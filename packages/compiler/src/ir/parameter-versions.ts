import { analyzeInt32Slots } from "./int32-slots.js";
import { BOOL, F64, type IrExpr, type IrFunction, type IrModule, type IrStmt } from "./ir.js";
import { reparseStmt } from "./serialize.js";
import { everyExprChild, everyStmtChild, everyStmtList } from "./traverse.js";

const MAX_FUNCTION_NODES = 2048;
const MAX_VERSIONS = 16;

function size(fn: IrFunction): number {
  let nodes = 0;
  everyStmtList(fn.body, {
    stmt: () => ++nodes <= MAX_FUNCTION_NODES,
    expr: () => ++nodes <= MAX_FUNCTION_NODES,
  });
  return nodes;
}

/** The function a direct call or construction runs, if any. */
function callee(e: IrExpr): string | null {
  if (e.kind === "call") return e.callee;
  if (e.kind === "new") return `%${e.className}.constructor`;
  return null;
}

/** Direct call and construction sites of each function in the module. */
function callSites(mod: IrModule): Map<string, number> {
  const sites = new Map<string, number>();
  for (const fn of mod.functions)
    everyStmtList(fn.body, {
      stmt: () => true,
      expr: (e) => {
        const name = callee(e);
        if (name !== null) sites.set(name, (sites.get(name) ?? 0) + 1);
        return true;
      },
    });
  return sites;
}

/** Expressions and statements of a callee that LLVM inlines at any number
 * of call sites: scalar arithmetic and reads, no calls or allocations. */
const SIMPLE_EXPRESSIONS = new Set<string>([
  "varRef",
  "numLit",
  "boolLit",
  "bin",
  "unary",
  "logical",
  "ternary",
  "toBool",
  "incDec",
  "assignExpr",
  "arrayGet",
  "fieldGet",
  "recordGet",
  "unionNarrow",
  "unionIsTag",
]);
const SIMPLE_STATEMENTS = new Set<string>([
  "varDecl",
  "assign",
  "exprStmt",
  "if",
  "block",
  "return",
]);

function simple(fn: IrFunction): boolean {
  return (
    (fn.returnType.kind === "f64" || fn.returnType.kind === "bool") &&
    everyStmtList(fn.body, {
      stmt: (s) => SIMPLE_STATEMENTS.has(s.kind),
      expr: (e) => SIMPLE_EXPRESSIONS.has(e.kind),
    })
  );
}

/** Whether a copy of `fn` would cost a callee its only call site. LLVM
 * inlines a function called once wherever its size allows; with a second
 * site, both calls can stay out of line, with the records and arguments
 * they pass built in memory. A callee that only computes a number or a
 * boolean from scalar reads inlines either way. A function calling itself
 * would also dispatch on every call. */
function keepsSingleBody(
  fn: IrFunction,
  sites: ReadonlyMap<string, number>,
  functions: ReadonlyMap<string, IrFunction>,
): boolean {
  return !everyStmtList(fn.body, {
    stmt: () => true,
    expr: (e) => {
      const name = callee(e);
      if (name === null) return true;
      if (name === fn.name) return false;
      if (sites.get(name) !== 1) return true;
      const target = functions.get(name);
      return target !== undefined && simple(target);
    },
  });
}

/** Statements and expressions of a loop whose work is numeric: arithmetic,
 * element and field reads and writes, `Math` calls and calls of simple
 * functions. Loops that allocate, build strings or call other code gain
 * little from an integer bound and would only grow the copy. */
const NUMERIC_STATEMENTS = new Set<string>([
  ...SIMPLE_STATEMENTS,
  "for",
  "while",
  "doWhile",
  "break",
  "continue",
  "arraySet",
  "fieldSet",
]);
const NUMERIC_EXPRESSIONS = new Set<string>([...SIMPLE_EXPRESSIONS, "arrayHas", "arrayState"]);

function numericLoop(loop: IrStmt, functions: ReadonlyMap<string, IrFunction>): boolean {
  const expr = (e: IrExpr): boolean => {
    let allowed = NUMERIC_EXPRESSIONS.has(e.kind);
    if (e.kind === "call") {
      const target = functions.get(e.callee);
      allowed = target !== undefined && simple(target);
    } else if (e.kind === "libCall") allowed = e.fn.startsWith("math.");
    else if (e.kind === "arrIntrinsic") allowed = e.method === "length" || e.method === "getNumber";
    return allowed && everyExprChild(e, expr, stmt);
  };
  const stmt = (s: IrStmt): boolean =>
    NUMERIC_STATEMENTS.has(s.kind) && everyStmtChild(s, expr, stmt);
  return stmt(loop);
}

/** Number parameters of `fn` that bound one of its numeric loops: read in
 * the loop's condition or in its `for` initializer. */
function loopBounds(fn: IrFunction, functions: ReadonlyMap<string, IrFunction>): Set<string> {
  const params = new Set(
    fn.params.filter((param) => param.type.kind === "f64").map((param) => param.localId),
  );
  const result = new Set<string>();
  if (params.size === 0) return result;
  const reads = (e: IrExpr): boolean => {
    if (e.kind === "varRef" && params.has(e.localId)) result.add(e.localId);
    return everyExprChild(e, reads, readsStmt);
  };
  const readsStmt = (s: IrStmt): boolean => everyStmtChild(s, reads, readsStmt);
  everyStmtList(fn.body, {
    stmt: (s) => {
      if (s.kind !== "for" && s.kind !== "while" && s.kind !== "doWhile") return true;
      if (!numericLoop(s, functions)) return true;
      if (s.cond) reads(s.cond);
      if (s.kind === "for" && s.init) readsStmt(s.init);
      return true;
    },
    expr: () => true,
  });
  return result;
}

