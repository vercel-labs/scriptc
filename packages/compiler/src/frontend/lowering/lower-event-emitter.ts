/* The node:events EventEmitter lowering (the spoke-module pattern, like
 * lower-server.ts): every EMITTER_API_MEMBERS method call on a receiver
 * whose class roots at %EventEmitter lands here, from
 * lowerObjectMethodCall.
 *
 * THE TYPING STANCE. Node types EventEmitter untyped — `emit(name,
 * ...args: any[])`, listeners `(...args: any[]) => void` — which has no
 * static lowering. Literal names use per-event monomorphization: each
 * name gets ONE argument tuple, unified across the whole program (a
 * pre-pass scans every emit site's argument types
 * and every registered listener's annotated parameter types). Emit sites
 * must supply exactly the tuple; listeners may declare any PREFIX of it
 * (Node calls listeners with all arguments; extra parameters would read
 * undefined and have no honest type). The table is program-global, not
 * per-class: every emitter class shares the %EventEmitter root and
 * upcasts alias freely, so per-class tables would be unsound. The JS
 * lane's unannotated listeners (checker `any` — dyn) do not fence: they
 * register through the checked-dynamic boundary (lowerDynListenerCall —
 * emit arguments box to dyn, JS-exact arity, the original kept as the
 * registry entry's identity). Computed string names with a provable
 * constant prefix or suffix use a checked-dynamic callback and exact-arity
 * argument vector instead. The pattern must exclude internal error, meta,
 * and stream events; literal names it may reach take the same path. The
 * same vector handles varying or inference-unknown JavaScript emit tuples
 * when every known listener accepts checked-dynamic parameters or no
 * parameters. Typed listener constraints keep the fixed-tuple refusal.
 * The remaining cases are fenced:
 * unrestricted names, symbol names, conflicting literal tuples, the
 * meta-events' listener-function argument (meta listeners take at most
 * the event name; dyn meta listeners fence — Node
 * passes the listener function second, which has no dyn conversion), and
 * listeners()/rawListeners() of an event with any dynamic
 * registration (the bucket has no one honest element type).
 *
 * Two special names: 'error' is forced to the one-%Error tuple (emit
 * routes through emitter.emitError — no listener means the payload
 * THROWS, Node's contract — and subclass payloads upcast to the root);
 * 'newListener'/'removeListener' are forced to the one-string tuple (the
 * runtime emits them internally with the affected event's name).
 *
 * One member is overridable: `emit`, in the forwarding shape — see the
 * emit-overrides block at the bottom of this file (per-event
 * monomorphization of the override body, dispatch on the dynamic class,
 * super.emit as the prototype chain). */
import { keyedHelperName } from "./stable-names.js";
import { checkKeypressListener } from "./builtins/readline.js";
import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";
import { dynFallbackType, newFnCtx } from "./lowerer.js";
import type { ClassInfo } from "./lower-classes.js";
import { isJsSourceFile, locOf } from "../program.js";
import {
  arrayOf,
  BOOL,
  canBoxFuncIntoDyn,
  canConvertToDyn,
  canDynCheckTo,
  isDynTypedRefType,
  DYN,
  F64,
  type IrExpr,
  type IrFunction,
  type IrLocal,
  type IrParam,
  type IrStmt,
  type IrType,
  isUnitType,
  STRING,
  type SrcLoc,
  typeEquals,
  typeKey,
  VOID,
} from "../../ir/ir.js";
import { STREAM_FORCED_EVENT_NAMES, streamForcedTuple, streamSidesOf } from "./lower-stream.js";
import { boolLit, dynUndefinedExpr, strLit, varRef } from "../../ir/build.js";
import { tryLowerExpression } from "./expressions/try-lower-expression.js";
import { lowerAddAbortListener } from "./builtin-calls.js";
import { requestGeneralStreamSurface } from "./general-streams.js";
import { nodeStreamInterfaceSide } from "./dyn-streams.js";

/** True when the class descends from (or is) the runtime emitter. */
export function emitterRooted(lowerer: Lowerer, info: ClassInfo | undefined | null): boolean {
  for (let c: ClassInfo | null = info ?? null; c; c = c.base) {
    if (c.builtinEmitter) return true;
  }
  return false;
}

const REGISTER_MEMBERS: ReadonlySet<string> = new Set([
  "on",
  "addListener",
  "once",
  "prependListener",
  "prependOnceListener",
]);

const META_EVENTS: ReadonlySet<string> = new Set(["newListener", "removeListener"]);

export interface EventSig {
  /** The unified argument tuple, positions in emit order. */
  tuple: IrType[];
  /** True once ANY emit site pinned the arity/types (listeners may then
   * only prefix it; without one, the longest listener defines the tuple). */
  fromEmit: boolean;
  /** A human-readable conflict, reported at every touching site. */
  conflict: string | null;
  /** True when ANY registration site's listener is dyn-flavored (a
   * checked-dynamic value, or a function whose parameters include dyn —
   * the JS lane's unannotated listeners). Such listeners register through
   * a dyn-converting adapter; they impose no tuple constraint (a dyn
   * parameter takes anything, including undefined beyond the tuple), and
   * the event's runtime bucket may hold originals of MIXED signatures —
   * so listeners()/rawListeners() have no one honest element type. */
  dynListener: boolean;
  /** At least one literal-name registration exists for this event. */
  hasListener: boolean;
  /** JS emits may have varying arity/types or inference-only payloads. */
  jsEmit?: true;
  unmappedEmit?: true;
  /** A listener with any concrete parameter still needs the fixed ABI. */
  typedListener?: true;
}

function flexibleJsEvent(name: string, sig: EventSig | undefined): boolean {
  // A stream may be upcast to EventEmitter. Its runtime-emitted payloads
  // keep their fixed ABI even when the static receiver looks ordinary.
  return (
    !STREAM_FORCED_EVENT_NAMES.has(name) &&
    sig?.jsEmit === true &&
    sig.typedListener !== true &&
    (sig.unmappedEmit === true || sig.conflict !== null)
  );
}

export interface ComputedEventPattern {
  prefix: string;
  suffix: string;
  listener: boolean;
}

function scannedEmitterInfo(lowerer: Lowerer, receiver: IrType | null): ClassInfo | null {
  if (!receiver) return null;
  let className: string;
  if (receiver.kind === "object") {
    className = receiver.className;
  } else if (receiver.kind === "union") {
    const arms = lowerer.unions.get(receiver.unionId)?.arms ?? [];
    const objects = arms.filter((arm): boolean => arm.kind === "object");
    const object = objects[0];
    if (
      objects.length !== 1 ||
      object?.kind !== "object" ||
      !arms.every((arm) => arm.kind === "object" || isUnitType(arm))
    )
      return null;
    className = object.className;
  } else {
    return null;
  }
  const info = lowerer.classes.get(className) ?? null;
  return emitterRooted(lowerer, info) ? info : null;
}

function computedPatternOverlapsReserved(pattern: ComputedEventPattern): boolean {
  return (
    ["error", "newListener", "removeListener"].some((name) => patternMatchesName(pattern, name)) ||
    [...STREAM_FORCED_EVENT_NAMES].some((name) => patternMatchesName(pattern, name))
  );
}

/** The program-wide event-signature table, built lazily on the first
 * emitter lowering (class shapes are collected before any body lowers, so
 * receiver classes resolve). The scan is DIAGNOSTIC-FREE: unmappable
 * types and non-literal names are simply not candidates — the touching
 * sites speak for themselves when they lower. */
function emitterEvents(lowerer: Lowerer): Map<string, EventSig> {
  if (lowerer.emitterEventTable) return lowerer.emitterEventTable;
  const table = new Map<string, EventSig>();
  const computedPatterns: ComputedEventPattern[] = [];
  const sigOf = (name: string): EventSig => {
    let sig = table.get(name);
    if (!sig)
      table.set(
        name,
        (sig = {
          tuple: [],
          fromEmit: false,
          conflict: null,
          dynListener: false,
          hasListener: false,
        }),
      );
    return sig;
  };
  // The forced tuples (see the header comment); errorMonitor listeners
  // receive the 'error' payload.
  for (const name of ["error", ERROR_MONITOR_EVENT]) {
    table.set(name, {
      tuple: [{ kind: "object", className: "%Error" }],
      fromEmit: true,
      conflict: null,
      dynListener: false,
      hasListener: false,
    });
  }
  table.set("newListener", {
    tuple: [STRING],
    fromEmit: true,
    conflict: null,
    dynListener: false,
    hasListener: false,
  });
  table.set("removeListener", {
    tuple: [STRING],
    fromEmit: true,
    conflict: null,
    dynListener: false,
    hasListener: false,
  });

  const fmt = (t: IrType): string => lowerer.fmt(t);
  const mergeEmit = (name: string, args: (IrType | null)[], js: boolean): void => {
    const sig = sigOf(name);
    if (js) sig.jsEmit = true;
    if (args.some((a) => a === null)) {
      sig.unmappedEmit = true;
      return; // a flexible site's lowered values must still convert to dyn
    }
    const tuple = args as IrType[];
    if (sig.conflict) return;
    if (!sig.fromEmit) {
      // Listener prefixes seen so far must fit under this tuple.
      if (sig.tuple.length > tuple.length) {
        sig.conflict = `a listener declares ${sig.tuple.length} parameters but an emit supplies ${tuple.length} arguments`;
        return;
      }
      for (let i = 0; i < sig.tuple.length; i++) {
        if (!typeEquals(sig.tuple[i]!, tuple[i]!)) {
          sig.conflict = `position ${i} is '${fmt(sig.tuple[i]!)}' at one site and '${fmt(tuple[i]!)}' at another`;
          return;
        }
      }
      sig.tuple = tuple;
      sig.fromEmit = true;
      return;
    }
    if (sig.tuple.length !== tuple.length) {
      sig.conflict = `emit sites supply ${sig.tuple.length} and ${tuple.length} arguments`;
      return;
    }
    for (let i = 0; i < tuple.length; i++) {
      if (!typeEquals(sig.tuple[i]!, tuple[i]!)) {
        sig.conflict = `position ${i} is '${fmt(sig.tuple[i]!)}' at one site and '${fmt(tuple[i]!)}' at another`;
        return;
      }
    }
  };
  const mergeListener = (name: string, params: (IrType | null)[]): void => {
    if (params.some((p) => p === null)) return;
    const prefix = params as IrType[];
    const sig = sigOf(name);
    sig.hasListener = true;
    if (sig.conflict) return;
    if (sig.fromEmit) {
      if (prefix.length > sig.tuple.length) {
        sig.conflict = `a listener declares ${prefix.length} parameters but emits supply ${sig.tuple.length} arguments`;
        return;
      }
    } else if (prefix.length > sig.tuple.length) {
      // The longest listener extends the provisional tuple.
      for (let i = 0; i < sig.tuple.length; i++) {
        if (!typeEquals(sig.tuple[i]!, prefix[i]!)) {
          sig.conflict = `position ${i} is '${fmt(sig.tuple[i]!)}' at one site and '${fmt(prefix[i]!)}' at another`;
          return;
        }
      }
      sig.tuple = prefix;
      return;
    }
    for (let i = 0; i < prefix.length; i++) {
      if (!typeEquals(sig.tuple[i]!, prefix[i]!)) {
        sig.conflict = `position ${i} is '${fmt(sig.tuple[i]!)}' at one site and '${fmt(prefix[i]!)}' at another`;
        return;
      }
    }
  };

  for (const sf of lowerer.program.getImplementationSourceFiles()) {
    if (sf.isDeclarationFile) continue;
    const walk = (node: ts.Node): void => {
      ts.forEachChild(node, walk);
      if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return;
      const member = node.expression.name.text;
      const isEmit = member === "emit";
      if (!isEmit && !REGISTER_MEMBERS.has(member)) return;
      const arg0 = node.arguments.nodes[0];
      if (!arg0) return;
      let recvT: IrType | null = null;
      let nameT: ts.Type | null = null;
      try {
        recvT = lowerer.mapTypeOf(lowerer.typeOf(node.expression.expression));
        nameT = lowerer.typeOf(arg0);
      } catch {
        return; // checker trouble is the lowering's business, not the scan's
      }
      const info = scannedEmitterInfo(lowerer, recvT);
      if (!info) return;
      const literal = isErrorMonitorRef(lowerer, arg0)
        ? ERROR_MONITOR_EVENT
        : nameT.isStringLiteralType()
          ? literalEventKey(nameT.value)
          : null;
      if (literal === null) {
        const pattern = computedEventPatternOf(lowerer, arg0);
        if (
          pattern &&
          streamSidesOf(lowerer, info) === null &&
          !computedPatternOverlapsReserved(pattern)
        ) {
          computedPatterns.push({ ...pattern, listener: !isEmit });
        }
        return;
      }
      const name = literal;
      if (META_EVENTS.has(name) || name === "error" || name === ERROR_MONITOR_EVENT) return; // forced tuples
      // Stream receivers' runtime-emitted events carry PER-BASE forced
      // tuples (lower-stream.ts) — their sites never join the program-
      // global table, so a stream's 'data' cannot collide with a user
      // event named 'data' on a plain emitter.
      if (streamForcedTuple(lowerer, info, name) !== null) return;
      try {
        if (isEmit) {
          mergeEmit(
            name,
            node.arguments.nodes.slice(1).map((a) => lowerer.mapTypeOf(lowerer.typeOf(a))),
            isJsSourceFile(sf),
          );
        } else if (node.arguments.nodes[1]) {
          const cbCt = lowerer.typeOf(node.arguments.nodes[1]);
          const cbT =
            lowerer.mapTypeOf(cbCt) ?? dynFallbackType(lowerer, node.arguments.nodes[1], cbCt);
          // A TypeScript listener with no parameters is typed too: it
          // registers without the adapter, so an untyped emit reaches it
          // only through the event's fixed ABI. A JavaScript function
          // without parameters can still read `arguments`.
          if (
            cbT?.kind !== "dyn" &&
            (cbT?.kind !== "func" ||
              (cbT.params.length === 0 && !isJsSourceFile(sf)) ||
              cbT.params.some((p) => p.kind !== "dyn"))
          ) {
            sigOf(name).typedListener = true;
          }
          // Dyn-flavored listeners (a checked-dynamic value, or a func
          // with dyn parameters — the JS lane) register through the
          // adapter and constrain nothing: a dyn parameter accepts any
          // tuple position, and positions past the tuple read the boxed
          // undefined (exactly JS's extra-parameter semantics).
          if (
            cbT?.kind === "dyn" ||
            (cbT?.kind === "func" && cbT.params.some((p) => p.kind === "dyn"))
          ) {
            const sig = sigOf(name);
            sig.hasListener = true;
            sig.dynListener = true;
          } else if (cbT?.kind === "func") {
            mergeListener(name, cbT.params);
          }
        }
      } catch {
        /* not a candidate */
      }
    };
    walk(sf);
  }
  lowerer.emitterEventTable = table;
  lowerer.emitterComputedPatterns = computedPatterns;
  return table;
}

