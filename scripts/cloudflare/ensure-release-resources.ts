import { mkdir, writeFile } from 'node:fs/promises';

type CommandResult = {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
};

const defaults = {
  CYANPRINT_REGISTRY_WORKER_NAME: 'cyanprint-registry',
  CYANPRINT_D1_DATABASE_NAME: 'cyanprint-registry',
  CYANPRINT_R2_BUCKET_NAME: 'cyanprint-registry-artifacts',
  CYANPRINT_KV_NAMESPACE_NAME: 'cyanprint-registry',
  CYANPRINT_WEB_WORKER_NAME: 'cyanprint-web',
  CYANPRINT_WEB_CACHE_R2_BUCKET_NAME: 'cyanprint-web-opennext-cache',
  CYANPRINT_RELEASE_REGISTRY_URL: 'https://registry.cyanprint.dev',
};

const dryRun = process.env.CYANPRINT_CLOUDFLARE_BOOTSTRAP_DRY_RUN === '1';

const resolved = {
  CYANPRINT_REGISTRY_WORKER_NAME: readEnv('CYANPRINT_REGISTRY_WORKER_NAME'),
  CYANPRINT_D1_DATABASE_NAME: readEnv('CYANPRINT_D1_DATABASE_NAME'),
  CYANPRINT_R2_BUCKET_NAME: readEnv('CYANPRINT_R2_BUCKET_NAME'),
  CYANPRINT_KV_NAMESPACE_NAME: readEnv('CYANPRINT_KV_NAMESPACE_NAME'),
  CYANPRINT_WEB_WORKER_NAME: readEnv('CYANPRINT_WEB_WORKER_NAME'),
  CYANPRINT_WEB_CACHE_R2_BUCKET_NAME: readEnv('CYANPRINT_WEB_CACHE_R2_BUCKET_NAME'),
  CYANPRINT_RELEASE_REGISTRY_URL: readEnv('CYANPRINT_RELEASE_REGISTRY_URL'),
  CYANPRINT_D1_DATABASE_ID: process.env.CYANPRINT_D1_DATABASE_ID ?? '',
  CYANPRINT_KV_NAMESPACE_ID: process.env.CYANPRINT_KV_NAMESPACE_ID ?? '',
};

if (!resolved.CYANPRINT_D1_DATABASE_ID) {
  resolved.CYANPRINT_D1_DATABASE_ID = await ensureD1Database(resolved.CYANPRINT_D1_DATABASE_NAME);
}

if (!resolved.CYANPRINT_KV_NAMESPACE_ID) {
  resolved.CYANPRINT_KV_NAMESPACE_ID = await ensureKvNamespace(resolved.CYANPRINT_KV_NAMESPACE_NAME);
}

await ensureR2Bucket(resolved.CYANPRINT_R2_BUCKET_NAME);
await ensureR2Bucket(resolved.CYANPRINT_WEB_CACHE_R2_BUCKET_NAME);

await mkdir('.tmp/cloudflare', { recursive: true });
await writeFile('.tmp/cloudflare/release.env', toShellEnv(resolved), 'utf8');

console.log(
  JSON.stringify(
    {
      status: 'done',
      envFile: '.tmp/cloudflare/release.env',
      d1: {
        name: resolved.CYANPRINT_D1_DATABASE_NAME,
        id: resolved.CYANPRINT_D1_DATABASE_ID,
      },
      kv: {
        name: resolved.CYANPRINT_KV_NAMESPACE_NAME,
        id: resolved.CYANPRINT_KV_NAMESPACE_ID,
      },
      r2: [resolved.CYANPRINT_R2_BUCKET_NAME, resolved.CYANPRINT_WEB_CACHE_R2_BUCKET_NAME],
      dryRun,
    },
    null,
    2,
  ),
);

async function ensureD1Database(name: string): Promise<string> {
  if (dryRun) {
    throw new Error('CYANPRINT_D1_DATABASE_ID is required when CYANPRINT_CLOUDFLARE_BOOTSTRAP_DRY_RUN=1.');
  }

  const existing = run(['bunx', 'wrangler', 'd1', 'list', '--json']);
  const database = parseJsonArray(existing).find(item => readObjectString(item, ['name']) === name);
  const existingId = database ? readObjectString(database, ['uuid', 'id', 'database_id']) : '';
  if (existingId) {
    return existingId;
  }

  const created = run(['bunx', 'wrangler', 'd1', 'create', name]);
  const createdId = parseTomlValue(created.stdout + '\n' + created.stderr, 'database_id');
  if (createdId) {
    return createdId;
  }

  const afterCreate = run(['bunx', 'wrangler', 'd1', 'list', '--json']);
  const createdDatabase = parseJsonArray(afterCreate).find(item => readObjectString(item, ['name']) === name);
  const listedId = createdDatabase ? readObjectString(createdDatabase, ['uuid', 'id', 'database_id']) : '';
  if (listedId) {
    return listedId;
  }

  throw new Error(`Created D1 database ${name}, but could not discover its database_id.`);
}

