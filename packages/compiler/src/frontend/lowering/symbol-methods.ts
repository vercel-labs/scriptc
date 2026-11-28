import * as ts from "../ts7/adapter.js";
import { locOf } from "../program.js";
import type { IrExpr } from "../../ir/ir.js";
import type { Lowerer } from "./lowerer.js";
import { accessorCall, type ClassInfo } from "./lower-classes.js";
import { classSymbolKeyOf } from "./symbol-fields.js";
import { classValueIsExactlyOwn, findStaticOn, staticMethodFunctionFor } from "./lower-classes.js";
import { usesStaticReceiver } from "./static-this.js";

/** A stable symbol method (a module-scope symbol, or a well-known symbol
 * such as `Symbol.iterator`) uses the same completed arguments and virtual
 * dispatch as a string-named class method. Runtime-selected keys stay on
 * the checked-property path. */
export function lowerClassSymbolMethodCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
): IrExpr | null {
  const access = call.expression;
  if (!ts.isElementAccessExpression(access) || access.questionDotToken || call.questionDotToken)
    return null;
  const type = lowerer.mapTypeOf(lowerer.typeOf(access.expression));
  // A class value calls a symbol-keyed STATIC method with the class as its
  // `this` (a `this`-reading body needs the receiver the detached value
  // cannot supply). `C[k]()` is a static call, exactly like `C.m()`.
  if (type?.kind === "classval") {
    const classInfo = lowerer.classes.get(type.className);
    const key = classSymbolKeyOf(lowerer, access.argumentExpression);
    const found = classInfo && key ? findStaticOn(lowerer, classInfo, key.fieldName) : null;
    if (!classInfo || !found?.method || !found.method.member.body) return null;
    const loc = locOf(call);
    if (usesStaticReceiver(found.method.member)) {
      if (!classValueIsExactlyOwn(lowerer, access.expression, classInfo))
        lowerer.unsupported(
          "SC1090",
          call,
          "receiver-dependent symbol-keyed static methods through a polymorphic class value",
        );
      const target = staticMethodFunctionFor(lowerer, call, classInfo, key!.fieldName);
      if (!target) return null;
      lowerer.noteEdge(target.fn);
      return {
        kind: "call",
        callee: target.fn,
        args: lowerer.completeArgs(call.arguments.nodes, target.params, loc, call),
        type: target.ret,
        loc,
      };
    }
    return null;
  }
  if (type?.kind !== "object") return null;
  const info = lowerer.classes.get(type.className);
  const key = classSymbolKeyOf(lowerer, access.argumentExpression);
  const name = key
    ? info?.symbolMethods?.get(key.identity)
    : wellKnownSymbolMethod(lowerer, info, access.argumentExpression);
  if (!name) return null;
  const method = lowerer.findMethodOn(info ?? null, name);
  if (!method) return null;
  const loc = locOf(call);
  const receiver = lowerer.lowerExpr(access.expression);
  const args = lowerer.completeArgs(call.arguments.nodes, method.sig.params, loc, call);
  return accessorCall(lowerer, type.className, name, receiver, args, method.sig.ret, loc);
}

/** The `sym:<name>` method a well-known symbol key such as `Symbol.iterator`
 * names, when the class declares it as a method and the program cannot
 * replace it at run time (an instance property of that name, a prototype
 * write). */
function wellKnownSymbolMethod(
  lowerer: Lowerer,
  info: ClassInfo | undefined,
  key: ts.Expression,
): string | null {
  while (ts.isParenthesizedExpression(key)) key = key.expression;
  if (!info || info.def.runtime || !ts.isPropertyAccessExpression(key)) return null;
  const member = lowerer.stdlibGlobalMember(key, "Symbol");
  if (member === null) return null;
  const name = `sym:${member}`;
  if (info.fields.has(name) || lowerer.replacedSymbolMethods.has(name)) return null;
  return name;
}
