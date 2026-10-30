import { constructorEscapePoint } from "../cycle-mutability.js";
import {
  VOID,
  isRefCounted,
  typeEquals,
  type IrExpr,
  type IrFunction,
  type IrType,
} from "../../ir/ir.js";
import {
  completeRecordLiteral,
  constructorInitializesFields,
  frameRecordShape,
  resultEntryName,
  scalarStandaloneClass,
} from "./record-results.js";
import { everyStmtList } from "../../ir/traverse.js";
import { mangleClassStruct, mangleRecordStruct } from "../mangle.js";
import { classFieldIndex, classIdImmortalRcWord, classUndefinedFieldInits } from "./classes.js";
import { CYC_BUF, CYC_HDR } from "./alloc.js";
import type { CallLifetimes } from "./call-lifetimes.js";
import { emitCallExpr, emitConstruction } from "./expr-calls.js";
import type { LlValue, LlvmEmitterContext } from "./expr-context.js";
import { emitRecordLitFields } from "./expr-primitives.js";
import { SHAPE_WORD_INDEX } from "./nullable-unions.js";
import { llFieldType } from "./shapes.js";

export type StackObjectSource = IrExpr & { kind: "recordLit" | "recordClone" | "new" | "call" };

/** A field of a frame object that owns a reference: an entry-block pointer
 * to its slot, and the field's type for the release. */
export interface StackObjectField {
  name: string;
  ptr: string;
  type: IrType;
}

/** Records the owners of a frame object's reference fields before anything
 * stores them: a lexical scope for bindings, a statement frame for
 * temporaries. */
export type StackObjectFieldOwner = (fields: readonly StackObjectField[]) => void;

/** A record literal, spread copy, `new` or result-slot producer call whose
 * object can live in the frame's own storage: a closed record shape, or a
 * standalone scalar class whose constructor never lets `this` escape
 * (record-results.ts). The caller proves that every use of the value only
 * projects it. Record fields may own references; the frame releases them
 * (stackObjectFields). Published and freezable shapes keep heap storage:
 * their field guards treat the immortal header as a frozen object, and a
 * frozen record keeps its frozen bit in a counted header. */
export function canStackObject(host: LlvmEmitterContext, e: IrExpr): e is StackObjectSource {
  // A ThreadSlots key keeps its slot index for its lifetime and has its
  // values released when it is freed: it lives on the heap.
  if (e.type.kind === "object" && host.classMeta.get(e.type.className)?.threadSlot === true)
    return false;
  if (e.type.kind === "record" && host.publishedTypes?.recordGuarded(e.type.shapeId) === true)
    return false;
  if (e.type.kind === "record" && host.recordsById.get(e.type.shapeId)?.freezable === true)
    return false;
  // A producer with a result-slot entry builds its fresh result in the
  // caller's storage, unless the call roots a group: then the result goes
  // in the group's arena with the objects it holds (arenas.ts).
  if (e.kind === "call") return host.fnByName.has(resultEntryName(e.callee)) && !host.opensArena(e);
  if (e.kind === "recordLit") {
    if (e.type.kind !== "record") return false;
    const shape = host.recordsById.get(e.type.shapeId);
    return frameRecordShape(shape) && completeRecordLiteral(e, shape);
  }
  // A same-shape spread (`{ ...source, field: value }`) copies the source's
  // fields; the frontend builds it only for plain declared-field records.
  if (e.kind === "recordClone")
    return e.type.kind === "record" && frameRecordShape(host.recordsById.get(e.type.shapeId));
  if (e.kind !== "new") return false;
  const meta = host.classMeta.get(e.className);
  return (
    meta !== undefined &&
    scalarStandaloneClass(
      meta.def,
      host.fnByName.get(`%${e.className}.constructor`),
      meta.hierarchy,
      host.programLifetime.has(e.className),
      host.inlineUnions,
    )
  );
}

/** A standalone class whose instance can live in the frame of a binding
 * that frame-escapes.ts proves stays in the frame. Unlike
 * scalarStandaloneClass, its fields may own references: the frame owns
 * them and releases them when the binding's scope exits. Classes in a
 * hierarchy keep heap storage, as do the kinds canStackObject refuses. */
export function frameClass(host: LlvmEmitterContext, className: string): boolean {
  const meta = host.classMeta.get(className);
  const ctor = host.fnByName.get(`%${className}.constructor`);
  if (meta === undefined || ctor === undefined) return false;
  const cls = meta.def;
  if (
    meta.hierarchy ||
    meta.compact ||
    meta.threadSlot === true ||
    host.programLifetime.has(className) ||
    host.publishedTypes?.classGuarded(className) === true ||
    cls.runtime ||
    cls.base !== undefined ||
    cls.arrayElem !== undefined ||
    cls.localCaptures !== undefined ||
    cls.tracksOwnFields ||
    (cls.symbolFields?.length ?? 0) > 0 ||
    ctor.async ||
    ctor.generator
  )
    return false;
  const self = ctor.params[0]?.localId;
  return self !== undefined && constructorEscapePoint(ctor, self, null) === ctor.body.length;
}

