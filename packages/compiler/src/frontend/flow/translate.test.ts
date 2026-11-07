import { createRequire } from "node:module";
import { expect, test } from "vitest";
import { translateFlow, type FlowNode, type FlowTranslateOptions } from "./translate.js";

const hermes = createRequire(import.meta.url)("hermes-parser") as {
  parse(text: string, options: object): FlowNode;
};

/** The TypeScript a Flow module translates to, with its header line. */
function translated(source: string, options: FlowTranslateOptions = {}): string {
  const program = hermes.parse(source, { flow: "all", sourceType: "module", tokens: false });
  return translateFlow(source, program, options).text;
}

/** The TypeScript a Flow module translates to, without the header line. */
function translate(source: string, options: FlowTranslateOptions = {}): string {
  return translated(source, options).split("\n").slice(1).join("\n");
}

test("the header that leaves checking to Flow follows a `#!` line", () => {
  expect(translated("#!/usr/bin/env node\nconst x = 1;")).toBe(
    "#!/usr/bin/env node\n// @ts-nocheck: a Flow module, checked by Flow.\nconst x = 1;",
  );
});

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
  // A hole is no element to name, so the literal stays an array. It arrives
  // as a null element, which the list walks must not treat as a node.
  expect(translate("function f(a: number) { const list = [a, , a]; g(list); }")).toContain(
    "const list = [a, , a];",
  );
  expect(translate("function f([a, , b]: Array<number>) { return a + b; }")).toContain(
    "function f([a, , b]: Array<number>) {",
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
  // The overload keeps a declared `this`, and the implementation repeats
  // the declaration's own `export default`, not a comment's.
  expect(
    translate(
      "/* c */ export /* d */ default function count(this: Ctx, a) { return arguments.length; }",
    ),
  ).toContain(
    "/* c */ export /* d */ default function count(this: Ctx, a?: unknown, ...rest_: unknown[]): unknown;\nexport default function count(",
  );
  expect(translate("// export\nfunction f(a) { return arguments.length; }")).toContain(
    "// export\nfunction f(a?: unknown, ...rest_: unknown[]): unknown;\nfunction f(",
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
  // An optional read keeps the value that may be absent.
  expect(translate("function f(v) { return (v: any)?.foo; }")).toContain("return (v)?.foo;");
});

test("a cast applies to its whole operand", () => {
  const out = translate(
    "const f = ((v) => v: (number) => number);\nconst a = (x || y: string);\nconst b = ((x): number);\nconst c = (x /* why */ : number);",
  );
  expect(out).toContain("const f = (((v) => v) as (arg0: number) => number);");
  expect(out).toContain("const a = ((x || y) as string);");
  expect(out).toContain("const b = ((x) as number);");
  expect(out).toContain("const c = (x /* why */  as number);");
});

test("constants replace the free references to their names", () => {
  const constants = new Map<string, boolean | number | string | null>([
    ["__DEV__", false],
    ["LEVEL", -1],
    ["meta", 1],
    ["target", 2],
  ]);
  const out = translate(
    "const s = {__DEV__, LEVEL};\nconst t = LEVEL.toString() + -LEVEL;\nclass A { __DEV__() {} __DEV__x = 1; }\nconst o = {__DEV__: 1, x: o.__DEV__};\nconst m = import.meta;\nfunction N() { return new.target; }",
    { constants },
  );
  // `import.meta` and `new.target` name no binding.
  expect(out).toContain("const m = import.meta;");
  expect(out).toContain("return new.target;");
  expect(out).toContain("const s = {__DEV__: false, LEVEL: (-1)};");
  expect(out).toContain("const t = (-1).toString() + -(-1);");
  // Member names are not references.
  expect(out).toContain("class A { __DEV__() {} __DEV__x = 1; }");
  expect(out).toContain("const o = {__DEV__: 1, x: o.__DEV__};");
});

test("a binding of a constant's name keeps the name as written where it is in scope", () => {
  const constants = new Map([["__DEV__", true]]);
  const out = translate(
    "function f(o: {__DEV__: boolean}) { const {__DEV__} = o; return __DEV__ ? 'dev' : 'prod'; }\nif (__DEV__) g();\nfunction p(__DEV__) { return __DEV__; }\ntry {} catch (__DEV__) { __DEV__; }\n{ let __DEV__ = 0; __DEV__; }\nfunction v() { if (x) { var __DEV__ = 2; } return __DEV__; }\nconst h = function __DEV__() { return __DEV__; };\nk(__DEV__);",
    { constants },
  );
  expect(out).toContain("return __DEV__ ? 'dev' : 'prod';");
  expect(out).toContain("{ g(); }");
  expect(out).toContain("function p(__DEV__?: unknown) { return __DEV__; }");
  expect(out).toContain("try {} catch (__DEV__) { __DEV__; }");
  expect(out).toContain("{ let __DEV__ = 0; __DEV__; }");
  expect(out).toContain("{ var __DEV__ = 2; } return __DEV__; }");
  expect(out).toContain("const h = function __DEV__() { return __DEV__; };");
  expect(out).toContain("k(true);");
  // `declare var` describes the global and declares nothing.
  expect(translate("declare var __DEV__: boolean;\nif (__DEV__) g();", { constants })).toContain(
    "{ g(); }",
  );
});

