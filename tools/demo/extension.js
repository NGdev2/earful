// Demo director for tools/record-demo.sh: inside a throwaway shell it plays
// out the README scenes (track changes, the menu, every design) and saves
// numbered frames plus timings to $EARFUL_DEMO_OUT/<clip>/. Never install
// it for real.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const OUT = GLib.getenv('EARFUL_DEMO_OUT');
const FRAME_MS = 66; // about 15 frames per second
const STAGE_WIDTH = 1280;

const SPOTIFY = 'spotify';
const YOUTUBE = 'earful_tab_101.instance4242';
const SOUNDCLOUD = 'earful_tab_102.instance4242';

const wait = ms => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
    resolve();
    return GLib.SOURCE_REMOVE;
}));

function call(player, method, params = null, iface = 'org.mpris.MediaPlayer2.Player') {
    return new Promise(resolve => {
        Gio.DBus.session.call(`org.mpris.MediaPlayer2.${player}`, '/org/mpris/MediaPlayer2',
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

async function shotArea(path, [x, y, w, h]) {
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
        this._box = box.map(Math.round);
        this._times = [];
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

    /** Stops and writes an ffmpeg concat list with each frame's duration. */
    async stop() {
        this._recording = false;
        await this._done;
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

    /** Menu bounds as [x, y, width, height]. */
    _menuBox() {
        const actor = this._earful.menu.actor;
        const [x, y] = actor.get_transformed_position();
        const [w, h] = actor.get_transformed_size();
        return [x, y, w, h];
    }

    /** Opens the menu and returns a crop around it, with room for a caption. */
    async _openMenu(captionRoom) {
        this._earful.menu.open(false);
        await wait(900);
        const [x, y, w, h] = this._menuBox();
        const left = Math.max(0, x - 18);
        this._menuBottom = y + h;
        this._menuCenter = x + w / 2;
        return [left, 0, STAGE_WIDTH - left, y + h + (captionRoom ? 64 : 18)];
    }

    _showCaption(text) {
        this._caption.text = text;
        this._caption.show();
        const [width] = this._caption.get_preferred_width(-1);
        this._caption.set_position(Math.round(this._menuCenter - width / 2),
            Math.round(this._menuBottom + 14));
    }

    async _shot(name, box) {
        GLib.mkdir_with_parents(OUT, 0o755);
        await shotArea(`${OUT}/${name}.png`, box.map(Math.round));
    }

    async _run() {
        const settings = this._earful._settings;
        settings.set_int('toast-duration', 4);
        settings.set_boolean('show-panel-label', true);
        // Players announce themselves when they appear; let those fade first.
        await wait(13000);

        // 1. Hero: track changes pop up, stack, and glide away.
        let rec = new Recorder('hero', [760, 0, 520, 290]);
        await wait(700);
        await next(SPOTIFY);
        await wait(1600);
        await next(YOUTUBE);
        await wait(5300);
        await rec.stop();

        // 2. The menu: every player and tab, live colors, volume, pause.
        let box = await this._openMenu(false);
        rec = new Recorder('menu', box);
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
        this._earful.menu.close(false);

        // Two players from here on, for smaller pictures.
        await call(SOUNDCLOUD, 'Quit', null, 'org.mpris.MediaPlayer2');
        await wait(1500);

        // 3. Designs and colors.
        box = await this._openMenu(true);
        rec = new Recorder('designs', box);
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
        this._earful.menu.close(false);
        settings.reset('design-color');
        settings.reset('design');

        // 4. Menu styles, as stills.
        for (const [style, label] of [['cards', 'Cards'], ['list', 'List'], ['compact', 'Compact']]) {
            settings.set_string('menu-style', style);
            await wait(500);
            box = await this._openMenu(true);
            this._showCaption(label);
            await wait(400);
            await this._shot(`style-${style}`, box);
            this._caption.hide();
            this._earful.menu.close(false);
            await wait(500);
        }
        settings.reset('menu-style');

        // 5. Popups in a few designs, as stills.
        settings.set_string('toast-position', 'top-right');
        for (const design of ['vinyl', 'cassette', 'road', 'leds']) {
            settings.set_string('design', design);
            await next(SPOTIFY);
            await wait(1200);
            await this._shot(`popup-${design}`, [STAGE_WIDTH - 420, 36, 420, 128]);
            await wait(4500);
        }
        settings.reset('design');

        // 6. Settings window.
        GLib.spawn_command_line_async('gnome-extensions prefs earful@NGdev2.github.io');
        await wait(5000);
        const window = global.display.focus_window;
        if (window) {
            const rect = window.get_frame_rect();
            await this._shot('settings', [rect.x, rect.y, rect.width, Math.min(rect.height, 640)]);
        }
    }

    disable() {
        this._caption?.destroy();
        this._caption = null;
    }
}
