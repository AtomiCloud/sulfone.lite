import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exists } from '../util';
import { probeKey, type ResolvedFeatureProbes } from './matrix';
import { executeProbeMatrix } from './executor';
import { resolveProbesFromSource } from './resolve';

// Probes execute in ISOLATED child processes (probe-process.ts / probe-runner.ts),
// so a probe cannot be an in-process closure — the runner re-loads it from a file.
// These tests therefore write each probe definition to a real `probes/<name>.ts`
// and resolve it through explicit-source mode, exactly as production does. The
// probe bodies are TS source strings: they run in a separate process and reference
// only their `repo`/`ctx` arguments and globals (`Bun`), never test-scope state.

let workRoot: string;
let repo: string;
let probesRoot: string;
let probesDir: string;

beforeAll(async () => {
  workRoot = await mkdtemp(join(tmpdir(), 'cyanprint-executor-test-'));
  repo = join(workRoot, 'repo');
  await mkdir(repo, { recursive: true });
  await writeFile(join(repo, 'app.txt'), 'healthy\n', 'utf8');
  probesRoot = join(workRoot, 'probe-source');
  probesDir = join(probesRoot, 'probes');
  await mkdir(probesDir, { recursive: true });
});

afterAll(async () => {
  await rm(workRoot, { recursive: true, force: true });
});

/**
 * Write a `probes/<name>.ts` definition and resolve it through explicit-source
 * mode so it carries the `source` the isolated runner needs. `probesArraySource`
 * is the TS source of the definition's `probes` array literal.
 */
async function inlineFeature(name: string, probesArraySource: string): Promise<ResolvedFeatureProbes> {
  await writeFile(
    join(probesDir, `${name}.ts`),
    `export default { contractVersion: 1, probes: ${probesArraySource} };\n`,
    'utf8',
  );
  const [resolved] = await resolveProbesFromSource({
    sourceDir: probesRoot,
    features: [{ template: 'local/tpl', name }],
  });
  if (!resolved) {
    throw new Error(`failed to resolve inline feature ${name}`);
  }
  return resolved;
}

function verdictOf(execution: Awaited<ReturnType<typeof executeProbeMatrix>>, name: string, probe: string) {
  return execution.verdicts.get(probeKey({ template: 'local/tpl', name }, probe));
}

/** Poll until a pid is gone (reaped) or the budget elapses. */
async function waitDead(pid: number, budgetMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true; // ESRCH: the process is gone
    }
    await Bun.sleep(50);
  }
  return false;
}

const SLEEP_PROBE = (name: string, kind: 'baseline' | 'mutation', ms: number) =>
  `{ name: '${name}', description: 'sleeps ${ms}ms', kind: '${kind}', run: async () => { await Bun.sleep(${ms}); } }`;

describe('probe timeouts kill the whole process tree (AC6)', () => {
  test('a probe spawning a long-lived child+grandchild ends broken within its timeout, tree dead', async () => {
    // Arrange
    const timeoutMs = 1_500;
    // The exec'd sh (child, in the runner's group) records its own pid, then
    // backgrounds a grandchild sh that records ITS pid; both block on a long sleep.
    // The whole tree shares the runner's process group, so the external group-kill
    // on timeout takes it all — no orphan survives.
    const feature = await inlineFeature(
      'hang',
      `[{
        name: 'hanging-mutation',
        description: 'Spawns a process tree that outlives any polite request to stop.',
        kind: 'mutation',
        timeoutMs: ${timeoutMs},
        run: async (repo) => {
          await repo.exec("echo $$ > child.txt; sh -c 'echo $$ > grand.txt; sleep 300' & sleep 300");
        },
      }]`,
    );

    // Act
    const startedAt = Date.now();
    const execution = await executeProbeMatrix({
      repoPath: repo,
      features: [feature],
      options: { keepSandboxes: true, sandboxRoot: join(workRoot, 'ac6') },
    });
    const elapsed = Date.now() - startedAt;

    // Assert
    expect(verdictOf(execution, 'hang', 'hanging-mutation')).toBe('broken');
    // Ends within the timeout window (plus kill-escalation + subprocess overhead).
    expect(elapsed).toBeLessThan(timeoutMs + 8_000);

    const sandboxPath = execution.runs.find(run => run.kind === 'mutation')?.sandboxPath;
    if (!sandboxPath) {
      throw new Error('mutation run sandbox was not retained');
    }
    const childPid = Number((await readFile(join(sandboxPath, 'child.txt'), 'utf8')).trim());
    const grandPid = Number((await readFile(join(sandboxPath, 'grand.txt'), 'utf8')).trim());
    expect(Number.isInteger(childPid) && childPid > 0).toBe(true);
    expect(Number.isInteger(grandPid) && grandPid > 0).toBe(true);
    // No process from the probe's spawned tree survives the timeout kill.
    expect(await waitDead(childPid)).toBe(true);
    expect(await waitDead(grandPid)).toBe(true);
  }, 30_000);
});

