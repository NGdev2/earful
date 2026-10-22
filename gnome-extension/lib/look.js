// Designs for popups and cards: a gradient, dark glass, an animated scene
// (see scenes.js) or the system theme, in the cover's colors or a fixed
// one. Styles are inline, so they win over the theme.

import {hslToRgb} from './art.js';

// Used while a player has no cover.
const PLAIN = {start: [64, 64, 78], end: [30, 30, 38], accent: [205, 205, 220]};

// Hue and saturation of the fixed colors.
const COLORS = {
    purple: [0.76, 0.55],
    blue: [0.6, 0.6],
    teal: [0.5, 0.55],
    green: [0.36, 0.6],
    amber: [0.1, 0.75],
    red: [0, 0.65],
    pink: [0.9, 0.6],
    graphite: [0.62, 0.06],
};

export const SCENES = ['vinyl', 'wave', 'leds', 'road', 'cassette'];

const rgb = c => `rgb(${c.join(', ')})`;
const rgba = (c, alpha) => `rgba(${c.join(', ')}, ${alpha.toFixed(2)})`;
// Mixes a color with white, for hover.
const lighten = (c, amount) => c.map(v => Math.round(v + (255 - v) * amount));

/** Reads the design settings once per restyle. */
export function lookFromSettings(settings) {
    return {
        design: settings.get_string('design'),
        color: settings.get_string('design-color'),
        opacity: settings.get_int('design-opacity') / 100,
        animate: settings.get_boolean('animations'),
    };
}

/** The colors to paint with: the cover's, or the chosen fixed color. */
export function paletteFor(look, coverPalette) {
    const fixed = COLORS[look.color];
    if (!fixed)
        return coverPalette ?? PLAIN;
    const [h, s] = fixed;
    return {
        start: hslToRgb([h, s, 0.36]),
        end: hslToRgb([(h + 0.06) % 1, s, 0.2]),
        accent: hslToRgb([h, s > 0.1 ? Math.max(s, 0.7) : s, 0.64]),
    };
}

/** True when the design draws an animated scene behind the content. */
export function isScene(look) {
    return SCENES.includes(look.design);
}

/** True when the design paints its own background (white text on it). */
export function isPainted(look) {
    return look.design !== 'system';
}

/** Background of a card or popup. */
export function surfaceStyle(look, palette, hover = false) {
    const {design, opacity} = look;
    if (design === 'system')
        return '';
    const lift = hover ? 0.1 : 0;
    let background;
    if (design === 'glass') {
        background = `background-color: ${rgba(lighten([22, 22, 28], lift), opacity)};`;
    } else {
        const {start, end} = paletteFor(look, palette);
        background = 'background-gradient-direction: horizontal; ' +
            `background-gradient-start: ${rgba(lighten(start, lift), opacity)}; ` +
            `background-gradient-end: ${rgba(lighten(end, lift), opacity)};`;
    }
    // Colors cross-fade when the track (and so the cover) changes.
    return `${background} color: #fafafa; ` +
        'border: 1px solid rgba(255, 255, 255, 0.09); transition-duration: 450ms;';
}

/** The highlight color: the cover's accent, or white-ish without one. */
export function accentColor(look, palette) {
    if (look.design === 'system')
        return null;
    return rgb(paletteFor(look, palette).accent);
}

/** Volume slider in the accent color on a painted card. */
export function sliderStyle(look, palette) {
    const accent = accentColor(look, palette);
    if (!accent)
        return '';
    return `-barlevel-active-background-color: ${accent}; ` +
        '-barlevel-background-color: rgba(255, 255, 255, 0.18); color: #fafafa;';
}

// Mixes a color with black.
const darken = (c, amount) => c.map(v => Math.round(v * (1 - amount)));

/**
 * Style of the menu box itself: 'theme' leaves it to the shell theme,
 * 'dark' and 'music' (the current song's colors) paint it, 'transparent'
 * lets the cards float. Returns {style, painted}; painted menus get light
 * text.
 */
export function menuStyle(background, look, palette) {
    const border = 'border: 1px solid rgba(255, 255, 255, 0.08);';
    switch (background) {
    case 'dark':
        return {
            style: `background-color: ${rgba([24, 24, 30], look.opacity)}; ${border}`,
            painted: true,
        };
    case 'music': {
        const {start, end} = paletteFor(look, palette);
        // Deep enough for white text, and cross-fading to the next song.
        return {
            style: 'background-gradient-direction: vertical; ' +
                `background-gradient-start: ${rgba(darken(start, 0.2), look.opacity)}; ` +
                `background-gradient-end: ${rgba(darken(end, 0.4), look.opacity)}; ` +
                `${border} transition-duration: 600ms;`,
            painted: true,
        };
    }
    case 'transparent':
        return {
            style: 'background-color: transparent; border-color: transparent; ' +
                'box-shadow: none; text-shadow: 0 1px 3px rgba(0, 0, 0, 0.7);',
            painted: true,
        };
    default:
        return {style: '', painted: false};
    }
}
