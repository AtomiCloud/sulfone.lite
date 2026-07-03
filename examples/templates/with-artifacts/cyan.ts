import type { CyanPromptContext, CyanPrompter } from '@cyanprint/contracts';

export default async function cyan(prompt: CyanPrompter, ctx: CyanPromptContext) {
  const name = await prompt.text('name', 'Project name');
  return {
    // Processors are hermetic: each invocation sees only its declared file scopes,
    // so the two processors work on disjoint roots and never conflict.
    processors: [
      {
        name: 'cyan/default',
        files: [{ root: 'template', glob: '**/*', type: 'Template' }],
        config: { vars: { NAME: name } },
      },
      {
        name: 'cyanprint/uppercase',
        files: [{ root: 'upper', glob: '**/*', type: 'Template' }],
      },
    ],
    plugins: [{ name: 'cyanprint/footer' }],
  };
}
