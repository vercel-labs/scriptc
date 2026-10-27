// A port of web-platform-tests wasm/jsapi tests for the parts W5 adds:
// global/constructor, global/value-get-set, global/valueOf,
// memory/constructor, memory/grow, table/constructor, table/get-set,
// table/grow, module/imports, module/exports and module/customSections
// (WPT, 3-Clause BSD). Each test keeps its WPT name and body, with these
// changes: modules that WasmModuleBuilder builds at run time are inline
// base64 literals (built by the same builder), a minimal testharness prints
// one line per test, and the assertions the port cannot express are left
// out: the classes as values (prototypes, function name and length,
// property descriptors, branding through Function.prototype.call),
// Symbol arguments, Object.isFrozen and Object.isExtensible of
// ArrayBuffers (general scriptc gaps), and the old buffer's detachment
// after Memory.grow (a documented difference). assert_Global's parameter carries a JSDoc type:
// scriptc answers a Global's valueOf() only on receivers typed as one.
const modules = {
  empty: "AGFzbQEAAAA=",
  imports: "AGFzbQEAAAABBAFgAAACRAQGbW9kdWxlAmZuAAAGbW9kdWxlBmdsb2JhbAN/AAZtb2R1bGUGbWVtb3J5AgEAgAEGbW9kdWxlBXRhYmxlAXABAIAB",
  importsEmptyModule: "AGFzbQEAAAABBAFgAAACLAQAAmZuAAAABmdsb2JhbAN/AAAGbWVtb3J5AgEAgAEABXRhYmxlAXABAIAB",
  importsEmptyNames: "AGFzbQEAAAABBAFgAAACHQQBYQAAAAFiAAN/AAFjAAIBAIABAWQAAXABAIAB",
  importsEmptyBoth: "AGFzbQEAAAABBAFgAAACGQQAAAAAAAADfwAAAAIBAIABAAABcAEAgAE=",
  exports: "AGFzbQEAAAABBwJgAABgAAADAwIAAQQEAXAAAQUFAQEAgAIGEgJ/AUEHC3wBRDMzMzMzM/M/CwcwBgJmbgAAA2ZuMgABBXRhYmxlAQAGZ2xvYmFsAwAHZ2xvYmFsMgMBBm1lbW9yeQIACgcCAgALAgALABEEbmFtZQEKAgACZm4BA2ZuMg==",
  exportsEmptyFunction: "AGFzbQEAAAABBAFgAAADAgEABwQBAAAACgQBAgALAAoEbmFtZQEDAQAA",
  exportsEmptyTable: "AGFzbQEAAAAEBAFwAAEHBAEAAQA=",
  exportsEmptyGlobal: "AGFzbQEAAAAGBgF/AUEHCwcEAQADAA==",
  custom: "AGFzbQEAAAAAEARuYW1lV2ViQXNzZW1ibHkACgRuYW1lSlNBUEkADwNmb29XZWJBc3NlbWJseQ==",
  customSurrogates: "AGFzbQEAAAAAFgp5ZWXwkJC3ZWV5V2ViQXNzZW1ibHk=",
  customReplacement: "AGFzbQEAAAAAEwduYe+/vW1lV2ViQXNzZW1ibHk=",
  customCopy: "AGFzbQEAAAAACARjb3B5ESIz",
  fn: "AGFzbQEAAAABBAFgAAADAgEABwYBAmZuAAAKBAECAAsADARuYW1lAQUBAAJmbg==",
  functions: "AGFzbQEAAAABCAJgAXwAYAAAAwMCAAEHDAICZm4AAANmbjIAAQoHAgIACwIACwARBG5hbWUBCgIAAmZuAQNmbjI=",
};
const binary = (name) => Buffer.from(modules[name], "base64");

// ── a minimal testharness ─────────────────────────────────────────────────
class AssertionError extends Error {}
function fail(message) {
  throw new AssertionError(message);
}
function same(a, b) {
  return a === b ? a !== 0 || 1 / a === 1 / b : a !== a && b !== b;
}
function format_value(v) {
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "bigint") return `${v}n`;
  if (typeof v === "number") return same(v, -0) ? "-0" : String(v);
  if (typeof v === "boolean") return String(v);
  if (v === null) return "null";
  if (v === undefined) return "undefined";
  return typeof v;
}
function assert_equals(actual, expected, description = "") {
  if (!same(actual, expected)) fail(`${description} expected ${format_value(expected)} but got ${format_value(actual)}`);
}
function assert_not_equals(actual, expected, description = "") {
  if (same(actual, expected)) fail(`${description} got disallowed value ${format_value(actual)}`);
}
function assert_true(actual, description = "") {
  if (actual !== true) fail(`${description} expected true got ${format_value(actual)}`);
}
function assert_false(actual, description = "") {
  if (actual !== false) fail(`${description} expected false got ${format_value(actual)}`);
}
function assert_array_equals(actual, expected, description = "") {
  if (actual.length !== expected.length) fail(`${description} lengths differ, expected ${expected.length} got ${actual.length}`);
  for (let i = 0; i < expected.length; i++) {
    if (!same(actual[i], expected[i])) fail(`${description} property ${i}, expected ${format_value(expected[i])} but got ${format_value(actual[i])}`);
  }
}
function assert_throws_js(name, func, description = "") {
  try {
    func();
  } catch (e) {
    if (e instanceof AssertionError) throw e;
    if (!(e instanceof Error) || e.name !== name) fail(`${description} threw ${e instanceof Error ? e.name : format_value(e)}, expected ${name}`);
    return;
  }
  fail(`${description} did not throw`);
}
let passed = 0;
let failed = 0;
function test(func, name) {
  try {
    func();
    passed++;
    console.log(`PASS ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}: ${e instanceof Error ? e.message : format_value(e)}`);
  }
}

