/**
 * XRPL APIs accept either a case-sensitive 3-character standard currency code
 * or a 40-hex-digit nonstandard code. Display names like PHNIX are NOT valid
 * in RPC Issue objects until encoded as 160-bit hex.
 *
 * Prefer original ledger hex values whenever they are available: converting a
 * 3-character display name cannot tell a standard code from 3 letters encoded
 * as a nonstandard 160-bit token.
 */
export function normalizeIssuedCurrency(currency: unknown): string | null {
  if (typeof currency !== 'string' || currency.length === 0) return null;
  if (/^[0-9a-fA-F]{40}$/.test(currency)) return currency.toUpperCase();
  // XRP is native and cannot be an issued currency.
  if (currency === 'XRP') return null;
  // Official XRPL standard-code character set. Case is significant.
  if (/^[A-Za-z0-9?!@#$%^&*<>(){}\[\]|]{3}$/.test(currency)) return currency;
  // Displayed names recovered from old DB rows can be ASCII instead of hex.
  // Encode only printable ASCII to avoid guessing the bytes of a corrupted
  // or lossy decoded Unicode value.
  if (!/^[\x20-\x7E]+$/.test(currency)) return null;
  const bytes = Buffer.from(currency, 'ascii');
  if (bytes.length > 20) return null;
  return bytes.toString('hex').toUpperCase().padEnd(40, '0');
}
