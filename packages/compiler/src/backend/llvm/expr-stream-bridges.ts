import { typedRefConstructor } from "./shapes.js";
/* Focused LLVM expression emission extracted from emitter.ts. */
import { InternalCompilerError } from "../../errors.js";
import { streamTypedRefEligible, undefinedArmTag } from "../../ir/analysis.js";
import {
  type IrType,
  DYN_CLASS_PROPERTIES,
  RUNTIME_STREAM_CLASSES,
  SYMBOL_T,
  classDynViewSupported,
  isClassOwnEnumerableFieldName,
  isDynTypedRefType,
  isRefCounted,
  typeKey,
} from "../../ir/ir.js";
import { mangleFunction, mangleGlobal, mangleRecordStruct } from "../mangle.js";
import { BlockBuilder } from "./blocks.js";
import { classFieldIndex, classStructSym } from "./classes.js";
import { emitFieldAbsentTest, llvmCommentText } from "./common.js";
import { FN_ATTRS, llFieldType, releaseSym, traceArg, vAdapters } from "./shapes.js";
import type { LlvmEmitterContext, LlStreamTypedRefAdapter } from "./expr-context.js";

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
  host.declare(`declare zeroext i1 @scr_exc_pending()`);
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
  B.line(`${pending} = call zeroext i1 @scr_exc_pending()`);
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

