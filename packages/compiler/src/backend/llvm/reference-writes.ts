import {
  isRefCounted,
  type IrClassDef,
  type IrExpr,
  type IrFunction,
  type IrRecordShape,
  type IrStmt,
  type IrType,
  type IrUnionDef,
} from "../../ir/ir.js";
import { everyExprChild, everyStmtChild } from "../../ir/traverse.js";
import { eachNodeOfKinds, type IrNodeIndex, type IrNodeKind } from "../../ir/node-index.js";
import { borrowsMapMutationReceiver, borrowsMapReadInputs } from "./map-read-lifetimes.js";
import { preservesRegexInputs, VirtualTargets } from "./reference-effects.js";
import { borrowsStringInputs } from "./string-lifetimes.js";
import { preservesDynTest } from "./checked-value-lifetimes.js";
import { isStableReceiverOperand } from "../../ir/analysis.js";
import type { ImmutableFields } from "../immutability.js";

type Call = IrExpr & { kind: "call" };

/** A set of reference locations, as a bitset over the interned keys; `null`
 * is the empty set. Key 0 (`*`) is an unknown heap write: it covers every
 * heap location but no local of the current function. */
export type Writes = Uint32Array | null;

/** Every heap location (key 0). */
const HEAP_KEY = "*";

/** Array element slots of every reference array share one location: arrays
 * are covariant, so element types do not separate them. */
const ARRAY_KEY = "a";
/** Entries of typed maps and sets. */
const MAP_KEY = "m";
/** Captured-binding boxes. */
const BOX_KEY = "bx";
/** Record fields written through a computed key. */
const ANY_RECORD_KEY = "r:*";

/** The pseudo-function standing for every indirect call target. */
const ANY_FUNCTION = "%anyFunctionValue";

/** Value-producing kinds that only move an existing function value. */
const FUNCTION_MOVES = new Set([
  "closure",
  "selfRef",
  "varRef",
  "fieldGet",
  "recordGet",
  "arrayGet",
  "call",
  "virtualCall",
  "callValue",
  "ternary",
  "logical",
  "nullish",
  "orDefault",
  "unionNarrow",
  "seqExpr",
  "assignExpr",
  "optChain",
  "chainRecv",
  "upcast",
  "downcast",
  "mapIntrinsic",
  "setIntrinsic",
  "arrIntrinsic",
  "recordKeyGet",
  "unionKeyGet",
]);

/** Runtime library families that run no user code and never write a
 * program reference (scalars, strings, byte buffers, files, clocks). */
const INERT_LIB_PREFIXES = [
  "math.",
  "num.",
  "number.",
  "string.",
  "str.",
  "bigint.",
  "buffer.",
  "arrayBuffer.",
  "sharedArrayBuffer.",
  "atomics.",
  "perf.",
  "date.",
  "text.",
  "path.",
  "fs.",
  "stats.",
  "spawnRes.",
];
const INERT_LIB_CALLS = new Set([
  "dyn.compare",
  // Reads the ambient receiver (a fresh reference to the bound value).
  "dyn.this",
  // A sloppy-mode function's receiver from it (a fresh reference).
  "error.new",
  "error.nodeThrow",
  "dyn.typedRefIs",
  "dyn.typedRefKeyIs",
  "dyn.bagGet",
  "json.parse",
  "process.stderrWrite",
  "process.stdoutWrite",
  "process.envGet",
  "process.envPairs",
  "regex.groupEquals",
  "regex.groupNumber",
  "regex.groupParseInt",
  "regex.resultProp",
  "array.namedKeys",
  "array.foreign",
  "array.hasNamedKey",
  "array.hasProperties",
  "process.cwd",
  "process.argv",
  "process.execArgv",
  "process.platform",
  "process.execPath",
  "process.isTTY",
  "process.isTTYValue",
  "worker.data",
  "worker.isMainThread",
  "worker.parentPort",
  "worker.root",
  "cp.spawnSyncOpts",
  "cp.spawnSyncEnv",
]);

/** jsval conversions (ir/jsval.ts): no user code, no stores. */
const JS_CONVERSIONS = new Set([
  "js.fromDyn",
  "js.toDyn",
  "js.fromF64",
  "js.fromBool",
  "js.fromStr",
  "js.fromBigInt",
  "js.toF64",
]);

/** jsval conversions of static primitives. */
const JS_PRIMITIVE_SOURCES = new Set(["js.fromF64", "js.fromBool", "js.fromStr", "js.fromBigInt"]);

/** Array methods that never release an existing element or run user code. */
const PRESERVING_ARRAY_METHODS = new Set([
  "length",
  "getNumber",
  "indexEq",
  "push",
  "pushSpread",
  "concatSpread",
  "unshift",
  "unshiftSpread",
  "indexOf",
  "includes",
  "nextPresent",
  "join",
  "slice",
  "flatCopy",
  "flatOne",
  "toReversed",
  "toSpliced",
  "with",
  "withUndefined",
  "toSortedPrimitive",
  // Permutes primitive payloads in place: every element keeps its owner.
  "sortPrimitive",
]);

/** Which heap reference locations evaluating code may overwrite or remove.
 *
 * ReferenceEffects answers one bit (does anything remove any edge?). This
 * analysis keeps the location, so a borrow that reads `x.f` only conflicts
 * with code that can write field `f` of x's hierarchy (or array elements,
 * map entries, a global or a captured box, for those reads), not with
 * every reference store. Locations:
 *
 * - `f:<hierarchy root>.<field>` class fields (all classes of a hierarchy
 *   that name the field share it, so redeclarations alias);
 * - `r:<field>` record fields, plus `r:*` for computed-key writes and
 *   deletions (every record read also depends on `r:*`);
 * - `a` reference array elements, `m` map/set entries, `bx` boxes;
 * - `g:<id>` module globals, `l:<id>` the current function's own locals
 *   (dropped from summaries: a callee cannot rebind its caller's locals);
 * - ALL for anything unknown: dynamic code, callbacks, suspension, unknown
 *   runtime operations.
 *
 * Stores a constructor makes into its own `this` write a fresh object that
 * no borrow outside the construction can reach, so `new` (and `super`
 * calls from constructors) use a constructor summary without them, as long
 * as constructors are invoked only through `new` and `super`.
 *
 * Facts belong to one finalized module and one emission. */
