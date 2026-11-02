// Registers Earful's native messaging host (bridge/earful-host.js) with the
// browsers on this computer, so the Earful Bridge browser add-on can start
// it. A registration is one small JSON file per browser, in the folder where
// that browser looks for native messaging hosts. Nothing else is touched.
//
// Uses only Gio and GLib, so the extension, its preferences, tools/bridge.js
// and the tests can all share it. Every function takes the folders to use,
// which keeps tests away from the real home folder.

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

// The Earful Bridge add-on: its ID when loaded unpacked (from the "key" in
// browser-extension/manifest.json) and, once published, in the Chrome Web
// Store. Brave, Edge, Vivaldi and Opera install from the Chrome Web Store too.
export const CHROME_EXTENSION_IDS = ['gjpjaodbgfodpakidffoooacjemeidmn'];
export const FIREFOX_EXTENSION_ID = 'earful@ngdev2.github.io';

// Chromium-based browsers: config folder (under ~/.config) and programs.
// Snap and Flatpak builds can't start a program outside their sandbox, so
// programs found under /snap or a Flatpak folder don't count.
export const CHROMIUM_BROWSERS = [
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

// Defaults for the real session. Tests pass their own.
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
        const found = paths.findProgram?.(name);
        return found && !sandboxed(found);
    });
}

// Where each browser on this computer reads its native messaging hosts:
// [{id, name, kind: 'chromium' | 'firefox', dir}]. A browser counts when its
// config folder exists or its program is installed.
export function targets(paths) {
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

    // Firefox reads ~/.mozilla/native-messaging-hosts, also when its profile
    // lives in ~/.config/mozilla (Mozilla bug 2005167; a fix will read
    // ~/.config/mozilla first). Firefox picks its old profile folder whenever
    // ~/.mozilla exists, so that folder is only created for the Snap build,
    // whose profile lives inside the Snap and whose desktop portal reads
    // ~/.mozilla.
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

export function manifestFor(kind, hostPath) {
    const manifest = {
        name: HOST_NAME,
        description: DESCRIPTION,
        path: hostPath,
        type: 'stdio',
    };
    if (kind === 'firefox')
        manifest.allowed_extensions = [FIREFOX_EXTENSION_ID];
    else
        manifest.allowed_origins = CHROME_EXTENSION_IDS.map(id => `chrome-extension://${id}/`);
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
        if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
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
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
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
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
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
