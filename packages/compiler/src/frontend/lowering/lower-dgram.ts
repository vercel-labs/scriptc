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
import { BOOL, canBoxFuncIntoDyn, DGRAMSOCK_T, DYN, F64, IrExpr, IrLibFn, IrType, SrcLoc, STRING, UNDEFINED_T, VOID } from "../../ir/ir.js";
import { DNS_LOOKUP_DOCUMENTED_OPTIONS, fenceOrDropOptionKey } from "./surfaces.js";
import { boolLit } from "../../ir/build.js";
import { resultIsDiscarded } from "./call-position.js";
import { lowerCallbackArg as lowerCallbackArgShared } from "./callback-arg.js";

const DGRAM_SURFACE_HINT =
  "bind, connect, send, address, close, unref/ref, and on/once of " +
  "message/listening/close/connect/error are the supported dgram.Socket members";

/** Dgram's callback policy: validate every positional parameter and require
 * callbacks to return void; raw dyn values adapt only to zero-arg slots. */
function lowerCallbackArg(
  lowerer: Lowerer,
  node: ts.Expression,
  what: string,
  maxParams: number,
  paramOk: (param: IrType, index: number) => boolean,
  paramHint: string,
): { cb: IrExpr; nparams: number } {
  return lowerCallbackArgShared(lowerer, node, what, maxParams, paramOk, paramHint, {
    dynZero: true,
    checkAllParams: true,
    rejectValueReturn: true,
  });
}

/** VOID-result socket calls are usable as statements and as concise arrow
 * bodies; anything consuming the result (Node returns `this` where this
 * surface returns void) is fenced — the lower-server stance. */
function requireStatementPosition(lowerer: Lowerer, call: ts.CallExpression, what: string): void {
  if (resultIsDiscarded(call)) return;
  lowerer.unsupported(
    "SC1090",
    call,
    `using the result of ${what} (the result is void here — call it as its own statement)`,
  );
}

/** Lowers a listener/callback argument, pinning the closure shape: void
 * return, at most `maxParams` parameters, each parameter's IR kind
 * satisfying `paramOk` (indexed). The lower-server helper's shape,
 * re-stated here so the spoke stays self-contained. */
/** True iff `t` is the `Error | null` union — dns.lookup's first callback
 * parameter (NodeJS.ErrnoException maps to %Error in type-mapper.ts). */
function isErrorOrNullUnion(lowerer: Lowerer, t: IrType): boolean {
  if (t.kind !== "union") return false;
  const def = lowerer.unions.get(t.unionId);
  if (!def || def.arms.length !== 2) return false;
  const hasNull = def.arms.some((a) => a.kind === "nullT");
  const hasError = def.arms.some((a) => a.kind === "object" && a.className === "%Error");
  return hasNull && hasError;
}

/** True iff `t` is a record of exactly the given (name-sorted) string/f64
 * fields — the AddressInfo/RemoteInfo shape check. */
