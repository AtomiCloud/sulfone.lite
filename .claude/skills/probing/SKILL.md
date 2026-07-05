---
name: probing
description: Writing and running CyanPrint probes — mutation-style proof that a generated repo's quality gates actually catch defects. Use when authoring probes, declaring features, curating probing profiles, or diagnosing probe verdicts.
invocation:
  - probe
  - probes
  - probing
  - false-green
  - mutation-testing
---

# Probing — proving promises instead of trusting green

A CyanPrint template that generates "a repo with CI, tests, lint, and coverage" is making a **promise**. A green gate is not proof of that promise: a gate can be green because it works, or because it silently checks nothing. Probes are the proof. A probe **sabotages** a freshly generated repo the way a real defect would and then demands the repo's own gate turns red. If the gate stays green after the sabotage, the promise was false — that is the **false green** this whole system exists to catch, and the verdict is `missed`.

This is mutation testing aimed at _generated projects_: the mutations target the repo the template produced, and the assertions are the repo's own quality gates.

## The six false-green modes (the canonical catalogue)

Every one of these has shipped in the wild. When you wonder "what is worth probing?", start here:

1. **Neutered CI script** — `ci.sh` exits 0 on a fast path before ever invoking a gate. Every individual gate works; the chain runs none of them.
2. **Vacuous coverage ledger** — the coverage gate compares against a committed ledger nobody regenerates; hand-editing the ledger satisfies the gate.
3. **Child breaks the parent's promise** — a composed child template overwrites (LWW) the parent's gate script with a stub; the parent's promise silently dies in composition. Probes catch this because the parent's features are proven against the **final combined repo**, not the parent in isolation.
4. **Zero-test pass** — the test gate passes when the suite collects zero tests, so deleting the whole suite stays green.
5. **Swallowed exit code** — the gate runs the tests but discards the failing exit code (`cmd || true`, missing `set -e`, unchecked `$?`).
6. **Degraded update path** _(deferred mode, kept as motivation)_ — an update float leaves the repo with gates that still pass but no longer check what the fresh generation's gates checked. Probing after `cyanprint update` is the future-proofing rationale for keeping probes runnable against ANY materialized repo.

## Anatomy of a probe

One definition file per declared feature: `probes/<feature>.ts` next to `cyan.ts`, default-exporting a `ProbeDefinition`. Two probe kinds:

- **`baseline`** — proves the healthy repo's gate is green (`proven`). A red baseline means the fixture/template itself is broken (`broken` — the run is untrusted).
- **`mutation`** — applies ONE sabotage and expects the gate to redden (`caught`). A green gate after the sabotage is the false green (`missed`).

```ts
import type { ProbeDefinition } from '@cyanprint/contracts';

const definition: ProbeDefinition = {
  contractVersion: 1,
  probes: [
    {
      name: 'baseline-test-gate-green',
      description: 'The untouched repo passes its test gate.',
      kind: 'baseline',
      async run(repo) {
        const result = await repo.exec('bash scripts/test-gate.sh');
        if (result.exitCode !== 0) throw new Error(`test gate failed on the healthy repo: ${result.stderr}`);
      },
    },
    {
      name: 'failing-test-reddens-gate',
      description: 'A genuinely failing test must turn the test gate red.',
      kind: 'mutation',
      expectedImpact: ['ci'],
      async run(repo) {
        await repo.patch('src/calc.js', { find: 'return left + right;', replace: 'return left - right;' });
        const result = await repo.exec('bash scripts/test-gate.sh');
        if (result.exitCode === 0) throw new Error('test gate stayed green with a failing test');
      },
    },
  ],
};

export default definition;
```

Assertions are written in the repo's own idiom — run the repo's gates via `repo.exec` and throw on the wrong outcome. The engine prescribes no assertion helpers. Verdicts: `proven` / `caught` / `missed` (the false green) / `invalid` (the experiment never ran — throw `probeInapplicable(reason)` when a precondition is absent) / `broken` (failure outside the experiment: timeouts, red baselines, sandbox-op failures).

## What is worth sabotaging — and when to add a probe

Sabotage the things the template _promises_, through the defect classes users actually produce: break a source function, delete the test suite, hand-edit a generated ledger or lockfile, introduce a lint violation, stub out a gate script. Do not probe incidental implementation details of the template.

**When to run probes:** every curated profile that declares features should have at least one `probe: true` test case — coverage-by-proof enforces that every declared feature is _proven_ by a probing case, where "proven" means the feature's report shows **both** a `proven` baseline (healthy gate green) **and** a `caught` mutation (a sabotage detected). A baseline alone does not count: a feature whose only probe checks the healthy repo never exercises the drift-detection path, so every declared feature needs at least one mutation probe that reddens its gate. **When to add one:** any time a defect slips through a generated repo's gate in the wild, write the probe that would have caught it before (or alongside) fixing the gate. The catalogue above started exactly that way.

