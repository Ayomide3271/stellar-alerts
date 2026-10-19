/**
 * Notifications Service
 * 
 * Handles notification preference updates with MFA protection and multi-channel support:
 * Telegram, Email, WhatsApp, Discord, Slack, and Push Protocol.
 */

import { Prisma } from '../../../generated/prisma/client';
import { prisma } from '../../lib/prisma';
import { mfaService } from '../auth/mfa.service';
import { encryptPersonalField, decryptPersonalField } from '../../utils/privacy';
import { isValidE164Number } from '../../utils/whatsapp';
import { isValidSlackWebhookUrl } from '../../utils/slack';
import { ValidationError } from '../../lib/errors';
import { dispatchPushNotification } from '../../utils/push-protocol';
import { slackNotificationProvider } from './providers/slack.provider';

export function isValidDiscordWebhookUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'https:' &&
      (parsed.hostname === 'discord.com' || parsed.hostname === 'discordapp.com') &&
      parsed.pathname.startsWith('/api/webhooks/')
    );
  } catch {
    return false;
  }
}

export interface NotificationPreferences {
  telegramChatId?: string | null;
  telegramEnabled?: boolean;
  emailEnabled?: boolean;
  whatsappNumber?: string | null;
  whatsappEnabled?: boolean;
  discordWebhookUrl?: string | null;
  discordEnabled?: boolean;
  slackWebhookUrl?: string | null;
  slackEnabled?: boolean;
  pushChannelAddress?: string | null;
  pushEnabled?: boolean;
  enabledChannels?: string[];
  assetFilters?: string[];
  minAmount?: number | string | null;
  receiptPreference?: 'instant' | 'daily_digest' | 'summary' | string;
  language?: string;
  filterRules?: any;
}

export class NotificationsService {
  /**
   * Update notification preferences (MFA-protected).
   * 
   * @param userId - User ID
   * @param preferences - Notification preferences to update
   * @param mfaToken - TOTP token (required if MFA is enabled)
   */
  async updatePreferences(
    userId: string,
    preferences: NotificationPreferences,
    mfaToken?: string
  ): Promise<void> {
    // Check if MFA is enabled
    const mfaEnabled = await mfaService.isMFAEnabled(userId);

    if (mfaEnabled) {
      // MFA is enabled - require token
      if (!mfaToken) {
        throw new Error('MFA token required');
      }

      const isValid = await mfaService.verifyMFAToken(userId, mfaToken);
      if (!isValid) {
        throw new Error('Invalid MFA token');
      }
    }

    // Validate the WhatsApp number whenever one is supplied, regardless of
    // whatsappEnabled — a malformed number shouldn't silently persist.
    if (preferences.whatsappNumber !== undefined && preferences.whatsappNumber !== null && !isValidE164Number(preferences.whatsappNumber)) {
      throw new ValidationError('Invalid WhatsApp number. Use E.164 format, e.g. +14155551234.', undefined, 'INVALID_WHATSAPP_NUMBER');
    }

    // Opting in requires a number either in this request or already on file.
    if (preferences.whatsappEnabled && !preferences.whatsappNumber) {
      const existing = await prisma.notificationPreference.findUnique({ where: { userId } });
      if (!existing?.whatsappNumber) {
        throw new ValidationError('A valid WhatsApp number is required to enable WhatsApp notifications', undefined, 'MISSING_WHATSAPP_NUMBER');
      }
    }

    // Validate Discord webhook URL if supplied
    if (preferences.discordWebhookUrl !== undefined && preferences.discordWebhookUrl !== null && preferences.discordWebhookUrl !== '') {
      if (!isValidDiscordWebhookUrl(preferences.discordWebhookUrl)) {
        throw new ValidationError('Invalid Discord webhook URL. Must be an https://discord.com/api/webhooks/... URL.', undefined, 'INVALID_DISCORD_WEBHOOK');
      }
    }

    // Validate Slack webhook URL if supplied
    if (preferences.slackWebhookUrl !== undefined && preferences.slackWebhookUrl !== null && preferences.slackWebhookUrl !== '') {
      if (!isValidSlackWebhookUrl(preferences.slackWebhookUrl)) {
        throw new ValidationError('Invalid Slack webhook URL. Must be an https://hooks.slack.com/services/... URL.', undefined, 'INVALID_SLACK_WEBHOOK');
      }
    }

    // Validate Push Protocol channel address if supplied
    if (preferences.pushChannelAddress !== undefined && preferences.pushChannelAddress !== null && preferences.pushChannelAddress !== '') {
      const addr = preferences.pushChannelAddress.trim();
      if (addr.length < 5) {
        throw new ValidationError('Invalid Push Protocol channel address.', undefined, 'INVALID_PUSH_CHANNEL');
      }
    }

    // Validate receipt preference
    if (preferences.receiptPreference !== undefined && preferences.receiptPreference !== null) {
      const allowedReceipts = ['instant', 'daily_digest', 'summary'];
      if (!allowedReceipts.includes(preferences.receiptPreference)) {
        throw new ValidationError(
          `Invalid receipt preference. Allowed values: ${allowedReceipts.join(', ')}`,
          undefined,
          'INVALID_RECEIPT_PREFERENCE'
        );
      }
    }

    // Validate min amount
    if (preferences.minAmount !== undefined && preferences.minAmount !== null) {
      const num = Number(preferences.minAmount);
      if (isNaN(num) || num < 0) {
        throw new ValidationError('Minimum amount must be a non-negative number.', undefined, 'INVALID_MIN_AMOUNT');
      }
    }

    // Validate asset filters
    if (preferences.assetFilters !== undefined && !Array.isArray(preferences.assetFilters)) {
      throw new ValidationError('assetFilters must be an array of asset strings.', undefined, 'INVALID_ASSET_FILTERS');
    }

    // Validate enabled channels
    if (preferences.enabledChannels !== undefined) {
      if (!Array.isArray(preferences.enabledChannels)) {
        throw new ValidationError('enabledChannels must be an array.', undefined, 'INVALID_ENABLED_CHANNELS');
      }
      const allowedChannels = ['telegram', 'email', 'whatsapp', 'discord', 'slack', 'push'];
      for (const ch of preferences.enabledChannels) {
        if (!allowedChannels.includes(ch)) {
          throw new ValidationError(`Unknown channel in enabledChannels: ${ch}`, undefined, 'INVALID_CHANNEL_NAME');
        }
      }
    }

    const dataToSave: any = {
      telegramEnabled: preferences.telegramEnabled,
      emailEnabled: preferences.emailEnabled,
      whatsappEnabled: preferences.whatsappEnabled,
      discordWebhookUrl: preferences.discordWebhookUrl,
      discordEnabled: preferences.discordEnabled,
      slackWebhookUrl: preferences.slackWebhookUrl,
      slackEnabled: preferences.slackEnabled,
      pushChannelAddress: preferences.pushChannelAddress,
      pushEnabled: preferences.pushEnabled,
      receiptPreference: preferences.receiptPreference,
      assetFilters: preferences.assetFilters,
      minAmount: preferences.minAmount !== undefined && preferences.minAmount !== null
        ? String(preferences.minAmount)
        : preferences.minAmount === null ? null : undefined,
      enabledChannels: preferences.enabledChannels,
      language: preferences.language,
      filterRules: preferences.filterRules,
    };

    if (preferences.telegramChatId !== undefined) {
      dataToSave.telegramChatId = preferences.telegramChatId
        ? encryptPersonalField(preferences.telegramChatId)
        : preferences.telegramChatId;
    }

    if (preferences.whatsappNumber !== undefined) {
      dataToSave.whatsappNumber = preferences.whatsappNumber
        ? encryptPersonalField(preferences.whatsappNumber)
        : preferences.whatsappNumber;
    }

    // Clean undefined fields for Prisma
    const cleanedData: any = {};
    for (const [key, value] of Object.entries(dataToSave)) {
      if (value !== undefined) {
        cleanedData[key] = value;
      }
    }

    // Update preferences with encrypted PII (#314)
    await (prisma as any).notificationPreference.upsert({
      where: { userId },
      create: {
        userId,
        ...cleanedData,
      },
      update: cleanedData,
    });

    console.log(`[NotificationsService] ✅ Preferences updated for user ${userId}`);
  }

