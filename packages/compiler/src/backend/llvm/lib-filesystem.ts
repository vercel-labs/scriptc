/* Focused LLVM library-call emission extracted from emitter.ts. */
import { InternalCompilerError } from "../../errors.js";
import { undefinedArmTag } from "../../ir/analysis.js";
import { DYN, F64, STATS_T, STRING, type IrExpr } from "../../ir/ir.js";
import { mangleRecordNew } from "../mangle.js";
import { arrNewCall, traceArg, vAdapters } from "./shapes.js";
import type { LlvmEmitterContext, LibCallExpr, LlValue } from "./expr-context.js";
import { f64Lit } from "./common.js";
import { emitAlwaysThrowLibCall } from "./lib-shared.js";
import { emitTruncF64 } from "./trunc.js";
import { markWrappingOperands } from "./wrapping-sums.js";

const FS_ALWAYS_THROW_SYMS: Readonly<Record<string, string>> = {
  "fs.mkdtempChk": "scr_fs_mkdtemp_chk",
  "fs.readFileChk": "scr_fs_read_file_chk",
  "fs.opendirChk": "scr_fs_opendir_chk",
  "fs.watchFileChk": "scr_fs_watch_file_chk",
  "fs.lchmodChk": "scr_fs_lchmod_chk",
  "fs.readChk": "scr_fs_read_chk",
  "fs.streamOptsChk": "scr_fs_stream_opts_chk",
};

export function emitWebLibCall(host: LlvmEmitterContext, e: LibCallExpr): LlValue {
  const B = host.B;
  if (e.fn === "fetch.responseText" || e.fn === "fetch.responseBytes") {
    if (e.type.kind !== "promise") {
      throw new InternalCompilerError(`llvm emitter bug: ${e.fn} result`);
    }
    const response = host.emitExpr(e.args[0]!);
    const runtimeFn =
      e.fn === "fetch.responseText" ? "scr_fetch_response_text" : "scr_fetch_response_bytes";
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
    B.line(`${sourceRaw} = call ptr @scr_fetch_reader_read(ptr ${reader.name})`);
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
    host.declare(`declare ptr @${sym}(ptr${source.type.kind === "array" ? ", ptr" : ""})`);
    const raw = B.tmp();
    B.line(`${raw} = call ptr @${sym}(ptr ${source.name}${extra})`);
    const out = host.own({ name: raw, type: e.type });
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
    host.emitAlwaysPendingUnwind();
    return out;
  }
  if (e.fn === "dyn.objEntryPairs") return emitObjEntryPairs(host, e);
  return host.emitGenericLibCall(e);
}

/** Object.entries over a checked-dynamic value as a native [string, any][]:
 * the runtime snapshots the owned (key, value) pairs in Node's order, and
 * each pair's references move into a fresh tuple row. */
function emitObjEntryPairs(host: LlvmEmitterContext, e: LibCallExpr): LlValue {
  const B = host.B;
  if (e.type.kind !== "array" || e.type.elem.kind !== "record")
    throw new InternalCompilerError(
      "llvm emitter bug: dyn.objEntryPairs result is not a tuple array",
    );
  const rowT = e.type.elem;
  const size = host.sizeType;
  const value = host.emitExpr(e.args[0]!);
  host.declare(`declare ptr @scr_dyn_obj_entry_pairs(ptr)`);
  host.declare(`declare void @scr_dyn_entry_pairs_free(ptr)`);
  const snap = B.tmp();
  B.line(`${snap} = call ptr @scr_dyn_obj_entry_pairs(ptr ${value.name})`);
  host.emitPendingCheck();
  const pairsT = `{ ${size}, [0 x { ptr, ptr }] }`;
  const count = B.tmp();
  B.line(`${count} = load ${size}, ptr ${snap}`);
  const arr = B.tmp();
  B.line(`${arr} = ${arrNewCall(host.shapeHost, rowT, count)}`);
  const out = host.own({ name: arr, type: e.type });
  const iSlot = B.slot();
  B.entryAllocas.push(`${iSlot} = alloca ${size}`);
  B.line(`store ${size} 0, ptr ${iSlot}`);
  const lc = B.newLabel("entries.c");
  const lb = B.newLabel("entries.b");
  const le = B.newLabel("entries.e");
  B.br(lc);
  B.startBlock(lc);
  const i = B.tmp();
  const more = B.tmp();
  B.line(`${i} = load ${size}, ptr ${iSlot}`);
  B.line(`${more} = icmp ult ${size} ${i}, ${count}`);
  B.condBr(more, lb, le);
  B.startBlock(lb);
  const keyPtr = B.tmp();
  const valuePtr = B.tmp();
  const key = B.tmp();
  const item = B.tmp();
  B.line(
    `${keyPtr} = getelementptr inbounds ${pairsT}, ptr ${snap}, i64 0, i32 1, ${size} ${i}, i32 0`,
  );
  B.line(
    `${valuePtr} = getelementptr inbounds ${pairsT}, ptr ${snap}, i64 0, i32 1, ${size} ${i}, i32 1`,
  );
  B.line(`${key} = load ptr, ptr ${keyPtr} ; +1, moves into the row`);
  B.line(`${item} = load ptr, ptr ${valuePtr} ; +1, moves into the row`);
  const row = B.tmp();
  B.line(`${row} = call ptr @${mangleRecordNew(rowT.shapeId)}()`);
  host.storeField(host.recordFieldPtr(row, rowT.shapeId, "0").ptr, STRING, key, false);
  host.storeField(host.recordFieldPtr(row, rowT.shapeId, "1").ptr, DYN, item, false);
  host.arrPush(arr, "ref", row, null); // push takes ownership of the row
  const next = B.tmp();
  B.line(`${next} = add ${size} ${i}, 1`);
  B.line(`store ${size} ${next}, ptr ${iSlot}`);
  B.br(lc);
  B.startBlock(le);
  B.line(`call void @scr_dyn_entry_pairs_free(ptr ${snap})`);
  return out;
}

