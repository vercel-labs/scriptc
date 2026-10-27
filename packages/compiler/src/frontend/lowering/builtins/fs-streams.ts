/** fs.ReadStream / fs.WriteStream members (scr_fs_stream.c). The
 * instances are runtime Readable / Writable streams; the members the fs
 * classes add (bytesRead, bytesWritten, pending, path, close) lower here,
 * and everything inherited goes through the stream spoke. */
import * as ts from "../../ts7/adapter.js";
import { type Lowerer } from "../lowerer.js";
import { isJsSourceFile, locOf } from "../../program.js";
import { isNodeTypesPath } from "../../dts-paths.js";
import { dynUndefinedExpr } from "../../../ir/build.js";
import {
  BOOL,
  DYN,
  F64,
  type IrExpr,
  type IrLibFn,
  type SrcLoc,
  VOID,
  funcOf,
} from "../../../ir/ir.js";

function isFsFallbackDecl(lowerer: Lowerer, d: ts.Node): boolean {
  const file = ts.getSourceFileOfNode(d);
  if (!lowerer.isStdlibFile(file) || isNodeTypesPath(file.fileName)) return false;
  for (let node: ts.Node | undefined = d.parent; node; node = node.parent) {
    if (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name)) {
      return node.name.text === "fs" || node.name.text === "node:fs";
    }
  }
  return false;
}

/** True when the accessed member is declared on the fallback
 * fs.ReadStream / fs.WriteStream classes. */
export function isFsStreamMember(lowerer: Lowerer, access: ts.PropertyAccessExpression): boolean {
  const symbol = lowerer.checker.getSymbolAtLocation(access.name);
  if (!symbol) return false;
  return symbol.declarations.some(
    (d) =>
      d.parent !== undefined &&
      ts.isClassDeclaration(d.parent) &&
      (d.parent.name?.text === "ReadStream" || d.parent.name?.text === "WriteStream") &&
      isFsFallbackDecl(lowerer, d.parent),
  );
}

/** bytesRead / bytesWritten / pending / path reads. Null for other
 * names. */
export function lowerFsStreamProperty(
  lowerer: Lowerer,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  const name = access.name.text;
  const loc = locOf(access);
  const fn: IrLibFn | null =
    name === "bytesRead" || name === "bytesWritten"
      ? "fs.fsStreamBytes"
      : name === "pending"
        ? "fs.fsStreamPending"
        : name === "path"
          ? "fs.fsStreamPath"
          : null;
  if (fn === null) return null;
  const receiver = lowerer.lowerExpr(access.expression);
  if (fn !== "fs.fsStreamPath") {
    return {
      kind: "libCall",
      fn,
      args: [receiver],
      type: fn === "fs.fsStreamBytes" ? F64 : BOOL,
      loc,
    };
  }
  // path keeps the value as given (a string, or a Buffer); the checked
  // conversion lands it in the declared `string | Buffer`.
  const value: IrExpr = { kind: "libCall", fn, args: [receiver], type: DYN, loc };
  const type = lowerer.mapTypeOf(lowerer.typeOf(access)) ?? DYN;
  return type.kind === "dyn" ? value : { kind: "dynCheck", value, type, loc };
}

/** close() / close(cb) with a `() => void` callback. */
export function lowerFsStreamMethodCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (access.name.text !== "close") return null;
  const loc = locOf(call);
  const args = call.arguments.nodes;
  if (args.some(ts.isSpreadElement)) lowerer.noLowering("close with spread arguments", call);
  if (args.length > 1) lowerer.noLowering(`close with ${args.length} arguments`, call);
  const receiver = lowerer.lowerExpr(access.expression);
  if (args[0] === undefined) {
    return { kind: "libCall", fn: "fs.fsStreamClose", args: [receiver], type: VOID, loc };
  }
  const cb = lowerer.lowerExprExpecting(args[0], funcOf([], VOID));
  if (cb.type.kind !== "func" || cb.type.params.length > 0) {
    lowerer.noLowering(
      "fs stream close callbacks taking arguments",
      args[0],
      "() => void callbacks are supported (listen for 'error' to observe failures)",
    );
  }
  return { kind: "libCall", fn: "fs.fsStreamCloseCb", args: [receiver, cb], type: VOID, loc };
}

