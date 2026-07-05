// Meta-template parity gate (NFC2): the two `new` meta-template copies —
// `in-tree/official/templates/new` and `examples/templates/new` — must stay in
// lockstep for everything this epic added (the probing skill + vendored probe
// types), diverging ONLY by the pre-existing authoring/updating skill wording.
//
// A plain `diff -rq` between the roots exits 1 on that accepted baseline, which
// is not valid "passing gate" evidence. This check encodes
// the baseline: it compares every file in both roots byte-for-byte and fails
// (exit 1) on ANY divergence — a file present in only one root, or differing
// content — EXCEPT the allow-listed authoring/updating SKILL.md wording files,
// which are permitted to differ in content but must still exist in both roots.
// Green ⇒ no NEW divergence beyond the accepted baseline (exit 0, JSON summary).

import { join } from 'node:path';

const ROOT = join(import.meta.dir, '../..');
const LEFT = 'in-tree/official/templates/new';
const RIGHT = 'examples/templates/new';

// The accepted, pre-existing wording divergence: the authoring/updating skill
// docs differ per meta-template root by design. They must still EXIST in both
// roots — only their content is allowed to differ.
const CONTENT_DIVERGENCE_ALLOWED = (relativePath: string): boolean =>
  relativePath.endsWith('.claude/skills/authoring/SKILL.md') ||
  relativePath.endsWith('.claude/skills/updating/SKILL.md');

async function fileMap(root: string): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>();
  for await (const relativePath of new Bun.Glob('**/*').scan({ cwd: join(ROOT, root), onlyFiles: true, dot: true })) {
    files.set(relativePath, await Bun.file(join(ROOT, root, relativePath)).bytes());
  }
  return files;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

const left = await fileMap(LEFT);
const right = await fileMap(RIGHT);

const missingInRight: string[] = [];
const missingInLeft: string[] = [];
const unexpectedContentDiff: string[] = [];

for (const [relativePath, leftBytes] of left) {
  const rightBytes = right.get(relativePath);
  if (rightBytes === undefined) {
    missingInRight.push(relativePath);
    continue;
  }
  if (!bytesEqual(leftBytes, rightBytes) && !CONTENT_DIVERGENCE_ALLOWED(relativePath)) {
    unexpectedContentDiff.push(relativePath);
  }
}
for (const relativePath of right.keys()) {
  if (!left.has(relativePath)) {
    missingInLeft.push(relativePath);
  }
}

const problems = [
  ...missingInRight.map(path => `only in ${LEFT}: ${path}`),
  ...missingInLeft.map(path => `only in ${RIGHT}: ${path}`),
  ...unexpectedContentDiff.map(path => `content differs (not an accepted baseline file): ${path}`),
].sort();

if (problems.length > 0) {
  console.error(
    `meta-template parity broken between the two "new" copies:\n${problems.map(line => `  - ${line}`).join('\n')}\n` +
      'Both meta-template roots must carry identical probing skill + vendored types; ' +
      'only .claude/skills/{authoring,updating}/SKILL.md may differ in wording.',
  );
  process.exit(1);
}

const acceptedBaseline = [...left.keys()].filter(
  path =>
    CONTENT_DIVERGENCE_ALLOWED(path) &&
    right.has(path) &&
    !bytesEqual(left.get(path) as Uint8Array, right.get(path) as Uint8Array),
);

console.log(
  JSON.stringify({
    status: 'done',
    left: LEFT,
    right: RIGHT,
    filesCompared: left.size,
    acceptedWordingDivergence: acceptedBaseline.length,
    newDivergence: 0,
  }),
);

export {};
