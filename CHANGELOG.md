# Changelog

## Unreleased (0.3.0)

New
- Track progress: elapsed time, a bar you can drag to seek, and the length. Live streams show no bar. When a site ignores a seek (YouTube during an ad), the bar locks until the next track instead of jumping back and forth.
- Card layouts: volume on the right (new default), volume beside the cover, slim, and volume on the cover.
- A standing volume in four styles: LED steps (default), knob, pill and line.
- Volume on the cover: scroll on the cover to change the volume, with one of ten animations. The default, Liquid, fills the cover like a glass of water.
- The art of a card design (vinyl, cassette and the others) dims as you turn its player down; a switch in Settings turns that off.
- A player without a cover takes the colors of its app's icon instead of plain grey.
- List layouts: volume on the cover (new default), one line for progress and volume, and two bars side by side.
- Copy a title or artist with a click; long titles slide on hover.
- Popup styles: controls on hover (new default), classic, Next with a countdown line, mini pill, island and big cover.
- A close button on popups (thanks @KevenGoncalves, #4).
- Settings in three pages (Menu, Popups, Behaviour). Popups have their own design, and options are greyed out where they don't apply.
- Settings show which browsers the add-on has connected from, and "Get the add-on" opens the store in that browser.
- Browser tabs work in Brave Origin (thanks u/Serenase).

Fixed
- Settings come to the front when they are already open (#6).
- Long site names end in "…" instead of widening the menu.

## 0.2.3 (2026-11-05)

New
- Earful Bridge is on [Firefox Add-ons](https://addons.mozilla.org/firefox/addon/earful-bridge/). The Firefox button in Settings, the README and the install message now point there, so Firefox users no longer load it by hand.

## 0.2.2 (2026-11-04)

New
- Click the speaker icon next to a volume slider to mute; click again to bring the volume back.
- "Show track in top bar" switch right in the menu (thanks @KevenGoncalves, #2).
- Popups: the shadow keeps its round corners while the colors change, and a new Shadow switch in Settings (thanks @KevenGoncalves, #3).

Fixed
- No error in the system log when a player disappears while it appears.
- Menu switches no longer save their setting twice on GNOME 47 and newer.
- The browser helper checks what the browser add-on sends, and no longer prints a deprecation warning on GNOME 50 and 51.

Changed
- Code cleanup following the extensions.gnome.org guidelines: unused code removed, GNOME's standard APIs instead of hand-written helpers.
- Only the Chrome Web Store ID of the add-on is accepted (the old development ID is gone). If you loaded an old copy unpacked, reload it from `~/.local/share/earful/browser-extension`.

## 0.2.1 (2026-11-02)

- The browser add-on has its Chrome Web Store ID, also when loaded unpacked, so the store version works with Earful.

## 0.2.0 (2026-11-02)

- One-command install: `curl -fsSL https://raw.githubusercontent.com/NGdev2/earful/main/install.sh | sh`, then a restart. Earful switches itself on.
- Browser tabs set themselves up: Earful registers its helper with Chrome, Chromium, Brave, Edge, Vivaldi, Opera and Firefox. A Browser tabs section in Settings shows the status.
- Firefox support for browser tabs, including Snap Firefox.
- The add-on opens a short welcome page if Earful isn't installed yet.
- GNOME 51 support (GNOME 46 to 51).
- Shorter README without emojis; privacy policy.
