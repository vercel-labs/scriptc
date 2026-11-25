import {
  BOOL,
  type IrBytesIntrinsicMethod,
  type IrExpr,
  type IrFunction,
  type IrLocal,
  type IrModule,
  type IrStmt,
  type IrType,
} from "./ir.js";
import { eachNodeOfKinds, type IrNodeIndex, type IrNodeKind, lacksKinds } from "./node-index.js";
import { everyStmtList, transformExpr, transformStmtList } from "./traverse.js";

const FOR_KINDS: readonly IrNodeKind[] = ["for"];

/** The most statement and expression nodes of one outer iteration: every
 * copy duplicates it. */
const MAX_BODY_NODES = 160;

/** Binary operators of numbers and booleans that run no other code and
 * cannot throw. */
const PURE_BINARY = new Set<string>([
  "+",
  "-",
  "*",
  "/",
  "%",
  "&",
  "|",
  "^",
  "<<",
  ">>",
  ">>>",
  "<",
  "<=",
  ">",
  ">=",
  "===",
  "!==",
]);

const PURE_UNARY = new Set<string>(["-", "+", "~", "!"]);

/** Statements that write through a reference rather than through a local. */
const MEMORY_STORES = new Set<IrStmt["kind"]>([
  "arraySet",
  "arraySetLength",
  "arraySetUndefined",
  "arrayDelete",
  "bytesSet",
]);

/** Statements `post` may hold: they run in order between the copies, so
 * only control transfer is ruled out. */
const PLAIN_STATEMENTS = new Set<IrStmt["kind"]>([
  "varDecl",
  "assign",
  "exprStmt",
  "if",
  "block",
  ...MEMORY_STORES,
]);

/** Expressions that can run code: they may read and change anything, so a
 * later copy's `pre` and loop cannot run before them. Every `libCall` is
 * one here: some (`emitter.emit`, the timer and fs callbacks) call back
 * into the program, and telling those from the inert members is the
 * library's business, not this pass's. `newPromise` runs its executor. */
const CALLS = new Set<IrExpr["kind"]>([
  "call",
  "ffiCall",
  "callValue",
  "new",
  "newValue",
  "virtualCall",
  "dynCall",
  "dynInvoke",
  "genResume",
  "libCall",
  "newPromise",
]);

/** The bytesIntrinsic methods that write their receiver's (or, for `copy`,
 * the target's) element storage. */
const BYTES_METHOD_STORES: ReadonlySet<IrBytesIntrinsicMethod> = new Set([
  "copyWithin",
  "sortNumeric",
  "sortCompare",
  "setFrom",
  "setFromDyn",
  "fill",
  "fillNum",
  "fillStr",
  "fillElem",
  "copy",
  "swap16",
  "swap32",
  "swap64",
  "writeNum",
  "writeNumVar",
  "writeStr",
  "dvSetUint8",
  "dvSetInt8",
  "dvSetUint16",
  "dvSetInt16",
  "dvSetUint32",
  "dvSetInt32",
  "dvSetFloat16",
  "dvSetFloat32",
  "dvSetFloat64",
]);

/** Whether `e` runs code: a call, or the sort intrinsics whose comparator
 * the runtime invokes. */
function runsCode(e: IrExpr): boolean {
  if (CALLS.has(e.kind)) return true;
  if (e.kind === "bytesIntrinsic") return e.method === "sortCompare";
  if (e.kind === "arrIntrinsic") return e.method === "sortValues" || e.method === "sortDense";
  return false;
}

/** Whether `e` writes element storage through a typed-array/Buffer method
 * (`arr.fill(0)`, an in-place sort, a DataView setter). */
function storesBytes(e: IrExpr): boolean {
  return e.kind === "bytesIntrinsic" && BYTES_METHOD_STORES.has(e.method);
}

type InnerLoop = IrStmt & ({ kind: "for" } | { kind: "while" } | { kind: "doWhile" });

