/* Focused LLVM library-call emission extracted from emitter.ts. */
import { InternalCompilerError } from "../../errors.js";
import { undefinedArmTag } from "../../ir/analysis.js";
import { F64, RUNTIME_ERROR_CLASSES, STRING } from "../../ir/ir.js";
import type { LlvmEmitterContext, LibCallExpr, LlValue } from "./expr-context.js";
import { f64Lit } from "./common.js";

export function emitChildProcessLibCall(host: LlvmEmitterContext, e: LibCallExpr): LlValue {
    const B = host.B;
    if (e.fn === "cp.spawn" || e.fn === "cp.spawnOpts") {
      // child_process.spawn: the child starts NOW (posix_spawnp); the
      // loop reaps it and fires its listeners. Never throws — spawn
      // failure defers to "error".
      host.usesTimers = true;
      const sym = e.fn === "cp.spawn" ? "scr_spawn" : "scr_spawn_opts";
      const args = e.args.map((a) => host.emitExpr(a));
      const argDecl = args.map((a) => (host.llType(a.type) === "i1" ? "i1 zeroext" : host.llType(a.type))).join(", ");
      host.declare(`declare ptr @${sym}(${argDecl})`);
      const t = B.tmp();
      B.line(`${t} = call ptr @${sym}(${args.map((a) => `${host.llType(a.type)} ${a.name}`).join(", ")})`);
      return host.own({ name: t, type: e.type });
    }
    if (e.fn === "child.onExit") {
      // The callback MOVES into the child's registry; the third
      // ingredient is the ADAPTER — emitted per callback shape, because
      // the `number | null` union's tags are program data (a zero-param
      // listener gets the runtime's ignoring thunk).
      const cbT = e.args[1]!.type;
      if (cbT.kind !== "func") throw new InternalCompilerError("llvm emitter bug: child.onExit callback not a func");
      const child = host.emitExpr(e.args[0]!);
      const cb = host.emitExpr(e.args[1]!);
      host.moveTemp(cb);
      let adapter: string;
      if (cbT.params.length === 0) {
        adapter = "scr_child_exit_thunk0";
        host.declare(`declare void @scr_child_exit_thunk0(ptr, i1 zeroext, double, ptr)`);
      } else if (cbT.params.length === 1) {
        adapter = host.childExitThunkFor(cbT.params[0]!);
      } else {
        adapter = host.childExitSignalThunkFor(cbT.params[0]!, cbT.params[1]!);
      }
      host.declare(`declare void @scr_child_on_exit(ptr, ptr, ptr)`);
      B.line(`call void @scr_child_on_exit(ptr ${child.name}, ptr ${cb.name}, ptr @${adapter})`);
      return { name: "", type: e.type };
    }
    if (e.fn === "child.onError") {
      // Both error-listener shapes have runtime-provided adapters
      // (constructing the %Error instance needs no program types).
      const cbT = e.args[1]!.type;
      if (cbT.kind !== "func") throw new InternalCompilerError("llvm emitter bug: child.onError callback not a func");
      const child = host.emitExpr(e.args[0]!);
      const cb = host.emitExpr(e.args[1]!);
      host.moveTemp(cb);
      const adapter = cbT.params.length === 0 ? "scr_child_err_thunk0" : "scr_child_err_thunk_error";
      host.declare(`declare void @${adapter}(ptr, ptr)`);
      host.declare(`declare void @scr_child_on_error(ptr, ptr, ptr)`);
      B.line(`call void @scr_child_on_error(ptr ${child.name}, ptr ${cb.name}, ptr @${adapter})`);
      return { name: "", type: e.type };
    }
    if (e.fn === "spawnRes.status" || e.fn === "child.pid" || e.fn === "child.exitCode") {
      // `number | null` / `number | undefined`, constructed type-
      // directedly over the runtime's has/get pairs (exprs.ts).
      if (e.type.kind !== "union") throw new InternalCompilerError(`llvm emitter bug: ${e.fn} result is not a union`);
      const def = host.unionsById.get(e.type.unionId);
      const wantUnit = e.fn === "child.pid" ? "undefinedT" : "nullT";
      const f64Tag = def ? def.arms.findIndex((a) => a.kind === "f64") : -1;
      const unitTag = def ? def.arms.findIndex((a) => a.kind === wantUnit) : -1;
      if (f64Tag < 0 || unitTag < 0) throw new InternalCompilerError(`llvm emitter bug: ${e.fn} union lacks its arms`);
      const has = e.fn === "spawnRes.status" ? "scr_spawn_res_has_status" : e.fn === "child.pid" ? "scr_child_has_pid" : "scr_child_has_exit_code";
      const get = e.fn === "spawnRes.status" ? "scr_spawn_res_status" : e.fn === "child.pid" ? "scr_child_pid" : "scr_child_exit_code";
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
      B.line(`store ptr ${host.unionNewOwned(f64Tag, { name: x, type: F64 })}, ptr ${slot}`);
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
      if (e.type.kind !== "union") throw new InternalCompilerError("llvm emitter bug: spawnRes.signal result is not a union");
      const def = host.unionsById.get(e.type.unionId);
      const strTag = def ? def.arms.findIndex((a) => a.kind === "string") : -1;
      const nullTag = def ? def.arms.findIndex((a) => a.kind === "nullT") : -1;
      if (strTag < 0 || nullTag < 0) throw new InternalCompilerError("llvm emitter bug: spawnRes.signal union lacks its arms");
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
      if (e.type.kind !== "union") throw new InternalCompilerError("llvm emitter bug: spawnRes.error result is not a union");
      const def = host.unionsById.get(e.type.unionId);
      const errTag = def ? def.arms.findIndex((a) => a.kind === "object" && a.className === "%Error") : -1;
      const undefTag = undefinedArmTag(e.type, host.unionsById);
      if (errTag < 0 || undefTag < 0) throw new InternalCompilerError("llvm emitter bug: spawnRes.error union lacks its arms");
      const recv = host.emitExpr(e.args[0]!);
      host.declare(`declare ptr @scr_spawn_res_error(ptr)`);
      const raw = B.tmp();
      B.line(`${raw} = call ptr @scr_spawn_res_error(ptr ${recv.name}) ; +1 or NULL`);
      return host.wrapNullable(raw, raw, { kind: "object", className: "%Error" }, errTag, e.type, undefTag);
    }
    if (e.fn === "child.stdout" || e.fn === "child.stderr") {
      // `Readable | null` — the child.pid pattern with a REF arm: the
      // runtime answers a +1 stream handle or NULL (not piped).
      if (e.type.kind !== "union") throw new InternalCompilerError(`llvm emitter bug: ${e.fn} result is not a union`);
      const def = host.unionsById.get(e.type.unionId);
      const streamTag = def ? def.arms.findIndex((a) => a.kind === "childStream") : -1;
      const nullTag = def ? def.arms.findIndex((a) => a.kind === "nullT") : -1;
      if (streamTag < 0 || nullTag < 0) throw new InternalCompilerError(`llvm emitter bug: ${e.fn} union lacks its arms`);
      const get = e.fn === "child.stdout" ? "scr_child_stdout" : "scr_child_stderr";
      const recv = host.emitExpr(e.args[0]!);
      host.declare(`declare ptr @${get}(ptr)`);
      const raw = B.tmp();
      B.line(`${raw} = call ptr @${get}(ptr ${recv.name}) ; +1 or NULL`);
      return host.wrapNullable(raw, raw, def!.arms[streamTag]!, streamTag, e.type, nullTag);
    }
    return host.emitGenericLibCall(e);
  }

