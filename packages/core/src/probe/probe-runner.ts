import type { Probe, ProbeDefinition, ProbeFeatureIdentity } from '@cyanprint/contracts';
import { isProbeInapplicable } from '@cyanprint/contracts';
import { builtInProbeDefinition } from './builtins';
import { loadProbeDefinitionFile } from './load-probe';
import { RUNNER_EXIT } from './probe-runner-protocol';
import { createProbeRepo, ProbeRepoOpError } from './repo-helper';
import type { ProbeSource } from './matrix';

/**
 * The isolated probe runner (child process). One probe runs per subprocess:
 * `probe-process.ts` spawns this script as its own process-group leader, hands it
 * a JSON payload, and enforces the per-probe timeout by killing the whole group
 * from OUTSIDE. That external boundary is the entire point of process isolation —
 * a probe that blocks the event loop synchronously (`while (true) {}`) or keeps
 * doing async work after its deadline cannot be stopped from within its own JS
 * context, but the parent's group-kill stops it unconditionally (FR10, AC6) — a
 * guarantee no in-process timeout mechanism can make.
 *
 * The probe's OUTCOME is reported via the process EXIT CODE (see `RUNNER_EXIT` in
 * `probe-runner-protocol.ts`, the single source of truth shared with the parent);
 * stdout/stderr stay free for the probe's own gate output and diagnostics. The
 * parent maps these to the five verdicts by probe kind; a group-kill (timeout) is
 * detected by the parent, not signalled here.
 */

type ProbeRunnerPayload = {
  source: ProbeSource;
  feature: ProbeFeatureIdentity;
  probeName: string;
  sandboxPath: string;
  timeoutMs: number;
};

async function loadProbe(payload: ProbeRunnerPayload): Promise<Probe> {
  const definition: ProbeDefinition | undefined =
    payload.source.kind === 'file'
      ? await loadProbeDefinitionFile(payload.source.modulePath, payload.feature.template, {
          bundled: payload.source.bundled,
        })
      : builtInProbeDefinition(payload.feature.name);
  const probe = definition?.probes.find(candidate => candidate.name === payload.probeName);
  if (!probe) {
    throw new Error(
      `probe "${payload.probeName}" not found for feature ${payload.feature.template}#${payload.feature.name} ` +
        `(source: ${payload.source.kind})`,
    );
  }
  return probe;
}

async function main(): Promise<number> {
  // The payload rides argv, NEVER the environment: probes' gate commands inherit
  // this process's env, and FR11 requires it strictly untouched — no
  // engine-injected variable of any kind.
  const raw = process.argv[2];
  if (!raw) {
    console.error('probe-runner: missing payload argument');
    return RUNNER_EXIT.engineFailed;
  }
  let payload: ProbeRunnerPayload;
  let probe: Probe;
  try {
    payload = JSON.parse(raw) as ProbeRunnerPayload;
    probe = await loadProbe(payload);
  } catch (error) {
    // Loading/locating the probe is engine infrastructure, not the experiment:
    // a failure here is `broken`, never a false verdict.
    console.error(`probe-runner: ${error instanceof Error ? error.message : String(error)}`);
    return RUNNER_EXIT.engineFailed;
  }

  // exec children inherit THIS process's group (detached: false), so the parent's
  // single group-kill sweeps the probe and every command it spawns as one tree.
  // No inner default timeout is imposed: a command with no explicit `timeoutMs` is
  // bounded solely by the OUTER per-probe timeout (which group-kills the whole tree
  // from the parent). An inner default equal to the probe budget would only race
  // that outer kill; an EXPLICIT per-command `timeoutMs` still fires and now takes
  // the command's whole subtree with it (see `runDetachedCommand`).
  const repo = createProbeRepo(payload.sandboxPath, { detached: false });
  try {
    await probe.run(repo, {
      feature: payload.feature,
      sandboxPath: payload.sandboxPath,
      timeoutMs: payload.timeoutMs,
    });
    return RUNNER_EXIT.passed;
  } catch (error) {
    if (isProbeInapplicable(error)) {
      return RUNNER_EXIT.inapplicable;
    }
    if (error instanceof ProbeRepoOpError) {
      return RUNNER_EXIT.opFailed;
    }
    if (error instanceof Error && error.stack) {
      console.error(error.stack);
    }
    return RUNNER_EXIT.authorFailed;
  }
}

// Exit explicitly: a probe may have left the event loop non-empty (a stray timer,
// an unawaited handle), and the run's verdict is already decided by the code here.
process.exit(await main());
