import { describe, it, expect } from 'vitest';
import { PayloadTransformer } from '../payload-transformer';

describe('PayloadTransformer Dynamic Webhook Transformation Engine (#748)', () => {
  const transformer = new PayloadTransformer();

  const samplePaymentEvent = {
    id: 'pay_987654321',
    event: 'payment.received',
    timestamp: 1729440000000,
    data: {
      transaction: {
        hash: 'tx_fe128ab90',
        ledger: 512399,
      },
      sender: {
        address: 'GSENDER_PUBLIC_KEY_1111222233334444555566667777888899990000',
        name: 'Alpha Corp',
      },
      recipient: {
        address: 'GRECIPIENT_PUBLIC_KEY_AAAABBBBCCCCDDDD111122223333444455556666',
        label: 'Treasury Wallet',
      },
      amount: '1500.50',
      asset: {
        code: 'USDC',
        issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      },
      memo: 'Invoice-4091',
    },
  };

  it('should return original payload when template is empty or null', async () => {
    const resultNull = await transformer.transform(samplePaymentEvent, null);
    expect(resultNull.transformed).toBe(false);
    expect(resultNull.payload).toEqual(samplePaymentEvent);

    const resultEmpty = await transformer.transform(samplePaymentEvent, '');
    expect(resultEmpty.transformed).toBe(false);
    expect(resultEmpty.payload).toEqual(samplePaymentEvent);
  });

  it('should evaluate user-defined Liquid template against nested payment event objects and output validated custom JSON payload', async () => {
    const template = `
    {
      "eventType": "{{ event }}",
      "paymentId": "{{ id }}",
      "details": {
        "tx": "{{ data.transaction.hash }}",
        "sender": "{{ data.sender.name }}",
        "transferredAmount": {{ data.amount }},
        "currency": "{{ data.asset.code | upcase }}",
        "memoText": "{{ data.memo | default: 'N/A' }}"
      }
    }
    `;

    const result = await transformer.transform(samplePaymentEvent, template);

    expect(result.transformed).toBe(true);
    expect(result.payload).toEqual({
      eventType: 'payment.received',
      paymentId: 'pay_987654321',
      details: {
        tx: 'tx_fe128ab90',
        sender: 'Alpha Corp',
        transferredAmount: 1500.5,
        currency: 'USDC',
        memoText: 'Invoice-4091',
      },
    });
  });

  it('should support JsonPath-style accessors in expressions', async () => {
    const template = `
    {
      "txHash": "{{ $.data.transaction.hash }}",
      "amount": "{{ $.data.amount }}"
    }
    `;

    const result = await transformer.transform(samplePaymentEvent, template);

    expect(result.transformed).toBe(true);
    expect(result.payload).toEqual({
      txHash: 'tx_fe128ab90',
      amount: '1500.50',
    });
  });

  it('should safely handle syntax errors or invalid JSON output with fallback to standard schema and error info', async () => {
    // Malformed JSON template
    const invalidJsonTemplate = `
    {
      "unclosedObject": "{{ data.amount }}"
    `;

    const result = await transformer.transform(samplePaymentEvent, invalidJsonTemplate);

    expect(result.transformed).toBe(false);
    expect(result.payload).toEqual(samplePaymentEvent);
    expect(result.error).toBeDefined();
    expect(result.error).toContain('not valid JSON');
  });

  it('should verify rejection of unsafe template tags (preventing prototype pollution or arbitrary execution)', async () => {
    const unsafeTemplates = [
      '{% include "/etc/passwd" %}',
      '{% render "exploit.liquid" %}',
      '{% layout "root" %}',
      '{"polluted": "{{ __proto__.admin }}"}',
      '{"exploit": "{{ constructor.name }}"}',
      '{"prototype": "{{ Object.prototype }}"}',
      '{"process": "{{ process.env }}"}',
    ];

    for (const tpl of unsafeTemplates) {
      const securityCheck = transformer.validateTemplateSecurity(tpl);
      expect(securityCheck.safe).toBe(false);
      expect(securityCheck.reason).toBeDefined();

      const result = await transformer.transform(samplePaymentEvent, tpl);
      // Must reject and fall back safely to standard payload
      expect(result.transformed).toBe(false);
      expect(result.payload).toEqual(samplePaymentEvent);
      expect(result.error).toBeDefined();
    }
  });

  it('should handle filters such as downcase, append, and default safely', async () => {
    const template = `
    {
      "currencyLower": "{{ data.asset.code | downcase }}",
      "decoratedMemo": "{{ data.memo | append: ' - PROCESSED' }}",
      "missingField": "{{ data.nonexistent | default: 'standard_default' }}"
    }
    `;

    const result = await transformer.transform(samplePaymentEvent, template);

    expect(result.transformed).toBe(true);
    expect(result.payload).toEqual({
      currencyLower: 'usdc',
      decoratedMemo: 'Invoice-4091 - PROCESSED',
      missingField: 'standard_default',
    });
  });
});
