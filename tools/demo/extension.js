// Demo director for tools/record-demo.sh: inside a throwaway shell it plays
// out the README scenes (track changes, the menu, designs, card and list
// layouts, seeking, volume on the cover, copying titles, settings) and saves
// numbered frames plus timings to $EARFUL_DEMO_OUT/<clip>/, stills to
// $EARFUL_DEMO_OUT/. $EARFUL_DEMO_SCENES (comma separated) picks scenes.
// Never install it for real.

import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const OUT = GLib.getenv('EARFUL_DEMO_OUT');
const FRAME_MS = 66; // about 15 frames per second
const STAGE_WIDTH = 1280;
const STAGE_HEIGHT = 800;

const MPRIS = 'org.mpris.MediaPlayer2.';
const SPOTIFY = 'spotify';
const YOUTUBE = 'earful_tab_101.instance4242';
const SOUNDCLOUD = 'earful_tab_102.instance4242';

// Every scene, in recording order. Spotify skips once in 'hero' and once in
// 'menu' (the popup stills count on that); the other scenes leave it alone.
const SCENES = ['hero', 'menu', 'designs', 'styles', 'progress', 'cards', 'liquid',
    'list', 'copy', 'popups', 'settings'];
const ASKED = (GLib.getenv('EARFUL_DEMO_SCENES') ?? '').split(',')
    .map(s => s.trim()).filter(Boolean);
// 'popup-styles' and 'looks' only run when asked for by name.
const wanted = scene => (ASKED.length ? ASKED.includes(scene) : SCENES.includes(scene));

// The popup styles for the 'popup-styles' clip, named as in Settings, and
// those that change when pointed at.
const POPUP_STYLES = {
    key: 'popup-style',
    values: [
        ['hover', 'Controls on hover'], ['current', 'Classic, no controls'],
        ['countdown', 'Next button and timer line'], ['mini', 'Mini pill'],
        ['island', 'Island'], ['big', 'Big cover'],
    ],
    pointed: ['hover', 'island'],
    // Big cover is left out of the clip: alone it would make it three
    // times as tall. popup-styles.png and docs/looks.md show it.
    inClip: style => style !== 'big',
};

// Where the settings window's page tabs are, from the middle of its title
// bar (measured on a 620 px window).
const SETTINGS_TABS = [-123, 0, 123];
const SETTINGS_PAGES = ['menu', 'popups', 'behaviour'];

// Width of the popup stills in docs/looks.md: the grown island (400 px),
// its 16 px from the screen edge and room for its shadow.
const LOOKS_POPUP_WIDTH = 452;

const wait = ms => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
    resolve();
    return GLib.SOURCE_REMOVE;
}));

const busName = player => (player.startsWith(MPRIS) ? player : `${MPRIS}${player}`);

function call(player, method, params = null, iface = 'org.mpris.MediaPlayer2.Player') {
    return new Promise(resolve => {
        Gio.DBus.session.call(busName(player), '/org/mpris/MediaPlayer2',
            iface, method, params, null, Gio.DBusCallFlags.NONE, -1, null, (bus, res) => {
                try {
                    bus.call_finish(res);
                } catch (e) {
                    logError(e, `earful-demo: ${method} on ${player}`);
                }
                resolve();
            });
    });
}

const next = player => call(player, 'Next');
const pause = player => call(player, 'Pause');
const play = player => call(player, 'Play');
const setVolume = (player, value) => call(player, 'Set',
    new GLib.Variant('(ssv)', ['org.mpris.MediaPlayer2.Player', 'Volume',
        new GLib.Variant('d', value)]), 'org.freedesktop.DBus.Properties');

/** Bounds of an actor on the screen as [x, y, width, height]. */
function bounds(actor) {
    const [x, y] = actor.get_transformed_position();
    const [w, h] = actor.get_transformed_size();
    return [x, y, w, h];
}

function center(actor) {
    const [x, y, w, h] = bounds(actor);
    return [x + w / 2, y + h / 2];
}

/** The smallest box around both, as [x, y, width, height]. */
function union(a, b) {
    if (!a)
        return b;
    const x = Math.min(a[0], b[0]);
    const y = Math.min(a[1], b[1]);
    return [x, y, Math.max(a[0] + a[2], b[0] + b[2]) - x, Math.max(a[1] + a[3], b[1] + b[3]) - y];
}

/** A box grown by `margin` on every side, kept on the screen. */
function grow([x, y, w, h], margin) {
    const left = Math.max(0, Math.round(x - margin));
    const top = Math.max(0, Math.round(y - margin));
    return [left, top, Math.min(STAGE_WIDTH, Math.round(x + w + margin)) - left,
        Math.min(STAGE_HEIGHT, Math.round(y + h + margin)) - top];
}

/** Where a slider's handle is (or would be) for `value`. */
function handleAt(slider, value) {
    const [x, y, w, h] = bounds(slider);
    let radius = 0;
    try {
        radius = slider.get_theme_node().get_length('-slider-handle-radius');
    } catch {}
    return [x + radius + value * (w - 2 * radius), y + h / 2];
}

