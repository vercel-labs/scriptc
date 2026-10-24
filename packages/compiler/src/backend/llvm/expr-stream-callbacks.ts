/* Focused LLVM expression emission extracted from emitter.ts. */
import { InternalCompilerError } from "../../errors.js";
import { type IrType, isRefCounted, typeKey } from "../../ir/ir.js";
import { FN_ATTRS, releaseSym, retainSym, traceArg } from "./shapes.js";
import type { LlvmEmitterContext } from "./expr-context.js";
import { unionPeekLines, unionTagLines } from "./union-repr.js";
import { registerReplay } from "./emit-journal.js";

export function streamDataAdapter(
  host: LlvmEmitterContext,
  cbT: IrType & { kind: "func" },
): string {
  const key = `eed:${typeKey(cbT)}`;
  let sym = host.resolveThunks.get(key);
  if (sym) return sym;
  sym = host.contentSymbol("sc_ee_dad_", key);
  host.resolveThunks.set(key, sym);
  host.journal?.allocated(sym, "streamDataAdapter", [cbT]);
  const p = cbT.params[0];
  if (cbT.params.length > 1) {
    throw new InternalCompilerError(
      "llvm emitter bug: stream data listener param shape (frontend must fence)",
    );
  }
  // A `Buffer | string` union wraps the filled slot; any other union (or
  // other type) converts from the chunk's checked-dynamic value.
  const bytesOrString =
    p?.kind === "union" &&
    (() => {
      const def = host.unionsById.get(p.unionId);
      return (
        def !== undefined &&
        !host.nullableUnions.has(p.unionId) &&
        def.arms.length === 2 &&
        def.arms.some((a) => a.kind === "bytes" && a.elem === "u8") &&
        def.arms.some((a) => a.kind === "string")
      );
    })();
  host.declare(`declare ptr @scr_box_get_ref(ptr)`);
  host.declare(`declare void @scr_closure_release(ptr)`);
  // The emit ABI's three slots (scr_stream_emit_data): the bytes chunk,
  // the string chunk, and an object-mode entry's value.
  const d: string[] = [
    `define internal void @${sym}(ptr %cb, ptr %a0, ptr %a1, ptr %a2) ${FN_ATTRS} { ; stream 'data' adapter ${typeKey(cbT)}`,
    `entry:`,
    `  %capsp = getelementptr inbounds %ScrClosure, ptr %cb, i64 1`,
    `  %bx = load ptr, ptr %capsp`,
    `  %orig = call ptr @scr_box_get_ref(ptr %bx) ; the listener, +1`,
  ];
  const finishTyped = (arg: string, argTy: string): void => {
    d.push(
      `  %fnp = getelementptr inbounds %ScrClosure, ptr %orig, i64 0, i32 1`,
      `  %fn = load ptr, ptr %fnp`,
    );
    const retTy = host.llType(cbT.ret);
    const argList = `ptr %orig, ${argTy} ${arg}`;
    if (retTy === "void") {
      d.push(`  call void %fn(${argList})`);
    } else {
      d.push(`  %ret = call ${retTy} %fn(${argList})`);
      if (isRefCounted(cbT.ret)) {
        d.push(
          `  call void ${releaseSym(host.shapeHost, cbT.ret)}(ptr %ret) ; discarded listener result`,
        );
      }
    }
    d.push(`  call void @scr_closure_release(ptr %orig)`, `  ret void`);
  };
  const finish = (arg: string | null): void => {
    d.push(
      `  %fnp = getelementptr inbounds %ScrClosure, ptr %orig, i64 0, i32 1`,
      `  %fn = load ptr, ptr %fnp`,
    );
    const retTy = host.llType(cbT.ret);
    const argList = arg === null ? `ptr %orig` : `ptr %orig, ptr ${arg}`;
    if (retTy === "void") {
      d.push(`  call void %fn(${argList})`);
    } else {
      d.push(`  %ret = call ${retTy} %fn(${argList})`);
      if (isRefCounted(cbT.ret)) {
        d.push(
          `  call void ${releaseSym(host.shapeHost, cbT.ret)}(ptr %ret) ; discarded listener result`,
        );
      }
    }
    d.push(`  call void @scr_closure_release(ptr %orig)`, `  ret void`);
  };
  if (p === undefined) {
    finish(null);
    d.push(`}`, ``);
  } else if (p.kind === "bytes" || p.kind === "string") {
    const msg =
      p.kind === "bytes"
        ? "a 'data' listener declaring a Buffer chunk received a string or an object-mode value (the stream has an encoding set, or is in object mode)"
        : "a 'data' listener declaring a string chunk received a Buffer or an object-mode value (call setEncoding, or declare the chunk's type)";
    const slot = p.kind === "bytes" ? "%a0" : "%a1";
    host.declare(`declare void @scr_throw_error_msg(i32, ptr, ${host.sizeType})`);
    d.push(
      `  %miss = icmp eq ptr ${slot}, null`,
      `  br i1 %miss, label %bad, label %ok`,
      `bad:`,
      `  call void @scr_throw_error_msg(i32 1, ptr ${host.cstr(msg)}, ${host.sizeType} ${Buffer.byteLength(msg, "utf8")})`,
      `  call void @scr_closure_release(ptr %orig)`,
      `  ret void`,
      `ok:`,
      `  %r0 = call ptr ${retainSym(host.shapeHost, p)}(ptr ${slot})`,
    );
    finish("%r0");
    d.push(`}`, ``);
  } else if (p.kind === "union" && bytesOrString) {
    // A `Buffer | string` chunk: wrap whichever slot the stream filled at
    // its arm of the (boxed) union.
    const def = host.unionsById.get(p.unionId);
    const bytesTag = def ? def.arms.findIndex((a) => a.kind === "bytes" && a.elem === "u8") : -1;
    const strTag = def ? def.arms.findIndex((a) => a.kind === "string") : -1;
    if (
      !def ||
      host.nullableUnions.has(p.unionId) ||
      bytesTag < 0 ||
      strTag < 0 ||
      def.arms.length !== 2
    )
      throw new InternalCompilerError(
        "llvm emitter bug: stream data listener union is not Buffer | string (frontend must fence)",
      );
    host.declare(`declare ptr @scr_union_new_ref(i32, ptr, ptr, ptr, ptr)`);
    host.declare(`declare ptr @scr_bytes_retain_v(ptr)`);
    host.declare(`declare void @scr_bytes_release_v(ptr)`);
    host.declare(`declare ptr @scr_str_retain_v(ptr)`);
    host.declare(`declare void @scr_str_release_v(ptr)`);
    host.declare(`declare void @scr_throw_error_msg(i32, ptr, ${host.sizeType})`);
    const unionMsg =
      "a 'data' listener declaring a Buffer | string chunk received an object-mode value that is neither (declare the chunk's type)";
    d.push(
      `  %uslot = alloca ptr`,
      `  %isb = icmp ne ptr %a0, null`,
      `  br i1 %isb, label %buf, label %str`,
      `buf:`,
      `  %rb = call ptr @scr_bytes_retain_v(ptr %a0)`,
      `  %ub = call ptr @scr_union_new_ref(i32 ${bytesTag}, ptr %rb, ptr @scr_bytes_retain_v, ptr @scr_bytes_release_v, ptr null)`,
      `  store ptr %ub, ptr %uslot`,
      `  br label %go`,
      `str:`,
      // an object-mode value that is neither: the catchable error the
      // one-type adapters throw
      `  %nos = icmp eq ptr %a1, null`,
      `  br i1 %nos, label %bad, label %strok`,
      `bad:`,
      `  call void @scr_throw_error_msg(i32 1, ptr ${host.cstr(unionMsg)}, ${host.sizeType} ${Buffer.byteLength(unionMsg, "utf8")})`,
      `  call void @scr_closure_release(ptr %orig)`,
      `  ret void`,
      `strok:`,
      `  %rs = call ptr @scr_str_retain_v(ptr %a1)`,
      `  %us = call ptr @scr_union_new_ref(i32 ${strTag}, ptr %rs, ptr @scr_str_retain_v, ptr @scr_str_release_v, ptr null)`,
      `  store ptr %us, ptr %uslot`,
      `  br label %go`,
      `go:`,
      `  %uv = load ptr, ptr %uslot`,
    );
    finish("%uv");
    d.push(`}`, ``);
  } else {
    // dyn: the object-mode value, else box by runtime tag — the JS lane's
    // adapter parameter. Any other type converts from that value.
    host.declare(`declare ptr @scr_dyn_new_buffer(ptr)`);
    host.declare(`declare ptr @scr_dyn_new_str(ptr)`);
    host.declare(`declare ptr @scr_dyn_retain_v(ptr)`);
    d.push(
      `  %dslot = alloca ptr`,
      `  %isv = icmp ne ptr %a2, null`,
      `  br i1 %isv, label %val, label %chunk`,
      `val:`,
      `  %dvv = call ptr @scr_dyn_retain_v(ptr %a2)`,
      `  store ptr %dvv, ptr %dslot`,
      `  br label %go`,
      `chunk:`,
      `  %isb = icmp ne ptr %a0, null`,
      `  br i1 %isb, label %buf, label %str`,
      `buf:`,
      `  %db = call ptr @scr_dyn_new_buffer(ptr %a0)`,
      `  store ptr %db, ptr %dslot`,
      `  br label %go`,
      `str:`,
      `  %ds = call ptr @scr_dyn_new_str(ptr %a1)`,
      `  store ptr %ds, ptr %dslot`,
      `  br label %go`,
      `go:`,
      `  %dv = load ptr, ptr %dslot`,
    );
    if (p.kind === "dyn") {
      finish("%dv");
    } else {
      const helper = host.dyn.dynCheckHelper(p, false);
      const ty = host.llType(p);
      host.declare(`declare void @scr_dyn_release(ptr)`);
      host.declare(`declare zeroext i1 @scr_exc_pending()`);
      d.push(
        `  %tv = call ${ty === "i1" ? "zeroext i1" : ty} @${helper}(ptr %dv, ptr null)`,
        `  call void @scr_dyn_release(ptr %dv)`,
        `  %pend = call zeroext i1 @scr_exc_pending()`,
        `  br i1 %pend, label %fail, label %conv`,
        `fail:`,
        `  call void @scr_closure_release(ptr %orig)`,
        `  ret void`,
        `conv:`,
      );
      finishTyped("%tv", ty);
    }
    d.push(`}`, ``);
  }
  host.resolveThunkDefs.push(...d);
  host.journal?.built();
  return sym;
}

