import { availableParallelism } from 'node:os';
import type { ProbeVerdict, ProbeVerdictReason } from '@cyanprint/contracts';
import { mapWithConcurrency } from '../util';
import { ProbeSetupError, prepareProbeSandboxSource } from './sandbox';
import { runProbeInSubprocess, type ProbeOutcome, type ProbeProcessResult } from './probe-process';
import {
  buildProbeMatrix,
  mergeProbeRunConfig,
  probeKey,
  type PlannedProbe,
  type ProbeRunPlan,
  type ResolvedFeatureProbes,
} from './matrix';

/** Engine default per-probe timeout (FR10); per-probe `timeoutMs` overrides it. */
export const DEFAULT_PROBE_TIMEOUT_MS = 120_000;

export type ProbeExecutionOptions = {
  /**
   * Concurrent runs. Default = min(number of runs, os.availableParallelism()) —
   * the machine maximum, never all-runs-at-once on matrices larger than the core
   * count, which also bounds peak sandbox disk to ≈ parallelism × repo size.
   * An explicit value overrides in either direction.
   */
  parallelism?: number;
  /** Engine-level default per-probe timeout override (per-probe values still win). */
  timeoutMs?: number;
  /** Retain run sandboxes and the snapshot instead of removing them (NFC3). */
  keepSandboxes?: boolean;
  /** Parent directory for the engine-managed sandbox tree. */
  sandboxRoot?: string;
};

/** A probe execution interval, for overlap/serialization assertions (AC11). */
export type ProbeExecutionSpan = {
  runIndex: number;
  role: 'baseline' | 'mutation' | 'control';
  feature: string;
  probe: string;
  startedAt: number;
  endedAt: number;
};

export type ProbeRunRecord = {
  runIndex: number;
  kind: 'baseline' | 'mutation';
  mutation?: { feature: string; probe: string };
  /** Present only when `keepSandboxes` retained the run's sandbox. */
  sandboxPath?: string;
  startedAt: number;
  endedAt: number;
};

export type ProbeMatrixExecution = {
  /** Verdict per probe, keyed by `probeKey(feature, probe.name)`. */
  verdicts: Map<string, ProbeVerdict>;
  /** Required provenance for every `broken`/`invalid` verdict. */
  reasons: Map<string, ProbeVerdictReason>;
  runs: ProbeRunRecord[];
  spans: ProbeExecutionSpan[];
  /** The retained snapshot path (only when `keepSandboxes`). */
  snapshotPath?: string;
};

/**
 * Execute the full run matrix for a resolved feature set: runs in parallel,
 * probes within a run sequential, one fresh snapshot-forked sandbox per run,
 * per-probe timeouts enforced by isolated-subprocess process-tree kill, and
 * conservative attribution of red in-run controls (FR7/FR9/FR10). Every probe
 * runs in its own child process (see `probe-process.ts`) — there is no in-process
 * execution path, so the timeout is an absolute external boundary.
 */
