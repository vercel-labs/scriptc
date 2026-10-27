/* JavaScript declarations whose values only the checked-dynamic
 * representation can hold faithfully. TypeScript infers a fixed object
 * type for each of them, but the program changes the value's shape or
 * identity at run time, so a static layout would answer stale members
 * (or throw on a value that no longer fits):
 *
 * - a non-empty object literal bound to a variable that the same file
 *   grows or reshapes dynamically: a keyed write with a runtime key
 *   (`o[k] = v`), a `delete`, or `Object.defineProperty(o, ...)` /
 *   `Object.defineProperties(o, ...)` (ansi-styles' `assembleStyles`).
 *   The object literals nested in its property values belong to the same
 *   value graph and are marked with it;
 * - a class whose only member is a constructor that returns a value and
 *   never reads `this` (chalk's `class Chalk { constructor(options) {
 *   return chalkFactory(options); } }`): `new C()` answers whatever the
 *   constructor returns, so its instance type has no fixed layout.
 *
 * The type mapper answers the checked-dynamic type for the instance and
 * object-literal types these declarations own (TypeMapperCtx
 * .jsDynamicDeclaration). The scan is syntactic, runs over JavaScript
 * files only, and an empty answer leaves every mapping unchanged, so
 * TypeScript programs and JavaScript that never uses these patterns
 * compile exactly as before. */
import { keyedHelperName } from "./stable-names.js";
import * as ts from "../ts7/adapter.js";
import { isJsSourceFile, locOf } from "../program.js";
import { BOOL, DYN, type IrExpr, type IrStmt } from "../../ir/ir.js";
import { dynUndefinedExpr, nodeThrowExpr } from "../../ir/build.js";
import type { Lowerer } from "./lowerer.js";
import type { ParamShape } from "./call-signatures.js";
import { newFnCtx } from "./function-context.js";

const SCANNED_KINDS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.VariableDeclaration,
  ts.SyntaxKind.ClassDeclaration,
  ts.SyntaxKind.BinaryExpression,
  ts.SyntaxKind.DeleteExpression,
  ts.SyntaxKind.CallExpression,
]);

function unparenthesized(node: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(node)) node = node.expression;
  return node;
}

function isLiteralKey(node: ts.Expression): boolean {
  const key = unparenthesized(node);
  return (
    ts.isStringLiteral(key) || ts.isNumericLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key)
  );
}

function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}

/** `class C { constructor(...) { ...; return value; } }` with nothing else:
 * no heritage, decorators or other members, a constructor body that
 * returns a value at its own level and never mentions `this`/`super`. */
export function isValueReturningConstructorClass(decl: ts.ClassDeclaration): boolean {
  if (decl.heritageClauses !== undefined && decl.heritageClauses.nodes.length > 0) return false;
  if (decl.modifiers?.nodes.some((modifier) => modifier.kind === ts.SyntaxKind.Decorator))
    return false;
  let ctor: ts.ConstructorDeclaration | undefined;
  for (const member of decl.members.nodes) {
    if (ts.isSemicolonClassElement(member)) continue;
    if (!ts.isConstructorDeclaration(member) || ctor !== undefined) return false;
    ctor = member;
  }
  if (ctor?.body === undefined) return false;
  let returnsValue = false;
  let observesThis = false;
  const visit = (node: ts.Node): void => {
    if (observesThis) return;
    if (node.kind === ts.SyntaxKind.ThisKeyword || node.kind === ts.SyntaxKind.SuperKeyword) {
      observesThis = true;
      return;
    }
    // Arrow functions share the constructor's `this`; other functions
    // have their own `this` and their own returns.
    if (ts.isFunctionLike(node) && !ts.isArrowFunction(node)) return;
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) return;
    if (ts.isReturnStatement(node) && node.expression !== undefined && !insideArrow(node, ctor!))
      returnsValue = true;
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(ctor.body, visit);
  for (const parameter of ctor.parameters.nodes) ts.forEachChild(parameter, visit);
  return returnsValue && !observesThis;
}

function insideArrow(node: ts.Node, ctor: ts.ConstructorDeclaration): boolean {
  for (let p = node.parent; p !== undefined && p !== ctor; p = p.parent) {
    if (ts.isArrowFunction(p)) return true;
  }
  return false;
}

