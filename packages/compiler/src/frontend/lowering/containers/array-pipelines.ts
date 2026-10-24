import { keyedHelperName } from "../stable-names.js";
import { writtenLocals } from "../../../ir/callback-specialization.js";
import { AmbientReceiverReaders } from "../../../ir/receiver-readers.js";
import { boolLit, countedFor, numLit, varRef } from "../../../ir/build.js";
import {
  BOOL,
  F64,
  VOID,
  type IrExpr,
  type IrFunction,
  type IrGlobal,
  type IrLocal,
  type IrParam,
  type IrStmt,
  type IrType,
  type SrcLoc,
  typeEquals,
  typeKey,
} from "../../../ir/ir.js";
import {
  everyExpr,
  everyExprChild,
  everyStmt,
  everyStmtChild,
  everyStmtList,
  transformExpr,
  transformStmtList,
} from "../../../ir/traverse.js";
import {
  arrayIndexPresent,
  arrayValueRead,
  arrayValueStore,
  arrayValueType,
} from "../array-values.js";
import type { Lowerer } from "../lowerer.js";

/** What one interned array-HOF helper computes. Recorded when the helper is
 * built; the helper's call arguments are `(receiver, callback, [init],
 * [fast])`, where `fast` is the split-visit closure over the plain element
 * and `init` is reduce's initial value. */
export interface ArrayHofInfo {
  method:
    | "map"
    | "filter"
    | "forEach"
    | "flatMap"
    | "flatMapArray"
    | "reduce"
    | "some"
    | "every"
    | "findIndex";
  elem: IrType;
  fnRet: IrType;
  arity: number;
  /** map/flatMap/filter: the produced array's element; reduce: the accumulator. */
  outElem: IrType;
  /** The callback takes the element type itself (no hole/undefined arm). */
  present: boolean;
  split: boolean;
  hasInit?: boolean;
}

type FuncType = IrType & { kind: "func" };

const PRODUCERS = new Set<ArrayHofInfo["method"]>(["map", "filter", "flatMap", "flatMapArray"]);
const TERMINALS = new Set<ArrayHofInfo["method"]>([
  "reduce",
  "some",
  "every",
  "findIndex",
  "forEach",
]);

/* ── callback effect summaries ───────────────────────────────────────── */

/** What calling a function can do, beyond allocating. `reads`/`writes`
 * name the shared bindings (captured locals and module globals, by id) it
 * reads or assigns; locals of its own frame are not listed. Anything not
 * modeled here (heap writes, host calls, dynamic operations, unknown
 * callees, recursion) makes the summary null: such a function is never
 * reordered. */
interface Effects {
  throws: boolean;
  loops: boolean;
  reads: Set<string>;
  writes: Set<string>;
}

function emptyEffects(): Effects {
  return { throws: false, loops: false, reads: new Set(), writes: new Set() };
}

function mergeEffects(into: Effects, from: Effects): void {
  into.throws ||= from.throws;
  into.loops ||= from.loops;
  for (const id of from.reads) into.reads.add(id);
  for (const id of from.writes) into.writes.add(id);
}

const PURE_MATH = new Set<string>([
  "math.abs",
  "math.acos",
  "math.acosh",
  "math.asin",
  "math.asinh",
  "math.atan",
  "math.atan2",
  "math.atanh",
  "math.cbrt",
  "math.ceil",
  "math.clz32",
  "math.cos",
  "math.cosh",
  "math.exp",
  "math.expm1",
  "math.floor",
  "math.f16round",
  "math.fround",
  "math.imul",
  "math.log",
  "math.log10",
  "math.log1p",
  "math.log2",
  "math.max",
  "math.min",
  "math.pow",
  "math.round",
  "math.sign",
  "math.sin",
  "math.sinh",
  "math.sqrt",
  "math.tan",
  "math.tanh",
  "math.trunc",
]);

/** String methods that cannot throw or call user code on string/number
 * arguments. */
const PURE_STRING = new Set<string>([
  "length",
  "charCodeAt",
  "charAt",
  "indexOf",
  "includes",
  "startsWith",
  "endsWith",
  "slice",
  "substring",
  "trim",
  "trimStart",
  "trimEnd",
  "toLowerCase",
  "toUpperCase",
  "isWellFormed",
  "toWellFormed",
  "cpAt",
]);

function primitive(t: IrType): boolean {
  return t.kind === "f64" || t.kind === "string" || t.kind === "bool";
}

/** Analysis scope: whose locals a node's ids name. `all` records every
 * read, including the scope's own locals (call-site expressions). */
interface Scope {
  fn: IrFunction;
  locals: Map<string, IrLocal>;
  captures: Set<string>;
  all: boolean;
}

class CallbackEffects {
  private readonly fns: Map<string, IrFunction>;
  /** The unique function that creates each closure, or null when several do. */
  private readonly creators = new Map<string, IrFunction | null>();
  private readonly memo = new Map<string, Effects | null>();
  private readonly active = new Set<string>();
  private readonly globals: Map<string, IrGlobal>;

  constructor(functions: readonly IrFunction[], globals: readonly IrGlobal[]) {
    this.fns = new Map(functions.map((fn) => [fn.name, fn]));
    this.globals = new Map(globals.map((g) => [g.id, g]));
    for (const fn of functions) {
      everyStmtList(fn.body, {
        expr: (e) => {
          if (e.kind === "closure") {
            const prior = this.creators.get(e.fnName);
            this.creators.set(e.fnName, prior === undefined || prior === fn ? fn : null);
          }
          return true;
        },
        stmt: () => true,
      });
    }
  }

  fn(name: string): IrFunction | undefined {
    return this.fns.get(name);
  }

  scope(fn: IrFunction, all: boolean): Scope {
    return {
      fn,
      locals: new Map(fn.locals.map((l) => [l.id, l])),
      captures: new Set((fn.captures ?? []).map((c) => c.localId)),
      all,
    };
  }

  /** Effects of calling `fn`, or null when they are not modeled. */
  ofFunction(fn: IrFunction): Effects | null {
    const cached = this.memo.get(fn.name);
    if (cached !== undefined) return cached;
    if (this.active.has(fn.name)) return null; // recursion
    if (fn.async || fn.generator || fn.classCaptures?.length) {
      this.memo.set(fn.name, null);
      return null;
    }
    this.active.add(fn.name);
    const effects = emptyEffects();
    const scope = this.scope(fn, false);
    const ok = fn.body.every((s) => this.stmt(s, scope, effects));
    this.active.delete(fn.name);
    const result = ok ? effects : null;
    this.memo.set(fn.name, result);
    return result;
  }

  /** Effects of evaluating `e` in `scope`; false when not modeled. */
  expr(e: IrExpr, scope: Scope, out: Effects): boolean {
    const child = (c: IrExpr): boolean => this.expr(c, scope, out);
    const stmt = (s: IrStmt): boolean => this.stmt(s, scope, out);
    switch (e.kind) {
      case "numLit":
      case "strLit":
      case "boolLit":
      case "unitLit":
        return true;
      case "varRef":
        return this.read(e.localId, scope, out);
      case "assignExpr":
        return this.write(e.localId, scope, out) && child(e.value);
      case "incDec":
        return this.read(e.localId, scope, out) && this.write(e.localId, scope, out);
      case "bin":
        return (
          e.left.type.kind !== "bigint" &&
          e.right.type.kind !== "bigint" &&
          child(e.left) &&
          child(e.right)
        );
      case "logical":
      case "ternary":
      case "nullish":
      case "strConcat":
      case "strEq":
      case "strCmp":
      case "toBool":
      case "recordGet":
      case "recordLit":
      case "recordClone":
      case "fieldGet":
      case "unionWrap":
      case "unionNarrow":
      case "unionIsTag":
      case "unionDisc":
      case "upcast":
      case "seqExpr":
        return everyExprChild(e, child, stmt);
      case "unary":
        return primitive(e.operand.type) && child(e.operand);
      case "toString":
        return (primitive(e.operand.type) || e.operand.type.kind === "union") && child(e.operand);
      case "arrayLit":
        return !e.spreads?.length && everyExprChild(e, child, stmt);
      case "arrIntrinsic":
        return e.method === "length" && e.receiver.type.kind === "array" && child(e.receiver);
      case "strIntrinsic":
        return (
          PURE_STRING.has(e.method) &&
          e.args.every((a) => a.type.kind === "f64" || a.type.kind === "string") &&
          everyExprChild(e, child, stmt)
        );
      case "libCall":
        if (e.fn === "error.nodeThrow") {
          out.throws = true;
          return everyExprChild(e, child, stmt);
        }
        if (e.fn === "error.new") return everyExprChild(e, child, stmt);
        return PURE_MATH.has(e.fn) && everyExprChild(e, child, stmt);
      case "closure":
        return !e.adapts;
      case "call": {
        const callee = this.fns.get(e.callee);
        if (!callee || callee.captures?.length) return false;
        const effects = this.ofFunction(callee);
        if (!effects) return false;
        mergeEffects(out, effects);
        return e.args.every(child);
      }
      case "callValue": {
        if (e.receiver) return false;
        const callee = this.resolve(e.callee, scope.fn, 0);
        if (!callee) return false;
        const effects = this.ofFunction(callee);
        if (!effects) return false;
        mergeEffects(out, effects);
        return child(e.callee) && e.args.every(child);
      }
      default:
        return false;
    }
  }

