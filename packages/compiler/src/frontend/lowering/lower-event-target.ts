/* Compiled subclasses of EventTarget and Event (`class Bus extends
 * EventTarget`, `class Ping extends Event`).
 *
 * Plain `new EventTarget()` / `new Event()` values are checked-dynamic
 * handles over the runtime engine (scr_event_target.c). A program class
 * extending either one roots at a runtime base class (%EventTarget /
 * %Event) whose instance prefix points at the same engine state: super()
 * creates it, and the backend embeds the prefix like the emitter's. The
 * inherited members lower here for typed receivers. Checked-dynamic
 * capsules of the instances are recognized by the runtime, so the
 * engine's own values are the instances themselves: a target's capsule is
 * its listeners' `this` and its events' target, and an Event subclass
 * instance is what its listeners receive. Property reads, writes and
 * method calls on those capsules reach the inherited members through the
 * class property dispatch (class-dynamic-dispatch.ts) and the runtime's
 * capsule hooks.
 *
 * Subclass members spelling an inherited member are fenced: the engine
 * reads its own state (the event's type, the target's listener lists)
 * and never calls an override.
 */
import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";
import type { ClassInfo } from "./lower-classes.js";
import { locOf } from "../program.js";
import { strLit } from "../../ir/build.js";
import {
  BOOL,
  DYN,
  RUNTIME_EVENT_CLASS,
  RUNTIME_EVENT_TARGET_CLASS,
  type IrExpr,
  type IrStmt,
  type IrType,
  type SrcLoc,
  VOID,
} from "../../ir/ir.js";

const HANDLE_EVENT_READER = "%event.handleEventOf";

/** A program that can register EventTarget listeners and declares a class
 * with a handleEvent method lifts `%event.handleEventOf(listener) =
 * listener.handleEvent`, a checked-dynamic read the class property
 * dispatch resolves through each class's compiled members (overrides and
 * own properties included). %main installs it for the engine, which reads
 * a capsule listener's handleEvent through it at every dispatch, as Node
 * does; class views alone carry fields, not methods. Called by the
 * EventTarget lowerings. */
export function noteEventListeners(lowerer: Lowerer, loc: SrcLoc): void {
  if (lowerer.handleEventReader) return;
  const declares = [...lowerer.classes.values()].some(
    (info) => !info.def.runtime && lowerer.findMethodOn(info, "handleEvent") !== null,
  );
  if (!declares) return;
  lowerer.handleEventReader = true;
  lowerer.liftedFns.push({
    name: HANDLE_EVENT_READER,
    params: [{ localId: "listener", name: "listener", type: DYN }],
    returnType: DYN,
    locals: [{ id: "listener", name: "listener", type: DYN, mutable: false }],
    body: [
      {
        kind: "return",
        value: {
          kind: "dynKeyGet",
          value: { kind: "varRef", localId: "listener", type: DYN, loc },
          key: strLit("handleEvent", loc),
          type: DYN,
          loc,
        },
        loc,
      },
    ],
    loc,
  });
}

/** %main's installation of the handleEvent reader, when one was lifted. */
export function handleEventReaderPrelude(lowerer: Lowerer, loc: SrcLoc): IrStmt[] {
  if (!lowerer.handleEventReader) return [];
  const reader: IrExpr = {
    kind: "dynFrom",
    value: {
      kind: "closure",
      fnName: HANDLE_EVENT_READER,
      captures: [],
      type: { kind: "func", params: [DYN], ret: DYN },
      loc,
    },
    type: DYN,
    loc,
  };
  return [
    {
      kind: "exprStmt",
      expr: { kind: "libCall", fn: "event.handleEventReader", args: [reader], type: VOID, loc },
      loc,
    },
  ];
}

/** The EventTarget methods compiled subclasses inherit. */
export const EVENT_TARGET_API_MEMBERS: ReadonlySet<string> = new Set([
  "addEventListener",
  "removeEventListener",
  "dispatchEvent",
]);

/** The Event methods compiled subclasses inherit. */
const EVENT_API_METHODS: ReadonlySet<string> = new Set([
  "preventDefault",
  "stopPropagation",
  "stopImmediatePropagation",
  "composedPath",
  "initEvent",
]);

