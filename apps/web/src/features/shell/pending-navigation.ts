export type NavigationOptions = { defer?: boolean };

type Timers = {
  setTimeout: (callback: () => void, delayMs: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};

export type PendingNavigation = {
  /** Issue (or debounce, with `defer`) a replace navigation, superseding any earlier pending one. */
  schedule: (url: string, navigation?: NavigationOptions) => void;
  /** URL the latest not-yet-landed navigation is heading to, if any. */
  target: () => string | undefined;
  /** Report the URL the router currently shows; drops the pending target once it landed or was abandoned. */
  settle: (currentUrl: string) => void;
  /** Forget the pending target (e.g. history navigation superseded it) and drop any debounced navigation. */
  cancel: () => void;
};

const realTimers: Timers = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** A target that never lands (router swallowed it) is dropped after this long, so nothing waits on it forever. */
const SAFETY_TIMEOUT_MS = 5000;

function pathnameOf(url: string): string {
  const query = url.indexOf('?');
  return query === -1 ? url : url.slice(0, query);
}

/**
 * Tracks the navigation the shell has asked the router for but that has not landed yet. A debounced search navigation
 * is "pending" from the keystroke until the router shows its URL, so other URL writers (theme toggle, kind filter) can
 * build on its target instead of the stale live location and cancelling it.
 *
 * The target must never outlive its navigation, otherwise URL writers keep building on a URL nobody is heading to:
 * - a navigation to the URL the router already shows is a no-op (the router would not report a change), so it never
 *   becomes pending;
 * - any route change that is not the target (or an earlier navigation we issued) abandons the target, e.g. the user
 *   followed a link while the navigation was in flight;
 * - a safety timeout drops a target that never lands.
 */
export function createPendingNavigation(
  replace: (url: string) => void,
  delayMs = 120,
  timers: Timers = realTimers,
): PendingNavigation {
  let debounce: unknown;
  let safety: unknown;
  let target: string | undefined;
  let settledUrl: string | undefined;
  /** URLs we issued to the router since the target was set; their late landing is not an abandonment. */
  let issued = new Set<string>();

  const clearTimers = () => {
    if (debounce !== undefined) {
      timers.clearTimeout(debounce);
      debounce = undefined;
    }
    if (safety !== undefined) {
      timers.clearTimeout(safety);
      safety = undefined;
    }
  };

  const drop = () => {
    clearTimers();
    target = undefined;
    issued = new Set();
  };

  const issue = (url: string) => {
    issued.add(url);
    if (safety !== undefined) {
      timers.clearTimeout(safety);
    }
    safety = timers.setTimeout(() => {
      safety = undefined;
      drop();
    }, SAFETY_TIMEOUT_MS);
    replace(url);
  };

  return {
    schedule(url, navigation) {
      const inFlight = target !== undefined && debounce === undefined;
      if (debounce !== undefined) {
        timers.clearTimeout(debounce);
        debounce = undefined;
      }
      if (url === settledUrl && !inFlight) {
        // Already there and nothing in flight to undo: the router would not report a change, so do not wait for one.
        drop();
        return;
      }
      target = url;
      if (navigation?.defer) {
        debounce = timers.setTimeout(() => {
          debounce = undefined;
          issue(url);
        }, delayMs);
        return;
      }
      issue(url);
    },
    target: () => target,
    settle(currentUrl) {
      settledUrl = currentUrl;
      if (target === undefined || debounce !== undefined) {
        return;
      }
      if (currentUrl === target) {
        drop();
        return;
      }
      // A different page, or a query we never asked for: the target is abandoned. A query we did ask for (an earlier,
      // superseded navigation landing late) leaves the target alone.
      if (pathnameOf(currentUrl) !== pathnameOf(target) || !issued.has(currentUrl)) {
        drop();
      }
    },
    cancel: drop,
  };
}
