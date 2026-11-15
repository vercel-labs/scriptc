import type { IrExpr, IrFunction, IrModule } from "./ir.js";
import { everyStmtList } from "./traverse.js";

/** The function an expression names as a value rather than as a direct
 * call's callee: a closure's code, the union→union retag helper an
 * `orDefault` hands its left box to, or the adapter body a `viewOf` or
 * `viewSource` recognizes a view by. These are the only expression fields
 * that hold a module function's name besides `call.callee`
 * (function-references.test.ts classifies every string field of the IR). */
export function exprFunctionReference(expr: IrExpr): string | undefined {
  if (expr.kind === "closure") return expr.fnName;
  if (expr.kind === "orDefault") return expr.retag;
  if (expr.kind === "viewOf" || expr.kind === "viewSource") return expr.adapter ?? undefined;
  return undefined;
}

/** The expression kinds exprFunctionReference answers for. */
export const FUNCTION_REFERENCE_KINDS = ["closure", "orDefault", "viewOf", "viewSource"] as const;

/** Functions the module's metadata names: the entry, library exports,
 * closures' jsval entries, the class prototype helpers the runtime calls
 * and the record links' compose helpers the record walkers call. Class
 * methods and constructors follow the `%<class>.<method>` convention
 * instead of being named here; callers that need them derive them from
 * `mod.classes`. */
export function moduleFunctionReferences(mod: IrModule): string[] {
  return metadataReferences(mod, true);
}

/** moduleFunctionReferences, with or without the closures' jsval entries.
 * A function names its entry for itself, so a walk that follows functions
 * (withoutUnreachedFunctions) reaches an entry when it reaches its closure. */
function metadataReferences(mod: IrModule, jsEntries: boolean): string[] {
  const names = [mod.entry];
  for (const entry of mod.lib?.exports ?? []) names.push(entry.fnName);
  if (jsEntries)
    for (const fn of mod.functions) if (fn.jsEntry !== undefined) names.push(fn.jsEntry);
  for (const cls of mod.classes ?? []) {
    if (cls.prototypeDataHelper !== undefined) names.push(cls.prototypeDataHelper);
    if (cls.instancePrototypeHelper !== undefined) names.push(cls.instancePrototypeHelper);
    if (cls.arrayFields !== undefined) names.push(cls.arrayFields);
    if (cls.arraySpecies !== undefined) names.push(cls.arraySpecies);
    if (cls.stringTagHelper !== undefined) names.push(cls.stringTagHelper);
    for (const accessor of cls.viewAccessors ?? []) names.push(accessor.helper);
  }
  for (const link of mod.recordLinks ?? []) names.push(link.compose);
  return names;
}

/** The properties of an error whose reads the runtime answers through a
 * function of the module (errorReaderName), when the module defines it. */
export const ERROR_READER_PROPERTIES = ["name", "message"] as const;

/** The module function the runtime calls to read an error's `property`. The
 * emitter installs it when the module defines it; no expression names it. */
export function errorReaderName(property: string): string {
  return `%error.${property}.read`;
}

/** The table that reboxes class instances to their exact classes. The
 * emitter reads its branches when the module defines it, whether or not an
 * expression calls it. */
export const CLASS_NORMALIZER = "%dyn.class.normalize";

/** Whether `name` follows the `%<class>.<member>` convention of class
 * methods, accessors and constructors for one of `classNames`. */
export function isClassMemberName(name: string, classNames: ReadonlySet<string>): boolean {
  if (!name.startsWith("%")) return false;
  for (let dot = name.indexOf("."); dot !== -1; dot = name.indexOf(".", dot + 1)) {
    if (classNames.has(name.slice(1, dot))) return true;
  }
  return false;
}

/** `mod` without the functions of `removable` that nothing reaches. A
 * function is reached through a call, a function reference
 * (exprFunctionReference), a closure's jsval entry, the module's metadata
 * (moduleFunctionReferences), the names the emitter looks up
 * (errorReaderName, CLASS_NORMALIZER), or a string literal that spells its
 * name (`Error.captureStackTrace` names the function whose frames it skips
 * that way). Functions outside `removable` are all kept and all reach, and
 * so are class members, which dispatch reaches by the `%<class>.<member>`
 * convention: a caller passes the functions lowering generated, whose only
 * uses are the ones above. Returns `mod` itself when every removable
 * function is reached. */
export function withoutUnreachedFunctions(mod: IrModule, removable: ReadonlySet<string>): IrModule {
  const classNames = new Set<string>();
  for (const cls of mod.classes ?? []) classNames.add(cls.name);
  const candidates = new Map<string, IrFunction>();
  for (const fn of mod.functions)
    if (removable.has(fn.name) && !isClassMemberName(fn.name, classNames))
      candidates.set(fn.name, fn);
  if (candidates.size === 0) return mod;
  const reached = new Set<string>();
  const pending: IrFunction[] = [];
  const reach = (name: string): void => {
    if (reached.has(name)) return;
    const fn = candidates.get(name);
    if (fn === undefined) return;
    reached.add(name);
    pending.push(fn);
  };
  const scan = (fn: IrFunction): void => {
    if (fn.jsEntry !== undefined) reach(fn.jsEntry);
    everyStmtList(fn.body, {
      expr: (expr) => {
        if (expr.kind === "call") reach(expr.callee);
        else if (expr.kind === "strLit") reach(expr.value);
        else {
          const referenced = exprFunctionReference(expr);
          if (referenced !== undefined) reach(referenced);
        }
        return true;
      },
      stmt: () => true,
    });
  };
  for (const name of metadataReferences(mod, false)) reach(name);
  for (const property of ERROR_READER_PROPERTIES) reach(errorReaderName(property));
  reach(CLASS_NORMALIZER);
  for (const fn of mod.functions) if (!candidates.has(fn.name)) scan(fn);
  for (let fn = pending.pop(); fn !== undefined; fn = pending.pop()) scan(fn);
  if (reached.size === candidates.size) return mod;
  return {
    ...mod,
    functions: mod.functions.filter((fn) => !candidates.has(fn.name) || reached.has(fn.name)),
  };
}
