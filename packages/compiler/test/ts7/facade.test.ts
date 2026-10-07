import { Ts7Host } from "../../src/frontend/ts7/program-adapter.js";
/* The checker facade's mechanics: memoization and batch prefetch must be
 * REAL — measured as raw-client call counts through a counting proxy, not
 * inferred from timings — and the client-side fast paths must agree with
 * the raw checker's answers on the same objects. */

import { afterAll, expect, test, vi } from "vitest";
import { lowerToIr } from "../../src/frontend/lowering/lowerer.js";
import {
  clearWorkspacePackages,
  registerWorkspacePackage,
} from "../../src/frontend/workspace-registry.js";
import { CheckerFacade } from "../../src/frontend/ts7/checker.js";
import type { SemanticChecker as Checker } from "../../src/frontend/ts7/semantic-checker.js";
import type { Node } from "../../src/frontend/ts7/ast-types.js";
import type { Type } from "../../src/frontend/ts7/semantic-types.js";
import { ad, buildTwoWorlds } from "./harness.js";
import type { TwoWorlds } from "./harness.js";
import { RICH_TS } from "./fixtures.js";

const host = new Ts7Host();
const worlds: TwoWorlds[] = [];
afterAll(() => {
  for (const w of worlds) w.dispose();
  host.close();
});

function countingChecker(raw: Checker): {
  proxy: Checker;
  counts: Record<string, number>;
  calls: Record<string, unknown[][]>;
} {
  const counts: Record<string, number> = {};
  const calls: Record<string, unknown[][]> = {};
  const proxy = new Proxy(raw, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value === "function" && typeof prop === "string") {
        return (...args: unknown[]) => {
          counts[prop] = (counts[prop] ?? 0) + 1;
          (calls[prop] ??= []).push(args);
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return value;
    },
  });
  return { proxy, counts, calls };
}

function build(): { w: TwoWorlds; facade: CheckerFacade; counts: Record<string, number> } {
  const w = buildTwoWorlds(RICH_TS, host);
  worlds.push(w);
  const { proxy, counts } = countingChecker(w.p7.project.checker);
  return { w, facade: new CheckerFacade(proxy), counts };
}

function collectNodes(w: TwoWorlds): Node[] {
  const sf = w.p7.getSourceFile(w.files[0]!);
  expect(sf).toBeDefined();
  const nodes: Node[] = [];
  const visit = (n: Node): void => {
    nodes.push(n);
    n.forEachChild(visit);
  };
  visit(sf!);
  return nodes;
}

test("interface base queries preserve generic parameters and memoize raw answers", () => {
  const w = buildTwoWorlds(
    {
      "main.ts": `
    interface Values<T> extends ReadonlySet<T> {}
    interface Nested<T> extends Values<T> {}
    const numbers: Nested<number> = new Set<number>();
    const strings: Nested<string> = new Set<string>();
  `,
    },
    host,
  );
  worlds.push(w);
  const { proxy, counts } = countingChecker(w.p7.project.checker);
  const facade = new CheckerFacade(proxy);
  const targets = new Set<ad.InterfaceType>();
  for (const node of collectNodes(w)) {
    if (!ad.isVariableDeclaration(node)) continue;
    const type = facade.getTypeAtLocation(node.name);
    expect(type.isTypeReference()).toBe(true);
    if (!type.isTypeReference()) continue;
    const target = type.getTarget();
    expect(target.isClassOrInterface()).toBe(true);
    if (!target.isClassOrInterface()) continue;
    targets.add(target);
    const bases = facade.getBaseTypes(target);
    expect(bases.map((base) => facade.typeToString(base))).toEqual(["Values<T>"]);
    expect(bases).toEqual(w.p7.project.checker.getBaseTypes(target));
    expect(facade.getBaseTypes(target)).toBe(bases);
  }
  expect(targets.size).toBe(1);
  expect(counts["getBaseTypes"]).toBe(1);
});

