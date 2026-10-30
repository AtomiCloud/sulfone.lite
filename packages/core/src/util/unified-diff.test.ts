import { describe, expect, test } from 'bun:test';
import { unifiedDiff } from './unified-diff';

describe('unifiedDiff', () => {
  test('stays bounded and correct for very large fully-different inputs', () => {
    const size = 20_000;
    const before = Array.from({ length: size }, (_, i) => `old-${i}`).join('\n');
    const after = Array.from({ length: size }, (_, i) => `new-${i}`).join('\n');
    const started = performance.now();
    const diff = unifiedDiff(before, after);
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(diff).toContain(`@@ -1,${size} +1,${size} @@`);
    expect(diff).toContain('-old-0\n');
    expect(diff).toContain(`+new-${size - 1}\n`);
  });

  test('keeps minimal output around a small change in a large file', () => {
    const lines = Array.from({ length: 50_000 }, (_, i) => `line-${i}`);
    const changed = [...lines];
    changed[25_000] = 'changed';
    const diff = unifiedDiff(lines.join('\n'), changed.join('\n'));
    expect(diff).toContain('-line-25000\n+changed\n');
    expect(diff.split('\n').length).toBeLessThan(20);
  });
});