function isRecordOfFields(lowerer: Lowerer, t: IrType, fields: [string, "string" | "f64"][]): boolean {
  if (t.kind !== "record") return false;
  const shape = lowerer.shapes.get(t.shapeId);
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
export function lowerDgramDnsModuleCall(lowerer: Lowerer, expr: ts.CallExpression,
  bi: { module: string; member: string },
  loc: SrcLoc,): IrExpr | null {
  if (bi.module === "dns") return lowerDnsModuleCall(lowerer, expr, bi, loc);
  if (bi.module !== "dgram") return null;
  const args = expr.arguments;
  if (bi.member === "createSocket") {
    if (args.length !== 1) {
      lowerer.noLowering(
        `createSocket with ${args.length} arguments`,
        expr,
        'the supported forms are createSocket("udp4") and createSocket({ type: "udp4", reuseAddr? })',
      );
    }
    const arg = args[0]!;
    // createSocket("udp4") — the bare string form.
    const argT = lowerer.typeOf(arg);
    if (argT.isStringLiteralType()) {
      if (argT.value !== "udp4") {
        lowerer.noLowering(`createSocket("${argT.value}")`, arg, '"udp4" is the supported socket type');
      }
      lowerer.lowerExpr(arg); // side-effect order (a call producing the literal type)
      return {
        kind: "libCall", fn: "dgram.createSocket",
        args: [boolLit(false, loc)], type: DGRAMSOCK_T, loc,
      };
    }
    // createSocket({ type: "udp4", reuseAddr?: <bool> }) — an OBJECT
    // LITERAL with literal keys; type must be the "udp4" literal.
    if (!ts.isObjectLiteralExpression(arg)) {
      lowerer.noLowering(
        "createSocket with a non-literal options argument",
        arg,
        'pass the options as an object literal: createSocket({ type: "udp4" })',
      );
    }
    let sawType = false;
    let reuseAddr: IrExpr | null = null;
    for (const prop of arg.properties) {
      if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) {
        lowerer.noLowering(
          "createSocket options with computed keys, spreads, or shorthand entries",
          prop,
          "each option must be a plain `name: value` entry with a literal key",
        );
      }
      const name = prop.name.text;
      if (name === "type") {
        const t = lowerer.typeOf(prop.initializer);
        if (!t.isStringLiteralType() || t.value !== "udp4") {
          lowerer.noLowering(
            'createSocket with a type other than the "udp4" literal',
            prop.initializer,
            '"udp4" is the supported socket type',
          );
        }
        sawType = true;
      } else if (name === "reuseAddr") {
        reuseAddr = lowerer.lowerExprExpecting(prop.initializer, BOOL);
      } else if (name === "signal" && isJsSourceFile(expr.getSourceFile())) {
        // A provably-non-AbortSignal signal (the invalid-input probes:
        // strings, numbers, plain records) throws Node's
        // validateAbortSignal ladder; plausible signal values keep the
        // fence — abort-driven close has no lowering yet.
        const raw = lowerer.lowerExpr(prop.initializer);
        const provablyNot = raw.type.kind === "string" || raw.type.kind === "f64" ||
          raw.type.kind === "bool" || raw.type.kind === "record" || raw.type.kind === "array";
        if (provablyNot && lowerer.dynConvertible(raw.type)) {
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
        lowerer.noLowering(
          `createSocket option 'signal'`,
          prop,
          "abort-driven close has no lowering yet — type and reuseAddr are the supported options",
        );
      } else {
        lowerer.noLowering(
          `createSocket option '${name}'`,
          prop,
          "type and reuseAddr are the supported options",
        );
      }
    }
    if (!sawType) {
      lowerer.noLowering(
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
  lowerer.noLowering(
    `dgram.${bi.member}`,
    expr,
    "createSocket is the lowered dgram module function",
    ts.isIdentifier(expr.expression) ? lowerer.resolveValueSymbol(expr.expression) : undefined,
  );
}

/** dns.lookup(hostname, { family: 4 }, (err, address[, family]) => ...) —
 * the ONE lowered dns member. getaddrinfo runs at call time; the callback
 * defers to the next loop turn (SEMANTICS.md documents the split). */
function lowerDnsModuleCall(lowerer: Lowerer, expr: ts.CallExpression,
  bi: { module: string; member: string },
  loc: SrcLoc,): IrExpr {
  if (bi.member !== "lookup") {
    lowerer.noLowering(
      `dns.${bi.member}`,
      expr,
      "lookup is the lowered dns module function",
      ts.isIdentifier(expr.expression) ? lowerer.resolveValueSymbol(expr.expression) : undefined,
    );
  }
  requireStatementPosition(lowerer, expr, "dns.lookup(...)");
  const args = expr.arguments;
  if (args.length !== 3) {
    lowerer.noLowering(
      `lookup with ${args.length} arguments`,
      expr,
      "the supported form is lookup(hostname, { family: 4 }, callback)",
    );
  }
  const hostname = lowerer.lowerExprExpecting(args[0]!, STRING);
  // The options: an object literal whose one meaningful entry is the
  // IPv4 pin — `{ family: 4 }`. Node's family-less and family-6 lookups
  // have no lowering (the runtime resolves over getaddrinfo/AF_INET).
  const opts = args[1]!;
  if (!ts.isObjectLiteralExpression(opts)) {
    lowerer.noLowering(
      "lookup with a non-literal options argument",
      opts,
      "pass the options as an object literal: lookup(hostname, { family: 4 }, cb)",
    );
  }
  let family: IrExpr | null = null;
  for (const prop of opts.properties) {
    if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) {
      lowerer.noLowering(
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
        lowerer, prop, prop.name.text, "lookup", DNS_LOOKUP_DOCUMENTED_OPTIONS,
        "family: 4 is the supported option",
        {
          all: "the all-addresses callback shape has no lowering — the lowered callback is (err, address, family) over one IPv4 answer",
        },
      );
      continue; // an undocumented key, dropped like Node drops it
    }
    const t = lowerer.typeOf(prop.initializer);
    if (!t.isNumberLiteralType() || t.value !== 4) {
      lowerer.noLowering(
        "lookup with a family other than the literal 4",
        prop.initializer,
        "IPv4 lookups ({ family: 4 }) are the supported form",
      );
    }
    family = lowerer.lowerExprExpecting(prop.initializer, F64);
  }
  if (!family) {
    lowerer.noLowering(
      "lookup options without a family",
      opts,
      "the supported form is lookup(hostname, { family: 4 }, cb)",
    );
  }
  const { cb } = lowerCallbackArg(
    lowerer, args[2]!, "lookup callbacks", 3,
    (p, i) =>
      i === 0 ? isErrorOrNullUnion(lowerer, p)
      : i === 1 ? p.kind === "string"
      : p.kind === "f64",
    "use (err, address) — err is Error | null, address a string",
  );
  return { kind: "libCall", fn: "dns.lookup", args: [hostname, family, cb], type: VOID, loc };
}

/** Method calls on dgram.Socket receivers — one entry in lower-calls.ts's
 * intrinsic chain (after lowerServerMethodCall). Null for other
 * receivers. */
export function lowerDgramMethodCall(lowerer: Lowerer, call: ts.CallExpression,
  access: ts.PropertyAccessExpression,): IrExpr | null {
  if (call.questionDotToken || access.questionDotToken) return null;
  if (lowerer.mapTypeOf(lowerer.typeOf(access.expression))?.kind !== "dgramSocket") return null;
  if (!lowerer.isStdlibMember(access)) return null;
  const name = access.name.text;
  const loc = locOf(call);
  const args = call.arguments;
  if (name === "bind" || name === "connect") {
    requireStatementPosition(lowerer, call, `socket.${name}(...)`);
    // bind(port[, address][, cb]) / connect(port[, address][, cb]) — the
    // net.connect optional-middle rule: a 2-arg call's second argument is
    // the address when string-typed, the callback when func-typed.
    if (args.length < 1 || args.length > 3) {
      lowerer.noLowering(
        `${name} with ${args.length} arguments`,
        call,
        `the supported form is ${name}(port[, address][, callback])`,
      );
    }
    const port = lowerer.lowerExprExpecting(args[0]!, F64);
    let hostNode: ts.Expression | undefined;
    let cbNode: ts.Expression | undefined;
    if (args.length === 2) {
      if (lowerer.mapTypeOf(lowerer.typeOf(args[1]!))?.kind === "string") hostNode = args[1];
      else cbNode = args[1];
    } else if (args.length === 3) {
      hostNode = args[1];
      cbNode = args[2];
    }
    // Omitted-address completions: bind's is Node's 0.0.0.0 (the runtime
    // reads "" as any); connect's is 127.0.0.1, Node's udp4 default.
    const host: IrExpr = hostNode
      ? lowerer.lowerExprExpecting(hostNode, STRING)
      : { kind: "strLit", value: name === "bind" ? "" : "127.0.0.1", type: STRING, loc };
    const receiver = lowerer.lowerExpr(access.expression);
    if (!cbNode) {
      const fn: IrLibFn = name === "bind" ? "dgram.bind" : "dgram.connect";
      return { kind: "libCall", fn, args: [receiver, port, host], type: VOID, loc };
    }
    const { cb } = lowerCallbackArg(
      lowerer, cbNode, `${name} callbacks`, 0,
      () => false,
      "use ()",
    );
    const fn: IrLibFn = name === "bind" ? "dgram.bindCb" : "dgram.connectCb";
    return { kind: "libCall", fn, args: [receiver, port, host, cb], type: VOID, loc };
  }
  if (name === "send") {
    requireStatementPosition(lowerer, call, "socket.send(...)");
    // send(msg, port, address) — one datagram to an explicit destination
    // (the static fast path). Every OTHER shape in a JS source rides the
    // checked-dynamic ladder (dgram.sendChk): Node's signature shuffle,
    // slice bounds, list/type contracts, port/address validation, and
    // the connected-state errors — with the compiler-rendered fence as
    // the post-validation tail for the callback/list/connected forms.
    const staticShape =
      args.length === 3 && !args.some(ts.isSpreadElement) &&
      (() => {
        const dataT = lowerer.mapTypeOf(lowerer.typeOf(args[0]!));
        const portT = lowerer.mapTypeOf(lowerer.typeOf(args[1]!));
        const hostT = lowerer.mapTypeOf(lowerer.typeOf(args[2]!));
        return (dataT?.kind === "string" || (dataT?.kind === "bytes" && dataT.elem === "u8")) &&
               portT?.kind === "f64" && hostT?.kind === "string";
      })();
    if (staticShape) {
      const receiver = lowerer.lowerExpr(access.expression);
      const data = lowerer.lowerExpr(args[0]!);
      const port = lowerer.lowerExprExpecting(args[1]!, F64);
      const host = lowerer.lowerExprExpecting(args[2]!, STRING);
      const fn: IrLibFn = data.type.kind === "string" ? "dgram.sendStr" : "dgram.sendBytes";
      return { kind: "libCall", fn, args: [receiver, data, port, host], type: VOID, loc };
    }
    if (isJsSourceFile(call.getSourceFile()) && args.length <= 5 && !args.some(ts.isSpreadElement)) {
      const receiver = lowerer.lowerExpr(access.expression);
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
        const raw = lowerer.lowerExpr(n);
        if (raw.type.kind === "dyn") slots.push(raw);
        else if (raw.kind === "unitLit" || lowerer.dynConvertible(raw.type) ||
                 (raw.type.kind === "func" &&
                  canBoxFuncIntoDyn(raw.type, (id) => lowerer.shapes.get(id), (id) => lowerer.unions.get(id)))) {
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
          args: [receiver, ...slots, ladderFenceExpr(lowerer, `send in this form`, call,
            "send(msg, port, address) — one string or Buffer datagram — is the lowered form; callback, list, and connected sends have no lowering yet")],
          type: VOID,
          loc,
        };
      }
    }
    lowerer.noLowering(
      `send with ${args.length} arguments`,
      call,
      "the supported form is send(msg, port, address) — one string or Buffer datagram",
    );
  }
  if (name === "address") {
    if (args.length !== 0) {
      lowerer.noLowering(`address with ${args.length} arguments`, call, "address() takes no arguments");
    }
    // The declared AddressInfo return must map to the {address, family,
    // port} record — the runtime fills exactly those three fields.
    const result = lowerer.mapTypeOf(lowerer.typeOf(call));
    if (!result || !isRecordOfFields(lowerer, result, ADDRINFO_FIELDS)) {
      lowerer.noLowering(
        "address() where the result is not the {address, family, port} record",
        call,
        "the AddressInfo shape is the supported result",
      );
    }
    const receiver = lowerer.lowerExpr(access.expression);
    return { kind: "libCall", fn: "dgram.address", args: [receiver], type: result, loc };
  }
  if (name === "close") {
    requireStatementPosition(lowerer, call, "socket.close(...)");
    if (args.length > 1) {
      lowerer.noLowering(`close with ${args.length} arguments`, call, "the supported form is close([callback])");
    }
    const receiver = lowerer.lowerExpr(access.expression);
    if (args.length === 0) {
      return { kind: "libCall", fn: "dgram.close", args: [receiver], type: VOID, loc };
    }
    const { cb } = lowerCallbackArg(lowerer, args[0]!, "close callbacks", 0, () => false, "use ()");
    return { kind: "libCall", fn: "dgram.closeCb", args: [receiver, cb], type: VOID, loc };
  }
  if (name === "unref" || name === "ref") {
    requireStatementPosition(lowerer, call, `socket.${name}()`);
    if (args.length !== 0) {
      lowerer.noLowering(`${name} with ${args.length} arguments`, call, `${name}() takes no arguments`);
    }
    const receiver = lowerer.lowerExpr(access.expression);
    const fn: IrLibFn = name === "unref" ? "dgram.unref" : "dgram.ref";
    return { kind: "libCall", fn, args: [receiver], type: VOID, loc };
  }
  if ((name === "on" || name === "once") && args.length === 2) {
    requireStatementPosition(lowerer, call, `socket.${name}(...)`);
    const once = boolLit(name === "once", loc);
    const evT = lowerer.typeOf(args[0]!);
    const event = evT.isStringLiteralType() ? evT.value : null;
    const receiver = lowerer.lowerExpr(access.expression);
    if (event === "message") {
      const { cb } = lowerCallbackArg(
        lowerer, args[1]!, "message listeners", 2,
        (p, i) =>
          i === 0 ? p.kind === "bytes" && p.elem === "u8"
          : isRecordOfFields(lowerer, p, RINFO_FIELDS),
        "use (msg: Buffer, rinfo) or (msg: Buffer) or ()",
      );
      return { kind: "libCall", fn: "dgram.onMessage", args: [receiver, cb, once], type: VOID, loc };
    }
    if (event === "error") {
      const { cb } = lowerCallbackArg(
        lowerer, args[1]!, "error listeners", 1,
        (p) => p.kind === "object" && p.className === "%Error",
        "use (err) or ()",
      );
      return { kind: "libCall", fn: "dgram.onError", args: [receiver, cb, once], type: VOID, loc };
    }
    if (event === "listening" || event === "close" || event === "connect") {
      const { cb } = lowerCallbackArg(lowerer, args[1]!, `${event} listeners`, 0, () => false, "use ()");
      const fn: IrLibFn =
        event === "listening" ? "dgram.onListening"
        : event === "close" ? "dgram.onClose"
        : "dgram.onConnect";
      return { kind: "libCall", fn, args: [receiver, cb, once], type: VOID, loc };
    }
    lowerer.noLowering(
      `socket.${name}(${event === null ? "non-literal event" : `"${event}"`}, ...)`,
      args[0]!,
      '"message", "listening", "close", "connect", and "error" are the supported socket events (as literals)',
    );
  }
  if (name.startsWith("setMulticast") || name === "addMembership" || name === "dropMembership" ||
      name === "setBroadcast" || name === "setTTL") {
    lowerer.noLowering(
      `dgram.Socket.${name}`,
      call,
      `multicast/TTL options have no lowering (${DGRAM_SURFACE_HINT})`,
      lowerer.checker.getSymbolAtLocation(access.name),
    );
  }
  lowerer.noLowering(
    `dgram.Socket.${name}`,
    call,
    DGRAM_SURFACE_HINT,
    lowerer.checker.getSymbolAtLocation(access.name),
  );
}
