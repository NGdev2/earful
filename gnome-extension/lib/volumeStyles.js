// SPDX-License-Identifier: GPL-3.0-or-later
// A vertical volume control in five looks: LED steps, a knob, a pill, a studio fader, a line.

import Atk from 'gi://Atk';
import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {volumeIcon} from './volume.js';
import {VERTICAL, scaleFactor} from './widgets.js';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

export const VOLUME_STYLES = ['led', 'knob', 'pill', 'fader', 'line'];

const SEGMENTS = 10;
const SCROLL_STEP = 0.05;
const KEY_STEP = 0.05;
const PAGE_STEP = 0.2;
// Dragging the knob this far (logical pixels) goes from silent to full.
const KNOB_TRAVEL = 150;
const METER_INTERVAL_MS = 150;
const DEFAULT_ACCENT = '#fafafa';
// The knob's arc starts at the bottom left and turns 270° clockwise.
const ARC_START = 0.75 * Math.PI;
const ARC_SPAN = 1.5 * Math.PI;

const clamp = v => Math.min(1, Math.max(0, v));

/** 'rgb(1, 2, 3)', 'rgba(…)' or '#abc'/'#aabbcc' -> [r, g, b], 0..255. */
function parseColor(css) {
    const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(css ?? '');
    if (rgb)
        return [rgb[1], rgb[2], rgb[3]].map(Number);
    const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(css ?? '');
    if (hex) {
        let digits = hex[1];
        if (digits.length === 3)
            digits = [...digits].map(d => d + d).join('');
        return [0, 2, 4].map(i => parseInt(digits.slice(i, i + 2), 16));
    }
    return parseColor(DEFAULT_ACCENT);
}

/** Natural size of an actor, from its stylesheet width/height. */
function naturalSize(actor) {
    return [actor.get_preferred_width(-1)[1], actor.get_preferred_height(-1)[1]];
}

/** The fader's level meter: green, yellow and red stripes. */
const Meter = GObject.registerClass(
class Meter extends St.DrawingArea {
    _init() {
        super._init({style_class: 'earful-vvol-meter'});
        this._level = 0;
    }

    setLevel(level) {
        if (level === this._level)
            return;
        this._level = level;
        this.queue_repaint();
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [sw, sh] = this.get_surface_size();
        const scale = scaleFactor();
        cr.scale(scale, scale);
        const w = sw / scale;
        const h = sh / scale;
        // Stripes of 3 px with 1 px gaps, from the bottom up.
        for (let bottom = h; bottom > 0; bottom -= 4) {
            const top = Math.max(0, bottom - 3);
            const at = 1 - (top + bottom) / 2 / h;
            let color = [0.17, 0.85, 0.42];
            if (at >= 0.82)
                color = [0.95, 0.27, 0.24];
            else if (at >= 0.6)
                color = [0.95, 0.82, 0.23];
            const lit = at <= this._level;
            cr.setSourceRGBA(...color, lit ? 1 : 0.15);
            cr.rectangle(0, top, w, bottom - top);
            cr.fill();
        }
        cr.$dispose();
    }
});

/**
 * The bar-like looks (led, pill, fader, line). Its parts are plain styled
 * widgets placed by hand at the current level; sizes come from the
 * stylesheet, so they follow the display scale.
 */
