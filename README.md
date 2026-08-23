# niixtube

A Chrome + Firefox extension for YouTube:

1. **Subscriptions-only home** — redirects `youtube.com/` to your subscriptions feed, then hard-filters the feed against your actual subscribed-channel list and forces the sort to "Latest" instead of YouTube's algorithmic "Most relevant" default.
2. **Grey out watched videos** — fully watched videos stay visible but are dimmed/desaturated instead of hidden.
3. **Enqueue system** — three ways to queue a video, all landing in the same extension-managed queue:
   - `+ Add to Queue` / `⏭ Play Next` buttons under every watch-page video, and small `+Q` / `⏭Q` buttons on thumbnail hover.
   - Right-click any video thumbnail or title link on YouTube → **Add to niixtube queue** / **Enqueue next (niixtube)**, via the browser's native context menu.
   - Queued videos play automatically, one after another, in the same tab. A video is removed from the queue the moment it finishes playing, wherever it was sitting in the list — not just when it was reached through auto-advance.
4. **Hide Shorts** — removes Shorts shelves, the Shorts sidebar entry, and redirects any `/shorts/...` link to the normal watch page.
5. **Seamless continue watching** — automatically dismisses the "Video paused. Continue watching?" popup.

All five features can be toggled individually from the extension's settings page (right-click the toolbar icon → Options, or the gear icon in the popup).

## Project layout

```
niixtube/
├── build.sh                  # one-command build
├── package.json
├── gen_icons.py               # regenerates icons/ (already generated, optional)
├── src/                       # extension source
│   ├── manifest.json
│   ├── background.js
│   ├── content/
│   │   ├── youtube.js
│   │   └── styles.css
│   ├── popup/
│   │   ├── popup.html
│   │   ├── popup.js
│   │   └── popup.css
│   ├── options/
│   │   ├── options.html
│   │   ├── options.js
│   │   └── options.css
│   └── icons/
│       ├── icon-16.png
│       ├── icon-32.png
│       ├── icon-48.png
│       └── icon-128.png
├── build/
│   ├── chrome/                 # generated — assembled, loadable Chrome extension (gitignored)
│   └── firefox/                 # generated — assembled, loadable Firefox extension (gitignored)
└── dist/                       # generated — final packages (gitignored)
    ├── niixtube-chrome-vX.Y.Z.zip
    └── niixtube-firefox-vX.Y.Z.zip
```

`src/lib/browser-polyfill.js` is intentionally **not** committed — the build script downloads it fresh (at the latest published version) every run and copies it into both `build/chrome/lib/` and `build/firefox/lib/`. Firefox has a native `browser.*` API and doesn't strictly need the polyfill, but it's included there too for consistency and because the content script/popup/options HTML load it unconditionally.

The two builds share **all the same JS/CSS/HTML from `src/`, byte-for-byte** — the code already talks to the extension APIs exclusively through the `browser.*` namespace, so nothing in the application logic differs per browser. Only `manifest.json` is generated differently per target, because Chrome and Firefox disagree on how an MV3 background script is declared:

- **Chrome** requires `background.service_worker`.
- **Firefox does not support `background.service_worker` at all** (it errors with "background.service_worker is currently disabled") — it needs `background.scripts` (a non-persistent background/event page) instead. The Firefox manifest also gets a `browser_specific_settings.gecko.id`, which Firefox needs to keep the add-on's identity stable across updates.

## Building (Arch Linux)

```bash
cd niixtube
./build.sh
```

What it does, in order:

1. **Installs system dependencies** via `pacman` if missing: `nodejs`, `npm`, `zip`, `unzip`, `jq`, `git`. Uses `sudo` automatically if not run as root.
2. **Installs build tooling** at the latest published version: `webextension-polyfill` (cross-browser `browser.*` API shim), via `npm install --no-save webextension-polyfill@latest`.
3. **Validates every source file** before packaging anything:
   - `manifest.json` is parsed with `jq` to catch malformed JSON.
   - Every `.js` file is checked with `node --check` to catch syntax errors.
   - Every `.html` file is checked for unbalanced tags with Python's `html.parser`.
   - The build **stops immediately** if any check fails.
4. **Assembles both `build/chrome/` and `build/firefox/`** from the same `src/`, injecting the polyfill and the version from `package.json` into each (so you only ever bump the version in one place), and rewrites `manifest.json` per target as described above.
5. **Packages** `dist/niixtube-chrome-vX.Y.Z.zip` and `dist/niixtube-firefox-vX.Y.Z.zip` — the Chrome zip is exactly what the Chrome Web Store expects, the Firefox zip is exactly what addons.mozilla.org expects for signing. Either `build/` folder can also be loaded unpacked directly.
6. **Logs everything in real time** to `build.log` in the project root (via `tee`, so it also prints to your terminal as it runs). Run `tail -f build.log` in another terminal to watch a build live. Every log line is timestamped. On failure, the script prints the exact line number and tells you to check `build.log`.

