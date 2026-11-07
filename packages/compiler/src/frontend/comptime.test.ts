import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { ComptimeFailure, createComptimeEvaluator, type ComptimeLimits } from "./comptime.js";
import { hostComptimeEvaluator } from "./services-node.js";
import { ts7Executable } from "./ts7/rpc-api.js";

// The evaluator both compilers run: TypeScript's command line and the
// executable of the host's LLVM helper package.
const evaluator = createComptimeEvaluator(ts7Executable(), hostComptimeEvaluator);
const LIMITS: ComptimeLimits = { timeoutMs: 5000, memoryMb: 256 };

function evaluate(source: string, limits: Partial<ComptimeLimits> = {}): unknown {
  return evaluator(source, { ...LIMITS, ...limits });
}

function failure(source: string, limits: Partial<ComptimeLimits> = {}): ComptimeFailure {
  try {
    evaluate(source, limits);
  } catch (error) {
    if (error instanceof ComptimeFailure) return error;
    throw error;
  }
  throw new Error(`the callback evaluated: ${source}`);
}

test("comptime erases TypeScript and returns the actual structured value", () => {
  expect(
    evaluate(`() => {
    interface Pair { value: number; text: string }
    const make = <T>(value: T): T => value;
    const items: Pair[] = [];
    for (let i = 0; i < 4; i++) items.push(make({ value: i * i, text: String(i) }));
    return { items, zero: -0, text: "hello \\ud83c\\udf0d", lone: "\\ud800", empty: undefined };
  }`),
  ).toEqual({
    items: [0, 1, 4, 9].map((value, index) => ({ value, text: String(index) })),
    zero: -0,
    text: "hello 🌍",
    lone: "\ud800",
    empty: undefined,
  });
  expect(
    evaluate(`(): string => {
    enum Level { Low = 1, High }
    class Named<T> { constructor(private readonly label: T, public rank?: number) {} get both(): string { return String(this.label) + this.rank; } }
    return [Level.High, Level[1], new Named("a", 2).both].join();
  }`),
  ).toBe("2,Low,a2");
});

test("non-bakeable results keep their identity for shared result validation", () => {
  const values = evaluate(
    "() => [NaN, Infinity, -Infinity, -0, undefined, null, 123n]",
  ) as unknown[];
  expect(values).toEqual([NaN, Infinity, -Infinity, -0, undefined, null, 123n]);
  expect(typeof evaluate("() => () => 1")).toBe("function");
  // A proxy over an array is an array, as Array.isArray says, and its traps
  // answer for its elements.
  expect(evaluate("() => new Proxy([1, 2, 3], {})")).toEqual([1, 2, 3]);
  expect(
    evaluate(
      '() => new Proxy(new Proxy([1, 2], {}), { get: (target, key) => (key === "length" ? 2 : target[key] * 10) })',
    ),
  ).toEqual([10, 20]);
  expect(evaluate("() => new Proxy({ a: 1 }, {})")).toEqual({ a: 1 });
  expect(
    failure(
      "() => { const { proxy, revoke } = Proxy.revocable([1], {}); revoke(); return proxy; }",
    ),
  ).toMatchObject({ kind: "thrown" });
  // A hole reads as undefined; only own enumerable properties are results.
  expect(evaluate("() => [1, , 3]")).toEqual([1, undefined, 3]);
  expect(
    evaluate(`() => {
    const inherited = Object.create({ fromPrototype: 1 });
    inherited.own = 2;
    Object.defineProperty(inherited, "hidden", { value: 3 });
    return inherited;
  }`),
  ).toEqual({ own: 2 });
});

test("the callback cannot replace how its result is read", () => {
  expect(
    evaluate(`() => {
    JSON.stringify = () => '"spoofed"';
    Array.prototype.toJSON = () => "spoofed";
    Object.prototype.toJSON = () => "spoofed";
    Array.prototype.map = () => ["spoofed"];
    const values = [1, 2];
    values.map = () => ["spoofed"];
    values.every = () => false;
    return { values, nested: { ok: true } };
  }`),
  ).toEqual({ values: [1, 2], nested: { ok: true } });
  // What comes back is data the compiler built, not the callback's objects.
  const result = evaluate('() => JSON.parse(\'{"a": 1, "__proto__": {"b": 2}}\')') as object;
  expect(Object.getPrototypeOf(result)).toBeNull();
  expect(Object.keys(result)).toEqual(["a", "__proto__"]);
  expect(({} as { b?: number }).b).toBeUndefined();
});

