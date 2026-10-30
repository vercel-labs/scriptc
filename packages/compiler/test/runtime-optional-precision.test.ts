import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule, validateModule } from "../src/index.js";
import { analyzeCallLifetimes } from "../src/backend/llvm/call-lifetimes.js";
import { emitLlvmModule } from "../src/backend/llvm/emitter.js";
import { type IrModule, type IrType } from "../src/ir/ir.js";

async function lower(source: string): Promise<IrModule> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-optional-precision-"));
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

/** `name(param, ...): result` with union arms spelled out. */
function signature(module: IrModule, name: string): string {
  const fn = module.functions.find((candidate) => candidate.name === name);
  expect(fn, name).toBeDefined();
  const unions = new Map((module.unions ?? []).map((union) => [union.id, union]));
  const spell = (type: IrType): string =>
    type.kind === "object"
      ? type.className
      : type.kind === "union"
        ? unions.get(type.unionId)!.arms.map(spell).join("|")
        : type.kind === "undefinedT"
          ? "undefined"
          : type.kind;
  return `${name}(${fn!.params.map((param) => spell(param.type)).join(", ")}): ${spell(fn!.returnType)}`;
}

/** The emitted body of a function, under its body or entry symbol. */
function body(llvm: string, name: string): string {
  const find = (symbol: string): RegExpExecArray | null =>
    new RegExp(`^define internal [^\\n]*@${symbol}(?:\\.i32)?\\([^]*?^}`, "m").exec(llvm);
  const found = find(`sc_bf_${name}`) ?? find(`sc_f_${name}`);
  expect(found, name).not.toBeNull();
  return found![0];
}

/** Follow the call's immediate exception edge, including a worker's slow poll. */
function exceptionSuccessor(emitted: string, callEnd: number): string {
  const parts = emitted.split(/^([\w.]+):\n/m);
  const blocks = new Map<string, string>();
  for (let i = 1; i < parts.length; i += 2) blocks.set(parts[i]!, parts[i + 1]!);
  const continuation = emitted.slice(callEnd).split(/^[\w.]+:\n/m, 1)[0]!;
  const branch = /br i1 [^,\n]+, label %(exc\.[\w.]+), label %exc\.[\w.]+/.exec(continuation);
  expect(branch).not.toBeNull();
  let exceptional = blocks.get(branch![1]!)!;
  expect(exceptional).toBeDefined();
  if (branch![1]!.startsWith("exc.s")) {
    const unwind = /br i1 [^,\n]+, label %(exc\.u[\w.]*),/.exec(exceptional);
    expect(unwind).not.toBeNull();
    exceptional = blocks.get(unwind![1]!)!;
    expect(exceptional).toBeDefined();
  }
  return exceptional;
}

const ITEM = `class Item {
  weight: number;
  constructor(weight: number) {
    this.weight = weight;
  }
}
function weigh(item: Item): number {
  return item.weight;
}
`;

test("callbacks over arrays that never hold undefined keep annotated parameters", async () => {
  const module = await lower(`${ITEM}
function check(item: Item): Item {
  weigh(item);
  return item;
}
const items: Item[] = [new Item(2)];
items.push(new Item(3));
console.log(items.map((item) => check(item)).length, items.some((item) => weigh(item) > 2));
console.log(items.filter(check).length);
`);
  expect(signature(module, "weigh")).toBe("weigh(Item): f64");
  expect(signature(module, "check")).toBe("check(Item): Item");
});

test("an undefined store, a hole for the find family, or a spread of holes widens the callee", async () => {
  const stored = await lower(`${ITEM}
const empty: Item[] = [];
const items: Item[] = [new Item(1)];
items.push(empty[4]);
console.log(items.map((item) => weigh(item)).join(","));
`);
  expect(signature(stored, "weigh")).toBe("weigh(Item|undefined): f64");
  const holes = await lower(`${ITEM}
const items: Item[] = [new Item(1)];
items[3] = new Item(2);
console.log(items.findIndex((item) => weigh(item) > 1));
`);
  expect(signature(holes, "weigh")).toBe("weigh(Item|undefined): f64");
  const spread = await lower(`${ITEM}
const items: Item[] = [new Item(1)];
items.length = 3;
const copy = [...items];
console.log(copy.map((item) => weigh(item)).join(","));
`);
  expect(signature(spread, "weigh")).toBe("weigh(Item|undefined): f64");
});

