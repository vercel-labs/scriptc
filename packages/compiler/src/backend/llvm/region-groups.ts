/* Region groups: call sites whose result is a fresh object graph the
 * caller only borrows and then drops, so everything the call allocates
 * can live in an arena that is dropped at once (arenas.ts).
 *
 * The group of a call is every object allocated while it runs. It can be
 * dropped with its result when nothing outside reaches any member once the
 * call returns except through the result. A function is leak-free when
 * every value it allocates (an allocation, a fresh-producing builtin, or
 * the result of a call) dies in its frame, is returned, or is stored into
 * the graph of a value it returns, and every function it calls is
 * leak-free too. Members may refer out of the group (to longer-lived
 * objects, which an arena would release when it drops); nothing outside
 * may refer in. A function is fresh when it is leak-free and returns only
 * values it allocated.
 *
 * A root is a call of a fresh function (or a leak-free construction) whose
 * value, and every reference read out of it, the caller keeps in its frame:
 * deep parameter summaries, where reading a reference out of a parameter
 * makes a value the callee must keep too. Everything is solved
 * optimistically over the call graph and refined to a fixpoint. */
import {
  isRefCounted,
  type IrExpr,
  type IrFunction,
  type IrModule,
  type IrStmt,
  type IrType,
} from "../../ir/ir.js";
import { everyExprChild, everyStmtChild } from "../../ir/traverse.js";
import { boundedNode } from "../may-throw.js";
import {
  ALLOCATIONS,
  FRESH_ARRAY_METHODS,
  argsOf,
  children,
  forEachNode,
  indexOfNode,
  isExpr,
  keepsInFrame,
  same,
  refType,
  transparent,
  type Node,
} from "./region-ir.js";
import { VirtualTargets } from "./reference-effects.js";

/** The module functions a virtual call can run, or null when unknown (or
 * when `node` is no virtual call). */
function virtualTargetsOf(vt: VirtualTargets, node: Node): readonly string[] | null {
  return node.kind === "virtualCall" ? vt.targets(node.className, node.method) : null;
}

export interface RegionGroups {
  /** Fresh call and `new` expressions whose value the caller only borrows. */
  roots: Set<Node>;
  /** Calls of leak-free functions that return no reference: everything
   * they allocate is dead when they return. */
  calls: Set<Node>;
  /** Where each root's arena is dropped: the local whose scope exit drops
   * it, or null for the end of the statement. */
  drops: Map<Node, string | null>;
  /** Functions whose allocations go to the open arena. */
  reachable: Set<string>;
  /** Roots and call regions whose groups are closed: every reference a
   * member holds is to a member or an immortal value (analyzeClosedGroups
   * fills it in). */
  closed: Set<Node>;
  /** The locals that share a root's value in its function (empty for a
   * value used in place), and the function of each root and call region. */
  rootLocals: Map<Node, Set<string>>;
  rootFunction: Map<Node, IrFunction>;
  /** Functions whose results are fresh. */
  fresh: Set<string>;
  /** Functions that keep nothing they allocate except through their result. */
  leakFree: Set<string>;
  /** Functions that allocate, directly or through what they call. */
  allocates: Set<string>;
  /** The calls and fresh copies in a root's function whose value may hold a
   * reference into the root's group: a call that keeps the root's value in
   * its own result (or a reference read out of it, or the value of a local
   * that shares it), and a copy of its elements. The root's proof keeps
   * each of them in the frame; it does not say where their own memory
   * comes from (region-sites.ts decides that). Computed on request. */
  holders: (root: Node) => Set<Node>;
}

/** Projections whose result is a reference read out of the operand.
 * Strings are leaves, not group members: reading one out of a member and
 * keeping it anywhere keeps no member. */
function projection(child: Node, parent: Node | undefined): boolean {
  if (parent === undefined || !isExpr(parent) || !refType(parent.type)) return false;
  switch (parent.kind) {
    case "fieldGet":
    case "recordGet":
    case "recordKeyGet":
      return same(parent.obj, child);
    case "arrayGet":
      return same(parent.arr, child);
    case "unionKeyGet":
      return same(parent.value, child);
    case "mapIntrinsic":
    case "setIntrinsic":
      return (
        same(parent.receiver, child) &&
        (parent.method === "get" || parent.method === "iterKey" || parent.method === "iterValue")
      );
    // A removed element is still one of the array's values.
    case "arrIntrinsic":
      return same(parent.receiver, child) && (parent.method === "pop" || parent.method === "shift");
    default:
      return false;
  }
}

const LOOP_KINDS = new Set(["while", "doWhile", "for", "forOf"]);

/** Collection methods that add their arguments to the receiver. */
const ADDING_METHODS = new Set(["push", "unshift", "set", "add"]);

export const throws = (e: IrExpr): boolean => e.kind === "libCall" && e.fn === "error.nodeThrow";

/** Receiver methods that read a collection or remove from it, and so add
 * nothing to its graph. */
const READ_RECEIVER = new Set([
  "get",
  "has",
  "delete",
  "iterKey",
  "iterValue",
  "size",
  "clear",
  "length",
  "at",
  "includes",
  "indexOf",
  "lastIndexOf",
  "indexEq",
  "getNumber",
  "join",
  "nextPresent",
  "slice",
  "concatSpread",
  "pop",
  "shift",
]);

/** The local a reference is read out of, through casts, checked reads and
 * projections (`l.items[0]` → l), or the local itself. */
function projectionBase(e: IrExpr, through?: (call: IrExpr) => IrExpr | null): string | null {
  let at: IrExpr = e;
  for (let i = 0; i < 64; i++) {
    if (at.kind === "varRef") return at.localId;
    if (at.kind === "call" && through !== undefined) {
      const next = through(at);
      if (next === null) return null;
      at = next;
      continue;
    }
    if (at.kind === "fieldGet" || at.kind === "recordGet" || at.kind === "recordKeyGet")
      at = at.obj;
    else if (at.kind === "arrayGet") at = at.arr;
    else if (at.kind === "unionKeyGet") at = at.value;
    else if (
      (at.kind === "mapIntrinsic" || at.kind === "setIntrinsic") &&
      (at.method === "get" || at.method === "iterKey" || at.method === "iterValue")
    )
      at = at.receiver;
    else if (
      at.kind === "unionNarrow" ||
      at.kind === "upcast" ||
      at.kind === "downcast" ||
      at.kind === "unionWrap" ||
      at.kind === "unionRetype"
    )
      at = at.value;
    else if (at.kind === "ternary" && throws(at.then)) at = at.else_;
    else if (at.kind === "ternary" && throws(at.else_)) at = at.then;
    else return null;
  }
  return null;
}

/** The local whose graph a store into `target` writes (`l.f.items` → l). */
export function storeTarget(target: IrExpr | undefined): string | null {
  let at: IrExpr | undefined = target;
  for (let i = 0; at !== undefined && i < 64; i++) {
    if (at.kind === "varRef") return at.localId;
    if (at.kind === "fieldGet" || at.kind === "recordGet" || at.kind === "recordKeyGet")
      at = at.obj;
    else if (at.kind === "arrayGet") at = at.arr;
    else if (at.kind === "unionNarrow" || at.kind === "upcast" || at.kind === "downcast")
      at = at.value;
    // A checked read (`entry.skus` on `entry | undefined`) throws on one side.
    else if (at.kind === "ternary" && throws(at.then)) at = at.else_;
    else if (at.kind === "ternary" && throws(at.else_)) at = at.then;
    else return null;
  }
  return null;
}

/** How `source` answers for each expression kind:
 * - "allocation": the expression allocates its value (ALLOCATIONS);
 * - "some": some of its nodes produce a value that they or a callee
 *   allocated, and `source` decides which;
 * - "none": `source` does not follow it.
 *
 * Every kind is listed, so a new expression kind does not compile until it
 * is classified here. "none" is no proof that a kind never yields an object
 * of the group: it records the kinds this analysis has not followed so far.
 * What keeps them sound is `calleesClean`, whose default is the safe one:
 * an operation that can run code of the program (anything boundedNode in
 * may-throw.ts does not list) ends leak-freedom, so a "none" kind in a
 * leak-free function yields what the runtime allocated on the heap or what
 * was reachable before. */
export const SOURCE_KINDS: Record<IrExpr["kind"], "allocation" | "some" | "none"> = {
  numLit: "none",
  strLit: "none",
  moduleNsRef: "none",
  boolLit: "none",
  unitLit: "none",
  varRef: "none",
  bin: "none",
  unary: "none",
  incDec: "none",
  fieldIncDec: "none",
  assignExpr: "none",
  toBool: "none",
  logical: "none",
  strConcat: "none",
  strEq: "none",
  strCmp: "none",
  toString: "none",
  ternary: "none",
  nullish: "none",
  orDefault: "none",
  optChain: "none",
  chainRecv: "none",
  strIntrinsic: "some",
  regexLit: "none",
  templateStrings: "none",
  regexIntrinsic: "none",
  arrayLit: "allocation",
  arrayNewLen: "allocation",
  arrayGet: "none",
  arrayHas: "none",
  arrayState: "none",
  constCell: "none",
  arrIntrinsic: "some",
  bytesNew: "none",
  bytesIntrinsic: "none",
  mapNew: "allocation",
  mapIntrinsic: "none",
  setNew: "allocation",
  setIntrinsic: "none",
  call: "some",
  ffiCall: "none",
  closure: "allocation",
  callValue: "some",
  viewOf: "none",
  viewSource: "none",
  selfRef: "none",
  yieldExpr: "none",
  genResume: "none",
  awaitExpr: "none",
  awaitUnionExpr: "none",
  newPromise: "none",
  promiseWithResolvers: "none",
  new: "allocation",
  classRef: "none",
  newValue: "none",
  instanceOfValue: "none",
  upcast: "none",
  promiseVoidWiden: "none",
  downcast: "none",
  instanceOf: "none",
  virtualCall: "some",
  fieldGet: "none",
  recordLit: "allocation",
  recordClone: "allocation",
  recordGet: "none",
  recordKeyGet: "none",
  dynFrom: "none",
  dynCall: "none",
  dynInvoke: "none",
  dynArrLit: "none",
  dynObjLit: "none",
  dynTest: "none",
  dynKeyGet: "none",
  dynHasKey: "none",
  dynScalarEq: "none",
  seqExpr: "none",
  dynDestrCheck: "none",
  dynIterN: "none",
  recordOvfKeys: "none",
  recordOvfHas: "none",
  recordNullProto: "none",
  recordHas: "none",
  fieldAbsent: "none",
  unionWrap: "none",
  unionRetype: "none",
  unionFuncEq: "none",
  caughtTest: "none",
  caughtNarrow: "none",
  caughtCheck: "none",
  caughtToDyn: "none",
  unionNarrow: "none",
  unionDisc: "none",
  unionKeyGet: "none",
  unionIsTag: "none",
  unionEq: "none",
  intrinsic: "none",
  libCall: "some",
  jsonStringify: "none",
  dynCheck: "some",
};

