# CyanPrint Documenting Skill

Use this when updating README, examples, or docs inside this artifact. The README should let a human or agent use the artifact without reading the implementation first.

## README Structure

Include these sections in order when they apply:

1. Title and one-sentence purpose.
2. What the artifact generates, transforms, folds, or finalizes.
3. Inputs: prompts, config keys, expected files, and dependency refs.
4. Outputs: generated files, renamed paths, resolver behavior, plugin additions, or validation commands.
5. Dependencies and why each is declared in `cyan.yaml`.
6. Processor and resolver plan for files that commonly overlap.
7. Build/test commands.
8. Push command and token requirement.
9. Compatibility notes and known merge behavior.

## Writing Good Examples

- Prefer commands that work from the artifact folder.
- Show headless commands with answer files when prompts exist.
- Mention `bun run build` before `cyanprint test` if `bundledEntry` is under `dist/`.
- Keep examples copy-pasteable; avoid placeholders except for secrets like `$CYANPRINT_TOKEN`.
- Include the exact command that proves the artifact locally, not just the command that publishes it.

## Template Documentation

For templates, document:

- every prompt and default
- dependency templates and any forced answers passed to them
- the folder roots copied or rendered
- processors used per root and why each processor is needed
- binary asset handling with `Copy`
- files that commonly overlap, such as `README.md`, `.gitignore`, `.dockerignore`, `flake.nix`, package manifests, CI, Claude/Codex/agent docs, and IDE files
- resolver expectations when files overlap with dependency templates
- what happens when no resolver is declared for an overlapping path

## Processor Documentation

For processors, document:

- the exact `{ files, config }` input shape
- all config keys and defaults
- deterministic behavior guarantees
- what file types are preserved, modified, added, or removed
- package dependencies used by the bundled processor
- fixture names and what each fixture proves
- validation commands, especially parseability and formatting checks

## Plugin Documentation

For plugins, document:

- the exact `{ files, config }` input shape
- all config keys and defaults
- when the plugin runs relative to processors
- every finalizer side effect
- idempotency guarantees
- whether shell commands are required, optional, or only used for validation
- pre-commit, Git, formatter, or package-manager assumptions

## Resolver Documentation

For resolvers, document:

- the candidate array shape
- all config keys and defaults
- whether the fold is commutative
- whether duplicate inputs are idempotent
- the order policy when order matters
- how user edits, generated files, dependency layers, and template versions are prioritized
- fixture names for clean merge, reversed order, duplicate candidates, three or more candidates, conflict, and mismatched config
