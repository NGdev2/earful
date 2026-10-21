#!/usr/bin/env python3
"""End-to-end test: a real headless Chromium / Google Chrome, the Earful
extension and the native host, all on a private D-Bus session.

Usage: python3 native-host/test-browser.py [browser]   (or: make bridge-test-browser)

Everything lives in a temporary folder that is deleted afterwards: browser
profile, HOME, XDG dirs, the host manifest and a tiny local web site. Your
real profile, ~/.config and session bus are never touched.
"""
import base64
import functools
import http.server
import json
import math
import os
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import threading
import time
import wave

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXTENSION_ID = 'gjpjaodbgfodpakidffoooacjemeidmn'
HOST_NAME = 'io.github.ngdev2.earful'
ROOT = 'org.mpris.MediaPlayer2'
PLAYER = 'org.mpris.MediaPlayer2.Player'
PNG = base64.b64decode(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==')

# A session bus that can't start services, so the browser can't wake up
# portals, keyrings or anything else of the real desktop.
BUS_CONFIG = '''<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN"
 "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <type>session</type>
  <listen>unix:tmpdir=/tmp</listen>
  <auth>EXTERNAL</auth>
  <policy context="default">
    <allow send_destination="*" eavesdrop="true"/>
    <allow eavesdrop="true"/>
    <allow own="*"/>
  </policy>
</busconfig>
'''

PAGES = {
    # Media Session metadata and next / previous handlers, like a music site.
    'music.html': '''<!doctype html><title>Ignored title</title>
<meta property="og:site_name" content="Earful Music">
<audio id="audio" src="tone.wav" loop></audio>
<script>
const tracks = ['Song One', 'Song Two', 'Song Three'];
let index = 0;
window.nextCalls = 0;
function show() {
    navigator.mediaSession.metadata = new MediaMetadata({
        title: tracks[index], artist: 'Test Artist', album: 'Test Album',
        artwork: [{src: 'small.png', sizes: '96x96'}, {src: 'big.png', sizes: '512x512'}],
    });
}
navigator.mediaSession.setActionHandler('nexttrack', () => { index = (index + 1) % 3; window.nextCalls++; show(); });
navigator.mediaSession.setActionHandler('previoustrack', () => { index = (index + 2) % 3; show(); });
show();
document.getElementById('audio').play();
</script>''',
    # A detached `new Audio()` and no metadata: falls back to the page title.
    'podcast.html': '''<!doctype html><title>Episode 7 | Earful Pods</title>
<meta property="og:site_name" content="Earful Pods">
<script>window.player = new Audio('tone.wav'); player.loop = true; player.play();</script>''',
    # Media inside an iframe is labelled with the top page.
    'blog.html': '<!doctype html><title>My Blog Post</title><iframe src="embed.html"></iframe>',
    'embed.html': '<!doctype html><title>Embed</title><audio src="tone.wav" autoplay loop></audio>',
}

failures = 0


def check(ok, label, detail=''):
    global failures
    print(f"{'ok' if ok else 'FAIL'} - {label}" + (f' ({detail})' if not ok and detail else ''), flush=True)
    if not ok:
        failures += 1


def wait_for(predicate, timeout=10):
    end = time.time() + timeout
    while time.time() < end:
        value = predicate()
        if value:
            return value
        time.sleep(0.2)
    return None


# D-Bus, through the gdbus command line tool

def gdbus(*args):
    result = subprocess.run(['gdbus', 'call', '--session', *args], capture_output=True, text=True, timeout=10)
    return result.stdout.strip()


def bus_names():
    out = gdbus('-d', 'org.freedesktop.DBus', '-o', '/org/freedesktop/DBus',
                '-m', 'org.freedesktop.DBus.ListNames')
    return [n.strip(" '") for n in out.strip('()[],').split(',') if 'org.mpris.' in n]


def tab_players():
    return [n for n in bus_names() if '.earful_tab_' in n]


def get(name, iface, prop):
    return gdbus('-d', name, '-o', '/org/mpris/MediaPlayer2',
                 '-m', 'org.freedesktop.DBus.Properties.Get', iface, prop)


def call(name, method):
    return gdbus('-d', name, '-o', '/org/mpris/MediaPlayer2', '-m', method)


def set_volume(name, volume):
    gdbus('-d', name, '-o', '/org/mpris/MediaPlayer2', '-m', 'org.freedesktop.DBus.Properties.Set',
          PLAYER, 'Volume', f'<{volume}>')


class DevTools:
    """Chrome DevTools Protocol over --remote-debugging-pipe (fds 3 and 4)."""

    def __init__(self, write_fd, read_fd):
        self._out = os.fdopen(write_fd, 'wb', buffering=0)
        self._in = os.fdopen(read_fd, 'rb', buffering=0)
        self._id = 0
        self._buffer = b''

    def send(self, method, params=None, session=None):
        self._id += 1
        message = {'id': self._id, 'method': method, 'params': params or {}}
        if session:
            message['sessionId'] = session
        self._out.write(json.dumps(message).encode() + b'\0')
        while True:
            while b'\0' not in self._buffer:
                chunk = self._in.read(65536)
                if not chunk:
                    raise RuntimeError('browser closed the DevTools pipe')
                self._buffer += chunk
            raw, self._buffer = self._buffer.split(b'\0', 1)
            reply = json.loads(raw)
            if reply.get('id') == self._id:
                if 'error' in reply:
                    raise RuntimeError(f"{method}: {reply['error']['message']}")
                return reply.get('result', {})

    def evaluate(self, target, expression):
        session = self.send('Target.attachToTarget', {'targetId': target, 'flatten': True})['sessionId']
        result = self.send('Runtime.evaluate', {'expression': expression, 'returnByValue': True}, session)
        self.send('Target.detachFromTarget', {'sessionId': session})
        return result.get('result', {}).get('value')


def make_site(root):
    os.makedirs(root)
    with wave.open(os.path.join(root, 'tone.wav'), 'wb') as tone:
        tone.setnchannels(1)
        tone.setsampwidth(2)
        tone.setframerate(8000)
        tone.writeframes(b''.join(struct.pack('<h', int(3000 * math.sin(i * 0.2))) for i in range(8000 * 60)))
    for name in ('small.png', 'big.png'):
        with open(os.path.join(root, name), 'wb') as f:
            f.write(PNG)
    for name, html in PAGES.items():
        with open(os.path.join(root, name), 'w') as f:
            f.write(html)

    class Handler(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *args):
            pass

    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Handler, directory=root))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return f'http://127.0.0.1:{server.server_address[1]}'


