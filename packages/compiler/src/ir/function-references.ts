import type { IrExpr, IrModule } from "./ir.js";

/** The function an expression names as a value rather than as a direct
 * call's callee: a closure's code, or the union→union retag helper an
 * `orDefault` hands its left box to. These are the only expression fields
 * that hold a module function's name besides `call.callee`
 * (function-references.test.ts classifies every string field of the IR). */
export function exprFunctionReference(expr: IrExpr): string | undefined {
  if (expr.kind === "closure") return expr.fnName;
  if (expr.kind === "orDefault") return expr.retag;
  return undefined;
}

/** The expression kinds exprFunctionReference answers for. */
export const FUNCTION_REFERENCE_KINDS = ["closure", "orDefault"] as const;

/** Functions the module's metadata names: the entry, library exports and
 * the class prototype helpers the runtime calls. Class methods and
 * constructors follow the `%<class>.<method>` convention instead of being
 * named here; callers that need them derive them from `mod.classes`. */
export function moduleFunctionReferences(mod: IrModule): string[] {
  const names = [mod.entry];
  for (const entry of mod.lib?.exports ?? []) names.push(entry.fnName);
  for (const cls of mod.classes ?? []) {
    if (cls.prototypeDataHelper !== undefined) names.push(cls.prototypeDataHelper);
    if (cls.instancePrototypeHelper !== undefined) names.push(cls.instancePrototypeHelper);
    if (cls.arrayFields !== undefined) names.push(cls.arrayFields);
    if (cls.arraySpecies !== undefined) names.push(cls.arraySpecies);
    if (cls.stringTagHelper !== undefined) names.push(cls.stringTagHelper);
  }
  return names;
}
