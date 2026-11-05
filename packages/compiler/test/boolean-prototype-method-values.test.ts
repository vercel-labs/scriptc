import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule, validateModule } from "../src/index.js";

/** The prototype builders a compiled JavaScript module reads. */
interface PrototypeReads {
  wrapper: number;
  dyn: string[];
  /** dynChecks whose value is a wrapper.booleanPrototype read. */
  checkedPrototype: number;
  /** Lowering-fence messages left in the IR (string literals naming SC2020). */
  fences: string[];
}

/** `wrapper.booleanPrototype` reads and `dyn.builtinPrototype` kinds in the
 * IR of `source`. */
async function prototypeReads(source: string, extension = "js"): Promise<PrototypeReads> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-boolean-methods-"));
  try {
    const entry = join(dir, `main.${extension}`);
    await writeFile(entry, source);
    const outPath = join(dir, "main.ir.json");
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const mod = deserializeModule(await readFile(outPath, "utf8"));
    const reads: PrototypeReads = { wrapper: 0, dyn: [], checkedPrototype: 0, fences: [] };
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const item of value) visit(item);
        return;
      }
      if (value === null || typeof value !== "object") return;
      const node = value as {
        kind?: unknown;
        fn?: unknown;
        args?: { value?: unknown }[];
        value?: unknown;
      };
      if (node.kind === "libCall" && node.fn === "wrapper.booleanPrototype") reads.wrapper++;
      if (node.kind === "libCall" && node.fn === "dyn.builtinPrototype")
        reads.dyn.push(String(node.args?.[0]?.value));
      if (
        node.kind === "dynCheck" &&
        (node.value as { kind?: unknown; fn?: unknown } | undefined)?.fn ===
          "wrapper.booleanPrototype"
      )
        reads.checkedPrototype++;
      if (node.kind === "strLit" && typeof node.value === "string" && node.value.includes("SC2020"))
        reads.fences.push(node.value);
      for (const child of Object.values(value)) visit(child);
    };
    visit(mod.functions);
    expect(validateModule(mod)).toEqual([]);
    return reads;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("Boolean's prototype object and its method values come from the wrapper unit", async () => {
  const reads = await prototypeReads(
    `const valueOf = Boolean.prototype.valueOf;
const toString = Boolean.prototype.toString;
console.log(typeof valueOf, typeof toString, valueOf.call(true), toString.call(false));
`,
  );
  // The wrapper unit's Boolean.prototype is the object instances inherit
  // from, so its methods accept a primitive boolean or a Boolean wrapper
  // receiver; the dyn.builtinPrototype builder takes only primitives.
  expect(reads.wrapper).toBe(2);
  expect(reads.dyn).toEqual([]);
});

test("a call on Boolean.prototype lowers without a wrapper-construction site", async () => {
  // No `new Boolean` or `Object(value)` here, so the checker's Boolean type
  // keeps its primitive mapping; the prototype object must still reach the
  // call as the object, not be checked to a boolean or refused.
  const reads = await prototypeReads(
    `console.log(Boolean.prototype.valueOf(), Boolean.prototype.toString());\n`,
  );
  expect(reads.wrapper).toBe(2);
  expect(reads.checkedPrototype).toBe(0);
  expect(reads.fences).toEqual([]);
});

test("Number.prototype keeps the checked-dynamic prototype builder", async () => {
  const reads = await prototypeReads(`console.log(Number.prototype.toString.call(255));\n`);
  expect(reads.wrapper).toBe(0);
  expect(reads.dyn).toEqual(["Number"]);
});

test("a typed source keeps the Boolean method-value read refused", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-boolean-methods-"));
  try {
    const entry = join(dir, "main.ts");
    await writeFile(
      entry,
      `const valueOf = Boolean.prototype.valueOf;\nconsole.log(typeof valueOf);\n`,
    );
    const result = await compile(entry, {
      outDir: dir,
      outPath: join(dir, "main.ir.json"),
      outputKind: "ir",
    });
    expect(result.ok).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
