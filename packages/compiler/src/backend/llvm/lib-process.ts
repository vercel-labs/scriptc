/* Focused LLVM library-call emission extracted from emitter.ts. */
import { InternalCompilerError } from "../../errors.js";
import { undefinedArmTag } from "../../ir/analysis.js";
import { F64, type IrType, RUNTIME_ERROR_CLASSES, STRING, typeKey } from "../../ir/ir.js";
import type { LlvmEmitterContext, LibCallExpr, LlValue } from "./expr-context.js";
import { f64Lit } from "./common.js";
import { mockTimerSym } from "./lib-shared.js";
import { FN_ATTRS } from "./shapes.js";
import { registerReplay } from "./emit-journal.js";

export function emitChildProcessLibCall(host: LlvmEmitterContext, e: LibCallExpr): LlValue {
  const B = host.B;
  if (e.fn === "cp.execFile") {
    const callbackArg = e.args[2];
    if (!callbackArg)
      throw new InternalCompilerError("llvm emitter bug: execFile callback missing");
    const cbT = callbackArg.type;
    if (cbT.kind !== "func")
      throw new InternalCompilerError("llvm emitter bug: execFile callback not a func");
    const cmd = host.emitExpr(e.args[0]!);
    const argv = host.emitExpr(e.args[1]!);
    const cb = host.emitExpr(callbackArg);
    host.toHeap(cb);
    const shell = host.emitExpr(e.args[3]!);
    const adapter = host.execFileThunkFor(cbT);
    host.usesTimers = true;
    host.declare(`declare ptr @scr_exec_file(ptr, ptr, ptr, ptr, i1)`);
    const out = B.tmp();
    B.line(
      `${out} = call ptr @scr_exec_file(ptr ${cmd.name}, ptr ${argv.name}, ptr ${cb.name}, ptr @${adapter}, i1 ${shell.name})`,
    );
    return host.own({ name: out, type: e.type });
  }
  if (
    e.fn === "cp.spawn" ||
    e.fn === "cp.spawnOpts" ||
    e.fn === "cp.spawnDynamic" ||
    e.fn === "cp.fork"
  ) {
    // child_process.spawn: the child starts NOW (posix_spawnp); the
    // loop reaps it and fires its listeners. Never throws — spawn
    // failure defers to "error".
    host.usesTimers = true;
    const sym =
      e.fn === "cp.spawn"
        ? "scr_spawn"
        : e.fn === "cp.fork"
          ? "scr_fork"
          : e.fn === "cp.spawnDynamic"
            ? "scr_spawn_dynamic"
            : "scr_spawn_opts";
    const args = e.args.map((a) => host.emitExpr(a));
    const argDecl = args
      .map((a) => (host.llType(a.type) === "i1" ? "i1 zeroext" : host.llType(a.type)))
      .join(", ");
    host.declare(`declare ptr @${sym}(${argDecl})`);
    const t = B.tmp();
    B.line(
      `${t} = call ptr @${sym}(${args.map((a) => `${host.llType(a.type)} ${a.name}`).join(", ")})`,
    );
    const out = host.own({ name: t, type: e.type });
    if (e.fn === "cp.spawnDynamic") host.emitPendingCheck();
    return out;
  }
  if (e.fn === "child.onDyn" || e.fn === "child.propsOnDyn") {
    const child = host.emitExpr(e.args[0]!);
    const event = host.emitExpr(e.args[1]!);
    const cb = host.emitExpr(e.args[2]!);
    const sym = e.fn === "child.onDyn" ? "scr_child_on_dyn" : "scr_child_on_dyn_hp";
    host.declare(`declare void @${sym}(ptr, ptr, ptr)`);
    B.line(`call void @${sym}(ptr ${child.name}, ptr ${event.name}, ptr ${cb.name})`);
    host.emitPendingCheck();
    return { name: "", type: e.type };
  }
  if (e.fn === "child.onSpawn") {
    const child = host.emitExpr(e.args[0]!);
    const cb = host.emitExpr(e.args[1]!);
    host.toHeap(cb);
    host.declare("declare void @scr_child_on_spawn(ptr, ptr)");
    B.line(`call void @scr_child_on_spawn(ptr ${child.name}, ptr ${cb.name})`);
    return { name: "", type: e.type };
  }
  if (e.fn === "child.onExit" || e.fn === "child.onClose") {
    // The callback MOVES into the child's registry; the third
    // ingredient is the ADAPTER — emitted per callback shape, because
    // the `number | null` union's tags are program data (a zero-param
    // listener gets the runtime's ignoring thunk).
    const cbT = e.args[1]!.type;
    if (cbT.kind !== "func")
      throw new InternalCompilerError(`llvm emitter bug: ${e.fn} callback not a func`);
    const child = host.emitExpr(e.args[0]!);
    const cb = host.emitExpr(e.args[1]!);
    host.toHeap(cb);
    let adapter: string;
    if (cbT.params.length === 0) {
      adapter = "scr_child_exit_thunk0";
      host.declare(`declare void @scr_child_exit_thunk0(ptr, i1 zeroext, double, ptr)`);
    } else if (cbT.params.length === 1) {
      adapter = host.childExitThunkFor(cbT.params[0]!);
    } else {
      adapter = host.childExitSignalThunkFor(cbT.params[0]!, cbT.params[1]!);
    }
    const register = e.fn === "child.onClose" ? "scr_child_on_close" : "scr_child_on_exit";
    host.declare(`declare void @${register}(ptr, ptr, ptr)`);
    B.line(`call void @${register}(ptr ${child.name}, ptr ${cb.name}, ptr @${adapter})`);
    return { name: "", type: e.type };
  }
  if (e.fn === "child.onError") {
    // Both error-listener shapes have runtime-provided adapters
    // (constructing the %Error instance needs no program types).
    const cbT = e.args[1]!.type;
    if (cbT.kind !== "func")
      throw new InternalCompilerError("llvm emitter bug: child.onError callback not a func");
    const child = host.emitExpr(e.args[0]!);
    const cb = host.emitExpr(e.args[1]!);
    host.toHeap(cb);
    const adapter = cbT.params.length === 0 ? "scr_child_err_thunk0" : "scr_child_err_thunk_error";
    host.declare(`declare void @${adapter}(ptr, ptr)`);
    host.declare(`declare void @scr_child_on_error(ptr, ptr, ptr)`);
    B.line(`call void @scr_child_on_error(ptr ${child.name}, ptr ${cb.name}, ptr @${adapter})`);
    return { name: "", type: e.type };
  }
  if (e.fn === "child.hasChannel") {
    const child = host.emitExpr(e.args[0]!);
    host.declare(`declare zeroext i1 @scr_child_ipc_present(ptr)`);
    const out = B.tmp();
    B.line(`${out} = call i1 @scr_child_ipc_present(ptr ${child.name})`);
    return { name: out, type: e.type };
  }
  if (e.fn === "child.connected") {
    const child = host.emitExpr(e.args[0]!);
    host.declare(`declare zeroext i1 @scr_child_ipc_connected(ptr)`);
    const out = B.tmp();
    B.line(`${out} = call i1 @scr_child_ipc_connected(ptr ${child.name})`);
    return { name: out, type: e.type };
  }
  if (e.fn === "child.send" || e.fn === "child.sendCb") {
    host.usesTimers = true;
    const child = host.emitExpr(e.args[0]!);
    const json = host.emitExpr(e.args[1]!);
    const sym = e.fn === "child.send" ? "scr_child_ipc_send" : "scr_child_ipc_send_cb";
    let suffix = "";
    let decl = "ptr, ptr";
    if (e.fn === "child.sendCb") {
      const cbT = e.args[2]!.type;
      if (cbT.kind !== "func")
        throw new InternalCompilerError("llvm emitter bug: child.send callback not a func");
      const cb = host.emitExpr(e.args[2]!);
      host.toHeap(cb);
      suffix = `, ptr ${cb.name}, ptr @${host.ipcSendThunkFor(cbT)}`;
      decl += ", ptr, ptr";
    }
    host.declare(`declare zeroext i1 @${sym}(${decl})`);
    const out = B.tmp();
    B.line(`${out} = call i1 @${sym}(ptr ${child.name}, ptr ${json.name}${suffix})`);
    return { name: out, type: e.type };
  }
  if (e.fn === "child.disconnect") {
    host.usesTimers = true;
    const child = host.emitExpr(e.args[0]!);
    host.declare(`declare void @scr_child_ipc_disconnect(ptr)`);
    B.line(`call void @scr_child_ipc_disconnect(ptr ${child.name})`);
    return { name: "", type: e.type };
  }
  if (e.fn === "child.onMessage" || e.fn === "child.onDisconnect") {
    host.usesTimers = true;
    const child = host.emitExpr(e.args[0]!);
    const cbT = e.args[1]!.type;
    if (cbT.kind !== "func")
      throw new InternalCompilerError(`llvm emitter bug: ${e.fn} callback not a func`);
    const cb = host.emitExpr(e.args[1]!);
    const once = host.emitExpr(e.args[2]!);
    host.toHeap(cb);
    if (e.fn === "child.onMessage") {
      host.declare(`declare void @scr_child_ipc_on_message(ptr, ptr, ptr, i1 zeroext)`);
      B.line(
        `call void @scr_child_ipc_on_message(ptr ${child.name}, ptr ${cb.name}, ptr @${host.ipcMessageThunkFor(cbT)}, i1 ${once.name})`,
      );
    } else {
      host.declare(`declare void @scr_child_ipc_on_disconnect(ptr, ptr, i1 zeroext)`);
      B.line(
        `call void @scr_child_ipc_on_disconnect(ptr ${child.name}, ptr ${cb.name}, i1 ${once.name})`,
      );
    }
    return { name: "", type: e.type };
  }
  if (e.fn === "spawnRes.status" || e.fn === "child.pid" || e.fn === "child.exitCode") {
    // `number | null` / `number | undefined`, constructed type-
    // directedly over the runtime's has/get pairs (exprs.ts).
    if (e.type.kind !== "union")
      throw new InternalCompilerError(`llvm emitter bug: ${e.fn} result is not a union`);
    const def = host.unionsById.get(e.type.unionId);
    const wantUnit = e.fn === "child.pid" ? "undefinedT" : "nullT";
    const f64Tag = def ? def.arms.findIndex((a) => a.kind === "f64") : -1;
    const unitTag = def ? def.arms.findIndex((a) => a.kind === wantUnit) : -1;
    if (f64Tag < 0 || unitTag < 0)
      throw new InternalCompilerError(`llvm emitter bug: ${e.fn} union lacks its arms`);
    const has =
      e.fn === "spawnRes.status"
        ? "scr_spawn_res_has_status"
        : e.fn === "child.pid"
          ? "scr_child_has_pid"
          : "scr_child_has_exit_code";
    const get =
      e.fn === "spawnRes.status"
        ? "scr_spawn_res_status"
        : e.fn === "child.pid"
          ? "scr_child_pid"
          : "scr_child_exit_code";
    const recv = host.emitExpr(e.args[0]!);
    host.declare(`declare zeroext i1 @${has}(ptr)`);
    host.declare(`declare double @${get}(ptr)`);
    const slot = B.slot();
    B.entryAllocas.push(`${slot} = alloca ptr`);
    const hasV = B.tmp();
    B.line(`${hasV} = call zeroext i1 @${has}(ptr ${recv.name})`);
    const lp = B.newLabel("hg.p");
    const la = B.newLabel("hg.a");
    const lj = B.newLabel("hg.j");
    B.condBr(hasV, lp, la);
    B.startBlock(lp);
    const x = B.tmp();
    B.line(`${x} = call double @${get}(ptr ${recv.name})`);
    B.line(
      `store ptr ${host.unionNewOwned(e.type.unionId, f64Tag, { name: x, type: F64 })}, ptr ${slot}`,
    );
    B.br(lj);
    B.startBlock(la);
    B.line(`store ptr ${host.unitInstanceRef(e.type.unionId, unitTag)}, ptr ${slot}`);
    B.br(lj);
    B.startBlock(lj);
    const t = B.tmp();
    B.line(`${t} = load ptr, ptr ${slot}`);
    return host.own({ name: t, type: e.type });
  }
  if (e.fn === "spawnRes.signal") {
    // The `string | null` union (the termination signal's name, null
    // for a normal exit or spawn failure) — the has/get pair wrapped
    // type-directedly.
    if (e.type.kind !== "union")
      throw new InternalCompilerError("llvm emitter bug: spawnRes.signal result is not a union");
    const def = host.unionsById.get(e.type.unionId);
    const strTag = def ? def.arms.findIndex((a) => a.kind === "string") : -1;
    const nullTag = def ? def.arms.findIndex((a) => a.kind === "nullT") : -1;
    if (strTag < 0 || nullTag < 0)
      throw new InternalCompilerError("llvm emitter bug: spawnRes.signal union lacks its arms");
    const recv = host.emitExpr(e.args[0]!);
    host.declare(`declare zeroext i1 @scr_spawn_res_has_signal(ptr)`);
    host.declare(`declare ptr @scr_spawn_res_signal(ptr)`);
    const hasV = B.tmp();
    B.line(`${hasV} = call zeroext i1 @scr_spawn_res_has_signal(ptr ${recv.name})`);
    const rawSlot = B.slot();
    B.entryAllocas.push(`${rawSlot} = alloca ptr`);
    B.line(`store ptr null, ptr ${rawSlot}`);
    const lp = B.newLabel("srs.p");
    const lj = B.newLabel("srs.j");
    B.condBr(hasV, lp, lj);
    B.startBlock(lp);
    const sv = B.tmp();
    B.line(`${sv} = call ptr @scr_spawn_res_signal(ptr ${recv.name}) ; +1`);
    B.line(`store ptr ${sv}, ptr ${rawSlot}`);
    B.br(lj);
    B.startBlock(lj);
    const raw = B.tmp();
    B.line(`${raw} = load ptr, ptr ${rawSlot}`);
    return host.wrapNullable(raw, raw, STRING, strTag, e.type, nullTag);
  }
  if (e.fn === "spawnRes.error") {
    // The `Error | undefined` union, the envGet convention: a spawn
    // failure hands back a fresh +1 %Error (ownership moves into the
    // union box); otherwise the interned undefined arm.
    if (e.type.kind !== "union")
      throw new InternalCompilerError("llvm emitter bug: spawnRes.error result is not a union");
    const def = host.unionsById.get(e.type.unionId);
    const errTag = def
      ? def.arms.findIndex((a) => a.kind === "object" && a.className === "%Error")
      : -1;
    const undefTag = undefinedArmTag(e.type, host.unionsById);
    if (errTag < 0 || undefTag < 0)
      throw new InternalCompilerError("llvm emitter bug: spawnRes.error union lacks its arms");
    const recv = host.emitExpr(e.args[0]!);
    host.declare(`declare ptr @scr_spawn_res_error(ptr)`);
    const raw = B.tmp();
    B.line(`${raw} = call ptr @scr_spawn_res_error(ptr ${recv.name}) ; +1 or NULL`);
    return host.wrapNullable(
      raw,
      raw,
      { kind: "object", className: "%Error" },
      errTag,
      e.type,
      undefTag,
    );
  }
  if (e.fn === "child.stdin" || e.fn === "child.stdout" || e.fn === "child.stderr") {
    // `Writable | null` / `Readable | null` — the child.pid pattern
    // with a REF arm: the runtime answers a +1 handle or NULL.
    if (e.type.kind !== "union")
      throw new InternalCompilerError(`llvm emitter bug: ${e.fn} result is not a union`);
    const def = host.unionsById.get(e.type.unionId);
    const writer = e.fn === "child.stdin";
    const streamTag = def
      ? def.arms.findIndex((a) => a.kind === (writer ? "childWriter" : "childStream"))
      : -1;
    const nullTag = def ? def.arms.findIndex((a) => a.kind === "nullT") : -1;
    if (streamTag < 0 || nullTag < 0)
      throw new InternalCompilerError(`llvm emitter bug: ${e.fn} union lacks its arms`);
    const get = writer
      ? "scr_child_stdin"
      : e.fn === "child.stdout"
        ? "scr_child_stdout"
        : "scr_child_stderr";
    const recv = host.emitExpr(e.args[0]!);
    host.declare(`declare ptr @${get}(ptr)`);
    const raw = B.tmp();
    B.line(`${raw} = call ptr @${get}(ptr ${recv.name}) ; +1 or NULL`);
    return host.wrapNullable(raw, raw, def!.arms[streamTag]!, streamTag, e.type, nullTag);
  }
  if (e.fn === "child.stdioStream") {
    // The general stream representation's stdio read: the child's bridged
    // runtime stream (+1) or NULL for an unpiped slot.
    if (e.type.kind !== "union")
      throw new InternalCompilerError(`llvm emitter bug: ${e.fn} result is not a union`);
    const def = host.unionsById.get(e.type.unionId);
    const streamTag = def ? def.arms.findIndex((a) => a.kind === "object") : -1;
    const nullTag = def ? def.arms.findIndex((a) => a.kind === "nullT") : -1;
    const fd = e.args[1];
    if (streamTag < 0 || nullTag < 0 || fd?.kind !== "numLit")
      throw new InternalCompilerError(`llvm emitter bug: ${e.fn} lacks its arms or slot`);
    const recv = host.emitExpr(e.args[0]!);
    const key = fd.value === 0 ? "stdin" : fd.value === 1 ? "stdout" : "stderr";
    host.declare(`declare ptr @scr_stream_child_stdio(ptr, ptr, ${host.sizeType})`);
    const raw = B.tmp();
    B.line(
      `${raw} = call ptr @scr_stream_child_stdio(ptr ${recv.name}, ptr ${host.cstr(key)}, ${host.sizeType} ${key.length}) ; +1 or NULL`,
    );
    const out = host.wrapNullable(raw, raw, def!.arms[streamTag]!, streamTag, e.type, nullTag);
    host.emitPendingCheck();
    return out;
  }
  if (e.fn === "writer.writeString" || e.fn === "writer.writeBytes") {
    const writer = host.emitExpr(e.args[0]!);
    const data = host.emitExpr(e.args[1]!);
    const sym =
      e.fn === "writer.writeString"
        ? "scr_child_writer_write_string"
        : "scr_child_writer_write_bytes";
    host.declare(`declare zeroext i1 @${sym}(ptr, ptr)`);
    const t = B.tmp();
    B.line(`${t} = call zeroext i1 @${sym}(ptr ${writer.name}, ptr ${data.name})`);
    return { name: t, type: e.type };
  }
  if (e.fn === "writer.end" || e.fn === "writer.destroy") {
    const writer = host.emitExpr(e.args[0]!);
    const sym = e.fn === "writer.end" ? "scr_child_writer_end" : "scr_child_writer_destroy";
    host.declare(`declare void @${sym}(ptr)`);
    B.line(`call void @${sym}(ptr ${writer.name})`);
    return { name: "", type: e.type };
  }
  if (e.fn === "writer.writable") {
    const writer = host.emitExpr(e.args[0]!);
    host.declare(`declare zeroext i1 @scr_child_writer_writable(ptr)`);
    const t = B.tmp();
    B.line(`${t} = call zeroext i1 @scr_child_writer_writable(ptr ${writer.name})`);
    return { name: t, type: e.type };
  }
  if (e.fn === "writer.onDrain" || e.fn === "writer.onFinish" || e.fn === "writer.onError") {
    const writer = host.emitExpr(e.args[0]!);
    const cbT = e.args[1]!.type;
    if (cbT.kind !== "func")
      throw new InternalCompilerError(`llvm emitter bug: ${e.fn} callback not a func`);
    const cb = host.emitExpr(e.args[1]!);
    host.toHeap(cb);
    const once = host.emitExpr(e.args[2]!);
    if (e.fn === "writer.onError") {
      const adapter =
        cbT.params.length === 0 ? "scr_child_err_thunk0" : "scr_child_err_thunk_error";
      host.declare(`declare void @${adapter}(ptr, ptr)`);
      host.declare(`declare void @scr_child_writer_on_error(ptr, ptr, ptr, i1 zeroext)`);
      B.line(
        `call void @scr_child_writer_on_error(ptr ${writer.name}, ptr ${cb.name}, ptr @${adapter}, i1 ${once.name})`,
      );
    } else {
      const sym =
        e.fn === "writer.onDrain" ? "scr_child_writer_on_drain" : "scr_child_writer_on_finish";
      host.declare(`declare void @${sym}(ptr, ptr, i1 zeroext)`);
      B.line(`call void @${sym}(ptr ${writer.name}, ptr ${cb.name}, i1 ${once.name})`);
    }
    return { name: "", type: e.type };
  }
  return host.emitGenericLibCall(e);
}

