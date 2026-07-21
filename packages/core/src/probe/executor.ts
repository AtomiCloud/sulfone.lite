import { availableParallelism } from 'node:os';
import type { ProbeEvidenceClass, ProbeVerdict } from '@cyanprint/contracts';
import { mapWithConcurrency } from '../util';
import { ProbeSetupError, prepareProbeSandboxSource } from './sandbox';
import { runProbeInSubprocess, type ProbeOutcome } from './probe-process';
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

/** Durable observation of one isolated probe child, including repeated controls. */
export type ProbeExecutionEvent = ProbeExecutionSpan & {
  /** Preserved from explicit feature-set inputs when supplied. */
  class?: ProbeEvidenceClass;
  outcome: ProbeOutcome;
  /** Verdict for this child only; it never replaces a sibling child's verdict. */
  verdict: ProbeVerdict;
  exitCode: number | null;
  stdoutTail: string;
  stderrTail: string;
  /** Why a non-passing control was expected or is an independently broken case. */
  attribution?: {
    kind: 'expected-impact' | 'unexpected-control';
    mutation: { feature: string; probe: string };
  };
};

export type ProbeMatrixExecution = {
  /** Verdict per probe, keyed by `probeKey(feature, probe.name)`. */
  verdicts: Map<string, ProbeVerdict>;
  runs: ProbeRunRecord[];
  spans: ProbeExecutionSpan[];
  events: ProbeExecutionEvent[];
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
      return { verdicts: allBrokenVerdicts(runs), runs: [], spans: [], events: [] };
    }
    throw error;
  }

  const verdicts = new Map<string, ProbeVerdict>();
  const spans: ProbeExecutionSpan[] = [];
  const events: ProbeExecutionEvent[] = [];
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
        const record = await executeRun({ source, run, runIndex, defaultTimeoutMs, verdicts, spans, events, options });
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
  events.sort((left, right) => left.runIndex - right.runIndex || left.startedAt - right.startedAt);
  return {
    verdicts,
    runs: runRecords,
    spans,
    events,
    snapshotPath: options.keepSandboxes ? source.snapshotPath : undefined,
  };
}

