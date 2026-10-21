UUID := earful@NGdev2.github.io
SRC := gnome-extension
DIST := dist
INSTALL_DIR := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)

.PHONY: all schemas pack install uninstall nested test lint clean \
	bridge-install bridge-uninstall bridge-test bridge-test-browser

all: pack

schemas:
	glib-compile-schemas --strict $(SRC)/schemas

pack: schemas
	mkdir -p $(DIST)
	gnome-extensions pack $(SRC) --force --out-dir=$(DIST) \
		--extra-source=lib --extra-source=icons

install: pack
	gnome-extensions install --force $(DIST)/$(UUID).shell-extension.zip
	@echo "Installed. Log out and back in (Wayland) or press Alt+F2, r (X11), then:"
	@echo "  gnome-extensions enable $(UUID)"

uninstall:
	rm -rf $(INSTALL_DIR)

# Run a nested GNOME Shell with the extension enabled, using throwaway
# settings so your real session's extension list is untouched (GNOME 46-48).
nested: install
	XDG_CONFIG_HOME=$$(mktemp -d) dbus-run-session -- sh -c '\
		gsettings set org.gnome.shell enabled-extensions "[\"$(UUID)\"]"; \
		MUTTER_DEBUG_DUMMY_MODE_SPECS=1366x768 gnome-shell --nested --wayland'

# Browser bridge: one MPRIS player per Chromium tab (see native-host/).
bridge-install:
	native-host/install.sh

bridge-uninstall:
	native-host/install.sh --uninstall

# Runs on a private D-Bus session; never touches your real one.
bridge-test:
	gjs -m native-host/test-host.js

# Same, plus a throwaway headless Chromium / Chrome profile.
bridge-test-browser:
	python3 native-host/test-browser.py

# Isolated headless GNOME Shell smoke test (never touches your session).
test:
	tools/test-shell.sh

lint:
	npx --yes eslint@9.13.0 $(SRC) tools native-host chromium-extension

clean:
	rm -rf $(DIST) $(SRC)/schemas/gschemas.compiled
