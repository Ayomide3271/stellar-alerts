import { FastifyInstance } from 'fastify';
import { authenticateHook } from '../../middleware/auth.middleware';
import { idempotencyHooks } from '../../middleware/idempotency.middleware';
import { walletsController } from './wallets.controller';
import { exportController } from './export.controller';

export async function walletsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticateHook);

  // Idempotency only guards mutations: a retried read has no side effect to
  // deduplicate, so those routes skip the extra database round trip (#334).
  const idempotent = idempotencyHooks();

  app.post(
    '/wallets',
    { preValidation: idempotent.preValidation, onSend: idempotent.onSend, onResponse: idempotent.onResponse },
    walletsController.addWallet.bind(walletsController)
  );
  app.get('/wallets', walletsController.getWallets.bind(walletsController));
  app.get('/wallets/:id/ingestion-status', walletsController.getIngestionStatus.bind(walletsController));
  app.get('/wallets/:id/export', exportController.exportWallet.bind(exportController));
  app.delete(
    '/wallets/:id',
    { preValidation: idempotent.preValidation, onSend: idempotent.onSend, onResponse: idempotent.onResponse },
    walletsController.deleteWallet.bind(walletsController)
  );

  app.post(
    '/wallets/bulk-import',
    { preValidation: idempotent.preValidation, onSend: idempotent.onSend, onResponse: idempotent.onResponse },
    walletsController.bulkImport.bind(walletsController)
  );
\n}