export function streamTypedRefCommitAdapter(
  host: LlvmEmitterContext,
  t: IrType,
  snapshot: string,
): string {
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
    const lines = [
      `define internal void @${commit}(ptr %target, ptr %d) ${FN_ATTRS} { ; commit live stream element ${typeKey(t)}`,
      `entry:`,
      `  %next = call ptr @${check}(ptr %d, ptr null)`,
      `  %missing = icmp eq ptr %next, null`,
      `  br i1 %missing, label %done, label %swap`,
      `swap:`,
    ];
    const storageMembers = [
      { name: "len", index: 1, type: host.sizeType },
      { name: "cap", index: 2, type: host.sizeType },
      { name: "data", index: 7, type: "ptr" },
      { name: "present", index: 8, type: "ptr" },
      { name: "sparse", index: 9, type: "ptr" },
      { name: "sparse_len", index: 10, type: host.sizeType },
      { name: "sparse_cap", index: 11, type: host.sizeType },
      { name: "props", index: 12, type: "ptr" },
      { name: "prop_len", index: 13, type: host.sizeType },
      { name: "prop_cap", index: 14, type: host.sizeType },
      { name: "metadata", index: 15, type: "ptr" },
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
    host.declare(`declare zeroext i1 @scr_exc_pending()`);
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
      const { index: fieldIndex } = classFieldIndex(meta, field.name);
      const fieldTy = llFieldType(field.type);
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
        `  %${pending} = call zeroext i1 @scr_exc_pending()`,
        `  br i1 %${pending}, label %done, label %${store}`,
        `${store}:`,
        `  %f${index}_ptr = getelementptr inbounds %${classStructSym(t.className)}, ptr %target, i64 0, i32 ${fieldIndex}`,
        `  %f${index}_old = load ${fieldTy}, ptr %f${index}_ptr`,
      );
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
        host.declare(`declare void @scr_dyn_obj_set(ptr, ptr, ${host.sizeType}, ptr)`);
      }
      lines.push(
        `  %bag = call ptr @scr_dyn_new_obj()`,
        `  %bag_copy = call ptr @scr_dyn_copy_property_descriptors(ptr %bag, ptr %d)`,
        `  call void @scr_dyn_release_v(ptr %bag_copy)`,
        `  %bag_pending = call zeroext i1 @scr_exc_pending()`,
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
              `  call void @scr_dyn_obj_set(ptr %bag, ptr ${host.cstr(field.name)}, ${host.sizeType} ${Buffer.byteLength(field.name, "utf8")}, ptr %bag_placeholder${index})`,
              `  br label %bag_field${index}_after`,
              `bag_field${index}_after:`,
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
      type: llFieldType(field.type),
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
  const tagPtr = B.tmp();
  const tagValue = B.tmp();
  B.line(`${tagPtr} = getelementptr inbounds %ScrUnion, ptr %u, i64 0, i32 1`);
  B.line(`${tagValue} = load i32, ptr ${tagPtr}`);
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
    const payloadPtr = B.tmp();
    const payload = B.tmp();
    const boxed = B.tmp();
    B.line(`${payloadPtr} = getelementptr inbounds %ScrUnion, ptr %u, i64 0, i32 5`);
    B.line(`${payload} = load ptr, ptr ${payloadPtr}`);
    B.line(
      `${boxed} = call ptr ${typedRefConstructor(host.shapeHost, arm)}(ptr ${payload}, ptr ${rc.retain}, ptr ${rc.release}, ptr ${host.cstr(armKey)}, ${host.sizeType} ${Buffer.byteLength(armKey, "utf8")}, ptr @${adapter.snapshot}, ptr ${adapter.commit})`,
    );
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
      const payloadPtr = B.tmp();
      const payload = B.tmp();
      const boxed = B.tmp();
      B.line(`${payloadPtr} = getelementptr inbounds %ScrUnion, ptr %u, i64 0, i32 5`);
      B.line(`${payload} = load ptr, ptr ${payloadPtr}`);
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
  if (t.kind === "bytes" || (!streamTypedRefEligible(t) && !isDynTypedRefType(t))) {
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
  return boxed;
}

export function streamTypedRefMaterializeAdapter(
  host: LlvmEmitterContext,
  t: IrType,
): LlStreamTypedRefAdapter {
  const key = typeKey(t);
  const existing = host.liveDynRefAdapters.get(key);
  if (existing) return existing;
  // The converter depends only on the static type. Intern the complete
  // graph across roots and union arms so recursive types emit once.
  const snapshot = `sc_ldr_${host.liveDynRefAdapters.size}_materialize`;
  const adapter: LlStreamTypedRefAdapter = { snapshot, commit: "null" };
  host.liveDynRefAdapters.set(key, adapter);
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
      return adapter;
    }
  }
  // Publish both symbols before their bodies: class-array and callback
  // converters can request this same adapter while emitting the commit.
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
    for (const field of meta.def.fields.filter(
      (f) =>
        isClassOwnEnumerableFieldName(f.name) &&
        !(meta.root.def.name === "%Error" && (f.name === "message" || f.name === "name")),
    )) {
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
      const { index } = classFieldIndex(meta, field.name);
      const fieldPtr = B.tmp();
      let fieldValue = B.tmp();
      B.line(
        `${fieldPtr} = getelementptr inbounds %${classStructSym(t.className)}, ptr %p, i64 0, i32 ${index}`,
      );
      B.line(`${fieldValue} = load ${llFieldType(field.type)}, ptr ${fieldPtr}`);
      if (llFieldType(field.type) === "i8") {
        const boolValue = B.tmp();
        B.line(`${boolValue} = trunc i8 ${fieldValue} to i1`);
        fieldValue = boolValue;
      }
      const boxed = host.streamTypedRefBoxValue(B, field.type, fieldValue);
      B.line(
        `call void @scr_dyn_obj_set(ptr ${out}, ptr ${host.cstr(field.name)}, ${host.sizeType} ${Buffer.byteLength(field.name, "utf8")}, ptr ${boxed})`,
      );
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
      B.line(`${fieldValue} = load ${llFieldType(field.type)}, ptr ${fieldPtr}`);
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
          host.declare(`declare zeroext i1 @scr_dyn_has_own_computed(ptr, ptr)`);
          B.line(
            `${initialized} = call zeroext i1 @scr_dyn_has_own_computed(ptr ${out}, ptr ${key})`,
          );
        } else B.line(`${initialized} = icmp ne ptr ${fieldValue}, null`);
        B.condBr(initialized, present, afterSymbol);
        B.startBlock(present);
      }
      if (llFieldType(field.type) === "i8") {
        const boolValue = B.tmp();
        B.line(`${boolValue} = trunc i8 ${fieldValue} to i1`);
        fieldValue = boolValue;
      }
      const value = host.streamTypedRefBoxValue(B, field.type, fieldValue);
      host.declare(`declare void @scr_dyn_symbol_key_set(ptr, ptr, ptr)`);
      host.declare(`declare void @scr_dyn_release_v(ptr)`);
      B.line(`call void @scr_dyn_symbol_key_set(ptr ${out}, ptr ${key}, ptr ${value})`);
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
        const index = shape.fields.indexOf(field) + 1;
        const fieldPtr = B.tmp();
        let fieldValue = B.tmp();
        B.line(
          `${fieldPtr} = getelementptr inbounds %${mangleRecordStruct(t.shapeId)}, ptr %p, i64 0, i32 ${index}`,
        );
        B.line(`${fieldValue} = load ${llFieldType(field.type)}, ptr ${fieldPtr}`);
        if (llFieldType(field.type) === "i8") {
          const boolValue = B.tmp();
          B.line(`${boolValue} = trunc i8 ${fieldValue} to i1`);
          fieldValue = boolValue;
        }
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
      const order = shape.declaredOrder ?? shape.fields.map((field) => field.name);
      const inOrder = new Set(order);
      const fields = [
        ...order.map((name) => byName.get(name)).filter((field) => field !== undefined),
        ...shape.fields.filter((field) => !inOrder.has(field.name)),
      ];
      for (const field of fields) {
        const index = shape.fields.indexOf(field) + 1;
        const fieldPtr = B.tmp();
        let fieldValue = B.tmp();
        B.line(
          `${fieldPtr} = getelementptr inbounds %${mangleRecordStruct(t.shapeId)}, ptr %p, i64 0, i32 ${index}`,
        );
        B.line(`${fieldValue} = load ${llFieldType(field.type)}, ptr ${fieldPtr}`);
        if (llFieldType(field.type) === "i8") {
          const boolValue = B.tmp();
          B.line(`${boolValue} = trunc i8 ${fieldValue} to i1`);
          fieldValue = boolValue;
        }
        // An ABSENT optional field contributes no key.
        const undefinedTag = undefinedArmTag(field.type, host.unionsById);
        let skip: string | null = null;
        if (undefinedTag >= 0) {
          const absent = emitFieldAbsentTest(B, fieldValue, undefinedTag);
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
      const tagPtr = B.tmp();
      const tagValue = B.tmp();
      B.line(`${tagPtr} = getelementptr inbounds %ScrUnion, ptr ${value}, i64 0, i32 1`);
      B.line(`${tagValue} = load i32, ptr ${tagPtr}`);
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
        const payloadPtr = B.tmp();
        const payload = B.tmp();
        const armBoxed = B.tmp();
        B.line(`${payloadPtr} = getelementptr inbounds %ScrUnion, ptr ${value}, i64 0, i32 5`);
        B.line(`${payload} = load ptr, ptr ${payloadPtr}`);
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
    if (streamTypedRefEligible(elem)) {
      const adapter = host.liveDynRefAdapter(elem);
      snapshot = adapter.snapshot;
      commit = adapter.commit;
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
