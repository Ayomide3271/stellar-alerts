/**
 * Minimal Prometheus scrape endpoint for long-running worker processes.
 *
 * The API serves `/metrics` from `plugins/metrics.ts`, but the webhook
 * dispatcher runs in its own process, so the histograms it records are not
 * visible through the API's listener. This exposes the same text format on a
 * dedicated, opt-in port for worker pods.
 */

import http from 'node:http';
import { renderWebhookDispatchMetrics } from './webhook-metrics';
import { renderQueueLaneMetrics } from './queue-lanes';
import { createLogger } from './logger';

const log = createLogger({ module: 'WorkerMetrics' });

let server: http.Server | undefined;

/**
 * Starts the scrape listener.
 *
 * Returns `undefined` when no port is configured, so telemetry stays entirely
 * opt-in and worker startup is unchanged for anyone who has not set the env var.
 */
export async function startWorkerMetricsServer(port: number | undefined): Promise<http.Server | undefined> {
  // Port 0 is a valid "pick any free port" request, so only an absent port
  // disables the listener.
  if (port === undefined || server) return server;

  server = http.createServer((req, res) => {
    if (req.url !== '/metrics') {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found\n');
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
    res.end(`${renderWebhookDispatchMetrics()}\n${renderQueueLaneMetrics()}\n`);
  });

  await new Promise<void>((resolve, reject) => {
    server?.once('error', reject);
    server?.listen(port, () => resolve());
  });

  log.info({ port }, 'Worker Prometheus metrics endpoint listening');

  return server;
}

export async function stopWorkerMetricsServer(): Promise<void> {
  const current = server;
  if (!current) return;

  server = undefined;
  await new Promise<void>((resolve) => current.close(() => resolve()));
}
