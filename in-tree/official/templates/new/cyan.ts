import type { CyanPromptContext, CyanPrompter } from '@cyanprint/contracts';

function slug(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export default async function cyan(prompt: CyanPrompter, ctx: CyanPromptContext) {
  const owner = await prompt.text('owner', 'Who owns this artifact?', {
    default: 'cyan',
    placeholder: 'acme',
    description: 'Your registry username; published artifacts live under owner/name.',
  });
  const name =
    slug(
      await prompt.text('name', 'What should this artifact be called?', {
        default: 'app-template',
        placeholder: 'my-app-template',
        description: 'Lowercase letters, numbers, and dashes; becomes the registry name.',
        validate: value => (slug(value).length > 0 ? true : 'Please use at least one letter or number.'),
      }),
    ) || 'app-template';
  const kind = await prompt.select('kind', 'Which kind of artifact are you creating?', {
    options: [
      { value: 'template', description: 'Asks questions and generates a project from template files.' },
      { value: 'processor', description: 'Transforms generated files, like variable rendering or formatting.' },
      { value: 'plugin', description: 'Post-processes the merged output and can run commands.' },
      { value: 'resolver', description: 'Merges same-path files at create time and during updates.' },
    ],
    default: 'template',
  });
  const title = await prompt.text('title', 'What is the human-friendly title?', {
    default: name,
    placeholder: 'My App Template',
  });
  const description = await prompt.text('description', 'Describe this artifact in one line.', {
    default: `A CyanPrint v4 ${kind}.`,
    placeholder: 'Scaffolds a Bun service with CI and tests.',
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
          },
          parser: {
            varSyntax: [
              ['@@', '@@'],
              ['__', '__'],
            ],
          },
        },
      },
    ],
  };
}