test("holes that only their owning slot can observe stay out of callbacks", async () => {
  const module = await lower(`${ITEM}
class Cache {
  private readonly slots: Item[];
  constructor(size: number) {
    this.slots = new Array<Item>(size);
  }
  get(index: number): Item {
    if (Object.hasOwn(this.slots, index)) return this.slots[index]!;
    const item = new Item(index);
    this.slots[index] = item;
    return item;
  }
}
const cache = new Cache(4);
const picked = [cache.get(2), cache.get(1)];
console.log(picked.find((item) => weigh(item) === 1)?.weight);
`);
  expect(signature(module, "weigh")).toBe("weigh(Item): f64");
});

test("a dominating guard keeps an unchecked read from widening its callee", async () => {
  const module = await lower(`${ITEM}
const items: Item[] = [new Item(1)];
function first(index: number): number {
  const item = items[index];
  if (item === undefined) return -1;
  return weigh(item);
}
function either(index: number): boolean {
  const item = items[index];
  return item !== undefined && weigh(item) > 0;
}
console.log(first(0), first(3), either(0), either(5));
`);
  expect(signature(module, "weigh")).toBe("weigh(Item): f64");
});

test("a rebound binding keeps its widening after a guard", async () => {
  const module = await lower(`${ITEM}
const items: Item[] = [new Item(1)];
function later(index: number): number {
  let item = items[index];
  if (item === undefined) return -1;
  item = items[index + 1];
  return weigh(item);
}
console.log(later(0));
`);
  expect(signature(module, "weigh")).toBe("weigh(Item|undefined): f64");
});

test("an unchanged captured parameter is borrowed and boxed only where a closure is built", async () => {
  const module = await lower(`${ITEM}
function heavier(item: Item, limits: number[]): boolean {
  if (limits.length === 0) return false;
  return limits.some((limit) => weigh(item) > limit);
}
function replaced(item: Item, other: Item): number {
  const read = () => item.weight;
  item = other;
  return read();
}
console.log(heavier(new Item(3), []), heavier(new Item(3), [1]), replaced(new Item(1), new Item(2)));
`);
  const facts = analyzeCallLifetimes(new Map(module.functions.map((fn) => [fn.name, fn])));
  expect(facts.borrowed.get("heavier")?.has(0)).toBe(true);
  expect(facts.borrowed.get("replaced")?.has(0) ?? false).toBe(false);
  const heavier = body(emitLlvmModule(module), "heavier");
  expect(heavier.slice(0, heavier.indexOf("scr_closure_new"))).not.toContain("@scr_box_new");
  // A path that built no environment skips the box release.
  expect(heavier).toMatch(/icmp ne ptr %t\d+, null\n\s+br i1 %t\d+, label %lazy\.release/);
});

test("removals use the runtime owner and box nothing when their result is unused", async () => {
  const module = await lower(`
class Circle { radius = 1; }
class Square { side = 2; }
const shapes: (Circle | Square)[] = [new Circle(), new Square()];
const counts: number[] = [1, 2, 3];
function drop(): number {
  shapes.pop();
  counts.pop();
  shapes.shift();
  void counts.shift();
  counts.pop(), counts.length;
  for (counts.pop(); counts.length > 0; counts.shift()) {}
  return shapes.length + counts.length;
}
function take(): Circle | Square | undefined {
  return shapes.pop();
}
function takeFirst(): Circle | Square | undefined {
  return shapes.shift();
}
console.log(drop(), take(), takeFirst(), shapes.length);
`);
  const llvm = emitLlvmModule(module);
  const drop = body(llvm, "drop");
  expect(drop).not.toContain("@scr_union_new");
  expect(drop).not.toContain("@scr_arr_splice");
  expect(drop).not.toContain("@scr_arr_set_len");
  expect(drop).toMatch(/call zeroext i8 @scr_arr_pop_state\(ptr %\w+, ptr null\)/);
  expect(drop).toMatch(/call zeroext i8 @scr_arr_shift_state\(ptr %\w+, ptr null\)/);
  expect(body(llvm, "take")).not.toContain("@scr_arr_splice");
  expect(body(llvm, "takeFirst")).not.toContain("@scr_arr_splice");
  expect(body(llvm, "take")).toContain("@scr_arr_pop_state");
  expect(body(llvm, "takeFirst")).toContain("@scr_arr_shift_state");
});