  stmt(s: IrStmt, scope: Scope, out: Effects): boolean {
    const child = (c: IrExpr): boolean => this.expr(c, scope, out);
    const stmt = (c: IrStmt): boolean => this.stmt(c, scope, out);
    switch (s.kind) {
      case "varDecl":
        return s.init === null || child(s.init);
      case "assign":
        return this.write(s.localId, scope, out) && child(s.value);
      case "throw":
        out.throws = true;
        return child(s.value);
      case "while":
      case "doWhile":
      case "for":
        out.loops = true;
        return everyStmtChild(s, child, stmt);
      case "exprStmt":
      case "return":
      case "if":
      case "block":
      case "break":
      case "continue":
        return everyStmtChild(s, child, stmt);
      default:
        return false;
    }
  }

  private read(id: string, scope: Scope, out: Effects): boolean {
    const local = scope.locals.get(id);
    if (local) {
      if (local.tdz) out.throws = true;
      if (scope.all || scope.captures.has(id)) out.reads.add(id);
      return true;
    }
    const global = this.globals.get(id);
    if (!global) return false;
    if (global.tdz || global.initFlag) out.throws = true;
    out.reads.add(id);
    return true;
  }

  private write(id: string, scope: Scope, out: Effects): boolean {
    const local = scope.locals.get(id);
    if (local) {
      if (local.tdz) out.throws = true;
      if (scope.all || scope.captures.has(id)) out.writes.add(id);
      return true;
    }
    const global = this.globals.get(id);
    if (!global) return false;
    if (global.tdz || global.initFlag) out.throws = true;
    out.writes.add(id);
    return true;
  }

  /** The one function a function-valued expression evaluated in `fn` can
   * hold: a closure literal, or a never-reassigned binding initialized by
   * one (directly, or through a call whose every return is the same
   * closure literal). Null when unknown. */
  resolve(e: IrExpr, fn: IrFunction, depth: number): IrFunction | null {
    if (depth > 4) return null;
    if (e.kind === "closure") {
      const target = this.fns.get(e.fnName);
      return target && !e.adapts ? target : null;
    }
    if (e.kind !== "varRef") return null;
    const id = e.localId;
    if (!fn.locals.some((l) => l.id === id)) return null;
    if (fn.params.some((p) => p.localId === id)) return null;
    if ((fn.captures ?? []).some((c) => c.localId === id)) {
      const creator = this.creators.get(fn.name);
      return creator ? this.resolveBinding(id, creator, depth + 1) : null;
    }
    return this.resolveBinding(id, fn, depth + 1);
  }

  private resolveBinding(id: string, fn: IrFunction, depth: number): IrFunction | null {
    const local = fn.locals.find((l) => l.id === id);
    if (!local || local.mutable || local.tdz) return null;
    if (fn.params.some((p) => p.localId === id)) return null;
    let init: IrExpr | null = null;
    let definitions = 0;
    everyStmtList(fn.body, {
      expr: (node) => {
        if ((node.kind === "assignExpr" || node.kind === "incDec") && node.localId === id)
          definitions += 2;
        return true;
      },
      stmt: (node) => {
        if (node.kind === "varDecl" && node.localId === id) {
          definitions++;
          init = node.init;
        } else if ((node.kind === "assign" || node.kind === "forOf") && node.localId === id) {
          definitions += 2;
        }
        return true;
      },
    });
    const value = init as IrExpr | null;
    if (definitions !== 1 || value === null) return null;
    return this.resolveValue(value, fn, depth);
  }

  private resolveValue(e: IrExpr, fn: IrFunction, depth: number): IrFunction | null {
    if (e.kind === "closure" || e.kind === "varRef") return this.resolve(e, fn, depth);
    if (e.kind !== "call") return null;
    const factory = this.fns.get(e.callee);
    if (!factory || factory.captures?.length || factory.async || factory.generator) return null;
    let target: string | null = null;
    let returns = 0;
    const ok = everyStmtList(factory.body, {
      expr: () => true,
      stmt: (node) => {
        if (node.kind !== "return") return true;
        returns++;
        const value = node.value;
        if (value?.kind !== "closure" || value.adapts) return false;
        if (target !== null && target !== value.fnName) return false;
        target = value.fnName;
        return true;
      },
    });
    const name = target as string | null;
    if (!ok || returns === 0 || name === null) return null;
    return this.fns.get(name) ?? null;
  }
}

/* ── chain recognition ───────────────────────────────────────────────── */

interface Stage {
  info: ArrayHofInfo;
  slow: IrExpr & { type: FuncType };
  fast: (IrExpr & { type: FuncType }) | null;
  loc: SrcLoc;
}

type Terminal =
  | { kind: "collect" }
  | { kind: "length" }
  | { kind: "call"; stage: Stage; init: IrExpr | null };

interface Chain {
  source: IrExpr;
  sourceType: IrType & { kind: "array" };
  slice: { start: IrExpr | null; end: IrExpr | null } | null;
  stages: Stage[];
  terminal: Terminal;
  type: IrType;
  loc: SrcLoc;
}

function isFunc(e: IrExpr | undefined): e is IrExpr & { type: FuncType } {
  return e !== undefined && e.type.kind === "func";
}

function stageOf(lowerer: Lowerer, e: IrExpr): { stage: Stage; receiver: IrExpr } | null {
  if (e.kind !== "call") return null;
  const info = lowerer.arrHofInfo.get(e.callee);
  if (!info) return null;
  const expected = 2 + (info.method === "reduce" && info.hasInit ? 1 : 0) + (info.split ? 1 : 0);
  if (e.args.length !== expected) return null;
  const receiver = e.args[0]!;
  const slow = e.args[1];
  const fast = info.split ? e.args[e.args.length - 1] : undefined;
  if (!isFunc(slow) || (info.split && !isFunc(fast))) return null;
  if (receiver.type.kind !== "array" || !typeEquals(receiver.type.elem, info.elem)) return null;
  return {
    stage: { info, slow, fast: fast && isFunc(fast) ? fast : null, loc: e.loc },
    receiver,
  };
}

function matchChain(lowerer: Lowerer, e: IrExpr): Chain | null {
  let terminal: Terminal;
  let receiver: IrExpr;
  const stages: Stage[] = [];
  if (e.kind === "arrIntrinsic" && e.method === "length" && e.args.length === 0) {
    if (e.receiver.type.kind !== "array") return null;
    terminal = { kind: "length" };
    receiver = e.receiver;
  } else {
    const top = stageOf(lowerer, e);
    if (!top) return null;
    receiver = top.receiver;
    if (TERMINALS.has(top.stage.info.method)) {
      const init =
        top.stage.info.method === "reduce" && top.stage.info.hasInit && e.kind === "call"
          ? e.args[2]!
          : null;
      terminal = { kind: "call", stage: top.stage, init };
    } else if (PRODUCERS.has(top.stage.info.method)) {
      terminal = { kind: "collect" };
      stages.push(top.stage);
    } else return null;
  }
  for (;;) {
    const inner = stageOf(lowerer, receiver);
    if (!inner || !PRODUCERS.has(inner.stage.info.method)) break;
    stages.unshift(inner.stage);
    receiver = inner.receiver;
  }
  let slice: Chain["slice"] = null;
  if (
    receiver.kind === "arrIntrinsic" &&
    receiver.method === "slice" &&
    receiver.args.length <= 2 &&
    receiver.receiver.type.kind === "array" &&
    receiver.type.kind === "array" &&
    typeEquals(receiver.type, receiver.receiver.type) &&
    receiver.args.every((a) => a.type.kind === "f64")
  ) {
    slice = { start: receiver.args[0] ?? null, end: receiver.args[1] ?? null };
    receiver = receiver.receiver;
  }
  if (receiver.type.kind !== "array") return null;
  const removed = stages.length + (slice ? 1 : 0) - (terminal.kind === "collect" ? 1 : 0);
  if (removed < 1) return null;
  return {
    source: receiver,
    sourceType: receiver.type,
    slice,
    stages,
    terminal,
    type: e.type,
    loc: e.loc,
  };
}

/** The outermost array-HOF call of `e` on its own, over its receiver. */
function loneChain(lowerer: Lowerer, e: IrExpr): Chain | null {
  const top = stageOf(lowerer, e);
  if (!top) return null;
  const { stage, receiver } = top;
  if (receiver.type.kind !== "array") return null;
  const stages: Stage[] = [];
  let terminal: Terminal;
  if (TERMINALS.has(stage.info.method)) {
    const init =
      stage.info.method === "reduce" && stage.info.hasInit && e.kind === "call" ? e.args[2]! : null;
    terminal = { kind: "call", stage, init };
  } else if (PRODUCERS.has(stage.info.method)) {
    terminal = { kind: "collect" };
    stages.push(stage);
  } else return null;
  return {
    source: receiver,
    sourceType: receiver.type,
    slice: null,
    stages,
    terminal,
    type: e.type,
    loc: e.loc,
  };
}

/** The callbacks of `chain` in order, or null when its stages cannot run
 * in one loop: element types that do not line up, an array argument past
 * the first stage, reduce without a seed, or findIndex over holes. */
function chainCallbacks(chain: Chain): Stage[] | null {
  const { stages, terminal } = chain;
  const terminalStage = terminal.kind === "call" ? terminal.stage : null;
  const callbacks = terminalStage ? [...stages, terminalStage] : stages;
  // Element types must line up stage to stage.
  let elem = chain.sourceType.elem;
  for (const stage of callbacks) {
    if (!typeEquals(stage.info.elem, elem)) return null;
    if (stage.info.method === "filter" && !typeEquals(stage.info.outElem, stage.info.elem))
      return null;
    if (
      (stage.info.method === "map" || stage.info.method === "flatMap") &&
      !typeEquals(stage.info.outElem, stage.info.fnRet)
    )
      return null;
    elem = stage.info.outElem;
  }
  // Index arguments are reproduced; an array argument only names the source.
  for (let k = 0; k < callbacks.length; k++) {
    const stage = callbacks[k]!;
    const lead = stage.info.method === "reduce" ? 1 : 0;
    if (stage.info.arity > lead + 3) return null;
    if (stage.info.arity === lead + 3 && (k !== 0 || chain.slice)) return null;
  }
  if (terminalStage?.info.method === "reduce" && !terminalStage.info.hasInit) return null;
  if (terminalStage?.info.method === "findIndex" && holeCarrying(chain)) return null;
  return callbacks;
}

