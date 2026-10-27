import { typedRefConstructor } from "./shapes.js";
/* Focused LLVM expression emission extracted from emitter.ts. */
import { InternalCompilerError } from "../../errors.js";
import { streamRooted, streamTypedRefEligible, undefinedArmTag } from "../../ir/analysis.js";
import {
  type IrRecordShape,
  type IrType,
  CLASS_ATTRIBUTES,
  DYN_CLASS_PROPERTIES,
  RUNTIME_STREAM_CLASSES,
  SYMBOL_T,
  classDynViewSupported,
  classFieldAttributesName,
  isClassOwnEnumerableFieldName,
  isDirentShape,
  KEY_ORDER_FIELD,
  shapeKeyOrders,
  isDynTypedRefType,
  textCodecRecordClass,
  isRefCounted,
  shapeHasAccessorSlots,
  typeKey,
  type IrClassDef,
} from "../../ir/ir.js";
import { mangleFunction, mangleGlobal, mangleRecordStruct } from "../mangle.js";
import { BlockBuilder } from "./blocks.js";
import {
  type LlClassMeta,
  classFieldIndex,
  classPreLines,
  classStructSym,
  compactRefLoadLines,
  compactRefStoreLines,
} from "./classes.js";
import { SCR_ARR_FIELD, llvmCommentText } from "./common.js";
import {
  FN_ATTRS,
  elemAccess,
  llFieldType,
  loadStructField,
  releaseSym,
  traceArg,
  vAdapters,
  type ShapeHost,
} from "./shapes.js";
import type { LlvmEmitterContext, LlStreamTypedRefAdapter } from "./expr-context.js";
import type { NullableRefField } from "./nullable-fields.js";
import { emitUnionPeek, emitUnionTag } from "./union-repr.js";
import { inlineUnionCopyLines } from "./inline-unions.js";
import { recordMayKeepSource } from "./record-sources.js";
import { emitPerKeyOrder } from "./key-orders.js";
import { registerReplay } from "./emit-journal.js";

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

export function dynPromiseAdapter(host: LlvmEmitterContext, inner: IrType): string {
  if (inner.kind === "dyn") {
    throw new InternalCompilerError(
      `dynamic promise adapter requires a concrete reference type, got ${typeKey(inner)}`,
    );
  }
  const key = typeKey(inner);
  const existing = host.dynPromiseAdapters.get(key);
  if (existing) return existing;
  const sym = `sc_dpa_${host.dynPromiseAdapters.size}`;
  host.dynPromiseAdapters.set(key, sym);
  host.journal?.allocated(sym, "dynPromiseAdapter", [inner]);
  host.declare(`declare ptr @scr_promise_payload_ref(ptr)`);
  host.declare(`declare void @scr_dyn_release_v(ptr)`);
  host.declare(`declare void @scr_promise_reject_pending(ptr)`);
  const B = new BlockBuilder();
  const dyn = B.tmp();
  const value = B.tmp();
  const pending = B.tmp();
  B.line(`${dyn} = call ptr @scr_promise_payload_ref(ptr %src)`);
  B.line(
    inner.kind === "void"
      ? `; void fulfillment ignores the checked payload`
      : `${value} = call ${host.llType(inner)} @${host.dyn.dynCheckHelper(inner)}(ptr ${dyn}, ptr null)`,
  );
  B.line(`call void @scr_dyn_release_v(ptr ${dyn})`);
  for (const line of host.pendingTestLines(pending)) B.line(line.trimStart());
  const fail = B.newLabel("sra.fail");
  const ok = B.newLabel("sra.ok");
  B.condBr(pending, fail, ok);
  B.startBlock(fail);
  B.line(`call void @scr_promise_reject_pending(ptr %dst)`);
  B.terminate(`ret void`);
  B.startBlock(ok);
  if (inner.kind === "void") {
    host.declare(`declare void @scr_promise_fulfill_void(ptr)`);
    B.line(`call void @scr_promise_fulfill_void(ptr %dst)`);
  } else if (inner.kind === "f64" || inner.kind === "procStream" || inner.kind === "bool") {
    const fn = inner.kind !== "bool" ? "scr_promise_fulfill_f64" : "scr_promise_fulfill_bool";
    host.declare(
      `declare void @${fn}(ptr, ${host.llType(inner)}${inner.kind === "bool" ? " zeroext" : ""})`,
    );
    B.line(
      `call void @${fn}(ptr %dst, ${host.llType(inner)}${inner.kind === "bool" ? " zeroext" : ""} ${value})`,
    );
  } else if (inner.kind === "string") {
    host.declare(`declare void @scr_promise_fulfill_str(ptr, ptr)`);
    B.line(`call void @scr_promise_fulfill_str(ptr %dst, ptr ${value})`);
  } else {
    const rc = vAdapters(host.shapeHost, inner);
    host.declare(`declare void @scr_promise_fulfill_ref(ptr, ptr, ptr, ptr, ptr)`);
    B.line(
      `call void @scr_promise_fulfill_ref(ptr %dst, ptr ${value}, ptr ${rc.retain}, ptr ${rc.release}, ptr ${traceArg(host.shapeHost, inner)})`,
    );
  }
  B.terminate(`ret void`);
  host.resolveThunkDefs.push(
    `define internal void @${sym}(ptr %dst, ptr %src) ${FN_ATTRS} { ; checked-dynamic promise exit ${key}`,
    B.render(),
    `}`,
    ``,
  );
  host.journal?.built();
  return sym;
}

