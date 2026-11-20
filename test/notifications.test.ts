import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../src/store.ts';
import { FakeClock } from './helpers.ts';
import { RevisionService } from '../src/service.ts';
import { AppError } from '../src/errors.ts';
import { deliver, dedupKeyOf } from '../src/notification.ts';

function makeService() {
  const clock = new FakeClock();
  const store = createMemoryStore();
  const service = new RevisionService(store, clock);
  const users = Object.fromEntries(store.db.users.map((u) => [u.role, u]));
  return { clock, store, service, users };
}

const caliberChange = () => ({
  kind: 'METRIC_CALIBER' as const,
  metricId: 'M-00001',
  newCaliber: '按签收确认收入（不含税）',
  newMultiplier: 1.1,
  reason: '收入确认口径调整',
});

test('notification dedup: identical key is suppressed and counted, distinct key delivered', () => {
  const { store, clock } = makeService();
  const base = {
    recipient: 'u-00003',
    channel: 'SITE' as const,
    eventType: 'REVIEW_ASSIGNED' as const,
    entityType: 'REVIEW_TASK' as const,
    entityId: 'TASK-00001',
    title: '第一次',
  };
  const first = deliver(store.db, clock, base);
  assert.equal(first.delivered, true);

  const second = deliver(store.db, clock, { ...base, title: '重复发送，标题不同也合并' });
  assert.equal(second.delivered, false);
  assert.equal(second.notification.dupCount, 1);
  assert.equal(second.notification.title, '第一次'); // original row untouched

  const third = deliver(store.db, clock, base);
  assert.equal(third.notification.dupCount, 2);
  assert.equal(store.db.notifications.length, 1);

  const otherChannel = deliver(store.db, clock, { ...base, channel: 'EMAIL' });
  assert.equal(otherChannel.delivered, true);
  assert.notEqual(dedupKeyOf(base), dedupKeyOf({ ...base, channel: 'EMAIL' }));
});

test('workflow notifications: submit emits one review-assigned per channel, remind only increments dupCount', () => {
  const { service, store, users } = makeService();
  const [rev] = service.createRevisions(users.analyst, caliberChange());
  service.submitRevision(users.analyst, rev.id);
  const task = service.getRevision(users.reviewer, rev.id).tasks[0]!;

  const reviewer = users.reviewer;
  const initial = store.db.notifications.filter(
    (n) => n.recipient === reviewer.id && n.eventType === 'REVIEW_ASSIGNED' && n.entityId === task.id,
  );
  // reviewer has SITE + EMAIL channels → exactly 2 rows
  assert.equal(initial.length, 2);
  assert.ok(initial.every((n) => n.dupCount === 0));

  const result = service.remindReviewers(users.analyst, rev.id);
  assert.equal(result.delivered, 0);
  assert.ok(result.suppressedDuplicates > 0);
  const after = store.db.notifications.filter(
    (n) => n.recipient === reviewer.id && n.eventType === 'REVIEW_ASSIGNED' && n.entityId === task.id,
  );
  assert.equal(after.length, 2); // no new rows
  assert.ok(after.every((n) => n.dupCount === 1));

  // second reminder keeps counting
  service.remindReviewers(users.analyst, rev.id);
  const twice = store.db.notifications.filter(
    (n) => n.recipient === reviewer.id && n.eventType === 'REVIEW_ASSIGNED' && n.entityId === task.id,
  );
  assert.ok(twice.every((n) => n.dupCount === 2));
});

test('notifications cover submit / approve / publish / rollback lifecycle events', () => {
  const { service, store, users } = makeService();
  const [rev] = service.createRevisions(users.analyst, caliberChange());
  service.submitRevision(users.analyst, rev.id);
  const task = service.getRevision(users.reviewer, rev.id).tasks[0]!;
  service.decideReview(users.reviewer, task.id, 'APPROVED');
  const v2 = service.publishRevision(users.admin, rev.id);
  const v1 = store.db.versions.find((v) => v.reportId === rev.reportId && v.versionNo === 1)!;
  service.rollback(users.admin, rev.reportId, v1.id, '回滚验证');
  void v2;

  const types = new Set(store.db.notifications.map((n) => n.eventType));
  for (const t of [
    'REVISION_SUBMITTED',
    'REVIEW_ASSIGNED',
    'REVISION_APPROVED',
    'REVISION_PUBLISHED',
    'REPORT_ROLLBACK',
  ]) {
    assert.ok(types.has(t), `缺少事件 ${t}`);
  }
});