async function shotArea(path, box) {
    const [x, y, w, h] = grow(box, 0);
    const stream = Gio.File.new_for_path(path)
        .replace(null, false, Gio.FileCreateFlags.NONE, null);
    await new Shell.Screenshot().screenshot_area(x, y, w, h, stream);
    stream.close(null);
}

/** Saves frames of one screen area with their real timing. */
class Recorder {
    constructor(name, box) {
        this._dir = `${OUT}/${name}`;
        GLib.mkdir_with_parents(this._dir, 0o755);
        this._box = grow(box, 0);
        this._times = [];
        this._fades = [];
        this._recording = true;
        this._done = this._loop();
    }

    async _loop() {
        while (this._recording) {
            const start = GLib.get_monotonic_time();
            const index = String(this._times.length).padStart(5, '0');
            await shotArea(`${this._dir}/${index}.png`, this._box);
            this._times.push(start);
            const spent = (GLib.get_monotonic_time() - start) / 1000;
            await wait(Math.max(1, FRAME_MS - spent));
        }
    }

    /**
     * Keeps only this part of the screen in the clip, for scenes whose size
     * is only known once they have played (written to `crop`, for ffmpeg).
     */
    cropTo(box) {
        const [bx, by, bw, bh] = this._box;
        const [x, y, w, h] = grow(box, 0);
        const left = Math.max(x, bx);
        const top = Math.max(y, by);
        const width = Math.min(x + w, bx + bw) - left;
        const height = Math.min(y + h, by + bh) - top;
        if (width > 0 && height > 0)
            GLib.file_set_contents(`${this._dir}/crop`, `${width}:${height}:${left - bx}:${top - by}`);
    }

    /** The number of the next frame. */
    mark() {
        return this._times.length;
    }

    /**
     * Turns the frames from `from` (a mark() taken just before a change)
     * up to now into a crossfade, done by crossfade.js after recording.
     */
    fade(from) {
        this._fades.push(`${from} ${this.mark()}`);
    }

    /** Stops and writes an ffmpeg concat list with each frame's duration. */
    async stop() {
        this._recording = false;
        await this._done;
        if (this._fades.length)
            GLib.file_set_contents(`${this._dir}/fades`, `${this._fades.join('\n')}\n`);
        const end = GLib.get_monotonic_time();
        const lines = this._times.map((time, i) => {
            const duration = ((this._times[i + 1] ?? end) - time) / 1e6;
            return `file '${String(i).padStart(5, '0')}.png'\nduration ${duration.toFixed(3)}`;
        });
        // ffmpeg's concat reader ignores the last duration without this.
        lines.push(`file '${String(this._times.length - 1).padStart(5, '0')}.png'`);
        GLib.file_set_contents(`${this._dir}/frames.txt`, `${lines.join('\n')}\n`);
    }
}

/** GNOME's arrow pointer, drawn: area screenshots leave the real one out. */
function drawArrow(area) {
    const cr = area.get_context();
    cr.scale(1.15, 1.15);
    const outline = () => {
        cr.moveTo(3, 2);
        cr.lineTo(3, 20);
        cr.lineTo(7.4, 15.9);
        cr.lineTo(10.4, 22.6);
        cr.lineTo(13.2, 21.4);
        cr.lineTo(10.3, 14.8);
        cr.lineTo(16, 14.8);
        cr.closePath();
    };
    cr.save();
    cr.translate(0.8, 1.4);
    outline();
    cr.setSourceRGBA(0, 0, 0, 0.3);
    cr.fill();
    cr.restore();
    outline();
    cr.setSourceRGB(0.08, 0.08, 0.08);
    cr.fillPreserve();
    cr.setLineWidth(1.4);
    cr.setLineJoin(Cairo.LineJoin.ROUND);
    cr.setSourceRGB(1, 1, 1);
    cr.stroke();
    cr.$dispose();
}

/** A virtual mouse that real widgets react to, with a drawn pointer. */
class Mouse {
    constructor() {
        // GNOME 51 dropped Clutter.get_default_backend().
        const backend = Clutter.get_default_backend?.() ?? global.stage.context.get_backend();
        this._device = backend.get_default_seat()
            .create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
        this._arrow = new St.DrawingArea({visible: false});
        this._arrow.set_size(24, 30);
        this._arrow.connect('repaint', drawArrow);
        // A ring at the tip on each click.
        this._ring = new St.Widget({
            style: 'border-radius: 14px; border: 2px solid rgba(255, 255, 255, 0.9); ' +
                'background-color: rgba(255, 255, 255, 0.2);',
            opacity: 0,
            visible: false,
        });
        this._ring.set_size(28, 28);
        this._ring.set_pivot_point(0.5, 0.5);
        global.stage.add_child(this._ring);
        global.stage.add_child(this._arrow);
        this.park();
    }

    get position() {
        return [this._x, this._y];
    }

    _send(x, y) {
        this._x = x;
        this._y = y;
        this._device.notify_absolute_motion(GLib.get_monotonic_time(), x, y);
        this._arrow.set_position(Math.round(x - 3), Math.round(y - 2));
    }