export function streamDoneFnFor(
  host: LlvmEmitterContext,
  kind: "w" | "f" | "d" | "t" | "l" | "c",
  doneT: IrType & { kind: "func" },
): string {
  const key = `sd:${kind}:${typeKey(doneT)}`;
  let sym = host.resolveThunks.get(key);
  if (sym) return sym;
  sym = host.contentSymbol("sc_sd_", key);
  host.resolveThunks.set(key, sym);
  host.journal?.allocated(sym, "streamDoneFnFor", [kind, doneT]);
  const errT = doneT.params[0];
  let errTag = -1;
  if (errT !== undefined) {
    if (errT.kind !== "union")
      throw new InternalCompilerError("llvm emitter bug: stream done err param not a union");
    const def = host.unionsById.get(errT.unionId);
    errTag = def ? def.arms.findIndex((a) => a.kind === "object") : -1;
    if (errTag < 0)
      throw new InternalCompilerError(
        "llvm emitter bug: stream done err union lacks its Error arm",
      );
  }
  const dataT = kind === "t" || kind === "l" ? doneT.params[1] : undefined;
  let bytesTag = -1;
  let strTag = -1;
  // data of any type other than a union of Buffer, string, undefined and
  // null (an object-mode Transform's value) completes through the
  // value entry points with the data boxed.
  let valueData = false;
  if (dataT !== undefined) {
    const def = dataT.kind === "union" ? host.unionsById.get(dataT.unionId) : undefined;
    valueData =
      def === undefined ||
      !def.arms.every(
        (a) =>
          (a.kind === "bytes" && a.elem === "u8") ||
          a.kind === "string" ||
          a.kind === "undefinedT" ||
          a.kind === "nullT",
      );
    if (!valueData) {
      bytesTag = def!.arms.findIndex((a) => a.kind === "bytes");
      strTag = def!.arms.findIndex((a) => a.kind === "string");
    }
  }
  const entry =
    kind === "c"
      ? "scr_stream_construct_done"
      : kind === "w"
        ? "scr_stream_write_done"
        : kind === "f"
          ? "scr_stream_final_done"
          : kind === "d"
            ? "scr_stream_destroy_done"
            : kind === "t"
              ? valueData
                ? "scr_stream_transform_done_value"
                : "scr_stream_transform_done"
              : valueData
                ? "scr_stream_flush_done_value"
                : "scr_stream_flush_done";
  const twoSlot = (kind === "t" || kind === "l") && !valueData;
  host.declare(
    `declare void @${entry}(ptr, ptr${twoSlot ? ", ptr, ptr" : valueData ? ", ptr" : ""})`,
  );
  host.declare(`declare ptr @scr_box_get_ref(ptr)`);
  host.declare(`declare void @scr_stream_release_v(ptr)`);
  host.declare(`declare ptr @scr_error_retain_v(ptr)`);
  host.declare(`declare void @scr_union_release(ptr)`);
  const params = [
    "ptr %self",
    ...(errT !== undefined ? ["ptr %e"] : []),
    ...(dataT !== undefined ? [`${host.llType(dataT)} %d`] : []),
  ];
  const d: string[] = [
    `define internal void @${sym}(${params.join(", ")}) ${FN_ATTRS} { ; stream '${kind}' done ${typeKey(doneT)}`,
    `entry:`,
    `  %eslot = alloca ptr`,
    ...(twoSlot ? [`  %bslot = alloca ptr`, `  %sslot = alloca ptr`] : []),
    `  %capsp = getelementptr inbounds %ScrClosure, ptr %self, i64 1`,
    `  %bx = load ptr, ptr %capsp`,
    `  %s = call ptr @scr_box_get_ref(ptr %bx) ; the stream, +1`,
    `  store ptr null, ptr %eslot`,
    ...(twoSlot ? [`  store ptr null, ptr %bslot`, `  store ptr null, ptr %sslot`] : []),
  ];
  // A tag-guarded retained peek out of a union argument into a slot.
  let arm = 0;
  const unwrap = (u: string, tag: number, retain: string, slot: string): void => {
    const a = arm++;
    const union = u === "%e" ? errT : dataT;
    const nullable = union?.kind === "union" ? host.nullableUnions.get(union.unionId) : null;
    d.push(
      `  %un${a} = icmp ne ptr ${u}, null`,
      `  br i1 %un${a}, label %chk${a}, label %done${a}`,
      `chk${a}:`,
      ...unionTagLines(nullable, u, `%tg${a}`),
      `  %hit${a} = icmp eq i32 %tg${a}, ${tag}`,
      `  br i1 %hit${a}, label %yes${a}, label %done${a}`,
      `yes${a}:`,
      ...unionPeekLines(nullable, u, `%pv${a}`),
      `  %rt${a} = call ptr ${retain}(ptr %pv${a})`,
      `  store ptr %rt${a}, ptr ${slot}`,
      `  br label %done${a}`,
      `done${a}:`,
    );
  };
  if (errT !== undefined) unwrap("%e", errTag, "@scr_error_retain_v", "%eslot");
  if (dataT !== undefined && bytesTag >= 0) {
    host.declare(`declare ptr @scr_bytes_retain_v(ptr)`);
    unwrap("%d", bytesTag, "@scr_bytes_retain_v", "%bslot");
  }
  if (dataT !== undefined && strTag >= 0) {
    host.declare(`declare ptr @scr_str_retain_v(ptr)`);
    unwrap("%d", strTag, "@scr_str_retain_v", "%sslot");
  }
  d.push(`  %ev = load ptr, ptr %eslot`);
  if (valueData) {
    const conv = host.dyn.toDynHelper(dataT!);
    host.declare(`declare void @scr_dyn_release(ptr)`);
    d.push(
      `  %dv = call ptr @${conv}(${host.llType(dataT!)} %d)`,
      `  call void @${entry}(ptr %s, ptr %ev, ptr %dv) ; moves err; borrows s and the value`,
      `  call void @scr_dyn_release(ptr %dv)`,
    );
  } else if (twoSlot) {
    d.push(
      `  %bv = load ptr, ptr %bslot`,
      `  %sv = load ptr, ptr %sslot`,
      `  call void @${entry}(ptr %s, ptr %ev, ptr %bv, ptr %sv) ; moves err/data; borrows s`,
    );
  } else {
    d.push(`  call void @${entry}(ptr %s, ptr %ev) ; moves err; borrows s`);
  }
  d.push(`  call void @scr_stream_release_v(ptr %s)`);
  if (errT !== undefined) d.push(`  call void ${releaseSym(host.shapeHost, errT)}(ptr %e)`);
  if (dataT !== undefined && isRefCounted(dataT))
    d.push(`  call void ${releaseSym(host.shapeHost, dataT)}(ptr %d)`);
  d.push(`  ret void`, `}`, ``);
  host.resolveThunkDefs.push(...d);
  host.journal?.built();
  return sym;
}