export function streamTypedRefCommitAdapter(
  host: LlvmEmitterContext,
  t: IrType,
  snapshot: string,
): string {
  // Only a runtime store into the view commits: without one in the program,
  // class and record views need no commit (or its checked conversions).
  if (host.liveViewsReadOnly && (isDynTypedRefType(t) || t.kind === "record")) return "null";
  if (t.kind === "bytes") {
    const commit = `${snapshot}_commit`;
    const check = host.dyn.dynCheckHelper(t);
    host.declare(`declare void @scr_bytes_copy_contents(ptr, ptr)`);
    host.declare(`declare void @scr_bytes_release(ptr)`);
    host.resolveThunkDefs.push(
      `define internal void @${commit}(ptr %target, ptr %d) ${FN_ATTRS} { ; commit live stream element ${typeKey(t)}`,
      `entry:`,
      `  %next = call ptr @${check}(ptr %d, ptr null)`,
      `  %missing = icmp eq ptr %next, null`,
      `  br i1 %missing, label %done, label %copy`,
      `copy:`,
      `  call void @scr_bytes_copy_contents(ptr %target, ptr %next)`,
      `  call void @scr_bytes_release(ptr %next)`,
      `  br label %done`,
      `done:`,
      `  ret void`,
      `}`,
      ``,
    );
    return `@${commit}`;
  }
  if (t.kind === "array") {
    const commit = `${snapshot}_commit`;
    // A value the element type cannot hold stays in the array as a foreign
    // element where the program can store one (LlEmitter.mayHoldForeign).
    const check = host.mayHoldForeign(t.elem)
      ? host.dyn.dynViewArrayHelper(t)
      : host.dyn.dynCheckHelper(t);
    host.declare(`declare void @scr_arr_release(ptr)`);
    host.declare(`declare void @scr_arr_outline(ptr)`);
    host.declare(`declare void @scr_arr_adopt_view_properties(ptr, ptr, ptr)`);
    const lines = [
      `define internal void @${commit}(ptr %target, ptr %d) ${FN_ATTRS} { ; commit live stream element ${typeKey(t)}`,
      `entry:`,
      `  %next = call ptr @${check}(ptr %d, ptr null)`,
      `  %missing = icmp eq ptr %next, null`,
      `  br i1 %missing, label %done, label %swap`,
      `swap:`,
      // Properties move with the storage (in its out-of-line part).
      `  call void @scr_arr_adopt_view_properties(ptr %next, ptr %d, ptr %target)`,
      // Inline slots live in each header's block; move them out first.
      `  call void @scr_arr_outline(ptr %target)`,
      `  call void @scr_arr_outline(ptr %next)`,
    ];
    const storageMembers = [
      // The dense states follow the data slots, so they move with data and cap.
      { name: "len", index: SCR_ARR_FIELD.len, type: "i32" },
      { name: "cap", index: SCR_ARR_FIELD.cap, type: "i32" },
      { name: "data", index: SCR_ARR_FIELD.data, type: "ptr" },
      { name: "filled", index: SCR_ARR_FIELD.filled, type: "i32" },
      // The out-of-line storage's pointer lives before the dense allocation
      // and moves with data; its flag is in spare, whose element ops id the
      // two arrays share.
      { name: "spare", index: SCR_ARR_FIELD.spare, type: "i16" },
    ];
    for (const member of storageMembers) {
      lines.push(
        `  %target_${member.name}_ptr = getelementptr inbounds %ScrArr, ptr %target, i64 0, i32 ${member.index}`,
        `  %next_${member.name}_ptr = getelementptr inbounds %ScrArr, ptr %next, i64 0, i32 ${member.index}`,
        `  %target_${member.name} = load ${member.type}, ptr %target_${member.name}_ptr`,
        `  %next_${member.name} = load ${member.type}, ptr %next_${member.name}_ptr`,
        `  store ${member.type} %next_${member.name}, ptr %target_${member.name}_ptr`,
        `  store ${member.type} %target_${member.name}, ptr %next_${member.name}_ptr`,
      );
    }
    lines.push(
      `  call void @scr_arr_release(ptr %next)`,
      `  br label %done`,
      `done:`,
      `  ret void`,
      `}`,
      ``,
    );
    host.resolveThunkDefs.push(...lines);
    return `@${commit}`;
  }
  if (isDynTypedRefType(t)) {
    const meta = host.classMeta.get(t.className);
    if (!meta) {
      throw new InternalCompilerError(
        `llvm emitter bug: typed-ref commit of unknown class ${t.className}`,
      );
    }
    const commit = `${snapshot}_commit`;
    host.declare(`declare ptr @scr_dyn_obj_get(ptr, ptr, ${host.sizeType})`);
    host.declare(`declare ptr @scr_dyn_undefined()`);
    const lines = [
      `define internal void @${commit}(ptr %target, ptr %d) ${FN_ATTRS} { ; commit unknown class ${typeKey(t)}`,
      `entry:`,
    ];
    if (meta.hierarchy && meta.children.length) {
      lines.push(
        ...classPreLines(
          meta,
          classStructSym(t.className),
          "%target",
          "%derived_pre",
          host.sizeType,
        ),
      );
      const descendants = (current: typeof meta): (typeof meta)[] =>
        current.children.flatMap((child) => [child, ...descendants(child)]);
      descendants(meta)
        .reverse()
        .forEach((child, index) => {
          const adapter = host.liveDynRefAdapter({ kind: "object", className: child.def.name });
          lines.push(
            `  %derived${index} = icmp eq ${host.sizeType} %derived_pre, ${child.pre}`,
            `  br i1 %derived${index}, label %derived${index}_commit, label %derived${index}_next`,
            `derived${index}_commit:`,
            `  call void ${adapter.commit}(ptr %target, ptr %d)`,
            `  ret void`,
            `derived${index}_next:`,
          );
        });
    }
    const symbols = new Map((meta.def.symbolFields ?? []).map((symbol) => [symbol.field, symbol]));
    const fields = meta.def.fields.filter(
      (field) =>
        (isClassOwnEnumerableFieldName(field.name) || symbols.has(field.name)) &&
        !(meta.root.def.name === "%Error" && (field.name === "message" || field.name === "name")),
    );
    for (const [index, field] of fields.entries()) {
      const next = `f${index}_next`;
      const raw = `f${index}_raw`;
      const missing = `f${index}_missing`;
      const undef = `f${index}_undef`;
      const input = `f${index}_input`;
      const pending = `f${index}_pending`;
      const store = `f${index}_store`;
      const after = `f${index}_after`;
      const { index: fieldIndex, compressed } = classFieldIndex(meta, field.name, "compressed");
      const int32 = host.int32Slots.isField(t.className, field.name);
      const inline = host.inlineUnions.classField(t.className, field.name);
      const fieldTy = int32 ? "i32" : llFieldType(field.type, inline);
      const checkTy = host.llType(field.type);
      const symbolKey = symbols.get(field.name);
      if (symbolKey) {
        host.declare(`declare ptr @scr_dyn_symbol_key_get(ptr, ptr, i1 zeroext)`);
        host.declare(`declare void @scr_dyn_release_v(ptr)`);
        const keyLines = symbolKeyLines(host, symbolKey, `f${index}_keyraw`);
        lines.push(
          ...keyLines.load,
          `  %f${index}_key = call ptr @${host.dyn.toDynHelper(SYMBOL_T)}(ptr %f${index}_keyraw)`,
          ...keyLines.release,
        );
        if (field.type.kind === "symbol") {
          // A base constructor can mutate the instance before this
          // derived field initializes. An absent snapshot entry leaves
          // that native slot uninitialized until its declaration runs.
          host.declare(`declare zeroext i1 @scr_dyn_has_own_computed(ptr, ptr)`);
          lines.push(
            `  %f${index}_present = call zeroext i1 @scr_dyn_has_own_computed(ptr %d, ptr %f${index}_key)`,
            `  %f${index}_priorptr = getelementptr inbounds %${classStructSym(t.className)}, ptr %target, i64 0, i32 ${fieldIndex}`,
            `  %f${index}_prior = load ptr, ptr %f${index}_priorptr`,
            `  %f${index}_initialized = icmp ne ptr %f${index}_prior, null`,
            `  %f${index}_read = or i1 %f${index}_present, %f${index}_initialized`,
            `  br i1 %f${index}_read, label %f${index}_read_symbol, label %f${index}_absent_symbol`,
            `f${index}_absent_symbol:`,
            `  call void @scr_dyn_release_v(ptr %f${index}_key)`,
            `  br label %${after}`,
            `f${index}_read_symbol:`,
          );
        }
        lines.push(
          `  %${raw} = call ptr @scr_dyn_symbol_key_get(ptr %d, ptr %f${index}_key, i1 zeroext false)`,
          `  call void @scr_dyn_release_v(ptr %f${index}_key)`,
        );
      } else
        lines.push(
          `  %${raw} = call ptr @scr_dyn_obj_get(ptr %d, ptr ${host.cstr(field.name)}, ${host.sizeType} ${Buffer.byteLength(field.name, "utf8")})`,
        );
      if (meta.def.tracksOwnFields && !symbolKey)
        lines.push(
          `  %f${index}_present = icmp ne ptr %${raw}, null`,
          `  br i1 %f${index}_present, label %f${index}_read, label %${after}`,
          `f${index}_read:`,
        );
      lines.push(
        `  %${missing} = icmp eq ptr %${raw}, null`,
        `  %${undef} = call ptr @scr_dyn_undefined()`,
        `  %${input} = select i1 %${missing}, ptr %${undef}, ptr %${raw}`,
        `  %${next} = call ${field.type.kind === "bool" ? "zeroext " : ""}${checkTy} @${host.dyn.dynCheckHelper(field.type)}(ptr %${input}, ptr null)`,
        ...(symbolKey ? [`  call void @scr_dyn_release_v(ptr %${raw})`] : []),
        ...host.pendingTestLines(`%${pending}`),
        `  br i1 %${pending}, label %done, label %${store}`,
        `${store}:`,
        `  %f${index}_ptr = getelementptr inbounds %${classStructSym(t.className)}, ptr %target, i64 0, i32 ${fieldIndex}`,
        ...(compressed
          ? [
              `  %f${index}_oldidx = load i32, ptr %f${index}_ptr`,
              ...compactRefLoadLines(`%f${index}_oldidx`, `%f${index}_old`, `%f${index}_od`),
            ]
          : [`  %f${index}_old = load ${fieldTy}, ptr %f${index}_ptr`]),
      );
      if (int32) {
        // int32-slots.ts keeps a field int32 only when no dynamic store in
        // the program can name it, so the view still holds the exact int32
        // snapshot. Anything else would mean the proof was wrong: trap
        // rather than store a different number.
        host.declare(`declare i32 @llvm.fptosi.sat.i32.f64(double)`);
        host.declare(`declare void @llvm.trap()`);
        lines.push(
          `  %f${index}_int = call i32 @llvm.fptosi.sat.i32.f64(double %${next})`,
          `  %f${index}_back = sitofp i32 %f${index}_int to double`,
          `  %f${index}_bits = bitcast double %${next} to i64`,
          `  %f${index}_backbits = bitcast double %f${index}_back to i64`,
          `  %f${index}_exact = icmp eq i64 %f${index}_bits, %f${index}_backbits`,
          `  br i1 %f${index}_exact, label %f${index}_int_store, label %f${index}_int_trap`,
          `f${index}_int_trap:`,
          `  call void @llvm.trap()`,
          `  unreachable`,
          `f${index}_int_store:`,
          `  store i32 %f${index}_int, ptr %f${index}_ptr`,
          `  br label %${after}`,
          `${after}:`,
        );
        continue;
      }
      const nullable = host.nullableFields.get(t.className, field.name);
      if (nullable) {
        // The checked union is owned here; the slot takes its retained
        // instance pointer (NULL for the unit arm).
        const rc = vAdapters(host.shapeHost, nullable.arm);
        host.declare(`declare void @scr_union_release(ptr)`);
        lines.push(
          `  %f${index}_tagp = getelementptr inbounds %ScrUnion, ptr %${next}, i64 0, i32 1`,
          `  %f${index}_tag = load i32, ptr %f${index}_tagp`,
          `  %f${index}_isref = icmp eq i32 %f${index}_tag, ${nullable.refTag}`,
          `  %f${index}_payp = getelementptr inbounds %ScrUnion, ptr %${next}, i64 0, i32 5`,
          `  %f${index}_pay = load ptr, ptr %f${index}_payp`,
          `  %f${index}_sel = select i1 %f${index}_isref, ptr %f${index}_pay, ptr null`,
          `  %f${index}_new = call ptr ${rc.retain}(ptr %f${index}_sel)`,
          ...(compressed
            ? [
                ...compactRefStoreLines(`%f${index}_new`, `%f${index}_newidx`, `%f${index}_ne`),
                `  store i32 %f${index}_newidx, ptr %f${index}_ptr`,
              ]
            : [`  store ptr %f${index}_new, ptr %f${index}_ptr`]),
          `  call void @scr_union_release(ptr %${next})`,
          `  call void ${rc.release}(ptr %f${index}_old)`,
          `  br label %${after}`,
          `${after}:`,
        );
        continue;
      }
      if (inline) {
        // The slot copies the checked union's bits; this code releases the box.
        lines.push(
          ...inlineUnionCopyLines(`%${next}`, `%f${index}_ptr`, `%f${index}_in`),
          `  call void ${releaseSym(host.shapeHost, field.type)}(ptr %${next})`,
          `  br label %${after}`,
          `${after}:`,
        );
        continue;
      }
      if (field.type.kind === "bool") {
        lines.push(
          `  %f${index}_stored = zext i1 %${next} to i8`,
          `  store i8 %f${index}_stored, ptr %f${index}_ptr`,
        );
      } else if (compressed) {
        lines.push(
          ...compactRefStoreLines(`%${next}`, `%f${index}_nextidx`, `%f${index}_nx`),
          `  store i32 %f${index}_nextidx, ptr %f${index}_ptr`,
        );
      } else {
        lines.push(`  store ${fieldTy} %${next}, ptr %f${index}_ptr`);
      }
      if (isRefCounted(field.type)) {
        lines.push(`  call void ${releaseSym(host.shapeHost, field.type)}(ptr %f${index}_old)`);
      }
      lines.push(`  br label %${after}`, `${after}:`);
    }
    if (meta.def.fields.some((field) => field.name === DYN_CLASS_PROPERTIES)) {
      host.declare(`declare ptr @scr_dyn_new_obj()`);
      host.declare(`declare ptr @scr_dyn_copy_property_descriptors(ptr, ptr)`);
      host.declare(`declare void @scr_dyn_release_v(ptr)`);
      host.declare(`declare ptr @scr_str_new(ptr, ${host.sizeType})`);
      host.declare(`declare void @scr_str_release(ptr)`);
      host.declare(`declare void @scr_dyn_key_delete(ptr, ptr, i1 zeroext)`);
      // The view of a sealed or frozen instance holds its fields as
      // non-configurable entries, which the bag copies.
      const withAttributes = meta.def.fields.some((field) => field.name === CLASS_ATTRIBUTES);
      const placeholderSet = withAttributes ? "scr_dyn_obj_set_field" : "scr_dyn_obj_set";
      if (meta.def.tracksOwnFields) {
        host.declare(`declare ptr @scr_dyn_retain_v(ptr)`);
        host.declare(`declare void @${placeholderSet}(ptr, ptr, ${host.sizeType}, ptr)`);
      } else if (withAttributes) host.declare(`declare void @scr_dyn_obj_delete_field(ptr, ptr)`);
      lines.push(
        `  %bag = call ptr @scr_dyn_new_obj()`,
        `  %bag_copy = call ptr @scr_dyn_copy_property_descriptors(ptr %bag, ptr %d)`,
        `  call void @scr_dyn_release_v(ptr %bag_copy)`,
        ...host.pendingTestLines("%bag_pending"),
        `  br i1 %bag_pending, label %bag_fail, label %bag_keys`,
        `bag_fail:`,
        `  call void @scr_dyn_release_v(ptr %bag)`,
        `  br label %done`,
        `bag_keys:`,
      );
      if (meta.def.instancePrototypeHelper || meta.def.prototypeDataHelper) {
        host.declare(`declare ptr @scr_dyn_set_prototype(ptr, ptr)`);
        lines.push(
          ...(meta.def.instancePrototypeHelper
            ? [
                `  %prototype_receiver = call ptr ${vAdapters(host.shapeHost, t).retain}(ptr %target)`,
                `  %prototype = call ptr @${mangleFunction(meta.def.instancePrototypeHelper)}(ptr %prototype_receiver)`,
              ]
            : [`  %prototype = call ptr @${mangleFunction(meta.def.prototypeDataHelper!)}()`]),
          `  %with_prototype = call ptr @scr_dyn_set_prototype(ptr %bag, ptr %prototype)`,
          `  call void @scr_dyn_release_v(ptr %prototype)`,
          `  call void @scr_dyn_release_v(ptr %with_prototype)`,
        );
      }
      fields
        .filter((field) => !symbols.has(field.name))
        .forEach((field, index) => {
          if (meta.def.tracksOwnFields)
            lines.push(
              `  %bag_field${index} = call ptr @scr_dyn_obj_get(ptr %bag, ptr ${host.cstr(field.name)}, ${host.sizeType} ${Buffer.byteLength(field.name, "utf8")})`,
              `  %bag_present${index} = icmp ne ptr %bag_field${index}, null`,
              `  br i1 %bag_present${index}, label %bag_field${index}_present, label %bag_field${index}_after`,
              `bag_field${index}_present:`,
              `  %bag_undefined${index} = call ptr @scr_dyn_undefined()`,
              `  %bag_placeholder${index} = call ptr @scr_dyn_retain_v(ptr %bag_undefined${index})`,
              `  call void @${placeholderSet}(ptr %bag, ptr ${host.cstr(field.name)}, ${host.sizeType} ${Buffer.byteLength(field.name, "utf8")}, ptr %bag_placeholder${index})`,
              `  br label %bag_field${index}_after`,
              `bag_field${index}_after:`,
            );
          else
            lines.push(
              `  %bag_key${index} = call ptr @scr_str_new(ptr ${host.cstr(field.name)}, ${host.sizeType} ${Buffer.byteLength(field.name, "utf8")})`,
              withAttributes
                ? `  call void @scr_dyn_obj_delete_field(ptr %bag, ptr %bag_key${index})`
                : `  call void @scr_dyn_key_delete(ptr %bag, ptr %bag_key${index}, i1 zeroext false)`,
              `  call void @scr_str_release(ptr %bag_key${index})`,
            );
        });
      if (symbols.size > 0)
        host.declare(
          meta.def.tracksOwnFields
            ? `declare void @scr_dyn_symbol_key_placeholder(ptr, ptr)`
            : withAttributes
              ? `declare void @scr_dyn_obj_delete_symbol_field(ptr, ptr)`
              : `declare void @scr_dyn_key_delete_computed(ptr, ptr, i1 zeroext)`,
        );
      [...symbols.values()].forEach((symbol, index) => {
        const keyLines = symbolKeyLines(host, symbol, `bag_symraw${index}`);
        lines.push(
          ...keyLines.load,
          `  %bag_sym${index} = call ptr @${host.dyn.toDynHelper(SYMBOL_T)}(ptr %bag_symraw${index})`,
          ...keyLines.release,
          meta.def.tracksOwnFields
            ? `  call void @scr_dyn_symbol_key_placeholder(ptr %bag, ptr %bag_sym${index})`
            : withAttributes
              ? `  call void @scr_dyn_obj_delete_symbol_field(ptr %bag, ptr %bag_sym${index})`
              : `  call void @scr_dyn_key_delete_computed(ptr %bag, ptr %bag_sym${index}, i1 zeroext false)`,
          `  call void @scr_dyn_release_v(ptr %bag_sym${index})`,
        );
      });
      const { index } = classFieldIndex(meta, DYN_CLASS_PROPERTIES);
      lines.push(
        `  %bag_ptr = getelementptr inbounds %${classStructSym(t.className)}, ptr %target, i64 0, i32 ${index}`,
        `  %bag_old = load ptr, ptr %bag_ptr`,
        `  store ptr %bag, ptr %bag_ptr`,
        `  call void @scr_dyn_release_v(ptr %bag_old)`,
      );
    }
    if (meta.root.def.name === "%Error") {
      host.declare(`declare void @scr_error_commit_dyn(ptr, ptr)`);
      lines.push(`  call void @scr_error_commit_dyn(ptr %target, ptr %d)`);
    }
    // Untyped Object.freeze, seal and preventExtensions apply to the view;
    // the instance's integrity word records them.
    if (host.untypedIntegrity && meta.def.fields.some((field) => field.name === CLASS_ATTRIBUTES)) {
      const bag = meta.def.fields.some((field) => field.name === DYN_CLASS_PROPERTIES)
        ? "%bag"
        : "null";
      host.declare(`declare double @scr_dyn_class_view_integrity(ptr, double, ptr)`);
      lines.push(
        `  %word_ptr = getelementptr inbounds %${classStructSym(t.className)}, ptr %target, i64 0, i32 ${classFieldIndex(meta, CLASS_ATTRIBUTES).index}`,
        `  %word = load double, ptr %word_ptr`,
        `  %word_next = call double @scr_dyn_class_view_integrity(ptr %d, double %word, ptr ${bag})`,
        `  store double %word_next, ptr %word_ptr`,
      );
    }
    lines.push(`  br label %done`, `done:`, `  ret void`, `}`, ``);
    host.resolveThunkDefs.push(...lines);
    return `@${commit}`;
  }
  if (t.kind !== "record") return "null";
  const shape = host.recordsById.get(t.shapeId);
  if (!shape) {
    throw new InternalCompilerError(
      `llvm emitter bug: stream typed-ref commit of unknown shape ${t.shapeId}`,
    );
  }
  const commit = `${snapshot}_commit`;
  const check = host.dyn.dynCheckHelper(t);
  const lines = [
    `define internal void @${commit}(ptr %target, ptr %d) ${FN_ATTRS} { ; commit live stream element ${typeKey(t)}`,
    `entry:`,
    `  %next = call ptr @${check}(ptr %d, ptr null)`,
    `  %missing = icmp eq ptr %next, null`,
    `  br i1 %missing, label %done, label %swap`,
    `swap:`,
  ];
  const base = host.nullableUnions.fieldBase(t.shapeId);
  const members = [
    ...shape.fields.map((field, index) => ({
      index: index + base,
      type: llFieldType(field.type, host.inlineUnions.record(field.type)),
      name: field.name,
    })),
    ...(shape.indexValue
      ? [
          {
            index: shape.fields.length + base,
            type: "ptr" as const,
            name: "[key: string] overflow",
          },
        ]
      : []),
  ];
  members.forEach((member, index) => {
    lines.push(
      `  %tp${index} = getelementptr inbounds %${mangleRecordStruct(t.shapeId)}, ptr %target, i64 0, i32 ${member.index}`,
      `  %np${index} = getelementptr inbounds %${mangleRecordStruct(t.shapeId)}, ptr %next, i64 0, i32 ${member.index}`,
      `  %old${index} = load ${member.type}, ptr %tp${index} ; ${llvmCommentText(member.name)}`,
      `  %new${index} = load ${member.type}, ptr %np${index}`,
      `  store ${member.type} %new${index}, ptr %tp${index}`,
      `  store ${member.type} %old${index}, ptr %np${index}`,
    );
  });
  // The conversion kept the view's undeclared properties for %next. Shapes
  // with accessor slots keep their accessors in the view instead.
  if (recordMayKeepSource(shape) && !shapeHasAccessorSlots(shape)) {
    host.declare(`declare void @scr_record_source_move(ptr, ptr)`);
    lines.push(`  call void @scr_record_source_move(ptr %next, ptr %target)`);
  }
  lines.push(
    `  call void ${releaseSym(host.shapeHost, t)}(ptr %next)`,
    `  br label %done`,
    `done:`,
    `  ret void`,
    `}`,
    ``,
  );
  host.resolveThunkDefs.push(...lines);
  return `@${commit}`;
}

