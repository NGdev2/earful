// SPDX-License-Identifier: GPL-3.0-or-later
// Discovers MPRIS media players on the session bus and keeps their state.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

Gio._promisify(Gio.DBusConnection.prototype, 'call');
Gio._promisify(Gio.DBusProxy.prototype, 'call');

const MPRIS_PREFIX = 'org.mpris.MediaPlayer2.';
const MPRIS_PATH = '/org/mpris/MediaPlayer2';
const PLAYER_IFACE = 'org.mpris.MediaPlayer2.Player';

// Players from Earful's own browser bridge; they implement Volume properly.
const BRIDGE_PREFIX = `${MPRIS_PREFIX}earful_tab_`;

const DBusIface = `
<node>
  <interface name="org.freedesktop.DBus">
    <method name="ListNames">
      <arg type="as" direction="out" name="names"/>
    </method>
    <signal name="NameOwnerChanged">
      <arg type="s" name="name"/>
      <arg type="s" name="oldOwner"/>
      <arg type="s" name="newOwner"/>
    </signal>
  </interface>
</node>`;

const MprisIface = `
<node>
  <interface name="org.mpris.MediaPlayer2">
    <method name="Raise"/>
    <property name="CanRaise" type="b" access="read"/>
    <property name="Identity" type="s" access="read"/>
    <property name="DesktopEntry" type="s" access="read"/>
  </interface>
</node>`;

const MprisPlayerIface = `
<node>
  <interface name="org.mpris.MediaPlayer2.Player">
    <method name="PlayPause"/>
    <method name="Pause"/>
    <method name="Next"/>
    <method name="Previous"/>
    <method name="Stop"/>
    <method name="Seek">
      <arg type="x" direction="in" name="Offset"/>
    </method>
    <method name="SetPosition">
      <arg type="o" direction="in" name="TrackId"/>
      <arg type="x" direction="in" name="Position"/>
    </method>
    <signal name="Seeked">
      <arg type="x" name="Position"/>
    </signal>
    <property name="PlaybackStatus" type="s" access="read"/>
    <property name="Metadata" type="a{sv}" access="read"/>
    <property name="CanGoNext" type="b" access="read"/>
    <property name="CanGoPrevious" type="b" access="read"/>
    <property name="CanControl" type="b" access="read"/>
    <property name="Volume" type="d" access="readwrite"/>
    <property name="Rate" type="d" access="read"/>
    <property name="CanSeek" type="b" access="read"/>
  </interface>
</node>`;

const DBusProxy = Gio.DBusProxy.makeProxyWrapper(DBusIface);
const MprisProxy = Gio.DBusProxy.makeProxyWrapper(MprisIface);
const MprisPlayerProxy = Gio.DBusProxy.makeProxyWrapper(MprisPlayerIface);

// Players published by our browser bridge, one per tab (see ../bridge/).
const BRIDGE_TAB = /^org\.mpris\.MediaPlayer2\.earful_tab_\d+\.instance(\d+)$/;
// A browser's own single player, e.g. org.mpris.MediaPlayer2.chromium.instance1234.
const BROWSER_INSTANCE = /^org\.mpris\.MediaPlayer2\.[^.]+\.instance(\d+)$/;
// Firefox's own player, e.g. org.mpris.MediaPlayer2.firefox.instance_1_23. A
// Snap Firefox starts the bridge through the desktop portal, so its pid
// can't be matched; any bridge tab from Firefox stands in for it.
const FIREFOX = /^org\.mpris\.MediaPlayer2\.firefox\./;

async function dbusCall(name, path, iface, method, params, replyType, cancellable) {
    const reply = await Gio.DBus.session.call(name, path, iface, method, params,
        new GLib.VariantType(replyType), Gio.DBusCallFlags.NONE, -1, cancellable);
    return reply.deepUnpack();
}

function asString(value) {
    return typeof value === 'string' ? value : '';
}

