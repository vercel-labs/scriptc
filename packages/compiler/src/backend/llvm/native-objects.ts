import { InternalCompilerError } from "../../errors.js";
import { undefinedArmTag } from "../../ir/analysis.js";
import {
  accessorSlotProp,
  canDynCheckTo,
  DYN_CLASS_PROPERTIES,
  isClassOwnEnumerableField,
  isRefCounted,
  NATIVE_PROPERTY_OPERATION,
  typeKey,
  type NativePropertyOperation,
  type IrType,
} from "../../ir/ir.js";
import { wtf8Bytes } from "../literals.js";
import { mangleFunction, mangleRecordStruct } from "../mangle.js";
import { nativeRecordIntegrityEligible } from "../../ir/native-integrity.js";
import { BlockBuilder } from "./blocks.js";
import { readClassFieldValue } from "./class-field-values.js";
import { classFieldIndex, classStructSym, type LlClassMeta } from "./classes.js";
import type { ExprOf, LlValue, LlvmEmitterContext } from "./expr-context.js";
import { storeInlineUnion, unionBoxBits } from "./inline-unions.js";
import { recordSourceFieldOrder } from "./record-sources.js";
import { FN_ATTRS, llFieldType, loadStructField, releaseSym, vAdapters } from "./shapes.js";
import { emitUnionPeek, emitUnionTag } from "./union-repr.js";
import { LlvmUnsupportedError } from "./unsupported.js";

interface NativeReadPart {
  part: number;
  name: string;
  slot: number;
  type: IrType;
}

/** Getter-free property facts, independent of optional snapshot/read hooks.
 * A predicate must not materialize child values or call an accessor. */
export class LlNativeObjects {
  private readonly tables = new Map<string, string>();
  private readonly emitted = new Set<string>();

  constructor(private readonly host: LlvmEmitterContext) {}

  tracksField(type: IrType, key: string): boolean {
    const host = this.host;
    if (type.kind === "record")
      return (
        !!host.nativeIntegrityTypes?.recordGuarded(type.shapeId) &&
        nativeRecordIntegrityEligible(host.recordsById.get(type.shapeId)!) &&
        !accessorSlotProp(key)
      );
    if (type.kind !== "object") return false;
    const meta = host.classMeta.get(type.className);
    return (
      !!meta?.def.nativePropertyBagHelper &&
      !meta.def.symbolFields?.length &&
      isClassOwnEnumerableField(meta.def.fields.find((field) => field.name === key))
    );
  }

  finishWrite(
    object: string,
    type: IrType,
    key: string,
    operation: NativePropertyOperation = "set",
  ): void {
    const host = this.host;
    if (!this.tracksField(type, key)) return;
    host.declare("declare void @scr_native_object_finish_write(ptr, ptr, ptr, i32)");
    host.B.line(
      `call void @scr_native_object_finish_write(ptr ${object}, ptr ${this.ops(type)}, ptr ${host.internLiteral(key)}, i32 ${NATIVE_PROPERTY_OPERATION[operation]})`,
    );
  }

  /** Opaque views can still expose integrity. Unsupported runtime families
   * remain honest unbound capsules; ordinary boxing must not require a view. */
  optionalOps(type: IrType): string | null {
    return this.reserveOps(type) === null ? null : this.ops(type);
  }

  /** Reserve metadata before any field boxer can recursively request the
   * containing adapter. Its recipe must already carry this capability. */
  reserveOps(type: IrType): string | null {
    if (type.kind === "record") {
      const shape = this.host.recordsById.get(type.shapeId);
      if (!shape || !nativeRecordIntegrityEligible(shape)) return null;
    } else if (type.kind === "object") {
      const meta = this.host.classMeta.get(type.className);
      if (!meta || meta.root.def.runtime || !meta.def.nativePropertyBagHelper) return null;
      if (!meta.def.tracksOwnFields || meta.def.symbolFields?.length)
        throw new LlvmUnsupportedError(`native integrity class:${type.className}`);
    } else return null;
    const key = typeKey(type);
    let table = this.tables.get(key);
    if (!table) {
      table = `@sc_native_${this.tables.size}_ops`;
      this.tables.set(key, table);
    }
    return table;
  }

