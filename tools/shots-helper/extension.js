// Test-only helper for tools/test-shell.sh: inside the throwaway shell it
// opens Earful's menu in every style and design and saves screenshots to
// $EARFUL_SHOTS, then writes $EARFUL_SHOTS/done. Never install it for real.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
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
            .finally(() => {
                GLib.file_set_contents(`${OUT}/done`, '');
                this._prefs().catch(e => logError(e, 'earful-shots'));
            });
    }

    /** The settings window, once the test opens it. */
    async _prefs() {
        let window = null;
        for (let i = 0; i < 120 && !window; i++) {
            await wait(1000);
            window = global.get_window_actors().map(a => a.meta_window)
                .find(w => /Shell\.Extensions/i.test(w.get_wm_class() ?? ''));
        }
        if (!window)
            return;
        await wait(2500);
        // The test shell starts in the overview, which covers the window.
        Main.overview.hide();
        await wait(1000);
        window.activate(global.get_current_time());
        await wait(800);
        await shot('prefs');
        await this._settingsComeBack(window);
    }

    /** Settings hidden behind another window come back from the menu. */
    async _settingsComeBack(prefs) {
        const [, pid] = GLib.spawn_async(null, ['gjs', '-c', `
            imports.gi.versions.Gtk = '4.0';
            const {Gtk, GLib} = imports.gi;
            Gtk.init();
            new Gtk.Window({title: 'Cover', default_width: 1000, default_height: 700}).present();
            new GLib.MainLoop(null, false).run();`],
        null, GLib.SpawnFlags.SEARCH_PATH | GLib.SpawnFlags.DO_NOT_REAP_CHILD, null);
        let cover = null;
        for (let i = 0; i < 20 && !cover; i++) {
            await wait(500);
            cover = global.display.focus_window?.get_title() === 'Cover' ? global.display.focus_window : null;
        }
        const notified = [];
        const source = MessageTray.getSystemSource();
        const notifyId = source.connect('notification-added', (s, n) => notified.push(n.title));
        const earful = Main.panel.statusArea['earful@NGdev2.github.io'];
        const item = earful.menu._getMenuItems().find(i => i.label?.text === 'Settings');
        item.activate(Clutter.get_current_event());
        await wait(1500);
        const settingsWindows = () => global.display.list_all_windows()
            .filter(w => w.get_wm_class() === 'org.gnome.Shell.Extensions');
        const result = [
            `covered ${cover !== null}`,
            `raised ${global.display.focus_window === prefs}`,
            `windows ${settingsWindows().length}`,
            `quiet ${notified.length === 0}`,
        ];
        await shot('prefs-after-cover');

        // Another extension's settings are open: they come forward, with a note.
        prefs.delete(global.display.get_current_time_roundtrip());
        for (let i = 0; i < 20 && settingsWindows().length; i++)
            await wait(500);
        this.openPreferences();
        let other = null;
        for (let i = 0; i < 30 && !other; i++) {
            await wait(500);
            other = settingsWindows()[0] ?? null;
        }
        await wait(1500);
        Main.activateWindow(global.display.list_all_windows().find(w => w.get_title() === 'Cover'));
        await wait(800);
        item.activate(Clutter.get_current_event());
        await wait(1500);
        result.push(
            `other raised ${other !== null && global.display.focus_window === other}`,
            `noted ${notified[0] === `Settings of “${this.metadata.name}” are open`}`);
        source.disconnect(notifyId);
        await shot('prefs-other-extension');
        other?.delete(global.display.get_current_time_roundtrip());
        GLib.file_set_contents(`${OUT}/settings-come-back`, result.join('\n'));
        GLib.spawn_command_line_sync(`kill ${pid}`);
        GLib.spawn_close_pid(pid);
    }

    async _run() {
        await wait(8000);
        const earful = Main.panel.statusArea['earful@NGdev2.github.io'];
        const settings = earful._settings;
        // Popups go to the other corner so they don't cover the menu.
        settings.set_string('toast-position', 'bottom-right');
        const menu = async (style, design, color = 'cover', name = '') => {
            settings.set_string('menu-style', style);
            settings.set_string('design', design);
            settings.set_string('design-color', color);
            await wait(600);
            earful.menu.open(false);
            await wait(1500);
            await shot(name || `menu-${style}-${design}${color === 'cover' ? '' : `-${color}`}`);
            earful.menu.close(false);
            await wait(400);
        };
        for (const design of DESIGNS)
            await menu('cards', design);
        for (const background of ['dark', 'music', 'transparent']) {
            settings.set_string('menu-background', background);
            await menu('cards', 'cover', 'cover', `background-${background}`);
            await menu('list', 'system', 'cover', `background-${background}-list`);
        }
        settings.reset('menu-background');
        await menu('cards', 'leds', 'green');
        await menu('cards', 'vinyl', 'amber');
        settings.reset('design-color');
        for (const style of STYLES.filter(s => s !== 'cards'))
            await menu(style, 'cover');
        settings.reset('menu-style');
        await this._manyPlayers(earful);
        for (const design of ['cover', 'vinyl', 'road']) {
            settings.set_string('design', design);
            await wait(3500);
            await shot(`popups-${design}`);
        }
        // Mid cross-fade: the shadow must keep its round corners.
        settings.set_string('design', 'cover');
        await wait(3500);
        settings.set_string('design-color', 'purple');
        await wait(120);
        await shot('popups-color-change');
        settings.reset('design-color');
        settings.set_boolean('toast-shadow', false);
        await wait(1500);
        await shot('popups-no-shadow');
        settings.reset('toast-shadow');
        settings.reset('design');
        await this._closePopup(settings);
        await this._progress(earful);
    }

    /** The progress bar: it shows, moves, seeks, and only where it should. */
    async _progress(earful) {
        const settings = earful._settings;
        const result = [];
        // A player of its own: Spotify's 2 s tracks would reset the bar.
        const name = 'Progress';
        const log = `${OUT}/progress-calls.log`;
        GLib.unlink(log);
        let env = GLib.get_environ();
        env = GLib.environ_setenv(env, 'FAKE_PLAYER_LENGTH', '240', true);
        env = GLib.environ_setenv(env, 'FAKE_PLAYER_LOG', log, true);
        GLib.spawn_async(null, ['gjs', '-m', `${GLib.getenv('ROOT')}/tools/fake-player.js`, name, '0'],
            env, GLib.SpawnFlags.SEARCH_PATH, null);
        // Players that answer a seek differently (see fake-player.js).
        const modes = {Ad: 'ignore', Silent: 'silent', Announce: 'announce', Long: 'normal'};
        // A site whose name is a whole sentence must not widen the menu.
        const longName = `${'Watch films and series online for free in good quality, '.repeat(3)}— Google Chrome`;
        for (const [extra, mode] of Object.entries(modes)) {
            let extraEnv = GLib.environ_setenv(GLib.get_environ(), 'FAKE_PLAYER_LENGTH', '240', true);
            extraEnv = GLib.environ_setenv(extraEnv, 'FAKE_PLAYER_SEEK_MODE', mode, true);
            if (extra === 'Long')
                extraEnv = GLib.environ_setenv(extraEnv, 'FAKE_PLAYER_IDENTITY', longName, true);
            GLib.spawn_async(null, ['gjs', '-m', `${GLib.getenv('ROOT')}/tools/fake-player.js`, extra, '0'],
                extraEnv, GLib.SpawnFlags.SEARCH_PATH, null);
        }
        const items = () => earful._section._getMenuItems();
        const itemOf = identity => items().find(i => i.player?.identity === identity);
        const open = async () => {
            earful.menu.open(false);
            await wait(1500);
        };
        const close = async () => {
            earful.menu.close(false);
            await wait(600);
        };
        try {
            settings.set_string('menu-style', 'cards');
            const ready = () => [name, 'Ad', 'Silent', 'Announce'].every(n => this._hasPlayer(earful, n)) &&
                earful._manager.players.some(p => p.identity === longName);
            for (let i = 0; i < 20 && !ready(); i++)
                await wait(500);
            await wait(1000);
            await open();
            const item = itemOf(name) ?? items().find(i => i._progress?._player?.length > 0);
            const bar = item?._progress;
            result.push(`shown ${bar?.visible === true}`);
            result.push(`length ${bar?.lengthLabel?.text ?? ''}`);
            result.push(`clockruns ${!!earful._clockId}`);

            const elapsed = bar?.elapsedLabel?.text;
            const position = item?.player?.position ?? 0;
            await wait(2200);
            result.push(`advances ${!!bar && (bar.elapsedLabel.text !== elapsed ||
                item.player.position > position)}`);

            bar?.seekTo(0.5);
            await wait(1200);
            result.push(`seek ${this._seeked(log, name)}`);
            await shot('menu-progress');

            const long = itemOf(longName);
            const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
            result.push(`longname ${!!long && long._source._label.width <= 211 * scale}`);

            const podcasts = itemOf('Podcasts');
            result.push(`nobar ${!!podcasts?._progress && !podcasts._progress.visible}`);

            // A player that accepts the seek but stays put: the bar snaps
            // back and can't be dragged any more on this track.
            const ad = itemOf('Ad');
            ad?._progress?.seekTo(0.5);
            await wait(3000);
            result.push(`refused ${!!ad && ad._progress.slider.reactive === false && ad.player.position < 60}`);

            // A player that announces Position: used before the next reading.
            const announce = itemOf('Announce');
            this._setPosition(announce?.player, 'Announce', 100);
            await wait(700);
            result.push(`announced ${!!announce && Math.abs(announce.player.position - 100) < 2}`);

            // A player that jumps without telling: the 5 s re-reading finds it.
            const silent = itemOf('Silent');
            this._setPosition(silent?.player, 'Silent', 100);
            await wait(6000);
            result.push(`reread ${!!silent && Math.abs(silent.player.position - 106) < 3}`);
            await close();
            result.push(`clockstops ${!earful._clockId}`);

            for (const style of ['list', 'compact']) {
                settings.set_string('menu-style', style);
                await wait(600);
                await open();
                const row = itemOf(name);
                if (style === 'list')
                    result.push(`list ${row?._progress?.visible === true}`);
                else
                    result.push(`compact ${!!row && row._progress === null}`);
                await shot(`menu-progress-${style}`);
                await close();
            }
        } catch (e) {
            logError(e, 'earful-shots');
            result.push(`error ${e.message}`);
            if (earful.menu.isOpen)
                earful.menu.close(false);
        } finally {
            settings.reset('menu-style');
            for (const player of [name, ...Object.keys(modes)]) {
                Gio.DBus.session.call(`org.mpris.MediaPlayer2.${player}`, '/org/mpris/MediaPlayer2',
                    'org.mpris.MediaPlayer2', 'Quit', null, null, Gio.DBusCallFlags.NONE, -1, null, null);
            }
            GLib.file_set_contents(`${OUT}/progress`, result.join('\n'));
        }
    }

    /** Seeks a fake player directly over D-Bus, behind Earful's back. */
    _setPosition(player, busName, seconds) {
        if (!player)
            return;
        Gio.DBus.session.call(`org.mpris.MediaPlayer2.${busName}`, '/org/mpris/MediaPlayer2',
            'org.mpris.MediaPlayer2.Player', 'SetPosition',
            new GLib.Variant('(ox)', [player.trackId, Math.round(seconds * 1e6)]),
            null, Gio.DBusCallFlags.NONE, -1, null, null);
    }

    _hasPlayer(earful, identity) {
        return earful._manager.players.some(p => p.identity === identity);
    }

    /**
     * Whether the seek reached the player: a SetPosition near the middle was
     * sent, and the player accepted it (right track id), so its own Position
     * is near the middle too.
     */
    _seeked(log, name) {
        let asked = [];
        try {
            const [, contents] = GLib.file_get_contents(log);
            asked = new TextDecoder().decode(contents).split('\n')
                .filter(l => l.startsWith('setposition '))
                .map(l => Number(l.split(' ')[1]));
        } catch {
            return false;
        }
        const reply = Gio.DBus.session.call_sync(`org.mpris.MediaPlayer2.${name}`,
            '/org/mpris/MediaPlayer2', 'org.freedesktop.DBus.Properties', 'Get',
            new GLib.Variant('(ss)', ['org.mpris.MediaPlayer2.Player', 'Position']),
            null, Gio.DBusCallFlags.NONE, 2000, null);
        const [value] = reply.recursiveUnpack();
        return asked.some(s => Math.abs(s - 120) < 2) && Math.abs(value / 1e6 - 120) < 3;
    }

    /** The ✕ on a popup closes it without raising the player. */
    async _closePopup(settings) {
        settings.set_int('toast-duration', 30);
        const popups = () => Main.layoutManager.uiGroup.get_children()
            .filter(a => a.has_style_class_name?.('earful-toast') && !a.dismissing);
        for (let i = 0; i < 20 && popups().length === 0; i++)
            await wait(500);
        const result = [];
        const popup = popups().at(-1);
        const close = popup?.get_child()?.get_children()
            .find(a => a.has_style_class_name?.('earful-toast-close'));
        result.push(`close shown ${!!close?.mapped}`);
        if (close) {
            let raised = false;
            popup.connect('clicked', () => (raised = true));
            // A real pointer click, so the popup underneath gets its say too.
            // GNOME 51 dropped Clutter.get_default_backend().
            const backend = Clutter.get_default_backend?.() ?? global.stage.context.get_backend();
            const pointer = backend.get_default_seat()
                .create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
            const [x, y] = close.get_transformed_position();
            const [w, h] = close.get_transformed_size();
            const now = () => GLib.get_monotonic_time();
            // A new virtual device takes a moment to be ready on GNOME 49+.
            await wait(500);
            pointer.notify_absolute_motion(now(), x + w / 2 - 2, y + h / 2 - 2);
            await wait(200);
            pointer.notify_absolute_motion(now(), x + w / 2, y + h / 2);
            await wait(800);
            result.push(`hover ${close.hover}`);
            await shot('popups-close-hover');
            pointer.notify_button(now(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.PRESSED);
            pointer.notify_button(now(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.RELEASED);
            await wait(100);
            result.push(`closing ${popup.dismissing === true}`);
            result.push(`raised ${raised}`);
            pointer.notify_absolute_motion(now(), 10, 400);
            await wait(1000);
            result.push(`gone ${!popups().includes(popup)}`);
        }
        settings.reset('toast-duration');
        GLib.file_set_contents(`${OUT}/popup-close`, result.join('\n'));
    }

    /** Lots of players: the list scrolls, paused ones can be hidden. */
    async _manyPlayers(earful) {
        const root = GLib.getenv('ROOT');
        const names = ['Extra1', 'Extra2', 'Extra3', 'Extra4', 'Extra5', 'Extra6'];
        const call = (name, method, iface = 'org.mpris.MediaPlayer2.Player') =>
            Gio.DBus.session.call(`org.mpris.MediaPlayer2.${name}`, '/org/mpris/MediaPlayer2',
                iface, method, null, null, Gio.DBusCallFlags.NONE, -1, null, null);
        for (const name of names) {
            GLib.spawn_async(null, ['gjs', '-m', `${root}/tools/fake-player.js`, name, '0'],
                null, GLib.SpawnFlags.SEARCH_PATH, null);
        }
        await wait(2500);
        names.slice(0, 3).forEach(name => call(name, 'Pause'));
        await wait(800);

        earful.menu.open(false);
        await wait(1200);
        await shot('many-top');
        const adjustment = earful._scroll.vadjustment;
        adjustment.value = adjustment.upper;
        await wait(600);
        await shot('many-bottom');
        const paused = earful._section._getMenuItems().find(i => i._dismiss?.visible);
        paused?._dismiss.emit('clicked', 1);
        await wait(600);
        await shot('many-dismissed');
        earful.menu.close(false);
        await wait(500);

        // Playing again brings it back.
        if (paused)
            call(paused.player.identity, 'Play');
        await wait(800);
        earful.menu.open(false);
        await wait(1200);
        await shot('many-back');
        earful.menu.close(false);
        names.forEach(name => call(name, 'Quit', 'org.mpris.MediaPlayer2'));
        await wait(800);
    }

    disable() {}
}
