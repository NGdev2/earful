// SPDX-License-Identifier: GPL-3.0-or-later
// Volume on the cover: scroll or drag on the cover art, and an animation on it shows the level.

import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {volumeIcon} from './volume.js';
import {scaleFactor} from './widgets.js';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

export const COVER_ANIMATIONS = [
    'liquid', 'cloud', 'dim', 'gray', 'ring', 'frame', 'bars', 'percent', 'speaker', 'heart',
];

const TAU = 2 * Math.PI;
const SCROLL_STEP = 0.05;
// Dragging this far (logical pixels) goes from silent to full.
const DRAG_TRAVEL = 150;
// A press must move this far up or down (logical pixels) to become a drag.
const DRAG_THRESHOLD = 4;
// How long the level stays on the cover after a scroll.
const LINGER_MS = 900;
const OVERLAY_FADE_MS = 200;
const BADGE_FADE_MS = 150;
// How fast the drawn level catches up with the real one (per second).
const LEVEL_RATE = 14;
const DEFAULT_ACCENT = '#fafafa';
const WHITE = [1, 1, 1];
const BLACK = [0, 0, 0];

// The liquid's slosh, in units of a 100×100 cover: a damped spring.
const SLOSH = {
    stiffness: 34,
    damping: 2.4,
    startTilt: 16,
    maxTilt: 26,
    swayTilt: 3.5,
    swaySpeed: 1.8,
    ripple: 1.2,
    rippleSpeed: 7,
};

// Variants that move by themselves; the others only move when the level does.
const ALWAYS_MOVING = new Set(['liquid', 'cloud']);

const clamp = v => Math.min(1, Math.max(0, v));
const frac = x => x - Math.floor(x);
const rgba = (cr, [r, g, b], a) => cr.setSourceRGBA(r, g, b, a);

/** 'rgb(1, 2, 3)', 'rgba(…)' or '#abc'/'#aabbcc' -> [r, g, b], 0..1. */
function parseColor(css) {
    const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(css ?? '');
    if (rgb)
        return [rgb[1], rgb[2], rgb[3]].map(v => clamp(Number(v) / 255));
    const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(css ?? '');
    if (hex) {
        let digits = hex[1];
        if (digits.length === 3)
            digits = [...digits].map(d => d + d).join('');
        return [0, 2, 4].map(i => parseInt(digits.slice(i, i + 2), 16) / 255);
    }
    return parseColor(DEFAULT_ACCENT);
}

function roundedRect(cr, x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    cr.newSubPath();
    cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
    cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
    cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
    cr.arc(x + r, y + r, r, Math.PI, 1.5 * Math.PI);
    cr.closePath();
}

function circle(cr, x, y, r) {
    cr.newSubPath();
    cr.arc(x, y, r, 0, TAU);
}

/** A pie slice from the top, clockwise; `from` and `to` are 0..1 of a turn. */
function slice(cr, cx, cy, r, from, to) {
    if (to <= from)
        return;
    cr.moveTo(cx, cy);
    cr.arc(cx, cy, r, -Math.PI / 2 + from * TAU, -Math.PI / 2 + to * TAU);
    cr.closePath();
}

/** Fills the level clockwise from the top in the accent, the rest in shade. */
function conic(cr, w, h, v, accent, shade) {
    const r = Math.hypot(w, h);
    slice(cr, w / 2, h / 2, r, 0, v);
    rgba(cr, accent, 1);
    cr.fill();
    slice(cr, w / 2, h / 2, r, v, 1);
    rgba(cr, BLACK, shade);
    cr.fill();
}

/** A heart in a 24×24 box. */
function heart(cr) {
    cr.moveTo(12, 21);
    cr.curveTo(12, 21, 4.5, 16.4, 2.4, 11.8);
    cr.curveTo(0.9, 8.4, 3, 4.5, 6.7, 4.5);
    cr.curveTo(8.9, 4.5, 10.3, 5.8, 12, 7.7);
    cr.curveTo(13.7, 5.8, 15.1, 4.5, 17.3, 4.5);
    cr.curveTo(21, 4.5, 23.1, 8.4, 21.6, 11.8);
    cr.curveTo(19.5, 16.4, 12, 21, 12, 21);
    cr.closePath();
}

