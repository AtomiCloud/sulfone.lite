import { expect, test } from 'bun:test';
import { add } from '../src/calc.js';

test('add sums two numbers', () => {
  expect(add(2, 3)).toBe(5);
});
