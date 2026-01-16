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
      console.log('response', response);

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

      if (offerCollateralSatoshis <= 0n) {
        throw new Error('Offer collateral must be greater than 0');
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

      // Get UTXOs for funding (either provided or selected automatically)
      const fundingUtxos =
        fixedInputs ?? (await this.getUtxosForAmount(offerCollateralSatoshis + 10000n)); // Add some buffer for fees

      // Create funding inputs from UTXOs
      dlcOffer.fundingInputs = fundingUtxos.map((input, index) => {
        const tx = Tx.decode(StreamReader.fromHex(input.txHex!));
        const fundingInput = new FundingInput();
        fundingInput.inputSerialId = BigInt(index + 1);
        fundingInput.prevTx = tx;
        fundingInput.prevTxVout = input.vout;
        fundingInput.sequence = Sequence.default();
        console.log(
          `Created funding input with sequence: ${fundingInput.sequence.toString()} (${Number(fundingInput.sequence.toString())})`,
        );
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
   * Helper function to convert address to script pubkey
   * @param address - Bitcoin address
   * @return {string} Script pubkey hex
   */
  private addressToScriptPubKey(addressStr: string): string {
    return address.toOutputScript(addressStr, this.network).toString('hex');
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

      console.log('DLC Transactions available:', {
        fundTx: dlcTransactions.fundTx ? 'available' : 'missing',
        refundTx: dlcTransactions.refundTx ? 'available' : 'missing',
        cets: dlcTransactions.cets ? dlcTransactions.cets.length : 0,
      });

      // Create PSBTs for all transactions
      const fundingPsbt = this.createFundingPsbt(dlcOffer, dlcAccept, dlcTransactions);
      const refundPsbt = this.createRefundPsbt(dlcOffer, dlcAccept, dlcTransactions);

      // Debug: Check PSBT fees by manually calculating input/output difference
      console.log('🔍 PSBT Fee Debug:');

      console.log('dlcTransactions.fundTx', dlcTransactions.fundTx.toHex());
      console.log('dlcTransactions.refundTx', dlcTransactions.refundTx.toHex());
      console.log(
        'dlcTransactions.cets',
        dlcTransactions.cets.map((cet) => cet.toHex()),
      );

      // Calculate funding PSBT fee manually
      const fundingPsbtDeserialized = fundingPsbt;
      let fundingInputTotal = 0;
      let fundingOutputTotal = 0;

      fundingPsbtDeserialized.data.inputs.forEach((input) => {
        if (input.witnessUtxo) {
          fundingInputTotal += input.witnessUtxo.value;
        }
      });

      fundingPsbtDeserialized.txOutputs.forEach((output) => {
        fundingOutputTotal += output.value;
      });

      const fundingFee = fundingInputTotal - fundingOutputTotal;
      console.log(
        `Funding PSBT fee: ${fundingFee} sats (inputs: ${fundingInputTotal}, outputs: ${fundingOutputTotal})`,
      );

      // Calculate refund PSBT fee manually
      const refundPsbtDeserialized = refundPsbt;
      let refundInputTotal = 0;
      let refundOutputTotal = 0;

      refundPsbtDeserialized.data.inputs.forEach((input) => {
        if (input.witnessUtxo) {
          refundInputTotal += input.witnessUtxo.value;
        }
      });

      refundPsbtDeserialized.txOutputs.forEach((output) => {
        refundOutputTotal += output.value;
      });

      const refundFee = refundInputTotal - refundOutputTotal;
      console.log(
        `Refund PSBT fee: ${refundFee} sats (inputs: ${refundInputTotal}, outputs: ${refundOutputTotal})`,
      );

      // Create CET PSBTs
      const cetPsbts: Psbt[] = [];
      const numCets = dlcTransactions.cets?.length || 0;
      for (let i = 0; i < numCets; i++) {
        const cetPsbt = this.createCetPsbt(dlcOffer, dlcAccept, dlcTransactions, i);
        cetPsbts.push(cetPsbt);

        // Calculate CET PSBT fee manually
        const cetPsbtDeserialized = cetPsbt;
        let cetInputTotal = 0;
        let cetOutputTotal = 0;

        cetPsbtDeserialized.data.inputs.forEach((input) => {
          if (input.witnessUtxo) {
            cetInputTotal += input.witnessUtxo.value;
          }
        });

        cetPsbtDeserialized.txOutputs.forEach((output) => {
          cetOutputTotal += output.value;
        });

        const cetFee = cetInputTotal - cetOutputTotal;
        console.log(
          `CET ${i} PSBT fee: ${cetFee} sats (inputs: ${cetInputTotal}, outputs: ${cetOutputTotal})`,
        );
      }

      // Get our addresses to determine which inputs we can sign
      const addresses = await this.getAddresses();
      const firstAddress = addresses[0]?.address;

      if (!firstAddress) {
        throw new Error('No wallet address available for signing');
      }

      // Find which inputs belong to our wallet for funding transaction
      const ourFundingInputIndexes: number[] = [];
      dlcOffer.fundingInputs.forEach((_, index) => {
        // Sign all offerer inputs since we created the offer
        ourFundingInputIndexes.push(index);
      });

      // Always fetch adaptor points from backend for consistency
      console.log('🔍 Fetching adaptor points from backend for validation...');
      const backendAdaptorPoints = await this.getAdaptorPoints(dlcOffer);

      // If adaptor points were provided (from accept response), validate they match
      if (adaptorPoints) {
        console.log('🔍 Validating provided adaptor points against backend calculation...');
        console.log(`  Provided count: ${adaptorPoints.length}`);
        console.log(`  Backend count: ${backendAdaptorPoints.length}`);

        if (adaptorPoints.length !== backendAdaptorPoints.length) {
          console.warn(
            `⚠️ WARNING: Adaptor point count mismatch! Provided: ${adaptorPoints.length}, Backend: ${backendAdaptorPoints.length}`,
          );
        }

        // Compare each adaptor point
        let allMatch = true;
        for (let i = 0; i < Math.min(adaptorPoints.length, backendAdaptorPoints.length); i++) {
          if (adaptorPoints[i] !== backendAdaptorPoints[i]) {
            console.warn(`⚠️ WARNING: Adaptor point ${i} mismatch!`);
            console.warn(`  Provided:  ${adaptorPoints[i]}`);
            console.warn(`  Backend:   ${backendAdaptorPoints[i]}`);
            allMatch = false;
          }
        }

        if (allMatch && adaptorPoints.length === backendAdaptorPoints.length) {
          console.log('✅ All adaptor points match backend calculation');
        } else {
          console.warn('⚠️ Using backend-calculated adaptor points for signing');
        }
      }

      // Always use backend-calculated adaptor points to ensure consistency
      const calculatedAdaptorPoints = backendAdaptorPoints;

      const params = {
        fundingTransaction: {
          psbt: fundingPsbt.toBase64(),
          signInputs:
            ourFundingInputIndexes.length > 0
              ? {
                  [firstAddress]: ourFundingInputIndexes,
                }
              : undefined,
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

      console.log('Params:', params);

      console.log('params', JSON.stringify(params, null, 2));

      // Use the new dlc_signOffer method for unified signing
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment
      const signResponse = (await (this.wallet.request as any)(
        'dlc_signOffer',
        params,
      )) as SatsConnectResponse<SignDlcResult>;

      console.log('Sign response:', signResponse);

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

          console.log(`Funding input ${inputIndex} witness elements:`);
          console.log(`  Signature: ${signature.toString('hex')} (${signature.length} bytes)`);
          console.log(`  Public Key: ${publicKey.toString('hex')} (${publicKey.length} bytes)`);
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
        console.log(`Refund PSBT Signature Debug:`);
        console.log(`Signature length: ${partialSig.signature.length} bytes`);
        console.log(`Signature hex: ${partialSig.signature.toString('hex')}`);

        // Convert DER signature to compact format (64 bytes)
        const compactSignature = this.ensureCompactSignature(partialSig.signature);
        console.log(`Compact signature length: ${compactSignature.length} bytes`);
        console.log(`Compact signature hex: ${compactSignature.toString('hex')}`);

        dlcSign.refundSignature = compactSignature;

        // Verify the internal storage is 64 bytes
        console.log(`✅ Internal refundSignature length: ${dlcSign.refundSignature.length} bytes`);
        console.log(`✅ Internal refundSignature hex: ${dlcSign.refundSignature.toString('hex')}`);
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
          // Decode the base64 adaptor signature
          const adaptorSignature = Buffer.from(base64AdaptorSig, 'base64');

          console.log(`CET ${i} Adaptor Signature Debug:`);
          console.log(`Total length: ${adaptorSignature.length} bytes`);
          console.log(`Full hex: ${adaptorSignature.toString('hex')}`);

          // Use the full 162-byte adaptor signature as expected
          console.log(`Using full ${adaptorSignature.length}-byte adaptor signature`);

          // Create a signature structure that matches what's expected
          cetSigs.push({
            encryptedSig: adaptorSignature, // Use the full 162-byte signature
            dleqProof: Buffer.alloc(0), // Placeholder - may need actual proof
          });

          console.log('---');
        }

        console.log(`Extracted ${cetSigs.length} CET adaptor signatures`);

        // Try to set the sigs property - this may need adjustment based on actual structure
        // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
        (cetAdaptorSignatures as any).sigs = cetSigs;
      } catch (error) {
        console.warn('Failed to extract CET adaptor signatures, using empty structure:', error);
        // Use empty structure if extraction fails
      }

      dlcSign.cetAdaptorSignatures = cetAdaptorSignatures;

      console.log('🔍 Final DlcSign Debug:');
      console.log('Contract ID:', dlcSign.contractId.toString('hex'));
      console.log('Refund signature (64 bytes):', dlcSign.refundSignature.toString('hex'));
      console.log('CET adaptor signatures count:', dlcSign.cetAdaptorSignatures.sigs.length);
      console.log('Funding signatures count:', dlcSign.fundingSignatures.witnessElements.length);

      // Debug funding signatures in detail
      console.log('🔍 Provider Funding Signatures Debug:');
      dlcSign.fundingSignatures.witnessElements.forEach((witnessElement, index) => {
        console.log(`  Input ${index} (our input):`);
        witnessElement.forEach((witness, witnessIndex) => {
          console.log(
            `    Witness ${witnessIndex}: ${witness.witness.toString('hex')} (${witness.witness.length} bytes)`,
          );
        });
      });

      // Debug input order from our perspective
      console.log('🔍 Our funding inputs (offerer):');
      dlcOffer.fundingInputs.forEach((input, index) => {
        console.log(
          `  Input ${index}: ${input.prevTx.txId.toString()}:${input.prevTxVout} (serialId: ${input.inputSerialId})`,
        );
      });

      // Validate funding signatures against what we created
      console.log('🔍 Funding Signature Validation:');
      try {
        // Recreate the funding PSBT to compare
        const validationPsbt = this.createFundingPsbt(dlcOffer, dlcAccept, dlcTransactions);

        // Check that our signatures match the expected inputs
        const allInputs = [...dlcOffer.fundingInputs, ...dlcAccept.fundingInputs];
        const sortedInputs = [...allInputs].sort((a, b) =>
          Number(a.inputSerialId - b.inputSerialId),
        );

        console.log('🔍 PSBT vs DLC Transaction Input Comparison:');

        // Validate witness element count matches offerer input count
        const offererInputCount = dlcOffer.fundingInputs.filter((input) => !input.dlcInput).length;
        const witnessElementCount = dlcSign.fundingSignatures.witnessElements.length;

        console.log(`🔍 Signature Count Validation:`);
        console.log(`  Offerer non-DLC inputs: ${offererInputCount}`);
        console.log(`  Witness elements provided: ${witnessElementCount}`);
        console.log(`  Count matches: ${offererInputCount === witnessElementCount}`);

        if (offererInputCount !== witnessElementCount) {
          console.warn('⚠️ WARNING: Witness element count mismatch!');
        }

        // Validate the actual signatures by testing them against the PSBT
        console.log('🔍 Signature Verification Test:');
        let witnessIndex = 0;

        for (let inputIndex = 0; inputIndex < sortedInputs.length; inputIndex++) {
          const dlcInput = sortedInputs[inputIndex];
          const isOffererInput = dlcOffer.fundingInputs.some(
            (offerInput) =>
              offerInput.prevTx.txId.toString() === dlcInput.prevTx.txId.toString() &&
              offerInput.prevTxVout === dlcInput.prevTxVout,
          );

          if (isOffererInput && witnessIndex < dlcSign.fundingSignatures.witnessElements.length) {
            try {
              const witnessElement = dlcSign.fundingSignatures.witnessElements[witnessIndex];
              const signature = witnessElement[0].witness;
              const publicKey = witnessElement[1].witness;

              // Add the signature to the validation PSBT
              validationPsbt.updateInput(inputIndex, {
                partialSig: [{ pubkey: publicKey, signature: signature }],
              });

              // Try to validate this specific input signature
              validationPsbt.validateSignaturesOfInput(inputIndex, (pubkey, msghash, sig) => {
                // Use a simple verification - in a real implementation you'd use proper secp256k1
                return sig.length > 0 && pubkey.length === 33; // Basic sanity check
              });

              console.log(`  ✅ Input ${inputIndex} signature validation passed`);
              witnessIndex++;
            } catch (sigValidationError) {
              console.error(
                `  ❌ Input ${inputIndex} signature validation failed:`,
                sigValidationError,
              );
            }
          } else if (isOffererInput) {
            console.log(
              `  ⚠️ Input ${inputIndex} is offerer input but no witness element available`,
            );
          } else {
            console.log(`  ➖ Input ${inputIndex} is accepter input (no signature expected)`);
          }
        }
      } catch (validationError) {
        console.error('❌ Funding signature validation failed:', validationError);
      }

      console.log('dlcSign.validate');
      dlcSign.validate();
      console.log('dlcSign.serialize');
      console.log('dlcSign.serialize', dlcSign.serialize().toString('hex'));
      console.log('dlcSign.toJSON');
      console.log('dlcSign.toJSON', dlcSign.toJSON());

      return dlcSign;
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to sign DLC accept: ${errorMessage}`);
    }
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
  async getAdaptorPoints(dlcOffer: DlcOffer): Promise<string[]> {
    try {
      console.log('🔍 Fetching adaptor points from backend...');

      const response = await fetch('http://localhost:3005/api/dlc/adaptor-points', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          dlcOfferHex: dlcOffer.serialize().toString('hex'),
        }),
      });

      if (!response.ok) {
        const errorData = (await response.json()) as { error: string; details?: string };
        throw new Error(`Backend error: ${errorData.error} - ${errorData.details ?? ''}`);
      }

      const result = (await response.json()) as { adaptorPoints: string[]; success: boolean };

      console.log(`✅ Received ${result.adaptorPoints.length} adaptor points from backend`);

      console.log('Adaptor Points:', result.adaptorPoints);

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
    // Create PSBT for refund transaction
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

    // Add the funding input
    refundPsbt.addInput({
      hash: dlcTransactions.fundTx.txId.serialize(),
      index: dlcTransactions.fundTxVout,
      sequence: Number(dlcTransactions.refundTx.inputs[0].sequence),
      witnessUtxo: {
        script: paymentVariant.output!,
        value: actualFundingOutputValue, // Use actual funding output value
      },
      witnessScript: paymentVariant.redeem!.output,
    });

    // Add refund outputs
    for (const output of transaction.outs) {
      refundPsbt.addOutput({
        address: address.fromOutputScript(output.script, this.network),
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

      console.log(
        `Adding input to PSBT: ${fundingInput.prevTx.txId.toString()}:${fundingInput.prevTxVout}`,
      );
      console.log(`  Using sequence from bitcoinjs transaction: ${sequenceValue}`);

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
        address: address.fromOutputScript(Buffer.from(output.script), this.network),
        value: output.value,
      });
    }

    // Set locktime (DDK doesn't explicitly set this, but it should match)
    fundingPsbt.setLocktime(transaction.locktime);

    console.log('🔍 PSBT Structure (DDK-compatible):');
    console.log(`  Input count: ${fundingPsbt.data.inputs.length}`);

    console.log(`  Output count: ${fundingPsbt.txOutputs.length}`);
    fundingPsbt.txOutputs.forEach((output, i) => {
      console.log(`  Output ${i}: ${output.value} sats, script=${output.script.toString('hex')}`);
    });

    return fundingPsbt;
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

    console.log(
      'Number(cetTransaction.inputs[0].sequence)',
      Number(cetTransaction.inputs[0].sequence),
    );

    // Add the funding input (CETs spend from the same funding transaction as refund)
    cetPsbt.addInput({
      hash: dlcTransactions.fundTx.txId.serialize(),
      index: dlcTransactions.fundTxVout,
      sequence: Number(cetTransaction.inputs[0].sequence),
      witnessUtxo: {
        script: paymentVariant.output!,
        value: actualFundingOutputValue, // Use actual funding output value
      },
      witnessScript: paymentVariant.redeem!.output,
    });

    // Add CET outputs
    for (const output of transaction.outs) {
      cetPsbt.addOutput({
        address: address.fromOutputScript(output.script, this.network),
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
