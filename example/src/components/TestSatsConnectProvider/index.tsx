import {
  DlcAccept,
  DlcOffer,
  DlcSign,
  DlcTransactions,
  OracleAttestation,
  SingleContractInfo,
  SingleOracleInfo,
} from '@node-dlc/messaging';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Button, Card } from '../../App.styles';
import { BitcoinSatsConnectProvider, type SatsConnectAddress } from '../../providers';
import { ErrorMessage } from '../common';

export function TestSatsConnectProvider() {
  // const contractInfo = SingleContractInfo.deserialize(
  //   Buffer.from(
  //     '0000000000000f42400003406136306135323338326437303737373132646566326136396564613362613330396231393539383934346161343539636534313861653533623766623564353800000000000186a0406635353639313930356561396439373635343039303361343638366164343964363535313830333361326438666338383038636135356465326532366532393200000000000000004030323536366564356634313439336332616462366464643562333064623262663831656538633938373362383730373234343934663130366163663532646138000000000000c35000fdd824b560d34dce7dc02b263e12e285ed66b00dcf0b67ca5f02386fe14fbce7d9b5b54337868b49b6d829b63227c4e10fe86b24f4b42b187765c29352ff2cd667a951233a5c57eaced9c70b42c8beaa5d5fad430bd351f82d52b375bcab430699be8a8bfdd82251000160d34dce7dc02b263e12e285ed66b00dcf0b67ca5f02386fe14fbce7d9b5b5436064108cfdd806170003057472756d70066b616d616c61076e6569746865720f7472756d702d76732d6b616d616c61',
  //     'hex',
  //   ),
  // );
  // contractInfo.totalCollateral = BigInt(100000);
  // const oracleAttestation = OracleAttestation.deserialize(
  //   Buffer.from(
  //     'fdd8687a0f7472756d702d76732d6b616d616c613a5c57eaced9c70b42c8beaa5d5fad430bd351f82d52b375bcab430699be8a8b000160d34dce7dc02b263e12e285ed66b00dcf0b67ca5f02386fe14fbce7d9b5b543b5810f69116f4b7924ebca4a02dca743cdb2ff9d261676d641ee17a7603d51fb0001057472756d70',
  //     'hex',
  //   ),
  // );

  const contractInfo = SingleContractInfo.deserialize(
    Buffer.from(
      '0000000000000186a00003406136306135323338326437303737373132646566326136396564613362613330396231393539383934346161343539636534313861653533623766623564353800000000000186a0406635353639313930356561396439373635343039303361343638366164343964363535313830333361326438666338383038636135356465326532366532393200000000000000004030323536366564356634313439336332616462366464643562333064623262663831656538633938373362383730373234343934663130366163663532646138000000000000c35000fdd824b5328684dd21718ceda26369cbd6b807082c90b6e43529e4b6a8b52541fe050182748dfd8cda01f12d9df6fe11a5d45f4140c1a532ae664e0fa2eb61643776b4efd2c9c4adccbdad291dc2d3d25b5a1e5650c0e3840bc30aa54f0035bc7fc614a5fdd822510001328684dd21718ceda26369cbd6b807082c90b6e43529e4b6a8b52541fe0501826064108cfdd806170003057472756d70066b616d616c61076e6569746865720f7472756d702d76732d6b616d616c61',
      'hex',
    ),
  );
  contractInfo.totalCollateral = BigInt(100000);
  const oracleAttestation = OracleAttestation.deserialize(
    Buffer.from(
      'fdd8687a0f7472756d702d76732d6b616d616c61d2c9c4adccbdad291dc2d3d25b5a1e5650c0e3840bc30aa54f0035bc7fc614a50001328684dd21718ceda26369cbd6b807082c90b6e43529e4b6a8b52541fe0501829f476ff965b7f21549e336ba517c9608dcedf894a4b4818d04cd52241aace18d0001057472756d70',
      'hex',
    ),
  );

  const [provider] = useState(() => new BitcoinSatsConnectProvider());

  const [finalizeState, setFinalizeState] = useState<{
    isLoading: boolean;
    txId?: string;
    txHex?: string;
    error?: string;
  }>({ isLoading: false });

  const [broadcastState, setBroadcastState] = useState<{
    isLoading: boolean;
    success?: boolean;
    error?: string;
  }>({ isLoading: false });

  const [executeState, setExecuteState] = useState<{
    isLoading: boolean;
    txId?: string;
    txHex?: string;
    error?: string;
  }>({ isLoading: false });

  const [executeBroadcastState, setExecuteBroadcastState] = useState<{
    isLoading: boolean;
    success?: boolean;
    error?: string;
  }>({ isLoading: false });

  const [executeDirectState, setExecuteDirectState] = useState<{
    isLoading: boolean;
    txId?: string;
    txHex?: string;
    error?: string;
  }>({ isLoading: false });

  const [executeFordefiState, setExecuteFordefiState] = useState<{
    isLoading: boolean;
    txId?: string;
    txHex?: string;
    error?: string;
    debugInfo?: {
      outcomeIndex: number;
      serverAdaptorSigHex: string;
      serverDecryptedSigHex: string;
      fordefiSigHex: string;
      offerPubkeyFirst: boolean;
      witnessScriptHex: string;
    };
  }>({ isLoading: false });

  const { refetch, error, data, isFetching, isError, isSuccess } = useQuery({
    queryKey: ['testSatsConnectProvider'],
    queryFn: async () => {
      const addresses = await provider.getAddresses();
      const paymentAddress = await provider.getPaymentAddress();
      const ordinalsAddress = await provider.getOrdinalsAddress();
      const isConnected = await provider.isConnected();

      // Test DLC functionality - complete flow
      let dlcOffer: DlcOffer | null = null;
      let dlcAcceptHex: string | null = null;
      let dlcTransactionsHex: string | null = null;
      let dlcSign: DlcSign | null = null;
      let contractId: string | null = null;
      let dlcError: string | null = null;
      let adaptorPoints: string[] | null = null;

      try {
        // Log contractInfo being used
        console.log('🔍 ContractInfo being used:');
        console.log('  Total collateral:', contractInfo.totalCollateral.toString(), 'sats');
        console.log('  Serialized:', contractInfo.serialize().toString('hex'));

        // Step 1: Create DLC offer using SatsConnect provider
        dlcOffer = await provider.createDlcOffer(
          contractInfo,
          50000n, // Offer 50,000 sats (50% of total 100,000 sats)
          3n, // 3 sats/vB fee rate
          Math.floor(Date.now() / 1000) + 3600, // CET locktime: 1 hour from now
          Math.floor(Date.now() / 1000) + 86400, // Refund locktime: 24 hours from now
        );

        console.log('DLC offer:', dlcOffer);

        // Step 2: Send DLC offer to backend for acceptance using DDK
        const backendResponse = await fetch('http://localhost:3005/api/dlc/accept', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            dlcOfferHex: dlcOffer.serialize().toString('hex'),
          }),
        });

        if (!backendResponse.ok) {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          const errorData = await backendResponse.json();
          // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
          throw new Error(`Backend error: ${errorData.error}`);
        }

        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const acceptResponse = await backendResponse.json();
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
        dlcAcceptHex = acceptResponse.dlcAcceptHex;
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
        dlcTransactionsHex = acceptResponse.dlcTransactionsHex;
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
        adaptorPoints = acceptResponse.adaptorPoints;
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
        contractId = acceptResponse.contractId;

        if (dlcAcceptHex && dlcTransactionsHex && adaptorPoints) {
          const dlcAccept = DlcAccept.deserialize(Buffer.from(dlcAcceptHex, 'hex'));
          const dlcTransactions = DlcTransactions.deserialize(
            Buffer.from(dlcTransactionsHex, 'hex'),
          );

          dlcSign = await provider.signDlcAccept(
            dlcOffer,
            dlcAccept,
            dlcTransactions,
            adaptorPoints,
            contractId ?? undefined,
          );
        }

        // Output DLC messages as JSON for inspection
        if (dlcOffer && dlcSign && dlcAcceptHex) {
          console.log('=== DLC MESSAGES JSON OUTPUT ===');
          console.log('DLC Offer JSON:', JSON.stringify(dlcOffer.toJSON(), null, 2));
          console.log('DLC Offer Hex:', dlcOffer.serialize().toString('hex'));

          const dlcAccept = DlcAccept.deserialize(Buffer.from(dlcAcceptHex, 'hex'));
          console.log('DLC Accept JSON:', JSON.stringify(dlcAccept.toJSON(), null, 2));
          console.log('DLC Accept Hex:', dlcAccept.serialize().toString('hex'));

          console.log('DLC Sign JSON:', JSON.stringify(dlcSign.toJSON(), null, 2));
          console.log('DLC Sign Hex:', dlcSign.serialize().toString('hex'));
          console.log('=== END DLC MESSAGES ===');
        }

        console.log('dlcSign', dlcSign);
      } catch (error: unknown) {
        dlcError = error instanceof Error ? error.message : 'Unknown error';
      }

      return {
        allAddresses: addresses,
        paymentAddress,
        ordinalsAddress,
        isConnected,
        dlcOffer,
        dlcAcceptHex,
        dlcTransactionsHex,
        dlcSign,
        contractId,
        dlcError,
      };
    },
    enabled: false,
  });

  const handleFinalize = async () => {
    if (!data?.dlcSign || !data?.contractId) {
      setFinalizeState({ isLoading: false, error: 'No DLC sign or contract ID available' });
      return;
    }

    setFinalizeState({ isLoading: true });

    try {
      const response = await fetch('http://localhost:3005/api/dlc/finalize', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contractId: data.contractId,
          dlcSignHex: data.dlcSign.serialize().toString('hex'),
        }),
      });

      if (!response.ok) {
        const errorData = (await response.json()) as { error: string };
        throw new Error(`Backend error: ${errorData.error}`);
      }

      const result = (await response.json()) as { txId: string; txHex: string };
      setFinalizeState({
        isLoading: false,
        txId: result.txId,
        txHex: result.txHex,
      });
    } catch (error: unknown) {
      setFinalizeState({
        isLoading: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  };

  const handleBroadcast = async () => {
    if (!finalizeState.txHex) {
      setBroadcastState({ isLoading: false, error: 'No transaction hex available' });
      return;
    }

    setBroadcastState({ isLoading: true });

    try {
      const response = await fetch('http://localhost:3005/api/dlc/broadcast', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          txHex: finalizeState.txHex,
        }),
      });

      if (!response.ok) {
        const errorData = (await response.json()) as { error: string };
        throw new Error(`Backend error: ${errorData.error}`);
      }

      setBroadcastState({ isLoading: false, success: true });
    } catch (error: unknown) {
      setBroadcastState({
        isLoading: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  };

  const handleExecute = async () => {
    if (!data?.contractId) {
      setExecuteState({ isLoading: false, error: 'No contract ID available' });
      return;
    }

    setExecuteState({ isLoading: true });

    try {
      const response = await fetch('http://localhost:3005/api/dlc/execute', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contractId: data.contractId,
          oracleAttestationHex: oracleAttestation.serialize().toString('hex'),
        }),
      });

      if (!response.ok) {
        const errorData = (await response.json()) as { error: string };
        throw new Error(`Backend error: ${errorData.error}`);
      }

      const result = (await response.json()) as { txId: string; txHex: string };
      setExecuteState({
        isLoading: false,
        txId: result.txId,
        txHex: result.txHex,
      });
    } catch (error: unknown) {
      setExecuteState({
        isLoading: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  };

  const handleExecuteBroadcast = async () => {
    if (!executeState.txHex) {
      setExecuteBroadcastState({
        isLoading: false,
        error: 'No execution transaction hex available',
      });
      return;
    }

    setExecuteBroadcastState({ isLoading: true });

    try {
      const response = await fetch('http://localhost:3005/api/dlc/broadcast', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          txHex: executeState.txHex,
        }),
      });

      if (!response.ok) {
        const errorData = (await response.json()) as { error: string };
        throw new Error(`Backend error: ${errorData.error}`);
      }

      setExecuteBroadcastState({ isLoading: false, success: true });
    } catch (error: unknown) {
      setExecuteBroadcastState({
        isLoading: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  };

  // Direct execute - skips verification and tries to decrypt/sign directly
  const handleExecuteDirect = async () => {
    if (!data?.contractId) {
      setExecuteDirectState({ isLoading: false, error: 'No contract ID available' });
      return;
    }

    setExecuteDirectState({ isLoading: true });

    try {
      const response = await fetch('http://localhost:3005/api/dlc/execute-direct', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contractId: data.contractId,
          oracleAttestationHex: oracleAttestation.serialize().toString('hex'),
        }),
      });

      if (!response.ok) {
        const errorData = (await response.json()) as { error: string; details?: string };
        throw new Error(`Backend error: ${errorData.error} - ${errorData.details ?? ''}`);
      }

      const result = (await response.json()) as { txId: string; txHex: string };
      setExecuteDirectState({
        isLoading: false,
        txId: result.txId,
        txHex: result.txHex,
      });
    } catch (error: unknown) {
      setExecuteDirectState({
        isLoading: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  };

  // Execute with Fordefi - Fordefi signs CET via signPsbt, server decrypts adaptor sig
  const handleExecuteWithFordefi = async () => {
    if (!data?.contractId || !data?.dlcOffer || !data?.dlcAcceptHex || !data?.dlcTransactionsHex) {
      setExecuteFordefiState({ isLoading: false, error: 'Missing DLC data' });
      return;
    }

    setExecuteFordefiState({ isLoading: true });

    try {
      const dlcAccept = DlcAccept.deserialize(Buffer.from(data.dlcAcceptHex, 'hex'));
      const dlcTransactions = DlcTransactions.deserialize(
        Buffer.from(data.dlcTransactionsHex, 'hex'),
      );

      // The attested outcome maps to CET index 0 (trump wins = index 0)
      const outcomeIndex = 0;

      console.log('🔍 Execute with Fordefi:');
      console.log('  Outcome index:', outcomeIndex);
      console.log('  Attested outcome:', oracleAttestation.outcomes[0]);

      // 2. Sign CET with Fordefi using signPsbt
      const fordefiSig = await provider.signCetForExecution(
        data.dlcOffer,
        dlcAccept,
        dlcTransactions,
        outcomeIndex,
      );

      console.log('  Fordefi signature:', fordefiSig.toString('hex'));

      // 3. Send to backend to combine with server's decrypted adaptor sig
      const response = await fetch('http://localhost:3005/api/dlc/execute-with-fordefi', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contractId: data.contractId,
          oracleAttestationHex: oracleAttestation.serialize().toString('hex'),
          fordefiSignature: fordefiSig.toString('hex'),
        }),
      });

      if (!response.ok) {
        const errorData = (await response.json()) as { error: string; details?: string };
        throw new Error(`Backend error: ${errorData.error} - ${errorData.details ?? ''}`);
      }

      const result = (await response.json()) as {
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
      };

      console.log('✅ Execute with Fordefi result:', result);

      setExecuteFordefiState({
        isLoading: false,
        txId: result.txId,
        txHex: result.txHex,
        debugInfo: result.debugInfo,
      });
    } catch (error: unknown) {
      console.error('❌ Execute with Fordefi failed:', error);
      setExecuteFordefiState({
        isLoading: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  };

  return (
    <Card>
      <h3>Test SatsConnect Provider</h3>
      <p>
        Test complete DLC flow: SatsConnect creates offer → Backend (DDK) accepts → Sign → Finalize
        → Broadcast → Execute with Oracle → Broadcast Execution
      </p>

      <Button
        onClick={() => {
          refetch().catch(console.error);
        }}
      >
        Test Complete DLC Flow (Offer → Accept → Sign)
      </Button>

      {(() => {
        if (isFetching) {
          return <p>Loading...</p>;
        }

        if (isError) {
          console.error(error);
          return <ErrorMessage>Error: {error?.message || 'Unknown error'}</ErrorMessage>;
        }

        if (isSuccess && data) {
          return (
            <div style={{ marginTop: '1rem' }}>
              <h4>Provider Test Results:</h4>

              <div style={{ marginBottom: '1rem' }}>
                <strong>Connection Status:</strong>{' '}
                {data.isConnected ? '✅ Connected' : '❌ Not Connected'}
              </div>

              <div style={{ marginBottom: '1rem' }}>
                <strong>Payment Address:</strong>
                <div style={{ fontSize: '0.9em', wordBreak: 'break-all', marginTop: '0.5rem' }}>
                  Address: {data.paymentAddress.address}
                </div>
                {data.paymentAddress.publicKey && (
                  <div style={{ fontSize: '0.8em', color: '#888', marginTop: '0.25rem' }}>
                    Public Key: {data.paymentAddress.publicKey}
                  </div>
                )}
              </div>

              <div style={{ marginBottom: '1rem' }}>
                <strong>Ordinals Address:</strong>
                <div style={{ fontSize: '0.9em', wordBreak: 'break-all', marginTop: '0.5rem' }}>
                  Address: {data.ordinalsAddress.address}
                </div>
                {data.ordinalsAddress.publicKey && (
                  <div style={{ fontSize: '0.8em', color: '#888', marginTop: '0.25rem' }}>
                    Public Key: {data.ordinalsAddress.publicKey}
                  </div>
                )}
              </div>

              <div>
                <strong>All Addresses ({data.allAddresses.length}):</strong>
                {data.allAddresses.map((addr: SatsConnectAddress, index: number) => (
                  <div
                    key={index}
                    style={{
                      marginTop: '0.5rem',
                      padding: '0.75rem',
                      backgroundColor: '#2a2a2a',
                      borderRadius: '4px',
                      fontSize: '0.85em',
                      color: '#ffffff',
                    }}
                  >
                    <div>
                      <strong>Purpose:</strong> {addr.purpose}
                    </div>
                    <div>
                      <strong>Address:</strong> {addr.address}
                    </div>
                    {addr.publicKey && (
                      <div>
                        <strong>Public Key:</strong> {addr.publicKey}
                      </div>
                    )}
                    {addr.derivationPath && (
                      <div>
                        <strong>Derivation Path:</strong> {addr.derivationPath}
                      </div>
                    )}
                  </div>
                ))}
              </div>

              <div style={{ marginTop: '1.5rem', borderTop: '1px solid #ddd', paddingTop: '1rem' }}>
                <h4>🔒 DLC Test Results:</h4>

                {data.dlcError ? (
                  <div style={{ color: '#d73a49', marginBottom: '1rem' }}>
                    <strong>❌ DLC Error:</strong> {data.dlcError}
                  </div>
                ) : (
                  <>
                    <div style={{ marginBottom: '1rem' }}>
                      <strong>✅ DLC Offer Created Successfully!</strong>
                    </div>

                    <div style={{ marginBottom: '1rem' }}>
                      <strong>Contract Info:</strong>
                      <div
                        style={{
                          marginTop: '0.5rem',
                          padding: '0.75rem',
                          backgroundColor: '#2a2a2a',
                          borderRadius: '4px',
                          fontSize: '0.85em',
                          color: '#ffffff',
                        }}
                      >
                        <div>
                          <strong>Total Collateral:</strong>{' '}
                          {contractInfo.totalCollateral.toString()} sats
                        </div>
                        <div>
                          <strong>Contract Type:</strong> Single Contract (Enum)
                        </div>
                        <div>
                          <strong>Event ID:</strong>{' '}
                          {
                            (contractInfo.oracleInfo as SingleOracleInfo).announcement.oracleEvent
                              .eventId
                          }
                        </div>
                        <div>
                          <strong>Event Maturity:</strong>{' '}
                          {new Date(
                            (contractInfo.oracleInfo as SingleOracleInfo).announcement.oracleEvent
                              .eventMaturityEpoch * 1000,
                          ).toLocaleString()}
                        </div>
                        <div>
                          <strong>Oracle Pubkey:</strong>{' '}
                          {(
                            contractInfo.oracleInfo as SingleOracleInfo
                          ).announcement.oraclePublicKey.toString('hex')}
                        </div>
                      </div>
                    </div>

                    {data.dlcOffer && (
                      <div style={{ marginBottom: '1rem' }}>
                        <strong>DLC Offer Details:</strong>
                        <div
                          style={{
                            marginTop: '0.5rem',
                            padding: '0.75rem',
                            backgroundColor: '#2a2a2a',
                            borderRadius: '4px',
                            fontSize: '0.85em',
                            color: '#ffffff',
                          }}
                        >
                          <div>
                            <strong>Contract ID:</strong>{' '}
                            {data.dlcOffer.temporaryContractId.toString('hex')}
                          </div>
                          <div>
                            <strong>Offer Collateral:</strong>{' '}
                            {data.dlcOffer.offerCollateral.toString()} sats
                          </div>
                          <div>
                            <strong>Fee Rate:</strong> {data.dlcOffer.feeRatePerVb.toString()}{' '}
                            sats/vB
                          </div>
                          <div>
                            <strong>CET Locktime:</strong>{' '}
                            {new Date(data.dlcOffer.cetLocktime * 1000).toLocaleString()}
                          </div>
                          <div>
                            <strong>Refund Locktime:</strong>{' '}
                            {new Date(data.dlcOffer.refundLocktime * 1000).toLocaleString()}
                          </div>
                          <div>
                            <strong>Funding Inputs:</strong> {data.dlcOffer.fundingInputs.length}
                          </div>
                          <div>
                            <strong>Funding Pubkey:</strong>{' '}
                            {data.dlcOffer.fundingPubkey.toString('hex')}
                          </div>
                          <div>
                            <strong>Payout SPK:</strong> {data.dlcOffer.payoutSpk.toString('hex')}
                          </div>
                        </div>
                      </div>
                    )}

                    {data.dlcAcceptHex && data.contractId && (
                      <div style={{ marginBottom: '1rem' }}>
                        <strong>✅ DLC Accept Received from Backend!</strong>
                        <div
                          style={{
                            marginTop: '0.5rem',
                            padding: '0.75rem',
                            backgroundColor: '#2a2a2a',
                            borderRadius: '4px',
                            fontSize: '0.85em',
                            color: '#ffffff',
                          }}
                        >
                          <div>
                            <strong>Contract ID:</strong> {data.contractId}
                          </div>
                          <div>
                            <strong>DLC Accept Hex:</strong>{' '}
                            <span style={{ wordBreak: 'break-all', fontFamily: 'monospace' }}>
                              {data.dlcAcceptHex.substring(0, 64)}...
                            </span>
                          </div>
                          <div style={{ marginTop: '0.5rem', fontStyle: 'italic' }}>
                            🎯 Ready for next step: Sign the accept with SatsConnect wallet
                          </div>
                        </div>
                      </div>
                    )}

                    {data.dlcSign && (
                      <div style={{ marginBottom: '1rem' }}>
                        <strong>✅ DLC Sign Created Successfully!</strong>
                        <div
                          style={{
                            marginTop: '0.5rem',
                            padding: '0.75rem',
                            backgroundColor: '#2a2a2a',
                            borderRadius: '4px',
                            fontSize: '0.85em',
                            color: '#ffffff',
                          }}
                        >
                          <div>
                            <strong>Contract ID:</strong> {data.dlcSign.contractId.toString('hex')}
                          </div>

                          {/* DLC Message Copy Buttons */}
                          <div style={{ marginTop: '0.5rem', marginBottom: '0.5rem' }}>
                            <strong>DLC Messages:</strong>
                            <div
                              style={{
                                display: 'flex',
                                gap: '0.5rem',
                                marginTop: '0.25rem',
                                flexWrap: 'wrap',
                              }}
                            >
                              <Button
                                onClick={() => {
                                  const offerHex = data.dlcOffer?.serialize()?.toString('hex');
                                  if (offerHex) {
                                    navigator.clipboard.writeText(offerHex).catch(console.error);
                                    alert('DLC Offer hex copied to clipboard!');
                                  }
                                }}
                                style={{ fontSize: '0.8em', padding: '0.25rem 0.5rem' }}
                              >
                                Copy Offer Hex
                              </Button>
                              <Button
                                onClick={() => {
                                  if (data.dlcAcceptHex) {
                                    navigator.clipboard
                                      .writeText(data.dlcAcceptHex)
                                      .catch(console.error);
                                    alert('DLC Accept hex copied to clipboard!');
                                  }
                                }}
                                style={{ fontSize: '0.8em', padding: '0.25rem 0.5rem' }}
                              >
                                Copy Accept Hex
                              </Button>
                              <Button
                                onClick={() => {
                                  const signHex = data.dlcSign?.serialize()?.toString('hex');
                                  if (signHex) {
                                    navigator.clipboard.writeText(signHex).catch(console.error);
                                    alert('DLC Sign hex copied to clipboard!');
                                  }
                                }}
                                style={{ fontSize: '0.8em', padding: '0.25rem 0.5rem' }}
                              >
                                Copy Sign Hex
                              </Button>
                            </div>
                          </div>

                          {/* JSON Output */}
                          <details style={{ marginTop: '0.5rem', marginBottom: '0.5rem' }}>
                            <summary style={{ cursor: 'pointer', fontWeight: 'bold' }}>
                              View DLC Messages as JSON
                            </summary>
                            <div style={{ marginTop: '0.5rem' }}>
                              <div style={{ marginBottom: '0.5rem' }}>
                                <strong>DLC Offer JSON:</strong>
                                <pre
                                  style={{
                                    backgroundColor: '#1a1a1a',
                                    padding: '0.5rem',
                                    borderRadius: '4px',
                                    fontSize: '0.7em',
                                    overflow: 'auto',
                                    maxHeight: '200px',
                                    marginTop: '0.25rem',
                                    border: '1px solid #444',
                                  }}
                                >
                                  {data.dlcOffer
                                    ? JSON.stringify(data.dlcOffer.toJSON(), null, 2)
                                    : 'N/A'}
                                </pre>
                                <Button
                                  onClick={() => {
                                    const json = data.dlcOffer
                                      ? JSON.stringify(data.dlcOffer.toJSON(), null, 2)
                                      : '';
                                    if (json) {
                                      navigator.clipboard.writeText(json).catch(console.error);
                                      alert('DLC Offer JSON copied to clipboard!');
                                    }
                                  }}
                                  style={{
                                    fontSize: '0.7em',
                                    padding: '0.2rem 0.4rem',
                                    marginTop: '0.25rem',
                                  }}
                                >
                                  Copy JSON
                                </Button>
                              </div>

                              <div style={{ marginBottom: '0.5rem' }}>
                                <strong>DLC Accept JSON:</strong>
                                <pre
                                  style={{
                                    backgroundColor: '#1a1a1a',
                                    padding: '0.5rem',
                                    borderRadius: '4px',
                                    fontSize: '0.7em',
                                    overflow: 'auto',
                                    maxHeight: '200px',
                                    marginTop: '0.25rem',
                                    border: '1px solid #444',
                                  }}
                                >
                                  {data.dlcAcceptHex
                                    ? JSON.stringify(
                                        DlcAccept.deserialize(
                                          Buffer.from(data.dlcAcceptHex, 'hex'),
                                        ).toJSON(),
                                        null,
                                        2,
                                      )
                                    : 'N/A'}
                                </pre>
                                <Button
                                  onClick={() => {
                                    if (data.dlcAcceptHex) {
                                      const json = JSON.stringify(
                                        DlcAccept.deserialize(
                                          Buffer.from(data.dlcAcceptHex, 'hex'),
                                        ).toJSON(),
                                        null,
                                        2,
                                      );
                                      navigator.clipboard.writeText(json).catch(console.error);
                                      alert('DLC Accept JSON copied to clipboard!');
                                    }
                                  }}
                                  style={{
                                    fontSize: '0.7em',
                                    padding: '0.2rem 0.4rem',
                                    marginTop: '0.25rem',
                                  }}
                                >
                                  Copy JSON
                                </Button>
                              </div>

                              <div style={{ marginBottom: '0.5rem' }}>
                                <strong>DLC Sign JSON:</strong>
                                <pre
                                  style={{
                                    backgroundColor: '#1a1a1a',
                                    padding: '0.5rem',
                                    borderRadius: '4px',
                                    fontSize: '0.7em',
                                    overflow: 'auto',
                                    maxHeight: '200px',
                                    marginTop: '0.25rem',
                                    border: '1px solid #444',
                                  }}
                                >
                                  {data.dlcSign
                                    ? JSON.stringify(data.dlcSign.toJSON(), null, 2)
                                    : 'N/A'}
                                </pre>
                                <Button
                                  onClick={() => {
                                    const json = data.dlcSign
                                      ? JSON.stringify(data.dlcSign.toJSON(), null, 2)
                                      : '';
                                    if (json) {
                                      navigator.clipboard.writeText(json).catch(console.error);
                                      alert('DLC Sign JSON copied to clipboard!');
                                    }
                                  }}
                                  style={{
                                    fontSize: '0.7em',
                                    padding: '0.2rem 0.4rem',
                                    marginTop: '0.25rem',
                                  }}
                                >
                                  Copy JSON
                                </Button>
                              </div>
                            </div>
                          </details>

                          <div style={{ marginTop: '0.5rem' }}>
                            <Button
                              onClick={() => {
                                handleFinalize().catch(console.error);
                              }}
                              disabled={finalizeState.isLoading}
                              style={{ marginRight: '0.5rem' }}
                            >
                              {finalizeState.isLoading ? 'Finalizing...' : 'Finalize DLC'}
                            </Button>
                            {finalizeState.txHex && (
                              <Button
                                onClick={() => {
                                  handleBroadcast().catch(console.error);
                                }}
                                disabled={broadcastState.isLoading}
                              >
                                {broadcastState.isLoading
                                  ? 'Broadcasting...'
                                  : 'Broadcast Transaction'}
                              </Button>
                            )}
                          </div>
                          {finalizeState.error && (
                            <div style={{ color: '#d73a49', marginTop: '0.5rem' }}>
                              <strong>Finalize Error:</strong> {finalizeState.error}
                            </div>
                          )}
                          {finalizeState.txId && (
                            <div style={{ marginTop: '0.5rem' }}>
                              <strong>✅ Transaction Finalized!</strong>
                              <div style={{ fontSize: '0.8em', marginTop: '0.25rem' }}>
                                TX ID: {finalizeState.txId}
                                TX Hex: {finalizeState.txHex}
                              </div>
                            </div>
                          )}
                          {broadcastState.success && (
                            <div style={{ color: '#28a745', marginTop: '0.5rem' }}>
                              <strong>✅ Transaction Broadcast Successfully!</strong>
                            </div>
                          )}
                          {broadcastState.error && (
                            <div style={{ color: '#d73a49', marginTop: '0.5rem' }}>
                              <strong>Broadcast Error:</strong> {broadcastState.error}
                            </div>
                          )}
                        </div>
                      </div>
                    )}

                    {broadcastState.success && (
                      <div style={{ marginBottom: '1rem' }}>
                        <strong>🎯 DLC Ready for Execution!</strong>
                        <div
                          style={{
                            marginTop: '0.5rem',
                            padding: '0.75rem',
                            backgroundColor: '#2a2a2a',
                            borderRadius: '4px',
                            fontSize: '0.85em',
                            color: '#ffffff',
                          }}
                        >
                          <div style={{ marginBottom: '0.5rem' }}>
                            The funding transaction has been broadcast. You can now execute the DLC
                            using the oracle attestation.
                          </div>
                          <div style={{ marginTop: '0.5rem', display: 'flex', gap: '0.5rem' }}>
                            <Button
                              onClick={() => {
                                handleExecute().catch(console.error);
                              }}
                              disabled={executeState.isLoading}
                            >
                              {executeState.isLoading ? 'Executing...' : 'Execute DLC'}
                            </Button>
                            <Button
                              onClick={() => {
                                handleExecuteDirect().catch(console.error);
                              }}
                              disabled={executeDirectState.isLoading}
                              style={{ backgroundColor: '#ff9800' }}
                            >
                              {executeDirectState.isLoading
                                ? 'Direct Executing...'
                                : 'Execute Direct (Skip Verify)'}
                            </Button>
                            <Button
                              onClick={() => {
                                handleExecuteWithFordefi().catch(console.error);
                              }}
                              disabled={executeFordefiState.isLoading}
                              style={{ backgroundColor: '#4CAF50' }}
                            >
                              {executeFordefiState.isLoading
                                ? 'Signing with Fordefi...'
                                : 'Execute with Fordefi'}
                            </Button>
                          </div>
                          {executeState.error && (
                            <div style={{ color: '#d73a49', marginTop: '0.5rem' }}>
                              <strong>Execute Error:</strong> {executeState.error}
                            </div>
                          )}
                          {executeDirectState.error && (
                            <div style={{ color: '#d73a49', marginTop: '0.5rem' }}>
                              <strong>Direct Execute Error:</strong> {executeDirectState.error}
                            </div>
                          )}
                          {executeDirectState.txId && (
                            <div style={{ color: '#28a745', marginTop: '0.5rem' }}>
                              <strong>✅ Direct Execution Succeeded!</strong>
                              <div style={{ fontSize: '0.8em', marginTop: '0.25rem' }}>
                                TX ID: {executeDirectState.txId}
                              </div>
                              <div
                                style={{
                                  fontSize: '0.7em',
                                  marginTop: '0.25rem',
                                  wordBreak: 'break-all',
                                }}
                              >
                                TX Hex: {executeDirectState.txHex?.substring(0, 100)}...
                              </div>
                            </div>
                          )}
                          {executeFordefiState.error && (
                            <div style={{ color: '#d73a49', marginTop: '0.5rem' }}>
                              <strong>Fordefi Execute Error:</strong> {executeFordefiState.error}
                            </div>
                          )}
                          {executeFordefiState.txId && (
                            <div style={{ color: '#28a745', marginTop: '0.5rem' }}>
                              <strong>✅ Fordefi Execution Succeeded!</strong>
                              <div style={{ fontSize: '0.8em', marginTop: '0.25rem' }}>
                                TX ID: {executeFordefiState.txId}
                              </div>
                              <div
                                style={{
                                  fontSize: '0.7em',
                                  marginTop: '0.25rem',
                                  wordBreak: 'break-all',
                                }}
                              >
                                TX Hex: {executeFordefiState.txHex?.substring(0, 100)}...
                              </div>
                              {executeFordefiState.debugInfo && (
                                <details style={{ marginTop: '0.5rem' }}>
                                  <summary style={{ cursor: 'pointer', fontWeight: 'bold' }}>
                                    Debug Info
                                  </summary>
                                  <pre
                                    style={{
                                      backgroundColor: '#1a1a1a',
                                      padding: '0.5rem',
                                      borderRadius: '4px',
                                      fontSize: '0.7em',
                                      overflow: 'auto',
                                      maxHeight: '200px',
                                      marginTop: '0.25rem',
                                    }}
                                  >
                                    {JSON.stringify(executeFordefiState.debugInfo, null, 2)}
                                  </pre>
                                </details>
                              )}
                            </div>
                          )}
                          {executeState.txId && (
                            <div style={{ marginTop: '0.5rem' }}>
                              <strong>✅ DLC Executed Successfully!</strong>
                              <div style={{ fontSize: '0.8em', marginTop: '0.25rem' }}>
                                Execution TX ID: {executeState.txId}
                              </div>
                              <div
                                style={{
                                  fontSize: '0.8em',
                                  marginTop: '0.25rem',
                                  color: '#28a745',
                                }}
                              >
                                🎉 DLC contract completed! The oracle attestation determined the
                                outcome and funds have been distributed accordingly.
                              </div>
                              <div style={{ marginTop: '0.5rem' }}>
                                <Button
                                  onClick={() => {
                                    handleExecuteBroadcast().catch(console.error);
                                  }}
                                  disabled={executeBroadcastState.isLoading}
                                >
                                  {executeBroadcastState.isLoading
                                    ? 'Broadcasting Execution...'
                                    : 'Broadcast Execution Transaction'}
                                </Button>
                              </div>
                              {executeBroadcastState.success && (
                                <div style={{ color: '#28a745', marginTop: '0.5rem' }}>
                                  <strong>✅ Execution Transaction Broadcast Successfully!</strong>
                                  <div style={{ fontSize: '0.8em', marginTop: '0.25rem' }}>
                                    🏆 DLC fully settled on-chain! The contract has been executed
                                    and funds distributed based on the oracle outcome.
                                  </div>
                                </div>
                              )}
                              {executeBroadcastState.error && (
                                <div style={{ color: '#d73a49', marginTop: '0.5rem' }}>
                                  <strong>Execution Broadcast Error:</strong>{' '}
                                  {executeBroadcastState.error}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    )}

                    <div style={{ marginBottom: '1rem' }}>
                      <strong>Available Oracle Attestation:</strong>
                      <div
                        style={{
                          marginTop: '0.5rem',
                          padding: '0.75rem',
                          backgroundColor: '#2a2a2a',
                          borderRadius: '4px',
                          fontSize: '0.85em',
                          color: '#ffffff',
                        }}
                      >
                        <div>
                          <strong>Event ID:</strong> {oracleAttestation.eventId}
                        </div>
                        <div>
                          <strong>Oracle Pubkey:</strong>{' '}
                          {oracleAttestation.oraclePublicKey.toString('hex')}
                        </div>
                        <div>
                          <strong>Outcomes:</strong> {oracleAttestation.outcomes.join(', ')}
                        </div>
                        <div>
                          <strong>Signatures:</strong> {oracleAttestation.signatures.length}
                        </div>
                      </div>
                    </div>
                  </>
                )}
              </div>

              <details style={{ marginTop: '1rem' }}>
                <summary>Raw Data (Click to expand)</summary>
                <pre
                  style={{
                    backgroundColor: '#f0f0f0',
                    padding: '1rem',
                    borderRadius: '4px',
                    fontSize: '0.8em',
                    overflow: 'auto',
                    marginTop: '0.5rem',
                  }}
                >
                  {JSON.stringify(data, null, 2)}
                </pre>
              </details>
            </div>
          );
        }
      })()}
    </Card>
  );
}
