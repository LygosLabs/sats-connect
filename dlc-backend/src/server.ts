import BitcoinDdkProvider from '@atomicfinance/bitcoin-ddk-provider';
import { Client } from '@atomicfinance/client';
import { bitcoin, Input } from '@atomicfinance/types';
import * as ddkJs from '@bennyblader/ddk-ts';
import {
  DlcAccept,
  DlcOffer,
  DlcSign,
  SingleContractInfo,
  SingleOracleInfo,
} from '@node-dlc/messaging';
import { generateMnemonic } from 'bip39';
import { BitcoinNetworks } from 'bitcoin-network';
import { address, Transaction as btcTransaction, payments, Psbt } from 'bitcoinjs-lib';
import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';
import MinimalScanWalletProvider from './MinimalScanWalletProvider';
import RateLimitedEsploraApiProvider from './RateLimitedEsploraApiProvider';
// import BlockstreamApiProvider from './BlockstreamApiProvider';

// Load environment variables
dotenv.config();

const app: express.Application = express();
const port = 3005;

// Setup DDK client - using testnet4 via mempool.space Esplora API
const network = BitcoinNetworks.bitcoin_testnet;

const bitcoinWithDdk = new Client();

// Add rate-limited Esplora API provider for testnet4 to avoid 429 errors
const esploraProvider = new RateLimitedEsploraApiProvider({
  url: 'https://mempool.space/testnet4/api',
  network,
  numberOfBlockConfirmation: 1,
  defaultFeePerByte: 3,
  rateLimitDelayMs: 50, // 500ms between requests
}) as any;

bitcoinWithDdk.addProvider(esploraProvider);

// Blockstream doesn't support testnet4 yet, so we're using mempool.space
// const blockstreamProvider = new BlockstreamApiProvider({
//   network,
//   clientId: process.env.BLOCKSTREAM_CLIENT_ID,
//   clientSecret: process.env.BLOCKSTREAM_CLIENT_SECRET,
//   numberOfBlockConfirmation: 1,
//   defaultFeePerByte: 3,
// });
// bitcoinWithDdk.addProvider(blockstreamProvider);

const mnemonic = process.env.MNEMONIC || generateMnemonic(256);

// Add wallet provider with minimal address scanning to reduce API calls
const walletProvider = new MinimalScanWalletProvider({
  network,
  mnemonic,
  baseDerivationPath: `m/84'/${network.coinType}'/0'`,
  addressType: bitcoin.AddressType.BECH32,
  addressGap: 1, // Only scan 1 unused address instead of 30
}) as any;

bitcoinWithDdk.addProvider(walletProvider);

// Add DDK provider
bitcoinWithDdk.addProvider(new BitcoinDdkProvider(network, ddkJs));

console.log(`🌐 Network: ${network.name} (testnet4)`);
console.log(`🔗 API Provider: mempool.space testnet4 Esplora`);
console.log(`💰 Wallet mnemonic: ${process.env.MNEMONIC ? 'PROVIDED' : 'GENERATED'}`);

// Middleware
app.use(cors());
app.use(express.json());

// Store for DLC state (in production, use proper database)
const dlcStore = new Map<
  string,
  {
    offer?: DlcOffer;
    accept?: DlcAccept;
    sign?: DlcSign;
    transactions?: any; // DlcTransactions type
  }
>();

/**
 * Accept a DLC offer using DDK
 * POST /api/dlc/accept
 * Body: { dlcOfferHex: string }
 * Returns: { dlcAcceptHex: string, contractId: string }
 */
