// One browser tab exposed as an MPRIS player on the session bus.
//
// Object paths are per D-Bus connection, and every player must live at
// /org/mpris/MediaPlayer2, so each tab gets its own connection.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Artwork from './artwork.js';

export const BUS_NAME_PREFIX = 'org.mpris.MediaPlayer2.earful_tab_';
const MPRIS_PATH = '/org/mpris/MediaPlayer2';
const MIN_RATE = 0.25;
const MAX_RATE = 4;
// Reported positions further off than this from our estimate are seeks.
const SEEK_THRESHOLD = 1.5;

const ROOT_IFACE = `
<node>
  <interface name="org.mpris.MediaPlayer2">
    <method name="Raise"/>
    <method name="Quit"/>
    <property name="CanRaise" type="b" access="read"/>
    <property name="CanQuit" type="b" access="read"/>
    <property name="HasTrackList" type="b" access="read"/>
    <property name="Identity" type="s" access="read"/>
    <property name="DesktopEntry" type="s" access="read"/>
    <property name="SupportedUriSchemes" type="as" access="read"/>
    <property name="SupportedMimeTypes" type="as" access="read"/>
  </interface>
</node>`;

const PLAYER_IFACE = `
<node>
  <interface name="org.mpris.MediaPlayer2.Player">
    <method name="Next"/>
    <method name="Previous"/>
    <method name="Pause"/>
    <method name="PlayPause"/>
    <method name="Stop"/>
    <method name="Play"/>
    <method name="Seek">
      <arg type="x" direction="in" name="Offset"/>
    </method>
    <method name="SetPosition">
      <arg type="o" direction="in" name="TrackId"/>
      <arg type="x" direction="in" name="Position"/>
    </method>
    <method name="OpenUri">
      <arg type="s" direction="in" name="Uri"/>
    </method>
    <signal name="Seeked">
      <arg type="x" name="Position"/>
    </signal>
    <property name="PlaybackStatus" type="s" access="read"/>
    <property name="Rate" type="d" access="readwrite"/>
    <property name="Metadata" type="a{sv}" access="read"/>
    <property name="Volume" type="d" access="readwrite"/>
    <property name="Position" type="x" access="read"/>
    <property name="MinimumRate" type="d" access="read"/>
    <property name="MaximumRate" type="d" access="read"/>
    <property name="CanGoNext" type="b" access="read"/>
    <property name="CanGoPrevious" type="b" access="read"/>
    <property name="CanPlay" type="b" access="read"/>
    <property name="CanPause" type="b" access="read"/>
    <property name="CanSeek" type="b" access="read"/>
    <property name="CanControl" type="b" access="read"/>
  </interface>
</node>`;

// Parsed once and kept for the whole run: GJS caches lookups per interface
// description and never drops the cache, so descriptions freed with a
// closed tab could leave a later tab's root interface answering
// "No such property" for everything.
const ROOT_INFO = Gio.DBusInterfaceInfo.new_for_xml(ROOT_IFACE);
const PLAYER_INFO = Gio.DBusInterfaceInfo.new_for_xml(PLAYER_IFACE);

// Properties whose changes are announced with PropertiesChanged.
// Position is deliberately missing: the spec uses the Seeked signal for it.
const ROOT_PROPERTIES = {Identity: 's', DesktopEntry: 's'};
const PLAYER_PROPERTIES = {
    PlaybackStatus: 's',
    Rate: 'd',
    Metadata: 'a{sv}',
    Volume: 'd',
    CanGoNext: 'b',
    CanGoPrevious: 'b',
    CanPlay: 'b',
    CanPause: 'b',
    CanSeek: 'b',
};
const METADATA_TYPES = {
    'mpris:trackid': 'o',
    'mpris:length': 'x',
    'mpris:artUrl': 's',
    'xesam:title': 's',
    'xesam:artist': 'as',
    'xesam:album': 's',
};

const EMPTY_STATE = {
    site: '',
    title: '',
    artist: '',
    album: '',
    artUrl: '',
    status: 'Stopped',
    position: 0,
    duration: 0,
    rate: 1,
    volume: 1,
    canPlay: false,
    canPause: false,
    canGoNext: false,
    canGoPrevious: false,
    canSeek: false,
    canSetVolume: false,
};

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

export class TabPlayer {
    /**
     * @param {number} tabId the browser's tab id
     * @param {object} browser shared {name, desktopEntry, pid}; may change
     * @param {Function} onCommand called as onCommand(command, value)
     */
    constructor(tabId, browser, onCommand) {
        this.tabId = tabId;
        this.busName = `${BUS_NAME_PREFIX}${tabId}.instance${browser.pid}`;
        this._browser = browser;
        this._onCommand = onCommand;
        this._state = EMPTY_STATE;
        this._stateTime = GLib.get_monotonic_time();
        this._trackKey = null;
        this._trackNumber = 0;
        this._artUri = '';

        this._root = Gio.DBusExportedObject.wrapJSObject(ROOT_INFO, this);
        this._player = Gio.DBusExportedObject.wrapJSObject(PLAYER_INFO, this);
        this._published = this._snapshot();

        const address = Gio.dbus_address_get_for_bus_sync(Gio.BusType.SESSION, null);
        this._connection = Gio.DBusConnection.new_for_address_sync(address,
            Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT |
            Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION, null, null);
        this._root.export(this._connection, MPRIS_PATH);
        this._player.export(this._connection, MPRIS_PATH);
        this._ownerId = Gio.bus_own_name_on_connection(this._connection,
            this.busName, Gio.BusNameOwnerFlags.DO_NOT_QUEUE, null,
            () => printerr(`earful-host: could not own ${this.busName}`));
    }

