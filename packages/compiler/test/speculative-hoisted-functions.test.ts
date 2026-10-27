import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule } from "../src/index.js";
import type { IrModule } from "../src/ir/ir.js";

// bignumber.js's clone(): `P = BigNumber.prototype = {...}` in a `var`
// list above the constructor. The initializer lowers speculatively first,
// which hoists the constructor and the helper it calls. Those bodies are
// kept, so their failing statements must keep runtime fences; dropping
// them left `isNum` without its return (an SC9002 trap at load). isNum's
// return reads the prototype through Reflect.getPrototypeOf, which has no
// lowering, so it fences.
const source = `
function clone(config) {
  var P = (Num.prototype = { constructor: Num, toString: null }),
    unit = config ? 2 : 1;
  function Num(v) {
    var x = this;
    if (!(x instanceof Num)) return new Num(v);
    x.v = isNum(v) ? 0 : v * unit;
  }
  function isNum(v) {
    return Reflect.getPrototypeOf(v) === P || (!!v && v._isNum === true);
  }
  P._isNum = true;
  return Num;
}
const Num = clone();
console.log(typeof Num);
`;

async function lower(): Promise<IrModule> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-speculative-hoisted-"));
  try {
    const entry = join(dir, "main.mjs");
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

function fenceCodes(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const item of node) fenceCodes(item, out);
  } else if (node !== null && typeof node === "object") {
    const record = node as Record<string, unknown>;
    if (record["kind"] === "runtimeFence") out.push(String(record["code"]));
    for (const [key, value] of Object.entries(record)) if (key !== "loc") fenceCodes(value, out);
  }
  return out;
}

test("speculatively hoisted JavaScript functions keep their statement fences", async () => {
  const mod = await lower();
  const isNum = mod.functions.find((fn) => fn.name.endsWith("_isNum"));
  expect(isNum).toBeDefined();
  expect(fenceCodes(isNum!.body)).toEqual(["SC2020"]);
  expect(mod.functions.flatMap((fn) => fenceCodes(fn.body))).not.toContain("SC9002");
});
