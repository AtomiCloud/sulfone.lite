import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Probe } from '@cyanprint/contracts';
import { CyanError } from '@cyanprint/contracts';
import { buildProbeMatrix, mergeProbeRunConfig, probeKey, type ResolvedFeatureProbes } from './matrix';
import { executeProbeMatrix } from './executor';
import { resolveProbesFromSource } from './resolve';

let workRoot: string;

beforeAll(async () => {
  workRoot = await mkdtemp(join(tmpdir(), 'cyanprint-matrix-test-'));
});

afterAll(async () => {
  await rm(workRoot, { recursive: true, force: true });
});

function resolvedFeature(template: string, name: string, probes: Probe[]): ResolvedFeatureProbes {
  return {
    feature: { template, name },
    definition: { contractVersion: 1, probes },
    probes: probes.map(probe => ({ probe, origin: { kind: 'local' } })),
  };
}

function baseline(name: string, run: Probe['run'] = () => {}): Probe {
  return { name, description: `baseline ${name}`, kind: 'baseline', run };
}

function mutation(name: string, run: Probe['run'], expectedImpact?: string[]): Probe {
  return { name, description: `mutation ${name}`, kind: 'mutation', expectedImpact, run };
}

describe('probe matrix shape (AC4)', () => {
  test('F features with M total mutations produce exactly 1 + M runs with correct controls', () => {
    const features = [
      resolvedFeature('local/tpl', 'alpha', [
        baseline('alpha-base'),
        mutation('alpha-m1', () => {}),
        mutation('alpha-m2', () => {}),
      ]),
      resolvedFeature('local/tpl', 'beta', [baseline('beta-base'), mutation('beta-m1', () => {})]),
      resolvedFeature('local/tpl', 'gamma', [baseline('gamma-base-1'), baseline('gamma-base-2')]),
    ];
    const runs = buildProbeMatrix(features);

    expect(runs).toHaveLength(1 + 3);
    const [baselineRun, ...mutationRuns] = runs;
    if (baselineRun?.kind !== 'baseline') {
      throw new Error('first run must be the baseline run');
    }
    expect(baselineRun.baselines.map(planned => planned.probe.name)).toEqual([
      'alpha-base',
      'beta-base',
      'gamma-base-1',
      'gamma-base-2',
    ]);

    for (const run of mutationRuns) {
      if (run.kind !== 'mutation') {
        throw new Error('subsequent runs must be mutation runs');
      }
      // Exactly one fault; controls are every OTHER feature's baselines.
      const ownFeature = run.mutation.feature.name;
      expect(run.controls.every(control => control.feature.name !== ownFeature)).toBe(true);
    }
    const alphaRun = mutationRuns.find(run => run.kind === 'mutation' && run.mutation.probe.name === 'alpha-m1');
    if (alphaRun?.kind !== 'mutation') {
      throw new Error('alpha-m1 run missing');
    }
    expect(alphaRun.controls.map(control => control.probe.name)).toEqual(['beta-base', 'gamma-base-1', 'gamma-base-2']);
  });
});

describe('run config merge', () => {
  test('conflicting explicit snapshot strategies are a hard error', () => {
    const features = [
      resolvedFeature('local/tpl', 'alpha', [baseline('a')]),
      resolvedFeature('local/tpl', 'beta', [baseline('b')]),
    ];
    features[0]!.definition.sandbox = { snapshot: 'git' };
    features[1]!.definition.sandbox = { snapshot: 'fs' };
    expect(() => mergeProbeRunConfig(features)).toThrow(CyanError);
  });

  test('preserve lists union and setup phases concatenate with duplicates run once', () => {
    const features = [
      resolvedFeature('local/tpl', 'alpha', [baseline('a')]),
      resolvedFeature('local/tpl', 'beta', [baseline('b')]),
    ];
    features[0]!.definition.sandbox = { snapshot: 'auto', preserve: ['deps'] };
    features[0]!.definition.setup = { pre: ['echo shared'], post: ['echo post-a'] };
    features[1]!.definition.sandbox = { snapshot: 'git', preserve: ['deps', 'cache'] };
    features[1]!.definition.setup = { pre: ['echo shared', 'echo pre-b'] };
    expect(mergeProbeRunConfig(features)).toEqual({
      sandbox: { snapshot: 'git', preserve: ['deps', 'cache'] },
      setup: { pre: ['echo shared', 'echo pre-b'], post: ['echo post-a'] },
    });
  });
});

