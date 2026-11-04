# Changelog

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
