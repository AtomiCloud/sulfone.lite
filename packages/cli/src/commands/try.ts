import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import type { PromptAdapter } from '@cyanprint/contracts';
import { makeEngineRunDir } from '@cyanprint/contracts/run-dir';
import { flagString, parseFlags } from '../args';
import { createCommand } from './create';

type CliRuntime = {
  promptAdapter?: PromptAdapter;
  promptAdapterFactory?: (answers: Record<string, unknown>) => PromptAdapter;
};

export async function tryCommand(argv: string[], runtime: CliRuntime = {}): Promise<void> {
  const { positional, flags } = parseFlags(argv);
  const outDir = flagString(flags, 'out') ?? positional[1];
  const effectiveArgv = outDir ? argv : [...argv, '--out', await makeEngineRunDir('cyanprint-try', { retain: true })];
  await createCommand(effectiveArgv, runtime);
}
