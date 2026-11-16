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
// Long enough for a title to start sliding (it waits 1.2 s first).
const HOLD_MS_TEST = 2500;
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

/** Popups on screen that aren't fading out. */
const popups = () => Main.layoutManager.uiGroup.get_children()
    .filter(a => a.has_style_class_name?.('earful-toast') && !a.dismissing);

/** Every actor in root's tree, root included, with the style class. */
function findAll(root, styleClass) {
    if (!root)
        return [];
    const found = root.has_style_class_name?.(styleClass) ? [root] : [];
    for (const child of root.get_children())
        found.push(...findAll(child, styleClass));
    return found;
}

const find = (root, styleClass) => findAll(root, styleClass)[0] ?? null;

/** Whether an actor can be seen: mapped, and nothing up its tree is transparent. */
function seen(actor) {
    if (!actor?.mapped)
        return false;
    for (let a = actor; a; a = a.get_parent()) {
        if (a.opacity === 0)
            return false;
    }
    return true;
}

const now = () => GLib.get_monotonic_time();

/** A virtual pointer, for real hovers and clicks. */
async function virtualPointer() {
    // GNOME 51 dropped Clutter.get_default_backend().
    const backend = Clutter.get_default_backend?.() ?? global.stage.context.get_backend();
    const pointer = backend.get_default_seat()
        .create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
    // A new virtual device takes a moment to be ready on GNOME 49+.
    await wait(500);
    return pointer;
}

/** Moves the pointer onto the middle of an actor. */
async function pointAt(pointer, actor) {
    const [x, y] = actor.get_transformed_position();
    const [w, h] = actor.get_transformed_size();
    pointer.notify_absolute_motion(now(), x + w / 2 - 2, y + h / 2 - 2);
    await wait(200);
    pointer.notify_absolute_motion(now(), x + w / 2, y + h / 2);
}