const Track = GObject.registerClass(
class Track extends St.Widget {
    _init(style) {
        super._init({
            style_class: `earful-vvol-control earful-vvol-track earful-vvol-${style}`,
            reactive: true,
            can_focus: true,
            x_align: Clutter.ActorAlign.CENTER,
            accessible_role: Atk.Role.SLIDER,
            accessible_name: _('Volume'),
        });
        this._style = style;
        this._value = 0;
        // Where the level can go, set on each layout: top of the content
        // box, its height, and how far the ends are kept from the edges.
        this._top = 0;
        this._height = 0;
        this._inset = 0;

        const part = name => {
            const actor = new St.Widget({style_class: `earful-vvol-${name}`});
            this.add_child(actor);
            return actor;
        };
        switch (style) {
        case 'led':
            // Every step first, then the lit parts, so a glow is not hidden
            // under the next step.
            this._segments = Array.from({length: SEGMENTS}, () => part('seg'));
            this._lit = Array.from({length: SEGMENTS}, () => part('lit'));
            break;
        case 'pill':
            this._fill = part('fill');
            break;
        case 'fader':
            this._groove = part('groove');
            this.meter = new Meter();
            this.add_child(this.meter);
            this._cap = part('cap');
            this._capLine = part('cap-line');
            break;
        default: // line
            this._rail = part('rail');
            this._fill = part('fill');
            this._thumb = part('thumb');
        }
    }

    setValue(value) {
        this._value = value;
        if (this._lit) {
            this._lit.forEach((lit, i) => {
                lit.visible = clamp(value * SEGMENTS - i) > 0;
            });
        }
        if (this._style === 'pill')
            this._fill.visible = value > 0;
        this.queue_relayout();
    }

    setAccent([r, g, b]) {
        const color = `background-color: rgb(${r}, ${g}, ${b});`;
        if (this._lit) {
            const glow = `box-shadow: 0 0 6px rgba(${r}, ${g}, ${b}, 0.7);`;
            for (const lit of this._lit)
                lit.style = color + glow;
        }
        if (this._fill)
            this._fill.style = color;
    }

    /** The level at a point, in stage coordinates. */
    valueAt(x, y) {
        const [ok, , localY] = this.transform_stage_point(x, y);
        if (!ok)
            return null;
        const travel = this._height - 2 * this._inset;
        if (travel <= 0)
            return null;
        return clamp((this._top + this._height - this._inset - localY) / travel);
    }

    // The size comes only from the stylesheet. The default would measure
    // the parts where they were last placed, and grow with the level.
    vfunc_get_preferred_width(_forHeight) {
        const [, natural] = this.get_theme_node().adjust_preferred_width(0, 0);
        return [natural, natural];
    }

    vfunc_get_preferred_height(_forWidth) {
        const [min, natural] = this.get_theme_node().adjust_preferred_height(0, 0);
        return [min, Math.max(min, natural)];
    }

    vfunc_allocate(box) {
        this.set_allocation(box);
        const content = this.get_theme_node().get_content_box(box);
        const x0 = content.x1;
        const y0 = content.y1;
        const w = content.get_width();
        const h = content.get_height();
        const v = this._value;
        // Places a part, in content box coordinates, on whole pixels.
        const put = (actor, x, y, width, height) => {
            const x1 = Math.round(x0 + x);
            const y1 = Math.round(y0 + y);
            actor.allocate(Clutter.ActorBox.new(x1, y1,
                Math.max(x1, Math.round(x0 + x + width)),
                Math.max(y1, Math.round(y0 + y + height))));
        };
        this._top = y0;
        this._height = h;
        this._inset = 0;

        switch (this._style) {
        case 'led': {
            const gap = this.get_theme_node().get_length('-earful-gap');
            const step = (h - gap * (SEGMENTS - 1)) / SEGMENTS;
            this._segments.forEach((segment, i) => {
                // Step 0 is at the bottom.
                const top = h - (i + 1) * step - i * gap;
                put(segment, 0, top, w, step);
                const lit = clamp(v * SEGMENTS - i);
                put(this._lit[i], 0, top + step * (1 - lit), w, step * lit);
            });
            break;
        }
        case 'pill': {
            put(this._fill, 0, h * (1 - v), w, h * v);
            break;
        }
        case 'fader': {
            const [capW, capH] = naturalSize(this._cap);
            const [grooveW] = naturalSize(this._groove);
            const [meterW] = naturalSize(this.meter);
            const [, lineH] = naturalSize(this._capLine);
            this._inset = capH / 2;
            const center = h - this._inset - v * (h - capH);
            put(this._groove, (capW - grooveW) / 2, 0, grooveW, h);
            put(this.meter, w - meterW, 0, meterW, h);
            put(this._cap, 0, center - capH / 2, capW, capH);
            const lineInset = Math.round(capW / 7);
            put(this._capLine, lineInset, center - lineH / 2, capW - 2 * lineInset, lineH);
            break;
        }
        default: { // line
            const [railW] = naturalSize(this._rail);
            const [thumbW, thumbH] = naturalSize(this._thumb);
            this._inset = thumbH / 2;
            const center = h - this._inset - v * (h - thumbH);
            put(this._rail, (w - railW) / 2, 0, railW, h);
            put(this._fill, (w - railW) / 2, center, railW, h - center);
            put(this._thumb, (w - thumbW) / 2, center - thumbH / 2, thumbW, thumbH);
        }
        }
    }
});

