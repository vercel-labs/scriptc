import { afterAll, expect, test } from "vitest";
import * as ts from "../ts7/adapter.js";
import { closeSourceParser, parseSourceFile } from "../ts7/source-parser-node.js";
import { presentAtUse } from "./runtime-optional-guards.js";

afterAll(closeSourceParser);

/** Every `use(x)` argument in `body`, in source order, with whether a
 * presence proof holds for it. Bindings are matched by name. */
function proofs(body: string): boolean[] {
  const file = parseSourceFile(
    "guards.ts",
    `declare function use(value: unknown): void;\n${body}`,
    "ts",
  );
  const results: boolean[] = [];
  ts.walkPreorder(file, (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "use"
    ) {
      const arg = node.arguments[0];
      if (arg && ts.isIdentifier(arg))
        results.push(
          presentAtUse(arg, {
            sameBinding: (other) => other.text === arg.text,
            isUndefined: (other) => other.text === "undefined",
          }),
        );
    }
    return undefined;
  });
  return results;
}

test("an enclosing condition proves presence in the branch it guards", () => {
  expect(
    proofs(`function f(x: string) {
      if (x !== undefined) use(x);
      if (x === undefined) {} else use(x);
      if (x) use(x);
      if (!x) use(x);
      if (typeof x === "string") use(x);
      if (typeof x !== "undefined") use(x);
      if (x != null) use(x);
      if (x !== null) use(x);
      if (x === "a" || x === "b") use(x);
      if (x instanceof Object) use(x);
    }`),
  ).toEqual([true, true, true, false, true, true, true, false, true, true]);
});

test("short-circuit and conditional operands see their guard", () => {
  expect(
    proofs(`function f(x: string, y: boolean) {
      x !== undefined && use(x);
      x === undefined || use(x);
      x ?? use(x);
      x !== undefined ? use(x) : use(x);
      y && use(x);
    }`),
  ).toEqual([true, true, false, true, false, false]);
});

test("an earlier exit or dereference in an enclosing statement list proves presence", () => {
  expect(
    proofs(`function f(x: { k: number }, items: number[]) {
      if (x === undefined) return;
      use(x);
    }
    function g(x: { k: number }) {
      const k = x.k;
      use(x);
    }
    function h(x: { k: number }) {
      if (x === undefined) { log(); }
      use(x);
    }
    function i(x: { k: number }) {
      for (const n of [1]) {
        if (!x) continue;
        use(x);
      }
      use(x);
    }
    declare function log(): void;`),
  ).toEqual([true, true, false, true, false]);
});

test("optional chains, assignment targets and later arguments do not dereference first", () => {
  expect(
    proofs(`function f(x: { k: number }, o: { k: number }) {
      const a = x?.k;
      use(x);
    }
    function g(x: { k: number }, o: { k: number }) {
      o.k = (use(x), 1);
      x.k = 2;
    }
    function h(x: { k: number }) {
      x.k(use(x));
    }`),
  ).toEqual([false, false, true]);
});

test("a hoisted function declaration cannot rely on earlier statements", () => {
  expect(
    proofs(`function f(x: { k: number }) {
      if (x === undefined) return inner();
      function inner() { use(x); }
      const later = () => use(x);
      return later;
    }`),
  ).toEqual([false, true]);
});
