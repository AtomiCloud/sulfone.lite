// Runtime validation for artifact exports. Validation happens on the imported function itself
// (never by parsing source text): source-level lexing cannot reliably classify JavaScript and
// previously rejected valid artifacts (division-vs-regex, ASI, TS generics).

/**
 * Assert an artifact's exported runtime function does not declare more parameters than the
 * runtime passes. `Function.length` ignores default/rest parameters, so under-declaring is
 * always allowed; declaring MORE means the artifact expects arguments it will never receive.
 * Processors and plugins receive (input, helper); resolvers receive one input object.
 */
export function assertRuntimeExportArity(args: {
  declaredParameterCount: number;
  exportName: string;
  isRegisteredLegacyResolver: boolean;
  label: string;
}): void {
  const { declaredParameterCount, exportName, isRegisteredLegacyResolver, label } = args;
  if (isRegisteredLegacyResolver) {
    // Legacy resolvers register through the cyan-sdk global hook, not a declared export.
    return;
  }
  const maxParameters = exportName === 'resolver' ? 1 : 2;
  if (declaredParameterCount <= maxParameters) {
    return;
  }
  if (exportName === 'resolver') {
    throw new Error(
      `${label} expected ${exportName} to take one input object. Use "export function ${exportName}(input)".`,
    );
  }
  throw new Error(
    `${label} expected ${exportName} to take an input object and an optional helper. ` +
      `Use "export function ${exportName}(input, helper)".`,
  );
}