/** Scales the context so a 24×24 icon of `side` device pixels is centered. */
function iconBox(cr, w, h, side) {
    cr.translate((w - side) / 2, (h - side) / 2);
    cr.scale(side / 24, side / 24);
}

// Each variant draws on the cover's w×h device pixels. `st` holds the level
// v (0..1), the accent, the display scale s, the unit u (a mockup pixel on
// a 64 px cover), the clock in seconds, and the liquid's tilt and ripple.
const DRAW = {
    // Water in a glass: a back and a front layer and a thin light line on
    // the surface, which tilts with the slosh.
    liquid(cr, w, h, st) {
        const {v, accent, tilt: a, ripple: r} = st;
        const level = 100 - v * 100;
        const X = x => x * w / 100;
        const Y = y => y * h / 100;
        const surface = (k, lift) => {
            const yl = level - a * k - lift;
            const yr = level + a * k - lift;
            cr.moveTo(0, Y(yl));
            cr.curveTo(X(35), Y(yl + a * k * 0.45 + r), X(65), Y(yr - a * k * 0.45 - r),
                w, Y(yr));
        };
        const body = (k, lift) => {
            surface(k, lift);
            cr.lineTo(w, h);
            cr.lineTo(0, h);
            cr.closePath();
        };

        body(0.65, 3);
        rgba(cr, accent, 0.34);
        cr.fill();

        // A touch deeper toward the bottom.
        body(1, 0);
        const top = Y(level - Math.abs(a) - Math.abs(r));
        const depth = new Cairo.LinearGradient(0, top, 0, Math.max(top + 1, h));
        depth.addColorStopRGBA(0, ...accent, 0.76);
        depth.addColorStopRGBA(1, ...accent, 0.66);
        cr.setSource(depth);
        cr.fill();

        if (v > 0) {
            surface(1, 0);
            rgba(cr, WHITE, 0.6);
            cr.setLineWidth(1.2 * st.s);
            cr.stroke();
        }
    },

    // A bumpy surface drifting sideways.
    cloud(cr, w, h, st) {
        if (st.v <= 0)
            return;
        const period = 24 * st.u;
        const half = period / 2;
        const top = h * (1 - st.v);
        const start = frac(st.time / 1.6) * period - period;
        let x = start;
        cr.moveTo(x, top);
        for (; x < w; x += period) {
            cr.save();
            cr.translate(x + half, top);
            cr.scale(1, 0.5);
            cr.arc(0, 0, half, Math.PI, TAU);
            cr.restore();
        }
        cr.lineTo(x, h);
        cr.lineTo(start, h);
        cr.closePath();
        rgba(cr, st.accent, 0.7);
        cr.fill();
    },

    // Darker above the level.
    dim(cr, w, h, st) {
        cr.rectangle(0, 0, w, h * (1 - st.v));
        rgba(cr, BLACK, 0.62);
        cr.fill();
    },

    // Gray above the level: a desaturated copy of the cover is clipped
    // there, and this darkens it. Without that copy, a gray tint fakes it.
    gray(cr, w, h, st) {
        cr.rectangle(0, 0, w, h * (1 - st.v));
        if (!st.desaturated) {
            rgba(cr, [0.5, 0.5, 0.5], 0.5);
            cr.fillPreserve();
        }
        rgba(cr, BLACK, 0.45);
        cr.fill();
    },

    // A round window; around it the level fills clockwise from the top.
    ring(cr, w, h, st) {
        cr.save();
        cr.setFillRule(Cairo.FillRule.EVEN_ODD);
        cr.rectangle(0, 0, w, h);
        circle(cr, w / 2, h / 2, Math.min(w, h) / 2 * 0.79);
        cr.clip();
        conic(cr, w, h, st.v, st.accent, 0.45);
        cr.restore();
    },

    // The border fills clockwise from the top.
    frame(cr, w, h, st) {
        const border = Math.max(3 * st.s, 4 * st.u);
        cr.save();
        cr.setFillRule(Cairo.FillRule.EVEN_ODD);
        roundedRect(cr, 0, 0, w, h, st.radius);
        roundedRect(cr, border, border, w - 2 * border, h - 2 * border,
            Math.max(0, st.radius - border));
        cr.clip();
        conic(cr, w, h, st.v, st.accent, 0.35);
        cr.restore();
    },

    // Five rising bars, lit up to the level.
    bars(cr, w, h, st) {
        const {u} = st;
        rgba(cr, BLACK, 0.4);
        cr.paint();
        const width = 6 * u;
        const gap = 4 * u;
        const pad = 10 * u;
        const x0 = (w - 5 * width - 4 * gap) / 2;
        [0.35, 0.5, 0.65, 0.8, 1].forEach((tall, i) => {
            const barH = tall * (h - 2 * pad);
            const x = x0 + i * (width + gap);
            const y = h - pad - barH;
            roundedRect(cr, x, y, width, barH, 2 * u);
            rgba(cr, WHITE, 0.25);
            cr.fillPreserve();
            rgba(cr, st.accent, clamp((st.v * 5 - i) * 4));
            cr.fill();
        });
    },

    // The number itself is a label above this.
    percent(cr, w, h) {
        cr.rectangle(0, 0, w, h);
        rgba(cr, BLACK, 0.45);
        cr.fill();
    },

    // A speaker whose three waves light up with the level.
    speaker(cr, w, h, st) {
        rgba(cr, BLACK, 0.45);
        cr.paint();
        cr.save();
        iconBox(cr, w, h, 34 * st.u);
        cr.moveTo(3, 9);
        cr.lineTo(7, 9);
        cr.lineTo(12, 4.5);
        cr.lineTo(12, 19.5);
        cr.lineTo(7, 15);
        cr.lineTo(3, 15);
        cr.closePath();
        rgba(cr, WHITE, 1);
        cr.fill();
        cr.setLineWidth(1.6);
        cr.setLineCap(Cairo.LineCap.ROUND);
        // [x of the ends, radius, half the gap between the ends, lights at]
        [[15, 3.5, 2.5, 0.01], [17.3, 6.6, 4.7, 0.34], [19.6, 9.8, 7, 0.67]]
            .forEach(([x, r, half, from]) => {
                const angle = Math.asin(half / r);
                cr.newSubPath();
                cr.arc(x - Math.sqrt(r * r - half * half), 12, r, -angle, angle);
                rgba(cr, WHITE, 0.2 + 0.8 * clamp((st.v - from) * 12));
                cr.stroke();
            });
        cr.restore();
    },

    // A heart outline that fills from the bottom.
    heart(cr, w, h, st) {
        rgba(cr, BLACK, 0.35);
        cr.paint();
        cr.save();
        iconBox(cr, w, h, 44 * st.u);
        cr.save();
        heart(cr);
        cr.clip();
        const top = 3 + 18 * (1 - st.v);
        cr.rectangle(0, top, 24, 24 - top);
        rgba(cr, st.accent, 1);
        cr.fill();
        cr.restore();
        heart(cr);
        rgba(cr, WHITE, 1);
        cr.setLineWidth(1.5);
        cr.stroke();
        cr.restore();
    },
};