/** Whether a frame object of this type has fields that own references. */
function ownsReferences(host: LlvmEmitterContext, type: IrType): boolean {
  if (type.kind === "object") return classReferenceFields(host, type.className).length > 0;
  return (
    type.kind === "record" &&
    host
      .recordShape(type.shapeId)
      .fields.some((field) => isRefCounted(field.type) && !host.inlineUnions.record(field.type))
  );
}

/** The fields of a frame class that own references: refcounted, not inline
 * unions, and not compressed references to program-lifetime instances.
 * Each has its storage type: a nullable class field holds the class pointer
 * itself, whatever form its union takes elsewhere (nullable-fields.ts). */
function classReferenceFields(
  host: LlvmEmitterContext,
  className: string,
): { name: string; index: number; type: IrType }[] {
  const meta = host.classMeta.get(className);
  if (meta === undefined) return [];
  const out: { name: string; index: number; type: IrType }[] = [];
  for (const field of meta.def.fields) {
    if (!isRefCounted(field.type) || host.inlineUnions.classField(className, field.name)) continue;
    const { index, compressed } = classFieldIndex(meta, field.name, "compressed");
    if (compressed) continue;
    out.push({
      name: field.name,
      index,
      type: host.nullableFields.storageType(className, field.name, field.type),
    });
  }
  return out;
}

/** Locals declared directly in a switch case. The cases share one scope
 * whose exit runs whichever case was entered, so a scope-owned field would
 * be released without its declaration having run. */
function caseScopedLocals(fn: IrFunction): Set<string> {
  const ids = new Set<string>();
  everyStmtList(fn.body, {
    expr: () => true,
    stmt: (stmt) => {
      if (stmt.kind === "switch")
        for (const c of stmt.cases)
          for (const s of c.body) if (s.kind === "varDecl") ids.add(s.localId);
      return true;
    },
  });
  return ids;
}

/** Locals initialized once by a stack-eligible object and only projected
 * afterwards (CallLifetimes.locals): field reads, and arguments to
 * parameters that are themselves only projected. Also locals initialized
 * once by a `new` of a frame class (frameClass) whose value stays in the
 * frame (frame-escapes.ts): their methods and callees may store into the
 * instance. */
export function findLocalStackObjects(
  host: LlvmEmitterContext,
  fn: IrFunction,
  lifetimes: CallLifetimes,
): Map<string, StackObjectSource> {
  const result = new Map<string, StackObjectSource>();
  const safe = lifetimes.locals.get(fn.name);
  if (fn.async || fn.generator) return result;
  // Frame facts are computed only for functions that construct a frame class.
  let frame: ReadonlySet<string> | undefined;
  const frameLocal = (localId: string): boolean => {
    if (host.frameEscapes === null) return false;
    frame ??= host.frameEscapes.locals(fn);
    return frame.has(localId);
  };
  const caseScoped = caseScopedLocals(fn);
  everyStmtList(fn.body, {
    expr: () => true,
    stmt: (stmt) => {
      if (
        stmt.kind === "varDecl" &&
        stmt.init &&
        ((safe?.has(stmt.localId) === true && canStackObject(host, stmt.init)) ||
          (stmt.init.kind === "new" &&
            frameClass(host, stmt.init.className) &&
            frameLocal(stmt.localId))) &&
        !(caseScoped.has(stmt.localId) && ownsReferences(host, stmt.init.type))
      )
        result.set(stmt.localId, stmt.init as StackObjectSource);
      return true;
    },
  });
  return result;
}

/** Reassigned locals declared with an initializer, whose every write
 * builds a stack-eligible object of the binding's own type, and whose uses
 * only project the value
 * (CallLifetimes.projectedLocals). The binding keeps one slot; each
 * assignment builds its value in fresh storage, which may read the old
 * value, and then copies it into the binding's slot. */
