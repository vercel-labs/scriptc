/* The node:events EventEmitter lowering (the spoke-module pattern, like
 * lower-server.ts): every EMITTER_API_MEMBERS method call on a receiver
 * whose class roots at %EventEmitter lands here, from
 * lowerObjectMethodCall.
 *
 * THE TYPING STANCE. Node types EventEmitter untyped — `emit(name,
 * ...args: any[])`, listeners `(...args: any[]) => void` — which has no
 * static lowering. The honest model here is per-event monomorphization:
 * event names must be compile-time string literals (the net/http/process
 * precedent), and each event name gets ONE argument tuple, unified across
 * the whole program (a pre-pass scans every emit site's argument types
 * and every registered listener's annotated parameter types). Emit sites
 * must supply exactly the tuple; listeners may declare any PREFIX of it
 * (Node calls listeners with all arguments; extra parameters would read
 * undefined and have no honest type). The table is program-global, not
 * per-class: every emitter class shares the %EventEmitter root and
 * upcasts alias freely, so per-class tables would be unsound. The JS
 * lane's unannotated listeners (checker `any` — dyn) do not fence: they
 * register through the checked-dynamic boundary (lowerDynListenerCall —
 * emit arguments box to dyn, JS-exact arity, the original kept as the
 * registry entry's identity). What the static model cannot carry is
 * fenced with its own words: non-literal names, symbol names,
 * conflicting tuples, the meta-events' listener-function argument (meta
 * listeners take at most the event name; dyn meta listeners fence — Node
 * passes the listener function second, which has no dyn conversion), and
 * listeners()/rawListeners() of an event with any dyn-flavored
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
import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";
import { dynFallbackType, newFnCtx } from "./lowerer.js";
import type { ClassInfo } from "./lower-classes.js";
import { isJsSourceFile, locOf } from "../program.js";
import { arrayOf, BOOL, canBoxFuncIntoDyn, canConvertToDyn, DYN, F64, IrExpr, IrFunction, IrLocal, IrParam, IrStmt, IrType, isUnitType, STRING, SrcLoc, typeEquals, typeKey, VOID } from "../../ir/nodes.js";
import { streamForcedTuple, streamSidesOf } from "./lower-stream.js";
import { boolLit, strLit, varRef } from "../../ir/build.js";

/** True when the class descends from (or is) the runtime emitter. */
export function emitterRooted(L: Lowerer, info: ClassInfo | undefined | null): boolean {
  for (let c: ClassInfo | null = info ?? null; c; c = c.base) {
    if (c.builtinEmitter) return true;
  }
  return false;
}

const REGISTER_MEMBERS: ReadonlySet<string> = new Set([
  "on", "addListener", "once", "prependListener", "prependOnceListener",
]);

const META_EVENTS: ReadonlySet<string> = new Set(["newListener", "removeListener"]);

interface EventSig {
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
}

/** The program-wide event-signature table, built lazily on the first
 * emitter lowering (class shapes are collected before any body lowers, so
 * receiver classes resolve). The scan is DIAGNOSTIC-FREE: unmappable
 * types and non-literal names are simply not candidates — the touching
 * sites speak for themselves when they lower. */
