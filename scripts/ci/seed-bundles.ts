import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compileRuntimeBundle } from '../../packages/artifact-bundler/src/build-bundle';

export async function readSeedBundle(
  dir: string,
  manifest: { kind: string; entry: string; bundledEntry: string },
): Promise<string> {
  if (manifest.kind === 'processor' || manifest.kind === 'plugin' || manifest.kind === 'resolver') {
    const tempDir = await mkdtemp(join(tmpdir(), 'cyanprint-seed-bundle-'));
    try {
      const output = join(tempDir, 'bundle.js');
      await compileRuntimeBundle({
        entrypoint: join(dir, manifest.entry),
        output,
        kind: manifest.kind,
        validateExport: false,
      });
      return await Bun.file(output).text();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
  return await Bun.file(`${dir}/${manifest.bundledEntry}`).text();
}
