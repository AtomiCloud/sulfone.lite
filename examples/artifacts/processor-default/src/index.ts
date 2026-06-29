export function processor(input: { files: Record<string, string>; config?: unknown }): Record<string, string> {
  const { files, config } = input;
  const processorConfig = readConfig(config);
  return Object.fromEntries(
    Object.entries(files).map(([path, content]) => [
      path,
      normalizeTrailingWhitespace(renderVars(content, processorConfig.vars, processorConfig.varSyntax)),
    ]),
  );
}

type DefaultProcessorConfig = {
  vars: Record<string, string>;
  varSyntax: Array<[string, string]>;
};

function readConfig(config: unknown): DefaultProcessorConfig {
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

function renderVars(content: string, vars: Record<string, string>, varSyntax: Array<[string, string]>): string {
  let rendered = content;
  for (const [key, value] of Object.entries(vars)) {
    for (const [open, close] of varSyntax) {
      rendered = rendered.replaceAll(`${open}${key}${close}`, value);
    }
  }
  return rendered;
}

function normalizeTrailingWhitespace(content: string): string {
  return content
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n*$/, '\n');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringPair(value: unknown): value is [string, string] {
  return Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && typeof value[1] === 'string';
}