function emitterEvents(L: Lowerer): Map<string, EventSig> {
  const holder = L as unknown as { emitterEventTable?: Map<string, EventSig> };
  if (holder.emitterEventTable) return holder.emitterEventTable;
  const table = new Map<string, EventSig>();
  const sigOf = (name: string): EventSig => {
    let sig = table.get(name);
    if (!sig) table.set(name, (sig = { tuple: [], fromEmit: false, conflict: null, dynListener: false }));
    return sig;
  };
  // The two forced tuples (see the header comment).
  table.set("error", { tuple: [{ kind: "object", className: "%Error" }], fromEmit: true, conflict: null, dynListener: false });
  table.set("newListener", { tuple: [STRING], fromEmit: true, conflict: null, dynListener: false });
  table.set("removeListener", { tuple: [STRING], fromEmit: true, conflict: null, dynListener: false });

  const fmt = (t: IrType): string => L.fmt(t);
  const mergeEmit = (name: string, args: (IrType | null)[]): void => {
    if (args.some((a) => a === null)) return; // its own site will diagnose
    const tuple = args as IrType[];
    const sig = sigOf(name);
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

  for (const sf of L.program.getSourceFiles()) {
    if (sf.isDeclarationFile) continue;
    const walk = (node: ts.Node): void => {
      ts.forEachChild(node, walk);
      if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return;
      const member = node.expression.name.text;
      const isEmit = member === "emit";
      if (!isEmit && !REGISTER_MEMBERS.has(member)) return;
      const arg0 = node.arguments[0];
      if (!arg0) return;
      let recvT: IrType | null = null;
      let nameT: ts.Type | null = null;
      try {
        recvT = L.mapTypeOf(L.typeOf(node.expression.expression));
        nameT = L.typeOf(arg0);
      } catch {
        return; // checker trouble is the lowering's business, not the scan's
      }
      if (recvT?.kind !== "object" || !emitterRooted(L, L.classes.get(recvT.className))) return;
      if (!nameT.isStringLiteralType()) return;
      const name = nameT.value;
      if (META_EVENTS.has(name) || name === "error") return; // forced tuples
      // Stream receivers' runtime-emitted events carry PER-BASE forced
      // tuples (lower-stream.ts) — their sites never join the program-
      // global table, so a stream's 'data' cannot collide with a user
      // event named 'data' on a plain emitter.
      if (streamForcedTuple(L, L.classes.get(recvT.className), name) !== null) return;
      try {
        if (isEmit) {
          mergeEmit(name, node.arguments.slice(1).map((a) => L.mapTypeOf(L.typeOf(a))));
        } else if (node.arguments[1]) {
          const cbCt = L.typeOf(node.arguments[1]);
          const cbT = L.mapTypeOf(cbCt) ?? dynFallbackType(L, node.arguments[1], cbCt);
          // Dyn-flavored listeners (a checked-dynamic value, or a func
          // with dyn parameters — the JS lane) register through the
          // adapter and constrain nothing: a dyn parameter accepts any
          // tuple position, and positions past the tuple read the boxed
          // undefined (exactly JS's extra-parameter semantics).
          if (cbT?.kind === "dyn" || (cbT?.kind === "func" && cbT.params.some((p) => p.kind === "dyn"))) {
            sigOf(name).dynListener = true;
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
  holder.emitterEventTable = table;
  return table;
}

/** The compile-time event name of the first argument, or a pointed fence
 * (string-literal TYPE, so const bindings and literal unions of one
 * member count — the staticHeaderKeyOf stance). */
function eventNameOf(L: Lowerer, member: string, arg: ts.Expression): string {
  const t = L.typeOf(arg);
  if (t.isStringLiteralType()) return t.value;
  L.noLowering(
    `${member} with a non-literal event name`,
    arg,
    "event names must be compile-time string literals (each event's argument tuple is unified statically; symbol names have no lowering)",
  );
}
/** The event's unified tuple, with conflicts reported at this site. */
function tupleOf(L: Lowerer, table: Map<string, EventSig>, name: string, blame: ts.Node): IrType[] {
  const sig = table.get(name);
  if (!sig) return [];
  if (sig.conflict) {
    L.noLowering(
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
function dynListenerFlavor(L: Lowerer, node: ts.Expression): "dyn" | "func" | null {
  let t: IrType | null;
  try {
    const ct = L.typeOf(node);
    // The JS declaration fallback is what the EXPRESSION lowering applies
    // to inference residue (an inline `(a) => {}` maps null as a checker
    // type but lowers as a dyn-parameter function) — classify by the same
    // rule, so the flavor always matches what lowerExpr will produce.
    t = L.mapTypeOf(ct) ?? dynFallbackType(L, node, ct);
  } catch {
    return null;
  }
  if (t?.kind === "dyn") return "dyn";
  if (t?.kind === "func") return t.params.some((p) => p.kind === "dyn") ? "func" : null;
  // A statically-known NON-function listener (a literal number, a record,
  // null): route it through the dyn path too — the registration helper's
  // checkListener throws Node's exact ERR_INVALID_ARG_TYPE TypeError
  // (the TS lane never reaches this: tsc rejects the argument first).
  if (t && t.kind !== "jsval" && (isUnitType(t) || canConvertToDyn(t, (id) => L.shapes.get(id), (id) => L.unions.get(id)))) {
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
  L: Lowerer,
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
    L.noLowering(
      `'${member}' of '${name}' with a checked-dynamic listener`,
      cbNode,
      "Node passes the listener FUNCTION as the meta event's second argument, which has no dynamic conversion — annotate the listener's parameter as a string",
    );
  }
  const getRecord = (id: string) => L.shapes.get(id);
  const getUnion = (id: string) => L.unions.get(id);
  for (let i = 0; i < tuple.length; i++) {
    const p = tuple[i]!;
    if (p.kind !== "dyn" && !canConvertToDyn(p, getRecord, getUnion)) {
      L.noLowering(
        `'${member}' of '${name}' with a checked-dynamic listener`,
        cbNode,
        `the event's argument ${i} is '${L.fmt(p)}', which cannot box into a dynamic value — annotate the listener's parameters with the emitted types`,
      );
    }
  }
  let cbDyn: IrExpr;
  if (flavor === "dyn") {
    const v = L.lowerExpr(cbNode);
    if (v.type.kind === "dyn") {
      cbDyn = v;
    } else if (v.kind === "unitLit" || canConvertToDyn(v.type, getRecord, getUnion)) {
      // A non-dyn residue the classification saw as dynamic (a literal
      // null/undefined listener, a convertible scalar): box it — the
      // checkListener call answers with Node's exact TypeError.
      cbDyn = { kind: "dynFrom", value: v, type: DYN, loc };
    } else {
      L.noLowering(`'${member}' with a non-function listener`, cbNode);
    }
  } else {
    const cb = L.lowerExpr(cbNode);
    if (cb.type.kind !== "func" || !canBoxFuncIntoDyn(cb.type, getRecord, getUnion)) {
      L.noLowering(
        `'${member}' with a listener of this signature`,
        cbNode,
        "a checked-dynamic listener's own parameters and return must box across the dynamic boundary",
      );
    }
    cbDyn = { kind: "dynFrom", value: cb, type: DYN, loc };
  }
  const recvT = receiver.type;
  const adapterT: IrType = { kind: "func", params: tuple, ret: VOID };
  const onFn = streamData ? "emitter.onDataDyn" as const : "emitter.onDyn" as const;
  const key = registering
    ? `${onFn}:${typeKey(recvT)}:${typeKey(adapterT)}`
    : `emitter.offDyn:${typeKey(recvT)}`;
  const existing = L.arrHofHelpers.get(key);
  let helper = existing;
  if (!helper) {
    helper = `%emitter.${registering ? "onDyn" : "offDyn"}.${L.arrHofHelpers.size}`;
    L.arrHofHelpers.set(key, helper);
    const check: IrStmt = {
      kind: "exprStmt",
      expr: { kind: "libCall", fn: "emitter.checkListener", args: [varRef("cb.0", DYN, loc)], type: VOID, loc },
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
    const locals = params.map((p) => ({ id: p.localId, name: p.name, type: p.type, mutable: false }));
    let body: IrStmt[];
    if (registering) {
      locals.push({ id: "a.0", name: "a", type: adapterT, mutable: false });
      body = [
        check,
        { kind: "varDecl", localId: "a.0", init: { kind: "dynCheck", value: varRef("cb.0", DYN, loc), type: adapterT, loc }, loc },
        {
          kind: "return",
          value: {
            kind: "libCall",
            fn: onFn,
            args: [varRef("r.0", recvT, loc), varRef("n.0", STRING, loc), varRef("cb.0", DYN, loc), varRef("a.0", adapterT, loc), varRef("o.0", BOOL, loc), varRef("p.0", BOOL, loc)],
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
    L.liftedFns.push({ name: helper, params, returnType: recvT, locals, body, loc });
  }
  return {
    kind: "call",
    callee: helper,
    args: registering
      ? [receiver, strLit(name, loc), cbDyn, boolLit(once, loc), boolLit(prepend, loc)]
      : [receiver, strLit(name, loc), cbDyn],
    type: recvT,
    loc,
  };
}

/** A listener argument: lowered, checked void-returning, and its
 * parameters checked as a typeEquals PREFIX of the event tuple. */
function lowerListenerArg(
  L: Lowerer,
  member: string,
  name: string,
  node: ts.Expression,
  tuple: IrType[],
): IrExpr {
  // Unannotated non-empty parameter lists have no static types (checker
  // `any`; dyn in JS sources) — say so before the blanket type fence speaks.
  if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && node.parameters.length > 0) {
    for (const p of node.parameters) {
      if (p.type === undefined && ts.isIdentifier(p.name)) {
        const mapped = (() => {
          try {
            return L.mapTypeOf(L.typeOf(p.name));
          } catch {
            return null;
          }
        })();
        if (mapped === null || mapped.kind === "dyn" || mapped.kind === "jsval") {
          L.noLowering(
            `'${member}' listeners with unannotated parameters`,
            p,
            "EventEmitter's declared listener type is (...args: any[]) — annotate each parameter with the emitted argument's type",
          );
        }
      }
    }
  }
  const cb = L.lowerExpr(node);
  if (cb.type.kind !== "func") {
    L.noLowering(`'${member}' with a non-function listener`, node);
  }
  const cbT = cb.type as IrType & { kind: "func" };
  // Node ignores listener return values, so value-returning listeners
  // (expression-body arrows, mustCall wrappers) register fine — the
  // emitted invoke adapter calls through the listener's true signature
  // and discards (releasing refcounted results). An async listener's
  // promise is abandoned unobserved (SEMANTICS.md).
  if (META_EVENTS.has(name) && cbT.params.length > 1) {
    L.noLowering(
      `'${name}' listeners taking the listener-function argument`,
      node,
      "meta-event listeners take at most the event name (the listener argument has no unified static type)",
    );
  }
  if (cbT.params.length > tuple.length) {
    L.noLowering(
      `a '${name}' listener declaring ${cbT.params.length} parameters where the event's tuple has ${tuple.length}`,
      node,
      "listeners may declare a prefix of the event's emitted arguments",
    );
  }
  for (let i = 0; i < cbT.params.length; i++) {
    if (!typeEquals(cbT.params[i]!, tuple[i]!)) {
      L.noLowering(
        `a '${name}' listener whose parameter ${i} is '${L.fmt(cbT.params[i]!)}' where the event's tuple has '${L.fmt(tuple[i]!)}'`,
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
export function lowerEmitterMethodCall(L: Lowerer, call: ts.CallExpression,
  access: ts.PropertyAccessExpression, info: ClassInfo,
  superRecv?: { thisRef: IrExpr; cls: ClassInfo }): IrExpr | null {
  const member = access.name.text;
  const loc = locOf(call);
  const args = call.arguments;
  const lowerReceiver = (): IrExpr => superRecv?.thisRef ?? L.lowerExpr(access.expression);
  // The class VALUE, not an instance (`EventEmitter.setMaxListeners(n)` —
  // the receiver's checker type carries construct signatures; mapType
  // answers the instance object for every EventEmitter-symbol type, so the
  // instance dispatch conflated the two and handed the instance libCalls a
  // receiver that lowers to the class value, the setMax ICE). The statics
  // are a DIFFERENT surface: setMaxListeners(n) writes the process-wide
  // defaultMaxListeners (validated at runtime — Node's ERR_OUT_OF_RANGE);
  // everything else fences by its static name.
  if (superRecv === undefined && L.checker.getConstructSignatures(L.typeOf(access.expression)).length > 0) {
    if (member === "setMaxListeners" && args.length === 1) {
      if (L.mapTypeOf(L.typeOf(args[0]!))?.kind !== "f64") {
        // Node's runtime ladder over the dyn value ("setMaxListeners" is
        // the message's slot for the static form).
        const raw = L.lowerExpr(args[0]!);
        if (raw.type.kind === "dyn" || raw.kind === "unitLit" || L.dynConvertible(raw.type)) {
          const n: IrExpr = raw.type.kind === "dyn" ? raw : { kind: "dynFrom", value: raw, type: DYN, loc };
          return {
            kind: "libCall",
            fn: "emitter.setDefaultMaxChk",
            args: [n, { kind: "strLit", value: "setMaxListeners", type: STRING, loc }],
            type: VOID,
            loc,
          };
        }
      }
      const n = L.lowerExprExpecting(args[0]!, F64);
      if (n.type.kind !== "f64") {
        L.noLowering(
          `EventEmitter.setMaxListeners with a '${L.fmt(n.type)}' argument`,
          args[0]!,
          "the lowered form takes a number (Node throws ERR_INVALID_ARG_TYPE at runtime for other values)",
        );
      }
      return { kind: "libCall", fn: "emitter.setDefaultMax", args: [n], type: VOID, loc };
    }
    if (member === "setMaxListeners") {
      // The per-target form with a target that is provably NOT an
      // emitter/EventTarget (the invalid-input probes): Node validates n
      // first, then throws ERR_INVALID_ARG_TYPE on the target. Claimed
      // when n is a pure read (identifier/literal — nothing to evaluate)
      // and the target crosses into the checked-dynamic tree for the Received tail.
      if (args.length === 2 && !args.some(ts.isSpreadElement)) {
        const nT = L.mapTypeOf(L.typeOf(args[0]!));
        const tT = L.mapTypeOf(L.typeOf(args[1]!));
        const nPure = ts.isIdentifier(args[0]!) || ts.isLiteralExpression(args[0]!);
        const targetNotEmitter =
          tT !== null && tT.kind !== "dyn" && tT.kind !== "jsval" &&
          !(tT.kind === "object");
        if (nT?.kind === "f64" && nPure && targetNotEmitter) {
          const raw = L.lowerExpr(args[1]!);
          if (raw.type.kind === "dyn" || raw.kind === "unitLit" || L.dynConvertible(raw.type)) {
            const got: IrExpr = raw.type.kind === "dyn" ? raw : { kind: "dynFrom", value: raw, type: DYN, loc };
            return {
              kind: "libCall",
              fn: "error.argTypeThrow",
              args: [
                { kind: "strLit", value: "eventTargets", type: STRING, loc },
                { kind: "strLit", value: "an instance of EventEmitter or EventTarget", type: STRING, loc },
                got,
              ],
              type: VOID,
              loc,
            };
          }
        }
      }
      L.noLowering(
        `EventEmitter.setMaxListeners with ${args.length} arguments`,
        call,
        "the lowered static form is EventEmitter.setMaxListeners(n) — per-target application (…, ...eventTargets) has no lowering; call target.setMaxListeners(n) instead",
      );
    }
    L.noLowering(
      `the static EventEmitter.${member} form`,
      call,
      "instance emitters lower this member; the class-value statics have no lowering yet",
    );
  }
  const table = emitterEvents(L);

  if (REGISTER_MEMBERS.has(member) || member === "off" || member === "removeListener") {
    // Node's (type, listener) signature IGNORES extra arguments — admit
    // pure-read extras (literals/identifiers: nothing to evaluate) and
    // drop them; anything with effects keeps the fence.
    const extrasPure = args.slice(2).every((a) => ts.isIdentifier(a) || ts.isLiteralExpression(a));
    if (args.length < 2 || !extrasPure) {
      L.noLowering(`${member} with ${args.length} arguments`, call, "the supported form is (eventName, listener)");
    }
    const name = eventNameOf(L, member, args[0]!);
    const registering = REGISTER_MEMBERS.has(member);
    // The runtime fires the meta events INTERNALLY (scr_ee_emit_meta —
    // Node calls this.emit, which would dispatch through an emit
    // override): with an override anywhere the receiver's instances could
    // be, a registered meta listener is the one observer of that
    // divergence, so the registration is the honest fence site.
    if (registering && META_EVENTS.has(name)) {
      const ov = emitOverrideComparable(info);
      if (ov) {
        L.noLowering(
          `'${member}' of '${name}' while '${ov.def.jsName || ov.def.name}' overrides emit`,
          call,
          "the runtime fires meta events internally, which cannot route through an emit override",
        );
      }
    }
    const receiver = lowerReceiver();
    const once = member === "once" || member === "prependOnceListener";
    const prepend = member === "prependListener" || member === "prependOnceListener";
    // Stream 'data' rides its own two-slot payload ABI (bytes + string —
    // encoded streams deliver strings; scr_stream_emit_data): listeners
    // on readable-sided receivers register through DATA thunks that
    // unwrap the declared side (typed) or box by tag (dyn).
    const sides = streamSidesOf(L, info);
    if (name === "data" && (sides === "r" || sides === "rw")) {
      const dynFlavor = dynListenerFlavor(L, args[1]!);
      if (dynFlavor !== null) {
        return lowerDynListenerCall(
          L, member, name, [DYN], receiver, args[1]!, dynFlavor, registering, once, prepend, loc, true,
        );
      }
      const cb = L.lowerExpr(args[1]!);
      if (cb.type.kind !== "func") {
        L.noLowering(`'${member}' with a non-function listener`, args[1]!);
      }
      const cbT = cb.type as IrType & { kind: "func" };
      if (cbT.params.length > 1) {
        L.noLowering(
          `a 'data' listener declaring ${cbT.params.length} parameters where the event carries one chunk`,
          args[1]!,
        );
      }
      const p = cbT.params[0];
      if (p !== undefined && !(p.kind === "bytes" && p.elem === "u8") && p.kind !== "string") {
        L.noLowering(
          `a 'data' listener whose chunk parameter is '${L.fmt(p)}'`,
          args[1]!,
          "chunks are Buffers — or strings once setEncoding/the encoding option applies",
        );
      }
      if (!registering) {
        return {
          kind: "libCall",
          fn: "emitter.off",
          args: [receiver, strLit(name, loc), cb],
          type: receiver.type,
          loc,
        };
      }
      return {
        kind: "libCall",
        fn: "emitter.onData",
        args: [receiver, strLit(name, loc), cb, boolLit(once, loc), boolLit(prepend, loc)],
        type: receiver.type,
        loc,
      };
    }
    // Stream-rooted receivers consult the per-base FORCED tuples first
    // (runtime-emitted 'end'/'pipe'/... payloads); the dyn-listener check
    // below then sees the forced tuple exactly like a table one.
    const tuple = streamForcedTuple(L, info, name) ?? tupleOf(L, table, name, call);
    const dynFlavor = dynListenerFlavor(L, args[1]!);
    if (dynFlavor !== null) {
      return lowerDynListenerCall(
        L, member, name, tuple, receiver, args[1]!, dynFlavor, registering, once, prepend, loc, false,
      );
    }
    const cb = lowerListenerArg(L, member, name, args[1]!, tuple);
    return {
      kind: "libCall",
      fn: registering ? "emitter.on" : "emitter.off",
      args: registering
        ? [receiver, strLit(name, loc), cb, boolLit(once, loc), boolLit(prepend, loc)]
        : [receiver, strLit(name, loc), cb],
      type: receiver.type,
      loc,
    };
  }

  if (member === "emit") {
    if (args.length === 0) {
      L.noLowering("emit without an event name", call);
    }
    const name = eventNameOf(L, member, args[0]!);
    const receiver = lowerReceiver();
    if (name === "error") {
      // The special event: exactly one %Error-rooted payload; no listener
      // means the runtime THROWS it (emitter.emitError, may-throw).
      if (args.length !== 2) {
        L.noLowering(
          `emit('error') with ${args.length - 1} payload arguments`,
          call,
          "the supported form is emit('error', err) with an Error-hierarchy payload (non-Error payloads would need Node's ERR_UNHANDLED_ERROR wrapping — no lowering yet)",
        );
      }
      const err = L.lowerExpr(args[1]!);
      const rootsAtError = (t: IrType): boolean => {
        if (t.kind !== "object") return false;
        for (let c: ClassInfo | null = L.classes.get(t.className) ?? null; c; c = c.base) {
          if (c.def.name === "%Error") return true;
        }
        return false;
      };
      if (!rootsAtError(err.type)) {
        L.noLowering(
          `emit('error') with a '${L.fmt(err.type)}' payload`,
          args[1]!,
          "the supported payload is an Error-hierarchy instance",
        );
      }
      return emitDispatchExpr(
        L, info, name, [{ kind: "object", className: "%Error" }],
        receiver, [L.upcastTo(err, "%Error")], superRecv?.cls, loc,
      );
    }
    // Stream 'data' rides the two-slot payload ABI: a user emit fills
    // the chunk's slot (bytes or string), NULLs the other.
    const emitSides = streamSidesOf(L, info);
    if (name === "data" && (emitSides === "r" || emitSides === "rw")) {
      if (args.length !== 2) {
        L.noLowering(`emit('data') with ${args.length - 1} payload arguments`, call, "the event carries one chunk (a Buffer or string)");
      }
      const chunk = L.lowerExpr(args[1]!);
      if (!(chunk.type.kind === "bytes" && chunk.type.elem === "u8") && chunk.type.kind !== "string") {
        L.noLowering(`emit('data') with a '${L.fmt(chunk.type)}' chunk`, args[1]!, "chunks are Buffers or strings");
      }
      return {
        kind: "libCall",
        fn: "emitter.emitData",
        args: [receiver, strLit(name, loc), chunk],
        type: BOOL,
        loc,
      };
    }
    const tuple = streamForcedTuple(L, info, name) ?? tupleOf(L, table, name, call);
    if (args.length - 1 !== tuple.length) {
      L.noLowering(
        `emit('${name}') with ${args.length - 1} arguments where the event's tuple has ${tuple.length}`,
        call,
        "every emit site of one event name must supply the same argument tuple (listeners may declare a prefix)",
      );
    }
    const payload = args.slice(1).map((a, i) => L.lowerExprExpecting(a, tuple[i]));
    return emitDispatchExpr(L, info, name, tuple, receiver, payload, superRecv?.cls, loc);
  }

  // The pure-introspection members take ANY string-typed name — no tuple
  // is involved, so the literal rule has nothing to protect (a meta
  // listener naturally passes its name parameter along).
  if (member === "removeAllListeners") {
    if (args.length > 1) {
      L.noLowering(`removeAllListeners with ${args.length} arguments`, call);
    }
    const all = args.length === 0;
    const receiver = lowerReceiver();
    const name = all ? strLit("", loc) : L.lowerExprExpecting(args[0]!, STRING);
    if (name.type.kind !== "string") {
      L.noLowering(`removeAllListeners with a '${L.fmt(name.type)}' event name`, args[0] ?? call);
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
      L.noLowering(`listenerCount with ${args.length} arguments`, call);
    }
    const receiver = lowerReceiver();
    const name = L.lowerExprExpecting(args[0]!, STRING);
    if (name.type.kind !== "string") {
      L.noLowering(`listenerCount with a '${L.fmt(name.type)}' event name`, args[0]!);
    }
    if (args.length === 2) {
      // The fn filter matches by identity — the listener's own type is
      // its word; no tuple check is needed to count.
      const cb = L.lowerExpr(args[1]!);
      if (cb.type.kind !== "func") {
        L.noLowering(`listenerCount with a non-function filter`, args[1]!);
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
      L.noLowering(`${member} with ${args.length} arguments`, call, "the supported form is (eventName)");
    }
    const name = eventNameOf(L, member, args[0]!);
    const sig = table.get(name);
    if (sig?.dynListener) {
      // A dyn-adapted registration means the runtime bucket can hold
      // originals of MIXED signatures — no one honest element type.
      L.noLowering(
        `${member} of the event '${name}'`,
        call,
        "a listener of this event is checked-dynamic (unannotated parameters), so the listener array has no one static element type — listenerCount(name) counts",
      );
    }
    const tuple = tupleOf(L, table, name, call);
    const receiver = lowerReceiver();
    return {
      kind: "libCall",
      fn: "emitter.listeners",
      args: [receiver, strLit(name, loc)],
      type: arrayOf({ kind: "func", params: tuple, ret: { kind: "void" } }),
      loc,
    };
  }

  if (member === "eventNames") {
    if (args.length !== 0) L.noLowering(`eventNames with ${args.length} arguments`, call);
    const receiver = lowerReceiver();
    return { kind: "libCall", fn: "emitter.names", args: [receiver], type: arrayOf(STRING), loc };
  }

  if (member === "setMaxListeners") {
    if (args.length !== 1) L.noLowering(`setMaxListeners with ${args.length} arguments`, call);
    const receiver = lowerReceiver();
    if (L.mapTypeOf(L.typeOf(args[0]!))?.kind !== "f64") {
      // The invalid-input probes (string n, dyn helpers): Node's ladder
      // runs at runtime — ERR_INVALID_ARG_TYPE for non-numbers,
      // ERR_OUT_OF_RANGE below zero, and a well-typed dyn still applies.
      const raw = L.lowerExpr(args[0]!);
      if (raw.type.kind === "dyn" || raw.kind === "unitLit" || L.dynConvertible(raw.type)) {
        const n: IrExpr = raw.type.kind === "dyn" ? raw : { kind: "dynFrom", value: raw, type: DYN, loc };
        return { kind: "libCall", fn: "emitter.setMaxChk", args: [receiver, n], type: receiver.type, loc };
      }
    }
    const n = L.lowerExprExpecting(args[0]!, F64);
    return { kind: "libCall", fn: "emitter.setMax", args: [receiver, n], type: receiver.type, loc };
  }

  if (member === "getMaxListeners") {
    if (args.length !== 0) L.noLowering(`getMaxListeners with ${args.length} arguments`, call);
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
export function emitOverrideShapeReason(L: Lowerer, member: ts.MethodDeclaration): string | null {
  if (!member.body) return "the declaration has no body";
  if (member.asteriskToken !== undefined) return "generator methods cannot answer emit's boolean";
  if ((member as { questionToken?: ts.Node }).questionToken !== undefined) return "optional method declarations have no lowering";
  if (member.typeParameters !== undefined) return "the compiled shape declares no type parameters";
  for (const m of member.modifiers ?? []) {
    if (m.kind === ts.SyntaxKind.AsyncKeyword) return "async methods answer a Promise, not emit's boolean";
    if (m.kind === ts.SyntaxKind.AbstractKeyword) return "abstract declarations have no body to lower";
    if (m.kind === ts.SyntaxKind.Decorator) return "decorated methods have no lowering";
  }
  if (member.parameters.length !== 2) return "it must declare exactly (event, ...args)";
  const p0 = member.parameters[0]!;
  const p1 = member.parameters[1]!;
  if (
    !ts.isIdentifier(p0.name) || p0.dotDotDotToken !== undefined ||
    p0.questionToken !== undefined || p0.initializer !== undefined ||
    (p0.modifiers?.length ?? 0) > 0
  ) {
    return "the event parameter must be a plain identifier";
  }
  if (
    !p1.dotDotDotToken || !ts.isIdentifier(p1.name) ||
    p1.initializer !== undefined || (p1.modifiers?.length ?? 0) > 0
  ) {
    return "the second parameter must be a plain rest parameter (...args)";
  }
  try {
    // TS: the event parameter must be annotated `string` (bivariance
    // admits it under the `string | symbol` base — symbols have no
    // lowering anyway). JS: unannotated is the only spelling (checker
    // `any`); the specialization binds it as the string it always is —
    // event names are compile-time literals program-wide.
    const p0T = L.mapTypeOf(L.typeOf(p0.name));
    const jsUnannotated =
      p0.type === undefined && isJsSourceFile(member.getSourceFile()) &&
      (p0T === null || p0T.kind === "dyn" || p0T.kind === "jsval");
    if (p0T?.kind !== "string" && !jsUnannotated) {
      return "the event parameter must be typed 'string' (symbol event names have no lowering)";
    }
    const sig = L.checker.getSignatureFromDeclaration(member);
    const ret = sig ? L.mapTypeOf(L.checker.getReturnTypeOfSignature(sig)) : null;
    if (ret?.kind !== "bool") {
      return "every code path must return a boolean (emit's contract)";
    }
  } catch {
    return "its signature does not resolve statically";
  }
  const eventSym = L.checker.getSymbolAtLocation(p0.name);
  const restSym = L.checker.getSymbolAtLocation(p1.name);
  if (!eventSym || !restSym) return "its parameters do not resolve statically";
  let reason: string | null = null;
  const visit = (n: ts.Node): void => {
    if (reason !== null) return;
    if (ts.isIdentifier(n)) {
      let s: ts.Symbol | undefined;
      try {
        s = L.checker.getSymbolAtLocation(n) ?? undefined;
      } catch {
        s = undefined;
      }
      if (s === restSym && !isEmitForwardSpread(L, member, n, eventSym)) {
        reason = "the rest parameter may only forward through super.emit(event, ...args) in the method's own body";
      } else if (s === eventSym && n !== p0.name && isWriteTarget(n)) {
        reason = "the event parameter cannot be reassigned (the forward's event name must stay pinned)";
      }
    }
    n.forEachChild(visit);
  };
  member.body.forEachChild(visit);
  return reason;
}

/** True when this rest-parameter reference is exactly the forward spread:
 * `super.emit(<event param>, ...<this identifier>)`, two arguments, sitting
 * in the override method's OWN body (a nested function could not reach the
 * specialization's tuple parameters). */
function isEmitForwardSpread(L: Lowerer, method: ts.MethodDeclaration, id: ts.Identifier, eventSym: ts.Symbol): boolean {
  const sp = id.parent;
  if (!ts.isSpreadElement(sp) || sp.expression !== id) return false;
  const call = sp.parent;
  if (!ts.isCallExpression(call) || call.arguments.length !== 2 || call.arguments[1] !== sp) return false;
  const callee = call.expression;
  if (
    !ts.isPropertyAccessExpression(callee) ||
    callee.expression.kind !== ts.SyntaxKind.SuperKeyword ||
    callee.name.text !== "emit"
  ) {
    return false;
  }
  const a0 = call.arguments[0]!;
  if (!ts.isIdentifier(a0)) return false;
  try {
    if (L.checker.getSymbolAtLocation(a0) !== eventSym) return false;
  } catch {
    return false;
  }
  for (let p: ts.Node | undefined = call.parent; p; p = p.parent) {
    if (p === method) return true;
    if (
      ts.isArrowFunction(p) || ts.isFunctionExpression(p) || ts.isFunctionDeclaration(p) ||
      ts.isMethodDeclaration(p) || ts.isConstructorDeclaration(p) ||
      ts.isGetAccessor(p) || ts.isSetAccessor(p) ||
      ts.isClassDeclaration(p) || ts.isClassExpression(p)
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
    const p: ts.Node = n.parent;
    if (ts.isBinaryExpression(p)) {
      const k = p.operatorToken.kind;
      return p.left === n && k >= ts.SyntaxKind.FirstAssignment && k <= ts.SyntaxKind.LastAssignment;
    }
    if (ts.isPostfixUnaryExpression(p) || ts.isPrefixUnaryExpression(p)) {
      return (
        (p.operator === ts.SyntaxKind.PlusPlusToken || p.operator === ts.SyntaxKind.MinusMinusToken) &&
        p.operand === n
      );
    }
    if (ts.isForOfStatement(p) || ts.isForInStatement(p)) return p.initializer === n;
    if (
      ts.isParenthesizedExpression(p) || ts.isArrayLiteralExpression(p) ||
      ts.isSpreadElement(p) || ts.isSpreadAssignment(p) ||
      ts.isShorthandPropertyAssignment(p) || ts.isObjectLiteralExpression(p) ||
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
function ensureEmitSpec(L: Lowerer, info: ClassInfo, event: string, tuple: IrType[]): void {
  const mName = `emit:${event}`;
  const key = `%${info.def.name}.${mName}`;
  if (L.emitSpecDone.has(key)) return;
  L.emitSpecDone.add(key);
  if (!info.methods.has(mName)) {
    info.methods.set(mName, { params: tuple.map((t) => ({ type: t, mode: "required" as const })), ret: BOOL });
    if (info.def.methods) info.def.methods.push(mName);
    else info.def.methods = [mName];
  }
  const ordinal = L.emitSpecQueue.filter((q) => q.info === info).length;
  L.emitSpecQueue.push({ info, event, tuple, ordinal });
}

/** One specialization body: the override method's statements lowered with
 * `event` bound to the name and hidden tuple parameters standing in for
 * the rest parameter (readable ONLY through the super-forward, which the
 * collection shape check guaranteed). */
export function lowerEmitOverrideSpec(L: Lowerer, req: EmitSpecRequest): IrFunction | null {
  const { info, event, tuple, ordinal } = req;
  const ov = info.emitOverride;
  if (!ov?.decl.body) return null;
  const className = info.def.name;
  const thisType: IrType = { kind: "object", className };
  const prevClass = L.currentClass;
  const prevSpec = L.emitSpecCtx;
  const prevSuppress = L.suppressStats;
  L.currentClass = info;
  L.suppressStats = prevSuppress || ordinal > 0;
  L.fnStack.push(newFnCtx(false, null, null, BOOL));
  try {
    const loc = locOf(ov.decl);
    const thisLocal = L.declareThis(thisType);
    const params: IrParam[] = [{ localId: thisLocal.id, name: "this", type: thisType }];
    const tupleParams: IrLocal[] = tuple.map((t, i) => {
      const p = L.declareHiddenLocal(`%ee${i}`, t);
      params.push({ localId: p.id, name: `%ee${i}`, type: t });
      return p;
    });
    const eventDecl = ov.decl.parameters[0]!;
    const eventLocal = L.declareLocal(
      eventDecl.name,
      ts.isIdentifier(eventDecl.name) ? eventDecl.name.text : "event",
      STRING,
      true,
    );
    const prologue: IrStmt[] = [
      { kind: "varDecl", localId: eventLocal.id, init: strLit(event, loc), loc },
    ];
    L.emitSpecCtx = { info, event, tuple, eventSym: ov.eventSym, restSym: ov.restSym, tupleParams };
    const body = [...prologue, ...L.lowerStmts(ov.decl.body.statements)];
    return {
      name: `%${className}.emit:${event}`,
      params,
      returnType: BOOL,
      locals: L.ctx.locals,
      body,
      loc,
    };
  } finally {
    L.emitSpecCtx = prevSpec;
    L.fnStack.pop();
    L.currentClass = prevClass;
    L.suppressStats = prevSuppress;
  }
}

/** The specialization body's `super.emit(event, ...args)` — matched
 * BEFORE the general super lowering (the event name is this
 * specialization's, not a source literal). The target is the nearest
 * override ancestor's specialization (JS's super chain) or the runtime
 * emit. Null when the call is not the forward (a literal-name super.emit
 * rides the general super-emitter route). */
export function emitSpecSuperForward(L: Lowerer, call: ts.CallExpression,
  access: ts.PropertyAccessExpression): IrExpr | null {
  const ctx = L.emitSpecCtx;
  if (!ctx || access.name.text !== "emit" || call.arguments.length !== 2) return null;
  const a0 = call.arguments[0]!;
  const a1 = call.arguments[1]!;
  if (!ts.isIdentifier(a0) || !ts.isSpreadElement(a1) || !ts.isIdentifier(a1.expression)) return null;
  if (L.checker.getSymbolAtLocation(a0) !== ctx.eventSym) return null;
  if (L.checker.getSymbolAtLocation(a1.expression) !== ctx.restSym) return null;
  const loc = locOf(call);
  const thisLocal = L.resolveThis();
  if (!thisLocal) return null;
  const thisRef: IrExpr = { kind: "varRef", localId: thisLocal.id, type: thisLocal.type, loc };
  const payload: IrExpr[] = ctx.tupleParams.map((p) => ({ kind: "varRef", localId: p.id, type: p.type, loc }));
  const anc = emitOverrideAtOrAbove(ctx.info.base);
  if (anc) {
    ensureEmitSpec(L, anc, ctx.event, ctx.tuple);
    const callee = `%${anc.def.name}.emit:${ctx.event}`;
    L.noteEdge(callee);
    return { kind: "call", callee, args: [L.upcastTo(thisRef, anc.def.name), ...payload], type: BOOL, loc };
  }
  if (ctx.event === "error") {
    return { kind: "libCall", fn: "emitter.emitError", args: [thisRef, strLit(ctx.event, loc), payload[0]!], type: BOOL, loc };
  }
  return { kind: "libCall", fn: "emitter.emit", args: [thisRef, strLit(ctx.event, loc), ...payload], type: BOOL, loc };
}

/** `super.<member>(...)` over an emitter-rooted base — the emitter spoke
 * with the current method's `this` as the receiver and STATIC dispatch
 * (an emit override at-or-below the lexical class never answers a super
 * call — JS's prototype-chain rule). */
export function lowerEmitterSuperCall(L: Lowerer, call: ts.CallExpression,
  access: ts.PropertyAccessExpression, cls: ClassInfo): IrExpr | null {
  const thisLocal = L.resolveThis();
  if (!thisLocal) return null;
  const loc = locOf(call);
  const thisRef: IrExpr = { kind: "varRef", localId: thisLocal.id, type: thisLocal.type, loc };
  return lowerEmitterMethodCall(L, call, access, cls, { thisRef, cls });
}

/** One emit site's dispatch: the plain runtime libCall when no override
 * is comparable to the receiver's static class; a direct or virtual
 * specialization call when an override sits at-or-above it; an interned
 * instanceOf-branch helper when overrides exist only strictly below
 * (evaluating receiver and payload exactly once as its arguments). */
function emitDispatchExpr(
  L: Lowerer,
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
      ? { kind: "libCall", fn: "emitter.emitError", args: [recv, strLit(name, loc), args[0]!], type: BOOL, loc }
      : { kind: "libCall", fn: "emitter.emit", args: [recv, strLit(name, loc), ...args], type: BOOL, loc };
  if (superOf !== undefined) {
    // super.emit: the nearest override STRICTLY ABOVE the lexical class.
    const anc = emitOverrideAtOrAbove(superOf.base);
    if (!anc) return runtime(receiver, payload);
    ensureEmitSpec(L, anc, name, tuple);
    const callee = `%${anc.def.name}.${method}`;
    L.noteEdge(callee);
    return { kind: "call", callee, args: [L.upcastTo(receiver, anc.def.name), ...payload], type: BOOL, loc };
  }
  const above = emitOverrideAtOrAbove(info);
  const below: ClassInfo[] = [];
  collectEmitOverridesBelow(info, below);
  if (!above && below.length === 0) return runtime(receiver, payload);
  // Every override class an instance at this site could dispatch through
  // gets the event's specialization (descendants intercept via the vtable;
  // the super-forward chain above `above` is ensured as each body lowers).
  if (above) ensureEmitSpec(L, above, name, tuple);
  for (const c of below) ensureEmitSpec(L, c, name, tuple);
  if (above) {
    if (below.length > 0) {
      L.noteVirtualEdge(info, method);
      return { kind: "virtualCall", className: info.def.name, method, args: [receiver, ...payload], type: BOOL, loc };
    }
    const callee = `%${above.def.name}.${method}`;
    L.noteEdge(callee);
    return { kind: "call", callee, args: [L.upcastTo(receiver, above.def.name), ...payload], type: BOOL, loc };
  }
  // Overrides only strictly below: the interned dispatch helper.
  const recvT = receiver.type;
  const key = `emitter.emitDispatch:${typeKey(recvT)}:${name}`;
  let helper = L.arrHofHelpers.get(key);
  if (!helper) {
    helper = `%emitter.emitDispatch.${L.arrHofHelpers.size}`;
    L.arrHofHelpers.set(key, helper);
    const params: IrParam[] = [
      { localId: "r.0", name: "r", type: recvT },
      ...tuple.map((t, i) => ({ localId: `a${i}.0`, name: `a${i}`, type: t })),
    ];
    const locals: IrLocal[] = params.map((p) => ({ id: p.localId, name: p.name, type: p.type, mutable: false }));
    const rRef = (): IrExpr => ({ kind: "varRef", localId: "r.0", type: recvT, loc });
    const argRefs = (): IrExpr[] => tuple.map((t, i) => ({ kind: "varRef", localId: `a${i}.0`, type: t, loc }));
    const body: IrStmt[] = [];
    for (const o of topmostEmitOverridesBelow(info)) {
      const oT: IrType = { kind: "object", className: o.def.name };
      const down: IrExpr = { kind: "downcast", value: rRef(), type: oT, loc };
      const oBelow: ClassInfo[] = [];
      collectEmitOverridesBelow(o, oBelow);
      let target: IrExpr;
      if (oBelow.length > 0) {
        L.noteVirtualEdge(o, method);
        target = { kind: "virtualCall", className: o.def.name, method, args: [down, ...argRefs()], type: BOOL, loc };
      } else {
        const callee = `%${o.def.name}.${method}`;
        L.noteEdge(callee);
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
    L.liftedFns.push({ name: helper, params, returnType: BOOL, locals, body, loc });
  }
  return { kind: "call", callee: helper, args: [receiver, ...payload], type: BOOL, loc };
}
