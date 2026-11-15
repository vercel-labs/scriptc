/* The Node island value-crossing matrix: one small program per cell.
 *
 * A cell is (kind of value) x (direction it crosses) x (how the receiving
 * side types it). Its program makes the value on one side, crosses it, and
 * prints one labelled line per observation; the same program runs under
 * Node (the island package is then an ordinary package) and as a native
 * binary whose island package runs in the embedded Node. Every observation
 * is one source line, so a compiler refusal names the observation it
 * refuses and the rest of the cell still runs.
 *
 * The island package `mx` is generated per cell: `index.js` is the same for
 * every cell of a kind, `index.d.ts` declares the probes at the cell's
 * typing. */
import { KINDS, type Kind, type Read, type TypeSpec, type Val } from "./kinds.js";

export type Typing = "p" | "i" | "w" | "u";
export type Direction = "n2i" | "i2n" | "n2i2n" | "i2n2i" | "clo-n2i" | "clo-i2n" | "control";

export const DIRECTIONS: Direction[] = ["n2i", "i2n", "n2i2n", "i2n2i", "clo-n2i", "clo-i2n"];
export const TYPINGS: Typing[] = ["p", "i", "w", "u"];

export interface Line {
  code: string;
  /** Present on lines the runner may drop: an observation, or a binding. */
  label?: string;
  /** The name this line binds; lines that mention it depend on it. */
  defines?: string;
  /** A binding the cell exists for: refusing it refuses the cell. */
  setup?: boolean;
}

export interface Cell {
  id: string;
  kind: string;
  family: string;
  /** The direction, or "all" for a program that holds every direction of
   * one (kind, typing): its labels are then `<direction>/<label>`. */
  dir: Direction | "all";
  typing: Typing | "-";
  lines: Line[];
  /** Files beside main.ts, relative to the cell directory. */
  files: Record<string, string>;
}

const q = (s: string): string => JSON.stringify(s);
const sub = (expr: string, name: string, index: number): string =>
  expr.replace(/\bv\b/g, name).replace(/\bI\b/g, String(index));

// ------------------------------------------------------------ shared sources

/** Formatting shared by both sides (this text is TypeScript; `stripTypes`
 * makes the island's copy). */
const FMT_TS = `function fmt(x: unknown): string {
  if (typeof x === "string") return x.length > 200 ? JSON.stringify(x.slice(0, 160)) + "~" + x.length : JSON.stringify(x);
  if (typeof x === "number") return Object.is(x, -0) ? "-0" : String(x);
  if (typeof x === "bigint") return String(x) + "n";
  if (typeof x === "symbol") return x.toString();
  if (typeof x === "function") return "[function]";
  if (typeof x === "object" && x !== null) return "[object]";
  return String(x);
}
function errStr(e: unknown): string {
  return e instanceof Error ? e.name + ": " + e.message.split("\\n")[0] : "thrown " + fmt(e);
}`;

const FMT_JS = FMT_TS.replace(/\(x: unknown\): string/g, "(x)").replace(
  /\(e: unknown\): string/g,
  "(e)",
);

/** The program's generic observations on a value received as `unknown`. */
const U_HELPERS: [name: string, fact: string, body: string][] = [
  ["uTypeof", "typeof", `return typeof x;`],
  ["uIsArray", "isArray", `return String(Array.isArray(x));`],
  [
    "uStr",
    "str",
    `return typeof x === "symbol" ? x.toString() : typeof x === "function" ? "[function]" : fmt(String(x));`,
  ],
  ["uJson", "json", `return fmt(JSON.stringify(x));`],
  ["uTag", "tag", `return Object.prototype.toString.call(x);`],
  ["uKeys", "keys", `return typeof x === "object" && x !== null ? Object.keys(x).join(",") : "-";`],
  [
    "uForIn",
    "forin",
    `if (typeof x !== "object" || x === null) return "-"; const ks: string[] = []; for (const k in x) ks.push(k); return ks.join(",");`,
  ],
  [
    "uInst",
    "inst",
    `return [x instanceof Object, x instanceof Array, x instanceof Map, x instanceof Set, x instanceof Date, x instanceof RegExp, x instanceof Error, x instanceof Promise, x instanceof Uint8Array, x instanceof ArrayBuffer, x instanceof Function].map((b) => (b ? "1" : "0")).join("");`,
  ],
  [
    "uClone",
    "clone",
    `const c = structuredClone(x); return (c === x ? "same" : "fresh") + ":" + fmt(JSON.stringify(c));`,
  ],
];