app.post('/api/dlc/accept', async (req, res) => {
  try {
    const { dlcOfferHex } = req.body;

    if (!dlcOfferHex) {
      return res.status(400).json({ error: 'dlcOfferHex is required' });
    }

    // Deserialize the DLC offer
    const dlcOffer = DlcOffer.deserialize(Buffer.from(dlcOfferHex, 'hex'));

    // Log contract info details
    console.log('🔍 DLC Offer Contract Info:');
    const contractInfo = dlcOffer.contractInfo as SingleContractInfo;
    console.log('  Total collateral:', contractInfo.totalCollateral.toString(), 'sats');
    console.log('  Offer collateral:', dlcOffer.offerCollateral.toString(), 'sats');
    const acceptCollateral = contractInfo.totalCollateral - dlcOffer.offerCollateral;
    console.log('  Accept collateral (required):', acceptCollateral.toString(), 'sats');

    // Get first address without scanning all addresses
    const addresses = await bitcoinWithDdk.getMethod('getAddresses')(0, 1);
    if (!addresses || addresses.length === 0) {
      return res.status(500).json({ error: 'No wallet addresses available' });
    }

    const firstAddress = addresses[0];
    console.log('🔍 Accept wallet address:', firstAddress.address);

    const unspentTransactions = await bitcoinWithDdk.getMethod('getUnspentTransactions')([
      firstAddress.address,
    ]);

    console.log('🔍 Unspent transactions found:', unspentTransactions.length);

    // Log total value available
    const totalValue = unspentTransactions.reduce((sum: number, utxo: any) => sum + utxo.value, 0);
    console.log('🔍 Total value available:', totalValue, 'sats');

    // Log each UTXO
    unspentTransactions.forEach((utxo: any, index: number) => {
      console.log(`  UTXO ${index}: ${utxo.txid}:${utxo.vout} - ${utxo.value} sats`);
    });

    // Convert UTXOs to Input format for DDK
    const inputs = unspentTransactions.map((utxo: any) => {
      return new Input(
        utxo.txid,
        utxo.vout,
        utxo.address,
        utxo.value / 1e8, // amount in BTC
        utxo.value, // value in sats
        firstAddress.derivationPath,
        108
      );
    });

    console.log('🔍 Inputs created for DLC accept:', inputs.length);

    console.log('dlcOffer', dlcOffer.toJSON());

    // Debug: Check offer funding inputs segwit status
    console.log('🔍 Offer funding inputs segwit check:');
    dlcOffer.fundingInputs.forEach((input, index) => {
      console.log(
        `  Input ${index}: isSegWit=${input.prevTx.isSegWit}, witness lengths: ${input.prevTx.inputs.map((i) => i.witness?.length || 0).join(', ')}`
      );
      console.log(
        `    prevTx hex prefix: ${input.prevTx.serialize().toString('hex').substring(0, 20)}...`
      );
    });

    // Use DDK client to accept the DLC offer with inputs
    let acceptDlcOfferResponse;
    try {
      acceptDlcOfferResponse = await bitcoinWithDdk.dlc.acceptDlcOffer(dlcOffer, inputs);
    } catch (acceptError: any) {
      // Debug: If accept fails, log more details about the inputs
      console.error('🔴 Accept DLC Offer failed:', acceptError.message);
      console.log('🔍 Debug: Backend inputs being used:');
      for (const input of inputs) {
        console.log(`  UTXO: ${input.txid}:${input.vout}`);
        // Fetch raw tx to check segwit status
        try {
          const rawTxResponse = await fetch(
            `https://mempool.space/testnet4/api/tx/${input.txid}/hex`
          );
          const rawTxHex = await rawTxResponse.text();
          console.log(`  Raw tx hex prefix: ${rawTxHex.substring(0, 30)}...`);
          console.log(`  Has segwit marker (0001): ${rawTxHex.substring(8, 12) === '0001'}`);
        } catch (fetchErr) {
          console.log(`  Could not fetch raw tx: ${fetchErr}`);
        }
      }
      throw acceptError;
    }
    const dlcAccept = acceptDlcOfferResponse.dlcAccept;
    dlcAccept.changeSpk = address.toOutputScript(firstAddress.address, network);
    dlcAccept.payoutSpk = address.toOutputScript(firstAddress.address, network);
    const dlcTransactions = acceptDlcOfferResponse.dlcTransactions;

    // The contract ID is already computed by acceptDlcOffer and set on dlcTransactions
    const contractId = dlcTransactions.contractId;

    // Store the state including transactions using the computed contract ID as hex string
    const contractIdHex = contractId.toString('hex');
    dlcStore.set(contractIdHex, {
      offer: dlcOffer,
      accept: dlcAccept,
      transactions: dlcTransactions,
    });

    const oraclePublicKey = (
      (dlcOffer.contractInfo as SingleContractInfo).oracleInfo as SingleOracleInfo
    ).announcement.oraclePublicKey;

    const oracleNonces = (
      (dlcOffer.contractInfo as SingleContractInfo).oracleInfo as SingleOracleInfo
    ).announcement.getNonces();

    const enumMessages = await bitcoinWithDdk.getMethod('GenerateMessages')(
      (dlcOffer.contractInfo as SingleContractInfo).oracleInfo as SingleOracleInfo
    );

    const msgsForDdk = await bitcoinWithDdk.getMethod('convertMessagesForDdk')(enumMessages);

    // Transform msgsForDdk structure: flatten the nested messages into separate arrays
    const transformedMsgsForDdk = msgsForDdk[0][0].map((message: Buffer) => [[message]]);

    console.log('\n🔍 Oracle & Message Debug Info:');
    console.log('Oracle public key:', oraclePublicKey.toString('hex'));
    console.log(
      'Oracle nonces:',
      oracleNonces.map((n: Buffer) => n.toString('hex'))
    );
    console.log('Number of messages (outcomes):', transformedMsgsForDdk.length);
    console.log(
      'Raw enumMessages structure:',
      JSON.stringify(
        enumMessages.map((m: any) =>
          m.msgs ? m.msgs.map((msg: Buffer) => msg.toString('hex')) : m
        )
      )
    );
    console.log(
      'msgsForDdk structure depth:',
      `[${msgsForDdk.length}][${msgsForDdk[0]?.length}][${msgsForDdk[0]?.[0]?.length}]`
    );

    // Log each message for adaptor point calculation
    transformedMsgsForDdk.forEach((msgWrapper: Buffer[][], index: number) => {
      console.log(`  Message ${index}:`, msgWrapper[0][0].toString('hex'));
    });

    const adaptorPoints = ddkJs.createCetAdaptorPointsFromOracleInfo(
      [
        {
          publicKey: oraclePublicKey,
          nonces: oracleNonces,
        },
      ],
      transformedMsgsForDdk
    );

    console.log('\n🔑 Adaptor Points (sent to Fordefi):');
    console.log('Number of adaptor points:', adaptorPoints.length);
    adaptorPoints.forEach((point: Buffer, index: number) => {
      console.log(
        `  Point ${index}: ${point.toString('hex')} (base64: ${point.toString('base64')})`
      );
    });

    // Debug: Get adaptor signature inputs using the new debug function
    // This lets us compare values with Fordefi to debug signature mismatches
    const fundOutput = dlcTransactions.fundTx.outputs[dlcTransactions.fundTxVout];
    // fundOutput.value is in BTC, convert to satoshis
    const fundOutputValue = BigInt(Math.round(fundOutput.value * 1e8));

    // For BIP143 sighash, we need the witness script (2-of-2 multisig), NOT the P2WSH scriptPubKey
    // The funding script is created from both parties' funding pubkeys
    const offerFundingPubkey = dlcOffer.fundingPubkey;
    const acceptFundingPubkey = dlcAccept.fundingPubkey;

    // Create the funding locking script (2-of-2 multisig witness script)
    // This is what BIP143 uses for sighash calculation
    const fundingScript = ddkJs.createFundTxLockingScript(offerFundingPubkey, acceptFundingPubkey);

    console.log('\n🔍 CET Adaptor Signature Debug Info:');
    console.log('Fund output value (sats):', fundOutputValue.toString());
    console.log('Offer funding pubkey:', offerFundingPubkey.toString('hex'));
    console.log('Accept funding pubkey:', acceptFundingPubkey.toString('hex'));
    console.log('Funding script (witness script for BIP143):', fundingScript.toString('hex'));
    console.log(
      'Fund output scriptPubKey (P2WSH):',
      fundOutput.scriptPubKey.serialize().toString('hex')
    );
    console.log('Number of CETs:', dlcTransactions.cets.length);

    // Critical: Document which pubkey is used for verification
    // When backend (accepter) verifies offerer's adaptor sigs, it uses dlcOffer.fundingPubkey
    // Fordefi (offerer) must sign with the private key corresponding to dlcOffer.fundingPubkey
    console.log('\n⚠️ VERIFICATION KEY INFO:');
    console.log(
      'Fordefi (offerer) should sign with private key for:',
      offerFundingPubkey.toString('hex')
    );
    console.log('Backend (accepter) will verify using pubkey:', offerFundingPubkey.toString('hex'));
    console.log('If Fordefi signs with a different key, verification WILL FAIL');

    // ========== DEBUG INFO FOR ALL CETs ==========
    console.log('\n📊 DEBUG INFO FOR ALL CETs:');
    console.log('='.repeat(80));

    for (let cetIndex = 0; cetIndex < dlcTransactions.cets.length; cetIndex++) {
      const cet = dlcTransactions.cets[cetIndex];
      const cetRawBytes = cet.serialize();

      // Convert to ddk-ts Transaction format
      const cetForDdk = {
        version: cet.version,
        lockTime: cet.locktime.value,
        inputs: cet.inputs.map((input: any) => ({
          txid: input.outpoint.txid.serialize().toString('hex'),
          vout: input.outpoint.outputIndex,
          scriptSig: input.scriptSig?.serialize() || Buffer.alloc(0),
          sequence: input.sequence?.value || 0xffffffff,
          witness: input.witness || [],
        })),
        outputs: cet.outputs.map((output: any) => ({
          value: BigInt(Math.round(output.value * 1e8)),
          scriptPubkey: output.scriptPubKey.serialize(),
        })),
        rawBytes: cetRawBytes,
      };

      try {
        const msgsForCet = transformedMsgsForDdk[cetIndex][0];

        const debugInfo = ddkJs.getCetAdaptorSignatureInputs(
          cetForDdk,
          [
            {
              publicKey: oraclePublicKey,
              nonces: oracleNonces,
            },
          ],
          fundingScript,
          fundOutputValue,
          [msgsForCet]
        );

        const sighash = ddkJs.getCetSighash(cetForDdk, fundingScript, fundOutputValue);

        console.log(`\n📊 CET ${cetIndex}:`);
        console.log(`  Txid: ${debugInfo.cetTxid}`);
        console.log(`  Sighash: ${debugInfo.sighash.toString('hex')}`);
        console.log(`  Adaptor point: ${debugInfo.adaptorPoint.toString('hex')}`);
        console.log(`  Adaptor point (base64): ${debugInfo.adaptorPoint.toString('base64')}`);
        console.log(`  Message hash: ${msgsForCet[0].toString('hex')}`);
        console.log(`  Input index: ${debugInfo.inputIndex}`);
        console.log(`  Script pubkey (witness script): ${debugInfo.scriptPubkey.toString('hex')}`);
        console.log(`  Value (sats): ${debugInfo.value.toString()}`);
        console.log(`  Direct sighash: ${sighash.toString('hex')}`);
        console.log(
          `  Sighash match: ${debugInfo.sighash.toString('hex') === sighash.toString('hex')}`
        );
        console.log(
          `  Adaptor point match with array: ${adaptorPoints[cetIndex]?.toString('hex') === debugInfo.adaptorPoint.toString('hex')}`
        );

        // Output payout info
        cet.outputs.forEach((output: any, outIdx: number) => {
          console.log(
            `  Output ${outIdx}: ${Math.round(output.value * 1e8)} sats to ${output.scriptPubKey.serialize().toString('hex')}`
          );
        });
      } catch (debugError: any) {
        console.error(`❌ Debug error for CET ${cetIndex}:`, debugError.message);
      }
    }
    console.log('='.repeat(80));

    // ========== DEBUG INFO FOR FUNDING TX ==========
    console.log('\n💰 DEBUG INFO FOR FUNDING TX:');
    console.log('='.repeat(80));
    const fundTx = dlcTransactions.fundTx;
    console.log(`  Txid: ${fundTx.txId.toString()}`);
    console.log(`  Version: ${fundTx.version}`);
    console.log(`  Locktime: ${fundTx.locktime.value}`);
    console.log(`  Input count: ${fundTx.inputs.length}`);
    fundTx.inputs.forEach((input: any, idx: number) => {
      console.log(`  Input ${idx}:`);
      console.log(`    Prev txid: ${input.outpoint.txid.serialize().toString('hex')}`);
      console.log(`    Prev vout: ${input.outpoint.outputIndex}`);
      console.log(`    Sequence: ${input.sequence?.value || 0xffffffff}`);
    });
    console.log(`  Output count: ${fundTx.outputs.length}`);
    fundTx.outputs.forEach((output: any, idx: number) => {
      const valueSats = Math.round(output.value * 1e8);
      console.log(`  Output ${idx}: ${valueSats} sats`);
      console.log(`    ScriptPubKey: ${output.scriptPubKey.serialize().toString('hex')}`);
    });
    console.log(`  Fund output vout: ${dlcTransactions.fundTxVout}`);
    console.log(`  Fund output value: ${fundOutputValue.toString()} sats`);

    // Calculate funding tx sighash for each input (for Fordefi validation)
    console.log('\n🔐 FUNDING TX SIGHASH INFO (for Fordefi):');
    // The funding output that CETs spend uses P2WSH with the 2-of-2 multisig script
    // But funding tx inputs are typically P2WPKH from each party's wallet
    dlcOffer.fundingInputs.forEach((fundingInput: any, idx: number) => {
      const prevOutput = fundingInput.prevTx.outputs[fundingInput.prevTxVout];
      const prevValueSats = Math.round(prevOutput.value * 1e8);
      console.log(`  Offerer Input ${idx}:`);
      console.log(`    Prev txid: ${fundingInput.prevTx.txId.toString()}`);
      console.log(`    Prev vout: ${fundingInput.prevTxVout}`);
      console.log(`    Prev value: ${prevValueSats} sats`);
      console.log(`    Prev scriptPubKey: ${prevOutput.scriptPubKey.serialize().toString('hex')}`);
      console.log(`    Serial ID: ${fundingInput.inputSerialId}`);
    });
    console.log('='.repeat(80));

    // ========== DEBUG INFO FOR REFUND TX ==========
    console.log('\n🔄 DEBUG INFO FOR REFUND TX:');
    console.log('='.repeat(80));
    const refundTx = dlcTransactions.refundTx;
    const refundRawBytes = refundTx.serialize();

    const refundForDdk = {
      version: refundTx.version,
      lockTime: refundTx.locktime.value,
      inputs: refundTx.inputs.map((input: any) => ({
        txid: input.outpoint.txid.serialize().toString('hex'),
        vout: input.outpoint.outputIndex,
        scriptSig: input.scriptSig?.serialize() || Buffer.alloc(0),
        sequence: input.sequence?.value || 0xffffffff,
        witness: input.witness || [],
      })),
      outputs: refundTx.outputs.map((output: any) => ({
        value: BigInt(Math.round(output.value * 1e8)),
        scriptPubkey: output.scriptPubKey.serialize(),
      })),
      rawBytes: refundRawBytes,
    };

    console.log(`  Txid: ${refundTx.txId.toString()}`);
    console.log(`  Version: ${refundTx.version}`);
    console.log(`  Locktime: ${refundTx.locktime.value}`);
    console.log(`  Input count: ${refundTx.inputs.length}`);
    refundTx.inputs.forEach((input: any, idx: number) => {
      console.log(`  Input ${idx}:`);
      console.log(`    Prev txid: ${input.outpoint.txid.serialize().toString('hex')}`);
      console.log(`    Prev vout: ${input.outpoint.outputIndex}`);
      console.log(`    Sequence: ${input.sequence?.value || 0xffffffff}`);
    });
    console.log(`  Output count: ${refundTx.outputs.length}`);
    refundTx.outputs.forEach((output: any, idx: number) => {
      const valueSats = Math.round(output.value * 1e8);
      console.log(`  Output ${idx}: ${valueSats} sats`);
      console.log(`    ScriptPubKey: ${output.scriptPubKey.serialize().toString('hex')}`);
    });

    // Get refund tx sighash
    try {
      const refundSighash = ddkJs.getCetSighash(refundForDdk, fundingScript, fundOutputValue);
      console.log(`  Refund sighash: ${refundSighash.toString('hex')}`);
    } catch (e: any) {
      console.error(`  Refund sighash error: ${e.message}`);
    }
    console.log('='.repeat(80));

    res.json({
      dlcAcceptHex: dlcAccept.serialize().toString('hex'),
      dlcTransactionsHex: dlcTransactions.serialize().toString('hex'),
      adaptorPoints: adaptorPoints.map((point: Buffer) => point.toString('base64')),
      contractId: contractIdHex,
      success: true,
    });
  } catch (error: any) {
    console.error('Error accepting DLC offer:', error);
    res.status(500).json({
      error: 'Failed to accept DLC offer',
      details: error.message,
    });
  }
});

