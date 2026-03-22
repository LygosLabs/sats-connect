import Provider from '@atomicfinance/provider';
import { Address, WalletProvider } from '@atomicfinance/types';
import { StreamReader } from '@node-dlc/bufio';
import { Sequence, Tx } from '@node-dlc/core';
import {
  CetAdaptorSignatures,
  ContractInfo,
  DlcAccept,
  DlcOffer,
  DlcSign,
  DlcTransactions,
  FundingInput,
  FundingSignatures,
  ScriptWitnessV0,
} from '@node-dlc/messaging';
import * as bech32Module from 'bech32';
import { BitcoinNetwork, BitcoinNetworks } from 'bitcoin-network';
import { Psbt, address, Transaction as btTransaction, payments } from 'bitcoinjs-lib';
import Wallet, { AddressPurpose } from 'sats-connect';

// Additional types we need
export interface Input {
  txid: string;
  vout: number;
  address: string;
  value: number;
  txHex?: string; // Full transaction hex needed for DDK
  derivationPath?: string;
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
interface SignDlcResult {
  fundingTransaction: string;
  refundTransaction: string;
  cetTransactions: string[];
}

interface SatsConnectWalletAddress {
  address: string;
  publicKey: string;
  purpose: AddressPurpose;
  addressType?: string;
  derivationPath?: string;
}

interface BitcoinSatsConnectProviderOptions {
  esploraUrl?: string;
  network?: BitcoinNetwork;
}

export class BitcoinSatsConnectProvider extends Provider implements Partial<WalletProvider> {
  private wallet: typeof Wallet;
  private esploraUrl: string;
  private network: BitcoinNetwork;

  constructor(options: BitcoinSatsConnectProviderOptions = {}) {
    super();
    this.wallet = Wallet;
    this.esploraUrl = options.esploraUrl ?? 'https://mempool.space/testnet4/api';
    this.network = options.network ?? BitcoinNetworks.bitcoin_testnet;
  }

  /**
   * Get addresses from the SatsConnect wallet.
   * @return {Promise<Address[]>} Resolves with a list of addresses.
   */
  async getAddresses(): Promise<SatsConnectAddress[]> {
    try {
      // Use the getAddresses method from SatsConnect
      const response = await this.wallet.request('getAddresses', {
        purposes: [AddressPurpose.Payment, AddressPurpose.Ordinals],
      });

      if (response.status === 'error') {
        throw new Error(`SatsConnect error: ${response.error?.message || 'Unknown error'}`);
      }

      if (!response.result?.addresses) {
        throw new Error('No addresses returned from SatsConnect wallet');
      }

      // Convert SatsConnect addresses to our Address format
      return response.result.addresses
        .filter(
          (addr: SatsConnectWalletAddress) =>
            // Filter out Stacks addresses for Bitcoin operations
            addr.purpose === AddressPurpose.Payment || addr.purpose === AddressPurpose.Ordinals,
        )
        .map(
          (addr: SatsConnectWalletAddress): SatsConnectAddress => ({
            address: addr.address,
            publicKey: addr.publicKey,
            derivationPath: addr.derivationPath,
            purpose: addr.purpose,
          }),
        );
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to get addresses from SatsConnect wallet: ${errorMessage}`);
    }
  }

  /**
   * Get a specific address by purpose
   * @param purpose - The address purpose to filter by
   * @return {Promise<Address | undefined>} Resolves with the address if found
   */
  async getAddressByPurpose(purpose: AddressPurpose): Promise<SatsConnectAddress | undefined> {
    const addresses = await this.getAddresses();
    return addresses.find((addr) => addr.purpose === purpose);
  }

  /**
   * Get payment address (first payment address)
   * @return {Promise<SatsConnectAddress>} Resolves with payment address
   */
  async getPaymentAddress(): Promise<SatsConnectAddress> {
    const address = await this.getAddressByPurpose(AddressPurpose.Payment);
    if (!address) {
      throw new Error('No payment address available from SatsConnect wallet');
    }
    return address;
  }

  /**
   * Get ordinals address (first ordinals address)
   * @return {Promise<SatsConnectAddress>} Resolves with ordinals address
   */
  async getOrdinalsAddress(): Promise<SatsConnectAddress> {
    const address = await this.getAddressByPurpose(AddressPurpose.Ordinals);
    if (!address) {
      throw new Error('No ordinals address available from SatsConnect wallet');
    }
    return address;
  }

  /**
   * Check if the wallet is connected
   * @return {Promise<boolean>} True if the wallet is connected
   */
  async isConnected(): Promise<boolean> {
    try {
      const response = await this.wallet.request('wallet_getAccount', undefined);
      return response.status === 'success';
    } catch (error) {
      return false;
    }
  }

  /**
   * Create a DLC Offer (simplified version for demonstration)
   * @param contractInfo - Contract information from @node-dlc/messaging
   * @param offerCollateralSatoshis - Amount the offerer is putting into the contract
   * @param feeRatePerVb - Fee rate in satoshis per virtual byte
   * @param cetLocktime - The nLockTime to be put on CETs
   * @param refundLocktime - The nLockTime to be put on the refund transaction
   * @param fixedInputs - Optional fixed inputs to use for funding
   * @return {Promise<DlcOffer>} Resolves with a DLC offer object
   */
  async createDlcOffer(
    contractInfo: ContractInfo,
    offerCollateralSatoshis: bigint,
    feeRatePerVb: bigint,
    cetLocktime: number,
    refundLocktime: number,
    fixedInputs?: Input[],
  ): Promise<DlcOffer> {
    try {
      // Validate contract info
      contractInfo.validate();

      // Allow zero collateral for single-funded DLCs (where only the accepter provides funds)
      if (offerCollateralSatoshis < 0n) {
        throw new Error('Offer collateral cannot be negative');
      }

      if (offerCollateralSatoshis > contractInfo.totalCollateral) {
        throw new Error('Offer collateral cannot exceed total contract collateral');
      }

      // Get addresses for the DLC
      const paymentAddress = await this.getPaymentAddress();

      // Create the DLC offer using the real DlcOffer class
      const dlcOffer = new DlcOffer();

      // Generate a random temporary contract ID
      dlcOffer.temporaryContractId = Buffer.from(this.generateRandomHex(32), 'hex');
      dlcOffer.contractInfo = contractInfo;
      dlcOffer.fundingPubkey = Buffer.from(paymentAddress.publicKey ?? '', 'hex');
      dlcOffer.payoutSpk = Buffer.from(this.addressToScriptPubKey(paymentAddress.address), 'hex');
      dlcOffer.payoutSerialId = this.generateSerialId();
      dlcOffer.offerCollateral = offerCollateralSatoshis;

      // Get UTXOs for funding only if offerer is contributing collateral
      // For single-funded DLCs (offerCollateralSatoshis === 0n), skip UTXO selection entirely
      let fundingUtxos: Input[] = [];
      if (offerCollateralSatoshis > 0n) {
        fundingUtxos =
          fixedInputs ?? (await this.getUtxosForAmount(offerCollateralSatoshis + 10000n)); // Add some buffer for fees
      }

      // Create funding inputs from UTXOs (will be empty array for single-funded)
      dlcOffer.fundingInputs = fundingUtxos.map((input, index) => {
        const tx = Tx.decode(StreamReader.fromHex(input.txHex!));
        const fundingInput = new FundingInput();
        fundingInput.inputSerialId = BigInt(index + 1);
        fundingInput.prevTx = tx;
        fundingInput.prevTxVout = input.vout;
        fundingInput.sequence = Sequence.default();
        fundingInput.maxWitnessLen = 108; // Standard witness length for P2WPKH
        fundingInput.redeemScript = Buffer.from('', 'hex');
        return fundingInput;
      });

      dlcOffer.changeSpk = Buffer.from(this.addressToScriptPubKey(paymentAddress.address), 'hex');
      dlcOffer.changeSerialId = this.generateSerialId();
      dlcOffer.fundOutputSerialId = this.generateSerialId();
      dlcOffer.feeRatePerVb = feeRatePerVb;
      dlcOffer.cetLocktime = cetLocktime;
      dlcOffer.refundLocktime = refundLocktime;
      dlcOffer.contractFlags = Buffer.from('00', 'hex');
      dlcOffer.chainHash = Buffer.from(
        '00000000da84f2bafbbc53dee25a72ae507ff4914b867c565be350b0da8bf043',
        'hex',
      ); // Bitcoin testnet4

      return dlcOffer;
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to create DLC offer: ${errorMessage}`);
    }
  }

