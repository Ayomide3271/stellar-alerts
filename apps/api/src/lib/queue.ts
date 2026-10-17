import { Queue, QueueEvents, Job, Worker } from 'bullmq';
import CircuitBreaker from 'opossum';
import { env } from '../config/env';
import { fetchWithTimeout, withDeadline } from './external-request';
import { workerFairnessManager } from './rate-budget';
import { registerRedisCleanupTask, redisCache } from './redis';
import { cryptoVault } from '../utils/crypto-vault';
import { applyWebhookPayloadTemplate } from '../utils/payload-template';
import { adaptiveWebhookRateLimiter, waitForAdaptiveBackoff } from '../utils/rate-limiter';
import { buildWebhookSignatureHeaders } from '../utils/webhook-signer';
import { dispatchWhatsAppAlert, WhatsAppInvalidNumberError } from '../utils/whatsapp';
import { prisma } from './prisma';
import { createLogger } from './logger';
import { publishDeliveryEvent } from './realtime';
import { deliverWithIdempotency } from './delivery';
import { instrumentedWebhookFetch } from './webhook-telemetry';
import { persistDeadLetter } from './dead-letter';
import { ssrfSafeFetch, validateUrlForSsrf } from '../utils/ssrf';
import { decryptPersonalField } from '../utils/privacy';
import { emailService } from '../services/email.service';
import { buildTelegramPaymentCard, dispatchTelegramAlert } from '../utils/telegram-dispatcher';
import { dispatchDiscordAlert } from '../utils/discord';
import { dispatchSlackAlert, isValidSlackWebhookUrl } from '../utils/slack';
import { dispatchPushNotification, PushNotificationData } from '../utils/push-protocol';
import { classifyWorkerError, getWorkerMaxAttempts, PermanentWorkerError } from './worker-retry-policy';

function decryptWebhookSecret(webhook: {
  keyVersion: number;
  secretIv: string;
  secretAuthTag: string;
  secretCiphertext: string;
}): string {
  const encrypted = [
    String(webhook.keyVersion),
    webhook.secretIv,
    webhook.secretAuthTag,
    webhook.secretCiphertext,
  ].join(':');
  return cryptoVault.decrypt(encrypted);
}

const queueLog = createLogger({ module: 'Queue' });

export interface AlertJobData {
  paymentId: string;
  txHash: string;
  walletId: string;
  amount: string;
  asset: string;
  assetIssuer?: string | null;
  fromAddress: string;
  receivedAt: string;
  /** Optional alert filter config — if provided, alerts are suppressed when rules fail */
  filterConfig?: AlertFilterConfig;
}

const redisHost = process.env.REDIS_HOST || "localhost";
const redisPort = parseInt(process.env.REDIS_PORT || "6379", 10);
const WEBHOOK_TIMEOUT_MS = 10000;
const CIRCUIT_BREAKER_THRESHOLD = 10; // 10 consecutive 5xx failures opens circuit
const CIRCUIT_BREAKER_TIMEOUT = 60000; // 60 second timeout before half-open

export let alertQueue: Queue<AlertJobData> | null = null;
export let dlqQueue: Queue<AlertJobData> | null = null;
export let alertQueueEvents: QueueEvents | null = null;
export let alertWorker: Worker<AlertJobData> | null = null;

const circuitBreakers = new Map<string, CircuitBreaker<any>>();

interface CircuitBreakerState {
  state: "closed" | "open" | "half-open";
  failureCount: number;
  openedAt?: number;
  lastFailureAt?: number;
}

const CIRCUIT_BREAKER_REDIS_PREFIX = "circuit_breaker:";

async function syncCircuitBreakerStateToRedis(webhookId: string, state: CircuitBreakerState): Promise<void> {
  try {
    const key = `${CIRCUIT_BREAKER_REDIS_PREFIX}${webhookId}`;
    const value = JSON.stringify(state);
    await redisCache.set(key, value, 3600); // 1 hour TTL
  } catch (error: any) {
    console.error(`[CircuitBreaker] Failed to sync state to Redis for webhook ${webhookId}: ${error.message}`);
  }
}

