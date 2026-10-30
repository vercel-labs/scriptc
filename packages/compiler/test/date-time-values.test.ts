import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule } from "../src/index.js";
import { emitLlvmModule } from "../src/backend/llvm/emitter.js";
import type { IrModule } from "../src/ir/ir.js";

async function lowerSource(source: string): Promise<IrModule> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-date-time-values-"));
  try {
    const entry = join(dir, "main.ts");
    await writeFile(entry, source);
    const outPath = join(dir, "main.ir.json");
    const result = await compile(entry, { outPath, outDir: dir, outputKind: "ir" });
    if (!result.ok) throw new Error(result.diagnostics.map((d) => d.message).join("\n"));
    return deserializeModule(await readFile(outPath, "utf8"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The IR type of each local named `name` in function `fn`. */
function localKinds(mod: IrModule, fn: string, name: string): string[] {
  const f = mod.functions.find((candidate) => candidate.name === fn);
  if (!f) throw new Error(`no function ${fn}`);
  return f.locals.filter((local) => local.name === name).map((local) => local.type.kind);
}

test("a Date local read only for its time value stores the time value", async () => {
  const mod = await lowerSource(`
function format(ms: number): string {
  const d = new Date(ms);
  const later = new Date(ms + 1);
  return d.toISOString() + String(d) + \`\${later}\` + (d < later) + d.getUTCHours() + new Date(d).getTime();
}
console.log(format(0));
`);
  expect(localKinds(mod, "format", "d")).toEqual(["f64"]);
  expect(localKinds(mod, "format", "later")).toEqual(["f64"]);
  // Reading the time value creates no Date object.
  const llvm = emitLlvmModule(mod, { pointerBits: 64 });
  const body = /^define internal [^\n]*@sc_f_format\([^]*?^}/m.exec(llvm)?.[0] ?? "";
  expect(body).not.toContain("@scr_date_new(");
});

test("a Date local whose identity a use can observe keeps the Date object", async () => {
  const mod = await lowerSource(`
const keep: Date[] = [];
function uses(ms: number): boolean {
  const compared = new Date(ms);
  const stored = new Date(ms);
  const passed = new Date(ms);
  const captured = new Date(ms);
  const returned = new Date(ms);
  let reassigned = new Date(ms);
  reassigned = new Date(ms + 1);
  keep.push(stored);
  const read = (): number => captured.getTime();
  console.log(String(passed), read(), returned.getTime(), reassigned.getTime());
  return compared === compared && pass(passed) === passed && back(returned) === returned;
}
function pass(d: Date): Date {
  return d;
}
function back(d: Date): Date {
  return d;
}
const top = new Date(0);
console.log(uses(0), top.getTime());
`);
  for (const name of ["compared", "stored", "passed", "captured", "returned", "reassigned"]) {
    expect(localKinds(mod, "uses", name), name).toEqual(["date"]);
  }
});

test("a Date in a block or loop at module level stores the time value unless a use observes it", async () => {
  const mod = await lowerSource(`
const seen: Date[] = [];
let total = 0;
for (let i = 0; i < 3; i++) {
  const read = new Date(i * 1000);
  const kept = new Date(i * 1000);
  seen.push(kept);
  total += read.getUTCSeconds() + read.toISOString().length;
}
{
  const block = new Date(5);
  const captured = new Date(6);
  const later = (): number => captured.getTime();
  total += block.getTime() + later();
}
const top = new Date(7);
console.log(total, seen.length, top.getTime());
`);
  expect(localKinds(mod, "%init.0", "read")).toEqual(["f64"]);
  expect(localKinds(mod, "%init.0", "block")).toEqual(["f64"]);
  expect(localKinds(mod, "%init.0", "kept")).toEqual(["date"]);
  expect(localKinds(mod, "%init.0", "captured")).toEqual(["date"]);
});
