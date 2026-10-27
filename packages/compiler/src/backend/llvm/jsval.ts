/* The dynamic tier's jsval values (two-tier design stage S3; runtime
 * scr_js.h / scr_js_value.c).
 *
 * A jsval is a 64-bit NaN-boxed word carried as an LLVM `ptr` (the bits
 * travel through ptrtoint/inttoptr and are never dereferenced untagged), so
 * the emitter's frames, locals and calls handle it like any refcounted
 * pointer; its retain/release helpers skip immediates. Encoding (scr_js.h):
 *
 *   below LIMIT        an IEEE double, NaN canonical (0x7FF8000000000000)
 *   0xFFF9 << 48 | n   undefined 0, null 1, false 2, true 3
 *   0xFFFA << 48 | p   a ScrDyn cell
 *   0xFFFB << 48 | p   a ScrStr
 *   0xFFFC << 48 | p   a ScrBigInt
 *
 * Every js.* builtin inlines its number case: an operand is a number when
 * it is an immediate double or a NUM cell (values read from dyn objects
 * stay cells), and results are canonicalized immediates. Everything else
 * calls the runtime, which defers to the dyn operators. 32-bit targets
 * have no room for a double in a pointer: there a jsval is a ScrDyn cell
 * and every js.* builtin is a runtime call. */
import { InternalCompilerError } from "../../errors.js";
import { DYN, type IrExpr } from "../../ir/ir.js";
import type { LibCallExpr, LlValue, LlvmEmitterContext } from "./expr-context.js";
import { f64Lit } from "./common.js";
import { JS_BITS, JS_TAGS } from "./jsval-encoding.js";
import { releaseSym } from "./shapes.js";

/** SCR_DYN_NUM and the ScrDyn layout facts the number fast path reads
 * (64-bit targets only): kind at +8, v.num at +16. */
const DYN_NUM = 2;

type Host = LlvmEmitterContext;

/** Whether this target represents jsvals as NaN-boxed words. */
export function jsImmediates(host: { sizeType: "i32" | "i64" }): boolean {
  return host.sizeType === "i64";
}

/** Whether an emitted value is a temp the current statement frames own
 * (so a conversion may move it instead of retaining it). */
function ownedTemp(host: Host, v: LlValue): boolean {
  for (const frame of host.frames)
    for (const entry of frame) if (entry.slot !== true && entry.name === v.name) return true;
  return false;
}

/** An emitted value with its ownership taken: moved out of its frame when
 * it was a temp, retained otherwise. */
function takeOwned(host: Host, v: LlValue): string {
  if (ownedTemp(host, v)) {
    host.toFrame(v);
    return v.name;
  }
  return host.retainFrame(v.name, v.type);
}

function bitsOf(host: Host, v: string): string {
  const b = host.B.tmp();
  host.B.line(`${b} = ptrtoint ptr ${v} to i64`);
  return b;
}

function wordOf(host: Host, bits: string): string {
  const v = host.B.tmp();
  host.B.line(`${v} = inttoptr i64 ${bits} to ptr`);
  return v;
}

/** A double as a jsval word: NaN canonicalized. */
function boxDouble(host: Host, d: string): string {
  const B = host.B;
  const raw = B.tmp();
  const nan = B.tmp();
  const bits = B.tmp();
  B.line(`${raw} = bitcast double ${d} to i64`);
  B.line(`${nan} = fcmp uno double ${d}, ${d}`);
  B.line(`${bits} = select i1 ${nan}, i64 ${JS_BITS.canonicalNan}, i64 ${raw}`);
  return wordOf(host, bits);
}

/** An operand of a number fast path: its jsval word (computed on demand
 * for a static number), and the double a fast path computes with. */
interface Operand {
  word: () => string;
  /** Emits the number test: returns the double and branches to `slow`
   * when the operand is not a number; a static number needs no test. */
  number: (slow: string) => string;
}

/** A static value crossing into jsval: emitted, and its dyn converter
 * requested exactly as the `dynFrom` it replaces requested it. Converters
 * are numbered per module in request order, so skipping the request would
 * renumber the converters static functions call (their code must not
 * change by a byte). An unused converter is dead code LLVM drops. */
