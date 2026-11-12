// SPDX-License-Identifier: GPL-3.0-or-later
// Registers Earful's native messaging host (bridge/earful-host.js) with the
// browsers on this computer, so the Earful Bridge browser add-on can start
// it. A registration is one small JSON file per browser, in the folder where
// that browser looks for native messaging hosts. Nothing else is touched.
// Uses only Gio and GLib, so the preferences can import it too.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Gio.File.prototype, 'replace_contents_bytes_async', 'replace_contents_finish');
Gio._promisify(Gio.File.prototype, 'make_directory_async');
Gio._promisify(Gio.File.prototype, 'query_info_async');
Gio._promisify(Gio.File.prototype, 'set_attributes_async');
Gio._promisify(Gio.File.prototype, 'delete_async');

export const HOST_NAME = 'io.github.ngdev2.earful';
const DESCRIPTION = 'Earful: one media player per browser tab';

// Chrome Web Store ID; also the unpacked ID, as the add-on's manifest carries
// the store key. Brave, Edge, Vivaldi and Opera install from the store too.
export const CHROME_EXTENSION_ID = 'hlomkcgmmialafamfkkpiamgefhlidll';
export const FIREFOX_EXTENSION_ID = 'earful@ngdev2.github.io';

// Chromium-based browsers: config folder (under ~/.config) and programs.
// Snap and Flatpak builds can't start a program outside their sandbox, so
// programs found under /snap or a Flatpak folder don't count.
const CHROMIUM_BROWSERS = [
    {id: 'chrome', name: 'Google Chrome', dir: 'google-chrome', programs: ['google-chrome', 'google-chrome-stable']},
    {id: 'chrome-beta', name: 'Google Chrome Beta', dir: 'google-chrome-beta', programs: ['google-chrome-beta']},
    {id: 'chrome-unstable', name: 'Google Chrome Dev', dir: 'google-chrome-unstable', programs: ['google-chrome-unstable']},
    {id: 'chromium', name: 'Chromium', dir: 'chromium', programs: ['chromium', 'chromium-browser']},
    {id: 'brave', name: 'Brave', dir: 'BraveSoftware/Brave-Browser', programs: ['brave-browser', 'brave']},
    {id: 'brave-beta', name: 'Brave Beta', dir: 'BraveSoftware/Brave-Browser-Beta', programs: ['brave-browser-beta']},
    {id: 'brave-nightly', name: 'Brave Nightly', dir: 'BraveSoftware/Brave-Browser-Nightly', programs: ['brave-browser-nightly']},
    {id: 'edge', name: 'Microsoft Edge', dir: 'microsoft-edge', programs: ['microsoft-edge', 'microsoft-edge-stable']},
    {id: 'edge-beta', name: 'Microsoft Edge Beta', dir: 'microsoft-edge-beta', programs: ['microsoft-edge-beta']},
    {id: 'edge-dev', name: 'Microsoft Edge Dev', dir: 'microsoft-edge-dev', programs: ['microsoft-edge-dev']},
    {id: 'vivaldi', name: 'Vivaldi', dir: 'vivaldi', programs: ['vivaldi', 'vivaldi-stable']},
    {id: 'vivaldi-snapshot', name: 'Vivaldi Snapshot', dir: 'vivaldi-snapshot', programs: ['vivaldi-snapshot']},
    {id: 'opera', name: 'Opera', dir: 'opera', programs: ['opera']},
];

function sandboxed(path) {
    return path.startsWith('/snap/') || path.includes('/flatpak/');
}

export function defaultPaths(hostPath) {
    return {
        home: GLib.get_home_dir(),
        configDir: GLib.get_user_config_dir(),
        hostPath,
        findProgram: name => GLib.find_program_in_path(name),
        snapFirefox: GLib.file_test('/snap/firefox', GLib.FileTest.IS_DIR),
    };
}

function isDir(path) {
    return GLib.file_test(path, GLib.FileTest.IS_DIR);
}

function hasProgram(paths, programs) {
    return programs.some(name => {
        const found = paths.findProgram(name);
        return found && !sandboxed(found);
    });
}