export function emitAsyncContextLibCall(host: LlvmEmitterContext, e: LibCallExpr): LlValue {
  const B = host.B;
  if (
    e.fn === "timers.setTimeout" ||
    e.fn === "timers.setInterval" ||
    e.fn === "timers.setTimeoutHandle" ||
    e.fn === "timers.setImmediate" ||
    e.fn === "process.nextTick" ||
    e.fn === "timers.queueMicrotask"
  ) {
    // The loop owns the callback until it fires (setTimeout/setImmediate/
    // queueMicrotask) or until clear (setInterval) — the +1 MOVES in;
    // main runs the loop.
    host.usesTimers = true;
    const cb = host.emitExpr(e.args[0]!);
    host.toHeap(cb);
    // Programs that enter AsyncLocalStorage stores schedule through the
    // *_als entry points, which carry the active stores into the callback.
    const sym =
      (mockTimerSym(host, e) ??
        {
          "timers.setTimeout": "scr_set_timeout",
          "timers.setInterval": "scr_set_interval",
          "timers.setTimeoutHandle": "scr_set_timeout_handle",
          "timers.setImmediate": "scr_set_immediate",
          "process.nextTick": "scr_next_tick",
          "timers.queueMicrotask": "scr_queue_microtask",
        }[e.fn]!) + (host.schedulesInContext ? "_als" : "");
    const rest = e.args.slice(1).map((a) => host.emitExpr(a));
    const argList = [`ptr ${cb.name}`, ...rest.map((a) => `${host.llType(a.type)} ${a.name}`)].join(
      ", ",
    );
    const argDecl = ["ptr", ...rest.map((a) => host.llType(a.type))].join(", ");
    if (e.type.kind === "void") {
      host.declare(`declare void @${sym}(${argDecl})`);
      B.line(`call void @${sym}(${argList})`);
      return { name: "", type: e.type };
    }
    host.declare(`declare ${host.llType(e.type)} @${sym}(${argDecl})`);
    const t = B.tmp();
    B.line(`${t} = call ${host.llType(e.type)} @${sym}(${argList})`);
    return host.own({ name: t, type: e.type });
  }
  if (
    e.fn === "timers.unref" ||
    e.fn === "timers.ref" ||
    e.fn === "timers.refresh" ||
    e.fn === "timers.immediateUnref" ||
    e.fn === "timers.immediateRef"
  ) {
    // The chaining forms: bookkeep, then yield the handle itself (the
    // C comma expressions).
    const h = host.emitExpr(e.args[0]!);
    const sym =
      mockTimerSym(host, e) ??
      {
        "timers.unref": "scr_timer_unref",
        "timers.ref": "scr_timer_ref",
        "timers.refresh": "scr_timer_refresh",
        "timers.immediateUnref": "scr_immediate_unref",
        "timers.immediateRef": "scr_immediate_ref",
      }[e.fn];
    host.declare(`declare void @${sym}(double)`);
    B.line(`call void @${sym}(double ${h.name})`);
    return { name: h.name, type: e.type };
  }
  if (e.fn === "timers.clearTimeout" || e.fn === "timers.clearInterval") {
    const h = host.emitExpr(e.args[0]!);
    const sym = mockTimerSym(host, e) ?? "scr_clear_interval";
    host.declare(`declare void @${sym}(double)`);
    B.line(`call void @${sym}(double ${h.name})`);
    return { name: "", type: e.type };
  }
  if (e.fn === "timers.clearNoop") {
    // clearTimeout(null) and friends: Node ignores non-handles
    // without an error — nothing runs (arguments still evaluate).
    for (const a of e.args) host.emitExpr(a);
    return { name: "", type: e.type };
  }
  if (e.fn === "als.bindCallback") {
    // The closure moves into the bound closure, whose entry is the
    // per-signature thunk; with nothing to bind the runtime answers the
    // closure itself.
    if (e.type.kind !== "func")
      throw new InternalCompilerError("llvm emitter bug: als.bindCallback on non-func");
    const cb = host.emitExpr(e.args[0]!);
    const always = host.emitExpr(e.args[1]!);
    host.toHeap(cb);
    const thunk = boundCallbackThunk(host, e.type);
    host.declare("declare ptr @scr_als_bind_closure(ptr, ptr, i1 zeroext)");
    const t = B.tmp();
    B.line(
      `${t} = call ptr @scr_als_bind_closure(ptr ${cb.name}, ptr @${thunk}, i1 ${always.name})`,
    );
    return host.own({ name: t, type: e.type });
  }
  return host.emitGenericLibCall(e);
}