function emitStaticSource(host: Host, value: IrExpr): LlValue {
  const v = host.emitExpr(value);
  host.dyn.toDynHelper(v.type);
  return v;
}

function operand(host: Host, e: IrExpr): Operand {
  const B = host.B;
  if (e.kind === "libCall" && e.fn === "js.fromF64") {
    const d = emitStaticSource(host, e.args[0]!).name;
    const word: string[] = [];
    return {
      word: () => {
        if (word.length === 0) word.push(boxDouble(host, d));
        return word[0]!;
      },
      number: () => d,
    };
  }
  const v = host.emitExpr(e).name;
  return {
    word: () => v,
    number: (slow) => {
      const bits = bitsOf(host, v);
      const isDouble = B.tmp();
      B.line(`${isDouble} = icmp ult i64 ${bits}, ${JS_BITS.limit}`);
      const slot = B.slot();
      B.entryAllocas.push(`${slot} = alloca double`);
      const dbl = B.newLabel("js.dbl");
      const notDbl = B.newLabel("js.cell");
      const isNum = B.newLabel("js.num");
      const ok = B.newLabel("js.n");
      B.condBr(isDouble, dbl, notDbl);
      B.startBlock(dbl);
      const d = B.tmp();
      B.line(`${d} = bitcast i64 ${bits} to double`);
      B.line(`store double ${d}, ptr ${slot}`);
      B.br(ok);
      B.startBlock(notDbl);
      const tag = B.tmp();
      const cell = B.tmp();
      B.line(`${tag} = lshr i64 ${bits}, 48`);
      B.line(`${cell} = icmp eq i64 ${tag}, ${JS_TAGS.cell}`);
      const cellBlock = B.newLabel("js.cellk");
      B.condBr(cell, cellBlock, slow);
      B.startBlock(cellBlock);
      const addr = B.tmp();
      const p = B.tmp();
      const live = B.tmp();
      B.line(`${addr} = and i64 ${bits}, ${JS_BITS.payloadMask}`);
      B.line(`${p} = inttoptr i64 ${addr} to ptr`);
      B.line(`${live} = icmp ne ptr ${p}, null`);
      const kindBlock = B.newLabel("js.kind");
      B.condBr(live, kindBlock, slow);
      B.startBlock(kindBlock);
      const kp = B.tmp();
      const kind = B.tmp();
      const num = B.tmp();
      B.line(`${kp} = getelementptr inbounds i8, ptr ${p}, i64 8 ; ->kind`);
      B.line(`${kind} = load i32, ptr ${kp}`);
      B.line(`${num} = icmp eq i32 ${kind}, ${DYN_NUM}`);
      B.condBr(num, isNum, slow);
      B.startBlock(isNum);
      const np = B.tmp();
      const n = B.tmp();
      B.line(`${np} = getelementptr inbounds i8, ptr ${p}, i64 16 ; ->v.num`);
      B.line(`${n} = load double, ptr ${np}`);
      B.line(`store double ${n}, ptr ${slot}`);
      B.br(ok);
      B.startBlock(ok);
      const out = B.tmp();
      B.line(`${out} = load double, ptr ${slot}`);
      return out;
    },
  };
}

/** The common shape of an inlined builtin: the fast path stores its result
 * into a slot, the slow path calls the runtime (and checks for a throw),
 * and the join reads the slot. */
function withSlowPath(
  host: Host,
  ty: "ptr" | "double" | "i1",
  fast: (slow: string) => string,
  slow: () => string,
  mayThrow: boolean,
): string {
  const B = host.B;
  const slot = B.slot();
  B.entryAllocas.push(`${slot} = alloca ${ty}`);
  const slowLabel = B.newLabel("js.slow");
  const done = B.newLabel("js.done");
  const fastValue = fast(slowLabel);
  B.line(`store ${ty} ${fastValue}, ptr ${slot}`);
  B.br(done);
  B.startBlock(slowLabel);
  const slowValue = slow();
  B.line(`store ${ty} ${slowValue}, ptr ${slot}`);
  if (mayThrow) host.emitPendingCheck();
  B.br(done);
  B.startBlock(done);
  const out = B.tmp();
  B.line(`${out} = load ${ty}, ptr ${slot}`);
  return out;
}

