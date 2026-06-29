# CyanPrint Searching Skill

Use this before adding or changing dependencies.

## Search Commands

```bash
cyanprint search <query>
cyanprint search --kind template <query>
cyanprint search --kind processor <query>
cyanprint search --kind plugin <query>
cyanprint search --kind resolver <query>
```

## Choosing Dependencies

- Prefer official `cyan/*` artifacts when they fit.
- Prefer a processor over local ad hoc rendering when a file type already has a stable formatter or renderer.
- Prefer a resolver over last-writer-wins when two templates write the same path intentionally.
- Prefer a plugin for deterministic finalization, such as pre-commit config, package script normalization, or idempotent Git setup.
- Avoid copying dependency behavior into this artifact unless the behavior is truly private to this artifact.
- Add dependencies to `cyan.yaml` without versions unless you intentionally need an older pinned version.
- After adding a dependency, add a test fixture that proves the dependency is invoked and that the returned artifact ref is declared.

## Search Questions

Before choosing an artifact, answer these:

- Does this template write common files such as `README.md`, ignore files, Nix, package manifests, CI, Claude/Codex/agent docs, or IDE config?
- Is there an official resolver for that path or file format?
- Is the resolver commutative for the way this template will share the file?
- Does the processor produce deterministic output from only `{ files, config }`?
- Is the plugin idempotent if it runs during create, try, update, and dependency installation?
- Does the dependency README include fixtures for the behavior you are relying on?

## Search in the Web UI

Use the registry search page for discovery and README review. Keep the URL query when sharing a dependency candidate with another agent so they see the same kind filter and query.
