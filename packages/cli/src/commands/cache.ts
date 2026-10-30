import { readdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, parse, resolve } from 'node:path';
import { ArtifactKindSchema, CyanError, problem } from '@cyanprint/contracts';
import { resolveCyanCacheDir } from '@cyanprint/core';
import { parseFlags, flagBool } from '../args';
import { kv, printJson, printSection, success } from '../ui';

// The only top-level entries the engine ever creates in a cache dir (artifact kinds + processor output).
const CACHE_ENTRY_NAMES = new Set<string>([...ArtifactKindSchema.options, 'processor-output']);

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
  const entries = await readdir(root).catch(() => [] as string[]);
  const foreign = entries.filter(name => !CACHE_ENTRY_NAMES.has(name));
  if (foreign.length > 0) {
    throw new CyanError(
      problem(
        'validation',
        'cache_dir_not_engine_owned',
        `Refusing to clean ${root}: it contains entries the cyanprint cache never creates (${foreign.slice(0, 5).join(', ')}). Nothing was deleted.`,
        { cacheDir: root, unexpected: foreign.slice(0, 20) },
      ),
    );
  }
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