function call(host: Host, ret: string, fn: string, args: [string, string][]): string {
  host.declare(`declare ${ret} @${fn}(${args.map(([t]) => t).join(", ")})`);
  const r = host.B.tmp();
  host.B.line(`${r} = call ${ret} @${fn}(${args.map(([t, v]) => `${t} ${v}`).join(", ")})`);
  return r;
}

/** `x % y` on two doubles: an integer remainder when both are integers of
 * magnitude below 2^31 and y is nonzero (the result keeps the dividend's
 * sign, so a zero result of a negative dividend, including -0, is -0),
 * else frem (libm's fmod). */
function remainder(host: Host, x: string, y: string): string {
  const B = host.B;
  host.declare(`declare double @llvm.fabs.f64(double)`);
  const ax = B.tmp();
  const ay = B.tmp();
  const smallX = B.tmp();
  const smallY = B.tmp();
  const small = B.tmp();
  B.line(`${ax} = call double @llvm.fabs.f64(double ${x})`);
  B.line(`${ay} = call double @llvm.fabs.f64(double ${y})`);
  B.line(`${smallX} = fcmp olt double ${ax}, 2147483648.0`);
  B.line(`${smallY} = fcmp olt double ${ay}, 2147483648.0`);
  B.line(`${small} = and i1 ${smallX}, ${smallY}`);
  const ints = B.newLabel("js.rem.i");
  const exact = B.newLabel("js.rem.x");
  const float = B.newLabel("js.rem.f");
  const join = B.newLabel("js.rem.j");
  B.condBr(small, ints, float);
  B.startBlock(ints);
  const xi = B.tmp();
  const yi = B.tmp();
  const xb = B.tmp();
  const yb = B.tmp();
  const xInt = B.tmp();
  const yInt = B.tmp();
  const nonzero = B.tmp();
  const both = B.tmp();
  const ok = B.tmp();
  B.line(`${xi} = fptosi double ${x} to i64`);
  B.line(`${yi} = fptosi double ${y} to i64`);
  B.line(`${xb} = sitofp i64 ${xi} to double`);
  B.line(`${yb} = sitofp i64 ${yi} to double`);
  B.line(`${xInt} = fcmp oeq double ${xb}, ${x}`);
  B.line(`${yInt} = fcmp oeq double ${yb}, ${y}`);
  B.line(`${nonzero} = icmp ne i64 ${yi}, 0`);
  B.line(`${both} = and i1 ${xInt}, ${yInt}`);
  B.line(`${ok} = and i1 ${both}, ${nonzero}`);
  B.condBr(ok, exact, float);
  B.startBlock(exact);
  const r = B.tmp();
  const rd = B.tmp();
  const xBits = B.tmp();
  const negative = B.tmp();
  const zero = B.tmp();
  const negZero = B.tmp();
  const intResult = B.tmp();
  B.line(`${r} = srem i64 ${xi}, ${yi}`);
  B.line(`${rd} = sitofp i64 ${r} to double`);
  B.line(`${xBits} = bitcast double ${x} to i64`);
  B.line(`${negative} = icmp slt i64 ${xBits}, 0`);
  B.line(`${zero} = icmp eq i64 ${r}, 0`);
  B.line(`${negZero} = and i1 ${negative}, ${zero}`);
  B.line(`${intResult} = select i1 ${negZero}, double -0.0, double ${rd}`);
  const exactEnd = B.currentLabel();
  B.br(join);
  B.startBlock(float);
  const fr = B.tmp();
  B.line(`${fr} = frem double ${x}, ${y}`);
  const floatEnd = B.currentLabel();
  B.br(join);
  B.startBlock(join);
  const out = B.tmp();
  B.line(`${out} = phi double [ ${intResult}, %${exactEnd} ], [ ${fr}, %${floatEnd} ]`);
  return out;
}

