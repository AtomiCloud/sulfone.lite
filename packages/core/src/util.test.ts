import { describe, expect, test } from 'bun:test';
import { mapWithConcurrency } from './util';

describe('mapWithConcurrency', () => {
  test('runs up to N tasks concurrently and preserves input order', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const items = [1, 2, 3, 4, 5, 6];
    const output = await mapWithConcurrency(items, 3, async value => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(resolve => setTimeout(resolve, 10));
      inFlight -= 1;
      return value * 2;
    });
    expect(output).toEqual([2, 4, 6, 8, 10, 12]);
    expect(maxInFlight).toBe(3);
  });

  test('a limit of 1 runs sequentially (never more than one in flight)', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    await mapWithConcurrency([1, 2, 3], 1, async value => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(resolve => setTimeout(resolve, 5));
      inFlight -= 1;
      return value;
    });
    expect(maxInFlight).toBe(1);
  });
});
