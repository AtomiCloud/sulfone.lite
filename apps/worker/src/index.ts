import { Hono } from 'hono';
import type { Context } from 'hono';
import YAML from 'yaml';
import { decompress } from 'fzstd';
import {
  ArtifactPublishSchema,
  artifactIntegrity,
  ObjectRefSchema,
  isSafeArchivePath,
  normalizeArchivePath,
  parseCyanManifest,
  validateTemplateTarPayload,
  type ArtifactPublish,
  type ArtifactObjects,
  type ArtifactVersion,
  type BatchResolveRequest,
  type ArtifactDependency,
  type CyanManifest,
  type ObjectRef,
} from '@cyanprint/contracts';
import { storage as defaultStorage } from './state';
import { createCloudflareBindingStorage, type WorkerBindings } from './storage/cloudflare-binding-storage';
import type { RegistryStorage, RegistryUser, StoredUploadSession } from './storage/types';
import { problemResponse } from './http/problem';
import { cyanprintSessionCookieName, isActiveArtifact, readCookie } from '@cyanprint/registry-client';

type AppContext = Context<{ Bindings: WorkerBindings }>;
type StorageSource = RegistryStorage | ((env: WorkerBindings) => RegistryStorage);
type UploadPartName = keyof ArtifactObjects;
type GitHubUser = {
  id: number;
  login: string;
};

async function sha256Hex(content: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256Bytes(content: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', toArrayBuffer(content));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function toArrayBuffer(content: Uint8Array): ArrayBuffer {
  return content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength) as ArrayBuffer;
}