interface Jam {
  loop: IrStmt & { kind: "for" };
  counter: string;
  counterType: IrType;
  step: number;
  pre: IrStmt[];
  inner: InnerLoop;
  post: IrStmt[];
  /** The locals the loop body declares: every copy gets its own. */
  own: Set<string>;
}

function isRef(e: IrExpr | null | undefined, id: string): boolean {
  return e?.kind === "varRef" && e.localId === id;
}

function intLit(e: IrExpr | null | undefined): number | null {
  return e?.kind === "numLit" && Number.isSafeInteger(e.value) && !Object.is(e.value, -0)
    ? e.value
    : null;
}

/** `id = id + step` with a positive integer literal step. */
function constantStep(update: IrStmt | null, id: string): number | null {
  if (
    update?.kind !== "assign" ||
    update.localId !== id ||
    update.value.kind !== "bin" ||
    update.value.op !== "+" ||
    !isRef(update.value.left, id)
  )
    return null;
  const step = intLit(update.value.right);
  return step !== null && step > 0 ? step : null;
}

/** A number or boolean expression that runs no other code, cannot throw and
 * reads memory only through a typed-array element read that answers NaN out
 * of range: literals, reads of locals and module bindings, arithmetic,
 * comparisons and boolean connectives. */
function pureExpr(e: IrExpr, locals: ReadonlyMap<string, IrLocal>): boolean {
  if (e.type.kind !== "f64" && e.type.kind !== "bool") return false;
  switch (e.kind) {
    case "numLit":
    case "boolLit":
      return true;
    case "varRef": {
      const local = locals.get(e.localId);
      if (local) return !local.boxed && !local.tdz;
      return e.localId.startsWith("%g.");
    }
    case "bin":
      return PURE_BINARY.has(e.op) && pureExpr(e.left, locals) && pureExpr(e.right, locals);
    case "unary":
      return PURE_UNARY.has(e.op) && pureExpr(e.operand, locals);
    case "logical":
      return pureExpr(e.left, locals) && pureExpr(e.right, locals);
    case "toBool":
      return pureExpr(e.operand, locals);
    case "bytesIntrinsic":
      return (
        e.method === "get" &&
        e.invalidNaN === true &&
        e.receiver.kind === "varRef" &&
        e.args.length === 1 &&
        pureExpr(e.args[0]!, locals)
      );
    default:
      return false;
  }
}

/** A local written by `s` (a declaration or assignment), or null. */
function writtenLocal(s: IrStmt): string | null {
  return s.kind === "varDecl" || s.kind === "assign" ? s.localId : null;
}

/** Every local written anywhere in `list`, including the targets of `x++`
 * and `x += v`. */
function localWrites(list: readonly IrStmt[]): Set<string> {
  const out = new Set<string>();
  everyStmtList(list as IrStmt[], {
    expr: (e) => {
      if (e.kind === "incDec" || e.kind === "assignExpr") out.add(e.localId);
      return true;
    },
    stmt: (s) => {
      const id = writtenLocal(s);
      if (id !== null) out.add(id);
      return true;
    },
  });
  return out;
}

/** Straight-line declarations and assignments of pure values. */
function pureStatements(list: readonly IrStmt[], locals: ReadonlyMap<string, IrLocal>): boolean {
  return list.every(
    (s) =>
      (s.kind === "varDecl" && s.init !== null && pureExpr(s.init, locals)) ||
      (s.kind === "assign" && locals.has(s.localId) && pureExpr(s.value, locals)),
  );
}

/** The inner loop's body: pure declarations and assignments to the
 * iteration's own locals, and `if` statements over them. Any other
 * statement would run in a different order once two iterations' loops
 * share one loop. */
function innerStatements(
  list: readonly IrStmt[],
  locals: ReadonlyMap<string, IrLocal>,
  own: ReadonlySet<string>,
): boolean {
  return list.every((s) => {
    switch (s.kind) {
      case "if":
        return (
          pureExpr(s.cond, locals) &&
          innerStatements(s.then, locals, own) &&
          innerStatements(s.else_ ?? [], locals, own)
        );
      case "varDecl":
        return s.init !== null && pureExpr(s.init, locals) && own.has(s.localId);
      case "assign":
        return own.has(s.localId) && pureExpr(s.value, locals);
      case "exprStmt":
        return pureExpr(s.expr, locals);
      default:
        return false;
    }
  });
}

