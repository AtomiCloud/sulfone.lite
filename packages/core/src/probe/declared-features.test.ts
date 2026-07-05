import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import YAML from 'yaml';
import type { GeneratedState } from '@cyanprint/contracts';
import { CyanError } from '@cyanprint/contracts';
import { createProject } from '../create/create-project';
import { STATE_FILE, loadGeneratedState, writeGeneratedState } from '../state/generated-state';
import { updateProject } from '../update/update-project';
import { exists } from '../util';
import { declaredFeatureSetForRepo } from './declared-features';

// Declaration-mode feature resolution is core-owned (not a CLI helper) so it can
// be exercised directly here: the persisted `.cyan_state.yaml` union scoped to a
// named --template's own install contribution, with the feature-off and
// no-state fallbacks. The end-to-end CLI behavior (sibling scoping, same-ref
// collision, composition) lives in e2e/probe-e2e.test.ts.

let workRoot: string;
let templatesRoot: string;

const GATE_TEMPLATE = 'declfeat-gatecond';
const gateTemplateRef = { template: `cyanprint/${GATE_TEMPLATE}`, name: 'gate' };

beforeAll(async () => {
  workRoot = await mkdtemp(join(tmpdir(), 'cyanprint-declfeat-test-'));
  templatesRoot = join(workRoot, 'examples/templates');
  const dir = join(templatesRoot, GATE_TEMPLATE);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'cyan.yaml'),
    YAML.stringify({
      cyanprint: 4,
      kind: 'template',
      owner: 'cyanprint',
      name: GATE_TEMPLATE,
      bundledEntry: 'cyan.ts',
    }),
    'utf8',
  );
  // The `gate` feature is declared ONLY when the enableGate answer is true.
  await writeFile(
    join(dir, 'cyan.ts'),
    "import type { CyanPrompter } from '@cyanprint/contracts';\n" +
      'export default async function cyan(prompt: CyanPrompter) {\n' +
      "  const enableGate = await prompt.confirm('enableGate', 'Enable the gate?', { default: true });\n" +
      "  return { features: enableGate ? ['gate'] : [] };\n" +
      '}\n',
    'utf8',
  );
  // A curated profile so the no-state fallback (deriveTemplateFeatureSet) has cases.
  await writeFile(join(dir, 'cyan.test.yaml'), 'cases:\n  - name: basic\n', 'utf8');
});

afterAll(async () => {
  await rm(workRoot, { recursive: true, force: true });
});

function templateDir(): string {
  return join(templatesRoot, GATE_TEMPLATE);
}

async function materialize(name: string, answers: Record<string, unknown>): Promise<string> {
  const outDir = join(workRoot, name);
  await createProject({ template: templateDir(), outDir, headless: true, answers });
  return outDir;
}

describe('declaredFeatureSetForRepo', () => {
  test('a feature-ON install resolves to the persisted union scoped to its declaration', async () => {
    // Arrange
    const repo = await materialize('repo-on', { enableGate: true });
    // Act
    const features = await declaredFeatureSetForRepo(repo, templateDir());
    // Assert
    expect(features).toEqual([gateTemplateRef]);
  });

  test('a feature-OFF install resolves to nothing to probe (present state, zero features recorded)', async () => {
    // Arrange
    const repo = await materialize('repo-off', { enableGate: false });
    // Assert (precondition): the empty union is omitted from state entirely, so
    // the feature-off repo is indistinguishable from a legacy repo by the state
    // file alone.
    const state = await Bun.file(join(repo, STATE_FILE)).text();
    expect(state).not.toContain('features:');
    // Act
    const features = await declaredFeatureSetForRepo(repo, templateDir());
    // Assert
    expect(features).toEqual([]);
  });

  test('a feature-OFF repo stays empty even after the template drifts to declare a feature for the same answers', async () => {
    // The scoping bug: a repo generated feature-OFF records nothing to probe, but
    // if the template later changes so the SAME recorded answers now declare a
    // feature, re-deriving against the current template would invent a promise
    // the materialized repo never made — a false `missed`. A present state file
    // recording zero features must resolve to [] regardless of what the current
    // template would derive.
    // Arrange
    const repo = await materialize('repo-off-drift', { enableGate: false });
    // Template drift: the feature is now declared UNCONDITIONALLY, so re-deriving
    // the repo's recorded { enableGate: false } answer would yield ['gate'].
    const drifted = join(templatesRoot, `${GATE_TEMPLATE}-alwayson`);
    await mkdir(drifted, { recursive: true });
    await writeFile(
      join(drifted, 'cyan.yaml'),
      YAML.stringify({
        cyanprint: 4,
        kind: 'template',
        owner: 'cyanprint',
        name: GATE_TEMPLATE,
        bundledEntry: 'cyan.ts',
      }),
      'utf8',
    );
    await writeFile(
      join(drifted, 'cyan.ts'),
      "import type { CyanPrompter } from '@cyanprint/contracts';\n" +
        'export default async function cyan(prompt: CyanPrompter) {\n' +
        "  await prompt.confirm('enableGate', 'Enable the gate?', { default: true });\n" +
        "  return { features: ['gate'] };\n" +
        '}\n',
      'utf8',
    );
    // Act
    const features = await declaredFeatureSetForRepo(repo, drifted);
    // Assert
    expect(features).toEqual([]);
  });

  test('a repo with no state file at all falls back to the template profile-union derivation', async () => {
    // Arrange
    const repo = join(workRoot, 'repo-nostate');
    await mkdir(repo, { recursive: true });
    expect(await exists(join(repo, STATE_FILE))).toBe(false);
    // Act
    const features = await declaredFeatureSetForRepo(repo, templateDir());
    // Assert: the profile's default answer enables the gate, so the derivation declares it.
    expect(features).toEqual([gateTemplateRef]);
  });
});

