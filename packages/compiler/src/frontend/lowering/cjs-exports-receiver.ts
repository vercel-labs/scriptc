/* A CommonJS export called through the module's own exports object
 * (`exports.f(x)`, `module.exports.f(x)`) whose function reads `this`.
 *
 * Node binds `this` to the exports object. The compiled module has no such
 * object: each export is a module global (cjs-exports-object.ts), so a call
 * of an export that may read `this` keeps a refusal. One style needs no
 * object, though: the module used as a namespace, where an export reaches
 * its siblings through the receiver and does nothing else with it,
 *
 *   exports.plan = function (o) { return exports.waits(o); };
 *   exports.waits = function (o) { return [this.waitFor(0, o)]; };
 *   exports.waitFor = function (attempt, o) { return o.base * attempt; };
 *
 * For that style the call passes a receiver built where it is made: an
 * object holding the current value of every export the module's functions
 * read through `this`. It is what the function would read from the exports
 * object, under the conditions this file proves from the module's source:
 *
 *   - every write of an export is a top-level statement `exports.name =
 *     value` (or `module.exports.name = value`), the object is never
 *     replaced, and it is used nowhere as a value: no code that runs during
 *     the call can change an export, so the values read at the call are the
 *     values the function would read;
 *   - up to the last of those statements the module's top-level code runs
 *     nothing of the module (it declares, assigns functions and literals,
 *     and requires other modules before its first export): every call finds
 *     every export assigned;
 *   - the function, and every export it calls through `this` in turn, uses
 *     `this` only to read `this.name`: it cannot write through the receiver,
 *     compare it or pass it on. It is not async and not a generator, and no
 *     arrow function or class inside it reads `this`, so no read happens
 *     after the call returned.
 *
 * A call of the same function with another receiver (detached, or through
 * `.call`) is compiled as before: the function body does not change. */
import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";
import { isCjsJsFile, locOf } from "../program.js";
import {
  cjsExportCallIgnoresThis,
  isCjsExportsIdentifier,
  isCjsModuleExports,
} from "./cjs-exports-object.js";
import { cjsExportValueByName } from "./cjs-inline-require.js";
import { isWriteTarget } from "./binding-analysis.js";
import { usesCjsTopLevelThis } from "./lower-node-module.js";
import { moduleExportIgnoresThis } from "./module-member-this.js";
import { DYN, STRING, type IrExpr } from "../../ir/ir.js";

/** How one function reads its own `this`. */
interface ThisReads {
  /** The names read as `this.name`. */
  names: string[];
  /** Those of them that are called: `this.name(...)`. */
  called: string[];
}

/** What the module's source shows of its exports object. */
export interface CjsExportsShape {
  /** The values each export is assigned, in source order of the first
   * assignment of each name. */
  writes: Map<string, ts.Expression[]>;
  /** The exports some function assigned to an export reads through `this`,
   * in the order of `writes`. */
  members: string[];
}

function withoutParentheses(node: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(node)) node = node.expression;
  return node;
}

/** Whether `access` is a target inside a destructuring assignment or the
 * variable of a for-in or for-of loop. */
function inAssignmentPattern(access: ts.Expression): boolean {
  let node: ts.Node = access;
  for (;;) {
    const parent: ts.Node | undefined = node.parent;
    if (parent === undefined) return false;
    if (
      ts.isParenthesizedExpression(parent) ||
      ts.isArrayLiteralExpression(parent) ||
      ts.isObjectLiteralExpression(parent) ||
      ts.isSpreadElement(parent) ||
      ts.isSpreadAssignment(parent) ||
      ts.isShorthandPropertyAssignment(parent) ||
      (ts.isPropertyAssignment(parent) && parent.initializer === node)
    ) {
      node = parent;
      continue;
    }
    if (ts.isBinaryExpression(parent))
      return (
        parent.left === node &&
        node !== access &&
        parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
      );
    if (ts.isForInStatement(parent) || ts.isForOfStatement(parent))
      return parent.initializer === node;
    return false;
  }
}

