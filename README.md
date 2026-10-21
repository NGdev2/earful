<div align="center">

# 🎧 Earful

**Every player, one click away.**

See and control everything that plays on your Linux desktop — Spotify, YouTube tabs, Twitch, podcasts —
from one button in the top bar. Catch the song name in a gentle popup, then get back to work.

<!-- Demo GIF goes here: docs/media/demo.gif -->

![GNOME 46–48](https://img.shields.io/badge/GNOME-46%E2%80%9348-4a86cf?logo=gnome&logoColor=white)
![License: GPL-3.0](https://img.shields.io/badge/license-GPL--3.0-blue)
![Status: early](https://img.shields.io/badge/status-early%20preview-orange)

</div>

---

## Why Earful?

🎵 **"Who sings this?"** — when the track changes, a small card fades in with the cover, title and artist, then quietly fades out. Several changes at once stack neatly and slide into place.

🧭 **One click, every player** — all your players in one list, each with its own play / pause / next. Click a track to jump straight to its app.

🤫 **Focus mode** — deep in code? One shortcut (<kbd>Super</kbd> + <kbd>Shift</kbd> + <kbd>M</kbd>) silences every popup. No popups over fullscreen games or while Do Not Disturb is on.

🎚️ **You decide** — popup position, duration, how many at once, and which players are allowed to show them.

## Coming next

- 🗂️ **Every browser tab as its own player** — three YouTube tabs, three rows (Chromium first)
- 🔊 **Volume per player**, plus apps that only play sound (games, calls) like a mini mixer
- ⏯️ **Pause others when one starts** — optional, with exceptions
- ⌨️ **Choose which player your media keys control** — last active or pinned
- 🙈 **Ignore list** for autoplay noise

## Install

> Earful is in early preview. A one-click install from extensions.gnome.org is on the way.

```bash
git clone https://github.com/NGdev2/earful.git
cd earful
make install
```

Then log out and back in (on X11 you can press <kbd>Alt</kbd> + <kbd>F2</kbd>, type `r`, Enter) and run:

```bash
gnome-extensions enable earful@NGdev2.github.io
```

## How it works

Earful listens to [MPRIS](https://specifications.freedesktop.org/mpris-spec/latest/), the standard way Linux media players share what they play. Anything that supports it — Spotify, browsers, VLC, Rhythmbox, Firefox, Chromium and more — shows up automatically. Nothing leaves your computer.

## Contributing

Ideas, bugs and pull requests are welcome — open an [issue](https://github.com/NGdev2/earful/issues).
Test without real music using the fake player: `gjs -m tools/fake-player.js MyPlayer 5`.

## License

[GPL-3.0](LICENSE)
