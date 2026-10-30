import { isBorrowSafeMath } from "./analysis.js";
import type { IrExpr, IrFunction, IrLibFn, IrStmt } from "./ir.js";
import { eachNodeOfKinds, type IrNodeIndex } from "./node-index.js";
import { everyExprChild, everyStmtChild } from "./traverse.js";

/** Expression kinds that run no user code of their own and never consult
 * the ambient receiver stack. Calls are admitted here and resolved through
 * the module call graph below; callValue brackets its own receiver. */
const RECEIVER_FREE_EXPRS = new Set<IrExpr["kind"]>([
  "numLit",
  "boolLit",
  "strLit",
  "unitLit",
  "varRef",
  "bin",
  "unary",
  "logical",
  "ternary",
  "seqExpr",
  "incDec",
  "fieldIncDec",
  "assignExpr",
  "toBool",
  "toString",
  "strConcat",
  "strEq",
  "strCmp",
  "nullish",
  "orDefault",
  "optChain",
  "chainRecv",
  "unionWrap",
  "unionRetype",
  "unionNarrow",
  "unionIsTag",
  "unionEq",
  "unionDisc",
  "upcast",
  "downcast",
  "dynFrom",
  "instanceOf",
  "fieldGet",
  "fieldAbsent",
  "recordGet",
  "recordHas",
  "recordLit",
  "recordClone",
  "arrayGet",
  "arrayHas",
  "arrayState",
  "arrayLit",
  "arrayNewLen",
  "selfRef",
  "closure",
  "callValue",
  "call",
  "new",
  "virtualCall",
  "libCall",
  "arrIntrinsic",
  "strIntrinsic",
  "mapIntrinsic",
  "setIntrinsic",
  "mapNew",
  "setNew",
  "bytesIntrinsic",
  "bytesNew",
  "intrinsic",
]);

const RECEIVER_FREE_STMTS = new Set<IrStmt["kind"]>([
  "varDecl",
  "assign",
  "exprStmt",
  "return",
  "if",
  "while",
  "doWhile",
  "for",
  "forOf",
  "switch",
  "block",
  "break",
  "continue",
  "fieldSet",
  "recordSet",
  "arraySet",
  "arraySetUndefined",
  "arraySetLength",
  "bytesSet",
  "throw",
  "rethrow",
  "tryCatch",
  // The deferred compile fence throws a fixed catchable Error
  // (scr_throw_error_msg_code).
  "runtimeFence",
]);

/** The kinds whose nodes the readers walk answers true for without looking
 * at them: every receiver-free statement, and the receiver-free expressions
 * other than calls, library calls, string conversions and data intrinsics. */
const TRIVIALLY_RECEIVER_FREE = new Set<string>([
  ...RECEIVER_FREE_STMTS,
  ...[...RECEIVER_FREE_EXPRS].filter(
    (kind) =>
      kind !== "call" &&
      kind !== "new" &&
      kind !== "virtualCall" &&
      kind !== "libCall" &&
      kind !== "toString" &&
      kind !== "arrIntrinsic" &&
      kind !== "strIntrinsic" &&
      kind !== "mapIntrinsic" &&
      kind !== "setIntrinsic" &&
      kind !== "bytesIntrinsic" &&
      kind !== "bytesNew" &&
      kind !== "intrinsic",
  ),
]);

/** Runtime library calls beyond scalar Math that only compute or build and
 * park a native error: the f64[] folds behind Math.max/min(...xs),
 * `new Error(message)` (scr_error_new), and the checked-read TypeError
 * (scr_throw_node_coded). */
const RECEIVER_FREE_LIB_FNS = new Set<IrLibFn>([
  "math.maxArr",
  "math.minArr",
  "error.new",
  "error.nodeThrow",
  "perf.now",
  "atomics.op",
]);

/** Intrinsics that only check a flag or switch the current lifetime
 * region: the module binding check (which throws a fixed ReferenceError)
 * and the LifetimeRegion operations. */
