// Top bar button that lists every player with its own controls.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Slider from 'resource:///org/gnome/shell/ui/slider.js';

import {CoverArt} from './art.js';
import * as Look from './look.js';
import {SourceLine} from './widgets.js';

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

/** A small volume slider for a player's MPRIS volume or a set of streams. */
const VolumeSlider = GObject.registerClass(
class VolumeSlider extends St.BoxLayout {
    _init(audio) {
        super._init({
            style_class: 'earful-volume',
            x_expand: true,
            visible: false,
        });
        this._audio = audio;
        this._player = null;
        this._streams = [];
        this._dragging = false;
        this._updating = false;

        this._icon = new St.Icon({
            style_class: 'earful-volume-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._icon);

        this._slider = new Slider.Slider(0);
        this._slider.accessible_name = _('Volume');
        this._slider.y_align = Clutter.ActorAlign.CENTER;
        // External changes don't move the handle while it is dragged.
        this._slider.connectObject(
            'notify::value', () => this._onSliderChanged(),
            'drag-begin', () => (this._dragging = true),
            'drag-end', () => {
                this._dragging = false;
                this.sync();
            },
            this);
        this.add_child(this._slider);

        this.connect('destroy', () => this._bind(null, []));
    }

    bindPlayer(player) {
        this._bind(player, []);
    }

    /** Inline style for the bar, e.g. the cover's accent color. */
    setSliderStyle(style) {
        if (this._slider.style === style)
            return;
        this._slider.style = style;
        // The bar is drawn once and only redrawn on request.
        this._slider.queue_repaint();
    }

    bindStreams(streams) {
        this._bind(null, streams);
    }

    _bind(player, streams) {
        const same = player === this._player &&
            streams.length === this._streams.length &&
            streams.every((s, i) => s === this._streams[i]);
        if (!same) {
            for (const stream of this._streams)
                stream.disconnectObject(this);
            this._player = player;
            this._streams = streams;
            for (const stream of streams) {
                stream.connectObject(
                    'notify::volume', () => this.sync(),
                    'notify::is-muted', () => this.sync(),
                    this);
            }
        }
        this.sync();
    }

    _read() {
        if (this._player)
            return this._player.volume;
        if (this._streams.length > 0)
            return this._audio.getVolume(this._streams);
        return null;
    }

    sync() {
        const value = this._read();
        this.visible = value !== null;
        if (value === null || this._dragging)
            return;
        this._updating = true;
        this._slider.value = value;
        this._updating = false;
        this._syncIcon(value);
    }

    _onSliderChanged() {
        if (this._updating)
            return;
        const {value} = this._slider;
        if (this._player)
            this._player.setVolume(value);
        else
            this._audio.setVolume(this._streams, value);
        this._syncIcon(value);
    }

    _syncIcon(value) {
        let level = 'high';
        if (value <= 0)
            level = 'muted';
        else if (value < 1 / 3)
            level = 'low';
        else if (value < 2 / 3)
            level = 'medium';
        this._icon.icon_name = `audio-volume-${level}-symbolic`;
    }
});

// Cover size per menu style, in logical pixels.
const COVER_SIZES = {cards: 64, list: 48, compact: 32};

const PlayerItem = GObject.registerClass(
class PlayerItem extends PopupMenu.PopupBaseMenuItem {
    _init(player, audio, settings, style) {
        super._init({style_class: `earful-player earful-${style}`});
        this.player = player;
        this._audio = audio;
        this._settings = settings;
        this._style = style;

        this._art = new CoverArt(COVER_SIZES[style], 'earful-art');

        const text = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'earful-text',
        });
        this._source = new SourceLine('earful-source');
        this._title = new St.Label({style_class: 'earful-title'});
        this._artist = new St.Label({style_class: 'earful-artist'});
        if (style !== 'compact')
            text.add_child(this._source);
        text.add_child(this._title);
        text.add_child(this._artist);

        // Shown only when media keys go to a pinned player.
        this._pin = new St.Button({
            style_class: 'earful-control earful-pin',
            can_focus: true,
            toggle_mode: true,
            y_align: Clutter.ActorAlign.CENTER,
            accessible_name: _('Media keys control this player'),
            child: new St.Icon({icon_name: 'view-pin-symbolic'}),
        });
        this._pin.connect('clicked', () => {
            settings.set_string('media-keys-pinned',
                this._pin.checked ? player.appKey : '');
        });

        this._prev = controlButton('media-skip-backward-symbolic',
            () => player.previous());
        this._playPause = controlButton('media-playback-start-symbolic',
            () => player.playPause());
        this._playPause.add_style_class_name('earful-play');
        this._next = controlButton('media-skip-forward-symbolic',
            () => player.next());
        const controls = new St.BoxLayout({
            style_class: 'earful-controls',
            y_align: Clutter.ActorAlign.CENTER,
        });
        if (style !== 'compact')
            controls.add_child(this._prev);
        controls.add_child(this._playPause);
        controls.add_child(this._next);

        this._volume = style === 'compact' ? null : new VolumeSlider(audio);

        if (style === 'cards') {
            // Cover and text on top; volume and controls share the row below.
            const column = new St.BoxLayout({vertical: true, x_expand: true});
            const top = new St.BoxLayout({style_class: 'earful-card-top'});
            top.add_child(this._art);
            top.add_child(text);
            top.add_child(this._pin);
            const bottom = new St.BoxLayout({style_class: 'earful-card-bottom'});
            bottom.add_child(this._volume);
            controls.x_expand = true;
            controls.x_align = Clutter.ActorAlign.END;
            bottom.add_child(controls);
            column.add_child(top);
            column.add_child(bottom);
            this.add_child(column);
        } else {
            if (this._volume)
                text.add_child(this._volume);
            this.add_child(this._art);
            this.add_child(text);
            this.add_child(this._pin);
            this.add_child(controls);
        }

        player.connectObject(
            'changed', () => this._sync(),
            'closed', () => this.destroy(),
            this);
        if (this._volume)
            audio.connectObject('changed', () => this._syncVolume(), this);
        settings.connectObject(
            'changed::media-keys-target', () => this._syncPin(),
            'changed::media-keys-pinned', () => this._syncPin(),
            'changed::design', () => this._restyle(),
            'changed::design-opacity', () => this._restyle(),
            'changed::animations', () => this._restyle(),
            this);
        this._art.connect('palette-changed', () => this._restyle());
        // Painted cards can't use the theme's hover color.
        this.connect('notify::active', () => this._restyle());
        this._sync();
        this._syncPin();
    }

    _restyle() {
        const look = Look.lookFromSettings(this._settings);
        const palette = this._art.palette;
        if (this._style === 'cards') {
            this.style = Look.surfaceStyle(look, palette, this.active);
            if (Look.isPainted(look))
                this.add_style_class_name('earful-painted');
            else
                this.remove_style_class_name('earful-painted');
            this._volume.setSliderStyle(Look.sliderStyle(look, palette));
        }
        this._source.update(this.player, this._settings.get_boolean('animations'),
            Look.accentColor(look, palette));
    }

    _syncVolume() {
        if (!this._volume)
            return;
        // The player's own volume if it has one, else its mixer streams.
        if (this.player.volume !== null)
            this._volume.bindPlayer(this.player);
        else
            this._volume.bindStreams(this._audio.streamsFor(this.player));
    }

    _syncPin() {
        this._pin.visible =
            this._settings.get_string('media-keys-target') === 'pinned';
        this._pin.checked =
            this._settings.get_string('media-keys-pinned') === this.player.appKey;
    }

    _sync() {
        const p = this.player;
        this._art.setPlayer(p);
        this._restyle();
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

        this._syncVolume();
    }

    activate(event) {
        this.player.raise();
        super.activate(event);
    }
});

