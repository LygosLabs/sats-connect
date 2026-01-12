import { useState } from 'react';
import { Button, Card } from '../../App.styles';
import { ErrorMessage } from '../common';

export function ManualDlcFinalize() {
  const [dlcOfferHex, setDlcOfferHex] = useState('');
  const [dlcAcceptHex, setDlcAcceptHex] = useState('');
  const [dlcSignHex, setDlcSignHex] = useState('');

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

  const handleManualFinalize = async () => {
    if (!dlcOfferHex || !dlcAcceptHex || !dlcSignHex) {
      setFinalizeState({
        isLoading: false,
        error: 'All three DLC messages (Offer, Accept, Sign) are required',
      });
      return;
    }

    setFinalizeState({ isLoading: true });

    try {
      const response = await fetch('http://localhost:3005/api/dlc/manual-finalize', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          dlcOfferHex: dlcOfferHex.trim(),
          dlcAcceptHex: dlcAcceptHex.trim(),
          dlcSignHex: dlcSignHex.trim(),
        }),
      });

      if (!response.ok) {
        const errorData = (await response.json()) as { error: string; details?: string };
        throw new Error(
          `Backend error: ${errorData.error}${errorData.details ? ` - ${errorData.details}` : ''}`,
        );
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

  const clearAll = () => {
    setDlcOfferHex('');
    setDlcAcceptHex('');
    setDlcSignHex('');
    setFinalizeState({ isLoading: false });
    setBroadcastState({ isLoading: false });
  };

  return (
    <Card>
      <h3>Manual DLC Finalize</h3>
      <p>Input DLC Offer, Accept, and Sign messages as hex strings to manually finalize the DLC.</p>

      <div style={{ marginBottom: '1rem' }}>
        <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 'bold' }}>
          DLC Offer Hex:
        </label>
        <textarea
          value={dlcOfferHex}
          onChange={(e) => setDlcOfferHex(e.target.value)}
          placeholder="Paste DLC Offer hex string here..."
          style={{
            width: '100%',
            height: '80px',
            padding: '0.5rem',
            fontFamily: 'monospace',
            fontSize: '0.8em',
            border: '1px solid #ccc',
            borderRadius: '4px',
            resize: 'vertical',
          }}
        />
      </div>

      <div style={{ marginBottom: '1rem' }}>
        <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 'bold' }}>
          DLC Accept Hex:
        </label>
        <textarea
          value={dlcAcceptHex}
          onChange={(e) => setDlcAcceptHex(e.target.value)}
          placeholder="Paste DLC Accept hex string here..."
          style={{
            width: '100%',
            height: '80px',
            padding: '0.5rem',
            fontFamily: 'monospace',
            fontSize: '0.8em',
            border: '1px solid #ccc',
            borderRadius: '4px',
            resize: 'vertical',
          }}
        />
      </div>

      <div style={{ marginBottom: '1rem' }}>
        <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 'bold' }}>
          DLC Sign Hex:
        </label>
        <textarea
          value={dlcSignHex}
          onChange={(e) => setDlcSignHex(e.target.value)}
          placeholder="Paste DLC Sign hex string here..."
          style={{
            width: '100%',
            height: '80px',
            padding: '0.5rem',
            fontFamily: 'monospace',
            fontSize: '0.8em',
            border: '1px solid #ccc',
            borderRadius: '4px',
            resize: 'vertical',
          }}
        />
      </div>

      <div style={{ marginBottom: '1rem', display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
        <Button
          onClick={() => {
            handleManualFinalize().catch(console.error);
          }}
          disabled={finalizeState.isLoading || !dlcOfferHex || !dlcAcceptHex || !dlcSignHex}
        >
          {finalizeState.isLoading ? 'Finalizing...' : 'Manual Finalize DLC'}
        </Button>

        {finalizeState.txHex && (
          <Button
            onClick={() => {
              handleBroadcast().catch(console.error);
            }}
            disabled={broadcastState.isLoading}
          >
            {broadcastState.isLoading ? 'Broadcasting...' : 'Broadcast Transaction'}
          </Button>
        )}

        <Button onClick={clearAll} style={{ backgroundColor: '#666', borderColor: '#666' }}>
          Clear All
        </Button>
      </div>

      {finalizeState.error && (
        <ErrorMessage style={{ marginBottom: '1rem' }}>
          <strong>Finalize Error:</strong> {finalizeState.error}
        </ErrorMessage>
      )}

      {finalizeState.txId && (
        <div
          style={{
            marginBottom: '1rem',
            padding: '1rem',
            backgroundColor: '#e8f5e8',
            borderRadius: '4px',
          }}
        >
          <strong>✅ Transaction Finalized Successfully!</strong>
          <div style={{ fontSize: '0.9em', marginTop: '0.5rem' }}>
            <strong>TX ID:</strong>
            <span style={{ fontFamily: 'monospace', wordBreak: 'break-all', marginLeft: '0.5rem' }}>
              {finalizeState.txId}
            </span>
          </div>
          <div style={{ fontSize: '0.9em', marginTop: '0.5rem' }}>
            <strong>TX Hex:</strong>
            <textarea
              readOnly
              value={finalizeState.txHex || ''}
              style={{
                width: '100%',
                height: '60px',
                padding: '0.5rem',
                fontFamily: 'monospace',
                fontSize: '0.7em',
                border: '1px solid #ccc',
                borderRadius: '4px',
                marginTop: '0.25rem',
                backgroundColor: '#f9f9f9',
              }}
            />
          </div>
        </div>
      )}

      {broadcastState.success && (
        <div style={{ color: '#28a745', marginBottom: '1rem' }}>
          <strong>✅ Transaction Broadcast Successfully!</strong>
        </div>
      )}

      {broadcastState.error && (
        <ErrorMessage style={{ marginBottom: '1rem' }}>
          <strong>Broadcast Error:</strong> {broadcastState.error}
        </ErrorMessage>
      )}
    </Card>
  );
}
