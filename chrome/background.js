'use strict';

/* Chrome MV3 service workers cannot load <script> tags, so pull the polyfill
   in via importScripts. */
if (typeof browser === 'undefined' && typeof importScripts === 'function') {
  importScripts('lib/browser-polyfill.js');
}

const DEFAULT_SETTINGS = {
  subscriptionsOnlyHome: true,
  greyOutWatched: true,
  watchedBadge: true,
  hideShorts: true,
  autoContinueWatching: true,
  enqueueEnabled: true,
  originalAudioTrack: true,
  originalTitles: true,
  watchedThreshold: 95
};

const MENU_ADD_ID = 'niixtube-enqueue';
const MENU_NEXT_ID = 'niixtube-enqueue-next';
// YouTube video IDs are always 11 chars of [A-Za-z0-9_-], but this is kept
// a little loose (6-15) to tolerate any future format change without
// breaking outright - it's a sanity check against malformed/unexpected
// values reaching a fetch() or constructed URL, not a strict spec match.
const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{6,15}$/;

// Populated by the content script's own contextmenu listener (see
// content/youtube.js), which resolves the nearest video by walking up the
// actual rendered DOM from whatever the user right-clicked - this is
// deliberately NOT sourced from the browser's native link-target detection.
// contexts: ['link'] + targetUrlPatterns only shows a menu item when the
// right-clicked element is a genuine <a href> matching those patterns, but
// YouTube's home/subscriptions grid doesn't consistently wrap thumbnails in
// real anchors across its various rendering paths - when it doesn't, no
// link context exists for the browser to match against, so the item simply
// cannot appear, regardless of anything in this file. Resolving the video
// ourselves in the page and showing/hiding the menu accordingly (via
// contextMenus.onShown below) works the same way no matter what element
// was actually under the cursor.
let lastRightClicked = null; // { videoId, title, thumbnail, channel } | null

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

function hasDuration(item) {
  return !!item && typeof item.durationSeconds === 'number' && item.durationSeconds > 0;
}

/** Reads a video's exact length from the watch page's own embedded player
 *  response ("lengthSeconds"), which YouTube includes in the page HTML for
 *  every video. No API key needed, and youtube.com is already a granted
 *  host. Used to backfill durations for queue items that were enqueued
 *  from a context where no duration could be scraped (e.g. right-click on
 *  a plain link) - without it, those items silently excluded themselves
 *  from the popup's total queue time. Never throws; null on any failure. */
async function fetchDurationSeconds(videoId) {
  try {
    const res = await fetch(`https://www.youtube.com/watch?v=${videoId}`, { credentials: 'include' });
    if (!res.ok) return null;
    const html = await res.text();
    const match = html.match(/"lengthSeconds":"(\d+)"/);
    if (!match) return null;
    const seconds = parseInt(match[1], 10);
    return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
  } catch (err) {
    return null;
  }
}

/** Fetches the duration for a queued item that doesn't have one and writes
 *  it back into the stored queue. Fire-and-forget from enqueueItem() - the
 *  enqueue itself never waits on this. */
async function backfillDuration(videoId) {
  const seconds = await fetchDurationSeconds(videoId);
  if (!seconds) return;
  const { queue } = await browser.storage.local.get('queue');
  const list = Array.isArray(queue) ? queue : [];
  let changed = false;
  const updated = list.map((entry) => {
    if (entry.videoId === videoId && !hasDuration(entry)) {
      changed = true;
      return { ...entry, durationSeconds: seconds };
    }
    return entry;
  });
  if (changed) await browser.storage.local.set({ queue: updated });
}

async function enqueueItem(item, playNext) {
  if (!item || !VIDEO_ID_PATTERN.test(item.videoId || '')) return null;
  const { queue } = await browser.storage.local.get('queue');
  const list = Array.isArray(queue) ? queue.slice() : [];
  // Re-adding a video replaces its existing entry - keep the old entry's
  // duration if the new one doesn't have it, rather than losing a known
  // duration to a worse scrape.
  const existing = list.find((entry) => entry.videoId === item.videoId);
  const merged = !hasDuration(item) && hasDuration(existing)
    ? { ...item, durationSeconds: existing.durationSeconds }
    : item;
  const filtered = list.filter((entry) => entry.videoId !== item.videoId);
  if (playNext) {
    filtered.unshift(merged);
  } else {
    filtered.push(merged);
  }
  await browser.storage.local.set({ queue: filtered });
  if (!hasDuration(merged)) {
    backfillDuration(merged.videoId).catch(() => {});
  }
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
async function handleVideoEnded(endedVideoId, playedVideoId) {
  const { queue } = await browser.storage.local.get('queue');
  let list = Array.isArray(queue) ? queue.slice() : [];
  if (endedVideoId) list = list.filter((entry) => entry.videoId !== endedVideoId);
  if (playedVideoId) list = list.filter((entry) => entry.videoId !== playedVideoId);
  await browser.storage.local.set({ queue: list });
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
    let id = null;
    if (u.pathname === '/watch') id = u.searchParams.get('v');
    else if (u.pathname.startsWith('/shorts/')) id = u.pathname.split('/')[2] || null;
    return id && VIDEO_ID_PATTERN.test(id) ? id : null;
  } catch (err) {
    return null;
  }
}

