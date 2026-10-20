import { vi, describe, it, expect, beforeEach } from 'vitest';
import { Job } from 'bullmq';

const { MockQueueAdd, MockQueueEventsOn, MockWorker } = vi.hoisted(() => ({
  MockQueueAdd: vi.fn().mockResolvedValue(true),
  MockQueueEventsOn: vi.fn(),
  MockWorker: vi.fn(function() {}),
}));

const mockRedisStore = new Map<string, string>();

vi.mock('ioredis', () => {
  const RedisMock = vi.fn().mockImplementation(() => ({
    set: vi.fn(async (key: string, value: string, ...rest: any[]) => {
      const hasNx = rest.some((arg) => typeof arg === 'string' && arg.toUpperCase() === 'NX');
      if (hasNx && mockRedisStore.has(key)) {
        return null;
      }
      mockRedisStore.set(key, value);
      return 'OK';
    }),
    get: vi.fn(async (key: string) => mockRedisStore.get(key) ?? null),
    eval: vi.fn(async (_script: string, _numkeys: number, key: string, value: string) => {
      if (mockRedisStore.get(key) === value) {
        mockRedisStore.delete(key);
        return 1;
      }
      return 0;
    }),
    on: vi.fn(),
  }));
  return { default: RedisMock };
});

vi.mock('./redis', async () => {
  const { default: Redis } = await import('ioredis');
  return { redis: new Redis() };
});

// We mock bullmq before importing queue
vi.mock('bullmq', () => {
  return {
    Queue: vi.fn(function() {
      return { add: MockQueueAdd };
    }),
    QueueEvents: vi.fn(function() {
      return { on: MockQueueEventsOn };
    }),
    Job: {
      fromId: vi.fn(),
    },
    Worker: MockWorker,
  };
});

vi.mock('./prisma', () => {
  return {
    prisma: {
      wallet: {
        findUnique: vi.fn().mockResolvedValue(null),
      },
      payment: {
        findUnique: vi.fn(),
      },
      whatsAppDeliveryLog: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({}),
      },
      notificationDeliveryAttempt: {
        findFirst: vi.fn().mockResolvedValue(null),
        count: vi.fn().mockResolvedValue(0),
        create: vi.fn().mockResolvedValue({ id: 'attempt-1' }),
        update: vi.fn().mockResolvedValue({}),
      },
      deadLetter: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: 'dl-1' }),
      },
      deliveryLog: {
        findUnique: vi.fn().mockResolvedValue(null),
        upsert: vi.fn().mockResolvedValue(null),
      },
    },
  };
});

vi.mock('../utils/discord', () => {
  return {
    dispatchDiscordAlert: vi.fn().mockResolvedValue(true),
  };
});

const { MockWhatsAppInvalidNumberError } = vi.hoisted(() => ({
  MockWhatsAppInvalidNumberError: class WhatsAppInvalidNumberError extends Error {
    constructor(number: string) {
      super(`"${number}" is not a valid E.164 WhatsApp number`);
      this.name = 'WhatsAppInvalidNumberError';
    }
  },
}));

vi.mock('../utils/whatsapp', () => {
  return {
    dispatchWhatsAppAlert: vi.fn().mockResolvedValue({ success: true, messageSid: 'SM123', status: 'queued', attempts: 1 }),
    WhatsAppInvalidNumberError: MockWhatsAppInvalidNumberError,
  };
});

vi.mock('../utils/slack', () => {
  return {
    dispatchSlackAlert: vi.fn().mockResolvedValue(true),
    isValidSlackWebhookUrl: (url: string) => url.startsWith('https://hooks.slack.com/'),
  };
});

vi.mock('../utils/webhook-signer', () => {
  return {
    signWebhookPayload: vi.fn().mockResolvedValue({ headerValue: 'test', nonce: 'test' }),
  };
});

vi.mock('resend', () => {
  return {
    Resend: vi.fn(function() {
      return {
        emails: {
          send: vi.fn().mockResolvedValue({ data: { id: 'test_id' }, error: null }),
        },
      };
    }),
  };
});

