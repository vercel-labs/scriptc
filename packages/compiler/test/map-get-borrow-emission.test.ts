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
const numbers = new Map<number, Counter>();
count(numbers, [1, 2, 1]);
console.log(named(new Map([["a", new Counter()]]), "a"), replaced(numbers));
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
    // A write between the read and its use keeps the read's own reference.
    expect(fn("replaced")).toContain("@sc_retain_Counter");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
