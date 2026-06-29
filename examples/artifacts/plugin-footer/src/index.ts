export function plugin(input: { files: Record<string, string> }): Record<string, string> {
  const { files } = input;
  return Object.fromEntries(Object.entries(files).map(([path, content]) => [path, `${content}\nGenerated locally.\n`]));
}