Re-running `./build.sh` is safe at any time — it wipes and rebuilds `build/` and `dist/` from scratch.

## Installing the built extension

### Chrome

Same split as Firefox below — quick local testing vs. a persistent install — because Chrome has the identical restriction: a "Load unpacked" (developer-mode) extension is **never** restart-proof, no matter what's in the manifest.

**Quick testing (dev-mode — nags/disables on every restart)**
1. Go to `chrome://extensions`.
2. Enable **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select the `build/chrome/` folder.
   - Note: Chrome's "Load unpacked" needs an actual unzipped folder with `manifest.json` at its root — it will **not** accept the `.zip` directly. If you only have the zip (e.g. `dist/niixtube-chrome-vX.Y.Z.zip`), extract it first: `unzip niixtube-chrome-vX.Y.Z.zip -d niixtube-chrome-unpacked`, then select that extracted folder.
4. After any rebuild, go back to `chrome://extensions` and click the refresh icon on the niixtube card to pick up the changes — Chrome does not auto-reload unpacked extensions.
5. **Every time you restart Chrome, it will show a "Disable developer mode extensions" prompt** and, depending on how it's dismissed, may disable the extension. This is Chrome's own long-standing security behavior for *any* unpacked extension (in place since ~2016, to stop malware from silently force-installing extensions this way) — it isn't caused by anything in this codebase, and there's no manifest setting that turns it off. Clicking "Keep" each time it appears re-enables it for that session without needing to reload anything.

