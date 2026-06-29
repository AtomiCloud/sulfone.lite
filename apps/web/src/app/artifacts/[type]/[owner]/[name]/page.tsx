import { ArtifactDetail } from '../../../../../features/artifacts/artifact-detail';

export default async function ArtifactDetailPage({
  params,
}: {
  params: Promise<{ type: string; owner: string; name: string }>;
}) {
  const resolved = await params;
  return <ArtifactDetail {...resolved} />;
}