## Writing non-vacuous probes

A probe that cannot fail proves nothing:

- Every mutation must assert the gate REDDENS — a mutation that only checks "the command ran" is vacuous.
- Pair every mutation with a baseline on the same gate. If the baseline is not green, redness after sabotage means nothing.
- Prefer sabotage via the same surface a user would break (source files, committed artifacts), not by rewriting the gate itself — a probe that edits the gate it then runs is testing its own edit.
- `repo.patch` fails loudly when the `find` text is missing: if the template's output drifts, the probe turns `broken`/`invalid` instead of silently asserting nothing.

## Narrow mutations and attribution hygiene

Each matrix run carries exactly ONE mutation; every other feature's baselines run alongside as in-run controls. Keep mutations narrow — one fault, the smallest edit that produces it. When a sabotage legitimately reddens ANOTHER feature's gate (deleting tests also reddens `ci`'s chained gate), declare it in `expectedImpact: [...]`. That is the attribution carrier: without it a red control marks the run `broken`; with it, overlap is expected and attributed. `expectedImpact` names are scoped to the probe's own source template — same-named features from other templates never collapse together.

## Sandbox and state hygiene

Probes run against a **sandboxed copy** of the generated repo — but the sandbox is _state isolation, not privilege isolation_ (see the trust model below). Author probes accordingly:

- Touch only the sandbox: use `repo.read/write/remove/patch/glob/exec` (cwd is pinned to the sandbox root). Never mutate global state — no writes to `$HOME`, no global installs, no `git config --global`.
- No fixed ports: gates that bind a port must pick ephemeral ones, or the parallel run matrix will flake.
- No secrets baked into generated trees or probe files — probe files travel with the template.
- **Environment loading is the author's job**: the engine deliberately assumes nothing about the sandbox environment (no `direnv`, no `nvm`, no toolchain setup). If the repo's gates need setup, run it in the definition's `setup.pre`/`setup.post` phases or inside the probe. This is a recorded, deliberate decision — do not wait for the engine to do it.
- Declare `sandbox.preserve` for dependency caches worth keeping across snapshot restores; declare `sandbox.snapshot: 'git' | 'fs'` only when 'auto' is wrong for the tree.

## The trust model — read this before probing third-party templates

The sandbox exists so probes cannot corrupt YOUR materialized repo between runs. It does **not** confine what probe code may do with your privileges: probes are code and run within the same trust boundary as consuming the template itself (its `cyan.ts`, processors, and post-generation commands already run on your machine). Probing a template you would not generate from is running code you do not trust.

## Profile curation — exercising feature gating in both directions

The engine proves the features a generation **declares**; it deliberately does not enforce _which_ profiles you curate. That authoring practice is yours: for every answer that gates a feature on and off, curate probing profiles in **both directions** — one whose generation declares the feature (proving the gates exist and work), and one without it (proving the feature's absence does not leave dead gates or false declarations). A feature that is only ever generated one way is a promise you have only half-proven.

## Diagnosing flaky gates

There is **no auto-retry anywhere in the probe engine — deliberately**. An intermittently red gate or probe is a defect signal (a racy test, a port collision, wall-clock coupling, network reliance) in the template's output or the probe, and retries would launder exactly the unreliability the gate is supposed to surface. Fix the flake at its source or make the probe's precondition explicit with `probeInapplicable`; never wrap it in retry loops, and never suppress the verdict.

## Running probes

- `cyanprint test <template>` with a `probe: true` case runs the drift gate + full matrix against that case's generation (opt-in per case; coverage-by-proof enforced across cases).
- `cyanprint probe <repo> --template <template-dir>` proves a materialized repo against the template's declarations (same rule, same engine). If the template stops declaring a feature the repo's `.cyan_state.yaml` still records, the run fails with `probe_declared_feature_drift` rather than silently proving a smaller matrix — realign the template, regenerate the repo (`cyanprint update`), or debug via the explicit-source path.
- `cyanprint probe <repo> --probes <dir> --features <file>` is the probe-author debug path (explicit source, manifest gate skipped).
- `--feature` / `--probe` select subsets (a mutation pulls in its baseline); selection is labelled `selection` — it is a debug view, never matrix results. `--keep-sandbox` retains sandboxes for inspection.
- `cyanprint probe --template <dir> --update-manifest` regenerates the committed `probes.yaml`; drift between the manifest and resolved probes fails both entry points.