async function loadCircuitBreakerStateFromRedis(webhookId: string): Promise<CircuitBreakerState | null> {
  try {
    const key = `${CIRCUIT_BREAKER_REDIS_PREFIX}${webhookId}`;
    const value = await redisCache.get(key);
    if (!value) return null;
    return JSON.parse(value) as CircuitBreakerState;
  } catch (error: any) {
    console.error(`[CircuitBreaker] Failed to load state from Redis for webhook ${webhookId}: ${error.message}`);
    return null;
  }
}

export { buildTelegramPaymentCard };

function isPublicChannel(chatId: string): boolean {
  return chatId.startsWith('@') || chatId.startsWith('-100');
}

/**
 * Records a channel delivery attempt and skips re-dispatching a channel that
 * already has a logged attempt for this payment, so BullMQ's job-level retry
 * (5 attempts, exponential backoff — see alertQueue config) doesn't double-send
 * to Discord/Slack on retry once a prior attempt already succeeded.
 */
async function alreadyDelivered(paymentId: string, channel: string): Promise<boolean> {
  const existing = await prisma.deliveryLog.findUnique({
    where: { paymentId_channel: { paymentId, channel } },
  });
  return existing?.status === 'sent';
}

async function recordDelivery(paymentId: string, channel: string, ok: boolean, error?: string) {
  await prisma.deliveryLog.upsert({
    where: { paymentId_channel: { paymentId, channel } },
    create: { paymentId, channel, status: ok ? 'sent' : 'failed', error: error ?? null, attempt: 1 },
    update: {
      status: ok ? 'sent' : 'failed',
      error: error ?? null,
      attempt: { increment: 1 },
    },
  });
}

async function assertBotIsChannelAdmin(botToken: string, chatId: string): Promise<void> {
  const me = await fetchWithTimeout(
    `https://api.telegram.org/bot${botToken}/getMe`,
    {},
    env.NOTIFICATION_PROVIDER_TIMEOUT_MS,
    undefined,
    'Telegram',
  );
  if (!me.ok) throw new Error('Telegram bot identity check failed');
  const bot = (await me.json()) as { result?: { id?: number } };
  if (!bot.result?.id) throw new Error('Telegram bot identity was not returned');
  const membership = await fetchWithTimeout(
    `https://api.telegram.org/bot${botToken}/getChatMember?chat_id=${encodeURIComponent(chatId)}&user_id=${bot.result.id}`,
    {},
    env.NOTIFICATION_PROVIDER_TIMEOUT_MS,
    undefined,
    'Telegram',
  );
  if (!membership.ok) throw new Error('Telegram channel permission check failed');
  const result = (await membership.json()) as { result?: { status?: string } };
  if (!['administrator', 'creator'].includes(result.result?.status ?? '')) {
    throw new Error('Telegram bot must be an administrator of the channel');
  }
}