import { alertQueue, dlqQueue, paymentAlertWorkerProcessor, failedJobHandler, createRedisConnectionConfig } from './queue';
import { prisma } from './prisma';
import { dispatchWhatsAppAlert } from '../utils/whatsapp';
import { dispatchDiscordAlert } from '../utils/discord';
import { dispatchSlackAlert } from '../utils/slack';
import { emailService } from '../services/email.service';

describe('Queue DLQ routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRedisStore.clear();
  });

  it('routes to DLQ queue and persists to DeadLetter table when job fails after 5 attempts (#539)', async () => {
    (Job.fromId as any).mockResolvedValue({
      attemptsMade: 5,
      opts: { attempts: 5 },
      data: { txHash: 'test-tx', paymentId: 'pay-123' },
    });

    await failedJobHandler({ jobId: '123', failedReason: 'Test error' });

    expect(MockQueueAdd).toHaveBeenCalledWith(
      'dispatch-alert-failed',
      { txHash: 'test-tx', paymentId: 'pay-123' },
      { jobId: 'dlq-123' }
    );
    expect(prisma.deadLetter.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          channel: 'queue',
          jobId: '123',
          attemptsMade: 5,
          maxAttempts: 5,
          failureReason: 'max_attempts_exceeded',
          status: 'pending',
        }),
      })
    );
  });
  
  it('does not route to DLQ if attempts < max attempts', async () => {
    (Job.fromId as any).mockResolvedValue({
      attemptsMade: 3,
      opts: { attempts: 5 },
      data: { txHash: 'test-tx' },
    });

    await failedJobHandler({ jobId: '124', failedReason: 'Test error' });

    expect(MockQueueAdd).not.toHaveBeenCalled();
    expect(prisma.deadLetter.create).not.toHaveBeenCalled();
  });
});

describe('Redis Sentinel Connection Configuration', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  it('builds standard Redis connection when REDIS_SENTINELS is not set', () => {
    delete process.env.REDIS_SENTINELS;
    const config = createRedisConnectionConfig();

    expect(config).toHaveProperty('host');
    expect(config).toHaveProperty('port');
    expect(config.maxRetriesPerRequest).toBeNull();
  });

  it('builds Sentinel connection options when REDIS_SENTINELS is set', () => {
    process.env.REDIS_SENTINELS = 'sentinel1:26379,sentinel2:26379,sentinel3:26379';
    process.env.REDIS_SENTINEL_MASTER_NAME = 'test-master';

    const config = createRedisConnectionConfig() as any;

    expect(config.sentinels).toHaveLength(3);
    expect(config.sentinels[0]).toEqual({ host: 'sentinel1', port: 26379 });
    expect(config.name).toBe('test-master');
    expect(config.role).toBe('master');
    expect(config.maxRetriesPerRequest).toBeNull();
    expect(typeof config.reconnectOnError).toBe('function');
    expect(config.reconnectOnError(new Error('READONLY You can\'t write against a read only replica.'))).toBe(true);
    expect(config.reconnectOnError(new Error('Some other error'))).toBe(false);
  });
});

