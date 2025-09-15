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
  EnumeratedDescriptor,
  FundingInput,
  FundingSignatures,
  SingleContractInfo,
  SingleOracleInfo,
} from '@node-dlc/messaging';
import { BitcoinNetwork, BitcoinNetworks } from 'bitcoin-network';
import { Psbt, address, Transaction as btTransaction, payments } from 'bitcoinjs-lib';
import Wallet, { AddressPurpose } from 'sats-connect';
import { createAdaptorPoint } from 'schnorr-adaptor-points';

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
    this.esploraUrl = options.esploraUrl ?? 'https://blockstream.info/testnet/api';
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
      const ordinalsAddress = await this.getOrdinalsAddress();

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
        '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f',
        'hex',
      ); // Bitcoin mainnet

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
   * Helper function to convert address to script pubkey (simplified)
   * @param address - Bitcoin address
   * @return {string} Script pubkey hex
   */
  private addressToScriptPubKey(address: string): string {
    console.log('TODO: Implement addressToScriptPubKey: ', address);
    // This is a simplified implementation
    // In a real implementation, you'd properly decode the address and create the script
    return `0014${this.generateRandomHex(20)}`; // P2WPKH script template
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
   * @return {Promise<DlcSign>} The DLC sign message
   */
  async signDlcAccept(
    dlcOffer: DlcOffer,
    dlcAccept: DlcAccept,
    dlcTransactions: DlcTransactions,
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
      dlcSign.contractId = Buffer.from(this.generateRandomHex(32), 'hex'); // Temporary - should be computed properly

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
      const fundingPsbtDeserialized = Psbt.fromBase64(fundingPsbt.toBase64());
      let fundingInputTotal = 0;
      let fundingOutputTotal = 0;

      fundingPsbtDeserialized.data.inputs.forEach((input, index) => {
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
      const refundPsbtDeserialized = Psbt.fromBase64(refundPsbt.toBase64());
      let refundInputTotal = 0;
      let refundOutputTotal = 0;

      refundPsbtDeserialized.data.inputs.forEach((input, index) => {
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
        const cetPsbtDeserialized = Psbt.fromBase64(cetPsbt.toBase64());
        let cetInputTotal = 0;
        let cetOutputTotal = 0;

        cetPsbtDeserialized.data.inputs.forEach((input, index) => {
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

      // Get adaptor points from the backend
      const adaptorPoints = this.getAdaptorPoints(dlcOffer, dlcTransactions);

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
          adaptorPoint: adaptorPoints[Math.min(index, adaptorPoints.length - 1)], // Use calculated adaptor points
        })),
      };

      console.log('Params:', params);

      // Use the new dlc_signOffer method for unified signing
      const signResponse = await this.wallet.request('dlc_signOffer' as any, params);

      console.log('Sign response:', signResponse);

      if (signResponse.status === 'error') {
        throw new Error(`Failed to sign DLC transactions: ${signResponse.error?.message}`);
      }

      // Extract signatures from the response
      // For now, create placeholder signatures - the real implementation would extract from signResponse.result
      dlcSign.refundSignature = Buffer.from(this.generateRandomHex(64), 'hex');

      const fundingSignatures = new FundingSignatures();
      fundingSignatures.witnessElements = [];
      dlcSign.fundingSignatures = fundingSignatures;

      // Create real CET adaptor signatures from the signed CETs
      const cetAdaptorSignatures = new CetAdaptorSignatures();
      // TODO: Extract actual adaptor signatures from signResponse.result.cetTransactions
      dlcSign.cetAdaptorSignatures = cetAdaptorSignatures;

      return dlcSign;
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to sign DLC accept: ${errorMessage}`);
    }
  }

  /**
   * Get adaptor points calculated in the browser
   * @param dlcOffer - The DLC offer containing oracle information
   * @param dlcTransactions - The DLC transactions containing CETs
   * @return {Promise<string[]>} Array of adaptor points as hex strings
   */
  getAdaptorPoints(dlcOffer: DlcOffer, dlcTransactions: DlcTransactions): string[] {
    const contractInfo = dlcOffer.contractInfo as SingleContractInfo;

    const singleOracleInfo = contractInfo.oracleInfo as SingleOracleInfo;
    const oracleAnnouncement = singleOracleInfo.announcement;
    const oraclePubkey = oracleAnnouncement.oraclePubkey;
    const oracleNonces = oracleAnnouncement.oracleEvent.oracleNonces;

    // Generate messages for each CET
    const contractDescriptor = contractInfo.contractDescriptor;
    const messages: Buffer[] = [];

    // EnumeratedDescriptor`
    const enumDescriptor = contractDescriptor as EnumeratedDescriptor;
    for (const outcome of enumDescriptor.outcomes) {
      // Convert outcome string to Buffer
      console.log('Outcome:', outcome);
      messages.push(Buffer.from(outcome.outcome, 'hex'));
    }

    // Calculate adaptor points using your module
    const adaptorPoints: string[] = [];

    console.log(
      'Messages:',
      messages.map((message) => message.toString('hex')),
    );
    console.log('Oracle pubkey:', oraclePubkey);
    console.log('Oracle nonces:', oracleNonces);

    for (let i = 0; i < messages.length; i++) {
      // Use your schnorr-adaptor-points module
      const adaptorPoint = createAdaptorPoint(
        [oraclePubkey], // Array of oracle public keys (Buffer)
        [messages[i]], // Array of messages (Buffer)
        [oracleNonces[i % oracleNonces.length]], // Array of R-values/nonces (Buffer)
      );

      // Convert result to hex string
      const adaptorPointHex = adaptorPoint.toString('hex');
      adaptorPoints.push(adaptorPointHex);
    }

    console.log(`✅ Calculated ${adaptorPoints.length} adaptor points in browser`);
    return adaptorPoints;
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
    const transaction = btTransaction.fromBuffer(dlcTransactions.fundTx.serialize());

    const fundingPsbt = new Psbt({ network: this.network });

    // Combine all funding inputs from both parties
    const allFundingInputs = [...dlcOffer.fundingInputs, ...dlcAccept.fundingInputs];

    // Sort by inputSerialId to reconstruct proper transaction order
    allFundingInputs.sort((a, b) => Number(a.inputSerialId - b.inputSerialId));

    // Add all inputs to PSBT with proper witnessUtxo
    for (const fundingInput of allFundingInputs) {
      const prevOut = fundingInput.prevTx.outputs[fundingInput.prevTxVout];

      // Use the same pattern as DDK - slice(1) to remove length prefix
      const witnessUtxo = {
        script: prevOut.scriptPubKey.serialize().subarray(1),
        value: Number(prevOut.value.sats),
      };

      fundingPsbt.addInput({
        hash: fundingInput.prevTx.txId.serialize().toString('hex'),
        index: fundingInput.prevTxVout,
        sequence: Number(fundingInput.sequence),
        witnessUtxo,
      });
    }

    for (const output of transaction.outs) {
      fundingPsbt.addOutput({
        address: address.fromOutputScript(output.script, this.network),
        value: output.value,
      });
    }

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
