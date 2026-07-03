# Update

`cyanprint update <dir>` floats **every active template** in the project to its latest version:

```bash
cyanprint update my-project
```

Pick versions per template, or target one template:

```bash
cyanprint update my-project --interactive          # choose the version for each template
cyanprint update my-project --template cyan/new    # update only this template
cyanprint update my-project --template cyan/new@7  # update it to a specific version
```

`git` must be on PATH: update (and `create` into an existing project) shells out to the system `git` for the merge. No other command needs it.

## How the three-way merge works

Update never stores or replays old generated output. `.cyan_state.yaml` records only answers, versions, and deterministic state per installed template; the three merge sides are built fresh:

- **Base** — every active template re-executed at its _old_ version with its _saved_ answers and deterministic state, layered through tier-3 sibling resolution. This only reconstructs the original output because generation is deterministic — see [the pipeline](pipeline.md) for why nondeterminism would create phantom diffs here.
- **Theirs** — the _new_ template versions, reusing the saved answers. Only questions the new version adds are prompted, with prior values offered as defaults.
- **Ours** — your current files on disk, edits and all.

The three sides meet in a temporary git repository: base is committed, `current` (ours) and `incoming` (theirs) are branched, and git merges them with rename detection at a 50% similarity threshold. You get real line-level merging — template changes and your edits to different parts of the same file combine cleanly.

## Conflicts

Conflicts stay **in the file** as standard git conflict markers:

```text
 <<<<<<< current
 your edit
 =======
 the new template output
 >>>>>>> incoming
```

(The markers sit at column 1 in your files; they are indented here only so this document does not itself look conflicted to Git tooling.)

The command exits non-zero and lists every conflicted file. Resolve the markers with your normal git tooling, editor, or merge tool — there are no side files to hunt down.

Files the merge deletes are cleaned up. New state is persisted only for templates that actually changed version — and only when the merge finishes without conflicts. While markers are pending, `.cyan_state.yaml` stays at the old versions, so re-running `update` after you resolve (or abandon) the files merges from the original base again instead of treating the half-accepted output as your new baseline. When the merge is clean, the persisted provenance in `.cyan_state.yaml` reflects the latest generation.

## Post-generation commands

After a clean merge, the post-generation commands of the templates that **changed version** run over the merged working tree (children's commands first) — the same step [the pipeline](pipeline.md) runs at the end of `create`. This keeps an update's output consistent with a fresh install: if a template installs dependencies or generates a lockfile in a command, that step runs on update too, and any files it produces are recorded in `.cyan_state.yaml`. Templates whose version did not change do not re-run their commands. When the merge has conflicts, commands are skipped (they would run over marker-bearing files) and state is left untouched until you resolve and re-run.

## Resolvers never run during update

Resolvers merge **template-vs-template** output during layering (the three tiers of the pipeline) — they run inside base and theirs generation, exactly as they run during create. The git three-way merge then handles **user** edits. Do not attach a resolver to a file hoping it will merge user changes on update; git already does that, better.

## Headless and JSON

```bash
cyanprint update my-project --headless --answers answers.json
cyanprint update my-project --json
```

With `--json`, conflicts are reported machine-readably and the exit code is non-zero.
