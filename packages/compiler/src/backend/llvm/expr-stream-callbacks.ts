/* Focused LLVM expression emission extracted from emitter.ts. */
import { InternalCompilerError } from "../../errors.js";
import { IrType, isRefCounted, typeKey } from "../../ir/ir.js";
import { FN_ATTRS, releaseSym, retainSym, traceArg } from "./shapes.js";
import type { LlvmEmitterContext } from "./expr-context.js";

export function streamDataAdapter(host: LlvmEmitterContext, cbT: IrType & { kind: "func" }): string {
    const key = `eed:${typeKey(cbT)}`;
    let sym = host.resolveThunks.get(key);
    if (sym) return sym;
    sym = `sc_ee_dad_${host.resolveThunks.size}`;
    host.resolveThunks.set(key, sym);
    const p = cbT.params[0];
    if (cbT.params.length > 1 || (p && p.kind !== "bytes" && p.kind !== "string" && p.kind !== "dyn")) {
      throw new InternalCompilerError("llvm emitter bug: stream data listener param shape (frontend must fence)");
    }
    host.declare(`declare ptr @scr_box_get_ref(ptr)`);
    host.declare(`declare void @scr_closure_release(ptr)`);
    const d: string[] = [
      `define internal void @${sym}(ptr %cb, ptr %a0, ptr %a1) ${FN_ATTRS} { ; stream 'data' adapter ${typeKey(cbT)}`,
      `entry:`,
      `  %capsp = getelementptr inbounds %ScrClosure, ptr %cb, i64 1`,
      `  %bx = load ptr, ptr %capsp`,
      `  %orig = call ptr @scr_box_get_ref(ptr %bx) ; the listener, +1`,
    ];
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
          d.push(`  call void ${releaseSym(host, cbT.ret)}(ptr %ret) ; discarded listener result`);
        }
      }
      d.push(`  call void @scr_closure_release(ptr %orig)`, `  ret void`);
    };
    if (p === undefined) {
      finish(null);
      d.push(`}`, ``);
    } else if (p.kind === "bytes" || p.kind === "string") {
      const msg = p.kind === "bytes"
        ? "a 'data' listener declaring a Buffer chunk received a string (the stream has an encoding set)"
        : "a 'data' listener declaring a string chunk received a Buffer (call setEncoding, or declare the chunk as a Buffer)";
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
        `  %r0 = call ptr ${retainSym(host, p)}(ptr ${slot})`,
      );
      finish("%r0");
      d.push(`}`, ``);
    } else {
      // dyn: box by runtime tag — the JS lane's adapter parameter.
      host.declare(`declare ptr @scr_dyn_new_buffer_copy(ptr)`);
      host.declare(`declare ptr @scr_dyn_new_str(ptr)`);
      d.push(
        `  %dslot = alloca ptr`,
        `  %isb = icmp ne ptr %a0, null`,
        `  br i1 %isb, label %buf, label %str`,
        `buf:`,
        `  %db = call ptr @scr_dyn_new_buffer_copy(ptr %a0)`,
        `  store ptr %db, ptr %dslot`,
        `  br label %go`,
        `str:`,
        `  %ds = call ptr @scr_dyn_new_str(ptr %a1)`,
        `  store ptr %ds, ptr %dslot`,
        `  br label %go`,
        `go:`,
        `  %dv = load ptr, ptr %dslot`,
      );
      finish("%dv");
      d.push(`}`, ``);
    }
    host.resolveThunkDefs.push(...d);
    return sym;
  }

