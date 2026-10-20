ALTER TABLE "wallets"
ADD COLUMN "metadata" JSONB NOT NULL DEFAULT '{}'::jsonb;