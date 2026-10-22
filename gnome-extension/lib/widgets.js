// Small pieces shared by the menu and the popups.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Graphene from 'gi://Graphene';
import St from 'gi://St';

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
        this._label = new St.Label({y_align: Clutter.ActorAlign.CENTER});
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
