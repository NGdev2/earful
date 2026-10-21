// Earful: watches media from inside the page's own JavaScript world (MAIN).
//
// Content scripts normally run in an isolated world that can't see what the
// page's scripts do. Two things only work from the page's world:
//
//  - Media Session action handlers. Sites register their play / pause /
//    next / previous logic with navigator.mediaSession.setActionHandler(),
//    and the browser never lets anyone else call it. So at document_start,
//    before any site code runs, we wrap setActionHandler() and keep a copy
//    of each handler. Calling it later does exactly what a hardware media
//    key would do, on any site that supports media keys.
//  - Detached players. Many sites play through `new Audio()` elements that
//    are never added to the DOM, so we also hook HTMLMediaElement.play().
//
// What we find is sent to relay.js (the isolated world) as JSON in DOM
// events; relay.js validates it and talks to the extension.

(() => {
    const STATE_EVENT = 'earful:state';
    const COMMAND_EVENT = 'earful:command';
    // Shorter sounds are notification blips, not something to control.
    const MIN_DURATION = 5;
    const MAX_ART_BYTES = 1024 * 1024;
    const MEDIA_EVENTS = [
        'play', 'playing', 'pause', 'ended', 'emptied', 'loadedmetadata',
        'durationchange', 'volumechange', 'ratechange', 'seeked',
    ];

    // Keep our own references in case the page replaces the globals.
    const {setTimeout, CustomEvent, HTMLMediaElement, MediaSession, MediaMetadata} = window;
    const {stringify, parse} = JSON;
    const dispatch = EventTarget.prototype.dispatchEvent.bind(window);
    const originalPlay = HTMLMediaElement.prototype.play;
    const originalPause = HTMLMediaElement.prototype.pause;

    const handlers = new Map();
    const elements = new Map(); // element -> {lastActive, audible, wasConnected}
    const blobArt = new Map(); // blob: URL -> data: URL ('' while loading)
    let timer = 0;
    let lastJson = 'null';

    function schedule() {
        timer ||= setTimeout(flush, 250);
    }

    function flush() {
        timer = 0;
        const json = stringify(collect());
        if (json === lastJson)
            return;
        lastJson = json;
        dispatch(new CustomEvent(STATE_EVENT, {detail: json}));
    }

    // Media elements

    function track(el) {
        if (!elements.has(el)) {
            elements.set(el, {lastActive: 0, audible: false, wasConnected: false});
            for (const type of MEDIA_EVENTS)
                el.addEventListener(type, onMediaEvent);
        }
        check(el);
        schedule();
    }

    function forget(el) {
        elements.delete(el);
        for (const type of MEDIA_EVENTS)
            el.removeEventListener(type, onMediaEvent);
    }

    function onMediaEvent(event) {
        check(event.target);
        schedule();
    }

    function check(el) {
        const info = elements.get(el);
        if (el.isConnected)
            info.wasConnected = true;
        if (el.duration < MIN_DURATION)
            info.audible = false;
        else if (!el.paused && !el.muted && el.volume > 0)
            info.audible = true;
        if (!el.paused)
            info.lastActive = performance.now();
    }

    // The element worth controlling: playing beats paused, then most recent.
    function activeElement() {
        let best = null;
        let bestInfo = null;
        for (const [el, info] of elements) {
            // Removed from the page and paused: the site is done with it.
            if (info.wasConnected && !el.isConnected && el.paused) {
                forget(el);
                continue;
            }
            if (!info.audible || !(el.currentSrc || el.srcObject))
                continue;
            if (!best || (best.paused && !el.paused) ||
                (best.paused === el.paused && info.lastActive > bestInfo.lastActive)) {
                best = el;
                bestInfo = info;
            }
        }
        return best;
    }

    function audibleElements() {
        return [...elements].filter(([, info]) => info.audible).map(([el]) => el);
    }

    // State

    function largestArtwork(artwork = []) {
        let best = '';
        let bestArea = -1;
        for (const {src, sizes} of artwork) {
            const area = Math.max(0, ...String(sizes ?? '').toLowerCase().split(/\s+/)
                .map(size => {
                    if (size === 'any')
                        return Infinity;
                    const [width, height] = size.split('x').map(Number);
                    return width * height || 0;
                }));
            if (area > bestArea) {
                best = src;
                bestArea = area;
            }
        }
        return best;
    }

    // blob: URLs only work inside this page, so inline them as data: URLs.
    function blobToDataUrl(url) {
        if (!blobArt.has(url)) {
            if (blobArt.size > 16)
                blobArt.clear();
            blobArt.set(url, '');
            fetch(url).then(response => response.blob()).then(blob => {
                if (blob.size > MAX_ART_BYTES || !blob.type.startsWith('image/'))
                    return;
                const reader = new FileReader();
                reader.onload = () => {
                    blobArt.set(url, reader.result);
                    schedule();
                };
                reader.readAsDataURL(blob);
            }).catch(() => {});
        }
        return blobArt.get(url);
    }

    function artUrl(metadata, el) {
        const url = largestArtwork(metadata?.artwork) || el?.poster || '';
        return url.startsWith('blob:') ? blobToDataUrl(url) : url;
    }

    function collect() {
        const session = navigator.mediaSession;
        const metadata = session?.metadata;
        const sessionState = session?.playbackState ?? 'none';
        const el = activeElement();
        // Web Audio players have no element but may still describe themselves.
        if (!el && (!metadata || sessionState === 'none'))
            return null;

        let status;
        if (el)
            status = el.ended ? 'Stopped' : el.paused ? 'Paused' : 'Playing';
        else
            status = sessionState === 'playing' ? 'Playing' : 'Paused';

        const duration = el && Number.isFinite(el.duration) ? el.duration : 0;
        return {
            hasMetadata: !!metadata,
            title: metadata?.title ?? '',
            artist: metadata?.artist ?? '',
            album: metadata?.album ?? '',
            artUrl: artUrl(metadata, el),
            status,
            position: el?.currentTime ?? 0,
            duration,
            rate: el?.playbackRate ?? 1,
            volume: !el || el.muted ? 0 : el.volume,
            canPlay: !!el || handlers.has('play'),
            canPause: !!el || handlers.has('pause'),
            canGoNext: handlers.has('nexttrack'),
            canGoPrevious: handlers.has('previoustrack'),
            canSeek: duration > 0 || handlers.has('seekto'),
            canSetVolume: !!el,
        };
    }

    // Commands

    function invoke(action, details = {}) {
        const handler = handlers.get(action);
        if (!handler)
            return false;
        try {
            handler.call(navigator.mediaSession, {action, ...details});
        } catch (e) {
            console.debug('Earful: media session handler failed', e);
        }
        return true;
    }

    function seekTo(el, seconds) {
        const end = el && Number.isFinite(el.duration) ? el.duration : Infinity;
        const time = Math.min(Math.max(0, seconds), end);
        if (!invoke('seekto', {seekTime: time, fastSeek: false}) && el)
            el.currentTime = time;
    }

    function run({command, value}) {
        if (value !== undefined && !Number.isFinite(value))
            return;
        const el = activeElement();
        const playing = el ? !el.paused : navigator.mediaSession?.playbackState === 'playing';
        switch (command) {
        case 'playpause':
            run({command: playing ? 'pause' : 'play'});
            return;
        case 'play':
            if (!invoke('play') && el)
                originalPlay.call(el).catch(() => {});
            break;
        case 'pause':
            if (!invoke('pause') && el)
                originalPause.call(el);
            break;
        case 'stop':
            if (!invoke('stop') && el)
                originalPause.call(el);
            break;
        case 'next':
            invoke('nexttrack');
            break;
        case 'previous':
            invoke('previoustrack');
            break;
        case 'seek':
            seekTo(el, (el?.currentTime ?? 0) + value);
            break;
        case 'position':
            seekTo(el, value);
            break;
        case 'volume':
            for (const media of audibleElements()) {
                media.volume = value;
                if (value > 0)
                    media.muted = false;
            }
            break;
        case 'rate':
            if (el)
                el.playbackRate = value;
            break;
        }
        schedule();
    }

    // Hooks

    function afterSet(proto, prop) {
        const descriptor = Object.getOwnPropertyDescriptor(proto, prop);
        if (!descriptor?.set)
            return;
        Object.defineProperty(proto, prop, {
            ...descriptor,
            set(value) {
                descriptor.set.call(this, value);
                schedule();
            },
        });
    }

    if (MediaSession) {
        const originalSetActionHandler = MediaSession.prototype.setActionHandler;
        MediaSession.prototype.setActionHandler = function setActionHandler(action, handler) {
            // Throws for unsupported actions, just like the original.
            originalSetActionHandler.call(this, action, handler);
            if (typeof handler === 'function')
                handlers.set(action, handler);
            else
                handlers.delete(action);
            schedule();
        };
        afterSet(MediaSession.prototype, 'metadata');
        afterSet(MediaSession.prototype, 'playbackState');
    }
    if (MediaMetadata) {
        for (const prop of ['title', 'artist', 'album', 'artwork'])
            afterSet(MediaMetadata.prototype, prop);
    }

    HTMLMediaElement.prototype.play = function play(...args) {
        track(this);
        return originalPlay.apply(this, args);
    };

    // Elements that start on their own (autoplay) never call play().
    window.addEventListener('play', event => {
        if (event.target instanceof HTMLMediaElement)
            track(event.target);
    }, true);

    window.addEventListener(COMMAND_EVENT, event => {
        try {
            run(parse(event.detail));
        } catch {}
    });
})();
