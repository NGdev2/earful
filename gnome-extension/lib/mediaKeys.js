// Sends the media keys to a player of your choice.
//
// gnome-settings-daemon grabs the media keys through the shell and picks
// an MPRIS player itself; the keys can't be grabbed a second time. So
// while a target is set, media key presses that the shell would forward
// to it are handled here instead. Everything else, and every press when
// there is no target, still goes to the settings daemon.

import Clutter from 'gi://Clutter';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const ACTIONS = new Map([
    [Clutter.KEY_AudioPlay, p => p.playPause()],
    [Clutter.KEY_AudioPause, p => p.pause()],
    [Clutter.KEY_AudioStop, p => p.stop()],
    [Clutter.KEY_AudioNext, p => p.next()],
    [Clutter.KEY_AudioPrev, p => p.previous()],
]);

/** Playing players by who started last, then paused ones by last played. */
function byRecentActivity(a, b) {
    return (b.isPlaying - a.isPlaying) ||
        (b.isPlaying ? b.startedAt - a.startedAt : 0) ||
        (b.lastActive - a.lastActive);
}

export class MediaKeys {
    constructor(settings, manager) {
        this._settings = settings;
        this._manager = manager;

        settings.connectObject('changed::media-keys-target',
            () => this._sync(), this);
        this._sync();
    }

    /** The player media keys go to, or null to leave them to the system. */
    get target() {
        const mode = this._settings.get_string('media-keys-target');
        let players = this._manager.allPlayers.filter(p => p.hasTrack);
        if (mode === 'pinned') {
            const pinned = this._settings.get_string('media-keys-pinned');
            players = players.filter(p => p.appKey === pinned);
        } else if (mode !== 'last-active') {
            return null;
        }
        return players.sort(byRecentActivity)[0] ?? null;
    }

    _sync() {
        if (this._settings.get_string('media-keys-target') === 'default')
            this._unhook();
        else
            this._hook();
    }

    _hook() {
        const service = Main.shellDBusService;
        if (this._service || typeof service?._emitAcceleratorActivated !== 'function')
            return;

        this._service = service;
        this._hadOwn = Object.hasOwn(service, '_emitAcceleratorActivated');
        this._original = service._emitAcceleratorActivated;
        const self = this;

        // If someone wraps us later we can't unwrap; then just pass through.
        const original = this._original;
        const hook = {active: true};
        this._hookState = hook;
        this._hookFn = function (...args) {
            if (!hook.active || !self._handle())
                original.apply(this, args);
        };
        service._emitAcceleratorActivated = this._hookFn;
    }

    _unhook() {
        if (!this._service)
            return;

        this._hookState.active = false;
        if (this._service._emitAcceleratorActivated === this._hookFn) {
            if (this._hadOwn)
                this._service._emitAcceleratorActivated = this._original;
            else
                delete this._service._emitAcceleratorActivated;
        }
        this._service = null;
        this._original = null;
        this._hookFn = null;
        this._hookState = null;
    }

    _handle() {
        // Only real media key presses; other grabbed shortcuts pass through.
        const event = Clutter.get_current_event();
        if (event?.type() !== Clutter.EventType.KEY_PRESS)
            return false;
        const action = ACTIONS.get(event.get_key_symbol());
        const target = action && this.target;
        if (!target)
            return false;
        action(target);
        return true;
    }

    destroy() {
        this._unhook();
        this._settings.disconnectObject(this);
    }
}
