// SPDX-License-Identifier: GPL-3.0-or-later
// A pretend player for the example popup that Settings can show.

import Gio from 'gi://Gio';
import GObject from 'gi://GObject';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

// Made-up tracks, with covers drawn for Earful (media/).
const TRACKS = [
    ['Golden Hour', 'The Examples', 'example-1.jpg'],
    ['Low Orbit', 'The Examples', 'example-2.jpg'],
    ['Neon Tides', 'The Examples', 'example-3.jpg'],
];

/**
 * Has what a popup reads from a player. Its buttons work: next and
 * previous change the example track, play/pause stops the dancing bars.
 */
export const ExamplePlayer = GObject.registerClass({
    Signals: {'changed': {}},
}, class ExamplePlayer extends GObject.Object {
    /** @param {Gio.File} dir the extension's folder */
    _init(dir) {
        super._init();
        this._dir = dir;
        this._index = 0;
        this.status = 'Playing';
        this.app = null;
        this.canGoNext = true;
        this.canGoPrevious = true;
    }

    get title() {
        return TRACKS[this._index][0];
    }

    get artistText() {
        return TRACKS[this._index][1];
    }

    get artUrl() {
        return this._dir.get_child('media').get_child(TRACKS[this._index][2]).get_uri();
    }

    get trackKey() {
        return `example\n${this._index}`;
    }

    get appIcon() {
        return new Gio.FileIcon({
            file: this._dir.get_child('icons').get_child('earful-symbolic.svg'),
        });
    }

    get sourceName() {
        return _('Example');
    }

    get isPlaying() {
        return this.status === 'Playing';
    }

    get hasTrack() {
        return true;
    }

    next() {
        this._index = (this._index + 1) % TRACKS.length;
        this.emit('changed');
    }

    previous() {
        this._index = (this._index + TRACKS.length - 1) % TRACKS.length;
        this.emit('changed');
    }

    playPause() {
        this.status = this.isPlaying ? 'Paused' : 'Playing';
        this.emit('changed');
    }

    raise() {
    }
});
