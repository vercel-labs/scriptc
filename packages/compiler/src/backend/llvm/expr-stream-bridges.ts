import { typedRefConstructor } from "./shapes.js";
/* Focused LLVM expression emission extracted from emitter.ts. */
import { InternalCompilerError } from "../../errors.js";
import { streamTypedRefEligible, undefinedArmTag } from "../../ir/analysis.js";
import {
  type IrRecordShape,
  type IrType,
  DYN_CLASS_PROPERTIES,
  RUNTIME_STREAM_CLASSES,
  SYMBOL_T,
  canDynCheckTo,
  classDynViewSupported,
  isClassOwnEnumerableField,
  isDirentShape,
  isDynTypedRefType,
  isRefCounted,
  typeKey,
} from "../../ir/ir.js";
import { mangleFunction, mangleGlobal, mangleRecordStruct } from "../mangle.js";
import { BlockBuilder } from "./blocks.js";
import { type LlClassMeta, classFieldIndex, classStructSym } from "./classes.js";
import { llvmCommentText } from "./common.js";
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
import {
  boxClassFieldValue,
  loadClassFieldValue,
  readClassFieldValue,
} from "./class-field-values.js";
import { emitUnionPeek, emitUnionTag } from "./union-repr.js";
import { inlineUnionCopyLines } from "./inline-unions.js";

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
  } else if (
    inner.kind === "f64" ||
    inner.kind === "date" ||
    inner.kind === "procStream" ||
    inner.kind === "bool"
  ) {
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
  return sym;
}

function streamTypedRefCanCommit(host: LlvmEmitterContext, t: IrType): boolean {
  // Opaque record children can be boxed exactly, but a whole-view commit
  // cannot reconstruct them. Declared writes retain their per-key owner.
  if (
    t.kind === "record" &&
    !canDynCheckTo(
      t,
      (id) => host.recordsById.get(id),
      (id) => host.unionsById.get(id),
    )
  )
    return false;
  return (
    t.kind === "bytes" ||
    t.kind === "array" ||
    (!host.liveViewsReadOnly && (isDynTypedRefType(t) || t.kind === "record"))
  );
}

