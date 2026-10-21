/**
 * contract-router.ts
 *
 * Multi-contract subscription router for Soroban WASM events.
 *
 * Contract IDs are registered dynamically (up to {@link MAX_ROUTER_CONTRACTS}
 * at once) together with an optional event topic. A single polling loop
 * fetches events for *all* registered contracts in batched RPC calls and
 * dispatches each event to the handlers whose contract and topic match.
 *
 * Alert channels (webhook, telegram, ...) register once via
 * {@link ContractRouter.registerChannel}; {@link ContractRouter.dispatchToChannels}
 * fans a routed event out to every channel.
 */
import { fetchEventsForContracts, getEventTopicName } from './soroban';

export type ContractEventHandler = (event: any) => Promise<void>;

/** Topic value meaning "every topic of this contract". */
export const ANY_TOPIC = '*';

/** Upper bound on simultaneously registered contract IDs (matches MAX_ACTIVE_CONTRACTS in soroban.ts). */
export const MAX_ROUTER_CONTRACTS = 100;

export class ContractLimitError extends Error {
  constructor(contractId: string) {
    super(
      `Cannot register contract ${contractId}: router already tracks ${MAX_ROUTER_CONTRACTS} contracts`,
    );
    this.name = 'ContractLimitError';
  }
}

/** An event matched to a set of subscribed users, ready for channel delivery. */
export interface RoutedSorobanAlert {
  contractId: string;
  topic: string;
  userIds: string[];
  event: any;
}

export type AlertChannelHandler = (alert: RoutedSorobanAlert) => Promise<void> | void;

interface Subscription {
  topic: string;
  handler: ContractEventHandler;
}

/** Normalises the RPC `contractId`, which the SDK may surface as a Contract object. */
function eventContractId(event: any): string {
  const id = event?.contractId;
  return id === undefined || id === null ? '' : String(id);
}

export class ContractRouter {
  /** Map of contractId → registered (topic, handler) pairs */
  private subscriptions = new Map<string, Subscription[]>();

  /** Named alert channels that routed events are fanned out to */
  private channels = new Map<string, AlertChannelHandler>();

  /** Shared polling timer for all contracts */
  private pollTimer: NodeJS.Timeout | null = null;

  /** Next start ledger per contract so repeated polls skip already-seen events. */
  private latestLedger = new Map<string, number>();

  // ---------------------------------------------------------------------------
  // Subscription management
  // ---------------------------------------------------------------------------

  /**
   * Subscribe a handler to events from a contract, optionally restricted to a
   * single event topic (default: every topic). Multiple handlers can be
   * registered per contract.
   *
   * @throws ContractLimitError when registering a new contract would exceed
   *         {@link MAX_ROUTER_CONTRACTS} distinct contracts.
   */
  subscribe(contractId: string, handler: ContractEventHandler, topic: string = ANY_TOPIC): void {
    const existing = this.subscriptions.get(contractId);
    if (!existing && this.subscriptions.size >= MAX_ROUTER_CONTRACTS) {
      throw new ContractLimitError(contractId);
    }
    const list = existing ?? [];
    list.push({ topic, handler });
    this.subscriptions.set(contractId, list);
  }

  /**
   * Unsubscribe all handlers for a contract.
   */
  unsubscribe(contractId: string): void {
    this.subscriptions.delete(contractId);
    this.latestLedger.delete(contractId);
  }

  /** Registers (or replaces) a named alert channel. */
  registerChannel(name: string, handler: AlertChannelHandler): void {
    this.channels.set(name, handler);
  }

  unregisterChannel(name: string): void {
    this.channels.delete(name);
  }

  // ---------------------------------------------------------------------------
  // Dispatch
  // ---------------------------------------------------------------------------