  /**
   * Helper function to generate random hex string
   * @param length - Length in bytes
   * @return {string} Random hex string
   */
  private generateRandomHex(length: number): string {
    const bytes = new Uint8Array(length);
    globalThis.crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Helper function to generate a serial ID
   * @return {bigint} Random serial ID
   */
  private generateSerialId(): bigint {
    return BigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER));
  }

  /**
   * Helper function to convert address to script pubkey (supports SegWit and Taproot)
   * @param addressStr - Bitcoin address
   * @return {string} Script pubkey hex
   */
  private addressToScriptPubKey(addressStr: string): string {
    // Try standard bitcoinjs-lib first (works for P2PKH, P2SH, P2WPKH, P2WSH)
    try {
      return address.toOutputScript(addressStr, this.network).toString('hex');
    } catch {
      // Handle Taproot (bech32m) addresses
      if (addressStr.startsWith('tb1p') || addressStr.startsWith('bc1p')) {
        const decoded = bech32Module.bech32m.decode(addressStr);
        const witnessProgram = bech32Module.bech32m.fromWords(decoded.words.slice(1));
        // P2TR scriptPubKey: OP_1 (0x51) + push32 (0x20) + 32-byte x-only pubkey
        const scriptPubKey = Buffer.concat([
          Buffer.from([0x51, 0x20]),
          Buffer.from(witnessProgram),
        ]);
        return scriptPubKey.toString('hex');
      }
      throw new Error(`Unsupported address format: ${addressStr}`);
    }
  }

  /**
   * Helper function to convert script pubkey to address (supports SegWit and Taproot)
   * @param scriptPubKey - Script pubkey buffer
   * @return {string} Bitcoin address
   */
  private scriptPubKeyToAddress(scriptPubKey: Buffer): string {
    // Try standard bitcoinjs-lib first
    try {
      return address.fromOutputScript(scriptPubKey, this.network);
    } catch {
      // Handle Taproot (P2TR) scripts: OP_1 (0x51) + push32 (0x20) + 32-byte x-only pubkey
      if (scriptPubKey.length === 34 && scriptPubKey[0] === 0x51 && scriptPubKey[1] === 0x20) {
        const witnessProgram = scriptPubKey.slice(2);
        const words = [1, ...bech32Module.bech32m.toWords(witnessProgram)]; // witness version 1
        const prefix = this.network === BitcoinNetworks.bitcoin ? 'bc' : 'tb';
        return bech32Module.bech32m.encode(prefix, words);
      }
      throw new Error(`Unsupported script pubkey format: ${scriptPubKey.toString('hex')}`);
    }
  }

  /**
   * Get full transaction hex from Esplora API
   * @param txid - Transaction ID
   * @return {Promise<string>} Full transaction hex
   */
  async getTransactionHex(txid: string): Promise<string> {
    try {
      const response = await fetch(`${this.esploraUrl}/tx/${txid}/hex`);

      if (!response.ok) {
        throw new Error(`Failed to fetch transaction hex: ${response.statusText}`);
      }

      return await response.text();
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to get transaction hex for ${txid}: ${errorMessage}`);
    }
  }

  /**
   * Get UTXOs for an address using Esplora API
   * @param address - Bitcoin address
   * @return {Promise<Input[]>} Array of UTXOs as Input objects with full transaction hex
   */
  async getUtxosForAddress(address: string): Promise<Input[]> {
    try {
      const response = await fetch(`${this.esploraUrl}/address/${address}/utxo`);

      if (!response.ok) {
        throw new Error(`Failed to fetch UTXOs: ${response.statusText}`);
      }

      const utxos = (await response.json()) as {
        txid: string;
        vout: number;
        value: number;
      }[];

      // Fetch full transaction hex for each UTXO
      const utxosWithTxHex = await Promise.all(
        utxos.map(async (utxo) => {
          const txHex = await this.getTransactionHex(utxo.txid);
          return {
            txid: utxo.txid,
            vout: utxo.vout,
            address: address,
            value: utxo.value,
            txHex: txHex, // Full transaction hex needed for DDK
            derivationPath: undefined, // Will be filled by wallet if needed
          };
        }),
      );

      return utxosWithTxHex;
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to get UTXOs for address ${address}: ${errorMessage}`);
    }
  }

  /**
   * Get sufficient UTXOs for a given amount
   * @param amount - Amount needed in satoshis
   * @return {Promise<Input[]>} Array of UTXOs that cover the amount
   */
  async getUtxosForAmount(amount: bigint): Promise<Input[]> {
    try {
      const addresses = await this.getAddresses();
      const selectedUtxos: Input[] = [];
      let totalValue = 0n;

      // Simple UTXO selection - check each address until we have enough
      for (const addr of addresses) {
        const utxos = await this.getUtxosForAddress(addr.address);

        for (const utxo of utxos) {
          selectedUtxos.push(utxo);
          totalValue += BigInt(utxo.value);

          if (totalValue >= amount) {
            return selectedUtxos;
          }
        }
      }

      throw new Error(`Insufficient funds: need ${amount} sats, have ${totalValue} sats`);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to select UTXOs for amount ${amount}: ${errorMessage}`);
    }
  }

  /**
   * Sign DLC Accept using SatsConnect wallet (following DDK signDlcAccept pattern)
   * @param dlcOffer - The DLC offer
   * @param dlcAccept - The DLC accept message
   * @param dlcTransactions - The DLC transactions containing funding and refund PSBTs
   * @param adaptorPoints - Optional adaptor points from backend (if not provided, will calculate in browser)
   * @param contractId - Optional contract ID from backend (if not provided, will compute from funding tx)
   * @return {Promise<DlcSign>} The DLC sign message
   */
  async signDlcAccept(
    dlcOffer: DlcOffer,
    dlcAccept: DlcAccept,
    dlcTransactions: DlcTransactions,
    adaptorPoints?: string[],
    contractId?: string,
  ): Promise<DlcSign> {
    try {
      // Validate inputs
      dlcOffer.validate();
      dlcAccept.validate();

      if (Buffer.compare(dlcOffer.fundingPubkey, dlcAccept.fundingPubkey) === 0) {
        throw new Error('DlcOffer and DlcAccept FundingPubKey cannot be the same');
      }

      // Create DLC sign message
      const dlcSign = new DlcSign();

      // Use provided contract ID or compute it from funding transaction
      if (contractId) {
        dlcSign.contractId = Buffer.from(contractId, 'hex');
      } else {
        // Compute contract ID using funding transaction details
        const fundTxId = dlcTransactions.fundTx.txId.serialize();
        const fundOutputIndex = dlcTransactions.fundTxVout;
        const temporaryContractId = dlcOffer.temporaryContractId;

        // For now, create a deterministic contract ID based on funding tx
        // In a full implementation, this should use the same computeContractId method as the backend
        const combinedData = Buffer.concat([
          fundTxId,
          Buffer.from([fundOutputIndex]),
          temporaryContractId,
        ]);
        const crypto = globalThis.crypto;
        const hashBuffer = await crypto.subtle.digest('SHA-256', combinedData);
        dlcSign.contractId = Buffer.from(hashBuffer);
      }

      // CET adaptor signatures will be created after signing

      // Create PSBTs for all transactions
      const fundingPsbt = this.createFundingPsbt(dlcOffer, dlcAccept, dlcTransactions);
      const refundPsbt = this.createRefundPsbt(dlcOffer, dlcAccept, dlcTransactions);

      // Create CET PSBTs
      const cetPsbts: Psbt[] = [];
      const numCets = dlcTransactions.cets?.length || 0;
      for (let i = 0; i < numCets; i++) {
        const cetPsbt = this.createCetPsbt(dlcOffer, dlcAccept, dlcTransactions, i);
        cetPsbts.push(cetPsbt);
      }

      // Get our addresses to determine which inputs we can sign
      const addresses = await this.getAddresses();
      const firstAddress = addresses[0]?.address;

      if (!firstAddress) {
        throw new Error('No wallet address available for signing');
      }

      // Find which inputs belong to our wallet for funding transaction
      // Inputs are sorted by inputSerialId when creating PSBT, so we need to map correctly
      const allFundingInputs = [...dlcOffer.fundingInputs, ...dlcAccept.fundingInputs];
      allFundingInputs.sort((a, b) => Number(a.inputSerialId - b.inputSerialId));

      // Create a set of offerer input serial IDs for quick lookup
      const offererInputSerialIds = new Set(
        dlcOffer.fundingInputs.map((input) => input.inputSerialId.toString()),
      );

      // Find PSBT indexes that correspond to offerer inputs
      const ourFundingInputIndexes: number[] = [];
      allFundingInputs.forEach((input, psbtIndex) => {
        if (offererInputSerialIds.has(input.inputSerialId.toString())) {
          ourFundingInputIndexes.push(psbtIndex);
        }
      });

      // Fetch adaptor points from backend
      const calculatedAdaptorPoints = await this.getAdaptorPoints(dlcOffer, dlcAccept);

      // Build params - for single-funded DLCs, include fundingTransaction but with empty signInputs
      // This tells Fordefi the PSBT structure without requiring any signatures from this vault
      const hasFundingInputsToSign = ourFundingInputIndexes.length > 0;

      const params = {
        fundingTransaction: {
          psbt: fundingPsbt.toBase64(),
          // For single-funded DLCs: pass empty signInputs object (not undefined)
          // This indicates the vault doesn't need to sign any inputs in the funding tx
          signInputs: hasFundingInputsToSign ? { [firstAddress]: ourFundingInputIndexes } : {},
        },
        refundTransaction: {
          psbt: refundPsbt.toBase64(),
          signInputs: {
            [firstAddress]: [0], // Sign the funding input in refund transaction
          },
        },
        cetTransactions: cetPsbts.map((cetPsbt, index) => ({
          psbt: cetPsbt.toBase64(),
          adaptorPoint:
            calculatedAdaptorPoints[Math.min(index, calculatedAdaptorPoints.length - 1)],
        })),
      };

      // Use the new dlc_signOffer method for unified signing
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment
      const signResponse = (await (this.wallet.request as any)(
        'dlc_signOffer',
        params,
      )) as SatsConnectResponse<SignDlcResult>;

      if (signResponse.status === 'error') {
        throw new Error(
          `Failed to sign DLC transactions: ${signResponse.error?.message ?? 'Unknown error'}`,
        );
      }

      // Extract signatures from the response
      if (!signResponse.result) {
        throw new Error('No result in sign response');
      }

      const signResult = signResponse.result;

      // Extract funding transaction signatures
      // SatsConnect returns PSBTs as base64 strings
      const signedFundingPsbt = Psbt.fromBase64(signResult.fundingTransaction);
      const fundingSignatures = new FundingSignatures();

      // Extract witness elements from the signed funding PSBT
      const witnessElements: ScriptWitnessV0[][] = [];
      for (const inputIndex of ourFundingInputIndexes) {
        const input = signedFundingPsbt.data.inputs[inputIndex];
        if (input?.partialSig && input.partialSig.length > 0) {
          // Extract signature from partialSig array
          const partialSig = input.partialSig[0];
          const signature = partialSig.signature;
          const publicKey = partialSig.pubkey;

          // Create ScriptWitnessV0 object for the signature
          const signatureWitness = new ScriptWitnessV0();
          signatureWitness.witness = signature;
          signatureWitness.length = signature.length;

          // Create ScriptWitnessV0 object for the public key
          const publicKeyWitness = new ScriptWitnessV0();
          publicKeyWitness.witness = publicKey;
          publicKeyWitness.length = publicKey.length;

          // Create witness element array for this input: [signature, publicKey]
          witnessElements.push([signatureWitness, publicKeyWitness]);
        }
      }

      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      fundingSignatures.witnessElements = witnessElements;
      dlcSign.fundingSignatures = fundingSignatures;

      // Extract refund transaction signature
      const signedRefundPsbt = Psbt.fromBase64(signResult.refundTransaction);
      const refundInput = signedRefundPsbt.data.inputs[0];
      if (refundInput?.partialSig && refundInput.partialSig.length > 0) {
        const partialSig = refundInput.partialSig[0];
        // Convert DER signature to compact format (64 bytes)
        const compactSignature = this.ensureCompactSignature(partialSig.signature);
        dlcSign.refundSignature = compactSignature;
      } else {
        // Fallback to placeholder if extraction fails
        dlcSign.refundSignature = Buffer.from(this.generateRandomHex(64), 'hex');
      }

      // Extract CET adaptor signatures
      const cetAdaptorSignatures = new CetAdaptorSignatures();

      // The new format returns base64-encoded adaptor signatures directly
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const cetSigs: any[] = [];

        for (let i = 0; i < signResult.cetTransactions.length; i++) {
          const base64AdaptorSig = signResult.cetTransactions[i];
          const adaptorSignature = Buffer.from(base64AdaptorSig, 'base64');

          // Fordefi returns 161-byte adaptor signatures that need reordering to secp256k1-zkp format
          if (adaptorSignature.length === 161) {
            const R = adaptorSignature.subarray(0, 33);
            const Ra = adaptorSignature.subarray(33, 66);
            const Sa = adaptorSignature.subarray(66, 98);
            const B = adaptorSignature.subarray(98, 130);
            const C = adaptorSignature.subarray(130, 162);

            // Reorder to secp256k1-zkp format: Ra, Sa, R, B, C
            const reorderedSig = Buffer.concat([Ra, Sa, R, B, C]);

            cetSigs.push({
              encryptedSig: reorderedSig,
              dleqProof: Buffer.alloc(0),
            });
          } else {
            cetSigs.push({
              encryptedSig: adaptorSignature,
              dleqProof: Buffer.alloc(0),
            });
          }
        }

        // Try to set the sigs property - this may need adjustment based on actual structure
        // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
        (cetAdaptorSignatures as any).sigs = cetSigs;
      } catch {
        // Use empty structure if extraction fails
      }

      dlcSign.cetAdaptorSignatures = cetAdaptorSignatures;

      dlcSign.validate();

      return dlcSign;
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to sign DLC accept: ${errorMessage}`);
    }
  }

  /**
   * Accept a DLC offer as accepter with 0 collateral using raw transaction data.
   * This method accepts raw transaction hexes instead of DlcTransactions serialization,
   * avoiding compatibility issues between DDK and node-dlc serialization formats.
   *
   * @param dlcOffer - The DLC offer from server
   * @param adaptorPoints - Adaptor points for CET signing
   * @param rawTxData - Raw transaction data from server
   * @return {Promise<DlcAccept>} The DLC accept message with accepter's signatures
   */
  async acceptDlcOfferWithRawTxs(
    dlcOffer: DlcOffer,
    adaptorPoints: string[],
    rawTxData: {
      fundTxHex: string;
      refundTxHex: string;
      cetHexes: string[];
      fundTxVout: number;
    },
  ): Promise<DlcAccept> {
    try {
      // Validate input
      dlcOffer.validate();

      // Get payment address for the accepter
      const paymentAddress = await this.getPaymentAddress();

      if (!paymentAddress.publicKey) {
        throw new Error('No public key available from wallet');
      }

      // Create DlcAccept with 0 collateral
      const dlcAccept = new DlcAccept();
      dlcAccept.temporaryContractId = dlcOffer.temporaryContractId;
      dlcAccept.acceptCollateral = 0n;
      dlcAccept.fundingInputs = []; // No funding inputs for 0 collateral
      dlcAccept.fundingPubkey = Buffer.from(paymentAddress.publicKey, 'hex');
      dlcAccept.payoutSpk = Buffer.from(this.addressToScriptPubKey(paymentAddress.address), 'hex');
      dlcAccept.payoutSerialId = this.generateSerialId();
      dlcAccept.changeSpk = Buffer.from(this.addressToScriptPubKey(paymentAddress.address), 'hex');
      dlcAccept.changeSerialId = this.generateSerialId();

      // Parse raw transactions
      const fundTx = btTransaction.fromHex(rawTxData.fundTxHex);
      const refundTx = btTransaction.fromHex(rawTxData.refundTxHex);
      const cets = rawTxData.cetHexes.map((hex) => btTransaction.fromHex(hex));

      // Create PSBTs for signing using raw transactions
      // Even for 0 collateral, Fordefi needs the funding PSBT for context
      const fundingPsbt = this.createFundingPsbtFromRawTx(
        dlcOffer,
        dlcAccept,
        fundTx,
        rawTxData.fundTxVout,
      );

      const refundPsbt = this.createRefundPsbtFromRawTx(
        dlcOffer,
        dlcAccept,
        fundTx,
        refundTx,
        rawTxData.fundTxVout,
      );

      // Create CET PSBTs
      const cetPsbts: Psbt[] = [];
      for (let i = 0; i < cets.length; i++) {
        const cetPsbt = this.createCetPsbtFromRawTx(
          dlcOffer,
          dlcAccept,
          fundTx,
          cets[i],
          rawTxData.fundTxVout,
        );
        cetPsbts.push(cetPsbt);
      }

      // Call Fordefi to sign
      // Pass funding PSBT for context but with empty signInputs (0 collateral = no inputs to sign)
      const params = {
        fundingTransaction: {
          psbt: fundingPsbt.toBase64(),
          signInputs: {}, // Empty - accepter has no inputs to sign in funding tx
        },
        refundTransaction: {
          psbt: refundPsbt.toBase64(),
          signInputs: {
            [paymentAddress.address]: [0], // Sign the funding input in refund transaction
          },
        },
        cetTransactions: cetPsbts.map((cetPsbt, index) => ({
          psbt: cetPsbt.toBase64(),
          adaptorPoint: adaptorPoints[Math.min(index, adaptorPoints.length - 1)],
        })),
      };

      // Use the dlc_signOffer method
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment
      const signResponse = (await (this.wallet.request as any)(
        'dlc_signOffer',
        params,
      )) as SatsConnectResponse<SignDlcResult>;

      if (signResponse.status === 'error') {
        throw new Error(
          `Failed to sign DLC transactions: ${signResponse.error?.message ?? 'Unknown error'}`,
        );
      }

      if (!signResponse.result) {
        throw new Error('No result in sign response');
      }

      const signResult = signResponse.result;

      // Extract refund signature from signed PSBT
      const signedRefundPsbt = Psbt.fromBase64(signResult.refundTransaction);
      const refundInput = signedRefundPsbt.data.inputs[0];

      if (refundInput?.partialSig && refundInput.partialSig.length > 0) {
        const partialSig = refundInput.partialSig[0];
        // Convert DER signature to compact format (64 bytes)
        const compactSignature = this.ensureCompactSignature(partialSig.signature);
        dlcAccept.refundSignature = compactSignature;
      } else {
        throw new Error('No refund signature in response');
      }

      // Extract CET adaptor signatures
      const cetAdaptorSignatures = new CetAdaptorSignatures();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cetSigs: any[] = [];

      for (let i = 0; i < signResult.cetTransactions.length; i++) {
        const base64AdaptorSig = signResult.cetTransactions[i];
        const adaptorSignature = Buffer.from(base64AdaptorSig, 'base64');

        // Fordefi returns 161-byte adaptor signatures that need reordering
        if (adaptorSignature.length === 161) {
          const R = adaptorSignature.subarray(0, 33);
          const Ra = adaptorSignature.subarray(33, 66);
          const Sa = adaptorSignature.subarray(66, 98);
          const B = adaptorSignature.subarray(98, 130);
          const C = adaptorSignature.subarray(130, 161);

          // Pad C to 32 bytes if needed
          const paddedC = C.length < 32 ? Buffer.concat([Buffer.alloc(32 - C.length), C]) : C;

          // Reorder to secp256k1-zkp format
          const reorderedSig = Buffer.concat([Ra, Sa, R, B, paddedC]);

          cetSigs.push({
            encryptedSig: reorderedSig,
            dleqProof: Buffer.alloc(0),
          });
        } else if (adaptorSignature.length === 162) {
          cetSigs.push({
            encryptedSig: adaptorSignature,
            dleqProof: Buffer.alloc(0),
          });
        } else {
          console.warn(`Unexpected adaptor signature length: ${adaptorSignature.length}`);
          cetSigs.push({
            encryptedSig: adaptorSignature,
            dleqProof: Buffer.alloc(0),
          });
        }
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
      (cetAdaptorSignatures as any).sigs = cetSigs;
      dlcAccept.cetAdaptorSignatures = cetAdaptorSignatures;

      // Validate the accept message
      dlcAccept.validate();

      return dlcAccept;
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to accept DLC offer: ${errorMessage}`);
    }
  }

  /**
   * Create funding PSBT from raw transaction data
   * Used to provide context to Fordefi even when accepter has 0 collateral
   */
  private createFundingPsbtFromRawTx(
    dlcOffer: DlcOffer,
    _dlcAccept: DlcAccept,
    fundTx: btTransaction,
    _fundTxVout: number,
  ): Psbt {
    const fundingPsbt = new Psbt({ network: this.network });

    // Add all inputs from the funding transaction
    // For offerer-funded DLC, all inputs come from the offerer
    for (let i = 0; i < fundTx.ins.length; i++) {
      const input = fundTx.ins[i];

      // Find the corresponding funding input from the offer to get witnessUtxo
      const fundingInput = dlcOffer.fundingInputs[i];
      if (fundingInput) {
        const prevOut = fundingInput.prevTx.outputs[fundingInput.prevTxVout];
        const witnessUtxo = {
          script: Buffer.from(prevOut.scriptPubKey.serialize().subarray(1)),
          value: Number(prevOut.value.sats),
        };

        fundingPsbt.addInput({
          hash: input.hash,
          index: input.index,
          sequence: input.sequence,
          witnessUtxo,
        });
      } else {
        // Fallback: add input without witnessUtxo (shouldn't happen for valid DLC)
        fundingPsbt.addInput({
          hash: input.hash,
          index: input.index,
          sequence: input.sequence,
        });
      }
    }

    // Add all outputs from the funding transaction
    for (let i = 0; i < fundTx.outs.length; i++) {
      const output = fundTx.outs[i];
      const addr = this.scriptPubKeyToAddress(output.script);
      fundingPsbt.addOutput({
        address: addr,
        value: output.value,
      });
    }

    // Set locktime
    fundingPsbt.setLocktime(fundTx.locktime);

    return fundingPsbt;
  }

  /**
   * Create refund PSBT from raw transaction data
   */
  private createRefundPsbtFromRawTx(
    dlcOffer: DlcOffer,
    dlcAccept: DlcAccept,
    fundTx: btTransaction,
    refundTx: btTransaction,
    fundTxVout: number,
  ): Psbt {
    const refundPsbt = new Psbt({ network: this.network });

    // Create the funding script (2-of-2 multisig)
    const fundingPubKeys =
      Buffer.compare(dlcOffer.fundingPubkey, dlcAccept.fundingPubkey) === -1
        ? [dlcOffer.fundingPubkey, dlcAccept.fundingPubkey]
        : [dlcAccept.fundingPubkey, dlcOffer.fundingPubkey];

    const p2ms = payments.p2ms({
      m: 2,
      pubkeys: fundingPubKeys,
      network: this.network,
    });

    const paymentVariant = payments.p2wsh({
      redeem: p2ms,
      network: this.network,
    });

    // Get the actual funding output value
    const actualFundingOutputValue = fundTx.outs[fundTxVout].value;

    // Use the input hash from the refund transaction
    const rawRefundInputHash = refundTx.ins[0].hash;
    const rawRefundInputIndex = refundTx.ins[0].index;

    // Add the funding input
    refundPsbt.addInput({
      hash: rawRefundInputHash,
      index: rawRefundInputIndex,
      sequence: refundTx.ins[0].sequence,
      witnessUtxo: {
        script: paymentVariant.output!,
        value: actualFundingOutputValue,
      },
      witnessScript: paymentVariant.redeem!.output,
    });

    // Add refund outputs
    for (let i = 0; i < refundTx.outs.length; i++) {
      const output = refundTx.outs[i];
      const addr = this.scriptPubKeyToAddress(output.script);
      refundPsbt.addOutput({
        address: addr,
        value: output.value,
      });
    }

    // Set locktime
    refundPsbt.setLocktime(refundTx.locktime);

    return refundPsbt;
  }

  /**
   * Create CET PSBT from raw transaction data
   */
  private createCetPsbtFromRawTx(
    dlcOffer: DlcOffer,
    dlcAccept: DlcAccept,
    fundTx: btTransaction,
    cetTx: btTransaction,
    fundTxVout: number,
  ): Psbt {
    const cetPsbt = new Psbt({ network: this.network });

    // Create the funding script (2-of-2 multisig)
    const fundingPubKeys =
      Buffer.compare(dlcOffer.fundingPubkey, dlcAccept.fundingPubkey) === -1
        ? [dlcOffer.fundingPubkey, dlcAccept.fundingPubkey]
        : [dlcAccept.fundingPubkey, dlcOffer.fundingPubkey];

    const p2ms = payments.p2ms({
      m: 2,
      pubkeys: fundingPubKeys,
      network: this.network,
    });

    const paymentVariant = payments.p2wsh({
      redeem: p2ms,
      network: this.network,
    });

    // Get the actual funding output value
    const actualFundingOutputValue = fundTx.outs[fundTxVout].value;

    // Use the input hash from the CET transaction
    const rawCetInputHash = cetTx.ins[0].hash;
    const rawCetInputIndex = cetTx.ins[0].index;

    // Add the funding input
    cetPsbt.addInput({
      hash: rawCetInputHash,
      index: rawCetInputIndex,
      sequence: cetTx.ins[0].sequence,
      witnessUtxo: {
        script: paymentVariant.output!,
        value: actualFundingOutputValue,
      },
      witnessScript: paymentVariant.redeem!.output,
    });

    // Add CET outputs
    for (let i = 0; i < cetTx.outs.length; i++) {
      const output = cetTx.outs[i];
      const addr = this.scriptPubKeyToAddress(output.script);
      cetPsbt.addOutput({
        address: addr,
        value: output.value,
      });
    }

    // Set locktime if present
    if (cetTx.locktime) {
      cetPsbt.setLocktime(cetTx.locktime);
    }

    return cetPsbt;
  }

  /**
   * Detect if signature is in DER format and convert to compact format (64 bytes)
   * by extracting r and s values, removing SIGHASH flag if present
   */
  private ensureCompactSignature(signature: Buffer): Buffer {
    // If signature is already 64 bytes, it's likely already compact format
    if (signature.length === 64) {
      return signature;
    }

    // Check if it's DER format (starts with 0x30)
    if (signature.length > 6 && signature[0] === 0x30) {
      let derSig = signature;

      // Remove SIGHASH flag if present (last byte is typically 0x01 for SIGHASH_ALL)
      if (signature[signature.length - 1] === 0x01) {
        derSig = signature.slice(0, -1);
      }

      // Parse DER format: 0x30 [total-length] 0x02 [R-length] [R] 0x02 [S-length] [S]
      if (derSig[0] !== 0x30) {
        throw new Error('Invalid DER signature: missing SEQUENCE tag');
      }

      const totalLength = derSig[1];
      if (derSig.length < totalLength + 2) {
        throw new Error('Invalid DER signature: length mismatch');
      }

      let offset = 2;

      // Parse R value
      if (derSig[offset] !== 0x02) {
        throw new Error('Invalid DER signature: missing INTEGER tag for R');
      }
      offset++;

      const rLength = derSig[offset];
      offset++;

      if (offset + rLength > derSig.length) {
        throw new Error('Invalid DER signature: R length exceeds signature length');
      }

      let rBytes = derSig.slice(offset, offset + rLength);
      offset += rLength;

      // Parse S value
      if (derSig[offset] !== 0x02) {
        throw new Error('Invalid DER signature: missing INTEGER tag for S');
      }
      offset++;

      const sLength = derSig[offset];
      offset++;

      if (offset + sLength > derSig.length) {
        throw new Error('Invalid DER signature: S length exceeds signature length');
      }

      let sBytes = derSig.slice(offset, offset + sLength);

      // Remove leading zero padding from r and s (DER may pad to prevent negative interpretation)
      while (rBytes.length > 1 && rBytes[0] === 0x00) {
        rBytes = rBytes.slice(1);
      }
      while (sBytes.length > 1 && sBytes[0] === 0x00) {
        sBytes = sBytes.slice(1);
      }

      // Pad to 32 bytes each (compact format requires exactly 32 bytes for r and s)
      while (rBytes.length < 32) {
        rBytes = Buffer.concat([Buffer.from([0x00]), rBytes]);
      }
      while (sBytes.length < 32) {
        sBytes = Buffer.concat([Buffer.from([0x00]), sBytes]);
      }

      if (rBytes.length !== 32 || sBytes.length !== 32) {
        throw new Error('Invalid signature values: r or s exceeds 32 bytes');
      }

      // Combine r and s into 64-byte compact format
      return Buffer.concat([rBytes, sBytes]);
    }

    // For other formats, throw error as we can't convert
    throw new Error('Unable to convert signature to compact format: unknown format');
  }

  /**
   * Get adaptor points from backend using DDK calculation
   * @param dlcOffer - The DLC offer containing oracle information
   * @return {Promise<string[]>} Array of adaptor points as base64 strings
   */
  async getAdaptorPoints(dlcOffer: DlcOffer, dlcAccept: DlcAccept): Promise<string[]> {
    try {
      const response = await fetch('http://localhost:3005/api/dlc/adaptor-points', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          dlcOfferHex: dlcOffer.serialize().toString('hex'),
          dlcAcceptHex: dlcAccept.serialize().toString('hex'),
        }),
      });

      if (!response.ok) {
        const errorData = (await response.json()) as { error: string; details?: string };
        throw new Error(`Backend error: ${errorData.error} - ${errorData.details ?? ''}`);
      }

      const result = (await response.json()) as { adaptorPoints: string[]; success: boolean };

      return result.adaptorPoints;
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to get adaptor points from backend: ${errorMessage}`);
    }
  }

  /**
   * Create refund PSBT for SatsConnect signing (following DDK pattern)
   * @param dlcOffer - The DLC offer
   * @param dlcAccept - The DLC accept message
   * @param dlcTransactions - The DLC transactions
   * @return {Psbt} The refund PSBT ready for signing
   */
  private createRefundPsbt(
    dlcOffer: DlcOffer,
    dlcAccept: DlcAccept,
    dlcTransactions: DlcTransactions,
  ): Psbt {
    const transaction = btTransaction.fromBuffer(dlcTransactions.refundTx.serialize());
    const refundPsbt = new Psbt({ network: this.network });

    // Verify refund transaction locktime matches expected
    if (Number(dlcTransactions.refundTx.locktime) !== dlcOffer.refundLocktime) {
      throw new Error(
        `Refund transaction locktime ${dlcTransactions.refundTx.locktime.toString()} does not match expected ${dlcOffer.refundLocktime.toString()}`,
      );
    }

    // Create the funding script (2-of-2 multisig)
    const fundingPubKeys =
      Buffer.compare(dlcOffer.fundingPubkey, dlcAccept.fundingPubkey) === -1
        ? [dlcOffer.fundingPubkey, dlcAccept.fundingPubkey]
        : [dlcAccept.fundingPubkey, dlcOffer.fundingPubkey];

    const p2ms = payments.p2ms({
      m: 2,
      pubkeys: fundingPubKeys,
      network: this.network,
    });

    const paymentVariant = payments.p2wsh({
      redeem: p2ms,
      network: this.network,
    });

    // Get the actual funding output value from the funding transaction
    const fundingTransaction = btTransaction.fromBuffer(dlcTransactions.fundTx.serialize());
    const actualFundingOutputValue = fundingTransaction.outs[dlcTransactions.fundTxVout].value;

    // Use the input hash directly from the raw refund transaction
    const rawRefundInputHash = transaction.ins[0].hash;
    const rawRefundInputIndex = transaction.ins[0].index;

    // Add the funding input
    refundPsbt.addInput({
      hash: rawRefundInputHash,
      index: rawRefundInputIndex,
      sequence: Number(dlcTransactions.refundTx.inputs[0].sequence),
      witnessUtxo: {
        script: paymentVariant.output!,
        value: actualFundingOutputValue,
      },
      witnessScript: paymentVariant.redeem!.output,
    });

    // Add refund outputs
    for (let i = 0; i < transaction.outs.length; i++) {
      const output = transaction.outs[i];
      const addr = this.scriptPubKeyToAddress(output.script);
      refundPsbt.addOutput({
        address: addr,
        value: output.value,
      });
    }

    // Set locktime
    refundPsbt.setLocktime(Number(dlcTransactions.refundTx.locktime));

    return refundPsbt;
  }

  /**
   * Create funding PSBT for SatsConnect signing (following DDK CreateFundingSigsAlt pattern)
   * @param dlcOffer - The DLC offer
   * @param dlcAccept - The DLC accept message
   * @param dlcTransactions - The DLC transactions
   * @return {Psbt} The funding PSBT ready for signing
   */
  private createFundingPsbt(
    dlcOffer: DlcOffer,
    dlcAccept: DlcAccept,
    dlcTransactions: DlcTransactions,
  ): Psbt {
    // Use the exact same pattern as DDK's CreateFundingSigsAlt
    const transaction = btTransaction.fromBuffer(Buffer.from(dlcTransactions.fundTx.serialize()));
    const fundingPsbt = new Psbt({ network: this.network });

    // Combine all funding inputs from both parties (same as DDK)
    const allFundingInputs = [...dlcOffer.fundingInputs, ...dlcAccept.fundingInputs];

    // Sort by inputSerialId to reconstruct proper transaction order (same as DDK)
    allFundingInputs.sort((a, b) => Number(a.inputSerialId - b.inputSerialId));

    // Add all inputs to PSBT with proper witnessUtxo (exactly like DDK)
    for (const fundingInput of allFundingInputs) {
      const prevOut = fundingInput.prevTx.outputs[fundingInput.prevTxVout];

      // Use the same pattern as DDK - slice(1) to remove length prefix
      const witnessUtxo = {
        script: Buffer.from(prevOut.scriptPubKey.serialize().subarray(1)),
        value: Number(prevOut.value.sats),
      };

      // Use sequence from the original transaction to ensure consistency (exactly like DDK)
      const originalInput = transaction.ins.find(
        (input) =>
          input.hash.reverse().toString('hex') === fundingInput.prevTx.txId.toString() &&
          input.index === fundingInput.prevTxVout,
      );
      const sequenceValue = originalInput ? originalInput.sequence : Number(fundingInput.sequence);

      fundingPsbt.addInput({
        hash: fundingInput.prevTx.txId.toString(),
        index: fundingInput.prevTxVout,
        sequence: sequenceValue,
        witnessUtxo,
      });
    }

    // Add all outputs to PSBT (maintains transaction structure) - exactly like DDK
    for (const output of transaction.outs) {
      fundingPsbt.addOutput({
        address: this.scriptPubKeyToAddress(Buffer.from(output.script)),
        value: output.value,
      });
    }

    // Set locktime
    fundingPsbt.setLocktime(transaction.locktime);

    return fundingPsbt;
  }

  /**
   * Sign a CET for execution using Fordefi's signPsbt
   * Returns the ECDSA signature that can be combined with the server's decrypted adaptor sig
   *
   * @param dlcOffer - The DLC offer
   * @param dlcAccept - The DLC accept message
   * @param dlcTransactions - The DLC transactions
   * @param outcomeIndex - Index of the CET to sign (based on oracle outcome)
   * @return {Promise<Buffer>} The ECDSA signature (DER format, ~71 bytes)
   */
  async signCetForExecution(
    dlcOffer: DlcOffer,
    dlcAccept: DlcAccept,
    dlcTransactions: DlcTransactions,
    outcomeIndex: number,
  ): Promise<Buffer> {
    // Create CET PSBT
    const cetPsbt = this.createCetPsbt(dlcOffer, dlcAccept, dlcTransactions, outcomeIndex);

    // Get payment address for signing
    const paymentAddress = await this.getPaymentAddress();

    // Call Fordefi signPsbt
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call
    const signResponse = (await (this.wallet.request as any)('signPsbt', {
      psbt: cetPsbt.toBase64(),
      signInputs: {
        [paymentAddress.address]: [0],
      },
    })) as SatsConnectResponse<{ psbt: string }>;

    if (signResponse.status === 'error') {
      throw new Error(`Failed to sign CET: ${signResponse.error?.message ?? 'Unknown error'}`);
    }

    if (!signResponse.result?.psbt) {
      throw new Error('No signed PSBT in response');
    }

    // Extract signature from signed PSBT
    const signedPsbt = Psbt.fromBase64(signResponse.result.psbt);
    const input = signedPsbt.data.inputs[0];

    if (!input?.partialSig || input.partialSig.length === 0) {
      throw new Error('No signature found in signed PSBT');
    }

    const signature = input.partialSig[0].signature;

    // Return the DER signature (without sighash byte if present)
    let derSig = signature;
    if (signature.length === 72 || signature.length === 73) {
      derSig = signature.subarray(0, signature.length - 1);
    }

    return derSig;
  }

  /**
   * Create CET PSBT for SatsConnect signing
   * @param dlcOffer - The DLC offer
   * @param dlcAccept - The DLC accept message
   * @param dlcTransactions - The DLC transactions
   * @param cetIndex - Index of the CET to create PSBT for
   * @return {Psbt} The CET PSBT ready for signing
   */
  private createCetPsbt(
    dlcOffer: DlcOffer,
    dlcAccept: DlcAccept,
    dlcTransactions: DlcTransactions,
    cetIndex: number,
  ): Psbt {
    if (!dlcTransactions.cets || cetIndex >= dlcTransactions.cets.length) {
      throw new Error(`CET at index ${cetIndex} not found in DLC transactions`);
    }

    const cetTransaction = dlcTransactions.cets[cetIndex];
    const transaction = btTransaction.fromBuffer(cetTransaction.serialize());
    const cetPsbt = new Psbt({ network: this.network });

    // Create the funding script (2-of-2 multisig) - same as refund
    const fundingPubKeys =
      Buffer.compare(dlcOffer.fundingPubkey, dlcAccept.fundingPubkey) === -1
        ? [dlcOffer.fundingPubkey, dlcAccept.fundingPubkey]
        : [dlcAccept.fundingPubkey, dlcOffer.fundingPubkey];

    const p2ms = payments.p2ms({
      m: 2,
      pubkeys: fundingPubKeys,
      network: this.network,
    });

    const paymentVariant = payments.p2wsh({
      redeem: p2ms,
      network: this.network,
    });

    // Get the actual funding output value from the funding transaction
    const fundingTransaction = btTransaction.fromBuffer(dlcTransactions.fundTx.serialize());
    const actualFundingOutputValue = fundingTransaction.outs[dlcTransactions.fundTxVout].value;

    // Use the input hash directly from the raw CET transaction
    const rawCetInputHash = transaction.ins[0].hash;
    const rawCetInputIndex = transaction.ins[0].index;

    // Add the funding input
    cetPsbt.addInput({
      hash: rawCetInputHash,
      index: rawCetInputIndex,
      sequence: Number(cetTransaction.inputs[0].sequence),
      witnessUtxo: {
        script: paymentVariant.output!,
        value: actualFundingOutputValue,
      },
      witnessScript: paymentVariant.redeem!.output,
    });

    // Add CET outputs
    for (let i = 0; i < transaction.outs.length; i++) {
      const output = transaction.outs[i];
      const addr = this.scriptPubKeyToAddress(output.script);
      cetPsbt.addOutput({
        address: addr,
        value: output.value,
      });
    }

    // Set locktime if present
    if (cetTransaction.locktime) {
      cetPsbt.setLocktime(Number(cetTransaction.locktime));
    }

    return cetPsbt;
  }
}
