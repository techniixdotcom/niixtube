'use strict';

const listEl = document.getElementById('queueList');
const emptyMsg = document.getElementById('emptyMsg');
// Guards the URL built in playNow() below - defense in depth in case a
// malformed entry ever ends up in stored queue data.
const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{6,15}$/;

async function send(type, payload) {
  return browser.runtime.sendMessage({ type, ...(payload || {}) });
}

async function moveItem(queue, index, delta) {
  const target = index + delta;
  if (target < 0 || target >= queue.length) return;
  const copy = queue.slice();
  const [moved] = copy.splice(index, 1);
  copy.splice(target, 0, moved);
  await send('REORDER_QUEUE', { queue: copy });
  render();
}

async function removeItem(videoId) {
  await send('REMOVE_FROM_QUEUE', { videoId });
  render();
}

async function playNow(item, queue) {
  if (!item || !VIDEO_ID_PATTERN.test(item.videoId || '')) return;
  const filtered = queue.filter((entry) => entry.videoId !== item.videoId);
  await send('REORDER_QUEUE', { queue: filtered });
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  if (tabs && tabs[0]) {
    await browser.tabs.update(tabs[0].id, { url: `https://www.youtube.com/watch?v=${item.videoId}` });
  }
  window.close();
}

function itemRow(item, index, queue) {
  const li = document.createElement('li');
  li.className = 'queue-item';
  li.dataset.videoId = item.videoId;

  const handle = document.createElement('button');
  handle.type = 'button';
  handle.className = 'queue-drag-handle';
  handle.title = 'Drag to reorder';
  handle.setAttribute('aria-label', 'Drag to reorder');
  handle.textContent = '\u22ee\u22ee'; // vertical dots, grip-style affordance

  const thumb = document.createElement('img');
  thumb.className = 'queue-thumb';
  thumb.src = item.thumbnail || '';
  thumb.alt = '';

  const meta = document.createElement('div');
  meta.className = 'queue-meta';

  const title = document.createElement('div');
  title.className = 'queue-title';
  title.textContent = item.title || 'Untitled video';

  const channel = document.createElement('div');
  channel.className = 'queue-channel';
  channel.textContent = item.channel || '';

  meta.appendChild(title);
  meta.appendChild(channel);

  const controls = document.createElement('div');
  controls.className = 'queue-controls';

  const upBtn = document.createElement('button');
  upBtn.textContent = '\u2191';
  upBtn.title = 'Move up';
  upBtn.disabled = index === 0;
  upBtn.addEventListener('click', () => moveItem(queue, index, -1));

  const downBtn = document.createElement('button');
  downBtn.textContent = '\u2193';
  downBtn.title = 'Move down';
  downBtn.disabled = index === queue.length - 1;
  downBtn.addEventListener('click', () => moveItem(queue, index, 1));

  const playBtn = document.createElement('button');
  playBtn.textContent = '\u25B6';
  playBtn.title = 'Play now';
  playBtn.addEventListener('click', () => playNow(item, queue));

  const removeBtn = document.createElement('button');
  removeBtn.textContent = '\u2715';
  removeBtn.title = 'Remove';
  removeBtn.addEventListener('click', () => removeItem(item.videoId));

  controls.append(upBtn, downBtn, playBtn, removeBtn);
  li.append(handle, thumb, meta, controls);
  attachDragHandlers(li);
  return li;
}

// ---------- Drag-to-reorder ----------
//
// Uses Pointer Events with manual DOM reordering rather than the native
// HTML5 Drag and Drop API - the native API has known rough edges inside
// small extension popup windows (drag-image rendering, and some browser
// versions closing the popup mid-drag if the pointer nears the window
// edge), whereas a plain pointerdown/pointermove/pointerup implementation
// behaves identically to any other popup interaction and needs no special
// handling for the popup context at all.
//
// Tracking is done with listeners on `document`, not with
// setPointerCapture() on the handle itself. That matters here specifically
// because onDragMove() below repositions the dragged <li> (which contains
// the handle) via insertBefore() *while the drag is in progress* - moving
// a pointer-capturing element within the DOM mid-capture isn't reliably
// honored across browsers, and losing capture after the first move is
// exactly what made dragging only ever manage one position at a time
// (each further pointermove went nowhere until the pointer was released
// and a fresh press re-established capture). document itself never moves,
// so listening there has no equivalent failure mode.
let dragState = null; // { li, pointerId } | null

