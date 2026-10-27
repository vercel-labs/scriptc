import { describe, expect, test } from "vitest";
import { analyzeWasm, isTranslatableFeature, isWasmHeader } from "./binary.js";

/** V8's verdict (the compiler's type world declares no WebAssembly value). */
const v8Validate = (bytes: Uint8Array): boolean =>
  (
    globalThis as unknown as { WebAssembly: { validate(bytes: Uint8Array): boolean } }
  ).WebAssembly.validate(bytes);

// A minimal module assembler: enough structure to aim at one decoder rule
// per test. Every module is also checked against V8 (Node is the oracle).

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

function name(text: string): number[] {
  const bytes = [...new TextEncoder().encode(text)];
  return [...leb(bytes.length), ...bytes];
}

function vec(items: number[][]): number[] {
  return [...leb(items.length), ...items.flat()];
}

function section(id: number, body: number[]): number[] {
  return [id, ...leb(body.length), ...body];
}

function module(...sections: number[][]): Uint8Array {
  return new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, ...sections.flat()]);
}

const I32 = 0x7f;
const I64 = 0x7e;
const F32 = 0x7d;
const V128 = 0x7b;
const EXTERNREF = 0x6f;

const funcType = (params: number[], results: number[]): number[] => [
  0x60,
  ...vec(params.map((p) => [p])),
  ...vec(results.map((r) => [r])),
];
const types = (...fts: number[][]): number[] => section(1, vec(fts));
const funcs = (...typeIndices: number[]): number[] =>
  section(3, vec(typeIndices.map((t) => leb(t))));
const body = (code: number[], locals: number[][] = []): number[] => {
  const content = [...vec(locals), ...code, 0x0b];
  return [...leb(content.length), ...content];
};
const code = (...bodies: number[][]): number[] => section(10, vec(bodies));
const memory = (...limits: number[][]): number[] => section(5, vec(limits));
const exportsOf = (...entries: number[][]): number[] => section(7, vec(entries));

function check(bytes: Uint8Array) {
  const summary = analyzeWasm(bytes);
  const accepted = summary.status === "valid" || summary.status === "unsupported";
  expect(accepted, summary.error ?? "").toBe(v8Validate(bytes));
  return summary;
}

