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

    // Store the sign
    dlcState.sign = dlcSign;
    dlcStore.set(contractId, dlcState);

    console.log('🔍 Calling finalizeDlcSign...');
    let fundTx;
    try {
      // Use DDK client to finalize and broadcast
      fundTx = await bitcoinWithDdk.dlc.finalizeDlcSign(
        dlcState.offer,
        dlcState.accept,
        dlcSign,
        dlcState.transactions
      );
      console.log('✅ finalizeDlcSign completed successfully');
    } catch (finalizeError) {
      console.error('❌ finalizeDlcSign error:', finalizeError);
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
    const broadcastResponse = await fetch(`${esploraProvider.url}/tx`, {
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
