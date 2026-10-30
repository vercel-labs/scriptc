import type { IrExpr, IrFunction, IrLocal, IrStmt } from "./ir.js";
import { isBorrowSafeMath } from "./analysis.js";
import { byteNumberAccess } from "./byte-numbers.js";
import { everyExprChild, everyStmtChild } from "./traverse.js";

/** Array methods that read the receiver without changing its length or its
 * slot states and run no user code. */
const READING_ARRAY_METHODS = new Set<string>([
  "length",
  "getNumber",
  "indexEq",
  "indexOf",
  "includes",
  "nextPresent",
]);

/** String methods that read an immutable string and run no user code. */
const READING_STRING_METHODS = new Set<string>(["length", "charCodeAt", "codePointAt"]);

/** Map and Set methods that read the receiver and run no user code: keys
 * hash and compare by value or identity, and no array is touched. */
const READING_MAP_METHODS = new Set<string>(["get", "has", "size"]);
const READING_SET_METHODS = new Set<string>(["has", "size"]);

/** Expressions that compute from their operands and run no user code. Their
 * children are checked separately. */
const PLAIN_EXPRESSIONS = new Set<string>([
  "numLit",
  "strLit",
  "boolLit",
  "unitLit",
  "varRef",
  "bin",
  "unary",
  "incDec",
  "toBool",
  "logical",
  "ternary",
  "strEq",
  "strCmp",
  "fieldGet",
  "recordGet",
  "unionNarrow",
  "unionIsTag",
  "unionDisc",
  "unionWrap",
  "upcast",
  "downcast",
  "instanceOf",
  "nullish",
  "seqExpr",
]);

/** Statements whose own effect is a local write or control flow inside the
 * loop. Their children are checked separately. */
const PLAIN_STATEMENTS = new Set<string>([
  "varDecl",
  "assign",
  "exprStmt",
  "if",
  "block",
  "break",
  "continue",
  "for",
  "while",
  "doWhile",
]);

/** Array methods whose result is never the receiver itself (unlike
 * `reverse`, `fill` or `copyWithin`, which return it). */
const CONTAINED_RECEIVER_METHODS = new Set<string>([
  ...READING_ARRAY_METHODS,
  "push",
  "pop",
  "shift",
  "unshift",
  "splice",
  "join",
  "slice",
]);

/** Local arrays that no other binding can hold: every write of the local
 * stores a fresh array literal and every read of it is the receiver of an
 * element access or array method (or the value of a `return`, which ends the
 * activation). No alias of such an array exists, so mutating it cannot change
 * the length of an array held by any other binding. */
export function findUnaliasedLocalArrays(fn: IrFunction): ReadonlySet<string> {
  const candidates = new Set<string>();
  const captured = new Set(
    [...(fn.captures ?? []), ...(fn.classCaptures ?? [])].map((c) => c.localId),
  );
  for (const local of fn.locals)
    if (local.type.kind === "array" && !local.boxed && !local.tdz && !captured.has(local.id))
      candidates.add(local.id);
  for (const param of fn.params) candidates.delete(param.localId);
  const written = new Set<string>();
  const fresh = (value: IrExpr | null): boolean =>
    value !== null && (value.kind === "arrayLit" || value.kind === "arrayNewLen");
  const receiver = (e: IrExpr): void => {
    if (e.kind !== "varRef") expr(e);
  };
  const expr = (e: IrExpr): boolean => {
    switch (e.kind) {
      case "varRef":
        candidates.delete(e.localId);
        return true;
      case "assignExpr":
        candidates.delete(e.localId);
        break;
      case "arrIntrinsic":
        if (!CONTAINED_RECEIVER_METHODS.has(e.method)) break;
        receiver(e.receiver);
        e.args.forEach(expr);
        return true;
      case "arrayGet":
      case "arrayHas":
      case "arrayState":
        receiver(e.arr);
        expr(e.index);
        return true;
    }
    return everyExprChild(e, expr, stmt);
  };
  const stmt = (s: IrStmt): boolean => {
    switch (s.kind) {
      case "varDecl":
      case "assign": {
        const value = s.kind === "varDecl" ? s.init : s.value;
        if (fresh(value)) written.add(s.localId);
        else if (value) candidates.delete(s.localId);
        if (value) expr(value);
        return true;
      }
      case "arraySet":
        receiver(s.arr);
        expr(s.index);
        expr(s.value);
        return true;
      case "return":
        if (s.value) receiver(s.value);
        return true;
      case "forOf":
      case "tryCatch":
        if (s.kind === "forOf") candidates.delete(s.localId);
        if (s.kind === "tryCatch" && s.catchLocalId) candidates.delete(s.catchLocalId);
        break;
    }
    return everyStmtChild(s, expr, stmt);
  };
  fn.body.every(stmt);
  // A binding with no visible write takes its value some other way.
  for (const id of candidates) if (!written.has(id)) candidates.delete(id);
  return candidates;
}

export interface ArrayLengthLoop {
  /** The local holding the array whose length must not change. */
  receiver: string;
  /** A binding that holds a value below the array's length wherever the
   * loop's condition, body or update reads it (the induction variable of
   * `for (let i = 0; i < a.length; i++)` when the body never writes it, as
   * long as the length itself has not changed). An element write at this
   * index replaces an existing element or sets a non-index property. */
  inRange: string | null;
  /** A second such binding: the high counter of a two-counter loop
   * (`for (let i = lo, j = hi; i < j; i++, j--)`), whose values stay
   * between the low counter's start and its own. */
  inRangeHigh?: string | null;
}

