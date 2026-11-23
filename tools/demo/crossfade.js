#!/usr/bin/env -S gjs -m
// Smooths the cuts of a recorded clip: the frames between two marks (see
// Recorder.fade() in extension.js) become a short crossfade from the last
// frame before the change to the first one after it settled; until the
// crossfade the old frame holds, which hides the menu being rebuilt.
//
// Usage: gjs -m tools/demo/crossfade.js <clip dir>   (reads <clip dir>/fades)

import Cairo from 'cairo';
import GLib from 'gi://GLib';
import {programArgs} from 'system';

const [dir] = programArgs;
// About a third of a second at 15 frames per second.
const FADE_FRAMES = 5;
const frame = i => `${dir}/${String(i).padStart(5, '0')}.png`;
const [, bytes] = GLib.file_get_contents(`${dir}/fades`);
const fades = new TextDecoder().decode(bytes).trim().split('\n')
    .map(line => line.split(' ').map(Number));

for (const [from, to] of fades) {
    if (from < 1 || to <= from || !GLib.file_test(frame(to), GLib.FileTest.EXISTS))
        continue;
    const before = Cairo.ImageSurface.createFromPNG(frame(from - 1));
    const after = Cairo.ImageSurface.createFromPNG(frame(to));
    const start = Math.max(from, to - FADE_FRAMES);
    for (let i = from; i < to; i++) {
        const t = Math.max(0, i - start + 1) / (to - start + 1);
        const eased = t * t * (3 - 2 * t);
        const surface = new Cairo.ImageSurface(Cairo.Format.ARGB32,
            before.getWidth(), before.getHeight());
        const cr = new Cairo.Context(surface);
        cr.setSourceSurface(before, 0, 0);
        cr.paint();
        cr.setSourceSurface(after, 0, 0);
        cr.paintWithAlpha(eased);
        surface.writeToPNG(frame(i));
        cr.$dispose();
    }
}
