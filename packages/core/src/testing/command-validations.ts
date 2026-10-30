import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeEngineRunDir } from '@cyanprint/contracts/run-dir';
import { IS_COMPILED_BINARY } from '../probe/probe-process';
import { runDetachedCommand } from '../probe/spawn';
import { exists } from '../util';

/** Upper bound for one validation command; a hung gate must not hang the run. */
export const DEFAULT_VALIDATION_TIMEOUT_MS = 5 * 60 * 1000;

export type CommandValidation =
  | {
      command: string;
      args: string[];
      shell?: false;
    }
  | {
      command: string;
      args: [];
      shell: true;
    };

/** Largest delay `setTimeout` honours; anything bigger overflows and fires immediately. */
const MAX_TIMEOUT_MS = 2_147_483_647;

/** Read an optional per-case `validationTimeoutMs` (positive integer milliseconds). */
export function readValidationTimeoutMs(value: unknown, label: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0 || value > MAX_TIMEOUT_MS) {
    throw new Error(`${label} must be a positive integer (milliseconds, at most ${MAX_TIMEOUT_MS}).`);
  }
  return value;
}

export function readCommandValidations(value: unknown, label: string): CommandValidation[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array.`);
  }
  return value.map((rawCommand, index) => {
    if (typeof rawCommand === 'string') {
      return { command: rawCommand, args: [], shell: true };
    }
    if (!rawCommand || typeof rawCommand !== 'object') {
      throw new Error(`${label}[${index}] must be a string or mapping.`);
    }
    const record = rawCommand as Record<string, unknown>;
    if (typeof record.shell === 'string' && record.shell.length > 0) {
      return { command: record.shell, args: [], shell: true };
    }
    const command = readRequiredString(record.command, `${label}[${index}].command`);
    const args = record.args;
    if (args !== undefined && (!Array.isArray(args) || args.some(arg => typeof arg !== 'string'))) {
      throw new Error(`${label}[${index}].args must be an array of strings.`);
    }
    return { command, args: args ? (args as string[]) : [] };
  });
}

export async function runCommandValidations(
  root: string,
  commands: CommandValidation[],
  options: { timeoutMs?: number } = {},
): Promise<string | undefined> {
  if (commands.length === 0) {
    return undefined;
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_VALIDATION_TIMEOUT_MS;
  const localBin = await createLocalCyanprintBin();
  try {
    for (const validation of commands) {
      // Always `sh -c` (never the caller's login shell + profile, which makes the
      // result machine-dependent); structured commands are quoted into one line.
      const command = validation.shell
        ? validation.command
        : [validation.command, ...validation.args].map(shellQuote).join(' ');
      const result = await runDetachedCommand({
        command,
        cwd: root,
        timeoutMs,
        env: {
          ...process.env,
          PATH: localBin ? `${localBin}:${process.env.PATH ?? ''}` : process.env.PATH,
          PWD: root,
        },
      });
      if (result.timedOut) {
        return `Command failed (${formatCommand(validation)}): timed out after ${timeoutMs}ms`;
      }
      if (result.exitCode !== 0) {
        return `Command failed (${formatCommand(validation)}): ${result.stderr || result.stdout}`;
      }
    }
    return undefined;
  } finally {
    if (localBin) {
      await rm(localBin, { recursive: true, force: true });
    }
  }
}

function formatCommand(validation: CommandValidation): string {
  return validation.shell ? validation.command : [validation.command, ...validation.args].join(' ');
}

function readRequiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

async function createLocalCyanprintBin(): Promise<string | undefined> {
  const invocation = await findLocalCliInvocation(dirname(fileURLToPath(import.meta.url)));
  if (!invocation) {
    return undefined;
  }
  const binDir = await makeEngineRunDir('cyanprint-validation-bin');
  const shim = join(binDir, 'cyanprint');
  await writeFile(shim, `#!/bin/sh\nexec ${invocation.map(shellQuote).join(' ')} "$@"\n`, 'utf8');
  await chmod(shim, 0o755);
  return binDir;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * The argv prefix the `cyanprint` validation shim execs. A compiled binary re-enters ITSELF
 * (never a sulfone checkout that happens to be the cwd); a source run uses the CLI entry found
 * beside this package.
 */
export async function findLocalCliInvocation(
  start: string,
  options: { compiled?: boolean; execPath?: string } = {},
): Promise<string[] | undefined> {
  if (options.compiled ?? IS_COMPILED_BINARY) {
    return [options.execPath ?? process.execPath];
  }
  const cliPath = await findLocalCliPath(start);
  return (await exists(cliPath)) ? ['bun', 'run', cliPath] : undefined;
}

async function findLocalCliPath(start: string): Promise<string> {
  let current = start;
  while (true) {
    const candidate = join(current, 'packages/cli/src/main.ts');
    if (await exists(candidate)) {
      return candidate;
    }
    const parent = dirname(current);
    if (parent === current) {
      return join(process.cwd(), 'packages/cli/src/main.ts');
    }
    current = parent;
  }
}