// ── global/constructor.any.js ─────────────────────────────────────────────
/** @param {WebAssembly.Global} actual (typed so that valueOf() reaches the Global) */
function assert_Global(actual, expected) {
  assert_equals(actual.value, expected, "value");
  assert_equals(actual.valueOf(), expected, "valueOf");
}

test(() => {
  // @ts-ignore: no descriptor
  assert_throws_js("TypeError", () => new WebAssembly.Global());
}, "No arguments");

test(() => {
  const argument = { value: "i32" };
  // @ts-ignore: called without new
  assert_throws_js("TypeError", () => WebAssembly.Global(argument));
}, "Calling");

test(() => {
  const order = [];
  new WebAssembly.Global(
    {
      get value() {
        order.push("descriptor value");
        return {
          toString() {
            order.push("descriptor value toString");
            return "f64";
          },
        };
      },
      get mutable() {
        order.push("descriptor mutable");
        return false;
      },
    },
    {
      valueOf() {
        order.push("value valueOf()");
      },
    },
  );
  assert_array_equals(order, ["descriptor mutable", "descriptor value", "descriptor value toString", "value valueOf()"]);
}, "Order of evaluation");

test(() => {
  const invalidArguments = [undefined, null, false, true, "", "test", 1, NaN, {}];
  for (const invalidArgument of invalidArguments) {
    // @ts-ignore: an invalid descriptor
    assert_throws_js("TypeError", () => new WebAssembly.Global(invalidArgument), `new Global(${format_value(invalidArgument)})`);
  }
}, "Invalid descriptor argument");

test(() => {
  const invalidTypes = ["i16", "i128", "f16", "f128", "u32", "u64", "i32\0"];
  for (const value of invalidTypes) {
    const argument = { value };
    // @ts-ignore: an invalid type
    assert_throws_js("TypeError", () => new WebAssembly.Global(argument));
  }
}, "Invalid type argument");

test(() => {
  const argument = { value: "v128" };
  // @ts-ignore: v128
  assert_throws_js("TypeError", () => new WebAssembly.Global(argument));
}, "Construct v128 global");

test(() => {
  const argument = { value: "i64" };
  const global = new WebAssembly.Global(argument);
  assert_Global(global, 0n);
}, "i64 with default");

for (const type of ["i32", "f32", "f64"]) {
  test(() => {
    const argument = { value: type };
    const global = new WebAssembly.Global(argument);
    assert_Global(global, 0);
  }, `Default value for type ${type}`);

  const valueArguments = [
    { value: undefined, expected: 0, name: "undefined" },
    { value: null, expected: 0, name: "null" },
    { value: true, expected: 1, name: "true" },
    { value: false, expected: 0, name: "false" },
    { value: 2, expected: 2, name: "2" },
    { value: "3", expected: 3, name: '"3"' },
    { value: { toString() { return "5"; } }, expected: 5, name: "object with toString returning string" },
    { value: { valueOf() { return "8"; } }, expected: 8, name: "object with valueOf returning string" },
    { value: { toString() { return 6; } }, expected: 6, name: "object with toString returning number" },
    { value: { valueOf() { return 9; } }, expected: 9, name: "object with valueOf returning number" },
  ];
  for (const { value, expected, name } of valueArguments) {
    test(() => {
      const argument = { value: type };
      const global = new WebAssembly.Global(argument, value);
      assert_Global(global, expected);
    }, `Explicit value ${name} for type ${type}`);
  }

  test(() => {
    const argument = { value: type };
    assert_throws_js("TypeError", () => new WebAssembly.Global(argument, 0n));
  }, `BigInt value for type ${type}`);
}

const bigintArguments = [
  { value: undefined, expected: 0n, name: "undefined" },
  { value: true, expected: 1n, name: "true" },
  { value: false, expected: 0n, name: "false" },
  { value: "3", expected: 3n, name: '"3"' },
  { value: 123n, expected: 123n, name: "123n" },
  { value: { toString() { return "5"; } }, expected: 5n, name: "object with toString returning string" },
  { value: { valueOf() { return "8"; } }, expected: 8n, name: "object with valueOf returning string" },
  { value: { toString() { return 6n; } }, expected: 6n, name: "object with toString returning bigint" },
  { value: { valueOf() { return 9n; } }, expected: 9n, name: "object with valueOf returning bigint" },
];
for (const { value, expected, name } of bigintArguments) {
  test(() => {
    const argument = { value: "i64" };
    const global = new WebAssembly.Global(argument, value);
    assert_Global(global, expected);
  }, `Explicit value ${name} for type i64`);
}

const invalidBigints = [
  { value: null, name: "null" },
  { value: 666, name: "666" },
  { value: { toString() { return 5; } }, name: "object" },
  { value: { valueOf() { return 8; } }, name: "object" },
];
for (const { value: invalidBigint, name } of invalidBigints) {
  test(() => {
    const argument = { value: "i64" };
    assert_throws_js("TypeError", () => new WebAssembly.Global(argument, invalidBigint));
  }, `Pass non-bigint as i64 Global value: ${name}`);
}

test(() => {
  const argument = { value: "i32" };
  const global = new WebAssembly.Global(argument, 0, {});
  assert_Global(global, 0);
}, "Stray argument");