/** The entry of a callback bound to an AsyncLocalStorage context, one per
 * callback signature: enters the captured context, calls the target with
 * the same arguments (the callValue ABI) and restores the caller's
 * context, also when the target leaves an exception pending. */
function boundCallbackThunk(host: LlvmEmitterContext, cbT: IrType & { kind: "func" }): string {
  const key = `alsbound:${typeKey(cbT)}`;
  let sym = host.resolveThunks.get(key);
  if (sym) return sym;
  sym = host.contentSymbol("sc_alsbound_", key);
  host.resolveThunks.set(key, sym);
  host.journal?.allocated(sym, "boundCallbackThunk", [cbT]);
  host.declare("declare ptr @scr_als_bound_target(ptr)");
  host.declare("declare ptr @scr_als_bound_enter(ptr)");
  host.declare("declare void @scr_als_bound_leave(ptr, ptr)");
  const ret = host.llType(cbT.ret);
  const params = cbT.params.map((p, i) => `${host.llType(p)} %a${i}`);
  const call = `call ${ret} %fn(${["ptr %cb", ...params].join(", ")})`;
  host.resolveThunkDefs.push(
    `define internal ${ret} @${sym}(${["ptr %self", ...params].join(", ")}) ${FN_ATTRS} { ; AsyncLocalStorage-bound callback ${typeKey(cbT)}`,
    `entry:`,
    `  %cb = call ptr @scr_als_bound_target(ptr %self)`,
    `  %prev = call ptr @scr_als_bound_enter(ptr %self)`,
    `  %fnp = getelementptr inbounds %ScrClosure, ptr %cb, i64 0, i32 1`,
    `  %fn = load ptr, ptr %fnp`,
    ret === "void" ? `  ${call}` : `  %r = ${call}`,
    `  call void @scr_als_bound_leave(ptr %prev, ptr %cb)`,
    ret === "void" ? `  ret void` : `  ret ${ret} %r`,
    `}`,
    ``,
  );
  host.journal?.built();
  return sym;
}

