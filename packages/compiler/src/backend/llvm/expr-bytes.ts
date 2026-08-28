/* Focused LLVM expression emission extracted from emitter.ts. */
import { InternalCompilerError } from "../../errors.js";
import { isStableBytesOperand } from "../../ir/analysis.js";
import { F64, IrBytesElem, IrExpr } from "../../ir/ir.js";
import type { LlvmEmitterContext, LlValue } from "./expr-context.js";
import { F64_INF, f64Lit } from "./common.js";

const BYTES_NUM_KIND: Record<string, { kind: number; le: boolean } | undefined> = {
  u8: { kind: 0, le: false },
  i8: { kind: 1, le: false },
  u16be: { kind: 2, le: false },
  u16le: { kind: 2, le: true },
  i16be: { kind: 3, le: false },
  i16le: { kind: 3, le: true },
  u32be: { kind: 4, le: false },
  u32le: { kind: 4, le: true },
  i32be: { kind: 5, le: false },
  i32le: { kind: 5, le: true },
  f32be: { kind: 6, le: false },
  f32le: { kind: 6, le: true },
  f64be: { kind: 7, le: false },
  f64le: { kind: 7, le: true },
};

const BYTES_NUM_VAR: Record<string, { sign: boolean; le: boolean } | undefined> = {
  ube: { sign: false, le: false },
  ule: { sign: false, le: true },
  ibe: { sign: true, le: false },
  ile: { sign: true, le: true },
};

const DV_GET_KIND: Record<string, number> = {
  dvGetUint8: 0,
  dvGetInt8: 1,
  dvGetUint16: 2,
  dvGetInt16: 3,
  dvGetUint32: 4,
  dvGetInt32: 5,
  dvGetFloat32: 6,
  dvGetFloat64: 7,
  dvGetBigUint64Number: 8,
  dvGetBigInt64Number: 9,
};

const DV_SET_KIND: Record<string, number> = {
  dvSetUint8: 0,
  dvSetInt8: 1,
  dvSetUint16: 2,
  dvSetInt16: 3,
  dvSetUint32: 4,
  dvSetInt32: 5,
  dvSetFloat32: 6,
  dvSetFloat64: 7,
};

export function emitBytesReceiver(host: LlvmEmitterContext, receiver: IrExpr, following: IrExpr[]): LlValue {
    if (
      receiver.kind === "varRef" &&
      following.every((operand) => isStableBytesOperand(operand, receiver.localId))
    ) {
      const b = host.binding(receiver.localId);
      if (b.kind !== "boxed") {
        const value = host.B.tmp();
        host.B.line(`${value} = load ptr, ptr ${b.slot}`);
        return { name: value, type: receiver.type };
      }
    }
    return host.emitExpr(receiver);
  }

export function emitIntegerLoopIndex(host: LlvmEmitterContext, expr: IrExpr): string | null {
    if (expr.kind !== "varRef") return null;
    const slot = host.integerLoopBindings.get(expr.localId);
    if (slot === undefined) return null;
    const index = host.B.tmp();
    host.B.line(`${index} = load ${host.sizeType}, ptr ${slot}`);
    return index;
  }

