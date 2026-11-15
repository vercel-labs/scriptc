import { expect, test } from "vitest";
import type { Program, SourceFile, Symbol as TsSymbol, Type } from "../ts7/adapter.js";
import { Lowerer } from "./lowerer.js";
import type { IrType } from "../../ir/ir.js";

const lowerer = (): Lowerer =>
  new Lowerer(
    { getTypeChecker: () => ({}), isSourceFileDefaultLibrary: () => false } as unknown as Program,
    { fileName: "/island/entry.ts" } as SourceFile,
    [],
  );

/** Installs a pair of binding maps the way generic-functions.ts:828 does. */
function inBindings<T>(
  subject: Lowerer,
  bindings: Map<TsSymbol, IrType>,
  tsBindings: Map<TsSymbol, Type> | null,
  fn: () => T,
): T {
  const prevBindings = subject.typeParamBindings;
  const prevTsBindings = subject.typeParamTsBindings;
  subject.typeParamBindings = bindings;
  subject.typeParamTsBindings = tsBindings;
  try {
    return fn();
  } finally {
    subject.typeParamBindings = prevBindings;
    subject.typeParamTsBindings = prevTsBindings;
  }
}

test("the top-level memo is the lowerer's own outside generic bindings", () => {
  const subject = lowerer();
  expect(subject.currentTypeMemo()).toBe(subject.typeMemo);
  expect(subject.typeCtx.typeMemoFor?.()).toBe(subject.typeMemo);
});

test("each installed pair of binding maps has its own memo", () => {
  const subject = lowerer();
  const first = new Map<TsSymbol, IrType>();
  const second = new Map<TsSymbol, IrType>();

  const a = inBindings(subject, first, null, () => subject.currentTypeMemo());
  const b = inBindings(subject, second, null, () => subject.currentTypeMemo());
  const again = inBindings(subject, first, null, () => subject.currentTypeMemo());

  expect(a).not.toBe(subject.typeMemo);
  expect(a).not.toBe(b);
  // Identity is the context: the same maps give the same memo back.
  expect(again).toBe(a);
  expect(subject.currentTypeMemo()).toBe(subject.typeMemo);
});

test("a context copy made inside a binding scope follows the live scope", () => {
  const subject = lowerer();
  const bindings = new Map<TsSymbol, IrType>();
  const tsBindings = new Map<TsSymbol, Type>();
  const captured = inBindings(subject, bindings, tsBindings, () => ({ ...subject.typeCtx }));

  const inside = inBindings(subject, bindings, tsBindings, () => captured.typeMemoFor?.());
  expect(inside).toBeDefined();
  expect(inside).not.toBe(subject.typeMemo);
  // Outside the scope the copy answers with the top-level memo, because the
  // hook reads the lowerer's current bindings rather than a snapshot.
  expect(captured.typeMemoFor?.()).toBe(subject.typeMemo);
});

test("the checker-side bindings map is part of the scope", () => {
  const subject = lowerer();
  const bindings = new Map<TsSymbol, IrType>();
  const tsFirst = new Map<TsSymbol, Type>();
  const tsSecond = new Map<TsSymbol, Type>();

  const a = inBindings(subject, bindings, tsFirst, () => subject.currentTypeMemo());
  const b = inBindings(subject, bindings, tsSecond, () => subject.currentTypeMemo());
  expect(a).not.toBe(b);
});

test("an entry written under one context is invisible to another", () => {
  const subject = lowerer();
  const first = new Map<TsSymbol, IrType>();
  const second = new Map<TsSymbol, IrType>();
  const entry: IrType = { kind: "void" };

  inBindings(subject, first, null, () => subject.currentTypeMemo().set(7, entry));
  expect(inBindings(subject, second, null, () => subject.currentTypeMemo().get(7))).toBeUndefined();
  // ...and the context that wrote it still has it, through the repeat lookup
  // the lowerer's hot path takes (Lowerer.lastMemo).
  expect(inBindings(subject, first, null, () => subject.currentTypeMemo().get(7))).toBe(entry);
});

test("the shared memo is the lowerer's own and never a scope's", () => {
  const subject = lowerer();
  const bindings = new Map<TsSymbol, IrType>();
  expect(subject.sharedTypeMemo).not.toBe(subject.typeMemo);
  expect(subject.typeCtx.typeMemoShared).toBe(subject.sharedTypeMemo);
  expect(inBindings(subject, bindings, null, () => subject.currentTypeMemo())).not.toBe(
    subject.sharedTypeMemo,
  );
});

test("the shared memo outlives the scope that filled it", () => {
  const subject = lowerer();
  const bindings = new Map<TsSymbol, IrType>();
  const entry: IrType = { kind: "void" };
  inBindings(subject, bindings, null, () => subject.sharedTypeMemo.set(9, entry));
  // Both a later scope and the top level answer from it: an entry only lands
  // here when its mapping read no binding (noteScopeSensitiveMapping).
  const later = new Map<TsSymbol, IrType>();
  expect(inBindings(subject, later, null, () => subject.sharedTypeMemo.get(9))).toBe(entry);
  expect(subject.sharedTypeMemo.get(9)).toBe(entry);
});
