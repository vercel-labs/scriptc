/* The dgram/dns-surface lowering (node:dgram + node:dns — a spoke module
 * like lower-server.ts): module-function calls (dgram createSocket, dns
 * lookup), method calls on dgramSocket receivers (bind/connect/send/
 * address/close/unref/ref and the message/listening/close/connect/error
 * events), and the AddressInfo record materialization behind address().
 * Everything the lib declares beyond these shapes fences member-qualified
 * — never a generic rejection, never silence. Multicast has no lowering
 * (portless's mDNS publishes through dns-sd/avahi child processes, not
 * dgram multicast); its members fence with a named hint. */
import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";
import { ladderFenceExpr } from "./lowerer.js";
import { isJsSourceFile, locOf } from "../program.js";
import { BOOL, canBoxFuncIntoDyn, DGRAMSOCK_T, DYN, F64, funcOf, IrExpr, IrLibFn, IrType, SrcLoc, STRING, UNDEFINED_T, VOID } from "../../ir/nodes.js";
import { DNS_LOOKUP_DOCUMENTED_OPTIONS, fenceOrDropOptionKey } from "./surfaces.js";

const DGRAM_SURFACE_HINT =
  "bind, connect, send, address, close, unref/ref, and on/once of " +
  "message/listening/close/connect/error are the supported dgram.Socket members";

/** VOID-result socket calls are usable as statements and as concise arrow
 * bodies; anything consuming the result (Node returns `this` where this
 * surface returns void) is fenced — the lower-server stance. */
function requireStatementPosition(L: Lowerer, call: ts.CallExpression, what: string): void {
  if (ts.isExpressionStatement(call.parent) || ts.isArrowFunction(call.parent)) return;
  L.unsupported(
    "SC1090",
    call,
    `using the result of ${what} (the result is void here — call it as its own statement)`,
  );
}

/** Lowers a listener/callback argument, pinning the closure shape: void
 * return, at most `maxParams` parameters, each parameter's IR kind
 * satisfying `paramOk` (indexed). The lower-server helper's shape,
 * re-stated here so the spoke stays self-contained. */
function lowerCallbackArg(
  L: Lowerer,
  node: ts.Expression,
  what: string,
  maxParams: number,
  paramOk: (p: IrType, i: number) => boolean,
  paramHint: string,
): { cb: IrExpr; nparams: number } {
  let cb = L.lowerExpr(node);
  // A checked-dynamic callback (test/common's mustCall wrapper — a dyn
  // value): the zero-parameter slots adapt through the dynCheck function
  // boundary, the lower-server listen-callback precedent.
  if (cb.type.kind === "dyn" && maxParams === 0) {
    cb = { kind: "dynCheck", value: cb, type: funcOf([], VOID), loc: locOf(node) };
  }
  if (cb.type.kind !== "func" || cb.type.params.length > maxParams) {
    L.unsupported(
      "SC1090",
      node,
      `${what} with more than ${maxParams} parameter${maxParams === 1 ? "" : "s"} (${paramHint})`,
    );
  }
  if (cb.type.ret.kind !== "void") {
    L.unsupported(
      "SC1090",
      node,
      "listeners returning a value (make the callback body a block, or return nothing)",
    );
  }
  for (let i = 0; i < cb.type.params.length; i++) {
    if (!paramOk(cb.type.params[i]!, i)) {
      L.unsupported("SC1090", node, `${what} whose parameter is not supported (${paramHint})`);
    }
  }
  return { cb, nparams: cb.type.params.length };
}

const boolLit = (value: boolean, loc: SrcLoc): IrExpr => ({ kind: "boolLit", value, type: BOOL, loc });

/** True iff `t` is the `Error | null` union — dns.lookup's first callback
 * parameter (NodeJS.ErrnoException maps to %Error in types.ts). */
function isErrorOrNullUnion(L: Lowerer, t: IrType): boolean {
  if (t.kind !== "union") return false;
  const def = L.unions.get(t.unionId);
  if (!def || def.arms.length !== 2) return false;
  const hasNull = def.arms.some((a) => a.kind === "nullT");
  const hasError = def.arms.some((a) => a.kind === "object" && a.className === "%Error");
  return hasNull && hasError;
}

/** True iff `t` is a record of exactly the given (name-sorted) string/f64
 * fields — the AddressInfo/RemoteInfo shape check. */
function isRecordOfFields(L: Lowerer, t: IrType, fields: [string, "string" | "f64"][]): boolean {
  if (t.kind !== "record") return false;
  const shape = L.shapes.get(t.shapeId);
  if (!shape || shape.tuple || shape.indexValue || shape.fields.length !== fields.length) return false;
  return shape.fields.every((f, i) => f.name === fields[i]![0] && f.type.kind === fields[i]![1]);
}

