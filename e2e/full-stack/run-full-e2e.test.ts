// Full-stack e2e: every one of the 39 required parity cases (see e2e.md) runs as a REAL
// test against the CLI and an in-process local registry worker.
//
// Reading guide: each test is "given these template folders, this one-line command produces
// this output folder". Templates live in committed folders (examples/ and
// e2e/full-stack/fixtures/), expected outcomes are folders under e2e/full-stack/expected/
// compared file-by-file (run with E2E_UPDATE_EXPECTED=1 to refresh them), and commands are
// single interpolated lines showing exactly what the CLI is called with.
// Tests run in declaration order (local-only cases, then seeded registry, publishing,
// merge semantics, registry flows, the tri-suite upgrade story, and the composition
// features) and later cases build on earlier pushes.

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

async function readState(outDir: string): Promise<string> {
  return await Bun.file(join(outDir, '.cyan_state.yaml')).text();
}

async function latestVersion(kind: string, owner: string, name: string): Promise<number> {
  const response = await fetch(`${registry}/artifacts/${kind}/${owner}/${name}/versions`);
  const body = (await response.json()) as { artifacts: Array<{ version: string }> };
  return Math.max(0, ...body.artifacts.map(artifact => Number(artifact.version)));
}

async function pushExpectingVersionBump(path: string, kind: string, owner: string, name: string): Promise<void> {
  const previous = await latestVersion(kind, owner, name);
  const output = await cyan(`push ${path} --registry ${registry} --json`, publish);
  const published = JSON.parse(output) as { artifact: { version: string } };
  expect(published.artifact.version).toBe(String(previous + 1));
}

// ── local-only cases (no registry) ───────────────────────────────────────────

test(
  'case 1: template works',
  async () => {
    const out = join(tmp, 'hello-create');
    await resetDir(out);
    await cyan(
      `create examples/templates/hello --out ${out} --headless --answers examples/templates/hello/answers.json --json`,
    );
    expect(await diffAgainstExpected(out, `${expected}/hello-create`)).toEqual([]);
  },
  T,
);

test(
  'case 2: template works with all input types (text, confirm, select, multiselect, number)',
  async () => {
    // The all-types fixture is the prompt showcase: placeholders, descriptions,
    // per-option help, validation, and defaults — try it interactively with
    // `bun run cyan -- create e2e/full-stack/fixtures/prompts/all-types .tmp/demo`.
    const out = join(tmp, 'prompts-create');
    await resetDir(out);
    await cyan(
      `create ${fixtures}/prompts/all-types --out ${out} --headless --answers ${fixtures}/prompts/all-types/answers.json --json`,
    );
    expect(await diffAgainstExpected(out, `${expected}/prompts-create`)).toEqual([]);

    // Defaults fill unanswered prompts headlessly (public=true, flavor=batteries, toppings=ci).
    const defaultsOut = join(tmp, 'prompts-defaults');
    await resetDir(defaultsOut);
    await cyan(
      `create ${fixtures}/prompts/all-types --out ${defaultsOut} --headless --answers ${fixtures}/prompts/all-types/answers-defaults.json --json`,
    );
    const rendered = await Bun.file(join(defaultsOut, 'OUT.md')).text();
    expect(rendered).toContain('public:   true');
    expect(rendered).toContain('flavor:   batteries');
    expect(rendered).toContain('toppings: ci');

    // Validation rejects out-of-range headless answers with the author's message.
    const failure = await cyanExpectingFailure(
      `create ${fixtures}/prompts/all-types --out ${join(tmp, 'prompts-invalid')} --headless --answers ${fixtures}/prompts/all-types/answers-invalid.json --json`,
    );
    expect(failure).toContain('Port must be between 1024 and 65535');
  },
  T,
);

test(
  'case 3: two templates can be installed (template group composes children)',
  async () => {
    const out = join(tmp, 'group-local-create');
    await resetDir(out);
    await cyan(`create examples/template-groups/basic --out ${out} --headless --json`);
    expect(await diffAgainstExpected(out, `${expected}/group-create`)).toEqual([]);
  },
  T,
);

