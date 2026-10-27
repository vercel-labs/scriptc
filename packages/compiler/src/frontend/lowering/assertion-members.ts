/* Members a type assertion attaches to record values. */
import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";
import { type IrType, typeEquals } from "../../ir/ir.js";
import { hostsAll } from "./expressions/hosted-narrowing.js";

/** `route as Route & { order: number; internal: boolean }` followed by
 * `view.internal = true` adds a property to the very object `route`
 * names: Node has no layouts, so every later read of `route` (its JSON,
 * its keys, a spread) sees the member. Native records are closed structs,
 * and the asserted intersection maps to a different struct, so neither a
 * conversion (a copy that severs the write from `route`) nor an erasure
 * (a struct without the slot) is faithful.
 *
 * This pass finds such assertions before any body lowers and gives each
 * record arm of the operand's type the asserted members it does not
 * declare, as optional fields. Values the program builds hold them absent,
 * which is invisible to every key surface (`in`, Object.keys, JSON,
 * inspect, spread). The asserted type then refines the stored arms
 * instead of naming new ones (hosted-narrowing.ts), so the assertion keeps
 * the value and its writes land in the stored object.
 *
 * Only the plain form qualifies: one intersection whose constituents are
 * the operand's own type and type literals of required property
 * signatures, over plain data types (object types, aliases and interfaces;
 * not classes or the standard library's types). Arms that are tuples or
 * carry an index signature, members whose type does not map, and members
 * two assertions type differently are left alone: those assertions keep
 * their exact-shape diagnostics. Assertions whose operand already declares
 * every member are skipped before any type maps, so programs without the
 * form intern exactly the types they did before. */
