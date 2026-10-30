import { describe, expect, test } from 'bun:test';
import { buildUrlUpdate, formatUrl, parseUrl } from './url-update';

describe('buildUrlUpdate', () => {
  test('sets, replaces and deletes params, dropping the default light theme', () => {
    const base = parseUrl('/search?q=abc&theme=dark');
    expect(buildUrlUpdate(base, { q: 'abcd' })?.url).toBe('/search?q=abcd&theme=dark');
    expect(buildUrlUpdate(base, { theme: 'light' })?.url).toBe('/search?q=abc');
    expect(buildUrlUpdate(base, { q: '' })?.url).toBe('/search?theme=dark');
  });

  test('returns undefined for a no-op update', () => {
    expect(buildUrlUpdate(parseUrl('/search?q=abc'), { theme: 'light' })).toBeUndefined();
    expect(buildUrlUpdate(parseUrl('/search?q=abc'), { q: 'abc' })).toBeUndefined();
  });

  test('formatUrl omits an empty query', () => {
    expect(formatUrl(parseUrl('/docs'))).toBe('/docs');
  });
});
