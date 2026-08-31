'use strict';

(function () {
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

  // Sanity check before any extracted ID is used to build a fetch() URL or
  // a thumbnail src - loose enough to tolerate a future format change (real
  // IDs are always 11 chars) without breaking outright.
  const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{6,15}$/;

  const SELECTORS = {
    videoRenderer:
      'ytd-rich-item-renderer, ytd-video-renderer, ytd-grid-video-renderer, ytd-compact-video-renderer',
    // YouTube has been migrating this element to a newer web-component
    // design system (yt-thumbnail-overlay-progress-bar-view-model, with
    // classes like ytThumbnailOverlayProgressBarHostWatchedProgressBar*)
    // alongside the older ytd-thumbnail-overlay-resume-playback-renderer,
    // rolled out inconsistently across accounts/pages - so both are matched.
    progressBar:
      'ytd-thumbnail-overlay-resume-playback-renderer #progress, ' +
      '[class*="ytThumbnailOverlayProgressBarHostWatchedProgressBarSegment"], ' +
      'yt-thumbnail-overlay-progress-bar-view-model [class*="WatchedProgressBarSegment"]',
    thumbnailLink: 'a#thumbnail',
    thumbnailHost: 'ytd-thumbnail',
    videoTitle: '#video-title, #video-title-link',
    channelLink:
      'ytd-channel-name a, #channel-name a, a.yt-simple-endpoint[href^="/channel/"], a.yt-simple-endpoint[href^="/@"]',
    continueWatchingDialog: 'ytd-popup-container tp-yt-paper-dialog, tp-yt-paper-dialog#dialog',
    video: 'video.html5-main-video, video.video-stream, .html5-video-player video',
    // Scoped to the subscriptions page's own filter bar instead of the
    // whole document, so we never have to scan every <button> on the page.
    sortBar: 'ytd-feed-filter-chip-bar-renderer, yt-sort-filter-sub-menu-renderer, #chips, #header'
  };

  const CHANNEL_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
  const CHEAP_TICK_INTERVAL_MS = 250; // min gap between cheap, page-wide checks
  const MAX_SORT_ATTEMPTS = 6; // give up quickly instead of scanning forever
  const MAX_AUDIO_TRACK_ATTEMPTS = 20; // player UI can render later than usual
  const MAX_SHELF_ATTEMPTS = 20; // shelf can render asynchronously after the rest of the page

  const state = {
    settings: { ...DEFAULT_SETTINGS },
    dismissingDialog: false,
    lastVideoEl: null,
    lastUrl: location.href,
    subscribedChannelSet: null,
    subscribedChannelsLoading: false,
    sortForced: false,
    sortAttempts: 0,
    shelfAttempts: 0,
    audioTrackVideoId: null,
    audioTrackAttempts: 0,
    watchTitleVideoId: null,
    cachedNextQueueItem: null,
    ytInitialDataChecked: false,
    cachedYtInitialData: null,
    toastTimer: null,
    lastCheapRun: 0,
    pendingMutations: [],
    rafScheduled: false
  };

  async function nxSend(type, payload) {
    try {
      return await browser.runtime.sendMessage({ type, ...(payload || {}) });
    } catch (err) {
      return null;
    }
  }

  async function loadSettings() {
    const remote = await nxSend('GET_SETTINGS');
    state.settings = { ...DEFAULT_SETTINGS, ...(remote || {}) };
  }

  function extractVideoId(href) {
    if (!href) return null;
    try {
      const url = new URL(href, window.location.origin);
      let id = null;
      if (url.pathname === '/watch') id = url.searchParams.get('v');
      else if (url.pathname.startsWith('/shorts/')) id = url.pathname.split('/')[2] || null;
      return id && VIDEO_ID_PATTERN.test(id) ? id : null;
    } catch (err) {
      return null;
    }
  }

  /** Best-effort title lookup when we have no matching DOM element to read
   *  from (e.g. right-clicking a link the extension never processed, such
   *  as a sidebar recommendation). oEmbed needs no API key and youtube.com
   *  is already a granted host, so this is a plain same-site fetch. It also
   *  always returns the uploader's original, untranslated title regardless
   *  of the viewer's language settings - which is what makes it reusable
   *  for the "original titles" feature below, not just the enqueue fallback. */
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

  // ---------- Feature: display original (untranslated) titles ----------
  //
  // YouTube can auto-translate video titles to match the viewer's language
  // settings - a platform feature, not something the uploader chose or
  // controls. This restores the title as the uploader actually wrote it, by
  // reading it from the oEmbed endpoint above, which always returns the
  // original metadata regardless of viewer locale. Cached persistently
  // (titles essentially never change) so repeat views of the same video,
  // even across browser sessions, don't re-fetch.
  //
  // Three efficiency measures beyond the basic cache, all aimed at cutting
  // down round-trips rather than DOM work (which is already batched
  // elsewhere - see processItems()):
  //   1. Storage reads are batched: one browser.storage.local.get() call
  //      per page of items instead of one call per video. IPC round-trips
  //      to extension storage aren't free, and a homepage can easily have
  //      30-60 items each wanting a lookup.
  //   2. In-flight requests are deduplicated per video ID, so if the same
  //      video shows up in two places on the page at once (e.g. a grid
  //      item and a sidebar recommendation for the same video), both
  //      resolve from a single shared fetch instead of firing two.
  //   3. Actual network fetches are concurrency-limited, so a page with
  //      many cache misses at once (e.g. first visit to an active
  //      subscriptions feed) doesn't burst a couple dozen simultaneous
  //      requests - they queue and drain a few at a time instead.
  const TITLE_CACHE_PREFIX = 'niixtube-title-cache:';
  const TITLE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
  const TITLE_FETCH_CONCURRENCY = 4;
  const titleCacheMem = new Map(); // videoId -> title, resolved this page load
  const titleFetchInFlight = new Map(); // videoId -> shared Promise<string|null>
  const titleFetchQueue = [];
  let titleFetchActive = 0;

  function runNextTitleFetch() {
    if (titleFetchActive >= TITLE_FETCH_CONCURRENCY) return;
    const job = titleFetchQueue.shift();
    if (!job) return;
    titleFetchActive += 1;
    job().finally(() => {
      titleFetchActive -= 1;
      runNextTitleFetch();
    });
  }

  function fetchTitleQueued(videoId) {
    if (titleFetchInFlight.has(videoId)) return titleFetchInFlight.get(videoId);
    const promise = new Promise((resolve) => {
      titleFetchQueue.push(async () => {
        const title = await fetchTitleViaOEmbed(videoId);
        if (title) {
          titleCacheMem.set(videoId, title);
          safe(() => {
            browser.storage.local
              .set({ [TITLE_CACHE_PREFIX + videoId]: { title, ts: Date.now() } })
              .catch(() => {});
          });
        }
        resolve(title);
      });
    });
    titleFetchInFlight.set(videoId, promise);
    promise.finally(() => titleFetchInFlight.delete(videoId));
    runNextTitleFetch();
    return promise;
  }

  /** Resolves original titles for a whole batch of video IDs at once: one
   *  storage.local.get() for everything not already cached in memory, then
   *  the deduplicated/concurrency-limited fetch queue above for genuine
   *  cache misses. Called once per processItems() batch rather than once
   *  per item - see the comment above for why that matters. */
  async function prefetchOriginalTitles(videoIds) {
    const need = [...new Set(videoIds)].filter((id) => id && !titleCacheMem.has(id));
    if (!need.length) return;

    try {
      const keys = need.map((id) => TITLE_CACHE_PREFIX + id);
      const stored = await browser.storage.local.get(keys);
      for (const id of need) {
        const entry = stored[TITLE_CACHE_PREFIX + id];
        if (entry && typeof entry.title === 'string' && Date.now() - entry.ts < TITLE_CACHE_TTL_MS) {
          titleCacheMem.set(id, entry.title);
        }
      }
    } catch (err) {
      /* storage read failed - every id below just falls through to a fetch */
    }

    const stillMissing = need.filter((id) => !titleCacheMem.has(id));
    await Promise.all(stillMissing.map(fetchTitleQueued));
  }

  async function getOriginalTitle(videoId) {
    if (titleCacheMem.has(videoId)) return titleCacheMem.get(videoId);
    await prefetchOriginalTitles([videoId]);
    return titleCacheMem.get(videoId) || null;
  }

  function applyOriginalTitleForItem(item, videoId) {
    if (!state.settings.originalTitles || !videoId) return;
    const titleEl = item.querySelector(SELECTORS.videoTitle);
    if (!titleEl) return;
    if (titleEl.dataset.niixtubeOriginalTitleFor === videoId) return; // already applied
    titleEl.dataset.niixtubeOriginalTitleFor = videoId; // claim before awaiting, avoids duplicate work
    getOriginalTitle(videoId).then((title) => {
      if (title && state.settings.originalTitles) {
        titleEl.textContent = title;
        if (titleEl.hasAttribute('title')) titleEl.setAttribute('title', title);
      }
    });
  }

  async function applyOriginalWatchTitle() {
    if (!state.settings.originalTitles) return;
    const videoId = currentWatchVideoId();
    if (!videoId) return;
    if (state.watchTitleVideoId === videoId) return;
    const el = document.querySelector(
      'ytd-watch-metadata h1.ytd-watch-metadata yt-formatted-string, #title h1 yt-formatted-string, #title h1'
    );
    if (!el) return; // player metadata not rendered yet - retried next cheap tick
    state.watchTitleVideoId = videoId; // claim before awaiting
    const title = await getOriginalTitle(videoId);
    if (title && state.settings.originalTitles && currentWatchVideoId() === videoId) {
      el.textContent = title;
      document.title = `${title} - YouTube`;
    }
  }

  function thumbnailUrl(videoId) {
    // Constructed directly from the video ID instead of scraping <img src>,
    // which is frequently blank/placeholder due to YouTube's lazy loading.
    return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
  }

  function safe(fn) {
    try {
      fn();
    } catch (err) {
      // A single fragile selector failing (e.g. after a YouTube layout
      // change) should never take the rest of the extension down with it.
      console.warn('[niixtube]', err);
    }
  }

  // ---------- Feature 1: subscriptions-only home, newest first ----------
  function redirectHomeToSubscriptions() {
    if (!state.settings.subscriptionsOnlyHome) return;
    const { pathname } = window.location;
    const isHome = pathname === '/' || pathname === '/feed/recommended';
    if (isHome) {
      window.location.replace('https://www.youtube.com/feed/subscriptions?flow=2');
    }
  }

  async function refreshSubscribedChannels(force) {
    if (state.subscribedChannelsLoading) return;
    const cached = await browser.storage.local.get('subscribedChannels');
    const now = Date.now();
    if (
      !force &&
      cached.subscribedChannels &&
      Array.isArray(cached.subscribedChannels.ids) &&
      now - cached.subscribedChannels.fetchedAt < CHANNEL_CACHE_TTL_MS
    ) {
      state.subscribedChannelSet = new Set(cached.subscribedChannels.ids);
      return;
    }
    if (cached.subscribedChannels && Array.isArray(cached.subscribedChannels.ids)) {
      // Use the stale cache immediately while we refresh in the background,
      // so filtering doesn't sit idle waiting on a network round trip.
      state.subscribedChannelSet = new Set(cached.subscribedChannels.ids);
    }
    state.subscribedChannelsLoading = true;
    try {
      const res = await fetch('https://www.youtube.com/feed/channels?flow=list', {
        credentials: 'include'
      });
      const html = await res.text();
      const ids = new Set();
      const channelIdRe = /"channelId":"(UC[0-9A-Za-z_-]{22})"/g;
      let match;
      while ((match = channelIdRe.exec(html))) ids.add(match[1]);
      const handleRe = /"canonicalBaseUrl":"\/(@[^"]+)"/g;
      while ((match = handleRe.exec(html))) ids.add(match[1]);

      if (ids.size > 0) {
        const idArray = Array.from(ids);
        await browser.storage.local.set({ subscribedChannels: { ids: idArray, fetchedAt: now } });
        state.subscribedChannelSet = new Set(idArray);
        fullDocumentItemPass(); // re-classify anything rendered before this resolved
      }
    } catch (err) {
      // Network failure or not signed in - keep whatever cache we already loaded above.
    } finally {
      state.subscribedChannelsLoading = false;
    }
  }

  function getChannelKeyFromRenderer(item) {
    const link = item.querySelector(SELECTORS.channelLink);
    if (!link) return null;
    const href = link.getAttribute('href') || '';
    const idMatch = href.match(/\/channel\/(UC[0-9A-Za-z_-]{22})/);
    if (idMatch) return idMatch[1];
    const handleMatch = href.match(/\/(@[^/?]+)/);
    if (handleMatch) return handleMatch[1];
    return null;
  }

  function applySubscribedOnlyFilterItem(item) {
    if (!state.settings.subscriptionsOnlyHome) return;
    if (window.location.pathname !== '/feed/subscriptions') return;
    if (!state.subscribedChannelSet || state.subscribedChannelSet.size === 0) return;

    const key = getChannelKeyFromRenderer(item);
    if (!key) {
      // Can't determine the channel - leave it visible rather than risk
      // hiding something that actually is a subscription.
      item.classList.remove('niixtube-hidden-nonsub');
      return;
    }
    if (state.subscribedChannelSet.has(key)) {
      item.classList.remove('niixtube-hidden-nonsub');
    } else {
      item.classList.add('niixtube-hidden-nonsub');
    }
  }

  function forceLatestSort() {
    if (!state.settings.subscriptionsOnlyHome) return;
    if (window.location.pathname !== '/feed/subscriptions') return;
    if (state.sortForced || state.sortAttempts >= MAX_SORT_ATTEMPTS) return;
    state.sortAttempts += 1;

    // Scoped to likely filter-bar containers only - never the whole document -
    // so this never turns into a full-page button scan.
    const bar = document.querySelector(SELECTORS.sortBar);
    const scope = bar || document;
    const trigger = Array.from(scope.querySelectorAll('tp-yt-paper-button, ytd-toggle-button-renderer')).find(
      (el) => (el.textContent || '').trim().toLowerCase() === 'most relevant'
    );
    if (!trigger) return; // will retry a few more cheap ticks, then give up for good

    state.sortForced = true; // stop retrying regardless of the outcome below
    trigger.click();
    setTimeout(() => {
      const option = Array.from(
        document.querySelectorAll('a.yt-simple-endpoint, tp-yt-paper-item, ytd-menu-service-item-renderer')
      ).find((el) => /^(latest|newest)/i.test((el.textContent || '').trim()));
      if (option) option.click();
      // The chip's own displayed label doesn't reliably update to say
      // "Latest" once selected - a YouTube rendering quirk on their end,
      // not something clicking harder fixes. The underlying video order
      // is already correct at this point, so leaving a stale "Most
      // relevant" label visible would just be actively misleading about
      // what's actually happening - hide the chip/bar rather than let it
      // keep claiming something that isn't true anymore.
      const wrap = trigger.closest(SELECTORS.sortBar) || trigger;
      wrap.classList.add('niixtube-hidden-sort-chip');
    }, 350);
  }

  function hideMostRelevantShelf() {
    if (!state.settings.subscriptionsOnlyHome) return;
    if (window.location.pathname !== '/feed/subscriptions') return;
    if (state.shelfAttempts >= MAX_SHELF_ATTEMPTS) return; // stop polling once we've given it a fair chance
    state.shelfAttempts += 1;
    // Separate from forceLatestSort() above - that fixes the sort-order
    // control itself. This handles something YouTube can insert
    // independently of it: an algorithmic "Most relevant" shelf/carousel
    // near the top of the subscriptions feed, sitting above the (already
    // correctly subscriptions-only, latest-first) main grid rather than
    // being part of it - the main feed's own sort has nothing to do with
    // whether this shelf appears.
    //
    // Matched by the shelf's own title text, not a positional selector -
    // this page assigns a unique per-video content-id to elements and can
    // reorder/insert sections, so nth-of-type-style selectors (the kind a
    // browser's own "pick an element" tool tends to generate) are exactly
    // the wrong thing to match against here; they break the moment
    // anything on the page shifts, even though nothing about the shelf
    // itself has changed.
    const sections = document.querySelectorAll('ytd-rich-section-renderer');
    for (const section of sections) {
      if (section.dataset.niixtubeShelfChecked === '1') continue;
      section.dataset.niixtubeShelfChecked = '1'; // check each section at most once - cheap either way, but no reason to repeat it
      const titleEl = section.querySelector('#title');
      const text = ((titleEl ? titleEl.textContent : section.textContent) || '').trim();
      if (/^most relevant\b/i.test(text)) {
        section.classList.add('niixtube-hidden-shelf');
      }
    }
  }

  // ---------- Feature: auto-select the original (non-dubbed) audio track ----------
  //
  // Deliberately drives the player's own settings UI (the ytp-* classes,
  // part of YouTube's long-stable HTML5 player chrome shared across watch
  // pages and embeds) rather than YouTube's internal, undocumented player
  // JS object (movie_player.getAvailableAudioTracks()/.setAudioTrack()).
  // That internal API exists, but its track objects expose their data
  // through minified/obfuscated property names that shift between
  // YouTube's own deployments - the UI's class names and visible label
  // text ("Audio track", "original") have stayed far more stable over time,
  // which is also why the one dedicated extension for this exact feature
  // (github.com/Bilalkamal/YouTube-Original-Audio-Track) takes the same
  // UI-driven approach instead of the internal API.
  function currentWatchVideoId() {
    if (window.location.pathname !== '/watch') return null;
    try {
      const id = new URLSearchParams(window.location.search).get('v');
      return id && VIDEO_ID_PATTERN.test(id) ? id : null;
    } catch (err) {
      return null;
    }
  }

  function findPlayerMenuItem(matchFn) {
    const items = document.querySelectorAll('.ytp-panel-menu .ytp-menuitem, .ytp-settings-menu .ytp-menuitem');
    for (const item of items) {
      const label = item.querySelector('.ytp-menuitem-label');
      const text = ((label ? label.textContent : item.textContent) || '').trim();
      if (matchFn(text)) return item;
    }
    return null;
  }

  function isSettingsPanelVisible() {
    // Checks the panel's actual rendered presence rather than the gear
    // button's aria-expanded attribute - that attribute isn't reliably
    // kept in sync by YouTube's player chrome for this button, which is
    // exactly what caused the panel to get left open on nearly every
    // video: this function runs on every video, most videos don't have
    // multiple audio tracks, and that's precisely the code path that
    // trusted aria-expanded to decide whether it still needed to close
    // what it had opened.
    const menu = document.querySelector('.ytp-settings-menu, .ytp-panel-menu');
    return !!menu && menu.offsetParent !== null;
  }

  function closeSettingsPanel(gear) {
    if (!isSettingsPanelVisible()) return;
    // Primary: re-click the same button that opened it. This is the
    // mechanism we KNOW works, since it's literally the toggle used to
    // open the panel in the first place - unlike a synthetic Escape
    // keypress, which many custom player UIs (this one very possibly
    // included) simply don't bind to closing a settings dropdown, since
    // Escape often means something else in a video player context (e.g.
    // exiting fullscreen).
    if (gear) gear.click();
    if (!isSettingsPanelVisible()) return;
    // Still open - fall back to a synthetic Escape as a second attempt,
    // dispatched on the player container specifically rather than
    // `document`, so it reaches a listener bound to the player itself
    // rather than only ones on document/window.
    const player = document.querySelector('#movie_player, .html5-video-player') || document;
    player.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Escape',
        code: 'Escape',
        keyCode: 27,
        which: 27,
        bubbles: true,
        cancelable: true
      })
    );
  }

  function selectOriginalAudioTrack() {
    if (!state.settings.originalAudioTrack) return;
    const videoId = currentWatchVideoId();
    if (!videoId) return;
    if (state.audioTrackVideoId !== videoId) {
      state.audioTrackVideoId = videoId;
      state.audioTrackAttempts = 0;
    }
    if (state.audioTrackAttempts >= MAX_AUDIO_TRACK_ATTEMPTS) return; // give up quietly for this video
    state.audioTrackAttempts += 1;

    const gear = document.querySelector('.ytp-settings-button');
    if (!gear) return; // player chrome not ready yet - retried next cheap tick

    const wasOpen = isSettingsPanelVisible();
    if (!wasOpen) gear.click();

    const audioRow = findPlayerMenuItem((t) => /audio track/i.test(t));
    if (!audioRow) {
      // Most videos don't have multiple audio tracks at all - nothing to
      // switch. Stop retrying for this video rather than reopening the
      // settings panel every tick for the rest of the watch.
      state.audioTrackAttempts = MAX_AUDIO_TRACK_ATTEMPTS;
      if (!wasOpen) closeSettingsPanel(gear);
      return;
    }
    audioRow.click();

    const original =
      findPlayerMenuItem((t) => /\boriginal\b/i.test(t)) ||
      findPlayerMenuItem((t) => t.length > 0 && !/auto[- ]?dub|dubbed|audio description/i.test(t));
    if (!original) {
      // Couldn't confidently tell which entry is the original track - back
      // out without guessing, and let the next cheap tick try again rather
      // than leaving the settings panel open on the audio-track submenu.
      if (!wasOpen) closeSettingsPanel(gear);
      return;
    }
    original.click();
    state.audioTrackAttempts = MAX_AUDIO_TRACK_ATTEMPTS; // done for this video

    // YouTube normally closes the panel itself after a leaf selection; only
    // step in if it's still open, and only if we're the ones who opened it.
    if (!wasOpen) closeSettingsPanel(gear);
  }

  // ---------- Feature 2: grey out fully watched videos ----------
  function readProgressBarPercent(bar) {
    // Old component exposes the watched percentage directly as an inline
    // style="width: N%" on the bar itself.
    const inlineWidth = parseFloat((bar.style && bar.style.width) || '');
    if (!Number.isNaN(inlineWidth)) return inlineWidth;

    // The newer view-model component doesn't reliably set that inline
    // style, so fall back to measuring the filled segment against its
    // track's rendered width - works regardless of how the percentage is
    // actually implemented under the hood (CSS var, flex-basis, etc.).
    const track = bar.parentElement;
    if (track && track.offsetWidth > 0) {
      const pct = (bar.offsetWidth / track.offsetWidth) * 100;
      if (Number.isFinite(pct) && pct > 0) return pct;
    }
    return null;
  }

  /** Pure read: measures whether an item is watched, without touching the
   *  DOM. Kept separate from applyGreyOutWatchedFromPercent() specifically
   *  so a whole batch of items can be measured before any of them are
   *  written to - see processItems() below for why that ordering matters. */
  function measureWatchedPercent(item) {
    if (!state.settings.greyOutWatched) return null;
    const bar = item.querySelector(SELECTORS.progressBar);
    if (!bar) return null;
    return readProgressBarPercent(bar);
  }

  function applyGreyOutWatchedFromPercent(item, percent) {
    if (!state.settings.greyOutWatched) {
      item.classList.remove('niixtube-watched');
      removeWatchedBadge(item);
      return;
    }
    if (percent !== null && percent >= state.settings.watchedThreshold) {
      item.classList.add('niixtube-watched');
      if (state.settings.watchedBadge) {
        addWatchedBadge(item);
      } else {
        removeWatchedBadge(item);
      }
    } else {
      item.classList.remove('niixtube-watched');
      removeWatchedBadge(item);
    }
  }

  function addWatchedBadge(item) {
    const host = item.querySelector(SELECTORS.thumbnailHost);
    if (!host || host.querySelector('.niixtube-watched-badge')) return;
    // Reused by the enqueue-button feature too - idempotent, so it's safe
    // to add here even when enqueue is off.
    host.classList.add('niixtube-thumb-relative');
    const badge = document.createElement('div');
    badge.className = 'niixtube-watched-badge';
    badge.textContent = 'Watched';
    host.appendChild(badge);
  }

  function removeWatchedBadge(item) {
    const badge = item.querySelector('.niixtube-watched-badge');
    if (badge) badge.remove();
  }

  // ---------- Feature 4: hide Shorts ----------
  function applyHideShortsClass() {
    document.documentElement.classList.toggle('niixtube-hide-shorts', !!state.settings.hideShorts);
  }

  function redirectShortsToWatch() {
    if (!state.settings.hideShorts) return;
    if (window.location.pathname.startsWith('/shorts/')) {
      const id = window.location.pathname.split('/')[2];
      if (id) {
        window.location.replace(`https://www.youtube.com/watch?v=${id}`);
      }
    }
  }

  // ---------- Feature 3: enqueue system ----------
  function showToast(message) {
    let toast = document.getElementById('niixtube-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'niixtube-toast';
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.classList.add('niixtube-toast-visible');
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => {
      toast.classList.remove('niixtube-toast-visible');
    }, 1800);
  }

  function flashButton(btn, text) {
    const original = btn.textContent;
    btn.textContent = text;
    btn.classList.add('niixtube-flash');
    setTimeout(() => {
      btn.textContent = original;
      btn.classList.remove('niixtube-flash');
    }, 900);
  }

  /** Parses a duration badge's text (e.g. "12:34" or "1:02:03") into total
   *  seconds. Searches for a duration-shaped substring rather than
   *  requiring the entire element's text to be nothing else - the original
   *  version required an exact match, which silently failed whenever the
   *  badge's textContent carried anything else alongside the visible
   *  duration (e.g. a separate hidden/accessibility text node as a
   *  sibling - a common, standard pattern, and enough on its own to make
   *  every match fail even though the duration was right there). Returns
   *  null for anything with no duration-shaped substring at all (including
   *  YouTube's non-duration overlay labels like "LIVE" or "SHORTS"). */
  function parseDurationText(text) {
    if (!text) return null;
    const match = text.match(/\b(\d{1,2})(:\d{2}){1,2}\b/);
    if (!match) return null;
    const parts = match[0].split(':').map((p) => parseInt(p, 10));
    if (parts.some((p) => Number.isNaN(p))) return null;
    return parts.reduce((total, part) => total * 60 + part, 0);
  }

  /** Best-effort video length for a feed/grid item, used only to total up
   *  queued watch time in the popup - never anything load-bearing, so a
   *  miss here just means that one video doesn't count toward the total
   *  rather than breaking anything. Tries the long-stable overlay class
   *  first, then falls back to scanning the thumbnail area for text that
   *  simply looks like a duration (M:SS / MM:SS / H:MM:SS) regardless of
   *  the exact class name - YouTube's overlay markup has shifted before
   *  (see the progress-bar and title-translation fixes elsewhere in this
   *  file) and a pattern match survives that better than a class name does. */
  /** Best-effort video length for a feed/grid item, used only to total up
   *  queued watch time in the popup - never anything load-bearing, so a
   *  miss here just means that one video doesn't count toward the total
   *  rather than breaking anything. Tries the long-stable overlay class
   *  first, then falls back to scanning the thumbnail area for text that
   *  contains something duration-shaped (M:SS / MM:SS / H:MM:SS) regardless
   *  of the exact class name - YouTube's overlay markup has shifted before
   *  (see the progress-bar and title-translation fixes elsewhere in this
   *  file) and a pattern match survives that better than a class name does. */
  /** Reads YouTube's own embedded structured data for the current page -
   *  the actual source data used to render everything on the page,
   *  including exact video lengths, before any of it becomes visible
   *  badge text. Far more reliable than scraping rendered text, since
   *  visual markup churns constantly (see the many selector fixes
   *  elsewhere in this file) while the underlying data shape is much more
   *  stable. Content scripts run in an isolated JS world and can't reach
   *  the page's own `window.ytInitialData` variable directly, but the
   *  <script> tag that DEFINES it is still a real, readable DOM node -
   *  this reads its raw text and parses the JSON itself instead. Cached
   *  for the lifetime of the current page view, since it doesn't change
   *  after initial load (see the caveat on durationFromPageData below). */
  function findYtInitialData() {
    if (state.ytInitialDataChecked) return state.cachedYtInitialData;
    state.ytInitialDataChecked = true; // only ever try parsing this once per page - if it fails, it'll keep failing the same way
    for (const script of document.querySelectorAll('script')) {
      const text = script.textContent;
      if (!text || !text.includes('ytInitialData')) continue;
      const match = text.match(/ytInitialData"?\]?\s*=\s*(\{.+?\})\s*;/s);
      if (!match) continue;
      try {
        state.cachedYtInitialData = JSON.parse(match[1]);
        return state.cachedYtInitialData;
      } catch (err) {
        /* malformed or unexpected shape - keep looking at other script tags */
      }
    }
    return null;
  }

  /** Recursively searches YouTube's data for the renderer object belonging
   *  to a specific video ID, generically (by looking for a `videoId` field
   *  matching, rather than hardcoding an exact nesting path) - the exact
   *  schema varies by page type (home/subscriptions/search/watch) and
   *  isn't worth tracking precisely when a generic search is this cheap to
   *  run once per enqueue. Depth-limited defensively against unexpectedly
   *  deep/cyclical structures, not because the real data is expected to
   *  need it. */
  function findRendererForVideoId(node, videoId, depth) {
    if (depth > 40 || node === null || typeof node !== 'object') return null;
    if (Array.isArray(node)) {
      for (const child of node) {
        const found = findRendererForVideoId(child, videoId, depth + 1);
        if (found) return found;
      }
      return null;
    }
    if (node.videoId === videoId) return node;
    for (const key of Object.keys(node)) {
      const found = findRendererForVideoId(node[key], videoId, depth + 1);
      if (found) return found;
    }
    return null;
  }

  /** Known caveat: ytInitialData only reflects what was on the page at
   *  initial load - videos that appeared later via infinite-scroll
   *  pagination won't be in it. That's exactly what the badge-scraping
   *  fallback in extractDurationSeconds below is for; this is tried first
   *  because it's more reliable when it does have the answer, not because
   *  it's guaranteed to. */
  function durationFromPageData(videoId) {
    const data = findYtInitialData();
    if (!data) return null;
    const renderer = findRendererForVideoId(data, videoId, 0);
    if (!renderer || !renderer.lengthText) return null;
    const text =
      renderer.lengthText.simpleText ||
      (renderer.lengthText.accessibility &&
        renderer.lengthText.accessibility.accessibilityData &&
        renderer.lengthText.accessibility.accessibilityData.label);
    return parseDurationText(text);
  }

  function extractDurationSeconds(item, videoId) {
    const fromPageData = videoId ? durationFromPageData(videoId) : null;
    if (fromPageData) return fromPageData;

    const known = item.querySelector(
      'ytd-thumbnail-overlay-time-status-renderer #text, .ytd-thumbnail-overlay-time-status-renderer, [class*="ThumbnailOverlayBadge" i], [class*="badge-shape" i]'
    );
    if (known) {
      const parsed = parseDurationText(known.textContent);
      if (parsed) return parsed;
    }
    const host = item.querySelector(SELECTORS.thumbnailHost) || item;
    for (const el of host.querySelectorAll('span, div')) {
      const parsed = parseDurationText(el.textContent);
      if (parsed) return parsed;
    }
    return null;
  }

  function extractRendererContext(item, videoId) {
    const titleEl = item.querySelector(SELECTORS.videoTitle);
    const title = titleEl ? titleEl.textContent.trim() : `YouTube video (${videoId})`;
    const channelEl = item.querySelector(SELECTORS.channelLink);
    const channel = channelEl ? channelEl.textContent.trim() : '';
    const durationSeconds = extractDurationSeconds(item, videoId);
    return { videoId, title, thumbnail: thumbnailUrl(videoId), channel, durationSeconds };
  }

  function getWatchPageContext() {
    const params = new URLSearchParams(window.location.search);
    const videoId = params.get('v');
    if (!videoId || !VIDEO_ID_PATTERN.test(videoId)) return null;
    const title = document.title.replace(/ - YouTube$/, '') || `YouTube video (${videoId})`;
    const channelEl = document.querySelector(SELECTORS.channelLink);
    const channel = channelEl ? channelEl.textContent.trim() : '';
    // The native <video> element's own .duration is far more reliable than
    // scraping a text badge - real, standard, no YouTube-specific markup
    // to break - and it's only available on the watch page itself, since
    // it requires the video to have actually loaded metadata.
    const videoEl = document.querySelector(SELECTORS.video);
    const durationSeconds =
      videoEl && Number.isFinite(videoEl.duration) && videoEl.duration > 0 ? Math.round(videoEl.duration) : null;
    return { videoId, title, thumbnail: thumbnailUrl(videoId), channel, durationSeconds };
  }

  function findVideoContextById(videoId) {
    const links = document.querySelectorAll(`${SELECTORS.thumbnailLink}, a#video-title`);
    for (const link of links) {
      const id = extractVideoId(link.getAttribute('href') || '');
      if (id !== videoId) continue;
      const item = link.closest(SELECTORS.videoRenderer);
      if (item) return extractRendererContext(item, videoId);
    }
    const watchContext = getWatchPageContext();
    if (watchContext && watchContext.videoId === videoId) return watchContext;
    return null;
  }

  function buildEnqueueButtons(context, opts) {
    const verbose = !!(opts && opts.verbose);
    const wrap = document.createElement('div');
    wrap.className = verbose ? 'niixtube-enqueue-wrap niixtube-verbose' : 'niixtube-enqueue-wrap';

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'niixtube-enqueue-btn';
    addBtn.title = 'Add to niixtube queue';
    addBtn.textContent = verbose ? '+ Add to Queue' : '+Q';
    addBtn.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      await nxSend('ENQUEUE', { item: { ...context, addedAt: Date.now() }, next: false });
      flashButton(addBtn, verbose ? 'Added \u2713' : 'Added');
    });

    const nextBtn = document.createElement('button');
    nextBtn.type = 'button';
    nextBtn.className = 'niixtube-enqueue-next-btn';
    nextBtn.title = 'Play next in niixtube queue';
    nextBtn.textContent = verbose ? '\u23ED Play Next' : '\u23ED Q';
    nextBtn.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      await nxSend('ENQUEUE', { item: { ...context, addedAt: Date.now() }, next: true });
      flashButton(nextBtn, verbose ? 'Added \u2713' : 'Added');
    });

    wrap.appendChild(addBtn);
    wrap.appendChild(nextBtn);
    return wrap;
  }

  function injectEnqueueButtonForItem(item, resolvedVideoId) {
    if (!state.settings.enqueueEnabled) return;
    let videoId = resolvedVideoId;
    if (!videoId) {
      const link = item.querySelector(SELECTORS.thumbnailLink);
      videoId = link ? extractVideoId(link.getAttribute('href') || '') : null;
    }
    if (!videoId) return;

    const existing = item.querySelector('.niixtube-enqueue-wrap');
    if (existing) {
      // YouTube sometimes reuses an existing renderer node for a different
      // video (e.g. during recycled-list updates) without ever removing it,
      // so a plain "already has a wrap" check can leave a stale button
      // pointing at the wrong video. Re-inject only when the ID changed.
      if (existing.dataset.niixtubeVideoId === videoId) return;
      existing.remove();
    }

    const context = extractRendererContext(item, videoId);
    const host =
      item.querySelector(SELECTORS.thumbnailHost) || item.querySelector(SELECTORS.thumbnailLink);
    // A plain class instead of a getComputedStyle() read-then-write, which
    // would otherwise force a synchronous layout on every single item.
    host.classList.add('niixtube-thumb-relative');
    const wrap = buildEnqueueButtons(context);
    wrap.dataset.niixtubeVideoId = videoId;
    host.appendChild(wrap);
  }

  function injectWatchPageEnqueue() {
    if (window.location.pathname !== '/watch') return;
    if (!state.settings.enqueueEnabled) return;
    const actions = document.querySelector(
      '#top-level-buttons-computed, #menu-container #top-level-buttons-computed, ytd-menu-renderer#menu'
    );
    // No container yet (YouTube often renders the action row asynchronously
    // after navigation finishes) - this is called repeatedly from the cheap
    // tick loop, so it just tries again next tick instead of giving up.
    if (!actions || actions.querySelector('.niixtube-enqueue-wrap')) return;

    const context = getWatchPageContext();
    if (!context) return;
    actions.appendChild(buildEnqueueButtons(context, { verbose: true }));
  }

  function attachVideoEndedHandler() {
    if (window.location.pathname !== '/watch') return;
    if (!state.settings.enqueueEnabled) return;
    const video = document.querySelector(SELECTORS.video);
    if (!video || video === state.lastVideoEl) return;
    state.lastVideoEl = video;
    video.addEventListener('ended', onVideoEnded);
  }

  // Keeps state.cachedNextQueueItem in sync with the stored queue at all
  // times (not just when a video happens to end), so the moment 'ended'
  // fires there is already a known target to jump to - no async round trip
  // to the background script at that exact moment. That round trip used to
  // run *after* the video had already ended, which gave YouTube's own
  // autoplay countdown overlay (which reacts to the same 'ended' event,
  // independently, immediately) time to visibly render before our slower
  // navigation took over. Priming this ahead of time removes that gap.
  function refreshCachedNextQueueItem(queue) {
    const list = Array.isArray(queue) ? queue : [];
    state.cachedNextQueueItem = list.length ? list[0] : null;
  }

  async function primeCachedNextQueueItem() {
    refreshCachedNextQueueItem(await nxSend('GET_QUEUE'));
  }

  if (browser.storage && browser.storage.onChanged) {
    browser.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.queue) {
        refreshCachedNextQueueItem(changes.queue.newValue);
      }
    });
  }

  /** Navigates to another video. Uses a direct location.href assignment
   *  (a real, guaranteed page navigation) rather than trying to trigger
   *  YouTube's own internal SPA router via a synthetic click - that would
   *  be faster in principle, but depends on an assumption that isn't safe
   *  to rely on: YouTube's router may specifically check event.isTrusted
   *  (which is always false for a JS-triggered .click()) to distinguish
   *  real clicks from scripted ones, in which case a synthetic click
   *  simply wouldn't be intercepted the way a real one is - and unlike the
   *  cache-priming below, that's not something this extension can verify
   *  or work around reliably. location.href is slower per-navigation than
   *  a true SPA transition would be, but it always works, and the bigger
   *  source of the original delay - waiting for an async round trip to
   *  the background script *after* the video had already ended - is gone
   *  regardless of which navigation method fires it. */
  function navigateToVideoFast(videoId) {
    window.location.href = `https://www.youtube.com/watch?v=${videoId}`;
  }

  function onVideoEnded() {
    if (!state.settings.enqueueEnabled) return;
    const next = state.cachedNextQueueItem;
    if (!next || !next.videoId) return;
    const endedVideoId = currentWatchVideoId();
    navigateToVideoFast(next.videoId); // fired first, synchronously - nothing below this blocks it
    // Tell the background script to actually remove these from the stored
    // queue - fire-and-forget, since the navigation above has already
    // started and doesn't need to wait on it.
    nxSend('VIDEO_ENDED', { endedVideoId, playedVideoId: next.videoId }).catch(() => {});
  }

  // ---------- Native right-click context menu support ----------
  async function handleContextEnqueueMessage(message) {
    const videoId = message.videoId;
    const next = message.next === true;
    // The background script already validates this before sending it, but
    // messages are a trust boundary in their own right - re-check here
    // rather than assume the sender's shape held.
    if (!videoId || !VIDEO_ID_PATTERN.test(videoId)) return;
    let context = findVideoContextById(videoId);
    if (!context) {
      // Nothing on the current page matched this link (common when
      // right-clicking a recommendation the extension hasn't scanned yet) -
      // fall back to a real title lookup instead of showing the raw ID.
      const resolvedTitle = await fetchTitleViaOEmbed(videoId);
      context = {
        videoId,
        title: resolvedTitle || `YouTube video (${videoId})`,
        thumbnail: thumbnailUrl(videoId),
        channel: ''
      };
    }
    await nxSend('ENQUEUE', { item: { ...context, addedAt: Date.now() }, next });
    showToast(next ? 'Added to front of niixtube queue' : 'Added to niixtube queue');
  }

  // ---------- Feature 5: seamless continue watching ----------
  function watchContinueDialog() {
    if (window.location.pathname !== '/watch') return;
    if (!state.settings.autoContinueWatching || state.dismissingDialog) return;
    const dialog = document.querySelector(SELECTORS.continueWatchingDialog);
    if (!dialog) return;
    const text = (dialog.textContent || '').toLowerCase();
    if (text.includes('still watching') || text.includes('video paused')) {
      const confirmBtn = dialog.querySelector('button');
      if (confirmBtn) {
        state.dismissingDialog = true;
        confirmBtn.click();
        setTimeout(() => {
          state.dismissingDialog = false;
        }, 500);
      }
    }
  }

  // ---------- Per-item work, run ONLY on newly added nodes ----------
  //
  // processItems() deliberately measures every item BEFORE writing to any
  // of them, instead of doing read-then-write per item in a loop. The
  // watched-percentage measurement (measureWatchedPercent) can force a
  // synchronous layout reflow when it falls back to reading offsetWidth
  // (see readProgressBarPercent) - interleaving that read with this-item's
  // classList/badge/hide writes means each item's write invalidates the
  // layout the NEXT item's read needs, forcing a fresh reflow per item
  // ("layout thrashing"). Batching all the reads first, then all the
  // writes, lets the browser do this in one shared reflow for the whole
  // batch instead of one per item - the more items on the page (YouTube's
  // homepage can easily have 30-60+), the more this matters.
  function processItems(items) {
    if (!items.length) return;
    const measured = items.map((item) => {
      let percent = null;
      let videoId = null;
      safe(() => {
        percent = measureWatchedPercent(item);
      });
      safe(() => {
        // Extracted once here and threaded through to both
        // injectEnqueueButtonForItem and the title-fix step below, instead
        // of each feature separately re-querying the same thumbnail link.
        const link = item.querySelector(SELECTORS.thumbnailLink);
        videoId = link ? extractVideoId(link.getAttribute('href') || '') : null;
      });
      return { item, percent, videoId };
    });

    // One batched lookup for the whole set instead of one storage round
    // trip per item - see the comment above prefetchOriginalTitles(). The
    // per-item title application below is chained through this promise
    // (not fired independently) specifically so every item's own
    // getOriginalTitle() call finds titleCacheMem already populated by the
    // time it runs - calling it independently before this batch call's
    // storage.get() had resolved would make each item trigger its own
    // separate single-ID lookup anyway, defeating the batching entirely.
    const titleIds = measured.map((m) => m.videoId).filter(Boolean);
    const titlesReady = state.settings.originalTitles
      ? prefetchOriginalTitles(titleIds).catch(() => {})
      : Promise.resolve();

    measured.forEach(({ item, percent, videoId }) => {
      safe(() => applyGreyOutWatchedFromPercent(item, percent));
      safe(() => applySubscribedOnlyFilterItem(item));
      safe(() => injectEnqueueButtonForItem(item, videoId));
      if (videoId) {
        titlesReady.then(() => safe(() => applyOriginalTitleForItem(item, videoId)));
      }
    });
  }

  function processItem(item) {
    processItems([item]);
  }

  function collectRendererDescendants(node, out) {
    if (!(node instanceof Element)) return;
    if (node.matches && node.matches(SELECTORS.videoRenderer)) out.push(node);
    if (node.querySelectorAll) {
      node.querySelectorAll(SELECTORS.videoRenderer).forEach((el) => out.push(el));
    }
  }

  /** A single full pass over every renderer currently on the page. Used only
   *  at well-defined trigger points (init, settings change, navigation,
   *  subscribed-channel-list refresh) - never on every mutation. */
  function fullDocumentItemPass() {
    processItems(Array.from(document.querySelectorAll(SELECTORS.videoRenderer)));
    safe(injectWatchPageEnqueue);
  }

  /** Cheap, page-wide checks that are safe to run frequently because none of
   *  them scan large node lists. Throttled to at most 4x/second. */
  function runCheapChecks(force) {
    const now = performance.now();
    if (!force && now - state.lastCheapRun < CHEAP_TICK_INTERVAL_MS) return;
    state.lastCheapRun = now;
    safe(redirectShortsToWatch);
    safe(redirectHomeToSubscriptions);
    safe(applyHideShortsClass);
    safe(forceLatestSort);
    safe(hideMostRelevantShelf);
    safe(watchContinueDialog);
    safe(attachVideoEndedHandler);
    // Retried here (not just at navigation) because YouTube's action-button
    // row often isn't in the DOM yet when navigation "finishes" - this call
    // is a cheap no-op once the button exists, so it's safe to keep polling.
    safe(injectWatchPageEnqueue);
    safe(selectOriginalAudioTrack);
    safe(applyOriginalWatchTitle);
  }

  // ---------- orchestration ----------
  function processMutationBatch(mutations) {
    const items = [];
    for (const m of mutations) {
      m.addedNodes.forEach((node) => collectRendererDescendants(node, items));
    }
    processItems(items);
    if (location.href !== state.lastUrl) {
      state.lastUrl = location.href;
      onNavigate();
    }
    runCheapChecks(false);
  }

  function scheduleMutationProcessing(mutations) {
    state.pendingMutations.push(...mutations);
    if (state.rafScheduled) return;
    state.rafScheduled = true;
    requestAnimationFrame(() => {
      state.rafScheduled = false;
      const batch = state.pendingMutations;
      state.pendingMutations = [];
      processMutationBatch(batch);
    });
  }

  function onNavigate() {
    state.sortForced = false;
    state.sortAttempts = 0;
    state.shelfAttempts = 0;
    if (window.location.pathname === '/feed/subscriptions') {
      refreshSubscribedChannels(false);
    }
    runCheapChecks(true);
    fullDocumentItemPass();
  }

  function setupObserver() {
    const domObserver = new MutationObserver(scheduleMutationProcessing);
    domObserver.observe(document.documentElement, { childList: true, subtree: true });
    // YouTube's own SPA-navigation signal - a reliable, low-overhead backstop
    // for the location.href check above.
    window.addEventListener('yt-navigate-finish', () => setTimeout(onNavigate, 250));
  }

  function watchSettingsChanges() {
    browser.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.settings) {
        state.settings = { ...state.settings, ...changes.settings.newValue };
        runCheapChecks(true);
        fullDocumentItemPass();
      }
    });
  }

  // ---------- Right-click detection (feeds background.js's context menu) ----------
  //
  // Deliberately resolves the video ourselves from the actual rendered DOM,
  // instead of relying on the browser's own "was this a link?" detection
  // that contexts: ['link'] + targetUrlPatterns would use in the manifest.
  // That detection only works when the right-clicked element is a genuine
  // <a href> matching the given patterns - YouTube's home/subscriptions
  // grid doesn't consistently wrap thumbnails in real anchors across all
  // its rendering paths, so that approach could show the menu on some
  // pages/rollouts and not others for reasons that have nothing to do with
  // this extension. Walking up from whatever was actually clicked works
  // the same way regardless of the underlying markup.
  function resolveRightClickedVideo(target) {
    if (!(target instanceof Element)) return null;
    const item = target.closest(SELECTORS.videoRenderer);
    if (item) {
      const link = item.querySelector(SELECTORS.thumbnailLink);
      const videoId = link ? extractVideoId(link.getAttribute('href') || '') : null;
      if (videoId) return extractRendererContext(item, videoId);
    }
    // Not inside a feed/grid item - check whether this is a right-click
    // somewhere inside the watch page's own player/metadata area instead.
    if (target.closest('#player, #player-container, ytd-watch-metadata, #above-the-fold')) {
      return getWatchPageContext();
    }
    return null;
  }

  function watchRightClicks() {
    // Capture phase so this still runs even if YouTube's own JS calls
    // stopPropagation() on the event further down the tree.
    document.addEventListener(
      'contextmenu',
      (event) => {
        const context = resolveRightClickedVideo(event.target);
        // Always sent, including null (as videoId: undefined) - a stale
        // "last resolved video" from a previous right-click would otherwise
        // make the menu appear for an unrelated later right-click on blank
        // space, since background.js only knows what we last told it.
        nxSend('SET_LAST_RIGHT_CLICKED', context ? context : { videoId: null });
      },
      true
    );
  }

  function watchRuntimeMessages() {
    browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message && message.type === 'CONTEXT_ENQUEUE') {
        handleContextEnqueueMessage(message);
        sendResponse(true);
      } else if (message && message.type === 'CONTEXT_ENQUEUE_NONE') {
        // Menu items are always visible now (see the comment on
        // lastRightClicked in background.js for why), so a click can
        // legitimately resolve nothing - say so rather than doing nothing
        // silently, which would otherwise look like the extension is
        // just broken.
        showToast("No video found for that click");
        sendResponse(true);
      }
    });
  }

  async function init() {
    await loadSettings();
    runCheapChecks(true);
    if (window.location.pathname === '/feed/subscriptions') {
      await refreshSubscribedChannels(false);
    }
    if (state.settings.enqueueEnabled) {
      primeCachedNextQueueItem(); // don't block init on this - it just needs to land before any video actually ends
    }
    fullDocumentItemPass();
    setupObserver();
    watchSettingsChanges();
    watchRuntimeMessages();
    watchRightClicks();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
