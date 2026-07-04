import type { CyanOutput } from '@cyanprint/contracts';

export default function cyan(): CyanOutput {
  return {
    features: ['tests', 'coverage', 'lint', 'ci'],
    processors: [{ name: 'cyan/default', files: [{ root: 'template', glob: '**/*', type: 'Copy' }] }],
  };
}
