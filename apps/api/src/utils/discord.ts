import { env } from '../config/env';
import { fetchWithTimeout } from '../lib/external-request';

export interface DiscordAlertData {
  paymentId: string;
  txHash: string;
  amount: string;
  asset: string;
  assetIssuer?: string | null;
  fromAddress: string;
  receivedAt: string;
}

const STELLAR_EXPERT_TX_URL = 'https://stellar.expert/explorer/testnet/tx';
const DISCORD_EMBED_COLOR = 0x5865f2;

export function getStellarExpertTxLink(txHash: string): string {
  return `${STELLAR_EXPERT_TX_URL}/${txHash}`;
}

function getAssetBadge(asset: string, assetIssuer?: string | null): string {
  if (asset === 'XLM' || asset === 'native') {
    return '🌟 XLM';
  }
  return assetIssuer ? `🪙 ${asset} (${assetIssuer.slice(0, 4)}...${assetIssuer.slice(-4)})` : `🪙 ${asset}`;
}

/**
 * Discord component object types.
 * @see https://discord.com/developers/docs/interactions/message-components
 */
export const DISCORD_COMPONENT_TYPE = {
  ACTION_ROW: 1,
  BUTTON: 2,
} as const;

export const DISCORD_BUTTON_STYLE = {
  PRIMARY: 1,
  SECONDARY: 2,
  SUCCESS: 3,
  DANGER: 4,
  LINK: 5,
} as const;

export interface DiscordButtonComponent {
  type: typeof DISCORD_COMPONENT_TYPE.BUTTON;
  style: (typeof DISCORD_BUTTON_STYLE)[keyof typeof DISCORD_BUTTON_STYLE];
  label: string;
  custom_id: string;
  disabled?: boolean;
  emoji?: { name: string };
}

export interface DiscordActionRow {
  type: typeof DISCORD_COMPONENT_TYPE.ACTION_ROW;
  components: DiscordButtonComponent[];
}

export interface DiscordEmbedPayload {
  username: string;
  embeds: Array<{
    title: string;
    color: number;
    fields: Array<{ name: string; value: string; inline?: boolean }>;
    timestamp: string;
    footer: { text: string };
  }>;
  components?: DiscordActionRow[];
}

/**
 * Actions an operator can trigger straight from a Discord alert message.
 */
export type DiscordAlertAction = 'ack' | 'snooze' | 'reroute';

export const ALERT_CUSTOM_ID_PREFIX = 'sa:v1';

/** Default snooze windows exposed as buttons, in seconds. */
export const DEFAULT_SNOOZE_DURATIONS = [3600, 14400] as const;

export interface ParsedAlertCustomId {
  action: DiscordAlertAction;
  alertId: string;
  /** Snooze duration (seconds) or re-route target, depending on the action. */
  param?: string;
}

/**
 * Encode a button `custom_id`. The format is
 * `sa:v1:<action>:<alertId>[:<param>]` — stable enough to parse back after a
 * redeploy and namespaced (`sa:`) so it never collides with other bots.
 */
export function buildAlertCustomId(
  action: DiscordAlertAction,
  alertId: string,
  param?: string | number,
): string {
  if (!alertId) {
    throw new Error('alertId is required to build a Discord custom_id');
  }
  const parts = [ALERT_CUSTOM_ID_PREFIX, action, alertId];
  if (param !== undefined && param !== null && `${param}`.length > 0) {
    parts.push(String(param));
  }
  return parts.join(':');
}

/**
 * Parse a button `custom_id` back into an action + alert reference. Returns
 * `null` for anything that is not a well-formed alert custom id so callers can
 * respond with a friendly ephemeral message instead of throwing.
 */
export function parseAlertCustomId(customId: string | undefined | null): ParsedAlertCustomId | null {
  if (!customId) return null;
  const parts = customId.split(':');
  if (parts.length < 4) return null;
  const [ns, version, action, alertId, ...rest] = parts;
  if (ns !== 'sa' || version !== 'v1') return null;
  if (action !== 'ack' && action !== 'snooze' && action !== 'reroute') return null;
  if (!alertId) return null;
  return { action, alertId, param: rest.length > 0 ? rest.join(':') : undefined };
}

export interface BuildAlertComponentsOptions {
  /** Snooze windows, in seconds. Defaults to 1h and 4h. */
  snoozeDurations?: readonly number[];
  /** Include the re-route button (default true). */
  allowReroute?: boolean;
  /** Optional re-route target encoded into the custom id, e.g. "oncall". */
  rerouteTarget?: string;
}

/**
 * Build the interactive action row attached to a payment alert so operators
 * can acknowledge, snooze, or re-route it without leaving Discord.
 */
