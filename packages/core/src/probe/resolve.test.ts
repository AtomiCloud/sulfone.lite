import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { CyanError } from '@cyanprint/contracts';
import { loadProbeDefinitionFile, resolveProbesForTemplate, resolveProbesFromSource } from './resolve';

// AC7/AC8 — three-tier resolution order, explicit overrides with audit records,
// propagation, diamonds, resolve-or-fail, and contract-version skew. Uses
// plan-1's real parent/child fixtures plus synthetic composition fixtures.

const realTemplatesRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../../examples/templates');

let workRoot: string;
let templatesRoot: string;

beforeAll(async () => {
  workRoot = await mkdtemp(join(tmpdir(), 'cyanprint-resolve-test-'));
  templatesRoot = join(workRoot, 'examples/templates');
  await mkdir(templatesRoot, { recursive: true });
});

afterAll(async () => {
  await rm(workRoot, { recursive: true, force: true });
});

type SyntheticTemplate = {
  name: string;
  templates?: string[];
  probeOverrides?: Record<string, Record<string, string>>;
  /** probes/<feature>.ts sources. */
  probes?: Record<string, string>;
  /** Extra files (e.g. override definition files), path → source. */
  files?: Record<string, string>;
};

async function writeTemplate(spec: SyntheticTemplate): Promise<string> {
  const dir = join(templatesRoot, spec.name);
  await mkdir(dir, { recursive: true });
  const manifest: Record<string, unknown> = {
    cyanprint: 4,
    kind: 'template',
    owner: 'cyanprint',
    name: spec.name,
    bundledEntry: 'cyan.ts',
  };
  if (spec.templates) {
    manifest.templates = Object.fromEntries(spec.templates.map(ref => [ref, null]));
  }
  if (spec.probeOverrides) {
    manifest.probeOverrides = spec.probeOverrides;
  }
  await writeFile(join(dir, 'cyan.yaml'), YAML.stringify(manifest), 'utf8');
  await writeFile(join(dir, 'cyan.ts'), 'export default () => ({});\n', 'utf8');
  for (const [feature, source] of Object.entries(spec.probes ?? {})) {
    await mkdir(join(dir, 'probes'), { recursive: true });
    await writeFile(join(dir, `probes/${feature}.ts`), source, 'utf8');
  }
  for (const [path, source] of Object.entries(spec.files ?? {})) {
    await mkdir(join(dir, dirname(path)), { recursive: true });
    await writeFile(join(dir, path), source, 'utf8');
  }
  return dir;
}

function probeSource(probeName: string, description: string, contractVersion = 1): string {
  return (
    `const definition = { contractVersion: ${contractVersion}, probes: [` +
    `{ name: ${JSON.stringify(probeName)}, description: ${JSON.stringify(description)}, kind: 'baseline', run: () => {} }` +
    `] };\nexport default definition;\n`
  );
}

const resolveArgs = (templateDir: string) => ({ templateDir, workspaceRoot: workRoot });

