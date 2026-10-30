import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule } from "../index.js";
import {
  decodeFunctionBinary,
  decodeModuleBinary,
  encodeFunctionBinary,
  encodeFunctionInOrder,
  encodeFunctionStrings,
  encodeModuleBinary,
  functionDigest,
} from "./codec.js";
import { IR_CODEC_LAYOUT } from "./codec.generated.js";
import { F64, STRING, VOID, type IrFunction, type IrModule } from "./ir.js";
import { deserializeModuleBytes } from "./serialize.js";

// Programs with many node kinds: classes, closures, async, generators,
// dynamic values, streams, records, regexes, lone surrogates and BigIntStats.
const PROGRAMS = [
  "1003-json-parse-unions.ts",
  "114-live-record-delete.ts",
  "1200-regex-test-basics.ts",
  "1631-inspect-arrays.ts",
  "4900-console-instances.ts",
  "4991-lone-surrogate-halves.ts",
  "5612-readable-from-iterables.cjs",
  "7018-bigint-stats.ts",
  "7110-als-completion-callbacks.ts",
  "7321-speculative-loop-bail-sites.ts",
];

/** Whether `a` and `b` hold the same data: the same keys with defined
 * values, in any order, and numbers equal by Object.is. */
function sameData(a: unknown, b: unknown): boolean {
  if (typeof a === "number" && typeof b === "number") return Object.is(a, b);
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return a === b;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const record = (value: object) => value as Record<string, unknown>;
  const keys = (value: object) =>
    Object.keys(value)
      .filter((key) => record(value)[key] !== undefined)
      .sort();
  const ka = keys(a);
  const kb = keys(b);
  return (
    ka.length === kb.length &&
    ka.every((key, index) => key === kb[index] && sameData(record(a)[key], record(b)[key]))
  );
}

