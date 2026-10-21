import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import pino from 'pino';
import {
  createLogger,
  rootLogger,
  loggerOptions,
  REDACT_PATHS,
  REDACT_CENSOR,
  sanitizeForLog,
} from '../logger';

function captureLogger() {
  const chunks: string[] = [];
  const stream = new PassThrough();
  stream.on('data', (buf: Buffer) => chunks.push(buf.toString('utf8')));
  const logger = pino(loggerOptions, stream);
  return {
    logger,
    lines: () =>
      chunks
        .join('')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

describe('createLogger', () => {
  it('returns a pino logger instance', () => {
    const logger = createLogger();
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.error).toBe('function');
  });

  it('is a child of the rootLogger', () => {
    const logger = createLogger({ module: 'Test' });
    expect((logger as any).bindings().module).toBe('Test');
  });

  it('binds requestId when provided', () => {
    const logger = createLogger({ requestId: 'req-abc-123' });
    expect((logger as any).bindings().requestId).toBe('req-abc-123');
  });

  it('binds module, requestId, jobId, and worker when provided', () => {
    const logger = createLogger({
      module: 'Queue',
      requestId: 'req-xyz',
      jobId: 'job-1',
      worker: 'alert',
    });
    const bindings = (logger as any).bindings();
    expect(bindings.module).toBe('Queue');
    expect(bindings.requestId).toBe('req-xyz');
    expect(bindings.jobId).toBe('job-1');
    expect(bindings.worker).toBe('alert');
  });

  it('omits requestId field when not provided', () => {
    const logger = createLogger({ module: 'Worker' });
    const bindings = (logger as any).bindings();
    expect(bindings.requestId).toBeUndefined();
  });

  it('returns a logger with no extra fields when called with no args', () => {
    const logger = createLogger();
    const bindings = (logger as any).bindings();
    expect(bindings.module).toBeUndefined();
    expect(bindings.requestId).toBeUndefined();
  });
});

describe('structured logger options', () => {
  it('exports machine-queryable level formatters and base fields', () => {
    expect(loggerOptions.base).toMatchObject({
      service: expect.any(String),
      env: expect.any(String),
    });
    expect(REDACT_PATHS.length).toBeGreaterThan(10);
    expect(typeof loggerOptions.formatters?.level).toBe('function');
    const leveled = loggerOptions.formatters!.level!('info', 30);
    expect(leveled).toEqual({ level: 'info' });
  });

  it('emits JSON with string level and service base fields', async () => {
    const { logger, lines } = captureLogger();
    logger.info({ walletId: 'GABC' }, 'ok');
    await new Promise((r) => setTimeout(r, 20));
    const entry = lines().at(-1)!;
    expect(entry.level).toBe('info');
    expect(entry.service).toBeTruthy();
    expect(entry.msg).toBe('ok');
    expect(entry.walletId).toBe('GABC');
  });

  it('redacts tokens, secrets, private keys, and message contents', async () => {
    const { logger, lines } = captureLogger();
    logger.info(
      {
        token: 'ghp_secret_token_value',
        secret: 'super-secret',
        privateKey: 'SSECRETKEY',
        password: 'hunter2',
        messageContent: 'ALERT: you received 100 XLM',
        messageBody: 'plaintext notification body',
        safe: 'visible',
        nested: { apiKey: 'key-123', walletId: 'GXYZ' },
      },
      'sensitive payload'
    );
    await new Promise((r) => setTimeout(r, 20));
    const entry = lines().at(-1)!;
    expect(entry.token).toBe(REDACT_CENSOR);
    expect(entry.secret).toBe(REDACT_CENSOR);
    expect(entry.privateKey).toBe(REDACT_CENSOR);
    expect(entry.password).toBe(REDACT_CENSOR);
    expect(entry.messageContent).toBe(REDACT_CENSOR);
    expect(entry.messageBody).toBe(REDACT_CENSOR);
    expect(entry.safe).toBe('visible');
    expect((entry.nested as any).apiKey).toBe(REDACT_CENSOR);
    expect((entry.nested as any).walletId).toBe('GXYZ');
    const raw = JSON.stringify(entry);
    expect(raw).not.toContain('ghp_secret_token_value');
    expect(raw).not.toContain('SSECRETKEY');
    expect(raw).not.toContain('ALERT: you received');
  });

  it('redacts authorization headers on request-shaped objects', async () => {
    const { logger, lines } = captureLogger();
    logger.info(
      {
        req: {
          headers: {
            authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.fake',
            cookie: 'session=abc',
            'x-api-key': 'api-key-value',
          },
        },
      },
      'request'
    );
    await new Promise((r) => setTimeout(r, 20));
    const entry = lines().at(-1)!;
    const headers = (entry.req as any).headers;
    expect(headers.authorization).toBe(REDACT_CENSOR);
    expect(headers.cookie).toBe(REDACT_CENSOR);
    expect(JSON.stringify(entry)).not.toContain('eyJhbGciOiJIUzI1NiJ9');
  });
});

describe('sanitizeForLog', () => {
  it('recursively redacts sensitive keys', () => {
    const cleaned = sanitizeForLog({
      userId: 'u1',
      refreshToken: 'rt_abc',
      nested: { private_key: 'pk', note: 'ok' },
      list: [{ telegramText: 'hi', id: 1 }],
    }) as any;
    expect(cleaned.userId).toBe('u1');
    expect(cleaned.refreshToken).toBe(REDACT_CENSOR);
    expect(cleaned.nested.private_key).toBe(REDACT_CENSOR);
    expect(cleaned.nested.note).toBe('ok');
    expect(cleaned.list[0].telegramText).toBe(REDACT_CENSOR);
    expect(cleaned.list[0].id).toBe(1);
  });
});

describe('rootLogger', () => {
  it('is a usable pino instance', () => {
    expect(typeof rootLogger.child).toBe('function');
    expect(typeof rootLogger.info).toBe('function');
  });
});

describe('requestId correlation in log output (Issue #567)', () => {
  it('emits requestId field in log lines when bound via createLogger', async () => {
    const chunks: string[] = [];
    const stream = new (require('node:stream').PassThrough)();
    stream.on('data', (buf: Buffer) => chunks.push(buf.toString('utf8')));
    const logger = pino(loggerOptions, stream);
    const child = logger.child({ requestId: 'req-567-test' });
    child.info({ walletId: 'GABC' }, 'payment received');
    await new Promise((r) => setTimeout(r, 20));
    const lines = chunks
      .join('')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const entry = lines.at(-1)!;
    expect(entry.requestId).toBe('req-567-test');
    expect(entry.walletId).toBe('GABC');
    expect(entry.level).toBe('info');
  });

  it('all log lines contain requestId when child logger is used (Issue #567 acceptance)', async () => {
    const chunks: string[] = [];
    const stream = new (require('node:stream').PassThrough)();
    stream.on('data', (buf: Buffer) => chunks.push(buf.toString('utf8')));
    const logger = pino(loggerOptions, stream);
    const reqId = 'aaaabbbb-cccc-4ddd-eeee-ffffffffffff';
    const child = logger.child({ requestId: reqId });

    child.info('first log line');
    child.warn({ detail: 'extra' }, 'second log line');
    child.error(new Error('test error'), 'third log line');

    await new Promise((r) => setTimeout(r, 30));
    const lines = chunks
      .join('')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);

    // Every emitted line must include the requestId binding.
    for (const line of lines) {
      expect(line.requestId).toBe(reqId);
    }
    expect(lines.length).toBeGreaterThanOrEqual(3);
  });
});
