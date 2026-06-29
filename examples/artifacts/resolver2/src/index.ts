type ResolverInput = {
  files: Array<{ content: string; origin: { template: string; layer: number } }>;
};

export function resolver(input: ResolverInput): string {
  const parts = [...input.files]
    .sort(
      (left, right) =>
        left.origin.layer - right.origin.layer || left.origin.template.localeCompare(right.origin.template),
    )
    .map(file => file.content)
    .filter((content): content is string => Boolean(content?.trim()))
    .map(content => content.trimEnd());
  return `${parts.join('\n')}\n`;
}