/** "file:///videos/My%20Trip.mkv" -> "My Trip", for players that send no title. */
function titleFromUrl(url) {
    const path = url.split(/[?#]/)[0];
    let name = path.slice(path.lastIndexOf('/') + 1);
    try {
        name = decodeURIComponent(name);
    } catch {}
    return name.replace(/\.[a-z0-9]{1,5}$/i, '');
}

/** A number in microseconds (players send x, t, i or d) as seconds; 0 if unusable. */
function asSeconds(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n / 1e6 : 0;
}

// The MPRIS "no track" id, and ids that are not object paths, can't be used
// with SetPosition; those players get Seek instead.
const NO_TRACK = '/org/mpris/MediaPlayer2/TrackList/NoTrack';
function asTrackId(value) {
    return typeof value === 'string' && value !== NO_TRACK &&
        GLib.Variant.is_object_path(value) ? value : '';
}

function asStringList(value) {
    if (typeof value === 'string')
        return [value];
    if (Array.isArray(value))
        return value.filter(v => typeof v === 'string');
    return [];
}

/**
 * One MPRIS player (an app, or a browser exposing its media session).
 *
 * Signals:
 *  - 'changed': any state or metadata change
 *  - 'track-changed': a new track started playing (worth announcing)
 *  - 'started': playback went from not playing to playing
 *  - 'closed': the player went away
 *  - 'position-changed': the position jumped (seek, fresh read, new track)
 */
export class Player extends Signals.EventEmitter {
    constructor(busName, {announce}) {
        super();

        this.busName = busName;
        this.identity = '';
        this.desktopEntry = '';
        this.app = null;
        this.status = 'Stopped';
        this.title = '';
        this.artists = [];
        this.album = '';
        this.artUrl = '';
        this.trackKey = null;
        this.canGoNext = false;
        this.canGoPrevious = false;
        this.lastActive = 0;
        this.startedAt = 0;
        // MPRIS volume (0..1), only when the player really lets us set it.
        this.volume = null;
        // Track length in seconds; 0 when unknown (live streams, some players).
        this.length = 0;
        this.trackId = '';
        this.rate = 1;
        this._canSeek = false;
        // Players rarely announce Position, so it is read now and then and
        // counted forward locally: base + time since base, times the rate.
        this._positionBase = 0;
        this._positionTime = GLib.get_monotonic_time();
        // Hidden from the list by the user until it plays or changes track.
        this.dismissed = false;

        // Whatever a player was playing when we found it stays silent;
        // every track after that is announced.
        this._announce = announce;
        this._initialized = false;
        this._pendingAnnounce = false;
        this._volumeWritable = false;
        this._volumeFailed = false;
        this._cancellable = new Gio.Cancellable();

        this._init().catch(e => {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                logError(e, `Earful: failed to set up player ${busName}`);
        });
    }

    async _init() {
        this._mprisProxy = await MprisProxy.newAsync(Gio.DBus.session,
            this.busName, MPRIS_PATH, this._cancellable);
        this._playerProxy = await MprisPlayerProxy.newAsync(Gio.DBus.session,
            this.busName, MPRIS_PATH, this._cancellable);

        this.identity = this._mprisProxy.Identity ?? '';
        this.desktopEntry = this._mprisProxy.DesktopEntry ?? '';
        if (this.desktopEntry) {
            this.app = Shell.AppSystem.get_default()
                .lookup_app(`${this.desktopEntry}.desktop`);
        }
        await Promise.all([this._findAppByPid(), this._checkVolume()]);
        // Both ignore errors, so check whether the player went away meanwhile.
        if (this._cancellable.is_cancelled())
            return;

        this._playerProxy.connectObject('g-properties-changed', (proxy, changed) => {
            // Most players never announce Position, but use it when one does.
            const position = changed.lookup_value('Position', null);
            if (position)
                this._setPosition(asSeconds(position.deepUnpack()));
            this._update();
        }, this);
        this._seekedId = this._playerProxy.connectSignal('Seeked',
            (proxy, sender, [position]) => this._setPosition(asSeconds(position)));

        this._update();
        this.refreshPosition();
    }

    async _findAppByPid() {
        // Some players (e.g. Chrome) have no DesktopEntry; their windows
        // still tell which app they are.
        if (this.app)
            return;
        try {
            const [pid] = await dbusCall('org.freedesktop.DBus',
                '/org/freedesktop/DBus', 'org.freedesktop.DBus',
                'GetConnectionUnixProcessID', new GLib.Variant('(s)', [this.busName]),
                '(u)', this._cancellable);
            this.app = Shell.WindowTracker.get_default().get_app_from_pid(pid);
        } catch {}
    }

    async _checkVolume() {
        // Many players expose Volume but ignore writes (Chrome always says
        // 1.0), so only trust it when declared writable.
        if (this.isBridge) {
            this._volumeWritable = true;
            return;
        }
        try {
            const [xml] = await dbusCall(this.busName, MPRIS_PATH,
                'org.freedesktop.DBus.Introspectable', 'Introspect', null,
                '(s)', this._cancellable);
            const prop = Gio.DBusNodeInfo.new_for_xml(xml)
                .lookup_interface(PLAYER_IFACE)?.lookup_property('Volume');
            this._volumeWritable =
                !!(prop && prop.flags & Gio.DBusPropertyInfoFlags.WRITABLE);
        } catch {}
    }

    /** Stable key used to remember per-app preferences. */
    get appKey() {
        return (this.desktopEntry || this.identity || this.busName).toLowerCase();
    }

    /** One tab of a browser, from Earful's browser bridge. */
    get isBridge() {
        return this.busName.startsWith(BRIDGE_PREFIX);
    }

    /** Human readable source, e.g. "Spotify" or "Twitch · Google Chrome". */
    get sourceName() {
        // Bridge tabs name their site and browser.
        if (this.isBridge && this.identity)
            return this.identity.replace(' — ', ' · ');
        return this.app?.get_name() || this.identity;
    }

    get appIcon() {
        return this.app?.get_icon() ??
            new Gio.ThemedIcon({name: 'audio-x-generic-symbolic'});
    }

    get artistText() {
        return this.artists.join(', ');
    }

    get isPlaying() {
        return this.status === 'Playing';
    }

    /** Players without a track (idle browsers etc.) are not worth showing. */
    get hasTrack() {
        return this.title !== '';
    }

    _update() {
        const proxy = this._playerProxy;
        const metadata = {};
        for (const [key, value] of Object.entries(proxy.Metadata ?? {}))
            metadata[key] = value.deepUnpack();

        const wasPlaying = this.isPlaying;
        const oldStatus = this.status, oldRate = this.rate;
        // Freeze the counted position before the status or rate changes it.
        const status = proxy.PlaybackStatus ?? 'Stopped';
        const rate = typeof proxy.Rate === 'number' && proxy.Rate > 0 ? proxy.Rate : 1;
        if (status !== oldStatus || rate !== oldRate) {
            this._positionBase = this.position;
            this._positionTime = GLib.get_monotonic_time();
        }
        this.status = status;
        this.rate = rate;
        this.length = asSeconds(metadata['mpris:length']);
        const trackId = asTrackId(metadata['mpris:trackid']);
        this._canSeek = proxy.CanSeek === true;
        // VLC sends only the file's URL for files without tags.
        this.title = asString(metadata['xesam:title']) ||
            titleFromUrl(asString(metadata['xesam:url']));
        this.artists = asStringList(metadata['xesam:artist']);
        this.album = asString(metadata['xesam:album']);
        this.artUrl = asString(metadata['mpris:artUrl']);
        this.canGoNext = proxy.CanGoNext ?? false;
        this.canGoPrevious = proxy.CanGoPrevious ?? false;

        const volume = proxy.Volume;
        this.volume = this._volumeWritable && !this._volumeFailed &&
            proxy.CanControl !== false && typeof volume === 'number'
            ? Math.clamp(volume, 0, 1) : null;

        // Players already playing when we start up did not just start.
        const started = this.isPlaying && !wasPlaying &&
            (this._initialized || this._announce);
        if (this.isPlaying)
            this.lastActive = GLib.get_monotonic_time();
        if (started)
            this.startedAt = this.lastActive;

        const key = this.title
            ? [this.title, ...this.artists, this.album].join('\u0001')
            : null;
        // A hidden player comes back as soon as it plays something.
        if (this.dismissed && (this.isPlaying || key !== this.trackKey))
            this.dismissed = false;
        const newTrack = (key && key !== this.trackKey) || trackId !== this.trackId;
        this.trackId = trackId;
        if (key && key !== this.trackKey) {
            this.trackKey = key;
            this._pendingAnnounce = this._initialized || this._announce;
        }
        if (newTrack) {
            this._positionBase = 0;
            this._positionTime = GLib.get_monotonic_time();
        }
        if (this._initialized && (newTrack || status !== oldStatus || rate !== oldRate))
            this.refreshPosition();
        this._initialized = true;

        // Announce a new track once it actually plays, so pausing,
        // resuming or browsing a paused player stays quiet.
        this.emit('changed');
        if (started)
            this.emit('started');
        if (this._pendingAnnounce && this.isPlaying) {
            this._pendingAnnounce = false;
            this.emit('track-changed');
        }
    }

    /** Hides a player that isn't playing, until it plays again. */
    dismiss() {
        if (this.isPlaying || this.dismissed)
            return;
        this.dismissed = true;
        this.emit('changed');
    }

    playPause() {
        this._playerProxy?.PlayPauseAsync().catch(logError);
    }

    pause() {
        this._playerProxy?.PauseAsync().catch(logError);
    }

    stop() {
        this._playerProxy?.StopAsync().catch(logError);
    }

    next() {
        this._playerProxy?.NextAsync().catch(logError);
    }

    previous() {
        this._playerProxy?.PreviousAsync().catch(logError);
    }

    /**
     * Whether the bar can be dragged: the player seeks, has a length, and
     * didn't ignore a seek on this track (YouTube ads say they can seek).
     */
    get canSeek() {
        return this._canSeek && this.length > 0 &&
            this._seekRefusedOn !== this._trackRef;
    }

    get _trackRef() {
        return `${this.trackKey}\u0001${this.trackId}`;
    }

    /** Current position in seconds, counted forward from the last reading. */
    get position() {
        let seconds = this._positionBase;
        if (this.status === 'Playing')
            seconds += (GLib.get_monotonic_time() - this._positionTime) / 1e6 * this.rate;
        seconds = Math.max(0, seconds);
        return this.length > 0 ? Math.min(seconds, this.length) : seconds;
    }

    _setPosition(seconds) {
        this._positionBase = seconds;
        this._positionTime = GLib.get_monotonic_time();
        this.emit('position-changed');
    }

    /** Reads Position from the player (it is not announced when it moves). */
    async refreshPosition() {
        if (!this._playerProxy)
            return;
        try {
            const reply = await this._playerProxy.call('org.freedesktop.DBus.Properties.Get',
                new GLib.Variant('(ss)', [PLAYER_IFACE, 'Position']),
                Gio.DBusCallFlags.NONE, -1, this._cancellable);
            const [position] = reply.recursiveUnpack();
            if (typeof position === 'number' && Number.isFinite(position)) {
                this._setPosition(Math.max(0, position / 1e6));
                return this.position;
            }
        } catch {
            // Not every player has a Position; the bar then counts from 0.
        }
        return null;
    }

    /** Jumps to `seconds` in the current track. */
    setPosition(seconds) {
        if (!this.canSeek || !this._playerProxy)
            return;
        const target = Math.clamp(seconds, 0, this.length);
        const before = this.position;
        const request = this.trackId
            ? this._playerProxy.SetPositionAsync(this.trackId, Math.round(target * 1e6))
            : this._playerProxy.SeekAsync(Math.round((target - this.position) * 1e6));
        request.catch(e => {
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED) || this._seekFailed)
                return;
            this._seekFailed = true;
            logError(e, `Earful: ${this.busName} refused to seek`);
        });
        // Move the bar now; a Seeked signal or the next reading corrects it.
        this._setPosition(target);
        this._checkSeek(before, target);
    }

    /**
     * Some players accept a seek and stay where they were (YouTube during an
     * ad). Read the position back a moment later; if it didn't move, the bar
     * snaps back and can't be dragged until the next track.
     */
    _checkSeek(before, target) {
        if (this._seekCheckId)
            GLib.source_remove(this._seekCheckId);
        const ref = this._trackRef;
        const start = GLib.get_monotonic_time();
        this._seekCheckId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
            this._seekCheckId = 0;
            this.refreshPosition().then(position => {
                if (position === null || ref !== this._trackRef)
                    return;
                const elapsed = this.status === 'Playing'
                    ? (GLib.get_monotonic_time() - start) / 1e6 * this.rate : 0;
                const stayed = Math.abs(position - (before + elapsed)) < 2;
                const moved = Math.abs(position - (target + elapsed)) < 3;
                if (stayed && !moved) {
                    this._seekRefusedOn = ref;
                    this.emit('changed');
                }
            });
            return GLib.SOURCE_REMOVE;
        });
    }

    async setVolume(value) {
        if (this.volume === null)
            return;
        try {
            await this._playerProxy.call('org.freedesktop.DBus.Properties.Set',
                new GLib.Variant('(ssv)',
                    [PLAYER_IFACE, 'Volume', new GLib.Variant('d', value)]),
                Gio.DBusCallFlags.NONE, -1, this._cancellable);
        } catch (e) {
            if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                return;
            // Declared writable but refused: fall back to the mixer.
            this._volumeFailed = true;
            this._update();
        }
    }

    /** Bring the player (and, for browsers, its tab) to the front. */
    raise() {
        // Raise() lets browsers switch to the right tab, but may be blocked
        // by focus stealing prevention, so also activate the app ourselves.
        if (this._mprisProxy?.CanRaise)
            this._mprisProxy.RaiseAsync().catch(logError);
        this.app?.activate();
    }

    destroy() {
        this._cancellable.cancel();
        if (this._seekCheckId)
            GLib.source_remove(this._seekCheckId);
        this._seekCheckId = 0;
        if (this._seekedId)
            this._playerProxy?.disconnectSignal(this._seekedId);
        this._playerProxy?.disconnectObject(this);
        this._mprisProxy = null;
        this._playerProxy = null;

        this.emit('closed');
    }
}