async function executeRun(args: {
  source: Awaited<ReturnType<typeof prepareProbeSandboxSource>>;
  run: ProbeRunPlan;
  runIndex: number;
  defaultTimeoutMs: number;
  verdicts: Map<string, ProbeVerdict>;
  spans: ProbeExecutionSpan[];
  events: ProbeExecutionEvent[];
  options: ProbeExecutionOptions;
}): Promise<{ mutation?: { feature: string; probe: string }; sandboxPath?: string }> {
  const { run, runIndex, defaultTimeoutMs, verdicts, spans, events } = args;
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
        verdicts.set(probeKey(planned.feature, planned.probe.name), 'broken');
      }
      return { mutation: mutationLabel };
    }
    throw error;
  }

  try {
    if (run.kind === 'baseline') {
      await executeBaselineRun(run, { runIndex, sandbox: sandbox.path, defaultTimeoutMs, verdicts, spans, events });
    } else {
      await executeMutationRun(run, { runIndex, sandbox: sandbox.path, defaultTimeoutMs, verdicts, spans, events });
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
  spans: ProbeExecutionSpan[];
  events: ProbeExecutionEvent[];
};

/**
 * The baseline run: every feature's baseline probes against the untouched
 * snapshot. Every child's verdict is independent: a failed baseline is `broken`
 * with its own event attribution while passing siblings remain `proven`.
 */
async function executeBaselineRun(run: Extract<ProbeRunPlan, { kind: 'baseline' }>, ctx: RunContext): Promise<void> {
  for (const planned of run.baselines) {
    const event = await executeProbe(planned, 'baseline', ctx);
    ctx.verdicts.set(probeKey(planned.feature, planned.probe.name), event.verdict);
  }
}

/**
 * One mutation run: the single fault, then every other feature's baseline probes
 * as in-run controls against the sabotaged tree. Attribution of a red control:
 * ONLY a legitimate author-level red (`author-failed` — the control's own gate
 * assertion fired) is an attributed overlap when its feature is listed in the
 * mutation's `expectedImpact`; its event is marked `expected-impact`. Every other non-pass
 * outcome — `timeout`, `op-failed`, `engine-failed`, `inapplicable` — is an
 * infrastructure/validity failure OUTSIDE the experiment and can never be
 * attributed away. A non-passing control is retained as its OWN broken child
 * event, with its feature/probe and whether it matched `expectedImpact`; it never
 * rewrites the mutation child's `caught`/`missed` verdict. Controls are skipped
 * when the mutation was `invalid` (the experiment never ran) or already `broken`.
 *
 * Feature identity is (source template, name): a mutation's bare `expectedImpact`
 * names are its OWN source template's feature names, so the match is scoped to
 * controls from that same template. A same-named feature from a DIFFERENT template
 * is a different feature and is never attributed away — its event remains an
 * `unexpected-control` broken case (same-named features must never collapse across templates).
 */
async function executeMutationRun(run: Extract<ProbeRunPlan, { kind: 'mutation' }>, ctx: RunContext): Promise<void> {
  const key = probeKey(run.mutation.feature, run.mutation.probe.name);
  const mutationEvent = await executeProbe(run.mutation, 'mutation', ctx);
  const verdict = mutationEvent.verdict;

  if (verdict === 'caught' || verdict === 'missed') {
    const mutationTemplate = run.mutation.feature.template;
    const expectedImpact = new Set(run.mutation.probe.expectedImpact ?? []);
    for (const control of run.controls) {
      const controlEvent = await executeProbe(control, 'control', ctx);
      if (controlEvent.outcome === 'passed') {
        continue;
      }
      // Only an author-level red gate is legitimate expected overlap. `timeout`,
      // `op-failed`, `engine-failed`, and `inapplicable` remain independently
      // broken controls even when their feature appears in expectedImpact.
      const attributed =
        controlEvent.outcome === 'author-failed' &&
        control.feature.template === mutationTemplate &&
        expectedImpact.has(control.feature.name);
      controlEvent.attribution = {
        kind: attributed ? 'expected-impact' : 'unexpected-control',
        mutation: {
          feature: `${run.mutation.feature.template}#${run.mutation.feature.name}`,
          probe: run.mutation.probe.name,
        },
      };
    }
  }
  ctx.verdicts.set(key, verdict);
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
): Promise<ProbeExecutionEvent> {
  const timeoutMs = planned.probe.timeoutMs ?? ctx.defaultTimeoutMs;
  const startedAt = Date.now();
  const result = planned.source
    ? await runProbeInSubprocess({
        source: planned.source,
        feature: planned.feature,
        probeName: planned.probe.name,
        sandboxPath: ctx.sandbox,
        timeoutMs,
      })
    : {
        outcome: 'engine-failed' as const,
        exitCode: null,
        stdoutTail: '',
        stderrTail: 'resolved probe source is missing',
      };
  const span: ProbeExecutionSpan = {
    runIndex: ctx.runIndex,
    role,
    feature: `${planned.feature.template}#${planned.feature.name}`,
    probe: planned.probe.name,
    startedAt,
    endedAt: Date.now(),
  };
  ctx.spans.push(span);
  const event: ProbeExecutionEvent = {
    ...span,
    ...(planned.feature.class === undefined ? {} : { class: planned.feature.class }),
    outcome: result.outcome,
    verdict:
      role === 'mutation'
        ? mutationVerdict(result.outcome)
        : role === 'baseline'
          ? baselineVerdict(result.outcome)
          : controlVerdict(result.outcome),
    exitCode: result.exitCode,
    stdoutTail: result.stdoutTail,
    stderrTail: result.stderrTail,
  };
  ctx.events.push(event);
  return event;
}

function controlVerdict(outcome: ProbeOutcome): ProbeVerdict {
  return outcome === 'passed' ? 'proven' : 'broken';
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

function plannedProbesOf(run: ProbeRunPlan): PlannedProbe[] {
  return run.kind === 'baseline' ? run.baselines : [run.mutation];
}
