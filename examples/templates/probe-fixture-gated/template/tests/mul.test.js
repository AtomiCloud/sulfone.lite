import { expect, test } from 'bun:test';
import { mul } from '../src/calc.js';

test('mul multiplies two numbers', () => {
  expect(mul(2, 3)).toBe(6);
});
