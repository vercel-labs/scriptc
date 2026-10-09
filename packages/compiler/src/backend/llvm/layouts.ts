import type { IrFunction, IrModule, IrType } from "../../ir/ir.js";
import { emitClassObjDefs, emitClassShapes, type ClassHost, type LlClassMeta } from "./classes.js";
import { emitRecordShapes } from "./shapes.js";
import { NullableRefFields } from "./nullable-fields.js";

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
  classObjects: Map<string, { nameSym: string }>,
  functions: Map<string, IrFunction>,
  llType: (type: IrType) => string,
  nullable?: NullableRefFields,
): LlvmLayouts {
  const records = emitRecordShapes(host, mod);
  const classShapes = emitClassShapes(host, mod, classes, nullable);
  const objects = emitClassObjDefs(
    host,
    classes,
    classObjects,
    functions,
    llType,
    mod.workers === true || mod.lib?.threadInstances === true,
  );
  return { records, classes: classShapes, classObjects: objects };
}
