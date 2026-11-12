// SPDX-License-Identifier: GPL-3.0-or-later
import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import * as BridgeSetup from './lib/bridgeSetup.js';

// Where to get the Earful Bridge add-on.
const CHROME_ADDON = 'https://chromewebstore.google.com/detail/hlomkcgmmialafamfkkpiamgefhlidll';
const FIREFOX_ADDON = 'https://addons.mozilla.org/firefox/addon/earful-bridge/';

/** Opens the store page in that browser itself, else in the default one. */
function openIn(browser, uri, window) {
    const program = BridgeSetup.browserProgram(browser);
    if (program) {
        try {
            Gio.Subprocess.new([program, uri], Gio.SubprocessFlags.NONE);
            return;
        } catch (e) {
            logError(e, `Earful: could not start ${browser}`);
        }
    }
    new Gtk.UriLauncher({uri}).launch(window, null, null);
}

/** "Connected: Google Chrome, Firefox · ready for 5 more" and the like. */
function browsersSummary(enabled, connected, total) {
    if (!enabled)
        return _('Off');
    const rest = total - connected.length;
    if (connected.length === 0)
        return _('Ready for %d browsers. Add the add-on to one of them.').format(total);
    const names = _('Connected: %s').format(connected.join(', '));
    return rest > 0 ? `${names} · ${_('ready for %d more').format(rest)}` : names;
}
// The shell (re)registers the helper when the switch changes; let it finish first.
const BRIDGE_REFRESH_DELAY_MS = 800;

const POSITIONS = [
    ['top-left', () => _('Top left')],
    ['top-center', () => _('Top center')],
    ['top-right', () => _('Top right')],
    ['bottom-left', () => _('Bottom left')],
    ['bottom-center', () => _('Bottom center')],
    ['bottom-right', () => _('Bottom right')],
];

const MENU_STYLES = [
    ['cards', () => _('Cards')],
    ['list', () => _('List')],
    ['compact', () => _('Compact (no sliders)')],
];

const CARD_LAYOUTS = [
    ['standing-volume', () => _('Volume on the right')],
    ['side-volume', () => _('Volume beside the cover')],
    ['slim', () => _('Slim')],
    ['cover-volume', () => _('Volume on the cover')],
];

const LIST_LAYOUTS = [
    ['cover-volume', () => _('Volume on the cover')],
    ['one-line', () => _('One line, two jobs')],
    ['two-bars', () => _('Two bars')],
];

const LIST_BARS_ORDERS = [
    ['time-left', () => _('Time left, volume right')],
    ['volume-left', () => _('Volume left, time right')],
];

const COVER_ANIMATIONS = [
    ['liquid', () => _('Liquid')],
    ['cloud', () => _('Cloud')],
    ['dim', () => _('Dim above')],
    ['gray', () => _('Gray above')],
    ['ring', () => _('Ring')],
    ['frame', () => _('Frame')],
    ['bars', () => _('Bars')],
    ['percent', () => _('Percent')],
    ['speaker', () => _('Speaker waves')],
    ['heart', () => _('Heart')],
];

const VOLUME_STYLES = [
    ['led', () => _('LED steps')],
    ['knob', () => _('Knob')],
    ['pill', () => _('Pill')],
    ['line', () => _('Line')],
];

const MENU_BACKGROUNDS = [
    ['theme', () => _('Theme')],
    ['dark', () => _('Dark')],
    ['music', () => _('Match the music')],
    ['transparent', () => _('Transparent')],
];

const DESIGNS = [
    ['cover', () => _('Gradient')],
    ['glass', () => _('Dark glass')],
    ['vinyl', () => _('Vinyl')],
    ['wave', () => _('Sound wave')],
    ['leds', () => _('Retro equalizer')],
    ['road', () => _('Note road')],
    ['cassette', () => _('Cassette')],
    ['system', () => _('System theme')],
];