registerReplay("boundCallbackThunk", (host, args) =>
  boundCallbackThunk(host, args[0] as IrType & { kind: "func" }),
);

export function emitProcessLibCall(host: LlvmEmitterContext, e: LibCallExpr): LlValue {
  const B = host.B;
  if (e.fn === "process.forkTarget") {
    const count = host.emitExpr(e.args[0]!);
    host.declare(`declare double @scr_process_fork_target(double)`);
    const out = B.tmp();
    B.line(`${out} = call double @scr_process_fork_target(double ${count.name})`);
    return { name: out, type: e.type };
  }
  if (e.fn === "process.connected") {
    host.declare(`declare zeroext i1 @scr_process_ipc_connected()`);
    const out = B.tmp();
    B.line(`${out} = call i1 @scr_process_ipc_connected()`);
    return { name: out, type: e.type };
  }
  if (e.fn === "process.send" || e.fn === "process.sendCb") {
    host.usesTimers = true;
    const json = host.emitExpr(e.args[0]!);
    const sym = e.fn === "process.send" ? "scr_process_ipc_send" : "scr_process_ipc_send_cb";
    let suffix = "";
    let decl = "ptr";
    if (e.fn === "process.sendCb") {
      const cbT = e.args[1]!.type;
      if (cbT.kind !== "func")
        throw new InternalCompilerError("llvm emitter bug: process.send callback not a func");
      const cb = host.emitExpr(e.args[1]!);
      host.toHeap(cb);
      suffix = `, ptr ${cb.name}, ptr @${host.ipcSendThunkFor(cbT)}`;
      decl += ", ptr, ptr";
    }
    host.declare(`declare zeroext i1 @${sym}(${decl})`);
    const out = B.tmp();
    B.line(`${out} = call i1 @${sym}(ptr ${json.name}${suffix})`);
    return { name: out, type: e.type };
  }
  if (e.fn === "process.disconnect") {
    host.usesTimers = true;
    host.declare(`declare void @scr_process_ipc_disconnect()`);
    B.line(`call void @scr_process_ipc_disconnect()`);
    return { name: "", type: e.type };
  }
  if (e.fn === "process.onMessage" || e.fn === "process.onDisconnect") {
    host.usesTimers = true;
    const cbT = e.args[0]!.type;
    if (cbT.kind !== "func")
      throw new InternalCompilerError(`llvm emitter bug: ${e.fn} callback not a func`);
    const cb = host.emitExpr(e.args[0]!);
    const once = host.emitExpr(e.args[1]!);
    host.toHeap(cb);
    if (e.fn === "process.onMessage") {
      host.declare(`declare void @scr_process_ipc_on_message(ptr, ptr, i1 zeroext)`);
      B.line(
        `call void @scr_process_ipc_on_message(ptr ${cb.name}, ptr @${host.ipcMessageThunkFor(cbT)}, i1 ${once.name})`,
      );
    } else {
      host.declare(`declare void @scr_process_ipc_on_disconnect(ptr, i1 zeroext)`);
      B.line(`call void @scr_process_ipc_on_disconnect(ptr ${cb.name}, i1 ${once.name})`);
    }
    return { name: "", type: e.type };
  }
  if (e.fn === "process.stdoutWriteBytesCb" || e.fn === "process.stderrWriteBytesCb") {
    // All arguments evaluate before bytes are submitted. The callback
    // then moves into the next-tick entry and its error-first adapter
    // constructs Node's success `null` argument when the tick fires.
    host.usesTimers = true;
    const args = e.args.map((a) => host.emitExpr(a));
    const cbT = e.args[2]!.type;
    if (cbT.kind !== "func")
      throw new InternalCompilerError("llvm emitter bug: process write callback not a func");
    host.toHeap(args[2]!);
    const adapter = host.fsRenameThunkFor(cbT);
    const write =
      e.fn === "process.stdoutWriteBytesCb"
        ? "scr_process_stdout_write_bytes"
        : "scr_process_stderr_write_bytes";
    host.declare(`declare zeroext i1 @${write}(ptr, ptr)`);
    host.declare(`declare void @scr_process_write_callback(ptr, ptr)`);
    const out = B.tmp();
    B.line(`${out} = call i1 @${write}(ptr ${args[0]!.name}, ptr ${args[1]!.name})`);
    B.line(`call void @scr_process_write_callback(ptr ${args[2]!.name}, ptr @${adapter})`);
    return { name: out, type: e.type };
  }
  if (e.fn === "stdin.nextChunk") {
    // +1 promise of the next chunk (empty = EOF); the await parks the
    // fiber while the loop watches fd 0.
    host.usesTimers = true;
    host.declare(`declare ptr @scr_stdin_next_chunk()`);
    const t = B.tmp();
    B.line(`${t} = call ptr @scr_stdin_next_chunk()`);
    return host.own({ name: t, type: e.type });
  }
  if (e.fn === "stdin.onData" || e.fn === "stdin.onEnd" || e.fn === "stdin.onError") {
    // A stdin listener is a consumer: the loop watches fd 0 and stays
    // alive until EOF, so main must run it. The callback MOVES in.
    host.usesTimers = true;
    const cbT = e.args[0]!.type;
    if (cbT.kind !== "func")
      throw new InternalCompilerError(`llvm emitter bug: ${e.fn} callback not a func`);
    const cb = host.emitExpr(e.args[0]!);
    const once = host.emitExpr(e.args[1]!);
    host.toHeap(cb);
    if (e.fn === "stdin.onEnd") {
      host.declare(`declare void @scr_stdin_on_end(ptr, i1 zeroext)`);
      B.line(`call void @scr_stdin_on_end(ptr ${cb.name}, i1 ${once.name})`);
      return { name: "", type: e.type };
    }
    // A string listener takes the setEncoding-decoded chunk.
    const stringData = e.fn === "stdin.onData" && cbT.params[0]?.kind === "string";
    const adapter =
      e.fn === "stdin.onData"
        ? cbT.params.length === 0
          ? "scr_stdin_data_thunk0"
          : stringData
            ? "scr_stdin_data_thunk_str"
            : "scr_stdin_data_thunk_bytes"
        : cbT.params.length === 0
          ? "scr_child_err_thunk0"
          : "scr_child_err_thunk_error";
    const sym =
      e.fn === "stdin.onData"
        ? stringData
          ? "scr_stdin_on_data_str"
          : "scr_stdin_on_data"
        : "scr_stdin_on_error";
    host.declare(`declare void @${adapter}(ptr, ptr)`);
    host.declare(`declare void @${sym}(ptr, ptr, i1 zeroext)`);
    B.line(`call void @${sym}(ptr ${cb.name}, ptr @${adapter}, i1 ${once.name})`);
    return { name: "", type: e.type };
  }
  if (e.fn === "stdin.onKeypress") {
    // The listener, a checked-dynamic function, joins process.stdin's
    // keypress listeners (the runtime retains it).
    host.usesTimers = true;
    const cb = host.emitExpr(e.args[0]!);
    const once = host.emitExpr(e.args[1]!);
    host.declare(`declare void @scr_rl_stdin_on_keypress(ptr, i1 zeroext)`);
    B.line(`call void @scr_rl_stdin_on_keypress(ptr ${cb.name}, i1 ${once.name})`);
    return { name: "", type: e.type };
  }
  if (e.fn === "process.onSignal") {
    host.usesTimers = true;
    const sig = host.emitExpr(e.args[0]!);
    const cb = host.emitExpr(e.args[1]!);
    const once = host.emitExpr(e.args[2]!);
    host.declare(`declare void @scr_signal_on(ptr, ptr, i1 zeroext)`);
    B.line(`call void @scr_signal_on(ptr ${sig.name}, ptr ${cb.name}, i1 ${once.name})`);
    host.emitPendingCheck();
    return { name: "", type: e.type };
  }
  if (e.fn === "process.onExit") {
    // Runtime adapters cover both shapes (the code is a plain double);
    // the registry owns the callback.
    const cbT = e.args[0]!.type;
    if (cbT.kind !== "func")
      throw new InternalCompilerError("llvm emitter bug: process.onExit callback not a func");
    const cb = host.emitExpr(e.args[0]!);
    const once = host.emitExpr(e.args[1]!);
    host.toHeap(cb);
    const adapter = cbT.params.length === 0 ? "scr_exit_thunk0" : "scr_exit_thunk_code";
    host.declare(`declare void @${adapter}(ptr, double)`);
    host.declare(`declare void @scr_process_on_exit(ptr, ptr, i1 zeroext)`);
    B.line(`call void @scr_process_on_exit(ptr ${cb.name}, ptr @${adapter}, i1 ${once.name})`);
    return { name: "", type: e.type };
  }
  if (e.fn === "process.envGet" || e.fn === "process.columns" || e.fn === "process.rows") {
    // getenv(3) / ioctl(TIOCGWINSZ): the runtime answers a +1 string or
    // NULL (a width or a negative sentinel); the union construction is
    // type-directed HERE — present wraps the value arm, absent yields
    // the interned immortal undefined-arm instance.
    if (e.type.kind !== "union")
      throw new InternalCompilerError(`llvm emitter bug: ${e.fn} result is not a union`);
    const def = host.unionsById.get(e.type.unionId);
    const undefTag = undefinedArmTag(e.type, host.unionsById);
    const isEnv = e.fn === "process.envGet";
    const valTag = def ? def.arms.findIndex((a) => a.kind === (isEnv ? "string" : "f64")) : -1;
    if (valTag < 0 || undefTag < 0)
      throw new InternalCompilerError(`llvm emitter bug: ${e.fn} union lacks its arms`);
    const args = e.args.map((a) => host.emitExpr(a));
    const slot = B.slot();
    B.entryAllocas.push(`${slot} = alloca ptr`);
    const lp = B.newLabel("env.p");
    const la = B.newLabel("env.a");
    const lj = B.newLabel("env.j");
    const raw = B.tmp();
    const present = B.tmp();
    if (isEnv) {
      host.declare(`declare ptr @scr_env_get(ptr)`);
      B.line(`${raw} = call ptr @scr_env_get(ptr ${args[0]!.name})`);
      B.line(`${present} = icmp ne ptr ${raw}, null`);
    } else {
      const runtimeFn = e.fn === "process.rows" ? "scr_process_rows" : "scr_process_columns";
      host.declare(`declare double @${runtimeFn}(double)`);
      B.line(`${raw} = call double @${runtimeFn}(double ${args[0]!.name})`);
      B.line(`${present} = fcmp oge double ${raw}, ${f64Lit(0)}`);
    }
    B.condBr(present, lp, la);
    B.startBlock(lp);
    B.line(
      `store ptr ${host.unionNewOwned(e.type.unionId, valTag, { name: raw, type: isEnv ? STRING : F64 })}, ptr ${slot}`,
    );
    B.br(lj);
    B.startBlock(la);
    B.line(`store ptr ${host.unitInstanceRef(e.type.unionId, undefTag)}, ptr ${slot}`);
    B.br(lj);
    B.startBlock(lj);
    const t = B.tmp();
    B.line(`${t} = load ptr, ptr ${slot}`);
    return host.own({ name: t, type: e.type });
  }
  return host.emitGenericLibCall(e);
}

