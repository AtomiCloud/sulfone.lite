# Probe

`cyanprint probe` proves a template's **feature promises** against a materialized repo: each probe sabotages a sandboxed copy of the generated project the way a real defect would, then demands the repo's own quality gate turns red. A gate that stays green after sabotage is a **false green** — the verdict `missed` — and fails the run.

The same engine also runs inside `cyanprint test` as the opt-in **probe tier** (`probe: true` per case). The two entry points share one execution path and one manifest rule, so their verdicts never disagree over the same full-matrix inputs.

## Declaring features and authoring probes

A template declares features from `cyan.ts` (`features: ['tests', 'ci']`) and authors one probe definition per feature in `probes/<feature>.ts` (default-exported `ProbeDefinition`). Probe files are template authoring surface — they are never copied into generated output.

- `kind: 'baseline'` proves the healthy repo's gate is green → `proven`.
- `kind: 'mutation'` applies ONE sabotage and expects red → `caught`; green is the false green → `missed`.
- `invalid` — the experiment never ran (e.g. `probeInapplicable`, sabotage could not apply); asserts nothing and always carries a report reason.
- `broken` — failure outside the experiment (timeout, red baseline, sandbox-op failure); never silently dropped and always carries its underlying category/message.

## Standalone command

```bash
# Declaration mode: prove a materialized repo against its template's declarations.
cyanprint probe ./my-app --template ./my-template

# Explicit-source mode (probe-author debug path): you name BOTH the feature set
# and the probe source; the manifest gate is skipped.
cyanprint probe ./my-app --probes ./my-template --features features.json

# Selection (debug): one mutation plus its feature's baseline; keep the sandboxes.
cyanprint probe ./my-app --probes ./my-template --features features.json \
  --probe failing-test-reddens-gate --keep-sandbox

# Regenerate the committed probes.yaml (authoring surface, like --update-snapshots).
cyanprint probe --template ./my-template --update-manifest
```