async function getOrCreateCircuitBreaker(
  webhookId: string,
): Promise<CircuitBreaker<any>> {
  if (circuitBreakers.has(webhookId)) {
    return circuitBreakers.get(webhookId)!;
  }

  const breaker: CircuitBreaker<any> = new CircuitBreaker(
    async (url: string, payload: string, headers: Record<string, string>, meta?: WebhookDispatchMeta) => {
      // Routed through the instrumented transport so every attempt contributes
      // DNS / TCP / TLS / TTFB / response-stream spans and histograms, and so
      // the subscriber receives a W3C traceparent it can join.
      const response = await instrumentedWebhookFetch(url, {
        method: "POST",
        headers,
        body: payload,
        timeoutMs: env.WEBHOOK_TIMEOUT_MS,
        webhookId: meta?.webhookId,
        traceparent: meta?.traceparent,
      });

      if (response.status === 429) {
        const error = new Error(`Rate limited: ${response.status}`) as Error & {
          statusCode?: number;
          headers?: Headers;
        };
        error.statusCode = 429;
        error.headers = response.headers;
        throw error;
      }

      if (response.status >= 500) {
        throw new Error(`Server error: ${response.status}`);
      }

      return response;
    },
    {
      timeout: WEBHOOK_TIMEOUT_MS,
      errorThresholdPercentage: 100,
      volumeThreshold: CIRCUIT_BREAKER_THRESHOLD,
      rollingCountTimeout: 60000,
      name: `webhook-${webhookId}`,
    },
  );

  // Initialize with Redis sync
  const redisState = await loadCircuitBreakerStateFromRedis(webhookId);
  if (redisState) {
    if (redisState.state === "open") {
      breaker.open();
    } else if (redisState.state === "half-open") {
      breaker.halfOpen();
    } else {
      breaker.close();
    }
    console.log(`[CircuitBreaker] Initialized webhook ${webhookId} with Redis state: ${redisState.state}`);
  }

  // Add event listeners to sync state changes to Redis
  breaker.on('open', () => {
    syncCircuitBreakerStateToRedis(webhookId, {
      state: 'open',
      failureCount: CIRCUIT_BREAKER_THRESHOLD,
      openedAt: Date.now(),
    });
  });

  breaker.on('halfOpen', () => {
    syncCircuitBreakerStateToRedis(webhookId, {
      state: 'half-open',
      failureCount: 0,
    });
  });

  breaker.on('close', () => {
    syncCircuitBreakerStateToRedis(webhookId, {
      state: 'closed',
      failureCount: 0,
    });
  });

  circuitBreakers.set(webhookId, breaker);
  return breaker;
}

async function updateCircuitBreakerState(
  webhookId: string,
  state: "closed" | "open" | "half-open",
  failureCount: number = 0,
) {
  await prisma.webhookCircuitBreaker.upsert({
    where: { webhookId },
    create: {
      webhookId,
      state,
      failureCount,
      openedAt: state === "open" ? new Date() : null,
    },
    update: {
      state,
      failureCount,
      lastFailureAt: state === "open" ? new Date() : undefined,
      openedAt: state === "open" ? new Date() : undefined,
    },
  });

  // Sync to Redis for distributed state sharing
  await syncCircuitBreakerStateToRedis(webhookId, {
    state,
    failureCount,
    openedAt: state === "open" ? Date.now() : undefined,
    lastFailureAt: state === "open" ? Date.now() : undefined,
  });
}