function computedPatterns(lowerer: Lowerer): ComputedEventPattern[] {
  emitterEvents(lowerer);
  return lowerer.emitterComputedPatterns;
}

function computedPatternsOverlap(left: ComputedEventPattern, right: ComputedEventPattern): boolean {
  return (
    (left.prefix.startsWith(right.prefix) || right.prefix.startsWith(left.prefix)) &&
    (left.suffix.endsWith(right.suffix) || right.suffix.endsWith(left.suffix))
  );
}

/** The compile-time key of `events.errorMonitor`. Node keys it by a
 * symbol, so no string event name may share it: literal names are keyed
 * through literalEventKey, which never yields this key, and the runtime
 * receives the emitter.errorMonitor key object (matched by identity)
 * instead of any string. */
export const ERROR_MONITOR_EVENT = "\u0000events.errorMonitor";

/** A string event name's compile-time key: the name itself, with one more
 * leading NUL when it already starts with one, so a key of one NUL and
 * then a non-NUL (ERROR_MONITOR_EVENT) belongs to no string. */
function literalEventKey(name: string): string {
  return name.startsWith("\u0000") ? `\u0000${name}` : name;
}

/** The string name of a key that is not ERROR_MONITOR_EVENT. */
function eventKeyName(key: string): string {
  return key.startsWith("\u0000") ? key.slice(1) : key;
}

/** The runtime event-name argument for a compile-time key. */
function eventNameExpr(key: string, loc: SrcLoc): IrExpr {
  if (key === ERROR_MONITOR_EVENT) {
    return { kind: "libCall", fn: "emitter.errorMonitor", args: [], type: STRING, loc };
  }
  return strLit(eventKeyName(key), loc);
}

/** `errorMonitor` / `EventEmitter.errorMonitor` / `events.errorMonitor`:
 * the events module's unique symbol, by declaration provenance. */
function isErrorMonitorRef(lowerer: Lowerer, arg: ts.Expression): boolean {
  const isMonitorType = (t: ts.Type): boolean => {
    if (!(t.flags & ts.TypeFlags.UniqueESSymbol)) return false;
    const symbol = t.getSymbol();
    return (
      symbol !== undefined &&
      ts.symbolName(symbol) === "errorMonitor" &&
      lowerer.isStdlibSymbol(symbol)
    );
  };
  // The unique symbol TYPE names its declaration through any alias.
  if (isMonitorType(lowerer.typeOf(arg))) return true;
  // A const destructuring (`const { errorMonitor } = events`) widens the
  // binding's type in JavaScript; its source property still names it.
  if (!ts.isIdentifier(arg)) return false;
  const symbol = lowerer.resolveValueSymbol(arg);
  const declaration = symbol ? symbol.valueDeclaration : undefined;
  if (!declaration || !ts.isBindingElement(declaration)) return false;
  const pattern = declaration.parent;
  const variable = pattern?.parent;
  if (
    !pattern ||
    !variable ||
    !ts.isObjectBindingPattern(pattern) ||
    !ts.isVariableDeclaration(variable) ||
    !variable.initializer ||
    !(ts.getCombinedNodeFlags(variable) & ts.NodeFlags.Const)
  )
    return false;
  const key = declaration.propertyName ?? declaration.name;
  if (!ts.isIdentifier(key)) return false;
  const property = lowerer.checker.getPropertyOfType(
    lowerer.typeOf(variable.initializer),
    key.text,
  );
  return property !== undefined && isMonitorType(lowerer.checker.getTypeOfSymbol(property));
}

/** A compile-time event key (literalEventKey): a string-literal TYPE
 * (const bindings and literal unions of one member count — the
 * staticHeaderKeyOf stance) or the errorMonitor symbol. */
function literalEventName(lowerer: Lowerer, arg: ts.Expression): string | null {
  if (isErrorMonitorRef(lowerer, arg)) return ERROR_MONITOR_EVENT;
  const t = lowerer.typeOf(arg);
  return t.isStringLiteralType() ? literalEventKey(t.value) : null;
}

/** The compile-time key for a literal-only operation, or a pointed fence. */
function eventNameOf(lowerer: Lowerer, member: string, arg: ts.Expression): string {
  const name = literalEventName(lowerer, arg);
  if (name !== null) return name;
  lowerer.noLowering(
    `${member} with a non-literal event name`,
    arg,
    "this operation needs a compile-time string literal (symbol names have no lowering)",
  );
}

function staticStringPrefixOf(
  lowerer: Lowerer,
  node: ts.Expression,
  seen = new Set<ts.Symbol>(),
): string | null {
  let expression = node;
  while (ts.isParenthesizedExpression(expression)) expression = expression.expression;
  if (ts.isStringLiteralLike(expression)) return expression.text;
  if (ts.isTemplateExpression(expression)) return expression.head.text;
  if (ts.isIdentifier(expression)) {
    const symbol = lowerer.resolveValueSymbol(expression);
    if (!symbol || seen.has(symbol)) return null;
    seen.add(symbol);
    const declaration = symbol.valueDeclaration;
    if (
      declaration &&
      ts.isVariableDeclaration(declaration) &&
      declaration.initializer &&
      (ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) !== 0
    ) {
      return staticStringPrefixOf(lowerer, declaration.initializer, seen);
    }
    return null;
  }
  if (
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    return staticStringPrefixOf(lowerer, expression.left, seen);
  }
  return null;
}

function staticStringSuffixOf(
  lowerer: Lowerer,
  node: ts.Expression,
  seen = new Set<ts.Symbol>(),
): string | null {
  let expression = node;
  while (ts.isParenthesizedExpression(expression)) expression = expression.expression;
  if (ts.isStringLiteralLike(expression)) return expression.text;
  if (ts.isTemplateExpression(expression))
    return expression.templateSpans.nodes.at(-1)?.literal.text ?? "";
  if (ts.isIdentifier(expression)) {
    const symbol = lowerer.resolveValueSymbol(expression);
    if (!symbol || seen.has(symbol)) return null;
    seen.add(symbol);
    const declaration = symbol.valueDeclaration;
    if (
      declaration &&
      ts.isVariableDeclaration(declaration) &&
      declaration.initializer &&
      (ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) !== 0
    )
      return staticStringSuffixOf(lowerer, declaration.initializer, seen);
    return null;
  }
  if (
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    return staticStringSuffixOf(lowerer, expression.right, seen);
  }
  return null;
}

function computedEventPatternOf(
  lowerer: Lowerer,
  node: ts.Expression,
): ComputedEventPattern | null {
  const prefix = staticStringPrefixOf(lowerer, node) ?? "";
  const suffix = staticStringSuffixOf(lowerer, node) ?? "";
  return prefix || suffix ? { prefix, suffix, listener: false } : null;
}

/** Whether a computed name could equal the event keyed `key` (never the
 * errorMonitor key: computed names are strings). */
function patternMatchesName(pattern: ComputedEventPattern, key: string): boolean {
  if (key === ERROR_MONITOR_EVENT) return false;
  const name = eventKeyName(key);
  return name.startsWith(pattern.prefix) && name.endsWith(pattern.suffix);
}

/** A computed event can use the variable-arity dyn path only when its
 * syntax proves a nonempty prefix or suffix excluding internal events. */
function computedEventPattern(
  lowerer: Lowerer,
  info: ClassInfo,
  member: string,
  arg: ts.Expression,
): ComputedEventPattern {
  const pattern = computedEventPatternOf(lowerer, arg);
  if (!pattern) {
    lowerer.noLowering(
      `${member} with an unrestricted computed event name`,
      arg,
      "computed event names need a nonempty constant prefix or suffix so they cannot collide with internal events",
    );
  }
  if (streamSidesOf(lowerer, info) !== null || computedPatternOverlapsReserved(pattern)) {
    lowerer.noLowering(
      `${member} with a computed event name overlapping an internal event`,
      arg,
      "computed-name listeners use an exact-arity dynamic argument vector; internal error, meta, and stream events retain their fixed representations",
    );
  }
  return pattern;
}

/** Register/remove a computed-name listener. The callback crosses the
 * checked-dynamic function boundary, which validates typed parameters.
 * The runtime retains the original closure and its checked-dynamic thunk,
 * supplying the exact emit argc without a fixed-tuple or varargs ABI. */
function lowerFlexListenerCall(
  lowerer: Lowerer,
  member: string,
  name: IrExpr,
  receiver: IrExpr,
  cbNode: ts.Expression,
  registering: boolean,
  once: boolean,
  prepend: boolean,
  loc: SrcLoc,
): IrExpr {
  if (receiver.type.kind !== "object") {
    lowerer.noLowering(
      `${member} with a nullable or non-emitter receiver`,
      cbNode,
      "narrow the receiver to an EventEmitter instance before registering or removing a computed-name listener",
    );
  }
  const cb = lowerer.lowerExpr(cbNode);
  const getRecord = (id: string) => lowerer.shapes.get(id);
  const getUnion = (id: string) => lowerer.unions.get(id);
  let boxed: IrExpr;
  if (cb.type.kind === "dyn") {
    boxed = cb;
  } else if (cb.type.kind === "func") {
    if (!canBoxFuncIntoDyn(cb.type, getRecord, getUnion)) {
      lowerer.noLowering(
        `${member} with a computed-name listener that cannot cross the checked-dynamic boundary`,
        cbNode,
        "the listener's parameters and return value must have checked-dynamic conversions",
      );
    }
    boxed = { kind: "dynFrom", value: cb, type: DYN, loc };
  } else if (cb.kind === "unitLit" || canConvertToDyn(cb.type, getRecord, getUnion)) {
    boxed = { kind: "dynFrom", value: cb, type: DYN, loc };
  } else {
    lowerer.noLowering(`${member} with a non-function computed-name listener`, cbNode);
  }
  const recvT = receiver.type;
  const key = `emitter.${registering ? "onFlex" : "offDyn"}:${typeKey(recvT)}`;
  let helper = lowerer.arrHofHelpers.get(key);
  if (!helper) {
    helper = keyedHelperName(lowerer, `%emitter.${registering ? "onFlex" : "offFlex"}`, key);
    lowerer.arrHofHelpers.set(key, helper);
    const params: IrParam[] = [
      { localId: "r.0", name: "r", type: recvT },
      { localId: "n.0", name: "n", type: STRING },
      { localId: "cb.0", name: "cb", type: DYN },
      ...(registering
        ? [
            { localId: "o.0", name: "o", type: BOOL },
            { localId: "p.0", name: "p", type: BOOL },
          ]
        : []),
    ];
    const locals = params.map((p) => ({
      id: p.localId,
      name: p.name,
      type: p.type,
      mutable: false,
    }));
    const body: IrStmt[] = [
      {
        kind: "exprStmt",
        expr: {
          kind: "libCall",
          fn: "emitter.checkListener",
          args: [varRef("cb.0", DYN, loc)],
          type: VOID,
          loc,
        },
        loc,
      },
      {
        kind: "return",
        value: {
          kind: "libCall",
          fn: registering ? "emitter.onFlex" : "emitter.offDyn",
          args: [
            varRef("r.0", recvT, loc),
            varRef("n.0", STRING, loc),
            varRef("cb.0", DYN, loc),
            ...(registering ? [varRef("o.0", BOOL, loc), varRef("p.0", BOOL, loc)] : []),
          ],
          type: recvT,
          loc,
        },
        loc,
      },
    ];
    lowerer.liftedFns.push({ name: helper, params, returnType: recvT, locals, body, loc });
  }
  return {
    kind: "call",
    callee: helper,
    args: [
      receiver,
      name,
      boxed,
      ...(registering ? [boolLit(once, loc), boolLit(prepend, loc)] : []),
    ],
    type: recvT,
    loc,
  };
}
/** The event's unified tuple, with conflicts reported at this site. */
function tupleOf(
  lowerer: Lowerer,
  table: Map<string, EventSig>,
  name: string,
  blame: ts.Node,
): IrType[] {
  const sig = table.get(name);
  if (!sig) return [];
  if (sig.conflict) {
    lowerer.noLowering(
      `the event '${name}' with conflicting argument types`,
      blame,
      `every emit site and listener of one event name must agree on one argument tuple — ${sig.conflict}`,
    );
  }
  return sig.tuple;
}