test("every callback gets fresh globals", () => {
  expect(evaluate("() => { globalThis.saved = 1; Object.prototype.leak = 1; return 2; }")).toBe(2);
  expect(evaluate("() => [typeof saved, typeof ({}).leak]")).toEqual(["undefined", "undefined"]);
});

// Each of these reached the compiler's own process, or one of its objects,
// when the Node host evaluated callbacks with node:vm.
test("no host object or binding is reachable from a callback", () => {
  const probe =
    "typeof process === 'object' ? 'host process ' + process.pid : typeof require === 'function' ? 'host require' : 'no host'";
  expect(
    evaluate(`() => globalThis.constructor.constructor(${JSON.stringify("return " + probe)})()`),
  ).toBe("no host");
  expect(
    evaluate(`() => {
    const F = (() => 1).constructor;
    const g = F("return this")();
    return g.constructor.constructor(${JSON.stringify("return " + probe)})();
  }`),
  ).toBe("no host");
  expect(
    evaluate(`() => {
    const reached = [];
    const visit = (value) => {
      for (let o = value; o !== null && o !== undefined; o = Object.getPrototypeOf(o)) {
        const constructor = o.constructor;
        if (typeof constructor === "function") reached.push(constructor.constructor(${JSON.stringify("return " + probe)})());
      }
    };
    visit(globalThis); visit(new Error("e")); visit(function () {}); visit(async () => {}); visit(function* () {}); visit(/r/); visit(Symbol.iterator);
    try { null.x; } catch (error) { visit(error); }
    return [...new Set(reached)];
  }`),
  ).toEqual(["no host"]);
  expect(
    evaluate(
      "() => ['process', 'require', 'module', 'console', 'setTimeout', 'setInterval', 'setImmediate', 'fetch', 'Buffer', 'WebAssembly', 'os', 'std', 'scriptArgs', 'print'].filter((name) => name in globalThis)",
    ),
  ).toEqual([]);
  // A result's accessors and hooks run in the evaluator, never in the compiler.
  expect(
    evaluate(`() => {
    const values = [0];
    values.map = function (callback) { return [callback.constructor(${JSON.stringify("return " + probe)})()]; };
    return { values, get where() { return ${probe}; } };
  }`),
  ).toEqual({ values: [0], where: "no host" });
});

test("module loading and blocking are not available", () => {
  expect(failure('() => { import("node:fs"); return 1; }')).toMatchObject({ kind: "refused" });
  expect(failure('() => { import("node:fs").catch(() => {}); return 1; }')).toMatchObject({
    kind: "refused",
    message: expect.stringContaining("promise reactions pending"),
  });
  expect(failure('() => require("node:fs")')).toMatchObject({ kind: "thrown" });
  expect(
    failure("() => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)"),
  ).toMatchObject({ kind: "thrown", message: "cannot block in this thread" });
});

test("asynchronous work left behind is refused, not dropped", () => {
  expect(failure("() => { Promise.resolve().then(() => {}); return 1; }")).toMatchObject({
    kind: "refused",
    message: "the callback left promise reactions pending, and they never run at compile time",
  });
  expect(failure('() => { Promise.reject(new Error("lost")); return 1; }')).toMatchObject({
    kind: "refused",
    message: "the callback left a rejected promise unhandled",
  });
  expect(evaluate("() => { Promise.resolve(1); return 1; }")).toBe(1);
  // Reading the result runs the callback's accessors and traps: work they
  // leave behind is refused too.
  expect(
    failure("() => ({ get n() { Promise.resolve().then(() => {}); return 1; } })"),
  ).toMatchObject({ kind: "refused", message: expect.stringContaining("reactions pending") });
  expect(
    failure(
      '() => new Proxy([1], { get(target, key) { if (key === "0") Promise.reject(new Error("lost")); return target[key]; } })',
    ),
  ).toMatchObject({ kind: "refused", message: "the callback left a rejected promise unhandled" });
});