test(
  'case 11: multiple processor output merges, later output overriding earlier',
  async () => {
    const out = join(tmp, 'scoped-create');
    await resetDir(out);
    await cyan(`create ${fixtures}/processors/scoped --out ${out} --headless --json`);
    expect(await Bun.file(join(out, 'OUT.md')).text()).toBe('value=second\n');
  },
  T,
);

test(
  'case 19: try works on a template (scratch output)',
  async () => {
    await cyan(`try examples/templates/hello --headless --answers examples/templates/hello/answers.json --json`);
  },
  T,
);

test(
  'case 21: test works on a processor with input and expected fixture',
  async () => {
    await cyan(`test examples/artifacts/processor-uppercase --json`);
  },
  T,
);

test(
  'case 22: processor validations command runs expecting exit 0',
  async () => {
    await cyan(`test examples/artifacts/processor-default --json`);
  },
  T,
);

test(
  'case 23: test works on a plugin with input and expected fixture',
  async () => {
    await cyan(`test examples/artifacts/plugin-footer --json`);
  },
  T,
);

test(
  'case 24: plugin validations command runs expecting exit 0',
  async () => {
    const output = await cyan(`test examples/artifacts/plugin-footer --json`);
    expect((JSON.parse(output) as { failed: number }).failed).toBe(0);
  },
  T,
);

test(
  'case 25: resolver test accepts folders, resolver config, and expected fixture',
  async () => {
    await cyan(`test examples/artifacts/resolver-keep-user --json`);
  },
  T,
);

test(
  'case 26: test works on a template with an expected output directory',
  async () => {
    await cyan(
      `test examples/templates/with-artifacts --answers examples/templates/with-artifacts/answers.json --out .tmp/e2e/full-test --json`,
    );
  },
  T,
);

test(
  'case 27: template validations command runs expecting exit 0',
  async () => {
    const output = await cyan(
      `test examples/templates/with-artifacts --answers examples/templates/with-artifacts/answers.json --out .tmp/e2e/full-test --json`,
    );
    expect((JSON.parse(output) as { failed: number }).failed).toBe(0);
  },
  T,
);

test(
  'case 6: templates update with a three-way merge (nested resolver keeps the user edit)',
  async () => {
    const out = join(tmp, 'group-local-update');
    await resetDir(out);
    await cyan(`create examples/template-groups/basic --out ${out} --headless --json`);
    await writeFile(join(out, 'README.md'), '# User Group Edit\n\nKeep this nested resolver edit.\n', 'utf8');
    await cyan(`update ${out} --template examples/template-groups/basic --headless --json`);
    expect(await diffAgainstExpected(out, `${expected}/group-update`)).toEqual([]);
  },
  T,
);

