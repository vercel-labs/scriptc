import { InternalCompilerError } from "../../errors.js";
import type { IrType } from "../../ir/ir.js";
import { typeKey } from "../../ir/ir.js";
import type { LibCallExpr, LlValue, LlvmEmitterContext } from "./expr-context.js";
import {
  type AbiArgument,
  abiValue,
  callbackAdapter,
  callbackType,
  finishRuntimeCall,
  ptr,
  caBytes,
  rawBytes,
  requestHandler,
} from "./lib-abi.js";
import { FN_ATTRS } from "./shapes.js";
import { registerReplay } from "./emit-journal.js";

/** The runtime owns the answer closure; its arguments arrive owned from the caller. */
function sniAnswer(host: LlvmEmitterContext, type: IrType): string {
  if (type.kind !== "func") throw new InternalCompilerError("SNI answer must be a function");
  const key = "sni:" + typeKey(type);
  const previous = host.resolveThunks.get(key);
  if (previous !== undefined) return previous;
  const symbol = `sc_sni_answer_${host.resolveThunks.size}`;
  host.resolveThunks.set(key, symbol);
  host.journal?.allocated(symbol, "sniAnswer", [type]);
  const params = ["ptr %self"],
    body: string[] = [];
  let hasError = "false",
    context = "null";
  host.declare("declare void @scr_union_release(ptr)");
  host.declare("declare void @scr_tls_sni_answer(ptr, i1 zeroext, ptr)");
  if (type.params.length >= 1) {
    const error = type.params[0]!;
    const nullTag =
      error.kind === "union"
        ? (host.unionsById.get(error.unionId)?.arms.findIndex((arm) => arm.kind === "nullT") ?? -1)
        : -1;
    if (nullTag < 0) throw new InternalCompilerError("SNI error argument lacks its null arm");
    params.push("ptr %error");
    body.push(
      "  %error.tag.ptr = getelementptr inbounds %ScrUnion, ptr %error, i64 0, i32 1",
      "  %error.tag = load i32, ptr %error.tag.ptr",
      `  %has.error = icmp ne i32 %error.tag, ${nullTag}`,
      "  call void @scr_union_release(ptr %error)",
    );
    hasError = "%has.error";
  }
  if (type.params.length >= 2) {
    const ctx = type.params[1]!;
    const tag =
      ctx.kind === "union"
        ? (host.unionsById.get(ctx.unionId)?.arms.findIndex((arm) => arm.kind === "secureCtx") ??
          -1)
        : -1;
    if (tag < 0)
      throw new InternalCompilerError("SNI context argument lacks its SecureContext arm");
    params.push("ptr %context");
    host.declare("declare ptr @scr_secure_ctx_retain_v(ptr)");
    body.push(
      "  %context.tag.ptr = getelementptr inbounds %ScrUnion, ptr %context, i64 0, i32 1",
      "  %context.tag = load i32, ptr %context.tag.ptr",
      `  %has.context = icmp eq i32 %context.tag, ${tag}`,
      "  br i1 %has.context, label %present, label %absent",
      "present:",
      "  %context.ptr = getelementptr inbounds %ScrUnion, ptr %context, i64 0, i32 5",
      "  %context.value = load ptr, ptr %context.ptr",
      "  %retained = call ptr @scr_secure_ctx_retain_v(ptr %context.value)",
      "  br label %join",
      "absent:",
      "  br label %join",
      "join:",
      "  %ctx = phi ptr [ %retained, %present ], [ null, %absent ]",
      "  call void @scr_union_release(ptr %context)",
    );
    context = "%ctx";
  }
  host.resolveThunkDefs.push(
    `define internal void @${symbol}(${params.join(", ")}) ${FN_ATTRS} {`,
    "entry:",
    ...body,
    `  call void @scr_tls_sni_answer(ptr %self, i1 zeroext ${hasError}, ptr ${context})`,
    "  ret void",
    "}",
    "",
  );
  host.journal?.built();
  return symbol;
}

/** The (closure, answer thunk) pair of an SNICallback argument: a function,
 * or a function | undefined union whose undefined arm passes no callback. */
export function sniCallbackArgs(host: LlvmEmitterContext, cb: LlValue): AbiArgument[] {
  let type = cb.type,
    value = cb.name;
  if (type.kind === "union") {
    const arms = host.unionsById.get(type.unionId)?.arms ?? [];
    const tag = arms.findIndex((arm) => arm.kind === "func");
    if (tag < 0) throw new InternalCompilerError("SNI callback union lacks its function arm");
    type = arms[tag]!;
    value = host.unwrapNullableClosure(value, tag);
  } else host.toHeap(cb);
  if (type.kind !== "func" || type.params[1] === undefined)
    throw new InternalCompilerError("SNI callback lacks its answer function");
  return [ptr(value), ptr("@" + sniAnswer(host, type.params[1]))];
}

