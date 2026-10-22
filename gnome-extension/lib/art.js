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
    // A bytes icon is not kept in the shell's texture cache forever.
    return Gio.BytesIcon.new(new GLib.Bytes(png));
}

/** Resolves to a square cover icon, or null if there is none. */
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
export const CoverArt = GObject.registerClass(
class CoverArt extends St.Bin {
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
        this.connect('destroy', () => (this._icon = null));
    }

    /** Shows the player's current cover. */
    setPlayer(player) {
        const request = `${player.trackKey}\n${player.artUrl}`;
        if (request === this._request)
            return;
        this._request = request;

        this._showIcon(player.appIcon);
        loadCover(player.artUrl, player.trackKey).then(cover => {
            // Still the same track, and not destroyed meanwhile.
            if (cover && this._request === request && this._icon)
                this._showCover(cover);
        });
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