describe('three-tier resolution order (AC7)', () => {
  test('consumer-own > source-template > built-in, and no cross-template shadowing', async () => {
    await writeTemplate({
      name: 'synth-order-dep',
      probes: {
        gate: probeSource('dep-gate-probe', 'Authored by the dependency.'),
        tests: probeSource('dep-tests-probe', 'Dependency-owned tests probes beat built-ins.'),
      },
    });
    const consumer = await writeTemplate({
      name: 'synth-order-consumer',
      templates: ['cyanprint/synth-order-dep'],
      probes: {
        gate: probeSource('consumer-gate-probe', 'Authored by the consumer for ITS OWN gate feature.'),
      },
    });

    const resolved = await resolveProbesForTemplate({
      ...resolveArgs(consumer),
      features: [
        // Same flat name "gate" declared by two templates: two independent features.
        { template: 'cyanprint/synth-order-consumer', name: 'gate' },
        { template: 'cyanprint/synth-order-dep', name: 'gate' },
        // Dependency's own file beats the built-in of the same name…
        { template: 'cyanprint/synth-order-dep', name: 'tests' },
        // …and a feature with no authored probes lands on the built-in tier.
        { template: 'cyanprint/synth-order-dep', name: 'lint' },
      ],
    });

    const [consumerGate, depGate, depTests, depLint] = resolved;
    expect(consumerGate?.probes[0]?.probe.name).toBe('consumer-gate-probe');
    expect(consumerGate?.probes[0]?.origin).toEqual({ kind: 'local' });
    // The consumer's probes/gate.ts NEVER shadows the dependency's gate feature.
    expect(depGate?.probes[0]?.probe.name).toBe('dep-gate-probe');
    expect(depGate?.probes[0]?.origin).toEqual({
      kind: 'dependency',
      owner: 'cyanprint',
      name: 'synth-order-dep',
      version: 'local',
    });
    expect(depTests?.probes[0]?.probe.name).toBe('dep-tests-probe');
    expect(depTests?.probes[0]?.origin?.kind).toBe('dependency');
    expect(depLint?.probes[0]?.origin).toEqual({ kind: 'built-in' });
    expect(depLint?.probes[0]?.probe.name).toBe('builtin-lint-baseline-green');
  });

  test("plan-1 fixtures: the child's own feature is local, the composed parent's features are dependency-origin", async () => {
    const resolved = await resolveProbesForTemplate({
      templateDir: join(realTemplatesRoot, 'probe-fixture-child-healthy'),
      features: [
        { template: 'cyanprint/probe-fixture-child-healthy', name: 'docs' },
        { template: 'cyanprint/probe-fixture-gated', name: 'tests' },
      ],
    });
    expect(resolved[0]?.probes[0]?.origin).toEqual({ kind: 'local' });
    expect(resolved[0]?.probes[0]?.probe.name).toBe('baseline-usage-doc-present');
    expect(resolved[1]?.probes[0]?.origin).toEqual({
      kind: 'dependency',
      owner: 'cyanprint',
      name: 'probe-fixture-gated',
      version: 'local',
    });
    expect(resolved[1]?.probes.map(entry => entry.probe.name)).toEqual([
      'baseline-test-gate-green',
      'deleting-tests-reddens-gate',
      'failing-test-reddens-gate',
    ]);
  });

  test('a declared feature with no resolution at any tier fails hard, naming the feature (FR2)', async () => {
    const consumer = await writeTemplate({ name: 'synth-unresolvable-consumer' });
    const attempt = resolveProbesForTemplate({
      ...resolveArgs(consumer),
      features: [{ template: 'cyanprint/synth-unresolvable-consumer', name: 'bespoke-feature' }],
    });
    expect(attempt).rejects.toThrow(/bespoke-feature/);
    await attempt.catch((error: unknown) => {
      expect(error).toBeInstanceOf(CyanError);
      expect((error as CyanError).problem.code).toBe('probe_resolution_failed');
    });
  });
});

