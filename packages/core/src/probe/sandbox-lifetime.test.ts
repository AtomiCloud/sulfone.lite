import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exists } from '../util';
import { executeProbeMatrix } from './executor';
import { probeKey, type ResolvedFeatureProbes } from './matrix';
import { resolveProbesFromSource } from './resolve';
import { prepareProbeSandboxSource } from './sandbox';

/**
 * Run state must outlive the INVOKING SHELL (engine gap #24).
 *
 * The engine used to materialize its snapshot under the caller's `TMPDIR`
 * (`/tmp/nix-shell.XXXX/cyanprint-probe-XXXX/snapshot`) and hold that path for the
 * whole run. That directory's lifetime belongs to the invoking `nix-shell`, not to
 * the engine, so a shell exit — or an extra wrapper layer's shell lifecycle ending —
 * deleted live run state MID-RUN and folded the whole invocation with
 * `ENOENT ... statx .../snapshot` before any report existed.
 *
 * These tests simulate exactly that: `TMPDIR` is pointed at a caller-owned directory
 * and that directory is removed while the run is in flight. Nothing here is about
 * disk pressure — it is purely about who owns the path.
 */

let workRoot: string;
let repo: string;
let probesRoot: string;
let probesDir: string;
let originalTmpdir: string | undefined;

beforeAll(async () => {
  workRoot = await mkdtemp(join(tmpdir(), 'cyanprint-lifetime-test-'));
  repo = join(workRoot, 'repo');
  await mkdir(join(repo, 'src'), { recursive: true });
  await writeFile(join(repo, 'src/app.txt'), 'app v1\n', 'utf8');
  probesRoot = join(workRoot, 'probe-source');
  probesDir = join(probesRoot, 'probes');
  await mkdir(probesDir, { recursive: true });
  originalTmpdir = process.env.TMPDIR;
});

afterAll(async () => {
  if (originalTmpdir === undefined) {
    delete process.env.TMPDIR;
  } else {
    process.env.TMPDIR = originalTmpdir;
  }
  await rm(workRoot, { recursive: true, force: true });
});

/**
 * Point `TMPDIR` at a fresh caller-owned directory shaped like a nix-shell's, run
 * `body`, then restore. `body` receives the caller-owned path so it can delete it
 * mid-run the way a shell exit would.
 */
async function withCallerOwnedTmpdir<T>(body: (callerTmp: string) => Promise<T>): Promise<T> {
  const callerTmp = await mkdtemp(join(workRoot, 'nix-shell.'));
  process.env.TMPDIR = callerTmp;
  try {
    return await body(callerTmp);
  } finally {
    if (originalTmpdir === undefined) {
      delete process.env.TMPDIR;
    } else {
      process.env.TMPDIR = originalTmpdir;
    }
    await rm(callerTmp, { recursive: true, force: true });
  }
}

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

describe('run state is engine-owned, not caller-TMPDIR-owned (#24)', () => {
  test('the sandbox root is not allocated under the caller TMPDIR', async () => {
    await withCallerOwnedTmpdir(async callerTmp => {
      const source = await prepareProbeSandboxSource({ repoPath: repo, sandbox: { snapshot: 'fs' } });
      try {
        expect(source.root.startsWith(callerTmp)).toBe(false);
        expect(source.snapshotPath.startsWith(callerTmp)).toBe(false);
      } finally {
        await source.dispose();
      }
    });
  });

  test('the snapshot survives the invoking shell deleting its TMPDIR mid-run', async () => {
    await withCallerOwnedTmpdir(async callerTmp => {
      const source = await prepareProbeSandboxSource({ repoPath: repo, sandbox: { snapshot: 'fs' } });
      try {
        // The invoking shell exits: everything it owns under TMPDIR is removed while
        // the engine still holds live run state. On the old behaviour this deleted the
        // snapshot itself, and the next fork folded with ENOENT.
        await rm(callerTmp, { recursive: true, force: true });

        const run = await source.createRun();
        expect(await exists(join(run.path, 'src/app.txt'))).toBe(true);
        // A restore rereads the snapshot, so it fails too if the snapshot went away.
        await run.restore();
        expect(await exists(join(run.path, 'src/app.txt'))).toBe(true);
      } finally {
        await source.dispose();
      }
    });
  });

  test('a full matrix still produces a report when the caller TMPDIR vanishes mid-run', async () => {
    await withCallerOwnedTmpdir(async callerTmp => {
      // Runs are [baseline, mutation]. Serialized, the baseline probe runs first and
      // removes the invoking shell's TMPDIR — precisely the wrapper-shell exit from the
      // field report — while the mutation run's fork from the snapshot is still to come.
      const feature = await inlineFeature(
        'shell-exit',
        `[
          {
            name: 'caller-shell-exits',
            description: 'The invoking shell exits mid-run, taking its TMPDIR with it.',
            kind: 'baseline',
            run: async (repo) => { await repo.exec(${JSON.stringify(`rm -rf ${JSON.stringify(callerTmp)}`)}); },
          },
          {
            name: 'breaks-the-app',
            description: 'Removes the app file the run depends on.',
            kind: 'mutation',
            run: async (repo) => { await repo.exec('rm -f src/app.txt'); },
          },
        ]`,
      );

      const execution = await executeProbeMatrix({
        repoPath: repo,
        features: [feature],
        options: { parallelism: 1 },
      });

      // Verdicts ARE the report. On the old behaviour the matrix threw ENOENT out of the
      // mutation run's fork from the deleted snapshot and produced nothing at all: zero
      // rows, no verdict, nothing attributable.
      const identity = { template: 'local/tpl', name: 'shell-exit' };
      expect(execution.runs.length).toBe(2);
      expect(execution.verdicts.get(probeKey(identity, 'caller-shell-exits'))).toBeDefined();
      expect(execution.verdicts.get(probeKey(identity, 'breaks-the-app'))).toBeDefined();
    });
  });
});