const COLORS = [
    ['cover', () => _('From the cover')],
    ['purple', () => _('Purple')],
    ['blue', () => _('Blue')],
    ['teal', () => _('Teal')],
    ['green', () => _('Green')],
    ['amber', () => _('Amber')],
    ['red', () => _('Red')],
    ['pink', () => _('Pink')],
    ['graphite', () => _('Graphite')],
];

const MEDIA_KEY_TARGETS = [
    ['default', () => _('Let the system choose')],
    ['last-active', () => _('Last active player')],
    ['pinned', () => _('Pinned player')],
];

function switchRow(settings, key, title, subtitle = '') {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function spinRow(settings, key, title, lower, upper) {
    const row = new Adw.SpinRow({
        title,
        adjustment: new Gtk.Adjustment({lower, upper, step_increment: 1}),
    });
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

/** A drop-down for a string key with fixed choices, as [id, label] pairs. */
function choiceRow(window, settings, key, title, choices, subtitle = '') {
    const row = new Adw.ComboRow({
        title,
        subtitle,
        model: Gtk.StringList.new(choices.map(([, label]) => label())),
    });
    const sync = () => {
        row.selected = Math.max(0,
            choices.findIndex(([id]) => id === settings.get_string(key)));
    };
    sync();
    const id = settings.connect(`changed::${key}`, sync);
    window.connect('close-request', () => settings.disconnect(id));
    row.connect('notify::selected', () =>
        settings.set_string(key, choices[row.selected][0]));
    return row;
}

Gio._promisify(Gio.DBusConnection.prototype, 'call');
Gio._promisify(Gio.DBusProxy, 'new');

const DBUS_TIMEOUT_MS = 2000;

/** Players currently on the bus, as [appKey, display name] pairs. */
async function runningPlayers() {
    const bus = Gio.DBus.session;
    const reply = await bus.call('org.freedesktop.DBus', '/org/freedesktop/DBus',
        'org.freedesktop.DBus', 'ListNames', null, null,
        Gio.DBusCallFlags.NONE, DBUS_TIMEOUT_MS, null);
    const [names] = reply.deepUnpack();

    const players = new Map();
    await Promise.all(names
        .filter(name => name.startsWith('org.mpris.MediaPlayer2.'))
        .map(async name => {
            try {
                const proxy = await Gio.DBusProxy.new(bus,
                    Gio.DBusProxyFlags.DO_NOT_CONNECT_SIGNALS, null, name,
                    '/org/mpris/MediaPlayer2', 'org.mpris.MediaPlayer2', null);
                const identity = proxy.get_cached_property('Identity')?.unpack() ?? '';
                const entry = proxy.get_cached_property('DesktopEntry')?.unpack() ?? '';
                players.set((entry || identity || name).toLowerCase(),
                    identity || entry || name);
            } catch {
                // A player that does not answer is simply not listed.
            }
        }));
    return players;
}

// Snap Firefox starts native helpers through the desktop portal, which
// remembers the answer to "Allow Firefox to start Earful?".
const PERMISSIONS = ['org.freedesktop.impl.portal.PermissionStore',
    '/org/freedesktop/impl/portal/PermissionStore',
    'org.freedesktop.impl.portal.PermissionStore'];

/** 'yes', 'no' or null (never asked) for Snap Firefox. */
async function firefoxPermission() {
    try {
        const reply = await Gio.DBus.session.call(...PERMISSIONS, 'Lookup',
            new GLib.Variant('(ss)', ['webextensions', BridgeSetup.HOST_NAME]),
            null, Gio.DBusCallFlags.NONE, DBUS_TIMEOUT_MS, null);
        const [permissions] = reply.deepUnpack();
        return permissions['snap.firefox']?.[0] ?? null;
    } catch {
        return null;
    }
}

/** Forgets a "no", so the portal asks the user again next time. */
async function forgetFirefoxPermission() {
    await Gio.DBus.session.call(...PERMISSIONS, 'DeletePermission',
        new GLib.Variant('(sss)', ['webextensions', BridgeSetup.HOST_NAME, 'snap.firefox']),
        null, Gio.DBusCallFlags.NONE, DBUS_TIMEOUT_MS, null);
}

/**
 * One switch per player, adding or removing its appKey in a string list.
 * `onWhenListed` tells whether a listed player shows as switched on.
 */
function addPlayerSwitches(group, settings, key, running, onWhenListed) {
    const known = new Map(running);
    for (const appKey of settings.get_strv(key)) {
        if (!known.has(appKey))
            known.set(appKey, appKey);
    }
    if (known.size === 0)
        group.add(new Adw.ActionRow({title: _('No players running right now')}));

    for (const [appKey, name] of known) {
        const listed = settings.get_strv(key).includes(appKey);
        const row = new Adw.SwitchRow({
            title: GLib.markup_escape_text(name, -1),
            active: listed === onWhenListed,
        });
        row.connect('notify::active', () => {
            const list = new Set(settings.get_strv(key));
            if (row.active === onWhenListed)
                list.add(appKey);
            else
                list.delete(appKey);
            settings.set_strv(key, [...list]);
        });
        group.add(row);
    }
}

export default class EarfulPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        this._window = window;
        const settings = this.getSettings();
        window.set_default_size(620, 760);

        // Three pages: how the menu looks, the popups, and how Earful behaves.
        const menuPage = new Adw.PreferencesPage({
            title: _('Menu'),
            icon_name: 'view-list-symbolic',
        });
        const popupPage = new Adw.PreferencesPage({
            title: _('Popups'),
            icon_name: 'emblem-music-symbolic',
        });
        const page = new Adw.PreferencesPage({
            title: _('Behaviour'),
            icon_name: 'emblem-system-symbolic',
        });
        window.add(menuPage);
        window.add(popupPage);
        window.add(page);
        // Greys out options that don't apply; runs again when these keys change.
        const follow = (keys, sync) => {
            sync();
            const ids = keys.map(key => settings.connect(`changed::${key}`, sync));
            window.connect('close-request', () => ids.forEach(id => settings.disconnect(id)));
        };

        // Menu: style and layout
        const layout = new Adw.PreferencesGroup({
            title: _('Players'),
            description: _('How each player looks in the top bar menu.'),
        });
        menuPage.add(layout);
        layout.add(choiceRow(window, settings, 'menu-style', _('Menu style'), MENU_STYLES));
        const cardLayout = choiceRow(window, settings, 'card-layout', _('Card layout'),
            CARD_LAYOUTS, _('The progress bar and where the volume sits.'));
        const volumeStyle = choiceRow(window, settings, 'card-volume-style',
            _('Volume style'), VOLUME_STYLES);
        const listLayout = choiceRow(window, settings, 'list-layout', _('List layout'),
            LIST_LAYOUTS, _('The progress bar and where the volume sits.'));
        const barsOrder = choiceRow(window, settings, 'list-bars-order',
            _('Bars'), LIST_BARS_ORDERS);
        const coverAnimation = choiceRow(window, settings, 'cover-volume-animation',
            _('Cover animation'), COVER_ANIMATIONS,
            _('Scroll on the cover to change the volume.'));
        // One switch for copying, following the menu style shown.
        const copyRow = new Adw.SwitchRow({
            title: _('Copy on hover'),
            subtitle: _('Click a title or artist to copy it.'),
        });
        const scrollRow = switchRow(settings, 'scroll-titles', _('Slide long titles'),
            _('Pointing at a long title shows its end.'));
        for (const row of [cardLayout, volumeStyle, listLayout, barsOrder, coverAnimation,
            copyRow, scrollRow])
            layout.add(row);
        const copyKey = () => settings.get_string('menu-style') === 'list'
            ? 'copy-on-hover-list' : 'copy-on-hover-cards';
        copyRow.connect('notify::active', () => {
            if (settings.get_string('menu-style') !== 'compact' &&
                settings.get_boolean(copyKey()) !== copyRow.active)
                settings.set_boolean(copyKey(), copyRow.active);
        });

        // Menu: colors
        const look = new Adw.PreferencesGroup({title: _('Look')});
        menuPage.add(look);
        const design = choiceRow(window, settings, 'design', _('Card design'), DESIGNS,
            _('Scenes like Vinyl move while music plays.'));
        const color = choiceRow(window, settings, 'design-color', _('Color'), COLORS);
        const opacity = spinRow(settings, 'design-opacity', _('Opacity (%)'), 40, 100);
        look.add(design);
        look.add(color);
        look.add(opacity);
        look.add(choiceRow(window, settings, 'menu-background', _('Menu background'),
            MENU_BACKGROUNDS, _('Match the music takes the colors of the song that is playing.')));

        // Each option only matters where it is used.
        follow(['menu-style', 'card-layout', 'list-layout', 'design', 'menu-background',
            'copy-on-hover-cards', 'copy-on-hover-list'], () => {
            const style = settings.get_string('menu-style');
            // Compact rows have nothing to copy or slide.
            copyRow.sensitive = style !== 'compact';
            scrollRow.sensitive = style !== 'compact';
            copyRow.active = style !== 'compact' && settings.get_boolean(copyKey());
            const cards = style === 'cards', list = style === 'list';
            const card = settings.get_string('card-layout');
            const row = settings.get_string('list-layout');
            cardLayout.sensitive = cards;
            volumeStyle.sensitive = cards && ['standing-volume', 'side-volume'].includes(card);
            listLayout.sensitive = list;
            barsOrder.sensitive = list && row === 'two-bars';
            coverAnimation.sensitive = (cards && card === 'cover-volume') ||
                (list && row === 'cover-volume');
            // Only cards are painted; the color and opacity also tint a
            // dark or music-colored menu background.
            design.sensitive = cards;
            const painted = cards && settings.get_string('design') !== 'system';
            const tinted = ['dark', 'music'].includes(settings.get_string('menu-background'));
            color.sensitive = painted || tinted;
            opacity.sensitive = painted || tinted;
        });

        // Popups
        const popups = new Adw.PreferencesGroup({
            title: _('Now playing popups'),
            description: _('A small card that fades out when a new track starts.'),
        });
        popupPage.add(popups);
        popups.add(switchRow(settings, 'toasts-enabled', _('Show popups')));
        const popupRows = [
            choiceRow(window, settings, 'toast-position', _('Position'), POSITIONS),
            spinRow(settings, 'toast-duration', _('Seconds on screen'), 2, 30),
            spinRow(settings, 'toast-max-visible', _('Maximum at once'), 1, 6),
        ];
        popupRows.forEach(row => popups.add(row));

        const popupLook = new Adw.PreferencesGroup({title: _('Look')});
        popupPage.add(popupLook);
        const popupDesign = choiceRow(window, settings, 'popup-design', _('Design'), DESIGNS,
            _('Scenes like Vinyl move while music plays.'));
        const popupColor = choiceRow(window, settings, 'popup-design-color', _('Color'), COLORS);
        const popupOpacity = spinRow(settings, 'popup-design-opacity', _('Opacity (%)'), 40, 100);
        const shadow = switchRow(settings, 'toast-shadow', _('Shadow'));
        [popupDesign, popupColor, popupOpacity, shadow].forEach(row => popupLook.add(row));

        const skip = new Adw.PreferencesGroup({title: _('When to stay quiet')});
        popupPage.add(skip);
        skip.add(switchRow(settings, 'toast-hide-when-app-focused',
            _('Skip when the player is in front'),
            _('You already see what is playing.')));
        skip.add(switchRow(settings, 'toast-hide-in-fullscreen',
            _('Skip over fullscreen windows'),
            _('Games, movies and presentations stay clean.')));
        skip.add(switchRow(settings, 'toast-respect-dnd',
            _('Follow Do Not Disturb')));

        // Per app
        const apps = new Adw.PreferencesGroup({
            title: _('Popups per player'),
            description: _('Turn popups off for players you do not care about. Start a player to see it here.'),
        });
        popupPage.add(apps);

        follow(['toasts-enabled', 'popup-design'], () => {
            const on = settings.get_boolean('toasts-enabled');
            popupRows.forEach(row => (row.sensitive = on));
            [popupLook, skip, apps].forEach(group => (group.sensitive = on));
            // The system theme brings its own colors and background.
            const own = settings.get_string('popup-design') !== 'system';
            popupColor.sensitive = own;
            popupOpacity.sensitive = own;
        });

        // Behaviour
        const general = new Adw.PreferencesGroup({title: _('Motion')});
        page.add(general);
        general.add(switchRow(settings, 'animations', _('Animations'),
            _('Moving scenes and little dancing bars while music plays, in the menu and in popups.')));

        // Focus mode
        const focus = new Adw.PreferencesGroup({
            title: _('Focus mode'),
            description: _('Silences all popups until you turn it off.'),
        });
        page.add(focus);
        focus.add(switchRow(settings, 'focus-mode', _('Focus mode')));

        const shortcut = new Adw.EntryRow({
            title: _('Toggle shortcut (e.g. &lt;Super&gt;&lt;Shift&gt;m)'),
            show_apply_button: true,
            text: settings.get_strv('toggle-focus-mode')[0] ?? '',
        });
        shortcut.connect('apply', () => {
            const accel = shortcut.text.trim();
            // Require a real modifier, or a bare letter would be grabbed
            // system-wide and stop working in every app.
            const [ok, key, mods] = Gtk.accelerator_parse(accel);
            const valid = ok && key !== 0 && Gtk.accelerator_valid(key, mods) &&
                (mods & ~Gdk.ModifierType.SHIFT_MASK) !== 0;
            if (accel === '' || valid) {
                settings.set_strv('toggle-focus-mode', accel ? [accel] : []);
                shortcut.remove_css_class('error');
            } else {
                shortcut.add_css_class('error');
            }
        });
        focus.add(shortcut);

        // Top bar
        const panel = new Adw.PreferencesGroup({title: _('Top bar')});
        page.add(panel);
        panel.add(switchRow(settings, 'show-panel-label',
            _('Show the playing track next to the icon')));
        const labelLength = spinRow(settings, 'panel-label-max-chars', _('Label length'), 10, 80);
        settings.bind('show-panel-label', labelLength, 'sensitive', Gio.SettingsBindFlags.GET);
        panel.add(labelLength);
        panel.add(switchRow(settings, 'hide-when-idle',
            _('Hide the button when nothing is playing')));
        panel.add(switchRow(settings, 'show-audio-only-apps',
            _('Show other apps playing sound'),
            _('Games, calls and other apps that are not players, each with a volume slider.')));

        // Browser tabs
        const tabs = new Adw.PreferencesGroup({
            title: _('Browser tabs'),
            description: _('Each browser tab that plays gets its own row in the menu. Needs the free Earful Bridge add-on in your browser.'),
        });
        page.add(tabs);
        tabs.add(switchRow(settings, 'browser-bridge', _('Show each tab as its own player'),
            _('Lets the add-on start Earful\'s small helper program.')));
        this._browserRows = [];
        const refresh = () => this._fillBrowsers(settings, tabs).catch(e =>
            logError(e, 'Earful: could not check browser tabs'));
        refresh();
        // Show the shell's result when the switch changes.
        let refreshId = 0;
        const bridgeId = settings.connect('changed::browser-bridge', () => {
            if (refreshId)
                GLib.source_remove(refreshId);
            refreshId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, BRIDGE_REFRESH_DELAY_MS, () => {
                refreshId = 0;
                refresh();
                return GLib.SOURCE_REMOVE;
            });
        });
        window.connect('close-request', () => {
            settings.disconnect(bridgeId);
            if (refreshId)
                GLib.source_remove(refreshId);
        });

        // Playback
        const playback = new Adw.PreferencesGroup({title: _('Playback')});
        page.add(playback);
        playback.add(switchRow(settings, 'pause-others',
            _('Pause others when one starts'),
            _('Only one player plays at a time, except the ones you keep below.')));
        playback.add(choiceRow(window, settings, 'media-keys-target',
            _('Media keys control'), MEDIA_KEY_TARGETS,
            _('Pin a player from its row in the top bar menu.')));

        // Pause others: exceptions
        const keep = new Adw.PreferencesGroup({
            title: _('Keep playing'),
            description: _('These players are never paused when another one starts.'),
        });
        settings.bind('pause-others', keep, 'sensitive', Gio.SettingsBindFlags.GET);
        page.add(keep);

        this._fillPlayers(settings, keep, apps).catch(e =>
            logError(e, 'Earful: could not list players'));
    }

    // One row per browser found, saying whether the helper is set up, plus a
    // way back for Snap Firefox when its permission was once denied.
    async _fillBrowsers(settings, group) {
        // Only the latest refresh may change the rows.
        const turn = this._browserTurn = (this._browserTurn ?? 0) + 1;
        const paths = BridgeSetup.defaultPaths(
            GLib.build_filenamev([this.path, 'bridge', 'earful-host.js']));
        const enabled = settings.get_boolean('browser-bridge');
        // A browser installed since the shell last checked gets set up right away.
        if (enabled)
            await BridgeSetup.register(paths);
        const found = await BridgeSetup.status(paths);
        const blocked = paths.snapFirefox && await firefoxPermission() === 'no';
        if (turn !== this._browserTurn)
            return;

        for (const row of this._browserRows)
            group.remove(row);
        this._browserRows = [];
        const add = row => {
            group.add(row);
            this._browserRows.push(row);
        };

        const byName = new Map();
        for (const browser of found)
            byName.set(browser.name, (byName.get(browser.name) ?? false) || browser.registered);
        if (byName.size === 0) {
            add(new Adw.ActionRow({title: _('No supported browser found')}));
            return;
        }

        // Where the add-on has already reached Earful, and where it hasn't yet.
        const seen = BridgeSetup.readSeen();
        const connected = [...byName.keys()].filter(name => name in seen);
        const browsers = new Adw.ExpanderRow({
            title: _('Browsers'),
            subtitle: browsersSummary(enabled, connected, byName.size),
        });
        add(browsers);

        for (const [name, registered] of byName) {
            const isFirefox = name === 'Firefox';
            let subtitle = _('Off');
            if (enabled && !registered)
                subtitle = _('Could not set up. Restart your computer to try again.');
            else if (enabled && isFirefox && blocked)
                subtitle = _('Firefox is not allowed to start Earful\'s helper.');
            else if (enabled && name in seen)
                subtitle = _('Add-on connected');
            else if (enabled)
                subtitle = _('Not seen yet. Add the add-on, or play something there to check.');
            const row = new Adw.ActionRow({title: GLib.markup_escape_text(name, -1), subtitle});
            if (enabled && registered && !(name in seen) && !(isFirefox && blocked)) {
                const get = new Gtk.Button({label: _('Get the add-on'), valign: Gtk.Align.CENTER});
                get.connect('clicked', () => openIn(name, isFirefox ? FIREFOX_ADDON : CHROME_ADDON,
                    this._window));
                row.add_suffix(get);
            }
            if (enabled && name in seen)
                row.add_prefix(new Gtk.Image({icon_name: 'emblem-ok-symbolic'}));
            if (isFirefox && enabled && blocked) {
                const again = new Gtk.Button({label: _('Ask again'), valign: Gtk.Align.CENTER});
                again.connect('clicked', async () => {
                    again.sensitive = false;
                    try {
                        await forgetFirefoxPermission();
                        row.subtitle = _('Firefox will ask once more. Choose Allow.');
                    } catch (e) {
                        logError(e, 'Earful: could not reset the Firefox permission');
                        again.sensitive = true;
                    }
                });
                row.add_suffix(again);
            }
            browsers.add_row(row);
        }
    }

    async _fillPlayers(settings, keep, apps) {
        const running = await runningPlayers();
        addPlayerSwitches(keep, settings, 'pause-others-exceptions', running, true);
        addPlayerSwitches(apps, settings, 'toast-muted-apps', running, false);
    }
}
