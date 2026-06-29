import type { CyanPromptContext, CyanPrompter } from '@cyanprint/contracts';

function slug(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export default async function cyan(prompt: CyanPrompter, ctx: CyanPromptContext) {
  const owner = await prompt.text('owner', 'Artifact owner', { default: 'cyanprint' });
  const name = slug(await prompt.text('name', 'Template name', { default: 'app-template' })) || 'app-template';
  const title = await prompt.text('title', 'Template title', { default: name });
  return {
    processors: [
      {
        name: 'cyanprint/default',
        files: [{ root: 'template', glob: '**/*', type: 'Template' }],
        config: { vars: { OWNER: owner, NAME: name, TITLE: title } },
      },
    ],
  };
}
