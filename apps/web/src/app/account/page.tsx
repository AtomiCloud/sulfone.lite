import { ButtonLink } from '../../components/ui/button';

export default function AccountPage() {
  return (
    <section className="page-grid">
      <div>
        <p className="eyebrow">Account</p>
        <h1>Publishing identity</h1>
        <p className="lede">
          Mint API tokens for `cyanprint push`, inspect token metadata, and revoke stale credentials.
        </p>
      </div>
      <div className="panel">
        <h2>Session</h2>
        <dl className="facts">
          <dt>User</dt>
          <dd>Registry account</dd>
          <dt>Role</dt>
          <dd>Publisher</dd>
        </dl>
        <ButtonLink href="/account/tokens">Manage tokens</ButtonLink>
      </div>
    </section>
  );
}
