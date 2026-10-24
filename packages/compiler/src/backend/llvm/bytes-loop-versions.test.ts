import { expect, test } from "vitest";
import {
  BOOL,
  F64,
  VOID,
  type IrExpr,
  type IrFunction,
  type IrLocal,
  type IrModule,
  type IrStmt,
  type IrType,
} from "../../ir/ir.js";
import { analyzeIntegerRanges } from "../../ir/integer-ranges.js";
import { matchIntegerCountedForLoop, matchIntegerPairedForLoop } from "../../ir/integer-loops.js";
import { findInitializedByteLoopBindings } from "./byte-windows.js";
import { matchBytesLoopVersion, type BytesLoopVersion } from "./bytes-loop-versions.js";
import { emitLlvmModule } from "./emitter.js";

const loc = { file: "versions.ts", start: 0, end: 0 };
const f64s: IrType = { kind: "bytes", elem: "f64" };
const i32s: IrType = { kind: "bytes", elem: "i32" };
const num = (value: number): IrExpr => ({ kind: "numLit", value, type: F64, loc });
const ref = (localId: string, type: IrType = F64): IrExpr => ({
  kind: "varRef",
  localId,
  type,
  loc,
});
const bin = (op: string, left: IrExpr, right: IrExpr): IrExpr =>
  ({ kind: "bin", op, left, right, type: F64, loc }) as IrExpr;
const get = (receiver: IrExpr, index: IrExpr): IrExpr => ({
  kind: "bytesIntrinsic",
  method: "get",
  receiver,
  args: [index],
  invalidNaN: true,
  type: F64,
  loc,
});
const set = (arr: IrExpr, index: IrExpr, value: IrExpr): IrStmt => ({
  kind: "bytesSet",
  arr,
  index,
  value,
  loc,
});
const counted = (
  body: IrStmt[],
  limit: IrExpr = ref("n"),
  counter = "i",
): IrStmt & { kind: "for" } => ({
  kind: "for",
  init: { kind: "varDecl", localId: counter, init: num(0), loc },
  cond: { kind: "bin", op: "<", left: ref(counter), right: limit, type: BOOL, loc },
  update: { kind: "assign", localId: counter, value: bin("+", ref(counter), num(1)), loc },
  body,
  loc,
});
const local = (
  id: string,
  type: IrType,
  mutable = false,
  extra: Partial<IrLocal> = {},
): IrLocal => ({
  id,
  name: id,
  type,
  mutable,
  ...extra,
});

function fn(body: IrStmt[], extra: IrLocal[] = []): IrFunction {
  return {
    name: "kernel",
    params: [
      { localId: "out", name: "out", type: f64s },
      { localId: "src", name: "src", type: f64s },
      { localId: "table", name: "table", type: i32s },
      { localId: "n", name: "n", type: F64 },
      { localId: "k", name: "k", type: F64 },
    ],
    returnType: VOID,
    locals: [
      local("out", f64s),
      local("src", f64s),
      local("table", i32s),
      local("n", F64),
      local("k", F64),
      local("i", F64, true),
      local("j", F64, true),
      ...extra,
    ],
    body,
    loc,
  };
}

function match(
  f: IrFunction,
  loop: IrStmt & { kind: "for" },
  captured: string[] = [],
  scalarStrings: string[] = [],
): BytesLoopVersion | null {
  const ranges = analyzeIntegerRanges(f);
  const locals = new Map(f.locals.map((l) => [l.id, l]));
  return matchBytesLoopVersion(loop, matchIntegerCountedForLoop(loop, locals, ranges), {
    locals,
    invariantGlobals: new Set(),
    captured: new Set(captured),
    ranges,
    initialized: findInitializedByteLoopBindings(f).get(loop) ?? new Set(),
    proven: new Set(),
    workers: false,
    owned: new Set(),
    scalarStrings: new Set(scalarStrings),
  });
}