  ops(type: IrType): string {
    const host = this.host;
    const table = this.reserveOps(type);
    if (table === null) throw new LlvmUnsupportedError(`native integrity:${typeKey(type)}`);
    if (this.emitted.has(table)) return table;
    // Mark before emitting bodies: field reads and descendant tables can
    // re-enter this owner while its reserved definition is still pending.
    this.emitted.add(table);
    const symbol = table.slice(1, -4);
    if (type.kind === "object") return this.classOps(type, symbol, table);
    if (type.kind !== "record") throw new LlvmUnsupportedError(`native integrity:${type.kind}`);
    const shape = host.recordsById.get(type.shapeId)!;
    const fields: { name: string; slot: number; accessor: boolean }[] = [];
    for (const nameInOrder of recordSourceFieldOrder(shape)) {
      const index = shape.fields.findIndex((field) => field.name === nameInOrder);
      const field = shape.fields[index]!;
      const accessor = accessorSlotProp(field.name);
      if (!accessor && shape.declaredOrder && !shape.declaredOrder.includes(field.name)) continue;
      const name = accessor?.prop ?? field.name;
      if (fields.some((entry) => entry.name === name)) continue;
      fields.push({ name, slot: index + 1, accessor: accessor !== null });
    }
    const B = new BlockBuilder();
    const labels = fields.map(() => B.newLabel("native.fact"));
    const absent = B.newLabel("native.absent");
    B.terminate(
      `switch ${host.sizeType} %i, label %${absent} [ ${fields.map((_, i) => `${host.sizeType} ${i}, label %${labels[i]}`).join(" ")} ]`,
    );
    fields.forEach((entry, i) => {
      B.startBlock(labels[i]!);
      const field = shape.fields[entry.slot - 1]!;
      if (
        !entry.accessor &&
        field.type.kind === "union" &&
        undefinedArmTag(field.type, host.unionsById) >= 0
      ) {
        const slot = B.tmp();
        B.line(
          `${slot} = getelementptr inbounds %${mangleRecordStruct(type.shapeId)}, ptr %p, i64 0, i32 ${entry.slot}`,
        );
        const value = loadStructField(
          B,
          host.sizeType,
          slot,
          field.type,
          host.inlineUnions.record(field.type),
        );
        const missing = host.fieldAbsentTestIn(B, value, field.type.unionId);
        const facts = B.tmp();
        B.line(`${facts} = select i1 ${missing}, i32 0, i32 31`);
        B.terminate(`ret i32 ${facts}`);
      } else B.terminate(`ret i32 ${entry.accessor ? 25 : 31}`);
    });
    B.startBlock(absent);
    B.terminate("ret i32 0");
    this.read(
      type,
      symbol,
      fields.map((entry) => {
        const parts: NativeReadPart[] = [];
        for (const [index, field] of shape.fields.entries()) {
          const accessor = accessorSlotProp(field.name);
          if ((accessor?.prop ?? field.name) !== entry.name) continue;
          const part = accessor ? (accessor.kind === "get" ? 1 : 2) : 0;
          parts.push({ part, name: field.name, slot: index + 1, type: field.type });
        }
        return parts;
      }),
    );
    let prepare = "null",
      apply = "null";
    // Raw accessor slots do not encode their logical key's declaration
    // position. Keep that admission separate until the IR records the order.
    if (!fields.some((field) => field.accessor)) {
      if (!host.liveViewsReadOnly)
        apply = this.apply(
          type,
          symbol,
          fields.map((field) => ({ ...field, type: shape.fields[field.slot - 1]!.type })),
        );
      const names = host.dyn.recordNameTable(type.shapeId, shape);
      prepare = `@${symbol}_prepare`;
      host.declare(
        `declare zeroext i1 @scr_record_source_prepare(ptr, ptr, ptr, ${host.sizeType}, ptr)`,
      );
      host.resolveThunkDefs.push(
        `define internal zeroext i1 ${prepare}(ptr %p) ${FN_ATTRS} {`,
        "entry:",
        `  %prepared = call zeroext i1 @scr_record_source_prepare(ptr %p, ptr ${names.names}, ptr ${names.lens}, ${host.sizeType} ${shape.fields.length}, ptr ${table})`,
        "  ret i1 %prepared",
        "}",
        "",
      );
    }
    host.declare("declare ptr @scr_record_source_view(ptr)");
    host.resolveThunkDefs.push(
      `define internal i32 @${symbol}_facts(ptr %p, ${host.sizeType} %i) ${FN_ATTRS} {`,
      B.render(),
      "}",
      "",
      `@${symbol}_names = internal constant [${fields.length} x ptr] [${fields.map((field) => `ptr ${host.cstr(field.name)}`).join(", ")}]`,
      `@${symbol}_lengths = internal constant [${fields.length} x ${host.sizeType}] [${fields.map((field) => `${host.sizeType} ${wtf8Bytes(field.name).length}`).join(", ")}]`,
      `${table} = internal constant { ptr, ${host.sizeType}, ptr, ptr, ptr, ptr, ptr, ptr, ptr, ptr, ptr } { ptr null, ${host.sizeType} ${fields.length}, ptr @${symbol}_names, ptr @${symbol}_lengths, ptr @${symbol}_facts, ptr @scr_record_source_view, ptr ${prepare}, ptr null, ptr @${symbol}_read, ptr ${apply}, ptr null }`,
      "",
    );
    return table;
  }

