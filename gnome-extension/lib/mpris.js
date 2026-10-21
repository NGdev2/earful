// Discovers MPRIS media players on the session bus and keeps their state.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

const MPRIS_PREFIX = 'org.mpris.MediaPlayer2.';
const MPRIS_PATH = '/org/mpris/MediaPlayer2';

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
    <method name="Play"/>
    <method name="Pause"/>
    <method name="Next"/>
    <method name="Previous"/>
    <property name="PlaybackStatus" type="s" access="read"/>
    <property name="Metadata" type="a{sv}" access="read"/>
    <property name="CanGoNext" type="b" access="read"/>
    <property name="CanGoPrevious" type="b" access="read"/>
    <property name="CanPlay" type="b" access="read"/>
    <property name="CanPause" type="b" access="read"/>
  </interface>
</node>`;

let DBusProxy, MprisProxy, MprisPlayerProxy;

function makeProxyClasses() {
    DBusProxy ??= Gio.DBusProxy.makeProxyWrapper(DBusIface);
    MprisProxy ??= Gio.DBusProxy.makeProxyWrapper(MprisIface);
    MprisPlayerProxy ??= Gio.DBusProxy.makeProxyWrapper(MprisPlayerIface);
}

// Players published by our browser bridge, one per tab (see native-host/).
const BRIDGE_TAB = /^org\.mpris\.MediaPlayer2\.earful_tab_\d+\.instance(\d+)$/;
// A browser's own single player, e.g. org.mpris.MediaPlayer2.chromium.instance1234.
const BROWSER_INSTANCE = /^org\.mpris\.MediaPlayer2\.[^.]+\.instance(\d+)$/;

// Cover art is loaded by the shell itself, so only allow local files and web URLs.
const ART_URL = /^(file|https?):\/\//;

function asString(value) {
    return typeof value === 'string' ? value : '';
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
 *  - 'closed': the player went away
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
        this.canPlay = false;
        this.lastActive = 0;

        // Whatever a player was playing when we found it stays silent;
        // every track after that is announced.
        this._announce = announce;
        this._initialized = false;
        this._pendingAnnounce = false;
        this._cancellable = new Gio.Cancellable();

        this._init().catch(e => {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                logError(e, `Earful: failed to set up player ${busName}`);
        });
    }

    async _init() {
        this._mprisProxy = await this._makeProxy(MprisProxy);
        this._playerProxy = await this._makeProxy(MprisPlayerProxy);

        this.identity = this._mprisProxy.Identity ?? '';
        this.desktopEntry = this._mprisProxy.DesktopEntry ?? '';
        if (this.desktopEntry) {
            this.app = Shell.AppSystem.get_default()
                .lookup_app(`${this.desktopEntry}.desktop`);
        }

        this._playerProxy.connectObject('g-properties-changed',
            () => this._update(), this);

        this._update();
    }

    _makeProxy(ProxyClass) {
        return new Promise((resolve, reject) => {
            new ProxyClass(Gio.DBus.session, this.busName, MPRIS_PATH,
                (proxy, error) => (error ? reject(error) : resolve(proxy)),
                this._cancellable);
        });
    }

    /** Stable key used to remember per-app preferences. */
    get appKey() {
        return (this.desktopEntry || this.identity || this.busName).toLowerCase();
    }

    /** Human readable source, e.g. "Spotify" or "Chromium". */
    get sourceName() {
        return this.app?.get_name() ?? this.identity ?? '';
    }

    /** Cover art if the player provides it, otherwise the app icon. */
    get artIcon() {
        if (ART_URL.test(this.artUrl)) {
            try {
                return new Gio.FileIcon({file: Gio.File.new_for_uri(this.artUrl)});
            } catch {}
        }
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

        this.status = proxy.PlaybackStatus ?? 'Stopped';
        this.title = asString(metadata['xesam:title']);
        this.artists = asStringList(metadata['xesam:artist']);
        this.album = asString(metadata['xesam:album']);
        this.artUrl = asString(metadata['mpris:artUrl']);
        this.canGoNext = proxy.CanGoNext ?? false;
        this.canGoPrevious = proxy.CanGoPrevious ?? false;
        this.canPlay = proxy.CanPlay ?? false;

        if (this.isPlaying)
            this.lastActive = GLib.get_monotonic_time();

        const key = this.title
            ? [this.title, ...this.artists, this.album].join('\u0001')
            : null;
        if (key && key !== this.trackKey) {
            this.trackKey = key;
            this._pendingAnnounce = this._initialized || this._announce;
        }
        this._initialized = true;

        // Announce a new track once it actually plays, so pausing,
        // resuming or browsing a paused player stays quiet.
        this.emit('changed');
        if (this._pendingAnnounce && this.isPlaying) {
            this._pendingAnnounce = false;
            this.emit('track-changed');
        }
    }

    playPause() {
        this._playerProxy?.PlayPauseAsync().catch(logError);
    }

    pause() {
        this._playerProxy?.PauseAsync().catch(logError);
    }

    next() {
        this._playerProxy?.NextAsync().catch(logError);
    }

    previous() {
        this._playerProxy?.PreviousAsync().catch(logError);
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
        if (this._destroyed)
            return;
        this._destroyed = true;

        this._cancellable.cancel();
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

        makeProxyClasses();
        this._players = new Map();
        this._cancellable = new Gio.Cancellable();

        this._init().catch(e => {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                logError(e, 'Earful: failed to watch media players');
        });
    }

    async _init() {
        this._proxy = await new Promise((resolve, reject) => {
            new DBusProxy(Gio.DBus.session,
                'org.freedesktop.DBus', '/org/freedesktop/DBus',
                (proxy, error) => (error ? reject(error) : resolve(proxy)),
                this._cancellable);
        });

        this._signalId = this._proxy.connectSignal('NameOwnerChanged',
            (proxy, sender, [name, oldOwner, newOwner]) => {
                if (!name.startsWith(MPRIS_PREFIX))
                    return;
                if (oldOwner)
                    this._removePlayer(name);
                if (newOwner)
                    this._addPlayer(name, true);
            });

        const [names] = await this._proxy.ListNamesAsync();
        for (const name of names) {
            if (name.startsWith(MPRIS_PREFIX))
                this._addPlayer(name, false);
        }
    }

    _addPlayer(busName, announce) {
        if (this._destroyed || this._players.has(busName))
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
            .filter(p => p.hasTrack && !this.isShadowed(p))
            .sort((a, b) => (b.isPlaying - a.isPlaying) ||
                (b.lastActive - a.lastActive));
    }

    /** The player that matters most right now, if any. */
    get current() {
        return this.players[0] ?? null;
    }

    destroy() {
        this._destroyed = true;
        this._cancellable.cancel();
        if (this._signalId)
            this._proxy.disconnectSignal(this._signalId);
        for (const player of [...this._players.values()])
            player.destroy();
        this._players.clear();
        this._proxy = null;
    }
}
