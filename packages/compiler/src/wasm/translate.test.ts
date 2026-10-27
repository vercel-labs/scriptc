import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { analyzeWasm } from "./binary.js";
import { decodeBase64, encodeBase64 } from "./base64.js";
import { WasmCursor, parseWasmModule } from "./module.js";
import {
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
