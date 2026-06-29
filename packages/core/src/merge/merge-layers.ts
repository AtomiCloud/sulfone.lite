export type MergeResult = {
  path: string;
  status: 'unchanged' | 'regenerated' | 'user-edited' | 'deleted' | 'added' | 'conflicted';
  content?: string;
  conflict?: string;
};

export function mergeFile(args: {
  prior?: string;
  current?: string;
  target?: string;
  resolver?: (input: typeof args) => string;
}): MergeResult {
  if (args.current === args.target) {
    return { path: '', status: 'unchanged', content: args.current };
  }
  if (args.current === args.prior) {
    return { path: '', status: 'regenerated', content: args.target };
  }
  if (args.resolver) {
    return { path: '', status: 'regenerated', content: args.resolver(args) };
  }
  return { path: '', status: 'conflicted', conflict: 'User edit and target template both changed this file.' };
}