export class ReferenceWrites {
  private readonly keys = new Map<string, number>();
  private readonly roots = new Map<string, string>();
  private readonly fieldOwners = new Map<string, IrClassDef>();
  private readonly classes = new Map<string, IrClassDef>();
  private readonly virtualTargets: VirtualTargets;
  private readonly summaries = new Map<string, Writes>();
  private readonly exprCache = new Map<IrExpr, Writes>();
  private readonly stmtCache = new Map<IrStmt, Writes>();
  private words = 0;
  /** The unknown heap write alone. */
  heapAll: Uint32Array = new Uint32Array(1).fill(1);
  /** Constructors only ever run on fresh objects. */
  private readonly freshConstructors: boolean;
  private readonly unions: ReadonlyMap<string, IrUnionDef>;
  private readonly records: ReadonlyMap<string, IrRecordShape>;
  private readonly inertJson = new Map<string, boolean>();
  /** Closure bodies an indirect call can reach. */
  private readonly functionValues = new Set<string>();
  private callTargets!: CallTargets;
  /** Some function value comes from outside the module's closures. */
  private foreignFunctionValues = false;
  private current: IrFunction | null = null;
  private currentBoxed = new Set<string>();
  private currentLocals = new Set<string>();
  private currentPrivateArrays: ReadonlySet<string> = new Set();
  private constructors: ReadonlySet<string> = new Set();
  private inConstructor = false;

  constructor(
    private readonly functions: ReadonlyMap<string, IrFunction>,
    classes: readonly IrClassDef[],
    private readonly intrinsicCall: (call: Call) => boolean,
    private readonly globals: ReadonlySet<string>,
    types: {
      unions?: readonly IrUnionDef[] | undefined;
      records?: readonly IrRecordShape[] | undefined;
    } = {},
    /** Fields no code writes once their object is constructed
     * (immutability.ts, from cycle-mutability's construction-only facts). */
    private readonly immutable: ImmutableFields | null = null,
    /** The module's node index, read instead of walking the bodies. */
    private readonly nodes?: IrNodeIndex,
  ) {
    this.key(HEAP_KEY);
    this.unions = new Map((types.unions ?? []).map((u) => [u.id, u]));
    this.records = new Map((types.records ?? []).map((r) => [r.id, r]));
    for (const cls of classes) this.classes.set(cls.name, cls);
    this.virtualTargets = new VirtualTargets(classes);
    const constructors = new Set(classes.map((cls) => `%${cls.name}.constructor`));
    this.constructors = constructors;
    this.freshConstructors = [...functions.values()].every((fn) =>
      this.onlySuperCalls(fn, constructors),
    );
    this.callTargets = new CallTargets(functions, this.virtualTargets, nodes);
    this.solve(constructors);
  }

  /** Every direct call of a constructor in `fn` is a `super` call from a
   * constructor on its own `this`. */
  private onlySuperCalls(fn: IrFunction, constructors: ReadonlySet<string>): boolean {
    const thisId = constructors.has(fn.name) ? fn.params[0]?.localId : undefined;
    let only = true;
    eachNodeOfKinds(fn, this.nodes?.scan(CALL_KINDS), (node) => {
      if (node.kind === "call" && constructors.has(node.callee)) {
        const self = node.args[0];
        if (thisId === undefined || !self || !isThisRef(self, thisId)) only = false;
      }
      return only;
    });
    return only;
  }

  private key(k: string): number {
    let id = this.keys.get(k);
    if (id === undefined) {
      id = this.keys.size;
      this.keys.set(k, id);
    }
    return id;
  }

  /** The hierarchy root of a class (runtime bases included). */
  private root(className: string): string {
    let r = this.roots.get(className);
    if (r !== undefined) return r;
    r = className;
    for (let cls = this.classes.get(className); cls?.base !== undefined;) {
      r = cls.base;
      cls = this.classes.get(cls.base);
    }
    this.roots.set(className, r);
    return r;
  }

  fieldKey(className: string, field: string): string {
    return `f:${this.root(className)}.${field}`;
  }

  // ── phase 1: per-function local writes and call edges ─────────────────

