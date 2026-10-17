/**
 * contract-router.ts
 *
 * Routes Soroban WASM contract events to registered handlers.
 * Multiple handlers can be registered per contract ID; each incoming event
 * is dispatched to all of them in registration order.
 */
import { fetchContractEvents, parseSorobanTransferEvent } from './soroban';

export type ContractEventHandler = (event: any) => Promise<void>;

export class ContractRouter {
  /** Map of contractId → list of registered handlers */
  private subscriptions = new Map<string, ContractEventHandler[]>();

  /** Map of contractId → active polling interval handle */
  private pollingIntervals = new Map<string, NodeJS.Timeout>();

  /**
   * The last ledger seen per contract so that repeated polls advance
   * the start ledger and avoid re-processing old events.
   */
  private latestLedger = new Map<string, number>();

  // ---------------------------------------------------------------------------
  // Subscription management
  // ---------------------------------------------------------------------------

  /**
   * Subscribe a handler to events from a specific contract ID.
   * Multiple handlers can be registered per contract.
   */
  subscribe(contractId: string, handler: ContractEventHandler): void {
    const handlers = this.subscriptions.get(contractId) ?? [];
    handlers.push(handler);
    this.subscriptions.set(contractId, handlers);
  }

  /**
   * Unsubscribe all handlers for a contract and clear its polling interval.
   */
  unsubscribe(contractId: string): void {
    this.subscriptions.delete(contractId);
    this.latestLedger.delete(contractId);
    const interval = this.pollingIntervals.get(contractId);
    if (interval !== undefined) {
      clearInterval(interval);
      this.pollingIntervals.delete(contractId);
    }
  }

  // ---------------------------------------------------------------------------
  // Polling
  // ---------------------------------------------------------------------------

  /**
   * Start polling for events from all currently subscribed contracts.
   *
   * @param startLedger    - The first ledger to query on the initial poll.
   * @param pollIntervalMs - How often to poll in milliseconds (default 10 s).
   */
  async startPolling(startLedger: number, pollIntervalMs = 10_000): Promise<void> {
    for (const contractId of this.subscriptions.keys()) {
      if (this.pollingIntervals.has(contractId)) {
        // Already polling – skip.
        continue;
      }

      // Seed the latest-ledger tracker for this contract.
      if (!this.latestLedger.has(contractId)) {
        this.latestLedger.set(contractId, startLedger);
      }

      // Run an initial poll immediately, then schedule recurring polls.
      await this.processContractEvents(contractId, this.latestLedger.get(contractId)!);

      const interval = setInterval(async () => {
        await this.processContractEvents(
          contractId,
          this.latestLedger.get(contractId) ?? startLedger
        );
      }, pollIntervalMs);

      this.pollingIntervals.set(contractId, interval);
    }
  }

  /**
   * Stop all active polling intervals.
   */
  stopPolling(): void {
    for (const [contractId, interval] of this.pollingIntervals.entries()) {
      clearInterval(interval);
      this.pollingIntervals.delete(contractId);
    }
  }

  // ---------------------------------------------------------------------------
  // Event processing
  // ---------------------------------------------------------------------------

  /**
   * Fetch events for a single contract starting at `startLedger`, then
   * dispatch each event to all registered handlers.
   *
   * @returns The number of events successfully dispatched.
   */
  async processContractEvents(contractId: string, startLedger: number): Promise<number> {
    const handlers = this.subscriptions.get(contractId);
    if (!handlers || handlers.length === 0) {
      return 0;
    }

    let dispatched = 0;

    try {
      const events = await fetchContractEvents(contractId, startLedger);

      for (const event of events) {
        // Advance the latest-ledger cursor so the next poll does not
        // re-process already-seen events.
        const eventLedger: number = Number(event?.ledger ?? event?.ledgerSequence ?? 0);
        if (eventLedger > 0) {
          const current = this.latestLedger.get(contractId) ?? startLedger;
          if (eventLedger >= current) {
            this.latestLedger.set(contractId, eventLedger + 1);
          }
        }

        // Dispatch to every registered handler; errors are isolated per handler.
        for (const handler of handlers) {
          try {
            await handler(event);
            dispatched++;
          } catch (err: any) {
            console.error(
              `[ContractRouter] Handler error for contract ${contractId}:`,
              err?.message ?? err
            );
          }
        }
      }
    } catch (err: any) {
      console.error(
        `[ContractRouter] Failed to fetch events for contract ${contractId}:`,
        err?.message ?? err
      );
    }

    return dispatched;
  }

  // ---------------------------------------------------------------------------
  // Introspection helpers
  // ---------------------------------------------------------------------------

  /** Returns a read-only snapshot of active subscriptions keyed by contractId. */
  getSubscriptions(): ReadonlyMap<string, ContractEventHandler[]> {
    return this.subscriptions;
  }

  /** Returns true if there is at least one handler registered for the given contract. */
  hasSubscription(contractId: string): boolean {
    return (this.subscriptions.get(contractId)?.length ?? 0) > 0;
  }
}

/** Singleton router instance – import this in workers and route handlers. */
export const contractRouter = new ContractRouter();