/** An expression that produces a value it allocates (a group member). */
export function source(e: Node): boolean {
  if (!isExpr(e)) return false;
  if (ALLOCATIONS.has(e.kind)) return true;
  if (SOURCE_KINDS[e.kind] === "none") return false;
  if (e.kind === "arrIntrinsic") return FRESH_ARRAY_METHODS.has(e.method);
  if (e.kind === "strIntrinsic") return e.method === "split";
  if (e.kind === "libCall") return e.fn === "json.parse";
  if (e.kind === "dynCheck") return e.value.kind === "libCall" && e.value.fn === "json.parse";
  // A call's reference result may be an object the callee allocated, so
  // the caller answers for where it goes. That holds for a virtual call
  // too: its targets may be fresh, and what they return then lives in the
  // caller's group.
  if (e.kind === "call" || e.kind === "callValue" || e.kind === "virtualCall")
    return refType(e.type);
  return false;
}

/** Store-like uses: the value goes into the graph of `target`'s value. */
export function storeOf(value: Node, parent: Node): IrExpr | undefined {
  switch (parent.kind) {
    case "fieldSet":
    case "recordSet":
    case "recordKeySet":
      return same(parent.value, value) ? parent.obj : undefined;
    case "arraySet":
      return same(parent.value, value) ? parent.arr : undefined;
    case "arrIntrinsic":
      return (parent.method === "push" || parent.method === "unshift") &&
        indexOfNode(parent.args, value) >= 0
        ? parent.receiver
        : undefined;
    case "mapIntrinsic":
      return parent.method === "set" && indexOfNode(parent.args, value) >= 0
        ? parent.receiver
        : undefined;
    case "setIntrinsic":
      return parent.method === "add" && indexOfNode(parent.args, value) >= 0
        ? parent.receiver
        : undefined;
    default:
      return undefined;
  }
}

/** Content positions: the value becomes part of the new value `parent`. */
export function contentOf(value: Node, parent: Node): boolean {
  switch (parent.kind) {
    case "arrayLit":
    case "recordLit":
    case "new":
    case "mapNew":
    case "setNew":
      return !same(parent, value);
    case "recordClone":
      return !same(parent.source, value);
    default:
      return false;
  }
}

/** Whether `parent` is a fresh array holding the elements of `child`, an
 * array of references (`xs.slice()`, `a.concat(b)`, the elements a splice
 * removed), or a fresh collection holding the keys or values of the Map or
 * Set `child` (`new Map(m)`, `new Set(m.values())`, `[...s]`): the elements
 * share the fate of the copy. Strings are leaves, not members. */
function copiesElements(child: Node, parent: Node | undefined): boolean {
  if (parent === undefined || !isExpr(child)) return false;
  if (parent.kind === "mapIntrinsic" || parent.kind === "setIntrinsic") {
    if (!same(parent.receiver, child) || !COLLECTION_COPIES.has(parent.method)) return false;
    const t = child.type;
    if (t.kind === "map") return refType(t.key) || refType(t.value);
    return t.kind === "set" && refType(t.elem);
  }
  if (parent.kind !== "arrIntrinsic") return false;
  if (
    !FRESH_ARRAY_METHODS.has(parent.method) &&
    !SPREAD_METHODS.has(parent.method) &&
    parent.method !== "spliceInsert"
  )
    return false;
  if (
    !same(parent.receiver, child) &&
    !(parent.method === "concatSpread" && indexOfNode(parent.args, child) >= 0)
  )
    return false;
  const t = child.type;
  return t.kind === "array" && refType(t.elem);
}

/** Array intrinsics that copy their array arguments' elements. */
const SPREAD_METHODS = new Set(["pushSpread", "unshiftSpread", "concatSpread"]);

/** Map and Set intrinsics that answer a fresh collection of what the
 * receiver holds. */
const COLLECTION_COPIES = new Set(["clone", "keySet", "valueSet", "toArray"]);

/** What a private array may be the receiver of (privateArrays). */
const PRIVATE_ARRAY_METHODS = new Set(["push", "length", "join"]);

/** The locals of `fn` that hold an array no other code can reach: unboxed
 * locals of the function itself (no parameter, capture or module binding),
 * declared with an empty array literal of strings, numbers or booleans, and mentioned
 * nowhere else in the function except as the receiver of `push`, `length`
 * and `join`. The local is never read as a value, assigned, captured or
 * passed on, so the array has no second reference and no dynamic view.
 *
 * Mentions are counted over the raw node records, whatever their shape, so
 * that a mention this function does not know (a capture list, a new node
 * kind) disqualifies the local instead of being missed. */
type PrivateArrays = Map<IrFunction, ReadonlySet<string>>;
function privateArrays(fn: IrFunction, privateArraysOf: PrivateArrays): ReadonlySet<string> {
  const known = privateArraysOf.get(fn);
  if (known !== undefined) return known;
  // The function's own unboxed locals: a module binding (`%g.…`) is shared
  // with every function, and a boxed local with the closures that capture it.
  const own = new Set<string>();
  for (const local of fn.locals)
    if (local.boxed !== true && !local.id.startsWith("%")) own.add(local.id);
  for (const param of fn.params) own.delete(param.localId);
  for (const capture of fn.captures ?? []) own.delete(capture.localId);
  // The mentions the rule allows, per candidate local.
  const allowed = new Map<string, number>();
  forEachNode(fn.body, (node) => {
    if (node.kind === "varDecl" && own.has(node.localId)) {
      const init = node.init;
      if (
        init !== null &&
        init.kind === "arrayLit" &&
        init.elems.length === 0 &&
        (init.spreads === undefined || init.spreads.length === 0) &&
        init.type.kind === "array" &&
        quietElement(init.type.elem)
      )
        allowed.set(node.localId, (allowed.get(node.localId) ?? 0) + 1);
    }
  });
  if (allowed.size > 0) {
    forEachNode(fn.body, (node, parent) => {
      if (
        node.kind === "varRef" &&
        allowed.has(node.localId) &&
        parent !== undefined &&
        parent.kind === "arrIntrinsic" &&
        same(parent.receiver, node) &&
        PRIVATE_ARRAY_METHODS.has(parent.method)
      )
        allowed.set(node.localId, allowed.get(node.localId)! + 1);
    });
    const mentions = new Map<string, number>();
    const count = (value: unknown): void => {
      if (typeof value === "string") {
        if (allowed.has(value)) mentions.set(value, (mentions.get(value) ?? 0) + 1);
      } else if (Array.isArray(value)) {
        for (const item of value) count(item);
      } else if (value !== null && typeof value === "object") {
        for (const key in value) {
          if (key !== "loc" && key !== "type") count((value as Record<string, unknown>)[key]);
        }
      }
    };
    count(fn.body);
    for (const [id, n] of allowed) if (mentions.get(id) !== n) allowed.delete(id);
  }
  const found: ReadonlySet<string> = new Set(allowed.keys());
  privateArraysOf.set(fn, found);
  return found;
}

/** Element types whose `join` text the runtime writes itself. */
function quietElement(type: IrType): boolean {
  return type.kind === "string" || type.kind === "f64" || type.kind === "bool";
}

/** Operations outside may-throw.ts's bounded list that still cannot run
 * code of the program, for the operand types and receivers named here.
 * This list is the arena analysis's own: the bounded list also promises
 * that an operation cannot block and steers the stack checks, so it is not
 * the place to widen.
 *
 * - `recordOvfKeys` lowers to `scr_map_keys_js_order` (scr_map.c): it
 *   walks the overflow map's entries and retains each key string into a
 *   fresh `string[]`. Keys are strings; nothing is converted or called.
 * - `recordKeyGet` of the overflow map alone with a static result
 *   (keyedRecordReadInto in expr-records.ts): a number or boolean value is
 *   one `scr_map_get_str_f64` / `scr_map_get_str_bool` lookup and a copy;
 *   any other value is a string-keyed entry lookup, a retain of the stored
 *   reference and, for a union result, a wrap of it; a miss stores the
 *   undefined arm or NaN, or traps. Reads that also cover declared fields
 *   and reads with a dynamic result stay unlisted: they pass through
 *   record views and conversions to dynamic values not proven here.
 * - `join` on a private array (privateArrays) of strings, numbers or
 *   booleans with a string separator lowers to `scr_arr_join`
 *   (scr_array.c), which copies string bytes and formats numbers and
 *   booleans itself. Its one path into program code is the string
 *   conversion of a foreign element (SCR_ARR_FOREIGN), and such an element
 *   is only ever stored by `scr_arr_set_foreign`, through a dynamic view of
 *   the array or a stream bridge. A private array has neither: its only
 *   reference is the local, and the local is only a receiver of `push`
 *   (typed elements), `length` and `join`. A `string[]` that came from
 *   anywhere else may hold a foreign element, so `join` on it stays
 *   unlisted. */
function quietOperation(
  node: Node,
  fn: IrFunction | null,
  privateArraysOf: PrivateArrays,
): boolean {
  if (node.kind === "recordOvfKeys") return true;
  if (node.kind === "recordKeyGet") return node.overflowOnly === true && node.type.kind !== "dyn";
  if (node.kind === "arrIntrinsic" && node.method === "join") {
    const receiver = node.receiver;
    return (
      fn !== null &&
      receiver.kind === "varRef" &&
      receiver.type.kind === "array" &&
      quietElement(receiver.type.elem) &&
      node.args.every((a) => a.type.kind === "string") &&
      privateArrays(fn, privateArraysOf).has(receiver.localId)
    );
  }
  return false;
}

