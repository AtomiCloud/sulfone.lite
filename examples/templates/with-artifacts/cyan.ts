import type { CyanPromptContext, CyanPrompter } from '@cyanprint/contracts';

export default async function cyan(prompt: CyanPrompter, ctx: CyanPromptContext) {
  const name = await prompt.text('name', 'Project name');
  return {
    processors: [
      {
        name: 'cyan/default',
        files: [{ root: 'template', glob: '**/*', type: 'Template' }],
        config: { vars: { NAME: name } },
      },
      { name: 'cyanprint/uppercase' },
    ],
    plugins: [{ name: 'cyanprint/footer' }],
    resolvers: [{ name: 'cyanprint/keep-user', config: { paths: ['README.md'] } }],
  };
}
