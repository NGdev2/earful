// SPDX-License-Identifier: GPL-3.0-or-later
// Sends the media keys to a player of your choice.
//
// gnome-settings-daemon grabs the media keys through the shell and picks
// an MPRIS player itself; the keys can't be grabbed a second time. So
// while a target is set, media key presses that the shell would forward
// to it are handled here instead. Everything else, and every press when
// there is no target, still goes to the settings daemon.

import Clutter from 'gi://Clutter';

import {InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';
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
        let players = this._manager.players;
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
        if (this._injections)
            return;

        const self = this;
        this._injections = new InjectionManager();
        this._injections.overrideMethod(Main.shellDBusService, '_emitAcceleratorActivated',
            original => function (...args) {
                if (!self._handle())
                    original.apply(this, args);
            });
    }

    _unhook() {
        this._injections?.clear();
        this._injections = null;
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
