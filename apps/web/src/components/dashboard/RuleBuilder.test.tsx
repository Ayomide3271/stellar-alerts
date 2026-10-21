import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RuleBuilder, RuleAST } from './RuleBuilder';

describe('RuleBuilder', () => {
  it('exports a JSON AST payload for a single condition', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<RuleBuilder onSave={onSave} />);

    await user.type(screen.getByLabelText('Condition value'), '100');
    await user.click(screen.getByRole('button', { name: 'Save Rule' }));

    const expected: RuleAST = {
      logic: 'AND',
      conditions: [{ field: 'amount', operator: 'gt', value: '100' }],
    };
    expect(onSave).toHaveBeenCalledWith(expected);
    expect(screen.getByText(/JSON AST Preview/i)).toBeInTheDocument();
  });

  it('supports adding a second condition and switching to OR logic', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<RuleBuilder onSave={onSave} />);

    await user.click(screen.getByRole('button', { name: 'OR' }));
    await user.click(screen.getByRole('button', { name: '+ Add Condition' }));

    const values = screen.getAllByLabelText('Condition value');
    await user.type(values[0], '50');
    await user.type(values[1], 'USDC');

    const fields = screen.getAllByLabelText('Condition field');
    await user.selectOptions(fields[1], 'asset');

    await user.click(screen.getByRole('button', { name: 'Save Rule' }));

    expect(onSave).toHaveBeenCalledWith({
      logic: 'OR',
      conditions: [
        { field: 'amount', operator: 'gt', value: '50' },
        { field: 'asset', operator: 'eq', value: 'USDC' },
      ],
    });
  });

  it('validates that a numeric amount is required before saving', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<RuleBuilder onSave={onSave} />);

    await user.type(screen.getByLabelText('Condition value'), 'not-a-number');
    await user.click(screen.getByRole('button', { name: 'Save Rule' }));

    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByText('Amount must be a number.')).toBeInTheDocument();
  });

  it('rejects saving when a required value is left empty', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<RuleBuilder onSave={onSave} />);

    await user.click(screen.getByRole('button', { name: 'Save Rule' }));

    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByText('Value is required.')).toBeInTheDocument();
  });

  it('prompts user to sign confirmation challenge and submits X-Stellar-Signature header (#648)', async () => {
    const {
      encodeEd25519PublicKeyStrKey,
      bytesToBase64,
      STELLAR_SIGNATURE_HEADER,
    } = await import('../../lib/wallet/signature-guard');

    const keyPair = (await globalThis.crypto.subtle.generateKey(
      { name: 'Ed25519' },
      true,
      ['sign', 'verify']
    )) as CryptoKeyPair;
    const rawPub = new Uint8Array(await globalThis.crypto.subtle.exportKey('raw', keyPair.publicKey));
    const publicKey = encodeEd25519PublicKeyStrKey(rawPub);

    const signer = vi.fn(async (message: string) => {
      const sigBuf = await globalThis.crypto.subtle.sign(
        'Ed25519',
        keyPair.privateKey,
        new TextEncoder().encode(message)
      );
      return bytesToBase64(new Uint8Array(sigBuf));
    });

    const user = userEvent.setup();
    const onSave = vi.fn();
    render(
      <RuleBuilder
        onSave={onSave}
        requireWalletSignature
        walletPublicKey={publicKey}
        walletSigner={signer}
        verifyCryptographically
      />
    );

    await user.type(screen.getByLabelText('Condition value'), '500');
    await user.click(screen.getByRole('button', { name: 'Save Rule' }));

    // Modal should open before onSave is called
    expect(onSave).not.toHaveBeenCalled();
    expect(
      screen.getByRole('heading', { name: /Confirm Rule Change with Wallet Signature/i })
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Sign & Confirm' }));

    expect(signer).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledTimes(1);
    const [savedAst, headers] = onSave.mock.calls[0];
    expect(savedAst).toEqual({
      logic: 'AND',
      conditions: [{ field: 'amount', operator: 'gt', value: '500' }],
    });
    expect(headers?.[STELLAR_SIGNATURE_HEADER]).toContain(`pub=${publicKey}`);
  });

  it('rejects sensitive rule modification when user rejects wallet signature prompt (#648)', async () => {
    const { encodeEd25519PublicKeyStrKey } = await import('../../lib/wallet/signature-guard');

    const keyPair = (await globalThis.crypto.subtle.generateKey(
      { name: 'Ed25519' },
      true,
      ['sign', 'verify']
    )) as CryptoKeyPair;
    const rawPub = new Uint8Array(await globalThis.crypto.subtle.exportKey('raw', keyPair.publicKey));
    const publicKey = encodeEd25519PublicKeyStrKey(rawPub);

    const rejectingSigner = vi.fn(async () => {
      throw new Error('User declined signature request in Freighter');
    });

    const user = userEvent.setup();
    const onSave = vi.fn();
    render(
      <RuleBuilder
        onSave={onSave}
        requireWalletSignature
        walletPublicKey={publicKey}
        walletSigner={rejectingSigner}
      />
    );

    await user.type(screen.getByLabelText('Condition value'), '250');
    await user.click(screen.getByRole('button', { name: 'Save Rule' }));
    await user.click(screen.getByRole('button', { name: 'Sign & Confirm' }));

    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(/declined/i);
  });

  it('verifies Ed25519 signature logic against a test keypair and rejects tampered or expired challenges (#648)', async () => {
    const {
      encodeEd25519PublicKeyStrKey,
      buildRuleChangeChallenge,
      verifyRuleSignature,
      bytesToBase64,
    } = await import('../../lib/wallet/signature-guard');

    const keyPair = (await globalThis.crypto.subtle.generateKey(
      { name: 'Ed25519' },
      true,
      ['sign', 'verify']
    )) as CryptoKeyPair;
    const rawPub = new Uint8Array(await globalThis.crypto.subtle.exportKey('raw', keyPair.publicKey));
    const publicKey = encodeEd25519PublicKeyStrKey(rawPub);

    const now = 1_700_000_000_000;
    const challenge = buildRuleChangeChallenge({
      action: 'rule.update',
      payload: { logic: 'AND', conditions: [{ field: 'amount', operator: 'gt', value: '1000' }] },
      publicKey,
      timestamp: now,
    });

    const sigBuffer = await globalThis.crypto.subtle.sign(
      'Ed25519',
      keyPair.privateKey,
      new TextEncoder().encode(challenge.message)
    );
    const validSignature = bytesToBase64(new Uint8Array(sigBuffer));

    const validCheck = await verifyRuleSignature({
      publicKey,
      challenge,
      signature: validSignature,
      now: now + 1000,
    });
    expect(validCheck.valid).toBe(true);

    // Tampered signature must fail
    const tamperedBytes = new Uint8Array(sigBuffer);
    tamperedBytes[0] ^= 0xff;
    const invalidCheck = await verifyRuleSignature({
      publicKey,
      challenge,
      signature: bytesToBase64(tamperedBytes),
      now: now + 1000,
    });
    expect(invalidCheck.valid).toBe(false);

    // Expired challenge must fail
    const expiredCheck = await verifyRuleSignature({
      publicKey,
      challenge,
      signature: validSignature,
      now: now + 10 * 60 * 1000,
    });
    expect(expiredCheck.valid).toBe(false);
    expect(expiredCheck.reason).toMatch(/expired/i);
  });
});

