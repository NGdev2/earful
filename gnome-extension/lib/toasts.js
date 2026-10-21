// "Now playing" popups: one per track change, stacked, slowly fading away.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const WIDTH = 340;
const MARGIN = 16;
const SPACING = 10;
const SLIDE_IN_MS = 250;
const MOVE_MS = 350;
const FADE_OUT_MS = 900;
const HOVER_GRACE_MS = 1500;

function scaleFactor() {
    return St.ThemeContext.get_for_stage(global.stage).scale_factor;
}

const Toast = GObject.registerClass(
class Toast extends St.Button {
    _init(player) {
        super._init({
            style_class: 'earful-toast',
            width: WIDTH * scaleFactor(),
            opacity: 0,
        });
        this.player = player;

        const box = new St.BoxLayout({style_class: 'earful-toast-box'});
        this._art = new St.Icon({
            style_class: 'earful-toast-art',
            y_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(this._art);

        const text = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._source = new St.Label({style_class: 'earful-toast-source'});
        this._title = new St.Label({style_class: 'earful-toast-title'});
        this._artist = new St.Label({style_class: 'earful-toast-artist'});
        text.add_child(this._source);
        text.add_child(this._title);
        text.add_child(this._artist);
        box.add_child(text);
        this.set_child(box);

        // Cover art often arrives a moment after the title; keep it fresh
        // as long as the same track is shown.
        player.connectObject('changed', () => {
            if (player.trackKey === this._trackKey)
                this._art.gicon = player.artIcon;
        }, this);

        this.showTrack();
    }

    showTrack() {
        const p = this.player;
        this._trackKey = p.trackKey;
        this._art.gicon = p.artIcon;
        this._source.text = p.sourceName;
        this._title.text = p.title;
        this._artist.text = p.artistText;
        this._artist.visible = this._artist.text !== '';
    }

});

export class ToastManager {
    constructor(settings, manager) {
        this._settings = settings;
        this._toasts = [];
        this._notificationSettings = new Gio.Settings({
            schema_id: 'org.gnome.desktop.notifications',
        });

        this._manager = manager;
        manager.connectObject('player-added',
            (m, player) => this._watchPlayer(player), this);

        settings.connectObject(
            'changed::toast-position', () => this._relayout(false),
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
        if (!this._shouldShow(player))
            return;

        // The same player skipping again updates its popup instead of
        // stacking another one.
        const existing = this._toasts.find(t => t.player === player && !t.dismissing);
        if (existing) {
            existing.showTrack();
            if (!existing.hover)
                this._startTimer(existing);
            this._relayout(true);
            return;
        }

        this._monitor = this._targetMonitor();

        const toast = new Toast(player);
        toast.connect('clicked', () => {
            player.raise();
            this._dismiss(toast, SLIDE_IN_MS);
        });
        toast.connect('notify::hover', () => {
            if (toast.dismissing)
                return;
            if (toast.hover)
                this._stopTimer(toast);
            else
                this._startTimer(toast, HOVER_GRACE_MS);
        });

        // Like notification banners: above windows, below modal dialogs,
        // the on-screen keyboard and the screenshot UI.
        Main.layoutManager.addChrome(toast, {affectsInputRegion: true});
        this._toasts.push(toast);

        const max = this._settings.get_int('toast-max-visible');
        const visible = this._toasts.filter(t => !t.dismissing);
        for (const old of visible.slice(0, Math.max(0, visible.length - max)))
            this._dismiss(old, SLIDE_IN_MS);

        this._relayout(true);

        const fromRight = this._settings.get_string('toast-position').endsWith('right');
        toast.translation_x = (fromRight ? 40 : -40) * scaleFactor();
        toast.ease({
            opacity: 255,
            translation_x: 0,
            duration: SLIDE_IN_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
        this._startTimer(toast);
    }

    _startTimer(toast, ms) {
        this._stopTimer(toast);
        const duration = ms ?? this._settings.get_int('toast-duration') * 1000;
        toast.timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, duration, () => {
            toast.timeoutId = 0;
            this._dismiss(toast, FADE_OUT_MS);
            return GLib.SOURCE_REMOVE;
        });
    }

    _stopTimer(toast) {
        if (toast.timeoutId) {
            GLib.source_remove(toast.timeoutId);
            toast.timeoutId = 0;
        }
    }

    _dismiss(toast, duration) {
        if (toast.dismissing)
            return;
        toast.dismissing = true;
        toast.reactive = false;
        this._stopTimer(toast);

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
        this._stopTimer(toast);
        Main.layoutManager.removeChrome(toast);
        toast.destroy();
        // Remaining popups glide into the freed space.
        this._relayout(true);
    }

    _dismissAll() {
        const toasts = this._toasts;
        this._toasts = [];
        for (const toast of toasts) {
            this._stopTimer(toast);
            toast.destroy();
        }
    }

    _relayout(animate) {
        if (this._toasts.length === 0)
            return;

        const workArea = Main.layoutManager.getWorkAreaForMonitor(this._monitor);
        const scale = scaleFactor();
        const width = WIDTH * scale;
        const margin = MARGIN * scale;
        const spacing = SPACING * scale;
        const [vertical, horizontal] =
            this._settings.get_string('toast-position').split('-');

        let x;
        if (horizontal === 'left')
            x = workArea.x + margin;
        else if (horizontal === 'right')
            x = workArea.x + workArea.width - width - margin;
        else
            x = workArea.x + Math.round((workArea.width - width) / 2);

        // Oldest popup sits closest to the screen edge, newer ones line up
        // behind it, and move up when the ones before them fade out.
        let offset = margin;
        for (const toast of this._toasts) {
            const [, height] = toast.get_preferred_height(width);
            const y = vertical === 'top'
                ? workArea.y + offset
                : workArea.y + workArea.height - offset - height;
            offset += height + spacing;

            if (animate && toast.placed) {
                toast.ease({
                    x, y,
                    duration: MOVE_MS,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
            } else {
                toast.set_position(x, y);
                toast.placed = true;
            }
        }
    }

    destroy() {
        this._dismissAll();
        this._settings.disconnectObject(this);
        this._manager.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        for (const player of this._manager.allPlayers)
            player.disconnectObject(this);
    }
}
