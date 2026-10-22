// Animated scenes painted behind a card or popup: a spinning record, a
// sound wave, a retro LED equalizer, a note riding a road, a cassette.
//
// Each scene has step(seconds, playing), which returns whether it is still
// moving, and draw(cr, width, height, colors, scale). Scenes only animate
// while visible and playing (or settling after a pause).

import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Look from './look.js';

const TAU = 2 * Math.PI;
const FRAME_SECONDS = 1 / 30;
const WHITE = [1, 1, 1];
const YELLOW = [1, 0.84, 0.22];
const RED = [1, 0.3, 0.24];

const rgba = (cr, [r, g, b], a) => cr.setSourceRGBA(r, g, b, a);
const frac = x => x - Math.floor(x);
// Moves `value` toward `target`, quickly for a high `rate`.
const approach = (value, target, rate, seconds) =>
    value + (target - value) * Math.min(1, rate * seconds);

function roundedRect(cr, x, y, w, h, r) {
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

/** An eighth note, drawn with paths so no font is needed. */
function note(cr, x, y, size) {
    cr.save();
    cr.translate(x, y);
    cr.rotate(-0.4);
    cr.scale(1, 0.72);
    circle(cr, 0, 0, size * 0.22);
    cr.restore();
    cr.fill();
    const stemX = x + size * 0.19;
    cr.setLineWidth(size * 0.07);
    cr.moveTo(stemX, y - size * 0.06);
    cr.lineTo(stemX, y - size * 0.8);
    cr.curveTo(stemX + size * 0.12, y - size * 0.55, stemX + size * 0.42, y - size * 0.55,
        stemX + size * 0.3, y - size * 0.25);
    cr.stroke();
}

class Vinyl {
    constructor() {
        this.fade = 0.25;
        this._angle = 0;
        this._speed = 0;
    }

    step(seconds, playing) {
        // Spins up and down like a turntable.
        this._speed = approach(this._speed, playing ? 0.45 : 0, 2.5, seconds);
        this._angle += this._speed * seconds * TAU;
        return this._speed > 0.002;
    }

    draw(cr, w, h, colors, s) {
        const radius = h * 0.8;
        const cx = w - radius * 0.62;
        const cy = h / 2;

        rgba(cr, [0.04, 0.04, 0.05], 0.92);
        circle(cr, cx, cy, radius);
        cr.fill();

        cr.setLineWidth(s);
        rgba(cr, WHITE, 0.05);
        for (let r = radius * 0.38; r < radius * 0.97; r += 3.2 * s)
            circle(cr, cx, cy, r);
        cr.stroke();

        cr.save();
        cr.translate(cx, cy);
        cr.rotate(this._angle);
        // Light catching the grooves.
        rgba(cr, WHITE, 0.06);
        for (const start of [0, Math.PI]) {
            cr.moveTo(0, 0);
            cr.arc(0, 0, radius * 0.97, start - 0.3, start + 0.3);
            cr.closePath();
        }
        cr.fill();
        // The label, with a mark that shows the spin.
        rgba(cr, colors.accent, 1);
        circle(cr, 0, 0, radius * 0.33);
        cr.fill();
        rgba(cr, WHITE, 0.55);
        cr.setLineWidth(2 * s);
        cr.arc(0, 0, radius * 0.22, -0.5, 0.5);
        cr.stroke();
        rgba(cr, [0.05, 0.05, 0.06], 1);
        circle(cr, 0, 0, 2.5 * s);
        cr.fill();
        cr.restore();

        // Tonearm from the top right corner onto the record.
        const pivotX = w - 12 * s;
        const pivotY = 12 * s;
        const headX = cx + radius * 0.55 * Math.cos(-2.15);
        const headY = cy + radius * 0.55 * Math.sin(-2.15);
        rgba(cr, [0.78, 0.78, 0.8], 0.9);
        cr.setLineWidth(3 * s);
        cr.moveTo(pivotX, pivotY);
        cr.lineTo(headX, headY);
        cr.stroke();
        circle(cr, pivotX, pivotY, 5 * s);
        cr.fill();
        cr.save();
        cr.translate(headX, headY);
        cr.rotate(Math.atan2(headY - pivotY, headX - pivotX));
        cr.rectangle(-4 * s, -4 * s, 10 * s, 8 * s);
        cr.restore();
        cr.fill();
    }
}

class Wave {
    constructor() {
        this.fade = 0.35;
        this._time = 0;
        this._energy = 0;
    }

    step(seconds, playing) {
        this._energy = approach(this._energy, playing ? 1 : 0, 2, seconds);
        this._time += seconds * (0.3 + this._energy);
        return this._energy > 0.01;
    }

    draw(cr, w, h, colors, s) {
        const base = h * 0.58;
        const path = i => {
            const amplitude = h * (0.05 + 0.17 * this._energy *
                (0.6 + 0.4 * Math.sin(this._time * 1.3 + i * 2)));
            const k = TAU / (w * (0.5 - i * 0.08));
            const phase = this._time * (2.2 + i * 0.7) + i;
            for (let x = 0; x <= w; x += 3 * s) {
                // Calm at the edges, loud in the middle.
                const envelope = Math.sin(Math.PI * x / w) ** 0.6;
                const y = base + amplitude * envelope * Math.sin(k * x - phase);
                if (x === 0)
                    cr.moveTo(x, y);
                else
                    cr.lineTo(x, y);
            }
        };

        path(0);
        cr.lineTo(w, h);
        cr.lineTo(0, h);
        cr.closePath();
        rgba(cr, colors.accent, 0.1);
        cr.fill();

        [0.85, 0.5, 0.3].forEach((alpha, i) => {
            path(i);
            rgba(cr, i === 1 ? WHITE : colors.accent, alpha);
            cr.setLineWidth((2.4 - i * 0.6) * s);
            cr.stroke();
        });
    }
}

class Leds {
    constructor() {
        this.fade = 0.8;
        this._levels = [];
        this._targets = [];
        this._peaks = [];
        this._holds = [];
        this._timer = 0;
    }

    _resize(count) {
        // New columns start mid-song, so a still picture isn't empty.
        while (this._levels.length < count) {
            const level = 0.25 + 0.5 * Math.random();
            this._levels.push(level);
            this._targets.push(level);
            this._peaks.push(Math.min(1, level + 0.12));
            this._holds.push(0.5);
        }
    }

    step(seconds, playing) {
        const count = this._levels.length;
        this._timer -= seconds;
        if (this._timer <= 0) {
            this._timer = 0.11;
            for (let i = 0; i < count; i++) {
                // Basses on the left are louder; neighbours move together.
                const tilt = 0.95 - 0.35 * i / Math.max(1, count - 1);
                const random = (Math.random() + (this._targets[i - 1] ?? Math.random())) / 2;
                this._targets[i] = playing ? Math.min(1, tilt * (0.35 + 0.8 * random)) : 0;
            }
        }
        let moving = false;
        for (let i = 0; i < count; i++) {
            this._levels[i] = approach(this._levels[i], this._targets[i], 12, seconds);
            // Peak caps hold a moment, then fall.
            if (this._levels[i] >= this._peaks[i]) {
                this._peaks[i] = this._levels[i];
                this._holds[i] = 0.5;
            } else if ((this._holds[i] -= seconds) <= 0) {
                this._peaks[i] = Math.max(0, this._peaks[i] - seconds * 0.5);
            }
            moving ||= this._levels[i] > 0.01 || this._peaks[i] > 0.01;
        }
        return moving;
    }

    draw(cr, w, h, colors, s) {
        // A dark display panel on the right, like on a hi-fi deck.
        const panelX = w * 0.5;
        const panelY = 8 * s;
        const panelW = w - panelX - 8 * s;
        const panelH = h - 2 * panelY;
        roundedRect(cr, panelX, panelY, panelW, panelH, 8 * s);
        rgba(cr, [0.02, 0.02, 0.04], 0.55);
        cr.fill();

        const width = 7 * s;
        const gap = 3 * s;
        const segment = 3 * s;
        const segmentGap = 2 * s;
        const inset = 8 * s;
        const columns = Math.floor((panelW - 2 * inset + gap) / (width + gap));
        const rows = Math.floor((panelH - 2 * inset + segmentGap) / (segment + segmentGap));
        this._resize(columns);
        // Center the columns in the panel.
        const left = panelX + (panelW - columns * (width + gap) + gap) / 2;
        const bottom = panelY + panelH - inset;

        for (let col = 0; col < columns; col++) {
            const lit = Math.round(this._levels[col] * rows);
            const peak = Math.round(this._peaks[col] * rows) - 1;
            const x = left + col * (width + gap);
            for (let row = 0; row < rows; row++) {
                const f = row / rows;
                // Your color, then the warning zone, like on old hi-fi decks.
                let color = colors.accent;
                if (f >= 0.82)
                    color = RED;
                else if (f >= 0.6)
                    color = YELLOW;
                const on = row < lit || (row === peak && peak > 0);
                rgba(cr, color, on ? 0.9 : 0.1);
                cr.rectangle(x, bottom - (row + 1) * (segment + segmentGap) + segmentGap,
                    width, segment);
                cr.fill();
            }
        }
    }
}

class Road {
    constructor() {
        this.fade = 0.3;
        this._time = 0;
        this._speed = 0;
    }

    step(seconds, playing) {
        this._speed = approach(this._speed, playing ? 1 : 0, 2, seconds);
        this._time += seconds * this._speed;
        return this._speed > 0.005;
    }

    draw(cr, w, h, colors, s) {
        const horizon = h * 0.42;
        const vanish = w * 0.76;
        const spread = w * 0.5;
        const t = this._time;

        // A glow on the horizon.
        const glow = new Cairo.RadialGradient(vanish, horizon, 0, vanish, horizon, h * 0.5);
        glow.addColorStopRGBA(0, ...colors.accent, 0.45);
        glow.addColorStopRGBA(1, ...colors.accent, 0);
        cr.setSource(glow);
        cr.rectangle(0, 0, w, horizon);
        cr.fill();

        // The skyline is an equalizer, pulsing with the music.
        rgba(cr, colors.accent, 0.4);
        for (let x = 4 * s; x < w; x += 6 * s) {
            const shape = 0.3 + 0.7 * Math.abs(Math.sin(x * 0.037 / s) * Math.cos(x * 0.013 / s));
            const pulse = 0.75 + 0.25 * Math.sin(t * 6 + x * 0.05 / s);
            const height = shape * pulse * h * 0.13;
            cr.rectangle(x, horizon - height, 3 * s, height);
        }
        cr.fill();

        // Road edges and lines rushing toward you.
        cr.setLineWidth(1.5 * s);
        rgba(cr, colors.accent, 0.7);
        cr.moveTo(vanish, horizon);
        cr.lineTo(vanish - spread, h);
        cr.moveTo(vanish, horizon);
        cr.lineTo(vanish + spread, h);
        cr.stroke();
        for (let i = 0; i < 7; i++) {
            const f = ((i + frac(t * 0.9)) / 7) ** 2;
            const y = horizon + (h - horizon) * f;
            rgba(cr, colors.accent, 0.08 + 0.3 * f);
            cr.moveTo(vanish - spread * f, y);
            cr.lineTo(vanish + spread * f, y);
            cr.stroke();
        }
        rgba(cr, WHITE, 0.55);
        for (let i = 0; i < 6; i++) {
            const z = (i + frac(t * 1.4)) / 6;
            const from = z ** 2;
            const to = Math.min(1, (z + 0.06) ** 2);
            cr.setLineWidth((1 + 3 * from) * s);
            cr.moveTo(vanish, horizon + (h - horizon) * from);
            cr.lineTo(vanish, horizon + (h - horizon) * to);
            cr.stroke();
        }

        // The note hops along, leaving a trail.
        // Mid-road in the right lane, clear of the text and buttons.
        const depth = 0.5;
        const size = h * 0.24;
        const x = vanish + spread * depth * 0.35;
        const ground = horizon + (h - horizon) * depth;
        const hop = Math.abs(Math.sin(t * 4.5)) * h * 0.08;
        rgba(cr, [0, 0, 0], 0.25);
        cr.save();
        cr.translate(x + size * 0.05, ground);
        cr.scale(1, 0.3);
        circle(cr, 0, 0, size * 0.28 * (1 - hop / (h * 0.2)));
        cr.restore();
        cr.fill();
        cr.setLineWidth(1.5 * s);
        for (let i = 1; i <= 3; i++) {
            rgba(cr, WHITE, 0.3 / i);
            cr.moveTo(x - size * (0.25 + i * 0.22), ground - hop - size * 0.15 * i);
            cr.lineTo(x - size * (0.05 + i * 0.22), ground - hop - size * 0.15 * i);
            cr.stroke();
        }
        rgba(cr, WHITE, 0.95);
        note(cr, x, ground - hop - size * 0.12, size);
    }
}

class Cassette {
    constructor() {
        this.fade = 0.3;
        this._angle = 0;
        this._speed = 0;
        // How far the tape has wound, 0..1; a side lasts a few minutes.
        this._wound = 0.3;
    }

    step(seconds, playing) {
        this._speed = approach(this._speed, playing ? 1 : 0, 3, seconds);
        this._angle += this._speed * seconds * TAU * 0.5;
        this._wound = frac(this._wound + this._speed * seconds / 240);
        return this._speed > 0.005;
    }

    draw(cr, w, h, colors, s) {
        const bodyH = h * 0.8;
        const bodyW = bodyH * 1.6;
        const x0 = w - bodyW - 10 * s;
        const y0 = (h - bodyH) / 2;

        roundedRect(cr, x0, y0, bodyW, bodyH, 8 * s);
        rgba(cr, [0.07, 0.07, 0.09], 0.8);
        cr.fillPreserve();
        rgba(cr, colors.accent, 0.6);
        cr.setLineWidth(1.5 * s);
        cr.stroke();

        // Label with a stripe in your color.
        roundedRect(cr, x0 + 7 * s, y0 + 7 * s, bodyW - 14 * s, bodyH * 0.62, 4 * s);
        rgba(cr, colors.accent, 0.22);
        cr.fill();
        rgba(cr, colors.accent, 0.7);
        cr.rectangle(x0 + 7 * s, y0 + 7 * s + bodyH * 0.1, bodyW - 14 * s, 3 * s);
        cr.fill();

        // Window with the two reels.
        const winX = x0 + bodyW * 0.2;
        const winY = y0 + bodyH * 0.27;
        const winW = bodyW * 0.6;
        const winH = bodyH * 0.3;
        roundedRect(cr, winX, winY, winW, winH, winH / 2);
        rgba(cr, [0, 0, 0], 0.65);
        cr.fillPreserve();
        cr.save();
        cr.clip();
        const hub = bodyH * 0.1;
        const reels = [[winX + winW * 0.22, 1 - this._wound], [winX + winW * 0.78, this._wound]];
        rgba(cr, [0.3, 0.18, 0.12], 0.95);
        for (const [x, amount] of reels)
            circle(cr, x, winY + winH / 2, hub * (1.15 + 1.4 * amount));
        cr.fill();
        cr.restore();

        for (const [x] of reels) {
            const y = winY + winH / 2;
            rgba(cr, WHITE, 0.9);
            circle(cr, x, y, hub);
            cr.fill();
            cr.save();
            cr.translate(x, y);
            cr.rotate(this._angle);
            rgba(cr, [0.1, 0.1, 0.12], 1);
            for (let i = 0; i < 6; i++) {
                cr.rotate(TAU / 6);
                cr.rectangle(hub * 0.35, -hub * 0.12, hub * 0.5, hub * 0.24);
            }
            cr.fill();
            cr.restore();
        }

        // The head opening at the bottom.
        const bottomW = bodyW * 0.5;
        const bx = x0 + (bodyW - bottomW) / 2;
        const by = y0 + bodyH;
        cr.moveTo(bx, by);
        cr.lineTo(bx + bottomW * 0.1, by - bodyH * 0.17);
        cr.lineTo(bx + bottomW * 0.9, by - bodyH * 0.17);
        cr.lineTo(bx + bottomW, by);
        cr.closePath();
        rgba(cr, colors.accent, 0.25);
        cr.fill();
    }
}

const SCENES = {
    vinyl: Vinyl,
    wave: Wave,
    leds: Leds,
    road: Road,
    cassette: Cassette,
};

function toColors(palette) {
    const unit = c => c.map(v => v / 255);
    return {accent: unit(palette.accent), start: unit(palette.start), end: unit(palette.end)};
}

/** Paints the chosen scene behind a card; hidden for other designs. */
export const SceneLayer = GObject.registerClass(
class SceneLayer extends St.DrawingArea {
    /** @param {number} radius corner radius of the card, in logical pixels */
    _init(radius) {
        super._init({x_expand: true, y_expand: true, visible: false});
        this._radius = radius;
        this._name = '';
        this._scene = null;
        this._colors = null;
        this._playing = false;
        this._animate = false;
        // Paused and done moving: no need to wake up for frames.
        this._settled = false;
        this._timeline = null;

        this.connect('repaint', () => this._paint());
        this.connect('notify::mapped', () => this._syncClock());
        St.Settings.get().connectObject('notify::enable-animations',
            () => this._syncClock(), this);
        this.connect('destroy', () => {
            this._stopClock();
            St.Settings.get().disconnectObject(this);
        });
    }

    update(look, palette, playing) {
        const name = Look.isScene(look) ? look.design : '';
        if (name !== this._name) {
            this._name = name;
            this._scene = name ? new SCENES[name]() : null;
            // A still picture should show the scene in motion, not empty.
            this._scene?.step(1.5, true);
        }
        this.visible = this._scene !== null;
        this._colors = toColors(Look.paletteFor(look, palette));
        if (playing)
            this._settled = false;
        this._playing = playing;
        this._animate = look.animate;
        this._syncClock();
        this.queue_repaint();
    }

    _syncClock() {
        const run = this._scene !== null && this._animate && this.mapped &&
            St.Settings.get().enable_animations && !this._settled;
        if (run && !this._timeline) {
            this._last = GLib.get_monotonic_time();
            this._timeline = new Clutter.Timeline({
                actor: this,
                duration: 1000,
                repeat_count: -1,
            });
            this._timeline.connect('new-frame', () => this._tick());
            this._timeline.start();
        } else if (!run && this._timeline) {
            this._stopClock();
        }
    }

    _stopClock() {
        this._timeline?.stop();
        this._timeline = null;
    }

    _tick() {
        const now = GLib.get_monotonic_time();
        const seconds = (now - this._last) / 1e6;
        if (seconds < FRAME_SECONDS)
            return;
        this._last = now;
        const moving = this._scene.step(Math.min(seconds, 0.1), this._playing);
        if (!moving && !this._playing) {
            this._settled = true;
            this._syncClock();
        }
        this.queue_repaint();
    }

    _paint() {
        const cr = this.get_context();
        const [w, h] = this.get_surface_size();
        if (this._scene && w > 0 && h > 0) {
            const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
            roundedRect(cr, 0, 0, w, h, Math.min(this._radius * scale, h / 2));
            cr.clip();
            cr.pushGroup();
            this._scene.draw(cr, w, h, this._colors, scale);
            cr.popGroupToSource();
            // Softer under the text on the left.
            const fade = new Cairo.LinearGradient(0, 0, w, 0);
            fade.addColorStopRGBA(0, 0, 0, 0, this._scene.fade);
            fade.addColorStopRGBA(0.5, 0, 0, 0, (this._scene.fade + 1) / 2);
            fade.addColorStopRGBA(1, 0, 0, 0, 1);
            cr.mask(fade);
        }
        cr.$dispose();
    }
});
