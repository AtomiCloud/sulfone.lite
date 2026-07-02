import type {
  ArtifactObjects,
  ArtifactPublish,
  ArtifactVersion,
  BatchResolveRequest,
  BatchResolveResponse,
  ObjectRef,
} from '@cyanprint/contracts';
import type { TokenRecord } from '@cyanprint/registry-client';

type MaybePromise<T> = T | Promise<T>;

type ArtifactSearchArgs = {
  cursor?: string;
  kind?: string;
  limit?: number;
  query?: string;
};

type ArtifactSearchPage = {
  artifacts: ArtifactVersion[];
  nextCursor?: string;
};

export type RegistryStorage = {
  mode: 'cloudflare-bindings' | 'in-memory';
  bindings: Array<'D1' | 'R2' | 'KV'>;
  getCurrentUser(): MaybePromise<RegistryUser | undefined>;
  getUser(id: string): MaybePromise<RegistryUser | undefined>;
  upsertUser(user: RegistryUser): MaybePromise<void>;
  updateUserHandle(userId: string, handle: string): MaybePromise<'updated' | 'duplicate' | 'immutable' | 'not_found'>;
  listUsers(): MaybePromise<RegistryUser[]>;
  createSession(userId: string, session: string): MaybePromise<void>;
  getSessionUser(session: string): MaybePromise<RegistryUser | undefined>;
  deleteSession(session: string): MaybePromise<void>;
  saveOAuthState(state: StoredOAuthState): MaybePromise<void>;
  consumeOAuthState(id: string): MaybePromise<StoredOAuthState | undefined>;
  saveAuthHandoff(handoff: StoredAuthHandoff): MaybePromise<void>;
  consumeAuthHandoff(id: string): MaybePromise<StoredAuthHandoff | undefined>;
  createToken(record: TokenRecord): MaybePromise<void>;
  listTokens(): MaybePromise<TokenRecord[]>;
  listTokensForUser(userId: string): MaybePromise<TokenRecord[]>;
  revokeTokenForUser(userId: string, tokenId: string): MaybePromise<void>;
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

export type RegistryUser = {
  id: string;
  handle: string | null;
  login?: string;
  admin?: boolean;
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

export type StoredOAuthState = {
  id: string;
  returnTo: string;
  expiresAt: string;
};

export type StoredAuthHandoff = {
  id: string;
  session: string;
  userId: string;
  expiresAt: string;
};
