#!/usr/bin/env -S gjs -m
// Draws the fictional album covers used in the README demo.
//
// Usage: gjs -m tools/demo/covers.js <dir>

import Cairo from 'cairo';
import {programArgs} from 'system';

const [dir] = programArgs;
const TAU = 2 * Math.PI;

// A small seeded random generator, so every run draws the same covers.
function random(seed) {
    let state = seed;
    return () => {
        state = (state * 1664525 + 1013904223) % 4294967296;
        return state / 4294967296;
    };
}

function gradient(cr, w, h, stops, [x0, y0, x1, y1] = [0, 0, 0, h]) {
    const g = new Cairo.LinearGradient(x0, y0, x1, y1);
    stops.forEach(([offset, r, gr, b]) => g.addColorStopRGB(offset, r, gr, b));
    cr.setSource(g);
    cr.rectangle(0, 0, w, h);
    cr.fill();
}

function save(name, w, h, draw) {
    const surface = new Cairo.ImageSurface(Cairo.Format.RGB24, w, h);
    const cr = new Cairo.Context(surface);
    draw(cr, w, h);
    surface.writeToPNG(`${dir}/${name}.png`);
    cr.$dispose();
}

// Neon Tides: a striped synthwave sun over the sea.
save('neon-tides', 600, 600, (cr, w, h) => {
    gradient(cr, w, h, [[0, 0.1, 0.05, 0.3], [0.62, 0.55, 0.12, 0.55], [1, 0.08, 0.04, 0.2]]);
    const sun = new Cairo.LinearGradient(0, 120, 0, 380);
    sun.addColorStopRGB(0, 1, 0.85, 0.3);
    sun.addColorStopRGB(1, 1, 0.25, 0.55);
    cr.setSource(sun);
    cr.arc(300, 330, 170, Math.PI, TAU);
    cr.fill();
    cr.setSourceRGB(0.4, 0.1, 0.45);
    for (let i = 0; i < 6; i++)
        cr.rectangle(120, 250 + i * 14, 360, 3 + i * 1.6);
    cr.fill();
    cr.setSourceRGBA(0.3, 0.9, 1, 0.8);
    cr.setLineWidth(3);
    for (let i = 0; i < 6; i++) {
        const y = 370 + i * i * 9;
        cr.moveTo(0, y);
        for (let x = 0; x <= w; x += 20)
            cr.lineTo(x, y + Math.sin(x / 40 + i) * (3 + i));
        cr.stroke();
    }
});

// Golden Hour: warm rings like light through a window.
save('golden-hour', 600, 600, (cr, w, h) => {
    const g = new Cairo.RadialGradient(380, 220, 20, 300, 300, 520);
    g.addColorStopRGB(0, 1, 0.9, 0.55);
    g.addColorStopRGB(0.45, 0.95, 0.5, 0.15);
    g.addColorStopRGB(1, 0.35, 0.08, 0.08);
    cr.setSource(g);
    cr.rectangle(0, 0, w, h);
    cr.fill();
    cr.setLineWidth(2);
    for (let r = 40; r < 600; r += 34) {
        cr.setSourceRGBA(1, 0.95, 0.8, 0.35 - r / 2000);
        cr.arc(380, 220, r, 0, TAU);
        cr.stroke();
    }
    cr.setSourceRGBA(0.2, 0.05, 0.05, 0.85);
    cr.moveTo(0, 470);
    cr.curveTo(150, 420, 320, 520, 600, 440);
    cr.lineTo(600, 600);
    cr.lineTo(0, 600);
    cr.fill();
});

// Paper Planes: white planes over a teal sky.
save('paper-planes', 600, 600, (cr, w, h) => {
    gradient(cr, w, h, [[0, 0.1, 0.6, 0.62], [1, 0.03, 0.25, 0.35]]);
    const rand = random(7);
    for (let i = 0; i < 9; i++) {
        const x = 60 + rand() * 480;
        const y = 60 + rand() * 480;
        const size = 30 + rand() * 60;
        cr.save();
        cr.translate(x, y);
        cr.rotate(-0.5 + rand() * 0.4);
        cr.setSourceRGBA(1, 1, 1, 0.55 + rand() * 0.4);
        cr.moveTo(-size, 0);
        cr.lineTo(size, -size * 0.25);
        cr.lineTo(-size * 0.3, size * 0.45);
        cr.closePath();
        cr.fill();
        cr.setSourceRGBA(0, 0.2, 0.25, 0.25);
        cr.moveTo(-size * 0.3, size * 0.45);
        cr.lineTo(size, -size * 0.25);
        cr.lineTo(-size * 0.1, size * 0.1);
        cr.closePath();
        cr.fill();
        cr.restore();
    }
});

