import type {
  ArtifactObjects,
  ArtifactPublish,
  ArtifactVersion,
  BatchResolveRequest,
  BatchResolveResponse,
  ObjectRef,
} from '@cyanprint/contracts';

export class RegistryClient {
  readonly baseUrl: string;
  readonly token?: string;
  readonly session?: string;

  constructor(baseUrl: string, token?: string, session?: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.token = token;
    this.session = session;
  }

  async health(): Promise<{ ok: boolean }> {
    return this.get('/health');
  }

  async search(
    kindOrArgs?: string | { kind?: string; query?: string; limit?: number; cursor?: string },
  ): Promise<{ artifacts: ArtifactVersion[]; nextCursor?: string }> {
    const args = typeof kindOrArgs === 'string' ? { kind: kindOrArgs } : (kindOrArgs ?? {});
    const params = new URLSearchParams();
    if (args.kind) {
      params.set('kind', args.kind);
    }
    if (args.query) {
      params.set('q', args.query);
    }
    if (args.limit) {
      params.set('limit', String(args.limit));
    }
    if (args.cursor) {
      params.set('cursor', args.cursor);
    }
    const query = params.toString();
    return this.get(`/artifacts${query ? `?${query}` : ''}`);
  }

  async latest(args: { kind?: string; query?: string; limit?: number; cursor?: string } = {}): Promise<{
    artifacts: ArtifactVersion[];
    nextCursor?: string;
  }> {
    const params = artifactSearchParams(args);
    const query = params.toString();
    return this.get(`/artifacts/latest${query ? `?${query}` : ''}`);
  }

  async getArtifact(kind: string, owner: string, name: string): Promise<{ artifact: ArtifactVersion }> {
    return this.get(`/artifacts/${encodeURIComponent(kind)}/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`);
  }

  async listArtifactVersions(kind: string, owner: string, name: string): Promise<{ artifacts: ArtifactVersion[] }> {
    return this.get(
      `/artifacts/${encodeURIComponent(kind)}/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/versions`,
    );
  }

  async listAdminArtifacts(args: { kind?: string; query?: string; limit?: number; cursor?: string } = {}): Promise<{
    artifacts: ArtifactVersion[];
    nextCursor?: string;
  }> {
    const params = artifactSearchParams(args);
    const query = params.toString();
    return this.get(`/admin/artifacts${query ? `?${query}` : ''}`);
  }

  async batchResolve(request: BatchResolveRequest): Promise<BatchResolveResponse> {
    return this.post('/batch-resolve', request);
  }

  async createLocalSession(
    userId = 'user_local',
    devSecret = process.env.CYANPRINT_LOCAL_DEV_SECRET ?? '',
  ): Promise<{ session: string; user: { id: string; handle: string | null; login?: string; admin: boolean } }> {
    return this.post('/auth/local-session', { userId }, { 'x-cyanprint-dev-secret': devSecret });
  }

  async createToken(name: string, session = this.session): Promise<{ id: string; token: string }> {
    if (!session) {
      throw new Error('createToken requires a local authenticated session.');
    }
    return new RegistryClient(this.baseUrl, this.token, session).post('/tokens', { name });
  }

  async listTokens(
    session = this.session,
  ): Promise<{ tokens: Array<{ id: string; userId: string; name: string; revoked: boolean }> }> {
    if (!session) {
      throw new Error('listTokens requires a local authenticated session.');
    }
    return new RegistryClient(this.baseUrl, this.token, session).get('/tokens');
  }

  async revokeToken(id: string, session = this.session): Promise<{ ok: boolean }> {
    if (!session) {
      throw new Error('revokeToken requires a local authenticated session.');
    }
    const response = await fetch(`${this.baseUrl}/tokens/${id}`, {
      method: 'DELETE',
      headers: new RegistryClient(this.baseUrl, this.token, session).headers(),
    });
    return this.parse<{ ok: boolean }>(response);
  }