export function liveDynUnionRefAdapter(
  host: LlvmEmitterContext,
  t: IrType & { kind: "union" },
): string {
  const key = typeKey(t);
  const existing = host.liveDynUnionRefAdapters.get(key);
  if (existing) return existing;
  const union = host.unionsById.get(t.unionId);
  if (!union) {
    throw new InternalCompilerError(`llvm emitter bug: live dyn ref of unknown union ${t.unionId}`);
  }
  // Codec records box as their own handles, by reference, through toDynHelper.
  const codecArm = (arm: IrType): boolean =>
    textCodecRecordClass(arm, (id) => host.recordsById.get(id)) !== null;
  const mutableArms = union.arms
    .map((arm, tag) => ({ arm, tag }))
    .filter(
      ({ arm }) =>
        arm.kind !== "bytes" &&
        !codecArm(arm) &&
        (streamTypedRefEligible(arm) || isDynTypedRefType(arm)),
    );
  if (
    mutableArms.length === 0 &&
    !union.arms.some((arm) => arm.kind === "bytes" || codecArm(arm))
  ) {
    throw new InternalCompilerError(`llvm emitter bug: live dyn ref of immutable union ${key}`);
  }

  const sym = `sc_ldu_${host.liveDynUnionRefAdapters.size}`;
  host.liveDynUnionRefAdapters.set(key, sym);
  host.journal?.allocated(sym, "liveDynUnionRefAdapter", [t]);

  const adapters = new Map<number, LlStreamTypedRefAdapter>();
  for (const { arm, tag } of mutableArms) {
    adapters.set(tag, host.liveDynRefAdapter(arm));
  }

  const B = new BlockBuilder();
  const nullable = host.nullableUnions.get(t.unionId);
  const tagValue = emitUnionTag(B, nullable, "%u");
  const fallback = B.newLabel("ldu.bad");
  const armLabels = mutableArms.map(() => B.newLabel("ldu.ref"));
  const mutableTags = new Set(mutableArms.map(({ tag }) => tag));
  const valueArms = union.arms
    .map((arm, tag) => ({ arm, tag }))
    .filter(({ tag }) => !mutableTags.has(tag));
  const valueLabels = valueArms.map(() => B.newLabel("ldu.value"));
  B.terminate(
    `switch i32 ${tagValue}, label %${fallback} [ ${[
      ...mutableArms.map(({ tag }, index) => `i32 ${tag}, label %${armLabels[index]}`),
      ...valueArms.map(({ tag }, index) => `i32 ${tag}, label %${valueLabels[index]}`),
    ].join(" ")} ]`,
  );
  mutableArms.forEach(({ arm, tag }, index) => {
    const adapter = adapters.get(tag)!;
    const rc = vAdapters(host.shapeHost, arm);
    const armKey = typeKey(arm);
    B.startBlock(armLabels[index]!);
    const payload = emitUnionPeek(B, nullable, "%u");
    const boxed = B.tmp();
    B.line(
      `${boxed} = call ptr ${typedRefConstructor(host.shapeHost, arm)}(ptr ${payload}, ptr ${rc.retain}, ptr ${rc.release}, ptr ${host.cstr(armKey)}, ${host.sizeType} ${Buffer.byteLength(armKey, "utf8")}, ptr @${adapter.snapshot}, ptr ${adapter.commit})`,
    );
    for (const line of bindLiveArrayOps(host.shapeHost, adapter, boxed)) B.line(line);
    B.terminate(`ret ptr ${boxed}`);
  });
  valueArms.forEach(({ arm }, index) => {
    B.startBlock(valueLabels[index]!);
    if (arm.kind === "undefinedT") {
      host.declare(`declare ptr @scr_dyn_undefined()`);
      host.declare(`declare ptr @scr_dyn_retain_v(ptr)`);
      const undef = B.tmp();
      const boxed = B.tmp();
      B.line(`${undef} = call ptr @scr_dyn_undefined()`);
      B.line(`${boxed} = call ptr @scr_dyn_retain_v(ptr ${undef})`);
      B.terminate(`ret ptr ${boxed}`);
    } else if (arm.kind === "nullT") {
      host.declare(`declare ptr @scr_dyn_new_null()`);
      const boxed = B.tmp();
      B.line(`${boxed} = call ptr @scr_dyn_new_null()`);
      B.terminate(`ret ptr ${boxed}`);
    } else if (arm.kind === "f64" || arm.kind === "procStream") {
      host.declare(`declare double @scr_union_get_f64(ptr)`);
      const value = B.tmp();
      const boxed = B.tmp();
      B.line(`${value} = call double @scr_union_get_f64(ptr %u)`);
      B.line(`${boxed} = call ptr @${host.dyn.toDynHelper(arm)}(double ${value})`);
      B.terminate(`ret ptr ${boxed}`);
    } else if (arm.kind === "bool") {
      host.declare(`declare zeroext i1 @scr_union_get_bool(ptr)`);
      host.declare(`declare ptr @scr_dyn_new_bool(i1 zeroext)`);
      const value = B.tmp();
      const boxed = B.tmp();
      B.line(`${value} = call zeroext i1 @scr_union_get_bool(ptr %u)`);
      B.line(`${boxed} = call ptr @scr_dyn_new_bool(i1 ${value})`);
      B.terminate(`ret ptr ${boxed}`);
    } else {
      const payload = emitUnionPeek(B, nullable, "%u");
      const boxed = B.tmp();
      B.line(`${boxed} = call ptr @${host.dyn.toDynHelper(arm)}(ptr ${payload})`);
      B.terminate(`ret ptr ${boxed}`);
    }
  });
  B.startBlock(fallback);
  host.declare(`declare void @scr_trap(ptr)`);
  B.line(`call void @scr_trap(ptr ${host.cstr("scriptc: internal error: invalid union tag\n")})`);
  B.terminate(`unreachable`);
  host.resolveThunkDefs.push(
    `define internal ptr @${sym}(ptr %u) ${FN_ATTRS} { ; materialize live union value ${key}`,
    B.render(),
    `}`,
    ``,
  );
  host.journal?.built();
  return sym;
}

/** The raw ScrSym of a class's symbol field key into `%name`: a module
 * key is borrowed from its global, a well-known one comes from the
 * runtime's registry (+1, released by the `release` lines once the key
 * value holds it). */
function symbolKeyLines(
  host: LlvmEmitterContext,
  symbol: NonNullable<IrClassDef["symbolFields"]>[number],
  name: string,
): { load: string[]; release: string[] } {
  if ("globalId" in symbol)
    return { load: [`  %${name} = load ptr, ptr @${mangleGlobal(symbol.globalId)}`], release: [] };
  host.declare("declare ptr @scr_sym_well_known(ptr)");
  host.declare("declare void @scr_sym_release(ptr)");
  return {
    load: [
      `  %${name} = call ptr @scr_sym_well_known(ptr ${host.internLiteral(symbol.wellKnown)})`,
    ],
    release: [`  call void @scr_sym_release(ptr %${name})`],
  };
}

