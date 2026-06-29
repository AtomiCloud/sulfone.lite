import YAML from 'yaml';

type GoreleaserConfig = {
  version?: unknown;
  project_name?: unknown;
  before?: { hooks?: unknown };
  builds?: unknown;
  archives?: unknown;
  checksum?: { name_template?: unknown };
  homebrew_casks?: unknown;
  scoops?: unknown;
  nfpms?: unknown;
};

export async function loadGoreleaserConfig(path = '.goreleaser.yaml'): Promise<GoreleaserConfig> {
  return YAML.parse(await Bun.file(path).text()) as GoreleaserConfig;
}

export function assertGoreleaserConfig(config: GoreleaserConfig): void {
  assert(config.version === 2, 'GoReleaser config must use version 2.');
  assert(config.project_name === 'cyanprint', 'GoReleaser project_name must be cyanprint.');

  const hooks = asStringArray(config.before?.hooks, 'before.hooks');
  const buildTargets = ['darwin-x64', 'darwin-arm64', 'linux-x64', 'linux-arm64', 'windows-x64'];
  assert(hooks.includes('bun install --frozen-lockfile'), 'GoReleaser before.hooks must install Bun dependencies.');
  const builds = asObjectArray(config.builds, 'builds');
  const build = builds.find(item => item.id === 'cyanprint');
  assert(build, 'GoReleaser builds must include cyanprint.');
  assert(build.builder === 'bun', 'GoReleaser cyanprint build must use the OSS Bun builder.');
  assert(build.binary === 'cyanprint', 'GoReleaser cyanprint build must package the cyanprint binary.');
  assert(build.main === 'packages/cli/src/main.ts', 'GoReleaser cyanprint build must use the CLI entrypoint.');
  assertContainsAll(asStringArray(build.targets, 'cyanprint.targets'), buildTargets, 'bun build targets');

  const archive = asObjectArray(config.archives, 'archives')[0];
  assert(archive, 'GoReleaser archives must be configured.');
  assertContainsAll(asStringArray(archive.ids, 'archives.ids'), ['cyanprint'], 'archive ids');
  assertContainsAll(asStringArray(archive.formats, 'archives.formats'), ['tar.gz'], 'archive formats');
  assert(config.checksum?.name_template === 'checksums.txt', 'GoReleaser checksum must write checksums.txt.');

  const brew = asObjectArray(config.homebrew_casks, 'homebrew_casks').find(item => item.name === 'cyanprint');
  assert(brew, 'GoReleaser homebrew_casks must include cyanprint.');
  assertContainsAll(asStringArray(brew.ids, 'homebrew_casks.ids'), ['cyanprint'], 'homebrew cask ids');
  assertContainsAll(asStringArray(brew.binaries, 'homebrew_casks.binaries'), ['cyanprint'], 'homebrew cask binaries');
  assertRepository(brew.repository, 'homebrew_casks.repository');

  const scoop = asObjectArray(config.scoops, 'scoops').find(item => item.name === 'cyanprint');
  assert(scoop, 'GoReleaser scoops must include cyanprint.');
  assertRepository(scoop.repository, 'scoops.repository');

  const nfpm = asObjectArray(config.nfpms, 'nfpms').find(item => item.id === 'packages');
  assert(nfpm, 'GoReleaser nfpms must include packages.');
  assert(typeof nfpm.maintainer === 'string' && nfpm.maintainer.length > 0, 'nfpms.maintainer is required.');
  assertContainsAll(asStringArray(nfpm.ids, 'nfpms.ids'), ['cyanprint'], 'nfpm ids');
  assertContainsAll(asStringArray(nfpm.formats, 'nfpms.formats'), ['deb', 'rpm', 'apk', 'archlinux'], 'nfpm formats');
}

function assertRepository(value: unknown, label: string): void {
  const repository = value as { owner?: unknown; name?: unknown; token?: unknown } | undefined;
  assert(typeof repository?.owner === 'string' && repository.owner.length > 0, `${label}.owner is required.`);
  assert(typeof repository?.name === 'string' && repository.name.length > 0, `${label}.name is required.`);
  if (repository.owner === 'cyanprint' && (repository.name === 'homebrew-tap' || repository.name === 'scoop-bucket')) {
    assert(
      repository.token === '{{ .Env.CYANPRINT_RELEASE_TOKEN }}',
      `${label}.token must use CYANPRINT_RELEASE_TOKEN.`,
    );
  }
}

function asObjectArray(value: unknown, label: string): Array<Record<string, unknown>> {
  assert(Array.isArray(value), `${label} must be an array.`);
  return value as Array<Record<string, unknown>>;
}

function asStringArray(value: unknown, label: string): string[] {
  assert(Array.isArray(value) && value.every(item => typeof item === 'string'), `${label} must be a string array.`);
  return value as string[];
}

function assertContainsAll(actual: string[], expected: string[], label: string): void {
  for (const item of expected) {
    assert(actual.includes(item), `${label} missing ${item}.`);
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}
