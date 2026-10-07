import { emitBorrowedInput } from "./borrowed-inputs.js";
import { borrowsIteratorInputs, borrowsJsonInputs } from "./checked-value-lifetimes.js";
import { emitTlsLibCall } from "./lib-tls.js";
import { emitHttp2LibCall } from "./lib-http2.js";
import { emitDatagramLibCall } from "./lib-datagram.js";
import { emitTestLibCall } from "./lib-test.js";
/* Focused LLVM library-call emission extracted from emitter.ts. */
import { InternalCompilerError } from "../../errors.js";

import { MAY_THROW_LIB_FNS } from "../../ir/builtin-effects.js";
import { LlvmUnsupportedError } from "./unsupported.js";
import type { LlvmEmitterContext, LibCallExpr, LibCallPrefix, LlValue } from "./expr-context.js";
import { LIB_FN_SYMS, USES_TIMERS_LIB_FNS } from "./lib-shared.js";
import { DYN_KIND } from "./dyn.js";
import { rawBytes } from "./lib-abi.js";

export function emitAssertInspectLibCall(host: LlvmEmitterContext, e: LibCallExpr): LlValue {
  const B = host.B;
  if (e.fn === "assert.shapeStr" || e.fn === "assert.shapeRe") {
    // The throws(fn, {shape}) accumulator's slot writers: the key is a
    // C int (the generic path would pass a double through the ABI —
    // fptosi here, exactly the C prototype's implicit conversion).
    // Never throw.
    const key = host.emitExpr(e.args[0]!);
    const v = host.emitExpr(e.args[1]!);
    const sym = e.fn === "assert.shapeStr" ? "scr_assert_shape_str" : "scr_assert_shape_re";
    host.declare(`declare void @${sym}(i32, ptr)`);
    const k32 = B.tmp();
    B.line(`${k32} = fptosi double ${key.name} to i32`);
    B.line(`call void @${sym}(i32 ${k32}, ptr ${v.name})`);
    return { name: "", type: e.type };
  }
  return host.emitGenericLibCall(e);
}

export function emitIoLibCall(host: LlvmEmitterContext, e: LibCallExpr): LlValue {
  const B = host.B;
  if (e.fn === "rl.create") {
    // readline interface handles are runtime IDs (doubles); an open
    // interface holds the loop.
    host.usesTimers = true;
    host.declare(`declare double @scr_rl_create()`);
    const t = B.tmp();
    B.line(`${t} = call double @scr_rl_create()`);
    return { name: t, type: e.type };
  }
  if (e.fn === "rl.question") {
    // The answer callback MOVES into the interface's registry; throws
    // Node's use-after-close error (the may-throw seed).
    host.usesTimers = true;
    const cbT = e.args[2]!.type;
    if (cbT.kind !== "func")
      throw new InternalCompilerError("llvm emitter bug: rl.question callback not a func");
    const args = e.args.map((a) => host.emitExpr(a));
    host.moveTemp(args[2]!);
    const adapter = cbT.params.length === 0 ? "scr_rl_answer_thunk0" : "scr_rl_answer_thunk_str";
    host.declare(`declare void @${adapter}(ptr, ptr)`);
    host.declare(`declare void @scr_rl_question(double, ptr, ptr, ptr)`);
    B.line(
      `call void @scr_rl_question(double ${args[0]!.name}, ptr ${args[1]!.name}, ptr ${args[2]!.name}, ptr @${adapter})`,
    );
    host.emitPendingCheck();
    return { name: "", type: e.type };
  }
  if (e.fn === "rl.close") {
    const id = host.emitExpr(e.args[0]!);
    host.declare(`declare void @scr_rl_close(double)`);
    B.line(`call void @scr_rl_close(double ${id.name})`);
    return { name: "", type: e.type };
  }
  if (e.fn === "rl.onClose") {
    // The close listener MOVES into the interface's registry.
    host.usesTimers = true;
    const id = host.emitExpr(e.args[0]!);
    const cb = host.emitExpr(e.args[1]!);
    host.moveTemp(cb);
    host.declare(`declare void @scr_rl_on_close(double, ptr)`);
    B.line(`call void @scr_rl_on_close(double ${id.name}, ptr ${cb.name})`);
    return { name: "", type: e.type };
  }
  return host.emitGenericLibCall(e);
}

