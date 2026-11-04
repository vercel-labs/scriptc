// `.catch((error: Error) => ...)`: the parameter annotation is a claim
// tsc cannot verify — the reject payload is whatever was thrown. It is
// accepted only as the checked extraction `caughtCheck`: the snapshot is
// verified against the class at handler entry, a match extracts the
// payload for ordinary typed reads, and anything else raises the catchable
// TypeError ("types don't lie"). An unannotated (or `: any`/`: unknown`)
// handler keeps today's typed-catch binding, so its IR is unchanged.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule, validateModule } from "../src/index.js";

type IrModule = { entry: string; functions: unknown[] };

async function compileToIr(
  body: string[],
): Promise<{ ok: boolean; module: IrModule | null; diagnostics: string }> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-catch-parameter-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ir.json");
    await writeFile(entry, body.join("\n"));
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

/** Every function body as text. */
function functions(module: IrModule): string {
  return JSON.stringify(module.functions);
}

const FAIL = [
  "async function fail(kind: number): Promise<number> {",
  '  if (kind === 0) throw new Error("boom");',
  "  return 7;",
  "}",
];

test("an annotated catch parameter converts through the checked extraction", async () => {
  const compiled = await compileToIr([
    ...FAIL,
    "async function main(): Promise<void> {",
    "  const v = await fail(0).catch((error: Error) => {",
    "    console.log(error.message);",
    "    return -1;",
    "  });",
    "  console.log(v);",
    "}",
    "main();",
  ]);
  expect(compiled.ok, compiled.diagnostics).toBe(true);
  const ir = functions(compiled.module!);
  // The snapshot binds as the hidden caught local; the parameter is an
  // ordinary %Error local initialized by the checked extraction.
  expect(ir).toContain('"caughtCheck"');
  expect(ir).toContain('"className":"%Error"');
  expect(ir).toContain('"%catch"');
});

test("a non-class catch parameter annotation keeps its refusal", async () => {
  const compiled = await compileToIr([
    ...FAIL,
    "async function main(): Promise<void> {",
    "  const v = await fail(0).catch((e: string) => {",
    "    console.log(e.length);",
    "    return -1;",
    "  });",
    "  console.log(v);",
    "}",
    "main();",
  ]);
  expect(compiled.ok).toBe(false);
  expect(compiled.diagnostics).toContain("SC1090");
  expect(compiled.diagnostics).toContain("annotated with a type other than a class");
});

test("an unannotated catch handler keeps the plain typed-catch binding", async () => {
  for (const parameter of ["e", "e: unknown", "e: any"]) {
    const compiled = await compileToIr([
      ...FAIL,
      "async function main(): Promise<void> {",
      `  const v = await fail(0).catch((${parameter}) => {`,
      "    if (e instanceof Error) console.log(e.message);",
      "    return -1;",
      "  });",
      "  console.log(v);",
      "}",
      "main();",
    ]);
    expect(compiled.ok, `${parameter}: ${compiled.diagnostics}`).toBe(true);
    const ir = functions(compiled.module!);
    expect(ir).not.toContain('"caughtCheck"');
    expect(ir).not.toContain('"%catch"');
  }
});

test("a standalone class annotation converts the payload as an untyped value", async () => {
  const compiled = await compileToIr([
    "class Plain {",
    "  constructor(readonly code: number) {}",
    "}",
    "async function throwPlain(): Promise<number> {",
    "  throw new Plain(7);",
    "}",
    "async function main(): Promise<void> {",
    "  const v = await throwPlain().catch((p: Plain) => p.code);",
    "  console.log(v);",
    "}",
    "main();",
  ]);
  expect(compiled.ok, compiled.diagnostics).toBe(true);
  const ir = functions(compiled.module!);
  // caughtCheck needs a class in an inheritance relation: the standalone
  // class takes the checked conversion of the untyped payload instead.
  expect(ir).not.toContain('"caughtCheck"');
  expect(ir).toContain('"caughtToDyn"');
  expect(ir).toContain('"%catch"');
});
