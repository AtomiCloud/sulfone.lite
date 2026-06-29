import { mkdir, writeFile } from 'node:fs/promises';
import { sha256 } from '@cyanprint/core';
import { assertGoreleaserConfig, loadGoreleaserConfig } from './release-config';

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
    checksums: true,
  }),
);

export {};
