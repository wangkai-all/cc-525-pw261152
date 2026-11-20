import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../src/store.ts';
import { FakeClock } from './helpers.ts';
import { RevisionService } from '../src/service.ts';
import { AppError } from '../src/errors.ts';
import {
  diffCells,
  impactAnalysis,
  materializeReport,
  metricMap,
  dataMap,
} from '../src/domain.ts';

function makeService() {
  const clock = new FakeClock();
  const store = createMemoryStore();
  const service = new RevisionService(store, clock);
  const users = Object.fromEntries(store.db.users.map((u) => [u.role, u]));
  return { clock, store, service, users };
}

const caliberChange = (reason = '收入确认口径由发货改为签收') => ({
  kind: 'METRIC_CALIBER' as const,
  metricId: 'M-00001',
  newCaliber: '按签收确认收入（不含税）',
  newMultiplier: 1.1,
  reason,
});

const dataChange = () => ({
  kind: 'SOURCE_DATA' as const,
  dataId: 'SD-00001',
  periodValues: { '2026-Q1': 1100, '2026-Q2': 1320 },
  reason: '财务补录修正收入原始数据',
});

test('materialization: cells = raw value × metric multiplier', () => {
  const { store } = makeService();
  const report = store.db.reports[0]!;
  const cells = materializeReport(report, metricMap(store.db), dataMap(store.db));
  const revQ1 = cells.find((c) => c.metricId === 'M-00001' && c.period === '2026-Q1')!;
  assert.equal(revQ1.rawValue, 1000);
  assert.equal(revQ1.value, 1000);
});

test('diff: detects changed cells and computes delta / pct', () => {
  const diffs = diffCells(
    [
      { metricId: 'M-00001', period: '2026-Q1', rawValue: 1000, value: 1000 },
      { metricId: 'M-00002', period: '2026-Q1', rawValue: 300, value: 300 },
    ],
    [
      { metricId: 'M-00001', period: '2026-Q1', rawValue: 1000, value: 1100 },
      { metricId: 'M-00002', period: '2026-Q1', rawValue: 300, value: 300 },
    ],
  );
  assert.equal(diffs.length, 1);
  assert.equal(diffs[0]!.delta, 100);
  assert.equal(diffs[0]!.pct, 10);
});

test('diff: zero old value yields null pct instead of Infinity', () => {
  const diffs = diffCells(
    [{ metricId: 'M-00003', period: '2026-Q1', rawValue: 0, value: 0 }],
    [{ metricId: 'M-00003', period: '2026-Q1', rawValue: 50, value: 50 }],
  );
  assert.equal(diffs[0]!.pct, null);
});

test('impact analysis: caliber change of M-00001 hits only reports containing it', () => {
  const { store } = makeService();
  const analysis = impactAnalysis(store.db, caliberChange());
  assert.deepEqual(analysis.impactedReportIds.sort(), ['R-00001', 'R-00002']);
  const first = analysis.impacted.find((i) => i.reportId === 'R-00002')!;
  // two periods × revenue cells only (gross profit untouched)
  assert.equal(first.diffPreview.length, 2);
  assert.equal(first.diffPreview[0]!.newValue, 1100);
});

test('impact analysis: source data change propagates through multiplier', () => {
  const { store } = makeService();
  const analysis = impactAnalysis(store.db, dataChange());
  assert.ok(analysis.impactedReportIds.includes('R-00001'));
  assert.ok(analysis.impactedReportIds.includes('R-00002'));
  assert.ok(!analysis.impactedReportIds.includes('R-00003'));
  const r1 = analysis.impacted.find((i) => i.reportId === 'R-00001')!;
  const q2 = r1.diffPreview.find((d) => d.period === '2026-Q2' && d.metricId === 'M-00001')!;
  assert.equal(q2.oldValue, 1200);
  assert.equal(q2.newValue, 1320);
  assert.equal(q2.delta, 120);
});