describe('Telegram Dispatcher Worker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRedisStore.clear();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
  });

  it('dispatches telegram message when user has valid chatId and enabled', async () => {
    (prisma.payment.findUnique as any).mockResolvedValue({
      id: 'pay-123',
      wallet: {
        user: {
          notifyPrefs: {
            telegramEnabled: true,
            telegramChatId: 'chat-123',
          },
        },
      },
    });

    await paymentAlertWorkerProcessor({
      data: {
        paymentId: 'pay-123',
        amount: '10',
        asset: 'XLM',
        fromAddress: 'GABC...',
        txHash: 'hash-123',
        walletId: 'wallet-123',
        receivedAt: new Date().toISOString(),
      },
    });

    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('https://api.telegram.org/bot'),
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"chat_id":"chat-123"'),
      })
    );
  });

  it('does not dispatch telegram message when telegram is disabled', async () => {
    (prisma.payment.findUnique as any).mockResolvedValue({
      id: 'pay-124',
      wallet: {
        user: {
          notifyPrefs: {
            telegramEnabled: false,
            telegramChatId: 'chat-123',
          },
        },
      },
    });

    await paymentAlertWorkerProcessor({
      data: {
        paymentId: 'pay-124',
        amount: '10',
        asset: 'XLM',
        fromAddress: 'GABC...',
        txHash: 'hash-124',
        walletId: 'wallet-124',
        receivedAt: new Date().toISOString(),
      },
    });

    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('WhatsApp Dispatcher Worker', () => {
  const originalEnv = process.env;
  const jobData = {
    paymentId: 'pay-wa-1',
    amount: '10',
    asset: 'XLM',
    fromAddress: 'GABC...',
    txHash: 'hash-wa-1',
    walletId: 'wallet-wa-1',
    receivedAt: new Date().toISOString(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = {
      ...originalEnv,
      TWILIO_ACCOUNT_SID: 'AC_test',
      TWILIO_AUTH_TOKEN: 'test_token',
      TWILIO_WHATSAPP_FROM: '+14155238886',
    };
    (prisma.whatsAppDeliveryLog.findFirst as any).mockResolvedValue(null);
    (dispatchWhatsAppAlert as any).mockResolvedValue({
      success: true,
      messageSid: 'SM123',
      status: 'queued',
      attempts: 1,
    });
  });

  it('dispatches and logs a successful WhatsApp alert when opted in and Twilio is configured', async () => {
    (prisma.payment.findUnique as any).mockResolvedValue({
      id: jobData.paymentId,
      wallet: {
        user: {
          notifyPrefs: { whatsappEnabled: true, whatsappNumber: '+14155551234' },
        },
      },
    });

    await paymentAlertWorkerProcessor({ data: jobData });

    expect(dispatchWhatsAppAlert).toHaveBeenCalledWith(
      '+14155551234',
      jobData,
      { accountSid: 'AC_test', authToken: 'test_token', fromNumber: '+14155238886' },
    );
    expect(prisma.whatsAppDeliveryLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        paymentId: jobData.paymentId,
        toNumber: '+14155551234',
        success: true,
        messageSid: 'SM123',
      }),
    });
  });

  it('does not dispatch when whatsappEnabled is false', async () => {
    (prisma.payment.findUnique as any).mockResolvedValue({
      id: jobData.paymentId,
      wallet: {
        user: {
          notifyPrefs: { whatsappEnabled: false, whatsappNumber: '+14155551234' },
        },
      },
    });

    await paymentAlertWorkerProcessor({ data: jobData });

    expect(dispatchWhatsAppAlert).not.toHaveBeenCalled();
  });

  it('does not dispatch when Twilio credentials are not configured', async () => {
    delete process.env.TWILIO_ACCOUNT_SID;
    (prisma.payment.findUnique as any).mockResolvedValue({
      id: jobData.paymentId,
      wallet: {
        user: {
          notifyPrefs: { whatsappEnabled: true, whatsappNumber: '+14155551234' },
        },
      },
    });

    await paymentAlertWorkerProcessor({ data: jobData });

    expect(dispatchWhatsAppAlert).not.toHaveBeenCalled();
  });

  it('skips dispatch for a duplicate job once a successful delivery is already logged', async () => {
    (prisma.whatsAppDeliveryLog.findFirst as any).mockResolvedValue({ id: 'log-1', success: true });
    (prisma.payment.findUnique as any).mockResolvedValue({
      id: jobData.paymentId,
      wallet: {
        user: {
          notifyPrefs: { whatsappEnabled: true, whatsappNumber: '+14155551234' },
        },
      },
    });

    await paymentAlertWorkerProcessor({ data: jobData });

    expect(dispatchWhatsAppAlert).not.toHaveBeenCalled();
    expect(prisma.whatsAppDeliveryLog.create).not.toHaveBeenCalled();
  });

  it('logs an invalid-number failure without throwing when the stored number is malformed', async () => {
    const { WhatsAppInvalidNumberError } = await import('../utils/whatsapp');
    (dispatchWhatsAppAlert as any).mockRejectedValue(new WhatsAppInvalidNumberError('not-a-number'));
    (prisma.payment.findUnique as any).mockResolvedValue({
      id: jobData.paymentId,
      wallet: {
        user: {
          notifyPrefs: { whatsappEnabled: true, whatsappNumber: 'not-a-number' },
        },
      },
    });

    await expect(paymentAlertWorkerProcessor({ data: jobData })).resolves.not.toThrow();

    expect(prisma.whatsAppDeliveryLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ success: false, attempts: 0 }),
    });
  });
});

