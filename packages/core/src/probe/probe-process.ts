import { fileURLToPath } from 'node:url';
import type { ProbeFeatureIdentity } from '@cyanprint/contracts';
import { OUTCOME_BY_EXIT, type ProbeOutcome } from './probe-runner-protocol';
import { collectPipe, killProcessTree } from './spawn';
import type { ProbeSource } from './matrix';

// The outcome vocabulary and exit-code mapping live in `probe-runner-protocol.ts`,
// the single source of truth shared with the child runner. Re-exported here so the
// executor keeps importing `ProbeOutcome` from its existing entry point.
export type { ProbeOutcome } from './probe-runner-protocol';

const RUNNER_PATH = fileURLToPath(new URL('./probe-runner.ts', import.meta.url));

/**
 * Run ONE probe in an isolated child process and return its raw outcome.
 *
 * The child is spawned as its OWN process-group leader (`detached: true`), so the
 * per-probe timeout is enforced entirely from OUTSIDE the probe's JS context: on
 * timeout the parent kills the whole group (SIGTERM→SIGKILL to the negative pgid),
 * which stops the probe unconditionally — whether it is blocked in a synchronous
 * loop, still doing async work past its deadline, or waiting on a spawned gate
 * command — and takes every in-group descendant with it. This is the guarantee an
 * in-thread `Promise.race` timeout cannot make (FR10, AC6).
 *
 * After the child exits (for any reason) the group is signalled once more, so a
 * probe that backgrounded an in-group process and returned normally still leaves
 * nothing from its group behind.
 *
 * Containment boundary (FR10/FR11 conflict resolution, 2026-07-04, option 2): the
 * kill guarantee covers the runner's process group ONLY. FR11 forbids injecting
 * any tracking variable into the environment probes (and their gate commands)
 * inherit, so a descendant that re-sessions out of the group (`setsid`,
 * daemonization) escapes the kill — a DOCUMENTED, out-of-scope limitation. The
 * runner payload rides argv, never the environment, for the same reason.
 */
export async function runProbeInSubprocess(args: {
  source: ProbeSource;
  feature: ProbeFeatureIdentity;
  probeName: string;
  sandboxPath: string;
  timeoutMs: number;
}): Promise<ProbeOutcome> {
  const payload = JSON.stringify({
    source: args.source,
    feature: args.feature,
    probeName: args.probeName,
    sandboxPath: args.sandboxPath,
    timeoutMs: args.timeoutMs,
  });
  const proc = Bun.spawn([process.execPath, RUNNER_PATH, payload], {
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'pipe',
    detached: true,
  });

  const stderrPipe = collectPipe(proc.stderr);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    // Group-kill: the runner leads its own group and its gate commands inherit it,
    // so the negative pgid takes the entire in-group tree down at once. A
    // descendant that escaped the group may still hold the runner's inherited
    // stderr pipe open — stop reading it once the kill settled, so the timeout
    // outcome lands at the deadline instead of whenever the escapee exits (FR10).
    void killProcessTree(proc.pid).then(() => stderrPipe.cancel());
  }, args.timeoutMs);

  let exitCode: number | null;
  let stderr = '';
  try {
    [exitCode, stderr] = await Promise.all([proc.exited, stderrPipe.text]);
  } finally {
    clearTimeout(timer);
    // Belt-and-suspenders: signal the group again in case the probe backgrounded
    // an in-group process that outlived the (already-exited) runner. Best-effort —
    // an empty or already-dead group is fine. What this cannot see — a descendant
    // that left the group via `setsid`/daemonization — is the documented
    // out-of-scope limitation above.
    try {
      process.kill(-proc.pid, 'SIGKILL');
    } catch {
      // group already gone
    }
  }

  if (timedOut) {
    return 'timeout';
  }
  const outcome = exitCode === null ? undefined : OUTCOME_BY_EXIT[exitCode];
  if (!outcome) {
    // An unexpected exit (crash, unmapped code) is engine infrastructure failing
    // around the experiment — surface the child's diagnostics and report `broken`.
    console.warn(
      `probe-runner for ${args.feature.template}#${args.feature.name}/${args.probeName} exited ${exitCode}: ` +
        stderr.trim(),
    );
    return 'engine-failed';
  }
  return outcome;
}
