import type { IrExpr, IrFunction, IrModule, IrStmt } from "./ir.js";
import { everyExprChild, everyStmtChild, mapExprChildren, transformStmtList } from "./traverse.js";

/** Callee bodies above this many nodes keep their call. */
const MAX_EXPRESSION_NODES = 32;

/** Number operators that run no other code and cannot throw. */
const PURE_BINARY = new Set<string>([
  "+",
  "-",
  "*",
  "/",
  "%",
  "**",
  "&",
  "|",
  "^",
  "<<",
  ">>",
  ">>>",
]);

/** The returned expression of a function whose body is `return <expr>` over
 * its number parameters: literals, parameter reads, and the number
 * operators of PURE_BINARY, unary `-` and `~`. Null for any other function. */
function inlinableExpression(fn: IrFunction): IrExpr | null {
  if (fn.async || fn.generator || fn.captures !== undefined || fn.classCaptures?.length)
    return null;
  if (fn.tier === "dynamic" || fn.returnType.kind !== "f64") return null;
  if (fn.body.length !== 1) return null;
  const only = fn.body[0]!;
  if (only.kind !== "return" || only.value === null) return null;
  const params = new Set<string>();
  for (const param of fn.params) {
    if (param.type.kind !== "f64") return null;
    params.add(param.localId);
  }
  const locals = new Map(fn.locals.map((local) => [local.id, local]));
  for (const id of params) {
    const local = locals.get(id);
    if (local === undefined || local.boxed || local.tdz) return null;
  }
  let nodes = 0;
  const pure = (e: IrExpr): boolean => {
    if (++nodes > MAX_EXPRESSION_NODES || e.type.kind !== "f64") return false;
    switch (e.kind) {
      case "numLit":
        return true;
      case "varRef":
        return params.has(e.localId);
      case "bin":
        return PURE_BINARY.has(e.op) && pure(e.left) && pure(e.right);
      case "unary":
        return (e.op === "-" || e.op === "~") && pure(e.operand);
      default:
        return false;
    }
  };
  return pure(only.value) ? only.value : null;
}

/** A call argument that reads the same value wherever the inlined body
 * reads it: a number literal or a read of one of the caller's own unboxed
 * locals outside the temporal dead zone. The body writes nothing, so every
 * read sees the value the call would have passed. */
function duplicableArgument(e: IrExpr, caller: ReadonlyMap<string, IrFunction["locals"][number]>) {
  if (e.type.kind !== "f64") return false;
  // A literal whose source spelling does not round-trip keeps its call.
  if (e.kind === "numLit") return e.spelling === undefined;
  if (e.kind !== "varRef") return false;
  const local = caller.get(e.localId);
  return local !== undefined && !local.boxed && !local.tdz;
}

/** A fresh copy of `e`: facts downstream are keyed by node identity. */
function copy(e: IrExpr, substitute: (ref: IrExpr & { kind: "varRef" }) => IrExpr): IrExpr {
  if (e.kind === "varRef") return substitute(e);
  return mapExprChildren(
    { ...e },
    (child) => copy(child, substitute),
    (stmt) => stmt,
  );
}

/** The direct calls of `body` that run inside a loop body or condition. */
function callsInLoops(body: IrStmt[]): Set<IrExpr> {
  const found = new Set<IrExpr>();
  let depth = 0;
  const expr = (e: IrExpr): boolean => {
    if (depth > 0 && e.kind === "call") found.add(e);
    return everyExprChild(e, expr, stmt);
  };
  const stmt = (s: IrStmt): boolean => {
    const loop =
      s.kind === "for" || s.kind === "while" || s.kind === "doWhile" || s.kind === "forOf";
    if (loop) depth++;
    everyStmtChild(s, expr, stmt);
    if (loop) depth--;
    return true;
  };
  body.forEach(stmt);
  return found;
}

/** Inlines functions whose body is one number expression over their
 * parameters (`function a(i, j) { return (((i + j) * (i + j + 1)) >>> 1) +
 * i + 1; }`) at direct call sites that pass literals or reads of the
 * caller's locals.
 *
 * The callee runs no other code, allocates nothing and cannot throw, so
 * the call's only effect is its result. Its arguments are reads that
 * nothing between them and the callee's reads can change, so substituting
 * them gives the same value. The caller's loop and integer analyses then
 * see the arithmetic on its own counters (`a(i, j)` inside a counted loop
 * over `i` and `j`). Only calls inside loops are inlined: elsewhere the
 * integer analyses gain nothing. The function itself stays for its other
 * uses. */
export function inlineExpressionFunctions(mod: IrModule): IrModule {
  const members = new Set((mod.classes ?? []).flatMap((cls) => cls.methods ?? []));
  const expressions = new Map<string, { fn: IrFunction; value: IrExpr }>();
  for (const fn of mod.functions) {
    if (fn.name === mod.entry || members.has(fn.name)) continue;
    const value = inlinableExpression(fn);
    if (value !== null) expressions.set(fn.name, { fn, value });
  }
  if (expressions.size === 0) return mod;
  let changed = false;
  const functions = mod.functions.map((fn) => {
    const locals = new Map(fn.locals.map((local) => [local.id, local]));
    const inLoops = callsInLoops(fn.body);
    // Each call the rewrite inlines: of an expression function, in a loop,
    // with arguments the copy may repeat.
    const inlinable = (e: IrExpr & { kind: "call" }): boolean => {
      if (e.callee === fn.name) return false;
      const target = expressions.get(e.callee);
      return (
        target !== undefined &&
        target.fn.params.length === e.args.length &&
        e.args.every((arg) => duplicableArgument(arg, locals))
      );
    };
    if (![...inLoops].some((e) => e.kind === "call" && inlinable(e))) return fn;
    let inlined = false;
    const body = transformStmtList(fn.body, {
      stmt: (s) => s,
      expr: (e) => {
        if (e.kind !== "call" || !inLoops.has(e) || !inlinable(e)) return e;
        const target = expressions.get(e.callee)!;
        const args = new Map(target.fn.params.map((param, i) => [param.localId, e.args[i]!]));
        inlined = true;
        return copy(target.value, (ref) => {
          const arg = args.get(ref.localId);
          if (arg?.kind === "numLit")
            return { kind: "numLit", value: arg.value, type: arg.type, loc: ref.loc };
          if (arg?.kind === "varRef")
            return { kind: "varRef", localId: arg.localId, type: arg.type, loc: ref.loc };
          return ref;
        });
      },
    });
    if (!inlined) return fn;
    changed = true;
    return { ...fn, body };
  });
  return changed ? { ...mod, functions } : mod;
}
