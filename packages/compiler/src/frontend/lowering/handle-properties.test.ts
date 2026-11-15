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

/** A child local makes moduleUsesChildProcess true over these functions,
 * the fact that links scr_child.c. */
const withChild = (f: IrFunction): IrFunction => ({
  ...f,
  locals: [{ id: "%child", name: "child", type: { kind: "child" }, mutable: false }],
});

test("renames a libCall the IR reaches from several statements once", () => {
  const call: IrExpr = { kind: "libCall", fn: "dyn.defineProperty", args: [], type: VOID, loc };
  const use: IrStmt = { kind: "exprStmt", expr: call, loc };
  const functions = [withChild(fn(ENTRY_NAME, [use, use])), fn("helper", [use])];
  applyHandleProperties(
    {
      writesOntoChildren: true,
      handleAdditions: { grants: new Map(), any: false },
      childAdditions: { written: new Set(), everyName: false, any: true },
    } as unknown as Lowerer,
    functions,
  );
  expect(call).toMatchObject({ kind: "libCall", fn: "child.propsDefine" });
  expect(functions[0]!.body[0]).toMatchObject({
    kind: "exprStmt",
    expr: { kind: "libCall", fn: "handle.propsInstall", args: [{ kind: "numLit", value: 1 }] },
  });
});

