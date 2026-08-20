'use strict';

(function () {
  const DEFAULT_SETTINGS = {
    subscriptionsOnlyHome: true,
    greyOutWatched: true,
    watchedBadge: true,
    hideShorts: true,
    autoContinueWatching: true,
    enqueueEnabled: true,
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

  const state = {
    settings: { ...DEFAULT_SETTINGS },
    dismissingDialog: false,
    lastVideoEl: null,
    lastUrl: location.href,
    subscribedChannelSet: null,
    subscribedChannelsLoading: false,
    sortForced: false,
    sortAttempts: 0,
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
   *  is already a granted host, so this is a plain same-site fetch. */
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
    }, 350);
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

  function applyGreyOutWatchedItem(item) {
    if (!state.settings.greyOutWatched) {
      item.classList.remove('niixtube-watched');
      removeWatchedBadge(item);
      return;
    }
    const bar = item.querySelector(SELECTORS.progressBar);
    if (!bar) {
      item.classList.remove('niixtube-watched');
      removeWatchedBadge(item);
      return;
    }
    const width = readProgressBarPercent(bar);
    if (width !== null && width >= state.settings.watchedThreshold) {
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

  function extractRendererContext(item, videoId) {
    const titleEl = item.querySelector(SELECTORS.videoTitle);
    const title = titleEl ? titleEl.textContent.trim() : `YouTube video (${videoId})`;
    const channelEl = item.querySelector(SELECTORS.channelLink);
    const channel = channelEl ? channelEl.textContent.trim() : '';
    return { videoId, title, thumbnail: thumbnailUrl(videoId), channel };
  }

  function getWatchPageContext() {
    const params = new URLSearchParams(window.location.search);
    const videoId = params.get('v');
    if (!videoId) return null;
    const title = document.title.replace(/ - YouTube$/, '') || `YouTube video (${videoId})`;
    const channelEl = document.querySelector(SELECTORS.channelLink);
    const channel = channelEl ? channelEl.textContent.trim() : '';
    return { videoId, title, thumbnail: thumbnailUrl(videoId), channel };
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

  function injectEnqueueButtonForItem(item) {
    if (!state.settings.enqueueEnabled) return;
    const link = item.querySelector(SELECTORS.thumbnailLink);
    if (!link) return;
    const videoId = extractVideoId(link.getAttribute('href') || '');
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
    const host = item.querySelector(SELECTORS.thumbnailHost) || link;
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

  async function onVideoEnded() {
    if (!state.settings.enqueueEnabled) return;
    const params = new URLSearchParams(window.location.search);
    const currentVideoId = params.get('v');
    const next = await nxSend('VIDEO_ENDED', { videoId: currentVideoId });
    if (next && next.videoId) {
      window.location.href = `https://www.youtube.com/watch?v=${next.videoId}`;
    }
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
  function processItem(item) {
    safe(() => applyGreyOutWatchedItem(item));
    safe(() => applySubscribedOnlyFilterItem(item));
    safe(() => injectEnqueueButtonForItem(item));
  }

  function processAddedNode(node) {
    if (!(node instanceof Element)) return;
    if (node.matches && node.matches(SELECTORS.videoRenderer)) {
      processItem(node);
    }
    if (node.querySelectorAll) {
      node.querySelectorAll(SELECTORS.videoRenderer).forEach(processItem);
    }
  }

  /** A single full pass over every renderer currently on the page. Used only
   *  at well-defined trigger points (init, settings change, navigation,
   *  subscribed-channel-list refresh) - never on every mutation. */
  function fullDocumentItemPass() {
    document.querySelectorAll(SELECTORS.videoRenderer).forEach(processItem);
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
    safe(watchContinueDialog);
    safe(attachVideoEndedHandler);
    // Retried here (not just at navigation) because YouTube's action-button
    // row often isn't in the DOM yet when navigation "finishes" - this call
    // is a cheap no-op once the button exists, so it's safe to keep polling.
    safe(injectWatchPageEnqueue);
  }

  // ---------- orchestration ----------
  function processMutationBatch(mutations) {
    for (const m of mutations) {
      m.addedNodes.forEach(processAddedNode);
    }
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

  function watchRuntimeMessages() {
    browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message && message.type === 'CONTEXT_ENQUEUE') {
        handleContextEnqueueMessage(message);
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
    fullDocumentItemPass();
    setupObserver();
    watchSettingsChanges();
    watchRuntimeMessages();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
