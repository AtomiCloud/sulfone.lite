# Merge And State

Generated projects contain `.cyan_state.yaml`. It stores **inputs and decisions, never old output content**.

## State shape

The state tracks **N installed templates** (multi-install out of the box):

```yaml
cyanprint: 4
templates:
  - owner: cyan
    name: new
    version: '7'
    source: cyan/new
    active: true
    installedAt: 2026-07-02T10:00:00.000Z
    history: # oldest first; last entry = current install
      - version: '6'
        time: 2026-06-01T09:00:00.000Z
        answers: { name: my-app }
        deterministicState: { port: 4180 }
      - version: '7'
        time: 2026-07-02T10:00:00.000Z
        answers: { name: my-app }
        deterministicState: { port: 4180 }
    artifacts: [] # pinned dependency artifacts with integrity
files: # paths + sha256 of the last generation
  - { path: README.md, sha256: '...' }
provenance: # persisted merge decisions (see below)
  - {
      path: package.json,
      source: cyan/new@7,
      decision: resolver-merged,
      segment: dependency,
      resolver: cyanprint/json-merge@2,
      contributors: [...],
    }
```

- Each template records `active`, `installedAt`, and a version `history` of `{ version, time, answers, deterministicState }` — answers + versions + deterministic state only, never generated file content.
- `cyanprint create` into a directory that already has state **upserts** the template (`packages/core/src/state/generated-state.ts` `upsertInstalledTemplate`): an existing entry keeps its `installedAt` slot and gains a history entry; a new template is appended.
- Pre-multi-install single-template state files are migrated in place on load (`migrateGeneratedState`).

## Provenance

Every create/update persists the full set of merge decisions to `.cyan_state.yaml` (`packages/contracts/src/runtime.ts` `Provenance`):

```ts
type Provenance = {
  path: string;
  source: string; // winning template ref
  decision: 'added' | 'resolver-merged' | 'lww-override';
  segment?: 'processor' | 'dependency' | 'sibling'; // absent for 'added'
  resolver?: string; // resolver ref actually invoked
  contributors?: FileOrigin[]; // every variation's origin
};
```

`cyanprint trace <project>` reads provenance directly from state (regeneration is only needed for isolated per-template output and diffs), and `cyan.test.yaml` `merges:` assertions are checked against it — unasserted `lww-override`s fail template tests by default.

## The three resolution tiers

Same-path output is merged during layering by `packages/core/src/merge/resolve-layers.ts` — one resolver call per conflicting path with **all** variations in scope, selected by consensus-or-LWW (every contributing template nominates the first `resolvers:` entry whose `files:` globs match; unanimous ref + config invokes the resolver once, anything else is last-write-wins recorded as `lww-override`). Byte-identical variations are not a conflict: they pass through with no decision and surface as `added`, so shared identical files (a LICENSE, an `.editorconfig`) never trip strict merge assertions:

1. **Tier 1 — processor outputs** (segment `processor`): within one template, all processor output layers; origins carry `processor: { ref, invocation }`. Plugins then transform the single own layer.
2. **Tier 2 — dependency tree** (segment `dependency`): at each template node, every child's fully merged subtree output (declaration order) plus the node's own post-plugin layer (last, so self wins LWW), resolved globally per path, recursively up the tree.
3. **Tier 3 — sibling installations** (segment `sibling`): at project level, each installed template's final output is one layer ordered by `installedAt`. Only meaningful for multi-install projects.

## Update: git three-way merge

`updateProject` (`packages/core/src/update/update-project.ts`) floats all active templates to latest (`--template` filters, `--interactive` picks versions):

- **Base** = re-execute the old versions with saved answers + deterministic state, layered through tier 3. This is why determinism matters: nondeterminism produces phantom diffs in the base.
- **Theirs** = the new versions, reusing saved answers (only new questions prompt).
- **Ours** = the working tree on disk.

`gitThreeWayMerge` (`packages/core/src/update/git-merge.ts`) commits base in a temporary repository, branches `current` (ours) and `incoming` (theirs), and merges with rename detection at 50% similarity via the system `git` (a runtime requirement of update and create-into-existing only). Conflicts stay in-file as standard `<<<<<<<` markers; the command exits non-zero listing conflicted files. There are no `.cyan_conflicts` side files.

**Resolvers never run in the three-way merge.** They merge template-vs-template output inside base/theirs generation; git merges user edits. New state is persisted only for templates that changed version, with files + provenance from the latest generation — and only when the merge is conflict-free. On conflict the merged tree (markers included) is written to disk but `.cyan_state.yaml` is not advanced and post-generation commands are skipped, so a retry after resolving re-merges from the original base instead of adopting the half-accepted incoming tree as the new baseline.

## Processor output cache

Because processors are hermetic, outputs are cached content-addressed (`packages/core/src/cache/processor-cache.ts`): key = `sha256(artifactIntegrity ‖ canonicalJSON(config) ‖ digest(input files: path + bytes + type))`, stored under `~/.cyan/cache/processor-output/<key>/`. A hit skips the invocation; `--bypass-cache` skips reads but still writes; stale entries are evicted by age. This makes repeated creates, template tests, and update's base regeneration near-instant.
