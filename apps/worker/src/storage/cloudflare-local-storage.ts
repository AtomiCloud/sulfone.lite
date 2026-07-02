import {
  artifactIntegrity,
  artifactVersionId,
  type ArtifactPublish,
  type ArtifactVersion,
  type ObjectRef,
} from '@cyanprint/contracts';
import {
  artifactMatchesQuery,
  artifactSearchText,
  batchResolve,
  createLocalRegistryState,
  isActiveArtifact,
  upsertArtifact,
  type SeedObjectPayload,
} from '@cyanprint/registry-client';
import type { RegistryStorage, RegistryUser, StoredAuthHandoff, StoredOAuthState, StoredUploadSession } from './types';

export function createCloudflareLocalStorage(
  seed: ArtifactVersion[] = [],
  seedObjects: SeedObjectPayload[] = [],
): RegistryStorage {
  const state = createLocalRegistryState();
  const users: RegistryUser[] = state.users.map(user => ({ ...user }));
  const objects = new Map<string, { ref: ObjectRef; payload: Uint8Array }>();
  const uploads = new Map<string, StoredUploadSession>();
  const sessions = new Map<string, { userId: string; expiresAt: string }>();
  const oauthStates = new Map<string, StoredOAuthState>();
  const authHandoffs = new Map<string, StoredAuthHandoff>();
  const likes = new Set<string>();
  const downloads: Array<{ artifactId: string; createdAt: string }> = [];
  const objectArtifactIndex = new Map<string, string>();
  state.artifacts.push(...seed.map(artifact => structuredClone(artifact)));
  for (const object of seedObjects) {
    const payload = typeof object.payload === 'string' ? new TextEncoder().encode(object.payload) : object.payload;
    objects.set(objectKey(object.ref), { ref: structuredClone(object.ref), payload: cloneBytes(payload) });
  }
  for (const artifact of state.artifacts) {
    indexArtifactObjects(artifact);
  }

  function indexArtifactObjects(artifact: ArtifactVersion): void {
    for (const ref of artifactObjectRefs(artifact)) {
      objectArtifactIndex.set(objectArtifactIndexKey(ref), artifact.id);
    }
  }

  function findActiveArtifactByObjectRef(ref: ObjectRef): ArtifactVersion | undefined {
    const indexedId = objectArtifactIndex.get(objectArtifactIndexKey(ref));
    if (indexedId) {
      const indexed = state.artifacts.find(artifact => artifact.id === indexedId);
      if (indexed && isActiveArtifact(indexed) && artifactHasObjectRef(indexed, ref)) {
        return indexed;
      }
    }
    const artifact = state.artifacts.find(item => isActiveArtifact(item) && artifactHasObjectRef(item, ref));
    if (artifact) {
      objectArtifactIndex.set(objectArtifactIndexKey(ref), artifact.id);
    }
    return artifact;
  }

  return {
    mode: 'in-memory',
    bindings: [],
    getCurrentUser() {
      return users[0];
    },
    getUser(id) {
      return users.find(user => user.id === id);
    },
    upsertUser(user) {
      const existing = users.findIndex(item => item.id === user.id);
      if (existing >= 0) {
        const current = users[existing]!;
        users[existing] = {
          ...current,
          handle: user.handle ?? current.handle,
          login: user.login ?? current.login,
          admin: Boolean(user.admin),
        };
        return;
      }
      users.push({ id: user.id, handle: user.handle, login: user.login, admin: Boolean(user.admin) });
    },
    updateUserHandle(userId, handle) {
      const user = users.find(item => item.id === userId);
      if (!user) {
        return 'not_found';
      }
      if (user.handle != null) {
        return 'immutable';
      }
      if (users.some(item => item.id !== userId && item.handle === handle)) {
        return 'duplicate';
      }
      user.handle = handle;
      return 'updated';
    },
    listUsers() {
      return users;
    },
    createSession(userId, session) {
      sessions.set(session, { userId, expiresAt: sessionExpiresAt() });
    },
    getSessionUser(session) {
      const record = sessions.get(session);
      if (!record || Date.parse(record.expiresAt) <= Date.now()) {
        sessions.delete(session);
        return undefined;
      }
      return this.getUser(record.userId);
    },
    deleteSession(session) {
      sessions.delete(session);
    },
    saveOAuthState(state) {
      oauthStates.set(state.id, state);
    },
    consumeOAuthState(id) {
      const state = oauthStates.get(id);
      oauthStates.delete(id);
      return state && Date.parse(state.expiresAt) > Date.now() ? state : undefined;
    },
    saveAuthHandoff(handoff) {
      authHandoffs.set(handoff.id, handoff);
    },
    consumeAuthHandoff(id) {
      const handoff = authHandoffs.get(id);
      authHandoffs.delete(id);
      return handoff && Date.parse(handoff.expiresAt) > Date.now() ? handoff : undefined;
    },
    createToken(record) {
      const index = state.tokens.findIndex(token => token.id === record.id);
      if (index >= 0) {
        state.tokens[index] = record;
      } else {
        state.tokens.push(record);
      }
    },
    listTokens() {
      return state.tokens;
    },
    listTokensForUser(userId) {
      return state.tokens.filter(token => token.userId === userId);
    },
    revokeTokenForUser(userId, tokenId) {
      const token = state.tokens.find(item => item.id === tokenId && item.userId === userId);
      if (token) {
        token.revoked = true;
      }
    },
    findTokenByHash(secretHash) {
      return state.tokens.find(token => token.secretHash === secretHash && !token.revoked);
    },
    listArtifacts(kind) {
      return kind ? state.artifacts.filter(artifact => artifact.kind === kind) : state.artifacts;
    },
    searchArtifacts(args = {}) {
      const limit = normalizeLimit(args.limit);
      const query = args.query?.trim().toLowerCase() ?? '';
      const matching = searchLocalArtifacts(state.artifacts, { kind: args.kind, query }).toSorted(compareArtifacts);
      return pageLocalArtifacts(matching, args.cursor, limit);
    },
    listLatestArtifacts(args = {}) {
      const limit = normalizeLimit(args.limit);
      const query = args.query?.trim().toLowerCase() ?? '';
      const latest = new Map<string, ArtifactVersion>();
      for (const artifact of searchLocalArtifacts(state.artifacts, { kind: args.kind, query })) {
        const key = `${artifact.kind}:${artifact.owner}:${artifact.name}`;
        const current = latest.get(key);
        if (!current || compareVersions(artifact.version, current.version) > 0) {
          latest.set(key, artifact);
        }
      }
      const matching = [...latest.values()].toSorted(compareArtifacts);
      return pageLocalArtifacts(matching, args.cursor, limit);
    },
    listModerationArtifacts(args = {}) {
      const limit = normalizeLimit(args.limit);
      const query = args.query?.trim().toLowerCase() ?? '';
      const matching = state.artifacts
        .filter(artifact => !args.kind || artifact.kind === args.kind)
        .filter(artifact => artifactMatchesQuery(artifactSearchText(artifact), query))
        .toSorted(compareArtifacts);
      return pageLocalArtifacts(matching, args.cursor, limit);
    },
    getArtifactByIdentity(kind, owner, name) {
      return state.artifacts
        .filter(isActiveArtifact)
        .filter(artifact => artifact.kind === kind && artifact.owner === owner && artifact.name === name)
        .toSorted((left, right) => compareVersions(right.version, left.version))[0];
    },
    listArtifactVersions(kind, owner, name) {
      return state.artifacts
        .filter(isActiveArtifact)
        .filter(artifact => artifact.kind === kind && artifact.owner === owner && artifact.name === name)
        .toSorted((left, right) => compareVersions(right.version, left.version));
    },
    getArtifact(id) {
      return state.artifacts.find(artifact => artifact.id === id);
    },
    getActiveArtifactByObjectRef(ref) {
      return findActiveArtifactByObjectRef(ref);
    },
    addArtifact(artifact) {
      upsertArtifact(state, artifact);
      indexArtifactObjects(artifact);
    },
    commitArtifact(artifact) {
      const version = String(
        Math.max(
          0,
          ...state.artifacts
            .filter(item => item.kind === artifact.kind && item.owner === artifact.owner && item.name === artifact.name)
            .map(item => Number(item.version))
            .filter(version => Number.isInteger(version)),
        ) + 1,
      );
      const committed: ArtifactVersion = {
        ...artifact,
        id: artifactVersionId(artifact.kind, artifact.owner, artifact.name, version),
        version,
        publishedAt: new Date().toISOString(),
      };
      upsertArtifact(state, committed);
      indexArtifactObjects(committed);
      return committed;
    },
    likeArtifact(id, userId) {
      const artifact = state.artifacts.find(item => item.id === id);
      if (!artifact) {
        return undefined;
      }
      const key = `${userId}:${id}`;
      if (!likes.has(key)) {
        likes.add(key);
        artifact.likes += 1;
      }
      return artifact;
    },
    recordDownload(ref) {
      const artifact = findActiveArtifactByObjectRef(ref);
      if (!artifact) {
        return undefined;
      }
      downloads.push({ artifactId: artifact.id, createdAt: new Date().toISOString() });
      artifact.downloads += 1;
      return artifact;
    },
    putObject(ref, payload) {
      return this.putObjectBytes(ref, new TextEncoder().encode(payload));
    },
    async getObject(ref) {
      const payload = await this.getObjectBytes(ref);
      return payload ? new TextDecoder().decode(payload) : undefined;
    },
    putObjectBytes(ref, payload) {
      const key = objectKey(ref);
      if (objects.has(key)) {
        throw new Error(`Object already exists: ${ref.key}`);
      }
      objects.set(key, { ref: structuredClone(ref), payload: cloneBytes(payload) });
    },
    getObjectBytes(ref) {
      const object = objects.get(objectKey(ref));
      if (!object || object.ref.sha256 !== ref.sha256 || object.ref.size !== ref.size) {
        return undefined;
      }
      return cloneBytes(object.payload);
    },
    hasObjectRef(ref) {
      return this.getObjectBytes(ref) !== undefined;
    },
    hasVersionPin(pin) {
      return state.artifacts.some(artifact => {
        const expectedIntegrity = artifactIntegrity(artifact);
        return (
          artifact.kind === pin.kind &&
          artifact.owner === pin.owner &&
          artifact.name === pin.name &&
          artifact.version === pin.version &&
          isActiveArtifact(artifact) &&
          pin.integrity === expectedIntegrity
        );
      });
    },
    batchResolve(request) {
      return batchResolve(state, request);
    },
    disableArtifact(id) {
      const artifact = state.artifacts.find(item => item.id === id);
      if (artifact) {
        artifact.disabled = true;
        artifact.moderationState = 'disabled';
      }
      return artifact;
    },
    saveUploadSession(upload) {
      uploads.set(upload.id, upload);
    },
    getUploadSession(uploadId) {
      const upload = uploads.get(uploadId);
      if (!upload || Date.parse(upload.expiresAt) <= Date.now()) {
        return undefined;
      }
      return upload;
    },
    deleteUploadSession(uploadId) {
      uploads.delete(uploadId);
    },
  };
}

