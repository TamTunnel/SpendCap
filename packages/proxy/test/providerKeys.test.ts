import { describe, expect, it } from 'vitest';
import { decryptProviderKey, encryptProviderKey } from '../src/providerKeys.js';

describe('provider key envelope', () => {
  it('round-trips with a real secret', async () => {
    const enc = await encryptProviderKey('sk-secret-123', 'test-secret');
    expect(enc.startsWith('v1:')).toBe(true);
    expect(await decryptProviderKey(enc, 'test-secret')).toBe('sk-secret-123');
  });

  it('fix-10-unset-secret-fails-closed: encrypt throws on undefined and empty secret', async () => {
    await expect(encryptProviderKey('sk-secret-123', undefined as unknown as string)).rejects.toThrow(
      /PROVIDER_KEYS_SECRET/,
    );
    await expect(encryptProviderKey('sk-secret-123', '')).rejects.toThrow(/PROVIDER_KEYS_SECRET/);
  });

  it('fix-10-unset-secret-fails-closed: decrypt throws on undefined and empty secret', async () => {
    const enc = await encryptProviderKey('sk-secret-123', 'test-secret');
    await expect(decryptProviderKey(enc, undefined as unknown as string)).rejects.toThrow(
      /PROVIDER_KEYS_SECRET/,
    );
    await expect(decryptProviderKey(enc, '')).rejects.toThrow(/PROVIDER_KEYS_SECRET/);
  });

  it('decrypt rejects the wrong secret', async () => {
    const enc = await encryptProviderKey('sk-secret-123', 'test-secret');
    await expect(decryptProviderKey(enc, 'wrong-secret')).rejects.toThrow();
  });
});
