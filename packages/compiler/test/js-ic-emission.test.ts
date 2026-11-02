import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { compile, deserializeModule, validateModule } from "../src/index.js";
import { emitLlvmModule } from "../src/backend/llvm/emitter.js";
import { moduleUsesDynTier } from "../src/ir/runtime-features.js";

/** The LLVM body of a function by source name. */
function body(llvm: string, name: string): string {
  const match = llvm.match(
    new RegExp(
      `define internal [^\\n]+ @sc_(?:b)?f_${name}(?:\\.i32)?\\([^\\n]*\\) #0 \\{([\\s\\S]*?)\\n\\}`,
    ),
  );
  expect(match, `${name} LLVM function`).not.toBeNull();
  return match![1]!;
}

test("dynamic-tier property sites read and write through inline caches", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-js-ic-"));
  try {
    const entry = join(dir, "main.js");
    const outPath = join(dir, "main.ir.json");
    await writeFile(
      entry,
      `
function dyn(v) { return v; }
function read(o) { return o.x; }
function write(o, v) { o.x = v; }
function bump(o) { o.n += 1; }
function at(a, i) { return a[i]; }
function call(o) { return o.m(); }
var o = dyn({ x: 1, n: 0, m: function () { return 2; } });
write(o, 3);
bump(o);
console.log(read(o), at(dyn([5, 6]), 1), call(o), o.n);
`,
    );
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const mod = deserializeModule(await readFile(outPath, "utf8"));
    expect(validateModule(mod)).toEqual([]);
    expect(moduleUsesDynTier(mod)).toBe(true);
    const llvm = emitLlvmModule(mod);
    // Each site owns a zeroed thread-local cache record.
    expect(llvm).toMatch(
      /@sc_js_ic_0 = internal (thread_local )?global \[21 x i64\] zeroinitializer/,
    );
    expect(body(llvm, "read")).toContain("@scr_js_get_probe(");
    expect(body(llvm, "write")).toContain("@scr_js_store_probe(");
    // Reads and writes test the first two entries inline: the second
    // starts 40 bytes into the record.
    for (const site of ["read", "write"])
      expect(body(llvm, site)).toMatch(/getelementptr inbounds i8, ptr @sc_js_ic_\d+, i64 40$/m);
    expect(body(llvm, "at")).toContain("@scr_js_keyed_probe(");
    expect(body(llvm, "call")).toContain("@scr_js_load_probe(");
    // A compound assignment stores its number result from the jsval: an
    // unshared number cell is updated in place.
    expect(body(llvm, "bump")).toMatch(/store double %t\d+, ptr %t\d+/);
    // The helper stays the out-of-line slow path of every site.
    expect(body(llvm, "read")).toMatch(
      /@sc_bf__x25_dyn_class_property_\d+\(ptr %t\d+\) noinline cold/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("object literal members with constant keys add through store caches", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-js-ic-literal-"));
  try {
    const entry = join(dir, "main.js");
    const outPath = join(dir, "main.ir.json");
    await writeFile(
      entry,
      `
function make(v, k) { return { a: v, b: 2, [k]: 3 }; }
var top = { t: 1 };
console.log(JSON.stringify(make(1, "c")), top.t);
`,
    );
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const mod = deserializeModule(await readFile(outPath, "utf8"));
    expect(moduleUsesDynTier(mod)).toBe(true);
    const llvm = emitLlvmModule(mod);
    const make = body(llvm, "make");
    // Each constant-key member tries its site's store cache first and
    // falls back to the generic member store; the computed key keeps the
    // generic store only.
    expect(make.match(/@scr_js_store_probe\(/g)).toHaveLength(2);
    expect(make.match(/@scr_dyn_key_set\(/g)).toHaveLength(2);
    expect(make).toContain("@scr_dyn_key_set_computed(");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("SCRIPTC_DEBUG_JS_IC_WAYS=0 sends every access through the probe", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-js-ic-ways-"));
  process.env["SCRIPTC_DEBUG_JS_IC_WAYS"] = "0";
  try {
    // The way count is a load-time constant, so the test compiles against a
    // fresh module graph in which the variable is set.
    vi.resetModules();
    const fresh = await import("../src/index.js");
    const { emitLlvmModule: emit } = await import("../src/backend/llvm/emitter.js");
    const entry = join(dir, "main.js");
    const outPath = join(dir, "main.ir.json");
    await writeFile(
      entry,
      `
function make(v, k) { return { a: v, b: 2, [k]: 3 }; }
function read(o) { return o.a; }
var top = { t: 1 };
read(top);
console.log(JSON.stringify(make(1, "c")), top.t);
`,
    );
    const result = await fresh.compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const mod = fresh.deserializeModule(await readFile(outPath, "utf8"));
    const llvm = emit(mod);
    const make = body(llvm, "make");
    // Literal members keep their own entry point, so an attribution profile
    // can tell them from other stores.
    expect(make.match(/@scr_js_literal_probe\(/g)).toHaveLength(2);
    expect(make).not.toContain("@scr_js_store_probe(");
    // Zero ways: no cache entry is tested inline, so the site branches to
    // the probe without loading an entry.
    expect(body(llvm, "read")).not.toMatch(
      /getelementptr inbounds i8, ptr @sc_js_ic_\d+, i64 \d+$/m,
    );
  } finally {
    delete process.env["SCRIPTC_DEBUG_JS_IC_WAYS"];
    vi.resetModules();
    await rm(dir, { recursive: true, force: true });
  }
});

test("property sites keep their caches in programs that declare classes and subclasses", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-js-ic-class-"));
  try {
    const entry = join(dir, "main.js");
    const outPath = join(dir, "main.ir.json");
    // Declared classes give every property helper class branches and
    // property-bag lookups, and a subclass adds a normalization step; plain
    // objects still read through the caches.
    await writeFile(
      entry,
      `
class Point {
  constructor(x) { this.x = x; }
}
class Tagged extends Point {
  constructor(x, tag) { super(x); this.tag = tag; }
}
function dyn(v) { return v; }
function read(o) { return o.x; }
function write(o, v) { o.x = v; }
function at(a, i) { return a[i]; }
var o = dyn({ x: 1 });
var p = dyn(new Point(4));
var t = dyn(new Tagged(6, "t"));
write(o, 3);
write(p, 5);
write(t, 7);
console.log(read(o), read(p), read(t), at(dyn([5, 6]), 1), at(p, "x"), at(t, "tag"));
`,
    );
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const mod = deserializeModule(await readFile(outPath, "utf8"));
    expect(validateModule(mod)).toEqual([]);
    const llvm = emitLlvmModule(mod);
    expect(body(llvm, "read")).toContain("@scr_js_get_probe(");
    expect(body(llvm, "write")).toContain("@scr_js_store_probe(");
    expect(body(llvm, "at")).toContain("@scr_js_keyed_probe(");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("property reads answer class instances' declared fields inline", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-js-ic-capsule-"));
  try {
    const entry = join(dir, "main.js");
    const outPath = join(dir, "main.ir.json");
    await writeFile(
      entry,
      `
class Point {
  constructor(x) { this.x = x; }
}
class Tagged extends Point {
  constructor(x, tag) { super(x); this.tag = tag; }
}
class Gauge {
  get x() { return 9; }
}
function dyn(v) { return v; }
function read(o) { return o.x; }
function tag(o) { return o.tag; }
var p = dyn(new Point(4));
var t = dyn(new Tagged(6, "t"));
console.log(read(p), read(t), read(dyn(new Gauge())), read({ x: 1 }), tag(t));
`,
    );
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const mod = deserializeModule(await readFile(outPath, "utf8"));
    expect(validateModule(mod)).toEqual([]);
    const llvm = emitLlvmModule(mod);
    const read = body(llvm, "read");
    // Point and Tagged instances load the field after one key compare
    // each; Gauge's getter, and every other receiver, keeps the probe and
    // the helper.
    expect(read.match(/^icc\.m\d+:/gm)).toHaveLength(2);
    expect(read).toContain("@scr_js_get_probe(");
    expect(read).toMatch(/@sc_b?f__x25_dyn_class_property_\d+\(ptr %t\d+\) noinline cold/);
    expect(body(llvm, "tag").match(/^icc\.m\d+:/gm)).toHaveLength(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("method calls on class instances call the method inline", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-js-ic-capsule-call-"));
  try {
    const entry = join(dir, "main.js");
    const outPath = join(dir, "main.ir.json");
    await writeFile(
      entry,
      `
class Cursor {
  constructor(x) { this.x = x; }
  step(d) { this.x += d; return this; }
  sum(k) { return this.x * k; }
}
class Marker extends Cursor {
  constructor(x, name) { super(x); this.name = name; }
}
class Fast extends Cursor {
  step(d) { this.x += d * 2; return this; }
}
class Shadowed {
  scale(k) { return k; }
}
function move(c) { return c.step(1); }
function total(c) { return c.sum(3); }
function scaled(c) { return c.scale(2); }
var list = [0, 1, 2].map((i) => (i === 0 ? new Cursor(1) : i === 1 ? new Marker(2, "m") : new Fast(3)));
var own = new Shadowed();
own.scale = function (k) { return -k; };
for (const c of list) console.log(move(c).x, total(c));
console.log(total({ sum: (k) => k + 1 }), scaled(own), scaled(new Shadowed()));
top: for (let i = 0; i < 2; i++) console.log(list[i].sum(i));
console.log(list[2].sum(5));
`,
    );
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const mod = deserializeModule(await readFile(outPath, "utf8"));
    expect(validateModule(mod)).toEqual([]);
    const llvm = emitLlvmModule(mod);
    const inline = (fn: string): number => fn.match(/^iccall\.m\d+:/gm)?.length ?? 0;
    // Fast overrides step, so the helper calls Cursor's step on Cursor and
    // Marker capsules through a virtual call, and only Fast capsules call
    // step inline. Every class answers sum with Cursor's, so all three
    // call it inline; every other receiver keeps the callback and the
    // helper.
    const move = body(llvm, "move");
    expect(inline(move)).toBe(1);
    expect(move).toContain("@sc_bf__x25_dyn_class_receiver_x3a_Fast_step(");
    expect(move).toMatch(/@sc_b?f__x25_dyn_class_callback_\d+\([^)]*\) noinline cold/);
    expect(move).toMatch(/@sc_b?f__x25_dyn_class_call_\d+\([^)]*\) noinline cold/);
    const total = body(llvm, "total");
    expect(inline(total)).toBe(3);
    expect(total).toMatch(/switch i32 %t\d+, label %iccall\.slow\d+ \[/);
    // Shadowed's instances may have an own scale, so its capsules keep the
    // callback, which reads it.
    expect(inline(body(llvm, "scaled"))).toBe(0);
    // A module initializer calls inline only inside its loops.
    expect(inline(body(llvm, "_x25_init_0"))).toBe(3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("typed programs have no cache sites and keep the ordinary runtime", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-js-ic-typed-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ir.json");
    await writeFile(
      entry,
      `
interface P { x: number; y: number }
function len2(p: P): number { return p.x * p.x + p.y * p.y; }
const parsed: unknown = JSON.parse('{"x":3,"y":4}');
console.log(len2({ x: 3, y: 4 }), typeof parsed);
`,
    );
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const mod = deserializeModule(await readFile(outPath, "utf8"));
    expect(moduleUsesDynTier(mod)).toBe(false);
    const llvm = emitLlvmModule(mod);
    expect(llvm).not.toContain("@sc_js_ic_");
    expect(llvm).not.toContain("@scr_js_");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("keyed and length sites read native number arrays in place", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-js-ic-native-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ir.json");
    await writeFile(join(dir, "package.json"), `{ "type": "module" }`);
    await writeFile(
      join(dir, "lib.cjs"),
      `exports.total = function (xs) {
  let s = 0;
  for (let i = 0; i < xs.length; i++) s += xs[i];
  return s;
};
`,
    );
    await writeFile(
      entry,
      `import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const lib: { total(xs: number[]): number } = require("./lib.cjs");
console.log(lib.total([1, 2, 3]));
`,
    );
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const llvm = emitLlvmModule(deserializeModule(await readFile(outPath, "utf8")));
    const fn = llvm.split("\ndefine ").find((f) => f.includes("ica.f64")) ?? "";
    // The keyed read tests the capsule's element kind and loads the double
    // in place; other receivers keep the probe.
    expect(fn).toMatch(/icmp eq i8 %t\d+, 0 ; SCR_ELEM_F64/);
    expect(fn).toMatch(/load double, ptr %t\d+/);
    expect(fn).toContain("@scr_js_keyed_probe(");
    // The length read answers from the native array's length.
    expect(fn).toContain("icg.rest");
    expect(fn).toContain("@scr_js_get_probe_native(");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a run of constant-key reads on one subject shares one guard", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-js-groups-"));
  try {
    const entry = join(dir, "main.js");
    const outPath = join(dir, "main.ir.json");
    await writeFile(
      entry,
      `
function dyn(v) { return v; }
function sum(o) { return o.a + o.b + o.c; }
console.log(sum(dyn(JSON.parse('{"a":1,"b":2,"c":3}'))), sum(dyn(JSON.parse('{"c":3,"b":2,"a":1}'))));
`,
    );
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const mod = deserializeModule(await readFile(outPath, "utf8"));
    expect(validateModule(mod)).toEqual([]);
    const llvm = emitLlvmModule(mod);
    // The group's record and its key list are private to the module: four
    // entries of a layout and a slot per key, and one pointer per key.
    expect(llvm).toMatch(
      /@sc_js_group_0 = internal (thread_local )?global \[9 x i64\] zeroinitializer/,
    );
    expect(llvm).toMatch(/@sc_gkeys_0 = internal constant \[3 x ptr\]/);
    const sum = body(llvm, "sum");
    // One layout probe answers all three members, so none of them keeps
    // its own read site.
    expect(sum.match(/@scr_js_group_probe\(/g)).toHaveLength(1);
    expect(sum).not.toContain("@scr_js_get_probe(");
    // The guard compares the subject's layout against the record's ways.
    expect(sum).toContain("load ptr, ptr @sc_js_group_0");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a store of an inert value replaces a parse-region object's slot inline", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-js-store-region-"));
  try {
    const entry = join(dir, "main.js");
    const outPath = join(dir, "main.ir.json");
    await writeFile(
      entry,
      `
function dyn(v) { return v; }
function bump(doc) { doc.meta.n = (doc.meta.n + 1) % 7; return doc.meta.n; }
function put(doc, v) { doc.meta.n = v; return doc.meta.n; }
var doc = dyn(JSON.parse('{"meta":{"n":1}}'));
console.log(bump(doc), put(doc, 5), JSON.stringify(doc));
`,
    );
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const mod = deserializeModule(await readFile(outPath, "utf8"));
    expect(validateModule(mod)).toEqual([]);
    const llvm = emitLlvmModule(mod);
    // A remainder is a number whatever its operands were, so the store's
    // value is an f64 the pass boxes on the spot: inert, and a store of an
    // inert value cannot clear the region's flag, so the site replaces the
    // slot inline. A value of unknown kind (the parameter of `put`) keeps
    // the region test that sends it to the probe.
    const regionTest = /getelementptr inbounds i8, ptr %\w+, i64 72$/m;
    expect(body(llvm, "bump")).not.toMatch(regionTest);
    expect(body(llvm, "put")).toMatch(regionTest);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
