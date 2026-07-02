// Minimal line-based LCS unified diff. No external dependency.

type Op = { type: ' ' | '-' | '+'; line: string };

function diffLines(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    const row = dp[i]!;
    const nextRow = dp[i + 1]!;
    for (let j = m - 1; j >= 0; j -= 1) {
      row[j] = a[i] === b[j] ? nextRow[j + 1]! + 1 : Math.max(nextRow[j]!, row[j + 1]!);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: ' ', line: a[i]! });
      i += 1;
      j += 1;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      ops.push({ type: '-', line: a[i]! });
      i += 1;
    } else {
      ops.push({ type: '+', line: b[j]! });
      j += 1;
    }
  }
  while (i < n) {
    ops.push({ type: '-', line: a[i]! });
    i += 1;
  }
  while (j < m) {
    ops.push({ type: '+', line: b[j]! });
    j += 1;
  }
  return ops;
}

type Hunk = { aStart: number; aLen: number; bStart: number; bLen: number; lines: Op[] };

function groupHunks(ops: Op[], context: number): Hunk[] {
  const changed = ops.map((op, index) => (op.type === ' ' ? -1 : index)).filter(index => index >= 0);
  if (changed.length === 0) {
    return [];
  }
  const groups: Array<[number, number]> = [];
  let start = changed[0]!;
  let end = changed[0]!;
  for (const index of changed.slice(1)) {
    if (index - end <= context * 2 + 1) {
      end = index;
    } else {
      groups.push([start, end]);
      start = index;
      end = index;
    }
  }
  groups.push([start, end]);

  const hunks: Hunk[] = [];
  for (const [groupStart, groupEnd] of groups) {
    const lo = Math.max(0, groupStart - context);
    const hi = Math.min(ops.length - 1, groupEnd + context);
    let aBefore = 0;
    let bBefore = 0;
    for (let k = 0; k < lo; k += 1) {
      if (ops[k]!.type !== '+') aBefore += 1;
      if (ops[k]!.type !== '-') bBefore += 1;
    }
    let aLen = 0;
    let bLen = 0;
    const lines: Op[] = [];
    for (let k = lo; k <= hi; k += 1) {
      const op = ops[k]!;
      lines.push(op);
      if (op.type !== '+') aLen += 1;
      if (op.type !== '-') bLen += 1;
    }
    // Unified-diff convention: a zero-length range references the line BEFORE the hunk.
    hunks.push({
      aStart: aLen === 0 ? aBefore : aBefore + 1,
      aLen,
      bStart: bLen === 0 ? bBefore : bBefore + 1,
      bLen,
      lines,
    });
  }
  return hunks;
}

export function unifiedDiff(
  before: string,
  after: string,
  opts: { fromLabel?: string; toLabel?: string; context?: number } = {},
): string {
  if (before === after) {
    return '';
  }
  const a = before.length > 0 ? before.split('\n') : [];
  const b = after.length > 0 ? after.split('\n') : [];
  const ops = diffLines(a, b);
  const hunks = groupHunks(ops, opts.context ?? 3);
  if (hunks.length === 0) {
    return '';
  }
  const from = opts.fromLabel ?? 'before';
  const to = opts.toLabel ?? 'after';
  let out = `--- ${from}\n+++ ${to}\n`;
  for (const hunk of hunks) {
    out += `@@ -${hunk.aStart},${hunk.aLen} +${hunk.bStart},${hunk.bLen} @@\n`;
    out += `${hunk.lines.map(op => `${op.type}${op.line}`).join('\n')}\n`;
  }
  return out;
}