test("semantic never detection drops impossible distributed intersections and caches the answer", () => {
  const w = buildTwoWorlds(
    {
      "main.ts": `
    type Node = { kind: "leaf"; text: string } | { kind: "branch"; children: Node[] };
    type Branch = Node & { kind: "branch" };
    type Impossible = { kind: "left" } & { kind: "right" };
    type Empty = {};
    type NeverField = { value: never };
    type PlainNever = never;
  `,
    },
    host,
  );
  worlds.push(w);
  const { proxy, counts } = countingChecker(w.p7.project.checker);
  const facade = new CheckerFacade(proxy);
  const aliases = new Map<string, ad.Type>();
  for (const node of collectNodes(w)) {
    if (ad.isTypeAliasDeclaration(node))
      aliases.set(node.name.text, facade.getTypeFromTypeNode(node.type));
  }
  const branch = aliases.get("Branch")!;
  const arms = ad.constituentTypes(branch);
  expect(arms.length).toBe(2);
  expect(arms.filter((arm) => facade.isNeverType(arm))).toHaveLength(1);
  expect(facade.isNeverType(branch)).toBe(false);
  expect(facade.isNeverType(aliases.get("Impossible")!)).toBe(true);
  expect(facade.isNeverType(aliases.get("PlainNever")!)).toBe(true);
  expect(facade.isNeverType(aliases.get("Empty")!)).toBe(false);
  expect(facade.isNeverType(aliases.get("NeverField")!)).toBe(false);
  const queried = counts["isTypeAssignableTo"];
  expect(queried).toBeGreaterThan(0);
  expect(counts["getNeverType"]).toBe(1);
  for (const type of [...aliases.values(), ...arms]) facade.isNeverType(type);
  const warm = counts["isTypeAssignableTo"];
  for (const type of [...aliases.values(), ...arms]) facade.isNeverType(type);
  expect(counts["isTypeAssignableTo"]).toBe(warm);
});

test("semantic assignability distinguishes recursive variants and memoizes both directions", () => {
  const w = buildTwoWorlds(
    {
      "main.ts": `
    type Tree = { kind: "leaf"; text: string } | { kind: "branch"; children: Tree[] };
    type Branch = Tree & { kind: "branch" };
    type Fresh = { kind: "branch"; children: never[] };
    type Wrong = { kind: "branch"; children: number[] };
  `,
    },
    host,
  );
  worlds.push(w);
  const { proxy, counts } = countingChecker(w.p7.project.checker);
  const facade = new CheckerFacade(proxy);
  const aliases = new Map<string, ad.Type>();
  for (const node of collectNodes(w)) {
    if (ad.isTypeAliasDeclaration(node))
      aliases.set(node.name.text, facade.getTypeFromTypeNode(node.type));
  }
  const pairs = [
    ["Fresh", "Branch", true],
    ["Fresh", "Tree", true],
    ["Branch", "Fresh", false],
    ["Wrong", "Tree", false],
    ["Branch", "Tree", true],
    ["Tree", "Branch", false],
  ] as const;
  for (const [from, to, expected] of pairs) {
    const source = aliases.get(from)!;
    const target = aliases.get(to)!;
    expect(facade.isTypeAssignableTo(source, target), `${from} to ${to}`).toBe(expected);
    expect(facade.isTypeAssignableTo(source, target)).toBe(
      w.p7.project.checker.isTypeAssignableTo(source, target),
    );
  }
  expect(counts["isTypeAssignableTo"]).toBe(pairs.length);
  for (const [from, to] of pairs) facade.isTypeAssignableTo(aliases.get(from)!, aliases.get(to)!);
  for (const type of aliases.values()) expect(facade.isTypeAssignableTo(type, type)).toBe(true);
  expect(counts["isTypeAssignableTo"]).toBe(pairs.length);
});

test("hot expression and identifier queries batch; uncommon kinds fall back once", () => {
  const { facade, counts, w } = build();
  const nodes = collectNodes(w);
  expect(nodes.length).toBeGreaterThan(300);

  for (const n of nodes) facade.getTypeAtLocation(n);
  // The first miss bulk-fetches only lowering's hot expression kinds. The
  // uncommon declaration/token kinds then use the direct memoized fallback.
  expect(counts["getTypeAtLocation"] ?? 0).toBeLessThan(nodes.length);

  for (const n of nodes) facade.getSymbolAtLocation(n);
  expect(counts["getSymbolAtLocation"] ?? 0).toBeLessThan(nodes.length);
  // Symbol prefetch batch-fetches the symbols' types too...
  const typeOfSymbolBatches = counts["getTypeOfSymbol"] ?? 0;
  expect(typeOfSymbolBatches).toBe(1);

  // ...so hot identifier symbols are free. Symbols surfaced only by uncommon
  // direct-fallback nodes pay one memoized query each.
  for (const n of nodes) {
    const s = facade.getSymbolAtLocation(n);
    if (s) facade.getTypeOfSymbol(s);
  }
  expect(counts["getTypeOfSymbol"] ?? 0).toBeLessThan(nodes.length);

  // Warm repeats of everything: zero further raw traffic.
  const before = { ...counts };
  for (const n of nodes) {
    facade.getTypeAtLocation(n);
    facade.getSymbolAtLocation(n);
  }
  expect(counts).toEqual(before);
});

