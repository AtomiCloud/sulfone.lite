const required = [
  'docs/user/install.md',
  'docs/user/quickstart.md',
  'docs/user/create.md',
  'docs/user/push.md',
  'docs/user/try-test.md',
  'docs/user/probe.md',
  'docs/user/update.md',
  'docs/user/auth-tokens.md',
  'docs/user/migration.md',
  'docs/developer/bundle-artifacts.md',
  'docs/security/trust-model.md',
  'docs/architecture/cloudflare-registry.md',
];

for (const path of required) {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new Error(`Missing required doc: ${path}`);
  }
}

const install = await Bun.file('docs/user/install.md').text();
for (const channel of [
  'Homebrew',
  'Scoop',
  'Nix',
  'apt/deb',
  'yum/rpm',
  'apk',
  'arch/pacman',
  'Direct archive',
  'Source/Bun',
]) {
  if (!install.includes(channel)) {
    throw new Error(`Install docs missing ${channel}`);
  }
}

console.log(JSON.stringify({ status: 'done', checked: required.length }));

export {};
