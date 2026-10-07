/** Argument marshalling at the runtime C ABI boundary. */
import { InternalCompilerError } from "../../errors.js";
import { type IrType } from "../../ir/ir.js";
import { MAY_THROW_LIB_FNS } from "../../ir/builtin-effects.js";
import type { LibCallExpr, LlValue, LlvmEmitterContext } from "./expr-context.js";
import { vAdapters } from "./shapes.js";

export interface AbiArgument {
  type: string;
  name: string;
}
export const ptr = (name = "null"): AbiArgument => ({ type: "ptr", name });
export function abiValue(host: LlvmEmitterContext, value: LlValue): AbiArgument {
  return { type: host.llType(value.type), name: value.name };
}
const parameterType = (type: string): string => (type === "i1" ? "i1 zeroext" : type);

export function callRuntime(
  host: LlvmEmitterContext,
  symbol: string,
  resultType: string,
  args: AbiArgument[],
): string {
  const result = resultType === "i1" ? "zeroext i1" : resultType;
  host.declare(
    `declare ${result} @${symbol}(${args.map((arg) => parameterType(arg.type)).join(", ")})`,
  );
  const name = resultType === "void" ? "" : host.B.tmp();
  host.B.line(
    `${name === "" ? "" : name + " = "}call ${result} @${symbol}(${args.map((arg) => `${parameterType(arg.type)} ${arg.name}`).join(", ")})`,
  );
  return name;
}

export function finishRuntimeCall(
  host: LlvmEmitterContext,
  e: LibCallExpr,
  symbol: string,
  args: AbiArgument[],
): LlValue {
  const name = callRuntime(host, symbol, host.llType(e.type), args);
  const out = e.type.kind === "void" ? { name, type: e.type } : host.own({ name, type: e.type });
  if (MAY_THROW_LIB_FNS.has(e.fn)) host.emitPendingCheck();
  return out;
}

/** Strings inline their bytes; Buffer views carry a separate data pointer. */
export function rawBytes(host: LlvmEmitterContext, value: LlValue): AbiArgument[] {
  const B = host.B;
  if (host.mod.workers && value.type.kind === "bytes") {
    // Native consumers can block or invoke callbacks. Keep a local copy of
    // shared storage alive in the ownership frame instead of escaping its
    // raw pointer or holding the shared-memory lock across the call.
    const name = callRuntime(host, "scr_bytes_local_copy", "ptr", [ptr(value.name)]);
    value = host.own({ name, type: value.type });
  }
  const lengthPtr = B.tmp(),
    length = B.tmp(),
    data = B.tmp();
  B.line(
    `${lengthPtr} = getelementptr inbounds i8, ptr ${value.name}, i64 ${host.abiOffset(8, 4)}`,
  );
  B.line(`${length} = load ${host.sizeType}, ptr ${lengthPtr}`);
  if (value.type.kind === "string") {
    B.line(`${data} = getelementptr inbounds i8, ptr ${value.name}, i64 ${host.abiOffset(24, 12)}`);
  } else if (value.type.kind === "bytes" && value.type.elem === "u8") {
    const dataPtr = B.tmp();
    B.line(
      `${dataPtr} = getelementptr inbounds i8, ptr ${value.name}, i64 ${host.abiOffset(24, 12)}`,
    );
    B.line(`${data} = load ptr, ptr ${dataPtr}`);
  } else throw new InternalCompilerError("runtime byte argument must be a string or Buffer");
  return [ptr(data), { type: host.sizeType, name: length }];
}

export function callbackType(value: LlValue): IrType & { kind: "func" } {
  if (value.type.kind !== "func")
    throw new InternalCompilerError("runtime callback must be a function");
  return value.type;
}

export function callbackAdapter(
  host: LlvmEmitterContext,
  value: LlValue,
  symbol: string,
  params: string[],
): AbiArgument[] {
  host.moveTemp(value);
  host.declare(`declare void @${symbol}(${params.join(", ")})`);
  return [ptr(value.name), ptr(`@${symbol}`)];
}

export function requestHandler(host: LlvmEmitterContext, value: LlValue): AbiArgument[] {
  const arity = callbackType(value).params.length;
  return callbackAdapter(host, value, `scr_http_handler_thunk${Math.min(arity, 2)}`, [
    "ptr",
    "ptr",
    "ptr",
  ]);
}

/** Wrap an owned nullable runtime reference in the program's tagged union. */
export function nullableReference(
  host: LlvmEmitterContext,
  type: IrType,
  value: string,
  presentKind: IrType["kind"],
  absentKind: "nullT" | "undefinedT",
): LlValue {
  if (type.kind !== "union")
    throw new InternalCompilerError("nullable runtime result must be a union");
  const arms = host.unionsById.get(type.unionId)?.arms ?? [];
  const presentTag = arms.findIndex((arm) => arm.kind === presentKind);
  const absentTag = arms.findIndex((arm) => arm.kind === absentKind);
  if (presentTag < 0 || absentTag < 0)
    throw new InternalCompilerError("nullable runtime result lacks its union arms");
  const adapters = vAdapters(host.shapeHost, arms[presentTag]!);
  const B = host.B,
    yes = B.newLabel("runtime.present"),
    no = B.newLabel("runtime.absent"),
    done = B.newLabel("runtime.join");
  const exists = B.tmp();
  B.line(`${exists} = icmp ne ptr ${value}, null`);
  B.condBr(exists, yes, no);
  B.startBlock(yes);
  const wrapped = callRuntime(host, "scr_union_new_ref", "ptr", [
    { type: "i32", name: String(presentTag) },
    ptr(value),
    ptr(adapters.retain),
    ptr(adapters.release),
    ptr(),
  ]);
  B.br(done);
  B.startBlock(no);
  B.br(done);
  B.startBlock(done);
  const result = B.tmp();
  B.line(
    `${result} = phi ptr [ ${wrapped}, %${yes} ], [ ${host.unitInstanceRef(type.unionId, absentTag)}, %${no} ]`,
  );
  return host.own({ name: result, type });
}
