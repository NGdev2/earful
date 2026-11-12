// SPDX-License-Identifier: GPL-3.0-or-later
// Progress and volume under the text of a list row: one line that does both, or two bars side by side.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Slider from 'resource:///org/gnome/shell/ui/slider.js';

import {formatTime} from './progress.js';
import {volumeIcon} from './volume.js';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

// The two lines of a SwapLine cross-fade in this time.
const FADE_MS = 160;
// A hovered part of the DuoBars grows in this time...
const GROW_MS = 240;
// ...to this share of the width (3:1).
const GROWN_SHARE = 0.75;
// The value next to a grown part's icon is a little dimmed.
const VALUE_OPACITY = 204;
// The progress part's icon. Adwaita draws it as a plain clock.
const CLOCK_ICON = 'document-open-recent-symbolic';

/** Shows a style pseudo class while `on` is true. */
function setPseudoClass(actor, name, on) {
    if (on)
        actor.add_style_pseudo_class(name);
    else
        actor.remove_style_pseudo_class(name);
}

/** Asks the actors whether the pointer is really on them. */
function syncHover(actors) {
    for (const actor of actors)
        actor.sync_hover();
}

/** True while the key focus is on the actor or inside it. */
function hasFocusWithin(actor) {
    const focus = global.stage.get_key_focus();
    return focus !== null && actor.contains(focus);
}

/**
 * A seek bar bound to a player. Dragging seeks when let go; keyboard and
 * scroll changes seek right away. onText gets "10:15 / 1:02:05", following
 * the handle while it is dragged.
 */
class SeekBar {
    constructor({onDrag, onText}) {
        this.player = null;
        this.dragging = false;
        this._updating = false;
        this._onText = onText;

        this.slider = new Slider.Slider(0);
        this.slider.accessible_name = _('Position');
        this.slider.y_align = Clutter.ActorAlign.CENTER;
        this.slider.connect('notify::value', () => this._onSliderChanged());
        this.slider.connect('drag-begin', () => {
            this.dragging = true;
            onDrag();
        });
        this.slider.connect('drag-end', () => {
            this.dragging = false;
            this._seek(this.slider.value);
            onDrag();
        });
    }

    /** The track's length in seconds, 0 when it has none. */
    get length() {
        return this.player?.length ?? 0;
    }

    get canSeek() {
        return this.length > 0 && Boolean(this.player.canSeek);
    }

    /** Moves the bar to the player's position. */
    sync() {
        const length = this.length;
        // While dragging, the bar and the text follow the handle instead.
        if (length <= 0 || this.dragging)
            return;
        const position = this.player.position;
        this._updating = true;
        this.slider.value = Math.clamp(position / length, 0, 1);
        this._updating = false;
        this._onText(`${formatTime(position)} / ${formatTime(length)}`);
    }

    _seek(fraction) {
        if (!this.canSeek)
            return;
        this.player.setPosition(Math.clamp(fraction, 0, 1) * this.player.length);
        this.sync();
    }

    _onSliderChanged() {
        if (this._updating || this.length <= 0)
            return;
        if (this.dragging) {
            const length = this.length;
            this._onText(`${formatTime(this.slider.value * length)} / ${formatTime(length)}`);
            return;
        }
        this._seek(this.slider.value);
    }
}

/**
 * A speaker button (click to mute, again to bring the volume back) and a
 * volume bar, both on a VolumeSource. onValue gets each new value, 0..1.
 */
class VolumeControl {
    constructor(source, prefix, {onDrag, onValue = () => {}}) {
        this._source = source;
        this._onValue = onValue;
        this.dragging = false;
        this._updating = false;

        this._icon = new St.Icon({style_class: `${prefix}-icon`});
        this.button = new St.Button({
            style_class: `${prefix}-mute`,
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
            accessible_name: _('Mute'),
            child: this._icon,
        });
        this.button.connect('clicked', () => {
            const value = source.toggleMute();
            if (value !== null)
                this._show(value);
        });

        this.slider = new Slider.Slider(0);
        this.slider.accessible_name = _('Volume');
        this.slider.y_align = Clutter.ActorAlign.CENTER;
        this.slider.connect('notify::value', () => {
            if (this._updating)
                return;
            source.apply(this.slider.value);
            this._syncIcon(this.slider.value);
            this._onValue(this.slider.value);
        });
        // Outside changes don't move the handle while it is dragged.
        this.slider.connect('drag-begin', () => {
            this.dragging = true;
            onDrag();
        });
        this.slider.connect('drag-end', () => {
            this.dragging = false;
            this.sync();
            onDrag();
        });
    }

