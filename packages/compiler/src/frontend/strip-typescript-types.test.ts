/* module.stripTypeScriptTypes in strip mode is pinned against Node itself:
 * the answers must be byte-identical, because the API keeps every source
 * position and only blanks the type syntax. */
import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";
import { stripTypeScriptTypesStrip } from "./strip-typescript-types.js";

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
];

describe("stripTypeScriptTypes (strip mode) matches Node", () => {
  test.for(CASES.map((code) => [JSON.stringify(code), code] as const))("%s", ([, code]) => {
    expect(stripTypeScriptTypesStrip(code)).toBe(nodeModule.stripTypeScriptTypes(code));
  });
});
