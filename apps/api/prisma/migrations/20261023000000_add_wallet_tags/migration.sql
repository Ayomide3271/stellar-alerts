-- Add custom color-coded category tags to tracked wallets
-- issue: Wallet Tagging & Custom Label Classification System API
ALTER TABLE "wallets" ADD COLUMN "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- Gin index for tag filtering on GET /wallets?tag=Payroll
CREATE INDEX IF NOT EXISTS "wallets_tags_idx" ON "wallets" USING GIN("tags");