export function emitHttp2LibCall(host: LlvmEmitterContext, e: LibCallExpr): LlValue {
  const args = e.args.map((arg) => host.emitExpr(arg)),
    a = args.map((arg) => abiValue(host, arg));
  host.usesTimers = true;
  const direct: Record<string, string> = {
    "http2.createServer": "scr_http2_create_server",
    "http2.sessionRequest": "scr_http2_session_request",
    "http2.sessionDestroy": "scr_http2_session_destroy",
    "http2.sessionSettingsDynCb": "scr_http2_session_settings_dyncb",
    "http2.sessionOnSettingsDyn": "scr_http2_session_on_settings_dyn",
    "http2.sessionSettingsGet": "scr_http2_session_settings_get",
    "http2.sessionPendingSettingsAck": "scr_http2_session_pending_settings_ack",
    "http2.getDefaultSettings": "scr_http2_get_default_settings",
    "http2.sessionClosed": "scr_http2_session_closed",
    "http2.sessionDestroyed": "scr_http2_session_destroyed",
    "http2.sessionEncrypted": "scr_http2_session_encrypted",
    "http2.sessionType": "scr_http2_session_type",
    "http2.sessionAlpn": "scr_http2_session_alpn",
    "http2.sessionSocket": "scr_http2_session_socket",
    "http2.streamRespond": "scr_http2_stream_respond",
    "http2.streamWrite": "scr_http2_stream_write_str",
    "http2.streamWriteBytes": "scr_http2_stream_write_bytes",
    "http2.streamEnd": "scr_http2_stream_end",
    "http2.streamEndStr": "scr_http2_stream_end_str",
    "http2.streamEndBytes": "scr_http2_stream_end_bytes",
    "http2.streamDestroy": "scr_http2_stream_destroy",
    "http2.streamSetEncoding": "scr_http2_stream_set_encoding",
    "http2.streamSetEncodingRet": "scr_http2_stream_set_encoding_ret",
    "http2.streamResume": "scr_http2_stream_resume",
    "http2.streamPause": "scr_http2_stream_pause",
    "http2.streamId": "scr_http2_stream_id",
    "http2.streamRstCode": "scr_http2_stream_rst_code",
    "http2.streamDestroyed": "scr_http2_stream_destroyed",
    "http2.streamClosed": "scr_http2_stream_closed",
    "http2.streamAborted": "scr_http2_stream_aborted",
    "http2.streamPending": "scr_http2_stream_pending",
    "http2.streamSession": "scr_http2_stream_session",
    "http2.streamUndefCall": "scr_http2_stream_undef_call",
  };
  const symbol = direct[e.fn];
  if (symbol !== undefined) return finishRuntimeCall(host, e, symbol, a);
  switch (e.fn) {
    case "http2.streamNoop":
      return { name: "", type: e.type };
    case "http2.createServerReq":
      return finishRuntimeCall(
        host,
        e,
        "scr_http2_create_server_req",
        requestHandler(host, args[0]!),
      );
    case "http2.createSecureServerDyn":
    case "http2.createSecureServerDynCb":
      return finishRuntimeCall(host, e, "scr_http2_create_secure_server_dyn", [
        a[0]!,
        ...(args[1] === undefined ? [ptr(), ptr()] : requestHandler(host, args[1])),
      ]);
    case "http2.createSecureServerH2":
      return finishRuntimeCall(host, e, "scr_http2_create_secure_server", [
        ...rawBytes(host, args[0]!),
        ...rawBytes(host, args[1]!),
        a[2]!,
      ]);
    case "http2.createSecureServerH2Req":
      return finishRuntimeCall(host, e, "scr_http2_create_secure_server_req", [
        ...rawBytes(host, args[0]!),
        ...rawBytes(host, args[1]!),
        ...requestHandler(host, args[2]!),
        a[3]!,
      ]);
    case "http2.createSecureServer":
    case "http2.createSecureServerReq":
    case "http2.createSecureServerSni": {
      let handler = [ptr(), ptr()],
        sni = [ptr(), ptr()];
      if (e.fn === "http2.createSecureServerReq") handler = requestHandler(host, args[2]!);
      if (e.fn === "http2.createSecureServerSni") sni = sniCallbackArgs(host, args[2]!);
      return finishRuntimeCall(host, e, "scr_http2_create_secure_server_allow_http1", [
        ...rawBytes(host, args[0]!),
        ...rawBytes(host, args[1]!),
        ...handler,
        ...sni,
        a[e.fn === "http2.createSecureServer" ? 2 : 3]!,
      ]);
    }
    case "http2.connect":
    case "http2.connectCb": {
      const cb = args[3];
      const handler =
        cb === undefined
          ? [ptr(), ptr()]
          : callbackAdapter(
              host,
              cb,
              `scr_http2_connect_thunk${Math.min(callbackType(cb).params.length, 2)}`,
              ["ptr", "ptr", "ptr"],
            );
      return finishRuntimeCall(host, e, "scr_http2_connect", [
        ...a.slice(0, 2),
        ...caBytes(host, args[2]!),
        ...handler,
      ]);
    }
    case "http2.sessionClose":
    case "http2.sessionCloseCb":
    case "http2.streamClose":
    case "http2.streamCloseCb": {
      const stream = e.fn.startsWith("http2.stream"),
        cbIndex = stream ? 2 : 1;
      if (args[cbIndex] !== undefined) host.toHeap(args[cbIndex]!);
      return finishRuntimeCall(
        host,
        e,
        stream ? "scr_http2_stream_close" : "scr_http2_session_close",
        [...a.slice(0, cbIndex), a[cbIndex] ?? ptr()],
      );
    }
    case "http2.sessionSettings0":
    case "http2.sessionSettings":
    case "http2.sessionSettingsCb0": {
      const handler =
        args[2] === undefined
          ? [ptr(), ptr()]
          : callbackAdapter(host, args[2], "scr_http2_settings_thunk0", ["ptr", "ptr"]);
      return finishRuntimeCall(host, e, "scr_http2_session_settings", [
        a[0]!,
        a[1] ?? ptr(),
        ...handler,
      ]);
    }
  }
  const cb = args[1];
  if (cb === undefined) throw new InternalCompilerError(`unhandled HTTP/2 call ${e.fn}`);
  const type = callbackType(cb),
    arity = type.params.length;
  let runtime: string,
    thunk: string | null = null,
    params: string[] = ["ptr", "ptr"];
  switch (e.fn) {
    case "http2.serverOnStream":
      runtime = "scr_http2_server_on_stream";
      thunk = "scr_http2_stream_thunk";
      params = ["ptr", "ptr", "ptr", "double"];
      break;
    case "http2.sessionOnStream":
      runtime = "scr_http2_session_on_stream";
      thunk = "scr_http2_stream_thunk";
      params = ["ptr", "ptr", "ptr", "double"];
      break;
    case "http2.serverOnSession":
      runtime = "scr_http2_server_on_session";
      thunk = arity === 0 ? "scr_http2_session_thunk0" : "scr_http2_session_thunk";
      break;
    case "http2.serverOnSessionError":
      runtime = "scr_http2_server_on_session_error";
      thunk = `scr_http2_session_error_thunk${Math.min(arity, 2)}`;
      params = ["ptr", "ptr", "ptr"];
      break;
    case "http2.sessionOnConnect":
      runtime = "scr_http2_session_on_connect";
      thunk = `scr_http2_connect_thunk${Math.min(arity, 2)}`;
      params = ["ptr", "ptr", "ptr"];
      break;
    case "http2.sessionOnGoaway":
      runtime = "scr_http2_session_on_goaway";
      thunk = `scr_http2_goaway_thunk${Math.min(arity, 2)}`;
      params = ["ptr", "double", "double"];
      break;
    case "http2.sessionOnError":
      runtime = "scr_http2_session_on_error";
      thunk = arity === 0 ? "scr_child_err_thunk0" : "scr_child_err_thunk_error";
      break;
    case "http2.streamOnError":
      runtime = "scr_http2_stream_on_error";
      thunk = arity === 0 ? "scr_child_err_thunk0" : "scr_child_err_thunk_error";
      break;
    case "http2.sessionOnSettings0":
      runtime = "scr_http2_session_on_settings";
      thunk = "scr_http2_settings_thunk0";
      break;
    case "http2.streamOnResponse":
      runtime = "scr_http2_stream_on_response";
      thunk = "scr_http2_resp_thunk";
      params = ["ptr", "ptr", "double", "double"];
      break;
    case "http2.streamOnData":
      runtime = "scr_http2_stream_on_data";
      thunk =
        arity === 0
          ? "scr_net_data_thunk0"
          : type.params[0]!.kind === "dyn"
            ? "scr_net_data_thunk_dyn"
            : type.params[0]!.kind === "string"
              ? "scr_net_data_thunk_str"
              : "scr_net_data_thunk_bytes";
      params = ["ptr", "ptr", "ptr"];
      break;
    case "http2.sessionOnClose":
      runtime = "scr_http2_session_on_close";
      break;
    case "http2.streamOnEnd":
      runtime = "scr_http2_stream_on_end";
      break;
    case "http2.streamOnClose":
      runtime = "scr_http2_stream_on_close";
      break;
    case "http2.streamOnAborted":
      runtime = "scr_http2_stream_on_aborted";
      break;
    default:
      throw new InternalCompilerError(`unhandled HTTP/2 listener ${e.fn}`);
  }
  if (thunk === null) host.toHeap(cb);
  const handler = thunk === null ? [a[1]!] : callbackAdapter(host, cb, thunk, params);
  return finishRuntimeCall(host, e, runtime, [a[0]!, ...handler, ...a.slice(2)]);
}

registerReplay("sniAnswer", (host, args) => sniAnswer(host, args[0] as IrType));
