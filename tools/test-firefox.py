#!/usr/bin/env python3
"""End-to-end test with Firefox (Snap or regular), headless, and the Earful
Bridge add-on installed as a temporary add-on through geckodriver.

Unlike tools/test-chrome.py this one uses your real session bus: Snap Firefox
starts native helpers through the desktop portal, which only runs there. So
for about half a minute a silent test player ("Earful Firefox Test") shows
up in Earful's menu. Your Firefox profile is not touched; the test uses a
throwaway one, and puts your Firefox helper registration back afterwards.

Snap Firefox must be allowed to start Earful's helper. If you once chose
"Don't allow", click "Ask again" in Earful's settings (Browser tabs) first;
the test then waits for you to choose Allow in the dialog.

Usage: python3 tools/test-firefox.py [--force]   (or: make bridge-test-firefox)
  --force  run even though "Pause others" is on in Earful (the test player
           would pause your music)
  --ignore-permission  run even if Snap Firefox may not start the helper
           (checks only the test itself: Firefox, the add-on, cleanup)
"""
import base64
import functools
import http.server
import json
import os
import shutil
import signal
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UUID = 'earful@NGdev2.github.io'
HOST_NAME = 'io.github.ngdev2.earful'
HOST = os.path.join(REPO, 'gnome-extension', 'bridge', 'earful-host.js')
ADDON = os.path.join(REPO, 'dist', 'earful-bridge-firefox.zip')
FIREFOX_ID = 'earful@ngdev2.github.io'
ROOT = 'org.mpris.MediaPlayer2'
PLAYER = 'org.mpris.MediaPlayer2.Player'
TITLE = 'Earful Firefox Test'
PERMISSIONS = ['--dest', 'org.freedesktop.impl.portal.PermissionStore',
               '--object-path', '/org/freedesktop/impl/portal/PermissionStore']
SNAP = os.path.isdir('/snap/firefox')

PAGE = f'''<!doctype html><title>{TITLE}</title>
<audio id="audio" src="silence.wav" loop autoplay></audio>
<script>
navigator.mediaSession.metadata = new MediaMetadata({{
    title: '{TITLE}', artist: 'Test Artist', album: 'Test Album'}});
document.getElementById('audio').play().catch(() => {{}});
</script>'''

failures = 0


def check(ok, label, detail=''):
    global failures
    print(f"{'ok' if ok else 'FAIL'} - {label}" + (f' ({detail})' if not ok and detail else ''), flush=True)
    if not ok:
        failures += 1
    return ok


def wait_for(predicate, timeout):
    end = time.time() + timeout
    while time.time() < end:
        value = predicate()
        if value:
            return value
        time.sleep(0.3)
    return None


def gdbus(*args):
    result = subprocess.run(['gdbus', 'call', '--session', *args],
                            capture_output=True, text=True, timeout=10)
    return result.stdout.strip() if result.returncode == 0 else ''


def bus_names():
    out = gdbus('--dest', 'org.freedesktop.DBus', '--object-path', '/org/freedesktop/DBus',
                '--method', 'org.freedesktop.DBus.ListNames')
    return [n.strip(" '[]()") for n in out.split(',') if 'earful_tab_' in n]


def get(name, interface, prop):
    return gdbus('--dest', name, '--object-path', '/org/mpris/MediaPlayer2',
                 '--method', 'org.freedesktop.DBus.Properties.Get', interface, prop)


def firefox_players():
    return [n for n in bus_names() if get(n, ROOT, 'Identity').endswith("Firefox'>,)")]


def host_pids():
    out = subprocess.run(['pgrep', '-f', 'earful-host.js'], capture_output=True, text=True).stdout
    return set(out.split())


def permission():
    out = gdbus(*PERMISSIONS, '--method', 'org.freedesktop.impl.portal.PermissionStore.Lookup',
                'webextensions', HOST_NAME)
    for answer in ('yes', 'no'):
        if f"'snap.firefox': ['{answer}']" in out:
            return answer
    return None


