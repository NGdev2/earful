#!/usr/bin/env -S gjs -m
// Puts screenshots side by side (row) or in a grid, on a transparent
// background, for the README.
//
// Usage: gjs -m tools/demo/compose.js <out.png> <columns> <image>...

import Cairo from 'cairo';
import {programArgs} from 'system';

const [out, columnsArg, ...files] = programArgs;
const columns = Number(columnsArg);
const GAP = 16;

const images = files.map(f => Cairo.ImageSurface.createFromPNG(f));
const rows = Math.ceil(images.length / columns);
const cellW = Math.max(...images.map(i => i.getWidth()));
// Each row as tall as its tallest picture, so a column stacks tightly.
const rowH = Array.from({length: rows}, (_, r) =>
    Math.max(...images.slice(r * columns, (r + 1) * columns).map(i => i.getHeight())));
const rowY = rowH.map((_, r) => rowH.slice(0, r).reduce((sum, h) => sum + h + GAP, 0));

const surface = new Cairo.ImageSurface(Cairo.Format.ARGB32,
    columns * cellW + (columns - 1) * GAP, rowY[rows - 1] + rowH[rows - 1]);
const cr = new Cairo.Context(surface);
images.forEach((image, i) => {
    // Top-aligned, so menus line up under the top bar.
    cr.setSourceSurface(image, (i % columns) * (cellW + GAP) + (cellW - image.getWidth()) / 2,
        rowY[Math.floor(i / columns)]);
    cr.paint();
});
surface.writeToPNG(out);
cr.$dispose();
