export type UrlState = {
  pathname: string;
  params: URLSearchParams;
};

export type UrlUpdate = UrlState & {
  /** Full relative URL (pathname + query) the update resolves to. */
  url: string;
};

/** Canonical `pathname?query` form used to compare URLs produced by this module. */
export function formatUrl(state: UrlState): string {
  const query = state.params.toString();
  return `${state.pathname}${query ? `?${query}` : ''}`;
}

export function parseUrl(url: string): UrlState {
  const parsed = new URL(url, 'http://cyanprint.local');
  return { pathname: parsed.pathname, params: new URLSearchParams(parsed.search) };
}

/**
 * Applies `next` on top of `base`. Callers must pass the TARGET of any pending navigation as `base` (falling back to
 * the live location only when nothing is pending), otherwise the update is built from a stale URL and silently drops
 * whatever the pending navigation was about to apply.
 * Returns undefined when the update would not change the query (a no-op must not start a navigation).
 */
export function buildUrlUpdate(base: UrlState, next: Record<string, string | undefined>): UrlUpdate | undefined {
  const params = new URLSearchParams(base.params.toString());
  for (const [key, value] of Object.entries(next)) {
    if (!value || (key === 'theme' && value === 'light')) {
      params.delete(key);
    } else {
      params.set(key, value);
    }
  }
  if (params.toString() === base.params.toString()) {
    return undefined;
  }
  const state = { pathname: base.pathname, params };
  return { ...state, url: formatUrl(state) };
}