/** An app that plays sound but is not a player: name, icon and volume. */
const AudioAppItem = GObject.registerClass(
class AudioAppItem extends PopupMenu.PopupBaseMenuItem {
    _init(audio, entry) {
        // Clicking raises the app when we know which one it is.
        super._init({
            style_class: 'earful-player earful-audio-app',
            activate: entry.app !== null,
            hover: entry.app !== null,
        });

        this._icon = new St.Icon({
            style_class: 'earful-app-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._icon);

        const text = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'earful-text',
        });
        // "mpv" above "My Trip" when the app says what it plays.
        this._source = new St.Label({style_class: 'earful-source'});
        this._name = new St.Label({style_class: 'earful-title'});
        this._volume = new VolumeSlider(audio);
        text.add_child(this._source);
        text.add_child(this._name);
        text.add_child(this._volume);
        this.add_child(text);

        this.update(entry);
    }

    get entry() {
        return this._entry;
    }

    update(entry) {
        this._entry = entry;
        this._icon.gicon = entry.gicon;
        this._source.text = entry.detail ? entry.name : '';
        this._source.visible = entry.detail !== '';
        this._name.text = entry.detail || entry.name;
        this._volume.bindStreams(entry.streams);
    }

    activate(event) {
        this._entry.app?.activate();
        super.activate(event);
    }
});

