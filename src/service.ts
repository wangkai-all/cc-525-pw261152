import type {
  AuditEvent,
  ChangeTrigger,
  DB,
  ReportVersion,
  Revision,
  ReviewTask,
  Role,
  User,
} from './types.ts';
import type { Store } from './store.ts';
import type { Clock } from './util.ts';
import { isoNow, nextId, systemClock } from './util.ts';
import { badRequest, conflict, forbidden, immutable, notFound, unauthorized } from './errors.ts';
import {
  buildTrigger,
  diffCells,
  impactAnalysis,
  latestVersion,
  materializeReport,
  metricMap,
  dataMap,
  requireLatestVersion,
  summarizeDiffs,
  type ChangeInput,
  type ImpactAnalysis,
} from './domain.ts';
import { notifyMany, notifyUser } from './notification.ts';

const OPEN_STATUSES = ['DRAFT', 'SUBMITTED', 'APPROVED'] as const;
type OpenStatus = (typeof OPEN_STATUSES)[number];
const TERMINAL_STATUSES = ['PUBLISHED', 'REJECTED', 'CANCELLED'] as const;

const READ_ROLES: Role[] = ['admin', 'analyst', 'reviewer', 'viewer'];

export class RevisionService {
  private store: Store;
  private clock: Clock;

  constructor(store: Store, clock: Clock = systemClock) {
    this.store = store;
    this.clock = clock;
  }

  /** Persisted domain state; exposed read/write to the HTTP layer and tests. */
  get db(): DB {
    return this.store.db;
  }

  // ---------- infra ----------

  authenticate(userId: string | undefined): User {
    if (!userId) throw unauthorized();
    const user = this.db.users.find((u) => u.id === userId);
    if (!user) throw unauthorized('用户不存在');
    return user;
  }

  private requireRole(user: User, roles: Role[]): User {
    if (!roles.includes(user.role)) {
      throw forbidden(`角色 ${user.role} 无权执行该操作，需要：${roles.join(' / ')}`);
    }
    return user;
  }

  private requireRead(user: User): User {
    return this.requireRole(user, READ_ROLES);
  }

  private audit(
    actor: User,
    action: string,
    entityType: string,
    entityId: string,
    detail: Record<string, unknown> = {},
  ): void {
    const event: AuditEvent = {
      id: nextId('AUD', this.db.seq),
      ts: isoNow(this.clock),
      actor: actor.id,
      action,
      entityType,
      entityId,
      detail,
    };
    this.db.audit.push(event);
  }

  private save(): void {
    this.store.save();
  }

  // ---------- read models (single projection shared by every role) ----------

  listReports(user: User) {
    this.requireRead(user);
    return this.db.reports.map((r) => {
      const latest = latestVersion(this.db, r.id);
      const revisions = this.db.revisions.filter((x) => x.reportId === r.id);
      const openCount = revisions.filter((x) => OPEN_STATUSES.includes(x.status as OpenStatus)).length;
      const pendingTasks = this.db.reviewTasks.filter(
        (t) => t.reportId === r.id && t.status === 'PENDING',
      ).length;
      return {
        id: r.id,
        name: r.name,
        metricIds: r.metricIds,
        periods: r.periods,
        latestVersionNo: latest?.versionNo ?? null,
        latestVersionId: latest?.id ?? null,
        revisionCount: revisions.length,
        openRevisionCount: openCount,
        pendingTaskCount: pendingTasks,
      };
    });
  }

