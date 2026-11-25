import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { loadProgram } from "../src/frontend/program-node.js";
import * as ts from "../src/frontend/ts7/adapter.js";
import {
  mapType,
  noteScopeSensitiveMapping,
  ShapeRegistry,
  UnionRegistry,
  type TypeMapperCtx,
} from "../src/frontend/type-mapper.js";
import type { IrType } from "../src/ir/ir.js";

let directory: string;
let load: ReturnType<typeof loadProgram>;
const aliases = new Map<string, ts.Type>();

beforeAll(() => {
  directory = mkdtempSync(
    join(process.platform === "win32" ? tmpdir() : "/tmp", "scriptc-mapper-shared-memo-"),
  );
  const entry = join(directory, "input.ts");
  writeFileSync(
    entry,
    `
    export type Inner<T> = { value: T; label: string };
    export type Outer<T> = { inner: Inner<T>; tag: string };
    export type Plain = { tag: string; count: number };
  `,
  );
  load = loadProgram(entry);
  ts.walkPreorder(load.entry, (node) => {
    if (ts.isTypeAliasDeclaration(node))
      aliases.set(node.name.text, load.program.getTypeChecker().getTypeAtLocation(node.type));
  });
});
afterAll(() => {
  load?.dispose();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

const memoKey = (type: ts.Type): number => (type as { id: number }).id * 2;

/** One generic-instantiation binding scope: its own memo plus the lowerer's
 * shared memo, which every scope serves. `bound` is the answer this scope's
 * type parameter maps to, so the same checker type maps differently in
 * different scopes. */
function scope(shared: Map<number, IrType>, bound: IrType) {
  const own = new Map<number, IrType>();
  const ctx: TypeMapperCtx = {
    checker: load.program.getTypeChecker(),
    shapes: new ShapeRegistry(),
    unions: new UnionRegistry(),
    classNamer: (decl) => decl.name?.text ?? "anonymous",
    typeMemo: new Map(),
    typeMemoFor: () => own,
    typeMemoShared: shared,
    isStdlibFile: (sf) => load.program.isSourceFileDefaultLibrary(sf),
    isNpmFile: () => false,
    isExternalTypeFile: () => false,
    isProgramFile: (sf) => load.moduleOrder.includes(sf),
    resolveTypeParam: (t) => {
      if (!(t.flags & ts.TypeFlags.TypeParameter)) return null;
      noteScopeSensitiveMapping();
      return bound;
    },
  };
  return { own, ctx };
}

/** The field type `inner: Inner<T>` as Outer's own body mentions it — the
 * entry a scope's memo holds after mapping it from that scope's bindings. */
function outerInnerType(): ts.Type {
  const checker = load.program.getTypeChecker();
  const [property] = checker
    .getPropertiesOfType(aliases.get("Outer")!)
    .filter((prop) => ts.symbolName(prop) === "inner");
  if (property === undefined) throw new Error("Outer has no inner field");
  return checker.getTypeOfSymbol(property);
}

function fieldType(outer: IrType, name: string, ctx: TypeMapperCtx): IrType {
  if (outer.kind !== "record") throw new Error(`expected a record, got ${outer.kind}`);
  const field = ctx.shapes.get(outer.shapeId)!.fields.find((entry) => entry.name === name);
  if (field === undefined) throw new Error(`missing field ${name}`);
  return field.type;
}

/** The bug this guards: Outer embeds Inner's scope-specific answer, and a
 * nested scope-only memo hit must still keep Outer out of the shared memo —
 * otherwise the next instantiation is served the first one's representation. */
test("a nested scope-only memo hit keeps the parent out of the shared memo", () => {
  const shared = new Map<number, IrType>();
  const first = scope(shared, { kind: "f64" });
  // The scope already answered the field's type from its own bindings; the
  // shared memo does not hold it because that answer is scope-specific.
  const inner = { kind: "object", className: "Inner_f64" } as IrType;
  first.own.set(memoKey(outerInnerType()), inner);

  const outer = mapType(aliases.get("Outer")!, first.ctx)!;
  // The field took the scope's answer rather than mapping again...
  expect(fieldType(outer, "inner", first.ctx)).toBe(inner);
  // ...so Outer carries this scope's bindings and is not a shared answer.
  expect(shared.has(memoKey(aliases.get("Outer")!))).toBe(false);

  const second = scope(shared, { kind: "string" });
  const again = mapType(aliases.get("Outer")!, second.ctx)!;
  expect(fieldType(again, "inner", second.ctx)).not.toBe(inner);
});

test("a mapping that hits no scope entry still shares across scopes", () => {
  const shared = new Map<number, IrType>();
  const first = scope(shared, { kind: "f64" });
  const plain = mapType(aliases.get("Plain")!, first.ctx);
  expect(plain).not.toBeNull();
  expect(shared.get(memoKey(aliases.get("Plain")!))).toBe(plain);
  const second = scope(shared, { kind: "string" });
  expect(mapType(aliases.get("Plain")!, second.ctx)).toBe(plain);
});
