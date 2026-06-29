type ResolverInput = {
  files: Array<{ content: string; origin: { template: string; layer: number } }>;
};

export function resolver(input: ResolverInput): string {
  const current = input.files.find(file => file.origin.template === 'current');
  if (current) {
    return current.content;
  }
  return [...input.files].sort((left, right) => right.origin.layer - left.origin.layer)[0]?.content ?? '';
}
