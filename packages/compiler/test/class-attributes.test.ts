import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule } from "../src/index.js";
import type { IrModule } from "../src/ir/ir.js";

async function lowerModule(source: string, file = "main.ts"): Promise<IrModule> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-class-attributes-"));
  try {
    const entry = join(dir, file);
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

function fieldsOf(mod: IrModule, className: string): string[] {
  const cls = (mod.classes ?? []).find(
    (c) => c.name === className || c.name.endsWith(`.${className}`),
  );
  if (!cls) throw new Error(`no class ${className}`);
  return cls.fields.map((f) => f.name);
}

function functionsCalling(mod: IrModule, fn: string): string[] {
  return mod.functions
    .filter((f) => JSON.stringify(f.body).includes(`"fn":"${fn}"`))
    .map((f) => f.name);
}

test("only hierarchies passed to an integrity call get attribute state and write checks", async () => {
  const mod = await lowerModule(`
export {};
class Point { x = 1; }
class Other { x = 1; }
function movePoint(p: Point): void { p.x = 2; }
function moveOther(o: Other): void { o.x = 2; }
const p = new Point();
Object.freeze(p);
movePoint(p);
moveOther(new Other());
`);
  expect(fieldsOf(mod, "Point")).toContain("%attributes");
  expect(fieldsOf(mod, "Other")).not.toContain("%attributes");
  const checked = functionsCalling(mod, "class.throwReadOnly");
  expect(checked).toContain("movePoint");
  expect(checked).not.toContain("moveOther");
});

test("a redefined field gets its own attribute word", async () => {
  const mod = await lowerModule(`
export {};
class Config { mode = "dev"; level = 1; }
const c = new Config();
Object.defineProperty(c, "mode", { writable: false });
`);
  const fields = fieldsOf(mod, "Config");
  expect(fields).toContain("%attributes");
  expect(fields).toContain("%attr:mode");
  expect(fields).not.toContain("%attr:level");
});

test("sloppy-mode writes skip a read-only field without throwing", async () => {
  const mod = await lowerModule(
    `
class Box { constructor() { this.x = 1; } }
const b = new Box();
Object.freeze(b);
b.x = 2;
`,
    "main.cjs",
  );
  expect(fieldsOf(mod, "Box")).toContain("%attributes");
  // Class bodies are strict mode code; the top-level write is not.
  const throwing = functionsCalling(mod, "class.throwReadOnly");
  expect(throwing.length).toBeGreaterThan(0);
  expect(throwing.every((name) => name.includes("constructor"))).toBe(true);
});

test("an untyped freeze gives every class hierarchy attribute state", async () => {
  const mod = await lowerModule(`
export {};
class Point { x = 1; }
class Labeled extends Point { label = "a"; }
function freezeUnknown(value: unknown): unknown { return Object.freeze(value); }
function move(p: Point): void { p.x = 2; }
freezeUnknown(new Labeled());
move(new Point());
`);
  expect(mod.untypedIntegrity).toBe(true);
  expect(fieldsOf(mod, "Point")).toContain("%attributes");
  expect(fieldsOf(mod, "Labeled")).toContain("%attributes");
  expect(functionsCalling(mod, "class.throwReadOnly")).toContain("move");
});

test("untyped freezes of fresh literals and tagged templates leave classes unchanged", async () => {
  const mod = await lowerModule(
    `
class Point { constructor() { this.x = 1; } }
const tag = (strings) => strings.length;
const frozen = Object.freeze({ a: 1 });
console.log(tag\`a\${1}b\`, frozen.a, new Point().x);
`,
    "main.js",
  );
  expect(mod.untypedIntegrity).toBeUndefined();
  expect(fieldsOf(mod, "Point")).not.toContain("%attributes");
});
