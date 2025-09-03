import Provider from '@atomicfinance/provider';
import { Address, bitcoin } from '@atomicfinance/types';
import { addressToString } from '@atomicfinance/utils';
import axios, { AxiosInstance } from 'axios';
import { BitcoinNetwork } from 'bitcoin-network';

export interface BlockstreamApiProviderOptions {
  network: BitcoinNetwork;
  clientId?: string;
  clientSecret?: string;
  numberOfBlockConfirmation?: number;
  defaultFeePerByte?: number;
}

export default class BlockstreamApiProvider extends Provider {
  _network: BitcoinNetwork;
  _numberOfBlockConfirmation: number;
  _defaultFeePerByte: number;
  private clientId?: string;
  private clientSecret?: string;
  private accessToken: string | null = null;
  private tokenExpiresAt: number = 0;
  private tokenRequestInProgress: Promise<string | null> | null = null;
  private axiosInstance: AxiosInstance;

  constructor(options: BlockstreamApiProviderOptions) {
    const {
      network,
      clientId,
      clientSecret,
      numberOfBlockConfirmation = 1,
      defaultFeePerByte = 3,
    } = options;

    super();

    this._network = network;
    this._numberOfBlockConfirmation = numberOfBlockConfirmation;
    this._defaultFeePerByte = defaultFeePerByte;

    // Determine the correct Blockstream API URL based on network
    let baseUrl: string;
    if (network.name === 'bitcoin') {
      baseUrl = clientId
        ? 'https://enterprise.blockstream.info/api'
        : 'https://blockstream.info/api';
    } else if (network.name === 'testnet' || network.name === 'bitcoin_testnet') {
      baseUrl = clientId
        ? 'https://enterprise.blockstream.info/testnet/api'
        : 'https://blockstream.info/testnet/api';
    } else {
      throw new Error(`Unsupported network for Blockstream API: ${network.name}`);
    }

    console.log(`🌐 Using API base URL: ${baseUrl}`);

    this.clientId = clientId;
    this.clientSecret = clientSecret;

    // Create axios instance with interceptor for authentication
    this.axiosInstance = axios.create({
      baseURL: baseUrl,
      timeout: 60000,
    });

    // Add request interceptor to handle authentication (only if credentials provided)
    if (this.clientId && this.clientSecret) {
      this.axiosInstance.interceptors.request.use(async (config) => {
        const token = await this.getAccessToken();
        if (token) {
          config.headers.Authorization = `Bearer ${token}`;
        }
        return config;
      });
    }
  }

  /**
   * Get OAuth2 access token from Blockstream
   */
  private async getAccessToken(): Promise<string | null> {
    if (!this.clientId || !this.clientSecret) {
      return null;
    }

    // Check if current token is still valid (with 30s buffer)
    if (this.accessToken && Date.now() < this.tokenExpiresAt - 30000) {
      return this.accessToken;
    }

    // If a token request is already in progress, wait for it
    if (this.tokenRequestInProgress) {
      return await this.tokenRequestInProgress;
    }

    // Immediately set the promise to prevent race conditions
    this.tokenRequestInProgress = this.performTokenRequest();

    try {
      const result = await this.tokenRequestInProgress;
      return result;
    } finally {
      // Clear the in-progress promise
      this.tokenRequestInProgress = null;
    }
  }

