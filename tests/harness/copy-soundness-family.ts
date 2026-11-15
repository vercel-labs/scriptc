/* The copy-soundness family: generated programs that convert a value to
 * another layout and then look at it.
 *
 * A width conversion copies (width-copies.ts) where JavaScript keeps one
 * object. Each case takes one pair of types, moves a value of the wider
 * type into a slot of the other type in one way, and observes the result in
 * one way: a write through one name read through the other, an identity
 * comparison, a search, or a plain read. The harness (copy-soundness.test.ts)
 * builds the programs and asserts the rule the divergence warnings exist
 * for: a case the compiler does not warn about prints what Node prints.
 *
 * Every case has its own field names, so its types are its own layouts and
 * what one case does to its values is not evidence about another's. */

export interface FamilyCase {
  /** `<pair>/<slot>/<look>`, unique in the family. */
  id: string;
  /** The first token of every line the case prints. */
  tag: string;
  /** The 1-based lines of the program that belong to the case: its
   * declarations and its block. */
  lines: number[];
}

export interface FamilyProgram {
  name: string;
  source: string;
  cases: FamilyCase[];
}

/** One pair of types and a value of the first. `k` is the case number, the
 * suffix of every name the case declares. */
interface Pair {
  name: string;
  /** Declarations: the source type `S<k>` and the target type `T<k>`. */
  types: (k: number) => string;
  /** An expression of type `S<k>` that builds the value. */
  value: (k: number) => string;
  /** A fresh `T<k>`. */
  other: (k: number) => string;
  /** The path from a value of either type to the object the conversion
   * copies (`""`, or `.i` for a nested record). */
  path: string;
}

/** A way a value `w` of type `S<k>` reaches a binding `n` of type `T<k>`.
 * `top` is declared at the top level of the program, `body` inside the
 * case's block after `w`. */
interface Slot {
  name: string;
  top?: (k: number, pair: Pair) => string;
  body: (k: number, pair: Pair) => string;
}

/** What the case does with `w` and `n`; prints lines that start with `tag`. */
interface Look {
  name: string;
  body: (k: number, pair: Pair, tag: string) => string;
}

const PAIRS: Pair[] = [
  {
    name: "narrow",
    types: (k) =>
      `interface S${k} { a${k}: number; b${k}: string }\ninterface T${k} { a${k}: number }`,
    value: (k) => `{ a${k}: 1, b${k}: "x" }`,
    other: (k) => `{ a${k}: 0 }`,
    path: "",
  },
  {
    name: "optional",
    types: (k) =>
      `interface S${k} { a${k}: number; b${k}: string }\ninterface T${k} { a${k}: number; z${k}?: number }`,
    value: (k) => `{ a${k}: 1, b${k}: "x" }`,
    other: (k) => `{ a${k}: 0 }`,
    path: "",
  },
  {
    name: "partial",
    types: (k) =>
      `interface S${k} { a${k}: number; b${k}: string }\ntype T${k} = { a${k}: number; b${k}?: string };`,
    value: (k) => `{ a${k}: 1, b${k}: "x" }`,
    other: (k) => `{ a${k}: 0 }`,
    path: "",
  },
  {
    name: "intersection",
    types: (k) =>
      `type S${k} = { a${k}: number } & { b${k}: string };\ninterface T${k} { a${k}: number }`,
    value: (k) => `{ a${k}: 1, b${k}: "x" }`,
    other: (k) => `{ a${k}: 0 }`,
    path: "",
  },
  {
    name: "nested",
    types: (k) =>
      `interface S${k} { i: { a${k}: number; b${k}: string }; t${k}: number }\ninterface T${k} { i: { a${k}: number } }`,
    value: (k) => `{ i: { a${k}: 1, b${k}: "x" }, t${k}: 2 }`,
    other: (k) => `{ i: { a${k}: 0 } }`,
    path: ".i",
  },
  {
    name: "class",
    types: (k) =>
      `class S${k} { constructor(public a${k}: number, public b${k}: string) {} }\ninterface T${k} { a${k}: number }`,
    value: (k) => `new S${k}(1, "x")`,
    other: (k) => `{ a${k}: 0 }`,
    path: "",
  },
];