export function buildDiscordAlertComponents(
  alertId: string,
  options: BuildAlertComponentsOptions = {},
): DiscordActionRow[] {
  const snoozeDurations = options.snoozeDurations ?? DEFAULT_SNOOZE_DURATIONS;
  const allowReroute = options.allowReroute ?? true;

  const buttons: DiscordButtonComponent[] = [
    {
      type: DISCORD_COMPONENT_TYPE.BUTTON,
      style: DISCORD_BUTTON_STYLE.SUCCESS,
      label: 'Acknowledge',
      custom_id: buildAlertCustomId('ack', alertId),
      emoji: { name: '✅' },
    },
    ...snoozeDurations.slice(0, 3).map((seconds) => ({
      type: DISCORD_COMPONENT_TYPE.BUTTON,
      style: DISCORD_BUTTON_STYLE.SECONDARY,
      label: `Snooze ${formatSnoozeLabel(seconds)}`,
      custom_id: buildAlertCustomId('snooze', alertId, seconds),
      emoji: { name: '⏰' },
    })),
  ];

  if (allowReroute) {
    buttons.push({
      type: DISCORD_COMPONENT_TYPE.BUTTON,
      style: DISCORD_BUTTON_STYLE.PRIMARY,
      label: 'Re-route',
      custom_id: buildAlertCustomId('reroute', alertId, options.rerouteTarget ?? 'default'),
      emoji: { name: '🔀' },
    });
  }

  // Discord caps an action row at 5 components.
  return [
    {
      type: DISCORD_COMPONENT_TYPE.ACTION_ROW,
      components: buttons.slice(0, 5),
    },
  ];
}

function formatSnoozeLabel(seconds: number): string {
  if (seconds % 86400 === 0) return `${seconds / 86400}d`;
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

export function buildDiscordEmbed(
  data: DiscordAlertData,
  options: { components?: DiscordActionRow[] } = {},
): DiscordEmbedPayload {
  const payload: DiscordEmbedPayload = {
    username: 'Stellar Alerts',
    embeds: [
      {
        title: '💸 Payment Received',
        color: DISCORD_EMBED_COLOR,
        fields: [
          { name: 'Amount', value: `\`${data.amount} ${data.asset}\``, inline: true },
          { name: 'Asset', value: getAssetBadge(data.asset, data.assetIssuer), inline: true },
          { name: 'From', value: `\`${data.fromAddress}\``, inline: false },
          {
            name: 'Transaction',
            value: `[${data.txHash.slice(0, 8)}...${data.txHash.slice(-8)}](${getStellarExpertTxLink(data.txHash)})`,
            inline: false,
          },
        ],
        timestamp: new Date(data.receivedAt).toISOString(),
        footer: { text: `Payment ID: ${data.paymentId}` },
      },
    ],
  };

  if (options.components && options.components.length > 0) {
    payload.components = options.components;
  }

  return payload;
}

export function parseDiscordWebhookUrls(rawUrls: string | string[]): string[] {
  if (Array.isArray(rawUrls)) {
    return rawUrls.map((u) => u.trim()).filter((u) => u.length > 0 && (u.startsWith('http://') || u.startsWith('https://')));
  }
  if (!rawUrls || typeof rawUrls !== 'string') return [];
  return rawUrls
    .split(/[\r\n,;]+/)
    .map((u) => u.trim())
    .filter((u) => u.length > 0 && (u.startsWith('http://') || u.startsWith('https://')));
}

export async function dispatchDiscordAlert(
  webhookUrl: string | string[],
  data: DiscordAlertData,
  options: {
    timeoutMs?: number;
    signal?: AbortSignal;
    /** Alert identifier; when supplied the message gets interactive buttons. */
    alertId?: string;
    components?: DiscordActionRow[];
  } = {},
): Promise<boolean> {
  const urls = parseDiscordWebhookUrls(webhookUrl);
  if (urls.length === 0) {
    console.warn(`[Discord] No valid webhook URLs provided for payment ${data.paymentId}`);
    return false;
  }

  const components =
    options.components ?? (options.alertId ? buildDiscordAlertComponents(options.alertId) : undefined);
  const payload = buildDiscordEmbed(data, { components });
  const timeoutMs = options.timeoutMs ?? env.NOTIFICATION_PROVIDER_TIMEOUT_MS;

  const results = await Promise.allSettled(
    urls.map(async (url) => {
      try {
        const response = await fetchWithTimeout(
          url,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          },
          timeoutMs,
          options.signal,
          'Discord',
        );

        if (!response.ok) {
          console.warn(`[Discord] Webhook responded with status ${response.status} for payment ${data.paymentId} at ${url}`);
        }

        return response.ok;
      } catch (error: any) {
        console.error(`[Discord] Failed to dispatch embed for payment ${data.paymentId} to ${url}:`, error.message);
        return false;
      }
    }),
  );

  return results.some((r) => r.status === 'fulfilled' && r.value === true);
}