const ADDRINFO_FIELDS: [string, "string" | "f64"][] = [
  ["address", "string"], ["family", "string"], ["port", "f64"],
];
const RINFO_FIELDS: [string, "string" | "f64"][] = [
  ["address", "string"], ["family", "string"], ["port", "f64"], ["size", "f64"],
];

/** Module-function calls on dgram/dns import bindings (named imports AND
 * namespace members — both funnel here): createSocket("udp4" | { type,
 * reuseAddr? }), dns.lookup(hostname, { family: 4 }, cb). Null for other
 * modules (the caller falls through); every dgram/dns member lands here —
 * unlowered ones fence with their module-qualified name. */
export function lowerDgramDnsModuleCall(L: Lowerer, expr: ts.CallExpression,
  bi: { module: string; member: string },
  loc: SrcLoc,): IrExpr | null {
  if (bi.module === "dns") return lowerDnsModuleCall(L, expr, bi, loc);
  if (bi.module !== "dgram") return null;
  const args = expr.arguments;
  if (bi.member === "createSocket") {
    if (args.length !== 1) {
      L.noLowering(
        `createSocket with ${args.length} arguments`,
        expr,
        'the supported forms are createSocket("udp4") and createSocket({ type: "udp4", reuseAddr? })',
      );
    }
    const arg = args[0]!;
    // createSocket("udp4") — the bare string form.
    const argT = L.typeOf(arg);
    if (argT.isStringLiteralType()) {
      if (argT.value !== "udp4") {
        L.noLowering(`createSocket("${argT.value}")`, arg, '"udp4" is the supported socket type');
      }
      L.lowerExpr(arg); // side-effect order (a call producing the literal type)
      return {
        kind: "libCall", fn: "dgram.createSocket",
        args: [boolLit(false, loc)], type: DGRAMSOCK_T, loc,
      };
    }
    // createSocket({ type: "udp4", reuseAddr?: <bool> }) — an OBJECT
    // LITERAL with literal keys; type must be the "udp4" literal.
    if (!ts.isObjectLiteralExpression(arg)) {
      L.noLowering(
        "createSocket with a non-literal options argument",
        arg,
        'pass the options as an object literal: createSocket({ type: "udp4" })',
      );
    }
    let sawType = false;
    let reuseAddr: IrExpr | null = null;
    for (const prop of arg.properties) {
      if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) {
        L.noLowering(
          "createSocket options with computed keys, spreads, or shorthand entries",
          prop,
          "each option must be a plain `name: value` entry with a literal key",
        );
      }
      const name = prop.name.text;
      if (name === "type") {
        const t = L.typeOf(prop.initializer);
        if (!t.isStringLiteralType() || t.value !== "udp4") {
          L.noLowering(
            'createSocket with a type other than the "udp4" literal',
            prop.initializer,
            '"udp4" is the supported socket type',
          );
        }
        sawType = true;
      } else if (name === "reuseAddr") {
        reuseAddr = L.lowerExprExpecting(prop.initializer, BOOL);
      } else if (name === "signal" && isJsSourceFile(expr.getSourceFile())) {
        // A provably-non-AbortSignal signal (the invalid-input probes:
        // strings, numbers, plain records) throws Node's
        // validateAbortSignal ladder; plausible signal values keep the
        // fence — abort-driven close has no lowering yet.
        const raw = L.lowerExpr(prop.initializer);
        const provablyNot = raw.type.kind === "string" || raw.type.kind === "f64" ||
          raw.type.kind === "bool" || raw.type.kind === "record" || raw.type.kind === "array";
        if (provablyNot && L.dynConvertible(raw.type)) {
          return {
            kind: "libCall",
            fn: "error.propTypeThrow",
            args: [
              { kind: "strLit", value: "options.signal", type: STRING, loc },
              { kind: "strLit", value: "an instance of AbortSignal", type: STRING, loc },
              { kind: "dynFrom", value: raw, type: DYN, loc },
            ],
            type: DGRAMSOCK_T,
            loc,
          };
        }
        L.noLowering(
          `createSocket option 'signal'`,
          prop,
          "abort-driven close has no lowering yet — type and reuseAddr are the supported options",
        );
      } else {
        L.noLowering(
          `createSocket option '${name}'`,
          prop,
          "type and reuseAddr are the supported options",
        );
      }
    }
    if (!sawType) {
      L.noLowering(
        "createSocket options without a type",
        arg,
        'the supported form is createSocket({ type: "udp4", reuseAddr? })',
      );
    }
    return {
      kind: "libCall", fn: "dgram.createSocket",
      args: [reuseAddr ?? boolLit(false, loc)], type: DGRAMSOCK_T, loc,
    };
  }
  L.noLowering(
    `dgram.${bi.member}`,
    expr,
    "createSocket is the lowered dgram module function",
    ts.isIdentifier(expr.expression) ? L.resolveValueSymbol(expr.expression) : undefined,
  );
}

