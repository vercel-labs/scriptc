import { InternalCompilerError } from "../../errors.js";
import { HTTPRES_T, NETSOCKET_T, typeKey } from "../../ir/ir.js";
import type { LibCallExpr, LlValue, LlvmEmitterContext } from "./expr-context.js";
import { abiValue, callbackType, finishRuntimeCall, ptr } from "./lib-abi.js";
import { FN_ATTRS } from "./shapes.js";
import { registerReplay } from "./emit-journal.js";

/** CONNECT transfers owned request/socket/response values to the listener. */
function connectAdapter(host: LlvmEmitterContext, cb: LlValue, h2: boolean): string {
  const type = callbackType(cb),
    second = type.params[1];
  /* A typed listener takes the union of the two arms; an untyped one
   * (dynamic slot) receives whichever value the arm carries, boxed as the
   * handle it is, so its member uses dispatch at runtime. A plain socket
   * slot is the HTTP/1-only shape (the adapter then exists for the head
   * union, not for the second slot). */
  const secondDyn = second?.kind === "dyn";
  const secondPlain = second?.kind === "netSocket";
  if (!secondDyn && !secondPlain && second?.kind !== "union")
    throw new InternalCompilerError("CONNECT adapter requires a union, dynamic or socket slot");
  const kind = h2 ? "httpRes" : "netSocket";
  let tag = -1;
  if (!secondDyn && !secondPlain) {
    tag = host.unionsById.get(second.unionId)?.arms.findIndex((arm) => arm.kind === kind) ?? -1;
    if (tag < 0) throw new InternalCompilerError(`CONNECT union lacks its ${kind} arm`);
  }
  const key = `connect:${h2}:${typeKey(type)}`;
  const previous = host.resolveThunks.get(key);
  if (previous !== undefined) return previous;
  const symbol = host.contentSymbol("sc_connect_", key);
  host.resolveThunks.set(key, symbol);
  host.journal?.allocated(symbol, "connectAdapter", [cb, h2]);
  const retain = h2 ? "scr_http_res_retain_v" : "scr_net_sock_retain_v";
  const release = h2 ? "scr_http_res_release_v" : "scr_net_sock_release_v";
  host.declare(`declare ptr @${retain}(ptr)`);
  host.declare(`declare void @${release}(ptr)`);
  if (!secondDyn && !secondPlain)
    host.declare("declare ptr @scr_union_new_ref(i32, ptr, ptr, ptr, ptr)");
  /* The listener's third slot: HTTP/1 hands the head over as a Buffer, the
   * h2 arm has none. A typed listener declares `Buffer | undefined`, so the
   * adapter builds that union's arm (the head on HTTP/1, the undefined
   * sentinel on h2); a dynamic slot (an untyped listener) takes a boxed
   * Buffer on HTTP/1 and undefined on h2. */
  const third = type.params[2];
  const thirdDyn = third?.kind === "dyn";
  const thirdUnion =
    third?.kind === "union"
      ? (() => {
          const def = host.unionsById.get(third.unionId);
          const bytesTag = def?.arms.findIndex((a) => a.kind === "bytes" && a.elem === "u8") ?? -1;
          const undefTag = def?.arms.findIndex((a) => a.kind === "undefinedT") ?? -1;
          if (bytesTag < 0 || undefTag < 0)
            throw new InternalCompilerError("CONNECT head union lacks its Buffer/undefined arms");
          return { unionId: third.unionId, bytesTag, undefTag };
        })()
      : undefined;
  /* A nullable union (`Buffer | undefined`) IS the pointer with NULL as the
   * undefined arm — no ScrUnion object is built. */
  const thirdNullable = third?.kind === "union" ? host.nullableUnions.of(third) : null;
  const passHead = !h2 && third !== undefined;
  const boxHead = passHead && thirdDyn;
  if (boxHead) {
    host.declare("declare ptr @scr_dyn_new_bytes(ptr)");
    host.declare("declare void @scr_bytes_release(ptr)");
  } else if (!h2 && !passHead) {
    host.declare("declare void @scr_bytes_release(ptr)");
  }
  if (thirdUnion !== undefined && thirdNullable === null) {
    host.declare("declare ptr @scr_union_new_ref(i32, ptr, ptr, ptr, ptr)");
    host.declare("declare ptr @scr_bytes_retain_v(ptr)");
    host.declare("declare void @scr_bytes_release_v(ptr)");
  }
  if (h2 && thirdDyn) {
    host.declare("declare ptr @scr_dyn_undefined()");
    host.declare("declare ptr @scr_dyn_retain_v(ptr)");
  }
  const callHead = passHead || (h2 && (thirdDyn || thirdUnion !== undefined));
  /* The h2 arm's undefined arm is an immortal constant ("null" for a
   * nullable union), usable as the call operand directly. */
  const headArg =
    h2 && thirdUnion !== undefined
      ? host.unitInstanceRef(thirdUnion.unionId, thirdUnion.undefTag)
      : thirdUnion !== undefined && thirdNullable !== null
        ? "%head"
        : thirdDyn || thirdUnion !== undefined
          ? "%headv"
          : "%head";
  host.resolveThunkDefs.push(
    `define internal void @${symbol}(ptr %cb, ptr %request, ptr %value${h2 ? "" : ", ptr %head"}) ${FN_ATTRS} {`,
    "entry:",
    ...(!h2 && !passHead ? ["  call void @scr_bytes_release(ptr %head)"] : []),
    ...(boxHead
      ? [
          "  %headv = call ptr @scr_dyn_new_bytes(ptr %head)",
          "  call void @scr_bytes_release(ptr %head)",
        ]
      : thirdUnion !== undefined && h2
        ? []
        : thirdUnion !== undefined && thirdNullable === null
          ? [
              `  %headv = call ptr @scr_union_new_ref(i32 ${thirdUnion.bytesTag}, ptr %head, ptr @scr_bytes_retain_v, ptr @scr_bytes_release_v, ptr null)`,
            ]
          : h2 && thirdDyn
            ? [
                "  %undef = call ptr @scr_dyn_undefined()",
                "  %headv = call ptr @scr_dyn_retain_v(ptr %undef)",
              ]
            : []),
    ...(secondDyn
      ? [
          `  %slot = call ptr @${host.dyn.toDynHelper(h2 ? HTTPRES_T : NETSOCKET_T)}(ptr %value)`,
          `  call void @${release}(ptr %value)`,
        ]
      : secondPlain
        ? []
        : [
            `  %slot = call ptr @scr_union_new_ref(i32 ${tag}, ptr %value, ptr @${retain}, ptr @${release}, ptr null)`,
          ]),
    "  %fnp = getelementptr inbounds %ScrClosure, ptr %cb, i64 0, i32 1",
    "  %fn = load ptr, ptr %fnp",
    `  call void %fn(ptr %cb, ptr %request, ptr ${secondPlain ? "%value" : "%slot"}${callHead ? `, ptr ${headArg}` : ""})`,
    "  ret void",
    "}",
    "",
  );
  host.journal?.built();
  return symbol;
}

