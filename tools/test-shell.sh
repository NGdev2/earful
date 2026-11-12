#!/usr/bin/env bash
# Smoke test: runs Earful in an invisible, isolated GNOME Shell with fake
# players, exercises settings, the browser-tabs registration, the settings
# window and disable/enable, then reports JS errors.
#
# Your real session is untouched: private D-Bus, throwaway home, settings
# and data dirs, its own Wayland display, no input method daemon, and every
# process it started is killed afterwards (even ones that detached).
#
# Usage: tools/test-shell.sh [seconds-per-scenario-step]   (default 3)
#        SHOTS=<dir> tools/test-shell.sh   also saves screenshots of the
#                                          menu in every style and of popups
#        KEEP_LOGS=<dir> tools/test-shell.sh   keeps the shell and bus logs

set -u
STEP=${1:-3}
SHOTS=${SHOTS:+$(realpath -m "$SHOTS")}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
UUID=earful@NGdev2.github.io
WORK=$(mktemp -d -t earful-test-XXXXXX)
MARKER="EARFUL_TEST_SESSION=$WORK"
WL="wl-test-${WORK##*-}"

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

make -s -C "$ROOT" pack >/dev/null || exit 1
EXT="$WORK/data/gnome-shell/extensions/$UUID"
mkdir -p "$EXT" "$WORK/config" "$WORK/cache" "$WORK/bin"
. "$ROOT/tools/mask-services.sh"
mask_services "$WORK/data"
# A fake home with Chrome and Firefox, for the browser-tabs registration.
# (Desktop: Ubuntu's desktop icons extension expects one.)
mkdir -p "$WORK/home/.mozilla/firefox" "$WORK/config/google-chrome" "$WORK/home/Desktop"
unzip -q "$ROOT/dist/$UUID.shell-extension.zip" -d "$EXT"
glib-compile-schemas "$EXT/schemas"
mkdir -p "$WORK/covers"
gjs -m "$ROOT/tools/make-covers.js" "$WORK/covers" || exit 1

EXTENSIONS="['$UUID']"
if [ -n "$SHOTS" ]; then
    mkdir -p "$SHOTS"
    rm -f "$SHOTS/done" "$SHOTS/settings-come-back" "$SHOTS/popup-close" \
          "$SHOTS/progress" "$SHOTS/progress-calls.log" "$SHOTS/card-layouts" "$SHOTS/list-layouts" "$SHOTS/copy-labels"
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
# A user of an older version picked a design: popups keep it after the update.
$G set $K design vinyl; $G set $K design-color amber
SHELL_DEBUG=backtrace-warnings gnome-shell --headless --wayland --no-x11 \
    --wayland-display="$WAYLAND_DISPLAY" --virtual-monitor 1280x800 > "$WORK/shell.log" 2>&1 &
# Wait until Earful is running (slow containers need more than a few seconds).
for _ in $(seq 40); do gnome-extensions info "$UUID" 2>/dev/null | grep -q 'State: ACTIVE' && break; sleep 1; done
sleep 2

# Browser tabs: Earful registers its helper with the (fake) browsers.
check() { if eval "$1"; then echo "ok - $2"; else echo "FAIL - $2"; fi >> "$WORK/checks.log"; }
check '[ "$($G get $K popup-design)" = "'"'"'vinyl'"'"'" ] && [ "$($G get $K popup-design-color)" = "'"'"'amber'"'"'" ] && [ "$($G get $K settings-version)" = 1 ]' "popups keep the design chosen before the update"
$G reset $K design; $G reset $K design-color; $G reset $K popup-design; $G reset $K popup-design-color
M=io.github.ngdev2.earful.json
CHROME="$XDG_CONFIG_HOME/google-chrome/NativeMessagingHosts/$M"
FIREFOX="$HOME/.mozilla/native-messaging-hosts/$M"
check '[ -f "$CHROME" ] && grep -q "\"path\": \"$EXT/bridge/earful-host.js\"" "$CHROME"' "Chrome registered at login"
check 'grep -q allowed_extensions "$FIREFOX"' "Firefox registered at login"
check '[ -x "$EXT/bridge/earful-host.js" ]' "helper is executable"
$G set $K browser-bridge false; sleep 1
check '[ ! -e "$CHROME" ] && [ ! -e "$FIREFOX" ]' "switch off removes the registration"
$G set $K browser-bridge true; sleep 1
check '[ -f "$CHROME" ] && [ -f "$FIREFOX" ]' "switch on registers again"