/** Whether `access` only reads its member. */
function readsMember(access: ts.PropertyAccessExpression): boolean {
  return !isWriteTarget(access) && !inAssignmentPattern(access);
}

/** Whether `access` is the callee of a call, which passes its object as the
 * receiver. */
function isCallee(access: ts.PropertyAccessExpression): boolean {
  let node: ts.Node = access;
  while (ts.isParenthesizedExpression(node.parent)) node = node.parent;
  const parent = node.parent;
  return (
    (ts.isCallExpression(parent) && parent.expression === node) ||
    (ts.isTaggedTemplateExpression(parent) && parent.tag === node)
  );
}

/** How `fn` reads its own `this`, or null when it does anything but read
 * `this.name` while it runs. */
function thisReadsOf(fn: ts.FunctionExpression): ThisReads | null {
  const names: string[] = [];
  const called: string[] = [];
  let sound = true;
  // `later` is set inside an arrow function or a class: its `this` reads
  // are the function's own, and may run after the call returned.
  const visit = (node: ts.Node, later: boolean): void => {
    if (!sound) return;
    if (node.kind === ts.SyntaxKind.ThisKeyword) {
      const access = node.parent;
      if (
        later ||
        !ts.isPropertyAccessExpression(access) ||
        access.expression !== node ||
        access.questionDotToken !== undefined ||
        !ts.isIdentifier(access.name) ||
        !readsMember(access)
      ) {
        sound = false;
        return;
      }
      if (!names.includes(access.name.text)) names.push(access.name.text);
      if (isCallee(access) && !called.includes(access.name.text)) called.push(access.name.text);
      return;
    }
    if (ts.isFunctionLike(node) && !ts.isArrowFunction(node)) {
      // Its own `this`; a computed member name is evaluated outside it.
      const name = (node as { name?: ts.Node }).name;
      if (name !== undefined && ts.isComputedPropertyName(name)) visit(name, later);
      return;
    }
    const inner = later || ts.isArrowFunction(node) || ts.isClassLikeDeclaration(node);
    ts.forEachChild(node, (child) => visit(child, inner));
  };
  for (const param of fn.parameters.nodes) visit(param, false);
  visit(fn.body, false);
  if (!sound) return null;
  if (names.length === 0) return { names, called };
  const suspends =
    fn.asteriskToken !== undefined ||
    (fn.modifiers?.nodes.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) ?? false);
  return suspends ? null : { names, called };
}

/** A value that is no function, whatever it is called with. */
function isPlainData(value: ts.Expression): boolean {
  return (
    ts.isNumericLiteral(value) ||
    ts.isStringLiteral(value) ||
    ts.isNoSubstitutionTemplateLiteral(value) ||
    ts.isRegularExpressionLiteral(value) ||
    ts.isObjectLiteralExpression(value) ||
    ts.isArrayLiteralExpression(value) ||
    value.kind === ts.SyntaxKind.TrueKeyword ||
    value.kind === ts.SyntaxKind.FalseKeyword ||
    value.kind === ts.SyntaxKind.NullKeyword
  );
}

/** Whether evaluating `node` runs no code: a function, a name, a literal,
 * or an object or array literal of such values. */
function runsNoCode(node: ts.Expression): boolean {
  const value = withoutParentheses(node);
  if (ts.isFunctionExpression(value) || ts.isArrowFunction(value) || ts.isIdentifier(value))
    return true;
  if (isPlainData(value)) {
    if (ts.isArrayLiteralExpression(value))
      return value.elements.nodes.every(
        (element) =>
          !ts.isSpreadElement(element) && !ts.isOmittedExpression(element) && runsNoCode(element),
      );
    if (ts.isObjectLiteralExpression(value))
      return value.properties.nodes.every((property) => {
        if (ts.isShorthandPropertyAssignment(property)) return true;
        if (ts.isSpreadAssignment(property) || ts.isComputedPropertyName(property.name))
          return false;
        return !ts.isPropertyAssignment(property) || runsNoCode(property.initializer);
      });
    return true;
  }
  return (
    ts.isPrefixUnaryExpression(value) &&
    value.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(value.operand)
  );
}

