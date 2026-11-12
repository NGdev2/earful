// SPDX-License-Identifier: GPL-3.0-or-later
// Top bar button that lists every player with its own controls.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Slider from 'resource:///org/gnome/shell/ui/slider.js';
import {ensureActorVisibleInScrollView} from 'resource:///org/gnome/shell/misc/animationUtils.js';

import {CoverArt} from './art.js';
import * as Look from './look.js';
import {ProgressBar} from './progress.js';
import {VolumeSource, volumeIcon} from './volume.js';
import {VerticalVolume} from './volumeStyles.js';
import {CoverVolume} from './coverVolume.js';
import {DuoBars, SwapLine} from './listBars.js';
import {SceneLayer} from './scenes.js';
import {SourceLine, VERTICAL, scaleFactor} from './widgets.js';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

// Only one extension settings window can be open at a time, and GNOME does
// not raise it when asked again, so it can stay hidden behind other windows.
function openSettings(extension) {
    const window = global.display.list_all_windows()
        .find(w => w.get_wm_class() === 'org.gnome.Shell.Extensions');
    if (!window) {
        extension.openPreferences();
        return;
    }
    Main.activateWindow(window);
    if (window.get_title() !== extension.metadata.name) {
        Main.notify(_('Settings of “%s” are open').format(window.get_title()),
            _('Close them to open Earful\'s settings.'));
    }
}

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

// Width of a slide-out volume bar, in logical pixels.
const SLIDE_WIDTH = 90;