async function ensureKvNamespace(name: string): Promise<string> {
  if (dryRun) {
    throw new Error('CYANPRINT_KV_NAMESPACE_ID is required when CYANPRINT_CLOUDFLARE_BOOTSTRAP_DRY_RUN=1.');
  }

  const existing = run(['bunx', 'wrangler', 'kv', 'namespace', 'list']);
  const namespace = parseJsonArray(existing).find(item => readObjectString(item, ['title', 'name']) === name);
  const existingId = namespace ? readObjectString(namespace, ['id']) : '';
  if (existingId) {
    return existingId;
  }

  const created = run(['bunx', 'wrangler', 'kv', 'namespace', 'create', name]);
  const createdId = parseTomlValue(created.stdout + '\n' + created.stderr, 'id');
  if (createdId) {
    return createdId;
  }

  const afterCreate = run(['bunx', 'wrangler', 'kv', 'namespace', 'list']);
  const createdNamespace = parseJsonArray(afterCreate).find(item => readObjectString(item, ['title', 'name']) === name);
  const listedId = createdNamespace ? readObjectString(createdNamespace, ['id']) : '';
  if (listedId) {
    return listedId;
  }

  throw new Error(`Created KV namespace ${name}, but could not discover its id.`);
}

async function ensureR2Bucket(name: string): Promise<void> {
  if (dryRun) {
    return;
  }

  const created = run(['bunx', 'wrangler', 'r2', 'bucket', 'create', name], { allowFailure: true });
  if (created.exitCode === 0) {
    return;
  }

  const output = `${created.stdout}\n${created.stderr}`.toLowerCase();
  if (output.includes('already exists') || output.includes('bucket name is already in use')) {
    return;
  }

  throw commandError(created);
}

function run(args: string[], options: { allowFailure?: boolean } = {}): CommandResult {
  const result = Bun.spawnSync(args, {
    stdout: 'pipe',
    stderr: 'pipe',
    env: process.env,
  });
  const commandResult = {
    command: args.join(' '),
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
    exitCode: result.exitCode,
  };

  if (commandResult.exitCode !== 0 && !options.allowFailure) {
    throw commandError(commandResult);
  }

  return commandResult;
}

function commandError(result: CommandResult): Error {
  const output = `${result.stdout}\n${result.stderr}`.trim();
  return new Error(`${result.command} failed with exit code ${result.exitCode}${output ? `:\n${output}` : ''}`);
}

function parseJsonArray(result: CommandResult): unknown[] {
  const value = parseJson(result.stdout) ?? parseJson(result.stderr);
  if (Array.isArray(value)) {
    return value;
  }
  throw new Error(`${result.command} did not return a JSON array.`);
}

function parseJson(text: string): unknown {
  const clean = stripAnsi(text).trim();
  const start = clean.indexOf('[');
  const end = clean.lastIndexOf(']');
  if (start < 0 || end < start) {
    return undefined;
  }

  return JSON.parse(clean.slice(start, end + 1));
}

function parseTomlValue(text: string, key: string): string {
  const clean = stripAnsi(text);
  const match = clean.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]+)"\\s*$`, 'm'));
  return match?.[1] ?? '';
}

function readObjectString(value: unknown, keys: string[]): string {
  if (!value || typeof value !== 'object') {
    return '';
  }

  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const item = record[key];
    if (typeof item === 'string' && item.length > 0) {
      return item;
    }
  }
  return '';
}

function readEnv(key: keyof typeof defaults): string {
  const configured = process.env[key];
  return configured && configured.length > 0 ? configured : defaults[key];
}

function toShellEnv(values: Record<string, string>): string {
  return `${Object.entries(values)
    .map(([key, value]) => `export ${key}=${shellQuote(value)}`)
    .join('\n')}\n`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, '');
}

export {};
