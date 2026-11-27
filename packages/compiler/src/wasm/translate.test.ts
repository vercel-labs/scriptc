import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { analyzeWasm } from "./binary.js";
import { decodeBase64, encodeBase64 } from "./base64.js";
import { WasmCursor, parseWasmModule } from "./module.js";
import { simdOp } from "./simd.js";
import {
  WasmTranslateError,
  signatureHash,
  stackCheckedFunctions,
  translateWasmModule,
  wasmSymbolPrefix,
} from "./translate.js";

const SHA = new Uint8Array(32).fill(0xab);

/** (module (func (export "add") (param i32 i32) (result i32) local.get 0 local.get 1 i32.add)
 *  (memory (export "mem") 1) (data (i32.const 8) "hi")) */
const ADD = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 7, 1, 96, 2, 127, 127, 1, 127, 3, 2, 1, 0, 5, 3, 1, 0, 1, 7, 13,
  2, 3, 97, 100, 100, 0, 0, 3, 109, 101, 109, 2, 0, 10, 9, 1, 7, 0, 32, 0, 32, 1, 106, 11, 11, 8, 1,
  0, 65, 8, 11, 2, 104, 105,
]);

/** Every top-level line must be one the native helper's text partitioner
 * accepts (native/llvm-codegen/src/partition.cpp), so translated modules
 * keep the program on its concurrent parsing path. */
function topLevelLines(text: string[]): string[] {
  const lines: string[] = [];
  for (const part of text) {
    let inFunction = false;
    for (const line of part.split("\n")) {
      if (inFunction) {
        if (line === "}") inFunction = false;
        continue;
      }
      if (line.startsWith("define ")) inFunction = true;
      lines.push(line);
    }
  }
  return lines;
}

