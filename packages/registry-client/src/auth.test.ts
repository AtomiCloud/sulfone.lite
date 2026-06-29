import { describe, expect, test } from 'bun:test';
import { readCookie } from './auth';

describe('registry auth cookie helpers', () => {
  test('reads encoded cookie values', () => {
    expect(readCookie('theme=dark; cyanprint_session=cps_%25_value', 'cyanprint_session')).toBe('cps_%_value');
  });

  test('ignores malformed encoded cookie values', () => {
    expect(readCookie('cyanprint_session=%', 'cyanprint_session')).toBeUndefined();
  });
});
