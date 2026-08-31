/* Focused LLVM library-call emission extracted from emitter.ts. */
import { InternalCompilerError } from "../../errors.js";
import { undefinedArmTag } from "../../ir/analysis.js";
import { STRING } from "../../ir/ir.js";
import { mangleRecordNew, mangleRecordStruct } from "../mangle.js";
import type { LlvmEmitterContext, LibCallExpr, LlValue } from "./expr-context.js";
import { f64Lit } from "./common.js";
import { emitAlwaysThrowLibCall } from "./lib-shared.js";

export function emitNetworkHttpLibCall(host: LlvmEmitterContext, e: LibCallExpr): LlValue {
    const B = host.B;
    if (e.fn === "net.connectOptsChk") {
      return emitAlwaysThrowLibCall(host, e, "scr_net_connect_opts_chk");
    }
    if (e.fn === "net.createServer" || e.fn === "net.createServerCb") {
      const args = e.args.map((a) => host.emitExpr(a));
      let cb = "null";
      let adapter = "null";
      if (e.fn === "net.createServerCb") {
        const cbT = e.args[0]!.type;
        if (cbT.kind !== "func") throw new InternalCompilerError("llvm emitter bug: net.createServerCb handler not a func");
        host.moveTemp(args[0]!);
        cb = args[0]!.name;
        adapter = cbT.params.length === 0 ? "@scr_net_conn_thunk0" : "@scr_net_conn_thunk_sock";
        host.declare(`declare void ${adapter}(ptr, ptr)`);
      }
      host.declare(`declare ptr @scr_net_create_server(ptr, ptr)`);
      const t = B.tmp();
      B.line(`${t} = call ptr @scr_net_create_server(ptr ${cb}, ptr ${adapter})`);
      return host.own({ name: t, type: e.type });
    }
    if (e.fn === "net.listen" || e.fn === "net.listenCb") {
      const args = e.args.map((a) => host.emitExpr(a));
      let cb = "null";
      if (e.fn === "net.listenCb") {
        host.moveTemp(args[2]!);
        cb = args[2]!.name;
      }
      host.declare(`declare void @scr_net_listen(ptr, double, ptr)`);
      B.line(`call void @scr_net_listen(ptr ${args[0]!.name}, double ${args[1]!.name}, ptr ${cb})`);
      return { name: "", type: e.type };
    }
    if (e.fn === "net.listenOpts" || e.fn === "net.listenOptsCb" ||
        e.fn === "net.listenOptsReusePort" || e.fn === "net.listenOptsReusePortCb") {
      // The callback slot may be the `(() => void) | undefined` optional-
      // binding union: unwrap to a nullable closure.
      const args = e.args.map((a) => host.emitExpr(a));
      let cb = "null";
      const reusePort = e.fn === "net.listenOptsReusePort" || e.fn === "net.listenOptsReusePortCb";
      const withCallback = e.fn === "net.listenOptsCb" || e.fn === "net.listenOptsReusePortCb";
      const cbIndex = reusePort ? 5 : 4;
      if (withCallback) {
        const cbT = e.args[cbIndex]!.type;
        if (cbT.kind === "func") {
          host.moveTemp(args[cbIndex]!);
          cb = args[cbIndex]!.name;
        } else {
          if (cbT.kind !== "union") throw new InternalCompilerError(`llvm emitter bug: ${e.fn} callback shape`);
          const def = host.unionsById.get(cbT.unionId);
          const funcTag = def ? def.arms.findIndex((a) => a.kind === "func") : -1;
          if (funcTag < 0) throw new InternalCompilerError(`llvm emitter bug: ${e.fn} union lacks its func arm`);
          cb = host.unwrapNullableClosure(args[cbIndex]!.name, funcTag);
        }
      }
      const valueCount = reusePort ? 5 : 4;
      const decls = e.args.slice(0, valueCount).map((a) => (host.llType(a.type) === "i1" ? "i1 zeroext" : host.llType(a.type)));
      const runtimeFn = reusePort ? "scr_net_listen_opts_reuse_port" : "scr_net_listen_opts";
      host.declare(`declare void @${runtimeFn}(${decls.join(", ")}, ptr)`);
      B.line(
        `call void @${runtimeFn}(${args.slice(0, valueCount).map((a) => `${host.llType(a.type)} ${a.name}`).join(", ")}, ptr ${cb})`,
      );
      return { name: "", type: e.type };
    }
    if (e.fn === "net.serverAddress") {
      // The AddressInfo record from the three runtime reads.
      if (e.type.kind !== "record") throw new InternalCompilerError("llvm emitter bug: net.serverAddress result is not a record");
      const recT = e.type;
      const shape = host.recordsById.get(recT.shapeId);
      if (!shape) throw new InternalCompilerError("llvm emitter bug: net.serverAddress record unknown");
      const args = e.args.map((a) => host.emitExpr(a));
      host.declare(`declare ptr @scr_net_server_addr_ip(ptr)`);
      host.declare(`declare ptr @scr_net_server_addr_family(ptr)`);
      host.declare(`declare double @scr_net_server_port(ptr)`);
      const ip = B.tmp();
      B.line(`${ip} = call ptr @scr_net_server_addr_ip(ptr ${args[0]!.name}) ; +1`);
      const rec = B.tmp();
      B.line(`${rec} = call ptr @${mangleRecordNew(recT.shapeId)}()`);
      const fieldIdx = (name: string): number => {
        const i = shape.fields.findIndex((f) => f.name === name);
        if (i < 0) throw new InternalCompilerError(`llvm emitter bug: net.serverAddress record lacks ${name}`);
        return i + 1;
      };
      const store = (name: string, ty: string, v: string): void => {
        const p = B.tmp();
        B.line(`${p} = getelementptr inbounds %${mangleRecordStruct(recT.shapeId)}, ptr ${rec}, i64 0, i32 ${fieldIdx(name)}`);
        B.line(`store ${ty} ${v}, ptr ${p} ; ${name}`);
      };
      store("address", "ptr", ip);
      const fam = B.tmp();
      B.line(`${fam} = call ptr @scr_net_server_addr_family(ptr ${args[0]!.name}) ; +1 — "IPv4"/"IPv6"`);
      store("family", "ptr", fam);
      const port = B.tmp();
      B.line(`${port} = call double @scr_net_server_port(ptr ${args[0]!.name})`);
      store("port", "double", port);
      return host.own({ name: rec, type: e.type });
    }
    if (e.fn === "net.serverClose" || e.fn === "net.serverCloseCb") {
      const args = e.args.map((a) => host.emitExpr(a));
      let cb = "null";
      if (e.fn === "net.serverCloseCb") {
        host.moveTemp(args[1]!);
        cb = args[1]!.name;
      }
      host.declare(`declare void @scr_net_server_close(ptr, ptr)`);
      B.line(`call void @scr_net_server_close(ptr ${args[0]!.name}, ptr ${cb})`);
      return { name: "", type: e.type };
    }
    if (e.fn === "net.serverCloseBind") {
      // The bound REAL close as a value: an emitted adapter behind a
      // fresh closure whose one env slot holds the +1 server.
      if (e.type.kind !== "func") throw new InternalCompilerError("llvm emitter bug: net.serverCloseBind result not a func");
      const args = e.args.map((a) => host.emitExpr(a));
      const fnSym = host.closeBindThunkFor(e.type.params[0]!, e.type.ret.kind === "netServer");
      host.declare(`declare ptr @scr_closure_new(ptr, ${host.sizeType})`);
      host.declare(`declare ptr @scr_box_new_obj(ptr, ptr, ptr)`);
      host.declare(`declare void @scr_box_set_ref(ptr, ptr)`);
      host.declare(`declare ptr @scr_net_server_retain_v(ptr)`);
      host.declare(`declare void @scr_net_server_release_v(ptr)`);
      const bound = B.tmp();
      B.line(`${bound} = call ptr @scr_closure_new(ptr @${fnSym}, ${host.sizeType} 1)`);
      const bx = B.tmp();
      B.line(`${bx} = call ptr @scr_box_new_obj(ptr @scr_net_server_retain_v, ptr @scr_net_server_release_v, ptr null)`);
      const capp = B.tmp();
      B.line(`${capp} = getelementptr inbounds %ScrClosure, ptr ${bound}, i64 1`);
      B.line(`store ptr ${bx}, ptr ${capp}`);
      const sr = B.tmp();
      B.line(`${sr} = call ptr @scr_net_server_retain_v(ptr ${args[0]!.name})`);
      B.line(`call void @scr_box_set_ref(ptr ${bx}, ptr ${sr})`);
      return host.own({ name: bound, type: e.type });
    }
    if (e.fn === "net.serverSetCloseOverride") {
      // The override MOVES into the server's slot behind the emitted
      // zero-arg wrapper (the runtime can't build the callback union).
      const cbT = e.args[1]!.type;
      if (cbT.kind !== "func") throw new InternalCompilerError("llvm emitter bug: close override not a func");
      const args = e.args.map((a) => host.emitExpr(a));
      const wrapSym = host.closeOverrideWrapFor(cbT.params[0]!, cbT.ret.kind === "netServer");
      host.moveTemp(args[1]!); // ownership moves into the wrapper's env box
      const wrap = host.wrapEmitterListener(args[1]!.name, wrapSym);
      host.declare(`declare void @scr_net_server_set_close_override(ptr, ptr)`);
      B.line(`call void @scr_net_server_set_close_override(ptr ${args[0]!.name}, ptr ${wrap})`);
      return { name: "", type: e.type };
    }
    if (e.fn === "net.serverOnError" || e.fn === "net.sockOnError") {
      const cbT = e.args[1]!.type;
      if (cbT.kind !== "func") throw new InternalCompilerError(`llvm emitter bug: ${e.fn} callback not a func`);
      const args = e.args.map((a) => host.emitExpr(a));
      host.moveTemp(args[1]!);
      const adapter = cbT.params.length === 0 ? "scr_child_err_thunk0" : "scr_child_err_thunk_error";
      const entry = e.fn === "net.serverOnError" ? "scr_net_server_on_error" : "scr_net_sock_on_error";
      host.declare(`declare void @${adapter}(ptr, ptr)`);
      host.declare(`declare void @${entry}(ptr, ptr, ptr, i1 zeroext)`);
      B.line(`call void @${entry}(ptr ${args[0]!.name}, ptr ${args[1]!.name}, ptr @${adapter}, i1 ${args[2]!.name})`);
      return { name: "", type: e.type };
    }
    if (
      e.fn === "net.serverOnClose" || e.fn === "net.serverOnListening" ||
      e.fn === "net.sockOnEnd" || e.fn === "net.sockOnClose" || e.fn === "net.sockOnConnect" ||
      e.fn === "net.sockOnTimeout" || e.fn === "net.sockOnReadable" ||
      e.fn === "http.reqOnEnd" || e.fn === "http.reqOnClose" || e.fn === "http.resOnClose" ||
      e.fn === "http.clientOnTimeout" || e.fn === "http.clientOnClose"
    ) {
      // Adapter-free registrations: (recv, cb /moves/, once).
      const entry = {
        "net.serverOnClose": "scr_net_server_on_close",
        "net.serverOnListening": "scr_net_server_on_listening",
        "net.sockOnEnd": "scr_net_sock_on_end",
        "net.sockOnClose": "scr_net_sock_on_close",
        "net.sockOnConnect": "scr_net_sock_on_connect",
        "net.sockOnTimeout": "scr_net_sock_on_timeout",
        "net.sockOnReadable": "scr_net_sock_on_readable",
        "http.reqOnEnd": "scr_http_req_on_end",
        "http.reqOnClose": "scr_http_req_on_close",
        "http.resOnClose": "scr_http_res_on_close",
        "http.clientOnTimeout": "scr_http_client_on_timeout",
        "http.clientOnClose": "scr_http_client_on_close",
      }[e.fn]!;
      const args = e.args.map((a) => host.emitExpr(a));
      host.moveTemp(args[1]!);
      host.declare(`declare void @${entry}(ptr, ptr, i1 zeroext)`);
      B.line(`call void @${entry}(ptr ${args[0]!.name}, ptr ${args[1]!.name}, i1 ${args[2]!.name})`);
      return { name: "", type: e.type };
    }
    if (e.fn === "net.serverOnConnection") {
      const cbT = e.args[1]!.type;
      if (cbT.kind !== "func") throw new InternalCompilerError("llvm emitter bug: net.serverOnConnection callback not a func");
      const args = e.args.map((a) => host.emitExpr(a));
      host.moveTemp(args[1]!);
      const adapter = cbT.params.length === 0 ? "scr_net_conn_thunk0" : "scr_net_conn_thunk_sock";
      host.declare(`declare void @${adapter}(ptr, ptr)`);
      host.declare(`declare void @scr_net_server_on_connection(ptr, ptr, ptr, i1 zeroext)`);
      B.line(`call void @scr_net_server_on_connection(ptr ${args[0]!.name}, ptr ${args[1]!.name}, ptr @${adapter}, i1 ${args[2]!.name})`);
      return { name: "", type: e.type };
    }
    if (e.fn === "net.connect" || e.fn === "net.connectCb") {
      const args = e.args.map((a) => host.emitExpr(a));
      let cb = "null";
      if (e.fn === "net.connectCb") {
        host.moveTemp(args[2]!);
        cb = args[2]!.name;
      }
      host.declare(`declare ptr @scr_net_connect(double, ptr, ptr)`);
      const t = B.tmp();
      B.line(`${t} = call ptr @scr_net_connect(double ${args[0]!.name}, ptr ${args[1]!.name}, ptr ${cb})`);
      return host.own({ name: t, type: e.type });
    }
    if (e.fn === "net.sockOnData" || e.fn === "http.reqOnData") {
      const cbT = e.args[1]!.type;
      if (cbT.kind !== "func") throw new InternalCompilerError(`llvm emitter bug: ${e.fn} callback not a func`);
      const args = e.args.map((a) => host.emitExpr(a));
      host.moveTemp(args[1]!);
      const adapter =
        cbT.params.length === 0 ? "scr_net_data_thunk0"
        : cbT.params[0]!.kind === "dyn" ? "scr_net_data_thunk_dyn"
        : "scr_net_data_thunk_bytes";
      const entry = e.fn === "net.sockOnData" ? "scr_net_sock_on_data" : "scr_http_req_on_data";
      host.declare(`declare void @${adapter}(ptr, ptr)`);
      host.declare(`declare void @${entry}(ptr, ptr, ptr, i1 zeroext)`);
      B.line(`call void @${entry}(ptr ${args[0]!.name}, ptr ${args[1]!.name}, ptr @${adapter}, i1 ${args[2]!.name})`);
      return { name: "", type: e.type };
    }
    if (e.fn === "net.sockRead") {
      // Buffer | null: NULL (not enough buffered) takes the null arm.
      if (e.type.kind !== "union") throw new InternalCompilerError("llvm emitter bug: net.sockRead result is not a union");
      const def = host.unionsById.get(e.type.unionId);
      const bytesTag = def ? def.arms.findIndex((a) => a.kind === "bytes" && a.elem === "u8") : -1;
      const nullTag = def ? def.arms.findIndex((a) => a.kind === "nullT") : -1;
      if (bytesTag < 0 || nullTag < 0) throw new InternalCompilerError("llvm emitter bug: net.sockRead union lacks its arms");
      const args = e.args.map((a) => host.emitExpr(a));
      host.declare(`declare ptr @scr_net_sock_read_bytes(ptr, double)`);
      const raw = B.tmp();
      B.line(`${raw} = call ptr @scr_net_sock_read_bytes(ptr ${args[0]!.name}, double ${args[1]!.name}) ; +1 or NULL`);
      return host.wrapNullable(raw, raw, def!.arms[bytesTag]!, bytesTag, e.type, nullTag);
    }
    if (e.fn === "net.sockRemoteAddress" || e.fn === "http.reqHeader" || e.fn === "http.resGetHeader" || e.fn === "http.reqStatusMessage") {
      // string | undefined: +1 or NULL, NULL takes the undefined arm.
      if (e.type.kind !== "union") throw new InternalCompilerError(`llvm emitter bug: ${e.fn} result is not a union`);
      const def = host.unionsById.get(e.type.unionId);
      const strTag = def ? def.arms.findIndex((a) => a.kind === "string") : -1;
      const undefTag = undefinedArmTag(e.type, host.unionsById);
      if (strTag < 0 || undefTag < 0) throw new InternalCompilerError(`llvm emitter bug: ${e.fn} union lacks its arms`);
      const entry = {
        "net.sockRemoteAddress": "scr_net_sock_remote_address",
        "http.reqHeader": "scr_http_req_header",
        "http.resGetHeader": "scr_http_res_get_header",
        "http.reqStatusMessage": "scr_http_req_status_message",
      }[e.fn]!;
      const args = e.args.map((a) => host.emitExpr(a));
      const argList = args.map((a) => `${host.llType(a.type)} ${a.name}`).join(", ");
      host.declare(`declare ptr @${entry}(${args.map((a) => host.llType(a.type)).join(", ")})`);
      const raw = B.tmp();
      B.line(`${raw} = call ptr @${entry}(${argList}) ; +1 or NULL`);
      return host.wrapNullable(raw, raw, STRING, strTag, e.type, undefTag);
    }
    if (e.fn === "net.sockEncrypted") {
      // boolean | undefined: the true arm iff a TLS transport.
      if (e.type.kind !== "union") throw new InternalCompilerError("llvm emitter bug: net.sockEncrypted result is not a union");
      const def = host.unionsById.get(e.type.unionId);
      const boolTag = def ? def.arms.findIndex((a) => a.kind === "bool") : -1;
      const undefTag = undefinedArmTag(e.type, host.unionsById);
      if (boolTag < 0 || undefTag < 0) throw new InternalCompilerError("llvm emitter bug: net.sockEncrypted union lacks its arms");
      const args = e.args.map((a) => host.emitExpr(a));
      host.declare(`declare zeroext i1 @scr_net_sock_encrypted(ptr)`);
      host.declare(`declare ptr @scr_union_new_bool(i32, i1 zeroext)`);
      const w = B.tmp();
      B.line(`${w} = call zeroext i1 @scr_net_sock_encrypted(ptr ${args[0]!.name})`);
      const slot = B.slot();
      B.entryAllocas.push(`${slot} = alloca ptr`);
      const lp = B.newLabel("se.p");
      const la = B.newLabel("se.a");
      const lj = B.newLabel("se.j");
      B.condBr(w, lp, la);
      B.startBlock(lp);
      const u = B.tmp();
      B.line(`${u} = call ptr @scr_union_new_bool(i32 ${boolTag}, i1 true)`);
      B.line(`store ptr ${u}, ptr ${slot}`);
      B.br(lj);
      B.startBlock(la);
      B.line(`store ptr ${host.unitInstanceRef(e.type.unionId, undefTag)}, ptr ${slot}`);
      B.br(lj);
      B.startBlock(lj);
      const t = B.tmp();
      B.line(`${t} = load ptr, ptr ${slot}`);
      return host.own({ name: t, type: e.type });
    }
    if (e.fn === "http.reqStatusCode") {
      // number | undefined: the runtime answers a negative status for
      // server requests (the process.columns shape).
      if (e.type.kind !== "union") throw new InternalCompilerError("llvm emitter bug: http.reqStatusCode result is not a union");
      const def = host.unionsById.get(e.type.unionId);
      const f64Tag = def ? def.arms.findIndex((a) => a.kind === "f64") : -1;
      const undefTag = undefinedArmTag(e.type, host.unionsById);
      if (f64Tag < 0 || undefTag < 0) throw new InternalCompilerError("llvm emitter bug: http.reqStatusCode union lacks its arms");
      const args = e.args.map((a) => host.emitExpr(a));
      host.declare(`declare double @scr_http_req_status(ptr)`);
      host.declare(`declare ptr @scr_union_new_f64(i32, double)`);
      const w = B.tmp();
      B.line(`${w} = call double @scr_http_req_status(ptr ${args[0]!.name})`);
      const has = B.tmp();
      B.line(`${has} = fcmp oge double ${w}, ${f64Lit(0)}`);
      const slot = B.slot();
      B.entryAllocas.push(`${slot} = alloca ptr`);
      const lp = B.newLabel("rs.p");
      const la = B.newLabel("rs.a");
      const lj = B.newLabel("rs.j");
      B.condBr(has, lp, la);
      B.startBlock(lp);
      const u = B.tmp();
      B.line(`${u} = call ptr @scr_union_new_f64(i32 ${f64Tag}, double ${w})`);
      B.line(`store ptr ${u}, ptr ${slot}`);
      B.br(lj);
      B.startBlock(la);
      B.line(`store ptr ${host.unitInstanceRef(e.type.unionId, undefTag)}, ptr ${slot}`);
      B.br(lj);
      B.startBlock(lj);
      const t = B.tmp();
      B.line(`${t} = load ptr, ptr ${slot}`);
      return host.own({ name: t, type: e.type });
    }
    if (e.fn === "http.createServer" || e.fn === "http.createServerEmpty") {
      const args = e.args.map((a) => host.emitExpr(a));
      let cb = "null";
      let adapter = "null";
      if (e.fn === "http.createServer") {
        const cbT = e.args[0]!.type;
        if (cbT.kind !== "func") throw new InternalCompilerError("llvm emitter bug: http.createServer handler not a func");
        host.moveTemp(args[0]!);
        cb = args[0]!.name;
        const sym =
          cbT.params.length === 2 ? "scr_http_handler_thunk2"
          : cbT.params.length === 1 ? "scr_http_handler_thunk1"
          : "scr_http_handler_thunk0";
        host.declare(`declare void @${sym}(ptr, ptr, ptr)`);
        adapter = `@${sym}`;
      }
      host.declare(`declare ptr @scr_http_create_server(ptr, ptr)`);
      const t = B.tmp();
      B.line(`${t} = call ptr @scr_http_create_server(ptr ${cb}, ptr ${adapter})`);
      return host.own({ name: t, type: e.type });
    }
    if (e.fn === "http.serverOnRequest") {
      const cbT = e.args[1]!.type;
      if (cbT.kind !== "func") throw new InternalCompilerError("llvm emitter bug: http.serverOnRequest handler not a func");
      const args = e.args.map((a) => host.emitExpr(a));
      host.moveTemp(args[1]!);
      const adapter =
        cbT.params.length === 2 ? "scr_http_handler_thunk2"
        : cbT.params.length === 1 ? "scr_http_handler_thunk1"
        : "scr_http_handler_thunk0";
      host.declare(`declare void @${adapter}(ptr, ptr, ptr)`);
      host.declare(`declare void @scr_http_server_on_request(ptr, ptr, ptr, i1 zeroext)`);
      B.line(`call void @scr_http_server_on_request(ptr ${args[0]!.name}, ptr ${args[1]!.name}, ptr @${adapter}, i1 ${args[2]!.name})`);
      return { name: "", type: e.type };
    }
    if (e.fn === "http.serverOnUpgrade" || e.fn === "http.clientOnUpgrade") {
      const cbT = e.args[1]!.type;
      if (cbT.kind !== "func") throw new InternalCompilerError(`llvm emitter bug: ${e.fn} listener not a func`);
      const args = e.args.map((a) => host.emitExpr(a));
      host.moveTemp(args[1]!);
      const adapter =
        cbT.params.length === 3 ? "scr_http_upgrade_thunk3"
        : cbT.params.length === 2 ? "scr_http_upgrade_thunk2"
        : cbT.params.length === 1 ? "scr_http_upgrade_thunk1"
        : "scr_http_upgrade_thunk0";
      const entry = e.fn === "http.serverOnUpgrade" ? "scr_http_server_on_upgrade" : "scr_http_client_on_upgrade";
      host.declare(`declare void @${adapter}(ptr, ptr, ptr, ptr)`);
      host.declare(`declare void @${entry}(ptr, ptr, ptr, i1 zeroext)`);
      B.line(`call void @${entry}(ptr ${args[0]!.name}, ptr ${args[1]!.name}, ptr @${adapter}, i1 ${args[2]!.name})`);
      return { name: "", type: e.type };
    }
    if (e.fn === "http.clientOnResponse" || e.fn === "http.clientOnError" || e.fn === "http.reqOnError") {
      const cbT = e.args[1]!.type;
      if (cbT.kind !== "func") throw new InternalCompilerError(`llvm emitter bug: ${e.fn} callback not a func`);
      const args = e.args.map((a) => host.emitExpr(a));
      host.moveTemp(args[1]!);
      const adapter = e.fn === "http.clientOnResponse"
        ? (cbT.params.length === 0 ? "scr_http_resp_thunk0" : "scr_http_resp_thunk_res")
        : (cbT.params.length === 0 ? "scr_child_err_thunk0" : "scr_child_err_thunk_error");
      const entry = {
        "http.clientOnResponse": "scr_http_client_on_response",
        "http.clientOnError": "scr_http_client_on_error",
        "http.reqOnError": "scr_http_req_on_error",
      }[e.fn]!;
      host.declare(`declare void @${adapter}(ptr, ptr)`);
      host.declare(`declare void @${entry}(ptr, ptr, ptr, i1 zeroext)`);
      B.line(`call void @${entry}(ptr ${args[0]!.name}, ptr ${args[1]!.name}, ptr @${adapter}, i1 ${args[2]!.name})`);
      return { name: "", type: e.type };
    }
    if (e.fn === "http.resOnFinish") {
      const args = e.args.map((a) => host.emitExpr(a));
      host.moveTemp(args[1]!);
      host.declare(`declare void @scr_http_res_on_finish(ptr, ptr)`);
      B.line(`call void @scr_http_res_on_finish(ptr ${args[0]!.name}, ptr ${args[1]!.name})`);
      return { name: "", type: e.type };
    }
    if (e.fn === "net.sockOnFinish") {
      const args = e.args.map((a) => host.emitExpr(a));
      host.moveTemp(args[1]!);
      host.declare(`declare void @scr_net_sock_on_finish(ptr, ptr)`);
      B.line(`call void @scr_net_sock_on_finish(ptr ${args[0]!.name}, ptr ${args[1]!.name})`);
      return { name: "", type: e.type };
    }
    return host.emitGenericLibCall(e);
  }
