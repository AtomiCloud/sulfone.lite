// Full-stack e2e against an in-process local registry worker.
//
// Reading guide: every test is "given these template folders, this one-line command
// produces this output folder". Templates live in committed folders (examples/ and
// e2e/full-stack/fixtures/), expected outcomes are folders under e2e/full-stack/expected/
// compared file-by-file (run with E2E_UPDATE_EXPECTED=1 to refresh them), and commands
// are single interpolated lines showing exactly what the CLI is called with.
// Tests run in declaration order and build on each other.

import { afterAll, beforeAll, expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import app from '../../apps/worker/src/index';
import { cyan, cyanExpectingFailure, diffAgainstExpected, resetDir, stageFixture } from './helpers';

const root = process.cwd();
const tmp = join(root, '.tmp/e2e');
const fixtures = 'e2e/full-stack/fixtures';
const expected = 'e2e/full-stack/expected';

const workerEnv = { CYANPRINT_ENABLE_LOCAL_AUTH: '1', CYANPRINT_LOCAL_DEV_SECRET: 'cyanprint-local-dev' };
const server = Bun.serve({ port: 0, fetch: request => app.fetch(request, workerEnv) });
const registry = server.url.toString().replace(/\/$/, '');
let publish: { env: Record<string, string | undefined> };

const T = 120_000;

beforeAll(async () => {
  const sessionResponse = await fetch(`${registry}/auth/local-session`, {
    method: 'POST',
    headers: { 'x-cyanprint-dev-secret': 'cyanprint-local-dev' },
    body: JSON.stringify({ userId: 'user_local' }),
  });
  const session = ((await sessionResponse.json()) as { session: string }).session;
  const tokenResponse = await fetch(`${registry}/tokens`, {
    method: 'POST',
    headers: { 'x-cyanprint-session': session },
    body: JSON.stringify({ name: 'full-e2e' }),
  });
  const token = ((await tokenResponse.json()) as { token: string }).token;
  publish = { env: { ...process.env, CYANPRINT_TOKEN: token } };
});

afterAll(() => {
  server.stop(true);
});

// ── with-artifacts against the seeded registry ──────────────────────────────

test(
  'seeded registry: create cyanprint/with-artifacts matches its expected folder',
  async () => {
    const out = join(tmp, 'seeded-create');
    await resetDir(out);
    await cyan(
      `create cyanprint/with-artifacts --registry ${registry} --trust-fixture local-registry --out ${out} --headless --answers examples/templates/with-artifacts/answers.json --json`,
    );
    expect(await diffAgainstExpected(out, `${expected}/with-artifacts-create`)).toEqual([]);
  },
  T,
);

test(
  'push example artifacts (processors, plugin, resolvers) to the local registry',
  async () => {
    for (const artifact of [
      'examples/artifacts/processor-default',
      'examples/artifacts/processor-uppercase',
      'examples/artifacts/plugin-footer',
      'examples/artifacts/resolver-keep-user',
      'examples/artifacts/resolver1',
      'examples/artifacts/resolver2',
    ]) {
      await cyan(`push ${artifact} --registry ${registry} --json`, publish);
    }
  },
  T,
);

// ── tri-suite: three templates sharing one resolver-merged file ──────────────
// Fixtures: e2e/full-stack/fixtures/tri — tri-a/b/c all write shared.txt (merged by
// cyanprint/tri-merge), composed by tri-suite. v1 and v2 are sibling folders.

const triStage = join(tmp, 'tri-artifacts');
const triOut = join(tmp, 'tri-output');
const triConflictOut = join(tmp, 'tri-conflict-output');

async function pushTri(version: 'v1' | 'v2'): Promise<void> {
  await resetDir(triStage);
  await stageFixture(`${fixtures}/tri/resolver`, join(triStage, 'resolver'));
  for (const template of ['tri-a', 'tri-b', 'tri-c']) {
    await stageFixture(`${fixtures}/tri/${version}/${template}`, join(triStage, template));
  }
  await stageFixture(`${fixtures}/tri/tri-suite`, join(triStage, 'tri-suite'));
  for (const artifact of ['resolver', 'tri-a', 'tri-b', 'tri-c', 'tri-suite']) {
    await cyan(`push ${join(triStage, artifact)} --registry ${registry} --json`, publish);
  }
}

test(
  'tri v1: push fixtures/tri (resolver, tri-a/b/c, tri-suite)',
  async () => {
    await pushTri('v1');
  },
  T,
);

test(
  'tri v1: create cyanprint/tri-suite@1 matches expected/tri-create',
  async () => {
    await resetDir(triOut);
    await cyan(
      `create cyanprint/tri-suite@1 --registry ${registry} --trust-fixture local-registry --out ${triOut} --headless --json`,
    );
    expect(await diffAgainstExpected(triOut, `${expected}/tri-create`)).toEqual([]);
  },
  T,
);

test(
  'tri v2: push updated fixtures (registry assigns version 2)',
  async () => {
    await writeFile(join(triOut, 'shared.txt'), 'user shared edit\n', 'utf8');
    await pushTri('v2');
  },
  T,
);

test(
  'tri v2: update merges the user edit with a2/b2/c2, removes remove-a.txt, upgrades the resolver pin',
  async () => {
    await cyan(
      `update ${triOut} --template cyanprint/tri-suite --registry ${registry} --trust-fixture local-registry --headless --json`,
    );
    expect(await diffAgainstExpected(triOut, `${expected}/tri-update`)).toEqual([]);
    const state = await Bun.file(join(triOut, '.cyan_state.yaml')).text();
    expect(state).toContain('name: tri-merge');
    expect(state).toContain('version: "2"');
  },
  T,
);

test(
  'tri v2: update with a user-edited conflict.txt fails and records .cyan_conflicts',
  async () => {
    await resetDir(triConflictOut);
    await cyan(
      `create cyanprint/tri-suite@1 --registry ${registry} --trust-fixture local-registry --out ${triConflictOut} --headless --json`,
    );
    await writeFile(join(triConflictOut, 'conflict.txt'), 'user conflict edit\n', 'utf8');
    await cyanExpectingFailure(
      `update ${triConflictOut} --template cyanprint/tri-suite --registry ${registry} --trust-fixture local-registry --headless --json`,
    );
    expect(await Bun.file(join(triConflictOut, '.cyan_conflicts/conflict.txt.target')).exists()).toBe(true);
  },
  T,
);

// ── publish the example templates and groups ─────────────────────────────────

test(
  'push example templates and the basic template group',
  async () => {
    for (const template of [
      'examples/templates/hello',
      'examples/templates/with-artifacts',
      'examples/templates/template-resolver-1',
      'examples/templates/template-resolver-2',
      'examples/template-groups/basic',
      'examples/templates/update-v2',
      'examples/templates/new',
      'examples/templates/workspace',
      'examples/templates/nix',
    ]) {
      await cyan(`push ${template} --registry ${registry} --json`, publish);
    }
  },
  T,
);

test(
  'batch-resolve finds the freshly published template',
  async () => {
    const response = await fetch(`${registry}/batch-resolve`, {
      method: 'POST',
      body: JSON.stringify({ refs: [{ kind: 'template', owner: 'cyanprint', name: 'with-artifacts' }] }),
    });
    const resolved = (await response.json()) as { resolved: unknown[] };
    expect(resolved.resolved).toHaveLength(1);
  },
  T,
);

test(
  'published registry: create cyanprint/with-artifacts matches its expected folder and records dependency pins',
  async () => {
    const out = join(tmp, 'full-create');
    await resetDir(out);
    await cyan(
      `create cyanprint/with-artifacts --registry ${registry} --trust-fixture local-registry --out ${out} --headless --answers examples/templates/with-artifacts/answers.json --json`,
    );
    expect(await diffAgainstExpected(out, `${expected}/with-artifacts-create`)).toEqual([]);
    const state = await Bun.file(join(out, '.cyan_state.yaml')).text();
    for (const dependency of ['name: default', 'name: uppercase', 'name: footer', 'name: keep-user']) {
      expect(state).toContain(dependency);
    }
  },
  T,
);

test(
  'try cyanprint/with-artifacts generates into a scratch folder',
  async () => {
    await cyan(
      `try cyanprint/with-artifacts --registry ${registry} --trust-fixture local-registry --headless --answers examples/templates/with-artifacts/answers.json --json`,
    );
  },
  T,
);

// ── template group: create + update through the nested child resolver ────────

const groupOut = join(tmp, 'group-create');

test(
  'basic-group: create composes child templates and matches its expected folder',
  async () => {
    await resetDir(groupOut);
    await cyan(
      `create cyanprint/basic-group --registry ${registry} --trust-fixture local-registry --out ${groupOut} --headless --answers examples/template-groups/basic/answers.json --json`,
    );
    expect(await diffAgainstExpected(groupOut, `${expected}/group-create`)).toEqual([]);
  },
  T,
);

test(
  'basic-group: update keeps a user README edit via the nested child resolver',
  async () => {
    await writeFile(join(groupOut, 'README.md'), '# User Group Edit\n\nKeep this nested resolver edit.\n', 'utf8');
    await cyan(
      `update ${groupOut} --template cyanprint/basic-group --registry ${registry} --trust-fixture local-registry --headless --answers examples/template-groups/basic/answers.json --json`,
    );
    expect(await diffAgainstExpected(groupOut, `${expected}/group-update`)).toEqual([]);
  },
  T,
);

// ── cyanprint test + local update flows ───────────────────────────────────────

test(
  'cyanprint test examples/templates/with-artifacts passes',
  async () => {
    await cyan(
      `test examples/templates/with-artifacts --answers examples/templates/with-artifacts/answers.json --out .tmp/e2e/full-test`,
    );
  },
  T,
);

test(
  'local update with a user-edited README fails and records the conflict target',
  async () => {
    const out = join(tmp, 'local-update');
    await resetDir(out);
    await cyan(
      `create examples/templates/update-v1 --out ${out} --headless --answers examples/templates/update-v1/answers.json --json`,
    );
    await writeFile(join(out, 'README.md'), '# User Edit\n\nKeep me.\n', 'utf8');
    await cyanExpectingFailure(
      `update ${out} --template examples/templates/update-v2 --headless --answers examples/templates/update-v2/answers.json --json`,
    );
    expect(await Bun.file(join(out, '.cyan_conflicts/README.md.target')).exists()).toBe(true);
  },
  T,
);

test(
  'registry update: update-v1 project updated to cyanprint/update-example matches expected/registry-update',
  async () => {
    const out = join(tmp, 'registry-update');
    await resetDir(out);
    await cyan(
      `create examples/templates/update-v1 --out ${out} --headless --answers examples/templates/update-v1/answers.json --json`,
    );
    await cyan(
      `update ${out} --template cyanprint/update-example --registry ${registry} --trust-fixture local-registry --headless --answers examples/templates/update-v2/answers.json --json`,
    );
    expect(await diffAgainstExpected(out, `${expected}/registry-update`)).toEqual([]);
  },
  T,
);

// ── template-resolver pair: file removal/addition and conflict preservation ───

test(
  'registry resolver templates: updating template-resolver-1 to -2 removes from-1.txt and adds from-2.txt',
  async () => {
    const out = join(tmp, 'resolver-update');
    await resetDir(out);
    await cyan(
      `create cyanprint/template-resolver-1 --registry ${registry} --trust-fixture local-registry --out ${out} --headless --json`,
    );
    await cyan(
      `update ${out} --template cyanprint/template-resolver-2 --registry ${registry} --trust-fixture local-registry --headless --json`,
    );
    expect(await diffAgainstExpected(out, `${expected}/resolver-update`)).toEqual([]);
  },
  T,
);

test(
  'registry resolver templates: a user-edited file fails the update and preserves the conflict target',
  async () => {
    const out = join(tmp, 'resolver-conflict');
    await resetDir(out);
    await cyan(
      `create cyanprint/template-resolver-1 --registry ${registry} --trust-fixture local-registry --out ${out} --headless --json`,
    );
    await writeFile(join(out, 'force_conflict.txt'), 'user edit\n', 'utf8');
    await cyanExpectingFailure(
      `update ${out} --template cyanprint/template-resolver-2 --registry ${registry} --trust-fixture local-registry --headless --json`,
    );
    expect(await Bun.file(join(out, '.cyan_conflicts/force_conflict.txt.target')).exists()).toBe(true);
  },
  T,
);
