import * as ts from "../ts7/adapter.js";
import { isClassOwnEnumerableFieldName } from "../../ir/ir.js";
import type { ClassInfo } from "./lower-classes.js";

/* Object.freeze, Object.seal and Object.preventExtensions do not appear
 * here: they never create or remove a property, and a class instance keeps
 * its integrity state outside the field layout. A statically typed call
 * sets the instance's CLASS_ATTRIBUTES word (class-attributes.ts), which
 * TypeScript classes use with the same fixed layouts; through an untyped
 * value the runtime refuses the operation on any class instance
 * (scr_dyn_class_integrity_fence). Lifting that fence must revisit this. */

/** Reflection that can remove any property. */
const PROPERTY_REFLECTION = new Set(["deleteProperty"]);

/** `Reflect.deleteProperty({ ... }, key)` applies to a new literal, which
 * is not a class instance. */
function freshLiteralArgument(callee: ts.PropertyAccessExpression): boolean {
  const call = callee.parent;
  if (!ts.isCallExpression(call) || call.expression !== callee) return false;
  let argument = call.arguments.nodes[0];
  while (argument && ts.isParenthesizedExpression(argument)) argument = argument.expression;
  return (
    argument !== undefined &&
    (ts.isObjectLiteralExpression(argument) || ts.isArrayLiteralExpression(argument))
  );
}

/** Property names that a `delete` in `files` can remove, or null when a
 * delete with a computed key or a reflective removal can remove any name. */
export function deletedPropertyNames(files: readonly ts.SourceFile[]): Set<string> | null {
  const names = new Set<string>();
  let any = false;
  for (const file of files)
    ts.walkPreorder(file, (node) => {
      if (any) return "stop";
      if (
        ts.isPropertyAccessExpression(node) &&
        PROPERTY_REFLECTION.has(node.name.text) &&
        !freshLiteralArgument(node)
      ) {
        any = true;
        return "stop";
      }
      if (!ts.isDeleteExpression(node)) return undefined;
      let target = node.expression;
      while (ts.isParenthesizedExpression(target)) target = target.expression;
      if (ts.isPropertyAccessExpression(target)) names.add(target.name.text);
      else if (
        ts.isElementAccessExpression(target) &&
        (ts.isStringLiteralLike(target.argumentExpression) ||
          ts.isNumericLiteral(target.argumentExpression))
      )
        names.add(target.argumentExpression.text);
      else any = true;
      return undefined;
    });
  return any ? null : names;
}

/** Whether `node` reads or passes `this` or `super`. */
function usesReceiver(node: ts.Node): boolean {
  let found = false;
  ts.walkPreorder(node, (part) => {
    if (part.kind === ts.SyntaxKind.ThisKeyword || part.kind === ts.SyntaxKind.SuperKeyword) {
      found = true;
      return "stop";
    }
    return undefined;
  });
  return found;
}

/** The field a statement `this.name = value` creates when `value` does not
 * use the receiver, or null for any other statement. */
function receiverFreeFieldAssignment(statement: ts.Statement): string | null {
  if (!ts.isExpressionStatement(statement)) return null;
  const assignment = statement.expression;
  if (
    !ts.isBinaryExpression(assignment) ||
    assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
    !ts.isPropertyAccessExpression(assignment.left) ||
    assignment.left.expression.kind !== ts.SyntaxKind.ThisKeyword ||
    usesReceiver(assignment.right)
  )
    return null;
  return assignment.left.name.text;
}

export interface Construction {
  /** Fields created before any code could observe the instance. */
  created: Set<string>;
  /** No code could observe the instance before construction finished. */
  sealed: boolean;
}

/** The fields a class's construction creates before the instance can be
 * observed: field declarations and top-level `this.name = value`
 * statements whose values do not use the receiver, up to the first
 * statement that uses `this` or `super` in any other way. A subclass
 * continues its base's sequence (`base`) only when the whole base
 * construction kept the instance unobserved. `isField` tells fields from
 * names whose assignment runs a setter or adds a property. Null when the
 * constructor's shape is not analyzed. */