  /**
   * Get notification preferences for a user.
   *
   * @param userId - User ID
   */
  async getPreferences(userId: string) {
    const pref = await prisma.notificationPreference.findUnique({
      where: { userId },
    });
    if (!pref) return null;
    return {
      ...pref,
      telegramChatId: decryptPersonalField(pref.telegramChatId),
      whatsappNumber: decryptPersonalField(pref.whatsappNumber),
      minAmount: pref.minAmount ? pref.minAmount.toString() : null,
    };
  }

  /**
   * Sends a one-off test message on a configured channel so a user can
   * confirm the link works (e.g. from the onboarding wizard) before relying
   * on it for real payment alerts.
   *
   * @param userId - User ID
   * @param channel - Which channel to ping. Supports 'telegram', 'push', etc.
   */
  async sendTestPing(
    userId: string,
    channel: 'telegram' | 'push'
  ): Promise<{ success: boolean; message: string }> {
    const prefs = await prisma.notificationPreference.findUnique({ where: { userId } });

    if (channel === 'telegram') {
      if (!prefs?.telegramChatId) {
        throw new Error('No Telegram chat ID is linked for this user yet');
      }

      const telegramChatId = decryptPersonalField(prefs.telegramChatId);
      const botToken = process.env.TELEGRAM_BOT_TOKEN;
      if (!botToken) {
        throw new Error('Telegram bot is not configured');
      }

      try {
        const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: telegramChatId,
            text: '✅ Stellar Alerts test ping — your Telegram alerts are connected.',
          }),
          signal: AbortSignal.timeout(10_000),
        });

        if (!response.ok) {
          return { success: false, message: `Telegram responded with status ${response.status}` };
        }

        return { success: true, message: 'Test message sent to your linked Telegram chat.' };
      } catch (error: any) {
        return { success: false, message: error.message || 'Failed to reach Telegram' };
      }
    }

    if (channel === 'push') {
      if (!prefs?.pushChannelAddress) {
        throw new Error('No Push Protocol channel address is configured for this user yet');
      }

      try {
        const ok = await dispatchPushNotification(prefs.pushChannelAddress, {
          paymentId: 'test-ping',
          txHash: '0x0000000000000000000000000000000000000000000000000000000000000000',
          amount: '0.00',
          asset: 'XLM',
          fromAddress: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
          recipientAddress: prefs.pushChannelAddress,
          receivedAt: new Date().toISOString(),
        });

        if (!ok) {
          return { success: false, message: 'Push Protocol test notification could not be sent' };
        }
        return { success: true, message: 'Push Protocol test notification dispatched successfully.' };
      } catch (error: any) {
        return { success: false, message: error.message || 'Failed to reach Push Protocol' };
      }
    }

    throw new Error(`Unsupported test ping channel: ${channel}`);
  }

  /**
   * Dispatch an interactive Slack Block Kit notification (#637).
   */
  async dispatchSlackNotification(
    target: { webhookUrl?: string; botToken?: string; channel?: string },
    data: Parameters<typeof slackNotificationProvider.buildBlockKitPayload>[0],
  ) {
    return slackNotificationProvider.dispatch(target, data);
  }
}

export const notificationsService = new NotificationsService();