/** Whether `list` holds no expression that can run code. */
function noCalls(list: readonly IrStmt[]): boolean {
  return everyStmtList(list as IrStmt[], { expr: (e) => !runsCode(e), stmt: () => true });
}

/** `post`: statements between the two copies' loops and their results,
 * kept in order, with no control transfer and no call that could observe
 * or change what an earlier copy's loop touches. */
function plainPost(list: readonly IrStmt[]): boolean {
  return list.every((s) => {
    if (!PLAIN_STATEMENTS.has(s.kind) || !noCalls([s])) return false;
    if (s.kind === "if") return plainPost(s.then) && plainPost(s.else_ ?? []);
    if (s.kind === "block") return plainPost(s.body);
    return true;
  });
}

/** Whether `list` reads memory: an element read of a typed array, the one
 * memory read `pureExpr` admits. */
function readsMemory(list: readonly IrStmt[]): boolean {
  return !everyStmtList(list as IrStmt[], {
    expr: (e) => e.kind !== "bytesIntrinsic",
    stmt: () => true,
  });
}

/** Whether `list` holds a memory store at any depth: a storing statement,
 * or a typed-array method such as `fill` that writes element storage
 * through an expression rather than a `bytesSet`. */
function hasStore(list: readonly IrStmt[]): boolean {
  return !everyStmtList(list as IrStmt[], {
    expr: (e) => !storesBytes(e),
    stmt: (s) => !MEMORY_STORES.has(s.kind),
  });
}

function countNodes(list: readonly IrStmt[]): number {
  let n = 0;
  everyStmtList(list as IrStmt[], {
    expr: () => ++n <= MAX_BODY_NODES,
    stmt: () => ++n <= MAX_BODY_NODES,
  });
  return n;
}

/** Whether `list` reads local `id`. */
function reads(list: readonly IrStmt[], id: string): boolean {
  return !everyStmtList(list as IrStmt[], { expr: (e) => !isRef(e, id), stmt: () => true });
}

/** Locals declared anywhere in `list`. */
function declared(list: readonly IrStmt[]): Set<string> {
  const out = new Set<string>();
  everyStmtList(list as IrStmt[], {
    expr: () => true,
    stmt: (s) => {
      if (s.kind === "varDecl") out.add(s.localId);
      return true;
    },
  });
  return out;
}

/** Whether `list` writes a local outside `own`, which only an iteration's
 * own state may hold. */
function writesOutside(list: readonly IrStmt[], own: ReadonlySet<string>): boolean {
  for (const id of localWrites(list)) if (!own.has(id)) return true;
  return false;
}

/** Whether the inner loop is pure over its own locals: every value it
 * writes belongs to the iteration, and its condition and update run no
 * code. */
function innerOk(
  inner: InnerLoop,
  locals: ReadonlyMap<string, IrLocal>,
  own: ReadonlySet<string>,
): boolean {
  switch (inner.kind) {
    case "while":
    case "doWhile":
      return pureExpr(inner.cond, locals) && innerStatements(inner.body, locals, own);
    case "for": {
      const init = inner.init;
      if (init !== null) {
        if (init.kind === "varDecl") {
          if (init.init === null || !pureExpr(init.init, locals) || !own.has(init.localId))
            return false;
        } else if (
          init.kind !== "assign" ||
          !pureExpr(init.value, locals) ||
          !own.has(init.localId)
        )
          return false;
      }
      if (inner.cond !== null && !pureExpr(inner.cond, locals)) return false;
      if (inner.update !== null) {
        if (inner.update.kind !== "assign") return false;
        if (!own.has(inner.update.localId) || !pureExpr(inner.update.value, locals)) return false;
      }
      return innerStatements(inner.body, locals, own);
    }
  }
}

