import { describe, expect, test } from 'bun:test';
import {
  PROBE_CONTRACT_VERSION,
  ProbeDefinitionSchema,
  ProbeFeatureIdentitySchema,
  ProbeManifestSchema,
  ProbeRunReportSchema,
  ProbeVerdictSchema,
  isProbeInapplicable,
  probeInapplicable,
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
    // Arrange — the first published contract version
    const expected = 1;

    // Act — read the published contract version constant
    const actual = PROBE_CONTRACT_VERSION;

    // Assert
    expect(actual).toBe(expected);
  });

  test('CyanOutput accepts flat feature declarations', () => {
    // Arrange
    const output: CyanOutput = { features: ['tests', 'lint'] };

    // Act
    const actual = output.features;

    // Assert
    expect(actual).toEqual(['tests', 'lint']);
  });

  test('feature identity preserves known evidence classes and rejects unknown ones', () => {
    expect(
      ProbeFeatureIdentitySchema.parse({
        template: 'cyanprint/probe-fixture-gated',
        name: 'tests',
        class: 'smoke',
      }),
    ).toEqual({ template: 'cyanprint/probe-fixture-gated', name: 'tests', class: 'smoke' });
    expect(
      ProbeFeatureIdentitySchema.safeParse({
        template: 'cyanprint/probe-fixture-gated',
        name: 'tests',
        class: 'unknown',
      }).success,
    ).toBe(false);
  });

  test('manifest accepts a valid fixture for each resolution origin kind', () => {
    // Arrange
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
      // Act
      const parsed = ProbeManifestSchema.safeParse(manifestWithOrigin(origin));
      // Assert
      expect(parsed.success).toBe(true);
    }
  });

  test('manifest rejects a probe without a description', () => {
    // Arrange
    const manifest = manifestWithOrigin({ kind: 'local' }) as {
      features: Array<{ probes: Array<Record<string, unknown>> }>;
    };
    delete manifest.features[0]?.probes[0]?.description;

    // Act
    const result = ProbeManifestSchema.safeParse(manifest);

    // Assert
    expect(result.success).toBe(false);
  });

  test('manifest rejects a multi-line probe description', () => {
    // Arrange
    const descriptions = ['line one\nline two', 'line one\r\nline two'];

    for (const description of descriptions) {
      // Arrange (per case)
      const manifest = manifestWithOrigin({ kind: 'local' }) as {
        features: Array<{ probes: Array<Record<string, unknown>> }>;
      };
      manifest.features[0]!.probes[0]!.description = description;

      // Act
      const result = ProbeManifestSchema.safeParse(manifest);

      // Assert
      expect(result.success).toBe(false);
    }
  });

  test('override origin rejects a multi-line displaced description', () => {
    // Arrange
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

    // Act
    const result = ProbeManifestSchema.safeParse(manifest);

    // Assert
    expect(result.success).toBe(false);
  });

  test('manifest rejects an unknown resolution origin kind', () => {
    // Arrange
    const manifest = manifestWithOrigin({ kind: 'implicit' });

    // Act
    const result = ProbeManifestSchema.safeParse(manifest);

    // Assert
    expect(result.success).toBe(false);
  });

  test('override origin requires the displaced probe identity and description', () => {
    // Arrange
    const missingDisplaced = manifestWithOrigin({ kind: 'override', origin: { kind: 'built-in' } });

    // Act
    const result = ProbeManifestSchema.safeParse(missingDisplaced);

    // Assert
    expect(result.success).toBe(false);
  });

  test('verdict vocabulary is fixed and rejects unknown verdicts', () => {
    // Arrange
    const validVerdicts = ['proven', 'caught', 'missed', 'invalid', 'broken'];

    // Act
    const validResults = validVerdicts.map(verdict => ProbeVerdictSchema.safeParse(verdict).success);
    const unknownResult = ProbeVerdictSchema.safeParse('flaky').success;

    // Assert
    expect(validResults.every(Boolean)).toBe(true);
    expect(unknownResult).toBe(false);
  });

  test('run report is the manifest shape with a verdict per probe', () => {
    // Arrange
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
    // Two mutated clones: one with an unknown verdict, one with a multi-line description.
    const badVerdict = structuredClone(report) as {
      features: Array<{ probes: Array<{ verdict: string }> }>;
    };
    badVerdict.features[0]!.probes[0]!.verdict = 'flaky';
    const multiLineDescription = structuredClone(report) as {
      features: Array<{ probes: Array<{ description: string }> }>;
    };
    multiLineDescription.features[0]!.probes[0]!.description = 'line one\nline two';

    // Act
    const validResult = ProbeRunReportSchema.safeParse(report).success;
    const badVerdictResult = ProbeRunReportSchema.safeParse(badVerdict).success;
    const multiLineResult = ProbeRunReportSchema.safeParse(multiLineDescription).success;

    // Assert
    expect(validResult).toBe(true);
    expect(badVerdictResult).toBe(false);
    expect(multiLineResult).toBe(false);
  });

  test('probe definition validates declarative parts and requires run to be a function', () => {
    // Arrange
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
    // Three invalid variants: one whose probe drops the description, one whose `run`
    // is a string rather than a function, one whose description spans multiple lines.
    const noDescription = {
      ...definition,
      probes: [{ name: 'x', kind: 'baseline', run: () => undefined }],
    };
    const runNotAFunction = {
      ...definition,
      probes: [{ ...definition.probes[0], run: 'bash scripts/ci.sh' }],
    };
    const multiLineDescription = {
      ...definition,
      probes: [{ ...definition.probes[0], description: 'line one\nline two' }],
    };

    // Act
    const validResult = ProbeDefinitionSchema.safeParse(definition).success;
    const noDescriptionResult = ProbeDefinitionSchema.safeParse(noDescription).success;
    const runNotAFunctionResult = ProbeDefinitionSchema.safeParse(runNotAFunction).success;
    const multiLineResult = ProbeDefinitionSchema.safeParse(multiLineDescription).success;

    // Assert
    expect(validResult).toBe(true);
    expect(noDescriptionResult).toBe(false);
    expect(runNotAFunctionResult).toBe(false);
    expect(multiLineResult).toBe(false);
  });

  // Verdicts are keyed by (template, feature, probe name), so two
  // probes sharing a name would overwrite each other's verdicts (FR7 violation).
  // The schema rejects duplicates loudly, naming the offending probe.
  test('probe definition rejects duplicate probe names, naming the duplicate', () => {
    // Arrange
    const probe = (name: string, kind: 'baseline' | 'mutation') => ({
      name,
      description: 'Probe description.',
      kind,
      run: () => undefined,
    });
    const duplicated = {
      contractVersion: PROBE_CONTRACT_VERSION,
      probes: [probe('same', 'baseline'), probe('same', 'mutation')],
    };

    // Act
    const result = ProbeDefinitionSchema.safeParse(duplicated);

    // Assert
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map(issue => issue.message).join('\n')).toContain('duplicate probe name "same"');
    }

    // Arrange: a definition whose probe names are distinct is accepted.
    const distinct = {
      contractVersion: PROBE_CONTRACT_VERSION,
      probes: [probe('a-baseline', 'baseline'), probe('a-mutation', 'mutation')],
    };

    // Act
    const distinctResult = ProbeDefinitionSchema.safeParse(distinct);

    // Assert
    expect(distinctResult.success).toBe(true);
  });
});

describe('probe inapplicability signal', () => {
  test('probeInapplicable errors are recognized across module realms via the marker property', () => {
    // Arrange
    const message = 'no test files found to delete';

    // Act
    const error = probeInapplicable(message);

    // Assert
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe(message);
    expect(isProbeInapplicable(error)).toBe(true);
    // Marker-based, not instanceof-based: a structurally equivalent object from a
    // bundled probe realm is recognized too.
    expect(isProbeInapplicable({ cyanprintProbeInapplicable: true })).toBe(true);
  });

  test('ordinary errors and non-errors are not inapplicable', () => {
    // Arrange
    const notInapplicable = [new Error('gate stayed green'), undefined, 'inapplicable'];

    // Act
    const results = notInapplicable.map(candidate => isProbeInapplicable(candidate));

    // Assert
    expect(results).toEqual([false, false, false]);
  });
});
