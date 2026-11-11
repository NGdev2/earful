// SPDX-License-Identifier: GPL-3.0-or-later
// Where a volume comes from (a player's MPRIS volume or its mixer streams),
// kept apart from how it is drawn, so every layout can show it its own way.

import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

/**
 * A player's own volume, or the volume of a set of mixer streams.
 *
 * Signals: 'changed' (the value or the source changed)
 */
export class VolumeSource extends Signals.EventEmitter {
    constructor(audio) {
        super();
        this._audio = audio;
        this._player = null;
        this._streams = [];
        // Clicking mute again brings this volume back.
        this._unmuteTo = 1;
    }

    bindPlayer(player) {
        this._bind(player, []);
    }

    bindStreams(streams) {
        this._bind(null, streams);
    }

    _bind(player, streams) {
        const same = player === this._player &&
            streams.length === this._streams.length &&
            streams.every((s, i) => s === this._streams[i]);
        if (!same) {
            this._disconnectStreams();
            this._player = player;
            this._streams = streams;
            for (const stream of streams) {
                stream.connectObject(
                    'notify::volume', () => this.emit('changed'),
                    'notify::is-muted', () => this.emit('changed'),
                    this);
            }
        }
        this.emit('changed');
    }

    /** The volume, 0..1, or null when there is nothing to control. */
    read() {
        if (this._player)
            return this._player.volume;
        if (this._streams.length > 0)
            return this._audio.getVolume(this._streams);
        return null;
    }

    apply(value) {
        if (this._player)
            this._player.setVolume(value);
        else if (this._streams.length > 0)
            this._audio.setVolume(this._streams, value);
    }

    /** Mutes, or brings the volume back; returns the new value (or null). */
    toggleMute() {
        const value = this.read();
        if (value === null)
            return null;
        let next;
        if (value > 0) {
            this._unmuteTo = value;
            next = 0;
        } else {
            next = this._unmuteTo;
        }
        this.apply(next);
        return next;
    }

    _disconnectStreams() {
        for (const stream of this._streams)
            stream.disconnectObject(this);
    }

    destroy() {
        this._disconnectStreams();
        this._streams = [];
        this._player = null;
    }
}

/** The speaker icon name for a volume. */
export function volumeIcon(value) {
    let level = 'high';
    if (value <= 0)
        level = 'muted';
    else if (value < 1 / 3)
        level = 'low';
    else if (value < 2 / 3)
        level = 'medium';
    return `audio-volume-${level}-symbolic`;
}
