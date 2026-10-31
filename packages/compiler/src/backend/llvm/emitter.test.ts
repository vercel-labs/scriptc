import { expect, test } from "vitest";
import {
  BOOL,
  F64,
  PROCSTREAM_T,
  STRING,
  VOID,
  type IrExpr,
  type IrFunction,
  type IrModule,
  type IrStmt,
  type IrType,
} from "../../ir/ir.js";
import { emitLlvmModule, emitLlvmModuleSource, LlEmitter } from "./emitter.js";
import { INLINE_STR_RELEASES_PER_FUNCTION } from "./shapes.js";

/** A pending-exception check: the inline active-cell test or a runtime call. */
const PENDING_CHECK = /@scr_exc_(?:active|pending)\b/;

const loc = { file: "exception-cleanup.ts", start: 0, end: 0 };
const call = (): IrStmt => ({
  kind: "exprStmt",
  expr: { kind: "call", callee: "throws", args: [], type: VOID, loc },
  loc,
});
const literal = (value: string) => ({ kind: "strLit" as const, value, type: STRING, loc });
function moduleFor(
  body: IrStmt[],
  options: { boxed?: boolean; numberReturn?: boolean } = {},
): IrModule {
  const params = ["first", "second", "third"].map((name) => ({
    name,
    localId: name,
    type: STRING,
  }));
  const work: IrFunction = {
    name: "work",
    params,
    returnType: options.numberReturn ? F64 : VOID,
    // Exercise owned scope cleanup independently of parameter borrowing:
    // the closure body rebinds its parameters (below), so it owns them.
    captures: [],
    locals: [
      ...params.map((p) => ({
        id: p.localId,
        name: p.name,
        type: p.type,
        mutable: false,
        ...(options.boxed ? { boxed: true as const } : {}),
      })),
      { id: "later", name: "later", type: STRING, mutable: true },
    ],
    body: [
      ...body,
      ...params.map((p) => ({
        kind: "assign" as const,
        localId: p.localId,
        value: { kind: "varRef" as const, localId: p.localId, type: STRING, loc },
        loc,
      })),
      ...(options.numberReturn
        ? [
            {
              kind: "return" as const,
              value: { kind: "numLit" as const, value: 7, type: F64, loc },
              loc,
            },
          ]
        : []),
    ],
    loc,
  };
  return {
    irVersion: 17,
    sourceFile: loc.file,
    entry: "main",
    functions: [
      { name: "main", params: [], returnType: VOID, locals: [], body: [], loc },
      work,
      {
        name: "throws",
        params: [],
        returnType: VOID,
        locals: [],
        body: [{ kind: "throw", value: literal("oops"), loc }],
        loc,
      },
    ],
  };
}
function cleanupBlocks(module: IrModule): string[] {
  const llvm = emitLlvmModule(module);
  return [...llvm.matchAll(/^exc\.cleanup\d+:\n(?:  [^\n]*\n)+/gm)].map((match) => match[0]!);
}

test("separate LLVM parts preserve complete module bytes in native, WASI, and debug builds", () => {
  const module = moduleFor([call()]);
  for (const options of [
    {},
    { wasi: true, pointerBits: 32 as const },
    { debugSources: new Map([[loc.file, "function main() {}"]]) },
  ]) {
    const expected = emitLlvmModule(module, options);
    expect(new LlEmitter(module, options).emitParts().join("\n")).toBe(expected);
    expect(emitLlvmModuleSource(module, options)).toBe(expected);
  }
});

test("the shared indexed-read helpers carry an inline hint", () => {
  const helper = (name: string): IrFunction => ({
    name,
    params: [],
    returnType: F64,
    locals: [],
    body: [{ kind: "return", value: { kind: "numLit", value: 1, type: F64, loc }, loc }],
    loc,
  });
  const module = moduleFor([]);
  const llvm = emitLlvmModule({
    ...module,
    functions: [...module.functions, helper("%arr.idxOr.0"), helper("plain")],
  });
  const define = (name: string): string =>
    llvm.split("\n").find((line) => line.startsWith("define") && line.endsWith(`{ ; ${name}`))!;
  expect(define("%arr.idxOr.0")).toMatch(/\) inlinehint #0 \{/);
  expect(define("plain")).not.toContain("inlinehint");
});

