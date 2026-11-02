// Earful: keeps track of every tab that plays media and mirrors each one as
// its own MPRIS player through the native messaging host
// (gnome-extension/bridge/, registered by Earful itself).
// Nothing is sent anywhere else: the host only talks to the local D-Bus.

// Firefox calls the extension API `browser`; Chromium calls it `chrome`.
const api = globalThis.browser ?? chrome;

const HOST_NAME = 'io.github.ngdev2.earful';
const FIRST_RETRY_DELAY = 1000;
const MAX_RETRY_DELAY = 60_000;
// Let the host (and this worker) sleep once nothing has played for a while.
const IDLE_DISCONNECT_DELAY = 60_000;

const frames = new Set(); // {port, tabId, frameId, state, updated}
const sent = new Map(); // tabId -> {json, frame}: what the host knows
const topPages = new Map(); // tabId -> {site, pageTitle} of the top frame

let host = null;
let retryDelay = FIRST_RETRY_DELAY;
let retryTimer = 0;
let idleTimer = 0;
// When the host isn't installed, don't retry on a timer: try again when
// media plays, at most once a minute.
let nextAttempt = 0;

// Chrome: "Specified native messaging host not found."
// Firefox: "No such native application io.github.ngdev2.earful".
function hostMissing(error) {
    return /not found|no such native application/i.test(error ?? '');
}

function browserInfo() {
    // The host finds Firefox's desktop entry itself (it differs for Snap,
    // Flatpak and plain installs).
    if (navigator.userAgent.includes('Firefox/'))
        return {name: 'Firefox', desktopEntry: ''};
    const brands = navigator.userAgentData?.brands.map(b => b.brand) ?? [];
    const known = [
        ['Google Chrome', 'google-chrome'],
        ['Microsoft Edge', 'microsoft-edge'],
        ['Brave', 'brave-browser'],
        ['Chromium', 'chromium'],
    ];
    const [name, desktopEntry] = known.find(([brand]) => brands.includes(brand)) ?? known.at(-1);
    return {name, desktopEntry};
}

// Native host

function connectHost() {
    clearTimeout(retryTimer);
    retryTimer = 0;

    const port = api.runtime.connectNative(HOST_NAME);
    host = port;
    port.onMessage.addListener(onHostMessage);
    port.onDisconnect.addListener(() => {
        const error = api.runtime.lastError?.message ?? port.error?.message;
        if (host !== port)
            return;
        host = null;
        sent.clear();
        console.warn(`Earful: native host disconnected${error ? `: ${error}` : ''}`);
        if (hostMissing(error))
            nextAttempt = Date.now() + MAX_RETRY_DELAY;
        else if (activeTabIds().size)
            scheduleReconnect();
    });

    port.postMessage({
        type: 'hello',
        browser: browserInfo(),
        version: api.runtime.getManifest().version,
    });
    for (const tabId of activeTabIds())
        refresh(tabId);
}

function scheduleReconnect() {
    if (retryTimer)
        return;
    retryTimer = setTimeout(connectHost, retryDelay);
    retryDelay = Math.min(retryDelay * 2, MAX_RETRY_DELAY);
}

function disconnectHost() {
    host?.disconnect();
    host = null;
    sent.clear();
    retryDelay = FIRST_RETRY_DELAY;
}

function updateIdleTimer() {
    clearTimeout(idleTimer);
    idleTimer = 0;
    if (host && !sent.size)
        idleTimer = setTimeout(disconnectHost, IDLE_DISCONNECT_DELAY);
}

function onHostMessage(message) {
    switch (message?.type) {
    case 'ready':
        retryDelay = FIRST_RETRY_DELAY;
        nextAttempt = 0;
        break;
    case 'command':
        if (message.command === 'raise' || (waitingForTab(message.tabId) &&
            ['play', 'playpause'].includes(message.command)))
            // Media held back until its tab is shown starts once it is.
            raiseTab(message.tabId);
        if (message.command !== 'raise')
            sendCommand(message.tabId, message.command, message.value);
        break;
    }
}

function waitingForTab(tabId) {
    return sent.get(tabId)?.frame.state?.waitingForTab === true;
}

function sendCommand(tabId, command, value) {
    try {
        sent.get(tabId)?.frame.port.postMessage({type: 'command', command, value});
    } catch {
        // The frame just went away; its disconnect handler cleans up.
    }
}