test("a counted loop's affine accesses get one guard and exact operand ranges", () => {
  const shifted = bin("+", ref("i"), num(1));
  const loop = counted([set(ref("out", f64s), ref("i"), get(ref("src", f64s), shifted))]);
  const version = match(fn([loop]), loop)!;
  expect(version).not.toBeNull();
  expect(version.bounds.size).toBe(2);
  expect(version.receivers.map((r) => r.ref.kind === "varRef" && r.ref.localId)).toEqual([
    "out",
    "src",
  ]);
  expect(version.affine.map((c) => [c.scale, c.minOffset, c.maxEnd])).toEqual([
    [1, 0, 0],
    [1, 1, 1],
  ]);
  // `n` is unproven: the guard bounds the counter so `i + 1` stays exact.
  expect(version.counted?.limitGuarded).toBe(true);
  expect(version.counterBound).toBe(Number.MAX_SAFE_INTEGER - 1);
  expect(version.ranges.get(shifted)).toEqual({ min: 1, max: Number.MAX_SAFE_INTEGER });
});

test("invariant terms without a range are tested by the guard", () => {
  // for (let i = 0; i < n; i++) out[i] = src[k + i], with `k` a parameter
  const shifted = bin("+", ref("k"), ref("i"));
  const loop = counted([set(ref("out", f64s), ref("i"), get(ref("src", f64s), shifted))]);
  const kernel = fn([loop]);
  const version = match(kernel, loop)!;
  expect([...version.guarded]).toEqual(["v1:k"]);
  expect(version.affine.map((c) => c.terms.map((t) => t.key))).toEqual([[], ["v1:k"]]);
  // In the fast copy the term has the range the guard tests.
  expect(version.ranges.get(shifted.kind === "bin" ? shifted.left : shifted)).toEqual({
    min: -(2 ** 32),
    max: 2 ** 32,
  });
  const mod: IrModule = {
    irVersion: 17,
    sourceFile: loc.file,
    entry: "__main",
    functions: [
      { name: "__main", params: [], returnType: VOID, locals: [], body: [], loc },
      kernel,
    ],
  };
  const body = /^define internal [^\n]*@sc_bf_kernel[^]*?^}/m.exec(emitLlvmModule(mod))![0];
  const guard = body.slice(0, body.search(/^bytes\.version\.(fast|slow)\d+:$/m));
  // -2^32 <= k <= 2^32, and k is the double of its frozen integer.
  expect(guard).toMatch(/fcmp oge double %\S+, 0xC1F0000000000000/);
  expect(guard).toMatch(/fcmp ole double %\S+, 0x41F0000000000000/);
  expect(guard).toMatch(/freeze i64/);
  const fast = /^bytes\.version\.fast\d+:$[^]*?^bytes\.version\.done\d+:$/m.exec(body)![0];
  expect(fast).not.toContain("bytes.index");
  expect(body.slice(0, body.indexOf(fast))).toContain("bytes.index.invalid");
});

test("statically ranged indices compare one constant with the length", () => {
  const masked = bin("&", bin("^", ref("i"), ref("k")), num(255));
  const loop = counted([set(ref("out", f64s), num(0), get(ref("table", i32s), masked))]);
  const version = match(fn([loop]), loop)!;
  expect(version.fixed.map((c) => [version.receivers[c.receiver]!.ref, c.end])).toEqual([
    [ref("out", f64s), 0],
    [ref("table", i32s), 255],
  ]);
  expect(version.affine).toEqual([]);
  expect(version.counted).toBeNull();
  // A uint32 index (an array counter's range) gets no guard: no typed array
  // in practice has 2^31 elements.
  const wide = bin(">>>", bin("^", ref("i"), ref("k")), num(0));
  const unbounded = counted([set(ref("out", f64s), num(0), get(ref("table", i32s), wide))]);
  expect(match(fn([unbounded]), unbounded)!.fixed).toEqual([{ receiver: 0, end: 0 }]);
});

