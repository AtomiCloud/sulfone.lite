import type { CyanPromptContext, CyanPrompter } from '@cyanprint/contracts';

export default function cyan(prompt: CyanPrompter, ctx: CyanPromptContext) {
  return {
    processors: [
      {
        name: 'cyanprint/default',
        files: [{ root: 'template', glob: '**/*', type: 'Template' }],
      },
    ],
    resolvers: [
      { name: 'cyanprint/resolver2', config: { paths: ['.gitignore'] } },
      { name: 'cyanprint/resolver1', config: { paths: ['c1.json'], arrayStrategy: 'concat' } },
      { name: 'cyanprint/resolver1', config: { paths: ['c2.json'], arrayStrategy: 'replace' } },
      { name: 'cyanprint/resolver1', config: { paths: ['c3.json'], arrayStrategy: 'distinct' } },
    ],
  };
}
