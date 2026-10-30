import { expect, test } from "vitest";
import { F64, VOID, type IrStmt, type IrModule } from "./ir.js";
import {
  IR_VERSION,
  deserializeModule,
  deserializeModuleBytes,
  serializeModule,
  serializeModuleParts,
} from "./serialize.js";

function numbers(values: number[]): IrModule {
  const loc = { file: "numbers.ts", start: 0, end: 0 };
  return {
    irVersion: IR_VERSION,
    sourceFile: loc.file,
    entry: "main",
    functions: [
      {
        name: "main",
        params: [],
        locals: [],
        returnType: VOID,
        loc,
        body: values.map((value) => ({
          kind: "exprStmt",
          expr: { kind: "numLit", value, type: F64, loc },
          loc,
        })),
      },
    ],
  };
}

test("IR numbers survive multiple serialized generations without losing their value", () => {
  const values = [
    NaN,
    Infinity,
    -Infinity,
    -0,
    0,
    Number.MIN_VALUE,
    Number.MAX_VALUE,
    -Number.MIN_VALUE,
    0.1 + 0.2,
  ];
  let mod = numbers(values);
  const first = serializeModule(mod);
  expect(first).toContain('"$nonfinite": "nan"');
  expect(first).toContain('"$nonfinite": "-0"');
  for (let generation = 0; generation < 3; generation++) {
    mod = deserializeModule(serializeModule(mod));
    const actual = mod.functions[0]!.body.map((stmt) => {
      if (stmt.kind !== "exprStmt" || stmt.expr.kind !== "numLit")
        throw new Error("lost numeric literal");
      return stmt.expr.value;
    });
    expect(actual.every((value, index) => Object.is(value, values[index]))).toBe(true);
    expect(serializeModule(mod)).toBe(first);
  }
});

test.each(["", "NaN", "infinity", "future-format"])(
  "unknown number sentinel %j is refused",
  (tag) => {
    const json = serializeModule(numbers([NaN])).replace('"nan"', JSON.stringify(tag));
    expect(() => deserializeModule(json)).toThrow("Invalid IR number sentinel");
  },
);

test("ordinary strings resembling number sentinels remain strings", () => {
  const mod = numbers([0]);
  mod.sourceFile = '{"$nonfinite":"nan"}';
  expect(deserializeModule(serializeModule(mod)).sourceFile).toBe(mod.sourceFile);
});

test("compact artifacts preserve the full module and special numeric values", () => {
  const mod = numbers([NaN, Infinity, -Infinity, -0, 0, Number.MIN_VALUE, Number.MAX_VALUE]);
  mod.sourceFile = 'escaped\nsource\t😀"functions":[]$&.ts';
  mod.functions.push({ ...mod.functions[0]!, name: "other" });
  const compact = serializeModule(mod, true);
  expect(compact).not.toContain("\n");
  expect(compact.length).toBeLessThan(serializeModule(mod).length);
  expect(deserializeModule(compact)).toEqual(mod);
  expect(deserializeModule(compact)).toEqual(deserializeModule(serializeModule(mod)));
  expect(JSON.parse(compact)).toEqual(JSON.parse(serializeModule(mod)));
  mod.functions = [];
  expect(deserializeModule(serializeModule(mod, true))).toEqual(mod);
});

test("the new number format rejects documents bearing an older version", () => {
  const json = serializeModule(numbers([NaN])).replace(
    `"irVersion": ${IR_VERSION}`,
    `"irVersion": ${IR_VERSION - 1}`,
  );
  expect(() => deserializeModule(json)).toThrow("IR version mismatch");
});

test("compact artifacts preserve mixed ordinary functions and special numbers in metadata", () => {
  const ordinary = numbers([1, 2, 3]).functions[0]!;
  const special = numbers([NaN, -0, Infinity, -Infinity]).functions[0]!;
  const metadata = {
    ...ordinary,
    name: "metadata",
    loc: { file: "metadata.ts", start: -0, end: Infinity },
  };
  const mod = numbers([]);
  mod.functions = [
    ordinary,
    { ...special, name: "special" },
    metadata,
    { ...ordinary, name: "shared" },
  ];
  const expected = serializeModule(mod);
  expect(JSON.parse(serializeModule(mod, true))).toEqual(JSON.parse(expected));
  expect(deserializeModule(serializeModule(mod, true))).toEqual(mod);
  expect(serializeModule(mod)).toBe(expected);
  special.body.push({
    kind: "exprStmt",
    expr: { kind: "numLit", value: NaN, type: F64, loc: special.loc },
    loc: special.loc,
  });
  expect(JSON.parse(serializeModule(mod, true))).toEqual(JSON.parse(serializeModule(mod)));
});

