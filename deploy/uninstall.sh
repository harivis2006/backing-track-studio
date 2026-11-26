#!/bin/bash
# Backing Track Studio — remove the helper.
#   curl -fsSL __SITE_URL__/uninstall.sh | bash            keeps your songs
#   curl -fsSL __SITE_URL__/uninstall.sh | bash -s -- --all  also deletes your songs
set -euo pipefail
HOME_DIR="${BTS_HOME:-$HOME/Library/Application Support/Backing Track Studio}"
LABEL="com.backingtrackstudio.helper"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
rm -rf "/Applications/Backing Track Studio Helper.app" "$HOME/Applications/Backing Track Studio Helper.app"
rm -rf "$HOME_DIR/app" "$HOME_DIR/logs"
rm -f "$HOME/.cache/torch/hub/checkpoints/beat_this-final0.ckpt"

if [ "${1:-}" = "--all" ]; then
  rm -rf "$HOME_DIR"
  echo "Backing Track Studio and all your songs have been removed."
else
  echo "The helper has been removed. Your songs are still in: $HOME_DIR/data"
  echo "(To delete them too, run the uninstaller with --all.)"
fi
