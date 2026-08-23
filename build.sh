#!/usr/bin/env bash
#
# niixtube build script (Chrome + Firefox)
# Builds unpacked extension folders and store-ready .zips for both Chrome
# and Firefox from ./src into ./build/{chrome,firefox} and ./dist,
# installing and configuring every dependency it needs along the way.
# Supports Arch (pacman), Debian/Ubuntu (apt), Fedora (dnf), and macOS
# (brew) automatically; on anything else it skips package installation and
# just tells you what to install by hand.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="$ROOT_DIR/src"
BUILD_DIR="$ROOT_DIR/build/chrome"
DIST_DIR="$ROOT_DIR/dist"
LOG_FILE="$ROOT_DIR/build.log"

# ---------------------------------------------------------------------------
# Logging: everything printed to stdout/stderr from this point on is also
# streamed in real time into build.log (via `tee`), so `tail -f build.log`
# in another terminal shows progress live and gives a permanent record for
# debugging failures.
# ---------------------------------------------------------------------------
: > "$LOG_FILE"
exec > >(tee -a "$LOG_FILE") 2> >(tee -a "$LOG_FILE" >&2)

ts() { date '+%Y-%m-%d %H:%M:%S'; }
log()  { echo "[$(ts)] [INFO]  $*"; }
warn() { echo "[$(ts)] [WARN]  $*"; }
err()  { echo "[$(ts)] [ERROR] $*" >&2; }

on_error() {
  local exit_code=$?
  local line_no=$1
  err "Build failed (exit $exit_code) at line $line_no. See $LOG_FILE for the full log."
  exit "$exit_code"
}
trap 'on_error $LINENO' ERR

# ---------------------------------------------------------------------------
# Local signing/publishing credentials (optional, never committed)
#
# If present, these files are sourced automatically so `./build.sh` alone
# signs/publishes without retyping secrets - explicit environment variables
# still take priority if you set them on the command line instead.
# Real secrets belong ONLY in these two files, never inline in this script -
# both are listed in .gitignore specifically so they can't end up committed.
#   .amo-credentials.env  -> AMO_JWT_ISSUER / AMO_JWT_SECRET   (Firefox)
#   .cws-credentials.env  -> CWS_CLIENT_ID / CWS_CLIENT_SECRET /
#                            CWS_REFRESH_TOKEN / CWS_PUBLISHER_ID /
#                            CWS_EXTENSION_ID                  (Chrome)
# ---------------------------------------------------------------------------
if [ -z "${AMO_JWT_ISSUER:-}" ] && [ -f "$ROOT_DIR/.amo-credentials.env" ]; then
  # shellcheck disable=SC1091
  source "$ROOT_DIR/.amo-credentials.env"
fi
if [ -z "${CWS_CLIENT_ID:-}" ] && [ -f "$ROOT_DIR/.cws-credentials.env" ]; then
  # shellcheck disable=SC1091
  source "$ROOT_DIR/.cws-credentials.env"
fi

log "niixtube build starting (Chrome + Firefox)"
log "Root: $ROOT_DIR"

# ---------------------------------------------------------------------------
# 1. System dependencies
#
# Detection is done by checking for the actual command each tool provides
# (node, npm, zip, unzip, jq, git), not by querying package-manager metadata
# - a tool can be present via a method the package manager doesn't know
# about (nvm, a vendor installer, etc.), and checking the binary directly
# avoids both false "missing" positives and needless reinstall attempts.
# ---------------------------------------------------------------------------
# tool:package-name-for-pacman:package-name-for-apt/dnf:package-name-for-brew
REQUIRED_TOOLS=(
  "node:nodejs:nodejs:node"
  "npm:npm:npm:node"
  "zip:zip:zip:zip"
  "unzip:unzip:unzip:unzip"
  "jq:jq:jq:jq"
  "git:git:git:git"
)

