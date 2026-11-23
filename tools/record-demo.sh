#!/usr/bin/env bash
# Records the README media into docs/media/: GIFs of popups, the menu, every
# design, the card and list layouts, seeking, volume on the cover and copying
# titles, plus stills of menu styles, popups and the settings pages.
#
# Everything happens in an invisible, isolated GNOME Shell (like
# tools/test-shell.sh) with fake players and drawn covers, and its own empty
# home folder, so nothing from your desktop can end up in the pictures.
#
# Needs: gnome-shell, gjs, ffmpeg.
# Usage: tools/record-demo.sh [out-dir] [scene,...]
#   Scenes, all by default: hero menu designs styles progress cards liquid
#   list copy popups settings. popup-styles and looks (the stills for
#   docs/looks.md, into docs/media/looks/) run only when named.
#   Through make: DEMO_SCENES=cards,list make demo

set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT=$(realpath -m "${1:-$ROOT/docs/media}")
SCENES=${2:-${DEMO_SCENES:-}}
UUID=earful@NGdev2.github.io
WORK=$(mktemp -d -t earful-demo-XXXXXX)
MARKER="EARFUL_TEST_SESSION=$WORK"
WL="wl-demo-${WORK##*-}"
# GIFs bigger than this are made again with fewer colors.
MAX_GIF=1000000
START=$(date +%s)