export function emitErrorsEventsLibCall(host: LlvmEmitterContext, e: LibCallExpr): LlValue {
  const B = host.B;
  if (e.fn === "error.argTypeThrow") {
    // Always throws with the runtime-rendered Received tail (the
    // error.nodeThrow dummy pattern). Borrows all three.
    const an = host.emitExpr(e.args[0]!);
    const ex = host.emitExpr(e.args[1]!);
    const got = host.emitExpr(e.args[2]!);
    host.declare(`declare void @scr_throw_arg_type(ptr, ptr, ptr)`);
    B.line(`call void @scr_throw_arg_type(ptr ${an.name}, ptr ${ex.name}, ptr ${got.name})`);
    const ty = host.llType(e.type);
    if (ty === "void") {
      host.emitAlwaysPendingUnwind();
      return { name: "", type: e.type };
    }
    const dummy = ty === "double" ? f64Lit(0) : ty === "i1" ? "false" : "null";
    const out = host.own({ name: dummy, type: e.type });
    host.emitAlwaysPendingUnwind();
    return out;
  }
  if (e.fn === "error.propTypeThrow") {
    // The property flavor of argTypeThrow — same always-throw shape.
    const an = host.emitExpr(e.args[0]!);
    const ex = host.emitExpr(e.args[1]!);
    const got = host.emitExpr(e.args[2]!);
    host.declare(`declare void @scr_throw_prop_type(ptr, ptr, ptr)`);
    B.line(`call void @scr_throw_prop_type(ptr ${an.name}, ptr ${ex.name}, ptr ${got.name})`);
    const ty = host.llType(e.type);
    if (ty === "void") {
      host.emitAlwaysPendingUnwind();
      return { name: "", type: e.type };
    }
    const dummy = ty === "double" ? f64Lit(0) : ty === "i1" ? "false" : "null";
    const out = host.own({ name: dummy, type: e.type });
    host.emitAlwaysPendingUnwind();
    return out;
  }
  if (e.fn === "error.nodeThrow") {
    // The compiler-resolved Node-parity throw (always throws — the
    // typed dummy is abandoned by the pending check's unwind).
    const kind = host.emitExpr(e.args[0]!);
    const code = host.emitExpr(e.args[1]!);
    const msg = host.emitExpr(e.args[2]!);
    host.declare(`declare void @scr_throw_node_coded(double, ptr, ptr)`);
    B.line(
      `call void @scr_throw_node_coded(double ${kind.name}, ptr ${code.name}, ptr ${msg.name})`,
    );
    const ty = host.llType(e.type);
    if (ty === "void") {
      host.emitAlwaysPendingUnwind();
      return { name: "", type: e.type };
    }
    const dummy = ty === "double" ? f64Lit(0) : ty === "i1" ? "false" : "null";
    const out = host.own({ name: dummy, type: e.type });
    host.emitAlwaysPendingUnwind();
    return out;
  }
  if (e.fn === "events.once" || e.fn === "events.onceSignal") {
    // (recv, name, boxer, errorBoxer, listenForError[, signal]):
    // scr_events_once registers one-shot typed listeners behind adapters
    // that box the event's tuple (and the 'error' tuple) into the fulfilled
    // array. The runtime retains the boxers; the frame's temporaries
    // release as usual. May-throw ('newListener' meta listeners run
    // inside). The signal form's adapters end in its own fire entry.
    const boxerT = e.args[2]!.type;
    const errorT = e.args[3]!.type;
    if (boxerT.kind !== "func" || errorT.kind !== "func")
      throw new InternalCompilerError(`llvm emitter bug: ${e.fn} boxer not a func`);
    const signal = e.fn === "events.onceSignal";
    const args = e.args.map((a) => host.emitExpr(a));
    const fire = signal ? "scr_events_once_signal_fire" : undefined;
    const event = host.emitterOnceAdapter(boxerT, fire);
    const error = host.emitterOnceAdapter(errorT, fire);
    const entry = signal ? "scr_events_once_signal" : "scr_events_once";
    host.declare(
      `declare ptr @${entry}(ptr, ptr, ptr, ptr, ptr, ptr, ptr, ptr${signal ? ", ptr" : ""})`,
    );
    const errorBoxer = B.tmp();
    B.line(`${errorBoxer} = select i1 ${args[4]!.name}, ptr ${args[3]!.name}, ptr null`);
    const t = B.tmp();
    B.line(
      `${t} = call ptr @${entry}(ptr ${args[0]!.name}, ptr ${args[1]!.name}, ` +
        `ptr ${args[2]!.name}, ptr @${event.fn}, ptr @${event.shim}, ` +
        `ptr ${errorBoxer}, ptr @${error.fn}, ptr @${error.shim}` +
        `${signal ? `, ptr ${args[5]!.name}` : ""})`,
    );
    const out = host.own({ name: t, type: e.type });
    host.emitPendingCheck();
    return out;
  }
  if (e.fn === "emitter.on") {
    // (recv, name, cb /moves — the identity/, once, prepend): the
    // listener registers through scr_emitter_on_via with an emitted
    // fixed-arity adapter closure (what emit invokes) and the runtime's
    // matching va_list shim across the runtime ABI. May-throw ('newListener' meta
    // listeners run inside).
    const cbT = e.args[2]!.type;
    if (cbT.kind !== "func")
      throw new InternalCompilerError("llvm emitter bug: emitter.on listener not a func");
    const args = e.args.map((a) => host.emitExpr(a));
    const { fn: adapterFn, shim } = host.emitterFixedAdapter(cbT);
    // The wrapper's capture box owns its OWN +1 of the listener; the
    // frame's +1 moves in as the entry's identity (orig).
    host.declare(`declare ptr @scr_closure_retain_v(ptr)`);
    const cbr = B.tmp();
    B.line(`${cbr} = call ptr @scr_closure_retain_v(ptr ${args[2]!.name})`);
    const wrapped = host.wrapEmitterListener(cbr, adapterFn);
    host.toHeap(args[2]!);
    host.declare(
      `declare ptr @scr_emitter_on_via(ptr, ptr, ptr, ptr, ptr, i1 zeroext, i1 zeroext)`,
    );
    const t = B.tmp();
    B.line(
      `${t} = call ptr @scr_emitter_on_via(ptr ${args[0]!.name}, ptr ${args[1]!.name}, ` +
        `ptr ${args[2]!.name}, ptr ${wrapped}, ptr @${shim}, i1 ${args[3]!.name}, i1 ${args[4]!.name})`,
    );
    const out = host.own({ name: t, type: e.type });
    host.emitPendingCheck();
    return out;
  }
  if (e.fn === "emitter.onDyn") {
    // (recv, name, cb /borrowed dyn — the identity/, adapter /moves/,
    // once, prepend): the frontend's dyn adapter (it boxes the tuple to
    // dyn and calls the original through the checked-dynamic machinery)
    // rides behind the same fixed-arity wrapper; the runtime keeps the
    // dyn box's underlying closure as the entry's identity.
    const adT = e.args[3]!.type;
    if (adT.kind !== "func")
      throw new InternalCompilerError("llvm emitter bug: emitter.onDyn adapter not a func");
    const args = e.args.map((a) => host.emitExpr(a));
    const { fn: adapterFn, shim } = host.emitterFixedAdapter(adT);
    host.toHeap(args[3]!); // the frame's +1 moves into the wrapper's box
    const wrapped = host.wrapEmitterListener(args[3]!.name, adapterFn);
    host.declare(
      `declare ptr @scr_emitter_on_dyn(ptr, ptr, ptr, ptr, ptr, i1 zeroext, i1 zeroext)`,
    );
    const t = B.tmp();
    B.line(
      `${t} = call ptr @scr_emitter_on_dyn(ptr ${args[0]!.name}, ptr ${args[1]!.name}, ` +
        `ptr ${args[2]!.name}, ptr ${wrapped}, ptr @${shim}, i1 ${args[4]!.name}, i1 ${args[5]!.name})`,
    );
    const out = host.own({ name: t, type: e.type });
    host.emitPendingCheck();
    return out;
  }
  if (e.fn === "emitter.emit") {
    // The variadic dispatch: the event's unified tuple rides the C
    // variadic tail POINTER-CLASSED. Scalar values ride pointers to
    // call-lived stack slots, while reference values ride directly; the
    // fixed shim can therefore read one pointer-width slot per argument
    // on both wasm32 and native targets. Every argument is borrowed. May
    // throw (listeners run inside).
    const args = e.args.map((a) => host.emitExpr(a));
    const tuple = args.slice(2).map((a) => {
      const ty = host.llType(a.type);
      if (ty === "double" || ty === "i1") {
        const slot = B.slot();
        B.entryAllocas.push(`${slot} = alloca ${ty} ; EventEmitter scalar argument`);
        B.line(`store ${ty} ${a.name}, ptr ${slot}`);
        return `ptr ${slot}`;
      }
      return `ptr ${a.name}`;
    });
    host.declare(`declare zeroext i1 @scr_emitter_emit(ptr, ptr, ...)`);
    const call =
      `call zeroext i1 (ptr, ptr, ...) @scr_emitter_emit(` +
      [`ptr ${args[0]!.name}`, `ptr ${args[1]!.name}`, ...tuple].join(", ") +
      `)`;
    if (e.type.kind === "void") {
      B.line(`${B.tmp()} = ${call}`);
      host.emitPendingCheck();
      return { name: "", type: e.type };
    }
    const t = B.tmp();
    B.line(`${t} = ${call}`);
    host.emitPendingCheck();
    return { name: t, type: e.type };
  }
  if (e.fn === "emitter.emitFlex" || e.fn === "emitter.emitAny") {
    const args = e.args.map((a) => host.emitExpr(a));
    const n = args.length - 2;
    let payload = "null";
    if (n > 0) {
      const arr = B.slot();
      B.entryAllocas.push(`${arr} = alloca [${n} x ptr]`);
      for (let i = 0; i < n; i++) {
        const slot = B.tmp();
        B.line(`${slot} = getelementptr inbounds [${n} x ptr], ptr ${arr}, i64 0, i64 ${i}`);
        B.line(`store ptr ${args[i + 2]!.name}, ptr ${slot}`);
      }
      payload = arr;
    }
    const sym = e.fn === "emitter.emitAny" ? "scr_emitter_emit_any" : "scr_emitter_emit_flex";
    host.declare(`declare zeroext i1 @${sym}(ptr, ptr, ptr, ${host.sizeType})`);
    const t = B.tmp();
    B.line(
      `${t} = call i1 @${sym}(ptr ${args[0]!.name}, ptr ${args[1]!.name}, ptr ${payload}, ${host.sizeType} ${n})`,
    );
    host.emitPendingCheck();
    return { name: t, type: e.type };
  }
  if (e.fn === "emitter.emitMixed") {
    // (recv, name, k, ...k dyn arguments, ...converted tuple): the dyn
    // arguments ride an exact-length array like emitFlex, the tuple the
    // pointer-classed variadic tail like emitter.emit. Borrowed; may throw.
    const count = e.args[2]!;
    const k = count.kind === "numLit" ? count.value : 0;
    const args = [e.args[0]!, e.args[1]!, ...e.args.slice(3)].map((a) => host.emitExpr(a));
    let payload = "null";
    if (k > 0) {
      const arr = B.slot();
      B.entryAllocas.push(`${arr} = alloca [${k} x ptr]`);
      for (let i = 0; i < k; i++) {
        const slot = B.tmp();
        B.line(`${slot} = getelementptr inbounds [${k} x ptr], ptr ${arr}, i64 0, i64 ${i}`);
        B.line(`store ptr ${args[i + 2]!.name}, ptr ${slot}`);
      }
      payload = arr;
    }
    const tuple = args.slice(2 + k).map((a) => {
      const ty = host.llType(a.type);
      if (ty === "double" || ty === "i1") {
        const slot = B.slot();
        B.entryAllocas.push(`${slot} = alloca ${ty} ; EventEmitter scalar argument`);
        B.line(`store ${ty} ${a.name}, ptr ${slot}`);
        return `ptr ${slot}`;
      }
      return `ptr ${a.name}`;
    });
    host.declare(
      `declare zeroext i1 @scr_emitter_emit_mixed(ptr, ptr, ptr, ${host.sizeType}, ...)`,
    );
    const t = B.tmp();
    B.line(
      `${t} = call zeroext i1 (ptr, ptr, ptr, ${host.sizeType}, ...) @scr_emitter_emit_mixed(` +
        [
          `ptr ${args[0]!.name}`,
          `ptr ${args[1]!.name}`,
          `ptr ${payload}`,
          `${host.sizeType} ${k}`,
          ...tuple,
        ].join(", ") +
        `)`,
    );
    host.emitPendingCheck();
    return { name: t, type: e.type };
  }
  if (e.fn === "emitter.emitData") {
    // A user emit('data', chunk) on a stream-rooted receiver: fill the
    // matching payload slot of the three-slot 'data' ABI (bytes, string,
    // object-mode value), NULL the others; a checked-dynamic chunk fills
    // them by tag (scr_stream_emit_value).
    const args = e.args.map((a) => host.emitExpr(a));
    const chunkT = e.args[2]!.type;
    const t = B.tmp();
    if (chunkT.kind === "dyn") {
      host.declare(`declare zeroext i1 @scr_stream_emit_value(ptr, ptr, ptr)`);
      B.line(
        `${t} = call zeroext i1 @scr_stream_emit_value(ptr ${args[0]!.name}, ptr ${args[1]!.name}, ptr ${args[2]!.name})`,
      );
    } else {
      const slots =
        chunkT.kind === "string"
          ? [`ptr null`, `ptr ${args[2]!.name}`, `ptr null`]
          : [`ptr ${args[2]!.name}`, `ptr null`, `ptr null`];
      host.declare(`declare zeroext i1 @scr_emitter_emit(ptr, ptr, ...)`);
      B.line(
        `${t} = call zeroext i1 (ptr, ptr, ...) @scr_emitter_emit(ptr ${args[0]!.name}, ptr ${args[1]!.name}, ${slots.join(", ")})`,
      );
    }
    host.emitPendingCheck();
    return e.type.kind === "void" ? { name: "", type: e.type } : { name: t, type: e.type };
  }
  if (e.fn === "emitter.onData" || e.fn === "emitter.onDataDyn") {
    // The stream-'data' registration: same runtime entries as
    // emitter.on/onDyn, but the DATA adapter (the three-slot payload ABI
    // — scr_stream_emit_data) behind the arity-3 fixed shim.
    const isDyn = e.fn === "emitter.onDataDyn";
    const cbT = e.args[isDyn ? 3 : 2]!.type;
    if (cbT.kind !== "func")
      throw new InternalCompilerError(`llvm emitter bug: ${e.fn} listener not a func`);
    const args = e.args.map((a) => host.emitExpr(a));
    const adapterFn = host.streamDataAdapter(cbT);
    host.declare(`declare void @scr_ee_inv_fixed3(ptr, ptr)`);
    const t = B.tmp();
    if (isDyn) {
      host.toHeap(args[3]!);
      const wrapped = host.wrapEmitterListener(args[3]!.name, adapterFn);
      host.declare(
        `declare ptr @scr_emitter_on_dyn(ptr, ptr, ptr, ptr, ptr, i1 zeroext, i1 zeroext)`,
      );
      B.line(
        `${t} = call ptr @scr_emitter_on_dyn(ptr ${args[0]!.name}, ptr ${args[1]!.name}, ` +
          `ptr ${args[2]!.name}, ptr ${wrapped}, ptr @scr_ee_inv_fixed3, i1 ${args[4]!.name}, i1 ${args[5]!.name})`,
      );
    } else {
      host.declare(`declare ptr @scr_closure_retain_v(ptr)`);
      const cbr = B.tmp();
      B.line(`${cbr} = call ptr @scr_closure_retain_v(ptr ${args[2]!.name})`);
      const wrapped = host.wrapEmitterListener(cbr, adapterFn);
      host.toHeap(args[2]!);
      host.declare(
        `declare ptr @scr_emitter_on_via(ptr, ptr, ptr, ptr, ptr, i1 zeroext, i1 zeroext)`,
      );
      B.line(
        `${t} = call ptr @scr_emitter_on_via(ptr ${args[0]!.name}, ptr ${args[1]!.name}, ` +
          `ptr ${args[2]!.name}, ptr ${wrapped}, ptr @scr_ee_inv_fixed3, i1 ${args[3]!.name}, i1 ${args[4]!.name})`,
      );
    }
    const out = host.own({ name: t, type: e.type });
    host.emitPendingCheck();
    return out;
  }
  if (e.fn === "error.new" || e.fn === "error.newOptions") {
    // Which builtin the runtime constructs is named by the RESULT type;
    // Arguments are borrowed. Raw messages may run a throwing coercion.
    if (e.type.kind !== "object")
      throw new InternalCompilerError("llvm emitter bug: error.new result is not a class");
    const rec = RUNTIME_ERROR_CLASSES.get(e.type.className);
    if (!rec) throw new InternalCompilerError(`llvm emitter bug: error.new of ${e.type.className}`);
    const msg = host.emitExpr(e.args[0]!);
    const options = e.fn === "error.newOptions" ? host.emitExpr(e.args[1]!) : null;
    const sym = options ? "scr_error_new_options" : "scr_error_new";
    host.declare(`declare ptr @${sym}(i32, ptr${options ? ", ptr" : ""})`);
    const t = B.tmp();
    B.line(
      `${t} = call ptr @${sym}(i32 ${rec.kind}, ptr ${msg.name}${options ? `, ptr ${options.name}` : ""})`,
    );
    const out = host.own({ name: t, type: e.type });
    if (options) host.emitPendingCheck();
    return out;
  }
  if (e.fn === "error.ctor" || e.fn === "error.ctorOptions") {
    // super(message) into the builtin base: stamps name/message on the
    // receiver (borrowed, like the message). The RECEIVER'S static class
    // names which builtin name to stamp.
    const recvT = e.args[0]!.type;
    if (recvT.kind !== "object")
      throw new InternalCompilerError("llvm emitter bug: error.ctor receiver is not a class");
    const rec = RUNTIME_ERROR_CLASSES.get(recvT.className);
    if (!rec) throw new InternalCompilerError(`llvm emitter bug: error.ctor on ${recvT.className}`);
    const args = e.args.map((a) => host.emitExpr(a));
    const options = e.fn === "error.ctorOptions" ? args[2]! : null;
    const sym = options ? "scr_error_init_options" : "scr_error_init";
    host.declare(`declare void @${sym}(ptr, i32, ptr${options ? ", ptr" : ""})`);
    B.line(
      `call void @${sym}(ptr ${args[0]!.name}, i32 ${rec.kind}, ptr ${args[1]!.name}${options ? `, ptr ${options.name}` : ""})`,
    );
    if (options) host.emitPendingCheck();
    return { name: "", type: e.type };
  }
  if (e.fn === "error.code") {
    // `string | undefined`, constructed type-directedly like
    // process.envGet: the runtime answers +1 or NULL (the receiver may
    // be a user subclass — the code slot sits in its ScrError prefix).
    if (e.type.kind !== "union")
      throw new InternalCompilerError("llvm emitter bug: error.code result is not a union");
    const def = host.unionsById.get(e.type.unionId);
    const strTag = def ? def.arms.findIndex((a) => a.kind === "string") : -1;
    const undefTag = undefinedArmTag(e.type, host.unionsById);
    if (strTag < 0 || undefTag < 0)
      throw new InternalCompilerError("llvm emitter bug: error.code union lacks its arms");
    const recv = host.emitExpr(e.args[0]!);
    host.declare(`declare ptr @scr_error_code(ptr)`);
    const raw = B.tmp();
    B.line(`${raw} = call ptr @scr_error_code(ptr ${recv.name})`);
    return host.wrapNullable(raw, raw, STRING, strTag, e.type, undefTag);
  }
  return host.emitGenericLibCall(e);
}
