#!/bin/bash
set -e

# Persistent volume mount point (Railway volume or /data fallback)
DEST="${OPENCLAW_VOLUME_PATH:-/data/.openclaw}"

# Fix volume permissions — Railway mounts /data as root
echo "[entrypoint] Fixing volume permissions on /data"
chown node:node /data 2>/dev/null || true

echo "[entrypoint] Syncing workspace to persistent volume: $DEST"

# Create directory structure
mkdir -p "$DEST/workspace/scripts" \
         "$DEST/workspace/memory/casos" \
         "$DEST/workspace/memory/patrones" \
         "$DEST/workspace/memory/metricas" \
         "$DEST/skills/dropux" \
         "$DEST/skills/anti-suspension"

# ALL files: copy only if not present (edit in volume, restart without rebuild)
# To force update from git: delete the file in volume, then restart

# Config
for f in config.json exec-approvals.json; do
  [ -f "$DEST/$f" ] || cp "/home/node/.openclaw/$f" "$DEST/$f"
done

# Workspace .md
for f in /home/node/.openclaw/workspace/*.md; do
  base=$(basename "$f")
  [ -f "$DEST/workspace/$base" ] || cp "$f" "$DEST/workspace/$base"
done

# Scripts .js
for f in /home/node/.openclaw/workspace/scripts/*.js; do
  base=$(basename "$f")
  [ -f "$DEST/workspace/scripts/$base" ] || cp "$f" "$DEST/workspace/scripts/$base"
done

# Skills
for skill in dropux anti-suspension; do
  src="/home/node/.openclaw/skills/$skill/SKILL.md"
  [ -f "$DEST/skills/$skill/SKILL.md" ] || [ ! -f "$src" ] || cp "$src" "$DEST/skills/$skill/SKILL.md"
done

echo "[entrypoint] Volume ready (files only copied if missing)"

# Ensure node owns everything in the volume
chown -R node:node "$DEST"

# Point OpenClaw to persistent volume
export OPENCLAW_STATE_DIR="$DEST"
export OPENCLAW_CONFIG_PATH="$DEST/config.json"

# Drop to node user for the gateway
echo "[entrypoint] Starting gateway as node (state=$DEST)"
exec su -s /bin/bash node -c "OPENCLAW_STATE_DIR=$DEST OPENCLAW_CONFIG_PATH=$DEST/config.json exec node /app/openclaw.mjs gateway --allow-unconfigured --bind lan"
