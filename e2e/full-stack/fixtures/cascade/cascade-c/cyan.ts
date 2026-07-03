export default async function cyan(prompt) {
  const grand = await prompt.text('grand', 'Grand');
  const parent = await prompt.text('parent', 'Parent');
  return {
    processors: [
      {
        name: 'cyan/default',
        files: [{ root: 'template', glob: '**/*', type: 'Template' }],
        config: { vars: { GRAND: grand, PARENT: parent } },
      },
    ],
  };
}
