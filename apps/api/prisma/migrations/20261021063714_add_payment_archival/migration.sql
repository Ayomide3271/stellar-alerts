-- Create PaymentArchive table for cold storage of payments older than 90 days
CREATE TABLE "PaymentArchive" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "walletId" TEXT NOT NULL,
    "txHash" TEXT NOT NULL UNIQUE,
    "fromAddress" TEXT NOT NULL,
    "amount" DECIMAL(65,30) NOT NULL,
    "asset" TEXT NOT NULL,
    "assetIssuer" TEXT,
    "memo" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Create indices for optimal query performance on archive table
CREATE INDEX "idx_PaymentArchive_walletId" ON "PaymentArchive"("walletId");
CREATE INDEX "idx_PaymentArchive_asset" ON "PaymentArchive"("asset");
CREATE INDEX "idx_PaymentArchive_walletId_receivedAt" ON "PaymentArchive"("walletId", "receivedAt");
CREATE INDEX "idx_PaymentArchive_createdAt" ON "PaymentArchive"("createdAt");
CREATE INDEX "idx_PaymentArchive_archivedAt" ON "PaymentArchive"("archivedAt");

-- Add index on Payment.createdAt for archival queries
CREATE INDEX "idx_Payment_createdAt" ON "Payment"("createdAt");
