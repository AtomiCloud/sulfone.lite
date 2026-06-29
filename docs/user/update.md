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

Resolvers are the deterministic part of updates. They receive:

- `files`: the versions being folded for one path
- `config`: resolver settings declared by the template

Each file entry has `{ path, content, origin: { template, layer } }`. The resolver folds that array into resolved text or `{ path, content }`.

Resolver dependencies are declared in `cyan.yaml` and pinned on push, just like processors and plugins. During install or update, CyanPrint rejects returned resolver refs that were not declared.