const RECEIVER_FREE_INTRINSICS = new Set<string>([
  "module.tdzCheck",
  "region.create",
  "region.enter",
  "region.leave",
  "region.release",
]);

function primitiveOperand(e: IrExpr): boolean {
  const kind = e.type.kind;
  return kind === "string" || kind === "f64" || kind === "bool";
}

/** A dynamic value boxed from a primitive, which converts to a string
 * without user code. */
function primitiveDynOperand(e: IrExpr): boolean {
  if (e.kind !== "dynFrom") return false;
  const kind = e.value.type.kind;
  return kind === "string" || kind === "f64" || kind === "bool" || kind === "undefinedT";
}

/** Whether a library call runs no user code: scalar Math, the members
 * above, `new Error(message, options)` over a primitive message without an
 * options object, and string and number members over primitive operands. */
function receiverFreeLibCall(e: Extract<IrExpr, { kind: "libCall" }>): boolean {
  if (isBorrowSafeMath(e.fn) || RECEIVER_FREE_LIB_FNS.has(e.fn)) return true;
  if (e.fn === "error.newOptions") return e.args.every(primitiveDynOperand);
  if (e.fn.startsWith("string.") || e.fn.startsWith("num.")) return e.args.every(primitiveOperand);
  return false;
}

/** Typed container and string operations. Their runtime paths compare and
 * copy values but never call back into compiled code, as long as no
 * operand is a function or a checked value. */
/** Operands of a data intrinsic (receiver first), or null when `e` is not
 * one. A switch over the kinds keeps this inside the self-hosted subset,
 * which has no `in` on IR expression unions. */
function dataIntrinsicOperands(e: IrExpr): IrExpr[] | null {
  switch (e.kind) {
    case "arrIntrinsic":
    case "strIntrinsic":
    case "mapIntrinsic":
    case "setIntrinsic":
    case "bytesIntrinsic":
      return [e.receiver, ...e.args];
    // A typed source is copied element by element; a dynamic one may be an
    // iterable whose iterator is user code.
    case "bytesNew":
      return e.source === null ? [] : [e.source];
    case "mapNew":
    case "setNew":
      return [];
    default:
      return null;
  }
}

function opaqueOperand(e: IrExpr): boolean {
  const kind = e.type.kind;
  return kind === "func" || kind === "dyn" || kind === "caught";
}

/** The functions that may observe the ambient receiver stack when entered
 * without a fresh binding: the JS `this` read (libCall dyn.this), async and
 * generator creation (which snapshot it), checked-value operations,
 * diagnostics-channel stores, and anything outside the admitted kinds; then
 * every function that can reach one through a direct call, constructor or
 * virtual dispatch (a backward reachability fixpoint, so recursion such as
 * a tree walker's `evaluate` resolves exactly). A known callback outside
 * this set needs no receiver bracket. */
export class AmbientReceiverReaders {
  private readers: Set<string> | null = null;
  private byMethod: Map<string, string[]> | null = null;

  constructor(
    private readonly functions: ReadonlyMap<string, IrFunction>,
    /** The module's node index, read instead of walking the bodies it holds. */
    private readonly nodes?: IrNodeIndex,
  ) {}

  ignores(fn: IrFunction): boolean {
    if (fn.async || fn.generator) return false;
    return !this.compute().has(fn.name);
  }