export function fsRenameThunkFor(host: LlvmEmitterContext, cbT: IrType & { kind: "func" }): string {
  if (cbT.params.length === 0) {
    host.declare(`declare void @scr_fs_rename_thunk0(ptr, ptr)`);
    return "scr_fs_rename_thunk0";
  }
  const key = `fsren:${typeKey(cbT)}`;
  let sym = host.resolveThunks.get(key);
  if (sym) return sym;
  sym = host.contentSymbol("sc_fsren_", key);
  host.resolveThunks.set(key, sym);
  host.journal?.allocated(sym, "fsRenameThunkFor", [cbT]);
  const param = cbT.params[0]!;
  const d: string[] = [
    `define internal void @${sym}(ptr %cb, ptr %err) ${FN_ATTRS} { ; fs.rename callback ${typeKey(cbT)}`,
    `entry:`,
    `  %slot = alloca ptr`,
    `  %has = icmp ne ptr %err, null`,
    `  br i1 %has, label %yes, label %no`,
    `yes:`,
  ];
  if (param.kind === "dyn") {
    host.declare(`declare ptr @scr_dyn_from_error(ptr)`);
    host.declare(`declare ptr @scr_dyn_new_null()`);
    d.push(
      `  %de = call ptr @scr_dyn_from_error(ptr %err)`,
      `  store ptr %de, ptr %slot`,
      `  br label %go`,
      `no:`,
      `  %dn = call ptr @scr_dyn_new_null()`,
      `  store ptr %dn, ptr %slot`,
    );
  } else {
    if (param.kind !== "union")
      throw new InternalCompilerError("llvm emitter bug: fs.rename error param not a union");
    const def = host.unionsById.get(param.unionId);
    const errTag = def
      ? def.arms.findIndex((a) => a.kind === "object" && a.className === "%Error")
      : -1;
    const nullTag = def ? def.arms.findIndex((a) => a.kind === "nullT") : -1;
    if (errTag < 0 || nullTag < 0)
      throw new InternalCompilerError("llvm emitter bug: fs.rename error union lacks its arms");
    host.declare(`declare ptr @scr_error_retain(ptr)`);
    host.declare(`declare ptr @scr_error_retain_v(ptr)`);
    host.declare(`declare void @scr_error_release_v(ptr)`);
    host.declare(`declare ptr @scr_union_new_ref(i32, ptr, ptr, ptr, ptr)`);
    d.push(
      `  %er = call ptr @scr_error_retain(ptr %err)`,
      `  %eu = call ptr @scr_union_new_ref(i32 ${errTag}, ptr %er, ptr @scr_error_retain_v, ptr @scr_error_release_v, ptr null)`,
      `  store ptr %eu, ptr %slot`,
      `  br label %go`,
      `no:`,
      `  store ptr ${host.unitInstanceRef(param.unionId, nullTag)}, ptr %slot`,
    );
  }
  d.push(
    `  br label %go`,
    `go:`,
    `  %arg = load ptr, ptr %slot`,
    `  %fnp = getelementptr inbounds %ScrClosure, ptr %cb, i64 0, i32 1`,
    `  %fn = load ptr, ptr %fnp`,
    `  call void %fn(ptr %cb, ptr %arg)`,
    `  ret void`,
    `}`,
    ``,
  );
  host.resolveThunkDefs.push(...d);
  host.journal?.built();
  return sym;
}