/* ── the fusion pass ─────────────────────────────────────────────────── */

/** The values a fused loop hands from one stage to the next: a local of a
 * known type, or (before the first read) the source slot itself. */
type Flow = { kind: "value"; id: string; type: IrType } | { kind: "slot" };

interface Plan {
  chain: Chain;
  callbacks: Stage[];
  /** Bindings the callbacks assign. */
  writes: Set<string>;
  /** Some callback may throw or loop; at most one does. */
  risky: boolean;
  /** How the loop inlines callbacks, when not by their effect summaries. */
  inline?: InlineTarget;
  /** Stack frame name of the loop: the inlined callback's, for a lone call. */
  frame?: string;
}

/** Fuse chains of array-HOF helper calls into one loop.
 *
 * `xs.filter(f).map(g).reduce(h, z)` lowers to nested helper calls, each
 * materializing a full intermediate array. When every callback's effects
 * are modeled (see CallbackEffects) and reordering them cannot be
 * observed, the chain becomes one synthetic helper that runs each element
 * through all stages before reading the next, and never builds the
 * intermediate arrays. The rules, from strictest to weakest need:
 *
 * - No callback writes the heap, calls host code or an unknown function,
 *   or recurses. Allocation and reads are fine: with no heap writes, every
 *   read sees the same value in either order.
 * - Callbacks may assign shared bindings (captured locals, globals), but
 *   no other callback in the chain reads or assigns those bindings.
 * - At most one callback may throw (or contain a loop, which might not
 *   terminate); if one does, no other callback assigns anything. A throw
 *   then leaves the same observable state in either order.
 * - some/every/findIndex stop early, so the stages before them must not
 *   throw, loop or assign at all: the unfused chain would have run them on
 *   every element.
 * - Index parameters receive the position in the array the unfused
 *   stage would have visited: the source index while only maps (which
 *   keep holes in place) precede it, else a count of the values that
 *   reached the stage. Only the first stage over an unsliced source may
 *   take the array parameter; any other would name an intermediate array.
 * - Holes: map and slice preserve them, filter/flatMap drop them; every
 *   consumer here skips them except findIndex, which is not fused when a
 *   hole can reach it. Lengths are read once, before any callback, and no
 *   callback can write an array.
 *
 * A `const` holding a chain that is read once, as the receiver of the next
 * statement's consumer, is folded into that consumer when the rest of that
 * statement is free of effects. */
export function fuseArrayPipelines(lowerer: Lowerer, functions: IrFunction[]): void {
  if (lowerer.arrHofInfo.size === 0) return;
  const pass = new PipelineFusion(lowerer, functions);
  for (const fn of functions.slice()) pass.run(fn);
  functions.push(...pass.added);
}

class PipelineFusion {
  readonly added: IrFunction[] = [];
  private readonly effects: CallbackEffects;
  private readonly helpers = new Map<string, string>();
  /** Bindings each function, or a closure it creates, writes after their
   * declaration. */
  private readonly written: Map<string, Set<string>>;
  /** Bindings of the function being fused that inlined callbacks captured. */
  private inlinedCaptures = new Set<string>();
  /** The helper calls each callback with an undefined receiver; a copied
   * body runs under the receiver around the array call instead. */
  private readonly receivers: AmbientReceiverReaders;

  constructor(
    private readonly lowerer: Lowerer,
    functions: readonly IrFunction[],
  ) {
    this.effects = new CallbackEffects(functions, lowerer.globalsList);
    this.written = writtenLocals({ functions });
    this.receivers = new AmbientReceiverReaders(new Map(functions.map((fn) => [fn.name, fn])));
  }

  run(fn: IrFunction): void {
    const infos = this.lowerer.arrHofInfo;
    const candidate = !everyStmtList(fn.body, {
      expr: (e) => !(e.kind === "call" && infos.has(e.callee)),
      stmt: () => true,
    });
    if (!candidate) return;
    const removed = new Set<string>();
    this.inlinedCaptures = new Set();
    let body = this.lists(fn.body, fn, removed);
    body = transformStmtList(body, {
      stmt: (s) => s,
      expr: (e) => this.fuse(e, fn) ?? e,
    });
    fn.body = body;
    if (removed.size > 0) fn.locals = fn.locals.filter((l) => !removed.has(l.id));
    if (this.inlinedCaptures.size > 0) unboxUncaptured(fn, this.inlinedCaptures);
  }

  /* ── statement lists: fold single-use chain bindings ── */

  private lists(list: IrStmt[], fn: IrFunction, removed: Set<string>): IrStmt[] {
    const nested = list.map((s) => this.nested(s, fn, removed));
    const out: IrStmt[] = [];
    for (let i = 0; i < nested.length; i++) {
      let current = nested[i]!;
      while (i + 1 < nested.length) {
        const merged = this.fold(current, nested[i + 1]!, fn);
        if (!merged) break;
        removed.add((current as IrStmt & { kind: "varDecl" }).localId);
        current = merged;
        i++;
      }
      out.push(current);
    }
    return out;
  }

  private nested(s: IrStmt, fn: IrFunction, removed: Set<string>): IrStmt {
    const l = (body: IrStmt[]): IrStmt[] => this.lists(body, fn, removed);
    switch (s.kind) {
      case "if":
        return { ...s, then: l(s.then), else_: s.else_ === null ? null : l(s.else_) };
      case "while":
      case "doWhile":
      case "for":
      case "forOf":
      case "block":
        return { ...s, body: l(s.body) };
      case "switch":
        return { ...s, cases: s.cases.map((c) => ({ ...c, body: l(c.body) })) };
      case "tryCatch":
        return {
          ...s,
          tryBody: l(s.tryBody),
          catchBody: s.catchBody === null ? null : l(s.catchBody),
          finallyBody: s.finallyBody === null ? null : l(s.finallyBody),
        };
      default:
        return s;
    }
  }

  /** `const L = <chain>; <stmt using L once as a consumer receiver>`. */
  private fold(decl: IrStmt, next: IrStmt, fn: IrFunction): IrStmt | null {
    if (decl.kind !== "varDecl" || decl.init === null) return null;
    const init = decl.init;
    const id = decl.localId;
    const local = fn.locals.find((l) => l.id === id);
    if (!local || local.boxed || local.tdz || !typeEquals(local.type, init.type)) return null;
    if (!matchChain(this.lowerer, init) && !stageOf(this.lowerer, init)) {
      if (!(init.kind === "arrIntrinsic" && init.method === "slice")) return null;
    }
    if (useCount(fn, id) !== 1) return null;
    // Only expression statements whose value is computed before any store.
    let root: IrExpr;
    switch (next.kind) {
      case "varDecl":
        if (next.init === null) return null;
        root = next.init;
        break;
      case "assign":
        root = next.value;
        break;
      case "exprStmt":
        root = next.expr;
        break;
      case "return":
        if (next.value === null) return null;
        root = next.value;
        break;
      default:
        return null;
    }
    const site = locateUse(this.lowerer, root, id);
    if (!site) return null;
    const substituted = substituteReceiver(site.node, init);
    // The chain now runs after the rest of `next`'s operands are evaluated;
    // those must not observe or change anything the chain touches.
    const plan = this.plan(substituted, fn);
    const chainArgs = matchChain(this.lowerer, substituted);
    if (!plan || !chainArgs) return null;
    if (site.conditional && (plan.risky || plan.writes.size > 0)) return null;
    const scope = this.effects.scope(fn, true);
    const rest = emptyEffects();
    const placeholder: IrExpr = { kind: "numLit", value: 0, type: F64, loc: site.node.loc };
    if (!this.effects.expr(replaceNode(root, site.node, placeholder), scope, rest)) return null;
    if (rest.throws || rest.writes.size > 0 || intersects(rest.reads, plan.writes)) return null;
    const moved = emptyEffects();
    const movedArgs: IrExpr[] = [chainArgs.source];
    if (chainArgs.slice?.start) movedArgs.push(chainArgs.slice.start);
    if (chainArgs.slice?.end) movedArgs.push(chainArgs.slice.end);
    if (!movedArgs.every((a) => this.effects.expr(a, scope, moved))) return null;
    if (moved.throws || moved.writes.size > 0 || moved.loops) return null;
    const value = replaceNode(root, site.node, substituted);
    switch (next.kind) {
      case "varDecl":
        return { ...next, init: value };
      case "assign":
        return { ...next, value };
      case "exprStmt":
        return { ...next, expr: value };
      case "return":
        return { ...next, value };
    }
    return null;
  }

  /* ── expressions ── */

  private fuse(e: IrExpr, fn: IrFunction): IrExpr | null {
    const plan = this.plan(e, fn) ?? this.lonePlan(e, fn);
    return plan ? this.emit(plan) : null;
  }

