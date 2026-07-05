---
name: cyanprint-probing
description: Use when writing probes for this CyanPrint template — mutation-style proofs that the repos it generates have quality gates that actually catch defects.
---

# Probing this template

If this template declares **features** (returned from `cyan.ts` as `features: ['tests', 'ci', ...]`), each one is a promise about the generated repo — "it has a real test gate", "CI actually runs the gates". Probes prove those promises: each probe **sabotages** a freshly generated repo the way a real defect would and demands the repo's own gate turns red. A gate that stays green after sabotage is a **false green** (verdict `missed`) and fails the gates.

## Where probes live

One definition file per declared feature: `probes/<feature>.ts` next to `cyan.ts`, default-exporting a `ProbeDefinition`. Probe files are part of the template's authoring surface — they are never copied into generated output.

Import the contract types from the vendored declarations (`types/cyanprint-probe.d.ts`, mapped as `@cyanprint/probe` in `tsconfig.json`). Use `import type` only — probes need zero runtime dependencies; the CyanPrint CLI is the driver:

```ts
import type { ProbeDefinition } from '@cyanprint/probe';

const definition: ProbeDefinition = {
  contractVersion: 1,
  probes: [
    {
      name: 'baseline-test-gate-green',
      description: 'The untouched repo passes its test gate.',
      kind: 'baseline',
      async run(repo) {
        const result = await repo.exec('bun test');
        if (result.exitCode !== 0) throw new Error(`test gate failed on the healthy repo: ${result.stderr}`);
      },
    },
    {
      name: 'failing-test-reddens-gate',
      description: 'A genuinely failing test must turn the test gate red.',
      kind: 'mutation',
      async run(repo) {
        await repo.patch('src/index.ts', { find: 'return value;', replace: 'return undefined as never;' });
        const result = await repo.exec('bun test');
        if (result.exitCode === 0) throw new Error('test gate stayed green with a failing test');
      },
    },
  ],
};

export default definition;
```

Two kinds: **`baseline`** proves the healthy repo's gate is green (`proven`); **`mutation`** applies ONE sabotage and expects red (`caught`; green = `missed`). Assertions are the repo's own gates run through `repo.exec` — throw on the wrong outcome.

If a probe's precondition is absent (nothing to sabotage, no gate to consult), signal **inapplicable** so the verdict is `invalid` instead of a fake result. The vendored `@cyanprint/probe` surface is **type-only** — there is no runtime helper to import — so throw a plain `Error` carrying the engine's sentinel property `cyanprintProbeInapplicable`. Define the one-line helper locally (no runtime dependency):

```ts
// Verdict `invalid`: this experiment does not apply here. No runtime import —
// the engine recognizes the `cyanprintProbeInapplicable` marker on the error.
const probeInapplicable = (reason: string): Error =>
  Object.assign(new Error(reason), { cyanprintProbeInapplicable: true });
```

## Rules that keep probes honest

- **Non-vacuous**: every mutation must assert the gate REDDENS, and pair with a baseline on the same gate. Sabotage what a user would break (source files, committed artifacts) — never rewrite the gate you then run.
- **Narrow mutations**: one fault per probe, the smallest edit that produces it. If the sabotage legitimately reddens another of THIS template's features (deleting tests also reddens `ci`), declare it in `expectedImpact: ['ci']` so the overlap is attributed instead of breaking the run.
- **Sandbox hygiene**: probes run against a sandboxed copy (`repo.*` paths are sandbox-relative; `exec` is pinned to the sandbox root). Never mutate global state, never bind fixed ports, never bake secrets into trees or probe files.
- **Environment is your job**: the engine deliberately assumes nothing about the sandbox environment. If gates need installs or setup, run them in the definition's `setup.pre` / `setup.post` or inside the probe.
- **No auto-retry — deliberately**: an intermittent verdict is a defect signal in the generated repo or the probe. Fix the flake; never wrap gates in retries and never suppress a verdict.
- **Trust model**: the sandbox is state isolation, not privilege isolation — probes run with your privileges, within the same trust boundary as consuming the template at all.

## The manifest and the gates

`probes.yaml` is the machine-generated, committed record of what runs and where each probe came from. Regenerate it whenever features, profiles, or probes change:

```bash
cyanprint probe --template . --update-manifest
```

Drift between the committed manifest and the resolved probes fails both `cyanprint test` and `cyanprint probe`.

## Running probes

- Mark at least one case per feature-declaring profile in `cyan.test.yaml` with `probe: true` — coverage-by-proof requires every declared feature to be proven by a probing case that produces BOTH a `proven` baseline AND a `caught` mutation for it — a baseline-only probe does not count, so give every feature a mutation probe. Curate profiles in **both directions** of every feature-gating answer: one that declares the feature, one without it.
- `cyanprint probe <generated-repo> --template .` proves an already materialized repo. If the template stops declaring a feature that repo's `.cyan_state.yaml` still records, the run fails with `probe_declared_feature_drift` instead of silently proving a smaller matrix — realign the template, regenerate the repo (`cyanprint update`), or fall back to the explicit-source debug loop.
- Debug loop: `cyanprint probe <repo> --probes . --features <file>` (explicit source, manifest gate skipped), plus `--probe <name>` to select one mutation (its baseline comes along), and `--keep-sandbox` to inspect the sabotaged tree. Selection output is labelled `selection` — it is a debug view, not matrix results.
- Composition is covered: features inherited from composed templates are proven against the final combined repo, so a child overwrite that neuters an inherited gate surfaces as `missed`.