/** The Event accessors compiled subclasses inherit (Event.prototype's). */
const EVENT_API_PROPERTIES: ReadonlySet<string> = new Set([
  "type",
  "target",
  "srcElement",
  "currentTarget",
  "eventPhase",
  "bubbles",
  "cancelable",
  "composed",
  "defaultPrevented",
  "returnValue",
  "cancelBubble",
  "timeStamp",
  "isTrusted",
]);

/** Whether `name` is an inherited member (accessor or method) of
 * `info`'s instances. */
export function eventTargetInheritedMember(
  info: ClassInfo | null | undefined,
  name: string,
): boolean {
  return eventTargetApiMembers(info)?.has(name) ?? false;
}

/** Every inherited Event member name (the subclass-member fence). */
export const EVENT_API_MEMBERS: ReadonlySet<string> = new Set([
  ...EVENT_API_METHODS,
  ...EVENT_API_PROPERTIES,
]);

/** Registers the runtime bases as ClassInfos (the emitter story): no
 * decl and no lowerable bodies; super() reaches them through event.*
 * libCalls. `new EventTarget()` takes no arguments; `new Event(type,
 * options)` takes the argument vector as one dyn array, which the runtime
 * validates like Node's constructor. */
export function registerBuiltinEventTargetClasses(lowerer: Lowerer): void {
  const loc = { file: "<builtin>", start: 0, end: 0 };
  const classes: [string, "target" | "event"][] = [
    [RUNTIME_EVENT_TARGET_CLASS, "target"],
    [RUNTIME_EVENT_CLASS, "event"],
  ];
  for (const [name, kind] of classes) {
    lowerer.classes.set(name, {
      def: { name, runtime: true, fields: [], loc },
      fields: new Map(),
      fieldOrder: [],
      methods: new Map(),
      decl: null,
      builtinEventTarget: kind,
      ctor: null,
      ctorParams: kind === "event" ? [{ type: DYN, mode: "dynRest" }] : [],
      base: null,
      subclasses: [],
      throwingSetters: [],
      staticFields: [],
    });
  }
}

/** The runtime base an `extends` expression names (the global EventTarget
 * or Event), or null. */
export function builtinEventTargetBaseOf(lowerer: Lowerer, expr: ts.Expression): ClassInfo | null {
  if (lowerer.isStdlibGlobal(expr, "EventTarget"))
    return lowerer.classes.get(RUNTIME_EVENT_TARGET_CLASS) ?? null;
  if (lowerer.isStdlibGlobal(expr, "Event"))
    return lowerer.classes.get(RUNTIME_EVENT_CLASS) ?? null;
  return null;
}

/** Which runtime base a class roots at, or null. */
export function eventTargetRootOf(info: ClassInfo | null | undefined): "target" | "event" | null {
  for (let c = info ?? null; c; c = c.base) if (c.builtinEventTarget) return c.builtinEventTarget;
  return null;
}

/** The inherited member names of a class rooted at a runtime base. */
export function eventTargetApiMembers(
  info: ClassInfo | null | undefined,
): ReadonlySet<string> | null {
  const root = eventTargetRootOf(info);
  return root === "target" ? EVENT_TARGET_API_MEMBERS : root === "event" ? EVENT_API_MEMBERS : null;
}

/** Whether `name` is an inherited method of a class rooted at a runtime
 * base. */
export function eventTargetApiMethod(info: ClassInfo | null | undefined, name: string): boolean {
  const root = eventTargetRootOf(info);
  return root === "target"
    ? EVENT_TARGET_API_MEMBERS.has(name)
    : root === "event" && EVENT_API_METHODS.has(name);
}

/** super() / super(type, options) into a runtime base. `args` is the
 * completed argument list: nothing for EventTarget, the dyn argument
 * vector for Event. */
