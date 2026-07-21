import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeCommand, readFeatureSet } from './probe';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('--features evidence classes', () => {
  test('should preserve gate, smoke, and presence classes from object entries', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cyanprint-features-'));
    tempDirs.push(dir);
    const file = join(dir, 'features.json');
    await writeFile(
      file,
      JSON.stringify([
        { template: 'local/tpl', name: 'compile', class: 'gate' },
        { template: 'local/tpl', name: 'launch', class: 'smoke' },
        { template: 'local/tpl', name: 'config', class: 'presence' },
      ]),
      'utf8',
    );

    expect(await readFeatureSet(file, dir)).toEqual([
      { template: 'local/tpl', name: 'compile', class: 'gate' },
      { template: 'local/tpl', name: 'launch', class: 'smoke' },
      { template: 'local/tpl', name: 'config', class: 'presence' },
    ]);
  });

  test('should reject an unknown class instead of silently dropping it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cyanprint-features-'));
    tempDirs.push(dir);
    const file = join(dir, 'features.json');
    await writeFile(file, JSON.stringify([{ template: 'local/tpl', name: 'compile', class: 'mystery' }]), 'utf8');

    await expect(readFeatureSet(file, dir)).rejects.toThrow('class must be one of');
  });

  test('should write classed per-child exit and output tails into the report artifact', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cyanprint-report-'));
    tempDirs.push(dir);
    const repo = join(dir, 'repo');
    const source = join(dir, 'source');
    const features = join(dir, 'features.json');
    const report = join(dir, 'report.json');
    await mkdir(repo, { recursive: true });
    await mkdir(join(source, 'probes'), { recursive: true });
    await writeFile(
      join(source, 'probes', 'launch.ts'),
      `export default {
        contractVersion: 1,
        probes: [{
          name: 'launches',
          description: 'The generated repository launches.',
          kind: 'baseline',
          run: () => {
            console.log('child-stdout');
            console.error('child-stderr');
          },
        }],
      };\n`,
      'utf8',
    );
    await writeFile(features, JSON.stringify([{ template: 'local/tpl', name: 'launch', class: 'smoke' }]), 'utf8');

    await probeCommand([repo, '--probes', source, '--features', features, '--report', report]);
    const payload = JSON.parse(await Bun.file(report).text()) as {
      events: Array<{
        class?: string;
        feature: string;
        probe: string;
        verdict: string;
        exitCode: number | null;
        stdoutTail: string;
        stderrTail: string;
      }>;
    };

    expect(payload.events).toHaveLength(1);
    expect(payload.events[0]).toMatchObject({
      class: 'smoke',
      feature: 'local/tpl#launch',
      probe: 'launches',
      verdict: 'proven',
      exitCode: 0,
    });
    expect(payload.events[0]?.stdoutTail).toContain('child-stdout');
    expect(payload.events[0]?.stderrTail).toContain('child-stderr');
  });
});