function click(pointer) {
    pointer.notify_button(now(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.PRESSED);
    pointer.notify_button(now(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.RELEASED);
}

/** How many times a fake player was asked for the next track, from its log. */
function nextCalls(log) {
    try {
        const [, contents] = GLib.file_get_contents(log);
        return new TextDecoder().decode(contents).split('\n').filter(l => l === 'next').length;
    } catch {
        return 0;
    }
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
            settings.set_string('popup-design', design);
            await wait(3500);
            await shot(`popups-${design}`);
        }
        // Mid cross-fade: the shadow must keep its round corners.
        settings.set_string('popup-design', 'cover');
        await wait(3500);
        settings.set_string('popup-design-color', 'purple');
        await wait(120);
        await shot('popups-color-change');
        settings.reset('popup-design-color');
        settings.set_boolean('toast-shadow', false);
        await wait(1500);
        await shot('popups-no-shadow');
        settings.reset('toast-shadow');
        settings.reset('popup-design');
        await this._closePopup(settings);
        await this._popupStyles(earful);
        await this._progress(earful);
        await this._cardLayouts(earful);
        await this._listLayouts(earful);
        await this._copyLabels(earful);
    }

    /** Copy on hover and sliding titles: cards copy, the list doesn't by default. */
    async _copyLabels(earful) {
        const settings = earful._settings;
        const result = [];
        settings.set_boolean('toasts-enabled', false);
        const firstItem = () => earful._section._getMenuItems().find(i => i.player);
        try {
            settings.set_string('menu-style', 'cards');
            await wait(500);
            earful.menu.open(false);
            await wait(1200);
            const item = firstItem();
            const title = item?._title;
            title?.emit('clicked', 1);
            const copied = await new Promise(resolve => St.Clipboard.get_default()
                .get_text(St.ClipboardType.CLIPBOARD, (clipboard, text) => resolve(text)));
            result.push(`copy ${!!title && copied === title.text}`);

            // A long title slides to show its end. A label of its own: the
            // fake players change track every few seconds, which resets titles.
            const {CopyLabel} = await import(
                `file://${Main.extensionManager.lookup('earful@NGdev2.github.io').path}/lib/copyLabel.js`);
            const long = new CopyLabel({styleClass: 'earful-title', copy: true, scroll: true});
            long.set_width(200);
            Main.layoutManager.uiGroup.add_child(long);
            long.text = 'A very long title that cannot fit in the card, so it slides to show the rest';
            await wait(300);
            // Containers render in software, where GNOME turns animations off.
            const forced = global.force_animations;
            global.force_animations = true;
            result.push(`slideinfo ${long._overflow()} ${St.Settings.get().enable_animations}`);
            long._startScroll();
            await wait(HOLD_MS_TEST);
            result.push(`slide ${long.textLabel.translation_x < 0}`);
            long._stopScroll();
            result.push(`back ${long.textLabel.translation_x === 0}`);
            long.destroy();
            global.force_animations = forced;
            await shot('copy-cards');
            earful.menu.close(false);
            await wait(400);

            settings.set_string('menu-style', 'list');
            await wait(500);
            earful.menu.open(false);
            await wait(1200);
            result.push(`listoff ${firstItem()?._title?._copy === false}`);
            earful.menu.close(false);
            await wait(400);

            settings.set_string('menu-style', 'compact');
            await wait(500);
            earful.menu.open(false);
            await wait(1200);
            const compact = firstItem()?._title;
            result.push(`compactplain ${compact instanceof St.Label && compact._copy === undefined}`);
            earful.menu.close(false);
            await wait(400);
        } catch (e) {
            logError(e, 'earful-shots');
            result.push(`error ${e.message}`);
        } finally {
            settings.reset('menu-style');
            settings.reset('toasts-enabled');
            GLib.file_set_contents(`${OUT}/copy-labels`, result.join('\n'));
        }
    }

    /** Each list layout: its bars show for players with a length and a volume. */
    async _listLayouts(earful) {
        const settings = earful._settings;
        const result = [];
        settings.set_boolean('toasts-enabled', false);
        settings.set_string('menu-style', 'list');
        try {
            const cases = [['cover-volume', 'time-left'], ['one-line', 'time-left'],
                ['two-bars', 'time-left'], ['two-bars', 'volume-left']];
            for (const [layout, order] of cases) {
                settings.set_string('list-layout', layout);
                settings.set_string('list-bars-order', order);
                await wait(500);
                earful.menu.open(false);
                await wait(1200);
                const items = earful._section._getMenuItems().filter(i => i.player);
                const withLength = items.find(i => i.player.length > 0);
                let ok = items.length > 0 && !!withLength;
                if (layout === 'cover-volume') {
                    ok &&= items.every(i => i._coverVolume) && withLength._progress?.visible === true;
                    for (const item of items) {
                        item._coverVolume._change(0.62);
                        item._coverVolume._linger();
                    }
                    await wait(450);
                } else {
                    ok &&= items.every(i => i._listBars?.visible === true && i._progress === null);
                }
                result.push(`${layout}-${order} ${ok}`);
                await shot(`list-${layout}${layout === 'two-bars' ? `-${order}` : ''}`);
                earful.menu.close(false);
                await wait(400);
            }
        } catch (e) {
            logError(e, 'earful-shots');
            result.push(`error ${e.message}`);
        } finally {
            settings.reset('list-layout');
            settings.reset('list-bars-order');
            settings.reset('menu-style');
            settings.reset('toasts-enabled');
            GLib.file_set_contents(`${OUT}/list-layouts`, result.join('\n'));
        }
    }

    /** Each card layout with each standing volume style. */
    async _cardLayouts(earful) {
        const settings = earful._settings;
        const result = [];
        settings.set_boolean('toasts-enabled', false);
        settings.set_string('menu-style', 'cards');
        try {
            for (const layout of ['standing-volume', 'side-volume']) {
                for (const style of ['led', 'knob', 'pill', 'line']) {
                    settings.set_string('card-layout', layout);
                    settings.set_string('card-volume-style', style);
                    await wait(500);
                    earful.menu.open(false);
                    await wait(1200);
                    const items = earful._section._getMenuItems().filter(i => i._vvolume !== undefined);
                    const shown = items.length > 0 && items.every(i => i._vvolume?.visible === true);
                    result.push(`${layout}-${style} ${shown}`);
                    await shot(`card-${layout}-${style}`);
                    earful.menu.close(false);
                    await wait(400);
                }
            }
            // Slim: a slide-out volume and the progress along the edge,
            // which grows when the card is hovered.
            settings.set_string('card-layout', 'slim');
            await wait(500);
            earful.menu.open(false);
            await wait(1200);
            const slim = earful._section._getMenuItems()
                .filter(i => i._progress?._player?.length > 0);
            const first = slim[0];
            const thin = first?._progress.elapsedLabel.visible === false;
            if (first)
                first.active = true;
            await wait(400);
            result.push(`slim ${!!first && thin && first._progress.elapsedLabel.visible === true &&
                first._volume?.visible === true}`);
            await shot('card-slim');
            earful.menu.close(false);
            await wait(400);

            // Volume on the cover: each animation, shown as after a scroll.
            settings.set_string('card-layout', 'cover-volume');
            for (const animation of ['liquid', 'cloud', 'dim', 'gray', 'ring', 'frame',
                'bars', 'percent', 'speaker', 'heart']) {
                settings.set_string('cover-volume-animation', animation);
                await wait(500);
                earful.menu.open(false);
                await wait(1200);
                const covers = earful._section._getMenuItems()
                    .map(i => i._coverVolume).filter(Boolean);
                for (const cover of covers) {
                    cover._change(0.62);
                    cover._linger();
                }
                await wait(450);
                result.push(`cover-${animation} ${covers.length > 0 && covers.every(c => c._shown)}`);
                await shot(`card-cover-${animation}`);
                earful.menu.close(false);
                await wait(400);
            }
        } catch (e) {
            logError(e, 'earful-shots');
            result.push(`error ${e.message}`);
        } finally {
            settings.reset('card-layout');
            settings.reset('card-volume-style');
            settings.reset('cover-volume-animation');
            settings.reset('menu-style');
            settings.reset('toasts-enabled');
            GLib.file_set_contents(`${OUT}/card-layouts`, result.join('\n'));
        }
    }

    /** The progress bar: it shows, moves, seeks, and only where it should. */
    async _progress(earful) {
        const settings = earful._settings;
        const result = [];
        // Six players start below at once; their popups aren't what this
        // step tests (a burst of popups is a separate case).
        settings.set_boolean('toasts-enabled', false);
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
        const modes = {Ad: 'ignore', Silent: 'silent', Announce: 'announce', Slow: 'slow', Long: 'normal'};
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
            const ready = () => [name, 'Ad', 'Silent', 'Announce', 'Slow'].every(n => this._hasPlayer(earful, n)) &&
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

            // The wheel scrolls the menu; it must never seek (each step would).
            result.push(`wheel ${bar?.slider.vfunc_scroll_event(null) === Clutter.EVENT_PROPAGATE}`);
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

            // A slow seek (buffering) looks ignored at first; the lock lifts
            // when the player reports the jump.
            const slow = itemOf('Slow');
            slow?._progress?.seekTo(0.5);
            await wait(2600);
            const lockedFirst = slow?._progress?.slider.reactive === false;
            await wait(2500);
            result.push(`slow ${!!slow && slow._progress.slider.reactive === true &&
                Math.abs(slow.player.position - 120) < 4}`);
            result.push(`slowlocked ${lockedFirst}`);

            // A player that announces Position: used before the next reading.
            const announce = itemOf('Announce');
            this._setPosition(announce?.player, 'Announce', 100);
            await wait(700);
            result.push(`announced ${!!announce && Math.abs(announce.player.position - 100) < 2}`);

            // A player that jumps without telling: the 5 s re-reading finds it.
            const silent = itemOf('Silent');
            this._setPosition(silent?.player, 'Silent', 100);
            // GNOME may run the one-second clock a little late; allow up to 8 s.
            const jumpedAt = GLib.get_monotonic_time();
            const found = () => {
                const expected = 100 + (GLib.get_monotonic_time() - jumpedAt) / 1e6;
                return !!silent && Math.abs(silent.player.position - expected) < 3;
            };
            for (let i = 0; i < 16 && !found(); i++)
                await wait(500);
            result.push(`reread ${found()}`);
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
            settings.reset('toasts-enabled');
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
        for (let i = 0; i < 20 && popups().length === 0; i++)
            await wait(500);
        const result = [];
        const popup = popups().at(-1);
        // Some styles put it in the popup's row, so look through the whole popup.
        const close = find(popup, 'earful-toast-close');
        result.push(`close shown ${!!close?.mapped}`);
        if (close) {
            let raised = false;
            popup.connect('clicked', () => (raised = true));
            // A real pointer click, so the popup underneath gets its say too.
            const pointer = await virtualPointer();
            await pointAt(pointer, close);
            await wait(800);
            result.push(`hover ${close.hover}`);
            await shot('popups-close-hover');
            click(pointer);
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

    /** Each popup style: its size, its buttons, and what the pointer does to it. */
    async _popupStyles(earful) {
        const settings = earful._settings;
        const result = [];
        const widths = [];
        // A player of its own that skips only when told to: Spotify's 2 s
        // tracks would restart the countdown. The others stay quiet (a burst
        // of popups is a separate case).
        const name = 'Styles';
        const log = `${OUT}/popup-styles-calls.log`;
        GLib.unlink(log);
        settings.set_strv('toast-muted-apps', ['spotify', 'podcasts']);
        settings.set_int('toast-duration', 30);
        const env = GLib.environ_setenv(GLib.get_environ(), 'FAKE_PLAYER_LOG', log, true);
        GLib.spawn_async(null, ['gjs', '-m', `${GLib.getenv('ROOT')}/tools/fake-player.js`, name, '0',
            `${GLib.getenv('WORK')}/covers`], env, GLib.SpawnFlags.SEARCH_PATH, null);
        const call = (method, iface = 'org.mpris.MediaPlayer2.Player') =>
            Gio.DBus.session.call(`org.mpris.MediaPlayer2.${name}`, '/org/mpris/MediaPlayer2',
                iface, method, null, null, Gio.DBusCallFlags.NONE, -1, null, null);
        const popupOf = async style => {
            const match = () => popups().find(t => t.styleName === style && t.player?.identity === name);
            for (let i = 0; i < 25 && !match(); i++)
                await wait(200);
            return match() ?? null;
        };
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const near = (actor, logical) => !!actor && Math.abs(actor.width - logical * scale) <= 1;
        const sizes = {current: 380, hover: 380, countdown: 380, mini: 330, island: 270, big: 250};
        const covers = {current: 72, hover: 72, countdown: 72, mini: 36, island: 30, big: 228};
        let pointer = null;
        const away = async () => {
            pointer.notify_absolute_motion(now(), 10, 400);
            await wait(300);
        };
        try {
            pointer = await virtualPointer();
            for (let i = 0; i < 20 && !this._hasPlayer(earful, name); i++)
                await wait(500);
            await wait(500);
            let restyled = true;
            for (const style of Object.keys(sizes)) {
                // A new style replaces the popups shown; the next track brings one.
                const previous = settings.get_string('popup-style');
                settings.set_string('popup-style', style);
                await wait(300);
                restyled &&= !popups().some(t => t.styleName === previous);
                call('Next');
                const toast = await popupOf(style);
                if (!toast) {
                    result.push(`error no ${style} popup`);
                    continue;
                }
                await wait(700);
                await shot(`popups-style-${style}`);
                widths.push(`${style}:${Math.round(toast.width)}`);
                // Whole on screen, and taller than its cover.
                const cover = find(toast, 'earful-cover');
                result.push(`onscreen-${style} ${toast.y >= 0 && toast.y + toast.height <= global.stage.height &&
                    toast.height > (cover?.height ?? 0)}`);
                result.push(`width-${style} ${near(toast, sizes[style])}`);
                result.push(`cover-${style} ${near(find(toast, 'earful-cover'), covers[style])}`);

                const controls = find(toast, 'earful-toast-controls');
                const buttons = findAll(controls, 'earful-control');
                const next = buttons.find(b => b.accessible_name === 'Next');
                const nextOnly = buttons.length === 1 && !!next;
                const controlsOk = {
                    current: !controls,
                    hover: !!controls && controls.opacity === 0 && !controls.reactive,
                    countdown: nextOnly && seen(controls),
                    mini: nextOnly && seen(controls),
                    island: !!controls && !controls.mapped,
                    big: !!next && seen(controls),
                }[style];
                result.push(`controls-${style} ${controlsOk}`);

                if (style === 'hover') {
                    await pointAt(pointer, toast);
                    await wait(600);
                    result.push(`hover-shows ${controls?.opacity === 255}`);
                    await shot('popups-style-hover-hovered');
                    await away();
                } else if (style === 'countdown') {
                    const line = find(toast, 'earful-toast-line');
                    result.push(`countdown-line ${!!line}`);
                    const start = line?.scale_x;
                    await wait(1000);
                    result.push(`countdown-runs ${!!line && line.scale_x < start}`);
                    if (next) {
                        // On Next the pointer is on the popup too, which holds the line.
                        await pointAt(pointer, next);
                        await wait(300);
                        const held = line?.scale_x;
                        await wait(1000);
                        result.push(`countdown-holds ${!!line && Math.abs(line.scale_x - held) < 0.002}`);
                        const title = find(toast, 'earful-toast-title')?.text;
                        const asked = nextCalls(log);
                        click(pointer);
                        await wait(1200);
                        result.push(`countdown-next ${nextCalls(log) > asked}`);
                        result.push(`countdown-follows ${!!title && popups().includes(toast) &&
                            find(toast, 'earful-toast-title')?.text !== title}`);
                        const restarted = find(toast, 'earful-toast-line')?.scale_x ?? 0;
                        result.push(`countdown-restarts ${restarted > 0.95}`);
                        await away();
                    }
                } else if (style === 'island') {
                    const artist = find(toast, 'earful-toast-artist');
                    result.push(`island-small ${toast.expanded === false && !seen(artist)}`);
                    await pointAt(pointer, toast);
                    await wait(800);
                    widths.push(`island-expanded:${Math.round(toast.width)}`);
                    result.push(`island-grows ${toast.expanded === true && near(toast, 400)}`);
                    result.push(`island-artist ${seen(artist)}`);
                    result.push(`island-controls ${seen(controls)}`);
                    await shot('popups-style-island-expanded');
                    await away();
                }
            }
            const last = settings.get_string('popup-style');
            settings.reset('popup-style');
            await wait(300);
            restyled &&= !popups().some(t => t.styleName === last);
            result.push(`restyle ${restyled}`);
            result.push(`widths ${widths.join(' ')}`);
        } catch (e) {
            logError(e, 'earful-shots');
            result.push(`error ${e.message}`);
        } finally {
            pointer?.notify_absolute_motion(now(), 10, 400);
            settings.reset('popup-style');
            settings.reset('toast-duration');
            settings.reset('toast-muted-apps');
            call('Quit', 'org.mpris.MediaPlayer2');
            GLib.file_set_contents(`${OUT}/popup-styles`, result.join('\n'));
        }
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