export function emitBytesIndex(host: LlvmEmitterContext, receiver: string, index: string, integerIndex = false): string {
    const B = host.B;
    const lenPtr = B.tmp();
    const len = B.tmp();
    B.line(`${lenPtr} = getelementptr inbounds %ScrBytes, ptr ${receiver}, i64 0, i32 1`);
    B.line(`${len} = load ${host.sizeType}, ptr ${lenPtr}`);
    if (integerIndex) {
      const inRange = B.tmp();
      B.line(`${inRange} = icmp ult ${host.sizeType} ${index}, ${len}`);
      const invalid = B.newLabel("bytes.index.invalid");
      const valid = B.newLabel("bytes.index.valid");
      B.condBr(inRange, valid, invalid);
      B.startBlock(invalid);
      const indexF64 = B.tmp();
      B.line(`${indexF64} = uitofp ${host.sizeType} ${index} to double`);
      host.declare(`declare double @scr_bytes_get(ptr, double)`);
      B.line(`call double @scr_bytes_get(ptr ${receiver}, double ${indexF64})`);
      B.terminate("unreachable");
      B.startBlock(valid);
      return index;
    }
    const lenF64 = B.tmp();
    const nonnegative = B.tmp();
    const belowLen = B.tmp();
    const inRange = B.tmp();
    B.line(`${lenF64} = uitofp ${host.sizeType} ${len} to double`);
    B.line(`${nonnegative} = fcmp oge double ${index}, ${f64Lit(0)}`);
    B.line(`${belowLen} = fcmp olt double ${index}, ${lenF64}`);
    B.line(`${inRange} = and i1 ${nonnegative}, ${belowLen}`);

    const rangeOk = B.newLabel("bytes.index.range");
    const invalid = B.newLabel("bytes.index.invalid");
    const valid = B.newLabel("bytes.index.valid");
    B.condBr(inRange, rangeOk, invalid);

    B.startBlock(rangeOk);
    const idx = B.tmp();
    const roundTrip = B.tmp();
    const integral = B.tmp();
    B.line(`${idx} = fptoui double ${index} to ${host.sizeType}`);
    B.line(`${roundTrip} = uitofp ${host.sizeType} ${idx} to double`);
    B.line(`${integral} = fcmp oeq double ${roundTrip}, ${index}`);
    B.condBr(integral, valid, invalid);

    B.startBlock(invalid);
    host.declare(`declare double @scr_bytes_get(ptr, double)`);
    B.line(`call double @scr_bytes_get(ptr ${receiver}, double ${index})`);
    B.terminate("unreachable");

    B.startBlock(valid);
    return idx;
  }

export function emitBytesData(host: LlvmEmitterContext, receiver: string): string {
    const p = host.B.tmp();
    const data = host.B.tmp();
    host.B.line(`${p} = getelementptr inbounds %ScrBytes, ptr ${receiver}, i64 0, i32 3`);
    host.B.line(`${data} = load ptr, ptr ${p}`);
    return data;
  }

export function emitBytesLength(host: LlvmEmitterContext, elem: IrBytesElem, receiver: string, bytes: boolean): LlValue {
    const B = host.B;
    const p = B.tmp();
    const len = B.tmp();
    B.line(`${p} = getelementptr inbounds %ScrBytes, ptr ${receiver}, i64 0, i32 1`);
    B.line(`${len} = load ${host.sizeType}, ptr ${p}`);
    const count = bytes && elem !== "u8" ? B.tmp() : len;
    if (count !== len) B.line(`${count} = shl ${host.sizeType} ${len}, 2`);
    const out = B.tmp();
    B.line(`${out} = uitofp ${host.sizeType} ${count} to double`);
    return { name: out, type: F64 };
  }

export function emitBytesGet(host: LlvmEmitterContext, elem: IrBytesElem, receiver: string, index: string, integerIndex = false): LlValue {
    const B = host.B;
    const idx = host.emitBytesIndex(receiver, index, integerIndex);
    const data = host.emitBytesData(receiver);
    const p = B.tmp();
    if (elem === "u8") {
      const raw = B.tmp();
      const wide = B.tmp();
      const out = B.tmp();
      B.line(`${p} = getelementptr inbounds i8, ptr ${data}, ${host.sizeType} ${idx}`);
      B.line(`${raw} = load i8, ptr ${p}, align 1`);
      B.line(`${wide} = zext i8 ${raw} to i32`);
      B.line(`${out} = uitofp i32 ${wide} to double`);
      return { name: out, type: F64 };
    }
    if (elem === "f32") {
      const raw = B.tmp();
      const out = B.tmp();
      B.line(`${p} = getelementptr inbounds float, ptr ${data}, ${host.sizeType} ${idx}`);
      B.line(`${raw} = load float, ptr ${p}, align 1`);
      B.line(`${out} = fpext float ${raw} to double`);
      return { name: out, type: F64 };
    }
    const raw = B.tmp();
    const out = B.tmp();
    B.line(`${p} = getelementptr inbounds i32, ptr ${data}, ${host.sizeType} ${idx}`);
    B.line(`${raw} = load i32, ptr ${p}, align 1`);
    B.line(`${out} = ${elem === "i32" ? "sitofp" : "uitofp"} i32 ${raw} to double`);
    return { name: out, type: F64 };
  }

