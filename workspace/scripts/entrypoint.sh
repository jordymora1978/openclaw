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
// Scraper arranca 30 min antes para que el análisis IA esté visible en /inquiries
// a las horas pico que pidió el usuario: 10 AM, 1 PM, 5 PM.
const SCRAPE_SCHEDULE_COL = [{ h: 9, m: 30 }, { h: 12, m: 30 }, { h: 16, m: 30 }];
const EXTRACT_SCHEDULE_COL = [{ h: 10, m: 0 }, { h: 13, m: 0 }, { h: 17, m: 0 }];
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

// Devuelve el próximo Date UTC dado un schedule de pares { h, m } en hora Colombia
function nextRunForSchedule(schedule) {
  const now = new Date();
  const candidates = [];
  for (let dayDelta = 0; dayDelta < 2; dayDelta++) {
    for (const { h, m } of schedule) {
      const d = new Date(now);
      d.setUTCDate(d.getUTCDate() + dayDelta);
      d.setUTCHours(h + COL_OFFSET_HOURS, m, 0, 0);
      if (d > now) candidates.push(d);
    }
  }
  return candidates[0];
}

function scheduleNext(label, fn, schedule) {
  const next = nextRunForSchedule(schedule);
  const wait = next - new Date();
  console.log(JSON.stringify({ts:new Date().toISOString(),level:'info',action:'scheduled',label,next_utc:next.toISOString(),wait_min:Math.round(wait/60000)}));
  setTimeout(() => {
    fn();
    setTimeout(() => scheduleNext(label, fn, schedule), 60000);  // re-programa después
  }, wait);
}

// Scraper a 9:30 / 12:30 / 16:30 COL (resultado listo en DB ~10 min después)
scheduleNext('scraper', runScrapers, SCRAPE_SCHEDULE_COL);
// Extract-context a 10:00 / 13:00 / 17:00 COL (análisis IA listo ~5 min después)
scheduleNext('extract-context', () => runScript('extract-context.js'), EXTRACT_SCHEDULE_COL);

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
