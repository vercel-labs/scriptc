import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

// A dynamic dictionary read keeps its missing key as undefined (#4192). A
// non-null asserted read (`record[key]!`) asserts presence and `!` performs
// no check, so a numeric use coerces the direct value with ToNumber (one
// js.toNumberOrNaN): a present number unboxes in place and a missing key
// answers NaN, exactly what `undefined + n` computes. The validated
// number | undefined union and its scalar-union helper cost the
// record-untyped-writes workload 4.9x its v0.4.17 time; a checked extraction
// (js.toF64) would throw for the missing key where Node computes NaN.
test("a non-null asserted dictionary read lowers to the direct number", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-asserted-dict-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ir");
    await writeFile(
      entry,
      `
function bump(target: unknown, key: string, by: number): void {
  const record = target as Record<string, number>;
  record[key] = record[key]! + by;
}
bump({ a: 1 }, "a", 2);
`,
    );
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
    const ir = await readFile(outPath, "utf8");
    expect(ir).toContain('"fn":"js.toNumberOrNaN"');
    expect(ir).not.toContain('"fn":"js.toF64"');
    expect(ir).not.toContain("%number.scalar");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// A checked-dynamic dictionary answers a missing key with undefined, and a
// present cell may hold null whatever the checker's index value says (the
// record crossed the checker through a cast). A non-numeric use of the
// asserted read therefore keeps both unit arms: String() and templates print
// the value, equality compares it, and JSON omits an undefined member or
// writes a null one. A root read goes through the runtime walker, which
// answers undefined for an absent root and "null" for a null one.
test("a null-bearing asserted dictionary read keeps both unit arms", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-asserted-dict-null-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ir");
    await writeFile(
      entry,
      `
function probe(target: unknown): void {
  const record = target as Record<string, number | null>;
  console.log(String(record["missing"]!), JSON.stringify(record["missing"]!));
  console.log(JSON.stringify({ k: record["missing"]! }), record["missing"]! + 1);
}
probe({});
`,
    );
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
    const ir = JSON.parse(await readFile(outPath, "utf8")) as {
      unions: { id: string; arms: { kind: string }[] }[];
      records: { fields: { name: string; type: { kind: string; unionId?: string } }[] }[];
    };
    const field = ir.records
      .flatMap((record) => record.fields)
      .find((candidate) => candidate.name === "k");
    expect(field?.type.kind).toBe("union");
    const union = ir.unions.find((candidate) => candidate.id === field?.type.unionId);
    expect(union?.arms.map((arm) => arm.kind).sort()).toEqual(["f64", "nullT", "undefinedT"]);
    const text = JSON.stringify(ir);
    // The root read keeps its absent root for the walker.
    expect(text).toContain('"fn":"json.stringifyReplacer"');
    // Numeric uses stay on the inline ToNumber conversion.
    expect(text).toContain('"fn":"js.toNumberOrNaN"');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// JSON.stringify answers undefined exactly when its root is absent. A
// callback or function the checker types `string` widens its return slot to
// keep that answer instead of trapping at the return, for the asserted read
// and for the plain one. An object member's result is always the text: its
// field drops or serializes on its own.
test("a JSON result's return slot widens when the root may be absent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-json-return-slot-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ir");
    await writeFile(
      entry,
      `
const raw: Record<string, unknown> = {};
const record = raw as Record<string, number | null>;
function member(bang: boolean): string {
  return JSON.stringify({ k: bang ? record["missing"]! : record["missing"] });
}
function root(bang: boolean): string {
  return bang ? JSON.stringify(record["missing"]!) : JSON.stringify(record["missing"]);
}
console.log(member(true), root(false));
`,
    );
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
    const ir = JSON.parse(await readFile(outPath, "utf8")) as {
      functions: { name: string; returnType: { kind: string; unionId?: string } }[];
      unions: { id: string; arms: { kind: string }[] }[];
    };
    const member = ir.functions.find((fn) => fn.name === "member");
    expect(member?.returnType.kind).toBe("string");
    const root = ir.functions.find((fn) => fn.name === "root");
    expect(root?.returnType.kind).toBe("union");
    const union = ir.unions.find((candidate) => candidate.id === root?.returnType.unionId);
    expect(union?.arms.map((arm) => arm.kind).sort()).toEqual(["string", "undefinedT"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
