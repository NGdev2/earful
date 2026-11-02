// Cover art URLs for MPRIS. http(s) URLs pass through untouched. Inline
// data: images are written to $XDG_RUNTIME_DIR/earful/ (private, in RAM,
// wiped at logout) because MPRIS clients expect a URI they can open.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const DIR = GLib.build_filenamev([GLib.get_user_runtime_dir(), 'earful']);
const PID = new Gio.Credentials().get_unix_pid();
const EXTENSIONS = {
    'png': 'png',
    'jpeg': 'jpg',
    'jpg': 'jpg',
    'gif': 'gif',
    'webp': 'webp',
    'avif': 'avif',
    'bmp': 'bmp',
    'svg+xml': 'svg',
};

const refs = new Map(); // file:// URI -> number of players using it

function decodeDataUrl(url) {
    const match = /^data:image\/([\w.+-]+)((?:;[^;,]*)*),(.*)$/is.exec(url);
    const extension = match && EXTENSIONS[match[1].toLowerCase()];
    if (!extension)
        return null;
    const bytes = match[2].toLowerCase().split(';').includes('base64')
        ? GLib.base64_decode(match[3])
        : new TextEncoder().encode(decodeURIComponent(match[3]));
    return {bytes, extension};
}

function writeDataUrl(url) {
    const image = decodeDataUrl(url);
    if (!image?.bytes.length)
        return '';
    // Files are tagged with our PID so several browsers never share one.
    const hash = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA1, url, -1);
    const path = GLib.build_filenamev([DIR, `${PID}-${hash}.${image.extension}`]);
    GLib.mkdir_with_parents(DIR, 0o700);
    if (!GLib.file_test(path, GLib.FileTest.EXISTS))
        GLib.file_set_contents(path, image.bytes);
    return GLib.filename_to_uri(path, null);
}

/** Returns a URI for `url` that MPRIS clients can use, or ''. */
export function acquire(url) {
    if (/^https?:\/\//i.test(url))
        return url;
    if (!/^data:/i.test(url))
        return '';

    let uri = '';
    try {
        uri = writeDataUrl(url);
    } catch (e) {
        printerr(`earful-host: could not save cover art: ${e.message}`);
    }
    if (uri)
        refs.set(uri, (refs.get(uri) ?? 0) + 1);
    return uri;
}

/** Drops a URI returned by acquire(), deleting its file when unused. */
export function release(uri) {
    const count = refs.get(uri);
    if (!count)
        return;
    if (count > 1) {
        refs.set(uri, count - 1);
        return;
    }
    refs.delete(uri);
    try {
        Gio.File.new_for_uri(uri).delete(null);
    } catch {}
}

export function releaseAll() {
    for (const uri of [...refs.keys()]) {
        refs.set(uri, 1);
        release(uri);
    }
}

/** Removes files left behind by hosts that crashed. */
export function removeStaleFiles() {
    const dir = Gio.File.new_for_path(DIR);
    try {
        const files = dir.enumerate_children('standard::name',
            Gio.FileQueryInfoFlags.NONE, null);
        let info;
        while ((info = files.next_file(null))) {
            const pid = /^(\d+)-/.exec(info.get_name())?.[1];
            if (pid && !GLib.file_test(`/proc/${pid}`, GLib.FileTest.EXISTS))
                dir.get_child(info.get_name()).delete(null);
        }
    } catch {
        // No folder yet, or a file vanished meanwhile: nothing to clean.
    }
}