/**
 * Tracks all players on the session bus.
 *
 * Signals: 'player-added' (player), 'player-removed' (player)
 */
export class PlayerManager extends Signals.EventEmitter {
    constructor() {
        super();

        this._players = new Map();
        this._cancellable = new Gio.Cancellable();

        this._init().catch(e => {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                logError(e, 'Earful: failed to watch media players');
        });
    }

    async _init() {
        this._proxy = await DBusProxy.newAsync(Gio.DBus.session,
            'org.freedesktop.DBus', '/org/freedesktop/DBus', this._cancellable);

        this._signalId = this._proxy.connectSignal('NameOwnerChanged',
            (proxy, sender, [name, oldOwner, newOwner]) => {
                if (!name.startsWith(MPRIS_PREFIX))
                    return;
                if (oldOwner)
                    this._removePlayer(name);
                if (newOwner)
                    this._addPlayer(name, true);
            });

        const [names] = await this._proxy.ListNamesAsync(this._cancellable);
        for (const name of names) {
            if (name.startsWith(MPRIS_PREFIX))
                this._addPlayer(name, false);
        }
    }

    _addPlayer(busName, announce) {
        if (this._players.has(busName))
            return;

        const player = new Player(busName, {announce});
        this._players.set(busName, player);
        player.connect('closed', () => {
            if (this._players.get(busName) === player)
                this._players.delete(busName);
            this.emit('player-removed', player);
        });
        this.emit('player-added', player);
    }

