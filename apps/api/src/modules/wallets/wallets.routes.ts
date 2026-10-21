import { FastifyInstance } from 'fastify';
import { authenticateHook } from '../../middleware/auth.middleware';
import { registerIdempotency } from '../../middleware/idempotency.middleware';
import { walletsController } from './wallets.controller';
import { exportController } from './export.controller';

export async function walletsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticateHook);
  await registerIdempotency(app);

  app.post('/wallets', walletsController.addWallet.bind(walletsController));
  app.get('/wallets', walletsController.getWallets.bind(walletsController));
  app.get('/wallets/:id/ingestion-status', walletsController.getIngestionStatus.bind(walletsController));
  app.patch('/wallets/:id/metadata', walletsController.updateWalletMetadata.bind(walletsController));
  app.delete('/wallets/:id', walletsController.deleteWallet.bind(walletsController));
}