const BITWISE_OPS: Readonly<Record<string, string>> = {
  "&": "and",
  "|": "or",
  "^": "xor",
  "<<": "shl",
  ">>": "ashr",
  ">>>": "lshr",
};

/** A double's ToInt32 when its magnitude is below 2^63: truncation toward
 * zero, then the low 32 bits; branches to `slow` otherwise (NaN and the
 * infinities included). */
function int32Operand(host: Host, d: string, slow: string): string {
  const B = host.B;
  host.declare(`declare double @llvm.fabs.f64(double)`);
  const magnitude = B.tmp();
  const small = B.tmp();
  B.line(`${magnitude} = call double @llvm.fabs.f64(double ${d})`);
  B.line(`${small} = fcmp olt double ${magnitude}, 9223372036854775808.0`);
  const ok = B.newLabel("js.int");
  B.condBr(small, ok, slow);
  B.startBlock(ok);
  const wide = B.tmp();
  const i = B.tmp();
  B.line(`${wide} = fptosi double ${d} to i64`);
  B.line(`${i} = trunc i64 ${wide} to i32`);
  return i;
}

const ARITH_OPS: Readonly<Record<string, string>> = {
  "-": "fsub",
  "*": "fmul",
  "/": "fdiv",
  "%": "frem",
};

const COMPARE_OPS: Readonly<Record<string, string>> = {
  "<": "olt",
  "<=": "ole",
  ">": "ogt",
  ">=": "oge",
};

function literalOp(e: IrExpr): string | null {
  return e.kind === "strLit" ? e.value : null;
}

