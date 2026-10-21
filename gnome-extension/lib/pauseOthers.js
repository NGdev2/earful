// Optionally pauses every other player when one starts playing.

import GLib from 'gi://GLib';

// A player we just paused may still report Playing for a moment (e.g. two
// players started together); within this window it can't pause the others.
const GUARD_US = 1500 * 1000;

export class PauseOthers {
    constructor(settings, manager) {
        this._settings = settings;
        this._manager = manager;
        this._pausedAt = new Map();

        manager.connectObject('player-added',
            (m, player) => this._watchPlayer(player), this);
        for (const player of manager.allPlayers)
            this._watchPlayer(player);
    }

    _watchPlayer(player) {
        player.connectObject(
            'started', () => this._onStarted(player),
            'closed', () => {
                player.disconnectObject(this);
                this._pausedAt.delete(player);
            },
            this);
    }

    _onStarted(player) {
        if (!this._settings.get_boolean('pause-others'))
            return;

        const now = GLib.get_monotonic_time();
        if (now - (this._pausedAt.get(player) ?? -GUARD_US) < GUARD_US)
            return;

        const exceptions = this._settings.get_strv('pause-others-exceptions');
        for (const other of this._manager.allPlayers) {
            if (other === player || !other.isPlaying ||
                exceptions.includes(other.appKey))
                continue;
            this._pausedAt.set(other, now);
            other.pause();
        }
    }

    destroy() {
        this._manager.disconnectObject(this);
        for (const player of this._manager.allPlayers)
            player.disconnectObject(this);
        this._pausedAt.clear();
    }
}
