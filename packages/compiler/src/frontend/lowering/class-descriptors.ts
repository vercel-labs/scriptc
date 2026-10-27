import * as ts from "../ts7/adapter.js";
import {
  BOOL,
  DYN,
  STRING,
  VOID,
  type SrcLoc,
  type IrExpr,
  type IrStmt,
  isDynTypedRefType,
} from "../../ir/ir.js";
import { varRef } from "../../ir/build.js";
import { locOf } from "../program.js";
import type { Lowerer } from "./lowerer.js";
import type { ClassInfo } from "./lower-classes.js";
import { classPropertiesHelper } from "./class-dynamic-dispatch.js";

function literalName(name: ts.PropertyName): string | null {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : null;
}

function bagOnlyProperty(owner: ClassInfo, name: string): boolean {
  return !owner.fields.has(name) && owner.subclasses.every((child) => bagOnlyProperty(child, name));
}

export function runtimeRooted(info: ClassInfo): boolean {
  for (let current: ClassInfo | null = info; current; current = current.base) {
    if (
      current.def.runtime ||
      current.builtinError ||
      current.builtinEmitter ||
      current.builtinStream
    )
      return true;
  }
  return false;
}

/** A named bag property needs no snapshot of unrelated native fields,
 * which may contain recursive or otherwise opaque values. */
export function lowerClassDescriptorRead(
  lowerer: Lowerer,
  call: ts.CallExpression,
  target: IrExpr,
): IrExpr | null {
  if (!isDynTypedRefType(target.type)) return null;
  const info = lowerer.classes.get(target.type.className);
  const key = call.arguments.nodes[1]!;
  if (!info || runtimeRooted(info) || !ts.isStringLiteral(key) || !bagOnlyProperty(info, key.text))
    return null;
  const loc = locOf(call);
  const bag: IrExpr = {
    kind: "call",
    callee: classPropertiesHelper(lowerer, loc).name,
    args: [lowerer.coerceToExpected(target, DYN)],
    type: DYN,
    loc,
  };
  return {
    kind: "libCall",
    fn: "dyn.getOwnPropertyDescriptor",
    args: [bag, lowerer.lowerExprExpecting(key, DYN)],
    type: DYN,
    loc,
  };
}

/** Native layout fields cannot change descriptors. New named properties
 * live in the instance's shared bag, preserving attributes and identity. */
