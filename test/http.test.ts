import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createMemoryStore } from '../src/store.ts';
import { createApp } from '../src/server.ts';
import { FakeClock } from './helpers.ts';

let base: string;
const sessions: Record<string, string> = {};
let server: ReturnType<typeof createApp>['server'];

before(async () => {
  const store = createMemoryStore();
  const app = createApp(store, new FakeClock());
  server = app.server;
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;

  for (const role of ['admin', 'analyst', 'reviewer', 'viewer']) {
    const userId = { admin: 'u-00001', analyst: 'u-00002', reviewer: 'u-00003', viewer: 'u-00004' }[role]!;
    const res = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId }),
    });
    assert.equal(res.status, 201);
    sessions[role] = (await res.json()).sessionId;
  }
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function call(role: string, path: string, opts: RequestInit = {}) {
  return fetch(`${base}/api${path}`, {
    ...opts,
    headers: {
      ...(opts.headers || {}),
      'x-session-id': sessions[role]!,
      ...(opts.body ? { 'content-type': 'application/json' } : {}),
    },
  });
}

test('HTTP: unauthenticated and bad session return 401', async () => {
  const r1 = await fetch(`${base}/api/reports`);
  assert.equal(r1.status, 401);
  const r2 = await fetch(`${base}/api/reports`, { headers: { 'x-session-id': 'nope' } });
  assert.equal(r2.status, 401);
});

test('HTTP: full revision flow through the API incl. 403 enforcement', async () => {
  // viewer cannot preview
  const denied = await call('viewer', '/changes/preview', {
    method: 'POST',
    body: JSON.stringify({
      kind: 'METRIC_CALIBER',
      metricId: 'M-00001',
      newCaliber: '签收口径',
      newMultiplier: 1.1,
      reason: '口径调整',
    }),
  });
  assert.equal(denied.status, 403);

  // analyst previews and creates revisions
  const change = {
    kind: 'METRIC_CALIBER',
    metricId: 'M-00001',
    newCaliber: '按签收确认收入（不含税）',
    newMultiplier: 1.1,
    reason: '收入确认口径由发货改为签收',
  };
  const previewRes = await call('analyst', '/changes/preview', { method: 'POST', body: JSON.stringify(change) });
  assert.equal(previewRes.status, 200);
  const preview = await previewRes.json();
  assert.ok(preview.impacted.length >= 2);

  const createRes = await call('analyst', '/revisions', { method: 'POST', body: JSON.stringify(change) });
  assert.equal(createRes.status, 201);
  const revs = await createRes.json();
  const rev = revs[0]!;

  // missing reason → 400
  const bad = await call('analyst', '/revisions', {
    method: 'POST',
    body: JSON.stringify({ ...change, reason: '' }),
  });
  assert.equal(bad.status, 400);

  // submit
  const submitRes = await call('analyst', `/revisions/${rev.id}/submit`, { method: 'POST' });
  assert.equal(submitRes.status, 200);

  // analyst cannot decide
  const tasksRes = await call('reviewer', '/review-tasks?status=PENDING');
  const tasks = await tasksRes.json();
  const task = tasks.find((t: { revisionId: string }) => t.revisionId === rev.id)!;
  const forbidden = await call('analyst', `/review-tasks/${task.id}/decision`, {
    method: 'POST',
    body: JSON.stringify({ decision: 'APPROVED' }),
  });
  assert.equal(forbidden.status, 403);

  // reviewer approves
  const decideRes = await call('reviewer', `/review-tasks/${task.id}/decision`, {
    method: 'POST',
    body: JSON.stringify({ decision: 'APPROVED', comment: '同意' }),
  });
  assert.equal(decideRes.status, 200);

  // reviewer cannot publish; admin can
  const pubDenied = await call('reviewer', `/revisions/${rev.id}/publish`, { method: 'POST' });
  assert.equal(pubDenied.status, 403);
  const pubRes = await call('admin', `/revisions/${rev.id}/publish`, { method: 'POST' });
  assert.equal(pubRes.status, 201);
  const version = await pubRes.json();
  assert.equal(version.versionNo, 2);

  // immutable: second publish rejected
  const again = await call('admin', `/revisions/${rev.id}/publish`, { method: 'POST' });
  assert.equal(again.status, 409);
  const againBody = await again.json();
  assert.equal(againBody.error.code, 'IMMUTABLE_VERSION');
});

