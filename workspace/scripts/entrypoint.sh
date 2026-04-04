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
cp /home/node/.openclaw/skills/anti-suspension/SKILL.md "$DEST/skills/anti-suspension/"

# Memory files in volume are NEVER overwritten (agent writes to these at runtime)
# The mkdir -p above ensures the dirs exist, but content is preserved.

# Ensure node owns everything in the volume
chown -R node:node "$DEST"

# Point OpenClaw to persistent volume
export OPENCLAW_STATE_DIR="$DEST"
export OPENCLAW_CONFIG_PATH="$DEST/config.json"

# Drop to node user for the gateway
echo "[entrypoint] Starting gateway as node (state=$DEST)"
exec su -s /bin/bash node -c "OPENCLAW_STATE_DIR=$DEST OPENCLAW_CONFIG_PATH=$DEST/config.json exec node /app/openclaw.mjs gateway --allow-unconfigured --bind lan"
