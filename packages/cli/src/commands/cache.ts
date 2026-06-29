import { rm } from 'node:fs/promises';
import { resolveCyanCacheDir } from '@cyanprint/core';
import { parseFlags, flagBool } from '../args';
import { kv, printJson, printSection, success } from '../ui';

export async function cacheCommand(argv: string[]): Promise<void> {
  const { positional, flags } = parseFlags(argv);
  const action = positional[0] ?? 'inspect';
  const cacheDir = resolveCyanCacheDir(typeof flags['cache-dir'] === 'string' ? flags['cache-dir'] : undefined);
  if (action === 'clean') {
    await rm(cacheDir, { recursive: true, force: true });
    const report = { status: 'done', action, cacheDir };
    if (flagBool(flags, 'json')) {
      printJson(report);
    } else {
      console.log(success(`cleaned cache ${cacheDir}`));
    }
    return;
  }
  const report = { status: 'done', action: 'inspect', cacheDir };
  if (flagBool(flags, 'json')) {
    printJson(report);
  } else {
    printSection('Cache', [kv('path', cacheDir)]);
  }
}
