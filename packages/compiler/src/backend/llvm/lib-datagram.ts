import { InternalCompilerError } from "../../errors.js";
import { STRING, type IrType } from "../../ir/ir.js";
import { mangleRecordNew, mangleRecordStruct } from "../mangle.js";
import type { LibCallExpr, LlValue, LlvmEmitterContext } from "./expr-context.js";
import {
  abiValue,
  callRuntime,
  callbackAdapter,
  callbackType,
  finishRuntimeCall,
  ptr,
} from "./lib-abi.js";
import { FN_ATTRS } from "./shapes.js";
import { registerReplay } from "./emit-journal.js";

function messageAdapter(host: LlvmEmitterContext, type: IrType): string {
  if (type.kind !== "record")
    throw new InternalCompilerError("datagram remote info must be a record");
  const key = "dgram:" + type.shapeId;
  const previous = host.resolveThunks.get(key);
  if (previous !== undefined) return previous;
  const symbol = host.contentSymbol("sc_dgram_message_", key);
  host.resolveThunks.set(key, symbol);
  host.journal?.allocated(symbol, "messageAdapter", [type]);
  const shape = host.recordsById.get(type.shapeId);
  if (shape === undefined) throw new InternalCompilerError("missing datagram remote info shape");
  const lines: string[] = [];
  for (const field of ["address", "family", "port", "size"]) {
    const index = shape.fields.findIndex((item) => item.name === field);
    if (index < 0) throw new InternalCompilerError(`missing remote info field ${field}`);
    const isString = field === "address" || field === "family";
    if (isString) lines.push(`  %${field}.owned = call ptr @scr_str_retain_v(ptr %${field})`);
    lines.push(
      `  %${field}.slot = getelementptr inbounds %${mangleRecordStruct(type.shapeId)}, ptr %record, i64 0, i32 ${index + host.nullableUnions.fieldBase(type.shapeId)}`,
      `  store ${isString ? "ptr" : "double"} %${field}${isString ? ".owned" : ""}, ptr %${field}.slot`,
    );
  }
  host.declare("declare ptr @scr_str_retain_v(ptr)");
  host.declare("declare ptr @scr_bytes_retain_v(ptr)");
  host.resolveThunkDefs.push(
    `define internal void @${symbol}(ptr %cb, ptr %message, ptr %address, ptr %family, double %port, double %size) ${FN_ATTRS} {`,
    "entry:",
    `  %record = call ptr @${mangleRecordNew(type.shapeId)}()`,
    ...lines,
    "  %owned = call ptr @scr_bytes_retain_v(ptr %message)",
    "  %fnp = getelementptr inbounds %ScrClosure, ptr %cb, i64 0, i32 1",
    "  %fn = load ptr, ptr %fnp",
    "  call void %fn(ptr %cb, ptr %owned, ptr %record)",
    "  ret void",
    "}",
    "",
  );
  host.journal?.built();
  return symbol;
}

function lookupAdapter(host: LlvmEmitterContext, cb: LlValue): string {
  const type = callbackType(cb),
    arity = type.params.length;
  if (arity === 0) return "scr_dns_thunk0";
  const error = type.params[0]!;
  if (error.kind !== "union") throw new InternalCompilerError("DNS callback error must be a union");
  const arms = host.unionsById.get(error.unionId)?.arms ?? [];
  const errorTag = arms.findIndex((arm) => arm.kind === "object"),
    nullTag = arms.findIndex((arm) => arm.kind === "nullT");
  if (errorTag < 0 || nullTag < 0)
    throw new InternalCompilerError("DNS callback error union lacks its arms");
  const key = `dns:${error.unionId}:${arity}`;
  const previous = host.resolveThunks.get(key);
  if (previous !== undefined) return previous;
  const symbol = host.contentSymbol("sc_dns_lookup_", key);
  host.resolveThunks.set(key, symbol);
  host.journal?.allocated(symbol, "lookupAdapter", [cb]);
  host.declare("declare ptr @scr_error_new(i32, ptr)");
  host.declare("declare ptr @scr_error_retain_v(ptr)");
  host.declare("declare void @scr_error_release_v(ptr)");
  host.declare("declare ptr @scr_union_new_ref(i32, ptr, ptr, ptr, ptr)");
  host.declare("declare ptr @scr_str_retain_v(ptr)");
  host.resolveThunkDefs.push(
    `define internal void @${symbol}(ptr %cb, ptr %message, ptr %address, double %family) ${FN_ATTRS} {`,
    "entry:",
    "  %failed = icmp ne ptr %message, null",
    "  br i1 %failed, label %error, label %success",
    "error:",
    "  %err.value = call ptr @scr_error_new(i32 0, ptr %message)",
    `  %boxed = call ptr @scr_union_new_ref(i32 ${errorTag}, ptr %err.value, ptr @scr_error_retain_v, ptr @scr_error_release_v, ptr null)`,
    "  br label %join",
    "success:",
    "  br label %join",
    "join:",
    `  %result = phi ptr [ %boxed, %error ], [ ${host.unitInstanceRef(error.unionId, nullTag)}, %success ]`,
    ...(arity >= 2 ? ["  %owned.address = call ptr @scr_str_retain_v(ptr %address)"] : []),
    "  %fnp = getelementptr inbounds %ScrClosure, ptr %cb, i64 0, i32 1",
    "  %fn = load ptr, ptr %fnp",
    `  call void %fn(ptr %cb, ptr %result${arity >= 2 ? ", ptr %owned.address" : ""}${arity >= 3 ? ", double %family" : ""})`,
    "  ret void",
    "}",
    "",
  );
  host.journal?.built();
  return symbol;
}