test("memoized answers are identical objects across calls", () => {
  const { facade, w } = build();
  const nodes = collectNodes(w).filter((n) => ad.isIdentifier(n));
  for (const n of nodes.slice(0, 50)) {
    expect(facade.getTypeAtLocation(n)).toBe(facade.getTypeAtLocation(n));
    expect(facade.getSymbolAtLocation(n)).toBe(facade.getSymbolAtLocation(n));
  }
});

test("getBaseTypeOfLiteralType answers literals client-side and agrees with the raw checker", () => {
  const { facade, counts, w } = build();
  const raw = w.p7.project.checker;
  const nodes = collectNodes(w);
  const types = new Set<Type>();
  for (const n of nodes) {
    const t = facade.getTypeAtLocation(n);
    if (t) types.add(t);
  }
  expect(types.size).toBeGreaterThan(30);
  let literals = 0;
  for (const t of types) {
    const viaFacade = facade.getBaseTypeOfLiteralType(t);
    const viaRaw = raw.getBaseTypeOfLiteralType(t) ?? t;
    expect(viaFacade, `type '${raw.typeToString(t)}'`).toBe(viaRaw);
    if (viaFacade !== t) literals++;
  }
  expect(literals).toBeGreaterThan(0);
  // The literal kinds never touched the raw method: only enum-ish/union
  // types round-trip, plus one call per intrinsic singleton.
  const rawCalls = counts["getBaseTypeOfLiteralType"] ?? 0;
  const intrinsicFetches =
    (counts["getStringType"] ?? 0) +
    (counts["getNumberType"] ?? 0) +
    (counts["getBigIntType"] ?? 0) +
    (counts["getBooleanType"] ?? 0);
  expect(intrinsicFetches).toBeLessThanOrEqual(4);
  expect(rawCalls).toBeLessThan(types.size / 2);
});

test("isTupleType agrees with the raw checker; only object types round-trip, once each", () => {
  const { facade, counts, w } = build();
  const raw = w.p7.project.checker;
  const nodes = collectNodes(w);
  const types = new Set<Type>();
  for (const n of nodes) {
    const t = facade.getTypeAtLocation(n);
    if (t) types.add(t);
  }
  let tuples = 0;
  let objectTypes = 0;
  for (const t of types) {
    if (t.flags & ad.TypeFlags.Object) objectTypes++;
    const viaFacade = facade.isTupleType(t);
    expect(viaFacade, raw.typeToString(t)).toBe(raw.isTupleType(t));
    if (viaFacade) tuples++;
  }
  expect(tuples).toBeGreaterThan(0); // Pair<T> instantiations / as const tuples
  // Non-object types never hit the wire; each object type at most once
  // (shape-true tuples answer locally too).
  expect(counts["isTupleType"] ?? 0).toBeLessThanOrEqual(objectTypes);
  // Warm repeat: fully memoized.
  const before = counts["isTupleType"] ?? 0;
  for (const t of types) facade.isTupleType(t);
  expect(counts["isTupleType"] ?? 0).toBe(before);
});

test("isArrayType agrees with the raw checker and skips visibly non-object types", () => {
  const { facade, counts, w } = build();
  const raw = w.p7.project.checker;
  const types = new Set<Type>();
  for (const node of collectNodes(w)) types.add(facade.getTypeAtLocation(node));
  expect(types.size).toBeGreaterThan(30);

  let objectTypes = 0;
  let arrays = 0;
  for (const type of types) {
    if (type.flags & ad.TypeFlags.Object) objectTypes++;
    const viaFacade = facade.isArrayType(type);
    expect(viaFacade, raw.typeToString(type)).toBe(raw.isArrayType(type));
    if (viaFacade) arrays++;
  }
  expect(arrays).toBeGreaterThan(0);
  expect(counts["isArrayType"] ?? 0).toBeLessThanOrEqual(objectTypes);

  const before = counts["isArrayType"] ?? 0;
  for (const type of types) facade.isArrayType(type);
  expect(counts["isArrayType"] ?? 0).toBe(before);
});

