// Earful: connects page.js (the page's world) to the service worker.
//
// Runs in the extension's isolated world, so it can use chrome.runtime.
// Everything coming from the page is untrusted: only known fields with the
// right types and sane sizes are passed on.

(() => {
    const STATE_EVENT = 'earful:state';
    const COMMAND_EVENT = 'earful:command';
    const MAX_TEXT = 500;
    const MAX_ART_URL = 2 * 1024 * 1024;
    const STATUSES = ['Playing', 'Paused', 'Stopped'];
    const FLAGS = ['canPlay', 'canPause', 'canGoNext', 'canGoPrevious', 'canSeek', 'canSetVolume'];

    let state = null;
    let port = null;

    function text(value, max = MAX_TEXT) {
        return typeof value === 'string' ? value.trim().slice(0, max) : '';
    }

    function number(value, fallback = 0) {
        return Number.isFinite(value) ? value : fallback;
    }

    function meta(selector) {
        return text(document.querySelector(selector)?.content);
    }

    function siteName() {
        return meta('meta[property="og:site_name"]') ||
            meta('meta[name="application-name"]') ||
            location.hostname.replace(/^www\./, '');
    }

    // "Song - YouTube" -> "Song"
    function pageTitle(site) {
        const title = text(document.title);
        const match = /^(.+?)\s+[-–—|·•]\s+(.+)$/.exec(title);
        return match && match[2].toLowerCase() === site.toLowerCase() ? match[1] : title;
    }

    function pageInfo() {
        const site = siteName();
        return {site, pageTitle: pageTitle(site)};
    }

    function artUrl(value) {
        const url = text(value, MAX_ART_URL);
        return /^(https?:|data:image\/)/i.test(url) ? url : '';
    }

    function sanitize(raw) {
        if (!raw || typeof raw !== 'object')
            return null;
        const hasMetadata = raw.hasMetadata === true;
        const clean = {
            ...pageInfo(),
            hasMetadata,
            title: text(raw.title),
            artist: text(raw.artist),
            album: text(raw.album),
            // Without metadata the page's preview image is the best guess.
            artUrl: artUrl(raw.artUrl) || (hasMetadata ? '' : artUrl(meta('meta[property="og:image"]'))),
            status: STATUSES.includes(raw.status) ? raw.status : 'Paused',
            position: Math.max(0, number(raw.position)),
            duration: Math.max(0, number(raw.duration)),
            rate: number(raw.rate, 1),
            volume: Math.min(1, Math.max(0, number(raw.volume, 1))),
        };
        for (const flag of FLAGS)
            clean[flag] = raw[flag] === true;
        return clean;
    }

    function connect() {
        const newPort = chrome.runtime.connect({name: 'earful'});
        newPort.onMessage.addListener(message => {
            if (message?.type !== 'command')
                return;
            const detail = JSON.stringify({command: message.command, value: message.value});
            window.dispatchEvent(new CustomEvent(COMMAND_EVENT, {detail}));
        });
        newPort.onDisconnect.addListener(() => {
            void chrome.runtime.lastError;
            if (port !== newPort)
                return;
            port = null;
            // The service worker restarted; tell the new one about us.
            if (state)
                setTimeout(send, 500);
        });
        return newPort;
    }

    function send() {
        if (!state) {
            port?.disconnect();
            port = null;
            return;
        }
        try {
            port ??= connect();
            port.postMessage({type: 'state', state});
        } catch {
            // The extension was reloaded or updated: this script is orphaned.
            port = null;
        }
    }

    window.addEventListener(STATE_EVENT, event => {
        try {
            state = sanitize(JSON.parse(event.detail));
        } catch {
            state = null;
        }
        send();
    });

    // Back from the back/forward cache: the old connection was closed.
    window.addEventListener('pageshow', event => {
        if (event.persisted && state)
            send();
    });

    // Lets media in a frame be labelled with the tab's real site and title.
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message?.type === 'earful:page-info')
            sendResponse(pageInfo());
    });
})();