# The settings window opens on the test display without errors.
gnome-extensions prefs "$UUID"
prefs_up() {
    gdbus call --session --dest org.freedesktop.DBus --object-path /org/freedesktop/DBus \
        --method org.freedesktop.DBus.NameHasOwner org.gnome.Shell.Extensions | grep -q true
}
for _ in $(seq 15); do prefs_up && break; sleep 1; done
sleep 3
check prefs_up "settings window running"
# Spotify changes track every 2 s (for popups) but has 4 min tracks; the
# podcast is a live stream, without a length. (The progress bar test uses a
# player of its own that doesn't skip.)
FAKE_PLAYER_LENGTH=240 gjs -m "$ROOT/tools/fake-player.js" Spotify 2 "$WORK/covers" >/dev/null 2>&1 &
FAKE_PLAYER_LENGTH=0 gjs -m "$ROOT/tools/fake-player.js" Podcasts 3 >/dev/null 2>&1 &
P2=$!
sleep "$STEP"
if [ -n "$SHOTS" ]; then
    for _ in $(seq 310); do [ -e "$SHOTS/done" ] && break; sleep 1; done
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
if [ -n "$SHOTS" ]; then
    for _ in $(seq 60); do [ -e "$SHOTS/settings-come-back" ] && break; sleep 1; done
    check 'grep -qx "covered true" "$SHOTS/settings-come-back"' "settings covered by another window"
    check 'grep -qx "raised true" "$SHOTS/settings-come-back"' "Settings in the menu brings them back"
    check 'grep -qx "windows 1" "$SHOTS/settings-come-back"' "still one settings window"
    check 'grep -qx "quiet true" "$SHOTS/settings-come-back"' "no note for Earful's own settings"
    check 'grep -qx "other raised true" "$SHOTS/settings-come-back"' "another extension's settings come forward"
    check 'grep -qx "noted true" "$SHOTS/settings-come-back"' "with a note to close them"
    check 'grep -qx "close shown true" "$SHOTS/popup-close"' "popups have a close button"
    check 'grep -qx "hover true" "$SHOTS/popup-close"' "the pointer reaches it"
    check 'grep -qx "closing true" "$SHOTS/popup-close"' "the close button closes the popup"
    check 'grep -qx "raised false" "$SHOTS/popup-close"' "without raising the player"
    check 'grep -qx "gone true" "$SHOTS/popup-close"' "and the popup is gone"
    P="$SHOTS/progress"
    check 'grep -qx "shown true" "$P" && grep -qx "length 4:00" "$P"' "progress bar shows for a player with a length"
    check 'grep -qx "advances true" "$P"' "elapsed time advances"
    check 'grep -qx "seek true" "$P"' "dragging the bar seeks the player"
    check 'grep -qx "wheel true" "$P"' "the mouse wheel on the time bar doesn't seek"
    check 'grep -qx "nobar true" "$P"' "no bar for a player without a length"
    check 'grep -qx "clockruns true" "$P"' "the progress clock runs while the menu is open"
    check 'grep -qx "clockstops true" "$P"' "the progress clock stops when the menu closes"
    check 'grep -qx "list true" "$P"' "list rows show progress"
    check 'grep -qx "compact true" "$P"' "compact rows have no progress"
    check 'grep -qx "longname true" "$P"' "a very long site name is cut, not widening the menu"
    check 'grep -qx "refused true" "$P"' "a player that ignores seeking gets a fixed bar"
    check 'grep -qx "slow true" "$P"' "a slow seek unlocks the bar when it lands"
    check 'grep -qx "announced true" "$P"' "an announced position is used"
    check 'grep -qx "reread true" "$P"' "a silent jump is found within 5 seconds"
    check '! grep -q "^error" "$P"' "progress test ran without errors"
    C="$SHOTS/card-layouts"
    check '[ "$(grep -cE "^(standing|side)-volume-[a-z]+ true$" "$C")" = 8 ]' "both card layouts show all 4 volume styles"
    check 'grep -qx "slim true" "$C"' "slim cards: edge progress grows on hover, slide-out volume"
    check '[ "$(grep -cE "^cover-[a-z]+ true$" "$C")" = 10 ]' "volume on the cover shows all 10 animations"
    check '! grep -q "^error" "$C"' "card layout test ran without errors"
    L="$SHOTS/list-layouts"
    check 'grep -qx "cover-volume-time-left true" "$L"' "list: volume on the cover with the edge progress"
    check 'grep -qx "one-line-time-left true" "$L"' "list: one line, two jobs"
    check 'grep -qx "two-bars-time-left true" "$L" && grep -qx "two-bars-volume-left true" "$L"' "list: two bars, both orders"
    check '! grep -q "^error" "$L"' "list layout test ran without errors"
    Y="$SHOTS/copy-labels"
    check 'grep -qx "copy true" "$Y"' "clicking a card title copies it"
    check 'grep -qx "slide true" "$Y" && grep -qx "back true" "$Y"' "a long title slides and comes back"
    check 'grep -qx "listoff true" "$Y"' "list rows don't copy by default"
    check 'grep -qx "compactplain true" "$Y"' "compact rows keep plain labels"
    check '! grep -q "^error" "$Y"' "copy test ran without errors"
