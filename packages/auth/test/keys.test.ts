import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { generateKey, hashKey, parseKey, timingSafeEqualHex } from '../src/keys.js';

const sha256Hex = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

describe('generateKey', () => {
  it('mints a well-formed live key', async () => {
    const k = await generateKey('live');
    expect(k.fullKey.startsWith('sc_live_')).toBe(true);
    const secret = k.fullKey.slice('sc_live_'.length);
    expect(secret).toHaveLength(43);
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(k.keyPrefix).toBe(k.fullKey.slice(0, 11));
    expect(k.keyPrefix).toHaveLength(11);
    expect(k.keyHash).toBe(sha256Hex(k.fullKey));
    expect(k.keyHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('mints a well-formed test key', async () => {
    const k = await generateKey('test');
    expect(k.fullKey.startsWith('sc_test_')).toBe(true);
    expect(k.fullKey.slice('sc_test_'.length)).toHaveLength(43);
  });

  it('mints unique secrets', async () => {
    const a = await generateKey('live');
    const b = await generateKey('live');
    expect(a.fullKey).not.toBe(b.fullKey);
  });

  it('encodes the full 32 bytes of entropy (43 base64url chars, no padding)', async () => {
    // 32 bytes -> ceil(32/3)*4 = 44 base64 chars, last block has 1 pad char -> 43 without '='.
    for (let i = 0; i < 25; i++) {
      const k = await generateKey('live');
      const secret = k.fullKey.slice(8);
      expect(secret).toHaveLength(43);
      expect(secret).not.toContain('=');
    }
  });
});

describe('parseKey', () => {
  it('round-trips a generated key', async () => {
    const k = await generateKey('live');
    const parts = parseKey(k.fullKey);
    expect(parts.prefix).toBe('sc_live_');
    expect(parts.secret).toBe(k.fullKey.slice('sc_live_'.length));
  });

  it.each([
    ['empty', ''],
    ['wrong prefix', 'sk_live_' + 'a'.repeat(43)],
    ['truncated prefix', 'sc_live' + 'a'.repeat(43)],
    ['short secret', 'sc_live_' + 'a'.repeat(42)],
    ['long secret', 'sc_live_' + 'a'.repeat(44)],
    ['bad char in secret', 'sc_live_' + 'a'.repeat(42) + '!'],
    ['padding char', 'sc_live_' + 'a'.repeat(42) + '='],
    ['trailing whitespace', 'sc_live_' + 'a'.repeat(43) + ' '],
    ['leading whitespace', ' sc_live_' + 'a'.repeat(43)],
    ['uppercase prefix', 'SC_LIVE_' + 'a'.repeat(43)],
  ])('throws on %s', async (_name, bad) => {
    expect(() => parseKey(bad)).toThrow(/invalid API key/);
  });

  it('still parses a genuinely valid key', async () => {
    const k = await generateKey('test');
    expect(parseKey(k.fullKey).prefix).toBe('sc_test_');
  });
});

describe('hashKey', () => {
  it('is the hex SHA-256 of the full key', async () => {
    const k = await generateKey('live');
    expect(await hashKey(k.fullKey)).toBe(sha256Hex(k.fullKey));
  });

  it('never returns the raw key material', async () => {
    const k = await generateKey('live');
    const h = await hashKey(k.fullKey);
    expect(h).not.toContain(k.fullKey.slice(8));
    expect(h).toHaveLength(64);
  });
});

describe('timingSafeEqualHex', () => {
  it('accepts equal strings', () => {
    expect(timingSafeEqualHex('ab12cd', 'ab12cd')).toBe(true);
    expect(timingSafeEqualHex('', '')).toBe(true);
  });

  it('rejects differing strings', () => {
    expect(timingSafeEqualHex('ab12cd', 'ab12ce')).toBe(false);
    expect(timingSafeEqualHex('ab12cd', 'ab12cd '.trim() + 'x')).toBe(false);
  });

  it('rejects different lengths without leaking position', () => {
    expect(timingSafeEqualHex('abc', 'abcd')).toBe(false);
    expect(timingSafeEqualHex('a'.repeat(64), 'a'.repeat(63) + 'b')).toBe(false);
  });

  it('compares full 64-char hashes correctly', async () => {
    const k = await generateKey('live');
    expect(timingSafeEqualHex(k.keyHash, k.keyHash)).toBe(true);
    const other = (await generateKey('live')).keyHash;
    expect(timingSafeEqualHex(k.keyHash, other)).toBe(false);
  });
});
