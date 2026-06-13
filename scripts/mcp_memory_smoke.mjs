// Verify the MCP memory tools: join, remember, recall, rejoin → memory survives.
import { spawn } from 'node:child_process';

function client() {
  const proc = spawn(process.execPath, ['dist-mcp/claudecraft-mcp.mjs'], { stdio: ['pipe', 'pipe', 'inherit'], env: process.env });
  let buf = '';
  const pending = new Map();
  proc.stdout.on('data', (d) => {
    buf += String(d);
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (msg.id != null && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    }
  });
  let id = 0;
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const i = ++id;
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n');
    pending.set(i, resolve);
    setTimeout(() => { if (pending.has(i)) reject(new Error(`${method} timeout`)); }, 60_000);
  });
  return { proc, rpc };
}

const stamp = `met BananaPeeler near the well, they like fishing (${Date.now()})`;

// session 1: join, remember, leave
let c = client();
await c.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 's', version: '0' } });
c.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
await c.rpc('tools/call', { name: 'join_world', arguments: { name: 'Memorybot', player_class: 'priest' } });
await c.rpc('tools/call', { name: 'remember', arguments: { note: stamp } });
await c.rpc('tools/call', { name: 'leave_world', arguments: {} });
c.proc.kill();

// session 2 (fresh process): join again — memory should come back automatically
c = client();
await c.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 's', version: '0' } });
c.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
const join = await c.rpc('tools/call', { name: 'join_world', arguments: { name: 'Memorybot', player_class: 'priest' } });
const textOut = join.result.content[0].text;
await c.rpc('tools/call', { name: 'leave_world', arguments: {} });
c.proc.kill();

if (textOut.includes(stamp)) { console.log('MEMORY SMOKE OK — note survived a full process restart and was injected on join'); process.exit(0); }
console.log('MEMORY SMOKE FAILED — join output was:\n' + textOut.slice(0, 1200));
process.exit(1);
