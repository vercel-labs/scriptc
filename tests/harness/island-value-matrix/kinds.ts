/* The value kinds of the Node island crossing matrix (see matrix.ts).
 *
 * Every kind names how the program makes the value (`nat`, TypeScript) and
 * how the island makes it (`isl`, JavaScript), the types it is declared at,
 * and the observations made on it. A read is an expression over `v` that is
 * valid both as TypeScript at the kind's precise type and as JavaScript, so
 * the same text runs natively and inside the island. */

export type Read = [label: string, expr: string];

export interface TypeSpec {
  /** The type as the program spells it. */
  t: string;
  /** The island's signatures take it through a type parameter (a type the
   * program declares cannot be named in the island's declarations). */
  generic?: boolean;
}

export interface Val {
  name: string;
  /** Program-side maker (TypeScript expression); absent when only the island can make it. */
  nat?: string;
  /** Island-side maker (JavaScript expression); absent when only the program can make it. */
  isl?: string;
}

export interface Kind {
  id: string;
  family: string;
  /** Program declarations. */
  prelude?: string;
  /** Island declarations (JavaScript). */
  jsPrelude?: string;
  /** Island declaration file additions. */
  dtsPrelude?: string;
  /** Value imports the program needs from the island beyond the probes. */
  imports?: string[];
  /** p: the precise type as its natural owner declares it (a standard
   * library type, or a program type through a type parameter); i: the
   * island's own declared type; w: a wider type. `unknown` always applies. */
  types: { p?: TypeSpec; i?: TypeSpec; w?: TypeSpec };
  vals: Val[];
  reads: Read[];
  /** Reads valid at the wide type. */
  readsW?: Read[];
  /** Reads only the program can spell. */
  natReads?: Read[];
  /** Reads only the island can spell. */
  islReads?: Read[];
  /** Reads after a write (default: `reads`). */
  reads2?: Read[];
  /** A write the program makes (statements over `v`). */
  natWrite?: string;
  natWriteW?: string;
  /** A write the island makes (statements over `v`). */
  islWrite?: string;
  /** Only the side that made the value can write it (a pending promise's resolver). */
  ownerWrites?: boolean;
  /** Reads use `await`. */
  async?: boolean;
  /** `for…of` applies: mutation during iteration from the other side. */
  iterable?: boolean;
  /** Extra observations: [label, expression over v (and I, the value index)]. */
  extraN2I?: Read[];
  extraI2N?: Read[];
  extraDts?: string;
  extraJs?: string;
}

const REC = `{ a: 1, b: "x", c: true }`;
const REC_PRELUDE = `interface Rec { a: number; b: string; c: boolean }\ninterface RecA { a: number }`;
const REC_DTS = `export interface IRec { a: number; b: string; c: boolean }`;
const keys: Read = ["keys", `Object.keys(v).join(",")`];
const json: Read = ["json", `JSON.stringify(v)`];
const len: Read = ["len", `v.length`];
const typeOf: Read = ["typeof", `typeof v`];