test(
  'case 7: templates update with conflict (user edit lands in .cyan_conflicts)',
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

// ── seeded registry ───────────────────────────────────────────────────────────

test(
  'case 4: template installs its own dependencies (processor, plugin, resolver pins in state)',
  async () => {
    const out = join(tmp, 'seeded-create');
    await resetDir(out);
    await cyan(
      `create cyanprint/with-artifacts --registry ${registry} --trust-fixture local-registry --out ${out} --headless --answers examples/templates/with-artifacts/answers.json --json`,
    );
    expect(await diffAgainstExpected(out, `${expected}/with-artifacts-create`)).toEqual([]);
    const state = await readState(out);
    for (const dependency of ['name: default', 'name: uppercase', 'name: footer', 'name: keep-user']) {
      expect(state).toContain(dependency);
    }
  },
  T,
);

// ── publishing ────────────────────────────────────────────────────────────────

test(
  'case 28: push works on template (templates, groups, and batch-resolve visibility)',
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
    // The official in-tree parity copies prove themselves the same way: push runs
    // their cyan.test.yaml suites (staged so bundling never mutates the committed tree).
    for (const official of ['in-tree/official/templates/new', 'in-tree/official/processors/default']) {
      const staged = await stageFixture(official, join(tmp, 'push-stage'));
      await cyan(`push ${staged} --registry ${registry} --json`, publish);
    }
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
  'case 29: push works on template, bumping version',
  async () => {
    await pushExpectingVersionBump('examples/templates/with-artifacts', 'template', 'cyanprint', 'with-artifacts');
  },
  T,
);

test(
  'case 30: push works on plugin',
  async () => {
    await cyan(`push examples/artifacts/plugin-footer --registry ${registry} --json`, publish);
  },
  T,
);

test(
  'case 31: push works on plugin, bumping version',
  async () => {
    await pushExpectingVersionBump('examples/artifacts/plugin-footer', 'plugin', 'cyanprint', 'footer');
  },
  T,
);

test(
  'case 32: push works on processor',
  async () => {
    await cyan(`push examples/artifacts/processor-default --registry ${registry} --json`, publish);
    await cyan(`push examples/artifacts/processor-uppercase --registry ${registry} --json`, publish);
  },
  T,
);

test(
  'case 33: push works on processor, bumping version',
  async () => {
    await pushExpectingVersionBump('examples/artifacts/processor-default', 'processor', 'cyan', 'default');
  },
  T,
);

test(
  'case 34: push works on resolver',
  async () => {
    for (const resolver of [
      'examples/artifacts/resolver-keep-user',
      'examples/artifacts/resolver1',
      'examples/artifacts/resolver2',
      `${fixtures}/merge/resolver-a`,
      `${fixtures}/merge/resolver-b`,
    ]) {
      const staged = await stageFixture(resolver, join(tmp, 'push-stage'));
      await cyan(`push ${staged} --registry ${registry} --json`, publish);
    }
  },
  T,
);

test(
  'case 35: push works on resolver, bumping version',
  async () => {
    const staged = await stageFixture('examples/artifacts/resolver-keep-user', join(tmp, 'push-stage'));
    await pushExpectingVersionBump(staged, 'resolver', 'cyanprint', 'keep-user');
  },
  T,
);

// ── same-path merge semantics (fixtures/merge, via the registry) ─────────────
// Leaves all write shared.txt; groups compose them with different resolver setups.

async function pushMergeFixtures(names: string[]): Promise<void> {
  for (const name of names) {
    const staged = await stageFixture(`${fixtures}/merge/${name}`, join(tmp, 'push-stage'));
    await cyan(`push ${staged} --registry ${registry} --json`, publish);
  }
}

async function createMergeGroup(group: string, out: string): Promise<string> {
  await resetDir(out);
  await cyan(
    `create cyanprint/${group} --registry ${registry} --trust-fixture local-registry --out ${out} --headless --json`,
  );
  return await readState(out);
}

test(
  'case 12: same-path templates with a matching resolver merge instead of overriding',
  async () => {
    await pushMergeFixtures(['merge-la1', 'merge-la2', 'merge-same']);
    const out = join(tmp, 'merge-same');
    const state = await createMergeGroup('merge-same', out);
    expect(await diffAgainstExpected(out, `${expected}/merge-same`)).toEqual([]);
    expect(state).not.toContain('reason:');
  },
  T,
);

test(
  'case 16: same resolver and same config merge commutatively',
  async () => {
    await pushMergeFixtures(['merge-same-rev']);
    const out = join(tmp, 'merge-same-rev');
    await createMergeGroup('merge-same-rev', out);
    // Reversed composition order must produce the exact same merged output.
    expect(await diffAgainstExpected(out, `${expected}/merge-same`)).toEqual([]);
  },
  T,
);

test(
  'case 13: same-path templates without a resolver record a no_resolver LWW conflict',
  async () => {
    await pushMergeFixtures(['merge-ln1', 'merge-ln2', 'merge-none']);
    const out = join(tmp, 'merge-none');
    const state = await createMergeGroup('merge-none', out);
    expect(await Bun.file(join(out, 'shared.txt')).text()).toBe('ln2\n');
    expect(state).toContain('no_resolver');
  },
  T,
);

test(
  'case 14: same-path templates with different resolvers record a different_resolver LWW conflict',
  async () => {
    await pushMergeFixtures(['merge-lb1', 'merge-mixed']);
    const out = join(tmp, 'merge-mixed');
    const state = await createMergeGroup('merge-mixed', out);
    expect(await Bun.file(join(out, 'shared.txt')).text()).toBe('lb1\n');
    expect(state).toContain('different_resolver');
  },
  T,
);

test(
  'case 15: same resolver with different config records a same_resolver_different_config LWW conflict',
  async () => {
    await pushMergeFixtures(['merge-la3', 'merge-config']);
    const out = join(tmp, 'merge-config');
    const state = await createMergeGroup('merge-config', out);
    expect(state).toContain('same_resolver_different_config');
  },
  T,
);

test(
  'case 17: resolver subset plus a no-resolver layer falls back to LWW',
  async () => {
    await pushMergeFixtures(['merge-subset']);
    const out = join(tmp, 'merge-subset');
    const state = await createMergeGroup('merge-subset', out);
    expect(await Bun.file(join(out, 'shared.txt')).text()).toBe('ln1\n');
    expect(state).toContain('no_resolver');
  },
  T,
);

test(
  'case 18: different resolver groups merge internally but fall back to LWW across groups',
  async () => {
    await pushMergeFixtures(['merge-lb2', 'merge-groups']);
    const out = join(tmp, 'merge-groups');
    const state = await createMergeGroup('merge-groups', out);
    expect(await diffAgainstExpected(out, `${expected}/merge-groups`)).toEqual([]);
    expect(state).toContain('different_resolver');
  },
  T,
);

// ── registry create/update/try flows ─────────────────────────────────────────

test(
  'case 20: try works on templates with dependencies resolved on the fly',
  async () => {
    await cyan(
      `try cyanprint/with-artifacts --registry ${registry} --trust-fixture local-registry --headless --answers examples/templates/with-artifacts/answers.json --json`,
    );
  },
  T,
);

test(
  'case 5: templates update normally (registry update applies the new version)',
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

test(
  'case 8: templates update when the new version deletes files (and conflicts are preserved)',
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

    const conflictOut = join(tmp, 'resolver-conflict');
    await resetDir(conflictOut);
    await cyan(
      `create cyanprint/template-resolver-1 --registry ${registry} --trust-fixture local-registry --out ${conflictOut} --headless --json`,
    );
    await writeFile(join(conflictOut, 'force_conflict.txt'), 'user edit\n', 'utf8');
    await cyanExpectingFailure(
      `update ${conflictOut} --template cyanprint/template-resolver-2 --registry ${registry} --trust-fixture local-registry --headless --json`,
    );
    expect(await Bun.file(join(conflictOut, '.cyan_conflicts/force_conflict.txt.target')).exists()).toBe(true);
  },
  T,
);

test(
  'case 10: templates pass forced answers to dependencies (group presets prefill child answers)',
  async () => {
    const out = join(tmp, 'group-create');
    await resetDir(out);
    await cyan(
      `create cyanprint/basic-group --registry ${registry} --trust-fixture local-registry --out ${out} --headless --json`,
    );
    expect(await diffAgainstExpected(out, `${expected}/group-create`)).toEqual([]);
    // The group's presets answered the children's prompts; the shared answer persists in state.
    expect(await readState(out)).toContain('name: Group Hello');
  },
  T,
);

// ── tri-suite: three templates, shared resolver, full upgrade story ───────────
// Fixtures: e2e/full-stack/fixtures/tri — tri-a/b/c all write shared.txt (merged by
// cyanprint/tri-merge), composed by tri-suite. v1 and v2 are sibling folders.

const triStage = join(tmp, 'tri-artifacts');
const triOut = join(tmp, 'tri-output');

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
  'case 9: multiple templates update with a three-way merge after a same-layer merge',
  async () => {
    await pushTri('v1');
    await resetDir(triOut);
    await cyan(
      `create cyanprint/tri-suite@1 --registry ${registry} --trust-fixture local-registry --out ${triOut} --headless --json`,
    );
    expect(await diffAgainstExpected(triOut, `${expected}/tri-create`)).toEqual([]);
    await writeFile(join(triOut, 'shared.txt'), 'user shared edit\n', 'utf8');
    await pushTri('v2');
    await cyan(
      `update ${triOut} --template cyanprint/tri-suite --registry ${registry} --trust-fixture local-registry --headless --json`,
    );
    const shared = await Bun.file(join(triOut, 'shared.txt')).text();
    for (const line of ['user shared edit', 'a2', 'b2', 'c2']) {
      expect(shared).toContain(line);
    }
  },
  T,
);

