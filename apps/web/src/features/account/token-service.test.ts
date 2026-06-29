import { describe, expect, test } from 'bun:test';
import { isLocalRegistryUrl } from './token-service';

describe('local token proxy registry URL validation', () => {
  test('accepts IPv4, localhost, and bracketed IPv6 loopback only', () => {
    expect(isLocalRegistryUrl('http://localhost:8787')).toBe(true);
    expect(isLocalRegistryUrl('http://127.0.0.1:8787')).toBe(true);
    expect(isLocalRegistryUrl('http://[::1]:8787')).toBe(true);
    expect(isLocalRegistryUrl('https://registry.example.com')).toBe(false);
  });
});
