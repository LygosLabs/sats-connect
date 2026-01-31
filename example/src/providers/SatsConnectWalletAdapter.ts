/**
 * SatsConnectWalletAdapter - Adapts the sats-connect Wallet to our WalletInterface
 *
 * This adapter allows using the standard sats-connect Wallet with the
 * NewBitcoinSatsConnectProvider which expects a WalletInterface.
 */

import Wallet from 'sats-connect';
import type { SatsConnectResponse, WalletInterface } from './types';

/**
 * Adapter that wraps sats-connect's Wallet to implement WalletInterface
 */
export class SatsConnectWalletAdapter implements WalletInterface {
  private wallet: typeof Wallet;

  constructor() {
    this.wallet = Wallet;
  }

  async request<T>(method: string, params?: unknown): Promise<SatsConnectResponse<T>> {
    // sats-connect's Wallet.request returns a similar response format
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any
    const response = (await (this.wallet.request as any)(method, params)) as SatsConnectResponse<T>;
    return response;
  }
}

export default SatsConnectWalletAdapter;
