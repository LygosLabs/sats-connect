import {
  BitcoinEsploraApiProvider,
  EsploraApiProviderOptions,
} from '@atomicfinance/bitcoin-esplora-api-provider';
import { Address, bitcoin } from '@atomicfinance/types';
import { addressToString } from '@atomicfinance/utils';

export interface RateLimitedEsploraApiProviderOptions extends EsploraApiProviderOptions {
  /** Delay between API requests in milliseconds (default: 500) */
  rateLimitDelayMs?: number;
}

/**
 * Rate-limited Esplora API provider that adds delays between requests
 * to avoid 429 Too Many Requests errors from public APIs like mempool.space
 */
export default class RateLimitedEsploraApiProvider extends BitcoinEsploraApiProvider {
  private rateLimitDelayMs: number;
  private lastRequestTime: number = 0;

  constructor(options: RateLimitedEsploraApiProviderOptions) {
    super(options);
    this.rateLimitDelayMs = options.rateLimitDelayMs ?? 50;
  }

  /**
   * Wait for rate limit delay if needed
   */
  private async waitForRateLimit(): Promise<void> {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;

    if (timeSinceLastRequest < this.rateLimitDelayMs) {
      const waitTime = this.rateLimitDelayMs - timeSinceLastRequest;
      await new Promise((resolve) => setTimeout(resolve, waitTime));
    }

    this.lastRequestTime = Date.now();
  }

  /**
   * Override getUnspentTransactions to add rate limiting
   */
  async getUnspentTransactions(_addresses: (Address | string)[]): Promise<bitcoin.UTXO[]> {
    const addresses = _addresses.map(addressToString);
    const utxos: bitcoin.UTXO[] = [];

    // Process addresses sequentially with rate limiting
    for (const address of addresses) {
      await this.waitForRateLimit();
      const addressUtxos = await this._getUnspentTransactions(address);
      utxos.push(...addressUtxos);
    }

    return utxos;
  }

  /**
   * Override getAddressTransactionCounts to add rate limiting
   */
  async getAddressTransactionCounts(
    _addresses: (Address | string)[]
  ): Promise<{ [address: string]: number }> {
    const addresses = _addresses.map(addressToString);
    const transactionCounts: { [address: string]: number } = {};

    // Process addresses sequentially with rate limiting
    for (const address of addresses) {
      await this.waitForRateLimit();
      const txCount = await this._getAddressTransactionCount(address);
      transactionCounts[address] = txCount;
    }

    return transactionCounts;
  }
}
