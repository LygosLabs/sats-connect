/**
 * DdkBackendClient - Interface and implementation for DLC backend operations
 *
 * This client abstracts the HTTP calls to the backend server that handles
 * DLC operations using the DDK (DLC Development Kit).
 */

export interface DlcAcceptResponse {
  dlcAcceptHex: string;
  dlcTransactionsHex: string;
  adaptorPoints: string[];
  contractId: string;
}

export interface DlcFinalizeResponse {
  txId: string;
  txHex: string;
}

export interface DlcBroadcastResponse {
  success: boolean;
}

export interface DlcExecuteResponse {
  txId: string;
  txHex: string;
}

export interface DlcExecuteWithFordefiResponse {
  txId: string;
  txHex: string;
  debugInfo?: {
    outcomeIndex: number;
    serverAdaptorSigHex: string;
    serverDecryptedSigHex: string;
    fordefiSigHex: string;
    offerPubkeyFirst: boolean;
    witnessScriptHex: string;
  };
}

export interface AdaptorPointsResponse {
  adaptorPoints: string[];
  success: boolean;
}

/**
 * Interface for DLC backend operations
 */
export interface DdkBackendClientInterface {
  /**
   * Accept a DLC offer
   * @param dlcOfferHex - Serialized DLC offer in hex
   * @returns DLC accept response with accept message, transactions, and adaptor points
   */
  acceptDlcOffer(dlcOfferHex: string): Promise<DlcAcceptResponse>;

  /**
   * Finalize a DLC sign
   * @param contractId - The contract ID
   * @param dlcSignHex - Serialized DLC sign message in hex
   * @returns Transaction ID and hex
   */
  finalizeDlcSign(contractId: string, dlcSignHex: string): Promise<DlcFinalizeResponse>;

  /**
   * Broadcast a transaction
   * @param txHex - Transaction hex to broadcast
   * @returns Success status
   */
  broadcastTransaction(txHex: string): Promise<DlcBroadcastResponse>;

  /**
   * Execute a DLC with oracle attestation
   * @param contractId - The contract ID
   * @param oracleAttestationHex - Serialized oracle attestation in hex
   * @returns Transaction ID and hex
   */
  executeDlc(contractId: string, oracleAttestationHex: string): Promise<DlcExecuteResponse>;

  /**
   * Execute a DLC directly (skip verification)
   * @param contractId - The contract ID
   * @param oracleAttestationHex - Serialized oracle attestation in hex
   * @returns Transaction ID and hex
   */
  executeDlcDirect(contractId: string, oracleAttestationHex: string): Promise<DlcExecuteResponse>;

  /**
   * Execute a DLC with Fordefi signature
   * @param contractId - The contract ID
   * @param oracleAttestationHex - Serialized oracle attestation in hex
   * @param fordefiSignature - Fordefi's signature in hex
   * @returns Transaction ID, hex, and debug info
   */
  executeDlcWithFordefi(
    contractId: string,
    oracleAttestationHex: string,
    fordefiSignature: string,
  ): Promise<DlcExecuteWithFordefiResponse>;

  /**
   * Get adaptor points for a DLC offer
   * @param dlcOfferHex - Serialized DLC offer in hex
   * @returns Adaptor points array
   */
  getAdaptorPoints(dlcOfferHex: string): Promise<AdaptorPointsResponse>;
}

/**
 * HTTP implementation of the DdkBackendClient
 */
export class DdkBackendClient implements DdkBackendClientInterface {
  private baseUrl: string;

  constructor(baseUrl: string = 'http://localhost:3005') {
    this.baseUrl = baseUrl;
  }

  async acceptDlcOffer(dlcOfferHex: string): Promise<DlcAcceptResponse> {
    const response = await fetch(`${this.baseUrl}/api/dlc/accept`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        dlcOfferHex,
      }),
    });

    if (!response.ok) {
      const errorData = (await response.json()) as { error: string };
      throw new Error(`Backend error: ${errorData.error}`);
    }

    return (await response.json()) as DlcAcceptResponse;
  }

  async finalizeDlcSign(contractId: string, dlcSignHex: string): Promise<DlcFinalizeResponse> {
    const response = await fetch(`${this.baseUrl}/api/dlc/finalize`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contractId,
        dlcSignHex,
      }),
    });

    if (!response.ok) {
      const errorData = (await response.json()) as { error: string };
      throw new Error(`Backend error: ${errorData.error}`);
    }

    return (await response.json()) as DlcFinalizeResponse;
  }

  async broadcastTransaction(txHex: string): Promise<DlcBroadcastResponse> {
    const response = await fetch(`${this.baseUrl}/api/dlc/broadcast`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        txHex,
      }),
    });

    if (!response.ok) {
      const errorData = (await response.json()) as { error: string };
      throw new Error(`Backend error: ${errorData.error}`);
    }

    return { success: true };
  }

  async executeDlc(contractId: string, oracleAttestationHex: string): Promise<DlcExecuteResponse> {
    const response = await fetch(`${this.baseUrl}/api/dlc/execute`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contractId,
        oracleAttestationHex,
      }),
    });

    if (!response.ok) {
      const errorData = (await response.json()) as { error: string };
      throw new Error(`Backend error: ${errorData.error}`);
    }

    return (await response.json()) as DlcExecuteResponse;
  }

  async executeDlcDirect(
    contractId: string,
    oracleAttestationHex: string,
  ): Promise<DlcExecuteResponse> {
    const response = await fetch(`${this.baseUrl}/api/dlc/execute-direct`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contractId,
        oracleAttestationHex,
      }),
    });

    if (!response.ok) {
      const errorData = (await response.json()) as { error: string; details?: string };
      throw new Error(`Backend error: ${errorData.error} - ${errorData.details ?? ''}`);
    }

    return (await response.json()) as DlcExecuteResponse;
  }

  async executeDlcWithFordefi(
    contractId: string,
    oracleAttestationHex: string,
    fordefiSignature: string,
  ): Promise<DlcExecuteWithFordefiResponse> {
    const response = await fetch(`${this.baseUrl}/api/dlc/execute-with-fordefi`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contractId,
        oracleAttestationHex,
        fordefiSignature,
      }),
    });

    if (!response.ok) {
      const errorData = (await response.json()) as { error: string; details?: string };
      throw new Error(`Backend error: ${errorData.error} - ${errorData.details ?? ''}`);
    }

    return (await response.json()) as DlcExecuteWithFordefiResponse;
  }

  async getAdaptorPoints(dlcOfferHex: string): Promise<AdaptorPointsResponse> {
    const response = await fetch(`${this.baseUrl}/api/dlc/adaptor-points`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        dlcOfferHex,
      }),
    });

    if (!response.ok) {
      const errorData = (await response.json()) as { error: string; details?: string };
      throw new Error(`Backend error: ${errorData.error} - ${errorData.details ?? ''}`);
    }

    return (await response.json()) as AdaptorPointsResponse;
  }
}

export default DdkBackendClient;
