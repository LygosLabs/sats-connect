import BitcoinDdkProvider from '@atomicfinance/bitcoin-ddk-provider';
import { BitcoinEsploraApiProvider } from '@atomicfinance/bitcoin-esplora-api-provider';
import { BitcoinJsWalletProvider } from '@atomicfinance/bitcoin-js-wallet-provider';
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
import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';
import BlockstreamApiProvider from './BlockstreamApiProvider';

// Load environment variables
dotenv.config();

const app: express.Application = express();
const port = 3001;

// Setup DDK client with Blockstream API - using testnet3 for testing
const network = BitcoinNetworks.bitcoin_testnet;

const bitcoinWithDdk = new Client();

// Add Blockstream API provider
// const blockstreamProvider = new BlockstreamApiProvider({
//   network,
//   clientId: process.env.BLOCKSTREAM_CLIENT_ID,
//   clientSecret: process.env.BLOCKSTREAM_CLIENT_SECRET,
//   numberOfBlockConfirmation: 1,
//   defaultFeePerByte: 3,
// });

// bitcoinWithDdk.addProvider(blockstreamProvider);

const esploraProvider = new BitcoinEsploraApiProvider({
  url: 'https://mempool.space/testnet/api',
  network,
}) as any;

bitcoinWithDdk.addProvider(esploraProvider);

const mnemonic = process.env.MNEMONIC || generateMnemonic(256);

// Add wallet provider
bitcoinWithDdk.addProvider(
  new BitcoinJsWalletProvider({
    network,
    mnemonic,
    baseDerivationPath: `m/84'/${network.coinType}'/0'`,
    addressType: bitcoin.AddressType.BECH32,
  }) as any
);

// Add DDK provider
bitcoinWithDdk.addProvider(new BitcoinDdkProvider(network, ddkJs));

console.log(`🌐 Network: ${network.name}`);
// console.log(
//   `🔐 Blockstream Auth: ${blockstreamProvider.isAuthenticationConfigured() ? 'ENABLED' : 'DISABLED'}`
// );
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

    // Get first address without scanning all addresses
    const addresses = await bitcoinWithDdk.getMethod('getAddresses')(0, 1);
    if (!addresses || addresses.length === 0) {
      return res.status(500).json({ error: 'No wallet addresses available' });
    }

    const firstAddress = addresses[0];
    const unspentTransactions = await bitcoinWithDdk.getMethod('getUnspentTransactions')([
      firstAddress.address,
    ]);

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

    // Use DDK client to accept the DLC offer with inputs
    const acceptDlcOfferResponse = await bitcoinWithDdk.dlc.acceptDlcOffer(dlcOffer, inputs);
    const dlcAccept = acceptDlcOfferResponse.dlcAccept;
    const dlcTransactions = acceptDlcOfferResponse.dlcTransactions;

    // Calculate the proper contract ID using the funding transaction
    const fundTxId = dlcTransactions.fundTx.txId.serialize();
    const fundOutputIndex = dlcTransactions.fundTxVout;
    const temporaryContractId = dlcOffer.temporaryContractId;

    const contractId = await bitcoinWithDdk.getMethod('computeContractId')(
      fundTxId,
      fundOutputIndex,
      temporaryContractId
    );

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

    const adaptorPoints = ddkJs.createCetAdaptorPointsFromOracleInfo(
      [
        {
          publicKey: oraclePublicKey,
          nonces: oracleNonces,
        },
      ],
      transformedMsgsForDdk
    );

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
      const sortedInputs = [...allInputs].sort((a, b) => Number(a.inputSerialId - b.inputSerialId));

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
      console.log('🔍 Step 1: Calling VerifyCetAdaptorAndRefundSigs...');
      try {
        await bitcoinWithDdk.getMethod('VerifyCetAdaptorAndRefundSigs')(
          dlcState.offer,
          dlcState.accept,
          dlcSign,
          dlcState.transactions,
          [], // messagesList - will be generated internally
          false // isOfferer = false (we're the accepter)
        );
        console.log('✅ Step 1: CET adaptor and refund signature verification passed');
      } catch (step1Error) {
        console.error('❌ Step 1: CET adaptor signature verification failed:', step1Error);
        throw new Error(`CET verification failed: ${step1Error.message}`);
      }

      console.log('🔍 Step 2: Calling VerifyFundingSigsAlt...');
      try {
        await bitcoinWithDdk.getMethod('VerifyFundingSigsAlt')(
          dlcState.offer,
          dlcState.accept,
          dlcSign,
          dlcState.transactions,
          false // isOfferer = false (we're the accepter)
        );
        console.log('✅ Step 2: Funding signature verification passed');
      } catch (step2Error) {
        console.error('❌ Step 2: Funding signature verification failed:', step2Error);
        throw new Error(`Funding signature verification failed: ${step2Error.message}`);
      }

      console.log('🔍 Step 3: Calling CreateFundingSigsAlt...');
      let accepterFundingSignatures;
      try {
        accepterFundingSignatures = await bitcoinWithDdk.getMethod('CreateFundingSigsAlt')(
          dlcState.offer,
          dlcState.accept,
          dlcState.transactions,
          false // isOfferer = false (we're the accepter)
        );
        console.log('✅ Step 3: Accepter funding signatures created');
        console.log(
          'Accepter witness elements count:',
          accepterFundingSignatures.witnessElements?.length || 0
        );
      } catch (step3Error) {
        console.error('❌ Step 3: Accepter funding signature creation failed:', step3Error);
        throw new Error(`Accepter signature creation failed: ${step3Error.message}`);
      }

      console.log('🔍 Step 4: Calling CreateFundingTx...');
      try {
        fundTx = await bitcoinWithDdk.getMethod('CreateFundingTx')(
          dlcState.offer,
          dlcState.accept,
          dlcSign,
          dlcState.transactions,
          accepterFundingSignatures
        );
        console.log('✅ Step 4: Funding transaction created successfully');
      } catch (step4Error) {
        console.error('❌ Step 4: Funding transaction creation failed:', step4Error);
        throw new Error(`Funding transaction creation failed: ${step4Error.message}`);
      }
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
      const sortedInputs = [...allInputs].sort((a, b) => Number(a.inputSerialId - b.inputSerialId));

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
          const utxoResponse = await fetch(`https://mempool.space/testnet/api/tx/${txid}`);
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
                `https://mempool.space/testnet/api/tx/${txid}/outspend/${vout}`
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
    const esploraUrl = 'https://mempool.space/testnet/api';
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
