/**
 * Clock / id generation kept injectable so tests can run deterministically.
 */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

export function isoNow(clock: Clock = systemClock): string {
  return clock.now().toISOString();
}

/** Monotonic per-prefix id backed by the persisted sequence table. */
export function nextId(prefix: string, seq: Record<string, number>): string {
  const n = (seq[prefix] ?? 0) + 1;
  seq[prefix] = n;
  return `${prefix}-${pad(n, 5)}`;
}

export function round6(n: number): number {
  return Math.round((n + Number.EPSILON) * 1e6) / 1e6;
}

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