test("folding a constant condition keeps the code in place", () => {
  const constants = new Map([["__DEV__", false]]);
  const out = translate(
    "let r = foo()\n__DEV__ ? 1 : (3)\nif (a) if (__DEV__) x(); else y();\nif (__DEV__) { var hoisted = 1; } else z();",
    { constants },
  );
  // The kept part cannot run into the line before it.
  expect(out).toContain("let r = foo()\n;(3)");
  // A kept statement stands where one statement belongs.
  expect(out).toContain("if (a) { y(); }");
  // A dropped branch's `var` stays declared.
  expect(out).toContain("{ z(); var hoisted; }");
  // Loose equality between types is not folded.
  expect(translate("if (V == 1) w();", { constants: new Map([["V", "1"]]) })).toContain(
    'if ("1" == 1) w();',
  );
});

test("object types keep Flow's override order for spreads", () => {
  const out = translate(
    "type B = {a: number};\ntype C = {...B, a: string};\ntype D = {a: number, ...B};\ntype E = {[K]: number, x: string};\ntype F = {+[id: number]: string};\ntype M = {...?B, q: string};",
  );
  // In each member of a union, and without the null and undefined a maybe
  // type adds (spreading them adds nothing).
  expect(out).toContain(
    'type C = (NonNullable<B> extends infer Spread_ ? (Spread_ extends unknown ? Omit<Spread_, "a"> : never) : never) & { a: string; };',
  );
  expect(out).toContain(
    "type D = (NonNullable<B> extends infer Spread__ ? (Spread__ extends unknown ? ({ a: number; } extends infer Spread_ ? (Spread_ extends unknown ? Omit<Spread_, keyof Spread__> : never) : never) & Spread__ : never) : never);",
  );
  // The bound variable is no name of the module's own.
  expect(translate("type Spread_ = {};\ntype X = {a: number, ...Spread_};")).toContain(
    "extends infer Spread__ ?",
  );
  expect(translate("type WithA<S> = {a: number, ...S};")).toContain(
    "type WithA<S> = (NonNullable<S> extends infer Spread__ ? (Spread__ extends unknown ? ({ a: number; } extends infer Spread_ ? (Spread_ extends unknown ? Omit<Spread_, keyof Spread__> : never) : never) & Spread__ : never) : never);",
  );
  // A spread that is a union overrides each arm's own keys, not the keys
  // every arm shares: the arm that carries `a` takes the spread's type,
  // and the arm that does not keeps the earlier one.
  const union = translate(
    "type B = {a: string} | {b: boolean};\ntype U = {a: number, ...B};\ntype V = {...B, q: string};",
  );
  expect(union).toContain(
    "type U = (NonNullable<B> extends infer Spread__ ? (Spread__ extends unknown ? ({ a: number; } extends infer Spread_ ? (Spread_ extends unknown ? Omit<Spread_, keyof Spread__> : never) : never) & Spread__ : never) : never);",
  );
  // A member after such a spread overrides that member in each arm.
  expect(union).toContain(
    'type V = (NonNullable<B> extends infer Spread_ ? (Spread_ extends unknown ? Omit<Spread_, "q"> : never) : never) & { q: string; };',
  );
  expect(out).toContain(
    'type M = (NonNullable<B | null | undefined> extends infer Spread_ ? (Spread_ extends unknown ? Omit<Spread_, "q"> : never) : never) & { q: string; };',
  );
  expect(out).toContain("type E = { x: string; } & Partial<Record<K, number>>;");
  expect(out).toContain("type F = { readonly [id: number]: string; };");
});

test("library and indexed types keep their arguments and absent cases", () => {
  const out = translate(
    "type It = Iterator<number, string, boolean>;\ntype V = $ArrayBufferView;\ntype P = O?.['p'];\ntype J = interface extends I { y: string };",
  );
  expect(out).toContain("type It = Iterator<number, string, boolean>;");
  expect(out).toContain("type V = ArrayBufferView;");
  expect(out).toContain("type P = NonNullable<O>['p'] | undefined;");
  expect(out).toContain("type J = I & { y: string; };");
});

test("only a const array literal is a tuple, and a destructuring write keeps a binding open", () => {
  expect(translate("function f(a: number, b: number) { let p = [a, b]; g(p); }")).toContain(
    "let p = [a, b];",
  );
  const constructed = translate(
    "let cur = null;\nfunction a() { cur = new Map<string, number>(); }\nlet other = null;\nfunction b(x) { other = new Set(); [other] = x; }",
  );
  expect(constructed).toContain("let cur: Map<string, number> | null = null;");
  expect(constructed).toContain("let other = null;");
});

test("setters, declared exported types and interfaces translate to valid TypeScript", () => {
  const out = translate(
    "class S { set v(x) {} }\ndeclare export type Ex = {x: number};\ninterface I { m(): A & B }",
  );
  expect(out).toContain("class S { set v(x: unknown) {} }");
  expect(out).toContain("export type Ex = { x: number; };");
  expect(out).toContain("interface I { m(): A & B; }");
});

