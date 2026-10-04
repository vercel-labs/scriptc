import { arrayOf, BOOL, F64, STRING, VOID, funcOf, type IrExpr, type IrFunction, type IrModule, type IrStmt, type IrType } from "../../packages/compiler/src/ir/ir.js";
import { IR_VERSION } from "../../packages/compiler/src/ir/serialize.js";

const loc = { file: "backend-analysis.ts", start: 0, end: 1 };
const num = (value: number): IrExpr => ({ kind: "numLit", value, type: F64, loc });
const ref = (localId: string, type: IrType = F64): IrExpr => ({ kind: "varRef", localId, type, loc });
const stmt = (expr: IrExpr): IrStmt => ({ kind: "exprStmt", expr, loc });
const call = (callee: string): IrExpr => ({ kind: "call", callee, args: [], type: VOID, loc });
const fn = (name: string, body: IrStmt[] = []): IrFunction => ({ name, params: [], locals: [], body, returnType: VOID, loc });
const module = (functions: IrFunction[] = [fn("main")]): IrModule => ({ irVersion: IR_VERSION, sourceFile: loc.file, entry: "main", functions });

export interface BackendAnalysisCase {
  name: string;
  module: IrModule;
  mayThrow?: string[];
  indirect?: boolean;
  shapes?: string[];
  unions?: string[];
  tables?: string[];
  loops?: string[];
}

/** Structural cases isolate analysis decisions independently of the runtime
 * APIs they describe. Execution/validation is covered separately with real
 * frontend output and native optimization followed by executable emission. */