// ── global/value-get-set.any.js and global/valueOf.any.js ────────────────
for (const type of ["i32", "i64", "f32", "f64"]) {
  const [initial, value, invalid] = type === "i64" ? [0n, 1n, 2] : [0, 1, 2n];
  const immutableOptions = [
    { opts: {}, name: "missing" },
    { opts: { mutable: undefined }, name: "undefined" },
    { opts: { mutable: null }, name: "null" },
    { opts: { mutable: false }, name: "false" },
    { opts: { mutable: "" }, name: "empty string" },
    { opts: { mutable: 0 }, name: "zero" },
  ];
  for (const { opts, name } of immutableOptions) {
    test(() => {
      const global = new WebAssembly.Global({ ...opts, value: type });
      assert_equals(global.value, initial, "initial value");
      assert_equals(global.valueOf(), initial, "initial valueOf");
      assert_throws_js("TypeError", () => {
        global.value = value;
      });
      assert_equals(global.value, initial, "post-set value");
      assert_equals(global.valueOf(), initial, "post-set valueOf");
    }, `Immutable ${type} (${name})`);

    test(() => {
      const global = new WebAssembly.Global({ ...opts, value: type });
      let touched = false;
      const value = {
        valueOf() {
          touched = true;
          return 1;
        },
        toString() {
          touched = true;
          return "1";
        },
      };
      assert_throws_js("TypeError", () => {
        global.value = value;
      });
      assert_false(touched, "should not call valueOf or toString");
      assert_equals(global.value, initial, "post-set value");
      assert_equals(global.valueOf(), initial, "post-set valueOf");
    }, `Immutable ${type} with ToNumber side-effects (${name})`);
  }

  const mutableOptions = [
    { opts: { mutable: true }, name: "true" },
    { opts: { mutable: 1 }, name: "one" },
    { opts: { mutable: "x" }, name: "string" },
  ];
  for (const { opts, name } of mutableOptions) {
    test(() => {
      const global = new WebAssembly.Global({ ...opts, value: type });
      assert_equals(global.value, initial, "initial value");
      assert_equals(global.valueOf(), initial, "initial valueOf");
      global.value = value;
      assert_throws_js("TypeError", () => {
        global.value = invalid;
      });
      assert_equals(global.value, value, "post-set value");
      assert_equals(global.valueOf(), value, "post-set valueOf");
    }, `Mutable ${type} (${name})`);
  }
}

test(() => {
  const argument = { value: "i64", mutable: true };
  const global = new WebAssembly.Global(argument);
  assert_equals(global.value, 0n, "initial value using ToJSValue");
  const valid = [
    { input: 123n, output: 123n },
    { input: 2n ** 63n, output: -(2n ** 63n) },
    { input: true, output: 1n },
    { input: false, output: 0n },
    { input: "456", output: 456n },
  ];
  for (const { input, output } of valid) {
    global.value = input;
    assert_equals(global.valueOf(), output, "post-set valueOf");
  }
  const invalid = [undefined, null, 0, 1, 4.2];
  for (const input of invalid) {
    assert_throws_js("TypeError", () => {
      global.value = input;
    });
  }
}, "i64 mutability");

test(() => {
  const argument = { value: "i32" };
  const global = new WebAssembly.Global(argument, 0);
  assert_equals(global.valueOf({}), 0);
}, "valueOf: Stray argument");

// ── memory/constructor.any.js ─────────────────────────────────────────────
function assert_ArrayBuffer(actual, { size = 0 }, message) {
  assert_equals(actual.toString(), "[object ArrayBuffer]", `${message}: toString()`);
  assert_equals(actual.byteLength, 0x10000 * size, `${message}: size`);
  if (size > 0) {
    const array = new Uint8Array(actual);
    assert_equals(array[0], 0, `${message}: first element`);
    assert_equals(array[array.byteLength - 1], 0, `${message}: last element`);
  }
}

function assert_Memory(memory, { size = 0 }) {
  assert_equals(memory.buffer, memory.buffer, "buffer should be idempotent");
  assert_ArrayBuffer(memory.buffer, { size });
}

test(() => {
  // @ts-ignore: no descriptor
  assert_throws_js("TypeError", () => new WebAssembly.Memory());
}, "Memory: No arguments");

test(() => {
  const argument = { initial: 0 };
  // @ts-ignore: called without new
  assert_throws_js("TypeError", () => WebAssembly.Memory(argument));
}, "Memory: Calling");

test(() => {
  const invalidArguments = [undefined, null, false, true, "", "test", 1, NaN, {}];
  for (const invalidArgument of invalidArguments) {
    // @ts-ignore: an invalid descriptor
    assert_throws_js("TypeError", () => new WebAssembly.Memory(invalidArgument), `new Memory(${format_value(invalidArgument)})`);
  }
}, "Memory: Invalid descriptor argument");

test(() => {
  assert_throws_js("TypeError", () => new WebAssembly.Memory({ initial: undefined }));
}, "Undefined initial value in descriptor");

const outOfRangeValues = [NaN, Infinity, -Infinity, -1, 0x100000000, 0x1000000000];
for (const value of outOfRangeValues) {
  test(() => {
    assert_throws_js("TypeError", () => new WebAssembly.Memory({ initial: value }));
  }, `Memory: Out-of-range initial value in descriptor: ${format_value(value)}`);

  test(() => {
    assert_throws_js("TypeError", () => new WebAssembly.Memory({ initial: 0, maximum: value }));
  }, `Memory: Out-of-range maximum value in descriptor: ${format_value(value)}`);
}

test(() => {
  assert_throws_js("RangeError", () => new WebAssembly.Memory({ initial: 10, maximum: 9 }));
}, "Memory: Initial value exceeds maximum");

