/* Focused LLVM expression emission extracted from emitter.ts. */
import { InternalCompilerError } from "../../errors.js";
import { streamTypedRefEligible } from "../../ir/analysis.js";
import { IrType, isRefCounted, typeKey } from "../../ir/ir.js";
import { mangleRecordStruct } from "../mangle.js";
import { BlockBuilder } from "./blocks.js";
import { FN_ATTRS, llFieldType, releaseSym, traceArg, vAdapters } from "./shapes.js";
import type { LlvmEmitterContext, LlStreamTypedRefAdapter, LlStreamTypedRefContext } from "./expr-context.js";

export function dynPromiseAdapter(host: LlvmEmitterContext, inner: IrType): string {
    if (!isRefCounted(inner) || inner.kind === "dyn") {
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
      `${value} = call ptr @${host.dyn.dynCheckHelper(inner)}(ptr ${dyn}, ptr null)`,
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
    if (inner.kind === "string") {
      host.declare(`declare void @scr_promise_fulfill_str(ptr, ptr)`);
      B.line(`call void @scr_promise_fulfill_str(ptr %dst, ptr ${value})`);
    } else {
      const rc = vAdapters(host, inner);
      host.declare(`declare void @scr_promise_fulfill_ref(ptr, ptr, ptr, ptr, ptr)`);
      B.line(
        `call void @scr_promise_fulfill_ref(ptr %dst, ptr ${value}, ptr ${rc.retain}, ptr ${rc.release}, ptr ${traceArg(host, inner)})`,
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

export function streamTypedRefCommitAdapter(host: LlvmEmitterContext,
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
      host.resolveThunkDefs.push(
        `define internal void @${commit}(ptr %target, ptr %d) ${FN_ATTRS} { ; commit live stream element ${typeKey(t)}`,
        `entry:`,
        `  %next = call ptr @${check}(ptr %d, ptr null)`,
        `  %missing = icmp eq ptr %next, null`,
        `  br i1 %missing, label %done, label %swap`,
        `swap:`,
        `  %target_len_ptr = getelementptr inbounds %ScrArr, ptr %target, i64 0, i32 1`,
        `  %next_len_ptr = getelementptr inbounds %ScrArr, ptr %next, i64 0, i32 1`,
        `  %target_len = load ${host.sizeType}, ptr %target_len_ptr`,
        `  %next_len = load ${host.sizeType}, ptr %next_len_ptr`,
        `  store ${host.sizeType} %next_len, ptr %target_len_ptr`,
        `  store ${host.sizeType} %target_len, ptr %next_len_ptr`,
        `  %target_cap_ptr = getelementptr inbounds %ScrArr, ptr %target, i64 0, i32 2`,
        `  %next_cap_ptr = getelementptr inbounds %ScrArr, ptr %next, i64 0, i32 2`,
        `  %target_cap = load ${host.sizeType}, ptr %target_cap_ptr`,
        `  %next_cap = load ${host.sizeType}, ptr %next_cap_ptr`,
        `  store ${host.sizeType} %next_cap, ptr %target_cap_ptr`,
        `  store ${host.sizeType} %target_cap, ptr %next_cap_ptr`,
        `  %target_data_ptr = getelementptr inbounds %ScrArr, ptr %target, i64 0, i32 7`,
        `  %next_data_ptr = getelementptr inbounds %ScrArr, ptr %next, i64 0, i32 7`,
        `  %target_data = load ptr, ptr %target_data_ptr`,
        `  %next_data = load ptr, ptr %next_data_ptr`,
        `  store ptr %next_data, ptr %target_data_ptr`,
        `  store ptr %target_data, ptr %next_data_ptr`,
        `  call void @scr_arr_release(ptr %next)`,
        `  br label %done`,
        `done:`,
        `  ret void`,
        `}`,
        ``,
      );
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
        ? [{
            index: shape.fields.length + 1,
            type: "ptr" as const,
            name: "[key: string] overflow",
          }]
        : []),
    ];
    members.forEach((member, index) => {
      lines.push(
        `  %tp${index} = getelementptr inbounds %${mangleRecordStruct(t.shapeId)}, ptr %target, i64 0, i32 ${member.index}`,
        `  %np${index} = getelementptr inbounds %${mangleRecordStruct(t.shapeId)}, ptr %next, i64 0, i32 ${member.index}`,
        `  %old${index} = load ${member.type}, ptr %tp${index} ; ${member.name}`,
        `  %new${index} = load ${member.type}, ptr %np${index}`,
        `  store ${member.type} %new${index}, ptr %tp${index}`,
        `  store ${member.type} %old${index}, ptr %np${index}`,
      );
    });
    lines.push(
      `  call void ${releaseSym(host, t)}(ptr %next)`,
      `  br label %done`,
      `done:`,
      `  ret void`,
      `}`,
      ``,
    );
    host.resolveThunkDefs.push(...lines);
    return `@${commit}`;
  }

export function liveDynUnionRefAdapter(host: LlvmEmitterContext,
    t: IrType & { kind: "union" },
  ): string {
    const key = typeKey(t);
    const existing = host.liveDynUnionRefAdapters.get(key);
    if (existing) return existing;
    const union = host.unionsById.get(t.unionId);
    if (!union) {
      throw new InternalCompilerError(
        `llvm emitter bug: live dyn ref of unknown union ${t.unionId}`,
      );
    }
    const mutableArms = union.arms
      .map((arm, tag) => ({ arm, tag }))
      .filter(({ arm }) => streamTypedRefEligible(arm));
    if (mutableArms.length === 0) {
      throw new InternalCompilerError(`llvm emitter bug: live dyn ref of immutable union ${key}`);
    }

    const sym = `sc_ldu_${host.liveDynUnionRefAdapters.size}`;
    host.liveDynUnionRefAdapters.set(key, sym);
    host.declare(
      `declare ptr @scr_dyn_new_typed_ref(ptr, ptr, ptr, ptr, ${host.sizeType}, ptr, ptr)`,
    );
    const adapters = new Map<number, LlStreamTypedRefAdapter>();
    for (const { arm, tag } of mutableArms) {
      const prefix = `${sym}_${tag}`;
      adapters.set(
        tag,
        host.streamTypedRefMaterializeAdapter(
          arm,
          { prefix, adapters: new Map() },
          `${prefix}_materialize`,
        ),
      );
    }

    const B = new BlockBuilder();
    const tagPtr = B.tmp();
    const tagValue = B.tmp();
    B.line(
      `${tagPtr} = getelementptr inbounds %ScrUnion, ptr %u, i64 0, i32 1`,
    );
    B.line(`${tagValue} = load i32, ptr ${tagPtr}`);
    const fallback = B.newLabel("ldu.dyn");
    const armLabels = mutableArms.map(() => B.newLabel("ldu.ref"));
    B.terminate(
      `switch i32 ${tagValue}, label %${fallback} [ ${mutableArms.map(({ tag }, index) => `i32 ${tag}, label %${armLabels[index]}`).join(" ")} ]`,
    );
    mutableArms.forEach(({ arm, tag }, index) => {
      const adapter = adapters.get(tag)!;
      const rc = vAdapters(host, arm);
      const armKey = typeKey(arm);
      B.startBlock(armLabels[index]!);
      const payloadPtr = B.tmp();
      const payload = B.tmp();
      const boxed = B.tmp();
      B.line(
        `${payloadPtr} = getelementptr inbounds %ScrUnion, ptr %u, i64 0, i32 5`,
      );
      B.line(`${payload} = load ptr, ptr ${payloadPtr}`);
      B.line(
        `${boxed} = call ptr @scr_dyn_new_typed_ref(ptr ${payload}, ptr ${rc.retain}, ptr ${rc.release}, ptr ${host.cstr(armKey)}, ${host.sizeType} ${Buffer.byteLength(armKey, "utf8")}, ptr @${adapter.snapshot}, ptr ${adapter.commit})`,
      );
      B.terminate(`ret ptr ${boxed}`);
    });
    B.startBlock(fallback);
    const boxed = B.tmp();
    B.line(`${boxed} = call ptr @${host.dyn.toDynHelper(t)}(ptr %u)`);
    B.terminate(`ret ptr ${boxed}`);
    host.resolveThunkDefs.push(
      `define internal ptr @${sym}(ptr %u) ${FN_ATTRS} { ; materialize live union value ${key}`,
      B.render(),
      `}`,
      ``,
    );
    return sym;
  }

export function streamTypedRefBoxValue(host: LlvmEmitterContext,
    B: BlockBuilder,
    t: IrType,
    value: string,
    ctx: LlStreamTypedRefContext,
  ): string {
    const boxed = B.tmp();
    if (!streamTypedRefEligible(t)) {
      const valueTy = t.kind === "f64"
        ? "double"
        : t.kind === "bool"
          ? "i1"
          : "ptr";
      B.line(
        `${boxed} = call ptr @${host.dyn.toDynHelper(t)}(${valueTy} ${value})`,
      );
      return boxed;
    }
    const nested = host.streamTypedRefMaterializeAdapter(t, ctx);
    const rc = vAdapters(host, t);
    const key = typeKey(t);
    host.declare(
      `declare ptr @scr_dyn_new_typed_ref(ptr, ptr, ptr, ptr, ${host.sizeType}, ptr, ptr)`,
    );
    B.line(
      `${boxed} = call ptr @scr_dyn_new_typed_ref(ptr ${value}, ptr ${rc.retain}, ptr ${rc.release}, ptr ${host.cstr(key)}, ${host.sizeType} ${Buffer.byteLength(key, "utf8")}, ptr @${nested.snapshot}, ptr ${nested.commit})`,
    );
    return boxed;
  }

export function streamTypedRefMaterializeAdapter(host: LlvmEmitterContext,
    t: IrType,
    ctx: LlStreamTypedRefContext,
    preferredSnapshot?: string,
  ): LlStreamTypedRefAdapter {
    const key = typeKey(t);
    const existing = ctx.adapters.get(key);
    if (existing) return existing;
    const snapshot = preferredSnapshot ??
      `${ctx.prefix}_nested_${ctx.adapters.size}`;
    const adapter: LlStreamTypedRefAdapter = { snapshot, commit: "null" };
    ctx.adapters.set(key, adapter);
    adapter.commit = host.streamTypedRefCommitAdapter(t, snapshot);
    const B = new BlockBuilder();

    if (t.kind === "record") {
      const shape = host.recordsById.get(t.shapeId);
      if (!shape) {
        throw new InternalCompilerError(
          `llvm emitter bug: stream typed-ref materialize of unknown shape ${t.shapeId}`,
        );
      }
      /* Keep the ordinary converter for index-signature/listener records;
       * their source-identity and overflow walks have extra contracts.
       * Declared-field records and tuples cover the live stream values. */
      const ordinary = shape.indexValue || shape.fields.some(
        (field) => field.name === "handleEvent" && field.type.kind === "func",
      );
      if (ordinary) {
        const out = B.tmp();
        B.line(`${out} = call ptr @${host.dyn.toDynHelper(t)}(ptr %p)`);
        B.terminate(`ret ptr ${out}`);
      } else if (shape.tuple) {
        host.declare(`declare ptr @scr_dyn_new_arr()`);
        host.declare(`declare void @scr_dyn_arr_push(ptr, ptr)`);
        const out = B.tmp();
        B.line(`${out} = call ptr @scr_dyn_new_arr()`);
        const fields = [...shape.fields].sort(
          (a, b) => Number(a.name) - Number(b.name),
        );
        for (const field of fields) {
          const index = shape.fields.indexOf(field) + 1;
          const fieldPtr = B.tmp();
          let fieldValue = B.tmp();
          B.line(`${fieldPtr} = getelementptr inbounds %${mangleRecordStruct(t.shapeId)}, ptr %p, i64 0, i32 ${index}`);
          B.line(`${fieldValue} = load ${llFieldType(field.type)}, ptr ${fieldPtr}`);
          if (llFieldType(field.type) === "i8") {
            const boolValue = B.tmp();
            B.line(`${boolValue} = trunc i8 ${fieldValue} to i1`);
            fieldValue = boolValue;
          }
          const boxed = host.streamTypedRefBoxValue(
            B,
            field.type,
            fieldValue,
            ctx,
          );
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
          B.line(`${fieldPtr} = getelementptr inbounds %${mangleRecordStruct(t.shapeId)}, ptr %p, i64 0, i32 ${index}`);
          B.line(`${fieldValue} = load ${llFieldType(field.type)}, ptr ${fieldPtr}`);
          if (llFieldType(field.type) === "i8") {
            const boolValue = B.tmp();
            B.line(`${boolValue} = trunc i8 ${fieldValue} to i1`);
            fieldValue = boolValue;
          }
          const boxed = host.streamTypedRefBoxValue(
            B,
            field.type,
            fieldValue,
            ctx,
          );
          B.line(`call void @scr_dyn_obj_set(ptr ${out}, ptr ${host.cstr(field.name)}, ${host.sizeType} ${Buffer.byteLength(field.name, "utf8")}, ptr ${boxed})`);
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
        const boxed = host.streamTypedRefBoxValue(B, elem, value, ctx);
        B.line(`call void @scr_dyn_arr_push(ptr ${out}, ptr ${boxed})`);
        if (isRefCounted(elem)) {
          B.line(`call void ${releaseSym(host, elem)}(ptr ${value})`);
        }
      });
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

export function streamFromArrayAdapter(host: LlvmEmitterContext,
    t: IrType & { kind: "array" },
  ): string {
    const elem = t.elem;
    const key = typeKey(elem);
    const existing = host.streamFromArrayAdapters.get(key);
    if (existing) return existing;
    const sym = `sc_sfa_${host.streamFromArrayAdapters.size}`;
    host.streamFromArrayAdapters.set(key, sym);
    const B = new BlockBuilder();
    const unionDef = elem.kind === "union"
      ? host.unionsById.get(elem.unionId)
      : undefined;
    if (elem.kind === "union" && !unionDef) {
      throw new InternalCompilerError(`llvm emitter bug: streamFrom of unknown union ${elem.unionId}`);
    }
    const unionRefArms = unionDef?.arms
      .map((arm, tag) => ({ arm, tag }))
      .filter(({ arm }) =>
        isRefCounted(arm) && arm.kind !== "dyn" && arm.kind !== "string"
      ) ?? [];
    const typedRef = isRefCounted(elem) &&
      elem.kind !== "dyn" &&
      elem.kind !== "string" &&
      elem.kind !== "union";
    const snapshot = `${sym}_materialize`;
    let value: string;
    if (elem.kind === "f64") {
      host.declare(`declare double @scr_arr_get_f64(ptr, double)`);
      value = B.tmp();
      B.line(
        `${value} = call double @scr_arr_get_f64(ptr %a, double %i)`,
      );
    } else if (elem.kind === "bool") {
      host.declare(`declare zeroext i1 @scr_arr_get_bool(ptr, double)`);
      value = B.tmp();
      B.line(
        `${value} = call i1 @scr_arr_get_bool(ptr %a, double %i)`,
      );
    } else {
      host.declare(`declare ptr @scr_arr_get_ref(ptr, double)`);
      value = B.tmp();
      B.line(
        `${value} = call ptr @scr_arr_get_ref(ptr %a, double %i) ; +1`,
      );
    }
    let boxed: string;
    const valueTy =
      elem.kind === "f64" ? "double" : elem.kind === "bool" ? "i1" : "ptr";
    if (elem.kind === "union") {
      if (unionRefArms.length === 0) {
        boxed = B.tmp();
        B.line(
          `${boxed} = call ptr @${host.dyn.toDynHelper(elem)}(ptr ${value})`,
        );
      } else {
        host.declare(
          `declare ptr @scr_dyn_new_typed_ref(ptr, ptr, ptr, ptr, ${host.sizeType}, ptr, ptr)`,
        );
        const boxedSlot = B.slot();
        B.entryAllocas.push(`${boxedSlot} = alloca ptr`);
        const tagPtr = B.tmp();
        const tagValue = B.tmp();
        B.line(
          `${tagPtr} = getelementptr inbounds %ScrUnion, ptr ${value}, i64 0, i32 1`,
        );
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
          const armCommit = host.streamTypedRefCommitAdapter(
            arm,
            armSnapshot,
          );
          const rc = vAdapters(host, arm);
          B.startBlock(armLabels[i]!);
          const payloadPtr = B.tmp();
          const payload = B.tmp();
          const armBoxed = B.tmp();
          B.line(
            `${payloadPtr} = getelementptr inbounds %ScrUnion, ptr ${value}, i64 0, i32 5`,
          );
          B.line(`${payload} = load ptr, ptr ${payloadPtr}`);
          B.line(
            `${armBoxed} = call ptr @scr_dyn_new_typed_ref(ptr ${payload}, ptr ${rc.retain}, ptr ${rc.release}, ptr ${host.cstr(armKey)}, ${host.sizeType} ${Buffer.byteLength(armKey, "utf8")}, ptr @${armSnapshot}, ptr ${armCommit})`,
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
        B.line(
          `${dynBoxed} = call ptr @${host.dyn.toDynHelper(elem)}(ptr ${value})`,
        );
        B.line(`store ptr ${dynBoxed}, ptr ${boxedSlot}`);
        B.br(join);
        B.startBlock(join);
        boxed = B.tmp();
        B.line(`${boxed} = load ptr, ptr ${boxedSlot}`);
      }
    } else if (typedRef) {
      boxed = B.tmp();
      const rc = vAdapters(host, elem);
      const keyPtr = host.cstr(key);
      let commit: string;
      if (streamTypedRefEligible(elem)) {
        commit = host.streamTypedRefMaterializeAdapter(
          elem,
          { prefix: snapshot, adapters: new Map() },
          snapshot,
        ).commit;
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
      host.declare(
        `declare ptr @scr_dyn_new_typed_ref(ptr, ptr, ptr, ptr, ${host.sizeType}, ptr, ptr)`,
      );
      B.line(
        `${boxed} = call ptr @scr_dyn_new_typed_ref(ptr ${value}, ptr ${rc.retain}, ptr ${rc.release}, ptr ${keyPtr}, ${host.sizeType} ${Buffer.byteLength(key, "utf8")}, ptr @${snapshot}, ptr ${commit})`,
      );
    } else {
      boxed = B.tmp();
      B.line(
        `${boxed} = call ptr @${host.dyn.toDynHelper(elem)}(${valueTy} ${value})`,
      );
    }
    if (isRefCounted(elem)) {
      B.line(`call void ${releaseSym(host, elem)}(ptr ${value})`);
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