export function emitGenericLibCall(host: LlvmEmitterContext, e: LibCallExpr): LlValue {
  const B = host.B;
  if (host.wasi && e.fn === "async.hop") {
    host.emitWasiSuspend(null);
    return { name: "", type: e.type };
  }
  if (host.wasi && e.fn === "async.awaitDyn") {
    const value = host.emitExpr(e.args[0]!);
    host.declare(`declare ptr @scr_dyn_promise_of(ptr)`);
    const promise = B.tmp();
    const isPromise = B.tmp();
    const wait = B.newLabel("await.dyn.promise");
    const hop = B.newLabel("await.dyn.value");
    const ready = B.newLabel("await.dyn.ready");
    B.line(`${promise} = call ptr @scr_dyn_promise_of(ptr ${value.name})`);
    B.line(`${isPromise} = icmp ne ptr ${promise}, null`);
    B.condBr(isPromise, wait, hop);
    B.startBlock(wait);
    host.emitWasiSuspend(promise);
    B.br(ready);
    B.startBlock(hop);
    host.emitWasiSuspend(null);
    B.br(ready);
    B.startBlock(ready);
    host.declare(`declare ptr @scr_await_dyn_value_settled(ptr)`);
    const result = B.tmp();
    B.line(`${result} = call ptr @scr_await_dyn_value_settled(ptr ${value.name})`);
    const output = host.own({ name: result, type: e.type });
    host.emitPendingCheck();
    return output;
  }
  if (e.fn === "dyn.typedRefIs") {
    // A literal brand cannot replace the receiver while being evaluated.
    // Generated class dispatch uses these probes repeatedly on one local.
    const value =
      e.args[1]!.kind === "strLit" ? host.emitReadReceiver(e.args[0]!) : host.emitExpr(e.args[0]!);
    const key = host.emitExpr(e.args[1]!);
    // Expose the capsule tag to LLVM so class dispatch can skip the whole
    // chain of brand comparisons for ordinary checked-dynamic values.
    // Keep the runtime's null handling and evaluate both operands once.
    const slot = B.slot();
    B.entryAllocas.push(`${slot} = alloca i1`);
    B.line(`store i1 false, ptr ${slot}`);
    const present = B.tmp();
    const inspect = B.newLabel("brand.inspect");
    const capsule = B.newLabel("brand.capsule");
    const done = B.newLabel("brand.done");
    B.line(`${present} = icmp ne ptr ${value.name}, null`);
    B.condBr(present, inspect, done);
    B.startBlock(inspect);
    const kind = host.dynKind(value.name);
    const typed = B.tmp();
    B.line(`${typed} = icmp eq i32 ${kind}, ${DYN_KIND.TYPED_REF}`);
    B.condBr(typed, capsule, done);
    B.startBlock(capsule);
    host.declare("declare zeroext i1 @scr_dyn_typed_ref_is_key(ptr, ptr) memory(read)");
    const matches = B.tmp();
    B.line(
      `${matches} = call zeroext i1 @scr_dyn_typed_ref_is_key(ptr ${value.name}, ptr ${key.name})`,
    );
    B.line(`store i1 ${matches}, ptr ${slot}`);
    B.br(done);
    B.startBlock(done);
    const result = B.tmp();
    B.line(`${result} = load i1, ptr ${slot}`);
    return { name: result, type: e.type };
  }
  if (
    e.fn === "crypto.randomBytesCb" ||
    e.fn === "crypto.pbkdf2Cb" ||
    e.fn === "crypto.hkdfCb" ||
    e.fn === "crypto.scryptCb"
  ) {
    host.usesTimers = true;
    const args = e.args.map((arg) => host.emitExpr(arg));
    const cbIndex = e.fn === "crypto.randomBytesCb" ? 1 : e.fn === "crypto.scryptCb" ? 4 : 5;
    const cbT = e.args[cbIndex]!.type;
    if (cbT.kind !== "func")
      throw new InternalCompilerError("llvm emitter bug: crypto callback not a func");
    host.moveTemp(args[cbIndex]!);
    const adapter = host.cryptoBytesThunkFor(cbT, e.fn === "crypto.hkdfCb");
    if (e.fn === "crypto.randomBytesCb") {
      host.declare(`declare void @scr_crypto_random_bytes_async(double, ptr, ptr)`);
      B.line(
        `call void @scr_crypto_random_bytes_async(double ${args[0]!.name}, ptr ${args[1]!.name}, ptr @${adapter})`,
      );
    } else if (e.fn === "crypto.hkdfCb") {
      host.declare(`declare void @scr_crypto_hkdf_async(ptr, ptr, ptr, ptr, double, ptr, ptr)`);
      B.line(
        `call void @scr_crypto_hkdf_async(ptr ${args[0]!.name}, ptr ${args[1]!.name}, ptr ${args[2]!.name}, ptr ${args[3]!.name}, double ${args[4]!.name}, ptr ${args[5]!.name}, ptr @${adapter})`,
      );
    } else if (e.fn === "crypto.scryptCb") {
      host.declare(`declare void @scr_crypto_scrypt_async(ptr, ptr, double, ptr, ptr, ptr)`);
      B.line(
        `call void @scr_crypto_scrypt_async(ptr ${args[0]!.name}, ptr ${args[1]!.name}, double ${args[2]!.name}, ptr ${args[3]!.name}, ptr ${args[4]!.name}, ptr @${adapter})`,
      );
    } else {
      host.declare(
        `declare void @scr_crypto_pbkdf2_async(ptr, ptr, double, double, ptr, ptr, ptr)`,
      );
      B.line(
        `call void @scr_crypto_pbkdf2_async(ptr ${args[0]!.name}, ptr ${args[1]!.name}, double ${args[2]!.name}, double ${args[3]!.name}, ptr ${args[4]!.name}, ptr ${args[5]!.name}, ptr @${adapter})`,
      );
    }
    host.emitPendingCheck();
    return { name: "", type: e.type };
  }
  if (
    e.fn === "http.request" ||
    e.fn === "http.requestCb" ||
    e.fn === "http.requestUrl" ||
    e.fn === "http.requestUrlCb" ||
    e.fn === "http.requestAgent" ||
    e.fn === "http.requestAgentCb" ||
    e.fn === "https.request" ||
    e.fn === "https.requestCb" ||
    e.fn === "https.requestUrl" ||
    e.fn === "https.requestUrlCb"
  ) {
    // The https URL row is the http one with the TLS entry point — same
    // three arguments, same response-callback adapter. The https options
    // row is wider: rejectUnauthorized stays an i1, while its ScrStr or
    // ScrBytes CA value expands to the runtime's raw pointer + length.
    const isTls = e.fn.startsWith("https.");
    const isUrl = e.fn.includes("requestUrl");
    const isTlsOptions = isTls && !isUrl;
    const isAgent = e.fn.startsWith("http.requestAgent");
    const cbIdx = isUrl ? 3 : isTlsOptions ? 9 : isAgent ? 8 : 7;
    const hasCb = e.fn.endsWith("Cb");
    const args = e.args.map((a) => host.emitExpr(a));
    let cb = "null";
    let adapter = "null";
    if (hasCb) {
      const cbT = e.args[cbIdx]!.type;
      if (cbT.kind !== "func")
        throw new InternalCompilerError(`llvm emitter bug: ${e.fn} callback not a func`);
      host.moveTemp(args[cbIdx]!);
      cb = args[cbIdx]!.name;
      const sym = cbT.params.length === 0 ? "scr_http_resp_thunk0" : "scr_http_resp_thunk_res";
      host.declare(`declare void @${sym}(ptr, ptr)`);
      adapter = `@${sym}`;
    }
    const head = args.slice(0, cbIdx);
    const entry = isTlsOptions
      ? "scr_https_request"
      : isTls
        ? "scr_https_request_url"
        : isUrl
          ? "scr_http_request_url"
          : isAgent
            ? "scr_http_request_agent"
            : "scr_http_request";
    let callArgs = head.map((a) => `${host.llType(a.type)} ${a.name}`);
    if (isTlsOptions) {
      callArgs = [
        ...callArgs.slice(0, 8),
        ...rawBytes(host, args[8]!).map((arg) => `${arg.type} ${arg.name}`),
      ];
      host.declare(
        `declare ptr @scr_https_request(ptr, double, ptr, ptr, double, ptr, i1 zeroext, i1 zeroext, ptr, ${host.sizeType}, ptr, ptr)`,
      );
    } else {
      const decls = head.map((a) =>
        host.llType(a.type) === "i1" ? "i1 zeroext" : host.llType(a.type),
      );
      host.declare(`declare ptr @${entry}(${[...decls, "ptr", "ptr"].join(", ")})`);
    }
    const t = B.tmp();
    B.line(`${t} = call ptr @${entry}(${[...callArgs, `ptr ${cb}`, `ptr ${adapter}`].join(", ")})`);
    const out = host.own({ name: t, type: e.type });
    if (MAY_THROW_LIB_FNS.has(e.fn)) host.emitPendingCheck();
    return out;
  }
  if (MAY_THROW_LIB_FNS.has(e.fn) && LIB_FN_SYMS[e.fn] === undefined) {
    throw new LlvmUnsupportedError(`libCall:${e.fn}`, e.loc);
  }
  const sym = LIB_FN_SYMS[e.fn];
  if (sym === undefined) throw new LlvmUnsupportedError(`libCall:${e.fn}`, e.loc);
  const args = e.args.map((a) =>
    borrowsJsonInputs(e.fn) || borrowsIteratorInputs(e.fn)
      ? emitBorrowedInput(host, a)
      : host.emitExpr(a),
  );
  const argDecls = args.map((a) => {
    const ty = host.llType(a.type);
    return ty === "i1" ? "i1 zeroext" : ty;
  });
  const retTy = host.llType(e.type);
  const retDecl = retTy === "i1" ? "zeroext i1" : retTy;
  host.declare(`declare ${retDecl} @${sym}(${argDecls.join(", ")})`);
  const argList = args.map((a, index) => `${argDecls[index]} ${a.name}`).join(", ");
  if (retTy === "void") {
    B.line(`call void @${sym}(${argList})`);
    if (MAY_THROW_LIB_FNS.has(e.fn)) host.emitPendingCheck();
    return { name: "", type: e.type };
  }
  const t = B.tmp();
  B.line(`${t} = call ${retDecl} @${sym}(${argList})`);
  // The result joins its frame BEFORE the pending check so an unwind
  // releases the dummy (NULL for refcounted returns) harmlessly.
  const out = host.own({ name: t, type: e.type });
  if (MAY_THROW_LIB_FNS.has(e.fn)) host.emitPendingCheck();
  return out;
}

