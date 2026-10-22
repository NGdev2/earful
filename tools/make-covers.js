#!/usr/bin/env -S gjs -m
// Draws two fake covers for tests and demos: a square album cover and a
// wide video thumbnail (Earful crops that one to a square).
//
// Usage: gjs -m tools/make-covers.js <dir>

import Cairo from 'cairo';
import {programArgs} from 'system';

const [dir] = programArgs;

const COVERS = [
    ['a.png', 600, 600, [0.95, 0.45, 0.2], [0.55, 0.1, 0.45]],
    ['b.png', 1280, 720, [0.1, 0.55, 0.75], [0.1, 0.2, 0.35]],
];

for (const [name, width, height, from, to] of COVERS) {
    const surface = new Cairo.ImageSurface(Cairo.Format.RGB24, width, height);
    const cr = new Cairo.Context(surface);
    const gradient = new Cairo.LinearGradient(0, 0, width, height);
    gradient.addColorStopRGB(0, ...from);
    gradient.addColorStopRGB(1, ...to);
    cr.setSource(gradient);
    cr.paint();
    cr.setSourceRGBA(1, 1, 1, 0.85);
    cr.arc(width / 2, height / 2, Math.min(width, height) / 4, 0, 2 * Math.PI);
    cr.fill();
    surface.writeToPNG(`${dir}/${name}`);
}
