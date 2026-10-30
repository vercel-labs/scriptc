import { expect, test } from "vitest";
import { emitLlvmModule } from "../src/backend/llvm/emitter.js";
import {
  BOOL,
  F64,
  VOID,
  bytesOf,
  type IrBytesElem,
  type IrExpr,
  type IrLocal,
  type IrModule,
  type IrStmt,
} from "../src/ir/ir.js";
import { validateModule } from "../src/ir/validate.js";

const loc = { file: "bytes-hot-loop.ts", start: 0, end: 0 };
const elems: IrBytesElem[] = ["u8", "u32", "i32", "f32"];

function fixture(): IrModule {
  const locals: IrLocal[] = [];
  const body: IrStmt[] = [];
  const num = (value: number): IrExpr => ({ kind: "numLit", value, type: F64, loc });

  for (const [n, elem] of elems.entries()) {
    const type = bytesOf(elem);
    const localId = `b.${n}`;
    const ref = (): IrExpr => ({ kind: "varRef", localId, type, loc });
    locals.push({ id: localId, name: `b${n}`, type, mutable: false });
    body.push(
      {
        kind: "varDecl",
        localId,
        init: { kind: "bytesNew", source: num(1), type, loc },
        loc,
      },
      { kind: "bytesSet", arr: ref(), index: num(0), value: num(n + 1), loc },
      {
        kind: "exprStmt",
        expr: {
          kind: "bytesIntrinsic",
          method: "get",
          receiver: ref(),
          args: [num(0)],
          type: F64,
          loc,
        },
        loc,
      },
    );
  }

  locals.push({ id: "index", name: "index", type: F64, mutable: true });
  body.push(
    { kind: "varDecl", localId: "index", init: num(1), loc },
    {
      kind: "exprStmt",
      expr: {
        kind: "bytesIntrinsic",
        method: "get",
        receiver: { kind: "varRef", localId: "b.0", type: bytesOf("u8"), loc },
        args: [
          {
            kind: "assignExpr",
            localId: "index",
            value: num(0),
            type: F64,
            loc,
          },
        ],
        type: F64,
        loc,
      },
      loc,
    },
  );

  return {
    irVersion: 17,
    sourceFile: loc.file,
    entry: "__main",
    functions: [{ name: "__main", params: [], returnType: VOID, locals, body, loc }],
  };
}

function receiverReassignmentFixture(): IrModule {
  const bytes = bytesOf("u8");
  const num = (value: number): IrExpr => ({ kind: "numLit", value, type: F64, loc });
  const ref = (localId: string): IrExpr => ({ kind: "varRef", localId, type: bytes, loc });
  const replacementCondition = (receiverId: string, replacementId: string): IrExpr => ({
    kind: "toBool",
    operand: {
      kind: "assignExpr",
      localId: receiverId,
      value: ref(replacementId),
      type: bytes,
      loc,
    },
    type: BOOL,
    loc,
  });
  const numericTernary = (cond: IrExpr, thenValue: number, elseValue: number): IrExpr => ({
    kind: "ternary",
    cond,
    then: num(thenValue),
    else_: num(elseValue),
    type: F64,
    loc,
  });
  const locals: IrLocal[] = [
    { id: "read", name: "read", type: bytes, mutable: true },
    { id: "readReplacement", name: "readReplacement", type: bytes, mutable: false },
    { id: "write", name: "write", type: bytes, mutable: true },
    { id: "writeReplacement", name: "writeReplacement", type: bytes, mutable: false },
  ];
  const declareBytes = (localId: string): IrStmt => ({
    kind: "varDecl",
    localId,
    init: { kind: "bytesNew", source: num(1), type: bytes, loc },
    loc,
  });
  const body: IrStmt[] = [
    declareBytes("read"),
    declareBytes("readReplacement"),
    {
      kind: "exprStmt",
      expr: {
        kind: "bytesIntrinsic",
        method: "get",
        receiver: ref("read"),
        args: [numericTernary(replacementCondition("read", "readReplacement"), 0, 0)],
        type: F64,
        loc,
      },
      loc,
    },
    declareBytes("write"),
    declareBytes("writeReplacement"),
    {
      kind: "bytesSet",
      arr: ref("write"),
      index: num(0),
      value: numericTernary(replacementCondition("write", "writeReplacement"), 55, 66),
      loc,
    },
  ];

  return {
    irVersion: 17,
    sourceFile: loc.file,
    entry: "__main",
    functions: [{ name: "__main", params: [], returnType: VOID, locals, body, loc }],
  };
}