describe("translateWasmModule", () => {
  test("emits functions, thunks, data and the descriptor in the helper's grammar", () => {
    const out = translateWasmModule(ADD, SHA, { boundsChecks: false });
    const prefix = wasmSymbolPrefix(SHA);
    expect(prefix).toBe("scr_wasm_abababababababab");
    expect(out.descriptor).toBe(`@${prefix}_desc`);
    const text = out.text.join("\n");
    expect(text).toContain(`define internal i32 @${prefix}_f0(ptr %inst, i32 %p0, i32 %p1)`);
    expect(text).toContain(`define internal void @${prefix}_x0(ptr %inst, ptr %a, ptr %r)`);
    expect(text).toContain(`c"hi"`);
    expect(text).toContain(`"disable-tail-calls"="true"`);
    for (const line of topLevelLines(out.text)) {
      expect(
        line === "" || /^(define internal |@[\w.$-]+ = (private|internal) )/.test(line),
        line,
      ).toBe(true);
    }
    for (const decl of out.decls) expect(decl).toMatch(/^declare /);
  });

  test("keeps custom sections only when asked, and gives unexported table functions call thunks", () => {
    // (module (type $t (func (param i32) (result i32))) (table 2 funcref)
    //   (elem (i32.const 0) $hidden $shown) (func $hidden (type $t) local.get 0)
    //   (func $shown (export "shown") (type $t) local.get 0)), plus a custom
    //   section "meta" with "hi".
    const refs = new Uint8Array([
      0, 97, 115, 109, 1, 0, 0, 0, 1, 6, 1, 96, 1, 127, 1, 127, 3, 3, 2, 0, 0, 4, 4, 1, 112, 0, 2,
      7, 9, 1, 5, 115, 104, 111, 119, 110, 0, 1, 9, 8, 1, 0, 65, 0, 11, 2, 0, 1, 10, 11, 2, 4, 0,
      32, 0, 11, 4, 0, 32, 0, 11, 0, 7, 4, 109, 101, 116, 97, 104, 105,
    ]);
    const prefix = wasmSymbolPrefix(SHA);
    const plain = translateWasmModule(refs, SHA, { boundsChecks: false }).text.join("\n");
    expect(plain).toContain(
      `@${prefix}_customs = private constant [0 x { ptr, i64, ptr, i64 }] []`,
    );
    expect(plain).not.toContain(`c"hi"`);
    const kept = translateWasmModule(refs, SHA, { boundsChecks: false, customSections: true });
    const text = kept.text.join("\n");
    expect(text).toContain(`@${prefix}_c0 = private unnamed_addr constant [2 x i8] c"hi", align 1`);
    expect(text).toContain(`@${prefix}_customs = private constant [1 x { ptr, i64, ptr, i64 }]`);
    // One call thunk for the signature, used by the unexported function
    // only (the exported one has its export thunk).
    expect(text).toContain(
      `define internal void @${prefix}_k0(ptr %code, ptr %inst, ptr %a, ptr %r)`,
    );
    expect(text).toContain(`%res = call i32 %code(ptr %inst, i32 `);
    expect(text).toContain(
      `@${prefix}_calls = private constant [2 x ptr] [ptr @${prefix}_k0, ptr null]`,
    );
    for (const line of topLevelLines(kept.text)) {
      expect(
        line === "" || /^(define internal |@[\w.$-]+ = (private|internal) )/.test(line),
        line,
      ).toBe(true);
    }
  });

  test("checks memory accesses explicitly only when asked", () => {
    const guarded = translateWasmModule(ADD, SHA, { boundsChecks: false }).text.join("\n");
    const checked = translateWasmModule(ADD, SHA, { boundsChecks: true }).text.join("\n");
    expect(guarded).not.toContain("%msize");
    expect(checked).toContain("%msize");
  });

  test("reads a memarg with an explicit memory index as one immediate", () => {
    // (func (result i32) (i32.load 0 offset=8 (i32.const 0))) with memory 1:
    // memarg flags 0x42 (alignment 2, memory index present), memory 0,
    // offset 8, then `end`.
    const bytes = new Uint8Array([
      0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 127, 3, 2, 1, 0, 5, 3, 1, 0, 1, 10, 10, 1, 8,
      0, 65, 0, 40, 66, 0, 8, 11,
    ]);
    expect(analyzeWasm(bytes).status).toBe("valid");
    const text = translateWasmModule(bytes, SHA, { boundsChecks: false }).text.join("\n");
    expect(text).toContain("add i64 %v1, 8");
    expect(text).toContain("load i32, ptr %v3");
  });

  test("translates every valid module of the WebAssembly spec test suite", () => {
    const cases = readFileSync(join(import.meta.dirname, "../../test/wasm-spec-cases.txt"), "utf8")
      .split("\n")
      .filter((line) => line !== "" && !line.startsWith("#"));
    let translated = 0;
    for (const line of cases) {
      const [, , where, b64] = line.split(" ");
      const bytes = decodeBase64(b64!)!;
      if (analyzeWasm(bytes).status !== "valid") continue;
      try {
        translateWasmModule(bytes, SHA, { boundsChecks: false });
      } catch (error) {
        throw new Error(`${where}: ${error instanceof Error ? error.message : String(error)}`);
      }
      translated++;
    }
    expect(translated).toBeGreaterThan(800);
  });
});

/** A module from its sections: `[id, ...payload]`, each payload under 128
 * bytes. */
function wasmModule(...sections: number[][]): Uint8Array {
  const out = [0, 97, 115, 109, 1, 0, 0, 0];
  for (const [id, ...payload] of sections) out.push(id!, payload.length, ...payload);
  return new Uint8Array(out);
}

/** (module (memory 1) (func (export "f") (param i32) (result i32)
 *  local.get 0 i32.load <memarg>)) with the memarg's bytes as given. */
function loadModule(memarg: number[]): Uint8Array {
  const body = [0, 0x20, 0, 0x28, ...memarg, 0x0b];
  return wasmModule(
    [1, 1, 0x60, 1, 0x7f, 1, 0x7f],
    [3, 1, 0],
    [5, 1, 0, 1],
    [7, 1, 1, 0x66, 0, 0],
    [10, 1, body.length, ...body],
  );
}

