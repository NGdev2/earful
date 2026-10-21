# Earful native host

A small [gjs](https://gitlab.gnome.org/GNOME/gjs) program that the browser
starts for the [Earful Bridge extension](../chromium-extension/). It publishes
one [MPRIS](https://specifications.freedesktop.org/mpris-spec/latest/) player
per browser tab with media, so any MPRIS client (Earful, GNOME's own media
controls, `playerctl`) sees each tab separately.

```bash
make bridge-install        # register with Chromium / Chrome / Brave / Edge
make bridge-uninstall
make bridge-test           # host only, on a private D-Bus session
make bridge-test-browser   # plus a throwaway headless Chrome profile
```

`install.sh` writes `io.github.ngdev2.earful.json` into
`~/.config/<browser>/NativeMessagingHosts/` for each browser that has a profile,
pointing at `earful-host.js` in this folder, so keep the checkout where it is.

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
- `Identity` is `"<site> — <browser>"`, e.g. `YouTube — Google Chrome`.
  `DesktopEntry` is the browser's desktop file id (`google-chrome`,
  `chromium`, …) from `$CHROME_DESKTOP` if the launcher sets it, otherwise
  from the extension.
- Players come and go with their tabs. When the browser quits or the
  extension goes away, every name is released.

## Native messaging protocol

Each message is a 4-byte native-endian length, then UTF-8 JSON.

Extension → host:

```js
{type: 'hello', browser: {name: 'Google Chrome', desktopEntry: 'google-chrome'}, version: '0.1.0'}
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
{type: 'ready', version: '0.1.0'}                 // reply to hello
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
