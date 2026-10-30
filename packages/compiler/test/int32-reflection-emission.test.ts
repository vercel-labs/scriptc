import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

async function classLayout(
  reflection: string,
  fallback = '"nonobject"',
  typedSet = false,
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-int32-reflection-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ll");
    await writeFile(
      entry,
      `
class P {
  kind = process.argv.length | 0;
  pos = (process.argv.length * 2) | 0;
  next: P | undefined = undefined;
}
function debug(x: unknown): string {
  if (typeof x !== "object" || x === null) return ${fallback};
  ${reflection}
}
const n = process.argv.length;
const p = new P();
${typedSet ? "p.next = new P();" : ""}
if (n > 100) console.log(debug(p));
console.log(p.kind + p.pos);
`,
    );
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "llvm" });
    expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
    const llvm = await readFile(outPath, "utf8");
    return /^%sc_o_P = type \{[^}]*\}/m.exec(llvm)?.[0] ?? "";
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("reflection that reads instances through unknown keeps their int32 fields", async () => {
  const layout = await classLayout(`
  let walked = "";
  for (const k in x) walked += k;
  console.log(x, typeof x, Object.prototype.toString.call(x));
  console.log(Object.getOwnPropertyNames(x), Reflect.ownKeys(x), Object.hasOwn(x, "kind"));
  console.log(Object.keys(x), Object.values(x), Object.entries(x));
  return walked;`);
  expect(layout).toMatch(/^%sc_o_P = type \{ i64, i32, i32, ptr/);
});

test("a computed store through unknown keeps the fields it can name as doubles", async () => {
  const layout = await classLayout(`
  (x as Record<string, unknown>)[String(Object.keys(x)[0])] = 1.5;
  return "";`);
  expect(layout).toMatch(/^%sc_o_P = type \{ i64, double, double, ptr/);
});

test("a guarded typed Set retains writable storage for possible setter effects", async () => {
  const layout = await classLayout('return Object.keys(x).join(",");', '"nonobject"', true);
  expect(layout).toMatch(/^%sc_o_P = type \{ i64, double, double, ptr/);
});

test("an unresolved method keeps dynamically exposed fields as doubles", async () => {
  const layout = await classLayout(`
  (x as any).mutate();
  return "";`);
  expect(layout).toMatch(/^%sc_o_P = type \{ i64, double, double, ptr/);
});

test.each([
  ["instance toString", "return x.toString();", '"nonobject"'],
  [
    "mixed array join",
    'return [Object.keys(x), Object.values(x), Object.entries(x)].join(";");',
    '"nonobject"',
  ],
  ["String of unknown", 'return "";', "String(x)"],
])("%s retains dynamically writable field storage", async (_name, body, fallback) => {
  const layout = await classLayout(body, fallback);
  expect(layout).toMatch(/^%sc_o_P = type \{ i64, double, double, ptr/);
});
