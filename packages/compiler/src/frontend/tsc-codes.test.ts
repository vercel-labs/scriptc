/* The two tables' guard: every TypeScript code the Test262 journals recorded
 * reaching SC0001 in a JavaScript source has exactly one decision — an
 * admission row in JS_OPINIONS or a decision in JS_TSC_CODE_TRIAGE
 * (tsc-codes.ts) — so a new code cannot slip in undecided. */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { JS_OPINIONS, JS_TSC_CODE_TRIAGE, jsOpinion, jsTscCodeTriage } from "./tsc-codes.js";

/** The distinct codes the 2026-10-31 journals recorded for in-scope
 * SC0001 variants in JavaScript. The W1.1/W1.2 codes (2695, 7032, 18050,
 * 2508, 7057, 2704, 2464, 2365) appear in it too: they are decisions of
 * JS_OPINIONS now, not exceptions to the tables. */
const OBSERVED_SC0001_JS_CODES: readonly number[] = [
  1005,
  1010,
  1014,
  1042,
  1052,
  1054,
  1089,
  1101,
  1102,
  1104,
  1105,
  1106,
  1109,
  1113,
  1114,
  1117,
  1119,
  1121,
  1123,
  1125,
  1127,
  1134,
  1142,
  1156,
  1163,
  1166,
  1189,
  1198,
  1200,
  1210,
  1214,
  1215,
  1260,
  1262,
  1312,
  1313,
  1320,
  1329,
  1341,
  1359,
  1368,
  1451,
  1487,
  1488,
  1489,
  1492,
  1493,
  1494,
  1514,
  1532,
  1533,
  1534,
  1536,
  1539,
  2300,
  2335,
  2337,
  2348,
  2356,
  2357,
  2359,
  2364,
  2365,
  2372,
  2373,
  2377,
  2378,
  2392,
  2393,
  2403,
  2405,
  2406,
  2407,
  2408,
  2409,
  2416,
  2417,
  2418,
  2447,
  2448,
  2451,
  2454,
  2464,
  2469,
  2481,
  2487,
  2490,
  2491,
  2492,
  2493,
  2506,
  2508,
  2511,
  2524,
  2537,
  2539,
  2542,
  2547,
  2565,
  2576,
  2588,
  2629,
  2630,
  2660,
  2662,
  2678,
  2684,
  2698,
  2699,
  2700,
  2703,
  2704,
  2723,
  2729,
  2736,
  2739,
  2767,
  2768,
  2774,
  2777,
  2783,
  2803,
  2815,
  2839,
  2845,
  2850,
  2855,
  2869,
  2871,
  2872,
  2873,
  4104,
  5076,
  7032,
  7036,
  17005,
  17009,
  17011,
  17013,
  18013,
  18014,
  18016,
  18030,
  18037,
  18041,
  18058,
  18059,
  18061,
  2464, // W1.1/W1.2
  2508, // W1.1/W1.2
  2695, // W1.1/W1.2
  2704, // W1.1/W1.2
  7032, // W1.1/W1.2
  7057, // W1.1/W1.2
  2365, // W1.1/W1.2
  18050, // W1.1/W1.2
];

const OBSERVED = [...new Set(OBSERVED_SC0001_JS_CODES)];

const CORPUS = fileURLToPath(new URL("../../../../tests/corpus/", import.meta.url));

/** Codes the tables deliberately leave undecided, so the diagnostic stays
 * SC0001: each is legal JavaScript whose construct the lowerer cannot build
 * Node-exactly yet (TS2704's builtin-receiver delete, TS2464's class element
 * name — see the "NOT relaxed" note in tsc-codes.ts).
 * `inferred-js-diagnostics.test.ts` pins that they stay refused; nothing
 * admits them. (TS2508 left this set when the heritage lowering learned the
 * lib's generic abstract Iterator base; it is a `checker` row now.) */
const ADMISSION_ONLY_REFUSALS = new Set([2464, 2704]);

describe("the JavaScript checker decisions", () => {
  test("every observed code has exactly one decision", () => {
    const missing = OBSERVED.filter(
      (code) =>
        !ADMISSION_ONLY_REFUSALS.has(code) &&
        jsOpinion(code) === null &&
        jsTscCodeTriage(code) === null,
    );
    expect(missing).toEqual([]);
  });

  test("the triage table holds no code the journals never produced", () => {
    const stray = [...JS_TSC_CODE_TRIAGE.keys()].filter((code) => !OBSERVED.includes(code));
    expect(stray).toEqual([]);
  });

  test("only a site guard's fallback puts a code in both tables", () => {
    // An opinion row admits the construct; the triage row of the same code
    // stays for the sites the row's guard excludes, where the user must keep
    // the named SC1090 refusal instead of an unnamed passthrough. The one
    // exception is a code whose excluded sites are SyntaxErrors in Node: a
    // regex decimal escape without its group, or in a character class, is
    // legal outside Unicode mode and a grammar error inside it.
    const grammarFallbacks = new Set([1533, 1534, 1536]);
    for (const [code, opinion] of JS_OPINIONS) {
      const decision = jsTscCodeTriage(code);
      if (decision === null) continue;
      expect(typeof opinion.site, `TS${code}`).toBe("function");
      if (grammarFallbacks.has(code)) expect(decision.action, `TS${code}`).toBe("keep");
      else expect(decision.action, `TS${code}`).not.toBe("keep");
    }
  });

  test("every admission and every refusal names its side of the boundary", () => {
    for (const [code, decision] of JS_TSC_CODE_TRIAGE) {
      if (decision.action === "refuse" || decision.action === "rewrite") {
        expect(decision.feature.length, `TS${code}`).toBeGreaterThan(0);
        expect(decision.hint.length, `TS${code}`).toBeGreaterThan(0);
      } else {
        expect(decision.why.length, `TS${code}`).toBeGreaterThan(0);
      }
    }
    for (const [code, opinion] of JS_OPINIONS) {
      expect(opinion.why.length, `TS${code}`).toBeGreaterThan(0);
      expect(["checker", "widen", "throw", "island"], `TS${code}`).toContain(opinion.view);
    }
  });

  test("every corpus program an opinion names exists", () => {
    for (const [code, opinion] of JS_OPINIONS)
      for (const program of opinion.corpus)
        expect(
          existsSync(CORPUS + program.slice("tests/corpus/".length)),
          `TS${code} ${program}`,
        ).toBe(true);
  });
});