export async function dispatchWebhookAndLog(
  webhookId: string,
  payload: any,
  retryAfterBackoff = false,
  traceparent?: string,
) {
  let targetUrl: string | undefined;

  try {
    const webhook = await prisma.webhook.findUnique({
      where: { id: webhookId },
      include: { circuitBreaker: true },
    });

    if (!webhook) {
      queueLog.warn(`[WebhookDispatch] Webhook ${webhookId} not found`);
      return;
    }

    targetUrl = webhook.url;

    // Validate webhook URL against SSRF rules (#312)
    try {
      await validateUrlForSsrf(webhook.url);
    } catch (ssrfErr: any) {
      queueLog.error(`[WebhookDispatch] SSRF validation blocked delivery to ${webhook.url}: ${ssrfErr.message}`);
      await prisma.webhookLog.create({
        data: {
          webhookId,
          error: `SSRF blocked: ${ssrfErr.message}`,
        },
      });
      return;
    }

    // Check circuit breaker state
    if (webhook.circuitBreaker?.state === "open") {
      const openedAt = webhook.circuitBreaker.openedAt?.getTime() || 0;
      const now = Date.now();

      if (now - openedAt < CIRCUIT_BREAKER_TIMEOUT) {
        queueLog.warn(
          `[WebhookDispatch] Circuit breaker OPEN for webhook ${webhookId}, skipping dispatch`,
        );
        await prisma.webhookLog.create({
          data: {
            webhookId,
            error: "Circuit breaker is open, endpoint temporarily disabled",
          },
        });
        return;
      } else {
        // Transition to half-open
        await updateCircuitBreakerState(webhookId, "half-open");
        queueLog.info(
          `[WebhookDispatch] Circuit breaker HALF-OPEN for webhook ${webhookId}, attempting recovery`,
        );
      }
    }

    const adaptiveDelayMs = adaptiveWebhookRateLimiter.getDelayMs(webhook.url);
    if (adaptiveDelayMs > 0) {
      queueLog.warn(`[WebhookDispatch] Pausing webhook domain for ${adaptiveDelayMs}ms before retry`);
      await waitForAdaptiveBackoff(adaptiveDelayMs);
    }

    const templateResult = applyWebhookPayloadTemplate(payload, webhook.payloadTemplate);
    if (!templateResult.ok) {
      queueLog.warn(
        `[WebhookDispatch] Payload template error for webhook ${webhookId}: ${templateResult.error}`,
      );
      await prisma.webhookLog.create({
        data: {
          webhookId,
          error: `Payload template ${templateResult.phase} error: ${templateResult.error}`,
        },
      });
      return;
    }

    const payloadString = templateResult.body;
    const webhookSecret = decryptWebhookSecret(webhook);
    const signatureHeaders = buildWebhookSignatureHeaders(payloadString, webhookSecret);

    const breaker = await getOrCreateCircuitBreaker(webhookId);
    const dispatchMeta: WebhookDispatchMeta = { webhookId, traceparent };
    const response = await breaker.fire(webhook.url, payloadString, {
      "Content-Type": "application/json",
      ...signatureHeaders,
    }, dispatchMeta);

    const responseBody = await response.text();

    const deliveryLog = await prisma.webhookLog.create({
      data: {
        webhookId,
        statusCode: response.status,
        responseBody: responseBody.substring(0, 5000),
      },
    });
    await publishDeliveryEvent(webhook.userId, deliveryLog);
    adaptiveWebhookRateLimiter.clear(webhook.url);

    // Reset circuit breaker to closed on success
    if (webhook.circuitBreaker?.state === "half-open") {
      await updateCircuitBreakerState(webhookId, "closed", 0);
      queueLog.info(
        `[WebhookDispatch] Circuit breaker CLOSED for webhook ${webhookId}, service recovered`,
      );
    }

    queueLog.info(
      `[WebhookDispatch] Webhook ${webhookId} dispatched, status: ${response.status}`,
    );
  } catch (error: any) {
    // Handle circuit breaker open error
    if (error.message && error.message.includes("breaker is open")) {
      queueLog.warn(
        `[WebhookDispatch] Circuit breaker prevented request for webhook ${webhookId}`,
      );
      await prisma.webhookLog.create({
        data: {
          webhookId,
          error: "Circuit breaker is open",
        },
      });
      return;
    }

    if ((error.statusCode === 429 || error.message?.includes("Rate limited")) && targetUrl) {
      const delayMs = adaptiveWebhookRateLimiter.recordRateLimit(targetUrl, error.headers);
      await prisma.webhookLog.create({
        data: {
          webhookId,
          statusCode: 429,
          error: `Endpoint rate limited webhook delivery; retrying after ${delayMs}ms`,
        },
      });

      if (!retryAfterBackoff) {
        queueLog.warn(`[WebhookDispatch] Rate limited by ${targetUrl}; retrying after ${delayMs}ms`);
        await waitForAdaptiveBackoff(delayMs);
        return dispatchWebhookAndLog(webhookId, payload, true, traceparent);
      }

      queueLog.warn(`[WebhookDispatch] Endpoint still rate limited after adaptive retry for ${webhookId}`);
      return;
    }

    // Track consecutive failures
    const breaker = circuitBreakers.get(webhookId);
    let failureCount = 1;

    if (breaker && typeof breaker.stats === "object") {
      const stats = breaker.stats();
      failureCount = stats?.failures || 1;
    }

    // Open circuit if threshold reached
    if (failureCount >= CIRCUIT_BREAKER_THRESHOLD) {
      await updateCircuitBreakerState(webhookId, "open", failureCount);
      queueLog.error(
        `[WebhookDispatch] Circuit breaker OPENED for webhook ${webhookId} after ${failureCount} failures`,
      );
    } else {
      await updateCircuitBreakerState(webhookId, "closed", failureCount);
    }

    const failureLog = await prisma.webhookLog.create({
      data: {
        webhookId,
        error: error.message.substring(0, 1000),
      },
    });

    const failedWebhook = await prisma.webhook.findUnique({
      where: { id: webhookId },
      select: { userId: true },
    });
    if (failedWebhook) {
      await publishDeliveryEvent(failedWebhook.userId, failureLog);
    }

    queueLog.error(
      `[WebhookDispatch] Failed to dispatch webhook ${webhookId}: ${error.message}`,
    );
  }
}