// Low Orbit: a ringed planet among stars.
save('low-orbit', 600, 600, (cr, w, h) => {
    gradient(cr, w, h, [[0, 0.02, 0.03, 0.1], [1, 0.08, 0.05, 0.2]]);
    const rand = random(3);
    for (let i = 0; i < 140; i++) {
        cr.setSourceRGBA(1, 1, 1, 0.2 + rand() * 0.7);
        cr.arc(rand() * w, rand() * h, rand() * 1.8 + 0.4, 0, TAU);
        cr.fill();
    }
    const planet = new Cairo.LinearGradient(200, 200, 420, 420);
    planet.addColorStopRGB(0, 0.45, 0.85, 1);
    planet.addColorStopRGB(1, 0.25, 0.2, 0.75);
    cr.setSource(planet);
    cr.arc(300, 300, 120, 0, TAU);
    cr.fill();
    cr.save();
    cr.translate(300, 300);
    cr.rotate(-0.35);
    cr.scale(1, 0.28);
    cr.arc(0, 0, 200, 0.15, Math.PI - 0.15);
    cr.restore();
    cr.setLineWidth(14);
    cr.setSourceRGBA(1, 0.8, 0.5, 0.85);
    cr.stroke();
});

// Velvet Static: soft diagonal bands.
save('velvet-static', 600, 600, (cr, w, h) => {
    gradient(cr, w, h, [[0, 0.35, 0.08, 0.4], [1, 0.9, 0.3, 0.45]], [0, 0, 600, 600]);
    for (let i = -6; i < 12; i++) {
        cr.setSourceRGBA(1, 1, 1, i % 2 ? 0.08 : 0.16);
        cr.moveTo(i * 70, 0);
        cr.lineTo(i * 70 + 40, 0);
        cr.lineTo(i * 70 + 640, 600);
        cr.lineTo(i * 70 + 600, 600);
        cr.closePath();
        cr.fill();
    }
    cr.setSourceRGBA(1, 0.95, 0.9, 0.9);
    cr.arc(300, 300, 70, 0, TAU);
    cr.fill();
});

// Night Signals: a grid of dots, a few lit.
save('night-signals', 600, 600, (cr, w, h) => {
    gradient(cr, w, h, [[0, 0.04, 0.06, 0.16], [1, 0.02, 0.02, 0.06]]);
    const rand = random(11);
    for (let y = 45; y < h; y += 45) {
        for (let x = 45; x < w; x += 45) {
            const lit = rand() < 0.18;
            if (lit)
                cr.setSourceRGBA(1, 0.3 + rand() * 0.3, 0.6, 0.95);
            else
                cr.setSourceRGBA(0.5, 0.6, 1, 0.18);
            cr.arc(x, y, lit ? 9 : 6, 0, TAU);
            cr.fill();
        }
    }
});

// Ocean Drive: a turquoise wave.
save('ocean-drive', 600, 600, (cr, w, h) => {
    gradient(cr, w, h, [[0, 1, 0.72, 0.5], [0.5, 0.3, 0.8, 0.75], [1, 0.05, 0.35, 0.5]]);
    for (let i = 0; i < 4; i++) {
        cr.setSourceRGBA(1, 1, 1, 0.12 + i * 0.06);
        cr.moveTo(0, 330 + i * 60);
        cr.curveTo(160, 250 + i * 60, 360, 420 + i * 60, 600, 320 + i * 60);
        cr.lineTo(600, 600);
        cr.lineTo(0, 600);
        cr.fill();
    }
});

// A wide video thumbnail: night city with a moon (Earful crops it square).
save('night-city', 1280, 720, (cr, w, h) => {
    gradient(cr, w, h, [[0, 0.15, 0.1, 0.35], [0.7, 0.75, 0.35, 0.55], [1, 0.95, 0.6, 0.5]]);
    cr.setSourceRGBA(1, 0.97, 0.88, 0.95);
    cr.arc(640, 250, 90, 0, TAU);
    cr.fill();
    const rand = random(5);
    let x = 0;
    while (x < w) {
        const bw = 50 + rand() * 90;
        const bh = 120 + rand() * 300;
        cr.setSourceRGB(0.08, 0.05, 0.15);
        cr.rectangle(x, h - bh, bw - 6, bh);
        cr.fill();
        cr.setSourceRGBA(1, 0.85, 0.5, 0.7);
        for (let wy = h - bh + 16; wy < h - 10; wy += 24) {
            for (let wx = x + 10; wx < x + bw - 20; wx += 18) {
                if (rand() < 0.3)
                    cr.rectangle(wx, wy, 7, 10);
            }
        }
        cr.fill();
        x += bw;
    }
});