function sideEffectFixture(): IrModule {
  const mod = fixture();
  mod.functions.unshift({
    name: "sideIndex",
    params: [],
    returnType: F64,
    locals: [],
    body: [{ kind: "return", value: { kind: "numLit", value: 0, type: F64, loc }, loc }],
    loc,
  });
  mod.functions
    .find((fn) => fn.name === "__main")!
    .body.push({
      kind: "exprStmt",
      expr: {
        kind: "bytesIntrinsic",
        method: "get",
        receiver: { kind: "varRef", localId: "b.0", type: bytesOf("u8"), loc },
        args: [{ kind: "call", callee: "sideIndex", args: [], type: F64, loc }],
        type: F64,
        loc,
      },
      loc,
    });
  return mod;
}

function integerLoopFixture(mutatesIndex = false): IrModule {
  const bytes = bytesOf("u8");
  const num = (value: number): IrExpr => ({ kind: "numLit", value, type: F64, loc });
  const ref = (localId: string, type = F64): IrExpr => ({ kind: "varRef", localId, type, loc });
  const bytesRef = (): IrExpr => ref("bytes", bytes);
  const indexRef = (): IrExpr => ref("index");
  const get: IrExpr = {
    kind: "bytesIntrinsic",
    method: "get",
    receiver: bytesRef(),
    args: [indexRef()],
    type: F64,
    loc,
  };
  const loopBody: IrStmt[] = [];
  if (mutatesIndex) {
    loopBody.push({
      kind: "assign",
      localId: "index",
      value: { kind: "bin", op: "+", left: indexRef(), right: num(1), type: F64, loc },
      loc,
    });
  }
  loopBody.push(
    {
      kind: "assign",
      localId: "sum",
      value: { kind: "bin", op: "+", left: ref("sum"), right: get, type: F64, loc },
      loc,
    },
    { kind: "bytesSet", arr: bytesRef(), index: indexRef(), value: ref("sum"), loc },
  );
  return {
    irVersion: 17,
    sourceFile: loc.file,
    entry: "__main",
    functions: [
      {
        name: "__main",
        params: [],
        returnType: VOID,
        locals: [
          { id: "bytes", name: "bytes", type: bytes, mutable: false },
          { id: "sum", name: "sum", type: F64, mutable: true },
          { id: "index", name: "index", type: F64, mutable: true },
        ],
        body: [
          {
            kind: "varDecl",
            localId: "bytes",
            init: { kind: "bytesNew", source: num(4), type: bytes, loc },
            loc,
          },
          { kind: "varDecl", localId: "sum", init: num(0), loc },
          {
            kind: "for",
            init: { kind: "varDecl", localId: "index", init: num(0), loc },
            cond: {
              kind: "bin",
              op: "<",
              left: indexRef(),
              right: {
                kind: "bytesIntrinsic",
                method: "length",
                receiver: bytesRef(),
                args: [],
                type: F64,
                loc,
              },
              type: BOOL,
              loc,
            },
            update: {
              kind: "assign",
              localId: "index",
              value: { kind: "bin", op: "+", left: indexRef(), right: num(1), type: F64, loc },
              loc,
            },
            body: loopBody,
            loc,
          },
        ],
        loc,
      },
    ],
  };
}