export function emitAsyncContextLibCall(host: LlvmEmitterContext, e: LibCallExpr): LlValue {
    const B = host.B;
    if (e.fn === "timers.setTimeout" || e.fn === "timers.setInterval" || e.fn === "timers.setTimeoutHandle" || e.fn === "timers.setImmediate" || e.fn === "process.nextTick" || e.fn === "timers.queueMicrotask") {
      // The loop owns the callback until it fires (setTimeout/setImmediate/
      // queueMicrotask) or until clear (setInterval) — the +1 MOVES in;
      // main runs the loop.
      host.usesTimers = true;
      const cb = host.emitExpr(e.args[0]!);
      host.moveTemp(cb);
      const sym = {
        "timers.setTimeout": "scr_set_timeout",
        "timers.setInterval": "scr_set_interval",
        "timers.setTimeoutHandle": "scr_set_timeout_handle",
        "timers.setImmediate": "scr_set_immediate",
        "process.nextTick": "scr_next_tick",
        "timers.queueMicrotask": "scr_queue_microtask",
      }[e.fn];
      const rest = e.args.slice(1).map((a) => host.emitExpr(a));
      const argList = [`ptr ${cb.name}`, ...rest.map((a) => `${host.llType(a.type)} ${a.name}`)].join(", ");
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
    if (e.fn === "timers.unref" || e.fn === "timers.ref" || e.fn === "timers.refresh" || e.fn === "timers.immediateUnref" || e.fn === "timers.immediateRef") {
      // The chaining forms: bookkeep, then yield the handle itself (the
      // C comma expressions).
      const h = host.emitExpr(e.args[0]!);
      const sym = {
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
      host.declare(`declare void @scr_clear_interval(double)`);
      B.line(`call void @scr_clear_interval(double ${h.name})`);
      return { name: "", type: e.type };
    }
    if (e.fn === "timers.clearNoop") {
      // clearTimeout(null) and friends: Node silently ignores
      // non-handles — nothing runs (arguments still evaluate).
      for (const a of e.args) host.emitExpr(a);
      return { name: "", type: e.type };
    }
    return host.emitGenericLibCall(e);
  }

export function emitProcessLibCall(host: LlvmEmitterContext, e: LibCallExpr): LlValue {
    const B = host.B;
    if (e.fn === "process.stdoutWriteBytesCb" || e.fn === "process.stderrWriteBytesCb") {
      // All arguments evaluate before bytes are submitted. The callback
      // then moves into the next-tick entry and its error-first adapter
      // constructs Node's success `null` argument when the tick fires.
      host.usesTimers = true;
      const args = e.args.map((a) => host.emitExpr(a));
      const cbT = e.args[2]!.type;
      if (cbT.kind !== "func") throw new InternalCompilerError("llvm emitter bug: process write callback not a func");
      host.moveTemp(args[2]!);
      const adapter = host.fsRenameThunkFor(cbT);
      const write = e.fn === "process.stdoutWriteBytesCb"
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
      if (cbT.kind !== "func") throw new InternalCompilerError(`llvm emitter bug: ${e.fn} callback not a func`);
      const cb = host.emitExpr(e.args[0]!);
      const once = host.emitExpr(e.args[1]!);
      host.moveTemp(cb);
      if (e.fn === "stdin.onEnd") {
        host.declare(`declare void @scr_stdin_on_end(ptr, i1 zeroext)`);
        B.line(`call void @scr_stdin_on_end(ptr ${cb.name}, i1 ${once.name})`);
        return { name: "", type: e.type };
      }
      const adapter =
        e.fn === "stdin.onData"
          ? (cbT.params.length === 0 ? "scr_stdin_data_thunk0" : "scr_stdin_data_thunk_bytes")
          : (cbT.params.length === 0 ? "scr_child_err_thunk0" : "scr_child_err_thunk_error");
      const sym = e.fn === "stdin.onData" ? "scr_stdin_on_data" : "scr_stdin_on_error";
      host.declare(`declare void @${adapter}(ptr, ptr)`);
      host.declare(`declare void @${sym}(ptr, ptr, i1 zeroext)`);
      B.line(`call void @${sym}(ptr ${cb.name}, ptr @${adapter}, i1 ${once.name})`);
      return { name: "", type: e.type };
    }
    if (e.fn === "process.onSignal") {
      // The registry owns the callback (zero-param — frontend-pinned)
      // until off/once removes it. The loop dispatches deliveries.
      host.usesTimers = true;
      const sig = host.emitExpr(e.args[0]!);
      const cb = host.emitExpr(e.args[1]!);
      const once = host.emitExpr(e.args[2]!);
      host.moveTemp(cb);
      host.declare(`declare void @scr_signal_on(double, ptr, i1 zeroext)`);
      B.line(`call void @scr_signal_on(double ${sig.name}, ptr ${cb.name}, i1 ${once.name})`);
      return { name: "", type: e.type };
    }
    if (e.fn === "process.onExit") {
      // Runtime adapters cover both shapes (the code is a plain double);
      // the registry owns the callback.
      const cbT = e.args[0]!.type;
      if (cbT.kind !== "func") throw new InternalCompilerError("llvm emitter bug: process.onExit callback not a func");
      const cb = host.emitExpr(e.args[0]!);
      const once = host.emitExpr(e.args[1]!);
      host.moveTemp(cb);
      const adapter = cbT.params.length === 0 ? "scr_exit_thunk0" : "scr_exit_thunk_code";
      host.declare(`declare void @${adapter}(ptr, double)`);
      host.declare(`declare void @scr_process_on_exit(ptr, ptr, i1 zeroext)`);
      B.line(`call void @scr_process_on_exit(ptr ${cb.name}, ptr @${adapter}, i1 ${once.name})`);
      return { name: "", type: e.type };
    }
    if (e.fn === "process.envGet" || e.fn === "process.columns") {
      // getenv(3) / ioctl(TIOCGWINSZ): the runtime answers a +1 string or
      // NULL (a width or a negative sentinel); the union construction is
      // type-directed HERE — present wraps the value arm, absent yields
      // the interned immortal undefined-arm instance.
      if (e.type.kind !== "union") throw new InternalCompilerError(`llvm emitter bug: ${e.fn} result is not a union`);
      const def = host.unionsById.get(e.type.unionId);
      const undefTag = undefinedArmTag(e.type, host.unionsById);
      const isEnv = e.fn === "process.envGet";
      const valTag = def ? def.arms.findIndex((a) => a.kind === (isEnv ? "string" : "f64")) : -1;
      if (valTag < 0 || undefTag < 0) throw new InternalCompilerError(`llvm emitter bug: ${e.fn} union lacks its arms`);
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
        host.declare(`declare double @scr_process_columns(double)`);
        B.line(`${raw} = call double @scr_process_columns(double ${args[0]!.name})`);
        B.line(`${present} = fcmp oge double ${raw}, ${f64Lit(0)}`);
      }
      B.condBr(present, lp, la);
      B.startBlock(lp);
      B.line(
        `store ptr ${host.unionNewOwned(valTag, { name: raw, type: isEnv ? STRING : F64 })}, ptr ${slot}`,
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
        host.emitPendingCheck();
        return { name: "", type: e.type };
      }
      const dummy = ty === "double" ? f64Lit(0) : ty === "i1" ? "false" : "null";
      const out = host.own({ name: dummy, type: e.type });
      host.emitPendingCheck();
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
        host.emitPendingCheck();
        return { name: "", type: e.type };
      }
      const dummy = ty === "double" ? f64Lit(0) : ty === "i1" ? "false" : "null";
      const out = host.own({ name: dummy, type: e.type });
      host.emitPendingCheck();
      return out;
    }
    {
      // The fs validation-ladder Chk forms that ALWAYS throw (a
      // validation error or the trailing compiler-rendered fence): every
      // argument is a ptr (dyns + the fence string), and the typed dummy
      // is abandoned by the pending check's unwind.
      const FS_CHK_THROW_SYMS: Record<string, string | undefined> = {
        "fs.mkdtempChk": "scr_fs_mkdtemp_chk",
        "fs.readFileChk": "scr_fs_read_file_chk",
        "fs.opendirChk": "scr_fs_opendir_chk",
        "fs.watchFileChk": "scr_fs_watch_file_chk",
        "fs.lchmodChk": "scr_fs_lchmod_chk",
        "fs.readChk": "scr_fs_read_chk",
        "fs.streamOptsChk": "scr_fs_stream_opts_chk",
        "net.connectOptsChk": "scr_net_connect_opts_chk",
      };
      const sym = FS_CHK_THROW_SYMS[e.fn];
      if (sym !== undefined) {
        const args = e.args.map((a) => host.emitExpr(a));
        host.declare(`declare void @${sym}(${args.map(() => "ptr").join(", ")})`);
        B.line(`call void @${sym}(${args.map((a) => `ptr ${a.name}`).join(", ")})`);
        const ty = host.llType(e.type);
        if (ty === "void") {
          host.emitPendingCheck();
          return { name: "", type: e.type };
        }
        const dummy = ty === "double" ? f64Lit(0) : ty === "i1" ? "false" : "null";
        const out = host.own({ name: dummy, type: e.type });
        host.emitPendingCheck();
        return out;
      }
    }
    if (e.fn === "error.nodeThrow") {
      // The compiler-resolved Node-parity throw (always throws — the
      // typed dummy is abandoned by the pending check's unwind).
      const kind = host.emitExpr(e.args[0]!);
      const code = host.emitExpr(e.args[1]!);
      const msg = host.emitExpr(e.args[2]!);
      host.declare(`declare void @scr_throw_node_coded(double, ptr, ptr)`);
      B.line(`call void @scr_throw_node_coded(double ${kind.name}, ptr ${code.name}, ptr ${msg.name})`);
      const ty = host.llType(e.type);
      if (ty === "void") {
        host.emitPendingCheck();
        return { name: "", type: e.type };
      }
      const dummy = ty === "double" ? f64Lit(0) : ty === "i1" ? "false" : "null";
      const out = host.own({ name: dummy, type: e.type });
      host.emitPendingCheck();
      return out;
    }
    if (e.fn === "emitter.on") {
      // (recv, name, cb /moves — the identity/, once, prepend): the
      // listener registers through scr_emitter_on_via with an emitted
      // fixed-arity adapter closure (what emit invokes) and the runtime's
      // matching va_list shim — the C backend's emitterInvokeThunkFor
      // split across the C/LLVM boundary. May-throw ('newListener' meta
      // listeners run inside).
      const cbT = e.args[2]!.type;
      if (cbT.kind !== "func") throw new InternalCompilerError("llvm emitter bug: emitter.on listener not a func");
      const args = e.args.map((a) => host.emitExpr(a));
      const { fn: adapterFn, shim } = host.emitterFixedAdapter(cbT);
      // The wrapper's capture box owns its OWN +1 of the listener; the
      // frame's +1 moves in as the entry's identity (orig).
      host.declare(`declare ptr @scr_closure_retain_v(ptr)`);
      const cbr = B.tmp();
      B.line(`${cbr} = call ptr @scr_closure_retain_v(ptr ${args[2]!.name})`);
      const wrapped = host.wrapEmitterListener(cbr, adapterFn);
      host.moveTemp(args[2]!);
      host.declare(`declare ptr @scr_emitter_on_via(ptr, ptr, ptr, ptr, ptr, i1 zeroext, i1 zeroext)`);
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
      if (adT.kind !== "func") throw new InternalCompilerError("llvm emitter bug: emitter.onDyn adapter not a func");
      const args = e.args.map((a) => host.emitExpr(a));
      const { fn: adapterFn, shim } = host.emitterFixedAdapter(adT);
      host.moveTemp(args[3]!); // the frame's +1 moves into the wrapper's box
      const wrapped = host.wrapEmitterListener(args[3]!.name, adapterFn);
      host.declare(`declare ptr @scr_emitter_on_dyn(ptr, ptr, ptr, ptr, ptr, i1 zeroext, i1 zeroext)`);
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
      const call = `call zeroext i1 (ptr, ptr, ...) @scr_emitter_emit(` +
        [`ptr ${args[0]!.name}`, `ptr ${args[1]!.name}`, ...tuple].join(", ") + `)`;
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
    if (e.fn === "emitter.emitData") {
      // A user emit('data', chunk) on a stream-rooted receiver: fill the
      // matching payload slot of the two-slot 'data' ABI, NULL the other.
      const args = e.args.map((a) => host.emitExpr(a));
      const chunkT = e.args[2]!.type;
      const both = chunkT.kind === "string"
        ? [`ptr null`, `ptr ${args[2]!.name}`]
        : [`ptr ${args[2]!.name}`, `ptr null`];
      host.declare(`declare zeroext i1 @scr_emitter_emit(ptr, ptr, ...)`);
      const t = B.tmp();
      B.line(
        `${t} = call zeroext i1 (ptr, ptr, ...) @scr_emitter_emit(ptr ${args[0]!.name}, ptr ${args[1]!.name}, ${both.join(", ")})`,
      );
      host.emitPendingCheck();
      return e.type.kind === "void" ? { name: "", type: e.type } : { name: t, type: e.type };
    }
    if (e.fn === "emitter.onData" || e.fn === "emitter.onDataDyn") {
      // The stream-'data' registration: same runtime entries as
      // emitter.on/onDyn, but the DATA adapter (the two-slot payload ABI
      // — scr_stream_emit_data) behind the arity-2 fixed shim.
      const isDyn = e.fn === "emitter.onDataDyn";
      const cbT = e.args[isDyn ? 3 : 2]!.type;
      if (cbT.kind !== "func") throw new InternalCompilerError(`llvm emitter bug: ${e.fn} listener not a func`);
      const args = e.args.map((a) => host.emitExpr(a));
      const adapterFn = host.streamDataAdapter(cbT);
      host.declare(`declare void @scr_ee_inv_fixed2(ptr, ptr)`);
      const t = B.tmp();
      if (isDyn) {
        host.moveTemp(args[3]!);
        const wrapped = host.wrapEmitterListener(args[3]!.name, adapterFn);
        host.declare(`declare ptr @scr_emitter_on_dyn(ptr, ptr, ptr, ptr, ptr, i1 zeroext, i1 zeroext)`);
        B.line(
          `${t} = call ptr @scr_emitter_on_dyn(ptr ${args[0]!.name}, ptr ${args[1]!.name}, ` +
            `ptr ${args[2]!.name}, ptr ${wrapped}, ptr @scr_ee_inv_fixed2, i1 ${args[4]!.name}, i1 ${args[5]!.name})`,
        );
      } else {
        host.declare(`declare ptr @scr_closure_retain_v(ptr)`);
        const cbr = B.tmp();
        B.line(`${cbr} = call ptr @scr_closure_retain_v(ptr ${args[2]!.name})`);
        const wrapped = host.wrapEmitterListener(cbr, adapterFn);
        host.moveTemp(args[2]!);
        host.declare(`declare ptr @scr_emitter_on_via(ptr, ptr, ptr, ptr, ptr, i1 zeroext, i1 zeroext)`);
        B.line(
          `${t} = call ptr @scr_emitter_on_via(ptr ${args[0]!.name}, ptr ${args[1]!.name}, ` +
            `ptr ${args[2]!.name}, ptr ${wrapped}, ptr @scr_ee_inv_fixed2, i1 ${args[3]!.name}, i1 ${args[4]!.name})`,
        );
      }
      const out = host.own({ name: t, type: e.type });
      host.emitPendingCheck();
      return out;
    }
    if (e.fn === "error.new") {
      // Which builtin the runtime constructs is named by the RESULT type;
      // the message is borrowed (the runtime retains its copy). Never
      // throws.
      if (e.type.kind !== "object") throw new InternalCompilerError("llvm emitter bug: error.new result is not a class");
      const rec = RUNTIME_ERROR_CLASSES.get(e.type.className);
      if (!rec) throw new InternalCompilerError(`llvm emitter bug: error.new of ${e.type.className}`);
      const msg = host.emitExpr(e.args[0]!);
      host.declare(`declare ptr @scr_error_new(i32, ptr)`);
      const t = B.tmp();
      B.line(`${t} = call ptr @scr_error_new(i32 ${rec.kind}, ptr ${msg.name})`);
      return host.own({ name: t, type: e.type });
    }
    if (e.fn === "error.ctor") {
      // super(message) into the builtin base: stamps name/message on the
      // receiver (borrowed, like the message). The RECEIVER'S static class
      // names which builtin name to stamp.
      const recvT = e.args[0]!.type;
      if (recvT.kind !== "object") throw new InternalCompilerError("llvm emitter bug: error.ctor receiver is not a class");
      const rec = RUNTIME_ERROR_CLASSES.get(recvT.className);
      if (!rec) throw new InternalCompilerError(`llvm emitter bug: error.ctor on ${recvT.className}`);
      const args = e.args.map((a) => host.emitExpr(a));
      host.declare(`declare void @scr_error_init(ptr, i32, ptr)`);
      B.line(`call void @scr_error_init(ptr ${args[0]!.name}, i32 ${rec.kind}, ptr ${args[1]!.name})`);
      return { name: "", type: e.type };
    }
    if (e.fn === "error.code") {
      // `string | undefined`, constructed type-directedly like
      // process.envGet: the runtime answers +1 or NULL (the receiver may
      // be a user subclass — the code slot sits in its ScrError prefix).
      if (e.type.kind !== "union") throw new InternalCompilerError("llvm emitter bug: error.code result is not a union");
      const def = host.unionsById.get(e.type.unionId);
      const strTag = def ? def.arms.findIndex((a) => a.kind === "string") : -1;
      const undefTag = undefinedArmTag(e.type, host.unionsById);
      if (strTag < 0 || undefTag < 0) throw new InternalCompilerError("llvm emitter bug: error.code union lacks its arms");
      const recv = host.emitExpr(e.args[0]!);
      host.declare(`declare ptr @scr_error_code(ptr)`);
      const raw = B.tmp();
      B.line(`${raw} = call ptr @scr_error_code(ptr ${recv.name})`);
      return host.wrapNullable(raw, raw, STRING, strTag, e.type, undefTag);
    }
    return host.emitGenericLibCall(e);
  }
