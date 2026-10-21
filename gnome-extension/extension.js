import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {PlayerManager} from './lib/mpris.js';
import {EarfulIndicator} from './lib/panel.js';
import {ToastManager} from './lib/toasts.js';

export default class EarfulExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._manager = new PlayerManager();
        this._toasts = new ToastManager(this._settings, this._manager);

        this._indicator = new EarfulIndicator(this, this._manager);
        Main.panel.addToStatusArea(this.uuid, this._indicator, 0, 'right');

        Main.wm.addKeybinding('toggle-focus-mode', this._settings,
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => this._toggleFocusMode());
    }

    _toggleFocusMode() {
        const focus = !this._settings.get_boolean('focus-mode');
        this._settings.set_boolean('focus-mode', focus);
        const label = focus ? _('Focus mode on') : _('Focus mode off');
        const osd = Main.osdWindowManager;
        // GNOME 49 replaced show(monitor, icon, label) with showAll(icon, label).
        if (osd.showAll)
            osd.showAll(this._indicator.earfulIcon, label);
        else
            osd.show(-1, this._indicator.earfulIcon, label);
    }

    disable() {
        Main.wm.removeKeybinding('toggle-focus-mode');

        this._indicator.destroy();
        this._indicator = null;
        this._toasts.destroy();
        this._toasts = null;
        this._manager.destroy();
        this._manager = null;
        this._settings = null;
    }
}