    /** Shows the pointer at a spot. */
    show(x, y) {
        this._send(x, y);
        global.stage.set_child_above_sibling(this._ring, null);
        global.stage.set_child_above_sibling(this._arrow, null);
        this._arrow.show();
    }

    /** Hides the pointer and moves it where it points at nothing. */
    park() {
        this._arrow.hide();
        this._send(40, STAGE_HEIGHT - 40);
    }

    /** Glides to a spot, easing in and out. */
    async moveTo(x, y, ms = 500) {
        const [x0, y0] = [this._x, this._y];
        const steps = Math.max(1, Math.round(ms / 16));
        for (let i = 1; i <= steps; i++) {
            const t = i / steps;
            const e = t < 0.5 ? 2 * t * t : 1 - (2 - 2 * t) ** 2 / 2;
            this._send(x0 + (x - x0) * e, y0 + (y - y0) * e);
            await wait(16);
        }
    }

    press() {
        this._device.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_PRIMARY,
            Clutter.ButtonState.PRESSED);
        this._ring.set_position(Math.round(this._x - 14), Math.round(this._y - 14));
        this._ring.remove_all_transitions();
        this._ring.scale_x = this._ring.scale_y = 0.4;
        this._ring.opacity = 255;
        this._ring.show();
        this._ring.ease({
            scale_x: 1.3,
            scale_y: 1.3,
            opacity: 0,
            duration: 420,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onStopped: () => this._ring.hide(),
        });
    }

    release() {
        this._device.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_PRIMARY,
            Clutter.ButtonState.RELEASED);
    }

    async click() {
        this.press();
        await wait(90);
        this.release();
    }

    /** Wheel steps, up (true) or down, `ms` apart. */
    async scroll(up, steps = 1, ms = 150) {
        for (let i = 0; i < steps; i++) {
            this._device.notify_discrete_scroll(GLib.get_monotonic_time(),
                up ? Clutter.ScrollDirection.UP : Clutter.ScrollDirection.DOWN,
                Clutter.ScrollSource.WHEEL);
            await wait(ms);
        }
    }

    /** Presses at a spot, drags to another and lets go. */
    async drag([x0, y0], [x1, y1], ms = 1000) {
        await this.moveTo(x0, y0, 450);
        await wait(250);
        this.press();
        await wait(200);
        await this.moveTo(x1, y1, ms);
        await wait(250);
        this.release();
    }

    destroy() {
        this._arrow.destroy();
        this._ring.destroy();
    }
}

export default class DemoDirector extends Extension {
    enable() {
        if (!OUT)
            return;
        this._caption = new St.Label({
            style: 'font-size: 15px; font-weight: bold; color: #ffffff; ' +
                'background-color: rgba(0, 0, 0, 0.62); border-radius: 99px; ' +
                'padding: 7px 18px;',
            visible: false,
        });
        Main.layoutManager.addTopChrome(this._caption);
        this._run().catch(e => logError(e, 'earful-demo'))
            .finally(() => GLib.file_set_contents(`${OUT}/done`, ''));
    }

    get _earful() {
        return Main.panel.statusArea['earful@NGdev2.github.io'];
    }

    _player(bus) {
        return this._earful._manager.players.find(p => p.busName === busName(bus));
    }

    /** The menu's player rows, top to bottom. */
    _items() {
        return this._earful._section._getMenuItems().filter(i => i.player);
    }

    _item(bus) {
        return this._items().find(i => i.player.busName === busName(bus));
    }

    /** Menu bounds as [x, y, width, height]. */
    _menuBox() {
        return bounds(this._earful.menu.actor);
    }

    /**
     * A crop of the top right corner down to below the menu (or a box
     * around several menu sizes), with room for a caption.
     */
    _menuCrop(box, captionRoom) {
        const [x, y, w, h] = box;
        const left = Math.max(0, x - 18);
        this._captionAt = [x + w / 2, y + h + 14];
        this._captionRoom = [left, STAGE_WIDTH];
        return [left, 0, STAGE_WIDTH - left, y + h + (captionRoom ? 64 : 18)];
    }

    /** Opens the menu and returns a crop around it. */
    async _openMenu(captionRoom) {
        this._earful.menu.open(false);
        await wait(900);
        return this._menuCrop(this._menuBox(), captionRoom);
    }

    async _closeMenu() {
        this._earful.menu.close(false);
        await wait(400);
    }

    /**
     * Shows changed layout settings in the open menu right away (the menu
     * itself waits until it is closed, so rows don't jump under the pointer).
     */
    async _relayout(caption = null) {
        await wait(60);
        const earful = this._earful;
        if (earful.menu.isOpen) {
            earful._rebuild();
            earful._fitToScreen();
        }
        if (caption)
            this._showCaption(caption);
        await wait(450);
    }

    /** Shows the first config with its caption and starts recording. */
    async _startTour(name, box, configs, apply) {
        apply(configs[0]);
        await this._relayout();
        this._showCaption(configs[0].at(-1));
        await wait(150);
        const rec = new Recorder(name, box);
        this._mouse.show(box[0] + 8, box[1] + box[3] * 0.5);
        return rec;
    }

