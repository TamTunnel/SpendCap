// AES-GCM envelope for provider API keys stored in D1 `provider_keys.enc_key`.
//
// Wire format: `v1:<base64url(iv, 12 bytes)>:<base64url(ciphertext)>`.
// The AES-256-GCM key is SHA-256(PROVIDER_KEYS_SECRET) used as raw key
// material. `encryptProviderKey` exists for tests and operator tooling;
// the worker only ever decrypts.

const VERSION = 'v1';
const IV_BYTES = 12;

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function importWrappingKey(secret: string): Promise<CryptoKey> {
  // Fail closed, loudly: an unset PROVIDER_KEYS_SECRET must never silently
  // derive SHA-256("") — a publicly-known key that would make every stored
  // provider key decryptable by anyone holding the D1 rows.
  if (!secret) {
    throw new Error(
      'PROVIDER_KEYS_SECRET is not set: refusing to wrap/unwrap provider keys with an empty secret',
    );
  }
  const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

export async function encryptProviderKey(plaintext: string, secret: string): Promise<string> {
  const key = await importWrappingKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  return `${VERSION}:${base64UrlEncode(iv)}:${base64UrlEncode(new Uint8Array(ct))}`;
}

export async function decryptProviderKey(enc: string, secret: string): Promise<string> {
  const parts = enc.split(':');
  if (parts.length !== 3 || parts[0] !== VERSION) {
    throw new Error('unsupported provider key envelope');
  }
  const key = await importWrappingKey(secret);
  const iv = base64UrlDecode(parts[1]);
  const ct = base64UrlDecode(parts[2]);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return new TextDecoder().decode(pt);
}