async function requireToken(storage: RegistryStorage, c: { req: { header(name: string): string | undefined } }) {
  const header = c.req.header('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
  return token ? storage.findTokenByHash(await sha256Hex(token)) : undefined;
}

async function requireUser(storage: RegistryStorage, c: { req: { header(name: string): string | undefined } }) {
  const session = c.req.header('x-cyanprint-session') ?? readCookie(c.req.header('cookie'), cyanprintSessionCookieName);
  return session ? storage.getSessionUser(session) : undefined;
}

async function requireAdminToken(
  storage: RegistryStorage,
  c: { env?: WorkerBindings; req: { header(name: string): string | undefined } },
) {
  const token = await requireToken(storage, c);
  if (!token) {
    return undefined;
  }
  const user = await storage.getUser(token.userId);
  return isEffectiveAdmin(user, c.env) ? { token, user } : undefined;
}

async function validateArtifactInput(storage: RegistryStorage, artifact: ArtifactPublish): Promise<string | undefined> {
  if (!artifact.object && !artifact.artifactObjects) {
    return 'artifact versions require uploaded object refs';
  }
  if (artifact.object && !(await storage.hasObjectRef(artifact.object))) {
    return 'object ref is missing, empty, or has invalid integrity';
  }
  if (artifact.artifactObjects) {
    for (const ref of artifactObjectRefs(artifact.artifactObjects)) {
      if (!(await storage.hasObjectRef(ref))) {
        return `artifact object ref is missing, empty, or has invalid integrity: ${ref.key}`;
      }
    }
  }
  for (const pin of artifact.resolvedPins) {
    if (!(await storage.hasVersionPin(pin))) {
      return `resolved pin does not point at a committed active version: ${pin.kind}:${pin.owner}:${pin.name}@${pin.version}`;
    }
  }
  return undefined;
}

async function validateArtifactPackage(
  storage: RegistryStorage,
  artifact: ArtifactPublish,
): Promise<string | undefined> {
  if (artifact.artifactObjects) {
    return validateFolderArtifactObjects(storage, artifact);
  }
  if (!artifact.object) {
    return 'artifact versions require an uploaded object ref';
  }
  const payload = await storage.getObject(artifact.object);
  if (!payload) {
    return 'artifact object payload is missing';
  }
  let parsed: { files?: Array<{ path?: unknown; content?: unknown }> };
  try {
    parsed = JSON.parse(payload) as { cyanprint?: unknown; files?: Array<{ path?: unknown; content?: unknown }> };
  } catch {
    return 'artifact object payload is not a valid CyanPrint package';
  }
  const packageError = validateLocalObjectPackage(parsed);
  if (packageError) {
    return packageError;
  }
  const manifestFile = parsed.files?.find(file => file.path === 'cyan.yaml');
  if (typeof manifestFile?.content !== 'string') {
    return 'artifact object payload is missing cyan.yaml';
  }
  let manifest;
  try {
    manifest = parseCyanManifest(YAML.parse(manifestFile.content) as unknown).manifest;
  } catch {
    return 'artifact object cyan.yaml is invalid';
  }
  return validateManifestPublishMetadata(manifest, artifact, 'artifact object cyan.yaml');
}

async function validateFolderArtifactObjects(
  storage: RegistryStorage,
  artifact: ArtifactPublish,
): Promise<string | undefined> {
  const objects = artifact.artifactObjects;
  if (!objects) {
    return 'artifact object refs are missing';
  }
  const manifestPayload = await storage.getObject(objects.manifest);
  if (!manifestPayload) {
    return 'artifact manifest object payload is missing';
  }
  let manifest;
  try {
    manifest = parseCyanManifest(YAML.parse(manifestPayload) as unknown).manifest;
  } catch {
    return 'artifact cyan.yaml is invalid';
  }
  const manifestError = validateManifestPublishMetadata(manifest, artifact, 'artifact cyan.yaml');
  if (manifestError) {
    return manifestError;
  }
  if (!(await storage.hasObjectRef(objects.bundle))) {
    return 'artifact bundled script object payload is missing';
  }
  if (
    (artifact.kind === 'template' || artifact.kind === 'template-group') &&
    !artifact.scriptOnly &&
    !objects.archive
  ) {
    return 'template artifacts require an archive object unless scriptOnly is true';
  }
  if (objects.archive) {
    const archivePayload = await storage.getObjectBytes(objects.archive);
    if (!archivePayload) {
      return 'artifact archive object payload is missing';
    }
    const archiveError = validateTemplateArchivePayloadBytes(archivePayload);
    if (archiveError) {
      return archiveError;
    }
  }
  if (objects.readme && !(await storage.hasObjectRef(objects.readme))) {
    return 'artifact README object payload is missing';
  }
  return undefined;
}

function validateManifestPublishMetadata(
  manifest: CyanManifest,
  artifact: ArtifactPublish,
  label: string,
): string | undefined {
  if (manifest.kind !== artifact.kind || manifest.owner !== artifact.owner || manifest.name !== artifact.name) {
    return `${label} identity does not match publish metadata`;
  }
  if (manifest.version) {
    return `${label} must not declare a version for registry-assigned publish`;
  }
  const declared = declaredArtifactDependencies(manifest).map(ref => ({
    ...ref,
    owner: ref.owner ?? manifest.owner,
  }));
  const declaredDependencyKeys = new Set(declared.map(ref => dependencyIdentityKey(ref, true)));
  const artifactDependencyKeys = new Set(
    artifact.dependencies.map(ref => dependencyIdentityKey({ ...ref, owner: ref.owner ?? manifest.owner }, true)),
  );
  const pinKeys = new Set(
    artifact.resolvedPins.flatMap(pin => [
      dependencyIdentityKey(pin),
      dependencyIdentityKey(pin, Boolean(pin.version)),
    ]),
  );
  const declaredPinKeys = new Set(declared.map(ref => dependencyIdentityKey(ref, Boolean(ref.version))));
  for (const dependency of artifactDependencyKeys) {
    if (!declaredDependencyKeys.has(dependency)) {
      return `artifact metadata contains undeclared dependency: ${dependency}`;
    }
  }
  for (const pin of artifact.resolvedPins) {
    const pinKey = dependencyIdentityKey(pin, true);
    const pinBaseKey = dependencyIdentityKey(pin);
    if (!declaredPinKeys.has(pinKey) && !declaredPinKeys.has(pinBaseKey)) {
      return `artifact resolved pins contain undeclared dependency: ${pinKey}`;
    }
  }
  for (const dependency of declared) {
    const metadataKey = dependencyIdentityKey(dependency, true);
    const pinKey = dependencyIdentityKey(dependency, Boolean(dependency.version));
    if (!artifactDependencyKeys.has(metadataKey)) {
      return `artifact metadata is missing declared dependency: ${metadataKey}`;
    }
    if (!pinKeys.has(pinKey)) {
      return `artifact resolved pins are missing declared dependency: ${pinKey}`;
    }
  }
  return undefined;
}

function validateLocalObjectPackage(input: {
  cyanprint?: unknown;
  files?: Array<{ path?: unknown; content?: unknown }>;
}): string | undefined {
  if (input.cyanprint !== 4) {
    return 'artifact object package must declare cyanprint: 4';
  }
  if (!Array.isArray(input.files) || input.files.length === 0) {
    return 'artifact object package requires files';
  }
  const seenPaths = new Set<string>();
  for (const file of input.files) {
    if (typeof file.path !== 'string' || typeof file.content !== 'string') {
      return 'artifact object package has an invalid file entry';
    }
    if (!isSafePackagePath(file.path)) {
      return `artifact object package has an unsafe file path: ${file.path}`;
    }
    const normalizedPath = normalizePackagePath(file.path);
    if (seenPaths.has(normalizedPath)) {
      return `artifact object package has a duplicate file path: ${file.path}`;
    }
    seenPaths.add(normalizedPath);
  }
  return undefined;
}

function validateTemplateArchivePayloadBytes(payload: Uint8Array): string | undefined {
  if (payload.byteLength === 0) {
    return 'template archive payload is empty';
  }
  if (isTarArchive(payload)) {
    return validateTemplateTarPayload(payload);
  }
  if (isZstdFrame(payload)) {
    try {
      return validateTemplateTarPayload(decompress(payload));
    } catch {
      return 'template archive payload is not a valid tar.zst archive';
    }
  }
  if (looksLikeLegacyJsonArchive(payload)) {
    return undefined;
  }
  return 'template archive payload is not a tar.zst archive';
}

function isZstdFrame(payload: Uint8Array): boolean {
  return payload[0] === 0x28 && payload[1] === 0xb5 && payload[2] === 0x2f && payload[3] === 0xfd;
}

function isTarArchive(payload: Uint8Array): boolean {
  if (payload.byteLength < 512) {
    return false;
  }
  const magic = new TextDecoder().decode(payload.slice(257, 262));
  return magic === 'ustar';
}

function looksLikeLegacyJsonArchive(payload: Uint8Array): boolean {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(payload);
    const parsed = JSON.parse(text) as {
      cyanArchive?: unknown;
      files?: Array<{ path?: unknown; bytesBase64?: unknown }>;
    };
    return parsed.cyanArchive === 1 && Array.isArray(parsed.files) && !validateLegacyJsonArchive(parsed);
  } catch {
    return false;
  }
}

