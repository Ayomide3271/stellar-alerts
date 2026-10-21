'use client';

import React, { useState } from 'react';
import {
  RuleMutationChallenge,
  SignedRuleMutation,
  WalletProviderType,
  WalletSignerFn,
  requestWalletRuleSignature,
  buildVerifiedRuleMutationHeaders,
} from '../../lib/wallet/signature-guard';

export interface WalletAuthModalProps {
  isOpen: boolean;
  challenge: RuleMutationChallenge | null;
  actionLabel?: string;
  defaultProvider?: WalletProviderType;
  signer?: WalletSignerFn;
  verifyCryptographically?: boolean;
  onConfirm: (signed: SignedRuleMutation, headers: Record<string, string>) => void;
  onCancel: () => void;
}

export const WalletAuthModal: React.FC<WalletAuthModalProps> = ({
  isOpen,
  challenge,
  actionLabel = 'Modify Sensitive Alert Rule',
  defaultProvider = 'freighter',
  signer,
  verifyCryptographically = false,
  onConfirm,
  onCancel,
}) => {
  const [provider, setProvider] = useState<WalletProviderType>(defaultProvider);
  const [isSigning, setIsSigning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen || !challenge) {
    return null;
  }

  const handleSign = async () => {
    setIsSigning(true);
    setError(null);
    try {
      const signed = await requestWalletRuleSignature(challenge, {
        provider,
        signer,
      });
      const headers = await buildVerifiedRuleMutationHeaders(signed, {
        verifyCryptographically,
      });
      onConfirm(signed, headers);
    } catch (err: any) {
      setError(err?.message || 'Wallet signature confirmation was rejected.');
    } finally {
      setIsSigning(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="wallet-auth-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-sm p-4"
    >
      <div className="w-full max-w-md rounded-2xl bg-slate-900 border border-slate-800 p-6 shadow-2xl space-y-5">
        <div>
          <h3 id="wallet-auth-modal-title" className="text-lg font-bold text-white">
            Confirm Rule Change with Wallet Signature
          </h3>
          <p className="text-xs text-slate-400 mt-1">
            Sign this timestamped challenge using your non-custodial Stellar wallet to authorize:{' '}
            <span className="text-purple-300 font-medium">{actionLabel}</span>
          </p>
        </div>

        <div className="space-y-2">
          <label
            htmlFor="wallet-provider-select"
            className="block text-xs font-semibold uppercase tracking-wider text-slate-400"
          >
            Browser Wallet Provider
          </label>
          <select
            id="wallet-provider-select"
            aria-label="Browser Wallet Provider"
            value={provider}
            onChange={(e) => setProvider(e.target.value as WalletProviderType)}
            className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-800 text-white text-sm"
          >
            <option value="freighter">Freighter</option>
            <option value="albedo">Albedo</option>
          </select>
        </div>

        <div className="space-y-1">
          <div className="text-xs font-semibold uppercase tracking-wider text-slate-400">
            Challenge Payload
          </div>
          <pre
            data-testid="wallet-challenge-preview"
            className="p-3 rounded-xl bg-slate-950 border border-slate-800 text-[11px] text-slate-300 font-mono overflow-x-auto whitespace-pre-wrap break-all"
          >
            {challenge.message}
          </pre>
        </div>

        {error && (
          <div
            role="alert"
            className="p-3 rounded-xl bg-red-950/60 border border-red-800 text-xs text-red-300"
          >
            {error}
          </div>
        )}

        <div className="flex justify-end gap-3 pt-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={isSigning}
            className="px-4 py-2 rounded-xl border border-slate-700 text-slate-300 hover:text-white text-sm font-medium"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSign}
            disabled={isSigning}
            className="px-4 py-2 rounded-xl bg-purple-600 hover:bg-purple-500 text-white text-sm font-medium disabled:opacity-50"
          >
            {isSigning ? 'Awaiting Wallet…' : 'Sign & Confirm'}
          </button>
        </div>
      </div>
    </div>
  );
};
