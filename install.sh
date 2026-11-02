#!/bin/sh
# Installs Earful for the current user and switches it on.
#
#   curl -fsSL https://raw.githubusercontent.com/NGdev2/earful/main/install.sh | sh
#   wget -qO- https://raw.githubusercontent.com/NGdev2/earful/main/install.sh | sh
#
# Options:  sh install.sh --uninstall   remove Earful and its browser setup
#           sh install.sh --from DIR    install from a checkout (make install)
#           EARFUL_REF=main sh install.sh   another branch or tag
#
# No sudo needed: everything goes into your home folder.

# Everything runs from main(), so a download cut off halfway runs nothing.
main() {
    set -eu
    UUID=earful@NGdev2.github.io
    REF=${EARFUL_REF:-v0.2.0}
    REPO_URL=https://github.com/NGdev2/earful
    DATA=${XDG_DATA_HOME:-$HOME/.local/share}
    EXT_DIR=$DATA/gnome-shell/extensions/$UUID
    ADDON_DIR=$DATA/earful/browser-extension

    action=install
    from=
    while [ $# -gt 0 ]; do
        case $1 in
            --uninstall) action=uninstall ;;
            --from) from=${2:?--from needs a folder}; shift ;;
            *) fail "Unknown option: $1 (use --uninstall or --from DIR)" ;;
        esac
        shift
    done

    [ "$(id -u)" -ne 0 ] || fail "Run this as your normal user, without sudo."
    for tool in gnome-extensions gsettings; do
        command -v "$tool" >/dev/null || fail "Earful needs GNOME Shell 46 or newer ($tool not found)."
    done

    if [ "$action" = uninstall ]; then
        uninstall
    else
        install
    fi
}

fail() {
    echo "Earful: $*" >&2
    exit 1
}

say() {
    echo "$*"
}

gnome_version() {
    gnome-shell --version 2>/dev/null | sed -n 's/^GNOME Shell \([0-9]*\).*/\1/p'
}

download() {
    if command -v curl >/dev/null; then
        curl -fsSL "$1"
    elif command -v wget >/dev/null; then
        wget -qO- "$1"
    else
        fail "Needs curl or wget to download Earful."
    fi
}

# gsettings lists look like ['a', 'b'] or @as [].
list_has() {
    gsettings get org.gnome.shell "$1" | grep -q "'$UUID'"
}

list_add() {
    list_has "$1" && return 0
    current=$(gsettings get org.gnome.shell "$1")
    case $current in
        *"[]") gsettings set org.gnome.shell "$1" "['$UUID']" ;;
        *) gsettings set org.gnome.shell "$1" "$(echo "$current" | sed "s/]\$/, '$UUID']/")" ;;
    esac
}

list_remove() {
    list_has "$1" || return 0
    gsettings set org.gnome.shell "$1" "$(gsettings get org.gnome.shell "$1" |
        sed -e "s/, '$UUID'//" -e "s/'$UUID', //" -e "s/'$UUID'//" -e 's/^@as //')"
}

install() {
    version=$(gnome_version)
    [ -n "$version" ] && [ "$version" -ge 46 ] ||
        fail "Earful needs GNOME Shell 46 or newer${version:+ (this is GNOME $version)}."
    command -v gjs >/dev/null || fail "Earful needs gjs (it comes with GNOME)."

    tmp=$(mktemp -d)
    trap 'rm -rf "$tmp"' EXIT

    if [ -n "$from" ]; then
        src=$(cd "$from" && pwd)
    else
        say "Downloading Earful ($REF)..."
        if [ -n "${EARFUL_TARBALL:-}" ]; then
            tar -xzf "$EARFUL_TARBALL" -C "$tmp"
        else
            download "$REPO_URL/archive/$REF.tar.gz" > "$tmp/earful.tar.gz" ||
                fail "Could not download Earful. Check your internet connection."
            tar -xzf "$tmp/earful.tar.gz" -C "$tmp"
            rm -f "$tmp/earful.tar.gz"
        fi
        src=$(find "$tmp" -mindepth 1 -maxdepth 1 -type d | head -n 1)
        [ -f "$src/gnome-extension/metadata.json" ] || fail "The download looks broken; try again."
    fi

    running=false
    if gnome-extensions info "$UUID" 2>/dev/null | grep -q "State: ACTIVE"; then
        running=true
    fi

    gnome-extensions pack "$src/gnome-extension" --force --out-dir="$tmp" \
        --extra-source=lib --extra-source=icons --extra-source=bridge
    gnome-extensions install --force "$tmp/$UUID.shell-extension.zip"

    # Switch it on for the next login. (gnome-extensions enable only works
    # once GNOME has loaded the extension, which needs a new login.)
    list_add enabled-extensions
    list_remove disabled-extensions

    # Browser tabs work right away, without waiting for the next login.
    bridge=$(gsettings --schemadir "$EXT_DIR/schemas" get org.gnome.shell.extensions.earful \
        browser-bridge 2>/dev/null || echo true)
    if [ "$bridge" = true ]; then
        gjs -m "$src/tools/bridge.js" register --host "$EXT_DIR/bridge/earful-host.js" || true
    fi

    # The add-on for "Load unpacked", until it's in the Chrome Web Store.
    rm -rf "$ADDON_DIR"
    mkdir -p "$ADDON_DIR"
    cp -r "$src/browser-extension/." "$ADDON_DIR/"

    say ""
    if $running; then
        say "Earful is updated. Restart your computer to load the new version."
    else
        say "Earful is installed. Restart your computer; from then on it starts by itself."
    fi
    if [ "$(gsettings get org.gnome.shell disable-user-extensions)" = true ]; then
        say "Note: extensions are switched off in GNOME. Turn them on in the Extensions app."
    fi
    say ""
    say "Optional, browser tabs as separate players: add the Earful Bridge add-on."
    say "  Chrome, Brave, Edge: open chrome://extensions, turn on Developer mode,"
    say "  click Load unpacked and choose $ADDON_DIR"
}

uninstall() {
    if [ -f "$EXT_DIR/metadata.json" ]; then
        gnome-extensions uninstall "$UUID" 2>/dev/null || rm -rf "$EXT_DIR"
    fi
    list_remove enabled-extensions
    list_remove disabled-extensions

    config=${XDG_CONFIG_HOME:-$HOME/.config}
    for manifest in "$config"/*/NativeMessagingHosts/io.github.ngdev2.earful.json \
        "$config"/BraveSoftware/*/NativeMessagingHosts/io.github.ngdev2.earful.json \
        "$HOME/.mozilla/native-messaging-hosts/io.github.ngdev2.earful.json" \
        "$config/mozilla/native-messaging-hosts/io.github.ngdev2.earful.json"; do
        rm -f "$manifest"
    done
    rm -rf "$DATA/earful"

    say "Earful is removed, and so is its browser helper. Its icon goes away after a restart."
    say "The Earful Bridge add-on lives inside your browser, so remove it there if you"
    say "added it: chrome://extensions in Chrome, Brave or Edge; about:addons in Firefox."
}

main "$@"
