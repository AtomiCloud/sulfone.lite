# Update

Update compares three states:

- prior generated state from `.cyan_state.yaml`
- current user-edited project files
- target template output

Resolvers can preserve user edits or produce conflicts. Unsafe overwrites become machine-readable conflicts.

Run an update locally:

```bash
cyanprint update app --template examples/templates/update-v2 --headless --answers examples/templates/update-v2/answers.json
```

Resolvers are the deterministic part of updates. A v4 resolver merges two files at a time, receiving `{ path, config, current, next }` where `current` and `next` are `{ path, content, origin: { template, layer } }`. It returns `{ path, content }`.

CyanPrint folds N conflicting candidates (e.g. prior/current/target on update) by calling the resolver repeatedly in a deterministic order — the output of one step becomes `current` for the next. New resolvers declare `api: 2` in `cyan.yaml`; the legacy folder-fold API (`api: 1`, `{ inputDirs, outputDir, files, config }`) remains supported internally for older resolvers.

Resolver dependencies are declared in `cyan.yaml` and pinned on push, just like processors and plugins. During install or update, CyanPrint rejects returned resolver refs that were not declared.
