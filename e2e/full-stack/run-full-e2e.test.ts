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
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import YAML from 'yaml';
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

// Structured view of `.cyan_state.yaml`: installed templates (with history) plus the
// persisted provenance set — every merge decision of the last generation.
type StateProvenance = {
  path: string;
  source: string;
  decision: 'added' | 'resolver-merged' | 'lww-override';
  segment?: 'processor' | 'dependency' | 'sibling';
  resolver?: string;
  contributors?: Array<{ template: string; layer: number; processor?: { ref: string; invocation: number } }>;
};
type ParsedState = {
  cyanprint: number;
  templates: Array<{
    owner: string;
    name: string;
    version: string;
    source: string;
    active: boolean;
    history: Array<{ version: string; answers: Record<string, unknown> }>;
    artifacts: Array<{ kind: string; owner: string; name: string; version: string }>;
  }>;
  files: Array<{ path: string; sha256: string }>;
  provenance: StateProvenance[];
};

async function parseState(outDir: string): Promise<ParsedState> {
  return YAML.parse(await readState(outDir)) as ParsedState;
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
    // Tier 1 (processor outputs): both hermetic invocations wrote OUT.md, no resolver was
    // nominated, so the later invocation wins LWW — persisted as provenance in state.
    const state = await parseState(out);
    const decision = state.provenance.find(entry => entry.path === 'OUT.md');
    expect(decision?.decision).toBe('lww-override');
    expect(decision?.segment).toBe('processor');
    expect(decision?.contributors).toHaveLength(2);
    expect(decision?.contributors?.[1]?.processor).toEqual({ ref: 'cyan/default', invocation: 1 });
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
  'case 6: templates update with a three-way merge (user edits survive; local sources re-execute identically)',
  async () => {
    // Local-path sources re-execute the SAME directory for base and theirs, so update is
    // a no-op for template content — the three-way merge keeps the user's edit (ours)
    // because base == theirs. Moving a local project to a NEW template version is a
    // re-create instead (case 7).
    const out = join(tmp, 'group-local-update');
    await resetDir(out);
    await cyan(`create examples/template-groups/basic --out ${out} --headless --json`);
    await writeFile(join(out, 'README.md'), '# User Group Edit\n\nKeep this local update edit.\n', 'utf8');
    await cyan(`update ${out} --headless --json`);
    expect(await diffAgainstExpected(out, `${expected}/group-update`)).toEqual([]);
    // State stays readable and unbumped: same version ⇒ no new history entry.
    const state = await parseState(out);
    expect(state.templates[0]?.name).toBe('basic-group');
    expect(state.templates[0]?.active).toBe(true);
    expect(state.templates[0]?.history).toHaveLength(1);
  },
  T,
);

