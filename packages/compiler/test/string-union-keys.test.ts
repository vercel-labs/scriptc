import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule, validateModule } from "../src/index.js";
import { emitLlvmModule } from "../src/backend/llvm/emitter.js";
import { keepSetElementsBoxed } from "../src/backend/llvm/test-boxed-unions.js";
import { type IrModule } from "../src/ir/ir.js";

async function lower(source: string): Promise<IrModule> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-string-union-keys-"));
  try {
    const entry = join(dir, "main.ts"),
      outPath = join(dir, "main.ir.json");
    await writeFile(entry, source);
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const mod = deserializeModule(await readFile(outPath, "utf8"));
    expect(validateModule(mod)).toEqual([]);
    return mod;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function body(llvm: string, symbol: string): string {
  const found = new RegExp(`^define internal [^\\n]*@${symbol}(?:\\.i32)?\\([^]*?^}`, "m").exec(
    llvm,
  );
  expect(found, symbol).not.toBeNull();
  return found![0];
}

const HELD = `
class Named {
  readonly name: string | null;
  constructor(name: string | null) { this.name = name; }
}
function make(index: number, text: string): Named {
  return new Named(index % 2 === 0 ? null : text);
}
function pick(index: number, text: string): string | null {
  return index % 3 === 0 ? null : text;
}
`;

test("a Set keyed by string | null stores string keys and the union stays a pointer everywhere", async () => {
  const mod = await lower(`${HELD}
const seen = new Set<string | null>();
function note(value: string | null): boolean {
  if (seen.has(value)) return false;
  seen.add(value);
  return true;
}
function forget(value: string | null): boolean { return seen.delete(value); }
function all(): Array<string | null> { return [...seen]; }
function count(): number {
  let total = 0;
  for (const value of seen) total += value === null ? 1 : value.length;
  return total;
}
console.log(note(make(1, "a").name), note(pick(3, "b")), forget(null), all().length, count());
`);
  const llvm = emitLlvmModule(mod);
  // No union box is made anywhere in the program.
  expect(llvm).not.toContain("@scr_union_new_ref");
  // The Set is a string-key map, and the module defines the unit arm's key.
  expect(llvm).toContain("call ptr @scr_map_new(i32 1, i32 0,");
  expect(llvm).toMatch(/^@sc_key_null = internal global .* c"\\FFn\\00" }/m);
  expect(llvm).toMatch(/^@sc_key_undefined = internal global .* c"\\FFu\\00" }/m);
  // A key going in is encoded: NULL becomes the key string.
  const note = body(llvm, "sc_bf_note");
  expect(note).toMatch(
    /icmp eq ptr %[\w.]+, null\n\s+%[\w.]+ = select i1 %[\w.]+, ptr @sc_key_null, ptr %/,
  );
  expect(note).not.toContain("_ref(");
  expect(body(llvm, "sc_bf_forget")).toContain("@scr_map_delete_str(");
  expect(body(llvm, "sc_bf_forget")).toContain("ptr @sc_key_null");
  // A key coming out is decoded: the key string becomes NULL again.
  const decoded =
    /icmp eq ptr %[\w.]+, @sc_key_null\n\s+%[\w.]+ = select i1 %[\w.]+, ptr null, ptr %/;
  expect(llvm.split("@scr_map_iter_key_str(").length).toBeGreaterThan(2);
  // The spread (wherever the backend put it) loops over decoded keys.
  const all = llvm;
  expect(all).toMatch(decoded);
  expect(all).toContain("@scr_map_iter_key_str(");
  expect(all).not.toContain("@scr_set_to_arr_");
});

test("the same program with the union kept a box keys the Set by boxes", async () => {
  const mod = await lower(`${HELD}
const seen = new Set<string | null>();
function note(value: string | null): boolean {
  if (seen.has(value)) return false;
  seen.add(value);
  return true;
}
console.log(note(make(1, "a").name), note(pick(3, "b")));
`);
  const llvm = emitLlvmModule(mod, keepSetElementsBoxed(mod));
  expect(llvm).toContain("@scr_union_new_ref");
  expect(llvm).toContain("call ptr @scr_map_new(i32 7, i32 0,");
  expect(llvm).not.toContain("@sc_key_null");
  expect(body(llvm, "sc_bf_note")).toContain("@scr_map_has_ref(");
});

test("a Map keyed by string | null | undefined encodes both unit arms; seeds and value sets loop", async () => {
  const mod = await lower(`
const byKey = new Map<string | null | undefined, number>();
function put(key: string | null | undefined, value: number): void { byKey.set(key, value); }
function get(key: string | null | undefined): number { return byKey.get(key) ?? -1; }
function keys(): number {
  let total = 0;
  for (const key of byKey.keys()) total += key === null ? 1 : key === undefined ? 2 : key.length;
  return total;
}
function seeded(values: Array<string | undefined>): number {
  return new Set<string | undefined>(values).size;
}
function valuesOf(source: Map<number, string | undefined>): number {
  return new Set<string | undefined>(source.values()).size;
}
put(null, 1);
put(undefined, 2);
put("a", 3);
console.log(get(null), get(undefined), get("a"), keys(), seeded(["a", undefined]), valuesOf(new Map([[1, "a"]])));
`);
  const llvm = emitLlvmModule(mod);
  expect(llvm).not.toContain("@scr_union_new_ref");
  const put = body(llvm, "sc_bf_put");
  expect(put).toMatch(/select i1 %[\w.]+, ptr @sc_key_undefined, ptr %/);
  expect(put).toMatch(
    /icmp eq ptr %[\w.]+, @sc_nullable_null\n\s+%[\w.]+ = select i1 %[\w.]+, ptr @sc_key_null, ptr %/,
  );
  expect(put).toContain("@scr_map_set_str_f64(");
  // The loop over the keys (wherever the backend put it) decodes both.
  const keys = llvm;
  expect(keys).toMatch(
    /icmp eq ptr %[\w.]+, @sc_key_undefined\n\s+%[\w.]+ = select i1 %[\w.]+, ptr null, ptr %/,
  );
  expect(keys).toMatch(
    /icmp eq ptr %[\w.]+, @sc_key_null\n\s+%[\w.]+ = select i1 %[\w.]+, ptr @sc_nullable_null, ptr %/,
  );
  // The runtime's bulk operations would hash a unit arm's pointer as a
  // string: both are loops over encoded keys.
  const seeded = body(llvm, "sc_bf_seeded");
  expect(seeded).not.toContain("@scr_set_add_all");
  expect(seeded).toContain("@scr_arr_get_ref(");
  expect(seeded).toContain("@scr_map_set_str_f64(");
  const valuesOf = body(llvm, "sc_bf_valuesOf");
  expect(valuesOf).not.toContain("@scr_map_values_into");
  expect(valuesOf).toContain("@scr_map_iter_val_ref(");
});

test("a program without such a collection defines no key strings", async () => {
  const mod = await lower(`${HELD}
const names = new Set<string>();
names.add(pick(1, "a") ?? "none");
console.log(make(1, "a").name, names.size);
`);
  const llvm = emitLlvmModule(mod);
  expect(llvm).not.toContain("@sc_key_");
});
