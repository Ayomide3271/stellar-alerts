-- Restore the soft-delete column on Wallet.
--
-- prisma/schema.prisma declares `@@index([deletedAt])` on the Wallet model,
-- but the `deletedAt` field itself was lost when the change that introduced
-- it was merged. Prisma refuses to generate the client while an index
-- references an unknown field, so the field is restored here together with
-- the migration that backs it.
ALTER TABLE "Wallet"
ADD COLUMN "deletedAt" TIMESTAMP(3);

-- Index backing the @@index([deletedAt]) declaration in prisma/schema.prisma.
CREATE INDEX IF NOT EXISTS "Wallet_deletedAt_idx" ON "Wallet"("deletedAt");
