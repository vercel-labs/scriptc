/* `new F(args)` of a plain constructor function whose instance a record
 * type describes (`const point: Point = new PointInstance(x, y)`, the
 * pre-class idiom for building an object): when F's body only
 * declares locals and assigns `this.field = value`, the call is a factory
 * of the record. Each assigned value evaluates in source order into a
 * temporary, and the record is built from them once the body completes,
 * so the instance is a static record rather than a checked-dynamic object.
 * Any other body (a `this` read, a method call on it, a field the record
 * lacks, a required record field left unassigned, a statement that names a
 * local declared after it, a `return`, `arguments`, `new.target`, or a
 * nested function declaration) keeps the ordinary `new`, and so does a
 * function the program uses other than in `new F()`:
 * the record has no prototype, so `F.prototype`, `instanceof F` and
 * methods added to the prototype need the real object. */
import * as ts from "../ts7/adapter.js";
import { DYN, UNDEFINED_T, type IrExpr, type IrStmt, type IrType } from "../../ir/ir.js";
import { isJsSourceFile, locOf } from "../program.js";
import { newFnCtx, type Lowerer } from "./lowerer.js";
import { isThisParameter } from "./call-signatures.js";
import { keyedHelperName } from "./stable-names.js";
import {
  escapesUnderAnotherName,
  functionImplementation,
  reachableWithoutItsName,
  symbolReferences,
} from "./symbol-references.js";

const assignmentsOf = new WeakMap<
  ts.FunctionDeclaration,
  Map<ts.ExpressionStatement, string> | null
>();

/** The `this.k = value` assignments of a constructor body, or null when
 * the function does anything else with `this` (its parameter defaults
 * included). Computed once per declaration. */
function fieldAssignments(
  decl: ts.FunctionDeclaration & { body: ts.Block },
): Map<ts.ExpressionStatement, string> | null {
  if (assignmentsOf.has(decl)) return assignmentsOf.get(decl)!;
  const result = computeFieldAssignments(decl);
  assignmentsOf.set(decl, result);
  return result;
}

function computeFieldAssignments(
  decl: ts.FunctionDeclaration & { body: ts.Block },
): Map<ts.ExpressionStatement, string> | null {
  const body = decl.body;
  const assignments = new Map<ts.ExpressionStatement, string>();
  let other = false;
  const readsThis = (n: ts.Node): boolean => {
    if (n.kind === ts.SyntaxKind.ThisKeyword) return true;
    if (ts.isFunctionLike(n) && !ts.isArrowFunction(n)) return false;
    let found = false;
    ts.forEachChild(n, (c) => {
      found ||= readsThis(c);
    });
    return found;
  };
  // `return`, `arguments`, `new.target` and hoisted function declarations
  // make the body more than a sequence of field writes. Arrow functions
  // share the constructor's `arguments` and `new.target`.
  const unsupported = (n: ts.Node, inArrow: boolean): boolean => {
    if (ts.isFunctionDeclaration(n)) return true;
    if (ts.isFunctionLike(n) && !ts.isArrowFunction(n)) return false;
    if (ts.isReturnStatement(n) && !inArrow) return true;
    if (ts.isIdentifier(n) && n.text === "arguments") return true;
    if (ts.isMetaProperty(n)) return true;
    let found = false;
    ts.forEachChild(n, (c) => {
      found ||= unsupported(c, inArrow || ts.isArrowFunction(n));
    });
    return found;
  };
  if (unsupported(body, false)) return null;
  // The factory lowers the body one statement at a time, so a statement
  // must not name a local that a later statement declares (a closure that
  // captures it, a hoisted `var` read early).
  const statements = body.statements.nodes;
  const declaredLater = new Set<string>();
  for (let i = statements.length - 1; i >= 0; i--) {
    const stmt = statements[i]!;
    const mentionsLater = (n: ts.Node): boolean =>
      (ts.isIdentifier(n) && declaredLater.has(n.text)) || !!ts.forEachChild(n, mentionsLater);
    if (mentionsLater(stmt)) return null;
    if (ts.isVariableStatement(stmt))
      for (const d of stmt.declarationList.declarations.nodes)
        if (ts.isIdentifier(d.name)) declaredLater.add(d.name.text);
        else return null;
  }
  for (const stmt of statements) {
    if (ts.isExpressionStatement(stmt)) {
      const e = stmt.expression;
      if (
        ts.isBinaryExpression(e) &&
        e.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isPropertyAccessExpression(e.left) &&
        e.left.expression.kind === ts.SyntaxKind.ThisKeyword &&
        !readsThis(e.right)
      ) {
        assignments.set(stmt, e.left.name.text);
        continue;
      }
    }
    if (ts.isEmptyStatement(stmt)) continue;
    if (readsThis(stmt)) other = true;
  }
  if (decl.parameters.nodes.some((p) => p.initializer !== undefined && readsThis(p.initializer)))
    other = true;
  return other ? null : assignments;
}

const newOnly = new WeakMap<Lowerer, Map<ts.Symbol, boolean>>();

/** The function `new F(...)` constructs when it can build a record: a
 * non-generic, non-generator TypeScript or Flow function declaration that
 * the program only ever calls with `new` (through parentheses). Null
 * otherwise. Cheap for every other `new`: no type is mapped. */
