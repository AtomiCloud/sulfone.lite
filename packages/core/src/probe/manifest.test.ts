import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { CyanError, ProbeManifestSchema } from '@cyanprint/contracts';
import { exists, readText, writeText } from '../util';
import {
  PROBE_MANIFEST_FILE,
  checkProbeManifestDrift,
  deriveTemplateFeatureSet,
  generateProbeManifest,
  renderProbeManifest,
  writeProbeManifest,
} from './manifest';

// AC9 — manifest generation with the full audit trail, byte-exact drift
// checking, and the committed fixture manifests verified in-plan.

const realTemplatesRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../../examples/templates');

let workRoot: string;
let templatesRoot: string;

beforeAll(async () => {
  workRoot = await mkdtemp(join(tmpdir(), 'cyanprint-manifest-test-'));
  templatesRoot = join(workRoot, 'examples/templates');
  await mkdir(templatesRoot, { recursive: true });

  // A synthetic composition exercising every origin kind:
  //  - consumer's own feature  → local
  //  - dep feature with probes → dependency
  //  - dep feature w/o probes  → built-in ("lint" is a built-in category)
  //  - dep feature overridden  → override (displacing the dep's probe)
  await writeSynthetic('synth-mani-dep', {
    features: ['covered', 'helper', 'lint'],
    probes: {
      covered: probeSource('dep-covered-probe', 'The displaced dependency probe.'),
      helper: probeSource('dep-helper-probe', 'Inherited from the dependency.'),
    },
  });
  await writeSynthetic('synth-mani-consumer', {
    features: ['own-gate'],
    templates: ['cyanprint/synth-mani-dep'],
    probeOverrides: { 'cyanprint/synth-mani-dep': { covered: 'probe-overrides/covered.ts' } },
    probes: { 'own-gate': probeSource('consumer-own-probe', 'Authored by the consumer.') },
    files: { 'probe-overrides/covered.ts': probeSource('override-covered-probe', 'The consumer replacement.') },
  });
});

afterAll(async () => {
  await rm(workRoot, { recursive: true, force: true });
});

function probeSource(probeName: string, description: string): string {
  return (
    `const definition = { contractVersion: 1, probes: [` +
    `{ name: ${JSON.stringify(probeName)}, description: ${JSON.stringify(description)}, kind: 'baseline', run: () => {} }` +
    `] };\nexport default definition;\n`
  );
}

async function writeSynthetic(
  name: string,
  spec: {
    features: string[];
    templates?: string[];
    probeOverrides?: Record<string, Record<string, string>>;
    probes?: Record<string, string>;
    files?: Record<string, string>;
  },
): Promise<string> {
  const dir = join(templatesRoot, name);
  await mkdir(dir, { recursive: true });
  const manifest: Record<string, unknown> = {
    cyanprint: 4,
    kind: 'template',
    owner: 'cyanprint',
    name,
    bundledEntry: 'cyan.ts',
  };
  if (spec.templates) {
    manifest.templates = Object.fromEntries(spec.templates.map(ref => [ref, null]));
  }
  if (spec.probeOverrides) {
    manifest.probeOverrides = spec.probeOverrides;
  }
  await writeFile(join(dir, 'cyan.yaml'), YAML.stringify(manifest), 'utf8');
  await writeFile(
    join(dir, 'cyan.ts'),
    `export default function cyan() {\n  return { features: ${JSON.stringify(spec.features)} };\n}\n`,
    'utf8',
  );
  await writeFile(join(dir, 'cyan.test.yaml'), 'cases:\n  - name: basic\n', 'utf8');
  for (const [feature, source] of Object.entries(spec.probes ?? {})) {
    await writeText(join(dir, `probes/${feature}.ts`), source);
  }
  for (const [path, source] of Object.entries(spec.files ?? {})) {
    await writeText(join(dir, path), source);
  }
  return dir;
}

const consumerDir = () => join(templatesRoot, 'synth-mani-consumer');

