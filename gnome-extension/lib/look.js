// Designs for popups and cards: colors from the cover, dark glass, or the
// system theme. Each returns inline styles, so they win over the theme.

// Used while a player has no cover.
const PLAIN = {start: [64, 64, 78], end: [30, 30, 38], accent: [205, 205, 220]};

const rgb = c => `rgb(${c.join(', ')})`;
const rgba = (c, alpha) => `rgba(${c.join(', ')}, ${alpha.toFixed(2)})`;
// Mixes a color with white, for hover.
const lighten = (c, amount) => c.map(v => Math.round(v + (255 - v) * amount));

/** Reads the design settings once per restyle. */
export function lookFromSettings(settings) {
    return {
        design: settings.get_string('design'),
        opacity: settings.get_int('design-opacity') / 100,
    };
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
        const {start, end} = palette ?? PLAIN;
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
    return rgb((palette ?? PLAIN).accent);
}

/** Volume slider in the accent color on a painted card. */
export function sliderStyle(look, palette) {
    const accent = accentColor(look, palette);
    if (!accent)
        return '';
    return `-barlevel-active-background-color: ${accent}; ` +
        '-barlevel-background-color: rgba(255, 255, 255, 0.18); color: #fafafa;';
}
