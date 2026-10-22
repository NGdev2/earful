#!/usr/bin/env bash
# Records the README media into docs/media/: GIFs of popups, the menu and
# every design, plus stills of menu styles, popups and settings.
#
# Everything happens in an invisible, isolated GNOME Shell (like
# tools/test-shell.sh) with fake players and drawn covers, and its own empty
# home folder, so nothing from your desktop can end up in the pictures.
#
# Needs: gnome-shell, gjs, ffmpeg.   Usage: tools/record-demo.sh [out-dir]

set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT=$(realpath -m "${1:-$ROOT/docs/media}")
UUID=earful@NGdev2.github.io
WORK=$(mktemp -d -t earful-demo-XXXXXX)
MARKER="EARFUL_TEST_SESSION=$WORK"

cleanup() {
    # Kill everything that carries our marker in its environment.
    for env in /proc/[0-9]*/environ; do
        if grep -qzx -- "$MARKER" "$env" 2>/dev/null; then
            pid=${env#/proc/}; pid=${pid%/environ}
            [ "$pid" != $$ ] && kill -9 "$pid" 2>/dev/null
        fi
    done
    rm -rf "$WORK"
}
trap cleanup EXIT INT TERM

command -v ffmpeg >/dev/null || { echo "ffmpeg is needed"; exit 1; }
make -s -C "$ROOT" pack >/dev/null || exit 1
EXTS="$WORK/data/gnome-shell/extensions"
mkdir -p "$EXTS/$UUID" "$WORK/config" "$WORK/cache" "$WORK/bin" "$WORK/home" \
    "$WORK/covers" "$WORK/frames"
unzip -q "$ROOT/dist/$UUID.shell-extension.zip" -d "$EXTS/$UUID"
glib-compile-schemas "$EXTS/$UUID/schemas"
mkdir -p "$EXTS/earful-demo@test"
cp "$ROOT/tools/demo/extension.js" "$ROOT/tools/demo/metadata.json" "$EXTS/earful-demo@test/"
gjs -m "$ROOT/tools/demo/covers.js" "$WORK/covers" || exit 1

# Songs shown in the demo: [title, artist, album, cover]. Real songs, but
# the covers are our own drawings (album art is the artists' copyright).
C="$WORK/covers"
# Order matters: Spotify skips once for the hero, once in the menu, then
# once per popup design (vinyl, cassette, road, equalizer).
cat > "$WORK/spotify.json" <<EOF
[["HUNTING FOR YOUR DREAM", "GALNERYUS", "", "$C/neon-tides.png"],
 ["Wonderful Life", "Black", "", "$C/golden-hour.png"],
 ["Tender Love", "Mounika.", "", "$C/velvet-static.png"],
 ["Enter One", "Sol Seppy", "", "$C/low-orbit.png"],
 ["Crab Rave", "Noisestorm", "", "$C/ocean-drive.png"]]
EOF
cat > "$WORK/youtube.json" <<EOF
[["Enter One", "Sol Seppy", "", "$C/low-orbit.png"],
 ["death bed (coffee for your head)", "Powfu", "", "$C/night-signals.png"]]
EOF
cat > "$WORK/soundcloud.json" <<EOF
[["Crab Rave", "Noisestorm", "", "$C/ocean-drive.png"]]
EOF

# The shell spawns ibus-daemon when systemd is unreachable (as on our
# private bus); a stand-in keeps it from running and outliving the run.
printf '#!/bin/sh\nexit 0\n' > "$WORK/bin/ibus-daemon"
chmod +x "$WORK/bin/ibus-daemon"

cat > "$WORK/scenario.sh" <<'EOF'
gsettings set org.gnome.shell enabled-extensions "['$UUID', 'earful-demo@test']"
# No desktop icons; a dark look suits a media app.
gsettings set org.gnome.shell disabled-extensions "['ding@rastersoft.com']"
gsettings set org.gnome.desktop.interface color-scheme prefer-dark
gsettings set org.gnome.desktop.interface gtk-theme Yaru-dark 2>/dev/null
env -u DISPLAY gnome-shell --headless --wayland --no-x11 \
    --virtual-monitor 1280x800 > "$WORK/shell.log" 2>&1 &
sleep 5
player() {
    env FAKE_PLAYER_BUS="$1" FAKE_PLAYER_IDENTITY="$2" FAKE_PLAYER_DESKTOP="$3" \
        FAKE_PLAYER_TRACKS="$WORK/$4.json" \
        gjs -m "$ROOT/tools/fake-player.js" "$4" 0 >/dev/null 2>&1 &
}
player spotify "Spotify" spotify_spotify spotify
player earful_tab_101.instance4242 "YouTube — Google Chrome" google-chrome youtube
player earful_tab_102.instance4242 "SoundCloud — Google Chrome" google-chrome soundcloud
for _ in $(seq 180); do [ -e "$WORK/frames/done" ] && break; sleep 1; done
EOF

echo "Recording (about two minutes)..."
env "$MARKER" UUID="$UUID" ROOT="$ROOT" WORK="$WORK" EARFUL_DEMO_OUT="$WORK/frames" \
    PATH="$WORK/bin:$PATH" HOME="$WORK/home" \
    XDG_DATA_HOME="$WORK/data" XDG_CONFIG_HOME="$WORK/config" XDG_CACHE_HOME="$WORK/cache" \
    timeout 240 dbus-run-session -- bash "$WORK/scenario.sh" 2>/dev/null

if grep -E "JS ERROR|earful-demo" "$WORK/shell.log"; then
    echo "The recording hit errors (above)."
fi

mkdir -p "$OUT"
F="$WORK/frames"
for clip in hero menu designs; do
    [ -e "$F/$clip/frames.txt" ] || { echo "missing clip: $clip"; continue; }
    # A palette per clip keeps colors true and files small.
    ffmpeg -v error -y -f concat -safe 0 -i "$F/$clip/frames.txt" \
        -vf "fps=15,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle" \
        -loop 0 "$OUT/$clip.gif" && echo "  $OUT/$clip.gif"
done
if [ -e "$F/style-cards.png" ]; then
    gjs -m "$ROOT/tools/demo/compose.js" "$OUT/styles.png" 3 \
        "$F/style-cards.png" "$F/style-list.png" "$F/style-compact.png" && echo "  $OUT/styles.png"
fi
if [ -e "$F/popup-vinyl.png" ]; then
    gjs -m "$ROOT/tools/demo/compose.js" "$OUT/popups.png" 2 \
        "$F"/popup-{vinyl,cassette,road,leds}.png && echo "  $OUT/popups.png"
fi
[ -e "$F/settings.png" ] && cp "$F/settings.png" "$OUT/settings.png" && echo "  $OUT/settings.png"
exit 0
