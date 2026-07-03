# CyanPrint v4 Simplification & Iridium-Parity Spec

Status: **FINAL** — all decisions resolved with the user (2026-07-02); amended same day (see "Amendments" at the bottom: `kind` removal, provenance persistence, verification framework stripped).

## Top goals

1. **One way to compose** — remove dynamic templates; dependencies are declared only in `cyan.yaml`. No `kind` field anywhere in dependency declarations — config or code; the declaration context implies it.
2. **One place to configure dependencies** — embed per-dependency `answers` / `deterministicState` directly in the `templates:` dictionary; delete the separate `presets:` block.
3. **Helium-exact resolvers, three tiers** — global semantics: one resolver call per conflicting path with ALL variations in scope at once (with origins), consensus-or-LWW selection. No fold/pairwise semantics anywhere. Tiers: processor outputs → dependency tree (layered VFS) → sibling installations. Runs locally (not as a server).
4. **Iridium-exact update & multi-install** — `create` into an existing project upserts the template into `.cyan_state.yaml` (multi-install out of the box); `update` floats all active templates to latest (`--interactive` to pick versions, `--template` to target one); base regenerated from recorded answers + old versions; real git three-way merge with rename detection and in-file conflict markers.
5. **Resolver observability, persisted** — every merge decision records its segment (`processor` / `dependency` / `sibling`), the resolver used, and every contributing origin (including source processor name + invocation id) — and the full set is **persisted to `.cyan_state.yaml`**, where trace and tests read it.
6. **Intentional merges** — `cyan.test.yaml` asserts per-path merge decisions; **any unasserted LWW override fails the test by default**. `ignore:` block for folder compare. Byte-for-byte comparison, excluding gitignored paths.
7. **Hermetic processors + processor-level caching** — hermeticity written into the processor definition; content-addressed output cache.
8. **Docs & skills** — emphasize the pipeline and determinism everywhere; teach authors to search before designing and to design for discoverability; documenting skill must cover all dependencies, all inputs (with meaning), and usage.

---

## 1. Remove dynamic templates

Templates may no longer be returned from `cyan.ts`. All composition is static via `cyan.yaml`.

Removal surface:

- `packages/contracts/src/script.ts` — drop `templates` from `CyanArtifactUse` / `CyanOutput`.
- `packages/core/src/create/create-project.ts` — remove the dynamic child loop, the static-vs-dynamic filter, dynamic artifact-use recording. Returning `templates` from `cyan.ts` becomes a hard, well-worded error: `templates cannot be returned from cyan.ts; declare them in cyan.yaml`.
- Docs: `docs/user/create.md` (composition section), `docs/user/artifact-authoring.md` (return-object example).
- Skills: template authoring `SKILL.md` — rewrite the Composition section (static only); template-group skill likewise.
- E2E: `e2e/full-stack/fixtures/tri/tri-suite/cyan.ts` becomes a `cyan.yaml`-declared composition; the tri-suite case is kept but re-pointed. Any other case using dynamic templates is reworked, not deleted (all 39 stay real).

Simplification bonus: with static-only children, every child generates **before** its parent's `cyan.ts`, so child answers always bubble up — the "dynamic children get answers flowing down but not back up" asymmetry disappears from code, docs, and skills.

## 2. Dependency dictionary with embedded config (replaces presets)

New `cyan.yaml` shape:

```yaml
templates:
  cyanprint/tri-a@5: {} # pinned to version 5, no config
  cyanprint/tri-b: # unpinned = latest at create; floats on update
    answers:
      flavor: batteries
    deterministicState:
      port: 4180
```