/** The jam of `loop`, or null.
 *
 *   for (let x = start; <cond]; x = x + step) {
 *     <pre: pure declarations and assignments>
 *     <inner loop over the iteration's own locals>
 *     <post: the statements that use the iteration's result>
 *   }
 */
function matchJam(
  loop: IrStmt & { kind: "for" },
  locals: ReadonlyMap<string, IrLocal>,
): Jam | null {
  if (loop.labels?.length || loop.init?.kind !== "varDecl" || loop.init.init === null) return null;
  const counter = loop.init.localId;
  const local = locals.get(counter);
  if (local?.type.kind !== "f64" || !local.mutable || local.boxed || local.tdz) return null;
  if (loop.init.init.kind !== "numLit") return null;
  const step = constantStep(loop.update, counter);
  const cond = loop.cond;
  if (step === null || cond === null || !pureExpr(cond, locals)) return null;
  // Exactly one inner loop, with straight-line code before and after it.
  let at = -1;
  for (let i = 0; i < loop.body.length; i++) {
    const s = loop.body[i]!;
    if (s.kind !== "for" && s.kind !== "while" && s.kind !== "doWhile") continue;
    if (at >= 0) return null;
    at = i;
  }
  if (at < 0) return null;
  const inner = loop.body[at] as InnerLoop;
  if (inner.labels?.length) return null;
  const pre = loop.body.slice(0, at);
  const post = loop.body.slice(at + 1);
  if (!pureStatements(pre, locals) || !plainPost(post)) return null;
  if (countNodes(loop.body) > MAX_BODY_NODES) return null;
  const own = declared(loop.body);
  // The body's state is the iteration's own: only `post` may change a
  // value that lives across iterations or outside the loop, and no
  // statement the loop body holds may advance the counter.
  if (writesOutside(pre, own) || writesOutside([inner], own)) return null;
  if (localWrites(loop.body).has(counter)) return null;
  const postWrites = localWrites(post);
  const control: IrStmt = { kind: "exprStmt", expr: cond, loc: loop.loc };
  // The first copy's `post` runs after the second copy's `pre` and loop:
  // neither may read a value it writes...
  for (const id of postWrites) if (reads([...pre, inner], id)) return null;
  // ...or memory it stores through, when their loops read memory. The
  // second copy's condition is tested even earlier, so a stored range it
  // reads rules the pairing out too.
  if (hasStore(post) && (readsMemory([...pre, inner]) || readsMemory([control]))) return null;
  // The second copy's condition is evaluated before the first copy's
  // `post` rather than after it: the condition may not depend on a value
  // the body changes.
  const bodyWrites = localWrites(loop.body);
  for (const id of bodyWrites) if (reads([control], id)) return null;
  if (!innerOk(inner, locals, own)) return null;
  return { loop, counter, counterType: local.type, step, pre, inner, post, own };
}

/** Runs a counted loop's iterations two at a time when the loop's body is
 * `pre; inner loop; post` and the inner loop works only on the iteration's
 * own locals:
 *
 *   for (let x = 0; x < w; x += 2) {
 *     const c = x * k;                                // pre
 *     do { ...; i++; } while (i < 50 && mask !== 0);   // inner
 *     out[o] = mask;                                  // post
 *   }
 *
 * becomes a loop whose iterations each run two of the original ones, with
 * `x2` holding the second one's counter (the value the loop's own update
 * would have produced), the two inner loops sharing one loop through live
 * flags, and the two `post`s in order; a second loop finishes the one
 * iteration a pair could not take:
 *
 *   for (; x < w && x2 < w; x = x2 + 2, x2 = x + 2) {
 *     pre; pre2; inner init; inner init2;
 *     do { if (live) { ...; i++; } if (live2) { ...; i2++; }
 *          live = <cond>; live2 = <cond2>; } while (live || live2);
 *     post; post2;
 *   }
 *   for (; x < w; x += 2) { pre; inner; post; }
 *
 * Each copy's live flag stops its loop at exactly the iteration it would
 * have stopped at on its own, so the value its `post` reads is the value
 * its own loop left, and the two iterations' dependence chains overlap.
 * `pre` and the inner loop touch only the iteration's locals and read
 * nothing `post` writes, so running the second iteration's `pre` and loop
 * before the first iteration's `post` changes no value; they also run no
 * code and read no memory a `post` stores through. `nodes`, an index of
 * `mod`, gives each function's `for` loops without walking its body. */