describe("memargs and operand types", () => {
  test("a memarg naming memory 0 explicitly translates as the plain form", () => {
    // Flags 0x42: alignment 2 with bit 6 set, then memory index 0 and
    // offset 4. Validation and translation read the same three immediates.
    // Only the descriptor (which records the module's byte length) differs.
    const code = (memarg: number[]): string[] =>
      translateWasmModule(loadModule(memarg), SHA, { boundsChecks: true })
        .text.join("\n")
        .split("\n")
        .filter((line) => !line.startsWith(`@${wasmSymbolPrefix(SHA)}_desc =`));
    expect(code([0x42, 0, 4])).toEqual(code([0x02, 4]));
  });

  test("a memarg naming another memory is refused", () => {
    expect(() =>
      translateWasmModule(loadModule([0x42, 1, 4]), SHA, { boundsChecks: true }),
    ).toThrow(/memory 1/);
  });

  test("local.tee of an i32 into an externref local is refused", () => {
    // (func (local externref) i32.const 1 local.tee 0 drop): the operand
    // never reaches a reference slot.
    const body = [1, 1, 0x6f, 0x41, 1, 0x22, 0, 0x1a, 0x0b];
    const bytes = wasmModule([1, 1, 0x60, 0, 0], [3, 1, 0], [10, 1, body.length, ...body]);
    expect(() => translateWasmModule(bytes, SHA, { boundsChecks: false })).toThrow(
      /local\.tee operand type does not match/,
    );
  });
});

describe("module parsing", () => {
  test("reads the parts translation needs", () => {
    const m = parseWasmModule(ADD);
    expect(m.types).toEqual([{ params: [0x7f, 0x7f], results: [0x7f] }]);
    expect(m.exports.map((e) => e.name)).toEqual(["add", "mem"]);
    expect(m.memories).toEqual([{ min: 1, max: null, imported: false }]);
    expect(m.datas[0]!.mode).toBe("active");
    expect([...m.declaredRefs]).toEqual([0]);
  });

  test("decodes signed 64-bit LEB128 into two's-complement halves", () => {
    const halves = (bytes: number[]): [number, number] =>
      new WasmCursor(new Uint8Array(bytes), 0).s64();
    expect(halves([0x7f])).toEqual([0xffffffff, 0xffffffff]);
    expect(halves([0x80, 0x80, 0x80, 0x80, 0x10])).toEqual([0, 1]);
    expect(halves([0xff, 0xff, 0xff, 0xff, 0x0f])).toEqual([0xffffffff, 0]);
    expect(halves([0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x7f])).toEqual([
      0, 0x80000000,
    ]);
    expect(halves([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00])).toEqual([
      0xffffffff, 0x7fffffff,
    ]);
  });
});

describe("large modules", () => {
  /** A module exporting `sum`, whose body adds one to its i32 parameter
   * `additions` times and returns it. */
  function summingModule(additions: number): Uint8Array {
    const leb = (value: number): number[] => {
      const out: number[] = [];
      do {
        let byte = value & 0x7f;
        value >>>= 7;
        if (value !== 0) byte |= 0x80;
        out.push(byte);
      } while (value !== 0);
      return out;
    };
    const section = (id: number, body: number[]): number[] => [id, ...leb(body.length), ...body];
    const instructions: number[] = [];
    for (let i = 0; i < additions; i++) instructions.push(0x20, 0, 0x41, 1, 0x6a);
    const body = [0x01, 0x01, 0x7f, ...instructions, 0x0b];
    return new Uint8Array([
      ...Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0),
      ...section(1, [1, 0x60, 1, 0x7f, 1, 0x7f]),
      ...section(3, [1, 0]),
      ...section(7, [1, 3, ...Buffer.from("sum"), 0, 0]),
      ...section(10, [1, ...leb(body.length), ...body]),
    ]);
  }

  test("a function body larger than the host's argument limit translates", () => {
    const out = translateWasmModule(summingModule(100_000), SHA, { boundsChecks: false });
    const text = out.text.join("\n");
    expect(text).toContain("define internal i32");
    expect(text.split("\n").filter((line) => line.includes("add i32")).length).toBe(100_000);
  });
});

