/* Focused LLVM library-call emission extracted from emitter.ts. */
import { InternalCompilerError } from "../../errors.js";
import { undefinedArmTag } from "../../ir/analysis.js";
import { DYN, F64, STRING } from "../../ir/ir.js";
import { mangleRecordNew } from "../mangle.js";
import { arrNewCall, traceArg, vAdapters } from "./shapes.js";
import type { LlvmEmitterContext, LibCallExpr, LlValue } from "./expr-context.js";
import { f64Lit } from "./common.js";

export function emitWebLibCall(host: LlvmEmitterContext, e: LibCallExpr): LlValue {
    const B = host.B;
    if (e.fn === "fetch.responseText" || e.fn === "fetch.responseBytes") {
      if (e.type.kind !== "promise") {
        throw new InternalCompilerError(`llvm emitter bug: ${e.fn} result`);
      }
      const response = host.emitExpr(e.args[0]!);
      const runtimeFn =
        e.fn === "fetch.responseText"
          ? "scr_fetch_response_text"
          : "scr_fetch_response_bytes";
      host.declare(`declare ptr @${runtimeFn}(ptr)`);
      host.declare(`declare ptr @scr_promise_new()`);
      host.declare(`declare void @scr_promise_race_add(ptr, ptr, ptr)`);
      const sourceRaw = B.tmp();
      B.line(`${sourceRaw} = call ptr @${runtimeFn}(ptr ${response.name})`);
      const source = host.own({
        name: sourceRaw,
        type: { kind: "promise", inner: DYN },
      });
      const resultRaw = B.tmp();
      B.line(`${resultRaw} = call ptr @scr_promise_new()`);
      const result = host.own({ name: resultRaw, type: e.type });
      B.line(
        `call void @scr_promise_race_add(ptr ${result.name}, ptr ${source.name}, ptr @${host.dynPromiseAdapter(e.type.inner)})`,
      );
      return result;
    }
    if (e.fn === "fetch.readerRead") {
      if (e.type.kind !== "promise" || e.type.inner.kind !== "record") {
        throw new InternalCompilerError("llvm emitter bug: fetch.readerRead result");
      }
      const reader = host.emitExpr(e.args[0]!);
      host.declare(`declare ptr @scr_fetch_reader_read(ptr)`);
      host.declare(`declare ptr @scr_promise_new()`);
      host.declare(`declare void @scr_promise_race_add(ptr, ptr, ptr)`);
      const sourceRaw = B.tmp();
      B.line(
        `${sourceRaw} = call ptr @scr_fetch_reader_read(ptr ${reader.name})`,
      );
      const source = host.own({
        name: sourceRaw,
        type: { kind: "promise", inner: DYN },
      });
      const resultRaw = B.tmp();
      B.line(`${resultRaw} = call ptr @scr_promise_new()`);
      const result = host.own({ name: resultRaw, type: e.type });
      B.line(
        `call void @scr_promise_race_add(ptr ${result.name}, ptr ${source.name}, ptr @${host.dynPromiseAdapter(e.type.inner)})`,
      );
      return result;
    }
    if (e.fn === "fetch.streamFrom") {
      const source = host.emitExpr(e.args[0]!);
      let sym = "scr_fetch_stream_from";
      let extra = "";
      if (source.type.kind === "array") {
        sym = "scr_fetch_stream_from_array";
        extra = `, ptr @${host.streamFromArrayAdapter(source.type)}`;
      } else if (source.type.kind === "bytes") {
        sym = "scr_fetch_stream_from_bytes";
      } else if (source.type.kind === "string") {
        sym = "scr_fetch_stream_from_string";
      }
      host.declare(
        `declare ptr @${sym}(ptr${source.type.kind === "array" ? ", ptr" : ""})`,
      );
      const raw = B.tmp();
      B.line(`${raw} = call ptr @${sym}(ptr ${source.name}${extra})`);
      const out = host.own({ name: raw, type: e.type });
      host.emitPendingCheck();
      return out;
    }
    // The handful with non-generic shapes first.
    if (e.fn === "island.castFail") {
      // The deferred boundary failure: the island value was evaluated
      // (its side effects are real), the throw is unconditional
      // (catchable TypeError naming the target type), and the typed
      // dummy is NULL — the pending check abandons it.
      const args = e.args.map((a) => host.emitExpr(a));
      host.declare(`declare void @scr_jsval_cast_fail(ptr, ptr)`);
      B.line(`call void @scr_jsval_cast_fail(ptr ${args[0]!.name}, ptr ${args[1]!.name})`);
      const out = host.own({ name: "null", type: e.type });
      host.emitPendingCheck();
      return out;
    }
    return host.emitGenericLibCall(e);
  }

