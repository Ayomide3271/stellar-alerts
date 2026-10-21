import { createWebhookSchema } from './webhooks.schema';
import { ssrfFilter, SsrfFilter, PinnedWebhookTarget } from './ssrf-filter';
import { zodValidationError } from '../../lib/errors';

export interface ValidatedWebhookInput {
  url: string;
  payloadTemplate?: string;
  pinnedTarget: PinnedWebhookTarget;
}

/**
 * Validates incoming webhook registration or mutation payloads:
 * 1. Validates schema shape via Zod.
 * 2. Resolves DNS and checks resolved IPs against the SSRF CIDR blocklist.
 * 3. Throws HTTP 400 ValidationError / SsrfBlockedError and logs a security
 *    audit entry if the URL targets localhost, RFC 1918 private IPs, or cloud
 *    metadata endpoints.
 */
export async function validateWebhookRegistration(
  input: unknown,
  filter: SsrfFilter = ssrfFilter
): Promise<ValidatedWebhookInput> {
  const parsed = createWebhookSchema.safeParse(input);
  if (!parsed.success) {
    throw zodValidationError(parsed, 'Invalid payload');
  }

  const pinnedTarget = await filter.validateAndResolve(parsed.data.url);

  return {
    url: parsed.data.url,
    payloadTemplate: parsed.data.payloadTemplate,
    pinnedTarget,
  };
}

export async function validateWebhookUrl(
  url: string,
  filter: SsrfFilter = ssrfFilter
): Promise<PinnedWebhookTarget> {
  return filter.validateAndResolve(url);
}
