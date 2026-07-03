# The Pipeline

Every `cyanprint create` (and every base/target regeneration inside `cyanprint update`) runs the same pipeline, in the same order. Knowing the order tells you exactly where a file came from and where two files can meet.

## Execution order

1. **Dependencies, deepest-first.** Child templates declared in `cyan.yaml` `templates:` generate before their parent. Each child runs this whole pipeline for itself, so a parent always receives fully merged child output — and child answers bubble up before the parent's `cyan.ts` runs.
2. **Processors, in declared order.** The template's `cyan.ts` returns processor uses; each invocation reads only its declared `files` scopes and emits its own output layer.
3. **Tier-1 resolve (segment `processor`).** All processor output layers of one template are resolved globally per path. Origins carry the source processor ref and invocation index.
4. **Plugins.** Plugins transform the template's now-single own layer, in declared order.
5. **Tier-2 resolve (segment `dependency`).** At each template node, every child's fully merged subtree output (in declaration order) plus the template's own post-plugin layer (last, so self wins last-write-wins) form one layered virtual file system, resolved globally per path. This covers dependency-vs-dependency and dependency-vs-self in one call, recursively up the tree.
6. **Tier-3 resolve (segment `sibling`).** In multi-install projects, each installed template's final output is one layer, ordered by installation time (most recently installed wins last-write-wins). Single-install projects skip this tier trivially.
7. **Commands.** Post-generation commands run inside the generated project, children's commands first. On `create` every template's commands run; on a clean `update` only the templates that changed version re-run theirs (over the merged working tree). Files a command creates are captured in `.cyan_state.yaml` on both paths. When a merge conflicts, commands are skipped until you resolve the markers.

At every tier the resolution rule is the same: for each path with more than one variation, each contributing template nominates a resolver (the first entry in its `resolvers:` list whose `files:` globs match the path). If all contributors nominate the same resolver ref with identical config, that resolver is invoked **once** with every variation; otherwise the highest layer wins and the decision is recorded as an `lww-override`. Every decision — with segment, resolver, and contributors — is persisted to `.cyan_state.yaml` as provenance, where `cyanprint trace` and `cyan.test.yaml` `merges:` assertions read it.

## The determinism contract

The core design principle of CyanPrint v4:

> **Same answers + same deterministic state ⇒ byte-identical output.**

Templates must not read the network, the clock, randomness, or machine state during generation. Anything that varies (generated ports, slugs, IDs) must come from deterministic state, which is recorded in `.cyan_state.yaml` alongside the answers.

Processors carry the same obligation, formalized as **hermeticity**: a processor's output is a pure function of (processor artifact version + integrity, config, input file set). Hermeticity is what makes the processor output cache safe — a cache hit skips the invocation entirely because the output could not have differed.

### Why update depends on it

`cyanprint update` never stores your old generated output. Instead it **re-executes the old template versions with the saved answers and deterministic state** to rebuild the merge base, generates the new versions the same way, and three-way merges both against your working tree with git. If generation were nondeterministic, the regenerated base would differ from what was originally written to disk, and every difference would show up as a phantom diff — noise at best, spurious conflicts at worst. Determinism is what makes the base trustworthy and updates clean.

See [update.md](update.md) for the merge itself and [create.md](create.md) for composition and multi-install.
