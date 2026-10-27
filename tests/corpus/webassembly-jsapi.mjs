// The WebAssembly JavaScript API's constructors and reflection: new
// WebAssembly.Memory, Table and Global (descriptors, defaults, conversions
// and every error), using them as imports (limits, types and mutability
// checked with Node's LinkError messages), the identity of exported
// objects, WebAssembly.Module.imports, exports and customSections, and the
// classes called without new. The modules are inline base64 literals
// (their text is in tests/wasm-spec/corpus/jsapi.wat and jsapi-own.wat).
const jsapi = Buffer.from("AGFzbQEAAAABKglgAX8Bf2ABfwBgAAF/YAF8AXxgAX4AYAABb2ABbwBgAn9/AX9gAn9/AAJbBwNlbnYDbG9nAAEDZW52Bm1lbW9yeQIBAQQDZW52BXRhYmxlAXABAggDZW52B2NvdW50ZXIDfwEDZW52BXNjYWxlA3wAA2VudgNiaWcDfgEDZW52A3JlZgNvAQMPDgAAAgMEBQYHCAACAAIBB5UBEQRidW1wAAMGc2NhbGVkAAQGYmlnQWRkAAUGZ2V0UmVmAAYGc2V0UmVmAAcFYXBwbHkACAVzdG9yZQAJBGxvYWQACgRzaXplAAsEZ3JvdwAMCXRhYmxlU2l6ZQANA3NheQAOBm1lbW9yeQIABXRhYmxlAQAHY291bnRlcgMAC2Fsc29Db3VudGVyAwAGZG91YmxlAAEJCAEAQQALAgECCnAOBwAgAEECbAsHACAAIABsCwsAIwBBAWokACMACwcAIAAjAaILCQAjAiAAfCQCCwQAIwMLBgAgACQDCwkAIAEgABEAAAsJACAAIAE6AAALBwAgAC0AAAsEAD8ACwYAIABAAAsFAPwQAAsGACAAEAALAAwIZHlsaW5rLjABAgMACgRtZXRhaGVsbG8ACwhkeWxpbmsuMAQFAAEA", "base64");
const own = Buffer.from("AGFzbQEAAAABBgFgAX8BfwMCAQAEBQFwAQIIBQQBAQEEBhICfwFBBwt8AEQAAAAAAAD4PwsHKgcDbWVtAgAEbWVtMgIAA3RhYgEAAWcDAAJnMgMABWZpeGVkAwECaWQAAAkHAQBBAQsBAAoGAQQAIAAL", "base64");

const show = (v) => {
  if (typeof v === "bigint") return `${v}n`;
  if (typeof v === "number") return Object.is(v, -0) ? "-0" : String(v);
  if (typeof v === "function") return "function";
  if (Array.isArray(v)) return `[${v.map(show).join(", ")}]`;
  if (v instanceof WebAssembly.Memory) return "Memory";
  if (v instanceof WebAssembly.Table) return "Table";
  if (v instanceof WebAssembly.Global) return "Global";
  if (v instanceof ArrayBuffer) return `ArrayBuffer(${v.byteLength})`;
  if (v !== null && typeof v === "object") return JSON.stringify(v);
  return String(v);
};
const attempt = (label, f) => {
  try {
    console.log(label, show(f()));
  } catch (e) {
    console.log(label, e instanceof Error ? `${e.name}: ${e.message}` : `threw ${show(e)}`);
  }
};

