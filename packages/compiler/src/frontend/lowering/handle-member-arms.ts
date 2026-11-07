/* A native handle seen through no type (`any`, `unknown`, a JavaScript
 * parameter) is a handle boxed by reference. Its members then come from the
 * unit's own run-time dispatch, which answers fewer of them than the typed
 * lowering compiles: `(socket as any).setRecvBufferSize(8192)` threw where
 * `socket.setRecvBufferSize(8192)` compiled.
 *
 * A member in a handle member table (handle-members.ts) is served on such a
 * receiver through the same builtin the typed lowering calls. A call that
 * names the member on a dynamic value goes through a helper that tests the
 * receiver for the handle kind and its arguments for the builtin's
 * parameter types, calls the builtin when they hold, and otherwise does
 * what the call did before. Two call shapes name a member:
 *
 *   dynInvoke(recv, "name", args)             a JavaScript method call
 *   dynCall(callee, receiver, "x.name", args) "read the member, call it":
 *                                             the callee is the value the
 *                                             member read answered
 *
 * For the second shape the helper also requires the read to have answered
 * undefined, which is what a handle's dynamic view answers for a member it
 * does not carry; a member the view does carry keeps its own function.
 *
 * Only a program that creates a handle of a table's class gets the helpers
 * (Lowerer.createsMemberTableHandles), and only for the kinds its IR holds;
 * every other program lowers as before. A computed member name
 * (`socket[name]()`) reaches the run-time dispatch as before. */
import { boolLit, dynUndefinedExpr, varRef } from "../../ir/build.js";
import {
  BOOL,
  DYN,
  STRING,
  type IrExpr,
  type IrFunction,
  type IrParam,
  type IrStmt,
  type IrType,
  type SrcLoc,
} from "../../ir/ir.js";
import { everyStmtList, transformStmtList } from "../../ir/traverse.js";
import {
  HANDLE_MEMBER_CLASSES,
  handleMemberSignature,
  type HandleMember,
  type HandleMemberClass,
} from "./handle-members.js";
import type { Lowerer } from "./lowerer.js";

type Invoke = Extract<IrExpr, { kind: "dynInvoke" }>;
type Call = Extract<IrExpr, { kind: "dynCall" }>;

/** The dynTest a dynamic argument must pass to be the builtin's parameter. */
function parameterTest(type: IrType): "number" | "string" | "boolean" | null {
  if (type.kind === "f64") return "number";
  if (type.kind === "string") return "string";
  if (type.kind === "bool") return "boolean";
  return null;
}

/** The member a "read the member, call it" call names: the callee text is
 * the receiver's text, a dot and the member name. */
function calledMember(call: Call): string | null {
  if (call.receiver === undefined || call.spreads !== undefined) return null;
  const dot = call.calleeName.lastIndexOf(".");
  return dot < 0 ? null : call.calleeName.slice(dot + 1);
}

/** The statements of one class's arm: when `recv` is the class's handle and
 * the arguments are the member's parameters, call the builtin and return
 * what Node returns. Null when the member does not take `argc` arguments. */
function memberArm(
  cls: HandleMemberClass,
  member: HandleMember,
  recv: IrExpr,
  args: readonly IrExpr[],
  extra: IrExpr | null,
  loc: SrcLoc,
): IrStmt | null {
  const { params, result } = handleMemberSignature(member);
  if (args.length > params.length || args.length < params.length - (member.optional ?? 0))
    return null;
  let cond: IrExpr = {
    kind: "dynTest",
    test: "handle",
    handleKind: cls.type.kind,
    value: recv,
    type: BOOL,
    loc,
  };
  if (extra !== null)
    cond = { kind: "logical", op: "&&", left: extra, right: cond, type: BOOL, loc };
  const lowered: IrExpr[] = [{ kind: "dynCheck", value: recv, type: cls.type, loc }];
  for (let i = 0; i < params.length; i++) {
    const param = params[i]!;
    const arg = args[i];
    if (arg === undefined) {
      // An omitted trailing parameter is the empty string; the builtin's
      // last argument says it was not given.
      lowered.push({ kind: "strLit", value: "", type: STRING, loc });
      continue;
    }
    const test = parameterTest(param);
    if (test === null) return null;
    cond = {
      kind: "logical",
      op: "&&",
      left: cond,
      right: { kind: "dynTest", test, value: arg, type: BOOL, loc },
      type: BOOL,
      loc,
    };
    lowered.push({ kind: "dynCheck", value: arg, type: param, loc });
  }
  if (member.optional !== undefined) lowered.push(boolLit(args.length === params.length, loc));
  const call: IrExpr = { kind: "libCall", fn: member.fn, args: lowered, type: result, loc };
  const then: IrStmt[] =
    result.kind === "void"
      ? [
          { kind: "exprStmt", expr: call, loc },
          { kind: "return", value: dynUndefinedExpr(loc), loc },
        ]
      : [{ kind: "return", value: { kind: "dynFrom", value: call, type: DYN, loc }, loc }];
  return { kind: "if", cond, then, else_: null, loc };
}