    /** Applies a new state reported by the extension. */
    update(state) {
        const expected = this._positionSeconds();
        const key = [state.title, state.artist, state.album].join('\u0001');
        const sameTrack = key === this._trackKey;
        if (!sameTrack) {
            this._trackKey = key;
            this._trackNumber++;
        }

        this._state = {...EMPTY_STATE, ...state};
        this._stateTime = GLib.get_monotonic_time();
        this._setArt(this._state.artUrl);
        this.publish();

        if (sameTrack && Math.abs(this._state.position - expected) > SEEK_THRESHOLD)
            this._player.emit_signal('Seeked', new GLib.Variant('(x)', [this.Position]));
    }

    /** Emits PropertiesChanged for everything that differs from last time. */
    publish() {
        const snapshot = this._snapshot();
        for (const [exported, types, part] of [
            [this._root, ROOT_PROPERTIES, 'root'],
            [this._player, PLAYER_PROPERTIES, 'player'],
        ]) {
            let changed = false;
            for (const [name, type] of Object.entries(types)) {
                if (snapshot[part][name] === this._published[part][name])
                    continue;
                exported.emit_property_changed(name, new GLib.Variant(type, this[name]));
                changed = true;
            }
            if (changed)
                exported.flush();
        }
        this._published = snapshot;
    }

    destroy() {
        Gio.bus_unown_name(this._ownerId);
        this._root.unexport();
        this._player.unexport();
        try {
            this._connection.close_sync(null);
        } catch {}
        this._setArt('');
    }

    _snapshot() {
        const part = (types, plain) => Object.fromEntries(Object.keys(types)
            .map(name => [name, JSON.stringify(plain(name))]));
        return {
            root: part(ROOT_PROPERTIES, name => this[name]),
            player: part(PLAYER_PROPERTIES,
                name => (name === 'Metadata' ? this._metadata() : this[name])),
        };
    }

    _setArt(url) {
        if (url === this._artSource)
            return;
        Artwork.release(this._artUri);
        this._artSource = url;
        this._artUri = url ? Artwork.acquire(url) : '';
    }

    _positionSeconds() {
        const {position, duration, status, rate} = this._state;
        let seconds = position;
        if (status === 'Playing')
            seconds += (GLib.get_monotonic_time() - this._stateTime) / 1e6 * rate;
        return duration > 0 ? Math.min(seconds, duration) : seconds;
    }

    get _trackId() {
        return `/io/github/ngdev2/earful/tab${this.tabId}/track${this._trackNumber}`;
    }

    _metadata() {
        const {title, artist, album, duration} = this._state;
        const metadata = {
            'mpris:trackid': this._trackId,
            'xesam:title': title,
        };
        if (artist)
            metadata['xesam:artist'] = [artist];
        if (album)
            metadata['xesam:album'] = album;
        if (this._artUri)
            metadata['mpris:artUrl'] = this._artUri;
        if (duration > 0)
            metadata['mpris:length'] = Math.round(duration * 1e6);
        return metadata;
    }

    // org.mpris.MediaPlayer2

    get CanRaise() {
        return true;
    }

    get CanQuit() {
        return false;
    }

    get HasTrackList() {
        return false;
    }

    get Identity() {
        const {site} = this._state;
        return site ? `${site} — ${this._browser.name}` : this._browser.name;
    }

    get DesktopEntry() {
        return this._browser.desktopEntry;
    }

    get SupportedUriSchemes() {
        return [];
    }

    get SupportedMimeTypes() {
        return [];
    }

    Raise() {
        this._onCommand('raise');
    }

    Quit() {}

    // org.mpris.MediaPlayer2.Player

    get PlaybackStatus() {
        return this._state.status;
    }

    get Rate() {
        return this._state.rate;
    }

    set Rate(rate) {
        // The spec says a rate of 0 means pause.
        if (rate <= 0) {
            this.Pause();
            return;
        }
        this._state = {...this._state, rate: clamp(rate, MIN_RATE, MAX_RATE)};
        this._onCommand('rate', this._state.rate);
        this.publish();
    }

    get Metadata() {
        return Object.fromEntries(Object.entries(this._metadata())
            .map(([key, value]) => [key, new GLib.Variant(METADATA_TYPES[key], value)]));
    }

    get Volume() {
        return this._state.volume;
    }

    set Volume(volume) {
        if (!this._state.canSetVolume)
            return;
        this._state = {...this._state, volume: clamp(volume, 0, 1)};
        this._onCommand('volume', this._state.volume);
        this.publish();
    }

    get Position() {
        return Math.round(this._positionSeconds() * 1e6);
    }

    get MinimumRate() {
        return MIN_RATE;
    }

    get MaximumRate() {
        return MAX_RATE;
    }

    get CanGoNext() {
        return this._state.canGoNext;
    }

    get CanGoPrevious() {
        return this._state.canGoPrevious;
    }

    get CanPlay() {
        return this._state.canPlay;
    }

    get CanPause() {
        return this._state.canPause;
    }

    get CanSeek() {
        return this._state.canSeek;
    }

    get CanControl() {
        return true;
    }

    Next() {
        if (this.CanGoNext)
            this._onCommand('next');
    }

    Previous() {
        if (this.CanGoPrevious)
            this._onCommand('previous');
    }

    Pause() {
        this._onCommand('pause');
    }

    PlayPause() {
        this._onCommand('playpause');
    }

    Stop() {
        this._onCommand('stop');
    }

    Play() {
        this._onCommand('play');
    }

    Seek(offset) {
        if (this.CanSeek)
            this._onCommand('seek', offset / 1e6);
    }

    SetPosition(trackId, position) {
        // Ignored for stale track ids, as the spec asks.
        if (this.CanSeek && trackId === this._trackId && position >= 0)
            this._onCommand('position', position / 1e6);
    }

    OpenUri() {}
}
