/* The representation report (SCRIPTC_REPR_REPORT=<file>): after a module is
 * emitted, one tab-separated line per class field, function parameter,
 * function result and union, naming the storage the backend chose for it
 * and, for numbers kept as doubles, the reason the int32 analysis recorded
 * (int32-slots.ts Int32Slots.reasons). It is a diagnostic for ranking
 * representation work; nothing reads it back. */
import { writeFileSync } from "node:fs";
import { typeKey, type IrFunction, type IrModule, type IrType } from "../../ir/ir.js";
import type { LlEmitter } from "./emitter.js";
import { classFieldTypes } from "./classes.js";
import { INLINE_UNION_FIELD } from "./inline-unions.js";

export const REPR_REPORT_HEADER = "kind\towner\tname\ttype\tstorage\treason";

/** The file SCRIPTC_REPR_REPORT names, or null. A build that writes the
 * report skips the executable cache, whose hit would emit no module. */
export function representationReportPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const path = env["SCRIPTC_REPR_REPORT"];
  return path === undefined || path === "" ? null : path;
}

/** Writes the report of `emitter`'s module when SCRIPTC_REPR_REPORT names a
 * file. */
export function writeRepresentationReport(emitter: LlEmitter): void {
  const path = representationReportPath();
  if (path !== null) writeFileSync(path, representationReport(emitter));
}

export function representationReport(emitter: LlEmitter): string {
  const mod = emitter.mod;
  const slots = emitter.int32Slots;
  const lines = [REPR_REPORT_HEADER];
  const row = (...cells: string[]): void => {
    lines.push(cells.map((cell) => cell.replace(/[\t\n]/g, " ")).join("\t"));
  };
  const typeLabel = typeLabeler(mod);
  // A union value that is not a plain box: a nullable or shape pointer.
  const unionStorage = (t: IrType): string | null => {
    if (t.kind !== "union") return null;
    return emitter.nullableUnions.get(t.unionId)?.repr ?? "box";
  };

  for (const cls of mod.classes ?? []) {
    const meta = emitter.classMeta.get(cls.name);
    const types = classFieldTypes(emitter.shapeHost, cls, slots);
    // Inherited fields come first in def.fields: report each field once,
    // on the class that declares it.
    const inherited = meta?.base?.def.fields.length ?? 0;
    cls.fields.forEach((field, i) => {
      if (i < inherited) return;
      let storage = types[i]!;
      if (storage === INLINE_UNION_FIELD) storage = "inline union";
      else if (meta?.compressed[i] === true) storage = "ref32";
      else if (storage === "ptr") storage = unionStorage(field.type) ?? "ptr";
      let reason = "";
      if (field.type.kind === "f64" && storage === "double") {
        const family = slots.family(cls.name, field.name);
        reason =
          family === null
            ? "no field family"
            : (slots.reasons.get(`field:${family}`) ?? "not a candidate");
      }
      row("field", cls.name, field.name, typeLabel(field.type), storage, reason);
    });
  }

  for (const fn of mod.functions) {
    const abi = emitter.int32Abis.get(fn.name);
    fn.params.forEach((param, i) => {
      let storage: string;
      let reason = "";
      if (param.type.kind === "f64") {
        storage = abi?.params[i] === true ? "i32" : "double";
        if (storage === "double") reason = parameterReason(emitter, fn, param.localId);
      } else storage = unionStorage(param.type) ?? scalarStorage(param.type);
      row("param", fn.name, param.name, typeLabel(param.type), storage, reason);
    });
    const ret = fn.returnType;
    if (ret.kind === "void") continue;
    let storage: string;
    let reason = "";
    if (ret.kind === "f64") {
      storage = abi?.result === true ? "i32" : "double";
      if (storage === "double")
        reason = slots.reasons.get(`ret:${fn.name}`) ?? notCandidate(emitter, fn);
    } else if (ret.kind === "union" && abi?.union === true) storage = "register pair";
    else storage = unionStorage(ret) ?? scalarStorage(ret);
    row("return", fn.name, "", typeLabel(ret), storage, reason);
  }

  for (const def of mod.unions ?? [])
    row(
      "union",
      def.id,
      "",
      typeLabel({ kind: "union", unionId: def.id }),
      unionStorage({ kind: "union", unionId: def.id })!,
      "",
    );
  return lines.join("\n") + "\n";
}

function scalarStorage(t: IrType): string {
  switch (t.kind) {
    case "f64":
      return "double";
    case "bool":
      return "i1";
    default:
      return "ptr";
  }
}

function parameterReason(emitter: LlEmitter, fn: IrFunction, localId: string): string {
  const slots = emitter.int32Slots;
  const recorded = slots.reasons.get(`param:${fn.name}\0${localId}`);
  if (recorded !== undefined) return recorded;
  // Proven, but the function has no i32 entry (findInt32Abis).
  if (slots.hasParam(fn.name, localId)) return "no i32 entry";
  return notCandidate(emitter, fn);
}

/** Why a function's numbers were never int32 candidates: the analysis only
 * proves functions that direct calls alone reach. */
function notCandidate(emitter: LlEmitter, fn: IrFunction): string {
  if (fn.async) return "async function";
  if (fn.generator) return "generator";
  if (fn.captures !== undefined) return "closure";
  if (!emitter.int32Slots.called.has(fn.name)) return "no direct call";
  return "escapes or is dispatched";
}

/** Type labels with union arms spelled out. */
function typeLabeler(mod: IrModule): (t: IrType) => string {
  const arms = new Map((mod.unions ?? []).map((def) => [def.id, def.arms]));
  return (t) => {
    if (t.kind !== "union") return typeKey(t);
    const list = arms.get(t.unionId);
    return list === undefined ? typeKey(t) : list.map(typeKey).join(" | ");
  };
}
