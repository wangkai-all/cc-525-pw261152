import type { DB, MetricDef, ReportDef, ReportVersion, SourceData, User } from './types.ts';
import { emptyDb } from './store.ts';
import { materializeReport, metricMap, dataMap } from './domain.ts';

const T0 = '2026-01-05T09:00:00.000Z';
const PUBLISH_TS = '2026-01-10T08:00:00.000Z';

export function seedDb(): DB {
  const db = emptyDb();

  const users: User[] = [
    { id: 'u-00001', name: '系统管理员', role: 'admin', email: 'admin@example.com' },
    { id: 'u-00002', name: '业务分析师', role: 'analyst', email: 'analyst@example.com' },
    { id: 'u-00003', name: '复核负责人', role: 'reviewer', email: 'reviewer@example.com' },
    { id: 'u-00004', name: '只读访客', role: 'viewer', email: 'viewer@example.com' },
  ];

  const sourceData: SourceData[] = [
    {
      id: 'SD-00001',
      label: '收入原始数据',
      values: { '2026-Q1': 1000, '2026-Q2': 1200 },
      updatedAt: T0,
    },
    {
      id: 'SD-00002',
      label: '毛利原始数据',
      values: { '2026-Q1': 300, '2026-Q2': 360 },
      updatedAt: T0,
    },
    {
      id: 'SD-00003',
      label: '成本原始数据',
      values: { '2026-Q1': 700, '2026-Q2': 840 },
      updatedAt: T0,
    },
  ];

  const metrics: MetricDef[] = [
    {
      id: 'M-00001',
      code: 'REVENUE',
      name: '营业收入',
      caliber: '按发货确认收入（不含税）',
      multiplier: 1,
      sourceDataId: 'SD-00001',
      version: 1,
      updatedAt: T0,
    },
    {
      id: 'M-00002',
      code: 'GROSS_PROFIT',
      name: '毛利额',
      caliber: '毛利 = 收入 − 营业成本（不含税）',
      multiplier: 1,
      sourceDataId: 'SD-00002',
      version: 1,
      updatedAt: T0,
    },
    {
      id: 'M-00003',
      code: 'OP_COST',
      name: '营业成本',
      caliber: '营业成本（含税口径）',
      multiplier: 1,
      sourceDataId: 'SD-00003',
      version: 1,
      updatedAt: T0,
    },
  ];

  const reports: ReportDef[] = [
    {
      id: 'R-00001',
      name: '管理层经营仪表盘',
      metricIds: ['M-00001', 'M-00002', 'M-00003'],
      periods: ['2026-Q1', '2026-Q2'],
      createdAt: T0,
    },
    {
      id: 'R-00002',
      name: '收入与毛利简报',
      metricIds: ['M-00001', 'M-00002'],
      periods: ['2026-Q1', '2026-Q2'],
      createdAt: T0,
    },
    {
      id: 'R-00003',
      name: '成本分析报表',
      metricIds: ['M-00003'],
      periods: ['2026-Q1', '2026-Q2'],
      createdAt: T0,
    },
  ];

  Object.assign(db, { users, sourceData, metrics, reports });

  // Every report gets an immutable V1 published snapshot.
  for (const report of reports) {
    const snapshot = materializeReport(report, metricMap(db), dataMap(db));
    const version: ReportVersion = {
      id: nextSeedId('V', db),
      reportId: report.id,
      versionNo: 1,
      status: 'PUBLISHED',
      source: 'PUBLISH',
      reason: '初始发布',
      snapshot,
      createdBy: 'u-00001',
      createdAt: PUBLISH_TS,
    };
    db.versions.push(version);
  }

  db.seq = {
    u: 4,
    SD: 3,
    M: 3,
    R: 3,
    V: 3,
    REV: 0,
    TASK: 0,
    NTF: 0,
    AUD: 0,
  };

  return db;
}

function nextSeedId(prefix: string, db: DB): string {
  const n = (db.seq[prefix] ?? 0) + 1;
  db.seq[prefix] = n;
  return `${prefix}-${String(n).padStart(5, '0')}`;
}
