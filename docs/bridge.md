# Earful's browser helper (native messaging host)

A small [gjs](https://gitlab.gnome.org/GNOME/gjs) program,
[gnome-extension/bridge/earful-host.js](../gnome-extension/bridge/earful-host.js),
that the browser starts for the [Earful Bridge add-on](../browser-extension/).
It publishes one [MPRIS](https://specifications.freedesktop.org/mpris-spec/latest/)
player per browser tab with media, so any MPRIS client (Earful, GNOME's own
media controls, `playerctl`) sees each tab separately. It ships inside the
GNOME extension.

## Registration

At login, after unlocking and when *Browser tabs* is switched on, Earful
writes `io.github.ngdev2.earful.json`, pointing at its own copy of the helper,
into the folder each installed browser reads
([gnome-extension/lib/bridgeSetup.js](../gnome-extension/lib/bridgeSetup.js)):

- `~/.config/<browser>/NativeMessagingHosts/` for Chrome, Chromium, Brave,
  Edge, Vivaldi and Opera (a browser counts when its config folder exists or
  its program is installed; Snap and Flatpak builds are skipped)
- `~/.mozilla/native-messaging-hosts/` for Firefox, when that folder exists
  or Firefox is the Snap build (its desktop portal reads it), and
  `~/.config/mozilla/native-messaging-hosts/` when Firefox uses the new
  folder layout. `~/.mozilla` is never created otherwise, because Firefox
  would then switch back to its old profile folder.

Only changed files are written. Switching *Browser tabs* off removes them,
and so does `install.sh --uninstall`.

```bash
make bridge-install        # the same by hand: gjs -m tools/bridge.js register
make bridge-uninstall      # gjs -m tools/bridge.js unregister
gjs -m tools/bridge.js status
make bridge-test           # helper and registration, private D-Bus, temp folders
make bridge-test-browser   # plus a throwaway headless Chrome profile
make bridge-test-firefox   # headless Firefox (uses your session bus, see the script)
```

## Bus names (contract with the GNOME extension)

Each tab owns

```
org.mpris.MediaPlayer2.earful_tab_<tabId>.instance<browserPid>
```

with `org.mpris.MediaPlayer2` and `org.mpris.MediaPlayer2.Player` at
`/org/mpris/MediaPlayer2`.

- The prefix `org.mpris.MediaPlayer2.earful_tab_` marks bridge players.
- `<browserPid>` is the browser process that started the host. Chromium's own
  single player is `org.mpris.MediaPlayer2.chromium.instance<browserPid>`,
  with the same pid, so a client should **hide
  `org.mpris.MediaPlayer2.chromium.instance<N>` while any
  `org.mpris.MediaPlayer2.earful_tab_*.instance<N>` exists**. The pid also
  keeps names unique when two browsers run the bridge at once.
- For Firefox, `<browserPid>` is the host's own pid instead: a Snap Firefox
  starts the host through the desktop portal, so the parent is the portal,
  the same for every Firefox running. Firefox's own player is
  `org.mpris.MediaPlayer2.firefox.*`; hide it while any bridge player's
  `Identity` ends in `Firefox`.
- `Identity` is `"<site> — <browser>"`, e.g. `YouTube — Google Chrome`.
  `DesktopEntry` is the browser's desktop file id (`google-chrome`,
  `chromium`, …) from `$CHROME_DESKTOP` if the launcher sets it, otherwise
  from the extension. For Firefox the host picks the installed one
  (`firefox_firefox` for Snap, `org.mozilla.firefox`, `firefox`).
- Players come and go with their tabs. When the browser quits or the
  extension goes away, every name is released.

## Native messaging protocol

Each message is a 4-byte native-endian length, then UTF-8 JSON.

Extension → host:

```js
{type: 'hello', browser: {name: 'Google Chrome', desktopEntry: 'google-chrome'}, version: '0.2.0'}
{type: 'update', tabId: 42, player: {
    site, title, artist, album,   // strings; artist is the site name when the page has no metadata
    artUrl,                       // http(s): or data:image/… URL, or ''
    status,                       // 'Playing' | 'Paused' | 'Stopped'
    position, duration, rate,     // seconds; duration 0 if unknown or live
    volume,                       // 0..1
    canPlay, canPause, canGoNext, canGoPrevious, canSeek, canSetVolume,
}}
{type: 'remove', tabId: 42}
```

`update` always carries the full state; the host works out what changed and
emits `PropertiesChanged` (and `Seeked` when the position jumps).

Host → extension:

```js
{type: 'ready'}                                   // reply to hello
{type: 'command', tabId: 42, command: 'play' | 'pause' | 'playpause' | 'stop' |
    'next' | 'previous' | 'raise'}
{type: 'command', tabId: 42, command: 'seek', value: -5}        // relative, seconds
{type: 'command', tabId: 42, command: 'position', value: 30}    // absolute, seconds
{type: 'command', tabId: 42, command: 'volume', value: 0.25}    // 0..1
{type: 'command', tabId: 42, command: 'rate', value: 1.5}
```

## Cover art

`http(s)` artwork URLs are passed through as `mpris:artUrl`. Inline `data:`
images (and `blob:` ones, which the extension turns into `data:`) are written to
`$XDG_RUNTIME_DIR/earful/` and passed as `file://` URIs. They are deleted when
the tab goes away or the host exits.
