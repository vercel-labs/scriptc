/* The `SingleOwner` contract's diagnostic (experimental
 * @scriptc/experimental, backend/tree-classes.ts): a class declared
 * `implements SingleOwner` whose instances the tree-class proof cannot give
 * one owner each. The proof needs the emitter's own ownership facts, so it
 * runs during emission; this module turns the plan's rejection reasons into
 * the error the build boundaries report as SC7010. */
import type { IrFunction, IrModule, SrcLoc } from "../../ir/ir.js";
import { LlvmUnsupportedError } from "./unsupported.js";

/** Why a marked class did not get the single-owner layout, in source terms:
 * the plan's reason strings name IR functions and local ids. */
export class SingleOwnerError extends LlvmUnsupportedError {
  constructor(
    readonly className: string,
    loc: SrcLoc,
    readonly reasons: readonly string[],
    hint: string,
    also: readonly SingleOwnerError[] = [],
  ) {
    super("singleOwner", loc, undefined, hint, also);
  }

  /** The diagnostic's text: the class, then each rule the program breaks. */
  override describe(): string {
    return `'${this.className}' cannot keep its SingleOwner contract: ${this.reasons.join("; ")}`;
  }
}

/** The errors for the marked classes the plan rejected, the first carrying
 * the others beside it. Rejection reasons are `TreeClassPlan.rejected`. */
export function singleOwnerErrors(
  mod: IrModule,
  failed: readonly string[],
  rejected: ReadonlyMap<string, readonly string[]>,
): SingleOwnerError[] {
  const errors = failed.map((name) => {
    const cls = mod.classes?.find((def) => def.name === name);
    const sourceName = cls?.jsName ?? name.replace(/^%(m\d+\.)?/, "");
    const reasons = (rejected.get(name) ?? []).map((reason) => sourceReason(mod, reason));
    return new SingleOwnerError(sourceName, cls?.loc ?? entryLoc(mod), reasons, HINT);
  });
  const [first, ...rest] = errors;
  if (first === undefined) return [];
  return [new SingleOwnerError(first.className, first.loc!, first.reasons, HINT, rest)];
}

const HINT =
  "keep each instance in one place at a time: the class's own fields, a local, a parameter or a returned value, never an array, record, global, closure or another class's field; remove `implements SingleOwner` to keep the ordinary layout, which behaves the same";

/** One plan reason, with the IR's function and local names written as the
 * source names: `total: local left.0 aliases ...` becomes `in total, local
 * 'left' aliases ...`. A reason that starts with a slot ("countAll parameter
 * nodes holds it ...") already names source declarations. */
function sourceReason(mod: IrModule, reason: string): string {
  const at = reason.indexOf(": ");
  if (at >= 0) {
    const fn = mod.functions.find((f) => f.name === reason.slice(0, at));
    if (fn !== undefined) {
      const body = reason.slice(at + 2);
      return `in ${functionName(mod, fn)}, ${localNames(fn, body)}`;
    }
  }
  // A slot reason names its holder first, and a module initializer's IR name
  // is not a source name.
  const init = /^%init\.\d+ /.exec(reason);
  if (init !== null) return `in the module's top-level code, ${reason.slice(init[0].length)}`;
  return reason;
}

function functionName(mod: IrModule, fn: IrFunction): string {
  const name = fn.name;
  const dot = name.lastIndexOf(".");
  if (name.startsWith("%") && dot > 1) {
    const owner = name.slice(1, dot);
    const cls = mod.classes?.find((def) => def.name === owner);
    if (cls !== undefined) return `${cls.jsName ?? owner}.${name.slice(dot + 1)}`;
  }
  return fn.sourceName ?? name.replace(/^%/, "");
}

/** The reason with each `<function's local id>` named as its source name. */
function localNames(fn: IrFunction, body: string): string {
  return body.replace(/\blocal (\S+)/g, (text, id: string) => {
    const local = fn.locals.find((l) => l.id === id);
    return local === undefined ? text : `local '${local.name}'`;
  });
}

function entryLoc(mod: IrModule): SrcLoc {
  return { file: mod.sourceFile, start: 0, end: 0 };
}