describe('timeout isolation is an absolute boundary', () => {
  test('a probe that keeps working AFTER its timeout cannot overlap or mutate the sandbox post-deadline', async () => {
    // Regression: an async probe that continues past its deadline.
    // Under isolation the whole process is killed at the deadline, so `late.txt` is
    // never written and the next probe in the run never overlaps it.

    // Arrange
    const feature = await inlineFeature(
      'boundary',
      `[
        {
          name: 'overruns-timeout',
          description: 'Keeps doing async work well past its short deadline.',
          kind: 'baseline',
          timeoutMs: 300,
          run: async (repo) => {
            await Bun.sleep(4000);
            await repo.write('late.txt', 'written after the deadline');
          },
        },
        {
          name: 'runs-after',
          description: 'The next baseline in the same run.',
          kind: 'baseline',
          run: async (repo) => { await repo.write('after.txt', 'ok'); },
        },
      ]`,
    );

    // Act
    const startedAt = Date.now();
    const execution = await executeProbeMatrix({
      repoPath: repo,
      features: [feature],
      options: { keepSandboxes: true, sandboxRoot: join(workRoot, 'boundary') },
    });
    const elapsed = Date.now() - startedAt;

    // Assert
    // The overrunning probe is broken, while its independently passing sibling remains proven.
    expect(verdictOf(execution, 'boundary', 'overruns-timeout')).toBe('broken');
    expect(verdictOf(execution, 'boundary', 'runs-after')).toBe('proven');
    expect(execution.events.find(event => event.probe === 'overruns-timeout')).toMatchObject({
      role: 'baseline',
      outcome: 'timeout',
      verdict: 'broken',
    });

    // It was killed at its deadline, not after its 4s of async work.
    expect(elapsed).toBeLessThan(4_000);

    const sandboxPath = execution.runs[0]?.sandboxPath;
    if (!sandboxPath) {
      throw new Error('baseline run sandbox was not retained');
    }
    // The post-deadline write never happened; the next probe still ran normally.
    expect(await exists(join(sandboxPath, 'late.txt'))).toBe(false);
    expect(await exists(join(sandboxPath, 'after.txt'))).toBe(true);

    // Spans never overlap: the killed probe is fully gone before the next starts.
    const spans = execution.spans;
    expect(spans).toHaveLength(2);
    const [first, second] = [...spans].sort((a, b) => a.startedAt - b.startedAt);
    expect(second!.startedAt).toBeGreaterThanOrEqual(first!.endedAt);
  }, 30_000);

  test('a synchronously-blocking probe is killed and reported broken — the matrix never hangs', async () => {
    // Regression: a probe that blocks the event loop forever. An
    // in-thread timer can never fire; only an external kill stops it. If isolation
    // failed this test would hang and time out.

    // Arrange
    const feature = await inlineFeature(
      'spin',
      `[{
        name: 'blocks-forever',
        description: 'Blocks the event loop synchronously and never yields.',
        kind: 'mutation',
        timeoutMs: 500,
        run: () => { while (true) {} },
      }]`,
    );

    // Act
    const startedAt = Date.now();
    const execution = await executeProbeMatrix({ repoPath: repo, features: [feature] });
    const elapsed = Date.now() - startedAt;

    // Assert
    expect(verdictOf(execution, 'spin', 'blocks-forever')).toBe('broken');
    // Bounded: timeout + SIGTERM→SIGKILL grace + overhead, nowhere near a hang.
    expect(elapsed).toBeLessThan(15_000);
  }, 30_000);
});