test("the time limit covers loops, patterns, builtins, accessors and thrown values", () => {
  const budget = { timeoutMs: 100 };
  expect(failure("() => { while (true) {} }", budget)).toMatchObject({ kind: "timeout" });
  expect(failure("() => { try { while (true) {} } catch { return 1; } }", budget)).toMatchObject({
    kind: "timeout",
  });
  expect(failure('() => /^(a+)+$/.test("a".repeat(48) + "b")', budget)).toMatchObject({
    kind: "timeout",
  });
  // One builtin call the engine never interrupts: the watchdog ends it.
  const started = Date.now();
  expect(
    failure("() => new Array(8000000).fill(7).sort().length", { timeoutMs: 100, memoryMb: 1024 }),
  ).toMatchObject({ kind: "timeout" });
  expect(failure("() => ({ get slow() { while (true) {} } })", budget)).toMatchObject({
    kind: "timeout",
  });
  expect(failure("() => { throw { get message() { while (true) {} } }; }", budget)).toMatchObject({
    kind: "timeout",
  });
  expect(Date.now() - started).toBeLessThan(20_000);
  expect(evaluate("() => 21 * 2")).toBe(42);
});

test("the memory limit is named, on and off the engine's heap", () => {
  const small = { memoryMb: 32 };
  expect(
    failure("() => { const all = []; for (;;) all.push(new Array(1 << 16).fill(1)); }", small),
  ).toMatchObject({ kind: "memory" });
  expect(failure("() => new Uint8Array(1 << 28).length", small)).toMatchObject({ kind: "memory" });
  expect(failure('() => "x".repeat(1 << 27).length', small)).toMatchObject({ kind: "memory" });
  // The engine has no memory left for an error object here and throws null.
  expect(
    failure(
      "() => { const a = []; for (let i = 0; i < 3000000; i++) a.push((i * 7919) % 3000017); a.sort(); return a[0]; }",
    ),
  ).toMatchObject({ kind: "memory" });
  expect(
    failure(
      '() => { try { new Uint8Array(1 << 28); } catch {} throw new Error("after the limit"); }',
      small,
    ),
  ).toMatchObject({ kind: "thrown", message: "after the limit" });
  // The callback may catch the engine's error and go on within the limit.
  expect(
    evaluate(
      "() => { try { new Uint8Array(1 << 28); } catch (error) { return error.message; } }",
      small,
    ),
  ).toBe("out of memory");
  expect(failure("() => { const r = (n) => r(n + 1) + 1; return r(0); }")).toMatchObject({
    kind: "thrown",
    message: "Maximum call stack size exceeded",
  });
});

test("thrown values and refused results are reported by name", () => {
  expect(failure('() => { throw new Error("user failure") }')).toMatchObject({
    kind: "thrown",
    message: "user failure",
  });
  expect(failure('() => { throw "plain"; }')).toMatchObject({ kind: "thrown", message: "plain" });
  expect(failure("() => { throw null; }")).toMatchObject({ kind: "thrown", message: "null" });
  expect(failure("() => { throw { code: 7 }; }")).toMatchObject({
    kind: "thrown",
    message: "[object Object]",
  });
  expect(failure("() => { throw Symbol('s'); }")).toMatchObject({
    kind: "thrown",
    message: "a value that has no string form",
  });
  expect(
    failure("() => { const result = {}; result.self = result; return result; }"),
  ).toMatchObject({ kind: "refused", message: "the result contains itself" });
  expect(failure('() => [1, Symbol("s")]')).toMatchObject({
    kind: "refused",
    message: "the result contains a symbol",
  });
  expect(failure("() => new Array(1000001).fill(0)")).toMatchObject({
    kind: "refused",
    message: "the result has an array of more than 1000000 elements",
  });
  expect(
    failure(
      "() => { let nested = []; for (let i = 0; i < 600; i++) nested = [nested]; return nested; }",
    ),
  ).toMatchObject({ kind: "refused", message: "the result is nested more than 512 levels deep" });
  expect(failure('() => "x".repeat(70 * 1024 * 1024)')).toMatchObject({
    kind: "refused",
    message: "the result is larger than 64 MB",
  });
  expect(
    (evaluate("() => { const shared = { n: 1 }; return [shared, shared]; }") as unknown[])[1],
  ).toEqual({ n: 1 });
});

