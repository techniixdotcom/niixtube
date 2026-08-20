'use strict';

const DEFAULT_SETTINGS = {
  subscriptionsOnlyHome: true,
  greyOutWatched: true,
  watchedBadge: true,
  hideShorts: true,
  autoContinueWatching: true,
  enqueueEnabled: true,
  watchedThreshold: 95
};

const CHECKBOX_FIELDS = [
  'subscriptionsOnlyHome',
  'greyOutWatched',
  'watchedBadge',
  'hideShorts',
  'autoContinueWatching',
  'enqueueEnabled'
];

const form = document.getElementById('settingsForm');
const savedMsg = document.getElementById('savedMsg');
let saveTimer = null;

async function load() {
  const stored = await browser.storage.local.get('settings');
  const settings = { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
  CHECKBOX_FIELDS.forEach((id) => {
    document.getElementById(id).checked = !!settings[id];
  });
  document.getElementById('watchedThreshold').value = settings.watchedThreshold;
}

function clampThreshold(value) {
  const n = Number(value);
  if (Number.isNaN(n)) return DEFAULT_SETTINGS.watchedThreshold;
  return Math.min(100, Math.max(50, Math.round(n)));
}

async function save() {
  const settings = {
    watchedThreshold: clampThreshold(document.getElementById('watchedThreshold').value)
  };
  CHECKBOX_FIELDS.forEach((id) => {
    settings[id] = form.elements[id].checked;
  });
  await browser.storage.local.set({ settings });

  savedMsg.classList.add('visible');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => savedMsg.classList.remove('visible'), 1200);
}

form.addEventListener('change', save);
load();