describe("stack checks", () => {
  test("only functions through which the stack can grow without bound check it", () => {
    // f0 <-> f1 recurse mutually, f2 recurses on itself, f3 calls f0 once.
    const calls = new Uint8Array([
      0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 5, 4, 0, 0, 0, 0, 10, 21, 4, 4, 0, 16, 1,
      11, 4, 0, 16, 0, 11, 4, 0, 16, 2, 11, 4, 0, 16, 0, 11,
    ]);
    expect([...stackCheckedFunctions(parseWasmModule(calls))].sort()).toEqual([0, 1, 2]);
    expect(stackCheckedFunctions(parseWasmModule(ADD)).size).toBe(0);
    // Only code without the fault handler checks explicitly.
    const checked = translateWasmModule(calls, SHA, { boundsChecks: true }).text.join("\n");
    expect(checked.split("@scr_wasm_stack_limit").length - 1).toBe(3);
    const guarded = translateWasmModule(calls, SHA, { boundsChecks: false }).text.join("\n");
    expect(guarded).not.toContain("@scr_wasm_stack_limit");
  });
});

// A small module assembler for the SIMD translator tests.
function leb(n: number): number[] {
  const out: number[] = [];
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) b |= 0x80;
    out.push(b);
  } while (n > 0);
  return out;
}
function vec(items: number[][]): number[] {
  return [...leb(items.length), ...items.flat()];
}
function section(id: number, body: number[]): number[] {
  return [id, ...leb(body.length), ...body];
}
function simdModule(...sections: number[][]): Uint8Array {
  return new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, ...sections.flat()]);
}
const SIMD_I32 = 0x7f;
const SIMD_V128 = 0x7b;
const simdType = (params: number[], results: number[]): number[] => [
  0x60,
  ...vec(params.map((p) => [p])),
  ...vec(results.map((r) => [r])),
];
const simdTypes = (...fts: number[][]): number[] => section(1, vec(fts));
const simdFuncs = (...indices: number[]): number[] => section(3, vec(indices.map((i) => leb(i))));
const simdBody = (code: number[], locals: number[] = [0x00]): number[] => {
  const content = [...locals, ...code, 0x0b];
  return [...leb(content.length), ...content];
};
const simdCode = (...bodies: number[][]): number[] => section(10, vec(bodies));
const simdExports = (...entries: number[][]): number[] => section(7, vec(entries));
const simdName = (text: string): number[] => {
  const bytes = [...Buffer.from(text)];
  return [...leb(bytes.length), ...bytes];
};
const simdMemory = (...limits: number[][]): number[] => section(5, vec(limits));
const V128_CONST = (lanes: number[]): number[] => [0xfd, 0x0c, ...lanes];