export function constructorFunctionOf(
  lowerer: Lowerer,
  expr: ts.NewExpression,
): { symbol: ts.Symbol; decl: ts.FunctionDeclaration & { body: ts.Block } } | null {
  let callee = expr.expression;
  while (ts.isParenthesizedExpression(callee)) callee = callee.expression;
  if (!ts.isIdentifier(callee)) return null;
  const symbol = lowerer.resolveValueSymbol(callee);
  const decl = symbol ? functionImplementation(symbol) : null;
  if (!symbol || decl === null || !decl.body || !decl.name) return null;
  if (isJsSourceFile(ts.getSourceFileOfNode(decl)) || decl.typeParameters || decl.asteriskToken)
    return null;
  let cache = newOnly.get(lowerer);
  if (cache === undefined) newOnly.set(lowerer, (cache = new Map()));
  let only = cache.get(symbol);
  if (only === undefined) {
    const references = symbolReferences(lowerer, symbol, decl.name.text);
    only =
      !reachableWithoutItsName(lowerer, decl, references) &&
      references.every((n) => {
        const parent = n.parent;
        if (escapesUnderAnotherName(n, decl)) return false;
        if (!parent || n === decl.name || ts.isExportSpecifier(parent)) return true;
        if (ts.isImportSpecifier(parent)) return true;
        let use: ts.Node = n;
        while (use.parent && ts.isParenthesizedExpression(use.parent)) use = use.parent;
        return !!use.parent && ts.isNewExpression(use.parent) && use.parent.expression === use;
      });
    cache.set(symbol, only);
  }
  return only ? { symbol, decl: decl as ts.FunctionDeclaration & { body: ts.Block } } : null;
}

export function lowerConstructorFunctionNew(
  lowerer: Lowerer,
  expr: ts.NewExpression,
  expected: IrType,
): IrExpr | null {
  if (expected.kind !== "record") return null;
  const target = constructorFunctionOf(lowerer, expr);
  if (target === null) return null;
  const { symbol, decl } = target;
  const sig = lowerer.fnSigsBySymbol.get(symbol);
  const shape = lowerer.shapes.get(expected.shapeId);
  if (!sig || !shape || sig.isAsync) return null;
  const assignments = fieldAssignments(decl);
  if (assignments === null) return null;
  const assigned = new Set(assignments.values());
  const fields = new Map(shape.fields.map((f) => [f.name, f.type]));
  // A field the body never assigns is left out as an object literal leaves
  // it out: an undefined-armed (optional) field holds its ABSENT state, and
  // a checked-dynamic one holds undefined.
  const absentArm = (t: IrType): boolean =>
    t.kind === "union" &&
    (lowerer.unions.get(t.unionId)?.arms.some((a) => a.kind === "undefinedT") ?? false);
  if (
    [...assigned].some((k) => !fields.has(k)) ||
    shape.fields.some((f) => !assigned.has(f.name) && !absentArm(f.type) && f.type.kind !== "dyn")
  )
    return null;
  const args = expr.arguments?.nodes ?? [];
  if (args.some(ts.isSpreadElement) || args.length !== sig.params.length) return null;

  const loc = locOf(expr);
  const name = keyedHelperName(
    lowerer,
    `%new.${decl.name!.text}`,
    `${sig.name}:${expected.shapeId}`,
  ) as string;
  if (!lowerer.arrHofHelpers.has(name)) {
    const ctx = newFnCtx(false, null, null, expected);
    lowerer.fnStack.push(ctx);
    try {
      const params = decl.parameters.nodes.filter((p) => !isThisParameter(p));
      const declared = lowerer.declareParams(params, sig.params);
      const body: IrStmt[] = [...declared.prologue];
      const temps = new Map<string, string>();
      for (const stmt of decl.body.statements.nodes) {
        const field = ts.isExpressionStatement(stmt) ? assignments.get(stmt) : undefined;
        if (field === undefined) {
          body.push(...lowerer.lowerStmts([stmt]));
          continue;
        }
        const value = (stmt.expression as ts.BinaryExpression).right;
        const temp = lowerer.declareHiddenLocal(`%this.${field}`, fields.get(field)!);
        body.push({
          kind: "varDecl",
          localId: temp.id,
          init: lowerer.lowerExprExpecting(value, fields.get(field)!),
          loc: locOf(stmt),
        });
        temps.set(field, temp.id);
      }
      // The instance's keys enumerate in the order the body first assigns
      // them, which the record notes as an object literal notes the order
      // it writes its keys in (key-order-witness.ts).
      const record: IrExpr = {
        kind: "recordLit",
        fields: shape.fields.map((f) => ({
          name: f.name,
          value: temps.has(f.name)
            ? { kind: "varRef", localId: temps.get(f.name)!, type: f.type, loc }
            : f.type.kind === "dyn"
              ? {
                  kind: "dynFrom",
                  value: { kind: "unitLit", unit: "undefined", type: UNDEFINED_T, loc },
                  type: DYN,
                  loc,
                }
              : {
                  kind: "fieldAbsent",
                  unionId: (f.type as IrType & { kind: "union" }).unionId,
                  type: f.type,
                  loc,
                },
        })),
        type: expected,
        loc,
      };
      lowerer.keyOrder.literal(
        record,
        [...assigned].map((name) => ({ kind: "key", name, definite: true })),
      );
      body.push({ kind: "return", value: record, loc });
      lowerer.liftedFns.push({
        name,
        params: declared.params,
        returnType: expected,
        locals: lowerer.ctx.locals,
        body,
        loc,
      });
      // Registered once the helper exists: a body that fails to lower
      // leaves no name behind for a later `new` to call.
      lowerer.arrHofHelpers.set(name, name);
    } finally {
      lowerer.fnStack.pop();
    }
  }
  return {
    kind: "call",
    callee: name,
    args: sig.params.map((p, i) => lowerer.lowerExprExpecting(args[i]!, p.type)),
    type: expected,
    loc,
  };
}
