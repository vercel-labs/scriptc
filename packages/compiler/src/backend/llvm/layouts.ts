import type { IrFunction, IrModule, IrType } from "../../ir/ir.js";
import { emitClassObjDefs, emitClassShapes, type ClassHost, type LlClassMeta } from "./classes.js";
import { emitRecordShapes } from "./shapes.js";
import { NullableRefFields } from "./nullable-fields.js";
import type { Int32Slots } from "../../ir/int32-slots.js";
import { alignFunctionEntries } from "./function-alignment.js";
import type { TextPart } from "../../text-parts.js";

export interface LlvmLayouts {
  records: { typeDefs: string[]; defs: string[] };
  classes: { typeDefs: string[]; defs: string[] };
  classObjects: string[];
}

/** Generate the module's layouts, ownership helpers, vtables and class
 * constructors together. Hosts supply symbol interning and declarations;
 * all layout and lifetime decisions stay in this production stage. */
export function emitLlvmLayouts(
  host: ClassHost,
  mod: IrModule,
  classes: Map<string, LlClassMeta>,
  classObjects: Map<string, { nameSym: string; baseNameSym: string | null }>,
  functions: Map<string, IrFunction>,
  llType: (type: IrType) => string,
  nullable?: NullableRefFields,
  int32?: Int32Slots,
): LlvmLayouts {
  const records = emitRecordShapes(host, mod);
  const classShapes = emitClassShapes(host, mod, classes, nullable, int32);
  const objects = emitClassObjDefs(
    host,
    classes,
    classObjects,
    functions,
    llType,
    mod.workers === true || mod.lib?.threadInstances === true,
  );
  // This stage's definitions are spliced into the full module by
  // self-hosting consumers, so they carry the same entry alignment the
  // emitter's whole-module pass gives every function.
  records.defs = alignFunctionEntries(records.defs as TextPart[]) as string[];
  classShapes.defs = alignFunctionEntries(classShapes.defs as TextPart[]) as string[];
  return {
    records,
    classes: classShapes,
    classObjects: alignFunctionEntries(objects as TextPart[]) as string[],
  };
}