// ── WebAssembly.Global ────────────────────────────────────────────────────
console.log("Global");
attempt("i32 default", () => new WebAssembly.Global({ value: "i32" }).value);
attempt("i64 default", () => new WebAssembly.Global({ value: "i64" }).value);
attempt("f32", () => new WebAssembly.Global({ value: "f32" }, 1.1).value);
attempt("f64", () => new WebAssembly.Global({ value: "f64" }, 1.1).value);
attempt("f64 undefined", () => new WebAssembly.Global({ value: "f64" }, undefined).value);
attempt("f64 null", () => new WebAssembly.Global({ value: "f64" }, null).value);
attempt("i32 string", () => new WebAssembly.Global({ value: "i32" }, "7").value);
attempt("i32 wraps", () => new WebAssembly.Global({ value: "i32" }, 2 ** 32 + 3).value);
attempt("i32 object", () => new WebAssembly.Global({ value: "i32" }, { valueOf: () => 9 }).value);
attempt("i64 bigint", () => new WebAssembly.Global({ value: "i64" }, 2n ** 63n).value);
attempt("i64 string", () => new WebAssembly.Global({ value: "i64" }, "12").value);
attempt("i64 number", () => new WebAssembly.Global({ value: "i64" }, 5).value);
attempt("i64 null", () => new WebAssembly.Global({ value: "i64" }, null).value);
attempt("i32 bigint", () => new WebAssembly.Global({ value: "i32" }, 5n).value);
attempt("externref default", () => new WebAssembly.Global({ value: "externref" }).value);
attempt("externref object", () => new WebAssembly.Global({ value: "externref" }, { a: 1 }).value);
attempt("anyfunc default", () => new WebAssembly.Global({ value: "anyfunc" }).value);
attempt("anyfunc arrow", () => new WebAssembly.Global({ value: "anyfunc" }, () => 1));
attempt("anyfunc number", () => new WebAssembly.Global({ value: "anyfunc" }, 1));
attempt("funcref name", () => new WebAssembly.Global({ value: "funcref" }));
attempt("v128", () => new WebAssembly.Global({ value: "v128" }));
attempt("bad type", () => new WebAssembly.Global({ value: "i16" }));
attempt("no value", () => new WebAssembly.Global({}));
attempt("no descriptor", () => new WebAssembly.Global());
attempt("number descriptor", () => new WebAssembly.Global(1));
attempt("toString type", () => new WebAssembly.Global({ value: { toString: () => "f64" } }, 2.5).value);
const order = [];
new WebAssembly.Global(
  {
    get value() {
      order.push("value");
      return { toString: () => (order.push("value toString"), "f64") };
    },
    get mutable() {
      order.push("mutable");
      return false;
    },
  },
  { valueOf: () => (order.push("valueOf"), 1) },
);
console.log("order", order.join(","));
const immutable = new WebAssembly.Global({ value: "i32" }, 4);
attempt("immutable set", () => {
  immutable.value = 5;
});
console.log("immutable after", immutable.value, immutable.valueOf());
const mutable = new WebAssembly.Global({ value: "i32", mutable: 1 }, 4);
mutable.value = 2.9;
console.log("mutable", mutable.value, mutable.valueOf());
mutable.value = "x";
console.log("mutable NaN", mutable.value);
const mutable64 = new WebAssembly.Global({ value: "i64", mutable: true });
mutable64.value = true;
console.log("mutable64", show(mutable64.value));
attempt("i64 set number", () => {
  mutable64.value = 3;
});
const mutableF32 = new WebAssembly.Global({ value: "f32", mutable: true }, 1);
mutableF32.value = undefined;
console.log("f32 set undefined", mutableF32.value);
const mutableRef = new WebAssembly.Global({ value: "externref", mutable: true }, "start");
mutableRef.value = undefined;
console.log("externref set undefined", mutableRef.value);
const mutableFunc = new WebAssembly.Global({ value: "anyfunc", mutable: true });
attempt("anyfunc set arrow", () => {
  mutableFunc.value = () => 2;
});
console.log(String(immutable), Object.prototype.toString.call(immutable), immutable instanceof WebAssembly.Global);
console.log(immutable);
// @ts-ignore: called without new, as Node reports
attempt("Global()", () => WebAssembly.Global({ value: "i32" }));

