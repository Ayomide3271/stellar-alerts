/**
 * Slack Interactive Block Kit Notification Dispatcher (#637).
 *
 * Implements enterprise Slack notification dispatching using Block Kit:
 * - Structured headers, markdown sections, context elements, and action accessories
 * - Interactive alert acknowledgment button
 * - Deep links to Stellar Expert explorer and Stellar Alerts dashboard
 * - Dual delivery transport: Custom Incoming Webhooks and Slack Bot Token (chat.postMessage)
 * - Rate limit handling (429 Retry-After) and timeout management
 */

import { env } from '../../../config/env';
import { fetchWithTimeout } from '../../../lib/external-request';

export interface SlackTextObject {
  type: 'plain_text' | 'mrkdwn';
  text: string;
  emoji?: boolean;
}

export interface SlackButtonElement {
  type: 'button';
  text: SlackTextObject;
  action_id: string;
  url?: string;
  value?: string;
  style?: 'primary' | 'danger';
}

export interface SlackHeaderBlock {
  type: 'header';
  text: {
    type: 'plain_text';
    text: string;
    emoji?: boolean;
  };
}

export interface SlackSectionBlock {
  type: 'section';
  text?: SlackTextObject;
  fields?: SlackTextObject[];
  accessory?: SlackButtonElement;
}

export interface SlackContextBlock {
  type: 'context';
  elements: Array<{
    type: 'plain_text' | 'mrkdwn' | 'image';
    text?: string;
    image_url?: string;
    alt_text?: string;
  }>;
}

export interface SlackActionsBlock {
  type: 'actions';
  elements: SlackButtonElement[];
}

export interface SlackDividerBlock {
  type: 'divider';
}

export type SlackBlock =
  | SlackHeaderBlock
  | SlackSectionBlock
  | SlackContextBlock
  | SlackActionsBlock
  | SlackDividerBlock;

export interface SlackBlockKitPayload {
  text?: string;
  blocks: SlackBlock[];
}

export interface SlackPaymentAlert {
  paymentId: string;
  txHash: string;
  amount: string | number;
  asset: string;
  fromAddress: string;
  recipientAddress?: string;
  receivedAt: string | Date;
  alertId?: string;
  network?: string;
  memo?: string;
  dashboardBaseUrl?: string;
  explorerBaseUrl?: string;
}

export interface SlackDispatchTarget {
  webhookUrl?: string;
  botToken?: string;
  channel?: string;
}

export interface SlackDispatchResult {
  success: boolean;
  statusCode?: number;
  error?: string;
  rateLimited?: boolean;
  retryAfterSeconds?: number;
}

export class SlackNotificationProvider {
  /**
   * Validate if incoming webhook URL meets Slack format requirements.
   */
  isValidWebhookUrl(url?: string | null): boolean {
    if (!url) return false;
    try {
      const parsed = new URL(url);
      return (
        parsed.protocol === 'https:' &&
        parsed.hostname === 'hooks.slack.com' &&
        parsed.pathname.startsWith('/services/')
      );
    } catch {
      return false;
    }
  }