  /** A signature adapter body that observes the ambient receiver only by
   * forwarding it, unchanged, to the original it captures (a callValue on
   * that capture whose receiver is the plain `this` read). Such an adapter
   * ignores the receiver exactly when its original does. */
  forwardsOnly(fn: IrFunction): boolean {
    if (fn.async || fn.generator) return false;
    const original = fn.captures?.[0]?.localId;
    if (original === undefined) return false;
    const readers = this.compute();
    const edge = (name: string): boolean => this.functions.has(name) && !readers.has(name);
    const stmt = (node: IrStmt): boolean =>
      RECEIVER_FREE_STMTS.has(node.kind) && everyStmtChild(node, expr, stmt);
    const expr = (node: IrExpr): boolean => {
      if (node.kind === "callValue" && node.receiver !== undefined) {
        const receiver = node.receiver;
        return (
          receiver.kind === "libCall" &&
          receiver.fn === "dyn.this" &&
          receiver.args.length === 0 &&
          node.callee.kind === "varRef" &&
          node.callee.localId === original &&
          node.args.every(expr)
        );
      }
      return this.admits(node, edge) && everyExprChild(node, expr, stmt);
    };
    return fn.body.every(stmt);
  }

  /** Whether one expression node, apart from its children, leaves the
   * ambient receiver alone; `edge` admits a direct callee. */
  private admits(expr: IrExpr, edge: (name: string) => boolean): boolean {
    if (!RECEIVER_FREE_EXPRS.has(expr.kind)) return false;
    switch (expr.kind) {
      case "call":
        return edge(expr.callee);
      case "new":
        return edge(`%${expr.className}.constructor`);
      case "virtualCall": {
        // Any class's override may run: admit only when every
        // same-named method is itself receiver-free.
        const targets = this.methods().get(expr.method) ?? [];
        return targets.length > 0 && targets.every(edge);
      }
      case "libCall":
        return receiverFreeLibCall(expr);
      case "intrinsic":
        return RECEIVER_FREE_INTRINSICS.has(expr.name);
      case "toString":
        return !opaqueOperand(expr.operand);
      default: {
        const operands = dataIntrinsicOperands(expr);
        return operands === null || !operands.some(opaqueOperand);
      }
    }
  }

  private methods(): Map<string, string[]> {
    if (this.byMethod) return this.byMethod;
    const byMethod = new Map<string, string[]>();
    for (const name of this.functions.keys()) {
      const dot = name.lastIndexOf(".");
      if (!name.startsWith("%") || dot < 0) continue;
      const method = name.slice(dot + 1);
      const list = byMethod.get(method) ?? [];
      list.push(name);
      byMethod.set(method, list);
    }
    this.byMethod = byMethod;
    return byMethod;
  }

  private compute(): Set<string> {
    if (this.readers) return this.readers;
    const readers = new Set<string>();
    const callers = new Map<string, string[]>();
    const scan = this.nodes?.scanExcept(TRIVIALLY_RECEIVER_FREE);
    for (const fn of this.functions.values()) {
      const callees = new Set<string>();
      let reads = fn.async === true || fn.generator !== undefined;
      const edge = (name: string): boolean => {
        if (!this.functions.has(name)) return false;
        callees.add(name);
        return true;
      };
      if (!reads)
        eachNodeOfKinds(fn, scan, (node, statement) => {
          const free = statement
            ? RECEIVER_FREE_STMTS.has((node as IrStmt).kind)
            : this.admits(node as IrExpr, edge);
          if (!free) reads = true;
          return free;
        });
      if (reads) readers.add(fn.name);
      for (const callee of callees) {
        const list = callers.get(callee) ?? [];
        list.push(fn.name);
        callers.set(callee, list);
      }
    }
    const work = [...readers];
    while (work.length > 0) {
      for (const caller of callers.get(work.pop()!) ?? []) {
        if (readers.has(caller)) continue;
        readers.add(caller);
        work.push(caller);
      }
    }
    this.readers = readers;
    return readers;
  }
}

/** A known callback that cannot observe ambient this needs no receiver
 * stack bracket. Standalone form of AmbientReceiverReaders over the given
 * functions (by default only the callback itself, so any call stays on the
 * ABI path). */
export function callbackIgnoresReceiver(
  fn: IrFunction,
  functions: ReadonlyMap<string, IrFunction> = new Map([[fn.name, fn]]),
): boolean {
  return new AmbientReceiverReaders(functions).ignores(fn);
}