    /** The next config of a tour, crossfading in the clip. */
    async _switchTo(rec, config, apply) {
        const from = rec.mark();
        apply(config);
        await this._relayout(config.at(-1));
        await wait(100);
        rec.fade(from);
    }

    /** Opens the menu and finds a crop that fits it in every config. */
    async _openForTour(configs, apply) {
        this._earful.menu.open(false);
        await wait(700);
        let box = null;
        let width = 0;
        for (const config of configs) {
            apply(config);
            await this._relayout();
            box = union(box, this._menuBox());
            width = Math.max(width, this._earful.menu.box.width);
        }
        // Each config as wide as the widest, so nothing shifts sideways
        // when one crossfades into the next (_endTour() lets go).
        this._earful.menu.box.min_width = width;
        await this._relayout();
        return this._menuCrop(union(box, this._menuBox()), true);
    }

    _endTour() {
        this._earful.menu.box.min_width_set = false;
    }

    _showCaption(text) {
        this._caption.text = text;
        this._caption.show();
        const [width] = this._caption.get_preferred_width(-1);
        const [x, y] = this._captionAt;
        // Centered, but kept inside the picture.
        const [left, right] = this._captionRoom ?? [0, STAGE_WIDTH];
        const at = Math.min(Math.max(x - width / 2, left + 8), right - width - 8);
        this._caption.set_position(Math.round(at), Math.round(y));
    }

    /** Somewhere in the middle of both songs, for the progress bars. */
    async _midSongs() {
        this._player(SPOTIFY)?.setPosition(64);
        this._player(YOUTUBE)?.setPosition(71);
        await wait(400);
    }

    async _shot(name, box) {
        GLib.mkdir_with_parents(OUT, 0o755);
        await shotArea(`${OUT}/${name}.png`, box);
    }

    async _run() {
        for (let i = 0; i < 80 && !this._earful?._manager; i++)
            await wait(250);
        const settings = this._earful._settings;
        this._settings = settings;
        // Software rendering (as in a headless shell) turns GNOME's
        // animations off; the clips are about them.
        this._forcedAnimations = global.force_animations;
        global.force_animations = true;
        settings.set_int('toast-duration', 4);
        settings.set_boolean('show-panel-label', true);
        // Popups only where a clip is about them.
        settings.set_boolean('toasts-enabled', false);
        this._mouse = new Mouse();
        // The players, and a moment for their covers.
        for (let i = 0; i < 80 && this._earful._manager.players.length < 3; i++)
            await wait(250);
        // Spotify last: the top bar shows the player changed last, and the
        // hero starts on Spotify's song.
        await setVolume(SOUNDCLOUD, 0.8);
        await setVolume(YOUTUBE, 0.86);
        await setVolume(SPOTIFY, 0.74);
        await wait(3000);

        if (wanted('hero'))
            await this._hero();
        // From here on no top bar label: it changes width (and moves the
        // menu) each time another player becomes the current one.
        settings.set_boolean('show-panel-label', false);
        await wait(300);
        if (wanted('menu'))
            await this._menuClip();

        // Two players from here on, for smaller pictures.
        if (this._player(SOUNDCLOUD)) {
            await call(SOUNDCLOUD, 'Quit', null, 'org.mpris.MediaPlayer2');
            await wait(1500);
        }
        if (wanted('designs'))
            await this._designs();
        if (wanted('styles'))
            await this._styles();

        if (wanted('progress'))
            await this._progress();
        if (wanted('cards'))
            await this._cards();
        if (wanted('liquid'))
            await this._liquid();
        if (wanted('list'))
            await this._list();
        if (wanted('copy'))
            await this._copy();
        if (wanted('popups'))
            await this._popups();
        if (wanted('popup-styles'))
            await this._popupStyles();
        if (wanted('settings'))
            await this._settingsPages();
        if (wanted('looks'))
            await this._looks();
    }

    /** Hero: track changes pop up, stack, and glide away. */
    async _hero() {
        this._settings.set_boolean('toasts-enabled', true);
        const rec = new Recorder('hero', [760, 0, 520, 290]);
        await wait(700);
        await next(SPOTIFY);
        await wait(1600);
        await next(YOUTUBE);
        await wait(5300);
        await rec.stop();
        this._settings.set_boolean('toasts-enabled', false);
    }

    /** The menu: every player and tab, live colors, volume, pause. */
    async _menuClip() {
        const box = await this._openMenu(false);
        const rec = new Recorder('menu', box);
        await wait(1200);
        await next(SPOTIFY);
        await wait(1800);
        await pause(YOUTUBE);
        await wait(1000);
        for (let v = 0.8; v >= 0.3; v -= 0.05) {
            await setVolume(SOUNDCLOUD, v);
            await wait(90);
        }
        await wait(900);
        await play(YOUTUBE);
        await wait(1400);
        await rec.stop();
        await this._closeMenu();
    }