  private classOps(
    type: Extract<IrType, { kind: "object" }>,
    symbol: string,
    table: string,
  ): string {
    const host = this.host;
    const meta = host.classMeta.get(type.className)!;
    const fields = meta.def.fields.filter(isClassOwnEnumerableField);
    const { index } = classFieldIndex(meta, DYN_CLASS_PROPERTIES);
    host.declare("declare ptr @scr_native_property_bag(ptr)");
    host.declare(`declare i32 @scr_native_property_bag_facts(ptr, ptr, ${host.sizeType})`);
    const P = new BlockBuilder(),
      slot = P.tmp(),
      raw = P.tmp(),
      bag = P.tmp();
    P.line(
      `${slot} = getelementptr inbounds %${classStructSym(type.className)}, ptr %p, i64 0, i32 ${index}`,
    );
    P.line(`${raw} = load ptr, ptr ${slot}`);
    P.line(`${bag} = call ptr @scr_native_property_bag(ptr ${raw})`);
    P.terminate(`ret ptr ${bag}`);
    const F = new BlockBuilder(),
      properties = F.tmp();
    F.line(`${properties} = call ptr @${symbol}_properties(ptr %p)`);
    const labels = fields.map(() => F.newLabel("native.fact")),
      absent = F.newLabel("native.absent");
    F.terminate(
      `switch ${host.sizeType} %i, label %${absent} [ ${fields.map((_, i) => `${host.sizeType} ${i}, label %${labels[i]}`).join(" ")} ]`,
    );
    fields.forEach((field, i) => {
      F.startBlock(labels[i]!);
      const facts = F.tmp();
      F.line(
        `${facts} = call i32 @scr_native_property_bag_facts(ptr ${properties}, ptr ${host.cstr(field.name)}, ${host.sizeType} ${wtf8Bytes(field.name).length})`,
      );
      F.terminate(`ret i32 ${facts}`);
    });
    F.startBlock(absent);
    F.terminate("ret i32 0");

    this.read(
      type,
      symbol,
      fields.map((field) => [{ part: 0, name: field.name, slot: 0, type: field.type }]),
    );

    // Preparation borrows the native receiver, while the generated helper
    // owns its parameter and result. Preserve a pending thrown value exactly.
    const B = new BlockBuilder(),
      owned = B.tmp(),
      prepared = B.tmp(),
      pending = B.tmp(),
      ok = B.tmp();
    host.declare("declare void @scr_dyn_release_v(ptr)");
    host.declare("declare zeroext i1 @scr_exc_pending()");
    B.line(`${owned} = call ptr ${vAdapters(host.shapeHost, type).retain}(ptr %p)`);
    B.line(
      `${prepared} = call ptr @${mangleFunction(meta.def.nativePropertyBagHelper!)}(ptr ${owned})`,
    );
    B.line(`call void @scr_dyn_release_v(ptr ${prepared})`);
    B.line(`${pending} = call zeroext i1 @scr_exc_pending()`);
    B.line(`${ok} = xor i1 ${pending}, true`);
    B.terminate(`ret i1 ${ok}`);

    // Generated prototype helpers own their receiver, but never store a
    // context-local default edge in the instance's publishable own bag.
    const D = new BlockBuilder(),
      prototype = D.tmp();
    const hasPrototype = !!(meta.def.instancePrototypeHelper || meta.def.prototypeDataHelper);
    if (meta.def.instancePrototypeHelper) {
      const receiver = D.tmp();
      D.line(`${receiver} = call ptr ${vAdapters(host.shapeHost, type).retain}(ptr %p)`);
      D.line(
        `${prototype} = call ptr @${mangleFunction(meta.def.instancePrototypeHelper)}(ptr ${receiver})`,
      );
    } else if (meta.def.prototypeDataHelper) {
      D.line(`${prototype} = call ptr @${mangleFunction(meta.def.prototypeDataHelper)}()`);
    }
    if (hasPrototype) D.terminate(`ret ptr ${prototype}`);

    const descendants = (parent: LlClassMeta): LlClassMeta[] =>
      parent.children.flatMap((child) => [child, ...descendants(child)]);
    // A type-only descendant still has a layout but no preparation helper.
    // Filter after traversal so it cannot hide retained grandchildren.
    const children = descendants(meta).filter((child) => child.constructorRetained);
    let exact = "null";
    if (children.length) {
      exact = `@${symbol}_exact`;
      const E = new BlockBuilder(),
        vtSlot = E.tmp(),
        vt = E.tmp(),
        preSlot = E.tmp(),
        pre = E.tmp();
      E.line(
        `${vtSlot} = getelementptr inbounds %${classStructSym(type.className)}, ptr %p, i64 0, i32 1`,
      );
      E.line(`${vt} = load ptr, ptr ${vtSlot}`);
      E.line(`${preSlot} = getelementptr inbounds %ScrVt, ptr ${vt}, i64 0, i32 0`);
      E.line(`${pre} = load ${host.sizeType}, ptr ${preSlot}`);
      for (const child of children) {
        const childOps = this.ops({ kind: "object", className: child.def.name });
        const match = E.tmp(),
          yes = E.newLabel("native.exact"),
          next = E.newLabel("native.next");
        E.line(`${match} = icmp eq ${host.sizeType} ${pre}, ${child.pre}`);
        E.condBr(match, yes, next);
        E.startBlock(yes);
        E.terminate(`ret ptr ${childOps}`);
        E.startBlock(next);
      }
      E.terminate(`ret ptr ${table}`);
      host.resolveThunkDefs.push(
        `define internal ptr ${exact}(ptr %p) ${FN_ATTRS} {`,
        E.render(),
        "}",
        "",
      );
    }
    const apply = host.liveViewsReadOnly
      ? "null"
      : this.apply(
          type,
          symbol,
          fields.map((field) => ({
            name: field.name,
            slot: classFieldIndex(meta, field.name).index,
            type: field.type,
          })),
        );
    host.resolveThunkDefs.push(
      `define internal ptr @${symbol}_properties(ptr %p) ${FN_ATTRS} {`,
      P.render(),
      "}",
      "",
      `define internal i32 @${symbol}_facts(ptr %p, ${host.sizeType} %i) ${FN_ATTRS} {`,
      F.render(),
      "}",
      "",
      `define internal zeroext i1 @${symbol}_prepare(ptr %p) ${FN_ATTRS} {`,
      B.render(),
      "}",
      "",
      ...(hasPrototype
        ? [`define internal ptr @${symbol}_prototype(ptr %p) ${FN_ATTRS} {`, D.render(), "}", ""]
        : []),
      `@${symbol}_names = internal constant [${fields.length} x ptr] [${fields.map((field) => `ptr ${host.cstr(field.name)}`).join(", ")}]`,
      `@${symbol}_lengths = internal constant [${fields.length} x ${host.sizeType}] [${fields.map((field) => `${host.sizeType} ${wtf8Bytes(field.name).length}`).join(", ")}]`,
      `${table} = internal constant { ptr, ${host.sizeType}, ptr, ptr, ptr, ptr, ptr, ptr, ptr, ptr, ptr } { ptr ${exact}, ${host.sizeType} ${fields.length}, ptr @${symbol}_names, ptr @${symbol}_lengths, ptr @${symbol}_facts, ptr @${symbol}_properties, ptr @${symbol}_prepare, ptr ${meta.def.jsName === "" ? "null" : host.cstr(meta.def.jsName ?? meta.def.name.replace(/^%/, ""))}, ptr @${symbol}_read, ptr ${apply}, ptr ${hasPrototype ? `@${symbol}_prototype` : "null"} }`,
      "",
    );
    return table;
  }