export function jamRuntimeCountLoops(mod: IrModule, nodes?: IrNodeIndex): IrModule {
  const loops = nodes?.scan(FOR_KINDS);
  let changed = false;
  const functions = mod.functions.map((fn): IrFunction => {
    if (fn.async || fn.generator || lacksKinds(fn, loops)) return fn;
    const locals = new Map(fn.locals.map((local) => [local.id, local]));
    let found = false;
    eachNodeOfKinds(fn, loops, (node) => {
      if (node.kind === "for" && matchJam(node, locals) !== null) found = true;
      return !found;
    });
    if (!found) return fn;
    const added: IrLocal[] = [];
    const ids = new Set(fn.locals.map((local) => local.id));
    const unique = (id: string): string => {
      let next = id;
      while (ids.has(next)) next += "_";
      ids.add(next);
      return next;
    };
    const fresh = (of: IrLocal, copy: number): string => {
      const id = unique(`%jam.${copy}.${of.id}`);
      const { source: _source, ...rest } = of;
      added.push({ ...rest, id, name: `%jam.${of.name}` });
      return id;
    };
    const temp = (base: string, type: IrType): string => {
      const id = unique(`%jam.${base}`);
      added.push({ id, name: `%jam.${base}`, type, mutable: true });
      return id;
    };
    const body = transformStmtList(fn.body, {
      expr: (e) => e,
      stmt: (s) => {
        if (s.kind !== "for") return s;
        const jam = matchJam(s, locals);
        return jam === null ? s : emitJam(jam, locals, fresh, temp);
      },
    });
    changed = true;
    return { ...fn, locals: [...fn.locals, ...added], body };
  });
  return changed ? { ...mod, functions } : mod;
}

