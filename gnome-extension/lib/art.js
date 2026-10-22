// Cover art: square-cropped, small, with rounded corners.

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

// Cover art is loaded by the shell itself, so only allow local files and web URLs.
const ART_URL = /^(file|https?):\/\//;
const MAX_BYTES = 8 * 1024 * 1024;
// Pixels per side of a cropped cover; enough for the biggest one on HiDPI.
const COVER_PIXELS = 256;
const CACHE_SIZE = 24;

// Recently loaded covers, newest last. Keyed by track too: some players
// (Chrome) reuse one file name for every cover.
const cache = new Map();

function loadBytes(file) {
    return new Promise((resolve, reject) => {
        file.load_contents_async(null, (f, res) => {
            try {
                resolve(f.load_contents_finish(res)[1]);
            } catch (e) {
                reject(e);
            }
        });
    });
}

function decode(bytes) {
    return new Promise((resolve, reject) => {
        const stream = Gio.MemoryInputStream.new_from_bytes(new GLib.Bytes(bytes));
        GdkPixbuf.Pixbuf.new_from_stream_async(stream, null, (s, res) => {
            try {
                resolve(GdkPixbuf.Pixbuf.new_from_stream_finish(res));
            } catch (e) {
                reject(e);
            }
        });
    });
}

function rgbToHsl([r, g, b]) {
    r /= 255;
    g /= 255;
    b /= 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min)
        return [0, 0, l];
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h;
    if (max === r)
        h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g)
        h = (b - r) / d + 2;
    else
        h = (r - g) / d + 4;
    return [h / 6, s, l];
}

function hslToRgb([h, s, l]) {
    const hue = t => {
        t = (t + 1) % 1;
        const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
        const p = 2 * l - q;
        if (t < 1 / 6)
            return p + (q - p) * 6 * t;
        if (t < 1 / 2)
            return q;
        if (t < 2 / 3)
            return p + (q - p) * (2 / 3 - t) * 6;
        return p;
    };
    return [hue(h + 1 / 3), hue(h), hue(h - 1 / 3)].map(v => Math.round(v * 255));
}

const clamp = (v, min, max) => Math.min(Math.max(v, min), max);

/**
 * The cover's main colors, toned for a card under white text:
 * {start, end} for the background gradient, {accent} for sliders.
 */
function makePalette(pixbuf) {
    const tiny = pixbuf.scale_simple(12, 12, GdkPixbuf.InterpType.BILINEAR);
    const pixels = tiny.get_pixels();
    const {rowstride, n_channels: channels} = tiny;

    // Weigh colors by how vivid they are, grouped by hue.
    const groups = new Map();
    for (let y = 0; y < 12; y++) {
        for (let x = 0; x < 12; x++) {
            const i = y * rowstride + x * channels;
            const [h, s, l] = rgbToHsl([pixels[i], pixels[i + 1], pixels[i + 2]]);
            const key = s < 0.15 || l < 0.08 || l > 0.94 ? 'grey' : Math.floor(h * 12);
            const weight = key === 'grey' ? 0.3 : 0.3 + s * (1 - Math.abs(l - 0.5));
            const group = groups.get(key) ?? {key, weight: 0, h: [0, 0], s: 0, l: 0};
            group.weight += weight;
            group.h[0] += Math.cos(h * 2 * Math.PI) * weight;
            group.h[1] += Math.sin(h * 2 * Math.PI) * weight;
            group.s += s * weight;
            group.l += l * weight;
            groups.set(key, group);
        }
    }
    // White, black and grey only count when the cover has little color.
    const total = [...groups.values()].reduce((sum, g) => sum + g.weight, 0);
    const grey = groups.get('grey');
    if (grey && grey.weight < total * 0.85)
        groups.delete('grey');
    const ranked = [...groups.values()].sort((a, b) => b.weight - a.weight)
        .map(g => [
            (Math.atan2(g.h[1], g.h[0]) / (2 * Math.PI) + 1) % 1,
            g.key === 'grey' ? 0.12 : g.s / g.weight,
            g.l / g.weight,
        ]);
    const [first] = ranked;
    // A second color with a clearly different hue makes a livelier gradient.
    const second = ranked.find(c =>
        Math.min(Math.abs(c[0] - first[0]), 1 - Math.abs(c[0] - first[0])) > 0.08 &&
        c[1] > 0.15) ?? first;

    const tone = ([h, s], l) => hslToRgb([h, clamp(s, 0, 0.75), l]);
    return {
        start: tone(first, 0.36),
        end: tone(second, 0.2),
        accent: hslToRgb([first[0], clamp(first[1], first[1] > 0.15 ? 0.55 : 0, 0.85), 0.66]),
    };
}

