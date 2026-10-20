import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  SlackNotificationProvider,
  slackNotificationProvider,
  SlackPaymentAlert,
} from '../providers/slack.provider';
import { notificationsService } from '../notifications.service';

const sampleAlertData: SlackPaymentAlert = {
  paymentId: 'pay-uuid-1234',
  txHash: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
  amount: '1250.75',
  asset: 'USDC',
  fromAddress: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
  recipientAddress: 'GBTYAFB3RFT6EJV7R6ZMQK442B5YCYJ2LUS5EAGB5WVRM6R5UGK5K4KZ',
  receivedAt: new Date('2026-10-19T14:30:00.000Z'),
  alertId: 'alert-abc-987',
  memo: 'Invoice #INV-2026-001',
  network: 'public',
  dashboardBaseUrl: 'https://app.stellaralerts.io',
};

describe('SlackNotificationProvider (#637)', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe('buildBlockKitPayload', () => {
    it('constructs a valid Slack Block Kit payload with header, section fields, context, and actions', () => {
      const payload = slackNotificationProvider.buildBlockKitPayload(sampleAlertData);

      expect(payload.text).toContain('💰 Stellar Payment Alert: 1250.75 USDC');
      expect(payload.blocks).toHaveLength(4);

      // Header block
      const header = payload.blocks[0];
      expect(header.type).toBe('header');
      if (header.type === 'header') {
        expect(header.text.type).toBe('plain_text');
        expect(header.text.text).toBe('🚨 Stellar Payment Alert');
        expect(header.text.emoji).toBe(true);
      }

      // Section block
      const section = payload.blocks[1];
      expect(section.type).toBe('section');
      if (section.type === 'section') {
        expect(section.fields).toBeDefined();
        const fieldTexts = section.fields!.map((f) => f.text);
        expect(fieldTexts.some((t) => t.includes('1250.75 USDC'))).toBe(true);
        expect(fieldTexts.some((t) => t.includes(sampleAlertData.fromAddress))).toBe(true);
        expect(fieldTexts.some((t) => t.includes(sampleAlertData.recipientAddress!))).toBe(true);
        expect(fieldTexts.some((t) => t.includes('Invoice #INV-2026-001'))).toBe(true);
        expect(fieldTexts.some((t) => t.includes('2026-10-19T14:30:00.000Z'))).toBe(true);
      }

      // Context block
      const context = payload.blocks[2];
      expect(context.type).toBe('context');
      if (context.type === 'context') {
        expect(context.elements).toHaveLength(1);
        expect(context.elements[0].text).toContain('Stellar Public Network');
        expect(context.elements[0].text).toContain('alert-abc-987');
      }

      // Actions block with buttons
      const actions = payload.blocks[3];
      expect(actions.type).toBe('actions');
      if (actions.type === 'actions') {
        expect(actions.elements).toHaveLength(3);

        // 1. Acknowledge button
        const ackBtn = actions.elements[0];
        expect(ackBtn.type).toBe('button');
        expect(ackBtn.action_id).toBe('acknowledge_alert');
        expect(ackBtn.style).toBe('primary');
        expect(ackBtn.value).toBe('alert-abc-987');
        expect(ackBtn.text.text).toContain('Acknowledge Alert');

        // 2. Stellar Expert button
        const explorerBtn = actions.elements[1];
        expect(explorerBtn.type).toBe('button');
        expect(explorerBtn.action_id).toBe('view_stellar_expert');
        expect(explorerBtn.url).toBe(
          `https://stellar.expert/explorer/public/tx/${sampleAlertData.txHash}`,
        );

        // 3. Dashboard button
        const dashBtn = actions.elements[2];
        expect(dashBtn.type).toBe('button');
        expect(dashBtn.action_id).toBe('open_dashboard');
        expect(dashBtn.url).toBe('https://app.stellaralerts.io/alerts/alert-abc-987');
      }
    });

    it('handles testnet network and default dashboard URL fallback', () => {
      const testnetData: SlackPaymentAlert = {
        paymentId: 'pay-testnet',
        txHash: '0x999',
        amount: '10',
        asset: 'XLM',
        fromAddress: 'GA_TEST',
        receivedAt: '2026-10-19T10:00:00Z',
        network: 'testnet',
      };

      const payload = slackNotificationProvider.buildBlockKitPayload(testnetData);
      const actions = payload.blocks.find((b) => b.type === 'actions') as any;
      const explorerBtn = actions.elements.find((el: any) => el.action_id === 'view_stellar_expert');
      const dashBtn = actions.elements.find((el: any) => el.action_id === 'open_dashboard');

      expect(explorerBtn.url).toBe('https://stellar.expert/explorer/testnet/tx/0x999');
      expect(dashBtn.url).toBe('https://stellar-alerts.com/alerts/pay-testnet');
    });
  });

  describe('isValidWebhookUrl', () => {
    it('accepts authentic Slack webhook URLs', () => {
      expect(
        slackNotificationProvider.isValidWebhookUrl(
          'https://hooks.slack.com/services/T00/B00/test-token',
        ),
      ).toBe(true);
    });

    it('rejects non-Slack or non-https URLs', () => {
      expect(slackNotificationProvider.isValidWebhookUrl('http://hooks.slack.com/services/1/2/3')).toBe(false);
      expect(slackNotificationProvider.isValidWebhookUrl('https://evil.com/hooks.slack.com/services/1/2/3')).toBe(false);
      expect(slackNotificationProvider.isValidWebhookUrl('not-a-url')).toBe(false);
      expect(slackNotificationProvider.isValidWebhookUrl(null)).toBe(false);
      expect(slackNotificationProvider.isValidWebhookUrl(undefined)).toBe(false);
    });
  });

  describe('sendWebhook', () => {
    it('dispatches payload via HTTP POST to Slack webhook endpoint', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => 'ok',
      } as Response);

      const webhookUrl = 'https://hooks.slack.com/services/T11/B22/ZZZ';
      const payload = slackNotificationProvider.buildBlockKitPayload(sampleAlertData);

      const result = await slackNotificationProvider.sendWebhook(webhookUrl, payload);

      expect(result.success).toBe(true);
      expect(result.statusCode).toBe(200);
      expect(global.fetch).toHaveBeenCalledTimes(1);

      const [calledUrl, calledOptions] = (global.fetch as any).mock.calls[0];
      expect(calledUrl).toBe(webhookUrl);
      expect(calledOptions.method).toBe('POST');
      expect(calledOptions.headers['Content-Type']).toBe('application/json');
    });

    it('handles HTTP 429 rate limit with retry-after header', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        headers: new Headers({ 'retry-after': '45' }),
        text: async () => 'rate_limited',
      } as unknown as Response);

      const webhookUrl = 'https://hooks.slack.com/services/T11/B22/ZZZ';
      const payload = slackNotificationProvider.buildBlockKitPayload(sampleAlertData);

      const result = await slackNotificationProvider.sendWebhook(webhookUrl, payload);

      expect(result.success).toBe(false);
      expect(result.rateLimited).toBe(true);
      expect(result.retryAfterSeconds).toBe(45);
      expect(result.error).toContain('rate limited');
    });

    it('handles non-200 HTTP error responses from Slack', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        headers: new Headers(),
        text: async () => 'internal_server_error',
      } as unknown as Response);

      const webhookUrl = 'https://hooks.slack.com/services/T11/B22/ZZZ';
      const payload = slackNotificationProvider.buildBlockKitPayload(sampleAlertData);

      const result = await slackNotificationProvider.sendWebhook(webhookUrl, payload);

      expect(result.success).toBe(false);
      expect(result.statusCode).toBe(500);
      expect(result.error).toContain('HTTP 500');
    });

    it('rejects invalid webhook URL without sending network request', async () => {
      global.fetch = vi.fn();

      const result = await slackNotificationProvider.sendWebhook(
        'https://invalid-url.com',
        slackNotificationProvider.buildBlockKitPayload(sampleAlertData),
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid Slack incoming webhook URL');
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  describe('sendBotMessage', () => {
    it('dispatches Block Kit message to Slack chat.postMessage API using bot token', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({ ok: true, channel: 'C12345', ts: '1729000000.000100' }),
      } as unknown as Response);

      const payload = slackNotificationProvider.buildBlockKitPayload(sampleAlertData);
      const result = await slackNotificationProvider.sendBotMessage('xoxb-mock-token', 'C12345', payload);

      expect(result.success).toBe(true);
      expect(result.statusCode).toBe(200);

      const [calledUrl, calledOptions] = (global.fetch as any).mock.calls[0];
      expect(calledUrl).toBe('https://slack.com/api/chat.postMessage');
      expect(calledOptions.headers['Authorization']).toBe('Bearer xoxb-mock-token');

      const body = JSON.parse(calledOptions.body);
      expect(body.channel).toBe('C12345');
      expect(body.blocks).toHaveLength(4);
    });

    it('handles Slack API error response (ok: false)', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({ ok: false, error: 'channel_not_found' }),
      } as unknown as Response);

      const payload = slackNotificationProvider.buildBlockKitPayload(sampleAlertData);
      const result = await slackNotificationProvider.sendBotMessage('xoxb-token', 'invalid-chan', payload);

      expect(result.success).toBe(false);
      expect(result.error).toBe('channel_not_found');
    });

    it('requires bot token and channel', async () => {
      const payload = slackNotificationProvider.buildBlockKitPayload(sampleAlertData);
      const result = await slackNotificationProvider.sendBotMessage('', '', payload);

      expect(result.success).toBe(false);
      expect(result.error).toContain('token and target channel are required');
    });
  });

  describe('dispatch and acknowledgeAlert', () => {
    it('routes to bot token delivery when botToken and channel are provided', async () => {
      const sendBotSpy = vi
        .spyOn(slackNotificationProvider, 'sendBotMessage')
        .mockResolvedValue({ success: true, statusCode: 200 });

      const result = await slackNotificationProvider.dispatch(
        { botToken: 'xoxb-token', channel: 'C001' },
        sampleAlertData,
      );

      expect(result.success).toBe(true);
      expect(sendBotSpy).toHaveBeenCalled();
    });

    it('routes to webhook delivery when webhookUrl is provided', async () => {
      const sendWebhookSpy = vi
        .spyOn(slackNotificationProvider, 'sendWebhook')
        .mockResolvedValue({ success: true, statusCode: 200 });

      const result = await slackNotificationProvider.dispatch(
        { webhookUrl: 'https://hooks.slack.com/services/T1/B1/Z1' },
        sampleAlertData,
      );

      expect(result.success).toBe(true);
      expect(sendWebhookSpy).toHaveBeenCalled();
    });

    it('records alert acknowledgment with timestamp', async () => {
      const ack = await slackNotificationProvider.acknowledgeAlert('alert-123', 'user-456', 'Verified onchain');

      expect(ack.acknowledged).toBe(true);
      expect(ack.alertId).toBe('alert-123');
      expect(ack.actorUserId).toBe('user-456');
      expect(ack.note).toBe('Verified onchain');
      expect(ack.timestamp).toBeInstanceOf(Date);
    });

    it('integrates with notificationsService.dispatchSlackNotification', async () => {
      const spy = vi
        .spyOn(slackNotificationProvider, 'dispatch')
        .mockResolvedValue({ success: true, statusCode: 200 });

      const result = await notificationsService.dispatchSlackNotification(
        { webhookUrl: 'https://hooks.slack.com/services/T1/B1/Z1' },
        sampleAlertData,
      );

      expect(result.success).toBe(true);
      expect(spy).toHaveBeenCalledWith(
        { webhookUrl: 'https://hooks.slack.com/services/T1/B1/Z1' },
        sampleAlertData,
      );
    });
  });
});
