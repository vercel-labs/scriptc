import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule, validateModule } from "../src/index.js";

test("JavaScript functions read the call receiver only when they refer to `this`", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-js-receiver-"));
  try {
    const entry = join(dir, "main.js");
    const outPath = join(dir, "main.ir.json");
    await writeFile(
      entry,
      `
function add(a, b) { return a + b; }
function pair(a) { const f = (b) => [a, b]; return f(1); }
function field() { return this.k; }
function fromDefault(a = this.k) { return a; }
function viaArrow() { return () => this.k; }
function* items() { yield this.n; }
function Plain() {}
const box = { constant() { return 9; }, read() { return this.k; } };
console.log(add(1, 2), pair(3), field.call({ k: 1 }), fromDefault.call({ k: 2 }));
console.log(viaArrow.call({ k: 3 })(), [...items.call({ n: 4 })], new Plain(), box.constant(), box.read());
`,
    );
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const mod = deserializeModule(await readFile(outPath, "utf8"));
    expect(validateModule(mod)).toEqual([]);
    const readsReceiver = (name: string): boolean => {
      // Object literal methods are named `%fn.<hash>_<method>`.
      const fns = mod.functions.filter(
        (fn) => fn.sourceName === name || fn.name.endsWith(`_${name}`),
      );
      expect(fns.length, `${name} IR functions`).toBeGreaterThan(0);
      return fns.some((fn) => /"fn":"dyn\.(generatorThis|this)"/.test(JSON.stringify(fn.body)));
    };
    for (const name of ["add", "pair", "Plain", "constant"])
      expect(readsReceiver(name), name).toBe(false);
    for (const name of ["field", "fromDefault", "viaArrow", "items", "read"])
      expect(readsReceiver(name), name).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
