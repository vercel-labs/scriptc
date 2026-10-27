/* TypeScript's UMD module emit in a compiled package: the module body is a
 * factory function that the wrapper calls with the CommonJS module's own
 * `require` and `exports`.
 *
 *   (function (factory) {
 *       if (typeof module === "object" && typeof module.exports === "object") {
 *           var v = factory(require, exports);
 *           if (v !== undefined) module.exports = v;
 *       }
 *       else if (typeof define === "function" && define.amd) {
 *           define(["require", "exports", "./dep"], factory);
 *       }
 *   })(function (require, exports) {
 *       "use strict";
 *       const dep = require("./dep");
 *       exports.f = f;
 *   });
 *
 * Under Node the CommonJS branch runs: the factory body runs once with the
 * module's `require` and `exports`, and a body without a `return` leaves
 * `module.exports` as it was. That is the module's own body, so the wrapper
 * is blanked out (line breaks kept, so positions stay) and the body runs at
 * the module's top level, where its requires and export assignments are the
 * module's own.
 *
 * Accepted: the wrapper is the file's only statement, the wrapper's body is
 * exactly the emit above (so dropping it drops nothing else), the factory's
 * parameters are exactly `require` and `exports`, and the body uses no
 * `return` or `arguments` of its own. `this` in the body is the factory's
 * receiver, not the module's: it may appear only in TypeScript's helper
 * probes (`this && this.__importDefault`), which find no helper on either
 * receiver. Any other shape keeps the original text. */
import * as ts from "./ts7/syntax.js";
import { tokenStartOfNode } from "./ts7/node-functions.js";
import { applyEdits } from "./npm-static-bundled-chunks.js";

/** True when the text may hold a UMD wrapper (a cheap probe). */
export function mayHoldUmdWrapper(source: string): boolean {
  return source.includes("define.amd") && source.includes("(require, exports)");
}

/** The module text with a UMD wrapper's factory body at the top level, or
 * null when the file is not one. */
export function unwrapUmdFactory(sf: ts.SourceFile): string | null {
  const stmts = sf.statements.nodes;
  if (stmts.length !== 1) return null;
  const stmt = stmts[0]!;
  if (!ts.isExpressionStatement(stmt) || !ts.isCallExpression(stmt.expression)) return null;
  const call = stmt.expression;
  if (call.arguments.nodes.length !== 1) return null;
  const wrapper = unparenthesized(call.expression);
  const factory = call.arguments.nodes[0]!;
  if (!ts.isFunctionExpression(wrapper) || !ts.isFunctionExpression(factory)) return null;
  const wrapperParams = wrapper.parameters.nodes;
  if (wrapperParams.length !== 1 || !isPlainParameter(wrapperParams[0]!)) return null;
  const factoryName = (wrapperParams[0]!.name as ts.Identifier).text;
  if (!isTypeScriptUmdWrapper(wrapper, factoryName)) return null;
  const params = factory.parameters.nodes;
  if (
    params.length !== 2 ||
    !params.every(isPlainParameter) ||
    (params[0]!.name as ts.Identifier).text !== "require" ||
    (params[1]!.name as ts.Identifier).text !== "exports"
  )
    return null;
  const body = factory.body;
  if (body === undefined || !ownBodyKeepsModuleSemantics(body)) return null;
  const open = tokenStartOfNode(body) + 1;
  const close = body.end - 1;
  return applyEdits(sf.text, 0, sf.text.length, [
    { start: tokenStartOfNode(stmt), end: open, text: "" },
    { start: close, end: stmt.end, text: "" },
  ]);
}

function unparenthesized(e: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  return e;
}

/** A parameter that is a bare identifier: no default, rest or pattern. */
function isPlainParameter(p: ts.ParameterDeclaration): boolean {
  return ts.isIdentifier(p.name) && p.initializer === undefined && p.dotDotDotToken === undefined;
}

/** True when the wrapper body is exactly TypeScript's emit and nothing else:
 * one `if` statement whose CommonJS branch holds only the factory call and
 * the `module.exports` assignment, and whose `else`, when present, is only
 * the AMD branch:
 *
 *   if (typeof module === "object" && typeof module.exports === "object") {
 *       var v = factory(require, exports);
 *       if (v !== undefined) module.exports = v;
 *   }
 *   else if (typeof define === "function" && define.amd) {
 *       define([...], factory);
 *   }
 *
 * Unwrapping drops the wrapper, so any other statement in it would be lost. */
