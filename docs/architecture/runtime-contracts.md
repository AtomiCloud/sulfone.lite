# Runtime Contracts

`cyan.yaml` owns metadata and dependency declarations.

`cyan.ts` is intentionally lightweight. It exports a default function, asks prompts through the first `prompt` argument, and returns a plain Cyan object with processors, plugins, resolvers, sub-templates, and optional command intent. File output comes from scoped archive files loaded by processors and plugins.

The normal authoring path is pure data: the script does not inline template files. It tells the CLI which artifact files to run over, and the CLI loads the extracted template archive, invokes processors/plugins one by one, then merges the final output.

`kind` belongs to the artifact itself. Dependency sections use string refs; the section supplies the dependency kind.

```yaml
cyanprint: 4
kind: template
owner: acme
name: nextjs-app
bundledEntry: cyan.ts

templates:
  - cyan/new
  - cyanprint/auth@7

processors:
  - cyan/default
  - cyanprint/eslint-fix@3

plugins:
  - cyanprint/footer

resolvers:
  - cyanprint/keep-user
```

Author refs are `{owner}/{name}` or `{owner}/{name}@{version}`. Registry versions are incremental integers. Authors may omit versions; `cyanprint push` resolves and pins exact versions.

Example:

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
    resolvers: [{ name: 'cyanprint/keep-user', config: { paths: ['README.md'] } }],
  };
}
```

`files` specs are archive scopes. `root`/`base` chooses the folder to load from the extracted artifact archive, `glob` and `exclude` filter paths inside that folder, and `type: 'Template'` decodes text for processors while `type: 'Copy'` copies bytes directly for images, fonts, and other binary assets.

Template scripts do not read archive files directly. All archive loading is owned by the CLI through processor and plugin file specs.