/** How a listener argument is dyn-flavored: "dyn" for a checked-dynamic
 * VALUE (a mustCall wrapper, a listener that rode an untyped binding),
 * "func" for a function whose parameters include dyn (the JS lane's
 * unannotated listeners — their checker type is any). Null for everything
 * else (the static path, with its own diagnostics). */
function dynListenerFlavor(lowerer: Lowerer, node: ts.Expression): "dyn" | "func" | null {
  let t: IrType | null;
  try {
    const ct = lowerer.typeOf(node);
    // The JS declaration fallback is what the EXPRESSION lowering applies
    // to inference residue (an inline `(a) => {}` maps null as a checker
    // type but lowers as a dyn-parameter function) — classify by the same
    // rule, so the flavor always matches what lowerExpr will produce.
    t = lowerer.mapTypeOf(ct) ?? dynFallbackType(lowerer, node, ct);
  } catch {
    return null;
  }
  if (t?.kind === "dyn") return "dyn";
  if (t?.kind === "func") {
    if (t.params.some((p) => p.kind === "dyn")) return "func";
    // The inferred signature of a wrapper can omit its runtime arguments
    // pack. Register the checked callable produced by the factory itself.
    return tryLowerExpression(lowerer, node)?.type.kind === "dyn" ? "dyn" : null;
  }
  // A statically-known NON-function listener (a literal number, a record,
  // null): route it through the dyn path too — the registration helper's
  // checkListener throws Node's exact ERR_INVALID_ARG_TYPE TypeError
  // (the TS lane never reaches this: tsc rejects the argument first).
  if (
    t &&
    (isUnitType(t) ||
      canConvertToDyn(
        t,
        (id) => lowerer.shapes.get(id),
        (id) => lowerer.unions.get(id),
      ))
  ) {
    return "dyn";
  }
  return null;
}

/** A dyn-flavored listener registration/removal (the JS lane's unannotated
 * listeners, and mustCall-style wrapped ones): the listener registers as a
 * checked-dynamic value through an interned helper —
 *
 *   %emitter.onDyn.<n>(recv, name, cb, once, prepend) {
 *     emitter.checkListener(cb);          // Node's ERR_INVALID_ARG_TYPE
 *     const a: (tuple) => void = cb;      // dynCheck: the boxing adapter
 *     return emitter.onDyn(recv, name, cb, a, once, prepend);
 *   }
 *
 * The dynCheck adapter boxes each emitted tuple argument to dyn and calls
 * the original through the checked-dynamic call machinery — JS-exact
 * arity (parameters past the tuple read undefined, extra arguments are
 * ignored). The runtime entry registers the ADAPTER for dispatch but
 * keeps the ORIGINAL (the dyn box's underlying closure) as the entry's
 * identity, so off/removeListener and listenerCount(name, fn) match it.
 * The helper shape exists because cb must evaluate ONCE and feed both
 * roles. Fenced honestly: tuple positions that cannot box to dyn (class
 * payloads — 'error' events), and the meta events (Node passes the
 * listener FUNCTION second, which has no dyn conversion — a dyn listener
 * reading it would see undefined). */
function lowerDynListenerCall(
  lowerer: Lowerer,
  member: string,
  name: string,
  tuple: IrType[],
  receiver: IrExpr,
  cbNode: ts.Expression,
  flavor: "dyn" | "func",
  registering: boolean,
  once: boolean,
  prepend: boolean,
  loc: SrcLoc,
  /** Stream 'data': the adapter registers through emitter.onDataDyn so
   * the backend emits the two-slot DATA thunk (box by runtime tag); the
   * tuple is [DYN] — the adapter passes the boxed chunk through. */
  streamData: boolean,
): IrExpr {
  if (META_EVENTS.has(name)) {
    lowerer.noLowering(
      `'${member}' of '${name}' with a checked-dynamic listener`,
      cbNode,
      "Node passes the listener FUNCTION as the meta event's second argument, which has no dynamic conversion — annotate the listener's parameter as a string",
    );
  }
  const getRecord = (id: string) => lowerer.shapes.get(id);
  const getUnion = (id: string) => lowerer.unions.get(id);
  for (let i = 0; i < tuple.length; i++) {
    const p = tuple[i]!;
    if (p.kind !== "dyn" && !canConvertToDyn(p, getRecord, getUnion)) {
      lowerer.noLowering(
        `'${member}' of '${name}' with a checked-dynamic listener`,
        cbNode,
        `the event's argument ${i} is '${lowerer.fmt(p)}', which cannot box into a dynamic value — annotate the listener's parameters with the emitted types`,
      );
    }
  }
  let cbDyn: IrExpr;
  if (flavor === "dyn") {
    const v = lowerer.lowerExpr(cbNode);
    if (v.type.kind === "dyn") {
      cbDyn = v;
    } else if (v.kind === "unitLit" || canConvertToDyn(v.type, getRecord, getUnion)) {
      // A non-dyn residue the classification saw as dynamic (a literal
      // null/undefined listener, a convertible scalar): box it — the
      // checkListener call answers with Node's exact TypeError.
      cbDyn = { kind: "dynFrom", value: v, type: DYN, loc };
    } else {
      lowerer.noLowering(`'${member}' with a non-function listener`, cbNode);
    }
  } else {
    const cb = lowerer.lowerExpr(cbNode);
    // A wrapper can return a boxed closure even when the checker retains
    // its callable signature. The registration helper validates that value.
    if (cb.type.kind === "dyn") {
      cbDyn = cb;
    } else if (cb.type.kind === "func" && canBoxFuncIntoDyn(cb.type, getRecord, getUnion)) {
      cbDyn = { kind: "dynFrom", value: cb, type: DYN, loc };
    } else {
      lowerer.noLowering(
        `'${member}' with a listener of this signature`,
        cbNode,
        "a checked-dynamic listener's own parameters and return must box across the dynamic boundary",
      );
    }
  }
  const recvT = receiver.type;
  const adapterT: IrType = { kind: "func", params: tuple, ret: VOID };
  const onFn = streamData ? ("emitter.onDataDyn" as const) : ("emitter.onDyn" as const);
  const key = registering
    ? `${onFn}:${typeKey(recvT)}:${typeKey(adapterT)}`
    : `emitter.offDyn:${typeKey(recvT)}`;
  const existing = lowerer.arrHofHelpers.get(key);
  let helper = existing;
  if (!helper) {
    helper = keyedHelperName(lowerer, `%emitter.${registering ? "onDyn" : "offDyn"}`, key);
    lowerer.arrHofHelpers.set(key, helper);
    const check: IrStmt = {
      kind: "exprStmt",
      expr: {
        kind: "libCall",
        fn: "emitter.checkListener",
        args: [varRef("cb.0", DYN, loc)],
        type: VOID,
        loc,
      },
      loc,
    };
    const params = [
      { localId: "r.0", name: "r", type: recvT },
      { localId: "n.0", name: "n", type: STRING },
      { localId: "cb.0", name: "cb", type: DYN },
      ...(registering
        ? [
            { localId: "o.0", name: "o", type: BOOL },
            { localId: "p.0", name: "p", type: BOOL },
          ]
        : []),
    ];
    const locals = params.map((p) => ({
      id: p.localId,
      name: p.name,
      type: p.type,
      mutable: false,
    }));
    let body: IrStmt[];
    if (registering) {
      locals.push({ id: "a.0", name: "a", type: adapterT, mutable: false });
      body = [
        check,
        {
          kind: "varDecl",
          localId: "a.0",
          init: { kind: "dynCheck", value: varRef("cb.0", DYN, loc), type: adapterT, loc },
          loc,
        },
        {
          kind: "return",
          value: {
            kind: "libCall",
            fn: onFn,
            args: [
              varRef("r.0", recvT, loc),
              varRef("n.0", STRING, loc),
              varRef("cb.0", DYN, loc),
              varRef("a.0", adapterT, loc),
              varRef("o.0", BOOL, loc),
              varRef("p.0", BOOL, loc),
            ],
            type: recvT,
            loc,
          },
          loc,
        },
      ];
    } else {
      body = [
        check,
        {
          kind: "return",
          value: {
            kind: "libCall",
            fn: "emitter.offDyn",
            args: [varRef("r.0", recvT, loc), varRef("n.0", STRING, loc), varRef("cb.0", DYN, loc)],
            type: recvT,
            loc,
          },
          loc,
        },
      ];
    }
    lowerer.liftedFns.push({ name: helper, params, returnType: recvT, locals, body, loc });
  }
  return {
    kind: "call",
    callee: helper,
    args: registering
      ? [receiver, eventNameExpr(name, loc), cbDyn, boolLit(once, loc), boolLit(prepend, loc)]
      : [receiver, eventNameExpr(name, loc), cbDyn],
    type: recvT,
    loc,
  };
}

/** The literal events typed code dispatches with a fixed tuple — it emits
 * them or listens with typed parameters — whose names an untyped receiver
 * may also use. 'error' and the meta events are excluded: the runtime fixes
 * their tuples itself (scr_emitter_on_flex / scr_emitter_emit_flex). */
function bridgedEvents(lowerer: Lowerer): { name: string; tuple: IrType[] }[] {
  const table = emitterEvents(lowerer);
  const events: { name: string; tuple: IrType[] }[] = [];
  for (const [key, sig] of table) {
    if (key === "error" || key === ERROR_MONITOR_EVENT || META_EVENTS.has(key)) continue;
    if (sig.conflict !== null || (!sig.fromEmit && sig.typedListener !== true)) continue;
    if (flexibleJsEvent(key, sig)) continue;
    if (computedPatterns(lowerer).some((pattern) => patternMatchesName(pattern, key))) continue;
    events.push({ name: eventKeyName(key), tuple: sig.tuple });
  }
  return events;
}

/** `emit(name, ...args)` through an untyped value on a (non-stream)
 * emitter-rooted receiver, when typed code fixes the tuple of some event.
 * Listeners registered as checked-dynamic functions receive the arguments
 * as given; when the name is such an event and a listener with typed
 * parameters is registered, the arguments also convert to the event's tuple
 * (a mismatch throws the checked conversion's TypeError). Null when no event
 * needs this, so the caller keeps the plain untyped emit. */
export function lowerDynamicEmitterEmit(
  lowerer: Lowerer,
  receiver: IrExpr,
  name: IrExpr,
  payload: IrExpr[],
  loc: SrcLoc,
): IrExpr | null {
  const recvT = receiver.type;
  if (recvT.kind !== "object") return null;
  const k = payload.length;
  const getRecord = (id: string) => lowerer.shapes.get(id);
  const getUnion = (id: string) => lowerer.unions.get(id);
  const checkable = (t: IrType): boolean =>
    t.kind === "dyn" ||
    isDynTypedRefType(t) ||
    isUnitType(t) ||
    (t.kind === "union"
      ? (getUnion(t.unionId)?.arms.every(checkable) ?? false)
      : canDynCheckTo(t, getRecord, getUnion));
  const converted = (tuple: IrType[]): IrExpr[] | null => {
    if (!tuple.every(checkable)) return null;
    const out: IrExpr[] = [];
    for (let i = 0; i < tuple.length; i++) {
      const arg = i < k ? varRef(`a.${i}`, DYN, loc) : dynUndefinedExpr(loc);
      const value = lowerer.coerceToExpected(arg, tuple[i]!);
      if (!typeEquals(value.type, tuple[i]!)) return null;
      out.push(value);
    }
    return out;
  };
  const events = bridgedEvents(lowerer)
    .map((event) => ({ ...event, args: converted(event.tuple) }))
    .filter((event) => event.args !== null);
  if (events.length === 0) return null;
  const key = `emitter.dynEmit:${typeKey(recvT)}:${k}`;
  let helper = lowerer.arrHofHelpers.get(key);
  if (!helper) {
    helper = keyedHelperName(lowerer, "%emitter.dynEmit", key);
    lowerer.arrHofHelpers.set(key, helper);
    const params: IrParam[] = [
      { localId: "r.0", name: "r", type: recvT },
      { localId: "n.0", name: "n", type: STRING },
      ...payload.map((_, i) => ({ localId: `a.${i}`, name: `a${i}`, type: DYN })),
    ];
    const r = varRef("r.0", recvT, loc);
    const n = varRef("n.0", STRING, loc);
    const dynArgs = payload.map((_, i) => varRef(`a.${i}`, DYN, loc));
    const body: IrStmt[] = events.map((event): IrStmt => ({
      kind: "if",
      cond: {
        kind: "strEq",
        negated: false,
        left: n,
        right: strLit(event.name, loc),
        type: BOOL,
        loc,
      },
      then: [
        {
          kind: "if",
          cond: { kind: "libCall", fn: "emitter.hasTyped", args: [r, n], type: BOOL, loc },
          then: [
            {
              kind: "return",
              value: {
                kind: "libCall",
                fn: "emitter.emitMixed",
                args: [
                  r,
                  n,
                  { kind: "numLit", value: k, type: F64, loc },
                  ...dynArgs,
                  ...event.args!,
                ],
                type: BOOL,
                loc,
              },
              loc,
            },
          ],
          else_: null,
          loc,
        },
      ],
      else_: null,
      loc,
    }));
    body.push({
      kind: "return",
      value: { kind: "libCall", fn: "emitter.emitAny", args: [r, n, ...dynArgs], type: BOOL, loc },
      loc,
    });
    lowerer.liftedFns.push({
      name: helper,
      params,
      returnType: BOOL,
      locals: params.map((p) => ({ id: p.localId, name: p.name, type: p.type, mutable: false })),
      body,
      loc,
    });
  }
  return { kind: "call", callee: helper, args: [receiver, name, ...payload], type: BOOL, loc };
}

