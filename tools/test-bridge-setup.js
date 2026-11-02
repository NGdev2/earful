#!/usr/bin/env -S gjs -m
// Unit test for gnome-extension/lib/bridgeSetup.js: registers the native
// host in throwaway folders (never the real home) and checks the files.
//
// Usage: gjs -m tools/test-bridge-setup.js   (or: make bridge-test)

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {exit} from 'system';

const SELF = GLib.filename_from_uri(import.meta.url)[0];
const REPO = GLib.path_get_dirname(GLib.path_get_dirname(SELF));
const Setup = await import(`file://${REPO}/gnome-extension/lib/bridgeSetup.js`);

let failures = 0;
function check(ok, label, detail = '') {
    print(`${ok ? 'ok' : 'FAIL'} - ${label}${!ok && detail ? ` (${detail})` : ''}`);
    if (!ok)
        failures++;
}

const join = (...parts) => GLib.build_filenamev(parts);
const exists = path => GLib.file_test(path, GLib.FileTest.EXISTS);
const read = path => new TextDecoder().decode(GLib.file_get_contents(path)[1]);
const mkdir = path => GLib.mkdir_with_parents(path, 0o755);
const mtime = path => Gio.File.new_for_path(path)
    .query_info('time::modified,time::modified-usec', Gio.FileQueryInfoFlags.NONE, null)
    .get_modification_date_time().to_unix_usec();
const mode = path => Gio.File.new_for_path(path)
    .query_info('unix::mode', Gio.FileQueryInfoFlags.NONE, null)
    .get_attribute_uint32('unix::mode') & 0o777;
const manifest = dir => join(dir, `${Setup.HOST_NAME}.json`);

// A fresh fake computer: home, ~/.config and a host script without the
// executable bit, as a zip might leave it.
function fakeComputer(options = {}) {
    const root = GLib.dir_make_tmp('earful-bridge-setup-XXXXXX');
    const home = join(root, 'home');
    const configDir = join(home, '.config');
    mkdir(configDir);
    const hostPath = join(root, 'ext', 'bridge', 'earful-host.js');
    mkdir(GLib.path_get_dirname(hostPath));
    GLib.file_set_contents(hostPath, '#!/usr/bin/env -S gjs -m\n');
    GLib.chmod(hostPath, 0o644);
    const programs = options.programs ?? {};
    return {
        root,
        paths: {
            home,
            configDir,
            hostPath,
            findProgram: name => programs[name] ?? null,
            snapFirefox: options.snapFirefox ?? false,
        },
    };
}

function cleanup(root) {
    // Undo read-only folders first so everything can be removed.
    Gio.Subprocess.new(['chmod', '-R', 'u+w', root], Gio.SubprocessFlags.NONE).wait(null);
    Gio.Subprocess.new(['rm', '-rf', root], Gio.SubprocessFlags.NONE).wait(null);
}

// 1. Nothing installed: nothing written.
{
    const {root, paths} = fakeComputer();
    const result = await Setup.register(paths);
    check(result.written.length === 0 && result.failed.length === 0, 'no browsers, nothing written');
    check(!exists(join(paths.home, '.mozilla')), 'no ~/.mozilla created without Firefox');
    cleanup(root);
}

