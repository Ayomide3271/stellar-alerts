import type { Prisma } from '../../../generated/prisma/client';

export type OutboxEventType = 'payment.alert' | 'payment.realtime';

export interface OutboxEventInput {
  eventType: OutboxEventType;
  aggregateId: string;
  payload: Prisma.InputJsonValue;
}

/** The slice of a Prisma client/transaction the service needs. */
export interface OutboxWriter {
  outboxEvent: {
    createMany(args: {
      data: Array<OutboxEventInput & { idempotencyKey: string }>;
      skipDuplicates: boolean;
    }): Promise<{ count: number }>;
  };
}

export function outboxIdempotencyKey(eventType: string, aggregateId: string): string {
  return `${eventType}:${aggregateId}`;
}

export class OutboxService {
  /**
   * Records events using the caller's transaction client so they commit or
   * roll back atomically with the business write. Replaying the same
   * (eventType, aggregateId) is a no-op thanks to the unique idempotency key.
   */
  async record(tx: OutboxWriter, events: OutboxEventInput[]): Promise<void> {
    if (events.length === 0) return;
    await tx.outboxEvent.createMany({
      data: events.map((event) => ({
        ...event,
        idempotencyKey: outboxIdempotencyKey(event.eventType, event.aggregateId),
      })),
      skipDuplicates: true,
    });
  }
}

export const outboxService = new OutboxService();