// Where each browser on this computer reads its native messaging hosts:
// [{id, name, kind: 'chromium' | 'firefox', dir}]. A browser counts when its
// config folder exists or its program is installed.
function targets(paths) {
    const list = [];
    for (const browser of CHROMIUM_BROWSERS) {
        const root = GLib.build_filenamev([paths.configDir, browser.dir]);
        if (isDir(root) || hasProgram(paths, browser.programs)) {
            list.push({
                id: browser.id,
                name: browser.name,
                kind: 'chromium',
                dir: GLib.build_filenamev([root, 'NativeMessagingHosts']),
            });
        }
    }

    // Firefox reads hosts only from ~/.mozilla for now (Mozilla bug 2005167), but goes
    // back to its old profile when that folder exists: create it only for Snap Firefox.
    const legacy = GLib.build_filenamev([paths.home, '.mozilla']);
    const xdg = GLib.build_filenamev([paths.configDir, 'mozilla']);
    if (isDir(legacy) || paths.snapFirefox) {
        list.push({id: 'firefox', name: 'Firefox', kind: 'firefox',
            dir: GLib.build_filenamev([legacy, 'native-messaging-hosts'])});
    }
    if (isDir(xdg)) {
        list.push({id: 'firefox-xdg', name: 'Firefox', kind: 'firefox',
            dir: GLib.build_filenamev([xdg, 'native-messaging-hosts'])});
    }
    return list;
}

function manifestFor(kind, hostPath) {
    const manifest = {
        name: HOST_NAME,
        description: DESCRIPTION,
        path: hostPath,
        type: 'stdio',
    };
    if (kind === 'firefox')
        manifest.allowed_extensions = [FIREFOX_EXTENSION_ID];
    else
        manifest.allowed_origins = [`chrome-extension://${CHROME_EXTENSION_ID}/`];
    return `${JSON.stringify(manifest, null, 2)}\n`;
}

function manifestFile(target) {
    return Gio.File.new_for_path(GLib.build_filenamev([target.dir, `${HOST_NAME}.json`]));
}

async function readText(file, cancellable) {
    try {
        const [bytes] = await file.load_contents_async(cancellable);
        return new TextDecoder().decode(bytes);
    } catch (e) {
        if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
            return null;
        throw e;
    }
}

async function makeDirs(dir, cancellable) {
    try {
        await dir.make_directory_async(GLib.PRIORITY_DEFAULT, cancellable);
    } catch (e) {
        if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS))
            return;
        if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
            throw e;
        await makeDirs(dir.get_parent(), cancellable);
        await makeDirs(dir, cancellable);
    }
}

// The host must be executable; a zip or copy may have lost the bit.
async function makeExecutable(path, cancellable) {
    const file = Gio.File.new_for_path(path);
    const info = await file.query_info_async(Gio.FILE_ATTRIBUTE_UNIX_MODE,
        Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, cancellable);
    const mode = info.get_attribute_uint32(Gio.FILE_ATTRIBUTE_UNIX_MODE);
    if ((mode & 0o111) === 0o111)
        return;
    info.set_attribute_uint32(Gio.FILE_ATTRIBUTE_UNIX_MODE, mode | 0o111);
    await file.set_attributes_async(info, Gio.FileQueryInfoFlags.NONE,
        GLib.PRIORITY_DEFAULT, cancellable);
}

// Writes the manifest for every browser found, only where it changed.
// Returns {written: [names], failed: [{name, error}]}; one browser failing
// (e.g. a read-only folder) doesn't stop the others.
export async function register(paths, cancellable = null) {
    const result = {written: [], failed: []};
    try {
        await makeExecutable(paths.hostPath, cancellable);
    } catch (e) {
        // A system-wide install may be read-only and already executable.
        if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
            throw e;
    }
    for (const target of targets(paths)) {
        const file = manifestFile(target);
        const contents = manifestFor(target.kind, paths.hostPath);
        try {
            if (await readText(file, cancellable) === contents)
                continue;
            await makeDirs(file.get_parent(), cancellable);
            await file.replace_contents_bytes_async(new GLib.Bytes(new TextEncoder().encode(contents)),
                null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, cancellable);
            result.written.push(target.name);
        } catch (e) {
            if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                throw e;
            result.failed.push({name: target.name, error: e.message});
        }
    }
    return result;
}

