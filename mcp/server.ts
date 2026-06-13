// World of Claudecraft MCP server: lets any MCP-capable AI agent play the game
// as a real character on a live server. Speaks the same REST + WebSocket
// protocol as the browser client; movement is handled by a background
// navigator so agents issue intents ("walk to the wolf") not 20 Hz inputs.
//
//   build:  npm run build:mcp
//   run:    node dist-mcp/claudecraft-mcp.mjs       (stdio transport)
//   server: SERVER_URL env or join_world's server_url (default: live East VM)
//
// stdout is the MCP transport — never console.log here; diagnostics go to stderr.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import WebSocket from 'ws';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { QUESTS, ITEMS, zoneAt } from '../src/sim/data';

const DEFAULT_SERVER = process.env.SERVER_URL ?? 'https://claudecraft-east.eastus.cloudapp.azure.com';
const CRED_FILE = path.join(os.homedir(), '.claudecraft-mcp.json');
const MEMORY_DIR = path.join(os.homedir(), '.claudecraft-mcp-memory');

// ---------------------------------------------------------------------------
// Per-character memory: a plain markdown file the agent reads on join and
// appends to with `remember` — lets a bot recognize players across sessions.
// ---------------------------------------------------------------------------

function memoryPath(server: string, charName: string): string {
  const safe = `${server.replace(/[^a-z0-9]+/gi, '_')}__${charName}`;
  return path.join(MEMORY_DIR, `${safe}.md`);
}

function readMemory(server: string, charName: string): string {
  try { return fs.readFileSync(memoryPath(server, charName), 'utf-8'); } catch { return ''; }
}