describe('declaration-mode drift guard', () => {
  // Each drifted variant lives at its OWN path with the SAME owner/name ref
  // (rather than rewriting one dir in place): the runtime's module cache keeps
  // an in-process rewrite of cyan.ts invisible, and the scenario under test is a
  // cross-process one anyway — the template a repo was generated from drifting
  // before a later `cyanprint probe --template <dir>` run. Ref identity, not
  // directory identity, is what declaration mode scopes by.
  async function writeGateTemplate(name: string, variant: string, featuresExpr: string): Promise<string> {
    const dir = join(templatesRoot, `${name}-${variant}`);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'cyan.yaml'),
      YAML.stringify({ cyanprint: 4, kind: 'template', owner: 'cyanprint', name, bundledEntry: 'cyan.ts' }),
      'utf8',
    );
    // Keep the prompt in every variant so the repo's recorded answers always
    // replay cleanly — only the declared feature set differs between variants.
    await writeFile(
      join(dir, 'cyan.ts'),
      "import type { CyanPrompter } from '@cyanprint/contracts';\n" +
        'export default async function cyan(prompt: CyanPrompter) {\n' +
        "  const enableGate = await prompt.confirm('enableGate', 'Enable the gate?', { default: true });\n" +
        `  return { features: ${featuresExpr} };\n` +
        '}\n',
      'utf8',
    );
    return dir;
  }

  test('template drift that removes a persisted feature fails loudly instead of shrinking the matrix', async () => {
    // Arrange
    const name = 'declfeat-drift';
    const original = await writeGateTemplate(name, 'v1', "enableGate ? ['gate'] : []");
    const repo = join(workRoot, 'repo-drift');
    await createProject({ template: original, outDir: repo, headless: true, answers: { enableGate: true } });
    // Drift: the template stops declaring the feature the repo's state records.
    const drifted = await writeGateTemplate(name, 'v2', '[]');
    // Act
    let caught: unknown;
    try {
      await declaredFeatureSetForRepo(repo, drifted);
    } catch (error) {
      caught = error;
    }
    // Assert
    expect(caught).toBeInstanceOf(CyanError);
    const cyanProblem = (caught as CyanError).problem;
    expect(cyanProblem.code).toBe('probe_declared_feature_drift');
    // The error names the exact recorded promise the run would have stopped proving.
    expect(cyanProblem.message).toContain(`cyanprint/${name}#gate`);
  });

  test('forward drift (a NEW template feature the repo never recorded) is scoped out without failing', async () => {
    // Arrange
    const name = 'declfeat-forward';
    const original = await writeGateTemplate(name, 'v1', "enableGate ? ['gate'] : []");
    const repo = join(workRoot, 'repo-forward');
    await createProject({ template: original, outDir: repo, headless: true, answers: { enableGate: true } });
    // The template gains a feature AFTER generation: nothing the repo recorded is
    // lost, so the run proceeds — scoped to what the repo actually contains.
    const gained = await writeGateTemplate(name, 'v2', "enableGate ? ['gate', 'extra'] : []");
    // Act
    const features = await declaredFeatureSetForRepo(repo, gained);
    // Assert
    expect(features).toEqual([{ template: `cyanprint/${name}`, name: 'gate' }]);
  });
});