/** js.* libCalls. */
export function emitJsLibCall(host: Host, e: LibCallExpr): LlValue {
  if (!jsImmediates(host)) return emitBoxedJsLibCall(host, e);
  const B = host.B;
  const jsval = (name: string): LlValue => host.own({ name, type: e.type });
  const immediate = (name: string): LlValue => host.markImmortal({ name, type: e.type });
  switch (e.fn) {
    case "js.fromDyn": {
      const d = host.emitExpr(e.args[0]!);
      const owned = takeOwned(host, d);
      const bits = bitsOf(host, owned);
      const tagged = B.tmp();
      B.line(`${tagged} = or i64 ${bits}, ${JS_BITS.cellTag}`);
      return jsval(wordOf(host, tagged));
    }
    case "js.toDyn": {
      const v = host.emitExpr(e.args[0]!);
      const moved = ownedTemp(host, v);
      if (moved) host.toFrame(v);
      const out = withSlowPath(
        host,
        "ptr",
        (slow) => {
          const bits = bitsOf(host, v.name);
          const tag = B.tmp();
          const cell = B.tmp();
          B.line(`${tag} = lshr i64 ${bits}, 48`);
          B.line(`${cell} = icmp eq i64 ${tag}, ${JS_TAGS.cell}`);
          const cellBlock = B.newLabel("js.todyn.cell");
          B.condBr(cell, cellBlock, slow);
          B.startBlock(cellBlock);
          const addr = B.tmp();
          B.line(`${addr} = and i64 ${bits}, ${JS_BITS.payloadMask}`);
          const p = wordOf(host, addr);
          return moved ? p : host.retainFrame(p, DYN);
        },
        () =>
          call(host, "ptr", moved ? "scr_js_to_dyn" : "scr_js_to_dyn_borrow", [["ptr", v.name]]),
        false,
      );
      return host.own({ name: out, type: DYN });
    }
    case "js.fromF64":
      return immediate(boxDouble(host, emitStaticSource(host, e.args[0]!).name));
    case "js.fromBool": {
      const b = emitStaticSource(host, e.args[0]!).name;
      const bits = B.tmp();
      B.line(`${bits} = select i1 ${b}, i64 ${JS_BITS.true}, i64 ${JS_BITS.false}`);
      return immediate(wordOf(host, bits));
    }
    case "js.fromStr":
    case "js.fromBigInt": {
      const s = emitStaticSource(host, e.args[0]!);
      const owned = takeOwned(host, s);
      const bits = bitsOf(host, owned);
      const tagged = B.tmp();
      const tag = e.fn === "js.fromStr" ? JS_BITS.strTag : JS_BITS.bigintTag;
      B.line(`${tagged} = or i64 ${bits}, ${tag}`);
      return jsval(wordOf(host, tagged));
    }
    case "js.toF64": {
      const a = operand(host, e.args[0]!);
      const out = withSlowPath(
        host,
        "double",
        (slow) => a.number(slow),
        () => {
          // dynCheck's number check, on the value as a cell: the same
          // TypeError for a non-number.
          const boxed = call(host, "ptr", "scr_js_to_dyn_borrow", [["ptr", a.word()]]);
          const helper = host.dyn.dynCheckHelper(e.type, undefined);
          const d = B.tmp();
          B.line(`${d} = call double @${helper}(ptr ${boxed}, ptr null)`);
          B.line(`call void ${releaseSym(host.shapeHost, DYN)}(ptr ${boxed})`);
          return d;
        },
        true,
      );
      return { name: out, type: e.type };
    }
    case "js.add":
    case "js.arithmetic": {
      const op = e.fn === "js.add" ? "+" : literalOp(e.args[2]!);
      const inst = op === "+" ? "fadd" : op !== null ? ARITH_OPS[op] : undefined;
      const a = operand(host, e.args[0]!);
      const b = operand(host, e.args[1]!);
      const opArg = e.fn === "js.arithmetic" ? host.emitExpr(e.args[2]!).name : null;
      const runtime = (): string =>
        e.fn === "js.add"
          ? call(host, "ptr", "scr_js_add", [
              ["ptr", a.word()],
              ["ptr", b.word()],
            ])
          : call(host, "ptr", "scr_js_arithmetic", [
              ["ptr", a.word()],
              ["ptr", b.word()],
              ["ptr", opArg!],
            ]);
      if (inst === undefined) {
        // `**` (pow's JS edge cases) stays in the runtime.
        const r = runtime();
        const out = jsval(r);
        host.emitPendingCheck();
        return out;
      }
      const out = withSlowPath(
        host,
        "ptr",
        (slow) => {
          const x = a.number(slow);
          const y = b.number(slow);
          const r = op === "%" ? remainder(host, x, y) : B.tmp();
          if (op !== "%") B.line(`${r} = ${inst} double ${x}, ${y}`);
          return boxDouble(host, r);
        },
        runtime,
        true,
      );
      return jsval(out);
    }
    case "js.compare": {
      const op = literalOp(e.args[2]!);
      const pred = op !== null ? COMPARE_OPS[op] : undefined;
      if (pred === undefined)
        throw new InternalCompilerError(`llvm emitter bug: js.compare operator ${String(op)}`);
      const a = operand(host, e.args[0]!);
      const b = operand(host, e.args[1]!);
      const opArg = host.emitExpr(e.args[2]!).name;
      const out = withSlowPath(
        host,
        "i1",
        (slow) => {
          const x = a.number(slow);
          const y = b.number(slow);
          const r = B.tmp();
          B.line(`${r} = fcmp ${pred} double ${x}, ${y}`);
          return r;
        },
        () =>
          call(host, "zeroext i1", "scr_js_compare", [
            ["ptr", a.word()],
            ["ptr", b.word()],
            ["ptr", opArg],
          ]),
        true,
      );
      return { name: out, type: e.type };
    }
    case "js.toNumeric":
    case "js.increment": {
      const a = operand(host, e.args[0]!);
      const step = e.fn === "js.increment" ? host.emitExpr(e.args[1]!).name : null;
      const out = withSlowPath(
        host,
        "ptr",
        (slow) => {
          const x = a.number(slow);
          if (step === null) return boxDouble(host, x);
          const delta = B.tmp();
          const r = B.tmp();
          B.line(`${delta} = select i1 ${step}, double ${f64Lit(1)}, double ${f64Lit(-1)}`);
          B.line(`${r} = fadd double ${x}, ${delta}`);
          return boxDouble(host, r);
        },
        () =>
          step === null
            ? call(host, "ptr", "scr_js_to_numeric", [["ptr", a.word()]])
            : call(host, "ptr", "scr_js_increment", [
                ["ptr", a.word()],
                ["i1 zeroext", step],
              ]),
        true,
      );
      return jsval(out);
    }
    case "js.toNumberCoerce": {
      const a = operand(host, e.args[0]!);
      const out = withSlowPath(
        host,
        "double",
        (slow) => a.number(slow),
        () => call(host, "double", "scr_js_to_number", [["ptr", a.word()]]),
        true,
      );
      return { name: out, type: e.type };
    }
    case "js.bitwise": {
      const op = literalOp(e.args[2]!);
      const inst = op !== null ? BITWISE_OPS[op] : undefined;
      if (inst === undefined) {
        const a = host.emitExpr(e.args[0]!).name;
        const b = host.emitExpr(e.args[1]!).name;
        const opArg = host.emitExpr(e.args[2]!).name;
        const r = call(host, "ptr", "scr_js_bitwise", [
          ["ptr", a],
          ["ptr", b],
          ["ptr", opArg],
        ]);
        const out = jsval(r);
        host.emitPendingCheck();
        return out;
      }
      // Two numbers of magnitude below 2^63: ToInt32 is truncation and
      // wrapping, so the operation runs on i32; anything else (NaN, the
      // infinities, larger magnitudes) takes the runtime.
      const a = operand(host, e.args[0]!);
      const b = operand(host, e.args[1]!);
      const opArg = host.emitExpr(e.args[2]!).name;
      const out = withSlowPath(
        host,
        "ptr",
        (slow) => {
          const x = int32Operand(host, a.number(slow), slow);
          const y = int32Operand(host, b.number(slow), slow);
          const r = B.tmp();
          const d = B.tmp();
          if (op === "<<" || op === ">>" || op === ">>>") {
            const count = B.tmp();
            B.line(`${count} = and i32 ${y}, 31`);
            B.line(`${r} = ${inst} i32 ${x}, ${count}`);
          } else {
            B.line(`${r} = ${inst} i32 ${x}, ${y}`);
          }
          B.line(`${d} = ${op === ">>>" ? "uitofp" : "sitofp"} i32 ${r} to double`);
          return boxDouble(host, d);
        },
        () =>
          call(host, "ptr", "scr_js_bitwise", [
            ["ptr", a.word()],
            ["ptr", b.word()],
            ["ptr", opArg],
          ]),
        true,
      );
      return jsval(out);
    }
    default:
      throw new InternalCompilerError(`llvm emitter bug: unknown jsval builtin ${e.fn}`);
  }
}