/** The island's generic view of a value (JavaScript). */
const INSPECT_JS = `function inspect(v) {
  const out = [];
  const fact = (k, f) => { try { out.push(k + "=" + f()); } catch (e) { out.push(k + "=!" + errStr(e)); } };
  fact("typeof", () => typeof v);
  fact("isArray", () => Array.isArray(v));
  fact("str", () => (typeof v === "symbol" ? v.toString() : typeof v === "function" ? "[function]" : fmt(String(v))));
  fact("json", () => fmt(JSON.stringify(v)));
  fact("tag", () => Object.prototype.toString.call(v));
  if ((typeof v === "object" && v !== null) || typeof v === "function") {
    fact("keys", () => Object.keys(v).join(","));
    fact("forin", () => { const ks = []; for (const k in v) ks.push(k); return ks.join(","); });
    fact("own", () => Object.getOwnPropertyNames(v).join(","));
    fact("syms", () => Object.getOwnPropertySymbols(v).length);
    fact("inst", () => [Object, Array, Map, Set, Date, RegExp, Error, Promise, Uint8Array, ArrayBuffer, Function].map((C) => (v instanceof C ? "1" : "0")).join(""));
    fact("proto", () => { const p = Object.getPrototypeOf(v); return p === null ? "null" : p === Object.prototype ? "Object.prototype" : p === Array.prototype ? "Array.prototype" : p === Function.prototype ? "Function.prototype" : (p.constructor && p.constructor.name) || "?"; });
    fact("ctor", () => (v.constructor ? v.constructor.name : "none"));
    fact("ext", () => Object.isExtensible(v));
    fact("proxy", () => require("node:util").types.isProxy(v));
    fact("desc", () => { const k = Object.keys(v)[0]; if (k === undefined) return "-"; const d = Object.getOwnPropertyDescriptor(v, k); return d === undefined ? "undefined" : ("value" in d ? "data" : "accessor") + ":" + (d.writable ? "w" : "") + (d.enumerable ? "e" : "") + (d.configurable ? "c" : ""); });
  }
  fact("clone", () => { const c = structuredClone(v); return (c === v ? "same" : "fresh") + ":" + fmt(JSON.stringify(c)); });
  return out.join(" ;; ");
}`;

// --------------------------------------------------------------- island side

function readFnJs(name: string, reads: Read[], isAsync: boolean): string {
  const lines = reads.map(
    ([label, expr]) =>
      `  try { out.push(${q(label + "=")} + fmt(${expr})); } catch (e) { out.push(${q(label + "=!")} + errStr(e)); }`,
  );
  return `${isAsync ? "async " : ""}function ${name}(v) {\n  const out = [];\n${lines.join("\n")}\n  return out.join(" ;; ");\n}`;
}

export function islandJs(kind: Kind): string {
  const isAsync = kind.async === true;
  const aw = isAsync ? "await " : "";
  const as = isAsync ? "async " : "";
  const makers = kind.vals.map((val) =>
    val.isl === undefined ? "  null," : `  () => (${val.isl}),`,
  );
  const reads = [...kind.reads, ...(kind.islReads ?? [])];
  const reads2 = kind.reads2 ?? reads;
  return `"use strict";
${FMT_JS}
${INSPECT_JS}
${kind.jsPrelude ?? ""}
const MAKERS = [
${makers.join("\n")}
];
const kept = [];
${readFnJs("read", reads, isAsync)}
${readFnJs("read2", reads2, isAsync)}
function mutate(v) { ${kind.islWrite ?? ""} }
const same = (a, b) => (Object.is(a, b) ? "same" : a === b ? "equal" : "DIFFERENT");
exports.make = (i) => (kept[i] = MAKERS[i]());
exports.kept = (i) => kept[i];
exports.keep = (i, v) => (kept[i] = v);
exports.same = (i, v) => same(v, kept[i]);
exports.inspect = inspect;
exports.read = read;
exports.read2 = read2;
exports.inspectKept = (i) => inspect(kept[i]);
exports.readKept = (i) => read(kept[i]);
exports.readKept2 = (i) => read2(kept[i]);
exports.mutate = (i) => mutate(kept[i]);
exports.callThunk = ${as}(i, f) => { const r = f(); return "same=" + same(r, kept[i]) + " ;; " + inspect(r) + " ;; " + ${aw}read(r); };
exports.callWith = ${as}(i, f) => ${aw}f((kept[i] = MAKERS[i]()));
exports.thunk = (i) => { const r = (kept[i] = MAKERS[i]()); return () => r; };
exports.taker = () => ${as}(v) => inspect(v) + " ;; " + ${aw}read(v);
exports.iterWith = (i, f) => { const seen = []; for (const x of kept[i]) { seen.push(String(x)); if (seen.length === 1) f(); if (seen.length > 40) break; } return seen.join(";"); };
exports.raise = (v) => { throw v; };
exports.raiseKept = (i) => { throw kept[i]; };
exports.argc = function () { return arguments.length + ":" + Array.from(arguments, (a) => typeof a).join(","); };
${kind.extraJs ?? ""}
`;
}

