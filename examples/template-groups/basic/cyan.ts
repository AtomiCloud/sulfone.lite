import type { CyanPromptContext, CyanPrompter } from '@cyanprint/contracts';

export default function cyan(prompt: CyanPrompter, ctx: CyanPromptContext) {
  const name = ctx.answers.name ?? 'Basic Group';
  return {
    processors: [
      {
        name: 'cyanprint/default',
        files: [{ root: 'template', glob: '**/*', type: 'Template' }],
        config: { vars: { NAME: name }, parser: { varSyntax: [['**', '**']] } },
      },
    ],
  };
}
