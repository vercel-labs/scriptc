/* Lazy module initializers (see deferClosedInitializers). The pass is a pure
 * function of the IR module; initializerTrace reads the environment. */
import {
  BOOL,
  F64,
  VOID,
  type IrExpr,
  type IrFunction,
  type IrGlobal,
  type IrModule,
  type IrStmt,
  type IrType,
  type SrcLoc,
} from "../ir/ir.js";
import type { IrLibFn } from "../ir/builtin-signatures.js";
import {
  everyExprChild,
  everyStmtChild,
  transformStmtList,
  type IrTransform,
} from "../ir/traverse.js";
import {
  eachNodeOfKinds,
  type IrNodeIndex,
  type IrNodeKind,
  LOCAL_BINDING_KINDS,
} from "../ir/node-index.js";
import { computeMayThrow } from "./may-throw.js";

/** Why a module initializer stays where it is (the `explain` callback). */
export interface LazyInitializerVerdict {
  init: string;
  /** The deferred group the initializer joined, or null when it stays. */
  group: string | null;
  /** For an initializer that stays: the first reason found. */
  reason?: string;
  loc?: SrcLoc | null;
}

const INIT = "%init.";
/** The run of group N is `%lazy.N`; a member's place is `%lazy.at.<module>`. */
const RUN = "%lazy.";
const PLACE = "%lazy.at.";

/** Whether `name` is the run of a deferred group (the function a guard
 * calls), as opposed to a member's place. */
export function isLazyGroupRun(name: string): boolean {
  return name.startsWith(RUN) && !name.startsWith(PLACE);
}

/** SCRIPTC_INITIALIZERS_TRACE=defer at build time prints the verdict for
 * every module initializer of the program, in the form of the trace of
 * deferred island loads (`[node-islands] defer|eager <path>: <reason>`,
 * node-islands/snapshot.ts): `defer` for a module that runs at the first use
 * of what it makes, `eager` with the first reason found for one that stays
 * where it is. Answers the `explain` callback of deferClosedInitializers, or
 * undefined when the variable does not ask. A build answered from the
 * executable cache emits no module and prints nothing. */
export function initializerTrace(
  mod: IrModule,
  env: NodeJS.ProcessEnv = process.env,
  write: (line: string) => void = (line) => void process.stderr.write(line),
): ((verdict: LazyInitializerVerdict) => void) | undefined {
  const asked = env["SCRIPTC_INITIALIZERS_TRACE"];
  if (asked === undefined || !asked.includes("defer")) return undefined;
  const files = new Map<string, string>();
  for (const fn of mod.functions) if (fn.name.startsWith(INIT)) files.set(fn.name, fn.loc.file);
  return (verdict) => {
    const file = files.get(verdict.init) ?? verdict.init;
    if (verdict.group !== null) {
      write(
        `[initializers] defer ${file}: runs at the first use of what it makes (${verdict.group})\n`,
      );
      return;
    }
    const loc = verdict.loc;
    const at = !loc ? "" : ` (offset ${loc.start}${loc.file === file ? "" : ` of ${loc.file}`})`;
    write(`[initializers] eager ${file}: ${verdict.reason ?? "it stays where it is"}${at}\n`);
  };
}

/** The binding nodes: reads and writes of locals and module globals. */
const BINDING_KINDS: readonly IrNodeKind[] = [...LOCAL_BINDING_KINDS, "varRef"];
const INIT_USE_KINDS: readonly IrNodeKind[] = ["call", "closure"];
const CLOSURE_KINDS: readonly IrNodeKind[] = ["closure"];

/** Statements a closed initializer may run. Each only moves values between
 * locals, module globals and objects of the heap: no input, no output, no
 * scheduling. Whether one can throw is computeMayThrow's question, asked
 * below of exactly the code an initializer reaches. */
const CLOSED_STMTS: ReadonlySet<IrStmt["kind"]> = new Set<IrStmt["kind"]>([
  "varDecl",
  "assign",
  "exprStmt",
  "if",
  "while",
  "doWhile",
  "for",
  "forOf",
  "switch",
  "block",
  "break",
  "continue",
  "return",
  "arraySet",
  "arraySetUndefined",
  "arrayDelete",
  "fieldSet",
  "recordSet",
  "recordKeySet",
  "recordKeyDelete",
]);

/** Expressions a closed initializer may evaluate: literals, arithmetic,
 * typed records, arrays, maps, sets, strings, unions, class fields, closures
 * and calls of the program's own functions. Left out on purpose: every
 * dynamic-tier operation (its callee and its receiver are whatever the value
 * holds at run time, and nearly all of them can throw), promises and
 * awaits (scheduling), typed arrays and dates (construction can throw or
 * reads the clock and the time zone), virtual calls and class values (the
 * callee set is the whole hierarchy), and the handle kinds (files, sockets,
 * processes). `libCall` and `intrinsic` are closed by name, `strIntrinsic`
 * by method (below). */
const CLOSED_EXPRS: ReadonlySet<IrExpr["kind"]> = new Set<IrExpr["kind"]>([
  "numLit",
  "strLit",
  "boolLit",
  "unitLit",
  "constCell",
  "varRef",
  "selfRef",
  "assignExpr",
  "incDec",
  "bin",
  "unary",
  "logical",
  "ternary",
  "nullish",
  "orDefault",
  "optChain",
  "seqExpr",
  "toBool",
  "toString",
  "strConcat",
  "strCmp",
  "strEq",
  "strIntrinsic",
  "templateStrings",
  "regexLit",
  "regexIntrinsic",
  "arrayLit",
  "arrayNewLen",
  "arrayGet",
  "arrayHas",
  "arrayState",
  "arrIntrinsic",
  "recordLit",
  "recordClone",
  "recordGet",
  "recordHas",
  "recordKeyGet",
  "recordNullProto",
  "recordOvfHas",
  "recordOvfKeys",
  "mapNew",
  "mapIntrinsic",
  "setNew",
  "setIntrinsic",
  "unionWrap",
  "unionNarrow",
  "unionRetype",
  "unionDisc",
  "unionEq",
  "unionFuncEq",
  "unionIsTag",
  "unionKeyGet",
  "upcast",
  "downcast",
  "fieldGet",
  "fieldAbsent",
  "fieldIncDec",
  "instanceOf",
  "new",
  "call",
  "callValue",
  "closure",
  "libCall",
]);