// ── WebAssembly.Memory ────────────────────────────────────────────────────
console.log("Memory");
attempt("bytes", () => new WebAssembly.Memory({ initial: 1 }).buffer.byteLength);
attempt("zero", () => new WebAssembly.Memory({ initial: 0 }).buffer.byteLength);
attempt("string initial", () => new WebAssembly.Memory({ initial: "2" }).buffer.byteLength);
attempt("fractional", () => new WebAssembly.Memory({ initial: 1.9 }).buffer.byteLength);
attempt("null initial", () => new WebAssembly.Memory({ initial: null }).buffer.byteLength);
attempt("missing", () => new WebAssembly.Memory({}));
attempt("minimum only", () => new WebAssembly.Memory({ minimum: 1 }));
attempt("undefined initial", () => new WebAssembly.Memory({ initial: undefined }));
attempt("negative", () => new WebAssembly.Memory({ initial: -1 }));
attempt("negative fraction", () => new WebAssembly.Memory({ initial: -0.5 }));
attempt("NaN", () => new WebAssembly.Memory({ initial: NaN }));
attempt("Infinity", () => new WebAssembly.Memory({ initial: Infinity }));
attempt("2^32", () => new WebAssembly.Memory({ initial: 2 ** 32 }));
attempt("too many pages", () => new WebAssembly.Memory({ initial: 65537 }));
attempt("max below initial", () => new WebAssembly.Memory({ initial: 20, maximum: 1 }));
attempt("max too large", () => new WebAssembly.Memory({ initial: 1, maximum: 65537 }));
attempt("max 2^32", () => new WebAssembly.Memory({ initial: 1, maximum: 2 ** 32 }));
attempt("max null", () => new WebAssembly.Memory({ initial: 1, maximum: null }));
attempt("bigint initial", () => new WebAssembly.Memory({ initial: 1n }));
attempt("throwing initial", () =>
  new WebAssembly.Memory({
    initial: {
      valueOf() {
        throw new Error("boom");
      },
    },
  }),
);
attempt("shared without maximum", () => new WebAssembly.Memory({ initial: 1, shared: true }));
attempt("no descriptor", () => new WebAssembly.Memory());
attempt("string descriptor", () => new WebAssembly.Memory("x"));
const memoryOrder = [];
new WebAssembly.Memory({
  get initial() {
    memoryOrder.push("initial");
    return { valueOf: () => (memoryOrder.push("initial valueOf"), 1) };
  },
  get maximum() {
    memoryOrder.push("maximum");
    return { valueOf: () => (memoryOrder.push("maximum valueOf"), 3) };
  },
  get shared() {
    memoryOrder.push("shared");
    return false;
  },
});
console.log("order", memoryOrder.join(","));
const grown = new WebAssembly.Memory({ initial: 1, maximum: 2 });
const before = grown.buffer;
new Uint8Array(before)[5] = 7;
console.log("same buffer", grown.buffer === grown.buffer);
attempt("grow", () => grown.grow(1));
console.log("after grow", grown.buffer.byteLength, new Uint8Array(grown.buffer)[5], before === grown.buffer);
attempt("grow past maximum", () => grown.grow(1));
attempt("grow negative", () => grown.grow(-1));
attempt("grow missing", () => grown.grow());
attempt("grow NaN", () => grown.grow(NaN));
attempt("grow 2^32", () => grown.grow(2 ** 32));
attempt("grow zero", () => grown.grow(0));
attempt("unbounded grow", () => new WebAssembly.Memory({ initial: 1, maximum: undefined }).grow(3));
console.log(String(grown), grown instanceof WebAssembly.Memory);
console.log(grown);
// @ts-ignore: called without new, as Node reports
attempt("Memory()", () => WebAssembly.Memory({ initial: 1 }));

// ── WebAssembly.Table ─────────────────────────────────────────────────────
console.log("Table");
attempt("anyfunc", () => new WebAssembly.Table({ initial: 2, element: "anyfunc" }).get(1));
attempt("externref", () => new WebAssembly.Table({ initial: 1, element: "externref" }).get(0));
attempt("externref init", () => new WebAssembly.Table({ initial: 2, element: "externref" }, "hi").get(1));
attempt("externref undefined", () => new WebAssembly.Table({ initial: 2, element: "externref" }, undefined).get(1));
attempt("anyfunc null", () => new WebAssembly.Table({ initial: 2, element: "anyfunc" }, null).get(1));
attempt("anyfunc arrow", () => new WebAssembly.Table({ initial: 2, element: "anyfunc" }, () => 1));
attempt("anyfunc number", () => new WebAssembly.Table({ initial: 2, element: "anyfunc" }, 5));
attempt("funcref name", () => new WebAssembly.Table({ initial: 1, element: "funcref" }));
attempt("i32 element", () => new WebAssembly.Table({ initial: 1, element: "i32" }));
attempt("no element", () => new WebAssembly.Table({ initial: 1 }));
attempt("no initial", () => new WebAssembly.Table({ element: "anyfunc" }));
// @ts-ignore: an incomplete descriptor
attempt("empty", () => new WebAssembly.Table({}));
attempt("no descriptor", () => new WebAssembly.Table());
attempt("max below initial", () => new WebAssembly.Table({ initial: 2, maximum: 1, element: "anyfunc" }));
attempt("bad init and descriptor", () => new WebAssembly.Table({ initial: 3, maximum: 2, element: "anyfunc" }, 37));
attempt("too large", () => new WebAssembly.Table({ initial: 10000001, element: "anyfunc" }));
attempt("large maximum", () => new WebAssembly.Table({ initial: 1, maximum: 10000001, element: "anyfunc" }).length);
attempt("max 2^32", () => new WebAssembly.Table({ initial: 1, maximum: 2 ** 32, element: "anyfunc" }));
attempt("toString element", () => new WebAssembly.Table({ element: { toString: () => "anyfunc" }, initial: 1 }).length);
const tableOrder = [];
new WebAssembly.Table({
  get element() {
    tableOrder.push("element");
    return { toString: () => (tableOrder.push("element toString"), "anyfunc") };
  },
  get initial() {
    tableOrder.push("initial");
    return { valueOf: () => (tableOrder.push("initial valueOf"), 1) };
  },
  get maximum() {
    tableOrder.push("maximum");
    return { valueOf: () => (tableOrder.push("maximum valueOf"), 3) };
  },
});
console.log("order", tableOrder.join(","));
const refs = new WebAssembly.Table({ initial: 1, maximum: 4, element: "externref" }, 3);
attempt("set default", () => {
  refs.set(0);
  return refs.get(0);
});
attempt("grow default", () => [refs.grow(1), refs.get(1), refs.length]);
attempt("grow value", () => [refs.grow(1, "z"), refs.get(2), refs.length]);
attempt("grow past maximum", () => refs.grow(2));
attempt("get negative", () => refs.get(-1));
attempt("get missing", () => refs.get());
attempt("get out of range", () => refs.get(5));
attempt("set out of range", () => refs.set(9, 1));
const funcs = new WebAssembly.Table({ initial: 1, element: "anyfunc" });
attempt("set arrow", () => funcs.set(0, () => 1));
attempt("set number", () => funcs.set(0, 7));
attempt("grow arrow", () => funcs.grow(1, () => 1));
attempt("grow negative", () => funcs.grow(-1));
console.log(String(funcs), funcs instanceof WebAssembly.Table);
console.log(funcs);
// @ts-ignore: called without new, as Node reports
attempt("Table()", () => WebAssembly.Table({ initial: 1, element: "anyfunc" }));