export function emitFilesystemLibCall(host: LlvmEmitterContext, e: LibCallExpr): LlValue {
  const B = host.B;
  const alwaysThrowSym = FS_ALWAYS_THROW_SYMS[e.fn];
  if (alwaysThrowSym !== undefined) {
    return emitAlwaysThrowLibCall(host, e, alwaysThrowSym);
  }
  if (
    e.fn === "zlib.deflateCb" ||
    e.fn === "zlib.inflateCb" ||
    e.fn === "zlib.deflateRawCb" ||
    e.fn === "zlib.inflateRawCb" ||
    e.fn === "zlib.gzipCb" ||
    e.fn === "zlib.gunzipCb" ||
    e.fn === "zlib.unzipCb"
  ) {
    host.usesTimers = true;
    const args = e.args.map((a) => host.emitExpr(a));
    const cbT = e.args[1]!.type;
    if (cbT.kind !== "func")
      throw new InternalCompilerError("llvm emitter bug: zlib callback not a func");
    host.toHeap(args[1]!);
    const adapter = host.zlibBytesThunkFor(cbT);
    const compressing =
      e.fn === "zlib.deflateCb" || e.fn === "zlib.deflateRawCb" || e.fn === "zlib.gzipCb";
    const mode =
      e.fn === "zlib.deflateRawCb" || e.fn === "zlib.inflateRawCb"
        ? 1
        : e.fn === "zlib.gzipCb" || e.fn === "zlib.gunzipCb"
          ? 2
          : e.fn === "zlib.unzipCb"
            ? 3
            : 0;
    host.declare(`declare void @scr_zlib_codec_async(ptr, double, i1 zeroext, ptr, ptr)`);
    B.line(
      `call void @scr_zlib_codec_async(ptr ${args[0]!.name}, double ${f64Lit(mode)}, i1 ${compressing}, ptr ${args[1]!.name}, ptr @${adapter})`,
    );
    return { name: "", type: e.type };
  }
  if (e.fn === "zlib.syncOpts" || e.fn === "zlib.syncOptsDyn") {
    // (mode, data, options): data and options borrowed; +1 bytes or NULL
    // with a pending throw.
    const args = e.args.map((a) => host.emitExpr(a));
    const sym = e.fn === "zlib.syncOpts" ? "scr_zlib_sync_opts" : "scr_zlib_sync_opts_dyn";
    host.declare(`declare ptr @${sym}(double, ptr, ptr)`);
    const t = B.tmp();
    B.line(
      `${t} = call ptr @${sym}(double ${args[0]!.name}, ptr ${args[1]!.name}, ptr ${args[2]!.name})`,
    );
    const out = host.own({ name: t, type: e.type });
    host.emitPendingCheck();
    return out;
  }
  if (e.fn === "zlib.promise" || e.fn === "zlib.promiseDyn") {
    // (mode, data, options): data and options borrowed; the +1 promise
    // settles from the worker pool, or is already rejected.
    host.usesTimers = true;
    const args = e.args.map((a) => host.emitExpr(a));
    const sym = e.fn === "zlib.promise" ? "scr_zlib_codec_promise" : "scr_zlib_codec_promise_dyn";
    host.declare(`declare ptr @${sym}(ptr, double, ptr)`);
    const t = B.tmp();
    B.line(
      `${t} = call ptr @${sym}(ptr ${args[1]!.name}, double ${args[0]!.name}, ptr ${args[2]!.name})`,
    );
    return host.own({ name: t, type: e.type });
  }
  if (e.fn === "zlib.cbOpts" || e.fn === "zlib.cbOptsDyn") {
    // (mode, data, options, callback): the options validate before the
    // submission (a pending throw); the callback moves into the operation.
    host.usesTimers = true;
    const args = e.args.map((a) => host.emitExpr(a));
    const cbT = e.args[3]!.type;
    if (cbT.kind !== "func")
      throw new InternalCompilerError("llvm emitter bug: zlib callback not a func");
    host.toHeap(args[3]!);
    const adapter = host.zlibBytesThunkFor(cbT);
    const sym =
      e.fn === "zlib.cbOpts" ? "scr_zlib_codec_async_opts" : "scr_zlib_codec_async_opts_dyn";
    host.declare(`declare void @${sym}(ptr, double, ptr, ptr, ptr)`);
    B.line(
      `call void @${sym}(ptr ${args[1]!.name}, double ${args[0]!.name}, ptr ${args[2]!.name}, ptr ${args[3]!.name}, ptr @${adapter})`,
    );
    host.emitPendingCheck();
    return { name: "", type: e.type };
  }
  if (e.fn === "zlib.streamNew") {
    // The stream's engine steps run on the worker pool; the options value
    // is borrowed and the +1 stream may be NULL with a pending throw.
    host.usesTimers = true;
    const args = e.args.map((a) => host.emitExpr(a));
    host.declare("declare ptr @scr_zlib_stream_new(double, ptr)");
    const t = B.tmp();
    B.line(`${t} = call ptr @scr_zlib_stream_new(double ${args[0]!.name}, ptr ${args[1]!.name})`);
    const out = host.own({ name: t, type: e.type });
    host.emitPendingCheck();
    return out;
  }
  if (e.fn === "zlib.streamBytesWritten") {
    const recv = host.emitExpr(e.args[0]!);
    host.declare("declare double @scr_zlib_stream_bytes_written(ptr)");
    const t = B.tmp();
    B.line(`${t} = call double @scr_zlib_stream_bytes_written(ptr ${recv.name})`);
    return { name: t, type: e.type };
  }
  if (
    e.fn === "zlib.streamFlush" ||
    e.fn === "zlib.streamFlushCb" ||
    e.fn === "zlib.streamParams" ||
    e.fn === "zlib.streamParamsCb" ||
    e.fn === "zlib.streamClose" ||
    e.fn === "zlib.streamCloseCb" ||
    e.fn === "zlib.streamReset"
  ) {
    // Receiver and dyn operands borrowed; the trailing () => void callback
    // of the Cb forms MOVES (NULL when absent).
    const args = e.args.map((a) => host.emitExpr(a));
    const withCb = e.fn.endsWith("Cb");
    const base = withCb ? e.fn.slice(0, -2) : e.fn;
    const operands = args.slice(0, withCb ? -1 : undefined).map((a) => `ptr ${a.name}`);
    let cb = "null";
    if (withCb) {
      host.toHeap(args[args.length - 1]!);
      cb = args[args.length - 1]!.name;
    }
    const sym =
      base === "zlib.streamFlush"
        ? "scr_zlib_stream_flush"
        : base === "zlib.streamParams"
          ? "scr_zlib_stream_params"
          : base === "zlib.streamClose"
            ? "scr_zlib_stream_close"
            : "scr_zlib_stream_reset";
    const params = base === "zlib.streamReset" ? operands : [...operands, `ptr ${cb}`];
    host.declare(`declare void @${sym}(${params.map(() => "ptr").join(", ")})`);
    B.line(`call void @${sym}(${params.join(", ")})`);
    if (base !== "zlib.streamClose") host.emitPendingCheck();
    return { name: "", type: e.type };
  }
  if (e.fn === "zlib.deflateLevelSync") {
    const args = e.args.map((arg) => host.emitExpr(arg));
    host.declare("declare ptr @scr_zlib_deflate_mode(ptr, double, double)");
    const raw = B.tmp();
    B.line(
      `${raw} = call ptr @scr_zlib_deflate_mode(ptr ${args[0]!.name}, double ${args[1]!.name}, double ${args[2]!.name})`,
    );
    return host.own({ name: raw, type: e.type });
  }
  if (
    e.fn === "zlib.deflateRawSync" ||
    e.fn === "zlib.inflateRawSync" ||
    e.fn === "zlib.gzipSync" ||
    e.fn === "zlib.gunzipSync" ||
    e.fn === "zlib.unzipSync"
  ) {
    const input = host.emitExpr(e.args[0]!);
    const compressing = e.fn === "zlib.deflateRawSync" || e.fn === "zlib.gzipSync";
    const mode =
      e.fn === "zlib.deflateRawSync" || e.fn === "zlib.inflateRawSync"
        ? 1
        : e.fn === "zlib.unzipSync"
          ? 3
          : 2;
    const sym = compressing ? "scr_zlib_deflate_mode" : "scr_zlib_inflate_mode";
    host.declare(
      compressing ? `declare ptr @${sym}(ptr, double, double)` : `declare ptr @${sym}(ptr, double)`,
    );
    const raw = B.tmp();
    const args = compressing
      ? `ptr ${input.name}, double ${f64Lit(mode)}, double ${f64Lit(-1)}`
      : `ptr ${input.name}, double ${f64Lit(mode)}`;
    B.line(`${raw} = call ptr @${sym}(${args})`);
    const out = host.own({ name: raw, type: e.type });
    if (!compressing) host.emitPendingCheck();
    return out;
  }
  if (e.fn === "fs.renameCb") {
    // The callback MOVES into the next-turn operation. Its emitted
    // adapter materializes the callback's Error | null union (or the
    // checkJs dyn argument) from the runtime's borrowed ScrError.
    host.usesTimers = true;
    const args = e.args.map((a) => host.emitExpr(a));
    const cbT = e.args[2]!.type;
    if (cbT.kind !== "func")
      throw new InternalCompilerError("llvm emitter bug: fs.rename callback not a func");
    host.toHeap(args[2]!);
    const adapter = host.fsRenameThunkFor(cbT);
    host.declare(`declare void @scr_fs_rename_async(ptr, ptr, ptr, ptr)`);
    B.line(
      `call void @scr_fs_rename_async(ptr ${args[0]!.name}, ptr ${args[1]!.name}, ptr ${args[2]!.name}, ptr @${adapter})`,
    );
    // A path with a null byte throws before the rename is queued.
    host.emitPendingCheck();
    return { name: "", type: e.type };
  }
  if (
    e.fn === "fileHandle.read" ||
    e.fn === "fileHandle.writeBytes" ||
    e.fn === "fileHandle.writeStr" ||
    e.fn === "fileHandle.readv" ||
    e.fn === "fileHandle.writev"
  ) {
    if (e.type.kind !== "promise" || e.type.inner.kind !== "record") {
      throw new InternalCompilerError(`llvm emitter bug: ${e.fn} result`);
    }
    const args = e.args.map((a) => host.emitExpr(a));
    const vector = e.fn === "fileHandle.readv" || e.fn === "fileHandle.writev";
    const sym = vector
      ? e.fn === "fileHandle.readv"
        ? "scr_file_handle_readv"
        : "scr_file_handle_writev"
      : e.fn === "fileHandle.read"
        ? "scr_file_handle_read"
        : e.fn === "fileHandle.writeBytes"
          ? "scr_file_handle_write_bytes"
          : "scr_file_handle_write_str";
    const tail = vector
      ? "ptr, ptr, double"
      : e.fn === "fileHandle.writeStr"
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
    const countField =
      e.fn === "fileHandle.read" || e.fn === "fileHandle.readv" ? "bytesRead" : "bytesWritten";
    host.storeField(host.recordFieldPtr(rec, inner.shapeId, countField).ptr, F64, count, false);
    const payload = host.retainHeap(args[1]!.name, e.args[1]!.type);
    B.line(
      `store ptr ${payload}, ptr ${host.recordFieldPtr(rec, inner.shapeId, vector ? "buffers" : "buffer").ptr}`,
    );
    const rc = vAdapters(host.shapeHost, inner);
    host.declare(`declare ptr @scr_promise_settled_ref(ptr, ptr, ptr, ptr)`);
    const result = B.tmp();
    B.line(
      `${result} = call ptr @scr_promise_settled_ref(ptr ${rec}, ptr ${rc.retain}, ptr ${rc.release}, ptr ${traceArg(host.shapeHost, inner)})`,
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
    if (cbT.kind !== "func")
      throw new InternalCompilerError("llvm emitter bug: fs.watchCb callback not a func");
    const path = host.emitExpr(e.args[0]!);
    const cb = host.emitExpr(e.args[1]!);
    host.toHeap(cb);
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
  if (e.fn === "fs.globTypesSync" || e.fn === "fsp.globTypes") {
    // Dirent rows from one glob snapshot (scr_glob.c): mode 1 is the
    // globSync form, 3 the fs/promises form with resolved parent paths.
    if (e.type.kind !== "array" || e.type.elem.kind !== "record") {
      throw new InternalCompilerError(
        `llvm emitter bug: ${e.fn} result is not a Dirent record array`,
      );
    }
    const arrayT = e.type;
    const recT = e.type.elem;
    const pattern = host.emitExpr(e.args[0]!);
    const options = host.emitExpr(e.args[1]!);
    const mode = e.fn === "fsp.globTypes" ? "3.0" : "1.0";
    host.declare(`declare ptr @scr_fs_glob(ptr, ptr, double)`);
    host.declare(`declare ${host.sizeType} @scr_fs_glob_count(ptr)`);
    host.declare(`declare ptr @scr_fs_glob_name(ptr, ${host.sizeType})`);
    host.declare(`declare ptr @scr_fs_glob_parent(ptr, ${host.sizeType})`);
    host.declare(`declare double @scr_fs_glob_type(ptr, ${host.sizeType})`);
    host.declare(`declare void @scr_fs_glob_free(ptr)`);
    const snap = B.tmp();
    B.line(
      `${snap} = call ptr @scr_fs_glob(ptr ${pattern.name}, ptr ${options.name}, double ${mode})`,
    );
    host.emitPendingCheck();
    const cnt = B.tmp();
    B.line(`${cnt} = call ${host.sizeType} @scr_fs_glob_count(ptr ${snap})`);
    const arr = B.tmp();
    B.line(`${arr} = ${arrNewCall(host.shapeHost, recT, cnt)}`);
    const arrayOut = host.own({ name: arr, type: arrayT });
    const iSlot = B.slot();
    B.entryAllocas.push(`${iSlot} = alloca ${host.sizeType}`);
    B.line(`store ${host.sizeType} 0, ptr ${iSlot}`);
    const lc = B.newLabel("gl.c");
    const lb = B.newLabel("gl.b");
    const le = B.newLabel("gl.e");
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
    B.line(`${dt} = call double @scr_fs_glob_type(ptr ${snap}, ${host.sizeType} ${i})`);
    host.storeField(host.recordFieldPtr(row, recT.shapeId, "%dtype").ptr, F64, dt, false);
    const nm = B.tmp();
    B.line(`${nm} = call ptr @scr_fs_glob_name(ptr ${snap}, ${host.sizeType} ${i}) ; +1`);
    B.line(`store ptr ${nm}, ptr ${host.recordFieldPtr(row, recT.shapeId, "name").ptr}`);
    const parent = B.tmp();
    B.line(`${parent} = call ptr @scr_fs_glob_parent(ptr ${snap}, ${host.sizeType} ${i}) ; +1`);
    B.line(`store ptr ${parent}, ptr ${host.recordFieldPtr(row, recT.shapeId, "parentPath").ptr}`);
    host.arrPush(arr, "ref", row, null); // push takes ownership of the row
    const i2 = B.tmp();
    B.line(`${i2} = add ${host.sizeType} ${i}, 1`);
    B.line(`store ${host.sizeType} ${i2}, ptr ${iSlot}`);
    B.br(lc);
    B.startBlock(le);
    B.line(`call void @scr_fs_glob_free(ptr ${snap})`);
    return arrayOut;
  }
  if (e.fn === "fs.statProbeSync" || e.fn === "fs.lstatProbeSync") {
    // `Stats | undefined` — the runtime answers a +1 Stats, or NULL for a
    // missing entry when throwIfNoEntry is false (other failures throw).
    if (e.type.kind !== "union")
      throw new InternalCompilerError(`llvm emitter bug: ${e.fn} result is not a union`);
    const def = host.unionsById.get(e.type.unionId);
    const statsTag = def ? def.arms.findIndex((a) => a.kind === "stats") : -1;
    const undefTag = undefinedArmTag(e.type, host.unionsById);
    if (statsTag < 0 || undefTag < 0)
      throw new InternalCompilerError(`llvm emitter bug: ${e.fn} union lacks its arms`);
    const path = host.emitExpr(e.args[0]!);
    const throws = host.emitExpr(e.args[1]!);
    host.declare(`declare ptr @scr_fs_stat_probe(ptr, i1 zeroext, i1 zeroext)`);
    const raw = B.tmp();
    const noFollow = e.fn === "fs.lstatProbeSync" ? "true" : "false";
    B.line(
      `${raw} = call ptr @scr_fs_stat_probe(ptr ${path.name}, i1 zeroext ${noFollow}, i1 zeroext ${throws.name})`,
    );
    host.emitPendingCheck();
    return host.wrapNullable(raw, raw, STATS_T, statsTag, e.type, undefTag);
  }
  if (e.fn === "fs.readdirTypesSync" || e.fn === "fsp.readdirTypes") {
    // Dirent rows assembled inline from one scandir snapshot — the C
    // emitter's flat loop. The sync form checks a scandir error before
    // allocation. The promise form lets the null-tolerant count/free
    // accessors turn a failed snapshot into an empty dummy array, then
    // settled_ref converts the pending exception to a rejection and
    // releases that dummy.
    const promiseForm = e.fn === "fsp.readdirTypes";
    const arrayT = promiseForm && e.type.kind === "promise" ? e.type.inner : e.type;
    if (arrayT.kind !== "array" || arrayT.elem.kind !== "record") {
      throw new InternalCompilerError(
        `llvm emitter bug: ${e.fn} result is not a Dirent record array`,
      );
    }
    const recT = arrayT.elem;
    const path = host.emitExpr(e.args[0]!);
    host.declare(`declare ptr @scr_fs_scandir(ptr)`);
    host.declare(`declare ${host.sizeType} @scr_fs_scandir_count(ptr)`);
    host.declare(`declare ptr @scr_fs_scandir_name(ptr, ${host.sizeType})`);
    host.declare(`declare double @scr_fs_scandir_type(ptr, ${host.sizeType})`);
    host.declare(`declare void @scr_fs_scandir_free(ptr)`);
    const snap = B.tmp();
    B.line(`${snap} = call ptr @scr_fs_scandir(ptr ${path.name})`);
    if (!promiseForm) host.emitPendingCheck();
    const cnt = B.tmp();
    B.line(`${cnt} = call ${host.sizeType} @scr_fs_scandir_count(ptr ${snap})`);
    const arr = B.tmp();
    B.line(`${arr} = ${arrNewCall(host.shapeHost, recT, cnt)}`);
    const arrayOut = host.own({ name: arr, type: arrayT });
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
    host.storeField(host.recordFieldPtr(row, recT.shapeId, "%dtype").ptr, F64, dt, false);
    const nm = B.tmp();
    B.line(`${nm} = call ptr @scr_fs_scandir_name(ptr ${snap}, ${host.sizeType} ${i}) ; +1`);
    B.line(`store ptr ${nm}, ptr ${host.recordFieldPtr(row, recT.shapeId, "name").ptr}`);
    B.line(
      `store ptr ${host.retainHeap(path.name, STRING)}, ptr ${host.recordFieldPtr(row, recT.shapeId, "parentPath").ptr}`,
    );
    host.arrPush(arr, "ref", row, null); // push takes ownership of the row
    const i2 = B.tmp();
    B.line(`${i2} = add ${host.sizeType} ${i}, 1`);
    B.line(`store ${host.sizeType} ${i2}, ptr ${iSlot}`);
    B.br(lc);
    B.startBlock(le);
    B.line(`call void @scr_fs_scandir_free(ptr ${snap})`);
    if (!promiseForm) return arrayOut;
    const rc = vAdapters(host.shapeHost, arrayT);
    host.declare(`declare ptr @scr_promise_settled_ref(ptr, ptr, ptr, ptr)`);
    host.toHeap(arrayOut); // promise fulfillment owns the result array
    const promise = B.tmp();
    B.line(
      `${promise} = call ptr @scr_promise_settled_ref(ptr ${arr}, ptr ${rc.retain}, ptr ${rc.release}, ptr ${traceArg(host.shapeHost, arrayT)})`,
    );
    return host.own({ name: promise, type: e.type });
  }
  if (e.fn === "dir.readSync" || e.fn === "dir.read") {
    // `Dirent | null`: scr_dir_read answers the next entry's +1 name and
    // kind, or false at the end; the row is the call site's Dirent record
    // (parentPath is the Dir's path), built only for an entry. The sync
    // form checks a closed-Dir error first; the promise form lets
    // settled_ref turn it into a rejection of the (null) dummy.
    const promiseForm = e.fn === "dir.read";
    const unionT = promiseForm && e.type.kind === "promise" ? e.type.inner : e.type;
    if (unionT.kind !== "union")
      throw new InternalCompilerError(
        `llvm emitter bug: ${e.fn} result is not a Dirent | null union`,
      );
    const def = host.unionsById.get(unionT.unionId);
    const recTag = def ? def.arms.findIndex((a) => a.kind === "record") : -1;
    const nullTag = def ? def.arms.findIndex((a) => a.kind === "nullT") : -1;
    const recT = recTag >= 0 ? def!.arms[recTag]! : undefined;
    if (!recT || recT.kind !== "record" || nullTag < 0)
      throw new InternalCompilerError(`llvm emitter bug: ${e.fn} union lacks its arms`);
    const dir = host.emitExpr(e.args[0]!);
    host.declare(`declare zeroext i1 @scr_dir_read(ptr, ptr, ptr)`);
    host.declare(`declare ptr @scr_dir_path(ptr)`);
    const nameSlot = B.slot();
    const kindSlot = B.slot();
    const rowSlot = B.slot();
    B.entryAllocas.push(
      `${nameSlot} = alloca ptr`,
      `${kindSlot} = alloca double`,
      `${rowSlot} = alloca ptr`,
    );
    const has = B.tmp();
    B.line(
      `${has} = call zeroext i1 @scr_dir_read(ptr ${dir.name}, ptr ${nameSlot}, ptr ${kindSlot})`,
    );
    if (!promiseForm) host.emitPendingCheck();
    B.line(`store ptr null, ptr ${rowSlot}`);
    const lr = B.newLabel("dr.r");
    const lj = B.newLabel("dr.j");
    B.condBr(has, lr, lj);
    B.startBlock(lr);
    const row = B.tmp();
    B.line(`${row} = call ptr @${mangleRecordNew(recT.shapeId)}()`);
    const kind = B.tmp();
    B.line(`${kind} = load double, ptr ${kindSlot}`);
    host.storeField(host.recordFieldPtr(row, recT.shapeId, "%dtype").ptr, F64, kind, false);
    const nm = B.tmp();
    B.line(`${nm} = load ptr, ptr ${nameSlot} ; +1`);
    B.line(`store ptr ${nm}, ptr ${host.recordFieldPtr(row, recT.shapeId, "name").ptr}`);
    const parent = B.tmp();
    B.line(`${parent} = call ptr @scr_dir_path(ptr ${dir.name}) ; +1`);
    B.line(`store ptr ${parent}, ptr ${host.recordFieldPtr(row, recT.shapeId, "parentPath").ptr}`);
    B.line(`store ptr ${row}, ptr ${rowSlot}`);
    B.br(lj);
    B.startBlock(lj);
    const raw = B.tmp();
    B.line(`${raw} = load ptr, ptr ${rowSlot}`);
    const value = host.wrapNullable(raw, raw, recT, recTag, unionT, nullTag);
    if (!promiseForm) return value;
    const rc = vAdapters(host.shapeHost, unionT);
    host.declare(`declare ptr @scr_promise_settled_ref(ptr, ptr, ptr, ptr)`);
    host.toHeap(value);
    const promise = B.tmp();
    B.line(
      `${promise} = call ptr @scr_promise_settled_ref(ptr ${value.name}, ptr ${rc.retain}, ptr ${rc.release}, ptr ${traceArg(host.shapeHost, unionT)})`,
    );
    return host.own({ name: promise, type: e.type });
  }
  return host.emitGenericLibCall(e);
}

export function emitPathUrlLibCall(host: LlvmEmitterContext, e: LibCallExpr): LlValue {
  const B = host.B;
  if (e.fn === "sp.get") {
    // `string | null` — the sym.desc pattern with a null arm: the
    // runtime answers a +1 string or NULL.
    if (e.type.kind !== "union")
      throw new InternalCompilerError("llvm emitter bug: sp.get result is not a union");
    const def = host.unionsById.get(e.type.unionId);
    const strTag = def ? def.arms.findIndex((a) => a.kind === "string") : -1;
    const nullTag = def ? def.arms.findIndex((a) => a.kind === "nullT") : -1;
    if (strTag < 0 || nullTag < 0)
      throw new InternalCompilerError("llvm emitter bug: sp.get union lacks its arms");
    const args = e.args.map((a) => host.emitExpr(a));
    host.declare(`declare ptr @scr_sp_get(ptr, ptr)`);
    const raw = B.tmp();
    B.line(`${raw} = call ptr @scr_sp_get(ptr ${args[0]!.name}, ptr ${args[1]!.name})`);
    return host.wrapNullable(raw, raw, STRING, strTag, e.type, nullTag);
  }
  if (e.fn === "qs.parse") {
    // The ParsedUrlQuery dictionary: a fresh pure-index-signature
    // record whose overflow map the runtime scan fills
    // (scr_qs_parse_into groups repeats into string[] buckets).
    // The frontend verified the structure;
    // lookups here only guard emitter bugs. Args: qs, sep, eq, maxKeys.
    if (e.type.kind !== "record")
      throw new InternalCompilerError("llvm emitter bug: qs.parse result is not a record");
    const dictShape = host.recordsById.get(e.type.shapeId);
    const iv = dictShape?.indexValue;
    if (!dictShape || iv?.kind !== "union")
      throw new InternalCompilerError("llvm emitter bug: qs.parse dict shape");
    const ivDef = host.unionsById.get(iv.unionId);
    const strTag = ivDef?.arms.findIndex((a) => a.kind === "string") ?? -1;
    const arrTag = ivDef?.arms.findIndex((a) => a.kind === "array") ?? -1;
    if (strTag < 0 || arrTag < 0)
      throw new InternalCompilerError("llvm emitter bug: qs.parse index union lacks its arms");
    const args = e.args.map((a) => host.emitExpr(a));
    host.declare(`declare void @scr_qs_parse_into(ptr, ptr, ptr, ptr, double, i32, i32)`);
    const dict = B.tmp();
    B.line(`${dict} = call ptr @${mangleRecordNew(e.type.shapeId)}()`);
    const out = host.own({ name: dict, type: e.type });
    // Node builds the result with a null prototype.
    B.line(`store i8 1, ptr ${host.recordMapFlagsPtr(dict, e.type.shapeId)}`);
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
    if (e.type.kind !== "record")
      throw new InternalCompilerError("llvm emitter bug: networkInterfaces result is not a record");
    const dictShape = host.recordsById.get(e.type.shapeId);
    const iv = dictShape?.indexValue;
    if (!dictShape || iv?.kind !== "union")
      throw new InternalCompilerError("llvm emitter bug: networkInterfaces dict shape");
    const ivDef = host.unionsById.get(iv.unionId);
    const arrTag = ivDef?.arms.findIndex((a) => a.kind === "array") ?? -1;
    const arrT = ivDef?.arms[arrTag];
    if (arrT?.kind !== "array" || arrT.elem.kind !== "union")
      throw new InternalCompilerError("llvm emitter bug: networkInterfaces bucket type");
    const infoT = arrT.elem;
    const infoDef = host.unionsById.get(infoT.unionId);
    if (!infoDef || infoDef.arms.length !== 2)
      throw new InternalCompilerError("llvm emitter bug: networkInterfaces Info union");
    const tag6 = infoDef.arms.findIndex(
      (a) =>
        a.kind === "record" &&
        host.recordsById.get(a.shapeId)?.fields.find((f) => f.name === "scopeid")?.type.kind ===
          "f64",
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
      if (t?.kind !== "record")
        throw new InternalCompilerError("llvm emitter bug: networkInterfaces Info arm");
      const shape = host.recordsById.get(t.shapeId);
      if (!shape) throw new InternalCompilerError("llvm emitter bug: networkInterfaces Info shape");
      const cidrT = shape.fields.find((f) => f.name === "cidr")?.type;
      const cidrDef = cidrT?.kind === "union" ? host.unionsById.get(cidrT.unionId) : undefined;
      if (cidrT?.kind !== "union" || !cidrDef)
        throw new InternalCompilerError("llvm emitter bug: networkInterfaces cidr type");
      const cidrStrTag = cidrDef.arms.findIndex((a) => a.kind === "string");
      const cidrNullTag = cidrDef.arms.findIndex((a) => a.kind === "nullT");
      const r = B.tmp();
      B.line(`${r} = call ptr @${mangleRecordNew(t.shapeId)}()`);
      const fields: [string, string][] = [
        ["address", "scr_os_ifaddrs_address"],
        ["netmask", "scr_os_ifaddrs_netmask"],
        ["family", "scr_os_ifaddrs_family"],
        ["mac", "scr_os_ifaddrs_mac"],
      ];
      for (const [field, sym] of fields) {
        const v = B.tmp();
        B.line(`${v} = call ptr @${sym}(ptr ${snap}, ${host.sizeType} ${i}) ; +1`);
        B.line(`store ptr ${v}, ptr ${host.recordFieldPtr(r, t.shapeId, field).ptr}`);
      }
      const internal = B.tmp();
      B.line(
        `${internal} = call zeroext i1 @scr_os_ifaddrs_internal(ptr ${snap}, ${host.sizeType} ${i})`,
      );
      host.storeField(
        host.recordFieldPtr(r, t.shapeId, "internal").ptr,
        { kind: "bool" },
        internal,
        false,
      );
      const cs = B.tmp();
      B.line(
        `${cs} = call ptr @scr_os_ifaddrs_cidr(ptr ${snap}, ${host.sizeType} ${i}) ; +1 or null`,
      );
      const hasCidr = B.tmp();
      B.line(`${hasCidr} = icmp ne ptr ${cs}, null`);
      const lcs = B.newLabel("ni.cs");
      const lcn = B.newLabel("ni.cn");
      const lcj = B.newLabel("ni.cj");
      const cidrSlot = B.slot();
      B.entryAllocas.push(`${cidrSlot} = alloca ptr`);
      B.condBr(hasCidr, lcs, lcn);
      B.startBlock(lcs);
      const cu = host.unionNewOwned(cidrT.unionId, cidrStrTag, { name: cs, type: STRING });
      B.line(`store ptr ${cu}, ptr ${cidrSlot}`);
      B.br(lcj);
      B.startBlock(lcn);
      // The unit arm is immortal in both representations: no retain owed.
      B.line(`store ptr ${host.unitInstanceRef(cidrT.unionId, cidrNullTag)}, ptr ${cidrSlot}`);
      B.br(lcj);
      B.startBlock(lcj);
      const cv = B.tmp();
      B.line(`${cv} = load ptr, ptr ${cidrSlot}`);
      B.line(`store ptr ${cv}, ptr ${host.recordFieldPtr(r, t.shapeId, "cidr").ptr}`);
      if (v6) {
        const sc = B.tmp();
        B.line(`${sc} = call double @scr_os_ifaddrs_scopeid(ptr ${snap}, ${host.sizeType} ${i})`);
        host.storeField(host.recordFieldPtr(r, t.shapeId, "scopeid").ptr, F64, sc, false);
      } else {
        const st = shape.fields.find((f) => f.name === "scopeid")?.type;
        if (st?.kind !== "union")
          throw new InternalCompilerError("llvm emitter bug: networkInterfaces IPv4 scopeid type");
        // IPv4 entries have no scopeid property at all (immortal: no
        // retain owed).
        const scopeid = host.recordFieldPtr(r, t.shapeId, "scopeid");
        host.storeField(
          scopeid.ptr,
          scopeid.type,
          host.absentInstanceRef(st.unionId),
          scopeid.inline,
        );
      }
      // The row (+1) moves into its union arm (a shape union is the row).
      const rowU = host.unionNewOwned(infoT.unionId, tag, { name: r, type: t });
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
    const peeked = host.unionPeek(cell, iv.unionId);
    const retained = B.tmp();
    B.line(`${retained} = call ptr @scr_arr_retain_v(ptr ${peeked})`);
    B.line(`store ptr ${retained}, ptr ${rowsSlot}`);
    host.releaseFrame(cell, iv);
    B.br(lj);
    B.startBlock(lm);
    const fresh = B.tmp();
    B.line(`${fresh} = ${arrNewCall(host.shapeHost, infoT, "1")}`);
    const freshRet = B.tmp();
    B.line(`${freshRet} = call ptr @scr_arr_retain_v(ptr ${fresh})`);
    const bucketU = host.unionNewOwned(iv.unionId, arrTag, { name: freshRet, type: arrT });
    B.line(`call void @scr_map_set_str_ref(ptr ${ovf}, ptr ${nm}, ptr ${bucketU})`);
    B.line(`store ptr ${fresh}, ptr ${rowsSlot}`);
    B.br(lj);
    B.startBlock(lj);
    const rows = B.tmp();
    B.line(`${rows} = load ptr, ptr ${rowsSlot}`);
    host.arrPush(rows, "ref", row, null); // push takes ownership of the row
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

/** Math.pow(2, n): for an integer n from -1074 to 1023 the result is the
 * power of two whose bits are its exponent field (or, below -1022, one
 * mantissa bit of a subnormal), the value pow returns. Other exponents call
 * scr_math_pow. */
function emitPowerOfTwo(host: LlvmEmitterContext, n: string): string {
  const B = host.B;
  const check = B.newLabel("pow2.check");
  const exact = B.newLabel("pow2.exact");
  const call = B.newLabel("pow2.call");
  const join = B.newLabel("pow2.join");
  const low = B.tmp();
  const high = B.tmp();
  const inRange = B.tmp();
  B.line(`${low} = fcmp oge double ${n}, ${f64Lit(-1074)}`);
  B.line(`${high} = fcmp ole double ${n}, ${f64Lit(1023)}`);
  B.line(`${inRange} = and i1 ${low}, ${high}`);
  B.condBr(inRange, check, call);
  B.startBlock(check);
  const int = B.tmp();
  const back = B.tmp();
  const integral = B.tmp();
  B.line(`${int} = fptosi double ${n} to i32`);
  B.line(`${back} = sitofp i32 ${int} to double`);
  B.line(`${integral} = fcmp oeq double ${back}, ${n}`);
  B.condBr(integral, exact, call);
  B.startBlock(exact);
  const normal = B.tmp();
  const biased = B.tmp();
  const biasedWide = B.tmp();
  const normalBits = B.tmp();
  const shift = B.tmp();
  const shiftWide = B.tmp();
  const subnormalBits = B.tmp();
  const bits = B.tmp();
  const power = B.tmp();
  B.line(`${normal} = icmp sge i32 ${int}, -1022`);
  B.line(`${biased} = add i32 ${int}, 1023`);
  B.line(`${biasedWide} = zext i32 ${biased} to i64`);
  B.line(`${normalBits} = shl i64 ${biasedWide}, 52`);
  B.line(`${shift} = add i32 ${int}, 1074`);
  B.line(`${shiftWide} = zext i32 ${shift} to i64`);
  B.line(`${subnormalBits} = shl i64 1, ${shiftWide}`);
  B.line(`${bits} = select i1 ${normal}, i64 ${normalBits}, i64 ${subnormalBits}`);
  B.line(`${power} = bitcast i64 ${bits} to double`);
  const exactEnd = B.currentLabel();
  B.br(join);
  B.startBlock(call);
  host.declare(`declare double @scr_math_pow(double, double)`);
  const called = B.tmp();
  B.line(`${called} = call double @scr_math_pow(double ${f64Lit(2)}, double ${n})`);
  const callEnd = B.currentLabel();
  B.br(join);
  B.startBlock(join);
  const out = B.tmp();
  B.line(`${out} = phi double [ ${power}, %${exactEnd} ], [ ${called}, %${callEnd} ]`);
  return out;
}

/** `base ** exponent` and `Math.pow(base, exponent)` as V8's math::pow
 * answers them: a literal exponent 2 is `base * base`, a literal 0.5 is
 * `sqrt(base + 0)` (+Infinity for an infinite base), and every other
 * exponent calls scr_math_pow, which applies V8's other special cases
 * before the platform pow. The platform pow is never called by its libm
 * name, which LLVM would rewrite (pow(2, x) to exp2(x), pow(x, -1) to 1/x)
 * into answers that can differ from V8's. */
export function emitPowF64(
  host: LlvmEmitterContext,
  base: string,
  exponent: string,
  exponentExpr: IrExpr,
): string {
  const B = host.B;
  const literal =
    exponentExpr.kind === "numLit"
      ? exponentExpr.value
      : exponentExpr.kind === "unary" &&
          exponentExpr.op === "-" &&
          exponentExpr.operand.kind === "numLit"
        ? -exponentExpr.operand.value
        : null;
  const out = B.tmp();
  if (literal === 2) {
    B.line(`${out} = fmul double ${base}, ${base}`);
    return out;
  }
  if (literal === 0.5) {
    host.declare(`declare double @llvm.sqrt.f64(double)`);
    host.declare(`declare double @llvm.fabs.f64(double)`);
    const plus = B.tmp(),
      root = B.tmp(),
      magnitude = B.tmp(),
      infinite = B.tmp();
    B.line(`${plus} = fadd double ${base}, ${f64Lit(0)}`);
    B.line(`${root} = call double @llvm.sqrt.f64(double ${plus})`);
    B.line(`${magnitude} = call double @llvm.fabs.f64(double ${base})`);
    B.line(`${infinite} = fcmp oeq double ${magnitude}, 0x7FF0000000000000`);
    B.line(`${out} = select i1 ${infinite}, double 0x7FF0000000000000, double ${root}`);
    return out;
  }
  host.declare(`declare double @scr_math_pow(double, double)`);
  B.line(
    `${out} = call double @scr_math_pow(double ${base}, double ${exponent}) nounwind willreturn`,
  );
  return out;
}

/** `Math.pow(2, n)`, the divisor emitPowerOfTwoQuotient takes. */
export function isPowerOfTwoCall(e: IrExpr): boolean {
  return (
    e.kind === "libCall" &&
    e.fn === "math.pow" &&
    e.args.length === 2 &&
    e.args[0]!.kind === "numLit" &&
    e.args[0]!.value === 2
  );
}

/** `left / divisor` for a divisor that is usually a power of two
 * (`x / Math.pow(2, n)`). A positive power of two from 2^-1022 to 2^1022
 * has a reciprocal that is a power of two too, whose bits are
 * 0x7FE0000000000000 minus the divisor's, and the product with it is the
 * quotient for every `left`: both are `left` scaled by the same power of
 * two, rounded once. Any other divisor divides. */
export function emitPowerOfTwoQuotient(
  host: LlvmEmitterContext,
  left: string,
  divisor: string,
): string {
  const B = host.B;
  const bits = B.tmp(),
    mantissa = B.tmp(),
    plain = B.tmp(),
    biased = B.tmp(),
    offset = B.tmp(),
    normal = B.tmp(),
    power = B.tmp(),
    inverseBits = B.tmp(),
    inverse = B.tmp(),
    scaled = B.tmp(),
    divided = B.tmp(),
    out = B.tmp();
  B.line(`${bits} = bitcast double ${divisor} to i64`);
  B.line(`${mantissa} = and i64 ${bits}, ${2n ** 52n - 1n}`);
  B.line(`${plain} = icmp eq i64 ${mantissa}, 0`);
  // Biased exponents 1 to 2045 with a clear sign bit.
  B.line(`${biased} = lshr i64 ${bits}, 52`);
  B.line(`${offset} = sub i64 ${biased}, 1`);
  B.line(`${normal} = icmp ult i64 ${offset}, 2045`);
  B.line(`${power} = and i1 ${plain}, ${normal}`);
  B.line(`${inverseBits} = sub i64 ${0x7fe0000000000000n}, ${bits}`);
  B.line(`${inverse} = bitcast i64 ${inverseBits} to double`);
  B.line(`${scaled} = fmul double ${left}, ${inverse}`);
  B.line(`${divided} = fdiv double ${left}, ${divisor}`);
  B.line(`${out} = select i1 ${power}, double ${scaled}, double ${divided}`);
  return out;
}

export function emitPrimitiveLibCall(host: LlvmEmitterContext, e: LibCallExpr): LlValue {
  const B = host.B;
  if (e.fn === "math.min" || e.fn === "math.max") {
    // IEEE 754-2019 minimum/maximum: NaN propagates and -0 orders below +0,
    // exactly Math.min/Math.max of two numbers.
    const a = host.emitExpr(e.args[0]!);
    const b = host.emitExpr(e.args[1]!);
    const intr = e.fn === "math.min" ? "minimum" : "maximum";
    host.declare(`declare double @llvm.${intr}.f64(double, double)`);
    const t = B.tmp();
    B.line(`${t} = call double @llvm.${intr}.f64(double ${a.name}, double ${b.name})`);
    return { name: t, type: e.type };
  }
  if (e.fn === "math.trunc") {
    const v = host.emitExpr(e.args[0]!);
    return { name: emitTruncF64(host, v.name), type: e.type };
  }
  if (e.fn === "math.pow" && e.args[0]!.kind === "numLit" && e.args[0]!.value === 2) {
    const v = host.emitExpr(e.args[1]!);
    return { name: emitPowerOfTwo(host, v.name), type: e.type };
  }
  if (e.fn === "math.pow") {
    const base = host.emitExpr(e.args[0]!);
    const exponent = host.emitExpr(e.args[1]!);
    return { name: emitPowF64(host, base.name, exponent.name, e.args[1]!), type: e.type };
  }
  if (e.fn === "math.floor" || e.fn === "math.ceil") {
    const intr = e.fn === "math.floor" ? "floor" : "ceil";
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
  if (e.fn === "math.sign") {
    const v = host.emitExpr(e.args[0]!);
    const positive = B.tmp();
    B.line(`${positive} = fcmp ogt double ${v.name}, ${f64Lit(0)}`);
    const negative = B.tmp();
    B.line(`${negative} = fcmp olt double ${v.name}, ${f64Lit(0)}`);
    const nonPositive = B.tmp();
    B.line(`${nonPositive} = select i1 ${negative}, double ${f64Lit(-1)}, double ${v.name}`);
    const t = B.tmp();
    B.line(`${t} = select i1 ${positive}, double ${f64Lit(1)}, double ${nonPositive}`);
    return { name: t, type: e.type };
  }
  if (e.fn === "math.clz32") {
    markWrappingOperands(host, e.args[0]!);
    const v = host.emitExpr(e.args[0]!);
    const bits = host.emitToUint32(v.name, e.args[0]!, v.uint32);
    host.declare(`declare i32 @llvm.ctlz.i32(i32, i1)`);
    const count = B.tmp();
    const t = B.tmp();
    B.line(`${count} = call i32 @llvm.ctlz.i32(i32 ${bits}, i1 false)`);
    B.line(`${t} = uitofp i32 ${count} to double`);
    return { name: t, type: e.type, uint32: count };
  }
  if (e.fn === "math.imul") {
    markWrappingOperands(host, e.args[0]!, e.args[1]!);
    const a = host.emitExpr(e.args[0]!);
    const b = host.emitExpr(e.args[1]!);
    const lhs = host.emitToUint32(a.name, e.args[0]!, a.uint32);
    const rhs = host.emitToUint32(b.name, e.args[1]!, b.uint32);
    const product = B.tmp();
    const t = B.tmp();
    B.line(`${product} = mul i32 ${lhs}, ${rhs}`);
    B.line(`${t} = sitofp i32 ${product} to double`);
    return { name: t, type: e.type, uint32: product };
  }
  if (e.fn === "math.f16round") {
    const v = host.emitExpr(e.args[0]!);
    host.declare(`declare zeroext i16 @scr_f16_from_f64(double)`);
    host.declare(`declare double @scr_f16_to_f64(i16 zeroext)`);
    const narrowed = B.tmp();
    const t = B.tmp();
    B.line(`${narrowed} = call zeroext i16 @scr_f16_from_f64(double ${v.name})`);
    B.line(`${t} = call double @scr_f16_to_f64(i16 zeroext ${narrowed})`);
    return { name: t, type: e.type };
  }
  if (e.fn === "math.fround") {
    const v = host.emitExpr(e.args[0]!);
    const narrowed = B.tmp();
    const t = B.tmp();
    B.line(`${narrowed} = fptrunc double ${v.name} to float`);
    B.line(`${t} = fpext float ${narrowed} to double`);
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
    if (e.type.kind !== "union")
      throw new InternalCompilerError(`llvm emitter bug: ${e.fn} result is not a union`);
    const def = host.unionsById.get(e.type.unionId);
    const strTag = def ? def.arms.findIndex((a) => a.kind === "string") : -1;
    const undefTag = undefinedArmTag(e.type, host.unionsById);
    if (strTag < 0 || undefTag < 0)
      throw new InternalCompilerError(`llvm emitter bug: ${e.fn} union lacks its arms`);
    const v = host.emitExpr(e.args[0]!);
    const sym = e.fn === "sym.desc" ? "scr_sym_desc" : "scr_sym_key_for";
    host.declare(`declare ptr @${sym}(ptr)`);
    const raw = B.tmp();
    B.line(`${raw} = call ptr @${sym}(ptr ${v.name})`);
    return host.wrapNullable(raw, raw, STRING, strTag, e.type, undefTag);
  }
  if (e.fn === "string.fromCharCode" || e.fn === "string.fromCodePoint") {
    const packed = e.args[0]!;
    if (
      e.fn === "string.fromCharCode" &&
      packed.kind === "arrayLit" &&
      packed.elems.length === 1 &&
      !packed.spreads?.length
    ) {
      const code = host.emitExpr(packed.elems[0]!);
      host.declare(`declare ptr @scr_str_from_char_code_one(double)`);
      const t = B.tmp();
      B.line(`${t} = call ptr @scr_str_from_char_code_one(double ${code.name})`);
      return host.own({ name: t, type: e.type });
    }
    if (
      e.fn === "string.fromCharCode" &&
      packed.kind === "arrayLit" &&
      packed.elems.length <= 16 &&
      !packed.spreads?.length
    ) {
      // A short argument list passes its codes in a stack array.
      const codes = packed.elems.map((elem) => host.emitExpr(elem));
      const slot = B.slot();
      B.entryAllocas.push(`${slot} = alloca [${Math.max(codes.length, 1)} x double]`);
      codes.forEach((code, i) => {
        const p = B.tmp();
        B.line(
          `${p} = getelementptr inbounds [${Math.max(codes.length, 1)} x double], ptr ${slot}, i64 0, i64 ${i}`,
        );
        B.line(`store double ${code.name}, ptr ${p}`);
      });
      host.declare(`declare ptr @scr_str_from_char_codes(ptr, ${host.sizeType})`);
      const t = B.tmp();
      B.line(
        `${t} = call ptr @scr_str_from_char_codes(ptr ${slot}, ${host.sizeType} ${codes.length})`,
      );
      return host.own({ name: t, type: e.type });
    }
    // One packed f64[] (the frontend built it) or one bytes value (the
    // spread-typed-array form); +1 string.
    const base =
      e.fn === "string.fromCodePoint" ? "scr_str_from_code_point" : "scr_str_from_char_code";
    const sym = e.args[0]!.type.kind === "bytes" ? `${base}_bytes` : base;
    const v = host.emitExpr(e.args[0]!);
    host.declare(`declare ptr @${sym}(ptr)`);
    const t = B.tmp();
    B.line(`${t} = call ptr @${sym}(ptr ${v.name})`);
    const out = host.own({ name: t, type: e.type });
    if (e.fn === "string.fromCodePoint") host.emitPendingCheck();
    return out;
  }
  return host.emitGenericLibCall(e);
}
