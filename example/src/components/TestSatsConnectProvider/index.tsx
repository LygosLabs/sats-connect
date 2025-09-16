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
  const contractInfo = SingleContractInfo.deserialize(
    Buffer.from(
      '0000000000000f42400003406136306135323338326437303737373132646566326136396564613362613330396231393539383934346161343539636534313861653533623766623564353800000000000186a0406635353639313930356561396439373635343039303361343638366164343964363535313830333361326438666338383038636135356465326532366532393200000000000000004030323536366564356634313439336332616462366464643562333064623262663831656538633938373362383730373234343934663130366163663532646138000000000000c35000fdd824b560d34dce7dc02b263e12e285ed66b00dcf0b67ca5f02386fe14fbce7d9b5b54337868b49b6d829b63227c4e10fe86b24f4b42b187765c29352ff2cd667a951233a5c57eaced9c70b42c8beaa5d5fad430bd351f82d52b375bcab430699be8a8bfdd82251000160d34dce7dc02b263e12e285ed66b00dcf0b67ca5f02386fe14fbce7d9b5b5436064108cfdd806170003057472756d70066b616d616c61076e6569746865720f7472756d702d76732d6b616d616c61',
      'hex',
    ),
  );
  contractInfo.totalCollateral = BigInt(100000);
  const oracleAttestation = OracleAttestation.deserialize(
    Buffer.from(
      'fdd8687a0f7472756d702d76732d6b616d616c613a5c57eaced9c70b42c8beaa5d5fad430bd351f82d52b375bcab430699be8a8b000160d34dce7dc02b263e12e285ed66b00dcf0b67ca5f02386fe14fbce7d9b5b543b5810f69116f4b7924ebca4a02dca743cdb2ff9d261676d641ee17a7603d51fb0001057472756d70',
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
        const backendResponse = await fetch('http://localhost:3001/api/dlc/accept', {
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
      const response = await fetch('http://localhost:3001/api/dlc/finalize', {
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
      const response = await fetch('http://localhost:3001/api/dlc/broadcast', {
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
      const response = await fetch('http://localhost:3001/api/dlc/execute', {
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
      const response = await fetch('http://localhost:3001/api/dlc/broadcast', {
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
                          ).announcement.oraclePubkey.toString('hex')}
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
                          <div style={{ marginTop: '0.5rem' }}>
                            <Button
                              onClick={() => {
                                handleExecute().catch(console.error);
                              }}
                              disabled={executeState.isLoading}
                            >
                              {executeState.isLoading ? 'Executing...' : 'Execute DLC'}
                            </Button>
                          </div>
                          {executeState.error && (
                            <div style={{ color: '#d73a49', marginTop: '0.5rem' }}>
                              <strong>Execute Error:</strong> {executeState.error}
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
                          {oracleAttestation.oraclePubkey.toString('hex')}
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
