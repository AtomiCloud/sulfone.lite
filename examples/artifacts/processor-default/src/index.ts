import { Eta } from 'eta';

export function processor(input: { files: Record<string, string>; config?: unknown }): Record<string, string> {
  const { files, config } = input;
  const processorConfig = readConfig(config);
  return Object.fromEntries(
    Object.entries(files).map(([path, content]) => [
      renderTemplate(path, processorConfig),
      normalizeTrailingWhitespace(renderTemplate(content, processorConfig)),
    ]),
  );
}

type DefaultProcessorConfig = {
  vars: Record<string, unknown>;
  varSyntax: Array<[string, string]>;
};

const defaultVarSyntax: Array<[string, string]> = [
  ['var__', '__'],
  ['__', '__'],
];

function readConfig(config: unknown): DefaultProcessorConfig {
  if (!isRecord(config)) {
    return { vars: {}, varSyntax: defaultVarSyntax };
  }
  const vars = isRecord(config.vars) ? config.vars : {};
  const parser = isRecord(config.parser) ? config.parser : {};
  const configuredSyntax = Array.isArray(parser.varSyntax) ? parser.varSyntax.filter(isStringPair) : undefined;
  return { vars, varSyntax: configuredSyntax && configuredSyntax.length > 0 ? configuredSyntax : defaultVarSyntax };
}

function renderTemplate(content: string, config: DefaultProcessorConfig): string {
  let rendered = content;
  for (const tags of config.varSyntax) {
    const masked = maskUnknownSimplePlaceholders(rendered, config.vars, tags);
    rendered = new Eta({
      autoEscape: false,
      autoTrim: [false, false],
      parse: { exec: '=', interpolate: '', raw: '~' },
      tags,
      useWith: true,
    }).renderString(masked.content, config.vars);
    rendered = restoreMaskedPlaceholders(rendered, masked.placeholders);
  }
  return rendered;
}

function maskUnknownSimplePlaceholders(
  content: string,
  vars: Record<string, unknown>,
  tags: [string, string],
): { content: string; placeholders: string[] } {
  const placeholders: string[] = [];
  const [open, close] = tags.map(escapeRegExp);
  const padded = tags[0] === '__' && tags[1] === '__' ? '' : '\\s*';
  const pattern = new RegExp(`${open}${padded}([A-Za-z_$][\\w$]*)${padded}${close}`, 'g');
  return {
    content: content.replace(pattern, (match, name: string) => {
      if (name in vars) {
        return match;
      }
      const index = placeholders.push(match) - 1;
      return `@@CYANPRINT_MASK_${index}@@`;
    }),
    placeholders,
  };
}

function restoreMaskedPlaceholders(content: string, placeholders: string[]): string {
  return placeholders.reduce(
    (result, placeholder, index) => result.replaceAll(`@@CYANPRINT_MASK_${index}@@`, placeholder),
    content,
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