/** on/once/prepend*(name, fn) through an untyped value on a (non-stream)
 * emitter-rooted receiver, when typed code fixes the tuple of some event.
 * Under such an event's name the function registers with a typed adapter
 * for typed emits as well as its checked-dynamic thunk for untyped ones;
 * other names register the thunk alone. Null when no event needs this. */
export function lowerDynamicEmitterOn(
  lowerer: Lowerer,
  receiver: IrExpr,
  name: IrExpr,
  cb: IrExpr,
  once: boolean,
  prepend: boolean,
  loc: SrcLoc,
): IrExpr | null {
  const recvT = receiver.type;
  if (recvT.kind !== "object") return null;
  const getRecord = (id: string) => lowerer.shapes.get(id);
  const getUnion = (id: string) => lowerer.unions.get(id);
  const events = bridgedEvents(lowerer).filter((event) =>
    event.tuple.every((t) => t.kind === "dyn" || canConvertToDyn(t, getRecord, getUnion)),
  );
  if (events.length === 0) return null;
  const key = `emitter.dynOn:${typeKey(recvT)}`;
  let helper = lowerer.arrHofHelpers.get(key);
  if (!helper) {
    helper = keyedHelperName(lowerer, "%emitter.dynOn", key);
    lowerer.arrHofHelpers.set(key, helper);
    const params: IrParam[] = [
      { localId: "r.0", name: "r", type: recvT },
      { localId: "n.0", name: "n", type: STRING },
      { localId: "cb.0", name: "cb", type: DYN },
      { localId: "o.0", name: "o", type: BOOL },
      { localId: "p.0", name: "p", type: BOOL },
    ];
    const locals: IrLocal[] = params.map((p) => ({
      id: p.localId,
      name: p.name,
      type: p.type,
      mutable: false,
    }));
    const r = varRef("r.0", recvT, loc);
    const n = varRef("n.0", STRING, loc);
    const fn = varRef("cb.0", DYN, loc);
    const o = varRef("o.0", BOOL, loc);
    const p = varRef("p.0", BOOL, loc);
    const body: IrStmt[] = [
      {
        kind: "exprStmt",
        expr: { kind: "libCall", fn: "emitter.checkListener", args: [fn], type: VOID, loc },
        loc,
      },
    ];
    events.forEach((event, i) => {
      const adapterT: IrType = { kind: "func", params: event.tuple, ret: VOID };
      const adapter = `a.${i}`;
      locals.push({ id: adapter, name: "a", type: adapterT, mutable: false });
      body.push({
        kind: "if",
        cond: {
          kind: "strEq",
          negated: false,
          left: n,
          right: strLit(event.name, loc),
          type: BOOL,
          loc,
        },
        then: [
          {
            kind: "varDecl",
            localId: adapter,
            init: { kind: "dynCheck", value: fn, type: adapterT, loc },
            loc,
          },
          {
            kind: "return",
            value: {
              kind: "libCall",
              fn: "emitter.onDyn",
              args: [r, n, fn, varRef(adapter, adapterT, loc), o, p],
              type: recvT,
              loc,
            },
            loc,
          },
        ],
        else_: null,
        loc,
      });
    });
    body.push({
      kind: "return",
      value: { kind: "libCall", fn: "emitter.onAny", args: [r, n, fn, o, p], type: recvT, loc },
      loc,
    });
    lowerer.liftedFns.push({ name: helper, params, returnType: recvT, locals, body, loc });
  }
  return {
    kind: "call",
    callee: helper,
    args: [receiver, name, cb, boolLit(once, loc), boolLit(prepend, loc)],
    type: recvT,
    loc,
  };
}

/** A listener argument: lowered, checked void-returning, and its
 * parameters checked as a typeEquals PREFIX of the event tuple. */
