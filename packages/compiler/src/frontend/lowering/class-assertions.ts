import { nodeThrowExpr, varRef } from "../../ir/build.js";
import {
  BOOL,
  type IrExpr,
  type IrStmt,
  type IrType,
  type SrcLoc,
  typeEquals,
  typeKey,
} from "../../ir/ir.js";
import type { Lowerer } from "./lowerer.js";

/** Whether any stored payload can supply a checked view of this class. */
export function canAssertClassValue(
  lowerer: Lowerer,
  source: IrType,
  target: IrType & { kind: "object" },
): boolean {
  if (source.kind === "union")
    return (
      lowerer.unions
        .get(source.unionId)
        ?.arms.some((arm) => canAssertClassValue(lowerer, arm, target)) ?? false
    );
  return (
    source.kind === "object" &&
    (typeEquals(source, target) ||
      lowerer.isSubclassOf(source.className, target.className) ||
      lowerer.isSubclassOf(target.className, source.className))
  );
}

/** Assertions cannot prove a subclass layout. Check the stored class before
 * exposing descendant fields, preserving identity and one operand evaluation. */
export function checkedClassAssertion(
  lowerer: Lowerer,
  value: IrExpr,
  target: IrType & { kind: "object" },
  loc: SrcLoc,
): IrExpr | null {
  const source = value;
  const compatible = (type: IrType): type is IrType & { kind: "object" } =>
    type.kind === "object" && canAssertClassValue(lowerer, type, target);
  const failure = (): IrExpr =>
    nodeThrowExpr(1, "", `Value is not an instance of '${lowerer.fmt(target)}'`, target, loc);
  const convert = (input: IrExpr): IrExpr => {
    if (input.type.kind !== "object") return failure();
    if (typeEquals(input.type, target)) return input;
    if (lowerer.isSubclassOf(input.type.className, target.className))
      return { kind: "upcast", value: input, type: target, loc };
    return {
      kind: "ternary",
      cond: { kind: "instanceOf", value: input, className: target.className, type: BOOL, loc },
      then: { kind: "downcast", value: input, type: target, loc },
      else_: failure(),
      type: target,
      loc,
    };
  };
  const union = source.type.kind === "union" ? lowerer.unions.get(source.type.unionId) : null;
  if (union) {
    if (!union.arms.some(compatible)) return null;
  } else {
    if (!compatible(source.type)) return null;
    if (typeEquals(source.type, target)) return source;
    if (lowerer.isSubclassOf(source.type.className, target.className)) return convert(source);
  }
  const key = `classassert:${typeKey(source.type)}:${typeKey(target)}`;
  let name = lowerer.coercions.retags.get(key);
  if (!name) {
    name = `%class.assert.${lowerer.coercions.retags.size}`;
    lowerer.coercions.retags.set(key, name);
    const input = varRef("value.0", source.type, loc);
    const body: IrStmt[] = [];
    const locals = [{ id: "value.0", name: "value", type: source.type, mutable: false }];
    if (union) {
      for (let tag = 0; tag < union.arms.length; tag++) {
        const arm = union.arms[tag]!;
        if (!compatible(arm)) continue;
        const localId = `arm.${tag}`;
        locals.push({ id: localId, name: "arm", type: arm, mutable: false });
        body.push({
          kind: "if",
          cond: {
            kind: "unionIsTag",
            unionId: union.id,
            tag,
            negated: false,
            value: input,
            type: BOOL,
            loc,
          },
          then: [
            {
              kind: "varDecl",
              localId,
              init: { kind: "unionNarrow", unionId: union.id, tag, value: input, type: arm, loc },
              loc,
            },
            { kind: "return", value: convert(varRef(localId, arm, loc)), loc },
          ],
          else_: null,
          loc,
        });
      }
      body.push({ kind: "return", value: failure(), loc });
    } else {
      body.push({ kind: "return", value: convert(input), loc });
    }
    lowerer.liftedFns.push({
      name,
      params: [{ localId: "value.0", name: "value", type: source.type }],
      locals,
      returnType: target,
      body,
      loc,
    });
  }
  return { kind: "call", callee: name, args: [source], type: target, loc };
}