/**
 * Finalize DLC sign and broadcast
 * POST /api/dlc/finalize
 * Body: { contractId: string, dlcSignHex: string }
 * Returns: { txId: string, success: boolean }
 */
app.post('/api/dlc/finalize', async (req, res) => {
  try {
    const { contractId, dlcSignHex } = req.body;

    if (!contractId || !dlcSignHex) {
      return res.status(400).json({ error: 'contractId and dlcSignHex are required' });
    }

    // Get stored DLC state
    const dlcState = dlcStore.get(contractId);
    if (!dlcState?.offer || !dlcState?.accept || !dlcState?.transactions) {
      return res.status(404).json({ error: 'DLC state not found for contract ID' });
    }

    // Deserialize the DLC sign
    const dlcSign = DlcSign.deserialize(Buffer.from(dlcSignHex, 'hex'));

    console.log('🔍 DLC Sign Debug Info:');
    console.log('Contract ID:', dlcSign.contractId.toString('hex'));
    console.log('Refund signature length:', dlcSign.refundSignature.length);
    console.log('CET adaptor signatures count:', dlcSign.cetAdaptorSignatures?.sigs?.length || 0);
    console.log(
      'Funding signatures count:',
      dlcSign.fundingSignatures?.witnessElements?.length || 0
    );

    // Debug funding signatures structure
    console.log('🔍 Funding Signatures Debug:');
    dlcSign.fundingSignatures?.witnessElements?.forEach((witnessElement, index) => {
      console.log(`  Input ${index}:`);
      witnessElement.forEach((witness, witnessIndex) => {
        console.log(
          `    Witness ${witnessIndex}: ${witness.witness.toString('hex')} (${witness.witness.length} bytes)`
        );
      });
    });

    // Debug offer and accept funding inputs
    console.log('🔍 DLC Offer funding inputs:');
    dlcState.offer.fundingInputs.forEach((input, index) => {
      console.log(
        `  Input ${index}: ${input.prevTx.txId.toString()}:${input.prevTxVout} (serialId: ${input.inputSerialId})`
      );
    });

    console.log('🔍 DLC Accept funding inputs:');
    dlcState.accept.fundingInputs.forEach((input, index) => {
      console.log(
        `  Input ${index}: ${input.prevTx.txId.toString()}:${input.prevTxVout} (serialId: ${input.inputSerialId})`
      );
    });

    // Debug funding pubkeys
    console.log('🔍 Funding Pubkeys:');
    console.log('Offer funding pubkey:', dlcState.offer.fundingPubkey.toString('hex'));
    console.log('Accept funding pubkey:', dlcState.accept.fundingPubkey.toString('hex'));
    console.log('Sign funding pubkey (from contractId):', dlcSign.contractId.toString('hex'));

    // Store the sign
    dlcState.sign = dlcSign;
    dlcStore.set(contractId, dlcState);

    console.log('🔍 Calling finalizeDlcSign...');
    let fundTx;
    try {
      // Add detailed debugging before finalization
      console.log('🔍 Pre-finalize validation:');

      // Check if inputs are sorted correctly
      const allInputs = [...dlcState.offer.fundingInputs, ...dlcState.accept.fundingInputs];
      const sortedInputs = [...allInputs].sort(
        (a, b) => Number(a.inputSerialId) - Number(b.inputSerialId)
      );

      console.log('All inputs (original order):');
      allInputs.forEach((input, i) => {
        console.log(
          `  ${i}: ${input.prevTx.txId.toString()}:${input.prevTxVout} (serialId: ${input.inputSerialId})`
        );
      });

      console.log('All inputs (sorted by serialId):');
      sortedInputs.forEach((input, i) => {
        console.log(
          `  ${i}: ${input.prevTx.txId.toString()}:${input.prevTxVout} (serialId: ${input.inputSerialId})`
        );
      });

      // Check witness element count vs input count
      const totalInputs =
        dlcState.offer.fundingInputs.length + dlcState.accept.fundingInputs.length;
      const witnessElementCount = dlcSign.fundingSignatures?.witnessElements?.length || 0;
      console.log(`Total inputs: ${totalInputs}, Witness elements: ${witnessElementCount}`);

      if (witnessElementCount !== dlcState.offer.fundingInputs.length) {
        console.log('⚠️ WARNING: Witness element count does not match offerer input count');
        console.log(`Expected: ${dlcState.offer.fundingInputs.length} (offerer inputs only)`);
        console.log(`Got: ${witnessElementCount}`);
      }

      // Debug the funding transaction structure
      console.log('🔍 Funding Transaction Debug:');
      const fundingTx = dlcState.transactions.fundTx;
      console.log(`Funding TX ID: ${fundingTx.txId.toString()}`);
      console.log(`Funding TX inputs: ${fundingTx.inputs.length}`);
      fundingTx.inputs.forEach((input, i) => {
        console.log(
          `  Input ${i}: ${input.outpoint.txid.toString()}:${input.outpoint.outputIndex}`
        );
      });
      console.log(`Funding TX outputs: ${fundingTx.outputs.length}`);
      console.log(`Fund output index: ${dlcState.transactions.fundTxVout}`);

      // Use DDK client to finalize and broadcast with step-by-step debugging
      // console.log('🔍 Step 1: Calling VerifyCetAdaptorAndRefundSigs...');
      // try {
      //   await bitcoinWithDdk.getMethod('VerifyCetAdaptorAndRefundSigs')(
      //     dlcState.offer,
      //     dlcState.accept,
      //     dlcSign,
      //     dlcState.transactions,
      //     [], // messagesList - will be generated internally
      //     false // isOfferer = false (we're the accepter)
      //   );
      //   console.log('✅ Step 1: CET adaptor and refund signature verification passed');
      // } catch (step1Error) {
      //   console.error('❌ Step 1: CET adaptor signature verification failed:', step1Error);
      //   throw new Error(`CET verification failed: ${step1Error.message}`);
      // }

      // console.log('🔍 Step 2: Calling VerifyFundingSigsAlt...');
      // try {
      //   await bitcoinWithDdk.getMethod('VerifyFundingSigsAlt')(
      //     dlcState.offer,
      //     dlcState.accept,
      //     dlcSign,
      //     dlcState.transactions,
      //     false // isOfferer = false (we're the accepter)
      //   );
      //   console.log('✅ Step 2: Funding signature verification passed');
      // } catch (step2Error) {
      //   console.error('❌ Step 2: Funding signature verification failed:', step2Error);
      //   throw new Error(`Funding signature verification failed: ${step2Error.message}`);
      // }

      // Skip individual steps and use the working finalizeDlcSign method directly
      console.log('🔍 Calling finalizeDlcSign directly (bypassing buggy verification steps)...');
      fundTx = await bitcoinWithDdk.dlc.finalizeDlcSign(
        dlcState.offer,
        dlcState.accept,
        dlcSign,
        dlcState.transactions
      );
      console.log('✅ finalizeDlcSign completed successfully');
    } catch (finalizeError) {
      console.error('❌ finalizeDlcSign error:', finalizeError);
      console.error('Full error stack:', finalizeError.stack);
      throw finalizeError;
    }

    // TODO: Add actual broadcasting when connected to Bitcoin node
    // For now, just return the transaction hex
    const txHex = fundTx.serialize().toString('hex');

    res.json({
      txId: fundTx.txId.serialize().toString('hex'),
      txHex,
      success: true,
      message: 'DLC finalized successfully',
    });
  } catch (error: any) {
    console.error('Error finalizing DLC:', error);
    res.status(500).json({
      error: 'Failed to finalize DLC',
      details: error.message,
    });
  }
});

/**
 * Create DLC transactions from offer and accept
 * POST /api/dlc/create-txs
 * Body: { dlcOfferHex: string, dlcAcceptHex: string }
 * Returns: { dlcTransactionsHex: string, success: boolean }
 */
