#!/bin/bash
set -e

# Persistent volume mount point (Railway volume or /data fallback)
DEST="${OPENCLAW_VOLUME_PATH:-/data/.openclaw}"

echo "[entrypoint] Syncing workspace to persistent volume: $DEST"

# Create directory structure
mkdir -p "$DEST/workspace/scripts" \
         "$DEST/workspace/memory/casos" \
         "$DEST/workspace/memory/patrones" \
         "$DEST/workspace/memory/metricas" \
         "$DEST/skills/dropux"

# Config files: copy only if not present (preserve manual edits)
for f in config.json exec-approvals.json; do
  if [ ! -f "$DEST/$f" ]; then
    echo "[entrypoint] First deploy — copying default $f"
    cp "/home/node/.openclaw/$f" "$DEST/$f"
  else
    echo "[entrypoint] $f already exists in volume, keeping it"
  fi
done

# Workspace .md files: always sync from image (source of truth in git)
echo "[entrypoint] Syncing workspace .md files"
cp /home/node/.openclaw/workspace/*.md "$DEST/workspace/"

# Scripts: always sync from image
echo "[entrypoint] Syncing workspace scripts"
cp /home/node/.openclaw/workspace/scripts/*.js "$DEST/workspace/scripts/"

# Skills: always sync from image
echo "[entrypoint] Syncing skills"
cp /home/node/.openclaw/skills/dropux/SKILL.md "$DEST/skills/dropux/"

# Memory files in volume are NEVER overwritten (agent writes to these at runtime)
# The mkdir -p above ensures the dirs exist, but content is preserved.

# Point OpenClaw to persistent volume
export OPENCLAW_STATE_DIR="$DEST"
export OPENCLAW_CONFIG_PATH="$DEST/config.json"

echo "[entrypoint] Starting gateway (state=$DEST)"
exec node /app/openclaw.mjs gateway --allow-unconfigured --bind lan