export const EarfulIndicator = GObject.registerClass(
class EarfulIndicator extends PanelMenu.Button {
    _init(extension, manager, audio) {
        super._init(0.5, 'Earful');

        this._extension = extension;
        this._settings = extension.getSettings();
        this._manager = manager;
        this._audio = audio;

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

        // Apps that play sound without being a player (games, calls).
        this._othersSection = new PopupMenu.PopupMenuSection();
        this._othersSection.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const othersTitle = new PopupMenu.PopupMenuItem(_('Other audio'),
            {reactive: false});
        othersTitle.add_style_class_name('earful-section-title');
        this._othersSection.addMenuItem(othersTitle);
        this.menu.addMenuItem(this._othersSection);
        this._otherItems = new Map();

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
            'changed::show-audio-only-apps', () => this._syncOthers(),
            'changed::menu-style', () => this._queueRebuild(),
            this);
        audio.connectObject('changed', () => this._syncOthers(), this);

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
            this._syncOthers();
        }, this);

        this._rebuild();
        this._syncOthers();
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
        const style = this._settings.get_string('menu-style');
        for (const name of ['cards', 'list', 'compact'])
            this.menu.box.remove_style_class_name(`earful-menu-${name}`);
        this.menu.box.add_style_class_name(`earful-menu-${style}`);
        for (const player of players)
            this._section.addMenuItem(new PlayerItem(player, this._audio, this._settings, style));

        if (players.length === 0) {
            const empty = new PopupMenu.PopupMenuItem(_('Nothing is playing'),
                {reactive: false});
            empty.add_style_class_name('earful-empty');
            this._section.addMenuItem(empty);
        }

        this._syncPanel();
    }

    _syncOthers() {
        const apps = this._settings.get_boolean('show-audio-only-apps')
            ? this._audio.otherApps : [];
        const entries = new Map(apps.map(a => [a.key, a]));
        // While the menu is open rows only update in place, like players:
        // gone apps lose their slider, new ones wait for the next open.
        const open = this.menu.isOpen;

        for (const [key, item] of this._otherItems) {
            if (entries.has(key)) {
                item.update(entries.get(key));
            } else if (open) {
                item.update({...item.entry, streams: []});
            } else {
                item.destroy();
                this._otherItems.delete(key);
            }
        }
        if (!open) {
            for (const entry of apps) {
                if (this._otherItems.has(entry.key))
                    continue;
                const item = new AudioAppItem(this._audio, entry);
                this._othersSection.addMenuItem(item);
                this._otherItems.set(entry.key, item);
            }
        }
        this._othersSection.actor.visible = this._otherItems.size > 0;
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
        this._audio.disconnectObject(this);
        this._otherItems.clear();
        for (const player of this._watched)
            player.disconnectObject(this);
        this._watched.clear();
        super.destroy();
    }
});