describe('child diagnostics', () => {
  test('exit code and the final 4 KiB of stdout/stderr are retained per child', async () => {
    const feature = await inlineFeature(
      'diagnostics',
      `[{
        name: 'noisy-baseline',
        description: 'Emits enough output to exercise bounded diagnostic tails.',
        kind: 'baseline',
        run: () => {
          console.log('x'.repeat(5000) + 'stdout-end');
          console.error('y'.repeat(5000) + 'stderr-end');
        },
      }]`,
    );

    const execution = await executeProbeMatrix({ repoPath: repo, features: [feature] });
    const event = execution.events.find(candidate => candidate.probe === 'noisy-baseline');

    expect(event).toBeDefined();
    expect(event?.exitCode).toBe(0);
    expect(event?.verdict).toBe('proven');
    expect(Buffer.byteLength(event?.stdoutTail ?? '', 'utf8')).toBeLessThanOrEqual(4096);
    expect(Buffer.byteLength(event?.stderrTail ?? '', 'utf8')).toBeLessThanOrEqual(4096);
    expect(event?.stdoutTail.endsWith('stdout-end\n')).toBe(true);
    expect(event?.stderrTail.endsWith('stderr-end\n')).toBe(true);
  });
});

// Containment boundary (FR10/FR11 resolution, 2026-07-04, option 2): the kill
// guarantee is scoped to the runner's PROCESS GROUP. A descendant that re-sessions
// out of it (`setsid`, daemonization) escapes — a documented, out-of-scope
// limitation, because tracking it would need an engine-injected env marker, which
// FR11 forbids. These tests therefore assert pgid-scoped kills only, never
// orphan-free absolutes.
describe('post-run group kill reaps what a probe left in its process group', () => {
  test('an in-group process backgrounded by a passing probe does not outlive its run', async () => {
    // The probe backgrounds a worker that STAYS in the runner's process group and
    // returns normally. The worker records `alive.txt` at once (proof it really
    // started) and would write `late.txt` at ~1500ms; the parent's post-exit group
    // kill must take it down before then. The probe waits for the alive marker so
    // the worker is provably running when the runner exits.

    // Arrange
    const feature = await inlineFeature(
      'daemon',
      `[{
        name: 'backgrounder',
        description: 'Leaves an in-group background worker behind and returns normally.',
        kind: 'baseline',
        run: async (repo) => {
          await repo.exec("sh -c 'echo alive > alive.txt; sleep 1.5; echo late > late.txt' >/dev/null 2>&1 &");
          for (let waited = 0; waited < 5000; waited += 50) {
            if ((await repo.glob('alive.txt')).length > 0) return;
            await Bun.sleep(50);
          }
          throw new Error('background worker never started');
        },
      }]`,
    );

    // Act
    const execution = await executeProbeMatrix({
      repoPath: repo,
      features: [feature],
      options: { keepSandboxes: true, sandboxRoot: join(workRoot, 'group-reap') },
    });

    // Assert
    // The probe itself passed — the post-exit group kill is invisible to healthy verdicts.
    expect(verdictOf(execution, 'daemon', 'backgrounder')).toBe('proven');

    const sandboxPath = execution.runs[0]?.sandboxPath;
    if (!sandboxPath) {
      throw new Error('baseline run sandbox was not retained');
    }
    // Wait past when the worker WOULD have written: it genuinely started (alive
    // marker present) but the post-exit group kill stopped it before its late write.
    await Bun.sleep(2_500);
    expect(await exists(join(sandboxPath, 'alive.txt'))).toBe(true);
    expect(await exists(join(sandboxPath, 'late.txt'))).toBe(false);
  }, 30_000);
});