- Key: `owner/name[@version]` (lite's existing pin syntax stays — decision D2).
- Value: `{ answers?, deterministicState? }`; `{}` means "just depend on it".
- **No `kind` anywhere (amendment A1):** the `cyan.yaml` section (`templates:` / `processors:` / `plugins:` / `resolvers:`) implies the artifact kind — dependency entries are plain `owner/name[@version]` refs with no `kind` field. Code-side the same: `kind` is removed from dependency-declaration shapes (`ArtifactDependency`, artifact-use records returned from `cyan.ts`, internal keys like `kind:owner:name`) — the kind is derived from which field/section the ref sits in. Registry API internals may keep kind parameters where an endpoint needs them, but authored config and `cyan.ts` shapes never carry it.
- Semantics: the config applies to that direct child. `answers` seed the child's answer bag before it generates (so they also reach the child's own descendants through normal answer sharing). `deterministicState` seeds shared deterministic state if the key is not already present.
- The `presets:` block, the preset cascade (`presetChain`, `resolveInheritedPreset`, root-wins), and their docs/skills/e2e fixtures are removed. Cascade e2e cases are reworked to the embedded-config semantics. Direct root→grandchild targeting is dropped (decision D6): one dep = one configuring parent (global template uniqueness guarantees no conflicts); deep influence happens via shared answer keys only.
- `processors:` / `plugins:` stay as lists (their config is passed at use-time from `cyan.ts`).
- `resolvers:` become iridium-style entries with config + file globs (needed for global consensus, §4):

```yaml
resolvers:
  - ref: cyanprint/json-merge@2
    config: { strategy: deep }
    files: ['package.json', '**/*.json']
```

A list (not a dict) so the same resolver can appear twice with different config/globs; first glob match wins per path, per template.

## 3. Multi-install, update, and the three-way merge (iridium-exact)

### Multi-install (out of the box, no new command)

`cyanprint create <template> <dir>` into a directory that already has `.cyan_state.yaml` **upserts** the template into the state (iridium: `cyancoordinator/src/state/services.rs:73-83`). Project state tracks N templates, each with `active`, version history (version, time, answers, deterministicState), and files. The new template's output is layered over the existing installation via tier-3 resolution (§4), then three-way merged with local files.

### Update semantics

