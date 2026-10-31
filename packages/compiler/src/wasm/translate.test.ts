import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { analyzeWasm, isTranslatableFeature } from "./binary.js";
import { decodeBase64, encodeBase64 } from "./base64.js";
import { WasmCursor, parseWasmModule, skipImmediates } from "./module.js";
import {
  signatureHash,
  stackCheckedFunctions,
  translateWasmModule,
  wasmSymbolPrefix,
} from "./translate.js";

const v8Validate = (bytes: Uint8Array): boolean =>
  (
    globalThis as unknown as { WebAssembly: { validate(bytes: Uint8Array): boolean } }
  ).WebAssembly.validate(bytes);

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

const simdFixtures: { name: string; base64: string; width: number }[] = JSON.parse(
  readFileSync(
    new URL("../../../../tests/wasm-spec/corpus/simd-data.json", import.meta.url),
    "utf8",
  ),
);

describe("SIMD128 instruction translation", () => {
  test.each(simdFixtures)(
    "validates and translates $name with either bounds policy",
    ({ base64 }) => {
      const bytes = new Uint8Array(Buffer.from(base64, "base64"));
      expect(v8Validate(bytes)).toBe(true);
      expect(analyzeWasm(bytes).status).toBe("valid");
      for (const boundsChecks of [false, true]) {
        const out = translateWasmModule(bytes, SHA, { boundsChecks });
        expect(out.text.join("\n")).toContain("define internal");
        for (const line of topLevelLines(out.text)) {
          expect(
            line === "" || /^(define internal |@[\w.$-]+ = (private|internal) )/.test(line),
            line,
          ).toBe(true);
        }
      }
    },
  );

  test("exports vector functions with a rejecting JavaScript thunk", () => {
    const vector = [253, 12, ...new Array<number>(16).fill(0)];
    const vectorBody = [0, ...vector, 11];
    const abi = wasmModule(
      [1, 1, 96, 0, 1, 123],
      [3, 1, 0],
      [7, 1, 6, 118, 101, 99, 116, 111, 114, 0, 0],
      [10, 1, vectorBody.length, ...vectorBody],
    );
    expect(v8Validate(abi)).toBe(true);
    expect(analyzeWasm(abi).status).toBe("valid");
    expect(translateWasmModule(abi, SHA, { boundsChecks: true }).text.join("\n")).toContain(
      "call void @scr_wasm_vector_js_error()",
    );
  });

  test.each([
    ["extract-21", [253, 21, 2], 2, 16],
    ["replace-34", [253, 34, 1], 2, 2],
    ["shuffle", [253, 13, 31], 2, 32],
    ["memory-0", [253, 0, 0, 0], 2, 5],
    ["lane-memory-87", [253, 87, 0, 0, 1], 4, 2],
  ])("rejects invalid SIMD immediates in %s", (name, needle, delta, replacement) => {
    const bytes = Buffer.from(simdFixtures.find((f) => f.name === name)!.base64, "base64");
    const offset = bytes.indexOf(Buffer.from(needle));
    expect(offset).toBeGreaterThan(0);
    bytes[offset + delta] = replacement;
    expect(v8Validate(bytes)).toBe(false);
    expect(analyzeWasm(bytes).status).toBe("invalid");
  });

  test("the opcode inventory matches the implemented and exercised subset", () => {
    const inventory: { opcode: string; translated: boolean }[] = JSON.parse(
      readFileSync(
        new URL("../../../../internal/compatibility/wasm-simd-opcodes.json", import.meta.url),
        "utf8",
      ),
    );
    expect(inventory).toHaveLength(256);
    expect(new Set(inventory.map((entry) => entry.opcode)).size).toBe(256);
    const exercised = new Set<number>();
    const relaxed: { base64: string }[] = JSON.parse(
      readFileSync(
        new URL("../../../../tests/wasm-spec/corpus/simd-contract.json", import.meta.url),
        "utf8",
      ),
    ).relaxed;
    for (const fixture of [...simdFixtures, ...relaxed]) {
      const m = parseWasmModule(Buffer.from(fixture.base64, "base64"));
      for (const code of m.codes) {
        const c = new WasmCursor(m.bytes, code.body.start);
        while (c.pos < code.body.end) {
          const op = c.u8();
          const pos = c.pos;
          if (op === 0xfd) {
            exercised.add(c.u32());
            c.pos = pos;
          }
          skipImmediates(c, op);
        }
      }
    }
    expect(
      inventory.filter((entry) => entry.translated).map((entry) => Number(entry.opcode)),
    ).toEqual([...exercised].sort((a, b) => a - b));
    expect(exercised.size).toBe(256);
  });

  test.each([0x23, 0xd6, 0x63, 0x64, 0xc3, 0xc4])(
    "rejects scalar operands for integer SIMD opcode %i",
    (sub) => {
      const compare = sub === 0x23 || sub === 0xd6;
      const vector = [253, 12, ...new Array<number>(16).fill(0)];
      const op = sub < 128 ? [253, sub] : [253, sub, 1];
      const instructions = [
        0,
        ...(compare ? vector : []),
        65,
        0,
        ...op,
        ...(compare ? [253, 83] : []),
        11,
      ];
      const bytes = wasmModule(
        [1, 1, 96, 0, 1, 127],
        [3, 1, 0],
        [10, 1, instructions.length, ...instructions],
      );
      expect(v8Validate(bytes)).toBe(false);
      expect(analyzeWasm(bytes).status).toBe("invalid");
    },
  );

  test.each([0x6b, 0x8c, 0xad, 0xcb])("rejects a non-i32 shift count for opcode %i", (sub) => {
    const vector = [253, 12, ...new Array<number>(16).fill(0)];
    const op = sub < 128 ? [253, sub] : [253, sub, 1];
    const instructions = [0, ...vector, 66, 0, ...op, 253, 83, 11];
    const bytes = wasmModule(
      [1, 1, 96, 0, 1, 127],
      [3, 1, 0],
      [10, 1, instructions.length, ...instructions],
    );
    expect(v8Validate(bytes)).toBe(false);
    expect(analyzeWasm(bytes).status).toBe("invalid");
  });

  test.each([0x87, 0x9c, 0x7c, 0xba])("rejects scalar operands for widening opcode %i", (sub) => {
    const binary = sub === 0x9c || sub === 0xba;
    const vector = [253, 12, ...new Array<number>(16).fill(0)];
    const op = sub < 128 ? [253, sub] : [253, sub, 1];
    const instructions = [0, ...(binary ? vector : []), 65, 0, ...op, 253, 83, 11];
    const bytes = wasmModule(
      [1, 1, 96, 0, 1, 127],
      [3, 1, 0],
      [10, 1, instructions.length, ...instructions],
    );
    expect(v8Validate(bytes)).toBe(false);
    expect(analyzeWasm(bytes).status).toBe("invalid");
  });

  test("vector function references retain native signatures with rejecting JS thunks", () => {
    const original = Buffer.from(
      simdFixtures.find((f) => f.name === "internal-vector-call")!.base64,
      "base64",
    );
    const c = new WasmCursor(original, 8);
    let pos = c.pos;
    while (c.pos < original.length) {
      pos = c.pos;
      const id = c.u8(),
        size = c.u32();
      if (id === 10) break;
      c.pos += size;
    }
    const bytes = Buffer.concat([
      original.subarray(0, pos),
      Buffer.from([9, 5, 1, 3, 0, 1, 1]),
      original.subarray(pos),
    ]);
    expect(v8Validate(bytes)).toBe(true);
    expect(analyzeWasm(bytes).status).toBe("valid");
    expect(translateWasmModule(bytes, SHA, { boundsChecks: true }).text.join("\n")).toContain(
      "call void @scr_wasm_vector_js_error()",
    );
  });

  test("internal vector function bodies stay type checked", () => {
    const bytes = Buffer.from(
      simdFixtures.find((f) => f.name === "internal-vector-call")!.base64,
      "base64",
    );
    const offset = bytes.lastIndexOf(Buffer.from([32, 0, 253, 97, 11]));
    expect(offset).toBeGreaterThan(0);
    bytes[offset] = 65;
    expect(v8Validate(bytes)).toBe(false);
    expect(analyzeWasm(bytes).status).toBe("invalid");
  });

  test.each([0x65, 0x6f, 0x82, 0x9b])(
    "rejects scalar operands for saturating/narrowing opcode %i",
    (sub) => {
      const vector = [253, 12, ...new Array<number>(16).fill(0)];
      const op = sub < 128 ? [253, sub] : [253, sub, 1];
      const instructions = [0, ...vector, 65, 0, ...op, 253, 83, 11];
      const bytes = wasmModule(
        [1, 1, 96, 0, 1, 127],
        [3, 1, 0],
        [10, 1, instructions.length, ...instructions],
      );
      expect(v8Validate(bytes)).toBe(false);
      expect(analyzeWasm(bytes).status).toBe("invalid");
    },
  );

  test("large function emission does not use the JavaScript argument stack", () => {
    const count = 70_000;
    const body = Buffer.alloc(1 + 7 * count + 3);
    for (let i = 0; i < count; i++) body.set([32, 0, 65, 1, 106, 33, 0], 1 + 7 * i);
    body.set([32, 0, 11], 1 + 7 * count);
    const leb = (value: number): Buffer => {
      const bytes: number[] = [];
      do {
        const low = value & 127;
        value >>>= 7;
        bytes.push(low | (value ? 128 : 0));
      } while (value);
      return Buffer.from(bytes);
    };
    const code = Buffer.concat([Buffer.from([1]), leb(body.length), body]);
    const bytes = Buffer.concat([
      Buffer.from([0, 97, 115, 109, 1, 0, 0, 0, 1, 6, 1, 96, 1, 127, 1, 127, 3, 2, 1, 0, 10]),
      leb(code.length),
      code,
    ]);
    expect(v8Validate(bytes)).toBe(true);
    expect(analyzeWasm(bytes).status).toBe("valid");
    const text = translateWasmModule(bytes, SHA, { boundsChecks: true }).text.join("\n");
    expect(text.split("add i32").length - 1).toBe(count);
  });

  test.each([0x9a, 0xa2, 0xaf, 0xbb, 0xe2, 0xee, 0x114])(
    "rejects reserved SIMD opcode %i as malformed",
    (sub) => {
      const op = sub < 128 ? [253, sub] : [253, (sub & 127) | 128, sub >>> 7];
      const instructions = [0, ...op, 65, 0, 11];
      const bytes = wasmModule(
        [1, 1, 96, 0, 1, 127],
        [3, 1, 0],
        [10, 1, instructions.length, ...instructions],
      );
      expect(v8Validate(bytes)).toBe(false);
      expect(analyzeWasm(bytes).status).toBe("malformed");
    },
  );

  test.each([0x41, 0xe4, 0xe3, 0x67, 0x5e, 0xfc])(
    "rejects scalar operands for float SIMD opcode %i",
    (sub) => {
      const vector = [253, 12, ...new Array<number>(16).fill(0)];
      const binary = sub === 0x41 || sub === 0xe4;
      const op = sub < 128 ? [253, sub] : [253, sub, 1];
      const instructions = [0, ...(binary ? vector : []), 65, 0, ...op, 253, 83, 11];
      const bytes = wasmModule(
        [1, 1, 96, 0, 1, 127],
        [3, 1, 0],
        [10, 1, instructions.length, ...instructions],
      );
      expect(v8Validate(bytes)).toBe(false);
      expect(analyzeWasm(bytes).status).toBe("invalid");
    },
  );

  test("SIMD stores check the full range even with guard pages", () => {
    const bytes = Buffer.from(simdFixtures.find((f) => f.name === "store-param")!.base64, "base64");
    const text = translateWasmModule(bytes, SHA, { boundsChecks: false }).text.join("\n");
    expect(text).toContain("icmp ugt i64");
    expect(text).toContain("store volatile <16 x i8>");
    expect(text.indexOf("icmp ugt i64")).toBeLessThan(text.indexOf("store volatile <16 x i8>"));
  });

  test("relaxed SIMD lowers through its portable strict projection", () => {
    const instructions = [
      0,
      253,
      12,
      ...new Array<number>(16).fill(0),
      253,
      12,
      ...new Array<number>(16).fill(0),
      253,
      128,
      2,
      253,
      83,
      11,
    ];
    const bytes = wasmModule(
      [1, 1, 96, 0, 1, 127],
      [3, 1, 0],
      [10, 1, instructions.length, ...instructions],
    );
    expect(v8Validate(bytes)).toBe(true);
    expect(analyzeWasm(bytes).features).toEqual(["simd", "relaxed-simd"]);
    expect(isTranslatableFeature("relaxed-simd")).toBe(true);
    expect(analyzeWasm(bytes).status).toBe("valid");
    expect(translateWasmModule(bytes, SHA, { boundsChecks: true }).text.join("\n")).toContain(
      "extractelement",
    );
  });

  test("seeded mutations never admit a SIMD module V8 rejects", () => {
    let state = 0x1679;
    const random = (n: number): number => {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      return (state >>> 0) % n;
    };
    for (let i = 0; i < 4000; i++) {
      const bytes = Buffer.from(simdFixtures[random(simdFixtures.length)]!.base64, "base64");
      const offset = random(bytes.length);
      bytes[offset] = random(256);
      const summary = analyzeWasm(bytes);
      if (summary.status === "unsupported") continue;
      expect(summary.status === "valid", `mutation ${i}: ${summary.error}`).toBe(v8Validate(bytes));
    }
  });

  test("a SIMD instruction does not hide a subsequent scalar type error", () => {
    const bytes = Buffer.from(simdFixtures.find((f) => f.name === "const")!.base64, "base64");
    const store = bytes.indexOf(Buffer.from([253, 11, 0, 0]));
    bytes[store + 4] = 66; // i64.const replaces the i32 function result.
    expect(v8Validate(bytes)).toBe(false);
    expect(analyzeWasm(bytes).status).toBe("invalid");
  });
});