/** Crops the middle square (video thumbnails are wide) and shrinks it. */
async function makeCover(url) {
    const bytes = await loadBytes(Gio.File.new_for_uri(url));
    if (bytes.length > MAX_BYTES)
        throw new Error('cover art too large');
    const image = await decode(bytes);
    const side = Math.min(image.width, image.height);
    const square = image.new_subpixbuf(
        Math.floor((image.width - side) / 2),
        Math.floor((image.height - side) / 2), side, side);
    const pixels = Math.min(side, COVER_PIXELS);
    const small = square.scale_simple(pixels, pixels, GdkPixbuf.InterpType.BILINEAR);
    const [, png] = small.save_to_bufferv('png', [], []);
    return {
        // A bytes icon is not kept in the shell's texture cache forever.
        icon: Gio.BytesIcon.new(new GLib.Bytes(png)),
        palette: makePalette(small),
    };
}

/** Resolves to {icon, palette} of a square cover, or null if there is none. */
function loadCover(url, trackKey) {
    if (!ART_URL.test(url ?? ''))
        return Promise.resolve(null);
    const key = `${trackKey}\n${url}`;
    let promise = cache.get(key);
    if (promise) {
        cache.delete(key);
    } else {
        promise = makeCover(url).catch(() => null);
        if (cache.size >= CACHE_SIZE)
            cache.delete(cache.keys().next().value);
    }
    cache.set(key, promise);
    return promise;
}

export function clearCache() {
    cache.clear();
}

const CORNER_DECLARATIONS = `
uniform vec2 size;
uniform float radius;
`;
// Fades out everything outside a rounded rectangle, smoothing the edge.
const CORNER_CODE = `
vec2 p = cogl_tex_coord_in[0].xy * size;
vec2 q = abs(p - size * 0.5) - (size * 0.5 - radius);
float d = length(max(q, 0.0)) - radius;
cogl_color_out *= clamp(0.5 - d, 0.0, 1.0);
`;

const RoundedCorners = GObject.registerClass(
class RoundedCorners extends Shell.GLSLEffect {
    _init(radius) {
        super._init();
        this._radius = radius;
    }

    vfunc_build_pipeline() {
        // GNOME 48 moved the hook enum to Cogl.
        const hook = Shell.SnippetHook?.FRAGMENT ?? Cogl.SnippetHook.FRAGMENT;
        this.add_glsl_snippet(hook, CORNER_DECLARATIONS, CORNER_CODE, false);
    }

    vfunc_paint_target(node, paintContext) {
        const [width, height] = this.actor.get_size();
        this.set_uniform_float(this.get_uniform_location('size'), 2, [width, height]);
        this.set_uniform_float(this.get_uniform_location('radius'), 1,
            [Math.min(this._radius * scaleFactor(), width / 2, height / 2)]);
        super.vfunc_paint_target(node, paintContext);
    }
});

function scaleFactor() {
    return St.ThemeContext.get_for_stage(global.stage).scale_factor;
}

/**
 * A player's cover, or its app icon on a tinted tile while there is none
 * (or while the cover loads).
 */
export const CoverArt = GObject.registerClass({
    Signals: {'palette-changed': {}},
}, class CoverArt extends St.Bin {
    /**
     * @param {number} size side in logical pixels
     * @param {string} styleClass extra style class for the tile
     */
    _init(size, styleClass) {
        super._init({
            style_class: `earful-cover ${styleClass}`,
            style: `width: ${size}px; height: ${size}px;`,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._size = size;
        this._icon = new St.Icon({
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.set_child(this._icon);
        this._corners = new RoundedCorners(Math.round(size / 5));
        this._request = null;
        /** Colors of the shown cover, or null while there is none. */
        this.palette = null;
        this.connect('destroy', () => (this._icon = null));
    }

    /** Shows the player's current cover. */
    setPlayer(player) {
        const request = `${player.trackKey}\n${player.artUrl}`;
        if (request === this._request)
            return;
        this._request = request;

        // The previous cover stays until the next one is ready, so
        // skipping tracks doesn't flash the app icon and plain colors.
        const appIcon = player.appIcon;
        if (!this.palette)
            this._showIcon(appIcon);
        loadCover(player.artUrl, player.trackKey).then(cover => {
            // Still the same track, and not destroyed meanwhile.
            if (this._request !== request || !this._icon)
                return;
            if (cover)
                this._showCover(cover.icon);
            else
                this._showIcon(appIcon);
            this._setPalette(cover?.palette ?? null);
        });
    }

    _setPalette(palette) {
        if (palette === this.palette)
            return;
        this.palette = palette;
        this.emit('palette-changed');
    }

    _showIcon(gicon) {
        this.remove_style_pseudo_class('cover');
        this._icon.remove_effect(this._corners);
        this._icon.gicon = gicon;
        this._icon.icon_size = Math.round(this._size * 0.6);
    }

    _showCover(gicon) {
        this.add_style_pseudo_class('cover');
        this._icon.gicon = gicon;
        this._icon.icon_size = this._size;
        if (!this._icon.get_effects().includes(this._corners))
            this._icon.add_effect(this._corners);
    }
});
