import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { openApiOptions, openApiComponentSchemas } from '../openapi.config';

describe('Swagger / OpenAPI documentation (#docs)', () => {
  it('GET /docs returns 200 OK and renders interactive documentation', async () => {
    const app = Fastify();
    await app.register(swagger, openApiOptions);
    await app.register(swaggerUi, { routePrefix: '/docs' });
    await app.ready();

    const response = await app.inject({
      method: 'GET',
      url: '/docs',
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');

    await app.close();
  });

  it('GET /docs/json returns a valid OpenAPI 3.x document', async () => {
    const app = Fastify();
    await app.register(swagger, openApiOptions);
    await app.register(swaggerUi, { routePrefix: '/docs' });
    await app.ready();

    const response = await app.inject({
      method: 'GET',
      url: '/docs/json',
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/json');

    const spec = JSON.parse(response.body);
    expect(spec.openapi).toMatch(/^3\./);
    expect(spec.info.title).toBe('Stellar Alerts API');
    expect(spec.info.version).toBe('1.0.0');

    // Verify tags are present
    const tagNames = spec.tags?.map((t: { name: string }) => t.name) ?? [];
    expect(tagNames).toContain('auth');
    expect(tagNames).toContain('wallets');
    expect(tagNames).toContain('payments');
    expect(tagNames).toContain('webhooks');

    await app.close();
  });

  it('OpenAPI component schemas include all Zod-derived schemas', () => {
    // Verify all expected component schemas are exported from openapi.config
    expect(openApiComponentSchemas).toHaveProperty('RequestLinkInput');
    expect(openApiComponentSchemas).toHaveProperty('VerifyLinkInput');
    expect(openApiComponentSchemas).toHaveProperty('DIDChallengeInput');
    expect(openApiComponentSchemas).toHaveProperty('DIDVerifyInput');
    expect(openApiComponentSchemas).toHaveProperty('CreateWalletInput');
    expect(openApiComponentSchemas).toHaveProperty('CreateWebhookInput');
    expect(openApiComponentSchemas).toHaveProperty('DeadLetterIdParams');
    expect(openApiComponentSchemas).toHaveProperty('ListDeadLettersQuery');
    expect(openApiComponentSchemas).toHaveProperty('SuppressDeadLetterInput');
    expect(openApiComponentSchemas).toHaveProperty('SandboxReplayIdParams');
    expect(openApiComponentSchemas).toHaveProperty('SandboxReplayInput');
    expect(openApiComponentSchemas).toHaveProperty('ListSandboxReplaysQuery');
    expect(openApiComponentSchemas).toHaveProperty('ErrorResponse');
    expect(openApiComponentSchemas).toHaveProperty('CreateExportInput');
    expect(openApiComponentSchemas).toHaveProperty('ExportIdParams');
    expect(openApiComponentSchemas).toHaveProperty('ListExportsQuery');
    expect(openApiComponentSchemas).toHaveProperty('DownloadExportQuery');
    expect(openApiComponentSchemas).toHaveProperty('AnalyzeSimulationInput');
    expect(openApiComponentSchemas).toHaveProperty('SimulationIdParams');
    expect(openApiComponentSchemas).toHaveProperty('ListSimulationsQuery');

    // Verify schemas are valid JSON Schema objects (type set to 'object')
    const createWallet = openApiComponentSchemas.CreateWalletInput as any;
    expect(createWallet.type).toBe('object');

    const errorResp = openApiComponentSchemas.ErrorResponse as any;
    expect(errorResp.type).toBe('object');
    expect(errorResp.properties).toHaveProperty('error');
  });

  it('OpenAPI component schemas are embedded in the spec under components.schemas', async () => {
    const app = Fastify();
    await app.register(swagger, openApiOptions);
    await app.register(swaggerUi, { routePrefix: '/docs' });
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/docs/json' });
    const spec = JSON.parse(response.body);

    expect(spec.components?.schemas).toHaveProperty('CreateWalletInput');
    expect(spec.components?.schemas).toHaveProperty('ErrorResponse');
    expect(spec.components?.schemas).toHaveProperty('RequestLinkInput');

    await app.close();
  });
});
