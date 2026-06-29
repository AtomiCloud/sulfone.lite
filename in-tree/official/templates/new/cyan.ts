import type { CyanPromptContext, CyanPrompter } from '@cyanprint/contracts';

const artifactKinds = ['template', 'processor', 'plugin', 'resolver'];

function slug(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export default async function cyan(prompt: CyanPrompter, ctx: CyanPromptContext) {
  const owner = await prompt.text('owner', 'Artifact owner', { default: 'cyan' });
  const name = slug(await prompt.text('name', 'Artifact name', { default: 'app-template' })) || 'app-template';
  const kind = await prompt.select('kind', 'Artifact kind', {
    options: artifactKinds,
    default: 'template',
  });
  const title = await prompt.text('title', 'Template title', { default: name });
  const description = await prompt.text('description', 'Artifact description', {
    default: `A CyanPrint v4 ${kind}.`,
  });
  return {
    processors: [
      {
        name: 'cyan/default',
        files: [{ root: `template/${kind}`, glob: '**/*', type: 'Template' }],
        config: {
          vars: {
            OWNER: owner,
            NAME: name,
            KIND: kind,
            TITLE: title,
            DESCRIPTION: description,
            TEST_COMMAND: kind === 'template' ? `cyanprint test . --answers answers.json` : 'cyanprint test .',
          },
          parser: {
            varSyntax: [
              ['__', '__'],
              ['{{', '}}'],
            ],
          },
        },
      },
    ],
  };
}
