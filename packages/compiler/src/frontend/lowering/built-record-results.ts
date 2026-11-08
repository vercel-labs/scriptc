/* A record a generic function builds key by key and returns as its declared
 * result type.
 *
 *     type Counts<Label extends string> = { [L in Label]: number } & {};
 *     function tally<Label extends string>(labels: readonly Label[]): Counts<Label> {
 *       const counts: Record<string, number> = {};
 *       for (const label of labels) counts[label] = 0;
 *       return counts as Counts<Label>;
 *     }
 *
 * Inside the body the checker keeps `Counts<Label>` symbolic, and an alias
 * of a mapped type has no form the type mapper can evaluate under the
 * instance's bindings, so the assertion has no target and the return refuses
 * the index-signature record (SC2002). Two facts name the target anyway:
 *
 *  - the asserted type is the very checker type the signature declares as
 *    its result (one type object, an inferred result included), and the
 *    assertion is the returned expression. The value the assertion makes is
 *    the function's result, so its type under the instance's bindings is the
 *    instance's result type, which every call that shares the instance
 *    agrees on (the instance key holds it);
 *  - the record cannot be observed apart from the result. It is a `const`
 *    of this function initialized with an object literal, every other use
 *    of the binding reads or writes a member of it, no closure sees it, and
 *    no `finally` block runs with it after the return. Nothing else holds
 *    the object, so the checked conversion the return applies (the one a
 *    non-generic `counts as { a: V }` takes: each declared member read by key
 *    and checked, the object's own keys and their order kept beside the
 *    record) cannot be told from Node's erased assertion. A declared member
 *    the object lacks throws the TypeError of every checked cast.
 *
 * Any other shape keeps the refusal: a record another holder can reach (a
 * parameter, a module binding, one stored or passed before the return)
 * would be copied while Node keeps one object, and an assertion to a type
 * other than the declared result has no instance type to take. */
import * as ts from "../ts7/adapter.js";
import { withoutParenthesesTypeWrappers } from "../outer-expressions.js";
import type { IrExpr, IrType } from "../../ir/ir.js";
import { shapeHasAccessorSlots } from "../../ir/ir.js";
import type { Lowerer } from "./lowerer.js";

/** The instance's result type, when `expr` (an assertion whose asserted type
 * did not map) returns a record this generic instance built as its declared
 * result type; null otherwise. The built record is a string-keyed dictionary
 * (`Record<string, V>`), held as a native index-signature record or, where
 * the program's dictionaries of that value type keep checked identity
 * (class-protocols.ts), as the checked-dynamic object. */
export function builtRecordResultType(
  lowerer: Lowerer,
  expr: ts.AsExpression | ts.TypeAssertion,
  inner: IrExpr,
  asserted: ts.Type,
): (IrType & { kind: "record" }) | null {
  if (lowerer.typeParamBindings === null || lowerer.ctx.inferReturn) return null;
  if (inner.type.kind === "record") {
    const source = lowerer.shapes.get(inner.type.shapeId);
    if (!source || source.tuple || source.indexValue === undefined || source.fields.length > 0)
      return null;
  } else if (inner.type.kind !== "dyn") return null;
  const result = lowerer.ctx.returnType;
  if (result.kind !== "record") return null;
  const target = lowerer.shapes.get(result.shapeId);
  if (!target || target.tuple || target.indexValue !== undefined || shapeHasAccessorSlots(target))
    return null;
  // The assertion is the returned expression.
  let returned: ts.Node = expr;
  while (returned.parent !== undefined && ts.isParenthesizedExpression(returned.parent))
    returned = returned.parent;
  const statement = returned.parent;
  if (statement === undefined || !ts.isReturnStatement(statement)) return null;
  let owner: ts.Node | undefined = statement.parent;
  while (owner !== undefined && !ts.isFunctionLike(owner)) owner = owner.parent;
  if (owner === undefined || !declaresResult(lowerer, owner, asserted)) return null;
  // The operand is a dictionary this function made and nothing else holds.
  const operand = withoutParenthesesTypeWrappers(expr.expression);
  if (!ts.isIdentifier(operand)) return null;
  const symbol = lowerer.resolveValueSymbol(operand);
  const declaration = symbol?.valueDeclaration;
  if (!symbol || !declaration || !ts.isVariableDeclaration(declaration)) return null;
  if (!ts.isIdentifier(declaration.name) || declaration.initializer === undefined) return null;
  if ((ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) === 0) return null;
  if (!ts.isObjectLiteralExpression(withoutParenthesesTypeWrappers(declaration.initializer)))
    return null;
  if (!isDictionary(lowerer, lowerer.typeOf(declaration.name))) return null;
  let home: ts.Node | undefined = declaration.parent;
  while (home !== undefined && !ts.isFunctionLike(home)) home = home.parent;
  if (home !== owner) return null;
  const body = (owner as ts.FunctionLikeDeclaration).body;
  if (body === undefined) return null;
  return onlyMemberUses(lowerer, body, owner, symbol, declaration.name) ? result : null;
}

