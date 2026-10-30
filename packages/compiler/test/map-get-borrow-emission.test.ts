import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule } from "../src/index.js";
import { emitLlvmModule } from "../src/backend/llvm/emitter.js";

test("a Map.get local read before any reference write holds the entry's reference", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-map-get-borrow-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ir.json");
    await writeFile(
      entry,
      `
class Counter {
  num = 1;
}
function count(m: Map<number, Counter>, keys: number[]): void {
  for (const key of keys) {
    const cur = m.get(key);
    if (cur === undefined) m.set(key, new Counter());
    else cur.num++;
  }
}
function named(m: Map<string, Counter>, key: string): number {
  const cur = m.get(key);
  return cur === undefined ? 0 : cur.num;
}
function replaced(m: Map<number, Counter>): number {
  const old = m.get(1);
  m.set(1, new Counter());
  return old === undefined ? 0 : old.num;
}
function aliased(m: Map<number, Counter>): number {
  const held = m.get(1);
  const copy = held;
  m.set(1, new Counter());
  return copy === undefined ? 0 : copy.num;
}
function fresh(): Map<number, Counter> {
  return new Map([[1, new Counter()]]);
}
function temporary(keys: number[]): number {
  let total = 0;
  for (const key of keys) {
    const held = fresh().get(key);
    if (held !== undefined) total += held.num;
  }
  return total;
}
class Holder {
  m = new Map<number, Counter>([[1, new Counter()]]);
  key(): number {
    this.m = new Map();
    return 1;
  }
  read(): number {
    const held = this.m.get(this.key());
    return held === undefined ? 0 : held.num;
  }
}
const numbers = new Map<number, Counter>();
count(numbers, [1, 2, 1]);
console.log(named(new Map([["a", new Counter()]]), "a"), replaced(numbers), aliased(numbers), temporary([1, 2]), new Holder().read());
`,
    );
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const mod = deserializeModule(await readFile(outPath, "utf8"));
    const ll = emitLlvmModule(mod);
    const fn = (name: string): string =>
      new RegExp(`^define internal [^\\n]*@sc_bf_${name}(?:\\.i32)?\\([^]*?^}`, "m").exec(ll)![0];
    // The update writes the map only where the entry is absent, and a
    // string key's lookup is inline: neither read retains the value.
    for (const name of ["count", "named"]) {
      expect(fn(name)).not.toContain("@sc_retain_Counter");
      expect(fn(name)).not.toContain("@sc_release_Counter");
    }
    // A write between the read and its use keeps the read's own reference,
    // also when the use goes through a local declared from the read, and so
    // does a read from a map that is released after the declaration.
    for (const name of ["replaced", "aliased", "temporary"])
      expect(fn(name)).toContain("@sc_retain_Counter");
    // A key whose evaluation replaces the receiver's field leaves the read
    // on the old map, which the statement releases: the read keeps its own
    // reference.
    expect(fn("_x25_Holder_read")).toContain("@sc_retain_Counter");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