/** Whether running `nodes` (a loop's condition, body and update) can never
 * change the length of the array held by local `loop.receiver`. The proof is
 * syntactic and conservative: every expression and statement must be one
 * that runs no user code (no calls other than checked union extractions, no
 * callbacks, closures, iterators, suspension or exception regions; Map and
 * Set reads are accepted); the binding is never written and only
 * ever read as the receiver of an element access or a reading array method,
 * so the array cannot escape to code that resizes it; and nothing in the
 * nodes resizes any array that may be the same one. Element writes are
 * accepted at the in-range binding (no array grows by them: an alias of the
 * receiver has the same length) and anywhere in an unaliased local array.
 * Array methods that resize an array are accepted only on unaliased local
 * arrays other than the receiver. */
export function preservesArrayLength(
  nodes: readonly (IrExpr | IrStmt)[],
  loop: ArrayLengthLoop,
  locals: ReadonlyMap<string, IrLocal>,
  unaliased: ReadonlySet<string>,
): boolean {
  const local = locals.get(loop.receiver);
  if (!local || local.type.kind !== "array" || local.boxed || local.tdz) return false;
  const separate = (e: IrExpr): boolean =>
    e.kind === "varRef" && e.localId !== loop.receiver && unaliased.has(e.localId);
  // A receiver position: the receiver binding itself is read there without
  // escaping.
  const receiver = (e: IrExpr): boolean =>
    (e.kind === "varRef" && e.localId === loop.receiver) || expr(e);
  const inRange = (id: string): boolean =>
    (loop.inRange !== null && id === loop.inRange) ||
    (loop.inRangeHigh != null && id === loop.inRangeHigh);
  const written = (id: string): boolean => id === loop.receiver || inRange(id);
  const expr = (e: IrExpr): boolean => {
    switch (e.kind) {
      case "varRef":
        return e.localId !== loop.receiver;
      case "assignExpr":
      case "incDec":
        return !written(e.localId) && everyExprChild(e, expr, stmt);
      case "arrayGet":
      case "arrayHas":
      case "arrayState":
        return receiver(e.arr) && expr(e.index);
      case "arrIntrinsic":
        if (READING_ARRAY_METHODS.has(e.method)) return receiver(e.receiver) && e.args.every(expr);
        return separate(e.receiver) && e.args.every(expr);
      case "strIntrinsic":
        return (
          READING_STRING_METHODS.has(e.method) &&
          e.receiver.type.kind === "string" &&
          expr(e.receiver) &&
          e.args.every(expr)
        );
      case "bytesIntrinsic": {
        const numeric = byteNumberAccess(e);
        return (
          (numeric ? !numeric.write : e.method === "get" || e.method === "length") &&
          expr(e.receiver) &&
          e.args.every(expr)
        );
      }
      case "call":
        // A checked union extraction (`x!`, coercions/unions.ts): the
        // asserted arm's payload or a TypeError, and no user code.
        if (e.callee.startsWith("%union.narrow.")) return e.args.every(expr);
        // An element read as `T | undefined` (int32-arrays.ts isElementReader).
        return (
          e.callee.startsWith("%arr.idxOr.") &&
          e.args.length === 2 &&
          receiver(e.args[0]!) &&
          expr(e.args[1]!)
        );
      case "mapIntrinsic":
        return READING_MAP_METHODS.has(e.method) && expr(e.receiver) && e.args.every(expr);
      case "setIntrinsic":
        return READING_SET_METHODS.has(e.method) && expr(e.receiver) && e.args.every(expr);
      case "libCall":
        // The TypeError of an assertion past a union arm leaves the loop.
        if (e.fn === "error.nodeThrow") return e.args.every(expr);
        return (
          isBorrowSafeMath(e.fn) &&
          e.args.every((arg) => arg.type.kind === "f64") &&
          e.args.every(expr)
        );
      case "strConcat":
        return (
          e.left.type.kind === "string" &&
          e.right.type.kind === "string" &&
          expr(e.left) &&
          expr(e.right)
        );
      default:
        return PLAIN_EXPRESSIONS.has(e.kind) && everyExprChild(e, expr, stmt);
    }
  };
  const stmt = (s: IrStmt): boolean => {
    switch (s.kind) {
      case "varDecl":
      case "assign":
        if (written(s.localId)) return false;
        break;
      case "arraySet":
        return (
          (separate(s.arr) || (s.index.kind === "varRef" && inRange(s.index.localId))) &&
          receiver(s.arr) &&
          expr(s.index) &&
          expr(s.value)
        );
      case "arraySetUndefined":
        // A present undefined replacing an element below the length.
        return (
          (separate(s.arr) || (s.index.kind === "varRef" && inRange(s.index.localId))) &&
          receiver(s.arr) &&
          expr(s.index)
        );
      case "return":
        return s.value === null || expr(s.value);
      case "fieldSet":
        // A number or boolean stored into a class field: accessors are
        // calls, not field writes, and the old value holds no reference to
        // release, so the write runs no user code.
        return (
          (s.value.type.kind === "f64" || s.value.type.kind === "bool") &&
          expr(s.obj) &&
          expr(s.value)
        );
      default:
        if (!PLAIN_STATEMENTS.has(s.kind)) return false;
    }
    return everyStmtChild(s, expr, stmt);
  };
  return nodes.every((node) => ("type" in node ? expr(node as IrExpr) : stmt(node as IrStmt)));
}