test.each(["pop", "shift"])(
  "%s owns a removed reference before worker cancellation polls",
  async (method) => {
    const module = await lower(`
function takeText(values: string[]): string | undefined { return values.${method}(); }
console.log(takeText(["value"]));
`);
    module.workers = true;
    const take = body(emitLlvmModule(module), "takeText");
    const call = take.indexOf(`@scr_arr_${method}_state`);
    const branch = take.indexOf("remove.p", call);
    expect(call).toBeGreaterThanOrEqual(0);
    expect(branch).toBeGreaterThan(call);
    // Termination can arrive after the runtime returns a successful +1.
    // Its unwind must release that value before ordinary result boxing.
    expect(take.slice(call, branch)).toContain("@scr_str_release");
  },
);

test("returned and discarded splice unwind at the runtime mutation boundary", async () => {
  const module = await lower(`
function discard(values: string[], replacement: string): number {
  values.splice(0, 2, replacement);
  return values.length;
}
function discardOptional(values: string[], source: string[]): number {
  values.splice(0, 2, source[4]);
  return values.length;
}
function take(values: string[]): string[] { return values.splice(0, 1); }
function replace(values: string[], items: string[]): string[] {
  return values.splice(0, 1, ...items);
}
console.log(discard(["a", "b"], "x"), discardOptional(["c", "d"], []),
  take(["e"]).length, replace(["f"], ["g"]).length);
`);
  module.workers = true;
  const llvm = emitLlvmModule(module);
  for (const name of ["discard", "discardOptional", "take", "replace"]) {
    const emitted = body(llvm, name);
    const calls = [
      ...emitted.matchAll(
        /(?:(%\w+) = )?call (?:ptr|void) @scr_arr_splice(?:_insert|_drop)?\([^\n]+/g,
      ),
    ];
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      const exceptional = exceptionSuccessor(emitted, call.index! + call[0].length);
      if (call[1]) {
        // A worker may be cancelled after splice successfully returns +1.
        expect(exceptional).toContain("@scr_arr_release(ptr " + call[1] + ")");
      }
    }
  }
});

