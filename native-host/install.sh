#!/bin/sh
# Registers the Earful native messaging host with Chromium-based browsers
# and Firefox, for the current user only.
#
# Usage: native-host/install.sh [--uninstall]

set -eu

NAME=io.github.ngdev2.earful
EXTENSION_ID=gjpjaodbgfodpakidffoooacjemeidmn
FIREFOX_ID=earful@ngdev2.github.io
# Firefox (also from Snap, through the desktop portal) reads this folder.
FIREFOX_HOSTS="$HOME/.mozilla/native-messaging-hosts"
HOST_PATH="$(cd "$(dirname "$0")" && pwd)/earful-host.js"
CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}"

# Browser config folders, relative to $CONFIG. Only existing ones are used.
BROWSERS="chromium google-chrome google-chrome-beta google-chrome-unstable
BraveSoftware/Brave-Browser microsoft-edge"

uninstall=false
case "${1:-}" in
    --uninstall) uninstall=true ;;
    "") ;;
    *) echo "Usage: $0 [--uninstall]" >&2; exit 2 ;;
esac

if ! $uninstall && ! command -v gjs >/dev/null; then
    echo "gjs is required (it comes with GNOME)." >&2
    exit 1
fi

found=false
for browser in $BROWSERS; do
    [ -d "$CONFIG/$browser" ] || continue
    found=true
    dir="$CONFIG/$browser/NativeMessagingHosts"
    manifest="$dir/$NAME.json"

    if $uninstall; then
        if [ -f "$manifest" ]; then
            rm -f "$manifest"
            echo "Removed $manifest"
        fi
        continue
    fi

    mkdir -p "$dir"
    cat > "$manifest" <<EOF
{
  "name": "$NAME",
  "description": "Earful: one MPRIS player per browser tab",
  "path": "$HOST_PATH",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXTENSION_ID/"]
}
EOF
    echo "Installed $manifest"
done

manifest="$FIREFOX_HOSTS/$NAME.json"
if $uninstall; then
    if [ -f "$manifest" ]; then
        rm -f "$manifest"
        echo "Removed $manifest"
    fi
elif [ -d "$HOME/.mozilla" ] || [ -d "$HOME/snap/firefox" ] || command -v firefox >/dev/null; then
    found=true
    mkdir -p "$FIREFOX_HOSTS"
    cat > "$manifest" <<EOF
{
  "name": "$NAME",
  "description": "Earful: one MPRIS player per browser tab",
  "path": "$HOST_PATH",
  "type": "stdio",
  "allowed_extensions": ["$FIREFOX_ID"]
}
EOF
    echo "Installed $manifest"
fi

if ! $found && ! $uninstall; then
    echo "No Chromium-based browser or Firefox found." >&2
    echo "Start your browser once, then run this again." >&2
    exit 1
fi

if ! $uninstall; then
    chmod +x "$HOST_PATH"
    echo "Now add the browser extension (see browser-extension/README.md)."
fi