function setupContextMenus() {
  if (!browser.contextMenus) return;
  // browser.contextMenus.removeAll() is promise-only on Firefox - it does
  // not invoke a callback argument the way chrome.contextMenus.removeAll()
  // does. The previous callback-style call here meant the create() calls
  // nested inside it were effectively dead code on Firefox: removeAll()
  // would resolve internally, but nothing ever called back into our
  // function, so the right-click menu items were never (re)created. Using
  // .then() instead works identically via the promise on both browsers.
  browser.contextMenus
    .removeAll()
    .then(() => {
      // contexts: ['all'] deliberately does NOT rely on the browser's own
      // link-target detection (see the comment on lastRightClicked above
      // for why) - the items are always visible on any youtube.com page,
      // and whether a right-click actually resolved a video is checked at
      // CLICK time in onClicked below, not here.
      //
      // An earlier version tried to hide/show these dynamically via
      // contextMenus.onShown, checking lastRightClicked right before the
      // menu displayed. That introduced a race: lastRightClicked is set by
      // an async runtime.sendMessage() from the content script's
      // contextmenu listener, and onShown can fire before that message
      // finishes delivering - especially if the background script had to
      // wake from an idle/suspended state first, which is common for both
      // Chrome's service worker and Firefox's event page. When that race
      // was lost, the items stayed hidden forever, which is why enqueue
      // broke completely on both browsers at once rather than just one.
      // Resolving at click time instead sidesteps the race entirely: a
      // full user click on the menu happens well after any messaging
      // latency, however slow the background script was to wake up.
      browser.contextMenus.create({
        id: MENU_ADD_ID,
        title: 'Add to niixtube queue',
        contexts: ['all'],
        documentUrlPatterns: ['*://*.youtube.com/*']
      });
      browser.contextMenus.create({
        id: MENU_NEXT_ID,
        title: 'Enqueue next (niixtube)',
        contexts: ['all'],
        documentUrlPatterns: ['*://*.youtube.com/*']
      });
    })
    .catch((err) => {
      // Logged (not silently ignored) so a real failure here - e.g. a
      // duplicate-ID clash from overlapping calls - is visible in the
      // background script's console instead of just manifesting as "the
      // right-click menu doesn't show up" with no clue why. Still
      // non-fatal: worst case the items are briefly missing until the next
      // call to this function (onInstalled/onStartup/every script re-run).
      console.warn('[niixtube] setupContextMenus failed:', err);
    });
}

if (browser.contextMenus) {
  browser.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId !== MENU_ADD_ID && info.menuItemId !== MENU_NEXT_ID) return;
    const next = info.menuItemId === MENU_NEXT_ID;

    // Primary path: whatever the content script resolved for this exact
    // right-click from the actual rendered DOM (see lastRightClicked
    // above). Falls back to the browser's native link-target info only if
    // that's unavailable for some reason and it happens to still be a
    // real, matching link - belt and suspenders, no longer the main path.
    //
    // Badge updates aren't triggered explicitly here - enqueueItem()'s own
    // storage.local.set() already fires the storage.onChanged listener
    // below, which calls updateBadge() itself. An explicit call here would
    // just be a redundant second update on every single enqueue (CLEAR_QUEUE
    // and REORDER_QUEUE elsewhere in this file already rely on onChanged
    // alone for exactly this reason - this makes the enqueue path consistent
    // with that instead of the odd one out).
    if (lastRightClicked && lastRightClicked.videoId) {
      const item = { ...lastRightClicked, addedAt: Date.now() };
      enqueueItem(item, next);
      return;
    }

    const videoId = extractVideoIdFromUrl(info.linkUrl || info.pageUrl || '');
    if (!videoId) {
      // Nothing resolvable for this click (e.g. right-clicked blank page
      // chrome, or the resolving message genuinely never arrived) - tell
      // the tab to say so instead of silently doing nothing, since the
      // menu item is now always visible rather than only appearing when
      // something was already confirmed.
      if (tab && typeof tab.id === 'number') {
        browser.tabs.sendMessage(tab.id, { type: 'CONTEXT_ENQUEUE_NONE' }).catch(() => {});
      }
      return;
    }

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
    case 'SET_LAST_RIGHT_CLICKED':
      // Fire-and-forget from the content script's contextmenu listener -
      // see the comment on lastRightClicked above. No response expected.
      lastRightClicked =
        message.videoId && VIDEO_ID_PATTERN.test(message.videoId)
          ? {
              videoId: message.videoId,
              title: typeof message.title === 'string' && message.title ? message.title : `YouTube video (${message.videoId})`,
              thumbnail:
                typeof message.thumbnail === 'string' && message.thumbnail
                  ? message.thumbnail
                  : `https://i.ytimg.com/vi/${message.videoId}/hqdefault.jpg`,
              channel: typeof message.channel === 'string' ? message.channel : '',
              // The content script often already scraped the duration off
              // the thumbnail badge - keep it, so right-click enqueues
              // count toward the popup's total queue time like any other.
              ...(typeof message.durationSeconds === 'number' && message.durationSeconds > 0
                ? { durationSeconds: message.durationSeconds }
                : {})
            }
          : null;
      return undefined;

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
      // Content script has already decided (from its own live-synced
      // cache) which video to play next and has already navigated there -
      // this just cleans up storage to match, no response needed.
      handleVideoEnded(message.endedVideoId, message.playedVideoId);
      return undefined;

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
