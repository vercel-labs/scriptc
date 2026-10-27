/* Argument lowering stores a call's values in hidden locals, in source
 * order, through a sequence on the first argument; the other arguments read
 * those locals:
 *
 *   f(seq { %a0 = x; %a1 = {...} } %a0, %a1)
 *
 * A direct call evaluates nothing before its first argument, so the
 * sequence can enclose the whole call instead:
 *
 *   seq { %a0 = x; %a1 = {...} } f(%a0, %a1)
 *
 * The same order, with each local's whole lifetime inside the sequence:
 * the emitter then moves a local into its one read (a fresh literal passed
 * to an owned parameter arrives as the only reference) instead of retaining
 * it for the call and releasing it at scope exit. */
import type { IrFunction, IrModule } from "./ir.js";
import { transformStmtList } from "./traverse.js";

export function hoistCallArgumentSequences(mod: IrModule): IrModule {
  let changed = false;
  const functions = mod.functions.map((fn): IrFunction => {
    let edits = 0;
    const body = transformStmtList(fn.body, {
      expr: (e) => {
        if (e.kind !== "call" || e.args.length < 2) return e;
        const first = e.args[0]!;
        if (first.kind !== "seqExpr") return e;
        edits++;
        return {
          kind: "seqExpr",
          stmts: first.stmts,
          result: { ...e, args: [first.result, ...e.args.slice(1)] },
          type: e.type,
          loc: e.loc,
        };
      },
      stmt: (s) => s,
    });
    if (edits === 0) return fn;
    changed = true;
    return { ...fn, body };
  });
  return changed ? { ...mod, functions } : mod;
}
