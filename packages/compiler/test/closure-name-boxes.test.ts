import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule, validateModule } from "../src/index.js";
import { emitLlvmModule } from "../src/backend/llvm/emitter.js";

test("a closure boxed where it is made takes its name at compile time", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-closure-names-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ir.json");
    await writeFile(
      entry,
      `
function named(): number {
  return 1;
}
const items: unknown = JSON.parse('[1, "a", 2]');
const all = Array.isArray(items) && items.every((item) => typeof item === "number");
const holder: Record<string, unknown> = {};
holder.f = named;
holder.g = () => 2;
console.log(all, holder);
`,
    );
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const mod = deserializeModule(await readFile(outPath, "utf8"));
    expect(validateModule(mod)).toEqual([]);
    const llvm = emitLlvmModule(mod);
    // The callback, `named` and the arrow box with a constant name or null;
    // none of them searches the closure-name table.
    expect(llvm).not.toContain("@sc_closure_name(");
    expect(llvm).not.toMatch(/call ptr @sc_dfu_\d+\(/);
    const boxes = [...llvm.matchAll(/call ptr @sc_dfb_\d+\(ptr %\w+, ptr (null|@\w+)\)/g)];
    const names = boxes.map((m) => m[1]);
    expect(names.filter((name) => name === "null").length).toBeGreaterThanOrEqual(2);
    const constant = names.find((name) => name !== "null");
    expect(constant).toBeDefined();
    expect(llvm).toMatch(new RegExp(`${constant} = [^\\n]*c"named\\\\00"`));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/** The LLVM module of `source`. */
async function emitted(source: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-closure-names-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ir.json");
    await writeFile(entry, source);
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const mod = deserializeModule(await readFile(outPath, "utf8"));
    expect(validateModule(mod)).toEqual([]);
    return emitLlvmModule(mod);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const HELD = `
function first(): number {
  return 1;
}
function second(): number {
  return 2;
}
const held = { a: first, b: second, c: () => 3 };
const box: unknown = held;
console.log(box);
`;

test("a box without a static name searches a sorted closure-name table", async () => {
  const llvm = await emitted(HELD);
  expect(llvm).toMatch(/call ptr @sc_dfu_\d+\(/);
  // The rows are sorted by entry address on the first lookup, in place.
  expect(llvm).toMatch(/^@sc_closure_names = internal global \[\d+ x \{ ptr, ptr \}\] \[/m);
  expect(llvm).toMatch(/^@sc_closure_names_sorted = internal global i1 false$/m);
  expect(llvm).toMatch(/call void @qsort\(ptr @sc_closure_names, i64 \d+, i64 ptrtoint /);
  const start = llvm.indexOf("define internal ptr @sc_closure_name(");
  const lookup = llvm.slice(start, llvm.indexOf("\n}\n", start));
  // The lookup halves its range instead of walking the rows.
  expect(lookup).toContain("load i1, ptr @sc_closure_names_sorted");
  expect(lookup).toContain("lshr i64 %n, 1");
  expect(lookup).not.toMatch(/add i64 %\w+, 1\n/);
});

test("a Worker program keeps the closure-name table per thread", async () => {
  const llvm = await emitted(`
import { Worker, isMainThread, parentPort } from "node:worker_threads";
${HELD}
if (isMainThread) new Worker(new URL(import.meta.url)).once("exit", () => console.log("done"));
else parentPort!.postMessage(1);
`);
  // Each thread sorts and reads its own rows, as it has its own globals.
  expect(llvm).toMatch(/^@sc_closure_names = internal thread_local(\(localexec\))? global \[/m);
  expect(llvm).toMatch(
    /^@sc_closure_names_sorted = internal thread_local(\(localexec\))? global i1 false$/m,
  );
});