test("compact artifacts keep JSON's circular-data refusal", () => {
  const mod = numbers([]);
  const block: IrStmt & { kind: "block" } = { kind: "block", body: [], loc: mod.functions[0]!.loc };
  block.body.push(block);
  mod.functions[0]!.body.push(block);
  expect(() => serializeModule(mod)).toThrow(TypeError);
  expect(() => serializeModule(mod, true)).toThrow(TypeError);
});

/** A module whose strings contain every byte the function splitter must not
 * mistake for structure. */
function structuralStrings(): IrModule {
  const mod = numbers([NaN, -0, 1.5, Infinity]);
  const tricky = 'q"\\"],[{"functions":[]}\\, \n\t😀é\\';
  mod.sourceFile = tricky + '"functions":[';
  const base = mod.functions[0]!;
  mod.functions = [
    base,
    { ...base, name: tricky, loc: { file: tricky, start: -0, end: 2 } },
    { ...base, name: "]", body: [] },
    { ...base, name: "\\" },
  ];
  mod.globals = [{ id: "%g.functions", name: "functions", type: F64, mutable: false }];
  return mod;
}

test("compact parts are exactly the single-root JSON encoding", () => {
  const mod = structuralStrings();
  const parts = serializeModuleParts(mod);
  expect(parts.length).toBe(2 + mod.functions.length * 2 - 1);
  const sentinels = (_key: string, value: unknown): unknown =>
    typeof value !== "number"
      ? value
      : Number.isNaN(value)
        ? { $nonfinite: "nan" }
        : value === Infinity
          ? { $nonfinite: "inf" }
          : value === -Infinity
            ? { $nonfinite: "-inf" }
            : Object.is(value, -0)
              ? { $nonfinite: "-0" }
              : value;
  expect(parts.join("")).toBe(JSON.stringify(mod, sentinels));
  expect(serializeModule(mod, true)).toBe(parts.join(""));
});

test("byte decoding splits functions without being misled by string contents", () => {
  const mod = structuralStrings();
  for (const text of [serializeModule(mod, true), serializeModule(mod)]) {
    const decoded = deserializeModuleBytes(Buffer.from(text, "utf8"));
    expect(decoded).toEqual(mod);
    expect(decoded).toEqual(deserializeModule(text));
    expect(Object.is(decoded.functions[1]!.loc.start, -0)).toBe(true);
  }
  mod.functions = [];
  expect(deserializeModuleBytes(Buffer.from(serializeModule(mod, true)))).toEqual(mod);
  expect(deserializeModuleBytes(Buffer.from(serializeModule(mod)))).toEqual(mod);
});

test("byte decoding keeps the whole-document errors and version refusal", () => {
  const text = serializeModule(structuralStrings(), true);
  for (const broken of [text.slice(0, -1), text.slice(0, text.length - 40), text + "]", "[]", ""]) {
    let expected: unknown;
    try {
      deserializeModule(broken);
    } catch (error) {
      expected = error;
    }
    expect(expected).toBeInstanceOf(Error);
    expect(() => deserializeModuleBytes(Buffer.from(broken))).toThrow();
  }
  const older = text.replace(`"irVersion":${IR_VERSION}`, `"irVersion":${IR_VERSION - 1}`);
  expect(() => deserializeModuleBytes(Buffer.from(older))).toThrow("IR version mismatch");
  const sentinel = text.replace('"nan"', '"future"');
  expect(() => deserializeModuleBytes(Buffer.from(sentinel))).toThrow("Invalid IR number sentinel");
});

test("file roots respell the source locations under them and nothing else", () => {
  const mod = numbers([1, 2]);
  const shim = { file: '/opt/scriptc "a"/shims/pkg/index.ts', start: 3, end: 4 };
  const other = { file: "/opt/elsewhere/shims/pkg/index.ts", start: 5, end: 6 };
  const body = mod.functions[0]!.body as IrStmt[];
  body.push(
    { kind: "exprStmt", expr: { kind: "numLit", value: 3, type: F64, loc: shim }, loc: shim },
    { kind: "exprStmt", expr: { kind: "numLit", value: 4, type: F64, loc: other }, loc: other },
  );
  const roots = [{ from: '/opt/scriptc "a"/shims/', to: "scriptc:shims/" }];
  const relocated = deserializeModule(serializeModuleParts(mod, roots).join(""));
  const files = (relocated.functions[0]!.body as IrStmt[]).map((stmt) => stmt.loc.file);
  expect(files).toEqual([
    "numbers.ts",
    "numbers.ts",
    "scriptc:shims/pkg/index.ts",
    "/opt/elsewhere/shims/pkg/index.ts",
  ]);
  expect(serializeModuleParts(mod).join("")).toBe(serializeModule(mod, true));
});