/** A round knob: an accent arc shows the level, a line points at it. */
const Knob = GObject.registerClass(
class Knob extends St.DrawingArea {
    _init() {
        super._init({
            style_class: 'earful-vvol-control earful-vvol-knob',
            reactive: true,
            can_focus: true,
            x_align: Clutter.ActorAlign.CENTER,
            accessible_role: Atk.Role.SLIDER,
            accessible_name: _('Volume'),
        });
        this._value = 0;
        this._accent = parseColor(DEFAULT_ACCENT);
        // A ring on the knob shows keyboard focus.
        this.connect('key-focus-in', () => this.queue_repaint());
        this.connect('key-focus-out', () => this.queue_repaint());
    }

    setValue(value) {
        this._value = value;
        this.queue_repaint();
    }

    setAccent(rgb) {
        this._accent = rgb;
        this.queue_repaint();
    }

    vfunc_get_preferred_width(_forHeight) {
        const [, natural] = this.get_theme_node().adjust_preferred_width(0, 0);
        return [natural, natural];
    }

    vfunc_get_preferred_height(_forWidth) {
        const [, natural] = this.get_theme_node().adjust_preferred_height(0, 0);
        return [natural, natural];
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [sw, sh] = this.get_surface_size();
        const scale = scaleFactor();
        // Draw in logical pixels.
        cr.scale(scale, scale);
        const w = sw / scale;
        const h = sh / scale;
        const cx = w / 2;
        const cy = h / 2;
        const outer = Math.min(w, h) / 2;
        const ring = 5;
        const inner = outer - ring;
        if (inner <= 0) {
            cr.$dispose();
            return;
        }

        // The arc: a dim track, then the level in the accent color.
        cr.setLineWidth(ring);
        cr.setLineCap(Cairo.LineCap.BUTT);
        cr.setSourceRGBA(1, 1, 1, 0.15);
        cr.arc(cx, cy, outer - ring / 2, ARC_START, ARC_START + ARC_SPAN);
        cr.stroke();
        if (this._value > 0) {
            const [r, g, b] = this._accent.map(c => c / 255);
            cr.setSourceRGB(r, g, b);
            cr.arc(cx, cy, outer - ring / 2, ARC_START, ARC_START + ARC_SPAN * this._value);
            cr.stroke();
        }

        // A soft shadow under the cap.
        for (let i = 0; i < 3; i++) {
            cr.setSourceRGBA(0, 0, 0, 0.14);
            cr.arc(cx, cy + 2, inner + 2 - i, 0, 2 * Math.PI);
            cr.fill();
        }

        // The cap, lit from the top left.
        const d = 2 * inner;
        const lightX = cx - inner + 0.35 * d;
        const lightY = cy - inner + 0.3 * d;
        const cap = new Cairo.RadialGradient(lightX, lightY, 0, lightX, lightY, 0.67 * d);
        cap.addColorStopRGB(0, 0x5a / 255, 0x5a / 255, 0x63 / 255);
        cap.addColorStopRGB(1, 0x26 / 255, 0x26 / 255, 0x2b / 255);
        cr.setSource(cap);
        cr.arc(cx, cy, inner, 0, 2 * Math.PI);
        cr.fill();

        if (this.has_key_focus()) {
            cr.setSourceRGBA(1, 1, 1, 0.6);
            cr.setLineWidth(1.5);
            cr.arc(cx, cy, inner - 0.75, 0, 2 * Math.PI);
            cr.stroke();
        }

        // The pointer: 0 points to the bottom left, full to the bottom right.
        const angle = (-135 + 270 * this._value) * Math.PI / 180;
        const dx = Math.sin(angle);
        const dy = -Math.cos(angle);
        const length = Math.round(inner * 0.9);
        cr.setSourceRGB(1, 1, 1);
        cr.setLineWidth(2);
        cr.setLineCap(Cairo.LineCap.ROUND);
        cr.moveTo(cx + dx * 2, cy + dy * 2);
        cr.lineTo(cx + dx * (length - 1), cy + dy * (length - 1));
        cr.stroke();
        cr.$dispose();
    }
});

/**
 * A vertical volume control with a speaker (mute) button under it. Hidden
 * when the source has no volume.
 */