// Removes our manifest wherever a browser would read it.
export async function unregister(paths, cancellable = null) {
    const removed = [];
    for (const target of targets(paths)) {
        try {
            await manifestFile(target).delete_async(GLib.PRIORITY_DEFAULT, cancellable);
            removed.push(target.name);
        } catch (e) {
            if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                throw e;
        }
    }
    return removed;
}

// [{id, name, kind, dir, registered}] for every browser found. Registered
// means our manifest is there and points at this host.
export async function status(paths, cancellable = null) {
    const list = [];
    for (const target of targets(paths)) {
        let registered = false;
        try {
            const text = await readText(manifestFile(target), cancellable);
            registered = text !== null && JSON.parse(text).path === paths.hostPath;
        } catch (e) {
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                throw e;
        }
        list.push({...target, registered});
    }
    return list;
}

// Which browsers the add-on has reached the helper from, so Settings can say
// "connected" rather than only "ready". The helper writes it on each start.

// Parts of a browser's program path, most specific first, and its name in
// BROWSERS (a Firefox through the desktop portal is told by its hello).
const PROGRAMS = [
    ['/chrome-beta/', 'Google Chrome Beta'],
    ['/chrome-unstable/', 'Google Chrome Dev'],
    ['/google/chrome/', 'Google Chrome'],
    ['brave-beta', 'Brave Beta'],
    ['brave-nightly', 'Brave Nightly'],
    ['brave', 'Brave'],
    ['msedge-beta', 'Microsoft Edge Beta'],
    ['msedge-dev', 'Microsoft Edge Dev'],
    ['msedge', 'Microsoft Edge'],
    ['vivaldi-snapshot', 'Vivaldi Snapshot'],
    ['vivaldi', 'Vivaldi'],
    ['opera', 'Opera'],
    ['chromium', 'Chromium'],
    ['firefox', 'Firefox'],
];

/**
 * The browser's name as Settings lists it, from the program that started the
 * helper, else from the name the add-on sent.
 */
export function browserName(program, helloName) {
    const found = PROGRAMS.find(([part]) => program.includes(part));
    if (helloName === 'Firefox' || !found)
        return helloName || 'Chromium';
    return found[1];
}

function seenFile(stateDir) {
    return GLib.build_filenamev([stateDir, 'earful', 'bridge-seen.json']);
}

/** {name: unix seconds} of each browser the add-on was last seen in. */
export function readSeen(stateDir = GLib.get_user_state_dir()) {
    try {
        const [, contents] = GLib.file_get_contents(seenFile(stateDir));
        const seen = JSON.parse(new TextDecoder().decode(contents));
        return seen && typeof seen === 'object' ? seen : {};
    } catch {
        return {};
    }
}

/** Notes that the add-on just reached the helper from this browser. */
export function markSeen(name, stateDir = GLib.get_user_state_dir()) {
    const seen = readSeen(stateDir);
    seen[name] = Math.floor(Date.now() / 1000);
    const file = seenFile(stateDir);
    GLib.mkdir_with_parents(GLib.path_get_dirname(file), 0o700);
    GLib.file_set_contents(file, JSON.stringify(seen));
}

// Keeps the registrations in line with the browser-bridge setting while the
// extension is enabled.
export class BridgeSync {
    constructor(settings, hostPath) {
        this._settings = settings;
        this._hostPath = hostPath;
        this._cancellable = new Gio.Cancellable();
        this._queue = Promise.resolve();
        this._changedId = settings.connect('changed::browser-bridge', () => this._sync());
        this._sync();
    }

    _sync() {
        const enabled = this._settings.get_boolean('browser-bridge');
        // One at a time: cancelling doesn't undo a delete already running, so a
        // quick off-on could otherwise race.
        this._queue = this._queue.then(() => this._apply(enabled));
    }

    async _apply(enabled) {
        if (this._cancellable.is_cancelled())
            return;
        const paths = defaultPaths(this._hostPath);
        try {
            if (enabled) {
                const {failed} = await register(paths, this._cancellable);
                if (failed.length) {
                    const list = failed.map(f => `${f.name} (${f.error})`).join(', ');
                    console.warn(`Earful: could not set up browser tabs for ${list}`);
                }
            } else {
                await unregister(paths, this._cancellable);
            }
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                logError(e, 'Earful: browser tabs setup');
        }
    }

    destroy() {
        this._cancellable.cancel();
        this._settings.disconnect(this._changedId);
        this._settings = null;
    }
}