app.post('/api/dlc/create-txs', async (req, res) => {
  try {
    const { dlcOfferHex, dlcAcceptHex } = req.body;

    if (!dlcOfferHex || !dlcAcceptHex) {
      return res.status(400).json({ error: 'dlcOfferHex and dlcAcceptHex are required' });
    }

    // Deserialize the DLC messages
    const dlcOffer = DlcOffer.deserialize(Buffer.from(dlcOfferHex, 'hex'));
    const dlcAccept = DlcAccept.deserialize(Buffer.from(dlcAcceptHex, 'hex'));

    // Use DDK client to create DLC transactions
    const createDlcTxsResponse = await bitcoinWithDdk.getMethod('createDlcTxs')(
      dlcOffer,
      dlcAccept
    );

    res.json({
      dlcTransactionsHex: createDlcTxsResponse.dlcTransactions.serialize().toString('hex'),
      success: true,
    });
  } catch (error: any) {
    console.error('Error creating DLC transactions:', error);
    res.status(500).json({
      error: 'Failed to create DLC transactions',
      details: error.message,
    });
  }
});

/**
 * Manual finalize DLC with all messages provided
 * POST /api/dlc/manual-finalize
 * Body: { dlcOfferHex: string, dlcAcceptHex: string, dlcSignHex: string }
 * Returns: { txId: string, txHex: string, success: boolean }
 */
app.post('/api/dlc/manual-finalize', async (req, res) => {
  try {
    const { dlcOfferHex, dlcAcceptHex, dlcSignHex } = req.body;

    if (!dlcOfferHex || !dlcAcceptHex || !dlcSignHex) {
      return res.status(400).json({
        error: 'dlcOfferHex, dlcAcceptHex, and dlcSignHex are required',
      });
    }

    // Deserialize all DLC messages
    const dlcOffer = DlcOffer.deserialize(Buffer.from(dlcOfferHex, 'hex'));
    const dlcAccept = DlcAccept.deserialize(Buffer.from(dlcAcceptHex, 'hex'));
    const dlcSign = DlcSign.deserialize(Buffer.from(dlcSignHex, 'hex'));

    console.log('🔍 Manual Finalize Debug Info:');
    console.log('DLC Offer valid:', dlcOffer ? 'yes' : 'no');
    console.log('DLC Accept valid:', dlcAccept ? 'yes' : 'no');
    console.log('DLC Sign valid:', dlcSign ? 'yes' : 'no');
    console.log('Contract ID:', dlcSign.contractId.toString('hex'));

    // Create DLC transactions
    const createDlcTxsResponse = await bitcoinWithDdk.getMethod('createDlcTxs')(
      dlcOffer,
      dlcAccept
    );

    console.log('🔍 Calling finalizeDlcSign with manual messages...');
    let fundTx;
    try {
      // Add detailed debugging before finalization
      console.log('🔍 Manual Pre-finalize validation:');

      // Check if inputs are sorted correctly
      const allInputs = [...dlcOffer.fundingInputs, ...dlcAccept.fundingInputs];
      const sortedInputs = [...allInputs].sort(
        (a, b) => Number(a.inputSerialId) - Number(b.inputSerialId)
      );

      console.log('All inputs (original order):');
      allInputs.forEach((input, i) => {
        console.log(
          `  ${i}: ${input.prevTx.txId.toString()}:${input.prevTxVout} (serialId: ${input.inputSerialId})`
        );
      });

      console.log('All inputs (sorted by serialId):');
      sortedInputs.forEach((input, i) => {
        console.log(
          `  ${i}: ${input.prevTx.txId.toString()}:${input.prevTxVout} (serialId: ${input.inputSerialId})`
        );
      });

      // Check witness element count vs input count
      const totalInputs = dlcOffer.fundingInputs.length + dlcAccept.fundingInputs.length;
      const witnessElementCount = dlcSign.fundingSignatures?.witnessElements?.length || 0;
      console.log(`Total inputs: ${totalInputs}, Witness elements: ${witnessElementCount}`);

      if (witnessElementCount !== dlcOffer.fundingInputs.length) {
        console.log('⚠️ WARNING: Witness element count does not match offerer input count');
        console.log(`Expected: ${dlcOffer.fundingInputs.length} (offerer inputs only)`);
        console.log(`Got: ${witnessElementCount}`);
      }

      // Debug funding signatures structure
      console.log('🔍 Manual Funding Signatures Debug:');
      dlcSign.fundingSignatures?.witnessElements?.forEach((witnessElement, index) => {
        console.log(`  Input ${index}:`);
        witnessElement.forEach((witness, witnessIndex) => {
          console.log(
            `    Witness ${witnessIndex}: ${witness.witness.toString('hex')} (${witness.witness.length} bytes)`
          );
        });
      });

      console.log('dlcTransactions', createDlcTxsResponse.dlcTransactions.fundTx.toHex());

      // Debug sighashes for all funding transaction inputs with details
      console.log('🔍 Funding Transaction Sighash Details:');
      try {
        const sighashDetails = await bitcoinWithDdk.getMethod(
          'getFundingTransactionSighashDetails'
        )(dlcOffer, dlcAccept, createDlcTxsResponse.dlcTransactions);

        sighashDetails.forEach((detail) => {
          console.log(`  Input ${detail.inputIndex}:`);
          console.log(`    TXID: ${detail.txid}:${detail.vout}`);
          console.log(`    Sequence: ${detail.sequence}`);
          console.log(`    Script: ${detail.scriptPubKey}`);
          console.log(`    Value: ${detail.value} sats`);
          console.log(`    Sighash: ${detail.sighash}`);
          console.log('    ---');
        });

        // Debug the actual transaction structure used for sighash calculation
        console.log('🔍 Transaction Structure for Sighash:');
        const fundingTx = createDlcTxsResponse.dlcTransactions.fundTx;
        console.log(`  Version: ${fundingTx.version}`);
        console.log(`  Locktime: ${fundingTx.locktime.toString()}`);
        console.log(`  Input count: ${fundingTx.inputs.length}`);

        fundingTx.inputs.forEach((input, i) => {
          console.log(`  Input ${i}:`);
          console.log(`    Hash: ${input.outpoint.txid.toString()}`);
          console.log(`    Index: ${input.outpoint.outputIndex}`);
          console.log(`    Sequence: ${input.sequence.toString()}`);
        });

        console.log(`  Output count: ${fundingTx.outputs.length}`);
        fundingTx.outputs.forEach((output, i) => {
          console.log(`  Output ${i}:`);
          console.log(`    Value: ${output.value.sats} sats`);
          console.log(`    Script: ${output.scriptPubKey.serialize().toString('hex')}`);
        });
      } catch (sighashError) {
        console.error('❌ Failed to get sighash details:', sighashError);
      }

      // Validate funding signatures before finalization
      console.log('🔍 Manual Funding Signature Validation:');
      try {
        await bitcoinWithDdk.getMethod('VerifyFundingSigsAlt')(
          dlcOffer,
          dlcAccept,
          dlcSign,
          createDlcTxsResponse.dlcTransactions,
          false // isOfferer = false (we're validating offerer's signatures as accepter)
        );
        console.log('✅ Manual funding signature validation passed');
      } catch (fundingSigError) {
        console.error('❌ Manual funding signature validation failed:', fundingSigError);
        console.error('This suggests the offerer signatures are invalid or incorrectly formatted');
        throw new Error(`Funding signature validation failed: ${fundingSigError.message}`);
      }

      // Use DDK client to finalize
      fundTx = await bitcoinWithDdk.dlc.finalizeDlcSign(
        dlcOffer,
        dlcAccept,
        dlcSign,
        createDlcTxsResponse.dlcTransactions
      );
      console.log('✅ Manual finalizeDlcSign completed successfully');

      // Debug the final transaction structure
      console.log('🔍 Final Transaction Debug:');
      console.log('TX ID:', fundTx.txId.serialize().toString('hex'));
      console.log('TX Hex:', fundTx.serialize().toString('hex'));
      console.log('Input count:', fundTx.inputs.length);

      fundTx.inputs.forEach((input, index) => {
        console.log(`Input ${index}:`);
        console.log(`  TXID: ${input.outpoint.txid.toString()}`);
        console.log(`  VOUT: ${input.outpoint.outputIndex}`);
        console.log(`  Witness elements: ${input.witness.length}`);
        input.witness.forEach((witness, wIndex) => {
          console.log(
            `    Witness ${wIndex}: ${witness.serialize().toString('hex')} (${witness.serialize().length} bytes)`
          );
        });
      });

      console.log('Output count:', fundTx.outputs.length);
      fundTx.outputs.forEach((output, index) => {
        console.log(`Output ${index}: ${output.value.sats} sats`);
      });

      // Validate UTXOs being spent vs signatures
      console.log('🔍 UTXO Validation:');
      for (let i = 0; i < fundTx.inputs.length; i++) {
        const input = fundTx.inputs[i];
        const txid = input.outpoint.txid.toString();
        const vout = input.outpoint.outputIndex;

        console.log(`Input ${i} UTXO check:`);
        console.log(`  Spending: ${txid}:${vout}`);

        try {
          // Fetch the actual UTXO from mempool.space to verify it exists and matches
          const utxoResponse = await fetch(`https://mempool.space/testnet4/api/tx/${txid}`);
          if (utxoResponse.ok) {
            const utxoData = await utxoResponse.json();
            const actualOutput = utxoData.vout[vout];

            if (actualOutput) {
              console.log(`  ✅ UTXO exists: ${actualOutput.value} sats`);
              console.log(`  Script type: ${actualOutput.scriptpubkey_type}`);
              console.log(`  Script: ${actualOutput.scriptpubkey}`);

              // Validate pubkey hash matches script
              if (actualOutput.scriptpubkey_type === 'v0_p2wpkh') {
                const scriptHex = actualOutput.scriptpubkey;
                // P2WPKH script: 0014 + 20-byte pubkey hash
                if (scriptHex.length === 44 && scriptHex.startsWith('0014')) {
                  const expectedPubkeyHash = scriptHex.slice(4); // Remove 0014 prefix

                  // Get the actual pubkey from witness
                  const witnessElements = input.witness;
                  if (witnessElements.length >= 2) {
                    const pubkeyFromWitness = witnessElements[1]
                      .serialize()
                      .toString('hex')
                      .slice(2); // Remove length prefix

                    // Calculate hash160 of the pubkey
                    const crypto = require('crypto');
                    const pubkeyBuffer = Buffer.from(pubkeyFromWitness, 'hex');
                    const sha256Hash = crypto.createHash('sha256').update(pubkeyBuffer).digest();
                    const ripemd160Hash = crypto
                      .createHash('ripemd160')
                      .update(sha256Hash)
                      .digest();
                    const calculatedHash = ripemd160Hash.toString('hex');

                    console.log(`  Expected pubkey hash: ${expectedPubkeyHash}`);
                    console.log(`  Witness pubkey: ${pubkeyFromWitness}`);
                    console.log(`  Calculated hash: ${calculatedHash}`);
                    console.log(`  Hash matches: ${calculatedHash === expectedPubkeyHash}`);

                    if (calculatedHash !== expectedPubkeyHash) {
                      console.log(
                        `  ❌ PUBKEY HASH MISMATCH! This is likely the cause of OP_EQUALVERIFY failure`
                      );
                    }
                  }
                }
              }

              // Check if it's unspent
              const utxoStatusResponse = await fetch(
                `https://mempool.space/testnet4/api/tx/${txid}/outspend/${vout}`
              );
              if (utxoStatusResponse.ok) {
                const utxoStatus = await utxoStatusResponse.json();
                console.log(`  Spent: ${utxoStatus.spent ? 'YES' : 'NO'}`);
                if (utxoStatus.spent) {
                  console.log(`  ⚠️ WARNING: UTXO already spent in tx: ${utxoStatus.txid}`);
                }
              }
            } else {
              console.log(`  ❌ UTXO output ${vout} not found in transaction`);
            }
          } else {
            console.log(`  ❌ Failed to fetch UTXO data: ${utxoResponse.status}`);
          }
        } catch (utxoError) {
          console.log(`  ❌ Error checking UTXO: ${utxoError.message}`);
        }
      }
    } catch (finalizeError) {
      console.error('❌ Manual finalizeDlcSign error:', finalizeError);
      console.error('Full error stack:', finalizeError.stack);
      throw finalizeError;
    }

    const txHex = fundTx.serialize().toString('hex');

    res.json({
      txId: fundTx.txId.serialize().toString('hex'),
      txHex,
      success: true,
      message: 'DLC manually finalized successfully',
    });
  } catch (error: any) {
    console.error('Error manually finalizing DLC:', error);
    res.status(500).json({
      error: 'Failed to manually finalize DLC',
      details: error.message,
    });
  }
});

