/* The midi-surface lowering (node:midi — a spoke module like lower-dgram.ts,
 * on which it is modeled part for part): the port-handle CONSTRUCTORS
 * (`new Input()` / `new Output()`, the node-midi/@julusian shape) and the
 * method surface on midiInput/midiOutput receivers (getPortCount/
 * getPortName/openPort/openVirtualPort/closePort/isPortOpen, ignoreTypes on
 * inputs, sendMessage on outputs, and the on/once "message" listener).
 * Construction is via `new` — the classes are the module's only exports, so
 * there is NO module-function surface (unlike dgram's createSocket); a CALL
 * on a midi import binding fences module-qualified. Everything the lib
 * declares beyond these shapes fences member-qualified — never a generic
 * rejection, never silence. */
import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";
import { locOf } from "../program.js";
import { BOOL, F64, funcOf, IrExpr, IrLibFn, IrType, MIDIIN_T, MIDIOUT_T, SrcLoc, STRING, VOID } from "../../ir/nodes.js";

const MIDI_SURFACE_HINT =
  "getPortCount, getPortName, openPort, openVirtualPort, closePort, " +
  "isPortOpen, ignoreTypes (Input), sendMessage (Output), and on/once of " +
  '"message" are the supported midi Input/Output members';

/** The midi lib-fn ids the runtime implements (scr_midi.c). These are NOT
 * in the frozen IrLibFn union yet — the emitter cases land with the runtime
 * TU (Phase 3/4); moduleUsesMidi already detects them by the "midi."
 * prefix (its `typeof node.fn === "string"` guard is written for exactly
 * this). The spoke casts through this alias so the lowering emits the frozen
 * §4 ABI ids without touching the shared IR/emission front-matter. */
type MidiLibFn =
  | "midi.newInput"
  | "midi.newOutput"
  | "midi.portCount"
  | "midi.portName"
  | "midi.openPort"
  | "midi.openVirtual"
  | "midi.closePort"
  | "midi.isOpen"
  | "midi.ignoreTypes"
  /** sendMessage's two marshalers, picked by argument type — the dgram
   * sendStr/sendBytes split retargeted: a number[] literal/array rides
   * sendArray (scr_midi_send_array over ScrArr*), a Uint8Array rides
   * sendBytes (scr_midi_send_bytes over ScrBytes*). */
  | "midi.sendArray"
  | "midi.sendBytes"
  /** on/once("message", (deltaTime, message) => …) — the trailing bool is
   * once; the emitter picks the msg_thunk0/1/2 adapter by the listener's
   * declared parameter count (the dgram.onMessage story exactly). */
  | "midi.onMessage";
const midiFn = (fn: MidiLibFn): IrLibFn => fn as unknown as IrLibFn;

/** The module's lowered value members — the surfaces.ts twin. EMPTY: the
 * two exports are classes reached through `new` (lowerMidiNew), so there is
 * no module-function to table. The set exists to mirror the dgram spoke and
 * to name the "recognized module, unlowered member" fence. */
export const MIDI_MODULE_FNS: ReadonlySet<string> = new Set();

/** VOID-result port calls are usable as statements and as concise arrow
 * bodies; anything consuming the result (Node returns void here too, but
 * the fence keeps parity with the dgram stance) is fenced — the lower-dgram
 * rule verbatim. */
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
 * satisfying `paramOk` (indexed). The lower-dgram helper's shape, re-stated
 * here so the spoke stays self-contained. */
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
  // boundary, the lower-dgram listen-callback precedent.
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

/** `new Input()` / `new Output()` — the port-handle constructors, one entry
 * in lowerer.ts's lowerNew chain (the AbortController/Response precedent).
 * The mapped instance type IS the discriminator: types.ts pins Input/Output
 * declared inside `declare module "midi"` to midiInput/midiOutput (a user's
 * local `class Input {}` never maps there), so the type answer both selects
 * the constructor AND proves stdlib provenance. Null for any other `new`.
 * Both ctors take no arguments (node-midi's `new midi.Input()`); an argument
 * fences. */
export function lowerMidiNew(L: Lowerer, expr: ts.NewExpression): IrExpr | null {
  const kind = L.mapTypeOf(L.typeOf(expr))?.kind;
  if (kind !== "midiInput" && kind !== "midiOutput") return null;
  const isInput = kind === "midiInput";
  const cls = isInput ? "Input" : "Output";
  const args = expr.arguments ?? [];
  const loc = locOf(expr);
  if (args.length !== 0) {
    L.noLowering(
      `new ${cls} with ${args.length} argument${args.length === 1 ? "" : "s"}`,
      expr,
      `the supported form is new ${cls}() — the port constructors take no arguments`,
    );
  }
  return {
    kind: "libCall",
    fn: midiFn(isInput ? "midi.newInput" : "midi.newOutput"),
    args: [],
    type: isInput ? MIDIIN_T : MIDIOUT_T,
    loc,
  };
}

