import { enqueuePaymentAlertStrict, type AlertJobData } from '../lib/queue';
import { prisma } from '../lib/prisma';
import { redis } from '../lib/redis';
import { createLogger } from '../lib/logger';

const log = createLogger({ module: 'OutboxRelay' });
const PAYMENT_CHANNEL = 'stellar-alerts:payments';
const RELAY_INTERVAL_MS = 1000;
const BATCH_SIZE = 50;
const LOCK_TIMEOUT_MS = 60_000;

type OutboxPayload = AlertJobData & { eventId?: string };

function nextAttempt(attempts: number): Date {
  return new Date(Date.now() + Math.min(60_000, 1000 * 2 ** Math.min(attempts, 6)));
}

async function claimBatch() {
  const staleBefore = new Date(Date.now() - LOCK_TIMEOUT_MS);
  await prisma.outboxEvent.updateMany({
    where: { status: 'processing', lockedAt: { lt: staleBefore } },
    data: { status: 'pending', lockedAt: null },
  });

  const candidates = await prisma.outboxEvent.findMany({
    where: { status: 'pending', availableAt: { lte: new Date() } },
    orderBy: { createdAt: 'asc' },
    take: BATCH_SIZE,
  });

  const claimed = [];
  for (const candidate of candidates) {
    const result = await prisma.outboxEvent.updateMany({
      where: { id: candidate.id, status: 'pending' },
      data: { status: 'processing', lockedAt: new Date(), attempts: { increment: 1 } },
    });
    if (result.count === 1) claimed.push(candidate);
  }
  return claimed;
}

async function relayEvent(event: { id: string; eventType: string; payload: unknown }) {
  const payload = { ...(event.payload as OutboxPayload), eventId: event.id };

  if (event.eventType === 'payment.alert') {
    await enqueuePaymentAlertStrict(payload);
  } else if (event.eventType === 'payment.realtime') {
    await redis.publish(PAYMENT_CHANNEL, JSON.stringify({
      type: 'payment',
      payload,
      timestamp: new Date().toISOString(),
      eventId: event.id,
    }));
  } else {
    throw new Error(`Unknown outbox event type: ${event.eventType}`);
  }
}

export async function relayOutboxBatch(): Promise<number> {
  const events = await claimBatch();
  for (const event of events) {
    try {
      await relayEvent(event);
      await prisma.outboxEvent.update({
        where: { id: event.id },
        data: { status: 'processed', processedAt: new Date(), lockedAt: null },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await prisma.outboxEvent.update({
        where: { id: event.id },
        data: {
          status: 'pending',
          availableAt: nextAttempt(event.attempts),
          lockedAt: null,
          lastError: message,
        },
      });
      log.warn({ eventId: event.id, eventType: event.eventType, err: message }, 'Outbox relay failed; scheduled retry');
    }
  }
  return events.length;
}

export function runOutboxRelay(): () => void {
  let running = false;
  const poll = async () => {
    if (running) return;
    running = true;
    try {
      await relayOutboxBatch();
    } catch (error) {
      log.error({ err: error }, 'Outbox relay poll failed');
    } finally {
      running = false;
    }
  };
  void poll();
  const timer = setInterval(() => void poll(), RELAY_INTERVAL_MS);
  log.info({ intervalMs: RELAY_INTERVAL_MS }, 'Durable outbox relay started');
  return () => clearInterval(timer);
}
