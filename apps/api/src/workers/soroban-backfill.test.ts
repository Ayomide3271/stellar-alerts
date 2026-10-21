import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock prisma before importing worker
vi.mock("../lib/prisma", () => ({
  prisma: {
    sorobanEventSnapshot: {
      create: vi.fn(),
      findFirst: vi.fn(),
    },
  },
}));

vi.mock("../lib/soroban", () => ({
  fetchContractEventsInRange: vi.fn(),
  parseSorobanTransferEvent: vi.fn(),
  getSorobanLatestLedger: vi.fn(),
}));

import { prisma } from "../lib/prisma";
import {
  fetchContractEventsInRange,
  parseSorobanTransferEvent,
  getSorobanLatestLedger,
} from "../lib/soroban";
import { runSorobanBackfill, runIncrementalBackfill } from "./soroban-backfill.worker";

describe("Soroban Backfill Worker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should backfill events with deduplication", async () => {
    const contractId = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
    const mockEvents = [
      {
        contractId,
        topic: ["transfer"],
        value: { from: "GAAA", to: "GBBB", amount: "1000" },
        ledger: 100,
      },
    ];

    const mockParsedEvent = {
      contractId,
      from: "GAAA",
      to: "GBBB",
      amount: "1000",
      topic: "transfer",
      ledgerSeq: 100,
    };

    // Mock RPC
    const mockGenerator = async function* () {
      yield mockEvents;
    };

    vi.mocked(getSorobanLatestLedger).mockResolvedValueOnce(200);
    vi.mocked(fetchContractEventsInRange).mockReturnValueOnce(mockGenerator());
    vi.mocked(parseSorobanTransferEvent).mockReturnValueOnce(mockParsedEvent);
    vi.mocked(prisma.sorobanEventSnapshot.create).mockResolvedValueOnce({
      id: "snap-1",
      contractId,
      from: "GAAA",
      to: "GBBB",
      amount: "1000",
      ledgerSeq: 100,
      eventType: "transfer",
      txHash: null,
      paid: false,
      createdAt: new Date(),
    });

    await runSorobanBackfill(contractId, 1);

    expect(getSorobanLatestLedger).toHaveBeenCalled();
    expect(fetchContractEventsInRange).toHaveBeenCalledWith(contractId, 1, 200);
    expect(prisma.sorobanEventSnapshot.create).toHaveBeenCalledWith({
      data: {
        contractId,
        from: "GAAA",
        to: "GBBB",
        amount: "1000",
        ledgerSeq: 100,
        eventType: "transfer",
      },
    });
  });

  it("should detect duplicate events via unique constraint", async () => {
    const contractId = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
    const mockEvents = [
      {
        contractId,
        topic: ["transfer"],
        value: { from: "GAAA", to: "GBBB", amount: "1000" },
        ledger: 100,
      },
    ];

    const mockParsedEvent = {
      contractId,
      from: "GAAA",
      to: "GBBB",
      amount: "1000",
      topic: "transfer",
      ledgerSeq: 100,
    };

    const mockGenerator = async function* () {
      yield mockEvents;
    };

    vi.mocked(getSorobanLatestLedger).mockResolvedValueOnce(200);
    vi.mocked(fetchContractEventsInRange).mockReturnValueOnce(mockGenerator());
    vi.mocked(parseSorobanTransferEvent).mockReturnValueOnce(mockParsedEvent);

    // Simulate unique constraint violation
    const duplicateError = new Error("Unique constraint failed");
    (duplicateError as any).code = "P2002";
    vi.mocked(prisma.sorobanEventSnapshot.create).mockRejectedValueOnce(duplicateError);

    await runSorobanBackfill(contractId, 1);

    expect(prisma.sorobanEventSnapshot.create).toHaveBeenCalled();
  });

  it("should perform incremental backfill from last ledger", async () => {
    const contractId = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";

    const lastSnapshot = {
      ledgerSeq: 150,
    };

    const mockEvents = [
      {
        contractId,
        topic: ["transfer"],
        value: { from: "GAAA", to: "GBBB", amount: "2000" },
        ledger: 200,
      },
    ];

    const mockParsedEvent = {
      contractId,
      from: "GAAA",
      to: "GBBB",
      amount: "2000",
      topic: "transfer",
      ledgerSeq: 200,
    };

    const mockGenerator = async function* () {
      yield mockEvents;
    };

    vi.mocked(prisma.sorobanEventSnapshot.findFirst).mockResolvedValueOnce(lastSnapshot);
    vi.mocked(getSorobanLatestLedger).mockResolvedValueOnce(300);
    vi.mocked(fetchContractEventsInRange).mockReturnValueOnce(mockGenerator());
    vi.mocked(parseSorobanTransferEvent).mockReturnValueOnce(mockParsedEvent);
    vi.mocked(prisma.sorobanEventSnapshot.create).mockResolvedValueOnce({
      id: "snap-2",
      contractId,
      from: "GAAA",
      to: "GBBB",
      amount: "2000",
      ledgerSeq: 200,
      eventType: "transfer",
      txHash: null,
      paid: false,
      createdAt: new Date(),
    });

    await runIncrementalBackfill(contractId);

    // Should query from last snapshot + 1
    expect(fetchContractEventsInRange).toHaveBeenCalledWith(contractId, 151, 300);
  });

  it("should skip incremental backfill if no new ledgers", async () => {
    const contractId = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";

    const lastSnapshot = {
      ledgerSeq: 300,
    };

    vi.mocked(prisma.sorobanEventSnapshot.findFirst).mockResolvedValueOnce(lastSnapshot);
    vi.mocked(getSorobanLatestLedger).mockResolvedValueOnce(300);

    await runIncrementalBackfill(contractId);

    // Should not call fetchContractEventsInRange if no new ledgers
    expect(fetchContractEventsInRange).not.toHaveBeenCalled();
  });

  it("should handle missing contract ID gracefully", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await runSorobanBackfill("", 1);

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("SOROBAN_CONTRACT_ID not set")
    );

    consoleErrorSpy.mockRestore();
  });

  it("should handle RPC failures gracefully", async () => {
    const contractId = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";

    vi.mocked(getSorobanLatestLedger).mockResolvedValueOnce(0);

    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await runSorobanBackfill(contractId, 1);

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Could not fetch latest ledger")
    );

    consoleErrorSpy.mockRestore();
  });

  it("should backfill across multiple paginated ledger batches and deduplicate within a batch (#547)", async () => {
    const contractId = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
    const batch1 = [
      {
        contractId,
        topic: ["transfer"],
        value: { from: "GAAA", to: "GBBB", amount: "1000" },
        ledger: 110,
      },
      {
        contractId,
        topic: ["transfer"],
        value: { from: "GAAA", to: "GBBB", amount: "1000" },
        ledger: 110,
      },
    ];
    const batch2 = [
      {
        contractId,
        topic: ["transfer"],
        value: { from: "GBBB", to: "GCCC", amount: "2500" },
        ledger: 220,
      },
    ];

    const mockGenerator = async function* () {
      yield batch1;
      yield batch2;
    };

    vi.mocked(fetchContractEventsInRange).mockReturnValueOnce(mockGenerator());
    vi.mocked(parseSorobanTransferEvent)
      .mockReturnValueOnce({
        contractId,
        from: "GAAA",
        to: "GBBB",
        amount: "1000",
        topic: "transfer",
        ledgerSeq: 110,
      })
      .mockReturnValueOnce({
        contractId,
        from: "GAAA",
        to: "GBBB",
        amount: "1000",
        topic: "transfer",
        ledgerSeq: 110,
      })
      .mockReturnValueOnce({
        contractId,
        from: "GBBB",
        to: "GCCC",
        amount: "2500",
        topic: "transfer",
        ledgerSeq: 220,
      });

    vi.mocked(prisma.sorobanEventSnapshot.create).mockResolvedValue({
      id: "snap-batch",
      contractId,
      from: "GAAA",
      to: "GBBB",
      amount: "1000",
      ledgerSeq: 110,
      eventType: "transfer",
      txHash: null,
      paid: false,
      createdAt: new Date(),
    });

    const stats = await runSorobanBackfill(contractId, 100, 300);

    expect(fetchContractEventsInRange).toHaveBeenCalledWith(contractId, 100, 300);
    expect(prisma.sorobanEventSnapshot.create).toHaveBeenCalledTimes(2);
    expect(stats).toEqual({
      totalEventsProcessed: 3,
      eventsStored: 2,
      eventsDuplicated: 1,
      errorCount: 0,
    });
  });
});

