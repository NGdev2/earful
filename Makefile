UUID := earful@NGdev2.github.io
SRC := gnome-extension
DIST := dist
INSTALL_DIR := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)

.PHONY: all schemas pack install uninstall nested test lint clean \
	bridge-install bridge-uninstall bridge-test bridge-test-browser demo \
	firefox bridge-test-firefox test-gnome-versions

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

# The Firefox add-on: the same scripts with Firefox's manifest, in
# dist/firefox-extension (load it from about:debugging) and zipped for
# signing on addons.mozilla.org.
firefox:
	rm -rf $(DIST)/firefox-extension
	mkdir -p $(DIST)/firefox-extension
	cp -r browser-extension/background.js browser-extension/content \
		browser-extension/icons $(DIST)/firefox-extension/
	cp browser-extension/manifest.firefox.json $(DIST)/firefox-extension/manifest.json
	cd $(DIST)/firefox-extension && rm -f ../earful-bridge-firefox.zip && \
		zip -qr ../earful-bridge-firefox.zip . -x 'icons/icon.svg'
	@echo "Built $(DIST)/firefox-extension and $(DIST)/earful-bridge-firefox.zip"

bridge-uninstall:
	native-host/install.sh --uninstall

# Runs on a private D-Bus session; never touches your real one.
bridge-test:
	gjs -m native-host/test-host.js

# Same, plus a throwaway headless Chromium / Chrome profile.
bridge-test-browser:
	python3 native-host/test-browser.py

bridge-test-firefox: firefox
	python3 native-host/test-firefox.py

# GNOME 47-50 in Fedora containers (needs docker).
test-gnome-versions:
	tools/test-gnome-versions.sh

# Isolated headless GNOME Shell smoke test (never touches your session).
test:
	tools/test-shell.sh

# Records the README pictures into docs/media (needs ffmpeg).
demo:
	tools/record-demo.sh

lint:
	npx --yes eslint@9.13.0 $(SRC) tools native-host browser-extension

clean:
	rm -rf $(DIST) $(SRC)/schemas/gschemas.compiled
