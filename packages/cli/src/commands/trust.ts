import {
  approveTrust,
  evaluateTrust,
  loadTrustStore,
  pinsFingerprint,
  resolveTrustStorePath,
  type TrustScope,
  type TrustStore,
} from '@cyanprint/core';
import { RegistryClient } from '@cyanprint/registry-client';
import { artifactIntegrity } from '@cyanprint/contracts';
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
  let integrity = flagString(flags, 'integrity', parsed.integrity);
  let fingerprint = flagString(flags, 'pins-fingerprint');
  const registry = flagString(flags, 'registry');
  if (scope === 'version' && registry && name && version && (!integrity || fingerprint === undefined)) {
    const resolved = await new RegistryClient(registry)
      .batchResolve({ refs: [{ kind, owner, name, version }] })
      .catch((error: unknown) => {
        throw new Error(
          `Could not reach registry ${registry} to resolve ${owner}/${name}@${version}: ${error instanceof Error ? error.message : String(error)}. To approve offline, pass both --integrity and --pins-fingerprint.`,
        );
      });
    const artifact = resolved.resolved[0];
    if (!artifact) {
      throw new Error(`Registry artifact not found: ${owner}/${name}@${version}`);
    }
    integrity ??= artifactIntegrity(artifact);
    fingerprint ??= pinsFingerprint(artifact.resolvedPins);
  }
  if (scope === 'version' && fingerprint === undefined) {
    console.error(
      'warning: no --pins-fingerprint and no --registry, so the dependency pins are recorded as empty; this will not match a template with dependencies. Pass --registry or --pins-fingerprint.',
    );
  }
  const store = await approveTrust(
    {
      scope,
      kind,
      owner,
      name,
      version,
      integrity,
      pinsFingerprint: fingerprint ?? pinsFingerprint([]),
    },
    trustPath,
  );
  const decision = evaluateTrust({
    requestedScope: scope,
    org: owner,
    template: name,
    version,
    integrity,
    trusted: true,
  });
  const report = { status: 'done', action, trustPath, decision, store };
  if (flagBool(flags, 'json')) {
    printJson(report);
  } else {
    console.log(success(`approved ${scope} trust`));
    printSection('Trust', [kv('path', trustPath), kv('owner', owner), kv('name', name)]);
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
