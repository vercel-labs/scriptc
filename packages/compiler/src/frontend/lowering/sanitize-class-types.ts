import {
  F64,
  UNDEFINED_T,
  type IrExpr,
  type IrModule,
  type IrType,
  typeEquals,
} from "../../ir/ir.js";
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
  // Every unregistered class becomes f64, so a union whose arms were all
  // such classes ends with several IDENTICAL arms, which the validator
  // refuses ("arms N and M are identical") and a runtime tag could no
  // longer select. Keep the first arm of each equal type and remember how
  // the surviving tags moved: the tags in unionWrap, unionNarrow,
  // unionFuncEq and unionIsTag exprs are arm indices.
  const tagMoves = new Map<string, Map<number, number>>();
  for (const union of module.unions ?? []) {
    const arms: IrType[] = [];
    const moves = new Map<number, number>();
    for (const [oldTag, arm] of union.arms.entries()) {
      const rewritten = rewrite(arm);
      const at = arms.findIndex((other) => typeEquals(other, rewritten));
      if (at >= 0) {
        moves.set(oldTag, at);
        continue;
      }
      moves.set(oldTag, arms.length);
      arms.push(rewritten);
    }
    // Nothing merged: the rewritten arms keep every position.
    if (arms.length === union.arms.length) {
      union.arms = arms;
      continue;
    }
    // A union of nothing but unregistered classes cannot hold a value at
    // all, but its id stays referenced by signatures. One arm plus an
    // undefined arm keeps the definition valid and every reference intact;
    // the undefined arm is never built (no code wraps it).
    if (arms.length === 1) arms.push(arms[0]!.kind === "undefinedT" ? F64 : UNDEFINED_T);
    union.arms = arms;
    tagMoves.set(union.id, moves);
    if (union.discriminant) {
      const cases = union.discriminant.cases.map((c) => ({ ...c, tag: moves.get(c.tag)! }));
      const seen = new Set<number>();
      const oneCasePerTag = cases.every((c) => {
        if (seen.has(c.tag)) return false;
        seen.add(c.tag);
        return true;
      });
      // Two former arms that became one share a case now: the field can no
      // longer select an arm, and the tag values no longer name one case.
      if (oneCasePerTag) union.discriminant.cases = cases;
      else delete union.discriminant;
    }
  }
  // The tags inside expressions index the (possibly shortened) arm list.
  const retag = (expr: IrExpr): void => {
    if (
      expr.kind === "unionWrap" ||
      expr.kind === "unionNarrow" ||
      expr.kind === "unionFuncEq" ||
      expr.kind === "unionIsTag"
    ) {
      const moves = tagMoves.get(expr.unionId);
      const moved = moves?.get(expr.tag);
      if (moved !== undefined) expr.tag = moved;
    }
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
        retag(expr);
        expr.type = rewrite(expr.type);
        return true;
      },
      stmt: () => true,
    });
  }
}
