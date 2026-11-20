/**
 * Domain types for the management report revision workflow.
 * Only erasable TypeScript syntax is used (no enums / namespaces / parameter properties)
 * so the files run directly under Node's native type stripping.
 */

export type Role = 'admin' | 'analyst' | 'reviewer' | 'viewer';

export type Channel = 'SITE' | 'EMAIL' | 'IM';

export type RevisionStatus =
  | 'DRAFT'
  | 'SUBMITTED'
  | 'APPROVED'
  | 'PUBLISHED'
  | 'REJECTED'
  | 'CANCELLED';

export type TaskStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';

export type ChangeType = 'METRIC_CALIBER' | 'SOURCE_DATA';

export interface User {
  id: string;
  name: string;
  role: Role;
  email: string;
}

/** Master definition of an indicator, including its statistical caliber (口径). */
export interface MetricDef {
  id: string;
  code: string;
  name: string;
  caliber: string;
  /** Multiplier applied to the raw source value when materializing report cells. */
  multiplier: number;
  sourceDataId: string;
  version: number;
  updatedAt: string;
}

export interface SourceData {
  id: string;
  label: string;
  /** Raw values keyed by reporting period, e.g. "2026-Q1". */
  values: Record<string, number>;
  updatedAt: string;
}

export interface ReportDef {
  id: string;
  name: string;
  metricIds: string[];
  periods: string[];
  createdAt: string;
}

export interface ReportCell {
  metricId: string;
  period: string;
  rawValue: number;
  value: number;
}

export interface CellDiff {
  metricId: string;
  period: string;
  oldValue: number;
  newValue: number;
  delta: number;
  /** Percentage change against the old value; null when the old value is zero. */
  pct: number | null;
}

export interface ReportVersion {
  id: string;
  reportId: string;
  versionNo: number;
  status: 'PUBLISHED';
  source: 'PUBLISH' | 'ROLLBACK';
  reason: string;
  snapshot: ReportCell[];
  revisionId?: string;
  /** For rollback versions: the version id whose snapshot was restored. */
  rolledBackFrom?: string;
  createdBy: string;
  createdAt: string;
}

export interface ChangeTrigger {
  metricId?: string;
  dataId?: string;
  oldCaliber?: string;
  newCaliber?: string;
  oldMultiplier?: number;
  newMultiplier?: number;
  /** For source-data changes: per-period old/new values. */
  periodChanges?: Array<{ period: string; oldValue: number; newValue: number }>;
}

export interface Revision {
  id: string;
  reportId: string;
  changeType: ChangeType;
  reason: string;
  status: RevisionStatus;
  trigger: ChangeTrigger;
  /** Full list of reports impacted by the same change (not only this revision's report). */
  impactedReportIds: string[];
  baseVersionId: string;
  diffPreview: CellDiff[];
  proposedSnapshot: ReportCell[];
  reviewTaskIds: string[];
  /** Shared id linking all revisions opened by the same change request. */
  changeGroupId: string;
  approval?: { approvedBy: string; approvedAt: string; comment?: string };
  publishedVersionId?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface ReviewTask {
  id: string;
  revisionId: string;
  reportId: string;
  assigneeRole: Role;
  status: TaskStatus;
  decidedBy?: string;
  decidedAt?: string;
  comment?: string;
  createdAt: string;
}

export interface Notification {
  id: string;
  /** Stable key used for idempotent delivery / duplicate suppression. */
  dedupKey: string;
  recipient: string;
  channel: Channel;
  eventType:
    | 'REVIEW_ASSIGNED'
    | 'REVISION_SUBMITTED'
    | 'REVISION_APPROVED'
    | 'REVISION_REJECTED'
    | 'REVISION_PUBLISHED'
    | 'REVISION_CANCELLED'
    | 'REPORT_ROLLBACK';
  entityType: 'REVISION' | 'REPORT_VERSION' | 'REVIEW_TASK';
  entityId: string;
  title: string;
  status: 'SENT';
  /** How many duplicate delivery attempts were suppressed against the dedup key. */
  dupCount: number;
  sentAt: string;
  createdAt: string;
}

export interface AuditEvent {
  id: string;
  ts: string;
  actor: string;
  action: string;
  entityType: string;
  entityId: string;
  detail: Record<string, unknown>;
}

export interface DB {
  users: User[];
  metrics: MetricDef[];
  sourceData: SourceData[];
  reports: ReportDef[];
  versions: ReportVersion[];
  revisions: Revision[];
  reviewTasks: ReviewTask[];
  notifications: Notification[];
  audit: AuditEvent[];
  seq: Record<string, number>;
}
