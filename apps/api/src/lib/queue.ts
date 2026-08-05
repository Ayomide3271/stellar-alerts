import { Queue } from 'bullmq';

export interface AlertJobData {
  paymentId: string;
  txHash: string;
  walletId: string;
  amount: string;
  asset: string;
  fromAddress: string;
  receivedAt: string;
}

const redisHost = process.env.REDIS_HOST || 'localhost';
const redisPort = parseInt(process.env.REDIS_PORT || '6379', 10);

export let alertQueue: Queue<AlertJobData> | null = null;

try {
  alertQueue = new Queue<AlertJobData>('payment-alerts', {
    connection: {
      host: redisHost,
      port: redisPort,
      lazyConnect: true,
      maxRetriesPerRequest: 1,
    },
    defaultJobOptions: {
      attempts: 5,
      backoff: {
        type: 'exponential',
        delay: 2000,
      },
      removeOnComplete: 100,
      removeOnFail: 500,
    },
  });
  console.log(`[Queue] 📡 BullMQ payment-alerts queue initialized (${redisHost}:${redisPort})`);
} catch (err: any) {
  console.warn(`[Queue] Could not initialize BullMQ queue: ${err.message}`);
}

export async function enqueuePaymentAlert(data: AlertJobData) {
  if (!alertQueue) {
    console.log(`[Queue] Skipping queue enqueue for payment ${data.txHash} (Queue not connected)`);
    return null;
  }

  try {
    const job = await alertQueue.add('dispatch-alert', data, {
      jobId: `payment-${data.txHash}`,
    });
    console.log(`[Queue] 📨 Enqueued payment alert job: ${job.id}`);
    return job;
  } catch (err: any) {
    console.warn(`[Queue] Failed to enqueue alert for payment ${data.txHash}: ${err.message}`);
    return null;
  }
}
