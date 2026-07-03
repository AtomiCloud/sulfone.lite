export type ResolverFileOrigin = {
  template: string;
  layer: number;
  processor?: { ref: string; invocation: number };
};

export type ResolverFile = {
  path: string;
  content: string;
  origin: ResolverFileOrigin;
};

export type ResolverInput = {
  files: ResolverFile[];
  config: Record<string, unknown>;
};

export type ResolverOutput = {
  path: string;
  content: string;
};

export type ResolverLambda = (input: ResolverInput) => Promise<ResolverOutput> | ResolverOutput;

export const CYANPRINT_RESOLVER_SYMBOL = Symbol.for('cyanprint.resolver');

export function StartResolverWithLambda(lambda: ResolverLambda): void {
  Object.defineProperty(globalThis, CYANPRINT_RESOLVER_SYMBOL, {
    configurable: true,
    value: lambda,
  });
}
