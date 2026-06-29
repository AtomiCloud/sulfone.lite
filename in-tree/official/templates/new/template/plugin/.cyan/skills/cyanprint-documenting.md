# CyanPrint Documenting Skill

Use this when updating README, examples, or docs inside this artifact. The README should let a human or agent use the artifact without reading the implementation first.

## README Structure

Include these sections in order when they apply:

1. Title and one-sentence purpose.
2. What the artifact generates or transforms.
3. Inputs: prompts, config keys, expected files, and dependency refs.
4. Outputs: generated files, renamed paths, resolver behavior, or plugin additions.
5. Dependencies and why each is declared in `cyan.yaml`.
6. Build/test commands.
7. Push command and token requirement.
8. Compatibility notes and known merge behavior.

## Writing Good Examples

- Prefer commands that work from the artifact folder.
- Show headless commands with answer files when prompts exist.
- Mention `bun run build` before `cyanprint test` if `bundledEntry` is under `dist/`.
- Keep examples copy-pasteable; avoid placeholders except for secrets like `$CYANPRINT_TOKEN`.

## Template Documentation

For templates, document:

- every prompt and default
- the folder roots copied or rendered
- processors used per root
- binary asset handling with `Copy`
- resolver expectations when files overlap with dependency templates

## Runtime Artifact Documentation

For processors, plugins, and resolvers, document:

- the exact input shape
- all config keys and defaults
- what is preserved, modified, added, or removed
- fixture names and what each fixture proves