/** 32-bit targets: a jsval is a ScrDyn cell, so the conversions to and from
 * dyn are moves and every operator is a runtime call. */
function emitBoxedJsLibCall(host: Host, e: LibCallExpr): LlValue {
  const B = host.B;
  const args = (): LlValue[] => e.args.map((arg) => host.emitExpr(arg));
  const owned = (name: string): LlValue => host.own({ name, type: e.type });
  const throwing = (v: LlValue): LlValue => {
    host.emitPendingCheck();
    return v;
  };
  switch (e.fn) {
    case "js.fromDyn":
    case "js.toDyn": {
      const v = host.emitExpr(e.args[0]!);
      return owned(takeOwned(host, v));
    }
    case "js.fromF64":
      return owned(
        call(host, "ptr", "scr_dyn_new_num", [["double", emitStaticSource(host, e.args[0]!).name]]),
      );
    case "js.fromBool":
      return owned(
        call(host, "ptr", "scr_dyn_new_bool", [
          ["i1 zeroext", emitStaticSource(host, e.args[0]!).name],
        ]),
      );
    case "js.fromStr":
      return owned(
        call(host, "ptr", "scr_js_from_str", [["ptr", emitStaticSource(host, e.args[0]!).name]]),
      );
    case "js.fromBigInt":
      return owned(
        call(host, "ptr", "scr_js_from_bigint", [["ptr", emitStaticSource(host, e.args[0]!).name]]),
      );
    case "js.toF64": {
      const v = host.emitExpr(e.args[0]!).name;
      const helper = host.dyn.dynCheckHelper(e.type, undefined);
      const d = B.tmp();
      B.line(`${d} = call double @${helper}(ptr ${v}, ptr null)`);
      return throwing({ name: d, type: e.type });
    }
    case "js.add": {
      const [a, b] = args();
      return throwing(
        owned(
          call(host, "ptr", "scr_js_add", [
            ["ptr", a!.name],
            ["ptr", b!.name],
          ]),
        ),
      );
    }
    case "js.arithmetic":
    case "js.bitwise": {
      const [a, b, op] = args();
      const fn = e.fn === "js.arithmetic" ? "scr_js_arithmetic" : "scr_js_bitwise";
      return throwing(
        owned(
          call(host, "ptr", fn, [
            ["ptr", a!.name],
            ["ptr", b!.name],
            ["ptr", op!.name],
          ]),
        ),
      );
    }
    case "js.compare": {
      const [a, b, op] = args();
      const r = call(host, "zeroext i1", "scr_js_compare", [
        ["ptr", a!.name],
        ["ptr", b!.name],
        ["ptr", op!.name],
      ]);
      return throwing({ name: r, type: e.type });
    }
    case "js.toNumeric":
      return throwing(owned(call(host, "ptr", "scr_js_to_numeric", [["ptr", args()[0]!.name]])));
    case "js.increment": {
      const [a, step] = args();
      return throwing(
        owned(
          call(host, "ptr", "scr_js_increment", [
            ["ptr", a!.name],
            ["i1 zeroext", step!.name],
          ]),
        ),
      );
    }
    case "js.toNumberCoerce":
      return throwing({
        name: call(host, "double", "scr_js_to_number", [["ptr", args()[0]!.name]]),
        type: e.type,
      });
    default:
      throw new InternalCompilerError(`llvm emitter bug: unknown jsval builtin ${e.fn}`);
  }
}

