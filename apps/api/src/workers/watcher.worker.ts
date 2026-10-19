import { isValidEd25519PublicKey } from '@stellar-alerts/shared';
import { env } from '../config/env';
import { prisma, connectWithRetry } from '../lib/prisma';
import { stellar, decodeHorizonAsset, parseSacTransferEvent, formatTokenAmount } from '../lib/stellar';
import { enqueuePaymentAlert } from '../lib/queue';
import { publishPaymentEvent } from '../lib/realtime';
import {
  getSorobanLatestLedger,
  loadContractRegistry,
  getActiveContractIds,
  parseSorobanTransferEvent,
  routeEventToUsers,
  getSacMetadata,
} from '../lib/soroban';
import { withWalletLock } from '../lib/lock';
import { shouldAlert, PaymentContext } from '../lib/rules-engine';
import { evaluateAlertRules, evaluateAndDispatch, AlertRuleRecord, NormalizedPaymentEvent } from '../lib/alert-rule-evaluator';
import { MemoryMonitor, MemorySnapshot } from '../utils/memory-monitor';
import { appendPaymentChecksum } from '../services/checksumChain.service';
import { createLogger } from '../lib/logger';
import { WorkerLifecycleManager } from '../lib/worker-lifecycle';
import { startTelemetry, shutdownTelemetry } from '../lib/telemetry';
import { startWorkerMetricsServer, stopWorkerMetricsServer } from '../lib/worker-metrics-server';
import { trace, SpanStatusCode, TraceFlags } from '@opentelemetry/api';

export const watcherLifecycle = new WorkerLifecycleManager({
  workerName: 'WatcherWorker',
  drainTimeoutMs: 10_000,
  maxInFlight: 20,
  autoRegisterSignals: true,
});
import {
  BOUNDED_BACKFILL_LIMIT,
  buildCursorGapClearedUpdate,
  buildCursorGapUpdate,
  buildCursorOutageUpdate,
  buildCursorSuccessUpdate,
  detectLedgerGap,
} from '../lib/cursor-recovery';
import {
  HorizonOperationRecord,
  isHorizonPayment,
  isHorizonCreateAccount,
  getHorizonPagingToken,
  getHorizonTxHash,
} from '../types/horizon';
import { asEnrichedSorobanEvents, type EnrichedSorobanEvent } from '../types/soroban-event';
import { isPingMessage } from '../types/ipc';
import { extractFilterRules } from '../types/notification-preference';

const tracer = trace.getTracer('watcher-worker');


let memoryMonitor: MemoryMonitor | null = null;

const log = createLogger({ module: 'WatcherWorker' });

/**
 * Replies to the supervisor's IPC pings so the worker is not considered
 * frozen and killed (see workers/supervisor.ts heartbeat logic).
 */
function registerSupervisorHeartbeat() {
  if (process.send) {
    process.on('message', (message: any) => {
      if (message === 'ping' || message?.type === 'ping') {
        process.send?.({ type: 'pong', pid: process.pid });
      }
    });
  }
}