    /** Takes the source's value; false when there is no volume. */
    sync() {
        const value = this._source.read();
        if (value === null)
            return false;
        if (!this.dragging)
            this._show(value);
        return true;
    }

    _show(value) {
        this._updating = true;
        this.slider.value = value;
        this._updating = false;
        this._syncIcon(value);
        this._onValue(value);
    }

    _syncIcon(value) {
        this._icon.icon_name = volumeIcon(value);
        this.button.accessible_name = value > 0 ? _('Mute') : _('Unmute');
    }
}

/** Inline style for both bars, e.g. the cover's accent color. */
function styleSliders(sliders, style) {
    for (const slider of sliders) {
        if (slider.style === style)
            continue;
        slider.style = style;
        // The bar is drawn once and only redrawn on request.
        slider.queue_repaint();
    }
}

/**
 * One line, two jobs: [speaker][line]. The line is the track's progress;
 * pointing at the speaker turns it into the volume until the pointer leaves
 * the whole widget. Clicking the speaker mutes. With no track length the
 * line is always the volume; with no volume it is only the progress and the
 * speaker is gone; with neither the widget hides.
 */
export const SwapLine = GObject.registerClass(
class SwapLine extends St.BoxLayout {
    _init(source) {
        super._init({
            style_class: 'earful-swap',
            x_expand: true,
            reactive: true,
            track_hover: true,
            visible: false,
        });
        this._source = source;
        this._player = null;
        // Set by pointing at (or focusing) the speaker, cleared on leaving.
        this._wantVolume = false;
        this._showingVolume = null;

        const sync = () => this._syncMode();
        this._seek = new SeekBar({onDrag: sync, onText: () => {}});
        this._volume = new VolumeControl(source, 'earful-swap', {onDrag: sync});

        const speaker = this._volume.button;
        const wantVolume = () => {
            this._wantVolume = true;
            this._syncMode();
        };
        speaker.connect('notify::hover', () => (speaker.hover ? wantVolume() : sync()));
        speaker.connect('key-focus-in', wantVolume);
        for (const actor of [speaker, this._seek.slider, this._volume.slider]) {
            actor.connect('key-focus-in', sync);
            actor.connect('key-focus-out', sync);
        }
        this.add_child(speaker);

        // Both lines lie in the same place and cross-fade. In a BinLayout a
        // child's y_align needs y_expand; the box itself must not expand.
        this._lines = new St.Widget({
            style_class: 'earful-swap-lines',
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: false,
            y_align: Clutter.ActorAlign.CENTER,
        });
        for (const slider of [this._seek.slider, this._volume.slider]) {
            slider.x_expand = true;
            slider.y_expand = true;
            this._lines.add_child(slider);
        }
        this.add_child(this._lines);

        this.connect('notify::hover', sync);
        // Reopening the menu starts on the progress, even if the pointer
        // was on the speaker when it closed.
        this.connect('notify::mapped', () => {
            if (!this.mapped)
                return;
            this._wantVolume = false;
            syncHover([this, speaker]);
            this._syncMode();
        });
        source.connectObject('changed', () => this._sync(), this);
        this.connect('destroy', () => {
            source.disconnectObject(this);
            this._player?.disconnectObject(this);
            this._player = null;
            this._seek.player = null;
        });
        this._sync();
    }

    bindPlayer(player) {
        if (player !== this._player) {
            this._player?.disconnectObject(this);
            this._player = player;
            this._seek.player = player;
            player?.connectObject(
                'changed', () => this._sync(),
                'position-changed', () => this._sync(),
                this);
        }
        this._sync();
    }

    tick() {
        this._sync();
    }

    setSliderStyle(style) {
        styleSliders([this._seek.slider, this._volume.slider], style);
    }

    _sync() {
        const hasVolume = this._volume.sync();
        const hasLength = this._seek.length > 0;
        this.visible = hasLength || hasVolume;
        this._volume.button.visible = hasVolume;
        this._seek.sync();
        this._syncMode();
    }

    _syncMode() {
        const speaker = this._volume.button;
        const volumeFocused = speaker.has_key_focus() || this._volume.slider.has_key_focus();
        // The speaker is checked too: its hover may be told before ours.
        if (!this.hover && !speaker.hover && !this._volume.dragging && !volumeFocused)
            this._wantVolume = false;

        const hasVolume = speaker.visible;
        const hasLength = this._seek.length > 0;
        this._show(hasVolume && (!hasLength || this._wantVolume));

        // The handle shows only while the line is pointed at, dragged or focused.
        setPseudoClass(this, 'expanded', this.hover || this._seek.dragging ||
            this._volume.dragging || hasFocusWithin(this));
    }

    _show(volume) {
        const seek = this._seek.slider;
        const vol = this._volume.slider;
        // Only the visible line takes the pointer and the key focus.
        vol.reactive = vol.can_focus = volume;
        seek.reactive = seek.can_focus = !volume && this._seek.canSeek;
        if (volume === this._showingVolume)
            return;
        this._showingVolume = volume;
        const fade = {duration: FADE_MS, mode: Clutter.AnimationMode.EASE_OUT_QUAD};
        vol.ease({...fade, opacity: volume ? 255 : 0});
        seek.ease({...fade, opacity: volume ? 0 : 255});
    }
});

