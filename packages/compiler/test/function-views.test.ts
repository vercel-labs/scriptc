import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule, validateModule } from "../src/index.js";
import type { IrExpr, IrFunction, IrModule } from "../src/ir/ir.js";
import { everyStmtList } from "../src/ir/traverse.js";

async function compileToIr(source: string): Promise<IrModule> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-function-views-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ir.json");
    await writeFile(entry, source);
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const mod = deserializeModule(await readFile(outPath, "utf8"));
    expect(validateModule(mod)).toEqual([]);
    return mod;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The `viewOf` tests in a function's body. */
function viewTests(fn: IrFunction): Extract<IrExpr, { kind: "viewOf" }>[] {
  const tests: Extract<IrExpr, { kind: "viewOf" }>[] = [];
  everyStmtList(fn.body, {
    expr: (e) => {
      if (e.kind === "viewOf") tests.push(e);
      return true;
    },
    stmt: () => true,
  });
  return tests;
}

function allViewTests(mod: IrModule): Extract<IrExpr, { kind: "viewOf" }>[] {
  return mod.functions.flatMap(viewTests);
}

const LABEL = `function label(prefix: string, options?: { upper: boolean }): string {
  return options?.upper ? prefix.toUpperCase() : prefix;
}
function plain(prefix: string): string { return prefix + "!"; }
type One = (prefix: string) => string;
type Two = (prefix: string, options: { upper: boolean }) => string;
`;

test("a widening adapter tests for the views of its source type and for nothing else", async () => {
  const mod = await compileToIr(
    `${LABEL}function narrowOf(f: One): One { return f; }
function widen(f: One): Two { return f; }
console.log(widen(narrowOf(label))("abc", { upper: true }), widen(plain)("abc", { upper: true }));
`,
  );
  // One view of `One` exists (label's), and one adapter widens `One`: that
  // adapter's factory holds the one test, ahead of the plain adapter.
  const tests = allViewTests(mod);
  expect(tests).toHaveLength(1);
  const adapter = tests[0]!.adapter;
  expect(adapter).not.toBeNull();
  const body = mod.functions.find((fn) => fn.name === adapter);
  expect(body?.captures?.[0]?.type).toMatchObject({ kind: "func" });
  // The view's body forwards to a function of two parameters.
  const forwarded = body!.captures![0]!.type;
  expect(forwarded.kind === "func" && forwarded.params.length).toBe(2);
  const factory = mod.functions.find((fn) => viewTests(fn).length === 1)!;
  expect(factory.body.at(-1)).toMatchObject({ kind: "return", value: { kind: "closure" } });
});

test("a program that narrows without widening, or widens without narrowing, has no test", async () => {
  const narrowOnly = await compileToIr(
    `${LABEL}function narrowOf(f: One): One { return f; }
console.log(narrowOf(label)("abc"));
`,
  );
  expect(allViewTests(narrowOnly)).toEqual([]);
  const widenOnly = await compileToIr(
    `${LABEL}function widen(f: One): Two { return f; }
console.log(widen(plain)("abc", { upper: true }));
`,
  );
  expect(allViewTests(widenOnly)).toEqual([]);
});

test("a shared array-method helper tests for the views of its callback type", async () => {
  const withView = await compileToIr(
    `function show(x: string, i?: number): string { return x + (i ?? "_"); }
function each(xs: string[], f: (x: string) => string): string[] { return xs.map(f); }
console.log(each(["a", "b"], show).join(" "));
`,
  );
  const helpers = withView.functions.filter(
    (fn) => fn.name.startsWith("%arr.map.") && viewTests(fn).length > 0,
  );
  expect(helpers).toHaveLength(1);
  // The test hands the function to the helper built for (value, index, array).
  const wide = withView.functions.filter(
    (fn) =>
      fn.name.startsWith("%arr.map.") &&
      fn.params[1]?.type.kind === "func" &&
      fn.params[1].type.params.length === 3,
  );
  expect(wide).toHaveLength(1);
  const withoutView = await compileToIr(
    `function plain(x: string): string { return x + "!"; }
function each(xs: string[], f: (x: string) => string): string[] { return xs.map(f); }
console.log(each(["a", "b"], plain).join(" "), ["c"].map((x) => x + "?").join(" "));
`,
  );
  expect(allViewTests(withoutView)).toEqual([]);
});
