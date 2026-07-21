/**
 * Detached process spawning for the probe engine. Every command a probe (or a
 * sandbox setup phase) runs is placed in its OWN process group (`detached: true`,
 * pgid = child pid), so a timeout can kill the entire still-grouped process tree —
 * children, grandchildren, backgrounded shells — by signalling the negative pgid
 * (FR10).
 *
 * Containment boundary (FR10/FR11 conflict resolution, 2026-07-04, option 2): the
 * kill guarantee covers the spawned process group (and, in non-detached runner
 * mode, the PPID-connected subtree) ONLY. FR11 requires the command environment
 * inherited STRICTLY untouched — no engine-injected variable of any kind — which
 * rules out the env-marker tracking that following daemonized descendants would
 * need. A descendant that leaves the process group (`setsid`, or reparenting to
 * init when its intermediate parent exits) therefore escapes the kill: that is a
 * DOCUMENTED, out-of-scope limitation, not a gap to close in userspace.
 */

export type DetachedCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** True when the command was killed because it exceeded its timeout. */
  timedOut: boolean;
};

/**
 * Run a shell command with the environment inherited untouched (FR11: no env
 * assumptions — nothing is read, altered, injected, or required). Never throws on
 * non-zero exit; a timeout kills the command's process group (detached) or its
 * PPID-connected subtree (non-detached), and the result only resolves once that
 * kill settled. See the module doc for the containment boundary.
 */
export async function runDetachedCommand(args: {
  command: string;
  cwd: string;
  timeoutMs?: number;
  /**
   * When true (the default) the command leads its OWN process group, so a timeout
   * kills its whole tree via the negative pgid. When false the command inherits
   * the caller's process group — used by the isolated probe runner, whose single
   * group is killed as one by the parent (see `probe-process.ts`). A per-command
   * timeout in this mode CANNOT group-kill (that would take the runner and every
   * sibling command down too), so it kills the shell plus its PPID-connected
   * subtree instead.
   */
  detached?: boolean;
}): Promise<DetachedCommandResult> {
  const detached = args.detached ?? true;
  const proc = Bun.spawn(['sh', '-c', args.command], {
    cwd: args.cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
    detached,
  });
  const stdout = collectPipe(proc.stdout);
  const stderr = collectPipe(proc.stderr);
  let timedOut = false;
  let killed: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (args.timeoutMs !== undefined) {
    timer = setTimeout(() => {
      timedOut = true;
      killed = killCommandTree(proc.pid, detached).then(() => {
        // A descendant that escaped the kill boundary may have INHERITED the
        // command's stdout/stderr pipe fds and hold them open for as long as it
        // lives — waiting for pipe EOF would then delay (or block forever) the
        // timeout result the caller is owed at the deadline (FR10: a timed-out
        // command becomes a bounded failure, it never hangs the engine). Stop
        // reading instead: the result carries whatever output arrived before
        // the kill settled.
        stdout.cancel();
        stderr.cancel();
      });
    }, args.timeoutMs);
  }
  try {
    // Observe the command's OWN exit independently of its output pipes. A
    // descendant that escaped the kill boundary can inherit the command's
    // stdout/stderr fds and hold the pipes open long after the command itself
    // exits — even with NO timeout in play (a normal exit that backgrounded an
    // in-group child). Joining on the pipes (the old `Promise.all([...text,
    // proc.exited])`) would then hang the result forever; wait on `proc.exited`,
    // then drain each pipe with a bounded grace so the read can never outlive the
    // command.
    const exitCode = await proc.exited;
    // Clear the timeout the instant the command's OWN process exits, BEFORE any
    // kill/drain work — matching `probe-process.ts`. Once the owner has exited the
    // deadline no longer applies: leaving the timer armed across the awaits below
    // (`await killed`, then `drainPipe`'s up-to-grace wait for a held pipe) would
    // let it fire against an already-exited command, flip `timedOut` true, and
    // cancel the pipes — mislabelling a clean `exitCode: 0` as a timeout. A genuine
    // timeout has already fired here (the timer resolved before `proc.exited`), so
    // this clear is a no-op in that case and `timedOut`/`killed` stay set.
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    // A timed-out command's result is only reported once the kill fully settled:
    // the caller must be able to trust that nothing the kill covers can still
    // mutate the sandbox after `exec` resolved.
    if (killed !== undefined) {
      await killed;
    }
    const [stdoutText, stderrText] = await Promise.all([drainPipe(stdout), drainPipe(stderr)]);
    return { exitCode, stdout: stdoutText, stderr: stderrText, timedOut };
  } finally {
    // Belt-and-suspenders: the try body clears the timer immediately on exit; this
    // covers only the early-throw path before that clear ran.
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/**
 * Incrementally collect a child-process output pipe into text, optionally retaining
 * only the last `maxBytes`, with a `cancel` that releases the pipe WITHOUT waiting
 * for EOF — the escape hatch for pipes a kill-surviving descendant still holds open
 * (see the timeout path above). After `cancel`, `text` resolves with everything
 * retained up to that point.
 */
export function collectPipe(
  stream: ReadableStream<Uint8Array>,
  maxBytes?: number,
): { text: Promise<string>; cancel: () => void } {
  if (maxBytes !== undefined && (!Number.isInteger(maxBytes) || maxBytes < 0)) {
    throw new RangeError(`maxBytes must be a non-negative integer, got ${maxBytes}`);
  }
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let collected = '';
  let tail = new Uint8Array();
  const text = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }
        if (maxBytes === undefined) {
          collected += decoder.decode(value, { stream: true });
        } else if (maxBytes === 0) {
          tail = new Uint8Array();
        } else if (value.length >= maxBytes) {
          tail = value.slice(-maxBytes);
        } else {
          const retained = Math.min(tail.length, maxBytes - value.length);
          const next = new Uint8Array(retained + value.length);
          next.set(tail.subarray(tail.length - retained));
          next.set(value, retained);
          tail = next;
        }
      }
    } catch {
      // Cancelled mid-read: keep what was decoded before the cancel.
    }
    return maxBytes === undefined ? collected + decoder.decode() : decoder.decode(tail);
  })();
  return {
    text,
    cancel: () => {
      // Resolves any pending read with `done: true`; best-effort by design.
      void reader.cancel().catch(() => undefined);
    },
  };
}