- `cyanprint update <dir>` — every active template goes to **latest**.
- `cyanprint update <dir> --interactive` — pick the version per template.
- `cyanprint update <dir> --template <ref>` — update only that template.
- Execution order for layering: installation time (iridium's `sort by installed_at`) — deterministic, most recently installed wins LWW at tier 3.

### The three-way merge

1. `.cyan_state.yaml` stores answers + versions + deterministic state — never old output.
2. **Base** = re-execute the _old_ version of each template with the _saved_ answers + deterministic state, layered (tier 3). Nondeterminism ⇒ phantom diffs in the base — this is why determinism is the core contract.
3. **Theirs** = execute the _new_ versions, reusing saved answers (only new questions prompt, prior values as defaults), layered (tier 3).
4. **Ours** = the user's current files on disk.
5. Merge: temporary git repository — commit base, branch `current` (ours) and `incoming` (theirs), merge with rename detection (similarity threshold 50%). Implementation: shell out to system `git` (line-level merge + rename detection for free; `git` becomes a runtime requirement of `update` only).
6. Conflicts stay **in-file as standard `<<<<<<<` markers** (decision D4); the command exits non-zero listing conflicted files. The `.cyan_conflicts/*.target` side-file mechanism and the current `plan-update.ts` per-file decision table + resolver fold are deleted.
7. Deleted-file cleanup, write, persist new state only for templates that actually changed version.

**Resolvers never run in the three-way merge** — only in layering. The authoring skill's current advice "attach a resolver to files users edit so updates merge" is wrong under this model and gets rewritten: git merge handles _user_ edits; resolvers merge _template-vs-template_ output.

## 4. Resolvers — helium-exact global semantics, three tiers, run locally

### Contract change

```ts
type FileOrigin = {
  template: string; // "owner/name@version"
  layer: number; // order within the resolution scope
  processor?: { ref: string; invocation: number }; // source processor name + invocation id (tier 1)
};
type ResolvedFile = { path: string; content: string; origin: FileOrigin };
type ResolverInput = { config: Record<string, unknown>; files: ResolvedFile[] }; // ALL variations, one call
type ResolverOutput = { path: string; content: string };
```

- One call per conflicting path, containing every variation in the tier's scope. No `current`/`next` pair, no fold; `resolver-fold.ts` is deleted.
- Official resolvers, vendored SDK types, skills, and tests all migrate to the new shape.
- Execution stays local (bundled artifact invocation), unlike helium's Docker/HTTP — same semantics, different transport.

### Selection: consensus or LWW (iridium-exact)

For each path with >1 variation, each contributing **template** nominates a resolver: the first entry in its `resolvers:` list whose `files:` globs match the path.

- **Agreed** — all contributors nominate the same resolver ref with identical config → invoke it once with all variations.
- **AllNone / NoConsensus / Ambiguous** — LWW: highest layer wins; recorded as `lww-override` provenance (a visible, assertable conflict).

### The three tiers (decision D3)

Every tier is global within its scope — one resolver call per path with all variations; the tiers exist because plugins and composition boundaries need resolved inputs.

1. **Tier 1 — processor outputs** (segment `processor`): within one template, all its processor outputs are collected; conflicts resolved globally per path (origins carry `processor.ref` + `invocation`). Then plugins transform the template's now-single own layer.
2. **Tier 2 — dependency tree** (segment `dependency`): at each template node, ALL its dependency layers (each child's fully merged subtree output, in declaration order) plus its own post-plugin layer (last ⇒ self wins LWW) form one layered VFS; conflicts resolved globally per path. Covers dep-vs-dep and dep-vs-self in one call. Applied recursively up the tree.
3. **Tier 3 — sibling installations** (segment `sibling`): at project level, each installed template's final output is one layer, ordered by installation time; conflicts resolved globally per path. Only applies to multi-install projects (single-install projects skip it).

## 5. Trace segmentation — persisted to `.cyan_state.yaml`

```ts
type Provenance = {
  path: string;
  source: string; // winning template ref
  decision: 'added' | 'resolver-merged' | 'lww-override';
  segment?: 'processor' | 'dependency' | 'sibling'; // absent for 'added'
  resolver?: string; // ref actually invoked
  contributors?: FileOrigin[]; // every variation's origin
};
```

- `processor` segment entries include the source processor's ref and invocation index for each contributor.
- **Persistence (amendment A2):** every `create` / `update` writes the full provenance set — decision, segment, resolver, contributors per path — into `.cyan_state.yaml` alongside the generation record. It is the durable record of the three-tier resolution.
- Consumers of the persisted provenance:
  - `cyanprint trace <project>` reads it directly from state (no regeneration needed for the provenance view; regeneration remains only for isolated per-template output + diffs).
  - `cyan.test.yaml` `merges:` assertions (§6) are checked against it.
- Human trace output groups by segment; `--json` carries everything.
- FR coverage entries added for the new fields.

## 6. Template testing upgrades (`cyan.test.yaml`)

```yaml
cases:
  - name: full
    answers: answers.json
    expected: expected/full
    ignore: # excluded from folder compare (discouraged; document why per entry)
      - '*.lock'
    merges: # assert merge decisions — every conflict is intentional
      - path: package.json
        decision: resolver # resolver | lww
        resolver: cyanprint/json-merge
        segment: dependency
      - path: README.md
        decision: lww
        segment: processor
    validations:
      - bun install && bun test
```

- **Byte-for-byte compare** — tree shape AND exact bytes (text and binary), excluding: `ignore:` globs and paths matched by the output's own `.gitignore`.
- **Strict by default (decision D5)** — any `lww-override` in the generation's persisted provenance (§5) that is not asserted in `merges:` **fails the test**. Authors must either attach a resolver or explicitly declare the LWW. A per-case escape hatch exists but is discouraged.
- Resolver artifact tests migrate to the global input shape (a list of variations with origins).
- The testing skill teaches: cover the meaningful combinations of answers, and assert every expected merge decision so resolver use and LWW are always intentional.

## 7. Hermetic processors + processor-level caching

**Definition (added to contracts docs + processor skills):** a processor is **hermetic** — its output is a pure function of (processor artifact version + integrity, config, input file set). No network, no clock, no randomness, no machine state. Anything random must be supplied by the template via config (sourced from deterministic state).

**Cache:**

- Key: `sha256(artifactIntegrity ‖ canonicalJSON(config) ‖ digest(input files: path + bytes + type))`.
- Value: the processor's output file set, stored under `~/.cyan/cache/processor-output/<key>/`.
- Hit → skip invocation entirely. `--bypass-cache` skips reads (still writes). Age/size-based eviction like the bundle cache.
- Payoff: repeated creates, template tests, and especially **update's base regeneration** become near-instant.

## 8. Docs & skills

- New user doc section: **The pipeline** — exact execution order (deps deepest-first → processors in declared order → tier-1 resolve → plugins → tier-2 resolve → tier-3 resolve → commands) and the determinism contract, stated as the core design principle: _same answers + deterministic state ⇒ byte-identical output_, and why update depends on it.
- **Discoverability:** document `cyanprint search`; authoring skills open with "search the registry before designing — reuse what exists, and name/describe/document your artifact so others searching for the need can find it".
- **Documenting skill (every artifact kind)** must produce: (a) every dependency used, with why; (b) every input/answer key, what it means, examples; (c) how to use it — the exact `cyanprint create/update` invocations (or how to reference the processor/plugin/resolver from a template).
- All skills updated for: no dynamic templates, no `kind` in declarations, dependency dictionary, global resolvers (+ `files:` globs), git-merge update semantics, multi-install, persisted provenance, hermetic processors.

---

## Resolved decisions (2026-07-02)

- **D1 — Multi-install:** yes, iridium parity, no new command — `create` into an existing project upserts into `.cyan_state.yaml`; `update` floats all active templates.
- **D2 — Pin syntax:** keep `owner/name@5`.
- **D3 — Resolution structure:** three tiers — processor outputs / dependency tree (layered VFS, dep-vs-dep + dep-vs-self in one global call) / sibling installations. Confirmed by user ("yes, exactly that").
- **D4 — Update conflicts:** in-file git conflict markers (iridium-exact); `.cyan_conflicts` side files removed.
- **D5 — Test strictness:** strict by default — unasserted `lww-override` fails template tests.
- **D6 — Grandchild targeting:** dropped — one dep = one configuring parent; deep influence via shared answer keys only.

## Amendments (2026-07-02, second pass)

- **A1 — No `kind` in dependency declarations** — removed from both config (`cyan.yaml` sections imply kind) and code (declaration/use types, internal keys); see §2.
- **A2 — Three-tier resolver decisions persisted** — the full provenance set is written to `.cyan_state.yaml` on every create/update; trace and test assertions read it; see §5.
- **A3 — Output verification framework stripped** — the `cyan-test.sh` / `cyanprint verify` framework is out of scope: too complicated, and it assumed users' environments (nix etc.) that cannot be assumed.

## Implementation phasing (PR sequence)

1. **PR 1 — Composition simplification:** remove dynamic templates; `templates:` dictionary with embedded config; `kind` removal (A1); delete presets/cascade; docs + skills + e2e rework; seed dance.
2. **PR 2 — Global resolvers (three tiers):** new resolver contract + `files:` globs + consensus; engine restructure; migrate official resolvers, SDK types, skills, tests; trace segmentation + provenance persistence to `.cyan_state.yaml` (§5, A2).
3. **PR 3 — Update & multi-install:** state shape (N templates + history), create-upsert, update-all/`--interactive`/`--template`, git three-way merge, delete plan-update decision table.
4. **PR 4 — Testing:** `merges:` assertions + strict default, `ignore:` block, gitignore-aware byte compare; resolver test migration.
5. **PR 5 — Hermetic processors + cache:** definition in contracts/docs/skills; content-addressed processor-output cache.
6. **PR 6 — Docs & skills sweep:** pipeline doc, determinism emphasis, discoverability, documenting-skill requirements.
