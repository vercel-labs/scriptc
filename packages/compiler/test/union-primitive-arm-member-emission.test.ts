// A member read on a union whose stored value still carries a scalar
// primitive arm that flow analysis removed. Node boxes the primitive and
// answers undefined for a name its prototype chain does not carry, which
// is the answer the read must produce — the arm is unreachable per the
// checker anyway, but lowering erases the narrowing and dispatches over
// every stored arm. A name the primitive DOES declare keeps the read's
// own lowering or fence, so `{ n: number } | string` never turns a real
// string member into undefined.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule, validateModule } from "../src/index.js";

const PRELUDE = [
  "interface Part { image_url?: string | { url?: string } }",
  "type Negotiation = { parsed: number; sequence: string } | 'pending' | undefined;",
];

type IrModule = {
  entry: string;
  functions: { name: string; body: unknown }[];
};

async function compileToIr(
  body: string[],
): Promise<{ ok: boolean; module: IrModule | null; diagnostics: string }> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-union-primitive-arm-"));
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

test("a string arm the guard removed answers undefined for a record field", async () => {
  const compiled = await compileToIr([
    "function pick(part: Part): string | undefined {",
    "  return typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;",
    "}",
    "console.log(pick({ image_url: 'a' }), pick({ image_url: { url: 'b' } }), pick({}));",
  ]);
  expect(compiled.ok, compiled.diagnostics).toBe(true);
  const pick = bodies(compiled.module!, "pick");
  // The keyed read over the stored union: the record arm reads its
  // declared field, the string arm answers the join's undefined arm.
  expect(pick).toContain('"unionKeyGet"');
  expect(pick).toContain('"url"');
});

test("a literal arm the guard removed answers undefined for a record field", async () => {
  const compiled = await compileToIr([
    "function read(n: Negotiation): string {",
    "  if (n === 'pending') return 'pending';",
    "  return n?.sequence ?? '';",
    "}",
    "console.log(read('pending'), read({ parsed: 1, sequence: 's' }), read(undefined));",
  ]);
  expect(compiled.ok, compiled.diagnostics).toBe(true);
  expect(bodies(compiled.module!, "read")).toContain('"unionKeyGet"');
});

test("a primitive member keeps its own answer, not undefined", async () => {
  // `.length` IS a string member: the read must not be rewritten into the
  // unimplemented-answer path just because a string arm is stored.
  const compiled = await compileToIr([
    "type Sized = { length: number } | string;",
    "function size(s: Sized): number {",
    "  return typeof s === 'string' ? s.length : s.length;",
    "}",
    "console.log(size('abc'), size({ length: 3 }));",
  ]);
  expect(compiled.ok, compiled.diagnostics).toBe(true);
  // Its lowering reads each arm's own `length`; no undefined answer joins in.
  expect(bodies(compiled.module!, "size")).not.toContain('"undefinedT"');
});
