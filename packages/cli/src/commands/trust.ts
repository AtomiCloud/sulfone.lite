import {
  approveTrust,
  evaluateTrust,
  loadTrustStore,
  pinsFingerprint,
  resolveTrustStorePath,
  type TrustScope,
  type TrustStore,
} from '@cyanprint/core';
import { parseFlags, flagBool, flagString } from '../args';
import { kv, printJson, printSection, success } from '../ui';

export async function trustCommand(argv: string[]): Promise<void> {
  const { positional, flags } = parseFlags(argv);
  const action = positional[0] ?? 'inspect';
  const explicitScope = flagString(flags, 'scope');
  const scope = (explicitScope ?? positional[1] ?? 'version') as TrustScope;
  const ref = flagString(flags, 'ref', explicitScope ? positional[1] : positional[2]);
  const kind = flagString(flags, 'kind', 'template')!;
  const trustPath = resolveTrustStorePath(flagString(flags, 'trust-dir'));

  if (action === 'inspect') {
    const store = await loadTrustStore(trustPath);
    const report = { status: 'done', action, trustPath, store };
    if (flagBool(flags, 'json')) {
      printJson(report);
    } else {
      printTrustStore(trustPath, store);
    }
    return;
  }
  if (action !== 'approve') {
    throw new Error('trust requires inspect or approve');
  }
  if (!isTrustScope(scope)) {
    throw new Error(`trust scope must be organization, template, or version; got ${String(scope)}`);
  }

  const parsed = parseTrustRef(ref, scope);
  const owner = flagString(flags, 'owner', parsed.owner);
  const name = flagString(flags, 'name', parsed.name);
  const version = flagString(flags, 'version', parsed.version);
  if (!owner) {
    throw new Error(`trust approve ${scope} requires an owner (pass a ref or --owner)`);
  }
  if (scope !== 'organization' && !name) {
    throw new Error(`trust approve ${scope} requires a name (pass owner/name or --name)`);
  }
  if (scope === 'version' && !version) {
    throw new Error('trust approve version requires a version (pass owner/name@version or --version)');
  }
  const store = await approveTrust(
    {
      scope,
      kind,
      owner,
      name,
      version,
      integrity: flagString(flags, 'integrity', parsed.integrity),
      pinsFingerprint: flagString(flags, 'pins-fingerprint', pinsFingerprint([])),
    },
    trustPath,
  );
  const decision = evaluateTrust({
    requestedScope: scope,
    org: parsed.owner,
    template: parsed.name,
    version: flagString(flags, 'version', parsed.version),
    integrity: flagString(flags, 'integrity', parsed.integrity),
    trusted: true,
  });
  const report = { status: 'done', action, trustPath, decision, store };
  if (flagBool(flags, 'json')) {
    printJson(report);
  } else {
    console.log(success(`approved ${scope} trust`));
    printSection('Trust', [kv('path', trustPath), kv('owner', parsed.owner), kv('name', parsed.name)]);
  }
}

function isTrustScope(value: string): value is TrustScope {
  return value === 'organization' || value === 'template' || value === 'version';
}

function printTrustStore(trustPath: string, store: TrustStore): void {
  printSection('Trust Store', [
    kv('path', trustPath),
    kv('organizations', store.organizations.length),
    kv('templates', store.templates.length),
    kv('versions', store.versions.length),
  ]);
  if (store.organizations.length > 0) {
    printSection(
      'Organizations',
      store.organizations.map(owner => `- ${owner}`),
    );
  }
  if (store.templates.length > 0) {
    printSection(
      'Templates',
      store.templates.map(entry => `- ${entry.kind}:${entry.owner}/${entry.name}`),
    );
  }
  if (store.versions.length > 0) {
    printSection(
      'Versions',
      store.versions.map(
        entry =>
          `- ${entry.kind}:${entry.owner}/${entry.name}@${entry.version} integrity=${entry.integrity} pins=${entry.pinsFingerprint}`,
      ),
    );
  }
}

function parseTrustRef(
  ref: string | undefined,
  scope: TrustScope,
): {
  owner?: string;
  name?: string;
  version?: string;
  integrity?: string;
} {
  if (!ref) {
    return {};
  }
  if (scope === 'organization') {
    return { owner: ref };
  }
  const [identity, version] = ref.split('@');
  const [owner, name] = identity?.split('/') ?? [];
  return { owner, name, version };
}