/**
 * How long to keep draining a pipe after the process that owns its write end has
 * exited, before force-cancelling it (see {@link drainPipe}). In the common case
 * the pipe reaches EOF the instant the owner exits and `text` resolves well
 * inside this window at no latency cost; only a pipe an escaped descendant is
 * still holding open ever pays the full grace.
 */
const PIPE_DRAIN_GRACE_MS = 200;

/**
 * Read a collected pipe to EOF, BUT bounded: call this only after the process
 * that owns the pipe's write end has exited. Its own bytes are already flushed to
 * the OS buffer and drain immediately; if a descendant that inherited the fd
 * holds the pipe open past {@link PIPE_DRAIN_GRACE_MS}, cancel so the read cannot
 * outlive the owner (FR10: a completed/timed-out command yields a bounded result,
 * never a hang). `text` then resolves with everything decoded up to the cancel.
 */
export async function drainPipe(
  pipe: { text: Promise<string>; cancel: () => void },
  graceMs = PIPE_DRAIN_GRACE_MS,
): Promise<string> {
  const timer = setTimeout(() => pipe.cancel(), graceMs);
  try {
    return await pipe.text;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Kill what a timed-out command spawned, within the pinned containment boundary:
 * a detached command dies with its whole process group; a non-detached one (runner
 * mode) dies with its PPID-connected subtree, collected BEFORE killing the shell
 * (killing first would reparent the children to init and break the walk).
 */
async function killCommandTree(rootPid: number, detached: boolean): Promise<void> {
  if (detached) {
    await killProcessTree(rootPid);
    return;
  }
  // Shares the caller's process group: a group-kill would be fratricidal.
  const descendants = await collectDescendants(rootPid);
  for (const pid of [rootPid, ...descendants]) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
}

/**
 * Kill an entire process tree by its group id: SIGTERM first (a chance to clean
 * up), then SIGKILL escalation after a short grace period. Signals go to the
 * NEGATIVE pgid so every descendant in the group dies with the leader.
 */
export async function killProcessTree(pid: number, graceMs = 500): Promise<void> {
  if (!signalProcessGroup(pid, 'SIGTERM')) {
    return;
  }
  await Bun.sleep(graceMs);
  signalProcessGroup(pid, 'SIGKILL');
}

/** Signal a process group; false when the group is already gone. */
function signalProcessGroup(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false;
  }
}

/** Every transitive descendant pid of `rootPid`, from a single `ps` snapshot. */
async function collectDescendants(rootPid: number): Promise<number[]> {
  const childrenOf = new Map<number, number[]>();
  try {
    const proc = Bun.spawn(['ps', '-Ao', 'pid=,ppid='], { stdout: 'pipe', stderr: 'ignore' });
    const [table] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    for (const line of table.split('\n')) {
      const match = line.trim().match(/^(\d+)\s+(\d+)$/);
      if (!match) {
        continue;
      }
      const pid = Number(match[1]);
      const ppid = Number(match[2]);
      const siblings = childrenOf.get(ppid) ?? [];
      siblings.push(pid);
      childrenOf.set(ppid, siblings);
    }
  } catch {
    // `ps` unavailable: fall back to killing just the root (in the caller).
    return [];
  }
  const descendants: number[] = [];
  const queue = [rootPid];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const child of childrenOf.get(current) ?? []) {
      descendants.push(child);
      queue.push(child);
    }
  }
  return descendants;
}