/** Array intrinsics that call their function-typed arguments natively. */
const CALLBACK_INTRINSICS = new Set(["sortDense", "sortValues"]);
const callbackArg = (child: Node, parent: Node | undefined): boolean =>
  parent !== undefined &&
  parent.kind === "arrIntrinsic" &&
  CALLBACK_INTRINSICS.has(parent.method) &&
  indexOfNode(parent.args, child) >= 0 &&
  isExpr(child) &&
  child.type.kind === "func";

type Use = "bound" | "kept" | "returned" | "stored" | "content" | "internal" | "thrown" | "escapes";
interface UseInfo {
  bound?: string;
  /** For "internal": the index of the call in `parents`. */
  at?: number;
  target?: string | null;
}

export function analyzeRegionGroups(mod: IrModule): RegionGroups {
  const fns = new Map<string, IrFunction>();
  for (const fn of mod.functions) fns.set(fn.name, fn);
  const vt = new VirtualTargets(mod.classes ?? []);
  const suspends = (fn: IrFunction): boolean => fn.async === true || fn.generator !== undefined;
  /** Whether `node` suspends the frame it runs in anywhere inside it: an
   * await, or a yield from a generator. A closure's body is an IrFunction
   * of its own, not part of `node`. */
  const suspensionSeen = new Map<Node, boolean>();
  const suspendsWithin = (node: Node): boolean => {
    const seen = suspensionSeen.get(node);
    if (seen !== undefined) return seen;
    let found =
      node.kind === "awaitExpr" || node.kind === "awaitUnionExpr" || node.kind === "yieldExpr";
    if (!found) {
      const kids: Node[] = [];
      children(node, kids);
      for (const kid of kids) {
        if (suspendsWithin(kid)) {
          found = true;
          break;
        }
      }
    }
    suspensionSeen.set(node, found);
    return found;
  };
  // Who refers to each function: by calls (direct, virtual, constructions),
  // and by closures too. A function's summaries depend only on those of
  // the functions it refers to, so the fixpoints below revisit just the
  // referrers of a function whose summary changed.
  const callers = new Map<string, Set<string>>();
  const referrers = new Map<string, Set<string>>();
  const directAlloc = new Set<string>();
  for (const fn of mod.functions) {
    const note = (map: Map<string, Set<string>>, name: string): void => {
      let set = map.get(name);
      if (set === undefined) map.set(name, (set = new Set()));
      set.add(fn.name);
    };
    forEachNode(fn.body, (node) => {
      if (node.kind === "call") {
        note(callers, node.callee);
        note(referrers, node.callee);
      } else if (node.kind === "virtualCall")
        for (const t of virtualTargetsOf(vt, node) ?? []) {
          note(callers, t);
          note(referrers, t);
        }
      else if (node.kind === "new") {
        const ctor = `%${node.className}.constructor`;
        note(callers, ctor);
        note(referrers, ctor);
      } else if (node.kind === "closure") note(referrers, node.fnName);
      // A call allocates through its targets (the edges noted above).
      if (source(node) && node.kind !== "call" && node.kind !== "virtualCall")
        directAlloc.add(fn.name);
    });
  }
  /** Runs `step` on the functions named, and again on the referrers of each
   * whose summary it reports changed, until nothing changes. */
  const solve = (
    names: Iterable<string>,
    by: Map<string, Set<string>>,
    step: (fn: IrFunction) => boolean,
  ): void => {
    const queue = [...names];
    const queued = new Set(queue);
    while (queue.length > 0) {
      const name = queue.pop()!;
      queued.delete(name);
      const fn = fns.get(name);
      if (fn === undefined || !step(fn)) continue;
      for (const r of by.get(name) ?? new Set<string>())
        if (!queued.has(r)) {
          queued.add(r);
          queue.push(r);
        }
    }
  };

  // Deep summaries.
  const deep = new Map<string, Set<number>>();
  // Internal parameters: ones a leak-free function only borrows, returns, or
  // stores into the graphs of values it allocates (so an argument a caller
  // allocated stays inside the caller's group). Optimistic, refined below.
  const internal = new Map<string, Set<number>>();
  // Callback parameters (see below), and the function being analyzed.
  const callbacks = new Map<string, Set<number>>();
  let current: IrFunction | null = null;
  // Each function's private arrays (see privateArrays), found once per
  // analysis: the analysis owns the cache, not a weak collection.
  const privateArraysOf: PrivateArrays = new Map();
  // While finding roots: a value passed to the function's own callback
  // parameter leaves the frame (its callers' callbacks are unknown here).
  let framePass = false;
  const keeps = (child: Node, parent: Node | undefined): boolean => {
    if (parent?.kind === "virtualCall") {
      const index = indexOfNode(parent.args, child);
      const targets = virtualTargetsOf(vt, parent);
      return (
        index >= 0 &&
        targets !== null &&
        targets.length > 0 &&
        targets.every((t) => deep.get(t)?.has(index) === true)
      );
    }
    // A spread copies the array's elements into another array: they
    // escape with it.
    if (
      parent?.kind === "arrIntrinsic" &&
      SPREAD_METHODS.has(parent.method) &&
      !same(parent.receiver, child) &&
      isExpr(child)
    ) {
      const t = child.type;
      return t.kind !== "array" || !refType(t.elem);
    }
    if (callbackArg(child, parent)) return true;
    if (parent?.kind === "jsonStringify") return true;
    // Comparisons only read their operands.
    if (parent?.kind === "strCmp" || parent?.kind === "strEq") return true;
    if (parent?.kind === "bin" && !refType(parent.type)) return true;
    return keepsInFrame(child, parent, deep);
  };

  /** How the value of `node` (`parents` its ancestors) is used, after the
   * expressions that pass it on (and, with `projections`, the reads of a
   * reference out of it). A reference read out of a value is one of the
   * values its group holds, so where it goes counts as a use of the value:
   * only the rule for a root bound to a local asks without `projections`,
   * because that local must hold the root's own value. */
  const useOf = (node: Node, parents: readonly Node[], projections: boolean, out: UseInfo): Use => {
    let value: Node = node;
    let at = parents.length - 1;
    while (
      at >= 0 &&
      (transparent(value, parents[at]) ||
        copiesElements(value, parents[at]) ||
        (projections && projection(value, parents[at])))
    )
      value = parents[at--]!;
    const p = at >= 0 ? parents[at] : undefined;
    if (p === undefined) return "escapes";
    if (
      (p.kind === "varDecl" && p.init !== null && same(p.init, value)) ||
      (p.kind === "assign" && same(p.value, value))
    ) {
      out.bound = p.localId;
      return "bound";
    }
    if (p.kind === "return") return "returned";
    if (p.kind === "throw") return "thrown";
    if (p.kind === "exprStmt") return "kept";
    const target = storeOf(value, p);
    if (target !== undefined) {
      out.target = storeTarget(target);
      return "stored";
    }
    if (contentOf(value, p)) return "content";
    if (keeps(value, p)) return "kept";
    if (p.kind === "callValue" && current !== null && !framePass) {
      const i = indexOfNode(p.args, value) >= 0 ? paramIndex(current, p.callee) : -1;
      if (i >= 0 && callbacks.get(current.name)!.has(i)) return "kept";
    }
    if (p.kind === "call") {
      const c = p;
      const i = indexOfNode(c.args, value);
      // The callee may hand the value to the callbacks it is passed, which
      // must keep it too.
      if (
        i >= 0 &&
        internal.get(c.callee)?.has(i) === true &&
        [...(callbacks.get(c.callee) ?? new Set<number>())].every((j) => callbackClean(c.args[j]))
      ) {
        out.at = at;
        return "internal";
      }
    }
    return "escapes";
  };

  /** How the result of the call at `parents[at]` is used, through calls
   * that keep it in their own results (`report(select(load()))`), and with
   * `projections` through the reads of a reference out of it. */
  const resultUse = (
    at: number,
    parents: readonly Node[],
    projections: boolean,
    out: UseInfo,
  ): Use => {
    let index = at;
    for (let i = 0; i < 64; i++) {
      const info: UseInfo = {};
      const use = useOf(parents[index]!, parents.slice(0, index), projections, info);
      if (use !== "internal") {
        // Field by field: an Object.assign onto a record makes the
        // self-hosted compiler read class and record properties dynamically.
        if (info.bound !== undefined) out.bound = info.bound;
        if (info.at !== undefined) out.at = info.at;
        if (info.target !== undefined) out.target = info.target;
        return use;
      }
      index = info.at!;
    }
    return "escapes";
  };
  /** `fn`'s body in preorder, with each node's parent (-1 for statements
   * of the body), the uses of locals that can hold references, and the
   * sources: walked once, for escapingLocals' many passes. */
  interface Flat {
    nodes: Node[];
    parent: number[];
    refs: number[];
    sources: number[];
  }
  const flats = new Map<string, Flat>();
  const flatOf = (fn: IrFunction): Flat => {
    let flat = flats.get(fn.name);
    if (flat !== undefined) return flat;
    flat = { nodes: [], parent: [], refs: [], sources: [] };
    const f = flat;
    // Parents come before their children, so each node's parent is indexed.
    const index = new Map<Node, number>();
    forEachNode(fn.body, (node, parent) => {
      const i = f.nodes.length;
      index.set(node, i);
      f.nodes.push(node);
      f.parent.push(parent === undefined ? -1 : index.get(parent)!);
      if (source(node)) f.sources.push(i);
      if (node.kind === "varRef" && (refType(node.type) || node.type.kind === "string"))
        f.refs.push(i);
    });
    flats.set(fn.name, flat);
    return flat;
  };
  /** The ancestors of node `i` of `flat`, outermost first, into `out`. */
  const ancestors = (flat: Flat, i: number, out: Node[]): Node[] => {
    out.length = 0;
    for (let p = flat.parent[i]!; p >= 0; p = flat.parent[p]!) out.push(flat.nodes[p]!);
    out.reverse();
    return out;
  };
  /** Locals of `fn` whose value (or a reference read out of it) escapes.
   * With `members` (the locals bound to group members), a value may also be
   * returned, be content of a new value, or be stored into a member's
   * graph. */
  const escapingLocals = (
    fn: IrFunction,
    members: Set<string> | null,
    classes?: Map<string, string>,
  ): Set<string> => {
    const out = new Set<string>();
    const add = (id: string): void => {
      out.add(id);
    };
    const own = new Set(fn.locals.map((l) => l.id));
    const group = new Map<string, string>();
    const find = (id: string): string => {
      let r = id;
      while (group.has(r) && group.get(r) !== r) r = group.get(r)!;
      return r;
    };
    const unite = (a: string, b: string): void => {
      const ra = find(a),
        rb = find(b);
      if (ra !== rb) group.set(ra, rb);
    };
    // Copies: locals bound to a local or to a fresh copy of one (`slice`).
    // A store of a value read out of a copy into the graph of another copy
    // adds no reference into the group, unless a member went into a copy.
    const copy = new Map<string, string>();
    const findCopy = (id: string): string => {
      let r = id;
      while (copy.has(r) && copy.get(r) !== r) r = copy.get(r)!;
      return r;
    };
    const uniteCopy = (a: string, b: string): void => {
      const ra = findCopy(a),
        rb = findCopy(b);
      if (ra !== rb) copy.set(ra, rb);
    };
    const filled = new Set<string>();
    const selfStores: [string, string][] = [];
    const flat = flatOf(fn);
    const parents: Node[] = [];
    if (members !== null)
      for (const i of flat.sources) {
        const node = flat.nodes[i]!;
        ancestors(flat, i, parents);
        // A copy class holds something new once a value it did not have
        // goes into it: stored into its graph, or bound to one of its locals
        // (`visited = new Map(); this.visited = visited`). A `slice` of a
        // local in the class holds only what the class held.
        const info: UseInfo = {};
        const use = useOf(node, parents, true, info);
        if (use === "stored" && info.target) filled.add(info.target);
        if (use === "bound" && !(node.kind === "arrIntrinsic" && node.method === "slice"))
          filled.add(info.bound!);
      }
    // Uses of locals that can hold references (a value without references
    // cannot keep a member).
    for (const i of flat.refs) {
      const node = flat.nodes[i]!;
      if (node.kind !== "varRef") continue;
      ancestors(flat, i, parents);
      const id = node.localId;
      const info: UseInfo = {};
      const use = useOf(node, parents, true, info);
      if (use === "bound") {
        if (own.has(info.bound!)) {
          unite(id, info.bound!);
          uniteCopy(id, info.bound!);
        } else add(id);
      } else if (use === "internal" && members === null) {
        // The callee keeps the value only in its result: the value stays
        // in this frame while the result does (a module global needs no
        // frame to hold it).
        const result: UseInfo = {};
        const r = resultUse(info.at!, parents, true, result);
        if (r === "bound" && own.has(result.bound!)) {
          if (own.has(id)) unite(id, result.bound!);
        } else if (r !== "kept") add(id);
      } else if (use === "thrown") {
        // A thrown value leaves the frame and outlives the group.
        add(id);
      } else if (use === "returned" || use === "content" || use === "internal") {
        if (members === null) add(id);
      } else if (use === "stored") {
        if (members?.has(id) && info.target) filled.add(info.target);
        if (
          members !== null &&
          info.target !== null &&
          info.target !== undefined &&
          !members.has(info.target) &&
          own.has(info.target)
        )
          selfStores.push([id, info.target]);
        else if (
          members === null ||
          info.target === null ||
          info.target === undefined ||
          !members.has(info.target)
        )
          add(id);
      } else if (use === "escapes") add(id);
      // `const copy = id.slice()`.
      // An optional chain on a Node, or a field read in the same condition
      // as its kind test, tests every Node kind in turn: the kind is read
      // after an undefined check, and the fields in a statement of their own.
      const p = parents[parents.length - 1];
      if (members !== null && p !== undefined && p.kind === "arrIntrinsic") {
        if (same(p.receiver, node) && p.method === "slice") {
          const copied: UseInfo = {};
          if (useOf(p, parents.slice(0, -1), false, copied) === "bound" && own.has(copied.bound!))
            uniteCopy(id, copied.bound!);
        }
      }
    }
    const filledCopies = new Set([...filled].map(findCopy));
    for (const [id, target] of selfStores)
      if (findCopy(id) !== findCopy(target) || filledCopies.has(findCopy(id))) add(id);
    for (const local of fn.locals) if (local.boxed === true) out.add(local.id);
    const roots = new Set<string>();
    for (const id of out) roots.add(find(id));
    for (const local of fn.locals) if (roots.has(find(local.id))) out.add(local.id);
    if (classes !== undefined) for (const local of fn.locals) classes.set(local.id, find(local.id));
    return out;
  };

  const solveDeep = (): void => {
    for (const fn of mod.functions) {
      const safe = new Set<number>();
      if (!suspends(fn))
        fn.params.forEach((param, i) => {
          const local = fn.locals.find((l) => l.id === param.localId);
          if ((refType(param.type) || param.type.kind === "string") && local?.boxed !== true)
            safe.add(i);
        });
      deep.set(fn.name, safe);
    }
    solve(fns.keys(), referrers, (fn) => {
      const safe = deep.get(fn.name)!;
      if (safe.size === 0) return false;
      const esc = escapingLocals(fn, null);
      let changed = false;
      fn.params.forEach((param, i) => {
        if (safe.has(i) && esc.has(param.localId)) {
          safe.delete(i);
          changed = true;
        }
      });
      return changed;
    });
  };
  solveDeep();

  // Leak-free and fresh functions, optimistic.
  const leakFree = new Set<string>();
  const fresh = new Set<string>();
  for (const fn of mod.functions) {
    if (suspends(fn)) continue;
    leakFree.add(fn.name);
    if (refType(fn.returnType)) fresh.add(fn.name);
    const inner = new Set<number>();
    fn.params.forEach((param, i) => {
      const local = fn.locals.find((l) => l.id === param.localId);
      if ((refType(param.type) || param.type.kind === "string") && local?.boxed !== true)
        inner.add(i);
    });
    internal.set(fn.name, inner);
  }
  let internalChanged = false;
  const unwrap = (e: Node): Node => {
    let at: Node = e;
    for (let i = 0; i < 16; i++) {
      if (
        at.kind === "unionWrap" ||
        at.kind === "upcast" ||
        at.kind === "downcast" ||
        at.kind === "unionRetype"
      )
        at = at.value;
      else break;
    }
    return at;
  };
  // Callback parameters: parameters a function calls (or passes on to a
  // callback parameter). Each argument for one must be a leak-free closure,
  // or a callback parameter of the caller.
  const reassignedMemo = new Map<string, Set<string>>();
  const reassignedIn = (fn: IrFunction): Set<string> => {
    let out = reassignedMemo.get(fn.name);
    if (out !== undefined) return out;
    out = new Set<string>();
    for (const node of flatOf(fn).nodes) if (node.kind === "assign") out.add(node.localId);
    for (const l of fn.locals) if (l.boxed === true) out.add(l.id);
    reassignedMemo.set(fn.name, out);
    return out;
  };
  const paramIndex = (fn: IrFunction, e: Node): number => {
    const u = unwrap(e);
    if (u.kind !== "varRef") return -1;
    const id = u.localId;
    if (reassignedIn(fn).has(id)) return -1;
    return fn.params.findIndex((p) => p.localId === id);
  };
  for (const fn of mod.functions) callbacks.set(fn.name, new Set());
  solve(fns.keys(), callers, (fn) => {
    const set = callbacks.get(fn.name)!;
    const before = set.size;
    for (const node of flatOf(fn).nodes) {
      if (node.kind === "callValue") {
        const i = paramIndex(fn, node.callee);
        if (i >= 0) set.add(i);
      } else if (node.kind === "arrIntrinsic" && CALLBACK_INTRINSICS.has(node.method)) {
        for (const a of node.args)
          if (a.type.kind === "func") {
            const i = paramIndex(fn, a);
            if (i >= 0) set.add(i);
          }
      } else if (node.kind === "call") {
        for (const j of callbacks.get(node.callee) ?? new Set<number>()) {
          const arg = node.args[j];
          const i = arg === undefined ? -1 : paramIndex(fn, arg);
          if (i >= 0) set.add(i);
        }
      }
    }
    return set.size !== before;
  });
  const callbackClean = (arg: IrExpr | undefined): boolean => {
    if (arg === undefined) return true;
    const u = unwrap(arg);
    if (u.kind === "closure") {
      // The callee passes the callback values it borrows (or that came from
      // its caller): its parameters must stay internal.
      const name = u.fnName;
      const target = fns.get(name);
      if (target === undefined || !leakFree.has(name)) return false;
      const inner = internal.get(name)!;
      return target.params.every((p, i) => !refType(p.type) || inner.has(i));
    }
    if (current === null || framePass) return false;
    const i = paramIndex(current, u);
    return i >= 0 && callbacks.get(current.name)!.has(i);
  };
  const calleesClean = (node: Node): boolean => {
    if (node.kind === "call") {
      if (!leakFree.has(node.callee)) return false;
      for (const j of callbacks.get(node.callee) ?? new Set<number>())
        if (!callbackClean(node.args[j])) return false;
      return true;
    }
    if (node.kind === "callValue" && current !== null) {
      const i = paramIndex(current, node.callee);
      return i >= 0 && callbacks.get(current.name)!.has(i);
    }
    if (node.kind === "arrIntrinsic" && CALLBACK_INTRINSICS.has(node.method))
      return node.args.every((a) => a.type.kind !== "func" || callbackClean(a));
    if (node.kind === "virtualCall") {
      const t = virtualTargetsOf(vt, node);
      return t !== null && t.length > 0 && t.every((x) => leakFree.has(x));
    }
    if (
      node.kind === "callValue" ||
      node.kind === "newValue" ||
      node.kind === "dynCall" ||
      node.kind === "dynInvoke"
    )
      return false;
    if (node.kind === "new") return leakFree.has(`%${node.className}.constructor`);
    // Resuming a generator (`for...of`, `next()`, a spread, `yield*`) runs
    // its body with the arena of the function that drives it as the
    // allocation target, and no edge the analysis follows leads there: what
    // the body keeps past the resumption would be dropped with the arena.
    if (node.kind === "genResume") return false;
    // `JSON.parse(text)` and the checked cast of its value are sources the
    // analysis follows itself, and neither runs code of the program: a
    // reviver is a library call of its own, and a checked cast admits plain
    // data only.
    if (node.kind === "dynCheck" || (node.kind === "libCall" && node.fn === "json.parse"))
      return true;
    // Every other operation is clean only when it cannot run code of the
    // program. An emitter's listeners, a Promise executor, a replacer, a
    // `toJSON` or a `toString` the runtime calls run with this function's
    // arena as the allocation target, like a generator's body, and what
    // they keep would be dropped with it.
    return boundedNode(node) || quietOperation(node, current, privateArraysOf);
  };
  /** The values `e` can produce, through casts and conditionals. */
  const leaves = (e: Node, out: Node[] = []): Node[] => {
    const u = unwrap(e);
    if (u.kind === "ternary") {
      // A side that throws produces no value.
      if (!throws(u.then)) leaves(u.then, out);
      if (!throws(u.else_)) leaves(u.else_, out);
    } else out.push(u);
    return out;
  };
  /** A source whose value is a new group member (a call result only when
   * the callee is fresh). */
  const memberSource = (u: Node): boolean =>
    source(u) &&
    u.kind !== "callValue" &&
    u.kind !== "virtualCall" &&
    (u.kind !== "call" || fresh.has(u.callee));
  /** What analyze reads of `fn` that no summary changes: the values bound
   * to each local, the stores into locals' graphs, and the locals that are
   * not closed (see analyze). */
  const bodyFacts = new Map<
    string,
    { bindings: Map<string, Node[]>; stores: [string, Node][]; open: Set<string> }
  >();
  const factsOf = (
    fn: IrFunction,
  ): { bindings: Map<string, Node[]>; stores: [string, Node][]; open: Set<string> } => {
    const memo = bodyFacts.get(fn.name);
    if (memo !== undefined) return memo;
    const bindings = new Map<string, Node[]>();
    const scan = (node: Node): void => {
      if (node.kind === "varDecl" || node.kind === "assign") {
        const v = node.kind === "varDecl" ? node.init : node.value;
        if (v !== null) bindings.set(node.localId, [...(bindings.get(node.localId) ?? []), v]);
      }
      const kids: Node[] = [];
      children(node, kids);
      for (const k of kids) scan(k);
    };
    for (const s of fn.body) scan(s);
    const stores: [string, Node][] = [];
    const open = new Set<string>();
    {
      const parents: Node[] = [];
      const walk = (node: Node): void => {
        const parent = parents[parents.length - 1];
        if (parent !== undefined) {
          const t = storeOf(node, parent);
          if (t !== undefined) {
            const target = storeTarget(t);
            if (target !== null) stores.push([target, node]);
          }
        }
        if (node.kind === "varRef") {
          const id = node.localId;
          let value: Node = node;
          let at = parents.length - 1;
          while (at >= 0 && (transparent(value, parents[at]) || projection(value, parents[at])))
            value = parents[at--]!;
          const p = parents[at];
          if (p !== undefined && isExpr(p)) {
            const x = p;
            if (
              x.kind === "call" ||
              x.kind === "virtualCall" ||
              x.kind === "callValue" ||
              x.kind === "new" ||
              x.kind === "newValue" ||
              x.kind === "dynCall" ||
              x.kind === "dynInvoke" ||
              x.kind === "libCall"
            )
              open.add(id);
            else if (
              (x.kind === "arrIntrinsic" ||
                x.kind === "mapIntrinsic" ||
                x.kind === "setIntrinsic") &&
              same(x.receiver, value) &&
              !READ_RECEIVER.has(x.method) &&
              !x.method.startsWith("iter") &&
              storeOf(x.args[0] ?? x, x) === undefined
            )
              open.add(id);
          }
        }
        const kids: Node[] = [];
        children(node, kids);
        parents.push(node);
        for (const kid of kids) walk(kid);
        parents.pop();
      };
      for (const st of fn.body) walk(st);
    }
    const facts = { bindings, stores, open };
    bodyFacts.set(fn.name, facts);
    return facts;
  };
  const analyze = (fn: IrFunction): { leakFree: boolean; fresh: boolean } => {
    current = fn;
    // Member locals: bound only to sources, other members, or non-references.
    const members = new Set<string>(fn.locals.filter((l) => l.boxed !== true).map((l) => l.id));
    for (const p of fn.params) members.delete(p.localId);
    // A constructor's `this` is the object its `new` allocated.
    const ctor = fn.name.endsWith(".constructor") && fn.params.length > 0;
    const thisId = ctor ? fn.params[0]!.localId : null;
    // Closed members: members whose graph holds only members and leaves
    // (values without a graph: numbers, strings). A reference read out of a
    // closed member is a member too. A local is not closed when it is passed
    // to a call (which may store into its graph) or used as the receiver of
    // a method that adds what this analysis does not see.
    const { bindings, stores, open } = factsOf(fn);
    const closed = new Set<string>([...members].filter((id) => !open.has(id) && id !== thisId));
    const leaf = (u: Node): boolean => isExpr(u) && !refType(u.type);
    const closedSource = (u: Node): boolean => {
      if (u.kind === "libCall") return u.fn === "json.parse";
      if (u.kind === "dynCheck") return closedSource(u.value);
      if (u.kind === "strIntrinsic") return u.method === "split";
      if (
        u.kind !== "arrayLit" &&
        u.kind !== "recordLit" &&
        u.kind !== "mapNew" &&
        u.kind !== "setNew"
      )
        return false;
      const kids: Node[] = [];
      children(u, kids);
      return kids.every((k) => !isExpr(k) || closedValue(k));
    };
    const closedValue = (v: Node): boolean =>
      leaves(v).every((u) => {
        if (leaf(u) || closedSource(u)) return true;
        const base = isExpr(u) ? projectionBase(u) : null;
        return base !== null && closed.has(base);
      });
    for (let again = true; again;) {
      again = false;
      for (const id of [...members]) {
        const list = bindings.get(id) ?? [];
        if (id === thisId) continue;
        const ok =
          list.length > 0 &&
          list.every((v) =>
            leaves(v).every((u) => {
              if (memberSource(u) || leaf(u)) return true;
              if (u.kind === "varRef") return members.has(u.localId);
              const base = isExpr(u) ? projectionBase(u) : null;
              return base !== null && closed.has(base);
            }),
          );
        if (!ok) {
          members.delete(id);
          closed.delete(id);
          again = true;
        }
      }
      for (const id of [...closed]) {
        const ok =
          members.has(id) &&
          (bindings.get(id) ?? []).every(closedValue) &&
          stores.every(([target, value]) => target !== id || closedValue(value));
        if (!ok) {
          closed.delete(id);
          again = true;
        }
      }
      // A local bound to a reference read out of another shares its graph.
      for (const [id, list] of bindings)
        if (!closed.has(id))
          for (const v of list)
            for (const u of leaves(v)) {
              const base = isExpr(u) ? projectionBase(u) : null;
              if (base !== null && base !== id && closed.delete(base)) again = true;
            }
    }
    if (thisId !== null) members.add(thisId);
    // Members that escape (other than by return or into a member's graph)
    // are no longer members; repeat, since a store into a former member's
    // graph now escapes too.
    let esc = escapingLocals(fn, members);
    for (let again = true; again;) {
      again = false;
      for (const id of esc) if (members.delete(id)) again = true;
      if (again) esc = escapingLocals(fn, members);
    }
    // Every source must die, be returned, or go into a member's graph; a
    // constructor's `this` must stay a member.
    const inner = internal.get(fn.name)!;
    fn.params.forEach((param, i) => {
      if (inner.has(i) && esc.has(param.localId)) {
        inner.delete(i);
        internalChanged = true;
      }
    });
    let clean = thisId === null || members.has(thisId);
    let returnsFresh = true;
    const parents: Node[] = [];
    const walk = (node: Node): void => {
      if (!calleesClean(node)) clean = false;
      if (source(node)) {
        const info: UseInfo = {};
        const use = useOf(node, parents, true, info);
        if (use === "bound") {
          if (esc.has(info.bound!) || !fn.locals.some((l) => l.id === info.bound)) {
            clean = false;
          }
        } else if (use === "stored") {
          if (info.target === null || info.target === undefined || !members.has(info.target)) {
            clean = false;
          }
        } else if (use === "escapes") {
          clean = false;
        } else if (use === "thrown") {
          // A thrown value outlives the group, so it may hold no member and
          // nothing allocated with it (a message string is fine).
          const kids: Node[] = [];
          children(node, kids);
          for (const k of kids)
            if (
              isExpr(k) &&
              refType(k.type) &&
              leaves(k).some((u) => {
                if (source(u)) return true;
                const base = isExpr(u) ? projectionBase(u) : null;
                return base !== null && members.has(base);
              })
            )
              clean = false;
        }
      }
      if (node.kind === "return") {
        const v = node.value;
        if (v !== null && refType(v.type)) {
          for (const u of leaves(v)) {
            if (!(memberSource(u) || (u.kind === "varRef" && members.has(u.localId))))
              returnsFresh = false;
            if (u.kind === "call" && !fresh.has(u.callee)) returnsFresh = false;
          }
        }
      }
      const kids: Node[] = [];
      children(node, kids);
      parents.push(node);
      for (const kid of kids) walk(kid);
      parents.pop();
    };
    for (const s of fn.body) walk(s);
    current = null;
    return { leakFree: clean, fresh: clean && returnsFresh };
  };
  solve(leakFree, referrers, (fn) => {
    if (!leakFree.has(fn.name)) return false;
    internalChanged = false;
    const r = analyze(fn);
    if (!r.leakFree) {
      leakFree.delete(fn.name);
      fresh.delete(fn.name);
      internal.get(fn.name)!.clear();
      return true;
    }
    return (!r.fresh && fresh.delete(fn.name)) || internalChanged;
  });

  // With internal parameters known, a value passed to one stays in the
  // frame while the call's result does: solve the deep summaries again.
  solveDeep();
  // Functions that allocate, directly or through what they call.
  const allocates = new Set<string>();
  solve(directAlloc, callers, (fn) => {
    if (allocates.has(fn.name)) return false;
    allocates.add(fn.name);
    return true;
  });
  // Roots, and call regions: calls of leak-free functions that allocate and
  // return no reference, so all they allocate is dead when they return.
  const roots = new Set<Node>();
  const calls = new Set<Node>();
  /** Whether the operands of `node` (evaluated inside its group) are clean:
   * every call in them is leak-free, no library call returns a reference
   * (the runtime may keep it: `process.argv`'s cached array), and every value they
   * allocate goes to `node` as an internal or borrowed argument, or into the
   * value of another operand. */
  const operandsClean = (node: Node, parents: readonly Node[]): boolean => {
    const stack: Node[] = [...parents, node];
    let ok = true;
    const visit = (n: Node): void => {
      if (!ok) return;
      if (!same(n, node)) {
        if (!calleesClean(n)) ok = false;
        if (n.kind === "libCall" && n.fn !== "json.parse" && refType(n.type)) ok = false;
        // `JSON.parse(text) as T`: the parse is the checked value itself.
        const checked = node.kind === "dynCheck" && same(node.value, n);
        if (source(n) && !checked) {
          const info: UseInfo = {};
          const use = useOf(n, stack, true, info);
          const at = info.at ?? -1;
          if (
            !(use === "kept" || use === "content" || (use === "internal" && at >= parents.length))
          )
            ok = false;
        }
      }
      const kids: Node[] = [];
      children(n, kids);
      const inner = !same(n, node);
      if (inner) stack.push(n);
      for (const k of kids) visit(k);
      if (inner) stack.pop();
    };
    visit(node);
    return ok;
  };
  /** Whether the value of `node` is, where it is made (or handed back by a
   * call that keeps it in its result), the array or collection a method
   * stores a reference into. */
  const storesInPlace = (node: Node, parents: readonly Node[]): boolean => {
    let value: Node = node;
    for (let at = parents.length - 1; at >= 0; at--) {
      const p = parents[at]!;
      if (
        (p.kind === "arrIntrinsic" || p.kind === "mapIntrinsic" || p.kind === "setIntrinsic") &&
        same(p.receiver, value) &&
        (ADDING_METHODS.has(p.method) || p.method === "spliceInsert" || p.method === "fill") &&
        p.args.some((arg) => refType(arg.type))
      )
        return true;
      const handedBack =
        p.kind === "call" && internal.get(p.callee)?.has(indexOfNode(p.args, value)) === true;
      if (!transparent(value, p) && !handedBack) return false;
      value = p;
    }
    return false;
  };
  const drops = new Map<Node, string | null>();
  const rootLocals = new Map<Node, Set<string>>();
  const rootFunction = new Map<Node, IrFunction>();
  framePass = true;
  for (const fn of mod.functions) {
    const suspending = suspends(fn);
    current = fn;
    const classes = new Map<string, string>();
    const esc = escapingLocals(fn, null, classes);
    const own = new Set(fn.locals.map((l) => l.id));
    const paths = declarationPaths(fn);
    /** The local of `bound`'s class whose scope holds every other one's,
     * or undefined when no one does. */
    const classOf = (bound: string): string[] => {
      const cls = classes.get(bound);
      return fn.locals.filter((l) => classes.get(l.id) === cls).map((l) => l.id);
    };
    const dropLocal = (bound: string): string | undefined => {
      const members = classOf(bound);
      const path = (id: string): readonly number[] => paths.get(id) ?? [];
      return members.find((m) =>
        members.every((o) => {
          const a = path(m);
          const b = path(o);
          return a.length <= b.length && a.every((x, i) => b[i] === x);
        }),
      );
    };
    const parents: Node[] = [];
    /** Whether no statement around `chain`'s node suspends. An arena opened
     * for a value used in place is dropped at the end of its statement, and
     * an await or a yield parks the frame with the arena still the thread's
     * allocation target: a suspending function keeps a root or a call
     * region only where no enclosing statement suspends, and keeps no root
     * whose value outlives the statement. */
    const statementSync = (chain: readonly Node[]): boolean => {
      if (!suspending) return true;
      for (const at of chain) if (!isExpr(at) && suspendsWithin(at)) return false;
      return true;
    };
    const walk = (node: Node): void => {
      const isRoot =
        isExpr(node) &&
        ((node.kind === "call" && fresh.has(node.callee)) ||
          (node.kind === "new" && leakFree.has(`%${node.className}.constructor`)) ||
          ((node.kind === "libCall" || node.kind === "dynCheck" || node.kind === "strIntrinsic") &&
            source(node)) ||
          (node.kind === "arrIntrinsic" && source(node)));
      const callbacksClean =
        node.kind !== "call" ||
        [...(callbacks.get(node.callee) ?? new Set<number>())].every((j) =>
          callbackClean(node.args[j]),
        );
      const clean =
        (isRoot || node.kind === "call") && callbacksClean && operandsClean(node, parents);
      if (
        node.kind === "call" &&
        clean &&
        statementSync(parents) &&
        !refType(node.type) &&
        // A constructor (a `super(...)` call) stores into `this`, which its
        // caller holds: it is leak-free only as part of a `new`.
        !node.callee.endsWith(".constructor") &&
        leakFree.has(node.callee) &&
        allocates.has(node.callee)
      ) {
        calls.add(node);
        rootFunction.set(node, fn);
      }
      if (isRoot && clean) {
        const info: UseInfo = {};
        let use = useOf(node, parents, false, info);
        if (use === "internal") use = resultUse(info.at!, parents, false, info);
        // A value used in place is dropped at the end of its statement, and
        // the references read out of it with it (`new Slot(rows()).held`,
        // `rows()[1]`): each must be kept in the statement too.
        if (use === "kept") {
          const reads: UseInfo = {};
          let read = useOf(node, parents, true, reads);
          if (read === "internal") read = resultUse(reads.at!, parents, true, reads);
          if (read !== "kept") use = "escapes";
        }
        // A reference stored into the value where it is made
        // (`rows().push(row)`, `rows().splice(1, 2, row)`) is held by a
        // group no local names: nothing would release it with the arena.
        if (storesInPlace(node, parents)) use = "escapes";
        rootFunction.set(node, fn);
        if (use === "kept" && statementSync(parents)) {
          roots.add(node);
          drops.set(node, null);
          rootLocals.set(node, new Set());
        } else if (
          use === "bound" &&
          !suspending &&
          own.has(info.bound!) &&
          !esc.has(info.bound!)
        ) {
          const local = dropLocal(info.bound!);
          // An assignment in a loop would add a group per iteration to a
          // list that is dropped only when the local's scope exits.
          let binding = parents.length - 1;
          while (
            binding >= 0 &&
            parents[binding]!.kind !== "varDecl" &&
            parents[binding]!.kind !== "assign"
          )
            binding--;
          const reassignedInLoop =
            binding >= 0 &&
            parents[binding]!.kind === "assign" &&
            parents.slice(0, binding).some((p) => LOOP_KINDS.has(p.kind));
          if (local !== undefined && !reassignedInLoop) {
            roots.add(node);
            drops.set(node, local);
            rootLocals.set(node, new Set(classOf(info.bound!)));
          }
        }
      }
      const kids: Node[] = [];
      children(node, kids);
      parents.push(node);
      for (const kid of kids) walk(kid);
      parents.pop();
    };
    for (const s of fn.body) walk(s);
  }
  current = null;
  // Functions that run inside an arena: what roots and call regions call,
  // and what those call, with the closures they pass.
  const reachable = new Set<string>();
  const queue: string[] = [];
  const reach = (name: string): void => {
    if (fns.has(name) && !reachable.has(name)) {
      reachable.add(name);
      queue.push(name);
    }
  };
  const callees = (node: Node): void => {
    if (node.kind === "call") reach(node.callee);
    else if (node.kind === "virtualCall")
      for (const t of virtualTargetsOf(vt, node) ?? []) reach(t);
    else if (node.kind === "new") reach(`%${node.className}.constructor`);
    else if (node.kind === "closure") reach(node.fnName);
  };
  const scanAll = (node: Node, visit: (n: Node) => void): void => {
    visit(node);
    const kids: Node[] = [];
    children(node, kids);
    for (const k of kids) scanAll(k, visit);
  };
  for (const r of [...roots, ...calls]) scanAll(r, callees);
  while (queue.length > 0) {
    const fn = fns.get(queue.pop()!)!;
    for (const st of fn.body) scanAll(st, callees);
  }
  const closed = new Set<Node>();
  /** Adds to `out` what holds the value of `node` on its way up `parents`,
   * followed the way useOf and resultUse follow it: through the expressions
   * that pass it on and the reads of a reference out of it, into each copy
   * of its elements and into the result of each call that keeps it. */
  const holdersAbove = (node: Node, parents: readonly Node[], out: Set<Node>): void => {
    let value: Node = node;
    let at = parents.length - 1;
    for (let hops = 0; hops < 64; hops++) {
      for (; at >= 0; at--) {
        const p = parents[at]!;
        if (copiesElements(value, p)) out.add(p);
        else if (!transparent(value, p) && !projection(value, p)) break;
        value = p;
      }
      const p = at >= 0 ? parents[at]! : undefined;
      // A callee that only borrows the value keeps nothing of it.
      if (p === undefined || p.kind !== "call" || keeps(value, p)) return;
      if (internal.get(p.callee)?.has(indexOfNode(p.args, value)) !== true) return;
      out.add(p);
      value = p;
      at--;
    }
  };
  // Per function, walked once however many roots it has: where each source
  // is, and what holds the value read from each local.
  const holderFacts = new Map<
    string,
    { sources: Map<Node, number>; byLocal: Map<string, Set<Node>> }
  >();
  const holderFactsOf = (
    fn: IrFunction,
  ): { sources: Map<Node, number>; byLocal: Map<string, Set<Node>> } => {
    const memo = holderFacts.get(fn.name);
    if (memo !== undefined) return memo;
    const flat = flatOf(fn);
    const sources = new Map<Node, number>();
    for (const i of flat.sources) sources.set(flat.nodes[i]!, i);
    const byLocal = new Map<string, Set<Node>>();
    const parents: Node[] = [];
    const above = new Set<Node>();
    for (const i of flat.refs) {
      const node = flat.nodes[i]!;
      if (node.kind !== "varRef") continue;
      above.clear();
      holdersAbove(node, ancestors(flat, i, parents), above);
      if (above.size === 0) continue;
      let set = byLocal.get(node.localId);
      if (set === undefined) byLocal.set(node.localId, (set = new Set()));
      for (const h of above) set.add(h);
    }
    const facts = { sources, byLocal };
    holderFacts.set(fn.name, facts);
    return facts;
  };
  const held = new Map<Node, Set<Node>>();
  const holders = (root: Node): Set<Node> => {
    const memo = held.get(root);
    if (memo !== undefined) return memo;
    const out = new Set<Node>();
    held.set(root, out);
    const fn = rootFunction.get(root);
    if (fn === undefined) return out;
    const facts = holderFactsOf(fn);
    const at = facts.sources.get(root);
    if (at !== undefined) holdersAbove(root, ancestors(flatOf(fn), at, []), out);
    for (const id of rootLocals.get(root) ?? new Set<string>())
      for (const h of facts.byLocal.get(id) ?? new Set<Node>()) out.add(h);
    return out;
  };
  return {
    roots,
    calls,
    drops,
    rootLocals,
    rootFunction,
    reachable,
    closed,
    fresh,
    leakFree,
    allocates,
    holders,
  };
}

