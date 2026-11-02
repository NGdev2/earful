#!/usr/bin/env -S gjs -m
// Registers Earful's browser helper by hand. Earful does this by itself at
// login (see gnome-extension/lib/bridgeSetup.js); install.sh uses this so
// browser tabs work right away, before the restart.
//
// Usage: gjs -m tools/bridge.js register|unregister|status [--host PATH]
//   --host  the earful-host.js to register (default: the installed Earful,
//           else the one in this checkout)

import GLib from 'gi://GLib';
import {exit, programArgs} from 'system';

const SELF = GLib.filename_from_uri(import.meta.url)[0];
const REPO = GLib.path_get_dirname(GLib.path_get_dirname(SELF));
const Setup = await import(`file://${REPO}/gnome-extension/lib/bridgeSetup.js`);

const UUID = 'earful@NGdev2.github.io';

function defaultHost() {
    const installed = GLib.build_filenamev([GLib.get_user_data_dir(),
        'gnome-shell', 'extensions', UUID, 'bridge', 'earful-host.js']);
    if (GLib.file_test(installed, GLib.FileTest.EXISTS))
        return installed;
    return GLib.build_filenamev([REPO, 'gnome-extension', 'bridge', 'earful-host.js']);
}

const [command, ...rest] = programArgs;
const hostIndex = rest.indexOf('--host');
const host = hostIndex >= 0 ? rest[hostIndex + 1] : defaultHost();
if (!['register', 'unregister', 'status'].includes(command) || !host) {
    printerr('Usage: gjs -m tools/bridge.js register|unregister|status [--host PATH]');
    exit(2);
}

const paths = Setup.defaultPaths(host);
if (command === 'register') {
    const {written, failed} = await Setup.register(paths);
    const found = await Setup.status(paths);
    const names = [...new Set(found.filter(b => b.registered).map(b => b.name))];
    print(names.length
        ? `Browser tabs ready for: ${names.join(', ')}${written.length ? '' : ' (already set up)'}`
        : 'No supported browser found. Start your browser once, then open Earful\'s settings.');
    for (const {name, error} of failed)
        printerr(`Could not set up ${name}: ${error}`);
    exit(failed.length ? 1 : 0);
} else if (command === 'unregister') {
    const removed = await Setup.unregister(paths);
    print(removed.length ? `Removed from: ${[...new Set(removed)].join(', ')}` : 'Nothing to remove.');
} else {
    for (const browser of await Setup.status(paths))
        print(`${browser.registered ? 'ready  ' : 'not set'}  ${browser.name}  (${browser.dir})`);
}
