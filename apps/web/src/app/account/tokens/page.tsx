import { getAccountSession } from '../../../features/account/account-session';
import { TokensPanel } from '../../../features/account/tokens-panel';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function TokensPage() {
  const account = await getAccountSession();
  return (
    <section className="stack">
      <div>
        <p className="eyebrow">Tokens</p>
        <h1>API token control plane</h1>
      </div>
      <TokensPanel serverUser={account?.user} />
    </section>
  );
}