  private solve(constructors: ReadonlySet<string>): void {
    interface Node {
      local: Set<number>;
      edges: Set<string>;
    }
    const nodes = new Map<string, Node>();
    const scan = (fn: IrFunction, external: boolean): Node => {
      const node: Node = { local: new Set(), edges: new Set() };
      if (fn.async || fn.generator) {
        node.local.add(0);
        return node;
      }
      const thisId = external && constructors.has(fn.name) ? (fn.params[0]?.localId ?? null) : null;
      const boxed = boxedLocals(fn);
      const privates = privateArrays(fn, boxed, this.nodes);
      const sink: WriteSink = {
        add: (k) => {
          // Interned for queries; a callee's locals are private to it.
          const id = this.key(k);
          if (!k.startsWith("l:")) node.local.add(id);
        },
        all: () => node.local.add(0),
        call: (callee, fresh) => {
          if (callee === ANY_FUNCTION) {
            node.edges.add(ANY_FUNCTION);
            return true;
          }
          if (!this.functions.has(callee)) return false;
          node.edges.add(
            fresh && this.freshConstructors && constructors.has(callee) ? `${callee}#ext` : callee,
          );
          return true;
        },
      };
      const expr = (e: IrExpr): boolean => {
        this.nodeWrites(e, sink, boxed, fn, constructors);
        if (e.kind === "closure") this.functionValues.add(e.fnName);
        else if (
          e.type?.kind === "func" &&
          !FUNCTION_MOVES.has(e.kind) &&
          !(e.kind === "libCall" && e.fn === "error.nodeThrow")
        )
          this.foreignFunctionValues = true;
        return everyExprChild(e, expr, stmt);
      };
      const stmt = (s: IrStmt): boolean => {
        if (thisId !== null && s.kind === "fieldSet" && isThisRef(s.obj, thisId)) {
          // A store into the fresh `this`: no outside borrow can reach it.
        } else this.stmtWrites(s, sink, boxed, privates);
        return everyStmtChild(s, expr, stmt);
      };
      fn.body.every(stmt);
      return node;
    };
    for (const fn of this.functions.values()) {
      nodes.set(fn.name, scan(fn, false));
      if (this.freshConstructors && constructors.has(fn.name))
        nodes.set(`${fn.name}#ext`, scan(fn, true));
    }
    // Indirect calls reach any closure body; values made elsewhere
    // (dynamic conversions) reach unknown code.
    nodes.set(ANY_FUNCTION, {
      local: new Set(this.foreignFunctionValues ? [0] : []),
      edges: new Set([...this.functionValues].filter((name) => this.functions.has(name))),
    });
    this.words = (this.keys.size + 31) >>> 5;
    this.heapAll = new Uint32Array(this.words);
    this.heapAll[0] = 1;
    // Tarjan's SCCs, iteratively; components come out callees first.
    const index = new Map<string, number>();
    const low = new Map<string, number>();
    const onStack = new Set<string>();
    const stack: string[] = [];
    let counter = 0;
    for (const start of nodes.keys()) {
      if (index.has(start)) continue;
      const work: { name: string; edges: Iterator<string> }[] = [];
      const enter = (name: string): void => {
        index.set(name, counter);
        low.set(name, counter++);
        stack.push(name);
        onStack.add(name);
        work.push({ name, edges: nodes.get(name)!.edges.values() });
      };
      enter(start);
      while (work.length > 0) {
        const top = work[work.length - 1]!;
        const next = top.edges.next();
        if (!next.done) {
          const callee = next.value;
          if (!nodes.has(callee)) continue;
          if (!index.has(callee)) enter(callee);
          else if (onStack.has(callee))
            low.set(top.name, Math.min(low.get(top.name)!, index.get(callee)!));
          continue;
        }
        work.pop();
        if (work.length > 0) {
          const parent = work[work.length - 1]!.name;
          low.set(parent, Math.min(low.get(parent)!, low.get(top.name)!));
        }
        if (low.get(top.name) !== index.get(top.name)) continue;
        const members: string[] = [];
        for (;;) {
          const m = stack.pop()!;
          onStack.delete(m);
          members.push(m);
          if (m === top.name) break;
        }
        const bits = new Uint32Array(this.words);
        const inComponent = new Set(members);
        for (const m of members) {
          const node = nodes.get(m)!;
          for (const id of node.local) setBit(bits, id);
          for (const callee of node.edges) {
            if (inComponent.has(callee)) continue;
            const s = this.summaries.get(callee);
            if (s === undefined || s === null) continue;
            orInto(bits, s);
          }
        }
        // An unknown heap write subsumes the precise heap keys.
        const summary: Writes = (bits[0]! & 1) !== 0 ? this.heapAll : anyBit(bits) ? bits : null;
        for (const m of members) this.summaries.set(m, summary);
      }
    }
  }

