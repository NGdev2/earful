// SPDX-License-Identifier: GPL-3.0-or-later
// Track progress: elapsed time, a bar that can be dragged to seek, and the length.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Slider from 'resource:///org/gnome/shell/ui/slider.js';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

// Keys held on a bar seek once, this long after the last press.
export const KEY_SEEK_DELAY_MS = 400;

/**
 * A slider for the track position. The mouse wheel is left to the menu: every
 * wheel step would be a seek, and players buffer on each one.
 */
export const SeekSlider = GObject.registerClass(
class SeekSlider extends Slider.Slider {
    vfunc_scroll_event() {
        return Clutter.EVENT_PROPAGATE;
    }
});

/** 75 -> "1:15", 3725 -> "1:02:05". */
export function formatTime(seconds) {
    const total = Math.max(0, Math.floor(seconds));
    const h = Math.floor(total / 3600);
    const m = Math.floor(total / 60) % 60;
    const s = String(total % 60).padStart(2, '0');
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/**
 * Elapsed time, bar and length of a player's track. Hidden when the track has
 * no length (live streams, players that don't tell). The menu calls tick()
 * once a second while it is open.
 */
export const ProgressBar = GObject.registerClass(
class ProgressBar extends St.BoxLayout {
    /**
     * @param {object} [options]
     * @param {boolean} [options.edge] a thin line along the card's edge that
     *   grows, with the times, when expanded (on hover)
     */
    _init({edge = false} = {}) {
        super._init({
            style_class: edge ? 'earful-progress earful-progress-edge' : 'earful-progress',
            x_expand: true,
            visible: false,
        });
        this._edge = edge;
        this._player = null;
        this._dragging = false;
        this._updating = false;

        this.elapsedLabel = new St.Label({
            style_class: 'earful-progress-time',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this.elapsedLabel);

        this.slider = new SeekSlider(0);
        this._keySeekId = 0;
        this.slider.accessible_name = _('Position');
        this.slider.x_expand = true;
        this.slider.y_align = Clutter.ActorAlign.CENTER;
        this.slider.connectObject(
            'notify::value', () => this._onSliderChanged(),
            'drag-begin', () => (this._dragging = true),
            'drag-end', () => {
                this._dragging = false;
                this.seekTo(this.slider.value);
            },
            this);
        this.add_child(this.slider);

        this.lengthLabel = new St.Label({
            style_class: 'earful-progress-time earful-progress-length',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this.lengthLabel);
        this.setExpanded(!edge);

        this.connect('destroy', () => {
            if (this._keySeekId)
                GLib.source_remove(this._keySeekId);
            this._keySeekId = 0;
            this._player?.disconnectObject(this);
            this._player = null;
        });
    }

    bindPlayer(player) {
        if (player !== this._player) {
            this._player?.disconnectObject(this);
            this._player = player;
            player?.connectObject(
                'changed', () => this.tick(),
                'position-changed', () => this.tick(),
                this);
        }
        this.tick();
    }

    /** Edge bars show the times and a handle only when expanded. */
    setExpanded(expanded) {
        if (!this._edge)
            return;
        this.elapsedLabel.visible = expanded;
        this.lengthLabel.visible = expanded;
        // Thin, it lies on the bottom of its row, so growing doesn't move the card.
        this.slider.y_align = expanded ? Clutter.ActorAlign.CENTER : Clutter.ActorAlign.END;
        if (expanded)
            this.add_style_pseudo_class('expanded');
        else
            this.remove_style_pseudo_class('expanded');
        this.slider.queue_repaint();
    }

    /** Inline style for the bar, e.g. the cover's accent color. */
    setSliderStyle(style) {
        if (this.slider.style === style)
            return;
        this.slider.style = style;
        this.slider.queue_repaint();
    }

    tick() {
        const player = this._player;
        const length = player?.length ?? 0;
        this.visible = length > 0;
        if (!this.visible)
            return;
        this.slider.reactive = player.canSeek;
        this.slider.can_focus = player.canSeek;
        this.lengthLabel.text = formatTime(length);
        // While dragging (or keys wait to seek), the label follows the handle.
        if (this._dragging || this._keySeekId)
            return;
        const position = player.position;
        this.elapsedLabel.text = formatTime(position);
        this._updating = true;
        this.slider.value = Math.clamp(position / length, 0, 1);
        this._updating = false;
    }

    /** Jumps to a point of the track, 0..1. */
    seekTo(fraction) {
        const player = this._player;
        if (!player?.canSeek)
            return;
        player.setPosition(Math.clamp(fraction, 0, 1) * player.length);
        this.tick();
    }

    _onSliderChanged() {
        if (this._updating || !this._player)
            return;
        if (this._dragging) {
            this.elapsedLabel.text = formatTime(this.slider.value * this._player.length);
            return;
        }
        // Arrow keys: one seek once they stop, not one per key repeat.
        this.elapsedLabel.text = formatTime(this.slider.value * this._player.length);
        if (this._keySeekId)
            GLib.source_remove(this._keySeekId);
        this._keySeekId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, KEY_SEEK_DELAY_MS, () => {
            this._keySeekId = 0;
            this.seekTo(this.slider.value);
            return GLib.SOURCE_REMOVE;
        });
    }
});