/**
 * The cover art as a volume control. Scroll on it (or drag up and down) to
 * change the volume; while hovered or changing, an animation on the cover
 * shows the level, and a speaker badge in the corner mutes.
 *
 * Wraps the CoverArt: add this to the layout instead of the art. The art
 * is destroyed with it.
 */
export const CoverVolume = GObject.registerClass(
class CoverVolume extends St.Widget {
    /**
     * @param {object} art the CoverArt
     * @param {object} source the VolumeSource
     * @param {object} options
     * @param {string} options.animation one of COVER_ANIMATIONS
     * @param {number} options.size side of the cover in logical pixels
     */
    _init(art, source, {animation = 'liquid', size = 64} = {}) {
        super._init({
            style_class: 'earful-cv',
            layout_manager: new Clutter.BinLayout(),
            reactive: true,
            track_hover: true,
            y_align: Clutter.ActorAlign.CENTER,
            // Set on purpose, so the children's expand below doesn't
            // spread to this widget and widen the cover.
            x_expand: false,
            y_expand: false,
        });
        this._art = art;
        this._source = source;
        this._size = size;
        this._animation = null;
        this._accent = parseColor(DEFAULT_ACCENT);
        this._playing = false;
        this._available = false;
        // The real level and the one drawn, which follows it smoothly.
        this._value = 0;
        this._display = 0;
        // Shown: hovered or adjusting. Showing: the fade is not over yet.
        this._shown = false;
        this._lingerId = 0;
        this._destroyed = false;
        // A press that may turn into a drag, and the drag itself.
        this._press = null;
        this._drag = null;
        this._timeline = null;
        this._last = 0;
        this._time = 0;
        // The liquid's tilt and how fast it swings.
        this._tilt = 0;
        this._swing = 0;

        this.add_child(art);

        // Everything drawn on the cover fades in and out together. A bin
        // layout only aligns children that expand, so these fill the cover.
        this._layer = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            opacity: 0,
            visible: false,
            x_expand: true,
            y_expand: true,
        });
        this._gray = null;
        this._area = new St.DrawingArea({x_expand: true, y_expand: true});
        this._area.connect('repaint', () => this._paint());
        this._area.connect('notify::mapped', () => this._syncClock());
        this._layer.add_child(this._area);
        this._label = new St.Label({
            style_class: 'earful-cv-percent',
            style: `font-size: ${Math.max(9, Math.round(size * 0.28))}px;`,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        this._layer.add_child(this._label);
        this.add_child(this._layer);

        // Clicking the speaker mutes, and clicking again brings the volume back.
        const side = Math.max(12, Math.round(size * 0.31));
        this._icon = new St.Icon({
            icon_size: Math.round(side * 0.6),
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._badge = new St.Button({
            style_class: 'earful-cv-badge',
            style: `width: ${side}px; height: ${side}px; border-radius: ${side / 2}px;
                margin: ${Math.max(2, Math.round(size / 16))}px;`,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.END,
            x_expand: true,
            y_expand: true,
            accessible_name: _('Mute'),
            child: this._icon,
            opacity: 0,
            reactive: false,
            visible: false,
        });
        this._badge.connect('clicked', () => {
            const value = source.toggleMute();
            if (value !== null)
                this._setLevel(value);
        });
        this.add_child(this._badge);

        this.setAnimation(animation);

        this.connect('notify::hover', () => this._syncShown());
        this.connect('notify::mapped', () => {
            if (!this.mapped) {
                this._press = null;
                this._endDrag(false);
            }
        });
        this.connect('button-press-event', (_a, event) => this._onPress(event));
        this.connect('motion-event', (_a, event) => this._onMotion(event));
        this.connect('button-release-event', () => this._onRelease());
        this.connect('touch-event', (_a, event) => this._onTouch(event));
        this.connect('scroll-event', (_a, event) => this._onScroll(event));

        source.connectObject('changed', () => this._sync(), this);
        St.Settings.get().connectObject('notify::enable-animations', () => {
            this._display = this._value;
            this._syncClock();
            this._redraw();
        }, this);
        this.connect('destroy', () => {
            this._destroyed = true;
            this._press = null;
            this._drag?.grab?.dismiss();
            this._drag = null;
            this._stopClock();
            if (this._lingerId) {
                GLib.source_remove(this._lingerId);
                this._lingerId = 0;
            }
            source.disconnectObject(this);
            St.Settings.get().disconnectObject(this);
        });
        this._sync();
    }

    /** True while dragging, and for a moment after a scroll. */
    get adjusting() {
        return this._drag !== null || this._lingerId !== 0;
    }

    /** @param {string} id one of COVER_ANIMATIONS */
    setAnimation(id) {
        if (!COVER_ANIMATIONS.includes(id))
            id = 'liquid';
        if (id === this._animation)
            return;
        this._animation = id;
        this._label.visible = id === 'percent';
        this._setGray(id === 'gray');
        this._tilt = 0;
        this._swing = 0;
        this._syncClock();
        this._redraw();
    }

    /** @param {string|null} color CSS color, or null for the default */
    setAccent(color) {
        this._accent = parseColor(color ?? DEFAULT_ACCENT);
        this._redraw();
    }

    /** While playing, the liquid keeps a gentle sway. */
    setPlaying(playing) {
        this._playing = playing;
    }

    // A desaturated copy of the cover, shown above the level for 'gray'.
    // Left out where the shell has no such effect.
    _setGray(on) {
        if (on && !this._gray && Clutter.DesaturateEffect) {
            this._gray = new Clutter.Clone({source: this._art});
            this._gray.add_effect(new Clutter.DesaturateEffect({factor: 1}));
            this._gray.connect('notify::size', () => this._clipGray());
            this._layer.insert_child_below(this._gray, this._area);
        } else if (!on && this._gray) {
            this._gray.destroy();
            this._gray = null;
        }
    }

    _clipGray() {
        // Measuring before the cover is on screen asks for a style too early;
        // the size change that follows clips it.
        if (!this._gray?.get_stage())
            return;
        const [w, h] = this._gray.get_size();
        this._gray.set_clip(0, 0, w, Math.round(h * (1 - this._display)));
    }

    _sync() {
        const value = this._source.read();
        const available = value !== null;
        if (available !== this._available) {
            this._available = available;
            this._badge.visible = available;
            if (!available) {
                this._press = null;
                this._endDrag(false);
            }
            this._syncShown();
        }
        // A drag owns the level until it ends.
        if (!available || this._drag)
            return;
        this._setLevel(value);
    }

    /** Shows a new level; a change pushes the liquid. */
    _setLevel(value) {
        const change = value - this._value;
        this._icon.icon_name = volumeIcon(value);
        this._badge.accessible_name = value > 0 ? _('Mute') : _('Unmute');
        if (change === 0)
            return;
        this._value = value;
        if (this._timeline && this._animation === 'liquid')
            this._swing += Math.sign(change) * 60 + change * 300;
        this._syncClock();
        // Not animating: no clock to follow the level with.
        if (!this._timeline)
            this._display = value;
        this._redraw();
    }

    /** Sets a new level from the user and sends it to the source. */
    _change(value) {
        const next = clamp(value);
        if (next === this._value) {
            // Pushing past the top or bottom still makes a little splash.
            if (next !== value && this._timeline && this._animation === 'liquid')
                this._swing += Math.sign(value - next) * 25;
            return;
        }
        this._setLevel(next);
        this._source.apply(next);
    }

    // Shown while hovered or adjusting, if there is a volume at all.
    _syncShown() {
        if (this._destroyed)
            return;
        const shown = this._available && (this.hover || this.adjusting);
        if (shown === this._shown)
            return;
        this._shown = shown;
        this._badge.reactive = shown;
        this._badge.ease({
            opacity: shown ? 255 : 0,
            duration: BADGE_FADE_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
        if (shown && !this._layer.visible) {
            // The water starts tilted and settles.
            this._tilt = (Math.random() < 0.5 ? -1 : 1) * SLOSH.startTilt;
            this._swing = 0;
            this._display = this._value;
            this._layer.visible = true;
            this._redraw();
        }
        this._layer.ease({
            opacity: shown ? 255 : 0,
            duration: OVERLAY_FADE_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                if (!this._shown)
                    this._layer.visible = false;
            },
        });
    }

    _linger() {
        if (this._lingerId)
            GLib.source_remove(this._lingerId);
        this._lingerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, LINGER_MS, () => {
            this._lingerId = 0;
            this._syncShown();
            return GLib.SOURCE_REMOVE;
        });
        GLib.Source.set_name_by_id(this._lingerId, '[earful] cover volume');
        this._syncShown();
    }

    // Input. Scrolling is always ours. A press is left to the menu item, so
    // a plain click still raises the player; once it moves up or down it
    // becomes a drag: a grab like GNOME's slider, and the item's click is
    // called off.

    _onScroll(event) {
        if (!this._available)
            return Clutter.EVENT_PROPAGATE;
        // Smooth scrolling also sends emulated steps; count it once.
        if (event.get_flags() & Clutter.EventFlags.FLAG_POINTER_EMULATED)
            return Clutter.EVENT_STOP;
        let delta;
        switch (event.get_scroll_direction()) {
        case Clutter.ScrollDirection.UP:
            delta = SCROLL_STEP;
            break;
        case Clutter.ScrollDirection.DOWN:
            delta = -SCROLL_STEP;
            break;
        case Clutter.ScrollDirection.SMOOTH:
            delta = -event.get_scroll_delta()[1] * SCROLL_STEP;
            break;
        default:
            return Clutter.EVENT_PROPAGATE;
        }
        if (!this._drag) {
            this._change(this._value + delta);
            this._linger();
        }
        return Clutter.EVENT_STOP;
    }

    _onPress(event) {
        if (this._available && !this._drag && event.get_button() === Clutter.BUTTON_PRIMARY)
            this._watchPress(event);
        return Clutter.EVENT_PROPAGATE;
    }

    _onMotion(event) {
        if (this._drag && !this._drag.sequence) {
            this._onMove(event);
            return Clutter.EVENT_STOP;
        }
        if (this._press && !this._press.sequence) {
            // The button went up somewhere we didn't hear about.
            if (!(event.get_state() & Clutter.ModifierType.BUTTON1_MASK))
                this._press = null;
            else if (this._maybeStartDrag(event))
                return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _onRelease() {
        this._press = null;
        if (this._drag && !this._drag.sequence) {
            this._endDrag();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _onTouch(event) {
        const type = event.type();
        const sequence = event.get_event_sequence();
        const same = following => following?.sequence &&
            sequence?.get_slot() === following.sequence.get_slot();
        const ended = type === Clutter.EventType.TOUCH_END ||
            type === Clutter.EventType.TOUCH_CANCEL;

        if (same(this._drag)) {
            if (type === Clutter.EventType.TOUCH_UPDATE)
                this._onMove(event);
            else if (ended)
                this._endDrag();
            return Clutter.EVENT_STOP;
        }
        if (type === Clutter.EventType.TOUCH_BEGIN) {
            if (this._available && !this._drag && !this._press)
                this._watchPress(event);
        } else if (same(this._press)) {
            if (type === Clutter.EventType.TOUCH_UPDATE && this._maybeStartDrag(event))
                return Clutter.EVENT_STOP;
            if (ended)
                this._press = null;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _watchPress(event) {
        const [x, y] = event.get_coords();
        this._press = {x, y, sequence: event.get_event_sequence(), value: this._value};
    }

    /** Turns the press into a drag once it moves far enough up or down. */
    _maybeStartDrag(event) {
        const [x, y] = event.get_coords();
        const dx = Math.abs(x - this._press.x);
        const dy = Math.abs(y - this._press.y);
        const threshold = DRAG_THRESHOLD * scaleFactor();
        if (dx > threshold && dx > dy) {
            // Sideways: not a volume drag, leave it to the item.
            this._press = null;
            return false;
        }
        if (dy <= threshold)
            return false;

        const press = this._press;
        this._press = null;
        this._drag = {
            grab: global.stage.grab(this),
            sequence: press.sequence,
            startY: press.y,
            startValue: press.value,
        };
        this._cancelClicks();
        this._syncShown();
        this._onMove(event);
        return true;
    }

    // The menu item saw the press and would activate on release; the grab
    // should call that off, and releasing its click action makes sure.
    _cancelClicks() {
        if (!Clutter.ClickAction)
            return;
        for (let actor = this.get_parent(); actor; actor = actor.get_parent()) {
            for (const action of actor.get_actions()) {
                if (action instanceof Clutter.ClickAction && action.pressed)
                    action.release();
            }
        }
    }

    _onMove(event) {
        const [, y] = event.get_coords();
        const travel = DRAG_TRAVEL * scaleFactor();
        this._change(this._drag.startValue + (this._drag.startY - y) / travel);
    }

    /** @param {boolean} sync show the level the source really took */
    _endDrag(sync = true) {
        if (!this._drag)
            return;
        this._drag.grab?.dismiss();
        this._drag = null;
        if (sync) {
            this._sync();
            this._linger();
        } else {
            this._syncShown();
        }
    }

    // Animation clock: runs only while the overlay is on screen, animations
    // are on, and something moves.

    _syncClock() {
        const run = this._area.mapped && St.Settings.get().enable_animations &&
            (ALWAYS_MOVING.has(this._animation) || this._display !== this._value);
        if (run && !this._timeline) {
            this._last = GLib.get_monotonic_time();
            this._timeline = new Clutter.Timeline({
                actor: this._area,
                duration: 1000,
                repeat_count: -1,
            });
            this._timeline.connect('new-frame', () => this._tick());
            this._timeline.start();
        } else if (!run && this._timeline) {
            this._stopClock();
            this._display = this._value;
            this._redraw();
        }
    }

    _stopClock() {
        this._timeline?.stop();
        this._timeline = null;
    }

    _tick() {
        const now = GLib.get_monotonic_time();
        const seconds = Math.min(0.05, (now - this._last) / 1e6);
        this._last = now;
        if (seconds <= 0)
            return;
        this._time += seconds;

        const gap = this._value - this._display;
        this._display = Math.abs(gap) < 0.002 ? this._value
            : this._display + gap * Math.min(1, LEVEL_RATE * seconds);

        if (this._animation === 'liquid') {
            // A damped spring toward level, or toward a gentle sway while playing.
            const target = this._playing
                ? SLOSH.swayTilt * Math.sin(this._time * SLOSH.swaySpeed) : 0;
            this._swing += (-SLOSH.stiffness * (this._tilt - target) -
                SLOSH.damping * this._swing) * seconds;
            this._tilt = Math.max(-SLOSH.maxTilt,
                Math.min(SLOSH.maxTilt, this._tilt + this._swing * seconds));
        }

        this._redraw();
        if (!ALWAYS_MOVING.has(this._animation) && this._display === this._value)
            this._syncClock();
    }

    _redraw() {
        if (this._label.visible)
            this._label.text = `${Math.round(this._display * 100)}%`;
        this._clipGray();
        this._area.queue_repaint();
    }

    _paint() {
        const cr = this._area.get_context();
        const [w, h] = this._area.get_surface_size();
        if (this._available && w > 0 && h > 0) {
            const s = scaleFactor();
            const moving = St.Settings.get().enable_animations;
            const radius = Math.min(Math.round(this._size / 5) * s, w / 2, h / 2);
            roundedRect(cr, 0, 0, w, h, radius);
            cr.clip();
            DRAW[this._animation](cr, w, h, {
                v: this._display,
                accent: this._accent,
                s,
                u: w / 64,
                radius,
                time: moving ? this._time : 0,
                // Without animations, the water lies flat.
                tilt: moving ? this._tilt : 0,
                ripple: moving ? SLOSH.ripple * Math.sin(this._time * SLOSH.rippleSpeed) : 0,
                desaturated: this._gray !== null,
            });
        }
        cr.$dispose();
    }
});