/** A small horizontal volume slider: speaker (mute) and bar. */
const VolumeSlider = GObject.registerClass(
class VolumeSlider extends St.BoxLayout {
    /**
     * @param {VolumeSource} source
     * @param {object} [options]
     * @param {boolean} [options.slide] only the speaker shows; the bar slides
     *   out from it while hovered
     */
    _init(source, {slide = false} = {}) {
        super._init({
            style_class: slide ? 'earful-volume earful-volume-slide' : 'earful-volume',
            x_expand: !slide,
            visible: false,
            track_hover: slide,
            reactive: slide,
        });
        this._source = source;
        this._dragging = false;
        this._updating = false;

        this._icon = new St.Icon({style_class: 'earful-volume-icon'});
        // Clicking the icon mutes, and clicking again brings the volume back.
        this._muteButton = new St.Button({
            style_class: 'earful-volume-mute',
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
            accessible_name: _('Mute'),
            child: this._icon,
        });
        this._muteButton.connect('clicked', () => {
            const value = source.toggleMute();
            if (value === null)
                return;
            this._setSlider(value);
            this._syncIcon(value);
        });
        this.add_child(this._muteButton);

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
        if (slide) {
            this._slider.width = 0;
            this._slider.opacity = 0;
            const sync = () => {
                const open = this.hover || this._dragging;
                this._slider.ease({
                    width: open ? SLIDE_WIDTH * scaleFactor() : 0,
                    opacity: open ? 255 : 0,
                    duration: 180,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
            };
            this.connect('notify::hover', sync);
            this._slider.connect('drag-end', sync);
        }

        source.connectObject('changed', () => this.sync(), this);
        this.connect('destroy', () => source.disconnectObject(this));
        this.sync();
    }

    /** Inline style for the bar, e.g. the cover's accent color. */
    setSliderStyle(style) {
        if (this._slider.style === style)
            return;
        this._slider.style = style;
        // The bar is drawn once and only redrawn on request.
        this._slider.queue_repaint();
    }

    sync() {
        const value = this._source.read();
        this.visible = value !== null;
        if (value === null || this._dragging)
            return;
        this._setSlider(value);
        this._syncIcon(value);
    }

    _setSlider(value) {
        this._updating = true;
        this._slider.value = value;
        this._updating = false;
    }

    _onSliderChanged() {
        if (this._updating)
            return;
        this._source.apply(this._slider.value);
        this._syncIcon(this._slider.value);
    }

    _syncIcon(value) {
        this._icon.icon_name = volumeIcon(value);
        this._muteButton.accessible_name = value > 0 ? _('Mute') : _('Unmute');
    }
});

// Must match .earful-cards in stylesheet.css (minus the border).
const CARD_RADIUS = 15;

// Cover size per menu style, in logical pixels.
const COVER_SIZES = {cards: 64, list: 48, compact: 32};

const PlayerItem = GObject.registerClass({
    Signals: {'palette-changed': {}},
}, class PlayerItem extends PopupMenu.PopupBaseMenuItem {
    _init(player, audio, settings, style) {
        super._init({style_class: `earful-player earful-${style}`});
        this.player = player;
        this._audio = audio;
        this._settings = settings;
        this._style = style;

        const slim = style === 'cards' && settings.get_string('card-layout') === 'slim';
        const listLayout = style === 'list' ? settings.get_string('list-layout') : null;
        this._art = new CoverArt(slim ? COVER_SIZES.list : COVER_SIZES[style]);

        const text = new St.BoxLayout({
            ...VERTICAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'earful-text',
        });
        // Compact rows have no source line.
        this._source = style === 'compact' ? null : new SourceLine('earful-source');
        this._title = new St.Label({style_class: 'earful-title'});
        this._artist = new St.Label({style_class: 'earful-artist'});
        if (this._source)
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

        // Only on players that aren't playing: hides the row until it plays.
        this._dismiss = new St.Button({
            style_class: 'earful-control earful-dismiss',
            can_focus: true,
            y_align: style === 'cards' ? Clutter.ActorAlign.START : Clutter.ActorAlign.CENTER,
            accessible_name: _('Hide until it plays again'),
            child: new St.Icon({icon_name: 'window-close-symbolic'}),
        });
        this._dismiss.connect('clicked', () => {
            player.dismiss();
            // The list itself is rebuilt when the menu closes.
            this.hide();
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
        // Hidden in compact rows, but still in the row so it's destroyed with it.
        this._prev.visible = style !== 'compact';
        controls.add_child(this._prev);
        controls.add_child(this._playPause);
        controls.add_child(this._next);

        this._volumeSource = new VolumeSource(audio);
        this.connect('destroy', () => this._volumeSource.destroy());
        // The volume is drawn by the layout: a horizontal slider in list
        // rows, standing up on cards. Compact rows have none.
        this._volume = null;
        this._vvolume = null;
        // Elapsed time, bar and length; compact rows have no sliders. Slim
        // cards and cover-volume list rows have it as a thin line along the
        // bottom edge; the other list layouts draw their own.
        const edge = slim || listLayout === 'cover-volume';
        this._progress = style === 'compact' || ['one-line', 'two-bars'].includes(listLayout)
            ? null : new ProgressBar({edge});
        this._listBars = null;
        this._coverVolume = null;

        if (style === 'cards') {
            this._buildCard(settings.get_string('card-layout'), {text, controls});
        } else if (style === 'list') {
            this._buildListRow(listLayout, {text, controls});
        } else {
            this.add_child(this._art);
            this.add_child(text);
            this.add_child(this._pin);
            this.add_child(controls);
            this.add_child(this._dismiss);
        }

        player.connectObject(
            'changed', () => this._sync(),
            'closed', () => this.destroy(),
            this);
        if (style !== 'compact')
            audio.connectObject('changed', () => this._syncVolume(), this);
        settings.connectObject(
            'changed::media-keys-target', () => this._syncPin(),
            'changed::media-keys-pinned', () => this._syncPin(),
            'changed::design', () => this._restyle(),
            'changed::design-color', () => this._restyle(),
            'changed::design-opacity', () => this._restyle(),
            'changed::animations', () => this._restyle(),
            this);
        this._art.connect('palette-changed', () => {
            this._restyle();
            this.emit('palette-changed');
        });
        // Painted cards can't use the theme's hover color. (Leaving the
        // screen also ends the hover.)
        this.connect('notify::active', () => {
            if (this.get_stage())
                this._restyle();
        });
        this._progress?.bindPlayer(player);
        this._sync();
        this._syncPin();
    }

    /**
     * Lays out a card. standing-volume: cover and text, the progress and
     * the controls under them, the volume standing on the right.
     * side-volume: a small standing volume left of the cover, the progress
     * and the controls in one row below. slim: one row with a slide-out
     * volume, the progress as a line along the bottom edge. cover-volume:
     * scroll on the cover for the volume, progress and controls below.
     */
    _buildCard(layout, {text, controls}) {
        const volumeStyle = this._settings.get_string('card-volume-style');
        const top = new St.BoxLayout({style_class: 'earful-card-top'});
        const column = new St.BoxLayout({...VERTICAL, x_expand: true});
        let content = column;

        if (layout === 'cover-volume') {
            // Scroll on the cover for the volume; the progress row is free.
            this._coverVolume = new CoverVolume(this._art, this._volumeSource, {
                animation: this._settings.get_string('cover-volume-animation'),
                size: COVER_SIZES.cards,
            });
            top.add_child(this._coverVolume);
            top.add_child(text);
            top.add_child(this._pin);
            top.add_child(this._dismiss);
            const bottom = new St.BoxLayout({style_class: 'earful-card-bottom'});
            this._progress.y_align = Clutter.ActorAlign.CENTER;
            bottom.add_child(this._progress);
            controls.x_align = Clutter.ActorAlign.END;
            const syncControls = () => (controls.x_expand = !this._progress.visible);
            this._progress.connect('notify::visible', syncControls);
            syncControls();
            bottom.add_child(controls);
            column.add_child(top);
            column.add_child(bottom);
        } else if (layout === 'slim') {
            // One row; previous is left out to give the title room.
            this._prev.visible = false;
            this._volume = new VolumeSlider(this._volumeSource, {slide: true});
            this._volume.y_align = Clutter.ActorAlign.CENTER;
            top.add_child(this._art);
            top.add_child(text);
            top.add_child(this._volume);
            top.add_child(controls);
            top.add_child(this._pin);
            top.add_child(this._dismiss);
            column.add_child(top);
            column.add_child(this._progress);
            column.add_style_class_name('earful-card-slim');
            // The edge line grows and shows the times while the card is hovered.
            this.connect('notify::active', () => this._progress.setExpanded(this.active));
        } else if (layout === 'side-volume') {
            this._vvolume = new VerticalVolume(this._volumeSource,
                {style: volumeStyle, compact: true});
            top.add_child(this._vvolume);
            top.add_child(this._art);
            top.add_child(text);
            top.add_child(this._pin);
            top.add_child(this._dismiss);
            const bottom = new St.BoxLayout({style_class: 'earful-card-bottom'});
            this._progress.y_align = Clutter.ActorAlign.CENTER;
            bottom.add_child(this._progress);
            // Without a bar (no length) the controls still sit on the right.
            controls.x_align = Clutter.ActorAlign.END;
            const syncControls = () => (controls.x_expand = !this._progress.visible);
            this._progress.connect('notify::visible', syncControls);
            syncControls();
            bottom.add_child(controls);
            column.add_child(top);
            column.add_child(bottom);
        } else {
            top.add_child(this._art);
            top.add_child(text);
            top.add_child(this._pin);
            top.add_child(this._dismiss);
            controls.x_align = Clutter.ActorAlign.CENTER;
            controls.add_style_class_name('earful-card-controls');
            column.add_child(top);
            column.add_child(this._progress);
            column.add_child(controls);
            this._vvolume = new VerticalVolume(this._volumeSource, {style: volumeStyle});
            content = new St.BoxLayout({style_class: 'earful-card-row', x_expand: true});
            content.add_child(column);
            content.add_child(this._vvolume);
        }

        // The design's scene lies under the content, edge to edge.
        content.add_style_class_name('earful-card-content');
        this._scene = new SceneLayer(CARD_RADIUS);
        const stack = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
        });
        stack.add_child(this._scene);
        stack.add_child(content);
        this.add_child(stack);
    }

    /**
     * Lays out a list row. cover-volume: scroll on the cover for the volume,
     * the progress as a line along the bottom. one-line: the line under the
     * text is the progress and turns into the volume from the speaker.
     * two-bars: progress and volume side by side under the text.
     */
    _buildListRow(layout, {text, controls}) {
        let art = this._art;
        if (layout === 'one-line') {
            this._listBars = new SwapLine(this._volumeSource);
        } else if (layout === 'two-bars') {
            this._listBars = new DuoBars(this._volumeSource,
                {order: this._settings.get_string('list-bars-order')});
        } else {
            this._coverVolume = new CoverVolume(this._art, this._volumeSource, {
                animation: this._settings.get_string('cover-volume-animation'),
                size: COVER_SIZES.list,
            });
            art = this._coverVolume;
        }
        if (this._listBars) {
            this._listBars.bindPlayer(this.player);
            text.add_child(this._listBars);
        }

        const row = new St.BoxLayout({style_class: 'earful-list-row', x_expand: true});
        row.add_child(art);
        row.add_child(text);
        row.add_child(this._pin);
        row.add_child(controls);
        row.add_child(this._dismiss);
        if (!this._progress) {
            this.add_child(row);
            return;
        }
        const column = new St.BoxLayout({...VERTICAL, x_expand: true});
        column.add_child(row);
        column.add_child(this._progress);
        // The edge line grows and shows the times while the row is hovered.
        this.connect('notify::active', () => this._progress.setExpanded(this.active));
        this.add_child(column);
    }

    /** Called once a second while the menu is open. */
    tick() {
        this._progress?.tick();
        this._listBars?.tick();
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
            this._volume?.setSliderStyle(Look.sliderStyle(look, palette));
            this._progress.setSliderStyle(Look.sliderStyle(look, palette));
            this._vvolume?.setAccent(Look.accentColor(look, palette));
            this._vvolume?.setPlaying(this.player.isPlaying);
            this._scene.update(look, palette, this.player.isPlaying);
        }
        // On the system theme there is no design accent; the cover's own works.
        this._coverVolume?.setAccent(Look.accentColor(look, palette) ??
            (palette ? `rgb(${palette.accent.join(', ')})` : null));
        this._coverVolume?.setPlaying(this.player.isPlaying);
        this._source?.update(this.player, look.animate, Look.accentColor(look, palette));
    }

    _syncVolume() {
        // The player's own volume if it has one, else its mixer streams.
        if (this.player.volume !== null)
            this._volumeSource.bindPlayer(this.player);
        else
            this._volumeSource.bindStreams(this._audio.streamsFor(this.player));
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
        this._dismiss.visible = !p.isPlaying;
        // Back on the list when it plays again, even while the menu is open.
        this.visible = !p.dismissed;
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

    /** Colors of the shown cover, or null. */
    get coverPalette() {
        return this._art.palette;
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
            ...VERTICAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'earful-text',
        });
        // "mpv" above "My Trip" when the app says what it plays.
        this._source = new St.Label({style_class: 'earful-source'});
        this._name = new St.Label({style_class: 'earful-title'});
        this._volumeSource = new VolumeSource(audio);
        this._volume = new VolumeSlider(this._volumeSource);
        this.connect('destroy', () => this._volumeSource.destroy());
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
        this._volumeSource.bindStreams(entry.streams);
    }

    activate(event) {
        this._entry.app?.activate();
        super.activate(event);
    }
});

