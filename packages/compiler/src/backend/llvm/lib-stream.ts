/* Focused LLVM library-call emission extracted from emitter.ts. */
import { InternalCompilerError } from "../../errors.js";
import type { LlvmEmitterContext, LibCallExpr, LlValue } from "./expr-context.js";
import { f64Lit } from "./common.js";

const STREAM_CANONICAL_CBS: Record<string, ("r" | "w" | "f" | "d" | "t" | "l")[]> = {
  readable: ["r", "d"],
  writable: ["w", "f", "d"],
  duplex: ["r", "w", "f", "d"],
  transform: ["t", "l", "d"],
  passthrough: ["t", "l", "d"],
};

export function emitStreamLibCall(host: LlvmEmitterContext, e: LibCallExpr): LlValue {
    const B = host.B;
    if (e.fn === "stream.onData") {
      // The callback MOVES into the stream's listener registry; the
      // adapter is per callback shape — runtime-provided for the
      // zero-param and Buffer forms, emitted per union for the
      // `Buffer | string` chunk (the chunk wraps at its Buffer arm).
      host.usesTimers = true; // a flowing stream holds the loop
      const cbT = e.args[1]!.type;
      if (cbT.kind !== "func") throw new InternalCompilerError("llvm emitter bug: stream.onData callback not a func");
      const s0 = host.emitExpr(e.args[0]!);
      const cb = host.emitExpr(e.args[1]!);
      const once = host.emitExpr(e.args[2]!);
      host.moveTemp(cb);
      const param = cbT.params[0];
      let adapter: string;
      if (param === undefined) {
        adapter = "scr_child_stream_thunk0";
        host.declare(`declare void @scr_child_stream_thunk0(ptr, ptr)`);
      } else if (param.kind === "union") {
        adapter = host.childDataThunkFor(param);
      } else {
        adapter = "scr_child_stream_thunk_bytes";
        host.declare(`declare void @scr_child_stream_thunk_bytes(ptr, ptr)`);
      }
      host.declare(`declare void @scr_child_stream_on_data(ptr, ptr, ptr, i1 zeroext)`);
      B.line(`call void @scr_child_stream_on_data(ptr ${s0.name}, ptr ${cb.name}, ptr @${adapter}, i1 ${once.name})`);
      return { name: "", type: e.type };
    }
    if (e.fn === "stream.onEnd") {
      const s0 = host.emitExpr(e.args[0]!);
      const cb = host.emitExpr(e.args[1]!);
      const once = host.emitExpr(e.args[2]!);
      host.moveTemp(cb);
      host.declare(`declare void @scr_child_stream_on_end(ptr, ptr, i1 zeroext)`);
      B.line(`call void @scr_child_stream_on_end(ptr ${s0.name}, ptr ${cb.name}, i1 ${once.name})`);
      return { name: "", type: e.type };
    }
    if (/^(readable|writable|duplex|transform|passthrough)\.(new|init)$/.test(e.fn)) {
      // Head args then flags then the PRESENT option callbacks in
      // canonical order (the flags literal names which; absent ones pass
      // NULL pairs). The .init forms carry the BORROWED receiver at arg 0
      // and shift everything by one (exprs.ts's shape, ported).
      const base = e.fn.slice(0, e.fn.indexOf("."));
      const isInit = e.fn.endsWith(".init");
      const off = isInit ? 1 : 0;
      const duplexShape = base !== "readable" && base !== "writable";
      const headLen = duplexShape ? 8 : 4;
      const flagsArg = e.args[off + headLen - 1]!;
      if (flagsArg.kind !== "numLit") throw new InternalCompilerError(`llvm emitter bug: ${e.fn} flags not a literal`);
      const flags = flagsArg.value;
      const args = e.args.map((a) => host.emitExpr(a));
      const canonical = STREAM_CANONICAL_CBS[base]!;
      const cbArgs: string[] = [];
      let at = off + headLen;
      for (let i = 0; i < canonical.length; i++) {
        if ((flags & (1 << i)) === 0) {
          cbArgs.push("ptr null", "ptr null");
          continue;
        }
        const cb = args[at]!;
        const cbT = e.args[at]!.type;
        host.moveTemp(cb); // the callback closure MOVES into the stream
        cbArgs.push(`ptr ${cb.name}`, `ptr @${host.streamCbThunkFor(canonical[i]!, cbT)}`);
        at++;
      }
      const entry = isInit ? `scr_stream_init_${base}` : `scr_stream_new_${base}`;
      const headIdx = duplexShape ? [0, 1, 2, 3, 4, 5, 6] : [0, 1, 2];
      const head = headIdx.map((i) => {
        const a = args[off + i]!;
        const ty = host.llType(a.type);
        return `${ty} ${a.name}`;
      });
      const headDecl = headIdx.map((i) => (host.llType(args[off + i]!.type) === "i1" ? "i1 zeroext" : host.llType(args[off + i]!.type)));
      const cbDecl = cbArgs.map(() => "ptr");
      if (isInit) {
        host.declare(`declare void @${entry}(ptr, ${[...headDecl, ...cbDecl].join(", ")})`);
        B.line(`call void @${entry}(${[`ptr ${args[0]!.name}`, ...head, ...cbArgs].join(", ")})`);
        return { name: "", type: e.type };
      }
      host.declare(`declare ptr @${entry}(${[...headDecl, ...cbDecl].join(", ")})`);
      const t = B.tmp();
      B.line(`${t} = call ptr @${entry}(${[...head, ...cbArgs].join(", ")})`);
      return host.own({ name: t, type: e.type });
    }
    if (e.fn === "stream.setRead" || e.fn === "stream.setWrite" || e.fn === "stream.setFinal" || e.fn === "stream.setDestroy" || e.fn === "stream.setTransform" || e.fn === "stream.setFlush") {
      // The underscore-method assignment surface: the runtime slot swaps
      // its closure (+1 moves in) and invoke thunk — the next
      // _read/_write/... dispatch uses it, Node's timing.
      const kindOf: Record<string, "r" | "w" | "f" | "d" | "t" | "l"> = {
        "stream.setRead": "r", "stream.setWrite": "w", "stream.setFinal": "f",
        "stream.setDestroy": "d", "stream.setTransform": "t", "stream.setFlush": "l",
      };
      const symOf: Record<string, string> = {
        "stream.setRead": "scr_stream_set_read", "stream.setWrite": "scr_stream_set_write",
        "stream.setFinal": "scr_stream_set_final", "stream.setDestroy": "scr_stream_set_destroy",
        "stream.setTransform": "scr_stream_set_transform", "stream.setFlush": "scr_stream_set_flush",
      };
      const recv = host.emitExpr(e.args[0]!);
      const cb = host.emitExpr(e.args[1]!);
      const cbT = e.args[1]!.type;
      host.moveTemp(cb); // the callback closure MOVES into the stream
      const sym = symOf[e.fn]!;
      host.declare(`declare void @${sym}(ptr, ptr, ptr)`);
      B.line(`call void @${sym}(ptr ${recv.name}, ptr ${cb.name}, ptr @${host.streamCbThunkFor(kindOf[e.fn]!, cbT)})`);
      return { name: "", type: e.type };
    }
    if (/^(readable|writable|duplex|transform|passthrough)\.initDyn$/.test(e.fn)) {
      // The dyn-options super(options): borrowed receiver + record, then
      // the FALLBACK underscore-method wrappers in canonical order (the
      // flags literal names which; wrappers MOVE). MAY THROW.
      const base = e.fn.slice(0, e.fn.indexOf("."));
      const flagsArg = e.args[2]!;
      if (flagsArg.kind !== "numLit") throw new InternalCompilerError(`llvm emitter bug: ${e.fn} flags not a literal`);
      const flags = flagsArg.value;
      const args = e.args.map((a) => host.emitExpr(a));
      const canonical = STREAM_CANONICAL_CBS[base]!;
      const cbArgs: string[] = [];
      let at = 3;
      for (let i = 0; i < canonical.length; i++) {
        if ((flags & (1 << i)) === 0) {
          cbArgs.push("ptr null", "ptr null");
          continue;
        }
        const cb = args[at]!;
        const cbT = e.args[at]!.type;
        host.moveTemp(cb);
        cbArgs.push(`ptr ${cb.name}`, `ptr @${host.streamCbThunkFor(canonical[i]!, cbT)}`);
        at++;
      }
      const entry = `scr_stream_init_${base}_dyn`;
      host.declare(`declare void @${entry}(ptr, ptr, ${cbArgs.map(() => "ptr").join(", ")})`);
      B.line(`call void @${entry}(${[`ptr ${args[0]!.name}`, `ptr ${args[1]!.name}`, ...cbArgs].join(", ")})`);
      host.emitPendingCheck();
      return { name: "", type: e.type };
    }
    if (e.fn === "readable.pushU" || e.fn === "writable.writeU") {
      // Union-typed chunk: dispatch by tag (bytes / string / null arms —
      // the frontend admitted exactly those). May throw (write_null's
      // ERR_STREAM_NULL_VALUES; listeners run inside).
      const t = e.args[1]!.type;
      if (t.kind !== "union") throw new InternalCompilerError(`llvm emitter bug: ${e.fn} chunk not a union`);
      const def = host.unionsById.get(t.unionId);
      if (!def) throw new InternalCompilerError(`llvm emitter bug: ${e.fn} union unknown`);
      const args = e.args.map((a) => host.emitExpr(a));
      const pushing = e.fn === "readable.pushU";
      const entries: Record<string, string> = pushing
        ? { bytes: "scr_stream_push", string: "scr_stream_push_str", nullT: "scr_stream_push_null" }
        : { bytes: "scr_stream_write", string: "scr_stream_write_str", nullT: "scr_stream_write_null" };
      const present = (["nullT", "string", "bytes"] as const)
        .map((kind) => ({ kind, tag: def.arms.findIndex((a) => a.kind === kind) }))
        .filter((a) => a.tag >= 0);
      if (present.length === 0) throw new InternalCompilerError(`llvm emitter bug: ${e.fn} union lacks its arms`);
      const tagP = B.tmp();
      const tag = B.tmp();
      B.line(`${tagP} = getelementptr inbounds %ScrUnion, ptr ${args[1]!.name}, i64 0, i32 1`);
      B.line(`${tag} = load i32, ptr ${tagP}`);
      const slot = B.slot();
      B.entryAllocas.push(`${slot} = alloca i1`);
      const lj = B.newLabel("scu.j");
      const emitArm = (kind: "bytes" | "string" | "nullT"): void => {
        const entry = entries[kind]!;
        if (kind === "nullT") {
          host.declare(`declare zeroext i1 @${entry}(ptr)`);
          const r = B.tmp();
          B.line(`${r} = call zeroext i1 @${entry}(ptr ${args[0]!.name})`);
          B.line(`store i1 ${r}, ptr ${slot}`);
          return;
        }
        const pk = B.tmp();
        const pv = B.tmp();
        B.line(`${pk} = getelementptr inbounds %ScrUnion, ptr ${args[1]!.name}, i64 0, i32 5`);
        B.line(`${pv} = load ptr, ptr ${pk} ; borrowed payload`);
        const r = B.tmp();
        if (pushing) {
          host.declare(`declare zeroext i1 @${entry}(ptr, ptr)`);
          B.line(`${r} = call zeroext i1 @${entry}(ptr ${args[0]!.name}, ptr ${pv})`);
        } else {
          host.declare(`declare zeroext i1 @${entry}(ptr, ptr, ptr)`);
          B.line(`${r} = call zeroext i1 @${entry}(ptr ${args[0]!.name}, ptr ${pv}, ptr null)`);
        }
        B.line(`store i1 ${r}, ptr ${slot}`);
      };
      // The C shape is a ternary chain ending at the LAST present arm
      // (no default): mirror with a tag switch whose default is that arm.
      const last = present[present.length - 1]!;
      const labels = present.slice(0, -1).map((a) => ({ ...a, label: B.newLabel(`scu.${a.kind}`) }));
      const ld = B.newLabel("scu.d");
      if (labels.length > 0) {
        B.terminate(
          `switch i32 ${tag}, label %${ld} [ ${labels.map((a) => `i32 ${a.tag}, label %${a.label}`).join(" ")} ]`,
        );
      } else {
        B.br(ld);
      }
      for (const a of labels) {
        B.startBlock(a.label);
        emitArm(a.kind);
        B.br(lj);
      }
      B.startBlock(ld);
      emitArm(last.kind);
      B.br(lj);
      B.startBlock(lj);
      const rv = B.tmp();
      B.line(`${rv} = load i1, ptr ${slot}`);
      host.emitPendingCheck();
      return e.type.kind === "void" ? { name: "", type: e.type } : { name: rv, type: e.type };
    }
    if (e.fn === "readable.read") {
      // +1 Buffer or NULL → the `Buffer | null` union, constructed
      // type-directedly (the C error.code pattern); the pending check
      // runs between the call and the wrap (encoded streams throw).
      if (e.type.kind !== "union") throw new InternalCompilerError("llvm emitter bug: readable.read result is not a union");
      const def = host.unionsById.get(e.type.unionId);
      const bytesTag = def ? def.arms.findIndex((a) => a.kind === "bytes") : -1;
      const nullTag = def ? def.arms.findIndex((a) => a.kind === "nullT") : -1;
      if (bytesTag < 0 || nullTag < 0) throw new InternalCompilerError("llvm emitter bug: readable.read union lacks its arms");
      const args = e.args.map((a) => host.emitExpr(a));
      host.declare(`declare ptr @scr_stream_read(ptr, double)`);
      const raw = B.tmp();
      B.line(`${raw} = call ptr @scr_stream_read(ptr ${args[0]!.name}, double ${args[1]!.name})`);
      const b = host.own({ name: raw, type: def!.arms[bytesTag]! });
      host.emitPendingCheck();
      host.moveTemp(b); // moves into the union arm when present
      return host.wrapNullable(raw, raw, def!.arms[bytesTag]!, bytesTag, e.type, nullTag);
    }
    if (e.fn === "readable.flowing") {
      // -1 (null: never kicked) / 0 / 1 → the `boolean | null` union.
      if (e.type.kind !== "union") throw new InternalCompilerError("llvm emitter bug: readable.flowing result is not a union");
      const def = host.unionsById.get(e.type.unionId);
      const boolTag = def ? def.arms.findIndex((a) => a.kind === "bool") : -1;
      const nullTag = def ? def.arms.findIndex((a) => a.kind === "nullT") : -1;
      if (boolTag < 0 || nullTag < 0) throw new InternalCompilerError("llvm emitter bug: readable.flowing union lacks its arms");
      const args = e.args.map((a) => host.emitExpr(a));
      host.declare(`declare double @scr_stream_flowing(ptr)`);
      host.declare(`declare ptr @scr_union_new_bool(i32, i1 zeroext)`);
      const f = B.tmp();
      B.line(`${f} = call double @scr_stream_flowing(ptr ${args[0]!.name})`);
      const slot = B.slot();
      B.entryAllocas.push(`${slot} = alloca ptr`);
      const isNull = B.tmp();
      B.line(`${isNull} = fcmp olt double ${f}, ${f64Lit(0)}`);
      const ln = B.newLabel("fl.n");
      const lb = B.newLabel("fl.b");
      const lj = B.newLabel("fl.j");
      B.condBr(isNull, ln, lb);
      B.startBlock(ln);
      B.line(`store ptr ${host.unitInstanceRef(e.type.unionId, nullTag)}, ptr ${slot}`);
      B.br(lj);
      B.startBlock(lb);
      const isOn = B.tmp();
      B.line(`${isOn} = fcmp ogt double ${f}, ${f64Lit(0)}`);
      const u = B.tmp();
      B.line(`${u} = call ptr @scr_union_new_bool(i32 ${boolTag}, i1 ${isOn})`);
      B.line(`store ptr ${u}, ptr ${slot}`);
      B.br(lj);
      B.startBlock(lj);
      const t = B.tmp();
      B.line(`${t} = load ptr, ptr ${slot}`);
      return host.own({ name: t, type: e.type });
    }
    if (e.fn === "readable.unpipe") {
      // (src[, dst]) — the absent destination unpipes everything.
      const args = e.args.map((a) => host.emitExpr(a));
      host.declare(`declare ptr @scr_stream_unpipe(ptr, ptr)`);
      const dst = e.args.length > 1 ? args[1]!.name : "null";
      const t = B.tmp();
      B.line(`${t} = call ptr @scr_stream_unpipe(ptr ${args[0]!.name}, ptr ${dst})`);
      const out = host.own({ name: t, type: e.type });
      host.emitPendingCheck();
      return out;
    }
    if (e.fn === "writable.write" || e.fn === "writable.writeStr" || e.fn === "writable.writeDyn") {
      // write borrows its chunk; the optional completion callback MOVES.
      const entry = e.fn === "writable.write" ? "scr_stream_write"
        : e.fn === "writable.writeStr" ? "scr_stream_write_str" : "scr_stream_write_dyn";
      const args = e.args.map((a) => host.emitExpr(a));
      let cb = "null";
      if (e.fn !== "writable.writeDyn" && e.args.length > 2) {
        host.moveTemp(args[2]!);
        cb = args[2]!.name;
      }
      host.declare(`declare zeroext i1 @${entry}(ptr, ptr, ptr)`);
      const t = B.tmp();
      B.line(`${t} = call zeroext i1 @${entry}(ptr ${args[0]!.name}, ptr ${args[1]!.name}, ptr ${cb})`);
      host.emitPendingCheck();
      return e.type.kind === "void" ? { name: "", type: e.type } : { name: t, type: e.type };
    }
    if (e.fn === "writable.end") {
      // (recv, flags[, chunk][, cb]) — flags: 1 bytes chunk, 2 string
      // chunk, 8 dyn chunk (write first, Node's end(chunk) decomposition),
      // 4 callback.
      const flagsArg = e.args[1]!;
      if (flagsArg.kind !== "numLit") throw new InternalCompilerError("llvm emitter bug: writable.end flags not a literal");
      const flags = flagsArg.value;
      const args = e.args.map((a) => host.emitExpr(a));
      let at = 2;
      let chunkB = "null";
      let chunkS = "null";
      let chunkD: string | null = null;
      if (flags & 1) chunkB = args[at++]!.name;
      else if (flags & 2) chunkS = args[at++]!.name;
      else if (flags & 8) chunkD = args[at++]!.name;
      let cbName = "null";
      if (flags & 4) {
        host.moveTemp(args[at]!);
        cbName = args[at]!.name;
      }
      if (chunkD !== null) {
        host.declare(`declare zeroext i1 @scr_stream_write_dyn(ptr, ptr, ptr)`);
        B.line(`${B.tmp()} = call zeroext i1 @scr_stream_write_dyn(ptr ${args[0]!.name}, ptr ${chunkD}, ptr null)`);
      }
      host.declare(`declare ptr @scr_stream_end(ptr, ptr, ptr, ptr)`);
      const t = B.tmp();
      B.line(`${t} = call ptr @scr_stream_end(ptr ${args[0]!.name}, ptr ${chunkB}, ptr ${chunkS}, ptr ${cbName})`);
      const out = host.own({ name: t, type: e.type });
      host.emitPendingCheck();
      return out;
    }
    if (e.fn === "stream.destroy") {
      const args = e.args.map((a) => host.emitExpr(a));
      host.declare(`declare ptr @scr_stream_destroy(ptr, ptr)`);
      const t = B.tmp();
      B.line(`${t} = call ptr @scr_stream_destroy(ptr ${args[0]!.name}, ptr null)`);
      const out = host.own({ name: t, type: e.type });
      host.emitPendingCheck();
      return out;
    }
    if (e.fn === "stream.prop") {
      // The property NAME is a compile-time literal; args[1]'s emitted
      // temp is unused (released with the statement's frame).
      const nameArg = e.args[1]!;
      if (nameArg.kind !== "strLit") throw new InternalCompilerError("llvm emitter bug: stream.prop name not a literal");
      const args = e.args.map((a) => host.emitExpr(a));
      host.declare(`declare double @scr_stream_prop(ptr, ptr)`);
      const t = B.tmp();
      B.line(`${t} = call double @scr_stream_prop(ptr ${args[0]!.name}, ptr ${host.cstr(nameArg.value)})`);
      if (e.type.kind === "bool") {
        const b = B.tmp();
        B.line(`${b} = fcmp une double ${t}, ${f64Lit(0)}`);
        return { name: b, type: e.type };
      }
      return { name: t, type: e.type };
    }
    if (e.fn === "stream.errored") {
      // +1 error or NULL → the `Error | null` union.
      if (e.type.kind !== "union") throw new InternalCompilerError("llvm emitter bug: stream.errored result is not a union");
      const def = host.unionsById.get(e.type.unionId);
      const errTag = def ? def.arms.findIndex((a) => a.kind === "object") : -1;
      const nullTag = def ? def.arms.findIndex((a) => a.kind === "nullT") : -1;
      if (errTag < 0 || nullTag < 0) throw new InternalCompilerError("llvm emitter bug: stream.errored union lacks its arms");
      const args = e.args.map((a) => host.emitExpr(a));
      host.declare(`declare ptr @scr_stream_errored(ptr)`);
      const raw = B.tmp();
      B.line(`${raw} = call ptr @scr_stream_errored(ptr ${args[0]!.name}) ; +1 or NULL`);
      return host.wrapNullable(raw, raw, def!.arms[errTag]!, errTag, e.type, nullTag);
    }
    if (e.fn === "stream.finished" || e.fn === "stream.finishedDyn") {
      // finished(s, cb): the +1 cleanup closure answers. Typed callbacks
      // ride the "e" thunk; dyn values ride the runtime's own inv.
      const args = e.args.map((a) => host.emitExpr(a));
      const t = B.tmp();
      if (e.fn === "stream.finishedDyn") {
        host.declare(`declare ptr @scr_stream_finished_dyn(ptr, ptr)`);
        B.line(`${t} = call ptr @scr_stream_finished_dyn(ptr ${args[0]!.name}, ptr ${args[1]!.name})`);
      } else {
        const cbT = e.args[1]!.type;
        if (cbT.kind !== "func") throw new InternalCompilerError("llvm emitter bug: stream.finished callback not a func");
        host.moveTemp(args[1]!); // the watcher closure MOVES into the stream
        const thunk = host.streamCbThunkFor("e", cbT);
        host.declare(`declare ptr @scr_stream_finished(ptr, ptr, ptr)`);
        B.line(`${t} = call ptr @scr_stream_finished(ptr ${args[0]!.name}, ptr ${args[1]!.name}, ptr @${thunk})`);
      }
      const out = host.own({ name: t, type: e.type });
      host.emitPendingCheck();
      return out;
    }
    if (e.fn === "sp.pipeline") {
      // pipeline(count, s1..sn) settling a void promise: the stream list
      // rides the callback form's stack array, no callback slot.
      const countArg = e.args[0]!;
      if (countArg.kind !== "numLit") throw new InternalCompilerError(`llvm emitter bug: ${e.fn} count not a literal`);
      const n = countArg.value;
      const args = e.args.map((a) => host.emitExpr(a));
      const arr = B.slot();
      B.entryAllocas.push(`${arr} = alloca [${n} x ptr]`);
      for (let i = 0; i < n; i++) {
        const p = B.tmp();
        B.line(`${p} = getelementptr inbounds [${n} x ptr], ptr ${arr}, i64 0, i64 ${i}`);
        B.line(`store ptr ${args[1 + i]!.name}, ptr ${p}`);
      }
      const t = B.tmp();
      host.declare(`declare ptr @scr_sp_pipeline(double, ptr)`);
      B.line(`${t} = call ptr @scr_sp_pipeline(double ${f64Lit(n)}, ptr ${arr})`);
      const out = host.own({ name: t, type: e.type });
      host.emitPendingCheck();
      return out;
    }
    if (e.fn === "stream.pipeline" || e.fn === "stream.pipelineDyn") {
      // pipeline(count, s1..sn, cb): the destination answers +1. The
      // stream list rides a stack array (the C compound literal).
      const countArg = e.args[0]!;
      if (countArg.kind !== "numLit") throw new InternalCompilerError(`llvm emitter bug: ${e.fn} count not a literal`);
      const n = countArg.value;
      const args = e.args.map((a) => host.emitExpr(a));
      const arr = B.slot();
      B.entryAllocas.push(`${arr} = alloca [${n} x ptr]`);
      for (let i = 0; i < n; i++) {
        const p = B.tmp();
        B.line(`${p} = getelementptr inbounds [${n} x ptr], ptr ${arr}, i64 0, i64 ${i}`);
        B.line(`store ptr ${args[1 + i]!.name}, ptr ${p}`);
      }
      const t = B.tmp();
      if (e.fn === "stream.pipelineDyn") {
        host.declare(`declare ptr @scr_stream_pipeline_dyn(double, ptr, ptr)`);
        B.line(`${t} = call ptr @scr_stream_pipeline_dyn(double ${f64Lit(n)}, ptr ${arr}, ptr ${args[1 + n]!.name})`);
      } else {
        const cbT = e.args[1 + n]!.type;
        if (cbT.kind !== "func") throw new InternalCompilerError("llvm emitter bug: stream.pipeline callback not a func");
        host.moveTemp(args[1 + n]!);
        const thunk = host.streamCbThunkFor("e", cbT);
        host.declare(`declare ptr @scr_stream_pipeline(double, ptr, ptr, ptr)`);
        B.line(`${t} = call ptr @scr_stream_pipeline(double ${f64Lit(n)}, ptr ${arr}, ptr ${args[1 + n]!.name}, ptr @${thunk})`);
      }
      const out = host.own({ name: t, type: e.type });
      host.emitPendingCheck();
      return out;
    }
    // ── node:net + node:http (the server surface): registrations move
    // their callbacks into the handle's registry with runtime-provided
    // adapters; the handful of union-wrapped reads use the envGet shapes.
    return host.emitGenericLibCall(e);
  }
