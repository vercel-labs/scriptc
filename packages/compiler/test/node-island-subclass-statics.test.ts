import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

/* A static field on a native class that extends an island class is a
 * property of the JavaScript class object the island host builds
 * (clipanion's `static paths`). The lowering defines it after the class
 * exists, in declaration order, with the property attributes Node gives a
 * static field; the member forms whose definition the JavaScript class
 * itself must carry keep their refusal. */
const repoRoot = join(import.meta.dirname, "../..");
const dir = join(repoRoot, "node_modules/.cache/scriptc-tests/node-island-subclass-statics");

function project(name: string, main: string): string {
  const root = join(dir, name);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, "node_modules/islpkg"), { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name,
      private: true,
      type: "module",
      scriptc: { packages: { islpkg: "node" } },
    }),
  );
  writeFileSync(
    join(root, "node_modules/islpkg/package.json"),
    JSON.stringify({ name: "islpkg", version: "1.0.0", main: "index.js", types: "index.d.ts" }),
  );
  writeFileSync(
    join(root, "node_modules/islpkg/index.js"),
    'class Base { constructor(x) { this.x = x; } describe() { return "base " + this.x; } }\nexports.Base = Base;\n',
  );
  writeFileSync(
    join(root, "node_modules/islpkg/index.d.ts"),
    "export declare class Base { constructor(x: number); x: number; describe(): string; }\n",
  );
  const entry = join(root, "main.ts");
  writeFileSync(entry, main);
  return entry;
}

async function compileIr(entry: string, root: string) {
  return compile(entry, {
    outDir: join(root, "out"),
    outPath: join(root, "out/main"),
    outputKind: "ir",
    libnode: join(root, "absent-pack"),
  });
}

interface IrCall {
  kind: string;
  fn?: string;
  args?: { kind: string; value?: unknown; localId?: string }[];
}

interface IrAssign {
  kind: string;
  localId?: string;
  value?: IrCall;
}

function libCalls(node: unknown, fn: string, found: IrCall[] = []): IrCall[] {
  if (Array.isArray(node)) {
    for (const item of node) libCalls(item, fn, found);
  } else if (node !== null && typeof node === "object") {
    const record = node as Record<string, unknown>;
    if (record["kind"] === "libCall" && record["fn"] === fn)
      found.push(record as unknown as IrCall);
    for (const value of Object.values(record)) libCalls(value, fn, found);
  }
  return found;
}

/** The assignment whose value is the one `nodeIsland.subclass` call. */
function subclassAssign(node: unknown, found: IrAssign[] = []): IrAssign[] {
  if (Array.isArray(node)) {
    for (const item of node) subclassAssign(item, found);
  } else if (node !== null && typeof node === "object") {
    const record = node as Record<string, unknown>;
    if (
      record["kind"] === "assign" &&
      (record["value"] as Record<string, unknown> | undefined)?.["kind"] === "libCall" &&
      (record["value"] as Record<string, unknown>)?.["fn"] === "nodeIsland.subclass"
    )
      found.push(record as unknown as IrAssign);
    for (const value of Object.values(record)) subclassAssign(value, found);
  }
  return found;
}

test("a static field is defined on the class object after it is created", async () => {
  const root = join(dir, "static-fields");
  const entry = project(
    "static-fields",
    [
      'import { Base } from "islpkg";',
      "class Sub extends Base {",
      '  static paths = [["greet"]];',
      "  static count = 0;",
      "  static label: string | undefined;",
      "  y = 2;",
      "}",
      "console.log(new Sub(1).describe(), Sub.paths.length, Sub.count, Sub.label);",
      "",
    ].join("\n"),
  );
  const result = await compileIr(entry, root);
  if (!result.ok) throw new Error(result.diagnostics.map((d) => d.message).join("\n"));
  const ir = JSON.parse(readFileSync(result.artifact.path, "utf8")) as unknown;
  const creates = subclassAssign(ir);
  expect(creates).toHaveLength(1);
  const classId = creates[0]!.localId;
  const defines = libCalls(ir, "nodeIsland.defineField");
  // Three static fields, plus the instance field `y` that the constructor's
  // fields function defines on each instance.
  expect(defines).toHaveLength(4);
  const statics = defines.filter((call) => call.args![0]!.localId === classId);
  expect(statics.map((call) => call.args![1]!.value)).toEqual(["paths", "count", "label"]);
});

test("the static forms whose definition needs the class's own body keep their refusal", async () => {
  const root = join(dir, "refused-statics");
  const entry = project(
    "refused-statics",
    [
      'import { Base } from "islpkg";',
      "export class ByMethod extends Base { static f() { return 1; } }",
      "export class ByBlock extends Base { static { void 0; } }",
      "export class ByThis extends Base { static z = 1; static y = this.z; }",
      "export class ByAccessor extends Base { static get g() { return 1; } }",
      "",
    ].join("\n"),
  );
  const result = await compileIr(entry, root);
  if (result.ok) throw new Error("expected the static member forms to be refused");
  const messages = result.diagnostics
    .filter((d) => d.code === "SC8011")
    .map((d) => d.message)
    .sort();
  expect(messages).toEqual([
    "a native class extending a class owned by a Node island cannot have a static field initializer that reads 'this' or 'super' yet",
    "a native class extending a class owned by a Node island cannot have static blocks yet",
    "a native class extending a class owned by a Node island cannot have static methods or accessors yet",
    "a native class extending a class owned by a Node island cannot have static methods or accessors yet",
  ]);
});