export function emitBytesU32(host: LlvmEmitterContext, value: string): string {
    const B = host.B;
    const aboveMin = B.tmp();
    const belowMax = B.tmp();
    const fast = B.tmp();
    B.line(`${aboveMin} = fcmp oge double ${value}, ${f64Lit(-9007199254740992)}`);
    B.line(`${belowMax} = fcmp ole double ${value}, ${f64Lit(9007199254740992)}`);
    B.line(`${fast} = and i1 ${aboveMin}, ${belowMax}`);

    const fastLabel = B.newLabel("bytes.coerce.fast");
    const slowLabel = B.newLabel("bytes.coerce.slow");
    const done = B.newLabel("bytes.coerce.done");
    B.condBr(fast, fastLabel, slowLabel);

    B.startBlock(fastLabel);
    const signed = B.tmp();
    const fastU32 = B.tmp();
    B.line(`${signed} = fptosi double ${value} to i64`);
    B.line(`${fastU32} = trunc i64 ${signed} to i32`);
    B.br(done);

    B.startBlock(slowLabel);
    const ordered = B.tmp();
    const belowInf = B.tmp();
    const aboveNegInf = B.tmp();
    const finiteRange = B.tmp();
    const finite = B.tmp();
    B.line(`${ordered} = fcmp ord double ${value}, ${value}`);
    B.line(`${belowInf} = fcmp olt double ${value}, ${F64_INF}`);
    B.line(`${aboveNegInf} = fcmp ogt double ${value}, ${f64Lit(-Infinity)}`);
    B.line(`${finiteRange} = and i1 ${belowInf}, ${aboveNegInf}`);
    B.line(`${finite} = and i1 ${ordered}, ${finiteRange}`);
    const finiteLabel = B.newLabel("bytes.coerce.finite");
    const nonfiniteLabel = B.newLabel("bytes.coerce.nonfinite");
    const slowDone = B.newLabel("bytes.coerce.slow.done");
    B.condBr(finite, finiteLabel, nonfiniteLabel);

    B.startBlock(finiteLabel);
    host.declare(`declare double @llvm.trunc.f64(double)`);
    const truncated = B.tmp();
    const residue = B.tmp();
    const negative = B.tmp();
    const wrapped = B.tmp();
    const normalized = B.tmp();
    const finiteU32 = B.tmp();
    B.line(`${truncated} = call double @llvm.trunc.f64(double ${value})`);
    B.line(`${residue} = frem double ${truncated}, ${f64Lit(4294967296)}`);
    B.line(`${negative} = fcmp olt double ${residue}, ${f64Lit(0)}`);
    B.line(`${wrapped} = fadd double ${residue}, ${f64Lit(4294967296)}`);
    B.line(`${normalized} = select i1 ${negative}, double ${wrapped}, double ${residue}`);
    B.line(`${finiteU32} = fptoui double ${normalized} to i32`);
    B.br(slowDone);

    B.startBlock(nonfiniteLabel);
    B.br(slowDone);

    B.startBlock(slowDone);
    const slowU32 = B.tmp();
    B.line(`${slowU32} = phi i32 [ ${finiteU32}, %${finiteLabel} ], [ 0, %${nonfiniteLabel} ]`);
    B.br(done);

    B.startBlock(done);
    const out = B.tmp();
    B.line(`${out} = phi i32 [ ${fastU32}, %${fastLabel} ], [ ${slowU32}, %${slowDone} ]`);
    return out;
  }

