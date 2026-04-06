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

# Start scheduler + health check (no LLM, no OpenClaw)
echo "[entrypoint] Starting scheduler..."
exec su -s /bin/bash node -c "node -e \"
const http = require('http');
const {execSync, spawn} = require('child_process');
const INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const SCRIPTS_DIR = '/data/.openclaw/workspace/scripts';

function runScript(name) {
  console.log(JSON.stringify({ts:new Date().toISOString(),level:'info',action:'cron_start',script:name}));
  const child = spawn('node', [SCRIPTS_DIR+'/'+name], {
    env: {...process.env, PLAYWRIGHT_BROWSERS_PATH:'/home/node/.cache/ms-playwright'},
    stdio: ['ignore','pipe','pipe'],
  });
  child.stdout.on('data', d => process.stdout.write(d));
  child.stderr.on('data', d => process.stderr.write(d));
  child.on('close', code => {
    console.log(JSON.stringify({ts:new Date().toISOString(),level:code===0?'info':'error',action:'cron_done',script:name,exitCode:code}));
  });
}

// Run scraper on startup + every 6h
runScript('scrape-all.js');
setInterval(() => runScript('scrape-all.js'), INTERVAL_MS);

// Run competitor search 1h after scraper + every 6h
setTimeout(() => {
  runScript('find-competitors.js');
  setInterval(() => runScript('find-competitors.js'), INTERVAL_MS);
}, 60*60*1000);

// Health check
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
  console.log('[scheduler] listening on port '+(process.env.PORT||8080)+' — scraper every 6h, competitors 1h after');
});
\""
