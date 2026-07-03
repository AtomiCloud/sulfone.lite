// v4 resolver contract: one call per conflicting path with every variation at once.
export function resolver(input) {
  const sorted = [...input.files].sort(
    (left, right) =>
      left.origin.layer - right.origin.layer ||
      (left.origin.template < right.origin.template ? -1 : left.origin.template > right.origin.template ? 1 : 0),
  );
  const lines = sorted
    .flatMap(file => String(file.content ?? '').split('\n'))
    .map(value => value.trim())
    .filter(Boolean);
  return { path: sorted[0].path, content: [...new Set(lines)].sort().join('\n') + '\n' };
}
