import { readFileSync } from 'fs';
import { join } from 'path';
import { prisma } from '../lib/prisma';
import { notificationService } from '../modules/notifications/notification.service';
import { logger } from '../lib/logger';

export interface DigestSummary {
  userId: string;
  email: string;
  displayName: string;
  totalPaymentsReceived: number;
  totalVolume: string;
  totalVolumeAsset: string;
  securityAlierts: Array<{ title: string; description: string; occurredAt: string }>;
  windowStart: string;
  windowEnd: string;
}

const DIGEST_TEMPLATE_PATH = join(__dirname, '../modules/notifications/templates/digest.html');
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatAmount(amount: bigint | number | string, asset: string): string {
  const numeric = typeof amount === 'bigint' ? Number(amount) : Number(amount);
  if (!Number.isFinite(numeric)) {
    return `0.0000000 ${asset}`;
  }
  return `${numeric.toFixed(7)} ${asset}`;
}

export async function compileDigestSummaries(
  windowStart: Date,
  windowEnd: Date,
): Promise<DigestSummary[]> {
  const users = await prisma.user.findMany({
    where: {
      notificationFrequency: 'DAILY',
      emailVerifiedAt: { not: null },
    },
    select: {
      id: true,
      email: true,
      displayName: true,
      walletAddress: true,
    },
  });

  const summaries: DigestSummary[] = [];

  for (const user of users) {
    const payments = await prisma.payment.findMany({
      where: {
        recipientWalletAddress: user.walletAddress,
        status: 'COMPLETED',
        createdAt: { gte: windowStart, lte: windowEnd },
      },
      select: { amount: true, assetCode: true },
    });

    const alerts = await prisma.securityAlert.findMany({
      where: {
        userId: user.id,
        createdAt: { gte: windowStart, lte: windowEnd },
      },
      select: { title: true, description: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });

    let totalVolume = 0n;
    const assetCounts = new Map<string, number>();
    for (const payment of payments) {
      const asset = payment.assetCode ?? 'XLM';
      assetCounts.set(asset, (assetCounts.get(asset) ?? 0) + 1);
      totalVolume += BigInt(payment.amount.toString());
    }

    let primaryAsset = 'XLM';
    let primaryCount = 0;
    for (const [asset, count] of assetCounts.entries()) {
      if (count > primaryCount) {
        primaryCount = count;
        primaryAsset = asset;
      }
    }

    summaries.push({
      userId: user.id,
      email: user.email,
      displayName: user.displayName ?? user.email.split('@')[0],
      totalPaymentsReceived: payments.length,
      totalVolume: formatAmount(totalVolume, primaryAsset),
      totalVolumeAsset: primaryAsset,
      securityAlierts: alerts.map((alert) => ({
        title: alert.title,
        description: alert.description,
        occurredAt: alert.createdAt.toISOString(),
      })),
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
    });
  }

  return summaries;
}

export function renderDigestHtml(summary: DigestSummary): string {
  const template = readFileSync(DIGEST_TEMPLATE_PATH, 'utf-8');

  const alertsHtml =
    summary.securityAlierts.length > 0
      ? summary.securityAlierts
          .map(
            (alert) =>
              `<tr><td style="padding:12px;border-bottom:1px solid #eee;"><strong>${escapeHtml(alert.title)}</strong><br/><span style="color:#555;font-size:13px;">${escapeHtml(alert.description)}</span><br/><span style="color:#999;font-size:12px;">${escapeHtml(alert.occurredAt)}</span></td></tr>`,
          )
          .join('')
      : `<tr><td style="padding:12px;color:#555;">No security alerts in the past 24 hours.</td></tr>`;

  const replacements: Record<string, string> = {
    '{{displayName}}': escapeHtml(summary.displayName),
    '{{totalPaymentsReceived}}': String(summary.totalPaymentsReceived),
    '{{totalVolume}}': escapeHtml(summary.totalVolume),
    '{{securityAliertsHtml}}': alertsHtml,
    '{{windowStart}}': escapeHtml(summary.windowStart),
    '{{windowEnd}}': escapeHtml(summary.windowEnd),
  };

  let html = template;
  for (const [token, value] of Object.entries(replacements)) {
    html = html.split(token).join(value);
  }
  return html;
}

export async function runDigestWorker(now: Date = new Date()): Promise<{ sent: number; failed: number }> {
  const windowEnd = new Date(now);
  const windowStart = new Date(windowEnd.getTime() - TWENTY_FOUR_HOURS_MS);

  const summaries = await compileDigestSummaries(windowStart, windowEnd);

  let sent = 0;
  let failed = 0;

  for (const summary of summaries) {
    try {
      const html = renderDigestHtml(summary);
      await notificationService.sendEmail({
        to: summary.email,
        subject: `Your 24-hour Stellar Alerts digest`,
        html,
        text: `Payments received: ${summary.totalPaymentsReceived}\nTotal volume: ${summary.totalVolume}\nSecurity alerts: ${summary.securityAlierts.length}`,
      });
      sent += 1;
    } catch (error) {
      failed += 1;
      logger.error('DigestWorker failed to send digest', {
        userId: summary.userId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  logger.info('DigestWorker completed', { sent, failed, windowStart, windowEnd });
  return { sent, failed };
}

export const digestWorker = {
  name: 'DigestWorker',
  cron: '0 0 0 * * *',
  async run(): Promise<void> {
    await runDigestWorker();
  },
};

export default digestWorker;