function markNested(literal: ts.ObjectLiteralExpression, out: Set<ts.Node>): void {
  if (out.has(literal)) return;
  out.add(literal);
  for (const property of literal.properties.nodes) {
    if (!ts.isPropertyAssignment(property)) continue;
    const value = unparenthesized(property.initializer);
    if (ts.isObjectLiteralExpression(value)) markNested(value, out);
  }
}

export function jsDynamicDeclarations(
  files: readonly ts.SourceFile[],
  checker: ts.TypeChecker,
): Set<ts.Node> {
  const out = new Set<ts.Node>();
  for (const file of files) {
    if (!isJsSourceFile(file) || file.isDeclarationFile) continue;
    const literals = new Map<ts.Symbol, ts.ObjectLiteralExpression>();
    const reshaped = new Set<ts.Symbol>();
    const receiver = (expression: ts.Expression | undefined): void => {
      if (expression === undefined) return;
      const target = unparenthesized(expression);
      if (!ts.isIdentifier(target)) return;
      const symbol = checker.getSymbolAtLocation(target);
      if (symbol !== undefined) reshaped.add(symbol);
    };
    ts.walkPreorder(
      file,
      (node) => {
        if (ts.isVariableDeclaration(node)) {
          if (!ts.isIdentifier(node.name) || node.initializer === undefined) return;
          const init = unparenthesized(node.initializer);
          // An empty literal's binding is already checked-dynamic
          // (jsOpenObjectType), and its type describes no layout.
          if (!ts.isObjectLiteralExpression(init) || init.properties.nodes.length === 0) return;
          const symbol = checker.getSymbolAtLocation(node.name);
          if (symbol !== undefined) literals.set(symbol, init);
          return;
        }
        if (ts.isClassDeclaration(node)) {
          if (isValueReturningConstructorClass(node)) out.add(node);
          return;
        }
        if (ts.isBinaryExpression(node)) {
          if (!isAssignmentOperator(node.operatorToken.kind)) return;
          const left = unparenthesized(node.left);
          if (ts.isElementAccessExpression(left) && !isLiteralKey(left.argumentExpression))
            receiver(left.expression);
          return;
        }
        if (ts.isDeleteExpression(node)) {
          const operand = unparenthesized(node.expression);
          if (ts.isElementAccessExpression(operand) || ts.isPropertyAccessExpression(operand))
            receiver(operand.expression);
          return;
        }
        if (ts.isCallExpression(node)) {
          const callee = unparenthesized(node.expression);
          if (
            ts.isPropertyAccessExpression(callee) &&
            ts.isIdentifier(callee.expression) &&
            callee.expression.text === "Object" &&
            (callee.name.text === "defineProperty" || callee.name.text === "defineProperties")
          )
            receiver(node.arguments.nodes[0]);
        }
      },
      SCANNED_KINDS,
    );
    for (const symbol of reshaped) {
      const literal = literals.get(symbol);
      if (literal !== undefined) markNested(literal, out);
    }
  }
  return out;
}

/** `new C(args)` for a value-returning constructor class (above): the
 * constructor body runs as an ordinary JavaScript function whose result
 * is the construction's value. A returned object or function is Node's
 * answer; a fall-through or primitive return would answer the bare
 * instance, which has no static home here, and throws the deferred
 * refusal instead. Null when the callee is not such a class. */
