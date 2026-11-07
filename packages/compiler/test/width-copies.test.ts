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

test("a conversion routed through a union reports at its own site", () => {
  const seen = facts(
    `${TYPES}function flag(): boolean { return process.argv.length < 100; }\nconst w: W = { a: 1, b: "x" }; const x: W | null = flag() ? w : null; const y: N | null = x; y!.a = 2; console.log(w.a);`,
  );
  expect(seen.facts).toEqual([
    { kind: "width", depth: "value", aliasable: true, observed: "write" },
  ]);
});