test("scaled counters and body temps resolve to their receiver and index", () => {
  const temps = [local("view", f64s), local("at", F64)];
  const at = bin("+", bin("*", ref("i"), num(4)), num(3));
  const loop = counted([
    { kind: "varDecl", localId: "view", init: ref("src", f64s), loc },
    { kind: "varDecl", localId: "at", init: at, loc },
    set(ref("view", f64s), ref("at"), num(1)),
    // (The integer counted loop needs one direct counter index.)
    set(ref("out", f64s), ref("i"), num(0)),
  ]);
  const version = match(fn([loop], temps), loop)!;
  expect(version.receivers.map((r) => r.ref)).toEqual([ref("src", f64s), ref("out", f64s)]);
  expect(version.affine.map((c) => [c.scale, c.minOffset, c.maxEnd])).toEqual([
    [4, 3, 3],
    [1, 0, 0],
  ]);
  expect(version.ranges.has(at)).toBe(true);
});

test("negative factors, rebinding, captures and outer loops are not versioned", () => {
  // `i * -1` is -0 at zero, so it is not treated as an affine operand.
  const negative = counted([set(ref("out", f64s), bin("*", ref("i"), num(-1)), num(1))]);
  expect(match(fn([negative]), negative)).toBeNull();
  const rebound = counted([
    set(ref("out", f64s), ref("i"), num(1)),
    { kind: "assign", localId: "out", value: ref("src", f64s), loc },
  ]);
  expect(match(fn([rebound]), rebound)).toBeNull();
  const plain = counted([set(ref("out", f64s), ref("i"), num(1))]);
  expect(match(fn([plain]), plain, ["out"])).toBeNull();
  const inner = counted([set(ref("out", f64s), ref("j"), num(1))], ref("n"), "j");
  const outer = counted([inner]);
  expect(match(fn([outer]), outer)).toBeNull();
  expect(match(fn([outer]), inner)).not.toBeNull();
});

test("emitted loops version the body and tag typed-array memory", () => {
  const loop = counted([
    set(ref("out", f64s), ref("i"), bin("*", get(ref("src", f64s), ref("i")), num(2))),
  ]);
  const kernel = fn([loop]);
  const mod: IrModule = {
    irVersion: 17,
    sourceFile: loc.file,
    entry: "__main",
    functions: [
      { name: "__main", params: [], returnType: VOID, locals: [], body: [], loc },
      kernel,
    ],
  };
  const llvm = emitLlvmModule(mod);
  const body = /^define internal [^\n]*@sc_bf_kernel[^]*?^}/m.exec(llvm)![0];
  expect(body).toContain("bytes.version.fast");
  expect(body).toContain("bytes.version.slow");
  // The checked copy keeps its per-element tests; the guard reads lengths.
  expect(body).toContain("bytes.index.invalid");
  expect(body).toMatch(/store double [^\n]*, align 1, !tbaa !\d+/);
  expect(body).toMatch(/load double, ptr [^\n]*, align 1, !tbaa !\d+/);
  expect(body).toMatch(/load i64, ptr [^\n]*, !tbaa !\d+/);
  expect(body).toMatch(/load ptr, ptr [^\n]*, !tbaa !\d+/);
  const elements = /store double [^\n]*!tbaa !(\d+)/.exec(body)![1];
  const header = /load ptr, ptr [^\n]*!tbaa !(\d+)/.exec(body)![1];
  expect(elements).not.toBe(header);
  // Header loads are invariant for the view's lifetime; element accesses
  // are not.
  expect(body).toMatch(/load ptr, ptr [^\n]*, !tbaa !\d+, !invariant\.load !\{\}$/m);
  expect(body).toMatch(/load i64, ptr [^\n]*, !tbaa !\d+, !invariant\.load !\{\}$/m);
  expect(body).not.toMatch(/(load double|store double)[^\n]*invariant\.load/);
});

