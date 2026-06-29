import { mkdir } from 'node:fs/promises';
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
    checksums: true,
    homebrew: true,
    scoop: true,
    nixInstallPath: true,
    nfpm: ['deb', 'rpm', 'apk', 'arch'],
  }),
);

export {};
