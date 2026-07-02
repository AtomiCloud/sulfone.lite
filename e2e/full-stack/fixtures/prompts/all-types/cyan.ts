export default async function cyan(prompt) {
  const name = await prompt.text('name', 'Name');
  const enabled = await prompt.confirm('enabled', 'Enabled');
  const flavor = await prompt.select('flavor', 'Flavor', { options: ['vanilla', 'mocha'] });
  const toppings = await prompt.multiselect('toppings', 'Toppings', { options: ['nuts', 'sprinkles', 'cherry'] });
  const count = await prompt.number('count', 'Count');
  return {
    processors: [
      {
        name: 'cyan/default',
        files: [{ root: 'template', glob: '**/*', type: 'Template' }],
        config: {
          vars: {
            NAME: name,
            ENABLED: String(enabled),
            FLAVOR: flavor,
            TOPPINGS: toppings.join(','),
            COUNT: String(count),
          },
        },
      },
    ],
  };
}