test.each(PROGRAMS)("%s round-trips through the binary encoding", async (program) => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-codec-"));
  try {
    const outPath = join(dir, "main.ir.json");
    const entry = join(import.meta.dirname, "../../../../tests/corpus", program);
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const mod = deserializeModule(await readFile(outPath, "utf8"));
    const bytes = encodeModuleBinary(mod);
    const back = decodeModuleBinary(bytes);
    expect(sameData(mod, back)).toBe(true);
    expect(Buffer.compare(encodeModuleBinary(back), bytes)).toBe(0);
    // The JSON reader takes the binary encoding too.
    expect(sameData(deserializeModuleBytes(bytes), mod)).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const loc = { file: "/src/main.ts", start: 0, end: 1 };
const fn = (body: IrFunction["body"]): IrFunction => ({
  name: "%main",
  params: [],
  locals: [],
  body,
  returnType: VOID,
  loc,
});

test("numbers keep NaN, the infinities, -0 and integers outside int32", () => {
  const values = [
    NaN,
    Infinity,
    -Infinity,
    -0,
    0,
    1,
    -1,
    2 ** 31,
    -(2 ** 31) - 1,
    2 ** 53,
    0.1,
    -1.5e300,
  ];
  const source = fn(
    values.map((value) => ({
      kind: "exprStmt",
      expr: { kind: "numLit", value, type: F64, loc },
      loc,
    })),
  );
  const back = decodeFunctionBinary(encodeFunctionBinary(source));
  const read = back.body.map((s) =>
    s.kind === "exprStmt" && s.expr.kind === "numLit" ? s.expr.value : null,
  );
  expect(read.length).toBe(values.length);
  read.forEach((value, index) => expect(Object.is(value, values[index])).toBe(true));
});

test("strings keep lone surrogates and repeat through the string table", () => {
  const texts = ["plain", "\ud83d", "a\udc00b", "😀", "plain", "é"];
  const source = fn(
    texts.map((value) => ({
      kind: "exprStmt",
      expr: { kind: "strLit", value, type: STRING, loc },
      loc,
    })),
  );
  const back = decodeFunctionBinary(encodeFunctionBinary(source));
  expect(
    back.body.map((s) => (s.kind === "exprStmt" && s.expr.kind === "strLit" ? s.expr.value : null)),
  ).toEqual(texts);
});

test("absent optional fields stay absent", () => {
  const source: IrModule = {
    irVersion: 17,
    sourceFile: "/src/main.ts",
    functions: [fn([])],
    entry: "%main",
  };
  const back = decodeModuleBinary(encodeModuleBinary(source));
  expect(Object.keys(back).sort()).toEqual(["entry", "functions", "irVersion", "sourceFile"]);
  expect(Object.keys(back.functions[0]!).sort()).toEqual(Object.keys(source.functions[0]!).sort());
});

test("a function whose objects follow the declared field order reads back with its key order", () => {
  // As lowering builds functions: the source name after the name, and the
  // async flag set after the literal.
  const source: IrFunction = {
    name: "%f",
    sourceName: "f",
    ownsPrototype: true,
    params: [],
    returnType: VOID,
    locals: [{ id: "x.0", name: "x", type: F64, mutable: true }],
    body: [{ kind: "return", value: null, loc }],
    loc,
  };
  source.async = true;
  const bytes = encodeFunctionInOrder(source);
  expect(bytes).not.toBeNull();
  const back = decodeFunctionBinary(bytes!);
  expect(JSON.stringify(back)).toBe(JSON.stringify(source));
  expect(Object.keys(back)).toEqual(Object.keys(source));
});

test("a function with an object out of the declared field order has no in-order encoding", () => {
  const source = fn([{ kind: "return", value: null, loc }]);
  // `loc` first: spreading the rest keeps its place.
  const { loc: first, ...rest } = source;
  const shuffled = { loc: first, ...rest } as IrFunction;
  expect(encodeFunctionInOrder(shuffled)).toBeNull();
  // An object with a key its type does not declare.
  expect(encodeFunctionInOrder({ ...source, extra: 1 } as IrFunction)).toBeNull();
  // The helper above builds `locals` before `returnType`.
  expect(encodeFunctionInOrder(source)).toBeNull();
  const ordered: IrFunction = {
    name: source.name,
    params: [],
    returnType: VOID,
    locals: [],
    body: source.body,
    loc,
  };
  expect(encodeFunctionInOrder(ordered)).not.toBeNull();
});

test("a node whose kind its union does not declare is refused", () => {
  const source = fn([{ kind: "noSuchStatement", loc } as never]);
  expect(encodeFunctionInOrder(source)).toBeNull();
  expect(() => encodeFunctionBinary(source)).toThrow(/cannot encode a IrStmt kind noSuchStatement/);
});

test("an encoding lists its strings and the files its fields named file hold", () => {
  const other = { file: "/src/other.ts", start: 2, end: 3 };
  const source: IrFunction = {
    name: "%f",
    params: [],
    returnType: VOID,
    locals: [],
    body: [
      {
        kind: "exprStmt",
        expr: { kind: "strLit", value: "%named", type: STRING, loc: other },
        loc,
      },
    ],
    loc,
  };
  const encoded = encodeFunctionStrings(source)!;
  expect(encoded.strings).toEqual(expect.arrayContaining(["%f", "%named", "/src/main.ts"]));
  expect([...encoded.files].sort()).toEqual(["/src/main.ts", "/src/other.ts"]);
  expect(Buffer.compare(encoded.bytes, encodeFunctionInOrder(source)!)).toBe(0);
});

test("a function's digest follows its content and not its key order", () => {
  const source = fn([{ kind: "return", value: null, loc }]);
  const digest = functionDigest(source);
  expect(digest).toMatch(/^\d+:[0-9a-f]{16}$/);
  expect(functionDigest(fn([{ kind: "return", value: null, loc }]))).toBe(digest);
  // The same fields in another order.
  const { loc: first, ...rest } = source;
  expect(functionDigest({ loc: first, ...rest } as IrFunction)).toBe(digest);
  // A change in place.
  source.locals.push({ id: "x.0", name: "x", type: F64, mutable: true });
  expect(functionDigest(source)).not.toBe(digest);
  // A node the encoder refuses is covered by the function's JSON text.
  const refused = fn([{ kind: "noSuchStatement", loc } as never]);
  const text = functionDigest(refused);
  expect(text).toMatch(/^json:/);
  (refused.body[0] as unknown as { extra: number }).extra = 1;
  expect(functionDigest(refused)).not.toBe(text);
});

test("bytes another layout wrote are refused", () => {
  const bytes = Buffer.from(encodeFunctionBinary(fn([])));
  // The layout digest follows the magic as the first new string.
  const at = bytes.indexOf(Buffer.from(IR_CODEC_LAYOUT));
  bytes[at] = bytes[at] === 0x30 ? 0x31 : 0x30;
  expect(() => decodeFunctionBinary(bytes)).toThrow(/layout/);
  expect(() => decodeFunctionBinary(Buffer.from("{}"))).toThrow(/not an IR encoding/);
});
