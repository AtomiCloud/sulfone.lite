import { describe, expect, test } from 'bun:test';
import {
  PROBE_CONTRACT_VERSION,
  ProbeDefinitionSchema,
  ProbeManifestSchema,
  ProbeRunReportSchema,
  ProbeVerdictSchema,
} from './probe';
import type { ProbeDefinition } from './probe';
import type { CyanOutput } from './script';

const manifestProbe = {
  name: 'deleting-tests-reddens-gate',
  description: 'Removing the test suite must turn the test gate red.',
  kind: 'mutation',
} as const;

function manifestWithOrigin(origin: unknown): unknown {
  return {
    contractVersion: PROBE_CONTRACT_VERSION,
    features: [
      {
        template: 'cyanprint/probe-fixture-gated',
        name: 'tests',
        probes: [{ ...manifestProbe, origin }],
      },
    ],
  };
}

describe('probe contract', () => {
  test('contract version starts at 1', () => {
    expect(PROBE_CONTRACT_VERSION).toBe(1);
  });

  test('CyanOutput accepts flat feature declarations', () => {
    const output: CyanOutput = { features: ['tests', 'lint'] };
    expect(output.features).toEqual(['tests', 'lint']);
  });

  test('manifest accepts a valid fixture for each resolution origin kind', () => {
    const origins = [
      { kind: 'local' },
      { kind: 'dependency', owner: 'cyanprint', name: 'probe-fixture-parent', version: '4' },
      { kind: 'built-in' },
      {
        kind: 'override',
        origin: { kind: 'local' },
        displaced: {
          identity: {
            feature: { template: 'cyanprint/probe-fixture-parent', name: 'tests' },
            probe: 'deleting-tests-reddens-gate',
          },
          description: 'Removing the test suite must turn the test gate red.',
        },
      },
    ];
    for (const origin of origins) {
      const parsed = ProbeManifestSchema.safeParse(manifestWithOrigin(origin));
      expect(parsed.success).toBe(true);
    }
  });

  test('manifest rejects a probe without a description', () => {
    const manifest = manifestWithOrigin({ kind: 'local' }) as {
      features: Array<{ probes: Array<Record<string, unknown>> }>;
    };
    delete manifest.features[0]?.probes[0]?.description;
    expect(ProbeManifestSchema.safeParse(manifest).success).toBe(false);
  });

  test('manifest rejects a multi-line probe description', () => {
    for (const description of ['line one\nline two', 'line one\r\nline two']) {
      const manifest = manifestWithOrigin({ kind: 'local' }) as {
        features: Array<{ probes: Array<Record<string, unknown>> }>;
      };
      manifest.features[0]!.probes[0]!.description = description;
      expect(ProbeManifestSchema.safeParse(manifest).success).toBe(false);
    }
  });

  test('override origin rejects a multi-line displaced description', () => {
    const manifest = manifestWithOrigin({
      kind: 'override',
      origin: { kind: 'local' },
      displaced: {
        identity: {
          feature: { template: 'cyanprint/probe-fixture-parent', name: 'tests' },
          probe: 'deleting-tests-reddens-gate',
        },
        description: 'line one\nline two',
      },
    });
    expect(ProbeManifestSchema.safeParse(manifest).success).toBe(false);
  });

  test('manifest rejects an unknown resolution origin kind', () => {
    expect(ProbeManifestSchema.safeParse(manifestWithOrigin({ kind: 'implicit' })).success).toBe(false);
  });

  test('override origin requires the displaced probe identity and description', () => {
    const missingDisplaced = manifestWithOrigin({ kind: 'override', origin: { kind: 'built-in' } });
    expect(ProbeManifestSchema.safeParse(missingDisplaced).success).toBe(false);
  });

  test('verdict vocabulary is fixed and rejects unknown verdicts', () => {
    for (const verdict of ['proven', 'caught', 'missed', 'invalid', 'broken']) {
      expect(ProbeVerdictSchema.safeParse(verdict).success).toBe(true);
    }
    expect(ProbeVerdictSchema.safeParse('flaky').success).toBe(false);
  });

  test('run report is the manifest shape with a verdict per probe', () => {
    const report = {
      contractVersion: PROBE_CONTRACT_VERSION,
      features: [
        {
          template: 'cyanprint/probe-fixture-gated',
          name: 'tests',
          probes: [{ ...manifestProbe, origin: { kind: 'local' }, verdict: 'caught' }],
        },
      ],
    };
    expect(ProbeRunReportSchema.safeParse(report).success).toBe(true);
    const badVerdict = structuredClone(report) as {
      features: Array<{ probes: Array<{ verdict: string }> }>;
    };
    badVerdict.features[0]!.probes[0]!.verdict = 'flaky';
    expect(ProbeRunReportSchema.safeParse(badVerdict).success).toBe(false);

    const multiLineDescription = structuredClone(report) as {
      features: Array<{ probes: Array<{ description: string }> }>;
    };
    multiLineDescription.features[0]!.probes[0]!.description = 'line one\nline two';
    expect(ProbeRunReportSchema.safeParse(multiLineDescription).success).toBe(false);
  });

  test('probe definition validates declarative parts and requires run to be a function', () => {
    const definition: ProbeDefinition = {
      contractVersion: PROBE_CONTRACT_VERSION,
      sandbox: { snapshot: 'auto', preserve: ['node_modules'] },
      setup: { pre: ['bun install'] },
      probes: [
        {
          name: 'baseline-ci-green',
          description: 'The untouched repo passes its full ci.sh gate chain.',
          kind: 'baseline',
          run: async repo => {
            await repo.exec('bash scripts/ci.sh');
          },
        },
      ],
    };
    expect(ProbeDefinitionSchema.safeParse(definition).success).toBe(true);

    const noDescription = {
      ...definition,
      probes: [{ name: 'x', kind: 'baseline', run: () => undefined }],
    };
    expect(ProbeDefinitionSchema.safeParse(noDescription).success).toBe(false);

    const runNotAFunction = {
      ...definition,
      probes: [{ ...definition.probes[0], run: 'bash scripts/ci.sh' }],
    };
    expect(ProbeDefinitionSchema.safeParse(runNotAFunction).success).toBe(false);

    const multiLineDescription = {
      ...definition,
      probes: [{ ...definition.probes[0], description: 'line one\nline two' }],
    };
    expect(ProbeDefinitionSchema.safeParse(multiLineDescription).success).toBe(false);
  });
});
