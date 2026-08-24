/* Focused LLVM library-call emission extracted from emitter.ts. */
import { InternalCompilerError } from "../../errors.js";
import { MAY_THROW_LIB_FNS } from "../../ir/ir.js";
import { LlvmUnsupportedError } from "./unsupported.js";
import type { LlvmEmitterContext, LibCallExpr, LibCallPrefix, LlValue } from "./expr-context.js";
import { LIB_FN_SYMS, USES_TIMERS_LIB_FNS } from "./lib-shared.js";

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
      if (cbT.kind !== "func") throw new InternalCompilerError("llvm emitter bug: rl.question callback not a func");
      const args = e.args.map((a) => host.emitExpr(a));
      host.moveTemp(args[2]!);
      const adapter = cbT.params.length === 0 ? "scr_rl_answer_thunk0" : "scr_rl_answer_thunk_str";
      host.declare(`declare void @${adapter}(ptr, ptr)`);
      host.declare(`declare void @scr_rl_question(double, ptr, ptr, ptr)`);
      B.line(`call void @scr_rl_question(double ${args[0]!.name}, ptr ${args[1]!.name}, ptr ${args[2]!.name}, ptr @${adapter})`);
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
    if (e.fn === "http.request" || e.fn === "http.requestCb" || e.fn === "http.requestUrl" || e.fn === "http.requestUrlCb" ||
        e.fn === "http.requestAgent" || e.fn === "http.requestAgentCb" ||
        e.fn === "https.request" || e.fn === "https.requestCb" ||
        e.fn === "https.requestUrl" || e.fn === "https.requestUrlCb") {
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
        if (cbT.kind !== "func") throw new InternalCompilerError(`llvm emitter bug: ${e.fn} callback not a func`);
        host.moveTemp(args[cbIdx]!);
        cb = args[cbIdx]!.name;
        const sym = cbT.params.length === 0 ? "scr_http_resp_thunk0" : "scr_http_resp_thunk_res";
        host.declare(`declare void @${sym}(ptr, ptr)`);
        adapter = `@${sym}`;
      }
      const head = args.slice(0, cbIdx);
      const entry = isTlsOptions ? "scr_https_request"
        : isTls ? "scr_https_request_url"
        : isUrl ? "scr_http_request_url"
        : isAgent ? "scr_http_request_agent" : "scr_http_request";
      let callArgs = head.map((a) => `${host.llType(a.type)} ${a.name}`);
      if (isTlsOptions) {
        const ca = args[8]!;
        const caLenPtr = B.tmp();
        const caLen = B.tmp();
        let caData: string;
        if (ca.type.kind === "string") {
          caData = B.tmp();
          B.line(`${caLenPtr} = getelementptr inbounds %ScrStr, ptr ${ca.name}, i64 0, i32 1`);
          B.line(`${caLen} = load ${host.sizeType}, ptr ${caLenPtr}`);
          B.line(`${caData} = getelementptr inbounds i8, ptr ${ca.name}, i64 ${host.abiOffset(24, 12)}`);
        } else if (ca.type.kind === "bytes" && ca.type.elem === "u8") {
          const caDataPtr = B.tmp();
          caData = B.tmp();
          B.line(`${caLenPtr} = getelementptr inbounds i8, ptr ${ca.name}, i64 ${host.abiOffset(8, 4)}`);
          B.line(`${caLen} = load ${host.sizeType}, ptr ${caLenPtr}`);
          B.line(`${caDataPtr} = getelementptr inbounds i8, ptr ${ca.name}, i64 ${host.abiOffset(24, 12)}`);
          B.line(`${caData} = load ptr, ptr ${caDataPtr}`);
        } else {
          throw new InternalCompilerError(`llvm emitter bug: ${e.fn} CA is not a string or Buffer`);
        }
        callArgs = [...callArgs.slice(0, 8), `ptr ${caData}`, `${host.sizeType} ${caLen}`];
        host.declare(`declare ptr @scr_https_request(ptr, double, ptr, ptr, double, ptr, i1 zeroext, i1 zeroext, ptr, ${host.sizeType}, ptr, ptr)`);
      } else {
        const decls = head.map((a) => (host.llType(a.type) === "i1" ? "i1 zeroext" : host.llType(a.type)));
        host.declare(`declare ptr @${entry}(${[...decls, "ptr", "ptr"].join(", ")})`);
      }
      const t = B.tmp();
      B.line(
        `${t} = call ptr @${entry}(${[...callArgs, `ptr ${cb}`, `ptr ${adapter}`].join(", ")})`,
      );
      const out = host.own({ name: t, type: e.type });
      if (MAY_THROW_LIB_FNS.has(e.fn)) host.emitPendingCheck();
      return out;
    }
    if (MAY_THROW_LIB_FNS.has(e.fn) && LIB_FN_SYMS[e.fn] === undefined) {
      throw new LlvmUnsupportedError(`libCall:${e.fn}`, e.loc);
    }
    const sym = LIB_FN_SYMS[e.fn];
    if (sym === undefined) throw new LlvmUnsupportedError(`libCall:${e.fn}`, e.loc);
    const args = e.args.map((a) => host.emitExpr(a));
    const argDecls = args.map((a) => {
      const ty = host.llType(a.type);
      return ty === "i1" ? "i1 zeroext" : ty;
    });
    const retTy = host.llType(e.type);
    const retDecl = retTy === "i1" ? "zeroext i1" : retTy;
    host.declare(`declare ${retDecl} @${sym}(${argDecls.join(", ")})`);
    const argList = args.map((a) => `${host.llType(a.type)} ${a.name}`).join(", ");
    if (retTy === "void") {
      B.line(`call void @${sym}(${argList})`);
      if (MAY_THROW_LIB_FNS.has(e.fn)) host.emitPendingCheck();
      return { name: "", type: e.type };
    }
    const t = B.tmp();
    B.line(`${t} = call ${retTy} @${sym}(${argList})`);
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
      case "net":
      case "dgram":
      case "dns":
      case "http":
      case "https":
        return host.emitNetworkHttpLibCall(e);
      case "assert":
      case "insp":
        return host.emitAssertInspectLibCall(e);
      case "rl":
      case "strdec":
        return host.emitIoLibCall(e);
      case "util":
      case "crypto":
      case "buffer":
      case "bytes":
      case "test":
      case "tls":
      case "tlsca":
      case "http2":
        return host.emitGenericLibCall(e);
      default: {
        const _exhaustive: never = prefix;
        void _exhaustive;
        throw new InternalCompilerError("unreachable");
      }
    }
  }