export function eventTargetSuperCall(
  lowerer: Lowerer,
  base: ClassInfo,
  thisRef: IrExpr,
  args: IrExpr[],
  loc: SrcLoc,
): IrStmt {
  noteEventListeners(lowerer, loc);
  const receiver = lowerer.upcastTo(thisRef, base.def.name);
  const vector = args[0] ?? { kind: "dynArrLit", elems: [], type: DYN, loc };
  // super(type) with a string needs no argument vector.
  const only = vector.kind === "dynArrLit" && vector.elems.length === 1 ? vector.elems[0]! : null;
  const expr: IrExpr =
    base.builtinEventTarget === "target"
      ? { kind: "libCall", fn: "event.targetInit", args: [receiver], type: VOID, loc }
      : only?.kind === "dynFrom" && only.value.type.kind === "string"
        ? { kind: "libCall", fn: "event.initType", args: [receiver, only.value], type: VOID, loc }
        : { kind: "libCall", fn: "event.init", args: [receiver, vector], type: VOID, loc };
  return { kind: "exprStmt", expr, loc };
}

/** The receiver lowered once: a local or `this` is used as is; anything
 * else evaluates into a hidden local first. */
function singleReceiver(
  lowerer: Lowerer,
  receiver: IrExpr,
  loc: SrcLoc,
): { stmts: IrStmt[]; ref: IrExpr } {
  if (receiver.kind === "varRef") return { stmts: [], ref: receiver };
  const local = lowerer.declareHiddenLocal("%eventReceiver", receiver.type);
  return {
    stmts: [{ kind: "varDecl", localId: local.id, init: receiver, loc }],
    ref: { kind: "varRef", localId: local.id, type: receiver.type, loc },
  };
}

function withReceiver(stmts: IrStmt[], result: IrExpr, loc: SrcLoc): IrExpr {
  if (stmts.length === 0) return result;
  return { kind: "seqExpr", stmts, result, type: result.type, loc };
}

/** The dyn result of an inherited member, converted to the type the
 * checker gives the expression (void and checked-dynamic stay as is). */
function typedResult(lowerer: Lowerer, node: ts.Expression, value: IrExpr): IrExpr {
  const expected: IrType | null = lowerer.mapTypeOf(lowerer.typeOf(node));
  if (!expected || expected.kind === "void" || expected.kind === "dyn") return value;
  return lowerer.coerceToExpected(value, expected);
}

/** A call of an inherited EventTarget or Event method on a typed receiver
 * of a class rooted at a runtime base. Listener arguments cross as live
 * values (typed `handleEvent` records keep their identity), the rest as
 * checked-dynamic values. */
export function lowerEventTargetMethodCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
  info: ClassInfo,
  receiverExpr: IrExpr,
): IrExpr {
  const member = access.name.text;
  const loc = locOf(call);
  if (call.arguments.nodes.some(ts.isSpreadElement)) {
    lowerer.noLowering(`${member} with spread arguments`, call);
  }
  const target = eventTargetRootOf(info) === "target";
  if (target) noteEventListeners(lowerer, loc);
  const { stmts, ref } = singleReceiver(lowerer, receiverExpr, loc);
  const args = call.arguments.nodes.map((arg, index) =>
    target && index === 1 && member !== "dispatchEvent"
      ? lowerer.lowerLiveWebValue(arg)
      : lowerer.lowerExprExpecting(arg, DYN),
  );
  const self = (): IrExpr => lowerer.coerceToExpected(ref, DYN);
  if (target && member === "dispatchEvent" && args.length === 1) {
    const dispatched: IrExpr = {
      kind: "libCall",
      fn: "event.targetDispatch",
      args: [ref, self(), args[0]!],
      type: BOOL,
      loc,
    };
    return withReceiver(stmts, dispatched, loc);
  }
  const vector: IrExpr = { kind: "dynArrLit", elems: args, type: DYN, loc };
  const value: IrExpr = target
    ? {
        kind: "libCall",
        fn: "event.targetCall",
        args: [ref, self(), strLit(member, loc), vector],
        type: DYN,
        loc,
      }
    : {
        kind: "libCall",
        fn: "event.call",
        args: [ref, strLit(member, loc), vector],
        type: DYN,
        loc,
      };
  return typedResult(lowerer, call, withReceiver(stmts, value, loc));
}

/** A read of an inherited member on a typed receiver (an Event accessor,
 * or a method read as a value), or null when the access is not one. */