test(() => {
  const order = [];
  new WebAssembly.Memory({
    get maximum() {
      order.push("maximum");
      return {
        valueOf() {
          order.push("maximum valueOf");
          return 1;
        },
      };
    },
    get initial() {
      order.push("initial");
      return {
        valueOf() {
          order.push("initial valueOf");
          return 1;
        },
      };
    },
  });
  assert_array_equals(order, ["initial", "initial valueOf", "maximum", "maximum valueOf"]);
}, "Memory: Order of evaluation for descriptor");

test(() => {
  const argument = { initial: 0 };
  const memory = new WebAssembly.Memory(argument);
  assert_Memory(memory, { size: 0 });
}, "Zero initial");

test(() => {
  const argument = { initial: 4 };
  const memory = new WebAssembly.Memory(argument);
  assert_Memory(memory, { size: 4 });
}, "Non-zero initial");

test(() => {
  const argument = { initial: 0 };
  const memory = new WebAssembly.Memory(argument, {});
  assert_Memory(memory, { size: 0 });
}, "Memory: Stray argument");

// ── memory/grow.any.js ────────────────────────────────────────────────────
test(() => {
  const argument = { initial: 0 };
  const memory = new WebAssembly.Memory(argument);
  // @ts-ignore: no delta
  assert_throws_js("TypeError", () => memory.grow());
}, "grow: Missing arguments");

for (const { initial, delta, label } of [
  { initial: 0, delta: 2, label: "Zero initial" },
  { initial: { valueOf() { return 0; } }, delta: { valueOf() { return 2; } }, label: "Zero initial with valueOf" },
  { initial: 3, delta: 2, label: "Non-zero initial" },
]) {
  test(() => {
    const memory = new WebAssembly.Memory({ initial });
    const before = Number(initial);
    const oldMemory = memory.buffer;
    assert_ArrayBuffer(oldMemory, { size: before }, "Buffer before growing");
    const result = memory.grow(delta);
    assert_equals(result, before);
    const newMemory = memory.buffer;
    assert_not_equals(oldMemory, newMemory);
    assert_ArrayBuffer(newMemory, { size: before + 2 }, "New buffer after growing");
  }, `grow: ${label}`);
}

test(() => {
  const argument = { initial: 0, maximum: 2 };
  const memory = new WebAssembly.Memory(argument);
  const result = memory.grow(2);
  assert_equals(result, 0);
  assert_ArrayBuffer(memory.buffer, { size: 2 }, "New buffer after growing");
}, "grow: Zero initial with respected maximum");

test(() => {
  const argument = { initial: 0, maximum: 2 };
  const memory = new WebAssembly.Memory(argument);
  assert_equals(memory.grow(1), 0);
  assert_equals(memory.grow(1), 1);
  assert_ArrayBuffer(memory.buffer, { size: 2 }, "Buffer after growing twice");
}, "grow: Zero initial with respected maximum grown twice");

test(() => {
  const argument = { initial: 1, maximum: 2 };
  const memory = new WebAssembly.Memory(argument);
  const oldMemory = memory.buffer;
  assert_throws_js("RangeError", () => memory.grow(2));
  assert_equals(memory.buffer, oldMemory);
  assert_ArrayBuffer(memory.buffer, { size: 1 }, "Buffer after trying to grow");
}, "grow: Zero initial growing too much");

const outOfRangeDeltas = [undefined, NaN, Infinity, -Infinity, -1, 0x100000000, 0x1000000000];
for (const value of outOfRangeDeltas) {
  test(() => {
    const argument = { initial: 0 };
    const memory = new WebAssembly.Memory(argument);
    assert_throws_js("TypeError", () => memory.grow(value));
  }, `grow: Out-of-range argument: ${format_value(value)}`);
}

test(() => {
  const argument = { initial: 0 };
  const memory = new WebAssembly.Memory(argument);
  const result = memory.grow(2, {});
  assert_equals(result, 0);
}, "grow: Stray argument");

// ── table/constructor.any.js ──────────────────────────────────────────────
function assert_equal_to_array(table, expected, message = "") {
  assert_equals(table.length, expected.length, `${message}: length`);
  assert_throws_js("TypeError", () => table.get(-1), `${message}: table.get(-1)`);
  for (let i = 0; i < expected.length; ++i) {
    assert_equals(table.get(i), expected[i], `${message}: table.get(${i} of ${expected.length})`);
  }
  assert_throws_js("RangeError", () => table.get(expected.length), `${message}: table.get(${expected.length} of ${expected.length})`);
  assert_throws_js("RangeError", () => table.get(expected.length + 1), `${message}: table.get(${expected.length + 1} of ${expected.length})`);
}

function assert_Table(actual, expected) {
  assert_equals(actual.length, expected.length, "length");
  for (let i = 0; i < expected.length; ++i) {
    assert_equals(actual.get(i), null, `actual.get(${i})`);
  }
}

test(() => {
  // @ts-ignore: no descriptor
  assert_throws_js("TypeError", () => new WebAssembly.Table());
}, "Table: No arguments");

test(() => {
  const argument = { element: "anyfunc", initial: 0 };
  // @ts-ignore: called without new
  assert_throws_js("TypeError", () => WebAssembly.Table(argument));
}, "Table: Calling");

test(() => {
  // @ts-ignore: an empty descriptor
  assert_throws_js("TypeError", () => new WebAssembly.Table({}));
}, "Empty descriptor");

test(() => {
  const invalidArguments = [undefined, null, false, true, "", "test", 1, NaN, {}];
  for (const invalidArgument of invalidArguments) {
    // @ts-ignore: an invalid descriptor
    assert_throws_js("TypeError", () => new WebAssembly.Table(invalidArgument), `new Table(${format_value(invalidArgument)})`);
  }
}, "Table: Invalid descriptor argument");