function validateLegacyJsonArchive(input: {
  cyanArchive?: unknown;
  files?: Array<{ path?: unknown; bytesBase64?: unknown }>;
}): string | undefined {
  if (input.cyanArchive !== 1 || !Array.isArray(input.files) || input.files.length === 0) {
    return 'template archive payload is not a valid CyanPrint archive';
  }
  const seenPaths = new Set<string>();
  for (const file of input.files) {
    if (typeof file.path !== 'string' || typeof file.bytesBase64 !== 'string') {
      return 'template archive payload has an invalid file entry';
    }
    if (!isSafePackagePath(file.path)) {
      return `template archive payload has an unsafe file path: ${file.path}`;
    }
    const normalizedPath = normalizePackagePath(file.path);
    if (seenPaths.has(normalizedPath)) {
      return `template archive payload has a duplicate file path: ${file.path}`;
    }
    seenPaths.add(normalizedPath);
    try {
      atob(file.bytesBase64);
    } catch {
      return `template archive payload has invalid base64 for file: ${file.path}`;
    }
  }
  return undefined;
}

function isSafePackagePath(path: string): boolean {
  return isSafeArchivePath(path);
}

function normalizePackagePath(path: string): string {
  return normalizeArchivePath(path);
}

function declaredArtifactDependencies(manifest: {
  templates: ArtifactDependency[];
  processors: ArtifactDependency[];
  plugins: ArtifactDependency[];
  resolvers: ArtifactDependency[];
}): ArtifactDependency[] {
  return [...manifest.templates, ...manifest.processors, ...manifest.plugins, ...manifest.resolvers];
}

function dependencyIdentityKey(
  ref: { kind: string; owner?: string; name: string; version?: string },
  includeVersion = false,
): string {
  return `${ref.kind}:${ref.owner ?? ''}:${ref.name}${includeVersion ? `:${ref.version ?? ''}` : ''}`;
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 100) : fallback;
}

function artifactObjectRefs(objects: ArtifactObjects): ObjectRef[] {
  return [objects.manifest, objects.readme, objects.bundle, objects.archive].filter((ref): ref is ObjectRef =>
    Boolean(ref),
  );
}

function isDownloadCountingRef(artifact: ArtifactVersion, ref: ObjectRef): boolean {
  const primaryRef = artifact.object ?? artifact.artifactObjects?.archive ?? artifact.artifactObjects?.bundle;
  return Boolean(primaryRef && objectRefsMatch(primaryRef, ref));
}

function objectRefsMatch(left: ObjectRef, right: ObjectRef): boolean {
  return (
    left.bucket === right.bucket && left.key === right.key && left.sha256 === right.sha256 && left.size === right.size
  );
}

function uploadObjectRef(
  kind: string,
  owner: string,
  name: string,
  uploadId: string,
  part: UploadPartName,
  spec: { sha256?: string; size?: number },
): ObjectRef {
  if (!spec.sha256 || typeof spec.size !== 'number') {
    throw new Error(`Upload part ${part} requires sha256 and size.`);
  }
  const fileName =
    part === 'manifest'
      ? 'cyan.yaml'
      : part === 'readme'
        ? 'README.md'
        : part === 'archive'
          ? 'template.tar.zst'
          : 'bundle.js';
  return {
    bucket: 'cyanprint-local-r2',
    key: `${kind}/${owner}/${name}/${uploadId}/${part}/${fileName}`,
    sha256: spec.sha256,
    size: spec.size,
  };
}

function isValidUploadObjectSpec(spec: { sha256?: string; size?: number } | undefined): boolean {
  return Boolean(
    spec &&
    typeof spec.sha256 === 'string' &&
    /^[a-f0-9]{64}$/i.test(spec.sha256) &&
    typeof spec.size === 'number' &&
    Number.isInteger(spec.size) &&
    spec.size >= 0,
  );
}

async function canPublishArtifact(
  storage: RegistryStorage,
  token: { userId: string },
  artifact: ArtifactPublish,
  env?: WorkerBindings,
): Promise<boolean> {
  const user = await storage.getUser(token.userId);
  return Boolean(isEffectiveAdmin(user, env) || user?.handle === artifact.owner);
}

async function canWriteObject(
  storage: RegistryStorage,
  token: { userId: string },
  ref: ObjectRef,
  env?: WorkerBindings,
): Promise<boolean> {
  const user = await storage.getUser(token.userId);
  const owner = ref.key.split('/')[1];
  return Boolean(isEffectiveAdmin(user, env) || user?.handle === owner);
}

function resolveStorage(source: StorageSource, c: AppContext): RegistryStorage {
  return typeof source === 'function' ? source(c.env ?? {}) : source;
}

function isBatchResolveRequest(input: unknown): input is BatchResolveRequest {
  if (!input || typeof input !== 'object' || !Array.isArray((input as { refs?: unknown }).refs)) {
    return false;
  }
  return (input as { refs: unknown[] }).refs.every(
    ref =>
      Boolean(ref) &&
      typeof ref === 'object' &&
      typeof (ref as { kind?: unknown }).kind === 'string' &&
      typeof (ref as { name?: unknown }).name === 'string' &&
      ((ref as { owner?: unknown }).owner === undefined || typeof (ref as { owner?: unknown }).owner === 'string') &&
      ((ref as { version?: unknown }).version === undefined ||
        typeof (ref as { version?: unknown }).version === 'string'),
  );
}

function legacyPackageApiEnabled(storage: RegistryStorage, c: AppContext): boolean {
  return c.env?.CYANPRINT_ENABLE_LEGACY_PACKAGE_API === '1' || storage.mode === 'in-memory';
}

function randomToken(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
}