def pause_others_on():
    schemas = os.path.join(os.path.expanduser('~/.local/share/gnome-shell/extensions'), UUID, 'schemas')
    result = subprocess.run(['gsettings', '--schemadir', schemas, 'get',
                             'org.gnome.shell.extensions.earful', 'pause-others'],
                            capture_output=True, text=True)
    return result.stdout.strip() == 'true'


def silent_wav(seconds=10, rate=8000):
    data = b'\0\0' * (seconds * rate)
    header = b'RIFF' + struct.pack('<I', 36 + len(data)) + b'WAVEfmt ' + \
        struct.pack('<IHHIIHH', 16, 1, 1, rate, rate * 2, 2, 16) + b'data' + struct.pack('<I', len(data))
    return header + data


def make_site(folder):
    os.makedirs(folder)
    with open(os.path.join(folder, 'music.html'), 'w') as f:
        f.write(PAGE)
    with open(os.path.join(folder, 'silence.wav'), 'wb') as f:
        f.write(silent_wav())
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=folder)
    handler.log_message = lambda *args: None
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f'http://127.0.0.1:{server.server_address[1]}'


class Manifest:
    """Points Firefox's registration at this checkout's helper; restores it."""

    def __init__(self):
        legacy = os.path.expanduser('~/.mozilla')
        xdg = os.path.join(os.environ.get('XDG_CONFIG_HOME', os.path.expanduser('~/.config')), 'mozilla')
        base = legacy if (SNAP or os.path.isdir(legacy) or not os.path.isdir(xdg)) else xdg
        self.path = os.path.join(base, 'native-messaging-hosts', f'{HOST_NAME}.json')
        self.saved = None

    def __enter__(self):
        if os.path.exists(self.path):
            with open(self.path) as f:
                self.saved = f.read()
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        os.chmod(HOST, os.stat(HOST).st_mode | 0o111)
        with open(self.path, 'w') as f:
            json.dump({'name': HOST_NAME, 'description': 'Earful test', 'path': HOST,
                       'type': 'stdio', 'allowed_extensions': [FIREFOX_ID]}, f, indent=2)
        return self

    def __exit__(self, *exc):
        if self.saved is None:
            os.remove(self.path)
        else:
            with open(self.path, 'w') as f:
                f.write(self.saved)


