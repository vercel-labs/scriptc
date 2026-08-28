/* The checker facade's mechanics: memoization and batch prefetch must be
 * REAL — measured as raw-client call counts through a counting proxy, not
 * inferred from timings — and the client-side fast paths must agree with
 * the raw checker's answers on the same objects. */

import { afterAll, expect, test } from "vitest";
import { lowerToIr } from "../../src/frontend/lowering/lowerer.js";
import { clearWorkspacePackages, registerWorkspacePackage } from "../../src/frontend/workspace-registry.js";
import { CheckerFacade } from "../../src/frontend/ts7/checker.js";
import type { Node } from "typescript/unstable/ast";
import type { Checker, Type } from "typescript/unstable/sync";
import { ad, buildTwoWorlds } from "./harness.js";
import type { TwoWorlds } from "./harness.js";
import { RICH_TS } from "./fixtures.js";

const host = new ad.Ts7Host();
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
    (counts["getStringType"] ?? 0) + (counts["getNumberType"] ?? 0) +
    (counts["getBigIntType"] ?? 0) + (counts["getBooleanType"] ?? 0);
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
  const calls = new Map<Type, number>();
  const originals = new Map<Type, () => readonly Type[] | undefined>();
  const compound = new Set<Type>();
  for (const node of collectNodes(w)) {
    const type = raw.getTypeAtLocation(node);
    if (type === undefined || !(type.isUnionType() || type.isIntersectionType())) continue;
    compound.add(type);
  }
  expect(compound.size).toBeGreaterThan(0);
  try {
    for (const type of compound) {
      const withConstituents = type as Type & { getTypes(): readonly Type[] | undefined };
      const original = withConstituents.getTypes.bind(withConstituents);
      originals.set(type, original);
      withConstituents.getTypes = () => {
        calls.set(type, (calls.get(type) ?? 0) + 1);
        return original();
      };
    }
    for (const type of compound) {
      const first = ad.constituentTypes(type);
      expect(ad.constituentTypes(type)).toBe(first);
      expect(calls.get(type)).toBe(1);
    }
  } finally {
    for (const [type, original] of originals) {
      (type as Type & { getTypes(): readonly Type[] | undefined }).getTypes = original;
    }
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
  const w = buildTwoWorlds({
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
  }, host);
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
  expect(headerSymbolNodes.every((node) => deferred.every((root) => !inside(node, root)))).toBe(true);

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

test("managed misses stay direct instead of falling back to whole-file prefetch", () => {
  const w = buildTwoWorlds({
    "managed.ts": `
export function dead(input: number): number {
  const first = input + 1;
  const second = first + 1;
  return second;
}
`,
  }, host);
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
  const w = buildTwoWorlds({
    "symbol-type-handoff.ts": `
export function reached(input: number): number {
${locals}
  return local23;
}
`,
  }, host);
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
  const w = buildTwoWorlds({
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
  }, host);
  worlds.push(w);
  const { proxy, calls } = countingChecker(w.p7.project.checker);
  const facade = new CheckerFacade(proxy, { project: w.p7.project });
  (w.p7 as unknown as { checkerFacade: CheckerFacade | null }).checkerFacade = facade;
  const sf = w.p7.getSourceFile(w.files[0]!)!;
  const cls = sf.statements.find(ad.isClassDeclaration)!;
  const ctor = cls.members.find(ad.isConstructorDeclaration)!;
  const insideCtor = (node: Node): boolean =>
    node.getStart() >= ctor.getStart() && node.end <= ctor.end;

  lowerToIr(w.p7, sf, [sf]);

  for (const name of ["getTypeAtLocation", "getSymbolAtLocation"]) {
    const checkerCalls = calls[name] ?? [];
    expect(checkerCalls.some(([arg]) =>
      Array.isArray(arg) && (arg as Node[]).some(insideCtor),
    )).toBe(true);
    expect(checkerCalls.some(([arg]) =>
      !Array.isArray(arg) && insideCtor(arg as Node),
    )).toBe(false);
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
  const facade = new CheckerFacade(proxy, { project: w.p7.project });
  (w.p7 as unknown as { checkerFacade: CheckerFacade | null }).checkerFacade = facade;
  const sf = w.p7.getSourceFile(w.files[0]!)!;
  const initializers = sf.statements
    .filter(ad.isFunctionDeclaration)
    .map((decl) => decl.parameters[0]!.initializer!);

  lowerToIr(w.p7, sf, [sf]);

  const typeCalls = calls["getTypeAtLocation"] ?? [];
  expect(typeCalls.some(([arg]) =>
    Array.isArray(arg) && initializers.every((initializer) => (arg as Node[]).includes(initializer)),
  )).toBe(true);
  expect(typeCalls.some(([arg]) =>
    !Array.isArray(arg) && initializers.includes(arg as never),
  )).toBe(false);
});

test("class-shape collection batches deferred method default types", () => {
  const methods = Array.from(
    { length: 24 },
    (_, index) =>
      `  dead${index}(value = process.env.VALUE): string | undefined { return value; }`,
  ).join("\n");
  const w = buildTwoWorlds({
    "class-defaults.ts": `class Dead {\n${methods}\n}\nconsole.log("ok");\n`,
  }, host);
  worlds.push(w);
  const { proxy, calls } = countingChecker(w.p7.project.checker);
  const facade = new CheckerFacade(proxy, { project: w.p7.project });
  (w.p7 as unknown as { checkerFacade: CheckerFacade | null }).checkerFacade = facade;
  const sf = w.p7.getSourceFile(w.files[0]!)!;
  const cls = sf.statements.find(ad.isClassDeclaration)!;
  const initializers = cls.members
    .filter(ad.isMethodDeclaration)
    .map((member) => member.parameters[0]!.initializer!);

  lowerToIr(w.p7, sf, [sf]);

  const typeCalls = calls["getTypeAtLocation"] ?? [];
  expect(typeCalls.some(([arg]) =>
    Array.isArray(arg) && initializers.every((initializer) => (arg as Node[]).includes(initializer)),
  )).toBe(true);
  expect(typeCalls.some(([arg]) =>
    !Array.isArray(arg) && initializers.includes(arg as never),
  )).toBe(false);
});

test("eager npm-static implicit instances batch their committed body", () => {
  const w = buildTwoWorlds({
    "eager-implicit.js": `
function pick(value) {
  const row = { value };
  return row.value;
}
console.log(pick(42));
`,
  }, host);
  worlds.push(w);
  const { proxy, calls } = countingChecker(w.p7.project.checker);
  const facade = new CheckerFacade(proxy, { project: w.p7.project });
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
  expect(typeCalls.some(([arg]) =>
    Array.isArray(arg) && (arg as Node[]).some(insideBody),
  )).toBe(true);
  expect(typeCalls.some(([arg]) =>
    !Array.isArray(arg) && insideBody(arg as Node),
  )).toBe(false);
});

test("coverage remainder batches checker queries for unreachable bodies", () => {
  const w = buildTwoWorlds({
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
  }, host);
  worlds.push(w);
  const { proxy, calls } = countingChecker(w.p7.project.checker);
  const facade = new CheckerFacade(proxy, { project: w.p7.project });
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
  expect(typeBodyCalls.some(([arg]) =>
    Array.isArray(arg) && (arg as Node[]).some(insideDeadBody),
  )).toBe(true);
  expect(typeBodyCalls.some(([arg]) =>
    !Array.isArray(arg) && insideDeadBody(arg as Node) && hotTypeKinds.has((arg as Node).kind),
  )).toBe(false);

  const symbolBodyCalls = calls["getSymbolAtLocation"] ?? [];
  expect(symbolBodyCalls.some(([arg]) =>
    Array.isArray(arg) && (arg as Node[]).some(insideDeadBody),
  )).toBe(true);
  expect(symbolBodyCalls.some(([arg]) =>
    !Array.isArray(arg) && insideDeadBody(arg as Node) && ad.isIdentifier(arg as Node),
  )).toBe(false);
});

test("root prefetch panic-fences bad nodes and keeps healthy answers warm", () => {
  const w = buildTwoWorlds({
    "panic.ts": `
export function f(input: number): number {
  const healthy = input + 1;
  const poison = healthy + 1;
  return poison;
}
`,
  }, host);
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

test("tuple/array predicate round-trips wear the panic fence (2726)", () => {
  // A REFERENCE to a tuple alias instantiation is the shape that round-trips
  // (the client-side shape check answers false there) — exactly where tsgo's
  // TypeReference/TupleType interface-conversion panics live. The facade
  // must degrade the panicked query to false, memoized, like a panicked
  // batch item — not crash the query pass.
  const w = buildTwoWorlds({
    "tuples.ts": `
type Pair<A, B> = [A, B];
export function f(pair: Pair<string, number>, list: string[]) {
  return [pair[0], list.length];
}
`,
  }, host);
  worlds.push(w);
  const raw = w.p7.project.checker;
  const sf = w.p7.getSourceFile(w.files[0]!)!;
  const fn = sf.statements.find(ad.isFunctionDeclaration)!;
  const direct = new CheckerFacade(raw);
  const tupleType = direct.getTypeAtLocation(fn.parameters[0]!)!;
  const arrayType = direct.getTypeAtLocation(fn.parameters[1]!)!;
  expect(tupleType).toBeDefined();
  expect(arrayType).toBeDefined();
  expect(raw.isTupleType(tupleType)).toBe(true);

  let panics = 0;
  const panicky = new Proxy(raw, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === "isTupleType" || prop === "isArrayType" || prop === "isArrayLikeType") {
        return (t: Type) => {
          if (t === tupleType || t === arrayType) {
            panics++;
            throw new Error(
              "panic: interface conversion: checker.TypeData is *checker.TypeReference, not checker.TupleType",
            );
          }
          return (value as (t: Type) => boolean).call(target, t);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Checker;
  const facade = new CheckerFacade(panicky);
  expect(facade.isTupleType(tupleType)).toBe(false);
  expect(facade.isArrayType(arrayType)).toBe(false);
  expect(facade.isArrayLikeType(arrayType)).toBe(false);
  // Degraded answers memoize: the panicking query never repeats.
  const warm = panics;
  facade.isTupleType(tupleType);
  facade.isArrayType(arrayType);
  facade.isArrayLikeType(arrayType);
  expect(panics).toBe(warm);
  // Healthy object types through the same poisoned facade keep real answers.
  expect(facade.isTupleType(arrayType)).toBe(false);
  expect(facade.isArrayType(tupleType)).toBe(false);
});
