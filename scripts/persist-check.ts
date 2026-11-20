import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';

const DB = '/tmp/persist-restart.json';
rmSync(DB, { force: true });

function start(port) {
  return new Promise((resolve, reject) => {
    const p = spawn('node', ['src/server.ts'], {
      env: { ...process.env, DATA_FILE: DB, PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    p.stderr.on('data', (d) => reject(new Error(d.toString())));
    p.stdout.on('data', (d) => {
      if (d.toString().includes('已启动')) resolve(p);
    });
    setTimeout(() => reject(new Error('startup timeout')), 4000);
  });
}

async function login(port, userId) {
  const r = await fetch(`http://localhost:${port}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId }),
  });
  return (await r.json()).sessionId;
}

// 1. first process: analyst creates a revision
const p1 = await start(3106);
const analyst = await login(3106, 'u-00002');
const create = await fetch('http://localhost:3106/api/revisions', {
  method: 'POST',
  headers: { 'x-session-id': analyst, 'content-type': 'application/json' },
  body: JSON.stringify({
    kind: 'SOURCE_DATA',
    dataId: 'SD-00002',
    periodValues: { '2026-Q1': 330 },
    reason: '持久化重启验证',
  }),
});
const revs = await create.json();
console.log('before restart: created', revs.length, 'revisions; first id', revs[0].id);
p1.kill('SIGTERM');
await new Promise((r) => p1.on('exit', r));
await new Promise((r) => setTimeout(r, 300));

// 2. second process on the same data file: viewer reads the revision back
const p2 = await start(3107);
const viewer = await login(3107, 'u-00004');
const after = await (await fetch('http://localhost:3107/api/revisions', {
  headers: { 'x-session-id': viewer },
})).json();
const match = after.find((r) => r.reason === '持久化重启验证');
console.log('after restart: revisions =', after.length, '| survived =', Boolean(match), '| status =', match?.status);

// 3. id sequence continues (no id collision)
const analyst2 = await login(3107, 'u-00002');
const second = await (await fetch('http://localhost:3107/api/revisions', {
  method: 'POST',
  headers: { 'x-session-id': analyst2, 'content-type': 'application/json' },
  body: JSON.stringify({
    kind: 'SOURCE_DATA',
    dataId: 'SD-00003',
    periodValues: { '2026-Q2': 900 },
    reason: '重启后再次变更',
  }),
})).json();
console.log('new revision ids after restart:', second.map((r) => r.id).join(','));
const ids = new Set([...revs.map((r) => r.id), ...second.map((r) => r.id)]);
console.log('no id collisions:', ids.size === revs.length + second.length);
p2.kill('SIGTERM');
await new Promise((r) => p2.on('exit', r));

if (!match || ids.size !== revs.length + second.length) process.exit(1);