test("union and intersection constituents are fetched once per immutable type", () => {
  const { w } = build();
  const raw = w.p7.project.checker;
  const compound = new Set<Type>();
  for (const node of collectNodes(w)) {
    const type = raw.getTypeAtLocation(node);
    if (type === undefined || !(type.isUnionType() || type.isIntersectionType())) continue;
    compound.add(type);
  }
  expect(compound.size).toBeGreaterThan(0);
  const fetch = vi.spyOn(raw.project, "fetchTypes");
  try {
    for (const type of compound) {
      const first = ad.constituentTypes(type);
      expect(ad.constituentTypes(type)).toBe(first);
      expect(type.getTypes()).toBe(first);
      expect(
        fetch.mock.calls.filter(([id, method]) => id === type.id && method === "getTypesOfType"),
      ).toHaveLength(1);
    }
  } finally {
    fetch.mockRestore();
  }
});

test("explicit prefetchSourceFile primes hot kinds and direct fallbacks memoize", () => {
  const { facade, counts, w } = build();
  const sf = w.p7.getSourceFile(w.files[0]!)!;
  facade.prefetchSourceFile(sf);
  const nodes = collectNodes(w);
  for (const n of nodes) {
    facade.getTypeAtLocation(n);
    const s = facade.getSymbolAtLocation(n);
    if (s) facade.getTypeOfSymbol(s);
  }
  expect(counts["getTypeAtLocation"] ?? 0).toBeLessThan(nodes.length);
  expect(counts["getSymbolAtLocation"] ?? 0).toBeLessThan(nodes.length);
  const afterWalk = { ...counts };
  for (const n of nodes) {
    facade.getTypeAtLocation(n);
    facade.getSymbolAtLocation(n);
  }
  expect(counts).toEqual(afterWalk);
});

test("managed structure and body waves batch across roots without touching deferred code", () => {
  const w = buildTwoWorlds(
    {
      "waves.ts": `
export function reached(input: number = Math.random()): number {
  const reachedLocal = { value: input };
  return reachedLocal.value;
}
export function dead(input: string): string {
  const deadLocal = [input];
  return deadLocal[0]!;
}
export class Holder {
  value = Math.random();
}
export function withClass(): number {
  class Nested {
    method(): number { return Math.random(); }
  }
  return new Nested().method();
}
const top = reached(1);
void top;
`,
    },
    host,
  );
  worlds.push(w);
  const { proxy, counts, calls } = countingChecker(w.p7.project.checker);
  const facade = new CheckerFacade(proxy);
  const sf = w.p7.getSourceFile(w.files[0]!)!;
  const functions = sf.statements.filter(ad.isFunctionDeclaration);
  const cls = sf.statements.find(ad.isClassDeclaration)!;
  const withClass = functions[2]!;
  const nested = withClass.body!.statements.find(ad.isClassDeclaration)!;
  const reachedBody = functions[0]!.body!;
  const deadBody = functions[1]!.body!;
  const nestedMethodBody = nested.members.find(ad.isMethodDeclaration)!.body!;
  const defaultValue = functions[0]!.parameters[0]!.initializer!;
  const fieldValue = cls.members.find(ad.isPropertyDeclaration)!.initializer!;
  const inside = (node: Node, root: Node): boolean =>
    node.getStart() >= root.getStart() && node.end <= root.end;

  facade.prefetchSourceFileStructures([sf]);
  const headerTypeNodes = calls["getTypeAtLocation"]?.[0]?.[0] as Node[];
  const headerSymbolNodes = calls["getSymbolAtLocation"]?.[0]?.[0] as Node[];
  expect(headerTypeNodes.length).toBeGreaterThan(0);
  expect(headerSymbolNodes.length).toBeGreaterThan(0);
  const deferred = [reachedBody, deadBody, defaultValue, fieldValue];
  expect(headerTypeNodes.every((node) => deferred.every((root) => !inside(node, root)))).toBe(true);
  expect(headerSymbolNodes.every((node) => deferred.every((root) => !inside(node, root)))).toBe(
    true,
  );

  const beforeBodies = { ...counts };
  facade.prefetchRoots([reachedBody, deadBody, defaultValue, fieldValue]);
  expect(counts["getTypeAtLocation"]).toBe((beforeBodies["getTypeAtLocation"] ?? 0) + 1);
  expect(counts["getSymbolAtLocation"]).toBe((beforeBodies["getSymbolAtLocation"] ?? 0) + 1);
  const bodyTypeNodes = calls["getTypeAtLocation"]!.at(-1)![0] as Node[];
  expect(bodyTypeNodes.some((node) => inside(node, reachedBody))).toBe(true);
  expect(bodyTypeNodes.some((node) => inside(node, deadBody))).toBe(true);
  expect(bodyTypeNodes.some((node) => inside(node, defaultValue))).toBe(true);
  expect(bodyTypeNodes.some((node) => inside(node, fieldValue))).toBe(true);

  const beforeOuterBody = { ...counts };
  facade.prefetchRoots([withClass.body!]);
  expect(counts["getTypeAtLocation"]).toBe((beforeOuterBody["getTypeAtLocation"] ?? 0) + 1);
  const outerTypeNodes = calls["getTypeAtLocation"]!.at(-1)![0] as Node[];
  expect(outerTypeNodes.some((node) => inside(node, withClass.body!))).toBe(true);
  expect(outerTypeNodes.every((node) => !inside(node, nestedMethodBody))).toBe(true);

  const warm = { ...counts };
  facade.prefetchRoots([reachedBody, deadBody, defaultValue, fieldValue]);
  expect(counts).toEqual(warm);
});