describe('Discord Dispatcher Worker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    (prisma.deliveryLog.findUnique as any).mockResolvedValue(null);
  });

  it('dispatches Discord alert when enabled with a webhook URL configured', async () => {
    (prisma.payment.findUnique as any).mockResolvedValue({
      id: 'pay-200',
      wallet: {
        user: {
          notifyPrefs: {
            discordEnabled: true,
            discordWebhookUrl: 'https://discord.com/api/webhooks/123/abc',
          },
        },
      },
    });

    await paymentAlertWorkerProcessor({
      data: {
        paymentId: 'pay-200',
        amount: '10',
        asset: 'XLM',
        fromAddress: 'GABC...',
        txHash: 'hash-200',
        walletId: 'wallet-200',
        receivedAt: new Date().toISOString(),
      },
    });

    expect(dispatchDiscordAlert).toHaveBeenCalledWith(
      'https://discord.com/api/webhooks/123/abc',
      expect.objectContaining({ paymentId: 'pay-200' })
    );
    expect(prisma.deliveryLog.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { paymentId_channel: { paymentId: 'pay-200', channel: 'discord' } },
      })
    );
  });

  it('does not dispatch Discord alert when disabled', async () => {
    (prisma.payment.findUnique as any).mockResolvedValue({
      id: 'pay-201',
      wallet: {
        user: {
          notifyPrefs: {
            discordEnabled: false,
            discordWebhookUrl: 'https://discord.com/api/webhooks/123/abc',
          },
        },
      },
    });

    await paymentAlertWorkerProcessor({
      data: {
        paymentId: 'pay-201',
        amount: '10',
        asset: 'XLM',
        fromAddress: 'GABC...',
        txHash: 'hash-201',
        walletId: 'wallet-201',
        receivedAt: new Date().toISOString(),
      },
    });

    expect(dispatchDiscordAlert).not.toHaveBeenCalled();
  });

  it('skips re-dispatching Discord when a delivery is already logged as sent', async () => {
    (prisma.payment.findUnique as any).mockResolvedValue({
      id: 'pay-202',
      wallet: {
        user: {
          notifyPrefs: {
            discordEnabled: true,
            discordWebhookUrl: 'https://discord.com/api/webhooks/123/abc',
          },
        },
      },
    });
    (prisma.deliveryLog.findUnique as any).mockResolvedValue({ status: 'sent' });

    await paymentAlertWorkerProcessor({
      data: {
        paymentId: 'pay-202',
        amount: '10',
        asset: 'XLM',
        fromAddress: 'GABC...',
        txHash: 'hash-202',
        walletId: 'wallet-202',
        receivedAt: new Date().toISOString(),
      },
    });

    expect(dispatchDiscordAlert).not.toHaveBeenCalled();
  });
});

