#!/usr/bin/env bash
# Smoke test: runs Earful in an invisible, isolated GNOME Shell with fake
# players, exercises settings and disable/enable, then reports JS errors.
#
# Your real session is untouched: private D-Bus, throwaway settings and
# data dirs, no input method daemon, and every process it started is
# killed afterwards (even ones that detached).
#
# Usage: tools/test-shell.sh [seconds-per-scenario-step]   (default 3)
#        SHOTS=<dir> tools/test-shell.sh   also saves screenshots of the
#                                          menu in every style and of popups

set -u
STEP=${1:-3}
SHOTS=${SHOTS:+$(realpath -m "$SHOTS")}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
UUID=earful@NGdev2.github.io
WORK=$(mktemp -d -t earful-test-XXXXXX)
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

make -s -C "$ROOT" pack >/dev/null || exit 1
EXT="$WORK/data/gnome-shell/extensions/$UUID"
mkdir -p "$EXT" "$WORK/config" "$WORK/cache" "$WORK/bin"
unzip -q "$ROOT/dist/$UUID.shell-extension.zip" -d "$EXT"
glib-compile-schemas "$EXT/schemas"
mkdir -p "$WORK/covers"
gjs -m "$ROOT/tools/make-covers.js" "$WORK/covers" || exit 1

EXTENSIONS="['$UUID']"
if [ -n "$SHOTS" ]; then
    mkdir -p "$SHOTS"
    rm -f "$SHOTS/done"
    cp -r "$ROOT/tools/shots-helper" "$WORK/data/gnome-shell/extensions/earful-shots@test"
    EXTENSIONS="['$UUID', 'earful-shots@test']"
fi

# The shell spawns ibus-daemon when systemd is unreachable (as on our
# private bus); a stand-in keeps it from running and outliving the test.
printf '#!/bin/sh\nexit 0\n' > "$WORK/bin/ibus-daemon"
chmod +x "$WORK/bin/ibus-daemon"

cat > "$WORK/scenario.sh" <<'EOF'
G="gsettings --schemadir $EXT/schemas"
K=org.gnome.shell.extensions.earful
gsettings set org.gnome.shell enabled-extensions "$EXTENSIONS"
env -u DISPLAY gnome-shell --headless --wayland --no-x11 \
    --virtual-monitor 1280x800 > "$WORK/shell.log" 2>&1 &
sleep 6
gjs -m "$ROOT/tools/fake-player.js" Spotify 2 "$WORK/covers" >/dev/null 2>&1 &
gjs -m "$ROOT/tools/fake-player.js" Podcasts 3 >/dev/null 2>&1 &
P2=$!
sleep "$STEP"
if [ -n "$SHOTS" ]; then
    for _ in $(seq 100); do [ -e "$SHOTS/done" ] && break; sleep 1; done
    rm -f "$SHOTS/done"
fi
for kv in "toast-position bottom-left" "show-panel-label true" \
          "show-audio-only-apps true" "pause-others true" \
          "media-keys-target last-active" "media-keys-target pinned" \
          "media-keys-pinned spotify" "focus-mode true" "focus-mode false"; do
    $G set $K $kv
    sleep 1
done
sleep "$STEP"
gnome-extensions disable "$UUID"; sleep 2
echo "after disable: $(gnome-extensions info "$UUID" | grep -o 'State: .*')"
gnome-extensions enable "$UUID"; sleep 2
kill $P2; sleep "$STEP"
echo "after enable:  $(gnome-extensions info "$UUID" | grep -o 'State: .*')"
$G reset-recursively $K
EOF

env "$MARKER" EXT="$EXT" UUID="$UUID" EXTENSIONS="$EXTENSIONS" \
    SHOTS="$SHOTS" EARFUL_SHOTS="$SHOTS" ROOT="$ROOT" WORK="$WORK" STEP="$STEP" \
    PATH="$WORK/bin:$PATH" \
    XDG_DATA_HOME="$WORK/data" XDG_CONFIG_HOME="$WORK/config" XDG_CACHE_HOME="$WORK/cache" \
    timeout 200 dbus-run-session -- bash "$WORK/scenario.sh" 2>/dev/null

errors=$(grep -E "JS ERROR|JS WARNING|earful" "$WORK/shell.log")
if [ -n "$errors" ]; then
    echo "FAIL:"; echo "$errors"
    exit 1
fi
echo "PASS: no JS errors or warnings"
