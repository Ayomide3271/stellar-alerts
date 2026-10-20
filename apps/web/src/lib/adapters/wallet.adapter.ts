/**
 * Wallet Adapter
 * 
 * Handles individual wallet-related API calls.
 * Each method represents a single RPC round-trip.
 */

import { WalletDTO, walletDTOSchema } from '@stellar-alerts/shared';
import { ApiAdapter } from './api.adapter';

export interface GetWalletsResponse {
  success: boolean;
  wallets: WalletDTO[];
}

export class WalletAdapter extends ApiAdapter {
  async getWallets(): Promise<WalletDTO[]> {
    const response = await this.get<GetWalletsResponse>('/wallets');
    return walletDTOSchema.array().parse(response.wallets);
  }

  async getWallet(walletId: string): Promise<WalletDTO> {
    const response = await this.get<{ success: boolean; wallet: WalletDTO }>(
      `/wallets/${walletId}`
    );
    return walletDTOSchema.parse(response.wallet);
  }

  async createWallet(data: {
    publicKey: string;
    label?: string;
  }): Promise<WalletDTO> {
    const response = await this.post<{ success: boolean; wallet: WalletDTO }>(
      '/wallets',
      data
    );
    return walletDTOSchema.parse(response.wallet);
  }

  async deleteWallet(walletId: string): Promise<void> {
    await this.delete(`/wallets/${walletId}`);
  }
}