  /**
   * Perform the actual OAuth2 token request
   */
  private async performTokenRequest(): Promise<string | null> {
    try {
      console.log(`[${new Date().toISOString()}] Requesting new Blockstream access token...`);

      const tokenResponse = await axios.post(
        'https://login.blockstream.com/realms/blockstream-public/protocol/openid-connect/token',
        new URLSearchParams({
          client_id: this.clientId!,
          client_secret: this.clientSecret!,
          grant_type: 'client_credentials',
          scope: 'openid',
        }),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        }
      );

      this.accessToken = tokenResponse.data.access_token;
      console.log('accessToken', this.accessToken);
      this.tokenExpiresAt = Date.now() + tokenResponse.data.expires_in * 1000;

      console.log(
        `[${new Date().toISOString()}] Access token obtained, expires in ${tokenResponse.data.expires_in}s`
      );
      return this.accessToken;
    } catch (error: any) {
      console.error(`[${new Date().toISOString()}] Failed to get access token:`, error.message);
      return null;
    }
  }

  /**
   * Make authenticated GET request to Blockstream API
   */
  private async nodeGet(path: string): Promise<any> {
    try {
      console.log(`🌐 API Request: GET ${path}`);
      const response = await this.axiosInstance.get(path);
      console.log(`✅ API Success: GET ${path} - ${response.status}`);
      return response.data;
    } catch (error: any) {
      console.error(
        `❌ API Error: GET ${path} - ${error.response?.status} ${error.response?.statusText}`
      );
      if (error.response?.data) {
        console.error(`📄 Error details:`, error.response.data);
      }

      if (error.response?.status === 404) {
        throw new Error(`Resource not found: ${path}`);
      }
      if (error.response?.status === 402) {
        throw new Error(`Payment required for endpoint: ${path}`);
      }
      if (error.response?.status === 429) {
        throw new Error(`Rate limit exceeded for endpoint: ${path}`);
      }
      throw error;
    }
  }

  /**
   * Make authenticated POST request to Blockstream API
   */
  private async nodePost(path: string, data: any): Promise<any> {
    try {
      const response = await this.axiosInstance.post(path, data);
      return response.data;
    } catch (error: any) {
      if (error.response?.status === 400) {
        throw new Error(`Bad request: ${error.response.data || error.message}`);
      }
      throw error;
    }
  }

  // Essential ChainProvider methods for DLC operations
  async getFeePerByte(numberOfBlocks = this._numberOfBlockConfirmation): Promise<number> {
    try {
      const feeEstimates = await this.nodeGet('/fee-estimates');
      const blockOptions = Object.keys(feeEstimates).map((block) => parseInt(block));
      const closestBlockOption = blockOptions.reduce((prev, curr) => {
        return Math.abs(prev - numberOfBlocks) < Math.abs(curr - numberOfBlocks) ? prev : curr;
      });
      return Math.round(feeEstimates[closestBlockOption]);
    } catch {
      return this._defaultFeePerByte;
    }
  }

  async getMinRelayFee(): Promise<number> {
    return 1;
  }

  async getUnspentTransactions(_addresses: (Address | string)[]): Promise<bitcoin.UTXO[]> {
    const addresses = [_addresses.map(addressToString)[0]];
    const utxoSets = await Promise.all(
      addresses.map(async (address) => {
        const data = await this.nodeGet(`/address/${address}/utxo`);
        return data.map((utxo: any) => ({
          ...utxo,
          address,
          value: utxo.value,
          blockHeight: utxo.status.block_height,
        }));
      })
    );
    return utxoSets.flat();
  }

  async getAddressTransactionCounts(
    _addresses: (Address | string)[]
  ): Promise<{ [address: string]: number }> {
    const addresses = [_addresses.map(addressToString)[0]];
    const transactionCounts: { [address: string]: number } = {};

    await Promise.all(
      addresses.map(async (address) => {
        const data = await this.nodeGet(`/address/${address}`);
        transactionCounts[address] = data.chain_stats.tx_count + data.mempool_stats.tx_count;
      })
    );

    return transactionCounts;
  }

  async getTransactionByHash(transactionHash: string): Promise<any> {
    const data = await this.nodeGet(`/tx/${transactionHash}`);
    const hex = await this.nodeGet(`/tx/${transactionHash}/hex`);
    // Return simplified transaction object - in real implementation would use normalizeTransactionObject
    return { ...data, hex };
  }

  async getRawTransactionByHash(transactionHash: string): Promise<string> {
    return this.nodeGet(`/tx/${transactionHash}/hex`);
  }

  async sendRawTransaction(rawTransaction: string): Promise<string> {
    return this.nodePost('/tx', rawTransaction);
  }

  async getBlockHeight(): Promise<number> {
    const data = await this.nodeGet('/blocks/tip/height');
    return parseInt(data);
  }

  /**
   * Get the current access token (for debugging)
   */
  public getCurrentToken(): string | null {
    return this.accessToken;
  }

  /**
   * Check if authentication is configured
   */
  public isAuthenticationConfigured(): boolean {
    return !!(this.clientId && this.clientSecret);
  }
}