export function constructionPrefix(
  decl: ts.ClassDeclaration | ts.ClassExpression,
  base: Construction | null,
  isField: (name: string) => boolean,
): Construction | null {
  const created = new Set(base?.created ?? []);
  let sealed = base?.sealed ?? true;
  const ctor = decl.members.nodes.find(
    (member): member is ts.ConstructorDeclaration =>
      ts.isConstructorDeclaration(member) && member.body !== undefined,
  );
  if (ctor?.parameters?.nodes.some((parameter) => usesReceiver(parameter))) sealed = false;
  const statements = ctor?.body?.statements?.nodes ?? [];
  // A derived constructor's statements before super() cannot reach the
  // instance; the field declarations run when super() returns.
  let at = 0;
  if (base && ctor) {
    const superAt = statements.findIndex(
      (statement) =>
        ts.isExpressionStatement(statement) &&
        ts.isCallExpression(statement.expression) &&
        statement.expression.expression.kind === ts.SyntaxKind.SuperKeyword,
    );
    if (superAt < 0) return null;
    const call = (statements[superAt] as ts.ExpressionStatement).expression as ts.CallExpression;
    if (call.arguments.nodes.some(usesReceiver)) sealed = false;
    at = superAt + 1;
  }
  for (const member of decl.members.nodes) {
    if (!ts.isPropertyDeclaration(member) || !ts.isIdentifier(member.name)) continue;
    if (member.modifiers?.nodes.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword))
      continue;
    if (member.initializer && usesReceiver(member.initializer)) sealed = false;
    if (sealed) created.add(member.name.text);
  }
  for (const statement of statements.slice(at)) {
    if (!sealed) break;
    // A name that is not a field runs a setter or adds a property bag
    // entry, either of which can observe the instance.
    const name = receiverFreeFieldAssignment(statement);
    if (name !== null && isField(name)) created.add(name);
    else if (name !== null || usesReceiver(statement) || ts.isReturnStatement(statement))
      sealed = false;
  }
  return { created, sealed };
}

/** The names of the getters and setters among a class's own methods. */
export function accessorNames(methods: Iterable<string>): Set<string> {
  const names = new Set<string>();
  for (const name of methods)
    if (name.startsWith("get:") || name.startsWith("set:")) names.add(name.slice(4));
  return names;
}

/** Whether one of `accessors` can intercept an assignment the base
 * constructions make: a base constructor's `this.name = value` runs a
 * subclass accessor of that name instead of creating the field. Only field
 * names can reach the created prefix; any other assignment already ends
 * it. */
export function accessorInterceptsBase(accessors: ReadonlySet<string>, base: ClassInfo): boolean {
  for (const name of accessors) if (base.fields.has(name)) return true;
  return false;
}

/** Whether an accessor that instances of `info` inherit or declare shares
 * a name with one of their fields. Such a field and accessor disagree on
 * what the instance's property is; any other accessor lives on the
 * prototype beside the fields and never touches the layout. */
function accessorShadowsField(info: ClassInfo): boolean {
  for (let current: ClassInfo | null = info; current; current = current.base) {
    if (current.def.runtime) break;
    for (const name of accessorNames(current.methods.keys()))
      if (info.fields.has(name)) return true;
  }
  return false;
}

/** `constructionPrefix` for a collected class and its bases. */
export function construction(info: ClassInfo): Construction | null {
  if (!info.decl) return null;
  let base: Construction | null = null;
  if (info.base) {
    base = construction(info.base);
    if (!base) return null;
    if (accessorInterceptsBase(accessorNames(info.methods.keys()), info.base))
      base = { created: base.created, sealed: false };
  }
  return constructionPrefix(info.decl, base, (name) => info.fields.has(name));
}

/** Whether every class in the family under `root` creates all of its
 * enumerable fields before its instances can be observed, and no field
 * name can be deleted. Such fields exist for the instance's whole life in
 * layout order, as TypeScript fields do, so their writes need no creation
 * tracking. */
export function fixedFieldFamily(root: ClassInfo, deleted: Set<string> | null): boolean {
  if (deleted === null) return false;
  const fixed = (info: ClassInfo): boolean => {
    if (accessorShadowsField(info)) return false;
    const built = construction(info);
    if (!built) return false;
    for (const field of info.fieldOrder) {
      if (!isClassOwnEnumerableFieldName(field.name)) continue;
      if (!built.created.has(field.name) || deleted.has(field.name)) return false;
    }
    return info.subclasses.every(fixed);
  };
  return fixed(root);
}