test.each([false, true])(
  "primitive sort unwinds after runtime refusal (workers=%s)",
  async (workers) => {
    const module = await lower(`
function discard(values: string[]): number { values.sort(); return values.length; }
function take(values: number[]): number[] { return values.sort(); }
console.log(discard(["b", "a"]), take([2, 1]).join(","));
`);
    module.workers = workers;
    const llvm = emitLlvmModule(module);
    for (const name of ["discard", "take"]) {
      const emitted = body(llvm, name);
      const call = /(%\w+) = call ptr @scr_arr_sort_primitive\([^\n]+/.exec(emitted);
      expect(call).not.toBeNull();
      const exceptional = exceptionSuccessor(emitted, call!.index + call![0].length);
      // Cancellation can follow a successful +1 return, so unwinding owns it.
      expect(exceptional).toContain("@scr_arr_release(ptr " + call![1] + ")");
    }
  },
);

test.each([false, true])(
  "rejected array stores release their evaluated RHS (workers=%s)",
  async (workers) => {
    const module = await lower(`
function write(values: string[], suffix: string): void { values[0] = "replace" + suffix; }
write(["old"], " value");
`);
    module.workers = workers;
    const emitted = body(emitLlvmModule(module), "write");
    const value = /(%\w+) = call ptr @scr_str_concat\([^\n]+/.exec(emitted);
    const guard = /call zeroext i1 @scr_arr_check_set\([^\n]+/.exec(emitted);
    expect(value).not.toBeNull();
    expect(guard).not.toBeNull();
    expect(guard!.index).toBeGreaterThan(value!.index);
    const exceptional = exceptionSuccessor(emitted, guard!.index + guard![0].length);
    expect(exceptional).toContain("@scr_str_release(ptr " + value![1] + ")");
  },
);

test.each(["push", "unshift"] as const)(
  "%s submits one complete mutation and propagates its refusal",
  async (method) => {
    const counts = [0, 1, 2, 64, 65];
    const functions = counts
      .map(
        (count) =>
          `function insert${count}(values: string[]): number {
        return values.${method}(${Array.from({ length: count }, (_, i) => JSON.stringify(String(i))).join(",")});
      }`,
      )
      .join("\n");
    const calls = counts.map((count) => `insert${count}(["old"])`).join(",");
    const module = await lower(`
${functions}
function optional(values: string[], source: string[]): number {
  return values.${method}(source[4]);
}
console.log(${calls}, optional(["old"], []));
`);
    const llvm = emitLlvmModule(module);
    for (const count of counts) {
      const emitted = body(llvm, "insert" + count);
      const helper = "scr_arr_" + method + (count <= 64 ? "_many" : "_spread");
      const calls = [...emitted.matchAll(new RegExp("call double @" + helper + "\\([^\\n]+", "g"))];
      expect(calls).toHaveLength(1);
      if (count <= 64) {
        expect(calls[0]![0]).toContain(", i64 " + count + ", ptr ");
        expect(emitted).not.toContain("arr.push.dense");
      }
      const after = emitted.slice(calls[0]!.index! + calls[0]![0].length);
      const continuation = after.split(/^[\w.]+:\n/m, 1)[0]!;
      expect(continuation).toMatch(/br i1 [^\n]+label %exc\./);
      expect(emitted).not.toContain("alloca [65 x i64]");
    }
    const optional = body(llvm, "optional");
    expect(optional).toContain("@scr_arr_" + method + "_spread");
  },
);

test.each(["push", "unshift"] as const)(
  "%s releases large owned argument lists on argument failure and worker cancellation",
  async (method) => {
    const args = Array.from({ length: 64 }, (_, i) => `item(${i})`).join(",");
    const module = await lower(`
function item(index: number): string { return "item" + index; }
function lastArgument(fail: boolean): string {
  if (fail) throw new Error("last argument");
  return item(64);
}
function insert(values: string[], fail: boolean): number {
  return values.${method}(${args}, lastArgument(fail));
}
console.log(insert(["old"], false));
try { insert(["old"], true); } catch { console.log("caught"); }
`);
    module.workers = true;
    const emitted = body(emitLlvmModule(module), "insert");
    const carriers = [...emitted.matchAll(/(%\w+) = call ptr @scr_arr_new(?:_small)?\([^\n]+/g)];
    expect(carriers).toHaveLength(1);
    const carrier = carriers[0]![1]!;
    const last = /call ptr @sc_(?:bf|f)_lastArgument(?:\.i32)?\([^\n]+/.exec(emitted);
    expect(last).not.toBeNull();
    const spreads = [
      ...emitted.matchAll(new RegExp("call double @scr_arr_" + method + "_spread\\([^\\n]+", "g")),
    ];
    expect(spreads).toHaveLength(1);
    expect(spreads[0]![0]).toContain(", ptr " + carrier + ")");
    expect(last!.index).toBeGreaterThan(carriers[0]!.index!);
    expect(spreads[0]!.index).toBeGreaterThan(last!.index);
    // The first 64 allocated strings belong to the carrier before arg 65.
    // A successful borrowed spread still leaves that owner in the frame.
    for (const call of [last!, spreads[0]!]) {
      const exceptional = exceptionSuccessor(emitted, call.index! + call[0].length);
      expect(exceptional).toContain("@scr_arr_release(ptr " + carrier + ")");
    }
  },
);

test.each([false, true])(
  "live indexed Get preserves pending exceptions (workers=%s)",
  async (workers) => {
    const source = await readFile(
      join(import.meta.dirname, "../../../tests/corpus/native-array-prototype-access.ts"),
      "utf8",
    );
    const module = await lower(source);
    module.workers = workers;
    const llvm = emitLlvmModule(module);
    const helper = /^define internal ptr @sc_dyn_key_get\([^]*?^}/m.exec(llvm)?.[0];
    expect(helper).toBeDefined();
    const parts = helper!.split(/^([\w.]+):\n/m);
    const blocks = new Map<string, string>();
    for (let i = 1; i < parts.length; i += 2) blocks.set(parts[i]!, parts[i + 1]!);
    for (const callee of ["scr_dyn_typed_ref_key_get", "scr_dyn_typed_ref_materialize"]) {
      const call = new RegExp(`(%\\w+) = call ptr @${callee}\\([^\\n]+`).exec(helper!);
      expect(call, callee).not.toBeNull();
      const following = helper!.slice(call!.index + call![0].length).split(/^[\w.]+:\n/m, 1)[0]!;
      const branch = /br i1 [^,\n]+, label %([\w.]+), label %([\w.]+)/.exec(following);
      expect(branch, callee).not.toBeNull();
      expect(following).toContain(workers ? "@scr_exc_pending()" : "@scr_exc_active");
      const failure = blocks.get(branch![1]!)!;
      expect(failure).toContain("ret ptr null");
      expect(failure).not.toContain("@sc_dyn_key_get");
      expect(failure).not.toContain("@scr_dyn_typed_ref_materialize");
      expect(failure).toContain(`@scr_dyn_release_v(ptr ${call![1]})`);
    }
  },
);

test("stream union reference arms retain their live operation bindings", async () => {
  const source = await readFile(
    join(import.meta.dirname, "../../../tests/corpus/native-stream-union-array-ownership.ts"),
    "utf8",
  );
  const module = await lower(source);
  const llvm = emitLlvmModule(module);
  const adapters = [...llvm.matchAll(/^define internal ptr @sc_sfa_\d+\([^]*?^}/gm)];
  expect(adapters).toHaveLength(1);
  const definitions = new Map(
    [...llvm.matchAll(/^define internal [^\n]*@([\w.]+)\([^]*?^}/gm)].map((match) => [
      match[1]!,
      match[0],
    ]),
  );
  const reachable = new Set<string>();
  const pending = [adapters[0]![0]];
  while (pending.length > 0) {
    const body = pending.pop()!;
    if (reachable.has(body)) continue;
    reachable.add(body);
    for (const call of body.matchAll(/@([\w.]+)\(/g)) {
      const callee = definitions.get(call[1]!);
      if (callee !== undefined) pending.push(callee);
    }
  }
  const bindings = [...reachable].join("\n");
  expect(bindings).toContain("@scr_dyn_typed_ref_bind_record");
  const arrayBinders = [...reachable].filter((body) =>
    body.includes("@scr_dyn_typed_ref_bind_array"),
  );
  expect(arrayBinders.length).toBeGreaterThan(0);
  for (const body of arrayBinders) {
    const bound = /(%\w+) = call zeroext i1 @scr_dyn_typed_ref_bind_array\(ptr (%\w+),/.exec(body);
    expect(bound).not.toBeNull();
    const branch = new RegExp(
      String.raw`br i1 ${bound![1]}, label %([\w.]+), label %([\w.]+)`,
    ).exec(body);
    expect(branch).not.toBeNull();
    const failure = body.slice(body.indexOf("\n" + branch![2] + ":\n")).split(/^[\w.]+:\n/m)[1]!;
    expect(failure).toContain(`@scr_dyn_release_v(ptr ${bound![2]})`);
    expect(body).toContain(`[ null, %${branch![2]} ]`);
  }
  expect(llvm).not.toContain("materialize stream union arm");
});

test("asserted values forward undefined only where no proof shows them present", async () => {
  const proven = await lower(`${ITEM}
const items: Item[] = [new Item(1), new Item(2)];
let total = 0;
for (let i = 0; i < items.length; i++) total += weigh(items[i]!);
function guarded(item: Item | undefined): number {
  if (item === undefined) return 0;
  return weigh(item!);
}
console.log(total, guarded(items[0]), guarded(undefined));
`);
  expect(signature(proven, "weigh")).toBe("weigh(Item): f64");
  const unproven = await lower(`${ITEM}
const items: Item[] = [new Item(1)];
function describe(item: Item): string {
  return item === undefined ? "none" : String(item.weight);
}
console.log(describe(items[4]!));
`);
  expect(signature(unproven, "describe")).toBe("describe(Item|undefined): string");
});