def start_browser(browser, work):
    profile = os.path.join(work, 'profile')
    home = os.path.join(work, 'home')
    runtime = os.path.join(work, 'runtime')
    for folder in (profile, home, runtime):
        os.makedirs(folder, mode=0o700)

    # Browsers also read per-user host manifests from <user-data-dir>/NativeMessagingHosts.
    hosts = os.path.join(profile, 'NativeMessagingHosts')
    os.makedirs(hosts)
    with open(os.path.join(hosts, f'{HOST_NAME}.json'), 'w') as f:
        json.dump({'name': HOST_NAME, 'description': 'Earful test', 'type': 'stdio',
                   'path': os.path.join(REPO, 'native-host', 'earful-host.js'),
                   'allowed_origins': [f'chrome-extension://{EXTENSION_ID}/']}, f)

    to_browser_r, to_browser_w = os.pipe()
    from_browser_r, from_browser_w = os.pipe()

    def devtools_fds():
        os.dup2(to_browser_r, 3)
        os.dup2(from_browser_w, 4)

    env = dict(os.environ, HOME=home, XDG_CONFIG_HOME=os.path.join(home, '.config'),
               XDG_CACHE_HOME=os.path.join(home, '.cache'), XDG_RUNTIME_DIR=runtime, GIO_USE_VFS='local')
    env.pop('CHROME_DESKTOP', None)
    log = open(os.path.join(work, 'browser.log'), 'w')
    process = subprocess.Popen([
        browser, '--headless=new', f'--user-data-dir={profile}', '--no-first-run',
        '--no-default-browser-check', '--password-store=basic', '--use-mock-keychain', '--disable-sync',
        '--autoplay-policy=no-user-gesture-required', '--mute-audio',
        # Branded Chrome ignores --load-extension; load through DevTools instead.
        '--remote-debugging-pipe', '--enable-unsafe-extension-debugging', 'about:blank',
    ], env=env, preexec_fn=devtools_fds, close_fds=False, stdout=log, stderr=log)
    os.close(to_browser_r)
    os.close(from_browser_w)
    return process, DevTools(to_browser_w, from_browser_r)


