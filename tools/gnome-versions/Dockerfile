# A Fedora image with just enough GNOME Shell to run tools/test-shell.sh.
# Fedora 41, 42, 43, 44 and 45 ship GNOME 47, 48, 49, 50 and 51.
ARG FEDORA=42
FROM fedora:${FEDORA}

RUN dnf install -y --setopt=install_weak_deps=False \
        gnome-shell gjs glib2 dbus-daemon dbus-tools make unzip findutils \
        procps-ng mesa-dri-drivers mesa-libEGL google-noto-sans-fonts \
        adwaita-icon-theme \
    && dnf clean all

# No systemd or system bus in a container: without this folder the shell
# uses its fallback login manager instead of failing to reach logind.
RUN rm -rf /run/systemd/seats

# GNOME Shell doesn't want to run as root.
RUN useradd -m tester
USER tester
ENV XDG_RUNTIME_DIR=/tmp/runtime
WORKDIR /home/tester
