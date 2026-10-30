import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act, createElement, type RefObject, useSyncExternalStore } from 'react';
import type { Root } from 'react-dom/client';
import { createPendingNavigation, type PendingNavigation } from './pending-navigation';

/**
 * Hook-level tests: the real useUrlState / useSearchDraft rendered with react-dom into a happy-dom window, with
 * next/navigation backed by a fake router whose navigations only "land" when the test says so.
 */

type Route = { pathname: string; search: string };
let route: Route = { pathname: '/', search: '' };
const listeners = new Set<() => void>();
let routeVersion = 0;
let searchParamsCache: { version: number; params: URLSearchParams } | undefined;
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const readVersion = () => routeVersion;

function setRoute(next: Route) {
  route = next;
  routeVersion += 1;
  for (const listener of [...listeners]) listener();
}

mock.module('next/navigation', () => ({
  usePathname: () => {
    useSyncExternalStore(subscribe, readVersion, readVersion);
    return route.pathname;
  },
  useSearchParams: () => {
    useSyncExternalStore(subscribe, readVersion, readVersion);
    // Stable between route changes, like Next's memoized searchParams.
    if (searchParamsCache?.version !== routeVersion) {
      searchParamsCache = { version: routeVersion, params: new URLSearchParams(route.search) };
    }
    return searchParamsCache.params;
  },
}));

type Timer = { callback: () => void; delay: number };

function fakeTimers() {
  const pending = new Map<number, Timer>();
  let id = 0;
  return {
    timers: {
      setTimeout: (callback: () => void, delay: number) => {
        id += 1;
        pending.set(id, { callback, delay });
        return id;
      },
      clearTimeout: (handle: unknown) => {
        pending.delete(handle as number);
      },
    },
    /** Fire every queued timer with exactly this delay. */
    fire: (delay: number) => {
      for (const [key, timer] of [...pending]) {
        if (timer.delay === delay) {
          pending.delete(key);
          timer.callback();
        }
      }
    },
    count: () => pending.size,
  };
}

const DEBOUNCE = 120;
const SAFETY = 5000;

let happy: Window;
let root: Root;
let container: HTMLElement;
const saved = new Map<string, unknown>();
const globals = globalThis as unknown as Record<string, unknown>;
let useUrlState: typeof import('./url-state').useUrlState;
let useSearchDraft: typeof import('./use-search-draft').useSearchDraft;
let createRoot: typeof import('react-dom/client').createRoot;