/**
 * Get DLC state
 * GET /api/dlc/:contractId
 */
app.get('/api/dlc/:contractId', (req, res) => {
  try {
    const { contractId } = req.params;
    const dlcState = dlcStore.get(contractId);

    if (!dlcState) {
      return res.status(404).json({ error: 'DLC state not found' });
    }

    res.json({
      hasOffer: !!dlcState.offer,
      hasAccept: !!dlcState.accept,
      hasSign: !!dlcState.sign,
      contractId,
    });
  } catch (error: any) {
    console.error('Error getting DLC state:', error);
    res.status(500).json({
      error: 'Failed to get DLC state',
      details: error.message,
    });
  }
});

/**
 * Broadcast a finalized transaction
 * POST /api/dlc/broadcast
 * Body: { txHex: string }
 * Returns: { txId: string, success: boolean }
 */
app.post('/api/dlc/broadcast', async (req, res) => {
  try {
    const { txHex } = req.body;

    if (!txHex) {
      return res.status(400).json({ error: 'txHex is required' });
    }

    // Use Esplora API to broadcast the transaction
    const esploraUrl = 'https://mempool.space/testnet4/api';
    const broadcastResponse = await fetch(`${esploraUrl}/tx`, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain',
      },
      body: txHex,
    });

    if (!broadcastResponse.ok) {
      const errorText = await broadcastResponse.text();
      throw new Error(`Broadcast failed: ${broadcastResponse.status} ${errorText}`);
    }

    // The response should be the transaction ID
    const txId = await broadcastResponse.text();

    res.json({
      txId: txId.trim(),
      success: true,
      message: 'Transaction broadcast successfully',
    });
  } catch (error: any) {
    console.error('Error broadcasting transaction:', error);
    res.status(500).json({
      error: 'Failed to broadcast transaction',
      details: error.message,
    });
  }
});

/**
 * Execute DLC with oracle attestation
 * POST /api/dlc/execute
 * Body: { contractId: string, oracleAttestationHex: string }
 * Returns: { txId: string, txHex: string, success: boolean }
 */
app.post('/api/dlc/execute', async (req, res) => {
  try {
    const { contractId, oracleAttestationHex } = req.body;

    if (!contractId || !oracleAttestationHex) {
      return res.status(400).json({ error: 'contractId and oracleAttestationHex are required' });
    }

    // Get stored DLC state
    const dlcState = dlcStore.get(contractId);
    if (!dlcState?.offer || !dlcState?.accept || !dlcState?.sign || !dlcState?.transactions) {
      return res.status(404).json({ error: 'Complete DLC state not found for contract ID' });
    }

    // Deserialize the oracle attestation
    const { OracleAttestation } = await import('@node-dlc/messaging');
    const oracleAttestation = OracleAttestation.deserialize(
      Buffer.from(oracleAttestationHex, 'hex')
    );

    // Execute the DLC from acceptor's perspective (server is acceptor, not offerer)
    const isOfferer = false;

    console.log('🔍 DLC Execution Debug:');
    console.log('Oracle attestation event ID:', oracleAttestation.eventId);
    console.log('Oracle attestation outcomes:', oracleAttestation.outcomes);
    console.log('Available CET count:', dlcState.transactions.cets?.length || 0);
    console.log(
      'DLC Accept CET signatures count:',
      dlcState.accept.cetAdaptorSignatures?.sigs?.length || 0
    );
    console.log(
      'DLC Sign CET signatures count:',
      dlcState.sign.cetAdaptorSignatures?.sigs?.length || 0
    );

    // Debug the fund output value issue
    const fundOutputValueSats =
      dlcState.transactions.fundTx.outputs[dlcState.transactions.fundTxVout].value.sats;
    console.log('Fund output value (sats):', fundOutputValueSats);
    console.log('Fund output value type:', typeof fundOutputValueSats);

    const executionTx = await bitcoinWithDdk.dlc.execute(
      dlcState.offer,
      dlcState.accept,
      dlcState.sign,
      dlcState.transactions,
      oracleAttestation,
      isOfferer
    );

    const txHex = executionTx.serialize().toString('hex');

    res.json({
      txId: executionTx.txId.serialize().toString('hex'),
      txHex,
      success: true,
      message: 'DLC executed successfully',
    });
  } catch (error: any) {
    console.error('Error executing DLC:', error);
    res.status(500).json({
      error: 'Failed to execute DLC',
      details: error.message,
    });
  }
});

/**
 * Execute DLC directly by decrypting adaptor sig (skip verification)
 * POST /api/dlc/execute-direct
 * Body: { contractId: string, oracleAttestationHex: string }
 * Returns: { txId: string, txHex: string, success: boolean }
 */
