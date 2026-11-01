import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { VOID, type IrExpr, type IrFunction, type IrStmt, type SrcLoc } from "../../ir/ir.js";
import { compile, deserializeModule } from "../../index.js";
import { applyHandleProperties } from "./handle-properties.js";
import { ENTRY_NAME, type Lowerer } from "./lowerer.js";

const loc: SrcLoc = { file: "main.ts", start: 0, end: 1 };
const fn = (name: string, body: IrStmt[]): IrFunction => ({
  name,
  body,
  params: [],
  locals: [],
  returnType: VOID,
  loc,
});

test("renames a libCall the IR reaches from several statements once", () => {
  const call: IrExpr = { kind: "libCall", fn: "dyn.defineProperty", args: [], type: VOID, loc };
  const use: IrStmt = { kind: "exprStmt", expr: call, loc };
  const functions = [fn(ENTRY_NAME, [use, use]), fn("helper", [use])];
  applyHandleProperties(
    { writesOntoChildren: true, handleAdditions: false } as unknown as Lowerer,
    functions,
  );
  expect(call).toMatchObject({ kind: "libCall", fn: "child.propsDefine" });
  expect(functions[0]!.body[0]).toMatchObject({
    kind: "exprStmt",
    expr: { kind: "libCall", fn: "handle.propsInstall", args: [{ kind: "numLit", value: 1 }] },
  });
});

/** The IR module of a one-file program. */
async function compileIr(source: string, extension: "js" | "ts") {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-handle-properties-"));
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

function installOf(mod: Awaited<ReturnType<typeof compileIr>>): unknown {
  const main = mod.functions.find((f) => f.name === ENTRY_NAME);
  expect(main, "%main").toBeDefined();
  return main!.body[0];
}

test("a JavaScript expando write installs the handle property table", async () => {
  const mod = await compileIr(
    `"use strict";
const m = new Map();
m.x = 1;
console.log(m.size);
`,
    "js",
  );
  expect(installOf(mod)).toMatchObject({
    kind: "exprStmt",
    expr: { kind: "libCall", fn: "handle.propsInstall", args: [{ kind: "numLit", value: 0 }] },
  });
});

test("the same program as TypeScript links no table", async () => {
  const mod = await compileIr(
    `const m = new Map<number, number>();
console.log(m.size);
`,
    "ts",
  );
  expect(installOf(mod)).not.toMatchObject({
    expr: { fn: "handle.propsInstall" },
  });
});

test("a JavaScript program that only writes a declared member links no table", async () => {
  const mod = await compileIr(
    `"use strict";
const re = /a/g;
re.lastIndex = 0;
console.log(re.test("a"));
`,
    "js",
  );
  expect(installOf(mod)).not.toMatchObject({
    expr: { fn: "handle.propsInstall" },
  });
});

test("a JavaScript program that only reads a Map member links no table", async () => {
  const mod = await compileIr(
    `"use strict";
console.log(new Map().size);
`,
    "js",
  );
  expect(installOf(mod)).not.toMatchObject({
    expr: { fn: "handle.propsInstall" },
  });
});