test(
  'case 36: three templates with upgraded resolver merge previous VFS, updated VFS, removals, conflicts, and clean output',
  async () => {
    // Continues from case 9: full output tree, removal of remove-a.txt, and the upgraded pin.
    expect(await diffAgainstExpected(triOut, `${expected}/tri-update`)).toEqual([]);
    const state = await readState(triOut);
    expect(state).toContain('name: tri-merge');
    expect(state).toContain('version: "2"');

    const conflictOut = join(tmp, 'tri-conflict-output');
    await resetDir(conflictOut);
    await cyan(
      `create cyanprint/tri-suite@1 --registry ${registry} --trust-fixture local-registry --out ${conflictOut} --headless --json`,
    );
    await writeFile(join(conflictOut, 'conflict.txt'), 'user conflict edit\n', 'utf8');
    await cyanExpectingFailure(
      `update ${conflictOut} --template cyanprint/tri-suite --registry ${registry} --trust-fixture local-registry --headless --json`,
    );
    expect(await Bun.file(join(conflictOut, '.cyan_conflicts/conflict.txt.target')).exists()).toBe(true);
  },
  T,
);

// ── composition features ──────────────────────────────────────────────────────

test(
  'case 37: parent presets cascade answers and deterministic state to descendants; outermost ancestor wins',
  async () => {
    for (const template of ['cascade-c', 'cascade-b', 'cascade-a']) {
      const staged = await stageFixture(`${fixtures}/cascade/${template}`, join(tmp, 'push-stage'));
      await cyan(`push ${staged} --registry ${registry} --json`, publish);
    }
    const out = join(tmp, 'cascade-create');
    await resetDir(out);
    await cyan(
      `create cyanprint/cascade-a --registry ${registry} --trust-fixture local-registry --out ${out} --headless --json`,
    );
    // Root A's preset beats B's for the grandchild, and A's deterministic seed reached state.
    expect(await Bun.file(join(out, 'OUT.md')).text()).toBe('grand=FROM_A\n');
    expect(await readState(out)).toContain('seed: A_SEED');
  },
  T,
);