test("managed waves leave erased type syntax on demand and retain runtime heritage", () => {
  const w = buildTwoWorlds(
    {
      "type-metadata.ts": `
interface Shape { value: number; }
type Alias = Shape;
class Base {}
class Child extends Base {}
function identity<T extends Shape>(value: T): T { return value; }
const item: Alias = identity({ value: 1 });
`,
    },
    host,
  );
  worlds.push(w);
  const raw = w.p7.project.checker;
  const { proxy, counts, calls } = countingChecker(raw);
  const facade = new CheckerFacade(proxy);
  const sf = w.p7.getSourceFile(w.files[0]!)!;
  const fn = sf.statements.find(ad.isFunctionDeclaration)!;
  const references: Node[] = [];
  ad.walkPreorder(sf, (node) => {
    if (ad.isTypeReferenceNode(node)) references.push(node.typeName);
  });
  expect(references.length).toBeGreaterThan(0);
  facade.prefetchSourceFileStructures([sf]);
  facade.prefetchSymbolRoots([sf], true);
  facade.prefetchRoots([fn.body!]);
  const queried = (method: string): Node[] =>
    calls[method]!.flatMap(([nodes]) => (Array.isArray(nodes) ? nodes : [nodes])) as Node[];
  expect(queried("getTypeAtLocation").some((node) => references.includes(node))).toBe(false);
  expect(queried("getSymbolAtLocation").some((node) => references.includes(node))).toBe(false);
  const child = sf.statements.filter(ad.isClassDeclaration)[1]!;
  const base = child.heritageClauses![0]!.types[0]!.expression;
  expect(queried("getTypeAtLocation")).toContain(base);

  const reference = references[0]!;
  const before = { ...counts };
  expect(facade.getTypeAtLocation(reference)).toBe(raw.getTypeAtLocation(reference));
  expect(facade.getSymbolAtLocation(reference)).toBe(raw.getSymbolAtLocation(reference));
  expect(counts["getTypeAtLocation"]).toBe(before["getTypeAtLocation"]! + 1);
  expect(counts["getSymbolAtLocation"]).toBe(before["getSymbolAtLocation"]! + 1);
  const warm = { ...counts };
  facade.getTypeAtLocation(reference);
  facade.getSymbolAtLocation(reference);
  expect(counts).toEqual(warm);
});

test("declaration misses stay direct while explicit whole-file prefetch remains available", () => {
  const w = buildTwoWorlds(
    { "api.d.ts": "export interface Box { value: number; label: string; }" },
    host,
  );
  worlds.push(w);
  const raw = w.p7.project.checker;
  const { proxy, counts, calls } = countingChecker(raw);
  const facade = new CheckerFacade(proxy);
  const sf = w.p7.getSourceFile(w.files[0]!)!;
  expect(sf.isDeclarationFile).toBe(true);
  const declaration = sf.statements.find(ad.isInterfaceDeclaration)!;
  const name = declaration.members.find(ad.isPropertySignature)!.name;
  expect(facade.getSymbolAtLocation(name)).toBe(raw.getSymbolAtLocation(name));
  expect(facade.getTypeAtLocation(name)).toBe(raw.getTypeAtLocation(name));
  expect(calls["getSymbolAtLocation"]).toEqual([[name]]);
  expect(calls["getTypeAtLocation"]).toEqual([[name]]);
  const warm = { ...counts };
  facade.getSymbolAtLocation(name);
  facade.getTypeAtLocation(name);
  expect(counts).toEqual(warm);
  facade.prefetchSourceFile(sf);
  expect(calls["getSymbolAtLocation"]!.some(([nodes]) => Array.isArray(nodes))).toBe(true);
  expect(calls["getTypeAtLocation"]!.some(([nodes]) => Array.isArray(nodes))).toBe(true);
});