describe('explicit overrides (AC7)', () => {
  test('a consumer override displaces the dependency probes with a full audit record', async () => {
    await writeTemplate({
      name: 'synth-ovr-dep',
      probes: { gate: probeSource('dep-gate-probe', 'The displaced dependency probe.') },
    });
    const consumer = await writeTemplate({
      name: 'synth-ovr-consumer',
      templates: ['cyanprint/synth-ovr-dep'],
      probeOverrides: { 'cyanprint/synth-ovr-dep': { gate: 'probe-overrides/gate.ts' } },
      files: { 'probe-overrides/gate.ts': probeSource('override-gate-probe', 'The consumer-supplied replacement.') },
    });

    const [resolved] = await resolveProbesForTemplate({
      ...resolveArgs(consumer),
      features: [{ template: 'cyanprint/synth-ovr-dep', name: 'gate' }],
    });
    expect(resolved?.probes[0]?.probe.name).toBe('override-gate-probe');
    expect(resolved?.probes[0]?.origin).toEqual({
      kind: 'override',
      origin: { kind: 'local' },
      displaced: {
        identity: { feature: { template: 'cyanprint/synth-ovr-dep', name: 'gate' }, probe: 'dep-gate-probe' },
        description: 'The displaced dependency probe.',
      },
    });
  });

  test('overrides propagate through composition to a grand-consumer', async () => {
    await writeTemplate({
      name: 'synth-prop-dep',
      probes: { gate: probeSource('dep-gate-probe', 'The displaced dependency probe.') },
    });
    await writeTemplate({
      name: 'synth-prop-mid',
      templates: ['cyanprint/synth-prop-dep'],
      probeOverrides: { 'cyanprint/synth-prop-dep': { gate: 'probe-overrides/gate.ts' } },
      files: { 'probe-overrides/gate.ts': probeSource('mid-override-probe', 'Overridden by the mid template.') },
    });
    const grandConsumer = await writeTemplate({
      name: 'synth-prop-grand',
      templates: ['cyanprint/synth-prop-mid'],
    });

    const [resolved] = await resolveProbesForTemplate({
      ...resolveArgs(grandConsumer),
      features: [{ template: 'cyanprint/synth-prop-dep', name: 'gate' }],
    });
    expect(resolved?.probes[0]?.probe.name).toBe('mid-override-probe');
    // The audit re-flags the override with its ORIGIN: the mid template.
    expect(resolved?.probes[0]?.origin).toEqual({
      kind: 'override',
      origin: { kind: 'dependency', owner: 'cyanprint', name: 'synth-prop-mid', version: 'local' },
      displaced: {
        identity: { feature: { template: 'cyanprint/synth-prop-dep', name: 'gate' }, probe: 'dep-gate-probe' },
        description: 'The displaced dependency probe.',
      },
    });
  });

  test('diamond: the override nearest the final consumer wins', async () => {
    await writeTemplate({
      name: 'synth-near-dep',
      probes: { gate: probeSource('dep-gate-probe', 'The displaced dependency probe.') },
    });
    await writeTemplate({
      name: 'synth-near-mid',
      templates: ['cyanprint/synth-near-dep'],
      probeOverrides: { 'cyanprint/synth-near-dep': { gate: 'probe-overrides/gate.ts' } },
      files: { 'probe-overrides/gate.ts': probeSource('mid-override-probe', 'Farther from the consumer.') },
    });
    const consumer = await writeTemplate({
      name: 'synth-near-consumer',
      templates: ['cyanprint/synth-near-mid', 'cyanprint/synth-near-dep'],
      probeOverrides: { 'cyanprint/synth-near-dep': { gate: 'probe-overrides/gate.ts' } },
      files: { 'probe-overrides/gate.ts': probeSource('consumer-override-probe', 'Nearest the consumer.') },
    });

    const [resolved] = await resolveProbesForTemplate({
      ...resolveArgs(consumer),
      features: [{ template: 'cyanprint/synth-near-dep', name: 'gate' }],
    });
    expect(resolved?.probes[0]?.probe.name).toBe('consumer-override-probe');
    expect(resolved?.probes[0]?.origin?.kind).toBe('override');
  });

  test('equal-distance diamond is a hard error naming both origins, fixable by the final consumer', async () => {
    await writeTemplate({
      name: 'synth-dia-dep',
      probes: { gate: probeSource('dep-gate-probe', 'The displaced dependency probe.') },
    });
    await writeTemplate({
      name: 'synth-dia-left',
      templates: ['cyanprint/synth-dia-dep'],
      probeOverrides: { 'cyanprint/synth-dia-dep': { gate: 'probe-overrides/gate.ts' } },
      files: { 'probe-overrides/gate.ts': probeSource('left-override-probe', 'Left branch override.') },
    });
    await writeTemplate({
      name: 'synth-dia-right',
      templates: ['cyanprint/synth-dia-dep'],
      probeOverrides: { 'cyanprint/synth-dia-dep': { gate: 'probe-overrides/gate.ts' } },
      files: { 'probe-overrides/gate.ts': probeSource('right-override-probe', 'Right branch override.') },
    });
    const consumer = await writeTemplate({
      name: 'synth-dia-consumer',
      templates: ['cyanprint/synth-dia-left', 'cyanprint/synth-dia-right'],
    });

    const features = [{ template: 'cyanprint/synth-dia-dep', name: 'gate' }];
    const attempt = resolveProbesForTemplate({ ...resolveArgs(consumer), features });
    expect(attempt).rejects.toThrow(/synth-dia-left.*synth-dia-right|synth-dia-right.*synth-dia-left/);
    await attempt.catch((error: unknown) => {
      expect((error as CyanError).problem.code).toBe('probe_override_conflict');
    });

    // The final consumer's OWN override declaration resolves the conflict.
    const [resolved] = await resolveProbesForTemplate({
      ...resolveArgs(consumer),
      features,
      overrides: [
        {
          template: 'cyanprint/synth-dia-dep',
          feature: 'gate',
          file: join(templatesRoot, 'synth-dia-left/probe-overrides/gate.ts'),
        },
      ],
    });
    expect(resolved?.probes[0]?.probe.name).toBe('left-override-probe');
    expect(resolved?.probes[0]?.origin).toMatchObject({ kind: 'override', origin: { kind: 'local' } });
  });
});