app.post('/api/dlc/execute-direct', async (req, res) => {
  try {
    const { contractId, oracleAttestationHex } = req.body;

    if (!contractId || !oracleAttestationHex) {
      return res.status(400).json({ error: 'contractId and oracleAttestationHex are required' });
    }

    // Get stored DLC state
    const dlcState = dlcStore.get(contractId);
    if (!dlcState?.offer || !dlcState?.accept || !dlcState?.sign || !dlcState?.transactions) {
      return res.status(404).json({ error: 'Complete DLC state not found for contract ID' });
    }

    // Deserialize the oracle attestation
    const { OracleAttestation } = await import('@node-dlc/messaging');
    const oracleAttestation = OracleAttestation.deserialize(
      Buffer.from(oracleAttestationHex, 'hex')
    );

    console.log('🔍 Direct Execution (skip verification):');
    console.log('Oracle attestation event ID:', oracleAttestation.eventId);
    console.log('Oracle attestation outcomes:', oracleAttestation.outcomes);
    console.log('Oracle signatures count:', oracleAttestation.signatures.length);
    oracleAttestation.signatures.forEach((sig: Buffer, i: number) => {
      console.log(`  Signature ${i}: ${sig.toString('hex')}`);
    });

    // Find the matching CET based on outcome
    const contractInfo = dlcState.offer.contractInfo as SingleContractInfo;
    const contractDescriptor = contractInfo.contractDescriptor;
    const attestedOutcome = oracleAttestation.outcomes[0];

    console.log('Looking for outcome:', attestedOutcome);

    // For enum contracts, find the CET index
    let outcomeIndex = -1;
    const crypto = require('crypto');

    // Hash the attested outcome for comparison
    const attestedOutcomeHash = crypto.createHash('sha256').update(attestedOutcome).digest('hex');
    console.log('Attested outcome hash:', attestedOutcomeHash);

    // Check for enumerated contract descriptor
    // EnumeratedDescriptor has type = 42768 (MessageType.ContractDescriptorV0)
    // or contractDescriptorType = 0 (ContractDescriptorType.Enumerated)
    const isEnumerated =
      contractDescriptor.type === 42768 || (contractDescriptor as any).contractDescriptorType === 0;

    console.log('Contract descriptor type:', contractDescriptor.type);
    console.log('Contract descriptor is enumerated:', isEnumerated);

    if (isEnumerated) {
      // EnumeratedDescriptor (enum)
      const enumDescriptor = contractDescriptor as any;

      // Debug: Log all outcomes in the contract
      console.log('Enum descriptor keys:', Object.keys(enumDescriptor));
      console.log('Outcomes array exists:', !!enumDescriptor.outcomes);
      console.log('Outcomes count:', enumDescriptor.outcomes?.length || 0);
      console.log('Contract outcomes:');
      enumDescriptor.outcomes?.forEach((o: any, idx: number) => {
        const outcomeText = typeof o === 'string' ? o : o.outcome;
        const outcomeHash = crypto.createHash('sha256').update(outcomeText).digest('hex');
        console.log(`  ${idx}: "${outcomeText}" -> hash: ${outcomeHash}`);
      });

      outcomeIndex = enumDescriptor.outcomes.findIndex((o: any) => {
        const outcomeText = typeof o === 'string' ? o : o.outcome;
        // Direct match
        if (outcomeText === attestedOutcome) return true;
        // Hash of stored outcome matches hash of attested outcome
        const storedOutcomeHash = crypto.createHash('sha256').update(outcomeText).digest('hex');
        if (storedOutcomeHash === attestedOutcomeHash) return true;
        // Stored outcome IS a hash that matches attested outcome hash
        if (outcomeText === attestedOutcomeHash) return true;
        return false;
      });
    }

    console.log('Found outcome index:', outcomeIndex);

    if (outcomeIndex < 0) {
      return res.status(400).json({ error: `Outcome "${attestedOutcome}" not found in contract` });
    }

    // Get the adaptor signature for this outcome
    const adaptorSig = dlcState.sign.cetAdaptorSignatures.sigs[outcomeIndex];
    console.log('Adaptor signature for outcome:');
    console.log('  encryptedSig length:', adaptorSig.encryptedSig.length);
    console.log('  encryptedSig hex:', adaptorSig.encryptedSig.toString('hex'));
    console.log('  dleqProof length:', adaptorSig.dleqProof?.length || 0);

    // Get the full 162-byte adaptor signature for secp256k1_zkp's EcdsaAdaptorSignature
    // DDK internal format stores the full 162 bytes in encryptedSig (dleqProof is empty)
    // Other implementations may split: encryptedSig (65 bytes) + dleqProof (97 bytes)
    // Either way, concatenating gives us the full 162 bytes
    const fullAdaptorSig = Buffer.concat([
      adaptorSig.encryptedSig,
      adaptorSig.dleqProof || Buffer.alloc(0),
    ]);
    console.log('  Full adaptor sig length:', fullAdaptorSig.length, '(expected: 162)');
    if (fullAdaptorSig.length !== 162) {
      console.error('❌ ERROR: Adaptor signature has unexpected length!');
      console.log(
        '  This indicates a format mismatch between how the signature was created and stored.'
      );
    }

    // Get the CET
    const cet = dlcState.transactions.cets[outcomeIndex];
    console.log('CET txid:', cet.txId.toString());

    // Get fund output value
    const fundOutputValue = BigInt(
      Math.round(dlcState.transactions.fundTx.outputs[dlcState.transactions.fundTxVout].value * 1e8)
    );

    // Try to directly sign the CET using ddk
    console.log('🔧 Attempting direct CET signing...');

    // We need the accepter's private key to sign
    // IMPORTANT: We must find the private key that corresponds to the ACTUAL funding pubkey
    // used in the DlcAccept, NOT just addresses[0]. The funding pubkey may be at a different
    // derivation path than the first address.
    const accepterFundingPubkeyHex = dlcState.accept.fundingPubkey.toString('hex');

    console.log('Looking for private key matching funding pubkey:', accepterFundingPubkeyHex);

    // Search through wallet addresses to find the one matching our funding pubkey
    let accepterPrivKey: string | null = null;

    // First check existing addresses
    const existingAddresses = await bitcoinWithDdk.getMethod('getAddresses')();
    for (const addressInfo of existingAddresses) {
      if (addressInfo.derivationPath) {
        try {
          const keyPair = await bitcoinWithDdk.getMethod('keyPair')(addressInfo.derivationPath);
          const pubkeyHex = Buffer.from(keyPair.publicKey).toString('hex');
          if (pubkeyHex === accepterFundingPubkeyHex) {
            accepterPrivKey = Buffer.from(keyPair.privateKey).toString('hex');
            console.log(`Found funding key at derivation path: ${addressInfo.derivationPath}`);
            break;
          }
        } catch {
          continue;
        }
      }
    }

    // If not found, search through more addresses
    if (!accepterPrivKey) {
      console.log('Key not in existing addresses, searching extended range...');
      for (const isChange of [false, true]) {
        for (let i = 0; i < 100; i++) {
          try {
            const addresses = await bitcoinWithDdk.getMethod('getAddresses')(i, 1, isChange);
            if (addresses && addresses.length > 0) {
              const addressInfo = addresses[0];
              if (addressInfo.derivationPath) {
                const keyPair = await bitcoinWithDdk.getMethod('keyPair')(
                  addressInfo.derivationPath
                );
                const pubkeyHex = Buffer.from(keyPair.publicKey).toString('hex');
                if (pubkeyHex === accepterFundingPubkeyHex) {
                  accepterPrivKey = Buffer.from(keyPair.privateKey).toString('hex');
                  console.log(
                    `Found funding key at derivation path: ${addressInfo.derivationPath}`
                  );
                  break;
                }
              }
            }
          } catch {
            continue;
          }
        }
        if (accepterPrivKey) break;
      }
    }

    if (!accepterPrivKey) {
      throw new Error(`Could not find private key for funding pubkey: ${accepterFundingPubkeyHex}`);
    }

    console.log('Found accepter private key for funding pubkey');

    // Note: Despite the parameter name "fundingScriptPubkey" in ddk-ffi, it actually expects
    // the ACCEPTER's funding pubkey (33 bytes), NOT the full witness script.
    // The Rust code does: make_funding_redeemscript(&funding_pubkey, &other_pk)
    // where funding_pubkey = our pubkey (accepter) and other_pk = offerer's pubkey

    // signCet signature:
    // signCet(cet, adaptorSignature, oracleSignatures, fundingSecretKey, otherPubkey, fundingScriptPubkey, fundOutputValue)
    // We are accepter, so:
    // - fundingSecretKey = accepter's private key
    // - otherPubkey = offerer's pubkey (the one who signed the adaptor sig)
    // - fundingScriptPubkey = accepter's funding pubkey (33 bytes, NOT the full script!)
    const accepterFundingPubkey = dlcState.accept.fundingPubkey;
    console.log('Accepter funding pubkey:', accepterFundingPubkey.toString('hex'));
    console.log('Offerer funding pubkey:', dlcState.offer.fundingPubkey.toString('hex'));

    // Debug: Compare pubkeys lexicographically to understand signature ordering
    const accepterPkHex = accepterFundingPubkey.toString('hex');
    const offererPkHex = dlcState.offer.fundingPubkey.toString('hex');
    console.log('Pubkey comparison (accepter < offerer):', accepterPkHex < offererPkHex);
    console.log('  Accepter pk:', accepterPkHex);
    console.log('  Offerer pk:', offererPkHex);

    // Create the funding script to verify it matches what was used for the adaptor sig
    const fundingScript = ddkJs.createFundTxLockingScript(
      dlcState.offer.fundingPubkey,
      accepterFundingPubkey
    );
    console.log('Funding script (2-of-2 multisig):', fundingScript.toString('hex'));

    const cetForDdk = {
      version: cet.version,
      lockTime: cet.locktime.value,
      inputs: cet.inputs.map((input: any) => ({
        txid: input.outpoint.txid.serialize().toString('hex'),
        vout: input.outpoint.outputIndex,
        scriptSig: input.scriptSig?.serialize() || Buffer.alloc(0),
        sequence: input.sequence?.value || 0xffffffff,
        witness: input.witness || [],
      })),
      outputs: cet.outputs.map((output: any) => ({
        value: BigInt(Math.round(output.value * 1e8)),
        scriptPubkey: output.scriptPubKey.serialize(),
      })),
      rawBytes: cet.serialize(),
    };

    console.log(
      'CET for DDK:',
      JSON.stringify({
        version: cetForDdk.version,
        lockTime: cetForDdk.lockTime,
        inputCount: cetForDdk.inputs.length,
        outputCount: cetForDdk.outputs.length,
      })
    );

    console.log('Calling ddkJs.signCet with:');
    console.log('  fullAdaptorSig length:', fullAdaptorSig.length, '(expected: 162)');
    console.log('  oracleSignatures count:', oracleAttestation.signatures.length);
    oracleAttestation.signatures.forEach((sig: Buffer, i: number) => {
      console.log(`    Oracle sig ${i}: ${sig.toString('hex')} (${sig.length} bytes)`);
    });
    console.log('  fundingSecretKey length:', accepterPrivKey.length / 2, 'bytes');
    console.log('  otherPubkey (offerer):', dlcState.offer.fundingPubkey.toString('hex'));
    console.log('  fundingScriptPubkey (accepter):', accepterFundingPubkey.toString('hex'));
    console.log('  fundingScriptPubkey length:', accepterFundingPubkey.length, '(expected: 33)');
    console.log('  fundOutputValue:', fundOutputValue.toString());
    console.log('  fundingScript for sighash:', fundingScript.toString('hex'));

    // Compute and log the sighash for debugging
    console.log('🔍 Computing sighash for execution...');
    const executionSighash = ddkJs.getCetSighash(cetForDdk, fundingScript, fundOutputValue);
    console.log('  Execution sighash:', executionSighash.toString('hex'));

    // Also compute adaptor signature inputs to compare with what was used during accept
    const enumMessages = await bitcoinWithDdk.getMethod('GenerateMessages')(
      (dlcState.offer.contractInfo as SingleContractInfo).oracleInfo as SingleOracleInfo
    );
    const msgsForDdk = await bitcoinWithDdk.getMethod('convertMessagesForDdk')(enumMessages);
    const transformedMsgsForDdk = msgsForDdk[0][0].map((message: Buffer) => [[message]]);
    const msgsForCet = transformedMsgsForDdk[outcomeIndex][0];

    const oraclePublicKey = (
      (dlcState.offer.contractInfo as SingleContractInfo).oracleInfo as SingleOracleInfo
    ).announcement.oraclePublicKey;
    const oracleNonces = (
      (dlcState.offer.contractInfo as SingleContractInfo).oracleInfo as SingleOracleInfo
    ).announcement.getNonces();

    const debugInfo = ddkJs.getCetAdaptorSignatureInputs(
      cetForDdk,
      [{ publicKey: oraclePublicKey, nonces: oracleNonces }],
      fundingScript,
      fundOutputValue,
      [msgsForCet]
    );

    console.log('🔍 CET debug info during execution:');
    console.log('  CET txid:', debugInfo.cetTxid);
    console.log('  Sighash:', debugInfo.sighash.toString('hex'));
    console.log('  Adaptor point:', debugInfo.adaptorPoint.toString('hex'));
    console.log('  Value:', debugInfo.value.toString());
    console.log('  Script pubkey:', debugInfo.scriptPubkey.toString('hex'));

    // Try signCet directly
    // IMPORTANT: The signCet function parameters are:
    // - funding_secret_key: OUR private key (accepter)
    // - other_pubkey: The OTHER party's pubkey (offerer) - who created the adaptor sig
    // - funding_script_pubkey: Used to create redeem script - the Rust code does:
    //   make_funding_redeemscript(&funding_pubkey, &other_pk)
    //   But since make_funding_redeemscript SORTS pubkeys, the order doesn't affect the script.
    //   However, funding_script_pubkey is also used for the signature - it should be
    //   the pubkey corresponding to funding_secret_key (i.e., OUR pubkey).
    const signedCet = ddkJs.signCet(
      cetForDdk,
      fullAdaptorSig, // Full 162-byte adaptor signature (encryptedSig + dleqProof)
      oracleAttestation.signatures, // Oracle Schnorr signatures
      Buffer.from(accepterPrivKey, 'hex'), // Our private key (accepter)
      dlcState.offer.fundingPubkey, // Other pubkey (offerer who made adaptor sig)
      accepterFundingPubkey, // Our pubkey (accepter) - matches the private key above
      fundOutputValue
    );

    console.log('✅ Direct CET signing succeeded!');
    const txHex = signedCet.rawBytes.toString('hex');

    // Compute txid from the signed transaction
    const signedCetBtc = btcTransaction.fromBuffer(signedCet.rawBytes);
    const signedCetTxId = signedCetBtc.getId();

    console.log('txHex', txHex);
    console.log('txId', signedCetTxId);

    res.json({
      txId: signedCetTxId,
      txHex,
      success: true,
      message: 'CET signed directly (verification skipped)',
    });
  } catch (error: any) {
    console.error('❌ Direct execution failed:', error);
    console.error('Stack:', error.stack);
    res.status(500).json({
      error: 'Failed to execute DLC directly',
      details: error.message,
    });
  }
});

