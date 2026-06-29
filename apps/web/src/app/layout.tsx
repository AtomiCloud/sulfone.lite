import type { Metadata } from 'next';
import { Suspense } from 'react';
import { AppShell } from '../features/shell/app-shell';
import { listLatestRegistryArtifacts } from '../features/registry/registry-data';
import { getAccountSession } from '../features/account/account-session';
import '../styles/globals.css';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export const metadata: Metadata = {
  title: 'CyanPrint Registry',
  description: 'Local-first CyanPrint registry, docs, and account console.',
  icons: {
    icon: '/logo/cyanprint-logo.svg',
  },
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const [artifacts, account] = await Promise.all([listLatestRegistryArtifacts(), getAccountSession()]);
  return (
    <html lang="en">
      <body>
        <Suspense>
          <AppShell artifacts={artifacts} user={account?.user}>
            {children}
          </AppShell>
        </Suspense>
      </body>
    </html>
  );
}
