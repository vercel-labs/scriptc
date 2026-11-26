import { expect, test } from "vitest";
import { lowerFailureFromPoison, PoisonError, type Lowerer } from "./lowerer.js";

const diagnostic = {
  code: "SC1090",
  category: "unsupported",
  severity: "error",
  scope: "reached",
  message: "a refused construct",
} as never;

function fakeLowerer(diags: readonly unknown[]): Lowerer {
  return {
    diags,
    stats: { statementsTotal: 1, statementsFailed: 1, functionsSkipped: 0 },
  } as unknown as Lowerer;
}

test("a recorded refusal that escapes its local recovery becomes that diagnostic", () => {
  expect(lowerFailureFromPoison(new PoisonError(), fakeLowerer([diagnostic]))).toEqual({
    module: null,
    diagnostics: [diagnostic],
    runtimeFences: [],
    stats: { statementsTotal: 1, statementsFailed: 1, functionsSkipped: 0 },
  });
});

test("an unrecorded poison or another error still surfaces as an internal failure", () => {
  expect(lowerFailureFromPoison(new PoisonError(), fakeLowerer([]))).toBeNull();
  expect(lowerFailureFromPoison(new Error("boom"), fakeLowerer([diagnostic]))).toBeNull();
});