class Gecko:
    """A geckodriver with its own process group, spoken to over plain HTTP."""

    def __init__(self, profile_root, log):
        with socket.socket() as s:
            s.bind(('127.0.0.1', 0))
            self.port = s.getsockname()[1]
        self.process = subprocess.Popen(
            ['geckodriver', '--port', str(self.port), '--profile-root', profile_root],
            stdout=log, stderr=log, start_new_session=True)
        self.session = None
        if not wait_for(self._up, 20):
            raise RuntimeError('geckodriver did not start')

    def _up(self):
        try:
            self.request('GET', '/status')
            return True
        except OSError:
            return False

    def request(self, method, path, body=None, timeout=60):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(f'http://127.0.0.1:{self.port}{path}', data=data, method=method,
                                     headers={'Content-Type': 'application/json'})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as response:
                return json.load(response).get('value')
        except urllib.error.HTTPError as e:
            raise RuntimeError(f'{method} {path}: {e.read().decode()[:500]}') from None

    def start(self, prefs):
        value = self.request('POST', '/session', {'capabilities': {'alwaysMatch': {
            'browserName': 'firefox',
            'moz:firefoxOptions': {'args': ['-headless'], 'prefs': prefs},
        }}}, timeout=90)
        self.session = value['sessionId']
        return value['capabilities']

    def call(self, method, path, body=None):
        return self.request(method, f'/session/{self.session}{path}', body)

    def stop(self):
        if self.session:
            try:
                self.request('DELETE', f'/session/{self.session}', timeout=20)
            except (OSError, RuntimeError):
                pass
            self.session = None
        try:
            os.killpg(self.process.pid, signal.SIGTERM)
            self.process.wait(10)
        except (ProcessLookupError, subprocess.TimeoutExpired):
            try:
                os.killpg(self.process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass


def run(gecko, base, wait_seconds):
    caps = gecko.start({
        'media.autoplay.default': 0,
        'media.autoplay.blocking_policy': 0,
        'media.block-autoplay-until-in-foreground': False,
        'widget.use-xdg-desktop-portal.native-messaging': 1 if SNAP else 0,
    })
    print(f"# Firefox {caps.get('browserVersion')}", flush=True)

    with open(ADDON, 'rb') as f:
        addon = base64.b64encode(f.read()).decode()
    check(gecko.call('POST', '/moz/addon/install', {'addon': addon, 'temporary': True}) == FIREFOX_ID,
          'add-on installs')
    time.sleep(3)
    check(len(gecko.call('GET', '/window/handles')) == 1,
          'no welcome page: the add-on reached the helper')

    before = set(firefox_players())
    gecko.call('POST', '/url', {'url': f'{base}/music.html'})
    name = wait_for(lambda: next(iter(set(firefox_players()) - before), None), wait_seconds)
    if not check(name is not None, 'the tab becomes a player named "... Firefox"', bus_names()):
        return
    metadata = get(name, PLAYER, 'Metadata')
    print(f'# {name}: {get(name, ROOT, "Identity")} {metadata}', flush=True)
    check(f"'xesam:title': <'{TITLE}'>" in metadata, 'title from the Media Session')
    check("['Test Artist']" in metadata, 'artist from the Media Session')
    check(wait_for(lambda: get(name, PLAYER, 'PlaybackStatus') == "(<'Playing'>,)", 10), 'status is Playing')

    paused = 'return document.getElementById("audio").paused'
    gdbus('--dest', name, '--object-path', '/org/mpris/MediaPlayer2', '--method', f'{PLAYER}.PlayPause')
    check(wait_for(lambda: get(name, PLAYER, 'PlaybackStatus') == "(<'Paused'>,)", 10),
          'PlayPause from D-Bus pauses the tab')
    check(gecko.call('POST', '/execute/sync', {'script': paused, 'args': []}) is True, 'the audio element is paused')
    gdbus('--dest', name, '--object-path', '/org/mpris/MediaPlayer2', '--method', f'{PLAYER}.PlayPause')
    check(wait_for(lambda: get(name, PLAYER, 'PlaybackStatus') == "(<'Playing'>,)", 10), 'PlayPause resumes')

    # Volume from D-Bus reaches the tab, and the tab reports it back.
    volume = 'return document.getElementById("audio").volume'
    print(f'# Volume before: {get(name, PLAYER, "Volume")}', flush=True)
    gdbus('--dest', name, '--object-path', '/org/mpris/MediaPlayer2',
          '--method', 'org.freedesktop.DBus.Properties.Set', PLAYER, 'Volume', '<0.4>')
    check(wait_for(lambda: abs(gecko.call('POST', '/execute/sync', {'script': volume, 'args': []}) - 0.4) < 0.01, 10),
          'Volume from D-Bus sets the audio element')
    time.sleep(2)
    reported = get(name, PLAYER, 'Volume')
    check(reported == '(<0.40000000000000002>,)' or reported.startswith('(<0.4'),
          'the tab still reports the new volume', reported)
    # Muting (volume 0, what the menu's volume icon does) keeps the player.
    gdbus('--dest', name, '--object-path', '/org/mpris/MediaPlayer2',
          '--method', 'org.freedesktop.DBus.Properties.Set', PLAYER, 'Volume', '<0.0>')
    time.sleep(2)
    check(name in bus_names() and get(name, PLAYER, 'Volume') == '(<0.0>,)'
          and get(name, PLAYER, 'PlaybackStatus') == "(<'Playing'>,)",
          'a muted tab stays a playing player', get(name, PLAYER, 'Volume'))
    gdbus('--dest', name, '--object-path', '/org/mpris/MediaPlayer2',
          '--method', 'org.freedesktop.DBus.Properties.Set', PLAYER, 'Volume', '<0.4>')
    check(wait_for(lambda: abs(gecko.call('POST', '/execute/sync', {'script': volume, 'args': []}) - 0.4) < 0.01, 10),
          'unmuting brings the volume back')

    gecko.call('POST', '/url', {'url': 'about:blank'})
    check(wait_for(lambda: name not in bus_names(), 15), 'leaving the page removes the player')


def main():
    global failures
    force = '--force' in sys.argv[1:]
    ignore_permission = '--ignore-permission' in sys.argv[1:]
    for tool in ('geckodriver', 'gdbus', 'gsettings'):
        if not shutil.which(tool):
            sys.exit(f'{tool} not found (geckodriver comes with Firefox from Snap, or from your distribution)')
    if not os.path.exists(ADDON):
        sys.exit('Build the add-on first: make firefox')

    wait_seconds = 15
    if SNAP:
        answer = permission()
        if answer == 'no' and not ignore_permission:
            sys.exit('Snap Firefox is not allowed to start Earful\'s helper (you chose "Don\'t allow" once).\n'
                     'Open Earful\'s settings, Browser tabs, and click "Ask again" (or run:\n'
                     '  gdbus call --session --dest org.freedesktop.impl.portal.PermissionStore \\\n'
                     '    --object-path /org/freedesktop/impl/portal/PermissionStore \\\n'
                     '    --method org.freedesktop.impl.portal.PermissionStore.DeletePermission \\\n'
                     f'    webextensions {HOST_NAME} snap.firefox\n'
                     ') then run this again and choose Allow when the dialog appears.')
        if answer is None:
            print('# Firefox will ask once whether it may start Earful\'s helper: choose Allow. Waiting up to 60 s.',
                  flush=True)
            wait_seconds = 60
    if pause_others_on() and not force:
        sys.exit('"Pause others" is on in Earful, so the test player would pause your music.\n'
                 'Pause your music first and run again with --force.')

    # Snap Firefox can only see its own folder, not /tmp.
    parent = os.path.expanduser('~/snap/firefox/common') if SNAP else None
    root = tempfile.mkdtemp(prefix='earful-test-', dir=parent)
    hosts_before = host_pids()
    # Your own Firefox may have players too; only the test's count.
    players_before = set(firefox_players())
    server = None
    gecko = None
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(1))
    try:
        with Manifest(), open(os.path.join(root, 'geckodriver.log'), 'w') as log:
            server, base = make_site(os.path.join(root, 'site'))
            gecko = Gecko(root, log)
            try:
                run(gecko, base, wait_seconds)
            except RuntimeError as e:
                check(False, 'Firefox ran the test', e)
            finally:
                gecko.stop()
            check(wait_for(lambda: not (set(firefox_players()) - players_before), 15),
                  'all test players gone after quitting')
    except KeyboardInterrupt:
        print('interrupted', flush=True)
        failures += 1
    finally:
        if server:
            server.shutdown()
        # Anything still running from the throwaway profile goes.
        subprocess.run(['pkill', '-KILL', '-f', root], capture_output=True)
        time.sleep(1)
        log_tail = ''
        if failures:
            try:
                with open(os.path.join(root, 'geckodriver.log')) as f:
                    log_tail = f.read()[-3000:]
            except OSError:
                pass
        shutil.rmtree(root, ignore_errors=True)
        check(not (host_pids() - hosts_before), 'no helper processes left behind', host_pids() - hosts_before)
        if log_tail:
            print('--- geckodriver.log (end)\n' + log_tail)

    print(f'\n{failures} check(s) failed' if failures else '\nAll checks passed')
    sys.exit(1 if failures else 0)


if __name__ == '__main__':
    main()