const SLOTS: Slot[] = [
  { name: "declaration", body: (k) => `const n: T${k} = w;` },
  { name: "assignment", body: (k, p) => `let n: T${k} = ${p.other(k)}; n = w;` },
  {
    name: "argument",
    top: (k) => `function pass${k}(p: T${k}): T${k} { return p; }`,
    body: (k) => `const n = pass${k}(w);`,
  },
  {
    name: "arrow-parameter",
    body: (k) => `const pass = (p: T${k}): T${k} => p; const n = pass(w);`,
  },
  {
    name: "return",
    top: (k) => `function give${k}(p: S${k}): T${k} { return p; }`,
    body: (k) => `const n = give${k}(w);`,
  },
  { name: "array-literal", body: (k) => `const xs: T${k}[] = [w]; const n = xs[0]!;` },
  { name: "push", body: (k) => `const xs: T${k}[] = []; xs.push(w); const n = xs[0]!;` },
  { name: "unshift", body: (k) => `const xs: T${k}[] = []; xs.unshift(w); const n = xs[0]!;` },
  {
    name: "index-store",
    body: (k, p) => `const xs: T${k}[] = [${p.other(k)}]; xs[0] = w; const n = xs[0]!;`,
  },
  {
    name: "map-value",
    body: (k) => `const m = new Map<string, T${k}>(); m.set("k", w); const n = m.get("k")!;`,
  },
  { name: "field", body: (k) => `const h: { h: T${k} } = { h: w }; const n = h.h;` },
  {
    name: "optional-field",
    body: (k) => `const h: { h?: T${k} } = {}; h.h = w; const n = h.h;`,
  },
  { name: "tuple", body: (k) => `const t: [T${k}, number] = [w, 1]; const n = t[0];` },
  {
    name: "dictionary",
    body: (k) => `const d: Record<string, T${k}> = { k: w }; const n = d["k"]!;`,
  },
  { name: "conditional", body: (k, p) => `const n: T${k} = flag() ? w : ${p.other(k)};` },
  {
    name: "constructor-parameter",
    top: (k) => `class Holder${k} { constructor(public n: T${k}) {} }`,
    body: (k) => `const n = new Holder${k}(w).n;`,
  },
  {
    name: "default-parameter",
    body: (k) => `const pass = (p: T${k} = w): T${k} => p; const n = pass();`,
  },
  {
    name: "rest-parameter",
    body: (k) => `const pass = (...ps: T${k}[]): T${k} => ps[0]!; const n = pass(w);`,
  },
  {
    name: "callback-argument",
    body: (k) =>
      `let got = undefined as T${k} | undefined; const call = (f: (p: T${k}) => void): void => f(w); call((p) => { got = p; }); const n = got!;`,
  },
  {
    name: "forEach",
    body: (k) =>
      `let got = undefined as T${k} | undefined; [w].forEach((p: T${k}) => { got = p; }); const n = got!;`,
  },
  { name: "map-result", body: (k) => `const n = [w].map((x): T${k} => x)[0]!;` },
  {
    name: "generator",
    top: (k) => `function* each${k}(p: T${k}): Generator<T${k}> { yield p; }`,
    body: (k) => `const n = [...each${k}(w)][0]!;`,
  },
  {
    name: "closure",
    body: (k) => `const keep = (p: T${k}): (() => T${k}) => () => p; const n = keep(w)();`,
  },
  {
    name: "union-binding",
    body: (k) => `const u: T${k} | null = flag() ? w : null; const n = u!;`,
  },
  { name: "spread-member", body: (k) => `const s: { n: T${k} } = { ...{ n: w } }; const n = s.n;` },
];