export function lowerClassDataDescriptor(
  lowerer: Lowerer,
  call: ts.CallExpression,
  member: string,
  target: IrExpr,
): IrExpr | null {
  if (!isDynTypedRefType(target.type)) return null;
  const info = lowerer.classes.get(target.type.className);
  if (!info || runtimeRooted(info)) return null;
  const safeName = (owner: ClassInfo, name: string): boolean => bagOnlyProperty(owner, name);
  const descriptor = (node: ts.Expression): boolean =>
    ts.isObjectLiteralExpression(node) &&
    node.properties.nodes.every(
      (p) =>
        (ts.isPropertyAssignment(p) ||
          ts.isShorthandPropertyAssignment(p) ||
          ts.isMethodDeclaration(p)) &&
        ["value", "writable", "enumerable", "configurable", "get", "set"].includes(
          literalName(p.name) ?? "",
        ),
    );
  const descriptors = call.arguments.nodes[member === "defineProperty" ? 2 : 1]!;
  if (member === "defineProperty") {
    const key = call.arguments.nodes[1]!;
    if ((ts.isStringLiteral(key) && !safeName(info, key.text)) || !descriptor(descriptors))
      return null;
  } else {
    if (
      !ts.isObjectLiteralExpression(descriptors) ||
      !descriptors.properties.nodes.every((p) => {
        if (!ts.isPropertyAssignment(p)) return false;
        const name = literalName(p.name);
        return (
          name !== null && name !== "__proto__" && safeName(info, name) && descriptor(p.initializer)
        );
      })
    )
      return null;
  }
  const loc = locOf(call);
  const receiver = lowerer.declareHiddenLocal("%descriptorReceiver", target.type);
  const desc = lowerer.declareHiddenLocal("%descriptors", DYN);
  const key =
    member === "defineProperty" ? lowerer.declareHiddenLocal("%descriptorKey", DYN) : null;
  if (key) key.mutable = true;
  const value = varRef(receiver.id, target.type, loc);
  const boxed = lowerer.coerceToExpected(value, DYN);
  const helper = classPropertiesHelper(lowerer, loc);
  const bag: IrExpr = { kind: "call", callee: helper.name, args: [boxed], type: DYN, loc };
  const args =
    member === "defineProperty"
      ? [bag, varRef(key!.id, DYN, loc), varRef(desc.id, DYN, loc)]
      : [bag, varRef(desc.id, DYN, loc)];
  const stmts: IrStmt[] = [
    { kind: "varDecl", localId: receiver.id, init: target, loc },
    ...(key
      ? [
          {
            kind: "varDecl" as const,
            localId: key.id,
            init: lowerer.lowerExprExpecting(call.arguments.nodes[1]!, DYN),
            loc,
          },
        ]
      : []),
    { kind: "varDecl", localId: desc.id, init: lowerer.lowerExprExpecting(descriptors, DYN), loc },
    ...(key && !ts.isStringLiteral(call.arguments.nodes[1]!)
      ? [
          {
            kind: "assign" as const,
            localId: key.id,
            value: {
              kind: "libCall" as const,
              fn: "dyn.propertyKey" as const,
              args: [varRef(key.id, DYN, loc)],
              type: DYN,
              loc,
            },
            loc,
          },
          {
            kind: "exprStmt" as const,
            expr: {
              kind: "call" as const,
              callee: descriptorGuard(lowerer, info, loc),
              args: [varRef(key.id, DYN, loc)],
              type: VOID,
              loc,
            },
            loc,
          },
        ]
      : []),
    {
      kind: "exprStmt",
      expr: {
        kind: "libCall",
        fn: member === "defineProperty" ? "dyn.defineProperty" : "dyn.defineProps",
        args,
        type: DYN,
        loc,
      },
      loc,
    },
  ];
  return { kind: "seqExpr", stmts, result: value, type: value.type, loc };
}

function descriptorGuard(lowerer: Lowerer, info: ClassInfo, loc: SrcLoc): string {
  const name = `%descriptorGuard:${info.def.name}`;
  const existing = lowerer.liftedFnNamed(name);
  const key = varRef("key", DYN, loc);
  const fields = new Set<string>();
  const collect = (owner: ClassInfo): void => {
    for (const field of owner.fields.keys()) fields.add(field);
    for (const child of owner.subclasses) collect(child);
  };
  collect(info);
  const body: IrStmt[] = [...fields]
    .filter((field) => !field.startsWith("%") && !field.startsWith("#"))
    .map((field): IrStmt => ({
      kind: "if",
      cond: {
        kind: "dynScalarEq",
        left: key,
        right: lowerer.coerceToExpected({ kind: "strLit", value: field, type: STRING, loc }, DYN),
        type: BOOL,
        loc,
      },
      then: [
        {
          kind: "runtimeFence",
          code: "SC2020",
          message: `changing the descriptor of native field '${field}' is not supported yet`,
          loc,
        },
      ],
      else_: null,
      loc,
    }));
  if (existing) {
    existing.body = body;
    return name;
  }
  lowerer.liftedFns.push({
    name,
    params: [{ localId: "key", name: "key", type: DYN }],
    locals: [{ id: "key", name: "key", type: DYN, mutable: false }],
    returnType: VOID,
    loc,
    body,
  });
  return name;
}

export function refreshDescriptorGuards(lowerer: Lowerer): void {
  for (const fn of lowerer.liftedFns) {
    if (!fn.name.startsWith("%descriptorGuard:")) continue;
    const info = lowerer.classes.get(fn.name.slice("%descriptorGuard:".length));
    if (info) descriptorGuard(lowerer, info, fn.loc);
  }
}
