/* What a shared module's accessor answers for each kind of export, and
 * which packages are shared (scope-B NI-6). Lowers to IR only: no libnode
 * is needed. */
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { compile, deserializeModule } from "../../index.js";
import type { IrExpr, IrFunction, IrModule, IrStmt } from "../../ir/ir.js";
import { everyStmtList } from "../../ir/traverse.js";

const dirs: string[] = [];
afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

async function lower(files: Record<string, string>): Promise<IrModule> {
  // Outside any node_modules directory: a program there would be a package.
  const dir = await realpath(await mkdtemp(join(tmpdir(), "scriptc-shared-modules-")));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, name)), { recursive: true });
    await writeFile(join(dir, name), text);
  }
  const outPath = join(dir, "main.ir.json");
  const result = await compile(join(dir, "main.mjs"), { outDir: dir, outPath, outputKind: "ir" });
  if (!result.ok)
    throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
  return deserializeModule(await readFile(outPath, "utf8"));
}

function calls(mod: IrModule, fn: string): (IrExpr & { kind: "libCall" })[] {
  const found: (IrExpr & { kind: "libCall" })[] = [];
  for (const f of mod.functions)
    everyStmtList(f.body, {
      stmt: () => true,
      expr: (e) => {
        if (e.kind === "libCall" && e.fn === fn) found.push(e);
        return true;
      },
    });
  return found;
}

/** The accessor's answer for each export of the program's one shared module. */
function answers(mod: IrModule): Record<string, IrExpr> {
  const share = calls(mod, "nodeIsland.share");
  expect(share).toHaveLength(1);
  const table = share[0]!.args[1]!;
  if (table.kind !== "strLit") throw new Error("the export table is not a literal");
  const names = (JSON.parse(table.value) as { name: string }[]).map((e) => e.name);
  const accessor = mod.functions.find((f) => f.name === "%island.shared:0");
  const answer = accessor?.body[0];
  if (answer?.kind !== "return" || answer.value?.kind !== "dynArrLit")
    throw new Error("the accessor does not answer an array");
  const elems = answer.value.elems;
  expect(elems).toHaveLength(names.length);
  return Object.fromEntries(names.map((name, i) => [name, elems[i]!]));
}

/** The flag an answer tests before it reads the export, or null. */
function flagOf(answer: IrExpr): string | null {
  return answer.kind === "ternary" && answer.cond.kind === "varRef" ? answer.cond.localId : null;
}

function stores(fn: IrFunction, flag: string): IrStmt[] {
  const found: IrStmt[] = [];
  everyStmtList(fn.body, {
    stmt: (s) => {
      if (s.kind === "assign" && s.localId === flag) found.push(s);
      return true;
    },
    expr: () => true,
  });
  return found;
}

const MAIN = `import { requireModule } from "@scriptc/node";
import { Shape, count, limit, make } from "./shapes.mjs";
const plugin = requireModule("./plugin.mjs");
console.log(new Shape(count).area(), limit, make(1).area(), plugin.name);
`;
const PLUGIN = `import { Shape } from "./shapes.mjs";
export const name = "plugin:" + typeof Shape;
`;
const SHAPES = `var Shape = class {
  constructor(side) {
    this.side = side;
  }
  area() {
    return this.side * this.side;
  }
};
var count = 3;
const limit = 9;
function make(side) {
  return new Shape(side);
}
export { Shape, count, limit, make };
`;

test("a shared module's var export is read only after its declaration ran", async () => {
  const mod = await lower({ "main.mjs": MAIN, "plugin.mjs": PLUGIN, "shapes.mjs": SHAPES });
  const answer = answers(mod);
  // A function declaration is hoisted with its value: no flag.
  expect(flagOf(answer["make"]!)).toBeNull();
  for (const name of ["Shape", "count", "limit"]) {
    const flag = flagOf(answer[name]!);
    expect(flag, name).toMatch(/%initialized$/);
    // One store, in the module's own initializer, after the declaration.
    const storing = mod.functions.filter((f) => stores(f, flag!).length > 0);
    expect(storing, name).toHaveLength(1);
    expect(stores(storing[0]!, flag!), name).toHaveLength(1);
  }
  // Before the declaration ran: a var is undefined (hoisted), a const is in
  // its temporal dead zone. The storage itself is not read: a class value's
  // holds no class object then.
  for (const name of ["Shape", "count"])
    expect(answer[name], name).toMatchObject({
      kind: "ternary",
      else_: { kind: "dynFrom", value: { kind: "unitLit", unit: "undefined" } },
    });
  expect(answer["limit"]).toMatchObject({
    kind: "ternary",
    else_: { kind: "libCall", fn: "nodeIsland.sharedTdz" },
  });
});