const LOOKS: Look[] = [
  {
    name: "write-copy",
    body: (k, p, tag) => `n${p.path}.a${k} = 7; console.log("${tag}", w${p.path}.a${k});`,
  },
  {
    name: "write-source",
    body: (k, p, tag) => `w${p.path}.a${k} = 8; console.log("${tag}", n${p.path}.a${k});`,
  },
  {
    name: "increment",
    body: (k, p, tag) => `n${p.path}.a${k}++; console.log("${tag}", w${p.path}.a${k});`,
  },
  {
    name: "write-in-callee",
    body: (k, p, tag) =>
      `const set = (q: T${k}): void => { q${p.path}.a${k} = 9; }; set(n); console.log("${tag}", w${p.path}.a${k});`,
  },
  {
    name: "assign",
    body: (k, p, tag) =>
      `Object.assign(n${p.path}, { a${k}: 10 }); console.log("${tag}", w${p.path}.a${k});`,
  },
  {
    name: "untyped-write",
    body: (k, p, tag) =>
      `(n${p.path} as unknown as { a${k}: number }).a${k} = 11; console.log("${tag}", w${p.path}.a${k});`,
  },
  {
    name: "identity",
    body: (_k, p, tag) =>
      `console.log("${tag}", (n${p.path} as unknown) === (w${p.path} as unknown));`,
  },
  {
    name: "same-type-identity",
    body: (k, _p, tag) =>
      `const again: T${k} = w; const same = (x: T${k}, y: T${k}): boolean => x === y; console.log("${tag}", same(n, again));`,
  },
  {
    name: "search",
    body: (k, _p, tag) =>
      `const all: T${k}[] = [n]; console.log("${tag}", all.includes(w), all.indexOf(w));`,
  },
  {
    name: "freeze",
    body: (_k, p, tag) =>
      `Object.freeze(n${p.path}); console.log("${tag}", Object.isFrozen(w${p.path}));`,
  },
  {
    name: "read",
    body: (k, p, tag) =>
      `console.log("${tag}", n${p.path}.a${k}, JSON.stringify(n), Object.keys(n).join(","));`,
  },
];

/** Array and tuple conversions: whole cases, since their slots and looks
 * differ from a record's. `k` suffixes the names as above. */
