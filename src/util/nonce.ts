import { randomBytes } from 'node:crypto';

/**
 * Generate a cryptographically-random nonce suitable for Content-Security-Policy.
 *
 * VSCode webviews require a CSP nonce for any inline or local script. A fresh
 * nonce per webview render ensures that only the scripts we deliberately
 * inject can execute. This uses Node's crypto.randomBytes for unpredictability.
 */
export function generateNonce(): string {
  return randomBytes(16).toString('base64');
}