test("loops to a typed array's length version the other typed arrays they index", () => {
  const length = (receiver: IrExpr): IrExpr => ({
    kind: "bytesIntrinsic",
    method: "length",
    receiver,
    args: [],
    type: F64,
    loc,
  });
  const emit = (body: IrStmt[]): string => {
    const mod: IrModule = {
      irVersion: 17,
      sourceFile: loc.file,
      entry: "__main",
      functions: [
        { name: "__main", params: [], returnType: VOID, locals: [], body: [], loc },
        fn(body),
      ],
    };
    return /^define internal [^\n]*@sc_bf_kernel[^]*?^}/m.exec(emitLlvmModule(mod))![0];
  };
  // for (let i = 0; i < out.length; i++) out[i] = src[i] * 2
  const scaled = set(ref("out", f64s), ref("i"), bin("*", get(ref("src", f64s), ref("i")), num(2)));
  const body = emit([counted([scaled], length(ref("out", f64s)))]);
  const fast = /^bytes\.version\.fast\d+:$[^]*?^bytes\.version\.done\d+:$/m.exec(body)![0];
  // The loop keeps its integer induction, and the fast copy reads `src`
  // unchecked.
  expect(body).toContain("integer induction i");
  expect(fast).not.toContain("bytes.index");
  expect(body.slice(0, body.indexOf(fast))).toContain("bytes.index.invalid");
  // A body that rebinds `src` keeps one checked loop.
  const rebound = emit([
    counted(
      [scaled, { kind: "assign", localId: "src", value: ref("out", f64s), loc }],
      length(ref("out", f64s)),
    ),
  ]);
  expect(rebound).not.toContain("bytes.version.fast");
  expect(rebound).toContain("bytes.index.invalid");
});

test("worker programs test each receiver's shared storage once in the guard", () => {
  // for (let i = 0; i < n; i++) out[i] = src[i] * 2, where either view may
  // be shared.
  const loop = counted([
    set(ref("out", f64s), ref("i"), bin("*", get(ref("src", f64s), ref("i")), num(2))),
  ]);
  const kernel = fn([loop]);
  const mod: IrModule = {
    irVersion: 17,
    sourceFile: loc.file,
    entry: "__main",
    workers: true,
    functions: [
      { name: "__main", params: [], returnType: VOID, locals: [], body: [], loc },
      kernel,
    ],
  };
  const body = /^define internal [^\n]*@sc_bf_kernel[^]*?^}/m.exec(emitLlvmModule(mod))![0];
  const guard = body.slice(0, body.search(/^bytes\.version\.(fast|slow)\d+:$/m));
  expect(guard.match(/icmp eq ptr %\S+, null/g)).toHaveLength(2);
  const fast = /^bytes\.version\.fast\d+:$[^]*?^bytes\.version\.done\d+:$/m.exec(body)![0];
  expect(fast).not.toContain("bytes.shared");
  expect(fast).not.toMatch(/(load|store) atomic double/);
  // The checked copy keeps the shared-memory path for each access.
  const slow = body.slice(body.search(/^bytes\.version\.slow\d+:$/m), body.indexOf(fast));
  expect(slow).toContain("load atomic double");
  expect(slow).toContain("store atomic double");
});

test("index temps of a version's counter are integers in the fast copy", () => {
  // for (let i = 0; i < out.length; i++) { const j = i * 4; out[i] = src[j] + src[j + 1] }
  const length: IrExpr = {
    kind: "bytesIntrinsic",
    method: "length",
    receiver: ref("out", f64s),
    args: [],
    type: F64,
    loc,
  };
  const loop = counted(
    [
      { kind: "varDecl", localId: "at", init: bin("*", ref("i"), num(4)), loc },
      set(
        ref("out", f64s),
        ref("i"),
        bin(
          "+",
          get(ref("src", f64s), ref("at")),
          get(ref("src", f64s), bin("+", ref("at"), num(1))),
        ),
      ),
    ],
    length,
  );
  const mod: IrModule = {
    irVersion: 17,
    sourceFile: loc.file,
    entry: "__main",
    functions: [
      { name: "__main", params: [], returnType: VOID, locals: [], body: [], loc },
      fn([loop], [local("at", F64)]),
    ],
  };
  const body = /^define internal [^\n]*@sc_bf_kernel[^]*?^}/m.exec(emitLlvmModule(mod))![0];
  const fast = /^bytes\.version\.fast\d+:$[^]*?^bytes\.version\.done\d+:$/m.exec(body)![0];
  expect(body).toContain("alloca i64 ; integer at");
  expect(fast).toMatch(/mul nsw i64 %\S+, 4/);
  expect(fast).toMatch(/add nsw i64 %\S+, 1/);
  expect(fast).not.toContain("fmul");
  expect(fast).not.toContain("fptosi");
  expect(fast).not.toContain("bytes.index");
});

