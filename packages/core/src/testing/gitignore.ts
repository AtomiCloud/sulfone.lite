// Minimal .gitignore matcher for template test output comparison. Supports comments,
// blank lines, negation (`!`), root-anchored patterns (leading `/`), directory patterns
// (trailing `/`), and `*`/`**`/`?` globs. Later patterns override earlier ones. Like git,
// a file under an excluded parent directory stays excluded: it cannot be re-included.

type IgnoreRule = {
  negated: boolean;
  /** Matches the path itself or anything beneath it (a file path). */
  matches: (path: string) => boolean;
  /** Matches the path as a directory itself (used for the ancestors of a file). */
  matchesDirectory: (path: string) => boolean;
};

export function parseGitignore(content: string): (path: string) => boolean {
  const rules: IgnoreRule[] = [];
  for (const rawLine of content.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (!line.trim() || line.trimStart().startsWith('#')) {
      continue;
    }
    let pattern = line.trim();
    const negated = pattern.startsWith('!');
    if (negated) {
      pattern = pattern.slice(1);
    }
    const directoryOnly = pattern.endsWith('/');
    if (directoryOnly) {
      pattern = pattern.slice(0, -1);
    }
    // A slash at the start or middle (the trailing one is already stripped) anchors the pattern.
    const anchored = pattern.includes('/');
    if (pattern.startsWith('/')) {
      pattern = pattern.slice(1);
    }
    if (!pattern) {
      continue;
    }
    const selfGlobs = [new Bun.Glob(pattern)];
    if (!anchored) {
      selfGlobs.push(new Bun.Glob(`**/${pattern}`));
    }
    const underGlobs = [new Bun.Glob(`${pattern}/**`)];
    if (!anchored) {
      underGlobs.push(new Bun.Glob(`**/${pattern}/**`));
    }
    const matchesDirectory = (path: string): boolean => selfGlobs.some(glob => glob.match(path));
    rules.push({
      negated,
      matchesDirectory,
      matches: path => (!directoryOnly && matchesDirectory(path)) || underGlobs.some(glob => glob.match(path)),
    });
  }
  const lastMatch = (path: string, test: (rule: IgnoreRule, path: string) => boolean): boolean => {
    let ignored = false;
    for (const rule of rules) {
      if (test(rule, path)) {
        ignored = !rule.negated;
      }
    }
    return ignored;
  };
  return (path: string): boolean => {
    const segments = path.split('/');
    for (let end = 1; end < segments.length; end += 1) {
      if (lastMatch(segments.slice(0, end).join('/'), (rule, p) => rule.matchesDirectory(p))) {
        return true;
      }
    }
    return lastMatch(path, (rule, p) => rule.matches(p));
  };
}