function appendMemory(server: string, charName: string, note: string): void {
  fs.mkdirSync(MEMORY_DIR, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  fs.appendFileSync(memoryPath(server, charName), `- [${stamp}] ${note}\n`);
}

// Per-character task list: persistent goals the agent works through across
// sessions. Players can hand the bot tasks in chat; it adds them here.
interface BotTask { id: number; text: string; done: boolean; added: string }

function tasksPath(server: string, charName: string): string {
  return memoryPath(server, charName).replace(/\.md$/, '.tasks.json');
}

function readTasks(server: string, charName: string): BotTask[] {
  try { return JSON.parse(fs.readFileSync(tasksPath(server, charName), 'utf-8')); } catch { return []; }
}

function writeTasks(server: string, charName: string, tasks: BotTask[]): void {
  fs.mkdirSync(MEMORY_DIR, { recursive: true });
  fs.writeFileSync(tasksPath(server, charName), JSON.stringify(tasks, null, 2));
}

function tasksSummary(server: string, charName: string): string {
  const tasks = readTasks(server, charName);
  const open = tasks.filter((t) => !t.done);
  if (!open.length) return '(no open tasks — add_task to set goals)';
  return open.map((t) => `  #${t.id} ${t.text}`).join('\n');
}

// ---------------------------------------------------------------------------
// Game client (same wire protocol as the browser client / test bots)
// ---------------------------------------------------------------------------

// heavy self fields arrive only when changed; absent = same as last snapshot
const DELTA_SELF_KEYS = ['inv', 'equip', 'qlog', 'qdone', 'cds', 'stats', 'weapon', 'party', 'trade', 'duel'];

interface Creds { username: string; password: string }

function loadCreds(server: string, charName: string): Creds | null {
  try {
    const all = JSON.parse(fs.readFileSync(CRED_FILE, 'utf-8'));
    return all[`${server}::${charName}`] ?? null;
  } catch { return null; }
}

function saveCreds(server: string, charName: string, creds: Creds): void {
  let all: Record<string, Creds> = {};
  try { all = JSON.parse(fs.readFileSync(CRED_FILE, 'utf-8')); } catch { /* fresh file */ }
  all[`${server}::${charName}`] = creds;
  fs.writeFileSync(CRED_FILE, JSON.stringify(all, null, 2), { mode: 0o600 });
}

class GameClient {
  ws: WebSocket | null = null;
  base = DEFAULT_SERVER;
  token = '';
  pid = -1;
  charName = '';
  self: any = null;
  ents = new Map<number, any>();
  events: any[] = [];
  unreadChat: any[] = [];
  private inputTimer: ReturnType<typeof setInterval> | null = null;
  private mi = { f: 0, b: 0, tl: 0, tr: 0, sl: 0, sr: 0, j: 0 };
  private facing: number | null = null;
  private navigating = false;

  get connected(): boolean { return this.ws !== null && this.ws.readyState === WebSocket.OPEN; }

  private async api(p: string, body?: unknown, method = 'POST'): Promise<{ status: number; body: any }> {
    const res = await fetch(this.base + p, {
      method,
      headers: { 'Content-Type': 'application/json', ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }

  async join(serverUrl: string, charName: string, playerClass: string): Promise<string> {
    if (this.connected) await this.leave();
    this.base = serverUrl.replace(/\/$/, '');
    this.charName = charName;

    // account: reuse persisted creds for this server+character, else register
    let creds = loadCreds(this.base, charName);
    if (creds) {
      const login = await this.api('/api/login', creds);
      if (login.status !== 200) creds = null; // stale — fall through to register
      else this.token = login.body.token;
    }
    if (!creds) {
      creds = {
        username: `agent_${charName.toLowerCase().slice(0, 12)}_${Math.random().toString(36).slice(2, 7)}`,
        password: Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2),
      };
      const reg = await this.api('/api/register', creds);
      if (reg.status !== 200) throw new Error(`register failed: ${JSON.stringify(reg.body)}`);
      this.token = reg.body.token;
      saveCreds(this.base, charName, creds);
    }

    // character: find by name, else create
    const list = await this.api('/api/characters', undefined, 'GET');
    let char = (list.body.characters ?? []).find((c: any) => c.name === charName);
    if (!char) {
      const created = await this.api('/api/characters', { name: charName, class: playerClass });
      if (created.status !== 200) throw new Error(`character create failed: ${JSON.stringify(created.body)}`);
      char = created.body;
    }

    // connect, retrying on "already in world" — after our own leave() the
    // server releases the online claim asynchronously, so a fast rejoin can
    // race it; back off and retry rather than deadlocking the bot
    for (let attempt = 0; ; attempt++) {
      try { await this.connectWs(char.id); break; }
      catch (err) {
        const m = String((err as Error).message ?? err);
        if (m.includes('already in world') && attempt < 5) { await sleep(2000); continue; }
        throw err;
      }
    }

    // movement intent stream, same cadence as the browser client
    this.inputTimer = setInterval(() => {
      if (!this.connected) return;
      const msg: Record<string, unknown> = { t: 'input', mi: this.mi };
      if (this.facing !== null) msg.facing = this.facing;
      this.ws!.send(JSON.stringify(msg));
    }, 50);

    // wait for the first snapshot so `look` works immediately
    for (let i = 0; i < 60 && !this.self; i++) await sleep(100);
    return `joined as ${charName} (${char.class} lv${char.level ?? this.self?.lv ?? '?'}) on ${this.base}`;
  }

  private connectWs(charId: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const wsUrl = this.base.replace(/^http/, 'ws') + '/ws';
      this.ws = new WebSocket(wsUrl);
      const to = setTimeout(() => reject(new Error('join timeout (10s)')), 10_000);
      this.ws.on('open', () => this.ws!.send(JSON.stringify({ t: 'auth', token: this.token, character: charId })));
      this.ws.on('message', (data) => {
        const msg = JSON.parse(String(data));
        if (msg.t === 'hello') { this.pid = msg.pid; clearTimeout(to); resolve(); }
        else if (msg.t === 'error') { clearTimeout(to); try { this.ws?.close(); } catch { /* */ } reject(new Error(msg.error)); }
        else if (msg.t === 'snap') {
          if (this.self) for (const k of DELTA_SELF_KEYS) if (!(k in msg.self)) msg.self[k] = this.self[k];
          this.self = msg.self;
          this.ents = new Map([[msg.self.id, msg.self], ...msg.ents.map((e: any) => [e.id, e])]);
        } else if (msg.t === 'events') {
          this.events.push(...msg.list);
          if (this.events.length > 300) this.events.splice(0, this.events.length - 300);
          // chat rides a separate unread buffer that piggybacks on EVERY tool
          // result — the agent can't miss a player talking to it mid-fight
          for (const ev of msg.list) {
            if (ev.type === 'chat' && ev.from !== this.charName) this.unreadChat.push(ev);
          }
          if (this.unreadChat.length > 50) this.unreadChat.splice(0, this.unreadChat.length - 50);
        }
      });
      this.ws.on('error', (err) => { clearTimeout(to); reject(err); });
      this.ws.on('close', () => { this.stopInput(); this.ws = null; });
    });
  }

  cmd(payload: Record<string, unknown>): void {
    if (!this.connected) throw new Error('not in world — call join_world first');
    this.ws!.send(JSON.stringify({ t: 'cmd', ...payload }));
  }

  private stopInput(): void {
    if (this.inputTimer) { clearInterval(this.inputTimer); this.inputTimer = null; }
  }

  stopMoving(): void {
    this.navigating = false;
    this.mi = { f: 0, b: 0, tl: 0, tr: 0, sl: 0, sr: 0, j: 0 };
  }

  // walk toward (x, z); resolves when within `range` yards or stuck/timeout
  async moveTo(x: number, z: number, range = 2): Promise<string> {
    if (!this.connected || !this.self) throw new Error('not in world');
    this.navigating = true;
    const start = Date.now();
    let lastPos = { x: this.self.x, z: this.self.z };
    let stuckSince = 0;
    while (this.navigating) {
      const me = this.self;
      const dx = x - me.x, dz = z - me.z;
      const dist = Math.hypot(dx, dz);
      if (dist <= range) { this.stopMoving(); return `arrived at (${me.x.toFixed(0)}, ${me.z.toFixed(0)}), ${dist.toFixed(1)}yd from goal`; }
      if (Date.now() - start > 60_000) { this.stopMoving(); return `gave up after 60s — still ${dist.toFixed(0)}yd away at (${me.x.toFixed(0)}, ${me.z.toFixed(0)})`; }
      // forward = (sin(facing), cos(facing)) in the sim
      this.facing = Math.atan2(dx, dz);
      this.mi.f = 1;
      // stuck? (cliff, building): jump, then strafe, then give up
      const moved = Math.hypot(me.x - lastPos.x, me.z - lastPos.z);
      if (moved < 0.3) {
        if (!stuckSince) stuckSince = Date.now();
        const stuckFor = Date.now() - stuckSince;
        this.mi.j = stuckFor > 1000 ? 1 : 0;
        this.mi.sl = stuckFor > 2500 ? 1 : 0;
        if (stuckFor > 8000) { this.stopMoving(); return `stuck at (${me.x.toFixed(0)}, ${me.z.toFixed(0)}) — path blocked, still ${dist.toFixed(0)}yd from goal; try a different route`; }
      } else { stuckSince = 0; this.mi.j = 0; this.mi.sl = 0; }
      lastPos = { x: me.x, z: me.z };
      await sleep(300);
    }
    return 'movement interrupted';
  }

  drainEvents(): any[] {
    const out = this.events;
    this.events = [];
    return out;
  }

  async leave(): Promise<void> {
    this.stopMoving();
    this.stopInput();
    if (this.ws) { try { this.ws.close(); } catch { /* already closing */ } this.ws = null; }
    this.self = null;
    this.ents.clear();
    this.pid = -1;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const game = new GameClient();

// ---------------------------------------------------------------------------
// Observations: semantic JSON + ASCII minimap (token-friendly "UI stream")
// ---------------------------------------------------------------------------

function compass(dx: number, dz: number): string {
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return dirs[Math.round(((Math.atan2(dx, dz) * 180) / Math.PI + 360) % 360 / 45) % 8];
}

function entityLine(e: any, me: any): string {
  const dist = Math.hypot(e.x - me.x, e.z - me.z);
  const bits = [
    `#${e.id}`, e.nm, `lv${e.lv}`, e.k,
    `${dist.toFixed(0)}yd ${compass(e.x - me.x, e.z - me.z)}`,
    `hp ${e.hp}/${e.mhp}`,
  ];
  if (e.h) bits.push('HOSTILE');
  if (e.dead) bits.push(e.loot ? 'dead+lootable' : 'dead');
  if (e.cast) bits.push(`casting ${e.cast}`);
  return bits.join(' | ');
}

function minimap(me: any, ents: Map<number, any>): string {
  const W = 21, H = 13, CELL = 5; // 105x65 yards, north (+z) up
  const grid = Array.from({ length: H }, () => Array(W).fill('.'));
  for (const e of ents.values()) {
    if (e.id === game.pid) continue;
    const col = Math.round((e.x - me.x) / CELL) + (W - 1) / 2;
    const row = (H - 1) / 2 - Math.round((e.z - me.z) / CELL);
    if (col < 0 || col >= W || row < 0 || row >= H) continue;
    const ch = e.k === 'npc' ? 'n' : e.k === 'player' ? 'P' : e.k === 'object' ? 'o'
      : e.dead ? (e.loot ? '$' : 'x') : e.h ? 'M' : 'm';
    grid[row][col] = ch;
  }
  grid[(H - 1) / 2][(W - 1) / 2] = '@';
  return [
    `minimap (1 cell = ${CELL}yd, north/+z up; @ you, M hostile, m passive, $ lootable, n npc, P player, o object):`,
    ...grid.map((r) => r.join('')),
  ].join('\n');
}

function buildLook(radius: number): string {
  const me = game.self;
  if (!me) throw new Error('not in world — call join_world first');
  const lines: string[] = [];
  const zone = zoneAt(me.z);
  lines.push(`== ${game.charName} | lv${me.lv} | hp ${me.hp}/${me.mhp}${me.mres ? ` | ${me.rtype ?? 'resource'} ${me.res}/${me.mres}` : ''} | pos (${me.x.toFixed(0)}, ${me.z.toFixed(0)}) | ${zone.name}${me.dead ? ' | DEAD — use release_spirit' : ''}`);
  if (me.tgt != null && game.ents.get(me.tgt)) lines.push(`target: ${entityLine(game.ents.get(me.tgt), me)}`);

  const near = [...game.ents.values()]
    .filter((e) => e.id !== game.pid && Math.hypot(e.x - me.x, e.z - me.z) <= radius)
    .sort((a, b) => Math.hypot(a.x - me.x, a.z - me.z) - Math.hypot(b.x - me.x, b.z - me.z))
    .slice(0, 25);
  lines.push('', `nearby (${near.length} within ${radius}yd):`);
  for (const e of near) lines.push('  ' + entityLine(e, me));

  const qlog = me.qlog ?? [];
  if (qlog.length) {
    lines.push('', 'quests:');
    for (const q of qlog) {
      const def = (QUESTS as any)[q.id];
      lines.push(`  ${q.id} "${def?.name ?? '?'}" — progress ${JSON.stringify(q.prog ?? q)}${q.done || q.complete ? ' READY TO TURN IN' : ''}`);
    }
  }
  const inv = me.inv ?? [];
  if (inv.length) {
    lines.push('', `bags: ${inv.map((s: any) => `${(ITEMS as any)[s.itemId]?.name ?? s.itemId}${s.count > 1 ? ` x${s.count}` : ''}`).join(', ')}`);
  }
  if (me.copper != null) lines.push(`money: ${Math.floor(me.copper / 10000)}g ${Math.floor((me.copper % 10000) / 100)}s ${me.copper % 100}c`);

  const evts = game.drainEvents();
  if (evts.length) {
    lines.push('', `events since last look (${evts.length}):`);
    for (const ev of evts.slice(-20)) lines.push('  ' + JSON.stringify(ev));
  }
  lines.push('', minimap(me, game.ents));
  return lines.join('\n');
}

function text(s: string) {
  // append unread player chat to every tool result so it's never missed
  if (game.unreadChat.length) {
    const lines = game.unreadChat.map((c) => `  ${c.from}${c.channel && c.channel !== 'say' ? ` [${c.channel}]` : ''}: ${c.text}`);
    game.unreadChat = [];
    s += `\n\n[players are talking — respond if it concerns you]\n${lines.join('\n')}`;
  }
  return { content: [{ type: 'text' as const, text: s }] };
}

// ---------------------------------------------------------------------------
// MCP tools
// ---------------------------------------------------------------------------

const server = new McpServer({ name: 'claudecraft', version: '0.1.0' });

server.tool(
  'join_world',
  'Join the live World of Claudecraft server as a character. Creates (and persists) an account + character on first use; reuses them afterwards, so your character keeps its progress between sessions.',
  {
    name: z.string().regex(/^[A-Za-z]{2,16}$/).describe('character name, 2-16 letters'),
    player_class: z.enum(['warrior', 'paladin', 'hunter', 'rogue', 'priest', 'shaman', 'mage', 'warlock', 'druid']).default('warrior'),
    server_url: z.string().default(DEFAULT_SERVER),
  },
  async ({ name, player_class, server_url }) => {
    // idempotent: if already living as this character, don't reconnect (a
    // destructive rejoin would race the duplicate-login guard and lock out) —
    // just hand back current state so a confused agent can't deadlock itself
    if (game.connected && game.charName.toLowerCase() === name.toLowerCase()) {
      return text(`already living as ${name} — you never left. here's where you are:\n\n` + buildLook(60));
    }
    const msg = await game.join(server_url, name, player_class);
    const memory = readMemory(game.base, name);
    const memBlock = memory
      ? `\n\nyour memory from past sessions:\n${memory.split('\n').slice(-40).join('\n')}`
      : '\n\n(no memories yet — use remember to keep notes about players and places)';
    const taskBlock = `\n\nyour open tasks:\n${tasksSummary(game.base, name)}`;
    return text(msg + memBlock + taskBlock + '\n\n' + buildLook(60));
  },
);

server.tool(
  'remember',
  'Save a note to your permanent memory for this character (who you met, what they said, places, promises, grudges). Recalled automatically on every join_world.',
  { note: z.string().max(500) },
  async ({ note }) => {
    if (!game.charName) return text('join a world first so memory has a character to belong to');
    appendMemory(game.base, game.charName, note);
    return text('remembered');
  },
);

server.tool(
  'recall',
  'Read your full permanent memory for this character.',
  {},
  async () => {
    if (!game.charName) return text('join a world first');
    const memory = readMemory(game.base, game.charName);
    return text(memory || '(no memories yet)');
  },
);

server.tool(
  'add_task',
  'Add a persistent goal to your task list (survives logouts; shown on every join_world). Use for quests to finish, levels to reach, promises made to players.',
  { task: z.string().max(300) },
  async ({ task }) => {
    if (!game.charName) return text('join a world first');
    const tasks = readTasks(game.base, game.charName);
    const id = (tasks[tasks.length - 1]?.id ?? 0) + 1;
    tasks.push({ id, text: task, done: false, added: new Date().toISOString().slice(0, 10) });
    writeTasks(game.base, game.charName, tasks);
    return text(`task #${id} added:\n${tasksSummary(game.base, game.charName)}`);
  },
);

server.tool(
  'complete_task',
  'Mark a task done by id.',
  { task_id: z.number() },
  async ({ task_id }) => {
    if (!game.charName) return text('join a world first');
    const tasks = readTasks(game.base, game.charName);
    const t = tasks.find((x) => x.id === task_id);
    if (!t) return text(`no task #${task_id}`);
    t.done = true;
    writeTasks(game.base, game.charName, tasks);
    return text(`task #${task_id} done. remaining:\n${tasksSummary(game.base, game.charName)}`);
  },
);

server.tool(
  'list_tasks',
  'List your open tasks (and recently completed ones).',
  {},
  async () => {
    if (!game.charName) return text('join a world first');
    const tasks = readTasks(game.base, game.charName);
    const done = tasks.filter((t) => t.done).slice(-5).map((t) => `  ✓ #${t.id} ${t.text}`);
    return text(`open:\n${tasksSummary(game.base, game.charName)}${done.length ? `\nrecently done:\n${done.join('\n')}` : ''}`);
  },
);

server.tool(
  'listen',
  'Wait and listen specifically for chat from players. Returns chat lines (and a count of other events) — the polite way to hold a conversation.',
  { seconds: z.number().min(1).max(30).default(8) },
  async ({ seconds }) => {
    await sleep(seconds * 1000);
    const evts = game.drainEvents();
    game.unreadChat = []; // listen displays chat itself; don't re-append via text()
    const chat = evts.filter((e) => e.type === 'chat');
    const lines = chat.map((c) => `${c.from}${c.channel && c.channel !== 'say' ? ` [${c.channel}]` : ''}: ${c.text}`);
    return text(lines.length
      ? `heard ${lines.length} chat line(s) (${evts.length - chat.length} other events):\n` + lines.join('\n')
      : `silence for ${seconds}s (${evts.length} non-chat events)`);
  },
);

server.tool(
  'look',
  'Observe the world: your stats, target, nearby entities with ids/distances, quests, bags, unread events/chat, and an ASCII minimap. Call this after acting to see what changed.',
  { radius: z.number().min(10).max(120).default(60) },
  async ({ radius }) => text(buildLook(radius)),
);

server.tool(
  'move_to',
  'Walk toward a position or entity. Blocks until you arrive (or get stuck / time out). Auto-jumps small obstacles.',
  {
    x: z.number().optional(), z: z.number().optional(),
    entity_id: z.number().optional().describe('walk to this entity instead of coordinates'),
    stop_at: z.number().min(1).max(30).default(2).describe('stop within this many yards'),
  },
  async ({ x, z: zz, entity_id, stop_at }) => {
    let gx = x, gz = zz;
    if (entity_id != null) {
      const e = game.ents.get(entity_id);
      if (!e) return text(`entity #${entity_id} not in view — use look first`);
      gx = e.x; gz = e.z;
    }
    if (gx == null || gz == null) return text('provide x+z or entity_id');
    return text(await game.moveTo(gx, gz, stop_at));
  },
);

server.tool(
  'attack',
  'Target an entity (or keep current target) and start auto-attacking. Use cast for abilities; use wait/look to follow the fight.',
  { entity_id: z.number().optional() },
  async ({ entity_id }) => {
    if (entity_id != null) game.cmd({ cmd: 'target', id: entity_id });
    game.cmd({ cmd: 'attack' });
    return text(`attacking${entity_id != null ? ` #${entity_id}` : ''} — use wait then look to follow the fight`);
  },
);

server.tool('stop_attack', 'Stop auto-attacking.', {}, async () => { game.cmd({ cmd: 'stopattack' }); return text('stopped attacking'); });

server.tool(
  'cast',
  'Cast an ability by action-bar slot (0-11, as the spellbook orders them) on your current target.',
  { slot: z.number().min(0).max(11) },
  async ({ slot }) => { game.cmd({ cmd: 'castSlot', slot }); return text(`cast slot ${slot} — look to see the result`); },
);

server.tool(
  'interact',
  'Interact with the nearest thing in range: talk to an NPC (opens their quests), loot a corpse, or pick up a quest object. Stand within ~4yd first (move_to with stop_at 3).',
  {},
  async () => { game.cmd({ cmd: 'interact' }); await sleep(400); return text('interacted\n\n' + buildLook(30)); },
);

server.tool(
  'loot',
  'Loot a specific dead mob by entity id (must be within ~4yd).',
  { entity_id: z.number() },
  async ({ entity_id }) => { game.cmd({ cmd: 'loot', id: entity_id }); await sleep(400); return text('loot attempted — events:\n' + game.drainEvents().map((e) => JSON.stringify(e)).join('\n')); },
);

server.tool(
  'quest',
  'Accept, turn in, or abandon a quest by id (quest ids appear in look and after interacting with NPCs).',
  { action: z.enum(['accept', 'turnin', 'abandon']), quest_id: z.string() },
  async ({ action, quest_id }) => {
    game.cmd({ cmd: action, quest: quest_id });
    await sleep(400);
    return text(`${action} ${quest_id} — events:\n` + game.drainEvents().map((e) => JSON.stringify(e)).join('\n'));
  },
);

server.tool(
  'say',
  'Say something in local chat. Prefix with /p to speak to your party.',
  { message: z.string().max(200) },
  async ({ message }) => { game.cmd({ cmd: 'chat', text: message }); return text(`said: ${message}`); },
);

server.tool(
  'use_item',
  'Use a consumable (eat/drink) or equip a weapon/armor piece from your bags, by item id (shown in look).',
  { item_id: z.string(), equip: z.boolean().default(false) },
  async ({ item_id, equip }) => { game.cmd({ cmd: equip ? 'equip' : 'use', item: item_id }); await sleep(300); return text(`${equip ? 'equipped' : 'used'} ${item_id}`); },
);

server.tool(
  'shop',
  'Buy from or sell to a vendor NPC. You must be near the vendor; npc_id is required for buying.',
  { action: z.enum(['buy', 'sell']), item_id: z.string(), npc_id: z.number().optional() },
  async ({ action, item_id, npc_id }) => {
    if (action === 'buy') game.cmd({ cmd: 'buy', npc: npc_id, item: item_id });
    else game.cmd({ cmd: 'sell', item: item_id });
    await sleep(300);
    return text(`${action} ${item_id} — events:\n` + game.drainEvents().map((e) => JSON.stringify(e)).join('\n'));
  },
);

server.tool(
  'party',
  'Party management: invite a player (entity_id), accept/decline a pending invite, or leave.',
  { action: z.enum(['invite', 'accept', 'decline', 'leave']), entity_id: z.number().optional() },
  async ({ action, entity_id }) => {
    const map: Record<string, Record<string, unknown>> = {
      invite: { cmd: 'pinvite', id: entity_id }, accept: { cmd: 'paccept' },
      decline: { cmd: 'pdecline' }, leave: { cmd: 'pleave' },
    };
    game.cmd(map[action]);
    return text(`party ${action} sent`);
  },
);

server.tool(
  'wait',
  'Wait and watch for a few seconds (combat ticks, mob movement, chat), then return everything that happened.',
  { seconds: z.number().min(1).max(15).default(3) },
  async ({ seconds }) => {
    await sleep(seconds * 1000);
    const evts = game.drainEvents();
    return text(`${evts.length} events in ${seconds}s:\n` + evts.slice(-40).map((e) => JSON.stringify(e)).join('\n'));
  },
);

server.tool('release_spirit', 'When dead: release to the graveyard to respawn.', {}, async () => {
  game.cmd({ cmd: 'release' });
  await sleep(500);
  return text('released\n\n' + buildLook(40));
});

server.tool('leave_world', 'Log out cleanly (character is saved server-side).', {}, async () => {
  await game.leave();
  return text('left the world — join_world to come back');
});

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
  console.error(`claudecraft MCP server ready (default server: ${DEFAULT_SERVER})`);
}

void main();
