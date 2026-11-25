import type { IrExpr, IrFunction, IrModule, IrStmt } from "./ir.js";
import {
  eachNodeOfKinds,
  type IrNodeIndex,
  type IrNodeKind,
  LOCAL_BINDING_KINDS,
} from "./node-index.js";
import { mapExprChildren, mapStmtChildren } from "./traverse.js";

/** The reads and writes of bindings. */
const BINDING_KINDS: readonly IrNodeKind[] = [...LOCAL_BINDING_KINDS, "varRef"];

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
 * builds keep their globals: a host may observe them across the boundary.
 * `nodes`, an index of `mod`, gives the reads and writes without walking
 * the bodies. */
export function foldConstantGlobals(mod: IrModule, nodes?: IrNodeIndex): IrModule {
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
  // Per function, the candidates it reads: the rewrite below visits only the
  // functions that read a constant.
  const readsByFunction = new Map<IrFunction, Set<string>>();
  const scan = nodes?.scan(BINDING_KINDS);
  for (const fn of mod.functions) {
    let read: Set<string> | undefined;
    // Every node other than a read that names the binding is a write
    // (assignments, loop and catch bindings, compound updates); only a
    // plain assignment or declaration contributes a value.
    eachNodeOfKinds(fn, scan, (node) => {
      if (node.kind === "assign") write(node.localId, node.value);
      else if (node.kind === "varDecl") write(node.localId, node.init);
      else if (node.kind === "varRef") {
        if (candidates.has(node.localId)) {
          if (read === undefined) read = new Set();
          read.add(node.localId);
        }
      } else if ("localId" in node && typeof node.localId === "string") write(node.localId, null);
    });
    if (read !== undefined) readsByFunction.set(fn, read);
  }
  const constants = new Map<string, Literal>();
  for (const [id, value] of values) if (writes.get(id) === 1) constants.set(id, value);
  if (constants.size === 0) return mod;

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
    const read = readsByFunction.get(fn);
    if (read === undefined || ![...read].some((id) => constants.has(id))) return fn;
    changed = true;
    return { ...fn, body: fn.body.map(rewriteStmt) };
  });
  return changed ? { ...mod, functions } : mod;
}