export function streamTypedRefBoxValue(
  host: LlvmEmitterContext,
  B: BlockBuilder,
  t: IrType,
  value: string,
): string {
  const boxed = B.tmp();
  if (
    t.kind === "union" &&
    (host.unionsById
      .get(t.unionId)
      ?.arms.some((arm) => streamTypedRefEligible(arm) || isDynTypedRefType(arm)) ??
      false)
  ) {
    B.line(`${boxed} = call ptr @${host.liveDynUnionRefAdapter(t)}(ptr ${value})`);
    return boxed;
  }
  // A codec record boxes as its own handle, by reference (toDynHelper), as
  // it does outside a live view.
  if (
    t.kind === "bytes" ||
    textCodecRecordClass(t, (id) => host.recordsById.get(id)) !== null ||
    (!streamTypedRefEligible(t) && !isDynTypedRefType(t))
  ) {
    const valueTy = host.llType(t);
    B.line(`${boxed} = call ptr @${host.dyn.toDynHelper(t)}(${valueTy} ${value})`);
    return boxed;
  }
  const nested = host.liveDynRefAdapter(t);
  const rc = vAdapters(host.shapeHost, t);
  const key = typeKey(t);

  B.line(
    `${boxed} = call ptr ${typedRefConstructor(host.shapeHost, t)}(ptr ${value}, ptr ${rc.retain}, ptr ${rc.release}, ptr ${host.cstr(key)}, ${host.sizeType} ${Buffer.byteLength(key, "utf8")}, ptr @${nested.snapshot}, ptr ${nested.commit})`,
  );
  for (const line of bindLiveArrayOps(host.shapeHost, nested, boxed)) B.line(line);
  return boxed;
}