/** ToBoolean of a jsval (a toBool over an operator result): doubles and
 * the special words inline, cells, strings and BigInts in the runtime. */
export function jsTruthy(host: Host, v: string): string {
  if (!jsImmediates(host)) {
    host.declare(`declare zeroext i1 @scr_dyn_truthy(ptr)`);
    const r = host.B.tmp();
    host.B.line(`${r} = call zeroext i1 @scr_dyn_truthy(ptr ${v})`);
    return r;
  }
  const B = host.B;
  const slot = B.slot();
  B.entryAllocas.push(`${slot} = alloca i1`);
  const bits = bitsOf(host, v);
  const isDouble = B.tmp();
  B.line(`${isDouble} = icmp ult i64 ${bits}, ${JS_BITS.limit}`);
  const dbl = B.newLabel("js.truthy.d");
  const other = B.newLabel("js.truthy.o");
  const special = B.newLabel("js.truthy.s");
  const heap = B.newLabel("js.truthy.h");
  const done = B.newLabel("js.truthy.j");
  B.condBr(isDouble, dbl, other);
  B.startBlock(dbl);
  const d = B.tmp();
  const t = B.tmp();
  B.line(`${d} = bitcast i64 ${bits} to double`);
  B.line(`${t} = fcmp one double ${d}, ${f64Lit(0)}`);
  B.line(`store i1 ${t}, ptr ${slot}`);
  B.br(done);
  B.startBlock(other);
  const tag = B.tmp();
  const isSpecial = B.tmp();
  B.line(`${tag} = lshr i64 ${bits}, 48`);
  B.line(`${isSpecial} = icmp eq i64 ${tag}, 65529`);
  B.condBr(isSpecial, special, heap);
  B.startBlock(special);
  const isTrue = B.tmp();
  B.line(`${isTrue} = icmp eq i64 ${bits}, ${JS_BITS.true}`);
  B.line(`store i1 ${isTrue}, ptr ${slot}`);
  B.br(done);
  B.startBlock(heap);
  const r = call(host, "zeroext i1", "scr_js_truthy", [["ptr", v]]);
  B.line(`store i1 ${r}, ptr ${slot}`);
  B.br(done);
  B.startBlock(done);
  const out = B.tmp();
  B.line(`${out} = load i1, ptr ${slot}`);
  return out;
}
