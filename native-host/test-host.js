#!/usr/bin/env -S gjs -m
// End-to-end test of the native host, without a browser.
//
// Spawns earful-host.js on a private D-Bus session (dbus-run-session) and a
// throwaway XDG_RUNTIME_DIR, plays the extension's side of the native
// messaging pipe for a few fake tabs, and checks the result over D-Bus.
//
// Usage: gjs -m native-host/test-host.js   (or: make bridge-test)

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {exit, programArgs} from 'system';

const SELF = GLib.filename_from_uri(import.meta.url)[0];
const HOST = GLib.build_filenamev([GLib.path_get_dirname(SELF), 'earful-host.js']);
const PRIVATE_FLAG = '--on-private-bus';

if (!programArgs.includes(PRIVATE_FLAG)) {
    // Never touch the real session bus or runtime dir: re-run in a sandbox.
    const runtimeDir = GLib.dir_make_tmp('earful-test-XXXXXX');
    const launcher = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.NONE});
    launcher.setenv('XDG_RUNTIME_DIR', runtimeDir, true);
    launcher.unsetenv('CHROME_DESKTOP');
    // Keep GVfs daemons from starting on the private bus.
    launcher.setenv('GIO_USE_VFS', 'local', true);
    const proc = launcher.spawnv(['dbus-run-session', '--', 'gjs', '-m', SELF, PRIVATE_FLAG]);
    proc.wait(null);
    Gio.Subprocess.new(['rm', '-rf', runtimeDir], Gio.SubprocessFlags.NONE).wait(null);
    exit(proc.get_exit_status());
}

Gio._promisify(Gio.DBusConnection.prototype, 'call');
Gio._promisify(Gio.InputStream.prototype, 'read_bytes_async');
Gio._promisify(Gio.Subprocess.prototype, 'wait_async');

const PID = new Gio.Credentials().get_unix_pid();
const busName = tabId => `org.mpris.MediaPlayer2.earful_tab_${tabId}.instance${PID}`;
const ROOT = 'org.mpris.MediaPlayer2';
const PLAYER = 'org.mpris.MediaPlayer2.Player';
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';

const bus = Gio.DBus.session;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
let failures = 0;

function check(ok, label, detail = '') {
    print(`${ok ? 'ok' : 'FAIL'} - ${label}${!ok && detail ? ` (${detail})` : ''}`);
    if (!ok)
        failures++;
}

function equal(actual, expected, label) {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    check(a === b, label, `got ${a}, expected ${b}`);
}

const sleep = ms => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
    resolve();
    return GLib.SOURCE_REMOVE;
}));

async function waitFor(predicate, timeout = 5000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
        // eslint-disable-next-line no-await-in-loop
        if (await predicate())
            return true;
        // eslint-disable-next-line no-await-in-loop
        await sleep(25);
    }
    return false;
}

// D-Bus helpers

async function callOn(name, iface, method, args = null, path = '/org/mpris/MediaPlayer2') {
    const reply = await bus.call(name, path, iface, method, args, null,
        Gio.DBusCallFlags.NONE, 2000, null);
    return reply.recursiveUnpack();
}

async function listNames() {
    const [names] = await callOn('org.freedesktop.DBus', 'org.freedesktop.DBus',
        'ListNames', null, '/org/freedesktop/DBus');
    return names.filter(n => n.startsWith('org.mpris.MediaPlayer2.'));
}

async function props(tabId, iface) {
    const [all] = await callOn(busName(tabId), 'org.freedesktop.DBus.Properties',
        'GetAll', new GLib.Variant('(s)', [iface]));
    return all;
}

async function setProp(tabId, name, variant) {
    await callOn(busName(tabId), 'org.freedesktop.DBus.Properties', 'Set',
        new GLib.Variant('(ssv)', [PLAYER, name, variant]));
}

function collectSignals(tabId, iface, member) {
    const received = [];
    const id = bus.signal_subscribe(busName(tabId), iface, member,
        '/org/mpris/MediaPlayer2', null, Gio.DBusSignalFlags.NONE,
        (connection, sender, path, ifaceName, signal, params) =>
            received.push(params.recursiveUnpack()));
    received.stop = () => bus.signal_unsubscribe(id);
    return received;
}

// The native messaging pipe, as the browser sees it

const host = Gio.Subprocess.new(['gjs', '-m', HOST],
    Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE);
const toHost = host.get_stdin_pipe();
const fromHost = host.get_stdout_pipe();
const inbox = [];

function sendRaw(bytes) {
    const frame = new Uint8Array(4 + bytes.length);
    new DataView(frame.buffer).setUint32(0, bytes.length, true);
    frame.set(bytes, 4);
    toHost.write_all(frame, null);
    toHost.flush(null);
}

const send = message => sendRaw(encoder.encode(JSON.stringify(message)));

async function readExactly(size) {
    const buffer = new Uint8Array(size);
    let offset = 0;
    while (offset < size) {
        // eslint-disable-next-line no-await-in-loop
        const chunk = (await fromHost.read_bytes_async(size - offset,
            GLib.PRIORITY_DEFAULT, null)).toArray();
        if (!chunk.length)
            return null;
        buffer.set(chunk, offset);
        offset += chunk.length;
    }
    return buffer;
}