/** `require("name")`, or a member read of it. */
function isLiteralRequire(node: ts.Expression): boolean {
  let value = withoutParentheses(node);
  while (ts.isPropertyAccessExpression(value)) value = withoutParentheses(value.expression);
  return (
    ts.isCallExpression(value) &&
    ts.isIdentifier(value.expression) &&
    value.expression.text === "require" &&
    value.arguments.nodes.length === 1 &&
    ts.isStringLiteral(value.arguments.nodes[0]!)
  );
}

/** Whether a top-level statement runs no code of its own module. `write`
 * marks an export assignment. A `require` counts only before the first
 * export assignment (`early`): the module it loads can then reach none of
 * this module's functions. */
function runsNothingOfTheModule(statement: ts.Statement, write: boolean, early: boolean): boolean {
  if (ts.isFunctionDeclaration(statement) || ts.isEmptyStatement(statement)) return true;
  if (ts.isExpressionStatement(statement)) {
    const expr = statement.expression;
    if (write) return ts.isBinaryExpression(expr) && runsNoCode(expr.right);
    return ts.isStringLiteral(expr) || (early && isLiteralRequire(expr));
  }
  if (ts.isVariableStatement(statement))
    return statement.declarationList.declarations.nodes.every(
      (declaration) =>
        declaration.initializer === undefined ||
        runsNoCode(declaration.initializer) ||
        (early && isLiteralRequire(declaration.initializer)),
    );
  return false;
}

/** The module's exports as its source assigns them, or null when the source
 * does not show every write of the exports object. Cached per file on the
 * lowerer: the answer depends only on the module's source. */
function exportsShapeOf(lowerer: Lowerer, sf: ts.SourceFile): CjsExportsShape | null {
  const cached = lowerer.cjsExportsShapes.get(sf);
  if (cached !== undefined) return cached;
  const shape = computeExportsShape(lowerer, sf);
  lowerer.cjsExportsShapes.set(sf, shape);
  return shape;
}

function computeExportsShape(lowerer: Lowerer, sf: ts.SourceFile): CjsExportsShape | null {
  if (!isCjsJsFile(sf, lowerer.program)) return null;
  // Top-level `this` is the exports object too, and it is used as a value.
  if (usesCjsTopLevelThis(lowerer, sf)) return null;
  const writes = new Map<string, ts.Expression[]>();
  const writeStatements = new Set<ts.Node>();
  let shown = true;
  ts.walkPreorder(sf, (node) => {
    if (!shown) return "stop";
    let object: ts.Expression | null = null;
    if (ts.isIdentifier(node) && node.text === "exports") {
      const parent = node.parent;
      // A member, property or declaration that is merely named `exports`.
      if ((parent as { name?: ts.Node }).name === node && !ts.isShorthandPropertyAssignment(parent))
        return undefined;
      if (isCjsExportsIdentifier(lowerer, node)) object = node;
    } else if (ts.isPropertyAccessExpression(node) && isCjsModuleExports(lowerer, node)) {
      object = node;
    }
    if (object === null) return undefined;
    const access = object.parent;
    if (
      !ts.isPropertyAccessExpression(access) ||
      access.expression !== object ||
      access.questionDotToken !== undefined ||
      !ts.isIdentifier(access.name)
    ) {
      shown = false;
      return "stop";
    }
    const assignment = access.parent;
    if (
      ts.isBinaryExpression(assignment) &&
      assignment.left === access &&
      assignment.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isExpressionStatement(assignment.parent) &&
      assignment.parent.parent === sf
    ) {
      const values = writes.get(access.name.text);
      if (values === undefined) writes.set(access.name.text, [assignment.right]);
      else values.push(assignment.right);
      writeStatements.add(assignment.parent);
    } else if (!readsMember(access)) {
      shown = false;
      return "stop";
    }
    return undefined;
  });
  if (!shown || writes.size === 0) return null;
  // Up to its last export assignment the module's top-level code runs
  // nothing of the module: no call can find an export still unassigned.
  const statements = sf.statements.nodes;
  let last = -1;
  let first = statements.length;
  for (const [i, statement] of statements.entries()) {
    if (!writeStatements.has(statement)) continue;
    last = i;
    if (i < first) first = i;
  }
  for (let i = 0; i <= last; i++) {
    const statement = statements[i]!;
    if (!runsNothingOfTheModule(statement, writeStatements.has(statement), i < first)) return null;
  }
  const read = new Set<string>();
  for (const values of writes.values()) {
    for (const value of values) {
      const fn = withoutParentheses(value);
      if (!ts.isFunctionExpression(fn)) continue;
      for (const name of thisReadsOf(fn)?.names ?? []) read.add(name);
    }
  }
  return { writes, members: [...writes.keys()].filter((name) => read.has(name)) };
}