export function emitLibCall(host: LlvmEmitterContext, e: LibCallExpr): LlValue {
  if (USES_TIMERS_LIB_FNS.has(e.fn)) host.usesTimers = true;
  if (e.fn === "process.nextTick") return host.emitAsyncContextLibCall(e);
  if (e.fn === "sp.pipeline") return host.emitStreamLibCall(e);
  const prefix = e.fn.slice(0, e.fn.indexOf(".")) as LibCallPrefix;
  switch (prefix) {
    case "fetch":
    case "abort":
    case "island":
    case "json":
      return host.emitWebLibCall(e);
    case "dyn":
    case "global":
      return host.emitDynamicLibCall(e);
    case "fs":
    case "fsp":
    case "fileHandle":
    case "watcher":
    case "stats":
    case "zlib":
    case "atomics":
      return host.emitFilesystemLibCall(e);
    case "path":
    case "os":
    case "url":
    case "sp":
    case "qs":
      return host.emitPathUrlLibCall(e);
    case "math":
    case "num":
    case "str":
    case "regexp":
    case "intl":
    case "sym":
    case "perf":
    case "number":
    case "date":
    case "text":
    case "string":
    case "class":
      return host.emitPrimitiveLibCall(e);
    case "cp":
    case "spawnRes":
    case "child":
    case "writer":
    case "procStream":
      return host.emitChildProcessLibCall(e);
    case "tp":
    case "dc":
    case "timers":
    case "async":
    case "als":
      return host.emitAsyncContextLibCall(e);
    case "process":
    case "stdin":
      return host.emitProcessLibCall(e);
    case "module":
    case "worker":
      return host.emitGenericLibCall(e);
    case "error":
    case "regex":
    case "emitter":
      return host.emitErrorsEventsLibCall(e);
    case "stream":
    case "readable":
    case "writable":
    case "duplex":
    case "transform":
    case "passthrough":
    case "sc":
      return host.emitStreamLibCall(e);
    case "dgram":
    case "dns":
      return emitDatagramLibCall(host, e);
    case "net":
    case "http":
    case "https":
      return host.emitNetworkHttpLibCall(e);
    case "assert":
    case "insp":
      return host.emitAssertInspectLibCall(e);
    case "rl":
    case "strdec":
      return host.emitIoLibCall(e);
    case "console":
    case "weakMap":
    case "weakSet":
    case "ffi":
    case "sharedArrayBuffer":
    case "arrayBuffer":
    case "util":
    case "bigint":
    case "crypto":
    case "buffer":
    case "bytes":
    case "tlsca":
      return host.emitGenericLibCall(e);
    case "test":
      return emitTestLibCall(host, e);
    case "tls":
      return emitTlsLibCall(host, e);
    case "http2":
      return emitHttp2LibCall(host, e);
    default: {
      const _exhaustive: never = prefix;
      void _exhaustive;
      throw new InternalCompilerError("unreachable");
    }
  }
}