// Regression: an escaped descendant (its OWN process group, so the timeout
// group-kill cannot reach it) that inherited the runner's stderr pipe used to
// keep the parent's pipe read — and with it the whole matrix — blocked until the
// escapee exited. The timeout verdict must land at the deadline regardless
// (FR10 bounds the failure); the escapee's survival stays the documented
// FR10/FR11 limitation.
describe('timeout verdict is bounded even when an escaped descendant holds inherited pipes', () => {
  test('a probe leaving an out-of-group child on the runner stderr pipe still lands broken at its deadline', async () => {
    // Arrange
    const timeoutMs = 1_000;
    const feature = await inlineFeature(
      'escape',
      `[{
        name: 'pipe-holder',
        description: 'Backgrounds an out-of-group child on the inherited stderr pipe, then overruns.',
        kind: 'mutation',
        timeoutMs: ${timeoutMs},
        run: async () => {
          // detached => the child leads a NEW process group (escapes the group
          // kill) while stderr: 'inherit' keeps the runner's stderr pipe open.
          Bun.spawn(['sh', '-c', 'sleep 15'], { stdin: 'ignore', stdout: 'ignore', stderr: 'inherit', detached: true });
          await Bun.sleep(300000);
        },
      }]`,
    );

    // Act
    const startedAt = Date.now();
    const execution = await executeProbeMatrix({ repoPath: repo, features: [feature] });
    const elapsed = Date.now() - startedAt;

    // Assert
    expect(verdictOf(execution, 'escape', 'pipe-holder')).toBe('broken');
    // Bounded: deadline + kill grace + engine overhead — never the escapee's 15s hold.
    expect(elapsed).toBeLessThan(timeoutMs + 9_000);
  }, 30_000);
});

// Regression: a probe whose own `run()` COMPLETES SUCCESSFULLY but leaves behind
// a backgrounded, out-of-group child that inherited the runner's stderr pipe. The
// runner exits at once with a passing code, yet the inherited pipe stays open
// until the escapee dies. Joining the verdict on the pipe (the old
// `Promise.all([proc.exited, stderrPipe.text])`) stalled the finished probe until
// the escapee exited — long enough for the per-probe timeout to fire and report a
// genuine `proven` as `broken`. The verdict must follow the runner's OWN exit,
// landing well inside the deadline.
describe('a successful probe is not turned into a false timeout by a child holding the stderr pipe', () => {
  test('a passing baseline that backgrounds an out-of-group pipe-holder still lands proven at once', async () => {
    // Arrange
    const timeoutMs = 10_000;
    const feature = await inlineFeature(
      'quick-escape',
      `[{
        name: 'passes-then-leaves-holder',
        description: 'Backgrounds an out-of-group child on the inherited stderr pipe, then returns normally.',
        kind: 'baseline',
        timeoutMs: ${timeoutMs},
        run: async () => {
          // detached => NEW process group (escapes the post-run group kill) while
          // stderr: 'inherit' keeps the runner's stderr pipe open for 15s. run()
          // itself returns immediately — a healthy, passing baseline.
          Bun.spawn(['sh', '-c', 'sleep 15'], { stdin: 'ignore', stdout: 'ignore', stderr: 'inherit', detached: true });
        },
      }]`,
    );

    // Act
    const startedAt = Date.now();
    const execution = await executeProbeMatrix({ repoPath: repo, features: [feature] });
    const elapsed = Date.now() - startedAt;

    // Assert
    // The probe's own run succeeded, so the verdict is proven — NOT a false timeout.
    expect(verdictOf(execution, 'quick-escape', 'passes-then-leaves-holder')).toBe('proven');
    // It landed on the runner's exit (plus the pipe-drain grace + overhead), not at
    // the 10s deadline and nowhere near the escapee's 15s pipe hold.
    expect(elapsed).toBeLessThan(timeoutMs);
  }, 30_000);
});

