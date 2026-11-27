import { expect, test } from "vitest";
import type { ScrDiagnostic } from "../../diagnostics/diagnostic.js";
import { F64, STRING, primitiveConstructorType } from "../../ir/ir.js";
import type { IrType } from "../../ir/ir.js";
import {
  constructorRefusals,
  fewerRefusals,
  holdsConstructorFunction,
  otherErrors,
} from "./held-constructors.js";
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

/** A ladder of `depth` unions, each with two record arms that both hold the
 * next union: 2^depth paths to the bottom, `3 * depth` named types. */
function ladder(depth: number, bottom: IrType) {
  const shapes = new Map<string, { fields: { name: string; type: IrType }[] }>();
  const unions = new Map<string, { arms: IrType[] }>();
  const union = (i: number): IrType => ({ kind: "union", unionId: `u${i}` });
  const record = (id: string): IrType => ({ kind: "record", shapeId: id });
  for (let i = 0; i < depth; i++) {
    const next = i + 1 < depth ? union(i + 1) : bottom;
    shapes.set(`a${i}`, { fields: [{ name: "a", type: next }] });
    shapes.set(`b${i}`, { fields: [{ name: "b", type: next }] });
    unions.set(`u${i}`, { arms: [record(`a${i}`), record(`b${i}`)] });
  }
  const lowerer = {
    shapes,
    unions,
    classes: new Map(),
    constructorHolders: new Map<string, boolean>(),
  } as unknown as Lowerer;
  return { lowerer, top: union(0) };
}

test("a walk meets each shared type once, however many paths reach it", () => {
  // Walked once per path, the 60-deep ladder is 2^60 visits.
  const none = ladder(60, F64);
  expect(holdsConstructorFunction(none.lowerer, none.top)).toBe(false);
  expect(none.lowerer.constructorHolders.size).toBe(180);
  expect([...none.lowerer.constructorHolders.values()].every((held) => !held)).toBe(true);
  const held = ladder(60, primitiveConstructorType(STRING));
  expect(holdsConstructorFunction(held.lowerer, held.top)).toBe(true);
  expect(held.lowerer.constructorHolders.get("u:u0")).toBe(true);
});
