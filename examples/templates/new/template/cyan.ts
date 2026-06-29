import type { CyanPromptContext, CyanPrompter } from '@cyanprint/contracts';

export default async function cyan(prompt: CyanPrompter, ctx: CyanPromptContext) {
  const project = await prompt.text('project', 'Project name');
  return {
    processors: [
      {
        name: 'cyanprint/default',
        files: [{ root: 'template', glob: '**/*', type: 'Template' }],
        config: { vars: { PROJECT: project } },
      },
    ],
  };
}