// Node computes these with V8's port of fdlibm and its own hypot; the C
// library's results differ in the last digit for a share of inputs.
test("Math members give Node's values", () => {
  const inputs: number[] = [];
  let state = 0x2545f491;
  for (let i = 0; i < 600; i++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    const unit = (state >>> 0) / 4294967296;
    inputs.push(
      [unit, unit * 10 - 5, unit * 1e3, (unit - 0.5) * 1e-3, unit * 700 - 350, 1 + unit][i % 6]!,
    );
  }
  const unary = [
    "sin",
    "cos",
    "tan",
    "asin",
    "acos",
    "atan",
    "sinh",
    "cosh",
    "tanh",
    "asinh",
    "acosh",
    "atanh",
    "exp",
    "expm1",
    "log",
    "log1p",
    "log2",
    "log10",
    "cbrt",
    "sqrt",
  ] as const;
  const computed = evaluate(`() => {
    const inputs = ${JSON.stringify(inputs)};
    const result = {};
    for (const name of ${JSON.stringify(unary)}) result[name] = inputs.map((x) => Math[name](x));
    result.atan2 = inputs.map((x, i) => Math.atan2(x, inputs[(i + 1) % inputs.length]));
    result.hypot = inputs.map((x, i) => Math.hypot(x, inputs[(i + 1) % inputs.length], inputs[(i + 2) % inputs.length]));
    result.pow = inputs.map((x, i) => Math.pow(Math.abs(x) % 50, inputs[(i + 1) % inputs.length] % 20));
    result.edges = [Math.hypot(), Math.hypot(-3), Math.hypot(NaN, Infinity), Math.hypot(NaN, 1), Math.hypot(0, -0), Math.hypot(3, 4), Math.hypot(1e300, 1e300), Math.atan2(0, -0), Math.cbrt(-27), Math.expm1(-0), Math.sin(1e22)];
    return result;
  }`) as Record<string, number[]>;
  for (const name of unary) expect(computed[name], name).toEqual(inputs.map((x) => Math[name](x)));
  expect(computed["atan2"]).toEqual(
    inputs.map((x, i) => Math.atan2(x, inputs[(i + 1) % inputs.length]!)),
  );
  expect(computed["hypot"]).toEqual(
    inputs.map((x, i) =>
      Math.hypot(x, inputs[(i + 1) % inputs.length]!, inputs[(i + 2) % inputs.length]!),
    ),
  );
  expect(computed["pow"]).toEqual(
    inputs.map((x, i) => Math.pow(Math.abs(x) % 50, inputs[(i + 1) % inputs.length]! % 20)),
  );
  expect(computed["edges"]).toEqual([
    Math.hypot(),
    Math.hypot(-3),
    Math.hypot(NaN, Infinity),
    Math.hypot(NaN, 1),
    Math.hypot(0, -0),
    Math.hypot(3, 4),
    Math.hypot(1e300, 1e300),
    Math.atan2(0, -0),
    Math.cbrt(-27),
    Math.expm1(-0),
    Math.sin(1e22),
  ]);
});

test("BigInt.asUintN gives a non-negative value", () => {
  const cases: [number, bigint][] = [
    [64, -1n],
    [63, -1n],
    [65, -1n],
    [32, -1n],
    [8, -1n],
    [64, -2n],
    [64, 1n],
    [64, 2n ** 64n],
    [64, 2n ** 64n - 1n],
    [64, -(2n ** 63n)],
    [128, -1n],
    [1, -1n],
    [0, -1n],
    [53, -1n],
    [70, -5n],
    [64, -(2n ** 64n) - 1n],
    [200, -(2n ** 190n)],
    [127, 2n ** 127n + 5n],
  ];
  expect(
    evaluate(
      `() => [${cases.map(([bits, value]) => `[${bits}, ${value}n]`).join(", ")}].map(([bits, value]) => [BigInt.asUintN(bits, value), BigInt.asIntN(bits, value)])`,
    ),
  ).toEqual(
    cases.map(([bits, value]) => [BigInt.asUintN(bits, value), BigInt.asIntN(bits, value)]),
  );
  expect(
    evaluate(
      "() => [BigInt.asUintN.name, BigInt.asUintN.length, String(BigInt.asUintN(undefined, 5n))]",
    ),
  ).toEqual(["asUintN", 2, "0"]);
  expect(failure("() => BigInt.asUintN(-1, 1n)")).toMatchObject({ kind: "thrown" });
  expect(failure("() => BigInt.asUintN(8, 1)")).toMatchObject({ kind: "thrown" });
});