describe('explicit-source mode', () => {
  test('features match the supplied source directly; a missing definition is a hard error', async () => {
    const sourceDir = join(realTemplatesRoot, 'probe-fixture-gated');
    const [resolved] = await resolveProbesFromSource({
      sourceDir,
      features: [{ template: 'cyanprint/probe-fixture-gated', name: 'tests' }],
    });
    expect(resolved?.probes.map(entry => entry.probe.name)).toContain('deleting-tests-reddens-gate');

    const attempt = resolveProbesFromSource({
      sourceDir,
      features: [{ template: 'cyanprint/probe-fixture-gated', name: 'no-such-feature' }],
    });
    expect(attempt).rejects.toThrow(/no-such-feature/);
  });
});

describe('artifact-shipped probe loading (bundling path)', () => {
  const multiFileProbe = {
    probes: {
      gate:
        `import { gateProbes } from './gate-helper';\n` +
        `const definition = { contractVersion: 1, probes: gateProbes };\n` +
        `export default definition;\n`,
    },
    files: {
      'probes/gate-helper.ts':
        `export const gateProbes = [` +
        `{ name: 'bundled-gate-probe', description: 'Loaded through the artifact bundle path.', kind: 'baseline', run: () => {} }` +
        `];\n`,
    },
  };

  test('a dependency resolved from the artifact-bundle cache loads its probes through compileRuntimeBundle', async () => {
    const dep = await writeTemplate({ name: 'synth-artifact-dep', ...multiFileProbe });
    const consumer = await writeTemplate({
      name: 'synth-artifact-consumer',
      templates: ['cyanprint/synth-artifact-dep'],
    });
    // Simulate a hydrated published artifact: a bundle-cache index in the consumer
    // dir points the dependency at a runtime file inside the dep dir. resolveDevTemplate
    // then reports fromArtifactCache=true, so the dependency's probe files take the
    // bundling branch (compileRuntimeBundle) instead of a direct import.
    await writeFile(
      join(consumer, '.cyan_artifact_bundles.json'),
      JSON.stringify({
        bundles: [{ key: 'template:cyanprint:synth-artifact-dep', runtimeFile: join(dep, 'dist/runtime.js') }],
      }),
      'utf8',
    );

    const [resolved] = await resolveProbesForTemplate({
      ...resolveArgs(consumer),
      features: [{ template: 'cyanprint/synth-artifact-dep', name: 'gate' }],
    });
    // The sibling-module import was inlined by the bundler; the probe resolved with
    // a dependency origin (proving it came from the composed artifact, not local).
    expect(resolved?.probes[0]?.probe.name).toBe('bundled-gate-probe');
    expect(resolved?.probes[0]?.origin).toEqual({
      kind: 'dependency',
      owner: 'cyanprint',
      name: 'synth-artifact-dep',
      version: 'local',
    });
  });

  test('loadProbeDefinitionFile bundles a multi-file probe (relative imports inlined) under bundled:true', async () => {
    const dep = await writeTemplate({ name: 'synth-bundle-multifile', ...multiFileProbe });
    const definition = await loadProbeDefinitionFile(join(dep, 'probes/gate.ts'), 'cyanprint/synth-bundle-multifile', {
      bundled: true,
    });
    expect(definition.probes[0]?.name).toBe('bundled-gate-probe');
    expect(definition.contractVersion).toBe(1);
  });
});

describe('contract-version skew (AC8)', () => {
  test('an unsupported contract version fails loudly with origin attribution, never a skip', async () => {
    const consumer = await writeTemplate({
      name: 'synth-skew-consumer',
      probes: { gate: probeSource('future-probe', 'Written against a future contract.', 99) },
    });
    const attempt = resolveProbesForTemplate({
      ...resolveArgs(consumer),
      features: [{ template: 'cyanprint/synth-skew-consumer', name: 'gate' }],
    });
    // The failure names the origin template AND the file, and both versions.
    expect(attempt).rejects.toThrow(/synth-skew-consumer.*probes\/gate\.ts|probes\/gate\.ts/);
    await attempt.catch((error: unknown) => {
      expect((error as CyanError).problem.code).toBe('probe_contract_version_unsupported');
      expect((error as CyanError).message).toContain('cyanprint/synth-skew-consumer');
      expect((error as CyanError).message).toContain('99');
    });
  });
});