describe("SIMD native contract", () => {
  const contract = JSON.parse(
    readFileSync(
      join(import.meta.dirname, "../../../../tests/wasm-spec/corpus/simd-contract.json"),
      "utf8",
    ),
  ) as {
    fixtures: Record<string, string>;
    relaxed: { op: number; base64: string; expected: number[] }[];
  };
  for (const [name, base64] of Object.entries(contract.fixtures)) {
    test(`validates and lowers ${name} in both bounds modes`, () => {
      const bytes = Buffer.from(base64, "base64");
      expect(v8Validate(bytes)).toBe(true);
      expect(analyzeWasm(bytes).status).toBe("valid");
      for (const boundsChecks of [false, true])
        expect(() => translateWasmModule(bytes, SHA, { boundsChecks })).not.toThrow();
    });
  }
  for (const f of contract.relaxed) {
    test(`relaxed opcode ${f.op} validates and lowers with typed operands`, () => {
      const bytes = Buffer.from(f.base64, "base64");
      expect(v8Validate(bytes)).toBe(true);
      expect(analyzeWasm(bytes).status).toBe("valid");
      for (const boundsChecks of [false, true])
        expect(() => translateWasmModule(bytes, SHA, { boundsChecks })).not.toThrow();
      // Replace a v128.const with i32.const plus nops, preserving section sizes.
      const bad = Buffer.from(bytes);
      const at = bad.indexOf(Buffer.from([253, 12]));
      bad[at] = 65;
      bad[at + 1] = 0;
      bad.fill(1, at + 2, at + 18);
      expect(v8Validate(bad)).toBe(false);
      expect(analyzeWasm(bad).status).toBe("invalid");
    });
  }
});

