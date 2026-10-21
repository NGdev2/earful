#!/usr/bin/env -S gjs -m
// A fake MPRIS player for testing Earful and recording demos.
//
// Usage: gjs -m tools/fake-player.js [name] [seconds-per-track] [art-dir]
//   name               bus name suffix and identity (default: FakePlayer)
//   seconds-per-track  auto-advance interval, 0 to disable (default: 8)
//   art-dir            optional folder with images used as cover art
//
// Set FAKE_PLAYER_NO_VOLUME=1 to leave out the MPRIS Volume property, like
// players whose volume Earful has to find in the sound mixer.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {programArgs} from 'system';

const [name = 'FakePlayer', secondsArg = '8', artDir = ''] = programArgs;
const seconds = Number(secondsArg);
const hasVolume = !GLib.getenv('FAKE_PLAYER_NO_VOLUME');

const TRACKS = [
    ['Midnight Compiler', 'The Semicolons', 'Build Passing'],
    ['Merge Conflict Blues', 'Rebase & The Heads', 'Detached'],
    ['Stack Overflow', 'Null Pointer', 'Segfault Sessions'],
    ['Infinite Loop', 'Recursion', 'Base Case'],
    ['Hello, World', 'The Printlns', 'First Commit'],
];

const covers = [];
if (artDir) {
    const dir = Gio.File.new_for_path(artDir);
    const files = dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
    let info;
    while ((info = files.next_file(null)))
        covers.push(dir.get_child(info.get_name()).get_uri());
    covers.sort();
}

const ROOT_IFACE = `
<node>
  <interface name="org.mpris.MediaPlayer2">
    <method name="Raise"/>
    <method name="Quit"/>
    <property name="CanRaise" type="b" access="read"/>
    <property name="CanQuit" type="b" access="read"/>
    <property name="HasTrackList" type="b" access="read"/>
    <property name="Identity" type="s" access="read"/>
    <property name="DesktopEntry" type="s" access="read"/>
    <property name="SupportedUriSchemes" type="as" access="read"/>
    <property name="SupportedMimeTypes" type="as" access="read"/>
  </interface>
</node>`;

const PLAYER_IFACE = `
<node>
  <interface name="org.mpris.MediaPlayer2.Player">
    <method name="PlayPause"/>
    <method name="Play"/>
    <method name="Pause"/>
    <method name="Stop"/>
    <method name="Next"/>
    <method name="Previous"/>
    <property name="PlaybackStatus" type="s" access="read"/>
    <property name="Metadata" type="a{sv}" access="read"/>
    <property name="CanGoNext" type="b" access="read"/>
    <property name="CanGoPrevious" type="b" access="read"/>
    <property name="CanPlay" type="b" access="read"/>
    <property name="CanPause" type="b" access="read"/>
    <property name="CanControl" type="b" access="read"/>
    ${hasVolume ? '<property name="Volume" type="d" access="readwrite"/>' : ''}
  </interface>
</node>`;

let index = 0;
let status = 'Playing';
let volume = 1.0;

const player = {
    CanRaise: true,
    CanQuit: true,
    HasTrackList: false,
    Identity: name,
    DesktopEntry: '',
    SupportedUriSchemes: [],
    SupportedMimeTypes: [],
    CanGoNext: true,
    CanGoPrevious: true,
    CanPlay: true,
    CanPause: true,
    CanControl: true,

    get Volume() {
        return volume;
    },

    set Volume(value) {
        volume = Math.min(Math.max(value, 0), 1);
        print(`${name}: volume ${volume.toFixed(2)}`);
        notify(['Volume']);
    },

    get PlaybackStatus() {
        return status;
    },

    get Metadata() {
        const [title, artist, album] = TRACKS[index % TRACKS.length];
        const metadata = {
            'mpris:trackid': new GLib.Variant('o', `/fake/track/${index}`),
            'xesam:title': new GLib.Variant('s', title),
            'xesam:artist': new GLib.Variant('as', [artist]),
            'xesam:album': new GLib.Variant('s', album),
        };
        if (covers.length)
            metadata['mpris:artUrl'] = new GLib.Variant('s', covers[index % covers.length]);
        return metadata;
    },

    Raise() {
        print(`${name}: Raise`);
    },
    Quit() {
        loop.quit();
    },
    PlayPause() {
        setStatus(status === 'Playing' ? 'Paused' : 'Playing');
    },
    Play() {
        setStatus('Playing');
    },
    Pause() {
        setStatus('Paused');
    },
    Stop() {
        setStatus('Stopped');
    },
    Next() {
        changeTrack(1);
    },
    Previous() {
        changeTrack(-1);
    },
};

const exportedRoot = Gio.DBusExportedObject.wrapJSObject(ROOT_IFACE, player);
const exportedPlayer = Gio.DBusExportedObject.wrapJSObject(PLAYER_IFACE, player);

function notify(props) {
    for (const prop of props) {
        let value;
        if (prop === 'Metadata')
            value = new GLib.Variant('a{sv}', player.Metadata);
        else if (prop === 'Volume')
            value = new GLib.Variant('d', volume);
        else
            value = new GLib.Variant('s', player[prop]);
        exportedPlayer.emit_property_changed(prop, value);
    }
    exportedPlayer.flush();
}

function setStatus(newStatus) {
    status = newStatus;
    print(`${name}: ${status}`);
    notify(['PlaybackStatus']);
}

function changeTrack(delta) {
    index = (index + delta + TRACKS.length) % TRACKS.length;
    print(`${name}: ${TRACKS[index][0]}`);
    notify(['Metadata']);
}

const loop = new GLib.MainLoop(null, false);

Gio.bus_own_name(Gio.BusType.SESSION,
    `org.mpris.MediaPlayer2.${name.replace(/[^A-Za-z0-9_]/g, '_')}`,
    Gio.BusNameOwnerFlags.NONE,
    connection => {
        exportedRoot.export(connection, '/org/mpris/MediaPlayer2');
        exportedPlayer.export(connection, '/org/mpris/MediaPlayer2');
    },
    () => print(`${name}: ready`),
    () => {
        printerr(`${name}: could not own bus name`);
        loop.quit();
    });

if (seconds > 0) {
    GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
        if (status === 'Playing')
            changeTrack(1);
        return GLib.SOURCE_CONTINUE;
    });
}

loop.run();
