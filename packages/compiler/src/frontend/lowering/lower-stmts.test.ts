import { afterAll, expect, test, vi } from "vitest";
import * as ts from "../ts7/adapter.js";
import { closeSourceParser, parseSourceFile } from "../ts7/source-parser-node.js";
import { Lowerer } from "./lowerer.js";
import { jsBindingHasOpenWrites } from "./lower-stmts.js";

afterAll(closeSourceParser);

function at<T>(values: T[], index: number): T {
  const value = values[index];
  if (value === undefined) throw new Error(`fixture node ${index} is missing`);
  return value;
}

function context(source: string, filename = "writes.js") {
  const file = parseSourceFile(filename, source, filename.endsWith(".js") ? "js" : "ts");
  const declarations: ts.VariableDeclaration[] = [];
  const assignments: ts.BinaryExpression[] = [];
  ts.walkPreorder(file, (node) => {
    if (ts.isVariableDeclaration(node)) declarations.push(node);
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    )
      assignments.push(node);
  });
  const lowerer = new Lowerer({ getTypeChecker: () => ({}) } as ts.Program, file, []);
  const symbols = new Map<ts.Node, ts.Symbol>();
  const resolve = vi
    .spyOn(lowerer, "resolveValueSymbol")
    .mockImplementation((node) => symbols.get(node) ?? null);
  const typeOf = vi
    .spyOn(lowerer, "typeOf")
    .mockReturnValue({ flags: ts.TypeFlags.Any } as ts.Type);
  const bind = (decl: ts.VariableDeclaration, writes: ts.BinaryExpression[]) => {
    const symbol = {} as ts.Symbol;
    symbols.set(decl.name, symbol);
    for (const write of writes) symbols.set(write.left, symbol);
  };
  return { file, declarations, assignments, lowerer, resolve, typeOf, bind };
}

test("indexes a JS file once while preserving captured writes, compound assignments and shadowing", () => {
  const ctx = context(`let captured = 0; let compound = 0; let shadow = 0; let untouched = 0;
function mutate(value) { captured = value; compound += value; let shadow = 0; shadow = value; }`);
  const captured = at(ctx.declarations, 0),
    compound = at(ctx.declarations, 1),
    shadow = at(ctx.declarations, 2);
  const untouched = at(ctx.declarations, 3),
    innerShadow = at(ctx.declarations, 4);
  ctx.bind(captured, [at(ctx.assignments, 0)]);
  ctx.bind(compound, [at(ctx.assignments, 1)]);
  ctx.bind(shadow, []);
  ctx.bind(untouched, []);
  ctx.bind(innerShadow, [at(ctx.assignments, 2)]);
  const walk = vi.spyOn(ctx.file.file.wire, "preorder");
  for (let i = 0; i < 20; i++) {
    expect(jsBindingHasOpenWrites(ctx.lowerer, captured)).toBe(true);
    expect(jsBindingHasOpenWrites(ctx.lowerer, compound)).toBe(true);
    expect(jsBindingHasOpenWrites(ctx.lowerer, shadow)).toBe(false);
    expect(jsBindingHasOpenWrites(ctx.lowerer, untouched)).toBe(false);
  }
  expect(walk).toHaveBeenCalledTimes(1);
});

test("keeps scope indexes separate and rechecks contextual RHS types", () => {
  const ctx = context(`function first(value) { let item = 0; return () => { item = value; }; }
function second(value) { let item = 0; item = value; }`);
  const first = at(ctx.declarations, 0),
    second = at(ctx.declarations, 1);
  ctx.bind(first, [at(ctx.assignments, 0)]);
  ctx.bind(second, [at(ctx.assignments, 1)]);
  ctx.typeOf.mockReturnValue({ flags: ts.TypeFlags.Number } as ts.Type);
  expect(jsBindingHasOpenWrites(ctx.lowerer, first)).toBe(false);
  ctx.typeOf.mockReturnValue({ flags: ts.TypeFlags.Unknown } as ts.Type);
  expect(jsBindingHasOpenWrites(ctx.lowerer, first)).toBe(true);
  expect(jsBindingHasOpenWrites(ctx.lowerer, second)).toBe(true);
  expect(ctx.lowerer.jsBindingWritesByOwner.size).toBe(2);
});

test("typed declarations retain their annotation without scanning or checker queries", () => {
  for (const [source, filename] of [
    ["let item: number = 0;", "writes.ts"],
    ["/** @type {number} */ let item = 0;", "writes.js"],
  ] as const) {
    const ctx = context(source, filename);
    expect(jsBindingHasOpenWrites(ctx.lowerer, at(ctx.declarations, 0))).toBe(false);
    expect(ctx.resolve).not.toHaveBeenCalled();
    expect(ctx.typeOf).not.toHaveBeenCalled();
    expect(ctx.lowerer.jsBindingWritesByOwner.size).toBe(0);
  }
});
