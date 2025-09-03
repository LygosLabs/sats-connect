import React, { useState } from 'react';
import { createAdaptorPoint } from 'schnorr-adaptor-points';

export const TestAdaptorPoints: React.FC = () => {
  const [result, setResult] = useState<string>('');
  const [error, setError] = useState<string>('');

  const generateRandomHex = (length: number): string => {
    const bytes = new Uint8Array(length);
    globalThis.crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  };

  const testAdaptorPoints = () => {
    try {
      setError('');

      // Test data - using simple values for verification
      const oraclePubkey = Buffer.from(
        '30bbf19aa3a986ed4e5640240b507901d6e03d6bbd71a281ed356a145516c655',
        'hex',
      ); // 32-byte pubkey
      const message = Buffer.from(generateRandomHex(32), 'hex');
      const nonce = Buffer.from(
        'd7c8421829470a961ef1cc2d1cba71b886d0dbfcd9fc17f60386f60d17a10602',
        'hex',
      ); // 32-byte nonce

      console.log('Testing adaptor point calculation...');
      console.log('Oracle pubkey:', oraclePubkey.toString('hex'));
      console.log('Message:', message.toString('hex'));
      console.log('Nonce:', nonce.toString('hex'));

      // Calculate adaptor point
      const adaptorPoint = createAdaptorPoint([oraclePubkey], [message], [nonce]);

      const resultHex = adaptorPoint.toString('hex');
      console.log('✅ Adaptor point calculated:', resultHex);

      setResult(`Success! Adaptor point: ${resultHex}`);
    } catch (err: any) {
      const errorMsg = err.message || 'Unknown error';
      console.error('❌ Adaptor point calculation failed:', err);
      setError(`Error: ${errorMsg}`);
    }
  };

  return (
    <div style={{ padding: '20px', border: '1px solid #ccc', margin: '10px' }}>
      <h3>🧪 Test Adaptor Points (Browser)</h3>
      <button
        onClick={testAdaptorPoints}
        style={{
          padding: '10px 20px',
          backgroundColor: '#007bff',
          color: 'white',
          border: 'none',
          borderRadius: '4px',
          cursor: 'pointer',
        }}
      >
        Test Adaptor Point Calculation
      </button>

      {result && (
        <div
          style={{
            marginTop: '10px',
            padding: '10px',
            backgroundColor: '#d4edda',
            color: '#155724',
            borderRadius: '4px',
          }}
        >
          {result}
        </div>
      )}

      {error && (
        <div
          style={{
            marginTop: '10px',
            padding: '10px',
            backgroundColor: '#f8d7da',
            color: '#721c24',
            borderRadius: '4px',
          }}
        >
          {error}
        </div>
      )}

      <div style={{ marginTop: '10px', fontSize: '12px', color: '#666' }}>
        <p>
          <strong>What this tests:</strong>
        </p>
        <ul>
          <li>Buffer polyfills working correctly</li>
          <li>schnorr-adaptor-points module loading in browser</li>
          <li>Crypto operations (bigi, ecurve, bip-schnorr) working</li>
        </ul>
      </div>
    </div>
  );
};