test("a TSX module writes a generic arrow function's type parameters with a comma", () => {
  expect(translate("const id = <T>(x: T): T => x;", { jsx: true })).toContain(
    "const id = <T,>(x: T): T => x;",
  );
  expect(translate("const id = <T>(x: T): T => x;")).toContain("const id = <T>(x: T): T => x;");
});

test("Flow forms without a translation are refused at their position", () => {
  const refused = (source: string): string => {
    try {
      translate(source);
      return "translated";
    } catch (error) {
      return (error as Error).message;
    }
  };
  expect(refused("type M = {[K in keyof O]: number};")).toBe(
    "Flow mapped types are not supported yet",
  );
  expect(refused("type C = $Call<F, number>;")).toBe(
    "Flow utility type '$Call' is not supported yet",
  );
  expect(refused("import {typeof C} from './c';")).toBe("`import typeof` is not supported yet");
  expect(refused("declare export default string;")).toBe(
    "this form of `declare export` is not supported yet",
  );
  expect(refused("module.exports = {a: 1};")).toBe("CommonJS Flow modules are not supported yet");
  expect(refused("exports.a = 1;")).toBe("CommonJS Flow modules are not supported yet");
  expect(refused("type S = {[[call]](): void};")).toBe(
    "Flow internal slot properties are not supported yet",
  );
  expect(refused("const x = f<_>(1);")).toBe("Flow's `_` type placeholder is not supported yet");
  expect(refused("type R = $Rest<A, B>;")).toBe("Flow utility type '$Rest' is not supported yet");
  expect(refused("component C() {}")).toBe("Flow component and hook syntax is not supported yet");
  expect(refused("hook useX() {}")).toBe("Flow component and hook syntax is not supported yet");
  for (const [source, form] of [
    ["declare class C {}", "declare class"],
    ["declare module M {}", "declare module"],
    ["declare module.exports: {a: number};", "declare module.exports"],
    ["declare export * from './x';", "declare export *"],
  ])
    expect(refused(source!)).toBe(`Flow \`${form}\` declarations are not supported yet`);
  // A declared exported value would be an export no code defines.
  for (const source of [
    "declare export function f(): void;",
    "declare export var v: number;",
    "declare export class C {}",
    "declare export {a};",
  ])
    expect(refused(source)).toBe("this form of `declare export` is not supported yet");
});

test("a rewrite that stands as a whole statement body stays the body", () => {
  const constants = new Map<string, boolean | number | string | null>([
    ["__DEV__", false],
    ["N", 1],
  ]);
  const out = translate("if (x) N.toFixed();\nwhile (x) __DEV__ ? a() : b();", { constants });
  expect(out).toContain("if (x) (1).toFixed();");
  expect(out).toContain("while (x) (b());");
  // A dropped branch's `var` stays inside the kept part, before an `else`.
  expect(
    translate("if (q) if (__DEV__) { var h = 1; } else b(); else c();", { constants }),
  ).toContain("if (q) { b(); var h; } else c();");
});

test("imported and exported names are bindings, and pattern defaults translate", () => {
  const constants = new Map([["__DEV__", false]]);
  const out = translate(
    "import { __DEV__ as dev } from './x';\nexport { y as __DEV__ };\nfunction f({ a = (x: ?string) => x }) {}",
    { constants },
  );
  expect(out).toContain("import { __DEV__ as dev } from './x';");
  expect(out).toContain("export { y as __DEV__ };");
  expect(out).toContain("function f({ a = (x: string | null | undefined) => x }) {}");
  // A constant is no reference a tuple element types.
  expect(
    translate("function t(y: number) { const tup = [__DEV__, y]; g(tup); }", { constants }),
  ).toContain("const tup = [false, y];");
});

test("only the module constant of a unique symbol type is the unique symbol", () => {
  const out = translate(
    "type Key = true;\nconst KEY: Key = (Symbol('k'): any);\nfunction n() { let k: Key = KEY; return k; }",
    { types: new Map([["Key", "unique symbol"]]) },
  );
  expect(out).toContain("const KEY: unique symbol =");
  expect(out).toContain("let k: Key = KEY;");
});

test("parameters, setters and library types keep TypeScript's rules", () => {
  const out = translate(
    "function g(a, b?) {}\nconst o = { set x(v) {} };\ntype G = Generator<number>;\ntype R = {[K]: number};\ndeclare export opaque type B: string;\ninterface I extends Node { x: number }",
    { types: new Map([["Node", "unknown"]]) },
  );
  expect(out).toContain("function g(a?: unknown, b?: unknown) {}");
  expect(out).toContain("const o = { set x(v: unknown) {} };");
  expect(out).toContain("type G = Generator<number, unknown, unknown>;");
  expect(out).toContain("type R = Partial<Record<K, number>>;");
  expect(out).toContain("export declare type B = string;");
  expect(out).toContain("interface I extends (unknown) { x: number; }");
});
