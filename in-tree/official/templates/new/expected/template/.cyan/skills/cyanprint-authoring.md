# CyanPrint Authoring Skill

Use this when creating or editing this artifact.

- Keep `cyan.yaml`, `README.md`, and the bundled entry aligned.
- Keep runtime code local-first and deterministic.
- Templates return pure Cyan data from `cyan.ts`; do not read or write the target project directly.
- Runtime artifacts export one named function: `processor`, `plugin`, or `resolver`.
- Declare every dependency in `cyan.yaml`; returned refs must be declared.