function objectKey(ref: ObjectRef): string {
  return `${ref.bucket}:${ref.key}:${ref.sha256}:${ref.size}`;
}

function objectArtifactIndexKey(ref: ObjectRef): string {
  return `object-artifact:${ref.sha256}:${ref.key}`;
}

function artifactObjectRefs(artifact: ArtifactVersion): ObjectRef[] {
  return [
    artifact.object,
    artifact.artifactObjects?.manifest,
    artifact.artifactObjects?.readme,
    artifact.artifactObjects?.bundle,
    artifact.artifactObjects?.archive,
  ].filter((ref): ref is ObjectRef => Boolean(ref));
}

function cloneBytes(payload: Uint8Array): Uint8Array {
  return payload.slice();
}

function sessionExpiresAt(): string {
  return new Date(Date.now() + 60 * 60 * 24 * 30 * 1000).toISOString();
}

function objectsMatch(left: ObjectRef | undefined, right: ObjectRef): boolean {
  return Boolean(
    left &&
    left.bucket === right.bucket &&
    left.key === right.key &&
    left.sha256 === right.sha256 &&
    left.size === right.size,
  );
}

function artifactHasObjectRef(artifact: ArtifactVersion, ref: ObjectRef): boolean {
  const refs = [
    artifact.object,
    artifact.artifactObjects?.manifest,
    artifact.artifactObjects?.readme,
    artifact.artifactObjects?.bundle,
    artifact.artifactObjects?.archive,
  ];
  return refs.some(candidate => objectsMatch(candidate, ref));
}

