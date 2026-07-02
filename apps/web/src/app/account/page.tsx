import { AccountPanel } from '../../features/account/account-panel';
import { getAccountSession } from '../../features/account/account-session';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type AccountPageProps = {
  searchParams?: Promise<{ error?: string | string[] | undefined }>;
};

export default async function AccountPage({ searchParams }: AccountPageProps) {
  const account = await getAccountSession();
  const params = await searchParams;
  const error = authErrorMessage(Array.isArray(params?.error) ? params.error[0] : params?.error);
  return (
    <section className="page-grid">
      <div>
        <p className="eyebrow">Account</p>
        <h1>Publishing identity</h1>
        <p className="lede">
          Mint API tokens for `cyanprint push`, inspect token metadata, and revoke stale credentials.
        </p>
      </div>
      <AccountPanel error={error} serverUser={account?.user} />
    </section>
  );
}

function authErrorMessage(error: string | undefined): string | undefined {
  switch (error) {
    case 'local_login_failed':
      return 'Local sign-in failed. Restart `pls dev` and try again.';
    case 'github_login_failed':
      return 'GitHub sign-in failed. Please try again.';
    case 'invalid_oauth_state':
    case 'invalid_login_nonce':
      return 'Your sign-in link expired. Please sign in again.';
    case 'missing_handoff':
      return 'Sign-in did not return a valid session. Please try again.';
    default:
      return undefined;
  }
}