test("while loop counters below a bound version their accesses", () => {
  // while (i < n) { out[i] = src[i + 1]; i = i + 1 }
  const step: IrStmt = { kind: "assign", localId: "i", value: bin("+", ref("i"), num(1)), loc };
  const whileLoop = (body: IrStmt[]): IrStmt & { kind: "while" } => ({
    kind: "while",
    cond: { kind: "bin", op: "<", left: ref("i"), right: ref("n"), type: BOOL, loc },
    body,
    loc,
  });
  const copy = whileLoop([
    set(ref("out", f64s), ref("i"), get(ref("src", f64s), bin("+", ref("i"), num(1)))),
    step,
  ]);
  const declared = (loop: IrStmt): IrFunction =>
    fn([{ kind: "varDecl", localId: "i", init: ref("k"), loc }, loop]);
  const versionOf = (
    loop: IrStmt & { kind: "while" },
    workers = false,
  ): BytesLoopVersion | null => {
    const f = declared(loop);
    const ranges = analyzeIntegerRanges(f);
    return matchBytesLoopVersion(loop, null, {
      locals: new Map(f.locals.map((l) => [l.id, l])),
      invariantGlobals: new Set(),
      captured: new Set(),
      ranges,
      initialized: findInitializedByteLoopBindings(f).get(loop) ?? new Set(),
      proven: new Set(),
      scalarStrings: new Set(),
      workers,
      owned: new Set(),
    });
  };
  const version = versionOf(copy)!;
  expect(version.bounds.size).toBe(2);
  expect(version.bounded.map((c) => [version.receivers[c.receiver]!.ref, c.slack])).toEqual([
    [ref("out", f64s), 0],
    [ref("src", f64s), 1],
  ]);
  // `out[i]` needs `i` to start at 0 or above (`src[i + 1]` only at -1).
  expect(version.counters.map((c) => [c.ref.kind === "varRef" && c.ref.localId, c.min])).toEqual([
    ["i", 0],
  ]);
  // An access after the counter advances in the same pass stays checked.
  const advanced = whileLoop([step, set(ref("out", f64s), ref("i"), num(0))]);
  expect(versionOf(advanced)).toBeNull();
  // In a worker program, a while loop versions for its counter's accesses,
  // and not for thread-owned receivers alone.
  expect(versionOf(copy, true)!.ownedReceivers).toHaveLength(2);
  const job = whileLoop([set(ref("out", f64s), ref("k"), get(ref("src", f64s), ref("k"))), step]);
  expect(versionOf(job, true)).toBeNull();
  const mod: IrModule = {
    irVersion: 17,
    sourceFile: loc.file,
    entry: "__main",
    functions: [
      { name: "__main", params: [], returnType: VOID, locals: [], body: [], loc },
      declared(copy),
    ],
  };
  const body = /^define internal [^\n]*@sc_bf_kernel[^]*?^}/m.exec(emitLlvmModule(mod))![0];
  const fast = /^bytes\.version\.fast\d+:$[^]*?^bytes\.version\.done\d+:$/m.exec(body)![0];
  expect(fast).not.toContain("bytes.index");
  expect(body.slice(0, body.indexOf(fast))).toContain("bytes.index.invalid");
});