function validateAlertJobData(data: AlertJobData): void {
  if (!data || typeof data !== 'object' || typeof data.paymentId !== 'string' || data.paymentId.length === 0) {
    throw new PermanentWorkerError('Alert job is missing paymentId', 'missing_payment_id');
  }
  if (typeof data.txHash !== 'string' || data.txHash.length === 0) {
    throw new PermanentWorkerError('Alert job is missing txHash', 'missing_tx_hash');
  }
}

export const paymentAlertWorkerProcessor = async (job: { data: AlertJobData }) => {
  try {
    validateAlertJobData(job.data);
    return await processAlertDispatch(job.data);
  } catch (error) {
    const classification = classifyWorkerError(error);
    if (classification.classification === 'permanent' && !(error instanceof PermanentWorkerError)) {
      throw new PermanentWorkerError(classification.message, classification.reason);
    }
    throw error;
  }
};

export function createRedisConnectionConfig() {
  const sentinelsRaw = process.env.REDIS_SENTINELS;
  const masterName = process.env.REDIS_SENTINEL_MASTER_NAME || "mymaster";
  const sentinelPassword = process.env.REDIS_SENTINEL_PASSWORD;

  if (sentinelsRaw) {
    const sentinels = sentinelsRaw.split(',').map((s) => {
      const parts = s.trim().split(':');
      return { host: parts[0] || 'localhost', port: parseInt(parts[1] || '26379', 10) };
    });

    queueLog.info(`[Queue] 🛡️ Configuring Redis Sentinel failover with master "${masterName}" across ${sentinels.length} sentinel(s)`);

    return {
      sentinels,
      name: masterName,
      sentinelPassword,
      role: 'master',
      enableReadyCheck: false,
      maxRetriesPerRequest: null,
      retryStrategy: (times: number) => Math.min(times * 100, 3000),
      reconnectOnError: (err: Error) => {
        if (err.message && err.message.includes('READONLY')) {
          queueLog.warn('[Queue] ⚡ Master promoted during Sentinel failover (READONLY received), reconnecting...');
          return true;
        }
        return false;
      },
    };
  }

  const redisHost = process.env.REDIS_HOST || "localhost";
  const redisPort = parseInt(process.env.REDIS_PORT || "6379", 10);
  return {
    host: redisHost,
    port: redisPort,
    lazyConnect: true,
    maxRetriesPerRequest: null,
  };
}

try {
  const connection = createRedisConnectionConfig() as any;

  alertQueue = new Queue<AlertJobData>("payment-alerts", {
    connection,
    defaultJobOptions: {
      attempts: getWorkerMaxAttempts(),
      backoff: {
        type: "exponential",
        delay: 2000,
      },
      removeOnComplete: 100,
      removeOnFail: 500,
    },
  });

  dlqQueue = new Queue<AlertJobData>('payment-alerts-dlq', { connection });
  alertQueueEvents = new QueueEvents('payment-alerts', { connection });

  alertWorker = new Worker<AlertJobData>(
    'payment-alerts',
    paymentAlertWorkerProcessor,
    { connection, concurrency: env.ALERT_WORKER_CONCURRENCY },
  );

  registerRedisCleanupTask(async () => {
    if (alertWorker) await alertWorker.close().catch(() => {});
    if (alertQueueEvents) await alertQueueEvents.close().catch(() => {});
    if (alertQueue) await alertQueue.close().catch(() => {});
    if (dlqQueue) await dlqQueue.close().catch(() => {});
  });

  alertQueueEvents.on("failed", async ({ jobId, failedReason }) => {
    await failedJobHandler({ jobId, failedReason });
  });

  queueLog.info({ host: redisHost, port: redisPort }, '📡 BullMQ payment-alerts queue initialized');
} catch (err: any) {
  queueLog.warn({ err: err.message }, 'Could not initialize BullMQ queue');
}