missing_packages_for() {
  # $1 = field index (2=pacman, 3=apt/dnf, 4=brew)
  local field="$1"
  local missing=()
  for entry in "${REQUIRED_TOOLS[@]}"; do
    IFS=':' read -r tool pkg_pacman pkg_aptdnf pkg_brew <<< "$entry"
    command -v "$tool" >/dev/null 2>&1 && continue
    case "$field" in
      2) missing+=("$pkg_pacman") ;;
      3) missing+=("$pkg_aptdnf") ;;
      4) missing+=("$pkg_brew") ;;
    esac
  done
  # De-duplicate (npm and node share a package on some managers). Guarded on
  # a non-empty array: `printf '%s\n' "${missing[@]}"` with a truly empty
  # array still prints ONE blank line in bash (printf runs its format once
  # even with zero operands), which `mapfile` would then read back as a
  # single empty-string "missing package" - that's what produced
  # `pacman ... --needed --noconfirm ""` and its "target not found: " error
  # even when nothing was actually missing.
  if [ "${#missing[@]}" -gt 0 ]; then
    printf '%s\n' "${missing[@]}" | awk '!seen[$0]++'
  fi
}

install_system_deps() {
  if command -v pacman >/dev/null 2>&1; then
    local missing
    mapfile -t missing < <(missing_packages_for 2)
    if [ "${#missing[@]}" -eq 0 ]; then
      log "All required tools already available (node npm zip unzip jq git)."
      return
    fi
    log "Installing missing system packages (pacman): ${missing[*]}"
    # -Syu (not -Sy) is required here: -Sy alone syncs the package database
    # against current repos but leaves already-installed packages (like
    # glibc) at their old version. Installing a brand-new package built
    # against a newer glibc than what's on disk is exactly the "partial
    # upgrade" Arch's own documentation warns against, and it fails at
    # runtime with errors like "GLIBC_2.xx not found". -Syu keeps the whole
    # system consistent before adding anything new.
    if [ "$(id -u)" -eq 0 ]; then
      pacman -Syu --needed --noconfirm "${missing[@]}"
    else
      sudo pacman -Syu --needed --noconfirm "${missing[@]}"
    fi
    return
  fi

  if command -v apt-get >/dev/null 2>&1; then
    local missing
    mapfile -t missing < <(missing_packages_for 3)
    if [ "${#missing[@]}" -eq 0 ]; then
      log "All required tools already available (node npm zip unzip jq git)."
      return
    fi
    log "Installing missing system packages (apt): ${missing[*]}"
    local sudo_cmd=""
    [ "$(id -u)" -eq 0 ] || sudo_cmd="sudo"
    # Non-fatal: a single broken/unrelated third-party repo in the user's
    # sources list (common with things like vendor Node.js repos) shouldn't
    # abort the whole build if the actual packages we need are available
    # from the repos that did succeed. `apt-get install` below will still
    # fail loudly and specifically if a package genuinely can't be found.
    $sudo_cmd apt-get update -y || warn "apt-get update reported errors (likely an unrelated repo) - continuing anyway."
    $sudo_cmd apt-get install -y "${missing[@]}"
    return
  fi

  if command -v dnf >/dev/null 2>&1; then
    local missing
    mapfile -t missing < <(missing_packages_for 3)
    if [ "${#missing[@]}" -eq 0 ]; then
      log "All required tools already available (node npm zip unzip jq git)."
      return
    fi
    log "Installing missing system packages (dnf): ${missing[*]}"
    local sudo_cmd=""
    [ "$(id -u)" -eq 0 ] || sudo_cmd="sudo"
    $sudo_cmd dnf install -y "${missing[@]}"
    return
  fi

  if command -v brew >/dev/null 2>&1; then
    local missing
    mapfile -t missing < <(missing_packages_for 4)
    if [ "${#missing[@]}" -eq 0 ]; then
      log "All required tools already available (node npm zip unzip jq git)."
      return
    fi
    log "Installing missing system packages (brew): ${missing[*]}"
    brew install "${missing[@]}"
    return
  fi

  warn "No supported package manager found (pacman/apt-get/dnf/brew) — skipping automatic system package installation."
  warn "Ensure these are installed manually: node npm zip unzip jq git"
}

install_system_deps

for cmd in node npm zip jq; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    err "Required command '$cmd' is still not available after dependency installation."
    exit 1
  fi
done

