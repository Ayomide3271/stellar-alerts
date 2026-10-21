-- Unique idempotency key prevents duplicate outbox rows (and so duplicate
-- dispatch) for the same event. Nullable so pre-existing rows stay valid.
ALTER TABLE "OutboxEvent" ADD COLUMN "idempotencyKey" TEXT;

CREATE UNIQUE INDEX "OutboxEvent_idempotencyKey_key" ON "OutboxEvent"("idempotencyKey");