/** Versions of functions whose number parameters bound their loops.
 *
 * A parameter that every call site proves an int32 already reaches the
 * function's i32 entry (int32-abi.ts). One that some caller passes as an
 * unproven number (a value read from a message, a field, a parse) keeps
 * its double, so the loops it bounds compare a counter with a double and
 * the values derived from it stay doubles.
 *
 * A parameter qualifies when it bounds a numeric loop (`numericLoop`).
 * Such a function gets a copy of its body under a new name, and its own
 * body starts by calling the copy when every such parameter holds an
 * int32: `(p | 0) === p` (an integer in the int32 range, not NaN) and not
 * -0 (`1 / p` is not -Infinity). The copy then receives `p | 0`, which is
 * the same double, so it computes what the body would; its only caller
 * proves the parameter an int32, so it gets the i32 entry. Other values
 * run the body as before.
 *
 * Only plain synchronous functions qualify: not class members, no
 * captures, not the module entry, not dynamic-tier, at most
 * MAX_FUNCTION_NODES nodes, not calling themselves, and not holding the
 * only call site of another function (`keepsSingleBody`). The caller
 * skips modules that observe call stacks, where the copy's frame could be
 * seen. */
export function versionLoopBoundParameters(
  mod: IrModule,
  symbolName: (name: string) => string = (name) => name,
): IrModule {
  const candidates: { fn: IrFunction; params: Set<string> }[] = [];
  // Call sites are read only for functions with loop-bound parameters.
  let sites: ReturnType<typeof callSites> | null = null;
  const functions = new Map(mod.functions.map((fn) => [fn.name, fn]));
  const members = new Set((mod.classes ?? []).flatMap((cls) => cls.methods ?? []));
  for (const fn of mod.functions) {
    if (
      // Constructors, methods and accessors (`%C.m`) and generated helper
      // families (`%arr.map_…`) keep their single body.
      fn.name.includes(".") ||
      members.has(fn.name) ||
      fn.async ||
      fn.generator ||
      fn.captures !== undefined ||
      fn.classCaptures?.length ||
      fn.tier === "dynamic" ||
      fn.name === mod.entry
    )
      continue;
    const params = loopBounds(fn, functions);
    const locals = new Map(fn.locals.map((local) => [local.id, local]));
    for (const id of params) {
      const local = locals.get(id);
      if (!local || local.boxed || local.tdz) params.delete(id);
    }
    if (
      params.size === 0 ||
      size(fn) > MAX_FUNCTION_NODES ||
      keepsSingleBody(fn, (sites ??= callSites(mod)), functions)
    )
      continue;
    candidates.push({ fn, params });
  }
  if (candidates.length === 0) return mod;
  const slots = analyzeInt32Slots(mod);
  const names = new Set(mod.functions.map((fn) => symbolName(fn.name)));
  const replaced = new Map<IrFunction, IrFunction>();
  const added: IrFunction[] = [];
  for (const { fn, params } of candidates) {
    if (added.length >= MAX_VERSIONS) break;
    const unproven = fn.params.filter(
      (param) => params.has(param.localId) && !slots.hasParam(fn.name, param.localId),
    );
    if (unproven.length === 0) continue;
    let name = `${fn.name}.int32Params`;
    while (names.has(symbolName(name))) name += "_";
    names.add(symbolName(name));
    const { ownsPrototype: _ownsPrototype, ...implementation } = fn;
    added.push({ ...implementation, name, body: fn.body.map(reparseStmt) });
    const loc = fn.body[0]?.loc ?? { file: mod.sourceFile, start: 0, end: 0 };
    const read = (localId: string): IrExpr => ({ kind: "varRef", localId, type: F64, loc });
    const int32 = (localId: string): IrExpr => ({
      kind: "bin",
      op: "|",
      left: read(localId),
      right: { kind: "numLit", value: 0, type: F64, loc },
      type: F64,
      loc,
    });
    let test: IrExpr | null = null;
    for (const param of unproven) {
      const exact: IrExpr = {
        kind: "bin",
        op: "===",
        left: int32(param.localId),
        right: read(param.localId),
        type: BOOL,
        loc,
      };
      const notNegativeZero: IrExpr = {
        kind: "bin",
        op: "!==",
        left: {
          kind: "bin",
          op: "/",
          left: { kind: "numLit", value: 1, type: F64, loc },
          right: read(param.localId),
          type: F64,
          loc,
        },
        right: { kind: "numLit", value: -Infinity, type: F64, loc },
        type: BOOL,
        loc,
      };
      const both: IrExpr = {
        kind: "logical",
        op: "&&",
        left: exact,
        right: notNegativeZero,
        type: BOOL,
        loc,
      };
      test =
        test === null
          ? both
          : { kind: "logical", op: "&&", left: test, right: both, type: BOOL, loc };
    }
    const versioned = new Set(unproven.map((param) => param.localId));
    const call: IrExpr = {
      kind: "call",
      callee: name,
      args: fn.params.map((param) =>
        versioned.has(param.localId)
          ? int32(param.localId)
          : { kind: "varRef", localId: param.localId, type: param.type, loc },
      ),
      type: fn.returnType,
      loc,
    };
    const run: IrStmt[] =
      fn.returnType.kind === "void"
        ? [
            { kind: "exprStmt", expr: call, loc },
            { kind: "return", value: null, loc },
          ]
        : [{ kind: "return", value: call, loc }];
    replaced.set(fn, {
      ...fn,
      body: [{ kind: "if", cond: test!, then: run, else_: null, loc }, ...fn.body],
    });
  }
  if (added.length === 0) return mod;
  return {
    ...mod,
    functions: [...mod.functions.map((fn) => replaced.get(fn) ?? fn), ...added],
  };
}