/** Library calls with no effect outside the heap and no input but their
 * arguments: no clock, no random numbers, no locale, no environment, no
 * file, no output. `math.random`, the locale-sensitive string forms and
 * everything that touches the process stay out. */
const CLOSED_LIB_FNS: ReadonlySet<IrLibFn> = new Set<IrLibFn>([
  "math.floor",
  "math.abs",
  "math.round",
  "math.trunc",
  "math.ceil",
  "math.sin",
  "math.sinh",
  "math.cos",
  "math.cosh",
  "math.tan",
  "math.tanh",
  "math.asin",
  "math.asinh",
  "math.acos",
  "math.acosh",
  "math.atan",
  "math.atanh",
  "math.cbrt",
  "math.clz32",
  "math.sign",
  "math.exp",
  "math.expm1",
  "math.f16round",
  "math.fround",
  "math.sqrt",
  "math.log",
  "math.log1p",
  "math.log2",
  "math.log10",
  "math.atan2",
  "math.pow",
  "math.imul",
  "math.min",
  "math.max",
  "math.maxArr",
  "math.minArr",
  "math.hypotArr",
  "num.parseInt",
  "num.parseFloat",
  "num.fromString",
  "num.isNaN",
  "num.sameValue",
  "number.isFinite",
  "number.isNaN",
  "number.isInteger",
  "number.isSafeInteger",
  "string.fromCharCode",
  "string.lastIndexOf",
  "string.lastIndexOfFrom",
  "str.substr",
  "str.replaceLiteral",
  "str.replaceChars",
  "str.codePoints",
  "array.undefinedKey",
]);

/** String methods that read the process's locale or can throw stay out
 * (`normalize`, `repeat`); the rest are functions of their operands. */
const OPEN_STR_METHODS: ReadonlySet<string> = new Set(["normalize", "repeat"]);

/** A deferred group needs this many nodes in its initializers' own
 * statements, or a call or a loop among them. An initializer of a few
 * literals costs less at start than its guards would cost later, and
 * leaving it alone keeps the programs that only have such initializers
 * byte-identical. */
const MIN_DEFERRED_NODES = 64;

/** A synchronous module initializer that runs its body at most once. */
interface InitShape {
  /** The run-once flag. */
  guard: string;
  /** The form of a module the program can load again after its evaluation
   * threw (a target of `import()` or a static dependency of one): the error
   * is kept in `error`, `failed` says so, and every later call of the
   * initializer throws it again. Null for the plain form. */
  record: { error: string; failed: string; caught: string } | null;
  /** The statements behind the guard: the loads of other modules, then the
   * module's own. */
  inner: readonly IrStmt[];
}

/** The two forms lowering gives a guarded synchronous initializer:
 *
 *     if (loaded) return;                    if (loaded) { if (failed) throw error; return; }
 *     loaded = true;                         loaded = true;
 *     ...inner                               try { ...inner }
 *                                            catch (e) { error = e; failed = true; throw e; }
 *
 * Null for every other function: the entry's initializer (no guard), one
 * that awaits, a CommonJS module's (its body registers the module). */
function initializerShape(
  fn: IrFunction,
  globals: ReadonlyMap<string, IrGlobal>,
): InitShape | null {
  if (fn.async || fn.generator || fn.captures?.length || fn.params.length > 0) return null;
  const check = fn.body[0],
    set = fn.body[1];
  if (
    check?.kind !== "if" ||
    check.cond.kind !== "varRef" ||
    check.else_ !== null ||
    set?.kind !== "assign" ||
    set.localId !== check.cond.localId ||
    set.value.kind !== "boolLit" ||
    !set.value.value
  )
    return null;
  const flag = globals.get(set.localId);
  if (flag?.type.kind !== "bool" || flag.tdz === true) return null;
  const last = check.then[check.then.length - 1];
  if (last?.kind !== "return" || last.value !== null) return null;
  if (check.then.length === 1) return { guard: flag.id, record: null, inner: fn.body.slice(2) };
  // The error-recording form.
  const again = check.then[0];
  const body = fn.body[2];
  if (
    check.then.length !== 2 ||
    fn.body.length !== 3 ||
    again?.kind !== "if" ||
    again.cond.kind !== "varRef" ||
    again.else_ !== null ||
    again.then.length !== 1 ||
    again.then[0]?.kind !== "rethrow" ||
    body?.kind !== "tryCatch" ||
    body.finallyBody !== null ||
    body.catchLocalId === null ||
    body.catchBody?.length !== 3
  )
    return null;
  const [keep, mark, raise] = body.catchBody;
  const error = again.then[0].localId;
  const failed = again.cond.localId;
  if (
    keep?.kind !== "assign" ||
    keep.localId !== error ||
    keep.value.kind !== "varRef" ||
    keep.value.localId !== body.catchLocalId ||
    mark?.kind !== "assign" ||
    mark.localId !== failed ||
    mark.value.kind !== "boolLit" ||
    !mark.value.value ||
    raise?.kind !== "rethrow" ||
    raise.localId !== body.catchLocalId ||
    !globals.has(error) ||
    globals.get(failed)?.type.kind !== "bool"
  )
    return null;
  return {
    guard: flag.id,
    record: { error, failed, caught: body.catchLocalId },
    inner: body.tryBody,
  };
}

/** `%init.N();` as a statement, or null. */
function initCall(stmt: IrStmt): string | null {
  return stmt.kind === "exprStmt" &&
    stmt.expr.kind === "call" &&
    stmt.expr.callee.startsWith(INIT) &&
    stmt.expr.args.length === 0
    ? stmt.expr.callee
    : null;
}

/** Whether every module load of an initializer precedes its own statements:
 * the shape of a module whose imports are all `import` declarations. Its
 * imports then run, in order, before anything of its own does. */
function loadsFirst(inner: readonly IrStmt[]): boolean {
  let own = false;
  for (const stmt of inner) {
    if (initCall(stmt) === null) own = true;
    else if (own) return false;
  }
  return true;
}

/** What one function does, as far as closedness goes. */
interface FnFacts {
  /** Null when every node is closed; else the first node that is not. */
  open: { what: string; loc: SrcLoc | null } | null;
  /** The module globals the body names. */
  globals: Set<string>;
  /** The functions it can enter: callees, constructors, closure bodies. */
  reaches: Set<string>;
  /** Nodes in the body, and whether a call or a loop is among them. */
  nodes: number;
  works: boolean;
  /** The body holds statements forThrowAnalysis rewrites. */
  rewrites: boolean;
}

