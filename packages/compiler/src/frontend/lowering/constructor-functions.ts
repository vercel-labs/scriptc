/* `new F(args)` of a plain constructor function whose instance a record
 * type describes (`const request: Request = new RequestInstance(...)`, the
 * pre-class idiom React builds its request with): when F's body only
 * declares locals and assigns `this.field = value`, the call is a factory
 * of the record. Each assigned value evaluates in source order into a
 * temporary, and the record is built from them once the body completes,
 * so the instance is a static record rather than a checked-dynamic object.
 * Any other body (a `this` read, a method call on it, a field the record
 * lacks, a record field left unassigned) keeps the ordinary `new`. */
import * as ts from "../ts7/syntax.js";
import { DYN, UNDEFINED_T, type IrExpr, type IrStmt, type IrType } from "../../ir/ir.js";
import { isJsSourceFile, locOf } from "../program.js";
import { newFnCtx, type Lowerer } from "./lowerer.js";
import { isThisParameter } from "./call-signatures.js";
import { keyedHelperName } from "./stable-names.js";

/** The `this.k = value` assignments of a constructor body, or null when
 * the body does anything else with `this`. */
function fieldAssignments(body: ts.Block): Map<ts.ExpressionStatement, string> | null {
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
  for (const stmt of body.statements.nodes) {
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
  return other ? null : assignments;
}

export function lowerConstructorFunctionNew(
  lowerer: Lowerer,
  expr: ts.NewExpression,
  expected: IrType,
): IrExpr | null {
  if (expected.kind !== "record") return null;
  let callee = expr.expression;
  while (ts.isParenthesizedExpression(callee)) callee = callee.expression;
  if (!ts.isIdentifier(callee)) return null;
  const symbol = lowerer.resolveValueSymbol(callee);
  const decl = symbol?.declarations[0];
  if (!symbol || !decl || !ts.isFunctionDeclaration(decl) || !decl.body) return null;
  if (isJsSourceFile(ts.getSourceFileOfNode(decl)) || decl.typeParameters || decl.asteriskToken)
    return null;
  const sig = lowerer.fnSigsBySymbol.get(symbol);
  const shape = lowerer.shapes.get(expected.shapeId);
  if (!sig || !shape || sig.isAsync) return null;
  const assignments = fieldAssignments(decl.body);
  if (assignments === null) return null;
  const assigned = new Set(assignments.values());
  const fields = new Map(shape.fields.map((f) => [f.name, f.type]));
  // A field the body never assigns is absent, as the property would be:
  // an undefined-armed (optional) field holds its ABSENT state, and a
  // checked-dynamic one, which cannot be absent, holds undefined (only an
  // `in` test of that key tells them apart).
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
    `%new.${decl.name?.text ?? "F"}`,
    `${sig.name}:${expected.shapeId}`,
  ) as string;
  if (!lowerer.arrHofHelpers.has(name)) {
    lowerer.arrHofHelpers.set(name, name);
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
      body.push({
        kind: "return",
        value: {
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
        },
        loc,
      });
      lowerer.liftedFns.push({
        name,
        params: declared.params,
        returnType: expected,
        locals: lowerer.ctx.locals,
        body,
        loc,
      });
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