export async function executeProbeMatrix(args: {
  repoPath: string;
  features: ResolvedFeatureProbes[];
  options?: ProbeExecutionOptions;
}): Promise<ProbeMatrixExecution> {
  const options = args.options ?? {};
  const runs = buildProbeMatrix(args.features);
  const config = mergeProbeRunConfig(args.features);
  const defaultTimeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;

  let source;
  try {
    source = await prepareProbeSandboxSource({
      repoPath: args.repoPath,
      sandbox: config.sandbox,
      setup: config.setup,
      sandboxRoot: options.sandboxRoot,
      commandTimeoutMs: defaultTimeoutMs,
    });
  } catch (error) {
    if (error instanceof ProbeSetupError) {
      // setup.pre failed: every run is affected, so every probe is `broken`.
      const verdicts = allBrokenVerdicts(runs);
      const reason = setupReason(error);
      return {
        verdicts,
        reasons: new Map([...verdicts.keys()].map(key => [key, reason])),
        runs: [],
        spans: [],
      };
    }
    throw error;
  }

  const verdicts = new Map<string, ProbeVerdict>();
  const reasons = new Map<string, ProbeVerdictReason>();
  const spans: ProbeExecutionSpan[] = [];
  const runRecords: ProbeRunRecord[] = [];
  // `mapWithConcurrency` is `Promise.all`-backed: a rejecting worker settles the whole
  // call immediately while sibling workers keep running in the background. Rethrowing
  // straight out of the mapped callback would race the `finally` below — `source.dispose()`
  // (which deletes the sandbox root) could run while other `executeRun`s are still using
  // sandboxes under it. Instead, swallow per-run errors into `firstError` so every worker
  // runs to completion (every run settles) before dispose, then surface the first error.
  let firstError: unknown;
  try {
    const parallelism = options.parallelism ?? Math.min(runs.length, availableParallelism());
    await mapWithConcurrency(runs, parallelism, async (run, runIndex) => {
      const startedAt = Date.now();
      try {
        const record = await executeRun({ source, run, runIndex, defaultTimeoutMs, verdicts, reasons, spans, options });
        runRecords.push({ ...record, runIndex, kind: run.kind, startedAt, endedAt: Date.now() });
      } catch (error) {
        firstError ??= error;
      }
    });
  } finally {
    if (!options.keepSandboxes) {
      await source.dispose();
    }
  }
  if (firstError) {
    throw firstError;
  }
  runRecords.sort((left, right) => left.runIndex - right.runIndex);
  return {
    verdicts,
    reasons,
    runs: runRecords,
    spans,
    snapshotPath: options.keepSandboxes ? source.snapshotPath : undefined,
  };
}

async function executeRun(args: {
  source: Awaited<ReturnType<typeof prepareProbeSandboxSource>>;
  run: ProbeRunPlan;
  runIndex: number;
  defaultTimeoutMs: number;
  verdicts: Map<string, ProbeVerdict>;
  reasons: Map<string, ProbeVerdictReason>;
  spans: ProbeExecutionSpan[];
  options: ProbeExecutionOptions;
}): Promise<{ mutation?: { feature: string; probe: string }; sandboxPath?: string }> {
  const { run, runIndex, defaultTimeoutMs, verdicts, spans } = args;
  const mutationLabel =
    run.kind === 'mutation'
      ? { feature: `${run.mutation.feature.template}#${run.mutation.feature.name}`, probe: run.mutation.probe.name }
      : undefined;

  let sandbox;
  try {
    sandbox = await args.source.createRun();
  } catch (error) {
    if (error instanceof ProbeSetupError) {
      // setup.post failed: this run is affected — every probe it carries is `broken`.
      for (const planned of plannedProbesOf(run)) {
        const key = probeKey(planned.feature, planned.probe.name);
        verdicts.set(key, 'broken');
        args.reasons.set(key, setupReason(error));
      }
      return { mutation: mutationLabel };
    }
    throw error;
  }

  try {
    if (run.kind === 'baseline') {
      await executeBaselineRun(run, {
        runIndex,
        sandbox: sandbox.path,
        defaultTimeoutMs,
        verdicts,
        reasons: args.reasons,
        spans,
      });
    } else {
      await executeMutationRun(run, {
        runIndex,
        sandbox: sandbox.path,
        defaultTimeoutMs,
        verdicts,
        reasons: args.reasons,
        spans,
      });
    }
  } finally {
    if (!args.options.keepSandboxes) {
      await sandbox.dispose();
    }
  }
  return { mutation: mutationLabel, sandboxPath: args.options.keepSandboxes ? sandbox.path : undefined };
}

type RunContext = {
  runIndex: number;
  sandbox: string;
  defaultTimeoutMs: number;
  verdicts: Map<string, ProbeVerdict>;
  reasons: Map<string, ProbeVerdictReason>;
  spans: ProbeExecutionSpan[];
};

/**
 * The baseline run: every feature's baseline probes against the untouched
 * snapshot. A broken baseline (author failure, sandbox-op failure, or timeout)
 * marks the WHOLE run untrusted: every probe in it is reported `broken` (FR7 —
 * ambiguity always lands on `broken`). `invalid` baselines assert nothing but do
 * not untrust the run.
 */