export function emitDatagramLibCall(host: LlvmEmitterContext, e: LibCallExpr): LlValue {
  const args = e.args.map((arg) => host.emitExpr(arg)),
    a = args.map((arg) => abiValue(host, arg));
  host.usesTimers = true;
  const direct: Record<string, string> = {
    "dgram.createSocket": "scr_dgram_create",
    "dgram.sendStr": "scr_dgram_send_str",
    "dgram.sendBytes": "scr_dgram_send_bytes",
    "dgram.sendChk": "scr_dgram_send_chk",
    "dgram.unixSocket": "scr_dgram_unix_socket",
    "dgram.unixConnect": "scr_dgram_unix_connect",
    "dgram.unixSend": "scr_dgram_unix_send",
    "dgram.unixClose": "scr_dgram_unix_close",
    "dgram.ref": "scr_dgram_ref",
    "dgram.unref": "scr_dgram_unref",
    "dgram.setBroadcast": "scr_dgram_set_broadcast",
    "dgram.setTTL": "scr_dgram_set_ttl",
    "dgram.setMulticastTTL": "scr_dgram_set_multicast_ttl",
    "dgram.setMulticastLoopback": "scr_dgram_set_multicast_loopback",
    "dgram.setMulticastInterface": "scr_dgram_set_multicast_interface",
    "dgram.addMembership": "scr_dgram_add_membership",
    "dgram.dropMembership": "scr_dgram_drop_membership",
    "dgram.getRecvBufferSize": "scr_dgram_get_recv_buffer_size",
    "dgram.getSendBufferSize": "scr_dgram_get_send_buffer_size",
    "dgram.setRecvBufferSize": "scr_dgram_set_recv_buffer_size",
    "dgram.setSendBufferSize": "scr_dgram_set_send_buffer_size",
    "dgram.getSendQueueSize": "scr_dgram_get_send_queue_size",
    "dgram.getSendQueueCount": "scr_dgram_get_send_queue_count",
    "dgram.disconnect": "scr_dgram_disconnect",
    "dns.lookupPromise": "scr_dns_lookup_promise",
    "dns.lookupServicePromise": "scr_dns_lookup_service_promise",
  };
  const symbol = direct[e.fn];
  if (symbol !== undefined) return finishRuntimeCall(host, e, symbol, a);
  switch (e.fn) {
    case "dgram.bind":
    case "dgram.bindCb":
    case "dgram.connect":
    case "dgram.connectCb":
      if (args[3] !== undefined) host.toHeap(args[3]);
      return finishRuntimeCall(
        host,
        e,
        e.fn.startsWith("dgram.bind") ? "scr_dgram_bind" : "scr_dgram_connect",
        [...a.slice(0, 3), a[3] ?? ptr()],
      );
    case "dgram.close":
    case "dgram.closeCb":
      if (args[1] !== undefined) host.toHeap(args[1]);
      return finishRuntimeCall(host, e, "scr_dgram_close", [a[0]!, a[1] ?? ptr()]);
    case "dgram.address": {
      const type = e.type;
      if (type.kind !== "record")
        throw new InternalCompilerError("datagram address must be a record");
      const ip = host.own({ name: callRuntime(host, "scr_dgram_addr_ip", "ptr", a), type: STRING });
      host.emitPendingCheck();
      const record = host.B.tmp();
      host.B.line(`${record} = call ptr @${mangleRecordNew(type.shapeId)}()`);
      const out = host.own({ name: record, type });
      host.toHeap(ip);
      const shape = host.recordsById.get(type.shapeId);
      if (shape === undefined) throw new InternalCompilerError("missing datagram address shape");
      for (const field of ["address", "family", "port"]) {
        const index = shape.fields.findIndex((item) => item.name === field);
        if (index < 0) throw new InternalCompilerError(`missing datagram address field ${field}`);
        const ty = field === "port" ? "double" : "ptr";
        const value =
          field === "address"
            ? ip.name
            : callRuntime(
                host,
                field === "family" ? "scr_dgram_addr_family" : "scr_dgram_addr_port",
                ty,
                a,
              );
        const slot = host.B.tmp();
        host.B.line(
          `${slot} = getelementptr inbounds %${mangleRecordStruct(type.shapeId)}, ptr ${record}, i64 0, i32 ${index + host.nullableUnions.fieldBase(type.shapeId)}`,
        );
        host.B.line(`store ${ty} ${value}, ptr ${slot}`);
      }
      return out;
    }
    case "dgram.onMessage": {
      const cb = args[1]!,
        type = callbackType(cb);
      const adapter =
        type.params.length === 0
          ? "scr_dgram_msg_thunk0"
          : type.params.length === 1
            ? "scr_dgram_msg_thunk1"
            : messageAdapter(host, type.params[1]!);
      // Program-specific adapters are definitions, so do not redeclare them.
      host.toHeap(cb);
      if (type.params.length < 2)
        host.declare(`declare void @${adapter}(ptr, ptr, ptr, ptr, double, double)`);
      return finishRuntimeCall(host, e, "scr_dgram_on_message", [
        a[0]!,
        a[1]!,
        ptr("@" + adapter),
        a[2]!,
      ]);
    }
    case "dgram.onError": {
      const cb = args[1]!;
      return finishRuntimeCall(host, e, "scr_dgram_on_error", [
        a[0]!,
        ...callbackAdapter(
          host,
          cb,
          callbackType(cb).params.length === 0
            ? "scr_child_err_thunk0"
            : "scr_child_err_thunk_error",
          ["ptr", "ptr"],
        ),
        a[2]!,
      ]);
    }
    case "dgram.onListening":
    case "dgram.onClose":
    case "dgram.onConnect":
      host.toHeap(args[1]!);
      return finishRuntimeCall(
        host,
        e,
        e.fn === "dgram.onListening"
          ? "scr_dgram_on_listening"
          : e.fn === "dgram.onClose"
            ? "scr_dgram_on_close"
            : "scr_dgram_on_connect",
        a,
      );
    case "dns.lookup": {
      const cb = args[2]!,
        symbol = lookupAdapter(host, cb);
      host.toHeap(cb);
      if (callbackType(cb).params.length === 0)
        host.declare("declare void @scr_dns_thunk0(ptr, ptr, ptr, double)");
      return finishRuntimeCall(host, e, "scr_dns_lookup", [...a, ptr("@" + symbol)]);
    }
    case "dns.lookupDyn":
      return finishRuntimeCall(host, e, "scr_dns_lookup_dyn", a);
    case "dns.lookupService":
      return finishRuntimeCall(host, e, "scr_dns_lookup_service", a);
    case "dns.promisesLookup":
      return finishRuntimeCall(host, e, "scr_dns_promises_lookup", a);
    case "dns.promisesLookupService":
      return finishRuntimeCall(host, e, "scr_dns_promises_lookup_service", a);
    case "dns.getServers":
      return finishRuntimeCall(host, e, "scr_dns_get_servers", a);
    case "dns.getDefaultResultOrder":
      return finishRuntimeCall(host, e, "scr_dns_get_default_result_order", a);
    case "dns.setDefaultResultOrder":
      return finishRuntimeCall(host, e, "scr_dns_set_default_result_order", a);
    default:
      throw new InternalCompilerError(`unhandled datagram call ${e.fn}`);
  }
}

registerReplay("messageAdapter", (host, args) => messageAdapter(host, args[0] as IrType));
registerReplay("lookupAdapter", (host, args) => lookupAdapter(host, args[0] as LlValue));