export async function processPaymentRecord(
  wallet: { id: string; publicKey: string; userId?: string },
  record: HorizonOperationRecord,
  options: { skipGapCheck?: boolean } = {}
) {
  return tracer.startActiveSpan('watcher.processPaymentRecord', async (span) => {
    try {
      let amount: string | undefined;
      let asset: string = "XLM";
      let assetIssuer: string | null = null;
      let fromAddress: string = '';
      let memo: string | null = null;
      const txHash: string = getHorizonTxHash(record);
      const receivedAt: Date = new Date(record.created_at || Date.now());

      if (isHorizonPayment(record)) {
        const decodedAsset = decodeHorizonAsset(record);
        amount = record.amount;
        asset = decodedAsset.assetCode;
        assetIssuer = decodedAsset.assetIssuer;
        fromAddress = record.from || '';
        memo = record.memo || null;
      } else if (isHorizonCreateAccount(record)) {
        amount = record.starting_balance;
        asset = "XLM";
        assetIssuer = null;
        fromAddress = record.funder || "";
      } else {
        const sacTransfer = parseSacTransferEvent(record);
        if (!sacTransfer) {
          span.end();
          return;
        }

        let decimals = 7;
        let symbol = sacTransfer.assetCode ?? sacTransfer.contractId ?? "Unknown";

        if (sacTransfer.contractId) {
          try {
            const meta = await getSacMetadata(sacTransfer.contractId);
            if (meta) {
              decimals = meta.decimals;
              symbol = meta.symbol || symbol;
            }
          } catch (err: any) {
            console.warn(`[WatcherWorker] Error resolving SAC metadata for ${sacTransfer.contractId}:`, err?.message);
          }
        }

        amount = formatTokenAmount(sacTransfer.rawAmount, decimals);
        asset = symbol;
        assetIssuer = sacTransfer.assetIssuer;
        fromAddress = sacTransfer.from;
      }

      if (!amount || !txHash) {
        span.end();
        return;
      }

      span.setAttribute('payment.txHash', txHash);
      span.setAttribute('payment.walletId', wallet.id);
      span.setAttribute('payment.asset', asset);

      const pagingToken = getHorizonPagingToken(record);
      const existing = await prisma.payment.findUnique({ where: { txHash } });
      let payment: { id: string } | null = existing;
      let isNewPayment = false;
      let shouldSendAlert = true;
      let alertRules: AlertRuleRecord[] = [];

      if (!existing && wallet.userId) {
        alertRules = await prisma.alertRule.findMany({
          where: { userId: wallet.userId },
        }) as unknown as AlertRuleRecord[];

        if (alertRules.length > 0) {
          const event: NormalizedPaymentEvent = {
            paymentId: '',
            txHash,
            walletId: wallet.id,
            userId: wallet.userId,
            amount: Number(amount),
            asset,
            assetIssuer,
            fromAddress,
            memo,
            receivedAt: receivedAt.toISOString(),
          };

          shouldSendAlert = evaluateAlertRules(alertRules, event).length > 0;
        } else {
          const notifyPrefs = await prisma.notificationPreference.findUnique({
            where: { userId: wallet.userId },
          });

          if ((notifyPrefs as any)?.filterRules) {
            const paymentContext: PaymentContext = {
              amount: Number(amount),
              asset,
              fromAddress,
              memo,
            };

            shouldSendAlert = shouldAlert((notifyPrefs as any)?.filterRules, paymentContext);

            if (!shouldSendAlert) {
              console.log(
                `[WatcherWorker] 🔕 Payment filtered by rules for wallet (${wallet.publicKey.substring(
                  0,
                  8
                )}...): ${amount} ${asset}`
              );
            }
          }
        }
      }

      const transactionResult = await withWalletLock(
        wallet.id,
        () => prisma.$transaction(async (tx) => {
          const inserted = await tx.payment.createMany({
            data: [{
              walletId: wallet.id,
              txHash,
              fromAddress,
              amount: Number(amount),
              asset,
              assetIssuer,
              memo,
              receivedAt,
            }],
            skipDuplicates: true,
          });
          const persistedPayment = await tx.payment.findUnique({ where: { txHash } });

          if (!persistedPayment) {
            throw new Error(`Payment ${txHash} was not available after its transactional insert`);
          }

          if (inserted.count > 0) {
            const eventPayload = {
              paymentId: persistedPayment.id,
              txHash,
              walletId: wallet.id,
              amount,
              asset,
              assetIssuer,
              fromAddress,
              receivedAt: receivedAt.toISOString(),
            };
            await tx.outboxEvent.createMany({
              data: [
                ...(shouldSendAlert
                  ? [{ eventType: 'payment.alert', aggregateId: persistedPayment.id, payload: eventPayload }]
                  : []),
                { eventType: 'payment.realtime', aggregateId: persistedPayment.id, payload: eventPayload },
              ],
            });
          }

          let cursorGap = { hasGap: false, ledgerDelta: 0 };
          if (pagingToken) {
            if (options.skipGapCheck) {
              const currentPagingToken =
                (await tx.ingestionCursor.findUnique({ where: { walletId: wallet.id } }))?.pagingToken ?? null;
              if (currentPagingToken === null || isPagingTokenAtLeast(pagingToken, currentPagingToken)) {
                await tx.ingestionCursor.upsert({
                  where: { walletId: wallet.id },
                  create: { walletId: wallet.id, pagingToken },
                  update: { pagingToken, ...buildCursorSuccessUpdate() },
                });
              }
            } else {
              const previousPagingToken =
                (await tx.ingestionCursor.findUnique({ where: { walletId: wallet.id } }))?.pagingToken ?? null;
              const cursorCanAdvance =
                previousPagingToken === null || isPagingTokenAtLeast(pagingToken, previousPagingToken);
              cursorGap = detectLedgerGap(previousPagingToken, pagingToken);

              if (cursorCanAdvance) {
                await tx.ingestionCursor.upsert({
                  where: { walletId: wallet.id },
                  create: { walletId: wallet.id, pagingToken },
                  update: {
                    pagingToken,
                    ...(cursorGap.hasGap
                      ? buildCursorGapUpdate(cursorGap.ledgerDelta)
                      : buildCursorSuccessUpdate()),
                  },
                });
              }
            }
          }

          return {
            payment: persistedPayment,
            isNewPayment: inserted.count > 0,
            gap: cursorGap,
          };
        }),
        { retryCount: 3, retryDelayMs: 100 },
      );
      if (transactionResult === null) {
        throw new Error(`Could not acquire wallet processing lock for ${wallet.id}`);
      }
      payment = transactionResult.payment;
      isNewPayment = transactionResult.isNewPayment;
      const { gap } = transactionResult;

      if (!payment) {
        throw new Error(`Payment ${txHash} was not available after its transactional insert`);
      }

      if (isNewPayment && payment) {
        // Best-effort, non-throwing by design (see services/checksumChain.service.ts):
        // a checksum-chain bug must never block real payment ingestion/alerting.
        await appendPaymentChecksum({
          id: payment.id,
          txHash,
          walletId: wallet.id,
          fromAddress,
          amount: Number(amount),
          asset,
          assetIssuer,
          memo,
          receivedAt,
        });

        if (wallet.userId) {
          await publishPaymentEvent(wallet.userId, payment);
        }

        const alertJobPayload = {
          paymentId: payment.id,
          txHash,
          walletId: wallet.id,
          amount,
          asset,
          assetIssuer,
          fromAddress,
          receivedAt: receivedAt.toISOString(),
        };

        // Persisted AlertRule records take priority when a user has any
        // configured (see lib/alert-rule-evaluator.ts): only a matching
        // rule enqueues a notification job, and duplicate delivery of the
        // same payment event is a no-op. Users with no AlertRule rows keep
        // the legacy NotificationPreference.filterRules gate (or, absent
        // that too, the historical "always alert" default) unchanged.
        let dispatched = false;
        let usedAlertRules = false;

        if (wallet.userId) {
          if (alertRules.length > 0) {
            usedAlertRules = true;
            const event: NormalizedPaymentEvent = {
              paymentId: payment.id,
              txHash,
              walletId: wallet.id,
              userId: wallet.userId,
              amount: Number(amount),
              asset,
              assetIssuer,
              fromAddress,
              memo,
              receivedAt: receivedAt.toISOString(),
            };

            const result = await evaluateAndDispatch(event, {
              findRules: async () => alertRules as unknown as AlertRuleRecord[],
              hasDispatched: async (paymentId) =>
                Boolean(await prisma.alertRuleDispatchLog.findUnique({ where: { paymentId } })),
              recordDispatch: async (paymentId, matchedRuleIds) => {
                await prisma.alertRuleDispatchLog.create({
                  data: { paymentId, matchedRuleIds },
                });
              },
              enqueueAlert: async () => enqueuePaymentAlert(alertJobPayload),
            });

            dispatched = result.enqueued;
            span.setAttribute('payment.matchedAlertRules', result.matchedRuleIds.length);

            if (result.matchedRuleIds.length === 0) {
              log.info(
                `[WatcherWorker] 🔕 No active AlertRule matched for wallet (${wallet.publicKey.substring(
                  0,
                  8
                )}...): ${amount} ${asset}`
              );
            }
          }
        }

        if (!usedAlertRules) {
          let shouldSendAlert = true;

          if (wallet.userId) {
            const notifyPrefs = await prisma.notificationPreference.findUnique({
              where: { userId: wallet.userId },
            });

            if ((notifyPrefs as any)?.filterRules) {
              const paymentContext: PaymentContext = {
                amount: Number(amount),
                asset,
                fromAddress,
                memo,
              };

              shouldSendAlert = shouldAlert((notifyPrefs as any)?.filterRules, paymentContext);

              if (!shouldSendAlert) {
                log.info(
                  `[WatcherWorker] 🔕 Payment filtered by rules for wallet (${wallet.publicKey.substring(
                    0,
                    8
                  )}...): ${amount} ${asset}`
                );
              }
            }
          }

          if (shouldSendAlert) {
            await enqueuePaymentAlert(alertJobPayload);
            dispatched = true;
          }
        }

        span.setAttribute('payment.enqueued', dispatched);
      }

      if (gap.hasGap) {
        log.warn({ walletId: wallet.id, ledgerDelta: gap.ledgerDelta }, '⚠️ Ledger gap detected in ingestion cursor');
        span.setAttribute('cursor.gapDetected', true);
        span.setAttribute('cursor.gapLedgerDelta', gap.ledgerDelta);
        await recoverFromLedgerGap(wallet);
      }

      span.setStatus({ code: SpanStatusCode.OK });
    } catch (err) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
      throw err;
    } finally {
      span.end();
    }
  });
}

