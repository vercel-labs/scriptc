import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule, serializeModule, validateModule } from "../src/index.js";
import { analyzeCallLifetimes } from "../src/backend/llvm/call-lifetimes.js";
import { emitLlvmModule } from "../src/backend/llvm/emitter.js";
import { mangleBorrowedFunction, mangleClassRetain } from "../src/backend/mangle.js";
import { type IrModule } from "../src/ir/ir.js";

/** A pending-exception check: the inline active-cell test or a runtime call. */
// Synchronous bodies test the kind of the entry-loaded exception cell.
const PENDING_CHECK = /@scr_exc_(?:active|pending)\b| = load i32, ptr %exc\.cell\b/;

async function lower(source: string): Promise<IrModule> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-input-lifetimes-"));
  try {
    const entry = join(dir, "main.ts"),
      output = join(dir, "main.ir.json");
    await writeFile(entry, source);
    const result = await compile(entry, {
      outDir: dir,
      outPath: output,
      outputKind: "ir",
    });
    if (!result.ok)
      throw new Error(result.diagnostics.map((item) => `${item.code}: ${item.message}`).join("\n"));
    const module = deserializeModule(await readFile(output, "utf8"));
    expect(validateModule(module)).toEqual([]);
    return module;
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

/** Source Get owns its result, whether the element came from a slot or a getter. */
function arrayReadValues(
  module: IrModule,
  llvm: string,
  work: string,
  count = 1,
): [string, ...string[]] {
  const helper = module.functions.find(
    (fn) => fn.body[0]?.kind === "return" && fn.body[0].value?.kind === "arrayPropertyRead",
  );
  expect(helper).toBeDefined();
  const symbol = mangleBorrowedFunction(helper!.name);
  const read = body(llvm, symbol);
  expect(read).toContain("@scr_arr_property_get");
  expect(read).toContain("@scr_arr_property_unbox");
  const array = helper!.params[0]!.type;
  expect(array.kind).toBe("array");
  if (array.kind === "array") {
    expect(["object", "string"]).toContain(array.elem.kind);
    const retain =
      array.elem.kind === "object" ? mangleClassRetain(array.elem.className) : "scr_str_retain_v";
    expect(read).toContain(`= call ptr @${retain}(`);
  }
  const calls = [...work.matchAll(new RegExp(`(%t\\d+) = call ptr @${symbol}(?:\\.i32)?\\(`, "g"))];
  expect(calls).toHaveLength(count);
  const values = calls.map((call) => call[1]!);
  expect(new Set(values).size).toBe(count);
  return values as [string, ...string[]];
}

/** Select the actual pending-check successor, not an unrelated later release. */
function continuation(work: string, callee: string, outcome: "normal" | "unwind"): string {
  const call = work.indexOf(`@${callee}`);
  expect(call).toBeGreaterThanOrEqual(0);
  const after = work.slice(call);
  const branch = /br i1 [^,]+, label %([\w.]+), label %([\w.]+)/.exec(after);
  expect(branch).not.toBeNull();
  expect(after.slice(0, branch!.index)).toMatch(PENDING_CHECK);
  const label = branch![outcome === "unwind" ? 1 : 2]!;
  const block = after.split(`${label}:\n`)[1];
  expect(block).toBeDefined();
  const result = block!.split(/^\w[\w.]*:/m)[0]!;
  const releases = result.match(/call void @\w*release\w*\(ptr %t\d+\)/g) ?? [];
  expect(new Set(releases).size).toBe(releases.length);
  return result;
}

test("projected collection receivers borrow across local helper work and typed mutation", async () => {
  const module = await lower(`
class Box {
  items = new Map<string, number>();
  keys = new Set<number>();
}
function key(input: string): string {
  let selected = input;
  if (selected.length === 0) selected = "fallback";
  return selected;
}
function read(box: Box, input: string): number { return box.items.get(key(input)) ?? 0; }
function write(box: Box, input: string, value: number): number {
  box.items.set(key(input), value);
  box.keys.add(value);
  return box.items.size + box.keys.size;
}
const box = new Box();
console.log(write(box, "entry", 7), read(box, "entry"));
`);
  for (const pointerBits of [32, 64] as const) {
    const llvm = emitLlvmModule(deserializeModule(serializeModule(module)), { pointerBits });
    for (const name of ["read", "write"]) {
      const work = body(llvm, `sc_bf_${name}`);
      expect(work).not.toContain("@scr_map_retain_v");
      expect(work).not.toContain("@scr_map_release");
    }
    expect(body(llvm, "sc_bf_write")).toContain("@scr_map_set_str_f64");
  }
});

test("projected collection receivers keep snapshots across an owner replacement", async () => {
  const module = await lower(`
class Box { items = new Map<string, number>(); }
let root = new Box();
function replace(): string { root = new Box(); return "entry"; }
function read(): number { return root.items.get(replace()) ?? 0; }
console.log(read());
`);
  for (const pointerBits of [32, 64] as const) {
    const work = body(emitLlvmModule(module, { pointerBits }), "sc_f_read");
    const retain = work.indexOf("@scr_map_retain_v");
    const replace = work.indexOf("@sc_f_replace");
    expect(retain).toBeGreaterThan(0);
    expect(replace).toBeGreaterThan(retain);
    expect(work.slice(replace)).toContain("@scr_map_release");
  }
});

test("source string helpers preserve borrowing after the serialized IR boundary", async () => {
  const module = await lower(`
function score(text: string, prefix: string): number {
  return text.startsWith(prefix) ? text.length + text.charCodeAt(0) : 0;
}
function relay(text: string, prefix: string): number { return score(text, prefix); }
console.log(relay("ready", "re"));
`);
  const facts = analyzeCallLifetimes(new Map(module.functions.map((fn) => [fn.name, fn])));
  expect(facts.parameters.get("score")).toEqual(new Set([0, 1]));
  expect(facts.parameters.get("relay")).toEqual(new Set([0, 1]));
  const llvm = emitLlvmModule(module);
  expect(body(llvm, "sc_bf_score")).toContain("@scr_str_starts_with");
  expect(body(llvm, "sc_bf_score")).not.toContain("@scr_str_retain_v");
  expect(body(llvm, "sc_bf_relay")).not.toContain("@scr_str_retain_v");
  expect(body(llvm, "sc_f_score").match(/@scr_str_release/g)).toHaveLength(2);
  expect(emitLlvmModule(deserializeModule(serializeModule(module)))).toBe(llvm);
});

test("direct source array arguments keep owned values through the borrowed helper ABI", async () => {
  const module = await lower(`
class Item { value: number; constructor(value: number) { this.value = value; } }
function value(item: Item): number { return item.value; }
function work(items: Item[], index: number): number { return value(items[index]); }
console.log(work([new Item(7)], 0));

// Keeps the optional element union a tagged box (Set elements are boxes),
// so owned union cleanup stays exercised; nullable pointers bypass it.
const keepBoxed = new Set<Item | undefined>();
void keepBoxed;
`);
  const value = module.functions.find((fn) => fn.name === "value")!;
  expect(value.params[0]!.type.kind).toBe("union");
  const llvm = emitLlvmModule(module);
  const work = body(llvm, "sc_bf_work");
  const [valueRead] = arrayReadValues(module, llvm, work);
  expect(work).toMatch(new RegExp(`@sc_bf_value(?:\\.i32)?\\(ptr ${valueRead}\\)`));
  for (const outcome of ["normal", "unwind"] as const) {
    expect(continuation(work, "sc_bf_value", outcome)).toContain(
      `@scr_union_release(ptr ${valueRead})`,
    );
  }
  expect(work).not.toContain("@sc_retain_Item");
  expect(body(llvm, "sc_f_value")).toContain("@scr_union_release");
});

test("a source array mutation during later argument evaluation retains the earlier payload", async () => {
  const module = await lower(`
class Item { value: number; constructor(value: number) { this.value = value; } }
function value(item: Item, ignored: number): number { return item.value + ignored; }
function clear(items: Item[]): number { items.length = 0; return 1; }
function work(items: Item[]): number { return value(items[0], clear(items)); }
console.log(work([new Item(7)]));

// Keeps the optional element union a tagged box (Set elements are boxes),
// so owned union cleanup stays exercised; nullable pointers bypass it.
const keepBoxed = new Set<Item | undefined>();
void keepBoxed;
`);
  const llvm = emitLlvmModule(module);
  const work = body(llvm, "sc_bf_work");
  const [value] = arrayReadValues(module, llvm, work);
  expect(work.indexOf(`${value} = call ptr`)).toBeLessThan(work.indexOf("@sc_bf_clear"));
  expect(continuation(work, "sc_bf_clear", "unwind")).toContain(`@scr_union_release(ptr ${value})`);
  expect(continuation(work, "sc_bf_value", "normal")).toContain(`@scr_union_release(ptr ${value})`);
});

test("source helpers that return their input retain a heap representation", async () => {
  const module = await lower(`
class Item { value = 7; }
function identity(item: Item): Item { return item; }
function work(items: Item[]): Item { return identity(items[0]); }
console.log(work([new Item()]).value);
`);
  const facts = analyzeCallLifetimes(new Map(module.functions.map((fn) => [fn.name, fn])));
  expect(facts.parameters.has("identity")).toBe(false);
  expect(body(emitLlvmModule(module), "sc_bf_work")).not.toContain("alloca %ScrUnion");
});

test("a helper's string projection retains an escaping result independently of the array", async () => {
  const module = await lower(`
class Item { label: string; constructor(label: string) { this.label = label; } }
function label(item: Item): string { return item.label; }
function work(items: Item[]): string { return label(items[0]); }
console.log(work([new Item("kept")]));

// Keeps the optional element union a tagged box (Set elements are boxes),
// so owned union cleanup stays exercised; nullable pointers bypass it.
const keepBoxed = new Set<Item | undefined>();
void keepBoxed;
`);
  const llvm = emitLlvmModule(module);
  const work = body(llvm, "sc_bf_work");
  const [value] = arrayReadValues(module, llvm, work);
  const normal = continuation(work, "sc_bf_label", "normal");
  expect(normal).toContain(`@scr_union_release(ptr ${value})`);
  expect(normal).not.toContain("@scr_str_release");
  expect(normal).toMatch(/ret ptr %t\d+/);
  expect(body(llvm, "sc_bf_label")).toContain("@scr_str_retain_v");
  expect(body(llvm, "sc_bf_label")).not.toContain("@scr_union_retain_v");
});

test("source-level helper aliases retain their owned adapter", async () => {
  const module = await lower(`
function size(value: string): number { return value.length; }
function invoke(callback: (value: string) => number, value: string): number { return callback(value); }
console.log(invoke(size, "indirect"));
`);
  const llvm = emitLlvmModule(module);
  expect(body(llvm, "sc_bf_size")).not.toContain("@scr_str_release");
  expect(body(llvm, "sc_f_size")).toContain("@scr_str_release");
  expect(body(llvm, "sc_bf_invoke")).toContain("@scr_str_retain_v");
});

test("many source call sites keep separate owned results from one read helper", async () => {
  const module = await lower(`
class Item { value = 7; }
function pair(left: Item, right: Item): number { return left.value + right.value; }
function work(items: Item[]): number { return pair(items[0], items[1]) + pair(items[1], items[0]); }
console.log(work([new Item(), new Item()]));

// Keeps the optional element union a tagged box (Set elements are boxes),
// so owned union cleanup stays exercised; nullable pointers bypass it.
const keepBoxed = new Set<Item | undefined>();
void keepBoxed;
`);
  const llvm = emitLlvmModule(module);
  const work = body(llvm, "sc_bf_work");
  const values = arrayReadValues(module, llvm, work, 4);
  const pairs = [...work.matchAll(/@sc_bf_pair(?:\.i32)?\(ptr (%t\d+), ptr (%t\d+)\)/g)];
  expect(pairs).toHaveLength(2);
  for (const [index, pair] of pairs.entries()) {
    const inputs = values.slice(index * 2, index * 2 + 2);
    expect(pair.slice(1)).toEqual(inputs);
    for (const outcome of ["normal", "unwind"] as const) {
      const block = continuation(work.slice(pair.index), "sc_bf_pair", outcome);
      for (const value of inputs) expect(block).toContain(`@scr_union_release(ptr ${value})`);
    }
  }
});

test("a throwing later source argument releases the retained snapshot on its exception edge", async () => {
  const module = await lower(`
class Item { value = 7; }
function read(item: Item, ignored: number): number { return item.value + ignored; }
function fail(items: Item[]): number { items.pop(); throw new Error("failed"); }
function work(items: Item[]): number { return read(items[0], fail(items)); }
try { console.log(work([new Item()])); } catch {}
`);
  // The later argument removes the element, so the snapshot must own it.
  const llvm = emitLlvmModule(module);
  const work = body(llvm, "sc_bf_work");
  const [value] = arrayReadValues(module, llvm, work);
  const failure = work.indexOf("@sc_bf_fail");
  expect(failure).toBeGreaterThan(0);
  expect(work.indexOf(`${value} = call ptr`)).toBeLessThan(failure);
  expect(work.slice(failure)).toMatch(PENDING_CHECK);
  expect(continuation(work, "sc_bf_fail", "unwind")).toContain(`@sc_release_Item(ptr ${value})`);
  expect(continuation(work, "sc_bf_read", "normal")).toContain(`@sc_release_Item(ptr ${value})`);
  expect(work).not.toContain("@scr_union_release");
});

test("a throwing later source argument releases its owned read even without an array write", async () => {
  const module = await lower(`
class Item { value = 7; }
function read(item: Item, ignored: number): number { return item.value + ignored; }
function fail(): number { throw new Error("failed"); }
function work(items: Item[]): number { return read(items[0], fail()); }
try { console.log(work([new Item()])); } catch {}
`);
  // Get can invoke a promoted getter, so its result has its own owner even
  // when the later argument preserves all array slots.
  const llvm = emitLlvmModule(module);
  const work = body(llvm, "sc_bf_work");
  const [value] = arrayReadValues(module, llvm, work);
  const failure = work.indexOf("@sc_f_fail");
  expect(failure).toBeGreaterThan(0);
  expect(work.indexOf(`${value} = call ptr`)).toBeLessThan(failure);
  expect(work.slice(failure)).toMatch(PENDING_CHECK);
  expect(work).not.toContain("@sc_retain_Item");
  expect(continuation(work, "sc_f_fail", "unwind")).toContain(`@sc_release_Item(ptr ${value})`);
  expect(continuation(work, "sc_bf_read", "normal")).toContain(`@sc_release_Item(ptr ${value})`);
  expect(work).not.toContain("@scr_union_release");
});

test("pure string helpers borrow the owned result of an immediate array read", async () => {
  const module = await lower(`
function size(text: string): number { return text.length + text.charCodeAt(0); }
function work(words: string[], index: number): number { return size(words[index]); }
console.log(work(["first"], 0));

// Keeps the optional element union a tagged box (Set elements are boxes),
// so owned union cleanup stays exercised; nullable pointers bypass it.
const keepBoxed = new Set<string | undefined>();
void keepBoxed;
`);
  const llvm = emitLlvmModule(module);
  const work = body(llvm, "sc_bf_work");
  const [value] = arrayReadValues(module, llvm, work);
  expect(work).toContain("@sc_bf_size");
  expect(work).not.toContain("@scr_str_retain_v");
  expect(work).not.toContain("@scr_str_release");
  expect(continuation(work, "sc_bf_size", "normal")).toContain(`@scr_union_release(ptr ${value})`);
});

test("string-producing helpers return an owner while borrowing their array input", async () => {
  const module = await lower(`
function trim(text: string): string { return text.trim(); }
function work(words: string[]): string { return trim(words[0]); }
console.log(work([" first "]));

// Keeps the optional element union a tagged box (Set elements are boxes),
// so owned union cleanup stays exercised; nullable pointers bypass it.
const keepBoxed = new Set<string | undefined>();
void keepBoxed;
`);
  const llvm = emitLlvmModule(module);
  const work = body(llvm, "sc_bf_work");
  const [value] = arrayReadValues(module, llvm, work);
  const normal = continuation(work, "sc_bf_trim", "normal");
  expect(normal).toContain(`@scr_union_release(ptr ${value})`);
  expect(normal).not.toContain("@scr_str_release");
  expect(normal).toMatch(/ret ptr %t\d+/);
  expect(work).not.toContain("@scr_str_retain_v");
  expect(body(llvm, "sc_bf_trim")).toContain("@scr_str_trim");
  expect(body(llvm, "sc_f_trim")).toContain("@scr_union_release");
});

test("string method arguments that mutate an array keep the earlier optional payload owned", async () => {
  const module = await lower(`
function prefix(text: string, start: string): boolean { return text.startsWith(start); }
function clear(words: string[]): string { words.length = 0; return "f"; }
function work(words: string[]): boolean { return prefix(words[0], clear(words)); }
console.log(work(["first"]));

// Keeps the optional element union a tagged box (Set elements are boxes),
// so owned union cleanup stays exercised; nullable pointers bypass it.
const keepBoxed = new Set<string | undefined>();
void keepBoxed;
`);
  const llvm = emitLlvmModule(module);
  const work = body(llvm, "sc_bf_work");
  const [value] = arrayReadValues(module, llvm, work);
  expect(work.indexOf(`${value} = call ptr`)).toBeLessThan(work.indexOf("@sc_bf_clear"));
  expect(work).toContain("@scr_str_release");
  expect(continuation(work, "sc_bf_clear", "unwind")).toContain(`@scr_union_release(ptr ${value})`);
  expect(continuation(work, "sc_bf_prefix", "normal")).toContain(
    `@scr_union_release(ptr ${value})`,
  );
});

test("whole-union string comparisons only project their operands", async () => {
  const module = await lower(`
function size(text: string): number { return text.length + (text === "" ? 1 : 0); }
function work(words: string[], index: number): number { return size(words[index]); }
console.log(work([""], 0));

// Keeps the optional element union a tagged box (Set elements are boxes),
// so owned union cleanup stays exercised; nullable pointers bypass it.
const keepBoxed = new Set<string | undefined>();
void keepBoxed;
`);
  const facts = analyzeCallLifetimes(new Map(module.functions.map((fn) => [fn.name, fn])));
  expect(facts.parameters.get("size")?.has(0)).toBe(true);
  const llvm = emitLlvmModule(module);
  const work = body(llvm, "sc_bf_work");
  const [value] = arrayReadValues(module, llvm, work);
  expect(work).not.toContain("@scr_union_new");
  expect(work).toContain("@sc_bf_size");
  expect(continuation(work, "sc_bf_size", "normal")).toContain(`@scr_union_release(ptr ${value})`);
});

test("class element comparisons, tests and optional chains release owned reads", async () => {
  const source = `
class Part { weight = 1; }
function same(parts: Part[], index: number, probe: Part): boolean { return parts[index] === probe; }
function missing(parts: Part[], index: number): boolean { return parts[index] === undefined; }
function weight(parts: Part[], index: number): number { return parts[index]?.weight ?? 0; }
function count(parts: Part[], probe: Part): number {
  let hits = 0;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part === probe) hits++;
  }
  return hits;
}
const parts = [new Part()];
console.log(same(parts, 0, parts[0]), missing(parts, 3), weight(parts, 2), count(parts, parts[0]));
`;
  // Exercise both tagged union cleanup and nullable payload cleanup.
  const boxedModule = await lower(`${source}
const keepBoxed = new Set<Part | undefined>();
void keepBoxed;
`);
  const nullableModule = await lower(source);
  const boxed = emitLlvmModule(boxedModule);
  const nullable = emitLlvmModule(nullableModule);
  for (const name of ["same", "missing", "weight", "count"]) {
    const work = body(boxed, `sc_bf_${name}`);
    const [value] = arrayReadValues(boxedModule, boxed, work);
    expect(work, name).not.toContain("@scr_union_new");
    // A nullable class element is the element pointer itself: no box at all.
    const plain = body(nullable, `sc_bf_${name}`);
    const [payload] = arrayReadValues(nullableModule, nullable, plain);
    expect(plain, name).not.toContain("%ScrUnion");
    expect(plain, name).not.toContain("@scr_union_new");
    for (const [code, input, release] of [
      [work, value, "scr_union_release"],
      [plain, payload, "sc_release_Part"],
    ] as const) {
      if (name === "count") {
        expect(code).toContain(`store ptr ${input}, ptr %sc_l_part_0`);
        const cleanup =
          /(%t\d+) = load ptr, ptr %sc_l_part_0\n\s+call void @(\w+)\(ptr \1\)\n\s+br label %loop\.u\d+/.exec(
            code,
          );
        expect(cleanup).not.toBeNull();
        expect(cleanup![2]).toBe(release);
      } else {
        const normal = code
          .split(/^\w[\w.]*:\n/m)
          .find((block) => /ret (?:i1|double) %t\d+/.test(block));
        expect(normal).toBeDefined();
        expect(normal).toContain(`@${release}(ptr ${input})`);
      }
    }
  }
});

test("an element read stored beyond its comparison keeps a heap union", async () => {
  const module = await lower(`
class Part { weight = 1; }
const kept: (Part | undefined)[] = [];
function keep(parts: Part[], index: number, probe: Part): boolean {
  const part = parts[index];
  kept.push(part);
  return part === probe;
}
console.log(keep([new Part()], 4, new Part()), kept.length);
`);
  const work = body(emitLlvmModule(module), "sc_bf_keep");
  expect(work).toMatch(/@scr_union_new|@sc_bf__x25_arr_idxOr/);
});
