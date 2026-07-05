/**
 * The cross-process runner protocol, shared by the parent driver
 * (`probe-process.ts`) and the isolated child (`probe-runner.ts`). Keeping the
 * exit codes, the outcome vocabulary, and the exit-code→outcome mapping in ONE
 * module means the two sides of the process boundary cannot silently drift as the
 * outcome set changes — an edit lands in a single place rather than two mirrored
 * literals that must be hand-synchronised.
 */

/**
 * The raw outcomes an isolated probe run can produce. The executor maps these to
 * the five verdicts by probe kind (baseline vs mutation).
 *
 * `engine-failed` covers the isolated model's infrastructure faults: a runner that
 * cannot load/locate the probe, or exits unexpectedly, is the engine breaking
 * AROUND the experiment — always `broken`, never a false `caught`/`missed`.
 * `timeout` is never carried by an exit code: the parent detects it when it kills a
 * probe that overran its deadline.
 */
export type ProbeOutcome = 'passed' | 'author-failed' | 'op-failed' | 'inapplicable' | 'timeout' | 'engine-failed';

/**
 * The child reports its outcome through its process EXIT CODE (stdout/stderr stay
 * free for the probe's own gate output and diagnostics):
 *
 * - `0`  passed        — the probe ran to completion without throwing.
 * - `10` inapplicable  — the probe threw `probeInapplicable(...)`.
 * - `11` op-failed     — a `ProbeRepo` sandbox operation failed (`ProbeRepoOpError`).
 * - `12` author-failed — the probe threw anything else (its own assertion fired).
 * - `13` engine-failed — the runner could not load/locate the probe (infra fault).
 */
export const RUNNER_EXIT = {
  passed: 0,
  inapplicable: 10,
  opFailed: 11,
  authorFailed: 12,
  engineFailed: 13,
} as const;

/** Runner exit code → outcome. `timeout` is added by the parent, never the child. */
export const OUTCOME_BY_EXIT: Record<number, ProbeOutcome> = {
  [RUNNER_EXIT.passed]: 'passed',
  [RUNNER_EXIT.inapplicable]: 'inapplicable',
  [RUNNER_EXIT.opFailed]: 'op-failed',
  [RUNNER_EXIT.authorFailed]: 'author-failed',
  [RUNNER_EXIT.engineFailed]: 'engine-failed',
};