  /** Writes of one expression node itself (children are separate). */
  private nodeWrites(
    e: IrExpr,
    sink: WriteSink,
    boxed: ReadonlySet<string>,
    fn: IrFunction | null,
    constructors: ReadonlySet<string>,
  ): void {
    switch (e.kind) {
      case "call": {
        const fresh =
          fn !== null &&
          constructors.has(e.callee) &&
          constructors.has(fn.name) &&
          e.args[0] !== undefined &&
          isThisRef(e.args[0], fn.params[0]?.localId ?? "");
        if (!sink.call(e.callee, fresh) && !this.intrinsicCall(e)) sink.all();
        return;
      }
      case "new":
        if (!sink.call(`%${e.className}.constructor`, true)) sink.all();
        return;
      case "virtualCall": {
        const targets = this.virtualTargets.targets(e.className, e.method);
        if (targets === null) sink.all();
        else for (const t of targets) if (!sink.call(t, false)) sink.all();
        return;
      }
      case "assignExpr":
      case "incDec":
        if (isRefCounted(e.type)) sink.add(this.localKey(e.localId, boxed));
        return;
      case "callValue": {
        const targets = fn !== null ? this.callTargets.of(e.callee, fn) : null;
        if (targets === null) {
          if (!sink.call(ANY_FUNCTION, false)) sink.all();
        } else for (const t of targets) if (!sink.call(t, false)) sink.all();
        return;
      }
      case "arrIntrinsic":
        if (!PRESERVING_ARRAY_METHODS.has(e.method)) {
          // The comparator sort orders a private snapshot. It may call the
          // comparator and a key reader.
          if (e.method === "sortValues" || e.method === "sortDense") {
            const comparator = e.args[e.method === "sortValues" ? 1 : 0];
            for (const callee of e.args[3] ? [comparator, e.args[3]] : [comparator]) {
              const targets =
                fn !== null && callee !== undefined ? this.callTargets.of(callee, fn) : null;
              if (targets === null) {
                if (!sink.call(ANY_FUNCTION, false)) sink.all();
              } else for (const t of targets) if (!sink.call(t, false)) sink.all();
            }
          }
          sink.add(ARRAY_KEY);
        }
        return;
      case "mapIntrinsic":
      case "setIntrinsic":
        if (borrowsMapReadInputs(e)) return;
        if (borrowsMapMutationReceiver(e)) sink.add(MAP_KEY);
        else if (e.receiver.type.kind === "map" || e.receiver.type.kind === "set") {
          // Typed collections: copies and iteration bookkeeping run no
          // user code; leaving an iteration may compact removed entries.
          if (e.method === "iterEnter" || e.method === "iterExit") sink.add(MAP_KEY);
          else if (
            e.method !== "clone" &&
            e.method !== "keySet" &&
            e.method !== "valueSet" &&
            e.method !== "toArray"
          )
            sink.all();
        } else sink.all();
        return;
      case "intrinsic":
        // A TDZ test reads; publication only makes objects immortal; intern
        // tables store published values and write no script object;
        // ThreadSlots reads write nothing.
        if (
          e.name !== "module.tdzCheck" &&
          e.name !== "threads.publish" &&
          !e.name.startsWith("itable.") &&
          e.name !== "slots.get" &&
          e.name !== "slots.has"
        )
          sink.all();
        return;
      case "dynFrom":
      case "dynArrLit":
      case "dynObjLit":
        return;
      case "dynCheck":
        // Identity and kind tests of class and primitive targets.
        if (!this.checkedWithoutCode(e.type)) sink.all();
        return;
      case "jsonStringify":
        if (!this.jsonInert(e.value.type)) sink.all();
        return;
      case "bytesNew":
        return;
      case "bytesIntrinsic":
        // The typed-array comparator sort orders a private snapshot.
        if (e.method === "sortCompare") {
          const targets = fn !== null && e.args[0] ? this.callTargets.of(e.args[0], fn) : null;
          if (targets === null) {
            if (!sink.call(ANY_FUNCTION, false)) sink.all();
          } else for (const t of targets) if (!sink.call(t, false)) sink.all();
        }
        return;
      case "strIntrinsic":
        if (!borrowsStringInputs(e.method)) sink.all();
        return;
      case "regexIntrinsic":
        if (!preservesRegexInputs(e.method)) sink.all();
        return;
      case "libCall":
        if (!this.inertLibCall(e)) sink.all();
        return;
      case "toString":
        if (!this.primitive(e.operand.type)) sink.all();
        return;
      case "dynTest":
        if (!preservesDynTest(e.test)) sink.all();
        return;
      // Reads, tests, arithmetic and fresh allocations.
      case "numLit":
      case "boolLit":
      case "strLit":
      case "unitLit":
      case "varRef":
      case "bin":
      case "unary":
      case "toBool":
      case "logical":
      case "nullish":
      case "ternary":
      case "seqExpr":
      case "fieldGet":
      case "recordGet":
      case "unionNarrow":
      case "unionIsTag":
      case "unionWrap":
      case "unionRetype":
      case "downcast":
      case "upcast":
      case "instanceOf":
      case "strConcat":
      case "strEq":
      case "strCmp":
      case "arrayGet":
      case "arrayHas":
      case "arrayState":
      case "unionEq":
      case "unionFuncEq":
      case "dynScalarEq":
      case "caughtTest":
      case "caughtNarrow":
      case "caughtCheck":
      case "classRef":
      case "recordLit":
      case "arrayLit":
      case "arrayNewLen":
      case "closure":
      case "mapNew":
      case "setNew":
      case "regexLit":
      case "recordHas":
      case "recordKeyGet":
      case "recordOvfHas":
      case "recordNullProto":
      case "recordOvfKeys":
      case "fieldAbsent":
      case "unionDisc":
      case "unionKeyGet":
      case "fieldIncDec":
      case "optChain":
      case "chainRecv":
      case "orDefault":
      case "instanceOfValue":
      case "promiseVoidWiden":
        return;
      default:
        sink.all();
    }
  }

  /** Writes of one statement node itself. */
  private stmtWrites(
    s: IrStmt,
    sink: WriteSink,
    boxed: ReadonlySet<string>,
    privates: ReadonlySet<string>,
  ): void {
    switch (s.kind) {
      case "assign":
        if (isRefCounted(s.value.type)) sink.add(this.localKey(s.localId, boxed));
        return;
      case "fieldSet":
        if (isRefCounted(s.value.type)) sink.add(this.fieldKey(s.className, s.field));
        return;
      case "recordSet":
        if (isRefCounted(s.value.type)) sink.add(`r:${s.field}`);
        return;
      case "recordKeySet":
      case "recordKeyDelete":
        sink.add(ANY_RECORD_KEY);
        return;
      case "arraySet":
      case "arraySetUndefined":
      case "arrayDelete":
      case "arraySetLength":
        if (!privateReceiver(s.arr, privates)) sink.add(ARRAY_KEY);
        return;
      case "varDecl":
      case "exprStmt":
      case "return":
      case "throw":
      case "runtimeFence":
      case "if":
      case "for":
      case "forOf":
      case "while":
      case "doWhile":
      case "block":
      case "switch":
      case "break":
      case "continue":
      case "bytesSet":
      case "tryCatch":
      case "rethrow":
        return;
      default:
        sink.all();
    }
  }

  /** Library calls that run no user code: inert families without callback
   * arguments, and an Error options bag that is a typed record (no
   * accessors) or absent. */
  private inertLibCall(e: IrExpr & { kind: "libCall" }): boolean {
    if (e.fn === "error.nodeThrow" || isStableReceiverOperand(e, "")) return true;
    // jsval conversions run no user code: they move a value between its
    // dyn and jsval forms, and js.toF64 is dynCheck's number check. A
    // comparison is inert exactly when its dyn twin is: every operand a
    // wrapped primitive.
    if (JS_CONVERSIONS.has(e.fn)) return true;
    if (e.fn === "js.compare")
      return e.args.every((arg) => arg.type.kind !== "jsval" || this.jsPrimitive(arg));
    if (e.fn === "error.newOptions")
      return e.args.every(
        (arg) =>
          arg.type.kind !== "dyn" ||
          (arg.kind === "dynFrom" &&
            (arg.value.type.kind === "record" || this.primitive(arg.value.type))),
      );
    if (!INERT_LIB_CALLS.has(e.fn) && !INERT_LIB_PREFIXES.some((p) => e.fn.startsWith(p)))
      return false;
    return e.args.every(
      (arg) =>
        arg.type.kind !== "func" &&
        (arg.type.kind !== "dyn" ||
          (e.fn !== "dyn.compare" && e.fn.startsWith("dyn.")) ||
          // A wrapped primitive has no methods to call back into.
          (arg.kind === "dynFrom" && this.primitive(arg.value.type))),
    );
  }

