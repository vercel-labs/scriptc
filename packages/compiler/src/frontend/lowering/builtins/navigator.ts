/* Node 24's `navigator` global (lib/internal/navigator.js): `typeof
 * navigator` is "object", `navigator.userAgent` is `Node.js/<major>` (both
 * fold to string literals; jose reads them at module load), and
 * hardwareConcurrency, language, languages and platform read the runtime's
 * answers (scr_node_builtin.c). The object as a value is the runtime's
 * Navigator handle, whose getters answer the same. `locks` keeps a named
 * refusal. */
import * as ts from "../../ts7/adapter.js";
import { strLit } from "../../../ir/build.js";
import { DYN, F64, STRING, type IrExpr, type SrcLoc } from "../../../ir/ir.js";
import { isJsSourceFile, locOf } from "../../program.js";
import type { Lowerer } from "../lowerer.js";

/** True when `node` names Node's global `navigator`: the @types/node
 * declaration, or, in a JavaScript file, the free name no declaration
 * binds (Node defines it on the global object). */
export function isNavigatorGlobal(lowerer: Lowerer, node: ts.Expression): boolean {
  let expr = node;
  while (ts.isParenthesizedExpression(expr)) expr = expr.expression;
  if (!ts.isIdentifier(expr) || expr.text !== "navigator") return false;
  if (lowerer.isStdlibGlobal(expr, "navigator")) return true;
  return (
    isJsSourceFile(ts.getSourceFileOfNode(expr)) &&
    lowerer.checker.getSymbolAtLocation(expr) === undefined
  );
}

/** `navigator.userAgent` (`Node.js/<major>` of `nodeVersion`, the pinned
 * release builtins/process.ts names), or the named refusal for another
 * member. Null when the receiver is not the global. */
export function lowerNavigatorMember(
  lowerer: Lowerer,
  access: ts.PropertyAccessExpression,
  nodeVersion: string,
): IrExpr | null {
  if (!isNavigatorGlobal(lowerer, access.expression)) return null;
  const loc = locOf(access);
  if (access.name.text === "userAgent") {
    return strLit(`Node.js/${nodeVersion.split(".")[0]}`, loc);
  }
  if (access.name.text === "hardwareConcurrency")
    return { kind: "libCall", fn: "os.availableParallelism", args: [], type: F64, loc };
  if (access.name.text === "language" || access.name.text === "platform") {
    const fn = access.name.text === "language" ? "navigator.language" : "navigator.platform";
    return { kind: "libCall", fn, args: [], type: STRING, loc };
  }
  if (access.name.text === "languages")
    return { kind: "libCall", fn: "navigator.languages", args: [], type: DYN, loc };
  return refuseNavigator(
    lowerer,
    access,
    `navigator.${access.name.text}`,
    lowerer.checker.getSymbolAtLocation(access.name),
  );
}

/** The refusal for the `navigator` object itself or an unlowered member. */
export function refuseNavigator(
  lowerer: Lowerer,
  node: ts.Node,
  what: string,
  symbol?: ts.Symbol,
): never {
  return lowerer.noLowering(
    what,
    node,
    "navigator.locks (the Web Locks API) has no lowering",
    symbol ?? null,
  );
}

/** The navigator object as a value: the runtime's Navigator handle. */
export function navigatorValue(loc: SrcLoc): IrExpr {
  return { kind: "libCall", fn: "navigator.object", args: [], type: DYN, loc };
}
