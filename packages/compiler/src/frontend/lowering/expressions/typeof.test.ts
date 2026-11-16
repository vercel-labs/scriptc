/* `typeof <Node global> === "..."` in a JavaScript source answers from the
 * pinned-Node census, without reading the object: the comparison is that
 * constant, so a module that only tests the name (scheduler's
 * `typeof performance === "object"`) never builds the held object whose
 * unprovided members are refusal placeholders. */
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { compile, deserializeModule } from "../../../index.js";
import type { IrExpr, IrModule, IrStmt } from "../../../ir/ir.js";
import { everyStmtList } from "../../../ir/traverse.js";

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function lowerProgram(files: Record<string, string>, entry = "main.mjs"): Promise<IrModule> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "scriptc-typeof-")));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text);
  const outPath = join(dir, "main.ir.json");
  const result = await compile(join(dir, entry), { outDir: dir, outPath, outputKind: "ir" });
  if (!result.ok)
    throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
  return deserializeModule(await readFile(outPath, "utf8"));
}

function statements(mod: IrModule): IrStmt[] {
  const found: IrStmt[] = [];
  for (const fn of mod.functions ?? [])
    everyStmtList(fn.body, {
      stmt: (stmt) => {
        found.push(stmt);
        return true;
      },
      expr: () => true,
    });
  return found;
}

function expressions(mod: IrModule): IrExpr[] {
  const found: IrExpr[] = [];
  for (const fn of mod.functions ?? [])
    everyStmtList(fn.body, {
      stmt: () => true,
      expr: (expr) => {
        found.push(expr);
        return true;
      },
    });
  return found;
}

/** Every call of the held object native code builds for a Node global. */
function heldObjectCalls(mod: IrModule): string[] {
  return expressions(mod)
    .filter((e): e is IrExpr & { kind: "call" } => e.kind === "call")
    .map((e) => e.callee)
    .filter((callee) => callee.startsWith("%builtin.object."));
}

test("a typeof test on a Node global folds without reading the held object", async () => {
  const mod = await lowerProgram({
    "main.mjs": `
if (typeof performance === "object") {
  console.log("object");
} else {
  console.log("other");
}
console.log(typeof performance.now === "function", typeof crypto === "object");
`,
  });
  expect(heldObjectCalls(mod)).toEqual([]);
  expect(JSON.stringify(mod.functions)).not.toContain("runtimeFence");
  // The branch test itself is the constant, so neither arm reads anything.
  const folded = statements(mod).flatMap((stmt) =>
    stmt.kind === "if" && stmt.cond.kind === "boolLit" ? [stmt.cond.value] : [],
  );
  expect(folded).toContain(true);
});

test("a program that replaces the global object's member keeps the runtime answer", async () => {
  const mod = await lowerProgram({
    "main.mjs": `
globalThis.performance = "replaced";
console.log(typeof performance === "object");
`,
  });
  // The comparison reads the value the program put there, not the census's.
  expect(heldObjectCalls(mod).length).toBeGreaterThan(0);
  expect(expressions(mod).some((e) => e.kind === "dynTest")).toBe(true);
});

test("a typeof test on an unknown value keeps its runtime kind test", async () => {
  const mod = await lowerProgram(
    {
      "main.mjs": `
function isObject(value) {
  return typeof value === "object";
}
console.log(isObject({}));
`,
    },
    "main.mjs",
  );
  expect(expressions(mod).some((e) => e.kind === "dynTest")).toBe(true);
});

test("a typeof test on a builtin class prototype keeps the runtime answer", async () => {
  const mod = await lowerProgram({
    "main.mjs": `
if (typeof ArrayBuffer.prototype === "object") {
  console.log("object");
} else {
  console.log("other");
}
`,
  });
  // The census describes the pinned Node release; the native runtime has no
  // ArrayBuffer.prototype value, so the test must not fold — the feature test
  // that follows would evaluate a member of an object the program lacks.
  const folded = statements(mod).flatMap((stmt) =>
    stmt.kind === "if" && stmt.cond.kind === "boolLit" ? [stmt.cond.value] : [],
  );
  expect(folded).toEqual([]);
});
