import { mkdir } from 'node:fs/promises';
import { assertPortableLinuxBinary } from './portable-elf';
import { assertGoreleaserConfig, loadGoreleaserConfig } from './release-config';

await mkdir('.tmp/release', { recursive: true });
const goreleaserConfig = await loadGoreleaserConfig();
assertGoreleaserConfig(goreleaserConfig);
const goreleaser = Bun.spawnSync(['goreleaser', 'check', '.goreleaser.yaml'], {
  env: {
    ...process.env,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'remote.origin.url',
    GIT_CONFIG_VALUE_0: 'https://github.com/AtomiCloud/sulfone.lite',
  },
});
if (!goreleaser.success) {
  throw new Error(goreleaser.stderr.toString());
}
const build = Bun.spawnSync([
  'bun',
  'build',
  'packages/cli/src/main.ts',
  '--compile',
  '--outfile',
  '.tmp/release/cyanprint',
]);
if (!build.success) {
  throw new Error(build.stderr.toString());
}
const version = Bun.spawnSync(['.tmp/release/cyanprint', '--version']);
const expectedVersion = (await import('../../package.json')).version;
if (!version.success || version.stdout.toString().trim() !== `cyanprint ${expectedVersion}`) {
  throw new Error('compiled cyanprint binary did not report the exact package version without external bun');
}
// Build the host-matching linux target through GoReleaser exactly as the release does
// (bun copies its own Nix-patched runtime when target == host, then the post-build
// hook must make it portable) and assert the shipped binary has the standard ELF
// interpreter, no /nix/store RUNPATH, and runs with an empty environment.
const linuxTarget = process.platform === 'linux' ? (process.arch === 'arm64' ? 'linux-arm64' : 'linux-x64') : undefined;
if (linuxTarget) {
  const releaseBinary = '.tmp/release/goreleaser-cyanprint';
  const snapshot = Bun.spawnSync(
    ['goreleaser', 'build', '--snapshot', '--clean', '--single-target', '--output', releaseBinary],
    {
      env: {
        ...process.env,
        TARGET: linuxTarget,
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'remote.origin.url',
        GIT_CONFIG_VALUE_0: 'https://github.com/AtomiCloud/sulfone.lite',
      },
    },
  );
  if (!snapshot.success) {
    throw new Error(
      `goreleaser linux snapshot build failed: ${snapshot.stdout.toString()}${snapshot.stderr.toString()}`,
    );
  }
  await assertPortableLinuxBinary(releaseBinary);
  const portableRun = Bun.spawnSync([releaseBinary, '--version'], { env: {} });
  if (!portableRun.success || portableRun.stdout.toString().trim() !== `cyanprint ${expectedVersion}`) {
    throw new Error('goreleaser linux binary did not run with an empty environment.');
  }
}
const installDocs = await Bun.file('docs/user/install.md').text();
if (!installDocs.includes('nix profile install github:AtomiCloud/sulfone.lite#cyanprint')) {
  throw new Error('install docs missing Nix install path');
}
if (!(await Bun.file('examples/templates/nix/cyan.yaml').exists())) {
  throw new Error('nix template missing');
}

console.log(
  JSON.stringify({
    status: 'done',
    semanticRelease: true,
    goreleaserCompatible: true,
    standaloneBunCompiled: true,
    portableLinuxBinary: linuxTarget !== undefined,
    checksums: true,
    homebrew: true,
    scoop: true,
    nixInstallPath: true,
    nfpm: ['deb', 'rpm', 'apk', 'arch'],
  }),
);

export {};