export function streamTypedRefMaterializeAdapter(
  host: LlvmEmitterContext,
  t: IrType,
): LlStreamTypedRefAdapter {
  const key = typeKey(t);
  // A `(T | undefined)[]` stored as T elements shares T[]'s capsule type,
  // but its adapters also store undefined elements.
  const adapterKey = t.kind === "array" && t.optionalElements ? `${key}?` : key;
  const existing = host.liveDynRefAdapters.get(adapterKey);
  if (existing) return existing;
  // The converter depends only on the static type. Intern the complete
  // graph across roots and union arms so recursive types emit once.
  const snapshot = `sc_ldr_${host.liveDynRefAdapters.size}_materialize`;
  const adapter: LlStreamTypedRefAdapter = { snapshot, commit: "null" };
  host.liveDynRefAdapters.set(adapterKey, adapter);
  host.journal?.allocated(
    snapshot.replace(/_materialize$/, ""),
    "streamTypedRefMaterializeAdapter",
    [t],
  );
  if (isDynTypedRefType(t)) {
    const fields = host.classMeta.get(t.className)?.def.fields;
    if (
      fields &&
      !classDynViewSupported(
        fields,
        (id) => host.recordsById.get(id),
        (id) => host.unionsById.get(id),
      )
    ) {
      host.declare(`declare ptr @scr_dyn_class_view_unavailable(ptr)`);
      adapter.snapshot = "scr_dyn_class_view_unavailable";
      host.journal?.built();
      return adapter;
    }
  }
  // Publish both symbols before their bodies: class-array and callback
  // converters can request this same adapter while emitting the commit.
  // A recursive field type binds capsules of this class there too, so the
  // class view ops are published first.
  const opsMeta = isDynTypedRefType(t) ? host.classMeta.get(t.className) : undefined;
  if (opsMeta && liveClassOpsEligible(opsMeta)) adapter.classOps = `@${snapshot}_cops`;
  else if (opsMeta && liveBagClassOpsEligible(opsMeta)) adapter.bagClassOps = `@${snapshot}_bops`;
  adapter.commit = `@${snapshot}_commit`;
  adapter.commit = host.streamTypedRefCommitAdapter(t, snapshot);
  const B = new BlockBuilder();

  if (isDynTypedRefType(t)) {
    const meta = host.classMeta.get(t.className);
    if (!meta) {
      throw new InternalCompilerError(
        `llvm emitter bug: typed-ref materialize of unknown class ${t.className}`,
      );
    }
    if (adapter.classOps !== undefined) liveClassOps(host, snapshot, meta);
    if (adapter.bagClassOps !== undefined) liveBagClassOps(host, snapshot, meta, t);
    if (meta.hierarchy && meta.children.length) {
      const pre = B.tmp();
      for (const line of classPreLines(meta, classStructSym(t.className), "%p", pre, host.sizeType))
        B.line(line.trimStart());
      const descendants = (current: typeof meta): (typeof meta)[] =>
        current.children.flatMap((child) => [child, ...descendants(child)]);
      for (const child of descendants(meta).reverse()) {
        const childAdapter = host.liveDynRefAdapter({ kind: "object", className: child.def.name });
        const exact = B.tmp(),
          yes = B.newLabel("class.derived"),
          next = B.newLabel("class.next");
        B.line(`${exact} = icmp eq ${host.sizeType} ${pre}, ${child.pre}`);
        B.condBr(exact, yes, next);
        B.startBlock(yes);
        const result = B.tmp();
        B.line(`${result} = call ptr @${childAdapter.snapshot}(ptr %p)`);
        B.terminate(`ret ptr ${result}`);
        B.startBlock(next);
      }
    }
    host.declare(`declare ptr @scr_dyn_new_obj()`);
    host.declare(`declare void @scr_dyn_obj_set(ptr, ptr, ${host.sizeType}, ptr)`);
    const out = B.tmp();
    if (meta.root.def.name === "%Error") {
      host.declare(`declare ptr @scr_error_dyn_fields(ptr)`);
      B.line(`${out} = call ptr @scr_error_dyn_fields(ptr %p)`);
    } else if (
      ((meta.def.runtime && RUNTIME_STREAM_CLASSES.has(t.className)) || streamRooted(meta)) &&
      !meta.def.instancePrototypeHelper &&
      !meta.def.prototypeDataHelper
    ) {
      // Programs with constructor-function streams view them through
      // scr_dyn_builtin_stream.c, which answers their own objects.
      const view = host.usesDynBuiltinStream
        ? "scr_dyn_builtin_stream_view"
        : "scr_stream_dyn_view";
      host.declare(`declare ptr @${view}(ptr)`);
      B.line(`${out} = call ptr @${view}(ptr %p)`);
    } else B.line(`${out} = call ptr @scr_dyn_new_obj()`);
    const withAttributes = meta.def.fields.some((field) => field.name === CLASS_ATTRIBUTES);
    if (meta.def.tracksOwnFields) {
      host.declare(`declare ptr @scr_dyn_copy_property_descriptors(ptr, ptr)`);
      host.declare(`declare void @scr_dyn_release_v(ptr)`);
      const { index } = classFieldIndex(meta, DYN_CLASS_PROPERTIES);
      const slot = B.tmp(),
        bag = B.tmp(),
        copied = B.tmp();
      B.line(
        `${slot} = getelementptr inbounds %${classStructSym(t.className)}, ptr %p, i64 0, i32 ${index}`,
      );
      B.line(`${bag} = load ptr, ptr ${slot}`);
      B.line(`${copied} = call ptr @scr_dyn_copy_property_descriptors(ptr ${out}, ptr ${bag})`);
      B.line(`call void @scr_dyn_release_v(ptr ${copied})`);
    }
    if (meta.def.instancePrototypeHelper || meta.def.prototypeDataHelper) {
      host.declare(`declare ptr @scr_dyn_set_prototype(ptr, ptr)`);
      host.declare(`declare void @scr_dyn_release_v(ptr)`);
      const prototype = B.tmp(),
        attached = B.tmp();
      if (meta.def.instancePrototypeHelper) {
        const receiver = B.tmp();
        B.line(`${receiver} = call ptr ${vAdapters(host.shapeHost, t).retain}(ptr %p)`);
        B.line(
          `${prototype} = call ptr @${mangleFunction(meta.def.instancePrototypeHelper)}(ptr ${receiver})`,
        );
      } else B.line(`${prototype} = call ptr @${mangleFunction(meta.def.prototypeDataHelper!)}()`);
      B.line(`${attached} = call ptr @scr_dyn_set_prototype(ptr ${out}, ptr ${prototype})`);
      B.line(`call void @scr_dyn_release_v(ptr ${prototype})`);
      B.line(`call void @scr_dyn_release_v(ptr ${attached})`);
    }
    for (const field of classViewFields(meta)) {
      const afterField = meta.def.tracksOwnFields ? B.newLabel("field.after") : null;
      if (afterField) {
        host.declare(`declare ptr @scr_dyn_obj_get(ptr, ptr, ${host.sizeType})`);
        const value = B.tmp(),
          present = B.tmp(),
          yes = B.newLabel("field.present");
        B.line(
          `${value} = call ptr @scr_dyn_obj_get(ptr ${out}, ptr ${host.cstr(field.name)}, ${host.sizeType} ${Buffer.byteLength(field.name, "utf8")})`,
        );
        B.line(`${present} = icmp ne ptr ${value}, null`);
        B.condBr(present, yes, afterField);
        B.startBlock(yes);
      }
      const { boxed, nullable, fieldValue } = classFieldDynValue(host, B, meta, t, field);
      // Attributes copied from the bag do not stop the view taking the value.
      const setter = withAttributes ? "scr_dyn_obj_set_field" : "scr_dyn_obj_set";
      if (withAttributes)
        host.declare(`declare void @scr_dyn_obj_set_field(ptr, ptr, ${host.sizeType}, ptr)`);
      B.line(
        `call void @${setter}(ptr ${out}, ptr ${host.cstr(field.name)}, ${host.sizeType} ${Buffer.byteLength(field.name, "utf8")}, ptr ${boxed})`,
      );
      // A field redefined through Object.defineProperty keeps its attributes.
      const attributesField = classFieldAttributesName(field.name);
      if (meta.def.fields.some((f) => f.name === attributesField)) {
        host.declare(`declare void @scr_dyn_class_field_attributes(ptr, ptr, double)`);
        const slot = B.tmp(),
          bits = B.tmp();
        B.line(
          `${slot} = getelementptr inbounds %${classStructSym(t.className)}, ptr %p, i64 0, i32 ${classFieldIndex(meta, attributesField).index}`,
        );
        B.line(`${bits} = load double, ptr ${slot}`);
        B.line(
          `call void @scr_dyn_class_field_attributes(ptr ${out}, ptr ${host.internLiteral(field.name)}, double ${bits})`,
        );
      }
      if (nullable) {
        host.declare(`declare void @scr_union_release(ptr)`);
        B.line(`call void @scr_union_release(ptr ${fieldValue})`);
      }
      if (afterField) {
        B.br(afterField);
        B.startBlock(afterField);
      }
    }
    for (const symbol of meta.def.symbolFields ?? []) {
      const field = meta.def.fields.find((field) => field.name === symbol.field)!;
      const { index } = classFieldIndex(meta, symbol.field);
      const fieldPtr = B.tmp(),
        rawKey = B.tmp();
      let fieldValue = B.tmp();
      B.line(
        `${fieldPtr} = getelementptr inbounds %${classStructSym(t.className)}, ptr %p, i64 0, i32 ${index}`,
      );
      const inline = host.inlineUnions.classField(t.className, field.name);
      if (host.int32Slots.isField(t.className, field.name)) {
        const raw = B.tmp();
        B.line(`${raw} = load i32, ptr ${fieldPtr}`);
        B.line(`${fieldValue} = sitofp i32 ${raw} to double`);
      } else if (inline) fieldValue = loadStructField(B, host.sizeType, fieldPtr, field.type, true);
      else B.line(`${fieldValue} = load ${llFieldType(field.type, false)}, ptr ${fieldPtr}`);
      const keyLines = symbolKeyLines(host, symbol, rawKey.slice(1));
      for (const line of keyLines.load) B.line(line.trim());
      const key = host.streamTypedRefBoxValue(B, SYMBOL_T, rawKey);
      for (const line of keyLines.release) B.line(line.trim());
      const afterSymbol =
        meta.def.tracksOwnFields || field.type.kind === "symbol"
          ? B.newLabel("symbol.after")
          : null;
      if (afterSymbol) {
        const initialized = B.tmp(),
          present = B.newLabel("symbol.present");
        if (meta.def.tracksOwnFields) {
          host.declare(`declare zeroext i1 @scr_dyn_has_own_computed(ptr, ptr)`);
          B.line(
            `${initialized} = call zeroext i1 @scr_dyn_has_own_computed(ptr ${out}, ptr ${key})`,
          );
        } else B.line(`${initialized} = icmp ne ptr ${fieldValue}, null`);
        B.condBr(initialized, present, afterSymbol);
        B.startBlock(present);
      }
      if (llFieldType(field.type, false) === "i8") {
        const boolValue = B.tmp();
        B.line(`${boolValue} = trunc i8 ${fieldValue} to i1`);
        fieldValue = boolValue;
      }
      const symbolNullable = host.nullableFields.get(t.className, field.name);
      if (symbolNullable) fieldValue = nullableFieldUnion(host, B, fieldValue, symbolNullable);
      const value = host.streamTypedRefBoxValue(B, field.type, fieldValue);
      if (symbolNullable) {
        host.declare(`declare void @scr_union_release(ptr)`);
        B.line(`call void @scr_union_release(ptr ${fieldValue})`);
      }
      // As for string-keyed fields, attributes copied from the bag (a frozen
      // instance's) do not stop the view taking the value.
      const symbolSetter =
        meta.def.tracksOwnFields || withAttributes
          ? "scr_dyn_symbol_field_set"
          : "scr_dyn_symbol_key_set";
      host.declare(`declare void @${symbolSetter}(ptr, ptr, ptr)`);
      host.declare(`declare void @scr_dyn_release_v(ptr)`);
      B.line(`call void @${symbolSetter}(ptr ${out}, ptr ${key}, ptr ${value})`);
      B.line(`call void @scr_dyn_release_v(ptr ${value})`);
      if (afterSymbol) {
        B.terminate(`br label %${afterSymbol}`);
        B.startBlock(afterSymbol);
      }
      B.line(`call void @scr_dyn_release_v(ptr ${key})`);
    }
    if (
      !meta.def.tracksOwnFields &&
      meta.def.fields.some((field) => field.name === DYN_CLASS_PROPERTIES)
    ) {
      host.declare(`declare ptr @scr_dyn_copy_property_descriptors(ptr, ptr)`);
      host.declare(`declare void @scr_dyn_release_v(ptr)`);
      const { index } = classFieldIndex(meta, DYN_CLASS_PROPERTIES);
      const slot = B.tmp(),
        bag = B.tmp(),
        copied = B.tmp();
      B.line(
        `${slot} = getelementptr inbounds %${classStructSym(t.className)}, ptr %p, i64 0, i32 ${index}`,
      );
      B.line(`${bag} = load ptr, ptr ${slot}`);
      B.line(`${copied} = call ptr @scr_dyn_copy_property_descriptors(ptr ${out}, ptr ${bag})`);
      B.line(`call void @scr_dyn_release_v(ptr ${copied})`);
    }
    // An Error subclass instance's own `name` sits where its class's
    // construction creates it: after a field, or after every other
    // property when no constructor sets it.
    const nameAfter = meta.def.errorNameAfter;
    if (meta.root.def.name === "%Error" && !meta.def.runtime && nameAfter !== null) {
      host.declare(`declare void @scr_error_dyn_place_name(ptr, ptr, ${host.sizeType})`);
      B.line(
        nameAfter === undefined
          ? `call void @scr_error_dyn_place_name(ptr ${out}, ptr null, ${host.sizeType} 0)`
          : `call void @scr_error_dyn_place_name(ptr ${out}, ptr ${host.cstr(nameAfter)}, ${host.sizeType} ${Buffer.byteLength(nameAfter, "utf8")})`,
      );
    }
    // A JavaScript Error subclass's property bag records, once a dynamic
    // write has committed the view, where `name` and `message` were created
    // (zod's error factory assigns `name` before it defines `message`); the
    // slots hold their values. A `name` the class's construction sets is
    // already where errorNameAfter places it among the fields.
    if (
      meta.def.errorBagOrder &&
      meta.root.def.name === "%Error" &&
      meta.def.fields.some((field) => field.name === DYN_CLASS_PROPERTIES)
    ) {
      host.declare(`declare void @scr_error_dyn_follow_bag(ptr, ptr, ptr, i1)`);
      const { index } = classFieldIndex(meta, DYN_CLASS_PROPERTIES);
      const slot = B.tmp(),
        bag = B.tmp();
      B.line(
        `${slot} = getelementptr inbounds %${classStructSym(t.className)}, ptr %p, i64 0, i32 ${index}`,
      );
      B.line(`${bag} = load ptr, ptr ${slot}`);
      B.line(
        `call void @scr_error_dyn_follow_bag(ptr ${out}, ptr ${bag}, ptr %p, i1 ${nameAfter === undefined ? "false" : "true"})`,
      );
    }
    // A frozen, sealed or non-extensible instance's view says so.
    if (withAttributes) {
      host.declare(`declare void @scr_dyn_class_view_attributes(ptr, double)`);
      const slot = B.tmp(),
        bits = B.tmp();
      B.line(
        `${slot} = getelementptr inbounds %${classStructSym(t.className)}, ptr %p, i64 0, i32 ${classFieldIndex(meta, CLASS_ATTRIBUTES).index}`,
      );
      B.line(`${bits} = load double, ptr ${slot}`);
      B.line(`call void @scr_dyn_class_view_attributes(ptr ${out}, double ${bits})`);
    }
    B.terminate(`ret ptr ${out}`);
  } else if (t.kind === "record") {
    const shape = host.recordsById.get(t.shapeId);
    if (!shape) {
      throw new InternalCompilerError(
        `llvm emitter bug: stream typed-ref materialize of unknown shape ${t.shapeId}`,
      );
    }
    /* Keep the ordinary converter for index-signature/listener records;
     * their source-identity and overflow walks have extra contracts.
     * Declared-field records and tuples cover the live stream values. */
    const ordinary =
      shape.indexValue ||
      shapeHasAccessorSlots(shape) ||
      shape.fields.some((field) => field.name === "handleEvent" && field.type.kind === "func");
    if (ordinary) {
      const out = B.tmp();
      B.line(`${out} = call ptr @${host.dyn.toDynHelper(t)}(ptr %p)`);
      B.terminate(`ret ptr ${out}`);
    } else if (shape.tuple) {
      host.declare(`declare ptr @scr_dyn_new_arr()`);
      host.declare(`declare void @scr_dyn_arr_push(ptr, ptr)`);
      const out = B.tmp();
      B.line(`${out} = call ptr @scr_dyn_new_arr()`);
      const fields = [...shape.fields].sort((a, b) => Number(a.name) - Number(b.name));
      for (const field of fields) {
        const index = shape.fields.indexOf(field) + host.nullableUnions.fieldBase(t.shapeId);
        const fieldPtr = B.tmp();
        B.line(
          `${fieldPtr} = getelementptr inbounds %${mangleRecordStruct(t.shapeId)}, ptr %p, i64 0, i32 ${index}`,
        );
        const fieldValue = loadStructField(
          B,
          host.sizeType,
          fieldPtr,
          field.type,
          host.inlineUnions.record(field.type),
        );
        const boxed = host.streamTypedRefBoxValue(B, field.type, fieldValue);
        B.line(`call void @scr_dyn_arr_push(ptr ${out}, ptr ${boxed})`);
      }
      B.terminate(`ret ptr ${out}`);
    } else {
      host.declare(`declare ptr @scr_dyn_new_obj()`);
      host.declare(`declare void @scr_dyn_obj_set(ptr, ptr, ${host.sizeType}, ptr)`);
      const out = B.tmp();
      B.line(`${out} = call ptr @scr_dyn_new_obj()`);
      const byName = new Map(shape.fields.map((field) => [field.name, field]));
      // A shape with orderVariants has one field list per key order; its
      // order index is no key.
      const orders = shapeKeyOrders(shape);
      const fieldsOf = (order: readonly string[]): IrRecordShape["fields"][number][] => {
        const inOrder = new Set(order);
        return [
          ...order.map((name) => byName.get(name)).filter((field) => field !== undefined),
          ...shape.fields.filter(
            (field) => !inOrder.has(field.name) && field.name !== KEY_ORDER_FIELD,
          ),
        ];
      };
      // Published before the field converters, like the array hooks below.
      // A Dirent row reads through its finished view (the prototype and
      // the non-enumerable %dtype).
      const dirent = isDirentShape(shape);
      if (!dirent && orders.every((order) => liveRecordOpsEligible(fieldsOf(order)))) {
        if (orders.length === 1) {
          adapter.recordOps = `@${snapshot}_rops`;
          liveRecordOps(host, t, snapshot, fieldsOf(orders[0]!));
        } else {
          orders.forEach((order, i) =>
            liveRecordOps(host, t, `${snapshot}_o${i}`, fieldsOf(order)),
          );
          adapter.recordOps = `@${snapshot}_rops`;
          liveRecordOrderSelect(host, shape, snapshot);
        }
      }
      emitPerKeyOrder(B, shape, host.nullableUnions.fieldBase(t.shapeId), "%p", (order) => {
        for (const field of fieldsOf(order)) {
          const index = shape.fields.indexOf(field) + host.nullableUnions.fieldBase(t.shapeId);
          const fieldPtr = B.tmp();
          B.line(
            `${fieldPtr} = getelementptr inbounds %${mangleRecordStruct(t.shapeId)}, ptr %p, i64 0, i32 ${index}`,
          );
          const fieldValue = loadStructField(
            B,
            host.sizeType,
            fieldPtr,
            field.type,
            host.inlineUnions.record(field.type),
          );
          // An ABSENT optional field contributes no key.
          const undefinedTag = undefinedArmTag(field.type, host.unionsById);
          let skip: string | null = null;
          if (undefinedTag >= 0 && field.type.kind === "union") {
            const absent = host.fieldAbsentTestIn(B, fieldValue, field.type.unionId);
            skip = B.newLabel("live.record.absent");
            const set = B.newLabel("live.record.set");
            B.condBr(absent, skip, set);
            B.startBlock(set);
          }
          const boxed = host.streamTypedRefBoxValue(B, field.type, fieldValue);
          B.line(
            `call void @scr_dyn_obj_set(ptr ${out}, ptr ${host.cstr(field.name)}, ${host.sizeType} ${Buffer.byteLength(field.name, "utf8")}, ptr ${boxed})`,
          );
          if (skip !== null) {
            B.br(skip);
            B.startBlock(skip);
          }
        }
      });
      if (dirent) {
        host.declare(`declare void @scr_dyn_dirent_finish(ptr)`);
        B.line(`call void @scr_dyn_dirent_finish(ptr ${out})`);
      }
      B.terminate(`ret ptr ${out}`);
    }
  } else if (t.kind === "array") {
    const elem = t.elem;
    // Published before the element converters: a recursive element type
    // can box this same array type while the bodies below are emitted.
    adapter.arrayOps = `@${snapshot}_ops`;
    host.declare(`declare ptr @scr_dyn_new_arr()`);
    host.declare(`declare void @scr_dyn_arr_push(ptr, ptr)`);
    host.declare(`declare double @scr_arr_len(ptr)`);
    const out = B.tmp();
    B.line(`${out} = call ptr @scr_dyn_new_arr()`);
    const len = B.tmp();
    B.line(`${len} = call double @scr_arr_len(ptr %p)`);
    B.countedLoop(len, (index) => {
      host.declare(`declare double @scr_arr_state(ptr, double)`);
      host.declare(`declare ptr @scr_dyn_undefined()`);
      host.declare(`declare ptr @scr_dyn_retain_v(ptr)`);
      const state = B.tmp();
      const present = B.tmp();
      const valueLabel = B.newLabel("live.array.value");
      const absentLabel = B.newLabel("live.array.absent");
      const holeLabel = B.newLabel("live.array.hole");
      const undefinedLabel = B.newLabel("live.array.undefined");
      const doneLabel = B.newLabel("live.array.done");
      B.line(`${state} = call double @scr_arr_state(ptr %p, double ${index})`);
      B.line(`${present} = fcmp oeq double ${state}, 1.0`); // SCR_ARR_VALUE
      B.condBr(present, valueLabel, absentLabel);
      B.startBlock(absentLabel);
      const hole = B.tmp();
      B.line(`${hole} = fcmp oeq double ${state}, 0.0`); // SCR_ARR_HOLE
      B.condBr(hole, holeLabel, undefinedLabel);
      B.startBlock(holeLabel);
      host.declare(`declare void @scr_dyn_arr_push_hole(ptr)`);
      B.line(`call void @scr_dyn_arr_push_hole(ptr ${out})`);
      B.br(doneLabel);
      B.startBlock(undefinedLabel);
      if (host.mayHoldForeign(elem)) {
        // A foreign element (SCR_ARR_FOREIGN) holds its own value.
        const foreign = B.tmp();
        const foreignLabel = B.newLabel("live.array.foreign");
        const presentUndefined = B.newLabel("live.array.present.undefined");
        B.line(`${foreign} = fcmp oeq double ${state}, 3.0`);
        B.condBr(foreign, foreignLabel, presentUndefined);
        B.startBlock(foreignLabel);
        host.declare(`declare ptr @scr_arr_get_foreign(ptr, double)`);
        const payload = B.tmp();
        B.line(`${payload} = call ptr @scr_arr_get_foreign(ptr %p, double ${index}) ; +1`);
        B.line(`call void @scr_dyn_arr_push(ptr ${out}, ptr ${payload})`);
        B.br(doneLabel);
        B.startBlock(presentUndefined);
      }
      const undefinedValue = B.tmp();
      const retained = B.tmp();
      B.line(`${undefinedValue} = call ptr @scr_dyn_undefined()`);
      B.line(`${retained} = call ptr @scr_dyn_retain_v(ptr ${undefinedValue})`);
      B.line(`call void @scr_dyn_arr_push(ptr ${out}, ptr ${retained})`);
      B.br(doneLabel);
      B.startBlock(valueLabel);
      let value: string;
      if (elem.kind === "f64" || elem.kind === "bool") {
        const valueTy = elem.kind === "f64" ? "double" : "i1";
        host.declare(
          `declare ${elem.kind === "bool" ? "zeroext i1" : valueTy} @scr_arr_get_${elem.kind}(ptr, double)`,
        );
        value = B.tmp();
        B.line(`${value} = call ${valueTy} @scr_arr_get_${elem.kind}(ptr %p, double ${index})`);
      } else {
        host.declare(`declare ptr @scr_arr_get_ref(ptr, double)`);
        value = B.tmp();
        B.line(`${value} = call ptr @scr_arr_get_ref(ptr %p, double ${index}) ; +1`);
      }
      const boxed = host.streamTypedRefBoxValue(B, elem, value);
      B.line(`call void @scr_dyn_arr_push(ptr ${out}, ptr ${boxed})`);
      if (isRefCounted(elem)) {
        B.line(`call void ${releaseSym(host.shapeHost, elem)}(ptr ${value})`);
      }
      B.br(doneLabel);
      B.startBlock(doneLabel);
    });
    host.declare(`declare void @scr_arr_copy_metadata(ptr, ptr)`);
    B.line(`call void @scr_arr_copy_metadata(ptr %p, ptr ${out})`);
    B.terminate(`ret ptr ${out}`);
    liveArrayOps(host, t, snapshot);
  } else {
    const out = B.tmp();
    B.line(`${out} = call ptr @${host.dyn.toDynHelper(t)}(ptr %p)`);
    B.terminate(`ret ptr ${out}`);
  }

  host.resolveThunkDefs.push(
    `define internal ptr @${snapshot}(ptr %p) ${FN_ATTRS} { ; materialize live stream value ${key}`,
    B.render(),
    `}`,
    ``,
  );
  host.journal?.built();
  return adapter;
}