/** How a bytes-callback adapter hands over its value: "buffer" boxes a
 * u8 value as a Buffer for a dyn parameter, "view" passes a view of any
 * element kind and keeps its own brand when boxed, and "dyn" receives a
 * dyn value in the value slot and passes it unchanged. */
export type BytesThunkValue = "buffer" | "view" | "dyn";

export function cryptoBytesThunkFor(
  host: LlvmEmitterContext,
  cbT: IrType & { kind: "func" },
  arrayBuffer = false,
  valueMode: BytesThunkValue = "buffer",
): string {
  return zlibBytesThunkFor(host, cbT, arrayBuffer, "crypto", valueMode);
}

/** randomInt's callback adapter: (cb, value). Node passes undefined as the
 * error, which a parameter typed Error | null without an undefined arm
 * receives as null. */
export function cryptoIntThunkFor(
  host: LlvmEmitterContext,
  cbT: IrType & { kind: "func" },
): string {
  if (cbT.params.length > 2)
    throw new InternalCompilerError("llvm emitter bug: randomInt callback arity");
  const key = `cryptoint:${typeKey(cbT)}`;
  let sym = host.resolveThunks.get(key);
  if (sym) return sym;
  sym = host.contentSymbol("sc_cryptoint_", key);
  host.resolveThunks.set(key, sym);
  host.journal?.allocated(sym, "cryptoIntThunkFor", [cbT]);
  const d: string[] = [
    `define internal void @${sym}(ptr %cb, double %value) ${FN_ATTRS} { ; randomInt callback ${typeKey(cbT)}`,
    `entry:`,
  ];
  const passed = ["ptr %cb"];
  const error = cbT.params[0];
  if (error !== undefined) {
    if (error.kind === "dyn") {
      host.declare(`declare ptr @scr_dyn_undefined()`);
      d.push(`  %error = call ptr @scr_dyn_undefined()`);
      passed.push("ptr %error");
    } else if (error.kind === "union") {
      const def = host.unionsById.get(error.unionId);
      const undefinedTag = def ? def.arms.findIndex((arm) => arm.kind === "undefinedT") : -1;
      const nullTag = def ? def.arms.findIndex((arm) => arm.kind === "nullT") : -1;
      const tag = undefinedTag >= 0 ? undefinedTag : nullTag;
      if (tag < 0)
        throw new InternalCompilerError("llvm emitter bug: randomInt callback error union");
      passed.push(`ptr ${host.unitInstanceRef(error.unionId, tag)}`);
    } else {
      throw new InternalCompilerError("llvm emitter bug: randomInt callback error param");
    }
  }
  const value = cbT.params[1];
  if (value?.kind === "f64") {
    passed.push("double %value");
  } else if (value?.kind === "dyn") {
    host.declare(`declare ptr @scr_dyn_new_num(double)`);
    d.push(`  %boxed = call ptr @scr_dyn_new_num(double %value)`);
    passed.push("ptr %boxed");
  } else if (value !== undefined) {
    throw new InternalCompilerError("llvm emitter bug: randomInt callback value param");
  }
  d.push(
    `  %fnp = getelementptr inbounds %ScrClosure, ptr %cb, i64 0, i32 1`,
    `  %fn = load ptr, ptr %fnp`,
    `  call void %fn(${passed.join(", ")})`,
    `  ret void`,
    `}`,
    ``,
  );
  host.resolveThunkDefs.push(...d);
  host.journal?.built();
  return sym;
}

