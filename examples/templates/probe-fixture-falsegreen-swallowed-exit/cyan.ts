import type { CyanOutput } from '@cyanprint/contracts';

export default function cyan(): CyanOutput {
  return {
    processors: [{ name: 'cyan/default', files: [{ root: 'template', glob: '**/*', type: 'Copy' }] }],
  };
}