export function streamTypedRefCommitAdapter(
  host: LlvmEmitterContext,
  t: IrType,
  snapshot: string,
): string {
  // Only a runtime store into the view commits: without one in the program,
  // class and record views need no commit (or its checked conversions).
  if (!streamTypedRefCanCommit(host, t)) return "null";
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
    const check = host.dyn.dynCheckHelper(t);
    host.declare(`declare void @scr_arr_release(ptr)`);
    host.declare(`declare void @scr_arr_swap_indexed_storage(ptr, ptr)`);
    host.resolveThunkDefs.push(
      `define internal void @${commit}(ptr %target, ptr %d) ${FN_ATTRS} { ; commit live stream element ${typeKey(t)}`,
      `entry:`,
      `  %next = call ptr @${check}(ptr %d, ptr null)`,
      `  %missing = icmp eq ptr %next, null`,
      `  br i1 %missing, label %done, label %swap`,
      `swap:`,
      // Checked conversion rebuilds indices only; names belong to the target.
      `  call void @scr_arr_swap_indexed_storage(ptr %target, ptr %next)`,
      `  call void @scr_arr_release(ptr %next)`,
      `  br label %done`,
      `done:`,
      `  ret void`,
      `}`,
      ``,
    );
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
        `  %derived_vt_slot = getelementptr inbounds %${classStructSym(t.className)}, ptr %target, i64 0, i32 1`,
        `  %derived_vt = load ptr, ptr %derived_vt_slot`,
        `  %derived_pre_slot = getelementptr inbounds %ScrVt, ptr %derived_vt, i64 0, i32 0`,
        `  %derived_pre = load ${host.sizeType}, ptr %derived_pre_slot`,
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
    const symbols = new Map(
      (meta.def.symbolFields ?? []).map((symbol) => [symbol.field, symbol.globalId]),
    );
    const fields = meta.def.fields.filter(
      (field) =>
        (isClassOwnEnumerableField(field) || symbols.has(field.name)) &&
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
      const { index: fieldIndex } = classFieldIndex(meta, field.name);
      const int32 = host.int32Slots.isField(t.className, field.name);
      const inline = host.inlineUnions.classField(t.className, field.name);
      const fieldTy = int32 ? "i32" : llFieldType(field.type, inline);
      const checkTy = host.llType(field.type);
      const symbolGlobal = symbols.get(field.name);
      if (symbolGlobal) {
        host.declare(`declare ptr @scr_dyn_symbol_key_get(ptr, ptr, i1 zeroext)`);
        host.declare(`declare void @scr_dyn_release_v(ptr)`);
        lines.push(
          `  %f${index}_keyraw = load ptr, ptr @${mangleGlobal(symbolGlobal)}`,
          `  %f${index}_key = call ptr @${host.dyn.toDynHelper(SYMBOL_T)}(ptr %f${index}_keyraw)`,
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
      if (meta.def.tracksOwnFields && !symbolGlobal)
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
        ...(symbolGlobal ? [`  call void @scr_dyn_release_v(ptr %${raw})`] : []),
        ...host.pendingTestLines(`%${pending}`),
        `  br i1 %${pending}, label %done, label %${store}`,
        `${store}:`,
        `  %f${index}_ptr = getelementptr inbounds %${classStructSym(t.className)}, ptr %target, i64 0, i32 ${fieldIndex}`,
        `  %f${index}_old = load ${fieldTy}, ptr %f${index}_ptr`,
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
          `  store ptr %f${index}_new, ptr %f${index}_ptr`,
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
      if (meta.def.tracksOwnFields) {
        host.declare(`declare ptr @scr_dyn_retain_v(ptr)`);
        host.declare(`declare void @scr_dyn_table_set_data(ptr, ptr, ${host.sizeType}, ptr)`);
      }
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
      if (
        !meta.def.nativePropertyBagHelper &&
        (meta.def.instancePrototypeHelper || meta.def.prototypeDataHelper)
      ) {
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
              `  %bag_undefined${index} = call ptr @scr_dyn_undefined()`,
              `  %bag_placeholder${index} = call ptr @scr_dyn_retain_v(ptr %bag_undefined${index})`,
              `  call void @scr_dyn_table_set_data(ptr %bag, ptr ${host.cstr(field.name)}, ${host.sizeType} ${Buffer.byteLength(field.name, "utf8")}, ptr %bag_placeholder${index})`,
            );
          else
            lines.push(
              `  %bag_key${index} = call ptr @scr_str_new(ptr ${host.cstr(field.name)}, ${host.sizeType} ${Buffer.byteLength(field.name, "utf8")})`,
              `  call void @scr_dyn_key_delete(ptr %bag, ptr %bag_key${index}, i1 zeroext false)`,
              `  call void @scr_str_release(ptr %bag_key${index})`,
            );
        });
      if (symbols.size > 0)
        host.declare(
          meta.def.tracksOwnFields
            ? `declare void @scr_dyn_symbol_key_placeholder(ptr, ptr)`
            : `declare void @scr_dyn_key_delete_computed(ptr, ptr, i1 zeroext)`,
        );
      [...symbols.values()].forEach((globalId, index) =>
        lines.push(
          `  %bag_symraw${index} = load ptr, ptr @${mangleGlobal(globalId)}`,
          `  %bag_sym${index} = call ptr @${host.dyn.toDynHelper(SYMBOL_T)}(ptr %bag_symraw${index})`,
          meta.def.tracksOwnFields
            ? `  call void @scr_dyn_symbol_key_placeholder(ptr %bag, ptr %bag_sym${index})`
            : `  call void @scr_dyn_key_delete_computed(ptr %bag, ptr %bag_sym${index}, i1 zeroext false)`,
          `  call void @scr_dyn_release_v(ptr %bag_sym${index})`,
        ),
      );
      const { index } = classFieldIndex(meta, DYN_CLASS_PROPERTIES);
      if (meta.def.nativePropertyBagHelper)
        host.declare(`declare void @scr_native_property_bag_copy_prototype(ptr, ptr)`);
      lines.push(
        `  %bag_ptr = getelementptr inbounds %${classStructSym(t.className)}, ptr %target, i64 0, i32 ${index}`,
        `  %bag_old = load ptr, ptr %bag_ptr`,
        ...(meta.def.nativePropertyBagHelper
          ? [`  call void @scr_native_property_bag_copy_prototype(ptr %bag, ptr %bag_old)`]
          : []),
        `  store ptr %bag, ptr %bag_ptr`,
        `  call void @scr_dyn_release_v(ptr %bag_old)`,
      );
    }
    if (meta.root.def.name === "%Error") {
      host.declare(`declare void @scr_error_commit_dyn(ptr, ptr)`);
      lines.push(`  call void @scr_error_commit_dyn(ptr %target, ptr %d)`);
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
  const members = [
    ...shape.fields.map((field, index) => ({
      index: index + 1,
      type: llFieldType(field.type, host.inlineUnions.record(field.type)),
      name: field.name,
    })),
    ...(shape.indexValue
      ? [
          {
            index: shape.fields.length + 1,
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
  const mutableArms = union.arms
    .map((arm, tag) => ({ arm, tag }))
    .filter(
      ({ arm }) => arm.kind !== "bytes" && (streamTypedRefEligible(arm) || isDynTypedRefType(arm)),
    );
  if (mutableArms.length === 0 && !union.arms.some((arm) => arm.kind === "bytes")) {
    throw new InternalCompilerError(`llvm emitter bug: live dyn ref of immutable union ${key}`);
  }

  const sym = `sc_ldu_${host.liveDynUnionRefAdapters.size}`;
  host.liveDynUnionRefAdapters.set(key, sym);

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
    const result = bindLiveArrayOps(host.shapeHost, B, adapter, boxed);
    B.terminate(`ret ptr ${result}`);
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
  return sym;
}

export function streamTypedRefBoxValue(
  host: LlvmEmitterContext,
  B: BlockBuilder,
  t: IrType,
  value: string,
): string {
  const boxed = B.tmp(),
    slot = B.tmp();
  const ty = host.llType(t);
  B.line(
    `${slot} = ${ty === "double" ? `bitcast double ${value} to i64` : ty === "i1" ? `zext i1 ${value} to i64` : `ptrtoint ptr ${value} to i64`}`,
  );
  B.line(`${boxed} = call ptr @${host.dyn.nativeSlotBoxHelper(t)}(i64 ${slot})`);
  return boxed;
}

export function streamTypedRefMaterializeAdapter(
  host: LlvmEmitterContext,
  t: IrType,
): LlStreamTypedRefAdapter {
  const key = typeKey(t);
  const existing = host.liveDynRefAdapters.get(key);
  if (existing) return existing;
  const snapshot = `sc_ldr_${host.liveDynRefAdapters.size}_materialize`;
  const meta = isDynTypedRefType(t) ? host.classMeta.get(t.className) : undefined;
  if (isDynTypedRefType(t) && !meta) {
    throw new InternalCompilerError(
      `llvm emitter bug: typed-ref materialize of unknown class ${t.className}`,
    );
  }
  const shape = t.kind === "record" ? host.recordsById.get(t.shapeId) : undefined;
  if (t.kind === "record" && !shape) {
    throw new InternalCompilerError(
      `llvm emitter bug: stream typed-ref materialize of unknown shape ${t.shapeId}`,
    );
  }
  // Index-signature/listener records keep their source-identity and overflow
  // walks on the ordinary converter. Other record hooks use snapshot order.
  const ordinaryRecord =
    shape?.indexValue ||
    shape?.fields.some((field) => field.name === "handleEvent" && field.type.kind === "func");
  const byName = new Map(shape?.fields.map((field) => [field.name, field]));
  const order = shape?.declaredOrder ?? shape?.fields.map((field) => field.name) ?? [];
  const inOrder = new Set(order);
  const recordFields = [
    ...order.map((name) => byName.get(name)).filter((field) => field !== undefined),
    ...(shape?.fields.filter((field) => !inOrder.has(field.name)) ?? []),
  ];
  const dirent = shape !== undefined && isDirentShape(shape);
  const unavailable =
    meta !== undefined &&
    !classDynViewSupported(
      meta.def.fields,
      (id) => host.recordsById.get(id),
      (id) => host.unionsById.get(id),
    );
  const nativeOps = host.nativeObjects.reserveOps(t);
  const adapter: LlStreamTypedRefAdapter = {
    snapshot: unavailable ? "scr_dyn_class_view_unavailable" : snapshot,
    commit: !unavailable && streamTypedRefCanCommit(host, t) ? `@${snapshot}_commit` : "null",
  };
  if (!unavailable) {
    if (t.kind === "array") adapter.arrayOps = `@${snapshot}_ops`;
    if (shape && !ordinaryRecord && !shape.tuple && !dirent && liveRecordOpsEligible(recordFields))
      adapter.recordOps = `@${snapshot}_rops`;
  }
  if (meta && (!unavailable || nativeOps) && liveClassOpsEligible(meta))
    adapter.classOps = `@${snapshot}_cops`;
  if (nativeOps) adapter.nativeObjectOps = nativeOps;
  // Publish the complete recipe before generating any body. Native reads,
  // commits and snapshots can recursively box this type and retain its
  // symbols permanently, including readonly NULL and unavailable views.
  host.liveDynRefAdapters.set(key, adapter);
  if (nativeOps) host.nativeObjects.ops(t);
  if (meta && adapter.classOps) liveClassOps(host, snapshot, meta);
  if (unavailable) {
    host.declare(`declare ptr @scr_dyn_class_view_unavailable(ptr)`);
    return adapter;
  }
  host.streamTypedRefCommitAdapter(t, snapshot);
  const B = new BlockBuilder();

  if (isDynTypedRefType(t)) {
    const meta = host.classMeta.get(t.className)!;
    if (meta.hierarchy && meta.children.length) {
      const vtSlot = B.tmp(),
        vt = B.tmp(),
        preSlot = B.tmp(),
        pre = B.tmp();
      B.line(
        `${vtSlot} = getelementptr inbounds %${classStructSym(t.className)}, ptr %p, i64 0, i32 1`,
      );
      B.line(`${vt} = load ptr, ptr ${vtSlot}`);
      B.line(`${preSlot} = getelementptr inbounds %ScrVt, ptr ${vt}, i64 0, i32 0`);
      B.line(`${pre} = load ${host.sizeType}, ptr ${preSlot}`);
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
      meta.def.runtime &&
      RUNTIME_STREAM_CLASSES.has(t.className) &&
      !meta.def.instancePrototypeHelper &&
      !meta.def.prototypeDataHelper
    ) {
      host.declare(`declare ptr @scr_stream_dyn_view(ptr)`);
      B.line(`${out} = call ptr @scr_stream_dyn_view(ptr %p)`);
    } else B.line(`${out} = call ptr @scr_dyn_new_obj()`);
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
    if (nativeOps) {
      host.declare(`declare void @scr_native_object_snapshot_prototype(ptr, ptr, ptr)`);
      B.line(
        `call void @scr_native_object_snapshot_prototype(ptr %p, ptr ${nativeOps}, ptr ${out})`,
      );
    } else if (meta.def.instancePrototypeHelper || meta.def.prototypeDataHelper) {
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
    for (const field of meta.def.fields.filter(
      (f) =>
        isClassOwnEnumerableField(f) &&
        !meta.def.symbolFields?.some((symbol) => symbol.field === f.name) &&
        !(meta.root.def.name === "%Error" && (f.name === "message" || f.name === "name")),
    )) {
      const afterField = meta.def.tracksOwnFields ? B.newLabel("field.after") : null;
      if (afterField) {
        host.declare(`declare i32 @scr_native_property_bag_facts(ptr, ptr, ${host.sizeType})`);
        const facts = B.tmp(),
          data = B.tmp(),
          present = B.tmp(),
          yes = B.newLabel("field.present");
        B.line(
          `${facts} = call i32 @scr_native_property_bag_facts(ptr ${out}, ptr ${host.cstr(field.name)}, ${host.sizeType} ${Buffer.byteLength(field.name, "utf8")})`,
        );
        B.line(`${data} = and i32 ${facts}, 2`);
        B.line(`${present} = icmp ne i32 ${data}, 0`);
        B.condBr(present, yes, afterField);
        B.startBlock(yes);
      }
      const boxed = readClassFieldValue(host, B, t.className, field, "%p");
      pendingSnapshot(host, B, [boxed, out]);
      const write = afterField ? "scr_dyn_table_set_data" : "scr_dyn_obj_set";
      host.declare(`declare void @${write}(ptr, ptr, ${host.sizeType}, ptr)`);
      B.line(
        `call void @${write}(ptr ${out}, ptr ${host.cstr(field.name)}, ${host.sizeType} ${Buffer.byteLength(field.name, "utf8")}, ptr ${boxed})`,
      );
      if (afterField) {
        B.br(afterField);
        B.startBlock(afterField);
      }
    }
    for (const symbol of meta.def.symbolFields ?? []) {
      const field = meta.def.fields.find((field) => field.name === symbol.field)!;
      const rawKey = B.tmp();
      const fieldValue = loadClassFieldValue(host, B, t.className, field, "%p");
      B.line(`${rawKey} = load ptr, ptr @${mangleGlobal(symbol.globalId)}`);
      const key = host.streamTypedRefBoxValue(B, SYMBOL_T, rawKey);
      const afterSymbol =
        meta.def.tracksOwnFields || field.type.kind === "symbol"
          ? B.newLabel("symbol.after")
          : null;
      if (afterSymbol) {
        const initialized = B.tmp(),
          present = B.newLabel("symbol.present");
        if (meta.def.tracksOwnFields) {
          host.declare(`declare zeroext i1 @scr_dyn_table_has_symbol_data(ptr, ptr)`);
          B.line(
            `${initialized} = call zeroext i1 @scr_dyn_table_has_symbol_data(ptr ${out}, ptr ${key})`,
          );
        } else B.line(`${initialized} = icmp ne ptr ${fieldValue}, null`);
        B.condBr(initialized, present, afterSymbol);
        B.startBlock(present);
      }
      const value = boxClassFieldValue(host, B, t.className, field, fieldValue);
      pendingSnapshot(host, B, [value, key, out]);
      const write = meta.def.tracksOwnFields
        ? "scr_dyn_table_set_symbol_data"
        : "scr_dyn_symbol_key_set";
      host.declare(`declare void @${write}(ptr, ptr, ptr)`);
      host.declare(`declare void @scr_dyn_release_v(ptr)`);
      B.line(`call void @${write}(ptr ${out}, ptr ${key}, ptr ${value})`);
      if (!meta.def.tracksOwnFields) B.line(`call void @scr_dyn_release_v(ptr ${value})`);
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
    B.terminate(`ret ptr ${out}`);
  } else if (t.kind === "record") {
    const shape = host.recordsById.get(t.shapeId)!;
    if (ordinaryRecord) {
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
        const index = shape.fields.indexOf(field) + 1;
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
        pendingSnapshot(host, B, [boxed, out]);
        B.line(`call void @scr_dyn_arr_push(ptr ${out}, ptr ${boxed})`);
      }
      B.terminate(`ret ptr ${out}`);
    } else {
      host.declare(`declare ptr @scr_dyn_new_obj()`);
      host.declare(`declare void @scr_dyn_obj_set(ptr, ptr, ${host.sizeType}, ptr)`);
      const out = B.tmp();
      B.line(`${out} = call ptr @scr_dyn_new_obj()`);
      // A Dirent row reads through its finished view (the prototype and
      // the non-enumerable %dtype).
      if (adapter.recordOps) liveRecordOps(host, t, snapshot, recordFields);
      for (const field of recordFields) {
        const index = shape.fields.indexOf(field) + 1;
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
        pendingSnapshot(host, B, [boxed, out]);
        B.line(
          `call void @scr_dyn_obj_set(ptr ${out}, ptr ${host.cstr(field.name)}, ${host.sizeType} ${Buffer.byteLength(field.name, "utf8")}, ptr ${boxed})`,
        );
        if (skip !== null) {
          B.br(skip);
          B.startBlock(skip);
        }
      }
      if (dirent) {
        host.declare(`declare void @scr_dyn_dirent_finish(ptr)`);
        B.line(`call void @scr_dyn_dirent_finish(ptr ${out})`);
      }
      B.terminate(`ret ptr ${out}`);
    }
  } else if (t.kind === "array") {
    const elem = t.elem;
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
      const undefinedValue = B.tmp();
      const retained = B.tmp();
      B.line(`${undefinedValue} = call ptr @scr_dyn_undefined()`);
      B.line(`${retained} = call ptr @scr_dyn_retain_v(ptr ${undefinedValue})`);
      B.line(`call void @scr_dyn_arr_push(ptr ${out}, ptr ${retained})`);
      B.br(doneLabel);
      B.startBlock(valueLabel);
      let value: string;
      const acc = elemAccess(elem);
      if (acc === "f64" || acc === "bool") {
        const valueTy = acc === "f64" ? "double" : "i1";
        host.declare(
          `declare ${acc === "bool" ? "zeroext i1" : valueTy} @scr_arr_get_slot_${acc}(ptr, double)`,
        );
        value = B.tmp();
        B.line(`${value} = call ${valueTy} @scr_arr_get_slot_${acc}(ptr %p, double ${index})`);
      } else {
        host.declare(`declare ptr @scr_arr_get_slot_ref(ptr, double)`);
        value = B.tmp();
        B.line(`${value} = call ptr @scr_arr_get_slot_ref(ptr %p, double ${index}) ; +1`);
      }
      const boxed = host.streamTypedRefBoxValue(B, elem, value);
      if (isRefCounted(elem)) {
        B.line(`call void ${releaseSym(host.shapeHost, elem)}(ptr ${value})`);
      }
      pendingSnapshot(host, B, [boxed, out]);
      B.line(`call void @scr_dyn_arr_push(ptr ${out}, ptr ${boxed})`);
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
  return adapter;
}

/** Per-element hooks for a live array capsule (ScrDynTypedArrayOps). The
 * runtime answers presence and length from the native array and calls these
 * to convert exactly one element, so `xs[i]`, `xs[i] = v`, `i in xs`, and
 * iteration on a live array do not rebuild the whole snapshot per access.
 * `get` boxes an element exactly like one step of the snapshot loop; `set`
 * returns ScrDynArrayWrite: mismatch=0, stored=1, refused=2. Matching and
 * conversion may run user code, so pending errors win and converted values
 * are released before a quiet or throwing post-conversion integrity refusal. */
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
    `declare ${acc === "bool" ? "zeroext i1" : valueTy} @scr_arr_get_slot_${acc}(ptr, double)`,
  );
  G.line(
    `${value} = call ${valueTy} @scr_arr_get_slot_${acc}(ptr %p, double %i)${acc === "ref" ? " ; +1" : ""}`,
  );
  const boxed = host.streamTypedRefBoxValue(G, elem, value);
  if (isRefCounted(elem)) G.line(`call void ${releaseSym(host.shapeHost, elem)}(ptr ${value})`);
  G.terminate(`ret ptr ${boxed}`);

  const S = new BlockBuilder();
  const fits = S.tmp();
  S.line(`${fits} = call zeroext i1 @${host.dyn.dynMatchHelper(elem)}(ptr %v)`);
  const matched = S.newLabel("live.array.matched");
  const refused = S.newLabel("live.array.refused");
  const matchPending = S.tmp();
  for (const line of host.pendingTestLines(matchPending)) S.line(line.trimStart());
  S.condBr(matchPending, refused, matched);
  S.startBlock(refused);
  S.terminate(`ret i32 2`);
  S.startBlock(matched);
  const convert = S.newLabel("live.array.convert");
  const mismatch = S.newLabel("live.array.mismatch");
  S.condBr(fits, convert, mismatch);
  S.startBlock(mismatch);
  S.terminate(`ret i32 0`);
  S.startBlock(convert);
  const next = S.tmp();
  S.line(
    `${next} = call ${acc === "bool" ? "zeroext " : ""}${valueTy} @${host.dyn.dynCheckHelper(elem)}(ptr %v, ptr null)`,
  );
  const pending = S.tmp();
  for (const line of host.pendingTestLines(pending)) S.line(line.trimStart());
  const guard = S.newLabel("live.array.guard");
  const failed = S.newLabel("live.array.failed");
  const write = S.newLabel("live.array.write");
  S.condBr(pending, failed, guard);
  S.startBlock(guard);
  host.declare(`declare zeroext i1 @scr_arr_check_set_mode(ptr, double, i1 zeroext)`);
  const allowed = S.tmp();
  S.line(`${allowed} = call zeroext i1 @scr_arr_check_set_mode(ptr %p, double %i, i1 %strict)`);
  S.condBr(allowed, write, failed);
  S.startBlock(failed);
  // Some failed union conversions still return an owned wrapper.
  if (isRefCounted(elem)) S.line(`call void ${releaseSym(host.shapeHost, elem)}(ptr ${next})`);
  S.terminate(`ret i32 2`);
  S.startBlock(write);
  host.declare(
    `declare void @scr_arr_set_${acc}(ptr, double, ${acc === "bool" ? "i1 zeroext" : valueTy})`,
  );
  S.line(`call void @scr_arr_set_${acc}(ptr %p, double %i, ${valueTy} ${next}) ; takes ownership`);
  S.terminate(`ret i32 1`);

  host.resolveThunkDefs.push(
    `define internal ptr @${get}(ptr %p, double %i) ${FN_ATTRS} { ; live element of ${typeKey(t)}`,
    G.render(),
    `}`,
    ``,
    `define internal i32 @${set}(ptr %p, double %i, ptr %v, i1 zeroext %strict) ${FN_ATTRS} { ; live element store into ${typeKey(t)}`,
    S.render(),
    `}`,
    ``,
    `@${ops} = internal constant { ptr, ptr, ptr, ptr } { ptr @${get}, ptr @${set}, ptr @${host.dyn.nativeSlotBoxHelper(elem)}, ptr @${host.dyn.nativeSlotUnboxHelper(elem)} }`,
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
    const index = shape.fields.indexOf(field) + 1;
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
    `@${names} = internal constant [${fields.length} x ptr] [${literals.join(", ")}]`,
    // Mutable: the runtime fills the trailing key-array slot on first use.
    `@${ops} = internal global { ${host.sizeType}, ptr, ptr, ptr, i8, ptr } { ${host.sizeType} ${fields.length}, ptr @${names}, ptr @${has}, ptr @${get}, i8 ${optional.length === 0 ? 1 : 0}, ptr null }`,
    ``,
  );
}

/** Native classes retain declaration facts even when their current
 * prototype omits unobserved methods or their fields have no dyn view.
 * Those facts support refusals, not effective-property lookup. */
function liveClassOpsEligible(meta: LlClassMeta): boolean {
  return (
    !meta.def.runtime &&
    !meta.root.def.runtime &&
    (!!meta.def.nativePropertyBagHelper ||
      (!meta.def.prototypeDataHelper && !meta.def.instancePrototypeHelper))
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
    const vtSlot = B.tmp(),
      vt = B.tmp(),
      preSlot = B.tmp(),
      pre = B.tmp();
    B.line(
      `${vtSlot} = getelementptr inbounds %${classStructSym(meta.def.name)}, ptr %p, i64 0, i32 1`,
    );
    B.line(`${vt} = load ptr, ptr ${vtSlot}`);
    B.line(`${preSlot} = getelementptr inbounds %ScrVt, ptr ${vt}, i64 0, i32 0`);
    B.line(`${pre} = load ${host.sizeType}, ptr ${preSlot}`);
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
  host.resolveThunkDefs.push(
    `@${names} = internal constant [${members.length} x ptr] [${literals.join(", ")}]`,
    `@${ops} = internal constant { ptr, ${host.sizeType}, ptr, ptr } { ptr ${exact}, ${host.sizeType} ${members.length}, ptr @${names}, ptr ${className} }`,
    ``,
  );
}

/** The live view a capsule of this adapter binds: the runtime bind call
 * and its ops constant, with the view code a deferred receiver recipe
 * records (1 array, 2 record, 3 class). */
export function liveRefView(
  adapter: LlStreamTypedRefAdapter,
): { bind: string; ops: string; code: 1 | 2 | 3 } | null {
  if (adapter.classOps !== undefined)
    return { bind: "scr_dyn_typed_ref_bind_class", ops: adapter.classOps, code: 3 };
  if (adapter.recordOps !== undefined)
    return { bind: "scr_dyn_typed_ref_bind_record", ops: adapter.recordOps, code: 2 };
  if (adapter.arrayOps !== undefined)
    return { bind: "scr_dyn_typed_ref_bind_array", ops: adapter.arrayOps, code: 1 };
  return null;
}

/** The capability is borrowed program metadata, so fresh and interned
 * capsules bind identically without touching their cached materialization. */
export function bindNativeObjectOps(
  host: ShapeHost,
  B: BlockBuilder,
  ops: string | null | undefined,
  capsule: string,
): void {
  if (!ops) return;
  host.declare("declare void @scr_dyn_typed_ref_bind_native_object(ptr, ptr)");
  B.line(`call void @scr_dyn_typed_ref_bind_native_object(ptr ${capsule}, ptr ${ops})`);
}

/** Attach independent native ownership and optional live-view hooks. */
export function bindLiveArrayOps(
  host: ShapeHost,
  B: BlockBuilder,
  adapter: LlStreamTypedRefAdapter,
  capsule: string,
): string {
  bindNativeObjectOps(host, B, adapter.nativeObjectOps, capsule);
  const view = liveRefView(adapter);
  if (view === null) return capsule;
  if (view.code !== 1) {
    host.declare(`declare void @${view.bind}(ptr, ptr)`);
    B.line(`call void @${view.bind}(ptr ${capsule}, ptr ${view.ops})`);
    return capsule;
  }
  host.declare(`declare zeroext i1 @${view.bind}(ptr, ptr)`);
  host.declare(`declare void @scr_dyn_release_v(ptr)`);
  const ok = B.tmp(),
    result = B.tmp();
  const bound = B.newLabel("bind.array.ok"),
    fail = B.newLabel("bind.array.fail");
  const join = B.newLabel("bind.array.join");
  B.line(`${ok} = call zeroext i1 @${view.bind}(ptr ${capsule}, ptr ${view.ops})`);
  B.condBr(ok, bound, fail);
  B.startBlock(fail);
  B.line(`call void @scr_dyn_release_v(ptr ${capsule})`);
  B.br(join);
  B.startBlock(bound);
  B.br(join);
  B.startBlock(join);
  B.line(`${result} = phi ptr [ ${capsule}, %${bound} ], [ null, %${fail} ]`);
  return result;
}

/** Generated snapshots own their partial output outside the emitter frame.
 * A nested bind failure must release that output before propagating pending. */
function pendingSnapshot(
  host: LlvmEmitterContext,
  B: BlockBuilder,
  owned: readonly string[],
): void {
  const pending = B.tmp(),
    fail = B.newLabel("snapshot.fail"),
    next = B.newLabel("snapshot.next");
  for (const line of host.pendingTestLines(pending)) B.line(line.trimStart());
  B.condBr(pending, fail, next);
  B.startBlock(fail);
  host.declare(`declare void @scr_dyn_release_v(ptr)`);
  for (const value of owned) B.line(`call void @scr_dyn_release_v(ptr ${value})`);
  B.terminate("ret ptr null");
  B.startBlock(next);
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
    host.declare(`declare double @scr_arr_get_slot_f64(ptr, double)`);
    value = B.tmp();
    B.line(`${value} = call double @scr_arr_get_slot_f64(ptr %a, double %i)`);
  } else if (elem.kind === "bool") {
    host.declare(`declare zeroext i1 @scr_arr_get_slot_bool(ptr, double)`);
    value = B.tmp();
    B.line(`${value} = call i1 @scr_arr_get_slot_bool(ptr %a, double %i)`);
  } else {
    host.declare(`declare ptr @scr_arr_get_slot_ref(ptr, double)`);
    value = B.tmp();
    B.line(`${value} = call ptr @scr_arr_get_slot_ref(ptr %a, double %i) ; +1`);
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
        B.startBlock(armLabels[i]!);
        const payload = emitUnionPeek(B, elemNullable, value);
        // Union chunks need the same live operations as non-union chunks;
        // snapshot-only boxing loses per-operation writes and partial failures.
        if (arm.kind !== "bytes" && (streamTypedRefEligible(arm) || isDynTypedRefType(arm))) {
          const armBoxed = host.streamTypedRefBoxValue(B, arm, payload);
          B.line(`store ptr ${armBoxed}, ptr ${boxedSlot}`);
          B.br(join);
          return;
        }
        const armKey = typeKey(arm);
        const armSnapshot = `${snapshot}_${tag}`;
        const armCommit = host.streamTypedRefCommitAdapter(arm, armSnapshot);
        const rc = vAdapters(host.shapeHost, arm);
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
    if (live) boxed = bindLiveArrayOps(host.shapeHost, B, live, boxed);
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
  return sym;
}
