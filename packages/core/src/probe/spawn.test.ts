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
    const cwd = await mkdtemp(join(tmpdir(), 'cyanprint-spawn-test-'));
    const startedAt = Date.now();
    // `setsid` re-sessions the child out of the command's process group (the
    // escape the group-kill cannot reach) while it keeps the inherited pipes open
    // for 15s; the foreground `sleep 30` guarantees the command itself times out.
    const result = await runDetachedCommand({
      command: "echo before-deadline; setsid sh -c 'sleep 15' & sleep 30",
      cwd,
      timeoutMs: 250,
    });
    const elapsed = Date.now() - startedAt;

    expect(result.timedOut).toBe(true);
    // Deadline + kill grace + overhead — nowhere near the escapee's 15s hold.
    expect(elapsed).toBeLessThan(5_000);
    // Output that arrived before the deadline is preserved in the result.
    expect(result.stdout).toContain('before-deadline');
  }, 20_000);

  test('non-detached (runner mode): a reparented escapee holding the pipes does not delay the timeout result', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'cyanprint-spawn-test-'));
    const startedAt = Date.now();
    // The intermediate `(… &)` subshell exits at once, reparenting its worker to
    // init BEFORE the deadline — the PPID-subtree walk cannot reach it, and it
    // holds the inherited pipes for 15s.
    const result = await runDetachedCommand({
      command: "(sh -c 'sleep 15' &) & sleep 30",
      cwd,
      timeoutMs: 250,
      detached: false,
    });
    const elapsed = Date.now() - startedAt;

    expect(result.timedOut).toBe(true);
    expect(elapsed).toBeLessThan(5_000);
  }, 20_000);
});
