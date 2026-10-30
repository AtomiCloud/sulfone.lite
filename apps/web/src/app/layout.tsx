import type { Metadata } from 'next';
import { Suspense } from 'react';
import { AppShell } from '../features/shell/app-shell';
import { loadShellArtifacts } from '../features/shell/shell-data';
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
  const [{ artifacts, registryUnavailable }, account] = await Promise.all([loadShellArtifacts(), getAccountSession()]);
  return (
    <html lang="en">
      <body>
        <Suspense>
          <AppShell artifacts={artifacts} user={account?.user}>
            {registryUnavailable ? (
              <p className="form-error" role="alert">
                The registry is temporarily unavailable. Catalog data may be missing; please try again shortly.
              </p>
            ) : null}
            {children}
          </AppShell>
        </Suspense>
      </body>
    </html>
  );
}
