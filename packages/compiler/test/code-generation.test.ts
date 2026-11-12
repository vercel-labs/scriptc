import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule } from "../src/index.js";
import type { IrExpr, IrModule, IrStmt } from "../src/ir/ir.js";
import { everyExprChild, everyStmtChild } from "../src/ir/traverse.js";
import { CODE_GENERATION_DISALLOWED } from "../src/frontend/lowering/code-generation.js";

/** Compiles `source` (as `main.<extension>`) to its IR module. */
async function compileToIr(source: string, extension: string): Promise<IrModule> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-code-generation-"));
  try {
    const entry = join(dir, `main.${extension}`);
    const outPath = join(dir, "main.ir.json");
    await writeFile(entry, source);
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    return deserializeModule(await readFile(outPath, "utf8"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Every code-generation refusal the module throws. */
function codeGenerationThrows(mod: IrModule): IrExpr[] {
  const found: IrExpr[] = [];
  const expr = (e: IrExpr): boolean => {
    if (
      e.kind === "libCall" &&
      e.fn === "error.nodeThrow" &&
      e.args.some((arg) => arg.kind === "strLit" && arg.value === CODE_GENERATION_DISALLOWED)
    )
      found.push(e);
    return everyExprChild(e, expr, stmt);
  };
  const stmt = (s: IrStmt): boolean => everyStmtChild(s, expr, stmt);
  for (const fn of mod.functions) for (const bodyStmt of fn.body) stmt(bodyStmt);
  return found;
}

/** The sequence expressions a module's bodies hold, outermost first. */
function sequences(mod: IrModule): Extract<IrExpr, { kind: "seqExpr" }>[] {
  const found: Extract<IrExpr, { kind: "seqExpr" }>[] = [];
  const expr = (e: IrExpr): boolean => {
    if (e.kind === "seqExpr") found.push(e);
    return everyExprChild(e, expr, stmt);
  };
  const stmt = (s: IrStmt): boolean => everyStmtChild(s, expr, stmt);
  for (const fn of mod.functions) for (const bodyStmt of fn.body) stmt(bodyStmt);
  return found;
}

test("a function value's constructor evaluates the receiver, then the arguments, then refuses", async () => {
  const mod = await compileToIr(
    `function pick(): () => number {
  return () => 1;
}
function argument(): string {
  return "return 1";
}
pick().constructor(argument());
`,
    "ts",
  );
  expect(codeGenerationThrows(mod)).toHaveLength(1);
  // The receiver and the argument reach the call, in source order.
  const refusal = sequences(mod).find(
    (seq) => seq.result.kind === "libCall" && seq.result.fn === "error.nodeThrow",
  );
  expect(refusal).toBeDefined();
  const callees = refusal!.stmts.map((s) =>
    s.kind === "exprStmt" && s.expr.kind === "call" ? s.expr.callee : s.kind,
  );
  expect(callees).toEqual(["pick", "argument"]);
});

test("a function the program gives its own constructor property keeps it", async () => {
  const mod = await compileToIr(
    `const made = () => 1;
made.constructor = () => 2;
console.log(made.constructor());
`,
    "js",
  );
  expect(codeGenerationThrows(mod)).toEqual([]);
});
