#!/usr/bin/env -S gjs -m
// Earful native messaging host: turns the media tabs reported by the
// Earful browser extension into one MPRIS player each.
//
// The browser starts it (see install.sh) with stdin/stdout as the native
// messaging pipe: every message is a 4-byte native-endian length followed
// by that many bytes of UTF-8 JSON. So nothing here may print to stdout;
// diagnostics go to stderr, which the browser shows in its own log.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Artwork from './lib/artwork.js';
import {TabPlayer} from './lib/tab-player.js';

// GLib 2.80 moved the Unix-only APIs into their own namespaces.
const GioUnix = await import('gi://GioUnix').then(m => m.default, () => null);
const GLibUnix = await import('gi://GLibUnix').then(m => m.default, () => null);

const VERSION = '0.1.0';
const MAX_MESSAGE_SIZE = 64 * 1024 * 1024;
const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
const SIGNALS = {SIGHUP: 1, SIGINT: 2, SIGTERM: 15};

Gio._promisify(Gio.InputStream.prototype, 'read_bytes_async');

const stdin = GioUnix
    ? new GioUnix.InputStream({fd: 0, close_fd: false})
    : new Gio.UnixInputStream({fd: 0, close_fd: false});
const stdout = GioUnix
    ? new GioUnix.OutputStream({fd: 1, close_fd: false})
    : new Gio.UnixOutputStream({fd: 1, close_fd: false});
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const loop = new GLib.MainLoop(null, false);
const players = new Map(); // tabId -> TabPlayer
const browser = {
    name: 'Chromium',
    // Set by some browser launchers; the most reliable hint when present.
    desktopEntry: (GLib.getenv('CHROME_DESKTOP') ?? '').replace(/\.desktop$/, ''),
    pid: parentPid(),
};

// The browser process that started us. Its own MPRIS player is called
// org.mpris.MediaPlayer2.chromium.instance<pid>, so including the pid in
// our names tells clients which browser's player we replace.
function parentPid() {
    try {
        const [, contents] = GLib.file_get_contents('/proc/self/stat');
        const fields = decoder.decode(contents).split(') ')[1].split(' ');
        return Number(fields[1]);
    } catch {
        return new Gio.Credentials().get_unix_pid();
    }
}

function log(message) {
    printerr(`earful-host: ${message}`);
}

// Framing

async function readExactly(size) {
    const buffer = new Uint8Array(size);
    let offset = 0;
    while (offset < size) {
        const bytes = await stdin.read_bytes_async(Math.min(size - offset, 65536),
            GLib.PRIORITY_DEFAULT, null);
        const chunk = bytes.toArray();
        if (!chunk.length)
            return null;
        buffer.set(chunk, offset);
        offset += chunk.length;
    }
    return buffer;
}

/** Resolves to the next message's raw bytes, or null when the pipe closes. */
async function readFrame() {
    const header = await readExactly(4);
    if (!header)
        return null;
    const size = new DataView(header.buffer).getUint32(0, LITTLE_ENDIAN);
    if (size > MAX_MESSAGE_SIZE)
        throw new Error(`message too large (${size} bytes)`);
    return readExactly(size);
}

function send(message) {
    const body = encoder.encode(JSON.stringify(message));
    const frame = new Uint8Array(4 + body.length);
    new DataView(frame.buffer).setUint32(0, body.length, LITTLE_ENDIAN);
    frame.set(body, 4);
    stdout.write_all(frame, null);
    stdout.flush(null);
}

// Messages from the extension

function text(value, max = 500) {
    return typeof value === 'string' ? value.slice(0, max) : '';
}

function handle(message) {
    const tabId = message?.tabId;
    if (tabId !== undefined && !(Number.isInteger(tabId) && tabId >= 0))
        throw new Error(`invalid tab id ${tabId}`);

    switch (message?.type) {
    case 'hello':
        browser.name = text(message.browser?.name, 100) || browser.name;
        browser.desktopEntry ||= text(message.browser?.desktopEntry, 100);
        for (const player of players.values())
            player.publish();
        send({type: 'ready', version: VERSION});
        break;
    case 'update': {
        if (typeof message.player !== 'object' || !message.player)
            throw new Error('update without player');
        let player = players.get(tabId);
        if (!player) {
            player = new TabPlayer(tabId, browser,
                (command, value) => send({type: 'command', tabId, command, value}));
            players.set(tabId, player);
        }
        player.update(message.player);
        break;
    }
    case 'remove':
        players.get(tabId)?.destroy();
        players.delete(tabId);
        break;
    default:
        throw new Error(`unknown message type ${message?.type}`);
    }
}

async function readMessages() {
    try {
        let frame;
        while ((frame = await readFrame())) {
            try {
                handle(JSON.parse(decoder.decode(frame)));
            } catch (e) {
                log(`ignoring message: ${e.message}`);
            }
        }
    } catch (e) {
        log(`stopping: ${e.message}`);
    }
    // The browser closed the pipe: the extension is gone.
    shutdown();
}

function shutdown() {
    for (const player of players.values())
        player.destroy();
    players.clear();
    Artwork.releaseAll();
    loop.quit();
}

for (const signal of Object.values(SIGNALS)) {
    const add = GLibUnix?.signal_add_full ?? GLib.unix_signal_add;
    add(GLib.PRIORITY_DEFAULT, signal, () => {
        shutdown();
        return GLib.SOURCE_REMOVE;
    });
}

Artwork.removeStaleFiles();
readMessages();
await loop.runAsync();
