import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule, validateModule } from "../src/index.js";
import type { IrExpr, IrFunction, IrModule, IrStmt } from "../src/ir/ir.js";
import { everyExprChild, everyStmtChild } from "../src/ir/traverse.js";

/** Bodies that initialize a local from the running closure. */
function selfRefInitializedLocals(fn: IrFunction): string[] {
  const ids: string[] = [];
  const expr = (e: IrExpr): boolean => everyExprChild(e, expr, stmt);
  const stmt = (s: IrStmt): boolean => {
    if (s.kind === "varDecl" && s.init !== null && s.init.kind === "selfRef") ids.push(s.localId);
    return everyStmtChild(s, expr, stmt);
  };
  for (const s of fn.body) stmt(s);
  return ids;
}

async function compileToIr(source: string): Promise<IrModule> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-fn-expression-name-"));
  try {
    const entry = join(dir, "main.js");
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

test("a nested function reads a function expression's name through a captured local", async () => {
  const mod = await compileToIr(
    `const make = function self() {
  return () => self;
};
console.log(make()() === make);
`,
  );
  // The function expression materializes its name once, at entry, from the
  // running closure; the returned arrow captures that binding.
  const owner = mod.functions.find((fn) => fn.sourceName === "self");
  expect(owner).toBeDefined();
  const locals = selfRefInitializedLocals(owner!);
  expect(locals).toHaveLength(1);
  const arrow = mod.functions.find(
    (fn) => fn !== owner && fn.captures?.some((capture) => capture.name === "self"),
  );
  expect(arrow).toBeDefined();
});

test("a directly recursive function expression keeps the bare selfRef form", async () => {
  const mod = await compileToIr(
    `const sum = function total(n) {
  return n <= 0 ? 0 : n + total(n - 1);
};
console.log(sum(4));
`,
  );
  // Nothing nested reads the name, so no local is materialized: the body's
  // reads are the running closure itself.
  const owner = mod.functions.find((fn) => fn.sourceName === "total");
  expect(owner).toBeDefined();
  expect(selfRefInitializedLocals(owner!)).toEqual([]);
});
