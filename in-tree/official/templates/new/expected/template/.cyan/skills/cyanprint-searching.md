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
- Prefer a resolver over last-writer-wins when two templates write the same path intentionally.
- Avoid copying dependency behavior into this artifact unless the behavior is truly private to this artifact.
- Add dependencies to `cyan.yaml` without versions unless you intentionally need an older pinned version.
- After adding a dependency, add a test fixture that proves the dependency is invoked and that the returned artifact ref is declared.

## Search in the Web UI

Use the registry search page for discovery and README review. Keep the URL query when sharing a dependency candidate with another agent so they see the same kind filter and query.
