// @bun
// examples/artifacts/processor-default/src/index.ts
function processor(input) {
  const { files, config } = input;
  const processorConfig = readConfig(config);
  return Object.fromEntries(
    Object.entries(files).map(([path, content]) => [
      path,
      normalizeTrailingWhitespace(renderVars(content, processorConfig.vars, processorConfig.varSyntax)),
    ]),
  );
}
function readConfig(config) {
  if (!isRecord(config)) {
    return { vars: {}, varSyntax: [['__', '__']] };
  }
  const vars = isRecord(config.vars)
    ? Object.fromEntries(Object.entries(config.vars).map(([key, value]) => [key, String(value)]))
    : {};
  const parser = isRecord(config.parser) ? config.parser : {};
  const configuredSyntax = Array.isArray(parser.varSyntax) ? parser.varSyntax.filter(isStringPair) : undefined;
  return { vars, varSyntax: configuredSyntax && configuredSyntax.length > 0 ? configuredSyntax : [['__', '__']] };
}
function renderVars(content, vars, varSyntax) {
  let rendered = content;
  for (const [key, value] of Object.entries(vars)) {
    for (const [open, close] of varSyntax) {
      rendered = rendered.replaceAll(`${open}${key}${close}`, value);
    }
  }
  return rendered;
}
function normalizeTrailingWhitespace(content) {
  return content
    .replace(
      /\r\n/g,
      `
`,
    )
    .replace(/[ \t]+$/gm, '')
    .replace(
      /\n*$/,
      `
`,
    );
}
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isStringPair(value) {
  return Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && typeof value[1] === 'string';
}
export { processor };