fi
gnome-extensions disable "$UUID"; sleep 2
echo "after disable: $(gnome-extensions info "$UUID" | grep -o 'State: .*')"
gnome-extensions enable "$UUID"; sleep 2
kill $P2; sleep "$STEP"
echo "after enable:  $(gnome-extensions info "$UUID" | grep -o 'State: .*')"
$G reset-recursively $K
EOF

# Everything started on the private bus (including the settings window)
# inherits this environment, so it can only reach the test display.
env -u DISPLAY "$MARKER" EXT="$EXT" UUID="$UUID" EXTENSIONS="$EXTENSIONS" \
    SHOTS="$SHOTS" EARFUL_SHOTS="$SHOTS" ROOT="$ROOT" WORK="$WORK" STEP="$STEP" \
    PATH="$WORK/bin:$PATH" HOME="$WORK/home" WAYLAND_DISPLAY="$WL" GDK_BACKEND=wayland \
    XDG_DATA_HOME="$WORK/data" XDG_CONFIG_HOME="$WORK/config" XDG_CACHE_HOME="$WORK/cache" \
    timeout 430 dbus-run-session -- bash "$WORK/scenario.sh" 2>"$WORK/bus.log"

[ -n "$SHOTS" ] && cp "$WORK/shell.log" "$WORK/bus.log" "$SHOTS/"
[ -n "${KEEP_LOGS:-}" ] && mkdir -p "$KEEP_LOGS" && cp "$WORK/shell.log" "$WORK/bus.log" "$KEEP_LOGS/"
cat "$WORK/checks.log" 2>/dev/null
errors=$(grep -E "JS ERROR|JS WARNING|earful" "$WORK/shell.log"
         grep -E "JS ERROR|JS WARNING|CRITICAL" "$WORK/bus.log"
         grep FAIL "$WORK/checks.log" 2>/dev/null
         [ -s "$WORK/checks.log" ] || echo "no checks ran")
if [ -n "$errors" ]; then
    echo "FAIL:"; echo "$errors"
    exit 1
fi
echo "PASS: no JS errors or warnings"
