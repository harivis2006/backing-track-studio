#!/bin/bash
# Backing Track Studio — helper installer for macOS.
#   curl -fsSL __SITE_URL__/install.sh | bash
# Installs (or updates) the helper that runs the AI models on this Mac, and starts it at login.
# Run it again any time to update; your songs and the downloaded AI models are kept.
set -euo pipefail

SITE="${BTS_SITE:-__SITE_URL__}"   # BTS_SITE overrides where to download from (for testing)
HOME_DIR="${BTS_HOME:-$HOME/Library/Application Support/Backing Track Studio}"
LABEL="com.backingtrackstudio.helper"
PORT=8765
NO_AGENT="${BTS_NO_AGENT:-}"     # set to 1 to skip the login item / helper app (used for testing)

say()  { printf "\n\033[1;33m==>\033[0m \033[1m%s\033[0m\n" "$*"; }
fail() { printf "\n\033[1;31mCan't continue:\033[0m %s\n" "$*" >&2; exit 1; }

# ---------------------------------------------------------------- checks
[ "$(uname -s)" = "Darwin" ] || fail "this installer is for macOS."
[ "$(uname -m)" = "arm64" ] || say "Note: this Mac has an Intel processor — everything works, but splitting songs will be slow."
free_gb=$(df -g "$HOME" | awk 'NR==2 {print $4}')
[ "${free_gb:-0}" -ge 4 ] || fail "about 4 GB of free disk space is needed (this Mac has ${free_gb} GB free)."

# ---------------------------------------------------------------- tools (Homebrew)
if ! command -v brew >/dev/null 2>&1; then
  for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do
    if [ -x "$b" ]; then eval "$("$b" shellenv)"; fi
  done
fi
command -v brew >/dev/null 2>&1 || fail "Homebrew is needed first. Go to https://brew.sh, copy the command shown there into Terminal, then run this installer again."
BREW_BIN="$(brew --prefix)/bin"
missing=()
[ -x "$BREW_BIN/python3.12" ] || command -v python3.12 >/dev/null 2>&1 || missing+=(python@3.12)
command -v ffmpeg >/dev/null 2>&1 || missing+=(ffmpeg)
command -v node   >/dev/null 2>&1 || missing+=(node)
if [ ${#missing[@]} -gt 0 ]; then
  say "Installing ${missing[*]} with Homebrew…"
  brew install "${missing[@]}"
fi
PYTHON="$(command -v python3.12 || echo "$BREW_BIN/python3.12")"

# ---------------------------------------------------------------- the helper itself
stop_helper() {  # stop the running helper and wait until it has really gone (a busy one takes a few seconds)
  busy=$(curl -s -m 2 "http://127.0.0.1:$PORT/api/jobs" | grep -oE '"status": ?"(running|queued)"' | wc -l | tr -d ' ')
  if [ "${busy:-0}" -gt 0 ]; then say "$busy song(s) being split will start again after the update — nothing is lost."; fi
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  for i in $(seq 1 30); do
    if ! launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1 && ! lsof -nP -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; then break; fi
    sleep 1
  done
}
if [ -z "$NO_AGENT" ]; then stop_helper; fi
say "Downloading the helper…"
mkdir -p "$HOME_DIR"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
curl -fsSL "$SITE/helper.zip" -o "$tmp/helper.zip"
rm -rf "$HOME_DIR/app.new"; mkdir -p "$HOME_DIR/app.new"
ditto -x -k "$tmp/helper.zip" "$HOME_DIR/app.new"
for keep in .venv models; do  # keep the Python packages and AI models from a previous install
  if [ -e "$HOME_DIR/app/$keep" ]; then mv "$HOME_DIR/app/$keep" "$HOME_DIR/app.new/$keep"; fi
done
rm -rf "$HOME_DIR/app"; mv "$HOME_DIR/app.new" "$HOME_DIR/app"
mkdir -p "$HOME_DIR/data" "$HOME_DIR/logs"

say "Installing the Python packages (about 1 GB — this takes a few minutes)…"
cd "$HOME_DIR/app"
[ -x .venv/bin/python ] || "$PYTHON" -m venv .venv
.venv/bin/pip install --quiet --disable-pip-version-check --upgrade pip
.venv/bin/pip install --quiet --disable-pip-version-check -r requirements.txt

if [ -n "$NO_AGENT" ]; then say "Installed to $HOME_DIR (no login item, as requested)."; exit 0; fi

# ---------------------------------------------------------------- start at login
say "Setting the helper to start automatically…"
mkdir -p "$HOME/Library/LaunchAgents"
plist="$HOME/Library/LaunchAgents/$LABEL.plist"
cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$HOME_DIR/app/.venv/bin/python</string><string>server.py</string></array>
  <key>WorkingDirectory</key><string>$HOME_DIR/app</string>
  <key>EnvironmentVariables</key><dict>
    <key>BTS_DATA</key><string>$HOME_DIR/data</string>
    <key>BTS_PORT</key><string>$PORT</string>
    <key>PATH</key><string>$BREW_BIN:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <!-- restart after a crash, but not after you choose Quit in the app -->
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key><string>$HOME_DIR/logs/helper.log</string>
  <key>StandardErrorPath</key><string>$HOME_DIR/logs/helper.log</string>
</dict></plist>
PLIST
for i in 1 2 3 4 5; do  # starting can fail briefly while macOS finishes removing the old one
  if launchctl bootstrap "gui/$(id -u)" "$plist" 2>/dev/null; then break; fi
  if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then launchctl kickstart -k "gui/$(id -u)/$LABEL"; break; fi
  [ "$i" = 5 ] && fail "macOS wouldn't start the helper. Run this installer again, or open Backing Track Studio Helper from Applications."
  sleep 2
done

# A small app in Applications that starts the helper again after you've quit it.
apps="/Applications"; [ -w "$apps" ] || { apps="$HOME/Applications"; mkdir -p "$apps"; }
app="$apps/Backing Track Studio Helper.app"
rm -rf "$app"; mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp "$HOME_DIR/app/macos/Backing Track Studio.app/Contents/Resources/AppIcon.icns" "$app/Contents/Resources/" 2>/dev/null || true
cat > "$app/Contents/MacOS/start" <<START
#!/bin/sh
launchctl bootstrap "gui/\$(id -u)" "$plist" 2>/dev/null || launchctl kickstart "gui/\$(id -u)/$LABEL"
for i in \$(seq 1 40); do curl -s -o /dev/null "http://127.0.0.1:$PORT/api/health" && break; sleep 0.5; done
open "$SITE"
START
chmod +x "$app/Contents/MacOS/start"
cat > "$app/Contents/Info.plist" <<INFO
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Backing Track Studio Helper</string>
  <key>CFBundleIdentifier</key><string>com.backingtrackstudio.helper-launcher</string>
  <key>CFBundleExecutable</key><string>start</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSUIElement</key><true/>
</dict></plist>
INFO

say "Starting the helper (the first start also downloads the AI models, about 1 GB)…"
for i in $(seq 1 120); do curl -s -o /dev/null "http://127.0.0.1:$PORT/api/health" && break; sleep 1; done
curl -s -o /dev/null "http://127.0.0.1:$PORT/api/health" || fail "the helper didn't start. Details: $HOME_DIR/logs/helper.log"
say "Done! Opening $SITE"
open "$SITE"