test(
  'case 7: templates update with conflict (re-create upsert leaves in-file git markers)',
  async () => {
    const out = join(tmp, 'local-update');
    await resetDir(out);
    await cyan(
      `create examples/templates/update-v1 --out ${out} --headless --answers examples/templates/update-v1/answers.json --json`,
    );
    await writeFile(join(out, 'README.md'), '# User Edit\n\nKeep me.\n', 'utf8');
    // The local "move to a new template version" flow: create the new template dir into
    // the existing project. Same owner/name (cyanprint/update-example) ⇒ UPSERT — base is
    // the old source re-executed with saved answers, theirs the new dir, ours the disk.
    // The wholesale user edit genuinely diverges from both ⇒ in-file conflict markers,
    // non-zero exit, result.status 'conflict'.
    const failure = await cyanExpectingFailure(
      `create examples/templates/update-v2 --out ${out} --headless --answers examples/templates/update-v2/answers.json --json`,
    );
    const report = JSON.parse(failure) as { status: string; conflicts: string[] };
    expect(report.status).toBe('conflict');
    expect(report.conflicts).toContain('README.md');
    const readme = await Bun.file(join(out, 'README.md')).text();
    expect(readme).toContain('<<<<<<<');
    expect(readme).toContain('Keep me.');
    expect(readme).toContain('Version two.');
    // With conflicts pending, state must NOT advance: the retry after resolving merges
    // from the original base, not from the half-accepted incoming tree.
    const state = await parseState(out);
    expect(state.templates).toHaveLength(1);
    expect(state.templates[0]?.history).toHaveLength(1);
    expect(await Bun.file(join(out, '.cyan_conflicts')).exists()).toBe(false);
    // Resolving the markers (accepting incoming) and re-running the upsert completes it
    // and only then records install #2.
    await writeFile(
      join(out, 'README.md'),
      '# Update Project\n\nUpdated with pinned answers.\n\nVersion two.\n',
      'utf8',
    );
    await cyan(
      `create examples/templates/update-v2 --out ${out} --headless --answers examples/templates/update-v2/answers.json --json`,
    );
    const resolved = await parseState(out);
    expect(resolved.templates).toHaveLength(1);
    expect(resolved.templates[0]?.history).toHaveLength(2);
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
    // Dependency pins live under the installed template's `artifacts:` in the state.
    const state = await parseState(out);
    const artifactNames = (state.templates[0]?.artifacts ?? []).map(artifact => artifact.name);
    for (const dependency of ['default', 'uppercase', 'footer', 'keep-user']) {
      expect(artifactNames).toContain(dependency);
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
// Consensus (same resolver ref + identical config across ALL contributors) ⇒ one global
// resolver call; anything else (AllNone / NoConsensus / Ambiguous) ⇒ LWW, persisted as an
// `lww-override` provenance entry in `.cyan_state.yaml` (the old `conflicts:` reason
// strings no_resolver / different_resolver / same_resolver_different_config are gone).

async function pushMergeFixtures(names: string[]): Promise<void> {
  for (const name of names) {
    const staged = await stageFixture(`${fixtures}/merge/${name}`, join(tmp, 'push-stage'));
    await cyan(`push ${staged} --registry ${registry} --json`, publish);
  }
}

async function createMergeGroup(group: string, out: string): Promise<ParsedState> {
  await resetDir(out);
  await cyan(
    `create cyanprint/${group} --registry ${registry} --trust-fixture local-registry --out ${out} --headless --json`,
  );
  return await parseState(out);
}

function sharedDecision(state: ParsedState): StateProvenance | undefined {
  return state.provenance.find(entry => entry.path === 'shared.txt');
}

test(
  'case 12: same-path templates with a matching resolver merge instead of overriding',
  async () => {
    await pushMergeFixtures(['merge-la1', 'merge-la2', 'merge-same']);
    const out = join(tmp, 'merge-same');
    const state = await createMergeGroup('merge-same', out);
    expect(await diffAgainstExpected(out, `${expected}/merge-same`)).toEqual([]);
    // Consensus on cyanprint/merge-a ⇒ ONE resolver-merged decision, no LWW anywhere.
    const decision = sharedDecision(state);
    expect(decision?.decision).toBe('resolver-merged');
    expect(decision?.resolver).toBe('cyanprint/merge-a');
    expect(decision?.segment).toBe('dependency');
    expect(decision?.contributors).toHaveLength(2);
    expect(state.provenance.some(entry => entry.decision === 'lww-override')).toBe(false);
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
  'case 13: same-path templates without any resolver fall back to LWW (AllNone override recorded)',
  async () => {
    await pushMergeFixtures(['merge-ln1', 'merge-ln2', 'merge-none']);
    const out = join(tmp, 'merge-none');
    const state = await createMergeGroup('merge-none', out);
    expect(await Bun.file(join(out, 'shared.txt')).text()).toBe('ln2\n');
    const decision = sharedDecision(state);
    expect(decision?.decision).toBe('lww-override');
    expect(decision?.segment).toBe('dependency');
    expect(decision?.source).toBe('cyanprint/merge-ln2@local');
    expect(decision?.contributors).toHaveLength(2);
  },
  T,
);

test(
  'case 14: same-path templates with different resolvers fall back to LWW (no consensus)',
  async () => {
    await pushMergeFixtures(['merge-lb1', 'merge-mixed']);
    const out = join(tmp, 'merge-mixed');
    const state = await createMergeGroup('merge-mixed', out);
    // merge-la1 nominates cyanprint/merge-a, merge-lb1 nominates cyanprint/merge-b —
    // no consensus, so no resolver runs and the highest layer wins.
    expect(await Bun.file(join(out, 'shared.txt')).text()).toBe('lb1\n');
    const decision = sharedDecision(state);
    expect(decision?.decision).toBe('lww-override');
    expect(decision?.resolver).toBeUndefined();
    expect(state.provenance.some(entry => entry.decision === 'resolver-merged')).toBe(false);
  },
  T,
);

test(
  'case 15: same resolver with different config falls back to LWW (ambiguous nomination)',
  async () => {
    await pushMergeFixtures(['merge-la3', 'merge-config']);
    const out = join(tmp, 'merge-config');
    const state = await createMergeGroup('merge-config', out);
    // Both nominate cyanprint/merge-a but with different config — not a consensus.
    expect(await Bun.file(join(out, 'shared.txt')).text()).toBe('la3\n');
    const decision = sharedDecision(state);
    expect(decision?.decision).toBe('lww-override');
    expect(state.provenance.some(entry => entry.decision === 'resolver-merged')).toBe(false);
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
    const decision = sharedDecision(state);
    expect(decision?.decision).toBe('lww-override');
    expect(decision?.contributors).toHaveLength(3);
    expect(state.provenance.some(entry => entry.decision === 'resolver-merged')).toBe(false);
  },
  T,
);

test(
  'case 18: split resolver nominations fall back to LWW across every contributor',
  async () => {
    await pushMergeFixtures(['merge-lb2', 'merge-groups']);
    const out = join(tmp, 'merge-groups');
    const state = await createMergeGroup('merge-groups', out);
    // Helium-exact global semantics: resolution is one call per path with ALL variations
    // in scope — there is no partial per-group merging. Two nomination camps (merge-a vs
    // merge-b) ⇒ no consensus ⇒ pure LWW: the last layer (merge-lb2) wins outright.
    expect(await diffAgainstExpected(out, `${expected}/merge-groups`)).toEqual([]);
    expect(await Bun.file(join(out, 'shared.txt')).text()).toBe('lb2\n');
    const decision = sharedDecision(state);
    expect(decision?.decision).toBe('lww-override');
    expect(decision?.contributors).toHaveLength(4);
    expect(state.provenance.some(entry => entry.decision === 'resolver-merged')).toBe(false);
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
    // Version numbers are relative: case 28 already published the update-v2 folder as an
    // earlier cyanprint/update-example version; pushing update-v1 now makes "old" = v1
    // content and the next update-v2 push "new" = v2 content.
    await cyan(`push examples/templates/update-v1 --registry ${registry} --json`, publish);
    const oldVersion = await latestVersion('template', 'cyanprint', 'update-example');
    const out = join(tmp, 'registry-update');
    await resetDir(out);
    await cyan(
      `create cyanprint/update-example@${oldVersion} --registry ${registry} --trust-fixture local-registry --out ${out} --headless --answers examples/templates/update-v1/answers.json --json`,
    );
    // The CLI records the unpinned source ('cyanprint/update-example') so update can
    // float, plus the registry-assigned version so base regeneration can pin it.
    expect(await Bun.file(join(out, 'README.md')).text()).toContain('Version one.');
    const createdState = await parseState(out);
    expect(createdState.templates.find(template => template.name === 'update-example')?.version).toBe(
      String(oldVersion),
    );

    await pushExpectingVersionBump('examples/templates/update-v2', 'template', 'cyanprint', 'update-example');
    const newVersion = oldVersion + 1;
    const updateOutput = await cyan(
      `update ${out} --template cyanprint/update-example@${newVersion} --registry ${registry} --trust-fixture local-registry --headless --answers examples/templates/update-v2/answers.json --json`,
    );
    const updateReport = JSON.parse(updateOutput) as {
      status: string;
      conflicts: string[];
      updated: Array<{ ref: string; from: string; to: string }>;
    };
    expect(updateReport.status).toBe('done');
    expect(updateReport.conflicts).toEqual([]);
    expect(updateReport.updated).toEqual([
      { ref: 'cyanprint/update-example', from: String(oldVersion), to: String(newVersion) },
    ]);
    expect(await diffAgainstExpected(out, `${expected}/registry-update`)).toEqual([]);
    // The version move persists (iridium parity): the entry floats to the new version
    // and gains a history entry, while the source stays the unpinned ref.
    const state = await parseState(out);
    const entry = state.templates.find(template => template.name === 'update-example');
    expect(entry?.source).toBe('cyanprint/update-example');
    expect(entry?.version).toBe(String(newVersion));
    expect(entry?.history).toHaveLength(2);

    // Unpinned float: `update <dir>` resolves the recorded source to LATEST, applies the
    // new content, and persists the resolved version the same way.
    const floatOut = join(tmp, 'registry-update-float');
    await resetDir(floatOut);
    await cyan(
      `create cyanprint/update-example@${oldVersion} --registry ${registry} --trust-fixture local-registry --out ${floatOut} --headless --answers examples/templates/update-v1/answers.json --json`,
    );
    await cyan(
      `update ${floatOut} --registry ${registry} --trust-fixture local-registry --headless --answers examples/templates/update-v2/answers.json --json`,
    );
    expect(await Bun.file(join(floatOut, 'README.md')).text()).toContain('Version two.');
    const floatState = await parseState(floatOut);
    expect(floatState.templates.find(template => template.name === 'update-example')?.version).toBe(String(newVersion));
  },
  T,
);

test(
  'case 8: templates update when the new version deletes files (and conflicts stay in-file)',
  async () => {
    // Stage a modified template-resolver-1 and push it under the SAME name: the bumped
    // version deletes from-1.txt and rewrites force_conflict.txt.
    const oldVersion = await latestVersion('template', 'cyanprint', 'template-resolver-1');
    const staged = await stageFixture('examples/templates/template-resolver-1', join(tmp, 'push-stage'));
    await rm(join(staged, 'template/from-1.txt'));
    await writeFile(join(staged, 'template/force_conflict.txt'), 'conflict updated\n', 'utf8');
    await cyan(`push ${staged} --registry ${registry} --json`, publish);
    const newVersion = oldVersion + 1;

    // Clean project: the update applies the deletion and the rewrite without conflicts.
    const out = join(tmp, 'resolver-update');
    await resetDir(out);
    await cyan(
      `create cyanprint/template-resolver-1@${oldVersion} --registry ${registry} --trust-fixture local-registry --out ${out} --headless --json`,
    );
    expect(await Bun.file(join(out, 'from-1.txt')).exists()).toBe(true);
    await cyan(
      `update ${out} --template cyanprint/template-resolver-1@${newVersion} --registry ${registry} --trust-fixture local-registry --headless --json`,
    );
    expect(await diffAgainstExpected(out, `${expected}/resolver-update`)).toEqual([]);
    expect(await Bun.file(join(out, 'from-1.txt')).exists()).toBe(false);

    // User-edited project: the genuine conflict stays IN-FILE; the deletion still applies.
    const conflictOut = join(tmp, 'resolver-conflict');
    await resetDir(conflictOut);
    await cyan(
      `create cyanprint/template-resolver-1@${oldVersion} --registry ${registry} --trust-fixture local-registry --out ${conflictOut} --headless --json`,
    );
    await writeFile(join(conflictOut, 'force_conflict.txt'), 'user edit\n', 'utf8');
    const failure = await cyanExpectingFailure(
      `update ${conflictOut} --template cyanprint/template-resolver-1@${newVersion} --registry ${registry} --trust-fixture local-registry --headless --json`,
    );
    const report = JSON.parse(failure) as { status: string; conflicts: string[] };
    expect(report.status).toBe('conflict');
    expect(report.conflicts).toEqual(['force_conflict.txt']);
    const conflicted = await Bun.file(join(conflictOut, 'force_conflict.txt')).text();
    expect(conflicted).toContain('<<<<<<<');
    expect(conflicted).toContain('user edit');
    expect(conflicted).toContain('conflict updated');
    expect(await Bun.file(join(conflictOut, 'from-1.txt')).exists()).toBe(false);
  },
  T,
);

test(
  'case 10: templates pass forced answers to dependencies (embedded answers prefill child prompts)',
  async () => {
    const out = join(tmp, 'group-create');
    await resetDir(out);
    await cyan(
      `create cyanprint/basic-group --registry ${registry} --trust-fixture local-registry --out ${out} --headless --json`,
    );
    expect(await diffAgainstExpected(out, `${expected}/group-create`)).toEqual([]);
    // The `templates:` dictionary's embedded answers seeded the children's prompts; the
    // shared answer bubbles up and persists in state.
    expect(await readState(out)).toContain('name: Group Hello');
  },
  T,
);

// ── tri-suite: three templates, shared resolver, full upgrade story ───────────
// Fixtures: e2e/full-stack/fixtures/tri — tri-a/b/c all write shared.txt (merged by
// cyanprint/tri-merge), composed by tri-suite. v1 and v2 are sibling folders.

const triStage = join(tmp, 'tri-artifacts');
const triOut = join(tmp, 'tri-output');
let triSuiteV1 = 0;

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
    triSuiteV1 = await latestVersion('template', 'cyanprint', 'tri-suite');
    await resetDir(triOut);
    await cyan(
      `create cyanprint/tri-suite@${triSuiteV1} --registry ${registry} --trust-fixture local-registry --out ${triOut} --headless --json`,
    );
    expect(await diffAgainstExpected(triOut, `${expected}/tri-create`)).toEqual([]);
    // keep.txt is identical in v1 and v2 (base == theirs), so the git three-way merge
    // keeps the user's edit; every other file floats to v2. shared.txt itself is a
    // SAME-LAYER merge inside each generation: tri-a/b/c all write it and consensus on
    // cyanprint/tri-merge folds their lines into one file.
    await writeFile(join(triOut, 'keep.txt'), 'tri keep\nuser keep edit\n', 'utf8');
    await pushTri('v2');
    const updateOutput = await cyan(
      `update ${triOut} --template cyanprint/tri-suite@${triSuiteV1 + 1} --registry ${registry} --trust-fixture local-registry --headless --json`,
    );
    const updateReport = JSON.parse(updateOutput) as {
      status: string;
      conflicts: string[];
      updated: Array<{ ref: string; from: string; to: string }>;
    };
    expect(updateReport.status).toBe('done');
    expect(updateReport.conflicts).toEqual([]);
    expect(updateReport.updated).toEqual([
      { ref: 'cyanprint/tri-suite', from: String(triSuiteV1), to: String(triSuiteV1 + 1) },
    ]);
    expect(await Bun.file(join(triOut, 'shared.txt')).text()).toBe('a2\nb2\nc2\n');
    expect(await Bun.file(join(triOut, 'keep.txt')).text()).toBe('tri keep\nuser keep edit\n');
  },
  T,
);

test(
  'case 36: three templates with upgraded resolver merge previous VFS, updated VFS, removals, conflicts, and clean output',
  async () => {
    // Continues from case 9: full output tree (clean.txt / conflict.txt at v2, the user's
    // keep.txt edit intact), removal of remove-a.txt applied, and the upgraded pins.
    expect(await diffAgainstExpected(triOut, `${expected}/tri-update`)).toEqual([]);
    expect(await Bun.file(join(triOut, 'remove-a.txt')).exists()).toBe(false);
    // State files + provenance reflect the updated (theirs) generation: the same-layer
    // shared.txt merge ran through the consensus resolver at the new version.
    const state = await parseState(triOut);
    const shared = state.provenance.find(entry => entry.path === 'shared.txt');
    expect(shared?.decision).toBe('resolver-merged');
    expect(shared?.resolver).toBe('cyanprint/tri-merge');
    expect(shared?.contributors).toHaveLength(3);
    expect(state.files.some(file => file.path === 'remove-a.txt')).toBe(false);

    // A wholesale user rewrite of shared.txt genuinely diverges from base AND theirs:
    // the update exits non-zero and leaves standard in-file markers carrying both sides,
    // while the non-conflicting changes (removal, v2 files) still apply.
    const conflictOut = join(tmp, 'tri-conflict-output');
    await resetDir(conflictOut);
    await cyan(
      `create cyanprint/tri-suite@${triSuiteV1} --registry ${registry} --trust-fixture local-registry --out ${conflictOut} --headless --json`,
    );
    await writeFile(join(conflictOut, 'shared.txt'), 'user shared edit\n', 'utf8');
    const failure = await cyanExpectingFailure(
      `update ${conflictOut} --template cyanprint/tri-suite@${triSuiteV1 + 1} --registry ${registry} --trust-fixture local-registry --headless --json`,
    );
    const report = JSON.parse(failure) as { status: string; conflicts: string[] };
    expect(report.status).toBe('conflict');
    expect(report.conflicts).toEqual(['shared.txt']);
    const conflicted = await Bun.file(join(conflictOut, 'shared.txt')).text();
    for (const piece of ['<<<<<<<', 'user shared edit', 'a2', 'b2', 'c2']) {
      expect(conflicted).toContain(piece);
    }
    expect(await Bun.file(join(conflictOut, 'remove-a.txt')).exists()).toBe(false);
    expect(await Bun.file(join(conflictOut, 'conflict.txt')).text()).toBe('generated conflict v2\n');
  },
  T,
);

// ── composition features ──────────────────────────────────────────────────────

test(
  'case 37: embedded dependency config seeds direct children; deep influence flows via shared answer keys',
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
    // A configures ONLY its direct child B (answers.grand + deterministicState.seed);
    // B configures ONLY its direct child C (answers.parent). C's `grand` prompt is
    // answered anyway because A's answer entered the shared bag and flowed down — deep
    // influence happens via shared answer keys, not direct grandchild targeting.
    expect(await Bun.file(join(out, 'OUT.md')).text()).toBe('grand=FROM_A\n');
    expect(await Bun.file(join(out, 'PARENT.md')).text()).toBe('parent=FROM_B\n');
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
      provenance: Array<{ path: string; source: string; decision: string; segment?: string }>;
      diffs: unknown[];
    };
    expect(trace.tree.ref).toBe('cyanprint/basic-group');
    expect(trace.tree.children).toHaveLength(2);
    expect(trace.provenance.length).toBeGreaterThan(0);
    // Exactly one merge conflict in the composition: hello and with-artifacts both write
    // README.md with no consensus resolver — a tier-2 (dependency) LWW override.
    const overrides = trace.provenance.filter(entry => entry.decision === 'lww-override');
    expect(overrides).toHaveLength(1);
    expect(overrides[0]?.path).toBe('README.md');
    expect(overrides[0]?.segment).toBe('dependency');
    expect(trace.diffs.length).toBeGreaterThan(0);
  },
  T,
);