/** For each local declared in `fn`, the statement lists that enclose its
 * declaration, outermost first (the body included); a declaration inside an
 * expression (a sequence's statements) is nested in the statement that
 * holds it. Parameters and locals without a declaration have none: the
 * function's own scope. A `for…of` variable counts as declared in the list
 * holding the loop. */
function declarationPaths(fn: IrFunction): Map<string, readonly number[]> {
  const out = new Map<string, readonly number[]>();
  // Each statement list (and each expression holding one) gets an id.
  let next = 0;
  const walk = (list: readonly IrStmt[], path: readonly number[]): void => {
    if (list.length === 0) return;
    const here = [...path, next++];
    for (const stmt of list) {
      if (stmt.kind === "varDecl" || stmt.kind === "forOf") out.set(stmt.localId, here);
      for (const inner of stmtLists(stmt)) walk(inner, here);
      // Statements inside the statement's expressions, one level deeper.
      const visit = (e: IrExpr): boolean => {
        if (e.kind === "seqExpr") walk(e.stmts, [...here, next++]);
        everyExprChild(e, visit, () => true);
        return true;
      };
      everyStmtChild(stmt, visit, () => true);
    }
  };
  walk(fn.body, []);
  return out;
}

/** The statement lists directly inside `stmt`. */
function stmtLists(stmt: IrStmt): readonly (readonly IrStmt[])[] {
  switch (stmt.kind) {
    case "if":
      return stmt.else_ === null ? [stmt.then] : [stmt.then, stmt.else_];
    case "while":
    case "doWhile":
    case "for":
    case "forOf":
    case "block":
      return [stmt.body];
    case "switch":
      return stmt.cases.map((c) => c.body);
    case "tryCatch":
      return [stmt.tryBody, stmt.catchBody ?? [], stmt.finallyBody ?? []];
    default:
      return [];
  }
}

