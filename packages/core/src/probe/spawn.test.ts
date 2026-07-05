import { describe, expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDetachedCommand } from './spawn';

// Regression: a descendant that escapes the timeout kill boundary inherits the
// command's stdout/stderr pipe fds and can hold them open long after the kill —
// a daemon would hold them forever. The timeout result must land at the deadline
// (plus the kill's SIGTERM→SIGKILL grace), NEVER when the escapee finally lets
// go: FR10 bounds the failure. The escapee's own survival is the documented
// FR10/FR11 containment limitation and is deliberately not asserted here.
describe('timeout returns at the deadline even when an escaped child holds the output pipes', () => {
  test('detached: a setsid escapee holding stdout/stderr does not delay the timeout result', async () => {
    // Arrange
    const cwd = await mkdtemp(join(tmpdir(), 'cyanprint-spawn-test-'));
    const startedAt = Date.now();
    // `setsid` re-sessions the child out of the command's process group (the
    // escape the group-kill cannot reach) while it keeps the inherited pipes open
    // for 15s; the foreground `sleep 30` guarantees the command itself times out.

    // Act
    const result = await runDetachedCommand({
      command: "echo before-deadline; setsid sh -c 'sleep 15' & sleep 30",
      cwd,
      timeoutMs: 250,
    });
    const elapsed = Date.now() - startedAt;

    // Assert
    expect(result.timedOut).toBe(true);
    // Deadline + kill grace + overhead — nowhere near the escapee's 15s hold.
    expect(elapsed).toBeLessThan(5_000);
    // Output that arrived before the deadline is preserved in the result.
    expect(result.stdout).toContain('before-deadline');
  }, 20_000);

  test('a command that EXITS NORMALLY but leaves an escapee holding the pipes still returns at once', async () => {
    // Regression: with no timeout to fire, an escapee inheriting stdout/stderr and
    // holding them open would stall a completed command forever under the old
    // `Promise.all([...text, proc.exited])` join. The result must follow the
    // command's own exit, draining only what arrived before the bounded grace.

    // Arrange
    const cwd = await mkdtemp(join(tmpdir(), 'cyanprint-spawn-test-'));
    const startedAt = Date.now();

    // Act
    const result = await runDetachedCommand({
      // Foreground command finishes immediately (exit 0); the setsid escapee keeps
      // the inherited pipes open for 15s. No timeoutMs is set.
      command: "echo done; setsid sh -c 'sleep 15' &",
      cwd,
    });
    const elapsed = Date.now() - startedAt;

    // Assert
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('done');
    // Landed on the command's own exit + drain grace, not the escapee's 15s hold.
    expect(elapsed).toBeLessThan(5_000);
  }, 20_000);

  test('a command that EXITS 0 before its deadline is never reported timed out, even with a timeout armed and an escapee holding the pipes', async () => {
    // Regression: `runDetachedCommand` used to clear its timeout only in
    // `finally`, AFTER `drainPipe`. With a timeout ARMED, a command that exits 0 but
    // leaves an escapee holding stdout/stderr makes `drainPipe` wait up to its 200ms
    // grace; a `timeoutMs` landing inside that post-exit drain window fired against
    // the already-finished command, cancelled the pipes, and mislabelled exit 0 as
    // `timedOut`. The prior escaped-pipe regression above omits `timeoutMs`, so the
    // timer path was never exercised — this covers it. The fix clears the timer the
    // instant the command's own process exits, before any drain.

    // Arrange
    const cwd = await mkdtemp(join(tmpdir(), 'cyanprint-spawn-test-'));
    const startedAt = Date.now();

    // Act
    // Foreground exits in ~ms (echo + fork); the setsid escapee holds the inherited
    // pipes for 15s. `timeoutMs: 150` sits comfortably above the command's own exit
    // yet well inside the post-exit drain grace (exit ≪ 150ms < exit + 200ms) —
    // exactly where the old `finally`-only clear let the timer fire on a finished run.
    const result = await runDetachedCommand({
      command: "echo done; setsid sh -c 'sleep 15' &",
      cwd,
      timeoutMs: 150,
    });
    const elapsed = Date.now() - startedAt;

    // Assert
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('done');
    // Landed on the command's own exit + bounded drain grace, not the escapee's 15s.
    expect(elapsed).toBeLessThan(5_000);
  }, 20_000);

  test('non-detached (runner mode): a reparented escapee holding the pipes does not delay the timeout result', async () => {
    // Arrange
    const cwd = await mkdtemp(join(tmpdir(), 'cyanprint-spawn-test-'));
    const startedAt = Date.now();
    // The intermediate `(… &)` subshell exits at once, reparenting its worker to
    // init BEFORE the deadline — the PPID-subtree walk cannot reach it, and it
    // holds the inherited pipes for 15s.

    // Act
    const result = await runDetachedCommand({
      command: "(sh -c 'sleep 15' &) & sleep 30",
      cwd,
      timeoutMs: 250,
      detached: false,
    });
    const elapsed = Date.now() - startedAt;

    // Assert
    expect(result.timedOut).toBe(true);
    expect(elapsed).toBeLessThan(5_000);
  }, 20_000);
});