async function pump() {
    for (;;) {
        // eslint-disable-next-line no-await-in-loop
        const header = await readExactly(4);
        if (!header)
            return;
        const size = new DataView(header.buffer).getUint32(0, true);
        // eslint-disable-next-line no-await-in-loop
        inbox.push(JSON.parse(decoder.decode(await readExactly(size))));
    }
}

async function nextMessage(timeout = 3000) {
    await waitFor(() => inbox.length > 0, timeout);
    return inbox.shift() ?? null;
}

// The tests

function tab(overrides) {
    return {
        site: 'Example',
        title: 'Untitled',
        artist: '',
        album: '',
        artUrl: '',
        status: 'Paused',
        position: 0,
        duration: 0,
        rate: 1,
        volume: 1,
        canPlay: true,
        canPause: true,
        canGoNext: false,
        canGoPrevious: false,
        canSeek: false,
        canSetVolume: true,
        ...overrides,
    };
}

async function testHandshake() {
    send({type: 'hello', browser: {name: 'Google Chrome', desktopEntry: 'google-chrome'}});
    const reply = await nextMessage();
    equal(reply?.type, 'ready', 'hello is answered with ready');
}

async function testPlayersAppear() {
    send({type: 'update', tabId: 11, player: tab({
        site: 'YouTube',
        title: 'Midnight Compiler',
        artist: 'The Semicolons',
        album: 'Build Passing',
        artUrl: 'https://i.ytimg.com/vi/abc/maxresdefault.jpg',
        status: 'Playing',
        position: 10,
        duration: 200,
        volume: 0.8,
        canGoNext: true,
        canGoPrevious: true,
        canSeek: true,
    })});
    send({type: 'update', tabId: 12, player: tab({site: 'SoundCloud', title: 'Stack Overflow'})});
    send({type: 'update', tabId: 13, player: tab({
        site: 'Bandcamp',
        title: 'Hello, World',
        artist: 'The Printlns',
        artUrl: `data:image/png;base64,${PNG_BASE64}`,
        status: 'Playing',
    })});

    const appeared = await waitFor(async () => {
        const names = await listNames();
        return [11, 12, 13].every(id => names.includes(busName(id)));
    });
    check(appeared, 'one bus name per tab appears');
    if (!appeared)
        throw new Error(`names on bus: ${await listNames()}`);

    const root = await props(11, ROOT);
    equal(root.Identity, 'YouTube — Google Chrome', 'Identity is site — browser');
    equal(root.DesktopEntry, 'google-chrome', 'DesktopEntry comes from hello');
    equal(root.CanRaise, true, 'CanRaise is true');

    const player = await props(11, PLAYER);
    const metadata = player.Metadata;
    equal(player.PlaybackStatus, 'Playing', 'PlaybackStatus');
    equal(metadata['xesam:title'], 'Midnight Compiler', 'xesam:title');
    equal(metadata['xesam:artist'], ['The Semicolons'], 'xesam:artist is a list');
    equal(metadata['xesam:album'], 'Build Passing', 'xesam:album');
    equal(metadata['mpris:artUrl'], 'https://i.ytimg.com/vi/abc/maxresdefault.jpg', 'https artwork passes through');
    equal(metadata['mpris:length'], 200e6, 'mpris:length in microseconds');
    check(/^\/io\/github\/ngdev2\/earful\/tab11\/track\d+$/.test(metadata['mpris:trackid']),
        'mpris:trackid is an object path', metadata['mpris:trackid']);
    equal(player.Volume, 0.8, 'Volume');
    equal([player.CanGoNext, player.CanGoPrevious, player.CanSeek], [true, true, true], 'Can* flags');
    check(player.Position >= 10e6 && player.Position < 15e6, 'Position advances from the reported one',
        `${player.Position}`);

    const quiet = await props(12, PLAYER);
    equal(quiet.CanGoNext, false, 'tab without a next handler cannot go next');
    check(!('xesam:artist' in quiet.Metadata), 'empty artist is left out');
    equal((await props(12, ROOT)).Identity, 'SoundCloud — Google Chrome', 'second tab Identity');

    const artUrl = (await props(13, PLAYER)).Metadata['mpris:artUrl'] ?? '';
    const artPath = artUrl.startsWith('file://') ? GLib.filename_from_uri(artUrl)[0] : '';
    const runtimeArt = GLib.build_filenamev([GLib.get_user_runtime_dir(), 'earful']);
    check(artPath.startsWith(`${runtimeArt}/`), 'data: artwork becomes a file in $XDG_RUNTIME_DIR/earful', artUrl);
    check(artPath && GLib.file_test(artPath, GLib.FileTest.EXISTS), 'artwork file exists');
    if (artPath) {
        const [, contents] = GLib.file_get_contents(artPath);
        equal(GLib.base64_encode(contents), PNG_BASE64, 'artwork file holds the decoded image');
    }
    return artPath;
}

