const logger = {
  info: (data: Record<string, unknown>, msg: string) => console.log(`[ReentrancySentinel] ${msg}`, data),
  warn: (data: Record<string, unknown>, msg: string) => console.warn(`[ReentrancySentinel] ${msg}`, data),
  error: (data: Record<string, unknown>, msg: string) => console.error(`[ReentrancySentinel] ${msg}`, data),
};

export interface SorobanInvocationNode {
  contractId: string;
  functionName?: string;
  subInvocations?: SorobanInvocationNode[];
  args?: unknown[];
}

export interface ReentrancySentinelOptions {
  maxDepth?: number;
  alertDispatcher?: (alert: ReentrancyAlertPayload) => Promise<void> | void;
}

export interface ReentrancyCycle {
  contractId: string;
  cyclePath: string[];
}

export interface ReentrancyAnalysisResult {
  hasReentrancy: boolean;
  hasExcessiveDepth: boolean;
  threatDetected: boolean;
  severity: 'CRITICAL' | 'HIGH' | 'NONE';
  maxDepthReached: number;
  maxConfiguredDepth: number;
  detectedCycles: ReentrancyCycle[];
  involvedContracts: string[];
  callTrace: string[];
  reason?: string;
}

export interface ReentrancyAlertPayload {
  event: 'soroban.reentrancy_exploit_detected';
  severity: 'CRITICAL' | 'HIGH';
  contractId: string;
  involvedContracts: string[];
  callTrace: string[];
  cyclePaths: string[][];
  maxDepthReached: number;
  reason: string;
  txHash?: string;
  ledger?: number;
  timestamp: number;
}

export class ReentrancySentinel {
  private defaultMaxDepth: number;
  private alertDispatcher?: (alert: ReentrancyAlertPayload) => Promise<void> | void;

  constructor(options: ReentrancySentinelOptions = {}) {
    this.defaultMaxDepth = options.maxDepth ?? 8;
    this.alertDispatcher = options.alertDispatcher;
  }

  /**
   * Analyzes Soroban invocation trees for circular contract call dependencies
   * and call depth exceeding the maximum recursion limit.
   */
  public analyzeCallTree(
    root: SorobanInvocationNode | SorobanInvocationNode[],
    options: ReentrancySentinelOptions = {}
  ): ReentrancyAnalysisResult {
    const maxDepthLimit = options.maxDepth ?? this.defaultMaxDepth;
    const roots = Array.isArray(root) ? root : [root];

    let maxDepthReached = 0;
    const detectedCycles: ReentrancyCycle[] = [];
    const involvedContractsSet = new Set<string>();
    const callTrace: string[] = [];

    const traverse = (
      node: SorobanInvocationNode,
      currentDepth: number,
      activeCallStack: string[],
      tracePrefix: string
    ) => {
      if (!node || !node.contractId) return;

      const contractId = node.contractId;
      involvedContractsSet.add(contractId);

      if (currentDepth > maxDepthReached) {
        maxDepthReached = currentDepth;
      }

      const funcName = node.functionName ?? 'invoke';
      const callDescriptor = `${contractId.substring(0, 8)}...::${funcName}()`;
      callTrace.push(`${tracePrefix}[depth ${currentDepth}] ${callDescriptor}`);

      // Check for circular dependency / re-entrancy cycle in active call stack
      const cycleStartIndex = activeCallStack.indexOf(contractId);
      if (cycleStartIndex !== -1) {
        const cyclePath = [...activeCallStack.slice(cycleStartIndex), contractId];
        detectedCycles.push({
          contractId,
          cyclePath,
        });
        logger.warn(
          { contractId, cyclePath, depth: currentDepth },
          `[ReentrancySentinel] 🚨 Circular contract call dependency detected!`
        );
      }

      const nextStack = [...activeCallStack, contractId];

      if (node.subInvocations && node.subInvocations.length > 0) {
        for (const child of node.subInvocations) {
          traverse(child, currentDepth + 1, nextStack, tracePrefix + '  ');
        }
      }
    };

    for (const r of roots) {
      traverse(r, 1, [], '');
    }

    const hasReentrancy = detectedCycles.length > 0;
    const hasExcessiveDepth = maxDepthReached > maxDepthLimit;
    const threatDetected = hasReentrancy || hasExcessiveDepth;

    let severity: 'CRITICAL' | 'HIGH' | 'NONE' = 'NONE';
    let reason: string | undefined;

    if (hasReentrancy && hasExcessiveDepth) {
      severity = 'CRITICAL';
      reason = `Circular re-entry detected (${detectedCycles.length} cycle(s)) and recursion depth ${maxDepthReached} exceeded threshold ${maxDepthLimit}`;
    } else if (hasReentrancy) {
      severity = 'CRITICAL';
      reason = `Circular re-entry detected (${detectedCycles.length} cycle(s)): ${detectedCycles[0].cyclePath.join(' -> ')}`;
    } else if (hasExcessiveDepth) {
      severity = 'HIGH';
      reason = `Excessive call depth ${maxDepthReached} exceeded maximum threshold of ${maxDepthLimit}`;
    }

    return {
      hasReentrancy,
      hasExcessiveDepth,
      threatDetected,
      severity,
      maxDepthReached,
      maxConfiguredDepth: maxDepthLimit,
      detectedCycles,
      involvedContracts: Array.from(involvedContractsSet),
      callTrace,
      reason,
    };
  }

