import { AlertJobData } from '../lib/queue';
import { env } from '../config/env';
import { fetchWithTimeout } from '../lib/external-request';

export interface SlackBlockKitPayload {
  channel?: string;
  text?: string;
  blocks: Array<{
    type: string;
    text?: {
      type: string;
      text: string;
      emoji?: boolean;
    };
    fields?: Array<{
      type: string;
      text: string;
    }>;
    elements?: Array<{
      type: string;
      text: {
        type: string;
        text: string;
        emoji?: boolean;
      };
      url?: string;
      action_id?: string;
    }>;
  }>;
}

export function buildSlackBlockKitPayload(data: AlertJobData, channel?: string): SlackBlockKitPayload {
  const explorerUrl = `https://stellar.expert/explorer/public/tx/${data.txHash}`;
  const truncatedHash = data.txHash.length > 12 ? `${data.txHash.substring(0, 10)}...` : data.txHash;

  const payload: SlackBlockKitPayload = {
    text: `💰 Payment Received: ${data.amount} ${data.asset} from ${data.fromAddress}`,
    blocks: [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: '💰 Stellar Payment Received',
          emoji: true,
        },
      },
      {
        type: 'section',
        fields: [
          {
            type: 'mrkdwn',
            text: `*Amount:*\n\`${data.amount} ${data.asset}\``,
          },
          {
            type: 'mrkdwn',
            text: `*From Address:*\n\`${data.fromAddress}\``,
          },
          {
            type: 'mrkdwn',
            text: `*Transaction Hash:*\n\`<${explorerUrl}|${truncatedHash}>\``,
          },
          {
            type: 'mrkdwn',
            text: `*Received At:*\n${data.receivedAt}`,
          },
        ],
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: {
              type: 'plain_text',
              text: '🔍 View on Stellar Expert',
              emoji: true,
            },
            url: explorerUrl,
            action_id: 'view_explorer_tx',
          },
        ],
      },
    ],
  };

  if (channel) {
    payload.channel = channel;
  }

  return payload;
}

export function parseSlackWebhookUrls(rawUrls: string | string[]): string[] {
  if (Array.isArray(rawUrls)) {
    return rawUrls.map((u) => u.trim()).filter((u) => u.length > 0 && (u.startsWith('http://') || u.startsWith('https://')));
  }
  if (!rawUrls || typeof rawUrls !== 'string') return [];
  return rawUrls
    .split(/[\r\n,;]+/)
    .map((u) => u.trim())
    .filter((u) => u.length > 0 && (u.startsWith('http://') || u.startsWith('https://')));
}

export function isValidSlackWebhookUrl(url: string): boolean {
  if (!url || typeof url !== 'string') return false;
  const urls = parseSlackWebhookUrls(url);
  if (urls.length === 0) return false;
  return urls.every((u) => u.startsWith('https://hooks.slack.com/'));
}

export async function dispatchSlackAlert(
  webhookUrl: string | string[],
  data: AlertJobData,
  options: { timeoutMs?: number; signal?: AbortSignal; channel?: string } = {},
): Promise<boolean> {
  const urls = parseSlackWebhookUrls(webhookUrl);
  if (urls.length === 0) {
    console.warn(`[SlackWorker] No valid webhook URLs provided for payment ${data.paymentId}`);
    return false;
  }

  const payload = buildSlackBlockKitPayload(data, options.channel);
  const timeoutMs = options.timeoutMs ?? env.NOTIFICATION_PROVIDER_TIMEOUT_MS;

  const results = await Promise.allSettled(
    urls.map(async (targetUrl) => {
      try {
        const res = await fetchWithTimeout(
          targetUrl,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload),
          },
          timeoutMs,
          options.signal,
          'Slack',
        );

        if (res.status === 429) {
          const retryAfter = res.headers.get('retry-after');
          console.warn(`[SlackWorker] Rate limited (429) dispatching to Slack for tx ${data.txHash}; retry-after=${retryAfter ?? 'unknown'}s`);
          return false;
        }

        if (!res.ok) {
          const errorText = await res.text();
          console.warn(`[SlackWorker] Slack API error HTTP ${res.status}: ${errorText}`);
          return false;
        }

        console.log(`[SlackWorker] 💬 Dispatched Slack Block Kit notification for tx ${data.txHash} to ${targetUrl}`);
        return true;
      } catch (err: any) {
        console.warn(`[SlackWorker] Failed to dispatch Slack message to ${targetUrl}: ${err.message}`);
        return false;
      }
    }),
  );

  return results.some((r) => r.status === 'fulfilled' && r.value === true);
}