function searchLocalArtifacts(
  artifacts: ArtifactVersion[],
  args: { kind?: string; query?: string },
): ArtifactVersion[] {
  const query = args.query?.trim().toLowerCase() ?? '';
  return artifacts
    .filter(isActiveArtifact)
    .filter(artifact => !args.kind || artifact.kind === args.kind)
    .filter(artifact => artifactMatchesQuery(artifactSearchText(artifact), query));
}

function normalizeLimit(limit: number | undefined): number {
  return typeof limit === 'number' && Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : 100;
}

function compareArtifacts(left: ArtifactVersion, right: ArtifactVersion): number {
  return (
    left.kind.localeCompare(right.kind) ||
    left.owner.localeCompare(right.owner) ||
    left.name.localeCompare(right.name) ||
    compareVersions(right.version, left.version)
  );
}

function pageLocalArtifacts(
  matching: ArtifactVersion[],
  cursor: string | undefined,
  limit: number,
): { artifacts: ArtifactVersion[]; nextCursor?: string } {
  const decoded = decodeArtifactCursor(cursor);
  const start = decoded
    ? Math.max(
        0,
        matching.findIndex(artifact => compareArtifactToCursor(artifact, decoded) > 0),
      )
    : 0;
  const artifacts = matching.slice(start, start + limit);
  const nextArtifact = artifacts.at(-1);
  return {
    artifacts,
    ...(start + artifacts.length < matching.length && nextArtifact
      ? { nextCursor: encodeArtifactCursor(nextArtifact) }
      : {}),
  };
}