function isPagingTokenAtLeast(candidate: string, current: string): boolean {
  if (!/^\d+$/.test(candidate) || !/^\d+$/.test(current)) return candidate === current;
  return BigInt(candidate) >= BigInt(current);
}

// Number of operations pulled from Horizon per cursor page
const CURSOR_PAGE_SIZE = 50;

// Upper bound on pages walked in a single catch-up pass, so a long outage
// cannot stall the catch-up run indefinitely
const MAX_CATCHUP_PAGES = 20;

/**
 * Persists the wallet's latest processed paging token. Unless
 * `skipGapCheck` is set (used internally while a bounded backfill is
 * already recovering from a previously detected gap), compares the new
 * token's ledger sequence against the currently persisted one and flags an
 * abnormally large jump as a ledger gap (see lib/cursor-recovery.ts) —
 * surfaced both to the caller (who triggers bounded backfill) and on the
 * IngestionCursor row itself for operator visibility.
 */
export async function saveCursor(
  walletId: string,
  pagingToken: string,
  options: { skipGapCheck?: boolean; previousPagingToken?: string | null } = {},
) {
  if (options.skipGapCheck) {
    await prisma.ingestionCursor.upsert({
      where: { walletId },
      create: { walletId, pagingToken },
      update: { pagingToken, ...buildCursorSuccessUpdate() },
    });
    return { hasGap: false, ledgerDelta: 0 };
  }

  // Callers that already track the wallet's in-flight cursor (the
  // catch-up/SSE loops) pass it explicitly to avoid a redundant read; other
  // callers (e.g. a bare processPaymentRecord() call) fall back to reading
  // the currently persisted token.
  const previousPagingToken =
    options.previousPagingToken !== undefined
      ? options.previousPagingToken
      : (await prisma.ingestionCursor.findUnique({ where: { walletId } }))?.pagingToken ?? null;

  const gap = detectLedgerGap(previousPagingToken, pagingToken);

  await prisma.ingestionCursor.upsert({
    where: { walletId },
    create: { walletId, pagingToken },
    update: {
      pagingToken,
      ...(gap.hasGap ? buildCursorGapUpdate(gap.ledgerDelta) : buildCursorSuccessUpdate()),
    },
  });

  if (gap.hasGap) {
    log.warn({ walletId, ledgerDelta: gap.ledgerDelta }, '⚠️ Ledger gap detected in ingestion cursor');
  }

  return gap;
}

