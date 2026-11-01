import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule, validateModule } from "../src/index.js";

/** The prototype reads a compiled JavaScript module's IR holds. */
interface IntrinsicReads {
  /** `dyn.intrinsic` ids, in IR order. */
  intrinsics: string[];
  /** The number of the old per-kind prototype builders. */
  builtinPrototype: number;
  stdlibPrototype: number;
  wrapperBooleanPrototype: number;
  /** `dyn.globalConstructor` names, in IR order. */
  constructors: string[];
}

async function intrinsicReads(source: string): Promise<IntrinsicReads> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-intrinsic-objects-"));
  try {
    const entry = join(dir, "main.js");
    await writeFile(entry, source);
    const outPath = join(dir, "main.ir.json");
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const mod = deserializeModule(await readFile(outPath, "utf8"));
    const reads: IntrinsicReads = {
      intrinsics: [],
      builtinPrototype: 0,
      stdlibPrototype: 0,
      wrapperBooleanPrototype: 0,
      constructors: [],
    };
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const item of value) visit(item);
        return;
      }
      if (value === null || typeof value !== "object") return;
      const node = value as { kind?: unknown; fn?: unknown; args?: { value?: unknown }[] };
      if (node.kind === "libCall" && node.fn === "dyn.intrinsic")
        reads.intrinsics.push(String(node.args?.[0]?.value));
      if (node.kind === "libCall" && node.fn === "dyn.builtinPrototype") reads.builtinPrototype++;
      if (node.kind === "libCall" && node.fn === "dyn.stdlibPrototype") reads.stdlibPrototype++;
      if (node.kind === "libCall" && node.fn === "wrapper.booleanPrototype")
        reads.wrapperBooleanPrototype++;
      if (node.kind === "libCall" && node.fn === "dyn.globalConstructor")
        reads.constructors.push(String(node.args?.[0]?.value));
      for (const child of Object.values(value)) visit(child);
    };
    visit(mod.functions);
    expect(validateModule(mod)).toEqual([]);
    return reads;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// A program that reads a builtin prototype takes the intrinsic table's
// object (t262-da A1); the per-kind builders the runtime keeps for programs
// without the read are never asked for a second object of the same intrinsic.
test("a fact program reads builtin prototypes through the intrinsic table only", async () => {
  const reads = await intrinsicReads(
    `
const mapMethods = Map.prototype;
const get = Map.prototype.get;
const test = RegExp.prototype.test;
console.log(typeof mapMethods, typeof get, typeof test);
`,
  );
  expect(reads.intrinsics).toEqual(["Map.prototype", "Map.prototype", "RegExp.prototype"]);
  expect(reads.stdlibPrototype).toBe(0);
  expect(reads.builtinPrototype).toBe(0);
});

// The primitive wrappers keep the runtime builders that already own their
// prototype object: `Number.prototype` and `Boolean.prototype` never reach
// the table, so one intrinsic never has two builders (§4.4), and the
// constructor a wrapper prototype names is the program's own closure.
test("a primitive wrapper prototype keeps its existing builder", async () => {
  const reads = await intrinsicReads(
    `
const fixed = Number.prototype.toFixed;
const booleanMethods = Boolean.prototype.valueOf;
console.log(typeof fixed, typeof booleanMethods);
`,
  );
  expect(reads.intrinsics).toEqual([]);
  expect(reads.stdlibPrototype).toBe(0);
  expect(reads.builtinPrototype).toBe(1);
  expect(reads.wrapperBooleanPrototype).toBe(1);
});

// A program that never reads one of those objects has no fact: no
// dyn.intrinsic at all, so its IR is exactly what it was before A1.
test("a program without an intrinsic read has no dyn.intrinsic", async () => {
  const reads = await intrinsicReads(`
const fixed = (1).toFixed(2);
console.log(fixed);
`);
  expect(reads.intrinsics).toEqual([]);
});

// A fact program reads a builtin constructor as the runtime's interned
// constructor (`dyn.globalConstructor`, whose statics the fill installs),
// and a prototype through the table, so reflecting on either is an ordinary
// checked-object read.
test("a fact program reads builtin constructors as the interned constructor", async () => {
  const reads = await intrinsicReads(`
const map = Map;
const descriptor = Object.getOwnPropertyDescriptor(map, "prototype");
console.log(typeof map, descriptor.value === Map.prototype, Map.prototype.get === new Map().get);
`);
  expect([...new Set(reads.constructors)]).toEqual(["Map"]);
  const ids = [...new Set(reads.intrinsics)].sort();
  expect(ids).toEqual(["Map.prototype"]);
});