test(() => {
  assert_throws_js("TypeError", () => new WebAssembly.Table({ element: "anyfunc", initial: undefined }));
}, "Table: Undefined initial value in descriptor");

test(() => {
  // @ts-ignore: an undefined element
  assert_throws_js("TypeError", () => new WebAssembly.Table({ element: undefined, initial: 0 }));
}, "Undefined element value in descriptor");

for (const value of outOfRangeValues) {
  test(() => {
    assert_throws_js("TypeError", () => new WebAssembly.Table({ element: "anyfunc", initial: value }));
  }, `Table: Out-of-range initial value in descriptor: ${format_value(value)}`);

  test(() => {
    assert_throws_js("TypeError", () => new WebAssembly.Table({ element: "anyfunc", initial: 0, maximum: value }));
  }, `Table: Out-of-range maximum value in descriptor: ${format_value(value)}`);
}

test(() => {
  assert_throws_js("RangeError", () => new WebAssembly.Table({ element: "anyfunc", initial: 10, maximum: 9 }));
}, "Table: Initial value exceeds maximum");

test(() => {
  const argument = { element: "anyfunc", initial: 0 };
  const table = new WebAssembly.Table(argument);
  assert_Table(table, { length: 0 });
}, "Basic (zero)");

test(() => {
  const argument = { element: "anyfunc", initial: 5 };
  const table = new WebAssembly.Table(argument);
  assert_Table(table, { length: 5 });
}, "Basic (non-zero)");

test(() => {
  const argument = { element: "anyfunc", initial: 0 };
  const table = new WebAssembly.Table(argument, null, {});
  assert_Table(table, { length: 0 });
}, "Table: Stray argument");

test(() => {
  const table = new WebAssembly.Table({
    // @ts-ignore: an object element
    element: {
      toString() {
        return "anyfunc";
      },
    },
    initial: 1,
  });
  assert_Table(table, { length: 1 });
}, "Type conversion for descriptor.element");

test(() => {
  const order = [];
  new WebAssembly.Table({
    get maximum() {
      order.push("maximum");
      return {
        valueOf() {
          order.push("maximum valueOf");
          return 1;
        },
      };
    },
    get initial() {
      order.push("initial");
      return {
        valueOf() {
          order.push("initial valueOf");
          return 1;
        },
      };
    },
    get element() {
      order.push("element");
      return {
        toString() {
          order.push("element toString");
          return "anyfunc";
        },
      };
    },
  });
  assert_array_equals(order, ["element", "element toString", "initial", "initial valueOf", "maximum", "maximum valueOf"]);
}, "Table: Order of evaluation for descriptor");

test(() => {
  const testObject = {};
  const argument = { element: "externref", initial: 3 };
  const table = new WebAssembly.Table(argument, testObject);
  assert_equals(table.length, 3);
  assert_equals(table.get(0), testObject);
  assert_equals(table.get(1), testObject);
  assert_equals(table.get(2), testObject);
}, "initialize externref table with default value");

test(() => {
  const argument = { element: "i32", initial: 3 };
  // @ts-ignore: an invalid element
  assert_throws_js("TypeError", () => new WebAssembly.Table(argument));
}, "initialize table with a wrong element value");

test(() => {
  const fn = new WebAssembly.Instance(new WebAssembly.Module(binary("fn"))).exports.fn;
  const argument = { element: "anyfunc", initial: 3 };
  const table = new WebAssembly.Table(argument, fn);
  assert_equals(table.length, 3);
  assert_equals(table.get(0), fn);
  assert_equals(table.get(1), fn);
  assert_equals(table.get(2), fn);
}, "initialize anyfunc table with default value");

test(() => {
  const argument = { element: "anyfunc", initial: 3 };
  assert_throws_js("TypeError", () => new WebAssembly.Table(argument, {}));
  assert_throws_js("TypeError", () => new WebAssembly.Table(argument, "cannot be used as a wasm function"));
  assert_throws_js("TypeError", () => new WebAssembly.Table(argument, 37));
}, "initialize anyfunc table with a bad default value");

test(() => {
  assert_throws_js("RangeError", () => new WebAssembly.Table({ element: "anyfunc", initial: 3, maximum: 2 }, 37));
}, "initialize anyfunc table with a bad default value and a bad descriptor");

// ── table/get-set.any.js ──────────────────────────────────────────────────
const functions = new WebAssembly.Instance(new WebAssembly.Module(binary("functions")), {}).exports;

test(() => {
  const argument = { element: "anyfunc", initial: 5 };
  const table = new WebAssembly.Table(argument);
  // @ts-ignore: no index
  assert_throws_js("TypeError", () => table.get());
}, "Missing arguments: get");

test(() => {
  const argument = { element: "anyfunc", initial: 5 };
  const table = new WebAssembly.Table(argument);
  // @ts-ignore: no index
  assert_throws_js("TypeError", () => table.set());
}, "Missing arguments: set");

test(() => {
  const argument = { element: "anyfunc", initial: 5 };
  const table = new WebAssembly.Table(argument);
  assert_equal_to_array(table, [null, null, null, null, null]);
  const { fn, fn2 } = functions;
  assert_equals(table.set(0, fn), undefined, "set() returns undefined.");
  table.set(2, fn2);
  table.set(4, fn);
  assert_equal_to_array(table, [fn, null, fn2, null, fn]);
  table.set(0, null);
  assert_equal_to_array(table, [null, null, fn2, null, fn]);
}, "Basic");

