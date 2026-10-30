'use client';

import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';
import type { PendingNavigation } from './pending-navigation';
import { nextSearchDraft } from './search-draft';

/**
 * State of the search input. Typing updates the draft immediately; the URL's `q` only flows back into the draft when
 * it did not originate from this input (see `nextSearchDraft`).
 */
export function useSearchDraft(options: {
  params: URLSearchParams;
  navigation: PendingNavigation;
  inputRef: RefObject<HTMLInputElement | null>;
}): { draft: string; type: (value: string) => void } {
  const { params, navigation, inputRef } = options;
  const urlQuery = params.get('q') ?? '';
  const [draft, setDraft] = useState(urlQuery);
  const draftRef = useRef(draft);
  const lastPushed = useRef<string | undefined>(undefined);

  const type = useCallback((value: string) => {
    draftRef.current = value;
    lastPushed.current = value;
    setDraft(value);
  }, []);

  useEffect(() => {
    const next = nextSearchDraft({
      draft: draftRef.current,
      urlQuery,
      pending: navigation.target() !== undefined,
      focused: inputRef.current !== null && inputRef.current === document.activeElement,
      lastPushed: lastPushed.current,
    });
    if (next !== draftRef.current) {
      // Taken from the URL: whatever we pushed earlier no longer describes what the input shows.
      draftRef.current = next;
      lastPushed.current = undefined;
      setDraft(next);
    }
  }, [params, urlQuery, navigation, inputRef]);

  return { draft, type };
}
