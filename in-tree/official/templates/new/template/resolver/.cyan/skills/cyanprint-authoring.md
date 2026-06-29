# CyanPrint Authoring Skill

Use this when creating or editing this artifact. The goal is to leave the artifact deterministic, folder-first, easy to test, resolver-friendly, and easy for another agent to continue.

## Artifact Contract

- Keep `cyan.yaml`, `README.md`, `package.json`, tests, and the bundled entry aligned.
- Keep execution local-first. Do not require Docker or server-side execution.
- Declare every template, processor, plugin, and resolver dependency in `cyan.yaml`. Runtime output may only reference declared dependencies.
- Keep versions out of authored dependency refs unless intentionally pinning an older version. Push resolves omitted versions and pins them.
- Run generated code through Bun and TypeScript-compatible APIs only.
- Keep runtime returns pure data. `cyan.ts`, processors, plugins, and resolvers should not smuggle functions in returned objects.

## Templates

A good template is a folder plus a small `cyan.ts` planner. It should ask focused questions, return pure data, and never write directly to the target project.

Recommended shape:

```ts
export default async function cyan(prompt) {
  const project = await prompt.text('project', 'Project name', { default: '__TITLE__ App' });

  return {
    processors: [
      {
        name: 'cyan/default',
        files: [{ root: 'template', glob: '**/*', type: 'Template' }],
        config: { vars: { PROJECT: project, TITLE: '__TITLE__' } },
      },
    ],
    resolvers: [{ name: 'cyan/keep-user', config: { paths: ['README.md'] } }],
  };
}
```

Rules for template quality:

- Put generated files under `template/`; do not inline file bodies in `cyan.ts` unless the file is tiny and dynamic by nature.
- Use `type: 'Template'` for text files that need variables. Use `type: 'Copy'` for binary assets, images, fonts, lockfiles, or any file that should not be UTF-8 rendered.
- Keep prompts deterministic. Defaults should produce a valid project without extra user input.
- Prefer one clear question over many clever ones. If a dependency template needs an answer, pass it explicitly through presets or returned template data.
- Think about processors before adding files. Markdown, JSON, YAML, package manifests, Nix files, and generated code should have a deterministic processor or formatter path.
- Think about resolvers before writing common paths. Common overlap paths include `README.md`, `.gitignore`, `.dockerignore`, `.env.example`, `flake.nix`, `package.json`, `tsconfig.json`, `.github/workflows/*`, `.claude/*`, `.codex/*`, `AGENTS.md`, and other agent or IDE files.
- If a file may be touched by more than one template, either add a resolver dependency and config, or document that last-writer-wins is intentional.
- Prefer resolver-friendly structure. For lists, keep one item per line. For generated sections, use stable headings or markers. For config files, preserve sorted keys where that is the ecosystem norm.
- Keep dependency templates explicit. If this template invokes `cyan/nix`, `cyan/workspace`, `cyan/readme`, or another base template, pass deterministic answers to it and test the combined output.

## Processors

Processors receive `{ files, config }` and return a complete file map. They should behave like pure deterministic functions:

```txt
same input files + same config + same processor version => same output files
```

Processor rules:

- Do not read wall-clock time, random values, host-specific paths, environment variables, network resources, or the target project unless those values are explicit config inputs.
- Sort file paths, object keys, imports, and generated arrays when order is not semantically meaningful.
- Preserve binary files and unknown files unless the processor explicitly owns them.
- Treat config as part of the input contract. Validate config up front and fail with clear messages.
- Make output stable across platforms. Normalize newlines, path separators, and trailing whitespace intentionally.
- Add fixtures that prove input to output determinism. Run the same test twice and make sure the second run has no diff.

Good processor examples:

- Render Eta templates with a fixed `vars` object.
- Format Markdown, JSON, TypeScript, YAML, or Nix files with pinned dependencies.
- Normalize package manifests by sorting scripts and dependencies.

Bad processor examples:

- Adding `generatedAt: new Date()`.
- Reading local Git author info without config.
- Reordering file sections based on filesystem traversal order.

## Plugins

Plugins receive `{ files, config }` and return a complete file map after processors run. Use plugins for project-level finalization that is still deterministic and idempotent.

Plugin rules:

- A plugin must be safe to run twice. The second run should not duplicate lines, sections, hooks, or files.
- Prefer file-map edits over shell commands. If a command is needed, document it and make it optional or validated.
- Use plugins for narrow final steps such as adding pre-commit config, initializing Git metadata idempotently, adding CI helper files, or running a declared formatting command.
- For pre-commit behavior, prefer generating `.pre-commit-config.yaml` plus a validation command such as `pre-commit run --all-files`. Do not assume the host already has hooks installed.
- For Git initialization, only create missing files or config. Never overwrite user remotes, branches, ignored files, or identity.
- Record every plugin side effect in README and tests.

## Resolvers

Resolvers receive every candidate for the same path as `{ files, config }` and return one folded result.

Resolver rules:

- Design the resolver as a fold over an array of candidates, not as a special two-file merge.
- Make equal inputs idempotent.
- Make the merge commutative when the resolver claims order does not matter. `fold([a, b, c])` should match `fold([c, a, b])` for unordered config.
- If order matters, make the order source explicit through metadata such as `origin.layer`, `origin.template`, or `origin.version`, then document that policy.
- Document when the resolver prefers user content, generated content, latest layer, or a structured merge.
- Keep resolver config small, serializable, and comparable. Same resolver plus same config is what allows CyanPrint to merge instead of reporting a resolver mismatch.
- Add fixtures for at least: clean merge, repeated identical input, reversed input order, three or more candidates, different config, and no-resolver fallback when relevant.

Resolver-friendly file design:

- Markdown: stable headings and bounded generated sections.
- Ignore files: sorted unique lines with comments preserved when possible.
- JSON/YAML/package files: parse and merge structurally, then emit stable sorted output.
- Nix files: prefer isolated imports/modules over editing one large expression.
- Agent docs: append or merge named sections, never rely on vague prose matching.

## Build and Bundle

This scaffold includes `package.json` scripts. Use them as the default path:

```bash
bun install
bun run build
bun run test
```

`bun run build` produces the bundled entry under `dist/`. That bundle is what gets uploaded for runtime artifacts, and it is what keeps imports from packages deterministic.
