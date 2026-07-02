// Refresh the vendored `@cyanprint/sdk` type contract that ships inside generated
// artifacts. The SDK is never published to npm; generated artifacts resolve
// `import type { Processor } from '@cyanprint/sdk'` against a checked-in `.d.ts`
// (plus a tsconfig paths mapping) so authors need zero install.
//
// The contract is `packages/artifact-runner/src/sdk-types.ts` verbatim — it is
// type-only and self-contained, so it is already valid as a `.d.ts`.

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '../..');
const CONTRACT = 'packages/artifact-runner/src/sdk-types.ts';
const VENDORED_ROOTS = ['in-tree/official/templates/new', 'examples/templates/new'];
const VENDORED_GLOB = '**/types/cyanprint-sdk.d.ts';

const types = await Bun.file(join(ROOT, CONTRACT)).text();

let count = 0;
for (const root of VENDORED_ROOTS) {
  for await (const relativePath of new Bun.Glob(VENDORED_GLOB).scan({ cwd: join(ROOT, root) })) {
    await writeFile(join(ROOT, root, relativePath), types, 'utf8');
    count += 1;
  }
}

console.log(`emitted @cyanprint/sdk type contract to ${count} vendored file(s)`);
