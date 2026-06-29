import {
  artifactIntegrity,
  artifactVersionId,
  type ArtifactPublish,
  type ArtifactVersion,
  type BatchResolveRequest,
  type BatchResolveResponse,
  type ObjectRef,
} from '@cyanprint/contracts';
import {
  artifactFtsQuery,
  artifactSearchText,
  batchResolve,
  createLocalRegistryState,
  isActiveArtifact,
  seedArtifacts,
  seedObjectPayloads,
  type TokenRecord,
} from '@cyanprint/registry-client';
import type { RegistryStorage, StoredUploadSession } from './types';

type D1Statement = {
  bind(...values: unknown[]): D1Statement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
};

type D1DatabaseBinding = {
  prepare(sql: string): D1Statement;
};

type R2ObjectBody = {
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
};

type R2BucketBinding = {
  get(key: string): Promise<R2ObjectBody | null>;
  put(key: string, value: string | Uint8Array): Promise<unknown>;
};

type KVNamespaceBinding = {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<unknown>;
};

export type WorkerBindings = {
  DB?: D1DatabaseBinding;
  R2?: R2BucketBinding;
  KV?: KVNamespaceBinding;
  CYANPRINT_ENABLE_LOCAL_AUTH?: string;
  CYANPRINT_LOCAL_DEV_SECRET?: string;
  CYANPRINT_ENABLE_LEGACY_PACKAGE_API?: string;
};