/** A string-keyed dictionary type with no declared members. */
function isDictionary(lowerer: Lowerer, type: ts.Type): boolean {
  if ((type.flags & ts.TypeFlags.Object) === 0) return false;
  if (lowerer.checker.isArrayType(type) || lowerer.checker.isTupleType(type)) return false;
  if (lowerer.checker.getCallSignatures(type).length > 0) return false;
  if (lowerer.checker.getPropertiesOfType(type).length > 0) return false;
  return lowerer.checker
    .getIndexInfosOfType(type)
    .some((index) => (index.keyType.flags & ts.TypeFlags.String) !== 0);
}

/** Whether `asserted` is the type `fn` declares (or infers) as its result:
 * the same checker type, or for an async function the type its promise
 * settles with. */
function declaresResult(lowerer: Lowerer, fn: ts.Node, asserted: ts.Type): boolean {
  const signature = lowerer.checker.getSignatureFromDeclaration(fn as ts.SignatureDeclaration);
  if (!signature) return false;
  const declared = lowerer.checker.getReturnTypeOfSignature(signature);
  if (declared === asserted) return true;
  const isAsync =
    (fn as ts.FunctionLikeDeclaration).modifiers?.nodes.some(
      (modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword,
    ) === true;
  return isAsync && lowerer.checker.getAwaitedType(declared) === asserted;
}

/** Whether every reference to `symbol` in `body`, its declaration aside, is
 * a use that leaves the record with this function: the receiver of a member
 * read or write that is not called (`counts[k] = v`, `counts[k]`, also through
 * an asserted view, `(counts as W)[key] = v`), the right side of `in`, or the
 * returned operand of an assertion. A reference inside a nested function or
 * class is a capture, and one inside a `finally` block can run after a
 * return: both fail. */
function onlyMemberUses(
  lowerer: Lowerer,
  body: ts.Node,
  owner: ts.Node,
  symbol: ts.Symbol,
  declared: ts.Identifier,
): boolean {
  let sound = true;
  const visit = (node: ts.Node, captured: boolean, late: boolean): void => {
    if (!sound) return;
    if (ts.isIdentifier(node)) {
      if (node === declared || node.text !== declared.text || isPropertyName(node)) return;
      // `{ counts }` stores the record under its own name.
      const shorthand = node.parent !== undefined && ts.isShorthandPropertyAssignment(node.parent);
      if (!shorthand && lowerer.resolveValueSymbol(node) !== symbol) return;
      if (shorthand || captured || late || !memberUse(node)) sound = false;
      return;
    }
    const inner =
      captured ||
      (node !== owner &&
        (ts.isFunctionLike(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node)));
    if (ts.isTryStatement(node)) {
      visit(node.tryBlock, inner, late);
      if (node.catchClause) visit(node.catchClause, inner, late);
      if (node.finallyBlock) visit(node.finallyBlock, inner, true);
      return;
    }
    ts.forEachChild(node, (child) => visit(child, inner, late));
  };
  visit(body, false, false);
  return sound;
}

/** `name` spells a member (`o.name`, `{ name: v }`), not a reference. */
function isPropertyName(name: ts.Identifier): boolean {
  const parent = name.parent;
  if (parent === undefined) return false;
  if (ts.isPropertyAccessExpression(parent)) return parent.name === name;
  if (ts.isPropertyAssignment(parent)) return parent.name === name;
  return false;
}

/** A reference used as the receiver of an uncalled member access, as the
 * right side of `in`, or as the returned value, looking out through
 * parentheses, assertions, `satisfies` and `!`. */
function memberUse(reference: ts.Identifier): boolean {
  let value: ts.Node = reference;
  let parent = value.parent;
  while (
    parent !== undefined &&
    (ts.isParenthesizedExpression(parent) ||
      ts.isAsExpression(parent) ||
      ts.isTypeAssertion(parent) ||
      ts.isSatisfiesExpression(parent) ||
      ts.isNonNullExpression(parent))
  ) {
    value = parent;
    parent = value.parent;
  }
  if (parent === undefined) return false;
  if (ts.isReturnStatement(parent)) return true;
  if (ts.isBinaryExpression(parent))
    return parent.operatorToken.kind === ts.SyntaxKind.InKeyword && parent.right === value;
  if (!ts.isPropertyAccessExpression(parent) && !ts.isElementAccessExpression(parent)) return false;
  if (parent.expression !== value) return false;
  // A called member receives the record as `this`.
  let access: ts.Node = parent;
  let user = access.parent;
  while (user !== undefined && ts.isParenthesizedExpression(user)) {
    access = user;
    user = access.parent;
  }
  return !(
    user !== undefined &&
    ((ts.isCallExpression(user) && user.expression === access) ||
      (ts.isTaggedTemplateExpression(user) && user.tag === access))
  );
}
