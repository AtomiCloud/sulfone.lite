'use client';

import { usePathname, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { NavigationOptions, PendingNavigation } from './pending-navigation';
import { buildUrlUpdate, formatUrl, parseUrl, type UrlState } from './url-update';

const URL_STATE_EVENT = 'cyanprint-url-state';

export function useUrlState(options?: { navigation?: PendingNavigation }): {
  pathname: string;
  params: URLSearchParams;
  update: (next: Record<string, string | undefined>, navigation?: NavigationOptions) => void;
  /**
   * Approximate: true when the Next router's route state matches the URL this hook last wrote. It can read true
   * while a navigation is still queued (e.g. a debounced one, which has not written the URL yet), so it is a
   * readiness hint for automation, not a guarantee that nothing is pending. Use `navigation.target()` for that.
   */
  settled: boolean;
} {
  const pending = options?.navigation;
  const nextPathname = usePathname();
  const nextSearchParams = useSearchParams();
  const routeState = useMemo(
    () => ({
      pathname: nextPathname || '/',
      params: new URLSearchParams(nextSearchParams?.toString() ?? ''),
    }),
    [nextPathname, nextSearchParams],
  );
  const [state, setState] = useState<UrlState>(routeState);

  useEffect(() => {
    setState(routeState);
    pending?.settle(formatUrl(routeState));
  }, [routeState, pending]);

  useEffect(() => {
    const sync = () => setState(readUrlState());
    const onPopState = () => {
      pending?.cancel();
      sync();
    };
    window.addEventListener('popstate', onPopState);
    window.addEventListener(URL_STATE_EVENT, sync);
    sync();
    return () => {
      window.removeEventListener('popstate', onPopState);
      window.removeEventListener(URL_STATE_EVENT, sync);
    };
  }, [pending]);

  const update = useCallback(
    (next: Record<string, string | undefined>, navigation?: NavigationOptions) => {
      // Build on the target of a pending navigation, not the live URL: the live URL does not include it yet, and
      // history.replaceState below dispatches a Next RESTORE that cancels in-flight navigations, so building from the
      // stale URL would silently drop e.g. a debounced search.
      const pendingTarget = pending?.target();
      const base = pendingTarget === undefined ? readUrlState() : parseUrl(pendingTarget);
      const built = buildUrlUpdate(base, next);
      // A no-op update (e.g. the default light theme with no theme param) must not navigate:
      // it would start a router.replace while `settled` already reads true.
      if (!built) {
        return;
      }
      window.history.replaceState(null, '', built.url);
      setState({ pathname: built.pathname, params: built.params });
      window.dispatchEvent(new Event(URL_STATE_EVENT));
      pending?.schedule(built.url, navigation);
    },
    [pending],
  );

  const settled = state.pathname === routeState.pathname && state.params.toString() === routeState.params.toString();

  return useMemo(() => ({ pathname: state.pathname, params: state.params, update, settled }), [state, update, settled]);
}

function readUrlState(): UrlState {
  if (typeof window === 'undefined') {
    return { pathname: '/', params: new URLSearchParams() };
  }
  return { pathname: window.location.pathname, params: new URLSearchParams(window.location.search) };
}
