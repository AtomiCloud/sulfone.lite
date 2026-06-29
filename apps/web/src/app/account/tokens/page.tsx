import { TokenForm } from '../../../features/account/token-form';
import { TokenList } from '../../../features/account/token-list';

export default function TokensPage() {
  return (
    <section className="stack">
      <div>
        <p className="eyebrow">Tokens</p>
        <h1>API token control plane</h1>
      </div>
      <TokenForm />
      <TokenList />
    </section>
  );
}
