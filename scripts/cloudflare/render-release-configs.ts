import { mkdir, writeFile } from 'node:fs/promises';

const defaults = {
  CYANPRINT_REGISTRY_WORKER_NAME: 'cyanprint-registry',
  CYANPRINT_REGISTRY_DOMAIN: 'registry.cyanprint.dev',
  CYANPRINT_D1_DATABASE_NAME: 'cyanprint-registry',
  CYANPRINT_R2_BUCKET_NAME: 'cyanprint-registry-artifacts',
  CYANPRINT_WEB_WORKER_NAME: 'cyanprint-web',
  CYANPRINT_WEB_DOMAIN: 'cyanprint.dev',
  CYANPRINT_WEB_CACHE_R2_BUCKET_NAME: 'cyanprint-web-opennext-cache',
  CYANPRINT_RELEASE_REGISTRY_URL: 'https://registry.cyanprint.dev',
};

const required = ['CYANPRINT_D1_DATABASE_ID', 'CYANPRINT_KV_NAMESPACE_ID'] as const;

for (const key of required) {
  if (!process.env[key]) {
    throw new Error(`${key} is required for release Wrangler config rendering.`);
  }
}

await render({
  templatePath: 'apps/worker/wrangler.release.toml.template',
  outPath: '.tmp/cloudflare/worker.wrangler.toml',
});
await render({
  templatePath: 'apps/web/wrangler.release.toml.template',
  outPath: '.tmp/cloudflare/web.wrangler.toml',
});

async function render(args: { templatePath: string; outPath: string }): Promise<void> {
  const template = await Bun.file(args.templatePath).text();
  const rendered = template.replace(/\$\{([A-Z0-9_]+)\}/g, (_, key: string) => {
    const configured = process.env[key];
    const value = configured && configured.length > 0 ? configured : defaults[key as keyof typeof defaults];
    if (!value) {
      throw new Error(`${key} is required for ${args.templatePath}.`);
    }
    return value;
  });
  await mkdir('.tmp/cloudflare', { recursive: true });
  await writeFile(args.outPath, rendered, 'utf8');
}

console.log(
  JSON.stringify({
    status: 'done',
    workerConfig: '.tmp/cloudflare/worker.wrangler.toml',
    webConfig: '.tmp/cloudflare/web.wrangler.toml',
    registryUrl:
      process.env.CYANPRINT_RELEASE_REGISTRY_URL && process.env.CYANPRINT_RELEASE_REGISTRY_URL.length > 0
        ? process.env.CYANPRINT_RELEASE_REGISTRY_URL
        : defaults.CYANPRINT_RELEASE_REGISTRY_URL,
  }),
);

export {};
