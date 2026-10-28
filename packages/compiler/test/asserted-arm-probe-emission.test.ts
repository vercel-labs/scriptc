// A feature-detection probe of a member read through a type assertion must
// answer off the value actually stored (Node erases `as`), never throw the
// checked-extraction TypeError. A real use of the same read keeps the
// checked conversion ("types don't lie": a lying assertion throws at the
// use, not at the probe).
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule, validateModule } from "../src/index.js";

const PRELUDE = [
  "interface Streams { stream: () => string; fetch?: () => string }",
  "interface Options<K extends string> { name: string; api: Streams | Record<K, Streams> }",
];

type IrModule = {
  entry: string;
  functions: { name: string; body: unknown }[];
};

async function compileToIr(
  body: string[],
): Promise<{ ok: boolean; module: IrModule | null; diagnostics: string }> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-asserted-arm-probe-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ir.json");
    await writeFile(entry, [...PRELUDE, ...body].join("\n"));
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok)
      return {
        ok: false,
        module: null,
        diagnostics: result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"),
      };
    const module = deserializeModule(await readFile(outPath, "utf8")) as unknown as IrModule;
    expect(validateModule(module as never)).toEqual([]);
    return { ok: true, module, diagnostics: "" };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The IR bodies of the functions whose name starts with `root`, as text
 * (a specialized function keeps its source name as a prefix). */
function bodies(module: IrModule, root: string): string {
  return JSON.stringify(
    module.functions.filter((fn) => fn.name.startsWith(root)).map((fn) => fn.body),
  );
}

test("typeof probe of a member read through an assertion reads per arm", async () => {
  const compiled = await compileToIr([
    "function detect<K extends string>(input: Options<K>): boolean {",
    '  return typeof (input.api as Streams).stream === "function";',
    "}",
    'console.log(detect({ name: "one", api: { stream: () => "one" } }));',
  ]);
  expect(compiled.ok, compiled.diagnostics).toBe(true);
  // A checked extraction of the asserted arm would trap on the record arm;
  // the probe answers from the stored union's runtime tag instead.
  const detect = bodies(compiled.module!, "detect");
  expect(detect).toContain('"unionIsTag"');
  expect(detect).not.toContain('"nodeThrow"');
});

test("undefined and null presence probes read per arm", async () => {
  for (const probe of [
    "(input.api as Streams).stream !== undefined",
    "(input.api as Streams).stream == null",
  ]) {
    const compiled = await compileToIr([
      "function detect<K extends string>(input: Options<K>): boolean {",
      `  return ${probe};`,
      "}",
      'console.log(detect({ name: "one", api: { stream: () => "one" } }));',
    ]);
    expect(compiled.ok, compiled.diagnostics).toBe(true);
    const detect = bodies(compiled.module!, "detect");
    expect(detect).not.toContain('"nodeThrow"');
  }
});

test("a real use of the asserted member keeps the checked extraction", async () => {
  const compiled = await compileToIr([
    "function call<K extends string>(input: Options<K>): string {",
    "  return (input.api as Streams).stream();",
    "}",
    'console.log(call({ name: "one", api: { stream: () => "one" } }));',
  ]);
  expect(compiled.ok, compiled.diagnostics).toBe(true);
  // The real use still applies the assertion's checked extraction: an arm
  // that is not Streams throws at the read (the trap is the nodeThrow).
  expect(bodies(compiled.module!, "call")).toMatch(/union\.narrow|nodeThrow/);
});
