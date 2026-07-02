import { rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { loadManifest } from '@cyanprint/core';
import { buildBundle } from '@cyanprint/artifact-bundler';
import { parseFlags, flagBool } from '../args';
import { info, kv, pathLabel, printJson, printSection, success } from '../ui';

export async function bundleCommand(argv: string[]): Promise<void> {
  const { positional, flags } = parseFlags(argv);
  const artifactDir = positional[0];
  if (!artifactDir) {
    throw new Error('bundle requires an artifact directory');
  }
  const json = flagBool(flags, 'json');
  const { manifest } = await loadManifest(artifactDir);
  if (!['processor', 'plugin', 'resolver'].includes(manifest.kind)) {
    throw new Error(`bundle requires a processor, plugin, or resolver; got ${manifest.kind}`);
  }
  if (!flagBool(flags, 'no-install')) {
    await ensureDependencies(artifactDir, json);
  }
  const bundle = await buildBundle({ artifactDir, dryRun: flagBool(flags, 'dry-run') });
  if (json) {
    printJson({ status: 'bundled', bundle });
  } else {
    console.log(success(`bundled ${pathLabel(manifest.bundledEntry)}`));
    printSection('Bundle', [
      kv('runtime', bundle.runtimeFile),
      kv('sha256', bundle.sha256),
      kv('dry run', bundle.dryRun),
    ]);
  }
  if (bundle.temporaryDirectory) {
    await rm(bundle.temporaryDirectory, { recursive: true, force: true });
  }
}

async function ensureDependencies(artifactDir: string, json: boolean): Promise<void> {
  if (!(await Bun.file(join(artifactDir, 'package.json')).exists())) {
    return;
  }
  if (await stat(join(artifactDir, 'node_modules')).catch(() => undefined)) {
    return;
  }
  if (!json) {
    console.log(info(`installing dependencies in ${pathLabel(artifactDir)}`));
  }
  const result = await Bun.$`bun install`.cwd(artifactDir).quiet().nothrow();
  if (result.exitCode !== 0) {
    throw new Error(`bundle could not install dependencies in ${artifactDir}: ${result.stderr.toString().trim()}`);
  }
}