export function zlibBytesThunkFor(
  host: LlvmEmitterContext,
  cbT: IrType & { kind: "func" },
  arrayBuffer = false,
  family = "zlib",
  valueMode: BytesThunkValue = "buffer",
): string {
  if (cbT.params.length > 2)
    throw new InternalCompilerError("llvm emitter bug: zlib callback arity");
  const mode = valueMode === "buffer" ? "" : `${valueMode}:`;
  const key = `${family}bytes:${arrayBuffer ? "arraybuffer:" : ""}${mode}${typeKey(cbT)}`;
  let sym = host.resolveThunks.get(key);
  if (sym) return sym;
  sym = host.contentSymbol(`sc_${family}bytes_`, key);
  host.resolveThunks.set(key, sym);
  host.journal?.allocated(sym, "zlibBytesThunkFor", [cbT, arrayBuffer, family, valueMode]);
  const d: string[] = [
    `define internal void @${sym}(ptr %cb, ptr %err, ptr %value) ${FN_ATTRS} { ; zlib bytes callback ${typeKey(cbT)}`,
    `entry:`,
  ];
  const passed = ["ptr %cb"];
  const error = cbT.params[0];
  if (error !== undefined) {
    d.push(
      `  %eslot = alloca ptr`,
      `  %haserr = icmp ne ptr %err, null`,
      `  br i1 %haserr, label %err_yes, label %err_no`,
      `err_yes:`,
    );
    if (error.kind === "dyn") {
      host.declare(`declare ptr @scr_dyn_from_error(ptr)`);
      d.push(`  %de = call ptr @scr_dyn_from_error(ptr %err)`, `  store ptr %de, ptr %eslot`);
    } else if (error.kind === "union") {
      const def = host.unionsById.get(error.unionId);
      const errTag = def
        ? def.arms.findIndex((arm) => arm.kind === "object" && arm.className === "%Error")
        : -1;
      const nullTag = def ? def.arms.findIndex((arm) => arm.kind === "nullT") : -1;
      if (errTag < 0 || nullTag < 0)
        throw new InternalCompilerError("llvm emitter bug: zlib callback error union lacks arms");
      host.declare(`declare ptr @scr_error_retain(ptr)`);
      host.declare(`declare ptr @scr_error_retain_v(ptr)`);
      host.declare(`declare void @scr_error_release_v(ptr)`);
      host.declare(`declare ptr @scr_union_new_ref(i32, ptr, ptr, ptr, ptr)`);
      d.push(
        `  %er = call ptr @scr_error_retain(ptr %err)`,
        `  %eu = call ptr @scr_union_new_ref(i32 ${errTag}, ptr %er, ptr @scr_error_retain_v, ptr @scr_error_release_v, ptr null)`,
        `  store ptr %eu, ptr %eslot`,
      );
    } else {
      throw new InternalCompilerError("llvm emitter bug: zlib callback error param");
    }
    d.push(`  br label %err_go`, `err_no:`);
    if (error.kind === "dyn") {
      host.declare(`declare ptr @scr_dyn_new_null()`);
      d.push(`  %dn = call ptr @scr_dyn_new_null()`, `  store ptr %dn, ptr %eslot`);
    } else {
      d.push(
        `  store ptr ${host.unitInstanceRef(
          error.unionId,
          host.unionsById.get(error.unionId)!.arms.findIndex((arm) => arm.kind === "nullT"),
        )}, ptr %eslot`,
      );
    }
    d.push(`  br label %err_go`, `err_go:`, `  %error = load ptr, ptr %eslot`);
    passed.push("ptr %error");
  }
  const value = cbT.params[1];
  if (valueMode === "dyn") {
    if (value === undefined) {
      host.declare(`declare void @scr_dyn_release(ptr)`);
      d.push(`  call void @scr_dyn_release(ptr %value)`);
    } else if (value.kind === "dyn") {
      passed.push("ptr %value");
    } else {
      throw new InternalCompilerError("llvm emitter bug: dyn-valued callback param");
    }
  } else if (value === undefined) {
    host.declare(`declare void @scr_bytes_release(ptr)`);
    d.push(`  call void @scr_bytes_release(ptr %value)`);
  } else if (value.kind === "dyn" && valueMode === "view") {
    host.declare(`declare ptr @scr_dyn_new_bytes(ptr)`);
    host.declare(`declare void @scr_bytes_release(ptr)`);
    d.push(
      `  %boxed = call ptr @scr_dyn_new_bytes(ptr %value)`,
      `  call void @scr_bytes_release(ptr %value)`,
    );
    passed.push("ptr %boxed");
  } else if (value.kind === "bytes" && valueMode === "view") {
    passed.push("ptr %value");
  } else if (value.kind === "dyn") {
    host.declare(
      `declare ptr @${arrayBuffer ? "scr_array_buffer_from_bytes" : "scr_dyn_new_buffer"}(ptr)`,
    );
    host.declare(`declare ptr @scr_dyn_undefined()`);
    host.declare(`declare void @scr_bytes_release(ptr)`);
    d.push(
      `  %rslot = alloca ptr`,
      `  %hasvalue = icmp ne ptr %value, null`,
      `  br i1 %hasvalue, label %value_yes, label %value_no`,
      `value_yes:`,
      `  %db = call ptr @${arrayBuffer ? "scr_array_buffer_from_bytes" : "scr_dyn_new_buffer"}(ptr %value)`,
      `  call void @scr_bytes_release(ptr %value)`,
      `  store ptr %db, ptr %rslot`,
      `  br label %value_go`,
      `value_no:`,
      `  %du = call ptr @scr_dyn_undefined()`,
      `  store ptr %du, ptr %rslot`,
      `  br label %value_go`,
      `value_go:`,
      `  %result = load ptr, ptr %rslot`,
    );
    passed.push("ptr %result");
  } else if (value.kind === "bytes" && value.elem === "u8") {
    passed.push("ptr %value");
  } else {
    throw new InternalCompilerError("llvm emitter bug: zlib callback value param");
  }
  d.push(
    `  %fnp = getelementptr inbounds %ScrClosure, ptr %cb, i64 0, i32 1`,
    `  %fn = load ptr, ptr %fnp`,
    `  call void %fn(${passed.join(", ")})`,
    `  ret void`,
    `}`,
    ``,
  );
  host.resolveThunkDefs.push(...d);
  host.journal?.built();
  return sym;
}

