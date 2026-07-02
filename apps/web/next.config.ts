import type { NextConfig } from 'next';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const webDir = dirname(fileURLToPath(import.meta.url));
const distDir = process.env.CYANPRINT_NEXT_DIST_DIR;
const isDevelopment = process.env.NODE_ENV !== 'production';
const scriptSrc = isDevelopment ? "'self' 'unsafe-inline' 'unsafe-eval'" : "'self' 'unsafe-inline'";
const registryUrl =
  process.env.CYANPRINT_REGISTRY_URL || process.env.CYANPRINT_RELEASE_REGISTRY_URL || 'https://registry.cyanprint.dev';
const registryOrigin = new URL(registryUrl).origin;
const connectSrc = [
  "'self'",
  registryOrigin,
  ...(isDevelopment ? ['http://127.0.0.1:8787', 'http://localhost:8787'] : []),
];

const nextConfig: NextConfig = {
  ...(distDir ? { distDir } : {}),
  outputFileTracingRoot: join(webDir, '../..'),
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          {
            key: 'Content-Security-Policy',
            value: `default-src 'self'; connect-src ${connectSrc.join(' ')}; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src ${scriptSrc}; object-src 'none'; frame-ancestors 'none'`,
          },
        ],
      },
    ];
  },
};

export default nextConfig;
