import { loadShellArtifacts } from '../features/shell/shell-data';
import { LandingHero } from '../features/shell/landing-hero';

export default async function Home() {
  const { artifacts } = await loadShellArtifacts();
  return <LandingHero artifacts={artifacts} />;
}
