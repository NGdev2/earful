// Top bar button that lists every player with its own controls.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

function controlButton(iconName, onClick) {
    const button = new St.Button({
        style_class: 'earful-control',
        can_focus: true,
        y_align: Clutter.ActorAlign.CENTER,
        child: new St.Icon({icon_name: iconName}),
    });
    button.connect('clicked', onClick);
    return button;
}

const PlayerItem = GObject.registerClass(
class PlayerItem extends PopupMenu.PopupBaseMenuItem {
    _init(player) {
        super._init({style_class: 'earful-player'});
        this.player = player;

        this._art = new St.Icon({
            style_class: 'earful-art',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._art);

        const text = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'earful-text',
        });
        this._source = new St.Label({style_class: 'earful-source'});
        this._title = new St.Label({style_class: 'earful-title'});
        this._artist = new St.Label({style_class: 'earful-artist'});
        text.add_child(this._source);
        text.add_child(this._title);
        text.add_child(this._artist);
        this.add_child(text);

        const controls = new St.BoxLayout({style_class: 'earful-controls'});
        this._prev = controlButton('media-skip-backward-symbolic',
            () => player.previous());
        this._playPause = controlButton('media-playback-start-symbolic',
            () => player.playPause());
        this._next = controlButton('media-skip-forward-symbolic',
            () => player.next());
        controls.add_child(this._prev);
        controls.add_child(this._playPause);
        controls.add_child(this._next);
        this.add_child(controls);

        player.connectObject(
            'changed', () => this._sync(),
            'closed', () => this.destroy(),
            this);
        this._sync();
    }

    _sync() {
        const p = this.player;
        this._art.gicon = p.artIcon;
        this._source.text = p.sourceName;
        this._title.text = p.title;
        this._artist.text = p.artistText;
        this._artist.visible = this._artist.text !== '';
        this._playPause.child.icon_name = p.isPlaying
            ? 'media-playback-pause-symbolic'
            : 'media-playback-start-symbolic';
        this._prev.reactive = p.canGoPrevious;
        this._next.reactive = p.canGoNext;
        this._prev.opacity = p.canGoPrevious ? 255 : 100;
        this._next.opacity = p.canGoNext ? 255 : 100;

        if (p.isPlaying)
            this.add_style_pseudo_class('playing');
        else
            this.remove_style_pseudo_class('playing');
    }

    activate(event) {
        this.player.raise();
        super.activate(event);
    }
});

export const EarfulIndicator = GObject.registerClass(
class EarfulIndicator extends PanelMenu.Button {
    _init(extension, manager) {
        super._init(0.5, 'Earful');

        this._extension = extension;
        this._settings = extension.getSettings();
        this._manager = manager;

        const box = new St.BoxLayout({style_class: 'panel-status-menu-box'});
        this._icon = new St.Icon({
            gicon: Gio.icon_new_for_string(
                `${extension.path}/icons/earful-symbolic.svg`),
            style_class: 'system-status-icon',
        });
        this._label = new St.Label({
            style_class: 'earful-panel-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(this._icon);
        box.add_child(this._label);
        this.add_child(box);

        this._section = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._section);
        this.menu.box.add_style_class_name('earful-menu');

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._focusSwitch = new PopupMenu.PopupSwitchMenuItem(
            _('Focus mode (no popups)'), this._settings.get_boolean('focus-mode'));
        this._focusSwitch.connect('toggled', (item, state) =>
            this._settings.set_boolean('focus-mode', state));
        this.menu.addMenuItem(this._focusSwitch);
        this.menu.addAction(_('Settings'), () => extension.openPreferences());

        this._settings.connectObject(
            'changed::focus-mode', () => this._focusSwitch.setToggleState(
                this._settings.get_boolean('focus-mode')),
            'changed::show-panel-label', () => this._syncPanel(),
            'changed::panel-label-max-chars', () => this._syncPanel(),
            'changed::hide-when-idle', () => this._syncPanel(),
            this);

        this._watched = new Set();
        manager.connectObject(
            'player-added', (m, player) => this._watchPlayer(player),
            'player-removed', () => this._queueRebuild(),
            this);
        // Rebuilding while open would steal key focus and make rows jump,
        // so changes to the list wait until the menu closes.
        this.menu.connectObject('open-state-changed', (menu, open) => {
            if (open || this._dirty)
                this._rebuild();
        }, this);

        this._rebuild();
    }

    get earfulIcon() {
        return this._icon.gicon;
    }

    _watchPlayer(player) {
        // Rebuild when a player gains or loses a track, otherwise items
        // update themselves and only the panel label needs syncing.
        let hadTrack = player.hasTrack;
        player.connectObject('changed', () => {
            if (player.hasTrack !== hadTrack) {
                hadTrack = player.hasTrack;
                this._queueRebuild();
            } else {
                this._syncPanel();
            }
        }, this);
        player.connectObject('closed', () => {
            player.disconnectObject(this);
            this._watched.delete(player);
        }, this);
        this._watched.add(player);
        this._queueRebuild();
    }

    _queueRebuild() {
        if (this.menu.isOpen) {
            this._dirty = true;
            return;
        }
        if (this._rebuildId)
            return;
        this._rebuildId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._rebuildId = 0;
            this._rebuild();
            return GLib.SOURCE_REMOVE;
        });
    }

    _rebuild() {
        this._dirty = false;
        this._section.removeAll();

        const players = this._manager.players;
        for (const player of players)
            this._section.addMenuItem(new PlayerItem(player));

        if (players.length === 0) {
            const empty = new PopupMenu.PopupMenuItem(_('Nothing is playing'),
                {reactive: false});
            empty.add_style_class_name('earful-empty');
            this._section.addMenuItem(empty);
        }

        this._syncPanel();
    }

    _syncPanel() {
        const current = this._manager.current;

        this.visible = current !== null ||
            !this._settings.get_boolean('hide-when-idle');

        let text = '';
        if (current?.isPlaying && this._settings.get_boolean('show-panel-label')) {
            text = current.artistText
                ? `${current.title} · ${current.artistText}`
                : current.title;
            const max = this._settings.get_int('panel-label-max-chars');
            if (text.length > max)
                text = `${text.slice(0, max - 1)}…`;
        }
        this._label.text = text;
        this._label.visible = text !== '';
    }

    destroy() {
        if (this._rebuildId)
            GLib.source_remove(this._rebuildId);
        this._settings.disconnectObject(this);
        this._manager.disconnectObject(this);
        for (const player of this._watched)
            player.disconnectObject(this);
        this._watched.clear();
        super.destroy();
    }
});
