// @bun
// src/index.ts
function resolver(input) {
  const winner = [...input.files].sort(
    (left, right) =>
      right.origin.layer - left.origin.layer || right.origin.template.localeCompare(left.origin.template),
  )[0];
  if (!winner) {
    throw new Error('keep-user was invoked with no variations');
  }
  return { path: winner.path, content: winner.content };
}
export { resolver };