function attachDragHandlers(li) {
  li.addEventListener('pointerdown', (event) => {
    if (event.button !== undefined && event.button !== 0) return; // left button / primary touch only
    // The up/down/play/remove buttons live inside the same row - a press
    // starting on one of them is a click on that control, not a drag.
    // Everything else on the row (thumbnail, title, channel text, the
    // drag-handle icon, or just blank space) starts a drag, so the target
    // for "grab and reorder" isn't limited to one small icon anymore.
    if (event.target.closest('.queue-controls')) return;
    event.preventDefault();
    dragState = { li, pointerId: event.pointerId };
    li.classList.add('dragging');
    document.addEventListener('pointermove', onDragMove);
    document.addEventListener('pointerup', onDragEnd);
    document.addEventListener('pointercancel', onDragEnd);
  });
}

function onDragMove(event) {
  if (!dragState || event.pointerId !== dragState.pointerId) return;
  const { li } = dragState;
  const y = event.clientY;
  // Single pass, O(n): find the first sibling (other than the dragged row)
  // whose vertical midpoint is below the cursor - that's exactly where the
  // dragged row belongs, right before it. Falls through to "belongs at the
  // end" if the cursor is below every sibling. This replaces an earlier
  // version that compared the dragged row against every sibling AND
  // recomputed Array.from(listEl.children).indexOf(...) twice per
  // comparison - an O(n^2) reconstruction-heavy approach doing far more
  // work than the problem needs, on every single pointermove event during
  // an active drag.
  const children = Array.from(listEl.children);
  let target = null;
  for (const child of children) {
    if (child === li) continue;
    const rect = child.getBoundingClientRect();
    if (y < rect.top + rect.height / 2) {
      target = child;
      break;
    }
  }
  // Only touch the DOM when the position actually needs to change - avoids
  // firing an unnecessary reflow/repaint on every pointermove while the
  // cursor is merely holding still or moving within the same gap.
  if (target) {
    if (target.previousElementSibling !== li) listEl.insertBefore(li, target);
  } else if (listEl.lastElementChild !== li) {
    listEl.appendChild(li);
  }
}

async function onDragEnd(event) {
  if (!dragState || event.pointerId !== dragState.pointerId) return;
  const { li } = dragState;
  document.removeEventListener('pointermove', onDragMove);
  document.removeEventListener('pointerup', onDragEnd);
  document.removeEventListener('pointercancel', onDragEnd);
  li.classList.remove('dragging');
  dragState = null;

  // Reconstruct the final order from the DOM (already live-reordered by
  // onDragMove above) and persist it, same as the up/down arrows do.
  const orderedIds = Array.from(listEl.children).map((el) => el.dataset.videoId);
  const queue = (await send('GET_QUEUE')) || [];
  const byId = new Map(queue.map((item) => [item.videoId, item]));
  const reordered = orderedIds.map((id) => byId.get(id)).filter(Boolean);
  // Anything not represented in the DOM order (shouldn't normally happen)
  // is appended at the end rather than silently dropped.
  for (const item of queue) {
    if (!orderedIds.includes(item.videoId)) reordered.push(item);
  }
  await send('REORDER_QUEUE', { queue: reordered });
  render();
}

/** Formats total queued seconds as e.g. "1h 24m" or "38m" - never shows
 *  seconds alone, since at queue-list scale that level of precision isn't
 *  meaningful. Returns null when nothing in the queue has a known duration
 *  (nothing to show at all, rather than a misleading "0m"). */
function formatTotalDuration(queue) {
  const known = queue.filter((item) => typeof item.durationSeconds === 'number' && item.durationSeconds > 0);
  if (!known.length) return null;
  const totalSeconds = known.reduce((sum, item) => sum + item.durationSeconds, 0);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.round((totalSeconds % 3600) / 60);
  let label = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
  if (known.length < queue.length) label += ' (partial)'; // some items' durations couldn't be read - said plainly rather than silently undercounting
  return label;
}

async function render() {
  const queue = (await send('GET_QUEUE')) || [];
  listEl.innerHTML = '';
  emptyMsg.style.display = queue.length ? 'none' : 'block';
  queue.forEach((item, index) => listEl.appendChild(itemRow(item, index, queue)));

  const totalTimeEl = document.getElementById('queueTotalTime');
  if (totalTimeEl) {
    const label = queue.length ? formatTotalDuration(queue) : null;
    totalTimeEl.textContent = label || '';
  }
}

document.getElementById('clearQueue').addEventListener('click', async () => {
  await send('CLEAR_QUEUE');
  render();
});

document.getElementById('openOptions').addEventListener('click', () => {
  browser.runtime.openOptionsPage();
});

const versionLabel = document.getElementById('versionLabel');
if (versionLabel) {
  // Read directly from the installed manifest rather than any hardcoded
  // string, so this can never itself drift out of sync with what's
  // actually running.
  versionLabel.textContent = `v${browser.runtime.getManifest().version}`;
}

render();