  /**
   * Dispatches one event to every handler registered for its contract whose
   * topic matches (exact topic or the wildcard). Handler errors are isolated.
   *
   * @returns The number of handlers that processed the event successfully.
   */
  async dispatchEvent(event: any): Promise<number> {
    const contractId = eventContractId(event);
    const subs = this.subscriptions.get(contractId);
    if (!subs || subs.length === 0) return 0;

    const topic = getEventTopicName(event);
    let dispatched = 0;

    for (const sub of subs) {
      if (sub.topic !== ANY_TOPIC && sub.topic !== topic) continue;
      try {
        await sub.handler(event);
        dispatched++;
      } catch (err: any) {
        console.error(
          `[ContractRouter] Handler error for contract ${contractId}:`,
          err?.message ?? err,
        );
      }
    }

    return dispatched;
  }

  /**
   * Delivers a routed alert to every registered channel. A failing channel
   * never blocks the others.
   *
   * @returns The number of channels that accepted the alert.
   */
  async dispatchToChannels(alert: RoutedSorobanAlert): Promise<number> {
    let delivered = 0;
    for (const [name, channel] of this.channels) {
      try {
        await channel(alert);
        delivered++;
      } catch (err: any) {
        console.error(
          `[ContractRouter] Channel "${name}" failed for contract ${alert.contractId}:`,
          err?.message ?? err,
        );
      }
    }
    return delivered;
  }

  // ---------------------------------------------------------------------------
  // Polling
  // ---------------------------------------------------------------------------

  /**
   * Fetches events for every registered contract in batched RPC calls and
   * dispatches them. Each contract advances its own cursor, so a contract
   * registered later starts at `startLedger` without replaying others.
   *
   * @returns The number of handler invocations that succeeded.
   */
  async pollOnce(startLedger: number): Promise<number> {
    const contractIds = Array.from(this.subscriptions.keys());
    if (contractIds.length === 0) return 0;

    // Contracts share a request, so query from the oldest cursor and drop
    // events a contract has already processed.
    const cursors = new Map<string, number>();
    for (const id of contractIds) {
      cursors.set(id, this.latestLedger.get(id) ?? startLedger);
    }
    const fromLedger = Math.min(...cursors.values());

    let dispatched = 0;
    try {
      const events = await fetchEventsForContracts(contractIds, fromLedger);

      for (const event of events) {
        const contractId = eventContractId(event);
        const cursor = cursors.get(contractId);
        if (cursor === undefined) continue;

        const eventLedger = Number(event?.ledger ?? event?.ledgerSequence ?? 0);
        if (eventLedger > 0 && eventLedger < cursor) continue;
        if (eventLedger > 0) {
          const next = Math.max(this.latestLedger.get(contractId) ?? cursor, eventLedger + 1);
          this.latestLedger.set(contractId, next);
        }

        dispatched += await this.dispatchEvent(event);
      }
    } catch (err: any) {
      console.error('[ContractRouter] Failed to poll contracts:', err?.message ?? err);
    }

    return dispatched;
  }

  /**
   * Start one polling loop covering all currently and subsequently
   * registered contracts.
   *
   * @param startLedger    - The first ledger to query on the initial poll.
   * @param pollIntervalMs - How often to poll in milliseconds (default 10 s).
   */
  async startPolling(startLedger: number, pollIntervalMs = 10_000): Promise<void> {
    if (this.pollTimer) return;

    await this.pollOnce(startLedger);
    this.pollTimer = setInterval(() => {
      void this.pollOnce(startLedger);
    }, pollIntervalMs);
  }

  /**
   * Stop the polling loop.
   */
  stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Introspection helpers
  // ---------------------------------------------------------------------------

  /** Returns the registered contract IDs. */
  getContractIds(): string[] {
    return Array.from(this.subscriptions.keys());
  }

  /** Returns the number of distinct registered contracts. */
  get size(): number {
    return this.subscriptions.size;
  }

  /** Returns true if there is at least one handler registered for the given contract. */
  hasSubscription(contractId: string): boolean {
    return (this.subscriptions.get(contractId)?.length ?? 0) > 0;
  }
}

/** Singleton router instance – import this in workers and route handlers. */
export const contractRouter = new ContractRouter();