describe('recorded per-install attribution (multi-install dependency drift)', () => {
  // The false-green shape the flat union could not attribute: a DEPENDENCY of
  // the probed template silently drifts its features away while the repo is
  // multi-install, so a dropped `dep#gate` is indistinguishable from a sibling
  // install's feature under intersection scoping. Per-install attribution on the
  // history entry records exactly which promises THIS install made (dependencies
  // included), so the drop is detected in any install count.
  //
  // Each template-tree VERSION lives under its own `examples/templates` root
  // (v1/v2 subtrees): composition resolution scans up from the probed template
  // dir, so probing the v2 parent resolves the v2 (drifted) dep — cross-process
  // drift without in-place rewrites (the module cache keeps those invisible).
  const DEP = 'declfeat-depdrift-dep';
  const PARENT = 'declfeat-depdrift-parent';
  const depFeatureRef = { template: `cyanprint/${DEP}`, name: 'gate' };

  async function writeTree(variant: string, depFeaturesExpr: string): Promise<string> {
    const root = join(workRoot, 'depdrift', variant, 'examples', 'templates');
    const dep = join(root, DEP);
    await mkdir(dep, { recursive: true });
    await writeFile(
      join(dep, 'cyan.yaml'),
      YAML.stringify({ cyanprint: 4, kind: 'template', owner: 'cyanprint', name: DEP, bundledEntry: 'cyan.ts' }),
      'utf8',
    );
    await writeFile(
      join(dep, 'cyan.ts'),
      "import type { CyanPrompter } from '@cyanprint/contracts';\n" +
        'export default async function cyan(_prompt: CyanPrompter) {\n' +
        `  return { features: ${depFeaturesExpr} };\n` +
        '}\n',
      'utf8',
    );
    const parent = join(root, PARENT);
    await mkdir(parent, { recursive: true });
    await writeFile(
      join(parent, 'cyan.yaml'),
      YAML.stringify({
        cyanprint: 4,
        kind: 'template',
        owner: 'cyanprint',
        name: PARENT,
        bundledEntry: 'cyan.ts',
        templates: { [`cyanprint/${DEP}`]: null },
      }),
      'utf8',
    );
    await writeFile(
      join(parent, 'cyan.ts'),
      "import type { CyanPrompter } from '@cyanprint/contracts';\n" +
        'export default async function cyan(_prompt: CyanPrompter) {\n' +
        '  return { features: [] };\n' +
        '}\n',
      'utf8',
    );
    return parent;
  }

  async function writeSidecar(): Promise<string> {
    const dir = join(workRoot, 'depdrift', 'sidecar-tmpl');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'cyan.yaml'),
      YAML.stringify({
        cyanprint: 4,
        kind: 'template',
        owner: 'cyanprint',
        name: 'declfeat-depdrift-sidecar',
        bundledEntry: 'cyan.ts',
      }),
      'utf8',
    );
    await writeFile(
      join(dir, 'cyan.ts'),
      "import type { CyanPrompter } from '@cyanprint/contracts';\n" +
        'export default async function cyan(_prompt: CyanPrompter) {\n' +
        "  return { features: ['side'] };\n" +
        '}\n',
      'utf8',
    );
    return dir;
  }

  async function materializeMultiInstall(repoName: string): Promise<{ repo: string; parentV1: string }> {
    const parentV1 = await writeTree('v1', "['gate']");
    const repo = join(workRoot, repoName);
    await createProject({ template: parentV1, outDir: repo, headless: true, answers: {} });
    // A second, unrelated root install makes the repo multi-install — the exact
    // configuration where the legacy union heuristic could not attribute drops.
    await createProject({ template: await writeSidecar(), outDir: repo, headless: true, answers: {} });
    return { repo, parentV1 };
  }

  test('the install records its own generation features (dependencies included) in state', async () => {
    // Arrange
    const { repo } = await materializeMultiInstall('repo-depdrift-recorded');
    // Act
    const state = await loadGeneratedState(repo);
    // Assert
    const parent = state.templates.find(entry => entry.name === PARENT);
    expect(parent?.history[parent.history.length - 1]?.features).toEqual([depFeatureRef]);
    // The sibling's record carries only its own feature — attribution, not the union.
    const sidecar = state.templates.find(entry => entry.name === 'declfeat-depdrift-sidecar');
    expect(sidecar?.history[sidecar.history.length - 1]?.features).toEqual([
      { template: 'cyanprint/declfeat-depdrift-sidecar', name: 'side' },
    ]);
  });

  test('a drifted dependency fails loudly in a multi-install repo instead of an empty matrix', async () => {
    // Arrange
    const { repo } = await materializeMultiInstall('repo-depdrift-drift');
    // Drift: the dependency stops declaring the feature the parent's install recorded.
    const parentV2 = await writeTree('v2', '[]');
    // Act
    let caught: unknown;
    try {
      await declaredFeatureSetForRepo(repo, parentV2);
    } catch (error) {
      caught = error;
    }
    // Assert
    expect(caught).toBeInstanceOf(CyanError);
    const cyanProblem = (caught as CyanError).problem;
    expect(cyanProblem.code).toBe('probe_declared_feature_drift');
    expect(cyanProblem.message).toContain(`cyanprint/${DEP}#gate`);
  });

  test('probing one install of a multi-install repo returns only its recorded features', async () => {
    // Arrange
    const { repo, parentV1 } = await materializeMultiInstall('repo-depdrift-scope');
    // Act
    const features = await declaredFeatureSetForRepo(repo, parentV1);
    // Assert: the dependency's promise is in scope; the sibling install's feature is not.
    expect(features).toEqual([depFeatureRef]);
  });

  test('legacy state without per-install attribution keeps the documented fallback behavior', async () => {
    // Arrange: simulate a repo generated before attribution existed: strip the
    // recorded features from every history entry (the flat union stays).
    const { repo, parentV1 } = await materializeMultiInstall('repo-depdrift-legacy');
    const state = await loadGeneratedState(repo);
    const legacy: GeneratedState = {
      ...state,
      templates: state.templates.map(template => ({
        ...template,
        history: template.history.map(({ features: _features, ...entry }) => entry),
      })),
    };
    await writeGeneratedState(repo, legacy);

    // Act (undrifted)
    const undrifted = await declaredFeatureSetForRepo(repo, parentV1);
    // Assert: the intersection heuristic still scopes to the install's own graph.
    expect(undrifted).toEqual([depFeatureRef]);

    // Arrange (drifted dependency in a multi-install repo)
    const parentV2 = await writeTree('v2-legacy', '[]');
    // Act
    const drifted = await declaredFeatureSetForRepo(repo, parentV2);
    // Assert: the flat union genuinely cannot attribute the drop, so the legacy
    // fallback stays silent — the documented pre-attribution hole that `cyanprint
    // update` closes by backfilling.
    expect(drifted).toEqual([]);
  });

  test('one update backfills attribution for a legacy repo, closing the dependency-drift hole', async () => {
    // Arrange: strip attribution to simulate a legacy repo.
    const { repo, parentV1 } = await materializeMultiInstall('repo-depdrift-backfill');
    const state = await loadGeneratedState(repo);
    const legacy: GeneratedState = {
      ...state,
      templates: state.templates.map(template => ({
        ...template,
        history: template.history.map(({ features: _features, ...entry }) => entry),
      })),
    };
    await writeGeneratedState(repo, legacy);
    // Act: a same-version, same-answer update against the UNDRIFTED template — the
    // only change is the missing attribution, which the changed-predicate treats as
    // a regeneration change so the history entry advances and records it.
    const update = await updateProject({ projectDir: repo, headless: true });
    // Assert: the update backfilled the per-install attribution.
    expect(update.status).toBe('done');
    const backfilled = await loadGeneratedState(repo);
    const parent = backfilled.templates.find(entry => entry.name === PARENT);
    expect(parent?.history[parent.history.length - 1]?.features).toEqual([depFeatureRef]);

    // Arrange: with attribution restored, re-point the install at a drifted template.
    const parentV2 = await writeTree('v2-backfill', '[]');
    // Act: the multi-install dependency drift now surfaces.
    let caught: unknown;
    try {
      await declaredFeatureSetForRepo(repo, parentV2);
    } catch (error) {
      caught = error;
    }
    // Assert: it fails loudly with the drift problem code.
    expect(caught).toBeInstanceOf(CyanError);
    expect((caught as CyanError).problem.code).toBe('probe_declared_feature_drift');
  });
});

