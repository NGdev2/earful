// Ties sound streams from the shell's mixer (PulseAudio/PipeWire) to
// players, and lists apps that play sound without being a player.

import GLib from 'gi://GLib';
import Gvc from 'gi://Gvc';
import Shell from 'gi://Shell';

import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';
import * as Volume from 'resource:///org/gnome/shell/ui/status/volume.js';

const MPRIS_PREFIX = 'org.mpris.MediaPlayer2.';

// Mixers show their own level meters as streams.
const SKIPPED_APPS = ['org.gnome.VolumeControl', 'org.PulseAudio.pavucontrol'];

// Icons Gvc falls back to when a stream names none; they say nothing
// about which app it is.
const GENERIC_ICONS = new Set([
    'applications-multimedia', 'audio-x-generic', 'video-x-generic',
    'applications-games', 'dialog-information', 'phone', 'audio-card',
]);

// Words too common to identify an app on their own.
const GENERIC_WORDS = new Set([
    'audio', 'sound', 'media', 'player', 'music', 'video', 'playback',
    'stream', 'browser', 'app', 'desktop', 'instance', 'alsa', 'plugin',
    'pulseaudio', 'pipewire', 'webrtc', 'output', 'the', 'org', 'com',
]);

function words(name) {
    return name.toLowerCase().replace(/\.desktop$/, '')
        .split(/[^a-z0-9]+/).filter(Boolean);
}

/** A name, plus the last part of a reverse-DNS id (org.gnome.Rhythmbox3). */
function nameVariants(name) {
    if (!name)
        return [];
    const variants = [words(name)];
    const parts = name.replace(/\.desktop$/, '').split('.');
    if (parts.length > 2)
        variants.push(words(parts[parts.length - 1]));
    return variants.filter(w => w.length > 0);
}

/** True if `needle` appears as whole consecutive words in `hay`. */
function containsWords(hay, needle) {
    if (needle.length > hay.length)
        return false;
    if (needle.join('').length < 3 || needle.every(w => GENERIC_WORDS.has(w)))
        return false;
    for (let i = 0; i + needle.length <= hay.length; i++) {
        if (needle.every((w, j) => hay[i + j] === w))
            return true;
    }
    return false;
}

function namesMatch(a, b) {
    return a.join('') === b.join('') ||
        containsWords(a, b) || containsWords(b, a);
}

function playerNames(player) {
    const names = [player.desktopEntry, player.identity];
    if (player.app)
        names.push(player.app.get_id(), player.app.get_name());
    // org.mpris.MediaPlayer2.vlc, ...firefox.instance_1_23, ...chromium.instance42
    if (!player.isBridge)
        names.push(player.busName.slice(MPRIS_PREFIX.length).split('.')[0]);
    return names.flatMap(nameVariants);
}

function streamNames(stream) {
    const names = [stream.get_application_id(), stream.get_name()];
    const icon = stream.get_icon_name();
    if (icon && !GENERIC_ICONS.has(icon))
        names.push(icon);
    return names.flatMap(nameVariants);
}

function streamKey(stream) {
    return (stream.get_application_id() || stream.get_name() ||
        stream.get_icon_name() || `${stream.get_id()}`).toLowerCase();
}

function lookupApp(stream) {
    const appSystem = Shell.AppSystem.get_default();
    for (const name of [stream.get_application_id(), stream.get_icon_name(), stream.get_name()]) {
        if (!name)
            continue;
        const app = appSystem.lookup_app(`${name}.desktop`) ??
            appSystem.lookup_heuristic_basename(`${name.toLowerCase()}.desktop`) ??
            appSystem.lookup_desktop_wmclass(name);
        if (app)
            return app;
    }
    return null;
}

/**
 * Signals: 'changed' when which streams belong to whom changes
 * (not on volume changes; those come from the streams themselves).
 */
