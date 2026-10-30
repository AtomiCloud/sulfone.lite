import { collectPipe, drainPipe, killProcessTree, trackProcessGroup } from '../probe/spawn';

export type CommandResult = {
  command: string;
  allowed: boolean;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  /** True when the command was killed for exceeding its timeout. */
  timedOut?: boolean;
};

/** Generous default: a hung command must not hang create/update forever. */
export const DEFAULT_POST_GENERATION_TIMEOUT_MS = 10 * 60 * 1000;

/** Largest delay `setTimeout` honours; anything bigger overflows and fires immediately. */
const MAX_TIMEOUT_MS = 2_147_483_647;

/** Env override for the per-command timeout (positive integer milliseconds). */
export const POST_GENERATION_TIMEOUT_ENV = 'CYANPRINT_COMMAND_TIMEOUT_MS';

function resolveTimeoutMs(explicit: number | undefined): number {
  if (explicit !== undefined) {
    return explicit;
  }
  const fromEnv = Number(process.env[POST_GENERATION_TIMEOUT_ENV]);
  return Number.isInteger(fromEnv) && fromEnv > 0 && fromEnv <= MAX_TIMEOUT_MS
    ? fromEnv
    : DEFAULT_POST_GENERATION_TIMEOUT_MS;
}

export async function runPostGenerationCommand(intent: {
  command: string;
  args?: string[];
  allow?: boolean;
  cwd?: string;
  /** Overrides the default timeout (and the env override). */
  timeoutMs?: number;
}): Promise<CommandResult> {
  if (!intent.allow) {
    return { command: intent.command, allowed: false, stderr: 'Post-generation commands require explicit allow.' };
  }
  const timeoutMs = resolveTimeoutMs(intent.timeoutMs);
  // Lead our own process group so a timeout kills the whole tree, not just the direct child.
  const proc = Bun.spawn([intent.command, ...(intent.args ?? [])], {
    cwd: intent.cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    detached: true,
  });
  const release = trackProcessGroup(proc.pid);
  const stdout = collectPipe(proc.stdout);
  const stderr = collectPipe(proc.stderr);
  let timedOut = false;
  let killed: Promise<void> | undefined;
  const timer = setTimeout(() => {
    timedOut = true;
    killed = killProcessTree(proc.pid).then(() => {
      // A surviving descendant may hold the pipes open; stop reading rather than hang.
      stdout.cancel();
      stderr.cancel();
    });
  }, timeoutMs);
  try {
    const exitCode = await proc.exited;
    clearTimeout(timer);
    if (killed) {
      await killed;
    }
    const [stdoutText, stderrText] = await Promise.all([drainPipe(stdout), drainPipe(stderr)]);
    return {
      command: intent.command,
      allowed: true,
      exitCode,
      stdout: stdoutText,
      stderr: stderrText,
      ...(timedOut ? { timedOut } : {}),
    };
  } finally {
    clearTimeout(timer);
    release();
  }
}