export function islandDts(kind: Kind, spec: TypeSpec): string {
  const g = spec.generic === true;
  const P = g ? "T" : spec.t;
  const G = g ? "<T>" : "";
  const S = kind.async === true ? "Promise<string>" : "string";
  return `${kind.dtsPrelude ?? ""}
export declare function make${G}(i: number): ${P};
export declare function kept${G}(i: number): ${P};
export declare function keep${G}(i: number, v: ${P}): ${P};
export declare function same${G}(i: number, v: ${P}): string;
export declare function inspect${G}(v: ${P}): string;
export declare function read${G}(v: ${P}): ${S};
export declare function read2${G}(v: ${P}): ${S};
export declare function inspectKept(i: number): string;
export declare function readKept(i: number): ${S};
export declare function readKept2(i: number): ${S};
export declare function mutate(i: number): void;
export declare function callThunk${G}(i: number, f: () => ${P}): ${S};
export declare function callWith${G}(i: number, f: (x: ${P}) => ${S}): ${S};
export declare function thunk${G}(i: number): () => ${P};
export declare function taker${G}(): (v: ${P}) => ${S};
export declare function iterWith(i: number, f: () => void): string;
export declare function raise${G}(v: ${P}): void;
export declare function raiseKept(i: number): void;
export declare function argc${G}(v?: ${P}): string;
${kind.extraDts ?? ""}
`;
}

// -------------------------------------------------------------- program side

class Program {
  lines: Line[] = [];
  /** Appended to every name the program binds, so the bodies of several
   * directions share one module. */
  ns: string;
  /** Prefixed to every label. */
  prefix: string;
  constructor(ns = "", prefix = "") {
    this.ns = ns;
    this.prefix = prefix;
  }
  name(base: string, i?: number): string {
    return `${base}${i ?? ""}${this.ns}`;
  }
  raw(code: string): void {
    for (const line of code.split("\n")) this.lines.push({ code: line });
  }
  line(line: Line): void {
    this.lines.push(line.label === undefined ? line : { ...line, label: this.prefix + line.label });
  }
  /** `label: <fmt(expr)>`, or `label: !Error` when the expression throws. */
  obs(label: string, expr: string): void {
    const l = this.prefix + label;
    this.lines.push({
      label: l,
      code: `try { console.log(${q(l + ": ")} + fmt(${expr})); } catch (e) { console.log(${q(l + ": !")} + errStr(e)); }`,
    });
  }
  /** `label: <expr>` for an expression that is already a string of facts. */
  facts(label: string, expr: string): void {
    const l = this.prefix + label;
    this.lines.push({
      label: l,
      code: `try { console.log(${q(l + ": ")} + (${expr})); } catch (e) { console.log(${q(l + ": !")} + errStr(e)); }`,
    });
  }
  stmt(label: string, code: string): void {
    const l = this.prefix + label;
    this.lines.push({
      label: l,
      code: `try { ${code} console.log(${q(l + ": ok")}); } catch (e) { console.log(${q(l + ": !")} + errStr(e)); }`,
    });
  }
  def(label: string, name: string, init: string, setup = false, type?: string): void {
    const l = this.prefix + label;
    this.lines.push({
      label: l,
      defines: name,
      setup,
      code: `const ${name}${type === undefined ? "" : `: ${type}`} = ${init}; console.log(${q(l + ": ok")});`,
    });
  }
}

function typedReads(kind: Kind, typing: Typing): Read[] {
  if (typing === "w") return kind.readsW ?? [];
  if (typing === "u") return [];
  return [...kind.reads, ...(kind.natReads ?? [])];
}

function typedReads2(kind: Kind, typing: Typing): Read[] {
  if (typing === "w") return kind.readsW ?? [];
  if (typing === "u") return [];
  return kind.reads2 ?? [...kind.reads, ...(kind.natReads ?? [])];
}

function preciseSpec(kind: Kind): TypeSpec {
  return (kind.types.p ?? kind.types.i)!;
}

function specOf(kind: Kind, typing: Typing): TypeSpec | undefined {
  return typing === "u" ? { t: "unknown" } : kind.types[typing];
}

