// The enum object (lowering/enum-objects.ts) is built only for an enum some
// code uses as a value: a program that reads members, or looks a name up by
// number, has no global for it, and one that enumerates or passes the enum
// gets the record tsc's emit would build, where the declaration stands.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule, validateModule } from "../src/index.js";

type IrType = { kind: string; unionId?: string };

type IrModule = {
  functions: { locals: { name: string; type: IrType; source?: unknown }[] }[];
  globals?: { id: string; name: string; type: IrType }[];
  unions?: { id: string; arms: IrType[] }[];
};

async function compileToIr(
  files: Record<string, string[]>,
): Promise<{ module: IrModule | null; diagnostics: string }> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-enum-object-"));
  try {
    for (const [name, lines] of Object.entries(files)) {
      await mkdir(dirname(join(dir, name)), { recursive: true });
      await writeFile(join(dir, name), lines.join("\n"));
    }
    const outPath = join(dir, "main.ir.json");
    const result = await compile(join(dir, "main.ts"), { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok)
      return {
        module: null,
        diagnostics: result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"),
      };
    const module = deserializeModule(await readFile(outPath, "utf8")) as unknown as IrModule;
    expect(validateModule(module as never)).toEqual([]);
    return { module, diagnostics: "" };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function enumGlobals(module: IrModule | null): string[] {
  return (module?.globals ?? []).map((g) => g.id).filter((id) => id.includes("%enum."));
}

/** The storage of the source binding `name`: a top-level one lives as a
 * global, any other as a local of the function that declares it. */
function bindingType(module: IrModule | null, name: string): IrType | undefined {
  const global = (module?.globals ?? []).find((g) => g.name === name);
  if (global) return global.type;
  for (const fn of module?.functions ?? [])
    for (const local of fn.locals) if (local.name === name) return local.type;
  return undefined;
}

/** Whether values of `type` can be undefined. */
function admitsUndefined(module: IrModule | null, type: IrType | undefined): boolean {
  if (type === undefined) return false;
  if (type.kind === "undefinedT") return true;
  if (type.kind !== "union") return false;
  const union = (module?.unions ?? []).find((u) => u.id === type.unionId);
  return union?.arms.some((arm) => arm.kind === "undefinedT") ?? false;
}

/** The field names of every record literal, in the order each writes them. */
function recordLiterals(module: IrModule | null): string[] {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (node === null || typeof node !== "object") return;
    const record = node as { kind?: string; fields?: { name: string }[] };
    if (record.kind === "recordLit" && record.fields)
      out.push(record.fields.map((f) => f.name).join(","));
    Object.values(node).forEach(walk);
  };
  walk(module?.functions);
  return out;
}

const LEVEL = ["enum Level {", "  Low,", "  High,", "  Top = 10,", "}"];

test("member reads and numeric lookups build no object", async () => {
  const { module, diagnostics } = await compileToIr({
    "main.ts": [
      ...LEVEL,
      "const picked: number = process.argv.length;",
      "const held: Level = Level.High;",
      'console.log(Level.Low, Level["Top"], Level[1], Level[picked], Level[held]);',
      "let name: keyof typeof Level = picked > 5 ? 'Low' : 'Top';",
      "console.log(Level[name]);",
    ],
  });
  expect(diagnostics).toBe("");
  expect(enumGlobals(module)).toEqual([]);
  expect(recordLiterals(module)).toEqual([]);
});

test("a numeric lookup into a member-only enum keeps the undefined case", async () => {
  const { module, diagnostics } = await compileToIr({
    "main.ts": [
      ...LEVEL,
      "const picked: number = process.argv.length;",
      "const name = Level[picked];",
      "console.log(name);",
    ],
  });
  expect(diagnostics).toBe("");
  // The enum has no value use, so it has no object and no record type here:
  // the reverse lookup still reads undefined for a value no member has, and
  // the binding has to keep it.
  expect(enumGlobals(module)).toEqual([]);
  expect(recordLiterals(module)).toEqual([]);
  const binding = bindingType(module, "name");
  expect(binding).toBeDefined();
  expect(admitsUndefined(module, binding)).toBe(true);
  expect(binding).toMatchObject({ kind: "union" });
});

test("a value use builds the record in the order tsc's emit writes it", async () => {
  const { module, diagnostics } = await compileToIr({
    "main.ts": [...LEVEL, "console.log(Object.keys(Level).length);"],
  });
  expect(diagnostics).toBe("");
  expect(enumGlobals(module)).toEqual(["%g.e.%enum.Level", "%g.e.%enum.Level%ready"]);
  expect(recordLiterals(module)).toEqual(["Low,0,High,1,Top,10"]);
});

test("a use in another module builds the exporting module's object", async () => {
  const lib = ["export enum Tone {", '  Hi = "hi",', '  Lo = "lo",', "}"];
  const unused = await compileToIr({
    "lib.ts": lib,
    "main.ts": ['import { Tone } from "./lib.ts";', "console.log(Tone.Hi);"],
  });
  expect(unused.diagnostics).toBe("");
  expect(enumGlobals(unused.module)).toEqual([]);
  const used = await compileToIr({
    "lib.ts": lib,
    "main.ts": [
      'import { Tone as Voice } from "./lib.ts";',
      "console.log(Object.values(Voice).length);",
    ],
  });
  expect(used.diagnostics).toBe("");
  expect(enumGlobals(used.module).length).toBe(2);
  expect(recordLiterals(used.module)).toEqual(["Hi,Lo"]);
});

test("an enum without a closed object keeps its refusal", async () => {
  const { diagnostics } = await compileToIr({
    "main.ts": [
      "function names(): string[] {",
      "  enum Local {",
      "    P,",
      "  }",
      "  return Object.keys(Local);",
      "}",
      "console.log(names().length);",
    ],
  });
  expect(diagnostics).toContain("SC1090: enum objects as values ('Local'");
});
