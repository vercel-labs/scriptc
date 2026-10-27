import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { compile } from "../src/index.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function emit(source: string, file = "main.ts"): Promise<string> {
  const outDir = await mkdtemp(join(tmpdir(), "scriptc-forin-"));
  directories.push(outDir);
  const entry = join(outDir, file);
  await writeFile(entry, source);
  const outPath = join(outDir, "program.ll");
  const result = await compile(entry, { entry, outDir, outPath, outputKind: "llvm" });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  return readFile(outPath, "utf8");
}

test("for-in over a checked-dynamic value walks native string keys", async () => {
  const llvm = await emit(`
type Row = { id: number; name: string };
function count(o: unknown): number {
  let n = 0;
  for (const k in o as Record<string, unknown>) n += k.length;
  return n;
}
const row: Row = { id: 1, name: "a" };
console.log(count(row), count(JSON.parse('{"b":1}')));
`);
  expect(llvm).toContain("call ptr @scr_dyn_for_in_key_strs(");
  expect(llvm).toContain("call zeroext i1 @scr_dyn_for_in_stable(");
  expect(llvm).not.toContain("@scr_dyn_for_in_keys(");
  // Fully required record shapes are marked fixed for the stable walk.
  expect(llvm).toMatch(
    /_rops = internal global \{ i64, ptr, ptr, ptr, i8, ptr, ptr, ptr \} \{[^}]*i8 1, ptr null, ptr null, ptr null \}/,
  );
});

test("Object.keys of an unknown value is a native string[] in TypeScript only", async () => {
  const source = `
function keysOf(o) {
  return Object.keys(o);
}
console.log(keysOf(JSON.parse('{"a":1}')).length);
`;
  const ts = await emit(
    source.replace("(o)", "(o: unknown)").replace("keys(o)", "keys(o as object)"),
  );
  expect(ts).toContain("call ptr @scr_dyn_obj_key_strs(");
  const js = await emit(source, "main.js");
  expect(js).not.toContain("@scr_dyn_obj_key_strs(");
  expect(js).toContain("call ptr @scr_dyn_obj_keys(");
});

test("Object.entries of an unknown value is a native [string, any][] in TypeScript only", async () => {
  const source = `
function entriesOf(o) {
  return Object.entries(o);
}
console.log(entriesOf(JSON.parse('{"a":1}')).length);
`;
  const ts = await emit(
    source.replace("(o)", "(o: unknown)").replace("entries(o)", "entries(o as object)"),
  );
  expect(ts).toContain("call ptr @scr_dyn_obj_entry_pairs(");
  expect(ts).toContain("call void @scr_dyn_entry_pairs_free(");
  expect(ts).not.toContain("@scr_dyn_obj_entries(");
  const js = await emit(source, "main.js");
  expect(js).not.toContain("@scr_dyn_obj_entry_pairs(");
  expect(js).toContain("call ptr @scr_dyn_obj_entries(");
});