/** Module-function calls on midi import bindings (named imports AND
 * namespace members). node:midi has NO callable exports — Input/Output are
 * classes reached through `new` — so every call fences module-qualified.
 * Null for other modules (the caller falls through). */
export function lowerMidiModuleCall(L: Lowerer, expr: ts.CallExpression,
  bi: { module: string; member: string },
  loc: SrcLoc,): IrExpr | null {
  void loc;
  if (bi.module !== "midi") return null;
  L.noLowering(
    `midi.${bi.member}`,
    expr,
    "node:midi has no callable exports — construct ports with new Input() / new Output()",
    ts.isIdentifier(expr.expression) ? L.resolveValueSymbol(expr.expression) : undefined,
  );
}

/** Method calls on midi.Input / midi.Output receivers — one entry in
 * lower-calls.ts's intrinsic chain (after lowerDgramMethodCall). Null for
 * other receivers. */
export function lowerMidiMethodCall(L: Lowerer, call: ts.CallExpression,
  access: ts.PropertyAccessExpression,): IrExpr | null {
  if (call.questionDotToken || access.questionDotToken) return null;
  const recvKind = L.mapTypeOf(L.typeOf(access.expression))?.kind;
  if (recvKind !== "midiInput" && recvKind !== "midiOutput") return null;
  if (!L.isStdlibMember(access)) return null;
  const isInput = recvKind === "midiInput";
  const name = access.name.text;
  const loc = locOf(call);
  const args = call.arguments;
  // getPortCount() — enumeration works on a fresh handle before openPort
  // (node-midi's enumerate-then-open, the ambient decl's promise). The
  // frozen ABI passes the input/output discriminator so the shared C
  // symbol reads the right stack. Value-returning: no statement fence.
  if (name === "getPortCount") {
    if (args.length !== 0) {
      L.noLowering(`getPortCount with ${args.length} arguments`, call, "getPortCount() takes no arguments");
    }
    const receiver = L.lowerExpr(access.expression);
    return { kind: "libCall", fn: midiFn("midi.portCount"), args: [receiver, boolLit(isInput, loc)], type: F64, loc };
  }
  if (name === "getPortName") {
    if (args.length !== 1) {
      L.noLowering(`getPortName with ${args.length} arguments`, call, "the supported form is getPortName(port)");
    }
    const receiver = L.lowerExpr(access.expression);
    const port = L.lowerExprExpecting(args[0]!, F64);
    return { kind: "libCall", fn: midiFn("midi.portName"), args: [receiver, port], type: STRING, loc };
  }
  if (name === "openPort") {
    requireStatementPosition(L, call, "port.openPort(...)");
    if (args.length !== 1) {
      L.noLowering(`openPort with ${args.length} arguments`, call, "the supported form is openPort(port)");
    }
    const receiver = L.lowerExpr(access.expression);
    const port = L.lowerExprExpecting(args[0]!, F64);
    return { kind: "libCall", fn: midiFn("midi.openPort"), args: [receiver, port], type: VOID, loc };
  }
  if (name === "openVirtualPort") {
    requireStatementPosition(L, call, "port.openVirtualPort(...)");
    if (args.length !== 1) {
      L.noLowering(`openVirtualPort with ${args.length} arguments`, call, "the supported form is openVirtualPort(name)");
    }
    const receiver = L.lowerExpr(access.expression);
    const nm = L.lowerExprExpecting(args[0]!, STRING);
    return { kind: "libCall", fn: midiFn("midi.openVirtual"), args: [receiver, nm], type: VOID, loc };
  }
  if (name === "closePort") {
    requireStatementPosition(L, call, "port.closePort(...)");
    if (args.length !== 0) {
      L.noLowering(`closePort with ${args.length} arguments`, call, "closePort() takes no arguments");
    }
    const receiver = L.lowerExpr(access.expression);
    return { kind: "libCall", fn: midiFn("midi.closePort"), args: [receiver], type: VOID, loc };
  }
  if (name === "isPortOpen") {
    if (args.length !== 0) {
      L.noLowering(`isPortOpen with ${args.length} arguments`, call, "isPortOpen() takes no arguments");
    }
    const receiver = L.lowerExpr(access.expression);
    return { kind: "libCall", fn: midiFn("midi.isOpen"), args: [receiver], type: BOOL, loc };
  }
  if (name === "ignoreTypes") {
    // Input-only (the ambient decl only puts it on Input); the type guard
    // would already have refused an Output receiver at the checker, but the
    // fence keeps the honest hint if the fallback surface ever widens.
    if (!isInput) {
      L.noLowering(
        "midi.Output.ignoreTypes",
        call,
        `ignoreTypes is an Input member (${MIDI_SURFACE_HINT})`,
        L.checker.getSymbolAtLocation(access.name),
      );
    }
    requireStatementPosition(L, call, "input.ignoreTypes(...)");
    if (args.length !== 3) {
      L.noLowering(
        `ignoreTypes with ${args.length} arguments`,
        call,
        "the supported form is ignoreTypes(sysex, timing, activeSensing) — three booleans",
      );
    }
    const receiver = L.lowerExpr(access.expression);
    const sysex = L.lowerExprExpecting(args[0]!, BOOL);
    const timing = L.lowerExprExpecting(args[1]!, BOOL);
    const sense = L.lowerExprExpecting(args[2]!, BOOL);
    return { kind: "libCall", fn: midiFn("midi.ignoreTypes"), args: [receiver, sysex, timing, sense], type: VOID, loc };
  }
  if (name === "sendMessage") {
    // Output-only. The runtime is byte-transparent: a number[] literal/
    // array marshals through sendArray (ScrArr*), a Uint8Array through
    // sendBytes (ScrBytes*) — the dgram sendStr/sendBytes split, one
    // marshaler per static argument type.
    if (isInput) {
      L.noLowering(
        "midi.Input.sendMessage",
        call,
        `sendMessage is an Output member (${MIDI_SURFACE_HINT})`,
        L.checker.getSymbolAtLocation(access.name),
      );
    }
    requireStatementPosition(L, call, "output.sendMessage(...)");
    if (args.length !== 1) {
      L.noLowering(
        `sendMessage with ${args.length} arguments`,
        call,
        "the supported form is sendMessage(message) — one number[] or Uint8Array",
      );
    }
    if (ts.isSpreadElement(args[0]!)) {
      L.noLowering(
        "sendMessage with a spread argument",
        args[0]!,
        "pass the message as a single number[] or Uint8Array value",
      );
    }
    const receiver = L.lowerExpr(access.expression);
    const data = L.lowerExpr(args[0]!);
    const dt = data.type;
    if (dt.kind === "array" && dt.elem.kind === "f64") {
      return { kind: "libCall", fn: midiFn("midi.sendArray"), args: [receiver, data], type: VOID, loc };
    }
    if (dt.kind === "bytes" && dt.elem === "u8") {
      return { kind: "libCall", fn: midiFn("midi.sendBytes"), args: [receiver, data], type: VOID, loc };
    }
    L.noLowering(
      "sendMessage with a message that is not a number[] or Uint8Array",
      args[0]!,
      "the supported message shapes are a number[] (array literal) and a Uint8Array",
    );
  }
  if ((name === "on" || name === "once") && args.length === 2) {
    // The "message" listener — input-only (Output declares no events). The
    // (deltaTime: number, message: number[]) node-midi shape; the trailing
    // bool is once, and the emitter picks msg_thunk0/1/2 by the listener's
    // declared parameter count (the dgram.onMessage discipline).
    if (!isInput) {
      L.noLowering(
        `midi.Output.${name}`,
        call,
        `on/once are Input members (${MIDI_SURFACE_HINT})`,
        L.checker.getSymbolAtLocation(access.name),
      );
    }
    requireStatementPosition(L, call, `input.${name}(...)`);
    const once = boolLit(name === "once", loc);
    const evT = L.typeOf(args[0]!);
    const event = evT.isStringLiteralType() ? evT.value : null;
    const receiver = L.lowerExpr(access.expression);
    if (event === "message") {
      const { cb } = lowerCallbackArg(
        L, args[1]!, "message listeners", 2,
        (p, i) =>
          i === 0 ? p.kind === "f64"
          : p.kind === "array" && p.elem.kind === "f64",
        "use (deltaTime: number, message: number[]) or (deltaTime) or ()",
      );
      return { kind: "libCall", fn: midiFn("midi.onMessage"), args: [receiver, cb, once], type: VOID, loc };
    }
    L.noLowering(
      `input.${name}(${event === null ? "non-literal event" : `"${event}"`}, ...)`,
      args[0]!,
      '"message" is the supported midi Input event (as a literal)',
    );
  }
  L.noLowering(
    `midi.${isInput ? "Input" : "Output"}.${name}`,
    call,
    MIDI_SURFACE_HINT,
    L.checker.getSymbolAtLocation(access.name),
  );
}
