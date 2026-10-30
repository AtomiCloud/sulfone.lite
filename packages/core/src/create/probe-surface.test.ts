import { afterEach, describe, expect, test } from 'bun:test';
import { lstat, mkdir, mkdtemp, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CompatibilityWarning } from '@cyanprint/contracts';
import { runPostGenerationCommands } from './create-project';

const dirs: string[] = [];

async function project(): Promise<{ root: string; out: string }> {
  const root = await mkdtemp(join(tmpdir(), 'cyanprint-probe-surface-'));
  dirs.push(root);
  const out = join(root, 'project');
  await mkdir(out, { recursive: true });
  return { root, out };
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

const shell = (script: string) => ({ command: 'sh', args: ['-c', script], allow: true });

describe('post-generation probe surface reconcile', () => {
  test('keeps a symlinked probe path that existed before the commands ran', async () => {
    const { root, out } = await project();
    await mkdir(join(root, 'shared/probes'), { recursive: true });
    await writeFile(join(root, 'shared/probes/gate.ts'), '// shared\n', 'utf8');
    await symlink('../shared/probes', join(out, 'probes'));
    await symlink('../shared/probes.yaml', join(out, 'probes.yaml'));

    const warnings: CompatibilityWarning[] = [];
    const failure = await runPostGenerationCommands([shell('echo ok > ran.txt')], { outDir: out }, warnings);

    expect(failure).toBeUndefined();
    expect(await readlink(join(out, 'probes'))).toBe('../shared/probes');
    expect(await readlink(join(out, 'probes.yaml'))).toBe('../shared/probes.yaml');
    expect(warnings).toEqual([]);
  });

  test('removes a symlink a command created at a probe path', async () => {
    const { root, out } = await project();
    const warnings: CompatibilityWarning[] = [];
    await runPostGenerationCommands(
      [shell(`ln -s ${root} probes; ln -s ${root} probes.yaml`)],
      { outDir: out },
      warnings,
    );

    expect(await lstat(join(out, 'probes')).catch(() => undefined)).toBeUndefined();
    expect(await lstat(join(out, 'probes.yaml')).catch(() => undefined)).toBeUndefined();
    expect(warnings.map(warning => warning.code)).toContain('post_generation_probe_output_removed');
  });

  test('restores a pre-existing probe symlink a command deleted or retargeted', async () => {
    const { root, out } = await project();
    await mkdir(join(root, 'shared'), { recursive: true });
    await symlink('../shared', join(out, 'probes'));
    await symlink('../shared/a.yaml', join(out, 'probes.yaml'));

    const warnings: CompatibilityWarning[] = [];
    await runPostGenerationCommands(
      [shell('rm probes probes.yaml; mkdir probes; ln -s /tmp probes.yaml')],
      { outDir: out },
      warnings,
    );

    expect(await readlink(join(out, 'probes'))).toBe('../shared');
    expect(await readlink(join(out, 'probes.yaml'))).toBe('../shared/a.yaml');
  });

  test('does not walk unrelated trees: probe-looking names below the root are not the probe surface', async () => {
    const { out } = await project();
    await mkdir(join(out, 'src/probes'), { recursive: true });
    await writeFile(join(out, 'src/probes/keep.ts'), '// nested\n', 'utf8');
    const warnings: CompatibilityWarning[] = [];
    await runPostGenerationCommands([shell('echo x > src/probes/new.ts')], { outDir: out }, warnings);

    expect(await Bun.file(join(out, 'src/probes/new.ts')).text()).toBe('x\n');
    expect(warnings).toEqual([]);
  });
});