export function emitDynamicLibCall(host: LlvmEmitterContext, e: LibCallExpr): LlValue {
    const B = host.B;
    if (e.fn === "global.undefRead") {
      // A declare-d const nothing defines: Node's catchable
      // ReferenceError at the access (always throws — the typed dummy is
      // abandoned by the pending check's unwind; releases are
      // NULL-tolerant). Borrows the name string.
      const name = host.emitExpr(e.args[0]!);
      host.declare(`declare void @scr_undef_global_read(ptr)`);
      B.line(`call void @scr_undef_global_read(ptr ${name.name})`);
      const ty = host.llType(e.type);
      const dummy = ty === "double" ? f64Lit(0) : ty === "i1" ? "false" : "null";
      const out = host.own({ name: dummy, type: e.type });
      host.emitPendingCheck();
      return out;
    }
    return host.emitGenericLibCall(e);
  }

export function emitFilesystemLibCall(host: LlvmEmitterContext, e: LibCallExpr): LlValue {
    const B = host.B;
    if (e.fn === "fs.renameCb") {
      // The callback MOVES into the next-turn operation. Its emitted
      // adapter materializes the callback's Error | null union (or the
      // checkJs dyn argument) from the runtime's borrowed ScrError.
      host.usesTimers = true;
      const args = e.args.map((a) => host.emitExpr(a));
      const cbT = e.args[2]!.type;
      if (cbT.kind !== "func") throw new InternalCompilerError("llvm emitter bug: fs.rename callback not a func");
      host.moveTemp(args[2]!);
      const adapter = host.fsRenameThunkFor(cbT);
      host.declare(`declare void @scr_fs_rename_async(ptr, ptr, ptr, ptr)`);
      B.line(`call void @scr_fs_rename_async(ptr ${args[0]!.name}, ptr ${args[1]!.name}, ptr ${args[2]!.name}, ptr @${adapter})`);
      return { name: "", type: e.type };
    }
    if (e.fn === "fileHandle.read" || e.fn === "fileHandle.writeBytes" || e.fn === "fileHandle.writeStr") {
      if (e.type.kind !== "promise" || e.type.inner.kind !== "record") {
        throw new InternalCompilerError(`llvm emitter bug: ${e.fn} result`);
      }
      const args = e.args.map((a) => host.emitExpr(a));
      const sym = e.fn === "fileHandle.read"
        ? "scr_file_handle_read"
        : e.fn === "fileHandle.writeBytes"
          ? "scr_file_handle_write_bytes"
          : "scr_file_handle_write_str";
      const tail = e.fn === "fileHandle.writeStr"
        ? "ptr, ptr, double, ptr"
        : "ptr, ptr, double, double, double, i1 zeroext";
      host.declare(`declare double @${sym}(${tail})`);
      const count = B.tmp();
      B.line(
        `${count} = call double @${sym}(${args.map((a) => `${host.llType(a.type)} ${a.name}`).join(", ")})`,
      );
      const inner = e.type.inner;
      const rec = B.tmp();
      B.line(`${rec} = call ptr @${mangleRecordNew(inner.shapeId)}()`);
      const countField = e.fn === "fileHandle.read" ? "bytesRead" : "bytesWritten";
      host.storeField(host.recordFieldPtr(rec, inner.shapeId, countField).ptr, F64, count);
      const payload = host.retainValue(args[1]!.name, e.args[1]!.type);
      B.line(`store ptr ${payload}, ptr ${host.recordFieldPtr(rec, inner.shapeId, "buffer").ptr}`);
      const rc = vAdapters(host, inner);
      host.declare(`declare ptr @scr_promise_settled_ref(ptr, ptr, ptr, ptr)`);
      const result = B.tmp();
      B.line(
        `${result} = call ptr @scr_promise_settled_ref(ptr ${rec}, ptr ${rc.retain}, ptr ${rc.release}, ptr ${traceArg(host, inner)})`,
      );
      return host.own({ name: result, type: e.type });
    }
    if (e.fn === "fs.readFileSync" || e.fn === "fs.readFdSync") {
      // args[1] is the (always-"utf8") encoding: evaluated for JS-exact
      // side-effect order, ignored by the runtime. May throw.
      const args = e.args.map((a) => host.emitExpr(a));
      const isFd = e.fn === "fs.readFdSync";
      const sym = isFd ? "scr_fs_read_fd" : "scr_fs_read_file";
      const argTy = isFd ? "double" : "ptr";
      host.declare(`declare ptr @${sym}(${argTy})`);
      const t = B.tmp();
      B.line(`${t} = call ptr @${sym}(${argTy} ${args[0]!.name})`);
      const out = host.own({ name: t, type: e.type });
      host.emitPendingCheck();
      return out;
    }
    if (e.fn === "fsp.readFile") {
      // fs.promises.readFile(path, "utf8"): args[1] is the encoding —
      // evaluated for JS-exact side-effect order, ignored by the runtime
      // exactly like fs.readFileSync's. The C prototype takes ONLY the
      // path, so the generic path (which passes every evaluated arg)
      // would declare a second parameter the runtime never had. Settles
      // the +1 promise instead of throwing — no pending check.
      const args = e.args.map((a) => host.emitExpr(a));
      host.declare(`declare ptr @scr_fsp_read_file(ptr)`);
      const t = B.tmp();
      B.line(`${t} = call ptr @scr_fsp_read_file(ptr ${args[0]!.name})`);
      return host.own({ name: t, type: e.type });
    }
    if (e.fn === "fs.watch") {
      // The callback-less form: NULL listener/adapter. Throws Node-shaped
      // fs errors when the path won't open; an open watcher holds the
      // loop (usesTimers).
      host.usesTimers = true;
      const path = host.emitExpr(e.args[0]!);
      host.declare(`declare ptr @scr_fs_watch(ptr, ptr, ptr)`);
      const t = B.tmp();
      B.line(`${t} = call ptr @scr_fs_watch(ptr ${path.name}, ptr null, ptr null)`);
      const out = host.own({ name: t, type: e.type });
      host.emitPendingCheck();
      return out;
    }
    if (e.fn === "fs.watchCb") {
      // The callback MOVES into the watcher's registry; the adapter is
      // runtime-provided per listener shape (zero-param, or the eventType
      // string). May throw (ENOENT) — the standard pending check.
      host.usesTimers = true;
      const cbT = e.args[1]!.type;
      if (cbT.kind !== "func") throw new InternalCompilerError("llvm emitter bug: fs.watchCb callback not a func");
      const path = host.emitExpr(e.args[0]!);
      const cb = host.emitExpr(e.args[1]!);
      host.moveTemp(cb);
      const adapter = cbT.params.length === 0 ? "scr_watch_thunk0" : "scr_watch_thunk_event";
      host.declare(`declare void @${adapter}(ptr, ptr)`);
      host.declare(`declare ptr @scr_fs_watch(ptr, ptr, ptr)`);
      const t = B.tmp();
      B.line(`${t} = call ptr @scr_fs_watch(ptr ${path.name}, ptr ${cb.name}, ptr @${adapter})`);
      const out = host.own({ name: t, type: e.type });
      host.emitPendingCheck();
      return out;
    }
    if (e.fn === "watcher.close") {
      // Idempotent; never throws.
      const w = host.emitExpr(e.args[0]!);
      host.declare(`declare void @scr_watcher_close(ptr)`);
      B.line(`call void @scr_watcher_close(ptr ${w.name})`);
      return { name: "", type: e.type };
    }
    if (e.fn === "fs.readdirTypesSync") {
      // Dirent rows assembled inline from one scandir snapshot — the C
      // emitter's flat loop. The snapshot call throws Node's scandir
      // error and answers NULL then, so the pending check runs before
      // any allocation.
      if (e.type.kind !== "array" || e.type.elem.kind !== "record") {
        throw new InternalCompilerError("llvm emitter bug: readdirTypesSync result is not a record array");
      }
      const recT = e.type.elem;
      const path = host.emitExpr(e.args[0]!);
      host.declare(`declare ptr @scr_fs_scandir(ptr)`);
      host.declare(`declare ${host.sizeType} @scr_fs_scandir_count(ptr)`);
      host.declare(`declare ptr @scr_fs_scandir_name(ptr, ${host.sizeType})`);
      host.declare(`declare double @scr_fs_scandir_type(ptr, ${host.sizeType})`);
      host.declare(`declare void @scr_fs_scandir_free(ptr)`);
      const snap = B.tmp();
      B.line(`${snap} = call ptr @scr_fs_scandir(ptr ${path.name})`);
      host.emitPendingCheck();
      const cnt = B.tmp();
      B.line(`${cnt} = call ${host.sizeType} @scr_fs_scandir_count(ptr ${snap})`);
      const arr = B.tmp();
      B.line(`${arr} = ${arrNewCall(host, recT, cnt)}`);
      const out = host.own({ name: arr, type: e.type });
      const iSlot = B.slot();
      B.entryAllocas.push(`${iSlot} = alloca ${host.sizeType}`);
      B.line(`store ${host.sizeType} 0, ptr ${iSlot}`);
      const lc = B.newLabel("sd.c");
      const lb = B.newLabel("sd.b");
      const le = B.newLabel("sd.e");
      B.br(lc);
      B.startBlock(lc);
      const i = B.tmp();
      const cont = B.tmp();
      B.line(`${i} = load ${host.sizeType}, ptr ${iSlot}`);
      B.line(`${cont} = icmp ult ${host.sizeType} ${i}, ${cnt}`);
      B.condBr(cont, lb, le);
      B.startBlock(lb);
      const row = B.tmp();
      B.line(`${row} = call ptr @${mangleRecordNew(recT.shapeId)}()`);
      const dt = B.tmp();
      B.line(`${dt} = call double @scr_fs_scandir_type(ptr ${snap}, ${host.sizeType} ${i})`);
      host.storeField(host.recordFieldPtr(row, recT.shapeId, "%dtype").ptr, F64, dt);
      const nm = B.tmp();
      B.line(`${nm} = call ptr @scr_fs_scandir_name(ptr ${snap}, ${host.sizeType} ${i}) ; +1`);
      B.line(`store ptr ${nm}, ptr ${host.recordFieldPtr(row, recT.shapeId, "name").ptr}`);
      B.line(`store ptr ${host.retainValue(path.name, STRING)}, ptr ${host.recordFieldPtr(row, recT.shapeId, "parentPath").ptr}`);
      host.arrPush(arr, "ref", row); // push takes ownership of the row
      const i2 = B.tmp();
      B.line(`${i2} = add ${host.sizeType} ${i}, 1`);
      B.line(`store ${host.sizeType} ${i2}, ptr ${iSlot}`);
      B.br(lc);
      B.startBlock(le);
      B.line(`call void @scr_fs_scandir_free(ptr ${snap})`);
      return out;
    }
    return host.emitGenericLibCall(e);
  }