test("Float16Array accesses version in elements and share the element tag", () => {
  const f16s: IrType = { kind: "bytes", elem: "f16" };
  const withHalves = (body: IrStmt[]): IrFunction => {
    const f = fn(body, [local("half", f16s)]);
    return { ...f, params: [...f.params, { localId: "half", name: "half", type: f16s }] };
  };
  // half[i] = src[i + 1]; out[i] = half[i] * 2
  const loop = counted([
    set(ref("half", f16s), ref("i"), get(ref("src", f64s), bin("+", ref("i"), num(1)))),
    set(ref("out", f64s), ref("i"), bin("*", get(ref("half", f16s), ref("i")), num(2))),
  ]);
  const kernel = withHalves([loop]);
  const version = match(kernel, loop)!;
  expect(version.bounds.size).toBe(4);
  expect(version.receivers.map((r) => r.ref)).toEqual([
    ref("half", f16s),
    ref("src", f64s),
    ref("out", f64s),
  ]);
  // Element offsets against the element count, whatever the element size.
  expect(version.affine.map((c) => [c.scale, c.minOffset, c.maxEnd])).toEqual([
    [1, 0, 0],
    [1, 1, 1],
    [1, 0, 0],
  ]);

  const mod: IrModule = {
    irVersion: 17,
    sourceFile: loc.file,
    entry: "__main",
    functions: [
      { name: "__main", params: [], returnType: VOID, locals: [], body: [], loc },
      kernel,
    ],
  };
  const body = /^define internal [^\n]*@sc_bf_kernel[^]*?^}/m.exec(emitLlvmModule(mod))![0];
  const fast = /^bytes\.version\.fast\d+:$[^]*?^bytes\.version\.done\d+:$/m.exec(body)![0];
  expect(fast).toContain("call double @scr_f16_to_f64");
  expect(fast).toContain("call zeroext i16 @scr_f16_from_f64");
  expect(fast).not.toContain("bytes.index");
  const halfStore = /store i16 [^\n]*, align 1, !tbaa !(\d+)/.exec(fast)![1];
  const halfLoad = /load i16, ptr [^\n]*, align 1, !tbaa !(\d+)/.exec(fast)![1];
  const doubleStore = /store double [^\n]*, align 1, !tbaa !(\d+)/.exec(fast)![1];
  // Views of any element type may share a buffer: one element category.
  expect(halfStore).toBe(doubleStore);
  expect(halfLoad).toBe(doubleStore);
  // The checked copy keeps its per-element tests.
  expect(body.slice(0, body.indexOf(fast))).toContain("bytes.index.invalid");
});

test("bodies compiled without optimization keep one checked loop", () => {
  const loop = counted([set(ref("out", f64s), ref("i"), get(ref("src", f64s), ref("i")))]);
  const boxes = Array.from({ length: 512 }, (_, k) => local(`box${k}`, F64, true, { boxed: true }));
  const mod: IrModule = {
    irVersion: 17,
    sourceFile: loc.file,
    entry: "__main",
    functions: [
      { name: "__main", params: [], returnType: VOID, locals: [], body: [], loc },
      fn([loop], boxes),
    ],
  };
  const body = /^define internal [^\n]*@sc_bf_kernel[^]*?^}/m.exec(emitLlvmModule(mod))![0];
  expect(body.split("\n", 1)[0]).toContain("optnone");
  expect(body).not.toContain("bytes.version");
  expect(body).toContain("bytes.index.invalid");
});

const STR: IrType = { kind: "string" };
const charCode = (receiver: IrExpr, index: IrExpr): IrExpr => ({
  kind: "strIntrinsic",
  method: "charCodeAt",
  receiver,
  args: [index],
  type: F64,
  loc,
});

/** The kernel with a string parameter `text`. */
function textKernel(body: IrStmt[], mutable = false): IrFunction {
  const kernel = fn(body, [local("text", STR, mutable)]);
  kernel.params.push({ localId: "text", name: "text", type: STR });
  return kernel;
}