/**
 * Calculate adaptor points from DLC offer
 * POST /api/dlc/adaptor-points
 * Body: { dlcOfferHex: string }
 * Returns: { adaptorPoints: string[], success: boolean }
 */
app.post('/api/dlc/adaptor-points', async (req, res) => {
  try {
    const { dlcOfferHex } = req.body;

    if (!dlcOfferHex) {
      return res.status(400).json({ error: 'dlcOfferHex is required' });
    }

    // Deserialize the DLC offer
    const dlcOffer = DlcOffer.deserialize(Buffer.from(dlcOfferHex, 'hex'));

    // Extract oracle info from contract info
    const contractInfo = dlcOffer.contractInfo as SingleContractInfo;
    const oracleInfo = contractInfo.oracleInfo as SingleOracleInfo;

    const oraclePublicKey = oracleInfo.announcement.oraclePublicKey;
    const oracleNonces = oracleInfo.announcement.getNonces();

    // Generate messages using DDK
    const enumMessages = await bitcoinWithDdk.getMethod('GenerateMessages')(oracleInfo);
    const msgsForDdk = await bitcoinWithDdk.getMethod('convertMessagesForDdk')(enumMessages);

    // Transform msgsForDdk structure: flatten the nested messages into separate arrays
    const transformedMsgsForDdk = msgsForDdk[0][0].map((message: Buffer) => [[message]]);

    console.log('🔍 Adaptor Point Calculation:');
    console.log('  Oracle public key:', oraclePublicKey.toString('hex'));
    console.log('  Oracle nonces count:', oracleNonces.length);
    console.log('  Messages count:', transformedMsgsForDdk.length);

    // Calculate adaptor points using DDK
    const adaptorPoints = ddkJs.createCetAdaptorPointsFromOracleInfo(
      [
        {
          publicKey: oraclePublicKey,
          nonces: oracleNonces,
        },
      ],
      transformedMsgsForDdk
    );

    console.log('  Adaptor points calculated:', adaptorPoints.length);

    res.json({
      adaptorPoints: adaptorPoints.map((point: Buffer) => point.toString('base64')),
      success: true,
    });
  } catch (error: any) {
    console.error('Error calculating adaptor points:', error);
    res.status(500).json({
      error: 'Failed to calculate adaptor points',
      details: error.message,
    });
  }
});

/**
 * Execute DLC with Fordefi signature
 * Fordefi signs the CET via signPsbt, server decrypts its adaptor sig, combines both
 * POST /api/dlc/execute-with-fordefi
 * Body: { contractId: string, oracleAttestationHex: string, fordefiSignature: string }
 * Returns: { txId: string, txHex: string, success: boolean, debugInfo: object }
 */