/**
 * The roots and call regions whose groups are closed: every reference an
 * arena object of the group holds is to an arena object of the group or an
 * immortal value, so dropping the arena releases nothing.
 *
 * `arenaType(t)` says whether a value of type `t` is a plain reference to
 * an object the arena-aware constructors allocate (no box around it).
 *
 * A function is closed when every reference it stores (into a field, an
 * element, a collection, or the content of a new object) is closed:
 * - a value without references, an immortal literal, or null/undefined;
 * - an object of an arena type it allocates, or the result of a call of a
 *   closed function whose results are closed;
 * - a local bound only to closed values, or a reference of an arena type
 *   read out of one;
 * - a constructor's `this`;
 * - a parameter, or a reference read out of one: its callers must pass a
 *   closed value (the function's stored parameters).
 * Every function it calls must be closed and get closed values for their
 * stored parameters. A root's group is then closed when its callee is,
 * its arguments for stored parameters are closed in its caller, and the
 * caller stores only closed values into the root's graph afterwards (there,
 * only values without references, literals, and references read out of the
 * root's own locals are closed: the caller's own allocations are on the
 * heap). Solved optimistically to a fixpoint.
 */
export function analyzeClosedGroups(
  mod: IrModule,
  groups: RegionGroups,
  arenaType: (t: IrType) => boolean,
  /** Whether an allocation or call site's objects take the arena. */
  kept: (e: Node) => boolean = () => true,
): Set<Node> {
  const fns = new Map<string, IrFunction>();
  for (const fn of mod.functions) fns.set(fn.name, fn);
  const vt = new VirtualTargets(mod.classes ?? []);
  const closedFn = new Set([...groups.reachable].filter((f) => groups.leakFree.has(f)));
  const closedFresh = new Set([...closedFn].filter((f) => groups.fresh.has(f)));
  const stored = new Map<string, Set<number>>();
  const storedOf = (name: string): Set<number> => stored.get(name) ?? new Set();
  const leavesOf = (e: IrExpr, out: IrExpr[] = []): IrExpr[] => {
    let at = e;
    for (let i = 0; i < 16; i++)
      if (
        at.kind === "unionWrap" ||
        at.kind === "upcast" ||
        at.kind === "downcast" ||
        at.kind === "unionRetype"
      )
        at = at.value;
      else break;
    if (at.kind === "ternary") {
      if (!throws(at.then)) leavesOf(at.then, out);
      if (!throws(at.else_)) leavesOf(at.else_, out);
    } else out.push(at);
    return out;
  };
  // Functions that return only references read out of one parameter (or
  // null/undefined), such as the checked element read `%arr.idxOr`: a call
  // of one reads out of that argument.
  const projects = new Map<string, number>();
  for (const fn of mod.functions) {
    const assigned = new Set<string>();
    let index: number | null = null;
    let ok = true;
    const visit = (node: Node): void => {
      if (!ok) return;
      if (node.kind === "assign") assigned.add(node.localId);
      if (node.kind === "return") {
        const v = node.value;
        if (v === null) ok = false;
        else
          for (const u of leavesOf(v)) {
            if (u.kind === "unitLit") continue;
            const base = projectionBase(u);
            const i = base === null ? -1 : fn.params.findIndex((p) => p.localId === base);
            if (i < 0 || (index !== null && index !== i)) ok = false;
            else index = i;
          }
      }
      const kids: Node[] = [];
      children(node, kids);
      for (const k of kids) visit(k);
    };
    if (!refType(fn.returnType)) continue;
    for (const st of fn.body) visit(st);
    if (ok && index !== null && !assigned.has(fn.params[index]!.localId))
      projects.set(fn.name, index);
  }
  const through = (call: IrExpr): IrExpr | null => {
    if (call.kind !== "call") return null;
    const i = projects.get(call.callee);
    return i === undefined ? null : (call.args[i] ?? null);
  };
  /** Whether `e` (in `fn`, `own` its closed locals, `inArena` whether its
   * allocations are arena objects) is a closed value; parameters it reads
   * go into `params`. */
  const closedValue = (
    e: Node,
    fn: IrFunction,
    own: ReadonlySet<string>,
    inArena: boolean,
    params: Set<number>,
  ): boolean => {
    if (!isExpr(e)) return false;
    const t = e.type;
    if (t.kind === "string") return e.kind === "strLit";
    // Any other counted value (a typed array, a promise) is a heap object.
    if (!refType(t) && !isRefCounted(t)) return true;
    if (!arenaType(t)) return false;
    return leavesOf(e).every((u) => {
      if (u.kind === "unitLit") return true;
      if (u.kind === "recordLit" || u.kind === "new" || u.kind === "arrayLit")
        return inArena && arenaType(u.type) && kept(u);
      if (u.kind === "call" && !projects.has(u.callee))
        return inArena && closedFresh.has(u.callee) && arenaType(u.type) && kept(u);
      const base = projectionBase(u, through);
      if (base === null) return false;
      const i = fn.params.findIndex((p) => p.localId === base);
      if (i >= 0) {
        if (i === 0 && fn.name.endsWith(".constructor") && u.kind === "varRef") return true;
        params.add(i);
        return arenaType(u.type);
      }
      return own.has(base) && arenaType(u.type);
    });
  };
  /** Every reference store and content position in `fn`'s body, and every
   * call with the arguments its callee stores. */
  const siteMemo = new Map<string, { value: Node; target: string | null }[]>();
  const sites = (fn: IrFunction): { value: Node; target: string | null }[] => {
    const memo = siteMemo.get(fn.name);
    if (memo !== undefined) return memo;
    const out: { value: Node; target: string | null }[] = [];
    siteMemo.set(fn.name, out);
    const walk = (node: Node, parent: Node | undefined): void => {
      if (parent !== undefined && isExpr(node)) {
        // An item a splice inserts and the value a fill writes go into their
        // array too. Elsewhere they count as leaving the frame; here the
        // array's group holds a reference to them that its arena must release.
        const target =
          storeOf(node, parent) ??
          (parent.kind === "arrIntrinsic" &&
          (parent.method === "spliceInsert" || parent.method === "fill") &&
          refType(node.type) &&
          indexOfNode(parent.args, node) >= 0
            ? parent.receiver
            : undefined);
        if (target !== undefined) out.push({ value: node, target: storeTarget(target) });
        else if (contentOf(node, parent) && parent.kind !== "new")
          out.push({ value: node, target: null });
      }
      const kids: Node[] = [];
      children(node, kids);
      for (const k of kids) walk(k, node);
    };
    for (const st of fn.body) walk(st, undefined);
    return out;
  };
  const bindingMemo = new Map<string, Map<string, IrExpr[]>>();
  const bindingsOf = (fn: IrFunction): Map<string, IrExpr[]> => {
    const memo = bindingMemo.get(fn.name);
    if (memo !== undefined) return memo;
    const out = new Map<string, IrExpr[]>();
    bindingMemo.set(fn.name, out);
    const scan = (node: Node): void => {
      if (node.kind === "varDecl" || node.kind === "assign") {
        const v = node.kind === "varDecl" ? node.init : node.value;
        if (v !== null) out.set(node.localId, [...(out.get(node.localId) ?? []), v]);
      }
      // A loop variable holds elements read out of the iterable.
      if (node.kind === "forOf")
        out.set(node.localId, [...(out.get(node.localId) ?? []), node.iterable]);
      const kids: Node[] = [];
      children(node, kids);
      for (const k of kids) scan(k);
    };
    for (const st of fn.body) scan(st);
    return out;
  };
  // Written parameters: those whose graph a function may store into, itself
  // or through what it calls (any function, not only arena-aware ones).
  const writes = new Map<string, Set<number>>();
  /** The parameter whose graph `local` reaches into, through bindings to
   * references read out of it, or -1. */
  const paramOf = (fn: IrFunction, bindings: Map<string, IrExpr[]>, local: string): number => {
    let at = local;
    for (let i = 0; i < 16; i++) {
      const p = fn.params.findIndex((q) => q.localId === at);
      if (p >= 0) return p;
      const list = bindings.get(at);
      if (list === undefined || list.length !== 1) return -1;
      const base = projectionBase(list[0]!);
      if (base === null || base === at) return -1;
      at = base;
    }
    return -1;
  };
  // Each function's own writes, and the parameters it passes to calls: a
  // parameter passed where the callee writes is written too.
  const passed = new Map<
    string,
    { param: number; callees: readonly string[] | null; index: number }[]
  >();
  const writers = new Map<string, Set<string>>();
  // Only what the functions holding roots call, transitively, is asked.
  const asked = new Set<string>();
  {
    const queue = [
      ...new Set(
        [...groups.roots, ...groups.calls].flatMap((r) => groups.rootFunction.get(r)?.name ?? []),
      ),
    ];
    for (const name of queue) asked.add(name);
    while (queue.length > 0) {
      const fn = fns.get(queue.pop()!);
      if (fn === undefined) continue;
      const visit = (n: Node): void => {
        const targets =
          n.kind === "call"
            ? [n.callee]
            : n.kind === "virtualCall"
              ? (virtualTargetsOf(vt, n) ?? [])
              : [];
        for (const t of targets)
          if (fns.has(t) && !asked.has(t)) {
            asked.add(t);
            queue.push(t);
          }
        const kids: Node[] = [];
        children(n, kids);
        for (const k of kids) visit(k);
      };
      for (const st of fn.body) visit(st);
    }
  }
  for (const fn of mod.functions) {
    if (!asked.has(fn.name)) continue;
    const bindings = bindingsOf(fn);
    const set = new Set<number>();
    for (const { target } of sites(fn))
      if (target !== null) {
        const i = paramOf(fn, bindings, target);
        if (i >= 0) set.add(i);
      }
    const list: { param: number; callees: readonly string[] | null; index: number }[] = [];
    const visit = (n: Node): void => {
      const args = argsOf(n);
      if (args !== null) {
        const callees =
          n.kind === "call"
            ? [n.callee]
            : n.kind === "virtualCall"
              ? (virtualTargetsOf(vt, n) ?? [])
              : null;
        args.forEach((a, j) => {
          const base = projectionBase(a);
          const i = base === null ? -1 : paramOf(fn, bindings, base);
          if (i < 0) return;
          if (callees === null || callees.length === 0 || callees.some((c) => !fns.has(c)))
            set.add(i);
          else {
            list.push({ param: i, callees, index: j });
            for (const c of callees) {
              let w = writers.get(c);
              if (w === undefined) writers.set(c, (w = new Set()));
              w.add(fn.name);
            }
          }
        });
      }
      const kids: Node[] = [];
      children(n, kids);
      for (const k of kids) visit(k);
    };
    for (const st of fn.body) visit(st);
    writes.set(fn.name, set);
    passed.set(fn.name, list);
  }
  {
    const queue = [...asked];
    const queued = new Set(queue);
    while (queue.length > 0) {
      const name = queue.pop()!;
      queued.delete(name);
      const set = writes.get(name)!;
      const before = set.size;
      for (const { param, callees, index } of passed.get(name)!)
        if (callees!.some((c) => writes.get(c)?.has(index) === true)) set.add(param);
      if (set.size !== before)
        for (const r of writers.get(name) ?? new Set<string>())
          if (!queued.has(r)) {
            queued.add(r);
            queue.push(r);
          }
    }
  }
  /** The locals of `fn` bound only to closed values. */
  const closedLocals = (
    fn: IrFunction,
    inArena: boolean,
    seed?: ReadonlySet<string>,
  ): Set<string> => {
    const bindings = bindingsOf(fn);
    const own = new Set(
      fn.locals
        .filter((l) => l.boxed !== true && !fn.params.some((p) => p.localId === l.id))
        .map((l) => l.id),
    );
    for (const id of seed ?? new Set<string>()) own.add(id);
    for (let again = true; again;) {
      again = false;
      for (const id of [...own]) {
        if (seed?.has(id) === true) continue;
        const list = bindings.get(id) ?? [];
        if (!list.every((v) => closedValue(v, fn, own, inArena, new Set()))) {
          own.delete(id);
          again = true;
        }
      }
    }
    return own;
  };
  /** Whether the calls in `node`'s subtree are of closed functions with
   * closed arguments for their stored parameters. */
  const callsClosed = (
    node: Node,
    fn: IrFunction,
    own: ReadonlySet<string>,
    inArena: boolean,
    params: Set<number>,
  ): boolean => {
    let ok = true;
    const visit = (n: Node): void => {
      if (!ok) return;
      if (n.kind === "call" || n.kind === "new" || n.kind === "virtualCall") {
        const targets =
          n.kind === "call"
            ? [n.callee]
            : n.kind === "new"
              ? [`%${n.className}.constructor`]
              : (virtualTargetsOf(vt, n) ?? []);
        if (targets.length === 0) ok = false;
        const shift = n.kind === "new" ? 1 : 0;
        for (const t of targets) {
          if (!closedFn.has(t)) ok = false;
          for (const j of storedOf(t)) {
            const arg = n.args[j - shift];
            if (arg !== undefined && !closedValue(arg, fn, own, inArena, params)) ok = false;
          }
        }
      } else if (n.kind === "callValue" || n.kind === "dynCall" || n.kind === "dynInvoke")
        ok = false;
      else if (
        (n.kind === "arrIntrinsic" || n.kind === "mapIntrinsic" || n.kind === "setIntrinsic") &&
        !READ_RECEIVER.has(n.method) &&
        !ADDING_METHODS.has(n.method) &&
        n.args.some((a) => refType(a.type) || isRefCounted(a.type))
      )
        ok = false;
      const kids: Node[] = [];
      children(n, kids);
      for (const k of kids) visit(k);
    };
    visit(node);
    return ok;
  };
  for (let changed = true; changed;) {
    changed = false;
    for (const name of [...closedFn]) {
      const fn = fns.get(name)!;
      const params = new Set<number>();
      const own = closedLocals(fn, true);
      let ok = sites(fn).every(({ value }) => closedValue(value, fn, own, true, params));
      for (const st of fn.body) if (ok) ok = callsClosed(st, fn, own, true, params);
      let returnsClosed = true;
      const scanReturns = (node: Node): void => {
        if (node.kind === "return") {
          const v = node.value;
          if (v !== null && !closedValue(v, fn, own, true, params)) returnsClosed = false;
        }
        const kids: Node[] = [];
        children(node, kids);
        for (const k of kids) scanReturns(k);
      };
      for (const st of fn.body) scanReturns(st);
      const before = storedOf(name);
      if ([...params].some((i) => !before.has(i))) {
        stored.set(name, new Set([...before, ...params]));
        changed = true;
      }
      if (!ok) {
        closedFn.delete(name);
        closedFresh.delete(name);
        changed = true;
      } else if (!returnsClosed && closedFresh.delete(name)) changed = true;
    }
  }
  const out = new Set<Node>();
  for (const root of [...groups.roots, ...groups.calls]) {
    const fn = groups.rootFunction.get(root);
    if (fn === undefined) continue;
    const locals = groups.rootLocals.get(root) ?? new Set<string>();
    const bindings = bindingsOf(fn);
    /** Whether `local` reaches into the root's graph: one of its locals,
     * or bound (a loop variable included) to a reference read out of one. */
    const intoRoot = (local: string, depth = 0): boolean =>
      locals.has(local) ||
      (depth < 16 &&
        (bindings.get(local) ?? []).some((v) => {
          const base = projectionBase(v);
          return base !== null && base !== local && intoRoot(base, depth + 1);
        }));
    // In the caller only the root's own locals and what is read out of them
    // are closed references.
    const params = new Set<number>();
    let ok = callsClosed(root, fn, locals, false, params) && params.size === 0;
    // After the arena closes, a call that is passed the root's value (or a
    // reference read out of it) must not write into it.
    const passes = (n: Node, parent: Node | undefined): void => {
      if (!ok) return;
      if (parent !== undefined && isExpr(n)) {
        const args = argsOf(parent);
        const j = args === null ? -1 : indexOfNode(args, n);
        const base = projectionBase(n);
        if (j >= 0 && refType(n.type) && (same(n, root) || (base !== null && intoRoot(base)))) {
          const callees =
            parent.kind === "call"
              ? [parent.callee]
              : parent.kind === "virtualCall"
                ? (virtualTargetsOf(vt, parent) ?? [])
                : [];
          if (callees.length === 0 || callees.some((c) => writes.get(c)?.has(j) !== false))
            ok = false;
        }
      }
      const kids: Node[] = [];
      children(n, kids);
      for (const k of kids) passes(k, n);
    };
    if (ok && !groups.calls.has(root)) for (const st of fn.body) passes(st, undefined);
    if (ok && locals.size > 0)
      ok = sites(fn).every(
        ({ value, target }) =>
          target === null ||
          !intoRoot(target) ||
          (closedValue(value, fn, locals, false, params) && params.size === 0),
      );
    if (ok) out.add(root);
  }
  return out;
}
