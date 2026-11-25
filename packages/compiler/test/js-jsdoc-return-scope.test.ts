import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule, validateModule } from "../src/index.js";
import type { IrModule } from "../src/ir/ir.js";

async function lower(source: string): Promise<IrModule> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-js-jsdoc-return-scope-"));
  try {
    const entry = join(dir, "main.js"),
      output = join(dir, "main.ir.json");
    await writeFile(entry, source);
    const result = await compile(entry, { outDir: dir, outPath: output, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((item) => `${item.code}: ${item.message}`).join("\n"));
    const module = deserializeModule(await readFile(output, "utf8"));
    expect(validateModule(module)).toEqual([]);
    return module;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function returnKind(module: IrModule, name: string): string {
  const fn = module.functions.find((candidate) => candidate.name === name);
  expect(fn, name).toBeDefined();
  return fn!.returnType.kind;
}

/** The checked-dynamic representations a JS return slot takes: the boxed
 * value (`dyn`) and the unboxed JavaScript value (`jsval`). */
const DYNAMIC = ["dyn", "jsval"];

const CLASS = `class Color {
  constructor(value = 0) {
    this.value = value;
    this.self = this;
  }
}
`;

/* A JavaScript file TypeScript does not check keeps a documented class
 * result as a hint (`documented` answers the plain object it was handed), but
 * the tag belongs to the declaration that carries it: the functions after it
 * keep the static result their own bodies produce. */
test("a JSDoc @returns leaves the next function's class result static", async () => {
  const module = await lower(`// @ts-nocheck
${CLASS}
const swatch = new Color(1);

/** @returns {Color} */
function documented() {
  return swatch;
}

/** @param {Color} target */
function rebuilt(target) {
  return new Color(target.value);
}

console.log(documented().value, rebuilt(swatch).value);
`);
  expect(returnKind(module, "documented")).toBe("dyn");
  expect(returnKind(module, "rebuilt")).toBe("object");
});

/* A result that comes from one of the function's own checked-dynamic
 * parameters is the caller's value: a constant copy, a property read and a
 * conditional arm all keep that provenance, so a plain object comes back as
 * that object (`rebuilt` above still builds a real instance). */
test("a class result a checked-dynamic parameter supplies stays dynamic", async () => {
  const module = await lower(`// @ts-nocheck
${CLASS}
/** @param {Color} target */
function copied(target) {
  const copy = target;
  return copy;
}

/** @param {Color} target */
function picked(target) {
  return target ? target : null;
}

/** @param {Color} target */
function selfOf(target) {
  return target.self;
}

const swatch = new Color(1);
console.log(copied(swatch).value, picked(swatch).value, selfOf(swatch).value);
`);
  expect(DYNAMIC).toContain(returnKind(module, "copied"));
  expect(DYNAMIC).toContain(returnKind(module, "picked"));
  expect(DYNAMIC).toContain(returnKind(module, "selfOf"));
});
