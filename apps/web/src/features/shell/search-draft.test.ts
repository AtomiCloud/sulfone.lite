import { describe, expect, test } from 'bun:test';
import { nextSearchDraft } from './search-draft';

const idle = { pending: false, focused: false, lastPushed: undefined };

describe('nextSearchDraft', () => {
  test('does not overwrite characters typed since while a search navigation is pending', () => {
    // User typed "re", "rea", "reac"; the navigation for "re" lands late and echoes q=re.
    expect(nextSearchDraft({ draft: 'reac', urlQuery: 're', pending: true, focused: true, lastPushed: 'reac' })).toBe(
      'reac',
    );
  });

  test('does not overwrite the draft with an echo of our own push while focused', () => {
    expect(nextSearchDraft({ draft: 'reac', urlQuery: 'rea', pending: false, focused: true, lastPushed: 'rea' })).toBe(
      'reac',
    );
  });

  test('keeps the draft when the URL already matches it', () => {
    expect(nextSearchDraft({ ...idle, draft: 'react', urlQuery: 'react' })).toBe('react');
  });

  test('syncs from the URL on external changes (back button, link) when not editing', () => {
    expect(nextSearchDraft({ ...idle, draft: 'react', urlQuery: '' })).toBe('');
    expect(nextSearchDraft({ ...idle, draft: 'react', urlQuery: 'vue', lastPushed: 'react' })).toBe('vue');
  });

  test('syncs an external change even while focused when it is not our own push', () => {
    expect(
      nextSearchDraft({ draft: 'react', urlQuery: 'vue', pending: false, focused: true, lastPushed: 'react' }),
    ).toBe('vue');
  });
});
