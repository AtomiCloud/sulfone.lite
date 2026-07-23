import type {
  Probe,
  ProbeDefinition,
  ProbeFeatureIdentity,
  ProbeResolutionOrigin,
  ProbeSandboxConfig,
  ProbeSetupConfig,
} from '@cyanprint/contracts';
import { CyanError, problem } from '@cyanprint/contracts';

/**
 * Where the engine re-obtains a probe's `run` code so it can execute it in an
 * ISOLATED subprocess (see `probe-process.ts` / `probe-runner.ts`). A probe's
 * closure cannot cross a process boundary, so the runner re-loads it:
 *
 * - `file`    — from its `probes/<feature>.ts` definition file (local, dependency,
 *   override, or explicit-source), by module path. `bundled` selects the
 *   artifact-bundle import path for hydrated dependency probes.
 * - `builtin` — from the engine's built-in library, keyed by the feature name on
 *   the owning {@link PlannedProbe}.
 *
 * Optional on the resolved shape so purely declarative consumers (the matrix
 * builder, the manifest, resolution tests that never execute) need not supply it;
 * the executor requires it before it will run a probe (execution is always
 * isolated — there is no in-process fallback).
 */
export type ProbeSource = { kind: 'file'; modulePath: string; bundled: boolean } | { kind: 'builtin' };

/** One probe with the resolution origin the audit trail records for it. */
export type ResolvedProbe = {
  probe: Probe;
  origin: ProbeResolutionOrigin;
  /** How the runner re-loads this probe for isolated execution (see {@link ProbeSource}). */
  source?: ProbeSource;
};

/** A feature's fully resolved probe set: the definition plus per-probe origins. */
export type ResolvedFeatureProbes = {
  feature: ProbeFeatureIdentity;
  definition: ProbeDefinition;
  probes: ResolvedProbe[];
};

export type PlannedProbe = {
  feature: ProbeFeatureIdentity;
  probe: Probe;
  /** How the runner re-loads this probe for isolated execution (see {@link ProbeSource}). */
  source?: ProbeSource;
};

/**
 * One matrix run. The baseline run executes every feature's baseline probes
 * against the untouched snapshot; each mutation run carries exactly ONE fault
 * plus every OTHER feature's baseline probes as in-run controls (FR9: faults
 * never stack, nothing leaks between runs — each run gets a fresh sandbox).
 */
export type ProbeRunPlan =
  | { kind: 'baseline'; baselines: PlannedProbe[] }
  | { kind: 'mutation'; mutation: PlannedProbe; controls: PlannedProbe[] };

/**
 * Build the run matrix for a resolved feature set: 1 baseline run + one run per
 * mutation probe (F features with M total mutations → exactly 1 + M runs, AC4).
 */
export function buildProbeMatrix(features: ResolvedFeatureProbes[]): ProbeRunPlan[] {
  const baselinesOf = (feature: ResolvedFeatureProbes): PlannedProbe[] =>
    feature.probes
      .filter(resolved => resolved.probe.kind === 'baseline')
      .map(resolved => ({ feature: feature.feature, probe: resolved.probe, source: resolved.source }));

  const runs: ProbeRunPlan[] = [{ kind: 'baseline', baselines: features.flatMap(feature => baselinesOf(feature)) }];
  for (const feature of features) {
    for (const resolved of feature.probes) {
      if (resolved.probe.kind !== 'mutation') {
        continue;
      }
      const controls = features
        .filter(other => !sameFeature(other.feature, feature.feature))
        .flatMap(other => baselinesOf(other));
      runs.push({
        kind: 'mutation',
        mutation: { feature: feature.feature, probe: resolved.probe, source: resolved.source },
        controls,
      });
    }
  }
  return runs;
}

function sameFeature(left: ProbeFeatureIdentity, right: ProbeFeatureIdentity): boolean {
  return left.template === right.template && left.name === right.name;
}

/** Stable identity key for one probe's verdict: (source template, feature, probe). */
export function probeKey(feature: ProbeFeatureIdentity, probeName: string): string {
  return `${feature.template}\u0000${feature.name}\u0000${probeName}`;
}

/**
 * The matrix shares one sandbox lifecycle across every feature's probes, so the
 * per-definition sandbox/setup configs must be merged: explicit snapshot
 * strategies must agree (a git-vs-fs conflict is a hard error, not a silent
 * pick), `preserve` and `exclude` are unioned, and setup phases concatenate in
 * feature order with exact-duplicate commands run once.
 */
export function mergeProbeRunConfig(features: ResolvedFeatureProbes[]): {
  sandbox: ProbeSandboxConfig;
  setup: ProbeSetupConfig;
} {
  let snapshot: ProbeSandboxConfig['snapshot'] = 'auto';
  let snapshotOwner: ProbeFeatureIdentity | undefined;
  const preserve: string[] = [];
  const exclude: string[] = [];
  const pre: string[] = [];
  const post: string[] = [];
  for (const feature of features) {
    const declared = feature.definition.sandbox?.snapshot;
    if (declared && declared !== 'auto') {
      if (snapshot !== 'auto' && snapshot !== declared && snapshotOwner) {
        throw new CyanError(
          problem(
            'validation',
            'probe_sandbox_strategy_conflict',
            `Probe sandbox strategies conflict: ${snapshotOwner.template}#${snapshotOwner.name} requires "${snapshot}" ` +
              `but ${feature.feature.template}#${feature.feature.name} requires "${declared}".`,
          ),
        );
      }
      snapshot = declared;
      snapshotOwner = feature.feature;
    }
    for (const path of feature.definition.sandbox?.preserve ?? []) {
      if (!preserve.includes(path)) {
        preserve.push(path);
      }
    }
    for (const pattern of feature.definition.sandbox?.exclude ?? []) {
      if (!exclude.includes(pattern)) {
        exclude.push(pattern);
      }
    }
    for (const command of feature.definition.setup?.pre ?? []) {
      if (!pre.includes(command)) {
        pre.push(command);
      }
    }
    for (const command of feature.definition.setup?.post ?? []) {
      if (!post.includes(command)) {
        post.push(command);
      }
    }
  }
  return { sandbox: { snapshot, preserve, exclude }, setup: { pre, post } };
}
