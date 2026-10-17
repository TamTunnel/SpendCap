// Spendcap virtual API keys.
//
// Format: `sc_live_<43-char base64url secret>` or `sc_test_<...>`. Only the
// SHA-256 hash of the full key is ever stored (D1) or compared; the raw key
// is shown once at issuance and never persisted.
//
// NOTE: hashing uses WebCrypto (`crypto.subtle`), which is async-only, so
// `generateKey`/`hashKey` are async. This is a deliberate deviation from the
// scaffold's sync signatures.

export interface KeyParts {
  prefix: 'sc_live_' | 'sc_test_';
  secret: string;
}

export interface GeneratedKey {
  /** The full key to show the user once, e.g. `sc_live_<secret>`. */
  fullKey: string;
  /** Hex SHA-256 of the full key — the only form ever stored. */
  keyHash: string;
  /**
   * First 11 chars of the full key (`sc_live_` + 3 secret chars), for
   * human-readable identification. NOTE: the task example `sc_live_ab12`
   * is 12 chars; the explicit "first 11 chars" rule is implemented.
   */
  keyPrefix: string;
}

const SECRET_BYTES = 32;
const SECRET_PATTERN = '[A-Za-z0-9_-]{43}';
const KEY_RE = new RegExp(`^(sc_live_|sc_test_)(${SECRET_PATTERN})$`);

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  // 32 bytes -> 44 base64 chars with one '=' pad; strip padding -> 43 chars.
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Mint a new virtual key. The secret is 32 crypto-random bytes, base64url
 * encoded (43 chars, no padding).
 */
export async function generateKey(env: 'live' | 'test'): Promise<GeneratedKey> {
  const secret = base64UrlEncode(crypto.getRandomValues(new Uint8Array(SECRET_BYTES)));
  const fullKey = (env === 'live' ? 'sc_live_' : 'sc_test_') + secret;
  return {
    fullKey,
    keyHash: await sha256Hex(fullKey),
    keyPrefix: fullKey.slice(0, 11),
  };
}

/** Strictly parse a presented key; throws on any deviation from the format. */
export function parseKey(fullKey: string): KeyParts {
  const m = KEY_RE.exec(fullKey);
  if (!m) throw new Error('invalid API key format');
  return { prefix: m[1] as KeyParts['prefix'], secret: m[2] };
}

/** Hex SHA-256 of the full presented key — compare hashes, never raw keys. */
export function hashKey(fullKey: string): Promise<string> {
  return sha256Hex(fullKey);
}

/**
 * Constant-time hex-string comparison. Iterates all bytes and accumulates
 * XOR differences so the result reveals nothing about where strings differ.
 * (Length is not hidden; all key hashes are fixed 64-char hex.)
 */
export function timingSafeEqualHex(a: string, b: string): boolean {
  const ab = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}
