import type { ProbeFeatureIdentity, ProbeRunReport } from '@cyanprint/contracts';
import { CyanError, problem } from '@cyanprint/contracts';
import { executeProbeMatrix, type ProbeExecutionOptions } from './executor';
import { buildProbeRunReport } from './manifest';
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
  options?: ProbeExecutionOptions;
}): Promise<ProbeRunReport> {
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
  const execution = await executeProbeMatrix({ repoPath: args.repoPath, features: resolved, options: args.options });
  return buildProbeRunReport(resolved, execution.verdicts);
}
