import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule } from "../src/index.js";

interface Reads {
  /** `dyn.builtinMethod` reads, as the prototype name each interns. */
  methods: string[];
  /** `weakMap.is` dispatch tests. */
  kindTests: number;
  /** Keyed reads that can only raise the property-read TypeError. */
  throwKeys: string[];
  /** Nullish tests on a held receiver. */
  nullish: number;
  /** Hidden locals the weak-collection reads declare. */
  heldReceivers: string[];
}

/** The weak-collection method-value reads in a JavaScript module. */
async function methodReads(source: string): Promise<Reads> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-weak-methods-"));
  try {
    const entry = join(dir, "main.js");
    await writeFile(entry, source);
    const outPath = join(dir, "main.ir.json");
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const mod = deserializeModule(await readFile(outPath, "utf8"));
    const reads: Reads = {
      methods: [],
      kindTests: 0,
      throwKeys: [],
      nullish: 0,
      heldReceivers: [],
    };
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const item of value) visit(item);
        return;
      }
      if (value === null || typeof value !== "object") return;
      const node = value as {
        kind?: unknown;
        fn?: unknown;
        test?: unknown;
        localId?: unknown;
        args?: { value?: unknown }[];
        key?: { value?: unknown };
      };
      if (node.kind === "libCall" && node.fn === "dyn.builtinMethod")
        reads.methods.push(String(node.args?.[0]?.value));
      if (node.kind === "libCall" && node.fn === "weakMap.is") reads.kindTests++;
      if (node.kind === "dynTest" && node.test === "nullish") reads.nullish++;
      if (node.kind === "dynKeyGet" && /^(has|add|delete|get)$/.test(String(node.key?.value)))
        reads.throwKeys.push(String(node.key?.value));
      if (
        node.kind === "varDecl" &&
        typeof node.localId === "string" &&
        node.localId.startsWith("%weakRecv")
      )
        reads.heldReceivers.push(node.localId);
      for (const child of Object.values(value)) visit(child);
    };
    visit(mod.functions);
    return reads;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("one weak collection reads its interned method without a dispatch", async () => {
  const reads = await methodReads(
    `const map = new WeakMap();
const key = {};
console.log(typeof map.has, map.has.call(map, key));
`,
  );
  // The receiver must hold a WeakMap, so no kind test, no unit test, and no
  // hidden local: the read is the interned prototype function.
  expect(reads.methods).toEqual(["WeakMap", "WeakMap"]);
  expect(reads.kindTests).toBe(0);
  expect(reads.nullish).toBe(0);
  expect(reads.heldReceivers).toEqual([]);
});

test("a WeakMap | WeakSet receiver picks the method its value holds", async () => {
  const reads = await methodReads(
    `function pick(flag) {
  return flag ? new WeakMap() : new WeakSet();
}
console.log(typeof pick(true).has, typeof pick(false).add, typeof pick(true).get);
`,
  );
  // `has` exists on both prototypes, so the receiver's collection chooses
  // between two interned functions; `add` and `get` have one home each, and
  // the other collection reads them as undefined.
  expect(reads.kindTests).toBe(3);
  expect(reads.methods).toEqual(["WeakMap", "WeakSet", "WeakSet", "WeakMap"]);
  expect(reads.heldReceivers).toHaveLength(3);
  expect(reads.nullish).toBe(0);
});

test("a receiver that may be null or undefined throws the property-read TypeError", async () => {
  const reads = await methodReads(
    `function maybe(flag) {
  return flag ? new WeakMap() : null;
}
function absent(flag) {
  return flag ? new WeakSet() : undefined;
}
try { console.log(maybe(false).has); } catch (e) { console.log(e.name); }
try { console.log(absent(true).delete); } catch (e) { console.log(e.name); }
`,
  );
  // Node throws from the read itself, naming the unit and the member, so the
  // nullish arm is a keyed read that raises it, not the method value.
  expect(reads.nullish).toBe(2);
  expect(reads.throwKeys).toEqual(["has", "delete"]);
  expect(reads.methods).toEqual(["WeakMap", "WeakSet"]);
  expect(reads.kindTests).toBe(0);
});
