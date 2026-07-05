import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256 } from '@cyanprint/core';
import { assertGoreleaserConfig, loadGoreleaserConfig } from './release-config';
import { VENDORED_CONTRACTS, VENDORED_ROOTS } from './vendored-contracts';

// The @cyanprint/sdk and @cyanprint/probe type contracts are vendored (not
// published) into generated projects. Every checked-in copy must match its
// in-repo source of truth so author DX never drifts. Each EXPECTED destination
// is asserted per-root (see vendored-contracts.ts) — not an aggregate count —
// so deleting a copy from one meta-template root is a hard failure rather than
// being masked by the other root's copies (FR19/NFC3).
for (const contract of VENDORED_CONTRACTS) {
  const typeContract = await Bun.file(contract.source).text();
  for (const vendoredRoot of VENDORED_ROOTS) {
    for (const relativePath of contract.vendored) {
      const vendoredPath = join(vendoredRoot, relativePath);
      const vendoredFile = Bun.file(vendoredPath);
      if (!(await vendoredFile.exists())) {
        throw new Error(
          `missing vendored ${contract.name} contract: ${vendoredPath}. ` +
            'Run "bun run sdk:types:emit" and regenerate template snapshots.',
        );
      }
      if ((await vendoredFile.text()) !== typeContract) {
        throw new Error(
          `vendored ${contract.name} contract out of sync: ${vendoredPath}. ` +
            'Run "bun run sdk:types:emit" and regenerate template snapshots.',
        );
      }
    }
  }
}

const version = (await import('../../packages/cli/src/version')).VERSION;
const packageJson = await import('../../package.json');
const packageVersion = packageJson.version;
if (packageJson.name !== 'cyanprint') {
  throw new Error(`package name must be cyanprint, got ${packageJson.name}.`);
}
if (version !== packageVersion || !version.startsWith('4.')) {
  throw new Error(`cyanprint package check expected exact package v4 version ${packageVersion}, got ${version}.`);
}
assertGoreleaserConfig(await loadGoreleaserConfig());
const installDocs = await Bun.file('docs/user/install.md').text();
if (!installDocs.includes('nix profile install github:AtomiCloud/sulfone.lite#cyanprint')) {
  throw new Error('missing Nix install documentation');
}
const flake = await Bun.file('flake.nix').text();
if (!flake.includes('apps = {') || !flake.includes('program = "${packages.cyanprint}/bin/cyanprint";')) {
  throw new Error('flake must expose a cyanprint app backed by the cyanprint package');
}
const nixPackages = await Bun.file('nix/packages.nix').text();
if (!nixPackages.includes('inherit cyanprint;') || !nixPackages.includes('default = cyanprint;')) {
  throw new Error('nix packages must expose cyanprint and default install targets');
}
const packageWorkflow = await Bun.file('.github/workflows/reusable-package-release.yaml').text();
if (!packageWorkflow.includes('SCOOP_BREW_TOKEN') || !packageWorkflow.includes('FURY_TOKEN')) {
  throw new Error('package release workflow must publish through Brew/Scoop and Gemfury tokens');
}
const furyScript = await Bun.file('scripts/ci/fury.sh').text();
if (
  !furyScript.includes('push.fury.io/atomicloud') ||
  !furyScript.includes('*.deb') ||
  !furyScript.includes('*.rpm') ||
  !furyScript.includes('*.apk')
) {
  throw new Error('Gemfury upload script must publish deb/rpm/apk packages');
}

await mkdir('.tmp/package', { recursive: true });
const binaryPath = '.tmp/package/cyanprint';
const build = Bun.spawnSync(['bun', 'build', 'packages/cli/src/main.ts', '--compile', '--outfile', binaryPath]);
if (!build.success) {
  throw new Error(build.stderr.toString());
}
const versionRun = Bun.spawnSync([binaryPath, '--version']);
if (!versionRun.success || versionRun.stdout.toString().trim() !== `cyanprint ${version}`) {
  throw new Error('packaged cyanprint binary did not report the exact package version without user-installed bun');
}

// Probe execution must survive compilation (FR12/FR13). The probe runner spawns
// an isolated child; under `bun build --compile` `process.execPath` is THIS
// binary, so the runner is re-entered through the hidden subcommand instead of an
// embedded .ts path (see probe-process.ts). A `--version`-only smoke never
// exercises that spawn, so it once shipped a binary whose every probe reported
// `broken`. Drive a real probe end-to-end through the packaged binary and assert
// clean verdicts so the packaging gate now catches that regression class.
const probeRepo = '.tmp/package/probe-repo';
const gatedFixture = 'examples/templates/probe-fixture-gated';
const created = Bun.spawnSync([binaryPath, 'create', gatedFixture, '--out', probeRepo, '--headless', '--json']);
if (!created.success) {
  throw new Error(`packaged binary failed to materialize the probe fixture: ${created.stderr.toString()}`);
}
const featuresFile = '.tmp/package/probe-features.json';
await writeFile(featuresFile, JSON.stringify(['tests', 'coverage', 'lint', 'ci']), 'utf8');
const probeRun = Bun.spawnSync([
  binaryPath,
  'probe',
  probeRepo,
  '--probes',
  gatedFixture,
  '--features',
  featuresFile,
  '--json',
]);
if (!probeRun.success) {
  throw new Error(`packaged cyanprint binary could not execute probes: ${probeRun.stderr.toString()}`);
}
const probeCounts = (JSON.parse(probeRun.stdout.toString()) as { counts: Record<string, number> }).counts;
if (probeCounts.broken !== 0 || probeCounts.missed !== 0 || probeCounts.proven === 0 || probeCounts.caught === 0) {
  throw new Error(
    `packaged cyanprint binary produced degenerate probe verdicts (compiled runner spawn broken?): ${JSON.stringify(
      probeCounts,
    )}`,
  );
}
const binaryBytes = await Bun.file(binaryPath).bytes();
const checksum = sha256(binaryBytes);
await writeFile('.tmp/package/checksums.txt', `${checksum}  cyanprint\n`, 'utf8');
const checksums = await Bun.file('.tmp/package/checksums.txt').text();
if (!checksums.includes(checksum)) {
  throw new Error('package checksum file did not include compiled binary checksum');
}

console.log(
  JSON.stringify({
    status: 'done',
    packageManagers: ['homebrew', 'scoop', 'gemfury', 'deb', 'rpm', 'apk', 'arch'],
    nixInstallPath: true,
    embeddedBun: true,
    name: packageJson.name,
    binaryExecuted: true,
    probeExecuted: true,
    checksums: true,
  }),
);

export {};
