// Refresh the vendored type contracts that ship inside generated projects.
//
// - `@cyanprint/sdk` (artifact authoring): generated artifacts resolve
//   `import type { Processor } from '@cyanprint/sdk'` against a checked-in
//   `.d.ts` (plus a tsconfig paths mapping) so authors need zero install.
//   The contract is `packages/artifact-runner/src/sdk-types.ts` verbatim.
// - `@cyanprint/probe` (probe authoring, FR19): scaffolded template projects
//   resolve `import type { ProbeDefinition } from '@cyanprint/probe'` the same
//   way. The contract is `packages/core/src/probe/probe-contract-types.ts`
//   verbatim — type-only and self-contained, so it is already a valid `.d.ts`.
//
// Emit writes to the EXPLICIT per-root destinations (see vendored-contracts.ts),
// not a glob of existing files — so a copy deleted from one root is re-created,
// keeping both meta-template copies pipeline-enforced and the emit idempotent
// (NFC3) even from a partially-missing tree.

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { VENDORED_CONTRACTS, VENDORED_ROOTS } from './vendored-contracts';

const ROOT = join(import.meta.dir, '../..');

for (const contract of VENDORED_CONTRACTS) {
  const types = await Bun.file(join(ROOT, contract.source)).text();
  let count = 0;
  for (const root of VENDORED_ROOTS) {
    for (const relativePath of contract.vendored) {
      const target = join(ROOT, root, relativePath);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, types, 'utf8');
      count += 1;
    }
  }
  console.log(`emitted ${contract.source} to ${count} vendored file(s)`);
}