/** Per-element hooks for a live array capsule (ScrDynTypedArrayOps). The
 * runtime answers presence and length from the native array and calls these
 * to convert exactly one element, so `xs[i]`, `xs[i] = v`, `i in xs`, and
 * iteration on a live array do not rebuild the whole snapshot per access.
 * `get` boxes an element exactly like one step of the snapshot loop; `set`
 * stores only values the element type accepts and otherwise reports false
 * without side effects, leaving the snapshot path to raise its diagnostic. */
function liveArrayOps(
  host: LlvmEmitterContext,
  t: IrType & { kind: "array" },
  snapshot: string,
): void {
  const elem = t.elem;
  const acc = elemAccess(elem);
  const valueTy = acc === "f64" ? "double" : acc === "bool" ? "i1" : "ptr";
  const get = `${snapshot}_get`;
  const set = `${snapshot}_set`;
  const ops = `${snapshot}_ops`;

  const G = new BlockBuilder();
  const value = G.tmp();
  host.declare(
    `declare ${acc === "bool" ? "zeroext i1" : valueTy} @scr_arr_get_${acc}(ptr, double)`,
  );
  G.line(
    `${value} = call ${valueTy} @scr_arr_get_${acc}(ptr %p, double %i)${acc === "ref" ? " ; +1" : ""}`,
  );
  const boxed = host.streamTypedRefBoxValue(G, elem, value);
  if (isRefCounted(elem)) G.line(`call void ${releaseSym(host.shapeHost, elem)}(ptr ${value})`);
  G.terminate(`ret ptr ${boxed}`);

  const S = new BlockBuilder();
  if (t.optionalElements) {
    // A `(T | undefined)[]` stores undefined as a present undefined.
    const undef = host.dyn.isUndefined(S, "%v");
    const storeUndefined = S.newLabel("live.array.undefined");
    const other = S.newLabel("live.array.value");
    S.condBr(undef, storeUndefined, other);
    S.startBlock(storeUndefined);
    host.declare(`declare void @scr_arr_set_undefined(ptr, double)`);
    S.line(`call void @scr_arr_set_undefined(ptr %p, double %i)`);
    S.terminate(`ret i1 true`);
    S.startBlock(other);
  }
  const fits = S.tmp();
  S.line(`${fits} = call zeroext i1 @${host.dyn.dynMatchHelper(elem)}(ptr %v)`);
  const store = S.newLabel("live.array.store");
  const refuse = S.newLabel("live.array.refuse");
  S.condBr(fits, store, refuse);
  S.startBlock(refuse);
  if (host.mayHoldForeign(elem)) {
    // The array keeps a value its element type cannot hold as a foreign
    // element, and undefined as a present undefined.
    host.declare(`declare zeroext i1 @scr_arr_set_foreign(ptr, double, ptr)`);
    const kept = S.tmp();
    S.line(`${kept} = call zeroext i1 @scr_arr_set_foreign(ptr %p, double %i, ptr %v)`);
    S.terminate(`ret i1 ${kept}`);
  } else {
    S.terminate(`ret i1 false`);
  }
  S.startBlock(store);
  const next = S.tmp();
  S.line(
    `${next} = call ${acc === "bool" ? "zeroext " : ""}${valueTy} @${host.dyn.dynCheckHelper(elem)}(ptr %v, ptr null)`,
  );
  // A conversion that throws (an accessor on a plain object, say) has
  // already raised the write's error; report it as handled.
  const pending = S.tmp();
  for (const line of host.pendingTestLines(pending)) S.line(line.trimStart());
  const write = S.newLabel("live.array.write");
  const failed = S.newLabel("live.array.failed");
  S.condBr(pending, failed, write);
  S.startBlock(failed);
  S.terminate(`ret i1 true`);
  S.startBlock(write);
  host.declare(
    `declare void @scr_arr_set_${acc}(ptr, double, ${acc === "bool" ? "i1 zeroext" : valueTy})`,
  );
  S.line(`call void @scr_arr_set_${acc}(ptr %p, double %i, ${valueTy} ${next}) ; takes ownership`);
  S.terminate(`ret i1 true`);

  host.resolveThunkDefs.push(
    `define internal ptr @${get}(ptr %p, double %i) ${FN_ATTRS} { ; live element of ${typeKey(t)}`,
    G.render(),
    `}`,
    ``,
    `define internal zeroext i1 @${set}(ptr %p, double %i, ptr %v) ${FN_ATTRS} { ; live element store into ${typeKey(t)}`,
    S.render(),
    `}`,
    ``,
    `@${ops} = internal constant { ptr, ptr } { ptr @${get}, ptr @${set} }`,
    ``,
  );
}

/** Field names whose snapshot order is not JS own-key order (array-index
 * spellings sort first) or that an object literal cannot own as data
 * (`__proto__`) keep every operation on the snapshot. */
function liveRecordOpsEligible(fields: readonly { name: string }[]): boolean {
  return fields.every(
    (field) => field.name !== "__proto__" && !/^(?:0|[1-9][0-9]*)$/.test(field.name),
  );
}

/** Per-field hooks for a live record capsule (ScrDynTypedRecordOps). The
 * runtime answers keyed reads, presence and key walks of a capsule whose
 * checked view was never created from the native record: `has` applies the
 * snapshot's absent-optional-field rule and `get` boxes one field exactly
 * like the snapshot does, so a walk over the record as `unknown` converts
 * only the fields it reads instead of rebuilding the whole object per
 * access. `fields` is the snapshot's definition order. */
function liveRecordOps(
  host: LlvmEmitterContext,
  t: IrType & { kind: "record" },
  snapshot: string,
  fields: readonly IrRecordShape["fields"][number][],
): void {
  const shape = host.recordsById.get(t.shapeId)!;
  const struct = mangleRecordStruct(t.shapeId);
  const has = `${snapshot}_has`;
  const get = `${snapshot}_get`;
  const names = `${snapshot}_names`;
  const ops = `${snapshot}_rops`;
  const loadField = (B: BlockBuilder, field: IrRecordShape["fields"][number]): string => {
    const index = shape.fields.indexOf(field) + host.nullableUnions.fieldBase(t.shapeId);
    const fieldPtr = B.tmp();
    B.line(`${fieldPtr} = getelementptr inbounds %${struct}, ptr %p, i64 0, i32 ${index}`);
    return loadStructField(
      B,
      host.sizeType,
      fieldPtr,
      field.type,
      host.inlineUnions.record(field.type),
    );
  };

  const H = new BlockBuilder();
  const optional = fields
    .map((field, position) => ({ field, position }))
    .filter(
      ({ field }) =>
        field.type.kind === "union" && undefinedArmTag(field.type, host.unionsById) >= 0,
    );
  const hasLabels = optional.map(() => H.newLabel("live.record.has"));
  const always = H.newLabel("live.record.always");
  H.terminate(
    `switch ${host.sizeType} %i, label %${always} [ ${optional
      .map(({ position }, k) => `${host.sizeType} ${position}, label %${hasLabels[k]}`)
      .join(" ")} ]`,
  );
  optional.forEach(({ field }, k) => {
    H.startBlock(hasLabels[k]!);
    const value = loadField(H, field);
    const absent = host.fieldAbsentTestIn(
      H,
      value,
      (field.type as IrType & { kind: "union" }).unionId,
    );
    const present = H.tmp();
    H.line(`${present} = xor i1 ${absent}, true`);
    H.terminate(`ret i1 ${present}`);
  });
  H.startBlock(always);
  H.terminate(`ret i1 true`);

  const G = new BlockBuilder();
  const getLabels = fields.map(() => G.newLabel("live.record.get"));
  const bad = G.newLabel("live.record.bad");
  G.terminate(
    `switch ${host.sizeType} %i, label %${bad} [ ${fields
      .map((_, position) => `${host.sizeType} ${position}, label %${getLabels[position]}`)
      .join(" ")} ]`,
  );
  fields.forEach((field, position) => {
    G.startBlock(getLabels[position]!);
    const value = loadField(G, field);
    const boxed = host.streamTypedRefBoxValue(G, field.type, value);
    G.terminate(`ret ptr ${boxed}`);
  });
  G.startBlock(bad);
  G.terminate(`unreachable`);

  // Only a program that writes through a dynamic view needs the store
  // hook (and its checked conversions), as for the commit adapter.
  const setDefs = host.liveViewsReadOnly ? [] : liveRecordSet(host, t, `${snapshot}_set`, fields);

  const literals = fields.map((field) => `ptr ${host.internLiteral(field.name)}`);
  host.resolveThunkDefs.push(
    `define internal zeroext i1 @${has}(ptr %p, ${host.sizeType} %i) ${FN_ATTRS} { ; live field presence of ${typeKey(t)}`,
    H.render(),
    `}`,
    ``,
    `define internal ptr @${get}(ptr %p, ${host.sizeType} %i) ${FN_ATTRS} { ; live field of ${typeKey(t)}`,
    G.render(),
    `}`,
    ``,
    ...setDefs,
    `@${names} = internal constant [${fields.length} x ptr] [${literals.join(", ")}]`,
    // Mutable: the runtime fills the key-array slot on first use.
    `@${ops} = internal global { ${host.sizeType}, ptr, ptr, ptr, i8, ptr, ptr, ptr } { ${host.sizeType} ${fields.length}, ptr @${names}, ptr @${has}, ptr @${get}, i8 ${optional.length === 0 ? 1 : 0}, ptr null, ptr null, ptr ${setDefs.length ? `@${snapshot}_set` : "null"} }`,
    ``,
  );
}

