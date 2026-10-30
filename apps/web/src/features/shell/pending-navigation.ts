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
  /** Report the URL the router currently shows; clears the pending target once it has landed. */
  settle: (currentUrl: string) => void;
  /** Forget the pending target (e.g. history navigation superseded it) and drop any debounced navigation. */
  cancel: () => void;
};

const realTimers: Timers = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Tracks the navigation the shell has asked the router for but that has not landed yet. A debounced search navigation
 * is "pending" from the keystroke until the router shows its URL, so other URL writers (theme toggle, kind filter) can
 * build on its target instead of the stale live location and cancelling it.
 */
export function createPendingNavigation(
  replace: (url: string) => void,
  delayMs = 120,
  timers: Timers = realTimers,
): PendingNavigation {
  let timer: unknown;
  let target: string | undefined;

  const clearTimer = () => {
    if (timer !== undefined) {
      timers.clearTimeout(timer);
      timer = undefined;
    }
  };

  return {
    schedule(url, navigation) {
      clearTimer();
      target = url;
      if (navigation?.defer) {
        timer = timers.setTimeout(() => {
          timer = undefined;
          replace(url);
        }, delayMs);
        return;
      }
      replace(url);
    },
    target: () => target,
    settle(currentUrl) {
      if (target !== undefined && timer === undefined && currentUrl === target) {
        target = undefined;
      }
    },
    cancel() {
      clearTimer();
      target = undefined;
    },
  };
}