function expiresIn(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

function githubAdminLogins(env: WorkerBindings): Set<string> {
  return new Set(
    (env.CYANPRINT_GITHUB_ADMIN_LOGINS ?? '')
      .split(',')
      .map(login => login.trim().toLowerCase())
      .filter(Boolean),
  );
}

function isEffectiveAdmin(user: RegistryUser | undefined, env: WorkerBindings | undefined): boolean {
  if (!user?.admin) {
    return false;
  }
  const login = (user.login ?? user.handle).toLowerCase();
  return !user.id.startsWith('github:') || githubAdminLogins(env ?? {}).has(login);
}

function normalizeGitHubHandle(login: string): string {
  return normalizeHandle(login);
}

function normalizeHandle(value: string): string {
  return value.trim().toLowerCase();
}

function validateHandle(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const handle = normalizeHandle(value);
  return /^[a-z0-9][a-z0-9-]{2,38}$/.test(handle) ? handle : undefined;
}

async function availableHandle(storage: RegistryStorage, preferred: string, userId: string): Promise<string> {
  const users = await storage.listUsers();
  if (!users.some(user => user.id !== userId && user.handle === preferred)) {
    return preferred;
  }
  const suffix = userId.replace(/^github:/, '').slice(-8);
  const fallback = `${preferred.slice(0, Math.max(1, 39 - suffix.length - 1))}-${suffix}`;
  return users.some(user => user.id !== userId && user.handle === fallback) ? `github-${suffix}` : fallback;
}

function publicUser(user: RegistryUser, env?: WorkerBindings) {
  return {
    id: user.id,
    handle: user.handle,
    login: user.login,
    admin: isEffectiveAdmin(user, env),
  };
}

function allowedReturnOrigins(env: WorkerBindings, requestOrigin: string): Set<string> {
  return new Set(
    [env.CYANPRINT_WEB_URL, env.CYANPRINT_AUTH_RETURN_ORIGINS, 'https://cyanprint.dev', requestOrigin]
      .filter(Boolean)
      .flatMap(value => String(value).split(','))
      .map(value => value.trim().replace(/\/$/, ''))
      .filter(Boolean),
  );
}

function validateReturnTo(env: WorkerBindings, requestOrigin: string, value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const url = new URL(value);
    return allowedReturnOrigins(env, requestOrigin).has(url.origin) ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function redirectWithAuthError(c: AppContext, returnTo: string | undefined, code: string): Response {
  if (!returnTo) {
    return problemResponse(c, 401, 'auth', code, 'GitHub authentication failed.');
  }
  const url = new URL(returnTo);
  url.searchParams.set('error', code);
  return c.redirect(url.toString(), 302);
}

async function exchangeGitHubCode(env: WorkerBindings, origin: string, code: string): Promise<string | undefined> {
  if (!env.CYANPRINT_GITHUB_CLIENT_ID || !env.CYANPRINT_GITHUB_CLIENT_SECRET) {
    return undefined;
  }
  const response = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': 'cyanprint-registry',
    },
    body: new URLSearchParams({
      client_id: env.CYANPRINT_GITHUB_CLIENT_ID,
      client_secret: env.CYANPRINT_GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: `${origin}/auth/github/callback`,
    }),
  });
  if (!response.ok) {
    return undefined;
  }
  const body = (await response.json().catch(() => ({}))) as { access_token?: string };
  return body.access_token;
}

