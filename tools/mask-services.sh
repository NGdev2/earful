# Sourced by the test scripts. Desktop services a throwaway test session
# must never start: they belong to your real desktop, would only find the
# test display (and crash when it goes away), and aren't needed. Each gets
# a stand-in in the test's own data folder, which D-Bus prefers, that fails
# at once.
#
# Usage: mask_services "$XDG_DATA_HOME"
mask_services() {
    mkdir -p "$1/dbus-1/services"
    for name in org.freedesktop.portal.Desktop org.freedesktop.portal.Documents \
        org.freedesktop.portal.Flatpak org.freedesktop.portal.IBus org.freedesktop.portal.Tracker \
        org.freedesktop.impl.portal.desktop.gnome org.freedesktop.impl.portal.desktop.gtk \
        org.freedesktop.impl.portal.Secret \
        org.freedesktop.Tracker3.Miner.Files org.freedesktop.Tracker3.Miner.Files.Control \
        org.freedesktop.Tracker3.Writeback org.gnome.Nautilus \
        org.gnome.Nautilus.Tracker3.Miner.Extract org.gnome.Nautilus.Tracker3.Miner.Files \
        org.gnome.evolution.dataserver.AddressBook10 org.gnome.evolution.dataserver.Calendar8 \
        org.gnome.evolution.dataserver.Sources5 org.gnome.evolution.dataserver.UserPrompter0 \
        org.gnome.Identity org.gnome.OnlineAccounts org.gtk.vfs.GoaVolumeMonitor; do
        printf '[D-BUS Service]\nName=%s\nExec=/bin/false\n' "$name" > "$1/dbus-1/services/$name.service"
    done
}