test("bodies holding thousands of capture boxes compile unoptimized with boxes in memory", () => {
  const number = (value: number): IrExpr => ({ kind: "numLit", value, type: F64, loc });
  const read = (localId: string): IrExpr => ({ kind: "varRef", localId, type: F64, loc });
  // A declaring body with `count` boxed bindings, and a closure body that
  // receives `count` of them through its environment.
  const declaring = (name: string, count: number): IrFunction => {
    const ids = Array.from({ length: count }, (_, i) => `${name}${i}`);
    return {
      name,
      params: [],
      returnType: F64,
      locals: ids.map((id) => ({ id, name: id, type: F64, mutable: true, boxed: true as const })),
      body: [
        ...ids.map((id, i): IrStmt => ({ kind: "varDecl", localId: id, init: number(i), loc })),
        { kind: "return", value: read(ids[count - 1]!), loc },
      ],
      loc,
    };
  };
  const receiving = (name: string, count: number): IrFunction => {
    const ids = Array.from({ length: count }, (_, i) => `${name}${i}`);
    return {
      name,
      params: [],
      returnType: F64,
      captures: ids.map((id) => ({ localId: id, name: id, type: F64 })),
      locals: ids.map((id) => ({ id, name: id, type: F64, mutable: true, boxed: true as const })),
      body: [{ kind: "return", value: read(ids[0]!), loc }],
      loc,
    };
  };
  const module = moduleFor([]);
  const llvm = emitLlvmModule({
    ...module,
    functions: [
      ...module.functions,
      declaring("wide", 512),
      declaring("narrow", 511),
      receiving("env", 512),
    ],
  });
  const body = (name: string): string => {
    const start = llvm.split("\n").findIndex((line) => line.endsWith(`{ ; ${name}`));
    const lines = llvm.split("\n").slice(start);
    return lines.slice(0, lines.indexOf("}")).join("\n");
  };
  expect(body("wide")).toMatch(/\) noinline optnone #0 \{/);
  expect(body("wide")).toMatch(/store volatile ptr %[st]\d+, ptr %sc_l_wide0\b/);
  expect(body("wide")).toMatch(/= load volatile ptr, ptr %sc_l_wide511\b/);
  expect(body("env")).toMatch(/\) noinline optnone #0 \{/);
  expect(body("env")).toMatch(/store volatile ptr %t\d+, ptr %sc_l_env0 ; captured env0/);
  expect(body("narrow")).not.toContain("optnone");
  expect(body("narrow")).not.toContain("volatile");
});

