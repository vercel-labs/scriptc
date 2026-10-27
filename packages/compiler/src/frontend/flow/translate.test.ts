import { createRequire } from "node:module";
import { expect, test } from "vitest";
import { translateFlow, type FlowNode, type FlowTranslateOptions } from "./translate.js";

const hermes = createRequire(import.meta.url)("hermes-parser") as {
  parse(text: string, options: object): FlowNode;
};

/** The TypeScript a Flow module translates to, without the header line. */
function translate(source: string, options: FlowTranslateOptions = {}): string {
  const program = hermes.parse(source, { flow: "all", sourceType: "module", tokens: false });
  return translateFlow(source, program, options).text.split("\n").slice(1).join("\n");
}

test("an array literal of references is the tuple Flow infers", () => {
  expect(
    translate("function f(a: number, b: {c: string}) { const pair = [a, b.c]; g(pair); }"),
  ).toContain("const pair: [typeof a, typeof b.c] = [a, b.c];");
  // Used as an array, the binding keeps TypeScript's array inference.
  expect(translate("function f(a: number) { const list = [a]; list.push(1); }")).toContain(
    "const list = [a];",
  );
  // Elements that are not references keep it too.
  expect(translate("function f(a: number) { const list = [a, 1]; g(list); }")).toContain(
    "const list = [a, 1];",
  );
});

test("a binding initialized with a silenced null holds null", () => {
  const constants = new Map([["__DEV__", false]]);
  expect(
    translate("export const f: (x: number) => number = __DEV__ ? (g: any) : (null: any);", {
      constants,
    }),
  ).toContain("export const f: ((x: number) => number) | null = ((null as unknown));");
  expect(translate("const k: string = __DEV__ ? 'a' : (null as any);", { constants })).toContain(
    "const k: (string) | null = (null as unknown);",
  );
  // A live branch keeps the declared type.
  expect(translate("const k: string = (null: any) || 'x';")).toContain("const k: string =");
});

test("a type corrected to unique symbol is its constant's symbol", () => {
  const types = new Map([["Key", "unique symbol"]]);
  const out = translate(
    "export const KEY: Key = Symbol.for('key');\nexport type Key = true;\nfunction f(k: null | string | Key) {}",
    {
      types,
    },
  );
  expect(out).toContain("export const KEY: unique symbol = Symbol.for('key');");
  expect(out).toContain("export type Key = typeof KEY;");
  expect(out).toContain("k: null | string | Key");
  // Declared elsewhere, the alias is a plain symbol and references name it.
  expect(translate("export type Key = true;", { types })).toContain("export type Key = symbol;");
});

test("dynamic and corrected types replace their aliases and references", () => {
  const types = new Map([
    ["Node", "unknown"],
    ["Id", "string"],
  ]);
  const out = translate(
    "type Node = {a: number};\ninterface Id {x: number}\nfunction f(n: Node, i: Id): Array<Node> {}",
    { types },
  );
  expect(out).toContain("type Node = unknown;");
  expect(out).toContain("type Id = string;");
  expect(out).toContain("function f(n: (unknown), i: (string)): Array<(unknown)>");
});

test("a function reading arguments declares a variadic overload", () => {
  const out = translate(
    "export function make(type, config: {}, children) { return arguments.length; }",
  );
  expect(out).toContain(
    "export function make(type?: unknown, config?: {}, children?: unknown, ...rest_: unknown[]): unknown;\nexport function make(type: unknown, config: {}, children?: unknown) {",
  );
  // A nested function's own arguments do not count.
  expect(
    translate("function outer(a: number) { return function () { return arguments; }; }"),
  ).not.toContain("rest_");
  expect(translate("function local(a: number): number { return arguments[0]; }")).toContain(
    "function local(a?: number, ...rest_: unknown[]): number;\nfunction local(a: number): number {",
  );
});

test("a module binding only ever assigned one class holds that class or null", () => {
  const out = translate(
    "let view = null;\nfunction reset() { view = new Uint8Array(4); }\nfunction clear() { view = null; }",
  );
  expect(out).toContain("let view: Uint8Array | null = null;");
  // Writes of different kinds keep TypeScript's inference.
  expect(
    translate(
      "let view = null;\nfunction f() { view = new Uint8Array(4); }\nfunction g() { view = 'x'; }",
    ),
  ).toContain("let view = null;");
});

test("an any cast that reads a member asserts the value is present", () => {
  const out = translate(
    "let v = null;\nfunction f() { v = new Uint8Array(4); (v: any).subarray(1); (v as any).set([1]); }",
  );
  expect(out).toContain("(v)!.subarray(1);");
  expect(out).toContain("(v!).set([1]);");
  // A cast used as a value keeps the operand.
  expect(translate("function f(x: ?string) { const s: string = (x: any); }")).toContain(
    "const s: string = (x);",
  );
});
