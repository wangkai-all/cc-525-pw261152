import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DB } from './types.ts';
import { seedDb } from './seed.ts';

export interface Store {
  db: DB;
  save(): void;
  reset(): void;
}

export function emptyDb(): DB {
  return {
    users: [],
    metrics: [],
    sourceData: [],
    reports: [],
    versions: [],
    revisions: [],
    reviewTasks: [],
    notifications: [],
    audit: [],
    seq: {},
  };
}

export function createJsonStore(filePath: string): Store {
  let db: DB;
  if (existsSync(filePath)) {
    const raw = readFileSync(filePath, 'utf8');
    db = raw.trim() ? (JSON.parse(raw) as DB) : emptyDb();
  } else {
    db = seedDb();
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(db, null, 2));
  }

  return {
    db,
    save() {
      const tmp = `${filePath}.tmp`;
      writeFileSync(tmp, JSON.stringify(db, null, 2));
      // atomic replace so a crash mid-write cannot corrupt the data file
      renameSync(tmp, filePath);
    },
    reset() {
      db = seedDb();
      writeFileSync(filePath, JSON.stringify(db, null, 2));
    },
  };
}

/** In-memory store used by tests. */
export function createMemoryStore(initial?: DB): Store {
  const db = initial ? structuredClone(initial) : seedDb();
  return {
    db,
    save() {
      /* no persistence */
    },
    reset() {
      const fresh = seedDb();
      for (const key of Object.keys(db) as (keyof DB)[]) {
        (db as Record<string, unknown>)[key] = fresh[key] as unknown;
      }
    },
  };
}