  /**
   * Helper to parse a simulated or serialized XDR invocation graph into a SorobanInvocationNode.
   */
  public parseInvocationGraph(rawGraph: unknown): SorobanInvocationNode[] {
    if (!rawGraph || typeof rawGraph !== 'object') {
      return [];
    }

    if (Array.isArray(rawGraph)) {
      return rawGraph.map((item) => this.parseSingleNode(item)).filter(Boolean) as SorobanInvocationNode[];
    }

    const single = this.parseSingleNode(rawGraph);
    return single ? [single] : [];
  }

  private parseSingleNode(raw: unknown): SorobanInvocationNode | null {
    if (!raw || typeof raw !== 'object') return null;

    const record = raw as Record<string, unknown>;
    const contractId =
      (typeof record.contractId === 'string' && record.contractId) ||
      (typeof record.contract_id === 'string' && record.contract_id) ||
      (typeof record.address === 'string' && record.address) ||
      '';

    if (!contractId) return null;

    const functionName =
      (typeof record.functionName === 'string' && record.functionName) ||
      (typeof record.function === 'string' && record.function) ||
      (typeof record.method === 'string' && record.method) ||
      undefined;

    let subInvocations: SorobanInvocationNode[] | undefined;
    const rawSubs = record.subInvocations ?? record.sub_invocations ?? record.children ?? record.calls;
    if (Array.isArray(rawSubs)) {
      subInvocations = rawSubs
        .map((sub) => this.parseSingleNode(sub))
        .filter((sub): sub is SorobanInvocationNode => sub !== null);
    }

    const args = Array.isArray(record.args) ? record.args : undefined;

    return {
      contractId,
      functionName,
      subInvocations,
      args,
    };
  }

  /**
   * Scans a call tree or simulated invocation graph, and if an exploit pattern is detected,
   * constructs an emergency alert and dispatches it.
   */
  public async inspectAndDispatch(
    invocation: SorobanInvocationNode | SorobanInvocationNode[] | unknown,
    context: { txHash?: string; ledger?: number } = {}
  ): Promise<ReentrancyAlertPayload | null> {
    const nodes =
      typeof invocation === 'object' && invocation !== null && 'contractId' in invocation
        ? (invocation as SorobanInvocationNode)
        : this.parseInvocationGraph(invocation);

    const result = this.analyzeCallTree(nodes);

    if (!result.threatDetected) {
      return null;
    }

    const rootContract = result.involvedContracts[0] ?? 'UNKNOWN_CONTRACT';
    const alert: ReentrancyAlertPayload = {
      event: 'soroban.reentrancy_exploit_detected',
      severity: result.severity === 'CRITICAL' ? 'CRITICAL' : 'HIGH',
      contractId: rootContract,
      involvedContracts: result.involvedContracts,
      callTrace: result.callTrace,
      cyclePaths: result.detectedCycles.map((c) => c.cyclePath),
      maxDepthReached: result.maxDepthReached,
      reason: result.reason ?? 'Exploit pattern detected',
      txHash: context.txHash,
      ledger: context.ledger,
      timestamp: Date.now(),
    };

    if (this.alertDispatcher) {
      try {
        await this.alertDispatcher(alert);
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.error({ err: errMsg }, '[ReentrancySentinel] Failed to dispatch alert');
      }
    }

    return alert;
  }
}

export const reentrancySentinel = new ReentrancySentinel();
