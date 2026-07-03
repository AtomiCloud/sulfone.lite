// @bun
// src/index.ts
function resolver(input) {
  const sorted = [...input.files].sort(
    (left, right) =>
      left.origin.layer - right.origin.layer || left.origin.template.localeCompare(right.origin.template),
  );
  const first = sorted[0];
  if (!first) {
    throw new Error('resolver2 was invoked with no variations');
  }
  const parts = sorted
    .map(file => file.content)
    .filter(content => Boolean(content.trim()))
    .map(content => content.trimEnd());
  return {
    path: first.path,
    content: `${parts.join(`
`)}
`,
  };
}
export { resolver };
