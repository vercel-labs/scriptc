import type { IrExpr, IrFunction, IrModule, IrStmt } from "./ir.js";
import { everyStmtList, mapExprChildren, mapStmtChildren } from "./traverse.js";

type Literal = (IrExpr & { kind: "numLit" }) | (IrExpr & { kind: "boolLit" });

/** Module constants such as `const DOT = 0x2e` read as their literal.
 *
 * A module-level binding is a global that the module initializer stores
 * once; every other function loads it (a thread-local load in worker
 * programs), which also hides the value from integer ranges, switch
 * dispatch and LLVM's constant folding. When the global is immutable, has
 * exactly one write in the program and that write stores a number or
 * boolean literal, every read sees that literal: reads that could run before
 * the store carry the frontend's initialization flag (`initFlag`) or a TDZ
 * sentinel, and those globals are left alone. The store stays, so module
 * namespace views and debuggers still find the value in the global. Library
 * builds keep their globals: a host may observe them across the boundary. */
export function foldConstantGlobals(mod: IrModule): IrModule {
  if (mod.lib || !mod.globals?.length) return mod;
  const candidates = new Set<string>();
  for (const g of mod.globals)
    if (
      !g.mutable &&
      g.tdz !== true &&
      g.initFlag === undefined &&
      (g.type.kind === "f64" || g.type.kind === "bool")
    )
      candidates.add(g.id);
  if (candidates.size === 0) return mod;

  const writes = new Map<string, number>();
  const values = new Map<string, Literal>();
  const write = (id: string, value: IrExpr | null): void => {
    if (!candidates.has(id)) return;
    writes.set(id, (writes.get(id) ?? 0) + 1);
    if (value && (value.kind === "numLit" || value.kind === "boolLit")) values.set(id, value);
    else values.delete(id);
  };
  for (const fn of mod.functions)
    everyStmtList(fn.body, {
      // Every node other than a read that names the binding is a write
      // (assignments, loop and catch bindings, compound updates); only a
      // plain assignment or declaration contributes a value.
      stmt: (s) => {
        if (s.kind === "assign") write(s.localId, s.value);
        else if (s.kind === "varDecl") write(s.localId, s.init);
        else if ("localId" in s && typeof s.localId === "string") write(s.localId, null);
        return true;
      },
      expr: (e) => {
        if (e.kind !== "varRef" && "localId" in e && typeof e.localId === "string")
          write(e.localId, null);
        return true;
      },
    });
  const constants = new Map<string, Literal>();
  for (const [id, value] of values) if (writes.get(id) === 1) constants.set(id, value);
  if (constants.size === 0) return mod;

  const reads = (e: IrExpr): boolean => !(e.kind === "varRef" && constants.has(e.localId));
  const rewriteExpr = (e: IrExpr): IrExpr => {
    if (e.kind === "varRef") {
      const value = constants.get(e.localId);
      return value ? { ...value, type: e.type, loc: e.loc } : e;
    }
    return mapExprChildren(e, rewriteExpr, rewriteStmt);
  };
  const rewriteStmt = (s: IrStmt): IrStmt => mapStmtChildren(s, rewriteExpr, rewriteStmt);
  let changed = false;
  const functions = mod.functions.map((fn): IrFunction => {
    if (everyStmtList(fn.body, { stmt: () => true, expr: reads })) return fn;
    changed = true;
    return { ...fn, body: fn.body.map(rewriteStmt) };
  });
  return changed ? { ...mod, functions } : mod;
}
