import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { canonEqual, canonKey, Normalizer, type Canon } from "../src/frontend/canon.js";
import { mapCanonical } from "../src/frontend/canon-map.js";
import {
  mapType,
  ShapeRegistry,
  UnionRegistry,
  type TypeMapperCtx,
} from "../src/frontend/type-mapper.js";
import { typeKey } from "../src/ir/ir.js";
import { loadProgram } from "../src/frontend/program-node.js";
import * as ts from "../src/frontend/ts7/adapter.js";

let directory: string;
let load: ReturnType<typeof loadProgram>;
let checker: ts.TypeChecker;
const aliases = new Map<string, ts.Type>();
const asTypes = new Map<string, { type: ts.Type; params: ts.Symbol[] }>();
const valueTypes = new Map<string, ts.Type>();
const typeParams = new Map<string, ts.Symbol>();

beforeAll(() => {
  directory = mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "scriptc-canon-"));
  const entry = join(directory, "input.ts");
  writeFileSync(
    entry,
    `
    // #2228: an intersection that restates an optional array member.
    export interface BuildOptions { cwd: string; contextFiles?: Array<{ path: string; content: string }> }
    export type Normalized = BuildOptions & { contextFiles: Array<{ path: string; content: string }> };
    export type Same = { x: number[] } & { x: number[] };
    // Unions flatten, drop never, read void as undefined, and dedupe.
    export type Flat = string | (number | undefined) | never | void | string;
    export type Flag = true | false | 0;
    // Branded primitive.
    export type Id = string & { readonly brand: "id" };
    // #2241/#2246: a recursive interface with a generic method.
    export interface TreeNode { name: string; child?: TreeNode; send<T>(message: T): string }
    // #2227: a generic alias spelled over a generic body's own parameters.
    export type Catalog<G, P> = { groups: G[]; provider: P };
    export function cast<G, P>(x: unknown) {
      return x as Catalog<G, P>;
    }
    // Narrowed type parameters.
    export function present<T>(x: T & {}) {
      return x;
    }
    export const sampleNumber = 1 as number;
    export const sampleText = "a" as string;
    export const sampleMaybe = undefined as string | undefined;
    export class Point { x = 0 }
    export type Points = readonly Point[];
    export type Pair = [string, number];
    // Two type parameters named T, in different functions.
    export function first<T>(x: unknown) {
      return x as T[];
    }
    export function second<T>(x: unknown) {
      return x as readonly T[];
    }
    // Distinct callables, and arrays of them.
    export type Calls = ((a: string) => void) & ((a: number) => void);
    export type CallArrays = ((a: string) => void)[] | ((a: number) => void)[];
    // A dictionary with a named property.
    export type Dict = { [key: string]: number } & { size: number };
    // Recursive array and tuple aliases.
    export type Nested = number | Nested[];
    export type Chain = [number, Chain] | null;
    // Optional and rest tuple elements.
    export type Loose = [string, number?, ...boolean[]];
    // Arrays of two instantiations of one generic class.
    export type Maps = Map<string, number>[] | Map<number, string>[];
    // The same instantiations, each refined by an object type.
    export type RefinedMaps =
      | (Map<string, number> & { tag: number })[]
      | (Map<number, string> & { tag: number })[];
  `,
  );
  load = loadProgram(entry);
  checker = load.program.getTypeChecker();
  ts.walkPreorder(load.entry, (node) => {
    if (ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node))
      aliases.set(
        node.name.text,
        checker.getTypeAtLocation(ts.isTypeAliasDeclaration(node) ? node.type : node.name),
      );
    if (ts.isAsExpression(node)) {
      let fn: ts.Node | undefined = node.parent;
      while (fn !== undefined && !ts.isFunctionDeclaration(fn)) fn = fn.parent;
      const params =
        fn !== undefined && ts.isFunctionDeclaration(fn)
          ? (fn.typeParameters?.nodes ?? []).map((p) => checker.getSymbolAtLocation(p.name)!)
          : [];
      asTypes.set(ts.getTextOfNode(node.type), {
        type: checker.getTypeAtLocation(node.type),
        params,
      });
    }
    if (ts.isTypeParameterDeclaration(node) && ts.isFunctionDeclaration(node.parent))
      typeParams.set(
        `${node.parent.name?.text}.${node.name.text}`,
        checker.getSymbolAtLocation(node.name)!,
      );
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name))
      valueTypes.set(node.name.text, checker.getTypeAtLocation(node.name));
    if (
      ts.isParameter(node) &&
      node.type !== undefined &&
      ts.isFunctionDeclaration(node.parent) &&
      node.parent.name?.text === "present"
    )
      asTypes.set("present", {
        type: checker.getTypeAtLocation(node.type),
        params: (node.parent.typeParameters?.nodes ?? []).map((p) =>
          checker.getSymbolAtLocation(p.name)!,
        ),
      });
  });
});
afterAll(() => {
  load?.dispose();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

const key = (c: Canon) => canonKey(c);

describe("canon", () => {
  test("intersections that restate members resolve to one object (#2228)", () => {
    const n = new Normalizer(checker);
    expect(key(n.canon(aliases.get("Same")!))).toBe("{ x: number[] }");
    expect(key(n.canon(aliases.get("Normalized")!))).toBe(
      "{ cwd: string; contextFiles: { path: string; content: string }[] }",
    );
  });

  test("unions are flat, never-free and deduplicated", () => {
    const n = new Normalizer(checker);
    expect(key(n.canon(aliases.get("Flat")!))).toBe("string | number | undefined");
    expect(key(n.canon(aliases.get("Flag")!))).toBe("boolean | 0");
  });

  test("a branded primitive is the primitive", () => {
    expect(key(new Normalizer(checker).canon(aliases.get("Id")!))).toBe("string");
  });

  test("recursion closes on the node under construction (#2241, #2246)", () => {
    const n = new Normalizer(checker);
    const tree = n.canon(aliases.get("TreeNode")!);
    expect(tree.k).toBe("obj");
    if (tree.k !== "obj") return;
    const child = tree
      .props()
      .find((p) => p.name === "child")!
      .type();
    expect(child.k).toBe("union");
    if (child.k !== "union") return;
    expect(child.arms).toContain(tree);
    const send = tree
      .props()
      .find((p) => p.name === "send")!
      .type();
    expect(send.k === "obj" && send.call()[0]!.generic).toBe(true);
  });

  test("a generic alias in a generic body substitutes the environment (#2227)", () => {
    const n = new Normalizer(checker);
    const { type, params } = asTypes.get("Catalog<G, P>")!;
    expect(key(n.canon(type))).toBe("{ groups: param G[]; provider: param P }");
    const bound = n.canon(
      type,
      new Map([
        [params[0]!, valueTypes.get("sampleNumber")!],
        [params[1]!, valueTypes.get("sampleText")!],
      ]),
    );
    expect(key(bound)).toBe("{ groups: number[]; provider: string }");
    expect(bound.k === "obj" && bound.alias?.name).toBe("Catalog");
    expect(bound.k === "obj" && bound.alias?.tsType).toBe(type);
  });

  test("a narrowed parameter drops its unit arms", () => {
    const n = new Normalizer(checker);
    const { type, params } = asTypes.get("present")!;
    expect(key(n.canon(type, new Map([[params[0]!, valueTypes.get("sampleMaybe")!]])))).toBe(
      "string",
    );
  });

  test("type parameters with the same name are distinct in the intern key", () => {
    const n = new Normalizer(checker);
    const { type } = asTypes.get("T[]")!;
    const firstT = typeParams.get("first.T")!;
    const secondT = typeParams.get("second.T")!;
    const num = valueTypes.get("sampleNumber")!;
    const text = valueTypes.get("sampleText")!;
    expect(
      key(
        n.canon(
          type,
          new Map([
            [firstT, num],
            [secondT, text],
          ]),
        ),
      ),
    ).toBe("number[]");
    expect(
      key(
        n.canon(
          type,
          new Map([
            [firstT, text],
            [secondT, num],
          ]),
        ),
      ),
    ).toBe("string[]");
  });

  test("callables and arrays of callables with different parameters stay distinct", () => {
    const n = new Normalizer(checker);
    const calls = n.canon(aliases.get("Calls")!);
    expect(calls.k === "obj" && calls.call().length).toBe(2);
    const arms = n.canon(aliases.get("CallArrays")!);
    expect(arms.k === "union" && arms.arms.length).toBe(2);
    expect(key(arms)).toBe("{ (string) => void }[] | { (number) => void }[]");
  });

  test("intersecting a dictionary with a named property keeps the index signature", () => {
    const dict = new Normalizer(checker).canon(aliases.get("Dict")!);
    expect(key(dict)).toBe("{ [string]: number; size: number }");
  });

  test("recursive array and tuple aliases close on themselves", () => {
    const n = new Normalizer(checker);
    const nested = n.canon(aliases.get("Nested")!);
    expect(nested.k).toBe("union");
    if (nested.k !== "union") return;
    // The array closes on itself through the union of its element.
    const array = nested.arms.find((a) => a.k === "array");
    const elem = array?.k === "array" ? array.elem : undefined;
    expect(elem?.k === "union" && elem.arms.includes(array!)).toBe(true);
    const chain = n.canon(aliases.get("Chain")!);
    expect(chain.k).toBe("union");
    if (chain.k !== "union") return;
    const tuple = chain.arms.find((a) => a.k === "tuple");
    const rest = tuple?.k === "tuple" ? tuple.elems[1]!.type : undefined;
    expect(rest?.k === "union" && rest.arms.includes(tuple!)).toBe(true);
  });

  test("a failed comparison withdraws the pairs it assumed equal", () => {
    const array = (p: "number" | "string"): Canon => ({
      k: "array",
      elem: { k: "prim", p },
      readonly: false,
    });
    // number[] fails against string[] before it matches number[]; that
    // attempt must not make string[] match later.
    const a: Canon = { k: "union", arms: [array("number"), array("number")] };
    const b: Canon = { k: "union", arms: [array("string"), array("number")] };
    expect(canonEqual(a, b)).toBe(false);
    expect(canonEqual(b, a)).toBe(false);
  });

  test("instantiations of one generic class stay distinct", () => {
    const maps = new Normalizer(checker).canon(aliases.get("Maps")!);
    expect(maps.k === "union" && maps.arms.length).toBe(2);
    expect(key(maps)).toBe("Map<string, number>[] | Map<number, string>[]");
  });

  test("a refined instantiation keeps its type arguments", () => {
    const maps = new Normalizer(checker).canon(aliases.get("RefinedMaps")!);
    expect(maps.k === "union" && maps.arms.length).toBe(2);
    expect(key(maps)).toBe("Map<string, number>[] | Map<number, string>[]");
  });

  test("optional and rest tuple elements keep their flags", () => {
    expect(key(new Normalizer(checker).canon(aliases.get("Loose")!))).toBe(
      "[string, number | undefined?, ...boolean]",
    );
  });

  test("classes are nominal; arrays and tuples keep their elements", () => {
    const n = new Normalizer(checker);
    expect(key(n.canon(aliases.get("Points")!))).toBe("readonly Point[]");
    expect(key(n.canon(aliases.get("Pair")!))).toBe("[string, number]");
  });
});

describe("mapCanonical", () => {
  const ctx = (): TypeMapperCtx => ({
    checker,
    shapes: new ShapeRegistry(),
    unions: new UnionRegistry(),
    classNamer: (decl) => decl.name?.text ?? "anonymous",
    isStdlibFile: (sf) => load.program.isSourceFileDefaultLibrary(sf),
    isNpmFile: () => false,
    isExternalTypeFile: () => false,
    isProgramFile: (sf) => load.moduleOrder.includes(sf),
  });
  test.for(["Normalized", "Same", "Flat", "Id", "Pair"])("%s maps like mapType", (name) => {
    const strict = mapType(aliases.get(name)!, ctx());
    const canonical = mapCanonical(new Normalizer(checker).canon(aliases.get(name)!), ctx());
    expect(strict).not.toBeNull();
    expect(canonical && typeKey(canonical)).toBe(typeKey(strict!));
  });
  test("shadow mode observes every successful top-level mapping", () => {
    const seen: string[] = [];
    const point = { kind: "object", className: "Point" } as const;
    const observed: TypeMapperCtx = {
      ...ctx(),
      typeMemo: new Map(),
      localClassValue: (type) => (type === aliases.get("Points") ? point : null),
      canonShadow: (type, mapped) => seen.push(`${checker.typeToString(type)} ${typeKey(mapped)}`),
    };
    // An intrinsic primitive, a mapping and its memo hit, and a local class
    // value: one observation each; the nested mappings of `Same` are not
    // observed.
    const number = mapType(valueTypes.get("sampleNumber")!, observed);
    const same = mapType(aliases.get("Same")!, observed);
    expect(mapType(aliases.get("Same")!, observed)).toBe(same);
    expect(mapType(aliases.get("Points")!, observed)).toBe(point);
    expect(seen).toEqual([
      `number ${typeKey(number!)}`,
      `Same ${typeKey(same!)}`,
      `Same ${typeKey(same!)}`,
      `Points ${typeKey(point)}`,
    ]);
  });
  test("a generic alias maps under bindings, where mapType needs the instance table", () => {
    const { type, params } = asTypes.get("Catalog<G, P>")!;
    const env = new Map([
      [params[0]!, valueTypes.get("sampleNumber")!],
      [params[1]!, valueTypes.get("sampleText")!],
    ]);
    const canonical = mapCanonical(new Normalizer(checker).canon(type, env), ctx());
    expect(canonical?.kind).toBe("record");
  });
});