# A command being on PATH isn't the same as it actually running (e.g. a
# glibc/library mismatch fails at execution, not at lookup). Command
# substitutions like "$(node --version)" don't trigger `set -e` on their
# own when used as part of a larger command, so check explicitly here
# rather than letting that failure silently produce a blank value.
if ! node --version >/dev/null 2>&1; then
  err "'node' is on PATH but fails to run. This usually means a system library"
  err "(commonly glibc) is out of sync with the installed Node.js build."
  err "Try: sudo pacman -Syu   (a full system upgrade, not just 'pacman -S <pkg>')"
  exit 1
fi
if ! npm --version >/dev/null 2>&1; then
  err "'npm' is on PATH but fails to run."
  exit 1
fi

log "Node.js: $(node --version), npm: $(npm --version)"

# ---------------------------------------------------------------------------
# 2. Node/npm build tooling (always pulled at latest, per project policy)
# ---------------------------------------------------------------------------
cd "$ROOT_DIR"

if [ ! -f package.json ]; then
  err "package.json missing at $ROOT_DIR"
  exit 1
fi

log "Installing/updating build tooling (webextension-polyfill) at latest version..."
npm install --no-save --no-fund --no-audit webextension-polyfill@latest

POLYFILL_SRC="$ROOT_DIR/node_modules/webextension-polyfill/dist/browser-polyfill.min.js"
if [ ! -f "$POLYFILL_SRC" ]; then
  err "webextension-polyfill did not install correctly (expected at $POLYFILL_SRC)"
  exit 1
fi

# ---------------------------------------------------------------------------
# 3. Pre-flight validation: catch syntax errors before packaging anything
# ---------------------------------------------------------------------------
log "Validating manifest.json..."
if ! jq empty "$SRC_DIR/manifest.json" >/dev/null 2>>"$LOG_FILE"; then
  err "Invalid JSON in $SRC_DIR/manifest.json"
  exit 1
fi
log "  OK: manifest.json"

log "Validating JavaScript syntax..."
while IFS= read -r -d '' jsfile; do
  if ! node --check "$jsfile" >>"$LOG_FILE" 2>&1; then
    err "Syntax error in $jsfile (see $LOG_FILE)"
    exit 1
  fi
  log "  OK: ${jsfile#"$SRC_DIR"/}"
done < <(find "$SRC_DIR" -name '*.js' -type f -print0)

log "Validating HTML files are well-formed (basic tag balance check)..."
while IFS= read -r -d '' htmlfile; do
  python3 - "$htmlfile" <<'PYEOF' 2>>"$LOG_FILE"
import sys
from html.parser import HTMLParser

path = sys.argv[1]
VOID = {"area","base","br","col","embed","hr","img","input","link","meta","param","source","track","wbr"}

class Checker(HTMLParser):
    def __init__(self):
        super().__init__()
        self.stack = []
    def handle_starttag(self, tag, attrs):
        if tag not in VOID:
            self.stack.append(tag)
    def handle_endtag(self, tag):
        if self.stack and self.stack[-1] == tag:
            self.stack.pop()

with open(path, encoding="utf-8") as f:
    data = f.read()

c = Checker()
c.feed(data)
if c.stack:
    print(f"Unclosed tags in {path}: {c.stack}", file=sys.stderr)
    sys.exit(1)
PYEOF
  log "  OK: ${htmlfile#"$SRC_DIR"/}"
done < <(find "$SRC_DIR" -name '*.html' -type f -print0)

log "All validation checks passed."

# ---------------------------------------------------------------------------
# 4. Choose the version - interactively at the prompt, non-interactively via
#    the VERSION environment variable, or just press Enter / run
#    non-interactively to keep whatever's currently in package.json.
#
# Both Chrome and Firefox always end up using exactly the same number -
# whichever one you pick here gets written back into package.json too, so
# it stays the single source of truth for next time rather than drifting
# out of sync with what actually got built.
#
# Note on the TTY check below: this script's stdout/stderr are redirected
# through `tee` (see the top of this file) so the build log captures
# everything, which means the usual `[ -t 1 ]` (stdout) check would
# incorrectly read as "non-interactive" even in a real terminal session -
# stdin isn't touched by that redirection, so `[ -t 0 ]` is what actually
# reflects whether someone can type a response here.
#
# The trade-off with choosing your own version: AMO rejects re-signing a
# version it's already seen (409 "Version X already exists"). If that
# happens, sign_firefox_build() below fails with a clear message rather
# than silently guessing a new number on your behalf - just re-run and
# enter a different version at this prompt.
# ---------------------------------------------------------------------------
CURRENT_VERSION="$(node -p "require('$ROOT_DIR/package.json').version")"