test(
  'case 38: each template may appear only once in a composition; duplicates are rejected',
  async () => {
    for (const template of ['dup-leaf', 'dup-x', 'dup-y', 'dup-group']) {
      const staged = await stageFixture(`${fixtures}/dup/${template}`, join(tmp, 'push-stage'));
      await cyan(`push ${staged} --registry ${registry} --json`, publish);
    }
    const out = join(tmp, 'dup-create');
    await resetDir(out);
    const failure = await cyanExpectingFailure(
      `create cyanprint/dup-group --registry ${registry} --trust-fixture local-registry --out ${out} --headless --json`,
    );
    expect(failure).toContain('included more than once');
  },
  T,
);

test(
  'case 39: trace reports per-file provenance, per-template output, and contribution diffs',
  async () => {
    const output = await cyan(`trace examples/template-groups/basic --headless --json`);
    const trace = JSON.parse(output) as {
      tree: { ref: string; children: unknown[] };
      provenance: Array<{ path: string; source: string; decision: string }>;
      diffs: unknown[];
    };
    expect(trace.tree.ref).toBe('cyanprint/basic-group');
    expect(trace.tree.children).toHaveLength(2);
    expect(trace.provenance.length).toBeGreaterThan(0);
    expect(trace.provenance.some(entry => entry.decision === 'lww-override')).toBe(true);
    expect(trace.diffs.length).toBeGreaterThan(0);
  },
  T,
);