export function findReassignedStackObjects(
  host: LlvmEmitterContext,
  fn: IrFunction,
  lifetimes: CallLifetimes,
): Set<string> {
  const result = new Set<string>();
  const projected = lifetimes.projectedLocals.get(fn.name);
  const stable = lifetimes.locals.get(fn.name);
  if (!projected?.size || fn.async || fn.generator) return result;
  const types = new Map(fn.locals.map((local) => [local.id, local.type]));
  for (const id of projected) {
    const type = types.get(id);
    if (!stable?.has(id) && (type?.kind === "record" || type?.kind === "object")) result.add(id);
  }
  // The binding must be declared by its own initializer: a loop that binds
  // it (`for...of`) would point it at each element, not at the slot.
  const initialized = new Set<string>();
  everyStmtList(fn.body, {
    expr: () => true,
    stmt: (stmt) => {
      if (stmt.kind === "forOf") result.delete(stmt.localId);
      if (stmt.kind === "varDecl" && stmt.init) initialized.add(stmt.localId);
      if ((stmt.kind === "varDecl" || stmt.kind === "assign") && result.has(stmt.localId)) {
        const value = stmt.kind === "varDecl" ? stmt.init : stmt.value;
        if (
          !value ||
          !canStackObject(host, value) ||
          !typeEquals(value.type, types.get(stmt.localId)!)
        )
          result.delete(stmt.localId);
      }
      return true;
    },
  });
  const caseScoped = caseScopedLocals(fn);
  for (const id of result)
    if (!initialized.has(id) || (caseScoped.has(id) && ownsReferences(host, types.get(id)!)))
      result.delete(id);
  return result;
}

export function stackObjectStruct(type: IrType): string {
  return type.kind === "record"
    ? `%${mangleRecordStruct(type.shapeId)}`
    : `%${mangleClassStruct((type as IrType & { kind: "object" }).className)}`;
}

/** The reference fields of the frame object in `slot`, addressed from the
 * entry block so that every cleanup path can reach them. Inline union
 * fields copy bits and own nothing, and so do a class's compressed
 * references to program-lifetime instances. */
export function stackObjectFields(
  host: LlvmEmitterContext,
  type: IrType,
  slot: string,
): readonly StackObjectField[] {
  if (type.kind !== "record" && type.kind !== "object") return [];
  const cached = host.stackObjectFieldPtrs.get(slot);
  if (cached) return cached;
  const struct = stackObjectStruct(type);
  if (type.kind === "object") {
    const fields: StackObjectField[] = [];
    for (const field of classReferenceFields(host, type.className)) {
      const ptr = host.B.slot();
      host.B.entryAllocas.push(
        `${ptr} = getelementptr inbounds ${struct}, ptr ${slot}, i64 0, i32 ${field.index}`,
      );
      fields.push({ name: field.name, ptr, type: field.type });
    }
    host.stackObjectFieldPtrs.set(slot, fields);
    return fields;
  }
  const base = host.nullableUnions.fieldBase(type.shapeId);
  const fields: StackObjectField[] = [];
  host.recordShape(type.shapeId).fields.forEach((field, index) => {
    if (!isRefCounted(field.type) || host.inlineUnions.record(field.type)) return;
    const ptr = host.B.slot();
    host.B.entryAllocas.push(
      `${ptr} = getelementptr inbounds ${struct}, ptr ${slot}, i64 0, i32 ${index + base}`,
    );
    fields.push({ name: field.name, ptr, type: field.type });
  });
  host.stackObjectFieldPtrs.set(slot, fields);
  return fields;
}

/** Copy a same-shape spread's source fields into `slot`, retaining the
 * references, then store the overrides in source order. The source is
 * read once, before any override evaluates, as the heap clone helper
 * reads it; an overridden field is never copied, so its slot stays empty
 * until the override initializes it. */
function emitRecordCloneFields(
  host: LlvmEmitterContext,
  e: IrExpr & { kind: "recordClone" },
  slot: string,
): void {
  const B = host.B;
  const shapeId = (e.type as IrType & { kind: "record" }).shapeId;
  const overridden = new Set(e.overrides.map((override) => override.name));
  const source = host.emitReadReceiver(e.source);
  for (const field of host.recordShape(shapeId).fields) {
    if (overridden.has(field.name)) continue;
    const from = host.recordFieldPtr(source.name, shapeId, field.name);
    const to = host.recordFieldPtr(slot, shapeId, field.name);
    const fieldTy = llFieldType(from.type, from.inline);
    const v = B.tmp();
    B.line(`${v} = load ${fieldTy}, ptr ${from.ptr}`);
    const stored = isRefCounted(from.type) && !from.inline ? host.retainFrame(v, from.type) : v;
    B.line(`store ${fieldTy} ${stored}, ptr ${to.ptr}`);
  }
  const initialized = new Set<string>();
  for (const override of e.overrides) {
    const v = host.emitFieldValue(override.value, host.recordFieldInline(shapeId, override.name));
    const { ptr, type, inline } = host.recordFieldPtr(slot, shapeId, override.name);
    // The first store fills an empty slot; a repeated name replaces it.
    if (initialized.has(override.name)) host.replaceField(ptr, type, inline, v);
    else host.initField(ptr, type, inline, v);
    initialized.add(override.name);
  }
}

