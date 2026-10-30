/**
 * Decides what the search input should show after the URL's `q` changed.
 *
 * The URL echoes what the user typed, delayed by the debounce and the router. Applying that echo while the user is
 * still editing overwrites the characters typed since, so the draft is only taken from the URL when the change did
 * not originate from this input.
 */
export function nextSearchDraft(input: {
  draft: string;
  urlQuery: string;
  /** A search navigation is debounced or in flight. */
  pending: boolean;
  /** The search input has keyboard focus. */
  focused: boolean;
  /** The last `q` this input pushed to the URL. */
  lastPushed: string | undefined;
}): string {
  const { draft, urlQuery, pending, focused, lastPushed } = input;
  if (urlQuery === draft) {
    return draft;
  }
  if (pending) {
    return draft;
  }
  if (focused && urlQuery === lastPushed) {
    return draft;
  }
  return urlQuery;
}