  /** One array-HOF call on its own (or the last call of a chain that does
   * not fuse), when every callback is a closure literal whose body can be
   * copied into the loop. A single stage reorders nothing, so the
   * callbacks' effects need no model; their captured bindings must keep
   * one value while the loop runs (stableTarget), since the loop reads
   * them once, when it starts. The loop keeps the helper's order: the
   * length read once, each element read when it is visited, holes
   * skipped (and kept by map). */
  private lonePlan(e: IrExpr, fn: IrFunction): Plan | null {
    const chain = loneChain(this.lowerer, e);
    if (!chain) return null;
    const callbacks = chainCallbacks(chain);
    if (!callbacks) return null;
    const inline = this.stableTarget(fn);
    let frame: string | undefined;
    for (const stage of callbacks) {
      for (const arg of [stage.slow, stage.fast]) {
        if (!arg) continue;
        const target = inline(arg);
        if (!target) return null;
        frame ??= target.sourceName;
      }
    }
    return {
      chain,
      callbacks,
      writes: new Set(),
      risky: true,
      inline,
      ...(frame === undefined ? {} : { frame }),
    };
  }

  /** Decide whether `e` is a fusable chain; null when it is not. */
  private plan(e: IrExpr, fn: IrFunction): Plan | null {
    const chain = matchChain(this.lowerer, e);
    if (!chain) return null;
    const callbacks = chainCallbacks(chain);
    if (!callbacks) return null;
    const { stages, terminal } = chain;
    const terminalStage = terminal.kind === "call" ? terminal.stage : null;
    // Effects of each callback, in chain order.
    const scope = this.effects.scope(fn, true);
    const summaries: Effects[] = [];
    const argReads = emptyEffects();
    for (const stage of callbacks) {
      for (const arg of [stage.slow, stage.fast]) {
        if (!arg) continue;
        if (!this.effects.expr(arg, scope, argReads)) return null;
      }
      const target = this.effects.resolve(stage.fast ?? stage.slow, fn, 0);
      const summary = target ? this.effects.ofFunction(target) : null;
      if (!summary) return null;
      if (stage.fast) {
        const slow = this.effects.resolve(stage.slow, fn, 0);
        const slowSummary = slow ? this.effects.ofFunction(slow) : null;
        if (!slowSummary) return null;
        mergeEffects(summary, slowSummary);
      }
      summaries.push(summary);
    }
    if (argReads.throws || argReads.writes.size > 0) return null;
    const init = terminal.kind === "call" ? terminal.init : null;
    if (init) {
      if (!this.effects.expr(init, scope, argReads)) return null;
      if (argReads.throws || argReads.writes.size > 0 || argReads.loops) return null;
    }
    const writes = new Set<string>();
    let riskyCount = 0;
    for (const s of summaries) {
      for (const id of s.writes) writes.add(id);
      if (s.throws || s.loops) riskyCount++;
    }
    if (riskyCount > 1) return null;
    for (let j = 0; j < summaries.length; j++) {
      const sj = summaries[j]!;
      if (riskyCount === 1 && !(sj.throws || sj.loops) && sj.writes.size > 0) return null;
      for (let k = 0; k < summaries.length; k++) {
        if (j === k) continue;
        const sk = summaries[k]!;
        if (intersects(sj.writes, sk.reads) || intersects(sj.writes, sk.writes)) return null;
      }
    }
    if (intersects(argReads.reads, writes)) return null;
    const early =
      terminalStage !== null &&
      (terminalStage.info.method === "some" ||
        terminalStage.info.method === "every" ||
        terminalStage.info.method === "findIndex");
    if (early) {
      for (let k = 0; k < stages.length; k++) {
        const s = summaries[k]!;
        if (s.throws || s.loops || s.writes.size > 0) return null;
      }
    }
    return { chain, callbacks, writes, risky: riskyCount > 0 };
  }

  /* ── helper construction ── */

  /** A closure-literal callback whose body can be copied into the loop:
   * small, no nested closures, and its captured bindings only read (they
   * are passed in by value, read when the fused call starts; no callback
   * in the chain assigns a binding another one reads). */
  private readonly inlineTarget: InlineTarget = (arg) => {
    const fn = this.closureTarget(arg);
    if (!fn) return null;
    const captures = new Set((fn.captures ?? []).map((c) => c.localId));
    const effects = this.effects.ofFunction(fn);
    if (!effects || intersects(effects.writes, captures)) return null;
    return inlinableBody(fn, captures) ? fn : null;
  };

  /** inlineTarget for a callback created in `fn` whose captured bindings
   * nothing assigns after their declaration: `fn`'s own locals and
   * parameters, written neither by `fn` nor by any closure that shares
   * them, and not by the callback body. The callback must not observe the
   * ambient receiver (AmbientReceiverReaders). */
  private stableTarget(fn: IrFunction): InlineTarget {
    const locals = new Map(fn.locals.map((l) => [l.id, l]));
    const inherited = new Set((fn.captures ?? []).map((c) => c.localId));
    const written = this.written.get(fn.name);
    return (arg) => {
      const target = this.closureTarget(arg);
      if (!target || !written || arg.kind !== "closure") return null;
      if (!this.receivers.ignores(target)) return null;
      for (const id of arg.captures) {
        const local = locals.get(id);
        if (!local || local.tdz || inherited.has(id) || written.has(id)) return null;
      }
      const captures = new Set((target.captures ?? []).map((c) => c.localId));
      const assigns = !everyStmtList(target.body, {
        stmt: (st) => !((st.kind === "assign" || st.kind === "forOf") && captures.has(st.localId)),
        expr: (ex) =>
          !((ex.kind === "assignExpr" || ex.kind === "incDec") && captures.has(ex.localId)),
      });
      return !assigns && inlinableBody(target, captures) ? target : null;
    };
  }

  /** The function behind a closure-literal callback the loop can inline. */
  private closureTarget(arg: IrExpr): IrFunction | null {
    if (arg.kind !== "closure" || arg.adapts) return null;
    const fn = this.effects.fn(arg.fnName);
    if (!fn || fn.async || fn.generator || fn.classCaptures?.length) return null;
    if ((fn.captures ?? []).length !== arg.captures.length) return null;
    return fn;
  }

  private emit(plan: Plan): IrExpr | null {
    const built = new FusedLoop(this.lowerer, plan.chain, plan.inline ?? this.inlineTarget).build();
    if (!built) return null;
    for (const id of built.inlinedCaptures) this.inlinedCaptures.add(id);
    let name = this.helpers.get(built.key);
    if (!name) {
      name = keyedHelperName(this.lowerer, plan.inline ? "%arr.loop" : "%arr.fused", built.key);
      this.helpers.set(built.key, name);
      const helper: IrFunction = { ...built.fn, name };
      // A lone call's loop stands in the inlined callback's stack frame.
      if (plan.frame !== undefined) helper.sourceName = plan.frame;
      this.added.push(helper);
    }
    return {
      kind: "call",
      callee: name,
      args: built.args,
      type: plan.chain.type,
      loc: plan.chain.loc,
    };
  }
}

/** Whether a statement inside `e` (a sequence expression's) returns. */
function returns(e: IrExpr): boolean {
  return !everyExpr(e, { expr: () => true, stmt: (s) => s.kind !== "return" });
}

/** Drops the box of each binding in `inlined` that no closure or class
 * created in `fn` captures any more: the callbacks that captured it were
 * copied into loops, which receive its value. A dead-zone binding keeps the
 * box that represents its uninitialized state, and bindings `fn` itself
 * captures keep theirs. */
function unboxUncaptured(fn: IrFunction, inlined: ReadonlySet<string>): void {
  const captured = new Set<string>();
  everyStmtList(fn.body, {
    expr: (e) => {
      if (e.kind === "closure" || e.kind === "classRef")
        for (const id of e.captures ?? []) captured.add(id);
      return true;
    },
    stmt: () => true,
  });
  const inherited = new Set(
    [...(fn.captures ?? []), ...(fn.classCaptures ?? [])].map((c) => c.localId),
  );
  fn.locals = fn.locals.map((local): IrLocal => {
    if (local.boxed !== true || local.tdz === true || !inlined.has(local.id)) return local;
    if (captured.has(local.id) || inherited.has(local.id)) return local;
    const { boxed: _boxed, ...plain } = local;
    return plain;
  });
}

/** A callback body the loop can copy: small, no nested closures, recursion
 * or try statements, and no boxed locals besides its captures. */
function inlinableBody(fn: IrFunction, captures: ReadonlySet<string>): boolean {
  if (fn.locals.some((l) => l.tdz || (l.boxed && !captures.has(l.id)))) return false;
  let size = 0;
  return everyStmtList(fn.body, {
    expr: (e) => ++size <= MAX_INLINE_NODES && e.kind !== "closure" && e.kind !== "selfRef",
    stmt: (s) => ++size <= MAX_INLINE_NODES && s.kind !== "tryCatch",
  });
}

function intersects(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  for (const id of a) if (b.has(id)) return true;
  return false;
}

/** Map and slice keep holes in place; filter and flatMap drop them. */
function holeCarrying(chain: Chain): boolean {
  return chain.stages.every((s) => s.info.method === "map");
}

function useCount(fn: IrFunction, id: string): number {
  let uses = 0;
  everyStmtList(fn.body, {
    expr: (e) => {
      switch (e.kind) {
        case "varRef":
        case "assignExpr":
        case "incDec":
          if (e.localId === id) uses++;
          break;
        case "closure":
          if (e.captures.includes(id)) uses += 2;
          break;
      }
      return true;
    },
    stmt: (s) => {
      if ((s.kind === "assign" || s.kind === "forOf") && s.localId === id) uses += 2;
      if (s.kind === "varDecl" && s.localId === id && s.init === null) uses += 2;
      return true;
    },
  });
  return uses;
}

/** The consumer node in `root` whose receiver is `varRef id`, and whether
 * it is evaluated only conditionally. */