async function fetchGitHubUser(accessToken: string): Promise<GitHubUser | undefined> {
  const response = await fetch('https://api.github.com/user', {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${accessToken}`,
      'user-agent': 'cyanprint-registry',
      'x-github-api-version': '2022-11-28',
    },
  });
  if (!response.ok) {
    return undefined;
  }
  const body = (await response.json().catch(() => ({}))) as Partial<GitHubUser>;
  return typeof body.id === 'number' && typeof body.login === 'string' ? { id: body.id, login: body.login } : undefined;
}

export function createApp(source: StorageSource): Hono<{ Bindings: WorkerBindings }> {
  const app = new Hono<{ Bindings: WorkerBindings }>();

  app.get('/health', c => {
    const storage = resolveStorage(source, c);
    return c.json({ ok: true, bindings: storage.bindings, mode: storage.mode });
  });

  app.get('/me', async c => {
    const storage = resolveStorage(source, c);
    const user = await requireUser(storage, c);
    if (!user) {
      return problemResponse(c, 401, 'auth', 'missing_session', 'A local authenticated session is required.');
    }
    return c.json({ user: publicUser(user, c.env) });
  });

  app.patch('/me', async c => {
    const storage = resolveStorage(source, c);
    const user = await requireUser(storage, c);
    if (!user) {
      return problemResponse(c, 401, 'auth', 'missing_session', 'A local authenticated session is required.');
    }
    const body = (await c.req.json().catch(() => ({}))) as { handle?: unknown };
    const handle = validateHandle(body.handle);
    if (!handle) {
      return problemResponse(
        c,
        400,
        'validation',
        'invalid_handle',
        'Handle must be 3-39 lowercase letters, numbers, or hyphens, and start with a letter or number.',
      );
    }
    const updated = await storage.updateUserHandle(user.id, handle);
    if (updated === 'duplicate') {
      return problemResponse(c, 409, 'validation', 'handle_taken', 'That CyanPrint username is already taken.');
    }
    if (updated === 'not_found') {
      return problemResponse(c, 404, 'not_found', 'user_not_found', 'Authenticated user was not found.');
    }
    const next = await storage.getUser(user.id);
    return c.json({ user: publicUser(next ?? { ...user, handle }, c.env) });
  });

  app.get('/users', async c => {
    const storage = resolveStorage(source, c);
    const user = await requireUser(storage, c);
    if (!user) {
      return problemResponse(c, 401, 'auth', 'missing_session', 'A local authenticated session is required.');
    }
    const users = await storage.listUsers();
    return c.json({ users: users.map(user => publicUser(user, c.env)) });
  });

  app.post('/auth/local-session', async c => {
    const storage = resolveStorage(source, c);
    const localDevSecret = c.env?.CYANPRINT_LOCAL_DEV_SECRET;
    if (
      c.env?.CYANPRINT_ENABLE_LOCAL_AUTH !== '1' ||
      !localDevSecret ||
      c.req.header('x-cyanprint-dev-secret') !== localDevSecret
    ) {
      return problemResponse(c, 401, 'auth', 'invalid_dev_secret', 'A valid local dev secret is required.');
    }
    const body = (await c.req.json().catch(() => ({}))) as { userId?: string };
    const user = body.userId ? await storage.getUser(body.userId) : await storage.getCurrentUser();
    if (!user) {
      return problemResponse(c, 404, 'not_found', 'user_not_found', 'Local user not found.');
    }
    const session = `cps_${crypto.randomUUID().replaceAll('-', '')}`;
    await storage.createSession(user.id, session);
    return c.json({ session, user: publicUser(user, c.env) });
  });

  app.get('/auth/github/start', async c => {
    const storage = resolveStorage(source, c);
    const origin = new URL(c.req.url).origin;
    const returnTo = validateReturnTo(c.env ?? {}, origin, c.req.query('return_to'));
    if (!returnTo) {
      return problemResponse(c, 400, 'auth', 'invalid_return_to', 'A valid return_to URL is required.');
    }
    if (!c.env?.CYANPRINT_GITHUB_CLIENT_ID || !c.env.CYANPRINT_GITHUB_CLIENT_SECRET) {
      return problemResponse(c, 503, 'auth', 'github_oauth_not_configured', 'GitHub OAuth is not configured.');
    }
    const state = randomToken('cpo');
    await storage.saveOAuthState({ id: state, returnTo, expiresAt: expiresIn(10 * 60) });
    const authorize = new URL('https://github.com/login/oauth/authorize');
    authorize.searchParams.set('client_id', c.env.CYANPRINT_GITHUB_CLIENT_ID);
    authorize.searchParams.set('redirect_uri', `${origin}/auth/github/callback`);
    authorize.searchParams.set('state', state);
    authorize.searchParams.set('scope', 'read:user');
    return c.redirect(authorize.toString(), 302);
  });

  app.get('/auth/github/callback', async c => {
    const storage = resolveStorage(source, c);
    const stateId = c.req.query('state');
    const code = c.req.query('code');
    const state = stateId ? await storage.consumeOAuthState(stateId) : undefined;
    if (!state || !code) {
      return redirectWithAuthError(c, state?.returnTo, 'invalid_oauth_state');
    }
    const origin = new URL(c.req.url).origin;
    const accessToken = await exchangeGitHubCode(c.env ?? {}, origin, code);
    const githubUser = accessToken ? await fetchGitHubUser(accessToken) : undefined;
    if (!githubUser) {
      return redirectWithAuthError(c, state.returnTo, 'github_login_failed');
    }
    const id = `github:${githubUser.id}`;
    const login = normalizeGitHubHandle(githubUser.login);
    const existing = await storage.getUser(id);
    const handle = existing?.handle ?? (await availableHandle(storage, login, id));
    const admin = githubAdminLogins(c.env ?? {}).has(login);
    const user = { id, handle, login, admin };
    await storage.upsertUser(user);
    const session = randomToken('cps');
    await storage.createSession(user.id, session);
    const handoff = randomToken('cph');
    await storage.saveAuthHandoff({ id: handoff, userId: user.id, session, expiresAt: expiresIn(2 * 60) });
    const redirectTo = new URL(state.returnTo);
    redirectTo.searchParams.set('handoff', handoff);
    return c.redirect(redirectTo.toString(), 302);
  });

  app.post('/auth/github/consume', async c => {
    const storage = resolveStorage(source, c);
    const body = (await c.req.json().catch(() => ({}))) as { handoff?: string };
    const handoff = body.handoff ? await storage.consumeAuthHandoff(body.handoff) : undefined;
    if (!handoff) {
      return problemResponse(c, 401, 'auth', 'invalid_auth_handoff', 'GitHub auth handoff is invalid or expired.');
    }
    const user = await storage.getUser(handoff.userId);
    if (!user) {
      return problemResponse(c, 404, 'not_found', 'user_not_found', 'Authenticated user was not found.');
    }
    return c.json({
      session: handoff.session,
      user: publicUser(user, c.env),
    });
  });

  app.post('/auth/logout', async c => {
    const storage = resolveStorage(source, c);
    const session =
      c.req.header('x-cyanprint-session') ?? readCookie(c.req.header('cookie'), cyanprintSessionCookieName);
    if (session) {
      await storage.deleteSession(session);
    }
    return c.json({ ok: true });
  });

  app.post('/tokens', async c => {
    const storage = resolveStorage(source, c);
    const user = await requireUser(storage, c);
    if (!user) {
      return problemResponse(
        c,
        401,
        'auth',
        'missing_session',
        'A local authenticated user is required to mint tokens.',
      );
    }
    const body = (await c.req.json().catch(() => ({}))) as { name?: string };
    const token = `cp4_${crypto.randomUUID().replaceAll('-', '')}`;
    const secretHash = await sha256Hex(token);
    const record = {
      id: crypto.randomUUID(),
      userId: user.id,
      name: body.name ?? 'local',
      secretHash,
      revoked: false,
    };
    await storage.createToken(record);
    return c.json({ id: record.id, token });
  });

  app.get('/tokens', async c => {
    const storage = resolveStorage(source, c);
    const user = await requireUser(storage, c);
    if (!user) {
      return problemResponse(
        c,
        401,
        'auth',
        'missing_session',
        'A local authenticated user is required to list tokens.',
      );
    }
    const tokens = await storage.listTokensForUser(user.id);
    return c.json({
      tokens: tokens.map(({ secretHash: _secretHash, ...token }) => token),
    });
  });

  app.delete('/tokens/:id', async c => {
    const storage = resolveStorage(source, c);
    const user = await requireUser(storage, c);
    if (!user) {
      return problemResponse(
        c,
        401,
        'auth',
        'missing_session',
        'A local authenticated user is required to revoke tokens.',
      );
    }
    await storage.revokeTokenForUser(user.id, c.req.param('id'));
    return c.json({ ok: true });
  });

  app.get('/artifacts', async c => {
    const storage = resolveStorage(source, c);
    const kind = c.req.query('kind');
    const query = c.req.query('q')?.trim() ?? '';
    const limit = parsePositiveInteger(c.req.query('limit'), 100);
    return c.json(await storage.searchArtifacts({ cursor: c.req.query('cursor'), kind, limit, query }));
  });

  app.get('/artifacts/latest', async c => {
    const storage = resolveStorage(source, c);
    const kind = c.req.query('kind');
    const query = c.req.query('q')?.trim() ?? '';
    const limit = parsePositiveInteger(c.req.query('limit'), 100);
    return c.json(await storage.listLatestArtifacts({ cursor: c.req.query('cursor'), kind, limit, query }));
  });

  app.get('/artifacts/:kind/:owner/:name', async c => {
    const artifact = await resolveStorage(source, c).getArtifactByIdentity(
      c.req.param('kind'),
      c.req.param('owner'),
      c.req.param('name'),
    );
    if (!artifact) {
      return problemResponse(c, 404, 'not_found', 'artifact_not_found', 'Artifact not found.');
    }
    return c.json({ artifact });
  });

  app.get('/artifacts/:kind/:owner/:name/versions', async c => {
    const artifacts = await resolveStorage(source, c).listArtifactVersions(
      c.req.param('kind'),
      c.req.param('owner'),
      c.req.param('name'),
    );
    return c.json({ artifacts });
  });

  app.get('/admin/artifacts', async c => {
    const storage = resolveStorage(source, c);
    const admin = await requireAdminToken(storage, c);
    if (!admin) {
      return problemResponse(c, 403, 'permission', 'admin_required', 'Admin token required.');
    }
    const kind = c.req.query('kind');
    const query = c.req.query('q')?.trim() ?? '';
    const limit = parsePositiveInteger(c.req.query('limit'), 100);
    const cursor = c.req.query('cursor');
    return c.json(await storage.listModerationArtifacts({ cursor, kind, limit, query }));
  });

  app.post('/uploads/start', async c => {
    const storage = resolveStorage(source, c);
    const token = await requireToken(storage, c);
    if (!token) {
      return problemResponse(c, 401, 'auth', 'missing_token', 'A valid API token is required to start uploads.');
    }
    const body = (await c.req.json().catch(() => undefined)) as
      | {
          kind?: string;
          owner?: string;
          name?: string;
          objects?: Partial<Record<UploadPartName, { sha256?: string; size?: number }>>;
        }
      | undefined;
    if (!body?.kind || !body.owner || !body.name || !body.objects?.manifest || !body.objects.bundle) {
      return problemResponse(
        c,
        400,
        'validation',
        'invalid_upload_start',
        'Upload start requires artifact identity and object specs.',
      );
    }
    const artifactForPermission = {
      kind: body.kind,
      owner: body.owner,
      name: body.name,
      readme: '',
      dependencies: [],
      resolvedPins: [],
      disabled: false,
      moderationState: 'active' as const,
      downloads: 0,
      likes: 0,
    };
    const parsedArtifact = ArtifactPublishSchema.safeParse(artifactForPermission);
    if (!parsedArtifact.success || !(await canPublishArtifact(storage, token, parsedArtifact.data, c.env))) {
      return problemResponse(c, 403, 'permission', 'owner_required', 'Token owner cannot upload this artifact owner.');
    }
    const uploadId = crypto.randomUUID();
    const uploadParts = (['manifest', 'readme', 'bundle', 'archive'] as UploadPartName[]).filter(
      part => body.objects?.[part],
    );
    const invalidPart = uploadParts.find(part => {
      const spec = body.objects?.[part];
      return !isValidUploadObjectSpec(spec);
    });
    if (invalidPart) {
      return problemResponse(
        c,
        400,
        'validation',
        'invalid_upload_part',
        `Upload part ${invalidPart} requires sha256 and size.`,
      );
    }
    const objects = Object.fromEntries(
      uploadParts.map(part => [
        part,
        uploadObjectRef(body.kind!, body.owner!, body.name!, uploadId, part, body.objects![part]!),
      ]),
    ) as ArtifactObjects;
    const upload: StoredUploadSession = {
      id: uploadId,
      userId: token.userId,
      kind: body.kind,
      owner: body.owner,
      name: body.name,
      objects,
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    };
    await storage.saveUploadSession(upload);
    return c.json({
      uploadId,
      objects,
      urls: Object.fromEntries(Object.keys(objects).map(part => [part, `/uploads/${uploadId}/${part}`])),
    });
  });

  app.put('/uploads/:uploadId/:part', async c => {
    const storage = resolveStorage(source, c);
    const token = await requireToken(storage, c);
    if (!token) {
      return problemResponse(c, 401, 'auth', 'missing_token', 'A valid API token is required to upload objects.');
    }
    const upload = await storage.getUploadSession(c.req.param('uploadId'));
    const part = c.req.param('part') as UploadPartName;
    const ref = upload?.objects[part];
    if (!upload || !ref) {
      return problemResponse(c, 404, 'not_found', 'upload_not_found', 'Upload part not found.');
    }
    if (upload.userId !== token.userId) {
      return problemResponse(c, 403, 'permission', 'upload_owner_required', 'Token cannot write this upload session.');
    }
    const payload = new Uint8Array(await c.req.arrayBuffer());
    if (ref.size !== payload.byteLength || ref.sha256 !== (await sha256Bytes(payload))) {
      return problemResponse(
        c,
        400,
        'validation',
        'upload_integrity_mismatch',
        'Upload payload does not match declared size/hash.',
      );
    }
    try {
      await storage.putObjectBytes(ref, payload);
    } catch (error) {
      return c.json(
        {
          category: 'conflict',
          code: 'object_already_exists',
          message: error instanceof Error ? error.message : 'Object conflict.',
        },
        409,
      );
    }
    return c.json({ object: ref });
  });

  app.post('/uploads/finalize', async c => {
    const storage = resolveStorage(source, c);
    const token = await requireToken(storage, c);
    if (!token) {
      return problemResponse(c, 401, 'auth', 'missing_token', 'A valid API token is required to finalize uploads.');
    }
    const body = (await c.req.json().catch(() => undefined)) as { uploadId?: string; artifact?: unknown } | undefined;
    const upload = body?.uploadId ? await storage.getUploadSession(body.uploadId) : undefined;
    if (!upload || upload.userId !== token.userId) {
      return problemResponse(c, 404, 'not_found', 'upload_not_found', 'Upload session not found.');
    }
    const parsed = ArtifactPublishSchema.safeParse(body?.artifact);
    if (!parsed.success) {
      return c.json(
        {
          category: 'validation',
          code: 'invalid_artifact_payload',
          message: 'Artifact payload does not match CyanPrint registry schema.',
          details: { issues: parsed.error.issues },
        },
        400,
      );
    }
    const sessionObject = upload.objects.archive ?? upload.objects.bundle;
    const artifact = {
      ...parsed.data,
      object: sessionObject,
      artifactObjects: upload.objects,
      disabled: false,
      moderationState: 'active' as const,
      downloads: 0,
      likes: 0,
    };
    if (artifact.kind !== upload.kind || artifact.owner !== upload.owner || artifact.name !== upload.name) {
      return problemResponse(
        c,
        400,
        'validation',
        'upload_identity_mismatch',
        'Upload identity does not match artifact metadata.',
      );
    }
    if (!(await canPublishArtifact(storage, token, artifact, c.env))) {
      return problemResponse(c, 403, 'permission', 'owner_required', 'Token owner cannot publish this artifact owner.');
    }
    const validationError = await validateArtifactInput(storage, artifact);
    if (validationError) {
      return problemResponse(c, 400, 'validation', 'invalid_artifact_version', validationError);
    }
    const packageValidationError = await validateArtifactPackage(storage, artifact);
    if (packageValidationError) {
      return problemResponse(c, 400, 'validation', 'invalid_artifact_package', packageValidationError);
    }
    const committed = await storage.commitArtifact(artifact);
    await storage.deleteUploadSession(body?.uploadId ?? '');
    return c.json({ artifact: committed }, 201);
  });

  app.post('/objects', async c => {
    const storage = resolveStorage(source, c);
    if (!legacyPackageApiEnabled(storage, c)) {
      return problemResponse(
        c,
        410,
        'unexpected',
        'legacy_package_api_disabled',
        'Legacy JSON package uploads are disabled. Use /uploads/start and /uploads/finalize.',
      );
    }
    const token = await requireToken(storage, c);
    if (!token) {
      return problemResponse(c, 401, 'auth', 'missing_token', 'A valid API token is required to upload objects.');
    }
    const body = (await c.req.json().catch(() => undefined)) as { ref?: ObjectRef; payload?: string } | undefined;
    const ref = ObjectRefSchema.safeParse(body?.ref);
    if (!ref.success || typeof body?.payload !== 'string') {
      return problemResponse(c, 400, 'validation', 'invalid_object', 'Object upload requires ref and payload.');
    }
    if (!(await canWriteObject(storage, token, ref.data, c.env))) {
      return problemResponse(c, 403, 'permission', 'owner_required', 'Token owner cannot upload this object key.');
    }
    if (
      ref.data.size !== new TextEncoder().encode(body.payload).byteLength ||
      ref.data.sha256 !== (await sha256Hex(body.payload))
    ) {
      return problemResponse(
        c,
        400,
        'validation',
        'object_integrity_mismatch',
        'Object payload does not match declared size/hash.',
      );
    }
    try {
      await storage.putObject(ref.data, body.payload);
    } catch (error) {
      return c.json(
        {
          category: 'conflict',
          code: 'object_already_exists',
          message: error instanceof Error ? error.message : 'Object conflict.',
        },
        409,
      );
    }
    return c.json({ object: ref.data }, 201);
  });

  app.post('/objects/download', async c => {
    const storage = resolveStorage(source, c);
    const body = (await c.req.json().catch(() => undefined)) as { ref?: ObjectRef } | undefined;
    const ref = ObjectRefSchema.safeParse(body?.ref);
    if (!ref.success) {
      return problemResponse(c, 400, 'validation', 'invalid_object_ref', 'Object download requires ref.');
    }
    const artifact = await storage.getActiveArtifactByObjectRef(ref.data);
    if (!artifact) {
      return problemResponse(
        c,
        404,
        'not_found',
        'object_not_published',
        'Object ref is not attached to an active artifact.',
      );
    }
    if (c.req.header('accept') === 'application/octet-stream') {
      const bytes = await storage.getObjectBytes(ref.data);
      if (!bytes) {
        return problemResponse(c, 404, 'not_found', 'object_not_found', `Object not found: ${ref.data.key}`);
      }
      if (isDownloadCountingRef(artifact, ref.data)) {
        await storage.recordDownload(ref.data);
      }
      return new Response(toArrayBuffer(bytes), { headers: { 'content-type': 'application/octet-stream' } });
    }
    const payload = await storage.getObject(ref.data);
    if (!payload) {
      return problemResponse(c, 404, 'not_found', 'object_not_found', `Object not found: ${ref.data.key}`);
    }
    if (isDownloadCountingRef(artifact, ref.data)) {
      await storage.recordDownload(ref.data);
    }
    return c.json({ payload });
  });

  app.post('/artifacts', async c => {
    const storage = resolveStorage(source, c);
    if (!legacyPackageApiEnabled(storage, c)) {
      return problemResponse(
        c,
        410,
        'unexpected',
        'legacy_package_api_disabled',
        'Legacy JSON package publish is disabled. Use /uploads/start and /uploads/finalize.',
      );
    }
    const token = await requireToken(storage, c);
    if (!token) {
      return problemResponse(c, 401, 'auth', 'missing_token', 'A valid API token is required to publish artifacts.');
    }
    const parsed = ArtifactPublishSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      return c.json(
        {
          category: 'validation',
          code: 'invalid_artifact_payload',
          message: 'Artifact payload does not match CyanPrint registry schema.',
          details: { issues: parsed.error.issues },
        },
        400,
      );
    }
    const artifact = {
      ...parsed.data,
      disabled: false,
      moderationState: 'active' as const,
      downloads: 0,
      likes: 0,
    };
    if (!(await canPublishArtifact(storage, token, artifact, c.env))) {
      return problemResponse(c, 403, 'permission', 'owner_required', 'Token owner cannot publish this artifact owner.');
    }
    const validationError = await validateArtifactInput(storage, artifact);
    if (validationError) {
      return problemResponse(c, 400, 'validation', 'invalid_artifact_version', validationError);
    }
    const expectedObjectKey = artifact.object
      ? `${artifact.kind}/${artifact.owner}/${artifact.name}/${artifact.object.sha256}.cyanpkg.json`
      : undefined;
    if (artifact.object?.key !== expectedObjectKey) {
      return problemResponse(
        c,
        400,
        'validation',
        'invalid_object_key',
        'Artifact object key does not match its identity.',
      );
    }
    const packageValidationError = await validateArtifactPackage(storage, artifact);
    if (packageValidationError) {
      return problemResponse(c, 400, 'validation', 'invalid_artifact_package', packageValidationError);
    }
    const committed = await storage.commitArtifact(artifact);
    return c.json({ artifact: committed }, 201);
  });

  app.post('/batch-resolve', async c => {
    const storage = resolveStorage(source, c);
    const body = (await c.req.json().catch(() => undefined)) as unknown;
    if (!isBatchResolveRequest(body)) {
      return problemResponse(c, 400, 'validation', 'invalid_batch_resolve', 'Batch resolve requires a refs array.');
    }
    return c.json(await storage.batchResolve(body));
  });

  app.post('/artifacts/:id/like', async c => {
    const storage = resolveStorage(source, c);
    const user = await requireUser(storage, c);
    if (!user) {
      return problemResponse(
        c,
        401,
        'auth',
        'missing_session',
        'A local authenticated user is required to like artifacts.',
      );
    }
    const current = await storage.getArtifact(c.req.param('id'));
    if (!current || !isActiveArtifact(current)) {
      return problemResponse(c, 404, 'not_found', 'artifact_not_found', 'Artifact not found.');
    }
    const artifact = await storage.likeArtifact(c.req.param('id'), user.id);
    if (!artifact) {
      return problemResponse(c, 404, 'not_found', 'artifact_not_found', 'Artifact not found.');
    }
    return c.json({ artifact });
  });

  app.post('/admin/artifacts/:id/disable', async c => {
    const storage = resolveStorage(source, c);
    if (!(await requireAdminToken(storage, c))) {
      return problemResponse(
        c,
        403,
        'permission',
        'admin_required',
        'An admin API token is required for admin routes.',
      );
    }
    const artifact = await storage.disableArtifact(c.req.param('id'));
    if (!artifact) {
      return problemResponse(c, 404, 'not_found', 'artifact_not_found', 'Artifact not found.');
    }
    return c.json({ ok: true, artifact });
  });

  return app;
}

const storesByEnv = new WeakMap<object, RegistryStorage>();

export function storageForEnv(env: WorkerBindings): RegistryStorage {
  const hasDb = Boolean(env.DB);
  const hasR2 = Boolean(env.R2);
  const hasKv = Boolean(env.KV);
  if ((hasDb || hasR2 || hasKv) && !(hasDb && hasR2 && hasKv)) {
    throw new Error('Cloudflare registry storage requires DB, R2, and KV bindings together.');
  }
  if (env.DB && env.R2 && env.KV) {
    const cached = storesByEnv.get(env);
    if (cached) {
      return cached;
    }
    const storage = createCloudflareBindingStorage(env);
    storesByEnv.set(env, storage);
    return storage;
  }
  return defaultStorage;
}

const app = createApp(storageForEnv);

export default app;
