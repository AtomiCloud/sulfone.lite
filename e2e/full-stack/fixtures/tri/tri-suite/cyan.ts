export default async function cyan(prompt, ctx) {
  return {
    templates: [{ name: 'cyanprint/tri-a' }, { name: 'cyanprint/tri-b' }, { name: 'cyanprint/tri-c' }],
  };
}