  /** A jsval operand made from a primitive: it has no methods to call
   * back into. */
  private jsPrimitive(e: IrExpr): boolean {
    if (e.kind !== "libCall") return false;
    if (e.fn === "js.fromDyn") {
      const value = e.args[0]!;
      return value.kind === "dynFrom" && this.primitive(value.value.type);
    }
    return JS_PRIMITIVE_SOURCES.has(e.fn);
  }

  /** Numbers, booleans, strings and unit values (and unions of them). */
  private primitive(t: IrType): boolean {
    switch (t.kind) {
      case "f64":
      case "bool":
      case "string":
      case "undefinedT":
      case "nullT":
        return true;
      case "union":
        return this.unions.get(t.unionId)?.arms.every((arm) => this.primitive(arm)) ?? false;
      default:
        return false;
    }
  }

  /** A dynamic-to-typed check that only tests identity or kind. */
  private checkedWithoutCode(t: IrType): boolean {
    if (t.kind === "object" || this.primitive(t)) return true;
    if (t.kind !== "union") return false;
    return (
      this.unions
        .get(t.unionId)
        ?.arms.every((arm) => arm.kind === "object" || this.primitive(arm)) ?? false
    );
  }

  /** JSON.stringify of this type calls no toJSON or accessor: primitives
   * and records/arrays/unions of them (class instances may define both). */
  private jsonInert(t: IrType): boolean {
    if (this.primitive(t)) return true;
    const key = JSON.stringify(t);
    const known = this.inertJson.get(key);
    if (known !== undefined) return known;
    this.inertJson.set(key, true); // recursive shapes: assume, then confirm
    let result: boolean;
    if (t.kind === "array") result = this.jsonInert(t.elem);
    else if (t.kind === "record")
      result = this.records.get(t.shapeId)?.fields.every((f) => this.jsonInert(f.type)) ?? false;
    else if (t.kind === "union")
      result = this.unions.get(t.unionId)?.arms.every((arm) => this.jsonInert(arm)) ?? false;
    else result = false;
    this.inertJson.set(key, result);
    return result;
  }

  private localKey(id: string, boxed: ReadonlySet<string>, locals?: ReadonlySet<string>): string {
    if (this.globals.has(id)) return `g:${id}`;
    // A binding of another function (never expected) counts as a box.
    if (boxed.has(id) || (locals !== undefined && !locals.has(id))) return BOX_KEY;
    return `l:${id}`;
  }

  // ── queries ────────────────────────────────────────────────────────────

  /** Start answering expression queries for one function body. */
  enter(fn: IrFunction): void {
    this.current = fn;
    this.currentBoxed = boxedLocals(fn);
    this.currentPrivateArrays = privateArrays(fn, this.currentBoxed, this.nodes);
    this.currentLocals = new Set(fn.locals.map((local) => local.id));
    this.inConstructor = this.constructors.has(fn.name);
    for (const p of fn.params) this.currentLocals.add(p.localId);
    this.exprCache.clear();
    this.stmtCache.clear();
  }

  private readonly bodyWrites = new Map<string, Writes>();

  /** Whether a walk of `fn` reads only locations its whole body never
   * writes; the candidate walk locals' own rebinding is exempt. */
  unwrittenWalk(
    fn: IrFunction,
    value: IrExpr,
    candidates: ReadonlySet<string>,
    call: (e: Call) => readonly string[] | null,
  ): boolean {
    if (this.current !== fn) this.enter(fn);
    const keys = this.readKeys(value, call);
    if (keys === null) return false;
    let body = this.bodyWrites.get(fn.name);
    if (body === undefined) {
      body = this.stmts(fn.body);
      this.bodyWrites.set(fn.name, body);
    }
    return !this.conflicts(
      keys.filter((k) => !(k.startsWith("l:") && candidates.has(k.slice(2)))),
      body,
    );
  }

  /** The transitive writes of a call to a module function (`#ext` for a
   * constructor reached through `new`). */
  summary(name: string): Writes {
    const known = this.summaries.get(name);
    return known === undefined ? this.heapAll : known;
  }

  constructWrites(className: string): Writes {
    const ctor = `%${className}.constructor`;
    if (!this.functions.has(ctor)) return this.heapAll;
    return this.summary(this.freshConstructors ? `${ctor}#ext` : ctor);
  }

  virtualWrites(className: string, method: string): Writes {
    const targets = this.virtualTargets.targets(className, method);
    if (targets === null) return this.heapAll;
    return this.union(targets.map((t) => this.summary(t)));
  }

  /** Writes of the node's own operation, without its operands: for a
   * call, what its possible targets may write. */
  ownWrites(e: IrExpr): Writes {
    const parts: Writes[] = [];
    this.nodeWrites(e, this.querySink(parts), this.currentBoxed, this.current, new Set());
    return this.union(parts);
  }

  /** Writes of evaluating an expression, with its operands. */
  expr(e: IrExpr): Writes {
    const known = this.exprCache.get(e);
    if (known !== undefined) return known;
    const parts: Writes[] = [];
    const sink = this.querySink(parts);
    this.nodeWrites(e, sink, this.currentBoxed, this.current, new Set());
    everyExprChild(
      e,
      (child) => (parts.push(this.expr(child)), true),
      (child) => (parts.push(this.stmt(child)), true),
    );
    const result = this.union(parts);
    this.exprCache.set(e, result);
    return result;
  }