function uHelpers(p: Program): void {
  for (const [name, , body] of U_HELPERS)
    p.lines.push({
      defines: name,
      label: `helper.${name}`,
      code: `function ${name}(x: unknown): string { ${body} }`,
    });
}

function uObs(p: Program, prefix: string, name: string, suffix: string): void {
  for (const [helper, fact] of U_HELPERS)
    p.facts(`${prefix}.${fact}${suffix}`, `${helper}(${name})`);
}

/** A program function that reads a value at the cell's typing (for
 * callbacks the island calls, and for a value flowing into a program
 * function parameter): one fact per line. */
function readFnTs(p: Program, kind: Kind, typing: Typing, type: string): void {
  const isAsync = kind.async === true;
  p.raw(
    `${isAsync ? "async " : ""}function ${p.name("readN")}(it: ${type}): ${isAsync ? "Promise<string>" : "string"} {\n  const out: string[] = [];`,
  );
  if (typing === "u") {
    for (const [helper, fact] of U_HELPERS)
      p.line({
        label: `cb.U.${fact}`,
        code: `  try { out.push(${q(fact + "=")} + ${helper}(it)); } catch (e) { out.push(${q(fact + "=!")} + errStr(e)); }`,
      });
  } else {
    for (const [label, expr] of typedReads(kind, typing))
      p.line({
        label: `cb.${label}`,
        code: `  try { out.push(${q(label + "=")} + fmt(${sub(expr, "it", 0)})); } catch (e) { out.push(${q(label + "=!")} + errStr(e)); }`,
      });
  }
  p.raw(`  return out.join(" ;; ");\n}`);
}

const PROBES = [
  "make",
  "kept",
  "keep",
  "same",
  "inspect",
  "read",
  "read2",
  "inspectKept",
  "readKept",
  "readKept2",
  "mutate",
  "callThunk",
  "callWith",
  "thunk",
  "taker",
  "iterWith",
  "raise",
  "raiseKept",
  "argc",
  "sameBuf",
];

function suffixOf(kind: Kind, val: Val): string {
  return kind.vals.length > 1 ? `#${val.name}` : "";
}

/** `make`/`kept`/`thunk`/`taker` name their type argument when the island
 * declares them through a type parameter. */
function targ(spec: TypeSpec): string {
  return spec.generic === true ? `<${spec.t}>` : "";
}

/** Binds a program-made value: `p<i>` at the precise type and `v<i>` at the
 * cell's typing (the same binding for the precise typings). */
function bindNative(
  p: Program,
  kind: Kind,
  typing: Typing,
  val: Val,
  i: number,
  s: string,
): { v: string; precise: string } {
  const spec = specOf(kind, typing)!;
  const v = p.name("v", i);
  if (typing === "p" || typing === "i") {
    p.def(`S.make${s}`, v, val.nat!, true, spec.t);
    return { v, precise: v };
  }
  const precise = p.name("p", i);
  p.def(`S.make${s}`, precise, val.nat!, true, preciseSpec(kind).t);
  p.def(`S.widen${s}`, v, precise, true, spec.t);
  return { v, precise };
}

/** Reads of a program-held value at the cell's typing, one line each. */
function nativeReads(
  p: Program,
  kind: Kind,
  typing: Typing,
  prefix: string,
  name: string,
  i: number,
  s: string,
  second = false,
): void {
  const reads = second ? typedReads2(kind, typing) : typedReads(kind, typing);
  for (const [label, expr] of reads) p.obs(`${prefix}.${label}${s}`, sub(expr, name, i));
}

function natWriteOf(kind: Kind, typing: Typing): string | undefined {
  return typing === "w" ? kind.natWriteW : kind.natWrite;
}

const aw = (kind: Kind): string => (kind.async === true ? "await " : "");

const iterMut = (v: string, step: string): string =>
  `(() => { const seen: string[] = []; for (const x of ${v}) { seen.push(String(x)); if (seen.length === 1) { ${step} } if (seen.length > 40) break; } return seen.join(";"); })()`;

