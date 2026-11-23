// SPDX-License-Identifier: GPL-3.0-or-later
// "Now playing" popups: one per track change, stacked, slowly fading away.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Graphene from 'gi://Graphene';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {CoverArt} from './art.js';
import {ExamplePlayer} from './example.js';
import * as Look from './look.js';
import {SceneLayer} from './scenes.js';
import {PlayerControls, SourceLine, VERTICAL, scaleFactor} from './widgets.js';

// Each popup style: its width and cover side, in logical pixels.
const STYLES = {
    hover: {width: 380, cover: 72},
    current: {width: 380, cover: 72},
    countdown: {width: 380, cover: 72},
    mini: {width: 330, cover: 36, round: true},
    island: {width: 270, expandedWidth: 400, cover: 30, round: true},
    big: {width: 250, cover: 228, coverRadius: 14},
};
// The scenes (vinyl, road…) are drawn for the wide popup; the other styles
// take only the design's colors.
const WIDE_STYLES = ['hover', 'current', 'countdown'];
// Must match .earful-toast-surface in stylesheet.css (minus the border).
const RADIUS = 19;
const MARGIN = 16;
const SPACING = 10;
const SLIDE_IN_MS = 250;
const MOVE_MS = 350;
const FADE_OUT_MS = 900;
const HOVER_GRACE_MS = 1500;
const HOVER_FADE_MS = 160;
const SWAP_MS = 350;
// How long a new popup waits for its cover, so it comes in in its colors.
const COVER_WAIT_MS = 400;

