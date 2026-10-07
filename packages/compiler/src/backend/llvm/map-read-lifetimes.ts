import {
  isRefCounted,
  typeEquals,
  type IrExpr,
  type IrFunction,
  type IrType,
  type IrUnionDef,
} from "../../ir/ir.js";
import { everyStmtList } from "../../ir/traverse.js";
import type { CallLifetimes } from "./call-lifetimes.js";
import type { LlValue, LlvmEmitterContext } from "./expr-context.js";
import { mapKeyAccess, mapKeyParamType } from "./shapes.js";

function hasTypedCollectionReceiver(
  expr: IrExpr,
): expr is Extract<IrExpr, { kind: "mapIntrinsic" | "setIntrinsic" }> {
  if (expr.kind !== "mapIntrinsic" && expr.kind !== "setIntrinsic") return false;
  const receiver = expr.receiver.type;
  if (receiver.kind === "map") {
    if (receiver.key.kind === "dyn" || receiver.value.kind === "dyn") return false;
  } else if (receiver.kind === "set") {
    if (receiver.elem.kind === "dyn") return false;
  } else return false;
  return true;
}

/** Typed reads neither invoke callbacks nor consume their inputs. Reference
 * results carry their own owner. Generic views keep the adapter path. */
export function borrowsMapReadInputs(expr: IrExpr): boolean {
  if (!hasTypedCollectionReceiver(expr)) return false;
  switch (expr.method) {
    case "get":
    case "has":
    case "size":
    case "iterCount":
    case "iterLive":
    case "iterKey":
    case "iterValue":
      return true;
    default:
      return false;
  }
}

/** Native typed mutations borrow their receiver and invoke no user code.
 * Stored arguments still acquire ownership, and the mutation itself must
 * never be classified as preserving the collection's reference edges. */
export function borrowsMapMutationReceiver(expr: IrExpr): boolean {
  if (!hasTypedCollectionReceiver(expr)) return false;
  return (
    expr.method === "set" ||
    expr.method === "add" ||
    expr.method === "delete" ||
    expr.method === "clear"
  );
}

export interface LocalMapRead {
  type: IrType;
  receiver: IrExpr;
  key: IrExpr;
  value: IrType;
  presentTag: number;
  missingTag: number;
}

export function matchMapRead(
  expr: IrExpr,
  unions: ReadonlyMap<string, IrUnionDef>,
): LocalMapRead | null {
  if (
    expr.kind !== "mapIntrinsic" ||
    expr.method !== "get" ||
    expr.args.length !== 1 ||
    expr.receiver.type.kind !== "map" ||
    expr.type.kind !== "union" ||
    !borrowsMapReadInputs(expr)
  )
    return null;
  const value = expr.receiver.type.value;
  // An already-boxed union is the stored value itself. Its identity and
  // ownership stay on the existing path instead of constructing a new box.
  if (
    value.kind === "union" ||
    (!isRefCounted(value) && value.kind !== "f64" && value.kind !== "bool")
  )
    return null;
  const arms = unions.get(expr.type.unionId)?.arms;
  if (!arms || arms.length !== 2) return null;
  const presentTag = arms.findIndex((arm) => typeEquals(arm, value));
  const missingTag = arms.findIndex((arm) => arm.kind === "undefinedT");
  if (presentTag < 0 || missingTag < 0) return null;
  return {
    type: expr.type,
    receiver: expr.receiver,
    key: expr.args[0]!,
    value,
    presentTag,
    missingTag,
  };
}

export interface MapReadLifetimes {
  locals: Map<string, LocalMapRead>;
  arguments: Map<IrExpr, LocalMapRead>;
}

/** Reuse the box-use proof for both lexical locals and direct arguments.
 * Each read owns an independent payload snapshot: changing or clearing the
 * map later cannot invalidate an earlier result. No map purity assumption
 * is needed, including for reference-valued entries. */
