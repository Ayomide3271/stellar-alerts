import { prisma } from '../lib/prisma';
import { stellar } from '../lib/stellar';
import { enqueuePaymentAlert } from '../lib/queue';

export async function processPaymentRecord(
  wallet: { id: string; publicKey: string },
  record: any
) {
  let amount: string | undefined;
  let asset: string = 'XLM';
  let fromAddress: string = '';
  const txHash: string = record.transaction_hash;
  const receivedAt: Date = new Date(record.created_at || Date.now());

  if (record.type === 'payment') {
    amount = record.amount;
    asset = record.asset_type === 'native' ? 'XLM' : record.asset_code || 'Unknown';
    fromAddress = record.from || '';
  } else if (record.type === 'create_account') {
    amount = record.starting_balance;
    asset = 'XLM';
    fromAddress = record.funder || '';
  }

  if (!amount || !txHash) return;

  // Deduplicate check
  const existing = await prisma.payment.findUnique({ where: { txHash } });
  if (!existing) {
    console.log(
      `[WatcherWorker] 💰 New ${record.type} detected for wallet (${wallet.publicKey.substring(
        0,
        8
      )}...): ${amount} ${asset}`
    );

    const payment = await prisma.payment.create({
      data: {
        walletId: wallet.id,
        txHash,
        fromAddress,
        amount: Number(amount),
        asset,
        receivedAt,
      },
    });

    // Enqueue off-chain alert dispatch job to BullMQ queue
    await enqueuePaymentAlert({
      paymentId: payment.id,
      txHash,
      walletId: wallet.id,
      amount,
      asset,
      fromAddress,
      receivedAt: receivedAt.toISOString(),
    });
  }
}

export async function processWalletPayments(wallet: { id: string; publicKey: string }) {
  if (!wallet.publicKey || wallet.publicKey.length !== 56 || !wallet.publicKey.startsWith('G')) {
    console.warn(`[WatcherWorker] Skipping invalid public key format: "${wallet.publicKey}"`);
    return;
  }

  const records = await stellar.getRecentPayments(wallet.publicKey, 10);
  for (const record of records as any[]) {
    await processPaymentRecord(wallet, record);
  }
}

export async function startHorizonSSEStream(wallet: { id: string; publicKey: string }) {
  console.log(`[WatcherWorker] 📡 Opening Horizon SSE payment stream for wallet ${wallet.publicKey.substring(0, 8)}...`);
  
  try {
    const closeStream = stellar.server
      .payments()
      .forAccount(wallet.publicKey)
      .cursor('now')
      .stream({
        onmessage: async (record: any) => {
          console.log(`[WatcherStream] ⚡ Live SSE stream message received: ${record.type}`);
          await processPaymentRecord(wallet, record);
        },
        onerror: (error: any) => {
          console.error(`[WatcherStream] SSE stream error for ${wallet.publicKey.substring(0, 8)}...:`, error);
        },
      });

    return closeStream;
  } catch (err: any) {
    console.error(`[WatcherStream] Failed to open SSE stream: ${err.message}`);
    return null;
  }
}

export async function runWatcher() {
  console.log('[WatcherWorker] 🚀 Starting Stellar Testnet Watcher Worker...');

  const poll = async () => {
    try {
      const wallets = await prisma.wallet.findMany();
      if (wallets.length === 0) {
        console.log('[WatcherWorker] No wallets registered in DB to watch. Waiting for next poll...');
        return;
      }

      console.log(`[WatcherWorker] Checking ${wallets.length} registered wallet(s)...`);
      for (const wallet of wallets) {
        await processWalletPayments(wallet);
      }
    } catch (error) {
      console.error('[WatcherWorker] Polling error:', error);
    }
  };

  // Initial payment catchup run
  await poll();

  // Schedule periodic catchup poll every 30 seconds
  setInterval(poll, 30000);
}

if (require.main === module) {
  runWatcher();
}
