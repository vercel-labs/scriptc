import { Ts7Host } from "../../src/frontend/ts7/program-adapter.js";
import { createProgram } from "../../src/frontend/ts7/program-adapter.js";
/* The memo/batch effect, measured on the survey's two real workloads.
 *
 * The survey counted the checker traffic a real lowering makes (counting
 * proxy over 5.9.3, committed JSONs): commander-calc 2,613 calls,
 * mock-gateway 32,226 — dominated by getBaseTypeOfLiteralType,
 * getTypeOfSymbol, isTupleType, isArrayType, getSymbolAtLocation,
 * getTypeAtLocation. Naive per-call use of the 7.0.2 sync client costs
 * 0.1-0.3 ms per query (IPC round trip), which projects to seconds per
 * lowering; the facade's batching + memoization must bring the same call
 * mix back to the survey's batched rate (~0.005 ms/call — 5.9.3 parity).
 *
 * This bench REPLAYS each workload's census mix through the facade against
 * the fixture's own program and compares it with the naive projection
 * measured on the same machine in the same process. The assertion is
 * deliberately coarse (10x) so scheduler noise cannot flake it; the real
 * numbers land in the log line for the migration report. */

import { afterAll, expect, test } from "vitest";
import { fileURLToPath } from "node:url";
import type { Node } from "../../src/frontend/ts7/ast-types.js";
import type {
  Signature,
  Symbol as Ts7Symbol,
  Type,
  TypeReference,
} from "../../src/frontend/ts7/semantic-types.js";
import { CheckerFacade } from "../../src/frontend/ts7/checker.js";
import { ambientDtsPath, fallbackDtsPath, overridesDtsPath } from "../../src/frontend/program.js";
import { fallbackModulesNamedIn } from "../../src/frontend/dts-paths.js";
import { readFileSync } from "node:fs";
import { ad, options7 } from "./harness.js";

const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));

/* The survey's committed call counts (checker-call-counts-*.json). */
const WORKLOADS = [
  {
    name: "commander-calc",
    entry: `${repoRoot}tests/fixtures/commander-calc/calc.ts`,
    // 2.6k calls against a 331-node file: the one-time prefetch is a real
    // fraction of the total, and under the suite's parallel-file contention
    // the ratio compresses — the bound is beat-naive, not a multiple.
    minSpeedup: 1.2,
    census: {
      getBaseTypeOfLiteralType: 701,
      getSymbolAtLocation: 484,
      isTupleType: 314,
      getTypeAtLocation: 303,
      isArrayType: 248,
      getPropertiesOfType: 172,
      getTypeOfSymbol: 152,
      isArrayLikeType: 66,
      getIndexInfosOfType: 66,
      getReturnTypeOfSignature: 38,
      getContextualType: 22,
      getSignatureFromDeclaration: 16,
      getNonNullableType: 16,
      getTypeArguments: 8,
      getAliasedSymbol: 7,
    },
  },
  {
    name: "mock-gateway",
    entry: `${repoRoot}tests/fixtures/gateway-e2e/mock-gateway.ts`,
    // 32k calls: the memo/batch effect at census scale — measured 13-16x
    // on a quiet machine; 4x is the no-flake floor (a full-suite run with
    // five clang-heavy workers measured 4.89x once — the bound exists to
    // catch the batching REGRESSING to per-call IPC, an order-of-magnitude
    // event, not to pin scheduler weather).
    minSpeedup: 4,
    census: {
      getBaseTypeOfLiteralType: 9059,
      getTypeOfSymbol: 5333,
      isTupleType: 4595,
      isArrayType: 3707,
      getPropertiesOfType: 2511,
      getSymbolAtLocation: 1538,
      isArrayLikeType: 1523,
      getIndexInfosOfType: 1518,
      getTypeAtLocation: 1467,
      getTypeArguments: 676,
      getContextualType: 194,
      getReturnTypeOfSignature: 58,
      getSignatureFromDeclaration: 18,
      typeToString: 14,
      getNonNullableType: 11,
    },
  },
] as const;

const host = new Ts7Host();
afterAll(() => host.close());

interface Pools {
  nodes: Node[];
  identifiers: Node[];
  functionish: Node[];
  symbols: Ts7Symbol[];
  types: Type[];
  references: TypeReference[];
  signatures: Signature[];
}

function collectPools(facade: CheckerFacade, sf: ad.SourceFile): Pools {
  const nodes: Node[] = [];
  const visit = (n: Node): void => {
    nodes.push(n);
    n.forEachChild(visit);
  };
  visit(sf);
  const identifiers = nodes.filter((n) => ad.isIdentifier(n));
  const functionish = nodes.filter(
    (n) =>
      ad.isFunctionDeclaration(n) ||
      ad.isArrowFunction(n) ||
      ad.isFunctionExpression(n) ||
      ad.isMethodDeclaration(n),
  );
  const symbols: Ts7Symbol[] = [];
  const typeSet = new Set<Type>();
  for (const n of nodes) {
    const t = facade.getTypeAtLocation(n);
    if (t) typeSet.add(t);
    const s = facade.getSymbolAtLocation(n);
    if (s) symbols.push(s);
  }
  const types = [...typeSet];
  const references = types.filter((t): t is TypeReference => t.isTypeReference());
  const signatures = functionish
    .map((n) => facade.getSignatureFromDeclaration(n))
    .filter((s): s is Signature => s !== undefined);
  return { nodes, identifiers, functionish, symbols, types, references, signatures };
}

