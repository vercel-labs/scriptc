import { dynUndefinedExpr, varRef } from "../../ir/build.js";
import * as ts from "../ts7/adapter.js";
import { BOOL, DYN, STRING, type IrExpr, type IrLocal, type IrStmt } from "../../ir/ir.js";
import { locOf } from "../program.js";
import type { Lowerer } from "./lowerer.js";
import { classValueRef, type ClassInfo } from "./lower-classes.js";
import { classPrototypeData } from "./class-prototypes.js";

export function hasRuntimeStatics(info: ClassInfo): boolean {
  for (let current: ClassInfo | null = info; current; current = current.base) {
    if (current.runtimeStatics !== undefined) return true;
  }
  return false;
}

/** Constructor descriptors preserve inherited getter receivers and static
 * initialization order. Factory evaluations additionally own independent
 * fields and closures when the same factory is called repeatedly.
 *
 * `binding` is the local that holds the class under its own name (a
 * function-local class declaration's binding, or the inner name of a
 * function-local class expression whose body names itself), declared
 * without a value. It is assigned before any static member is defined, so
 * static initializers and methods read the class through it. */
export function initializeRuntimeStatics(
  lowerer: Lowerer,
  info: ClassInfo,
  value: IrExpr,
  binding?: IrLocal,
): IrExpr {
  if (!info.runtimeStatics && !info.runtimePrototypeMembers) {
    if (!binding) return value;
    return {
      kind: "seqExpr",
      stmts: [{ kind: "assign", localId: binding.id, value, loc: value.loc }],
      result: varRef(binding.id, binding.type, value.loc),
      type: binding.type,
      loc: value.loc,
    };
  }
  const loc = value.loc;
  const local = lowerer.declareHiddenLocal("%staticClass", value.type);
  const receiver = varRef(local.id, value.type, loc);
  const boxed = lowerer.coerceToExpected(receiver, DYN);
  const base =
    !info.localClass && info.base && !info.def.baseValueGlobal
      ? lowerer.coerceToExpected(classValueRef(lowerer, info.base, info.decl!), DYN)
      : dynUndefinedExpr(loc);
  const statements: IrStmt[] = [
    { kind: "varDecl", localId: local.id, init: value, loc },
    ...(binding
      ? [
          {
            kind: "assign" as const,
            localId: binding.id,
            value: lowerer.coerceToExpected(receiver, binding.type),
            loc,
          },
        ]
      : []),
    {
      kind: "exprStmt",
      expr: { kind: "libCall", fn: "dyn.classInherit", args: [boxed, base], type: DYN, loc },
      loc,
    },
  ];
  const previousThis = lowerer.ctx.thisLocal;
  try {
    const members = [...(info.runtimeStatics ?? []), ...(info.runtimePrototypeMembers ?? [])];
    const computedKeys = new Map<ts.ClassElement, IrExpr>();
    for (const member of members) {
      if (!member.name || !ts.isComputedPropertyName(member.name)) continue;
      const key = lowerer.declareHiddenLocal("%staticKey", DYN);
      statements.push({
        kind: "varDecl",
        localId: key.id,
        init: {
          kind: "libCall",
          fn: "dyn.propertyKey",
          args: [lowerer.lowerExprExpecting(member.name.expression, DYN)],
          type: DYN,
          loc: locOf(member.name),
        },
        loc: locOf(member.name),
      });
      computedKeys.set(member, varRef(key.id, DYN, locOf(member.name)));
    }
    lowerer.ctx.thisLocal = local;
    // Methods and accessors exist before any static initializer executes.
    const definitions = members.filter(
      (member) => ts.isMethodDeclaration(member) || ts.isAccessor(member),
    );
    const initializers = members.filter(
      (member) => !ts.isMethodDeclaration(member) && !ts.isAccessor(member),
    );
    for (const member of [...definitions, ...initializers]) {
      if (ts.isClassStaticBlockDeclaration(member)) {
        statements.push(...lowerer.lowerStmts(member.body.statements.nodes));
        continue;
      }
      if (!member.name) continue;
      const memberLoc = locOf(member);
      const key: IrExpr = ts.isComputedPropertyName(member.name)
        ? computedKeys.get(member)!
        : lowerer.coerceToExpected(
            {
              kind: "strLit",
              value: ts.isNumericLiteral(member.name)
                ? String(Number(member.name.text))
                : member.name.text!,
              type: STRING,
              loc: memberLoc,
            },
            DYN,
          );
      const fields: { key: string; value: IrExpr }[] = [
        {
          key: "configurable",
          value: lowerer.coerceToExpected(
            { kind: "boolLit", value: true, type: BOOL, loc: memberLoc },
            DYN,
          ),
        },
        {
          key: "enumerable",
          value: lowerer.coerceToExpected(
            {
              kind: "boolLit",
              value: ts.isPropertyDeclaration(member),
              type: BOOL,
              loc: memberLoc,
            },
            DYN,
          ),
        },
      ];
      if (ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) {
        fields.push({
          key: ts.isGetAccessorDeclaration(member) ? "get" : "set",
          value: lowerer.coerceToExpected(lowerer.lowerLambda(member), DYN),
        });
      } else if (ts.isMethodDeclaration(member) || ts.isPropertyDeclaration(member)) {
        fields.push({
          key: "writable",
          value: lowerer.coerceToExpected(
            { kind: "boolLit", value: true, type: BOOL, loc: memberLoc },
            DYN,
          ),
        });
        fields.push({
          key: "value",
          value: ts.isMethodDeclaration(member)
            ? lowerer.coerceToExpected(lowerer.lowerLambda(member), DYN)
            : member.initializer
              ? lowerer.lowerExprExpecting(member.initializer, DYN)
              : dynUndefinedExpr(memberLoc),
        });
      }
      const target = info.runtimePrototypeMembers?.includes(member)
        ? classPrototypeData(lowerer, info, memberLoc, receiver)!
        : boxed;
      statements.push({
        kind: "exprStmt",
        expr: {
          kind: "libCall",
          fn: "dyn.defineProperty",
          args: [
            target,
            key,
            {
              kind: "dynObjLit",
              fields: fields.map((field) => ({
                key: { kind: "strLit", value: field.key, type: STRING, loc: memberLoc },
                value: field.value,
              })),
              type: DYN,
              loc: memberLoc,
            },
          ],
          type: DYN,
          loc: memberLoc,
        },
        loc: memberLoc,
      });
    }
  } finally {
    lowerer.ctx.thisLocal = previousThis;
  }
  return { kind: "seqExpr", stmts: statements, result: receiver, type: receiver.type, loc };
}
