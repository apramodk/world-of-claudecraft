// Stream overlay for Haikubot: one page combining the live spectate view,
// his open task list, and a ticker of his thoughts/actions.
//   node mcp/overlay_server.mjs           → http://localhost:8788
//   env: BOT_NAME (Haikubot), GAME_URL (live server), PORT (8788)
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const BOT = process.env.BOT_NAME ?? 'Haikubot';
const GAME = process.env.GAME_URL ?? 'https://claudecraft-east.eastus.cloudapp.azure.com';
const PORT = Number(process.env.PORT ?? 8788);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEMORY_DIR = path.join(os.homedir(), '.claudecraft-mcp-memory');
const THOUGHTS = path.join(REPO, 'tmp', 'thoughts.ndjson');

function findFile(suffix) {
  try {
    const f = fs.readdirSync(MEMORY_DIR).find((n) => n.endsWith(`__${BOT}${suffix}`));
    return f ? path.join(MEMORY_DIR, f) : null;
  } catch { return null; }
}

function overlayData() {
  let tasks = [];
  const tf = findFile('.tasks.json');
  if (tf) { try { tasks = JSON.parse(fs.readFileSync(tf, 'utf-8')); } catch { /* mid-write */ } }
  let memory = [];
  const mf = findFile('.md');
  if (mf) { try { memory = fs.readFileSync(mf, 'utf-8').trim().split('\n').slice(-4); } catch { /* */ } }
  let thoughts = [];
  try {
    thoughts = fs.readFileSync(THOUGHTS, 'utf-8').trim().split('\n').slice(-25)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { /* no thoughts yet */ }
  return { bot: BOT, tasks: tasks.filter((t) => !t.done).slice(-8), recentDone: tasks.filter((t) => t.done).slice(-3), memory, thoughts };
}

const HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${BOT} — live</title><style>
  * { box-sizing: border-box; margin: 0; }
  body { background: #000; font-family: Georgia, 'Palatino Linotype', serif; overflow: hidden; }
  #game { position: fixed; inset: 0; width: 100vw; height: 100vh; border: 0; }
  .panel { position: fixed; background: #0b0b12d8; border: 2px solid #6f5a2a; border-radius: 8px;
    color: #e8d8a8; padding: 12px 14px; box-shadow: 0 2px 16px #000c; }
  .panel h2 { color: #ffd100; font-size: 15px; letter-spacing: .5px; border-bottom: 1px solid #463a1c;
    padding-bottom: 5px; margin-bottom: 8px; text-shadow: 1px 1px 2px #000; }
  #tasks { top: 90px; right: 14px; width: 300px; max-height: 38vh; overflow: hidden; }
  #tasks li { font-size: 13px; line-height: 1.5; margin-left: 18px; }
  #tasks li.done { color: #7fdc4f; text-decoration: line-through; opacity: .7; }
  #thoughts { left: 14px; bottom: 180px; width: 460px; max-height: 44vh; overflow: hidden;
    display: flex; flex-direction: column; justify-content: flex-end; }
  .t { font-size: 13px; line-height: 1.5; margin-top: 5px; opacity: 0; animation: fade .4s forwards; }
  .t.thought { color: #cfe3ff; font-style: italic; }
  .t.thought::before { content: '🧠 '; font-style: normal; }
  .t.action { color: #ffd9a0; }
  .t.action::before { content: '⚡ '; }
  .t.result { color: #9c8f6e; font-size: 12px; }
  @keyframes fade { to { opacity: 1; } }
  #brand { top: 14px; left: 50%; transform: translateX(-50%); font-size: 14px; color: #ffd100;
    letter-spacing: 1px; padding: 8px 22px; }
  #offline { display: none; position: fixed; inset: 0; background: #000a; color: #e8d8a8;
    font-size: 26px; text-align: center; padding-top: 40vh; }
</style></head><body>
  <iframe id="game" src="${GAME}/?spectate=${BOT}" allow="autoplay"></iframe>
  <div id="brand" class="panel">🧙 ${BOT} — an AI playing World of Claudecraft live</div>
  <div id="tasks" class="panel"><h2>Goals</h2><ul id="task-list"></ul></div>
  <div id="thoughts" class="panel"><h2>Thinking</h2><div id="thought-list"></div></div>
  <div id="offline">🧙 ${BOT} is resting between adventures…<br><span style="font-size:15px">(sessions cycle every few minutes — he'll be back)</span></div>
<script>
  let lastThoughtAt = 0;
  async function tick() {
    try {
      const d = await (await fetch('/api/overlay')).json();
      const ul = document.getElementById('task-list');
      ul.innerHTML = d.tasks.map(t => '<li>' + esc(t.text) + '</li>').join('')
        + d.recentDone.map(t => '<li class="done">' + esc(t.text) + '</li>').join('');
      const tl = document.getElementById('thought-list');
      const fresh = d.thoughts.filter(t => t.at > lastThoughtAt);
      if (fresh.length) {
        lastThoughtAt = d.thoughts[d.thoughts.length - 1].at;
        for (const t of fresh) {
          const el = document.createElement('div');
          el.className = 't ' + t.kind;
          el.textContent = t.text;
          tl.appendChild(el);
        }
        while (tl.children.length > 14) tl.removeChild(tl.firstChild);
      }
    } catch (e) { /* server restarting */ }
  }
  function esc(s) { const d = document.createElement('span'); d.textContent = s; return d.innerHTML; }
  setInterval(tick, 2000); tick();
  // reload the game iframe occasionally if the bot was offline when it loaded
  setInterval(() => {
    fetch('${GAME}/api/status').then(r => r.json()).then(s => {
      const on = s.names?.includes('${BOT}');
      document.getElementById('offline').style.display = on ? 'none' : 'block';
      if (on && window.__wasOffline) { document.getElementById('game').src = '${GAME}/?spectate=${BOT}'; window.__wasOffline = false; }
      if (!on) window.__wasOffline = true;
    }).catch(() => {});
  }, 10000);
</script></body></html>`;

http.createServer((req, res) => {
  if (req.url?.startsWith('/api/overlay')) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(overlayData()));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(HTML);
}).listen(PORT, () => console.log(`overlay: http://localhost:${PORT}  (bot: ${BOT}, game: ${GAME})`));