  /**
   * Construct an official Slack Block Kit payload with section fields,
   * context metadata, and interactive button actions.
   */
  buildBlockKitPayload(data: SlackPaymentAlert): SlackBlockKitPayload {
    const alertId = data.alertId || data.paymentId;
    const network = data.network || 'public';
    const networkLabel = network === 'testnet' ? 'Stellar Testnet' : 'Stellar Public Network';

    const explorerBase =
      data.explorerBaseUrl ||
      (network === 'testnet'
        ? 'https://stellar.expert/explorer/testnet'
        : 'https://stellar.expert/explorer/public');

    const dashboardBase =
      data.dashboardBaseUrl ||
      process.env.DASHBOARD_URL ||
      'https://stellar-alerts.com';

    const explorerUrl = `${explorerBase}/tx/${data.txHash}`;
    const dashboardUrl = `${dashboardBase}/alerts/${alertId}`;

    const truncatedHash =
      data.txHash.length > 14
        ? `${data.txHash.substring(0, 8)}...${data.txHash.substring(data.txHash.length - 6)}`
        : data.txHash;

    const truncatedFrom =
      data.fromAddress.length > 14
        ? `${data.fromAddress.substring(0, 6)}...${data.fromAddress.substring(data.fromAddress.length - 4)}`
        : data.fromAddress;

    const formattedTime =
      data.receivedAt instanceof Date
        ? data.receivedAt.toISOString()
        : String(data.receivedAt);

    const fallbackText = `💰 Stellar Payment Alert: ${data.amount} ${data.asset} from ${truncatedFrom}`;

    const fields: SlackTextObject[] = [
      {
        type: 'mrkdwn',
        text: `*Amount:*\n\`${data.amount} ${data.asset}\``,
      },
      {
        type: 'mrkdwn',
        text: `*From:*\n\`${data.fromAddress}\``,
      },
      {
        type: 'mrkdwn',
        text: `*Transaction:*\n<${explorerUrl}|${truncatedHash}>`,
      },
      {
        type: 'mrkdwn',
        text: `*Received At:*\n${formattedTime}`,
      },
    ];

    if (data.recipientAddress) {
      fields.push({
        type: 'mrkdwn',
        text: `*Recipient:*\n\`${data.recipientAddress}\``,
      });
    }

    if (data.memo) {
      fields.push({
        type: 'mrkdwn',
        text: `*Memo:*\n${data.memo}`,
      });
    }

    const blocks: SlackBlock[] = [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: '🚨 Stellar Payment Alert',
          emoji: true,
        },
      },
      {
        type: 'section',
        fields,
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `🌐 Network: *${networkLabel}* | Alert ID: \`${alertId}\` | Stellar Alerts Dispatcher`,
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
              text: '✅ Acknowledge Alert',
              emoji: true,
            },
            action_id: 'acknowledge_alert',
            style: 'primary',
            value: alertId,
          },
          {
            type: 'button',
            text: {
              type: 'plain_text',
              text: '🔍 View on Stellar Expert',
              emoji: true,
            },
            action_id: 'view_stellar_expert',
            url: explorerUrl,
          },
          {
            type: 'button',
            text: {
              type: 'plain_text',
              text: '📊 Stellar Alerts Dashboard',
              emoji: true,
            },
            action_id: 'open_dashboard',
            url: dashboardUrl,
          },
        ],
      },
    ];

    return {
      text: fallbackText,
      blocks,
    };
  }

  /**
   * Dispatch a Block Kit payload via Slack Incoming Webhook URL.
   */
  async sendWebhook(
    webhookUrl: string,
    payload: SlackBlockKitPayload,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<SlackDispatchResult> {
    if (!this.isValidWebhookUrl(webhookUrl)) {
      return {
        success: false,
        error: 'Invalid Slack incoming webhook URL',
      };
    }

    const timeoutMs = options.timeoutMs ?? env.NOTIFICATION_PROVIDER_TIMEOUT_MS;

    try {
      const response = await fetchWithTimeout(
        webhookUrl,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
        },
        timeoutMs,
        options.signal,
        'SlackWebhook',
      );

      if (response.status === 429) {
        const retryHeader = response.headers.get('retry-after');
        const retryAfterSeconds = retryHeader ? parseInt(retryHeader, 10) : undefined;
        return {
          success: false,
          statusCode: 429,
          rateLimited: true,
          retryAfterSeconds,
          error: `Slack webhook rate limited (429); retry after ${retryAfterSeconds ?? 'unknown'}s`,
        };
      }

      if (!response.ok) {
        const errorText = await response.text();
        return {
          success: false,
          statusCode: response.status,
          error: `Slack webhook responded with HTTP ${response.status}: ${errorText}`,
        };
      }

      return {
        success: true,
        statusCode: response.status,
      };
    } catch (err: any) {
      return {
        success: false,
        error: err.message || 'Failed to dispatch Slack webhook',
      };
    }
  }

  /**
   * Dispatch a Block Kit payload via Slack Bot Token (chat.postMessage).
   */
  async sendBotMessage(
    botToken: string,
    channel: string,
    payload: SlackBlockKitPayload,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<SlackDispatchResult> {
    if (!botToken || !channel) {
      return {
        success: false,
        error: 'Slack bot token and target channel are required',
      };
    }

    const timeoutMs = options.timeoutMs ?? env.NOTIFICATION_PROVIDER_TIMEOUT_MS;

    try {
      const response = await fetchWithTimeout(
        'https://slack.com/api/chat.postMessage',
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${botToken}`,
            'Content-Type': 'application/json; charset=utf-8',
          },
          body: JSON.stringify({
            channel,
            text: payload.text,
            blocks: payload.blocks,
          }),
        },
        timeoutMs,
        options.signal,
        'SlackBot',
      );

      if (response.status === 429) {
        const retryHeader = response.headers.get('retry-after');
        const retryAfterSeconds = retryHeader ? parseInt(retryHeader, 10) : undefined;
        return {
          success: false,
          statusCode: 429,
          rateLimited: true,
          retryAfterSeconds,
          error: `Slack API rate limited (429); retry after ${retryAfterSeconds ?? 'unknown'}s`,
        };
      }

      const body = (await response.json()) as { ok?: boolean; error?: string };

      if (!response.ok || !body.ok) {
        return {
          success: false,
          statusCode: response.status,
          error: body.error || `Slack chat.postMessage failed with HTTP ${response.status}`,
        };
      }

      return {
        success: true,
        statusCode: 200,
      };
    } catch (err: any) {
      return {
        success: false,
        error: err.message || 'Failed to dispatch Slack bot message',
      };
    }
  }

  /**
   * High-level dispatch routing to webhook or bot token.
   */
  async dispatch(
    target: SlackDispatchTarget,
    data: SlackPaymentAlert,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<SlackDispatchResult> {
    const payload = this.buildBlockKitPayload(data);

    if (target.botToken && target.channel) {
      return this.sendBotMessage(target.botToken, target.channel, payload, options);
    }

    if (target.webhookUrl) {
      return this.sendWebhook(target.webhookUrl, payload, options);
    }

    return {
      success: false,
      error: 'No valid Slack destination provided (requires webhookUrl or botToken + channel)',
    };
  }

  /**
   * Process alert acknowledgment from interactive button action.
   */
  async acknowledgeAlert(
    alertId: string,
    actorUserId?: string,
    note?: string,
  ): Promise<{ acknowledged: boolean; alertId: string; actorUserId?: string; timestamp: Date; note?: string }> {
    return {
      acknowledged: true,
      alertId,
      actorUserId,
      note,
      timestamp: new Date(),
    };
  }
}

export const slackNotificationProvider = new SlackNotificationProvider();