test("throwing-call count does not multiply identical scope cleanup", () => {
  for (const boxed of [false, true]) {
    const small = emitLlvmModule(moduleFor(Array.from({ length: 4 }, call), { boxed }));
    const large = emitLlvmModule(moduleFor(Array.from({ length: 64 }, call), { boxed }));
    const release = boxed ? /call void @scr_box_release\(ptr/g : /call void @scr_str_release\(ptr/g;
    expect(small.match(release)?.length).toBeGreaterThan(0);
    expect(large.match(release)?.length).toBe(small.match(release)?.length);
  }
});

test("detached exit defines the runtime opt-in symbol only when requested", () => {
  const module = moduleFor([call()]);
  const plain = emitLlvmModule(module);
  expect(emitLlvmModule(module, { detachedExit: false })).toBe(plain);
  expect(plain).not.toContain("@scr_detached_exit");
  const detached = emitLlvmModule(module, { detachedExit: true });
  expect(detached.match(/^@scr_detached_exit = constant i8 1$/gm)).toHaveLength(1);
  expect(detached.replace("@scr_detached_exit = constant i8 1\n", "")).toBe(plain);
});

test("a target CPU level reaches every function attribute group and nothing else", () => {
  const module = moduleFor([call()]);
  const plain = emitLlvmModule(module);
  expect(plain).not.toContain("target-cpu");
  const v3 = emitLlvmModule(module, { targetCpu: "x86-64-v3" });
  expect(v3).toMatch(/^attributes #0 = \{ sanitize_address uwtable "target-cpu"="x86-64-v3" \}$/m);
  expect(v3.replaceAll(' "target-cpu"="x86-64-v3"', "")).toBe(plain);
  expect(emitLlvmModule(module, { targetCpu: "baseline" })).toBe(plain);
});

test("only sanitized builds mark the emitted functions sanitize_address", () => {
  const module = moduleFor([call()]);
  const sanitized = emitLlvmModule(module);
  expect(emitLlvmModule(module, { sanitizeAttributes: true })).toBe(sanitized);
  expect(sanitized).toMatch(/^attributes #0 = \{ sanitize_address uwtable \}$/m);
  const plain = emitLlvmModule(module, { sanitizeAttributes: false });
  expect(plain).not.toContain("sanitize_address");
  expect(plain).toMatch(/^attributes #0 = \{ uwtable \}$/m);
  const v3 = emitLlvmModule(module, { sanitizeAttributes: false, targetCpu: "x86-64-v3" });
  expect(v3).toMatch(/^attributes #0 = \{ uwtable "target-cpu"="x86-64-v3" \}$/m);
});

test("native functions get unwind tables and wasm32-wasi functions do not", () => {
  const module = moduleFor([call()]);
  expect(emitLlvmModule(module)).toMatch(/^attributes #0 = \{ sanitize_address uwtable \}$/m);
  const wasi = emitLlvmModule(module, { wasi: true, pointerBits: 32, sanitizeAttributes: false });
  expect(wasi).not.toContain("uwtable");
  // A group needs an attribute: an ignored string attribute stands in.
  expect(wasi).toMatch(/^attributes #0 = \{ "scriptc-function" \}$/m);
});

test("inline RC inlines every fast path at speed and keeps box releases as calls in release", () => {
  for (const boxed of [false, true]) {
    const module = moduleFor(Array.from({ length: 4 }, call), { boxed });
    const release = emitLlvmModule(module);
    expect(release).not.toContain("@sc_rc_");
    expect(release).not.toContain("%ScrMapRc");
    // The release subset inlines string and dyn retains and releases and Map
    // retains only: box releases stay runtime calls, and so do the string
    // releases of a function with more than INLINE_STR_RELEASES_PER_FUNCTION.
    const subset = emitLlvmModule(module, { inlineRc: "release" });
    expect(subset).not.toContain("call void @sc_rc_release_box(");
    const sites = (ir: string, fn: string): number => ir.split(`call void @${fn}(ptr`).length - 1;
    if (!boxed) {
      expect(sites(subset, "sc_rc_release_str")).toBe(0);
      // Every site calls the runtime, and so does the unused helper's slow path.
      expect(sites(subset, "scr_str_release")).toBe(sites(release, "scr_str_release") + 1);
      expect(sites(release, "scr_str_release")).toBeGreaterThan(INLINE_STR_RELEASES_PER_FUNCTION);
    }
    const speed = emitLlvmModule(module, { inlineRc: "speed" });
    const helper = boxed ? "sc_rc_release_box" : "sc_rc_release_str";
    const runtime = boxed ? "scr_box_release" : "scr_str_release";
    expect(release.match(new RegExp(`call void @${runtime}\\(ptr`, "g"))?.length).toBeGreaterThan(
      0,
    );
    expect(speed).toContain(`define internal void @${helper}(ptr %o)`);
    // Speed calls the runtime release only from the helper's cold slow path.
    expect(speed.match(new RegExp(`call void @${runtime}\\(ptr`, "g"))).toHaveLength(1);
    expect(speed.match(new RegExp(`call void @${helper}\\(ptr`, "g"))?.length).toBe(
      release.match(new RegExp(`call void @${runtime}\\(ptr`, "g"))?.length,
    );
  }
});

test("cleanup snapshots keep locals declared after an earlier throw separate", () => {
  // An owned value: a stable binding of an immortal literal needs no cleanup.
  const owned: IrExpr = {
    kind: "strConcat",
    left: literal("cre"),
    right: literal("ated"),
    type: STRING,
    loc,
  };
  const module = moduleFor([
    call(),
    { kind: "varDecl", localId: "later", init: owned, loc },
    call(),
  ]);
  const blocks = cleanupBlocks(module);
  expect(blocks).toHaveLength(2);
  expect(blocks.filter((block) => block.includes("%sc_l_later"))).toHaveLength(1);
});

test("equivalent slots with different catch destinations remain separate", () => {
  const module = moduleFor([
    {
      kind: "tryCatch",
      tryBody: [{ kind: "varDecl", localId: "later", init: literal("one"), loc }, call(), call()],
      catchBody: [],
      catchLocalId: null,
      finallyBody: null,
      loc,
    },
    {
      kind: "tryCatch",
      tryBody: [{ kind: "varDecl", localId: "later", init: literal("two"), loc }, call(), call()],
      catchBody: [],
      catchLocalId: null,
      finallyBody: null,
      loc,
    },
  ]);
  const blocks = cleanupBlocks(module).filter((block) => block.includes("%sc_l_later"));
  expect(blocks).toHaveLength(2);
  const targets = blocks.map((block) => /br label %([^\n]+)/.exec(block)?.[1]);
  expect(targets.every(Boolean)).toBe(true);
  expect(new Set(targets).size).toBe(2);
});

test("shared exceptional exits preserve the function's scalar return ABI", () => {
  const blocks = cleanupBlocks(moduleFor([call(), call()], { numberReturn: true }));
  expect(blocks).toHaveLength(1);
  expect(blocks[0]).toContain("ret double 0x0000000000000000");
});

test("exceptional exits use each scalar kind's LLVM return type", () => {
  for (const type of [F64, BOOL, PROCSTREAM_T]) {
    for (const ownedLocals of [false, true]) {
      const module = moduleFor([call(), call(), { kind: "throw", value: literal("failed"), loc }]);
      const work = module.functions[1]!;
      work.returnType = type;
      if (!ownedLocals) {
        work.params = [];
        work.locals = [];
      }
      const llvm = emitLlvmModule(module);
      const body = /^define internal [^\n]*@sc_f_work(?:\.i32)?\([^]*?^}/m.exec(llvm)?.[0];
      expect(body).toBeDefined();
      expect(body).toContain(
        type.kind === "bool" ? "ret i1 false" : "ret double 0x0000000000000000",
      );
      expect(body).not.toContain("ret ptr null");
    }
  }
});

const receiverLoc = { file: "read-receiver.ts", start: 0, end: 0 };
const leaf: IrType = { kind: "record", shapeId: "leaf" };
const root: IrType = { kind: "record", shapeId: "root" };
const union: IrType = { kind: "union", unionId: "value" };
const ref = (type: IrType): IrExpr => ({
  kind: "varRef",
  localId: "value",
  type,
  loc: receiverLoc,
});
const narrow = (value: IrExpr): IrExpr => ({
  kind: "unionNarrow",
  unionId: "value",
  tag: 0,
  value,
  type: root,
  loc: receiverLoc,
});
const child = (obj: IrExpr): IrExpr => ({
  kind: "recordGet",
  obj,
  shapeId: "root",
  field: "child",
  type: leaf,
  loc: receiverLoc,
});
const text = (obj: IrExpr): IrExpr => ({
  kind: "recordGet",
  obj,
  shapeId: "leaf",
  field: "text",
  type: STRING,
  loc: receiverLoc,
});

function work(expr: IrExpr, parameter: IrType, boxed = false, tdz = false): string {
  const module: IrModule = {
    irVersion: 17,
    sourceFile: receiverLoc.file,
    entry: "main",
    records: [
      { id: "leaf", fields: [{ name: "text", type: STRING }] },
      { id: "root", fields: [{ name: "child", type: leaf }] },
    ],
    unions: [{ id: "value", arms: [root, STRING] }],
    functions: [
      { name: "main", params: [], returnType: VOID, locals: [], body: [], loc: receiverLoc },
      {
        name: "work",
        params: [{ name: "value", localId: "value", type: parameter }],
        returnType: expr.type,
        locals: [
          {
            id: "value",
            name: "value",
            type: parameter,
            mutable: false,
            ...(boxed ? { boxed: true } : {}),
            ...(tdz ? { tdz: true } : {}),
          },
        ],
        body: [
          { kind: "return", value: expr, loc: receiverLoc },
          // An unreachable rebinding keeps a boxed parameter in its shared
          // box; a captured parameter that is never rebound uses a plain slot.
          ...(boxed
            ? [
                {
                  kind: "assign" as const,
                  localId: "value",
                  value: {
                    kind: "varRef" as const,
                    localId: "value",
                    type: parameter,
                    loc: receiverLoc,
                  },
                  loc: receiverLoc,
                },
              ]
            : []),
        ],
        loc: receiverLoc,
      },
    ],
  };
  const llvm = emitLlvmModule(module);
  const body = /^define internal [^\n]*@sc_(?:b)?f_work(?:\.i32)?\([^]*?^}/m.exec(llvm)?.[0];
  expect(body).toBeDefined();
  return body!;
}

test("nested union and record projections retain only the escaping reference", () => {
  const llvm = work(text(child(narrow(ref(union)))), union);
  expect(llvm).not.toContain("call ptr @scr_union_retain_v");
  expect(llvm).not.toMatch(/call ptr @sc_rretain_/);
  expect(llvm.match(/call ptr @scr_str_retain_v/g)).toHaveLength(1);
});

test("tag tests read an owned local without adding a temporary owner", () => {
  const llvm = work(
    {
      kind: "unionIsTag",
      unionId: "value",
      value: ref(union),
      tag: 0,
      negated: false,
      type: BOOL,
      loc: receiverLoc,
    },
    union,
  );
  expect(llvm).not.toContain("call ptr @scr_union_retain_v");
  expect(llvm).toContain("icmp eq i32");
});

test("class brand probes borrow a local only across an inert literal key", () => {
  const dyn: IrType = { kind: "dyn" };
  const key: IrExpr = { kind: "strLit", value: "object:Example", type: STRING, loc: receiverLoc };
  const probe: IrExpr = {
    kind: "libCall",
    fn: "dyn.typedRefIs",
    args: [ref(dyn), key],
    type: BOOL,
    loc: receiverLoc,
  };
  const borrowed = work(probe, dyn);
  expect(borrowed).not.toContain("call ptr @scr_dyn_retain_v(");
  expect(borrowed).toContain("icmp ne ptr");
  expect(borrowed).toContain("icmp eq i32");
  expect(borrowed).toContain("@scr_dyn_typed_ref_is_key");
  const boxed = work(probe, dyn, true);
  expect(boxed).not.toContain("call ptr @scr_box_get_ref");
  expect(boxed).toContain("getelementptr inbounds %ScrBox");
  expect(boxed).toContain("call void @scr_box_release");
  const computed = work(
    {
      ...probe,
      args: [
        ref(dyn),
        {
          kind: "toString",
          operand: ref(dyn),
          type: STRING,
          loc: receiverLoc,
        },
      ],
    },
    dyn,
  );
  expect(computed).toContain("call ptr @scr_dyn_retain_v(");
});

test("class constructor probes test the function tag and borrow across a literal key", () => {
  const dyn: IrType = { kind: "dyn" };
  const key: IrExpr = { kind: "strLit", value: "classval:Example", type: STRING, loc: receiverLoc };
  const probe: IrExpr = {
    kind: "libCall",
    fn: "dyn.classIs",
    args: [ref(dyn), key],
    type: BOOL,
    loc: receiverLoc,
  };
  const borrowed = work(probe, dyn);
  expect(borrowed).not.toContain("call ptr @scr_dyn_retain_v(");
  expect(borrowed).toContain("icmp ne ptr");
  expect(borrowed).toContain("icmp eq i32 %t");
  expect(borrowed).toMatch(/icmp eq i32 %t\d+, 8\b/);
  expect(borrowed).toContain("call zeroext i1 @scr_dyn_class_is_key(");
  const computed = work(
    {
      ...probe,
      args: [ref(dyn), { kind: "toString", operand: ref(dyn), type: STRING, loc: receiverLoc }],
    },
    dyn,
  );
  expect(computed).toContain("call ptr @scr_dyn_retain_v(");
  expect(computed).toContain("call zeroext i1 @scr_dyn_class_is_key(");
});

test("class brand probes compare the program's key constant before the key text", () => {
  const dyn: IrType = { kind: "dyn" };
  const key: IrExpr = { kind: "strLit", value: "object:Example", type: STRING, loc: receiverLoc };
  const probe = (fn: "dyn.typedRefIs" | "dyn.typedRefKeyIs"): IrExpr => ({
    kind: "libCall",
    fn,
    args: [ref(dyn), key],
    type: BOOL,
    loc: receiverLoc,
  });
  const named = work(probe("dyn.typedRefIs"), dyn);
  expect(named).toContain("; ->v.typed_ref.type_key");
  expect(named).toContain("@scr_dyn_typed_ref_is_key");
  // Another key pointer is rejected on its length and last eight bytes
  // ("Example" plus the prefix's ':') before the out-of-line comparison.
  expect(named).toContain("; ->v.typed_ref.type_key_len");
  expect(named).toContain("and i32 %t");
  expect(named).toMatch(/icmp eq i32 %t\d+, 14\b/);
  const tail = Buffer.from("object:Example").readBigInt64LE(6);
  expect(named).toContain(`icmp eq i64 %t`);
  expect(named).toContain(`, ${tail}`);
  const shortKey: IrExpr = { kind: "strLit", value: "o:E", type: STRING, loc: receiverLoc };
  const short = work(
    {
      kind: "libCall",
      fn: "dyn.typedRefIs",
      args: [ref(dyn), shortKey],
      type: BOOL,
      loc: receiverLoc,
    },
    dyn,
  );
  expect(short).toMatch(/icmp eq i32 %t\d+, 3\b/);
  expect(short).not.toContain("load i64");
  // The key-pointer test answers false for capsules boxed elsewhere.
  const exact = work(probe("dyn.typedRefKeyIs"), dyn);
  expect(exact).toContain("; ->v.typed_ref.type_key");
  expect(exact).not.toContain("@scr_dyn_typed_ref_is_key");
  expect(exact).not.toContain("call ptr @scr_dyn_retain_v(");
});

test("capture projections borrow their payload but retain escaping results and TDZ reads", () => {
  const llvm = work(text(child(narrow(ref(union)))), union, true);
  expect(llvm).not.toContain("call ptr @scr_box_get_ref");
  expect(llvm).toContain("call void @scr_box_release");
  expect(llvm.match(/call ptr @scr_str_retain_v/g)).toHaveLength(1);
  const checked = work(text(child(narrow(ref(union)))), union, true, true);
  expect(checked).toContain("call ptr @scr_box_get_ref");
  expect(checked).toContain("call void @scr_union_release");
});

test("native iterator steps borrow stable owners but snapshot captured state", () => {
  const dyn: IrType = { kind: "dyn" };
  const step: IrExpr = {
    kind: "libCall",
    fn: "dyn.iteratorStep",
    args: [ref(dyn)],
    type: dyn,
    loc: receiverLoc,
  };
  const stable = work(step, dyn);
  expect(stable).toContain("call ptr @scr_dyn_iterator_step(");
  expect(stable).not.toContain("call ptr @scr_dyn_retain_v(");
  const captured = work(step, dyn, true);
  expect(captured).toContain("call ptr @scr_box_get_ref");
  expect(captured).toContain("call void @scr_dyn_release");
});

test("checked field receivers borrow only the successful projection", () => {
  const checked: IrExpr = {
    kind: "ternary",
    type: root,
    loc: receiverLoc,
    cond: {
      kind: "unionIsTag",
      unionId: "value",
      value: ref(union),
      tag: 1,
      negated: false,
      type: BOOL,
      loc: receiverLoc,
    },
    then: {
      kind: "libCall",
      fn: "error.nodeThrow",
      args: [
        { kind: "numLit", value: 1, type: F64, loc: receiverLoc },
        literal(""),
        literal("missing receiver"),
      ],
      type: root,
      loc: receiverLoc,
    },
    else_: narrow(ref(union)),
  };
  const llvm = work(text(child(checked)), union);
  expect(llvm).toContain("@scr_throw_node_coded");
  // The throw always leaves an exception pending: it unwinds directly.
  expect(llvm).not.toMatch(PENDING_CHECK);
  expect(llvm).not.toContain("@scr_union_retain_v");
  expect(llvm).not.toMatch(/call ptr @sc_rretain_/);
  const captured = work(text(child(checked)), union, true);
  expect(captured).not.toContain("@scr_box_get_ref");
  expect(captured).toContain("@scr_throw_node_coded");
});

function sharedFieldModule(prefixes: IrType[][], fieldType: IrType): IrModule {
  const shared: IrType = { kind: "union", unionId: "shared" };
  const records = prefixes.map((prefix, index) => ({
    id: `variant${index}`,
    fields: [
      ...prefix.map((type, field) => ({ name: `prefix${field}`, type })),
      { name: "value", type: fieldType },
      { name: `tail${index}`, type: index % 2 ? BOOL : F64 },
    ],
  }));
  return {
    irVersion: 17,
    sourceFile: loc.file,
    entry: "main",
    records,
    unions: [
      { id: "shared", arms: records.map((record) => ({ kind: "record", shapeId: record.id })) },
    ],
    functions: [
      { name: "main", params: [], returnType: VOID, locals: [], body: [], loc },
      {
        name: "read",
        params: [{ localId: "value", name: "value", type: shared }],
        returnType: fieldType,
        locals: [{ id: "value", name: "value", type: shared, mutable: false }],
        loc,
        body: [
          {
            kind: "return",
            value: {
              kind: "unionDisc",
              value: ref(shared),
              unionId: "shared",
              field: "value",
              type: fieldType,
              loc,
            },
            loc,
          },
        ],
      },
    ],
  };
}

test("wide unions share field reads with identical storage prefixes", () => {
  for (const pointerBits of [32, 64] as const) {
    const llvm = emitLlvmModule(
      sharedFieldModule(
        Array.from({ length: 128 }, () => [BOOL, STRING]),
        STRING,
      ),
      { pointerBits },
    );
    const body = /^define internal [^\n]*@sc_bf_read(?:\.i32)?\([^]*?^}/m.exec(llvm)![0];
    expect(body).not.toContain("switch i32");
    expect(body).toMatch(/icmp ult i32 %\w+, 128/);
    expect(body).toContain("call void @sc_bad_tag()");
    expect(body.match(/call ptr @scr_str_retain_v/g)).toHaveLength(1);
  }
});

test("different union field offsets retain per-variant dispatch", () => {
  for (const prefixes of [
    [[], [BOOL]],
    [[BOOL], [F64]],
    [[STRING], [BOOL]],
  ]) {
    const llvm = emitLlvmModule(sharedFieldModule(prefixes, STRING));
    const body = /^define internal [^\n]*@sc_bf_read(?:\.i32)?\([^]*?^}/m.exec(llvm)![0];
    expect(body).toContain("switch i32");
    expect(body.match(/call ptr @scr_str_retain_v/g)).toHaveLength(2);
  }
});

test("partially shared union layouts emit one read per storage prefix", () => {
  const llvm = emitLlvmModule(
    sharedFieldModule(
      Array.from({ length: 128 }, (_, index) => (index % 2 ? [BOOL] : [])),
      STRING,
    ),
  );
  const body = /^define internal [^\n]*@sc_bf_read(?:\.i32)?\([^]*?^}/m.exec(llvm)![0];
  expect(body).toContain("switch i32");
  expect(body.match(/call ptr @scr_str_retain_v/g)).toHaveLength(2);
  const destinations = [...body.matchAll(/i32 \d+, label %(u\.a\d+)/g)].map((match) => match[1]);
  expect(destinations).toHaveLength(128);
  expect(new Set(destinations).size).toBe(2);
});

test("shared boolean union fields keep their byte storage and scalar result", () => {
  const llvm = emitLlvmModule(sharedFieldModule([[], []], BOOL));
  const body = /^define internal [^\n]*@sc_bf_read(?:\.i32)?\([^]*?^}/m.exec(llvm)![0];
  expect(body).not.toContain("switch i32");
  expect(body.match(/load i8, ptr/g)).toHaveLength(1);
  expect(body).toMatch(/trunc i8 %\w+ to i1/);
});

test("literal zero division emits the JavaScript NaN constant in development builds", () => {
  const zero: IrExpr = { kind: "numLit", value: 0, type: F64, loc: receiverLoc };
  const llvm = work(
    { kind: "bin", op: "/", left: zero, right: zero, type: F64, loc: receiverLoc },
    F64,
  );
  expect(llvm).not.toContain("fdiv");
  expect(llvm).toContain("ret double 0x7FF8000000000000");
  const dynamic = work(
    { kind: "bin", op: "/", left: ref(F64), right: ref(F64), type: F64, loc: receiverLoc },
    F64,
  );
  expect(dynamic).toContain("fdiv double");
});

test("synchronous bodies load the active exception cell once for all pending checks", () => {
  const body = (llvm: string, name: string): string => {
    const start = llvm.indexOf(`@${name}(`);
    return llvm.slice(start, llvm.indexOf("\n}\n", start));
  };
  const module = moduleFor([call(), call(), call()]);
  const work = body(emitLlvmModule(module), "sc_f_work");
  expect(work.match(/= load ptr, ptr @scr_exc_active/g)).toHaveLength(1);
  expect(work.slice(work.indexOf("entry:")).split("\n").slice(1).join("\n")).toMatch(
    /^(?:  %[^\n]* = alloca [^\n]*\n)*  %exc\.cell = load ptr, ptr @scr_exc_active/,
  );
  expect(work.match(/= load i32, ptr %exc\.cell\b/g)).toHaveLength(3);
  // Darwin and Windows worker executables test the process-wide alert word
  // at each check instead, and never read their thread-local cell inline.
  const darwin = { targetTriple: "arm64-apple-macosx14.0.0" };
  const workers = body(emitLlvmModule({ ...module, workers: true }, darwin), "sc_f_work");
  expect(workers).not.toContain("%exc.cell");
  expect(workers).not.toContain("@scr_exc_active");
  expect(workers.match(/= load atomic i32, ptr @scr_exc_alert monotonic/g)).toHaveLength(3);
  expect(workers.match(/call zeroext i1 @scr_exc_pending\(\)/g)).toHaveLength(3);
  // ELF worker executables test the thread's exact pending word and unwind
  // directly: no check carries an out-of-line slow path.
  const elf = { targetTriple: "x86_64-unknown-linux-gnu" };
  const flagLlvm = emitLlvmModule({ ...module, workers: true }, elf);
  expect(flagLlvm).toContain("@scr_exc_flag = external thread_local(localexec) global i32");
  const flag = body(flagLlvm, "sc_f_work");
  expect(flag).not.toContain("@scr_exc_alert");
  expect(flag).not.toContain("@scr_exc_pending");
  // Outside loops the tests are unordered loads LLVM may forward around.
  expect(flag.match(/= load atomic i32, ptr @scr_exc_flag unordered/g)).toHaveLength(3);
  expect(flag).not.toContain("monotonic");
  // Inside a source loop (whose termination poll the call's test replaces)
  // the test stays ordered, so LLVM cannot hoist it out of the loop.
  const spin: IrStmt = {
    kind: "while",
    cond: { kind: "boolLit", value: true, type: BOOL, loc },
    body: [call()],
    loc,
  };
  const looped = body(emitLlvmModule({ ...moduleFor([spin]), workers: true }, elf), "sc_f_work");
  expect(looped.match(/= load atomic i32, ptr @scr_exc_flag monotonic/g)).toHaveLength(1);
  expect(looped).not.toContain("unordered");
});