if [ -n "${VERSION:-}" ]; then
  log "Using version from \$VERSION environment variable: $VERSION"
elif [ -t 0 ]; then
  read -r -p "Version to build [$CURRENT_VERSION]: " VERSION_INPUT
  VERSION="${VERSION_INPUT:-$CURRENT_VERSION}"
else
  VERSION="$CURRENT_VERSION"
fi

# 1-4 dot-separated non-negative integers - what both Chrome's and
# Firefox's manifests actually require; anything else fails validation on
# whichever browser catches it first, further into the build.
if ! [[ "$VERSION" =~ ^[0-9]+(\.[0-9]+){0,3}$ ]]; then
  err "Invalid version '$VERSION' - must be 1 to 4 dot-separated non-negative integers (e.g. 1.2.1 or 1.2.1.4)."
  exit 1
fi

if [ "$VERSION" != "$CURRENT_VERSION" ]; then
  log "Updating package.json version: $CURRENT_VERSION -> $VERSION"
  node -e "
    const fs = require('fs');
    const path = '$ROOT_DIR/package.json';
    const pkg = JSON.parse(fs.readFileSync(path, 'utf8'));
    pkg.version = '$VERSION';
    fs.writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n');
  "
fi

log "Building niixtube v$VERSION"

# ---------------------------------------------------------------------------
# 5. Assemble a target build directory + manifest
#
# Both browsers ship the exact same JS/CSS/HTML unmodified - the code base
# already talks to the extension APIs exclusively through the `browser.*`
# namespace (via the polyfill on Chrome, natively on Firefox), so the only
# thing that differs per target is manifest.json:
#   - Chrome (MV3) requires background.service_worker.
#   - Firefox (MV3) does not support background.service_worker at all
#     ("background.service_worker is currently disabled" - it requires
#     background.scripts, i.e. a non-persistent background/event page) and
#     additionally needs a browser_specific_settings.gecko.id to keep the
#     add-on's ID stable across updates when self-distributed or signed.
# ---------------------------------------------------------------------------
FIREFOX_BUILD_DIR="$ROOT_DIR/build/firefox"
FIREFOX_GECKO_ID="niixtube@dfc36751-e3ec-4d47-9b37-a913006730b9.local"
FIREFOX_MIN_VERSION="109.0"

assemble_build_dir() {
  local target_dir="$1"
  rm -rf "$target_dir"
  mkdir -p "$target_dir"
  if command -v rsync >/dev/null 2>&1; then
    rsync -a "$SRC_DIR/" "$target_dir/"
  else
    cp -r "$SRC_DIR/." "$target_dir/"
  fi
  mkdir -p "$target_dir/lib"
  cp "$POLYFILL_SRC" "$target_dir/lib/browser-polyfill.js"
}

rm -rf "$ROOT_DIR/build" "$DIST_DIR"
mkdir -p "$DIST_DIR"

# --- Chrome -----------------------------------------------------------------
log "Assembling $BUILD_DIR"
assemble_build_dir "$BUILD_DIR"

jq --arg v "$VERSION" '.version = $v' "$SRC_DIR/manifest.json" > "$BUILD_DIR/manifest.json.tmp"
mv "$BUILD_DIR/manifest.json.tmp" "$BUILD_DIR/manifest.json"
jq empty "$BUILD_DIR/manifest.json" >/dev/null

# --- Firefox ------------------------------------------------------------
log "Assembling $FIREFOX_BUILD_DIR"
assemble_build_dir "$FIREFOX_BUILD_DIR"

