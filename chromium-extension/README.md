# Earful Bridge for Chromium and Google Chrome

Chromium shows only **one** media player to the desktop: whichever tab played
last. With three YouTube tabs open, two of them are invisible to GNOME.

This extension, together with the small [native host](../native-host/), gives
**every tab that plays media its own player**, so Earful can list and control
each one: title, artist, cover, play / pause, next / previous, volume, and a
click that jumps right to the tab.

## Install

1. Open `chrome://extensions`, turn on **Developer mode**, click
   **Load unpacked** and pick this `chromium-extension` folder.
   The extension ID is always `gjpjaodbgfodpakidffoooacjemeidmn`.
2. From the repository root, register the native host:

   ```bash
   make bridge-install      # make bridge-uninstall to undo
   ```

3. Reload tabs that were already open, or just start something new. If the
   extension was loaded before the host was installed, click its reload
   button once so it connects right away.

Needs `gjs`, which every GNOME desktop already has.

## Privacy

The extension runs on every page, because media can play on any site. What it
sees never leaves your computer:

- It reads only media information: the title, artist, album and cover the page
  publishes for media keys, the page title and site name, and whether a video
  or audio element is playing. It never reads page content, form fields,
  cookies or history.
- Pages without media send nothing at all.
- The only thing it talks to is the native host on your own machine, which
  only talks to your desktop's session bus (D-Bus). No network requests, no
  analytics, no remote code.

## Permissions

| Permission | Why |
| --- | --- |
| `nativeMessaging` | Talk to the local native host that publishes the players on D-Bus. |
| Content scripts on `<all_urls>`, all frames | Notice media on any site, including players embedded in other pages. This is what shows the "read and change data on all websites" warning; nothing is read beyond the media details listed above. |

Raising a tab uses `chrome.tabs.update` and `chrome.windows.update`, which need
no extra permission. There is no `tabs`, `history`, `storage` or host
permission.

## How it works

```
page.js (page world) ──DOM events──> relay.js (isolated world) ──port──> background.js ──native messaging──> earful-host.js ──D-Bus──> Earful
```

- **`content/page.js`** runs in the page's own JavaScript world (`"world": "MAIN"`)
  at `document_start`, before any site code. Sites register their play /
  pause / next / previous logic with `navigator.mediaSession.setActionHandler()`,
  and the browser offers no way for an extension to call those handlers. So
  page.js wraps `setActionHandler()` and keeps a copy of each handler; pressing
  Next in Earful then runs exactly what a hardware media key would. It also
  hooks `HTMLMediaElement.play()` to find players that are never added to the
  page (`new Audio()`), and picks the element worth controlling: playing,
  audible and longer than a few seconds.
- **`content/relay.js`** runs in the extension's isolated world. It treats
  everything from the page as untrusted, keeps only known fields with sane
  sizes, and opens a port to the service worker only while the frame has media.
- **`background.js`** keeps the state of each tab (the best frame wins:
  playing first, then most recent), starts the native host when there is
  something to show, restarts it with backoff if it dies, and lets it sleep
  after a minute without media. Closing a tab or leaving the page closes its
  port, which removes the player.

## Limitations

- **Next / previous only work where the site supports media keys**, i.e. it
  registered `nexttrack` / `previoustrack` handlers (YouTube playlists, YouTube
  Music, Spotify, SoundCloud and most music sites do). Elsewhere Earful shows
  those buttons as unavailable, just like Chromium itself would.
- Play and pause use the site's handlers when present, otherwise the media
  element directly. Volume always sets the media element, so a site's own
  volume slider may not move along.
- Media in closed shadow roots that starts by itself, Web Audio without Media
  Session metadata, and pages where extensions can't run (`chrome://`, the
  Web Store) are not detected.
- Tabs that were open before the extension was installed or updated need a
  reload.
- Chromium's own single player still exists next to the per-tab ones. The
  bridge's bus names tell Earful which one to hide (see
  [native-host/README.md](../native-host/README.md)).