describe('probe manifest generation (AC9)', () => {
  test('the feature set derives from the test profiles’ generations, per-template identity', async () => {
    const features = await deriveTemplateFeatureSet(consumerDir());
    expect(features).toEqual([
      { template: 'cyanprint/synth-mani-consumer', name: 'own-gate' },
      { template: 'cyanprint/synth-mani-dep', name: 'covered' },
      { template: 'cyanprint/synth-mani-dep', name: 'helper' },
      { template: 'cyanprint/synth-mani-dep', name: 'lint' },
    ]);
  });

  test('generation records the full audit trail: all four origin kinds', async () => {
    const manifest = await generateProbeManifest(consumerDir(), { workspaceRoot: workRoot });
    expect(ProbeManifestSchema.safeParse(manifest).success).toBe(true);

    const originOf = (name: string) => manifest.features.find(feature => feature.name === name)?.probes[0]?.origin;
    expect(originOf('own-gate')).toEqual({ kind: 'local' });
    expect(originOf('helper')).toEqual({
      kind: 'dependency',
      owner: 'cyanprint',
      name: 'synth-mani-dep',
      version: 'local',
    });
    expect(originOf('lint')).toEqual({ kind: 'built-in' });
    expect(originOf('covered')).toEqual({
      kind: 'override',
      origin: { kind: 'local' },
      displaced: {
        identity: {
          feature: { template: 'cyanprint/synth-mani-dep', name: 'covered' },
          probe: 'dep-covered-probe',
        },
        description: 'The displaced dependency probe.',
      },
    });
  });

  test('an in-sync committed manifest passes; a hand-edited one fails with a diff; a missing one fails', async () => {
    const dir = consumerDir();
    const manifest = await writeProbeManifest(dir, { workspaceRoot: workRoot });
    expect(await readText(join(dir, PROBE_MANIFEST_FILE))).toBe(renderProbeManifest(manifest));
    await checkProbeManifestDrift(dir, { workspaceRoot: workRoot });

    // Hand edit → hard, diff-printing drift failure.
    const committed = await readText(join(dir, PROBE_MANIFEST_FILE));
    await writeText(join(dir, PROBE_MANIFEST_FILE), committed.replace('The consumer replacement.', 'Edited by hand.'));
    const drifted = checkProbeManifestDrift(dir, { workspaceRoot: workRoot });
    expect(drifted).rejects.toThrow(/probes\.yaml/);
    await drifted.catch((error: unknown) => {
      expect((error as CyanError).problem.code).toBe('probe_manifest_drift');
      expect((error as CyanError).message).toContain('-'); // unified diff body
      expect((error as CyanError).message).toContain('Edited by hand.');
    });

    // Missing manifest → drift failure too (feature-declaring templates must commit one).
    await rm(join(dir, PROBE_MANIFEST_FILE));
    const missing = checkProbeManifestDrift(dir, { workspaceRoot: workRoot });
    expect(missing).rejects.toThrow(/Missing committed/);

    // Restore an in-sync manifest for any later assertions.
    await writeProbeManifest(dir, { workspaceRoot: workRoot });
  });
});

describe('committed fixture manifests (AC9, in-plan verification)', () => {
  test('every feature-declaring probe fixture carries a committed, drift-clean probes.yaml; probe-less ones carry none', async () => {
    const fixtures = (await readdir(realTemplatesRoot, { withFileTypes: true }))
      .filter(entry => entry.isDirectory() && entry.name.startsWith('probe-fixture-'))
      .map(entry => join(realTemplatesRoot, entry.name));
    expect(fixtures.length).toBeGreaterThanOrEqual(8);

    const withManifest: string[] = [];
    for (const dir of fixtures) {
      const declares = (await deriveTemplateFeatureSet(dir).catch(() => [])).length > 0;
      const committed = await exists(join(dir, PROBE_MANIFEST_FILE));
      // The pinned rule: feature-declaring templates (built-ins-only included)
      // commit a machine-generated manifest; templates declaring nothing need none.
      expect(`${dir}: declares=${declares} committed=${committed}`).toBe(
        `${dir}: declares=${declares} committed=${declares}`,
      );
      if (committed) {
        withManifest.push(dir);
        await checkProbeManifestDrift(dir);
      }
    }
    expect(withManifest.map(dir => dir.split('/').pop()).sort()).toEqual([
      'probe-fixture-builtins',
      'probe-fixture-child-healthy',
      'probe-fixture-gated',
    ]);
  }, 300_000);
});
