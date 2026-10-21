import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      // Resolve the shared workspace package directly from its TypeScript source
      // so tests work without needing to pre-build `packages/shared/dist/`.
      '@stellar-alerts/shared': path.resolve(__dirname, '../../packages/shared/src/index.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: process.env.VITEST_INCLUDE
      ? [process.env.VITEST_INCLUDE]
      : (process.env.npm_lifecycle_event === 'test:integration'
          ? ['src/**/*.integration.test.ts']
          : (process.env.npm_lifecycle_event === 'test:unit'
              ? ['src/**/*.test.ts']
              : [
                  'src/utils/__tests__/jwt.test.ts',
                  'src/utils/__tests__/webhook-signer.test.ts',
                  'src/modules/auth/__tests__/auth.service.test.ts',
                ])),
    // Safe dummy values so suites that import modules which validate env at
    // import time (e.g. config/env.ts via lib/prisma) don't process.exit(1).
    env: {
      DATABASE_URL: 'postgresql://user:password@localhost:5432/stellar_alerts?schema=public',
      TELEGRAM_BOT_TOKEN: 'test-telegram-token',
      JWT_SECRET: 'test-jwt-secret',
      REDIS_URL: 'redis://localhost:6379',
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'json-summary', 'html', 'lcov'],
      reportsDirectory: './coverage',
      reportOnFailure: true,
      all: true,
      clean: true,
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/**/*.spec.ts',
        'src/**/*.d.ts',
        'src/**/__tests__/**',
        'src/server.ts',
        'src/mocks/**',
        'src/workers/**',
        'generated/**',
        'prisma/**',
      ],
      thresholds: {
        lines: 85,
        functions: 85,
        branches: 80,
        statements: 85,
      },
    },
  },
});