async function executeBaselineRun(run: Extract<ProbeRunPlan, { kind: 'baseline' }>, ctx: RunContext): Promise<void> {
  const outcomes = new Map<string, { planned: PlannedProbe; result: ProbeProcessResult }>();
  const failures: Array<{ planned: PlannedProbe; result: ProbeProcessResult }> = [];
  for (const planned of run.baselines) {
    const result = await executeProbe(planned, 'baseline', ctx);
    outcomes.set(probeKey(planned.feature, planned.probe.name), { planned, result });
    if (
      result.outcome === 'author-failed' ||
      result.outcome === 'op-failed' ||
      result.outcome === 'timeout' ||
      result.outcome === 'engine-failed'
    ) {
      failures.push({ planned, result });
    }
  }
  for (const [key, { result }] of outcomes) {
    const verdict = baselineVerdict(result.outcome);
    const finalVerdict = failures.length > 0 && verdict === 'proven' ? 'broken' : verdict;
    ctx.verdicts.set(key, finalVerdict);
    if (finalVerdict === 'invalid') {
      ctx.reasons.set(key, outcomeReason(result));
    } else if (verdict === 'broken') {
      ctx.reasons.set(key, outcomeReason(result, 'baseline_failed'));
    } else if (finalVerdict === 'broken') {
      ctx.reasons.set(key, {
        category: 'baseline_run_untrusted',
        message: `baseline run was untrusted because ${failures.map(formatFailure).join('; ')}`,
      });
    }
  }
}

/**
 * One mutation run: the single fault, then every other feature's baseline probes
 * as in-run controls against the sabotaged tree. Attribution of a red control:
 * ONLY a legitimate author-level red (`author-failed` — the control's own gate
 * assertion fired) is an attributed overlap when its feature is listed in the
 * mutation's `expectedImpact`; the run then stays trusted. Every other non-pass
 * outcome — `timeout`, `op-failed`, `engine-failed`, `inapplicable` — is an
 * infrastructure/validity failure OUTSIDE the experiment and can never be
 * attributed away: it marks the run untrusted and the mutation's verdict `broken`,
 * never counted as `caught`, even when the control's feature is in `expectedImpact`
 * (a control that failed to load, hit an unsafe sandbox op, or was inapplicable
 * proves nothing about legitimate overlap — the conservative trust model lands it
 * on `broken`). Controls are skipped when the mutation was `invalid` (the
 * experiment never ran) or already `broken`.
 *
 * Feature identity is (source template, name): a mutation's bare `expectedImpact`
 * names are its OWN source template's feature names, so the match is scoped to
 * controls from that same template. A same-named feature from a DIFFERENT template
 * is a different feature and is never attributed away — its redness conservatively
 * marks the run `broken` (same-named features must never collapse across templates).
 */
async function executeMutationRun(run: Extract<ProbeRunPlan, { kind: 'mutation' }>, ctx: RunContext): Promise<void> {
  const key = probeKey(run.mutation.feature, run.mutation.probe.name);
  const result = await executeProbe(run.mutation, 'mutation', ctx);
  let verdict = mutationVerdict(result.outcome);
  let reason: ProbeVerdictReason | undefined =
    verdict === 'invalid' || verdict === 'broken' ? outcomeReason(result) : undefined;

  if (verdict === 'caught' || verdict === 'missed') {
    const mutationTemplate = run.mutation.feature.template;
    const expectedImpact = new Set(run.mutation.probe.expectedImpact ?? []);
    for (const control of run.controls) {
      const controlResult = await executeProbe(control, 'control', ctx);
      if (controlResult.outcome === 'passed') {
        continue;
      }
      // Only an author-level red gate is legitimate expected overlap. `timeout`,
      // `op-failed`, `engine-failed`, and `inapplicable` are outside-the-experiment
      // failures that must still untrust the run — they are never attributed away.
      const attributed =
        controlResult.outcome === 'author-failed' &&
        control.feature.template === mutationTemplate &&
        expectedImpact.has(control.feature.name);
      if (attributed) {
        continue; // attributed overlap: this control's own gate legitimately reddened.
      }
      verdict = 'broken';
      reason = {
        category: 'control_failed',
        message: `control ${control.feature.template}#${control.feature.name}/${control.probe.name} failed: ${
          controlResult.reason ?? controlResult.outcome
        }`,
      };
      break;
    }
  }
  ctx.verdicts.set(key, verdict);
  if (reason) {
    ctx.reasons.set(key, reason);
  }
}