test(() => {
  const argument = { element: "anyfunc", initial: 5 };
  const table = new WebAssembly.Table(argument);
  assert_equal_to_array(table, [null, null, null, null, null]);
  const { fn, fn2 } = functions;
  table.set(0, fn);
  table.set(2, fn2);
  table.set(4, fn);
  assert_equal_to_array(table, [fn, null, fn2, null, fn]);
  table.grow(4);
  assert_equal_to_array(table, [fn, null, fn2, null, fn, null, null, null, null]);
}, "Growing");

test(() => {
  const argument = { element: "anyfunc", initial: 5 };
  const table = new WebAssembly.Table(argument);
  assert_equal_to_array(table, [null, null, null, null, null]);
  const { fn } = functions;
  assert_throws_js("TypeError", () => table.set(-1, fn));
  assert_throws_js("RangeError", () => table.set(5, fn));
  assert_equal_to_array(table, [null, null, null, null, null]);
}, "Setting out-of-bounds");

test(() => {
  const argument = { element: "anyfunc", initial: 1 };
  const table = new WebAssembly.Table(argument);
  assert_equal_to_array(table, [null]);
  const invalidArguments = [undefined, true, false, "test", 7, NaN, {}];
  for (const argument of invalidArguments) {
    assert_throws_js("TypeError", () => table.set(0, argument), `set(${format_value(argument)})`);
  }
  assert_equal_to_array(table, [null]);
}, "Setting non-function");

test(() => {
  const argument = { element: "anyfunc", initial: 1 };
  const table = new WebAssembly.Table(argument);
  assert_equal_to_array(table, [null]);
  const fn = function () {};
  assert_throws_js("TypeError", () => table.set(0, fn));
  assert_equal_to_array(table, [null]);
}, "Setting non-wasm function");

test(() => {
  const argument = { element: "anyfunc", initial: 1 };
  const table = new WebAssembly.Table(argument);
  assert_equal_to_array(table, [null]);
  const fn = () => {};
  assert_throws_js("TypeError", () => table.set(0, fn));
  assert_equal_to_array(table, [null]);
}, "Setting non-wasm arrow function");

const outOfRangeIndices = [
  { value: undefined, name: "undefined" },
  { value: NaN, name: "NaN" },
  { value: Infinity, name: "Infinity" },
  { value: -Infinity, name: "-Infinity" },
  { value: -1, name: "-1" },
  { value: 0x100000000, name: "4294967296" },
  { value: 0x1000000000, name: "68719476736" },
  { value: "0x100000000", name: '"0x100000000"' },
  { value: { valueOf() { return 0x100000000; } }, name: "object" },
];
for (const { value, name } of outOfRangeIndices) {
  test(() => {
    const argument = { element: "anyfunc", initial: 1 };
    const table = new WebAssembly.Table(argument);
    assert_throws_js("TypeError", () => table.get(value));
  }, `Getting out-of-range argument: ${name}`);

  test(() => {
    const argument = { element: "anyfunc", initial: 1 };
    const table = new WebAssembly.Table(argument);
    assert_throws_js("TypeError", () => table.set(value, null));
  }, `Setting out-of-range argument: ${name}`);
}

test(() => {
  const argument = { element: "anyfunc", initial: 1 };
  const table = new WebAssembly.Table(argument);
  let called = 0;
  const value = {
    valueOf() {
      called++;
      return 0;
    },
  };
  assert_throws_js("TypeError", () => table.set(value, {}));
  assert_equals(called, 1);
}, "Order of argument conversion");

test(() => {
  const { fn } = functions;
  const argument = { element: "anyfunc", initial: 1 };
  const table = new WebAssembly.Table(argument);
  assert_equals(table.get(0, {}), null);
  assert_equals(table.set(0, fn, {}), undefined);
}, "get-set: Stray argument");

test(() => {
  const fn = new WebAssembly.Instance(new WebAssembly.Module(binary("fn"))).exports.fn;
  const argument = { element: "anyfunc", initial: 1 };
  const table = new WebAssembly.Table(argument, fn);
  assert_equals(table.get(0), fn);
  table.set(0);
  assert_equals(table.get(0), null);
  table.set(0, fn);
  assert_equals(table.get(0), fn);
  assert_throws_js("TypeError", () => table.set(0, {}));
  assert_throws_js("TypeError", () => table.set(0, 37));
}, "Arguments for anyfunc table set");

test(() => {
  const testObject = {};
  const argument = { element: "externref", initial: 1 };
  const table = new WebAssembly.Table(argument, testObject);
  assert_equals(table.get(0), testObject);
  table.set(0);
  assert_equals(table.get(0), undefined);
  table.set(0, testObject);
  assert_equals(table.get(0), testObject);
  table.set(0, 37);
  assert_equals(table.get(0), 37);
}, "Arguments for externref table set");

// ── table/grow.any.js ─────────────────────────────────────────────────────
function nulls(n) {
  return Array(n).fill(null);
}

test(() => {
  const argument = { element: "anyfunc", initial: 5 };
  const table = new WebAssembly.Table(argument);
  // @ts-ignore: no delta
  assert_throws_js("TypeError", () => table.grow());
}, "Table grow: Missing arguments");

test(() => {
  const argument = { element: "anyfunc", initial: 5 };
  const table = new WebAssembly.Table(argument);
  assert_equal_to_array(table, nulls(5), "before");
  const result = table.grow(3);
  assert_equals(result, 5);
  assert_equal_to_array(table, nulls(8), "after");
}, "Table grow: Basic");

test(() => {
  const argument = { element: "anyfunc", initial: 3, maximum: 5 };
  const table = new WebAssembly.Table(argument);
  assert_equal_to_array(table, nulls(3), "before");
  const result = table.grow(2);
  assert_equals(result, 3);
  assert_equal_to_array(table, nulls(5), "after");
}, "Reached maximum");