/** `body` as computeMayThrow should read it: without the statements this
 * pass knows cannot throw although their kind can.
 *
 * - `arraySetLength` with `reserve` asks for dense storage ahead of the
 *   statements that fill a fresh array; it changes no length and cannot
 *   fail (scr_arr_reserve_len returns when the request is out of range).
 * - `arraySetLength` of a fresh array to another array's length
 *   (settledLength): a valid length, on an array nothing has frozen.
 * - `try`/`catch`: read as its try body followed by its finally body. If
 *   the function cannot throw in that form, the try body cannot, so the
 *   catch never runs and the original cannot throw either; if the try body
 *   can throw, the form without the catch says so. */
function forThrowAnalysis(body: IrStmt[], settled: ReadonlySet<IrStmt>): IrStmt[] {
  return transformStmtList(body, {
    expr: (e) => e,
    stmt: (s) => {
      if (s.kind === "arraySetLength" && (s.reserve === true || settled.has(s)))
        return { kind: "block", body: [], loc: s.loc };
      if (s.kind === "tryCatch")
        return { kind: "block", body: [...s.tryBody, ...(s.finallyBody ?? [])], loc: s.loc };
      return s;
    },
  });
}

/** Whether `length` is a valid array length whatever runs: an integer
 * literal in range, the length of an array (through a local that holds
 * one), such a value minus zero, or a choice between two of them. */
function settledLength(length: IrExpr, lengths: ReadonlySet<string>): boolean {
  switch (length.kind) {
    case "numLit":
      return Number.isInteger(length.value) && length.value >= 0 && length.value <= 0xffffffff;
    case "varRef":
      return lengths.has(length.localId);
    case "arrIntrinsic":
      return length.method === "length";
    case "bin":
      return (
        length.op === "-" &&
        length.right.kind === "numLit" &&
        length.right.value === 0 &&
        settledLength(length.left, lengths)
      );
    case "ternary":
      return settledLength(length.then, lengths) && settledLength(length.else_, lengths);
    default:
      return false;
  }
}

/** Run closed module initializers at the first use of what they make.
 *
 * A module's top-level code runs before `main`, whether or not the program
 * then uses what it built. A group of initializers is deferred when the
 * compiler can prove that running it later is unobservable:
 *
 * - closed: everything the initializers can reach (their statements, the
 *   functions they call, the closures they create) only computes on the
 *   heap. No output, no input (clock, random numbers, environment, files,
 *   locale), no scheduling, no dynamic-tier operation.
 * - cannot throw: computeMayThrow, asked of exactly that code. An error
 *   would otherwise be raised at the first use instead of at the import.
 * - owns what it touches: every module global that code names is guarded
 *   everywhere in the program, and none is assigned by an initializer that
 *   stays. So until a guard fires, nothing outside the group has read or
 *   written any state the group reads or writes.
 *
 * Initializers that share a global form one group, behind one flag. Each
 * member keeps its place in the order modules are loaded in, whatever
 * loads them: every call of a member's initializer (an importer's header,
 * the helper of an `import()`, a `require()` inside a function) becomes a
 * call of its place, `%lazy.at.N`. A place loads the member's own imports,
 * as the initializer's header did, and then notes that the member was
 * reached: it puts the member on its group's list. Nothing else happens
 * there while the group is idle. The first guard that fires makes the
 * group active and runs the members on the list, in the order they were
 * reached; from then on a member runs at its place, as it always did. A
 * member therefore never runs before its place, and it runs after its
 * place only across code that touched nothing of the group's, which is why
 * the delay cannot be seen.
 *
 * A module the program can load again after its evaluation threw (a target
 * of `import()` or a static dependency of one) has the error-recording
 * form: the error is kept and thrown again at every later load. A member's
 * own statements cannot throw, so the only error such a module can record
 * is one of its imports. Its place records that error where the
 * initializer did and throws it again when the place is visited again; the
 * member is then never put on the list, as its statements never ran.
 *
 * Every function that names one of the group's globals gets a guard
 * (`if (!active) { run(); active = true; }`) before the first statement
 * that does, outside any loop of the function, and inside the branch (or
 * the `try`) when only that names one. A group that is never used costs a
 * few stores; reads in a loop pay no guard.
 *
 * Left where they are: the roots (the entry, a fork target), a module
 * whose initializer awaits or registers a CommonJS module, a module of an
 * import cycle, a module that loads another after its own first statement,
 * anything whose globals are captured, flagged for a temporal dead zone or
 * named by class metadata, groups too small to be worth a guard, and
 * groups the start-up code uses for certain. Library builds and worker
 * programs are not touched. */