// Where the engine cannot give Node's answer, the call throws by name.
test("members whose Node result needs locale data or V8's digit generation are refused", () => {
  for (const [call, member] of [
    ["(1234567.891).toLocaleString()", "Number.prototype.toLocaleString"],
    ["(10n ** 9n).toLocaleString()", "BigInt.prototype.toLocaleString"],
    ['"a".localeCompare("B")', "String.prototype.localeCompare"],
    ['"I".toLocaleLowerCase("tr")', "String.prototype.toLocaleLowerCase"],
    ['"i".toLocaleUpperCase()', "String.prototype.toLocaleUpperCase"],
    ["[1234.5].toLocaleString()", "Number.prototype.toLocaleString"],
    ["new Date(0).toString()", "Date.prototype.toString"],
    ["String(new Date(0))", "Date.prototype.toString"],
    ["new Date(0).toTimeString()", "Date.prototype.toTimeString"],
    ["new Date(0).toLocaleString()", "Date.prototype.toLocaleString"],
    ["new Date(0).toLocaleDateString()", "Date.prototype.toLocaleDateString"],
    ["new Date(0).toLocaleTimeString()", "Date.prototype.toLocaleTimeString"],
  ] as const)
    expect(failure(`() => ${call}`), call).toMatchObject({
      kind: "thrown",
      message: `${member} is not available at compile time: its result depends on locale data`,
    });
  expect(failure("() => (0.5).toString(3)")).toMatchObject({
    kind: "thrown",
    message: expect.stringContaining("only for safe integers"),
  });
  expect(failure("() => (1e21).toString(36)")).toMatchObject({ kind: "thrown" });
  expect(failure("() => (1).toString(1)")).toMatchObject({ kind: "thrown" });
  expect(
    evaluate(
      "() => [(255).toString(16), (-255).toString(2), (2 ** 53 - 1).toString(36), (0.1).toString(), (0.1).toString(10), (1e21).toString(), NaN.toString(2), (-Infinity).toString(36), new Number(5).toString(2), new Date(0).toISOString(), new Date(0).toUTCString(), [1, 2].toString()]",
    ),
  ).toEqual([
    "ff",
    "-11111111",
    (2 ** 53 - 1).toString(36),
    "0.1",
    "0.1",
    "1e+21",
    "NaN",
    "-Infinity",
    "101",
    "1970-01-01T00:00:00.000Z",
    "Thu, 01 Jan 1970 00:00:00 GMT",
    "1,2",
  ]);
});

test.skipIf(process.platform === "win32")(
  "one TypeScript run erases the types of a file's callbacks",
  () => {
    const stage = mkdtempSync(join(tmpdir(), "scriptc-comptime-test-"));
    try {
      // TypeScript's command line behind a script that records each run.
      const runs = join(stage, "runs");
      const counted = join(stage, "tsc");
      writeFileSync(counted, `#!/bin/sh\necho run >> '${runs}'\nexec '${ts7Executable()}' "$@"\n`, {
        mode: 0o755,
      });
      const counting = createComptimeEvaluator(counted, hostComptimeEvaluator);
      const siblings = ["(): number => 1", "(): number => 2", "(): string => 'three'"];
      expect(siblings.map((source) => counting(source, LIMITS, siblings))).toEqual([1, 2, "three"]);
      expect(counting("(): number => 1", LIMITS)).toBe(1);
      expect(readFileSync(runs, "utf8")).toBe("run\n");
      // A sibling TypeScript rejects costs a second run, not the evaluation.
      expect(counting("(): number => 4", LIMITS, ["(): number => 4", "() => { return }}}"])).toBe(
        4,
      );
      expect(readFileSync(runs, "utf8")).toBe("run\nrun\nrun\n");
      expect(() => counting("() => { return }}}", LIMITS)).toThrow();
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  },
);