export class AudioManager extends Signals.EventEmitter {
    constructor(playerManager) {
        super();

        this._players = playerManager;
        this._playerStreams = new Map();
        this._others = [];
        this._signature = '';

        this._control = Volume.getMixerControl();
        this._control.connectObject(
            'state-changed', () => this._queueUpdate(),
            'stream-added', () => this._queueUpdate(),
            'stream-removed', () => this._queueUpdate(),
            'stream-changed', () => this._queueUpdate(),
            this);
        // Matching depends on players' names and on whether they have
        // a track; recomputing is cheap and only signals real changes.
        playerManager.connectObject(
            'player-added', (m, player) => this._watchPlayer(player),
            'player-removed', () => this._queueUpdate(),
            this);
        for (const player of playerManager.allPlayers)
            this._watchPlayer(player);

        this._update();
    }

    _watchPlayer(player) {
        player.connectObject(
            'changed', () => this._queueUpdate(),
            'closed', () => player.disconnectObject(this),
            this);
        this._queueUpdate();
    }

    _queueUpdate() {
        if (this._updateId)
            return;
        this._updateId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._updateId = 0;
            this._update();
            return GLib.SOURCE_REMOVE;
        });
    }

    _streams() {
        if (this._control.get_state() !== Gvc.MixerControlState.READY)
            return [];
        // Event streams are system and notification sounds. (These are
        // properties; the same-named methods are shadowed in GJS.)
        return this._control.get_sink_inputs().filter(s =>
            !s.is_event_stream && !s.is_virtual &&
            !SKIPPED_APPS.includes(s.get_application_id()));
    }

    _update() {
        const streams = this._streams().map(stream =>
            ({stream, names: streamNames(stream)}));

        // Gvc does not expose a stream's process id, so matching goes by
        // app id, name and icon against the player's desktop entry,
        // identity and app.
        this._playerStreams = new Map();
        const claimed = new Set();
        for (const player of this._players.allPlayers) {
            const names = playerNames(player);
            const matched = streams
                .filter(s => s.names.some(a => names.some(b => namesMatch(a, b))))
                .map(s => s.stream);
            this._playerStreams.set(player, matched);
            // Idle players (no track) don't hide e.g. a call in the same browser.
            if (player.hasTrack)
                matched.forEach(s => claimed.add(s));
        }

        const groups = new Map();
        for (const {stream} of streams) {
            if (claimed.has(stream))
                continue;
            const key = streamKey(stream);
            if (!groups.has(key)) {
                const app = lookupApp(stream);
                groups.set(key, {
                    key,
                    name: app?.get_name() || stream.get_name() ||
                        stream.get_description() || key,
                    gicon: app?.get_icon() ?? stream.get_gicon(),
                    app,
                    streams: [],
                });
            }
            groups.get(key).streams.push(stream);
        }
        this._others = [...groups.values()];

        const signature = JSON.stringify([
            [...this._playerStreams].map(([p, s]) => [p.busName, s.map(x => x.id)]),
            this._others.map(o => [o.key, o.name, o.streams.map(x => x.id)]),
        ]);
        if (signature !== this._signature) {
            this._signature = signature;
            this.emit('changed');
        }
    }

    /** Streams that seem to belong to this player. */
    streamsFor(player) {
        return this._playerStreams.get(player) ?? [];
    }

    /** Apps playing sound that are not players: {key, name, gicon, app, streams}. */
    get otherApps() {
        return this._others;
    }

    /** Loudest level of the streams, 0..1 (muted counts as 0). */
    getVolume(streams) {
        const max = this._control.get_vol_max_norm();
        return Math.min(1, Math.max(0, ...streams.map(s =>
            s.is_muted ? 0 : s.volume / max)));
    }

    /** Sets all streams to one level, muting at 0 like the shell does. */
    setVolume(streams, value) {
        const max = this._control.get_vol_max_norm();
        const volume = value * max;
        for (const stream of streams) {
            if (volume < 1) {
                stream.volume = 0;
                if (!stream.is_muted)
                    stream.change_is_muted(true);
            } else {
                stream.volume = volume;
                if (stream.is_muted)
                    stream.change_is_muted(false);
            }
            stream.push_volume();
        }
    }

    destroy() {
        if (this._updateId)
            GLib.source_remove(this._updateId);
        // The mixer control is the shell's shared one; leave it open.
        this._control.disconnectObject(this);
        this._players.disconnectObject(this);
        for (const player of this._players.allPlayers)
            player.disconnectObject(this);
        this._playerStreams.clear();
        this._others = [];
    }
}