/** Serves table members on dynamic receivers, in place. */
export function applyHandleMemberArms(lowerer: Lowerer, functions: IrFunction[]): void {
  if (!lowerer.createsMemberTableHandles) return;
  // The classes whose handles this program's IR holds, and the functions
  // with a call that names one of their members.
  const present = new Set<string>();
  const sites = new Set<IrFunction>();
  const named = (name: string): boolean =>
    HANDLE_MEMBER_CLASSES.some((cls) => Object.hasOwn(cls.table, name));
  for (const fn of functions) {
    everyStmtList(fn.body, {
      stmt: () => true,
      expr: (e) => {
        if (HANDLE_MEMBER_CLASSES.some((cls) => cls.type.kind === e.type.kind))
          present.add(e.type.kind);
        if (e.kind === "dynInvoke" && named(e.method)) sites.add(fn);
        else if (e.kind === "dynCall") {
          const member = calledMember(e);
          if (member !== null && named(member)) sites.add(fn);
        }
        return true;
      },
    });
  }
  const classes = HANDLE_MEMBER_CLASSES.filter((cls) => present.has(cls.type.kind));
  if (classes.length === 0 || sites.size === 0) return;

  const helpers = new Map<string, string>();
  /** The helper for `name` called with `argc` arguments in one of the two
   * shapes, or null when no present class takes the member that way. */
  const helperFor = (shape: "invoke" | "call", name: string, argc: number, loc: SrcLoc) => {
    const key = `${shape}.${name}.${argc}`;
    const known = helpers.get(key);
    if (known !== undefined) return known === "" ? null : known;
    const recv = varRef("p.recv", DYN, loc);
    const callee = varRef("p.callee", DYN, loc);
    const calleeName = varRef("p.calleeName", STRING, loc);
    const args = Array.from({ length: argc }, (_, i) => varRef(`p.${i}`, DYN, loc));
    const unanswered: IrExpr | null =
      shape === "call"
        ? { kind: "dynTest", test: "undefined", value: callee, type: BOOL, loc }
        : null;
    const arms: IrStmt[] = [];
    for (const cls of classes) {
      if (!Object.hasOwn(cls.table, name)) continue;
      const arm = memberArm(cls, cls.table[name]!, recv, args, unanswered, loc);
      if (arm !== null) arms.push(arm);
    }
    if (arms.length === 0) {
      helpers.set(key, "");
      return null;
    }
    const params: IrParam[] = [
      { localId: "p.recv", name: "receiver", type: DYN },
      ...(shape === "call" ? [{ localId: "p.callee", name: "callee", type: DYN }] : []),
      ...args.map((_, i) => ({ localId: `p.${i}`, name: `argument${i}`, type: DYN })),
      { localId: "p.calleeName", name: "calleeName", type: STRING },
    ];
    const fallback: IrExpr =
      shape === "call"
        ? {
            kind: "dynCall",
            callee,
            receiver: recv,
            calleeName: name,
            calleeNameValue: calleeName,
            args,
            type: DYN,
            loc,
          }
        : {
            kind: "dynInvoke",
            recv,
            method: name,
            calleeName: name,
            calleeNameValue: calleeName,
            args,
            type: DYN,
            loc,
          };
    const helper: IrFunction = {
      name: `%handle.member.${key}`,
      params,
      returnType: DYN,
      locals: params.map((p) => ({ id: p.localId, name: p.name, type: p.type, mutable: false })),
      body: [...arms, { kind: "return", value: fallback, loc }],
      loc,
    };
    functions.push(helper);
    helpers.set(key, helper.name);
    return helper.name;
  };

  const rewrite = (e: IrExpr): IrExpr => {
    if (e.kind === "dynInvoke" && named(e.method)) {
      const invoke: Invoke = e;
      const helper = helperFor("invoke", invoke.method, invoke.args.length, invoke.loc);
      if (helper === null) return e;
      return {
        kind: "call",
        callee: helper,
        args: [
          invoke.recv,
          ...invoke.args,
          invoke.calleeNameValue ?? {
            kind: "strLit",
            value: invoke.calleeName,
            type: STRING,
            loc: invoke.loc,
          },
        ],
        type: DYN,
        loc: invoke.loc,
      };
    }
    if (e.kind === "dynCall" && e.calleeNameValue === undefined) {
      // A call whose callee text is computed names no member statically.
      const member = calledMember(e);
      if (member === null || !named(member)) return e;
      const helper = helperFor("call", member, e.args.length, e.loc);
      if (helper === null) return e;
      return {
        kind: "call",
        callee: helper,
        args: [
          e.receiver!,
          e.callee,
          ...e.args,
          { kind: "strLit", value: e.calleeName, type: STRING, loc: e.loc },
        ],
        type: DYN,
        loc: e.loc,
      };
    }
    return e;
  };
  for (const fn of sites) fn.body = transformStmtList(fn.body, { expr: rewrite, stmt: (s) => s });
}