describe('same-ref sibling attribution (zero-feature root install)', () => {
  // The false-drift shape per-install attribution must NOT mistake for drift: a
  // zero-feature ROOT install of `shared` (enableGate:false → declares nothing)
  // coexists with a SIBLING `parent` install that composes the SAME `shared` ref
  // with feature-enabling answers, so `shared#gate` lands in the flat union via
  // the sibling — never via the root install. Probing the root install must
  // resolve to [] (it promised nothing), not throw same-ref drift for a feature
  // a sibling contributed. The signal that separates this from genuine legacy
  // state: the sibling carries per-install `features`, so the state is modern and
  // the root install's omitted `features` is an explicit zero-feature record.
  const SHARED = 'sameref-shared';
  const PARENT = 'sameref-parent';

  async function writeSharedAndParent(): Promise<{ root: string; sharedDir: string; parentDir: string }> {
    const root = join(workRoot, 'sameref', 'examples', 'templates');
    const sharedDir = join(root, SHARED);
    await mkdir(sharedDir, { recursive: true });
    await writeFile(
      join(sharedDir, 'cyan.yaml'),
      YAML.stringify({ cyanprint: 4, kind: 'template', owner: 'cyanprint', name: SHARED, bundledEntry: 'cyan.ts' }),
      'utf8',
    );
    // `gate` is declared only when enableGate is true (default true), so the root
    // install (enableGate:false) declares nothing while the parent's composition
    // (default answers) declares gate.
    await writeFile(
      join(sharedDir, 'cyan.ts'),
      "import type { CyanPrompter } from '@cyanprint/contracts';\n" +
        'export default async function cyan(prompt: CyanPrompter) {\n' +
        "  const enableGate = await prompt.confirm('enableGate', 'Enable the gate?', { default: true });\n" +
        "  return { features: enableGate ? ['gate'] : [] };\n" +
        '}\n',
      'utf8',
    );
    const parentDir = join(root, PARENT);
    await mkdir(parentDir, { recursive: true });
    await writeFile(
      join(parentDir, 'cyan.yaml'),
      YAML.stringify({
        cyanprint: 4,
        kind: 'template',
        owner: 'cyanprint',
        name: PARENT,
        bundledEntry: 'cyan.ts',
        templates: { [`cyanprint/${SHARED}`]: null },
      }),
      'utf8',
    );
    await writeFile(
      join(parentDir, 'cyan.ts'),
      "import type { CyanPrompter } from '@cyanprint/contracts';\n" +
        'export default async function cyan(_prompt: CyanPrompter) {\n' +
        '  return { features: [] };\n' +
        '}\n',
      'utf8',
    );
    return { root, sharedDir, parentDir };
  }

  test('a zero-feature root install returns [] even when a sibling contributes the same ref to the flat union', async () => {
    // Arrange: a feature-OFF root install of `shared`, then a sibling `parent`
    // install that composes `shared` with feature-enabling (default) answers.
    const { sharedDir, parentDir } = await writeSharedAndParent();
    const repo = join(workRoot, 'repo-sameref');
    await createProject({ template: sharedDir, outDir: repo, headless: true, answers: { enableGate: false } });
    await createProject({ template: parentDir, outDir: repo, headless: true, answers: {} });

    // Assert (state precondition): the flat union carries the sibling-contributed
    // `shared#gate`, but the root `shared` install's history recorded no features.
    const state = await loadGeneratedState(repo);
    expect(state.features).toEqual([{ template: `cyanprint/${SHARED}`, name: 'gate' }]);
    const sharedInstall = state.templates.find(entry => entry.name === SHARED);
    expect(sharedInstall?.history[sharedInstall.history.length - 1]?.features).toBeUndefined();
    const parentInstall = state.templates.find(entry => entry.name === PARENT);
    expect(parentInstall?.history[parentInstall.history.length - 1]?.features).toEqual([
      { template: `cyanprint/${SHARED}`, name: 'gate' },
    ]);

    // Act: probe the zero-feature root install of `shared`.
    const features = await declaredFeatureSetForRepo(repo, sharedDir);

    // Assert: it promised nothing, so declaration mode resolves to [] rather than
    // throwing same-ref drift for the sibling's `shared#gate`.
    expect(features).toEqual([]);
  });
});