function isTypeScriptUmdWrapper(wrapper: ts.FunctionExpression, factoryName: string): boolean {
  const stmts = wrapper.body?.statements.nodes ?? [];
  if (stmts.length !== 1 || !ts.isIfStatement(stmts[0]!)) return false;
  const test = stmts[0];
  const sf = ts.getSourceFileOfNode(wrapper);
  const text = (n: ts.Node): string =>
    sf.text.slice(tokenStartOfNode(n), n.end).replace(/\s+/g, " ");
  if (text(test.expression) !== 'typeof module === "object" && typeof module.exports === "object"')
    return false;
  const branch = test.thenStatement;
  if (!ts.isBlock(branch) || branch.statements.nodes.length !== 2) return false;
  const [call, assign] = branch.statements.nodes as [ts.Statement, ts.Statement];
  if (!ts.isVariableStatement(call)) return false;
  const declarations = call.declarationList.declarations.nodes;
  const name = declarations.length === 1 ? declarations[0]!.name : undefined;
  if (name === undefined || !ts.isIdentifier(name)) return false;
  const result = name.text;
  if (text(call) !== `var ${result} = ${factoryName}(require, exports);`) return false;
  if (text(assign) !== `if (${result} !== undefined) module.exports = ${result};`) return false;
  const amd = test.elseStatement;
  if (amd === undefined) return true;
  if (!ts.isIfStatement(amd) || amd.elseStatement !== undefined) return false;
  if (text(amd.expression) !== 'typeof define === "function" && define.amd') return false;
  const define = ts.isBlock(amd.thenStatement) ? amd.thenStatement.statements.nodes : [];
  if (define.length !== 1 || !ts.isExpressionStatement(define[0]!)) return false;
  const defineCall = define[0].expression;
  if (!ts.isCallExpression(defineCall) || text(defineCall.expression) !== "define") return false;
  const last = defineCall.arguments.nodes.at(-1);
  return last !== undefined && ts.isIdentifier(last) && last.text === factoryName;
}

/** True when the factory body behaves the same as the module's top level:
 * no `return` or `arguments` of its own, and `this` only in TypeScript's
 * helper probes. */
function ownBodyKeepsModuleSemantics(body: ts.Block): boolean {
  let keeps = true;
  ts.walkPreorder(body, (n) => {
    if (!keeps) return "stop";
    // Nested functions have their own `return`, `arguments` and `this`;
    // arrow functions only their own `return`.
    if (
      ts.isFunctionDeclaration(n) ||
      ts.isFunctionExpression(n) ||
      ts.isMethodDeclaration(n) ||
      ts.isGetAccessorDeclaration(n) ||
      ts.isSetAccessorDeclaration(n) ||
      ts.isConstructorDeclaration(n)
    )
      return "skip";
    if (ts.isClassDeclaration(n) || ts.isClassExpression(n)) return "skip";
    if (ts.isReturnStatement(n) && !insideArrow(n, body)) keeps = false;
    else if (ts.isIdentifier(n) && n.text === "arguments") keeps = false;
    else if (n.kind === ts.SyntaxKind.ThisKeyword && !isHelperProbe(n)) keeps = false;
    return undefined;
  });
  return keeps;
}

/** True when `node` sits inside an arrow function nested in `body`. */
function insideArrow(node: ts.Node, body: ts.Block): boolean {
  for (let p = node.parent; p !== undefined && p !== body; p = p.parent)
    if (ts.isArrowFunction(p)) return true;
  return false;
}

/** `this` in TypeScript's helper probe `this && this.__name`: the left
 * operand, or the receiver of the right operand's `__` member. */
function isHelperProbe(node: ts.Node): boolean {
  const parent = node.parent;
  if (parent === undefined) return false;
  const probe =
    ts.isBinaryExpression(parent) && parent.left === node
      ? parent
      : ts.isPropertyAccessExpression(parent) &&
          parent.expression === node &&
          ts.isIdentifier(parent.name) &&
          parent.name.text.startsWith("__") &&
          parent.parent !== undefined &&
          ts.isBinaryExpression(parent.parent) &&
          parent.parent.right === parent
        ? parent.parent
        : undefined;
  if (probe === undefined || probe.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken)
    return false;
  const right = probe.right;
  return (
    probe.left.kind === ts.SyntaxKind.ThisKeyword &&
    ts.isPropertyAccessExpression(right) &&
    right.expression.kind === ts.SyntaxKind.ThisKeyword &&
    ts.isIdentifier(right.name) &&
    right.name.text.startsWith("__")
  );
}