  /** Conversion can mutate this receiver. Keep every sibling out of the
   * transaction, and do not load old ownership until callbacks have finished. */
  private apply(
    owner: Extract<IrType, { kind: "record" | "object" }>,
    symbol: string,
    fields: readonly { name: string; slot: number; type: IrType }[],
  ): string {
    const host = this.host,
      B = new BlockBuilder();
    const structure =
      owner.kind === "record" ? mangleRecordStruct(owner.shapeId) : classStructSym(owner.className);
    host.declare("declare zeroext i1 @scr_native_mutation_write(ptr)");
    host.declare("declare zeroext i1 @scr_native_mutation_delete(ptr)");
    host.declare("declare zeroext i1 @scr_native_mutation_refuse(ptr)");
    host.declare("declare ptr @scr_native_mutation_value(ptr)");
    host.declare("declare zeroext i1 @scr_native_mutation_recheck(ptr)");
    host.declare("declare void @scr_native_mutation_finish(ptr)");
    const write = B.tmp(),
      mutate = B.newLabel("native.mutate"),
      remove = B.newLabel("native.delete"),
      convert = B.newLabel("native.convert"),
      attributes = B.newLabel("native.attributes"),
      refused = B.newLabel("native.refused");
    B.line(`${write} = call zeroext i1 @scr_native_mutation_write(ptr %request)`);
    B.condBr(write, mutate, attributes);
    B.startBlock(mutate);
    const deleting = B.tmp();
    B.line(`${deleting} = call zeroext i1 @scr_native_mutation_delete(ptr %request)`);
    B.condBr(deleting, remove, convert);
    B.startBlock(attributes);
    const checked = B.tmp(),
      finish = B.newLabel("native.finish");
    B.line(`${checked} = call zeroext i1 @scr_native_mutation_recheck(ptr %request)`);
    B.condBr(checked, finish, refused);
    B.startBlock(finish);
    B.line("call void @scr_native_mutation_finish(ptr %request)");
    B.terminate("ret i1 true");
    B.startBlock(remove);
    if (owner.kind === "object") {
      // Class presence belongs to the bag. Deletion keeps physical ownership
      // until replacement or teardown, including slots absent from reflection.
      B.br(attributes);
    } else {
      const deleteLabels = fields.map(() => B.newLabel("native.delete.field"));
      B.terminate(
        `switch ${host.sizeType} %i, label %${refused} [ ${fields.map((_, i) => `${host.sizeType} ${i}, label %${deleteLabels[i]}`).join(" ")} ]`,
      );
      fields.forEach(({ slot, type }, index) => {
        B.startBlock(deleteLabels[index]!);
        if (type.kind !== "union" || undefinedArmTag(type, host.unionsById) < 0) {
          const rejected = B.tmp();
          B.line(`${rejected} = call zeroext i1 @scr_native_mutation_refuse(ptr %request)`);
          B.terminate(`ret i1 ${rejected}`);
          return;
        }
        const admitted = B.tmp(),
          store = B.newLabel("native.delete.store");
        B.line(`${admitted} = call zeroext i1 @scr_native_mutation_recheck(ptr %request)`);
        B.condBr(admitted, store, refused);
        B.startBlock(store);
        const address = B.tmp(),
          inline = host.inlineUnions.record(type),
          absent = host.absentInstanceRef(type.unionId);
        B.line(`${address} = getelementptr inbounds %${structure}, ptr %p, i64 0, i32 ${slot}`);
        // ABSENT is a storage state, not the ordinary undefined arm. Finish
        // order/descriptor metadata before releasing a child that can observe it.
        let old: string | undefined;
        if (inline) {
          const { tag, bits } = unionBoxBits(B, absent, host.unionNoneRef());
          storeInlineUnion(B, address, tag, bits);
        } else {
          old = B.tmp();
          B.line(`${old} = load ptr, ptr ${address}`);
          B.line(`store ptr ${absent}, ptr ${address}`);
        }
        B.line("call void @scr_native_mutation_finish(ptr %request)");
        if (old) B.line(`call void ${releaseSym(host.shapeHost, type)}(ptr ${old})`);
        B.terminate("ret i1 true");
      });
    }
    B.startBlock(convert);
    const input = B.tmp(),
      labels = fields.map(() => B.newLabel("native.apply.field"));
    B.line(`${input} = call ptr @scr_native_mutation_value(ptr %request)`);
    B.terminate(
      `switch ${host.sizeType} %i, label %${refused} [ ${fields.map((_, i) => `${host.sizeType} ${i}, label %${labels[i]}`).join(" ")} ]`,
    );
    fields.forEach(({ name, slot, type }, index) => {
      const inline =
          owner.kind === "record"
            ? host.inlineUnions.record(type)
            : host.inlineUnions.classField(owner.className, name),
        nullable = owner.kind === "object" ? host.nullableFields.get(owner.className, name) : null,
        int32 = owner.kind === "object" && host.int32Slots.isField(owner.className, name),
        owned = isRefCounted(type);
      B.startBlock(labels[index]!);
      // Readable opaque fields do not necessarily have a checked builder.
      // Preserve their reflection and attribute-only definitions without
      // generating an unsupported conversion for a value write.
      if (
        !canDynCheckTo(
          type,
          (id) => host.recordsById.get(id),
          (id) => host.unionsById.get(id),
        )
      ) {
        B.br(refused);
        return;
      }
      const converted = B.tmp(),
        pending = B.tmp();
      const cleanup = B.newLabel("native.apply.cleanup"),
        recheck = B.newLabel("native.apply.recheck");
      B.line(
        `${converted} = call ${type.kind === "bool" ? "zeroext i1" : host.llType(type)} @${host.dyn.dynCheckHelper(type)}(ptr ${input}, ptr null)`,
      );
      for (const line of host.pendingTestLines(pending)) B.line(line.trimStart());
      B.condBr(pending, cleanup, recheck);
      B.startBlock(recheck);
      const admitted = B.tmp(),
        admittedLabel = B.newLabel("native.apply.admitted");
      B.line(`${admitted} = call zeroext i1 @scr_native_mutation_recheck(ptr %request)`);
      B.condBr(admitted, admittedLabel, cleanup);
      B.startBlock(admittedLabel);
      const needed = B.tmp(),
        store = B.newLabel("native.apply.store"),
        unchanged = B.newLabel("native.apply.unchanged");
      B.line(`${needed} = call zeroext i1 @scr_native_mutation_write(ptr %request)`);
      B.condBr(needed, store, unchanged);
      B.startBlock(unchanged);
      B.line("call void @scr_native_mutation_finish(ptr %request)");
      if (owned) B.line(`call void ${releaseSym(host.shapeHost, type)}(ptr ${converted})`);
      B.terminate("ret i1 true");
      B.startBlock(store);
      const address = B.tmp();
      B.line(`${address} = getelementptr inbounds %${structure}, ptr %p, i64 0, i32 ${slot}`);
      let old: string | undefined;
      if (owned && !inline) {
        old = B.tmp();
        B.line(`${old} = load ptr, ptr ${address}`);
      }
      if (nullable) {
        // NullableRefFields contains only globally boxed unions. Its class
        // slot owns the payload; the checked wrapper remains ours to release.
        const tag = emitUnionTag(B, null, converted),
          payload = emitUnionPeek(B, null, converted),
          isRef = B.tmp(),
          selected = B.tmp(),
          next = B.tmp();
        const rc = vAdapters(host.shapeHost, nullable.arm);
        B.line(`${isRef} = icmp eq i32 ${tag}, ${nullable.refTag}`);
        B.line(`${selected} = select i1 ${isRef}, ptr ${payload}, ptr null`);
        B.line(`${next} = call ptr ${rc.retain}(ptr ${selected})`);
        B.line(`store ptr ${next}, ptr ${address}`);
      } else if (int32) {
        // Dynamic-store analysis proves this field's writes stay int32.
        // Preserve the whole-view bridge's exactness check at this owner.
        host.declare("declare i32 @llvm.fptosi.sat.i32.f64(double)");
        host.declare("declare void @llvm.trap()");
        const integer = B.tmp(),
          back = B.tmp(),
          bits = B.tmp(),
          backBits = B.tmp(),
          exact = B.tmp(),
          valid = B.newLabel("native.apply.int32"),
          trap = B.newLabel("native.apply.trap");
        B.line(`${integer} = call i32 @llvm.fptosi.sat.i32.f64(double ${converted})`);
        B.line(`${back} = sitofp i32 ${integer} to double`);
        B.line(`${bits} = bitcast double ${converted} to i64`);
        B.line(`${backBits} = bitcast double ${back} to i64`);
        B.line(`${exact} = icmp eq i64 ${bits}, ${backBits}`);
        B.condBr(exact, valid, trap);
        B.startBlock(trap);
        B.line("call void @llvm.trap()");
        B.terminate("unreachable");
        B.startBlock(valid);
        B.line(`store i32 ${integer}, ptr ${address}`);
      } else if (inline) {
        const { tag, bits } = unionBoxBits(B, converted, host.unionNoneRef());
        storeInlineUnion(B, address, tag, bits);
      } else if (type.kind === "bool") {
        const byte = B.tmp();
        B.line(`${byte} = zext i1 ${converted} to i8`);
        B.line(`store i8 ${byte}, ptr ${address}`);
      } else B.line(`store ${llFieldType(type, false)} ${converted}, ptr ${address}`);
      B.line("call void @scr_native_mutation_finish(ptr %request)");
      if (old) B.line(`call void ${releaseSym(host.shapeHost, nullable?.arm ?? type)}(ptr ${old})`);
      if (inline || nullable)
        B.line(`call void ${releaseSym(host.shapeHost, type)}(ptr ${converted})`);
      B.terminate("ret i1 true");
      B.startBlock(cleanup);
      if (owned) B.line(`call void ${releaseSym(host.shapeHost, type)}(ptr ${converted})`);
      B.terminate("ret i1 false");
    });
    B.startBlock(refused);
    B.terminate("ret i1 false");
    const apply = `@${symbol}_apply`;
    host.resolveThunkDefs.push(
      `define internal zeroext i1 ${apply}(ptr %p, ${host.sizeType} %i, ptr %request) ${FN_ATTRS} {`,
      B.render(),
      "}",
      "",
    );
    return apply;
  }

