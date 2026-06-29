import type { CyanPromptContext, CyanPrompter } from '@cyanprint/contracts';

function slug(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export default async function cyan(prompt: CyanPrompter, ctx: CyanPromptContext) {
  const name =
    slug(await prompt.text('name', 'Workspace name', { default: 'cyanprint-workspace' })) || 'cyanprint-workspace';
  return {
    processors: [
      {
        name: 'cyanprint/default',
        files: [{ root: 'template', glob: '**/*', type: 'Template' }],
        config: { vars: { NAME: name } },
      },
    ],
  };
}
