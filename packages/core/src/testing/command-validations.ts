import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exists } from '../util';

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

export async function runCommandValidations(root: string, commands: CommandValidation[]): Promise<string | undefined> {
  if (commands.length === 0) {
    return undefined;
  }
  const localBin = await createLocalCyanprintBin();
  try {
    for (const validation of commands) {
      const invocation = validation.shell
        ? [process.env.SHELL || 'sh', '-lc', validation.command]
        : [validation.command, ...validation.args];
      const proc = Bun.spawn(invocation, {
        cwd: root,
        stdout: 'pipe',
        stderr: 'pipe',
        env: {
          ...process.env,
          PATH: localBin ? `${localBin}:${process.env.PATH ?? ''}` : process.env.PATH,
          PWD: root,
        },
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      if (exitCode !== 0) {
        return `Command failed (${formatCommand(validation)}): ${stderr || stdout}`;
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
  const cliPath = await findLocalCliPath(dirname(fileURLToPath(import.meta.url)));
  if (!(await exists(cliPath))) {
    return undefined;
  }
  const binDir = join(tmpdir(), `cyanprint-validation-bin-${process.pid}-${Date.now()}`);
  await mkdir(binDir, { recursive: true });
  const shim = join(binDir, 'cyanprint');
  await writeFile(shim, `#!/bin/sh\nexec bun run ${shellQuote(cliPath)} "$@"\n`, 'utf8');
  await chmod(shim, 0o755);
  return binDir;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
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
