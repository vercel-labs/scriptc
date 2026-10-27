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
import { undefinedArmTag } from "../../ir/analysis.js";
import { classFieldIndex } from "./classes.js";
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

/** Whether a frame object of this type has fields that own references. */
function ownsReferences(host: LlvmEmitterContext, type: IrType): boolean {
  return (
    type.kind === "record" &&
    host
      .recordShape(type.shapeId)
      .fields.some((field) => isRefCounted(field.type) && !host.inlineUnions.record(field.type))
  );
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
 * parameters that are themselves only projected. */
export function findLocalStackObjects(
  host: LlvmEmitterContext,
  fn: IrFunction,
  lifetimes: CallLifetimes,
): Map<string, StackObjectSource> {
  const result = new Map<string, StackObjectSource>();
  const safe = lifetimes.locals.get(fn.name);
  if (!safe?.size || fn.async || fn.generator) return result;
  const caseScoped = caseScopedLocals(fn);
  everyStmtList(fn.body, {
    expr: () => true,
    stmt: (stmt) => {
      if (
        stmt.kind === "varDecl" &&
        safe.has(stmt.localId) &&
        stmt.init &&
        canStackObject(host, stmt.init) &&
        !(caseScoped.has(stmt.localId) && ownsReferences(host, stmt.init.type))
      )
        result.set(stmt.localId, stmt.init);
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
 * fields copy bits and own nothing; class objects in frame storage are
 * scalar. */
export function stackObjectFields(
  host: LlvmEmitterContext,
  type: IrType,
  slot: string,
): readonly StackObjectField[] {
  if (type.kind !== "record") return [];
  const cached = host.stackObjectFieldPtrs.get(slot);
  if (cached) return cached;
  const struct = stackObjectStruct(type);
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
    B.entryAllocas.push(`${slot} = alloca ${struct}, align 8`);
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
      // Inline union fields start undefined, as the class's `new` sets them.
      for (const field of meta.def.fields) {
        const tag = undefinedArmTag(field.type, host.unionsById);
        if (tag < 0 || !host.inlineUnions.classField(type.className, field.name)) continue;
        const p = B.tmp();
        B.line(
          `${p} = getelementptr inbounds ${struct}, ptr ${slot}, i64 0, i32 ${classFieldIndex(meta, field.name).index}, i32 0`,
        );
        B.line(`store i32 ${tag}, ptr ${p}`);
      }
    }
  }
  B.line(`store ${host.sizeType} -1, ptr ${slot}`);
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
