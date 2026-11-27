/* module.stripTypeScriptTypes in strip mode is pinned against Node itself:
 * the answers must be byte-identical — the API keeps every source position
 * and only blanks the type syntax — and the same programs must be refused,
 * with Node's code and message, where the syntax cannot be erased. */
import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";
import { StripUnsupportedSyntax, stripTypeScriptTypesStrip } from "./strip-typescript-types.js";

const nodeModule = createRequire(import.meta.url)("node:module") as {
  stripTypeScriptTypes(code: string): string;
};

const CASES: readonly string[] = [
  "const x: number = 1;",
  "interface A { b: string }\nconst y: A = { b: 'x' };",
  "function f<T>(a: T): T { return a; }",
  "type T = string;\nlet v: T = 'a';",
  "const g = <T,>(v: T) => v;",
  "const v = {} as any;",
  "const v = x!;",
  "function f(a?: string) {}",
  "let v!: number;",
  "f<string>('x');",
  "import type { A } from './a';\nlet v: A;",
  "@dec class C {}",
  // `declare` declarations are erasable; a leading comment survives the blank.
  "declare enum E { A }\nconst x = 1;",
  "declare namespace N { const a: number; }\nconst y = 2;",
  "// keeps\ninterface A { b: string }\nconst z = 1;",
  // Class modifiers that only change the type surface erase; `static` stays.
  "class C { public a = 1; private b = 2; readonly c = 3; static d = 4; }",
  "class C implements I { a = 1; }",
  "abstract class C { abstract m(): void; }",
  "class C { declare x: number; }",
  "class C extends B { override m() {} }",
  // Inline type-only specifiers erase; the value specifiers stay.
  "import { type A, b } from './m';\nconsole.log(b);",
  "export { type A, b };\nconst b = 1;",
  // A namespace of only type declarations is erasable, as in Node.
  "namespace N { export type A = string; }\nconst ok = 1;",
  // Optional markers, definite assignment, overload signatures.
  "interface I { m?(): void; }\nclass C { m?() {} }",
  "class C { x!: number; }",
  "function f(a: string): void;\nfunction f(a: any) {}\nf('x');",
  // Leading comments survive a type-only statement, and a comment between a
  // type-only specifier and its comma blanks with it.
  "// leading\nimport type { A } from './m';\nconst z = 1;",
  "import { type A /* c */, b } from './m';\nconsole.log(b);",
];

const REFUSED: readonly string[] = [
  "enum E { A }",
  "namespace N { export const a = 1; }",
  "class C { constructor(private x: number) {} }",
  "const v = <string>someValue;",
  "class C { override m() {} }",
];

function nodeStrip(code: string): { text: string } | { code: string; message: string } {
  try {
    return { text: nodeModule.stripTypeScriptTypes(code) };
  } catch (error) {
    const e = error as { code?: string; message: string };
    return { code: e.code ?? "", message: e.message };
  }
}

function ourStrip(code: string): { text: string } | { code: string; message: string } {
  try {
    return { text: stripTypeScriptTypesStrip(code) };
  } catch (error) {
    if (!(error instanceof StripUnsupportedSyntax)) throw error;
    return { code: error.code, message: error.message };
  }
}

describe("stripTypeScriptTypes (strip mode) matches Node", () => {
  test.for(CASES.map((code) => [JSON.stringify(code), code] as const))("%s", ([, code]) => {
    expect(ourStrip(code)).toEqual(nodeStrip(code));
  });

  test.for(REFUSED.map((code) => [JSON.stringify(code), code] as const))("%s", ([, code]) => {
    expect(ourStrip(code)).toEqual(nodeStrip(code));
  });
});
