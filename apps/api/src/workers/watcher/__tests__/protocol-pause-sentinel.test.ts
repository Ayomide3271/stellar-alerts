import { describe, it, expect, vi } from 'vitest';
import {
  ProtocolPauseSentinel,
  ProtocolInvocationRecord,
} from '../protocol-pause-sentinel';
import {
  ProtocolPauseRuleEvaluator,
} from '../../../modules/alerts/rules/protocol-pause.rule';

describe('ProtocolPauseSentinel & Circuit Breaker State Transition Monitor (#749)', () => {
  it('should ignore regular non-pause smart contract invocations', () => {
    const sentinel = new ProtocolPauseSentinel();

    const normalInvocation: ProtocolInvocationRecord = {
      contractId: 'C_LENDING_DEFI',
      functionName: 'deposit',
      args: ['GADMIN123', '500.0'],
    };

    const alert = sentinel.inspectInvocation(normalInvocation);
    expect(alert).toBeNull();
  });

  it('should detect pause invocation from contract transaction envelope', () => {
    const sentinel = new ProtocolPauseSentinel();

    const rawEnvelope = {
      contractId: 'C_LENDING_DEFI',
      functionName: 'pause',
      callerAddress: 'GADMIN_PUBKEY_AAAABBBBCCCCDDDD11112222333344445555666677778888',
      args: ['emergency maintenance'],
      txHash: '0x1234567890abcdef',
      ledger: 894102,
    };

    const alert = sentinel.inspectInvocation(sentinel.parseTransactionRecord(rawEnvelope)!);

    expect(alert).not.toBeNull();
    expect(alert?.event).toBe('soroban.protocol_pause_transition');
    expect(alert?.action).toBe('PAUSE');
    expect(alert?.isPaused).toBe(true);
    expect(alert?.contractId).toBe('C_LENDING_DEFI');
    expect(alert?.functionName).toBe('pause');
    expect(alert?.callerAddress).toBe('GADMIN_PUBKEY_AAAABBBBCCCCDDDD11112222333344445555666677778888');
    expect(alert?.txHash).toBe('0x1234567890abcdef');
    expect(alert?.ledger).toBe(894102);
    expect(alert?.severity).toBe('CRITICAL');
    expect(alert?.message).toContain('circuit breaker activated');
  });

  it('should verify alert dispatch when mock protocol triggers emergency freeze', async () => {
    const dispatcher = vi.fn();
    const sentinel = new ProtocolPauseSentinel({
      alertDispatcher: dispatcher,
    });

    const freezeInvocation: ProtocolInvocationRecord = {
      contractId: 'C_DEX_AMM',
      functionName: 'emergency_freeze',
      callerAddress: 'GSECURITY_COUNCIL',
      args: ['suspected exploit in pool'],
      events: [
        {
          topics: ['freeze', 'all_pools'],
          data: { status: 'frozen' },
        },
      ],
      txHash: 'tx_freeze_999',
      ledger: 105822,
    };

    const alert = await sentinel.inspectAndDispatch(freezeInvocation);

    expect(alert).not.toBeNull();
    expect(alert?.action).toBe('FREEZE');
    expect(alert?.isPaused).toBe(true);
    expect(alert?.severity).toBe('EMERGENCY');
    expect(alert?.parameters.emittedEvents).toBeDefined();
    expect(dispatcher).toHaveBeenCalledTimes(1);
    expect(dispatcher).toHaveBeenCalledWith(alert);
  });

  it('should detect unpause / resume actions and update protocol status', () => {
    const sentinel = new ProtocolPauseSentinel();

    const resumeInvocation: ProtocolInvocationRecord = {
      contractId: 'C_LENDING_DEFI',
      functionName: 'unpause',
      callerAddress: 'GADMIN_123',
    };

    const alert = sentinel.inspectInvocation(resumeInvocation);

    expect(alert).not.toBeNull();
    expect(alert?.action).toBe('UNPAUSE');
    expect(alert?.isPaused).toBe(false);
    expect(alert?.severity).toBe('HIGH');
    expect(alert?.message).toContain('circuit breaker deactivated');
  });

  it('should evaluate alert rules matching specific monitored contracts and actions', () => {
    const evaluator = new ProtocolPauseRuleEvaluator();

    const rule = {
      id: 'rule_pause_watcher',
      userId: 'user_analyst_1',
      isActive: true,
      conditions: {
        protocolPause: {
          contractId: 'C_MONITORED_DEFI',
          actions: ['FREEZE', 'EMERGENCY_SHUTDOWN'] as const,
        },
      },
    };

    // Case 1: unmonitored contract -> no match
    const otherContract: ProtocolInvocationRecord = {
      contractId: 'C_OTHER_DEFI',
      functionName: 'freeze',
    };
    expect(evaluator.evaluate(otherContract, rule).matched).toBe(false);

    // Case 2: monitored contract, but action is PAUSE (rule specified only FREEZE / EMERGENCY_SHUTDOWN)
    const pauseAction: ProtocolInvocationRecord = {
      contractId: 'C_MONITORED_DEFI',
      functionName: 'pause',
    };
    expect(evaluator.evaluate(pauseAction, rule).matched).toBe(false);

    // Case 3: monitored contract and FREEZE action -> match!
    const freezeAction: ProtocolInvocationRecord = {
      contractId: 'C_MONITORED_DEFI',
      functionName: 'freeze',
      callerAddress: 'GADMIN',
    };
    const match = evaluator.evaluate(freezeAction, rule);
    expect(match.matched).toBe(true);
    expect(match.deliveryPayload?.ruleId).toBe('rule_pause_watcher');
    expect(match.deliveryPayload?.metadata.action).toBe('FREEZE');
    expect(match.deliveryPayload?.metadata.isPaused).toBe(true);
  });
});