const Toast = GObject.registerClass({
    Signals: {'close-clicked': {}, 'resized': {}},
}, class Toast extends St.Button {
    _init(player, settings) {
        const name = settings.get_string('popup-style');
        const styleName = Object.hasOwn(STYLES, name) ? name : 'hover';
        const style = STYLES[styleName];
        super._init({
            style_class: `earful-toast earful-toast-${styleName}`,
            width: style.width * scaleFactor(),
            opacity: 0,
        });
        this.player = player;
        this.styleName = styleName;
        /** Island only: grown on hover to show the artist and the buttons. */
        this.expanded = false;
        this.dismissing = false;
        this.placed = false;
        this._style = style;
        this._settings = settings;
        this._timeoutId = 0;
        this._onTimeout = null;
        this._lineTimeline = null;
        this._trackKey = null;
        this.connect('destroy', () => this.stopTimer());

        this._surface = new St.Widget({
            style_class: 'earful-toast-surface',
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
        });
        // The design's scene lies under the content, edge to edge.
        this._scene = null;
        if (WIDE_STYLES.includes(styleName)) {
            this._scene = new SceneLayer(RADIUS);
            this._surface.add_child(this._scene);
        }
        this._art = new CoverArt(style.cover,
            {radius: style.round ? style.cover / 2 : style.coverRadius});
        this._source = null;
        this._title = new St.Label({style_class: 'earful-toast-title'});
        this._artist = new St.Label({style_class: 'earful-toast-artist'});
        this._text = null;
        this._controls = null;
        this._strip = null;
        this._line = null;

        // Closes the popup without raising the player, as a click would.
        this._close = new St.Button({
            style_class: 'earful-toast-close',
            can_focus: true,
            accessible_name: _('Close'),
            child: new St.Icon({icon_name: 'window-close-symbolic'}),
        });
        this._close.connect('clicked', () => this.emit('close-clicked'));

        if (styleName === 'mini' || styleName === 'island')
            this._buildPill();
        else if (styleName === 'big')
            this._buildBig();
        else
            this._buildWide();
        this.set_child(this._surface);

        // A popup shows what its player plays now: Next pressed in it, or
        // in the player, swaps the track in place.
        player.connectObject('changed', () => {
            if (this.dismissing)
                return;
            if (player.hasTrack)
                this.showTrack();
            else
                this._restyle();
            this._controls?.sync();
        }, this);
        this._art.connect('palette-changed', () => this._restyle());
        // Leaving the screen also ends the hover.
        this.connect('notify::hover', () => {
            if (!this.get_stage() || this.dismissing)
                return;
            this._restyle();
            this._syncHover();
        });
        settings.connectObject(
            'changed::popup-design', () => this._restyle(),
            'changed::popup-design-color', () => this._restyle(),
            'changed::popup-design-opacity', () => this._restyle(),
            'changed::animations', () => this._restyle(),
            'changed::toast-shadow', () => this._syncShadow(),
            this);

        // Until the first cover is shown the colors change at once: a new
        // popup comes in in its colors instead of fading into them.
        this._settled = false;
        this._syncShadow();
        this.showTrack();
        /** Settles when the first cover is shown. */
        this.ready = this._art.setPlayer(player).then(() => (this._settled = true));
    }

    // Cover, source line, title and artist, with ✕ in the corner.
    _buildWide() {
        // A button centers its child; the content starts at the left.
        const box = new St.BoxLayout({
            style_class: 'earful-toast-box',
            x_expand: true,
            x_align: Clutter.ActorAlign.FILL,
        });
        box.add_child(this._art);
        box.add_child(this._textColumn(true));
        this._surface.add_child(box);

        if (this.styleName === 'countdown') {
            this._controls = new PlayerControls(this.player,
                {styleClass: 'earful-toast-controls earful-toast-next', previous: false});
            box.add_child(this._controls);
            // How long the popup stays: shrinks to nothing, stops on hover.
            this._line = new St.Widget({
                style_class: 'earful-toast-line',
                x_expand: true,
                y_expand: true,
                x_align: Clutter.ActorAlign.FILL,
                y_align: Clutter.ActorAlign.END,
                pivot_point: new Graphene.Point({x: 0, y: 0.5}),
            });
            this._surface.add_child(this._line);
        } else if (this.styleName === 'hover') {
            // Fades in at the right end, over the end of the text.
            this._controls = new PlayerControls(this.player,
                {styleClass: 'earful-toast-buttons'});
            this._stripEnd = new St.BoxLayout({
                style_class: 'earful-toast-strip-end',
                y_expand: true,
            });
            this._stripEnd.add_child(this._controls);
            this._stripFade = new St.Widget({
                style_class: 'earful-toast-strip-fade',
                y_expand: true,
            });
            this._strip = new St.BoxLayout({
                style_class: 'earful-toast-controls',
                x_expand: true,
                y_expand: true,
                x_align: Clutter.ActorAlign.END,
                y_align: Clutter.ActorAlign.FILL,
                opacity: 0,
            });
            this._strip.add_child(this._stripFade);
            this._strip.add_child(this._stripEnd);
            this._surface.add_child(this._strip);
        }

        Object.assign(this._close, {
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.START,
        });
        this._surface.add_child(this._close);
    }

    // One row in a pill: cover, text, buttons and ✕.
    _buildPill() {
        const box = new St.BoxLayout({
            style_class: 'earful-toast-box',
            x_expand: true,
            x_align: Clutter.ActorAlign.FILL,
        });
        box.add_child(this._art);
        if (this.styleName === 'island') {
            box.add_child(this._textColumn(false));
            this._controls = new PlayerControls(this.player,
                {styleClass: 'earful-toast-controls'});
            this._controls.visible = false;
        } else {
            // "Title · Artist" on one line.
            this._title.x_expand = true;
            this._title.y_align = Clutter.ActorAlign.CENTER;
            this._text = this._title;
            box.add_child(this._title);
            this._controls = new PlayerControls(this.player,
                {styleClass: 'earful-toast-controls', previous: false});
        }
        box.add_child(this._controls);
        this._close.y_align = Clutter.ActorAlign.CENTER;
        this._close.add_style_class_name('earful-toast-close-inline');
        box.add_child(this._close);
        this._surface.add_child(box);
    }

    // A column: the big cover, the text and the buttons, with ✕ on the cover.
    _buildBig() {
        const column = new St.BoxLayout({
            ...VERTICAL,
            style_class: 'earful-toast-box',
            x_expand: true,
        });
        this._art.x_align = Clutter.ActorAlign.CENTER;
        column.add_child(this._art);
        column.add_child(this._textColumn(true));
        this._controls = new PlayerControls(this.player,
            {styleClass: 'earful-toast-controls'});
        this._controls.x_align = Clutter.ActorAlign.START;
        column.add_child(this._controls);
        this._surface.add_child(column);

        Object.assign(this._close, {
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.START,
        });
        this._close.add_style_class_name('earful-toast-close-cover');
        this._surface.add_child(this._close);
    }

    _textColumn(withSource) {
        const text = new St.BoxLayout({
            ...VERTICAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'earful-toast-text',
        });
        if (withSource) {
            this._source = new SourceLine('earful-toast-source');
            text.add_child(this._source);
        }
        text.add_child(this._title);
        text.add_child(this._artist);
        this._text = text;
        return text;
    }

    /** Width the popup should have now, in physical pixels. */
    get layoutWidth() {
        const style = this._style;
        return (this.expanded ? style.expandedWidth : style.width) * scaleFactor();
    }

    _syncShadow() {
        if (this._settings.get_boolean('toast-shadow'))
            this.remove_style_class_name('earful-toast-flat');
        else
            this.add_style_class_name('earful-toast-flat');
    }

    _syncHover() {
        if (this._strip) {
            this._strip.ease({
                opacity: this.hover ? 255 : 0,
                duration: HOVER_FADE_MS,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        } else if (this.styleName === 'island' && this.expanded !== this.hover) {
            this.expanded = this.hover;
            this._syncArtist();
            this._controls.visible = this.expanded;
            this.emit('resized');
        }
    }

    _syncArtist() {
        const island = this.styleName === 'island';
        this._artist.visible = this._artist.text !== '' && (!island || this.expanded);
    }

    _durationMs() {
        return this._settings.get_int('toast-duration') * 1000;
    }

    /** Calls onTimeout after ms, replacing a running timer. */
    startTimer(ms, onTimeout) {
        this.stopTimer();
        this._onTimeout = onTimeout;
        this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._timeoutId = 0;
            onTimeout();
            return GLib.SOURCE_REMOVE;
        });
        this._runLine(ms);
    }

    stopTimer() {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }
        this._stopLine();
    }

    /**
     * How long to stay once the pointer leaves: the rest of the countdown
     * line, or a short grace.
     */
    resumeMs(grace) {
        if (!this._line)
            return grace;
        return Math.max(grace, Math.round(this._line.scale_x * this._durationMs()));
    }

    // The line runs from where it is to nothing in ms. Not an ease: it
    // tells the time, so it moves even with animations off. The timeline
    // only wakes it up each frame; the clock is the real one, like the
    // timer's (a timeline's own time can run fast without a real screen).
    _runLine(ms) {
        if (!this._line)
            return;
        this._stopLine();
        const from = this._line.scale_x;
        const start = GLib.get_monotonic_time();
        const timeline = new Clutter.Timeline({actor: this._line, duration: 1000, repeat_count: -1});
        timeline.connect('new-frame', () => {
            const done = Math.min(1, (GLib.get_monotonic_time() - start) / 1000 / Math.max(1, ms));
            this._line.scale_x = from * (1 - done);
            if (done >= 1)
                this._stopLine();
        });
        this._lineTimeline = timeline;
        // A timeline gets frames only once its actor is on screen.
        if (this._line.mapped)
            timeline.start();
        else
            this._line.connectObject('notify::mapped', () => this._startLine(), this);
    }

    _startLine() {
        if (!this._line.mapped)
            return;
        this._line.disconnectObject(this);
        this._lineTimeline?.start();
    }

    _stopLine() {
        this._line?.disconnectObject(this);
        this._lineTimeline?.stop();
        this._lineTimeline = null;
    }

    _restyle() {
        // A popup fading out is left as it is: changing it would ask for a
        // new layout of a widget about to be removed.
        if (this.dismissing)
            return;
        const look = Look.lookFromSettings(this._settings, 'popup-');
        const palette = this._art.palette;
        // The island is always black (stylesheet.css).
        if (this.styleName !== 'island') {
            const style = Look.surfaceStyle(look, palette, this.hover);
            this._surface.style = this._settled || !style ? style : `${style} transition-duration: 0ms;`;
        }
        this._scene?.update(look, palette, this.player.isPlaying);
        this._source?.update(this.player, look.animate, Look.accentColor(look, palette));
        if (this._strip) {
            // The buttons' strip fades into the popup's end color; without
            // a design the stylesheet's colors match the plain popup.
            const edge = Look.edgeColors(look, palette, this.hover);
            this._stripFade.style = edge
                ? `background-gradient-start: ${edge.clear}; background-gradient-end: ${edge.solid};`
                : '';
            this._stripEnd.style = edge ? `background-color: ${edge.solid};` : '';
        }
    }

    /** Shows the player's track; a new one swaps in with a little lift. */
    showTrack() {
        const p = this.player;
        const isNew = p.trackKey !== this._trackKey;
        if (isNew && this._trackKey !== null)
            this._swap();
        this._trackKey = p.trackKey;
        this._art.setPlayer(p);
        this._restyle();
        if (!isNew)
            return;

        const artist = p.artistText;
        this._title.text = this.styleName === 'mini' && artist
            ? `${p.title} · ${artist}`
            : p.title;
        this._artist.text = artist;
        this._syncArtist();
        if (this._line) {
            // A new track gets the full time again, shown by a full line.
            this._stopLine();
            this._line.scale_x = 1;
            if (this._timeoutId)
                this.startTimer(this._durationMs(), this._onTimeout);
        }
    }

    _swap() {
        for (const actor of [this._art, this._text]) {
            actor.remove_all_transitions();
            actor.opacity = 0;
            actor.translation_y = 6 * scaleFactor();
            actor.ease({
                opacity: 255,
                translation_y: 0,
                duration: SWAP_MS,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }
    }
});

export class ToastManager {
    /**
     * @param {Gio.Settings} settings
     * @param {object} manager the PlayerManager
     * @param {Gio.File} dir the extension's folder, for the example popup
     */
    constructor(settings, manager, dir) {
        this._settings = settings;
        this._toasts = [];
        // Popups cleared at once, waiting to be destroyed.
        this._leaving = new Set();
        this._leavingId = 0;
        this._example = new ExamplePlayer(dir);
        this._notificationSettings = new Gio.Settings({
            schema_id: 'org.gnome.desktop.notifications',
        });

        this._manager = manager;
        manager.connectObject('player-added',
            (m, player) => this._watchPlayer(player), this);

        settings.connectObject(
            'changed::toast-position', () => this._relayout(false),
            // Popups are built for one style; the next track brings the new
            // one, and an example on screen comes back in it right away.
            'changed::popup-style', () => {
                const example = this._shown(this._example);
                this._dismissAll();
                if (example)
                    this._showExample();
            },
            'changed::show-example-popup', () => this._showExample(),
            'changed::focus-mode', () => {
                if (settings.get_boolean('focus-mode'))
                    this._dismissAll();
            },
            this);
        Main.layoutManager.connectObject('monitors-changed',
            () => this._dismissAll(), this);
    }

    _watchPlayer(player) {
        player.connectObject(
            'track-changed', () => this._onTrackChanged(player),
            'closed', () => {
                // A popup of a closed player would relaunch the app on click.
                player.disconnectObject(this);
                for (const toast of this._toasts.filter(t => t.player === player))
                    this._dismiss(toast, SLIDE_IN_MS);
            },
            this);
    }

    _shouldShow(player) {
        const s = this._settings;
        if (!s.get_boolean('toasts-enabled') || s.get_boolean('focus-mode'))
            return false;
        if (this._manager.isShadowed(player))
            return false;
        if (s.get_strv('toast-muted-apps').includes(player.appKey))
            return false;
        if (s.get_boolean('toast-respect-dnd') &&
            !this._notificationSettings.get_boolean('show-banners'))
            return false;

        const monitor = Main.layoutManager.monitors[this._targetMonitor()];
        if (s.get_boolean('toast-hide-in-fullscreen') && monitor?.inFullscreen)
            return false;

        if (s.get_boolean('toast-hide-when-app-focused') && player.app) {
            const focused = global.display.focus_window;
            const tracker = Shell.WindowTracker.get_default();
            if (focused && tracker.get_window_app(focused) === player.app)
                return false;
        }
        return true;
    }

    _targetMonitor() {
        // Keep a stack on one monitor; a new stack follows the pointer.
        if (this._toasts.length > 0)
            return this._monitor;
        return global.display.get_current_monitor();
    }

    _onTrackChanged(player) {
        const show = this._shouldShow(player);

        // The same player skipping again updates its popup instead of
        // stacking another one; it gets more time only if it may show.
        const existing = this._shown(player);
        if (existing) {
            existing.showTrack();
            if (show && !existing.hover)
                this._startTimer(existing);
            this._relayout(true);
            return;
        }
        if (show)
            this._add(player);
    }

    /** The player's popup on screen, if any. */
    _shown(player) {
        return this._toasts.find(t => t.player === player && !t.dismissing);
    }

    /**
     * Settings asked to see an example: it shows whatever the quiet rules
     * say, and asking again while it's shown skips to the next example.
     */
    _showExample() {
        const shown = this._shown(this._example);
        if (!shown) {
            this._add(this._example);
            return;
        }
        // The popup follows its player to the next track.
        this._example.next();
        if (!shown.hover)
            this._startTimer(shown);
        this._relayout(true);
    }

    _add(player) {
        this._monitor = this._targetMonitor();

        const toast = new Toast(player, this._settings);
        toast.connect('clicked', () => {
            player.raise();
            this._dismiss(toast, SLIDE_IN_MS);
        });
        toast.connect('close-clicked', () => this._dismiss(toast, SLIDE_IN_MS));
        toast.connect('notify::hover', () => {
            if (toast.dismissing)
                return;
            if (toast.hover)
                toast.stopTimer();
            else
                this._startTimer(toast, toast.resumeMs(HOVER_GRACE_MS));
        });
        toast.connect('resized', () => this._relayout(true));

        // Like notification banners: above windows, below modal dialogs,
        // the on-screen keyboard and the screenshot UI.
        Main.layoutManager.addChrome(toast);
        this._toasts.push(toast);

        const max = this._settings.get_int('toast-max-visible');
        const visible = this._toasts.filter(t => !t.dismissing);
        for (const old of visible.slice(0, Math.max(0, visible.length - max)))
            this._dismiss(old, SLIDE_IN_MS);

        this._relayout(true);

        const fromRight = this._settings.get_string('toast-position').endsWith('right');
        toast.translation_x = (fromRight ? 40 : -40) * scaleFactor();
        // It slides in once its cover is there (or after a moment), so it
        // doesn't come in plain and change colors on the way.
        let waitId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, COVER_WAIT_MS, () => {
            waitId = 0;
            this._slideIn(toast);
            return GLib.SOURCE_REMOVE;
        });
        toast.connect('destroy', () => {
            if (waitId)
                GLib.source_remove(waitId);
            waitId = 0;
        });
        toast.ready.then(() => {
            if (!waitId)
                return;
            GLib.source_remove(waitId);
            waitId = 0;
            this._slideIn(toast);
        });
    }

    _slideIn(toast) {
        if (toast.dismissing)
            return;
        toast.ease({
            opacity: 255,
            translation_x: 0,
            duration: SLIDE_IN_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
        this._startTimer(toast);
    }

    _startTimer(toast, ms = this._settings.get_int('toast-duration') * 1000) {
        toast.startTimer(ms, () => this._dismiss(toast, FADE_OUT_MS));
    }

    _dismiss(toast, duration) {
        if (toast.dismissing)
            return;
        toast.dismissing = true;
        toast.reactive = false;
        // Drop the hover now, or losing it on removal would restyle it.
        toast.track_hover = false;
        toast.stopTimer();

        toast.ease({
            opacity: 0,
            duration,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onComplete: () => this._remove(toast),
        });
    }

    _remove(toast) {
        const index = this._toasts.indexOf(toast);
        if (index === -1)
            return;
        this._toasts.splice(index, 1);
        // Destroying also drops it from the layout manager. Calling
        // removeChrome() first would queue one last layout for it, which
        // GNOME 48 then runs after it is gone.
        toast.destroy();
        // Remaining popups glide into the freed space.
        this._relayout(true);
    }

    /**
     * Clears every popup at once. They are hidden now and destroyed a
     * moment later: one that has just appeared still waits for its first
     * layout, which the shell would otherwise run on a removed actor.
     */
    _dismissAll() {
        for (const toast of this._toasts) {
            toast.dismissing = true;
            toast.track_hover = false;
            toast.stopTimer();
            toast.hide();
            this._leaving.add(toast);
        }
        this._toasts = [];
        if (this._leaving.size > 0 && !this._leavingId) {
            this._leavingId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SLIDE_IN_MS, () => {
                this._leavingId = 0;
                this._destroyLeaving();
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _destroyLeaving() {
        for (const toast of this._leaving)
            toast.destroy();
        this._leaving.clear();
    }

    _relayout(animate) {
        if (this._toasts.length === 0)
            return;

        const workArea = Main.layoutManager.getWorkAreaForMonitor(this._monitor);
        const scale = scaleFactor();
        const margin = MARGIN * scale;
        const spacing = SPACING * scale;
        const [vertical, horizontal] =
            this._settings.get_string('toast-position').split('-');

        // Oldest popup sits closest to the screen edge, newer ones line up
        // behind it, and move up when the ones before them fade out. A
        // popup that grows (the island) grows away from the screen edge.
        let offset = margin;
        for (const toast of this._toasts) {
            const width = toast.layoutWidth;
            let x;
            if (horizontal === 'left')
                x = workArea.x + margin;
            else if (horizontal === 'right')
                x = workArea.x + workArea.width - width - margin;
            else
                x = workArea.x + Math.round((workArea.width - width) / 2);
            const [, height] = toast.get_preferred_height(width);
            const y = vertical === 'top'
                ? workArea.y + offset
                : workArea.y + workArea.height - offset - height;
            offset += height + spacing;

            // A popup fading out keeps its place until it is gone.
            if (toast.dismissing)
                continue;
            if (animate && toast.placed) {
                toast.ease({
                    x, y, width,
                    duration: MOVE_MS,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
            } else {
                toast.set_position(x, y);
                toast.width = width;
                toast.placed = true;
            }
        }
    }

    destroy() {
        this._dismissAll();
        if (this._leavingId)
            GLib.source_remove(this._leavingId);
        this._leavingId = 0;
        this._destroyLeaving();
        this._settings.disconnectObject(this);
        this._manager.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        for (const player of this._manager.allPlayers)
            player.disconnectObject(this);
    }
}
