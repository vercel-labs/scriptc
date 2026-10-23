import { afterAll, expect, test } from "vitest";
import * as ts from "../ts7/adapter.js";
import { closeSourceParser, parseSourceFile } from "../ts7/source-parser-node.js";
import {
  type BoundsFacts,
  indexReadInBounds,
  indexStoreInBounds,
} from "./runtime-optional-bounds.js";

afterAll(closeSourceParser);

/** Whether each indexed store in `body` is proven to stay inside its array. */
function stores(body: string, facts: BoundsFacts = {}): boolean[] {
  const file = parseSourceFile("bounds.ts", body, "ts");
  const results: boolean[] = [];
  ts.walkPreorder(file, (node) => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isElementAccessExpression(node.left)
    )
      results.push(indexStoreInBounds(node, facts));
    return undefined;
  });
  return results;
}

test("a dominating length comparison or asserted read bounds the store", () => {
  const body = `function f(xs: number[], i: number) {
      for (let j = 0; j < xs.length; j++) xs[j] = 0;
      if (i < xs.length) xs[i] = 1;
      if (xs.length > i) { xs[i] = 2; }
      const old = xs[i]!;
      xs[i] = old + 1;
      xs[i] = 3;
    }`;
  expect(stores(body, { assertedReadsThrow: true })).toEqual([true, true, true, true, true]);
  // Where `xs[i]!` reads undefined for a missing index, it bounds nothing.
  expect(stores(body)).toEqual([true, true, true, false, false]);
});

test("a swap is bounded by the reads that precede each store", () => {
  const body = `function swap(xs: number[], a: number, b: number) {
      const t = xs[a]!;
      xs[a] = xs[b]!;
      xs[b] = t;
    }`;
  expect(stores(body, { assertedReadsThrow: true })).toEqual([true, true]);
  expect(stores(body)).toEqual([false, false]);
});

test("code that can change the length or an operand voids the proof", () => {
  expect(
    stores(`declare function shrink(): void;
    function f(xs: number[], i: number) {
      if (i < xs.length) { shrink(); xs[i] = 1; }
      if (i < xs.length) { xs.length = 0; xs[i] = 2; }
      if (i < xs.length) { i++; xs[i] = 3; }
      if (i < xs.length) { xs = []; xs[i] = 4; }
      if (i < xs.length) xs[i + 1] = 5;
      if (i <= xs.length) xs[i] = 6;
      while (i < xs.length) { xs[i] = 7; xs.pop(); }
    }`),
  ).toEqual([false, false, false, false, false, false, true]);
});

test("a guarded read forwarded to a call is bounded when nothing earlier can change it", () => {
  const file = parseSourceFile(
    "reads.ts",
    `declare function use(...values: number[]): void;
    declare function shrink(): number;
    function f(xs: number[], i: number) {
      for (let j = 0; j < xs.length; j++) use(xs[j]!);
      if (i < xs.length) use(i, xs[i]!);
      if (i < xs.length) use(shrink(), xs[i]!);
      use(xs[i]!);
      if (i < xs.length) { const v = xs[i]!; use(v); }
    }`,
    "ts",
  );
  const results: boolean[] = [];
  ts.walkPreorder(file, (node) => {
    if (ts.isElementAccessExpression(node)) results.push(indexReadInBounds(node));
    return undefined;
  });
  expect(results).toEqual([true, true, false, false, true]);
});

test("an if condition reads like a statement, and a same-length fact extends the guard", () => {
  const file = parseSourceFile(
    "same-length.ts",
    `declare function use(...values: number[]): boolean;
    function f(xs: Uint32Array, ys: Uint32Array, zs: Uint32Array) {
      for (let i = 0; i < xs.length; i++) if (use(xs[i], ys[i], zs[i])) return;
      for (let i = 0; i < xs.length; i++) if (use(xs[i], use(), ys[i])) return;
    }`,
    "ts",
  );
  const results: boolean[] = [];
  const facts = {
    conditions: true,
    sameLength: (array: ts.Expression, other: ts.Expression) =>
      ts.isIdentifier(array) &&
      ts.isIdentifier(other) &&
      [array.text, other.text].sort().join() === "xs,ys",
  };
  ts.walkPreorder(file, (node) => {
    if (ts.isElementAccessExpression(node)) results.push(indexReadInBounds(node, facts));
    return undefined;
  });
  expect(results).toEqual([true, true, false, true, false]);
  // Without the opt-in, a read in an `if` condition keeps its old answer.
  const plain: boolean[] = [];
  ts.walkPreorder(file, (node) => {
    if (ts.isElementAccessExpression(node)) plain.push(indexReadInBounds(node));
    return undefined;
  });
  expect(plain).toEqual([false, false, false, false, false]);
});

test("a length-alias fact lets a cached length bound the read", () => {
  const file = parseSourceFile(
    "length-alias.ts",
    `function f(src: Uint8Array, dst: Uint8Array) {
      const n = src.length;
      for (let i = 0; i < n; i++) { const c = src[i]; }
      for (let i = 0; i < n; i++) { const c = dst[i]; }
    }`,
    "ts",
  );
  const results: boolean[] = [];
  const facts = {
    lengthAlias: (bound: ts.Expression, array: ts.Expression) =>
      ts.isIdentifier(bound) &&
      bound.text === "n" &&
      ts.isIdentifier(array) &&
      array.text === "src",
  };
  ts.walkPreorder(file, (node) => {
    if (ts.isElementAccessExpression(node)) results.push(indexReadInBounds(node, facts));
    return undefined;
  });
  expect(results).toEqual([true, false]);
  const plain: boolean[] = [];
  ts.walkPreorder(file, (node) => {
    if (ts.isElementAccessExpression(node)) plain.push(indexReadInBounds(node));
    return undefined;
  });
  expect(plain).toEqual([false, false]);
});

test("a conditional expression's condition bounds its true branch", () => {
  const file = parseSourceFile(
    "conditional.ts",
    `declare function use(...values: number[]): number;
    function f(xs: number[], i: number) {
      const a = xs.length > 2 ? xs[2]! : 0;
      const b = i < xs.length ? xs[i]! : -1;
      const c = i < xs.length ? 0 : xs[i]!;
      const d = i < xs.length ? use(xs[i]!, i++, xs[i]!) : 0;
    }`,
    "ts",
  );
  const results: boolean[] = [];
  ts.walkPreorder(file, (node) => {
    if (ts.isElementAccessExpression(node)) results.push(indexReadInBounds(node));
    return undefined;
  });
  expect(results).toEqual([true, true, false, true, false]);
});