export function streamDoneFnFor(host: LlvmEmitterContext, kind: "w" | "f" | "d" | "t" | "l", doneT: IrType & { kind: "func" }): string {
    const key = `sd:${kind}:${typeKey(doneT)}`;
    let sym = host.resolveThunks.get(key);
    if (sym) return sym;
    sym = `sc_sd_${host.resolveThunks.size}`;
    host.resolveThunks.set(key, sym);
    const errT = doneT.params[0];
    let errTag = -1;
    if (errT !== undefined) {
      if (errT.kind !== "union") throw new InternalCompilerError("llvm emitter bug: stream done err param not a union");
      const def = host.unionsById.get(errT.unionId);
      errTag = def ? def.arms.findIndex((a) => a.kind === "object") : -1;
      if (errTag < 0) throw new InternalCompilerError("llvm emitter bug: stream done err union lacks its Error arm");
    }
    const dataT = kind === "t" || kind === "l" ? doneT.params[1] : undefined;
    let bytesTag = -1;
    let strTag = -1;
    if (dataT !== undefined) {
      if (dataT.kind !== "union") throw new InternalCompilerError("llvm emitter bug: stream done data param not a union");
      const def = host.unionsById.get(dataT.unionId);
      bytesTag = def ? def.arms.findIndex((a) => a.kind === "bytes") : -1;
      strTag = def ? def.arms.findIndex((a) => a.kind === "string") : -1;
    }
    const entry =
      kind === "w" ? "scr_stream_write_done" :
      kind === "f" ? "scr_stream_final_done" :
      kind === "d" ? "scr_stream_destroy_done" :
      kind === "t" ? "scr_stream_transform_done" : "scr_stream_flush_done";
    const twoSlot = kind === "t" || kind === "l";
    host.declare(`declare void @${entry}(ptr, ptr${twoSlot ? ", ptr, ptr" : ""})`);
    host.declare(`declare ptr @scr_box_get_ref(ptr)`);
    host.declare(`declare void @scr_stream_release_v(ptr)`);
    host.declare(`declare ptr @scr_error_retain_v(ptr)`);
    host.declare(`declare void @scr_union_release(ptr)`);
    const params = [
      "ptr %self",
      ...(errT !== undefined ? ["ptr %e"] : []),
      ...(dataT !== undefined ? ["ptr %d"] : []),
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
      d.push(
        `  %un${a} = icmp ne ptr ${u}, null`,
        `  br i1 %un${a}, label %chk${a}, label %done${a}`,
        `chk${a}:`,
        `  %tp${a} = getelementptr inbounds %ScrUnion, ptr ${u}, i64 0, i32 1`,
        `  %tg${a} = load i32, ptr %tp${a}`,
        `  %hit${a} = icmp eq i32 %tg${a}, ${tag}`,
        `  br i1 %hit${a}, label %yes${a}, label %done${a}`,
        `yes${a}:`,
        `  %pp${a} = getelementptr inbounds %ScrUnion, ptr ${u}, i64 0, i32 5`,
        `  %pv${a} = load ptr, ptr %pp${a}`,
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
    if (twoSlot) {
      d.push(
        `  %bv = load ptr, ptr %bslot`,
        `  %sv = load ptr, ptr %sslot`,
        `  call void @${entry}(ptr %s, ptr %ev, ptr %bv, ptr %sv) ; moves err/data; borrows s`,
      );
    } else {
      d.push(`  call void @${entry}(ptr %s, ptr %ev) ; moves err; borrows s`);
    }
    d.push(`  call void @scr_stream_release_v(ptr %s)`);
    if (errT !== undefined) d.push(`  call void @scr_union_release(ptr %e)`);
    if (dataT !== undefined) d.push(`  call void @scr_union_release(ptr %d)`);
    d.push(`  ret void`, `}`, ``);
    host.resolveThunkDefs.push(...d);
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
    sym = `sc_fsren_${host.resolveThunks.size}`;
    host.resolveThunks.set(key, sym);
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
      if (param.kind !== "union") throw new InternalCompilerError("llvm emitter bug: fs.rename error param not a union");
      const def = host.unionsById.get(param.unionId);
      const errTag = def ? def.arms.findIndex((a) => a.kind === "object" && a.className === "%Error") : -1;
      const nullTag = def ? def.arms.findIndex((a) => a.kind === "nullT") : -1;
      if (errTag < 0 || nullTag < 0) throw new InternalCompilerError("llvm emitter bug: fs.rename error union lacks its arms");
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
    return sym;
  }

export function streamCbThunkFor(host: LlvmEmitterContext, kind: "r" | "w" | "f" | "d" | "t" | "l" | "e", cbT: IrType): string {
    if (cbT.kind !== "func") throw new InternalCompilerError("llvm emitter bug: stream option callback not a func");
    const key = `scb:${kind}:${typeKey(cbT)}`;
    let sym = host.resolveThunks.get(key);
    if (sym) return sym;
    sym = `sc_scb_${host.resolveThunks.size}`;
    host.resolveThunks.set(key, sym);
    const runtimeParams =
      kind === "r" ? ["ptr %s", "double %size"] :
      kind === "w" || kind === "t" ? ["ptr %s", "ptr %chunk"] :
      kind === "d" || kind === "e" ? ["ptr %s", "ptr %err"] :
      ["ptr %s"];
    const declared = cbT.params;
    const hasThis = declared[0] !== undefined && declared[0].kind === "object";
    if (declared.length === 0) {
      throw new InternalCompilerError("llvm emitter bug: stream option callback with no params (frontend must fence)");
    }
    const off = hasThis ? 1 : 0;
    const full = (kind === "r" ? 1 : kind === "w" || kind === "t" ? 3 : kind === "d" ? 2 : 1) + off;
    if (declared.length > full) {
      throw new InternalCompilerError(`llvm emitter bug: stream '${kind}' callback declares ${declared.length} params (frontend must fence)`);
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
      const isChunkPos = (kind === "w" || kind === "t") && pos === 0;
      const isEncPos = (kind === "w" || kind === "t") && pos === 1;
      const isErrPos = (kind === "d" || kind === "e") && pos === 0;
      const isDonePos =
        kind === "e" ? false
        : (kind === "w" || kind === "t") ? pos === 2 : (kind === "f" || kind === "l") ? pos === 0 : pos === 1;
      if (p.kind === "dyn") {
        if (isChunkPos) {
          host.declare(`declare ptr @scr_dyn_new_buffer_copy(ptr)`);
          d.push(`  %dc${i} = call ptr @scr_dyn_new_buffer_copy(ptr %chunk)`);
          passed.push(`ptr %dc${i}`);
        } else if (isEncPos) {
          host.declare(`declare ptr @scr_str_new(ptr, ${host.sizeType})`);
          host.declare(`declare ptr @scr_dyn_new_str(ptr)`);
          host.declare(`declare void @scr_str_release(ptr)`);
          d.push(
            `  %es${i} = call ptr @scr_str_new(ptr ${host.cstr("buffer")}, ${host.sizeType} 6)`,
            `  %ed${i} = call ptr @scr_dyn_new_str(ptr %es${i})`,
            `  call void @scr_str_release(ptr %es${i})`,
          );
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
          d.push(
            `  br label %ego${i}`,
            `ego${i}:`,
            `  %edv${i} = load ptr, ptr %edslot${i}`,
          );
          passed.push(`ptr %edv${i}`);
        } else if (isDonePos) {
          const glue = `scr_stream_done_dyn_${kind}`;
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
          throw new InternalCompilerError(`llvm emitter bug: stream '${kind}' dyn callback param ${i} has no adapter`);
        }
        continue;
      }
      if (isChunkPos) {
        host.declare(`declare ptr @scr_bytes_retain_v(ptr)`);
        d.push(`  %rc${i} = call ptr @scr_bytes_retain_v(ptr %chunk)`);
        passed.push(`ptr %rc${i}`);
      } else if (isEncPos) {
        // Node's encoding for decoded (Buffer) chunks is 'buffer'.
        host.declare(`declare ptr @scr_str_new(ptr, ${host.sizeType})`);
        d.push(`  %en${i} = call ptr @scr_str_new(ptr ${host.cstr("buffer")}, ${host.sizeType} 6)`);
        passed.push(`ptr %en${i}`);
      } else if (isErrPos) {
        // destroy's error argument: `Error | null` — wrap type-directedly.
        // The finished/pipeline callback ("e") may declare `Error | null |
        // undefined`; success prefers the undefined arm there.
        if (p.kind !== "union") throw new InternalCompilerError("llvm emitter bug: stream destroy err param not a union");
        const def = host.unionsById.get(p.unionId);
        const errTag = def ? def.arms.findIndex((a) => a.kind === "object") : -1;
        const undefTag = kind === "e" && def ? def.arms.findIndex((a) => a.kind === "undefinedT") : -1;
        const nullTag = def
          ? (undefTag >= 0 ? undefTag : def.arms.findIndex((a) => a.kind === "nullT"))
          : -1;
        if (errTag < 0 || nullTag < 0) throw new InternalCompilerError("llvm emitter bug: stream destroy err union lacks its arms");
        host.declare(`declare ptr @scr_union_new_ref(i32, ptr, ptr, ptr, ptr)`);
        host.declare(`declare ptr @scr_error_retain_v(ptr)`);
        host.declare(`declare void @scr_error_release_v(ptr)`);
        d.push(
          `  %euslot${i} = alloca ptr`,
          `  %euh${i} = icmp ne ptr %err, null`,
          `  br i1 %euh${i}, label %euy${i}, label %eun${i}`,
          `euy${i}:`,
          `  %eur${i} = call ptr @scr_error_retain_v(ptr %err)`,
          `  %euu${i} = call ptr @scr_union_new_ref(i32 ${errTag}, ptr %eur${i}, ptr @scr_error_retain_v, ptr @scr_error_release_v, ptr ${traceArg(host, def!.arms[errTag]!)})`,
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
        const doneKind = kind as "w" | "f" | "d" | "t" | "l"; // "e" has no done position
        if (p.kind !== "func") throw new InternalCompilerError("llvm emitter bug: stream done callback not a func");
        const doneFn = host.streamDoneFnFor(doneKind, p);
        const clo = doneClosure(`@${doneFn}`, `dn${i}`);
        passed.push(`ptr ${clo}`);
      } else {
        throw new InternalCompilerError(`llvm emitter bug: stream '${kind}' callback param ${i} has no adapter`);
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
        d.push(`  call void ${releaseSym(host, cbT.ret)}(ptr %ret) ; discarded option-callback result`);
      }
    }
    d.push(`  ret void`, `}`, ``);
    host.resolveThunkDefs.push(...d);
    return sym;
  }