function emitJam(
  jam: Jam,
  locals: ReadonlyMap<string, IrLocal>,
  fresh: (of: IrLocal, copy: number) => string,
  temp: (base: string, type: IrType) => string,
): IrStmt {
  const { loop, counter, counterType, step, pre, inner, post, own } = jam;
  const loc = loop.loc;
  const init = loop.init as IrStmt & { kind: "varDecl" };
  const next = temp("next", counterType);
  const lives = [temp("live", BOOL), temp("live", BOOL)];
  const counters = [counter, next];
  const rename = [new Map<string, string>(), new Map<string, string>()];
  for (const id of own) {
    const local = locals.get(id)!;
    for (let copy = 0; copy < 2; copy++) rename[copy]!.set(id, fresh(local, copy));
  }
  const liveRef = (copy: number): IrExpr => ({
    kind: "varRef",
    localId: lives[copy]!,
    type: BOOL,
    loc,
  });
  // One copy's expressions and statements, with its counter and its own
  // locals renamed.
  const renameExpr =
    (copy: number) =>
    (e: IrExpr): IrExpr => {
      if (e.kind === "varRef") {
        if (e.localId === counter) return { ...e, localId: counters[copy]!, type: counterType };
        const to = rename[copy]!.get(e.localId);
        return to === undefined ? e : { ...e, localId: to };
      }
      if (e.kind === "incDec" || e.kind === "assignExpr") {
        const to = rename[copy]!.get(e.localId);
        return to === undefined ? e : { ...e, localId: to };
      }
      // A closure captures its creating function's boxes: the copy's closure
      // must hold the copy's box, or it would read the original local, which
      // the pair's declaration no longer initializes.
      if (e.kind === "closure") {
        const captures = e.captures.map((id) => rename[copy]!.get(id) ?? id);
        return captures.every((id, at) => id === e.captures[at]) ? e : { ...e, captures };
      }
      return e;
    };
  const renameStmt =
    (copy: number) =>
    (s: IrStmt): IrStmt => {
      if ((s.kind === "varDecl" || s.kind === "assign") && rename[copy]!.has(s.localId))
        return { ...s, localId: rename[copy]!.get(s.localId)! };
      return s;
    };
  const renamed = (copy: number, list: readonly IrStmt[]): IrStmt[] =>
    transformStmtList(list as IrStmt[], { expr: renameExpr(copy), stmt: renameStmt(copy) });
  const renamedExpr = (copy: number, e: IrExpr): IrExpr =>
    transformExpr(e, { expr: renameExpr(copy), stmt: renameStmt(copy) });

  const copies = [0, 1].map((copy) => ({
    pre: renamed(copy, pre),
    body: renamed(copy, inner.body),
    init: inner.kind === "for" && inner.init !== null ? renamed(copy, [inner.init])[0]! : null,
    update:
      inner.kind === "for" && inner.update !== null ? renamed(copy, [inner.update])[0]! : null,
    cond: inner.cond === null ? null : renamedExpr(copy, inner.cond),
    post: renamed(copy, post),
  }));
  const liveInit = (copy: number): IrStmt => {
    const cond = copies[copy]!.cond;
    const value: IrExpr =
      inner.kind === "doWhile" || cond === null
        ? { kind: "boolLit", value: true, type: BOOL, loc }
        : cond;
    return { kind: "varDecl", localId: lives[copy]!, init: value, loc };
  };
  const liveNext = (copy: number): IrStmt | null => {
    const cond = copies[copy]!.cond;
    return cond === null ? null : { kind: "assign", localId: lives[copy]!, value: cond, loc };
  };
  const guarded = (copy: number): IrStmt | null => {
    const statements = [
      ...copies[copy]!.body,
      ...(copies[copy]!.update === null ? [] : [copies[copy]!.update!]),
    ];
    if (statements.length === 0) return null;
    return { kind: "if", cond: liveRef(copy), then: statements, else_: null, loc };
  };
  const either: IrExpr = {
    kind: "logical",
    op: "||",
    left: liveRef(0),
    right: liveRef(1),
    type: BOOL,
    loc,
  };
  const innerBody = [guarded(0), guarded(1), liveNext(0), liveNext(1)].filter(
    (s): s is IrStmt => s !== null,
  );
  const fused: IrStmt =
    inner.kind === "doWhile"
      ? { kind: "doWhile", cond: either, body: innerBody, loc }
      : { kind: "while", cond: either, body: innerBody, loc };
  const advance = (from: string): IrExpr => ({
    kind: "bin",
    op: "+",
    left: { kind: "varRef", localId: from, type: counterType, loc },
    right: { kind: "numLit", value: step, type: counterType, loc },
    type: counterType,
    loc,
  });
  const secondCond = transformExpr(loop.cond!, {
    expr: (e) => (e.kind === "varRef" && e.localId === counter ? { ...e, localId: next } : e),
    stmt: (s) => s,
  });
  // A tree of its own, so the tail keeps the only reference to the
  // original condition's nodes.
  const firstCond = transformExpr(loop.cond!, { expr: (e) => e, stmt: (s) => s });
  const pair: IrStmt = {
    kind: "while",
    cond: { kind: "logical", op: "&&", left: firstCond, right: secondCond, type: BOOL, loc },
    body: [
      ...copies[0]!.pre,
      ...copies[1]!.pre,
      ...(copies[0]!.init === null ? [] : [copies[0]!.init!]),
      ...(copies[1]!.init === null ? [] : [copies[1]!.init!]),
      liveInit(0),
      liveInit(1),
      fused,
      ...copies[0]!.post,
      ...copies[1]!.post,
      { kind: "assign", localId: counter, value: advance(next), loc },
      { kind: "assign", localId: next, value: advance(counter), loc },
    ],
    loc,
  };
  const tail: IrStmt = {
    kind: "for",
    init: null,
    cond: loop.cond,
    update: loop.update,
    body: loop.body,
    loc,
  };
  return {
    kind: "block",
    body: [init, { kind: "varDecl", localId: next, init: advance(counter), loc }, pair, tail],
    loc,
  };
}
