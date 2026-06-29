type Prompt = {
  text(name: string, message: string, options?: { default?: string }): Promise<string>;
};

export default async function cyan(prompt: Prompt, ctx: unknown) {
  const project = await prompt.text('project', 'Project name', { default: 'Service Template App' });
  return {
    processors: [
      {
        name: 'cyan/default',
        files: [{ root: 'template', glob: '**/*', type: 'Template' }],
        config: { vars: { PROJECT: project, TITLE: 'Service Template' } },
      },
    ],
  };
}