/**
 * Execute one probe in an ISOLATED child process (see `probe-process.ts`). The
 * per-probe timeout is enforced from outside that process, so it is an absolute
 * boundary: a probe that blocks synchronously or keeps working after its deadline
 * is killed with its whole process tree and reported `timeout` — it can neither
 * hang the matrix nor mutate the sandbox after the deadline (FR10, AC6). A probe
 * with no resolved `source` cannot be isolated, so it is treated as an engine
 * failure (`broken`) rather than silently run in-process — production always
 * attaches a source (see `resolve.ts`); a missing one is a bug, never a verdict.
 */
async function executeProbe(
  planned: PlannedProbe,
  role: 'baseline' | 'mutation' | 'control',
  ctx: RunContext,
): Promise<ProbeProcessResult> {
  const timeoutMs = planned.probe.timeoutMs ?? ctx.defaultTimeoutMs;
  const startedAt = Date.now();
  const result: ProbeProcessResult = planned.source
    ? await runProbeInSubprocess({
        source: planned.source,
        feature: planned.feature,
        probeName: planned.probe.name,
        sandboxPath: ctx.sandbox,
        timeoutMs,
      })
    : { outcome: 'engine-failed', reason: 'resolved probe has no isolated runner source' };
  ctx.spans.push({
    runIndex: ctx.runIndex,
    role,
    feature: `${planned.feature.template}#${planned.feature.name}`,
    probe: planned.probe.name,
    startedAt,
    endedAt: Date.now(),
  });
  return result;
}

function baselineVerdict(outcome: ProbeOutcome): ProbeVerdict {
  switch (outcome) {
    case 'passed':
      return 'proven';
    case 'inapplicable':
      return 'invalid';
    default:
      // author-failed / op-failed / timeout / engine-failed: a failing baseline is `broken`.
      return 'broken';
  }
}

function mutationVerdict(outcome: ProbeOutcome): ProbeVerdict {
  switch (outcome) {
    case 'passed':
      return 'caught';
    case 'author-failed':
      // The author's own assertion fired: the gate stayed green — the false green.
      return 'missed';
    case 'op-failed':
    case 'inapplicable':
      // The sabotage could not be applied / preconditions absent: asserts nothing.
      return 'invalid';
    case 'timeout':
    case 'engine-failed':
      // Timed out, or the engine failed to run the probe: outside the experiment.
      return 'broken';
  }
}

function allBrokenVerdicts(runs: ProbeRunPlan[]): Map<string, ProbeVerdict> {
  const verdicts = new Map<string, ProbeVerdict>();
  for (const run of runs) {
    for (const planned of plannedProbesOf(run)) {
      verdicts.set(probeKey(planned.feature, planned.probe.name), 'broken');
    }
  }
  return verdicts;
}

function setupReason(error: ProbeSetupError): ProbeVerdictReason {
  return { category: `setup_${error.phase}_failed`, message: error.message };
}

function outcomeReason(result: ProbeProcessResult, category?: string): ProbeVerdictReason {
  return {
    category: category ?? outcomeCategory(result.outcome),
    message: result.reason ?? `probe ended with ${result.outcome} without diagnostic output`,
  };
}

function outcomeCategory(outcome: ProbeOutcome): string {
  switch (outcome) {
    case 'inapplicable':
      return 'probe_inapplicable';
    case 'op-failed':
      return 'sandbox_operation_failed';
    case 'timeout':
      return 'probe_timeout';
    case 'engine-failed':
      return 'engine_failed';
    case 'author-failed':
      return 'probe_assertion_failed';
    case 'passed':
      return 'probe_passed';
  }
}

function formatFailure(failure: { planned: PlannedProbe; result: ProbeProcessResult }): string {
  return `${failure.planned.feature.template}#${failure.planned.feature.name}/${failure.planned.probe.name}: ${
    failure.result.reason ?? failure.result.outcome
  }`;
}

function plannedProbesOf(run: ProbeRunPlan): PlannedProbe[] {
  return run.kind === 'baseline' ? run.baselines : [run.mutation];
}
