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

export default class EarfulPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.set_default_size(620, 760);

        const page = new Adw.PreferencesPage();
        window.add(page);

        // Popups
        const popups = new Adw.PreferencesGroup({
            title: _('Now playing popups'),
            description: _('A small card that fades out when a new track starts.'),
        });
        page.add(popups);

        popups.add(switchRow(settings, 'toasts-enabled', _('Show popups')));

        const position = new Adw.ComboRow({
            title: _('Position'),
            model: Gtk.StringList.new(POSITIONS.map(([, label]) => label())),
        });
        const syncPosition = () => {
            position.selected = Math.max(0,
                POSITIONS.findIndex(([id]) => id === settings.get_string('toast-position')));
        };
        syncPosition();
        const positionId = settings.connect('changed::toast-position', syncPosition);
        window.connect('close-request', () => settings.disconnect(positionId));
        position.connect('notify::selected', () =>
            settings.set_string('toast-position', POSITIONS[position.selected][0]));
        popups.add(position);

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

        // Per app
        const apps = new Adw.PreferencesGroup({
            title: _('Popups per player'),
            description: _('Turn popups off for players you do not care about. Start a player to see it here.'),
        });
        page.add(apps);

        this._fillPlayers(apps, settings).catch(e =>
            logError(e, 'Earful: could not list players'));
    }

    async _fillPlayers(group, settings) {
        const known = await runningPlayers();
        for (const key of settings.get_strv('toast-muted-apps')) {
            if (!known.has(key))
                known.set(key, key);
        }
        if (known.size === 0) {
            group.add(new Adw.ActionRow({title: _('No players running right now')}));
        }
        for (const [key, name] of known) {
            const row = new Adw.SwitchRow({
                title: GLib.markup_escape_text(name, -1),
                active: !settings.get_strv('toast-muted-apps').includes(key),
            });
            row.connect('notify::active', () => {
                const muted = new Set(settings.get_strv('toast-muted-apps'));
                if (row.active)
                    muted.delete(key);
                else
                    muted.add(key);
                settings.set_strv('toast-muted-apps', [...muted]);
            });
            group.add(row);
        }
    }
}
