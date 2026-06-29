import type { NextConfig } from 'next';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const webDir = dirname(fileURLToPath(import.meta.url));
const distDir = process.env.CYANPRINT_NEXT_DIST_DIR;
const isDevelopment = process.env.NODE_ENV !== 'production';
const scriptSrc = isDevelopment ? "'self' 'unsafe-inline' 'unsafe-eval'" : "'self' 'unsafe-inline'";

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
            value: `default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src ${scriptSrc}; object-src 'none'; frame-ancestors 'none'`,
          },
        ],
      },
    ];
  },
};

export default nextConfig;
