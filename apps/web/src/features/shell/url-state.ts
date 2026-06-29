'use client';

import { usePathname, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';

type UrlState = {
  pathname: string;
  params: URLSearchParams;
};

type NavigationOptions = { defer?: boolean };

const URL_STATE_EVENT = 'cyanprint-url-state';

export function useUrlState(options?: { onNavigate?: (url: string, navigation?: NavigationOptions) => void }): {
  pathname: string;
  params: URLSearchParams;
  update: (next: Record<string, string | undefined>, navigation?: NavigationOptions) => void;
} {
  const onNavigate = options?.onNavigate;
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
  }, [routeState]);

  useEffect(() => {
    const sync = () => setState(readUrlState());
    window.addEventListener('popstate', sync);
    window.addEventListener(URL_STATE_EVENT, sync);
    sync();
    return () => {
      window.removeEventListener('popstate', sync);
      window.removeEventListener(URL_STATE_EVENT, sync);
    };
  }, []);

  const update = useCallback(
    (next: Record<string, string | undefined>, navigation?: NavigationOptions) => {
      const current = readUrlState();
      const params = new URLSearchParams(current.params.toString());
      for (const [key, value] of Object.entries(next)) {
        if (!value || (key === 'theme' && value === 'light')) {
          params.delete(key);
        } else {
          params.set(key, value);
        }
      }
      const query = params.toString();
      const url = `${current.pathname}${query ? `?${query}` : ''}`;
      window.history.replaceState(null, '', url);
      setState({ pathname: current.pathname, params });
      window.dispatchEvent(new Event(URL_STATE_EVENT));
      onNavigate?.(url, navigation);
    },
    [onNavigate],
  );

  return useMemo(() => ({ pathname: state.pathname, params: state.params, update }), [state, update]);
}

function readUrlState(): UrlState {
  if (typeof window === 'undefined') {
    return { pathname: '/', params: new URLSearchParams() };
  }
  return { pathname: window.location.pathname, params: new URLSearchParams(window.location.search) };
}