test("charCodeAt reads of a string binding version with the typed-array reads", () => {
  const read = charCode(ref("text", STR), bin("+", ref("i"), num(1)));
  const loop = counted([set(ref("out", f64s), ref("i"), read)]);
  const version = match(textKernel([loop]), loop)!;
  expect(version.bounds.has(read)).toBe(true);
  expect(
    version.receivers.map((r) => [r.ref.kind === "varRef" && r.ref.localId, r.string]),
  ).toEqual([
    ["out", false],
    ["text", true],
  ]);
  expect(version.affine.map((c) => [c.receiver, c.minOffset, c.maxEnd])).toEqual([
    [0, 0, 0],
    [1, 1, 1],
  ]);
  // A string the loop rebinds keeps its checked reads.
  const rebinding = counted([
    set(ref("out", f64s), ref("i"), charCode(ref("text", STR), ref("i"))),
    { kind: "assign", localId: "text", value: ref("text", STR), loc },
  ]);
  const rebound = match(textKernel([rebinding], true), rebinding)!;
  expect(rebound.receivers.map((r) => r.string)).toEqual([false]);
  // A string held as a slice of another string has no header to test.
  const sliced = match(textKernel([loop]), loop, [], ["text"])!;
  expect(sliced.receivers.map((r) => r.string)).toEqual([false]);
  expect(sliced.bounds.has(read)).toBe(false);
});

test("charAt reads of a string binding version as one-unit reads", () => {
  const read: IrExpr = {
    kind: "strIntrinsic",
    method: "charAt",
    receiver: ref("text", STR),
    args: [bin("-", ref("i"), num(1))],
    type: STR,
    loc,
  };
  const loop = counted([{ kind: "exprStmt", expr: read, loc }]);
  const version = match(textKernel([loop]), loop)!;
  expect(version.bounds.has(read)).toBe(true);
  expect(version.receivers.map((r) => r.string)).toEqual([true]);
  expect(version.affine.map((c) => [c.receiver, c.minOffset, c.maxEnd])).toEqual([[0, -1, -1]]);
});

test("the guard tests a string's ASCII bit and the fast copy reads bytes", () => {
  const loop = counted([set(ref("out", f64s), ref("i"), charCode(ref("text", STR), ref("i")))]);
  const kernel = textKernel([loop]);
  const mod: IrModule = {
    irVersion: 17,
    sourceFile: loc.file,
    entry: "__main",
    functions: [
      { name: "__main", params: [], returnType: VOID, locals: [], body: [], loc },
      kernel,
    ],
  };
  const body = /^define internal [^\n]*@sc_bf_kernel[^]*?^}/m.exec(emitLlvmModule(mod))![0];
  const guard = body.slice(0, body.search(/^bytes\.version\.slow\d*:/m));
  expect(guard).toMatch(/load i32, ptr %\S+\n\s+%\S+ = icmp slt i32 %\S+, 0/);
  // The byte copy, up to the units copy that follows it.
  const units = body.search(/^bytes\.version\.fast\.units\d+:/m);
  const fast = body.slice(body.search(/^bytes\.version\.fast\d+:/m), units < 0 ? undefined : units);
  expect(fast).toMatch(/load i8, ptr %\S+\n\s+%\S+ = uitofp i8/);
  expect(fast).not.toContain("@sc_str_char_code_at_int");
  // The checked copy keeps the inline helper and its fallback.
  expect(body).toContain("@sc_str_char_code_at_int");
});

test("while loop counters below a string's length version its reads", () => {
  // while (i < text.length && text.charCodeAt(i) === 32) i = i + 1
  const text = ref("text", STR);
  const read = charCode(text, ref("i"));
  const length: IrExpr = {
    kind: "strIntrinsic",
    method: "length",
    receiver: text,
    args: [],
    type: F64,
    loc,
  };
  const loop: IrStmt & { kind: "while" } = {
    kind: "while",
    cond: {
      kind: "logical",
      op: "&&",
      left: { kind: "bin", op: "<", left: ref("i"), right: length, type: BOOL, loc },
      right: { kind: "bin", op: "===", left: read, right: num(32), type: BOOL, loc },
      type: BOOL,
      loc,
    },
    body: [{ kind: "assign", localId: "i", value: bin("+", ref("i"), num(1)), loc }],
    loc,
  };
  const f = textKernel([{ kind: "varDecl", localId: "i", init: ref("k"), loc }, loop]);
  const version = matchBytesLoopVersion(loop, null, {
    locals: new Map(f.locals.map((l) => [l.id, l])),
    invariantGlobals: new Set(),
    captured: new Set(),
    ranges: analyzeIntegerRanges(f),
    initialized: findInitializedByteLoopBindings(f).get(loop) ?? new Set(),
    proven: new Set(),
    scalarStrings: new Set(),
    workers: false,
    owned: new Set(),
  })!;
  // The read is bounded by the counter's test against the length, not by
  // a static range the guard could not meet.
  expect(version.bounds.has(read)).toBe(true);
  expect(version.receivers.map((r) => r.string)).toEqual([true]);
  expect(version.bounded.map((c) => c.slack)).toEqual([0]);
  expect(version.fixed).toEqual([]);
});