describe('Slack Dispatcher Worker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    (prisma.deliveryLog.findUnique as any).mockResolvedValue(null);
  });

  it('dispatches Slack alert when enabled with a valid webhook URL configured', async () => {
    (prisma.payment.findUnique as any).mockResolvedValue({
      id: 'pay-300',
      wallet: {
        user: {
          notifyPrefs: {
            slackEnabled: true,
            slackWebhookUrl: 'https://hooks.slack.com/services/T00/B00/xyz',
          },
        },
      },
    });

    await paymentAlertWorkerProcessor({
      data: {
        paymentId: 'pay-300',
        amount: '10',
        asset: 'XLM',
        fromAddress: 'GABC...',
        txHash: 'hash-300',
        walletId: 'wallet-300',
        receivedAt: new Date().toISOString(),
      },
    });

    expect(dispatchSlackAlert).toHaveBeenCalledWith(
      'https://hooks.slack.com/services/T00/B00/xyz',
      expect.objectContaining({ paymentId: 'pay-300' })
    );
  });

  it('does not dispatch Slack alert when disabled', async () => {
    (prisma.payment.findUnique as any).mockResolvedValue({
      id: 'pay-301',
      wallet: {
        user: {
          notifyPrefs: {
            slackEnabled: false,
            slackWebhookUrl: 'https://hooks.slack.com/services/T00/B00/xyz',
          },
        },
      },
    });

    await paymentAlertWorkerProcessor({
      data: {
        paymentId: 'pay-301',
        amount: '10',
        asset: 'XLM',
        fromAddress: 'GABC...',
        txHash: 'hash-301',
        walletId: 'wallet-301',
        receivedAt: new Date().toISOString(),
      },
    });

    expect(dispatchSlackAlert).not.toHaveBeenCalled();
  });

  it('rejects an invalid (non-Slack) webhook URL without dispatching', async () => {
    (prisma.payment.findUnique as any).mockResolvedValue({
      id: 'pay-302',
      wallet: {
        user: {
          notifyPrefs: {
            slackEnabled: true,
            slackWebhookUrl: 'https://evil.example.com/not-slack',
          },
        },
      },
    });

    await paymentAlertWorkerProcessor({
      data: {
        paymentId: 'pay-302',
        amount: '10',
        asset: 'XLM',
        fromAddress: 'GABC...',
        txHash: 'hash-302',
        walletId: 'wallet-302',
        receivedAt: new Date().toISOString(),
      },
    });

    expect(dispatchSlackAlert).not.toHaveBeenCalled();
  });
});

describe('Email Dispatcher Worker via Resend (#535)', () => {
  const emailJobData = {
    paymentId: 'pay-email-1',
    amount: '50',
    asset: 'USDC',
    fromAddress: 'GUSER123',
    txHash: 'hash-email-1',
    walletId: 'wallet-email-1',
    receivedAt: new Date().toISOString(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('dispatches HTML payment receipt email via Resend when user has email configured', async () => {
    const sendPaymentReceiptSpy = vi.spyOn(emailService, 'sendPaymentReceipt').mockResolvedValue({ id: 'resend-msg-1' });

    (prisma.payment.findUnique as any).mockResolvedValue({
      id: 'pay-email-1',
      wallet: {
        user: {
          id: 'user-email-1',
          email: 'recipient@example.com',
          notifyPrefs: { emailEnabled: true },
        },
      },
    });

    await paymentAlertWorkerProcessor({ data: emailJobData });

    expect(sendPaymentReceiptSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientEmail: 'recipient@example.com',
        emailEnabled: true,
      }),
      expect.objectContaining({
        paymentId: 'pay-email-1',
        txHash: 'hash-email-1',
        amount: '50',
        asset: 'USDC',
        fromAddress: 'GUSER123',
      })
    );
  });

  it('skips email dispatch when emailEnabled is false', async () => {
    const sendPaymentReceiptSpy = vi.spyOn(emailService, 'sendPaymentReceipt').mockResolvedValue({ skipped: true });

    (prisma.payment.findUnique as any).mockResolvedValue({
      id: 'pay-email-1',
      wallet: {
        user: {
          id: 'user-email-1',
          email: 'recipient@example.com',
          notifyPrefs: { emailEnabled: false },
        },
      },
    });

    await paymentAlertWorkerProcessor({ data: emailJobData });

    expect(sendPaymentReceiptSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientEmail: 'recipient@example.com',
        emailEnabled: false,
      }),
      expect.any(Object)
    );
  });
});