export function createCloudflareBindingStorage(env: WorkerBindings): RegistryStorage {
  const db = requireBinding(env.DB, 'D1');
  const r2 = requireBinding(env.R2, 'R2');
  const kv = requireBinding(env.KV, 'KV');
  let seeded: Promise<void> | undefined;

  async function ensureSeeded(): Promise<void> {
    seeded ??= seed();
    await seeded;
  }

  async function seed(): Promise<void> {
    const state = createLocalRegistryState();
    for (const user of state.users) {
      await db
        .prepare('INSERT OR IGNORE INTO users (id, handle, admin) VALUES (?, ?, ?)')
        .bind(user.id, user.handle, user.admin ? 1 : 0)
        .run();
    }
    for (const object of seedObjectPayloads) {
      if (!(await kv.get(objectMetaKey(object.ref)))) {
        await r2.put(objectKey(object.ref), object.payload);
        await kv.put(objectMetaKey(object.ref), JSON.stringify(object.ref));
      }
    }
    for (const artifact of seedArtifacts) {
      const existing = await findArtifactByIdentity(artifact.kind, artifact.owner, artifact.name, artifact.version);
      if (!existing) {
        await persistArtifact(artifact);
      }
    }
  }

  async function findArtifactByIdentity(
    kind: string,
    owner: string,
    name: string,
    version: string,
  ): Promise<ArtifactVersion | undefined> {
    const row = await db
      .prepare(
        `SELECT versions.id
         FROM versions
         JOIN artifacts ON artifacts.id = versions.artifact_id
         WHERE artifacts.kind = ? AND artifacts.owner = ? AND artifacts.name = ? AND versions.version = ?
         LIMIT 1`,
      )
      .bind(kind, owner, name, version)
      .first<{ id: string }>();
    if (!row) {
      return undefined;
    }
    const raw = await kv.get(artifactKey(row.id));
    return raw ? (JSON.parse(raw) as ArtifactVersion) : undefined;
  }

  async function persistArtifact(artifact: ArtifactVersion): Promise<void> {
    await db
      .prepare(
        `INSERT INTO artifacts (id, kind, owner, name, disabled, moderation_state)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           kind = excluded.kind,
           owner = excluded.owner,
           name = excluded.name,
           disabled = excluded.disabled,
           moderation_state = excluded.moderation_state`,
      )
      .bind(
        artifact.id,
        artifact.kind,
        artifact.owner,
        artifact.name,
        artifact.disabled ? 1 : 0,
        artifact.moderationState,
      )
      .run();
    const searchText = artifactSearchText(artifact);
    await db
      .prepare(
        `INSERT INTO versions (id, artifact_id, version, published_at, object_key, sha256, size, downloads, likes, search_text)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           artifact_id = excluded.artifact_id,
           version = excluded.version,
           published_at = excluded.published_at,
           object_key = excluded.object_key,
           sha256 = excluded.sha256,
           size = excluded.size,
           downloads = excluded.downloads,
           likes = excluded.likes,
           search_text = excluded.search_text`,
      )
      .bind(
        artifact.id,
        artifact.id,
        artifact.version,
        artifact.publishedAt ?? new Date().toISOString(),
        artifact.object?.key ?? null,
        artifact.object?.sha256 ?? null,
        artifact.object?.size ?? 0,
        artifact.downloads,
        artifact.likes,
        searchText,
      )
      .run();
    await db.prepare('DELETE FROM artifact_search WHERE version_id = ?').bind(artifact.id).run();
    await db
      .prepare('INSERT INTO artifact_search (version_id, search_text) VALUES (?, ?)')
      .bind(artifact.id, searchText)
      .run();
    await db.prepare('DELETE FROM refs WHERE version_id = ?').bind(artifact.id).run();
    await db.prepare('DELETE FROM artifact_objects WHERE version_id = ?').bind(artifact.id).run();
    for (const [part, ref] of artifactObjectEntries(artifact)) {
      await db
        .prepare('INSERT INTO artifact_objects (version_id, part, object_key, sha256, size) VALUES (?, ?, ?, ?, ?)')
        .bind(artifact.id, part, ref.key, ref.sha256, ref.size)
        .run();
    }
    for (const pin of artifact.resolvedPins) {
      await db
        .prepare('INSERT INTO refs (version_id, kind, owner, name, version, integrity) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(artifact.id, pin.kind, pin.owner, pin.name, pin.version, pin.integrity)
        .run();
    }
    await advanceCounter(artifact.kind, artifact.owner, artifact.name, artifact.version);
    await kv.put(artifactKey(artifact.id), JSON.stringify(artifact));
  }

  return {
    mode: 'cloudflare-bindings',
    bindings: ['D1', 'R2', 'KV'],
    async getCurrentUser() {
      await ensureSeeded();
      return this.getUser('user_local');
    },
    async getUser(id) {
      await ensureSeeded();
      const row = await db.prepare('SELECT id, handle, admin FROM users WHERE id = ?').bind(id).first<UserRow>();
      return row ? rowToUser(row) : undefined;
    },
    async listUsers() {
      await ensureSeeded();
      const { results } = await db.prepare('SELECT id, handle, admin FROM users ORDER BY handle').all<UserRow>();
      return results.map(rowToUser);
    },
    async createSession(userId, session) {
      await ensureSeeded();
      await kv.put(sessionKey(session), userId);
    },
    async getSessionUser(session) {
      await ensureSeeded();
      const userId = await kv.get(sessionKey(session));
      return userId ? this.getUser(userId) : undefined;
    },
    async createToken(record) {
      await ensureSeeded();
      await db
        .prepare(
          `INSERT INTO tokens (id, user_id, name, secret_hash, revoked)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             user_id = excluded.user_id,
             name = excluded.name,
             secret_hash = excluded.secret_hash,
             revoked = excluded.revoked`,
        )
        .bind(record.id, record.userId, record.name, record.secretHash, record.revoked ? 1 : 0)
        .run();
    },
    async listTokens() {
      await ensureSeeded();
      const { results } = await db
        .prepare('SELECT id, user_id, name, secret_hash, revoked FROM tokens ORDER BY name')
        .all<TokenRow>();
      return results.map(rowToToken);
    },
    async findTokenByHash(secretHash) {
      await ensureSeeded();
      const row = await db
        .prepare('SELECT id, user_id, name, secret_hash, revoked FROM tokens WHERE secret_hash = ? AND revoked = 0')
        .bind(secretHash)
        .first<TokenRow>();
      return row ? rowToToken(row) : undefined;
    },
    async listArtifacts(kind) {
      await ensureSeeded();
      const statement = kind
        ? db.prepare('SELECT id FROM artifacts WHERE kind = ? ORDER BY owner, name').bind(kind)
        : db.prepare('SELECT id FROM artifacts ORDER BY kind, owner, name');
      const { results } = await statement.all<{ id: string }>();
      const artifacts = await Promise.all(results.map(row => this.getArtifact(row.id)));
      return artifacts.filter((artifact): artifact is ArtifactVersion => Boolean(artifact));
    },
    async searchArtifacts(args = {}) {
      await ensureSeeded();
      return searchStoredArtifacts(args);
    },
    async listLatestArtifacts(args = {}) {
      await ensureSeeded();
      return searchStoredArtifacts(args, { latestOnly: true });
    },
    async listModerationArtifacts(args = {}) {
      await ensureSeeded();
      return searchStoredArtifacts(args, { includeInactive: true });
    },
    async getArtifact(id) {
      await ensureSeeded();
      const raw = await kv.get(artifactKey(id));
      return raw ? (JSON.parse(raw) as ArtifactVersion) : undefined;
    },
    async getArtifactByIdentity(kind, owner, name) {
      await ensureSeeded();
      const row = await db
        .prepare(
          `SELECT versions.id
           FROM versions
           JOIN artifacts ON artifacts.id = versions.artifact_id
           WHERE artifacts.kind = ? AND artifacts.owner = ? AND artifacts.name = ?
             AND artifacts.disabled = 0 AND artifacts.moderation_state = 'active'
           ORDER BY CAST(versions.version AS INTEGER) DESC, versions.version DESC
           LIMIT 1`,
        )
        .bind(kind, owner, name)
        .first<{ id: string }>();
      return row ? this.getArtifact(row.id) : undefined;
    },
    async listArtifactVersions(kind, owner, name) {
      await ensureSeeded();
      const { results } = await db
        .prepare(
          `SELECT versions.id
           FROM versions
           JOIN artifacts ON artifacts.id = versions.artifact_id
           WHERE artifacts.kind = ? AND artifacts.owner = ? AND artifacts.name = ?
             AND artifacts.disabled = 0 AND artifacts.moderation_state = 'active'
           ORDER BY CAST(versions.version AS INTEGER) DESC, versions.version DESC`,
        )
        .bind(kind, owner, name)
        .all<{ id: string }>();
      const artifacts = await Promise.all(results.map(row => this.getArtifact(row.id)));
      return artifacts.filter((artifact): artifact is ArtifactVersion => Boolean(artifact));
    },
    async getActiveArtifactByObjectRef(ref) {
      await ensureSeeded();
      const artifacts = await this.listArtifacts();
      return artifacts.find(
        artifact => artifact.moderationState === 'active' && !artifact.disabled && artifactHasObjectRef(artifact, ref),
      );
    },
    async addArtifact(artifact) {
      await ensureSeeded();
      await persistArtifact(artifact);
    },
    async commitArtifact(artifact: ArtifactPublish) {
      await ensureSeeded();
      const version = await allocateVersion(artifact.kind, artifact.owner, artifact.name);
      const committed: ArtifactVersion = {
        ...artifact,
        id: artifactVersionId(artifact.kind, artifact.owner, artifact.name, version),
        version,
        publishedAt: new Date().toISOString(),
      };
      await persistArtifact(committed);
      return committed;
    },
    async likeArtifact(id, userId) {
      await ensureSeeded();
      const artifact = await this.getArtifact(id);
      if (!artifact) {
        return undefined;
      }
      const liked = await db
        .prepare('SELECT user_id FROM likes WHERE user_id = ? AND artifact_id = ?')
        .bind(userId, id)
        .first();
      if (!liked) {
        await db
          .prepare('INSERT OR IGNORE INTO likes (user_id, artifact_id, created_at) VALUES (?, ?, ?)')
          .bind(userId, id, new Date().toISOString())
          .run();
        artifact.likes = await countRows('likes', 'artifact_id', id);
        await persistArtifactCounters(artifact);
      }
      return artifact;
    },
    async recordDownload(ref) {
      await ensureSeeded();
      const artifacts = await this.listArtifacts();
      const artifact = artifacts.find(item => isActiveArtifact(item) && artifactHasObjectRef(item, ref));
      if (!artifact) {
        return undefined;
      }
      await db
        .prepare('INSERT INTO downloads (id, artifact_id, version_id, created_at) VALUES (?, ?, ?, ?)')
        .bind(crypto.randomUUID(), artifact.id, artifact.id, new Date().toISOString())
        .run();
      artifact.downloads = await countRows('downloads', 'artifact_id', artifact.id);
      await persistArtifactCounters(artifact);
      return artifact;
    },
    async putObject(ref, payload) {
      await this.putObjectBytes(ref, new TextEncoder().encode(payload));
    },
    async getObject(ref) {
      const payload = await this.getObjectBytes(ref);
      return payload ? new TextDecoder().decode(payload) : undefined;
    },
    async putObjectBytes(ref, payload) {
      await ensureSeeded();
      const key = objectKey(ref);
      if (await kv.get(objectMetaKey(ref))) {
        throw new Error(`Object already exists: ${ref.key}`);
      }
      await r2.put(key, payload);
      await kv.put(objectMetaKey(ref), JSON.stringify(ref));
    },
    async getObjectBytes(ref) {
      await ensureSeeded();
      const metadata = await kv.get(objectMetaKey(ref));
      if (!metadata) {
        return undefined;
      }
      const object = await r2.get(objectKey(ref));
      return object ? new Uint8Array(await object.arrayBuffer()) : undefined;
    },
    async hasObjectRef(ref) {
      return (await this.getObjectBytes(ref)) !== undefined;
    },
    async hasVersionPin(pin) {
      await ensureSeeded();
      const artifacts = await this.listArtifacts(pin.kind);
      return artifacts.some(artifact => {
        const expectedIntegrity = artifactIntegrity(artifact);
        return (
          artifact.owner === pin.owner &&
          artifact.name === pin.name &&
          artifact.version === pin.version &&
          isActiveArtifact(artifact) &&
          pin.integrity === expectedIntegrity
        );
      });
    },
    async batchResolve(request) {
      await ensureSeeded();
      const state = createLocalRegistryState();
      state.artifacts = await this.listArtifacts();
      return batchResolve(state, request) satisfies BatchResolveResponse;
    },
    async disableArtifact(id) {
      await ensureSeeded();
      const artifact = await this.getArtifact(id);
      if (!artifact) {
        return undefined;
      }
      artifact.disabled = true;
      artifact.moderationState = 'disabled';
      await persistArtifact(artifact);
      return artifact;
    },
    async saveUploadSession(upload) {
      await ensureSeeded();
      await kv.put(uploadSessionKey(upload.id), JSON.stringify(upload));
    },
    async getUploadSession(uploadId) {
      await ensureSeeded();
      const raw = await kv.get(uploadSessionKey(uploadId));
      if (!raw) {
        return undefined;
      }
      const upload = JSON.parse(raw) as StoredUploadSession;
      return Date.parse(upload.expiresAt) > Date.now() ? upload : undefined;
    },
    async deleteUploadSession(uploadId) {
      await ensureSeeded();
      await kv.put(uploadSessionKey(uploadId), '');
    },
  };

  async function allocateVersion(kind: string, owner: string, name: string): Promise<string> {
    const row = await db
      .prepare(
        `INSERT INTO artifact_counters (kind, owner, name, next_version)
         VALUES (
           ?,
           ?,
           ?,
           COALESCE((
             SELECT MAX(CAST(versions.version AS INTEGER)) + 2
             FROM versions
             JOIN artifacts ON artifacts.id = versions.artifact_id
             WHERE artifacts.kind = ? AND artifacts.owner = ? AND artifacts.name = ?
           ), 2)
         )
         ON CONFLICT(kind, owner, name) DO UPDATE SET next_version = next_version + 1
         RETURNING next_version - 1 AS version`,
      )
      .bind(kind, owner, name, kind, owner, name)
      .first<{ version: number }>();
    if (!row) {
      throw new Error(`Unable to allocate artifact version for ${kind}:${owner}:${name}`);
    }
    return String(row.version);
  }

  async function advanceCounter(kind: string, owner: string, name: string, version: string): Promise<void> {
    const numericVersion = Number(version);
    if (!Number.isInteger(numericVersion) || numericVersion < 0) {
      return;
    }
    await db
      .prepare(
        `INSERT INTO artifact_counters (kind, owner, name, next_version)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(kind, owner, name) DO UPDATE SET next_version = max(next_version, excluded.next_version)`,
      )
      .bind(kind, owner, name, numericVersion + 1)
      .run();
  }

  async function countRows(table: 'likes' | 'downloads', column: 'artifact_id', value: string): Promise<number> {
    const row = await db
      .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${column} = ?`)
      .bind(value)
      .first<{ count: number }>();
    return Number(row?.count ?? 0);
  }

  async function persistArtifactCounters(artifact: ArtifactVersion): Promise<void> {
    await db
      .prepare('UPDATE versions SET downloads = ?, likes = ? WHERE id = ?')
      .bind(artifact.downloads, artifact.likes, artifact.id)
      .run();
    await kv.put(artifactKey(artifact.id), JSON.stringify(artifact));
  }

  async function searchStoredArtifacts(
    args = {},
    options?: { includeInactive?: boolean; latestOnly?: boolean },
  ): Promise<{ artifacts: ArtifactVersion[]; nextCursor?: string }> {
    const typedArgs = args as { cursor?: string; kind?: string; limit?: number; query?: string };
    const limit = normalizeLimit(typedArgs.limit);
    const query = typedArgs.query?.trim().toLowerCase() ?? '';
    const ftsQuery = artifactFtsQuery(query);
    const conditions = options?.includeInactive
      ? ['1 = 1']
      : ['artifacts.disabled = 0', "artifacts.moderation_state = 'active'"];
    const bindings: unknown[] = [];
    if (typedArgs.kind) {
      conditions.push('artifacts.kind = ?');
      bindings.push(typedArgs.kind);
    }
    if (ftsQuery) {
      conditions.push('artifact_search MATCH ?');
      bindings.push(ftsQuery);
    }
    const cursor = decodeStoredCursor(typedArgs.cursor);
    const cursorCondition = cursor ? ` AND ${storedCursorCondition()}` : '';
    const cursorBindings = cursor ? storedCursorBindings(cursor) : [];
    const eligibleSelect = `SELECT versions.id,
                                   artifacts.kind,
                                   artifacts.owner,
                                   artifacts.name,
                                   CAST(versions.version AS INTEGER) AS numeric_version,
                                   versions.version AS text_version,
                                   ${ftsQuery ? 'bm25(artifact_search)' : '0'} AS rank
                            FROM versions
                            JOIN artifacts ON artifacts.id = versions.artifact_id
                            ${ftsQuery ? 'JOIN artifact_search ON artifact_search.version_id = versions.id' : ''}
                            WHERE ${conditions.join(' AND ')}`;
    const sql = options?.latestOnly
      ? `WITH eligible AS (${eligibleSelect}),
              ranked AS (
                SELECT id,
                       ROW_NUMBER() OVER (
                         PARTITION BY kind, owner, name
                         ORDER BY numeric_version DESC, text_version DESC, id
                       ) AS identity_rank,
                       rank,
                       kind,
                       owner,
                       name,
                       numeric_version,
                       text_version
                FROM eligible
              )
         SELECT id, rank, kind, owner, name, numeric_version, text_version
         FROM ranked
         WHERE identity_rank = 1${cursorCondition}
         ORDER BY rank, kind, owner, name, numeric_version DESC, text_version DESC, id
         LIMIT ?`
      : `WITH eligible AS (${eligibleSelect})
         SELECT id, rank, kind, owner, name, numeric_version, text_version
         FROM eligible
         WHERE 1 = 1${cursorCondition}
         ORDER BY rank, kind, owner, name, numeric_version DESC, text_version DESC, id
         LIMIT ?`;
    const { results } = await db
      .prepare(sql)
      .bind(...bindings, ...cursorBindings, limit + 1)
      .all<StoredCursorRow>();
    const pageRows = results.slice(0, limit);
    const artifacts = await Promise.all(
      pageRows.map(row => {
        return kv.get(artifactKey(row.id)).then(raw => (raw ? (JSON.parse(raw) as ArtifactVersion) : undefined));
      }),
    );
    return {
      artifacts: artifacts.filter((artifact): artifact is ArtifactVersion => Boolean(artifact)),
      ...(results.length > limit && pageRows.at(-1) ? { nextCursor: encodeStoredCursor(pageRows.at(-1)!) } : {}),
    };
  }
}

type UserRow = { id: string; handle: string; admin: number };
type TokenRow = { id: string; user_id: string; name: string; secret_hash: string; revoked: number };

function rowToUser(row: UserRow): { id: string; handle: string; admin: boolean } {
  return { id: row.id, handle: row.handle, admin: Boolean(row.admin) };
}

function rowToToken(row: TokenRow): TokenRecord {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    secretHash: row.secret_hash,
    revoked: Boolean(row.revoked),
  };
}

function requireBinding<T>(binding: T | undefined, name: string): T {
  if (!binding) {
    throw new Error(`Missing Cloudflare ${name} binding`);
  }
  return binding;
}

function artifactKey(id: string): string {
  return `artifact:${id}`;
}

function sessionKey(session: string): string {
  return `session:${session}`;
}

function objectMetaKey(ref: ObjectRef): string {
  return `object:${objectKey(ref)}`;
}

function uploadSessionKey(uploadId: string): string {
  return `upload:${uploadId}`;
}

function objectKey(ref: ObjectRef): string {
  return `${ref.bucket}/${ref.key}/${ref.sha256}/${ref.size}`;
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

function artifactObjectEntries(artifact: ArtifactVersion): Array<[string, ObjectRef]> {
  return [
    ['object', artifact.object],
    ['manifest', artifact.artifactObjects?.manifest],
    ['readme', artifact.artifactObjects?.readme],
    ['bundle', artifact.artifactObjects?.bundle],
    ['archive', artifact.artifactObjects?.archive],
  ].filter((entry): entry is [string, ObjectRef] => Boolean(entry[1]));
}

function normalizeLimit(limit: number | undefined): number {
  return typeof limit === 'number' && Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : 100;
}

type StoredCursorRow = {
  id: string;
  rank: number;
  kind: string;
  owner: string;
  name: string;
  numeric_version: number;
  text_version: string;
};

function encodeStoredCursor(row: StoredCursorRow): string {
  return btoa(JSON.stringify(row));
}

function decodeStoredCursor(cursor: string | undefined): StoredCursorRow | undefined {
  if (!cursor) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(atob(cursor)) as Partial<StoredCursorRow>;
    return typeof parsed.id === 'string' &&
      typeof parsed.rank === 'number' &&
      typeof parsed.kind === 'string' &&
      typeof parsed.owner === 'string' &&
      typeof parsed.name === 'string' &&
      typeof parsed.numeric_version === 'number' &&
      typeof parsed.text_version === 'string'
      ? {
          id: parsed.id,
          rank: parsed.rank,
          kind: parsed.kind,
          owner: parsed.owner,
          name: parsed.name,
          numeric_version: parsed.numeric_version,
          text_version: parsed.text_version,
        }
      : undefined;
  } catch {
    return undefined;
  }
}

function storedCursorCondition(): string {
  return `(rank > ? OR
    (rank = ? AND kind > ?) OR
    (rank = ? AND kind = ? AND owner > ?) OR
    (rank = ? AND kind = ? AND owner = ? AND name > ?) OR
    (rank = ? AND kind = ? AND owner = ? AND name = ? AND numeric_version < ?) OR
    (rank = ? AND kind = ? AND owner = ? AND name = ? AND numeric_version = ? AND text_version < ?) OR
    (rank = ? AND kind = ? AND owner = ? AND name = ? AND numeric_version = ? AND text_version = ? AND id > ?))`;
}

function storedCursorBindings(cursor: StoredCursorRow): unknown[] {
  return [
    cursor.rank,
    cursor.rank,
    cursor.kind,
    cursor.rank,
    cursor.kind,
    cursor.owner,
    cursor.rank,
    cursor.kind,
    cursor.owner,
    cursor.name,
    cursor.rank,
    cursor.kind,
    cursor.owner,
    cursor.name,
    cursor.numeric_version,
    cursor.rank,
    cursor.kind,
    cursor.owner,
    cursor.name,
    cursor.numeric_version,
    cursor.text_version,
    cursor.rank,
    cursor.kind,
    cursor.owner,
    cursor.name,
    cursor.numeric_version,
    cursor.text_version,
    cursor.id,
  ];
}