test("a two-counter loop versions the typed arrays it indexes at either counter", () => {
  // for (let i = 0, j = k; i < j; i++, j--) { const t = out[i]; out[i] = out[j]; out[j] = t; }
  const loop: IrStmt & { kind: "for" } = {
    kind: "for",
    init: {
      kind: "block",
      body: [
        { kind: "varDecl", localId: "i", init: num(0), loc },
        { kind: "varDecl", localId: "j", init: ref("k"), loc },
      ],
      loc,
    },
    cond: { kind: "bin", op: "<", left: ref("i"), right: ref("j"), type: BOOL, loc },
    update: {
      kind: "block",
      body: [
        { kind: "assign", localId: "i", value: bin("+", ref("i"), num(1)), loc },
        { kind: "assign", localId: "j", value: bin("-", ref("j"), num(1)), loc },
      ],
      loc,
    },
    body: [
      { kind: "varDecl", localId: "t", init: get(ref("out", f64s), ref("i")), loc },
      set(ref("out", f64s), ref("i"), get(ref("out", f64s), ref("j"))),
      set(ref("out", f64s), ref("j"), ref("t")),
      // Another index stays checked.
      set(ref("src", f64s), bin("+", ref("i"), num(1)), num(0)),
    ],
    loc,
  };
  const kernel = fn([loop], [local("t", F64)]);
  const ranges = analyzeIntegerRanges(kernel);
  const locals = new Map(kernel.locals.map((l) => [l.id, l]));
  const paired = matchIntegerPairedForLoop(loop, locals, ranges)!;
  expect(paired).not.toBeNull();
  const version = matchBytesLoopVersion(
    loop,
    null,
    {
      locals,
      invariantGlobals: new Set(),
      captured: new Set(),
      ranges,
      initialized: findInitializedByteLoopBindings(kernel).get(loop) ?? new Set(),
      proven: new Set(),
      workers: false,
      owned: new Set(),
      scalarStrings: new Set(),
    },
    paired,
  )!;
  expect(version.paired?.loop).toBe(paired);
  expect(version.paired?.receivers.map((r) => version.receivers[r]!.ref)).toEqual([
    ref("out", f64s),
  ]);
  expect(version.bounds.size).toBe(4);
  const mod: IrModule = {
    irVersion: 17,
    sourceFile: loc.file,
    entry: "__main",
    functions: [
      { name: "__main", params: [], returnType: VOID, locals: [], body: [], loc },
      kernel,
    ],
  };
  const body = /^define internal [^\n]*@sc_bf_kernel[^]*?^}/m.exec(emitLlvmModule(mod))![0];
  const guard = body.slice(0, body.search(/^bytes\.version\.(fast|slow)\d+:$/m));
  expect(guard).toMatch(/icmp sge i64 %\S+, 0/);
  expect(guard).toMatch(/icmp slt i64 %\S+, %\S+/);
  const fast = /^bytes\.version\.fast\d+:$[^]*?^bytes\.version\.done\d+:$/m.exec(body)![0];
  // The fast copy keeps only the `src[i + 1]` check, and no second guard.
  expect(fast.match(/bytes\.index\.invalid\d+:/g)).toHaveLength(1);
  expect(fast).not.toContain("counted.fast");
});
