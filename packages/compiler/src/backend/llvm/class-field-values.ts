import type { IrClassField } from "../../ir/ir.js";
import { wtf8Bytes } from "../literals.js";
import type { BlockBuilder } from "./blocks.js";
import { classFieldIndex, classStructSym } from "./classes.js";
import type { LlvmEmitterContext } from "./expr-context.js";
import type { NullableRefField } from "./nullable-fields.js";
import { loadStructField, traceArg, vAdapters } from "./shapes.js";

/** An owned (+1) union value for a nullable-pointer class field slot `p`
 * (the unit arm's immortal instance, or a fresh box around a retained
 * instance). The bridge releases it after boxing. */
function nullableFieldUnion(
  host: LlvmEmitterContext,
  B: BlockBuilder,
  p: string,
  nullable: NullableRefField,
): string {
  const rc = vAdapters(host.shapeHost, nullable.arm);
  host.declare(`declare ptr @scr_union_new_ref(i32, ptr, ptr, ptr, ptr)`);
  const isNull = B.tmp(),
    retained = B.tmp(),
    box = B.tmp(),
    out = B.tmp();
  const unit = B.newLabel("nf.u"),
    ref = B.newLabel("nf.r"),
    join = B.newLabel("nf.j");
  B.line(`${isNull} = icmp eq ptr ${p}, null`);
  B.condBr(isNull, unit, ref);
  B.startBlock(unit);
  B.br(join);
  B.startBlock(ref);
  B.line(`${retained} = call ptr ${rc.retain}(ptr ${p})`);
  B.line(
    `${box} = call ptr @scr_union_new_ref(i32 ${nullable.refTag}, ptr ${retained}, ptr ${rc.retain}, ptr ${rc.release}, ptr ${traceArg(host.shapeHost, nullable.arm)})`,
  );
  B.br(join);
  B.startBlock(join);
  B.line(
    `${out} = phi ptr [ ${host.unitInstanceRef(nullable.unionId, nullable.unitTag)}, %${unit} ], [ ${box}, %${ref} ]`,
  );
  return out;
}

/** Load the physical field once. Nullable references remain raw pointers
 * until boxing; their null value is also the initialization probe for symbols. */
export function loadClassFieldValue(
  host: LlvmEmitterContext,
  B: BlockBuilder,
  className: string,
  field: IrClassField,
  receiver: string,
): string {
  const meta = host.classMeta.get(className)!;
  const { index } = classFieldIndex(meta, field.name);
  const slot = B.tmp();
  B.line(
    `${slot} = getelementptr inbounds %${classStructSym(className)}, ptr ${receiver}, i64 0, i32 ${index}`,
  );
  if (host.int32Slots.isField(className, field.name)) {
    const raw = B.tmp(),
      value = B.tmp();
    B.line(`${raw} = load i32, ptr ${slot}`);
    B.line(`${value} = sitofp i32 ${raw} to double`);
    return value;
  }
  return loadStructField(
    B,
    host.sizeType,
    slot,
    field.type,
    host.inlineUnions.classField(className, field.name),
  );
}

/** Read the logical own value before touching its native storage. A bare
 * declaration can mask an earlier write whose physical child still needs tracing. */
export function readClassFieldValue(
  host: LlvmEmitterContext,
  B: BlockBuilder,
  className: string,
  field: IrClassField,
  receiver: string,
): string {
  const load = (): string =>
    boxClassFieldValue(
      host,
      B,
      className,
      field,
      loadClassFieldValue(host, B, className, field, receiver),
    );
  if (!host.classMeta.get(className)!.def.nativePropertyBagHelper) return load();
  host.declare(
    `declare zeroext i1 @scr_native_property_declared_undefined(ptr, ptr, ${host.sizeType})`,
  );
  host.declare("declare ptr @scr_dyn_undefined()");
  const marked = B.tmp(),
    undefinedValue = B.tmp(),
    result = B.tmp();
  const missing = B.newLabel("field.undefined"),
    present = B.newLabel("field.value"),
    join = B.newLabel("field.join");
  B.line(
    `${marked} = call zeroext i1 @scr_native_property_declared_undefined(ptr ${receiver}, ptr ${host.cstr(field.name)}, ${host.sizeType} ${wtf8Bytes(field.name).length})`,
  );
  B.condBr(marked, missing, present);
  B.startBlock(missing);
  B.line(`${undefinedValue} = call ptr @scr_dyn_undefined()`);
  B.br(join);
  B.startBlock(present);
  const value = load(),
    predecessor = B.currentLabel();
  B.br(join);
  B.startBlock(join);
  B.line(`${result} = phi ptr [ ${undefinedValue}, %${missing} ], [ ${value}, %${predecessor} ]`);
  return result;
}

/** Return one owned dynamic value without observing any sibling field.
 * Nullable slots need a temporary union wrapper; ordinary slot values borrow. */
export function boxClassFieldValue(
  host: LlvmEmitterContext,
  B: BlockBuilder,
  className: string,
  field: IrClassField,
  raw: string,
): string {
  const nullable = host.nullableFields.get(className, field.name);
  const value = nullable ? nullableFieldUnion(host, B, raw, nullable) : raw;
  const boxed = host.streamTypedRefBoxValue(B, field.type, value);
  if (nullable) {
    host.declare("declare void @scr_union_release(ptr)");
    B.line(`call void @scr_union_release(ptr ${value})`);
  }
  return boxed;
}
