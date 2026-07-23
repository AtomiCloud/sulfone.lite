import type { ProbeFeatureIdentity, ProbeRunReport } from '@cyanprint/contracts';
import { CyanError, problem } from '@cyanprint/contracts';
import { executeProbeMatrix, type ProbeExecutionOptions, type ProbeRunRecord } from './executor';
import { buildProbeRunReport } from './manifest';
import type { ResolvedFeatureProbes } from './matrix';
import { resolveProbesForTemplate, resolveProbesFromSource, type ProbeOverrideInput } from './resolve';

/**
 * Where probe definitions come from — the two pinned resolution modes:
 *
 * - `declaration` — features come from a template's declarations; the three-tier
 *   order, override, and diamond rules apply (FR2/FR4).
 * - `explicit-source` — the caller supplies BOTH the feature set and the probe
 *   source directory (FR12/G3's probe-author debug path): features match the
 *   supplied source's `probes/<name>.ts` directly, bypassing three-tier
 *   resolution — testing your probes against an arbitrary fixture repo is
 *   exactly what this mode is for. Resolve-or-fail applies in both modes.
 */
export type ProbeSourcesInput =
  | { mode: 'declaration'; templateDir: string; workspaceRoot?: string; localFallback?: boolean }
  | { mode: 'explicit-source'; dir: string };

/**
 * Selection (FR13's debug mode): named features run ALL their probes; a named
 * mutation probe implicitly pulls in its feature's baselines so the verdict
 * stays readable. Everything else is dropped from the run — selection is a
 * debug tool WITHOUT full in-run controls, so verdict parity with the test
 * flow is defined over full-matrix runs only.
 */
export type ProbeSelectionInput = {
  /** Feature selectors: a bare feature name or `template#name`. */
  features?: string[];
  /** Probe selectors: a probe name or `feature/probe`. */
  probes?: string[];
};

/** The run report plus the execution facts the report itself cannot carry. */
export type ProbeMatrixRunResult = {
  report: ProbeRunReport;
  runs: ProbeRunRecord[];
  /** Retained snapshot path (only when `options.keepSandboxes`). */
  snapshotPath?: string;
};

/**
 * The single engine API for probing a materialized repo (shared by plan-3's
 * standalone command and test-flow tier): resolve probes for the feature set,
 * execute the full run matrix, and report the manifest shape with exactly one
 * verdict per probe (FR7).
 *
 * Cost envelope: runs execute in parallel (default = machine maximum, i.e.
 * min(number of runs, os.availableParallelism()); `options.parallelism`
 * overrides in either direction) and sandboxes are created lazily per executing
 * run and removed as each run finishes unless `keepSandboxes` — so peak disk is
 * ≈ effective parallelism × post-setup repo size.
 */
export async function runProbeMatrix(args: {
  repoPath: string;
  probeSources: ProbeSourcesInput;
  features: ProbeFeatureIdentity[];
  /** Final-consumer override declarations (declaration mode only). */
  overrides?: ProbeOverrideInput[];
  /** Debug-mode selection; omitted = the full matrix. */
  selection?: ProbeSelectionInput;
  options?: ProbeExecutionOptions;
}): Promise<ProbeMatrixRunResult> {
  if (args.probeSources.mode === 'explicit-source' && args.overrides && args.overrides.length > 0) {
    throw new CyanError(
      problem(
        'validation',
        'probe_overrides_not_applicable',
        'Probe overrides only apply in declaration mode — explicit-source mode already names the exact probe ' +
          'source, so an override would be silently meaningless.',
      ),
    );
  }
  const resolved =
    args.probeSources.mode === 'declaration'
      ? await resolveProbesForTemplate({
          templateDir: args.probeSources.templateDir,
          features: args.features,
          overrides: args.overrides,
          workspaceRoot: args.probeSources.workspaceRoot,
          localFallback: args.probeSources.localFallback,
        })
      : await resolveProbesFromSource({ sourceDir: args.probeSources.dir, features: args.features });
  const selected = args.selection ? applyProbeSelection(resolved, args.selection) : resolved;
  const execution = await executeProbeMatrix({ repoPath: args.repoPath, features: selected, options: args.options });
  return {
    report: buildProbeRunReport(selected, execution.verdicts, execution.reasons),
    runs: execution.runs,
    snapshotPath: execution.snapshotPath,
  };
}

/**
 * Filter a resolved feature set down to a selection. Every selector must match
 * something — a selector that names nothing is a hard error, never a silent
 * no-op run (the debug mode must not fake a green).
 */
export function applyProbeSelection(
  resolved: ResolvedFeatureProbes[],
  selection: ProbeSelectionInput,
): ResolvedFeatureProbes[] {
  const featureSelectors = selection.features ?? [];
  const probeSelectors = selection.probes ?? [];
  if (featureSelectors.length === 0 && probeSelectors.length === 0) {
    return resolved;
  }
  const matched = new Set<string>();
  const featureMatches = (feature: ProbeFeatureIdentity): boolean =>
    featureSelectors.some(selector => {
      if (selector === feature.name || selector === `${feature.template}#${feature.name}`) {
        matched.add(`feature:${selector}`);
        return true;
      }
      return false;
    });
  const probeMatches = (feature: ProbeFeatureIdentity, probeName: string): boolean =>
    probeSelectors.some(selector => {
      if (selector === probeName || selector === `${feature.name}/${probeName}`) {
        matched.add(`probe:${selector}`);
        return true;
      }
      return false;
    });

  const filtered: ResolvedFeatureProbes[] = [];
  for (const feature of resolved) {
    const wholeFeature = featureMatches(feature.feature);
    const kept = feature.probes.filter(entry => {
      // Always call probeMatches for its matched-tracking side effect: a probe selector
      // for a probe inside an already-fully-selected feature must still be marked matched,
      // or the unmatched-selector check below would wrongly report it as unmatched.
      const matchesProbe = probeMatches(feature.feature, entry.probe.name);
      return wholeFeature || matchesProbe;
    });
    if (kept.length === 0) {
      continue;
    }
    // A selected mutation implicitly includes its feature's baselines (FR13):
    // without the baseline the mutation's verdict is unreadable.
    const probes = kept.some(entry => entry.probe.kind === 'mutation')
      ? feature.probes.filter(entry => entry.probe.kind === 'baseline' || kept.includes(entry))
      : kept;
    filtered.push({ ...feature, probes });
  }

  const unmatched = [
    ...featureSelectors
      .filter(selector => !matched.has(`feature:${selector}`))
      .map(selector => `--feature ${selector}`),
    ...probeSelectors.filter(selector => !matched.has(`probe:${selector}`)).map(selector => `--probe ${selector}`),
  ];
  if (unmatched.length > 0) {
    throw new CyanError(
      problem(
        'validation',
        'probe_selection_unmatched',
        `Probe selection matched nothing for: ${unmatched.join(', ')}. ` +
          'Selectors must name a resolved feature (name or template#name) or probe (name or feature/probe).',
      ),
    );
  }
  return filtered;
}