type LocalArtifactCursor = {
  kind: string;
  owner: string;
  name: string;
  version: string;
  id: string;
};

function encodeArtifactCursor(artifact: ArtifactVersion): string {
  return btoa(
    JSON.stringify({
      kind: artifact.kind,
      owner: artifact.owner,
      name: artifact.name,
      version: artifact.version,
      id: artifact.id,
    } satisfies LocalArtifactCursor),
  );
}

function decodeArtifactCursor(cursor: string | undefined): LocalArtifactCursor | undefined {
  if (!cursor) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(atob(cursor)) as Partial<LocalArtifactCursor>;
    return parsed.kind && parsed.owner && parsed.name && parsed.version && parsed.id
      ? {
          kind: parsed.kind,
          owner: parsed.owner,
          name: parsed.name,
          version: parsed.version,
          id: parsed.id,
        }
      : undefined;
  } catch {
    return undefined;
  }
}

function compareArtifactToCursor(artifact: ArtifactVersion, cursor: LocalArtifactCursor): number {
  return (
    artifact.kind.localeCompare(cursor.kind) ||
    artifact.owner.localeCompare(cursor.owner) ||
    artifact.name.localeCompare(cursor.name) ||
    compareVersions(cursor.version, artifact.version) ||
    artifact.id.localeCompare(cursor.id)
  );
}

function compareVersions(left: string, right: string): number {
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  if (Number.isInteger(leftNumber) && Number.isInteger(rightNumber)) {
    return leftNumber - rightNumber;
  }
  return left.localeCompare(right);
}
