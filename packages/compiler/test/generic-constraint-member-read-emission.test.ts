// A member the checker admits only through a type parameter's constraint
// while the instantiation's record has no slot for it (`options.sessionId`
// under an `"sessionId" in options` guard, at a call site whose options
// literal omits the optional member): the read must lower to the
// checked-dynamic keyed read of the stored record — the object's own
// property, undefined when absent — instead of fencing.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule, validateModule } from "../src/index.js";

const PRELUDE = [
  "interface RequestOptions<TModel> { model?: TModel; apiKey?: string; sessionId?: string }",
  "interface Transforms {",
  "  transformHeaders?: (headers: Record<string, string | null>) => Record<string, string | null>;",
  "}",
  "function sessionOf<TModel, TOptions extends RequestOptions<TModel> & Transforms>(",
  "  options: TOptions | undefined,",
  "): string | undefined {",
  "  return options && 'sessionId' in options && typeof options.sessionId === 'string'",
  "    ? options.sessionId",
  "    : undefined;",
  "}",
];

type IrModule = {
  entry: string;
  functions: { name: string; body: unknown }[];
};

async function compileToIr(
  lines: string[],
): Promise<{ ok: boolean; module: IrModule | null; diagnostics: string }> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-generic-constraint-read-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ir.json");
    await writeFile(entry, [...PRELUDE, ...lines].join("\n"));
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

test("an omitted constraint member reads dynamically off the stored record", async () => {
  const compiled = await compileToIr([
    "const withoutKey = { apiKey: 'k' };",
    "console.log(String(sessionOf<{ id: string }, typeof withoutKey>(withoutKey)));",
  ]);
  expect(compiled.ok, compiled.diagnostics).toBe(true);
  const body = bodies(compiled.module!, "sessionOf");
  // The stored record has no `sessionId` slot, so the read is the
  // checked-dynamic keyed read of the value (dynFrom → key read → check).
  expect(body).toContain('"dynFrom"');
  expect(body).toContain('"dynCheck"');
  expect(body).not.toContain('"unsupported"');
});

test("a constraint member the instantiation stores still reads its slot", async () => {
  const compiled = await compileToIr([
    "const withKey = { apiKey: 'k', sessionId: 's-1' };",
    "console.log(String(sessionOf<{ id: string }, typeof withKey>(withKey)));",
  ]);
  expect(compiled.ok, compiled.diagnostics).toBe(true);
  const body = bodies(compiled.module!, "sessionOf");
  expect(body).toContain('"recordGet"');
  expect(body).toContain('"sessionId"');
  expect(body).not.toContain('"dynFrom"');
});