function cellN2I(p: Program, kind: Kind, typing: Typing): void {
  kind.vals.forEach((val, i) => {
    if (val.nat === undefined) return;
    const s = suffixOf(kind, val);
    const { v, precise } = bindNative(p, kind, typing, val, i, s);
    p.facts(`I.inspect${s}`, `inspect(${v})`);
    p.facts(`I.read${s}`, `${aw(kind)}read(${v})`);
    p.stmt(`I.keep${s}`, `keep(${i}, ${v});`);
    p.facts(`I.same${s}`, `same(${i}, ${v})`);
    if (typing === "p" || typing === "i")
      for (const [label, expr] of kind.extraN2I ?? []) p.obs(`${label}${s}`, sub(expr, v, i));
    if (kind.islWrite !== undefined && kind.ownerWrites !== true) {
      p.stmt(`W.isl${s}`, `mutate(${i});`);
      nativeReads(p, kind, typing, "N.read@isl", v, i, s, true);
      if (typing === "u" || typing === "w") {
        p.facts(`U.json@isl${s}`, `uJson(${v})`);
        nativeReads(p, kind, "p", "P.read@isl", precise, i, s, true);
      }
    }
    const write = typing === "u" ? kind.natWrite : (natWriteOf(kind, typing) ?? kind.natWrite);
    if (write !== undefined) {
      const target = typing === "u" || natWriteOf(kind, typing) === undefined ? precise : v;
      p.stmt(`W.nat${s}`, sub(write, target, i));
      p.facts(`I.read@nat${s}`, `${aw(kind)}readKept2(${i})`);
      p.facts(`I.inspect@nat${s}`, `inspectKept(${i})`);
      if (kind.ownerWrites === true) nativeReads(p, kind, typing, "N.read@nat", v, i, s, true);
    }
    if (kind.iterable === true && (typing === "p" || typing === "i")) {
      p.obs(`N.itermut${s}`, iterMut(v, `mutate(${i});`));
      if (kind.natWrite !== undefined)
        p.facts(`I.itermut${s}`, `iterWith(${i}, () => { ${sub(kind.natWrite, v, i)} })`);
    }
  });
}

function cellI2N(p: Program, kind: Kind, typing: Typing): void {
  const spec = specOf(kind, typing)!;
  const precise = preciseSpec(kind);
  // Program functions the value flows through at the cell's type.
  const flows = typing !== "u";
  const paramWrite = natWriteOf(kind, typing);
  const readN = p.name("readN");
  const identN = p.name("identN");
  const writeN = p.name("writeN");
  if (flows) {
    readFnTs(p, kind, typing, spec.t);
    p.line({
      label: "helper.identN",
      defines: identN,
      code: `function ${identN}(it: ${spec.t}): ${spec.t} { return it; }`,
    });
    if (paramWrite !== undefined && kind.ownerWrites !== true)
      p.line({
        label: "helper.writeN",
        defines: writeN,
        code: `function ${writeN}(it: ${spec.t}): void { ${sub(paramWrite, "it", 0)} }`,
      });
  }
  kind.vals.forEach((val, i) => {
    if (val.isl === undefined) return;
    const s = suffixOf(kind, val);
    const v = p.name("v", i);
    p.def(`S.make${s}`, v, `make${targ(spec)}(${i})`, true);
    nativeReads(p, kind, typing, "N.read", v, i, s);
    p.obs(`T.typeof${s}`, `typeof ${v}`);
    p.obs(`T.json${s}`, `JSON.stringify(${v})`);
    p.obs(`T.clone${s}`, `typeof structuredClone(${v})`);
    uObs(p, "U", v, s);
    if (flows) {
      p.facts(`N.param${s}`, `${aw(kind)}${readN}(${v})`);
      p.obs(`N.param.ident${s}`, `${identN}(${v}) === ${v}`);
      p.facts(`I.same@param${s}`, `same(${i}, ${identN}(${v}))`);
    }
    p.obs(
      `N.field.ident${s}`,
      `(() => { const box = { held: ${v} }; return box.held === ${v}; })()`,
    );
    p.facts(
      `I.same@field${s}`,
      `(() => { const box = { held: ${v} }; return same(${i}, box.held); })()`,
    );
    p.facts(`I.same@element${s}`, `(() => { const list = [${v}]; return same(${i}, list[0]); })()`);
    p.obs(`N.ident${s}`, `kept${targ(spec)}(${i}) === ${v}`);
    p.obs(`N.mapkey${s}`, `new Map<unknown, number>([[${v}, 1]]).get(kept${targ(spec)}(${i}))`);
    p.obs(`N.indexOf${s}`, `([${v}] as unknown[]).indexOf(kept${targ(spec)}(${i}))`);
    if (typing === "p" || typing === "i")
      for (const [label, expr] of kind.extraI2N ?? []) p.obs(`${label}${s}`, sub(expr, v, i));
    let target = v;
    if (typing === "u") {
      // The program narrows what it received as `unknown`: a checked cast.
      target = p.name("c", i);
      p.def(`N.cast${s}`, target, `${v} as ${precise.t}`);
      nativeReads(p, kind, "p", "N.cast.read", target, i, s);
      p.facts(`I.same@cast${s}`, `same(${i}, ${target})`);
    }
    if (kind.islWrite !== undefined) {
      p.stmt(`W.isl${s}`, `mutate(${i});`);
      nativeReads(p, kind, typing, "N.read@isl", v, i, s, true);
      p.facts(`U.json@isl${s}`, `uJson(${v})`);
      if (typing === "u") nativeReads(p, kind, "p", "N.cast.read@isl", target, i, s, true);
    }
    const write = typing === "u" ? kind.natWrite : natWriteOf(kind, typing);
    if (write !== undefined && kind.ownerWrites !== true) {
      p.stmt(`W.nat${s}`, sub(write, target, i));
      p.facts(`I.read@nat${s}`, `${aw(kind)}readKept2(${i})`);
      p.facts(`I.inspect@nat${s}`, `inspectKept(${i})`);
    }
    if (flows && paramWrite !== undefined && kind.ownerWrites !== true) {
      p.stmt(`W.param${s}`, `${writeN}(${v});`);
      p.facts(`I.read@param${s}`, `${aw(kind)}readKept2(${i})`);
    }
    if (kind.iterable === true && (typing === "p" || typing === "i")) {
      p.obs(`N.itermut${s}`, iterMut(v, `mutate(${i});`));
      if (kind.natWrite !== undefined)
        p.facts(`I.itermut${s}`, `iterWith(${i}, () => { ${sub(kind.natWrite, v, i)} })`);
    }
  });
}