    /** Designs and colors. */
    async _designs() {
        const settings = this._settings;
        const box = await this._openMenu(true);
        this._showCaption('Gradient');
        await wait(150);
        const rec = new Recorder('designs', box);
        const designs = [
            ['cover', 'Gradient'], ['glass', 'Dark glass'], ['vinyl', 'Vinyl'],
            ['wave', 'Sound wave'], ['leds', 'Retro equalizer'], ['road', 'Note road'],
            ['cassette', 'Cassette'],
        ];
        for (const [design, label] of designs) {
            settings.set_string('design', design);
            this._showCaption(label);
            await wait(2300);
        }
        settings.set_string('design', 'leds');
        for (const [color, label] of [['green', 'Green'], ['amber', 'Amber'], ['pink', 'Pink']]) {
            settings.set_string('design-color', color);
            this._showCaption(`Retro equalizer · ${label}`);
            await wait(1500);
        }
        await rec.stop();
        this._caption.hide();
        await this._closeMenu();
        settings.reset('design-color');
        settings.reset('design');
    }

    /** Menu styles, as stills. */
    async _styles() {
        const settings = this._settings;
        for (const [style, label] of [['cards', 'Cards'], ['list', 'List'], ['compact', 'Compact']]) {
            settings.set_string('menu-style', style);
            await wait(500);
            const box = await this._openMenu(true);
            this._showCaption(label);
            await wait(400);
            await this._shot(`style-${style}`, box);
            this._caption.hide();
            await this._closeMenu();
            await wait(100);
        }
        settings.reset('menu-style');
        await wait(500);
    }

    /** Dragging the progress bar seeks; the time follows the handle. */
    async _progress() {
        const mouse = this._mouse;
        await this._midSongs();
        const box = await this._openMenu(false);
        const [first, second] = this._items();
        const rec = new Recorder('progress', box);
        mouse.show(box[0] + 8, box[1] + box[3] * 0.55);
        await wait(700);
        const bar = first._progress.slider;
        await mouse.drag(handleAt(bar, bar.value), handleAt(bar, 0.8), 1300);
        await wait(1600);
        if (second?._progress?.visible) {
            const other = second._progress.slider;
            await mouse.drag(handleAt(other, other.value), handleAt(other, 0.18), 1100);
            await wait(1500);
        }
        await mouse.moveTo(box[0] + 8, box[1] + box[3] * 0.6, 500);
        await wait(500);
        await rec.stop();
        mouse.park();
        await this._closeMenu();
    }

    /** A tour of the card layouts and volume styles. */
    async _cards() {
        const settings = this._settings;
        const mouse = this._mouse;
        // Named as in Settings.
        const configs = [
            ['standing-volume', 'led', 'Volume on the right · LED steps'],
            ['standing-volume', 'knob', 'Volume on the right · Knob'],
            ['standing-volume', 'pill', 'Volume on the right · Pill'],
            ['side-volume', 'led', 'Volume beside the cover'],
            ['slim', 'led', 'Slim'],
            ['cover-volume', 'led', 'Volume on the cover'],
        ];
        const apply = ([layout, style]) => {
            settings.set_string('card-layout', layout);
            settings.set_string('card-volume-style', style);
        };
        await this._midSongs();
        const box = await this._openForTour(configs, apply);
        const rec = await this._startTour('cards', box, configs, apply);
        for (const [i, config] of configs.entries()) {
            if (i > 0)
                await this._switchTo(rec, config, apply);
            const item = this._items()[0];
            if (item._vvolume) {
                // The tip low on the control, so the level stays in sight.
                const control = item._vvolume._control ?? item._vvolume;
                const [x, y, w, h] = bounds(control);
                const knob = config[1] === 'knob';
                await mouse.moveTo(x + w / 2, y + h * (knob ? 0.5 : 0.82), 450);
                await mouse.scroll(false, 4, 130);
                await mouse.scroll(true, 5, 130);
                await wait(500);
            } else if (item._coverVolume) {
                const [x, y] = center(item._coverVolume);
                await mouse.moveTo(x - 8, y - 6, 500);
                await wait(300);
                await mouse.scroll(false, 5, 140);
                await mouse.scroll(true, 4, 140);
                await wait(700);
            } else {
                // Slim: the line on the edge grows on hover.
                const [x, y] = center(item._art);
                await mouse.moveTo(x - 6, y - 4, 500);
                await wait(1600);
            }
        }
        await mouse.moveTo(box[0] + 8, box[1] + box[3] * 0.5, 500);
        await wait(500);
        await rec.stop();
        this._caption.hide();
        mouse.park();
        await this._closeMenu();
        this._endTour();
        settings.reset('card-layout');
        settings.reset('card-volume-style');
        await wait(300);
    }