export function lowerEventObjectProperty(
  lowerer: Lowerer,
  expr: ts.PropertyAccessExpression,
): IrExpr | null {
  if (expr.questionDotToken && !lowerer.chainHandled.has(expr)) return null;
  const name = expr.name.text;
  const recvT = lowerer.mapTypeOf(lowerer.typeOf(expr.expression));
  if (recvT?.kind !== "object") return null;
  const info = lowerer.classes.get(recvT.className);
  if (!eventTargetApiMembers(info)?.has(name)) return null;
  const loc = locOf(expr);
  const receiver = lowerer.lowerExpr(expr.expression);
  if (receiver.type.kind !== "object") return null;
  // Accessors read the event directly; method values come from the
  // capsule view (the prototype's function, run on its `this`).
  const value: IrExpr = EVENT_API_PROPERTIES.has(name)
    ? { kind: "libCall", fn: "event.get", args: [receiver, strLit(name, loc)], type: DYN, loc }
    : {
        kind: "dynKeyGet",
        value: lowerer.coerceToExpected(receiver, DYN),
        key: strLit(name, loc),
        type: DYN,
        loc,
      };
  return typedResult(lowerer, expr, value);
}

/** Whether `target` is `returnValue` or `cancelBubble` (the two writable
 * accessors) on a typed receiver of an Event subclass. */
export function isEventWritableAccessor(
  lowerer: Lowerer,
  target: ts.PropertyAccessExpression,
): boolean {
  const name = target.name.text;
  if (name !== "returnValue" && name !== "cancelBubble") return false;
  if (target.questionDotToken) return false;
  const recvT = lowerer.mapTypeOf(lowerer.typeOf(target.expression));
  if (recvT?.kind !== "object") return false;
  return eventTargetRootOf(lowerer.classes.get(recvT.className)) === "event";
}

/** The event.set write of an Event subclass's writable accessor. */
export function eventAccessorWrite(
  receiver: IrExpr,
  name: string,
  value: IrExpr,
  lowerer: Lowerer,
  loc: SrcLoc,
): IrStmt {
  return {
    kind: "exprStmt",
    expr: {
      kind: "libCall",
      fn: "event.set",
      args: [receiver, strLit(name, loc), lowerer.coerceToExpected(value, DYN)],
      type: VOID,
      loc,
    },
    loc,
  };
}

/** The event.get read of an Event subclass's writable accessor, typed as
 * the accessor's boolean. */
export function eventAccessorRead(
  receiver: IrExpr,
  name: string,
  lowerer: Lowerer,
  loc: SrcLoc,
): IrExpr {
  return lowerer.coerceToExpected(
    { kind: "libCall", fn: "event.get", args: [receiver, strLit(name, loc)], type: DYN, loc },
    BOOL,
  );
}

/** `event.returnValue = v` / `event.cancelBubble = v` on a typed receiver
 * of an Event subclass, in statement or value position, or null when the
 * target is not one. The receiver evaluates before the value, and the
 * expression's value is the assigned one, whatever the setter does. */
export function lowerEventObjectPropertyWrite(
  lowerer: Lowerer,
  target: ts.PropertyAccessExpression,
  value: ts.Expression,
): IrExpr | null {
  if (!isEventWritableAccessor(lowerer, target)) return null;
  const loc = locOf(target);
  const receiver = lowerer.lowerExpr(target.expression);
  const receiverLocal = lowerer.declareHiddenLocal("%eventReceiver", receiver.type);
  const receiverRef: IrExpr = {
    kind: "varRef",
    localId: receiverLocal.id,
    type: receiver.type,
    loc,
  };
  const assigned = lowerer.lowerExpr(value);
  const local = lowerer.declareHiddenLocal("%eventAssigned", assigned.type);
  const ref: IrExpr = { kind: "varRef", localId: local.id, type: assigned.type, loc };
  return {
    kind: "seqExpr",
    stmts: [
      { kind: "varDecl", localId: receiverLocal.id, init: receiver, loc },
      { kind: "varDecl", localId: local.id, init: assigned, loc },
      eventAccessorWrite(receiverRef, target.name.text, ref, lowerer, loc),
    ],
    result: ref,
    type: assigned.type,
    loc,
  };
}