  stmt(s: IrStmt): Writes {
    const known = this.stmtCache.get(s);
    if (known !== undefined) return known;
    const parts: Writes[] = [];
    this.stmtWrites(s, this.querySink(parts), this.currentBoxed, this.currentPrivateArrays);
    everyStmtChild(
      s,
      (child) => (parts.push(this.expr(child)), true),
      (child) => (parts.push(this.stmt(child)), true),
    );
    const result = this.union(parts);
    this.stmtCache.set(s, result);
    return result;
  }

  stmts(list: readonly IrStmt[]): Writes {
    return this.union(list.map((s) => this.stmt(s)));
  }

  private querySink(parts: Writes[]): WriteSink {
    return {
      add: (k) => parts.push(this.bitsOf([k])),
      all: () => parts.push(this.heapAll),
      call: (callee, fresh) => {
        if (callee === ANY_FUNCTION) {
          parts.push(this.summary(ANY_FUNCTION));
          return true;
        }
        if (!this.functions.has(callee)) return false;
        const ctor = fresh && callee.endsWith(".constructor") && this.freshConstructors;
        parts.push(this.summary(ctor ? `${callee}#ext` : callee));
        return true;
      },
    };
  }

  union(parts: readonly Writes[]): Writes {
    let out: Uint32Array | null = null;
    for (const p of parts) {
      if (p === null) continue;
      if (out === null) out = new Uint32Array(this.words);
      orInto(out, p);
    }
    return out;
  }

  /** A bitset over known keys; keys nothing writes are dropped. */
  bitsOf(keys: readonly string[]): Writes {
    let out: Uint32Array | null = null;
    for (const k of keys) {
      const id = this.keys.get(k);
      if (id === undefined || id >= this.words * 32) continue;
      if (out === null) out = new Uint32Array(this.words);
      setBit(out, id);
    }
    return out;
  }

  /** Whether writes may touch any of the read keys. */
  conflicts(reads: readonly string[], writes: Writes): boolean {
    if (writes === null) return false;
    const heap = (writes[0]! & 1) !== 0;
    for (const k of reads) {
      if (heap && !k.startsWith("l:")) return true;
      const id = this.keys.get(k);
      if (id === undefined || id >= this.words * 32) continue;
      if ((writes[id >>> 5]! & (1 << (id & 31))) !== 0) return true;
    }
    return false;
  }

  /** The locations whose writes could release the object a borrowed read
   * of `e` yields, or null when `e` is not such a projection. `call`
   * resolves borrowed-return callees to the locations their walks read. */
  readKeys(e: IrExpr, call?: (e: Call) => readonly string[] | null): string[] | null {
    const out: string[] = [];
    const walk = (node: IrExpr): boolean => {
      switch (node.kind) {
        case "varRef":
          out.push(this.localKey(node.localId, this.currentBoxed, this.currentLocals));
          return true;
        case "fieldGet":
          // A construction-only field of an existing object never changes;
          // only a constructor can still be writing it (its own `this`).
          if (this.inConstructor || !this.immutable?.classField(node.className, node.field))
            out.push(this.fieldKey(node.className, node.field));
          return walk(node.obj);
        case "recordGet":
          if (this.inConstructor || !this.immutable?.recordField(node.shapeId, node.field))
            out.push(`r:${node.field}`, ANY_RECORD_KEY);
          return walk(node.obj);
        case "arrayGet":
          out.push(ARRAY_KEY);
          return this.expr(node.index) === null && walk(node.arr);
        case "recordKeyGet":
          // Any declared field or overflow entry the key may name.
          out.push(ANY_RECORD_KEY);
          for (const f of this.records.get(node.shapeId)?.fields ?? []) out.push(`r:${f.name}`);
          return this.expr(node.key) === null && walk(node.obj);
        case "nullish":
          // `r[k] ?? d`: a hit is the read's own value; the default runs only
          // on a miss and is owned apart from any location.
          return walk(node.left);
        case "mapIntrinsic":
          // A typed Map.get: any entry of any map.
          if (node.method !== "get" || node.args.length !== 1 || !borrowsMapReadInputs(node))
            return false;
          out.push(MAP_KEY);
          return this.expr(node.args[0]!) === null && walk(node.receiver);
        case "unionNarrow":
        case "upcast":
        case "downcast":
          return walk(node.value);
        case "unionWrap":
          return node.value.kind === "unitLit" || walk(node.value);
        case "ternary":
          return this.expr(node.cond) === null && armWalk(node.then) && armWalk(node.else_);
        case "seqExpr": {
          // Guarded projections: `(check, value)` where the checks only
          // read and throw.
          if (this.stmts(node.stmts) !== null) return false;
          return walk(node.result);
        }
        case "strLit":
          return true;
        case "call": {
          const keys = call?.(node) ?? null;
          if (keys === null) return false;
          out.push(...keys);
          return node.args.every((arg) => !isRefCounted(arg.type) || walk(arg));
        }
        default:
          return false;
      }
    };
    const armWalk = (node: IrExpr): boolean =>
      (node.kind === "libCall" && node.fn === "error.nodeThrow") || walk(node);
    return walk(e) ? out : null;
  }
}

interface WriteSink {
  add(key: string): void;
  all(): void;
  /** False when the callee is not a module function. */
  call(callee: string, fresh: boolean): boolean;
}

function isThisRef(e: IrExpr, thisId: string): boolean {
  if (e.kind === "varRef") return e.localId === thisId;
  if (e.kind === "upcast") return isThisRef(e.value, thisId);
  return false;
}

/** A write whose receiver is a private array of the current function. */
function privateReceiver(arr: IrExpr, privates: ReadonlySet<string>): boolean {
  return privates.size > 0 && arr.kind === "varRef" && privates.has(arr.localId);
}