function lowerListenerArg(
  lowerer: Lowerer,
  member: string,
  name: string,
  node: ts.Expression,
  tuple: IrType[],
): IrExpr {
  // Unannotated non-empty parameter lists have no static types (checker
  // `any`; dyn in JS sources) — say so before the blanket type fence speaks.
  if (
    (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
    node.parameters.nodes.length > 0
  ) {
    for (const p of node.parameters.nodes) {
      if (p.type === undefined && ts.isIdentifier(p.name)) {
        const mapped = (() => {
          try {
            return lowerer.mapTypeOf(lowerer.typeOf(p.name));
          } catch {
            return null;
          }
        })();
        if (mapped === null || mapped.kind === "dyn") {
          lowerer.noLowering(
            `'${member}' listeners with unannotated parameters`,
            p,
            "EventEmitter's declared listener type is (...args: any[]) — annotate each parameter with the emitted argument's type",
          );
        }
      }
    }
  }
  const cb = lowerer.lowerExpr(node);
  if (cb.type.kind !== "func") {
    lowerer.noLowering(`'${member}' with a non-function listener`, node);
  }
  const cbT = cb.type as IrType & { kind: "func" };
  // Node ignores listener return values, so value-returning listeners
  // (expression-body arrows, mustCall wrappers) register fine — the
  // emitted invoke adapter calls through the listener's true signature
  // and discards (releasing refcounted results). An async listener's
  // promise is abandoned unobserved (SEMANTICS.md).
  if (META_EVENTS.has(name) && cbT.params.length > 1) {
    lowerer.noLowering(
      `'${name}' listeners taking the listener-function argument`,
      node,
      "meta-event listeners take at most the event name (the listener argument has no unified static type)",
    );
  }
  if (cbT.params.length > tuple.length) {
    lowerer.noLowering(
      `a '${name}' listener declaring ${cbT.params.length} parameters where the event's tuple has ${tuple.length}`,
      node,
      "listeners may declare a prefix of the event's emitted arguments",
    );
  }
  for (let i = 0; i < cbT.params.length; i++) {
    if (!typeEquals(cbT.params[i]!, tuple[i]!)) {
      lowerer.noLowering(
        `a '${name}' listener whose parameter ${i} is '${lowerer.fmt(cbT.params[i]!)}' where the event's tuple has '${lowerer.fmt(tuple[i]!)}'`,
        node,
        "every emit site and listener of one event name must agree on one argument tuple",
      );
    }
  }
  return cb;
}

/** `recv.<member>(...)` over an emitter-rooted receiver — the whole
 * EventEmitter method surface. Returns null only for members this spoke
 * does not own (the caller falls through to its own fences).
 *
 * `superRecv` is the `super.<member>(...)` spelling (lowerSuperMethodCall
 * routes here): the receiver is the current method's `this`, and emit
 * NEVER dispatches through an override at-or-below the lexical class —
 * JS's static super dispatch (the nearest override STRICTLY ABOVE the
 * lexical class still answers, exactly like a prototype-chain walk). */
export function lowerEmitterMethodCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
  info: ClassInfo,
  superRecv?: { thisRef: IrExpr; cls: ClassInfo },
): IrExpr | null {
  const member = access.name.text;
  const loc = locOf(call);
  const args = call.arguments.nodes;
  const lowerReceiver = (): IrExpr => {
    if (superRecv) return superRecv.thisRef;
    const receiver = lowerer.lowerExpr(access.expression);
    if (receiver.type.kind === "union") {
      const target: IrType = { kind: "object", className: info.def.name };
      const helper = lowerer.narrowedArmHelper(
        receiver.type.unionId,
        target,
        locOf(access.expression),
      );
      if (helper !== null) {
        return {
          kind: "call",
          callee: helper,
          args: [receiver],
          type: target,
          loc: locOf(access.expression),
        };
      }
    }
    return receiver;
  };
  const lowerFlexEmit = (name: IrExpr, kind = "computed-name"): IrExpr => {
    const below: ClassInfo[] = [];
    collectEmitOverridesBelow(info, below);
    if (emitOverrideAtOrAbove(info) || below.length > 0) {
      lowerer.noLowering(
        `${kind} emit through an EventEmitter subclass overriding emit`,
        call,
        "the override specialization needs a literal event name and fixed argument tuple",
      );
    }
    const receiver = lowerReceiver();
    if (receiver.type.kind !== "object") {
      lowerer.noLowering(
        `${kind} emit on a nullable or non-emitter receiver`,
        access.expression,
        "narrow the receiver to an EventEmitter instance before emitting",
      );
    }
    const payload = args.slice(1).map((arg) => lowerer.lowerExprExpecting(arg, DYN));
    return {
      kind: "libCall",
      fn: "emitter.emitFlex",
      args: [receiver, name, ...payload],
      type: BOOL,
      loc,
    };
  };
  // The class VALUE, not an instance (`EventEmitter.setMaxListeners(n)` —
  // the receiver's checker type carries construct signatures; mapType
  // answers the instance object for every EventEmitter-symbol type, so the
  // instance dispatch conflated the two and handed the instance libCalls a
  // receiver that lowers to the class value, the setMax ICE). The statics
  // are a DIFFERENT surface: setMaxListeners(n) writes the process-wide
  // defaultMaxListeners (validated at runtime — Node's ERR_OUT_OF_RANGE);
  // everything else fences by its static name.
  if (
    superRecv === undefined &&
    lowerer.checker.getConstructSignatures(lowerer.typeOf(access.expression)).length > 0
  ) {
    if (member === "addAbortListener") return lowerAddAbortListener(lowerer, call, loc);
    // The events module's functions are EventEmitter's statics too.
    if (member === "once") return lowerEventsOnce(lowerer, call, loc);
    if (member === "setMaxListeners" && args.length === 1)
      return lowerDefaultMaxListenersSet(lowerer, args[0]!, loc);
    if (
      member === "listenerCount" ||
      member === "getMaxListeners" ||
      member === "getEventListeners" ||
      (member === "setMaxListeners" &&
        args.length > 1 &&
        args.slice(1).every((arg) => lowerer.mapTypeOf(lowerer.typeOf(arg))?.kind === "object"))
    ) {
      return lowerEventsEmitterHelper(lowerer, call, member, loc)!;
    }
    if (member === "setMaxListeners") {
      // The per-target form with a target that is provably NOT an
      // emitter/EventTarget (the invalid-input probes): Node validates n
      // first, then throws ERR_INVALID_ARG_TYPE on the target. Claimed
      // when n is a pure read (identifier/literal — nothing to evaluate)
      // and the target crosses into the checked-dynamic tree for the Received tail.
      if (args.length === 2 && !args.some(ts.isSpreadElement)) {
        const nT = lowerer.mapTypeOf(lowerer.typeOf(args[0]!));
        const tT = lowerer.mapTypeOf(lowerer.typeOf(args[1]!));
        const nPure = ts.isIdentifier(args[0]!) || ts.isLiteralExpression(args[0]!);
        const targetNotEmitter = tT !== null && tT.kind !== "dyn" && !(tT.kind === "object");
        if (nT?.kind === "f64" && nPure && targetNotEmitter) {
          const raw = lowerer.lowerExpr(args[1]!);
          if (
            raw.type.kind === "dyn" ||
            raw.kind === "unitLit" ||
            lowerer.dynConvertible(raw.type)
          ) {
            const got: IrExpr =
              raw.type.kind === "dyn" ? raw : { kind: "dynFrom", value: raw, type: DYN, loc };
            return {
              kind: "libCall",
              fn: "error.argTypeThrow",
              args: [
                { kind: "strLit", value: "eventTargets", type: STRING, loc },
                {
                  kind: "strLit",
                  value: "an instance of EventEmitter or EventTarget",
                  type: STRING,
                  loc,
                },
                got,
              ],
              type: VOID,
              loc,
            };
          }
        }
      }
      lowerer.noLowering(
        `EventEmitter.setMaxListeners with ${args.length} arguments`,
        call,
        "the lowered static form is EventEmitter.setMaxListeners(n) — per-target application (…, ...eventTargets) has no lowering; call target.setMaxListeners(n) instead",
      );
    }
    lowerer.noLowering(
      `the static EventEmitter.${member} form`,
      call,
      "instance emitters lower this member; the class-value statics have no lowering yet",
    );
  }
  const table = emitterEvents(lowerer);

  if (REGISTER_MEMBERS.has(member) || member === "off" || member === "removeListener") {
    // Node's (type, listener) signature IGNORES extra arguments — admit
    // pure-read extras (literals/identifiers: nothing to evaluate) and
    // drop them; anything with effects keeps the fence.
    const extrasPure = args.slice(2).every((a) => ts.isIdentifier(a) || ts.isLiteralExpression(a));
    if (args.length < 2 || !extrasPure) {
      lowerer.noLowering(
        `${member} with ${args.length} arguments`,
        call,
        "the supported form is (eventName, listener)",
      );
    }
    const registering = REGISTER_MEMBERS.has(member);
    if (literalEventName(lowerer, args[0]!) === null) {
      computedEventPattern(lowerer, info, member, args[0]!);
      const receiver = lowerReceiver();
      const name = lowerer.lowerExprExpecting(args[0]!, STRING);
      return lowerFlexListenerCall(
        lowerer,
        member,
        name,
        receiver,
        args[1]!,
        registering,
        member === "once" || member === "prependOnceListener",
        member === "prependListener" || member === "prependOnceListener",
        loc,
      );
    }
    const name = eventNameOf(lowerer, member, args[0]!);
    if (
      !META_EVENTS.has(name) &&
      name !== "error" &&
      streamForcedTuple(lowerer, info, name) === null &&
      (flexibleJsEvent(name, table.get(name)) ||
        computedPatterns(lowerer).some((pattern) => patternMatchesName(pattern, name)))
    ) {
      return lowerFlexListenerCall(
        lowerer,
        member,
        eventNameExpr(name, loc),
        lowerReceiver(),
        args[1]!,
        registering,
        member === "once" || member === "prependOnceListener",
        member === "prependListener" || member === "prependOnceListener",
        loc,
      );
    }
    // The runtime fires the meta events INTERNALLY (scr_ee_emit_meta —
    // Node calls this.emit, which would dispatch through an emit
    // override): with an override anywhere the receiver's instances could
    // be, a registered meta listener is the one observer of that
    // divergence, so the registration is the honest fence site.
    if (registering && META_EVENTS.has(name)) {
      const ov = emitOverrideComparable(info);
      if (ov) {
        lowerer.noLowering(
          `'${member}' of '${name}' while '${ov.def.jsName || ov.def.name}' overrides emit`,
          call,
          "the runtime fires meta events internally, which cannot route through an emit override",
        );
      }
    }
    const receiver = lowerReceiver();
    const once = member === "once" || member === "prependOnceListener";
    const prepend = member === "prependListener" || member === "prependOnceListener";
    // Stream 'data' rides its own three-slot payload ABI (bytes, string —
    // encoded streams deliver strings — and an object-mode value;
    // scr_stream_emit_data): listeners on readable-sided receivers
    // register through DATA thunks that unwrap the declared side, convert
    // to the declared type, or take the value (dyn).
    const sides = streamSidesOf(lowerer, info);
    if (name === "data" && (sides === "r" || sides === "rw")) {
      const dynFlavor = dynListenerFlavor(lowerer, args[1]!);
      if (dynFlavor !== null) {
        return lowerDynListenerCall(
          lowerer,
          member,
          name,
          [DYN],
          receiver,
          args[1]!,
          dynFlavor,
          registering,
          once,
          prepend,
          loc,
          true,
        );
      }
      const cb = lowerer.lowerExpr(args[1]!);
      if (cb.type.kind !== "func") {
        lowerer.noLowering(`'${member}' with a non-function listener`, args[1]!);
      }
      const cbT = cb.type as IrType & { kind: "func" };
      if (cbT.params.length > 1) {
        lowerer.noLowering(
          `a 'data' listener declaring ${cbT.params.length} parameters where the event carries one chunk`,
          args[1]!,
        );
      }
      const p = cbT.params[0];
      // A `Buffer | string` chunk (NodeJS.ReadableStream's listener
      // shape) takes whichever side the stream delivers.
      const chunkUnion =
        p?.kind === "union" &&
        (lowerer.unions.get(p.unionId)?.arms ?? []).every(
          (arm) => (arm.kind === "bytes" && arm.elem === "u8") || arm.kind === "string",
        );
      // Any other chunk type converts from the chunk's value (an
      // object-mode stream's value, or the Buffer or string) when the
      // listener runs, or throws a TypeError there.
      if (
        p !== undefined &&
        !(p.kind === "bytes" && p.elem === "u8") &&
        p.kind !== "string" &&
        !chunkUnion &&
        (p.kind === "func" ||
          !canConvertToDyn(
            p,
            (id) => lowerer.shapes.get(id),
            (id) => lowerer.unions.get(id),
          ))
      ) {
        lowerer.noLowering(
          `a 'data' listener whose chunk parameter is '${lowerer.fmt(p)}'`,
          args[1]!,
          "declare the chunk as a type that converts from a checked-dynamic value",
        );
      }
      if (!registering) {
        return {
          kind: "libCall",
          fn: "emitter.off",
          args: [receiver, eventNameExpr(name, loc), cb],
          type: receiver.type,
          loc,
        };
      }
      return {
        kind: "libCall",
        fn: "emitter.onData",
        args: [receiver, eventNameExpr(name, loc), cb, boolLit(once, loc), boolLit(prepend, loc)],
        type: receiver.type,
        loc,
      };
    }
    // Stream-rooted receivers consult the per-base FORCED tuples first
    // (runtime-emitted 'end'/'pipe'/... payloads); the dyn-listener check
    // below then sees the forced tuple exactly like a table one.
    const tuple = streamForcedTuple(lowerer, info, name) ?? tupleOf(lowerer, table, name, call);
    // readline's 'keypress' (str, key) arrives as checked-dynamic values:
    // a typed listener is called through the dyn machinery too
    const keypress = name === "keypress" && streamForcedTuple(lowerer, info, name) !== null;
    if (keypress) {
      const probe = tryLowerExpression(lowerer, args[1]!);
      if (probe) checkKeypressListener(lowerer, args[1]!, probe);
    }
    const dynFlavor = dynListenerFlavor(lowerer, args[1]!) ?? (keypress ? "func" : null);
    if (dynFlavor !== null) {
      return lowerDynListenerCall(
        lowerer,
        member,
        name,
        tuple,
        receiver,
        args[1]!,
        dynFlavor,
        registering,
        once,
        prepend,
        loc,
        false,
      );
    }
    const cb = lowerListenerArg(lowerer, member, name, args[1]!, tuple);
    return {
      kind: "libCall",
      fn: registering ? "emitter.on" : "emitter.off",
      args: registering
        ? [receiver, eventNameExpr(name, loc), cb, boolLit(once, loc), boolLit(prepend, loc)]
        : [receiver, eventNameExpr(name, loc), cb],
      type: receiver.type,
      loc,
    };
  }

  if (member === "emit") {
    if (args.length === 0) {
      lowerer.noLowering("emit without an event name", call);
    }
    if (literalEventName(lowerer, args[0]!) === null) {
      const pattern = computedEventPatternOf(lowerer, args[0]!);
      const mayBeObserved =
        pattern === null ||
        computedPatternOverlapsReserved(pattern) ||
        [...table].some(
          ([candidate, sig]) =>
            (candidate === "error" || sig.hasListener) && patternMatchesName(pattern, candidate),
        ) ||
        computedPatterns(lowerer).some(
          (registered) => registered.listener && computedPatternsOverlap(pattern, registered),
        );
      if (!mayBeObserved) {
        const receiver = lowerReceiver();
        const dynamicName = lowerer.lowerExprExpecting(args[0]!, STRING);
        const payload = args.slice(1).map((arg) => lowerer.lowerExpr(arg));
        return {
          kind: "seqExpr",
          stmts: [receiver, dynamicName, ...payload].map((expr) => ({
            kind: "exprStmt" as const,
            expr,
            loc: expr.loc,
          })),
          result: boolLit(false, loc),
          type: BOOL,
          loc,
        };
      }
      computedEventPattern(lowerer, info, member, args[0]!);
      const name = lowerer.lowerExprExpecting(args[0]!, STRING);
      return lowerFlexEmit(name);
    }
    const name = eventNameOf(lowerer, member, args[0]!);
    if (
      name !== "error" &&
      !META_EVENTS.has(name) &&
      streamForcedTuple(lowerer, info, name) === null &&
      (flexibleJsEvent(name, table.get(name)) ||
        computedPatterns(lowerer).some((pattern) => patternMatchesName(pattern, name)))
    )
      return lowerFlexEmit(
        eventNameExpr(name, loc),
        flexibleJsEvent(name, table.get(name)) ? "variable-arity" : "computed-name",
      );
    const receiver = lowerReceiver();
    if (name === "error") {
      // The special event: exactly one %Error-rooted payload; no listener
      // means the runtime THROWS it (emitter.emitError, may-throw).
      if (args.length !== 2) {
        lowerer.noLowering(
          `emit('error') with ${args.length - 1} payload arguments`,
          call,
          "the supported form is emit('error', err) with an Error-hierarchy payload (non-Error payloads would need Node's ERR_UNHANDLED_ERROR wrapping — no lowering yet)",
        );
      }
      const err = lowerer.lowerExpr(args[1]!);
      const rootsAtError = (t: IrType): boolean => {
        if (t.kind !== "object") return false;
        for (let c: ClassInfo | null = lowerer.classes.get(t.className) ?? null; c; c = c.base) {
          if (c.def.name === "%Error") return true;
        }
        return false;
      };
      if (!rootsAtError(err.type)) {
        lowerer.noLowering(
          `emit('error') with a '${lowerer.fmt(err.type)}' payload`,
          args[1]!,
          "the supported payload is an Error-hierarchy instance",
        );
      }
      return emitDispatchExpr(
        lowerer,
        info,
        name,
        [{ kind: "object", className: "%Error" }],
        receiver,
        [lowerer.upcastTo(err, "%Error")],
        superRecv?.cls,
        loc,
      );
    }
    // Stream 'data' rides the three-slot payload ABI: a user emit fills
    // the chunk's slot (bytes or string) and NULLs the others; any other
    // value is emitted as a checked-dynamic value, filling the slots by
    // its tag.
    const emitSides = streamSidesOf(lowerer, info);
    if (name === "data" && (emitSides === "r" || emitSides === "rw")) {
      if (args.length !== 2) {
        lowerer.noLowering(
          `emit('data') with ${args.length - 1} payload arguments`,
          call,
          "the event carries one chunk (a Buffer or string)",
        );
      }
      let chunk = lowerer.lowerExpr(args[1]!);
      if (
        !(chunk.type.kind === "bytes" && chunk.type.elem === "u8") &&
        chunk.type.kind !== "string"
      ) {
        if (
          chunk.type.kind === "func" ||
          (chunk.type.kind !== "dyn" &&
            !canConvertToDyn(
              chunk.type,
              (id) => lowerer.shapes.get(id),
              (id) => lowerer.unions.get(id),
            ))
        ) {
          lowerer.noLowering(
            `emit('data') with a '${lowerer.fmt(chunk.type)}' chunk`,
            args[1]!,
            "the chunk is a value that converts to a checked-dynamic value",
          );
        }
        chunk = lowerer.coerceToExpected(chunk, DYN);
      }
      return {
        kind: "libCall",
        fn: "emitter.emitData",
        args: [receiver, eventNameExpr(name, loc), chunk],
        type: BOOL,
        loc,
      };
    }
    const tuple = streamForcedTuple(lowerer, info, name) ?? tupleOf(lowerer, table, name, call);
    if (args.length - 1 !== tuple.length) {
      lowerer.noLowering(
        `emit('${name}') with ${args.length - 1} arguments where the event's tuple has ${tuple.length}`,
        call,
        "every emit site of one event name must supply the same argument tuple (listeners may declare a prefix)",
      );
    }
    const payload = args.slice(1).map((a, i) => lowerer.lowerExprExpecting(a, tuple[i]));
    return emitDispatchExpr(lowerer, info, name, tuple, receiver, payload, superRecv?.cls, loc);
  }

  // The pure-introspection members take ANY string-typed name — no tuple
  // is involved, so the literal rule has nothing to protect (a meta
  // listener naturally passes its name parameter along).
  if (member === "removeAllListeners") {
    if (args.length > 1) {
      lowerer.noLowering(`removeAllListeners with ${args.length} arguments`, call);
    }
    const all = args.length === 0;
    const receiver = lowerReceiver();
    const name = all
      ? strLit("", loc)
      : isErrorMonitorRef(lowerer, args[0]!)
        ? eventNameExpr(ERROR_MONITOR_EVENT, loc)
        : lowerer.lowerExprExpecting(args[0]!, STRING);
    if (name.type.kind !== "string") {
      lowerer.noLowering(
        `removeAllListeners with a '${lowerer.fmt(name.type)}' event name`,
        args[0] ?? call,
      );
    }
    return {
      kind: "libCall",
      fn: "emitter.removeAll",
      args: [receiver, name, boolLit(all, loc)],
      type: receiver.type,
      loc,
    };
  }

  if (member === "listenerCount") {
    if (args.length !== 1 && args.length !== 2) {
      lowerer.noLowering(`listenerCount with ${args.length} arguments`, call);
    }
    const receiver = lowerReceiver();
    const name = isErrorMonitorRef(lowerer, args[0]!)
      ? eventNameExpr(ERROR_MONITOR_EVENT, loc)
      : lowerer.lowerExprExpecting(args[0]!, STRING);
    if (name.type.kind !== "string") {
      lowerer.noLowering(`listenerCount with a '${lowerer.fmt(name.type)}' event name`, args[0]!);
    }
    if (args.length === 2) {
      // The fn filter matches by identity — the listener's own type is
      // its word; no tuple check is needed to count.
      const cb = lowerer.lowerExpr(args[1]!);
      if (cb.type.kind === "dyn") {
        return {
          kind: "libCall",
          fn: "emitter.countDyn",
          args: [receiver, name, cb],
          type: F64,
          loc,
        };
      }
      if (cb.type.kind !== "func") {
        lowerer.noLowering(`listenerCount with a non-function filter`, args[1]!);
      }
      return { kind: "libCall", fn: "emitter.countFn", args: [receiver, name, cb], type: F64, loc };
    }
    return { kind: "libCall", fn: "emitter.count", args: [receiver, name], type: F64, loc };
  }

  if (member === "listeners" || member === "rawListeners") {
    // A fresh +1 closure array of the event's listeners in list order,
    // element-typed by the event's unified tuple: every registered
    // listener declared a typeEquals PREFIX of it, and calling one through
    // the full-tuple signature delivers exactly what emit would (extra
    // trailing arguments are ignored — JS's semantics, and the C calling
    // convention's). The event NAME must be a compile-time literal — the
    // element type depends on it. Both members answer the ORIGINALS: the
    // once wrapper is runtime-internal, so rawListeners' wrapper identity
    // is a documented divergence (SEMANTICS.md).
    if (args.length !== 1) {
      lowerer.noLowering(
        `${member} with ${args.length} arguments`,
        call,
        "the supported form is (eventName)",
      );
    }
    const name = eventNameOf(lowerer, member, args[0]!);
    const sig = table.get(name);
    if (
      sig?.dynListener ||
      flexibleJsEvent(name, sig) ||
      computedPatterns(lowerer).some(
        (pattern) => pattern.listener && patternMatchesName(pattern, name),
      )
    ) {
      // A dyn-adapted registration means the runtime bucket can hold
      // originals of MIXED signatures — no one honest element type.
      lowerer.noLowering(
        `${member} of the event '${name}'`,
        call,
        "a listener of this event uses checked-dynamic dispatch, so the listener array has no one static element type — listenerCount(name) counts",
      );
    }
    const tuple = tupleOf(lowerer, table, name, call);
    const receiver = lowerReceiver();
    return {
      kind: "libCall",
      fn: "emitter.listeners",
      args: [receiver, eventNameExpr(name, loc)],
      type: arrayOf({ kind: "func", params: tuple, ret: { kind: "void" } }),
      loc,
    };
  }

  if (member === "eventNames") {
    if (args.length !== 0) lowerer.noLowering(`eventNames with ${args.length} arguments`, call);
    const receiver = lowerReceiver();
    return { kind: "libCall", fn: "emitter.names", args: [receiver], type: arrayOf(STRING), loc };
  }

  if (member === "setMaxListeners") {
    if (args.length !== 1)
      lowerer.noLowering(`setMaxListeners with ${args.length} arguments`, call);
    const receiver = lowerReceiver();
    if (lowerer.mapTypeOf(lowerer.typeOf(args[0]!))?.kind !== "f64") {
      // The invalid-input probes (string n, dyn helpers): Node's ladder
      // runs at runtime — ERR_INVALID_ARG_TYPE for non-numbers,
      // ERR_OUT_OF_RANGE below zero, and a well-typed dyn still applies.
      const raw = lowerer.lowerExpr(args[0]!);
      if (raw.type.kind === "dyn" || raw.kind === "unitLit" || lowerer.dynConvertible(raw.type)) {
        const n: IrExpr =
          raw.type.kind === "dyn" ? raw : { kind: "dynFrom", value: raw, type: DYN, loc };
        return {
          kind: "libCall",
          fn: "emitter.setMaxChk",
          args: [receiver, n],
          type: receiver.type,
          loc,
        };
      }
    }
    const n = lowerer.lowerExprExpecting(args[0]!, F64);
    return { kind: "libCall", fn: "emitter.setMax", args: [receiver, n], type: receiver.type, loc };
  }

  if (member === "getMaxListeners") {
    if (args.length !== 0)
      lowerer.noLowering(`getMaxListeners with ${args.length} arguments`, call);
    const receiver = lowerReceiver();
    return { kind: "libCall", fn: "emitter.getMax", args: [receiver], type: F64, loc };
  }

  return null;
}

