import * as ts from "../../ts7/adapter.js";
import { type Lowerer } from "../lowerer.js";
import { locOf } from "../../program.js";
import { dynUndefinedExpr } from "../../../ir/build.js";
import { BOOL, DYN, type IrExpr, type IrLibFn } from "../../../ir/ir.js";
import { lowerDynObjectLiteral } from "../expressions/object-literals.js";
import { builtinImportOf } from "./module-bindings.js";

/* node:net's SocketAddress and BlockList are native checked-dynamic
 * handles (scr_net.c): both types map to dyn, their getters are handle
 * property reads, their methods dispatch through the handle, and these
 * helpers lower the class's uses that a dyn value cannot answer by
 * itself (construction, the static members and instanceof). */

type NetAddressClass = "SocketAddress" | "BlockList";

/** The SocketAddress or BlockList class in any node:net spelling. */
export function netAddressClassOf(lowerer: Lowerer, node: ts.Expression): NetAddressClass | null {
  const builtin = ts.isIdentifier(node)
    ? builtinImportOf(lowerer, node)
    : ts.isPropertyAccessExpression(node) && !node.questionDotToken
      ? lowerer.builtinMemberOf(node)
      : null;
  if (builtin?.module !== "net") return null;
  return builtin.member === "SocketAddress" || builtin.member === "BlockList"
    ? builtin.member
    : null;
}

/** The class of a stdlib SocketAddress- or BlockList-typed value. */
function netAddressValueClass(lowerer: Lowerer, node: ts.Expression): NetAddressClass | null {
  const type = lowerer.typeOf(node);
  const sym = type.getAliasSymbol() ?? type.getSymbol();
  if (!sym) return null;
  const name = ts.symbolName(sym);
  if (name !== "SocketAddress" && name !== "BlockList") return null;
  return lowerer.isStdlibSymbol(sym) ? name : null;
}

/** `new SocketAddress(options?)` and `new BlockList()`: the argument
 * vector goes to the runtime, which validates it in Node's order. */
export function lowerNetAddressNew(lowerer: Lowerer, expr: ts.NewExpression): IrExpr | null {
  const cls = netAddressClassOf(lowerer, expr.expression);
  if (cls === null) return null;
  const args = expr.arguments?.nodes ?? [];
  if (args.some(ts.isSpreadElement)) return null;
  const loc = locOf(expr);
  const values = args.map((arg) =>
    ts.isObjectLiteralExpression(arg)
      ? lowerDynObjectLiteral(lowerer, arg)
      : lowerer.lowerExprExpecting(arg, DYN),
  );
  return {
    kind: "libCall",
    fn: cls === "SocketAddress" ? "net.socketAddressNew" : "net.blockListNew",
    args: [{ kind: "dynArrLit", elems: values, type: DYN, loc }],
    type: DYN,
    loc,
  };
}

const STATIC_CALLS: Record<
  string,
  { cls: NetAddressClass; fn: IrLibFn; result: typeof DYN | typeof BOOL }
> = {
  parse: { cls: "SocketAddress", fn: "net.socketAddressParse", result: DYN },
  isSocketAddress: { cls: "SocketAddress", fn: "net.isSocketAddress", result: BOOL },
  isBlockList: { cls: "BlockList", fn: "net.isBlockList", result: BOOL },
};

const INSTANCE_METHODS: Record<NetAddressClass, ReadonlySet<string>> = {
  SocketAddress: new Set(["toJSON"]),
  BlockList: new Set([
    "addAddress",
    "addAddresses",
    "addRange",
    "addSubnet",
    "addCIDR",
    "addCIDRs",
    "removeAddress",
    "removeRange",
    "removeSubnet",
    "removeCIDR",
    "clear",
    "check",
    "toJSON",
    "fromJSON",
  ]),
};

/** SocketAddress.parse(), SocketAddress.isSocketAddress() and
 * BlockList.isBlockList(); and the instance methods, which the handle
 * answers as methods, so they dispatch through dynInvoke rather than as
 * a member read and a call. */
export function lowerNetAddressCall(lowerer: Lowerer, call: ts.CallExpression): IrExpr | null {
  if (call.questionDotToken || !ts.isPropertyAccessExpression(call.expression)) return null;
  const access = call.expression;
  if (access.questionDotToken || call.arguments.nodes.some(ts.isSpreadElement)) return null;
  const name = access.name.text;
  const loc = locOf(call);
  const statics = Object.hasOwn(STATIC_CALLS, name) ? STATIC_CALLS[name]! : null;
  if (statics !== null && netAddressClassOf(lowerer, access.expression) === statics.cls) {
    // The member takes one value; any others still evaluate, in order.
    const args = call.arguments.nodes.map((arg) => lowerer.lowerExprExpecting(arg, DYN));
    const first: IrExpr = args[0] ?? dynUndefinedExpr(loc);
    const result: IrExpr = {
      kind: "libCall",
      fn: statics.fn,
      args: [first],
      type: statics.result,
      loc,
    };
    if (args.length <= 1) return result;
    const local = lowerer.declareHiddenLocal("%netAddressResult", statics.result);
    return {
      kind: "seqExpr",
      stmts: [
        { kind: "varDecl", localId: local.id, init: result, loc },
        ...args.slice(1).map((arg) => ({ kind: "exprStmt" as const, expr: arg, loc: arg.loc })),
      ],
      result: { kind: "varRef", localId: local.id, type: statics.result, loc },
      type: statics.result,
      loc,
    };
  }
  const cls = netAddressValueClass(lowerer, access.expression);
  if (cls === null || !INSTANCE_METHODS[cls].has(name)) return null;
  return {
    kind: "dynInvoke",
    recv: lowerer.lowerExprExpecting(access.expression, DYN),
    method: name,
    calleeName: ts.getTextOfNode(access),
    args: call.arguments.nodes.map((arg) => lowerer.lowerExprExpecting(arg, DYN)),
    type: DYN,
    loc,
  };
}

/** `BlockList.PRIVATE_RANGES`: one frozen array of CIDR strings. */
export function lowerNetAddressStaticRead(
  lowerer: Lowerer,
  expr: ts.PropertyAccessExpression,
): IrExpr | null {
  if (expr.questionDotToken || expr.name.text !== "PRIVATE_RANGES") return null;
  if (netAddressClassOf(lowerer, expr.expression) !== "BlockList") return null;
  return {
    kind: "libCall",
    fn: "net.blockListPrivateRanges",
    args: [],
    type: DYN,
    loc: locOf(expr),
  };
}

/** `v instanceof SocketAddress` / `v instanceof BlockList`. */
export function lowerNetAddressInstanceof(
  lowerer: Lowerer,
  expr: ts.BinaryExpression,
): IrExpr | null {
  const cls = netAddressClassOf(lowerer, expr.right);
  if (cls === null) return null;
  const value = lowerer.coerceInto(expr.left, lowerer.lowerExpr(expr.left), DYN);
  return {
    kind: "libCall",
    fn: cls === "SocketAddress" ? "net.isSocketAddress" : "net.isBlockList",
    args: [value],
    type: BOOL,
    loc: locOf(expr),
  };
}
