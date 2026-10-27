// Running maximum and minimum updates, `if (v > max) { max = v; ... }`.
// With the accumulator in a register LLVM turns such an update into a
// select (`maxsd`, or a compare and mask), so every element waits on the
// previous one's. The update gets rarer as a scan goes on, so a branch
// predicts well; emitStmtBody gives these `if`s branch weights that say the
// update is rarely taken, and LLVM keeps the branch. A clamp of a value read
// in the same iteration is not an accumulator and keeps its select: its
// branch would go whichever way the data goes. An update nested in another
// branch keeps its select too: kept, its branch can stop LLVM from turning
// the enclosing branch into selects, and that branch may follow the data.

import type { IrExpr, IrFunction, IrStmt } from "../../ir/ir.js";
import { everyExprChild, everyStmtChild } from "../../ir/traverse.js";

type Loop = IrStmt & { kind: "for" | "while" | "doWhile" | "forOf" };

const RELATIONAL = new Set(["<", "<=", ">", ">="]);

/** The `if` statements of `fn` that update a running maximum or minimum:
 * no `else`, a numeric `<`, `<=`, `>` or
 * `>=` between a local and another expression, and a then-block that
 * assigns that expression to the local. The local must carry across
 * iterations: inside a loop the `if` is a statement of the innermost loop's
 * body, the local is declared outside that loop, and the loop writes it only
 * in this `if`; outside any loop the `if` is a statement of the function
 * body and the local is a binding the function captures and writes only in
 * this `if` (a callback that a loop elsewhere calls). */
export function runningExtremumUpdates(fn: IrFunction): Set<IrStmt> {
  const found = new Set<IrStmt>();
  const captured = new Set((fn.captures ?? []).map((c) => c.localId));
  const loops: Loop[] = [];
  const candidates: { s: IrStmt; local: string; loop: Loop | undefined }[] = [];
  const expr = (e: IrExpr): boolean => everyExprChild(e, expr, stmt);
  const stmt = (s: IrStmt): boolean => {
    if (s.kind === "if") {
      const local = updatedExtremum(s);
      if (local !== undefined) candidates.push({ s, local, loop: loops[loops.length - 1] });
    }
    const loop =
      s.kind === "for" || s.kind === "while" || s.kind === "doWhile" || s.kind === "forOf";
    if (loop) loops.push(s);
    everyStmtChild(s, expr, stmt);
    if (loop) loops.pop();
    return true;
  };
  for (const s of fn.body) stmt(s);
  for (const { s, local, loop } of candidates) {
    const scope = loop ?? (captured.has(local) ? fn.body : undefined);
    const body = loop ? loop.body : fn.body;
    if (scope !== undefined && body.includes(s) && writes(scope, local) === 1) found.add(s);
  }
  return found;
}

/** The local an `if` updates to a new maximum or minimum, if it is one. */
function updatedExtremum(s: IrStmt & { kind: "if" }): string | undefined {
  if (s.else_ !== null && s.else_.length > 0) return undefined;
  const c = s.cond;
  if (c.kind !== "bin" || !RELATIONAL.has(c.op)) return undefined;
  if (c.left.type.kind !== "f64" || c.right.type.kind !== "f64") return undefined;
  for (const [local, other] of [
    [c.left, c.right],
    [c.right, c.left],
  ]) {
    if (local!.kind !== "varRef") continue;
    const id = local!.localId;
    const assigns = s.then.some(
      (x) => x.kind === "assign" && x.localId === id && sameExpr(x.value, other!),
    );
    if (assigns) return id;
  }
  return undefined;
}

/** Declarations and writes of `local` under `scope`. A declaration counts
 * as a write too, so a local declared inside a loop does not qualify. */
function writes(scope: IrStmt | IrStmt[], local: string): number {
  let n = 0;
  const expr = (e: IrExpr): boolean => {
    if ((e.kind === "assignExpr" || e.kind === "incDec") && e.localId === local) n++;
    return everyExprChild(e, expr, stmt);
  };
  const stmt = (s: IrStmt): boolean => {
    if ((s.kind === "assign" || s.kind === "varDecl" || s.kind === "forOf") && s.localId === local)
      n++;
    else if (s.kind === "tryCatch" && s.catchLocalId === local) n++;
    return everyStmtChild(s, expr, stmt);
  };
  if (Array.isArray(scope)) for (const s of scope) stmt(s);
  else stmt(scope);
  return n;
}

/** Structural equality of two small expressions (`v`, `a[i]`), ignoring
 * source locations and types; larger expressions do not compare equal. */
function sameExpr(a: IrExpr, b: IrExpr): boolean {
  let budget = 64;
  const same = (x: unknown, y: unknown): boolean => {
    if (--budget < 0) return false;
    if (typeof x !== "object" || x === null || typeof y !== "object" || y === null) return x === y;
    if (Array.isArray(x) !== Array.isArray(y)) return false;
    const keys = Object.keys(x).filter((k) => k !== "loc" && k !== "type");
    if (keys.length !== Object.keys(y).filter((k) => k !== "loc" && k !== "type").length)
      return false;
    return keys.every((k) =>
      same((x as Record<string, unknown>)[k], (y as Record<string, unknown>)[k]),
    );
  };
  return same(a, b);
}
