import type { CyanPromptContext, CyanPrompter } from '@cyanprint/contracts';

export default function cyan(prompt: CyanPrompter, ctx: CyanPromptContext) {
  return {
    processors: [
      {
        name: 'cyan/default',
        files: [{ root: 'template', glob: '**/*', type: 'Template' }],
      },
    ],
  };
}
