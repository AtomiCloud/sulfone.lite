import type { CyanOutput } from '@cyanprint/contracts';

export default function cyan(): CyanOutput {
  return {
    features: ['docs'],
    processors: [{ name: 'cyan/default', files: [{ root: 'template', glob: '**/*', type: 'Copy' }] }],
  };
}
