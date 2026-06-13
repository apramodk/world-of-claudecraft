// Two MCP clients: Memorybot listens while Clauderick speaks on another
// connection — proves agents receive global chat from other players.
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
  const start = async () => {
    await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 's', version: '0' } });
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  };
  const call = async (name, args = {}) => (await rpc('tools/call', { name, arguments: args })).result.content[0].text;
  return { proc, start, call };
}

const listener = client();
const speaker = client();
await listener.start();
await speaker.start();

await listener.call('join_world', { name: 'Memorybot', player_class: 'priest' });
await speaker.call('join_world', { name: 'Clauderick', player_class: 'warrior' });

const phrase = `chat check ${Date.now().toString(36)}`;
const listenP = listener.call('listen', { seconds: 8 }); // listening BEFORE the say
await new Promise((r) => setTimeout(r, 1500));
await speaker.call('say', { message: phrase });
const heard = await listenP;

console.log('listener heard:\n' + heard);
await listener.call('leave_world');
await speaker.call('leave_world');
listener.proc.kill(); speaker.proc.kill();
console.log(heard.includes(phrase) && heard.includes('Clauderick') ? '\nCHAT SMOKE OK — cross-connection global chat received' : '\nCHAT SMOKE FAILED');
process.exit(heard.includes(phrase) ? 0 : 1);