/* ── emit overrides (`class Logged extends EventEmitter { emit(...) }`) ──
 * The one EventEmitter member a subclass may re-declare, in the FORWARDING
 * SHAPE: `emit(event: string, ...args: unknown[]): boolean` whose rest
 * parameter appears only as `super.emit(event, ...args)` in the method's
 * own body (`event` reads freely; writes to it would un-pin the forward's
 * name). The static story is per-event monomorphization, riding the same
 * program-global tuple table as every emit site: each event name that can
 * dispatch through the override gets one specialization method `emit:<e>`
 * — a REAL hierarchy method (vtable participation, override-exact ABI
 * `(this, ...tuple) => bool`), whose body is the user body with `event`
 * bound to the name and the super-forward lowered to the runtime emit (or
 * to the nearest override ancestor's specialization — JS's super chain).
 * Dispatch at emit sites is then the ordinary whole-program rule: a
 * receiver at-or-below an override class calls the specialization directly
 * (virtually when a deeper override exists); a receiver ABOVE every
 * override (a plain EventEmitter binding) routes through an interned
 * helper that tests the dynamic class per topmost override subtree
 * (preorder-interval instanceOf) and falls through to the runtime emit.
 * What stays out: the runtime's INTERNAL meta-event emission cannot route
 * through an override, so registering 'newListener'/'removeListener'
 * listeners fences while a comparable override exists (the registration
 * is the one observer); every other member keeps the override fence. */

export interface EmitOverrideRec {
  decl: ts.MethodDeclaration;
  eventSym: ts.Symbol;
  restSym: ts.Symbol;
}

/** The lowering context of one specialization body (lowerEmitOverrideSpec
 * sets it; lowerSuperMethodCall's forward interception reads it). */
export interface EmitSpecCtx {
  info: ClassInfo;
  event: string;
  tuple: IrType[];
  eventSym: ts.Symbol;
  restSym: ts.Symbol;
  tupleParams: IrLocal[];
}

/** One queued specialization: `%<class>.emit:<event>`, lowered in the
 * drive loop's fixpoint (its body can queue further specializations —
 * the super-forward chain — and generic instances). */
export interface EmitSpecRequest {
  info: ClassInfo;
  event: string;
  tuple: IrType[];
  /** Per-class body ordinal: bodies past the first suppress coverage
   * stats (one source method, many monomorphized copies). */
  ordinal: number;
}

/** Why a subclass `emit` declaration is NOT the forwarding shape, or null
 * when it conforms. Checked at class collection; the recorded override
 * then lowers per event with no further shape questions. */
