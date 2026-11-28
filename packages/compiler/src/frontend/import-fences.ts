/* The preflight diagnostics that do not stop the analysis. An import form the
 * compiler cannot follow (a dynamic import with a computed specifier, a require
 * cycle, an unsupported module syntax) leaves the module graph computable: the
 * analysis still reports a statement percentage, lists the fence as a blocker
 * and poisons the imported bindings at their use sites. Every other preflight
 * diagnostic stops the analysis before lowering (analysis.ts), and a build
 * fails on every preflight diagnostic, fences included. */
const IMPORT_FENCE_CODES = new Set(["SC1010", "SC1012", "SC1013", "SC1014", "SC1015", "SC2013"]);

/** Whether `code` is an import fence: a blocker the analysis reports without
 * stopping. */
export function isImportFence(code: string): boolean {
  return IMPORT_FENCE_CODES.has(code);
}