  /** Descriptor compatibility sometimes needs one current value or accessor
   * identity. Keep that observation independent from whole-object snapshots. */
  private read(
    owner: Extract<IrType, { kind: "record" | "object" }>,
    symbol: string,
    fields: NativeReadPart[][],
  ): void {
    const host = this.host,
      B = new BlockBuilder();
    const absent = B.newLabel("native.read.absent"),
      present = B.newLabel("native.read.present");
    const facts = B.tmp(),
      own = B.tmp(),
      exists = B.tmp();
    B.line(`${facts} = call i32 @${symbol}_facts(ptr %p, ${host.sizeType} %i)`);
    B.line(`${own} = and i32 ${facts}, 1`);
    B.line(`${exists} = icmp ne i32 ${own}, 0`);
    B.condBr(exists, present, absent);
    B.startBlock(present);
    const labels = fields.map(() => B.newLabel("native.read.field"));
    B.terminate(
      `switch ${host.sizeType} %i, label %${absent} [ ${fields.map((_, i) => `${host.sizeType} ${i}, label %${labels[i]}`).join(" ")} ]`,
    );
    fields.forEach((parts, i) => {
      B.startBlock(labels[i]!);
      const selected = parts.map((field) => ({
        field,
        label: B.newLabel("native.read.part"),
      }));
      B.terminate(
        `switch i32 %part, label %${absent} [ ${selected.map(({ field, label }) => `i32 ${field.part}, label %${label}`).join(" ")} ]`,
      );
      for (const { field, label } of selected) {
        B.startBlock(label);
        let value: string;
        if (owner.kind === "object")
          value = readClassFieldValue(host, B, owner.className, field, "%p");
        else {
          const slot = B.tmp();
          B.line(
            `${slot} = getelementptr inbounds %${mangleRecordStruct(owner.shapeId)}, ptr %p, i64 0, i32 ${field.slot}`,
          );
          const raw = loadStructField(
            B,
            host.sizeType,
            slot,
            field.type,
            host.inlineUnions.record(field.type),
          );
          value = host.streamTypedRefBoxValue(B, field.type, raw);
        }
        B.terminate(`ret ptr ${value}`);
      }
    });
    B.startBlock(absent);
    host.declare("declare ptr @scr_dyn_undefined()");
    const undefinedValue = B.tmp();
    B.line(`${undefinedValue} = call ptr @scr_dyn_undefined()`);
    B.terminate(`ret ptr ${undefinedValue}`);
    host.resolveThunkDefs.push(
      `define internal ptr @${symbol}_read(ptr %p, ${host.sizeType} %i, i32 %part) ${FN_ATTRS} {`,
      B.render(),
      "}",
      "",
    );
  }
}

