import { afterAll, expect, test } from "vitest";
import * as ts from "../ts7/adapter.js";
import { closeSourceParser, parseSourceFile } from "../ts7/source-parser-node.js";
import { isValueReturningConstructorClass } from "./js-dynamic-objects.js";

afterAll(closeSourceParser);

function classify(source: string, returnsObject?: (returned: ts.Expression) => boolean): boolean {
  const file = parseSourceFile("classes.js", source, "js");
  let decl: ts.ClassDeclaration | undefined;
  ts.walkPreorder(file, (node) => {
    if (!decl && ts.isClassDeclaration(node)) decl = node;
  });
  if (!decl) throw new Error("fixture has no class");
  return isValueReturningConstructorClass(decl, returnsObject);
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

test("a constructor that keeps what it builds on this and returns it is claimed", () => {
  const object = (): boolean => true;
  // `this` only as the receiver of named properties, also inside arrows.
  expect(
    classify(
      `class C { constructor(o = {}) { this.fn = function () { return new C(o); }; this.fn.label = () => o.name; Object.keys(o).forEach((k) => { this.fn[k] = o[k]; }); return this.fn; } }`,
      object,
    ),
  ).toBe(true);
  expect(classify(`class C { constructor() { this.a = 1; return {}; } }`, object)).toBe(true);
  // A returned value that is not known to be an object may answer the instance.
  expect(
    classify(`class C { constructor(n) { this.size = n.length; return this.size; } }`, () => false),
  ).toBe(false);
  // A path that ends without a value answers the instance.
  expect(
    classify(
      `class C { constructor(n) { this.size = n; if (n > 1) return { size: 99 }; } }`,
      object,
    ),
  ).toBe(false);
  expect(
    classify(
      `class C { constructor(n) { this.size = n; if (n > 1) return; return { n }; } }`,
      object,
    ),
  ).toBe(false);
  // Without an answer about the returned values the class is left alone.
  expect(classify(`class C { constructor() { this.fn = () => 1; return this.fn; } }`)).toBe(false);
});

test("an instance that leaves the constructor keeps its class", () => {
  const object = (): boolean => true;
  // `this` as a value, as a computed receiver, or read through its prototype.
  expect(classify(`class C { constructor() { seen.push(this); return {}; } }`, object)).toBe(false);
  expect(classify(`class C { constructor(k) { this[k] = 1; return {}; } }`, object)).toBe(false);
  expect(
    classify(`class C { constructor() { this.kind = this.constructor.name; return {}; } }`, object),
  ).toBe(false);
  expect(classify(`class C { constructor() { this.__proto__.x = 1; return {}; } }`, object)).toBe(
    false,
  );
  expect(
    classify(`class C { constructor() { const self = this; return { self }; } }`, object),
  ).toBe(false);
});
