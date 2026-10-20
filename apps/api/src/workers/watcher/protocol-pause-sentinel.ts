const logger = {
  info: (data: Record<string, unknown>, msg: string) => console.log(`[ProtocolPauseSentinel] ${msg}`, data),
  warn: (data: Record<string, unknown>, msg: string) => console.warn(`[ProtocolPauseSentinel] ${msg}`, data),
  error: (data: Record<string, unknown>, msg: string) => console.error(`[ProtocolPauseSentinel] ${msg}`, data),
};

export type PauseActionType =
  | 'PAUSE'
  | 'UNPAUSE'
  | 'FREEZE'
  | 'HALT'
  | 'EMERGENCY_SHUTDOWN';

export interface ProtocolInvocationRecord {
  contractId: string;
  functionName: string;
  callerAddress?: string;
  args?: unknown[];
  txHash?: string;
  ledger?: number;
  events?: Array<{
    topics: string[];
    data?: unknown;
  }>;
}

export interface ProtocolPauseAlertPayload {
  event: 'soroban.protocol_pause_transition';
  contractId: string;
  action: PauseActionType;
  isPaused: boolean;
  callerAddress?: string;
  functionName: string;
  parameters: Record<string, unknown>;
  txHash?: string;
  ledger?: number;
  severity: 'EMERGENCY' | 'CRITICAL' | 'HIGH';
  message: string;
  timestamp: number;
}

export interface ProtocolPauseSentinelOptions {
  monitoredContracts?: string[];
  alertDispatcher?: (alert: ProtocolPauseAlertPayload) => Promise<void> | void;
}

const PAUSE_PATTERNS = new Set([
  'pause',
  'set_pause',
  'set_paused',
  'freeze',
  'halt',
  'emergency_pause',
  'emergency_stop',
  'circuit_breaker',
  'emergency_freeze',
  'stop',
]);

const UNPAUSE_PATTERNS = new Set([
  'unpause',
  'resume',
  'unfreeze',
  'set_unpaused',
  'unhalt',
  'start',
]);

export class ProtocolPauseSentinel {
  private monitoredContracts = new Set<string>();
  private alertDispatcher?: (alert: ProtocolPauseAlertPayload) => Promise<void> | void;

  constructor(options: ProtocolPauseSentinelOptions = {}) {
    if (options.monitoredContracts) {
      for (const id of options.monitoredContracts) {
        this.monitoredContracts.add(id.toLowerCase());
      }
    }
    this.alertDispatcher = options.alertDispatcher;
  }

  public registerMonitoredContract(contractId: string): void {
    this.monitoredContracts.add(contractId.toLowerCase());
  }

  public unregisterMonitoredContract(contractId: string): void {
    this.monitoredContracts.delete(contractId.toLowerCase());
  }

  public isContractMonitored(contractId: string): boolean {
    if (this.monitoredContracts.size === 0) return true; // Default: monitor all if none specified
    return this.monitoredContracts.has(contractId.toLowerCase());
  }

  /**
   * Scans a contract invocation for circuit breaker / pause state transition signatures.
   */
  public inspectInvocation(record: ProtocolInvocationRecord): ProtocolPauseAlertPayload | null {
    if (!record || !record.contractId || !record.functionName) {
      return null;
    }

    if (!this.isContractMonitored(record.contractId)) {
      return null;
    }

    const normalizedFunc = record.functionName.trim().toLowerCase();
    const isPause = PAUSE_PATTERNS.has(normalizedFunc);
    const isUnpause = UNPAUSE_PATTERNS.has(normalizedFunc);

    if (!isPause && !isUnpause) {
      return null;
    }

    let action: PauseActionType = 'PAUSE';
    let isPaused = true;
    let severity: 'EMERGENCY' | 'CRITICAL' | 'HIGH' = 'CRITICAL';

    if (normalizedFunc.includes('freeze')) {
      action = 'FREEZE';
      isPaused = true;
      severity = 'EMERGENCY';
    } else if (normalizedFunc.includes('halt')) {
      action = 'HALT';
      isPaused = true;
      severity = 'EMERGENCY';
    } else if (normalizedFunc.includes('emergency')) {
      action = 'EMERGENCY_SHUTDOWN';
      isPaused = true;
      severity = 'EMERGENCY';
    } else if (isUnpause) {
      action = 'UNPAUSE';
      isPaused = false;
      severity = 'HIGH';
    } else {
      action = 'PAUSE';
      isPaused = true;
      severity = 'CRITICAL';
    }

    const callerAddress = this.extractAdminCaller(record);
    const parameters = this.extractParameters(record);

    const message = isPaused
      ? `Protocol circuit breaker activated on contract ${record.contractId} (${action}) by ${callerAddress ?? 'Unknown admin'}`
      : `Protocol circuit breaker deactivated on contract ${record.contractId} (${action}) by ${callerAddress ?? 'Unknown admin'}`;

    logger.warn(
      { contractId: record.contractId, action, functionName: record.functionName, callerAddress },
      `[ProtocolPauseSentinel] ⚠️ ${message}`
    );

    return {
      event: 'soroban.protocol_pause_transition',
      contractId: record.contractId,
      action,
      isPaused,
      callerAddress,
      functionName: record.functionName,
      parameters,
      txHash: record.txHash,
      ledger: record.ledger,
      severity,
      message,
      timestamp: Date.now(),
    };
  }