function replay(facade: CheckerFacade, pools: Pools, census: Record<string, number>): number {
  const pick = <T>(pool: T[], i: number): T | undefined => pool[i % Math.max(pool.length, 1)];
  const start = performance.now();
  for (const [method, calls] of Object.entries(census)) {
    for (let i = 0; i < calls; i++) {
      switch (method) {
        case "getTypeAtLocation":
          facade.getTypeAtLocation(pick(pools.nodes, i)!);
          break;
        case "getSymbolAtLocation":
          facade.getSymbolAtLocation(pick(pools.nodes, i)!);
          break;
        case "getContextualType":
          facade.getContextualType(pick(pools.identifiers, i)!);
          break;
        case "getTypeOfSymbol": {
          const s = pick(pools.symbols, i);
          if (s) facade.getTypeOfSymbol(s);
          break;
        }
        case "getAliasedSymbol": {
          const s = pick(pools.symbols, i);
          if (s && s.flags & ad.SymbolFlags.Alias) facade.getAliasedSymbol(s);
          break;
        }
        case "getBaseTypeOfLiteralType": {
          const t = pick(pools.types, i);
          if (t) facade.getBaseTypeOfLiteralType(t);
          break;
        }
        case "isTupleType": {
          const t = pick(pools.types, i);
          if (t) facade.isTupleType(t);
          break;
        }
        case "isArrayType": {
          const t = pick(pools.types, i);
          if (t) facade.isArrayType(t);
          break;
        }
        case "isArrayLikeType": {
          const t = pick(pools.types, i);
          if (t) facade.isArrayLikeType(t);
          break;
        }
        case "getPropertiesOfType": {
          const t = pick(pools.types, i);
          if (t) facade.getPropertiesOfType(t);
          break;
        }
        case "getIndexInfosOfType": {
          const t = pick(pools.types, i);
          if (t) facade.getIndexInfosOfType(t);
          break;
        }
        case "getNonNullableType": {
          const t = pick(pools.types, i);
          if (t) facade.getNonNullableType(t);
          break;
        }
        case "typeToString": {
          const t = pick(pools.types, i);
          if (t) facade.typeToString(t);
          break;
        }
        case "getTypeArguments": {
          const t = pick(pools.references, i);
          if (t) facade.getTypeArguments(t);
          break;
        }
        case "getReturnTypeOfSignature": {
          const s = pick(pools.signatures, i);
          if (s) facade.getReturnTypeOfSignature(s);
          break;
        }
        case "getSignatureFromDeclaration": {
          const n = pick(pools.functionish, i);
          if (n) facade.getSignatureFromDeclaration(n);
          break;
        }
        default:
          throw new Error(`unmapped census method ${method}`);
      }
    }
  }
  return performance.now() - start;
}

for (const workload of WORKLOADS) {
  // retry: the naive projection and the facade replay are measured in
  // adjacent windows, so a load burst landing in exactly one of them can
  // invert the comparison on a busy machine. A real batching regression
  // is ~10x and fails every attempt.
  test(
    `${workload.name}: facade replay of the census mix beats the naive per-call projection`,
    { retry: 2 },
    () => {
      const program = createProgram(
        [
          workload.entry,
          ambientDtsPath(),
          fallbackDtsPath(),
          ...fallbackModulesNamedIn(readFileSync(workload.entry, "utf8")),
          overridesDtsPath(),
        ],
        options7(),
        host,
      );
      try {
        const sf = program.getSourceFile(workload.entry);
        expect(sf).toBeDefined();
        const raw = program.project.checker;

        // NAIVE: raw one-by-one queries, measured on this machine right now.
        const walk: Node[] = [];
        const visit = (n: Node): void => {
          walk.push(n);
          n.forEachChild(visit);
        };
        visit(sf!);
        const sample = walk.filter((_, i) => i % Math.ceil(walk.length / 300) === 0);
        const naiveStart = performance.now();
        for (const n of sample) raw.getTypeAtLocation(n);
        const naivePerCallMs = (performance.now() - naiveStart) / sample.length;

        // FACADE: prime (the prefetch IS part of the facade's cost) + replay.
        const facade = new CheckerFacade(raw);
        const primeStart = performance.now();
        const pools = collectPools(facade, sf!);
        const primeMs = performance.now() - primeStart;
        const totalCalls = Object.values(workload.census).reduce((a, b) => a + b, 0);
        const replayMs = replay(facade, pools, workload.census);

        const facadeMs = primeMs + replayMs;
        const naiveProjectedMs = naivePerCallMs * totalCalls;
        console.log(
          `[ts7-bench] ${JSON.stringify({
            workload: workload.name,
            walkNodes: walk.length,
            totalCensusCalls: totalCalls,
            naivePerCallMs: +naivePerCallMs.toFixed(4),
            naiveProjectedMs: +naiveProjectedMs.toFixed(1),
            facadePrimeMs: +primeMs.toFixed(1),
            facadeReplayMs: +replayMs.toFixed(1),
            facadeTotalMs: +facadeMs.toFixed(1),
            speedup: +(naiveProjectedMs / facadeMs).toFixed(1),
            replayPerCallMs: +(replayMs / totalCalls).toFixed(4),
          })}`,
        );
        // Coarse on purpose so scheduler noise cannot flake it; the real
        // effect (logged above) measures ~4-16x total and 0.002-0.005
        // ms/call replayed — the survey's batched-parity rate.
        expect(facadeMs).toBeLessThan(naiveProjectedMs / workload.minSpeedup);
      } finally {
        program.dispose();
      }
    },
  );
}