test(() => {
  const argument = { element: "anyfunc", initial: 2, maximum: 5 };
  const table = new WebAssembly.Table(argument);
  assert_equal_to_array(table, nulls(2), "before");
  assert_throws_js("RangeError", () => table.grow(4));
  assert_equal_to_array(table, nulls(2), "after");
}, "Exceeded maximum");

for (const { value, name } of outOfRangeIndices) {
  test(() => {
    const argument = { element: "anyfunc", initial: 1 };
    const table = new WebAssembly.Table(argument);
    assert_throws_js("TypeError", () => table.grow(value));
  }, `Table grow: Out-of-range argument: ${name}`);
}

test(() => {
  const argument = { element: "anyfunc", initial: 5 };
  const table = new WebAssembly.Table(argument);
  assert_equal_to_array(table, nulls(5), "before");
  const result = table.grow(3, null, {});
  assert_equals(result, 5);
  assert_equal_to_array(table, nulls(8), "after");
}, "Table grow: Stray argument");

test(() => {
  const fn = new WebAssembly.Instance(new WebAssembly.Module(binary("fn"))).exports.fn;
  const argument = { element: "anyfunc", initial: 1 };
  const table = new WebAssembly.Table(argument, fn);
  assert_equal_to_array(table, [fn], "before");
  const result = table.grow(2, fn);
  assert_equals(result, 1);
  assert_equal_to_array(table, [fn, fn, fn], "after");
}, "Grow with exported-function argument");

test(() => {
  const argument = { element: "anyfunc", initial: 1 };
  const table = new WebAssembly.Table(argument);
  assert_throws_js("TypeError", () => table.grow(2, {}));
}, "Grow with non-function argument");

test(() => {
  const argument = { element: "anyfunc", initial: 1 };
  const table = new WebAssembly.Table(argument);
  assert_throws_js("TypeError", () => table.grow(2, () => true));
}, "Grow with JS-function argument");

// ── module/imports.any.js and module/exports.any.js ──────────────────────
function assert_descriptors(actual, expected, keys) {
  assert_true(Array.isArray(actual), "Should be array");
  assert_true(Object.isExtensible(actual), "isExtensible");
  assert_equals(actual.length, expected.length);
  for (let i = 0; i < expected.length; ++i) {
    assert_true(Object.isExtensible(actual[i]), "isExtensible");
    assert_array_equals(Object.keys(actual[i]), keys, "keys");
    for (const key of keys) assert_equals(actual[i][key], expected[i][key], key);
  }
}
const assert_imports = (imports, expected) => assert_descriptors(imports, expected, ["module", "name", "kind"]);
const assert_exports = (exports, expected) => assert_descriptors(exports, expected, ["name", "kind"]);
const emptyModule = new WebAssembly.Module(binary("empty"));

for (const which of ["imports", "exports"]) {
  test(() => {
    // @ts-ignore: no module
    assert_throws_js("TypeError", () => (which === "imports" ? WebAssembly.Module.imports() : WebAssembly.Module.exports()));
  }, `${which}: Missing arguments`);

  test(() => {
    const invalidArguments = [undefined, null, true, "", 1, {}];
    for (const argument of invalidArguments) {
      assert_throws_js(
        "TypeError",
        // @ts-ignore: not a module
        () => (which === "imports" ? WebAssembly.Module.imports(argument) : WebAssembly.Module.exports(argument)),
        `${which}(${format_value(argument)})`,
      );
    }
  }, `${which}: Non-Module arguments`);

  test(() => {
    const result = which === "imports" ? WebAssembly.Module.imports(emptyModule) : WebAssembly.Module.exports(emptyModule);
    assert_true(Array.isArray(result));
  }, `${which}: Return type`);

  test(() => {
    if (which === "imports") assert_imports(WebAssembly.Module.imports(emptyModule), []);
    else assert_exports(WebAssembly.Module.exports(emptyModule), []);
  }, `${which}: Empty module`);

  test(() => {
    if (which === "imports")
      assert_not_equals(WebAssembly.Module.imports(emptyModule), WebAssembly.Module.imports(emptyModule));
    else assert_not_equals(WebAssembly.Module.exports(emptyModule), WebAssembly.Module.exports(emptyModule));
  }, `${which}: Empty module: array caching`);
}

test(() => {
  const module = new WebAssembly.Module(binary("imports"));
  const imports = WebAssembly.Module.imports(module);
  const expected = [
    { module: "module", kind: "function", name: "fn" },
    { module: "module", kind: "global", name: "global" },
    { module: "module", kind: "memory", name: "memory" },
    { module: "module", kind: "table", name: "table" },
  ];
  assert_imports(imports, expected);
}, "imports");

for (const { key, label, expected } of [
  {
    key: "importsEmptyModule",
    label: "imports with empty module name",
    expected: [
      { module: "", kind: "function", name: "fn" },
      { module: "", kind: "global", name: "global" },
      { module: "", kind: "memory", name: "memory" },
      { module: "", kind: "table", name: "table" },
    ],
  },
  {
    key: "importsEmptyNames",
    label: "imports with empty names",
    expected: [
      { module: "a", kind: "function", name: "" },
      { module: "b", kind: "global", name: "" },
      { module: "c", kind: "memory", name: "" },
      { module: "d", kind: "table", name: "" },
    ],
  },
  {
    key: "importsEmptyBoth",
    label: "imports with empty module names and names",
    expected: [
      { module: "", kind: "function", name: "" },
      { module: "", kind: "global", name: "" },
      { module: "", kind: "memory", name: "" },
      { module: "", kind: "table", name: "" },
    ],
  },
]) {
  test(() => {
    const module = new WebAssembly.Module(binary(key));
    assert_imports(WebAssembly.Module.imports(module), expected);
  }, label);
}

