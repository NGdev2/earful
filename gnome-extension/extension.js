import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {clearCache as clearArtCache} from './lib/art.js';
import {AudioManager} from './lib/audio.js';
import * as BridgeSetup from './lib/bridgeSetup.js';
import {MediaKeys} from './lib/mediaKeys.js';
import {PlayerManager} from './lib/mpris.js';
import {EarfulIndicator} from './lib/panel.js';
import {PauseOthers} from './lib/pauseOthers.js';
import {ToastManager} from './lib/toasts.js';

export default class EarfulExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._manager = new PlayerManager();
        this._audio = new AudioManager(this._manager);
        this._toasts = new ToastManager(this._settings, this._manager);
        this._pauseOthers = new PauseOthers(this._settings, this._manager);
        this._mediaKeys = new MediaKeys(this._settings, this._manager);

        this._indicator = new EarfulIndicator(this, this._manager, this._audio);
        Main.panel.addToStatusArea(this.uuid, this._indicator, 0, 'right');

        Main.wm.addKeybinding('toggle-focus-mode', this._settings,
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => this._toggleFocusMode());

        // Register the browser helper once per login (enable also runs after
        // every screen unlock), and again whenever the switch changes.
        this._bridgeCancellable = new Gio.Cancellable();
        this._bridgeChangedId = this._settings.connect('changed::browser-bridge',
            () => this._syncBridge());
        if (!this._bridgeSynced)
            this._syncBridge();
    }

    _syncBridge() {
        const cancellable = this._bridgeCancellable;
        const enabled = this._settings.get_boolean('browser-bridge');
        // One at a time, in order, so a quick off-on can't race.
        this._bridgeQueue = (this._bridgeQueue ?? Promise.resolve())
            .then(() => this._applyBridge(enabled, cancellable));
    }

    async _applyBridge(enabled, cancellable) {
        if (cancellable.is_cancelled())
            return;
        const paths = BridgeSetup.defaultPaths(
            GLib.build_filenamev([this.path, 'bridge', 'earful-host.js']));
        try {
            if (enabled) {
                const {failed} = await BridgeSetup.register(paths, cancellable);
                if (failed.length)
                    console.warn(`Earful: could not set up browser tabs for ${failed.map(f => `${f.name} (${f.error})`).join(', ')}`);
            } else {
                await BridgeSetup.unregister(paths, cancellable);
            }
            this._bridgeSynced = true;
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                logError(e, 'Earful: browser tabs setup');
        }
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
        this._bridgeCancellable.cancel();
        this._bridgeCancellable = null;
        this._settings.disconnect(this._bridgeChangedId);
        Main.wm.removeKeybinding('toggle-focus-mode');

        this._indicator.destroy();
        this._indicator = null;
        this._mediaKeys.destroy();
        this._mediaKeys = null;
        this._pauseOthers.destroy();
        this._pauseOthers = null;
        this._toasts.destroy();
        this._toasts = null;
        this._audio.destroy();
        this._audio = null;
        this._manager.destroy();
        this._manager = null;
        this._settings = null;
        clearArtCache();
    }
}
