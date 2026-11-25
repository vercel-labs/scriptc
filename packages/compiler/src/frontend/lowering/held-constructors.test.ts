import { expect, test } from "vitest";
import type { ScrDiagnostic } from "../../diagnostics/diagnostic.js";
import { constructorRefusals, fewerRefusals, otherErrors } from "./held-constructors.js";
import type { Lowerer, LowerResult } from "./lowerer.js";

const loc = { file: "main.ts", start: 0, end: 1 };
const refusal = (extra: Partial<ScrDiagnostic> = {}): ScrDiagnostic =>
  ({ code: "SC1090", message: "refused", loc, ...extra }) as ScrDiagnostic;
const pass = (diagnostics: ScrDiagnostic[], runtimeFences: ScrDiagnostic[] = []): LowerResult =>
  ({ module: null, diagnostics, runtimeFences }) as unknown as LowerResult;

test("a pass with fewer build errors refuses less, whatever it defers", () => {
  expect(fewerRefusals(pass([], [refusal(), refusal()]), pass([refusal()]))).toBe(true);
  expect(fewerRefusals(pass([refusal()]), pass([], [refusal(), refusal()]))).toBe(false);
});

test("with as many build errors, refusals a module reaches when it starts decide first", () => {
  const atStart = refusal({ startup: true });
  expect(fewerRefusals(pass([], [refusal(), refusal()]), pass([], [atStart]))).toBe(true);
  expect(fewerRefusals(pass([], [atStart]), pass([], [refusal(), refusal()]))).toBe(false);
  expect(fewerRefusals(pass([], [refusal()]), pass([], [refusal({ moduleInit: true })]))).toBe(
    true,
  );
});

test("then the deferred refusals in all, and a tie keeps the standing pass", () => {
  expect(fewerRefusals(pass([], [refusal()]), pass([], [refusal(), refusal()]))).toBe(true);
  expect(fewerRefusals(pass([], [refusal()]), pass([], [refusal()]))).toBe(false);
  expect(fewerRefusals(pass([refusal()]), pass([refusal()]))).toBe(false);
});

test("a refusal involves a held constructor by its mark, as an error or deferred", () => {
  const marked = refusal({ heldConstructor: true });
  const holds = { constructorFunctionTypes: true } as unknown as Lowerer;
  const holdsNone = { constructorFunctionTypes: false } as unknown as Lowerer;
  expect(constructorRefusals(holds, pass([refusal()], [refusal()]))).toBe(false);
  expect(constructorRefusals(holds, pass([marked]))).toBe(true);
  expect(constructorRefusals(holds, pass([], [marked]))).toBe(true);
  // A program that writes no constructor as a value never compares, though
  // every diagnostic it makes carries the mark.
  expect(constructorRefusals(holdsNone, pass([marked]))).toBe(false);
  expect(otherErrors(pass([marked]))).toBe(false);
  expect(otherErrors(pass([marked, refusal()]))).toBe(true);
  expect(otherErrors(pass([], [refusal()]))).toBe(false);
});