/** Array methods a private array may receive: they neither read an
 * element out nor let the array escape. */
const PRIVATE_ARRAY_METHODS = new Set(["length", "push"]);

/** The nodes the scans below read. */
const CALL_KINDS: readonly IrNodeKind[] = ["call"];
const CALL_SITE_KINDS: readonly IrNodeKind[] = ["call", "new", "virtualCall", "closure"];
const DEFINITION_KINDS: readonly IrNodeKind[] = ["assignExpr", "incDec", "varDecl", "assign"];

/** The nodes privateArrays reads. */
const PRIVATE_ARRAY_KINDS: readonly IrNodeKind[] = [
  "varRef",
  "assignExpr",
  "incDec",
  "closure",
  "classRef",
  "arrIntrinsic",
  "arrayHas",
  "varDecl",
  "assign",
  "arraySet",
  "arraySetUndefined",
  "arrayDelete",
  "arraySetLength",
  "return",
];

/** Array locals whose storage the function allocated itself and that
 * nothing else can reach before the function returns them: declared once
 * from an array literal or `new Array(n)`, never rebound, unboxed, and
 * otherwise only the receiver of element stores, length updates, `length`,
 * `push` and presence tests, or the value of a `return`. No code reads an
 * element of such an array or reaches its storage through another path, so
 * its element stores cannot release a value that a borrow depends on:
 * a borrow's own location stays unwritten, and the array is not one. The
 * stores are private to the activation, like writes of its locals, and
 * stay out of the function's summary (a caller's borrows predate the
 * array). The literal map, filter and fused-pipeline helpers fill their
 * results this way. */
function privateArrays(
  fn: IrFunction,
  boxed: ReadonlySet<string>,
  nodes: IrNodeIndex | undefined,
): ReadonlySet<string> {
  if (fn.async || fn.generator) return new Set();
  const candidates = new Set<string>();
  for (const local of fn.locals)
    if (local.type.kind === "array" && !local.boxed && !boxed.has(local.id))
      candidates.add(local.id);
  if (candidates.size === 0) return candidates;
  const declarations = new Map<string, number>();
  const rejected = new Set<string>();
  // Permitted positions per varRef node (lowering may share one node
  // between several positions, so each visit consumes one permission).
  const permitted = new Map<IrExpr, number>();
  const permit = (e: IrExpr): void => {
    if (e.kind === "varRef" && candidates.has(e.localId))
      permitted.set(e, (permitted.get(e) ?? 0) + 1);
  };
  eachNodeOfKinds(fn, nodes?.scan(PRIVATE_ARRAY_KINDS), (node) => {
    switch (node.kind) {
      case "varRef": {
        const left = permitted.get(node) ?? 0;
        if (left === 0) rejected.add(node.localId);
        else permitted.set(node, left - 1);
        break;
      }
      case "assignExpr":
      case "incDec":
        rejected.add(node.localId);
        break;
      case "closure":
      case "classRef":
        for (const id of node.captures ?? []) rejected.add(id);
        break;
      case "arrIntrinsic":
        if (PRIVATE_ARRAY_METHODS.has(node.method)) permit(node.receiver);
        break;
      case "arrayHas":
        permit(node.arr);
        break;
      case "varDecl":
        declarations.set(node.localId, (declarations.get(node.localId) ?? 0) + 1);
        if (
          node.init === null ||
          (node.init.kind !== "arrayLit" && node.init.kind !== "arrayNewLen")
        )
          rejected.add(node.localId);
        break;
      case "assign":
        rejected.add(node.localId);
        break;
      case "arraySet":
      case "arraySetUndefined":
      case "arrayDelete":
      case "arraySetLength":
        permit(node.arr);
        break;
      case "return":
        if (node.value !== null) permit(node.value);
        break;
    }
  });
  const out = new Set<string>();
  for (const id of candidates) if (!rejected.has(id) && declarations.get(id) === 1) out.add(id);
  return out;
}

/** Locals living in boxes: declared boxed or captured from an enclosing
 * function. */
function boxedLocals(fn: IrFunction): Set<string> {
  const out = new Set<string>();
  for (const local of fn.locals) if (local.boxed) out.add(local.id);
  for (const c of fn.captures ?? []) out.add(c.localId);
  for (const c of fn.classCaptures ?? []) out.add(c.localId);
  return out;
}

/** The closure bodies a function value can be, when it flows only from
 * closure expressions through stable locals and the function-typed
 * parameters of functions that are only called directly (null: any
 * function value). A small flow analysis over parameter positions: each
 * position collects the targets every direct, virtual and `new` call site
 * passes, to a fixpoint. */
class CallTargets {
  private readonly sites = new Map<string, { caller: IrFunction; args: readonly IrExpr[] }[]>();
  private readonly opaque = new Set<string>();
  private readonly params = new Map<string, Set<string> | null>();
  private readonly definitions = new Map<IrFunction, Map<string, IrExpr | null>>();
  /** Functions creating each closure body. */
  private readonly creators = new Map<string, IrFunction[]>();