- **Declaration mode** (`--template`): the feature set is the generation-time record of what the named `--template`'s **own install** declared, straight from the repo's persisted `.cyan_state.yaml`. Each install's history entry records the features its generation declared — dependencies included, under per-template `(template, name)` identity — so the run proves exactly that install's promises, never a sibling install's. A feature-off install recorded nothing to probe (never the template's whole profile union); a repo with no state file at all falls back to the template's profile-union derivation. Probes resolve through the fixed three-tier order (below) and the manifest gate fires.
  - **Multi-install repos:** a repo built by installing several templates (create-into-existing / update) records each install's own answers and feature attribution. Each `cyanprint probe --template <dir>` run proves **that** template's recorded promises only, so it never leaks a sibling install's feature — even when the same template ref appears both as an independent sibling install and as a dependency composed with different answers. Prove every root by running `--template` once per installed template.
  - **Template drift fails loudly:** every recorded feature must still be produced by re-deriving the install from its recorded answers (features are a deterministic function of the answers — the same invariant the manifest drift check relies on). If the template — **or any dependency it composes, in any install count** — stops declaring a feature the repo's state records, the run fails with `probe_declared_feature_drift` naming the features instead of silently proving a smaller (or empty) matrix. Features the template gained since generation are scoped out without failing: the run reflects what the materialized repo actually contains. Fix a drift failure by restoring the template the repo was generated from, regenerating the repo (`cyanprint update`) so its state matches the current template, or debugging with an explicit source (`--probes` + `--features`).
  - **Repos generated before per-install attribution:** older `.cyan_state.yaml` files carry only the flat feature union, so declaration mode falls back to intersecting it with the install's re-derived features and can attribute a dropped feature only when it cannot be a sibling install's (the probed template's own ref, or a single-install repo). In that legacy fallback a dependency's drifted-away feature in a multi-install repo is scoped out silently. One `cyanprint update` of the repo backfills the per-install attribution and closes that gap.
- **Explicit-source mode** (`--probes` + `--features`): both inputs are yours; features match the source's `probes/<name>.ts` directly. The run asserts nothing about any template's declared promises, so the manifest gate is skipped. `--features` is a JSON array of `{"template":"owner/name","name":"feature"}` identities (bare names allowed when the probe source is a template dir).
- `--feature` / `--probe` select subsets (a selected mutation implicitly includes its feature's baselines). Selection output is labelled `selection` — it is a debug view, never matrix results; verdict parity between the two entry points is defined over full matrices only.
- `--parallel <n>` bounds concurrent matrix runs; `--timeout <seconds>` sets the default per-probe timeout; `--keep-sandbox` retains the snapshot and per-run sandboxes (paths printed); `--report <file>` / `--json` emit the machine-readable run report.
- Exit code 1 on any `missed` or `broken` verdict, or any hard error.

## Test-flow probe tier

```yaml
cases:
  - name: full
    expected: expected/full
    probe: true # opt-in: drift gate + full probe matrix after validations
```

Probing is **opt-in per curated case** and layers on top of the existing validation tier (which is untouched). A probing case fails on any `missed`/`broken` verdict, a drifted or missing manifest, or any hard error; per-verdict counts and the full run report land on the case entry in `cyanprint test --json` output.

**Coverage-by-proof:** across all cases, every feature that any case's generation declares must be _proven_ by a passing `probe: true` case — and "proven" means that feature's report carries **both** a `proven` baseline (the healthy gate is green) **and** a `caught` mutation (a sabotage was detected). A baseline-only probe, or a run whose mutations only ever go `invalid`, asserts nothing about drift detection and does **not** satisfy coverage: every declared feature therefore needs at least one mutation probe that reddens its gate. Otherwise the template test fails naming the unproven features. Probe-free templates are untouched: no features, no gate, byte-identical behavior.

**Composition:** feature identity is per-template (`owner/name` + feature name). The union of ALL composed templates' features is persisted in `.cyan_state.yaml` and proven once against the final combined repo — a child template needs zero extra authoring to have its parent's promises proven, and a child that neuters a parent's gate surfaces as `missed`.

## The committed manifest (probes.yaml)

A feature-declaring template must commit a machine-generated `probes.yaml` next to `cyan.yaml` — the audit trail of what runs and where each probe came from. One rule, both entry points: when probing a template via its own declarations, the manifest is byte-compared against a regeneration first; a drifted **or missing** manifest is a hard failure with the diff printed. Regenerate with:

```bash
cyanprint probe --template <dir> --update-manifest
```

The gate is skipped in explicit-source mode and for templates declaring nothing.

## Fixed resolution order

Per feature, probes resolve in a **fixed, documented** order:

1. **Consumer-own** — the consuming template's own `probes/<feature>.ts`, for its OWN features only. A dependency's feature resolves to the DEPENDENCY's `probes/` directory, never the consumer's (no auto-shadowing; same-named features from different templates stay independent).
2. **Source template** — the feature's declaring template's probes, inherited through composition.
3. **Built-ins** — the engine's built-in library for common feature categories (`tests`, `coverage`, `lint`, `ci`).

**Explicit overrides** (`probeOverrides` in `cyan.yaml`) displace a dependency feature's probes and propagate through composition as part of the overriding template's interface. **Diamonds** resolve nearest-the-final-consumer; an equal-distance conflict is a hard error resolved by declaring an override in the final consumer. A declared feature that resolves at no tier is a hard error — declared promises must be proven, never silently skipped.

## Trust model

The probe sandbox is **state isolation, not privilege isolation**. Each run gets a fresh snapshot-forked copy of the repo so probes cannot corrupt your materialized project or each other's runs — but probe code executes with your privileges, within the exact trust boundary you already accepted by consuming the template (its `cyan.ts`, processors, and post-generation commands run on your machine too). Probing a template you would not generate from is running code you do not trust.

## Sandbox snapshots and large generated artifacts

Each matrix materializes the source once, then derives every probe sandbox from that sealed master snapshot with reflink/CoW clones when the filesystem supports them (and ordinary-copy fallback elsewhere). Git worktrees are archived from their exact committed tree; CyanPrint never recursively copies a live `.git` object store.

A definition can omit expensive paths from source materialization with `sandbox.exclude` globs. The option is additive and defaults to an empty list. Use `setup.pre` to recreate anything probes need inside the sealed snapshot:

```ts
export default {
  contractVersion: 1,
  sandbox: {
    snapshot: 'auto',
    exclude: ['node_modules/**', '.direnv/**'],
  },
  setup: {
    pre: ['bun install --frozen-lockfile'],
  },
  probes: [
    /* ... */
  ],
};
```

Ignored files are never force-added to the engine-owned Git snapshot. This keeps dependency caches available on disk when setup creates them without making Git-aware gates traverse those caches as project source.

## Deliberate decisions

- **The engine assumes nothing about the sandbox environment.** No `direnv`, no toolchain bootstrap, no env injection — the environment is inherited untouched. If the generated repo's gates need setup, that is the probe author's job (`setup.pre`/`setup.post` or inside the probe).
- **Failed gates are never auto-retried.** An intermittent verdict is a defect signal in the generated repo or the probe — retries would launder exactly the unreliability probes exist to surface. Fix the flake at its source; never suppress the verdict.