export function backendAnalysisCases(): BackendAnalysisCase[] {
  const cases: BackendAnalysisCase[] = [{ name: "empty", module: module(), mayThrow: [], indirect: false, shapes: [], unions: [], tables: [], loops: [] }];
  const failure = fn("failure", [{ kind: "throw", value: num(1), loc }]);
  const caller = fn("main", [stmt(call("middle"))]);
  const middle = fn("middle", [stmt(call("failure"))]);
  cases.push({ name: "transitive calls", module: module([caller, middle, failure]), mayThrow: ["failure", "middle", "main"], indirect: false });
  const closure: IrExpr = { kind: "closure", fnName: "middle", captures: [], type: funcOf([], VOID), loc };
  cases.push({ name: "indirect fixpoint", module: module([
    fn("main", [stmt({ kind: "callValue", callee: closure, args: [], type: VOID, loc })]), middle, failure,
  ]), mayThrow: ["failure", "middle", "main"], indirect: true });
  for (const suspension of ["async", "generator"] as const) {
    const suspended: IrFunction = suspension === "async" ? { ...failure, async: true }
      : { ...failure, generator: { yieldT: F64, nextT: F64, resultType: { kind: "record", shapeId: "result" } } };
    cases.push({ name: `${suspension} call does not unwind`, module: module([
      fn("main", [stmt(call("failure")), stmt({ ...closure, fnName: "failure" })]), suspended,
    ]), mayThrow: ["failure"], indirect: false });
  }
  const nested: IrStmt = { kind: "tryCatch", catchLocalId: null, catchBody: null, finallyBody: [
    stmt({ kind: "seqExpr", stmts: [stmt(call("failure"))], result: num(0), type: F64, loc }),
  ], tryBody: [], loc };
  cases.push({ name: "statement hidden in finally expression", module: module([fn("main", [nested]), failure]), mayThrow: ["failure", "main"] });
  cases.push({ name: "lazy operands still contribute", module: module([
    fn("main", [stmt({ kind: "ternary", cond: { kind: "boolLit", value: false, type: BOOL, loc }, then: call("failure"), else_: num(0), type: F64, loc })]), failure,
  ]), mayThrow: ["failure", "main"] });
  const recursive = module([fn("main", [stmt(call("a"))]), fn("a", [stmt(call("b"))]), fn("b", [stmt(call("a")), stmt(call("failure"))]), failure]);
  cases.push({ name: "recursive call graph", module: recursive, mayThrow: ["failure", "b", "a", "main"] });
  const local = { id: "value", name: "value", type: F64, mutable: true, boxed: true as const, tdz: true as const };
  for (const initializes of [true, false]) {
    const entry = fn("main", [{ kind: "assign", localId: local.id, value: num(1), ...(initializes ? { initializes: true as const } : {}), loc }]);
    entry.locals = [local];
    cases.push({ name: `TDZ initialize=${initializes}`, module: module([entry]), mayThrow: initializes ? [] : ["main"] });
  }
  const virtual = module([fn("main", [stmt({ kind: "virtualCall", className: "Base", method: "run", args: [], type: VOID, loc })]), { ...failure, name: "%Child.run" }]);
  virtual.classes = [{ name: "Base", fields: [], methods: ["run"], loc }, { name: "Child", base: "Base", fields: [], methods: ["run"], loc }];
  cases.push({ name: "virtual dispatch", module: virtual, mayThrow: ["%Child.run", "main"] });
  const construction = module([fn("main", [stmt({ kind: "newValue", callee: { kind: "classRef", className: "Base", type: { kind: "classval", className: "Base" }, loc }, args: [], type: { kind: "object", className: "Base" }, loc })]), { ...failure, name: "%Child.constructor" }]);
  construction.classes = virtual.classes;
  cases.push({ name: "indirect derived constructor", module: construction, mayThrow: ["%Child.constructor", "main"] });
  const adapter = module([fn("main", [stmt({ kind: "dynCheck", value: ref("unknown", { kind: "dyn" }), type: funcOf([], VOID), loc })])]);
  cases.push({ name: "synthetic checked callback", module: adapter, mayThrow: ["main"], indirect: true });

  const graph = module();
  const record = (shapeId: string): IrType => ({ kind: "record", shapeId });
  graph.records = [
    { id: "outer", fields: [{ name: "next", type: arrayOf(record("cycle")) }] },
    { id: "cycle", fields: [], indexValue: { kind: "union", unionId: "recursive" } },
    { id: "leaf", fields: [{ name: "value", type: STRING }] },
    { id: "chain", fields: [{ name: "next", type: record("leaf") }] },
  ];
  graph.unions = [{ id: "recursive", arms: [record("cycle"), { kind: "nullT" }] }, { id: "acyclic", arms: [record("chain"), F64] }];
  cases.push({ name: "shape and union fixed point", module: graph, shapes: ["record:outer", "record:cycle"], unions: ["recursive"] });
  const hierarchy = module();
  hierarchy.classes = [
    { name: "Child", base: "Base", fields: [{ name: "callback", type: funcOf([], VOID) }], loc },
    { name: "Sibling", base: "Base", fields: [], loc }, { name: "Base", fields: [], loc },
  ];
  cases.push({ name: "hierarchy uniform tracing", module: hierarchy, shapes: ["object:Child", "object:Sibling", "object:Base"] });

  const length = 128;
  const constructorChain = module([
    ...Array.from({ length }, (_, i) => fn(`factory${i}`, [stmt({ kind: "newValue", callee: {
      kind: "classRef", className: `C${i}`, type: { kind: "classval", className: `C${i}` }, loc,
    }, args: [], type: { kind: "object", className: `C${i}` }, loc })])),
    fn("direct", [stmt({ kind: "new", className: "C0", args: [], type: { kind: "object", className: "C0" }, loc })]),
    fn("%C0.constructor"), fn(`%C${length - 1}.constructor`, [{ kind: "throw", value: num(1), loc }]),
  ]);
  constructorChain.classes = Array.from({ length }, (_, i) => ({ name: `C${i}`, ...(i > 0 ? { base: `C${i - 1}` } : {}), fields: [], loc })).reverse();
  cases.push({ name: "class-value chain keeps direct construction separate", module: constructorChain, mayThrow: [
    `%C${length - 1}.constructor`, ...Array.from({ length }, (_, i) => `factory${length - i - 1}`),
  ], indirect: false });
  const chain = module(Array.from({ length }, (_, i) => fn(`f${i}`, i === length - 1
    ? [{ kind: "throw", value: num(1), loc }] : [stmt(call(`f${i + 1}`)), stmt(call(`f${i + 1}`))])));
  cases.push({ name: "caller-first chain with repeated edges", module: chain, mayThrow: chain.functions.map((f) => f.name).reverse(), indirect: false });
  const alternating = module();
  alternating.records = Array.from({ length }, (_, i) => ({ id: `r${i}`, fields: [
    { name: "next", type: arrayOf({ kind: "union" as const, unionId: `u${i}` }) },
    { name: "again", type: { kind: "union" as const, unionId: `u${i}` } },
  ] }));
  alternating.unions = Array.from({ length }, (_, i) => ({ id: `u${i}`, arms: [i === length - 1 ? F64 : record(`r${i + 1}`), STRING] }));
  cases.push({ name: "alternating acyclic chain with repeated edges", module: alternating, shapes: [], unions: [] });
  const branch = module();
  branch.records = [
    { id: "leaf", fields: [{ name: "value", type: F64 }] },
    { id: "cycle", fields: [{ name: "next", type: record("cycle") }] },
    { id: "outer", fields: [{ name: "dead", type: record("leaf") }, { name: "live", type: record("cycle") }] },
  ];
  cases.push({ name: "removing a leaf preserves another cyclic branch", module: branch, shapes: ["record:cycle", "record:outer"] });

  const tableId = "%g.table";
  const tableType = arrayOf(F64);
  const tableRead: IrExpr = { kind: "arrIntrinsic", method: "getNumber", receiver: ref(tableId, tableType), args: [num(0)], type: F64, loc };
  const table = module([fn("main", [
    { kind: "assign", localId: tableId, value: { kind: "arrayLit", elems: [num(2), num(-0), num(Infinity)], type: tableType, loc }, loc }, stmt(tableRead),
  ])]);
  table.globals = [{ id: tableId, name: "table", type: tableType, mutable: false }];
  cases.push({ name: "numeric table", module: table, tables: [tableId] });
  for (const use of ["capture", "index-write", "reassign", "length", "hidden-call"]) {
    const changed = structuredClone(table);
    const entry = changed.functions[0]!;
    const mutation: IrStmt = { kind: "arraySet", arr: ref(tableId, tableType), index: num(0), value: num(3), loc };
    if (use === "capture") entry.body.push(stmt({ kind: "closure", fnName: "callback", captures: [tableId], type: funcOf([], VOID), loc }));
    if (use === "index-write") entry.body.push(stmt({ ...tableRead, args: [{ kind: "seqExpr", stmts: [mutation], result: num(0), type: F64, loc }] } as IrExpr));
    if (use === "reassign") entry.body.push(entry.body[0]!);
    if (use === "length") entry.body.push({ kind: "arraySetLength", arr: ref(tableId, tableType), length: num(1), loc });
    if (use === "hidden-call") changed.functions.push(fn("unused", [stmt({ kind: "call", callee: "sink", args: [ref(tableId, tableType)], type: VOID, loc })]));
    cases.push({ name: `table rejects ${use}`, module: changed, tables: [] });
  }

  const bytes: IrType = { kind: "bytes", elem: "u8" };
  const loop: IrStmt & { kind: "for" } = { kind: "for",
    init: { kind: "varDecl", localId: "i", init: num(0), loc },
    cond: { kind: "bin", op: "<", left: ref("i"), right: { kind: "bytesIntrinsic", method: "length", receiver: ref("bytes", bytes), args: [], type: F64, loc }, type: BOOL, loc },
    update: stmt({ kind: "incDec", localId: "i", op: "+", prefix: false, type: F64, loc }), body: [], loc,
  };
  const loops = module([fn("main", [{ kind: "block", body: [loop], loc }])]);
  loops.functions[0]!.locals = [{ id: "i", name: "i", type: F64, mutable: true }, { id: "bytes", name: "bytes", type: bytes, mutable: false }];
  cases.push({ name: "nested integer loop", module: loops, loops: ["i"] });
  for (const mutation of ["expression", "finally", "capture", "negative-zero"]) {
    const changed = structuredClone(loops);
    const block = changed.functions[0]!.body[0] as IrStmt & { kind: "block" };
    const changedLoop = block.body[0] as IrStmt & { kind: "for" };
    if (mutation === "expression") changedLoop.body.push(stmt({ kind: "seqExpr", stmts: [], result: { kind: "assignExpr", localId: "i", value: num(2), type: F64, loc }, type: F64, loc }));
    if (mutation === "finally") changedLoop.body.push({ kind: "tryCatch", tryBody: [], catchBody: null, catchLocalId: null, finallyBody: [{ kind: "assign", localId: "i", value: num(2), loc }], loc });
    if (mutation === "capture") changed.functions[0]!.locals[0]!.boxed = true;
    if (mutation === "negative-zero") changedLoop.init = { kind: "varDecl", localId: "i", init: num(-0), loc };
    cases.push({ name: `integer loop rejects ${mutation}`, module: changed, loops: [] });
  }
  return cases;
}
