// SPDX-License-Identifier: GPL-3.0-or-later
// Small pieces shared by the menu and the popups.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Graphene from 'gi://Graphene';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

// Constructor properties for a vertical St.BoxLayout. GNOME 48 added
// `orientation` and GNOME 51 removed the older `vertical`.
export const VERTICAL = GObject.Object.find_property.call(St.BoxLayout, 'orientation')
    ? {orientation: Clutter.Orientation.VERTICAL}
    : {vertical: true};

/** The display's scale factor (2 on HiDPI). */
export function scaleFactor() {
    return St.ThemeContext.get_for_stage(global.stage).scale_factor;
}

/** A round icon button, e.g. play or next. */
export function controlButton(iconName, accessibleName, onClick) {
    const button = new St.Button({
        style_class: 'earful-control',
        can_focus: true,
        y_align: Clutter.ActorAlign.CENTER,
        accessible_name: accessibleName,
        child: new St.Icon({icon_name: iconName}),
    });
    button.connect('clicked', onClick);
    return button;
}

/**
 * Previous, play/pause and next for one player. sync() follows the player:
 * the play/pause icon, and dimmed skip buttons the player can't use.
 */
/**
 * A label that asks for the room its text takes in bold, also while it
 * isn't bold: a title that is bold only while its player plays doesn't
 * change the menu's width on pause.
 */
export const SteadyLabel = GObject.registerClass(
class SteadyLabel extends St.Label {
    vfunc_get_preferred_width(forHeight) {
        const [min, natural] = super.vfunc_get_preferred_width(forHeight);
        const text = this.clutter_text;
        if (!text.text || !text.font_name)
            return [min, natural];
        // A layout and font of its own: the text's layout depends on its
        // allocation, which can't be asked for while sizes are worked out.
        const font = Pango.FontDescription.from_string(text.font_name);
        const layout = text.create_pango_layout(text.text);
        layout.set_font_description(font);
        const [plain] = layout.get_pixel_size();
        font.set_weight(Pango.Weight.BOLD);
        layout.set_font_description(font);
        const [wide] = layout.get_pixel_size();
        return [min, natural + Math.max(0, wide - plain)];
    }
});

export const PlayerControls = GObject.registerClass(
class PlayerControls extends St.BoxLayout {
    /**
     * @param {object} player
     * @param {object} [options]
     * @param {string} [options.styleClass]
     * @param {boolean} [options.previous] include previous and play/pause
     *   (without them it's a lone next button)
     */
    _init(player, {styleClass = 'earful-controls', previous = true} = {}) {
        super._init({style_class: styleClass, y_align: Clutter.ActorAlign.CENTER});
        this._player = player;
        if (previous) {
            this.previous = controlButton('media-skip-backward-symbolic',
                _('Previous'), () => player.previous());
            this.playPause = controlButton('media-playback-start-symbolic',
                _('Play'), () => player.playPause());
            this.playPause.add_style_class_name('earful-play');
            this.add_child(this.previous);
            this.add_child(this.playPause);
        }
        this.next = controlButton('media-skip-forward-symbolic',
            _('Next'), () => player.next());
        this.add_child(this.next);
        this.sync();
    }

    sync() {
        const p = this._player;
        if (this.playPause) {
            this.playPause.child.icon_name = p.isPlaying
                ? 'media-playback-pause-symbolic'
                : 'media-playback-start-symbolic';
            this.playPause.accessible_name = p.isPlaying ? _('Pause') : _('Play');
        }
        if (this.previous) {
            this.previous.reactive = p.canGoPrevious;
            this.previous.opacity = p.canGoPrevious ? 255 : 100;
        }
        this.next.reactive = p.canGoNext;
        this.next.opacity = p.canGoNext ? 255 : 100;
    }
});

const BARS = 3;
// Heights the bars rest at between dances.
const STILL = [0.55, 1, 0.75];

/** Three little bars that dance while a player plays. */
export const Equalizer = GObject.registerClass(
class Equalizer extends St.BoxLayout {
    _init() {
        super._init({
            style_class: 'earful-eq',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        this._bars = [];
        for (let i = 0; i < BARS; i++) {
            const bar = new St.Widget({
                style_class: 'earful-eq-bar',
                y_align: Clutter.ActorAlign.END,
                // Bars grow up from the bottom.
                pivot_point: new Graphene.Point({x: 0.5, y: 1}),
            });
            this._bars.push(bar);
            this.add_child(bar);
        }
        this._playing = false;
        this._animate = true;
        this._dancing = new Set();

        // Dance only while someone can see it. Bars get mapped after their
        // parent, so each one is followed on its own.
        for (const bar of this._bars)
            bar.connect('notify::mapped', () => this._sync());
        St.Settings.get().connectObject('notify::enable-animations',
            () => this._sync(), this);
        this.connect('destroy', () => {
            this._dancing.clear();
            St.Settings.get().disconnectObject(this);
        });
    }

    /**
     * @param {boolean} playing shows the bars
     * @param {boolean} animate lets them dance (the user's setting)
     * @param {string|null} color CSS color, or null for the stylesheet's
     */
    update(playing, animate, color) {
        this._playing = playing;
        this._animate = animate;
        const style = color ? `background-color: ${color};` : '';
        for (const bar of this._bars)
            bar.style = style;
        this._sync();
    }

    _sync() {
        // The bars are an animation; without animations they are hidden.
        const run = this._playing && this._animate &&
            St.Settings.get().enable_animations;
        this.visible = run;
        this._bars.forEach((bar, i) => {
            const dance = run && bar.mapped;
            if (dance === this._dancing.has(bar))
                return;
            bar.remove_all_transitions();
            if (dance) {
                this._dancing.add(bar);
                this._bounce(bar);
            } else {
                this._dancing.delete(bar);
                bar.scale_y = STILL[i];
            }
        });
    }

    _bounce(bar) {
        if (!this._dancing.has(bar))
            return;
        let starting = true;
        bar.ease({
            scale_y: 0.2 + Math.random() * 0.8,
            duration: 160 + Math.random() * 240,
            mode: Clutter.AnimationMode.EASE_IN_OUT_QUAD,
            onComplete: () => {
                // Finished at once: the shell isn't animating it, so stop
                // instead of looping forever.
                if (starting)
                    this._dancing.delete(bar);
                else
                    this._bounce(bar);
            },
        });
        starting = false;
    }
});

/** App icon, source name and the dancing bars, e.g. "♫ Twitch · Chrome ▮▮▮". */
export const SourceLine = GObject.registerClass(
class SourceLine extends St.BoxLayout {
    _init(styleClass) {
        super._init({style_class: styleClass});
        this._icon = new St.Icon({
            style_class: `${styleClass}-icon`,
            y_align: Clutter.ActorAlign.CENTER,
        });
        // Site names can be a whole sentence; the label is cut with "…".
        this._label = new St.Label({
            style_class: `${styleClass}-name`,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._equalizer = new Equalizer();
        this.add_child(this._icon);
        this.add_child(this._label);
        this.add_child(this._equalizer);
    }

    /**
     * @param {object} player
     * @param {boolean} animate whether the bars may dance
     * @param {string|null} color the bars' color, null for the default
     */
    update(player, animate, color) {
        this._icon.gicon = player.appIcon;
        this._label.text = player.sourceName;
        this.visible = this._label.text !== '';
        this._equalizer.update(player.isPlaying, animate, color);
    }
});