/** dns.lookup(hostname, { family: 4 }, (err, address[, family]) => ...) —
 * the ONE lowered dns member. getaddrinfo runs at call time; the callback
 * defers to the next loop turn (SEMANTICS.md documents the split). */
function lowerDnsModuleCall(L: Lowerer, expr: ts.CallExpression,
  bi: { module: string; member: string },
  loc: SrcLoc,): IrExpr {
  if (bi.member !== "lookup") {
    L.noLowering(
      `dns.${bi.member}`,
      expr,
      "lookup is the lowered dns module function",
      ts.isIdentifier(expr.expression) ? L.resolveValueSymbol(expr.expression) : undefined,
    );
  }
  requireStatementPosition(L, expr, "dns.lookup(...)");
  const args = expr.arguments;
  if (args.length !== 3) {
    L.noLowering(
      `lookup with ${args.length} arguments`,
      expr,
      "the supported form is lookup(hostname, { family: 4 }, callback)",
    );
  }
  const hostname = L.lowerExprExpecting(args[0]!, STRING);
  // The options: an object literal whose one meaningful entry is the
  // IPv4 pin — `{ family: 4 }`. Node's family-less and family-6 lookups
  // have no lowering (the runtime resolves over getaddrinfo/AF_INET).
  const opts = args[1]!;
  if (!ts.isObjectLiteralExpression(opts)) {
    L.noLowering(
      "lookup with a non-literal options argument",
      opts,
      "pass the options as an object literal: lookup(hostname, { family: 4 }, cb)",
    );
  }
  let family: IrExpr | null = null;
  for (const prop of opts.properties) {
    if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) {
      L.noLowering(
        "lookup options with computed keys, spreads, or shorthand entries",
        prop,
        "each option must be a plain `name: value` entry with a literal key",
      );
    }
    if (prop.name.text !== "family") {
      // The options-record stance: hints/all/order/verbatim are
      // documented dns.lookup knobs with no lowering — they fence by
      // name; undocumented keys drop like Node drops them.
      fenceOrDropOptionKey(
        L, prop, prop.name.text, "lookup", DNS_LOOKUP_DOCUMENTED_OPTIONS,
        "family: 4 is the supported option",
        {
          all: "the all-addresses callback shape has no lowering — the lowered callback is (err, address, family) over one IPv4 answer",
        },
      );
      continue; // an undocumented key, dropped like Node drops it
    }
    const t = L.typeOf(prop.initializer);
    if (!t.isNumberLiteralType() || t.value !== 4) {
      L.noLowering(
        "lookup with a family other than the literal 4",
        prop.initializer,
        "IPv4 lookups ({ family: 4 }) are the supported form",
      );
    }
    family = L.lowerExprExpecting(prop.initializer, F64);
  }
  if (!family) {
    L.noLowering(
      "lookup options without a family",
      opts,
      "the supported form is lookup(hostname, { family: 4 }, cb)",
    );
  }
  const { cb } = lowerCallbackArg(
    L, args[2]!, "lookup callbacks", 3,
    (p, i) =>
      i === 0 ? isErrorOrNullUnion(L, p)
      : i === 1 ? p.kind === "string"
      : p.kind === "f64",
    "use (err, address) — err is Error | null, address a string",
  );
  return { kind: "libCall", fn: "dns.lookup", args: [hostname, family, cb], type: VOID, loc };
}

/** Method calls on dgram.Socket receivers — one entry in lower-calls.ts's
 * intrinsic chain (after lowerServerMethodCall). Null for other
 * receivers. */
