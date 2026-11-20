import type { Channel, Notification, User, DB } from './types.ts';
import { nextId, isoNow, type Clock } from './util.ts';

export interface NotificationInput {
  recipient: string;
  channel: Channel;
  eventType: Notification['eventType'];
  entityType: Notification['entityType'];
  entityId: string;
  title: string;
}

/**
 * Stable identity of a notification: same event + entity + recipient + channel
 * is the same message. Repeated delivery attempts are counted as duplicates
 * instead of creating another row.
 */
export function dedupKeyOf(n: Omit<NotificationInput, 'title'>): string {
  return `${n.eventType}|${n.entityType}|${n.entityId}|${n.recipient}|${n.channel}`;
}

export function channelsForUser(user: User): Channel[] {
  return user.email ? ['SITE', 'EMAIL'] : ['SITE'];
}

/**
 * Deliver (or de-duplicate) one notification.
 * Returns the notification row and whether it was newly sent.
 */
export function deliver(
  db: DB,
  clock: Clock,
  input: NotificationInput,
): { notification: Notification; delivered: boolean } {
  const key = dedupKeyOf(input);
  const existing = db.notifications.find((n) => n.dedupKey === key);
  if (existing) {
    existing.dupCount += 1;
    return { notification: existing, delivered: false };
  }
  const notification: Notification = {
    id: nextId('NTF', db.seq),
    dedupKey: key,
    recipient: input.recipient,
    channel: input.channel,
    eventType: input.eventType,
    entityType: input.entityType,
    entityId: input.entityId,
    title: input.title,
    status: 'SENT',
    dupCount: 0,
    sentAt: isoNow(clock),
    createdAt: isoNow(clock),
  };
  db.notifications.push(notification);
  return { notification, delivered: true };
}

export interface NotifySpec {
  recipient: string;
  eventType: Notification['eventType'];
  entityType: Notification['entityType'];
  entityId: string;
  title: string;
}

/** Deliver one spec across every channel of the recipient; all are dedup-safe. */
export function notifyUser(db: DB, clock: Clock, spec: NotifySpec): {
  delivered: number;
  suppressed: number;
} {
  const user = db.users.find((u) => u.id === spec.recipient);
  if (!user) return { delivered: 0, suppressed: 0 };
  let delivered = 0;
  let suppressed = 0;
  for (const channel of channelsForUser(user)) {
    const result = deliver(db, clock, { ...spec, channel });
    if (result.delivered) delivered += 1;
    else suppressed += 1;
  }
  return { delivered, suppressed };
}

export function notifyMany(db: DB, clock: Clock, specs: NotifySpec[]): {
  delivered: number;
  suppressed: number;
} {
  return specs.reduce(
    (acc, spec) => {
      const r = notifyUser(db, clock, spec);
      acc.delivered += r.delivered;
      acc.suppressed += r.suppressed;
      return acc;
    },
    { delivered: 0, suppressed: 0 },
  );
}
