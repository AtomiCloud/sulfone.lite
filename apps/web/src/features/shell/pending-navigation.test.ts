import { describe, expect, test } from 'bun:test';
import { createPendingNavigation } from './pending-navigation';

function setup() {
  const queue = new Map<number, () => void>();
  let id = 0;
  const replaced: string[] = [];
  const pending = createPendingNavigation(url => replaced.push(url), 120, {
    setTimeout: callback => {
      id += 1;
      queue.set(id, callback);
      return id;
    },
    clearTimeout: handle => {
      queue.delete(handle as number);
    },
  });
  // Only the debounce timer is the first queued one; the safety timer is queued by issue().
  const fireNext = () => {
    const first = queue.entries().next().value;
    if (first) {
      queue.delete(first[0]);
      first[1]();
    }
  };
  return { pending, replaced, fireNext };
}

describe('createPendingNavigation', () => {
  test('debounces: only the latest deferred navigation fires', () => {
    const { pending, replaced, fireNext } = setup();
    pending.schedule('/search?q=a', { defer: true });
    pending.schedule('/search?q=ab', { defer: true });
    fireNext();
    expect(replaced).toEqual(['/search?q=ab']);
  });

  test('does not settle while the debounce timer is still queued', () => {
    const { pending } = setup();
    pending.schedule('/search?q=ab', { defer: true });
    pending.settle('/search?q=ab');
    expect(pending.target()).toBe('/search?q=ab');
  });

  test('cancel drops a queued navigation', () => {
    const { pending, replaced, fireNext } = setup();
    pending.schedule('/search?q=a', { defer: true });
    pending.cancel();
    fireNext();
    expect(replaced).toEqual([]);
    expect(pending.target()).toBeUndefined();
  });

  test('landing on the target settles it', () => {
    const { pending, fireNext } = setup();
    pending.schedule('/search?q=a', { defer: true });
    fireNext();
    pending.settle('/search?q=a');
    expect(pending.target()).toBeUndefined();
  });
});
