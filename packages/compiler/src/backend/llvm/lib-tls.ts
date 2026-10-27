import { InternalCompilerError } from "../../errors.js";
import type { LibCallExpr, LlValue, LlvmEmitterContext } from "./expr-context.js";
import {
  abiValue,
  callRuntime,
  callbackAdapter,
  callbackType,
  finishRuntimeCall,
  nullableReference,
  ptr,
  caBytes,
  rawBytes,
  requestHandler,
} from "./lib-abi.js";
import { sniCallbackArgs } from "./lib-http2.js";
import { emitAlwaysThrowLibCall } from "./lib-shared.js";

export function emitTlsLibCall(host: LlvmEmitterContext, e: LibCallExpr): LlValue {
  if (e.fn === "tls.caCertsChk") return emitAlwaysThrowLibCall(host, e, "scr_tls_ca_certs_chk");
  const args = e.args.map((arg) => host.emitExpr(arg));
  const a = args.map((arg) => abiValue(host, arg));
  host.usesTimers = true;
  switch (e.fn) {
    case "tls.createServer":
    case "tls.createServerCb":
    case "https.createServer": {
      const cb = args[2];
      const handler =
        cb === undefined
          ? [ptr(), ptr()]
          : e.fn === "https.createServer"
            ? requestHandler(host, cb)
            : callbackAdapter(
                host,
                cb,
                callbackType(cb).params.length === 0
                  ? "scr_net_conn_thunk0"
                  : "scr_net_conn_thunk_sock",
                ["ptr", "ptr"],
              );
      return finishRuntimeCall(
        host,
        e,
        e.fn === "https.createServer" ? "scr_https_create_server" : "scr_tls_create_server",
        [...rawBytes(host, args[0]!), ...rawBytes(host, args[1]!), ...handler],
      );
    }
    case "tls.createServerSni":
    case "tls.createServerSniCb": {
      const cb = args[3];
      const handler =
        cb === undefined
          ? [ptr(), ptr()]
          : callbackAdapter(
              host,
              cb,
              callbackType(cb).params.length === 0
                ? "scr_net_conn_thunk0"
                : "scr_net_conn_thunk_sock",
              ["ptr", "ptr"],
            );
      return finishRuntimeCall(host, e, "scr_tls_create_server_sni", [
        ...rawBytes(host, args[0]!),
        ...rawBytes(host, args[1]!),
        ...handler,
        ...sniCallbackArgs(host, args[2]!),
      ]);
    }
    case "tls.createServerDyn":
    case "tls.createServerDynCb":
    case "https.createServerDyn":
    case "https.createServerDynCb": {
      const cb = args[1];
      const handler =
        cb === undefined
          ? [ptr(), ptr()]
          : e.fn.startsWith("https.")
            ? requestHandler(host, cb)
            : callbackAdapter(
                host,
                cb,
                callbackType(cb).params.length === 0
                  ? "scr_net_conn_thunk0"
                  : "scr_net_conn_thunk_sock",
                ["ptr", "ptr"],
              );
      return finishRuntimeCall(
        host,
        e,
        e.fn.startsWith("https.") ? "scr_https_create_server_dyn" : "scr_tls_create_server_dyn",
        [a[0]!, ...handler],
      );
    }
    case "tls.createSecureContext":
      return finishRuntimeCall(host, e, "scr_tls_create_secure_context", [
        ...rawBytes(host, args[0]!),
        ...rawBytes(host, args[1]!),
      ]);
    case "tls.createSecureContextDyn":
      return finishRuntimeCall(host, e, "scr_tls_create_secure_context_dyn", a);
    case "tls.pemDyn":
      return finishRuntimeCall(host, e, "scr_tls_pem_from_dyn", [
        a[0]!,
        rawBytes(host, args[1]!)[0]!,
      ]);
    case "tls.sockAuthorized":
      return finishRuntimeCall(host, e, "scr_tls_sock_authorized", a);
    case "tls.sockGetProtocol":
      return finishRuntimeCall(host, e, "scr_tls_sock_get_protocol", a);
    case "tls.sockGetCipher":
      return finishRuntimeCall(host, e, "scr_tls_sock_get_cipher", a);
    case "tls.sockAlpnProtocol":
      return finishRuntimeCall(host, e, "scr_tls_sock_alpn_protocol", a);
    case "tls.serverAddContext":
      return finishRuntimeCall(host, e, "scr_tls_server_add_context", [...a, ptr()]);
    case "tls.serverAddContextCtx":
      return finishRuntimeCall(host, e, "scr_tls_server_add_context", [a[0]!, a[1]!, ptr(), a[2]!]);
    case "tls.serverSetSecureContext":
      return finishRuntimeCall(host, e, "scr_tls_server_set_secure_context", a);
    case "tls.serverOnClientError": {
      // (err, tlsSocket) listeners by arity: the adapter retains what the
      // listener takes.
      const cb = args[1]!;
      const thunk = `scr_net_client_error_thunk${callbackType(cb).params.length}`;
      return finishRuntimeCall(host, e, "scr_net_server_on_client_error", [
        a[0]!,
        ...callbackAdapter(host, cb, thunk, ["ptr", "ptr", "ptr"]),
        a[2]!,
      ]);
    }
    case "tls.sockGetPeerCertificate":
      return finishRuntimeCall(host, e, "scr_tls_sock_get_peer_certificate", a);
    case "tls.sockGetCertificate":
      return finishRuntimeCall(host, e, "scr_tls_sock_get_certificate", a);
    case "tls.sockPeerCertDer":
      return finishRuntimeCall(host, e, "scr_tls_sock_peer_cert_der", a);
    case "tls.sockOwnCertDer":
      return finishRuntimeCall(host, e, "scr_tls_sock_own_cert_der", a);
    case "tls.sockAuthError": {
      const result = callRuntime(host, "scr_tls_sock_auth_error", "ptr", a);
      return nullableReference(host, e.type, result, "string", "nullT");
    }
    case "tls.connect":
    case "tls.connectCb":
      if (args[3] !== undefined) host.toHeap(args[3]);
      return finishRuntimeCall(host, e, "scr_tls_connect_dyn", [...a.slice(0, 3), a[3] ?? ptr()]);
    case "tls.sockOnSecureConnect":
      host.toHeap(args[1]!);
      return finishRuntimeCall(host, e, "scr_tls_sock_on_secure_connect", a);
    case "tls.sockOnSecure":
      host.toHeap(args[1]!);
      return finishRuntimeCall(host, e, "scr_tls_sock_on_secure", a);
    case "tls.wrapSocket":
      return finishRuntimeCall(host, e, "scr_tls_wrap_socket", [a[0]!, a[1]!, ptr()]);
    case "tls.wrapSocketCtx":
      return finishRuntimeCall(host, e, "scr_tls_wrap_socket", a);
    case "tls.sockOnSession": {
      const cb = args[1]!,
        type = callbackType(cb);
      const adapter =
        type.params.length === 0
          ? "scr_net_data_thunk0"
          : type.params[0]!.kind === "dyn"
            ? "scr_net_data_thunk_dyn"
            : "scr_net_data_thunk_bytes";
      return finishRuntimeCall(host, e, "scr_tls_sock_on_session", [
        a[0]!,
        ...callbackAdapter(host, cb, adapter, ["ptr", "ptr", "ptr"]),
        a[2]!,
      ]);
    }
    case "https.requestAgent":
    case "https.requestAgentCb": {
      const cb = args[10];
      const handler =
        cb === undefined
          ? [ptr(), ptr()]
          : callbackAdapter(
              host,
              cb,
              callbackType(cb).params.length === 0
                ? "scr_http_resp_thunk0"
                : "scr_http_resp_thunk_res",
              ["ptr", "ptr"],
            );
      return finishRuntimeCall(host, e, "scr_https_request_agent", [
        ...a.slice(0, 8),
        ...caBytes(host, args[8]!),
        a[9]!,
        ...handler,
      ]);
    }
    case "https.requestFn":
    case "https.requestFnCb": {
      const cb = args[10];
      const handler =
        cb === undefined
          ? [ptr(), ptr()]
          : callbackAdapter(
              host,
              cb,
              callbackType(cb).params.length === 0
                ? "scr_http_resp_thunk0"
                : "scr_http_resp_thunk_res",
              ["ptr", "ptr"],
            );
      // Evaluate arguments once before selecting which transport consumes the callback.
      const pem = caBytes(host, args[9]!);
      const B = host.B,
        tls = B.newLabel("request.tls"),
        plain = B.newLabel("request.plain"),
        done = B.newLabel("request.join");
      B.condBr(args[0]!.name, tls, plain);
      B.startBlock(tls);
      const secure = callRuntime(host, "scr_https_request", "ptr", [
        ...a.slice(1, 9),
        ...pem,
        ...handler,
      ]);
      B.br(done);
      B.startBlock(plain);
      // The plain arm is http.request: Node's global agent serves it.
      const insecure = callRuntime(host, "scr_http_request", "ptr", [...a.slice(1, 8), ...handler]);
      B.br(done);
      B.startBlock(done);
      const result = B.tmp();
      B.line(`${result} = phi ptr [ ${secure}, %${tls} ], [ ${insecure}, %${plain} ]`);
      const out = host.own({ name: result, type: e.type });
      host.emitPendingCheck();
      return out;
    }
    default:
      throw new InternalCompilerError(`unhandled TLS runtime call ${e.fn}`);
  }
}