export function emitPathUrlLibCall(host: LlvmEmitterContext, e: LibCallExpr): LlValue {
    const B = host.B;
    if (e.fn === "sp.get") {
      // `string | null` — the sym.desc pattern with a null arm: the
      // runtime answers a +1 string or NULL.
      if (e.type.kind !== "union") throw new InternalCompilerError("llvm emitter bug: sp.get result is not a union");
      const def = host.unionsById.get(e.type.unionId);
      const strTag = def ? def.arms.findIndex((a) => a.kind === "string") : -1;
      const nullTag = def ? def.arms.findIndex((a) => a.kind === "nullT") : -1;
      if (strTag < 0 || nullTag < 0) throw new InternalCompilerError("llvm emitter bug: sp.get union lacks its arms");
      const args = e.args.map((a) => host.emitExpr(a));
      host.declare(`declare ptr @scr_sp_get(ptr, ptr)`);
      const raw = B.tmp();
      B.line(`${raw} = call ptr @scr_sp_get(ptr ${args[0]!.name}, ptr ${args[1]!.name})`);
      return host.wrapNullable(raw, raw, STRING, strTag, e.type, nullTag);
    }
    if (e.fn === "qs.parse") {
      // The ParsedUrlQuery dictionary: a fresh pure-index-signature
      // record whose overflow map the runtime scan fills
      // (scr_qs_parse_into groups repeats into string[] buckets) — the
      // C emitter's shape exactly. The frontend verified the structure;
      // lookups here only guard emitter bugs. Args: qs, sep, eq, maxKeys.
      if (e.type.kind !== "record") throw new InternalCompilerError("llvm emitter bug: qs.parse result is not a record");
      const dictShape = host.recordsById.get(e.type.shapeId);
      const iv = dictShape?.indexValue;
      if (!dictShape || iv?.kind !== "union") throw new InternalCompilerError("llvm emitter bug: qs.parse dict shape");
      const ivDef = host.unionsById.get(iv.unionId);
      const strTag = ivDef?.arms.findIndex((a) => a.kind === "string") ?? -1;
      const arrTag = ivDef?.arms.findIndex((a) => a.kind === "array") ?? -1;
      if (strTag < 0 || arrTag < 0) throw new InternalCompilerError("llvm emitter bug: qs.parse index union lacks its arms");
      const args = e.args.map((a) => host.emitExpr(a));
      host.declare(`declare void @scr_qs_parse_into(ptr, ptr, ptr, ptr, double, i32, i32)`);
      const dict = B.tmp();
      B.line(`${dict} = call ptr @${mangleRecordNew(e.type.shapeId)}()`);
      const out = host.own({ name: dict, type: e.type });
      const ovf = host.recordOvfPtr(dict, e.type.shapeId);
      B.line(
        `call void @scr_qs_parse_into(ptr ${ovf}, ptr ${args[0]!.name}, ptr ${args[1]!.name}, ptr ${args[2]!.name}, double ${args[3]!.name}, i32 ${strTag}, i32 ${arrTag})`,
      );
      return out;
    }
    if (e.fn === "os.networkInterfaces") {
      // The Dict<NetworkInterfaceInfo[]> record, built inline from a
      // getifaddrs(3) snapshot — exprs.ts's builder, block-lowered.
      // Every shape/union/tag below comes from the call's own type; the
      // frontend verified the structure, so lookups only guard against
      // emitter bugs. Rows append to their interface's bucket in snapshot
      // order; a first row makes the bucket (a fresh Info[] wrapped into
      // the `Info[] | undefined` union arm the overflow map stores).
      if (e.type.kind !== "record") throw new InternalCompilerError("llvm emitter bug: networkInterfaces result is not a record");
      const dictShape = host.recordsById.get(e.type.shapeId);
      const iv = dictShape?.indexValue;
      if (!dictShape || iv?.kind !== "union") throw new InternalCompilerError("llvm emitter bug: networkInterfaces dict shape");
      const ivDef = host.unionsById.get(iv.unionId);
      const arrTag = ivDef?.arms.findIndex((a) => a.kind === "array") ?? -1;
      const arrT = ivDef?.arms[arrTag];
      if (arrT?.kind !== "array" || arrT.elem.kind !== "union") throw new InternalCompilerError("llvm emitter bug: networkInterfaces bucket type");
      const infoT = arrT.elem;
      const infoDef = host.unionsById.get(infoT.unionId);
      if (!infoDef || infoDef.arms.length !== 2) throw new InternalCompilerError("llvm emitter bug: networkInterfaces Info union");
      const tag6 = infoDef.arms.findIndex(
        (a) => a.kind === "record" && host.recordsById.get(a.shapeId)?.fields.find((f) => f.name === "scopeid")?.type.kind === "f64",
      );
      const tag4 = 1 - tag6;
      host.declare(`declare ptr @scr_os_ifaddrs()`);
      host.declare(`declare ${host.sizeType} @scr_os_ifaddrs_count(ptr)`);
      host.declare(`declare ptr @scr_os_ifaddrs_name(ptr, ${host.sizeType})`);
      host.declare(`declare ptr @scr_os_ifaddrs_address(ptr, ${host.sizeType})`);
      host.declare(`declare ptr @scr_os_ifaddrs_netmask(ptr, ${host.sizeType})`);
      host.declare(`declare ptr @scr_os_ifaddrs_family(ptr, ${host.sizeType})`);
      host.declare(`declare ptr @scr_os_ifaddrs_mac(ptr, ${host.sizeType})`);
      host.declare(`declare zeroext i1 @scr_os_ifaddrs_internal(ptr, ${host.sizeType})`);
      host.declare(`declare zeroext i1 @scr_os_ifaddrs_ipv6(ptr, ${host.sizeType})`);
      host.declare(`declare ptr @scr_os_ifaddrs_cidr(ptr, ${host.sizeType})`);
      host.declare(`declare double @scr_os_ifaddrs_scopeid(ptr, ${host.sizeType})`);
      host.declare(`declare void @scr_os_ifaddrs_free(ptr)`);
      host.declare(`declare ptr @scr_union_new_ref(i32, ptr, ptr, ptr, ptr)`);
      host.declare(`declare ptr @scr_union_retain_v(ptr)`);
      host.declare(`declare void @scr_union_release(ptr)`);
      host.declare(`declare ptr @scr_str_retain_v(ptr)`);
      host.declare(`declare void @scr_str_release_v(ptr)`);
      host.declare(`declare void @scr_str_release(ptr)`);
      host.declare(`declare ptr @scr_arr_retain_v(ptr)`);
      host.declare(`declare void @scr_arr_release(ptr)`);
      host.declare(`declare ptr @scr_map_get_str_ref(ptr, ptr)`);
      host.declare(`declare void @scr_map_set_str_ref(ptr, ptr, ptr)`);
      const dict = B.tmp();
      B.line(`${dict} = call ptr @${mangleRecordNew(e.type.shapeId)}()`);
      const out = host.own({ name: dict, type: e.type });
      const ovf = host.recordOvfPtr(dict, e.type.shapeId);
      const snap = B.tmp();
      const cnt = B.tmp();
      B.line(`${snap} = call ptr @scr_os_ifaddrs()`);
      B.line(`${cnt} = call ${host.sizeType} @scr_os_ifaddrs_count(ptr ${snap})`);
      const iSlot = B.slot();
      const rowSlot = B.slot();
      B.entryAllocas.push(`${iSlot} = alloca ${host.sizeType}`, `${rowSlot} = alloca ptr`);
      B.line(`store ${host.sizeType} 0, ptr ${iSlot}`);
      const lc = B.newLabel("ni.c");
      const lb = B.newLabel("ni.b");
      const le = B.newLabel("ni.e");
      B.br(lc);
      B.startBlock(lc);
      const i = B.tmp();
      const cont = B.tmp();
      B.line(`${i} = load ${host.sizeType}, ptr ${iSlot}`);
      B.line(`${cont} = icmp ult ${host.sizeType} ${i}, ${cnt}`);
      B.condBr(cont, lb, le);
      B.startBlock(lb);
      const isV6 = B.tmp();
      B.line(`${isV6} = call zeroext i1 @scr_os_ifaddrs_ipv6(ptr ${snap}, ${host.sizeType} ${i})`);
      const l6 = B.newLabel("ni.v6");
      const l4 = B.newLabel("ni.v4");
      const lRow = B.newLabel("ni.r");
      B.condBr(isV6, l6, l4);
      const emitRow = (tag: number, v6: boolean): void => {
        const t = infoDef.arms[tag];
        if (t?.kind !== "record") throw new InternalCompilerError("llvm emitter bug: networkInterfaces Info arm");
        const shape = host.recordsById.get(t.shapeId);
        if (!shape) throw new InternalCompilerError("llvm emitter bug: networkInterfaces Info shape");
        const cidrT = shape.fields.find((f) => f.name === "cidr")?.type;
        const cidrDef = cidrT?.kind === "union" ? host.unionsById.get(cidrT.unionId) : undefined;
        if (cidrT?.kind !== "union" || !cidrDef) throw new InternalCompilerError("llvm emitter bug: networkInterfaces cidr type");
        const cidrStrTag = cidrDef.arms.findIndex((a) => a.kind === "string");
        const cidrNullTag = cidrDef.arms.findIndex((a) => a.kind === "nullT");
        const r = B.tmp();
        B.line(`${r} = call ptr @${mangleRecordNew(t.shapeId)}()`);
        for (const [field, sym] of [
          ["address", "scr_os_ifaddrs_address"],
          ["netmask", "scr_os_ifaddrs_netmask"],
          ["family", "scr_os_ifaddrs_family"],
          ["mac", "scr_os_ifaddrs_mac"],
        ] as const) {
          const v = B.tmp();
          B.line(`${v} = call ptr @${sym}(ptr ${snap}, ${host.sizeType} ${i}) ; +1`);
          B.line(`store ptr ${v}, ptr ${host.recordFieldPtr(r, t.shapeId, field).ptr}`);
        }
        const internal = B.tmp();
        B.line(`${internal} = call zeroext i1 @scr_os_ifaddrs_internal(ptr ${snap}, ${host.sizeType} ${i})`);
        host.storeField(host.recordFieldPtr(r, t.shapeId, "internal").ptr, { kind: "bool" }, internal);
        const cs = B.tmp();
        B.line(`${cs} = call ptr @scr_os_ifaddrs_cidr(ptr ${snap}, ${host.sizeType} ${i}) ; +1 or null`);
        const hasCidr = B.tmp();
        B.line(`${hasCidr} = icmp ne ptr ${cs}, null`);
        const lcs = B.newLabel("ni.cs");
        const lcn = B.newLabel("ni.cn");
        const lcj = B.newLabel("ni.cj");
        const cidrSlot = B.slot();
        B.entryAllocas.push(`${cidrSlot} = alloca ptr`);
        B.condBr(hasCidr, lcs, lcn);
        B.startBlock(lcs);
        const cu = B.tmp();
        B.line(`${cu} = call ptr @scr_union_new_ref(i32 ${cidrStrTag}, ptr ${cs}, ptr @scr_str_retain_v, ptr @scr_str_release_v, ptr null)`);
        B.line(`store ptr ${cu}, ptr ${cidrSlot}`);
        B.br(lcj);
        B.startBlock(lcn);
        const cn = B.tmp();
        B.line(`${cn} = call ptr @scr_union_retain_v(ptr ${host.unitInstanceRef(cidrT.unionId, cidrNullTag)})`);
        B.line(`store ptr ${cn}, ptr ${cidrSlot}`);
        B.br(lcj);
        B.startBlock(lcj);
        const cv = B.tmp();
        B.line(`${cv} = load ptr, ptr ${cidrSlot}`);
        B.line(`store ptr ${cv}, ptr ${host.recordFieldPtr(r, t.shapeId, "cidr").ptr}`);
        if (v6) {
          const sc = B.tmp();
          B.line(`${sc} = call double @scr_os_ifaddrs_scopeid(ptr ${snap}, ${host.sizeType} ${i})`);
          host.storeField(host.recordFieldPtr(r, t.shapeId, "scopeid").ptr, F64, sc);
        } else {
          const st = shape.fields.find((f) => f.name === "scopeid")?.type;
          if (st?.kind !== "union") throw new InternalCompilerError("llvm emitter bug: networkInterfaces IPv4 scopeid type");
          const undefTag = undefinedArmTag(st, host.unionsById);
          const su = B.tmp();
          B.line(`${su} = call ptr @scr_union_retain_v(ptr ${host.unitInstanceRef(st.unionId, undefTag)})`);
          B.line(`store ptr ${su}, ptr ${host.recordFieldPtr(r, t.shapeId, "scopeid").ptr}`);
        }
        const rc = vAdapters(host, t);
        const rowU = B.tmp();
        B.line(`${rowU} = call ptr @scr_union_new_ref(i32 ${tag}, ptr ${r}, ptr ${rc.retain}, ptr ${rc.release}, ptr ${traceArg(host, t)})`);
        B.line(`store ptr ${rowU}, ptr ${rowSlot}`);
        B.br(lRow);
      };
      B.startBlock(l6);
      emitRow(tag6, true);
      B.startBlock(l4);
      emitRow(tag4, false);
      B.startBlock(lRow);
      const row = B.tmp();
      B.line(`${row} = load ptr, ptr ${rowSlot}`);
      const nm = B.tmp();
      B.line(`${nm} = call ptr @scr_os_ifaddrs_name(ptr ${snap}, ${host.sizeType} ${i}) ; +1`);
      const cell = B.tmp();
      B.line(`${cell} = call ptr @scr_map_get_str_ref(ptr ${ovf}, ptr ${nm})`);
      const hasCell = B.tmp();
      B.line(`${hasCell} = icmp ne ptr ${cell}, null`);
      const lh = B.newLabel("ni.h");
      const lm = B.newLabel("ni.m");
      const lj = B.newLabel("ni.j");
      const rowsSlot = B.slot();
      B.entryAllocas.push(`${rowsSlot} = alloca ptr`);
      B.condBr(hasCell, lh, lm);
      B.startBlock(lh);
      const peeked = host.unionPeek(cell);
      const retained = B.tmp();
      B.line(`${retained} = call ptr @scr_arr_retain_v(ptr ${peeked})`);
      B.line(`store ptr ${retained}, ptr ${rowsSlot}`);
      B.line(`call void @scr_union_release(ptr ${cell})`);
      B.br(lj);
      B.startBlock(lm);
      const fresh = B.tmp();
      B.line(`${fresh} = ${arrNewCall(host, infoT, "1")}`);
      const arrRc = vAdapters(host, arrT);
      const freshRet = B.tmp();
      B.line(`${freshRet} = call ptr @scr_arr_retain_v(ptr ${fresh})`);
      const bucketU = B.tmp();
      B.line(`${bucketU} = call ptr @scr_union_new_ref(i32 ${arrTag}, ptr ${freshRet}, ptr ${arrRc.retain}, ptr ${arrRc.release}, ptr ${traceArg(host, arrT)})`);
      B.line(`call void @scr_map_set_str_ref(ptr ${ovf}, ptr ${nm}, ptr ${bucketU})`);
      B.line(`store ptr ${fresh}, ptr ${rowsSlot}`);
      B.br(lj);
      B.startBlock(lj);
      const rows = B.tmp();
      B.line(`${rows} = load ptr, ptr ${rowsSlot}`);
      host.arrPush(rows, "ref", row); // push takes ownership of the row
      B.line(`call void @scr_arr_release(ptr ${rows})`);
      B.line(`call void @scr_str_release(ptr ${nm})`);
      const i2 = B.tmp();
      B.line(`${i2} = add ${host.sizeType} ${i}, 1`);
      B.line(`store ${host.sizeType} ${i2}, ptr ${iSlot}`);
      B.br(lc);
      B.startBlock(le);
      B.line(`call void @scr_os_ifaddrs_free(ptr ${snap})`);
      return out;
    }
    return host.emitGenericLibCall(e);
  }