def run(browser, work):
    base = make_site(os.path.join(work, 'site'))
    process, devtools = start_browser(browser, work)
    try:
        print(f"# {devtools.send('Browser.getVersion')['product']}", flush=True)
        extension = devtools.send('Extensions.loadUnpacked', {'path': os.path.join(REPO, 'chromium-extension')})
        check(extension.get('id') == EXTENSION_ID, 'extension id matches the manifest key', extension.get('id'))

        # Open the tabs one at a time: Chrome holds back media loading in
        # background tabs that were never shown.
        tabs = {}
        for count, page in enumerate(('music', 'podcast', 'blog'), 1):
            tabs[page] = devtools.send('Target.createTarget', {'url': f'{base}/{page}.html'})['targetId']
            wait_for(lambda: len(tab_players()) >= count, 10)
            time.sleep(0.5)
        players = tab_players()
        check(len(players) == 3, 'three tabs become three players', bus_names())

        by_title = {}
        for name in players:
            metadata = get(name, PLAYER, 'Metadata')
            print(f'# {name}: {get(name, ROOT, "Identity")} {metadata}', flush=True)
            for title in ('Song One', 'Episode 7', 'My Blog Post'):
                if f"'xesam:title': <'{title}'>" in metadata:
                    by_title[title] = name

        browser_pid = players[0].rsplit('.instance', 1)[-1] if players else '?'
        own_player = f'org.mpris.MediaPlayer2.chromium.instance{browser_pid}'
        if any(n.startswith('org.mpris.MediaPlayer2.chromium.') for n in bus_names()):
            check(own_player in bus_names(), "name suffix matches the browser's own MPRIS player", bus_names())

        music = by_title.get('Song One')
        podcast = by_title.get('Episode 7')
        check(music is not None, 'music tab shows its Media Session title')
        check(podcast is not None, 'detached Audio falls back to the page title, site suffix removed')
        check('My Blog Post' in by_title, 'media in an iframe is labelled with the top page')

        if music:
            check(get(music, ROOT, 'Identity').startswith("(<'Earful Music — "), 'Identity uses og:site_name')
            metadata = get(music, PLAYER, 'Metadata')
            check(f"'{base}/big.png'" in metadata, 'the largest artwork is used', metadata)
            check("['Test Artist']" in metadata and "'Test Album'" in metadata, 'artist and album')
            check(get(music, PLAYER, 'PlaybackStatus') == "(<'Playing'>,)", 'status is Playing')
            check(get(music, PLAYER, 'CanGoNext') == '(<true>,)', 'CanGoNext comes from the captured handler')

            call(music, f'{PLAYER}.Next')
            check(wait_for(lambda: 'Song Two' in get(music, PLAYER, 'Metadata'), 5),
                  "Next runs the page's own nexttrack handler")
            check(devtools.evaluate(tabs['music'], 'window.nextCalls') == 1, 'the handler ran exactly once')

            call(music, f'{PLAYER}.Pause')
            check(wait_for(lambda: get(music, PLAYER, 'PlaybackStatus') == "(<'Paused'>,)", 5),
                  'Pause pauses the page and the status follows')
            check(devtools.evaluate(tabs['music'], 'document.getElementById("audio").paused') is True,
                  'the audio element is paused')

            call(music, f'{PLAYER}.PlayPause')
            check(wait_for(lambda: get(music, PLAYER, 'PlaybackStatus') == "(<'Playing'>,)", 5), 'PlayPause resumes')

            set_volume(music, 0.3)
            check(wait_for(lambda: devtools.evaluate(tabs['music'], 'document.getElementById("audio").volume') == 0.3, 5),
                  'setting Volume changes the element volume')
            check(call(music, f'{ROOT}.Raise') == '()', 'Raise succeeds')

        if podcast:
            check(wait_for(lambda: 'mpris:length' in get(podcast, PLAYER, 'Metadata'), 5), 'duration becomes mpris:length')
            check("['Earful Pods']" in get(podcast, PLAYER, 'Metadata'), 'without metadata the site is the artist')
            call(podcast, f'{PLAYER}.PlayPause')
            check(wait_for(lambda: devtools.evaluate(tabs['podcast'], 'player.paused') is True, 5),
                  'PlayPause reaches a detached Audio element')

            devtools.send('Target.closeTarget', {'targetId': tabs['podcast']})
            check(wait_for(lambda: podcast not in bus_names(), 10), 'closing a tab removes its player')

        # A crashed host is restarted by the extension and gets every tab back.
        survivors = tab_players()
        host_pid = gdbus('-d', 'org.freedesktop.DBus', '-o', '/org/freedesktop/DBus',
                         '-m', 'org.freedesktop.DBus.GetConnectionUnixProcessID', survivors[0])
        os.kill(int(host_pid.strip('(,)').split()[-1]), signal.SIGKILL)
        check(wait_for(lambda: not tab_players(), 5), 'players vanish when the host dies')
        check(wait_for(lambda: sorted(tab_players()) == sorted(survivors), 10),
              'the extension restarts the host and restores the players')

        devtools.send('Target.closeTarget', {'targetId': tabs['blog']})
        try:
            devtools.send('Browser.close')
        except RuntimeError:
            pass
        process.wait(15)
        check(wait_for(lambda: not tab_players(), 10), 'all players vanish when the browser quits')
    finally:
        if process.poll() is None:
            process.kill()


def main():
    if len(sys.argv) > 2 and sys.argv[2] == '--on-private-bus':
        run(sys.argv[1], sys.argv[3])
        print(f'\n{failures} check(s) failed' if failures else '\nAll checks passed')
        sys.exit(1 if failures else 0)

    browser = sys.argv[1] if len(sys.argv) > 1 else next(
        (b for b in ('google-chrome', 'chromium', 'chromium-browser') if shutil.which(b)), None)
    if not browser:
        sys.exit('No Chromium or Google Chrome found; pass the browser binary as an argument.')

    work = tempfile.mkdtemp(prefix='earful-browser-test-')
    try:
        config = os.path.join(work, 'bus.conf')
        with open(config, 'w') as f:
            f.write(BUS_CONFIG)
        status = subprocess.call(['dbus-run-session', f'--config-file={config}', '--',
                                  sys.executable, '-I', os.path.abspath(__file__), browser, '--on-private-bus', work])
    finally:
        shutil.rmtree(work, ignore_errors=True)
    sys.exit(status)


if __name__ == '__main__':
    main()
