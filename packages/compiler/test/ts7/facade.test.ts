/* The checker facade's mechanics: memoization and batch prefetch must be
 * REAL — measured as raw-client call counts through a counting proxy, not
 * inferred from timings — and the client-side fast paths must agree with
 * the raw checker's answers on the same objects. */

import { afterAll, expect, test } from "vitest";
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

function countingChecker(raw: Checker): { proxy: Checker; counts: Record<string, number> } {
  const counts: Record<string, number> = {};
  const proxy = new Proxy(raw, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value === "function" && typeof prop === "string") {
        return (...args: unknown[]) => {
          counts[prop] = (counts[prop] ?? 0) + 1;
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return value;
    },
  });
  return { proxy, counts };
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