async function raiseTab(tabId) {
    try {
        const tab = await api.tabs.update(tabId, {active: true});
        await api.windows.update(tab.windowId, {focused: true});
    } catch (e) {
        console.warn(`Earful: could not raise tab ${tabId}`, e);
    }
}

// Tabs

function activeTabIds() {
    return new Set([...frames].filter(f => f.state).map(f => f.tabId));
}

// The frame that speaks for the tab: playing beats paused, then most recent.
function bestFrame(tabId) {
    let best = null;
    for (const frame of frames) {
        if (frame.tabId !== tabId || !frame.state)
            continue;
        const playing = frame.state.status === 'Playing';
        const bestPlaying = best?.state.status === 'Playing';
        if (!best || (playing && !bestPlaying) ||
            (playing === bestPlaying && frame.updated > best.updated))
            best = frame;
    }
    return best;
}

function describe({tabId, frameId, state}) {
    const {hasMetadata, site: frameSite, pageTitle: framePageTitle, ...player} = state;
    // Only the extension needs to know; the host gets plain player state.
    delete player.waitingForTab;
    // Media in an embedded frame (a video on a blog) belongs to the tab's page.
    const page = (frameId !== 0 && topPages.get(tabId)) ||
        {site: frameSite, pageTitle: framePageTitle};
    return {
        ...player,
        site: page.site,
        title: player.title || page.pageTitle,
        artist: hasMetadata ? player.artist : page.site,
    };
}

function refresh(tabId) {
    const frame = bestFrame(tabId);
    if (!frame) {
        topPages.delete(tabId);
        if (sent.delete(tabId))
            host?.postMessage({type: 'remove', tabId});
        updateIdleTimer();
        return;
    }

    if (!host) {
        // connectHost() refreshes every tab once connected.
        if (!retryTimer && Date.now() >= nextAttempt)
            connectHost();
        return;
    }

    const player = describe(frame);
    const json = JSON.stringify(player);
    const known = sent.get(tabId);
    if (known?.json === json) {
        known.frame = frame;
        return;
    }
    sent.set(tabId, {json, frame});
    host.postMessage({type: 'update', tabId, player});
    updateIdleTimer();
}

async function fetchTopPage(tabId) {
    try {
        const info = await api.tabs.sendMessage(tabId,
            {type: 'earful:page-info'}, {frameId: 0});
        if (typeof info?.site === 'string' && typeof info?.pageTitle === 'string') {
            topPages.set(tabId, {site: info.site, pageTitle: info.pageTitle});
            refresh(tabId);
        }
    } catch {
        // No content script in the top frame (e.g. a browser page).
    }
}

// Every frame with media keeps a port open; closing the tab or navigating
// away closes it, which is how players disappear.
api.runtime.onConnect.addListener(port => {
    const tabId = port.sender?.tab?.id;
    if (port.name !== 'earful' || !(tabId >= 0))
        return;

    const frame = {port, tabId, frameId: port.sender.frameId ?? 0, state: null, updated: 0};
    frames.add(frame);

    port.onMessage.addListener(message => {
        if (message?.type !== 'state' || !message.state)
            return;
        frame.state = message.state;
        frame.updated = Date.now();
        if (frame.frameId !== 0 && !topPages.has(tabId))
            fetchTopPage(tabId);
        refresh(tabId);
    });
    port.onDisconnect.addListener(() => {
        frames.delete(frame);
        refresh(tabId);
    });
});

// Right after the add-on is installed, check that Earful's helper answers.
// If Earful isn't installed yet, say so and show how to get it. (Snap
// Firefox asks here, once, whether it may start the helper.)
api.runtime.onInstalled.addListener(({reason}) => {
    if (reason !== 'install')
        return;
    const port = api.runtime.connectNative(HOST_NAME);
    port.onMessage.addListener(message => {
        if (message?.type === 'ready')
            port.disconnect();
    });
    port.onDisconnect.addListener(() => {
        const error = api.runtime.lastError?.message ?? port.error?.message;
        if (hostMissing(error))
            api.tabs.create({url: api.runtime.getURL('welcome.html')});
    });
    port.postMessage({type: 'hello', browser: browserInfo(), version: api.runtime.getManifest().version});
});
