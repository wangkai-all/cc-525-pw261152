import type {
  CellDiff,
  ChangeTrigger,
  DB,
  MetricDef,
  ReportCell,
  ReportDef,
  ReportVersion,
  SourceData,
} from './types.ts';
import { notFound } from './errors.ts';
import { round6 } from './util.ts';

/** A proposed change to a metric caliber or to source data. */
export type ChangeInput =
  | {
      kind: 'METRIC_CALIBER';
      metricId: string;
      newCaliber: string;
      newMultiplier: number;
      reason: string;
    }
  | {
      kind: 'SOURCE_DATA';
      dataId: string;
      /** New raw values keyed by period; only supplied periods are changed. */
      periodValues: Record<string, number>;
      reason: string;
    };

export function metricMap(db: DB): Map<string, MetricDef> {
  return new Map(db.metrics.map((m) => [m.id, m]));
}

export function dataMap(db: DB): Map<string, SourceData> {
  return new Map(db.sourceData.map((d) => [d.id, d]));
}

/**
 * Materialize the cells of a report from metric definitions + source data.
 * Pure function: the same inputs always produce the same snapshot, which is
 * what keeps every role's detail and summary views consistent.
 */
export function materializeReport(
  report: ReportDef,
  metrics: Map<string, MetricDef>,
  data: Map<string, SourceData>,
): ReportCell[] {
  const cells: ReportCell[] = [];
  for (const metricId of report.metricIds) {
    const metric = metrics.get(metricId);
    if (!metric) throw notFound(`指标 ${metricId} 不存在`);
    const series = data.get(metric.sourceDataId);
    if (!series) throw notFound(`数据源 ${metric.sourceDataId} 不存在`);
    for (const period of report.periods) {
      const rawValue = series.values[period] ?? 0;
      cells.push({
        metricId,
        period,
        rawValue,
        value: round6(rawValue * metric.multiplier),
      });
    }
  }
  return cells;
}

export function latestVersion(db: DB, reportId: string): ReportVersion | undefined {
  return db.versions
    .filter((v) => v.reportId === reportId && v.status === 'PUBLISHED')
    .sort((a, b) => b.versionNo - a.versionNo)[0];
}

export function requireLatestVersion(db: DB, reportId: string): ReportVersion {
  const v = latestVersion(db, reportId);
  if (!v) throw notFound(`报表 ${reportId} 还没有已发布版本`);
  return v;
}

/** Build the "what-if" metric/data maps after applying the proposed change. */
function scenario(
  db: DB,
  change: ChangeInput,
): { metrics: Map<string, MetricDef>; data: Map<string, SourceData> } {
  const metrics = metricMap(db);
  const data = dataMap(db);

  if (change.kind === 'METRIC_CALIBER') {
    const current = metrics.get(change.metricId);
    if (!current) throw notFound(`指标 ${change.metricId} 不存在`);
    metrics.set(change.metricId, {
      ...current,
      caliber: change.newCaliber,
      multiplier: change.newMultiplier,
      version: current.version + 1,
    });
  } else {
    const current = data.get(change.dataId);
    if (!current) throw notFound(`数据源 ${change.dataId} 不存在`);
    data.set(change.dataId, {
      ...current,
      values: { ...current.values, ...change.periodValues },
    });
  }
  return { metrics, data };
}

export function buildTrigger(db: DB, change: ChangeInput): ChangeTrigger {
  if (change.kind === 'METRIC_CALIBER') {
    const m = metricMap(db).get(change.metricId)!;
    return {
      metricId: m.id,
      oldCaliber: m.caliber,
      newCaliber: change.newCaliber,
      oldMultiplier: m.multiplier,
      newMultiplier: change.newMultiplier,
    };
  }
  const d = dataMap(db).get(change.dataId)!;
  return {
    dataId: d.id,
    periodChanges: Object.entries(change.periodValues)
      .map(([period, newValue]) => ({
        period,
        oldValue: d.values[period] ?? 0,
        newValue,
      }))
      .sort((a, b) => a.period.localeCompare(b.period)),
  };
}

const cellKey = (metricId: string, period: string) => `${metricId}|${period}`;

export function diffCells(oldCells: ReportCell[], newCells: ReportCell[]): CellDiff[] {
  const oldMap = new Map(oldCells.map((c) => [cellKey(c.metricId, c.period), c]));
  const diffs: CellDiff[] = [];
  for (const cell of newCells) {
    const old = oldMap.get(cellKey(cell.metricId, cell.period));
    const oldValue = old?.value ?? 0;
    const newValue = cell.value;
    if (oldValue === newValue) continue;
    const delta = round6(newValue - oldValue);
    diffs.push({
      metricId: cell.metricId,
      period: cell.period,
      oldValue,
      newValue,
      delta,
      pct: oldValue === 0 ? null : round6((delta / oldValue) * 100),
    });
  }
  return diffs.sort((a, b) =>
    a.metricId === b.metricId
      ? a.period.localeCompare(b.period)
      : a.metricId.localeCompare(b.metricId),
  );
}

export interface ImpactedReport {
  reportId: string;
  baseVersionId: string;
  diffPreview: CellDiff[];
  proposedSnapshot: ReportCell[];
}

export interface ImpactAnalysis {
  change: ChangeInput;
  impacted: ImpactedReport[];
  impactedReportIds: string[];
}

/**
 * Run a change across every report and return the impacted reports with
 * diff previews and proposed snapshots. Reports whose cells do not change
 * are excluded.
 */
export function impactAnalysis(db: DB, change: ChangeInput): ImpactAnalysis {
  const { metrics, data } = scenario(db, change);
  const impacted: ImpactedReport[] = [];

  for (const report of db.reports) {
    const base = requireLatestVersion(db, report.id);
    const proposedSnapshot = materializeReport(report, metrics, data);
    const diffPreview = diffCells(base.snapshot, proposedSnapshot);
    if (diffPreview.length > 0) {
      impacted.push({
        reportId: report.id,
        baseVersionId: base.id,
        diffPreview,
        proposedSnapshot,
      });
    }
  }

  return {
    change,
    impacted,
    impactedReportIds: impacted.map((i) => i.reportId),
  };
}

/** Aggregate summary used by list views; derived from the same diff data. */
export function summarizeDiffs(diffs: CellDiff[]): {
  changedCells: number;
  totalDelta: number;
  maxAbsPct: number | null;
} {
  let totalDelta = 0;
  let maxAbsPct: number | null = null;
  for (const d of diffs) {
    totalDelta = round6(totalDelta + d.delta);
    if (d.pct !== null) {
      maxAbsPct = maxAbsPct === null ? Math.abs(d.pct) : Math.max(maxAbsPct, Math.abs(d.pct));
    }
  }
  return { changedCells: diffs.length, totalDelta, maxAbsPct };
}