  constructor(
    private readonly functions: ReadonlyMap<string, IrFunction>,
    virtualTargets: VirtualTargets,
    private readonly nodes: IrNodeIndex | undefined,
  ) {
    const site = (callee: string, caller: IrFunction, args: readonly IrExpr[]): void => {
      let list = this.sites.get(callee);
      if (!list) this.sites.set(callee, (list = []));
      list.push({ caller, args });
    };
    const scan = nodes?.scan(CALL_SITE_KINDS);
    for (const fn of functions.values()) {
      if (fn.captures !== undefined || fn.classCaptures !== undefined) this.opaque.add(fn.name);
      eachNodeOfKinds(fn, scan, (node) => {
        if (node.kind === "call") site(node.callee, fn, node.args);
        else if (node.kind === "new")
          site(`%${node.className}.constructor`, fn, [node, ...node.args]);
        else if (node.kind === "virtualCall") {
          const targets = virtualTargets.targets(node.className, node.method);
          for (const t of targets ?? []) site(t, fn, node.args);
        } else if (node.kind === "closure") {
          this.opaque.add(node.fnName);
          let list = this.creators.get(node.fnName);
          if (!list) this.creators.set(node.fnName, (list = []));
          list.push(fn);
        }
      });
    }
    // Fixpoint over function-typed parameter positions.
    const positions: [IrFunction, number][] = [];
    for (const fn of functions.values())
      fn.params.forEach((p, i) => {
        if (p.type.kind === "func") {
          positions.push([fn, i]);
          this.params.set(`${fn.name}#${i}`, new Set());
        }
      });
    for (let changed = true; changed;) {
      changed = false;
      for (const [fn, i] of positions) {
        const key = `${fn.name}#${i}`;
        const known = this.params.get(key);
        if (known === null) continue;
        const sites = this.sites.get(fn.name);
        let next: Set<string> | null = new Set(known!);
        if (this.opaque.has(fn.name) || !sites || this.assigned(fn, fn.params[i]!.localId))
          next = null;
        else
          for (const { caller, args } of sites) {
            const arg = args[i];
            const t = arg === undefined ? null : this.resolve(arg, caller, 0);
            if (t === null) {
              next = null;
              break;
            }
            for (const name of t) next.add(name);
          }
        if (next === null || next.size !== known!.size) {
          this.params.set(key, next);
          changed = true;
        }
      }
    }
  }

  of(callee: IrExpr, fn: IrFunction): readonly string[] | null {
    const t = this.resolve(callee, fn, 0);
    return t === null ? null : [...t];
  }

  private resolve(e: IrExpr, fn: IrFunction, depth: number): ReadonlySet<string> | null {
    if (depth > 8) return null;
    switch (e.kind) {
      case "closure":
        return new Set([e.fnName]);
      case "ternary":
      case "logical":
      case "nullish":
      case "orDefault": {
        const arms = e.kind === "ternary" ? [e.then, e.else_] : [e.left, e.right];
        const out = new Set<string>();
        for (const arm of arms) {
          if (arm.type.kind !== "func") {
            if (arm.kind === "libCall" && arm.fn === "error.nodeThrow") continue;
            if (e.kind === "ternary") return null;
            continue; // the tested operand of `a ?? f`, `a || f`
          }
          const t = this.resolve(arm, fn, depth + 1);
          if (t === null) return null;
          for (const name of t) out.add(name);
        }
        return out;
      }
      case "varRef": {
        if ((fn.captures ?? []).some((c) => c.localId === e.localId)) {
          // A captured binding nothing rebinds holds what it held in every
          // function creating this closure.
          const creators = this.creators.get(fn.name);
          if (!creators || this.assigned(fn, e.localId)) return null;
          const out = new Set<string>();
          for (const creator of creators) {
            const t = this.resolve(e, creator, depth + 1);
            if (t === null) return null;
            for (const name of t) out.add(name);
          }
          return out;
        }
        const index = fn.params.findIndex((p) => p.localId === e.localId);
        if (index >= 0) {
          if (this.assigned(fn, e.localId)) return null;
          return this.params.get(`${fn.name}#${index}`) ?? null;
        }
        const def = this.definition(fn, e.localId);
        return def ? this.resolve(def, fn, depth + 1) : null;
      }
      case "call": {
        // A function value returned by a module function: whatever every
        // return yields (adapters return closures over their argument).
        const callee = this.functions.get(e.callee);
        if (!callee || callee.async || callee.generator) return null;
        const out = new Set<string>();
        let ok = true;
        let any = false;
        const stmt = (st: IrStmt): boolean => {
          if (st.kind === "return") {
            any = true;
            const t = st.value ? this.resolve(st.value, callee, depth + 1) : null;
            if (t === null) return (ok = false);
            for (const name of t) out.add(name);
          }
          return everyStmtChild(st, () => true, stmt);
        };
        callee.body.every(stmt);
        return ok && any ? out : null;
      }
      default:
        return null;
    }
  }

  /** The single initializer of a never-assigned, unboxed local. */
  private definition(fn: IrFunction, id: string): IrExpr | null {
    let defs = this.definitions.get(fn);
    if (!defs) {
      defs = new Map();
      const boxed = new Set(fn.locals.filter((l) => l.boxed).map((l) => l.id));
      const counts = new Map<string, number>();
      eachNodeOfKinds(fn, this.nodes?.scan(DEFINITION_KINDS), (node) => {
        if (node.kind === "assignExpr" || node.kind === "incDec") counts.set(node.localId, 2);
        else if (node.kind === "varDecl") {
          counts.set(node.localId, (counts.get(node.localId) ?? 0) + 1);
          defs!.set(node.localId, node.init);
        } else if (node.kind === "assign") counts.set(node.localId, 2);
      });
      for (const [local, n] of counts) if (n !== 1 || boxed.has(local)) defs.set(local, null);
      this.definitions.set(fn, defs);
    }
    return defs.get(id) ?? null;
  }

  private assigned(fn: IrFunction, id: string): boolean {
    this.definition(fn, id);
    const defs = this.definitions.get(fn)!;
    return defs.has(id);
  }
}

function setBit(bits: Uint32Array, id: number): void {
  const w = id >>> 5;
  bits[w] = bits[w]! | (1 << (id & 31));
}

function orInto(bits: Uint32Array, other: Uint32Array): void {
  for (let w = 0; w < bits.length; w++) bits[w] = bits[w]! | other[w]!;
}

function anyBit(bits: Uint32Array): boolean {
  for (let w = 0; w < bits.length; w++) if (bits[w] !== 0) return true;
  return false;
}