export function emitBytesSet(host: LlvmEmitterContext, elem: IrBytesElem, receiver: string, index: string, value: string, integerIndex = false): void {
    const B = host.B;
    const idx = host.emitBytesIndex(receiver, index, integerIndex);
    const stored = elem === "f32" ? null : host.emitBytesU32(value);
    const data = host.emitBytesData(receiver);
    const p = B.tmp();
    if (elem === "u8") {
      const byte = B.tmp();
      B.line(`${byte} = trunc i32 ${stored!} to i8`);
      B.line(`${p} = getelementptr inbounds i8, ptr ${data}, ${host.sizeType} ${idx}`);
      B.line(`store i8 ${byte}, ptr ${p}, align 1`);
      return;
    }
    if (elem === "f32") {
      const narrowed = B.tmp();
      B.line(`${narrowed} = fptrunc double ${value} to float`);
      B.line(`${p} = getelementptr inbounds float, ptr ${data}, ${host.sizeType} ${idx}`);
      B.line(`store float ${narrowed}, ptr ${p}, align 1`);
      return;
    }
    B.line(`${p} = getelementptr inbounds i32, ptr ${data}, ${host.sizeType} ${idx}`);
    B.line(`store i32 ${stored!}, ptr ${p}, align 1`);
  }

export function emitBytesIntrinsic(host: LlvmEmitterContext, e: IrExpr & { kind: "bytesIntrinsic" }): LlValue {
    const B = host.B;
    const call = (sym: string, sig: string, argText: string, owned: boolean, fallible: boolean): LlValue => {
      const m = /^(.+?) \((.*)\)$/.exec(sig);
      if (!m) throw new InternalCompilerError(`llvm emitter bug: bad bytesIntrinsic sig ${sig}`);
      host.declare(`declare ${m[1]} @${sym}(${m[2]})`);
      const retTy = m[1] === "zeroext i1" ? "i1" : m[1]!;
      if (retTy === "void") {
        B.line(`call void @${sym}(${argText})`);
        if (fallible) host.emitPendingCheck();
        return { name: "", type: e.type };
      }
      const t = B.tmp();
      B.line(`${t} = call ${retTy} @${sym}(${argText})`);
      const out = owned ? host.own({ name: t, type: e.type }) : { name: t, type: e.type };
      if (fallible) host.emitPendingCheck();
      return out;
    };
    if (e.method === "readNum" || e.method === "writeNum" || e.method === "readNumVar" || e.method === "writeNumVar") {
      const tok = e.args[0]!;
      if (tok.kind !== "strLit") throw new InternalCompilerError(`llvm emitter bug: bytesIntrinsic ${e.method} kind must be a strLit`);
      const r0 = host.emitExpr(e.receiver);
      const rest = e.args.slice(1).map((a) => host.emitExpr(a));
      if (e.method === "readNum" || e.method === "writeNum") {
        const spec = BYTES_NUM_KIND[tok.value];
        if (!spec) throw new InternalCompilerError(`llvm emitter bug: bytes numeric kind '${tok.value}'`);
        return e.method === "readNum"
          ? call("scr_bytes_read_num", "double (ptr, double, i32, i1 zeroext)",
              `ptr ${r0.name}, double ${rest[0]!.name}, i32 ${spec.kind}, i1 ${spec.le}`, false, true)
          : call("scr_bytes_write_num", "double (ptr, double, double, i32, i1 zeroext)",
              `ptr ${r0.name}, double ${rest[0]!.name}, double ${rest[1]!.name}, i32 ${spec.kind}, i1 ${spec.le}`, false, true);
      }
      const spec = BYTES_NUM_VAR[tok.value];
      if (!spec) throw new InternalCompilerError(`llvm emitter bug: bytes variable-width kind '${tok.value}'`);
      return e.method === "readNumVar"
        ? call("scr_bytes_read_var", "double (ptr, double, double, i1 zeroext, i1 zeroext)",
            `ptr ${r0.name}, double ${rest[0]!.name}, double ${rest[1]!.name}, i1 ${spec.sign}, i1 ${spec.le}`, false, true)
        : call("scr_bytes_write_var", "double (ptr, double, double, double, i1 zeroext, i1 zeroext)",
            `ptr ${r0.name}, double ${rest[0]!.name}, double ${rest[1]!.name}, double ${rest[2]!.name}, i1 ${spec.sign}, i1 ${spec.le}`, false, true);
    }
    const method = e.method;
    const directElementAccess = method === "length" || method === "byteLength" || method === "get";
    const r = directElementAccess
      ? host.emitBytesReceiver(e.receiver, e.args)
      : host.emitExpr(e.receiver);
    const integerIndex = method === "get" ? host.emitIntegerLoopIndex(e.args[0]!) : null;
    const args = integerIndex === null ? e.args.map((a) => host.emitExpr(a)) : [];
    const NAN = f64Lit(NaN);
    switch (method) {
      case "length":
        if (e.receiver.type.kind !== "bytes") {
          throw new InternalCompilerError("llvm emitter bug: bytesIntrinsic length on non-bytes");
        }
        return host.emitBytesLength(e.receiver.type.elem, r.name, false);
      case "byteLength":
        if (e.receiver.type.kind !== "bytes") {
          throw new InternalCompilerError("llvm emitter bug: bytesIntrinsic byteLength on non-bytes");
        }
        return host.emitBytesLength(e.receiver.type.elem, r.name, true);
      case "get":
        // Any invalid index traps (the array runtime's discipline).
        if (e.receiver.type.kind !== "bytes") {
          throw new InternalCompilerError("llvm emitter bug: bytesIntrinsic get on non-bytes");
        }
        return host.emitBytesGet(
          e.receiver.type.elem,
          r.name,
          integerIndex ?? args[0]!.name,
          integerIndex !== null,
        );
      case "slice":
        return call(
          "scr_bytes_slice",
          "ptr (ptr, double, double)",
          `ptr ${r.name}, double ${args[0]?.name ?? f64Lit(0)}, double ${args[1]?.name ?? F64_INF}`,
          true,
          false,
        );
      case "subarray":
        // A +1 VIEW aliasing the receiver's storage (subarray / Buffer's
        // slice); same index defaults as slice.
        return call(
          "scr_bytes_subarray",
          "ptr (ptr, double, double)",
          `ptr ${r.name}, double ${args[0]?.name ?? f64Lit(0)}, double ${args[1]?.name ?? F64_INF}`,
          true,
          false,
        );
      case "toReversed":
        return call(
          "scr_bytes_to_reversed",
          "ptr (ptr)",
          `ptr ${r.name}`,
          true,
          false,
        );
      case "with":
        return call(
          "scr_bytes_with",
          "ptr (ptr, double, double)",
          `ptr ${r.name}, double ${args[0]!.name}, double ${args[1]!.name}`,
          true,
          true,
        );
      case "join":
        return call(
          "scr_bytes_join",
          "ptr (ptr, ptr)",
          `ptr ${r.name}, ptr ${args[0]!.name}`,
          true,
          false,
        );
      case "toArray":
        return call(
          "scr_bytes_to_arr",
          "ptr (ptr)",
          `ptr ${r.name}`,
          true,
          false,
        );
      case "setFrom":
        // dst.set(src, offset?) — void; throws Node's RangeError on
        // overflow.
        return call(
          "scr_bytes_set_from",
          "void (ptr, ptr, double)",
          `ptr ${r.name}, ptr ${args[0]!.name}, double ${args[1]?.name ?? f64Lit(0)}`,
          false,
          true,
        );
      case "toString":
      case "toStringVar": {
        // The encoding arg is always present (the frontend completes an
        // omitted one to "utf8"). The runtime-valued form validates and
        // may throw ERR_UNKNOWN_ENCODING; the literal form is canonical
        // and cannot throw. Both return +1. Range forms: [enc, start]
        // decode to the buffer's end (the element count — r->len in the C
        // spelling); [enc, start, end] clamps.
        const checked = method === "toStringVar";
        const stem = checked ? "scr_bytes_to_str_checked" : "scr_bytes_to_str";
        if (e.args.length === 3) {
          return call(
            `${stem}_range`,
            "ptr (ptr, ptr, double, double)",
            `ptr ${r.name}, ptr ${args[0]!.name}, double ${args[1]!.name}, double ${args[2]!.name}`,
            true,
            checked,
          );
        }
        if (e.args.length === 2) {
          host.declare(`declare double @scr_bytes_len(ptr)`);
          const len = B.tmp();
          B.line(`${len} = call double @scr_bytes_len(ptr ${r.name})`);
          return call(
            `${stem}_range`,
            "ptr (ptr, ptr, double, double)",
            `ptr ${r.name}, ptr ${args[0]!.name}, double ${args[1]!.name}, double ${len}`,
            true,
            checked,
          );
        }
        return call(stem, "ptr (ptr, ptr)", `ptr ${r.name}, ptr ${args[0]!.name}`, true, checked);
      }
      case "equals":
        return call("scr_bytes_equals", "zeroext i1 (ptr, ptr)", `ptr ${r.name}, ptr ${args[0]!.name}`, false, false);
      case "compareBuf": {
        // nargs = the PRESENT index args (omitted ones skip Node's
        // validation); the 0 placeholders are never read past nargs.
        const n = e.args.length - 1;
        const idx = [1, 2, 3, 4].map((i) => args[i]?.name ?? f64Lit(0));
        return call(
          "scr_bytes_compare",
          "double (ptr, ptr, double, double, double, double, double)",
          `ptr ${r.name}, ptr ${args[0]!.name}, double ${f64Lit(n)}, ${idx.map((x) => `double ${x}`).join(", ")}`,
          false,
          true,
        );
      }
      case "indexOf":
      case "lastIndexOf":
      case "includes": {
        // args = [needle, align, byteOffset?]; an omitted byteOffset is
        // NaN — the runtime's search-everything default.
        const fwd = method !== "lastIndexOf";
        const idx = call(
          "scr_bytes_index_of",
          "double (ptr, ptr, double, double, i1 zeroext)",
          `ptr ${r.name}, ptr ${args[0]!.name}, double ${args[2]?.name ?? NAN}, double ${args[1]!.name}, i1 ${fwd}`,
          false,
          false,
        );
        if (method !== "includes") return idx;
        const t = B.tmp();
        B.line(`${t} = fcmp one double ${idx.name}, ${f64Lit(-1)}`);
        return { name: t, type: e.type };
      }
      case "indexOfNum":
      case "lastIndexOfNum":
      case "includesNum": {
        const fwd = method !== "lastIndexOfNum";
        const idx = call(
          "scr_bytes_index_of_num",
          "double (ptr, double, double, i1 zeroext)",
          `ptr ${r.name}, double ${args[0]!.name}, double ${args[1]?.name ?? NAN}, i1 ${fwd}`,
          false,
          false,
        );
        if (method !== "includesNum") return idx;
        const t = B.tmp();
        B.line(`${t} = fcmp one double ${idx.name}, ${f64Lit(-1)}`);
        return { name: t, type: e.type };
      }
      case "fillElem":
        // Per-element TypedArray fill (non-u8): slice-style index
        // defaults, never throws; the receiver comes back +1.
        return call(
          "scr_bytes_fill_elem",
          "ptr (ptr, double, double, double)",
          `ptr ${r.name}, double ${args[0]!.name}, double ${args[1]?.name ?? f64Lit(0)}, double ${args[2]?.name ?? F64_INF}`,
          true,
          false,
        );
      case "fill":
      case "fillNum": {
        const sym = method === "fill" ? "scr_bytes_fill" : "scr_bytes_fill_num";
        const vTy = method === "fill" ? "ptr" : "double";
        const n = e.args.length - 1;
        return call(
          sym,
          `ptr (ptr, ${vTy}, double, double, double)`,
          `ptr ${r.name}, ${vTy} ${args[0]!.name}, double ${f64Lit(n)}, double ${args[1]?.name ?? f64Lit(0)}, double ${args[2]?.name ?? f64Lit(0)}`,
          true,
          true,
        );
      }
      case "fillStr": {
        const n = e.args.length - 2;
        return call(
          "scr_bytes_fill_str",
          "ptr (ptr, ptr, ptr, double, double, double)",
          `ptr ${r.name}, ptr ${args[0]!.name}, ptr ${args[1]!.name}, double ${f64Lit(n)}, double ${args[2]?.name ?? f64Lit(0)}, double ${args[3]?.name ?? f64Lit(0)}`,
          true,
          true,
        );
      }
      case "copy": {
        const n = e.args.length - 1;
        return call(
          "scr_bytes_copy_into",
          "double (ptr, ptr, double, double, double, double)",
          `ptr ${r.name}, ptr ${args[0]!.name}, double ${f64Lit(n)}, double ${args[1]?.name ?? f64Lit(0)}, double ${args[2]?.name ?? f64Lit(0)}, double ${args[3]?.name ?? f64Lit(0)}`,
          false,
          true,
        );
      }
      case "swap16":
      case "swap32":
      case "swap64": {
        const w = method === "swap16" ? 2 : method === "swap32" ? 4 : 8;
        return call("scr_bytes_swap", "ptr (ptr, double)", `ptr ${r.name}, double ${f64Lit(w)}`, true, true);
      }
      case "writeStr":
        return call(
          "scr_bytes_write_str",
          "double (ptr, ptr, ptr, double, double, i1 zeroext)",
          `ptr ${r.name}, ptr ${args[0]!.name}, ptr ${args[1]!.name}, double ${args[2]!.name}, double ${args[3]?.name ?? f64Lit(0)}, i1 ${args[3] ? "true" : "false"}`,
          false,
          true,
        );
      case "byteOffset":
        return call("scr_bytes_byte_offset", "double (ptr)", `ptr ${r.name}`, false, false);
      case "dataViewNew":
        // new DataView(x.buffer, byteOffset?, byteLength?) — the has_len
        // flag keeps an omitted length distinct from every numeric value.
        return call(
          "scr_dataview_new",
          "ptr (ptr, double, i1 zeroext, double)",
          `ptr ${r.name}, double ${args[0]?.name ?? f64Lit(0)}, i1 ${args[1] ? "true" : "false"}, double ${args[1]?.name ?? f64Lit(0)}`,
          true,
          true,
        );
      case "dvGetUint8":
      case "dvGetInt8":
      case "dvGetUint16":
      case "dvGetInt16":
      case "dvGetUint32":
      case "dvGetInt32":
      case "dvGetFloat32":
      case "dvGetFloat64":
      case "dvGetBigUint64Number":
      case "dvGetBigInt64Number":
        // DataView getters: an omitted littleEndian is big-endian (the JS
        // default). Throw Node's constant RangeError on a bad offset.
        return call(
          "scr_dataview_get",
          "double (ptr, double, i32, i1 zeroext)",
          `ptr ${r.name}, double ${args[0]!.name}, i32 ${DV_GET_KIND[method]}, i1 ${args[1]?.name ?? "false"}`,
          false,
          true,
        );
      case "dvSetUint8":
      case "dvSetInt8":
      case "dvSetUint16":
      case "dvSetInt16":
      case "dvSetUint32":
      case "dvSetInt32":
      case "dvSetFloat32":
      case "dvSetFloat64":
        // DataView setters: [offset, value, littleEndian?] — void; throw
        // the getters' constant RangeError on a bad offset.
        return call(
          "scr_dataview_set",
          "void (ptr, double, double, i32, i1 zeroext)",
          `ptr ${r.name}, double ${args[0]!.name}, double ${args[1]!.name}, ` +
            `i32 ${DV_SET_KIND[method]}, i1 ${args[2]?.name ?? "false"}`,
          false,
          true,
        );
      default: {
        const _exhaustive: never = method;
        void _exhaustive;
        throw new InternalCompilerError("unreachable");
      }
    }
  }