test('HTTP: rollback endpoint creates a new version and notifies', async () => {
  // create + publish one revision first
  const change = {
    kind: 'SOURCE_DATA',
    dataId: 'SD-00003',
    periodValues: { '2026-Q1': 650 },
    reason: '成本数据修正',
  };
  const created = await (await call('analyst', '/revisions', { method: 'POST', body: JSON.stringify(change) })).json();
  const rev = created.find((r: { reportId: string }) => r.reportId === 'R-00003')!;
  await call('analyst', `/revisions/${rev.id}/submit`, { method: 'POST' });
  const tasks = await (await call('reviewer', '/review-tasks?status=PENDING')).json();
  const task = tasks.find((t: { revisionId: string }) => t.revisionId === rev.id)!;
  await call('reviewer', `/review-tasks/${task.id}/decision`, {
    method: 'POST',
    body: JSON.stringify({ decision: 'APPROVED' }),
  });
  const v2 = await (await call('admin', `/revisions/${rev.id}/publish`, { method: 'POST' })).json();

  const detailBefore = await (await call('viewer', `/reports/R-00003`)).json();
  assert.equal(detailBefore.versions.length, 2);

  const rb = await call('admin', '/reports/R-00003/rollback', {
    method: 'POST',
    body: JSON.stringify({
      targetVersionId: detailBefore.versions.find((v: { versionNo: number }) => v.versionNo === 1).id,
      reason: '验证回滚',
    }),
  });
  assert.equal(rb.status, 201);
  const rbBody = await rb.json();
  assert.equal(rbBody.versionNo, 3);
  assert.equal(rbBody.source, 'ROLLBACK');
  assert.equal(rbBody.rolledBackFrom !== undefined, true);
  void v2;

  const detailAfter = await (await call('viewer', '/reports/R-00003')).json();
  assert.deepEqual(detailAfter.versions.map((v: { versionNo: number }) => v.versionNo), [1, 2, 3]);
  // rollback without reason → 400
  const noReason = await call('admin', '/reports/R-00003/rollback', {
    method: 'POST',
    body: JSON.stringify({ targetVersionId: detailAfter.versions[0].id, reason: '' }),
  });
  assert.equal(noReason.status, 400);
});

test('HTTP: reminders suppress duplicate notifications (row count stable, dupCount grows)', async () => {
  const change = {
    kind: 'SOURCE_DATA',
    dataId: 'SD-00002',
    periodValues: { '2026-Q2': 400 },
    reason: '毛利数据重报',
  };
  const created = await (await call('analyst', '/revisions', { method: 'POST', body: JSON.stringify(change) })).json();
  const rev = created[0]!;
  await call('analyst', `/revisions/${rev.id}/submit`, { method: 'POST' });

  const before = await (await call('admin', '/notifications')).json();
  const remind1 = await call('analyst', `/revisions/${rev.id}/remind`, { method: 'POST' });
  assert.equal(remind1.status, 200);
  const r1 = await remind1.json();
  assert.equal(r1.delivered, 0);
  assert.ok(r1.suppressedDuplicates > 0);

  const after = await (await call('admin', '/notifications')).json();
  assert.equal(after.length, before.length); // no duplicate rows created
  const dups = after.reduce((acc: number, n: { dupCount: number }) => acc + n.dupCount, 0);
  assert.ok(dups > 0);
});

test('HTTP: static frontend is served and unknown API routes 404', async () => {
  const index = await fetch(`${base}/`);
  assert.equal(index.status, 200);
  assert.match(await index.text(), /管理报表修订平台/);
  const js = await fetch(`${base}/app.js`);
  assert.equal(js.status, 200);
  const nope = await call('admin', '/nope');
  assert.equal(nope.status, 404);
});

test('HTTP: audit log is admin-only and records the workflow', async () => {
  const denied = await call('viewer', '/audit');
  assert.equal(denied.status, 403);
  const ok = await call('admin', '/audit');
  assert.equal(ok.status, 200);
  const events = await ok.json();
  const actions = new Set(events.map((e: { action: string }) => e.action));
  for (const a of ['REVISION_CREATE', 'REVISION_SUBMIT', 'REVIEW_APPROVE', 'REVISION_PUBLISH', 'REPORT_ROLLBACK']) {
    assert.ok(actions.has(a), `审计缺少动作 ${a}`);
  }
});