function locateUse(
  lowerer: Lowerer,
  root: IrExpr,
  id: string,
): { node: IrExpr; conditional: boolean } | null {
  let found: { node: IrExpr; conditional: boolean } | null = null;
  const isUse = (e: IrExpr): boolean => {
    const receiver =
      e.kind === "arrIntrinsic" && e.method === "length"
        ? e.receiver
        : e.kind === "call" && lowerer.arrHofInfo.has(e.callee)
          ? e.args[0]
          : undefined;
    return receiver?.kind === "varRef" && receiver.localId === id;
  };
  const walk = (e: IrExpr, conditional: boolean): boolean => {
    if (isUse(e)) {
      found = { node: e, conditional };
      return false;
    }
    const branching =
      conditional ||
      e.kind === "ternary" ||
      e.kind === "logical" ||
      e.kind === "nullish" ||
      e.kind === "orDefault" ||
      e.kind === "optChain" ||
      e.kind === "seqExpr" ||
      e.kind === "closure";
    return everyExprChild(
      e,
      (c) => walk(c, branching && !(e.kind === "ternary" && c === e.cond)),
      () => true,
    );
  };
  walk(root, false);
  return found;
}

function substituteReceiver(node: IrExpr, receiver: IrExpr): IrExpr {
  if (node.kind === "arrIntrinsic") return { ...node, receiver };
  if (node.kind === "call") return { ...node, args: [receiver, ...node.args.slice(1)] };
  return node;
}

function replaceNode(root: IrExpr, target: IrExpr, replacement: IrExpr): IrExpr {
  if (root === target) return replacement;
  return transformExprOnce(root, target, replacement);
}

function transformExprOnce(root: IrExpr, target: IrExpr, replacement: IrExpr): IrExpr {
  const [stmt] = transformStmtList([{ kind: "exprStmt", expr: root, loc: root.loc }], {
    stmt: (s) => s,
    expr: (e) => (e === target ? replacement : e),
  });
  return (stmt as IrStmt & { kind: "exprStmt" }).expr;
}

/* ── the fused loop ──────────────────────────────────────────────────── */

/** A callback the fused loop calls: either through a parameter holding the
 * closure value, or inlined (its body copied into the loop, its captured
 * bindings passed in by value). */
interface Callee {
  arg: IrExpr & { type: FuncType };
  ref: IrExpr | null;
  inline: IrFunction | null;
  captures: Map<string, string> | null;
}

/** The inlinable body behind a closure-literal callback, or null. */
export type InlineTarget = (arg: IrExpr) => IrFunction | null;

const MAX_INLINE_NODES = 400;

class FusedLoop {
  private readonly params: IrParam[] = [];
  private readonly locals: IrLocal[] = [];
  private readonly args: IrExpr[] = [];
  private readonly keyParts: string[] = [];
  private readonly callees: Callee[] = [];
  private readonly loc: SrcLoc;
  private next = 0;
  private failed = false;

  constructor(
    private readonly lowerer: Lowerer,
    private readonly chain: Chain,
    private readonly inlineTarget: InlineTarget,
  ) {
    this.loc = chain.loc;
  }

  private fresh(name: string): string {
    return `${name}.${this.next++}`;
  }

  private local(name: string, type: IrType, mutable = false): string {
    const id = this.fresh(name);
    this.locals.push({ id, name, type, mutable });
    return id;
  }

  private param(name: string, value: IrExpr, key: string): IrExpr {
    const id = this.fresh(name);
    this.params.push({ localId: id, name, type: value.type });
    this.locals.push({ id, name, type: value.type, mutable: false });
    this.args.push(value);
    this.keyParts.push(`${key}:${typeKey(value.type)}`);
    return varRef(id, value.type, this.loc);
  }

  /** How the loop reaches one callback argument; decided at first use. */
  private callee(arg: IrExpr & { type: FuncType }): Callee {
    const known = this.callees.find((c) => c.arg === arg);
    if (known) return known;
    // Called as a plain function: the loop is not the target's receiver.
    const inlineTarget = this.inlineTarget;
    const target = inlineTarget(arg);
    let callee: Callee;
    if (target && arg.kind === "closure") {
      const captures = new Map<string, string>();
      (target.captures ?? []).forEach((capture, index) => {
        const source = arg.captures[index]!;
        const ref = this.param("cap", varRef(source, capture.type, this.loc), `cap@${target.name}`);
        captures.set(capture.localId, (ref as IrExpr & { kind: "varRef" }).localId);
      });
      this.keyParts.push(`inline@${target.name}`);
      callee = { arg, ref: null, inline: target, captures };
    } else {
      const site = arg.kind === "closure" ? `@${arg.fnName}` : "";
      callee = { arg, ref: this.param("f", arg, `cb${site}`), inline: null, captures: null };
    }
    this.callees.push(callee);
    return callee;
  }

  /** Statements and the value of calling `callee` with `args`. */
  private invoke(callee: Callee, args: IrExpr[], ret: IrType): { pre: IrStmt[]; value: IrExpr } {
    const loc = this.loc;
    if (!callee.inline) {
      return {
        pre: [],
        value: { kind: "callValue", callee: callee.ref!, args, type: ret, loc },
      };
    }
    const fn = callee.inline;
    if (fn.params.length !== args.length) {
      this.failed = true;
      return { pre: [], value: { kind: "numLit", value: 0, type: F64, loc } };
    }
    const renamed = new Map<string, string>(callee.captures);
    // A parameter the body never assigns can name its argument's local
    // directly: the loop's value locals are not assigned while the
    // inlined body runs.
    const assigned = new Set<string>();
    everyStmtList(fn.body, {
      expr: (e) => {
        if (e.kind === "assignExpr" || e.kind === "incDec") assigned.add(e.localId);
        return true;
      },
      stmt: (st) => {
        if (st.kind === "assign" || st.kind === "forOf") assigned.add(st.localId);
        return true;
      },
    });
    const aliased = new Set<string>();
    fn.params.forEach((p, index) => {
      const arg = args[index]!;
      if (arg.kind === "varRef" && !assigned.has(p.localId) && typeEquals(arg.type, p.type)) {
        renamed.set(p.localId, arg.localId);
        aliased.add(p.localId);
      }
    });
    for (const l of fn.locals) {
      if (renamed.has(l.id)) continue;
      const id = this.local(l.name, l.type, true);
      renamed.set(l.id, id);
    }
    const rename = (id: string): string => renamed.get(id) ?? id;
    const renameExpr = (e: IrExpr): IrExpr => {
      switch (e.kind) {
        case "varRef":
        case "incDec":
        case "assignExpr":
          return { ...e, localId: rename(e.localId) };
        default:
          return e;
      }
    };
    const bind: IrStmt[] = fn.params.flatMap((p, index): IrStmt[] =>
      aliased.has(p.localId)
        ? []
        : [{ kind: "varDecl", localId: rename(p.localId), init: args[index]!, loc }],
    );
    const labels = new Map<string, string>();
    const label = (name: string): string => {
      let id = labels.get(name);
      if (!id) {
        id = this.fresh("%fused.label");
        labels.set(name, id);
      }
      return id;
    };
    /** Locals and labels of a copied statement; returns are the caller's. */
    const renameStmt = (st: IrStmt): IrStmt => {
      switch (st.kind) {
        case "varDecl":
        case "assign":
          return { ...st, localId: rename(st.localId) };
        case "break":
        case "continue":
          return st.label ? { ...st, label: label(st.label) } : st;
        case "while":
        case "doWhile":
        case "for":
        case "block":
          return st.labels ? { ...st, labels: st.labels.map(label) } : st;
        default:
          return st;
      }
    };
    // A body whose only return is its last statement (`(x) => x * k`,
    // `{ const y = x * 2; return y > 4; }`) needs no exit block: its other
    // statements run after the bindings, and the call's value is the
    // returned expression.
    const last = fn.body[fn.body.length - 1];
    const prefix = fn.body.slice(0, -1);
    if (
      last !== undefined &&
      last.kind === "return" &&
      last.value !== null &&
      typeEquals(last.value.type, fn.returnType) &&
      !returns(last.value) &&
      prefix.every((st) => everyStmt(st, { expr: () => true, stmt: (x) => x.kind !== "return" }))
    ) {
      const copy = { expr: renameExpr, stmt: renameStmt };
      return {
        pre: [...bind, ...transformStmtList(prefix, copy)],
        value: transformExpr(last.value, copy),
      };
    }
    const exit = this.fresh("%fused.exit");
    const result = fn.returnType.kind === "void" ? null : this.local("ret", fn.returnType, true);
    const body = transformStmtList(fn.body, {
      expr: renameExpr,
      stmt: (s): IrStmt => {
        switch (s.kind) {
          case "return": {
            const exitStmt: IrStmt = { kind: "break", label: exit, loc: s.loc };
            if (s.value === null || result === null) {
              return s.value === null
                ? exitStmt
                : {
                    kind: "block",
                    body: [{ kind: "exprStmt", expr: s.value, loc: s.loc }, exitStmt],
                    loc: s.loc,
                  };
            }
            return {
              kind: "block",
              body: [{ kind: "assign", localId: result, value: s.value, loc: s.loc }, exitStmt],
              loc: s.loc,
            };
          }
          case "break":
          case "continue":
            return s.label && s.label !== exit ? { ...s, label: label(s.label) } : s;
          default:
            return renameStmt(s);
        }
      },
    });
    const pre: IrStmt[] = [];
    if (result !== null) pre.push({ kind: "varDecl", localId: result, init: null, loc });
    pre.push({ kind: "block", labels: [exit], body: [...bind, ...body], loc });
    return {
      pre,
      value:
        result === null
          ? { kind: "numLit", value: 0, type: F64, loc }
          : varRef(result, fn.returnType, loc),
    };
  }

