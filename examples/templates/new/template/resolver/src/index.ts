export function resolver(input: { files: Array<{ content: string; origin: { layer: number } }> }) {
  const latest = [...input.files].sort((left, right) => right.origin.layer - left.origin.layer)[0];
  return latest?.content ?? '';
}
