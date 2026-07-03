export default async function cyan(prompt, ctx) {
  return {
    processors: [{ name: 'cyan/default', files: [{ root: 'template', glob: '**/*', type: 'Template' }] }],
  };
}
