'use strict';

/* Chrome MV3 service workers cannot load <script> tags, so pull the polyfill
   in via importScripts. */
if (typeof browser === 'undefined' && typeof importScripts === 'function') {
  importScripts('lib/browser-polyfill.js');
}

const DEFAULT_SETTINGS = {
  subscriptionsOnlyHome: true,
  greyOutWatched: true,
  hideShorts: true,
  autoContinueWatching: true,
  enqueueEnabled: true,
  watchedThreshold: 95
};

const MENU_ADD_ID = 'niixtube-enqueue';
const MENU_NEXT_ID = 'niixtube-enqueue-next';

async function getSettings() {
  const stored = await browser.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
}

async function initStorage() {
  const stored = await browser.storage.local.get(['settings', 'queue']);
  const tasks = [];
  if (!stored.settings) {
    tasks.push(browser.storage.local.set({ settings: DEFAULT_SETTINGS }));
  }
  if (!Array.isArray(stored.queue)) {
    tasks.push(browser.storage.local.set({ queue: [] }));
  }
  await Promise.all(tasks);
}

async function updateBadge() {
  const { queue } = await browser.storage.local.get('queue');
  const count = Array.isArray(queue) ? queue.length : 0;
  try {
    await browser.action.setBadgeText({ text: count > 0 ? String(count) : '' });
    await browser.action.setBadgeBackgroundColor({ color: '#cc0000' });
  } catch (err) {
    /* Badge API differences are non-fatal. */
  }
}

async function enqueueItem(item, playNext) {
  const { queue } = await browser.storage.local.get('queue');
  const list = Array.isArray(queue) ? queue.slice() : [];
  const filtered = list.filter((entry) => entry.videoId !== item.videoId);
  if (playNext) {
    filtered.unshift(item);
  } else {
    filtered.push(item);
  }
  await browser.storage.local.set({ queue: filtered });
  return filtered;
}

async function removeFromQueue(videoId) {
  const { queue } = await browser.storage.local.get('queue');
  const list = (Array.isArray(queue) ? queue : []).filter((entry) => entry.videoId !== videoId);
  await browser.storage.local.set({ queue: list });
  return list;
}

/** Called when a video finishes playing. Removes that video from the queue
 *  wherever it happens to sit (not just position 0 - it may have been
 *  reached by normal browsing rather than by auto-advance), then returns
 *  the new front-of-queue item, if any, for the content script to play. */
async function handleVideoEnded(videoId) {
  const { queue } = await browser.storage.local.get('queue');
  let list = Array.isArray(queue) ? queue.slice() : [];
  if (videoId) {
    list = list.filter((entry) => entry.videoId !== videoId);
  }
  const next = list.length ? list[0] : null;
  if (next) {
    list = list.slice(1);
  }
  await browser.storage.local.set({ queue: list });
  return next;
}

/** Best-effort title lookup for cases where we have no DOM to read from
 *  (e.g. the content script didn't respond in time). Uses YouTube's public
 *  oEmbed endpoint - no API key needed, and it's on a host we already have
 *  permission for. Never throws; callers just get null on any failure. */
async function fetchTitleViaOEmbed(videoId) {
  try {
    const res = await fetch(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(
        `https://www.youtube.com/watch?v=${videoId}`
      )}&format=json`
    );
    if (!res.ok) return null;
    const data = await res.json();
    return typeof data.title === 'string' && data.title.trim() ? data.title.trim() : null;
  } catch (err) {
    return null;
  }
}

function extractVideoIdFromUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.pathname === '/watch') return u.searchParams.get('v');
    if (u.pathname.startsWith('/shorts/')) return u.pathname.split('/')[2] || null;
    return null;
  } catch (err) {
    return null;
  }
}

function setupContextMenus() {
  if (!browser.contextMenus) return;
  browser.contextMenus.removeAll(() => {
    browser.contextMenus.create({
      id: MENU_ADD_ID,
      title: 'Add to niixtube queue',
      contexts: ['link'],
      documentUrlPatterns: ['*://*.youtube.com/*'],
      targetUrlPatterns: ['*://*.youtube.com/watch*', '*://*.youtube.com/shorts/*']
    });
    browser.contextMenus.create({
      id: MENU_NEXT_ID,
      title: 'Enqueue next (niixtube)',
      contexts: ['link'],
      documentUrlPatterns: ['*://*.youtube.com/*'],
      targetUrlPatterns: ['*://*.youtube.com/watch*', '*://*.youtube.com/shorts/*']
    });
  });
}

if (browser.contextMenus) {
  browser.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId !== MENU_ADD_ID && info.menuItemId !== MENU_NEXT_ID) return;
    const videoId = extractVideoIdFromUrl(info.linkUrl || info.pageUrl || '');
    if (!videoId) return;
    const next = info.menuItemId === MENU_NEXT_ID;

    const fallbackEnqueue = async () => {
      const resolvedTitle = await fetchTitleViaOEmbed(videoId);
      await enqueueItem(
        {
          videoId,
          title: resolvedTitle || `YouTube video (${videoId})`,
          thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
          channel: '',
          addedAt: Date.now()
        },
        next
      );
      await updateBadge();
    };

    if (tab && typeof tab.id === 'number') {
      browser.tabs
        .sendMessage(tab.id, { type: 'CONTEXT_ENQUEUE', videoId, next })
        .catch(fallbackEnqueue);
    } else {
      fallbackEnqueue();
    }
  });
}

browser.runtime.onInstalled.addListener(() => {
  initStorage().then(updateBadge);
  setupContextMenus();
});

if (browser.runtime.onStartup) {
  browser.runtime.onStartup.addListener(() => {
    initStorage().then(updateBadge);
    setupContextMenus();
  });
}

// Service workers can be killed and respawned by the browser at any time;
// make sure the menu exists whenever this script (re)runs, not just on
// install/startup.
setupContextMenus();

browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.queue) {
    updateBadge();
  }
});

browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== 'object' || !message.type) {
    return undefined;
  }

  switch (message.type) {
    case 'GET_SETTINGS':
      getSettings().then(sendResponse);
      return true;

    case 'GET_QUEUE':
      browser.storage.local.get('queue').then((r) => sendResponse(Array.isArray(r.queue) ? r.queue : []));
      return true;

    case 'ENQUEUE':
      enqueueItem(message.item, message.next === true).then(sendResponse);
      return true;

    case 'VIDEO_ENDED':
      handleVideoEnded(message.videoId).then(sendResponse);
      return true;

    case 'REMOVE_FROM_QUEUE':
      removeFromQueue(message.videoId).then(sendResponse);
      return true;

    case 'CLEAR_QUEUE':
      browser.storage.local.set({ queue: [] }).then(() => sendResponse(true));
      return true;

    case 'REORDER_QUEUE':
      browser.storage.local.set({ queue: Array.isArray(message.queue) ? message.queue : [] }).then(() => sendResponse(true));
      return true;

    default:
      return undefined;
  }
});

initStorage().then(updateBadge);
