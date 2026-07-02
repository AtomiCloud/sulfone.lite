export default async function cyan(prompt) {
  // text — backdrop placeholder + bottom description + validation
  const project = await prompt.text('project', 'What is your project called?', {
    placeholder: 'my-shiny-app',
    description: 'Used as the H1 of the generated README.',
    validate: value => (value.trim().length >= 3 ? true : 'Give it at least 3 characters.'),
  });

  // text — regex validation re-prompts inline
  const url = await prompt.text('url', 'What is your project URL?', {
    placeholder: 'https://example.com',
    description: 'Must be a full URL; validation re-prompts until it is.',
    validate: value => (/^https?:\/\/\S+$/.test(value) ? true : 'Enter a full URL, starting with http(s)://'),
  });

  // confirm — default (press enter to keep) + description
  const isPublic = await prompt.confirm('public', 'Should this project be public?', {
    default: true,
    description: 'Controls the visibility note in the README.',
  });

  // select — option help follows the highlight; prompt description stacks beneath it
  const flavor = await prompt.select('flavor', 'Which flavor do you want?', {
    description: 'You can change this later in your config file.',
    options: [
      { value: 'minimal', label: 'Minimal', description: 'Just the essentials; bring your own tooling.' },
      { value: 'batteries', label: 'Batteries included', description: 'CI, tests, formatter, docs preconfigured.' },
      { value: 'chaos', label: 'Chaos mode', description: 'No lockfiles, no linters, no regrets.' },
    ],
    default: 'batteries',
  });

  // multiselect — option descriptions + default + validation
  const toppings = await prompt.multiselect('toppings', 'Pick your extras', {
    options: [
      { value: 'docker', description: 'Adds a Dockerfile and compose setup.' },
      { value: 'ci', description: 'GitHub Actions workflow.' },
      { value: 'docs', description: 'A docs folder with a starter page.' },
    ],
    default: ['ci'],
    validate: values => (values.length > 0 ? true : 'Pick at least one extra.'),
  });

  // number — backdrop placeholder + range validation
  const port = await prompt.number('port', 'Which port should the dev server use?', {
    placeholder: '3000',
    description: 'Unprivileged ports only.',
    validate: value => (value >= 1024 && value <= 65535 ? true : 'Port must be between 1024 and 65535.'),
  });

  return {
    processors: [
      {
        name: 'cyan/default',
        files: [{ root: 'template', glob: '**/*', type: 'Template' }],
        config: {
          vars: {
            PROJECT: project,
            URL: url,
            PUBLIC: String(isPublic),
            FLAVOR: flavor,
            TOPPINGS: toppings.join(', '),
            PORT: String(port),
          },
        },
      },
    ],
  };
}