  /**
   * Helper to parse simulated transaction envelope or operation record into ProtocolInvocationRecord
   */
  public parseTransactionRecord(rawRecord: unknown): ProtocolInvocationRecord | null {
    if (!rawRecord || typeof rawRecord !== 'object') return null;

    const record = rawRecord as Record<string, unknown>;

    const contractId =
      (typeof record.contractId === 'string' && record.contractId) ||
      (typeof record.contract_id === 'string' && record.contract_id) ||
      (typeof record.address === 'string' && record.address) ||
      '';

    const functionName =
      (typeof record.functionName === 'string' && record.functionName) ||
      (typeof record.function === 'string' && record.function) ||
      (typeof record.method === 'string' && record.method) ||
      '';

    if (!contractId || !functionName) return null;

    const callerAddress =
      (typeof record.callerAddress === 'string' && record.callerAddress) ||
      (typeof record.caller === 'string' && record.caller) ||
      (typeof record.from === 'string' && record.from) ||
      (typeof record.invoker === 'string' && record.invoker) ||
      (typeof record.sourceAccount === 'string' && record.sourceAccount) ||
      undefined;

    const args = Array.isArray(record.args) ? record.args : undefined;
    const txHash = typeof record.txHash === 'string' ? record.txHash : (typeof record.hash === 'string' ? record.hash : undefined);
    const ledger = typeof record.ledger === 'number' ? record.ledger : (typeof record.ledgerSeq === 'number' ? record.ledgerSeq : undefined);

    let events: Array<{ topics: string[]; data?: unknown }> | undefined;
    if (Array.isArray(record.events)) {
      events = record.events
        .map((ev) => {
          if (ev && typeof ev === 'object' && 'topics' in ev && Array.isArray((ev as Record<string, unknown>).topics)) {
            const evRecord = ev as Record<string, unknown>;
            return {
              topics: evRecord.topics as string[],
              data: evRecord.data,
            };
          }
          return null;
        })
        .filter((ev): ev is { topics: string[]; data?: unknown } => ev !== null);
    }

    return {
      contractId,
      functionName,
      callerAddress,
      args,
      txHash,
      ledger,
      events,
    };
  }

  /**
   * Scans an incoming transaction/invocation, checks for pause signatures, and dispatches alerts.
   */
  public async inspectAndDispatch(
    rawRecord: unknown,
    context: { txHash?: string; ledger?: number } = {}
  ): Promise<ProtocolPauseAlertPayload | null> {
    const invocation =
      rawRecord && typeof rawRecord === 'object' && 'contractId' in rawRecord && 'functionName' in rawRecord
        ? (rawRecord as ProtocolInvocationRecord)
        : this.parseTransactionRecord(rawRecord);

    if (!invocation) return null;

    if (context.txHash && !invocation.txHash) invocation.txHash = context.txHash;
    if (context.ledger && !invocation.ledger) invocation.ledger = context.ledger;

    const alert = this.inspectInvocation(invocation);
    if (!alert) return null;

    if (this.alertDispatcher) {
      try {
        await this.alertDispatcher(alert);
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.error({ err: errMsg }, '[ProtocolPauseSentinel] Failed to dispatch alert');
      }
    }

    return alert;
  }

  private extractAdminCaller(record: ProtocolInvocationRecord): string | undefined {
    if (record.callerAddress) return record.callerAddress;

    // Check args for admin address (starts with G for Stellar public key or C for contract)
    if (record.args && record.args.length > 0) {
      for (const arg of record.args) {
        if (typeof arg === 'string' && (arg.startsWith('G') || arg.startsWith('C')) && arg.length >= 56) {
          return arg;
        }
      }
    }

    return undefined;
  }

  private extractParameters(record: ProtocolInvocationRecord): Record<string, unknown> {
    const params: Record<string, unknown> = {};

    if (record.args) {
      params.args = record.args;
    }

    if (record.events && record.events.length > 0) {
      params.emittedEvents = record.events;
    }

    return params;
  }
}

export const protocolPauseSentinel = new ProtocolPauseSentinel();
