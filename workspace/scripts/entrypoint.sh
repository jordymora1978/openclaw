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

# Scripts .js — ALWAYS overwrite (code must stay in sync with deploy)
for f in /home/node/.openclaw/workspace/scripts/*.js; do
  base=$(basename "$f")
  cp "$f" "$DEST/workspace/scripts/$base"
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
const SCRIPTS_DIR = '/data/.openclaw/workspace/scripts';

// Horario fijo en Colombia (UTC-5). Tres corridas en ventana de actividad humana.
// El scraper corre a estas horas; extract-context 30 min después.
const SCRAPE_HOURS_COL = [10, 13, 17];  // 10 AM, 1 PM, 5 PM Colombia
const EXTRACT_OFFSET_MIN = 30;
const COL_OFFSET_HOURS = 5;  // Colombia = UTC-5

function runScript(name, args) {
  const label = args ? name+' '+args.join(' ') : name;
  console.log(JSON.stringify({ts:new Date().toISOString(),level:'info',action:'cron_start',script:label}));
  const child = spawn('node', [SCRIPTS_DIR+'/'+name, ...(args||[])], {
    env: {...process.env, PLAYWRIGHT_BROWSERS_PATH:'/home/node/.cache/ms-playwright'},
    stdio: ['ignore','pipe','pipe'],
  });
  child.stdout.on('data', d => process.stdout.write(d));
  child.stderr.on('data', d => process.stderr.write(d));
  child.on('close', code => {
    console.log(JSON.stringify({ts:new Date().toISOString(),level:code===0?'info':'error',action:'cron_done',script:label,exitCode:code}));
  });
}

function runScrapers() {
  if (process.env.BB_CONTEXT_49) runScript('scrape-store.js', ['49']);
  if (process.env.BB_CONTEXT_51) runScript('scrape-store.js', ['51']);
}

// Calcula próximo Date UTC para una hora local Colombia dada (HH 0-23)
function nextRunFor(colHour, offsetMin) {
  const now = new Date();
  const candidates = [];
  for (let dayDelta = 0; dayDelta < 2; dayDelta++) {
    for (const h of SCRAPE_HOURS_COL) {
      const d = new Date(now);
      d.setUTCDate(d.getUTCDate() + dayDelta);
      d.setUTCHours(h + COL_OFFSET_HOURS, offsetMin || 0, 0, 0);
      if (d > now) candidates.push(d);
    }
  }
  if (colHour !== undefined) {
    return candidates.find(d => d.getUTCHours() === (colHour + COL_OFFSET_HOURS) % 24) || candidates[0];
  }
  return candidates[0];
}

function scheduleNext(label, fn, offsetMin) {
  const next = nextRunFor(undefined, offsetMin);
  const wait = next - new Date();
  console.log(JSON.stringify({ts:new Date().toISOString(),level:'info',action:'scheduled',label,next_utc:next.toISOString(),wait_min:Math.round(wait/60000)}));
  setTimeout(() => {
    fn();
    setTimeout(() => scheduleNext(label, fn, offsetMin), 60000);  // re-programa después
  }, wait);
}

// Programa scraper a las 10 AM, 1 PM, 5 PM COL
scheduleNext('scraper', runScrapers, 0);
// Programa extract-context 30 min después de cada scrape
scheduleNext('extract-context', () => runScript('extract-context.js'), EXTRACT_OFFSET_MIN);

// DISABLED 2026-04-23: both competitor scripts share the Browserbase context with
// scrape-store.js and kill its session mid-run (Colombia always fails). Re-enable
// when we want competitor data; consider moving them to a delay > scraper duration.
// // Run per-publication competitor search 5min after scraper + every 6h
// setTimeout(() => {
//   runScript('find-pub-competitors.js');
//   setInterval(() => runScript('find-pub-competitors.js'), INTERVAL_MS);
// }, 5*60*1000);
//
// // Retry failed competitor searches with LLM ingredients 10min after scraper (one-time on startup)
// setTimeout(() => {
//   runScript('retry-competitors.js');
// }, 10*60*1000);

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
