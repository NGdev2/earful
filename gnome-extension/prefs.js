import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

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
        const settings = this.getSettings();
        window.set_default_size(620, 760);

        const page = new Adw.PreferencesPage();
        window.add(page);

        // Look
        const look = new Adw.PreferencesGroup({
            title: _('Look'),
            description: _('Make the menu and popups yours.'),
        });
        page.add(look);
        look.add(choiceRow(window, settings, 'menu-style', _('Menu style'), MENU_STYLES));
        look.add(choiceRow(window, settings, 'design', _('Design'), DESIGNS,
            _('Popups and cards. Scenes like Vinyl move while music plays.')));
        const color = choiceRow(window, settings, 'design-color', _('Color'), COLORS);
        const opacity = spinRow(settings, 'design-opacity', _('Opacity (%)'), 40, 100);
        // The system theme brings its own colors and background.
        const syncDesign = () => {
            const own = settings.get_string('design') !== 'system';
            color.sensitive = own;
            opacity.sensitive = own;
        };
        syncDesign();
        const designId = settings.connect('changed::design', syncDesign);
        window.connect('close-request', () => settings.disconnect(designId));
        look.add(color);
        look.add(opacity);
        look.add(switchRow(settings, 'animations', _('Animations'),
            _('Moving scenes and little dancing bars while music plays.')));

        // Popups
        const popups = new Adw.PreferencesGroup({
            title: _('Now playing popups'),
            description: _('A small card that fades out when a new track starts.'),
        });
        page.add(popups);

        popups.add(switchRow(settings, 'toasts-enabled', _('Show popups')));
        popups.add(choiceRow(window, settings, 'toast-position', _('Position'), POSITIONS));
        popups.add(spinRow(settings, 'toast-duration', _('Seconds on screen'), 2, 30));
        popups.add(spinRow(settings, 'toast-max-visible', _('Maximum at once'), 1, 6));
        popups.add(switchRow(settings, 'toast-hide-when-app-focused',
            _('Skip when the player is in front'),
            _('You already see what is playing.')));
        popups.add(switchRow(settings, 'toast-hide-in-fullscreen',
            _('Skip over fullscreen windows'),
            _('Games, movies and presentations stay clean.')));
        popups.add(switchRow(settings, 'toast-respect-dnd',
            _('Follow Do Not Disturb')));

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
        panel.add(spinRow(settings, 'panel-label-max-chars', _('Label length'), 10, 80));
        panel.add(switchRow(settings, 'hide-when-idle',
            _('Hide the button when nothing is playing')));
        panel.add(switchRow(settings, 'show-audio-only-apps',
            _('Show other apps playing sound'),
            _('Games, calls and other apps that are not players, each with a volume slider.')));

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

        // Per app
        const apps = new Adw.PreferencesGroup({
            title: _('Popups per player'),
            description: _('Turn popups off for players you do not care about. Start a player to see it here.'),
        });
        page.add(apps);

        this._fillPlayers(settings, keep, apps).catch(e =>
            logError(e, 'Earful: could not list players'));
    }

    async _fillPlayers(settings, keep, apps) {
        const running = await runningPlayers();
        addPlayerSwitches(keep, settings, 'pause-others-exceptions', running, true);
        addPlayerSwitches(apps, settings, 'toast-muted-apps', running, false);
    }
}