export async function failedJobHandler({ jobId, failedReason }: { jobId?: string; failedReason?: string }) {
  if (!jobId || !alertQueue || !dlqQueue) return;
  try {
    const job = await Job.fromId(alertQueue, jobId);
    if (!job) return;

    const classification = classifyWorkerError(failedReason || 'Alert delivery job failed');
    const maxAttempts = job.opts.attempts || getWorkerMaxAttempts();
    const reachedAttemptCap = job.attemptsMade >= maxAttempts;

    if (classification.classification === 'permanent' || reachedAttemptCap) {
      await dlqQueue.add("dispatch-alert-failed", job.data, {
        jobId: `dlq-${jobId}`,
      });
      const wallet = job.data?.walletId
        ? await prisma.wallet.findUnique({ where: { id: job.data.walletId }, select: { userId: true } })
        : null;
      await persistDeadLetter({
        channel: "queue",
        destination: jobId,
        deliveryKey: `queue:${jobId}`,
        paymentId: (job.data as AlertJobData | undefined)?.paymentId ?? null,
        userId: wallet?.userId ?? null,
        payload: job.data ?? null,
        error: classification.message || "Alert delivery job reached max attempts",
        failureClass: classification.classification,
        failureReason: reachedAttemptCap && classification.classification === 'retryable'
          ? 'max_attempts_exceeded'
          : classification.reason,
        jobId,
        attemptsMade: job.attemptsMade,
        maxAttempts,
      });
      queueLog.info(
        `[Queue] 📨 Moved failed job ${jobId} to DLQ. Reason: ${failedReason}`,
      );
    }
  } catch (err: any) {
    queueLog.warn(`[Queue] Failed to process DLQ routing for ${jobId}: ${err.message}`);
  }
}