// ── WebAssembly.Module's static functions ────────────────────────────────
console.log("Module");
const module = new WebAssembly.Module(jsapi);
console.log(JSON.stringify(WebAssembly.Module.imports(module)));
console.log(JSON.stringify(WebAssembly.Module.exports(module)));
const firstImport = WebAssembly.Module.imports(module)[0];
console.log(Object.keys(firstImport).join(","), Array.isArray(WebAssembly.Module.imports(module)));
firstImport.module = "changed";
console.log("fresh", WebAssembly.Module.imports(module)[0].module);
const dylink = WebAssembly.Module.customSections(module, "dylink.0");
console.log(
  "dylink.0",
  dylink.length,
  dylink.map((b) => `${show(b)} ${[...new Uint8Array(b)].join(" ")}`).join(" | "),
);
console.log("meta", new TextDecoder().decode(WebAssembly.Module.customSections(module, "meta")[0]));
console.log("empty name", WebAssembly.Module.customSections(module, "").length);
console.log("missing", WebAssembly.Module.customSections(module, "nope").length);
console.log("toString", WebAssembly.Module.customSections(module, { toString: () => "meta" }).length);
console.log("null", WebAssembly.Module.customSections(module, null).length);
const copy = WebAssembly.Module.customSections(module, "meta")[0];
new Uint8Array(copy)[0] = 0;
console.log(
  "copies",
  new Uint8Array(WebAssembly.Module.customSections(module, "meta")[0])[0],
  copy === WebAssembly.Module.customSections(module, "meta")[0],
);
attempt("customSections missing name", () => WebAssembly.Module.customSections(module));
attempt("customSections symbol", () => WebAssembly.Module.customSections(module, Symbol("x")));
attempt("customSections number", () => WebAssembly.Module.customSections(1, "x"));
attempt("imports object", () => WebAssembly.Module.imports({}));
attempt("exports missing", () => WebAssembly.Module.exports());
attempt("imports stray", () => WebAssembly.Module.imports(module, 1).length);
console.log("own", JSON.stringify(WebAssembly.Module.imports(new WebAssembly.Module(own))));
console.log("own", JSON.stringify(WebAssembly.Module.exports(new WebAssembly.Module(own))));
// @ts-ignore: called without new, as Node reports
attempt("Module()", () => WebAssembly.Module(jsapi));
// @ts-ignore: called without new, as Node reports
attempt("Instance()", () => WebAssembly.Instance(module, {}));