export function emitOverrideShapeReason(
  lowerer: Lowerer,
  member: ts.MethodDeclaration,
): string | null {
  if (!member.body) return "the declaration has no body";
  if (member.asteriskToken !== undefined) return "generator methods cannot answer emit's boolean";
  if ((member as { questionToken?: ts.Node }).questionToken !== undefined)
    return "optional method declarations have no lowering";
  if (member.typeParameters !== undefined) return "the compiled shape declares no type parameters";
  for (const m of member.modifiers?.nodes ?? []) {
    if (m.kind === ts.SyntaxKind.AsyncKeyword)
      return "async methods answer a Promise, not emit's boolean";
    if (m.kind === ts.SyntaxKind.AbstractKeyword)
      return "abstract declarations have no body to lower";
    if (m.kind === ts.SyntaxKind.Decorator) return "decorated methods have no lowering";
  }
  if (member.parameters.nodes.length !== 2) return "it must declare exactly (event, ...args)";
  const p0 = member.parameters.nodes[0]!;
  const p1 = member.parameters.nodes[1]!;
  if (
    !ts.isIdentifier(p0.name) ||
    p0.dotDotDotToken !== undefined ||
    p0.questionToken !== undefined ||
    p0.initializer !== undefined ||
    (p0.modifiers?.nodes.length ?? 0) > 0
  ) {
    return "the event parameter must be a plain identifier";
  }
  if (
    !p1.dotDotDotToken ||
    !ts.isIdentifier(p1.name) ||
    p1.initializer !== undefined ||
    (p1.modifiers?.nodes.length ?? 0) > 0
  ) {
    return "the second parameter must be a plain rest parameter (...args)";
  }
  try {
    // TS: the event parameter must be annotated `string` (bivariance
    // admits it under the `string | symbol` base — symbols have no
    // lowering anyway). JS: unannotated is the only spelling (checker
    // `any`); the specialization binds it as the string it always is —
    // event names are compile-time literals program-wide.
    const p0T = lowerer.mapTypeOf(lowerer.typeOf(p0.name));
    const jsUnannotated =
      p0.type === undefined &&
      isJsSourceFile(ts.getSourceFileOfNode(member)) &&
      (p0T === null || p0T.kind === "dyn");
    if (p0T?.kind !== "string" && !jsUnannotated) {
      return "the event parameter must be typed 'string' (symbol event names have no lowering)";
    }
    const sig = lowerer.checker.getSignatureFromDeclaration(member);
    const ret = sig ? lowerer.mapTypeOf(lowerer.checker.getReturnTypeOfSignature(sig)) : null;
    if (ret?.kind !== "bool") {
      return "every code path must return a boolean (emit's contract)";
    }
  } catch {
    return "its signature does not resolve statically";
  }
  const eventSym = lowerer.checker.getSymbolAtLocation(p0.name);
  const restSym = lowerer.checker.getSymbolAtLocation(p1.name);
  if (!eventSym || !restSym) return "its parameters do not resolve statically";
  let reason: string | null = null;
  const visit = (n: ts.Node): void => {
    if (reason !== null) return;
    if (ts.isIdentifier(n)) {
      let s: ts.Symbol | undefined;
      try {
        s = lowerer.checker.getSymbolAtLocation(n) ?? undefined;
      } catch {
        s = undefined;
      }
      if (s === restSym && !isEmitForwardSpread(lowerer, member, n, eventSym)) {
        reason =
          "the rest parameter may only forward through super.emit(event, ...args) in the method's own body";
      } else if (s === eventSym && n !== p0.name && isWriteTarget(n)) {
        reason =
          "the event parameter cannot be reassigned (the forward's event name must stay pinned)";
      }
    }
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(member.body, visit);
  return reason;
}

/** True when this rest-parameter reference is exactly the forward spread:
 * `super.emit(<event param>, ...<this identifier>)`, two arguments, sitting
 * in the override method's OWN body (a nested function could not reach the
 * specialization's tuple parameters). */
function isEmitForwardSpread(
  lowerer: Lowerer,
  method: ts.MethodDeclaration,
  id: ts.Identifier,
  eventSym: ts.Symbol,
): boolean {
  const sp = id.parent;
  if (!ts.isSpreadElement(sp) || sp.expression !== id) return false;
  const call = sp.parent;
  if (
    !ts.isCallExpression(call) ||
    call.arguments.nodes.length !== 2 ||
    call.arguments.nodes[1] !== sp
  )
    return false;
  const callee = call.expression;
  if (
    !ts.isPropertyAccessExpression(callee) ||
    callee.expression.kind !== ts.SyntaxKind.SuperKeyword ||
    callee.name.text !== "emit"
  ) {
    return false;
  }
  const a0 = call.arguments.nodes[0]!;
  if (!ts.isIdentifier(a0)) return false;
  try {
    if (lowerer.checker.getSymbolAtLocation(a0) !== eventSym) return false;
  } catch {
    return false;
  }
  for (let p: ts.Node | undefined = call.parent; p; p = p.parent) {
    if (p === method) return true;
    if (
      ts.isArrowFunction(p) ||
      ts.isFunctionExpression(p) ||
      ts.isFunctionDeclaration(p) ||
      ts.isMethodDeclaration(p) ||
      ts.isConstructorDeclaration(p) ||
      ts.isGetAccessor(p) ||
      ts.isSetAccessor(p) ||
      ts.isClassDeclaration(p) ||
      ts.isClassExpression(p)
    ) {
      return false;
    }
  }
  return false;
}

/** True when the identifier sits in a WRITE position: assignment target
 * (destructuring patterns included — the climb crosses array/object
 * literal layers), ++/--, or a for-in/of initializer. */
function isWriteTarget(id: ts.Identifier): boolean {
  let n: ts.Node = id;
  for (;;) {
    const p: ts.Node | undefined = n.parent;
    if (ts.isBinaryExpression(p)) {
      const k = p.operatorToken.kind;
      return (
        p.left === n && k >= ts.SyntaxKind.FirstAssignment && k <= ts.SyntaxKind.LastAssignment
      );
    }
    if (ts.isPostfixUnaryExpression(p) || ts.isPrefixUnaryExpression(p)) {
      return (
        (p.operator === ts.SyntaxKind.PlusPlusToken ||
          p.operator === ts.SyntaxKind.MinusMinusToken) &&
        p.operand === n
      );
    }
    if (ts.isForOfStatement(p) || ts.isForInStatement(p)) return p.initializer === n;
    if (
      ts.isParenthesizedExpression(p) ||
      ts.isArrayLiteralExpression(p) ||
      ts.isSpreadElement(p) ||
      ts.isSpreadAssignment(p) ||
      ts.isShorthandPropertyAssignment(p) ||
      ts.isObjectLiteralExpression(p) ||
      (ts.isPropertyAssignment(p) && p.initializer === n)
    ) {
      n = p;
      continue;
    }
    return false;
  }
}

/** The nearest class at-or-above `info` declaring an emit override. */
function emitOverrideAtOrAbove(info: ClassInfo | null | undefined): ClassInfo | null {
  for (let c: ClassInfo | null = info ?? null; c; c = c.base) {
    if (c.emitOverride) return c;
  }
  return null;
}

/** Every STRICT descendant of `info` declaring an emit override. */
function collectEmitOverridesBelow(info: ClassInfo, out: ClassInfo[]): void {
  for (const s of info.subclasses) {
    if (s.emitOverride) out.push(s);
    collectEmitOverridesBelow(s, out);
  }
}

/** The topmost override classes strictly below `info` (deeper overrides
 * intercept these through the vtable — one interval test each covers a
 * whole override subtree). */
function topmostEmitOverridesBelow(info: ClassInfo): ClassInfo[] {
  const out: ClassInfo[] = [];
  const walk = (c: ClassInfo): void => {
    for (const s of c.subclasses) {
      if (s.emitOverride) out.push(s);
      else walk(s);
    }
  };
  walk(info);
  return out;
}

/** An emit-override class COMPARABLE to `info` (ancestor-or-self or
 * descendant — a dynamic instance under this static type could dispatch
 * through it), or null. The meta-registration fence's test. */
function emitOverrideComparable(info: ClassInfo): ClassInfo | null {
  const above = emitOverrideAtOrAbove(info);
  if (above) return above;
  const below: ClassInfo[] = [];
  collectEmitOverridesBelow(info, below);
  return below[0] ?? null;
}

/** Interns the specialization `%<class>.emit:<event>`: registers the
 * method on the class (vtable participation — the ABI is `(this, ...tuple)
 * => bool` for every declarer of one event, override-exact by
 * construction) and queues the body for the drive loop's fixpoint. */
function ensureEmitSpec(lowerer: Lowerer, info: ClassInfo, event: string, tuple: IrType[]): void {
  const mName = `emit:${event}`;
  const key = `%${info.def.name}.${mName}`;
  if (lowerer.emitSpecDone.has(key)) return;
  lowerer.emitSpecDone.add(key);
  if (!info.methods.has(mName)) {
    info.methods.set(mName, {
      params: tuple.map((t) => ({ type: t, mode: "required" as const })),
      ret: BOOL,
    });
    // Specializations sit in the method list sorted by event name, so the
    // class table does not depend on which body asked for one first.
    const methods = (info.def.methods ??= []);
    const after = methods.findIndex((m) => m.startsWith("emit:") && m > mName);
    if (after < 0) methods.push(mName);
    else methods.splice(after, 0, mName);
  }
  const ordinal = lowerer.emitSpecQueue.filter((q) => q.info === info).length;
  lowerer.emitSpecQueue.push({ info, event, tuple, ordinal });
}

/** One specialization body: the override method's statements lowered with
 * `event` bound to the name and hidden tuple parameters standing in for
 * the rest parameter (readable ONLY through the super-forward, which the
 * collection shape check guaranteed). */
export function lowerEmitOverrideSpec(lowerer: Lowerer, req: EmitSpecRequest): IrFunction | null {
  const { info, event, tuple, ordinal } = req;
  const ov = info.emitOverride;
  if (!ov?.decl.body) return null;
  const className = info.def.name;
  const thisType: IrType = { kind: "object", className };
  const prevClass = lowerer.currentClass;
  const prevSpec = lowerer.emitSpecCtx;
  const prevSuppress = lowerer.suppressStats;
  lowerer.currentClass = info;
  lowerer.suppressStats = prevSuppress || ordinal > 0;
  lowerer.fnStack.push(newFnCtx(false, null, null, BOOL));
  try {
    const loc = locOf(ov.decl);
    const thisLocal = lowerer.declareThis(thisType);
    const params: IrParam[] = [{ localId: thisLocal.id, name: "this", type: thisType }];
    const tupleParams: IrLocal[] = tuple.map((t, i) => {
      const p = lowerer.declareHiddenLocal(`%ee${i}`, t);
      params.push({ localId: p.id, name: `%ee${i}`, type: t });
      return p;
    });
    const eventDecl = ov.decl.parameters.nodes[0]!;
    const eventLocal = lowerer.declareLocal(
      eventDecl.name,
      ts.isIdentifier(eventDecl.name) ? eventDecl.name.text : "event",
      STRING,
      true,
    );
    const prologue: IrStmt[] = [
      { kind: "varDecl", localId: eventLocal.id, init: eventNameExpr(event, loc), loc },
    ];
    lowerer.emitSpecCtx = {
      info,
      event,
      tuple,
      eventSym: ov.eventSym,
      restSym: ov.restSym,
      tupleParams,
    };
    const body = [...prologue, ...lowerer.lowerStmts(ov.decl.body.statements.nodes)];
    return {
      name: `%${className}.emit:${event}`,
      params,
      returnType: BOOL,
      locals: lowerer.ctx.locals,
      body,
      loc,
    };
  } finally {
    lowerer.emitSpecCtx = prevSpec;
    lowerer.fnStack.pop();
    lowerer.currentClass = prevClass;
    lowerer.suppressStats = prevSuppress;
  }
}

/** The specialization body's `super.emit(event, ...args)` — matched
 * BEFORE the general super lowering (the event name is this
 * specialization's, not a source literal). The target is the nearest
 * override ancestor's specialization (JS's super chain) or the runtime
 * emit. Null when the call is not the forward (a literal-name super.emit
 * rides the general super-emitter route). */
export function emitSpecSuperForward(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  const ctx = lowerer.emitSpecCtx;
  if (!ctx || access.name.text !== "emit" || call.arguments.nodes.length !== 2) return null;
  const a0 = call.arguments.nodes[0]!;
  const a1 = call.arguments.nodes[1]!;
  if (!ts.isIdentifier(a0) || !ts.isSpreadElement(a1) || !ts.isIdentifier(a1.expression))
    return null;
  if (lowerer.checker.getSymbolAtLocation(a0) !== ctx.eventSym) return null;
  if (lowerer.checker.getSymbolAtLocation(a1.expression) !== ctx.restSym) return null;
  const loc = locOf(call);
  const thisLocal = lowerer.resolveThis();
  if (!thisLocal) return null;
  const thisRef: IrExpr = { kind: "varRef", localId: thisLocal.id, type: thisLocal.type, loc };
  const payload: IrExpr[] = ctx.tupleParams.map((p) => ({
    kind: "varRef",
    localId: p.id,
    type: p.type,
    loc,
  }));
  const anc = emitOverrideAtOrAbove(ctx.info.base);
  if (anc) {
    ensureEmitSpec(lowerer, anc, ctx.event, ctx.tuple);
    const callee = `%${anc.def.name}.emit:${ctx.event}`;
    lowerer.noteEdge(callee);
    return {
      kind: "call",
      callee,
      args: [lowerer.upcastTo(thisRef, anc.def.name), ...payload],
      type: BOOL,
      loc,
    };
  }
  if (ctx.event === "error") {
    return {
      kind: "libCall",
      fn: "emitter.emitError",
      args: [thisRef, eventNameExpr(ctx.event, loc), payload[0]!],
      type: BOOL,
      loc,
    };
  }
  return {
    kind: "libCall",
    fn: "emitter.emit",
    args: [thisRef, eventNameExpr(ctx.event, loc), ...payload],
    type: BOOL,
    loc,
  };
}

/** `super.<member>(...)` over an emitter-rooted base — the emitter spoke
 * with the current method's `this` as the receiver and STATIC dispatch
 * (an emit override at-or-below the lexical class never answers a super
 * call — JS's prototype-chain rule). */
export function lowerEmitterSuperCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
  cls: ClassInfo,
): IrExpr | null {
  const thisLocal = lowerer.resolveThis();
  if (!thisLocal) return null;
  const loc = locOf(call);
  const thisRef: IrExpr = { kind: "varRef", localId: thisLocal.id, type: thisLocal.type, loc };
  return lowerEmitterMethodCall(lowerer, call, access, cls, { thisRef, cls });
}

/** One emit site's dispatch: the plain runtime libCall when no override
 * is comparable to the receiver's static class; a direct or virtual
 * specialization call when an override sits at-or-above it; an interned
 * instanceOf-branch helper when overrides exist only strictly below
 * (evaluating receiver and payload exactly once as its arguments). */
function emitDispatchExpr(
  lowerer: Lowerer,
  info: ClassInfo,
  name: string,
  tuple: IrType[],
  receiver: IrExpr,
  payload: IrExpr[],
  superOf: ClassInfo | undefined,
  loc: SrcLoc,
): IrExpr {
  const method = `emit:${name}`;
  const runtime = (recv: IrExpr, args: IrExpr[]): IrExpr =>
    name === "error"
      ? {
          kind: "libCall",
          fn: "emitter.emitError",
          args: [recv, eventNameExpr(name, loc), args[0]!],
          type: BOOL,
          loc,
        }
      : {
          kind: "libCall",
          fn: "emitter.emit",
          args: [recv, eventNameExpr(name, loc), ...args],
          type: BOOL,
          loc,
        };
  if (superOf !== undefined) {
    // super.emit: the nearest override STRICTLY ABOVE the lexical class.
    const anc = emitOverrideAtOrAbove(superOf.base);
    if (!anc) return runtime(receiver, payload);
    ensureEmitSpec(lowerer, anc, name, tuple);
    const callee = `%${anc.def.name}.${method}`;
    lowerer.noteEdge(callee);
    return {
      kind: "call",
      callee,
      args: [lowerer.upcastTo(receiver, anc.def.name), ...payload],
      type: BOOL,
      loc,
    };
  }
  const above = emitOverrideAtOrAbove(info);
  const below: ClassInfo[] = [];
  collectEmitOverridesBelow(info, below);
  if (!above && below.length === 0) return runtime(receiver, payload);
  // Every override class an instance at this site could dispatch through
  // gets the event's specialization (descendants intercept via the vtable;
  // the super-forward chain above `above` is ensured as each body lowers).
  if (above) ensureEmitSpec(lowerer, above, name, tuple);
  for (const c of below) ensureEmitSpec(lowerer, c, name, tuple);
  if (above) {
    if (below.length > 0) {
      lowerer.noteVirtualEdge(info, method);
      return {
        kind: "virtualCall",
        className: info.def.name,
        method,
        args: [receiver, ...payload],
        type: BOOL,
        loc,
      };
    }
    const callee = `%${above.def.name}.${method}`;
    lowerer.noteEdge(callee);
    return {
      kind: "call",
      callee,
      args: [lowerer.upcastTo(receiver, above.def.name), ...payload],
      type: BOOL,
      loc,
    };
  }
  // Overrides only strictly below: the interned dispatch helper.
  const recvT = receiver.type;
  const key = `emitter.emitDispatch:${typeKey(recvT)}:${name}`;
  let helper = lowerer.arrHofHelpers.get(key);
  if (!helper) {
    helper = keyedHelperName(lowerer, "%emitter.emitDispatch", key);
    lowerer.arrHofHelpers.set(key, helper);
    const params: IrParam[] = [
      { localId: "r.0", name: "r", type: recvT },
      ...tuple.map((t, i) => ({ localId: `a${i}.0`, name: `a${i}`, type: t })),
    ];
    const locals: IrLocal[] = params.map((p) => ({
      id: p.localId,
      name: p.name,
      type: p.type,
      mutable: false,
    }));
    const rRef = (): IrExpr => ({ kind: "varRef", localId: "r.0", type: recvT, loc });
    const argRefs = (): IrExpr[] =>
      tuple.map((t, i) => ({ kind: "varRef", localId: `a${i}.0`, type: t, loc }));
    const body: IrStmt[] = [];
    for (const o of topmostEmitOverridesBelow(info)) {
      const oT: IrType = { kind: "object", className: o.def.name };
      const down: IrExpr = { kind: "downcast", value: rRef(), type: oT, loc };
      const oBelow: ClassInfo[] = [];
      collectEmitOverridesBelow(o, oBelow);
      let target: IrExpr;
      if (oBelow.length > 0) {
        lowerer.noteVirtualEdge(o, method);
        target = {
          kind: "virtualCall",
          className: o.def.name,
          method,
          args: [down, ...argRefs()],
          type: BOOL,
          loc,
        };
      } else {
        const callee = `%${o.def.name}.${method}`;
        lowerer.noteEdge(callee);
        target = { kind: "call", callee, args: [down, ...argRefs()], type: BOOL, loc };
      }
      body.push({
        kind: "if",
        cond: { kind: "instanceOf", value: rRef(), className: o.def.name, type: BOOL, loc },
        then: [{ kind: "return", value: target, loc }],
        else_: null,
        loc,
      });
    }
    body.push({ kind: "return", value: runtime(rRef(), argRefs()), loc });
    lowerer.liftedFns.push({ name: helper, params, returnType: BOOL, locals, body, loc });
  }
  return { kind: "call", callee: helper, args: [receiver, ...payload], type: BOOL, loc };
}

/** The function that boxes one event tuple into the any[] that
 * events.once fulfills with: a capture-free module function per tuple,
 * registered as the typed listener's payload builder. */
