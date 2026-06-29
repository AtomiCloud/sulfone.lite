# CyanPrint Authoring Skill

Use this when creating or editing this artifact. The goal is to leave the artifact deterministic, folder-first, easy to test, and easy for another agent to continue.

## Artifact Contract

- Keep `cyan.yaml`, `README.md`, `package.json`, tests, and the bundled entry aligned.
- Keep execution local-first. Do not require Docker or server-side execution.
- Declare every template, processor, plugin, and resolver dependency in `cyan.yaml`. Runtime output may only reference declared dependencies.
- Keep versions out of authored dependency refs unless intentionally pinning an older version. Push resolves omitted versions and pins them.
- Run generated code through Bun and TypeScript-compatible APIs only.

## Templates

A good template is a folder plus a small `cyan.ts` planner. It should ask focused questions, return pure data, and never write directly to the target project.

Recommended shape:

```ts
export default async function cyan(prompt) {
  const project = await prompt.text('project', 'Project name', { default: 'Trim Lines Processor App' });

  return {
    processors: [
      {
        name: 'cyan/default',
        files: [{ root: 'template', glob: '**/*', type: 'Template' }],
        config: { vars: { PROJECT: project, TITLE: 'Trim Lines Processor' } },
      },
    ],
  };
}
```

Rules for template quality:

- Put generated files under `template/`; do not inline file bodies in `cyan.ts` unless the file is tiny and dynamic by nature.
- Use `type: 'Template'` for text files that need variables. Use `type: 'Copy'` for binary assets, images, fonts, lockfiles, or any file that should not be UTF-8 rendered.
- Keep prompts deterministic. Defaults should produce a valid project without extra user input.
- Prefer one clear question over many clever ones. If a dependency template needs an answer, pass it explicitly through presets or returned template data.
- Include resolvers when multiple templates may touch the same path. Same resolver + same config should merge commutatively; no resolver should be an intentional last-writer-wins choice.

## Processors and Plugins

Processors and plugins receive `{ files, config }` and return a complete file map.

- Processors should be deterministic transforms: render, format, normalize, sort, or validate output.
- Plugins should add or make final edits after processors. Keep plugin behavior explicit and narrow.
- Never mutate hidden global state. Never read the target project directly.
- Preserve unrelated files unless the artifact is intentionally replacing them.
- If importing packages, add them to `package.json` and run `bun run build` before test or push.

## Resolvers

Resolvers receive every candidate for the same path as `{ files, config }` and return one folded result.

- Treat resolver input order as meaningful only through explicit metadata such as `origin.layer`.
- Make equal inputs idempotent.
- Document when the resolver prefers user content, generated content, latest layer, or a structured merge.
- Add fixtures for at least: clean merge, same resolver same config, different config, and no-resolver fallback when relevant.

## Build and Bundle

This scaffold includes `package.json` scripts. Use them as the default path:

```bash
bun install
bun run build
bun run test
```

`bun run build` produces the bundled entry under `dist/`. That bundle is what gets uploaded for runtime artifacts, and it is what keeps imports from packages deterministic.