/**
 * Plant a uniquely-named marker, then self-check isolation FROM INSIDE the isolated
 * runner: throw if any FOREIGN marker is visible. A throw flips the verdict away
 * from `caught`, so the assertion survives the process boundary (there is no shared
 * in-process array to inspect). Controls (baselines running after a mutation) throw
 * on more than one marker — stacked faults.
 */
function isolationProbes(marker: string): string {
  return `[
    { name: '${marker}-base', description: 'control ${marker}-base', kind: 'baseline', run: async (repo) => {
        const seen = await repo.glob('sabotage-*.txt');
        if (seen.length > 1) { throw new Error('control saw stacked faults: ' + seen.join(', ')); }
      } },
    { name: '${marker}-m1', description: 'mutation ${marker}-m1', kind: 'mutation', expectedImpact: ['other'], run: async (repo) => {
        await repo.write('sabotage-${marker}-m1.txt', '${marker}-m1\\n');
        await Bun.sleep(100);
        const foreign = (await repo.glob('sabotage-*.txt')).filter(p => p !== 'sabotage-${marker}-m1.txt');
        if (foreign.length) { throw new Error('isolation leak: ' + foreign.join(', ')); }
      } },
    { name: '${marker}-m2', description: 'mutation ${marker}-m2', kind: 'mutation', expectedImpact: ['other'], run: async (repo) => {
        await repo.write('sabotage-${marker}-m2.txt', '${marker}-m2\\n');
        await Bun.sleep(100);
        const foreign = (await repo.glob('sabotage-*.txt')).filter(p => p !== 'sabotage-${marker}-m2.txt');
        if (foreign.length) { throw new Error('isolation leak: ' + foreign.join(', ')); }
      } },
  ]`;
}

describe('run isolation (AC2)', () => {
  test('sabotage in one run is not observable in any other run nor in the original repo', async () => {
    const repo = join(workRoot, 'isolation-repo');
    await mkdir(repo, { recursive: true });
    await writeFile(join(repo, 'app.txt'), 'healthy\n', 'utf8');

    const sourceDir = join(workRoot, 'isolation-source');
    await mkdir(join(sourceDir, 'probes'), { recursive: true });
    for (const marker of ['alpha', 'beta'] as const) {
      await writeFile(
        join(sourceDir, 'probes', `${marker}.ts`),
        `export default { contractVersion: 1, probes: ${isolationProbes(marker)} };\n`,
        'utf8',
      );
    }
    const features = await resolveProbesFromSource({
      sourceDir,
      features: [
        { template: 'local/tpl', name: 'alpha' },
        { template: 'local/tpl', name: 'beta' },
      ],
    });

    const execution = await executeProbeMatrix({
      repoPath: repo,
      features,
      options: { keepSandboxes: true, sandboxRoot: join(workRoot, 'isolation-sandboxes') },
    });
    // Every mutation is `caught`: it planted its marker (probe returns) AND saw no
    // foreign marker (no throw). A leak would have thrown → verdict not `caught`.
    expect(execution.verdicts.get(probeKey({ template: 'local/tpl', name: 'alpha' }, 'alpha-m1'))).toBe('caught');
    expect(execution.verdicts.get(probeKey({ template: 'local/tpl', name: 'alpha' }, 'alpha-m2'))).toBe('caught');
    expect(execution.verdicts.get(probeKey({ template: 'local/tpl', name: 'beta' }, 'beta-m1'))).toBe('caught');

    // Per-sandbox inspection: the baseline run's sandbox carries NO sabotage; each
    // mutation run's sandbox carries exactly its own fault and nothing else.
    for (const run of execution.runs) {
      if (!run.sandboxPath) {
        throw new Error('sandbox was not retained');
      }
      const markers = await Array.fromAsync(new Bun.Glob('sabotage-*.txt').scan({ cwd: run.sandboxPath }));
      if (run.kind === 'baseline') {
        expect(markers).toEqual([]);
      } else {
        expect(markers).toEqual([`sabotage-${run.mutation?.probe}.txt`]);
      }
    }

    // The original materialized repo is never touched.
    expect(await readFile(join(repo, 'app.txt'), 'utf8')).toBe('healthy\n');
    expect(await Array.fromAsync(new Bun.Glob('sabotage-*.txt').scan({ cwd: repo }))).toEqual([]);
  });
});