export function findMapReadLifetimes(
  fn: IrFunction,
  unions: ReadonlyMap<string, IrUnionDef>,
  lifetimes: CallLifetimes,
): MapReadLifetimes {
  const result: MapReadLifetimes = { locals: new Map(), arguments: new Map() };
  if (fn.async || fn.generator) return result;
  const locals = lifetimes.locals.get(fn.name);
  everyStmtList(fn.body, {
    stmt: (stmt) => {
      if (stmt.kind === "varDecl" && stmt.init && locals?.has(stmt.localId)) {
        const read = matchMapRead(stmt.init, unions);
        if (read) result.locals.set(stmt.localId, read);
      }
      return true;
    },
    expr: (expr) => {
      if (expr.kind !== "call") return true;
      const parameters = lifetimes.parameters.get(expr.callee);
      if (parameters)
        expr.args.forEach((arg, index) => {
          if (!parameters.has(index)) return;
          const read = matchMapRead(arg, unions);
          if (read) result.arguments.set(arg, read);
        });
      return true;
    },
  });
  return result;
}

export function emitMapLookupKey(
  host: LlvmEmitterContext,
  key: IrExpr,
  borrow: boolean,
): { access: string; types: string; args: string } {
  const span =
    borrow && key.kind === "varRef" && key.type.kind === "string"
      ? host.splitSpans.get(key.localId)
      : undefined;
  if (span)
    return {
      access: "span",
      types: `ptr, ${host.sizeType}`,
      args: `ptr ${span.bytes}, ${host.sizeType} ${span.length}`,
    };
  const value = borrow ? host.emitReadReceiver(key) : host.emitExpr(key);
  const access = mapKeyAccess(key.type);
  const type = mapKeyParamType(access);
  return { access, types: type, args: `${type} ${value.name}` };
}

export interface StackMapRead {
  value: LlValue;
  owner: { slot: string; type: IrType } | null;
}

/** Preserve Map.get's ordinary lookup and tag ABI, with the temporary box
 * on the stack. The reference getter supplies +1 directly to the payload
 * slot; its lexical or call frame releases that slot on every exit. Scalar
 * results have no owner. A missing reference initializes the owner to null. */
export function emitStackMapRead(host: LlvmEmitterContext, read: LocalMapRead): StackMapRead {
  const B = host.B;
  const receiver = host.emitStableReceiver(read.receiver, [read.key]);
  const key = emitMapLookupKey(host, read.key, true);
  const access = key.access;
  const keyType = key.types;
  const box = B.slot(),
    payload = B.slot(),
    tag = B.slot();
  B.entryAllocas.push(`${box} = alloca %ScrUnion`);
  B.entryAllocas.push(`${payload} = getelementptr inbounds %ScrUnion, ptr ${box}, i32 0, i32 5`);
  B.entryAllocas.push(`${tag} = getelementptr inbounds %ScrUnion, ptr ${box}, i32 0, i32 1`);
  const found = B.tmp();
  let owner: StackMapRead["owner"] = null;
  if (isRefCounted(read.value)) {
    const raw = B.tmp();
    host.declare(`declare ptr @scr_map_get_${access}_ref(ptr, ${keyType})`);
    B.line(`${raw} = call ptr @scr_map_get_${access}_ref(ptr ${receiver.name}, ${key.args})`);
    B.line(`${found} = icmp ne ptr ${raw}, null`);
    B.line(`store i64 0, ptr ${payload}`);
    B.line(`store ptr ${raw}, ptr ${payload}`);
    owner = { slot: payload, type: read.value };
  } else {
    const scalar = read.value.kind === "f64" ? "f64" : "bool";
    B.line(`store i64 0, ptr ${payload}`);
    host.declare(`declare zeroext i1 @scr_map_get_${access}_${scalar}(ptr, ${keyType}, ptr)`);
    B.line(
      `${found} = call zeroext i1 @scr_map_get_${access}_${scalar}(ptr ${receiver.name}, ${key.args}, ptr ${payload})`,
    );
    if (read.value.kind === "bool") {
      // The runtime writes a byte; union projections read an i64. Widen
      // explicitly rather than depending on the target's byte order.
      const byte = B.tmp(),
        bits = B.tmp();
      B.line(`${byte} = load i8, ptr ${payload}`);
      B.line(`${bits} = zext i8 ${byte} to i64`);
      B.line(`store i64 ${bits}, ptr ${payload}`);
    }
  }
  const selected = B.tmp();
  B.line(`${selected} = select i1 ${found}, i32 ${read.presentTag}, i32 ${read.missingTag}`);
  B.line(`store i32 ${selected}, ptr ${tag}`);
  return { value: { name: box, type: read.type }, owner };
}