export function emitConnectListener(host: LlvmEmitterContext, e: LibCallExpr): LlValue {
  const args = e.args.map((arg) => host.emitExpr(arg)),
    a = args.map((arg) => abiValue(host, arg));
  const cb = args[1]!,
    type = callbackType(cb),
    arity = type.params.length,
    second = type.params[1];
  host.toHeap(cb);
  let h1: string,
    h2 = "null";
  if (second?.kind === "union") {
    h1 = "@" + connectAdapter(host, cb, false);
    if (host.unionsById.get(second.unionId)?.arms.some((arm) => arm.kind === "httpRes"))
      h2 = "@" + connectAdapter(host, cb, true);
  } else if (second?.kind === "dyn") {
    /* One dynamic slot serves both arms: the h2 server's CONNECT hands the
     * compatibility response over instead of a socket. */
    h1 = "@" + connectAdapter(host, cb, false);
    h2 = "@" + connectAdapter(host, cb, true);
  } else if (type.params[2]?.kind === "union") {
    /* HTTP/1 only, with a `Buffer | undefined` head: the adapter builds the
     * union arm (the h2 arm does not exist for a plain socket slot). */
    h1 = "@" + connectAdapter(host, cb, false);
  } else {
    h1 = `@scr_http_upgrade_thunk${Math.min(arity, 3)}`;
    host.declare(`declare void ${h1}(ptr, ptr, ptr, ptr)`);
  }
  if (arity <= 1) {
    h2 = `@scr_http_handler_thunk${arity}`;
    host.declare(`declare void ${h2}(ptr, ptr, ptr)`);
  }
  return finishRuntimeCall(host, e, "scr_http_server_on_connect", [
    a[0]!,
    a[1]!,
    ptr(h1),
    ptr(h2),
    a[2]!,
  ]);
}

registerReplay("connectAdapter", (host, args) =>
  connectAdapter(host, args[0] as LlValue, args[1] as boolean),
);
