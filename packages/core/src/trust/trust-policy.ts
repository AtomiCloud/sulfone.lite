import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { artifactIntegrity, type ArtifactVersion, type ResolvedDependencyPin } from '@cyanprint/contracts';

export type TrustScope = 'organization' | 'template' | 'version';

export type TrustDecision = {
  trusted: boolean;
  scope: TrustScope;
  reason: string;
};

export type TrustStore = {
  organizations: string[];
  templates: Array<{ kind: string; owner: string; name: string }>;
  versions: Array<{
    kind: string;
    owner: string;
    name: string;
    version: string;
    integrity: string;
    pinsFingerprint: string;
  }>;
};

export const emptyTrustStore = (): TrustStore => ({ organizations: [], templates: [], versions: [] });

export function evaluateTrust(args: {
  requestedScope?: TrustScope;
  org?: string;
  template?: string;
  version?: string;
  integrity?: string;
  trusted?: boolean;
}): TrustDecision {
  const scope = args.requestedScope ?? 'version';
  if (!args.trusted) {
    return { trusted: false, scope, reason: `Untrusted ${scope} execution requires explicit approval.` };
  }
  if (scope === 'version' && (!args.version || !args.integrity)) {
    return { trusted: false, scope, reason: 'Version-level trust requires exact version and integrity.' };
  }
  return { trusted: true, scope, reason: `${scope} trust accepted.` };
}

export function resolveTrustStorePath(override?: string): string {
  if (override) {
    return join(override, 'trust.json');
  }
  if (process.env.CYANPRINT_TRUST_FILE) {
    return process.env.CYANPRINT_TRUST_FILE;
  }
  return join(process.env.CYANPRINT_TRUST_DIR ?? join(homedir(), '.cyan'), 'trust.json');
}

export async function loadTrustStore(path = resolveTrustStorePath()): Promise<TrustStore> {
  const raw = await readFile(path, 'utf8').catch(() => undefined);
  if (!raw) {
    return emptyTrustStore();
  }
  const parsed = JSON.parse(raw) as Partial<TrustStore>;
  return {
    organizations: Array.isArray(parsed.organizations) ? parsed.organizations.filter(isString) : [],
    templates: Array.isArray(parsed.templates) ? parsed.templates.filter(isTrustIdentity) : [],
    versions: Array.isArray(parsed.versions) ? parsed.versions.filter(isTrustVersion) : [],
  };
}

export async function saveTrustStore(store: TrustStore, path = resolveTrustStorePath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
}

export async function approveTrust(
  approval: {
    scope: TrustScope;
    kind?: string;
    owner: string;
    name?: string;
    version?: string;
    integrity?: string;
    pinsFingerprint?: string;
  },
  path = resolveTrustStorePath(),
): Promise<TrustStore> {
  const store = await loadTrustStore(path);
  if (approval.scope === 'organization') {
    addUnique(store.organizations, approval.owner);
  } else if (approval.scope === 'template') {
    if (!approval.name) {
      throw new Error('Template trust requires owner/name.');
    }
    addUniqueIdentity(store.templates, {
      kind: approval.kind ?? 'template',
      owner: approval.owner,
      name: approval.name,
    });
  } else {
    if (!approval.name || !approval.version || !approval.integrity) {
      throw new Error('Version trust requires owner/name, version, and integrity.');
    }
    addUniqueVersion(store.versions, {
      kind: approval.kind ?? 'template',
      owner: approval.owner,
      name: approval.name,
      version: approval.version,
      integrity: approval.integrity,
      pinsFingerprint: approval.pinsFingerprint ?? pinsFingerprint([]),
    });
  }
  await saveTrustStore(store, path);
  return store;
}

export function evaluateArtifactTrust(store: TrustStore, artifact: ArtifactVersion): TrustDecision {
  if (store.organizations.includes(artifact.owner)) {
    return { trusted: true, scope: 'organization', reason: `Trusted organization ${artifact.owner}.` };
  }
  if (
    store.templates.some(
      entry => entry.kind === artifact.kind && entry.owner === artifact.owner && entry.name === artifact.name,
    )
  ) {
    return { trusted: true, scope: 'template', reason: `Trusted template ${artifact.owner}/${artifact.name}.` };
  }
  const integrity = artifactIntegrity(artifact);
  const fingerprint = pinsFingerprint(artifact.resolvedPins);
  if (
    store.versions.some(
      entry =>
        entry.kind === artifact.kind &&
        entry.owner === artifact.owner &&
        entry.name === artifact.name &&
        entry.version === artifact.version &&
        entry.integrity === integrity &&
        entry.pinsFingerprint === fingerprint,
    )
  ) {
    return {
      trusted: true,
      scope: 'version',
      reason: `Trusted version ${artifact.owner}/${artifact.name}@${artifact.version}.`,
    };
  }
  return {
    trusted: false,
    scope: 'version',
    reason: `Registry artifact ${artifact.owner}/${artifact.name}@${artifact.version} is not trusted.`,
  };
}

export function pinsFingerprint(pins: ResolvedDependencyPin[]): string {
  return JSON.stringify(
    [...pins]
      .map(pin => ({
        kind: pin.kind,
        owner: pin.owner,
        name: pin.name,
        version: pin.version,
        integrity: pin.integrity,
      }))
      .sort((left, right) =>
        `${left.kind}:${left.owner}:${left.name}:${left.version}:${left.integrity}`.localeCompare(
          `${right.kind}:${right.owner}:${right.name}:${right.version}:${right.integrity}`,
        ),
      ),
  );
}

function addUnique(values: string[], value: string): void {
  if (!values.includes(value)) {
    values.push(value);
  }
}

function addUniqueIdentity(values: TrustStore['templates'], value: TrustStore['templates'][number]): void {
  if (!values.some(entry => entry.kind === value.kind && entry.owner === value.owner && entry.name === value.name)) {
    values.push(value);
  }
}

function addUniqueVersion(values: TrustStore['versions'], value: TrustStore['versions'][number]): void {
  if (
    !values.some(
      entry =>
        entry.kind === value.kind &&
        entry.owner === value.owner &&
        entry.name === value.name &&
        entry.version === value.version &&
        entry.integrity === value.integrity,
    )
  ) {
    values.push(value);
  }
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isTrustIdentity(value: unknown): value is TrustStore['templates'][number] {
  return isRecord(value) && isString(value.kind) && isString(value.owner) && isString(value.name);
}

function isTrustVersion(value: unknown): value is TrustStore['versions'][number] {
  return (
    isRecord(value) &&
    isString(value.kind) &&
    isString(value.owner) &&
    isString(value.name) &&
    isString(value.version) &&
    isString(value.integrity) &&
    isString(value.pinsFingerprint)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