export const EarfulIndicator = GObject.registerClass(
class EarfulIndicator extends PanelMenu.Button {
    _init(extension, settings, manager, audio) {
        super._init(0.5, 'Earful');

        this._extension = extension;
        this._settings = settings;
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

        // Players scroll when there are more than fit on the screen; the
        // rest of the menu stays in place below them.
        this._section = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._section);
        this.menu.box.remove_child(this._section.actor);
        this._scroll = new St.ScrollView({
            style_class: 'earful-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            clip_to_allocation: true,
            child: this._section.actor,
        });
        // Lets the menu find the section's items (keyboard, emptiness).
        this._scroll._delegate = this._section;
        this.menu.box.insert_child_at_index(this._scroll, 0);
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
        this._focusSwitch.connect('toggled', (item, state) => this._save('focus-mode', state));
        this.menu.addMenuItem(this._focusSwitch);
        this._labelSwitch = new PopupMenu.PopupSwitchMenuItem(
            _('Show track in top bar'), this._settings.get_boolean('show-panel-label'));
        this._labelSwitch.connect('toggled', (item, state) => this._save('show-panel-label', state));
        this.menu.addMenuItem(this._labelSwitch);
        this.menu.addAction(_('Settings'), () => openSettings(extension));

        this._settings.connectObject(
            'changed::focus-mode', () => this._focusSwitch.setToggleState(
                this._settings.get_boolean('focus-mode')),
            'changed::show-panel-label', () => {
                this._labelSwitch.setToggleState(
                    this._settings.get_boolean('show-panel-label'));
                this._syncPanel();
            },
            'changed::panel-label-max-chars', () => this._syncPanel(),
            'changed::hide-when-idle', () => this._syncPanel(),
            'changed::show-audio-only-apps', () => this._syncOthers(),
            'changed::menu-style', () => this._queueRebuild(),
            'changed::card-layout', () => this._queueRebuild(),
            'changed::card-volume-style', () => this._queueRebuild(),
            'changed::cover-volume-animation', () => this._queueRebuild(),
            'changed::list-layout', () => this._queueRebuild(),
            'changed::list-bars-order', () => this._queueRebuild(),
            'changed::menu-background', () => this._syncBackground(),
            'changed::design', () => this._syncBackground(),
            'changed::design-color', () => this._syncBackground(),
            'changed::design-opacity', () => this._syncBackground(),
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
            if (open)
                this._fitToScreen();
            this._syncClock(open);
        }, this);

        this._rebuild();
        this._syncOthers();
    }

    get earfulIcon() {
        return this._icon.gicon;
    }

    _watchPlayer(player) {
        // Rebuild when a player joins or leaves the list, otherwise items
        // update themselves and only the panel label needs syncing.
        const listed = () => player.hasTrack && !player.dismissed;
        let wasListed = listed();
        player.connectObject('changed', () => {
            if (listed() !== wasListed) {
                wasListed = listed();
                this._queueRebuild();
            } else {
                this._syncPanel();
                // Another player may have become the current one.
                this._syncBackground();
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
        for (const player of players) {
            const item = new PlayerItem(player, this._audio, this._settings, style);
            item.connect('palette-changed', () => this._syncBackground());
            item.connect('key-focus-in',
                () => ensureActorVisibleInScrollView(this._scroll, item));
            this._section.addMenuItem(item);
        }

        if (players.length === 0) {
            const empty = new PopupMenu.PopupMenuItem(_('Nothing is playing'),
                {reactive: false});
            empty.add_style_class_name('earful-empty');
            this._section.addMenuItem(empty);
        }

        this._syncPanel();
        this._syncBackground();
    }

    /** Limits the player list to what fits under the top bar. */
    _fitToScreen() {
        const monitor = Main.layoutManager.findIndexForActor(this);
        const workArea = Main.layoutManager.getWorkAreaForMonitor(monitor);
        const scale = scaleFactor();
        const [, menuHeight] = this.menu.box.get_preferred_height(-1);
        const [, listHeight] = this._scroll.get_preferred_height(-1);
        // Room for the rest of the menu and its margins.
        const room = workArea.height - (menuHeight - listHeight) - 40 * scale;
        this._scroll.style = `max-height: ${Math.max(160, Math.floor(room / scale))}px;`;
        // Each time the menu opens, start with what plays now.
        this._scroll.vadjustment.value = 0;
    }

    /** Paints the menu box itself, e.g. in the current song's colors. */
    _syncBackground() {
        // The current song's colors, or the next one that has a cover.
        const current = this._manager.current;
        const items = this._section._getMenuItems().filter(i => i instanceof PlayerItem);
        const item = items.find(i => i.player === current && i.coverPalette) ??
            items.find(i => i.coverPalette);
        const look = Look.lookFromSettings(this._settings);
        const {style, painted} = Look.menuStyle(
            this._settings.get_string('menu-background'), look, item?.coverPalette ?? null);
        if (this.menu.box.style !== style)
            this.menu.box.style = style;
        if (painted)
            this.menu.box.add_style_class_name('earful-menu-painted');
        else
            this.menu.box.remove_style_class_name('earful-menu-painted');
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

    // Since GNOME 47 setToggleState() also emits 'toggled'; only write real changes.
    _save(key, state) {
        if (this._settings.get_boolean(key) !== state)
            this._settings.set_boolean(key, state);
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

    /** Progress bars move once a second, only while the menu is open. */
    _syncClock(open) {
        if (open && !this._clockId) {
            for (const player of this._manager.players)
                player.refreshPosition();
            this._clockTicks = 0;
            this._clockId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
                // Ask again every 5 s, for players that jump without saying so.
                if (++this._clockTicks % 5 === 0) {
                    for (const player of this._manager.players)
                        player.refreshPosition();
                }
                for (const item of this._section._getMenuItems()) {
                    if (item instanceof PlayerItem)
                        item.tick();
                }
                return GLib.SOURCE_CONTINUE;
            });
        } else if (!open && this._clockId) {
            GLib.source_remove(this._clockId);
            this._clockId = 0;
        }
    }

    destroy() {
        if (this._rebuildId)
            GLib.source_remove(this._rebuildId);
        this._syncClock(false);
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
