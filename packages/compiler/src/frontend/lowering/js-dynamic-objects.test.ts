import { afterAll, expect, test } from "vitest";
import * as ts from "../ts7/adapter.js";
import { closeSourceParser, parseSourceFile } from "../ts7/source-parser-node.js";
import { isValueReturningConstructorClass } from "./js-dynamic-objects.js";

afterAll(closeSourceParser);

function classify(source: string): boolean {
  const file = parseSourceFile("classes.js", source, "js");
  let decl: ts.ClassDeclaration | undefined;
  ts.walkPreorder(file, (node) => {
    if (!decl && ts.isClassDeclaration(node)) decl = node;
  });
  if (!decl) throw new Error("fixture has no class");
  return isValueReturningConstructorClass(decl);
}

test("a constructor-only class returning a value is claimed", () => {
  expect(classify(`class Chalk { constructor(options) { return chalkFactory(options); } }`)).toBe(
    true,
  );
  expect(classify(`class C { constructor(a) { if (a) return { a }; return [a]; } ; }`)).toBe(true);
  expect(classify(`class C { constructor() { const f = () => 1; return { f }; } }`)).toBe(true);
});

test("classes that keep their instance layout are left alone", () => {
  // No value return, or only nested functions return.
  expect(classify(`class C { constructor() { return; } }`)).toBe(false);
  expect(classify(`class C { constructor() { function f() { return 1; } f(); } }`)).toBe(false);
  expect(classify(`class C { constructor() { const f = () => { return 1; }; f(); } }`)).toBe(false);
  // Other members, heritage, or a constructor that observes `this`.
  expect(classify(`class C { constructor() { return {}; } m() {} }`)).toBe(false);
  expect(classify(`class C { x = 1; constructor() { return {}; } }`)).toBe(false);
  expect(classify(`class C extends B { constructor() { super(); return {}; } }`)).toBe(false);
  expect(classify(`class C { constructor() { this.a = 1; return {}; } }`)).toBe(false);
  expect(classify(`class C { constructor() { const g = () => this; return { g }; } }`)).toBe(false);
  expect(classify(`class C {}`)).toBe(false);
});
