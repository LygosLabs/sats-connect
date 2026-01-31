// Main provider - using NewBitcoinSatsConnectProvider as the default
export { NewBitcoinSatsConnectProvider as BitcoinSatsConnectProvider } from './NewBitcoinSatsConnectProvider';
export { NewBitcoinSatsConnectProvider } from './NewBitcoinSatsConnectProvider';

// Wallet adapters
export { SatsConnectWalletAdapter } from './SatsConnectWalletAdapter';

// DdkBackendClient for backend operations
export {
  DdkBackendClient,
  type DdkBackendClientInterface,
  type DlcAcceptResponse,
  type DlcFinalizeResponse,
  type DlcBroadcastResponse,
  type DlcExecuteResponse,
  type DlcExecuteWithFordefiResponse,
  type AdaptorPointsResponse,
} from './DdkBackendClient';

// Types
export {
  // Enums
  AddressPurpose,
  // Classes
  WalletClient,
  // Types
  type Input,
  type SatsConnectAddress,
  type SatsConnectResponse,
  type SignDlcResult,
  type SatsConnectWalletAddress,
  type BitcoinSatsConnectProviderOptions,
  type WalletInterface,
  type DlcSignOfferParams,
  type DlcSignOfferResult,
  type SignPsbtResult,
  type GetAddressesResult,
  type GetAccountResult,
  type WalletClientInterface,
  type DdkInterface,
  type DdkOracleInfo,
  type DdkTransaction,
} from './types';