function cellN2I2N(p: Program, kind: Kind, typing: Typing): void {
  kind.vals.forEach((val, i) => {
    if (val.nat === undefined) return;
    const s = suffixOf(kind, val);
    const { v, precise } = bindNative(p, kind, typing, val, i, s);
    const w = p.name("w", i);
    p.def(`S.back${s}`, w, `keep(${i}, ${v})`, true);
    p.obs(`N.ident${s}`, `${w} === ${v}`);
    p.obs(`N.is${s}`, `Object.is(${w}, ${v})`);
    p.obs(`N.mapkey${s}`, `new Map<unknown, number>([[${v}, 1]]).get(${w})`);
    p.obs(`N.indexOf${s}`, `([${v}] as unknown[]).indexOf(${w})`);
    nativeReads(p, kind, typing, "N.read", w, i, s);
    p.obs(`T.typeof${s}`, `typeof ${w}`);
    uObs(p, "U", w, s);
    const write = natWriteOf(kind, typing);
    if (write !== undefined && typing !== "u") {
      p.stmt(`W.back${s}`, sub(write, w, i));
      nativeReads(p, kind, "p", "P.read@back", precise, i, s, true);
    }
    if (kind.islWrite !== undefined && kind.ownerWrites !== true) {
      p.stmt(`W.isl${s}`, `mutate(${i});`);
      nativeReads(p, kind, typing, "N.read@isl", w, i, s, true);
    }
  });
}

function cellI2N2I(p: Program, kind: Kind, typing: Typing): void {
  const spec = specOf(kind, typing)!;
  kind.vals.forEach((val, i) => {
    if (val.isl === undefined) return;
    const s = suffixOf(kind, val);
    const v = p.name("v", i);
    // Pass-through: the program only hands the value back.
    p.def(`S.make${s}`, v, `make${targ(spec)}(${i})`, true);
    p.facts(`I.same${s}`, `same(${i}, ${v})`);
    p.facts(`I.inspect${s}`, `inspect(${v})`);
    p.facts(`I.read${s}`, `${aw(kind)}read(${v})`);
    // Mixed use: the program reads the value, then hands it back.
    const m = p.name("m", i);
    p.def(`S.make2${s}`, m, `make${targ(spec)}(${i})`);
    const first = typedReads(kind, typing)[0];
    if (first !== undefined) p.obs(`N.read@mixed.${first[0]}${s}`, sub(first[1], m, i));
    else p.obs(`N.read@mixed.typeof${s}`, `typeof ${m}`);
    p.facts(`I.same@mixed${s}`, `same(${i}, ${m})`);
    p.facts(`I.read@mixed${s}`, `${aw(kind)}read(${m})`);
  });
}

function cellCloN2I(p: Program, kind: Kind, typing: Typing): void {
  const spec = specOf(kind, typing)!;
  readFnTs(p, kind, typing, spec.t);
  kind.vals.forEach((val, i) => {
    const s = suffixOf(kind, val);
    if (val.nat !== undefined) {
      // The island calls a program closure that returns a program value.
      const { v } = bindNative(p, kind, typing, val, i, s);
      p.stmt(`I.keep${s}`, `keep(${i}, ${v});`);
      p.facts(`I.thunk${s}`, `${aw(kind)}callThunk(${i}, () => ${v})`);
    }
    if (val.isl !== undefined) {
      // The island calls a program callback with a value the island made.
      p.facts(
        `N.callback${s}`,
        `${aw(kind)}callWith(${i}, (x: ${spec.t}) => ${p.name("readN")}(x))`,
      );
      p.facts(`I.read@callback${s}`, `${aw(kind)}readKept(${i})`);
    }
  });
}

