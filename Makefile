UUID := earful@NGdev2.github.io
SRC := gnome-extension
DIST := dist
# What goes into the browser add-on (besides its manifest).
ADDON_FILES := background.js content icons welcome.html welcome.css welcome.js

.PHONY: all schemas pack install uninstall nested test lint clean \
	bridge-install bridge-uninstall bridge-test bridge-test-browser demo \
	chrome firefox ego release bridge-test-firefox test-install test-gnome-versions

all: pack

schemas:
	glib-compile-schemas --strict $(SRC)/schemas

# The GNOME extension zip; also what goes to extensions.gnome.org.
pack: schemas
	mkdir -p $(DIST)
	gnome-extensions pack $(SRC) --force --out-dir=$(DIST) \
		--extra-source=lib --extra-source=icons --extra-source=bridge

ego: pack

# Same as the one-line install, from this checkout: installs, switches
# Earful on for the next login and sets up browser tabs.
install:
	sh install.sh --from .

uninstall:
	sh install.sh --uninstall

# Run a nested GNOME Shell with the extension enabled, using throwaway
# settings so your real session's extension list is untouched (GNOME 46-48).
nested: install
	XDG_CONFIG_HOME=$$(mktemp -d) dbus-run-session -- sh -c '\
		gsettings set org.gnome.shell enabled-extensions "[\"$(UUID)\"]"; \
		MUTTER_DEBUG_DUMMY_MODE_SPECS=1366x768 gnome-shell --nested --wayland'

# Earful registers its browser helper by itself at login; these do it by
# hand (see tools/bridge.js).
bridge-install:
	gjs -m tools/bridge.js register

bridge-uninstall:
	gjs -m tools/bridge.js unregister

# The browser add-on for the Chrome Web Store (no "key": the store sets the
# ID; only the zip is kept) and for addons.mozilla.org (Firefox's manifest).
# dist/firefox-extension can also be loaded from about:debugging.
chrome:
	rm -rf $(DIST)/chrome-extension
	mkdir -p $(DIST)/chrome-extension
	cp -r $(addprefix browser-extension/,$(ADDON_FILES)) $(DIST)/chrome-extension/
	python3 -c 'import json, sys; m = json.load(open(sys.argv[1])); m.pop("key", None); \
		json.dump(m, open(sys.argv[2], "w"), indent=2)' \
		browser-extension/manifest.json $(DIST)/chrome-extension/manifest.json
	cd $(DIST)/chrome-extension && rm -f ../earful-bridge-chrome.zip && \
		zip -qr ../earful-bridge-chrome.zip . -x 'icons/icon.svg'
	@# Without its "key" this copy gets a random ID that Earful's helper
	@# refuses, so don't leave it around to be loaded by mistake.
	rm -rf $(DIST)/chrome-extension
	@echo "Built $(DIST)/earful-bridge-chrome.zip (for the Chrome Web Store; to try the add-on, load browser-extension/ unpacked)"

firefox:
	rm -rf $(DIST)/firefox-extension
	mkdir -p $(DIST)/firefox-extension
	cp -r $(addprefix browser-extension/,$(ADDON_FILES)) $(DIST)/firefox-extension/
	cp browser-extension/manifest.firefox.json $(DIST)/firefox-extension/manifest.json
	cd $(DIST)/firefox-extension && rm -f ../earful-bridge-firefox.zip && \
		zip -qr ../earful-bridge-firefox.zip . -x 'icons/icon.svg'
	@echo "Built $(DIST)/firefox-extension and $(DIST)/earful-bridge-firefox.zip"

# All three store uploads, after checking that their versions match.
release: pack chrome firefox
	@python3 -c 'import json, sys; \
		v = {p: json.load(open(p)).get("version-name") or json.load(open(p))["version"] for p in sys.argv[1:]}; \
		print("\n".join(f"{x}  {p}" for p, x in v.items())); \
		sys.exit(len(set(v.values())) != 1 and "Versions differ" or 0)' \
		$(SRC)/metadata.json browser-extension/manifest.json browser-extension/manifest.firefox.json
	@ls -l $(DIST)/*.zip

# The helper and its registration, on a private D-Bus session and in
# throwaway folders; never touches your real ones.
bridge-test:
	gjs -m tools/test-host.js
	gjs -m tools/test-bridge-setup.js

# Same, plus a throwaway headless Chromium / Chrome profile.
bridge-test-browser:
	python3 tools/test-chrome.py

# Headless Firefox with the add-on (see tools/test-firefox.py).
bridge-test-firefox: firefox
	python3 tools/test-firefox.py

# install.sh and --uninstall in a throwaway home.
test-install:
	tools/test-install.sh

# GNOME 47-51 in Fedora containers (needs docker).
test-gnome-versions:
	tools/test-gnome-versions.sh

# Isolated headless GNOME Shell smoke test (never touches your session).
test:
	tools/test-shell.sh

# Records the README pictures into docs/media (needs ffmpeg).
demo:
	tools/record-demo.sh

lint:
	npx --yes eslint@9.13.0 $(SRC) tools browser-extension

clean:
	rm -rf $(DIST) $(SRC)/schemas/gschemas.compiled
