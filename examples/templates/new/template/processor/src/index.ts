export function processor(input: { files: Record<string, string> }) {
  return Object.fromEntries(
    Object.entries(input.files).map(([path, content]) => [path, String(content).replace(/[ \t]+$/gm, '')]),
  );
}