    /** Scrolling on the cover fills it like water. */
    async _liquid() {
        const settings = this._settings;
        const mouse = this._mouse;
        settings.set_string('card-layout', 'cover-volume');
        settings.reset('cover-volume-animation');
        await this._midSongs();
        this._earful.menu.open(false);
        await wait(900);
        // The YouTube card: on its dark cover the water shows best.
        const items = this._items();
        const item = this._item(YOUTUBE) ?? items[0];
        await setVolume(item.player.busName, 0.3);
        await wait(600);
        // The card, and half the gap to its neighbours around it.
        const [ix, iy, iw, ih] = bounds(item);
        const gaps = items.filter(i => i !== item).map(i => {
            const [, y, , h] = bounds(i);
            return y > iy ? y - (iy + ih) : iy - (y + h);
        });
        const gap = Math.min(24, ...gaps);
        const box = grow([ix, iy, iw, ih], Math.max(2, Math.min(12, Math.floor(gap / 2))));
        // Below the cover: on the way up it passes no title.
        const rest = [ix + 34, iy + ih - 6];
        const rec = new Recorder('liquid', box);
        mouse.show(...rest);
        await wait(500);
        const [x, y] = center(item._coverVolume);
        await mouse.moveTo(x - 8, y - 6, 700);
        await wait(1000);
        await mouse.scroll(true, 9, 170);
        await wait(1300);
        await mouse.scroll(false, 5, 150);
        await wait(1400);
        await mouse.scroll(true, 2, 170);
        await wait(1200);
        await mouse.moveTo(...rest, 600);
        await wait(1400);
        await rec.stop();
        mouse.park();
        await this._closeMenu();
        settings.reset('card-layout');
        await wait(300);
    }

    /** A tour of the list layouts. */
    async _list() {
        const settings = this._settings;
        const mouse = this._mouse;
        settings.set_string('menu-style', 'list');
        await wait(500);
        // Named as in Settings.
        const configs = [
            ['cover-volume', 'Volume on the cover'],
            ['one-line', 'One line, two jobs'],
            ['two-bars', 'Two bars'],
        ];
        const apply = ([layout]) => settings.set_string('list-layout', layout);
        await this._midSongs();
        const box = await this._openForTour(configs, apply);
        const rec = await this._startTour('list', box, configs, apply);
        for (const [i, config] of configs.entries()) {
            if (i > 0)
                await this._switchTo(rec, config, apply);
            const item = this._items()[0];
            const bars = item._listBars;
            if (item._coverVolume) {
                const [x, y] = center(item._coverVolume);
                await mouse.moveTo(x - 6, y - 6, 500);
                await wait(500);
                await mouse.scroll(false, 4, 140);
                await mouse.scroll(true, 3, 140);
                await wait(900);
            } else if (bars?._lines) {
                // One line: the progress, then the speaker turns it into the volume.
                const [lx, ly] = center(bars._lines);
                await mouse.moveTo(lx, ly, 500);
                await wait(800);
                const [sx, sy] = center(bars._volume.button);
                await mouse.moveTo(sx, sy, 400);
                await wait(700);
                const slider = bars._volume.slider;
                await mouse.drag(handleAt(slider, slider.value),
                    handleAt(slider, Math.max(0.2, slider.value - 0.35)), 700);
                await wait(700);
            } else if (bars) {
                // Two bars: the one pointed at grows.
                const [tx, ty] = center(bars._time);
                await mouse.moveTo(tx, ty, 500);
                await wait(900);
                const [vx, vy] = center(bars._vol);
                await mouse.moveTo(vx, vy, 450);
                await wait(700);
                const slider = bars._volume.slider;
                await mouse.drag(handleAt(slider, slider.value),
                    handleAt(slider, Math.min(1, slider.value + 0.25)), 700);
                await wait(800);
            }
        }
        await mouse.moveTo(box[0] + 8, box[1] + box[3] * 0.5, 500);
        await wait(500);
        await rec.stop();
        this._caption.hide();
        mouse.park();
        await this._closeMenu();
        this._endTour();
        settings.reset('list-layout');
        settings.reset('menu-style');
        await wait(300);
    }

    /** Pointing at a title shows a copy icon, a click copies it; long ones slide. */
    async _copy() {
        const mouse = this._mouse;
        const longTitle = () => this._items().find(i => i._title._overflow?.() > 0);
        await this._midSongs();
        this._earful.menu.open(false);
        await wait(900);
        // The YouTube tab's last video has a long title.
        for (let i = 0; i < 3 && !longTitle(); i++) {
            await this._closeMenu();
            await next(YOUTUBE);
            await wait(800);
            await this._midSongs();
            this._earful.menu.open(false);
            await wait(900);
        }
        const items = this._items();
        const box = grow(bounds(this._earful._scroll), 14);
        const long = longTitle();
        const short = items.find(i => i !== long) ?? items[0];
        if (!long)
            log('earful-demo: no title is long enough to slide');
        const rec = new Recorder('copy', box);
        mouse.show(box[0] + box[2] - 30, box[1] + box[3] - 8);
        await wait(500);
        const [x, y] = center(short._title);
        await mouse.moveTo(x - 10, y, 650);
        await wait(900);
        await mouse.click();
        await wait(1600);
        if (long) {
            const [lx, ly] = center(long._title);
            await mouse.moveTo(lx - 30, ly, 600);
            // It waits 1.2 s, slides to the end, waits and comes back.
            await wait(5200);
        }
        await mouse.moveTo(box[0] + box[2] - 30, box[1] + box[3] - 8, 600);
        await wait(600);
        await rec.stop();
        mouse.park();
        await this._closeMenu();
    }

    /** The newest popup's bounds, with room for its shadow. */
    _popupBox() {
        const popups = Main.layoutManager.uiGroup.get_children()
            .filter(a => a.has_style_class_name?.('earful-toast') && a.visible && !a.dismissing);
        const popup = popups.at(-1);
        return popup ? grow(bounds(popup), 18) : null;
    }