    _removePlayer(busName) {
        this._players.get(busName)?.destroy();
    }

    /** Every known player, including idle ones without a track. */
    get allPlayers() {
        return [...this._players.values()];
    }

    /**
     * True for a browser's own single player while our bridge shows that
     * browser's tabs one by one; it would only duplicate one of them.
     */
    isShadowed(player) {
        if (BRIDGE_TAB.test(player.busName))
            return false;
        if (FIREFOX.test(player.busName)) {
            return [...this._players.values()].some(p =>
                p.isBridge && p.identity.endsWith('Firefox'));
        }
        const pid = BROWSER_INSTANCE.exec(player.busName)?.[1];
        if (!pid)
            return false;
        for (const name of this._players.keys()) {
            if (BRIDGE_TAB.exec(name)?.[1] === pid)
                return true;
        }
        return false;
    }

    /** Players that have a track, playing first, then most recently active. */
    get players() {
        return [...this._players.values()]
            .filter(p => p.hasTrack && !p.dismissed && !this.isShadowed(p))
            .sort((a, b) => (b.isPlaying - a.isPlaying) ||
                (b.lastActive - a.lastActive));
    }

    /** The player that matters most right now, if any. */
    get current() {
        return this.players[0] ?? null;
    }

    destroy() {
        this._cancellable.cancel();
        if (this._signalId)
            this._proxy.disconnectSignal(this._signalId);
        for (const player of [...this._players.values()])
            player.destroy();
        this._players.clear();
        this._proxy = null;
    }
}