export function lowerDgramMethodCall(L: Lowerer, call: ts.CallExpression,
  access: ts.PropertyAccessExpression,): IrExpr | null {
  if (call.questionDotToken || access.questionDotToken) return null;
  if (L.mapTypeOf(L.typeOf(access.expression))?.kind !== "dgramSocket") return null;
  if (!L.isStdlibMember(access)) return null;
  const name = access.name.text;
  const loc = locOf(call);
  const args = call.arguments;
  if (name === "bind" || name === "connect") {
    requireStatementPosition(L, call, `socket.${name}(...)`);
    // bind(port[, address][, cb]) / connect(port[, address][, cb]) — the
    // net.connect optional-middle rule: a 2-arg call's second argument is
    // the address when string-typed, the callback when func-typed.
    if (args.length < 1 || args.length > 3) {
      L.noLowering(
        `${name} with ${args.length} arguments`,
        call,
        `the supported form is ${name}(port[, address][, callback])`,
      );
    }
    const port = L.lowerExprExpecting(args[0]!, F64);
    let hostNode: ts.Expression | undefined;
    let cbNode: ts.Expression | undefined;
    if (args.length === 2) {
      if (L.mapTypeOf(L.typeOf(args[1]!))?.kind === "string") hostNode = args[1];
      else cbNode = args[1];
    } else if (args.length === 3) {
      hostNode = args[1];
      cbNode = args[2];
    }
    // Omitted-address completions: bind's is Node's 0.0.0.0 (the runtime
    // reads "" as any); connect's is 127.0.0.1, Node's udp4 default.
    const host: IrExpr = hostNode
      ? L.lowerExprExpecting(hostNode, STRING)
      : { kind: "strLit", value: name === "bind" ? "" : "127.0.0.1", type: STRING, loc };
    const receiver = L.lowerExpr(access.expression);
    if (!cbNode) {
      const fn: IrLibFn = name === "bind" ? "dgram.bind" : "dgram.connect";
      return { kind: "libCall", fn, args: [receiver, port, host], type: VOID, loc };
    }
    const { cb } = lowerCallbackArg(
      L, cbNode, `${name} callbacks`, 0,
      () => false,
      "use ()",
    );
    const fn: IrLibFn = name === "bind" ? "dgram.bindCb" : "dgram.connectCb";
    return { kind: "libCall", fn, args: [receiver, port, host, cb], type: VOID, loc };
  }
  if (name === "send") {
    requireStatementPosition(L, call, "socket.send(...)");
    // send(msg, port, address) — one datagram to an explicit destination
    // (the static fast path). Every OTHER shape in a JS source rides the
    // checked-dynamic ladder (dgram.sendChk): Node's signature shuffle,
    // slice bounds, list/type contracts, port/address validation, and
    // the connected-state errors — with the compiler-rendered fence as
    // the post-validation tail for the callback/list/connected forms.
    const staticShape =
      args.length === 3 && !args.some(ts.isSpreadElement) &&
      (() => {
        const dataT = L.mapTypeOf(L.typeOf(args[0]!));
        const portT = L.mapTypeOf(L.typeOf(args[1]!));
        const hostT = L.mapTypeOf(L.typeOf(args[2]!));
        return (dataT?.kind === "string" || (dataT?.kind === "bytes" && dataT.elem === "u8")) &&
               portT?.kind === "f64" && hostT?.kind === "string";
      })();
    if (staticShape) {
      const receiver = L.lowerExpr(access.expression);
      const data = L.lowerExpr(args[0]!);
      const port = L.lowerExprExpecting(args[1]!, F64);
      const host = L.lowerExprExpecting(args[2]!, STRING);
      const fn: IrLibFn = data.type.kind === "string" ? "dgram.sendStr" : "dgram.sendBytes";
      return { kind: "libCall", fn, args: [receiver, data, port, host], type: VOID, loc };
    }
    if (isJsSourceFile(call.getSourceFile()) && args.length <= 5 && !args.some(ts.isSpreadElement)) {
      const receiver = L.lowerExpr(access.expression);
      const slots: IrExpr[] = [];
      let ok = true;
      for (let i = 0; i < 5; i++) {
        const n = args[i];
        if (!n) {
          slots.push({
            kind: "dynFrom",
            value: { kind: "unitLit", unit: "undefined", type: UNDEFINED_T, loc },
            type: DYN,
            loc,
          });
          continue;
        }
        const raw = L.lowerExpr(n);
        if (raw.type.kind === "dyn") slots.push(raw);
        else if (raw.kind === "unitLit" || L.dynConvertible(raw.type) ||
                 (raw.type.kind === "func" &&
                  canBoxFuncIntoDyn(raw.type, (id) => L.shapes.get(id), (id) => L.unions.get(id)))) {
          slots.push({ kind: "dynFrom", value: raw, type: DYN, loc });
        } else {
          ok = false;
          break;
        }
      }
      if (ok) {
        return {
          kind: "libCall",
          fn: "dgram.sendChk",
          args: [receiver, ...slots, ladderFenceExpr(L, `send in this form`, call,
            "send(msg, port, address) — one string or Buffer datagram — is the lowered form; callback, list, and connected sends have no lowering yet")],
          type: VOID,
          loc,
        };
      }
    }
    L.noLowering(
      `send with ${args.length} arguments`,
      call,
      "the supported form is send(msg, port, address) — one string or Buffer datagram",
    );
  }
  if (name === "address") {
    if (args.length !== 0) {
      L.noLowering(`address with ${args.length} arguments`, call, "address() takes no arguments");
    }
    // The declared AddressInfo return must map to the {address, family,
    // port} record — the runtime fills exactly those three fields.
    const result = L.mapTypeOf(L.typeOf(call));
    if (!result || !isRecordOfFields(L, result, ADDRINFO_FIELDS)) {
      L.noLowering(
        "address() where the result is not the {address, family, port} record",
        call,
        "the AddressInfo shape is the supported result",
      );
    }
    const receiver = L.lowerExpr(access.expression);
    return { kind: "libCall", fn: "dgram.address", args: [receiver], type: result, loc };
  }
  if (name === "close") {
    requireStatementPosition(L, call, "socket.close(...)");
    if (args.length > 1) {
      L.noLowering(`close with ${args.length} arguments`, call, "the supported form is close([callback])");
    }
    const receiver = L.lowerExpr(access.expression);
    if (args.length === 0) {
      return { kind: "libCall", fn: "dgram.close", args: [receiver], type: VOID, loc };
    }
    const { cb } = lowerCallbackArg(L, args[0]!, "close callbacks", 0, () => false, "use ()");
    return { kind: "libCall", fn: "dgram.closeCb", args: [receiver, cb], type: VOID, loc };
  }
  if (name === "unref" || name === "ref") {
    requireStatementPosition(L, call, `socket.${name}()`);
    if (args.length !== 0) {
      L.noLowering(`${name} with ${args.length} arguments`, call, `${name}() takes no arguments`);
    }
    const receiver = L.lowerExpr(access.expression);
    const fn: IrLibFn = name === "unref" ? "dgram.unref" : "dgram.ref";
    return { kind: "libCall", fn, args: [receiver], type: VOID, loc };
  }
  if ((name === "on" || name === "once") && args.length === 2) {
    requireStatementPosition(L, call, `socket.${name}(...)`);
    const once = boolLit(name === "once", loc);
    const evT = L.typeOf(args[0]!);
    const event = evT.isStringLiteralType() ? evT.value : null;
    const receiver = L.lowerExpr(access.expression);
    if (event === "message") {
      const { cb } = lowerCallbackArg(
        L, args[1]!, "message listeners", 2,
        (p, i) =>
          i === 0 ? p.kind === "bytes" && p.elem === "u8"
          : isRecordOfFields(L, p, RINFO_FIELDS),
        "use (msg: Buffer, rinfo) or (msg: Buffer) or ()",
      );
      return { kind: "libCall", fn: "dgram.onMessage", args: [receiver, cb, once], type: VOID, loc };
    }
    if (event === "error") {
      const { cb } = lowerCallbackArg(
        L, args[1]!, "error listeners", 1,
        (p) => p.kind === "object" && p.className === "%Error",
        "use (err) or ()",
      );
      return { kind: "libCall", fn: "dgram.onError", args: [receiver, cb, once], type: VOID, loc };
    }
    if (event === "listening" || event === "close" || event === "connect") {
      const { cb } = lowerCallbackArg(L, args[1]!, `${event} listeners`, 0, () => false, "use ()");
      const fn: IrLibFn =
        event === "listening" ? "dgram.onListening"
        : event === "close" ? "dgram.onClose"
        : "dgram.onConnect";
      return { kind: "libCall", fn, args: [receiver, cb, once], type: VOID, loc };
    }
    L.noLowering(
      `socket.${name}(${event === null ? "non-literal event" : `"${event}"`}, ...)`,
      args[0]!,
      '"message", "listening", "close", "connect", and "error" are the supported socket events (as literals)',
    );
  }
  if (name.startsWith("setMulticast") || name === "addMembership" || name === "dropMembership" ||
      name === "setBroadcast" || name === "setTTL") {
    L.noLowering(
      `dgram.Socket.${name}`,
      call,
      `multicast/TTL options have no lowering (${DGRAM_SURFACE_HINT})`,
      L.checker.getSymbolAtLocation(access.name),
    );
  }
  L.noLowering(
    `dgram.Socket.${name}`,
    call,
    DGRAM_SURFACE_HINT,
    L.checker.getSymbolAtLocation(access.name),
  );
}