/** One side of the DuoBars: [icon][value][bar], or mirrored at the end. */
const DuoPart = GObject.registerClass(
class DuoPart extends St.BoxLayout {
    _init(kind, icon, slider, atStart) {
        super._init({
            style_class: `earful-duo-part earful-duo-${kind} ` +
                (atStart ? 'earful-duo-start' : 'earful-duo-end'),
            reactive: true,
            track_hover: true,
            clip_to_allocation: true,
        });
        this.slider = slider;
        slider.x_expand = true;

        // Hidden at width 0; DuoBars widens it as the part grows.
        this.label = new St.Label({
            style_class: 'earful-duo-value',
            y_align: Clutter.ActorAlign.CENTER,
            width: 0,
            opacity: 0,
            clip_to_allocation: true,
        });
        // Clipped while it slides out, not cut with "…".
        this.label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;

        const children = [icon, this.label, slider];
        if (!atStart)
            children.reverse();
        for (const child of children)
            this.add_child(child);
    }

    /** Its natural width without the value. */
    get restWidth() {
        return this.get_preferred_width(-1)[0] - this.label.get_preferred_width(-1)[0];
    }

    /** Widens the value from 0 (hidden) to 1 (full). */
    showValue(t) {
        const label = this.label;
        t = Math.clamp(t, 0, 1);
        label.opacity = Math.round(t * VALUE_OPACITY);
        if (t >= 1) {
            // Natural width, so a longer text later still fits.
            label.width = -1;
        } else if (t <= 0 || !label.mapped) {
            label.width = 0;
        } else {
            label.width = -1;
            label.width = t * label.get_preferred_width(-1)[1];
        }
    }
});

/**
 * Two bars on one line, each with its icon at the outer end: the progress
 * (a clock) and the volume (the speaker; click to mute). Pointing at a part
 * grows it to 3:1 and shows its value next to the icon. With no track length
 * only the volume shows, with no volume only the progress.
 *
 * The growth is a 'split' property (the progress part's share of the width)
 * eased with ease_property and read in vfunc_allocate, the way the shell's
 * workspace thumbnails ease their 'expand-fraction'. One animation drives
 * the widths of both parts and of the values, so they never disagree.
 */
