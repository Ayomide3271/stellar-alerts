import Fastify from 'fastify';
import { describe, it, expect, afterEach } from 'vitest';
import { registerSecurityHeaders } from '../middleware/security.middleware';

describe('Strict-Transport-Security (HSTS) configuration', () => {
  const originalEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
  });

  it('enforces 2-year max-age, includeSubDomains, and preload in production', async () => {
    process.env.NODE_ENV = 'production';
    const app = Fastify();
    await registerSecurityHeaders(app);
    app.get('/test', async () => ({ ok: true }));

    const res = await app.inject({ method: 'GET', url: '/test' });
    expect(res.statusCode).toBe(200);

    const hsts = res.headers['strict-transport-security'];
    expect(hsts).toBe('max-age=63072000; includeSubDomains; preload');
    expect(hsts).toContain('max-age=63072000');
    expect(hsts).toContain('includeSubDomains');
    expect(hsts).toContain('preload');
  });

  it('loosens HSTS to max-age=0 in non-production environments to allow localhost testing', async () => {
    process.env.NODE_ENV = 'development';
    const app = Fastify();
    await registerSecurityHeaders(app);
    app.get('/test', async () => ({ ok: true }));

    const res = await app.inject({ method: 'GET', url: '/test' });
    expect(res.statusCode).toBe(200);

    const hsts = res.headers['strict-transport-security'];
    expect(hsts).toBe('max-age=0');
  });
});