// ── constructed objects as imports ────────────────────────────────────────
console.log("imports");
const logged = [];
const memory = new WebAssembly.Memory({ initial: 1, maximum: 4 });
const table = new WebAssembly.Table({ initial: 2, maximum: 8, element: "anyfunc" });
const counter = new WebAssembly.Global({ value: "i32", mutable: true }, 10);
const big = new WebAssembly.Global({ value: "i64", mutable: true }, 1n);
const ref = new WebAssembly.Global({ value: "externref", mutable: true }, "first");
const env = { log: (v) => logged.push(v), memory, table, counter, scale: 2.5, big, ref };
const instance = new WebAssembly.Instance(module, { env });
const x = instance.exports;
console.log(
  "identity",
  x.memory === memory,
  x.table === table,
  x.counter === counter,
  x.alsoCounter === counter,
);
attempt("bump", () => [x.bump(), x.bump(), counter.value]);
counter.value = 100;
attempt("bump after set", () => x.bump());
attempt("scaled", () => x.scaled(4));
x.bigAdd(41n);
console.log("big", show(big.value));
attempt("getRef", () => x.getRef());
x.setRef({ hello: "world" });
console.log("ref", JSON.stringify(ref.value));
ref.value = 42;
attempt("getRef after set", () => x.getRef());
attempt("apply double", () => x.apply(0, 21));
attempt("apply square", () => x.apply(1, 12));
console.log("table get", table.get(0) === x.double);
// A function the module does not export, reached through the table.
const square = table.get(1);
console.log("unexported", square(5), square === table.get(1), square.name, square.length, typeof square);
x.store(3, 99);
console.log("memory", new Uint8Array(memory.buffer)[3], x.load(3));
new Uint8Array(memory.buffer)[4] = 55;
console.log("memory from js", x.load(4));
attempt("grow in wasm", () => [x.grow(1), x.size(), memory.buffer.byteLength]);
attempt("grow from js", () => [memory.grow(1), x.size(), memory.buffer.byteLength]);
attempt("table grow", () => [table.grow(2), x.tableSize(), table.length]);
const global = new WebAssembly.Global({ value: "anyfunc", mutable: true }, x.double);
console.log("funcref global", global.value === x.double);
global.value = null;
console.log("funcref null", global.value);
table.set(1, x.double);
attempt("apply after set", () => x.apply(1, 8));
x.say(5);
console.log("logged", logged.join(","));

// Another instance's exports as imports, and the same objects again.
const provider = new WebAssembly.Instance(new WebAssembly.Module(own)).exports;
console.log("own identity", provider.mem === provider.mem2, provider.g === provider.g2, provider.mem instanceof WebAssembly.Memory);
const second = new WebAssembly.Instance(module, {
  env: { ...env, memory: provider.mem, table: provider.tab, counter: provider.g },
}).exports;
console.log("re-exported", second.memory === provider.mem, second.table === provider.tab, second.counter === provider.g);
attempt("bump provider global", () => [second.bump(), provider.g.value]);
attempt("apply provider table", () => second.apply(1, 3));

// ── link errors ───────────────────────────────────────────────────────────
console.log("link errors");
const link = (label, overrides) =>
  attempt(label, () => new WebAssembly.Instance(module, { env: { ...env, ...overrides } }) && "linked");
link("memory too small", { memory: new WebAssembly.Memory({ initial: 0, maximum: 4 }) });
link("memory without maximum", { memory: new WebAssembly.Memory({ initial: 1 }) });
link("memory maximum too large", { memory: new WebAssembly.Memory({ initial: 1, maximum: 5 }) });
link("memory larger initial", { memory: new WebAssembly.Memory({ initial: 3, maximum: 4 }) });
link("memory number", { memory: 5 });
link("table too small", { table: new WebAssembly.Table({ initial: 1, maximum: 8, element: "anyfunc" }) });
link("table without maximum", { table: new WebAssembly.Table({ initial: 2, element: "anyfunc" }) });
link("table maximum too large", { table: new WebAssembly.Table({ initial: 2, maximum: 12, element: "anyfunc" }) });
link("table externref", { table: new WebAssembly.Table({ initial: 2, maximum: 8, element: "externref" }) });
link("table small externref", { table: new WebAssembly.Table({ initial: 1, maximum: 8, element: "externref" }) });
link("table number", { table: 3 });
link("global immutable", { counter: new WebAssembly.Global({ value: "i32" }, 1) });
link("global type", { counter: new WebAssembly.Global({ value: "i64", mutable: true }, 1n) });
link("global both", { counter: new WebAssembly.Global({ value: "f64" }, 1) });
link("global number", { counter: 1 });
link("immutable global object", { scale: new WebAssembly.Global({ value: "f64" }, 4) });
link("immutable global mutable", { scale: new WebAssembly.Global({ value: "f64", mutable: true }, 4) });
link("immutable global bigint", { scale: 4n });
link("i64 number", { big: 4 });
link("externref anything", { ref: new WebAssembly.Global({ value: "externref", mutable: true }, null) });
