import { F64, type IrModule, type IrType } from "../../ir/ir.js";
import { everyStmtList } from "../../ir/traverse.js";

/** Replace inert instance slots left by runtime-fenced class declarations.
 * Construction of an unregistered class already traps, but its remaining
 * storage types must agree across declarations, signatures and expressions.
 * Keep class values and node-level class names for the validator to check.
 * Traverse typed IR directly: boxing a whole module into unknown recursively
 * copies its records and makes this pass costly in the native compiler. */
export function sanitizeUnregisteredClassTypes(
  module: IrModule,
  hasClass: (name: string) => boolean,
): void {
  const rewrite = (type: IrType): IrType => {
    switch (type.kind) {
      case "object":
        return hasClass(type.className) ? type : F64;
      case "array":
        type.elem = rewrite(type.elem);
        break;
      case "set":
        type.elem = rewrite(type.elem);
        break;
      case "map":
        type.key = rewrite(type.key);
        type.value = rewrite(type.value);
        break;
      case "func":
        for (let i = 0; i < type.params.length; i++) type.params[i] = rewrite(type.params[i]!);
        type.ret = rewrite(type.ret);
        break;
      case "promise":
        type.inner = rewrite(type.inner);
        break;
      case "generator":
        type.yieldT = rewrite(type.yieldT);
        type.retT = rewrite(type.retT);
        type.nextT = rewrite(type.nextT);
        break;
    }
    // Record and union references use IDs. Visit each definition below,
    // without following those edges through recursive type graphs.
    return type;
  };
  for (const global of module.globals ?? []) global.type = rewrite(global.type);
  for (const cls of module.classes ?? []) {
    for (const field of cls.fields) field.type = rewrite(field.type);
    for (const capture of cls.localCaptures ?? []) capture.type = rewrite(capture.type);
  }
  for (const record of module.records ?? []) {
    for (const field of record.fields) field.type = rewrite(field.type);
    if (record.indexValue) record.indexValue = rewrite(record.indexValue);
  }
  for (const union of module.unions ?? []) {
    for (let i = 0; i < union.arms.length; i++) union.arms[i] = rewrite(union.arms[i]!);
  }
  for (const fn of module.functions) {
    fn.returnType = rewrite(fn.returnType);
    for (const param of fn.params) param.type = rewrite(param.type);
    for (const local of fn.locals) local.type = rewrite(local.type);
    for (const capture of fn.captures ?? []) capture.type = rewrite(capture.type);
    for (const capture of fn.classCaptures ?? []) capture.type = rewrite(capture.type);
    if (fn.generator) {
      fn.generator.yieldT = rewrite(fn.generator.yieldT);
      fn.generator.nextT = rewrite(fn.generator.nextT);
      // resultType is a record reference; its fields are visited above.
    }
    everyStmtList(fn.body, {
      expr: (expr) => {
        expr.type = rewrite(expr.type);
        return true;
      },
      stmt: () => true,
    });
  }
}
