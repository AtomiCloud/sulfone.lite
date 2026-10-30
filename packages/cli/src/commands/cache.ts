import { rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, parse, resolve } from 'node:path';
import { CyanError, problem } from '@cyanprint/contracts';
import { CACHE_ROOT_MARKER, inspectCacheRoot, resolveCyanCacheDir } from '@cyanprint/core';
import { parseFlags, flagBool } from '../args';
import { kv, printJson, printSection, success } from '../ui';

/** Deletes only engine-created cache entries; refuses any directory that holds anything else. */
async function cleanCacheDir(cacheDir: string): Promise<void> {
  const root = resolve(cacheDir);
  if (root === parse(root).root || root === resolve(homedir()) || root === resolve(process.cwd())) {
    throw new CyanError(
      problem(
        'validation',
        'cache_dir_unsafe',
        `Refusing to clean ${root}: it is a filesystem root, your home directory or the current directory. Point --cache-dir at a dedicated cache directory.`,
        { cacheDir: root },
      ),
    );
  }
  // The engine marks every cache root it creates; an unmarked directory (a cache from before
  // markers existed) is only cleaned when every entry matches the engine's own naming scheme.
  const inspected = await inspectCacheRoot(root);
  if (inspected.state === 'foreign') {
    throw new CyanError(
      problem(
        'validation',
        'cache_dir_not_engine_owned',
        `Refusing to clean ${root}: it is not a cyanprint cache (no ${CACHE_ROOT_MARKER} marker) and contains entries the cache never creates (${inspected.foreign.slice(0, 5).join(', ')}). Nothing was deleted.`,
        { cacheDir: root, unexpected: inspected.foreign.slice(0, 20) },
      ),
    );
  }
  const entries = inspected.state === 'empty' ? [] : inspected.entries;
  for (const name of entries) {
    await rm(join(root, name), { recursive: true, force: true });
  }
}

export async function cacheCommand(argv: string[]): Promise<void> {
  const { positional, flags } = parseFlags(argv);
  const action = positional[0] ?? 'inspect';
  const cacheDir = resolveCyanCacheDir(typeof flags['cache-dir'] === 'string' ? flags['cache-dir'] : undefined);
  if (action === 'clean') {
    await cleanCacheDir(cacheDir);
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
