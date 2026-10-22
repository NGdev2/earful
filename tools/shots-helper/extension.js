// Test-only helper for tools/test-shell.sh: inside the throwaway shell it
// opens Earful's menu in every style and design and saves screenshots to
// $EARFUL_SHOTS, then writes $EARFUL_SHOTS/done. Never install it for real.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const OUT = GLib.getenv('EARFUL_SHOTS');
const STYLES = ['cards', 'list', 'compact'];
const DESIGNS = ['cover', 'glass', 'vinyl', 'wave', 'leds', 'road', 'cassette', 'system'];

const wait = ms => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
    resolve();
    return GLib.SOURCE_REMOVE;
}));

async function shot(name) {
    const file = Gio.File.new_for_path(`${OUT}/${name}.png`);
    const stream = file.replace(null, false, Gio.FileCreateFlags.NONE, null);
    await new Shell.Screenshot().screenshot(false, stream);
    stream.close(null);
}

export default class ShotsHelper extends Extension {
    enable() {
        if (!OUT)
            return;
        this._run().catch(e => logError(e, 'earful-shots'))
            .finally(() => GLib.file_set_contents(`${OUT}/done`, ''));
    }

    async _run() {
        await wait(8000);
        const earful = Main.panel.statusArea['earful@NGdev2.github.io'];
        const settings = earful._settings;
        // Popups go to the other corner so they don't cover the menu.
        settings.set_string('toast-position', 'bottom-right');
        const menu = async (style, design, color = 'cover') => {
            settings.set_string('menu-style', style);
            settings.set_string('design', design);
            settings.set_string('design-color', color);
            await wait(600);
            earful.menu.open(false);
            await wait(1500);
            await shot(`menu-${style}-${design}${color === 'cover' ? '' : `-${color}`}`);
            earful.menu.close(false);
            await wait(400);
        };
        for (const design of DESIGNS)
            await menu('cards', design);
        await menu('cards', 'leds', 'green');
        await menu('cards', 'vinyl', 'amber');
        settings.reset('design-color');
        for (const style of STYLES.filter(s => s !== 'cards'))
            await menu(style, 'cover');
        settings.reset('menu-style');
        for (const design of ['cover', 'vinyl', 'road']) {
            settings.set_string('design', design);
            await wait(3500);
            await shot(`popups-${design}`);
        }
        settings.reset('design');
    }

    disable() {}
}
