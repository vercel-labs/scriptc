import { nodeThrowExpr, varRef } from "../../ir/build.js";
import {
  BOOL,
  type IrExpr,
  type IrStmt,
  type IrType,
  isUnitType,
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

/** `value as Sub | undefined`: an assertion into a union whose class arm is
 * narrower than the stored one. Every other arm must already have an
 * identical destination arm. The stored class is checked before the
 * descendant view is exposed (as `value as Sub` does), and the present
 * value keeps its identity. Null when no arm needs a checked downcast. */
export function checkedClassUnionAssertion(
  lowerer: Lowerer,
  value: IrExpr,
  target: IrType & { kind: "union" },
  loc: SrcLoc,
): IrExpr | null {
  const targetArms = lowerer.unions.get(target.unionId)?.arms;
  if (!targetArms) return null;
  const sourceUnion = value.type.kind === "union" ? lowerer.unions.get(value.type.unionId) : null;
  if (value.type.kind === "union" && !sourceUnion) return null;
  const sourceArms = sourceUnion ? sourceUnion.arms : [value.type];
  type Route =
    | { kind: "same"; tag: number }
    | { kind: "down"; tags: number[]; fallback: number | null };
  const routes: Route[] = [];
  let downcasts = false;
  for (const arm of sourceArms) {
    const same = targetArms.findIndex((candidate) => typeEquals(candidate, arm));
    if (same >= 0) {
      routes.push({ kind: "same", tag: same });
      continue;
    }
    if (arm.kind !== "object") return null;
    const related = (relation: (candidate: string) => boolean): number[] =>
      targetArms.flatMap((candidate, tag) =>
        candidate.kind === "object" && relation(candidate.className) ? [tag] : [],
      );
    const depth = (tag: number): number => {
      const candidate = targetArms[tag]!;
      return targetArms.filter(
        (other) =>
          candidate.kind === "object" &&
          other.kind === "object" &&
          lowerer.isSubclassOf(candidate.className, other.className),
      ).length;
    };
    const subs = related((name) => lowerer.isSubclassOf(name, arm.className)).sort(
      (a, b) => depth(b) - depth(a),
    );
    const supers = related((name) => lowerer.isSubclassOf(arm.className, name)).sort(
      (a, b) => depth(b) - depth(a),
    );
    if (subs.length === 0) return null;
    downcasts = true;
    routes.push({ kind: "down", tags: subs, fallback: supers[0] ?? null });
  }
  if (!downcasts) return null;
  const key = `classunionassert:${typeKey(value.type)}:${typeKey(target)}`;
  let name = lowerer.coercions.retags.get(key);
  if (!name) {
    name = `%class.assert.${lowerer.coercions.retags.size}`;
    lowerer.coercions.retags.set(key, name);
    const input = varRef("value.0", value.type, loc);
    const locals = [{ id: "value.0", name: "value", type: value.type, mutable: false }];
    const wrap = (tag: number, payload: IrExpr): IrExpr => ({
      kind: "unionWrap",
      unionId: target.unionId,
      tag,
      value: payload,
      type: target,
      loc,
    });
    const body: IrStmt[] = [];
    for (let source = 0; source < sourceArms.length; source++) {
      const arm = sourceArms[source]!;
      const route = routes[source]!;
      const branch: IrStmt[] = [];
      let payload: IrExpr = input;
      if (sourceUnion) {
        if (isUnitType(arm)) {
          payload = {
            kind: "unitLit",
            unit: arm.kind === "undefinedT" ? "undefined" : "null",
            type: arm,
            loc,
          };
        } else {
          const localId = `arm.${source}`;
          locals.push({ id: localId, name: "arm", type: arm, mutable: false });
          branch.push({
            kind: "varDecl",
            localId,
            init: {
              kind: "unionNarrow",
              unionId: sourceUnion.id,
              tag: source,
              value: input,
              type: arm,
              loc,
            },
            loc,
          });
          payload = varRef(localId, arm, loc);
        }
      }
      if (route.kind === "same") {
        branch.push({ kind: "return", value: wrap(route.tag, payload), loc });
      } else {
        for (const tag of route.tags) {
          const sub = targetArms[tag]! as IrType & { kind: "object" };
          branch.push({
            kind: "if",
            cond: { kind: "instanceOf", value: payload, className: sub.className, type: BOOL, loc },
            then: [
              {
                kind: "return",
                value: wrap(tag, { kind: "downcast", value: payload, type: sub, loc }),
                loc,
              },
            ],
            else_: null,
            loc,
          });
        }
        const fallback = route.fallback;
        branch.push({
          kind: "return",
          value:
            fallback === null
              ? nodeThrowExpr(
                  1,
                  "",
                  `Value is not an instance of '${lowerer.fmt(target)}'`,
                  target,
                  loc,
                )
              : wrap(fallback, {
                  kind: "upcast",
                  value: payload,
                  type: targetArms[fallback]!,
                  loc,
                }),
          loc,
        });
      }
      if (!sourceUnion) {
        body.push(...branch);
        continue;
      }
      body.push({
        kind: "if",
        cond: {
          kind: "unionIsTag",
          unionId: sourceUnion.id,
          tag: source,
          negated: false,
          value: input,
          type: BOOL,
          loc,
        },
        then: branch,
        else_: null,
        loc,
      });
    }
    if (sourceUnion) {
      body.push({
        kind: "return",
        value: nodeThrowExpr(
          1,
          "",
          `Value is not an instance of '${lowerer.fmt(target)}'`,
          target,
          loc,
        ),
        loc,
      });
    }
    lowerer.liftedFns.push({
      name,
      params: [{ localId: "value.0", name: "value", type: value.type }],
      locals,
      returnType: target,
      body,
      loc,
    });
  }
  return { kind: "call", callee: name, args: [value], type: target, loc };
}