    /** The Next button of the newest popup, if it has one. */
    _popupNextButton() {
        const popup = Main.layoutManager.uiGroup.get_children()
            .filter(a => a.has_style_class_name?.('earful-toast') && !a.dismissing).at(-1);
        const search = actor => actor.accessible_name === 'Next' ? actor
            : actor.get_children().map(search).find(Boolean) ?? null;
        return popup ? search(popup) : null;
    }

    /** Popups in a few designs, as stills. */
    async _popups() {
        const settings = this._settings;
        settings.set_boolean('toasts-enabled', true);
        settings.set_string('toast-position', 'top-right');
        for (const design of ['vinyl', 'cassette', 'road', 'leds']) {
            settings.set_string('popup-design', design);
            await next(SPOTIFY);
            await wait(1200);
            await this._shot(`popup-${design}`,
                this._popupBox() ?? [STAGE_WIDTH - 420, 36, 420, 128]);
            await wait(4500);
        }
        settings.reset('popup-design');
        settings.set_boolean('toasts-enabled', false);
        await wait(1000);
    }

    /** Each popup style in turn (see POPUP_STYLES). */
    async _popupStyles() {
        const settings = this._settings;
        const mouse = this._mouse;
        const {key, values, pointed} = POPUP_STYLES;
        if (!settings.settings_schema.has_key(key)) {
            log(`earful-demo: no ${key} setting yet`);
            return;
        }
        const popupsOnScreen = () => Main.layoutManager.uiGroup.get_children()
            .some(a => a.has_style_class_name?.('earful-toast'));
        settings.set_boolean('toasts-enabled', true);
        settings.set_string('toast-position', 'top-right');
        settings.set_int('toast-duration', 3);
        // Room for the biggest; the clip is cut to what was used.
        const area = [STAGE_WIDTH - 600, 0, 600, 260];
        const rec = new Recorder('popup-styles', area);
        let used = null;
        const see = () => {
            const popup = this._popupBox();
            if (popup)
                used = union(used, popup);
            return popup;
        };
        for (const [value, label] of values.filter(([v]) => POPUP_STYLES.inClip(v))) {
            settings.set_string(key, value);
            await wait(200);
            await next(SPOTIFY);
            await wait(700);
            const popup = see();
            if (popup) {
                this._captionAt = [popup[0] + popup[2] / 2, popup[1] + popup[3] + 2];
                this._captionRoom = [area[0], STAGE_WIDTH];
                this._showCaption(label);
                await wait(50);
                used = union(used, grow(bounds(this._caption), 6));
            }
            const nextButton = value === 'countdown' ? this._popupNextButton() : null;
            if (nextButton) {
                // The line shrinks, Next swaps the track in place and fills
                // it again; it waits while the pointer is on the popup.
                await wait(1600);
                const [x, y] = center(nextButton);
                mouse.show(x - 70, y + 90);
                await mouse.moveTo(x, y, 600);
                await wait(300);
                await mouse.click();
                await wait(1400);
                await mouse.moveTo(x - 70, y + 110, 500);
                mouse.park();
                await wait(1200);
            } else if (popup && pointed.includes(value)) {
                const [x, y] = [popup[0] + popup[2] * 0.4, popup[1] + popup[3] / 2];
                mouse.show(x - 60, y + 90);
                await mouse.moveTo(x, y, 600);
                await wait(1500);
                see();
                await mouse.moveTo(x - 60, y + 110, 500);
                mouse.park();
            } else {
                await wait(1500);
            }
            // Gone before the next one, so they don't stack.
            for (let i = 0; i < 50 && popupsOnScreen(); i++)
                await wait(150);
            this._caption.hide();
            await wait(300);
        }
        if (used)
            rec.cropTo(grow(used, 4));
        await rec.stop();
        settings.reset(key);
        settings.set_int('toast-duration', 4);
        settings.set_boolean('toasts-enabled', false);
    }

    /** Each page of the settings window. */
    async _settingsPages() {
        const mouse = this._mouse;
        // As after installing, except the top bar label.
        this._settings.reset('toasts-enabled');
        this._settings.reset('toast-duration');
        this._settings.set_boolean('show-panel-label', true);
        const settingsWindow = () => global.display.list_all_windows()
            .find(w => w.get_wm_class() === 'org.gnome.Shell.Extensions');
        GLib.spawn_command_line_async('gnome-extensions prefs earful@NGdev2.github.io');
        let window = null;
        for (let i = 0; i < 40 && !window; i++) {
            await wait(500);
            window = settingsWindow();
        }
        if (!window) {
            log('earful-demo: the settings window did not open');
            return;
        }
        await wait(2500);
        Main.overview.hide();
        window.activate(global.get_current_time());
        await wait(800);
        const rect = window.get_frame_rect();
        const box = [rect.x, rect.y, rect.width, rect.height];
        const middle = rect.x + rect.width / 2;
        for (const [i, page] of SETTINGS_PAGES.entries()) {
            if (i > 0) {
                await mouse.moveTo(middle + SETTINGS_TABS[i], rect.y + 23, 200);
                await mouse.click();
                await wait(300);
                mouse.park();
                await wait(900);
            }
            await this._shot(`settings-${page}`, box);
        }
        window.delete(global.get_current_time());
        await wait(500);
        this._settings.set_boolean('toasts-enabled', false);
    }