describe("recovered adversarial vector ABI cases", () => {
  const abi = JSON.parse(
    readFileSync(
      new URL("../../../../tests/wasm-spec/corpus/simd-abi.json", import.meta.url),
      "utf8",
    ),
  ) as Record<string, string>;
  test.each(Object.entries(abi))(
    "validates and lowers %s with the vector runtime ABI",
    (_name, base64) => {
      const bytes = Buffer.from(base64, "base64");
      expect(v8Validate(bytes)).toBe(true);
      expect(analyzeWasm(bytes).status).toBe("valid");
      for (const boundsChecks of [false, true]) {
        const out = translateWasmModule(bytes, SHA, { boundsChecks });
        const text = out.text.join("\n");
        expect(text.slice(text.indexOf(out.descriptor + " ="))).toContain(
          `i64 ${bytes.length}, i64 3,`,
        );
      }
    },
  );
  test("keeps scalar descriptor ABI compatibility", () => {
    const out = translateWasmModule(ADD, SHA, { boundsChecks: false });
    const text = out.text.join("\n");
    expect(text.slice(text.indexOf(out.descriptor + " ="))).toContain(`i64 ${ADD.length}, i64 2,`);
  });
  test("boundary mutations agree with V8 validation", () => {
    const originals = Object.values(abi).map((base64) => Buffer.from(base64, "base64"));
    let seed = 0x1679ab1;
    const random = (limit: number): number => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return (seed >>> 0) % limit;
    };
    for (let i = 0; i < 2000; i++) {
      const bytes = Uint8Array.from(originals[random(originals.length)]!);
      bytes[random(bytes.length)] = random(256);
      const summary = analyzeWasm(bytes),
        valid = v8Validate(bytes);
      if (summary.status === "valid") expect(valid, `boundary mutation ${i}`).toBe(true);
      if (summary.status === "invalid" || summary.status === "malformed")
        expect(valid, `boundary mutation ${i}`).toBe(false);
    }
  });
});