test("managed misses stay direct instead of falling back to whole-file prefetch", () => {
  const w = buildTwoWorlds(
    {
      "managed.ts": `
export function dead(input: number): number {
  const first = input + 1;
  const second = first + 1;
  return second;
}
`,
    },
    host,
  );
  worlds.push(w);
  const { proxy, counts, calls } = countingChecker(w.p7.project.checker);
  const facade = new CheckerFacade(proxy);
  const sf = w.p7.getSourceFile(w.files[0]!)!;
  const body = sf.statements.find(ad.isFunctionDeclaration)!.body!;
  const identifiers: Node[] = [];
  ad.walkPreorder(body, (node) => {
    if (ad.isIdentifier(node)) identifiers.push(node);
  });

  facade.prefetchSourceFileStructures([sf]);
  const before = counts["getTypeAtLocation"] ?? 0;
  facade.getTypeAtLocation(identifiers[0]!);
  facade.getTypeAtLocation(identifiers[1]!);
  expect(counts["getTypeAtLocation"]).toBe(before + 2);
  expect(Array.isArray(calls["getTypeAtLocation"]!.at(-1)![0])).toBe(false);
});

test("reachable waves batch symbol types after symbol-only analysis", () => {
  const locals = Array.from(
    { length: 24 },
    (_, index) => `  const local${index} = input + ${index};`,
  ).join("\n");
  const w = buildTwoWorlds(
    {
      "symbol-type-handoff.ts": `
export function reached(input: number): number {
${locals}
  return local23;
}
`,
    },
    host,
  );
  worlds.push(w);
  const { proxy, counts, calls } = countingChecker(w.p7.project.checker);
  const facade = new CheckerFacade(proxy);
  const sf = w.p7.getSourceFile(w.files[0]!)!;
  const body = sf.statements.find(ad.isFunctionDeclaration)!.body!;
  const identifiers: Node[] = [];
  ad.walkPreorder(body, (node) => {
    if (ad.isIdentifier(node)) identifiers.push(node);
  });

  facade.prefetchSymbolRoots([body]);
  expect(counts["getSymbolAtLocation"]).toBe(1);
  expect(counts["getTypeOfSymbol"] ?? 0).toBe(0);

  facade.prefetchRoots([body]);
  expect(counts["getSymbolAtLocation"]).toBe(1);
  expect(counts["getTypeOfSymbol"]).toBe(1);
  expect(Array.isArray(calls["getTypeOfSymbol"]![0]![0])).toBe(true);

  const warm = { ...counts };
  for (const node of identifiers) {
    const symbol = facade.getSymbolAtLocation(node);
    if (symbol) facade.getTypeOfSymbol(symbol);
  }
  expect(counts).toEqual(warm);
});

test("JavaScript class-shape collection batches constructor field queries", () => {
  const fields = Array.from(
    { length: 24 },
    (_, index) => `    this.value${index} = { nested: input };`,
  ).join("\n");
  const w = buildTwoWorlds(
    {
      "dead-class.js": `
class Dead {
  constructor(input) {
${fields}
  }
  method() {
    return this.value0.nested;
  }
}
console.log("ok");
`,
    },
    host,
  );
  worlds.push(w);
  const { proxy, calls } = countingChecker(w.p7.project.checker);
  const facade = new CheckerFacade(proxy, { project: w.p7.project.checker.project });
  (w.p7 as unknown as { checkerFacade: CheckerFacade | null }).checkerFacade = facade;
  const sf = w.p7.getSourceFile(w.files[0]!)!;
  const cls = sf.statements.find(ad.isClassDeclaration)!;
  const ctor = cls.members.find(ad.isConstructorDeclaration)!;
  const insideCtor = (node: Node): boolean =>
    node.getStart() >= ctor.getStart() && node.end <= ctor.end;

  lowerToIr(w.p7, sf, [sf]);

  for (const name of ["getTypeAtLocation", "getSymbolAtLocation"]) {
    const checkerCalls = calls[name] ?? [];
    expect(
      checkerCalls.some(([arg]) => Array.isArray(arg) && (arg as Node[]).some(insideCtor)),
    ).toBe(true);
    expect(checkerCalls.some(([arg]) => !Array.isArray(arg) && insideCtor(arg as Node))).toBe(
      false,
    );
  }
});