async function testCommands() {
    await callOn(busName(11), PLAYER, 'Next');
    equal(await nextMessage(), {type: 'command', tabId: 11, command: 'next'}, 'Next is forwarded');

    await callOn(busName(12), PLAYER, 'PlayPause');
    equal(await nextMessage(), {type: 'command', tabId: 12, command: 'playpause'}, 'PlayPause is forwarded');

    await callOn(busName(11), PLAYER, 'Previous');
    equal(await nextMessage(), {type: 'command', tabId: 11, command: 'previous'}, 'Previous is forwarded');

    await callOn(busName(12), PLAYER, 'Next');
    equal(await nextMessage(300), null, 'Next is ignored when CanGoNext is false');

    const changes = collectSignals(13, 'org.freedesktop.DBus.Properties', 'PropertiesChanged');
    await setProp(13, 'Volume', new GLib.Variant('d', 0.25));
    equal(await nextMessage(), {type: 'command', tabId: 13, command: 'volume', value: 0.25}, 'setting Volume is forwarded');
    equal((await props(13, PLAYER)).Volume, 0.25, 'Volume reads back the new value');
    await waitFor(() => changes.length > 0, 1000);
    equal(changes[0]?.[1]?.Volume, 0.25, 'Volume change emits PropertiesChanged');
    changes.stop();

    await callOn(busName(11), ROOT, 'Raise');
    equal(await nextMessage(), {type: 'command', tabId: 11, command: 'raise'}, 'Raise is forwarded');

    const {Metadata: metadata} = await props(11, PLAYER);
    await callOn(busName(11), PLAYER, 'SetPosition',
        new GLib.Variant('(ox)', [metadata['mpris:trackid'], 30e6]));
    equal(await nextMessage(), {type: 'command', tabId: 11, command: 'position', value: 30}, 'SetPosition is forwarded in seconds');

    await callOn(busName(11), PLAYER, 'Seek', new GLib.Variant('(x)', [-5e6]));
    equal(await nextMessage(), {type: 'command', tabId: 11, command: 'seek', value: -5}, 'Seek is forwarded in seconds');
}

async function testChanges() {
    const changes = collectSignals(11, 'org.freedesktop.DBus.Properties', 'PropertiesChanged');
    const seeks = collectSignals(11, PLAYER, 'Seeked');
    const {Metadata: before} = await props(11, PLAYER);

    const next = tab({site: 'YouTube', title: 'Merge Conflict Blues', artist: 'Rebase & The Heads',
        status: 'Playing', duration: 180, canGoNext: true, canSeek: true});
    send({type: 'update', tabId: 11, player: next});
    await waitFor(() => changes.length > 0, 2000);
    const changed = changes.shift()?.[1] ?? {};
    equal(changed.Metadata?.['xesam:title'], 'Merge Conflict Blues', 'new track emits PropertiesChanged with Metadata');
    check(changed.Metadata?.['mpris:trackid'] !== before['mpris:trackid'], 'new track gets a new trackid');

    send({type: 'update', tabId: 11, player: next});
    await sleep(300);
    equal(changes.length, 0, 'an identical update emits nothing');

    send({type: 'update', tabId: 11, player: {...next, position: 120}});
    await waitFor(() => seeks.length > 0, 2000);
    check(seeks.length === 1 && seeks[0][0] >= 120e6, 'a jump in position emits Seeked', JSON.stringify(seeks));

    changes.stop();
    seeks.stop();
}

async function testRobustness() {
    sendRaw(encoder.encode('{not json'));
    send({type: 'bogus'});
    send({type: 'update', tabId: -4, player: tab({})});
    send({type: 'hello', browser: {name: 'Google Chrome'}});
    equal((await nextMessage())?.type, 'ready', 'host survives malformed messages');
    check(!(await listNames()).some(n => n.includes('tab_-4')), 'invalid tab ids are rejected');
}

async function testRemoval(artPath) {
    send({type: 'remove', tabId: 12});
    const gone = await waitFor(async () => !(await listNames()).includes(busName(12)));
    check(gone, 'removed tab releases its bus name');
    check((await listNames()).includes(busName(11)), 'other tabs stay');

    toHost.close(null);
    const exited = await Promise.race([host.wait_async(null).then(() => true), sleep(5000)]);
    check(exited === true, 'host exits when stdin closes');
    const names = await listNames();
    check(!names.some(n => n.includes('earful_tab_')), 'all bus names released on exit', `${names}`);
    check(!GLib.file_test(artPath, GLib.FileTest.EXISTS), 'artwork files removed on exit');
}

async function main() {
    pump().catch(e => printerr(`reader: ${e.message}`));
    try {
        await testHandshake();
        const artPath = await testPlayersAppear();
        await testCommands();
        await testChanges();
        await testRobustness();
        await testRemoval(artPath);
    } catch (e) {
        check(false, 'test run finished', `${e.message}\n${e.stack}`);
    }
    host.force_exit();
    print(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
    return failures ? 1 : 0;
}

const loop = new GLib.MainLoop(null, false);
let status = 1;
main().then(result => {
    status = result;
    loop.quit();
});
await loop.runAsync();
exit(status);
