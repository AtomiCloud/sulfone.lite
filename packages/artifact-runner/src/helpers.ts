// Runtime helper factories. These are called by the CyanPrint runtime to build the
// helper objects passed into processors/plugins. Artifact authors never import these
// (they receive a constructed helper as the second argument).

import type { ExecOptions, ExecResult, PluginHelper, ProcessorFsHelper } from './sdk-types';
import { readVfsFiles, writeVfsFiles } from './fs-utils';

export function createProcessorFsHelper(context: ProcessorFsHelper['context']): ProcessorFsHelper {
  return {
    context,
    read: () => readVfsFiles(context.inputDir),
    write: files => writeVfsFiles(context.outputDir, files),
  };
}

export function createPluginHelper(context: PluginHelper['context']): PluginHelper {
  return {
    context,
    read: () => readVfsFiles(context.inputDir),
    write: files => writeVfsFiles(context.outputDir, files),
    exec: (command, options) => exec(command, { cwd: context.outputDir, ...options }),
  };
}

/**
 * Run a shell command via Bun Shell. Captures stdout/stderr/exit code and throws on a
 * non-zero exit unless `options.throwOnError === false`. Runs in `options.cwd` when given.
 */
export async function exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
  const throwOnError = options.throwOnError ?? true;
  let shell = Bun.$`${{ raw: command }}`.quiet().nothrow();
  if (options.cwd !== undefined) {
    shell = shell.cwd(options.cwd);
  }
  if (options.env !== undefined) {
    shell = shell.env({ ...(process.env as Record<string, string>), ...options.env });
  }
  const output = await shell;
  const result: ExecResult = {
    stdout: output.stdout.toString(),
    stderr: output.stderr.toString(),
    exitCode: output.exitCode,
  };
  if (throwOnError && result.exitCode !== 0) {
    const detail = result.stderr.trim();
    throw new Error(`Command failed with exit code ${result.exitCode}: ${command}${detail ? `\n${detail}` : ''}`);
  }
  return result;
}