export const KINDS: Kind[] = [
  // ---------------------------------------------------------------- primitives
  {
    id: "num",
    family: "primitive",
    prelude: `function mul(a: number, b: number): number { return a * b; }`,
    jsPrelude: `function mul(a, b) { return a * b; }`,
    types: { p: { t: "number" }, w: { t: "number | string" } },
    vals: [
      ["zero", "0"],
      ["negzero", "-0"],
      ["i42", "42"],
      ["dbl", "1.5"],
      ["nan", "NaN"],
      ["inf", "Infinity"],
      ["i31", "2147483647"],
      ["p31", "2147483648"],
      ["u32", "4294967295"],
      ["p53", "9007199254740992"],
      ["max", "1.7976931348623157e308"],
      ["laneNegZero", "mul(0, -1)"],
      [
        "laneOverflow",
        "(() => { let s = 2147483000; for (let k = 0; k < 1000; k++) s += 1; return s; })()",
      ],
    ].map(([name, e]) => ({ name: name!, nat: e!, isl: e! })),
    reads: [
      ["str", "String(v)"],
      ["negz", "Object.is(v, -0)"],
      ["int", "Number.isInteger(v)"],
      ["or0", "v | 0"],
      ["add", "v + 1"],
      ["hex", "v.toString(16)"],
      ["self", "v === v"],
      typeOf,
    ],
    readsW: [["str", "String(v)"], typeOf, ["negz", "Object.is(v, -0)"]],
  },
  {
    id: "bigint",
    family: "primitive",
    types: { p: { t: "bigint" }, w: { t: "bigint | number" } },
    vals: [
      ["zero", "0n"],
      ["neg", "-1n"],
      ["p64", "2n ** 64n"],
      ["n127", "-(2n ** 127n)"],
      ["odd", "9007199254740993n"],
    ].map(([name, e]) => ({ name: name!, nat: e!, isl: e! })),
    reads: [
      ["str", "String(v)"],
      typeOf,
      ["add", "v + 1n"],
      ["self", "v === v"],
      ["neg", "-v"],
      ["i64", "BigInt.asIntN(64, v)"],
    ],
    readsW: [["str", "String(v)"], typeOf],
  },
  {
    id: "str",
    family: "primitive",
    types: { p: { t: "string" }, w: { t: "string | number" } },
    vals: [
      ["empty", `""`],
      ["ascii", `"hello"`],
      ["latin", `"h\\u00e9llo"`],
      ["astral", `"\\u{1F600}x\\u{1D4B3}"`],
      ["loneHi", `"a\\ud83d"`],
      ["loneLo", `"\\udc00b"`],
      ["revPair", `"\\udc00\\ud83d"`],
      ["nul", `"a\\u0000b"`],
      ["bom", `"\\ufeffx"`],
      ["digits", `"123"`],
      ["long", `"ab".repeat(60000)`],
      [
        "rope",
        `(() => { let s = ""; for (let k = 0; k < 2000; k++) s += String.fromCharCode(97 + (k % 26)) + (k % 7 === 0 ? "\\u{1F600}" : ""); return s; })()`,
      ],
    ].map(([name, e]) => ({ name: name!, nat: e!, isl: e! })),
    reads: [
      len,
      ["val", "v"],
      ["cc0", "v.charCodeAt(0)"],
      ["ccL", "v.charCodeAt(v.length - 1)"],
      ["cp0", "v.codePointAt(0)"],
      ["spread", "[...v].length"],
      ["jsonLen", "JSON.stringify(v).length"],
      ["wf", "v.isWellFormed()"],
      ["up", "v.toUpperCase().length"],
      ["utf8", "Buffer.byteLength(v)"],
      ["enc", "new TextEncoder().encode(v).length"],
      [
        "hash",
        "(() => { let h = 0; for (let k = 0; k < v.length; k++) h = (h * 31 + v.charCodeAt(k)) | 0; return h; })()",
      ],
      ["cat", `(v + "!").length`],
      ["self", "v === v"],
    ],
    readsW: [["str", "String(v).length"], typeOf],
  },
  {
    id: "bool",
    family: "primitive",
    types: { p: { t: "boolean" }, w: { t: "boolean | string" } },
    vals: [
      { name: "t", nat: "true", isl: "true" },
      { name: "f", nat: "false", isl: "false" },
    ],
    reads: [["str", "String(v)"], typeOf, ["not", "!v"]],
    readsW: [["str", "String(v)"], typeOf],
  },
  {
    id: "undef",
    family: "primitive",
    types: { p: { t: "number | undefined" }, w: { t: "number | string | undefined" } },
    vals: [{ name: "u", nat: "undefined", isl: "undefined" }],
    reads: [["str", "String(v)"], ["isU", "v === undefined"], ["isN", "v === null"], typeOf],
    readsW: [["str", "String(v)"], typeOf],
    extraN2I: [
      ["I.argc.passed", "argc(v)"],
      ["I.argc.omitted", "argc()"],
    ],
  },
  {
    id: "null",
    family: "primitive",
    types: { p: { t: "number | null" }, w: { t: "number | string | null" } },
    vals: [{ name: "n", nat: "null", isl: "null" }],
    reads: [["str", "String(v)"], ["isU", "v === undefined"], ["isN", "v === null"], typeOf],
    readsW: [["str", "String(v)"], typeOf],
    extraN2I: [["I.argc.passed", "argc(v)"]],
  },
  {
    id: "sym",
    family: "primitive",
    types: { p: { t: "symbol" }, w: { t: "symbol | string" } },
    vals: [
      { name: "local", nat: `Symbol("loc")`, isl: `Symbol("loc")` },
      { name: "registered", nat: `Symbol.for("reg")`, isl: `Symbol.for("reg")` },
      { name: "wellknown", nat: `Symbol.iterator`, isl: `Symbol.iterator` },
      { name: "nodesc", nat: `Symbol()`, isl: `Symbol()` },
    ],
    reads: [
      ["str", "v.toString()"],
      ["desc", "v.description"],
      typeOf,
      ["keyFor", "Symbol.keyFor(v)"],
      ["isReg", `v === Symbol.for("reg")`],
      ["isWk", "v === Symbol.iterator"],
      ["asKey", "Object.getOwnPropertySymbols({ [v]: 1 }).length"],
      ["self", "v === v"],
    ],
    readsW: [typeOf],
  },
  // ------------------------------------------------------------------- records
  {
    id: "rec",
    family: "record",
    prelude: REC_PRELUDE,
    dtsPrelude: REC_DTS,
    types: {
      p: { t: "Rec", generic: true },
      i: { t: "IRec" },
      w: { t: "RecA", generic: true },
    },
    vals: [{ name: "abc", nat: REC, isl: REC }],
    reads: [
      ["a", "v.a"],
      ["b", "v.b"],
      ["c", "v.c"],
      keys,
      json,
      ["inA", `"a" in v`],
      ["nvals", "Object.values(v).length"],
      ["entries", `Object.entries(v).map(([k, x]) => k + "=" + String(x)).join(",")`],
      ["spread", `Object.keys({ ...v }).join(",")`],
      ["destr", "(({ a, b }) => b + String(a))(v)"],
    ],
    readsW: [["a", "v.a"], keys, json],
    natWrite: `v.a = 100; v.b = "nat";`,
    natWriteW: `v.a = 100;`,
    islWrite: `v.a = 200; v.b = "isl";`,
  },
  {
    id: "rec-opt",
    family: "record",
    prelude: `interface RecO { a: number; b?: string; c?: number | undefined; d: string | null }\ninterface RecA { a: number }`,
    dtsPrelude: `export interface IRecO { a: number; b?: string; c?: number | undefined; d: string | null }`,
    types: {
      p: { t: "RecO", generic: true },
      i: { t: "IRecO" },
      w: { t: "RecA", generic: true },
    },
    vals: [
      { name: "absent", nat: `{ a: 1, d: null }`, isl: `{ a: 1, d: null }` },
      {
        name: "undef",
        nat: `{ a: 1, b: undefined, c: undefined, d: null }`,
        isl: `{ a: 1, b: undefined, c: undefined, d: null }`,
      },
      {
        name: "full",
        nat: `{ a: 1, b: "x", c: 2, d: "y" }`,
        isl: `{ a: 1, b: "x", c: 2, d: "y" }`,
      },
    ],
    reads: [
      ["b", "v.b"],
      ["c", "v.c"],
      ["d", "v.d"],
      ["inB", `"b" in v`],
      ["inC", `"c" in v`],
      ["hasB", `Object.hasOwn(v, "b")`],
      keys,
      json,
      ["bU", "v.b === undefined"],
      ["dN", "v.d === null"],
      ["bq", `v.b ?? "dflt"`],
    ],
    readsW: [["a", "v.a"], keys, json],
    natWrite: `v.b = "nb"; v.d = "nd";`,
    natWriteW: `v.a = 100;`,
    islWrite: `v.c = 5; delete v.b; v.d = null;`,
  },
  {
    id: "rec-idx",
    family: "record",
    types: { p: { t: "Record<string, number>" }, w: { t: "Record<string, unknown>" } },
    vals: [
      { name: "xy", nat: `{ x: 1, y: 2 }`, isl: `{ x: 1, y: 2 }` },
      {
        name: "order",
        nat: `{ b: 1, "2": 2, a: 3, "1": 4 }`,
        isl: `{ b: 1, "2": 2, a: 3, "1": 4 }`,
      },
      { name: "empty", nat: `{}`, isl: `{}` },
      { name: "nullproto", isl: `Object.assign(Object.create(null), { x: 1, y: 2 })` },
    ],
    reads: [
      ["x", "v.x"],
      ["y", `v["y"]`],
      ["nope", "v.nope === undefined"],
      keys,
      json,
      ["inX", `"x" in v`],
      ["n", "Object.keys(v).length"],
      ["vals", `Object.values(v).join(",")`],
    ],
    readsW: [keys, json, ["n", "Object.keys(v).length"]],
    natWrite: `v.k = 5; v.x = 10; v["7"] = 7;`,
    natWriteW: `v.k = "w";`,
    islWrite: `v.q = 7; delete v.y; v["3"] = 3;`,
  },
  {
    id: "rec-extra",
    family: "record",
    prelude: `${REC_PRELUDE}\nconst wideSrc = { a: 1, b: "x", c: true, extra: 5, "0": "zero" };`,
    dtsPrelude: REC_DTS,
    types: { p: { t: "Rec", generic: true }, i: { t: "IRec" } },
    vals: [
      { name: "extra", nat: `wideSrc`, isl: `{ a: 1, b: "x", c: true, extra: 5, 0: "zero" }` },
    ],
    reads: [
      ["a", "v.a"],
      keys,
      json,
      ["n", "Object.keys(v).length"],
      ["inExtra", `"extra" in v`],
      ["entries", "Object.entries(v).length"],
    ],
    natWrite: `v.a = 3;`,
    islWrite: `v.added = 1; v.a = 2;`,
  },
  {
    id: "rec-nested",
    family: "record",
    prelude: `interface Inner { n: number; tags: string[] }\ninterface Outer { id: number; inner: Inner; list: { k: string }[] }\ninterface OuterId { id: number }`,
    dtsPrelude: `export interface IInner { n: number; tags: string[] }\nexport interface IOuter { id: number; inner: IInner; list: { k: string }[] }`,
    types: {
      p: { t: "Outer", generic: true },
      i: { t: "IOuter" },
      w: { t: "OuterId", generic: true },
    },
    vals: [
      {
        name: "nested",
        nat: `{ id: 1, inner: { n: 5, tags: ["t"] }, list: [{ k: "k0" }] }`,
        isl: `{ id: 1, inner: { n: 5, tags: ["t"] }, list: [{ k: "k0" }] }`,
      },
    ],
    reads: [
      ["n", "v.inner.n"],
      ["tags", `v.inner.tags.join(",")`],
      ["ll", "v.list.length"],
      ["k0", "v.list[0].k"],
      ["innerId", "v.inner === v.inner"],
      ["listId", "v.list === v.list"],
      ["elId", "v.list[0] === v.list[0]"],
      ["tagsId", "v.inner.tags === v.inner.tags"],
      json,
    ],
    readsW: [["id", "v.id"], keys, json],
    natWrite: `v.inner.n = 50; v.inner.tags.push("nt"); v.list.push({ k: "nk" });`,
    natWriteW: `v.id = 9;`,
    islWrite: `v.inner.n = 60; v.inner.tags.push("it"); v.list[0].k = "ik";`,
  },
  {
    id: "rec-acc",
    family: "record",
    prelude: `interface Acc { n: number; readonly twice: number; bump(): number }`,
    dtsPrelude: `export interface IAcc { n: number; readonly twice: number; bump(): number }`,
    types: { p: { t: "Acc", generic: true }, i: { t: "IAcc" } },
    vals: [
      {
        name: "acc",
        nat: `{ n: 1, get twice() { return this.n * 2; }, bump() { this.n++; return this.n; } }`,
        isl: `{ n: 1, get twice() { return this.n * 2; }, bump() { this.n++; return this.n; } }`,
      },
    ],
    reads: [["n", "v.n"], ["twice", "v.twice"], ["bump", "v.bump()"], ["n2", "v.n"], keys, json],
    natWrite: `v.n = 10;`,
    islWrite: `v.n = 20;`,
  },
  {
    id: "rec-frozen",
    family: "record",
    prelude: `interface Frz { readonly a: number; readonly list: number[] }`,
    dtsPrelude: `export interface IFrz { readonly a: number; readonly list: number[] }`,
    types: { p: { t: "Frz", generic: true }, i: { t: "IFrz" } },
    vals: [
      {
        name: "frozen",
        nat: `Object.freeze({ a: 1, list: [1] })`,
        isl: `Object.freeze({ a: 1, list: [1] })`,
      },
    ],
    reads: [["a", "v.a"], ["frozen", "Object.isFrozen(v)"], keys, json, ["ll", "v.list.length"]],
    natWrite: `v.list.push(2);`,
    islWrite: `v.a = 2;`,
  },
  // -------------------------------------------------------------------- arrays
  {
    id: "arr-num",
    family: "array",
    types: { p: { t: "number[]" }, w: { t: "unknown[]" } },
    vals: [
      { name: "three", nat: `[1, 2, 3]`, isl: `[1, 2, 3]` },
      { name: "empty", nat: `[]`, isl: `[]` },
      {
        name: "big",
        nat: `Array.from({ length: 300 }, (_, k) => k)`,
        isl: `Array.from({ length: 300 }, (_, k) => k)`,
      },
    ],
    reads: [
      len,
      ["i0", "v[0]"],
      ["join", `v.join(",")`],
      ["idx", "v.indexOf(2)"],
      ["inc", "v.includes(3)"],
      ["map", `v.map((x) => x * 2).join(",")`],
      ["spread", "[...v].length"],
      ["isArr", "Array.isArray(v)"],
      json,
      ["slice", "v.slice(1).length"],
      ["keys", `Object.keys(v).length`],
      ["sum", "v.reduce((s, x) => s + x, 0)"],
      ["last", "v.at(-1)"],
      ["forof", "(() => { let s = 0; for (const x of v) s += x; return s; })()"],
      ["oob", "v[99999] === undefined"],
    ],
    readsW: [len, ["isArr", "Array.isArray(v)"], json],
    natWrite: `v.push(9); v[0] = 7;`,
    natWriteW: `v.push("w");`,
    islWrite: `v.push(8); v[1] = 5;`,
    iterable: true,
  },
  {
    id: "arr-str",
    family: "array",
    types: { p: { t: "string[]" }, w: { t: "unknown[]" } },
    vals: [{ name: "strs", nat: `["a", "b", ""]`, isl: `["a", "b", ""]` }],
    reads: [len, ["i0", "v[0]"], ["join", `v.join("|")`], json, ["isArr", "Array.isArray(v)"]],
    readsW: [len, json],
    natWrite: `v.push("n");`,
    islWrite: `v.push("i"); v[0] = "z";`,
    iterable: true,
  },
  {
    id: "arr-rec",
    family: "array",
    prelude: REC_PRELUDE,
    dtsPrelude: REC_DTS,
    types: { p: { t: "Rec[]", generic: true }, i: { t: "IRec[]" } },
    vals: [
      {
        name: "recs",
        nat: `[{ a: 1, b: "x", c: true }, { a: 2, b: "y", c: false }]`,
        isl: `[{ a: 1, b: "x", c: true }, { a: 2, b: "y", c: false }]`,
      },
    ],
    reads: [
      len,
      ["a0", "v[0].a"],
      ["as", `v.map((r) => r.a).join(",")`],
      ["elId", "v[0] === v[0]"],
      ["idx", "v.indexOf(v[1])"],
      json,
      ["find", "v.find((r) => r.a === 2)?.b"],
    ],
    natWrite: `v[0].a = 100; v.push({ a: 3, b: "n", c: false });`,
    islWrite: `v[1].a = 200; v.push({ a: 4, b: "i", c: true });`,
  },
  {
    id: "arr-mixed",
    family: "array",
    types: { p: { t: "(number | string | null)[]" }, w: { t: "unknown[]" } },
    vals: [{ name: "mixed", nat: `[1, "two", null, 3.5]`, isl: `[1, "two", null, 3.5]` }],
    reads: [
      len,
      ["t0", "typeof v[0]"],
      ["t1", "typeof v[1]"],
      ["n2", "v[2] === null"],
      ["join", `v.join("|")`],
      json,
    ],
    readsW: [len, json],
    natWrite: `v.push("n");`,
    islWrite: `v.push(null); v[0] = "s";`,
  },
  {
    id: "arr-holes",
    family: "array",
    types: { p: { t: "(number | undefined)[]" } },
    vals: [
      { name: "holes", nat: `[1, , 3]`, isl: `[1, , 3]` },
      { name: "undef", nat: `[1, undefined, 3]`, isl: `[1, undefined, 3]` },
    ],
    reads: [
      len,
      ["in1", "1 in v"],
      ["u1", "v[1] === undefined"],
      ["keys", `Object.keys(v).join(",")`],
      json,
      ["join", `v.join("-")`],
      ["mapn", "v.map(() => 1).length"],
      ["each", "(() => { let n = 0; v.forEach(() => { n++; }); return n; })()"],
      ["fi", "v.findIndex((x) => x === undefined)"],
    ],
  },
  {
    id: "arr-nested",
    family: "array",
    types: { p: { t: "number[][]" }, w: { t: "unknown[]" } },
    vals: [{ name: "nested", nat: `[[1, 2], [3]]`, isl: `[[1, 2], [3]]` }],
    reads: [
      len,
      ["l0", "v[0].length"],
      ["x", "v[1][0]"],
      ["elId", "v[0] === v[0]"],
      ["flat", `v.flat().join(",")`],
      json,
    ],
    readsW: [len, json],
    natWrite: `v[0].push(9); v.push([7]);`,
    islWrite: `v[1].push(8); v[0][0] = 5;`,
  },
  {
    id: "tuple",
    family: "array",
    types: { p: { t: "[number, string]" }, w: { t: "[number, string, boolean?]" } },
    vals: [{ name: "pair", nat: `[1, "a"]`, isl: `[1, "a"]` }],
    reads: [
      ["t0", "v[0]"],
      ["t1", "v[1]"],
      len,
      json,
      ["isArr", "Array.isArray(v)"],
      ["destr", "(([x, y]) => y + String(x))(v)"],
    ],
    readsW: [len, json],
    natWrite: `v[0] = 10;`,
    natWriteW: `v[0] = 11;`,
    islWrite: `v[1] = "isl";`,
  },
  {
    id: "tuple-opt",
    family: "array",
    types: { p: { t: "[number, string?]" } },
    vals: [
      { name: "one", nat: `[1]`, isl: `[1]` },
      { name: "two", nat: `[1, "b"]`, isl: `[1, "b"]` },
    ],
    reads: [len, ["u1", "v[1] === undefined"], json],
  },
  {
    id: "tuple-rec",
    family: "array",
    prelude: REC_PRELUDE,
    dtsPrelude: REC_DTS,
    types: { p: { t: "[Rec, number[]]", generic: true }, i: { t: "[IRec, number[]]" } },
    vals: [
      {
        name: "pair",
        nat: `[{ a: 1, b: "x", c: true }, [1, 2]]`,
        isl: `[{ a: 1, b: "x", c: true }, [1, 2]]`,
      },
    ],
    reads: [["a", "v[0].a"], ["xl", "v[1].length"], ["elId", "v[0] === v[0]"], json],
    natWrite: `v[0].a = 100; v[1].push(3);`,
    islWrite: `v[0].a = 200; v[1].push(4);`,
  },
  // --------------------------------------------------------------------- bytes
  {
    id: "u8",
    family: "bytes",
    types: { p: { t: "Uint8Array" }, w: { t: "Uint8Array | string" } },
    vals: [
      { name: "four", nat: `new Uint8Array([1, 2, 3, 4])`, isl: `new Uint8Array([1, 2, 3, 4])` },
      {
        name: "sub",
        nat: `new Uint8Array([0, 1, 2, 3, 4, 5]).subarray(2, 5)`,
        isl: `new Uint8Array([0, 1, 2, 3, 4, 5]).subarray(2, 5)`,
      },
      { name: "empty", nat: `new Uint8Array(0)`, isl: `new Uint8Array(0)` },
    ],
    reads: [
      len,
      ["i0", "v[0]"],
      ["bl", "v.byteLength"],
      ["bo", "v.byteOffset"],
      ["join", `v.join(",")`],
      ["bufLen", "v.buffer.byteLength"],
      ["isU8", "v instanceof Uint8Array"],
      ["isBuf", "Buffer.isBuffer(v)"],
      ["isView", "ArrayBuffer.isView(v)"],
      ["bufId", "v.buffer === v.buffer"],
      ["alias", "new Uint8Array(v.buffer)[v.byteOffset]"],
      ["sub", "v.subarray(1).length"],
      ["subBuf", "v.subarray(0, 1).buffer === v.buffer"],
      json,
    ],
    readsW: [typeOf],
    natWrite: `if (v.length > 2) { v[0] = 100; v.fill(7, 2); }`,
    islWrite: `if (v.length > 2) { v[1] = 200; v.set([9], v.length - 1); }`,
    iterable: true,
    extraN2I: [["I.bufSame", "sameBuf(v, v.buffer)"]],
    extraDts: `export declare function sameBuf(view: Uint8Array, buf: ArrayBufferLike): boolean;`,
    extraJs: `exports.sameBuf = (view, buf) => view.buffer === buf;`,
  },
  {
    id: "f64",
    family: "bytes",
    types: { p: { t: "Float64Array" } },
    vals: [
      {
        name: "f64",
        nat: `new Float64Array([1.5, -0, NaN, 1e300])`,
        isl: `new Float64Array([1.5, -0, NaN, 1e300])`,
      },
    ],
    reads: [
      ["f0", "v[0]"],
      ["negz", "Object.is(v[1], -0)"],
      ["nan", "v[2]"],
      ["big", "v[3]"],
      len,
      ["bl", "v.byteLength"],
      ["bpe", "v.BYTES_PER_ELEMENT"],
      ["isF64", "v instanceof Float64Array"],
    ],
    natWrite: `v[0] = 2.5;`,
    islWrite: `v[3] = -1;`,
  },
  {
    id: "i32",
    family: "bytes",
    types: { p: { t: "Int32Array" } },
    vals: [
      {
        name: "i32",
        nat: `new Int32Array([-1, 2147483647, -2147483648])`,
        isl: `new Int32Array([-1, 2147483647, -2147483648])`,
      },
    ],
    reads: [["i0", "v[0]"], ["i1", "v[1]"], ["i2", "v[2]"], len, ["bl", "v.byteLength"]],
    natWrite: `v[0] = 5;`,
    islWrite: `v[1] = 6;`,
  },
  {
    id: "f32",
    family: "bytes",
    types: { p: { t: "Float32Array" } },
    vals: [
      {
        name: "f32",
        nat: `new Float32Array([0.1, 16777217])`,
        isl: `new Float32Array([0.1, 16777217])`,
      },
    ],
    reads: [["f0", "v[0]"], ["f1", "v[1]"], len],
    natWrite: `v[0] = 0.5;`,
    islWrite: `v[1] = 0.25;`,
  },
  {
    id: "big64",
    family: "bytes",
    types: { p: { t: "BigInt64Array" } },
    vals: [
      {
        name: "b64",
        nat: `new BigInt64Array([1n, -1n])`,
        isl: `new BigInt64Array([1n, -1n])`,
      },
    ],
    reads: [["b0", "v[0]"], ["b1", "v[1]"], len],
    natWrite: `v[0] = 5n;`,
    islWrite: `v[1] = 6n;`,
  },
  {
    id: "dataview",
    family: "bytes",
    types: { p: { t: "DataView" } },
    vals: [
      {
        name: "dv",
        nat: `new DataView(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer, 2, 4)`,
        isl: `new DataView(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer, 2, 4)`,
      },
    ],
    reads: [
      ["bl", "v.byteLength"],
      ["bo", "v.byteOffset"],
      ["u8", "v.getUint8(0)"],
      ["u16le", "v.getUint16(0, true)"],
      ["i16", "v.getInt16(2)"],
      ["bufLen", "v.buffer.byteLength"],
    ],
    natWrite: `v.setUint8(0, 100);`,
    islWrite: `v.setUint8(1, 200);`,
  },
  {
    id: "arraybuffer",
    family: "bytes",
    prelude: `function filled(b: ArrayBuffer): ArrayBuffer { new Uint8Array(b).set([1, 2, 3, 4]); return b; }`,
    jsPrelude: `function filled(b) { new Uint8Array(b).set([1, 2, 3, 4]); return b; }`,
    types: { p: { t: "ArrayBuffer" } },
    vals: [{ name: "ab", nat: `filled(new ArrayBuffer(4))`, isl: `filled(new ArrayBuffer(4))` }],
    reads: [
      ["bl", "v.byteLength"],
      ["first", "new Uint8Array(v)[0]"],
      ["isAB", "v instanceof ArrayBuffer"],
      ["slice", "v.slice(1).byteLength"],
    ],
    natWrite: `new Uint8Array(v)[0] = 100;`,
    islWrite: `new Uint8Array(v)[1] = 200;`,
  },
  {
    id: "buffer",
    family: "bytes",
    types: { p: { t: "Buffer" }, w: { t: "Uint8Array" } },
    vals: [
      { name: "from", nat: `Buffer.from("hello")`, isl: `Buffer.from("hello")` },
      { name: "alloc", nat: `Buffer.alloc(4, 1)`, isl: `Buffer.alloc(4, 1)` },
    ],
    reads: [
      len,
      ["str", "v.toString()"],
      ["hex", `v.toString("hex")`],
      ["isBuf", "Buffer.isBuffer(v)"],
      ["isU8", "v instanceof Uint8Array"],
      ["i0", "v[0]"],
      ["r1", "v.readUInt8(1)"],
      ["sub", "v.subarray(1, 3).toString()"],
      ["eq", `v.equals(Buffer.from("hello"))`],
      json,
    ],
    readsW: [len, ["i0", "v[0]"], ["isBuf", "Buffer.isBuffer(v)"]],
    natWrite: `v[0] = 72; v.write("y", 1);`,
    natWriteW: `v[0] = 73;`,
    islWrite: `v[2] = 76;`,
  },
  {
    id: "sab",
    family: "bytes",
    types: { p: { t: "SharedArrayBuffer" } },
    vals: [{ name: "sab", nat: `new SharedArrayBuffer(4)`, isl: `new SharedArrayBuffer(4)` }],
    reads: [
      ["bl", "v.byteLength"],
      ["isSAB", "v instanceof SharedArrayBuffer"],
      ["first", "new Uint8Array(v)[0]"],
    ],
    natWrite: `new Uint8Array(v)[0] = 100;`,
    islWrite: `new Uint8Array(v)[1] = 200;`,
  },
  // --------------------------------------------------------------- collections
  {
    id: "map",
    family: "collection",
    types: { p: { t: "Map<string, number>" }, w: { t: "Map<string, unknown>" } },
    vals: [
      {
        name: "sn",
        nat: `new Map([["a", 1], ["b", 2]])`,
        isl: `new Map([["a", 1], ["b", 2]])`,
      },
    ],
    reads: [
      ["size", "v.size"],
      ["getA", `v.get("a")`],
      ["hasB", `v.has("b")`],
      ["keys", `[...v.keys()].join(",")`],
      ["ents", `[...v.entries()].map(([k, x]) => k + "=" + String(x)).join(",")`],
      ["isMap", "v instanceof Map"],
      ["each", "(() => { let n = 0; v.forEach((x) => { n += x; }); return n; })()"],
      json,
      ["spread", "[...v].length"],
    ],
    readsW: [
      ["size", "v.size"],
      ["isMap", "v instanceof Map"],
      ["keys", `[...v.keys()].join(",")`],
    ],
    natWrite: `v.set("n", 5); v.delete("a");`,
    natWriteW: `v.set("w", "wide");`,
    islWrite: `v.set("i", 6); v.delete("b");`,
    iterable: true,
  },
  {
    id: "map-obj",
    family: "collection",
    prelude: `${REC_PRELUDE}\nconst mapKey: Rec = { a: 1, b: "x", c: true };`,
    types: { p: { t: "Map<Rec, string[]>", generic: true } },
    vals: [
      {
        name: "objkey",
        nat: `new Map([[mapKey, ["val"]]])`,
        isl: `new Map([[{ a: 1, b: "x", c: true }, ["val"]]])`,
      },
    ],
    reads: [
      ["size", "v.size"],
      ["kA", "[...v.keys()][0].a"],
      ["val0", `[...v.values()][0].join(",")`],
      ["getByKey", "v.get([...v.keys()][0]) === [...v.values()][0]"],
      ["keyId", "[...v.keys()][0] === [...v.keys()][0]"],
    ],
    natReads: [["hasOwnKey", "v.has(mapKey)"]],
    natWrite: `[...v.keys()][0].a = 100; [...v.values()][0].push("n");`,
    islWrite: `[...v.keys()][0].a = 200; [...v.values()][0].push("i");`,
  },
  {
    id: "set",
    family: "collection",
    types: { p: { t: "Set<number>" }, w: { t: "Set<unknown>" } },
    vals: [{ name: "nums", nat: `new Set([1, 2, 3])`, isl: `new Set([1, 2, 3])` }],
    reads: [
      ["size", "v.size"],
      ["has2", "v.has(2)"],
      ["vals", `[...v].join(",")`],
      ["isSet", "v instanceof Set"],
      json,
    ],
    readsW: [
      ["size", "v.size"],
      ["isSet", "v instanceof Set"],
    ],
    natWrite: `v.add(9); v.delete(1);`,
    natWriteW: `v.add("w");`,
    islWrite: `v.add(8); v.delete(2);`,
    iterable: true,
  },
  {
    id: "weakmap",
    family: "collection",
    types: { p: { t: "WeakMap<object, number>" } },
    vals: [{ name: "wm", nat: `new WeakMap<object, number>()`, isl: `new WeakMap()` }],
    reads: [
      ["isWM", "v instanceof WeakMap"],
      ["hasX", "v.has({})"],
    ],
  },
  // ------------------------------------------------------------------ builtins
  {
    id: "date",
    family: "builtin",
    types: { p: { t: "Date" }, w: { t: "Date | number" } },
    vals: [
      { name: "valid", nat: `new Date(1700000000123)`, isl: `new Date(1700000000123)` },
      { name: "invalid", nat: `new Date(NaN)`, isl: `new Date(NaN)` },
    ],
    reads: [
      ["time", "v.getTime()"],
      ["iso", `isNaN(v.getTime()) ? "invalid" : v.toISOString()`],
      ["isDate", "v instanceof Date"],
      json,
      typeOf,
      ["year", "v.getUTCFullYear()"],
      ["valueOf", "v.valueOf()"],
    ],
    readsW: [typeOf, json],
    natWrite: `v.setTime(1000);`,
    islWrite: `v.setUTCFullYear(2001);`,
  },
  {
    id: "regexp",
    family: "builtin",
    types: { p: { t: "RegExp" }, w: { t: "RegExp | string" } },
    vals: [{ name: "global", nat: `/a(b)?/g`, isl: `/a(b)?/g` }],
    reads: [
      ["src", "v.source"],
      ["flags", "v.flags"],
      ["li", "v.lastIndex"],
      ["global", "v.global"],
      ["test", `v.test("xab")`],
      ["li2", "v.lastIndex"],
      ["str", "String(v)"],
      ["isRe", "v instanceof RegExp"],
      [
        "exec",
        `(() => { v.lastIndex = 0; const m = v.exec("ab ab"); return m === null ? "null" : m.index + ":" + m[0] + ":" + String(m[1]) + ":" + v.lastIndex; })()`,
      ],
      ["li3", "v.lastIndex"],
    ],
    reads2: [
      ["li", "v.lastIndex"],
      ["src", "v.source"],
    ],
    readsW: [typeOf, ["str", "String(v)"]],
    natWrite: `v.lastIndex = 1;`,
    islWrite: `v.lastIndex = 0; v.exec("ab ab");`,
  },
  {
    id: "url",
    family: "builtin",
    types: { p: { t: "URL" } },
    vals: [
      {
        name: "url",
        nat: `new URL("https://ex.test/p?q=1#h")`,
        isl: `new URL("https://ex.test/p?q=1#h")`,
      },
    ],
    reads: [
      ["href", "v.href"],
      ["q", `v.searchParams.get("q")`],
      ["isURL", "v instanceof URL"],
      json,
      ["str", "String(v)"],
    ],
    natWrite: `v.pathname = "/nat";`,
    islWrite: `v.hash = "#isl";`,
  },
  // ------------------------------------------------------------------- classes
  {
    id: "class",
    family: "class",
    prelude: `class Counter {\n  n: number;\n  #secret = 7;\n  static made = 0;\n  constructor(n: number) { this.n = n; Counter.made++; }\n  inc(): number { this.n += 1; return this.n; }\n  get double(): number { return this.n * 2; }\n  set double(x: number) { this.n = x / 2; }\n  reveal(): number { return this.#secret; }\n  toString(): string { return "Counter(" + this.n + ")"; }\n}\ninterface HasN { n: number }`,
    types: { p: { t: "Counter", generic: true }, w: { t: "HasN", generic: true } },
    vals: [{ name: "counter", nat: `new Counter(3)` }],
    reads: [
      ["n", "v.n"],
      ["inc", "v.inc()"],
      ["dbl", "v.double"],
      ["rev", "v.reveal()"],
      ["str", "String(v)"],
      keys,
      json,
      ["incId", "v.inc === v.inc"],
      ["ctor", "v.constructor.name"],
      ["hasInc", `"inc" in v`],
      ["ownInc", `Object.hasOwn(v, "inc")`],
      ["tInc", "typeof v.inc"],
    ],
    natReads: [
      ["inst", "v instanceof Counter"],
      ["made", "Counter.made"],
    ],
    islReads: [
      ["plainProto", "Object.getPrototypeOf(v) === Object.prototype"],
      ["protoNames", `Object.getOwnPropertyNames(Object.getPrototypeOf(v)).sort().join(",")`],
      [
        "detached",
        "(() => { const f = v.inc; try { return f(); } catch (e) { return e.constructor.name; } })()",
      ],
      [
        "otherThis",
        "(() => { try { return v.inc.call({ n: 40 }); } catch (e) { return e.constructor.name; } })()",
      ],
    ],
    readsW: [["n", "v.n"], keys, json],
    natWrite: `v.n = 10; v.double = 50;`,
    natWriteW: `v.n = 11;`,
    islWrite: `v.n = 20; v.double = 80;`,
  },
  {
    id: "island-class",
    family: "class",
    prelude: `interface HasN { n: number }`,
    dtsPrelude: `export declare class Box {\n  n: number;\n  constructor(n: number);\n  inc(): number;\n  get double(): number;\n  set double(x: number);\n  reveal(): number;\n  static create(n: number): Box;\n  static made: number;\n}`,
    jsPrelude: `class Box {\n  #secret = 7;\n  static made = 0;\n  constructor(n) { this.n = n; Box.made++; }\n  inc() { this.n += 1; return this.n; }\n  get double() { return this.n * 2; }\n  set double(x) { this.n = x / 2; }\n  reveal() { return this.#secret; }\n  static create(n) { return new Box(n); }\n}\nexports.Box = Box;`,
    imports: ["Box"],
    types: { i: { t: "Box" }, w: { t: "HasN", generic: true } },
    vals: [{ name: "box", nat: `new Box(3)`, isl: `new Box(3)` }],
    reads: [
      ["n", "v.n"],
      ["inc", "v.inc()"],
      ["dbl", "v.double"],
      ["rev", "v.reveal()"],
      ["str", "String(v)"],
      keys,
      json,
      ["incId", "v.inc === v.inc"],
      ["ctor", "v.constructor.name"],
      ["tInc", "typeof v.inc"],
      ["inst", "v instanceof Box"],
    ],
    readsW: [["n", "v.n"], keys, json],
    natWrite: `v.n = 10; v.double = 50;`,
    natWriteW: `v.n = 11;`,
    islWrite: `v.n = 20; v.double = 80;`,
  },
  {
    id: "island-subclass",
    family: "class",
    dtsPrelude: `export declare class Box {\n  n: number;\n  constructor(n: number);\n  inc(): number;\n  get double(): number;\n  reveal(): number;\n}`,
    jsPrelude: `class Box {\n  #secret = 7;\n  constructor(n) { this.n = n; }\n  inc() { this.n += 1; return this.n; }\n  get double() { return this.n * 2; }\n  reveal() { return this.#secret; }\n}\nexports.Box = Box;`,
    imports: ["Box"],
    prelude: `class MyBox extends Box {\n  extra: number = 1;\n  inc(): number { return super.inc() + 100; }\n  describe(): string { return "MyBox:" + this.n; }\n}`,
    types: { p: { t: "MyBox", generic: true }, i: { t: "Box" } },
    vals: [{ name: "mybox", nat: `new MyBox(3)` }],
    reads: [
      ["n", "v.n"],
      ["inc", "v.inc()"],
      ["dbl", "v.double"],
      ["rev", "v.reveal()"],
      ["ctor", "v.constructor.name"],
      ["instBox", "v instanceof Box"],
    ],
    natReads: [["instMy", "v instanceof MyBox"]],
    islReads: [
      ["extra", "v.extra"],
      ["tDescribe", "typeof v.describe"],
    ],
    natWrite: `v.n = 10;`,
    islWrite: `v.n = 20;`,
  },
  // ----------------------------------------------------------------- functions
  {
    id: "fn",
    family: "function",
    types: {
      p: { t: "(x: number) => number" },
      w: { t: "((x: number) => number) | string" },
    },
    vals: [{ name: "arrow", nat: `(x: number): number => x + 10`, isl: `(x) => x + 10` }],
    reads: [["call", "v(1)"], typeOf, len, ["self", "v === v"]],
    islReads: [
      ["tName", "typeof v.name"],
      ["call2", "v.call(null, 2)"],
      ["apply", "v.apply(null, [3])"],
      ["bind", "v.bind(null, 4)()"],
      ["isFn", "v instanceof Function"],
      ["extraArgs", "v(1, 2, 3)"],
      ["noArg", "(() => { try { return v(); } catch (e) { return e.constructor.name; } })()"],
      ["badArg", `(() => { try { return v("s"); } catch (e) { return e.constructor.name; } })()`],
    ],
    readsW: [typeOf],
  },
  {
    id: "fn-this",
    family: "function",
    prelude: `interface Ctx { k: number }`,
    types: { p: { t: "(this: Ctx, x: number) => number", generic: true } },
    vals: [
      {
        name: "method",
        nat: `function (this: Ctx, x: number): number { return this.k + x; }`,
        isl: `function (x) { return this.k + x; }`,
      },
    ],
    reads: [["call", "v.call({ k: 5 }, 1)"], typeOf],
    islReads: [["asMethod", "({ k: 7, m: v }).m(1)"]],
  },
  {
    id: "fn-state",
    family: "function",
    types: { p: { t: "() => number" } },
    vals: [
      {
        name: "counter",
        nat: `(() => { let c = 0; return (): number => ++c; })()`,
        isl: `(() => { let c = 0; return () => ++c; })()`,
      },
    ],
    reads: [
      ["c1", "v()"],
      ["c2", "v()"],
    ],
  },
  {
    id: "fn-rest",
    family: "function",
    types: { p: { t: "(a: number, b?: string, ...rest: number[]) => string" } },
    vals: [
      {
        name: "rest",
        nat: `(a: number, b?: string, ...rest: number[]): string => a + ":" + String(b) + ":" + rest.join("+")`,
        isl: `(a, b, ...rest) => a + ":" + String(b) + ":" + rest.join("+")`,
      },
    ],
    reads: [["one", "v(1)"], ["two", `v(1, "b")`], ["four", `v(1, "b", 2, 3)`], len],
  },
  {
    id: "fn-async",
    family: "function",
    async: true,
    types: { p: { t: "(x: number) => Promise<number>" } },
    vals: [
      {
        name: "async",
        nat: `async (x: number): Promise<number> => x * 2`,
        isl: `async (x) => x * 2`,
      },
    ],
    reads: [
      ["aw", "await v(2)"],
      ["isP", "v(1) instanceof Promise"],
    ],
  },
  {
    id: "fn-throw",
    family: "function",
    types: { p: { t: "() => number" } },
    vals: [
      {
        name: "thrower",
        nat: `(): number => { throw new RangeError("boom"); }`,
        isl: `() => { throw new RangeError("boom"); }`,
      },
    ],
    reads: [
      [
        "thrown",
        `(() => { try { v(); return "no throw"; } catch (e) { return String(e instanceof RangeError) + ":" + (e instanceof Error ? e.name + ":" + e.message : "?"); } })()`,
      ],
    ],
  },
  {
    id: "fn-rec",
    family: "function",
    prelude: REC_PRELUDE,
    types: { p: { t: "(r: Rec) => Rec", generic: true } },
    vals: [
      {
        name: "recfn",
        nat: `(r: Rec): Rec => { r.a += 1; return r; }`,
        isl: `(r) => { r.a += 1; return r; }`,
      },
    ],
    reads: [
      [
        "roundtrip",
        `(() => { const r = { a: 1, b: "x", c: true }; const q = v(r); return String(q === r) + ":" + r.a; })()`,
      ],
    ],
  },
  // ------------------------------------------------------------------ promises
  {
    id: "promise-resolved",
    family: "promise",
    async: true,
    types: { p: { t: "Promise<number>" }, w: { t: "Promise<number> | number" } },
    vals: [{ name: "five", nat: `Promise.resolve(5)`, isl: `Promise.resolve(5)` }],
    reads: [
      ["aw", "await v"],
      ["isP", "v instanceof Promise"],
      ["then", "await v.then((x) => x + 1)"],
      ["tThen", "typeof v.then"],
      ["all", `(await Promise.all([v, v])).join(",")`],
    ],
    readsW: [["aw", "await v"]],
  },
  {
    id: "promise-rejected",
    family: "promise",
    async: true,
    types: { p: { t: "Promise<number>" } },
    vals: [
      {
        name: "rejected",
        nat: `(() => { const p: Promise<number> = Promise.reject(new TypeError("no")); p.catch(() => {}); return p; })()`,
        isl: `(() => { const p = Promise.reject(new TypeError("no")); p.catch(() => {}); return p; })()`,
      },
    ],
    reads: [
      [
        "caught",
        `await v.then(() => "resolved", (e) => String(e instanceof TypeError) + ":" + (e instanceof Error ? e.message : "?"))`,
      ],
      ["isP", "v instanceof Promise"],
    ],
  },
  {
    id: "promise-pending",
    family: "promise",
    async: true,
    ownerWrites: true,
    prelude: `let resolveNat: (x: number) => void = () => {};`,
    jsPrelude: `let resolveIsl = () => {};`,
    types: { p: { t: "Promise<number>" } },
    vals: [
      {
        name: "pending",
        nat: `new Promise<number>((res) => { resolveNat = res; })`,
        isl: `new Promise((res) => { resolveIsl = res; })`,
      },
    ],
    reads: [
      ["isP", "v instanceof Promise"],
      ["tThen", "typeof v.then"],
    ],
    reads2: [["aw", "await v"]],
    natWrite: `resolveNat(21);`,
    islWrite: `resolveIsl(21);`,
  },
  {
    id: "thenable",
    family: "promise",
    async: true,
    types: { p: { t: "PromiseLike<number>" } },
    vals: [{ name: "thenable", isl: `{ then(res) { res(7); } }` }],
    reads: [
      ["aw", "await v"],
      ["tThen", "typeof v.then"],
    ],
  },
  // ----------------------------------------------------------------- iterators
  {
    id: "iter-array",
    family: "iterator",
    types: { p: { t: "IterableIterator<number>" } },
    vals: [{ name: "values", nat: `[1, 2, 3].values()`, isl: `[1, 2, 3].values()` }],
    reads: [
      ["n1", "v.next().value"],
      ["rest", `[...v].join(",")`],
      ["done", "v.next().done"],
    ],
  },
  {
    id: "iter-object",
    family: "iterator",
    jsPrelude: `function range(from, to) {\n  return { [Symbol.iterator]() { let k = from; return { next: () => (k <= to ? { value: k++, done: false } : { value: undefined, done: true }) }; } };\n}`,
    types: { p: { t: "Iterable<number>" } },
    vals: [{ name: "range", isl: `range(1, 3)` }],
    reads: [
      ["spread", `[...v].join(",")`],
      [
        "forof",
        "(() => { let s = 0; for (const x of v) { s += x; if (x === 2) break; } return s; })()",
      ],
      ["again", "[...v].length"],
    ],
  },
  {
    id: "generator",
    family: "iterator",
    prelude: `const genLog: string[] = [];\nfunction* count(): Generator<number, string, number | undefined> {\n  genLog.push("start");\n  const got = yield 1;\n  genLog.push("got " + String(got));\n  yield 2;\n  genLog.push("end");\n  return "ret";\n}`,
    jsPrelude: `const genLog = [];\nfunction* count() {\n  genLog.push("start");\n  const got = yield 1;\n  genLog.push("got " + String(got));\n  yield 2;\n  genLog.push("end");\n  return "ret";\n}`,
    types: { p: { t: "Generator<number, string, number | undefined>" } },
    vals: [{ name: "count", nat: `count()`, isl: `count()` }],
    reads: [
      ["n1", "v.next().value"],
      ["n2", "v.next(10).value"],
      ["ret", `v.return("early").value`],
      ["done", "v.next().done"],
      ["log", `genLog.join("|")`],
    ],
  },
  {
    id: "generator-lazy",
    family: "iterator",
    prelude: `const genLog: string[] = [];\nfunction* steps(): Generator<number, void, undefined> {\n  genLog.push("y0");\n  yield 0;\n  genLog.push("y1");\n  yield 1;\n  genLog.push("y2");\n  yield 2;\n  genLog.push("end");\n}`,
    jsPrelude: `const genLog = [];\nfunction* steps() {\n  genLog.push("y0");\n  yield 0;\n  genLog.push("y1");\n  yield 1;\n  genLog.push("y2");\n  yield 2;\n  genLog.push("end");\n}`,
    types: { p: { t: "Generator<number, void, undefined>" } },
    vals: [{ name: "steps", nat: `steps()`, isl: `steps()` }],
    reads: [
      [
        "forof",
        `(() => { let s = ""; for (const x of v) { s += "got" + x + ";"; if (x === 1) break; } return s + genLog.join("|"); })()`,
      ],
      ["after", "v.next().done"],
    ],
  },
  {
    id: "generator-infinite",
    family: "iterator",
    prelude: `function* nats(): Generator<number, void, undefined> {\n  for (let k = 0; ; k++) yield k;\n}`,
    jsPrelude: `function* nats() {\n  for (let k = 0; ; k++) yield k;\n}`,
    types: { p: { t: "Generator<number, void, undefined>" } },
    vals: [{ name: "nats", nat: `nats()`, isl: `nats()` }],
    reads: [
      [
        "take3",
        `(() => { let s = ""; for (const x of v) { s += x; if (x === 2) break; } return s; })()`,
      ],
      ["next", "v.next().done"],
    ],
  },
  {
    id: "async-generator",
    family: "iterator",
    async: true,
    prelude: `async function* acount(): AsyncGenerator<number, void, undefined> {\n  yield 1;\n  yield 2;\n  yield 3;\n}`,
    jsPrelude: `async function* acount() {\n  yield 1;\n  yield 2;\n  yield 3;\n}`,
    types: { p: { t: "AsyncGenerator<number, void, undefined>" } },
    vals: [{ name: "acount", nat: `acount()`, isl: `acount()` }],
    reads: [
      ["n1", "(await v.next()).value"],
      ["rest", "await (async () => { let s = 0; for await (const x of v) s += x; return s; })()"],
    ],
  },
  {
    id: "async-iterable",
    family: "iterator",
    async: true,
    jsPrelude: `function arange(n) {\n  return { [Symbol.asyncIterator]() { let k = 0; return { next: async () => (k < n ? { value: k++, done: false } : { value: undefined, done: true }) }; } };\n}`,
    types: { p: { t: "AsyncIterable<number>" } },
    vals: [{ name: "arange", isl: `arange(4)` }],
    reads: [
      ["sum", "await (async () => { let s = 0; for await (const x of v) s += x; return s; })()"],
    ],
  },
  // -------------------------------------------------------------------- errors
  {
    id: "error",
    family: "error",
    types: { p: { t: "Error" }, w: { t: "Error | string" } },
    vals: [{ name: "plain", nat: `new Error("plain")`, isl: `new Error("plain")` }],
    reads: [
      ["msg", "v.message"],
      ["name", "v.name"],
      ["isErr", "v instanceof Error"],
      ["tStack", "typeof v.stack"],
      ["str", "String(v)"],
      keys,
      json,
      ["stack0", `String(v.stack).split("\\n")[0]`],
      ["ctor", "v.constructor.name"],
    ],
    readsW: [typeOf, ["str", "String(v)"]],
    natWrite: `v.message = "nat";`,
    islWrite: `v.message = "isl";`,
    extraN2I: [
      [
        "N.throwId",
        `(() => { try { raise(v); return "no throw"; } catch (e) { return e === v; } })()`,
      ],
    ],
    extraI2N: [
      [
        "N.throwId",
        `(() => { try { raiseKept(I); return "no throw"; } catch (e) { return e === v; } })()`,
      ],
    ],
  },
  {
    id: "error-cause",
    family: "error",
    types: { p: { t: "TypeError" }, w: { t: "Error" } },
    vals: [
      {
        name: "typed",
        nat: `new TypeError("typed", { cause: new RangeError("inner") })`,
        isl: `new TypeError("typed", { cause: new RangeError("inner") })`,
      },
    ],
    reads: [
      ["name", "v.name"],
      ["msg", "v.message"],
      ["isT", "v instanceof TypeError"],
      ["isE", "v instanceof Error"],
      ["isR", "v instanceof RangeError"],
      ["cause", "String(v.cause)"],
      ["causeIsR", "v.cause instanceof RangeError"],
    ],
    readsW: [
      ["name", "v.name"],
      ["msg", "v.message"],
      ["isT", "v instanceof TypeError"],
    ],
  },
  {
    id: "error-class",
    family: "error",
    prelude: `class AppError extends Error {\n  code: string;\n  constructor(m: string, code: string) { super(m); this.name = "AppError"; this.code = code; }\n}`,
    types: { p: { t: "AppError", generic: true }, w: { t: "Error" } },
    vals: [{ name: "app", nat: `new AppError("app", "E_APP")` }],
    reads: [
      ["code", "v.code"],
      ["name", "v.name"],
      ["msg", "v.message"],
      ["isE", "v instanceof Error"],
      ["str", "String(v)"],
      keys,
      ["ctor", "v.constructor.name"],
    ],
    natReads: [["isApp", "v instanceof AppError"]],
    readsW: [
      ["name", "v.name"],
      ["msg", "v.message"],
      ["isE", "v instanceof Error"],
    ],
  },
  {
    id: "island-error-class",
    family: "error",
    dtsPrelude: `export declare class IslError extends Error {\n  code: string;\n  constructor(m: string, code: string);\n}`,
    jsPrelude: `class IslError extends Error {\n  constructor(m, code) { super(m); this.name = "IslError"; this.code = code; }\n}\nexports.IslError = IslError;`,
    imports: ["IslError"],
    types: { i: { t: "IslError" }, w: { t: "Error" } },
    vals: [
      { name: "isl", nat: `new IslError("isl", "E_ISL")`, isl: `new IslError("isl", "E_ISL")` },
    ],
    reads: [
      ["code", "v.code"],
      ["name", "v.name"],
      ["msg", "v.message"],
      ["isE", "v instanceof Error"],
      ["isIsl", "v instanceof IslError"],
      ["str", "String(v)"],
      ["ctor", "v.constructor.name"],
    ],
    readsW: [
      ["name", "v.name"],
      ["msg", "v.message"],
      ["isE", "v instanceof Error"],
    ],
  },
  {
    id: "error-aggregate",
    family: "error",
    types: { p: { t: "AggregateError" } },
    vals: [
      {
        name: "agg",
        nat: `new AggregateError([new Error("e1"), new TypeError("e2")], "agg")`,
        isl: `new AggregateError([new Error("e1"), new TypeError("e2")], "agg")`,
      },
    ],
    reads: [
      ["msg", "v.message"],
      ["n", "v.errors.length"],
      ["e1", "String(v.errors[1])"],
      ["isAgg", "v instanceof AggregateError"],
    ],
  },
  // -------------------------------------------------------------------- cycles
  {
    id: "cycle-record",
    family: "cycle",
    prelude: `interface CNode { name: string; self: CNode | null; kids: CNode[] }\nfunction mkCyc(): CNode { const n: CNode = { name: "root", self: null, kids: [] }; n.self = n; n.kids.push(n); return n; }`,
    jsPrelude: `function mkCyc() { const n = { name: "root", self: null, kids: [] }; n.self = n; n.kids.push(n); return n; }`,
    dtsPrelude: `export interface ICNode { name: string; self: ICNode | null; kids: ICNode[] }`,
    types: { p: { t: "CNode", generic: true }, i: { t: "ICNode" } },
    vals: [{ name: "selfref", nat: `mkCyc()`, isl: `mkCyc()` }],
    reads: [
      ["name", "v.name"],
      ["selfId", "v.self === v"],
      ["deep", "v.self?.self?.name"],
      ["kidId", "v.kids[0] === v"],
      ["kl", "v.kids.length"],
      [
        "json",
        `(() => { try { return JSON.stringify(v); } catch (e) { return e instanceof Error ? e.name : "?"; } })()`,
      ],
      [
        "clone",
        `(() => { const c = structuredClone(v); return String(c !== v) + ":" + String(c.self === c) + ":" + String(c.kids[0] === c); })()`,
      ],
    ],
    natWrite: `v.name = "nat"; v.kids.push(v);`,
    islWrite: `v.name = "isl"; v.self = null;`,
  },
  {
    id: "cycle-array",
    family: "cycle",
    prelude: `function mkCycArr(): unknown[] { const a: unknown[] = [1]; a.push(a); return a; }`,
    jsPrelude: `function mkCycArr() { const a = [1]; a.push(a); return a; }`,
    types: { p: { t: "unknown[]" } },
    vals: [{ name: "selfarr", nat: `mkCycArr()`, isl: `mkCycArr()` }],
    reads: [len, ["selfId", "v[1] === v"], ["isArr", "Array.isArray(v)"]],
  },
  // ------------------------------------------------------------------- holders
  {
    id: "holder",
    family: "holder",
    async: true,
    prelude: `interface Holder { f: () => number; xs: number[]; m: Map<string, number>; d: Date; b: Uint8Array; inner: { q: number }; p: Promise<string> }`,
    dtsPrelude: `export interface IHolder { f: () => number; xs: number[]; m: Map<string, number>; d: Date; b: Uint8Array; inner: { q: number }; p: Promise<string> }`,
    types: { p: { t: "Holder", generic: true }, i: { t: "IHolder" } },
    vals: [
      {
        name: "holder",
        nat: `{ f: () => 42, xs: [1, 2], m: new Map([["a", 1]]), d: new Date(1700000000123), b: new Uint8Array([9]), inner: { q: 1 }, p: Promise.resolve("pv") }`,
        isl: `{ f: () => 42, xs: [1, 2], m: new Map([["a", 1]]), d: new Date(1700000000123), b: new Uint8Array([9]), inner: { q: 1 }, p: Promise.resolve("pv") }`,
      },
    ],
    reads: [
      ["f", "v.f()"],
      ["xl", "v.xs.length"],
      ["ma", `v.m.get("a")`],
      ["dt", "v.d.getTime()"],
      ["b0", "v.b[0]"],
      ["q", "v.inner.q"],
      ["pv", "await v.p"],
      ["xsId", "v.xs === v.xs"],
      ["mId", "v.m === v.m"],
      ["dId", "v.d === v.d"],
      ["bId", "v.b === v.b"],
      ["fId", "v.f === v.f"],
      ["pId", "v.p === v.p"],
      keys,
    ],
    natWrite: `v.xs.push(3); v.m.set("n", 2); v.d.setTime(5); v.b[0] = 1; v.inner.q = 2;`,
    islWrite: `v.xs.push(4); v.m.set("i", 3); v.d.setTime(6); v.b[0] = 2; v.inner.q = 3;`,
  },
];