test('impact analysis: no-op change produces empty impact list', () => {
  const { store } = makeService();
  const analysis = impactAnalysis(store.db, {
    kind: 'METRIC_CALIBER',
    metricId: 'M-00001',
    newCaliber: store.db.metrics[0]!.caliber,
    newMultiplier: 1,
    reason: '无实际变化',
  });
  assert.equal(analysis.impacted.length, 0);
});

test('creating revisions requires a reason and opens one draft per impacted report', () => {
  const { service, users } = makeService();
  assert.throws(
    () => service.createRevisions(users.analyst, { ...caliberChange('') }),
    (e: unknown) => e instanceof AppError && e.status === 400,
  );
  const revs = service.createRevisions(users.analyst, caliberChange());
  assert.equal(revs.length, 2);
  assert.ok(revs.every((r) => r.status === 'DRAFT'));
  assert.ok(revs.every((r) => r.changeGroupId === revs[0]!.changeGroupId));
  // every revision knows the full impacted report list
  assert.deepEqual([...new Set(revs.flatMap((r) => r.impactedReportIds))].sort(), [
    'R-00001',
    'R-00002',
  ]);
});

test('full happy path: draft → submit → approve → publish creates immutable V2', () => {
  const { service, store, users } = makeService();
  const [rev] = service.createRevisions(users.analyst, caliberChange());

  service.submitRevision(users.analyst, rev.id);
  let stored = service.getRevision(users.viewer, rev.id);
  assert.equal(stored.status, 'SUBMITTED');
  assert.equal(stored.tasks.length, 1);
  assert.equal(stored.tasks[0]!.status, 'PENDING');

  const taskId = stored.tasks[0]!.id;
  service.decideReview(users.reviewer, taskId, 'APPROVED', '口径调整合理');
  stored = service.getRevision(users.viewer, rev.id);
  assert.equal(stored.status, 'APPROVED');
  assert.ok(stored.approval);

  const beforeCount = store.db.versions.filter((v) => v.reportId === rev.reportId).length;
  const version = service.publishRevision(users.admin, rev.id);
  assert.equal(version.versionNo, 2);
  assert.equal(version.source, 'PUBLISH');
  assert.equal(version.revisionId, rev.id);
  const after = store.db.versions.filter((v) => v.reportId === rev.reportId);
  assert.equal(after.length, beforeCount + 1);

  // master metric definition only changes at publish time
  const metric = store.db.metrics.find((m) => m.id === 'M-00001')!;
  assert.equal(metric.multiplier, 1.1);
  assert.equal(metric.version, 2);

  // published version snapshot must equal the reviewed proposed snapshot
  const finalRev = service.getRevision(users.viewer, rev.id);
  assert.equal(finalRev.status, 'PUBLISHED');
  assert.deepEqual(version.snapshot, finalRev.proposedSnapshot);

  // V1 is untouched (immutability)
  const v1 = after.find((v) => v.versionNo === 1)!;
  const revCell = v1.snapshot.find((c) => c.metricId === 'M-00001' && c.period === '2026-Q1')!;
  assert.equal(revCell.value, 1000);
});

test('published version cannot be overwritten: re-publish and re-approve are rejected', () => {
  const { service, users } = makeService();
  const [rev] = service.createRevisions(users.analyst, caliberChange());
  service.submitRevision(users.analyst, rev.id);
  const task = service.getRevision(users.reviewer, rev.id).tasks[0]!;
  service.decideReview(users.reviewer, task.id, 'APPROVED');
  service.publishRevision(users.admin, rev.id);

  assert.throws(
    () => service.publishRevision(users.admin, rev.id),
    (e: unknown) => e instanceof AppError && e.code === 'IMMUTABLE_VERSION',
  );
  // task is finished and cannot be decided again
  assert.throws(
    () => service.decideReview(users.reviewer, task.id, 'APPROVED'),
    (e: unknown) => e instanceof AppError && e.status === 409,
  );
});