test("LLVM emission performs typed-array element access directly on the valid path", () => {
  const mod = fixture();
  expect(validateModule(mod)).toEqual([]);
  const ll = emitLlvmModule(mod);
  expect(ll).toContain("%ScrBytes = type { i64, i64, i32, ptr, ptr, i8, i8, i8, i8, ptr }");
  expect(ll).toContain("getelementptr inbounds i8");
  expect(ll).toContain("getelementptr inbounds i32");
  expect(ll).toContain("getelementptr inbounds float");
  expect(ll).toContain("bytes.index.invalid");
  // The generic getter is only the shared cold trap funnel for invalid indices.
  expect(ll).toContain("call double @scr_bytes_get");
  expect(ll).not.toContain("@scr_bytes_set(");
  expect(ll).not.toContain("@scr_bytes_retain_v");
});

test("stable receivers borrow across index calls", () => {
  const mod = sideEffectFixture();
  expect(validateModule(mod)).toEqual([]);

  const ll = emitLlvmModule(mod);

  // The call cannot replace this uncaptured local's owning binding.
  expect(ll).not.toContain("call ptr @scr_bytes_retain_v");
  // An int32 index result returns through the i32 entry.
  expect(ll).toMatch(/call (?:double|i32) @sc_f_sideIndex(?:\.i32)?\(/);

  expect(ll).toContain("call double @scr_bytes_get");
});

test("receiver assignments nested in numeric operands retain the receiver snapshot", () => {
  const mod = receiverReassignmentFixture();
  expect(validateModule(mod)).toEqual([]);

  const ll = emitLlvmModule(mod);

  // Two receiver snapshots plus one retain per yielded bytes assignment for
  // the binding's stored reference. The RHS temp takes over the
  // replacement's own reference: the assignment is its last use.
  expect(ll.match(/call ptr @scr_bytes_retain_v/g)).toHaveLength(4);
});

test("canonical byte loops keep their induction variable and indices integral", () => {
  const mod = integerLoopFixture();
  expect(validateModule(mod)).toEqual([]);

  const ll = emitLlvmModule(mod);

  expect(ll).toContain("alloca i64 ; integer induction index");
  expect(ll).toContain("icmp ult i64");
  // The proven in-bounds index needs no element check at all. Do not assert
  // on `fptosi double` here: the fixture's inline ToUint32 coercion of the
  // running sum legitimately uses it.
  expect(ll).not.toContain("bytes.index");
});

test("a body mutation keeps the byte loop on the general f64 path", () => {
  const mod = integerLoopFixture(true);
  expect(validateModule(mod)).toEqual([]);

  const ll = emitLlvmModule(mod);

  expect(ll).not.toContain("integer induction index");
  expect(ll).toContain("bytes.index.valid");
  expect(ll).toContain("fptosi double");
});

test("worker programs read and write shared views at the checked integer index", () => {
  const ll = emitLlvmModule({ ...fixture(), workers: true });
  // The shared path uses the index the inline path checked, as an integer:
  // each element is one relaxed atomic access of its width, aligned to it.
  expect(ll).toMatch(/load atomic i8, ptr %\w+ monotonic, align 1/);
  expect(ll).toMatch(/load atomic i32, ptr %\w+ monotonic, align 4/);
  expect(ll).toMatch(/load atomic float, ptr %\w+ monotonic, align 4/);
  expect(ll).toMatch(/store atomic i8 [%\w.]+, ptr %\w+ monotonic, align 1/);
  expect(ll).toMatch(/store atomic i32 [%\w.]+, ptr %\w+ monotonic, align 4/);
  expect(ll).toMatch(/store atomic float [%\w.]+, ptr %\w+ monotonic, align 4/);
  expect(ll).not.toContain("@scr_bytes_shared_get_int");
  expect(ll).not.toContain("@scr_bytes_shared_get_f64");
  expect(ll).not.toContain("@scr_bytes_shared_set");
  expect(ll).not.toContain("@scr_bytes_get_or_nan");
  expect(ll).not.toContain("@scr_bytes_set(");
  // Both paths join as one integer, which converts to a number after the join.
  expect(ll).toMatch(
    /= phi i32 \[ %\w+, %bytes\.local\.done\d+ \], \[ %\w+, %bytes\.shared\.done\d+ \]/,
  );
});

test("worker loops poll for cancellation on the back edge", () => {
  const mod = integerLoopFixture(true);
  const ll = emitLlvmModule({ ...mod, workers: true });
  const blocks = ll.split(/\n(?=[\w.]+:)/);
  const update = blocks.find((block) => block.startsWith("loop.u"));
  // The poll budget is decremented in the continue target, after the body;
  // the condition block is a single exit, so LLVM can rotate the loop.
  expect(update).toContain("sub i32");
  const cond = blocks.find((block) => block.startsWith("loop.c"));
  expect(cond).not.toContain("sub i32");
});

test("large record clones stay outlined while small clones remain inlineable", () => {
  const record = (id: string, count: number): IrModule => {
    const fields = Array.from({ length: count }, (_, i) => ({ name: `f${i}`, type: F64 }));
    const type = { kind: "record", shapeId: id } as const;
    return {
      irVersion: 17,
      sourceFile: "record-clone.ts",
      entry: "__main",
      records: [{ id, fields }],
      functions: [
        {
          name: "__main",
          params: [],
          returnType: VOID,
          locals: [{ id: "source", name: "source", type, mutable: false }],
          body: [
            {
              kind: "exprStmt",
              expr: {
                kind: "recordClone",
                source: { kind: "varRef", localId: "source", type, loc },
                overrides: [{ name: "f0", value: { kind: "numLit", value: 1, type: F64, loc } }],
                type,
                loc,
              },
              loc,
            },
          ],
          loc,
        },
      ],
    };
  };
  const small = emitLlvmModule(record("small", 2));
  const large = emitLlvmModule(record("large", 16));
  expect(small).toContain("define internal ptr @sc_rclone_small(ptr %src) #0");
  expect(small).not.toContain("attributes #2");
  expect(large).toContain("define internal ptr @sc_rclone_large(ptr %src) #2");
  expect(large).toContain("attributes #2 = { noinline sanitize_address uwtable }");
});

test("Uint8ClampedArray stores clamp and round without a runtime call", () => {
  const type = bytesOf("u8c");
  const mod: IrModule = {
    irVersion: 17,
    sourceFile: loc.file,
    entry: "__main",
    functions: [
      { name: "__main", params: [], returnType: VOID, locals: [], body: [], loc },
      {
        name: "store",
        params: [
          { localId: "px", name: "px", type },
          { localId: "v", name: "v", type: F64 },
        ],
        returnType: VOID,
        locals: [
          { id: "px", name: "px", type, mutable: false },
          { id: "v", name: "v", type: F64, mutable: false },
        ],
        body: [
          {
            kind: "bytesSet",
            arr: { kind: "varRef", localId: "px", type, loc },
            index: { kind: "numLit", value: 0, type: F64, loc },
            value: { kind: "varRef", localId: "v", type: F64, loc },
            loc,
          },
        ],
        loc,
      },
    ],
  };
  expect(validateModule(mod)).toEqual([]);
  const body = /^define internal [^\n]*@sc_bf_store[^]*?^}/m.exec(emitLlvmModule(mod))![0];
  expect(body).not.toContain("scr_bytes_to_u8_clamp");
  expect(body).toMatch(/fcmp ogt double %\S+, 0\.0/);
  expect(body).toMatch(/fcmp oge double %\S+, 255\.0/);
  expect(body).toMatch(/fadd double %\S+, 0x4330000000000000/);
  expect(body).toMatch(/fsub double %\S+, 0x4330000000000000/);
  expect(body).toMatch(/store i8 [^\n]*, align 1/);
});
