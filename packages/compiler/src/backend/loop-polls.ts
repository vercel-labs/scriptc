/* Which worker-program loops can skip their termination poll. */
import type { IrExpr, IrStmt } from "../ir/ir.js";
import { everyExprChild, everyStmtChild } from "../ir/traverse.js";

type Loop = Extract<IrStmt, { kind: "while" | "doWhile" | "for" | "forOf" }>;

/** Expression kinds whose operands all evaluate whenever the expression does
 * (no short-circuit, deferred or conditional operand). */
const EAGER_EXPRS: ReadonlySet<string> = new Set([
  "call",
  "new",
  "virtualCall",
  "callValue",
  "bin",
  "unary",
  "toBool",
  "strConcat",
  "strEq",
  "strCmp",
  "assignExpr",
  "fieldGet",
  "fieldIncDec",
  "arrayGet",
  "recordGet",
  "upcast",
  "downcast",
  "unionWrap",
  "unionRetype",
  "dynFrom",
]);

/** Statement kinds whose expressions all evaluate whenever the statement
 * does. */
const EAGER_STMTS: ReadonlySet<string> = new Set([
  "varDecl",
  "assign",
  "exprStmt",
  "arraySet",
  "bytesSet",
  "fieldSet",
  "recordSet",
  "return",
  "throw",
]);

/** True when every iteration of `loop` evaluates a call that the emitter
 * follows with a pending test (`tested`). Worker loops poll for termination
 * every 64 iterations (emitWorkerLoopCheck) so that a loop whose body calls
 * nothing that tests still observes a terminate request; a pending test reads
 * the same alert word, so a loop that always runs one needs no extra poll.
 * The tested call must be unconditional: in the condition (while, for), in
 * the update or the do-while condition (both run after `continue` too), or
 * in the body before any statement that can `continue` this loop. */
export function loopTestsEveryIteration(loop: Loop, tested: (call: IrExpr) => boolean): boolean {
  const evaluates = (e: IrExpr): boolean => {
    if (tested(e)) return true;
    if (!EAGER_EXPRS.has(e.kind)) return false;
    let found = false;
    everyExprChild(
      e,
      (child) => !(found = evaluates(child)),
      () => true,
    );
    return found;
  };
  const statementEvaluates = (s: IrStmt): boolean => {
    if (s.kind === "if") return evaluates(s.cond);
    if (s.kind === "block") return s.body.some(statementEvaluates);
    if (!EAGER_STMTS.has(s.kind)) return false;
    let found = false;
    everyStmtChild(
      s,
      (child) => !(found = evaluates(child)),
      () => true,
    );
    return found;
  };
  const labels = new Set(loop.labels ?? []);
  // Can `s` jump to this loop's next iteration? Unlabeled continues bind to
  // the innermost enclosing loop; labeled ones may skip out of nested loops.
  const continues = (s: IrStmt, nested: boolean): boolean => {
    if (s.kind === "continue") return s.label === undefined ? !nested : labels.has(s.label);
    const inner =
      nested ||
      s.kind === "while" ||
      s.kind === "doWhile" ||
      s.kind === "for" ||
      s.kind === "forOf";
    let found = false;
    everyStmtChild(
      s,
      () => true,
      (child) => !(found = continues(child, inner)),
    );
    return found;
  };
  if (loop.kind === "while" && evaluates(loop.cond)) return true;
  if (loop.kind === "doWhile" && evaluates(loop.cond)) return true;
  if (loop.kind === "for") {
    if (loop.cond !== null && evaluates(loop.cond)) return true;
    if (loop.update !== null && statementEvaluates(loop.update)) return true;
  }
  for (const s of loop.body) {
    if (continues(s, false)) return false;
    if (statementEvaluates(s)) return true;
  }
  return false;
}

/** True when the body of `loop`, outside its nested loops and closures,
 * reads or writes a typed-array element: the loops whose cancellation poll
 * the emitter moves between blocks of iterations, so that LLVM can
 * vectorize them. Outside another loop, other loops keep the budget in
 * their body, which costs less in a loop of a few iterations. */
export function loopAccessesTypedArrays(loop: Loop): boolean {
  const inExpr = (e: IrExpr): boolean => {
    if (e.kind === "bytesIntrinsic" && e.method === "get") return true;
    let found = false;
    everyExprChild(
      e,
      (child) => !(found = inExpr(child)),
      (child) => !(found = inStmt(child)),
    );
    return found;
  };
  const inStmt = (s: IrStmt): boolean => {
    if (s.kind === "bytesSet") return true;
    if (s.kind === "while" || s.kind === "doWhile" || s.kind === "for" || s.kind === "forOf")
      return false;
    let found = false;
    everyStmtChild(
      s,
      (child) => !(found = inExpr(child)),
      (child) => !(found = inStmt(child)),
    );
    return found;
  };
  return loop.body.some(inStmt);
}

/** Whether `body` holds a loop outside its closures. */
export function containsLoop(body: readonly IrStmt[]): boolean {
  const inStmt = (s: IrStmt): boolean =>
    s.kind === "while" ||
    s.kind === "doWhile" ||
    s.kind === "for" ||
    s.kind === "forOf" ||
    !everyStmtChild(
      s,
      () => true,
      (child) => !inStmt(child),
    );
  return body.some(inStmt);
}
