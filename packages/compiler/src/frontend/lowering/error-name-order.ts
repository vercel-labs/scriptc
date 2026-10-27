import * as ts from "../ts7/adapter.js";
import { isClassOwnEnumerableFieldName } from "../../ir/ir.js";
import type { ClassInfo } from "./lower-classes.js";

type ErrorClassLink = Pick<ClassInfo, "decl" | "ctor" | "paramProps"> & {
  base: ErrorClassLink | null;
};

/** The property key a member or element-access name spells statically:
 * an identifier, a quoted string, a number in its canonical spelling, or a
 * computed string literal. Null for other keys. */
function staticKeyText(name: ts.Node): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  if (ts.isNumericLiteral(name)) return String(Number(name.text));
  if (ts.isComputedPropertyName(name)) return staticKeyText(name.expression);
  return null;
}

/** Whether `node` is an assignment to `this.<name>` or `this["<name>"]`,
 * and the name. */
function thisAssignmentName(node: ts.Node): string | null {
  if (!ts.isBinaryExpression(node) || node.operatorToken.kind !== ts.SyntaxKind.EqualsToken)
    return null;
  const target = node.left;
  if (ts.isPropertyAccessExpression(target) && target.expression.kind === ts.SyntaxKind.ThisKeyword)
    return ts.isIdentifier(target.name) ? target.name.text : null;
  if (ts.isElementAccessExpression(target) && target.expression.kind === ts.SyntaxKind.ThisKeyword)
    return staticKeyText(target.argumentExpression);
  return null;
}

/** Where an Error subclass instance's own `name` sits among its fields when
 * a class of its chain gives it one during construction. A property's
 * position is fixed when it is created: a `name` field takes its place
 * among the fields (parameter properties first, then the declared ones),
 * and `this.name = ...` in a constructor follows the fields created so far,
 * including the ones that constructor created before it. The answer is the
 * field `name` follows, null when it precedes every field, and undefined
 * when no class of the chain sets it during construction. `fields` are the
 * instance's own enumerable fields. */
export function errorNameAfterField(
  info: ErrorClassLink,
  fields: ReadonlySet<string>,
): string | null | undefined {
  const chain: ErrorClassLink[] = [];
  for (let current: ErrorClassLink | null | undefined = info; current; current = current.base)
    if (current.decl) chain.unshift(current);
  const created = new Set<string>();
  let last: string | null = null;
  const create = (name: string): void => {
    if (!fields.has(name) || created.has(name)) return;
    created.add(name);
    last = name;
  };
  for (const link of chain) {
    for (const property of link.paramProps ?? []) create(property.name);
    for (const member of link.decl!.members.nodes) {
      if (!ts.isPropertyDeclaration(member)) continue;
      const key = staticKeyText(member.name);
      if (key === null) continue;
      if (
        member.modifiers?.nodes.some(
          (m) => m.kind === ts.SyntaxKind.StaticKeyword || m.kind === ts.SyntaxKind.DeclareKeyword,
        )
      )
        continue;
      if (key === "name") return last;
      create(key);
    }
    const body = link.ctor?.body;
    if (!body) continue;
    let found = false;
    ts.walkPreorder(body, (node) => {
      if (ts.isTypeNode(node)) return "skip";
      if (ts.isFunctionLike(node) && !ts.isArrowFunction(node)) return "skip";
      const name = thisAssignmentName(node);
      if (name === "name") {
        found = true;
        return "stop";
      }
      if (name !== null) create(name);
      return undefined;
    });
    if (found) return last;
  }
  return undefined;
}

/** The fields an Error subclass's own-property view lists. */
export function errorViewFields(fields: readonly { name: string }[]): Set<string> {
  return new Set(
    fields
      .map((field) => field.name)
      .filter(
        (name) => isClassOwnEnumerableFieldName(name) && name !== "name" && name !== "message",
      ),
  );
}
