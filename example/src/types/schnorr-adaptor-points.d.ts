declare module 'schnorr-adaptor-points' {
  /**
   * Create an adaptor point from oracle public keys, messages, and R-values
   * @param pubKeys - Array of oracle public key buffers
   * @param messages - Array of message buffers
   * @param rValues - Array of R-value (nonce) buffers
   * @returns Buffer containing the adaptor point
   */
  export function createAdaptorPoint(
    pubKeys: Buffer[],
    messages: Buffer[],
    rValues: Buffer[],
  ): Buffer;

  /**
   * Create an adaptor secret from private keys, messages, and k-values
   * @param privKeys - Array of private key buffers
   * @param messages - Array of message buffers
   * @param kValues - Array of k-value buffers
   * @returns Buffer containing the adaptor secret
   */
  export function createAdaptorSecret(
    privKeys: Buffer[],
    messages: Buffer[],
    kValues: Buffer[],
  ): Buffer;

  /**
   * Combine multiple secrets
   * @param secrets - Array of secret buffers
   * @returns Buffer containing the combined secret
   */
  export function combineSecrets(secrets: Buffer[]): Buffer;
}
