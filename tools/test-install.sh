#!/usr/bin/env bash
# Tests install.sh the way a user runs it (from a downloaded archive of
# this checkout), then --uninstall. Runs on a private D-Bus session with a
# throwaway home and settings, so your real GNOME setup is never touched.
#
# Usage: tools/test-install.sh   (or: make test-install)

set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd)
UUID=earful@NGdev2.github.io
WORK=$(mktemp -d -t earful-install-XXXXXX)
MARKER="EARFUL_TEST_SESSION=$WORK"

cleanup() {
    for env in /proc/[0-9]*/environ; do
        if grep -qzx -- "$MARKER" "$env" 2>/dev/null; then
            pid=${env#/proc/}; pid=${pid%/environ}
            [ "$pid" != $$ ] && kill -9 "$pid" 2>/dev/null
        fi
    done
    rm -rf "$WORK"
}
trap cleanup EXIT INT TERM

# What GitHub would serve: the checkout's files (committed or not) in one
# top-level folder.
(cd "$ROOT" && git ls-files -co --exclude-standard -z |
    grep -zv '^promo/' |
    tar --null -czf "$WORK/earful.tar.gz" --transform 's,^,earful-test/,' -T -)

mkdir -p "$WORK/home/.config/google-chrome" "$WORK/home/.mozilla/firefox"
. "$ROOT/tools/mask-services.sh"
mask_services "$WORK/home/.local/share"

cat > "$WORK/scenario.sh" <<'EOF'
check() { if eval "$1"; then echo "ok - $2"; else echo "FAIL - $2"; fi; }
EXT="$XDG_DATA_HOME/gnome-shell/extensions/$UUID"
M=io.github.ngdev2.earful.json
CHROME="$XDG_CONFIG_HOME/google-chrome/NativeMessagingHosts/$M"
FIREFOX="$HOME/.mozilla/native-messaging-hosts/$M"
enabled() { gsettings get org.gnome.shell enabled-extensions; }

# Another extension is on; Earful was once switched off.
gsettings set org.gnome.shell enabled-extensions "['other@test']"
gsettings set org.gnome.shell disabled-extensions "['$UUID']"

sh "$ROOT/install.sh" > "$WORK/install.log" 2>&1
check '[ $? -eq 0 ]' "install succeeds"
check '[ -f "$EXT/metadata.json" ] && [ -f "$EXT/schemas/org.gnome.shell.extensions.earful.gschema.xml" ]' "extension installed"
check '[ -x "$EXT/bridge/earful-host.js" ] && [ -f "$EXT/bridge/lib/tab-player.js" ]' "helper installed and executable"
check '[ "$(enabled)" = "['"'"'other@test'"'"', '"'"'$UUID'"'"']" ]' "switched on, other extensions kept"
check '! gsettings get org.gnome.shell disabled-extensions | grep -q earful' "removed from the switched-off list"
check 'grep -q "\"path\": \"$EXT/bridge/earful-host.js\"" "$CHROME"' "Chrome set up right away"
check 'grep -q allowed_extensions "$FIREFOX"' "Firefox set up right away"
check '[ -f "$XDG_DATA_HOME/earful/browser-extension/manifest.json" ]' "add-on copied for Load unpacked"
check 'grep -q "Restart your computer" "$WORK/install.log"' "tells the user to restart once"

sh "$ROOT/install.sh" > "$WORK/install2.log" 2>&1
check '[ $? -eq 0 ] && [ "$(enabled | grep -o earful | wc -l)" -eq 1 ]' "second install keeps one entry"

sh "$ROOT/install.sh" --uninstall > "$WORK/uninstall.log" 2>&1
check '[ $? -eq 0 ]' "uninstall succeeds"
check '[ ! -e "$EXT" ] && [ ! -e "$XDG_DATA_HOME/earful" ]' "files removed"
check '[ ! -e "$CHROME" ] && [ ! -e "$FIREFOX" ]' "browser setup removed"
check '[ "$(enabled)" = "['"'"'other@test'"'"']" ]' "switched off, other extensions kept"

check '! sh "$ROOT/install.sh" --bogus >/dev/null 2>&1' "unknown option refused"
EOF

env "$MARKER" ROOT="$ROOT" UUID="$UUID" WORK="$WORK" EARFUL_TARBALL="$WORK/earful.tar.gz" \
    HOME="$WORK/home" XDG_DATA_HOME="$WORK/home/.local/share" \
    XDG_CONFIG_HOME="$WORK/home/.config" XDG_CACHE_HOME="$WORK/home/.cache" \
    GIO_USE_VFS=local \
    timeout 120 dbus-run-session -- bash "$WORK/scenario.sh" > "$WORK/checks.log" 2> "$WORK/bus.log"

cat "$WORK/checks.log"
if grep -q FAIL "$WORK/checks.log" || ! grep -q "ok - unknown option refused" "$WORK/checks.log"; then
    echo "--- install.log"; cat "$WORK/install.log" 2>/dev/null
    echo "FAIL"
    exit 1
fi
echo "PASS"