cleanup() {
    # Kill everything that carries our marker in its environment.
    for env in /proc/[0-9]*/environ; do
        if grep -qzx -- "$MARKER" "$env" 2>/dev/null; then
            pid=${env#/proc/}; pid=${pid%/environ}
            [ "$pid" != $$ ] && kill -9 "$pid" 2>/dev/null
        fi
    done
    rm -rf "$WORK"
    rm -f "${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/$WL" "${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/$WL.lock"
}
trap cleanup EXIT INT TERM

command -v ffmpeg >/dev/null || { echo "ffmpeg is needed"; exit 1; }
make -s -C "$ROOT" pack >/dev/null || exit 1
EXTS="$WORK/data/gnome-shell/extensions"
EXT="$EXTS/$UUID"
mkdir -p "$EXT" "$WORK/config" "$WORK/cache" "$WORK/bin" "$WORK/home" \
    "$WORK/covers" "$WORK/frames"
. "$ROOT/tools/mask-services.sh"
mask_services "$WORK/data"
unzip -q "$ROOT/dist/$UUID.shell-extension.zip" -d "$EXT"
glib-compile-schemas "$EXT/schemas"
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
# The last one, a video title as YouTube has them, is long enough to slide.
cat > "$WORK/youtube.json" <<EOF
[["Enter One", "Sol Seppy", "", "$C/low-orbit.png"],
 ["death bed (coffee for your head)", "Powfu", "", "$C/night-signals.png"],
 ["Noisestorm - Crab Rave [Monstercat Release]", "Monstercat", "", "$C/ocean-drive.png"]]
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
# No popups while the players appear; the director turns them on where needed.
gsettings --schemadir "$EXT/schemas" set org.gnome.shell.extensions.earful toasts-enabled false
gnome-shell --headless --wayland --no-x11 --wayland-display="$WAYLAND_DISPLAY" \
    --virtual-monitor 1280x800 > "$WORK/shell.log" 2>&1 &
for _ in $(seq 30); do
    gnome-extensions info "$UUID" 2>/dev/null | grep -qE 'State: (ACTIVE|ENABLED)' && break
    sleep 1
done
player() {
    env FAKE_PLAYER_BUS="$1" FAKE_PLAYER_IDENTITY="$2" FAKE_PLAYER_DESKTOP="$3" \
        FAKE_PLAYER_TRACKS="$WORK/$4.json" \
        gjs -m "$ROOT/tools/fake-player.js" "$4" 0 >/dev/null 2>&1 &
}
player spotify "Spotify" spotify_spotify spotify
player earful_tab_101.instance4242 "YouTube — Google Chrome" google-chrome youtube
player earful_tab_102.instance4242 "SoundCloud — Google Chrome" google-chrome soundcloud
for _ in $(seq 420); do [ -e "$WORK/frames/done" ] && break; sleep 1; done
EOF

echo "Recording ${SCENES:-every scene} (all of them take about three minutes)..."
# Everything started on the private bus (including the settings window)
# inherits this environment, so it can only reach the demo display. The
# desktop portal is masked, so libadwaita reads the dark style from GSettings.
env -u DISPLAY "$MARKER" ADW_DISABLE_PORTAL=1 UUID="$UUID" ROOT="$ROOT" WORK="$WORK" EXT="$EXT" \
    EARFUL_DEMO_OUT="$WORK/frames" EARFUL_DEMO_SCENES="$SCENES" \
    PATH="$WORK/bin:$PATH" HOME="$WORK/home" WAYLAND_DISPLAY="$WL" GDK_BACKEND=wayland \
    XDG_DATA_HOME="$WORK/data" XDG_CONFIG_HOME="$WORK/config" XDG_CACHE_HOME="$WORK/cache" \
    timeout 480 dbus-run-session -- bash "$WORK/scenario.sh" 2>/dev/null
[ -e "$WORK/frames/done" ] || echo "The recording did not finish in time."

if grep -E "JS ERROR|earful-demo" "$WORK/shell.log"; then
    echo "The recording hit errors (above)."
fi
[ -n "${KEEP_LOGS:-}" ] && mkdir -p "$KEEP_LOGS" && cp "$WORK/shell.log" "$KEEP_LOGS/"

# A palette per clip keeps colors true and files small; too big a GIF is
# made again with fewer colors.
gif() {
    local list=$1 out=$2 colors crop=""
    # A clip may keep only part of what was recorded (see cropTo()).
    [ -e "$(dirname "$list")/crop" ] && crop="crop=$(cat "$(dirname "$list")/crop"),"
    for colors in 256 160 96 64; do
        ffmpeg -v error -y -f concat -safe 0 -i "$list" \
            -vf "${crop}fps=15,split[a][b];[a]palettegen=max_colors=$colors:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle" \
            -loop 0 "$out" || return 1
        [ "$(stat -c %s "$out")" -le "$MAX_GIF" ] && break
    done
    echo "  $out ($(( $(stat -c %s "$out") / 1024 )) KB)"
}

mkdir -p "$OUT"
F="$WORK/frames"
for list in "$F"/*/frames.txt; do
    [ -e "$list" ] || continue
    clip=$(basename "$(dirname "$list")")
    gif "$list" "$OUT/$clip.gif"
done
if [ -e "$F/style-cards.png" ]; then
    gjs -m "$ROOT/tools/demo/compose.js" "$OUT/styles.png" 3 \
        "$F/style-cards.png" "$F/style-list.png" "$F/style-compact.png" && echo "  $OUT/styles.png"
fi
if [ -e "$F/popup-vinyl.png" ]; then
    gjs -m "$ROOT/tools/demo/compose.js" "$OUT/popups.png" 2 \
        "$F"/popup-{vinyl,cassette,road,leds}.png && echo "  $OUT/popups.png"
fi
if [ -e "$F/settings-menu.png" ]; then
    for page in menu popups behaviour; do
        cp "$F/settings-$page.png" "$OUT/settings-$page.png" && echo "  $OUT/settings-$page.png"
    done
    # The first page is also the README's settings picture.
    cp "$F/settings-menu.png" "$OUT/settings.png" && echo "  $OUT/settings.png"
    gjs -m "$ROOT/tools/demo/compose.js" "$OUT/settings-pages.png" 3 \
        "$F"/settings-{menu,popups,behaviour}.png && echo "  $OUT/settings-pages.png"
fi
if [ -d "$F/looks" ]; then
    mkdir -p "$OUT/looks"
    cp "$F"/looks/*.png "$OUT/looks/" && echo "  $OUT/looks/ ($(ls "$F/looks" | wc -l) stills)"
fi
echo "Done in $(( $(date +%s) - START )) s."
exit 0