test("a child write in a module without the child fact installs no wrapper", () => {
  const functions = [fn(ENTRY_NAME, [])];
  applyHandleProperties(
    {
      writesOntoChildren: true,
      handleAdditions: { grants: new Map(), any: false },
      childAdditions: { written: new Set(), everyName: false, any: true },
    } as unknown as Lowerer,
    functions,
  );
  // The write is dead: the module cannot box a child, so nothing installs.
  expect(functions[0]!.body).toEqual([]);
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

test("a JavaScript file that only mentions child_process in text requests no child wrapper", async () => {
  // A comment mentioning child_process makes the census walk the file, but
  // nothing writes onto a child, so the program asks for no child wrapper:
  // the install must not ask scr_child.c's ops of a binary that never links
  // them.
  const mod = await compileIr(
    `"use strict";
// child_process and defineProperty are words here, not calls.
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

test("a program that spawns a child still requests the child wrapper", async () => {
  const mod = await compileIr(
    `"use strict";
const { spawn } = require("child_process");
const child = spawn(process.execPath, ["-e", ""]);
Reflect.defineProperty(child, "label", { value: 1, configurable: true });
child.on("close", () => console.log("close"));
`,
    "js",
  );
  expect(installOf(mod)).toMatchObject({
    kind: "exprStmt",
    expr: { kind: "libCall", fn: "handle.propsInstall", args: [{ kind: "numLit", value: 1 }] },
  });
});

test("an untyped define in a module without the child fact requests no child wrapper", async () => {
  // The census counts the definition, but this module cannot box a child:
  // the table it installs serves the Map write only.
  const mod = await compileIr(
    `"use strict";
// child_process is a word here, not a call.
function tag(value) {
  Reflect.defineProperty(value, "label", { value: 1, configurable: true });
}
const m = new Map();
m.x = 1;
console.log(typeof tag, m.size);
`,
    "js",
  );
  expect(installOf(mod)).toMatchObject({
    kind: "exprStmt",
    expr: { kind: "libCall", fn: "handle.propsInstall", args: [{ kind: "numLit", value: 0 }] },
  });
});

test("a define through an untyped parameter still requests the child wrapper", async () => {
  // `tag`'s parameter is untyped, so the checker resolves no type for the
  // definition's target. A child is the value the call site passes, and a
  // definition routed without the child's table is refused at runtime.
  const mod = await compileIr(
    `"use strict";
const { spawn } = require("child_process");
function tag(child) {
  Reflect.defineProperty(child, "label", { value: 1, configurable: true });
}
const child = spawn(process.execPath, ["-e", ""]);
tag(child);
child.on("close", () => console.log("close"));
`,
    "js",
  );
  expect(installOf(mod)).toMatchObject({
    kind: "exprStmt",
    expr: { kind: "libCall", fn: "handle.propsInstall", args: [{ kind: "numLit", value: 1 }] },
  });
});

test("a define through an aliased defineProperty requests the child wrapper", async () => {
  // The call's callee is a function value, not `Object.defineProperty`, so
  // the walk reaches the definition only by resolving the alias. Without the
  // child's table the runtime refuses the member.
  const mod = await compileIr(
    `"use strict";
const { spawn } = require("child_process");
const define = Object.defineProperty;
const child = spawn(process.execPath, ["-e", ""]);
define(child, "label", { value: 1, configurable: true });
child.on("close", () => console.log("close"));
`,
    "js",
  );
  expect(installOf(mod)).toMatchObject({
    kind: "exprStmt",
    expr: { kind: "libCall", fn: "handle.propsInstall", args: [{ kind: "numLit", value: 1 }] },
  });
});

test("a two-argument call to a plain helper requests no child wrapper", async () => {
  // Any function value called with two arguments would be a definition if
  // the alias resolution stopped at the value; it resolves to the initializer
  // and finds a function, not a define.
  const mod = await compileIr(
    `"use strict";
// child_process is a word here, not a call.
function copy(target, value) {
  return target;
}
const m = new Map();
m.x = copy(m, 1);
console.log(m.size);
`,
    "js",
  );
  expect(installOf(mod)).toMatchObject({
    kind: "exprStmt",
    expr: { kind: "libCall", fn: "handle.propsInstall", args: [{ kind: "numLit", value: 0 }] },
  });
});

test("a child-free program that writes on an unreachable local Map subclass compiles", async () => {
  // No JavaScript file names child_process, so the census never walks: a write
  // target in a dead function must not be mapped. Mapping it is a local-class
  // refusal, and the census owns no statement that could report it.
  const mod = await compileIr(
    `"use strict";
function never() {
  class M extends Map {}
  M.added = 1;
  return typeof M;
}
console.log("ok", typeof never);
`,
    "js",
  );
  expect(installOf(mod)).not.toMatchObject({
    expr: { fn: "handle.propsInstall" },
  });
});

/** How many checked-dynamic invocations of `method` the IR holds. A typed
 * child call that reaches the member a definition installed lowers to one of
 * these; a call left native does not. */
function dynInvokes(value: unknown, method: string): number {
  let count = 0;
  const seen = new Set<object>();
  const visit = (node: unknown): void => {
    if (typeof node !== "object" || node === null || seen.has(node)) return;
    seen.add(node);
    const record = node as Record<string, unknown>;
    if (record.kind === "dynInvoke" && record.method === method) count += 1;
    for (const child of Object.values(record)) visit(child);
  };
  visit(value);
  return count;
}

test("a typed child call reaches a member defined through an aliased defineProperty", async () => {
  // The aliased definition names its member in the second argument. Without
  // reading that name the call below lowers to the child's native method, so
  // the replacement never runs.
  const mod = await compileIr(
    `"use strict";
const { spawn } = require("child_process");
const define = Object.defineProperty;
const child = spawn(process.execPath, ["-e", ""]);
define(child, "kill", { value: () => "replaced", configurable: true });
console.log(child.kill());
child.on("close", () => console.log("close"));
`,
    "js",
  );
  expect(dynInvokes(mod, "kill")).toBe(1);
});

test("a typed child call reaches a member named by an aliased defineProperties", async () => {
  // defineProperties names its members as the keys of the descriptor object.
  const mod = await compileIr(
    `"use strict";
const { spawn } = require("child_process");
const define = Object.defineProperties;
const child = spawn(process.execPath, ["-e", ""]);
define(child, { kill: { value: () => "replaced", configurable: true } });
console.log(child.kill());
child.on("close", () => console.log("close"));
`,
    "js",
  );
  expect(dynInvokes(mod, "kill")).toBe(1);
});

test("a typed child call reaches a member an untyped target defines", async () => {
  // The definition's target is an untyped parameter, so the checker resolves
  // no child for it; the name it defines still reaches a typed call.
  const mod = await compileIr(
    `"use strict";
const { spawn } = require("child_process");
function replace(child) {
  Object.defineProperty(child, "kill", { value: () => "replaced", configurable: true });
}
const child = spawn(process.execPath, ["-e", ""]);
replace(child);
console.log(child.kill());
child.on("close", () => console.log("close"));
`,
    "js",
  );
  expect(dynInvokes(mod, "kill")).toBe(1);
});

test("a typed child call reaches a member an aliased definition names with a variable", async () => {
  // The key is a variable, not a literal, so it may name any member: the
  // typed call below must still go through the child's box rather than keep
  // the native lowering.
  const mod = await compileIr(
    `"use strict";
const { spawn } = require("child_process");
const define = Object.defineProperty;
const key = "kill";
const child = spawn(process.execPath, ["-e", ""]);
define(child, key, { value: () => "replaced", configurable: true });
console.log(child.kill());
child.on("close", () => console.log("close"));
`,
    "js",
  );
  expect(dynInvokes(mod, "kill")).toBe(1);
});

test("a child call of a member no definition names stays native", async () => {
  // The program defines `label`; `kill` is untouched, so its typed call keeps
  // the native lowering.
  const mod = await compileIr(
    `"use strict";
const { spawn } = require("child_process");
const define = Object.defineProperty;
const child = spawn(process.execPath, ["-e", ""]);
define(child, "label", { value: 1, configurable: true });
console.log(child.kill());
child.on("close", () => console.log("close"));
`,
    "js",
  );
  expect(dynInvokes(mod, "kill")).toBe(0);
});
