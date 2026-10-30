import { VOID, typeEquals, type IrExpr, type IrFunction, type IrType } from "../../ir/ir.js";
import {
  completeRecordLiteral,
  constructorInitializesFields,
  resultEntryName,
  scalarRecordShape,
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

export type StackObjectSource = IrExpr & { kind: "recordLit" | "new" | "call" };

/** A record literal, `new` or result-slot producer call whose object can
 * live in the frame's own storage: a plain scalar record shape, or a
 * standalone scalar class whose constructor never lets `this` escape
 * (record-results.ts). The caller proves that every use of the value only
 * projects it. */
export function canStackObject(host: LlvmEmitterContext, e: IrExpr): e is StackObjectSource {
  if (
    host.publishedTypes?.requiresHeapIdentity(e.type) ||
    host.nativeIntegrityTypes?.requiresHeapIdentity(e.type)
  )
    return false;
  // A producer with a result-slot entry builds its fresh result in the
  // caller's storage.
  if (e.kind === "call") return host.fnByName.has(resultEntryName(e.callee));
  if (e.kind === "recordLit") {
    if (e.type.kind !== "record") return false;
    const shape = host.recordsById.get(e.type.shapeId);
    return scalarRecordShape(shape, host.inlineUnions) && completeRecordLiteral(e, shape);
  }
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
  everyStmtList(fn.body, {
    expr: () => true,
    stmt: (stmt) => {
      if (
        stmt.kind === "varDecl" &&
        safe.has(stmt.localId) &&
        stmt.init &&
        canStackObject(host, stmt.init)
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
  for (const id of result) if (!initialized.has(id)) result.delete(id);
  return result;
}

export function stackObjectStruct(type: IrType): string {
  return type.kind === "record"
    ? `%${mangleRecordStruct(type.shapeId)}`
    : `%${mangleClassStruct((type as IrType & { kind: "object" }).className)}`;
}

/** Build the object in an entry-block slot (or `into`, an existing one).
 * The immortal reference count makes every retain and release a no-op;
 * the proof that the value is only projected keeps the pointer from
 * outliving the frame. */
export function emitStackObject(
  host: LlvmEmitterContext,
  e: StackObjectSource,
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
  else emitConstruction(host, e, slot, host.fnByName.get(`%${e.className}.constructor`)!);
  return { name: slot, type: e.type };
}
