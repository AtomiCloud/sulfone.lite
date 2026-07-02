import { listLatestRegistryArtifacts } from '../features/registry/registry-data';
import { LandingHero } from '../features/shell/landing-hero';

export default async function Home() {
  const artifacts = await listLatestRegistryArtifacts();
  return <LandingHero artifacts={artifacts} />;
}
