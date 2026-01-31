import { Address, DdkInterface, DdkOracleInfo, DdkTransaction } from '@atomicfinance/types';

// DDK types re-exported for convenience
export type { DdkInterface, DdkOracleInfo, DdkTransaction };

// Additional types we need
export interface Input {
  txid: string;
  vout: number;
  address: string;
  value: number;
  txHex?: string; // Full transaction hex needed for DDK
  derivationPath?: string;
}

// Address purposes (matching sats-connect)
export enum AddressPurpose {
  Payment = 'payment',
  Ordinals = 'ordinals',
}

// Extended Address interface for our provider
export interface SatsConnectAddress extends Address {
  purpose?: AddressPurpose;
}

// SatsConnect response type
export interface SatsConnectResponse<T> {
  status: 'success' | 'error';
  result?: T;
  error?: {
    code: number;
    message: string;
  };
}

// DLC Sign result interface
export interface SignDlcResult {
  fundingTransaction: string;
  refundTransaction: string;
  cetTransactions: string[];
}

export interface SatsConnectWalletAddress {
  address: string;
  publicKey: string;
  purpose: AddressPurpose;
  addressType?: string;
  derivationPath?: string;
}

export interface BitcoinSatsConnectProviderOptions {
  esploraUrl?: string;
  network?: import('bitcoin-network').BitcoinNetwork;
  wallet?: WalletInterface;
}

// Wallet interface that both SatsConnect and our emulator implement
export interface WalletInterface {
  request<T>(method: string, params?: unknown): Promise<SatsConnectResponse<T>>;
}

// DLC Sign Offer parameters
export interface DlcSignOfferParams {
  fundingTransaction: {
    psbt: string;
    signInputs?: Record<string, number[]>;
  };
  refundTransaction: {
    psbt: string;
    signInputs?: Record<string, number[]>;
  };
  cetTransactions: {
    psbt: string;
    adaptorPoint: string;
  }[];
  // DDK-specific data for adaptor signature creation
  cets?: DdkTransaction[];
  oracleInfo?: DdkOracleInfo[];
  fundingScriptPubkey?: Buffer;
  fundOutputValue?: bigint;
  messages?: Buffer[][][];
}

// Response from dlc_signOffer
export interface DlcSignOfferResult {
  fundingTransaction: string; // Base64 signed PSBT
  refundTransaction: string; // Base64 signed PSBT
  cetTransactions: string[]; // Base64 adaptor signatures
}

// Response from signPsbt
export interface SignPsbtResult {
  psbt: string; // Base64 signed PSBT
}

// Response from getAddresses
export interface GetAddressesResult {
  addresses: SatsConnectWalletAddress[];
}

// Response from wallet_getAccount
export type GetAccountResult = Record<string, unknown>;

/**
 * Extended wallet client interface with typed methods
 * This provides a higher-level API on top of the generic WalletInterface
 */
export interface WalletClientInterface {
  /**
   * Get addresses from the wallet
   * @param purposes - Address purposes to request
   * @returns Wallet addresses
   */
  getAddresses(purposes: AddressPurpose[]): Promise<SatsConnectWalletAddress[]>;

  /**
   * Check if wallet is connected
   * @returns True if connected
   */
  isConnected(): Promise<boolean>;

  /**
   * Sign a PSBT
   * @param psbt - Base64 encoded PSBT
   * @param signInputs - Map of address to input indexes to sign
   * @returns Signed PSBT in base64
   */
  signPsbt(psbt: string, signInputs: Record<string, number[]>): Promise<string>;

  /**
   * Sign DLC offer (unified signing for funding, refund, and CET adaptor signatures)
   * @param params - DLC sign offer parameters
   * @returns Sign result with signed transactions and adaptor signatures
   */
  dlcSignOffer(params: DlcSignOfferParams): Promise<SignDlcResult>;
}

/**
 * Wrapper class that implements WalletClientInterface using WalletInterface
 */
export class WalletClient implements WalletClientInterface {
  private wallet: WalletInterface;

  constructor(wallet: WalletInterface) {
    this.wallet = wallet;
  }

  async getAddresses(purposes: AddressPurpose[]): Promise<SatsConnectWalletAddress[]> {
    const response = await this.wallet.request<GetAddressesResult>('getAddresses', {
      purposes,
    });

    if (response.status === 'error') {
      throw new Error(`Wallet error: ${response.error?.message ?? 'Unknown error'}`);
    }

    if (!response.result?.addresses) {
      throw new Error('No addresses returned from wallet');
    }

    return response.result.addresses;
  }

  async isConnected(): Promise<boolean> {
    try {
      const response = await this.wallet.request<GetAccountResult>('wallet_getAccount', undefined);
      return response.status === 'success';
    } catch {
      return false;
    }
  }

  async signPsbt(psbt: string, signInputs: Record<string, number[]>): Promise<string> {
    const response = await this.wallet.request<SignPsbtResult>('signPsbt', {
      psbt,
      signInputs,
    });

    if (response.status === 'error') {
      throw new Error(`Failed to sign PSBT: ${response.error?.message ?? 'Unknown error'}`);
    }

    if (!response.result?.psbt) {
      throw new Error('No signed PSBT in response');
    }

    return response.result.psbt;
  }

  async dlcSignOffer(params: DlcSignOfferParams): Promise<SignDlcResult> {
    const response = await this.wallet.request<SignDlcResult>('dlc_signOffer', params);

    if (response.status === 'error') {
      throw new Error(
        `Failed to sign DLC transactions: ${response.error?.message ?? 'Unknown error'}`,
      );
    }

    if (!response.result) {
      throw new Error('No result in sign response');
    }

    return response.result;
  }

  /**
   * Get the underlying wallet interface for direct access
   */
  getWalletInterface(): WalletInterface {
    return this.wallet;
  }
}