export function streamCbThunkFor(
  host: LlvmEmitterContext,
  kind: "r" | "w" | "f" | "d" | "t" | "l" | "e" | "c" | "v",
  cbT: IrType,
): string {
  if (cbT.kind !== "func")
    throw new InternalCompilerError("llvm emitter bug: stream option callback not a func");
  const key = `scb:${kind}:${typeKey(cbT)}`;
  let sym = host.resolveThunks.get(key);
  if (sym) return sym;
  sym = host.contentSymbol("sc_scb_", key);
  host.resolveThunks.set(key, sym);
  host.journal?.allocated(sym, "streamCbThunkFor", [kind, cbT]);
  const runtimeParams =
    kind === "r"
      ? ["ptr %s", "double %size"]
      : kind === "w" || kind === "t"
        ? ["ptr %s", "ptr %chunk"]
        : kind === "v"
          ? ["ptr %s", "ptr %chunks"]
          : kind === "d" || kind === "e"
            ? ["ptr %s", "ptr %err"]
            : ["ptr %s"];
  const declared = cbT.params;
  const hasThis = declared[0] !== undefined && declared[0].kind === "object";
  if (declared.length === 0) {
    throw new InternalCompilerError(
      "llvm emitter bug: stream option callback with no params (frontend must fence)",
    );
  }
  const off = hasThis ? 1 : 0;
  const full =
    (kind === "r" ? 1 : kind === "w" || kind === "t" ? 3 : kind === "d" || kind === "v" ? 2 : 1) +
    off;
  if (declared.length > full) {
    throw new InternalCompilerError(
      `llvm emitter bug: stream '${kind}' callback declares ${declared.length} params (frontend must fence)`,
    );
  }
  const d: string[] = [
    `define internal void @${sym}(ptr %cb, ${runtimeParams.join(", ")}) ${FN_ATTRS} { ; stream '${kind}' option callback ${typeKey(cbT)}`,
    `entry:`,
  ];
  const passed: string[] = ["ptr %cb"];
  if (hasThis) {
    host.declare(`declare ptr @scr_stream_retain_v(ptr)`);
    d.push(`  %sr = call ptr @scr_stream_retain_v(ptr %s)`);
    passed.push(`ptr %sr`);
  }
  // The stream-owning completion closure (a 1-cap closure boxing the
  // retained stream) — shared by the typed and dyn done shapes.
  const doneClosure = (fnRef: string, tag: string): string => {
    host.declare(`declare ptr @scr_closure_new(ptr, ${host.sizeType})`);
    host.declare(`declare ptr @scr_box_new_obj(ptr, ptr, ptr)`);
    host.declare(`declare void @scr_box_set_ref(ptr, ptr)`);
    host.declare(`declare ptr @scr_stream_retain_v(ptr)`);
    host.declare(`declare void @scr_stream_release_v(ptr)`);
    host.declare(`declare void @scr_stream_trace(ptr, ptr, ptr)`);
    d.push(
      `  %${tag}clo = call ptr @scr_closure_new(ptr ${fnRef}, ${host.sizeType} 1)`,
      `  %${tag}bx = call ptr @scr_box_new_obj(ptr @scr_stream_retain_v, ptr @scr_stream_release_v, ptr @scr_stream_trace)`,
      `  %${tag}cp = getelementptr inbounds %ScrClosure, ptr %${tag}clo, i64 1`,
      `  store ptr %${tag}bx, ptr %${tag}cp`,
      `  %${tag}sr = call ptr @scr_stream_retain_v(ptr %s)`,
      `  call void @scr_box_set_ref(ptr %${tag}bx, ptr %${tag}sr)`,
    );
    return `%${tag}clo`;
  };
  for (let i = off; i < declared.length; i++) {
    const p = declared[i]!;
    const pos = i - off;
    if (kind === "r") {
      if (p.kind === "dyn") {
        host.declare(`declare ptr @scr_dyn_new_num(double)`);
        d.push(`  %dn${i} = call ptr @scr_dyn_new_num(double %size)`);
        passed.push(`ptr %dn${i}`);
      } else {
        passed.push(`double %size`);
      }
      continue;
    }
    if (kind === "v" && pos === 0) {
      // writev's chunks: the batch array (borrowed from the runtime), as
      // a dyn value or converted to the declared type
      if (p.kind === "dyn") {
        host.declare(`declare ptr @scr_dyn_retain_v(ptr)`);
        d.push(`  %vc${i} = call ptr @scr_dyn_retain_v(ptr %chunks)`);
        passed.push(`ptr %vc${i}`);
      } else {
        const helper = host.dyn.dynCheckHelper(p, false);
        const ty = host.llType(p);
        host.declare(`declare zeroext i1 @scr_exc_pending()`);
        if (hasThis) host.declare(`declare void @scr_stream_release_v(ptr)`);
        // An entry `encoding` declared as a string (the declarations'
        // `encoding: string`) receives "" where Node passes undefined or
        // null (an object-mode write), as a write's encoding parameter does.
        const entry =
          p.kind === "array" && p.elem.kind === "record"
            ? host.recordsById.get(p.elem.shapeId)
            : undefined;
        if (entry?.fields.some((f) => f.name === "encoding" && f.type.kind === "string")) {
          host.declare(`declare void @scr_stream_writev_fill_encodings(ptr)`);
          d.push(`  call void @scr_stream_writev_fill_encodings(ptr %chunks)`);
        }
        d.push(
          `  %vt${i} = call ${ty === "i1" ? "zeroext i1" : ty} @${helper}(ptr %chunks, ptr null)`,
          `  %vtbad${i} = call zeroext i1 @scr_exc_pending()`,
          `  br i1 %vtbad${i}, label %vtfail${i}, label %vtok${i}`,
          `vtfail${i}:`,
          ...(hasThis ? [`  call void @scr_stream_release_v(ptr %sr)`] : []),
          `  ret void`,
          `vtok${i}:`,
        );
        passed.push(`${ty} %vt${i}`);
      }
      continue;
    }
    const isChunkPos = (kind === "w" || kind === "t") && pos === 0;
    const isEncPos = (kind === "w" || kind === "t") && pos === 1;
    const isErrPos = (kind === "d" || kind === "e") && pos === 0;
    const isDonePos =
      kind === "e"
        ? false
        : kind === "w" || kind === "t"
          ? pos === 2
          : kind === "f" || kind === "l" || kind === "c"
            ? pos === 0
            : pos === 1;
    if (p.kind === "dyn") {
      if (isChunkPos) {
        // the chunk's value: a Buffer, or an object-mode side's value
        host.declare(`declare ptr @scr_stream_chunk_value(ptr, ptr)`);
        d.push(`  %dc${i} = call ptr @scr_stream_chunk_value(ptr %s, ptr %chunk)`);
        passed.push(`ptr %dc${i}`);
      } else if (isEncPos) {
        // 'buffer', or the encoding argument an object-mode write passed
        host.declare(`declare ptr @scr_stream_chunk_encoding_value(ptr)`);
        d.push(`  %ed${i} = call ptr @scr_stream_chunk_encoding_value(ptr %s)`);
        passed.push(`ptr %ed${i}`);
      } else if (isErrPos) {
        // finished/pipeline succeed with UNDEFINED (Node calls the eos
        // callback with no arguments); destroy passes null.
        host.declare(`declare ptr @scr_dyn_from_error(ptr)`);
        d.push(
          `  %edslot${i} = alloca ptr`,
          `  %ehas${i} = icmp ne ptr %err, null`,
          `  br i1 %ehas${i}, label %eyes${i}, label %eno${i}`,
          `eyes${i}:`,
          `  %ede${i} = call ptr @scr_dyn_from_error(ptr %err)`,
          `  store ptr %ede${i}, ptr %edslot${i}`,
          `  br label %ego${i}`,
          `eno${i}:`,
        );
        if (kind === "e") {
          host.declare(`declare ptr @scr_dyn_undefined()`);
          host.declare(`declare ptr @scr_dyn_retain_v(ptr)`);
          d.push(
            `  %eun${i} = call ptr @scr_dyn_undefined()`,
            `  %eur${i} = call ptr @scr_dyn_retain_v(ptr %eun${i})`,
            `  store ptr %eur${i}, ptr %edslot${i}`,
          );
        } else {
          host.declare(`declare ptr @scr_dyn_new_null()`);
          d.push(
            `  %enl${i} = call ptr @scr_dyn_new_null()`,
            `  store ptr %enl${i}, ptr %edslot${i}`,
          );
        }
        d.push(`  br label %ego${i}`, `ego${i}:`, `  %edv${i} = load ptr, ptr %edslot${i}`);
        passed.push(`ptr %edv${i}`);
      } else if (isDonePos) {
        const glue = `scr_stream_done_dyn_${kind === "v" ? "w" : kind}`;
        host.declare(`declare ptr @${glue}(ptr, ptr, ${host.sizeType})`);
        host.declare(`declare ptr @scr_dyn_new_func(ptr, ptr, i32, ptr, ptr)`);
        const clo = doneClosure(`@${glue}`, `dd${i}`);
        const arity = kind === "t" || kind === "l" ? 2 : 1;
        const sig = kind === "t" || kind === "l" ? "(error,data)" : "(error)";
        d.push(
          `  %ddn${i} = call ptr @scr_dyn_new_func(ptr ${clo}, ptr @${glue}, i32 ${arity}, ptr ${host.cstr(sig)}, ptr ${host.cstr("callback")})`,
        );
        passed.push(`ptr %ddn${i}`);
      } else {
        throw new InternalCompilerError(
          `llvm emitter bug: stream '${kind}' dyn callback param ${i} has no adapter`,
        );
      }
      continue;
    }
    if (isChunkPos && p.kind === "bytes") {
      // A Buffer, which an object-mode side's value must be (else a
      // TypeError, thrown out of the write).
      host.declare(`declare ptr @scr_stream_chunk_bytes(ptr, ptr)`);
      d.push(
        `  %rc${i} = call ptr @scr_stream_chunk_bytes(ptr %s, ptr %chunk)`,
        `  %rcbad${i} = icmp eq ptr %rc${i}, null`,
        `  br i1 %rcbad${i}, label %rcfail${i}, label %rcok${i}`,
        `rcfail${i}:`,
        ...(hasThis ? [`  call void @scr_stream_release_v(ptr %sr)`] : []),
        `  ret void`,
        `rcok${i}:`,
      );
      if (hasThis) host.declare(`declare void @scr_stream_release_v(ptr)`);
      passed.push(`ptr %rc${i}`);
    } else if (isChunkPos) {
      // Any other declared type converts from the chunk's value (an
      // object-mode side's value, or the Buffer), or throws out of the
      // write.
      const helper = host.dyn.dynCheckHelper(p, false);
      const ty = host.llType(p);
      host.declare(`declare ptr @scr_stream_chunk_value(ptr, ptr)`);
      host.declare(`declare void @scr_dyn_release(ptr)`);
      host.declare(`declare zeroext i1 @scr_exc_pending()`);
      if (hasThis) host.declare(`declare void @scr_stream_release_v(ptr)`);
      d.push(
        `  %cv${i} = call ptr @scr_stream_chunk_value(ptr %s, ptr %chunk)`,
        `  %ct${i} = call ${ty === "i1" ? "zeroext i1" : ty} @${helper}(ptr %cv${i}, ptr null)`,
        `  call void @scr_dyn_release(ptr %cv${i})`,
        `  %ctbad${i} = call zeroext i1 @scr_exc_pending()`,
        `  br i1 %ctbad${i}, label %ctfail${i}, label %ctok${i}`,
        `ctfail${i}:`,
        ...(hasThis ? [`  call void @scr_stream_release_v(ptr %sr)`] : []),
        `  ret void`,
        `ctok${i}:`,
      );
      passed.push(`${ty} %ct${i}`);
    } else if (isEncPos && p.kind === "string") {
      // Node's encoding for decoded (Buffer) chunks is 'buffer'; an
      // object-mode side passes the write's encoding argument ("" for
      // undefined and null).
      host.declare(`declare ptr @scr_stream_chunk_encoding(ptr)`);
      d.push(`  %en${i} = call ptr @scr_stream_chunk_encoding(ptr %s)`);
      passed.push(`ptr %en${i}`);
    } else if (isEncPos) {
      // Another declared type (string | null | undefined) converts from
      // the encoding argument's value.
      const helper = host.dyn.dynCheckHelper(p, false);
      const ty = host.llType(p);
      host.declare(`declare ptr @scr_stream_chunk_encoding_value(ptr)`);
      host.declare(`declare void @scr_dyn_release(ptr)`);
      host.declare(`declare zeroext i1 @scr_exc_pending()`);
      if (hasThis) host.declare(`declare void @scr_stream_release_v(ptr)`);
      d.push(
        `  %ev${i} = call ptr @scr_stream_chunk_encoding_value(ptr %s)`,
        `  %et${i} = call ${ty === "i1" ? "zeroext i1" : ty} @${helper}(ptr %ev${i}, ptr null)`,
        `  call void @scr_dyn_release(ptr %ev${i})`,
        `  %etbad${i} = call zeroext i1 @scr_exc_pending()`,
        `  br i1 %etbad${i}, label %etfail${i}, label %etok${i}`,
        `etfail${i}:`,
        ...(hasThis ? [`  call void @scr_stream_release_v(ptr %sr)`] : []),
        `  ret void`,
        `etok${i}:`,
      );
      passed.push(`${ty} %et${i}`);
    } else if (isErrPos) {
      // destroy's error argument: `Error | null` — wrap type-directedly.
      // The finished/pipeline callback ("e") may declare `Error | null |
      // undefined`; success prefers the undefined arm there.
      if (p.kind !== "union")
        throw new InternalCompilerError("llvm emitter bug: stream destroy err param not a union");
      const def = host.unionsById.get(p.unionId);
      const errTag = def ? def.arms.findIndex((a) => a.kind === "object") : -1;
      const undefTag =
        kind === "e" && def ? def.arms.findIndex((a) => a.kind === "undefinedT") : -1;
      const nullTag = def
        ? undefTag >= 0
          ? undefTag
          : def.arms.findIndex((a) => a.kind === "nullT")
        : -1;
      if (errTag < 0 || nullTag < 0)
        throw new InternalCompilerError(
          "llvm emitter bug: stream destroy err union lacks its arms",
        );
      host.declare(`declare ptr @scr_union_new_ref(i32, ptr, ptr, ptr, ptr)`);
      host.declare(`declare ptr @scr_error_retain_v(ptr)`);
      host.declare(`declare void @scr_error_release_v(ptr)`);
      d.push(
        `  %euslot${i} = alloca ptr`,
        `  %euh${i} = icmp ne ptr %err, null`,
        `  br i1 %euh${i}, label %euy${i}, label %eun${i}`,
        `euy${i}:`,
        `  %eur${i} = call ptr @scr_error_retain_v(ptr %err)`,
        `  %euu${i} = call ptr @scr_union_new_ref(i32 ${errTag}, ptr %eur${i}, ptr @scr_error_retain_v, ptr @scr_error_release_v, ptr ${traceArg(host.shapeHost, def!.arms[errTag]!)})`,
        `  store ptr %euu${i}, ptr %euslot${i}`,
        `  br label %eug${i}`,
        `eun${i}:`,
        `  store ptr ${host.unitInstanceRef(p.unionId, nullTag)}, ptr %euslot${i}`,
        `  br label %eug${i}`,
        `eug${i}:`,
        `  %euv${i} = load ptr, ptr %euslot${i}`,
      );
      passed.push(`ptr %euv${i}`);
    } else if (isDonePos) {
      // "e" has no done position; writev completes as a write
      const doneKind = (kind === "v" ? "w" : kind) as "w" | "f" | "d" | "t" | "l" | "c";
      if (p.kind !== "func")
        throw new InternalCompilerError("llvm emitter bug: stream done callback not a func");
      const doneFn = host.streamDoneFnFor(doneKind, p);
      const clo = doneClosure(`@${doneFn}`, `dn${i}`);
      passed.push(`ptr ${clo}`);
    } else {
      throw new InternalCompilerError(
        `llvm emitter bug: stream '${kind}' callback param ${i} has no adapter`,
      );
    }
  }
  d.push(
    `  %fnp = getelementptr inbounds %ScrClosure, ptr %cb, i64 0, i32 1`,
    `  %fn = load ptr, ptr %fnp`,
  );
  const retTy = host.llType(cbT.ret);
  if (retTy === "void") {
    d.push(`  call void %fn(${passed.join(", ")})`);
  } else {
    d.push(`  %ret = call ${retTy} %fn(${passed.join(", ")})`);
    if (isRefCounted(cbT.ret)) {
      d.push(
        `  call void ${releaseSym(host.shapeHost, cbT.ret)}(ptr %ret) ; discarded option-callback result`,
      );
    }
  }
  d.push(`  ret void`, `}`, ``);
  host.resolveThunkDefs.push(...d);
  host.journal?.built();
  return sym;
}

registerReplay("streamDataAdapter", (host, args) =>
  streamDataAdapter(host, args[0] as IrType & { kind: "func" }),
);
registerReplay("streamDoneFnFor", (host, args) =>
  streamDoneFnFor(
    host,
    args[0] as "w" | "f" | "d" | "t" | "l",
    args[1] as IrType & { kind: "func" },
  ),
);
registerReplay("fsRenameThunkFor", (host, args) =>
  fsRenameThunkFor(host, args[0] as IrType & { kind: "func" }),
);
registerReplay("cryptoIntThunkFor", (host, args) =>
  cryptoIntThunkFor(host, args[0] as IrType & { kind: "func" }),
);
registerReplay("zlibBytesThunkFor", (host, args) =>
  zlibBytesThunkFor(
    host,
    args[0] as IrType & { kind: "func" },
    args[1] as boolean,
    args[2] as string,
    args[3] as BytesThunkValue,
  ),
);
registerReplay("streamCbThunkFor", (host, args) =>
  streamCbThunkFor(host, args[0] as "r" | "w" | "f" | "d" | "t" | "l" | "e", args[1] as IrType),
);