/** The `set` hook of a live record's ops table: stores a dynamic write of
 * present field `index` into the native record in place, so the capsule
 * never becomes a snapshot for it. A value the field type does not accept
 * answers false with no side effects, leaving the snapshot path to raise
 * the commit's diagnostic; an inline union field always does. */
function liveRecordSet(
  host: LlvmEmitterContext,
  t: IrType & { kind: "record" },
  sym: string,
  fields: readonly IrRecordShape["fields"][number][],
): string[] {
  const shape = host.recordsById.get(t.shapeId)!;
  const struct = mangleRecordStruct(t.shapeId);
  const S = new BlockBuilder();
  const labels = fields.map(() => S.newLabel("live.record.store"));
  const refuse = S.newLabel("live.record.refuse");
  S.terminate(
    `switch ${host.sizeType} %i, label %${refuse} [ ${fields
      .map((_, position) => `${host.sizeType} ${position}, label %${labels[position]}`)
      .join(" ")} ]`,
  );
  fields.forEach((field, position) => {
    S.startBlock(labels[position]!);
    const inline = host.inlineUnions.record(field.type);
    if (inline) {
      S.br(refuse);
      return;
    }
    const fits = S.tmp();
    S.line(`${fits} = call zeroext i1 @${host.dyn.dynMatchHelper(field.type)}(ptr %v)`);
    const check = S.newLabel("live.record.check");
    S.condBr(fits, check, refuse);
    S.startBlock(check);
    const valueTy = host.llType(field.type);
    const next = S.tmp();
    S.line(
      `${next} = call ${valueTy === "i1" ? "zeroext " : ""}${valueTy} @${host.dyn.dynCheckHelper(field.type)}(ptr %v, ptr null)`,
    );
    // A conversion that throws has already raised the write's error.
    const pending = S.tmp();
    for (const line of host.pendingTestLines(pending)) S.line(line.trimStart());
    const write = S.newLabel("live.record.write");
    const done = S.newLabel("live.record.done");
    S.condBr(pending, done, write);
    S.startBlock(write);
    const index = shape.fields.indexOf(field) + host.nullableUnions.fieldBase(t.shapeId);
    const fieldPtr = S.tmp();
    S.line(`${fieldPtr} = getelementptr inbounds %${struct}, ptr %p, i64 0, i32 ${index}`);
    const fieldTy = llFieldType(field.type, false);
    let stored = next;
    if (fieldTy === "i8") {
      stored = S.tmp();
      S.line(`${stored} = zext i1 ${next} to i8`);
    }
    if (isRefCounted(field.type)) {
      const old = S.tmp();
      S.line(`${old} = load ptr, ptr ${fieldPtr}`);
      S.line(`store ptr ${stored}, ptr ${fieldPtr} ; takes ownership`);
      S.line(`call void ${releaseSym(host.shapeHost, field.type)}(ptr ${old})`);
    } else {
      S.line(`store ${fieldTy} ${stored}, ptr ${fieldPtr}`);
    }
    S.br(done);
    S.startBlock(done);
    S.terminate(`ret i1 true`);
  });
  S.startBlock(refuse);
  S.terminate(`ret i1 false`);
  return [
    `define internal zeroext i1 @${sym}(ptr %p, ${host.sizeType} %i, ptr %v) ${FN_ATTRS} { ; live field store into ${typeKey(t)}`,
    S.render(),
    `}`,
    ``,
  ];
}

/** `@<snapshot>_rops` for a shape with orderVariants: a record-ops table
 * whose `select` hook answers the `_o<i>_rops` table (liveRecordOps) of the
 * record's current key order, which a write of an optional key can change
 * after the record is boxed. */
function liveRecordOrderSelect(
  host: LlvmEmitterContext,
  shape: IrRecordShape,
  snapshot: string,
): void {
  const B = new BlockBuilder();
  const out = B.slot();
  B.entryAllocas.push(`${out} = alloca ptr`);
  emitPerKeyOrder(B, shape, host.nullableUnions.fieldBase(shape.id), "%p", (_, i) => {
    B.line(`store ptr @${snapshot}_o${i}_rops, ptr ${out}`);
  });
  const ops = B.tmp();
  B.line(`${ops} = load ptr, ptr ${out}`);
  B.terminate(`ret ptr ${ops}`);
  host.resolveThunkDefs.push(
    `define internal ptr @${snapshot}_select(ptr %p) ${FN_ATTRS} { ; live record ops by key order`,
    B.render(),
    `}`,
    ``,
    `@${snapshot}_rops = internal global { ${host.sizeType}, ptr, ptr, ptr, i8, ptr, ptr, ptr } { ${host.sizeType} 0, ptr null, ptr null, ptr null, i8 0, ptr null, ptr @${snapshot}_select, ptr null }`,
    ``,
  );
}

/** Compiled classes whose instance views have no prototype object. Runtime
 * classes and JavaScript classes with prototype data answer through their
 * own views. */
function liveClassOpsEligible(meta: LlClassMeta): boolean {
  return (
    !meta.def.runtime &&
    !meta.root.def.runtime &&
    !meta.def.prototypeDataHelper &&
    !meta.def.instancePrototypeHelper
  );
}

/** The prototype member names of a class instance capsule
 * (ScrDynTypedClassOps): the class's and its bases' methods and accessors,
 * plus `constructor`. A hierarchy's table resolves the instance's exact
 * class first, like the materializer, since an instance seen through a base
 * type still has its own class's prototype. */
function liveClassOps(host: LlvmEmitterContext, snapshot: string, meta: LlClassMeta): void {
  const ops = `${snapshot}_cops`;
  const names = `${snapshot}_cnames`;
  const members = ["constructor"];
  for (let current: LlClassMeta | null = meta; current; current = current.base) {
    for (const name of current.def.prototypeNames ?? []) {
      if (!members.includes(name)) members.push(name);
    }
  }
  const literals = members.map((name) => `ptr ${host.internLiteral(name)}`);
  const descendants = (current: LlClassMeta): LlClassMeta[] =>
    current.children.flatMap((child) => [child, ...descendants(child)]);
  const subclasses = meta.hierarchy ? descendants(meta).filter(liveClassOpsEligible) : [];
  let exact = "null";
  if (subclasses.length > 0) {
    exact = `@${snapshot}_cexact`;
    const B = new BlockBuilder();
    const pre = B.tmp();
    for (const line of classPreLines(meta, classStructSym(meta.def.name), "%p", pre, host.sizeType))
      B.line(line.trimStart());
    for (const child of subclasses.reverse()) {
      const childAdapter = host.liveDynRefAdapter({ kind: "object", className: child.def.name });
      const match = B.tmp(),
        yes = B.newLabel("class.ops.derived"),
        next = B.newLabel("class.ops.next");
      B.line(`${match} = icmp eq ${host.sizeType} ${pre}, ${child.pre}`);
      B.condBr(match, yes, next);
      B.startBlock(yes);
      B.terminate(`ret ptr ${childAdapter.classOps ?? `@${ops}`}`);
      B.startBlock(next);
    }
    B.terminate(`ret ptr @${ops}`);
    host.resolveThunkDefs.push(
      `define internal ptr ${exact}(ptr %p) ${FN_ATTRS} { ; exact class members of ${meta.def.name}`,
      B.render(),
      `}`,
      ``,
    );
  }
  // The constructor's name, as util.inspect prints before the fields.
  const jsName = meta.def.jsName ?? meta.def.name.replace(/^%/, "");
  const className = jsName === "" ? "null" : host.internLiteral(jsName);
  // Its Symbol.toStringTag getter's string, for Object.prototype.toString
  // and util.inspect.
  let stringTag = "null";
  if (meta.def.stringTagHelper) {
    // The runtime lends the instance; the helper takes its own reference.
    stringTag = `@${snapshot}_ctag`;
    const retain = vAdapters(host.shapeHost, { kind: "object", className: meta.def.name }).retain;
    host.resolveThunkDefs.push(
      `define internal ptr ${stringTag}(ptr %p) ${FN_ATTRS} { ; Symbol.toStringTag of ${meta.def.name}`,
      `entry:`,
      `  %owned = call ptr ${retain}(ptr %p)`,
      `  %tag = call ptr @${mangleFunction(meta.def.stringTagHelper)}(ptr %owned)`,
      `  ret ptr %tag`,
      `}`,
      ``,
    );
  }
  host.resolveThunkDefs.push(
    `@${names} = internal constant [${members.length} x ptr] [${literals.join(", ")}]`,
    `@${ops} = internal constant { ptr, ${host.sizeType}, ptr, ptr, ptr } { ptr ${exact}, ${host.sizeType} ${members.length}, ptr @${names}, ptr ${className}, ptr ${stringTag} }`,
    ``,
  );
}

/** The checked-dynamic value a class instance's view holds for `field`, read
 * from its native slot of `%p`: `boxed` (+1), and the nullable union
 * `fieldValue` the caller releases when `nullable` is set. */
function classFieldDynValue(
  host: LlvmEmitterContext,
  B: BlockBuilder,
  meta: LlClassMeta,
  t: Extract<IrType, { kind: "object" }>,
  field: LlClassMeta["def"]["fields"][number],
): { boxed: string; nullable: NullableRefField | null; fieldValue: string } {
  const { index, compressed } = classFieldIndex(meta, field.name, "compressed");
  const fieldPtr = B.tmp();
  let fieldValue = B.tmp();
  B.line(
    `${fieldPtr} = getelementptr inbounds %${classStructSym(t.className)}, ptr %p, i64 0, i32 ${index}`,
  );
  if (host.int32Slots.isField(t.className, field.name)) {
    const raw = B.tmp();
    B.line(`${raw} = load i32, ptr ${fieldPtr}`);
    B.line(`${fieldValue} = sitofp i32 ${raw} to double`);
  } else if (host.inlineUnions.classField(t.className, field.name))
    fieldValue = loadStructField(B, host.sizeType, fieldPtr, field.type, true);
  else if (compressed) {
    const idx = B.tmp();
    B.line(`${idx} = load i32, ptr ${fieldPtr}`);
    for (const line of compactRefLoadLines(idx, fieldValue, `${fieldValue}.r`))
      B.line(line.trimStart());
  } else B.line(`${fieldValue} = load ${llFieldType(field.type, false)}, ptr ${fieldPtr}`);
  if (llFieldType(field.type, false) === "i8") {
    const boolValue = B.tmp();
    B.line(`${boolValue} = trunc i8 ${fieldValue} to i1`);
    fieldValue = boolValue;
  }
  const nullable = host.nullableFields.get(t.className, field.name);
  if (nullable) fieldValue = nullableFieldUnion(host, B, fieldValue, nullable);
  return { boxed: host.streamTypedRefBoxValue(B, field.type, fieldValue), nullable, fieldValue };
}

/** The fields an instance's view takes from their native slots, in order:
 * its own enumerable fields, except an Error's message and name. */
function classViewFields(meta: LlClassMeta): LlClassMeta["def"]["fields"] {
  return meta.def.fields.filter(
    (f) =>
      isClassOwnEnumerableFieldName(f.name) &&
      !(meta.root.def.name === "%Error" && (f.name === "message" || f.name === "name")),
  );
}

/** Classes whose instance views the materializer builds from the property
 * bag and the prototype data alone (see liveBagClassOps): JavaScript classes
 * tracking their own fields, outside the Error and runtime families, with no
 * subclass whose view another materializer builds. */
function liveBagClassOpsEligible(meta: LlClassMeta): boolean {
  return (
    meta.def.tracksOwnFields === true &&
    (meta.def.prototypeDataHelper !== undefined ||
      meta.def.instancePrototypeHelper !== undefined) &&
    !meta.def.runtime &&
    !meta.root.def.runtime &&
    meta.root.def.name !== "%Error" &&
    !(meta.hierarchy && meta.children.length > 0) &&
    meta.def.fields.some((field) => field.name === DYN_CLASS_PROPERTIES) &&
    !meta.def.fields.some(
      (field) =>
        field.name === CLASS_ATTRIBUTES ||
        meta.def.fields.some((f) => f.name === classFieldAttributesName(field.name)),
    )
  );
}

