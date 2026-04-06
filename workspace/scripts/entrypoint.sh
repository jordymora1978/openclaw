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

# Setup system cron for scraper (no LLM, no tokens, no OpenClaw)
echo "[entrypoint] Setting up system cron..."
CRON_LOG="$DEST/scrape-cron.log"

# Write crontab for node user
cat > /tmp/scraper-cron << CRONEOF
# Scrape ML inquiries every 6 hours (0:00, 6:00, 12:00, 18:00 Colombia = 5,11,17,23 UTC)
0 5,11,17,23 * * * PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright BB_CONTEXT_49=${BB_CONTEXT_49} SUPABASE_URL=${SUPABASE_URL} SUPABASE_ANON_KEY=${SUPABASE_ANON_KEY} SUPABASE_CATALOG_URL=${SUPABASE_CATALOG_URL} SUPABASE_CATALOG_ANON_KEY=${SUPABASE_CATALOG_ANON_KEY} BROWSERBASE_API_KEY=${BROWSERBASE_API_KEY} BROWSERBASE_PROJECT_ID=${BROWSERBASE_PROJECT_ID} /usr/local/bin/node ${DEST}/workspace/scripts/scrape-all.js >> ${CRON_LOG} 2>&1

# Find competitors for pending cases every 6 hours (offset 1h from scraper)
0 6,12,18,0 * * * PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright BB_CONTEXT_49=${BB_CONTEXT_49} SUPABASE_URL=${SUPABASE_URL} SUPABASE_ANON_KEY=${SUPABASE_ANON_KEY} SUPABASE_CATALOG_URL=${SUPABASE_CATALOG_URL} SUPABASE_CATALOG_ANON_KEY=${SUPABASE_CATALOG_ANON_KEY} BROWSERBASE_API_KEY=${BROWSERBASE_API_KEY} BROWSERBASE_PROJECT_ID=${BROWSERBASE_PROJECT_ID} /usr/local/bin/node ${DEST}/workspace/scripts/find-competitors.js >> ${DEST}/competitors-cron.log 2>&1
CRONEOF

crontab -u node /tmp/scraper-cron 2>/dev/null || crontab /tmp/scraper-cron 2>/dev/null || true
rm -f /tmp/scraper-cron

# Start cron daemon in background
crond 2>/dev/null || cron 2>/dev/null || echo "[entrypoint] WARNING: cron daemon not available"
echo "[entrypoint] System cron configured"

# Health check server (keeps container alive on Railway)
echo "[entrypoint] Starting health check server..."
exec su -s /bin/bash node -c "node -e \"
const http = require('http');
const server = http.createServer((req, res) => {
  if (req.url === '/healthz' || req.url === '/health') {
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify({status:'ok',service:'dropux-scraper'}));
  } else {
    res.writeHead(404);
    res.end();
  }
});
server.listen(process.env.PORT || 8080, '0.0.0.0', () => {
  console.log('[health] listening on port ' + (process.env.PORT || 8080));
});
\""