describe("SIMD translation", () => {
  const prefix = wasmSymbolPrefix(SHA);

  test("translates the issue's module: i32.const, i8x16.splat, drop", () => {
    // (module (func i32.const 0 i8x16.splat drop))
    const bytes = simdModule(
      simdTypes(simdType([], [])),
      simdFuncs(0),
      simdCode(simdBody([0x41, 0x00, 0xfd, 0x0f, 0x1a])),
    );
    const text = translateWasmModule(bytes, SHA, { boundsChecks: false }).text.join("\n");
    expect(text).toContain("trunc i32 0 to i8");
    expect(text).toContain("insertelement <16 x i8> undef, i8 ");
    expect(text).toContain("shufflevector <16 x i8>");
    expect(text).toContain("bitcast <16 x i8>");
  });

  test("passes v128 parameters and results between functions", () => {
    // (func $add (param v128 v128) (result v128) local.get 0 local.get 1 i8x16.add)
    // (func (export "get") (result i32) v128.const ... v128.const ... call $add
    //   i8x16.extract_lane_u 0)
    const bytes = simdModule(
      simdTypes(simdType([SIMD_V128, SIMD_V128], [SIMD_V128]), simdType([], [SIMD_I32])),
      simdFuncs(0, 1),
      simdExports([...simdName("get"), 0x00, ...leb(1)]),
      simdCode(
        simdBody([0x20, 0x00, 0x20, 0x01, 0xfd, 0x6e]),
        simdBody([
          ...V128_CONST(Array.from({ length: 16 }, (_, i) => i + 1)),
          ...V128_CONST(Array.from({ length: 16 }, (_, i) => i + 2)),
          0x10,
          0x00,
          0xfd,
          0x16,
          0x00,
        ]),
      ),
    );
    const text = translateWasmModule(bytes, SHA, { boundsChecks: false }).text.join("\n");
    expect(text).toContain(
      `define internal <4 x i32> @${prefix}_f0(ptr %inst, <4 x i32> %p0, <4 x i32> %p1)`,
    );
    expect(text).toContain("add <16 x i8>");
    expect(text).toContain("extractelement <16 x i8>");
    expect(text).toContain("zext i8");
    expect(text).toContain(`define internal void @${prefix}_x1(ptr %inst, ptr %a, ptr %r)`);
    // The signature identity includes the vector operands.
    expect(text).toContain('c"VV:V\\00"');
  });

  test("loads and stores a full vector with a 16-byte bounds check", () => {
    // (func (export "roundtrip") (param i32) (result i32)
    //   local.get 0 v128.const . v128.store
    //   local.get 0 v128.load i8x16.extract_lane_u 0)
    const bytes = simdModule(
      simdTypes(simdType([SIMD_I32], [SIMD_I32])),
      simdFuncs(0),
      simdMemory([0x00, 0x01]),
      simdExports([...simdName("roundtrip"), 0x00, 0x00]),
      simdCode(
        simdBody([
          0x20,
          0x00,
          ...V128_CONST(Array.from({ length: 16 }, (_, i) => i)),
          0xfd,
          0x0b,
          0x00,
          0x00,
          0x20,
          0x00,
          0xfd,
          0x00,
          0x00,
          0x00,
          0xfd,
          0x16,
          0x00,
        ]),
      ),
    );
    const guarded = translateWasmModule(bytes, SHA, { boundsChecks: false }).text.join("\n");
    expect(guarded).toContain("store <4 x i32>");
    expect(guarded).toContain("load <4 x i32>, ptr");
    // The memarg alignment is a hint: the same instruction may run unaligned.
    expect(guarded).toContain("align 1");
    expect(guarded).not.toContain("align 16");
    const checked = translateWasmModule(bytes, SHA, { boundsChecks: true }).text.join("\n");
    expect(checked).toContain("add i64 %v");
    expect(checked).toMatch(/add i64 %v\d+, 16/);
  });

  test("keeps a dropped vector load's trap by loading it volatile", () => {
    // (func i32.const 0 v128.load drop)
    const bytes = simdModule(
      simdTypes(simdType([], [])),
      simdFuncs(0),
      simdMemory([0x00, 0x01]),
      simdCode(simdBody([0x41, 0x00, 0xfd, 0x00, 0x00, 0x00, 0x1a])),
    );
    const guarded = translateWasmModule(bytes, SHA, { boundsChecks: false }).text.join("\n");
    expect(guarded).toContain("load volatile <4 x i32>");
  });

  test("puts the build's target-cpu on translated functions", () => {
    const bytes = simdModule(
      simdTypes(simdType([], [])),
      simdFuncs(0),
      simdCode(simdBody([0x41, 0x00, 0xfd, 0x0f, 0x1a])),
    );
    const text = translateWasmModule(bytes, SHA, {
      boundsChecks: false,
      targetAttributes: ' "target-cpu"="x86-64-v3"',
    }).text.join("\n");
    expect(text).toContain('nounwind "disable-tail-calls"="true" "target-cpu"="x86-64-v3"');
    const plain = translateWasmModule(bytes, SHA, { boundsChecks: false }).text.join("\n");
    expect(plain).not.toContain("target-cpu");
  });

  test("zero-initializes v128 locals and stores updates", () => {
    // (func (local v128) local.get 0 drop)
    const bytes = simdModule(
      simdTypes(simdType([], [])),
      simdFuncs(0),
      simdCode(simdBody([0x20, 0x00, 0x1a], [0x01, 0x01, SIMD_V128])),
    );
    const text = translateWasmModule(bytes, SHA, { boundsChecks: false }).text.join("\n");
    expect(text).toContain("%l0 = alloca <4 x i32>");
    expect(text).toContain("store <4 x i32> zeroinitializer, ptr %l0");
    expect(text).toContain("load <4 x i32>, ptr %l0");
  });

  test("emulates lane arithmetic with vector operations", () => {
    // (func (param v128 v128) (result v128) i8x16.add_sat? no: add, sub, min_s,
    //   shl, bitselect, bitmask, all_true)
    const bytes = simdModule(
      simdTypes(simdType([SIMD_V128, SIMD_V128], [SIMD_V128]), simdType([SIMD_V128], [SIMD_I32])),
      simdFuncs(0, 1),
      simdCode(
        simdBody([0x20, 0x00, 0x20, 0x01, 0xfd, 0x6e]),
        simdBody([
          0x20,
          0x00,
          0xfd,
          0x64, // i8x16.bitmask
          0x1a,
          0x20,
          0x00,
          0xfd,
          0x63, // i8x16.all_true
          0x1a,
          0x20,
          0x00,
          0x41,
          0x03,
          0xfd,
          0x6c, // i8x16.shr_s
          0x1a,
          0x20,
          0x00,
          0x20,
          0x00,
          0x20,
          0x00,
          0xfd,
          0x52, // v128.bitselect
          0x1a,
          0x20,
          0x00,
          0xfd,
          0x80,
          0x02, // i8x16.relaxed_swizzle: relaxed SIMD is not translated yet
        ]),
      ),
    );
    expect(() => translateWasmModule(bytes, SHA, { boundsChecks: false })).toThrow(
      WasmTranslateError,
    );
    // Drop the swizzle and the module translates with vector instructions.
    const supported = simdModule(
      simdTypes(simdType([SIMD_V128, SIMD_V128], [SIMD_V128]), simdType([SIMD_V128], [SIMD_I32])),
      simdFuncs(0, 1),
      simdCode(
        simdBody([0x20, 0x00, 0x20, 0x01, 0xfd, 0x6e]),
        simdBody([0x20, 0x00, 0xfd, 0x64, 0x1a, 0x20, 0x00, 0xfd, 0x63, 0x1a, 0x41, 0x00]),
      ),
    );
    const text = translateWasmModule(supported, SHA, { boundsChecks: false }).text.join("\n");
    expect(text).toContain("icmp ne <16 x i8>");
    expect(text).toContain("icmp slt <16 x i8>");
    expect(text).toContain("bitcast <16 x i1>");
    expect(text).toContain("add <16 x i8>");
  });

  const descLine = (out: ReturnType<typeof translateWasmModule>): string =>
    out.text
      .join("\n")
      .split("\n")
      .find((line) => line.startsWith(`${out.descriptor} =`))!;

  test("represents v128 exports, globals and imports at the boundary", () => {
    // An exported v128 function: no slot thunk, and the descriptor is ABI 3.
    const exported = simdModule(
      simdTypes(simdType([], [SIMD_V128])),
      simdFuncs(0),
      simdExports([...simdName("f"), 0x00, 0x00]),
      simdCode(simdBody(V128_CONST(new Array(16).fill(0)))),
    );
    const out = translateWasmModule(exported, SHA, { boundsChecks: false });
    expect(out.text.join("\n")).not.toContain(`${wasmSymbolPrefix(SHA)}_x0`);
    expect(descLine(out)).toContain("i64 3, i64 0,");
    // A v128 global with a 16-byte cell accessed at align 8.
    const global = simdModule(
      section(
        6,
        vec([[SIMD_V128, 0x00, ...V128_CONST(Array.from({ length: 16 }, (_, i) => i)), 0x0b]]),
      ),
    );
    const globalOut = translateWasmModule(global, SHA, { boundsChecks: false });
    expect(globalOut.text.join("\n")).toContain("store <4 x i32>");
    expect(globalOut.text.join("\n")).toContain(", align 8");
    expect(descLine(globalOut)).toContain("i64 3, i64 0,");
    // A v128 import calls the imported function's code directly.
    const imported = simdModule(
      simdTypes(simdType([SIMD_V128, SIMD_V128], [SIMD_V128]), simdType([], [])),
      section(2, vec([[...simdName("m"), ...simdName("f"), 0x00, ...leb(0)]])),
      simdFuncs(1),
      simdCode(
        simdBody([
          ...V128_CONST(new Array(16).fill(1)),
          ...V128_CONST(new Array(16).fill(2)),
          0x10,
          0x00,
          0x1a,
        ]),
      ),
    );
    const importedOut = translateWasmModule(imported, SHA, { boundsChecks: false });
    const importedText = [...importedOut.decls, ...importedOut.text].join("\n");
    expect(importedText).toContain("declare ptr @scr_wasm_import_funcref(ptr, i32)");
    expect(importedText).toContain("@scr_wasm_import_funcref(ptr %host, i32 0)");
    expect(importedText).toContain("%code(ptr %cinst, <4 x i32> %p0, <4 x i32> %p1)");
    // A scalar module keeps descriptor ABI 2.
    const scalar = translateWasmModule(ADD, SHA, { boundsChecks: false });
    expect(descLine(scalar)).toContain("i64 2, i64 0,");
    // Relaxed SIMD is still not translated.
    const unsupported = simdModule(
      simdTypes(simdType([], [])),
      simdFuncs(0),
      simdCode(simdBody([0xfd, 0x80, 0x02])), // i8x16.relaxed_swizzle
    );
    expect(() => translateWasmModule(unsupported, SHA, { boundsChecks: false })).toThrow(
      /SIMD instruction 0xfd 256 is not supported yet/,
    );
  });
});

