import { describe, it, expect, vi } from 'vitest';
import {
  SsrfFilter,
  SsrfBlockedError,
  SecurityAuditEntry,
  matchesIpv4Cidr,
  isBlockedIpAddress,
} from '../ssrf-filter';
import { validateWebhookRegistration } from '../webhook.validator';
import { DispatcherWorker } from '../../../workers/dispatcher.worker';

describe('SsrfFilter & Private IP Egress Firewall (#650)', () => {
  it('checks IPv4 addresses against the CIDR blocklist accurately', () => {
    expect(matchesIpv4Cidr('127.0.0.1', '127.0.0.0/8')).toBe(true);
    expect(matchesIpv4Cidr('10.24.0.5', '10.0.0.0/8')).toBe(true);
    expect(matchesIpv4Cidr('172.16.0.1', '172.16.0.0/12')).toBe(true);
    expect(matchesIpv4Cidr('172.31.255.254', '172.16.0.0/12')).toBe(true);
    expect(matchesIpv4Cidr('172.32.0.1', '172.16.0.0/12')).toBe(false);
    expect(matchesIpv4Cidr('192.168.1.100', '192.168.0.0/16')).toBe(true);
    expect(matchesIpv4Cidr('169.254.169.254', '169.254.169.254/32')).toBe(true);
    expect(matchesIpv4Cidr('93.184.216.34', '10.0.0.0/8')).toBe(false);
  });

  it('rejects localhost, loopback, RFC 1918 private IPs, and cloud metadata 169.254.169.254 with HTTP 400 and security audit log', async () => {
    const auditEvents: SecurityAuditEntry[] = [];
    const filter = new SsrfFilter({
      auditLogger: (entry) => auditEvents.push(entry),
      dnsResolver: async (hostname) => {
        if (hostname === 'internal-redis.corp') {
          return [{ address: '10.0.1.25', family: 4 }];
        }
        if (hostname === 'aws-meta.attacker.test') {
          return [{ address: '169.254.169.254', family: 4 }];
        }
        return [{ address: '93.184.216.34', family: 4 }];
      },
    });

    const blockedUrls = [
      'http://localhost:6379/redis',
      'https://127.0.0.1/admin',
      'https://10.0.0.42/internal',
      'https://172.16.10.5/service',
      'https://192.168.1.1/router',
      'http://169.254.169.254/latest/meta-data/',
      'https://[::1]/loopback',
      'https://internal-redis.corp/hook',
      'https://aws-meta.attacker.test/steal',
    ];

    for (const url of blockedUrls) {
      await expect(filter.validateAndResolve(url)).rejects.toThrow(SsrfBlockedError);
      try {
        await filter.validateAndResolve(url);
      } catch (err: any) {
        expect(err).toBeInstanceOf(SsrfBlockedError);
        expect(err.statusCode).toBe(400);
      }
    }

    expect(auditEvents.length).toBeGreaterThanOrEqual(blockedUrls.length);
    expect(auditEvents[0].event).toBe('SSRF_EGRESS_BLOCKED');
  });

  it('passes legitimate public HTTPS URLs seamlessly and pins the resolved IP to prevent DNS rebinding', async () => {
    const dnsResolver = vi.fn().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    const filter = new SsrfFilter({ dnsResolver });

    const validated = await validateWebhookRegistration(
      { url: 'https://events.example.com/webhooks/stellar' },
      filter
    );

    expect(validated.url).toBe('https://events.example.com/webhooks/stellar');
    expect(validated.pinnedTarget.pinnedIp).toBe('93.184.216.34');
    expect(validated.pinnedTarget.hostHeader).toBe('events.example.com');
    expect(validated.pinnedTarget.pinnedUrl).toBe('https://93.184.216.34/webhooks/stellar');
    expect(dnsResolver).toHaveBeenCalledTimes(1);

    const agent = filter.createPinnedAgent(validated.pinnedTarget);
    expect(agent).toBeDefined();
  });

  it('prevents webhook dispatch to SSRF targets in DispatcherWorker and pins IP for valid targets', async () => {
    const fakeBreaker = {
      canExecute: vi.fn().mockResolvedValue(true),
      execute: vi.fn(async (_id: string, fn: () => Promise<any>) => fn()),
    } as any;

    const filter = new SsrfFilter({
      dnsResolver: async (host) => {
        if (host === 'rebind.attacker.test') {
          return [{ address: '169.254.169.254', family: 4 }];
        }
        return [{ address: '93.184.216.34', family: 4 }];
      },
    });

    const transport = vi.fn(async (_url, _payload, _headers, pinnedTarget) => ({
      status: 200,
      body: pinnedTarget?.pinnedIp,
    }));

    const worker = new DispatcherWorker(fakeBreaker, transport, filter);

    const blockedResult = await worker.processJob({
      data: {
        webhookId: 'wh-blocked',
        url: 'https://rebind.attacker.test/collect',
        payload: { alert: 'test' },
      },
    });

    expect(blockedResult.status).toBe('failed');
    expect(blockedResult.statusCode).toBe(400);
    expect(transport).not.toHaveBeenCalled();

    const allowedResult = await worker.processJob({
      data: {
        webhookId: 'wh-ok',
        url: 'https://alerts.example.com/notify',
        payload: { alert: 'test' },
      },
    });

    expect(allowedResult.status).toBe('delivered');
    expect(allowedResult.statusCode).toBe(200);
    expect(allowedResult.pinnedIp).toBe('93.184.216.34');
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('blocks IPv6 link-local, unique-local, and IPv4-mapped loopback addresses', () => {
    expect(isBlockedIpAddress('fe80::1').blocked).toBe(true);
    expect(isBlockedIpAddress('fd00::1234').blocked).toBe(true);
    expect(isBlockedIpAddress('::ffff:127.0.0.1').blocked).toBe(true);
    expect(isBlockedIpAddress('2606:2800:220:1:248:1893:25c8:1946').blocked).toBe(false);
  });
});
