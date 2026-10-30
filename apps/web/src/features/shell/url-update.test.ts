import { describe, expect, test } from 'bun:test';
import { createPendingNavigation } from './pending-navigation';
import { buildUrlUpdate, formatUrl, parseUrl } from './url-update';

function fakeTimers() {
  const queue = new Map<number, () => void>();
  let id = 0;
  return {
    timers: {
      setTimeout: (callback: () => void) => {
        id += 1;
        queue.set(id, callback);
        return id;
      },
      clearTimeout: (handle: unknown) => {
        queue.delete(handle as number);
      },
    },
    flush: () => {
      for (const [key, callback] of [...queue]) {
        queue.delete(key);
        callback();
      }
    },
    size: () => queue.size,
  };
}

/** Mirrors useUrlState().update: build on the pending target (else the live URL), then schedule the navigation. */
function themeUpdate(live: string, pending: ReturnType<typeof createPendingNavigation>, theme: string) {
  const target = pending.target();
  const built = buildUrlUpdate(parseUrl(target ?? live), { theme });
  if (built) {
    pending.schedule(built.url);
  }
  return built;
}

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

describe('theme update while a search navigation is pending', () => {
  test('keeps the debounced search instead of rebuilding from the stale live URL', () => {
    const { timers, flush, size } = fakeTimers();
    const replaced: string[] = [];
    const pending = createPendingNavigation(url => replaced.push(url), 120, timers);

    // The user typed "react"; the debounced navigation has not fired, so the live URL still has no q.
    pending.schedule('/search?q=react', { defer: true });
    const built = themeUpdate('/search', pending, 'dark');

    expect(built?.url).toBe('/search?q=react&theme=dark');
    expect(size()).toBe(0);
    expect(replaced).toEqual(['/search?q=react&theme=dark']);
    flush();
    expect(replaced).toEqual(['/search?q=react&theme=dark']);
  });

  test('keeps a search navigation that was already issued but has not landed', () => {
    const { timers, flush } = fakeTimers();
    const replaced: string[] = [];
    const pending = createPendingNavigation(url => replaced.push(url), 120, timers);

    pending.schedule('/search?q=react', { defer: true });
    flush();
    expect(replaced).toEqual(['/search?q=react']);
    expect(pending.target()).toBe('/search?q=react');

    expect(themeUpdate('/search', pending, 'dark')?.url).toBe('/search?q=react&theme=dark');
  });

  test('builds from the live URL once the pending navigation has landed', () => {
    const { timers, flush } = fakeTimers();
    const pending = createPendingNavigation(() => undefined, 120, timers);

    pending.schedule('/search?q=react', { defer: true });
    flush();
    pending.settle('/search?q=react');

    expect(pending.target()).toBeUndefined();
    expect(themeUpdate('/search?q=react', pending, 'dark')?.url).toBe('/search?q=react&theme=dark');
  });
});

describe('createPendingNavigation', () => {
  test('debounces: only the latest deferred navigation fires', () => {
    const { timers, flush } = fakeTimers();
    const replaced: string[] = [];
    const pending = createPendingNavigation(url => replaced.push(url), 120, timers);

    pending.schedule('/search?q=a', { defer: true });
    pending.schedule('/search?q=ab', { defer: true });
    flush();

    expect(replaced).toEqual(['/search?q=ab']);
  });

  test('does not settle on an unrelated URL or while the debounce timer is still queued', () => {
    const { timers } = fakeTimers();
    const pending = createPendingNavigation(() => undefined, 120, timers);

    pending.schedule('/search?q=ab', { defer: true });
    pending.settle('/search?q=ab');
    expect(pending.target()).toBe('/search?q=ab');

    pending.cancel();
    expect(pending.target()).toBeUndefined();
  });

  test('cancel drops a queued navigation', () => {
    const { timers, flush } = fakeTimers();
    const replaced: string[] = [];
    const pending = createPendingNavigation(url => replaced.push(url), 120, timers);

    pending.schedule('/search?q=a', { defer: true });
    pending.cancel();
    flush();

    expect(replaced).toEqual([]);
  });
});
