import { readFile } from 'node:fs/promises';

export function parseFlags(argv: string[]): { positional: string[]; flags: Record<string, string | boolean> } {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) {
      continue;
    }
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const key = arg.slice(2);
    // `--flag=value` form: unambiguous even for values that start with `--` or are empty.
    const separator = key.indexOf('=');
    if (separator >= 0) {
      flags[key.slice(0, separator)] = key.slice(separator + 1);
      continue;
    }
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      flags[key] = true;
    } else {
      flags[key] = next;
      index += 1;
    }
  }
  return { positional, flags };
}

export function flagString(
  flags: Record<string, string | boolean>,
  name: string,
  fallback?: string,
): string | undefined {
  const value = flags[name];
  return typeof value === 'string' ? value : fallback;
}

export function flagBool(flags: Record<string, string | boolean>, name: string): boolean {
  return flags[name] === true || flags[name] === 'true';
}

/** Shared `--parallel N` parser: a positive integer worker count, or undefined when absent. */
export function parseParallel(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`--parallel must be a positive integer, got "${value}"`);
  }
  return parsed;
}

export async function readAnswersFile(path: string): Promise<Record<string, unknown>> {
  const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Answers file must contain a JSON object of answers: ${path}`);
  }
  return parsed as Record<string, unknown>;
}
