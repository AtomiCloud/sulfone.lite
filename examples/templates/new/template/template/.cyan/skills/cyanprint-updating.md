# CyanPrint Updating Skill

Use this when changing behavior.

- Update fixtures and expected output together.
- Run `cyanprint test .` before publishing.
- For templates, run `cyanprint test . --update-snapshots` only when changed output is intended.
- For resolver behavior, include same-resolver, different-config, and no-resolver edge cases when relevant.
