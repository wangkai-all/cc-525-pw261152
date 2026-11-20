import type { Clock } from '../src/util.ts';

/** Deterministic, monotonically advancing clock for reproducible tests. */
export class FakeClock implements Clock {
  private t: number;

  constructor(startIso = '2026-11-20T00:00:00.000Z') {
    this.t = Date.parse(startIso);
  }

  now(): Date {
    this.t += 1000;
    return new Date(this.t);
  }
}