  build(): {
    fn: Omit<IrFunction, "name">;
    args: IrExpr[];
    key: string;
    /** Bindings the callbacks copied into the loop captured at this site. */
    inlinedCaptures: string[];
  } | null {
    const { chain, loc } = this;
    const arrT = chain.sourceType;
    const a = this.param("a", chain.source, "src");
    const n = this.local("n", F64);
    const body: IrStmt[] = [
      {
        kind: "varDecl",
        localId: n,
        init: { kind: "arrIntrinsic", method: "length", receiver: a, args: [], type: F64, loc },
        loc,
      },
    ];
    const nRef = varRef(n, F64, loc);
    // Slice bounds: ToIntegerOrInfinity, then relative to the length.
    let lo: IrExpr = numLit(0, loc);
    let hi: IrExpr = nRef;
    if (chain.slice) {
      const bound = (value: IrExpr | null, name: string, fallback: IrExpr): IrExpr => {
        if (!value) return fallback;
        const raw = this.param(name, value, name);
        const t = this.local(`${name}Int`, F64);
        const at = this.local(`${name}At`, F64);
        const tRef = varRef(t, F64, loc);
        const sum: IrExpr = { kind: "bin", op: "+", left: nRef, right: tRef, type: F64, loc };
        const lt = (left: IrExpr, right: IrExpr): IrExpr => ({
          kind: "bin",
          op: "<",
          left,
          right,
          type: BOOL,
          loc,
        });
        const pick = (cond: IrExpr, then: IrExpr, else_: IrExpr): IrExpr => ({
          kind: "ternary",
          cond,
          then,
          else_,
          type: F64,
          loc,
        });
        body.push(
          {
            kind: "varDecl",
            localId: t,
            init: pick(
              { kind: "bin", op: "!==", left: raw, right: raw, type: BOOL, loc },
              numLit(0, loc),
              { kind: "libCall", fn: "math.trunc", args: [raw], type: F64, loc },
            ),
            loc,
          },
          {
            kind: "varDecl",
            localId: at,
            init: pick(
              lt(tRef, numLit(0, loc)),
              pick(lt(sum, numLit(0, loc)), numLit(0, loc), sum),
              pick(lt(nRef, tRef), nRef, tRef),
            ),
            loc,
          },
        );
        return varRef(at, F64, loc);
      };
      lo = bound(chain.slice.start, "start", numLit(0, loc));
      hi = bound(chain.slice.end, "end", nRef);
      this.keyParts.push(`slice:${chain.slice.start ? 1 : 0}${chain.slice.end ? 1 : 0}`);
    }
    const terminalStage = chain.terminal.kind === "call" ? chain.terminal.stage : null;
    for (const stage of terminalStage ? [...chain.stages, terminalStage] : chain.stages) {
      this.keyParts.push(
        `${stage.info.method}:${typeKey(stage.info.elem)}:${typeKey(stage.info.fnRet)}:${stage.info.arity}:${stage.info.present ? "p" : ""}`,
      );
    }
    const holes = holeCarrying(chain);
    const resultT = chain.type;
    const terminal = chain.terminal;
    const epilogue: IrStmt[] = [];
    // Terminal state. The reduce seed is a parameter evaluated after the
    // callbacks, like the unfused call's argument.
    let acc: string | null = null;
    let count: string | null = null;
    let out: string | null = null;
    const stateDecls: IrStmt[] = [];
    if (terminal.kind === "call" && terminal.stage.info.method === "reduce") {
      acc = this.local("acc", terminal.stage.info.outElem, true);
      epilogue.push({ kind: "return", value: varRef(acc, terminal.stage.info.outElem, loc), loc });
    } else if (
      terminal.kind === "length" ||
      (terminal.kind === "call" && terminal.stage.info.method === "findIndex")
    ) {
      count = this.local("count", F64, true);
      stateDecls.push({ kind: "varDecl", localId: count, init: numLit(0, loc), loc });
      epilogue.push({
        kind: "return",
        value: terminal.kind === "length" ? varRef(count, F64, loc) : numLit(-1, loc),
        loc,
      });
    } else if (terminal.kind === "collect") {
      out = this.local("out", resultT);
      stateDecls.push({
        kind: "varDecl",
        localId: out,
        init: { kind: "arrayLit", elems: [], type: resultT, loc },
        loc,
      });
      if (holes) {
        // The result keeps the source's holes: storage for its length is
        // reserved first and the length is set after the loop, so a result
        // without holes is filled by appends and gets no state bytes.
        const length = (): IrExpr => ({
          kind: "ternary",
          cond: { kind: "bin", op: "<", left: lo, right: hi, type: BOOL, loc },
          then: { kind: "bin", op: "-", left: hi, right: lo, type: F64, loc },
          else_: numLit(0, loc),
          type: F64,
          loc,
        });
        stateDecls.push({
          kind: "arraySetLength",
          arr: varRef(out, resultT, loc),
          length: length(),
          loc,
          reserve: true,
        });
        epilogue.push({
          kind: "arraySetLength",
          arr: varRef(out, resultT, loc),
          length: length(),
          loc,
        });
      }
      epilogue.push({ kind: "return", value: varRef(out, resultT, loc), loc });
    } else if (terminal.kind === "call") {
      const method = terminal.stage.info.method;
      if (method === "some" || method === "every")
        epilogue.push({ kind: "return", value: boolLit(method === "every", loc), loc });
    }
    const i = varRef("i.0", F64, loc);
    this.locals.push({ id: "i.0", name: "i", type: F64, mutable: true });
    const slotRead = (): IrExpr => ({ kind: "arrayGet", arr: a, index: i, type: arrT.elem, loc });
    const outIndex = (): IrExpr =>
      chain.slice ? { kind: "bin", op: "-", left: i, right: lo, type: F64, loc } : i;

    const counters = new Map<number, string>();
    /** The index argument for the value now reaching callback `k`. */
    const indexArg = (k: number, pre: IrStmt[]): IrExpr => {
      if (chain.stages.slice(0, k).every((s) => s.info.method === "map")) return outIndex();
      let counter = counters.get(k);
      if (counter === undefined) {
        counter = this.local("index", F64, true);
        counters.set(k, counter);
        stateDecls.push({ kind: "varDecl", localId: counter, init: numLit(0, loc), loc });
      }
      const ix = this.local("ix", F64);
      pre.push(
        { kind: "varDecl", localId: ix, init: varRef(counter, F64, loc), loc },
        increment(counter, loc),
      );
      return varRef(ix, F64, loc);
    };

    /** Call callback `k` with `lead` arguments, a value, and the index and
     * array arguments it declares. */
    const deliver = (
      stage: Stage,
      k: number,
      lead: IrExpr[],
      flow: Flow & { kind: "value" },
    ): { pre: IrStmt[]; value: IrExpr } | null => {
      const arity = stage.info.arity;
      const value = varRef(flow.id, flow.type, loc);
      const at = lead.length;
      const pick = (): { arg: IrExpr & { type: FuncType }; value: IrExpr | null } | null => {
        if (arity <= at) return { arg: stage.slow, value: null };
        const fast = stage.fast;
        if (fast && typeEquals(fast.type.params[at]!, flow.type)) return { arg: fast, value };
        const paramT = stage.slow.type.params[at]!;
        if (typeEquals(paramT, flow.type)) return { arg: stage.slow, value };
        if (paramT.kind === "union" && flow.type.kind !== "union") {
          const tag = this.lowerer.armTag(paramT.unionId, flow.type);
          if (tag >= 0)
            return {
              arg: stage.slow,
              value: { kind: "unionWrap", unionId: paramT.unionId, tag, value, type: paramT, loc },
            };
        }
        return null;
      };
      const chosen = pick();
      if (!chosen) return null;
      const before: IrStmt[] = [];
      const args = chosen.value ? [...lead, chosen.value] : lead.slice();
      if (chosen.value && arity > args.length) args.push(indexArg(k, before));
      if (chosen.value && arity > args.length) args.push(a);
      const called = this.invoke(
        this.callee(chosen.arg),
        args.slice(0, arity),
        chosen.arg.type.ret,
      );
      return { pre: [...before, ...called.pre], value: called.value };
    };

    const fail = (): IrStmt[] => {
      this.failed = true;
      return [];
    };

    /** Turn the source slot into a value for the callback of `stage`. */
    const read = (stage: Stage, rest: (flow: Flow & { kind: "value" }) => IrStmt[]): IrStmt[] => {
      if (stage.info.present) {
        const v = this.local("v", arrT.elem);
        return [
          { kind: "varDecl", localId: v, init: slotRead(), loc },
          ...rest({ kind: "value", id: v, type: arrT.elem }),
        ];
      }
      const valueT = arrayValueType(this.lowerer, arrT.elem);
      if (stage.fast) {
        // The split visit: a value goes on as the plain element, a present
        // undefined as the undefined arm.
        const missing = this.lowerer.wrappedUndefined(valueT, loc);
        if (!missing) return fail();
        const v = this.local("v", arrT.elem);
        const u = this.local("u", valueT);
        return [
          {
            kind: "if",
            cond: {
              kind: "bin",
              op: "===",
              left: { kind: "arrayState", arr: a, index: i, type: F64, loc },
              right: numLit(1, loc),
              type: BOOL,
              loc,
            },
            then: [
              { kind: "varDecl", localId: v, init: slotRead(), loc },
              ...rest({ kind: "value", id: v, type: arrT.elem }),
            ],
            else_: [
              { kind: "varDecl", localId: u, init: missing, loc },
              ...rest({ kind: "value", id: u, type: valueT }),
            ],
            loc,
          },
        ];
      }
      const u = this.local("u", valueT);
      return [
        {
          kind: "varDecl",
          localId: u,
          init: arrayValueRead(this.lowerer, a, i, arrT.elem, loc),
          loc,
        },
        ...rest({ kind: "value", id: u, type: valueT }),
      ];
    };

    /** The statements that run one value through stages k.. and the terminal. */
    const visit = (k: number, flow: Flow): IrStmt[] => {
      if (k === chain.stages.length) return finish(flow);
      const stage = chain.stages[k]!;
      const info = stage.info;
      if (flow.kind === "slot") return read(stage, (value) => visit(k, value));
      const called = deliver(stage, k, [], flow);
      if (!called) return fail();
      const { pre, value: result } = called;
      switch (info.method) {
        case "map":
        case "flatMap": {
          const id = this.local("m", info.fnRet);
          return [
            ...pre,
            { kind: "varDecl", localId: id, init: result, loc },
            ...visit(k + 1, { kind: "value", id, type: info.fnRet }),
          ];
        }
        case "filter":
          return [
            ...pre,
            {
              kind: "if",
              cond:
                result.type.kind === "bool"
                  ? result
                  : { kind: "toBool", operand: result, type: BOOL, loc },
              then: visit(k + 1, flow),
              else_: null,
              loc,
            },
          ];
        case "flatMapArray": {
          const r = this.local("r", info.fnRet);
          const m = this.local("len", F64);
          const j = this.local("j", F64, true);
          const inner = (info.fnRet as IrType & { kind: "array" }).elem;
          const rRef = varRef(r, info.fnRet, loc);
          const jRef = varRef(j, F64, loc);
          let each: IrStmt[];
          if (k + 1 === chain.stages.length && terminal.kind === "length") {
            each = finish({ kind: "slot" });
          } else {
            const w = this.local("w", arrayValueType(this.lowerer, inner));
            const element = arrayValueRead(this.lowerer, rRef, jRef, inner, loc);
            each = [
              { kind: "varDecl", localId: w, init: element, loc },
              ...visit(k + 1, { kind: "value", id: w, type: element.type }),
            ];
          }
          return [
            ...pre,
            { kind: "varDecl", localId: r, init: result, loc },
            {
              kind: "varDecl",
              localId: m,
              init: {
                kind: "arrIntrinsic",
                method: "length",
                receiver: rRef,
                args: [],
                type: F64,
                loc,
              },
              loc,
            },
            {
              kind: "for",
              init: { kind: "varDecl", localId: j, init: numLit(0, loc), loc },
              cond: {
                kind: "bin",
                op: "<",
                left: jRef,
                right: varRef(m, F64, loc),
                type: BOOL,
                loc,
              },
              update: {
                kind: "assign",
                localId: j,
                value: { kind: "bin", op: "+", left: jRef, right: numLit(1, loc), type: F64, loc },
                loc,
              },
              body: [
                {
                  kind: "if",
                  cond: arrayIndexPresent(rRef, jRef, loc),
                  then: each,
                  else_: null,
                  loc,
                },
              ],
              loc,
            },
          ];
        }
        default:
          return fail();
      }
    };

    /** The terminal's action for one value. */
    const finish = (flow: Flow): IrStmt[] => {
      if (terminal.kind === "length") return [increment(count!, loc)];
      if (terminal.kind === "collect") {
        if (flow.kind !== "value") return fail();
        const last = chain.stages[chain.stages.length - 1]!;
        const outT = resultT as IrType & { kind: "array" };
        if (!typeEquals(outT.elem, last.info.outElem)) return fail();
        const outRef = varRef(out!, resultT, loc);
        const index: IrExpr = holes
          ? outIndex()
          : { kind: "arrIntrinsic", method: "length", receiver: outRef, args: [], type: F64, loc };
        return [
          arrayValueStore(
            this.lowerer,
            outRef,
            index,
            varRef(flow.id, flow.type, loc),
            outT.elem,
            loc,
          ),
        ];
      }
      const stage = terminal.stage;
      const method = stage.info.method;
      if (flow.kind === "slot") return read(stage, (value) => finish(value));
      if (method === "reduce") {
        const accT = stage.info.outElem;
        const called = deliver(stage, chain.stages.length, [varRef(acc!, accT, loc)], flow);
        if (!called || !typeEquals(called.value.type, accT)) return fail();
        return [...called.pre, { kind: "assign", localId: acc!, value: called.value, loc }];
      }
      const called = deliver(stage, chain.stages.length, [], flow);
      if (!called) return fail();
      const { pre, value: result } = called;
      if (method === "forEach") {
        return stage.slow.type.ret.kind === "void" && result.kind === "numLit"
          ? pre
          : [...pre, { kind: "exprStmt", expr: result, loc }];
      }
      const test = predicateToBoolean(result);
      if (method === "some")
        return [
          ...pre,
          {
            kind: "if",
            cond: test,
            then: [{ kind: "return", value: boolLit(true, loc), loc }],
            else_: null,
            loc,
          },
        ];
      if (method === "every")
        return [
          ...pre,
          {
            kind: "if",
            cond: { kind: "unary", op: "!", operand: test, type: BOOL, loc },
            then: [{ kind: "return", value: boolLit(false, loc), loc }],
            else_: null,
            loc,
          },
        ];
      if (method === "findIndex")
        return [
          ...pre,
          {
            kind: "if",
            cond: test,
            then: [{ kind: "return", value: varRef(count!, F64, loc), loc }],
            else_: null,
            loc,
          },
          increment(count!, loc),
        ];
      return fail();
    };

    // Callbacks are parameters in stage order; the reduce seed follows them.
    for (const stage of terminalStage ? [...chain.stages, terminalStage] : chain.stages) {
      void stage;
    }
    const present = visit(0, { kind: "slot" });
    if (this.failed) return null;
    if (acc !== null && terminal.kind === "call") {
      const z = this.param("z", terminal.init!, "init");
      stateDecls.unshift({ kind: "varDecl", localId: acc, init: z, loc });
    }
    body.push(...stateDecls);
    const hole: IrStmt[] | null =
      holes && terminal.kind === "length" ? [increment(count!, loc)] : null;
    const loopBody: IrStmt[] = [
      { kind: "if", cond: arrayIndexPresent(a, i, loc), then: present, else_: hole, loc },
    ];
    const loop: IrStmt = chain.slice
      ? {
          kind: "for",
          init: { kind: "varDecl", localId: "i.0", init: lo, loc },
          cond: { kind: "bin", op: "<", left: i, right: hi, type: BOOL, loc },
          update: {
            kind: "assign",
            localId: "i.0",
            value: { kind: "bin", op: "+", left: i, right: numLit(1, loc), type: F64, loc },
            loc,
          },
          body: loopBody,
          loc,
        }
      : countedFor(loc, nRef, () => loopBody);
    body.push(loop, ...epilogue);
    this.keyParts.push(`${terminal.kind}:${typeKey(resultT)}`);
    const returnType: IrType =
      terminal.kind === "call" && terminal.stage.info.method === "forEach" ? VOID : resultT;
    const fn: Omit<IrFunction, "name"> = {
      params: this.params,
      returnType,
      locals: this.locals,
      body,
      loc,
    };
    foldKnownUnions(fn);
    scalarizeRecordTemporaries(this.lowerer, fn);
    const inlinedCaptures = this.callees.flatMap((c) =>
      c.inline && c.arg.kind === "closure" ? c.arg.captures : [],
    );
    return { fn, args: this.args, key: this.keyParts.join("|"), inlinedCaptures };
  }
}

