import BitcoinDdkProvider from '@atomicfinance/bitcoin-ddk-provider';
import { BitcoinEsploraApiProvider } from '@atomicfinance/bitcoin-esplora-api-provider';
import { BitcoinJsWalletProvider } from '@atomicfinance/bitcoin-js-wallet-provider';
import { Client } from '@atomicfinance/client';
import { bitcoin, Input } from '@atomicfinance/types';
import * as ddkJs from '@bennyblader/ddk-ts';
import { DlcAccept, DlcOffer, DlcSign } from '@node-dlc/messaging';
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
console.log(
  `🔐 Blockstream Auth: ${blockstreamProvider.isAuthenticationConfigured() ? 'ENABLED' : 'DISABLED'}`
);
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

    const contractId = dlcOffer.temporaryContractId.toString('hex');

    // Store the state including transactions
    dlcStore.set(contractId, {
      offer: dlcOffer,
      accept: dlcAccept,
      transactions: dlcTransactions,
    });

    res.json({
      dlcAcceptHex: dlcAccept.serialize().toString('hex'),
      dlcTransactionsHex: dlcTransactions.serialize().toString('hex'),
      contractId,
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

    // Store the sign
    dlcState.sign = dlcSign;
    dlcStore.set(contractId, dlcState);

    // Use DDK client to finalize and broadcast
    const fundTx = await bitcoinWithDdk.dlc.finalizeDlcSign(
      dlcState.offer,
      dlcState.accept,
      dlcSign,
      dlcState.transactions
    );

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