test('rejection ends the revision and blocks publishing', () => {
  const { service, users } = makeService();
  const [rev] = service.createRevisions(users.analyst, caliberChange());
  service.submitRevision(users.analyst, rev.id);
  const task = service.getRevision(users.reviewer, rev.id).tasks[0]!;
  service.decideReview(users.reviewer, task.id, 'REJECTED', '依据不足');
  assert.equal(service.getRevision(users.viewer, rev.id).status, 'REJECTED');
  assert.throws(
    () => service.publishRevision(users.admin, rev.id),
    (e: unknown) => e instanceof AppError && e.status === 409,
  );
});

test('cancel withdraws the revision and cancels pending review tasks', () => {
  const { service, users } = makeService();
  const [rev] = service.createRevisions(users.analyst, caliberChange());
  service.submitRevision(users.analyst, rev.id);
  service.cancelRevision(users.analyst, rev.id, '需求取消');
  const view = service.getRevision(users.viewer, rev.id);
  assert.equal(view.status, 'CANCELLED');
  assert.ok(view.tasks.every((t) => t.status === 'CANCELLED'));
});

test('rollback publishes the target snapshot as a new immutable version', () => {
  const { service, store, users } = makeService();
  const [rev] = service.createRevisions(users.analyst, caliberChange());
  service.submitRevision(users.analyst, rev.id);
  const task = service.getRevision(users.reviewer, rev.id).tasks[0]!;
  service.decideReview(users.reviewer, task.id, 'APPROVED');
  const v2 = service.publishRevision(users.admin, rev.id);

  // open revisions block rollback
  const [rev2] = service.createRevisions(users.analyst, dataChange());
  assert.throws(
    () => service.rollback(users.admin, rev2.reportId, v2.id, '测试回滚'),
    (e: unknown) => e instanceof AppError && e.status === 409,
  );
  service.cancelRevision(users.admin, rev2.id);

  const v1 = store.db.versions.find((v) => v.reportId === rev.reportId && v.versionNo === 1)!;
  const v3 = service.rollback(users.admin, rev.reportId, v1.id, '新口径核算错误，恢复原口径');
  assert.equal(v3.versionNo, 3);
  assert.equal(v3.source, 'ROLLBACK');
  assert.equal(v3.rolledBackFrom, v1.id);
  assert.deepEqual(v3.snapshot, v1.snapshot);
  // history still intact: V1 and V2 remain
  const all = store.db.versions.filter((v) => v.reportId === rev.reportId);
  assert.deepEqual(all.map((v) => v.versionNo), [1, 2, 3]);

  // rollback requires a reason
  assert.throws(
    () => service.rollback(users.admin, rev.reportId, v1.id, '  '),
    (e: unknown) => e instanceof AppError && e.status === 400,
  );
});

test('baseline guard: revision based on an outdated version cannot be published', () => {
  const { service, users } = makeService();
  // first change publishes V2
  const [revA] = service.createRevisions(users.analyst, dataChange());
  service.submitRevision(users.analyst, revA.id);
  const taskA = service.getRevision(users.reviewer, revA.id).tasks[0]!;
  service.decideReview(users.reviewer, taskA.id, 'APPROVED');
  service.publishRevision(users.admin, revA.id);

  // second revision targeting the same report with an older baseline
  const changeB = {
    kind: 'METRIC_CALIBER' as const,
    metricId: 'M-00002',
    newCaliber: '毛利口径修订（扣除运费）',
    newMultiplier: 0.95,
    reason: '毛利口径二次调整',
  };
  const drafts = service.createRevisions(users.analyst, changeB);
  const revB = drafts.find((d) => d.reportId === revA.reportId)!;
  // simulate stale baseline by pointing it at V1 while latest is V2
  revB.baseVersionId = service
    .getReport(users.admin, revA.reportId)
    .versions.find((v) => v.versionNo === 1)!.id;
  service.submitRevision(users.analyst, revB.id);
  const taskB = service.getRevision(users.reviewer, revB.id).tasks[0]!;
  service.decideReview(users.reviewer, taskB.id, 'APPROVED');
  assert.throws(
    () => service.publishRevision(users.admin, revB.id),
    (e: unknown) => e instanceof AppError && e.status === 409 && /基线/.test(e.message),
  );
});
