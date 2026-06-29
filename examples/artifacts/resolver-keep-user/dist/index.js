// @bun
// examples/artifacts/resolver-keep-user/src/index.ts
function resolver(input) {
  const current = input.files.find(file => file.origin.template === 'current');
  if (current) {
    return current.content;
  }
  return [...input.files].sort((left, right) => right.origin.layer - left.origin.layer)[0]?.content ?? '';
}
export { resolver };
