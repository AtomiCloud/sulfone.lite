import { describe, expect, test } from 'bun:test';
import { buildSearchNavigation, buildUrlUpdate, formatUrl, parseUrl } from './url-update';

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

describe('buildSearchNavigation (updateSearchState path)', () => {
  const on = (url: string, kind = 'all') => ({ current: parseUrl(url), pendingTarget: undefined, kind });

  test('re-picking the selected kind is a no-op', () => {
    expect(
      buildSearchNavigation({ ...on('/search?kind=template', 'template'), next: { kind: 'template' } }),
    ).toBeUndefined();
    expect(buildSearchNavigation({ ...on('/search'), next: { kind: 'all' } })).toBeUndefined();
  });

  test('retyping the current query is a no-op', () => {
    expect(buildSearchNavigation({ ...on('/search?q=a'), next: { q: 'a' } })).toBeUndefined();
  });

  test('typing then backspacing to the pending target is a no-op', () => {
    expect(
      buildSearchNavigation({ ...on('/search?q=a'), pendingTarget: '/search?q=ab', next: { q: 'ab' } }),
    ).toBeUndefined();
  });

  test('a kind change keeps a debounced query, and a query keeps the kind', () => {
    expect(
      buildSearchNavigation({ ...on('/search'), pendingTarget: '/search?q=react', next: { kind: 'plugin' } }),
    ).toBe('/search?q=react&kind=plugin');
    expect(buildSearchNavigation({ ...on('/', 'template'), next: { q: 'x' } })).toBe('/search?kind=template&q=x');
  });

  test('drops the cursor and the all kind', () => {
    expect(buildSearchNavigation({ ...on('/search?kind=plugin&cursor=9'), next: { kind: 'all' } })).toBe('/search');
  });
});