/** fs.createReadStream / createWriteStream(path[, options]) and their
 * constructor spellings: the path and options cross as dyn values, so
 * literal and computed options take the runtime's Node-order checks. The
 * result is a runtime Readable or Writable stream. */
export function fsStreamCreateExpr(
  lowerer: Lowerer,
  args: readonly ts.Expression[],
  readable: boolean,
  what: string,
  site: ts.Node,
  loc: SrcLoc,
): IrExpr {
  if (args.some(ts.isSpreadElement)) lowerer.noLowering(`${what} with spread arguments`, site);
  if (args.length > 2) {
    lowerer.noLowering(
      `${what} with ${args.length} arguments`,
      args[2]!,
      "the supported form takes a path and an options value",
    );
  }
  const asDyn = (node: ts.Expression | undefined, part: string): IrExpr => {
    if (node === undefined) return dynUndefinedExpr(loc);
    const raw = lowerer.lowerExpr(node);
    if (raw.type.kind === "dyn") return raw;
    if (raw.kind === "unitLit" || lowerer.dynConvertible(raw.type)) {
      return { kind: "dynFrom", value: raw, type: DYN, loc };
    }
    return lowerer.noLowering(
      `${what} with a '${lowerer.fmt(raw.type)}' ${part}`,
      node,
      "the path is a string, Buffer or URL and the options an encoding string or a plain object",
    );
  };
  const path = asDyn(args[0], "path");
  const options = asDyn(args[1], "options value");
  return {
    kind: "libCall",
    fn: readable ? "fs.createReadStream" : "fs.createWriteStream",
    args: [path, options],
    type: { kind: "object", className: readable ? "%Readable" : "%Writable" },
    loc,
  };
}

/** The fs stream class a constructor symbol names ("ReadStream" or
 * "WriteStream" from the fallback declarations), or null. */
export function fsStreamClassOf(
  lowerer: Lowerer,
  symbol: ts.Symbol | null | undefined,
): "ReadStream" | "WriteStream" | null {
  if (!symbol) return null;
  const name = ts.symbolName(symbol);
  if (name !== "ReadStream" && name !== "WriteStream") return null;
  const declared = symbol.declarations.some(
    (d) => ts.isClassDeclaration(d) && isFsFallbackDecl(lowerer, d),
  );
  return declared ? name : null;
}

/** `new fs.ReadStream(path, options)` / `new fs.WriteStream(...)`: the
 * createReadStream / createWriteStream stream. */
export function lowerFsStreamNew(
  lowerer: Lowerer,
  expr: ts.NewExpression,
  cls: "ReadStream" | "WriteStream",
): IrExpr {
  return fsStreamCreateExpr(
    lowerer,
    expr.arguments?.nodes ?? [],
    cls === "ReadStream",
    `new fs.${cls}`,
    expr,
    locOf(expr),
  );
}

/** `fs.ReadStream(path, options)` / `fs.WriteStream(...)` called without
 * `new` in JavaScript: Node's stream constructors construct when called as
 * functions, so the call is the `new` form. Null for other calls. */
export function lowerFsStreamCall(lowerer: Lowerer, expr: ts.CallExpression): IrExpr | null {
  if (!isJsSourceFile(ts.getSourceFileOfNode(expr))) return null;
  const callee = expr.expression;
  const name = ts.isPropertyAccessExpression(callee)
    ? callee.name
    : ts.isIdentifier(callee)
      ? callee
      : null;
  if (name === null || !ts.isIdentifier(name)) return null;
  const symbol = lowerer.checker.getSymbolAtLocation(name);
  const resolved =
    symbol && symbol.flags & ts.SymbolFlags.Alias
      ? lowerer.checker.getAliasedSymbol(symbol)
      : symbol;
  const cls = fsStreamClassOf(lowerer, resolved);
  if (cls === null) return null;
  return fsStreamCreateExpr(
    lowerer,
    expr.arguments.nodes,
    cls === "ReadStream",
    `fs.${cls}`,
    expr,
    locOf(expr),
  );
}
