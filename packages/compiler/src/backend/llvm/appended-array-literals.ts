/* Empty array literals that are about to receive elements.
 *
 * These construct through scr_arr_new_small / scr_arr_new_ops_small, which
 * keep the first slots in the array's own block. Reserving slots for every
 * empty literal would grow the arrays that stay empty (`cond ? xs : []`,
 * `?? []`, an empty flatMap result), so reserve only where the literal
 * initializes storage that the module appends to: a local or global binding that is a push/unshift/splice
 * receiver or an indexed-write target, or a class or record field that is
 * one directly or through a binding read from it. The choice never changes
 * behavior. */

import type { IrExpr, IrModule, IrStmt } from "../../ir/ir.js";
import { eachNodeOfKinds, type IrNodeIndex, type IrNodeKind } from "../../ir/node-index.js";

const APPENDING_METHODS: ReadonlySet<string> = new Set([
  "push",
  "pushSpread",
  "unshift",
  "unshiftSpread",
  "splice",
  "spliceInsert",
]);

function isEmptyLiteral(e: IrExpr): boolean {
  return (
    e.kind === "arrayLit" &&
    e.elems.length === 0 &&
    e.capacity === undefined &&
    e.type.kind === "array"
  );
}

/** The nodes that name an appended binding or field, and the stores that
 * initialize one. */
const TARGET_KINDS: readonly IrNodeKind[] = [
  "arrIntrinsic",
  "assignExpr",
  "arraySet",
  "varDecl",
  "assign",
];
const STORE_KINDS: readonly IrNodeKind[] = [
  "assignExpr",
  "varDecl",
  "assign",
  "fieldSet",
  "recordSet",
];

export function findAppendedArrayLiterals(
  module: IrModule,
  index?: IrNodeIndex,
): ReadonlySet<IrExpr> {
  // Bindings are function-scoped by id; module globals are shared.
  const localsOf = new Map<string, ReadonlySet<string>>();
  for (const fn of module.functions) {
    localsOf.set(
      fn.name,
      new Set([...fn.locals.map((local) => local.id), ...fn.params.map((p) => p.localId)]),
    );
  }
  const bindingKey = (fn: string, localId: string): string =>
    localsOf.get(fn)?.has(localId) ? `${fn}\0${localId}` : localId;
  const fieldKey = (owner: string, field: string): string => `${owner}.${field}`;

  const fieldOf = (e: IrExpr | null): string | null =>
    e?.kind === "fieldGet"
      ? fieldKey(e.className, e.field)
      : e?.kind === "recordGet"
        ? fieldKey(e.shapeId, e.field)
        : null;
  const appendedBindings = new Set<string>();
  const appendedFields = new Set<string>();
  // Bindings that hold a field's array (`const d = this.d; d.push(x)`, and
  // the receiver temporaries the frontend introduces) append to the field.
  const fieldAliases = new Map<string, string[]>();
  const noteAlias = (fn: string, localId: string, value: IrExpr | null): void => {
    const field = fieldOf(value);
    if (field === null) return;
    const key = bindingKey(fn, localId);
    fieldAliases.set(key, [...(fieldAliases.get(key) ?? []), field]);
  };
  const noteTarget = (fn: string, target: IrExpr): void => {
    if (target.kind === "varRef") appendedBindings.add(bindingKey(fn, target.localId));
    const field = fieldOf(target);
    if (field !== null) appendedFields.add(field);
  };
  const targets = index?.scan(TARGET_KINDS);
  for (const fn of module.functions) {
    eachNodeOfKinds(fn, targets, (node) => {
      if (node.kind === "arrIntrinsic" && APPENDING_METHODS.has(node.method))
        noteTarget(fn.name, node.receiver);
      else if (node.kind === "assignExpr") noteAlias(fn.name, node.localId, node.value);
      else if (node.kind === "arraySet") noteTarget(fn.name, node.arr);
      else if (node.kind === "varDecl") noteAlias(fn.name, node.localId, node.init);
      else if (node.kind === "assign") noteAlias(fn.name, node.localId, node.value);
    });
  }
  for (const binding of appendedBindings)
    for (const field of fieldAliases.get(binding) ?? []) appendedFields.add(field);

  const result = new Set<IrExpr>();
  if (appendedBindings.size === 0 && appendedFields.size === 0) return result;
  const consider = (value: IrExpr | null, appended: boolean): void => {
    if (value && appended && isEmptyLiteral(value)) result.add(value);
  };
  const stores = index?.scan(STORE_KINDS);
  for (const fn of module.functions) {
    const binding = (localId: string): boolean =>
      appendedBindings.has(bindingKey(fn.name, localId));
    eachNodeOfKinds(fn, stores, (node) => {
      if (node.kind === "assignExpr") consider(node.value, binding(node.localId));
      else if (node.kind === "varDecl") consider(node.init, binding(node.localId));
      else if (node.kind === "assign") consider(node.value, binding(node.localId));
      else if (node.kind === "fieldSet")
        consider(node.value, appendedFields.has(fieldKey(node.className, node.field)));
      else if (node.kind === "recordSet")
        consider(node.value, appendedFields.has(fieldKey(node.shapeId, node.field)));
    });
  }
  return result;
}

/** `const xs = []` directly followed by a capacity hint for `xs` (an
 * `arraySetLength` with `reserve`) whose length reads only literals and
 * other locals: the literal can be constructed with that capacity, and the
 * hint then has nothing left to do. */
export function reservedArrayLength(
  stmts: readonly IrStmt[],
  i: number,
): { literal: IrExpr; hint: IrStmt & { kind: "arraySetLength" } } | null {
  const decl = stmts[i];
  const next = stmts[i + 1];
  if (decl?.kind !== "varDecl" || decl.init === null || !isEmptyLiteral(decl.init)) return null;
  if (next?.kind !== "arraySetLength" || next.reserve !== true) return null;
  if (next.arr.kind !== "varRef" || next.arr.localId !== decl.localId) return null;
  return plainLength(next.length, decl.localId) ? { literal: decl.init, hint: next } : null;
}

function plainLength(e: IrExpr, array: string): boolean {
  switch (e.kind) {
    case "numLit":
      return true;
    case "varRef":
      return e.localId !== array;
    case "bin":
      return plainLength(e.left, array) && plainLength(e.right, array);
    case "ternary":
      return (
        plainLength(e.cond, array) && plainLength(e.then, array) && plainLength(e.else_, array)
      );
    default:
      return false;
  }
}
