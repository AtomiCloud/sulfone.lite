# Runtime Contracts

`cyan.yaml` owns metadata and dependency declarations — including **all composition**: child templates and resolvers are declared here and only here.

`cyan.ts` is intentionally lightweight. It exports a default function, asks prompts through the first `prompt` argument, and returns a plain Cyan object with `processors`, `plugins`, and optional `commands`. Returning `templates` or `resolvers` from `cyan.ts` is a hard error. File output comes from scoped archive files loaded by processors and plugins.

The normal authoring path is pure data: the script does not inline template files. It tells the CLI which artifact files to run over, and the CLI loads the extracted template archive, invokes processors/plugins one by one, then merges the final output through the three resolution tiers (see `docs/user/pipeline.md`).

`kind` belongs to the artifact itself. Dependency declarations never carry a kind — the section supplies it (`templates:` / `processors:` / `plugins:` / `resolvers:`), and the same holds in code: dependency shapes have no `kind` field; runtime internals attach kind from context where an endpoint needs it.

```yaml
cyanprint: 4
kind: template
owner: acme
name: nextjs-app
bundledEntry: cyan.ts

templates:
  cyan/new: {} # dictionary: ref -> embedded per-dependency config
  cyanprint/auth@7:
    answers:
      provider: github
    deterministicState:
      port: 4180

processors:
  - cyan/default
  - cyanprint/eslint-fix@3

plugins:
  - cyanprint/footer

resolvers:
  - ref: cyanprint/keep-user
    config: { paths: ['README.md'] }
    files: ['README.md']
```

Author refs are `{owner}/{name}` or `{owner}/{name}@{version}`. Registry versions are incremental integers. Authors may omit versions; `cyanprint push` resolves and pins exact versions. `templates:` values embed `answers` (seed the child's answer bag) and `deterministicState` (seed shared deterministic state when absent); `{}` means "just depend on it". `resolvers:` is a list of `{ ref, config, files }` entries — per path, a template's first entry whose `files:` globs match is its nomination.

Example `cyan.ts`:

```ts
export default async function cyan(prompt, ctx) {
  const name = await prompt.text('name', 'Project name', { default: 'my-app' });

  return {
    processors: [
      {
        name: 'cyan/default',
        files: [{ root: 'template', glob: '**/*', type: 'Template' }],
        config: { vars: { name } },
      },
    ],
    plugins: [{ name: 'cyanprint/footer' }],
  };
}
```

`files` specs are archive scopes. `root`/`base` chooses the folder to load from the extracted artifact archive, `glob` and `exclude` filter paths inside that folder, and `type: 'Template'` decodes text for processors while `type: 'Copy'` copies bytes directly for images, fonts, and other binary assets.

Template scripts do not read archive files directly. All archive loading is owned by the CLI through processor and plugin file specs.

## Resolver contract

A resolver is invoked **once per conflicting path**, with every variation of that path in the resolution scope:

```ts
type FileOrigin = {
  template: string; // "owner/name@version"
  layer: number; // order within the resolution scope
  processor?: { ref: string; invocation: number }; // set for tier-1 processor-output variations
};
type ResolvedFile = { path: string; content: string; origin: FileOrigin };
type ResolverInput = { config: Record<string, unknown>; files: ResolvedFile[] };
type ResolverOutput = { path: string; content: string };
```

Selection is consensus-or-LWW: every contributing template nominates from its own `resolvers:` list; unanimous ref + identical config invokes the resolver once with all variations, anything else falls back to last-write-wins (highest layer), recorded as an `lww-override` in the provenance persisted to `.cyan_state.yaml`. There is no pairwise fold, no `current`/`next`, no `api:` versioning, and no `commutative` flag. Execution is local bundled-artifact invocation.

Processors are **hermetic**: output is a pure function of (artifact version + integrity, config, input file set), which is what makes the content-addressed processor-output cache (`~/.cyan/cache/processor-output/`) sound.