export function lowerValueReturningConstructorNew(
  lowerer: Lowerer,
  expr: ts.NewExpression,
): IrExpr | null {
  const isDynamic = lowerer.typeCtx.jsDynamicDeclaration;
  if (isDynamic === undefined) return null;
  const callee = unparenthesized(expr.expression);
  if (!ts.isIdentifier(callee)) return null;
  let symbol = lowerer.resolveValueSymbol(callee);
  if (symbol !== null && (symbol.flags & ts.SymbolFlags.Alias) !== 0)
    symbol = lowerer.checker.getAliasedSymbol(symbol);
  const decl = symbol
    ? symbol.declarations.find(
        (node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && isDynamic(node),
      )
    : undefined;
  if (decl === undefined) return null;
  const loc = locOf(expr);
  const ctor = decl.members.nodes.find(ts.isConstructorDeclaration)!;
  const simple = ctor.parameters.nodes.every(
    (p) => ts.isIdentifier(p.name) && p.dotDotDotToken === undefined && p.initializer === undefined,
  );
  if (!simple || !ts.isSourceFile(decl.parent)) {
    lowerer.unsupported(
      "SC1090",
      expr,
      "constructing a class whose constructor returns a value, with parameter defaults, rest or patterns, or declared inside a function",
    );
  }
  const args = expr.arguments?.nodes ?? [];
  if (args.some(ts.isSpreadElement)) {
    lowerer.unsupported(
      "SC1090",
      expr,
      "spread arguments when constructing a class whose constructor returns a value",
    );
  }
  const key = `ctorValue:${lowerer.positions.of(decl)}`;
  let name = lowerer.valueHelpers.get(key);
  if (name === undefined) {
    name = keyedHelperName(lowerer, "%ctorValue", key);
    lowerer.valueHelpers.set(key, name);
    const savedClass = lowerer.currentClass;
    lowerer.currentClass = null;
    lowerer.fnStack.push(newFnCtx(false, null, null, DYN));
    try {
      const shapes: ParamShape[] = ctor.parameters.nodes.map(() => ({
        type: DYN,
        mode: "required",
      }));
      const declared = lowerer.declareParams(ctor.parameters.nodes, shapes);
      const body: IrStmt[] = [
        ...declared.prologue,
        ...lowerer.lowerStmts(ctor.body!.statements.nodes),
        {
          kind: "runtimeFence",
          code: "SC1090",
          message: `constructors that return no object (the bare instance of '${decl.name?.text ?? "class"}' has no representation here) are not supported yet [SC1090 at ${ts.getSourceFileOfNode(decl).fileName}:${ts.getLineAndCharacterOfPosition(ts.getSourceFileOfNode(decl), ts.tokenStartOfNode(ctor)).line + 1}]`,
          loc: locOf(ctor),
        },
      ];
      lowerer.liftedFns.push({
        name,
        params: declared.params,
        returnType: DYN,
        locals: lowerer.ctx.locals,
        body,
        loc: locOf(ctor),
      });
    } finally {
      lowerer.fnStack.pop();
      lowerer.currentClass = savedClass;
    }
  }
  const lowered = ctor.parameters.nodes.map((_, i) =>
    args[i] !== undefined ? lowerer.lowerExprExpecting(args[i]!, DYN) : dynUndefinedExpr(loc),
  );
  // Surplus arguments still evaluate, left to right, after the others.
  const surplus: IrStmt[] = args
    .slice(ctor.parameters.nodes.length)
    .map((arg) => ({ kind: "exprStmt", expr: lowerer.lowerExpr(arg), loc: locOf(arg) }));
  const result = lowerer.declareHiddenLocal("%constructed", DYN);
  const value: IrExpr = { kind: "varRef", localId: result.id, type: DYN, loc };
  const sf = ts.getSourceFileOfNode(expr);
  const line = ts.getLineAndCharacterOfPosition(sf, ts.tokenStartOfNode(expr)).line + 1;
  const objectLike: IrExpr = {
    kind: "logical",
    op: "||",
    left: { kind: "dynTest", test: "function", value, type: BOOL, loc },
    right: {
      kind: "logical",
      op: "&&",
      left: { kind: "dynTest", test: "object", value, type: BOOL, loc },
      right: { kind: "dynTest", test: "null", negated: true, value, type: BOOL, loc },
      type: BOOL,
      loc,
    },
    type: BOOL,
    loc,
  };
  const args0: IrStmt[] = [];
  const argLocals = lowered.map((arg) => {
    const local = lowerer.declareHiddenLocal("%constructArg", DYN);
    args0.push({ kind: "varDecl", localId: local.id, init: arg, loc });
    return { kind: "varRef", localId: local.id, type: DYN, loc } as IrExpr;
  });
  return {
    kind: "seqExpr",
    stmts: [
      ...args0,
      ...surplus,
      {
        kind: "varDecl",
        localId: result.id,
        init: { kind: "call", callee: name, args: argLocals, type: DYN, loc },
        loc,
      },
    ],
    result: {
      kind: "ternary",
      cond: objectLike,
      then: value,
      else_: nodeThrowExpr(
        0,
        "SC1090",
        `constructors that return no object are not supported yet [SC1090 at ${sf.fileName}:${line}]`,
        DYN,
        loc,
      ),
      type: DYN,
      loc,
    },
    type: DYN,
    loc,
  };
}