export function emitNativeObjectIntrinsic(
  host: LlvmEmitterContext,
  expr: ExprOf<"intrinsic">,
): LlValue {
  const B = host.B;
  // The guard can initialize a bag and run arbitrary user code. Keep an
  // owned receiver/key snapshot across it, just like any callback boundary.
  const args = expr.args.map((arg) => host.emitExpr(arg));
  if (B.isTerminated()) return { name: "", type: expr.type };
  const receiver = args[0]!;
  if (expr.name === "native.declareUndefined") {
    host.declare("declare void @scr_native_object_declare_undefined(ptr, ptr, ptr)");
    B.line(
      `call void @scr_native_object_declare_undefined(ptr ${receiver.name}, ptr ${host.nativeObjects.ops(receiver.type)}, ptr ${args[1]!.name})`,
    );
    host.emitPendingCheck();
    return { name: "", type: expr.type };
  }
  if (
    expr.name === "native.checkWrite" ||
    expr.name === "native.propertyReset" ||
    expr.name === "native.isDeclaredUndefined"
  ) {
    const key = args[1]!;
    const lengthSlot = B.tmp(),
      length = B.tmp(),
      data = B.tmp();
    B.line(`${lengthSlot} = getelementptr inbounds %ScrStr, ptr ${key.name}, i64 0, i32 1`);
    B.line(`${length} = load ${host.sizeType}, ptr ${lengthSlot}`);
    B.line(`${data} = getelementptr inbounds %ScrStr, ptr ${key.name}, i64 1`);
    if (expr.name === "native.isDeclaredUndefined") {
      host.declare(
        `declare zeroext i1 @scr_native_property_declared_undefined(ptr, ptr, ${host.sizeType})`,
      );
      const result = B.tmp();
      B.line(
        `${result} = call zeroext i1 @scr_native_property_declared_undefined(ptr ${receiver.name}, ptr ${data}, ${host.sizeType} ${length})`,
      );
      return { name: result, type: expr.type };
    }
    if (expr.name === "native.propertyReset") {
      host.declare(`declare void @scr_native_property_forget(ptr, ptr, ${host.sizeType})`);
      B.line(
        `call void @scr_native_property_forget(ptr ${receiver.name}, ptr ${data}, ${host.sizeType} ${length})`,
      );
      return { name: "", type: expr.type };
    }
    const operation = expr.args[2];
    if (operation?.kind !== "numLit")
      throw new InternalCompilerError("native property operation must be literal");
    const ops = host.nativeObjects.ops(receiver.type),
      result = B.tmp();
    const value = args[3];
    if (value) {
      const bits = B.tmp(),
        ty = host.llType(value.type);
      B.line(
        `${bits} = ${
          ty === "double"
            ? `bitcast double ${value.name} to i64`
            : ty === "i1"
              ? `zext i1 ${value.name} to i64`
              : `ptrtoint ptr ${value.name} to i64`
        }`,
      );
      host.declare(
        "declare zeroext i1 @scr_native_object_check_set(ptr, ptr, ptr, i32, i64, ptr, ptr)",
      );
      B.line(
        `${result} = call zeroext i1 @scr_native_object_check_set(ptr ${receiver.name}, ptr ${ops}, ptr ${key.name}, i32 ${operation.value}, i64 ${bits}, ptr @${host.dyn.nativeSlotBoxHelper(value.type)}, ptr @${host.dyn.nativeSlotBoxHelper(receiver.type)})`,
      );
    } else {
      host.declare(
        `declare zeroext i1 @scr_native_object_check_write(ptr, ptr, ptr, ${host.sizeType}, i32)`,
      );
      B.line(
        `${result} = call zeroext i1 @scr_native_object_check_write(ptr ${receiver.name}, ptr ${ops}, ptr ${data}, ${host.sizeType} ${length}, i32 ${operation.value})`,
      );
    }
    host.emitPendingCheck();
    return { name: result, type: expr.type };
  }
  const ops = host.nativeObjects.ops(receiver.type);
  const restrictions =
    expr.name.endsWith("Frozen") || expr.name.endsWith("freeze")
      ? 7
      : expr.name.endsWith("Sealed") || expr.name.endsWith("seal")
        ? 3
        : 1;
  if (expr.name.startsWith("native.is")) {
    host.declare("declare zeroext i1 @scr_native_object_is_restricted(ptr, ptr, i32)");
    const result = B.tmp();
    B.line(
      `${result} = call zeroext i1 @scr_native_object_is_restricted(ptr ${receiver.name}, ptr ${ops}, i32 ${restrictions})`,
    );
    if (expr.name !== "native.isExtensible") return { name: result, type: expr.type };
    const extensible = B.tmp();
    B.line(`${extensible} = xor i1 ${result}, true`);
    return { name: extensible, type: expr.type };
  }
  host.declare("declare void @scr_native_object_restrict(ptr, ptr, i32)");
  B.line(
    `call void @scr_native_object_restrict(ptr ${receiver.name}, ptr ${ops}, i32 ${restrictions})`,
  );
  return { name: "", type: expr.type };
}