  async publishArtifact(artifact: ArtifactPublish): Promise<{ artifact: ArtifactVersion }> {
    return this.post('/artifacts', artifact);
  }

  async startUpload(request: {
    kind: string;
    owner: string;
    name: string;
    objects: {
      manifest: Pick<ObjectRef, 'sha256' | 'size'>;
      readme?: Pick<ObjectRef, 'sha256' | 'size'>;
      bundle: Pick<ObjectRef, 'sha256' | 'size'>;
      archive?: Pick<ObjectRef, 'sha256' | 'size'>;
    };
  }): Promise<{
    uploadId: string;
    objects: ArtifactObjects;
    urls: { manifest: string; bundle: string; readme?: string; archive?: string };
  }> {
    return this.post('/uploads/start', request);
  }

  async putUploadObject(uploadUrl: string, payload: string | Uint8Array): Promise<void> {
    const url = uploadUrl.startsWith('http') ? uploadUrl : `${this.baseUrl}${uploadUrl}`;
    const body =
      typeof payload === 'string'
        ? payload
        : (payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength) as ArrayBuffer);
    const response = await fetch(url, { method: 'PUT', headers: this.headers(), body });
    if (!response.ok) {
      throw new Error(await response.text());
    }
  }

  async finalizeUpload(request: {
    uploadId: string;
    artifact: ArtifactPublish;
  }): Promise<{ artifact: ArtifactVersion }> {
    return this.post('/uploads/finalize', request);
  }

  async uploadObject(ref: ObjectRef, payload: string): Promise<{ object: ObjectRef }> {
    return this.post('/objects', { ref, payload });
  }

  async downloadObject(ref: ObjectRef): Promise<{ payload: string }> {
    const bytes = await this.downloadObjectBytes(ref);
    return { payload: new TextDecoder().decode(bytes) };
  }

  async downloadObjectBytes(ref: ObjectRef): Promise<Uint8Array> {
    const response = await fetch(`${this.baseUrl}/objects/download`, {
      method: 'POST',
      headers: { ...this.headers(), 'content-type': 'application/json', accept: 'application/octet-stream' },
      body: JSON.stringify({ ref }),
    });
    if (!response.ok) {
      throw new Error(await response.text());
    }
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      const body = (await response.json()) as { payload?: string };
      if (typeof body.payload !== 'string') {
        throw new Error('Registry object download response did not include a payload.');
      }
      return new TextEncoder().encode(body.payload);
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  private async get<T>(path: string): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, { headers: this.headers() });
    return this.parse<T>(response);
  }

  private async post<T>(path: string, body: unknown, headers: Record<string, string> = {}): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { ...this.headers(), ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return this.parse<T>(response);
  }

  private headers(): Record<string, string> {
    return {
      ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      ...(this.session ? { 'x-cyanprint-session': this.session } : {}),
    };
  }

  private async parse<T>(response: Response): Promise<T> {
    // Read text first: an HTML/plain-text error from a proxy must surface as an HTTP error
    // with its status and body, not as a JSON parse SyntaxError.
    const text = await response.text();
    let body: T | undefined;
    try {
      body = JSON.parse(text) as T;
    } catch {
      body = undefined;
    }
    if (!response.ok) {
      throw new Error(body !== undefined ? JSON.stringify(body) : `HTTP ${response.status}: ${text.slice(0, 200)}`);
    }
    if (body === undefined) {
      throw new Error(`Registry returned non-JSON response (HTTP ${response.status}): ${text.slice(0, 200)}`);
    }
    return body;
  }
}

function artifactSearchParams(args: {
  kind?: string;
  query?: string;
  limit?: number;
  cursor?: string;
}): URLSearchParams {
  const params = new URLSearchParams();
  if (args.kind) {
    params.set('kind', args.kind);
  }
  if (args.query) {
    params.set('q', args.query);
  }
  if (args.limit) {
    params.set('limit', String(args.limit));
  }
  if (args.cursor) {
    params.set('cursor', args.cursor);
  }
  return params;
}