export function deferClosedInitializers(
  mod: IrModule,
  nodes?: IrNodeIndex,
  explain?: (verdict: LazyInitializerVerdict) => void,
): IrModule {
  if (mod.lib || mod.workers || !mod.globals?.length) return mod;
  const globals = new Map(mod.globals.map((g) => [g.id, g]));
  const fns = new Map(mod.functions.map((fn) => [fn.name, fn]));

  // The initializers, their forms and their loads of each other.
  const inits = mod.functions.filter((fn) => fn.name.startsWith(INIT));
  if (inits.length < 2) return mod;
  const initNames = new Set(inits.map((fn) => fn.name));
  const shapes = new Map<string, InitShape>();
  /** By initializer: the modules its import declarations load, in order. */
  const calls = new Map<string, string[]>();
  for (const fn of inits) {
    const shape = initializerShape(fn, globals);
    if (shape !== null) shapes.set(fn.name, shape);
    const list: string[] = [];
    for (const stmt of shape?.inner ?? fn.body) {
      const callee = initCall(stmt);
      if (callee !== null) list.push(callee);
    }
    calls.set(fn.name, list);
  }
  // Who calls an initializer, anywhere: an importer's header, the helper of
  // an `import()`, a `require()` inside a function. The roots are the ones
  // `%main` calls (the entry, a fork target); they never move. A function
  // value of an initializer has no call a place could stand for.
  const roots = new Set<string>();
  /** By initializer: the functions that call it. */
  const callers = new Map<string, Set<string>>();
  const asValue = new Set<string>();
  const callScan = nodes?.scan(INIT_USE_KINDS);
  for (const fn of mod.functions) {
    eachNodeOfKinds(fn, callScan, (node) => {
      if (node.kind === "closure") {
        if (initNames.has(node.fnName)) asValue.add(node.fnName);
        return;
      }
      if (node.kind !== "call" || !initNames.has(node.callee)) return;
      if (fn.name === mod.entry) roots.add(node.callee);
      let list = callers.get(node.callee);
      if (!list) callers.set(node.callee, (list = new Set()));
      list.add(fn.name);
    });
  }
  if (roots.size === 0) return mod;
  const reachedFrom = (from: Iterable<string>): Set<string> => {
    const seen = new Set<string>(from);
    const work = [...seen];
    while (work.length > 0)
      for (const callee of calls.get(work.pop()!) ?? [])
        if (!seen.has(callee)) {
          seen.add(callee);
          work.push(callee);
        }
    return seen;
  };
  // Initializers on an import cycle reach themselves.
  const cyclic = new Set<string>();
  for (const fn of inits) {
    const below = reachedFrom(calls.get(fn.name) ?? []);
    if (below.has(fn.name)) cyclic.add(fn.name);
  }

  const verdicts = new Map<string, LazyInitializerVerdict>();
  const stays = (init: string, reason: string, loc?: SrcLoc | null): void => {
    if (!verdicts.has(init)) verdicts.set(init, { init, group: null, reason, loc: loc ?? null });
  };
  const candidates = new Set<string>();
  for (const fn of inits) {
    const shape = shapes.get(fn.name);
    if (roots.has(fn.name)) stays(fn.name, "the entry module");
    else if (shape === undefined)
      stays(fn.name, "its initializer awaits, or registers a CommonJS module");
    else if (asValue.has(fn.name)) stays(fn.name, "its initializer is held as a function value");
    else if (cyclic.has(fn.name)) stays(fn.name, "the module is on an import cycle");
    else if (!loadsFirst(shape.inner))
      stays(fn.name, "it loads a module after its own first statement");
    else candidates.add(fn.name);
  }
  const report = (): void => {
    if (explain)
      for (const fn of inits) explain(verdicts.get(fn.name) ?? { init: fn.name, group: null });
  };
  if (candidates.size === 0) {
    report();
    return mod;
  }

  // Closedness, one function at a time, on demand.
  const classes = new Map((mod.classes ?? []).map((cls) => [cls.name, cls]));
  const facts = new Map<string, FnFacts>();
  /** Length assignments proven unable to fail (settledLength). */
  const settled = new Set<IrStmt>();
  const factsOf = (fn: IrFunction, body: readonly IrStmt[]): FnFacts => {
    const f: FnFacts = {
      open: null,
      globals: new Set(),
      reaches: new Set(),
      nodes: 0,
      works: false,
      rewrites: false,
    };
    const open = (what: string, loc: SrcLoc | null): boolean => {
      f.open = { what, loc };
      return false;
    };
    if (fn.async || fn.generator) {
      open(fn.async ? "an async function" : "a generator", fn.loc);
      return f;
    }
    const name = (id: string): void => {
      if (globals.has(id)) f.globals.add(id);
    };
    // Locals written once, where they are declared: one that holds a new
    // array literal names a fresh array, one that holds an array's length
    // a valid length.
    const constLocals = new Set(fn.locals.filter((l) => !l.mutable).map((l) => l.id));
    const freshArrays = new Set<string>();
    const lengthLocals = new Set<string>();
    const expr = (e: IrExpr): boolean => {
      f.nodes++;
      if (!CLOSED_EXPRS.has(e.kind)) return open(`a '${e.kind}' expression`, e.loc);
      switch (e.kind) {
        case "varRef":
        case "assignExpr":
        case "incDec":
          name(e.localId);
          break;
        case "libCall":
          if (!CLOSED_LIB_FNS.has(e.fn)) return open(`the builtin ${e.fn}`, e.loc);
          break;
        case "strIntrinsic":
          if (OPEN_STR_METHODS.has(e.method)) return open(`String.prototype.${e.method}`, e.loc);
          break;
        case "call":
          if (e.callee.startsWith(INIT)) return open("a module load inside an expression", e.loc);
          if (!fns.has(e.callee)) return open(`a call of ${e.callee}`, e.loc);
          f.reaches.add(e.callee);
          f.works = true;
          break;
        case "callValue":
          f.works = true;
          break;
        case "closure":
          for (const id of e.captures)
            if (globals.has(id)) return open("a captured module binding", e.loc);
          if (!fns.has(e.fnName)) return open(`a closure over ${e.fnName}`, e.loc);
          f.reaches.add(e.fnName);
          break;
        case "new": {
          // A class of the runtime (an Error, an emitter, a stream) has
          // behavior the IR does not show; a program class is its
          // constructor function.
          for (
            let cls = classes.get(e.className);
            cls;
            cls = cls.base ? classes.get(cls.base) : undefined
          )
            if (cls.runtime) return open(`a runtime class (${e.className})`, e.loc);
          if (!classes.has(e.className)) return open(`an unknown class (${e.className})`, e.loc);
          const ctor = `%${e.className}.constructor`;
          if (fns.has(ctor)) f.reaches.add(ctor);
          f.works = true;
          break;
        }
        default:
          break;
      }
      return everyExprChild(e, expr, stmt);
    };
    const stmt = (s: IrStmt): boolean => {
      f.nodes++;
      if (s.kind === "arraySetLength") {
        // A capacity hint, or the length of a fresh array set to a length
        // that is always valid.
        const fresh = s.arr.kind === "varRef" && freshArrays.has(s.arr.localId);
        if (s.reserve !== true && !(fresh && settledLength(s.length, lengthLocals)))
          return open("a length assignment", s.loc);
        if (s.reserve !== true) settled.add(s);
        f.rewrites = true;
        return everyStmtChild(s, expr, stmt);
      }
      if (s.kind === "tryCatch") {
        // The catch only runs if the try body throws, which the throw
        // analysis rules out for the whole initializer (forThrowAnalysis).
        f.rewrites = true;
        return s.tryBody.every(stmt) && (s.finallyBody ?? []).every(stmt);
      }
      if (s.kind === "varDecl" && s.init !== null && constLocals.has(s.localId)) {
        if (s.init.kind === "arrayLit" || s.init.kind === "arrayNewLen") freshArrays.add(s.localId);
        else if (s.init.kind === "arrIntrinsic" && s.init.method === "length")
          lengthLocals.add(s.localId);
      }
      if (!CLOSED_STMTS.has(s.kind)) return open(`a '${s.kind}' statement`, s.loc);
      switch (s.kind) {
        case "varDecl":
        case "assign":
        case "forOf":
          name(s.localId);
          break;
        case "while":
        case "doWhile":
        case "for":
          f.works = true;
          break;
        default:
          break;
      }
      if (s.kind === "forOf") f.works = true;
      return everyStmtChild(s, expr, stmt);
    };
    for (const s of body) if (!stmt(s)) break;
    return f;
  };
  const functionFacts = (name: string): FnFacts => {
    let f = facts.get(name);
    if (f === undefined) {
      const fn = fns.get(name)!;
      for (const capture of [...(fn.captures ?? []), ...(fn.classCaptures ?? [])])
        if (globals.has(capture.localId)) {
          f = {
            open: { what: "a captured module binding", loc: fn.loc },
            globals: new Set(),
            reaches: new Set(),
            nodes: 0,
            works: false,
            rewrites: false,
          };
          break;
        }
      f ??= factsOf(fn, fn.body);
      facts.set(name, f);
    }
    return f;
  };
  /** A candidate's own statements: what stands behind its guard, without
   * the loads of other modules. */
  const ownBody = (fn: IrFunction): IrStmt[] =>
    shapes.get(fn.name)!.inner.filter((s) => initCall(s) === null);

  interface Closure {
    own: FnFacts;
    /** Every function the initializer can enter. */
    reached: Set<string>;
    globals: Set<string>;
  }
  const closures = new Map<string, Closure>();
  for (const init of [...candidates]) {
    const fn = fns.get(init)!;
    const own = factsOf(fn, ownBody(fn));
    if (own.open) {
      candidates.delete(init);
      stays(init, own.open.what, own.open.loc);
      continue;
    }
    const reached = new Set<string>();
    const touched = new Set(own.globals);
    const work = [...own.reaches];
    let open: FnFacts["open"] = null;
    while (work.length > 0 && open === null) {
      const callee = work.pop()!;
      if (reached.has(callee)) continue;
      reached.add(callee);
      const f = functionFacts(callee);
      if (f.open) {
        open = { what: `${callee} holds ${f.open.what}`, loc: f.open.loc };
        break;
      }
      for (const g of f.globals) touched.add(g);
      for (const next of f.reaches) if (!reached.has(next)) work.push(next);
    }
    if (open) {
      candidates.delete(init);
      stays(init, open.what, open.loc);
      continue;
    }
    touched.delete(shapes.get(init)!.guard);
    closures.set(init, { own, reached, globals: touched });
  }
  if (candidates.size === 0) {
    report();
    return mod;
  }

  // Who names each global the candidates touch, and how: every use must be
  // one a guard can stand in front of.
  const interesting = new Set<string>();
  for (const init of candidates) for (const g of closures.get(init)!.globals) interesting.add(g);
  /** By global: the functions that name it. */
  const users = new Map<string, Set<string>>();
  /** By global: the functions that assign it. */
  const writers = new Map<string, Set<string>>();
  const unguardable = new Set<string>();
  const bindingScan = nodes?.scan(BINDING_KINDS);
  const closureScan = nodes?.scan(CLOSURE_KINDS);
  for (const fn of mod.functions) {
    for (const capture of [...(fn.captures ?? []), ...(fn.classCaptures ?? [])])
      if (interesting.has(capture.localId)) unguardable.add(capture.localId);
    eachNodeOfKinds(fn, bindingScan, (node) => {
      if (!("localId" in node) || typeof node.localId !== "string") return;
      const id = node.localId;
      if (!interesting.has(id)) return;
      let list = users.get(id);
      if (!list) users.set(id, (list = new Set()));
      list.add(fn.name);
      if (node.kind !== "varRef") {
        let w = writers.get(id);
        if (!w) writers.set(id, (w = new Set()));
        w.add(fn.name);
      }
    });
    eachNodeOfKinds(fn, closureScan, (node) => {
      if (node.kind === "closure")
        for (const id of node.captures) if (interesting.has(id)) unguardable.add(id);
    });
  }
  // Class metadata, records and the like can name a global (a symbol-keyed
  // field's key, a computed base class): the backend reads those without
  // a statement a guard could precede.
  const metadata = (value: unknown, depth: number): void => {
    if (typeof value === "string") {
      if (interesting.has(value)) unguardable.add(value);
    } else if (Array.isArray(value)) {
      for (const item of value) metadata(item, depth + 1);
    } else if (value !== null && typeof value === "object" && depth < 12) {
      for (const item of Object.values(value)) metadata(item, depth + 1);
    }
  };
  for (const [key, value] of Object.entries(mod))
    if (key !== "functions" && key !== "globals") metadata(value, 0);
  for (const cls of mod.classes ?? [])
    for (const capture of cls.localCaptures ?? [])
      if (interesting.has(capture.localId)) unguardable.add(capture.localId);

  // Drop candidates until the rest hold together: every global a candidate
  // touches is guardable and has no dead-zone state of its own. One that an
  // initializer that stays assigns must be a constant of a primitive type:
  // the staying module is an import of the candidate's, so the constant is
  // assigned before the candidate's place and is the same value whenever
  // the candidate reads it. Such a constant is read freely; it is not the
  // group's and gets no guard. Any other value made by a module that stays
  // could have changed by the time the candidate runs.
  const stayingWriter = (id: string): string | null => {
    let staying: string | null = null;
    for (const writer of writers.get(id) ?? []) {
      if (!initNames.has(writer)) continue;
      if (candidates.has(writer)) return null;
      staying = writer;
    }
    return staying;
  };
  const constant = (g: IrGlobal): boolean =>
    !g.mutable && (g.type.kind === "f64" || g.type.kind === "bool" || g.type.kind === "string");
  const settle = (): boolean => {
    let dropped = false;
    for (let changed = true; changed;) {
      changed = false;
      for (const init of [...candidates]) {
        let reason: string | null = null;
        for (const id of closures.get(init)!.globals) {
          const g = globals.get(id)!;
          const writer = stayingWriter(id);
          if (g.tdz === true || g.initFlag !== undefined)
            reason = `'${g.name}' can be read before its declaration`;
          else if (writer !== null) {
            if (!constant(g)) reason = `'${g.name}' is made by a module that stays (${writer})`;
          } else if (unguardable.has(id))
            reason = `'${g.name}' is captured or named by class metadata`;
          if (reason !== null) break;
        }
        if (reason === null) continue;
        candidates.delete(init);
        stays(init, reason);
        changed = true;
        dropped = true;
      }
    }
    return dropped;
  };
  settle();
  if (candidates.size === 0) {
    report();
    return mod;
  }

  // Cannot throw: computeMayThrow over exactly what the candidates reach.
  // Its indirect calls then range over the closures that code creates,
  // which are the only functions a deferred initializer can hold.
  {
    const stripped: IrFunction[] = [];
    const included = new Set<string>();
    for (const init of candidates) {
      const fn = fns.get(init)!;
      const own = ownBody(fn);
      stripped.push({
        ...fn,
        body: closures.get(init)!.own.rewrites ? forThrowAnalysis(own, settled) : own,
      });
      for (const name of closures.get(init)!.reached) included.add(name);
    }
    const reduced: IrModule = {
      ...mod,
      functions: [
        ...stripped,
        ...mod.functions
          .filter((fn) => included.has(fn.name))
          .map((fn) =>
            facts.get(fn.name)?.rewrites ? { ...fn, body: forThrowAnalysis(fn.body, settled) } : fn,
          ),
      ],
    };
    const may = computeMayThrow(reduced, {
      stackChecks: "everyCycleMember",
      explain: explain !== undefined,
    });
    let dropped = false;
    for (const init of [...candidates]) {
      if (!may.fns.has(init)) continue;
      candidates.delete(init);
      const why = may.why?.get(init);
      stays(
        init,
        why === undefined
          ? "it can throw"
          : why.kind === "seed"
            ? `it can throw: ${why.what}`
            : why.kind === "call"
              ? `it can throw: through ${why.callee}`
              : `it can throw: through a function value (${why.target})`,
        why?.loc,
      );
      dropped = true;
    }
    // A candidate that left may have been the one assigning a global the
    // others read.
    if (dropped) settle();
  }
  if (candidates.size === 0) {
    report();
    return mod;
  }

  // Groups: candidates that touch a common global run together.
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    for (let at = x; at !== root;) {
      const next = parent.get(at)!;
      parent.set(at, root);
      at = next;
    }
    return root;
  };
  for (const init of candidates) parent.set(init, init);
  // What a candidate owns: the globals it touches, less the constants of
  // modules that stay.
  for (const init of candidates) {
    const touched = closures.get(init)!.globals;
    for (const id of [...touched]) if (stayingWriter(id) !== null) touched.delete(id);
  }
  const firstToucher = new Map<string, string>();
  for (const fn of inits) {
    if (!candidates.has(fn.name)) continue;
    for (const id of closures.get(fn.name)!.globals) {
      const other = firstToucher.get(id);
      if (other === undefined) firstToucher.set(id, fn.name);
      else parent.set(find(fn.name), find(other));
    }
  }
  // Worth a guard?
  const members = new Map<string, string[]>();
  for (const fn of inits) {
    if (!candidates.has(fn.name)) continue;
    const root = find(fn.name);
    const list = members.get(root);
    if (list) list.push(fn.name);
    else members.set(root, [fn.name]);
  }
  for (const [root, list] of [...members]) {
    let nodeCount = 0;
    let works = false;
    for (const init of list) {
      const own = closures.get(init)!.own;
      nodeCount += own.nodes;
      works ||= own.works;
    }
    if (works || nodeCount >= MIN_DEFERRED_NODES) continue;
    members.delete(root);
    for (const init of list) {
      candidates.delete(init);
      stays(init, "too small to be worth a guard");
    }
  }
  // Used at start for certain? A group whose globals the start-up code
  // names outside any branch or loop would run in full before `main` gets
  // anywhere: deferring it only adds the places and the guards. Start-up
  // code is the top-level statements of the initializers that stay, in the
  // roots' static import tree, and of the functions those statements call,
  // a few calls deep; a statement
  // under an `if`, a loop, a `switch` or a `try` is not counted, since it
  // may not run.
  {
    const ownerRoot = new Map<string, string>();
    for (const [root, list] of members)
      for (const init of list)
        for (const id of closures.get(init)!.globals) ownerRoot.set(id, root);
    const certain = new Map<string, string>();
    const visited = new Set<string>();
    const use = (id: string, by: string): void => {
      const root = ownerRoot.get(id);
      if (root !== undefined && !certain.has(root))
        certain.set(root, `${by} names '${globals.get(id)!.name}'`);
    };
    const scan = (fn: IrFunction, depth: number): void => {
      if (visited.has(fn.name)) return;
      visited.add(fn.name);
      const expr = (e: IrExpr): boolean => {
        if (e.kind === "varRef" || e.kind === "assignExpr" || e.kind === "incDec") {
          use(e.localId, fn.name);
        } else if (e.kind === "call" && depth < 3 && !e.callee.startsWith(INIT)) {
          const callee = fns.get(e.callee);
          if (callee && !callee.async && !callee.generator) scan(callee, depth + 1);
        }
        return everyExprChild(e, expr, () => true);
      };
      const straight = (list: readonly IrStmt[]): void => {
        for (const s of list) {
          switch (s.kind) {
            case "block":
              if (!s.labels?.length) straight(s.body);
              break;
            case "varDecl":
            case "assign":
              use(s.localId, fn.name);
              everyStmtChild(s, expr, () => true);
              break;
            case "exprStmt":
            case "return":
            case "arraySet":
            case "fieldSet":
            case "recordSet":
            case "recordKeySet":
              everyStmtChild(s, expr, () => true);
              break;
            case "if":
              expr(s.cond);
              break;
            default:
              break;
          }
        }
      };
      // An initializer's statements stand behind its guard (inside the
      // `try` of the error-recording form).
      straight(depth === 0 ? (shapes.get(fn.name)?.inner ?? fn.body) : fn.body);
    };
    // The modules the roots load through import declarations: a module
    // only `import()` or a `require()` in a function loads may never run.
    const startUp = reachedFrom(roots);
    for (const fn of inits) if (startUp.has(fn.name) && !candidates.has(fn.name)) scan(fn, 0);
    for (const [root, by] of certain) {
      const list = members.get(root);
      if (!list) continue;
      members.delete(root);
      for (const init of list) {
        candidates.delete(init);
        stays(init, `the start-up code uses it at once (${by})`);
      }
    }
  }
  if (members.size === 0) {
    report();
    return mod;
  }

  // Groups, numbered by their first member in the order of the module's
  // functions; a member's number is its position in its group, from one.
  const groupOf = new Map<string, number>();
  const groupMembers: string[][] = [];
  const numberIn = new Map<string, number>();
  {
    const groupOfRoot = new Map<string, number>();
    for (const fn of inits) {
      if (!candidates.has(fn.name)) continue;
      const root = find(fn.name);
      let group = groupOfRoot.get(root);
      if (group === undefined) {
        group = groupMembers.length;
        groupOfRoot.set(root, group);
        groupMembers.push([]);
      }
      groupOf.set(fn.name, group);
      groupMembers[group]!.push(fn.name);
      numberIn.set(fn.name, groupMembers[group]!.length);
    }
  }
  const activeOf = (group: number): string => `%g.%lazy.${group}`;
  const lastOf = (group: number): string => `%g.%lazy.${group}.last`;
  const runOf = (group: number): string => `${RUN}${group}`;
  const placeOf = (init: string): string => `${PLACE}${init.slice(INIT.length)}`;
  const atOf = (init: string): string => `%g.%lazy.at.${init.slice(INIT.length)}`;
  const linkOf = (init: string): string => `%g.%lazy.link.${init.slice(INIT.length)}`;
  const ownerOf = new Map<string, number>();
  for (const init of candidates)
    for (const id of closures.get(init)!.globals) ownerOf.set(id, groupOf.get(init)!);
  for (const init of candidates) verdicts.set(init, { init, group: runOf(groupOf.get(init)!) });

  const callStmt = (callee: string, loc: SrcLoc): IrStmt => ({
    kind: "exprStmt",
    expr: { kind: "call", callee, args: [], type: VOID, loc },
    loc,
  });
  const num = (value: number, loc: SrcLoc): IrExpr => ({ kind: "numLit", value, type: F64, loc });
  const flag = (value: boolean, loc: SrcLoc): IrExpr => ({
    kind: "boolLit",
    value,
    type: BOOL,
    loc,
  });
  const read = (localId: string, type: IrType, loc: SrcLoc): IrExpr => ({
    kind: "varRef",
    localId,
    type,
    loc,
  });
  const store = (localId: string, value: IrExpr, loc: SrcLoc): IrStmt => ({
    kind: "assign",
    localId,
    value,
    loc,
  });
  const rewritten = new Map<string, IrFunction>();
  const added: IrFunction[] = [];
  const state: IrGlobal[] = [];
  for (const fn of inits) {
    if (!candidates.has(fn.name)) continue;
    const shape = shapes.get(fn.name)!;
    const group = groupOf.get(fn.name)!;
    const loc = fn.loc;
    const at = atOf(fn.name);
    const link = linkOf(fn.name);
    state.push({ id: at, name: "%lazy.at", type: BOOL, mutable: true });
    state.push({ id: link, name: "%lazy.link", type: F64, mutable: true });
    // A member's place stands where its initializer was called: an
    // importer's header, the helper of an `import()`, a `require()`. It
    // loads the member's imports as the initializer's header did, then
    // notes that the member was reached: in an idle group by adding it to
    // the group's list, in an active one by running it. A module the
    // program can load again keeps an error of its imports and throws it
    // again at every later load, as its initializer did.
    const loads = (calls.get(fn.name) ?? []).map((callee) =>
      callStmt(candidates.has(callee) ? placeOf(callee) : callee, loc),
    );
    const record = shape.record;
    const caught = record === null ? undefined : fn.locals.find((l) => l.id === record.caught);
    added.push({
      name: placeOf(fn.name),
      params: [],
      returnType: VOID,
      locals: caught === undefined || loads.length === 0 ? [] : [caught],
      loc,
      body: [
        {
          kind: "if",
          cond: read(at, BOOL, loc),
          then: [
            ...(record === null
              ? []
              : [
                  {
                    kind: "if" as const,
                    cond: read(record.failed, BOOL, loc),
                    then: [{ kind: "rethrow" as const, localId: record.error, loc }],
                    else_: null,
                    loc,
                  },
                ]),
            { kind: "return", value: null, loc },
          ],
          else_: null,
          loc,
        },
        store(at, flag(true, loc), loc),
        ...(record === null || caught === undefined || loads.length === 0
          ? loads
          : [
              {
                kind: "tryCatch" as const,
                tryBody: loads,
                catchBody: [
                  store(record.error, read(caught.id, caught.type, loc), loc),
                  store(record.failed, flag(true, loc), loc),
                  { kind: "rethrow" as const, localId: caught.id, loc },
                ],
                catchLocalId: caught.id,
                finallyBody: null,
                loc,
              },
            ]),
        {
          kind: "if",
          cond: read(activeOf(group), BOOL, loc),
          then: [callStmt(fn.name, loc)],
          else_: [
            store(link, read(lastOf(group), F64, loc), loc),
            store(lastOf(group), num(numberIn.get(fn.name)!, loc), loc),
          ],
          loc,
        },
      ],
    });
    // The member itself: its own statements behind its guard. Its place
    // loaded its imports before it was reached, and its statements cannot
    // throw, so neither the loads nor the error record are needed here.
    rewritten.set(fn.name, {
      ...fn,
      locals: record === null ? fn.locals : fn.locals.filter((l) => l.id !== record.caught),
      body: [
        {
          kind: "if",
          cond: read(shape.guard, BOOL, loc),
          then: [{ kind: "return", value: null, loc }],
          else_: null,
          loc,
        },
        store(shape.guard, flag(true, loc), loc),
        ...ownBody(fn),
      ],
    });
  }
  // Every other call of a member's initializer goes to its place.
  const toPlace: IrTransform = {
    expr: (e) =>
      e.kind === "call" && candidates.has(e.callee) ? { ...e, callee: placeOf(e.callee) } : e,
    stmt: (s) => s,
  };
  for (const init of candidates)
    for (const name of callers.get(init) ?? []) {
      if (candidates.has(name) || rewritten.has(name)) continue;
      const fn = fns.get(name)!;
      rewritten.set(name, { ...fn, body: transformStmtList(fn.body, toPlace) });
    }

  // Guards.
  const accessing = new Set<string>();
  for (const [id, group] of ownerOf)
    for (const user of users.get(id) ?? [])
      // A member runs inside its group's run; every other user is guarded.
      if (!(candidates.has(user) && groupOf.get(user) === group)) accessing.add(user);
  // The store after the run says nothing new (the run sets the flag before
  // it does anything else, so that a guard inside it does not start it
  // again). It is there for the optimizer: the run is a call that could
  // write anything, and with the store the flag is known to be set on
  // every path out of the guard. A loop around an inlined accessor then
  // tests the flag once instead of in every turn.
  const guardStmt = (group: number, loc: SrcLoc): IrStmt => ({
    kind: "if",
    cond: {
      kind: "unary",
      op: "!",
      operand: { kind: "varRef", localId: activeOf(group), type: BOOL, loc },
      type: BOOL,
      loc,
    },
    then: [callStmt(runOf(group), loc), store(activeOf(group), flag(true, loc), loc)],
    else_: null,
    loc,
  });
  for (const name of accessing) {
    const fn = rewritten.get(name) ?? fns.get(name)!;
    const skip = candidates.has(name) ? groupOf.get(name)! : -1;
    const note = (id: string, out: Set<number>): void => {
      const group = ownerOf.get(id);
      if (group !== undefined && group !== skip) out.add(group);
    };
    /** The groups whose globals a statement (or an expression) names. */
    const needs = (node: { stmt: IrStmt } | { expr: IrExpr }, out: Set<number>): void => {
      const expr = (e: IrExpr): boolean => {
        if (e.kind === "varRef" || e.kind === "assignExpr" || e.kind === "incDec")
          note(e.localId, out);
        return everyExprChild(e, expr, stmt);
      };
      const stmt = (s: IrStmt): boolean => {
        if (s.kind === "varDecl" || s.kind === "assign" || s.kind === "forOf") note(s.localId, out);
        return everyStmtChild(s, expr, stmt);
      };
      if ("stmt" in node) stmt(node.stmt);
      else expr(node.expr);
    };
    const place = (list: readonly IrStmt[], ran: Set<number>): IrStmt[] => {
      const out: IrStmt[] = [];
      const guard = (need: Set<number>, loc: SrcLoc): void => {
        for (const group of [...need].sort((a, b) => a - b)) {
          if (ran.has(group)) continue;
          ran.add(group);
          out.push(guardStmt(group, loc));
        }
      };
      for (const s of list) {
        const need = new Set<number>();
        needs({ stmt: s }, need);
        if ([...need].every((group) => ran.has(group))) {
          out.push(s);
          continue;
        }
        // Branches keep their guards inside: a path that names none of the
        // group's globals does not run the group. Everything else, loops
        // first of all, gets its guards in front.
        if (s.kind === "if") {
          const head = new Set<number>();
          needs({ expr: s.cond }, head);
          guard(head, s.loc);
          const then = place(s.then, new Set(ran));
          const else_ = s.else_ === null ? null : place(s.else_, new Set(ran));
          out.push({ ...s, then, else_ });
        } else if (s.kind === "block") {
          // A labeled block can be left early: what it guards is not
          // guarded after it.
          out.push({ ...s, body: place(s.body, s.labels?.length ? new Set(ran) : ran) });
        } else if (s.kind === "tryCatch") {
          // Each body keeps its guards inside, like a branch: the try body
          // can be left before its guard, and a module the program can
          // load again has its whole top level in one.
          out.push({
            ...s,
            tryBody: place(s.tryBody, new Set(ran)),
            catchBody: s.catchBody === null ? null : place(s.catchBody, new Set(ran)),
            finallyBody: s.finallyBody === null ? null : place(s.finallyBody, new Set(ran)),
          });
        } else {
          guard(need, s.loc);
          out.push(s);
        }
      }
      return out;
    };
    rewritten.set(name, { ...fn, body: place(fn.body, new Set()) });
  }

  // The groups' state and runs. A group's list is kept through the members'
  // link slots, newest first (a place only stores twice); the run turns it
  // around and then takes the members in the order their places were
  // reached, which is the order their modules ran in.
  groupMembers.forEach((list, group) => {
    const loc = fns.get(list[0]!)!.loc;
    const active = activeOf(group);
    const last = lastOf(group);
    state.push({ id: active, name: "%lazy", type: BOOL, mutable: true });
    state.push({ id: last, name: "%lazy.last", type: F64, mutable: true });
    const at = `%lazy.${group}.at`;
    const next = `%lazy.${group}.next`;
    const held = `%lazy.${group}.held`;
    const positive = (localId: string): IrExpr => ({
      kind: "bin",
      op: ">",
      left: read(localId, F64, loc),
      right: num(0, loc),
      type: BOOL,
      loc,
    });
    const each = (cases: (member: string) => IrStmt[]): IrStmt => ({
      kind: "switch",
      disc: read(at, F64, loc),
      cases: [
        ...list.map((member) => ({
          test: num(numberIn.get(member)!, loc),
          body: [...cases(member), { kind: "break" as const, loc }],
        })),
        { test: null, body: [store(at, num(0, loc), loc)] },
      ],
      loc,
    });
    added.push({
      name: runOf(group),
      params: [],
      returnType: VOID,
      locals: [
        { id: at, name: "%at", type: F64, mutable: true },
        { id: next, name: "%next", type: F64, mutable: true },
        { id: held, name: "%held", type: F64, mutable: true },
      ],
      loc,
      body: [
        {
          kind: "if",
          cond: read(active, BOOL, loc),
          then: [{ kind: "return", value: null, loc }],
          else_: null,
          loc,
        },
        store(active, flag(true, loc), loc),
        { kind: "varDecl", localId: at, init: read(last, F64, loc), loc },
        { kind: "varDecl", localId: next, init: num(0, loc), loc },
        { kind: "varDecl", localId: held, init: num(0, loc), loc },
        // Newest first becomes oldest first: each link now names the member
        // reached after its own.
        {
          kind: "while",
          cond: positive(at),
          body: [
            each((member) => [
              store(held, read(linkOf(member), F64, loc), loc),
              store(linkOf(member), read(next, F64, loc), loc),
              store(next, read(at, F64, loc), loc),
              store(at, read(held, F64, loc), loc),
            ]),
          ],
          loc,
        },
        store(at, read(next, F64, loc), loc),
        {
          kind: "while",
          cond: positive(at),
          body: [
            each((member) => [
              store(at, read(linkOf(member), F64, loc), loc),
              callStmt(member, loc),
            ]),
          ],
          loc,
        },
      ],
    });
  });
  report();
  return {
    ...mod,
    functions: [...mod.functions.map((fn) => rewritten.get(fn.name) ?? fn), ...added],
    globals: [...mod.globals, ...state],
  };
}
