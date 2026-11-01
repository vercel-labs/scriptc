/* The triage table's guard: every TypeScript code the Test262 journals
 * recorded reaching SC0001 in a JavaScript source has exactly one decision
 * (tsc-codes.ts), so a new code cannot slip in untriaged. */
import { describe, expect, test } from "vitest";
import { JS_TSC_CODE_TRIAGE, jsTscCodeTriage } from "./tsc-codes.js";

/** The distinct codes the 2026-10-31 journals recorded for in-scope
 * SC0001 variants in JavaScript, plus the eight the W1.1/W1.2 relaxations
 * own (2695, 7032, 18050, 2508, 7057, 2704, 2464, 2365), which the table
 * deliberately does not carry. */
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

/** The W1.1/W1.2 codes: admitted by their own relaxations, not triaged. */
const W1_1_W1_2_CODES = new Set([2695, 7032, 18050, 2508, 7057, 2704, 2464, 2365]);

const OBSERVED = [...new Set(OBSERVED_SC0001_JS_CODES)];

describe("the SC0001 JavaScript triage table", () => {
  test("every observed code has exactly one decision", () => {
    const missing = OBSERVED.filter(
      (code) => !W1_1_W1_2_CODES.has(code) && jsTscCodeTriage(code) === null,
    );
    expect(missing).toEqual([]);
    expect(JS_TSC_CODE_TRIAGE.size).toBe(
      OBSERVED.filter((code) => !W1_1_W1_2_CODES.has(code)).length,
    );
  });

  test("the table holds no code the journals never produced", () => {
    const stray = [...JS_TSC_CODE_TRIAGE.keys()].filter((code) => !OBSERVED.includes(code));
    expect(stray).toEqual([]);
  });

  test("every refusal names its construct and its next step", () => {
    for (const [code, decision] of JS_TSC_CODE_TRIAGE) {
      if (decision.action !== "refuse" && decision.action !== "rewrite") continue;
      expect(decision.feature.length, `TS${code}`).toBeGreaterThan(0);
      expect(decision.hint.length, `TS${code}`).toBeGreaterThan(0);
    }
  });

  test("every admission says why it is safe", () => {
    for (const [code, decision] of JS_TSC_CODE_TRIAGE) {
      if (decision.action !== "relax" && decision.action !== "keep") continue;
      expect(decision.why.length, `TS${code}`).toBeGreaterThan(0);
    }
  });
});