/** A module with one function that takes the instruction's operands and
 * performs it, for checking its lowered IR. */
function oneOpModule(sub: number): Uint8Array {
  const op = simdOp(sub)!;
  const code: number[] = [];
  for (let i = 0; i < op.params.length; i++) code.push(0x20, ...leb(i));
  code.push(0xfd, ...leb(sub));
  switch (op.immediate) {
    case 1:
    case 2:
      for (let i = 0; i < 16; i++) code.push(i);
      break;
    case 3:
      code.push(0);
      break;
    case 4:
      code.push(0, 0);
      break;
    case 5:
      code.push(0, 0, 0);
      break;
  }
  return simdModule(
    simdTypes(simdType([...op.params], [...op.results])),
    simdFuncs(0),
    simdMemory([0x00, 0x01]),
    simdCode(simdBody(code)),
  );
}

describe("later SIMD instruction families", () => {
  test.each([
    [1, "load <8 x i8>"], // load8x8_s
    [14, "select <16 x i1>"], // i8x16.swizzle
    [98, "llvm.ctpop.v16i8"], // i8x16.popcnt
    [102, "icmp sgt <16 x i16>"], // narrow_i16x8_u clamps signed inputs
    [111, "llvm.sadd.sat.v16i8"], // add_sat_s
    [124, "add <8 x i16>"], // extadd_pairwise
    [130, "ashr <8 x i32>"], // q15mulr rounds by shifting a widened product
    [186, "add <4 x i32>"], // dot_i16x8_s
    [228, "fadd <4 x float>"], // f32x4.add
    [234, "fcmp olt <4 x float>"], // pmin is a compare and select
    [253, "llvm.fptoui.sat.v2i32.v2f64"], // trunc_sat with zero high lanes
  ])("lowers 0xfd %i to %s", (sub, fragment) => {
    const out = translateWasmModule(oneOpModule(sub), SHA, { boundsChecks: false });
    const text = [...out.decls, ...out.text].join("\n");
    expect(text).toContain(fragment);
  });

  test("every standard SIMD instruction translates", () => {
    const failures: string[] = [];
    for (let sub = 0; sub < 0x100; sub++) {
      if (simdOp(sub) === undefined) continue;
      try {
        translateWasmModule(oneOpModule(sub), SHA, { boundsChecks: false });
      } catch (error) {
        failures.push(`0x${sub.toString(16)}: ${(error as Error).message}`);
      }
    }
    expect(failures).toEqual([]);
  });
});

describe("helpers", () => {
  test("equal signatures share their identity across modules", () => {
    expect(signatureHash("ii:i")).toBe(signatureHash("ii:i"));
    expect(signatureHash("ii:i")).not.toBe(signatureHash("i:i"));
    expect(signatureHash(":")).toMatch(/^u0x[0-9a-f]{16}$/);
  });

  test("base64 round-trips module bytes", () => {
    expect(encodeBase64(ADD)).toBe(Buffer.from(ADD).toString("base64"));
    expect(decodeBase64(encodeBase64(ADD))).toEqual(ADD);
    expect(encodeBase64(new Uint8Array([1]))).toBe("AQ==");
    expect(encodeBase64(new Uint8Array([1, 2]))).toBe("AQI=");
  });
});