export const DuoBars = GObject.registerClass({
    Properties: {
        'split': GObject.ParamSpec.double(
            'split', 'split', 'split',
            GObject.ParamFlags.READWRITE,
            0, 1, 0.5),
    },
}, class DuoBars extends St.BoxLayout {
    /**
     * @param {VolumeSource} source
     * @param {object} [options]
     * @param {string} [options.order] 'time-left' (progress left, volume
     *   right) or 'volume-left'
     */
    _init(source, {order = 'time-left'} = {}) {
        super._init({
            style_class: 'earful-duo',
            x_expand: true,
            visible: false,
        });
        this._split = 0.5;
        this._target = 0.5;
        this._source = source;
        this._player = null;

        const sync = () => this._syncOpen();
        this._seek = new SeekBar({
            onDrag: sync,
            onText: text => (this._time.label.text = text),
        });
        this._volume = new VolumeControl(source, 'earful-duo', {
            onDrag: sync,
            onValue: value => (this._vol.label.text = `${Math.round(value * 100)}%`),
        });

        const timeFirst = order !== 'volume-left';
        const clock = new St.Icon({
            style_class: 'earful-duo-icon earful-duo-clock',
            icon_name: CLOCK_ICON,
            fallback_icon_name: 'alarm-symbolic',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._time = new DuoPart('time', clock, this._seek.slider, timeFirst);
        this._vol = new DuoPart('volume', this._volume.button, this._volume.slider, !timeFirst);
        this._parts = timeFirst ? [this._time, this._vol] : [this._vol, this._time];
        for (const part of this._parts) {
            this.add_child(part);
            part.connect('notify::hover', sync);
        }
        for (const actor of [this._seek.slider, this._volume.button, this._volume.slider]) {
            actor.connect('key-focus-in', sync);
            actor.connect('key-focus-out', sync);
        }

        // A hover left over from when the menu closed would keep a part grown.
        this.connect('notify::mapped', () => {
            if (!this.mapped)
                return;
            syncHover(this._parts);
            this._syncOpen();
        });
        source.connectObject('changed', () => this._sync(), this);
        this.connect('destroy', () => {
            source.disconnectObject(this);
            this._player?.disconnectObject(this);
            this._player = null;
            this._seek.player = null;
        });
        this._sync();
    }

    get split() {
        return this._split ?? 0.5;
    }

    set split(value) {
        if (this._split === value)
            return;
        this._split = value;
        this.notify('split');
        const span = GROWN_SHARE - 0.5;
        this._time.showValue((value - 0.5) / span);
        this._vol.showValue((0.5 - value) / span);
        this.queue_relayout();
    }

    bindPlayer(player) {
        if (player !== this._player) {
            this._player?.disconnectObject(this);
            this._player = player;
            this._seek.player = player;
            player?.connectObject(
                'changed', () => this._sync(),
                'position-changed', () => this._sync(),
                this);
        }
        this._sync();
    }

    tick() {
        this._sync();
    }

    setSliderStyle(style) {
        styleSliders([this._seek.slider, this._volume.slider], style);
    }

    _sync() {
        const hasVolume = this._volume.sync();
        const hasLength = this._seek.length > 0;
        this._time.visible = hasLength;
        this._vol.visible = hasVolume;
        this.visible = hasLength || hasVolume;
        const seek = this._seek.slider;
        seek.reactive = seek.can_focus = this._seek.canSeek;
        this._seek.sync();
        this._syncOpen();
    }

    /** Grows the part that is pointed at, dragged or focused. */
    _syncOpen() {
        const isOpen = (part, dragging) =>
            part.visible && (part.hover || dragging || hasFocusWithin(part));
        const timeOpen = isOpen(this._time, this._seek.dragging);
        const volOpen = isOpen(this._vol, this._volume.dragging);
        // The handles show only on an open part.
        setPseudoClass(this._time, 'expanded', timeOpen);
        setPseudoClass(this._vol, 'expanded', volOpen);

        let target = 0.5;
        if (timeOpen && !volOpen)
            target = GROWN_SHARE;
        else if (volOpen && !timeOpen)
            target = 1 - GROWN_SHARE;
        if (target === this._target)
            return;
        this._target = target;
        this.ease_property('split', target, {
            duration: GROW_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    // Only the resting size is asked for, so a part showing its value
    // never widens the menu.
    vfunc_get_preferred_width(forHeight) {
        if (!this._parts)
            return super.vfunc_get_preferred_width(forHeight);
        const parts = this._parts.filter(p => p.visible);
        let width = Math.max(0, parts.length - 1) * this.layout_manager.spacing;
        for (const part of parts)
            width += part.restWidth;
        return this.get_theme_node().adjust_preferred_width(width, width);
    }

    // Splits the width by 'split', keeping each part at least its minimum
    // when there is room for both.
    vfunc_allocate(box) {
        this.set_allocation(box);
        const content = this.get_theme_node().get_content_box(box);
        let parts = this._parts.filter(p => p.visible);
        if (parts.length === 0)
            return;
        if (parts.length === 1) {
            parts[0].allocate(content);
            return;
        }
        if (this.get_text_direction() === Clutter.TextDirection.RTL)
            parts = parts.reverse();

        const [first, second] = parts;
        const height = content.get_height();
        const spacing = this.layout_manager.spacing;
        const room = Math.max(0, content.get_width() - spacing);
        const share = first === this._time ? this.split : 1 - this.split;
        const [firstMin] = first.get_preferred_width(height);
        const [secondMin] = second.get_preferred_width(height);
        let firstWidth = room * share;
        if (firstMin + secondMin <= room)
            firstWidth = Math.clamp(firstWidth, firstMin, room - secondMin);
        firstWidth = Math.round(firstWidth);

        const childBox = new Clutter.ActorBox();
        childBox.set_origin(content.x1, content.y1);
        childBox.set_size(firstWidth, height);
        first.allocate(childBox);
        childBox.set_origin(content.x1 + firstWidth + spacing, content.y1);
        childBox.set_size(Math.max(0, room - firstWidth), height);
        second.allocate(childBox);
    }
});