    /** The row every looks still shows: the YouTube tab, the same in all. */
    _looksItem() {
        return this._item(YOUTUBE) ?? this._items()[0];
    }

    /** A still of that row, a little around it, to looks/<name>.png. */
    async _rowShot(name) {
        await wait(500);
        await this._shot(`looks/${name}`, grow(bounds(this._looksItem()), 5));
    }

    /**
     * Stills of every look for docs/looks.md: card layouts, volume styles,
     * volume on the cover, list layouts, designs, colors and popup styles.
     */
    async _looks() {
        const settings = this._settings;
        const mouse = this._mouse;
        GLib.mkdir_with_parents(`${OUT}/looks`, 0o755);
        // A title that fits (the copy clip leaves the long one).
        for (let i = 0; i < 3 && (this._player(YOUTUBE)?.title.length ?? 0) > 24; i++) {
            await next(YOUTUBE);
            await wait(800);
        }
        settings.set_string('menu-style', 'cards');
        await this._midSongs();
        this._earful.menu.open(false);
        await wait(900);
        const relayout = async () => {
            await this._relayout();
            await this._midSongs();
        };

        for (const layout of ['standing-volume', 'side-volume', 'slim', 'cover-volume']) {
            settings.set_string('card-layout', layout);
            await relayout();
            await this._rowShot(`card-${layout}`);
        }
        settings.set_string('card-layout', 'standing-volume');
        for (const style of ['led', 'knob', 'pill', 'line']) {
            settings.set_string('card-volume-style', style);
            await relayout();
            await this._rowShot(`volume-${style}`);
        }
        settings.reset('card-volume-style');

        // Volume on the cover, as just after a scroll.
        settings.set_string('card-layout', 'cover-volume');
        for (const animation of ['liquid', 'cloud', 'dim', 'gray', 'ring', 'frame',
            'bars', 'percent', 'speaker', 'heart']) {
            settings.set_string('cover-volume-animation', animation);
            await relayout();
            const cover = this._looksItem()._coverVolume;
            cover?._change(0.62);
            cover?._linger();
            await this._rowShot(`cover-${animation}`);
        }
        settings.reset('cover-volume-animation');
        settings.reset('card-layout');
        await setVolume(YOUTUBE, 0.86);

        for (const design of ['cover', 'glass', 'vinyl', 'wave', 'leds', 'road', 'cassette', 'system']) {
            settings.set_string('design', design);
            await relayout();
            await this._rowShot(`design-${design}`);
        }
        settings.set_string('design', 'cover');
        for (const color of ['purple', 'blue', 'teal', 'green', 'amber', 'red', 'pink', 'graphite']) {
            settings.set_string('design-color', color);
            await wait(300);
            await this._rowShot(`color-${color}`);
        }
        settings.reset('design-color');
        settings.reset('design');

        settings.set_string('menu-style', 'list');
        for (const layout of ['cover-volume', 'one-line', 'two-bars']) {
            settings.set_string('list-layout', layout);
            await relayout();
            await this._rowShot(`list-${layout}`);
        }
        settings.reset('list-layout');
        settings.reset('menu-style');
        await this._closeMenu();

        // Popups, at rest and (the ones that change) pointed at.
        settings.set_boolean('toasts-enabled', true);
        settings.set_string('toast-position', 'top-right');
        const popupsOnScreen = () => Main.layoutManager.uiGroup.get_children()
            .some(a => a.has_style_class_name?.('earful-toast'));
        for (const [style] of POPUP_STYLES.values) {
            settings.set_string('popup-style', style);
            await wait(200);
            await next(SPOTIFY);
            await wait(1200);
            // All but the big cover as wide as the widest (the grown island),
            // right-aligned as on the screen, so the stills line up.
            const fit = popup => (popup && style !== 'big'
                ? [STAGE_WIDTH - LOOKS_POPUP_WIDTH, popup[1], LOOKS_POPUP_WIDTH, popup[3]] : popup);
            const box = this._popupBox();
            if (box)
                await this._shot(`looks/popup-${style}`, fit(box));
            if (box && POPUP_STYLES.pointed.includes(style)) {
                // The pointer itself stays hidden.
                await mouse.moveTo(box[0] + box[2] * 0.4, box[1] + box[3] / 2, 300);
                await wait(900);
                await this._shot(`looks/popup-${style}-pointed`, fit(this._popupBox() ?? box));
                mouse.park();
            }
            for (let i = 0; i < 60 && popupsOnScreen(); i++)
                await wait(150);
        }
        settings.reset('popup-style');
        settings.set_boolean('toasts-enabled', false);
    }

    disable() {
        this._caption?.destroy();
        this._caption = null;
        this._mouse?.destroy();
        this._mouse = null;
        if (this._forcedAnimations !== undefined)
            global.force_animations = this._forcedAnimations;
    }
}
