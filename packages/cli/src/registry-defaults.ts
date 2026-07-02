export const RELEASE_REGISTRY_URL = 'https://registry.cyanprint.dev';

export function defaultRegistryUrl(): string {
  return (process.env.CYANPRINT_REGISTRY_URL ?? process.env.CYANPRINT_REGISTRY ?? RELEASE_REGISTRY_URL).replace(
    /\/$/,
    '',
  );
}