jq \
  --arg v "$VERSION" \
  --arg geckoId "$FIREFOX_GECKO_ID" \
  --arg minVer "$FIREFOX_MIN_VERSION" \
  '
  .version = $v
  | del(.background.service_worker)
  | .background.scripts = ["background.js"]
  | del(.minimum_chrome_version)
  | .browser_specific_settings.gecko.id = $geckoId
  | .browser_specific_settings.gecko.strict_min_version = $minVer
  # Required as of Nov 2025 for all new Firefox extensions (Mozilla will
  # extend this to all extensions, new and existing, in H1 2026) - niixtube
  # doesn'\''t collect or transmit any personal data: everything it stores
  # stays in browser.storage.local, and its only network call (the oEmbed
  # title lookup) goes to youtube.com itself, not a third party, so this
  # declares "none" rather than any of the specific data-type categories.
  # https://mzl.la/firefox-builtin-data-consent
  | .browser_specific_settings.gecko.data_collection_permissions = { "required": ["none"] }
  ' \
  "$SRC_DIR/manifest.json" > "$FIREFOX_BUILD_DIR/manifest.json.tmp"
mv "$FIREFOX_BUILD_DIR/manifest.json.tmp" "$FIREFOX_BUILD_DIR/manifest.json"
jq empty "$FIREFOX_BUILD_DIR/manifest.json" >/dev/null

# ---------------------------------------------------------------------------
# 6. Package each target as a .zip
#    - Chrome: upload as-is to the Chrome Web Store, or load unpacked from
#      build/chrome for local testing.
#    - Firefox: upload as-is to addons.mozilla.org for signing, or load
#      temporarily via about:debugging -> This Firefox -> Load Temporary
#      Add-on -> select build/firefox/manifest.json for local testing.
# ---------------------------------------------------------------------------
CHROME_ZIP="$DIST_DIR/niixtube-chrome-v$VERSION.zip"
log "Packaging Chrome build -> $CHROME_ZIP"
(
  cd "$BUILD_DIR"
  zip -r -q -X "$CHROME_ZIP" . -x '*.DS_Store'
)
log "Chrome package size: $(du -h "$CHROME_ZIP" | cut -f1)"

FIREFOX_ZIP="$DIST_DIR/niixtube-firefox-v$VERSION.zip"
log "Packaging Firefox build -> $FIREFOX_ZIP"
(
  cd "$FIREFOX_BUILD_DIR"
  zip -r -q -X "$FIREFOX_ZIP" . -x '*.DS_Store'
)
log "Firefox package size: $(du -h "$FIREFOX_ZIP" | cut -f1)"