function increment(id: string, loc: SrcLoc): IrStmt {
  return {
    kind: "assign",
    localId: id,
    value: {
      kind: "bin",
      op: "+",
      left: varRef(id, F64, loc),
      right: numLit(1, loc),
      type: F64,
      loc,
    },
    loc,
  };
}

/** ToBoolean of a predicate result, as the some/every/findIndex helpers apply it. */
function predicateToBoolean(e: IrExpr): IrExpr {
  if (e.type.kind === "bool") return e;
  if (e.type.kind === "dyn")
    return { kind: "dynTest", test: "truthy", value: e, type: BOOL, loc: e.loc };
  return { kind: "toBool", operand: e, type: BOOL, loc: e.loc };
}

/** A union local the fused loop wrapped from a plain value has a known
 * tag: its tag tests fold, its narrowing is the plain value, and the wrap
 * itself goes away once nothing reads it. */
function foldKnownUnions(fn: Omit<IrFunction, "name">): void {
  const writes = new Map<string, number>();
  const count = (id: string): void => {
    writes.set(id, (writes.get(id) ?? 0) + 1);
  };
  everyStmtList(fn.body, {
    expr: (e) => {
      if (e.kind === "assignExpr" || e.kind === "incDec") count(e.localId);
      return true;
    },
    stmt: (s) => {
      if (s.kind === "varDecl" || s.kind === "assign" || s.kind === "forOf") count(s.localId);
      return true;
    },
  });
  const known = new Map<string, { tag: number; value: IrExpr & { kind: "varRef" } }>();
  everyStmtList(fn.body, {
    expr: () => true,
    stmt: (s) => {
      if (
        s.kind === "varDecl" &&
        s.init?.kind === "unionWrap" &&
        s.init.value.kind === "varRef" &&
        writes.get(s.localId) === 1 &&
        writes.get(s.init.value.localId) === 1
      )
        known.set(s.localId, { tag: s.init.tag, value: s.init.value });
      return true;
    },
  });
  if (known.size === 0) return;
  const fold = (e: IrExpr): IrExpr => {
    if (e.kind === "unionIsTag" && e.value.kind === "varRef") {
      const k = known.get(e.value.localId);
      if (k) return boolLit((k.tag === e.tag) !== e.negated, e.loc);
    }
    if (e.kind === "unionNarrow" && e.value.kind === "varRef") {
      const k = known.get(e.value.localId);
      if (k && k.tag === e.tag && typeEquals(k.value.type, e.type))
        return { ...k.value, loc: e.loc };
    }
    if (e.kind === "ternary") {
      const cond = fold(e.cond);
      if (cond.kind === "boolLit") return fold(cond.value ? e.then : e.else_);
    }
    return e;
  };
  let body = transformStmtList(fn.body, { stmt: (s) => s, expr: fold });
  const reads = new Set<string>();
  everyStmtList(body, {
    expr: (e) => {
      if (e.kind === "varRef") reads.add(e.localId);
      return true;
    },
    stmt: () => true,
  });
  const dead = new Set([...known.keys()].filter((id) => !reads.has(id)));
  if (dead.size > 0) {
    const prune = (list: IrStmt[]): IrStmt[] =>
      list
        .filter((s) => !(s.kind === "varDecl" && dead.has(s.localId)))
        .map((s) => {
          switch (s.kind) {
            case "if":
              return { ...s, then: prune(s.then), else_: s.else_ === null ? null : prune(s.else_) };
            case "for":
            case "while":
            case "doWhile":
            case "block":
              return { ...s, body: prune(s.body) };
            default:
              return s;
          }
        });
    body = prune(body);
    fn.locals = fn.locals.filter((l) => !dead.has(l.id));
  }
  fn.body = body;
}