export function emitPrimitiveLibCall(host: LlvmEmitterContext, e: LibCallExpr): LlValue {
    const B = host.B;
    if (e.fn === "math.floor" || e.fn === "math.trunc" || e.fn === "math.ceil") {
      const intr = e.fn === "math.floor" ? "floor" : e.fn === "math.trunc" ? "trunc" : "ceil";
      const v = host.emitExpr(e.args[0]!);
      host.declare(`declare double @llvm.${intr}.f64(double)`);
      const t = B.tmp();
      B.line(`${t} = call double @llvm.${intr}.f64(double ${v.name})`);
      return { name: t, type: e.type };
    }
    if (e.fn === "math.abs") {
      const v = host.emitExpr(e.args[0]!);
      host.declare(`declare double @llvm.fabs.f64(double)`);
      const t = B.tmp();
      B.line(`${t} = call double @llvm.fabs.f64(double ${v.name})`);
      return { name: t, type: e.type };
    }
    if (e.fn === "num.isNaN") {
      const v = host.emitExpr(e.args[0]!);
      const t = B.tmp();
      B.line(`${t} = fcmp uno double ${v.name}, ${f64Lit(0)}`);
      return { name: t, type: e.type };
    }
    if (e.fn === "sym.newAnon") {
      host.declare(`declare ptr @scr_sym_new(ptr)`);
      const t = B.tmp();
      B.line(`${t} = call ptr @scr_sym_new(ptr null)`);
      return host.own({ name: t, type: e.type });
    }
    if (e.fn === "sym.desc" || e.fn === "sym.keyFor") {
      // `string | undefined` — the runtime answers a +1 string or NULL;
      // the union construction is type-directed here (envGet convention).
      if (e.type.kind !== "union") throw new InternalCompilerError(`llvm emitter bug: ${e.fn} result is not a union`);
      const def = host.unionsById.get(e.type.unionId);
      const strTag = def ? def.arms.findIndex((a) => a.kind === "string") : -1;
      const undefTag = undefinedArmTag(e.type, host.unionsById);
      if (strTag < 0 || undefTag < 0) throw new InternalCompilerError(`llvm emitter bug: ${e.fn} union lacks its arms`);
      const v = host.emitExpr(e.args[0]!);
      const sym = e.fn === "sym.desc" ? "scr_sym_desc" : "scr_sym_key_for";
      host.declare(`declare ptr @${sym}(ptr)`);
      const raw = B.tmp();
      B.line(`${raw} = call ptr @${sym}(ptr ${v.name})`);
      return host.wrapNullable(raw, raw, STRING, strTag, e.type, undefTag);
    }
    if (e.fn === "string.fromCharCode") {
      // One packed f64[] (the frontend built it) or one bytes value (the
      // spread-typed-array form); +1 string.
      const sym = e.args[0]!.type.kind === "bytes" ? "scr_str_from_char_code_bytes" : "scr_str_from_char_code";
      const v = host.emitExpr(e.args[0]!);
      host.declare(`declare ptr @${sym}(ptr)`);
      const t = B.tmp();
      B.line(`${t} = call ptr @${sym}(ptr ${v.name})`);
      return host.own({ name: t, type: e.type });
    }
    return host.emitGenericLibCall(e);
  }