const ARRAY_CASES: {
  id: string;
  top?: (k: number) => string;
  body: (k: number, tag: string) => string;
}[] = [
  {
    id: "array/declaration/push",
    body: (k, tag) =>
      `const ws: S${k}[] = [{ a${k}: 1, b${k}: "x" }]; const ns: T${k}[] = ws; ns.push({ a${k}: 5 }); console.log("${tag}", ws.length);`,
  },
  {
    id: "array/declaration/push-source",
    body: (k, tag) =>
      `const ws: S${k}[] = [{ a${k}: 1, b${k}: "x" }]; const ns: T${k}[] = ws; ws.push({ a${k}: 5, b${k}: "y" }); console.log("${tag}", ns.length);`,
  },
  {
    id: "array/declaration/element-write",
    body: (k, tag) =>
      `const ws: S${k}[] = [{ a${k}: 1, b${k}: "x" }]; const ns: T${k}[] = ws; ns[0]!.a${k} = 7; console.log("${tag}", ws[0]!.a${k});`,
  },
  {
    id: "array/declaration/identity",
    body: (k, tag) =>
      `const ws: S${k}[] = [{ a${k}: 1, b${k}: "x" }]; const ns: T${k}[] = ws; console.log("${tag}", (ns as unknown) === (ws as unknown));`,
  },
  {
    id: "array/declaration/read",
    body: (k, tag) =>
      `const ws: S${k}[] = [{ a${k}: 1, b${k}: "x" }]; const ns: T${k}[] = ws; console.log("${tag}", ns.length, ns[0]!.a${k});`,
  },
  {
    id: "array/arrow-parameter/push",
    body: (k, tag) =>
      `const ws: S${k}[] = [{ a${k}: 1, b${k}: "x" }]; const grow = (ns: T${k}[]): void => { ns.push({ a${k}: 5 }); }; grow(ws); console.log("${tag}", ws.length);`,
  },
  {
    id: "array/argument/element-write",
    top: (k) => `function touch${k}(ns: T${k}[]): void { ns[0]!.a${k} = 7; }`,
    body: (k, tag) =>
      `const ws: S${k}[] = [{ a${k}: 1, b${k}: "x" }]; touch${k}(ws); console.log("${tag}", ws[0]!.a${k});`,
  },
  {
    id: "array/field/sort",
    body: (k, tag) =>
      `const ws: S${k}[] = [{ a${k}: 2, b${k}: "x" }, { a${k}: 1, b${k}: "y" }]; const h: { ns: T${k}[] } = { ns: ws }; h.ns.sort((x, y) => x.a${k} - y.a${k}); console.log("${tag}", ws[0]!.a${k});`,
  },
  {
    id: "array/return/length",
    top: (k) => `function view${k}(ws: S${k}[]): T${k}[] { return ws; }`,
    body: (k, tag) =>
      `const ws: S${k}[] = [{ a${k}: 1, b${k}: "x" }]; const ns = view${k}(ws); ns.length = 0; console.log("${tag}", ws.length);`,
  },
  // Tuples and arrays of the case's own element type, so that one case's
  // writes are not evidence about another's arrays.
  {
    id: "tuple/declaration/index-store",
    body: (k, tag) =>
      `const t${k}: [T${k}, T${k}] = [{ a${k}: 1 }, { a${k}: 2 }]; const xs: T${k}[] = t${k}; xs[0] = { a${k}: 9 }; console.log("${tag}", t${k}[0].a${k});`,
  },
  {
    id: "tuple/declaration/store-source",
    body: (k, tag) =>
      `const t${k}: [T${k}, T${k}] = [{ a${k}: 1 }, { a${k}: 2 }]; const xs: T${k}[] = t${k}; t${k}[1] = { a${k}: 9 }; console.log("${tag}", xs[1]!.a${k});`,
  },
  {
    id: "tuple/arrow-parameter/push",
    body: (k, tag) =>
      `const t${k}: [T${k}, T${k}] = [{ a${k}: 1 }, { a${k}: 2 }]; const grow = (xs: T${k}[]): void => { xs.push({ a${k}: 3 }); }; grow(t${k}); console.log("${tag}", JSON.stringify(t${k}));`,
  },
  {
    id: "tuple/declaration/read",
    body: (k, tag) =>
      `const t${k}: [T${k}, T${k}] = [{ a${k}: 1 }, { a${k}: 2 }]; const xs: readonly T${k}[] = t${k}; console.log("${tag}", xs.length, xs[1]!.a${k});`,
  },
  {
    id: "empty/declaration/push",
    body: (k, tag) =>
      `const e${k}: [] = []; const xs: T${k}[] = e${k}; xs.push({ a${k}: 1 }); console.log("${tag}", JSON.stringify(e${k}));`,
  },
  // Two conversions in a row: the second copies the first copy, and Node
  // still has the one object.
  {
    id: "chain/field/write-copy",
    top: (k) =>
      `interface W${k} { a${k}: number; b${k}: string; c${k}: boolean }\nfunction narrow${k}(x: W${k}): S${k} { return x; }`,
    body: (k, tag) =>
      `const w: W${k} = { a${k}: 1, b${k}: "x", c${k}: true }; const hold: { m: T${k} } = { m: narrow${k}(w) }; hold.m.a${k} = 7; console.log("${tag}", w.a${k});`,
  },
  // A record with more declared fields into a record with an index
  // signature: the overflow capture.
  {
    id: "hybrid/declaration/keyed-write",
    top: (k) => `type H${k} = { a${k}: number; [key: string]: number };`,
    body: (k, tag) =>
      `const w = { a${k}: 1, c${k}: 2 }; const h: H${k} = w; h["z${k}"] = 5; console.log("${tag}", JSON.stringify(w));`,
  },
  {
    id: "hybrid/declaration/field-write",
    top: (k) => `type H${k} = { a${k}: number; [key: string]: number };`,
    body: (k, tag) =>
      `const w = { a${k}: 1, c${k}: 2 }; const h: H${k} = w; h.a${k} = 7; console.log("${tag}", w.a${k});`,
  },
  // A written predicate that names a type no union arm is: the kept
  // elements are rebuilt at the predicate's type.
  {
    id: "predicate/filter/write",
    top: (k) =>
      `interface A${k} { kind: "a"; t${k}: string; s${k}?: string }\ninterface B${k} { kind: "b"; n${k}: number }`,
    body: (k, tag) =>
      `const items: (A${k} | B${k})[] = [{ kind: "a", t${k}: "t", s${k}: "s" }, { kind: "b", n${k}: 1 }]; const kept = items.filter((c): c is { kind: "a"; t${k}: string } => c.kind === "a"); kept[0]!.t${k} = "w"; console.log("${tag}", JSON.stringify(items[0]));`,
  },
  {
    id: "predicate/filter/read",
    top: (k) =>
      `interface A${k} { kind: "a"; t${k}: string; s${k}?: string }\ninterface B${k} { kind: "b"; n${k}: number }`,
    body: (k, tag) =>
      `const items: (A${k} | B${k})[] = [{ kind: "a", t${k}: "t", s${k}: "s" }, { kind: "b", n${k}: 1 }]; const kept = items.filter((c): c is { kind: "a"; t${k}: string } => c.kind === "a"); console.log("${tag}", kept.length, kept[0]!.t${k});`,
  },
  {
    id: "instance/declaration/write",
    top: (k) => `class Q${k} { constructor(public a${k}: number) {} }`,
    body: (k, tag) =>
      `const r = { a${k}: 1 }; const q: Q${k} = r; q.a${k} = 5; console.log("${tag}", r.a${k});`,
  },
  {
    id: "promise/declaration/write",
    body: (k, tag) =>
      `const w: S${k} = { a${k}: 1, b${k}: "x" }; const p: Promise<S${k}> = Promise.resolve(w); const q: Promise<T${k}> = p; q.then((n) => { n.a${k} = 7; console.log("${tag}", w.a${k}); });`,
  },
];