/**
 * Recovers from a detected ledger gap with a bounded backfill: reprocesses
 * the most recent `BOUNDED_BACKFILL_LIMIT` payments for the wallet (rather
 * than an unbounded replay of unknown gap size), then clears the
 * gap_detected status. Already-recorded payments within that window are
 * skipped via the same duplicate-protected insert path as normal ingestion.
 */
async function recoverFromLedgerGap(wallet: { id: string; publicKey: string; userId?: string }) {
  log.warn(
    { walletId: wallet.id, publicKey: wallet.publicKey.substring(0, 8), limit: BOUNDED_BACKFILL_LIMIT },
    '🩹 Running bounded backfill to recover from detected ledger gap',
  );

  const recent = await stellar.getRecentPayments(wallet.publicKey, BOUNDED_BACKFILL_LIMIT);
  const ascending = [...recent].reverse();

  for (const record of ascending) {
    await processPaymentRecord(wallet, record, { skipGapCheck: true });
  }

  await prisma.ingestionCursor.update({
    where: { walletId: wallet.id },
    data: buildCursorGapClearedUpdate(),
  });

  log.info(
    { walletId: wallet.id, recovered: ascending.length },
    '✅ Bounded backfill complete, ingestion cursor gap cleared',
  );
}

/**
 * Returns the persisted paging token for a wallet, creating the cursor record
 * on first sight. A fresh cursor is seeded from the wallet's latest Horizon
 * paging token so that registering a wallet does not replay its whole history.
 */
export async function ensureCursor(wallet: {
  id: string;
  publicKey: string;
}): Promise<string> {
  const existing = await prisma.ingestionCursor.findUnique({
    where: { walletId: wallet.id },
  });
  if (existing) return existing.pagingToken;

  const pagingToken = await stellar.getLatestPagingToken(wallet.publicKey);
  const cursor = await prisma.ingestionCursor.upsert({
    where: { walletId: wallet.id },
    create: { walletId: wallet.id, pagingToken },
    update: {},
  });
  log.info(
    { walletPublicKey: wallet.publicKey.substring(0, 8), pagingToken },
    '🔖 Ensured ingestion cursor'
  );
  return cursor.pagingToken;
}

export async function processWalletPayments(wallet: { id: string; publicKey: string; userId?: string }) {
  return tracer.startActiveSpan('watcher.processWalletPayments', async (span) => {
    try {
      if (!wallet.publicKey || !isValidEd25519PublicKey(wallet.publicKey)) {
        log.warn(`[WatcherWorker] Skipping invalid public key checksum: "${wallet.publicKey}"`);
        span.setStatus({ code: SpanStatusCode.OK });
        span.end();
        return;
      }

      span.setAttribute('wallet.id', wallet.id);
      span.setAttribute('wallet.publicKey', wallet.publicKey);

      let cursor = await ensureCursor(wallet);

      for (let page = 0; page < MAX_CATCHUP_PAGES; page++) {
        const result = await stellar.getPaymentsSinceResult(wallet.publicKey, cursor, CURSOR_PAGE_SIZE);

        if (result.allNodesFailed) {
          // Provider outage: every Horizon failover node errored. Record it
          // on the cursor for operator visibility and stop this pass without
          // advancing the cursor — the next poll retries from the same
          // point, so no data is lost once Horizon recovers.
          const currentCursor = await prisma.ingestionCursor.findUnique({ where: { walletId: wallet.id } });
          await prisma.ingestionCursor.update({
            where: { walletId: wallet.id },
            data: buildCursorOutageUpdate(result.lastError || 'All Horizon nodes unreachable', currentCursor?.consecutiveFailures ?? 0),
          });
          log.warn(
            `[WatcherWorker] Provider outage for ${wallet.publicKey.substring(0, 8)}...: ${result.lastError}. Will retry next poll.`,
          );
          span.setStatus({ code: SpanStatusCode.OK });
          span.end();
          return;
        }

        const records = result.records;
        if (records.length === 0) {
          await prisma.ingestionCursor.update({
            where: { walletId: wallet.id },
            data: buildCursorSuccessUpdate(),
          });
          span.setStatus({ code: SpanStatusCode.OK });
          span.end();
          return;
        }

        for (const record of records) {
          await processPaymentRecord(wallet, record);
          const token = getHorizonPagingToken(record);
          if (token) {
            cursor = token;
          }
        }

        if (records.length < CURSOR_PAGE_SIZE) {
          span.setStatus({ code: SpanStatusCode.OK });
          span.end();
          return;
        }
      }

      log.warn(
        `[WatcherWorker] Catch-up page limit reached for ${wallet.publicKey.substring(0, 8)}..., resuming next poll from ${cursor}`,
      );
      span.setStatus({ code: SpanStatusCode.OK });
      span.end();
    } catch (err) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
      span.end();
      throw err;
    }
  });
}