/** The hooks of a bag-tracked class instance capsule
 * (ScrDynTypedBagClassOps). The materializer gives the instance's view
 * exactly the bag's string-keyed properties, the values of the declared
 * fields among them from their native slots, and the prototype these hooks
 * return, so a method call resolves without building the view. */
function liveBagClassOps(
  host: LlvmEmitterContext,
  snapshot: string,
  meta: LlClassMeta,
  t: Extract<IrType, { kind: "object" }>,
): void {
  const struct = classStructSym(t.className);
  const bag = new BlockBuilder();
  const slot = bag.tmp(),
    value = bag.tmp();
  bag.line(
    `${slot} = getelementptr inbounds %${struct}, ptr %p, i64 0, i32 ${classFieldIndex(meta, DYN_CLASS_PROPERTIES).index}`,
  );
  bag.line(`${value} = load ptr, ptr ${slot}`);
  bag.terminate(`ret ptr ${value}`);
  const proto = new BlockBuilder();
  const prototype = proto.tmp();
  if (meta.def.instancePrototypeHelper) {
    const receiver = proto.tmp();
    proto.line(`${receiver} = call ptr ${vAdapters(host.shapeHost, t).retain}(ptr %p)`);
    proto.line(
      `${prototype} = call ptr @${mangleFunction(meta.def.instancePrototypeHelper)}(ptr ${receiver})`,
    );
  } else proto.line(`${prototype} = call ptr @${mangleFunction(meta.def.prototypeDataHelper!)}()`);
  proto.terminate(`ret ptr ${prototype}`);
  // Field `%i` of the view's field list, as the materializer boxes it.
  const fields = classViewFields(meta);
  const get = new BlockBuilder();
  const cases = fields.map((_, i) => get.newLabel(`field.${i}`));
  const none = get.newLabel("field.none");
  get.terminate(
    `switch ${host.sizeType} %i, label %${none} [ ${cases.map((label, i) => `${host.sizeType} ${i}, label %${label}`).join(" ")} ]`,
  );
  fields.forEach((field, i) => {
    get.startBlock(cases[i]!);
    const { boxed, nullable, fieldValue } = classFieldDynValue(host, get, meta, t, field);
    if (nullable) {
      host.declare(`declare void @scr_union_release(ptr)`);
      get.line(`call void @scr_union_release(ptr ${fieldValue})`);
    }
    get.terminate(`ret ptr ${boxed}`);
  });
  get.startBlock(none);
  get.terminate(`ret ptr null`);
  const names = fields.map((field) => `ptr ${host.internLiteral(field.name)}`);
  host.resolveThunkDefs.push(
    `define internal ptr @${snapshot}_field(ptr %p, ${host.sizeType} %i) ${FN_ATTRS} { ; view field of ${meta.def.name}`,
    get.render(),
    `}`,
    ``,
    `@${snapshot}_fnames = internal constant [${names.length} x ptr] ${names.length ? `[${names.join(", ")}]` : "zeroinitializer"}`,
  );
  host.resolveThunkDefs.push(
    `define internal ptr @${snapshot}_bag(ptr %p) ${FN_ATTRS} { ; property bag of ${meta.def.name}`,
    bag.render(),
    `}`,
    ``,
    `define internal ptr @${snapshot}_proto(ptr %p) ${FN_ATTRS} { ; view prototype of ${meta.def.name}`,
    proto.render(),
    `}`,
    ``,
    `@${snapshot}_bops = internal constant { ptr, ptr, ${host.sizeType}, ptr, ptr } { ptr @${snapshot}_bag, ptr @${snapshot}_proto, ${host.sizeType} ${fields.length}, ptr @${snapshot}_fnames, ptr @${snapshot}_field }`,
    ``,
  );
}

/** The live view a capsule of this adapter binds: the runtime bind call
 * and its ops constant, with the view code a deferred receiver recipe
 * records (1 array, 2 record, 3 class, 4 bag-tracked class). */
export function liveRefView(
  adapter: LlStreamTypedRefAdapter,
): { bind: string; ops: string; code: 1 | 2 | 3 | 4 } | null {
  if (adapter.classOps !== undefined)
    return { bind: "scr_dyn_typed_ref_bind_class", ops: adapter.classOps, code: 3 };
  if (adapter.bagClassOps !== undefined)
    return { bind: "scr_dyn_typed_ref_bind_bag_class", ops: adapter.bagClassOps, code: 4 };
  if (adapter.recordOps !== undefined)
    return { bind: "scr_dyn_typed_ref_bind_record", ops: adapter.recordOps, code: 2 };
  if (adapter.arrayOps !== undefined)
    return { bind: "scr_dyn_typed_ref_bind_array", ops: adapter.arrayOps, code: 1 };
  return null;
}

/** Attach the element or field hooks right after a live capsule is built. */
export function bindLiveArrayOps(
  host: ShapeHost,
  adapter: LlStreamTypedRefAdapter,
  capsule: string,
): string[] {
  const view = liveRefView(adapter);
  if (view === null) return [];
  host.declare(`declare void @${view.bind}(ptr, ptr)`);
  return [`call void @${view.bind}(ptr ${capsule}, ptr ${view.ops})`];
}

export function streamFromArrayAdapter(
  host: LlvmEmitterContext,
  t: IrType & { kind: "array" },
): string {
  const elem = t.elem;
  const key = typeKey(elem);
  const existing = host.streamFromArrayAdapters.get(key);
  if (existing) return existing;
  const sym = `sc_sfa_${host.streamFromArrayAdapters.size}`;
  host.streamFromArrayAdapters.set(key, sym);
  host.journal?.allocated(sym, "streamFromArrayAdapter", [t]);
  const B = new BlockBuilder();
  const unionDef = elem.kind === "union" ? host.unionsById.get(elem.unionId) : undefined;
  if (elem.kind === "union" && !unionDef) {
    throw new InternalCompilerError(
      `llvm emitter bug: streamFrom of unknown union ${elem.unionId}`,
    );
  }
  const unionRefArms =
    unionDef?.arms
      .map((arm, tag) => ({ arm, tag }))
      .filter(({ arm }) => isRefCounted(arm) && arm.kind !== "dyn" && arm.kind !== "string") ?? [];
  const typedRef =
    isRefCounted(elem) && elem.kind !== "dyn" && elem.kind !== "string" && elem.kind !== "union";
  let snapshot = `${sym}_materialize`;
  let value: string;
  if (elem.kind === "f64") {
    host.declare(`declare double @scr_arr_get_f64(ptr, double)`);
    value = B.tmp();
    B.line(`${value} = call double @scr_arr_get_f64(ptr %a, double %i)`);
  } else if (elem.kind === "bool") {
    host.declare(`declare zeroext i1 @scr_arr_get_bool(ptr, double)`);
    value = B.tmp();
    B.line(`${value} = call i1 @scr_arr_get_bool(ptr %a, double %i)`);
  } else {
    host.declare(`declare ptr @scr_arr_get_ref(ptr, double)`);
    value = B.tmp();
    B.line(`${value} = call ptr @scr_arr_get_ref(ptr %a, double %i) ; +1`);
  }
  let boxed: string;
  const valueTy = elem.kind === "f64" ? "double" : elem.kind === "bool" ? "i1" : "ptr";
  if (elem.kind === "union") {
    if (unionRefArms.length === 0) {
      boxed = B.tmp();
      B.line(`${boxed} = call ptr @${host.dyn.toDynHelper(elem)}(ptr ${value})`);
    } else {
      const boxedSlot = B.slot();
      B.entryAllocas.push(`${boxedSlot} = alloca ptr`);
      const elemNullable = host.nullableUnions.get(elem.unionId);
      const tagValue = emitUnionTag(B, elemNullable, value);
      const fallback = B.newLabel("sfa.union.dyn");
      const join = B.newLabel("sfa.union.join");
      const armLabels = unionRefArms.map(() => B.newLabel("sfa.union.ref"));
      B.terminate(
        `switch i32 ${tagValue}, label %${fallback} [ ${unionRefArms.map(({ tag }, i) => `i32 ${tag}, label %${armLabels[i]}`).join(" ")} ]`,
      );
      unionRefArms.forEach(({ arm, tag }, i) => {
        const armKey = typeKey(arm);
        const armSnapshot = `${snapshot}_${tag}`;
        const armCommit = host.streamTypedRefCommitAdapter(arm, armSnapshot);
        const rc = vAdapters(host.shapeHost, arm);
        B.startBlock(armLabels[i]!);
        const payload = emitUnionPeek(B, elemNullable, value);
        const armBoxed = B.tmp();
        B.line(
          `${armBoxed} = call ptr ${typedRefConstructor(host.shapeHost, arm)}(ptr ${payload}, ptr ${rc.retain}, ptr ${rc.release}, ptr ${host.cstr(armKey)}, ${host.sizeType} ${Buffer.byteLength(armKey, "utf8")}, ptr @${armSnapshot}, ptr ${armCommit})`,
        );
        B.line(`store ptr ${armBoxed}, ptr ${boxedSlot}`);
        B.br(join);
        host.resolveThunkDefs.push(
          `define internal ptr @${armSnapshot}(ptr %p) ${FN_ATTRS} { ; materialize stream union arm ${armKey}`,
          `entry:`,
          `  %d = call ptr @${host.dyn.toDynHelper(arm)}(ptr %p)`,
          `  ret ptr %d`,
          `}`,
          ``,
        );
      });
      B.startBlock(fallback);
      const dynBoxed = B.tmp();
      B.line(`${dynBoxed} = call ptr @${host.dyn.toDynHelper(elem)}(ptr ${value})`);
      B.line(`store ptr ${dynBoxed}, ptr ${boxedSlot}`);
      B.br(join);
      B.startBlock(join);
      boxed = B.tmp();
      B.line(`${boxed} = load ptr, ptr ${boxedSlot}`);
    }
  } else if (typedRef) {
    boxed = B.tmp();
    const rc = vAdapters(host.shapeHost, elem);
    const keyPtr = host.cstr(key);
    let commit: string;
    let live: LlStreamTypedRefAdapter | undefined;
    if (streamTypedRefEligible(elem)) {
      live = host.liveDynRefAdapter(elem);
      snapshot = live.snapshot;
      commit = live.commit;
    } else {
      commit = host.streamTypedRefCommitAdapter(elem, snapshot);
      host.resolveThunkDefs.push(
        `define internal ptr @${snapshot}(ptr %p) ${FN_ATTRS} { ; materialize stream element ${key}`,
        `entry:`,
        `  %d = call ptr @${host.dyn.toDynHelper(elem)}(ptr %p)`,
        `  ret ptr %d`,
        `}`,
        ``,
      );
    }

    B.line(
      `${boxed} = call ptr ${typedRefConstructor(host.shapeHost, elem)}(ptr ${value}, ptr ${rc.retain}, ptr ${rc.release}, ptr ${keyPtr}, ${host.sizeType} ${Buffer.byteLength(key, "utf8")}, ptr @${snapshot}, ptr ${commit})`,
    );
    if (live) for (const line of bindLiveArrayOps(host.shapeHost, live, boxed)) B.line(line);
  } else {
    boxed = B.tmp();
    B.line(`${boxed} = call ptr @${host.dyn.toDynHelper(elem)}(${valueTy} ${value})`);
  }
  if (isRefCounted(elem)) {
    B.line(`call void ${releaseSym(host.shapeHost, elem)}(ptr ${value})`);
  }
  B.terminate(`ret ptr ${boxed}`);
  host.resolveThunkDefs.push(
    `define internal ptr @${sym}(ptr %a, double %i) ${FN_ATTRS} { ; ReadableStream.from array<${key}>`,
    B.render(),
    `}`,
    ``,
  );
  host.journal?.built();
  return sym;
}

registerReplay("dynPromiseAdapter", (host, args) => dynPromiseAdapter(host, args[0] as IrType));
registerReplay("liveDynUnionRefAdapter", (host, args) =>
  liveDynUnionRefAdapter(host, args[0] as IrType & { kind: "union" }),
);
registerReplay("streamTypedRefMaterializeAdapter", (host, args) =>
  streamTypedRefMaterializeAdapter(host, args[0] as IrType).snapshot.replace(/_materialize$/, ""),
);
registerReplay("streamFromArrayAdapter", (host, args) =>
  streamFromArrayAdapter(host, args[0] as IrType & { kind: "array" }),
);
