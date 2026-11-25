/* Program generators for the generative lane.
 *
 * Each generator is a pure function of (seed, index): the same pair always
 * yields the same program, so a failure is reproduced from the two numbers in
 * its baseline key and nothing else. Changing what a generator emits changes
 * every program, which is why the baseline records a digest of each
 * generator's output (generatorDigest) and refuses to compare across digests.
 *
 * Every generated program is well typed, uses only forms scriptc compiles, and
 * contains no conversion scriptc documents as divergent. Under the lane's
 * oracle (oracle.mjs) each one must match Node exactly.
 */
import { createHash } from "node:crypto";

/** A small deterministic random source keyed by (seed, index). */
function randomSource(seed, index) {
  let state = (Math.imul(seed >>> 0, 0x9e3779b1) ^ Math.imul((index + 1) >>> 0, 0x85ebca6b)) >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (bound) => Math.floor(next() * bound);
  const pick = (values) => values[int(values.length)];
  const shuffle = (values) => {
    const out = [...values];
    for (let i = out.length - 1; i > 0; i--) {
      const j = int(i + 1);
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  };
  return { next, int, pick, shuffle };
}

/* ── records ─────────────────────────────────────────────────────────────
 * One record type with required and optional fields. A program creates
 * values with random key order and presence, aliases them, sends them through
 * a generic function, `unknown` and a cast, an array, a Map, a closure and a
 * field, spreads them, writes, deletes and mutates them in callees. After
 * every step it prints each reflective view of the touched record and its
 * identity against every other binding. No value is converted to another
 * record type, so no copy and no key-order fallback is documented for it. */

const RECORD_PRELUDE = `interface R { a: number; b?: number; c?: string; d: string; e?: number[] }
function id<T>(v: T): T { return v; }
function viaUnknown(v: R): R { const u: unknown = v; return u as R; }
function viaArray(v: R): R { const xs: R[] = [v]; return xs[0]!; }
function viaMap(v: R): R { const m = new Map<string, R>(); m.set("k", v); return m.get("k")!; }
function viaClosure(v: R): R { const f = (): R => v; return f(); }
function viaField(v: R): R { const h = { r: v }; return h.r; }
function setB(r: R, n: number): void { r.b = n; }
function bumpA(r: R): void { r.a += 1; }
function defB(r: R, n: number): void { r.b ??= n; }
function clearC(r: R): void { delete r.c; }
function pushE(r: R, n: number): void { (r.e ??= []).push(n); }
function obs(tag: string, r: R, all: R[]): void {
  const ks: string[] = [];
  for (const k in r) ks.push(k);
  console.log(tag, JSON.stringify(r), Object.keys(r).join(","), "b" in r, Object.hasOwn(r, "c"), ks.join(","), Object.values(r).length, Object.entries(r).map(([k]) => k).join(""), all.map((x) => (x === r ? "1" : "0")).join(""));
}
`;

function records(seed, index) {
  const { next, int, pick, shuffle } = randomSource(seed, index);
  const literal = () => {
    const keys = ["a", "d"];
    if (next() < 0.5) keys.push("b");
    if (next() < 0.5) keys.push("c");
    if (next() < 0.3) keys.push("e");
    const value = {
      a: () => String(int(9)),
      b: () => pick(["1", "2", "undefined", "0"]),
      c: () => pick(['"s"', '"t"', "undefined"]),
      d: () => `"d${int(9)}"`,
      e: () => pick(["[]", "[1]"]),
    };
    return `{ ${shuffle(keys)
      .map((k) => `${k}: ${value[k]()}`)
      .join(", ")} }`;
  };
  const lines = [RECORD_PRELUDE];
  const vars = [];
  const all = () => `[${vars.join(", ")}]`;
  const declare = (declaration, name) => {
    lines.push(declaration);
    vars.push(name);
    lines.push(`obs("${name}", ${name}, ${all()});`);
  };
  declare(`const r0: R = ${literal()};`, "r0");
  const steps = 8 + int(10);
  for (let step = 0; step < steps; step++) {
    const src = pick(vars);
    const roll = next();
    const name = `r${vars.length}`;
    if (roll < 0.1) declare(`const ${name}: R = ${literal()};`, name);
    else if (roll < 0.16) declare(`const ${name} = ${src};`, name);
    else if (roll < 0.3) {
      const via = pick(["id", "viaUnknown", "viaArray", "viaMap", "viaClosure", "viaField"]);
      declare(`const ${name} = ${via}(${src});`, name);
    } else if (roll < 0.4) {
      const spread = pick([
        `{ ...${src} }`,
        `{ ...${src}, a: ${int(9)} }`,
        `{ ...${src}, b: ${int(9)} }`,
        `{ b: ${int(9)}, ...${src} }`,
        `{ ...${src}, c: "sp" }`,
        `{ c: "pre", ...${src}, b: undefined }`,
      ]);
      declare(`const ${name}: R = ${spread};`, name);
    } else {
      lines.push(
        pick([
          `${src}.a = ${int(99)};`,
          `${src}.b = ${int(99)};`,
          `${src}.b = undefined;`,
          `${src}.c = "w${int(9)}";`,
          `${src}.c = undefined;`,
          `${src}.e = [${int(9)}];`,
          `delete ${src}.b;`,
          `delete ${src}.c;`,
          `delete ${src}.e;`,
          `${src}.b ??= ${int(99)};`,
          `${src}.a += ${int(9)};`,
          `setB(${src}, ${int(99)});`,
          `bumpA(${src});`,
          `defB(${src}, ${int(99)});`,
          `clearC(${src});`,
          `pushE(${src}, ${int(9)});`,
          `Object.assign(${src}, { b: ${int(99)} });`,
          `{ const { a: _a, ...rest } = ${src}; console.log("rest", JSON.stringify(rest), Object.keys(rest).join(",")); }`,
          `{ const copy = structuredClone(${src}); copy.a = -1; console.log("clone", JSON.stringify(copy), copy === ${src}); }`,
          `{ const parsed = JSON.parse(JSON.stringify(${src})) as R; console.log("json", Object.keys(parsed).join(","), parsed.b); }`,
        ]),
      );
      lines.push(`obs("${src}'", ${src}, ${all()});`);
    }
  }
  lines.push(`for (const [i, r] of ${all()}.entries()) obs("final" + i, r, ${all()});`);
  return `${lines.join("\n")}\n`;
}

/* ── numbers ─────────────────────────────────────────────────────────────
 * Arithmetic over the integer and float lanes: expression trees over the
 * binary, bitwise and Math operators, with operands from loop counters, array
 * and string lengths and constants at the representation edges (2^31, 2^32,
 * 2^53, -0, halves). Every result prints through a formatter that tells -0
 * from 0. */

const NUMBER_CONSTANTS = [
  "0",
  "1",
  "2",
  "3",
  "7",
  "31",
  "255",
  "65535",
  "65536",
  "46341",
  "2147483647",
  "-2147483648",
  "2147483648",
  "4294967295",
  "4294967296",
  "9007199254740991",
  "9007199254740992",
  "0.5",
  "-0.5",
  "1.5",
  "0.1",
  "-1",
  "-0",
  "1e9",
  "1e21",
  "-7",
  "1073741824",
  "715827883",
];
const BINARY_OPERATORS = ["+", "-", "*", "/", "%", "|", "&", "^", "<<", ">>", ">>>", "+", "-", "*"];

function numbers(seed, index) {
  const { next, int, pick } = randomSource(seed, index);
  const expression = (depth, vars) => {
    if (depth <= 0 || next() < 0.18) {
      const roll = next();
      if (roll < 0.55) return pick(vars);
      if (roll < 0.85) return `(${pick(NUMBER_CONSTANTS)})`;
      if (roll < 0.9) return "arr.length";
      if (roll < 0.95) return "str.length";
      return `arr[(${pick(vars)} >>> 0) % arr.length]!`;
    }
    const roll = next();
    const operand = () => expression(depth - 1, vars);
    if (roll < 0.6) return `(${operand()} ${pick(BINARY_OPERATORS)} ${operand()})`;
    if (roll < 0.66) return `Math.floor(${operand()})`;
    if (roll < 0.7) return `Math.trunc(${operand()})`;
    if (roll < 0.73) return `Math.round(${operand()})`;
    if (roll < 0.76) return `Math.abs(${operand()})`;
    if (roll < 0.8) return `Math.imul(${operand()}, ${operand()})`;
    if (roll < 0.83) return `Math.min(${operand()}, ${operand()})`;
    if (roll < 0.86) return `Math.max(${operand()}, ${operand()})`;
    if (roll < 0.89) return `(-${operand()})`;
    if (roll < 0.92) return `(~${operand()})`;
    if (roll < 0.95) return `(${operand()} | 0)`;
    if (roll < 0.97) return `(${operand()} >>> 0)`;
    // The left side of a comparison is a variable: tsc rejects a comparison
    // of two literals whose types do not overlap.
    const comparison = pick(["<", "<=", ">", ">=", "===", "!=="]);
    return `(${pick(vars)} ${comparison} ${operand()} ? ${operand()} : ${operand()})`;
  };
  const lines = [
    `const fmt = (x: number): string => (Object.is(x, -0) ? "-0" : String(x));`,
    `const arr: number[] = [${Array.from({ length: 1 + int(6) }, () => pick(NUMBER_CONSTANTS)).join(", ")}];`,
    `const str: string = "${"abcdefgh".slice(0, 1 + int(8))}";`,
  ];
  const functions = 2 + int(3);
  for (let f = 0; f < functions; f++) {
    const shape = int(4);
    if (shape === 0) {
      lines.push(
        `function f${f}(a: number, b: number): number { return ${expression(4, ["a", "b"])}; }`,
      );
    } else if (shape === 1) {
      const start = pick([
        "0",
        "1",
        "-3",
        "2147483640",
        "-2147483650",
        "4294967290",
        "arr.length",
        "str.length",
      ]);
      const step = pick(["i++", "i += 2", "i += 0.5", "i--", "i += 3"]);
      const rounds = 3 + int(12);
      lines.push(
        `function f${f}(a: number, b: number): number { let acc: number = ${pick(NUMBER_CONSTANTS)}; let n = 0; for (let i: number = ${start}; n < ${rounds}; ${step}) { n++; acc = ${expression(3, ["a", "b", "acc", "i"])}; } return acc; }`,
      );
    } else if (shape === 2) {
      lines.push(
        `function f${f}(a: number, b: number): number { let x = a; let y = b; for (let i = 0; i < ${2 + int(8)}; i++) { const t: number = ${expression(3, ["x", "y", "i"])}; x = y; y = t; } return ${expression(2, ["x", "y"])}; }`,
      );
    } else {
      lines.push(
        `function f${f}(a: number, b: number): number { const out: number[] = []; for (let i = 0; i < ${2 + int(6)}; i++) out.push(${expression(3, ["a", "b", "i"])}); let s: number = 0; for (const v of out) s = ${expression(2, ["s", "v"])}; return s + out.length; }`,
      );
    }
  }
  const inputs = Array.from(
    { length: 4 },
    () => `[${pick(NUMBER_CONSTANTS)}, ${pick(NUMBER_CONSTANTS)}]`,
  );
  lines.push(
    `const inputs: [number, number][] = [${inputs.join(", ")}, [arr.length, str.length]];`,
  );
  for (let f = 0; f < functions; f++) {
    lines.push(`console.log("f${f}", inputs.map(([a, b]) => fmt(f${f}(a, b))).join(" "));`);
  }
  lines.push(`const first: number = arr[0]!;`);
  for (let k = 0; k < 3; k++) {
    lines.push(`console.log("e${k}", fmt(${expression(4, ["first"])}));`);
  }
  return `${lines.join("\n")}\n`;
}

/* ── islands ─────────────────────────────────────────────────────────────
 * Records crossing into a Node island and back through @scriptc/node's
 * copying calls. The same record type as above goes to a CommonJS module
 * that echoes it, mutates its copy, reads its keys, merges two, wraps it, or
 * throws; the program prints every view of what comes back and of the value
 * it sent, which the call must leave alone. The module is named by a string
 * literal at every call, as the build requires. Number fields stay finite,
 * since a result is checked against its declared type and NaN arrives as
 * null.
 * These programs need a libnode pack (SCRIPTC_LIBNODE) to run natively. */

const ISLAND_MODULE = `"use strict";
let calls = 0;
exports.echo = (v) => v;
exports.bump = (v) => {
  v.a += 1;
  v.b = (v.b ?? 0) + 1;
  return v;
};
exports.keys = (v) => Object.keys(v);
exports.describe = (v) =>
  JSON.stringify(v) + "|" + typeof v.b + "|" + ("c" in v) + "|" + Array.isArray(v.e);
exports.merge = (a, b) => ({ ...a, ...b });
exports.count = () => ++calls;
exports.nested = (v) => ({ wrapped: v, list: [v, v] });
exports.optionalB = (v) => v.b;
exports.fail = (kind, message) => {
  throw new globalThis[kind](message);
};
exports.later = async (v) => {
  await null;
  return { ...v, d: v.d + "!" };
};
`;

const ISLAND_PRELUDE = `import { call, callSync } from "@scriptc/node";
interface R { a: number; b?: number; c?: string; d: string; e?: number[] }
function obs(tag: string, r: R, all: R[]): void {
  const ks: string[] = [];
  for (const k in r) ks.push(k);
  console.log(tag, JSON.stringify(r), Object.keys(r).join(","), "b" in r, Object.hasOwn(r, "c"), ks.join(","), Object.values(r).length, all.map((x) => (x === r ? "1" : "0")).join(""));
}
function attempt(kind: string, message: string): void {
  try {
    callSync<void>("./island.cjs", "fail", kind, message);
    console.log("fail returned");
  } catch (e) {
    console.log("caught", e instanceof TypeError, e instanceof RangeError, e instanceof Error ? e.name + ":" + e.message : String(e));
  }
}
`;

function islands(seed, index) {
  const { next, int, pick, shuffle } = randomSource(seed, index);
  // Escapes stay escapes in the emitted source: an astral character, a lone
  // surrogate and a control character all have to survive the JSON copy.
  const text = () => pick(['"s"', '"t"', '"\\u{1F600}x"', '"a\\ud800b"', '"\\u00e9\\n"', '""']);
  const literal = () => {
    const keys = ["a", "d"];
    if (next() < 0.5) keys.push("b");
    if (next() < 0.5) keys.push("c");
    if (next() < 0.3) keys.push("e");
    const value = {
      a: () => pick(["0", "1", "-0", "1.5", "2147483648", "9007199254740991", String(int(9))]),
      b: () => pick(["1", "2", "undefined", "0"]),
      c: () => pick([text(), "undefined"]),
      d: () => `"d${int(9)}"`,
      e: () => pick(["[]", "[1]", "[1, 2.5, -0]"]),
    };
    return `{ ${shuffle(keys)
      .map((k) => `${k}: ${value[k]()}`)
      .join(", ")} }`;
  };
  const lines = [ISLAND_PRELUDE];
  const vars = [];
  const all = () => `[${vars.join(", ")}]`;
  const declare = (declaration, name) => {
    lines.push(declaration);
    vars.push(name);
    lines.push(`obs("${name}", ${name}, ${all()});`);
  };
  declare(`const r0: R = ${literal()};`, "r0");
  const steps = 6 + int(8);
  for (let step = 0; step < steps; step++) {
    const src = pick(vars);
    const roll = next();
    const name = `r${vars.length}`;
    if (roll < 0.1) declare(`const ${name}: R = ${literal()};`, name);
    else if (roll < 0.3) {
      declare(
        `const ${name} = callSync<R>("./island.cjs", "${pick(["echo", "bump"])}", ${src});`,
        name,
      );
      lines.push(`obs("${src}'", ${src}, ${all()});`);
    } else if (roll < 0.4) {
      declare(`const ${name} = callSync<R>("./island.cjs", "merge", ${src}, ${pick(vars)});`, name);
    } else if (roll < 0.75) {
      lines.push(
        pick([
          `console.log("keys", callSync<string[]>("./island.cjs", "keys", ${src}).join(","));`,
          `console.log("describe", callSync<string>("./island.cjs", "describe", ${src}));`,
          `console.log("count", callSync<number>("./island.cjs", "count"));`,
          `console.log("optional", callSync<number | undefined>("./island.cjs", "optionalB", ${src}));`,
          `{ const w = callSync<{ wrapped: R; list: R[] }>("./island.cjs", "nested", ${src}); console.log("nested", JSON.stringify(w), w.list[0] === w.list[1], w.wrapped === ${src}); }`,
          `attempt("${pick(["TypeError", "RangeError", "Error", "SyntaxError"])}", "m${int(9)}");`,
        ]),
      );
    } else {
      lines.push(
        pick([
          `${src}.a = ${int(99)};`,
          `${src}.b = ${int(99)};`,
          `${src}.b = undefined;`,
          `${src}.c = ${text()};`,
          `${src}.e = [${int(9)}];`,
          `delete ${src}.b;`,
          `delete ${src}.c;`,
          `${src}.b ??= ${int(99)};`,
        ]),
      );
      lines.push(`obs("${src}'", ${src}, ${all()});`);
    }
  }
  const last = `r${vars.length}`;
  declare(`const ${last} = await call<R>("./island.cjs", "later", ${pick(vars)});`, last);
  return { "main.ts": `${lines.join("\n")}\n`, "island.cjs": ISLAND_MODULE };
}

export const generators = { records, numbers, islands };

/** Generators whose programs call into a Node island and so need a libnode
 * pack to run natively. */
export const needsLibnode = new Set(["islands"]);

/** The program `generator` emits for (seed, index) as a map from file name
 * to text; `main.ts` is the entry and starts with the command that emits the
 * program again. */
export function generate(generator, seed, index) {
  const emit = generators[generator];
  if (emit === undefined) throw new Error(`unknown generator '${generator}'`);
  const emitted = emit(seed, index);
  const files = typeof emitted === "string" ? { "main.ts": emitted } : emitted;
  const header = `// Generated: node tests/harness/generative/run.mjs emit ${generator} ${seed} ${index}\n`;
  return { ...files, "main.ts": header + files["main.ts"] };
}

/** A digest of what a generator emits, taken over a fixed sample. Baseline
 * keys name programs by (seed, index) and mean nothing across digests. */
export function generatorDigest(generator) {
  const hash = createHash("sha256");
  for (let index = 0; index < 16; index++) {
    const files = generate(generator, 1, index);
    for (const name of Object.keys(files).sort()) hash.update(files[name]);
  }
  return hash.digest("hex").slice(0, 16);
}