export const handleStreamRecord = processPaymentRecord;

export type StreamHandlerOptions = {
  onmessage: (record: HorizonOperationRecord) => Promise<void>;
  onerror: (error: Error | unknown) => void;
};

export type StreamConnector = (
  cursor: string,
  handlers: StreamHandlerOptions
) => () => void;

export type StartHorizonSSEStreamOptions = {
  connector?: StreamConnector;
  reconnectDelayMs?: number;
  maxReconnectAttempts?: number;
  maxReconnectDelayMs?: number;
  maxQueuedMessages?: number;
};

export const streamMetrics = {
  reconnects: 0,
  heartbeatTimeouts: 0,
  messagesProcessed: 0,
  backpressureDropped: 0,
};

export async function startHorizonSSEStream(
  wallet: { id: string; publicKey: string; userId?: string },
  options: StartHorizonSSEStreamOptions = {}
): Promise<() => void> {
  return tracer.startActiveSpan('watcher.startHorizonSSEStream', async (span) => {
    let isClosed = false;
    let attempts = 1;
    let currentClose: (() => void) | null = null;
    let heartbeatTimeout: NodeJS.Timeout | null = null;
    let reconnectTimeout: NodeJS.Timeout | null = null;

    const noopClose = () => {};

    if (!wallet.publicKey || !isValidEd25519PublicKey(wallet.publicKey)) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: 'Invalid public key' });
      span.end();
      return noopClose;
    }

    const maxAttempts = options.maxReconnectAttempts ?? Infinity;
    const reconnectDelay = options.reconnectDelayMs ?? 1000;
    const maxReconnectDelay = options.maxReconnectDelayMs ?? reconnectDelay * 30;
    const maxQueuedMessages = options.maxQueuedMessages ?? 50;

    // Bounded backpressure: process messages one at a time in arrival order so a
    // slow consumer (e.g. a slow DB write) never lets concurrent handler calls pile
    // up. Once maxQueuedMessages are waiting behind the in-flight one, further
    // messages are dropped (and counted) rather than buffered without limit.
    let queueLength = 0;
    let streamGeneration = 0;
    let processingChain: Promise<void> = Promise.resolve();
    const enqueueMessage = (task: () => Promise<void>, generation: number): Promise<void> => {
      if (queueLength >= maxQueuedMessages) {
        streamMetrics.backpressureDropped++;
        log.warn(`[WatcherStream] ⚠️ Backpressure limit reached (${maxQueuedMessages}); dropping message for ${wallet.publicKey.substring(0, 8)}...`);
        if (generation === streamGeneration && !isClosed) {
          restartFromPersistedCursor(generation);
        }
        return Promise.resolve();
      }
      queueLength++;
      const run = processingChain
        .then(async () => {
          if (generation === streamGeneration) await task();
        })
        .catch((err: unknown) => {
          const errMsg = err instanceof Error ? err.message : String(err);
          log.error(`[WatcherStream] Error processing queued message: ${errMsg}`);
          restartFromPersistedCursor(generation);
        })
        .finally(() => {
          queueLength--;
        });
      processingChain = run;
      return run;
    };

    const defaultConnector: StreamConnector = (cursor, handlers) => {
      return stellar.multiNode.streamPaymentsMultiNode(
        wallet.publicKey,
        cursor,
        (record) => handlers.onmessage(record),
      );
    };

    const connector = options.connector ?? defaultConnector;

    const cleanupCurrent = () => {
      if (heartbeatTimeout) {
        clearTimeout(heartbeatTimeout);
        heartbeatTimeout = null;
      }
      if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
        reconnectTimeout = null;
      }
      if (currentClose) {
        try {
          currentClose();
        } catch {}
        currentClose = null;
      }
    };

    const restartFromPersistedCursor = (generation: number) => {
      if (isClosed || generation !== streamGeneration) return;
      streamGeneration++;
      cleanupCurrent();
      reconnectTimeout = setTimeout(() => {
        void connect();
      }, reconnectDelay);
    };

    const resetHeartbeat = () => {
      if (heartbeatTimeout) clearTimeout(heartbeatTimeout);
      heartbeatTimeout = setTimeout(() => {
        streamMetrics.heartbeatTimeouts++;
        log.warn(`[WatcherStream] ⚠️ Heartbeat timeout for ${wallet.publicKey.substring(0, 8)}... Reconnecting...`);
        connect();
      }, 60000);
    };

    const connect = async () => {
      if (isClosed) return;
      cleanupCurrent();

      try {
        const cursor = await ensureCursor(wallet);
        resetHeartbeat();
        const connectionGeneration = streamGeneration;

        const handlers: StreamHandlerOptions = {
          onmessage: async (record: HorizonOperationRecord) => {
            resetHeartbeat();
            attempts = 1;
            console.log(`[WatcherStream] ⚡ Live SSE stream message received: ${record.type}`);
            await enqueueMessage(async () => {
              await processPaymentRecord(wallet, record);
              streamMetrics.messagesProcessed++;
            }, connectionGeneration);
          },
          onerror: (error: Error | unknown) => {
            const errMsg = error instanceof Error ? error.message : String(error);
            console.error(`[WatcherStream] SSE stream error for ${wallet.publicKey.substring(0, 8)}...:`, errMsg);
            cleanupCurrent();
            if (isClosed) return;
            if (attempts < maxAttempts) {
              const delay = Math.min(reconnectDelay * 2 ** (attempts - 1), maxReconnectDelay);
              attempts++;
              streamMetrics.reconnects++;
              reconnectTimeout = setTimeout(() => {
                connect();
              }, delay);
            }
          },
        };

        currentClose = connector(cursor, handlers);
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[WatcherStream] Failed to open SSE stream: ${errMsg}`);
        if (!isClosed && attempts < maxAttempts) {
          const delay = Math.min(reconnectDelay * 2 ** (attempts - 1), maxReconnectDelay);
          attempts++;
          streamMetrics.reconnects++;
          reconnectTimeout = setTimeout(() => {
            void connect();
          }, delay);
        }
      }
    };

    try {
      await connect();
      span.setStatus({ code: SpanStatusCode.OK });
      span.end();
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      span.setStatus({ code: SpanStatusCode.ERROR, message: errMsg });
      span.end();
    }

    return () => {
      isClosed = true;
      cleanupCurrent();
    };
  });
}

/**
 * Logs the reason, stops the memory monitor's own timer, and exits the
 * process so the supervisor (workers/supervisor.ts) respawns it fresh with
 * a clean heap — a controlled exit chosen before the OS OOM-kills the
 * process mid-request, not an uncontrolled crash.
 */
export function gracefulRestart(reason: string, snapshot: MemorySnapshot): void {
  log.error(
    `[WatcherWorker] 💥 Initiating graceful restart: ${reason} ` +
      `(heap ${(snapshot.usageRatio * 100).toFixed(1)}%, ${Math.round(snapshot.heapUsed / 1024 / 1024)}MB used)`,
  );
  memoryMonitor?.stop();
  // setImmediate gives the error log above a turn of the event loop to
  // flush to stdout/stderr before the process exits.
  setImmediate(() => process.exit(1));
}

export function startMemoryMonitor(): MemoryMonitor {
  const monitor = new MemoryMonitor({
    onCleanup: (snapshot, gcRan) => {
      log.warn(
        `[WatcherWorker] Heap cleanup pass ${gcRan ? "ran" : "skipped (start with --expose-gc to enable it)"} ` +
          `at ${(snapshot.usageRatio * 100).toFixed(1)}% usage.`,
      );
    },
    onRestartRequired: (snapshot) => gracefulRestart("sustained high heap usage", snapshot),
  });
  monitor.start();
  memoryMonitor = monitor;
  return monitor;
}

/**
 * Concurrently processes wallets using a bounded worker pool to prevent starvation (#309).
 */
export async function processWalletsConcurrently(
  wallets: Array<{ id: string; publicKey: string; userId?: string }>,
  concurrency = env.WATCHER_WALLET_CONCURRENCY,
): Promise<void> {
  const queue = [...wallets];
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length > 0) {
      const wallet = queue.shift();
      if (!wallet) break;
      try {
        await processWalletPayments({ id: wallet.id, publicKey: wallet.publicKey, userId: wallet.userId });
      } catch (err: any) {
        log.error(`[WatcherWorker] Error processing wallet ${wallet.publicKey}:`, err.message || err);
      }
    }
  });
  await Promise.all(workers);
}

export async function pollOnce() {
  return tracer.startActiveSpan('watcher.pollOnce', async (pollSpan) => {
    try {
      const wallets = await prisma.wallet.findMany();
      if (wallets.length === 0) {
        pollSpan.setStatus({ code: SpanStatusCode.OK });
        pollSpan.end();
        return;
      }
      for (const wallet of wallets) {
        try {
          await processWalletPayments({ id: wallet.id, publicKey: wallet.publicKey, userId: wallet.userId });
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          console.error(`[WatcherWorker] Error processing wallet ${wallet.publicKey}:`, errMsg);
        }
      }
      const contractIds = getActiveContractIds();
      if (contractIds.length > 0) {
        for (const contractId of contractIds) {
          try {
            await processSorobanContractEvents(contractId);
          } catch (err: unknown) {
            const errMsg = err instanceof Error ? err.message : String(err);
            console.error(`[WatcherWorker] Error processing contract ${contractId}:`, errMsg);
          }
        }
      }
      pollSpan.setStatus({ code: SpanStatusCode.OK });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error('[WatcherWorker] Error in pollOnce:', errMsg);
      pollSpan.setStatus({ code: SpanStatusCode.OK });
    } finally {
      pollSpan.end();
    }
  });
}

export async function runWatcher() {
  log.info("[WatcherWorker] 🚀 Starting Stellar Testnet Watcher Worker...");
  const walletStreams = new Map<string, () => void>();

  // Without an SDK registered the OpenTelemetry API is a no-op, so webhook
  // dispatch spans would be silently dropped instead of reaching Jaeger.
  await startTelemetry(env.OTEL_WORKER_SERVICE_NAME);
  watcherLifecycle.registerCleanup('telemetry', async () => {
    await shutdownTelemetry();
  });

  // Opt-in scrape endpoint; unset by default so no listener is opened.
  await startWorkerMetricsServer(env.WORKER_METRICS_PORT);
  watcherLifecycle.registerCleanup('metricsServer', async () => {
    await stopWorkerMetricsServer();
  });

  startMemoryMonitor();

  watcherLifecycle.registerCleanup('memoryMonitor', () => {
    memoryMonitor?.stop();
  });
  watcherLifecycle.registerCleanup('horizonStreams', () => {
    for (const close of walletStreams.values()) close();
    walletStreams.clear();
  });
  watcherLifecycle.registerCleanup('prisma', async () => {
    await prisma.$disconnect();
  });

  await loadContractRegistry();

  const poll = async () => {
    return watcherLifecycle.runTask(async () => {
      return tracer.startActiveSpan('watcher.poll', async (pollSpan) => {
        try {
          const wallets = await prisma.wallet.findMany();
          const activeWalletIds = new Set(wallets.map((wallet) => wallet.id));
          for (const [walletId, close] of walletStreams) {
            if (!activeWalletIds.has(walletId)) {
              close();
              walletStreams.delete(walletId);
            }
          }
          if (wallets.length === 0) {
            log.info(
              "[WatcherWorker] No wallets registered in DB to watch. Waiting for next poll...",
            );
            pollSpan.setStatus({ code: SpanStatusCode.OK });
            pollSpan.end();
            return;
          }

          log.info(
            `[WatcherWorker] Checking ${wallets.length} registered wallet(s)...`,
          );
          for (const wallet of wallets) {
            await processWalletPayments({ id: wallet.id, publicKey: wallet.publicKey, userId: wallet.userId });
            if (!walletStreams.has(wallet.id)) {
              walletStreams.set(
                wallet.id,
                await startHorizonSSEStream({
                  id: wallet.id,
                  publicKey: wallet.publicKey,
                  userId: wallet.userId,
                }),
              );
            }
          }

          const contractIds = getActiveContractIds();
          if (contractIds.length > 0) {
            log.info(
              `[WatcherWorker] Processing ${contractIds.length} Soroban contract subscriptions...`,
            );
            for (const contractId of contractIds) {
              await processSorobanContractEvents(contractId);
            }
          }
          pollSpan.setStatus({ code: SpanStatusCode.OK });
        } catch (err) {
          pollSpan.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
          throw err;
        } finally {
          pollSpan.end();
        }
      });
    });
  };

  // Start Horizon SSE streams for live ingestion (#523)
  const wallets = await prisma.wallet.findMany();
  const streamClosures: Array<() => void> = [];
  for (const wallet of wallets) {
    try {
      const close = await startHorizonSSEStream(wallet);
      streamClosures.push(close);
      watcherLifecycle.registerCleanup(`sse-stream-${wallet.id}`, close);
    } catch (err: any) {
      log.error(
        `[WatcherWorker] Failed to start SSE stream for wallet ${wallet.publicKey}:`,
        err?.message || err,
      );
    }
  }

  // Also keep a lightweight periodic poll as fallback for catch-up safety
  await poll();

  const pollTimer = setInterval(poll, 30000);
  watcherLifecycle.trackInterval(pollTimer);

  const registryTimer = setInterval(() => {
    loadContractRegistry();
  }, 300000);
  watcherLifecycle.trackInterval(registryTimer);
}

async function processSorobanContractEvents(contractId: string) {
  return tracer.startActiveSpan('watcher.processSorobanContractEvents', async (span) => {
    try {
      span.setAttribute('contract.id', contractId);
      const latestLedger = await getSorobanLatestLedger();
      if (latestLedger === 0) {
        span.setStatus({ code: SpanStatusCode.OK });
        span.end();
        return;
      }

      const lastSnapshot = await prisma.sorobanEventSnapshot.findFirst({
        where: { contractId },
        orderBy: { ledgerSeq: "desc" },
        select: { ledgerSeq: true },
      });

      const startLedger = lastSnapshot
        ? lastSnapshot.ledgerSeq + 1
        : latestLedger - 1000;
      if (startLedger > latestLedger) {
        span.setStatus({ code: SpanStatusCode.OK });
        span.end();
        return;
      }

      const { fetchContractEventsInRange } = await import("../lib/soroban");

      for await (const eventBatch of fetchContractEventsInRange(
        contractId,
        startLedger,
        latestLedger,
      )) {
        for (const event of asEnrichedSorobanEvents(eventBatch)) {
          const parsed = parseSacTransferEvent(event);
          if (!parsed) continue;

          const routes = routeEventToUsers(event);

          for (const route of routes) {
            log.info(
              `[SorobanRouter] Event ${route.topic} from ${contractId.substring(0, 8)}... routed to ${route.userIds.length} user(s)`,
            );

            // `event.ledgerSeq` is always set by fetchContractEventsInRange
            // (it enriches every event with `ledgerSeq = evt.ledger || currentStart`),
            // so we no longer need (parsed as any).ledgerSeq.
            const ledgerSeq = event.ledgerSeq ?? 0;

            try {
              await prisma.sorobanEventSnapshot.upsert({
                where: {
                  contractId_ledgerSeq_from_to_amount: {
                    contractId: parsed.contractId,
                    ledgerSeq,
                    from: parsed.from,
                    to: parsed.to,
                    amount: parsed.amount,
                  },
                },
                create: {
                  contractId: parsed.contractId,
                  from: parsed.from,
                  to: parsed.to,
                  amount: parsed.amount,
                  ledgerSeq,
                },
                update: {},
              });

              // Also store as Payment if this transfer is relevant to a watched wallet (#528)
              const wallets = await prisma.wallet.findMany({
                where: {
                  OR: [
                    { publicKey: parsed.to },
                    { publicKey: parsed.from },
                    { userId: { in: route.userIds } },
                  ],
                },
              });
              for (const wallet of wallets) {
                const txHash = (event.txHash || `${ledgerSeq}-${event.topic?.toString() || ''}`) as string;
                const receivedAt = new Date(Date.now());
                const sacRecord: any = {
                  type: 'contract_event',
                  contractId: parsed.contractId,
                  transaction_hash: txHash,
                  created_at: receivedAt.toISOString(),
                  topic: event.topic,
                  value: event.value || event.data || {},
                };
                try {
                  await processPaymentRecord(wallet, sacRecord);
                } catch (e) {
                  // best effort
                }
              }
            } catch (err: unknown) {
              const prismaErr = err as { code?: string; message?: string };
              if (prismaErr.code !== "P2025") {
                console.warn(
                  "[SorobanRouter] Error storing event snapshot:",
                  prismaErr.message,
                );
              }
            }
          }
        }
      }
      span.setStatus({ code: SpanStatusCode.OK });
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : String(error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: errMsg });
      console.error(
        `[SorobanRouter] Error processing contract ${contractId}:`,
        errMsg,
      );
    } finally {
      span.end();
    }
  });
}

if (require.main === module) {
  registerSupervisorHeartbeat();
  startMemoryMonitor();
  runWatcher();

  // Issue #20: Graceful shutdown for the watcher worker process
  let watcherIntervalId: NodeJS.Timeout | undefined;

  // Patch runWatcher to capture the interval handle so we can stop it
  const originalSetInterval = global.setInterval;
  (global as any).setInterval = (fn: (...args: any[]) => void, delay?: number, ...args: any[]) => {
    const id = originalSetInterval(fn, delay, ...args);
    watcherIntervalId = id;
    return id;
  };

  const shutdownWorker = async (signal: string) => {
    console.log(`[WatcherWorker] Received ${signal}. Shutting down gracefully...`);

    if (watcherIntervalId !== undefined) {
      clearInterval(watcherIntervalId);
      watcherIntervalId = undefined;
    }

    try {
      await prisma.$disconnect();
      console.log('[WatcherWorker] Shutdown complete.');
      process.exit(0);
    } catch (err) {
      console.error('[WatcherWorker] Error during shutdown:', err);
      process.exit(1);
    }
  };

  process.once('SIGTERM', () => shutdownWorker('SIGTERM'));
  process.once('SIGINT', () => shutdownWorker('SIGINT'));
}