test("signature collection batches exact types of deferred function defaults", () => {
  const defaults = Array.from(
    { length: 24 },
    (_, index) =>
      `function dead${index}(value = process.env.VALUE): string | undefined { return value; }`,
  ).join("\n");
  const w = buildTwoWorlds({ "defaults.ts": `${defaults}\nconsole.log("ok");\n` }, host);
  worlds.push(w);
  const { proxy, calls } = countingChecker(w.p7.project.checker);
  const facade = new CheckerFacade(proxy, { project: w.p7.project.checker.project });
  (w.p7 as unknown as { checkerFacade: CheckerFacade | null }).checkerFacade = facade;
  const sf = w.p7.getSourceFile(w.files[0]!)!;
  const initializers = sf.statements
    .filter(ad.isFunctionDeclaration)
    .map((decl) => decl.parameters[0]!.initializer!);

  lowerToIr(w.p7, sf, [sf]);

  const typeCalls = calls["getTypeAtLocation"] ?? [];
  expect(
    typeCalls.some(
      ([arg]) =>
        Array.isArray(arg) &&
        initializers.every((initializer) => (arg as Node[]).includes(initializer)),
    ),
  ).toBe(true);
  expect(
    typeCalls.some(([arg]) => !Array.isArray(arg) && initializers.includes(arg as never)),
  ).toBe(false);
});

test("class-shape collection batches deferred method default types", () => {
  const methods = Array.from(
    { length: 24 },
    (_, index) => `  dead${index}(value = process.env.VALUE): string | undefined { return value; }`,
  ).join("\n");
  const w = buildTwoWorlds(
    {
      "class-defaults.ts": `class Dead {\n${methods}\n}\nconsole.log("ok");\n`,
    },
    host,
  );
  worlds.push(w);
  const { proxy, calls } = countingChecker(w.p7.project.checker);
  const facade = new CheckerFacade(proxy, { project: w.p7.project.checker.project });
  (w.p7 as unknown as { checkerFacade: CheckerFacade | null }).checkerFacade = facade;
  const sf = w.p7.getSourceFile(w.files[0]!)!;
  const cls = sf.statements.find(ad.isClassDeclaration)!;
  const initializers = cls.members
    .filter(ad.isMethodDeclaration)
    .map((member) => member.parameters[0]!.initializer!);

  lowerToIr(w.p7, sf, [sf]);

  const typeCalls = calls["getTypeAtLocation"] ?? [];
  expect(
    typeCalls.some(
      ([arg]) =>
        Array.isArray(arg) &&
        initializers.every((initializer) => (arg as Node[]).includes(initializer)),
    ),
  ).toBe(true);
  expect(
    typeCalls.some(([arg]) => !Array.isArray(arg) && initializers.includes(arg as never)),
  ).toBe(false);
});

test("eager npm-static implicit instances batch their committed body", () => {
  const w = buildTwoWorlds(
    {
      "eager-implicit.js": `
function pick(value) {
  const row = { value };
  return row.value;
}
console.log(pick(42));
`,
    },
    host,
  );
  worlds.push(w);
  const { proxy, calls } = countingChecker(w.p7.project.checker);
  const facade = new CheckerFacade(proxy, { project: w.p7.project.checker.project });
  (w.p7 as unknown as { checkerFacade: CheckerFacade | null }).checkerFacade = facade;
  const sf = w.p7.getSourceFile(w.files[0]!)!;
  const fn = sf.statements.find(ad.isFunctionDeclaration)!;
  const insideBody = (node: Node): boolean =>
    node.getStart() >= fn.body!.getStart() && node.end <= fn.body!.end;

  // Mark this fixture as an opted-in package file: that is the only gate
  // separating ordinary JS from npm-static implicit-any monomorphization.
  registerWorkspacePackage("eager-implicit", w.dir);
  try {
    lowerToIr(w.p7, sf, [sf]);
  } finally {
    clearWorkspacePackages();
  }

  const typeCalls = calls["getTypeAtLocation"] ?? [];
  expect(typeCalls.some(([arg]) => Array.isArray(arg) && (arg as Node[]).some(insideBody))).toBe(
    true,
  );
  expect(typeCalls.some(([arg]) => !Array.isArray(arg) && insideBody(arg as Node))).toBe(false);
});

