// @bun
// examples/artifacts/plugin-footer/src/index.ts
async function plugin(input, helper) {
  const files = await helper.read();
  await helper.write(
    files.map(file =>
      file.content === undefined
        ? file
        : {
            ...file,
            content: `${file.content}
Generated locally.
`,
          },
    ),
  );
}
export { plugin };