# ---------------------------------------------------------------------------
# 7. Optional: sign the Firefox build with Mozilla so it survives restarts
#
# A Firefox extension loaded via "Load Temporary Add-on" is wiped every time
# Firefox closes - that's Firefox's own design, not something this build
# controls. Regular (release) Firefox will only keep an extension installed
# permanently if it's been cryptographically signed by Mozilla, even for
# purely personal/unlisted use.
#
# This step automates that signing via Mozilla's own `web-ext` CLI, using
# free API credentials (no review or public listing required for unlisted
# self-distribution, and it's typically signed within a minute or two):
#   1. Get a key/secret pair at https://addons.mozilla.org/developers/addon/api/key/
#   2. Re-run this script as:
#        AMO_JWT_ISSUER=xxx AMO_JWT_SECRET=xxx ./build.sh
# Skipped automatically (with instructions printed) if those aren't set.
#
# On a version conflict (409 "already exists"), this fails immediately with
# a clear message instead of guessing a new version - you chose the version
# in package.json, so this script doesn't override that choice. Bump it
# yourself and re-run when that happens.
#
# On a rate limit (429, e.g. "Request was throttled. Expected available in
# N seconds") this DOES retry automatically, waiting the time AMO itself
# reports before trying again - that's a pacing problem, not a version
# problem, and retrying the exact same version is correct and safe there.
# ---------------------------------------------------------------------------
sign_firefox_build() {
  local max_attempts=5
  local attempt=1
  local sign_output
  local status
  local wait_seconds

  while [ "$attempt" -le "$max_attempts" ]; do
    if [ "$attempt" -eq 1 ]; then
      log "AMO credentials found — signing Firefox build v$VERSION for a permanent, restart-proof install..."
    else
      log "Retrying signing of v$VERSION after the rate limit (attempt $attempt/$max_attempts)..."
    fi

    set +e
    sign_output="$(cd "$FIREFOX_BUILD_DIR" && npx --yes web-ext sign \
      --api-key="$AMO_JWT_ISSUER" \
      --api-secret="$AMO_JWT_SECRET" \
      --channel=unlisted \
      --artifacts-dir="$DIST_DIR" 2>&1)"
    status=$?
    set -e
    echo "$sign_output"

    if [ "$status" -eq 0 ]; then
      SIGNED_XPI="$(find "$DIST_DIR" -maxdepth 1 -name '*.xpi' 2>/dev/null | sort | tail -n1)"
      if [ -n "$SIGNED_XPI" ]; then
        log "Signed Firefox package ready: $SIGNED_XPI"
        log "Install via about:addons -> gear icon -> Install Add-on From File. This one survives restarts."
      else
        warn "web-ext sign reported success but no .xpi was found in $DIST_DIR — check the output above."
      fi
      return 0
    fi

    if echo "$sign_output" | grep -qi "already exists"; then
      warn "Version $VERSION was already signed previously — AMO won't accept it again."
      warn "Bump the version in package.json yourself and re-run ./build.sh — both Chrome and Firefox will then use that new number."
      warn "The unsigned $FIREFOX_ZIP is still available for temporary testing via about:debugging."
      return 1
    fi

    if echo "$sign_output" | grep -qi "throttled\|rate limit\|429"; then
      # Parse "Expected available in N seconds" if present; otherwise fall
      # back to a conservative default rather than hammering AMO again
      # immediately, which is exactly what produced this in the first place.
      wait_seconds="$(echo "$sign_output" | grep -oE 'available in [0-9]+' | grep -oE '[0-9]+' | head -n1)"
      [ -n "$wait_seconds" ] || wait_seconds=30
      wait_seconds=$((wait_seconds + 5)) # small safety margin
      warn "AMO rate-limited this request — waiting ${wait_seconds}s before retrying (same version, no change needed)..."
      sleep "$wait_seconds"
      attempt=$((attempt + 1))
      continue
    fi

    warn "Firefox signing failed (see the web-ext output above, or check your network/credentials)."
    warn "The unsigned $FIREFOX_ZIP is still available for temporary testing via about:debugging."
    return 1
  done

  warn "Still rate-limited after $max_attempts attempts — try again in a few minutes."
  warn "The unsigned $FIREFOX_ZIP is still available for temporary testing via about:debugging."
  return 1
}

if [ -n "${AMO_JWT_ISSUER:-}" ] && [ -n "${AMO_JWT_SECRET:-}" ]; then
  if npm install --no-save --no-fund --no-audit web-ext@latest >/dev/null 2>&1; then
    sign_firefox_build || true
  else
    warn "Could not install web-ext — skipping Firefox signing."
    warn "The unsigned $FIREFOX_ZIP is still available for temporary testing via about:debugging."
  fi
else
  log "No AMO credentials set (AMO_JWT_ISSUER / AMO_JWT_SECRET) — skipping Firefox signing."
  log "Without signing, Firefox only allows a TEMPORARY install (about:debugging), removed on every restart."
  log "For a permanent install, get free credentials at https://addons.mozilla.org/developers/addon/api/key/"
  log "and re-run: AMO_JWT_ISSUER=xxx AMO_JWT_SECRET=xxx ./build.sh"
fi

