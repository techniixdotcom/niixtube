'use strict';

const listEl = document.getElementById('queueList');
const emptyMsg = document.getElementById('emptyMsg');

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
  li.append(thumb, meta, controls);
  return li;
}

async function render() {
  const queue = (await send('GET_QUEUE')) || [];
  listEl.innerHTML = '';
  emptyMsg.style.display = queue.length ? 'none' : 'block';
  queue.forEach((item, index) => listEl.appendChild(itemRow(item, index, queue)));
}

document.getElementById('clearQueue').addEventListener('click', async () => {
  await send('CLEAR_QUEUE');
  render();
});

document.getElementById('openOptions').addEventListener('click', () => {
  browser.runtime.openOptionsPage();
});

render();
