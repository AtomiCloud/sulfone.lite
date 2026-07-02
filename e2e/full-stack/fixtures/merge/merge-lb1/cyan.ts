export default async function cyan(prompt, ctx) {
  return {
    processors: [{ name: 'cyan/default', files: [{ root: 'template', glob: '**/*', type: 'Template' }] }],
    resolvers: [{ name: 'cyanprint/merge-b', config: { paths: ['shared.txt'] } }],
  };
}
