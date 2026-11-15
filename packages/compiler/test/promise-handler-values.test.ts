// `p.catch(handler)` with a handler that is not an inline function is
// `p.then(undefined, handler)`: the handler is a function value, called with
// the rejection reason as a checked-dynamic value. The inline handler keeps
// its catch-clause lowering, and a handler known to be a function is called
// without a run-time callable test.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule, validateModule } from "../src/index.js";

type IrFunction = { name: string };
type IrModule = { entry: string; functions: IrFunction[] };

async function compileToIr(
  body: string[],
): Promise<{ ok: boolean; module: IrModule | null; diagnostics: string }> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-promise-handler-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ir.json");
    await writeFile(entry, body.join("\n"));
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok)
      return {
        ok: false,
        module: null,
        diagnostics: result.diagnostics
          .map((d) => `${d.code}: ${d.message}${d.hint ? ` (${d.hint})` : ""}`)
          .join("\n"),
      };
    const module = deserializeModule(await readFile(outPath, "utf8")) as unknown as IrModule;
    expect(validateModule(module as never)).toEqual([]);
    return { ok: true, module, diagnostics: "" };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The lifted promise-method wrappers (`…_catch`, `…_then`, `…_then2`) as text. */
function wrappers(module: IrModule): string {
  return JSON.stringify(module.functions.filter((fn) => /_(catch|then2?)$/.test(fn.name)));
}

const FAIL = [
  "async function fail(kind: number): Promise<number> {",
  '  if (kind === 0) throw new Error("boom");',
  "  return 7;",
  "}",
];

test("a named catch handler is called as a function value", async () => {
  const compiled = await compileToIr([
    ...FAIL,
    "function recover(e: unknown): number {",
    "  return e instanceof Error ? e.message.length : -1;",
    "}",
    "fail(0).catch(recover).then((v) => console.log(v));",
  ]);
  expect(compiled.ok, compiled.diagnostics).toBe(true);
  const ir = wrappers(compiled.module!);
  expect(ir).toContain('"dynCall"');
  expect(ir).toContain('"calleeName":"recover"');
  // `recover` is statically a function: no callable test.
  expect(ir).not.toContain('"test":"function"');
});

test("a handler that may be absent is tested before it is called", async () => {
  const compiled = await compileToIr([
    ...FAIL,
    "interface Options { onError?: (e: unknown) => number }",
    "function run(options: Options): Promise<number> {",
    "  return fail(0).catch(options.onError);",
    "}",
    "run({}).then((v) => console.log(v), () => console.log('passed on'));",
  ]);
  expect(compiled.ok, compiled.diagnostics).toBe(true);
  const ir = wrappers(compiled.module!);
  expect(ir).toContain('"test":"function"');
  expect(ir).toContain('"rethrow"');
});

test("an inline catch handler keeps the catch-clause lowering", async () => {
  const compiled = await compileToIr([
    ...FAIL,
    "fail(0)",
    "  .catch((e) => (e instanceof Error ? e.message.length : -1))",
    "  .then((v) => console.log(v));",
  ]);
  expect(compiled.ok, compiled.diagnostics).toBe(true);
  const ir = wrappers(compiled.module!);
  expect(ir).not.toContain('"dynCall"');
  expect(ir).not.toContain('"test":"function"');
});

test("a then handler of the settled type is called directly", async () => {
  const compiled = await compileToIr([
    ...FAIL,
    "const double = (n: number): number => n * 2;",
    "fail(1).then(double).then((v) => console.log(v));",
  ]);
  expect(compiled.ok, compiled.diagnostics).toBe(true);
  const ir = wrappers(compiled.module!);
  expect(ir).not.toContain('"dynCall"');
  expect(ir).not.toContain('"dynFrom"');
});

test("a then handler with a wider parameter is called as a function value", async () => {
  const compiled = await compileToIr([
    ...FAIL,
    "const show = (n: number | string): string => 'value ' + n;",
    "fail(1).then(show).then((v) => console.log(v));",
  ]);
  expect(compiled.ok, compiled.diagnostics).toBe(true);
  expect(wrappers(compiled.module!)).toContain('"dynCall"');
});
