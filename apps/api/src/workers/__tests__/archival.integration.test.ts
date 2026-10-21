import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "../../lib/prisma";
import { archivalWorker } from "../archival.worker";
import { partitionService } from "../../modules/maintenance/partition.service";
import { Decimal } from "@prisma/client/runtime/library";

describe("ArchivalWorker Integration Tests", () => {
  const testWalletId = "test-wallet-archival-" + Date.now();
  const testUserId = "test-user-archival-" + Date.now();

  beforeAll(async () => {
    // Create test user and wallet
    await prisma.user.create({
      data: {
        id: testUserId,
        email: `test-archival-${Date.now()}@example.com`,
      },
    });

    await prisma.wallet.create({
      data: {
        id: testWalletId,
        userId: testUserId,
        publicKey: `test-key-${Date.now()}`,
      },
    });
  });

  afterAll(async () => {
    // Cleanup
    await prisma.payment.deleteMany({
      where: { walletId: testWalletId },
    });
    await prisma.paymentArchive.deleteMany({
      where: { walletId: testWalletId },
    });
    await prisma.wallet.delete({
      where: { id: testWalletId },
    });
    await prisma.user.delete({
      where: { id: testUserId },
    });
  });

  it("should create monthly partitions without error", async () => {
    const result = await partitionService.ensureMonthlyPartitions();
    expect(result).toBeUndefined(); // Success if no throw
  });

  it("should archive old payments and delete from primary table", async () => {
    // Create payment older than 90 days
    const oldDate = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000);
    const payment = await prisma.payment.create({
      data: {
        id: `payment-old-${Date.now()}`,
        walletId: testWalletId,
        txHash: `tx-old-${Date.now()}`,
        fromAddress: "G123456789",
        amount: new Decimal("100.50"),
        asset: "USD",
        memo: "Old payment",
        receivedAt: oldDate,
        createdAt: oldDate,
      },
    });

    const paymentId = payment.id;

    // Archive old payments
    const archiveResult = await partitionService.archiveOldPayments(90);

    expect(archiveResult.archivedCount).toBeGreaterThan(0);
    expect(archiveResult.deletedCount).toBeGreaterThan(0);
    expect(archiveResult.duration).toBeGreaterThan(0);

    // Verify payment was removed from primary table
    const primaryPayment = await prisma.payment.findUnique({
      where: { id: paymentId },
    });
    expect(primaryPayment).toBeNull();

    // Verify payment exists in archive
    const archivedPayment = await prisma.paymentArchive.findMany({
      where: { walletId: testWalletId },
    });
    expect(archivedPayment.length).toBeGreaterThan(0);
  });

  it("should not archive recent payments (<90 days)", async () => {
    // Create recent payment (10 days old)
    const recentDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    const recentPayment = await prisma.payment.create({
      data: {
        id: `payment-recent-${Date.now()}`,
        walletId: testWalletId,
        txHash: `tx-recent-${Date.now()}`,
        fromAddress: "G987654321",
        amount: new Decimal("50.00"),
        asset: "EUR",
        memo: "Recent payment",
        receivedAt: recentDate,
        createdAt: recentDate,
      },
    });

    const paymentId = recentPayment.id;

    // Archive old payments (>90 days)
    await partitionService.archiveOldPayments(90);

    // Verify recent payment still exists in primary table
    const stillInPrimary = await prisma.payment.findUnique({
      where: { id: paymentId },
    });
    expect(stillInPrimary).not.toBeNull();
    expect(stillInPrimary?.id).toBe(paymentId);
  });

  it("should verify data integrity after archival", async () => {
    // Create test data
    const oldDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);
    await prisma.payment.create({
      data: {
        id: `payment-integrity-${Date.now()}`,
        walletId: testWalletId,
        txHash: `tx-integrity-${Date.now()}`,
        fromAddress: "GTEST",
        amount: new Decimal("123.45"),
        asset: "XLM",
        memo: "Integrity test",
        receivedAt: oldDate,
        createdAt: oldDate,
      },
    });

    // Run archival
    await partitionService.archiveOldPayments(90);

    // Verify data integrity
    const integrityCheck = await archivalWorker.verifyDataIntegrity();

    expect(integrityCheck.valid).toBe(true);
    expect(integrityCheck.primaryTableCount).toBeGreaterThanOrEqual(0);
    expect(integrityCheck.archiveTableCount).toBeGreaterThanOrEqual(0);
    expect(integrityCheck.totalCount).toBeGreaterThanOrEqual(
      integrityCheck.primaryTableCount,
    );
  });

  it("should ensure active indices exist", async () => {
    // Should not throw
    await partitionService.ensureActiveIndices();
    expect(true).toBe(true);
  });

  it("should validate partition health", async () => {
    const healthReport = await partitionService.validatePartitionHealth();

    expect(healthReport).toBeDefined();
    expect(healthReport.healthy).toBe(true);
    expect(healthReport.primaryTableRowCount).toBeGreaterThanOrEqual(0);
    expect(healthReport.archiveTableRowCount).toBeGreaterThanOrEqual(0);
    expect(healthReport.checkDuration).toBeGreaterThan(0);
  });

  it("should run full archival worker cycle", async () => {
    const result = await archivalWorker.run();

    expect(result.success).toBe(true);
    expect(result.duration).toBeGreaterThan(0);
    expect(result.error).toBeUndefined();
    expect(result.healthReport).toBeDefined();
  });

  it("should benchmark query performance", async () => {
    // Create some test data
    await prisma.payment.create({
      data: {
        id: `payment-bench-${Date.now()}`,
        walletId: testWalletId,
        txHash: `tx-bench-${Date.now()}`,
        fromAddress: "GBENCH",
        amount: new Decimal("999.99"),
        asset: "USDC",
        receivedAt: new Date(),
        createdAt: new Date(),
      },
    });

    const benchmark =
      await archivalWorker.benchmarkQueryPerformance(testWalletId);

    expect(benchmark.activeQueryMs).toBeGreaterThanOrEqual(0);
    expect(benchmark.archiveQueryMs).toBeGreaterThanOrEqual(0);
    expect(benchmark.improvement).toBeDefined();
  });

  it("should handle empty archival gracefully", async () => {
    // Clean up all old payments first
    const hundredDaysAgo = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);
    await prisma.payment.deleteMany({
      where: {
        walletId: testWalletId,
        createdAt: { lt: hundredDaysAgo },
      },
    });

    // Run archival on empty set
    const result = await partitionService.archiveOldPayments(90);

    expect(result.archivedCount).toBe(0);
    expect(result.deletedCount).toBe(0);
    expect(result.duration).toBeGreaterThanOrEqual(0);
  });
});
