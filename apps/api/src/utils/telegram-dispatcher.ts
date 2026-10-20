import { env } from '../config/env';
import { fetchWithTimeout } from '../lib/external-request';

export interface TelegramAlertData {
  amount: string;
  asset: string;
  fromAddress: string;
  txHash: string;
  receivedAt: string;
}

export class TelegramDispatchError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'TelegramDispatchError';
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char] ?? char);
}

export function buildTelegramPaymentCard(data: TelegramAlertData): string {
  return [
    '<b>Stellar Payment Received</b>',
    `<b>Amount:</b> ${escapeHtml(data.amount)} ${escapeHtml(data.asset)}`,
    `<b>From:</b> <code>${escapeHtml(data.fromAddress)}</code>`,
    `<b>Transaction:</b> <code>${escapeHtml(data.txHash)}</code>`,
    `<b>Received:</b> ${escapeHtml(data.receivedAt)}`,
  ].join('\n');
}

/**
 * Sends a payment alert through the Telegram Bot API. Returns `false` without
 * calling the API when no usable chatId is supplied, and throws a
 * `TelegramDispatchError` when Telegram rejects the message (blocked bot,
 * unknown chat, rate limit) so callers can log or retry.
 */
export async function dispatchTelegramAlert(
  chatId: string | null | undefined,
  data: TelegramAlertData,
  botToken: string = env.TELEGRAM_BOT_TOKEN,
): Promise<boolean> {
  const targetChatId = typeof chatId === 'string' ? chatId.trim() : '';
  if (!targetChatId || !botToken) {
    return false;
  }

  const response = await fetchWithTimeout(
    `https://api.telegram.org/bot${botToken}/sendMessage`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: targetChatId,
        text: buildTelegramPaymentCard(data),
        parse_mode: 'HTML',
      }),
    },
    env.NOTIFICATION_PROVIDER_TIMEOUT_MS,
    undefined,
    'Telegram',
  );

  if (!response.ok) {
    let description = `HTTP ${response.status}`;
    let retryAfter: number | undefined;
    try {
      const body = (await response.json()) as {
        description?: string;
        parameters?: { retry_after?: number };
      };
      description = body.description ?? description;
      retryAfter = body.parameters?.retry_after;
    } catch {
      // Non-JSON error body; keep the status-based description.
    }
    throw new TelegramDispatchError(`Telegram API error: ${description}`, response.status, retryAfter);
  }

  return true;
}