export async function processAlertDispatch(data: AlertJobData) {
  await workerFairnessManager.acquireWalletSlot(data.walletId);
  try {
    // Get user's active webhooks
    let wallet = await prisma.wallet.findUnique({
      where: { id: data.walletId },
      include: {
        user: {
          include: {
            webhooks: {
              where: { isActive: true },
            },
            notifyPrefs: true,
          },
        },
      },
    });

    if (!wallet && data.paymentId) {
      const payment: any = await prisma.payment.findUnique({
        where: { id: data.paymentId },
        include: {
          wallet: {
            include: {
              user: {
                include: {
                  webhooks: {
                    where: { isActive: true },
                  },
                  notifyPrefs: true,
                },
              },
            },
          },
        },
      });
      if (payment?.wallet) {
        wallet = payment.wallet;
      }
    }

    // Prepare webhook payload
    const webhookPayload = {
      event: "payment.received",
      timestamp: new Date().toISOString(),
      data: {
        paymentId: data.paymentId,
        txHash: data.txHash,
        amount: data.amount,
        asset: data.asset,
        assetIssuer: data.assetIssuer,
        fromAddress: data.fromAddress,
        receivedAt: data.receivedAt,
      },
    };

    const userId = wallet?.user?.id ?? null;

    const recordDeadLetter = (channel: string, destination: string | null, err: any) =>
      persistDeadLetter({
        paymentId: data.paymentId,
        userId,
        channel,
        destination,
        payload: webhookPayload,
        error: err?.message ?? String(err),
      });

    // Dispatch to all user webhooks (non-blocking). Every webhook POST is
    // wrapped in the delivery idempotency gate so concurrent duplicate jobs
    // produce a single provider request and restarted jobs never re-send a
    // delivery that already succeeded (#272).
    if (wallet?.user?.webhooks && wallet.user.webhooks.length > 0) {
      await Promise.all(
        wallet.user.webhooks.map((webhook) =>
          deliverWithIdempotency(
            {
              paymentId: data.paymentId,
              channel: "webhook",
              destination: webhook.id,
              userId,
            },
            async () => {
              await workerFairnessManager.acquireProviderBudget('webhook');
              await dispatchWebhookAndLog(webhook.id, webhookPayload, false, data.traceparent);
            },
          ).catch((err: any) => {
            queueLog.warn(`[Worker] Webhook dispatch had errors: ${err.message}`);
          }),
        ),
      );
    }

    // Dispatch a Telegram alert if the user linked and enabled a chat.
    if (wallet?.user?.notifyPrefs?.telegramEnabled && wallet.user.notifyPrefs.telegramChatId) {
      const rawChatId = wallet.user.notifyPrefs.telegramChatId;
      const chatId = decryptPersonalField(rawChatId) || rawChatId;
      await dispatchTelegramAlert(chatId, data).catch((err: any) => {
        queueLog.warn(`[Worker] Telegram dispatch error: ${err.message}`);
      });
    }

    // Dispatch a WhatsApp alert via Twilio if the user opted in and Twilio
    // is configured. Deduplicates against a prior successful delivery for
    // this payment so a restarted job never double-sends.
    if (wallet?.user?.notifyPrefs?.whatsappEnabled && wallet.user.notifyPrefs.whatsappNumber) {
      const accountSid = process.env.TWILIO_ACCOUNT_SID;
      const authToken = process.env.TWILIO_AUTH_TOKEN;
      const fromNumber = process.env.TWILIO_WHATSAPP_FROM;

      if (accountSid && authToken && fromNumber) {
        const rawNumber = wallet.user.notifyPrefs.whatsappNumber;
        const toNumber = decryptPersonalField(rawNumber) || rawNumber;

        const alreadyDelivered = await prisma.whatsAppDeliveryLog.findFirst({
          where: { paymentId: data.paymentId, success: true },
        });

        if (!alreadyDelivered) {
          try {
            const result = await dispatchWhatsAppAlert(toNumber, data, { accountSid, authToken, fromNumber });
            await prisma.whatsAppDeliveryLog.create({
              data: {
                paymentId: data.paymentId,
                toNumber,
                success: result.success,
                messageSid: result.messageSid,
                status: result.status,
                error: result.error,
                attempts: result.attempts,
              },
            });
          } catch (err: any) {
            queueLog.warn(`[Worker] WhatsApp dispatch error: ${err.message}`);
            await prisma.whatsAppDeliveryLog.create({
              data: {
                paymentId: data.paymentId,
                toNumber,
                success: false,
                error: err.message,
                attempts: 0,
              },
            });
          }
        }
      }
    }

    // Dispatch Discord alert if configured
    if (wallet?.user?.notifyPrefs?.discordEnabled && wallet.user.notifyPrefs.discordWebhookUrl) {
      try {
        if (!(await alreadyDelivered(data.paymentId, 'discord'))) {
          const ok = await dispatchDiscordAlert(wallet.user.notifyPrefs.discordWebhookUrl, {
            paymentId: data.paymentId,
            txHash: data.txHash,
            amount: data.amount,
            asset: data.asset,
            assetIssuer: data.assetIssuer,
            fromAddress: data.fromAddress,
            receivedAt: data.receivedAt,
          });
          await recordDelivery(data.paymentId, 'discord', ok, ok ? undefined : 'webhook returned non-ok status');
          if (ok) {
            console.log(`[Worker] Sent Discord alert for ${data.paymentId}`);
          } else {
            console.warn(`[Worker] Failed to send Discord alert for ${data.paymentId}`);
          }
        }
      } catch (err: any) {
        console.warn(`[Worker] Discord dispatch error for ${data.paymentId}: ${err.message}`);
        await recordDelivery(data.paymentId, 'discord', false, err.message);
      }
    }

    // Dispatch Slack alert if configured
    if (wallet?.user?.notifyPrefs?.slackEnabled && wallet.user.notifyPrefs.slackWebhookUrl) {
      try {
        const webhookUrl = wallet.user.notifyPrefs.slackWebhookUrl;
        if (!isValidSlackWebhookUrl(webhookUrl)) {
          console.warn(`[Worker] Skipping Slack dispatch for ${data.paymentId}: invalid webhook URL`);
        } else if (!(await alreadyDelivered(data.paymentId, 'slack'))) {
          const ok = await dispatchSlackAlert(webhookUrl, data);
          await recordDelivery(data.paymentId, 'slack', ok, ok ? undefined : 'webhook returned non-ok status');
          if (ok) {
            console.log(`[Worker] Sent Slack alert for ${data.paymentId}`);
          } else {
            console.warn(`[Worker] Failed to send Slack alert for ${data.paymentId}`);
          }
        }
      } catch (err: any) {
        console.warn(`[Worker] Slack dispatch error for ${data.paymentId}: ${err.message}`);
        await recordDelivery(data.paymentId, 'slack', false, err.message);
      }
    }

    // Send email alert via emailService (Issue #263)
    const recipientEmail = wallet?.user?.email || (data.fromAddress.includes('@') ? data.fromAddress : null);
    if (recipientEmail) {
      await deliverWithIdempotency(
        {
          paymentId: data.paymentId,
          channel: "email",
          destination: recipientEmail,
          userId,
        },
        async () => {
          await workerFairnessManager.acquireProviderBudget('email');
          return emailService.sendPaymentReceipt(
            {
              recipientEmail,
              emailEnabled: wallet?.user?.notifyPrefs?.emailEnabled ?? true,
            },
            {
              paymentId: data.paymentId,
              txHash: data.txHash,
              amount: data.amount,
              asset: data.asset,
              assetIssuer: data.assetIssuer,
              fromAddress: data.fromAddress,
              receivedAt: data.receivedAt,
            }
          );
        }
      ).catch(async (err: any) => {
        queueLog.warn(`[Worker] Email dispatch error: ${err.message}`);
        await recordDeadLetter('email', recipientEmail, err);
        if (err.isRetriable) {
          throw err;
        }
        return null;
      });
    }

    // Dispatch Push Protocol alert if user configured push preferences (#253)
    const pushEnabled = wallet?.user?.notifyPrefs?.pushEnabled;
    const pushDestination = wallet?.user?.notifyPrefs?.pushChannelAddress || wallet?.publicKey;
    if (pushEnabled && pushDestination) {
      await deliverWithIdempotency(
        {
          paymentId: data.paymentId,
          channel: "push",
          destination: pushDestination,
          userId,
        },
        async () => {
          await workerFairnessManager.acquireProviderBudget('push');
          const pushData: PushNotificationData = {
            paymentId: data.paymentId,
            txHash: data.txHash,
            amount: data.amount,
            asset: data.asset,
            assetIssuer: data.assetIssuer,
            fromAddress: data.fromAddress,
            recipientAddress: pushDestination,
            receivedAt: data.receivedAt,
          };
          const ok = await dispatchPushNotification(pushDestination, pushData);
          if (!ok) {
            const err: any = new Error(`Push Protocol dispatch failed for recipient ${pushDestination}`);
            err.isRetriable = true;
            throw err;
          }
          return { success: true };
        }
      ).catch(async (err: any) => {
        console.warn(`[Worker] Push Protocol dispatch error: ${err.message}`);
        await recordDeadLetter('push', pushDestination, err);
        if (err.isRetriable) {
          throw err;
        }
        return null;
      });
    }
  } finally {
    workerFairnessManager.releaseWalletSlot(data.walletId);
  }
}

export async function enqueuePaymentAlert(data: AlertJobData) {
  if (!alertQueue) {
    queueLog.info({ txHash: data.txHash }, 'Queue not connected for payment. Dispatching alert directly in-process...');
    return processAlertDispatch(data);
  }

  try {
    const job = await alertQueue.add("dispatch-alert", data, {
      jobId: `payment-${data.txHash}`,
    });
    queueLog.info({ jobId: job.id, txHash: data.txHash, requestId: data.requestId }, '📨 Enqueued payment alert job');
    return job;
  } catch (err: any) {
    queueLog.warn(
      { txHash: data.txHash, err: err.message },
      'Failed to enqueue alert. Falling back to direct dispatch...',
    );
    return processAlertDispatch(data);
  }
}

export { dispatchPushNotification } from "../utils/push-protocol";
