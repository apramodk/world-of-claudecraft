// Filters `claude -p --output-format stream-json --verbose` into:
//   1. tmp/thoughts.ndjson — {at, kind: thought|action|result, text} per line,
//      consumed live by the stream overlay (mcp/overlay_server.mjs)
//   2. stdout — human-readable session log (redirect to resident_bot.log)
import * as fs from 'node:fs';
import * as readline from 'node:readline';

const OUT = 'tmp/thoughts.ndjson';
fs.mkdirSync('tmp', { recursive: true });

function emit(kind, text) {
  if (!text || !text.trim()) return;
  fs.appendFileSync(OUT, JSON.stringify({ at: Date.now(), kind, text: text.slice(0, 400) }) + '\n');
  console.log(`[${kind}] ${text.slice(0, 200)}`);
}

// keep the overlay file from growing unbounded
try {
  const lines = fs.readFileSync(OUT, 'utf-8').trim().split('\n');
  if (lines.length > 500) fs.writeFileSync(OUT, lines.slice(-200).join('\n') + '\n');
} catch { /* fresh file */ }

const TOOL_VERBS = {
  join_world: (i) => `entering the world as ${i.name ?? '?'}…`,
  look: () => 'looking around…',
  move_to: (i) => i.entity_id != null ? `walking to #${i.entity_id}…` : `walking to (${i.x}, ${i.z})…`,
  attack: (i) => i.entity_id != null ? `attacking #${i.entity_id}!` : 'attacking!',
  stop_attack: () => 'backing off',
  cast: (i) => `casting (slot ${i.slot})`,
  interact: () => 'interacting…',
  loot: (i) => `looting #${i.entity_id}`,
  quest: (i) => `quest ${i.action}: ${i.quest_id}`,
  say: (i) => `💬 "${i.message}"`,
  listen: () => 'listening for players…',
  use_item: (i) => `${i.equip ? 'equipping' : 'using'} ${i.item_id}`,
  shop: (i) => `${i.action}ing ${i.item_id}`,
  party: (i) => `party: ${i.action}`,
  wait: (i) => `watching the world (${i.seconds ?? 3}s)…`,
  remember: (i) => `📝 noting: ${i.note}`,
  recall: () => 'recalling memories…',
  add_task: (i) => `🎯 new goal: ${i.task}`,
  complete_task: (i) => `✅ finished task #${i.task_id}`,
  list_tasks: () => 'reviewing goals…',
  release_spirit: () => '👻 releasing spirit…',
  leave_world: () => 'logging out — see you next time',
};

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.type === 'assistant') {
    for (const block of msg.message?.content ?? []) {
      if (block.type === 'text') emit('thought', block.text);
      else if (block.type === 'tool_use' && block.name.startsWith('mcp__claudecraft__')) {
        // only game actions reach the stream — skip claude's internal tools
        const name = block.name.replace(/^mcp__claudecraft__/, '');
        const verb = TOOL_VERBS[name];
        emit('action', verb ? verb(block.input ?? {}) : name);
      }
    }
  } else if (msg.type === 'result') {
    emit('result', msg.result ?? `session ended (${msg.subtype ?? 'done'})`);
  }
});