/* ── per-element record temporaries ──────────────────────────────────── */

/** Inside a fused loop, a record one inlined stage builds and the next
 * only reads field by field never needs to exist. A group of record locals
 * connected by copies, each defined only by a literal of their shape (or a
 * copy within the group) and used only through field reads, becomes one
 * scalar local per field. Literal fields still evaluate in source order
 * (through temporaries, so a literal may read the fields it replaces).
 * Identity cannot be observed: no use besides a field read survives. */
function scalarizeRecordTemporaries(lowerer: Lowerer, fn: Omit<IrFunction, "name">): void {
  const params = new Set(fn.params.map((p) => p.localId));
  const candidates = new Map<string, IrLocal & { type: IrType & { kind: "record" } }>();
  for (const l of fn.locals) {
    if (l.type.kind !== "record" || l.boxed || l.tdz || params.has(l.id)) continue;
    const shape = lowerer.shapes.get(l.type.shapeId);
    if (
      !shape ||
      shape.tuple ||
      shape.indexValue ||
      shape.fields.length === 0 ||
      shape.fields.length > 8 ||
      !shape.fields.every((f) => f.type.kind === "f64" || f.type.kind === "bool")
    )
      continue;
    candidates.set(l.id, l as IrLocal & { type: IrType & { kind: "record" } });
  }
  if (candidates.size === 0) return;
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    let root = id;
    while (parent.has(root)) root = parent.get(root)!;
    return root;
  };
  const union = (x: string, y: string): void => {
    const rx = find(x);
    const ry = find(y);
    if (rx !== ry) parent.set(rx, ry);
  };
  const bad = new Set<string>();
  const sameShape = (x: string, y: string): boolean =>
    candidates.get(x)!.type.shapeId === candidates.get(y)!.type.shapeId;
  const literalOk = (e: IrExpr, shapeId: string): boolean =>
    e.kind === "recordLit" &&
    e.type.kind === "record" &&
    e.type.shapeId === shapeId &&
    e.fields.every((f) => !f.overflow);
  const expr = (e: IrExpr): boolean => {
    if (e.kind === "recordGet" && e.obj.kind === "varRef" && candidates.has(e.obj.localId))
      return true;
    if (
      (e.kind === "varRef" || e.kind === "assignExpr" || e.kind === "incDec") &&
      candidates.has(e.localId)
    )
      bad.add(e.localId);
    if (e.kind === "closure") for (const id of e.captures) if (candidates.has(id)) bad.add(id);
    return everyExprChild(e, expr, stmt);
  };
  const definition = (id: string, value: IrExpr | null): void => {
    const target = candidates.get(id)!;
    if (value === null) return;
    if (value.kind === "varRef" && candidates.has(value.localId)) {
      if (sameShape(id, value.localId)) union(id, value.localId);
      else bad.add(id);
      return;
    }
    if (literalOk(value, target.type.shapeId)) {
      for (const f of (value as IrExpr & { kind: "recordLit" }).fields) expr(f.value);
      return;
    }
    bad.add(id);
    expr(value);
  };
  const stmt = (s: IrStmt): boolean => {
    if ((s.kind === "varDecl" || s.kind === "assign") && candidates.has(s.localId)) {
      definition(s.localId, s.kind === "varDecl" ? s.init : s.value);
      return true;
    }
    if (s.kind === "forOf" && candidates.has(s.localId)) bad.add(s.localId);
    return everyStmtChild(s, expr, stmt);
  };
  fn.body.forEach(stmt);
  const badRoots = new Set([...bad].map(find));
  const chosen = [...candidates.keys()].filter((id) => !badRoots.has(find(id)));
  if (chosen.length === 0) return;
  const fields = new Map<string, Map<string, string>>();
  const added: IrLocal[] = [];
  let next = 0;
  const used = new Set(fn.locals.map((l) => l.id));
  const fresh = (name: string): string => {
    let id: string;
    do id = `${name}.s${next++}`;
    while (used.has(id));
    used.add(id);
    return id;
  };
  for (const id of chosen) {
    const local = candidates.get(id)!;
    const shape = lowerer.shapes.get(local.type.shapeId)!;
    const map = new Map<string, string>();
    for (const f of shape.fields) {
      const fid = fresh(`${local.name}.${f.name}`);
      map.set(f.name, fid);
      added.push({ id: fid, name: `${local.name}.${f.name}`, type: f.type, mutable: true });
    }
    fields.set(id, map);
  }
  const fieldType = (id: string, field: string): IrType =>
    lowerer.shapes.get(candidates.get(id)!.type.shapeId)!.fields.find((f) => f.name === field)!
      .type;
  const rewriteExpr = (e: IrExpr): IrExpr => {
    const [s] = transformStmtList([{ kind: "exprStmt", expr: e, loc: e.loc }], {
      stmt: (x) => x,
      expr: (x) => {
        if (x.kind === "recordGet" && x.obj.kind === "varRef") {
          const id = fields.get(x.obj.localId)?.get(x.field);
          if (id) return { kind: "varRef", localId: id, type: x.type, loc: x.loc };
        }
        return x;
      },
    });
    return (s as IrStmt & { kind: "exprStmt" }).expr;
  };
  const rewriteList = (list: IrStmt[]): IrStmt[] => list.flatMap(rewriteStmt);
  const rewriteStmt = (s: IrStmt): IrStmt[] => {
    if ((s.kind === "varDecl" || s.kind === "assign") && fields.has(s.localId)) {
      const map = fields.get(s.localId)!;
      const value = s.kind === "varDecl" ? s.init : s.value;
      const store = (fid: string, v: IrExpr | null): IrStmt =>
        s.kind === "varDecl"
          ? { kind: "varDecl", localId: fid, init: v, loc: s.loc }
          : { kind: "assign", localId: fid, value: v!, loc: s.loc };
      if (value === null) return [...map.values()].map((fid) => store(fid, null));
      if (value.kind === "varRef") {
        const from = fields.get(value.localId)!;
        return [...map].map(([name, fid]) =>
          store(fid, varRef(from.get(name)!, fieldType(s.localId, name), s.loc)),
        );
      }
      const literal = value as IrExpr & { kind: "recordLit" };
      const temps: IrStmt[] = [];
      const values = new Map<string, IrExpr>();
      for (const f of literal.fields) {
        const t = fresh(`${candidates.get(s.localId)!.name}.${f.name}.t`);
        const type = fieldType(s.localId, f.name);
        added.push({ id: t, name: f.name, type, mutable: false });
        temps.push({ kind: "varDecl", localId: t, init: rewriteExpr(f.value), loc: s.loc });
        values.set(f.name, varRef(t, type, s.loc));
      }
      return [...temps, ...[...map].map(([name, fid]) => store(fid, values.get(name)!))];
    }
    return rewriteNested(s);
  };
  const rewriteNested = (s: IrStmt): IrStmt[] => {
    switch (s.kind) {
      case "if":
        return [
          {
            ...s,
            cond: rewriteExpr(s.cond),
            then: rewriteList(s.then),
            else_: s.else_ === null ? null : rewriteList(s.else_),
          },
        ];
      case "while":
        return [{ ...s, cond: rewriteExpr(s.cond), body: rewriteList(s.body) }];
      case "doWhile":
        return [{ ...s, cond: rewriteExpr(s.cond), body: rewriteList(s.body) }];
      case "for":
        return [
          {
            ...s,
            init: s.init === null ? null : (rewriteStmt(s.init)[0] ?? null),
            cond: s.cond === null ? null : rewriteExpr(s.cond),
            update: s.update === null ? null : (rewriteStmt(s.update)[0] ?? null),
            body: rewriteList(s.body),
          },
        ];
      case "block":
        return [{ ...s, body: rewriteList(s.body) }];
      default: {
        const [x] = transformStmtList([s], {
          stmt: (y) => y,
          expr: (y) => {
            if (y.kind === "recordGet" && y.obj.kind === "varRef") {
              const id = fields.get(y.obj.localId)?.get(y.field);
              if (id) return { kind: "varRef", localId: id, type: y.type, loc: y.loc };
            }
            return y;
          },
        });
        return [x!];
      }
    }
  };
  fn.body = rewriteList(fn.body);
  fn.locals = [...fn.locals.filter((l) => !fields.has(l.id)), ...added];
}