test(() => {
  assert_imports(WebAssembly.Module.imports(emptyModule, {}), []);
}, "imports: Stray argument");

test(() => {
  const module = new WebAssembly.Module(binary("exports"));
  const exports = WebAssembly.Module.exports(module);
  const expected = [
    { kind: "function", name: "fn" },
    { kind: "function", name: "fn2" },
    { kind: "table", name: "table" },
    { kind: "global", name: "global" },
    { kind: "global", name: "global2" },
    { kind: "memory", name: "memory" },
  ];
  assert_exports(exports, expected);
}, "exports");

for (const { key, kind } of [
  { key: "exportsEmptyFunction", kind: "function" },
  { key: "exportsEmptyTable", kind: "table" },
  { key: "exportsEmptyGlobal", kind: "global" },
]) {
  test(() => {
    const module = new WebAssembly.Module(binary(key));
    assert_exports(WebAssembly.Module.exports(module), [{ kind, name: "" }]);
  }, `exports with empty name: ${kind}`);
}

test(() => {
  assert_exports(WebAssembly.Module.exports(emptyModule, {}), []);
}, "exports: Stray argument");

// ── module/customSections.any.js ──────────────────────────────────────────
function assert_sections(sections, expected) {
  assert_true(Array.isArray(sections), "Should be array");
  assert_true(Object.isExtensible(sections), "isExtensible");
  assert_equals(sections.length, expected.length);
  for (let i = 0; i < expected.length; ++i) {
    assert_true(sections[i] instanceof ArrayBuffer, "ArrayBuffer");
    assert_array_equals(new Uint8Array(sections[i]), expected[i]);
  }
}

test(() => {
  // @ts-ignore: no arguments
  assert_throws_js("TypeError", () => WebAssembly.Module.customSections());
  // @ts-ignore: no name
  assert_throws_js("TypeError", () => WebAssembly.Module.customSections(emptyModule));
}, "customSections: Missing arguments");

test(() => {
  const invalidArguments = [undefined, null, true, "", 1, {}];
  for (const argument of invalidArguments) {
    // @ts-ignore: not a module
    assert_throws_js("TypeError", () => WebAssembly.Module.customSections(argument, ""), `customSections(${format_value(argument)})`);
  }
}, "customSections: Non-Module arguments");

test(() => {
  assert_sections(WebAssembly.Module.customSections(emptyModule, ""), []);
}, "customSections: Empty module");

test(() => {
  assert_not_equals(WebAssembly.Module.customSections(emptyModule, ""), WebAssembly.Module.customSections(emptyModule, ""));
}, "customSections: Empty module: array caching");

const bytes1 = [87, 101, 98, 65, 115, 115, 101, 109, 98, 108, 121];
const bytes2 = [74, 83, 65, 80, 73];

test(() => {
  const module = new WebAssembly.Module(binary("custom"));
  assert_sections(WebAssembly.Module.customSections(module, "name"), [bytes1, bytes2]);
  assert_sections(WebAssembly.Module.customSections(module, "foo"), [bytes1]);
  assert_sections(WebAssembly.Module.customSections(module, ""), []);
  assert_sections(WebAssembly.Module.customSections(module, "\0"), []);
  assert_sections(WebAssembly.Module.customSections(module, "name\0"), []);
  assert_sections(WebAssembly.Module.customSections(module, "foo\0"), []);
}, "Custom sections");

test(() => {
  const name = "yee𐐷eey";
  const module = new WebAssembly.Module(binary("customSurrogates"));
  assert_sections(WebAssembly.Module.customSections(module, name), [bytes1]);
  assert_sections(WebAssembly.Module.customSections(module, "yee�eey"), []);
  assert_sections(WebAssembly.Module.customSections(module, "yee��eey"), []);
}, "Custom sections with surrogate pairs");

test(() => {
  const module = new WebAssembly.Module(binary("customReplacement"));
  assert_sections(WebAssembly.Module.customSections(module, "name"), []);
  assert_sections(WebAssembly.Module.customSections(module, "na�me"), [bytes1]);
  assert_sections(WebAssembly.Module.customSections(module, "na\uDC01me"), []);
}, "Custom sections with U+FFFD");

test(() => {
  assert_sections(WebAssembly.Module.customSections(emptyModule, "", {}), []);
}, "customSections: Stray argument");

test(() => {
  const module = new WebAssembly.Module(binary("customCopy"));
  const first = WebAssembly.Module.customSections(module, "copy");
  const second = WebAssembly.Module.customSections(module, "copy");
  assert_equals(first.length, 1);
  assert_equals(second.length, 1);
  assert_not_equals(first, second);
  assert_not_equals(first[0], second[0]);
}, "Custom section buffers are independent copies");

test(() => {
  const bytes = [0x11, 0x22, 0x33];
  const module = new WebAssembly.Module(binary("customCopy"));
  const first = WebAssembly.Module.customSections(module, "copy");
  const second = WebAssembly.Module.customSections(module, "copy");
  const view = new Uint8Array(first[0]);
  view[0] = 0xff;
  view[1] = 0xee;
  view[2] = 0xdd;
  const again = WebAssembly.Module.customSections(module, "copy");
  assert_array_equals(new Uint8Array(again[0]), bytes);
  assert_array_equals(new Uint8Array(second[0]), bytes);
}, "Mutating a custom section buffer does not change other copies");

console.log(`${passed} passed, ${failed} failed`);
