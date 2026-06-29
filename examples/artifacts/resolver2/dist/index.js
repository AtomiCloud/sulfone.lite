// @bun
// examples/artifacts/resolver2/src/index.ts
function resolver(input) {
  const parts = [...input.files]
    .sort(
      (left, right) =>
        left.origin.layer - right.origin.layer || left.origin.template.localeCompare(right.origin.template),
    )
    .map(file => file.content)
    .filter(content => Boolean(content?.trim()))
    .map(content => content.trimEnd());
  return `${parts.join(`
`)}
`;
}
export { resolver };