describe('parallelism (AC11)', () => {
  test('runs execute concurrently by default and probes within a run never overlap', async () => {
    // Arrange
    const features = [
      await inlineFeature(
        'one',
        `[${SLEEP_PROBE('one-base', 'baseline', 300)}, ${SLEEP_PROBE('one-mut', 'mutation', 300)}]`,
      ),
      await inlineFeature(
        'two',
        `[${SLEEP_PROBE('two-base', 'baseline', 300)}, ${SLEEP_PROBE('two-mut', 'mutation', 300)}]`,
      ),
    ];

    // Act
    const execution = await executeProbeMatrix({ repoPath: repo, features });

    // Assert
    // Observed overlap between runs: at least one pair of probe spans from
    // different runs executed at the same time.
    const crossRunOverlap = execution.spans.some(left =>
      execution.spans.some(
        right => left.runIndex < right.runIndex && left.startedAt < right.endedAt && right.startedAt < left.endedAt,
      ),
    );
    expect(crossRunOverlap).toBe(true);

    // Probes WITHIN a run are sequential: no two spans of one run overlap.
    for (const left of execution.spans) {
      for (const right of execution.spans) {
        if (left === right || left.runIndex !== right.runIndex) {
          continue;
        }
        const overlaps = left.startedAt < right.endedAt && right.startedAt < left.endedAt;
        expect(overlaps).toBe(false);
      }
    }
  }, 30_000);

  test('parallelism: 1 serializes runs', async () => {
    // Arrange
    const features = [
      await inlineFeature(
        'one',
        `[${SLEEP_PROBE('one-base', 'baseline', 150)}, ${SLEEP_PROBE('one-mut', 'mutation', 150)}]`,
      ),
      await inlineFeature('two', `[${SLEEP_PROBE('two-mut', 'mutation', 150)}]`),
    ];

    // Act
    const execution = await executeProbeMatrix({ repoPath: repo, features, options: { parallelism: 1 } });

    // Assert
    const ordered = [...execution.runs].sort((left, right) => left.startedAt - right.startedAt);
    for (let index = 1; index < ordered.length; index += 1) {
      expect(ordered[index]!.startedAt).toBeGreaterThanOrEqual(ordered[index - 1]!.endedAt);
    }
  }, 30_000);
});

describe('sandbox hygiene (NFC3)', () => {
  const tidyFeatures = () =>
    inlineFeature(
      'tidy',
      `[
        { name: 'tidy-base', description: 'passes', kind: 'baseline', run: () => {} },
        { name: 'tidy-mut', description: 'passes', kind: 'mutation', run: () => {} },
      ]`,
    );

  test('engine-managed sandboxes are removed after a matrix run by default', async () => {
    // Arrange
    const sandboxRoot = join(workRoot, 'hygiene-default');

    // Act
    await executeProbeMatrix({ repoPath: repo, features: [await tidyFeatures()], options: { sandboxRoot } });

    // Assert
    expect(await readdir(sandboxRoot)).toEqual([]);
  }, 30_000);

  test('keepSandboxes retains the snapshot and run sandboxes', async () => {
    // Arrange
    const sandboxRoot = join(workRoot, 'hygiene-keep');

    // Act
    const execution = await executeProbeMatrix({
      repoPath: repo,
      features: [await tidyFeatures()],
      options: { sandboxRoot, keepSandboxes: true },
    });

    // Assert
    expect(execution.snapshotPath && (await exists(execution.snapshotPath))).toBe(true);
    for (const run of execution.runs) {
      expect(run.sandboxPath && (await exists(run.sandboxPath))).toBe(true);
    }
  }, 30_000);
});

describe('setup failures mark affected runs broken', () => {
  test('a failing setup.pre marks every probe of every run broken', async () => {
    // Arrange
    const feature = await inlineFeature(
      'doomed',
      `[
        { name: 'doomed-base', description: 'never runs', kind: 'baseline', run: () => {} },
        { name: 'doomed-mut', description: 'never runs', kind: 'mutation', run: () => {} },
      ]`,
    );
    feature.definition.setup = { pre: ['exit 9'] };

    // Act
    const execution = await executeProbeMatrix({ repoPath: repo, features: [feature] });

    // Assert
    expect(verdictOf(execution, 'doomed', 'doomed-base')).toBe('broken');
    expect(verdictOf(execution, 'doomed', 'doomed-mut')).toBe('broken');
  }, 30_000);

  test('a failing setup.post marks the affected runs broken', async () => {
    // Arrange
    const feature = await inlineFeature(
      'doomed-post',
      `[{ name: 'post-base', description: 'never runs', kind: 'baseline', run: () => {} }]`,
    );
    feature.definition.setup = { post: ['exit 3'] };

    // Act
    const execution = await executeProbeMatrix({ repoPath: repo, features: [feature] });

    // Assert
    expect(verdictOf(execution, 'doomed-post', 'post-base')).toBe('broken');
  }, 30_000);
});
