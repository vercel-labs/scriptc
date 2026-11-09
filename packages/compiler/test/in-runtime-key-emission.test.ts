import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule, validateModule } from "../src/index.js";
import { emitLlvmModule } from "../src/backend/llvm/emitter.js";

async function emit(source: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-in-runtime-key-"));
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

/** The serialized IR of one program, for the questions a lowering answers
 * by the order of the statements it builds. */
async function irText(source: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-in-runtime-key-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ir.json");
    await writeFile(entry, source);
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    return await readFile(outPath, "utf8");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function body(llvm: string, name: RegExp): string {
  const match = llvm.match(
    new RegExp(
      `define internal [^\\n]+ @${name.source}(?:\\.i32)?\\([^\\n]*\\) #0 \\{([\\s\\S]*?)\\n\\}`,
    ),
  );
  expect(match, `${name.source} LLVM function`).not.toBeNull();
  return match![1]!;
}

test("a runtime numeric key over an array asks the array's presence query", async () => {
  const llvm = await emit(`
function count(values: number[], names: string[], n: number): number {
  let c = 0;
  for (let i = 0; i < n; i++) if (i in values && i in names) c++;
  return c;
}
console.log(count([1, 2], ["a"], 4));
`);
  const fn = body(llvm, /sc_b?f_count/);
  expect(fn).toContain("@scr_arr_has(");
  // The checked-dynamic fallback boxed the receiver and materialized it.
  expect(fn).not.toContain("@scr_dyn_new_typed_ref");
  expect(fn).not.toContain("dyn_class_computed");
});

test("a runtime string key over an index-signature record probes the overflow map", async () => {
  const llvm = await emit(`
function has(dict: Record<string, number>, key: string): boolean { return key in dict; }
const d: Record<string, number> = {};
d["a"] = 1;
console.log(has(d, "a"), has(d, "b"));
`);
  const helper = body(llvm, /sc_b?f__x25_rec_haskey_[0-9a-f]+/);
  expect(helper).toContain("@scr_map_has_str(");
  // Not a scan over a fresh key snapshot per probe.
  expect(helper).not.toContain("@scr_map_keys_js_order(");
});

test("a runtime key over a builtin namespace is read before an effectful receiver", async () => {
  // Node evaluates the key first, then the receiver. The census answer
  // does not read the receiver, so the key is held in a local that the
  // receiver's evaluation cannot change.
  const ir = await irText(`
let name = "deflateSync";
console.log(name in (await import("node:zlib")));
`);
  const key = ir.indexOf('"%inKey');
  expect(key).toBeGreaterThan(-1);
  expect(key).toBeLessThan(ir.indexOf('"kind":"awaitExpr"'));
});

test("a side-effect-free namespace receiver keeps the key inside the census test", async () => {
  const ir = await irText(`
import * as zlib from "node:zlib";
let name = "deflateSync";
console.log(name in zlib);
`);
  expect(ir).not.toContain('"%inKey');
});

test("a write under a key that names a string by conversion takes a named helper", async () => {
  const ir = await irText(`
class Box { a = 1; }
function put(target: unknown, keys: string[], i: number, key: string): void {
  (target as any)[keys[i]] = 1;
  (target as any)[key] = 2;
}
const held: unknown = new Box();
put(held, ["a"], 0, "a");
console.log((held as Box).a);
`);
  // \`keys[i]\` is the marked write (the libCall's namedKey), \`key\` the
  // write a key typed \`string\` always made. The mark chooses the helper
  // and the helper's own write does not carry it.
  expect(ir).toContain("%dyn.class.named.");
  expect(ir).toContain("%dyn.class.computed.");
  expect(ir).not.toContain('"namedKey"');
});

test("an element read by a number on an untyped value tests the index in place", async () => {
  const llvm = await emit(`
class Box { a = 1; }
function first(values: unknown, j: number): unknown { return (values as any)[j]; }
const held: unknown = new Box();
console.log(first([1, 2], 0), first([1, 2], 1.5), first(held, 0));
`);
  const fn = body(llvm, /sc_b?f_first/);
  expect(fn).toContain("@llvm.fptosi.sat.i64.f64(");
  // The one runtime call of the fast arm is the helper's own element read.
  expect(fn).toContain("@scr_dyn_arr_at(");
  expect(fn).not.toContain("@scr_num_is_integer(");
  expect(fn).not.toContain("@scr_dyn_arr_len(");
  expect(fn).not.toContain("@scr_dyn_index_get(");
});