# ---------------------------------------------------------------------------
# 8. Optional: push the Chrome build to the Chrome Web Store so it survives
#    restarts and doesn't trigger the "Disable developer mode extensions"
#    prompt
#
# Chrome shows that prompt on every single restart for ANY extension loaded
# via "Load unpacked" - this is intentional Chrome security behavior for
# developer-mode extensions (in place since ~2016, to stop malware from
# silently force-installing unpacked extensions), not something this build
# controls, and not something that can be suppressed from the manifest side.
# The only way to make a Chrome extension behave like a normally installed
# one - no prompt, persists across restarts - is to install it through the
# Chrome Web Store, which supports a private "Unlisted" visibility (reachable
# only via direct link, not searchable) for exactly this kind of personal use.
#
# One-time setup this script can't do for you (Google doesn't offer a simple
# API-key flow like Mozilla's - it's OAuth2):
#   1. Register a Chrome Web Store developer account (one-time $5 fee, needs
#      2-Step Verification on the Google account):
#      https://chrome.google.com/webstore/devconsole/register
#   2. Create the listing once, by hand, in the dashboard - upload
#      dist/niixtube-chrome-vX.Y.Z.zip, fill in the required fields, and set
#      visibility to "Unlisted". Note the resulting Extension ID.
#   3. Create OAuth2 credentials for the Chrome Web Store API in a Google
#      Cloud project and get a refresh token - Google's own guide:
#      https://developer.chrome.com/docs/webstore/using-api
# After that one-time setup, subsequent builds can push new versions
# automatically by re-running this script with:
#   CWS_CLIENT_ID=xxx CWS_CLIENT_SECRET=xxx CWS_REFRESH_TOKEN=xxx \
#   CWS_PUBLISHER_ID=xxx CWS_EXTENSION_ID=xxx ./build.sh
# ---------------------------------------------------------------------------
if [ -n "${CWS_CLIENT_ID:-}" ] && [ -n "${CWS_CLIENT_SECRET:-}" ] && [ -n "${CWS_REFRESH_TOKEN:-}" ] && \
   [ -n "${CWS_PUBLISHER_ID:-}" ] && [ -n "${CWS_EXTENSION_ID:-}" ]; then
  log "Chrome Web Store credentials found — pushing an update for a persistent, prompt-free install..."
  if npm install --no-save --no-fund --no-audit chrome-webstore-upload-cli@latest >/dev/null 2>&1 && \
     CLIENT_ID="$CWS_CLIENT_ID" CLIENT_SECRET="$CWS_CLIENT_SECRET" REFRESH_TOKEN="$CWS_REFRESH_TOKEN" \
     PUBLISHER_ID="$CWS_PUBLISHER_ID" \
     npx --yes chrome-webstore-upload-cli --source "$CHROME_ZIP" --extension-id "$CWS_EXTENSION_ID"; then
    log "Chrome Web Store update published for extension $CWS_EXTENSION_ID."
    log "Once Chrome finishes auto-updating (or after 'Update' in chrome://extensions), this install is no longer dev-mode and stops prompting on restart."
  else
    warn "Chrome Web Store upload/publish failed (see the CLI output above, or check your credentials)."
    warn "The unpacked $BUILD_DIR and $CHROME_ZIP are still available for local/manual testing."
  fi
else
  log "No Chrome Web Store credentials set — skipping Chrome Web Store publish."
  log "The 'Disable developer mode extensions' prompt on every restart is expected for a 'Load unpacked' install and isn't caused by this build."
  log "For a persistent, prompt-free install, publish (even as 'Unlisted') via the Chrome Web Store — see the comment above this step in build.sh for the one-time setup."
fi

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------
log "Build complete."
log "  Chrome unpacked:  $BUILD_DIR  (chrome://extensions -> Load unpacked -> select this folder - dev-mode, will nag/disable on every browser restart, see step 8 above)"
log "  Chrome zipped:    $CHROME_ZIP (upload directly to the Chrome Web Store Developer Dashboard, or use CWS_* vars above to push automatically)"
log "  Firefox unpacked: $FIREFOX_BUILD_DIR  (about:debugging#/runtime/this-firefox -> Load Temporary Add-on -> select manifest.json in this folder - TEMPORARY, wiped on restart)"
log "  Firefox zipped:   $FIREFOX_ZIP (upload to https://addons.mozilla.org/developers/ for signing, or use AMO_JWT_ISSUER/AMO_JWT_SECRET above to sign automatically)"
log "Full log written to $LOG_FILE"
