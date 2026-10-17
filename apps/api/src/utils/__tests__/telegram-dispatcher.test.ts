import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  buildTelegramPaymentCard,
  dispatchTelegramAlert,
  TelegramDispatchError,
} from '../telegram-dispatcher';

const alert = {
  amount: '10.5',
  asset: 'USDC',
  fromAddress: 'GABC<script>',
  txHash: 'hash-1',
  receivedAt: '2026-01-01T00:00:00.000Z',
};

describe('telegram dispatcher', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts an HTML payment card to the Bot API when a chatId is present', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });

    await expect(dispatchTelegramAlert('12345', alert, 'bot-token')).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.telegram.org/botbot-token/sendMessage');
    const body = JSON.parse(init.body);
    expect(body.chat_id).toBe('12345');
    expect(body.parse_mode).toBe('HTML');
    expect(body.text).toBe(buildTelegramPaymentCard(alert));
  });

  it('escapes HTML in the message card', () => {
    expect(buildTelegramPaymentCard(alert)).toContain('GABC&lt;script&gt;');
  });

  it.each([null, undefined, '', '   '])('does not call Telegram for chatId %j', async (chatId) => {
    await expect(dispatchTelegramAlert(chatId as any, alert, 'bot-token')).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws a TelegramDispatchError when Telegram rejects the message', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ description: 'Forbidden: bot was blocked by the user' }),
    });

    await expect(dispatchTelegramAlert('12345', alert, 'bot-token')).rejects.toMatchObject({
      name: 'TelegramDispatchError',
      status: 403,
      message: expect.stringContaining('bot was blocked'),
    });
  });

  it('surfaces retry_after on rate limiting', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({ description: 'Too Many Requests', parameters: { retry_after: 7 } }),
    });

    const err = await dispatchTelegramAlert('12345', alert, 'bot-token').catch((e) => e);
    expect(err).toBeInstanceOf(TelegramDispatchError);
    expect(err.retryAfterSeconds).toBe(7);
  });
});
