import * as ts from "../ts7/adapter.js";
import { BOOL, DYN, type IrExpr, type IrFunction, type SrcLoc } from "../../ir/ir.js";
import { varRef } from "../../ir/build.js";
import { isJsSourceFile } from "../program.js";
import { findStaticOn, findGenericStaticOn, type ClassInfo } from "./lower-classes.js";
import type { Lowerer } from "./lowerer.js";

const constructorMembers = new Set([
  "name",
  "length",
  "prototype",
  "__proto__",
  "constructor",
  "call",
  "apply",
  "bind",
  "arguments",
  "caller",
  "toString",
  "toLocaleString",
  "valueOf",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
]);

/** Expando data on an exact JS constructor. Declared statics and Function
 * members retain their existing lowering; this bag cannot replace them. */
export function classStaticDataFor(
  lowerer: Lowerer,
  info: ClassInfo,
  name: string,
  loc: SrcLoc,
): IrExpr | null {
  if (
    !info.decl ||
    !isJsSourceFile(ts.getSourceFileOfNode(info.decl)) ||
    name.startsWith("#") ||
    constructorMembers.has(name)
  )
    return null;
  if (findStaticOn(lowerer, info, name) || findGenericStaticOn(lowerer, info, name)) return null;
  for (let c: ClassInfo | null = info; c; c = c.base) {
    if (
      c.decl?.members?.nodes.some(
        (m) =>
          m.name &&
          ts.canHaveModifiers(m) &&
          ts.getModifiers(m)?.some((mod) => mod.kind === ts.SyntaxKind.StaticKeyword) &&
          (ts.isComputedPropertyName(m.name) ||
            ((ts.isIdentifier(m.name) || ts.isStringLiteral(m.name)) && m.name.text === name)),
      )
    )
      return null;
  }
  return classStaticData(lowerer, info, loc);
}

export function classStaticData(lowerer: Lowerer, info: ClassInfo, loc: SrcLoc): IrExpr | null {
  if (info.callableBase) return null;
  if (
    info.localClass ||
    info.runtimeStatics ||
    info.mixinInstance ||
    info.generic ||
    info.genericInstance ||
    info.classDecorators ||
    info.def.runtime ||
    info.builtinEmitter ||
    info.builtinStream ||
    info.builtinError
  )
    return null;
  if (info.staticDataHelper === undefined) {
    const base =
      info.base && !info.base.builtinError ? classStaticData(lowerer, info.base, loc) : null;
    if (info.base && !info.base.builtinError && base === null) return null;
    const name = `%static.data.${info.def.name}`;
    const globalId = `%g.${name}`;
    const readyId = `${globalId}.ready`;
    info.staticDataHelper = name;
    lowerer.globalsList.push({
      id: globalId,
      name: `${info.def.name}.staticData`,
      type: DYN,
      mutable: true,
    });
    lowerer.globalsList.push({
      id: readyId,
      name: `${info.def.name}.staticDataReady`,
      type: BOOL,
      mutable: true,
    });
    const helper: IrFunction = {
      name,
      params: [],
      returnType: DYN,
      locals: [],
      loc,
      body: [
        {
          kind: "if",
          cond: { kind: "unary", op: "!", operand: varRef(readyId, BOOL, loc), type: BOOL, loc },
          then: [
            {
              kind: "assign",
              localId: globalId,
              value: base
                ? { kind: "libCall", fn: "dyn.objCreate", args: [base], type: DYN, loc }
                : { kind: "dynObjLit", fields: [], type: DYN, loc },
              loc,
            },
            {
              kind: "assign",
              localId: readyId,
              value: { kind: "boolLit", value: true, type: BOOL, loc },
              loc,
            },
          ],
          else_: null,
          loc,
        },
        { kind: "return", value: varRef(globalId, DYN, loc), loc },
      ],
    };
    lowerer.liftedFns.push(helper);
  }
  return { kind: "call", callee: info.staticDataHelper, args: [], type: DYN, loc };
}