function cellCloI2N(p: Program, kind: Kind, typing: Typing): void {
  const spec = specOf(kind, typing)!;
  kind.vals.forEach((val, i) => {
    const s = suffixOf(kind, val);
    const g = p.name("g", i);
    p.def(`S.taker${s}`, g, `taker${targ(spec)}()`);
    if (val.isl !== undefined) {
      // The program calls an island closure that returns an island value.
      const f = p.name("f", i);
      const v = p.name("v", i);
      p.def(`S.thunk${s}`, f, `thunk${targ(spec)}(${i})`, true);
      p.def(`S.call${s}`, v, `${f}()`, true);
      nativeReads(p, kind, typing, "N.read", v, i, s);
      uObs(p, "U", v, s);
      p.obs(`N.ident${s}`, `${f}() === ${v}`);
      p.facts(`I.taker.back${s}`, `${aw(kind)}${g}(${v})`);
    }
    if (val.nat !== undefined) {
      // The program hands a program value to an island closure.
      const n = p.name("n", i);
      if (typing === "p" || typing === "i") p.def(`S.make${s}`, n, val.nat, false, spec.t);
      else {
        const precise = p.name("q", i);
        p.def(`S.make${s}`, precise, val.nat, false, preciseSpec(kind).t);
        p.def(`S.widen${s}`, n, precise, false, spec.t);
      }
      p.facts(`I.taker${s}`, `${aw(kind)}${g}(${n})`);
    }
  });
}

/** No crossing: the program makes the value and observes it itself. An
 * observation that differs from Node here is the native tier's, not the
 * boundary's. */
function cellControl(p: Program, kind: Kind): void {
  const precise = preciseSpec(kind);
  kind.vals.forEach((val, i) => {
    if (val.nat === undefined) return;
    const s = suffixOf(kind, val);
    const v = p.name("v", i);
    p.def(`S.make${s}`, v, val.nat, true, precise.t);
    nativeReads(p, kind, "p", "N.read", v, i, s);
    p.obs(`T.typeof${s}`, `typeof ${v}`);
    p.obs(`T.json${s}`, `JSON.stringify(${v})`);
    p.obs(`T.clone${s}`, `typeof structuredClone(${v})`);
    uObs(p, "U", v, s);
    // The value as a key of an untyped collection, as the crossing cells
    // observe it for a value that came back from the island.
    p.obs(`N.mapkey${s}`, `new Map<unknown, number>([[${v}, 1]]).get(${v})`);
    if (kind.types.w !== undefined) {
      p.def(`S.widen${s}`, p.name("w", i), v, false, kind.types.w.t);
      nativeReads(p, kind, "w", "W.read", p.name("w", i), i, s);
      // The wide type as a function's result has it: an assignment narrows
      // the binding above to the value's own type, a call does not. This is
      // what a wide-typed island function's result is to the program.
      const r = p.name("r", i);
      p.def(`S.result${s}`, r, `((x: ${kind.types.w.t}): ${kind.types.w.t} => x)(${v})`);
      nativeReads(p, kind, "w", "W.result.read", r, i, s);
      p.obs(`W.result.mapkey${s}`, `new Map<unknown, number>([[${v}, 1]]).get(${r})`);
    }
    p.def(`S.unknown${s}`, p.name("u", i), v, false, "unknown");
    p.def(`N.cast${s}`, p.name("c", i), `${p.name("u", i)} as ${precise.t}`);
    nativeReads(p, kind, "p", "N.cast.read", p.name("c", i), i, s);
    p.obs(`N.cast.ident${s}`, `${p.name("c", i)} === ${v}`);
    if (kind.natWrite !== undefined) {
      p.stmt(`W.nat${s}`, sub(kind.natWrite, v, i));
      nativeReads(p, kind, "p", "N.read@nat", v, i, s, true);
    }
    if (kind.iterable === true && kind.natWrite !== undefined)
      p.obs(`N.itermut${s}`, iterMut(v, sub(kind.natWrite, v, i)));
  });
}

const BUILDERS: Record<
  Exclude<Direction, "control">,
  (p: Program, kind: Kind, typing: Typing) => void