function eventsOnceBoxer(
  lowerer: Lowerer,
  call: ts.CallExpression,
  tuple: IrType[],
  arrayT: IrType,
  loc: SrcLoc,
): IrExpr {
  const fnType: IrType = { kind: "func", params: tuple, ret: arrayT };
  const key = `eventsOnce:${typeKey(fnType)}`;
  let name = lowerer.valueHelpers.get(key);
  if (name === undefined) {
    name = keyedHelperName(lowerer, "%events.onceArgs", key);
    lowerer.valueHelpers.set(key, name);
    const params: IrParam[] = tuple.map((type, i) => ({
      localId: `%once.a${i}`,
      name: `arg${i}`,
      type,
    }));
    const getRecord = (id: string) => lowerer.shapes.get(id);
    const getUnion = (id: string) => lowerer.unions.get(id);
    for (const type of tuple) {
      if (type.kind !== "dyn" && !canConvertToDyn(type, getRecord, getUnion)) {
        lowerer.noLowering(
          `events.once of an event whose arguments include '${lowerer.fmt(type)}' values`,
          call,
          "the awaited arguments arrive as any[], so each must convert to a checked-dynamic value",
        );
      }
    }
    const elems = params.map((p) => lowerer.coerceInto(call, varRef(p.localId, p.type, loc), DYN));
    lowerer.liftedFns.push({
      name,
      params,
      returnType: arrayT,
      locals: params.map((p) => ({ id: p.localId, name: p.name, type: p.type, mutable: false })),
      body: [{ kind: "return", value: { kind: "arrayLit", elems, type: arrayT, loc }, loc }],
      loc,
    });
  }
  return { kind: "closure", fnName: name, captures: [], type: fnType, loc };
}

/** The `signal` of an events.once options object literal (a checked-
 * dynamic AbortSignal or undefined), or null when the literal names none.
 * Other options forms are refused. */
function eventsOnceSignal(lowerer: Lowerer, node: ts.Expression): IrExpr | null {
  if (!ts.isObjectLiteralExpression(node)) {
    lowerer.noLowering(
      "events.once options that are not an object literal",
      node,
      "pass the options as an object literal: { signal }",
    );
    return null;
  }
  let signal: IrExpr | null = null;
  for (const prop of node.properties.nodes) {
    const name = prop.name && ts.isIdentifier(prop.name) ? prop.name.text : null;
    if (
      name === "signal" &&
      signal === null &&
      (ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop))
    ) {
      signal = lowerer.lowerExprExpecting(
        ts.isPropertyAssignment(prop) ? prop.initializer : (prop.name as ts.Identifier),
        DYN,
      );
    } else {
      lowerer.noLowering(
        "events.once options other than one signal",
        prop,
        "the lowered options object takes signal: AbortSignal",
      );
    }
  }
  return signal;
}

/** events.once(emitter, name[, { signal }]): a promise of the next `name`
 * event's arguments as an array, rejected by an earlier 'error' event
 * (unless the awaited event is 'error') or by the signal's abort with an
 * AbortError. The emitter's listeners are typed by the program-wide event
 * table (a stream's runtime-emitted events by their fixed tuples), so the
 * runtime registers one-shot typed listeners whose compiler-built boxers
 * turn the event's tuple into the array. EventTarget receivers, a stream's
 * 'data' event, computed names and options other than a literal { signal }
 * are refused. */
export function lowerEventsOnce(lowerer: Lowerer, call: ts.CallExpression, loc: SrcLoc): IrExpr {
  const args = call.arguments.nodes;
  if (args.length < 2 || args.length > 3 || args.some(ts.isSpreadElement)) {
    lowerer.noLowering("events.once without an emitter, an event name and options", call);
  }
  // Node's Promise<any[]>: the arguments array of checked-dynamic values.
  const arrayT = arrayOf(DYN);
  const resultT: IrType = { kind: "promise", inner: arrayT };
  let receiver = lowerer.lowerExpr(args[0]!);
  // A checked-dynamic NodeJS stream slot (dyn-streams.ts): a native stream
  // unboxes by identity; any other value throws the not-supported Error.
  if (
    receiver.type.kind === "dyn" &&
    lowerer.dynNodeStreams &&
    nodeStreamInterfaceSide(lowerer, lowerer.typeOf(args[0]!)) !== null
  ) {
    receiver = {
      kind: "libCall",
      fn: "stream.unboxDyn",
      args: [
        receiver,
        strLit(
          "events.once over stream objects other than native streams is not supported yet",
          loc,
        ),
      ],
      type: { kind: "object", className: "%Duplex" },
      loc,
    };
  }
  const info =
    receiver.type.kind === "object" ? lowerer.classes.get(receiver.type.className) : undefined;
  if (!emitterRooted(lowerer, info)) {
    // A NodeJS stream interface slot that holds a stdio handle here: the
    // program lowers again with the runtime stream classes.
    requestGeneralStreamSurface(lowerer, args[0]!);
    lowerer.noLowering(
      "events.once over this value",
      args[0]!,
      "the emitter must be an EventEmitter or stream instance; EventTarget receivers are not supported yet",
    );
  }
  const name = literalEventName(lowerer, args[1]!);
  if (name === null || META_EVENTS.has(name) || name === ERROR_MONITOR_EVENT) {
    lowerer.noLowering(
      "events.once with a computed or meta event name",
      args[1]!,
      "name the awaited event with a string literal",
    );
  }
  const event = name ?? "";
  const sides = streamSidesOf(lowerer, info);
  if ((sides === "r" || sides === "rw") && (event === "data" || event === "keypress")) {
    lowerer.noLowering(
      `events.once of a stream's '${event}' event`,
      args[1]!,
      `the chunk has no checked-dynamic boxing here; register stream.once('${event}', listener) instead`,
    );
  }
  const table = emitterEvents(lowerer);
  if (event !== "error" && flexibleJsEvent(event, table.get(event))) {
    lowerer.noLowering(
      `events.once of the event '${event}', which is emitted with computed names or checked-dynamic listeners`,
      args[1]!,
    );
  }
  const tuple = streamForcedTuple(lowerer, info, event) ?? tupleOf(lowerer, table, event, call);
  const errorTuple: IrType[] = [{ kind: "object", className: "%Error" }];
  const boxer = eventsOnceBoxer(lowerer, call, tuple, arrayT, loc);
  const errorBoxer = eventsOnceBoxer(lowerer, call, errorTuple, arrayT, loc);
  const signal = args.length > 2 ? eventsOnceSignal(lowerer, args[2]!) : null;
  const common = [
    receiver,
    eventNameExpr(event, loc),
    boxer,
    errorBoxer,
    boolLit(event !== "error", loc),
  ];
  return {
    kind: "libCall",
    fn: signal === null ? "events.once" : "events.onceSignal",
    args: signal === null ? common : [...common, signal],
    type: resultT,
    loc,
  };
}

/** The EventEmitter argument of an events-module helper: an emitter
 * instance (not a stream, whose listener tuples the runtime pins). */
function helperEmitter(lowerer: Lowerer, member: string, node: ts.Expression): IrExpr {
  const value = lowerer.lowerExpr(node);
  const info = value.type.kind === "object" ? lowerer.classes.get(value.type.className) : undefined;
  if (!emitterRooted(lowerer, info) || streamSidesOf(lowerer, info) !== null) {
    lowerer.noLowering(
      `events.${member} over this value`,
      node,
      "the argument must be an EventEmitter instance; EventTarget and stream arguments are not supported yet",
    );
  }
  return value;
}

/** setMaxListeners(n) with no targets: the process-wide default, through
 * Node's validateNumber(n, 'setMaxListeners', 0) ladder. */
function lowerDefaultMaxListenersSet(lowerer: Lowerer, node: ts.Expression, loc: SrcLoc): IrExpr {
  if (lowerer.mapTypeOf(lowerer.typeOf(node))?.kind !== "f64") {
    // Node's runtime ladder over the dyn value ("setMaxListeners" is
    // the message's slot for the static form).
    const raw = lowerer.lowerExpr(node);
    if (raw.type.kind === "dyn" || raw.kind === "unitLit" || lowerer.dynConvertible(raw.type)) {
      const n: IrExpr =
        raw.type.kind === "dyn" ? raw : { kind: "dynFrom", value: raw, type: DYN, loc };
      return {
        kind: "libCall",
        fn: "emitter.setDefaultMaxChk",
        args: [n, { kind: "strLit", value: "setMaxListeners", type: STRING, loc }],
        type: VOID,
        loc,
      };
    }
  }
  const n = lowerer.lowerExprExpecting(node, F64);
  if (n.type.kind !== "f64") {
    lowerer.noLowering(
      `EventEmitter.setMaxListeners with a '${lowerer.fmt(n.type)}' argument`,
      node,
      "the lowered form takes a number (Node throws ERR_INVALID_ARG_TYPE at runtime for other values)",
    );
  }
  return { kind: "libCall", fn: "emitter.setDefaultMax", args: [n], type: VOID, loc };
}

/** The events module's helpers over EventEmitter instances, also reachable
 * as EventEmitter statics: listenerCount(emitter, name), getMaxListeners
 * (emitter), setMaxListeners(n[, ...emitters]) and getEventListeners
 * (emitter, name). Node answers each through the emitter's own method, so
 * they lower as those methods do. EventTarget and stream arguments are
 * refused. Null for other members. */
export function lowerEventsEmitterHelper(
  lowerer: Lowerer,
  call: ts.CallExpression,
  member: string,
  loc: SrcLoc,
): IrExpr | null {
  const args = call.arguments.nodes;
  if (args.some(ts.isSpreadElement)) {
    lowerer.noLowering(`events.${member} with spread arguments`, call);
  }
  if (member === "listenerCount") {
    if (args.length !== 2)
      lowerer.noLowering(`events.listenerCount with ${args.length} arguments`, call);
    const receiver = helperEmitter(lowerer, member, args[0]!);
    const name = isErrorMonitorRef(lowerer, args[1]!)
      ? eventNameExpr(ERROR_MONITOR_EVENT, loc)
      : lowerer.lowerExprExpecting(args[1]!, STRING);
    if (name.type.kind !== "string") {
      lowerer.noLowering(
        `events.listenerCount with a '${lowerer.fmt(name.type)}' event name`,
        args[1]!,
      );
    }
    return { kind: "libCall", fn: "emitter.count", args: [receiver, name], type: F64, loc };
  }
  if (member === "getMaxListeners") {
    if (args.length !== 1)
      lowerer.noLowering(`events.getMaxListeners with ${args.length} arguments`, call);
    const receiver = helperEmitter(lowerer, member, args[0]!);
    return { kind: "libCall", fn: "emitter.getMax", args: [receiver], type: F64, loc };
  }
  if (member === "setMaxListeners") {
    // An omitted n is the current default, assigned again.
    if (args.length === 0) {
      return {
        kind: "libCall",
        fn: "emitter.setDefaultMax",
        args: [{ kind: "libCall", fn: "emitter.getDefaultMax", args: [], type: F64, loc }],
        type: VOID,
        loc,
      };
    }
    if (args.length === 1) return lowerDefaultMaxListenersSet(lowerer, args[0]!, loc);
    // Node evaluates every argument, validates n, then sets each target.
    const n = lowerer.lowerExprExpecting(args[0]!, F64);
    if (n.type.kind !== "f64") {
      lowerer.noLowering(
        `events.setMaxListeners with a '${lowerer.fmt(n.type)}' limit and targets`,
        args[0]!,
        "pass a number",
      );
    }
    const limit = lowerer.declareHiddenLocal("%maxListeners", F64);
    const stmts: IrStmt[] = [{ kind: "varDecl", localId: limit.id, init: n, loc }];
    const targets = args.slice(1).map((node) => {
      const value = helperEmitter(lowerer, member, node);
      const slot = lowerer.declareHiddenLocal("%maxListenersTarget", value.type);
      stmts.push({ kind: "varDecl", localId: slot.id, init: value, loc });
      return varRef(slot.id, value.type, loc);
    });
    for (const target of targets) {
      stmts.push({
        kind: "exprStmt",
        expr: {
          kind: "libCall",
          fn: "emitter.setMax",
          args: [target, varRef(limit.id, F64, loc)],
          type: target.type,
          loc,
        },
        loc,
      });
    }
    // The effects sit in the statements; the call answers undefined.
    const tail: IrExpr = { kind: "libCall", fn: "console.noop", args: [], type: VOID, loc };
    return { kind: "seqExpr", stmts, result: tail, type: VOID, loc };
  }
  if (member === "getEventListeners") {
    if (args.length !== 2)
      lowerer.noLowering(`events.getEventListeners with ${args.length} arguments`, call);
    // emitter.listeners(name): the event's listener array, typed by the
    // event's unified tuple (the instance method's rules).
    const receiver = helperEmitter(lowerer, member, args[0]!);
    const name = eventNameOf(lowerer, "events.getEventListeners", args[1]!);
    const table = emitterEvents(lowerer);
    const sig = table.get(name);
    if (
      sig?.dynListener ||
      flexibleJsEvent(name, sig) ||
      computedPatterns(lowerer).some(
        (pattern) => pattern.listener && patternMatchesName(pattern, name),
      )
    ) {
      lowerer.noLowering(
        `events.getEventListeners of the event '${name}'`,
        call,
        "a listener of this event uses checked-dynamic dispatch, so the listener array has no one static element type — listenerCount(emitter, name) counts",
      );
    }
    const tuple = tupleOf(lowerer, table, name, call);
    return {
      kind: "libCall",
      fn: "emitter.listeners",
      args: [receiver, eventNameExpr(name, loc)],
      type: arrayOf({ kind: "func", params: tuple, ret: { kind: "void" } }),
      loc,
    };
  }
  return null;
}