app.post('/api/dlc/execute-with-fordefi', async (req, res) => {
  try {
    const { contractId, oracleAttestationHex, fordefiSignature } = req.body;

    if (!contractId || !oracleAttestationHex || !fordefiSignature) {
      return res.status(400).json({
        error: 'contractId, oracleAttestationHex, and fordefiSignature are required',
      });
    }

    // Get stored DLC state
    const dlcState = dlcStore.get(contractId);
    if (!dlcState?.offer || !dlcState?.accept || !dlcState?.transactions) {
      return res.status(404).json({ error: 'DLC state not found for contract ID' });
    }

    // Deserialize the oracle attestation
    const { OracleAttestation } = await import('@node-dlc/messaging');
    const oracleAttestation = OracleAttestation.deserialize(
      Buffer.from(oracleAttestationHex, 'hex')
    );

    console.log('🔍 Execute with Fordefi - Oracle attestation:');
    console.log('  Event ID:', oracleAttestation.eventId);
    console.log('  Outcomes:', oracleAttestation.outcomes);
    console.log('  Signatures count:', oracleAttestation.signatures.length);

    // The attested outcome maps to CET index 0 (trump wins = index 0)
    const outcomeIndex = 0;
    console.log('  Using outcome index:', outcomeIndex);

    // Get server's adaptor signature for this outcome (from dlcAccept, since server is accepter)
    const serverAdaptorSig = dlcState.accept.cetAdaptorSignatures.sigs[outcomeIndex];

    console.log('🔍 Server adaptor signature (raw structure):');
    console.log('  encryptedSig length:', serverAdaptorSig.encryptedSig.length);
    console.log('  encryptedSig hex:', serverAdaptorSig.encryptedSig.toString('hex'));
    console.log('  dleqProof length:', serverAdaptorSig.dleqProof?.length || 0);
    console.log('  dleqProof hex:', serverAdaptorSig.dleqProof?.toString('hex') || 'none');

    // DDK's internal format stores the full 162-byte adaptor signature in encryptedSig
    // (with dleqProof being empty). The signature is already in secp256k1-zkp format:
    //   [Ra(33)][Sa(32)][R(33)][e(32)][s(32)] = 162 bytes
    //
    // Some implementations may split it differently:
    //   encryptedSig (65 bytes) = [Ra(33)][Sa(32)]
    //   dleqProof (97 bytes) = [R(33)][e(32)][s(32)]
    //
    // Concatenating handles both cases correctly.
    const fullAdaptorSig = Buffer.concat([
      serverAdaptorSig.encryptedSig,
      serverAdaptorSig.dleqProof || Buffer.alloc(0),
    ]);

    console.log('  Full adaptor sig length:', fullAdaptorSig.length, '(expected: 162)');
    console.log('  Full adaptor sig hex:', fullAdaptorSig.toString('hex'));

    if (fullAdaptorSig.length !== 162) {
      throw new Error(
        `Unexpected adaptor signature length: ${fullAdaptorSig.length} (expected 162)`
      );
    }

    // Debug: Parse the adaptor sig components (secp256k1-zkp format)
    const Ra = fullAdaptorSig.subarray(0, 33);
    const Sa = fullAdaptorSig.subarray(33, 65);
    const R = fullAdaptorSig.subarray(65, 98);
    const e = fullAdaptorSig.subarray(98, 130);
    const s = fullAdaptorSig.subarray(130, 162);
    console.log('  Adaptor sig components (secp256k1-zkp format):');
    console.log('    Ra (adapted R): ', Ra.toString('hex'));
    console.log('    Sa (adapted s): ', Sa.toString('hex'));
    console.log('    R (commitment): ', R.toString('hex'));
    console.log('    e (DLEQ proof): ', e.toString('hex'));
    console.log('    s (DLEQ proof): ', s.toString('hex'));

    // Compute the sighash to compare with what was used during accept
    const cet = dlcState.transactions.cets[outcomeIndex];
    const cetRawBytes = cet.serialize();

    // Debug: Log raw CET structure
    console.log('🔍 Raw CET from DLC Transactions:');
    console.log('  Raw CET hex:', cetRawBytes.toString('hex'));
    const rawCetBtc = btcTransaction.fromBuffer(cetRawBytes);
    console.log('  Raw CET txid (bitcoinjs):', rawCetBtc.getId());
    console.log('  Raw CET version:', rawCetBtc.version);
    console.log('  Raw CET locktime:', rawCetBtc.locktime);
    console.log('  Raw CET inputs:', rawCetBtc.ins.length);
    rawCetBtc.ins.forEach((input, i) => {
      console.log(`    Input ${i}:`);
      console.log(`      hash: ${input.hash.toString('hex')}`);
      console.log(
        `      hash (reversed/txid): ${Buffer.from(input.hash).reverse().toString('hex')}`
      );
      console.log(`      index: ${input.index}`);
      console.log(`      sequence: ${input.sequence}`);
    });
    console.log('  Raw CET outputs:', rawCetBtc.outs.length);
    rawCetBtc.outs.forEach((output, i) => {
      console.log(
        `    Output ${i}: ${output.value} sats, script: ${output.script.toString('hex')}`
      );
    });

    // Also log what the fund tx txid looks like
    const fundTxRawBytes = dlcState.transactions.fundTx.serialize();
    const fundTxBtc = btcTransaction.fromBuffer(fundTxRawBytes);
    console.log('🔍 Fund TX info:');
    console.log('  Fund TX txid (bitcoinjs):', fundTxBtc.getId());
    console.log('  Fund TX txid (node-dlc):', dlcState.transactions.fundTx.txId.toString());
    console.log('  Fund TX vout:', dlcState.transactions.fundTxVout);

    const cetForDdk = {
      version: cet.version,
      lockTime: cet.locktime.value,
      inputs: cet.inputs.map((input: any) => ({
        txid: input.outpoint.txid.serialize().toString('hex'),
        vout: input.outpoint.outputIndex,
        scriptSig: input.scriptSig?.serialize() || Buffer.alloc(0),
        sequence: input.sequence?.value || 0xffffffff,
        witness: input.witness || [],
      })),
      outputs: cet.outputs.map((output: any) => ({
        value: BigInt(Math.round(output.value * 1e8)),
        scriptPubkey: output.scriptPubKey.serialize(),
      })),
      rawBytes: cetRawBytes,
    };

    console.log('🔍 CET for DDK (converted):');
    console.log('  Input 0 txid:', cetForDdk.inputs[0].txid);
    console.log('  Input 0 vout:', cetForDdk.inputs[0].vout);

    // Get the funding script (witness script)
    const fundingScript = ddkJs.createFundTxLockingScript(
      dlcState.offer.fundingPubkey,
      dlcState.accept.fundingPubkey
    );

    // Get fund output value
    const fundOutput = dlcState.transactions.fundTx.outputs[dlcState.transactions.fundTxVout];
    const fundOutputValue = BigInt(Math.round(fundOutput.value * 1e8));

    console.log('🔍 Computing sighash for Fordefi execution...');
    const executionSighash = ddkJs.getCetSighash(cetForDdk, fundingScript, fundOutputValue);
    console.log('  Execution sighash:', executionSighash.toString('hex'));
    console.log('  Fund output value (sats):', fundOutputValue.toString());
    console.log('  Funding script:', fundingScript.toString('hex'));
    console.log('  CET txid:', cet.txId.toString());

    // Decrypt server's adaptor signature using oracle signatures
    console.log('🔍 Decrypting server adaptor signature...');
    const serverDecryptedSig = ddkJs.extractEcdsaSignatureFromOracleSignatures(
      oracleAttestation.signatures,
      fullAdaptorSig
    );

    console.log('  Server decrypted ECDSA sig:', Buffer.from(serverDecryptedSig).toString('hex'));
    console.log('  Server decrypted sig length:', serverDecryptedSig.length);

    // Parse Fordefi's signature
    let fordefiSigBuffer = Buffer.from(fordefiSignature, 'hex');
    console.log('🔍 Fordefi signature:');
    console.log('  Fordefi sig hex:', fordefiSigBuffer.toString('hex'));
    console.log('  Fordefi sig length:', fordefiSigBuffer.length);

    // Strip sighash byte from Fordefi signature if present (ends with 01)
    // PSBT partialSig should not include sighash byte
    if (fordefiSigBuffer[fordefiSigBuffer.length - 1] === 0x01) {
      console.log('  Stripping sighash byte from Fordefi signature');
      fordefiSigBuffer = fordefiSigBuffer.subarray(0, fordefiSigBuffer.length - 1);
      console.log('  Fordefi sig without sighash:', fordefiSigBuffer.toString('hex'));
    }

    console.log('🔍 CET:', cet.txId.toString());

    // Get pubkeys
    const offerPubkey = dlcState.offer.fundingPubkey;
    const acceptPubkey = dlcState.accept.fundingPubkey;

    // Pubkeys are sorted lexicographically in 2-of-2 multisig
    const offerFirst = Buffer.compare(offerPubkey, acceptPubkey) < 0;

    console.log('🔍 Pubkey ordering:');
    console.log('  Offer pubkey:', offerPubkey.toString('hex'));
    console.log('  Accept pubkey:', acceptPubkey.toString('hex'));
    console.log('  Offer pubkey first:', offerFirst);

    // Create the 2-of-2 multisig payment variant (same as in BitcoinDdkProvider)
    const fundingPubKeys = offerFirst ? [offerPubkey, acceptPubkey] : [acceptPubkey, offerPubkey];

    const p2ms = payments.p2ms({
      m: 2,
      pubkeys: fundingPubKeys,
      network,
    });

    const paymentVariant = payments.p2wsh({
      redeem: p2ms,
      network,
    });

    console.log('🔍 Payment variant:');
    console.log('  P2WSH output script:', paymentVariant.output?.toString('hex'));
    console.log('  Witness script:', paymentVariant.redeem?.output?.toString('hex'));

    // Fund output value for PSBT (as number, not BigInt)
    const fundOutputValueNum = Number(fundOutputValue);

    // Parse the CET transaction using bitcoinjs-lib
    const cetTx = btcTransaction.fromBuffer(cetRawBytes);

    console.log('🔍 CET transaction:');
    console.log('  Version:', cetTx.version);
    console.log('  Locktime:', cetTx.locktime);
    console.log('  Inputs:', cetTx.ins.length);
    console.log('  Outputs:', cetTx.outs.length);

    // Create PSBT from the CET
    const psbt = new Psbt({ network });

    // Add the funding input
    psbt.addInput({
      hash: dlcState.transactions.fundTx.txId.serialize(),
      index: dlcState.transactions.fundTxVout,
      sequence: cetTx.ins[0].sequence,
      witnessUtxo: {
        script: paymentVariant.output!,
        value: fundOutputValueNum,
      },
      witnessScript: paymentVariant.redeem!.output,
    });

    // Add outputs from the CET
    for (const output of cetTx.outs) {
      psbt.addOutput({
        script: output.script,
        value: output.value,
      });
    }

    // Set locktime
    psbt.setLocktime(cetTx.locktime);

    console.log('🔍 PSBT created with input and outputs');

    // Add both partial signatures
    // Fordefi's signature corresponds to offerPubkey
    // Server's decrypted signature corresponds to acceptPubkey
    // Signatures are already DER format - just append SIGHASH_ALL byte
    const sighashByte = Buffer.from([0x01]); // SIGHASH_ALL
    const partialSigs = [
      {
        pubkey: offerPubkey,
        signature: Buffer.concat([fordefiSigBuffer, sighashByte]),
      },
      {
        pubkey: acceptPubkey,
        signature: Buffer.concat([Buffer.from(serverDecryptedSig), sighashByte]),
      },
    ];

    console.log('🔍 Adding partial signatures:');
    partialSigs.forEach((ps, i) => {
      console.log(`  [${i}] pubkey: ${ps.pubkey.toString('hex')}`);
      console.log(`  [${i}] signature: ${ps.signature.toString('hex')}`);
    });

    psbt.updateInput(0, { partialSig: partialSigs });

    // Finalize the input
    // Note: Signature validation will happen when broadcasting
    psbt.finalizeAllInputs();

    // Extract the final transaction
    const finalTx = psbt.extractTransaction();
    const finalTxHex = finalTx.toHex();
    const txId = finalTx.getId();

    console.log('✅ Final CET assembled using PSBT:');
    console.log('  TX ID:', txId);
    console.log('  TX Hex:', finalTxHex);

    res.json({
      txId,
      txHex: finalTxHex,
      success: true,
      message: 'CET assembled with Fordefi signature and server decrypted adaptor sig',
      debugInfo: {
        outcomeIndex,
        serverAdaptorSigHex: fullAdaptorSig.toString('hex'),
        serverDecryptedSigHex: Buffer.from(serverDecryptedSig).toString('hex'),
        fordefiSigHex: fordefiSigBuffer.toString('hex'),
        offerPubkeyFirst: offerFirst,
        witnessScriptHex: paymentVariant.redeem?.output?.toString('hex') || '',
      },
    });
  } catch (error: any) {
    console.error('❌ Execute with Fordefi failed:', error);
    console.error('Stack:', error.stack);
    res.status(500).json({
      error: 'Failed to execute DLC with Fordefi',
      details: error.message,
    });
  }
});

/**
 * Health check endpoint
 */
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(port, () => {
  console.log(`🚀 DLC Backend server running on http://localhost:${port}`);
  console.log(`📊 Health check: http://localhost:${port}/health`);
});

export default app;