beforeAll(async () => {
  happy = new Window({ url: 'http://localhost/' });
  for (const [key, value] of Object.entries({
    window: happy,
    document: happy.document,
    Event: happy.Event,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    saved.set(key, globals[key]);
    globals[key] = value;
  }
  ({ useUrlState } = await import('./url-state'));
  ({ useSearchDraft } = await import('./use-search-draft'));
  ({ createRoot } = await import('react-dom/client'));
  container = happy.document.createElement('div') as unknown as HTMLElement;
  happy.document.body.appendChild(container as never);
  root = createRoot(container);
});

afterAll(() => {
  act(() => root.unmount());
  for (const [key, value] of saved) {
    if (value === undefined) delete globals[key];
    else globals[key] = value;
  }
});

/** Mimics the Next router: records replace() calls; the route (and address bar) only change in land(). */
function fakeRouter(start: string) {
  const [pathname, search = ''] = start.split('?');
  happy.history.replaceState(null, '', start);
  act(() => setRoute({ pathname: pathname ?? '/', search }));
  const replaced: string[] = [];
  const clock = fakeTimers();
  const navigation = createPendingNavigation(url => replaced.push(url), DEBOUNCE, clock.timers);
  return {
    replaced,
    clock,
    navigation,
    land(url: string) {
      const [landedPath, landedSearch = ''] = url.split('?');
      happy.history.replaceState(null, '', url);
      act(() => setRoute({ pathname: landedPath ?? '/', search: landedSearch }));
    },
  };
}

function renderUrlState(navigation: PendingNavigation) {
  const current: { value?: ReturnType<typeof useUrlState> } = {};
  function Probe() {
    current.value = useUrlState({ navigation });
    return null;
  }
  act(() => root.render(createElement(Probe)));
  return {
    get state() {
      return current.value as ReturnType<typeof useUrlState>;
    },
    update(next: Record<string, string | undefined>) {
      act(() => (current.value as ReturnType<typeof useUrlState>).update(next));
    },
  };
}

const locationUrl = () => `${happy.location.pathname}${happy.location.search}`;

describe('useUrlState with a pending navigation', () => {
  test('a theme update during a debounced search navigation keeps the search', () => {
    const router = fakeRouter('/search');
    const hook = renderUrlState(router.navigation);

    router.navigation.schedule('/search?q=react', { defer: true });
    hook.update({ theme: 'dark' });

    expect(router.replaced).toEqual(['/search?q=react&theme=dark']);
    expect(locationUrl()).toBe('/search?q=react&theme=dark');
    router.clock.fire(DEBOUNCE);
    expect(router.replaced).toEqual(['/search?q=react&theme=dark']);
  });

  test('a navigation to the URL the router already shows never becomes pending', () => {
    const router = fakeRouter('/search?q=a');
    const hook = renderUrlState(router.navigation);

    // Type "b", then backspace, within the debounce: the final URL equals the settled one.
    router.navigation.schedule('/search?q=ab', { defer: true });
    router.navigation.schedule('/search?q=a', { defer: true });

    expect(router.navigation.target()).toBeUndefined();
    router.clock.fire(DEBOUNCE);
    expect(router.replaced).toEqual([]);

    hook.update({ theme: 'dark' });
    expect(router.replaced).toEqual(['/search?q=a&theme=dark']);
  });

  test('following a link while a search navigation is in flight abandons it', () => {
    const router = fakeRouter('/search?q=a');
    const hook = renderUrlState(router.navigation);

    router.navigation.schedule('/search?q=ab', { defer: true });
    router.clock.fire(DEBOUNCE);
    expect(router.navigation.target()).toBe('/search?q=ab');

    router.land('/artifacts/template/acme/hello');
    expect(router.navigation.target()).toBeUndefined();

    hook.update({ theme: 'dark' });
    expect(router.replaced.at(-1)).toBe('/artifacts/template/acme/hello?theme=dark');
    expect(locationUrl()).toBe('/artifacts/template/acme/hello?theme=dark');
  });

  test('a link that only changes the query also abandons the pending search', () => {
    const router = fakeRouter('/search?q=a');
    renderUrlState(router.navigation);

    router.navigation.schedule('/search?q=ab', { defer: true });
    router.clock.fire(DEBOUNCE);
    router.land('/search?q=vue');

    expect(router.navigation.target()).toBeUndefined();
  });

  test('a superseded navigation landing late does not drop the newer target', () => {
    const router = fakeRouter('/search');
    renderUrlState(router.navigation);

    router.navigation.schedule('/search?q=a', { defer: true });
    router.clock.fire(DEBOUNCE);
    router.navigation.schedule('/search?q=ab', { defer: true });
    router.clock.fire(DEBOUNCE);

    router.land('/search?q=a');
    expect(router.navigation.target()).toBe('/search?q=ab');
    router.land('/search?q=ab');
    expect(router.navigation.target()).toBeUndefined();
  });

  test('a target that never lands is dropped by the safety timeout', () => {
    const router = fakeRouter('/search?q=a');
    renderUrlState(router.navigation);

    router.navigation.schedule('/search?q=ab');
    expect(router.navigation.target()).toBe('/search?q=ab');
    router.clock.fire(SAFETY);
    expect(router.navigation.target()).toBeUndefined();
  });
});

function renderSearchDraft(navigation: PendingNavigation, input: HTMLInputElement) {
  const current: { value?: ReturnType<typeof useSearchDraft> } = {};
  const inputRef = { current: input } as RefObject<HTMLInputElement | null>;
  function Probe({ params }: { params: URLSearchParams }) {
    current.value = useSearchDraft({ params, navigation, inputRef });
    return null;
  }
  return {
    get draft() {
      return (current.value as ReturnType<typeof useSearchDraft>).draft;
    },
    render(search: string) {
      act(() => root.render(createElement(Probe, { params: new URLSearchParams(search) })));
    },
    type(value: string) {
      act(() => (current.value as ReturnType<typeof useSearchDraft>).type(value));
    },
  };
}

describe('useSearchDraft', () => {
  test('a late echo of an earlier keystroke does not overwrite what was typed since', () => {
    const router = fakeRouter('/search');
    const input = happy.document.createElement('input') as unknown as HTMLInputElement;
    const draft = renderSearchDraft(router.navigation, input);
    draft.render('');

    draft.type('re');
    router.navigation.schedule('/search?q=re', { defer: true });
    router.clock.fire(DEBOUNCE);
    draft.type('rea');
    draft.type('reac');
    router.navigation.schedule('/search?q=reac', { defer: true });

    draft.render('q=re');
    expect(draft.draft).toBe('reac');
  });

  test('follows the URL again after a content link, even if it matches an old push (history back)', () => {
    const router = fakeRouter('/search');
    const input = happy.document.createElement('input') as unknown as HTMLInputElement;
    happy.document.body.appendChild(input as never);
    const draft = renderSearchDraft(router.navigation, input);
    draft.render('');

    draft.type('react');
    draft.render('q=react');
    expect(draft.draft).toBe('react');

    draft.render('q=vue');
    expect(draft.draft).toBe('vue');

    input.focus();
    draft.render('q=react');
    expect(draft.draft).toBe('react');
  });
});
