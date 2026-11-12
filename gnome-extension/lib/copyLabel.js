// SPDX-License-Identifier: GPL-3.0-or-later
// A title or artist line that can be copied with a click and that slides to
// show its end when it is too long, while pointed at.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

// Sliding: wait, move at this speed to the end, wait, jump back, repeat.
const HOLD_MS = 1200;
const PIXELS_PER_SECOND = 40;
// GNOME 51 renamed ButtonMask.ONE to PRIMARY.
const PRIMARY_BUTTON = St.ButtonMask.PRIMARY ?? St.ButtonMask.ONE;
// How long the check mark stays after copying.
const COPIED_MS = 1200;

/**
 * Text that slides on hover when it doesn't fit, and with `copy` also shows
 * a faint frame and a copy icon on hover; a click then copies the text (and
 * doesn't activate the row around it).
 */
export const CopyLabel = GObject.registerClass(
class CopyLabel extends St.Button {
    /**
     * @param {object} options
     * @param {string} options.styleClass the label's class, e.g. 'earful-title'
     * @param {boolean} options.copy whether a click copies the text
     * @param {boolean} options.scroll whether long text slides on hover
     */
    _init({styleClass, copy, scroll}) {
        super._init({
            style_class: copy ? 'earful-copy earful-copy-on' : 'earful-copy',
            x_align: Clutter.ActorAlign.START,
            reactive: true,
            // Without copying the button takes no clicks, so they reach the
            // row (which raises the player); hover still works for sliding.
            button_mask: copy ? PRIMARY_BUTTON : 0,
            can_focus: copy,
            track_hover: true,
            accessible_name: copy ? _('Copy') : '',
        });
        this._copy = copy;
        this._scroll = scroll;
        this._timer = 0;
        this._copiedTimer = 0;

        this.textLabel = new St.Label({style_class: styleClass, y_align: Clutter.ActorAlign.CENTER});
        // The label is drawn inside this box only, so it can slide past the edge.
        this._clip = new St.BoxLayout({clip_to_allocation: true, x_expand: true});
        this._clip.add_child(this.textLabel);
        this._icon = new St.Icon({
            style_class: 'earful-copy-icon',
            icon_name: 'edit-copy-symbolic',
            y_align: Clutter.ActorAlign.CENTER,
            opacity: 0,
            visible: copy,
        });
        const box = new St.BoxLayout({style_class: 'earful-copy-box'});
        box.add_child(this._clip);
        box.add_child(this._icon);
        this.set_child(box);

        this.connect('notify::hover', () => this._syncHover());
        this.connect('destroy', () => this._stopAll());
    }

    get text() {
        return this.textLabel.text;
    }

    set text(text) {
        if (this.textLabel.text === text)
            return;
        this._stopScroll();
        this.textLabel.text = text;
        this.accessible_name = this._copy ? _('Copy “%s”').format(text) : text;
        if (this.hover)
            this._syncHover();
    }

    vfunc_clicked() {
        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, this.textLabel.text);
        this._icon.icon_name = 'object-select-symbolic';
        if (this._copiedTimer)
            GLib.source_remove(this._copiedTimer);
        this._copiedTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, COPIED_MS, () => {
            this._copiedTimer = 0;
            this._icon.icon_name = 'edit-copy-symbolic';
            return GLib.SOURCE_REMOVE;
        });
    }

    _syncHover() {
        if (this._copy) {
            this._icon.ease({
                opacity: this.hover ? 255 : 0,
                duration: 120,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }
        if (this.hover && this._scroll)
            this._startScroll();
        else
            this._stopScroll();
    }

    /** How far the text runs past its box, in pixels (0 when it fits). */
    _overflow() {
        return Math.max(0, Math.round(this._fullWidth() - this._clip.width));
    }

    // Text cut with "…" reports its cut width; measure it uncut.
    _fullWidth() {
        const text = this.textLabel.clutter_text;
        const ellipsize = text.ellipsize;
        text.ellipsize = Pango.EllipsizeMode.NONE;
        const [, natural] = text.get_preferred_width(-1);
        text.ellipsize = ellipsize;
        return natural;
    }

    _startScroll() {
        if (this._timer || !St.Settings.get().enable_animations)
            return;
        const distance = this._overflow();
        if (distance <= 0)
            return;
        // Hold the box at its size and let the label run its full length.
        this._clip.width = this._clip.width;
        this.textLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        this.textLabel.width = this._fullWidth();
        const slide = Math.round(distance / PIXELS_PER_SECOND * 1000);
        const step = () => {
            this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, HOLD_MS, () => {
                this._timer = 0;
                this.textLabel.ease({
                    translation_x: -distance,
                    duration: slide,
                    mode: Clutter.AnimationMode.LINEAR,
                    onComplete: () => {
                        if (!this.hover)
                            return;
                        this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, HOLD_MS, () => {
                            this._timer = 0;
                            this.textLabel.translation_x = 0;
                            step();
                            return GLib.SOURCE_REMOVE;
                        });
                    },
                });
                return GLib.SOURCE_REMOVE;
            });
        };
        step();
    }

    _stopScroll() {
        if (this._timer)
            GLib.source_remove(this._timer);
        this._timer = 0;
        this.textLabel.remove_all_transitions();
        this.textLabel.translation_x = 0;
        this.textLabel.width = -1;
        this.textLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._clip.width = -1;
    }

    _stopAll() {
        if (this._copiedTimer)
            GLib.source_remove(this._copiedTimer);
        this._copiedTimer = 0;
        if (this._timer)
            GLib.source_remove(this._timer);
        this._timer = 0;
    }
});
