// @bun
// examples/artifacts/plugin-footer/src/index.ts
function plugin(input) {
  const { files } = input;
  return Object.fromEntries(
    Object.entries(files).map(([path, content]) => [
      path,
      `${content}
Generated locally.
`,
    ]),
  );
}
export { plugin };
