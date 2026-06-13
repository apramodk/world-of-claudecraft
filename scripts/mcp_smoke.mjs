// Smoke test for the claudecraft MCP server: speaks JSON-RPC over stdio like
// a real MCP client — join the live world, look around, say hi, log out.
//   node scripts/mcp_smoke.mjs   (SERVER_URL env to override target server)
import { spawn } from 'node:child_process';

const proc = spawn(process.execPath, ['dist-mcp/claudecraft-mcp.mjs'], {
  stdio: ['pipe', 'pipe', 'inherit'],
  env: process.env,
});

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

let nextId = 1;
function rpc(method, params) {
  const id = nextId++;
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`${method} timed out`)); } }, 90_000);
  });
}
const call = async (name, args = {}) => {
  const res = await rpc('tools/call', { name, arguments: args });
  const text = res.result?.content?.[0]?.text ?? JSON.stringify(res);
  console.log(`\n=== ${name} ===\n${text.slice(0, 1800)}`);
  return text;
};

const init = await rpc('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'smoke', version: '0' },
});
console.log('initialized:', init.result.serverInfo.name);
proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

const tools = await rpc('tools/list', {});
console.log('tools:', tools.result.tools.map((t) => t.name).join(', '));

await call('join_world', { name: 'Clauderick', player_class: 'warrior' });
await call('say', { message: 'Hello! I am an AI agent playing through MCP. o/' });
await call('wait', { seconds: 3 });
await call('look', { radius: 50 });
await call('leave_world');
proc.kill();
console.log('\nSMOKE OK');
process.exit(0);