// 2. Chrome and a classic Firefox profile.
{
    const {root, paths} = fakeComputer();
    mkdir(join(paths.configDir, 'google-chrome'));
    mkdir(join(paths.home, '.mozilla', 'firefox'));
    const result = await Setup.register(paths);
    const chrome = manifest(join(paths.configDir, 'google-chrome', 'NativeMessagingHosts'));
    const firefox = manifest(join(paths.home, '.mozilla', 'native-messaging-hosts'));
    check(JSON.stringify(result.written) === '["Google Chrome","Firefox"]', 'Chrome and Firefox registered',
        JSON.stringify(result));
    const c = JSON.parse(read(chrome));
    check(c.name === Setup.HOST_NAME && c.path === paths.hostPath && c.type === 'stdio',
        'Chrome manifest points at the host');
    check(c.allowed_origins?.[0] === `chrome-extension://${Setup.CHROME_EXTENSION_IDS[0]}/` && !c.allowed_extensions,
        'Chrome manifest allows the add-on');
    const f = JSON.parse(read(firefox));
    check(f.allowed_extensions?.[0] === Setup.FIREFOX_EXTENSION_ID && !f.allowed_origins,
        'Firefox manifest allows the add-on');
    check(mode(paths.hostPath) === 0o755, 'host made executable', mode(paths.hostPath).toString(8));

    const before = [mtime(chrome), mtime(firefox)];
    const again = await Setup.register(paths);
    check(again.written.length === 0, 'second run writes nothing');
    check(JSON.stringify([mtime(chrome), mtime(firefox)]) === JSON.stringify(before), 'files untouched');

    const listed = await Setup.status(paths);
    check(listed.length === 2 && listed.every(t => t.registered), 'status: both registered');
    const moved = await Setup.status({...paths, hostPath: '/elsewhere/earful-host.js'});
    check(moved.every(t => !t.registered), 'status: a manifest for another host path is not ours');

    // A changed host path (e.g. the old repo checkout) is rewritten.
    GLib.file_set_contents(chrome, read(chrome).replace(paths.hostPath, '/old/native-host/earful-host.js'));
    const fixed = await Setup.register(paths);
    check(JSON.stringify(fixed.written) === '["Google Chrome"]', 'outdated manifest rewritten');

    const otherFile = join(paths.configDir, 'google-chrome', 'NativeMessagingHosts', 'other.app.json');
    GLib.file_set_contents(otherFile, '{}');
    const removed = await Setup.unregister(paths);
    check(removed.length === 2 && !exists(chrome) && !exists(firefox), 'unregister removes both');
    check(exists(otherFile), 'unregister leaves other apps alone');
    cleanup(root);
}

// 3. Programs on PATH count even before the first start; sandboxed ones don't.
{
    const {root, paths} = fakeComputer({programs: {
        'brave-browser': '/usr/bin/brave-browser',
        'chromium': '/snap/bin/chromium',
        'vivaldi': '/var/lib/flatpak/exports/bin/vivaldi',
    }});
    const result = await Setup.register(paths);
    check(JSON.stringify(result.written) === '["Brave"]', 'Brave found by its program, Snap/Flatpak ignored',
        JSON.stringify(result));
    check(exists(manifest(join(paths.configDir, 'BraveSoftware', 'Brave-Browser', 'NativeMessagingHosts'))),
        'Brave folder created');
    cleanup(root);
}

// 4. Firefox folders: Snap creates ~/.mozilla; the new XDG layout doesn't.
{
    const snap = fakeComputer({snapFirefox: true});
    const result = await Setup.register(snap.paths);
    check(JSON.stringify(result.written) === '["Firefox"]' &&
        exists(manifest(join(snap.paths.home, '.mozilla', 'native-messaging-hosts'))),
    'Snap Firefox: ~/.mozilla/native-messaging-hosts');
    cleanup(snap.root);

    const xdg = fakeComputer();
    mkdir(join(xdg.paths.configDir, 'mozilla', 'firefox'));
    await Setup.register(xdg.paths);
    check(exists(manifest(join(xdg.paths.configDir, 'mozilla', 'native-messaging-hosts'))),
        'XDG Firefox: ~/.config/mozilla/native-messaging-hosts');
    check(!exists(join(xdg.paths.home, '.mozilla')), 'XDG Firefox: ~/.mozilla not created');
    cleanup(xdg.root);
}

// 5. One read-only browser folder doesn't stop the others.
{
    const {root, paths} = fakeComputer();
    const locked = join(paths.configDir, 'chromium', 'NativeMessagingHosts');
    mkdir(locked);
    GLib.chmod(locked, 0o555);
    mkdir(join(paths.configDir, 'google-chrome'));
    const result = await Setup.register(paths);
    const writable = GLib.access(locked, 2) === 0; // root can write anyway
    check(writable || (result.failed.length === 1 && result.failed[0].name === 'Chromium'),
        'read-only folder reported', JSON.stringify(result));
    check(result.written.includes('Google Chrome'), 'other browsers still registered');
    cleanup(root);
}

// 6. Cancelling stops the work and reports it.
{
    const {root, paths} = fakeComputer();
    mkdir(join(paths.configDir, 'google-chrome'));
    const cancellable = new Gio.Cancellable();
    cancellable.cancel();
    let cancelled = false;
    try {
        await Setup.register(paths, cancellable);
    } catch (e) {
        cancelled = e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
    }
    check(cancelled, 'cancelled registration throws CANCELLED');
    cleanup(root);
}

print(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
exit(failures ? 1 : 0);