**Permanent install (survives restarts, no prompt)**
The only way to make a Chrome extension behave like a normally installed one is to install it through the Chrome Web Store — even at the private **"Unlisted"** visibility (reachable only via direct link, not searchable), which is the Chrome equivalent of Firefox's unlisted self-distribution.
1. One-time setup (can't be scripted — these are manual, human steps):
   - Register a Chrome Web Store developer account: one-time **$5 fee**, requires 2-Step Verification on the Google account. [chrome.google.com/webstore/devconsole/register](https://chrome.google.com/webstore/devconsole/register)
   - Create the listing once by hand in the dashboard: upload `dist/niixtube-chrome-vX.Y.Z.zip`, fill in the required fields, set visibility to **Unlisted**. Note the resulting Extension ID.
   - Create OAuth2 credentials for the Chrome Web Store API (a Google Cloud project + refresh token) — Google's guide: [developer.chrome.com/docs/webstore/using-api](https://developer.chrome.com/docs/webstore/using-api). This step is more involved than Firefox's simple API key, since Google only offers an OAuth2 flow here.
2. After that one-time setup, `build.sh` can push subsequent version updates automatically:
   ```bash
   CWS_CLIENT_ID=xxx CWS_CLIENT_SECRET=xxx CWS_REFRESH_TOKEN=xxx \
   CWS_PUBLISHER_ID=xxx CWS_EXTENSION_ID=xxx ./build.sh
   ```
3. Without those five variables set, `build.sh` just skips this step (build still succeeds) and logs a reminder.
4. Once installed from the Chrome Web Store (even Unlisted), Chrome treats it as a normal extension — no developer-mode prompt, and it auto-updates and survives restarts like anything else.

### Firefox

There are two very different install paths on Firefox — pick based on whether you want it to survive a browser restart.

**Quick testing (temporary — gone after every restart)**
1. Go to `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…** and select `build/firefox/manifest.json` (not the folder — Firefox wants the manifest file itself).
3. This is genuinely temporary **by Firefox's own design, not a limitation of this build** — regular Firefox refuses to keep *any* unsigned extension installed once the browser closes, no matter how it was loaded. You'll also need to repeat step 2 after every rebuild, since Firefox doesn't auto-reload it either.

**Permanent install (survives restarts)**
Firefox will only keep an extension installed permanently if Mozilla has cryptographically signed it — even for purely personal, unlisted use. `build.sh` automates that signing:
1. Get a free API key/secret at [addons.mozilla.org/developers/addon/api/key](https://addons.mozilla.org/developers/addon/api/key/) (no public listing or manual review required for unlisted self-distribution — sign-off is usually automatic, within a minute or two).
2. Two ways to give `build.sh` the credentials, in priority order:
   - **`.amo-credentials.env`** in the project root (already present with your key in this copy — `build.sh` auto-loads it on every run, no typing needed): `AMO_JWT_ISSUER="..."` / `AMO_JWT_SECRET="..."`. It's `chmod 600`'d and listed in `.gitignore` so it can't accidentally get committed - don't remove it from `.gitignore`, and don't paste its contents anywhere public.
   - Or explicit environment variables, which override the file if both are present:
     ```bash
     AMO_JWT_ISSUER=your-key AMO_JWT_SECRET=your-secret ./build.sh
     ```
3. Just running `./build.sh` now produces a signed `dist/niixtube-*.xpi` automatically. Install it via `about:addons` → gear icon → **Install Add-on From File…**, or drag the `.xpi` straight into a Firefox window. This one persists across restarts like any normal add-on.
4. If `.amo-credentials.env` is ever deleted and no environment variables are set, `build.sh` just skips signing (build still succeeds) and logs a reminder instead of failing.
5. **Both browsers always share the same version number.** `build.sh` prompts for it at the start of every run: `Version to build [1.2.1]:` — press Enter to keep what's shown, or type a new one. Whatever you choose is written back into `package.json`, so it stays the single source of truth rather than drifting out of sync with what actually got built. For non-interactive/scripted runs, set the `VERSION` environment variable instead (`VERSION=1.2.2 ./build.sh`) and the prompt is skipped entirely; with neither a terminal to prompt at nor `VERSION` set, it silently keeps whatever's already in `package.json`. If you try to sign a version that's already been signed before, AMO rejects it (`409 "already exists"`) and `build.sh` fails immediately with that message rather than guessing a new number for you — just re-run and enter a different version at the prompt. If AMO rate-limits a request instead (`429`), that's a pacing issue rather than a version issue, so `build.sh` *does* handle that one automatically: it waits out the time AMO itself reports before retrying the exact same version, up to 5 attempts.
6. **This key was pasted into a chat to get here** — treat it as lower-trust than one you generated and kept private from the start. Worth rotating (generate a fresh key/secret at the same AMO page and swap the file's contents) once you've confirmed signing works, and definitely before sharing this project folder with anyone else.

`build.sh` assigns a fixed placeholder add-on ID (`browser_specific_settings.gecko.id` in the generated manifest) so updates keep the same identity across builds/signings. If you intend to publish or sign this yourself long-term, swap that ID in `build.sh` for one you control (any unique string in `name@domain` or UUID form works — it doesn't need to resolve to anything, it just needs to stay the same across versions).

**Alternative if you'd rather not create an AMO account:** [Firefox Developer Edition](https://www.mozilla.org/firefox/developer/) or Nightly can have signature enforcement disabled entirely (set `xpinstall.signatures.required` to `false` on `about:config`), after which the *unsigned* `.xpi` can be installed permanently via `about:addons` → **Install Add-on From File…**, same as the signed path above. This only works on those two channels — regular release/ESR Firefox does not allow disabling that setting.

## Settings

Open the popup (toolbar icon) and click the gear, or go directly to the extension's Options page, to toggle:

- Subscriptions-only home
- Grey out watched videos (and the watched-percentage threshold)
- Hide Shorts
- Enqueue & auto-play-next
- Seamless continue-watching

## How the queue works

- **Watch page:** below the video, `+ Add to Queue` adds it to the end of the queue; `⏭ Play Next` inserts it at the front.
- **Thumbnails (grid/list views):** hover any thumbnail to reveal small `+Q` / `⏭Q` buttons.
- **Right-click anywhere on YouTube:** right-click a thumbnail or a video title link to get **Add to niixtube queue** and **Enqueue next (niixtube)** in the browser's native context menu — this works even for thumbnails the hover buttons haven't rendered on yet.
- **Popup (toolbar icon):** see the full queue with thumbnails, reorder with ↑/↓, jump to a video immediately with ▶, remove with ✕, or clear the whole queue.
- When the currently playing video ends, it is removed from the queue (wherever it happens to be sitting — not just position 0), and the extension automatically navigates the same tab to the new front-of-queue video. No extra tabs required.

## Known limitations (honest disclosure)

- Features 1, 2, and 4 rely on YouTube's current DOM structure and internal element/attribute names (e.g. `ytd-rich-item-renderer`, `#progress`). YouTube changes this fairly often; if a feature silently stops working after a YouTube redesign, the selectors in `src/content/youtube.js` / `src/content/styles.css` are the first place to check and update — this is an inherent tradeoff of any extension that works without a paid, quota-limited YouTube Data API key.
- The subscribed-channel allowlist is built by fetching `youtube.com/feed/channels` from your own logged-in session and parsing the channel IDs out of it. It's cached for an hour to avoid repeated fetches. If that page's internal structure changes, the extension falls back to trusting YouTube's own subscriptions feed rather than hiding videos it can't classify.
- "Force sort to Latest" on the subscriptions page works by finding and clicking YouTube's own "Most relevant" sort control — if YouTube renames or restructures that control, this step silently no-ops rather than breaking anything else (each feature runs in its own try/catch).
- The native right-click context menu items are the most reliable way to enqueue a video, unaffected by YouTube's own DOM quirks, since they use the browser's own `contextMenus` API rather than scraping. They appear only when you right-click an actual link to a video (a thumbnail or its title) on a youtube.com page.
- No YouTube account credentials, API keys, or personal data ever leave your browser. Everything (settings, queue, cached subscription list) is stored locally via `browser.storage.local`.

## Updating dependencies

The build always pulls `webextension-polyfill` at `@latest` — there is nothing to manually bump. To release a new version of niixtube itself, just answer the version prompt at the start of `./build.sh` (or set `VERSION=x.y.z` for a non-interactive run) — it updates `package.json` for you.