test('viewer inbox only contains own notifications; admin sees the full feed', () => {
  const { service, users } = makeService();
  const [rev] = service.createRevisions(users.analyst, caliberChange());
  service.submitRevision(users.analyst, rev.id);

  const viewerFeed = service.listNotifications(users.viewer);
  assert.ok(viewerFeed.every((n) => n.recipient === users.viewer.id));
  const adminFeed = service.listNotifications(users.admin);
  assert.ok(adminFeed.length > viewerFeed.length);
  assert.ok(adminFeed.some((n) => n.recipient !== users.admin.id));
});

// ---------- permissions ----------

test('permissions: viewer is read-only', () => {
  const { service, users } = makeService();
  // reads allowed
  assert.ok(service.listReports(users.viewer).length > 0);
  assert.ok(service.listRevisions(users.viewer).length === 0);

  for (const call of [
    () => service.previewChange(users.viewer, caliberChange()),
    () => service.createRevisions(users.viewer, caliberChange()),
  ]) {
    assert.throws(call, (e: unknown) => e instanceof AppError && e.status === 403);
  }
});

test('permissions: analyst can create and submit but not review or publish', () => {
  const { service, users } = makeService();
  const [rev] = service.createRevisions(users.analyst, caliberChange());
  service.submitRevision(users.analyst, rev.id);
  const task = service.getRevision(users.reviewer, rev.id).tasks[0]!;

  assert.throws(
    () => service.decideReview(users.analyst, task.id, 'APPROVED'),
    (e: unknown) => e instanceof AppError && e.status === 403,
  );
  // get the revision approved first so publish is otherwise valid
  service.decideReview(users.reviewer, task.id, 'APPROVED');
  assert.throws(
    () => service.publishRevision(users.analyst, rev.id),
    (e: unknown) => e instanceof AppError && e.status === 403,
  );
  assert.throws(
    () => service.rollback(users.analyst, rev.reportId, rev.baseVersionId, 'x'),
    (e: unknown) => e instanceof AppError && e.status === 403,
  );
});

test('permissions: reviewer can review but cannot author changes or publish', () => {
  const { service, users } = makeService();
  assert.throws(
    () => service.createRevisions(users.reviewer, caliberChange()),
    (e: unknown) => e instanceof AppError && e.status === 403,
  );
  const [rev] = service.createRevisions(users.analyst, caliberChange());
  service.submitRevision(users.analyst, rev.id);
  const task = service.getRevision(users.reviewer, rev.id).tasks[0]!;
  service.decideReview(users.reviewer, task.id, 'APPROVED');
  assert.throws(
    () => service.publishRevision(users.reviewer, rev.id),
    (e: unknown) => e instanceof AppError && e.status === 403,
  );
});

test('consistency: every role receives identical detail and summary numbers', () => {
  const { service, users } = makeService();
  const [rev] = service.createRevisions(users.analyst, caliberChange());
  service.submitRevision(users.analyst, rev.id);

  const views = [users.admin, users.analyst, users.reviewer, users.viewer].map((u) =>
    service.getRevision(u, rev.id),
  );
  for (const v of views) {
    assert.deepEqual(v.diffPreview, views[0]!.diffPreview);
    assert.deepEqual(v.diffSummary, views[0]!.diffSummary);
    assert.deepEqual(v.proposedSnapshot, views[0]!.proposedSnapshot);
    assert.deepEqual(v.tasks, views[0]!.tasks);
  }

  const reportViews = [users.admin, users.analyst, users.reviewer, users.viewer].map((u) =>
    service.getReport(u, rev.reportId),
  );
  for (const rv of reportViews) {
    assert.deepEqual(rv.latestCells, reportViews[0]!.latestCells);
    assert.deepEqual(rv.summary, reportViews[0]!.summary);
    assert.equal(rv.timeline.length, reportViews[0]!.timeline.length);
  }
});

test('unauthenticated access is rejected', () => {
  const { service } = makeService();
  assert.throws(
    () => service.listReports(service.authenticate(undefined)),
    (e: unknown) => e instanceof AppError && e.status === 401,
  );
  assert.throws(
    () => service.authenticate('u-does-not-exist'),
    (e: unknown) => e instanceof AppError && e.status === 401,
  );
});

test('state machine: submit only from DRAFT, approve only from SUBMITTED', () => {
  const { service, users } = makeService();
  const [rev] = service.createRevisions(users.analyst, caliberChange());
  service.submitRevision(users.analyst, rev.id);
  assert.throws(
    () => service.submitRevision(users.analyst, rev.id),
    (e: unknown) => e instanceof AppError && e.status === 409,
  );
  const task = service.getRevision(users.reviewer, rev.id).tasks[0]!;
  service.decideReview(users.reviewer, task.id, 'APPROVED');
  assert.throws(
    () => service.decideReview(users.reviewer, task.id, 'REJECTED'),
    (e: unknown) => e instanceof AppError && e.status === 409,
  );
});
