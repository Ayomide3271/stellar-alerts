import { describe, it, expect, vi } from 'vitest';
import {
  ReentrancySentinel,
  SorobanInvocationNode,
} from '../reentrancy-sentinel';
import {
  ExploitDetectorRuleEvaluator,
} from '../../../modules/alerts/rules/exploit-detector.rule';

describe('ReentrancySentinel & Exploit Detector (#743)', () => {
  it('should verify benign single-call invocations produce zero false positive alerts', () => {
    const sentinel = new ReentrancySentinel({ maxDepth: 8 });

    const benignCallTree: SorobanInvocationNode = {
      contractId: 'CAAAA111111111111111111111111111111111111111111111111111',
      functionName: 'transfer',
      args: ['GDESTINATION', '100.0'],
    };

    const result = sentinel.analyzeCallTree(benignCallTree);

    expect(result.threatDetected).toBe(false);
    expect(result.hasReentrancy).toBe(false);
    expect(result.hasExcessiveDepth).toBe(false);
    expect(result.severity).toBe('NONE');
    expect(result.maxDepthReached).toBe(1);
    expect(result.detectedCycles).toHaveLength(0);
  });

  it('should verify normal non-cyclic multi-hop contract calls do not trigger alerts', () => {
    const sentinel = new ReentrancySentinel({ maxDepth: 8 });

    const normalMultiHop: SorobanInvocationNode = {
      contractId: 'C_ROUTER',
      functionName: 'swap_exact_tokens',
      subInvocations: [
        {
          contractId: 'C_POOL_A',
          functionName: 'swap',
          subInvocations: [
            {
              contractId: 'C_TOKEN_X',
              functionName: 'transfer',
            },
          ],
        },
      ],
    };

    const result = sentinel.analyzeCallTree(normalMultiHop);

    expect(result.threatDetected).toBe(false);
    expect(result.hasReentrancy).toBe(false);
    expect(result.maxDepthReached).toBe(3);
  });

  it('should detect circular call patterns in simulated XDR call graphs (A -> B -> A)', () => {
    const sentinel = new ReentrancySentinel({ maxDepth: 8 });

    const cyclicGraph = {
      contractId: 'C_LENDING_POOL',
      functionName: 'flash_loan',
      subInvocations: [
        {
          contractId: 'C_ATTACKER_CONTRACT',
          functionName: 'on_flash_loan',
          subInvocations: [
            {
              contractId: 'C_LENDING_POOL',
              functionName: 'withdraw', // Re-entering lending pool within same transaction!
            },
          ],
        },
      ],
    };

    const nodes = sentinel.parseInvocationGraph(cyclicGraph);
    const result = sentinel.analyzeCallTree(nodes);

    expect(result.threatDetected).toBe(true);
    expect(result.hasReentrancy).toBe(true);
    expect(result.severity).toBe('CRITICAL');
    expect(result.detectedCycles.length).toBeGreaterThanOrEqual(1);
    expect(result.detectedCycles[0].cyclePath).toEqual([
      'C_LENDING_POOL',
      'C_ATTACKER_CONTRACT',
      'C_LENDING_POOL',
    ]);
    expect(result.reason).toContain('Circular re-entry detected');
  });

  it('should flag call depth exceeding configurable maximum recursion limit', () => {
    const sentinel = new ReentrancySentinel({ maxDepth: 5 });

    // Build a 7-level deep linear call tree
    let current: SorobanInvocationNode = {
      contractId: 'C_LEVEL_7',
      functionName: 'execute',
    };

    for (let i = 6; i >= 1; i--) {
      current = {
        contractId: `C_LEVEL_${i}`,
        functionName: 'forward',
        subInvocations: [current],
      };
    }

    const result = sentinel.analyzeCallTree(current, { maxDepth: 5 });

    expect(result.threatDetected).toBe(true);
    expect(result.hasExcessiveDepth).toBe(true);
    expect(result.maxDepthReached).toBe(7);
    expect(result.severity).toBe('HIGH');
    expect(result.reason).toContain('Excessive call depth 7 exceeded maximum threshold of 5');
  });

  it('should dispatch emergency alert with involved contract addresses and call trace', async () => {
    const dispatcher = vi.fn();
    const sentinel = new ReentrancySentinel({
      maxDepth: 8,
      alertDispatcher: dispatcher,
    });

    const exploitTree: SorobanInvocationNode = {
      contractId: 'C_VAULT',
      functionName: 'deposit',
      subInvocations: [
        {
          contractId: 'C_TOKEN',
          functionName: 'transfer',
          subInvocations: [
            {
              contractId: 'C_VAULT',
              functionName: 'deposit', // Re-entry
            },
          ],
        },
      ],
    };

    const alert = await sentinel.inspectAndDispatch(exploitTree, {
      txHash: 'tx_abc123',
      ledger: 104523,
    });

    expect(alert).not.toBeNull();
    expect(alert?.event).toBe('soroban.reentrancy_exploit_detected');
    expect(alert?.severity).toBe('CRITICAL');
    expect(alert?.contractId).toBe('C_VAULT');
    expect(alert?.involvedContracts).toContain('C_VAULT');
    expect(alert?.involvedContracts).toContain('C_TOKEN');
    expect(alert?.txHash).toBe('tx_abc123');
    expect(alert?.ledger).toBe(104523);
    expect(dispatcher).toHaveBeenCalledTimes(1);
  });

  it('should evaluate AlertRule via ExploitDetectorRuleEvaluator', () => {
    const evaluator = new ExploitDetectorRuleEvaluator();

    const rule = {
      id: 'rule_123',
      userId: 'user_456',
      isActive: true,
      conditions: {
        exploitDetector: {
          maxDepth: 4,
          alertOnReentrancy: true,
        },
      },
    };

    const benignCall: SorobanInvocationNode = {
      contractId: 'C_TOKEN',
      functionName: 'balance',
    };
    expect(evaluator.evaluate(benignCall, rule).matched).toBe(false);

    const exploitCall: SorobanInvocationNode = {
      contractId: 'C_TARGET',
      functionName: 'call',
      subInvocations: [
        {
          contractId: 'C_INTERMEDIARY',
          subInvocations: [
            {
              contractId: 'C_TARGET',
              functionName: 'reenter',
            },
          ],
        },
      ],
    };

    const matchResult = evaluator.evaluate(exploitCall, rule);
    expect(matchResult.matched).toBe(true);
    expect(matchResult.deliveryPayload?.ruleId).toBe('rule_123');
    expect(matchResult.deliveryPayload?.alert.cyclePaths.length).toBeGreaterThan(0);
  });
});
