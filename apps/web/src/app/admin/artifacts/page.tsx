import { cookies } from 'next/headers';
import { AdminArtifactTable } from '../../../features/admin/admin-artifact-table';
import { listAdminRegistryArtifactPage } from '../../../features/registry/registry-data';

export default async function AdminArtifactsPage({
  searchParams,
}: {
  searchParams?: Promise<{ cursor?: string; kind?: string; limit?: string; q?: string }>;
}) {
  const params = (await searchParams) ?? {};
  if (!(await isAdminPageAuthorized())) {
    return (
      <section className="stack">
        <div>
          <p className="eyebrow">Admin review</p>
          <h1>Artifact moderation</h1>
        </div>
        <form action="/admin/artifacts/access" className="panel" method="post">
          <h2>Admin access required</h2>
          <p>Enter the admin web secret to open remote moderation data for this browser session.</p>
          <input aria-label="Admin web secret" name="adminSecret" placeholder="admin secret" type="password" />
          <input name="redirectTo" type="hidden" value="/admin/artifacts" />
          <button className="btn btn-primary" type="submit">
            Unlock
          </button>
        </form>
      </section>
    );
  }
  const parsedLimit = Number(params.limit);
  const page = await listAdminRegistryArtifactPage({
    cursor: params.cursor,
    kind: params.kind,
    limit: Number.isInteger(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 100) : 100,
    query: params.q,
  });
  return <AdminArtifactTable artifacts={page.artifacts} nextCursor={page.nextCursor} params={params} />;
}

async function isAdminPageAuthorized(): Promise<boolean> {
  if (!process.env.CYANPRINT_REGISTRY_URL) {
    return true;
  }
  const expected = process.env.CYANPRINT_WEB_ADMIN_SECRET;
  if (!expected) {
    return false;
  }
  const cookieSecret = (await cookies()).get('cyanprint-admin-secret')?.value;
  return cookieSecret === expected;
}
