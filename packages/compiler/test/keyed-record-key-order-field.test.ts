// A record whose object literals write its keys in more than one order
// gains a hidden number field for the order's index after the bodies
// lowered (KEY_ORDER_FIELD). That field is storage, not a property: a keyed
// read or write (`TABLE[key]`) dispatches over the declared keys only, so
// its result type answers for them alone. The differential case is
// tests/corpus/8816-keyed-record-read-key-orders.ts.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule, validateModule } from "../src/index.js";
import {
  F64,
  KEY_ORDER_FIELD,
  STRING,
  keyedRecordFields,
  type IrRecordShape,
} from "../src/ir/ir.js";

type Node = { kind?: string; [key: string]: unknown };
type IrModule = {
  functions: { name: string; body: unknown }[];
  records: { id: string; fields: { name: string; type: { kind: string } }[] }[];
};

async function compileToIr(source: string[]): Promise<IrModule> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-keyed-key-order-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ir.json");
    await writeFile(entry, source.join("\n"));
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const module = deserializeModule(await readFile(outPath, "utf8")) as unknown as IrModule;
    expect(validateModule(module as never)).toEqual([]);
    return module;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Every IR node of `kind` under `root`. */
function nodesOf(root: unknown, kind: string, found: Node[] = []): Node[] {
  if (Array.isArray(root)) for (const item of root) nodesOf(item, kind, found);
  else if (root !== null && typeof root === "object") {
    const node = root as Node;
    if (node.kind === kind) found.push(node);
    for (const value of Object.values(node)) nodesOf(value, kind, found);
  }
  return found;
}

test("the key-order field is not a field a key can name", () => {
  const plain: IrRecordShape = {
    id: "r0",
    fields: [
      { name: "high", type: STRING },
      { name: "low", type: STRING },
    ],
  };
  expect(keyedRecordFields(plain)).toBe(plain.fields);
  const ordered: IrRecordShape = {
    id: "r1",
    fields: [{ name: KEY_ORDER_FIELD, type: F64 }, ...plain.fields],
  };
  expect(keyedRecordFields(ordered).map((f) => f.name)).toEqual(["high", "low"]);
});

test("a keyed read and write of a record with two key orders validate", async () => {
  const module = await compileToIr([
    'type Level = "off" | "low" | "high";',
    'const NOTES: Record<Level, string> = { off: "none", low: "light", high: "deep" };',
    'const SHORT: Record<Level, string> = { high: "h", off: "o", low: "l" };',
    "function note(level: Level): string {",
    "  return NOTES[level];",
    "}",
    "function rename(level: Level, text: string): void {",
    "  SHORT[level] = text;",
    "}",
    'rename("low", "L");',
    'console.log(note("low"), Object.keys(NOTES).join(), Object.keys(SHORT).join());',
  ]);
  const read = nodesOf(module.functions.find((fn) => fn.name === "note")!.body, "recordKeyGet");
  expect(read).toHaveLength(1);
  expect((read[0]!["type"] as Node).kind).toBe("string");
  const write = nodesOf(module.functions.find((fn) => fn.name === "rename")!.body, "recordKeySet");
  expect(write).toHaveLength(1);
  // The shape both name holds the hidden index beside its three string keys.
  const shape = module.records.find((record) => record.id === read[0]!["shapeId"]);
  expect(shape?.fields.map((f) => `${f.name}: ${f.type.kind}`)).toEqual([
    `${KEY_ORDER_FIELD}: f64`,
    "high: string",
    "low: string",
    "off: string",
  ]);
  expect(write[0]!["shapeId"]).toBe(shape?.id);
});
