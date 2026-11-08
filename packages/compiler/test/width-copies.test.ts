/* The width-copy facts (frontend/lowering/width-copies.ts) are read off the
 * lowered program: one per conversion that builds a new object, with
 * whether the converted value is aliasable and what the program does that
 * tells the copy from its object. These tests pin the classification; the
 * end-to-end rule (no warning means Node's output) is
 * tests/harness/copy-soundness.test.ts. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { analyze } from "../src/index.js";

interface Seen {
  kind: string;
  depth: string;
  aliasable: boolean;
  observed: string | null;
}

function facts(source: string, refusals: string[] = []): { facts: Seen[]; warnings: string[] } {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-width-copies-"));
  try {
    const entry = join(dir, "main.ts");
    writeFileSync(entry, source);
    const result = analyze(entry);
    expect(result.coverage.diagnostics.map((d) => `${d.code}: ${d.message}`)).toEqual(refusals);
    return {
      facts: (result.widthCopies ?? []).map((fact) => ({
        kind: fact.kind,
        depth: fact.depth,
        aliasable: fact.aliasable,
        observed: fact.observed?.how ?? null,
      })),
      warnings: (result.coverage.divergences ?? [])
        .filter((d) => d.code === "SC6001")
        .map((d) => d.message),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const TYPES = `interface N { a: number }\ninterface W { a: number; b: string }\n`;

test("a program without conversions has no facts", () => {
  const seen = facts(`const w = { a: 1, b: "x" }; w.a = 2; console.log(w.a, w === w);`);
  expect(seen.facts).toEqual([]);
  expect(seen.warnings).toEqual([]);
});

test("a copy of a literal is fresh, and never a warning", () => {
  const seen = facts(
    `${TYPES}function make(): W { return { a: 1, b: "x" }; }\nconst n: N = make(); n.a = 2; console.log(n.a, JSON.stringify(n));`,
  );
  expect(seen.facts).toEqual([{ kind: "width", depth: "value", aliasable: false, observed: null }]);
  expect(seen.warnings).toEqual([]);
});

test("an aliasable copy the program only reads is not a warning", () => {
  const seen = facts(
    `${TYPES}const w: W = { a: 1, b: "x" }; const read = (n: N): number => n.a; console.log(read(w), w.b);`,
  );
  expect(seen.facts).toEqual([{ kind: "width", depth: "value", aliasable: true, observed: null }]);
  expect(seen.warnings).toEqual([]);
});

test("a write to either layout makes the copy a warning, wherever the copy went", () => {
  const through = facts(
    `${TYPES}const w: W = { a: 1, b: "x" }; const m = new Map<string, N>(); m.set("k", w); m.get("k")!.a = 3; console.log(w.a);`,
  );
  expect(through.facts).toEqual([
    { kind: "width", depth: "value", aliasable: true, observed: "write" },
  ]);
  expect(through.warnings).toHaveLength(1);
  expect(through.warnings[0]).toContain(
    "converting this '{ a: number; b: string }' to '{ a: number }'",
  );
  expect(through.warnings[0]).toContain(
    "the program writes field 'a' of a '{ a: number }' (main.ts:3)",
  );

  const source = facts(
    `${TYPES}const w: W = { a: 1, b: "x" }; const xs: N[] = [w]; w.a = 9; console.log(xs[0]!.a);`,
  );
  expect(source.facts.map((f) => f.observed)).toEqual(["write"]);
  // A write to a field the copy does not have is not one.
  const other = facts(
    `${TYPES}const w: W = { a: 1, b: "x" }; const xs: N[] = [w]; w.b = "y"; console.log(xs[0]!.a, w.b);`,
  );
  expect(other.facts.map((f) => f.observed)).toEqual([null]);
});

test("identity comparisons and searches of the copy's type make it a warning", () => {
  const compared = facts(
    `${TYPES}const w: W = { a: 1, b: "x" }; const same = (x: N, y: N): boolean => x === y; console.log(same(w, w));`,
  );
  expect(compared.facts.map((f) => f.observed)).toEqual(["identity", "identity"]);
  const searched = facts(
    `${TYPES}const w: W = { a: 1, b: "x" }; const xs: N[] = []; xs.push(w); console.log(xs.includes(w));`,
  );
  expect(new Set(searched.facts.map((f) => f.observed))).toEqual(new Set(["identity"]));
  const untyped = facts(
    `${TYPES}const w: W = { a: 1, b: "x" }; const n: N = w; console.log((n as unknown) === (w as unknown));`,
  );
  expect(untyped.facts.map((f) => f.observed)).toEqual(["untyped"]);
});

test("a copy inside the converted value is a member fact", () => {
  const seen = facts(
    `${TYPES}const inner: W = { a: 1, b: "x" }; const o: { i: W; t: number } = { i: inner, t: 1 }; const v: { i: N } = o; v.i.a = 8; console.log(inner.a);`,
  );
  expect(seen.facts).toEqual([
    { kind: "width", depth: "value", aliasable: true, observed: null },
    { kind: "width", depth: "member", aliasable: true, observed: "write" },
  ]);
  expect(seen.warnings).toHaveLength(1);
  expect(seen.warnings[0]).toContain("copies the '{ a: number; b: string }' inside the value");
});

test("arrays, tuples and class targets have their own kinds", () => {
  const arr = facts(
    `${TYPES}const ws: W[] = [{ a: 1, b: "x" }]; const ns: N[] = ws; ns.push({ a: 5 }); console.log(ws.length);`,
  );
  expect(arr.facts).toEqual([
    { kind: "arr", depth: "value", aliasable: true, observed: "write" },
    { kind: "width", depth: "member", aliasable: true, observed: null },
  ]);
  const tuple = facts(
    `const t: [number, number] = [1, 2]; const xs: number[] = t; xs[0] = 9; console.log(t[0]);`,
  );
  expect(tuple.facts).toEqual([
    { kind: "tupleArr", depth: "value", aliasable: true, observed: "write" },
  ]);
});

test("a record built into a class instance is refused where the program can tell", () => {
  const CLASS = `class Q { constructor(public x: number) {} }\n`;
  const read = facts(`${CLASS}const r = { x: 1 }; const q: Q = r; console.log(q.x, r.x);`);
  expect(read.facts).toEqual([
    { kind: "clsWidth", depth: "value", aliasable: true, observed: null },
  ]);
  facts(`${CLASS}const r = { x: 1 }; const q: Q = r; q.x = 5; console.log(r.x);`, [
    "SC1090: converting a '{ x: number }' to the class 'Q' in a program that writes field 'x' of a 'Q' (main.ts:2) is not supported yet",
  ]);
});

test("a derived class's construction is not a write after the copy", () => {
  // The fields a constructor stores before anything can hold the object are
  // not writes a copy could miss, also where the constructor first calls its
  // base's, and where the base is a class the runtime provides.
  const DIAL = `class Dial { turns = 20 }\n`;
  const USE = `function turns(source: { dial: Dial }): number { return source.dial.turns; }\nconst radio = new Radio(); radio.dial.turns += 5; console.log(turns(radio));`;
  const quiet = [{ kind: "objWidth", depth: "value", aliasable: true, observed: null }];
  const derived = facts(
    `${DIAL}class Chassis { serial = 7 }\nclass Radio extends Chassis { dial: Dial = new Dial(); band = "fm" }\n${USE}`,
  );
  expect(derived.facts).toEqual(quiet);
  expect(derived.warnings).toEqual([]);
  const emitter = facts(
    `import { EventEmitter } from "node:events";\n${DIAL}class Radio extends EventEmitter { dial: Dial = new Dial(); band = "fm" }\n${USE}`,
  );
  expect(emitter.facts).toEqual(quiet);
  expect(emitter.warnings).toEqual([]);
  const error = facts(
    `${DIAL}class Radio extends Error { dial: Dial = new Dial(); band = "fm" }\n${USE}`,
  );
  expect(error.facts).toEqual(quiet);
  expect(error.warnings).toEqual([]);
  // A constructor that hands the object to the program's own code lets it
  // out before its fields are stored: those stores are writes.
  const leaked = facts(
    `${DIAL}const seen: Chassis[] = [];\nclass Chassis { serial = 7; constructor() { seen.push(this); } }\nclass Radio extends Chassis { dial: Dial = new Dial(); band = "fm" }\n${USE}`,
  );
  expect(leaked.facts).toEqual([
    { kind: "objWidth", depth: "value", aliasable: true, observed: "write" },
  ]);
});

test("a conversion of a copy is a copy of the first value", () => {
  // `w` reaches M through N. Node has one object, so the write through M
  // is lost exactly as a write through N would be: the second conversion
  // is not excused by the first.
  const TYPES3 = `interface M { a: number }\ninterface N { a: number; b: string }\ninterface W { a: number; b: string; c: boolean }\n`;
  const seen = facts(
    `${TYPES3}function narrow(x: W): N { return x; }\nconst w: W = { a: 1, b: "x", c: true }; const hold: { m: M } = { m: narrow(w) }; hold.m.a = 7; console.log(w.a);`,
  );
  expect(seen.facts.filter((f) => f.observed === "write")).toHaveLength(1);
  expect(seen.warnings).toHaveLength(1);
  expect(seen.warnings[0]).toContain("to '{ a: number }'");
});

test("a conversion routed through a union reports at its own site", () => {
  const seen = facts(
    `${TYPES}function flag(): boolean { return process.argv.length < 100; }\nconst w: W = { a: 1, b: "x" }; const x: W | null = flag() ? w : null; const y: N | null = x; y!.a = 2; console.log(w.a);`,
  );
  expect(seen.facts).toEqual([
    { kind: "width", depth: "value", aliasable: true, observed: "write" },
  ]);
});

test("a call that builds its union result is fresh", () => {
  // The literals are wrapped into the union the function returns: the box
  // is a value, and nothing else holds the record inside it.
  const seen = facts(
    `${TYPES}function make(flag: boolean): W | null { return flag ? { a: 1, b: "x" } : null; }\nconst n: N | null = make(process.argv.length < 100); if (n !== null) n.a = 2; console.log(n?.a);`,
  );
  expect(seen.facts).toEqual([{ kind: "width", depth: "value", aliasable: false, observed: null }]);
  expect(seen.warnings).toEqual([]);
});

/** The refusals of a program, as `code: message`. */
function refusalsOf(source: string): string[] {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-width-copies-"));
  try {
    const entry = join(dir, "main.ts");
    writeFileSync(entry, source);
    return analyze(entry).coverage.diagnostics.map((d) => `${d.code}: ${d.message}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// `Stored` takes a `Shipped` by width, so a `Shipped` fits two arms of
// `Tracked` and enters the one its `place` names. `Crate` lacks the member,
// so the source union keeps no discriminant of its own.
const PARCELS = `type Crate = { weight: number };\ntype Stored = { place: "stored"; shelf?: number };\ntype Shipped = { place: "shipped"; carrier: string; days: number };\ntype Parcel = Stored | Shipped;\ntype Tracked = Parcel & { scanned?: boolean };\nconst dock: (Crate | Parcel)[] = [{ weight: 4 }, { place: "shipped", carrier: "rail", days: 2 }, { place: "stored" }];\n`;

test("a union arm that enters by its own discriminant compiles where nothing tells the copy from the object", () => {
  const seen = facts(
    `${PARCELS}for (const item of dock) if ("place" in item) { const t: Tracked = item; console.log(t.place, t.scanned, JSON.stringify(item)); }`,
  );
  expect(seen.facts.length).toBeGreaterThan(0);
  expect(seen.facts.every((f) => f.kind === "width" && f.aliasable && f.observed === null)).toBe(
    true,
  );
  expect(seen.warnings).toEqual([]);
});

test("a union arm that enters by its own discriminant is refused where the program can tell", () => {
  // A write through the converted value while the list still holds the
  // object: to a member of the arm that has two destination arms,
  const written = refusalsOf(
    `${PARCELS}for (const item of dock) if ("place" in item) { const t: Tracked = item; t.scanned = true; console.log(JSON.stringify(item)); }`,
  );
  expect(written).toHaveLength(1);
  expect(written[0]).toContain(
    "SC2003: union conversion has no layout mapping that keeps the object",
  );
  expect(written[0]).toContain("the program writes field 'scanned'");
  // and to a member only the arm with one destination arm has. Without the
  // route the conversion has no plan at all, so each of its copies counts.
  const oneArm = refusalsOf(
    `${PARCELS}for (const item of dock) if ("place" in item) { const t: Tracked = item; if (t.place === "stored") t.shelf = 7; console.log(JSON.stringify(item)); }`,
  );
  expect(oneArm).toHaveLength(1);
  expect(oneArm[0]).toContain("the program writes field 'shelf'");
});
