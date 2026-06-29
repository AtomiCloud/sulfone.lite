// @bun
// examples/artifacts/processor-uppercase/src/index.ts
function processor(input) {
  const { files } = input;
  return Object.fromEntries(Object.entries(files).map(([path, content]) => [path, content.toUpperCase()]));
}
export { processor };