test("coverage remainder batches checker queries for unreachable bodies", () => {
  const w = buildTwoWorlds(
    {
      "coverage-remainder.ts": `
function reached(input: number): number {
  return input + 1;
}
function dead(input: number): number {
  const record = { value: input };
  const values = [record.value];
  return values[0]!;
}
console.log(reached(1));
`,
    },
    host,
  );
  worlds.push(w);
  const { proxy, calls } = countingChecker(w.p7.project.checker);
  const facade = new CheckerFacade(proxy, { project: w.p7.project.checker.project });
  // Ts7Program owns one shared facade; install the counting instance so
  // lowering and this assertion observe the same memo/batch traffic.
  (w.p7 as unknown as { checkerFacade: CheckerFacade | null }).checkerFacade = facade;
  const sf = w.p7.getSourceFile(w.files[0]!)!;
  const deadBody = sf.statements
    .filter(ad.isFunctionDeclaration)
    .find((decl) => decl.name?.text === "dead")!.body!;
  const insideDeadBody = (node: Node): boolean =>
    node.getStart() >= deadBody.getStart() && node.end <= deadBody.end;

  lowerToIr(w.p7, sf, [sf], { coverage: true });

  const hotTypeKinds = new Set([
    ad.SyntaxKind.Identifier,
    ad.SyntaxKind.PropertyAccessExpression,
    ad.SyntaxKind.ObjectLiteralExpression,
    ad.SyntaxKind.ArrayLiteralExpression,
    ad.SyntaxKind.ConditionalExpression,
  ]);
  const typeBodyCalls = calls["getTypeAtLocation"] ?? [];
  expect(
    typeBodyCalls.some(([arg]) => Array.isArray(arg) && (arg as Node[]).some(insideDeadBody)),
  ).toBe(true);
  expect(
    typeBodyCalls.some(
      ([arg]) =>
        !Array.isArray(arg) && insideDeadBody(arg as Node) && hotTypeKinds.has((arg as Node).kind),
    ),
  ).toBe(false);

  const symbolBodyCalls = calls["getSymbolAtLocation"] ?? [];
  expect(
    symbolBodyCalls.some(([arg]) => Array.isArray(arg) && (arg as Node[]).some(insideDeadBody)),
  ).toBe(true);
  expect(
    symbolBodyCalls.some(
      ([arg]) => !Array.isArray(arg) && insideDeadBody(arg as Node) && ad.isIdentifier(arg as Node),
    ),
  ).toBe(false);
});

test("root prefetch panic-fences bad nodes and keeps healthy answers warm", () => {
  const w = buildTwoWorlds(
    {
      "panic.ts": `
export function f(input: number): number {
  const healthy = input + 1;
  const poison = healthy + 1;
  return poison;
}
`,
    },
    host,
  );
  worlds.push(w);
  const sf = w.p7.getSourceFile(w.files[0]!)!;
  const body = sf.statements.find(ad.isFunctionDeclaration)!.body!;
  const identifiers: Node[] = [];
  ad.walkPreorder(body, (node) => {
    if (ad.isIdentifier(node)) identifiers.push(node);
  });
  const poison = identifiers.find((node) => node.getText(sf) === "poison")!;
  const healthy = identifiers.find((node) => node.getText(sf) === "healthy")!;
  const raw = w.p7.project.checker;
  let panics = 0;
  const panicky = new Proxy(raw, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === "getTypeAtLocation") {
        return (nodes: Node | Node[]) => {
          if (Array.isArray(nodes) && nodes.includes(poison)) {
            panics++;
            throw new Error("synthetic checker panic");
          }
          return (value as (nodes: Node | Node[]) => unknown).call(target, nodes);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Checker;
  const facade = new CheckerFacade(panicky);

  facade.prefetchRoots([body]);
  expect(panics).toBeGreaterThan(1);
  expect(facade.getTypeAtLocation(healthy)).toBe(raw.getTypeAtLocation(healthy));
  expect(facade.getTypeAtLocation(poison)).toBe(raw.getAnyType());
  const warmPanics = panics;
  facade.prefetchRoots([body]);
  facade.getTypeAtLocation(poison);
  expect(panics).toBe(warmPanics);
});

test("autoPrefetch: false degrades to per-call queries (the escape hatch works)", () => {
  const w = buildTwoWorlds(RICH_TS, host);
  worlds.push(w);
  const { proxy, counts } = countingChecker(w.p7.project.checker);
  const facade = new CheckerFacade(proxy, { autoPrefetch: false });
  const nodes = collectNodes(w).slice(0, 20);
  for (const n of nodes) facade.getTypeAtLocation(n);
  expect(counts["getTypeAtLocation"]).toBe(20);
  // memoization still holds
  for (const n of nodes) facade.getTypeAtLocation(n);
  expect(counts["getTypeAtLocation"]).toBe(20);
});
