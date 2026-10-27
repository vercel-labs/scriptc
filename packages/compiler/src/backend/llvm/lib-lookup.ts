import { InternalCompilerError } from "../../errors.js";
import { type IrType, typeKey } from "../../ir/ir.js";
import { mangleRecordRelease, mangleRecordStruct } from "../mangle.js";
import type { LibCallExpr, LlValue, LlvmEmitterContext } from "./expr-context.js";
import { abiValue, callbackType, finishRuntimeCall, ptr } from "./lib-abi.js";
import { FN_ATTRS } from "./shapes.js";
import { registerReplay } from "./emit-journal.js";

export function emitLookupConnect(host: LlvmEmitterContext, e: LibCallExpr): LlValue {
  const args = e.args.map((arg) => host.emitExpr(arg)),
    cb = args[2]!;
  const lookup = callbackType(cb),
    answer = lookup.params[2];
  if (answer?.kind !== "func" || answer.params.length !== 2)
    throw new InternalCompilerError("lookup answer must have two parameters");
  const symbol = lookupAnswer(host, answer);
  host.usesTimers = true;
  host.toHeap(cb);
  return finishRuntimeCall(host, e, "scr_net_connect_lookup", [
    ...args.map((arg) => abiValue(host, arg)),
    ptr("@" + symbol),
  ]);
}

/** The thunk that hands a lookup's answer (error, addresses) to the
 * runtime, one per answer signature. */
function lookupAnswer(host: LlvmEmitterContext, answer: IrType & { kind: "func" }): string {
  const error = answer.params[0]!,
    addresses = answer.params[1]!;
  if (error.kind !== "union" || addresses.kind !== "array" || addresses.elem.kind !== "record")
    throw new InternalCompilerError("invalid lookup answer parameters");
  const nullTag =
    host.unionsById.get(error.unionId)?.arms.findIndex((arm) => arm.kind === "nullT") ?? -1;
  const shape = host.recordsById.get(addresses.elem.shapeId);
  const field = shape?.fields.findIndex((item) => item.name === "address") ?? -1;
  if (nullTag < 0 || field < 0) throw new InternalCompilerError("invalid lookup answer layouts");
  const key = "lookup:" + typeKey(answer);
  let symbol = host.resolveThunks.get(key);
  if (symbol === undefined) {
    symbol = host.contentSymbol("sc_lookup_answer_", key);
    host.resolveThunks.set(key, symbol);
    host.journal?.allocated(symbol, "lookupAnswer", [answer]);
    for (const declaration of [
      "declare ptr @scr_str_retain_v(ptr)",
      "declare void @scr_str_release(ptr)",
      "declare void @scr_union_release(ptr)",
      "declare void @scr_arr_release(ptr)",
      "declare double @scr_arr_len(ptr)",
      `declare ptr @scr_arr_new(i32, ${host.sizeType})`,
      "declare ptr @scr_arr_get_ref(ptr, double)",
      "declare double @scr_arr_push_ref(ptr, ptr)",
      "declare void @scr_net_lookup_answer(ptr, i1 zeroext, ptr, ptr)",
    ])
      host.declare(declaration);
    const struct = mangleRecordStruct(addresses.elem.shapeId),
      release = mangleRecordRelease(addresses.elem.shapeId);
    host.resolveThunkDefs.push(
      `define internal void @${symbol}(ptr %self, ptr %error, ptr %addresses) ${FN_ATTRS} {`,
      "entry:",
      "  %tagp = getelementptr inbounds %ScrUnion, ptr %error, i64 0, i32 1",
      "  %tag = load i32, ptr %tagp",
      `  %failed = icmp ne i32 %tag, ${nullTag}`,
      "  br i1 %failed, label %failure, label %success",
      "failure:",
      "  %errorp = getelementptr inbounds %ScrUnion, ptr %error, i64 0, i32 5",
      "  %err = load ptr, ptr %errorp",
      `  %messagep = getelementptr inbounds i8, ptr %err, i64 ${host.abiOffset(24, 12)}`,
      "  %message = load ptr, ptr %messagep",
      "  %owned.message = call ptr @scr_str_retain_v(ptr %message)",
      "  br label %finish",
      "success:",
      "  %length = call double @scr_arr_len(ptr %addresses)",
      `  %capacity = fptoui double %length to ${host.sizeType}`,
      `  %ips = call ptr @scr_arr_new(i32 2, ${host.sizeType} %capacity)`,
      "  br label %condition",
      "condition:",
      "  %index = phi double [ 0.0, %success ], [ %next, %body ]",
      "  %more = fcmp olt double %index, %length",
      "  br i1 %more, label %body, label %finish",
      "body:",
      "  %record = call ptr @scr_arr_get_ref(ptr %addresses, double %index)",
      `  %addressp = getelementptr inbounds %${struct}, ptr %record, i64 0, i32 ${field + host.nullableUnions.fieldBase(addresses.elem.shapeId)}`,
      "  %address = load ptr, ptr %addressp",
      "  %owned.address = call ptr @scr_str_retain_v(ptr %address)",
      "  call double @scr_arr_push_ref(ptr %ips, ptr %owned.address)",
      `  call void @${release}(ptr %record)`,
      "  %next = fadd double %index, 1.0",
      "  br label %condition",
      "finish:",
      "  %msg = phi ptr [ %owned.message, %failure ], [ null, %condition ]",
      "  %list = phi ptr [ null, %failure ], [ %ips, %condition ]",
      "  call void @scr_net_lookup_answer(ptr %self, i1 zeroext %failed, ptr %msg, ptr %list)",
      "  call void @scr_str_release(ptr %msg)",
      "  call void @scr_arr_release(ptr %list)",
      "  call void @scr_union_release(ptr %error)",
      "  call void @scr_arr_release(ptr %addresses)",
      "  ret void",
      "}",
      "",
    );
    host.journal?.built();
  }
  return symbol;
}

registerReplay("lookupAnswer", (host, args) =>
  lookupAnswer(host, args[0] as IrType & { kind: "func" }),
);