describe("analyzeWasm", () => {
  test("an empty module is valid and uses no proposal", () => {
    const s = check(module());
    expect(s).toMatchObject({ status: "valid", error: null, features: [], functions: 0, size: 8 });
    expect(isWasmHeader(module())).toBe(true);
  });

  test("counts functions, imports, exports, memories, tables and globals", () => {
    const s = check(
      module(
        types(funcType([I32, I32], [I32]), funcType([], [])),
        section(
          2,
          vec([
            [...name("env"), ...name("log"), 0x00, 0x01],
            [...name("wasi_snapshot_preview1"), ...name("proc_exit"), 0x00, 0x01],
          ]),
        ),
        funcs(0),
        section(4, vec([[0x70, 0x00, 0x01]])),
        memory([0x00, 0x01]),
        section(6, vec([[I32, 0x01, 0x41, 0x00, 0x0b]])),
        exportsOf([...name("add"), 0x00, 0x02], [...name("memory"), 0x02, 0x00]),
        code(body([0x20, 0x00, 0x20, 0x01, 0x6a])),
      ),
    );
    expect(s).toMatchObject({
      status: "valid",
      functions: 1,
      imports: 2,
      exports: 2,
      importModules: ["env", "wasi_snapshot_preview1"],
      memories: 1,
      tables: 1,
      globals: 1,
    });
  });

  test.each([
    [
      "sign-extension",
      module(types(funcType([I32], [I32])), funcs(0), code(body([0x20, 0x00, 0xc0]))),
    ],
    [
      "nontrapping-fptoint",
      module(types(funcType([F32], [I32])), funcs(0), code(body([0x20, 0x00, 0xfc, 0x00]))),
    ],
    [
      "bulk-memory",
      module(
        types(funcType([], [])),
        funcs(0),
        memory([0x00, 0x01]),
        code(body([0x41, 0x00, 0x41, 0x00, 0x41, 0x00, 0xfc, 0x0b, 0x00])),
      ),
    ],
    [
      "multi-value",
      module(types(funcType([], [I32, I64])), funcs(0), code(body([0x41, 0x01, 0x42, 0x02]))),
    ],
    ["reference-types", module(section(4, vec([[EXTERNREF, 0x00, 0x01]])))],
    ["extended-const", module(section(6, vec([[I32, 0x00, 0x41, 0x01, 0x41, 0x02, 0x6a, 0x0b]])))],
    [
      "mutable-globals",
      module(section(2, vec([[...name("env"), ...name("sp"), 0x03, I32, 0x01]]))),
    ],
  ])("detects %s and stays translatable", (feature, bytes) => {
    const s = check(bytes);
    expect(s.status).toBe("valid");
    expect(s.features).toContain(feature);
    expect(isTranslatableFeature(feature)).toBe(true);
  });

  test.each([
    [
      "simd",
      module(
        types(funcType([], [V128])),
        funcs(0),
        code(body([0xfd, 0x0c, ...Array.from({ length: 16 }, () => 0)])),
      ),
    ],
    ["threads", module(memory([0x03, 0x01, 0x01]))],
    ["exceptions", module(types(funcType([], [])), section(13, vec([[0x00, 0x00]])))],
    ["tail-call", module(types(funcType([], [])), funcs(0), code(body([0x12, 0x00])))],
    ["memory64", module(memory([0x04, 0x01]))],
    ["multi-memory", module(memory([0x00, 0x01], [0x00, 0x01]))],
    ["gc", module(section(1, vec([[0x5f, 0x00]])))],
  ])("reports %s as outside the translatable set", (feature, bytes) => {
    const s = check(bytes);
    expect(s.status).toBe("unsupported");
    expect(s.unsupported).toEqual([feature]);
    expect(isTranslatableFeature(feature)).toBe(false);
  });

  test.each([
    ["bad magic", new Uint8Array([0x00, 0x61, 0x73, 0x6e, 1, 0, 0, 0]), "malformed", "magic"],
    ["bad version", new Uint8Array([0x00, 0x61, 0x73, 0x6d, 2, 0, 0, 0]), "malformed", "version"],
    ["sections out of order", module(funcs(), types()), "malformed", "unexpected section"],
    ["section size mismatch", module([0x01, 0x02, 0x00, 0x00]), "malformed", "section size"],
    [
      "overlong integer",
      module([0x01, 0x06, 0x80, 0x80, 0x80, 0x80, 0x80, 0x00]),
      "malformed",
      "integer",
    ],
    ["invalid UTF-8 name", module(exportsOf([0x01, 0xff, 0x00, 0x00])), "malformed", "UTF-8"],
    [
      "function and code counts differ",
      module(types(funcType([], [])), funcs(0, 0), code(body([]))),
      "malformed",
      "inconsistent",
    ],
    [
      "illegal opcode",
      module(types(funcType([], [])), funcs(0), code(body([0xff]))),
      "malformed",
      "illegal opcode",
    ],
    [
      "memory.init without a data count section",
      module(
        types(funcType([], [])),
        funcs(0),
        memory([0x00, 0x01]),
        code(body([0x41, 0x00, 0x41, 0x00, 0x41, 0x00, 0xfc, 0x08, 0x00, 0x00])),
      ),
      "malformed",
      "data count",
    ],
    [
      "type mismatch",
      module(types(funcType([], [I32])), funcs(0), code(body([0x42, 0x00]))),
      "invalid",
      "type mismatch",
    ],
    [
      "unknown function",
      module(types(funcType([], [])), funcs(0), code(body([0x10, 0x05]))),
      "invalid",
      "unknown function",
    ],
    [
      "duplicate export",
      module(
        types(funcType([], [])),
        funcs(0),
        exportsOf([...name("f"), 0x00, 0x00], [...name("f"), 0x00, 0x00]),
        code(body([])),
      ),
      "invalid",
      "duplicate export",
    ],
    ["memory above 4 GiB", module(memory([0x00, ...leb(65537)])), "invalid", "65536 pages"],
    [
      "undeclared function reference",
      module(types(funcType([], [])), funcs(0), code(body([0xd2, 0x00, 0x1a]))),
      "invalid",
      "undeclared",
    ],
  ])("rejects %s", (_label, bytes, status, message) => {
    const s = check(bytes);
    expect(s.status).toBe(status);
    expect(s.error).toContain(message);
  });

  test("never throws on truncated input", () => {
    const whole = module(
      types(funcType([I32, I32], [I32])),
      funcs(0),
      code(body([0x20, 0x00, 0x20, 0x01, 0x6a])),
    );
    for (let n = 0; n < whole.length; n++) check(whole.subarray(0, n));
  });
});