export function extendAssertedRecordMembers(
  lowerer: Lowerer,
  files: readonly ts.SourceFile[],
): void {
  const additions = new Map<string, Map<string, IrType>>();
  const conflicts = new Set<string>();
  const consider = (node: ts.AsExpression | ts.TypeAssertion): void => {
    let typeNode: ts.TypeNode = node.type;
    while (ts.isParenthesizedTypeNode(typeNode)) typeNode = typeNode.type;
    if (!ts.isIntersectionTypeNode(typeNode)) return;
    const parts = typeNode.types.nodes;
    const literals = parts.filter((p) => ts.isTypeLiteralNode(p));
    const bases = parts.filter((p) => !ts.isTypeLiteralNode(p));
    if (literals.length === 0 || bases.length !== 1) return;
    const memberNodes: { name: string; type: ts.TypeNode }[] = [];
    for (const literal of literals) {
      if (!ts.isTypeLiteralNode(literal)) return;
      for (const member of literal.members.nodes) {
        // A required member: the form that writes through the view. An
        // optional one only reads, and keeps its exact-shape fence.
        if (!ts.isPropertySignatureDeclaration(member) || !member.type || member.questionToken)
          return;
        const name = ts.isIdentifier(member.name)
          ? member.name.text
          : ts.isStringLiteral(member.name)
            ? member.name.text
            : null;
        if (name === null || name.startsWith("%")) return;
        memberNodes.push({ name, type: member.type });
      }
    }
    // Checker-only gate first: an assertion every constituent of whose
    // operand type already declares the members (`e as Expr & { kind:
    // "mul" }`, the refinement idiom) attaches nothing, and mapping its
    // types here would intern them out of the usual order.
    const operandTs = lowerer.typeOf(node.expression);
    const constituents = operandTs.isUnionType() ? ts.constituentTypes(operandTs) : [operandTs];
    const declares = (t: ts.Type, name: string): boolean =>
      lowerer.checker.getPropertyOfType(t, name) !== undefined;
    if (constituents.every((t) => memberNodes.every((m) => declares(t, m.name)))) return;
    // Plain data types only: object literal types, aliases and interfaces
    // (not classes, and not the standard library's types).
    const dataType = (t: ts.Type): boolean => {
      const symbol = t.getAliasSymbol() ?? t.getSymbol();
      return (
        !!symbol &&
        (symbol.flags & ts.SymbolFlags.Class) === 0 &&
        symbol.declarations.length > 0 &&
        symbol.declarations.every(
          (d) =>
            !lowerer.isStdlibFile(ts.getSourceFileOfNode(d)) &&
            (ts.isTypeLiteralNode(d) ||
              ts.isInterfaceDeclaration(d) ||
              ts.isTypeAliasDeclaration(d)),
        )
      );
    };
    if (!constituents.every(dataType)) return;
    const operand = lowerer.mapTypeOf(operandTs);
    const base = lowerer.mapTypeOf(lowerer.checker.getTypeFromTypeNode(bases[0]!));
    if (!operand || !base || !typeEquals(operand, base)) return;
    const arms =
      operand.kind === "union" ? (lowerer.unions.get(operand.unionId)?.arms ?? []) : [operand];
    if (arms.length === 0) return;
    const shapeIds: string[] = [];
    for (const arm of arms) {
      if (arm.kind !== "record") return;
      const shape = lowerer.shapes.get(arm.shapeId);
      if (!shape || shape.tuple || shape.indexValue) return;
      shapeIds.push(arm.shapeId);
    }
    const members: { name: string; type: IrType }[] = [];
    for (const { name, type } of memberNodes) {
      if (shapeIds.every((id) => lowerer.shapes.get(id)!.fields.some((f) => f.name === name)))
        continue;
      const mapped = lowerer.mapTypeOf(lowerer.checker.getTypeFromTypeNode(type));
      if (!mapped || mapped.kind === "void") return;
      const optional = lowerer.withUndefinedArmOf(mapped);
      if (!optional) return;
      members.push({ name, type: optional });
    }
    for (const shapeId of shapeIds) {
      const shape = lowerer.shapes.get(shapeId)!;
      for (const member of members) {
        if (shape.fields.some((f) => f.name === member.name)) continue;
        let added = additions.get(shapeId);
        if (!added) additions.set(shapeId, (added = new Map()));
        const prior = added.get(member.name);
        if (prior && !typeEquals(prior, member.type)) conflicts.add(`${shapeId}:${member.name}`);
        else added.set(member.name, member.type);
      }
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isAsExpression(node) || ts.isTypeAssertion(node)) consider(node);
    ts.forEachChild(node, visit);
  };
  for (const sf of files) {
    if (sf.isDeclarationFile) continue;
    // Cheap text gate: the form needs an intersection with a type literal.
    if (!/&\s*\{/.test(sf.text)) continue;
    visit(sf);
  }
  for (const [shapeId, added] of additions) {
    const extra = [...added]
      .filter(([name]) => !conflicts.has(`${shapeId}:${name}`))
      .map(([name, type]) => ({ name, type }));
    lowerer.shapes.extendShape(shapeId, extra);
  }
  if (additions.size > 0) keepStoredTypeOfAssertedGlobals(lowerer, files);
}

/** A module-level `const view = value as T & { member: X }` binding keeps
 * the stored type of `value` once the members are attached, exactly as a
 * local binding does (lowerVarDecl): the assertion keeps the object, and
 * writes through the binding must reach it. Globals took their checker
 * (or annotated) type during collection, before the members existed; an
 * annotation the stored type hosts gives way to it the same way. */
function keepStoredTypeOfAssertedGlobals(lowerer: Lowerer, files: readonly ts.SourceFile[]): void {
  for (const sf of files) {
    if (sf.isDeclarationFile) continue;
    for (const statement of sf.statements.nodes) {
      if (!ts.isVariableStatement(statement)) continue;
      if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0) continue;
      for (const decl of statement.declarationList.declarations.nodes) {
        if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
        let init: ts.Expression = decl.initializer;
        while (ts.isParenthesizedExpression(init)) init = init.expression;
        if (!ts.isAsExpression(init) && !ts.isTypeAssertion(init)) continue;
        const global = lowerer.globalOf(decl.name);
        const stored = lowerer.mapTypeOf(lowerer.typeOf(init.expression));
        if (!global || !stored || (stored.kind !== "union" && stored.kind !== "record")) continue;
        if (hostsAll(lowerer, stored, global.type)) global.type = stored;
      }
    }
  }
}
