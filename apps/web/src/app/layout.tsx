import type { Metadata } from 'next';
import { Suspense } from 'react';
import { AppShell } from '../features/shell/app-shell';
import { listLatestRegistryArtifacts } from '../features/registry/registry-data';
import '../styles/globals.css';

export const metadata: Metadata = {
  title: 'CyanPrint v4 Registry',
  description: 'Local-first CyanPrint v4 registry, docs, and account console.',
  icons: {
    icon: '/logo/cyanprint-logo.svg',
  },
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const artifacts = await listLatestRegistryArtifacts();
  return (
    <html lang="en">
      <body>
        <Suspense>
          <AppShell artifacts={artifacts}>{children}</AppShell>
        </Suspense>
      </body>
    </html>
  );
}
