import type {
  ArtifactObjects,
  ArtifactPublish,
  ArtifactVersion,
  BatchResolveRequest,
  BatchResolveResponse,
  ObjectRef,
} from '@cyanprint/contracts';
import type { TokenRecord } from '@cyanprint/registry-client';

export type MaybePromise<T> = T | Promise<T>;

export type ArtifactSearchArgs = {
  cursor?: string;
  kind?: string;
  limit?: number;
  query?: string;
};

export type ArtifactSearchPage = {
  artifacts: ArtifactVersion[];
  nextCursor?: string;
};

export type RegistryStorage = {
  mode: 'cloudflare-bindings' | 'in-memory';
  bindings: Array<'D1' | 'R2' | 'KV'>;
  getCurrentUser(): MaybePromise<{ id: string; handle: string; admin?: boolean } | undefined>;
  getUser(id: string): MaybePromise<{ id: string; handle: string; admin?: boolean } | undefined>;
  listUsers(): MaybePromise<Array<{ id: string; handle: string; admin?: boolean }>>;
  createSession(userId: string, session: string): MaybePromise<void>;
  getSessionUser(session: string): MaybePromise<{ id: string; handle: string; admin?: boolean } | undefined>;
  createToken(record: TokenRecord): MaybePromise<void>;
  listTokens(): MaybePromise<TokenRecord[]>;
  findTokenByHash(secretHash: string): MaybePromise<TokenRecord | undefined>;
  listArtifacts(kind?: string): MaybePromise<ArtifactVersion[]>;
  searchArtifacts(args?: ArtifactSearchArgs): MaybePromise<ArtifactSearchPage>;
  listLatestArtifacts(args?: ArtifactSearchArgs): MaybePromise<ArtifactSearchPage>;
  listModerationArtifacts(args?: ArtifactSearchArgs): MaybePromise<ArtifactSearchPage>;
  getArtifact(id: string): MaybePromise<ArtifactVersion | undefined>;
  getArtifactByIdentity(kind: string, owner: string, name: string): MaybePromise<ArtifactVersion | undefined>;
  listArtifactVersions(kind: string, owner: string, name: string): MaybePromise<ArtifactVersion[]>;
  getActiveArtifactByObjectRef(ref: ObjectRef): MaybePromise<ArtifactVersion | undefined>;
  addArtifact(artifact: ArtifactVersion): MaybePromise<void>;
  commitArtifact(artifact: ArtifactPublish): MaybePromise<ArtifactVersion>;
  likeArtifact(id: string, userId: string): MaybePromise<ArtifactVersion | undefined>;
  recordDownload(ref: ObjectRef): MaybePromise<ArtifactVersion | undefined>;
  putObject(ref: ObjectRef, payload: string): MaybePromise<void>;
  getObject(ref: ObjectRef): MaybePromise<string | undefined>;
  hasObjectRef(ref: ObjectRef): MaybePromise<boolean>;
  hasVersionPin(pin: ArtifactVersion['resolvedPins'][number]): MaybePromise<boolean>;
  batchResolve(request: BatchResolveRequest): MaybePromise<BatchResolveResponse>;
  disableArtifact(id: string): MaybePromise<ArtifactVersion | undefined>;
  saveUploadSession(upload: StoredUploadSession): MaybePromise<void>;
  getUploadSession(uploadId: string): MaybePromise<StoredUploadSession | undefined>;
  deleteUploadSession(uploadId: string): MaybePromise<void>;
  putObjectBytes(ref: ObjectRef, payload: Uint8Array): MaybePromise<void>;
  getObjectBytes(ref: ObjectRef): MaybePromise<Uint8Array | undefined>;
};

export type StoredUploadSession = {
  id: string;
  userId: string;
  kind: string;
  owner: string;
  name: string;
  objects: ArtifactObjects;
  expiresAt: string;
};
