import { ButtonLink } from '../../components/ui/button';

export default function AdminPage() {
  return (
    <section className="page-grid">
      <div>
        <p className="eyebrow">Admin</p>
        <h1>Registry operations</h1>
        <p className="lede">Inspect versions, pins, object refs, publish state, and moderation controls.</p>
      </div>
      <ButtonLink href="/admin/artifacts">Open artifact review</ButtonLink>
    </section>
  );
}