/** Build the object in an entry-block slot (or `into`, an existing one).
 * The immortal reference count makes every retain and release a no-op;
 * the proof that the value is only projected keeps the pointer from
 * outliving the frame. Reference fields start empty and are handed to
 * `owner` before anything is stored, so an exception while the object is
 * being built releases exactly the fields stored so far. */
export function emitStackObject(
  host: LlvmEmitterContext,
  e: StackObjectSource,
  owner: StackObjectFieldOwner,
  into?: string,
): LlValue {
  const B = host.B;
  const type = e.type;
  const struct = stackObjectStruct(type);
  let slot = into;
  if (slot === undefined) {
    slot = B.slot();
    if (type.kind === "object" && host.shapeHost.tracedShapes.has(`object:${type.className}`)) {
      // A cycle-capable class keeps its collector header in front of the
      // object, never a candidate (SCR_CYC_ACYCLIC), as arena objects do.
      const frame = B.slot();
      B.entryAllocas.push(
        `${frame} = alloca { [${CYC_HDR} x i8], ${struct} }, align 8`,
        `${slot} = getelementptr inbounds { [${CYC_HDR} x i8], ${struct} }, ptr ${frame}, i64 0, i32 1`,
      );
      const buf = B.tmp();
      B.line(`store i16 0, ptr ${frame} ; ScrCycHdr.id`);
      B.line(`${buf} = getelementptr inbounds i8, ptr ${frame}, i64 ${CYC_BUF}`);
      B.line(`store i32 -1, ptr ${buf} ; ScrCycHdr.buf = SCR_CYC_ACYCLIC`);
    } else B.entryAllocas.push(`${slot} = alloca ${struct}, align 8`);
  }
  // A literal's interned string fields are immortal and need no owner. A
  // binding's own slot (`into`) keeps an owner for every field: later
  // assignments copy arbitrary values into it.
  const literals =
    into === undefined && e.kind === "recordLit"
      ? new Set(e.fields.filter((f) => f.value.kind === "strLit").map((f) => f.name))
      : new Set<string>();
  const fields = stackObjectFields(host, type, slot).filter((f) => !literals.has(f.name));
  if (fields.length > 0) {
    for (const field of fields) B.line(`store ptr null, ptr ${field.ptr}`);
    owner(fields);
  }
  // Literals store every field; constructors that store every field
  // before reading one need no zeroed storage either.
  if (type.kind === "object") {
    const meta = host.classMeta.get(type.className)!;
    const ctor = host.fnByName.get(`%${type.className}.constructor`)!;
    if (!constructorInitializesFields(meta.def, ctor)) {
      B.line(`store ${struct} zeroinitializer, ptr ${slot}`);
      // Union and dyn fields start undefined, as the class's `new` sets them.
      for (const line of classUndefinedFieldInits(
        host.shapeHost,
        meta,
        host.nullableFields,
        slot,
        `${B.tmp()}.uf`,
      ))
        B.line(line.trim());
    }
  }
  const tagged = type.kind === "object" ? host.classMeta.get(type.className) : undefined;
  // A class-union arm keeps its class id beside the immortal count.
  if (tagged?.idInRc === true) B.line(`store i64 ${classIdImmortalRcWord(tagged)}, ptr ${slot}`);
  else B.line(`store ${host.sizeType} -1, ptr ${slot}`);
  if (type.kind === "record") {
    // A tagged shape's word names it to every shape union's tag read.
    const shapeNumber = host.nullableUnions.shapeNumber(type.shapeId);
    if (shapeNumber !== 0) {
      const p = B.tmp();
      B.line(
        `${p} = getelementptr inbounds ${struct}, ptr ${slot}, i64 0, i32 ${SHAPE_WORD_INDEX}`,
      );
      B.line(`store i32 ${shapeNumber}, ptr ${p}`);
    }
  }
  if (e.kind === "call") {
    // The entry writes the result into the slot it receives last.
    emitCallExpr(
      host,
      { ...e, callee: resultEntryName(e.callee), type: VOID },
      false,
      false,
      host.markImmortal({ name: slot, type }),
    );
  } else if (e.kind === "recordLit") emitRecordLitFields(host, e, slot);
  else if (e.kind === "recordClone") emitRecordCloneFields(host, e, slot);
  else emitConstruction(host, e, slot, host.fnByName.get(`%${e.className}.constructor`)!);
  return { name: slot, type: e.type };
}