  getReport(user: User, reportId: string) {
    this.requireRead(user);
    const report = this.db.reports.find((r) => r.id === reportId);
    if (!report) throw notFound(`报表 ${reportId} 不存在`);
    const versions = this.db.versions
      .filter((v) => v.reportId === reportId)
      .sort((a, b) => a.versionNo - b.versionNo);
    const revisions = this.db.revisions
      .filter((x) => x.reportId === reportId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const latest = versions.at(-1);

    // Unified timeline: published versions and revision events in one ordered stream.
    const timeline = [
      ...versions.map((v) => ({
        kind: 'VERSION' as const,
        id: v.id,
        ts: v.createdAt,
        label: `V${v.versionNo} ${v.source === 'ROLLBACK' ? '回滚发布' : '发布'}`,
        actor: v.createdBy,
        reason: v.reason,
        status: v.status,
      })),
      ...revisions.map((x) => ({
        kind: 'REVISION' as const,
        id: x.id,
        ts: x.updatedAt,
        label: `修订 ${x.id}（${x.status}）`,
        actor: x.createdBy,
        reason: x.reason,
        status: x.status,
      })),
    ].sort((a, b) => a.ts.localeCompare(b.ts));

    return {
      report,
      latestVersion: latest ?? null,
      latestCells: latest?.snapshot ?? [],
      versions,
      timeline,
      revisions: revisions.map((x) => this.buildRevisionView(x)),
      // Summary counters derived from the same arrays returned above.
      summary: {
        versionCount: versions.length,
        revisionCount: revisions.length,
        openRevisionCount: revisions.filter((x) =>
          OPEN_STATUSES.includes(x.status as OpenStatus),
        ).length,
        pendingTaskCount: this.db.reviewTasks.filter(
          (t) => t.reportId === reportId && t.status === 'PENDING',
        ).length,
      },
    };
  }

  getVersion(user: User, versionId: string) {
    this.requireRead(user);
    const version = this.db.versions.find((v) => v.id === versionId);
    if (!version) throw notFound(`版本 ${versionId} 不存在`);
    return version;
  }

  private buildRevisionView(rev: Revision) {
    const tasks = this.db.reviewTasks.filter((t) => t.revisionId === rev.id);
    const notifications = this.db.notifications.filter(
      (n) => n.entityType === 'REVISION' && n.entityId === rev.id,
    );
    const report = this.db.reports.find((r) => r.id === rev.reportId);
    return {
      ...rev,
      reportName: report?.name ?? rev.reportId,
      diffSummary: summarizeDiffs(rev.diffPreview),
      tasks,
      notificationState: {
        total: notifications.length,
        suppressedDuplicates: notifications.reduce((acc, n) => acc + n.dupCount, 0),
        byEvent: groupNotifications(notifications),
      },
    };
  }

  listRevisions(user: User, opts: { status?: string; reportId?: string } = {}) {
    this.requireRead(user);
    return this.db.revisions
      .filter((r) => (opts.status ? r.status === opts.status : true))
      .filter((r) => (opts.reportId ? r.reportId === opts.reportId : true))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((r) => this.buildRevisionView(r));
  }

  getRevision(user: User, revisionId: string) {
    this.requireRead(user);
    const rev = this.requireRevision(revisionId);
    return this.buildRevisionView(rev);
  }

  listReviewTasks(user: User, opts: { status?: string } = {}) {
    this.requireRead(user);
    return this.db.reviewTasks
      .filter((t) => (opts.status ? t.status === opts.status : true))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  listNotifications(user: User) {
    this.requireRead(user);
    // Personal inbox for everyone; admins additionally see the system-wide feed.
    const rows = user.role === 'admin'
      ? this.db.notifications
      : this.db.notifications.filter((n) => n.recipient === user.id);
    return rows.sort((a, b) => b.sentAt.localeCompare(a.sentAt));
  }

  listAudit(user: User) {
    this.requireRole(user, ['admin']);
    return [...this.db.audit].sort((a, b) => b.ts.localeCompare(a.ts));
  }

  // ---------- impact preview ----------

  previewChange(user: User, input: ChangeInput): ImpactAnalysis {
    this.requireRole(user, ['admin', 'analyst']);
    validateChange(input);
    return impactAnalysis(this.db, input);
  }

  // ---------- revision lifecycle ----------

  /**
   * Apply-for-revision entry point: analyze the change and open one DRAFT
   * revision per impacted report. Master metric/data definitions are NOT
   * mutated until a revision is published.
   */
  createRevisions(user: User, input: ChangeInput): Revision[] {
    this.requireRole(user, ['admin', 'analyst']);
    validateChange(input);
    const analysis = impactAnalysis(this.db, input);
    if (analysis.impacted.length === 0) {
      throw conflict('该变更未影响任何已发布报表，无需创建修订');
    }

    const groupId = nextId('GRP', this.db.seq);
    const trigger = buildTrigger(this.db, input);
    const now = isoNow(this.clock);
    const created: Revision[] = [];

    for (const item of analysis.impacted) {
      const rev: Revision = {
        id: nextId('REV', this.db.seq),
        reportId: item.reportId,
        changeType: input.kind,
        reason: input.reason,
        status: 'DRAFT',
        trigger,
        impactedReportIds: analysis.impactedReportIds,
        baseVersionId: item.baseVersionId,
        diffPreview: item.diffPreview,
        proposedSnapshot: item.proposedSnapshot,
        reviewTaskIds: [],
        changeGroupId: groupId,
        createdBy: user.id,
        createdAt: now,
        updatedAt: now,
      };
      this.db.revisions.push(rev);
      created.push(rev);
      this.audit(user, 'REVISION_CREATE', 'REVISION', rev.id, {
        reportId: rev.reportId,
        changeType: rev.changeType,
        impacted: analysis.impactedReportIds,
      });
    }
    this.save();
    return created;
  }

  submitRevision(user: User, revisionId: string): Revision {
    this.requireRole(user, ['admin', 'analyst']);
    const rev = this.requireRevision(revisionId);
    if (rev.createdBy !== user.id && user.role !== 'admin') {
      throw forbidden('只有修订创建人或管理员可以提交复核');
    }
    if (rev.status !== 'DRAFT') {
      throw conflict(`当前状态 ${rev.status} 不可提交，仅 DRAFT 可提交`);
    }

    rev.status = 'SUBMITTED';
    rev.updatedAt = isoNow(this.clock);

    // One review task per impacted report (this revision's report).
    const task: ReviewTask = {
      id: nextId('TASK', this.db.seq),
      revisionId: rev.id,
      reportId: rev.reportId,
      assigneeRole: 'reviewer',
      status: 'PENDING',
      createdAt: isoNow(this.clock),
    };
    this.db.reviewTasks.push(task);
    rev.reviewTaskIds.push(task.id);

    const reviewers = this.db.users.filter((u) => u.role === 'reviewer' || u.role === 'admin');
    notifyMany(this.db, this.clock, [
      ...reviewers.map((u) => ({
        recipient: u.id,
        eventType: 'REVIEW_ASSIGNED' as const,
        entityType: 'REVIEW_TASK' as const,
        entityId: task.id,
        title: `新复核任务：报表 ${rev.reportId} 的修订 ${rev.id}`,
      })),
      ...reviewers.map((u) => ({
        recipient: u.id,
        eventType: 'REVISION_SUBMITTED' as const,
        entityType: 'REVISION' as const,
        entityId: rev.id,
        title: `修订 ${rev.id} 已提交复核（原因：${rev.reason}）`,
      })),
    ]);

    this.audit(user, 'REVISION_SUBMIT', 'REVISION', rev.id, { taskId: task.id });
    this.save();
    return rev;
  }

  decideReview(
    user: User,
    taskId: string,
    decision: 'APPROVED' | 'REJECTED',
    comment?: string,
  ): ReviewTask {
    this.requireRole(user, ['admin', 'reviewer']);
    const task = this.db.reviewTasks.find((t) => t.id === taskId);
    if (!task) throw notFound(`复核任务 ${taskId} 不存在`);
    if (task.status !== 'PENDING') throw conflict(`任务已结束：${task.status}`);
    const rev = this.requireRevision(task.revisionId);
    if (rev.status !== 'SUBMITTED') {
      throw conflict(`修订当前状态 ${rev.status}，不可复核`);
    }

    task.status = decision;
    task.decidedBy = user.id;
    task.decidedAt = isoNow(this.clock);
    task.comment = comment;
    rev.updatedAt = isoNow(this.clock);

    if (decision === 'APPROVED') {
      rev.status = 'APPROVED';
      rev.approval = { approvedBy: user.id, approvedAt: task.decidedAt, comment };
    } else {
      rev.status = 'REJECTED';
    }

    const recipients = uniqueRecipients([
      rev.createdBy,
      ...this.db.users.filter((u) => u.role === 'admin').map((u) => u.id),
    ]);
    notifyMany(this.db, this.clock, recipients.map((recipient) => ({
      recipient,
      eventType: decision === 'APPROVED' ? 'REVISION_APPROVED' : 'REVISION_REJECTED',
      entityType: 'REVISION',
      entityId: rev.id,
      title:
        decision === 'APPROVED'
          ? `修订 ${rev.id} 复核通过，待发布`
          : `修订 ${rev.id} 复核被驳回${comment ? `：${comment}` : ''}`,
    })));

    this.audit(user, decision === 'APPROVED' ? 'REVIEW_APPROVE' : 'REVIEW_REJECT', 'REVIEW_TASK', task.id, {
      revisionId: rev.id,
      comment: comment ?? null,
    });
    this.save();
    return task;
  }

  publishRevision(user: User, revisionId: string): ReportVersion {
    this.requireRole(user, ['admin']);
    const rev = this.requireRevision(revisionId);
    if (rev.status === 'PUBLISHED') throw immutable(`修订 ${rev.id} 已发布，发布版本不可覆盖`);
    if (rev.status !== 'APPROVED') {
      throw conflict(`仅复核通过的修订可发布，当前状态：${rev.status}`);
    }

    // Baseline guard: the version the diff was computed against must still be latest.
    const currentLatest = requireLatestVersion(this.db, rev.reportId);
    if (currentLatest.id !== rev.baseVersionId) {
      throw conflict('基线版本已变化，存在更新的已发布版本，请基于新版本重新生成修订');
    }

    // Re-materialize from the stored proposal and verify it matches what was reviewed.
    this.applyTriggerToMaster(rev.trigger);
    const report = this.db.reports.find((r) => r.id === rev.reportId)!;
    const rematerialized = materializeReport(report, metricMap(this.db), dataMap(this.db));
    if (JSON.stringify(rematerialized) !== JSON.stringify(rev.proposedSnapshot)) {
      throw conflict('重新计算结果与复核时的快照不一致，发布已中止');
    }
    const reDiff = diffCells(currentLatest.snapshot, rematerialized);
    if (JSON.stringify(reDiff) !== JSON.stringify(rev.diffPreview)) {
      throw conflict('差异预览与当前实际差异不一致，发布已中止');
    }

    const versionNo = currentLatest.versionNo + 1;
    const version: ReportVersion = {
      id: nextId('V', this.db.seq),
      reportId: rev.reportId,
      versionNo,
      status: 'PUBLISHED',
      source: 'PUBLISH',
      reason: rev.reason,
      snapshot: rev.proposedSnapshot,
      revisionId: rev.id,
      createdBy: user.id,
      createdAt: isoNow(this.clock),
    };
    this.db.versions.push(version);
    rev.status = 'PUBLISHED';
    rev.publishedVersionId = version.id;
    rev.updatedAt = version.createdAt;

    const recipients = uniqueRecipients([
      rev.createdBy,
      ...this.db.users.filter((u) => u.role === 'reviewer' || u.role === 'admin').map((u) => u.id),
    ]);
    notifyMany(this.db, this.clock, recipients.map((recipient) => ({
      recipient,
      eventType: 'REVISION_PUBLISHED',
      entityType: 'REVISION',
      entityId: rev.id,
      title: `报表 ${rev.reportId} 已发布 V${versionNo}（修订 ${rev.id}）`,
    })));

    this.audit(user, 'REVISION_PUBLISH', 'REPORT_VERSION', version.id, {
      revisionId: rev.id,
      reportId: rev.reportId,
      versionNo,
    });
    this.save();
    return version;
  }

  cancelRevision(user: User, revisionId: string, comment?: string): Revision {
    const rev = this.requireRevision(revisionId);
    if (user.role !== 'admin' && rev.createdBy !== user.id) {
      throw forbidden('只有创建人或管理员可以撤销修订');
    }
    if (TERMINAL_STATUSES.includes(rev.status as (typeof TERMINAL_STATUSES)[number])) {
      throw conflict(`修订已结束（${rev.status}），不可撤销`);
    }

    rev.status = 'CANCELLED';
    rev.updatedAt = isoNow(this.clock);
    for (const task of this.db.reviewTasks.filter(
      (t) => t.revisionId === rev.id && t.status === 'PENDING',
    )) {
      task.status = 'CANCELLED';
      task.decidedBy = user.id;
      task.decidedAt = rev.updatedAt;
      task.comment = comment ?? '修订撤销，任务自动取消';
    }

    const recipients = uniqueRecipients([
      rev.createdBy,
      ...this.db.users.filter((u) => u.role === 'reviewer' || u.role === 'admin').map((u) => u.id),
    ]);
    notifyMany(this.db, this.clock, recipients.map((recipient) => ({
      recipient,
      eventType: 'REVISION_CANCELLED',
      entityType: 'REVISION',
      entityId: rev.id,
      title: `修订 ${rev.id} 已撤销`,
    })));

    this.audit(user, 'REVISION_CANCEL', 'REVISION', rev.id, { comment: comment ?? null });
    this.save();
    return rev;
  }

  /** Re-send review reminders; duplicate suppression is verified via dupCount growth. */
  remindReviewers(user: User, revisionId: string) {
    this.requireRole(user, ['admin', 'analyst']);
    const rev = this.requireRevision(revisionId);
    const pending = this.db.reviewTasks.filter(
      (t) => t.revisionId === rev.id && t.status === 'PENDING',
    );
    if (pending.length === 0) throw conflict('该修订没有待处理的复核任务，无需提醒');

    const reviewers = this.db.users.filter((u) => u.role === 'reviewer' || u.role === 'admin');
    let delivered = 0;
    let suppressedDuplicates = 0;
    for (const task of pending) {
      for (const u of reviewers) {
        const result = notifyUser(this.db, this.clock, {
          recipient: u.id,
          eventType: 'REVIEW_ASSIGNED',
          entityType: 'REVIEW_TASK',
          entityId: task.id,
          title: `催办：复核任务 ${task.id}（报表 ${rev.reportId}）仍待处理`,
        });
        delivered += result.delivered;
        suppressedDuplicates += result.suppressed;
      }
    }
    this.audit(user, 'REVIEW_REMIND', 'REVISION', rev.id, { delivered, suppressedDuplicates });
    this.save();
    return { delivered, suppressedDuplicates };
  }

  rollback(user: User, reportId: string, targetVersionId: string, reason: string): ReportVersion {
    this.requireRole(user, ['admin']);
    if (!reason || !reason.trim()) throw badRequest('回滚必须绑定原因');
    const report = this.db.reports.find((r) => r.id === reportId);
    if (!report) throw notFound(`报表 ${reportId} 不存在`);
    const target = this.db.versions.find((v) => v.id === targetVersionId && v.reportId === reportId);
    if (!target) throw notFound(`目标版本 ${targetVersionId} 不存在`);

    const current = requireLatestVersion(this.db, reportId);
    if (target.id === current.id) throw conflict('目标版本就是当前最新版本，无需回滚');

    const open = this.db.revisions.filter(
      (r) => r.reportId === reportId && OPEN_STATUSES.includes(r.status as OpenStatus),
    );
    if (open.length > 0) {
      throw conflict(`报表存在 ${open.length} 个未结束的修订，请先处理后再回滚`);
    }

    // Rollback never mutates or deletes history: the old snapshot is re-published
    // as a new immutable version.
    const version: ReportVersion = {
      id: nextId('V', this.db.seq),
      reportId,
      versionNo: current.versionNo + 1,
      status: 'PUBLISHED',
      source: 'ROLLBACK',
      reason,
      snapshot: structuredClone(target.snapshot),
      rolledBackFrom: target.id,
      createdBy: user.id,
      createdAt: isoNow(this.clock),
    };
    this.db.versions.push(version);

    const recipients = uniqueRecipients([
      ...this.db.users.filter((u) => u.role !== 'viewer').map((u) => u.id),
    ]);
    notifyMany(this.db, this.clock, recipients.map((recipient) => ({
      recipient,
      eventType: 'REPORT_ROLLBACK',
      entityType: 'REPORT_VERSION',
      entityId: version.id,
      title: `报表 ${reportId} 已回滚至 V${target.versionNo}，新版本 V${version.versionNo}`,
    })));

    this.audit(user, 'REPORT_ROLLBACK', 'REPORT_VERSION', version.id, {
      reportId,
      targetVersionId,
      reason,
    });
    this.save();
    return version;
  }

  // ---------- internals ----------

  private requireRevision(id: string): Revision {
    const rev = this.db.revisions.find((r) => r.id === id);
    if (!rev) throw notFound(`修订 ${id} 不存在`);
    return rev;
  }

  /**
   * Apply the stored trigger to the master metric/data definitions.
   * Idempotent: re-publishing a shared change must not corrupt definitions.
   */
  private applyTriggerToMaster(trigger: ChangeTrigger): void {
    const now = isoNow(this.clock);
    if (trigger.metricId) {
      const metric = this.db.metrics.find((m) => m.id === trigger.metricId);
      if (!metric) throw notFound(`指标 ${trigger.metricId} 不存在`);
      let changed = false;
      if (trigger.newCaliber !== undefined && metric.caliber !== trigger.newCaliber) {
        metric.caliber = trigger.newCaliber;
        changed = true;
      }
      if (
        trigger.newMultiplier !== undefined &&
        metric.multiplier !== trigger.newMultiplier
      ) {
        metric.multiplier = trigger.newMultiplier;
        changed = true;
      }
      if (changed) {
        metric.version += 1;
        metric.updatedAt = now;
      }
    } else if (trigger.dataId) {
      const series = this.db.sourceData.find((d) => d.id === trigger.dataId);
      if (!series) throw notFound(`数据源 ${trigger.dataId} 不存在`);
      for (const pc of trigger.periodChanges ?? []) {
        if (series.values[pc.period] !== pc.newValue) {
          series.values[pc.period] = pc.newValue;
        }
      }
      series.updatedAt = now;
    }
  }
}

// ---------- helpers ----------

function validateChange(input: ChangeInput): void {
  if (!input.reason || !input.reason.trim()) {
    throw badRequest('修订必须绑定变更原因');
  }
  if (input.kind === 'METRIC_CALIBER') {
    if (!Number.isFinite(input.newMultiplier) || input.newMultiplier === 0) {
      throw badRequest('指标乘数必须是非零有限数值');
    }
    if (!input.newCaliber || !input.newCaliber.trim()) {
      throw badRequest('新口径不能为空');
    }
  } else {
    const entries = Object.entries(input.periodValues);
    if (entries.length === 0) throw badRequest('至少提供一个期间的新数据');
    for (const [, v] of entries) {
      if (!Number.isFinite(v)) throw badRequest('数据值必须是有限数值');
    }
  }
}

function uniqueRecipients(ids: string[]): string[] {
  return [...new Set(ids.filter(Boolean))];
}

function groupNotifications(notifications: DB['notifications']) {
  const map = new Map<string, { eventType: string; count: number; suppressed: number; lastSentAt: string }>();
  for (const n of notifications) {
    const cur = map.get(n.eventType);
    if (cur) {
      cur.count += 1;
      cur.suppressed += n.dupCount;
      if (n.sentAt > cur.lastSentAt) cur.lastSentAt = n.sentAt;
    } else {
      map.set(n.eventType, {
        eventType: n.eventType,
        count: 1,
        suppressed: n.dupCount,
        lastSentAt: n.sentAt,
      });
    }
  }
  return [...map.values()];
}