> = {
  n2i: cellN2I,
  i2n: cellI2N,
  n2i2n: cellN2I2N,
  i2n2i: cellI2N2I,
  "clo-n2i": cellCloN2I,
  "clo-i2n": cellCloI2N,
};

/** Whether the direction has anything to cross for this kind. */
function applies(kind: Kind, dir: Direction): boolean {
  const nat = kind.vals.some((val) => val.nat !== undefined);
  const isl = kind.vals.some((val) => val.isl !== undefined);
  switch (dir) {
    case "n2i":
    case "n2i2n":
      return nat;
    case "i2n":
    case "i2n2i":
      return isl;
    default:
      return nat || isl;
  }
}

/** The whole program of a cell: imports, the shared helpers, the kind's
 * declarations and the body. */
function finish(
  kind: Kind,
  dir: Cell["dir"],
  typing: Typing | "-",
  body: Program,
  spec: TypeSpec | null,
): Cell {
  const head = new Program();
  head.raw("// @requires-libnode");
  if (spec !== null) {
    const text = body.lines.map((l) => l.code).join("\n");
    const used = PROBES.filter((name) => new RegExp(`\\b${name}\\s*[<(]`).test(text));
    const imports = [...used, ...(kind.imports ?? [])];
    const typeNames = [...(kind.dtsPrelude ?? "").matchAll(/export interface (\w+)/g)]
      .map((m) => m[1]!)
      .filter((name) => new RegExp(`\\b${name}\\b`).test(text));
    head.raw(`import { ${imports.join(", ")} } from "mx";`);
    if (typeNames.length > 0) head.raw(`import type { ${typeNames.join(", ")} } from "mx";`);
  }
  head.raw(FMT_TS);
  head.raw(kind.prelude ?? "");
  uHelpers(head);
  const lines = [...head.lines, ...body.lines];
  const id = dir === "all" ? `${kind.id}.${typing}` : `${kind.id}.${dir}.${typing}`;
  const files: Record<string, string> = {
    "package.json":
      JSON.stringify(
        {
          name: "island-matrix-cell",
          private: true,
          type: "module",
          ...(spec === null ? {} : { scriptc: { packages: { mx: "node" } } }),
        },
        null,
        2,
      ) + "\n",
  };
  if (spec !== null) {
    files["node_modules/mx/package.json"] =
      `{ "name": "mx", "version": "1.0.0", "main": "index.js", "types": "index.d.ts" }\n`;
    files["node_modules/mx/index.js"] = islandJs(kind);
    files["node_modules/mx/index.d.ts"] = islandDts(kind, spec);
  }
  return { id, kind: kind.id, family: kind.family, dir, typing, lines, files };
}

/** Whether the kind has a control: its values can be made without the
 * island's own classes. */
function hasControl(kind: Kind): boolean {
  return kind.imports === undefined && kind.vals.some((val) => val.nat !== undefined);
}

function control(kind: Kind): Cell {
  const body = new Program();
  cellControl(body, kind);
  return finish(kind, "control", "-", body, null);
}

/** One program per cell: (kind, direction, typing). */
export function generate(): Cell[] {
  const cells: Cell[] = [];
  for (const kind of KINDS) {
    if (hasControl(kind)) cells.push(control(kind));
    for (const dir of DIRECTIONS) {
      if (!applies(kind, dir)) continue;
      for (const typing of TYPINGS) {
        const spec = specOf(kind, typing);
        if (spec === undefined) continue;
        const body = new Program();
        BUILDERS[dir as "n2i"](body, kind, typing);
        cells.push(finish(kind, dir, typing, body, spec));
      }
    }
  }
  return cells;
}

/** One program per (kind, typing) holding every direction: the form the
 * test suite pins. Labels are `<direction>/<label>`. */
export function generateGroups(): Cell[] {
  const cells: Cell[] = [];
  for (const kind of KINDS) {
    if (hasControl(kind)) cells.push(control(kind));
    for (const typing of TYPINGS) {
      const spec = specOf(kind, typing);
      if (spec === undefined) continue;
      const body = new Program();
      for (const dir of DIRECTIONS) {
        if (!applies(kind, dir)) continue;
        const part = new Program(`_${dir.replace("-", "")}`, `${dir}/`);
        BUILDERS[dir as "n2i"](part, kind, typing);
        body.lines.push(...part.lines);
      }
      cells.push(finish(kind, "all", typing, body, spec));
    }
  }
  return cells;
}

export function mainSource(lines: Line[], dropped: ReadonlySet<number> = new Set()): string {
  return lines.map((line, n) => (dropped.has(n) ? "" : line.code)).join("\n") + "\n";
}

export { KINDS };