const PRELUDE = `function flag(): boolean { return process.argv.length < 100; }`;

/** The family: `perProgram` cases a program, without the cases named in
 * `skip`. Deterministic: the same call answers the same programs. Every
 * slot meets every look, the pair rotating so that every pair meets every
 * slot. */
export function copySoundnessFamily(
  perProgram = 25,
  skip: ReadonlySet<string> = new Set(),
): FamilyProgram[] {
  interface Draft {
    id: string;
    top: string[];
    block: (tag: string) => string;
  }
  const drafts: Draft[] = [];
  let k = 0;
  const record = (pair: Pair, slot: Slot, look: Look): void => {
    const n = k++;
    const top = [pair.types(n)];
    if (slot.top) top.push(slot.top(n, pair));
    drafts.push({
      id: `${pair.name}/${slot.name}/${look.name}`,
      top,
      block: (tag) =>
        `{ const w: S${n} = ${pair.value(n)}; ${slot.body(n, pair)} ${look.body(n, pair, tag)} }`,
    });
  };
  // Every slot with every look, the pair rotating.
  SLOTS.forEach((slot, s) =>
    LOOKS.forEach((look, l) => record(PAIRS[(s + l) % PAIRS.length]!, slot, look)),
  );
  // Every pair with every slot (the look rotating) not yet covered above.
  const seen = new Set(drafts.map((d) => d.id.slice(0, d.id.lastIndexOf("/"))));
  PAIRS.forEach((pair, p) =>
    SLOTS.forEach((slot, s) => {
      if (!seen.has(`${pair.name}/${slot.name}`))
        record(pair, slot, LOOKS[(p + s) % LOOKS.length]!);
    }),
  );
  for (const array of ARRAY_CASES) {
    const n = k++;
    const top = [
      `interface S${n} { a${n}: number; b${n}: string }\ninterface T${n} { a${n}: number }`,
    ];
    if (array.top) top.push(array.top(n));
    drafts.push({ id: array.id, top, block: (tag) => `{ ${array.body(n, tag)} }` });
  }
  const kept = drafts.filter((draft) => !skip.has(draft.id));
  const programs: FamilyProgram[] = [];
  for (let start = 0; start < kept.length; start += perProgram) {
    const slice = kept.slice(start, start + perProgram);
    const lines: string[] = [PRELUDE];
    const owned = slice.map((): number[] => []);
    const add = (owner: number, text: string): void => {
      for (const line of text.split("\n")) {
        lines.push(line);
        owned[owner]!.push(lines.length);
      }
    };
    slice.forEach((draft, i) => draft.top.forEach((top) => add(i, top)));
    const cases: FamilyCase[] = [];
    slice.forEach((draft, i) => {
      const tag = `c${start + i}`;
      add(i, draft.block(tag));
      cases.push({ id: draft.id, tag, lines: owned[i]! });
    });
    programs.push({
      name: `copy-soundness-${String(programs.length).padStart(2, "0")}`,
      source: lines.join("\n") + "\n",
      cases,
    });
  }
  return programs;
}
