import { describe, it, expect, vi } from 'vitest';
import { probeClusterStatus, formatClusterStatusTable } from '../commands/status';

describe('Cluster Status Probe Command (#774)', () => {
  it('correctly parses healthy cluster responses and active watchers', async () => {
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith('/health')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ status: 'ok', services: { database: 'up', redis: 'up' } }),
        });
      }
      if (url.endsWith('/metrics/summary')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ activeWatchers: 42 }),
        });
      }
      return Promise.reject(new Error('Unknown URL'));
    });

    const status = await probeClusterStatus('http://test-api:3000', mockFetch as any);
    expect(status.apiStatus).toBe('healthy');
    expect(status.databaseStatus).toBe('connected');
    expect(status.redisStatus).toBe('connected');
    expect(status.activeWatchers).toBe(42);
    expect(status.latencyMs).toBeGreaterThanOrEqual(0);

    const table = formatClusterStatusTable(status);
    expect(table).toContain('Stellar Alerts Cluster Status');
    expect(table).toContain('HEALTHY');
  });

  it('reports degraded status when API health returns non-200', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
    });

    const status = await probeClusterStatus('http://test-api:3000', mockFetch as any);
    expect(status.apiStatus).toBe('degraded');
  });

  it('handles complete network failure as offline', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const status = await probeClusterStatus('http://offline-host:3000', mockFetch as any);
    expect(status.apiStatus).toBe('offline');
    expect(status.databaseStatus).toBe('error');
    expect(status.redisStatus).toBe('error');
  });
});