export const VerticalVolume = GObject.registerClass(
class VerticalVolume extends St.BoxLayout {
    /**
     * @param {VolumeSource} source where the volume comes from
     * @param {object} options
     * @param {string} options.style one of VOLUME_STYLES
     * @param {boolean} options.compact the short one beside the cover
     */
    _init(source, {style = 'led', compact = false} = {}) {
        super._init({
            ...VERTICAL,
            style_class: compact ? 'earful-vvol earful-vvol-compact' : 'earful-vvol',
            visible: false,
        });
        this._source = source;
        this._compact = compact;
        this._style = null;
        this._control = null;
        this._value = 0;
        this._accent = parseColor(DEFAULT_ACCENT);
        this._playing = false;
        // The press being followed: grab, device, touch sequence, start.
        this._drag = null;
        this._meterId = 0;

        this._icon = new St.Icon({style_class: 'earful-volume-icon'});
        // Clicking the speaker mutes, and clicking again brings the volume back.
        this._muteButton = new St.Button({
            style_class: 'earful-volume-mute',
            can_focus: true,
            x_align: Clutter.ActorAlign.CENTER,
            accessible_name: _('Mute'),
            child: this._icon,
        });
        this._muteButton.connect('clicked', () => {
            const value = source.toggleMute();
            if (value !== null)
                this._show(value);
        });
        this.add_child(this._muteButton);

        // With the knob, this keeps the knob and the speaker together in
        // the middle of a tall card.
        this._spacer = new St.Widget({y_expand: true, visible: false});
        this.add_child(this._spacer);

        this.setStyle(style);

        source.connectObject('changed', () => this._sync(), this);
        St.Settings.get().connectObject('notify::enable-animations',
            () => this._syncMeter(), this);
        this.connect('destroy', () => {
            this._endDrag(false);
            this._stopMeter();
            source.disconnectObject(this);
            St.Settings.get().disconnectObject(this);
        });
        this._sync();
    }

    get dragging() {
        return this._drag !== null;
    }

    /** Swaps the control for another look, keeping the level. */
    setStyle(style) {
        if (!VOLUME_STYLES.includes(style))
            style = 'led';
        if (style === this._style)
            return;
        this._endDrag(false);
        this._stopMeter();
        this._control?.destroy();

        this._style = style;
        const knob = style === 'knob';
        const control = knob ? new Knob() : new Track(style);
        // Tall: the bar fills the card's height; the knob sits in the middle.
        control.y_expand = !this._compact;
        control.y_align = knob ? Clutter.ActorAlign.END : Clutter.ActorAlign.FILL;
        this._spacer.visible = knob && !this._compact;
        control.setAccent(this._accent);
        control.setValue(this._value);

        control.connect('button-press-event', (_a, event) => this._onPress(event));
        control.connect('button-release-event', () => {
            if (this._drag && !this._drag.sequence)
                this._endDrag();
            return Clutter.EVENT_STOP;
        });
        control.connect('motion-event', (_a, event) => {
            if (!this._drag || this._drag.sequence)
                return Clutter.EVENT_PROPAGATE;
            this._onMove(event);
            return Clutter.EVENT_STOP;
        });
        control.connect('touch-event', (_a, event) => this._onTouch(event));
        control.connect('scroll-event', (_a, event) => this._onScroll(event));
        control.connect('key-press-event', (_a, event) => this._onKey(event));
        // A closing menu takes the control away mid-drag.
        control.connect('notify::mapped', () => {
            if (!control.mapped)
                this._endDrag();
        });
        control.meter?.connect('notify::mapped', () => this._syncMeter());

        this._control = control;
        this.insert_child_at_index(control, 0);
        this._syncMeter();
    }

    /** @param {string|null} color CSS color, or null for the default */
    setAccent(color) {
        this._accent = parseColor(color ?? DEFAULT_ACCENT);
        this._control?.setAccent(this._accent);
    }

    /** The fader's meter moves while the player plays. */
    setPlaying(playing) {
        if (playing === this._playing)
            return;
        this._playing = playing;
        this._syncMeter();
    }

    _sync() {
        const value = this._source.read();
        this.visible = value !== null;
        // A drag owns the level until it ends.
        if (value === null || this._drag)
            return;
        this._show(value);
    }

    _show(value) {
        this._value = value;
        this._control.setValue(value);
        this._icon.icon_name = volumeIcon(value);
        this._muteButton.accessible_name = value > 0 ? _('Mute') : _('Unmute');
        this._syncMeter();
    }

    /** Sets a new level from the user and sends it to the source. */
    _change(value) {
        if (value === null)
            return;
        value = clamp(value);
        if (value === this._value)
            return;
        this._show(value);
        this._source.apply(value);
    }

    // Input follows GNOME's own slider: a grab while pressed, and every
    // press, release and scroll stopped here, so the menu item under the
    // control is not activated (that would raise the player and close the menu).

    _onPress(event) {
        if (!this._drag && event.get_button() === Clutter.BUTTON_PRIMARY)
            this._startDrag(event);
        return Clutter.EVENT_STOP;
    }

    _onTouch(event) {
        const type = event.type();
        const sequence = event.get_event_sequence();
        if (!this._drag && type === Clutter.EventType.TOUCH_BEGIN) {
            this._startDrag(event);
            return Clutter.EVENT_STOP;
        }
        if (this._drag?.sequence &&
            sequence.get_slot() === this._drag.sequence.get_slot()) {
            if (type === Clutter.EventType.TOUCH_UPDATE)
                this._onMove(event);
            else if (type === Clutter.EventType.TOUCH_END ||
                     type === Clutter.EventType.TOUCH_CANCEL)
                this._endDrag();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _startDrag(event) {
        const [x, y] = event.get_coords();
        this._drag = {
            grab: global.stage.grab(this._control),
            sequence: event.get_event_sequence(),
            startY: y,
            startValue: this._value,
        };
        // A click on a bar jumps there; the knob only turns when dragged.
        if (this._style !== 'knob')
            this._change(this._control.valueAt(x, y));
    }

    _onMove(event) {
        const [x, y] = event.get_coords();
        if (this._style === 'knob') {
            const travel = KNOB_TRAVEL * scaleFactor();
            this._change(this._drag.startValue + (this._drag.startY - y) / travel);
        } else {
            this._change(this._control.valueAt(x, y));
        }
    }

    /** @param {boolean} sync show the level the source really took */
    _endDrag(sync = true) {
        if (!this._drag)
            return;
        this._drag.grab?.dismiss();
        this._drag = null;
        if (sync)
            this._sync();
    }

    _onScroll(event) {
        // Smooth scrolling also sends emulated steps; count it once.
        if (event.get_flags() & Clutter.EventFlags.FLAG_POINTER_EMULATED)
            return Clutter.EVENT_STOP;
        let delta = 0;
        switch (event.get_scroll_direction()) {
        case Clutter.ScrollDirection.UP:
            delta = SCROLL_STEP;
            break;
        case Clutter.ScrollDirection.DOWN:
            delta = -SCROLL_STEP;
            break;
        case Clutter.ScrollDirection.SMOOTH: {
            const [, dy] = event.get_scroll_delta();
            delta = -dy * SCROLL_STEP;
            break;
        }
        }
        if (delta !== 0 && !this._drag)
            this._change(this._value + delta);
        return Clutter.EVENT_STOP;
    }

    _onKey(event) {
        const steps = {
            [Clutter.KEY_Up]: KEY_STEP,
            [Clutter.KEY_Down]: -KEY_STEP,
            [Clutter.KEY_Page_Up]: PAGE_STEP,
            [Clutter.KEY_Page_Down]: -PAGE_STEP,
            [Clutter.KEY_End]: 1,
            [Clutter.KEY_Home]: -1,
        };
        const delta = steps[event.get_key_symbol()];
        if (delta === undefined)
            return Clutter.EVENT_PROPAGATE;
        this._change(this._value + delta);
        return Clutter.EVENT_STOP;
    }

    // The fader's meter dances only while playing, seen, and allowed to
    // animate; otherwise it stands still (or empty when paused).
    _syncMeter() {
        const meter = this._control?.meter;
        if (!meter) {
            this._stopMeter();
            return;
        }
        const run = this._playing && this._value > 0 && meter.mapped &&
            St.Settings.get().enable_animations;
        if (run && !this._meterId) {
            this._meterId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, METER_INTERVAL_MS, () => {
                this._control.meter.setLevel(this._value * (0.75 + Math.random() * 0.25));
                return GLib.SOURCE_CONTINUE;
            });
            GLib.Source.set_name_by_id(this._meterId, '[earful] volume meter');
        } else if (!run) {
            this._stopMeter();
        }
        if (!this._meterId)
            meter.setLevel(this._playing ? this._value * 0.9 : 0);
    }

    _stopMeter() {
        if (this._meterId) {
            GLib.source_remove(this._meterId);
            this._meterId = 0;
        }
    }
});