test("island code constructs the class a shared module's variable holds", async () => {
  const mod = await lower({ "main.mjs": MAIN, "plugin.mjs": PLUGIN, "shapes.mjs": SHAPES });
  const shape = answers(mod)["Shape"]!;
  if (shape.kind !== "ternary") throw new Error("the class export is not guarded");
  // The method table and the construct helper of a declared class.
  expect(shape.then).toMatchObject({ kind: "libCall", fn: "nodeIsland.classMethodsOf" });
  expect(mod.functions.some((f) => f.name.startsWith("%island.methods:"))).toBe(true);
  expect(mod.functions.some((f) => f.name.startsWith("%island.new:"))).toBe(true);
});

test("a variable that is reassigned is not taken for the class it starts with", async () => {
  const mod = await lower({
    "main.mjs": MAIN.replace("Shape, count, limit, make", "Shape, count, limit, make, swap"),
    "plugin.mjs": PLUGIN,
    "shapes.mjs": `${SHAPES.replace("{ Shape, count", "{ Shape, swap, count")}let other = Shape;
function swap() {
  const kept = Shape;
  Shape = other;
  other = kept;
}
`,
  });
  const shape = answers(mod)["Shape"]!;
  if (shape.kind !== "ternary") throw new Error("the class export is not guarded");
  expect(shape.then.kind === "libCall" && shape.then.fn === "nodeIsland.classMethodsOf").toBe(
    false,
  );
});

const KIT_MAIN = `import { requireModule } from "@scriptc/node";
import { Kit, isKit } from "kit";
const plugin = requireModule("./plugin.mjs");
console.log(isKit(new Kit()), plugin.name);
`;
const KIT_PLUGIN = `import { Kit } from "kit";
export const name = "plugin:" + (new Kit() instanceof Kit);
`;
const KIT_TYPES = `export declare class Kit {}
export declare function isKit(value: unknown): boolean;
`;
const kitPackage = (source: string): Record<string, string> => ({
  "main.mjs": KIT_MAIN,
  "plugin.mjs": KIT_PLUGIN,
  "node_modules/kit/package.json": `{ "name": "kit", "version": "1.0.0", "type": "module", "main": "index.js", "types": "index.d.ts" }`,
  "node_modules/kit/index.d.ts": KIT_TYPES,
  "node_modules/kit/index.js": source,
});
const IS_KIT = `function isKit(value) {
  return value instanceof Kit;
}
`;

test.each([
  ["a declared class", `class Kit {}\n${IS_KIT}export { Kit, isKit };\n`],
  ["a variable's class expression", `var Kit = class {};\n${IS_KIT}export { Kit, isKit };\n`],
  [
    "an exported constant's class expression",
    `export const Kit = class {};\n${IS_KIT}export { isKit };\n`,
  ],
])("a package that exports %s through its export list is shared", async (_form, source) => {
  const mod = await lower(kitPackage(source));
  // Two copies of the class would fail each other's instanceof.
  expect(calls(mod, "nodeIsland.share")).toHaveLength(1);
});

test("a package of functions alone is still duplicated", async () => {
  const mod = await lower({
    "main.mjs": `import { requireModule } from "@scriptc/node";
import { twice } from "kit";
const plugin = requireModule("./plugin.mjs");
console.log(twice(2), plugin.name);
`,
    "plugin.mjs": `import { twice } from "kit";\nexport const name = "plugin:" + twice(1);\n`,
    "node_modules/kit/package.json": `{ "name": "kit", "version": "1.0.0", "type": "module", "main": "index.js", "types": "index.d.ts" }`,
    "node_modules/kit/index.d.ts": `export declare function twice(n: number): number;\n`,
    "node_modules/kit/index.js": `function twice(n) {\n  return n * 2;\n}\nexport { twice };\n`,
  });
  expect(calls(mod, "nodeIsland.share")).toHaveLength(0);
});