/** Whether every function the module assigns to its export `name` reads
 * `this` only as `this.member`, and the same holds for every export such a
 * function calls through `this`. */
function exportReadsOnlyMembers(
  lowerer: Lowerer,
  sf: ts.SourceFile,
  shape: CjsExportsShape,
  name: string,
  visiting: ReadonlySet<string>,
): boolean {
  const values = shape.writes.get(name);
  if (values === undefined) return false;
  const inner = new Set(visiting).add(name);
  for (const assigned of values) {
    const value = withoutParentheses(assigned);
    if (ts.isFunctionExpression(value)) {
      const reads = thisReadsOf(value);
      if (reads === null) return false;
      for (const callee of reads.called) {
        if (inner.has(callee)) continue;
        if (cjsExportCallIgnoresThis(lowerer, sf, callee)) continue;
        if (!exportReadsOnlyMembers(lowerer, sf, shape, callee, inner)) return false;
      }
      continue;
    }
    if (isPlainData(value) || ts.isArrowFunction(value)) continue;
    if (!moduleExportIgnoresThis(lowerer, value)) return false;
  }
  return true;
}

/** The exports a receiver for a call of the module's export `name` through
 * its exports object holds, or null when the call needs the exports object
 * itself. */
export function cjsExportsReceiverMembers(
  lowerer: Lowerer,
  sf: ts.SourceFile,
  name: string,
): string[] | null {
  const shape = exportsShapeOf(lowerer, sf);
  if (shape === null) return null;
  return exportReadsOnlyMembers(lowerer, sf, shape, name, new Set()) ? shape.members : null;
}

/** The receiver of `exports.name(...)` inside the module `sf`: an object
 * with the current values of the exports the module's functions read
 * through `this`. Null when the module is not written in that style, or one
 * of those values has no dynamic form. */
export function lowerCjsExportsReceiver(
  lowerer: Lowerer,
  call: ts.CallExpression,
  sf: ts.SourceFile,
  name: string,
): IrExpr | null {
  const members = cjsExportsReceiverMembers(lowerer, sf, name);
  if (members === null) return null;
  const loc = locOf(call);
  const fields: { key: IrExpr; value: IrExpr }[] = [];
  for (const member of members) {
    const value = cjsExportValueByName(lowerer, sf, member, call);
    if (value === null) return null;
    if (value.type.kind !== "dyn" && !lowerer.dynConvertible(value.type)) return null;
    fields.push({
      key: { kind: "strLit", value: member, type: STRING, loc },
      value: value.type.kind === "dyn" ? value : lowerer.coerceToExpected(value, DYN),
    });
  }
  return { kind: "dynObjLit", fields, type: DYN, loc };
}
