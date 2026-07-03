// Composition is static: tri-a, tri-b, and tri-c are declared in cyan.yaml's
// templates: dictionary. cyan.ts may only return processors, plugins, and commands.
export default async function cyan(prompt, ctx) {
  return {};
}
