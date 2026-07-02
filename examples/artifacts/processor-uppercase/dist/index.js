// @bun
// examples/artifacts/processor-uppercase/src/index.ts
async function processor(input, fs) {
  const files = await fs.read();
  await fs.write(
    files.map(file => (file.content === undefined ? file : { ...file, content: file.content.toUpperCase() })),
  );
}
export { processor };
