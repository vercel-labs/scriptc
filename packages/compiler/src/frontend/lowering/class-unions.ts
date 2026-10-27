import { keyedHelperName } from "./stable-names.js";
import * as ts from "../ts7/adapter.js";
import { BOOL, typeKey, type IrExpr, type IrStmt, type IrType } from "../../ir/ir.js";
import { nodeThrowExpr, varRef } from "../../ir/build.js";
import { checkedClassAssertion } from "./class-assertions.js";
import type { Lowerer } from "./lowerer.js";

/** The classes a narrowed read of a `staticClass` value can hold when the
 * checker typed it as the subclass `narrowed`, as a class union, or null
 * when `narrowed` is the only one.
 *
 * TypeScript reduces a union of type-parameter intersections by structural
 * subtyping. With `<T extends Node>`, `node instanceof Identifier || node
 * instanceof PrivateIdentifier` narrows `node` to `T & PrivateIdentifier`
 * when Identifier has every member PrivateIdentifier has, so the narrowed
 * read can hold an Identifier. Class identity is nominal in compiled code:
 * such a read holds the narrowed class or any class under `staticClass`
 * that is assignable to it without extending it. A narrowing outside a
 * type-parameter intersection keeps every class it names. */
export function structuralNarrowing(
  lowerer: Lowerer,
  node: ts.Node,
  staticClass: string,
  narrowed: IrType & { kind: "object" },
): (IrType & { kind: "union" }) | null {
  if (!intersectsTypeParameter(lowerer.checker.getTypeAtLocation(node))) return null;
  const key = `${staticClass}:${narrowed.className}`;
  let peers = lowerer.structuralClassPeers.get(key);
  if (peers === undefined) {
    peers = assignableClassPeers(lowerer, staticClass, narrowed.className);
    lowerer.structuralClassPeers.set(key, peers);
  }
  if (peers.length === 0) return null;
  const arms: IrType[] = [
    narrowed,
    ...peers.map((className) => ({ kind: "object" as const, className })),
  ];
  arms.sort((a, b) => (typeKey(a) < typeKey(b) ? -1 : 1));
  return { kind: "union", unionId: lowerer.unions.intern(arms) };
}

/** The type a member access dispatches on when its receiver `node` is a
 * narrowed read of a type-parameter intersection, or null to use the
 * checker's type: the class union structuralNarrowing reads, or the
 * receiver's own class when this instantiation's class is unrelated to the
 * narrowed one but assignable to it (with `T = Identifier`, the reduced
 * `T & PrivateIdentifier` still holds an Identifier). */
export function structuralReadType(lowerer: Lowerer, node: ts.Expression): IrType | null {
  if (!ts.isIdentifier(node) && !ts.isPropertyAccessExpression(node)) return null;
  if (!intersectsTypeParameter(lowerer.checker.getTypeAtLocation(node))) return null;
  const narrowed = lowerer.mapTypeOf(lowerer.typeOf(node));
  if (narrowed?.kind !== "object") return null;
  const stored = ts.isIdentifier(node) ? lowerer.peekLocal(node)?.type : undefined;
  const symbol = lowerer.checker.getSymbolAtLocation(ts.isIdentifier(node) ? node : node.name);
  const declared =
    stored ?? (symbol ? lowerer.mapTypeOf(lowerer.checker.getTypeOfSymbol(symbol)) : null);
  if (declared?.kind !== "object" || declared.className === narrowed.className) return null;
  if (lowerer.isSubclassOf(narrowed.className, declared.className))
    return structuralNarrowing(lowerer, node, declared.className, narrowed);
  if (lowerer.isSubclassOf(declared.className, narrowed.className)) return null;
  const declaredType = classInstanceType(lowerer, declared.className);
  const narrowedType = classInstanceType(lowerer, narrowed.className);
  return declaredType !== null &&
    narrowedType !== null &&
    lowerer.checker.isTypeAssignableTo(declaredType, narrowedType)
    ? declared
    : null;
}

function classInstanceType(lowerer: Lowerer, className: string): ts.Type | null {
  const decl = lowerer.classes.get(className)?.decl;
  if (!decl?.name || decl.typeParameters?.nodes.length) return null;
  const symbol = lowerer.checker.getSymbolAtLocation(decl.name);
  return symbol ? lowerer.checker.getDeclaredTypeOfSymbol(symbol) : null;
}

function intersectsTypeParameter(type: ts.Type): boolean {
  try {
    if (type.isUnionType()) return ts.constituentTypes(type).some(intersectsTypeParameter);
    return (
      (type.flags & ts.TypeFlags.Intersection) !== 0 &&
      ts.constituentTypes(type).some((part) => (part.flags & ts.TypeFlags.TypeParameter) !== 0)
    );
  } catch (e) {
    if (ts.isUnreadableConstituentsPanic(e)) return false;
    throw e;
  }
}

/** The outermost classes under `staticClass`, other than `target` and its
 * subclasses, whose instance type is assignable to `target`'s. */
function assignableClassPeers(lowerer: Lowerer, staticClass: string, target: string): string[] {
  const targetType = classInstanceType(lowerer, target);
  if (targetType === null) return [];
  const assignable: string[] = [];
  for (const className of lowerer.classes.keys()) {
    if (
      className === target ||
      !lowerer.isSubclassOf(className, staticClass) ||
      lowerer.isSubclassOf(className, target)
    )
      continue;
    const type = classInstanceType(lowerer, className);
    if (type !== null && lowerer.checker.isTypeAssignableTo(type, targetType))
      assignable.push(className);
  }
  // A subclass of an assignable class is one of its instances already.
  return assignable.filter(
    (className) =>
      !assignable.some((other) => other !== className && lowerer.isSubclassOf(className, other)),
  );
}

/** A base-class slot stays one pointer after a guard selects several
 * subclasses. Recover the tagged view from runtime membership without
 * copying the object or guessing which of the remaining layouts it has. */
export function narrowClassUnion(
  lowerer: Lowerer,
  value: IrExpr,
  target: IrType & { kind: "union" },
): IrExpr | null {
  if (value.type.kind !== "object") return null;
  const source = value.type;
  const arms = lowerer.unions.get(target.unionId)?.arms;
  if (
    !arms?.length ||
    !arms.every(
      (arm) => arm.kind === "object" && lowerer.isSubclassOf(arm.className, source.className),
    )
  )
    return null;
  const loc = value.loc;
  const key = `classUnion:${source.className}:${target.unionId}`;
  let helper = lowerer.valueHelpers.get(key);
  if (!helper) {
    helper = keyedHelperName(lowerer, "%class.union", key);
    lowerer.valueHelpers.set(key, helper);
    const input = varRef("value.0", source, loc);
    // Rank by ancestry before sorting: returning zero for unrelated pairs
    // alone would not reliably put a descendant before a nonadjacent ancestor.
    const ordered = arms
      .map((arm, tag) => ({
        arm,
        tag,
        ancestors: arms.filter(
          (other) =>
            arm.kind === "object" &&
            other.kind === "object" &&
            lowerer.isSubclassOf(arm.className, other.className),
        ).length,
      }))
      .sort((a, b) => b.ancestors - a.ancestors);
    const body: IrStmt[] = [];
    for (const { arm, tag } of ordered) {
      if (arm.kind !== "object") continue;
      body.push({
        kind: "if",
        cond: { kind: "instanceOf", value: input, className: arm.className, type: BOOL, loc },
        then: [
          {
            kind: "return",
            value: {
              kind: "unionWrap",
              unionId: target.unionId,
              tag,
              value: { kind: "downcast", value: input, type: arm, loc },
              type: target,
              loc,
            },
            loc,
          },
        ],
        else_: null,
        loc,
      });
    }
    body.push({
      kind: "return",
      value: nodeThrowExpr(1, "", "Class value does not match the narrowed union", target, loc),
      loc,
    });
    lowerer.liftedFns.push({
      name: helper,
      params: [{ localId: "value.0", name: "value", type: source }],
      locals: [{ id: "value.0", name: "value", type: source, mutable: false }],
      returnType: target,
      body,
      loc,
    });
  }
  return { kind: "call", callee: helper, args: [value], type: target, loc };
}

/** Recover a class refinement from optional storage without treating the
 * checker's non-optional array element type as proof of presence. Only a
 * stricter class view qualifies; the stored tag and class are validated. */
export function narrowStoredClassValue(
  lowerer: Lowerer,
  value: IrExpr,
  target: IrType,
): IrExpr | null {
  if (value.type.kind !== "union") return null;
  const arms = lowerer.unions.get(value.type.unionId)?.arms;
  if (!arms) return null;
  if (target.kind === "object") {
    if (
      !arms.some(
        (arm) =>
          arm.kind === "object" &&
          arm.className !== target.className &&
          lowerer.isSubclassOf(target.className, arm.className),
      )
    )
      return null;
    return checkedClassAssertion(lowerer, value, target, value.loc);
  }
  if (target.kind !== "union") return null;
  const present = lowerer.stripUndefinedArm(value.type);
  if (present.kind !== "object") return null;
  const targetArms = lowerer.unions.get(target.unionId)?.arms;
  if (
    !targetArms?.length ||
    !targetArms.every(
      (arm) => arm.kind === "object" && lowerer.isSubclassOf(arm.className, present.className),
    )
  )
    return null;
  const extract = lowerer.narrowedArmHelper(value.type.unionId, present, value.loc);
  if (!extract) return null;
  return narrowClassUnion(
    lowerer,
    {
      kind: "call",
      callee: extract,
      args: [value],
      type: present,
      loc: value.loc,
    },
    target,
  );
}

/** An erased generic instanceof test identifies a family, not a concrete
 * field layout. Recover a demanded instantiation only after checking its
 * runtime membership; incompatible specializations cannot share payloads. */
export function narrowGenericClassValue(
  lowerer: Lowerer,
  value: IrExpr,
  expected: IrType,
): IrExpr | null {
  if (value.type.kind !== "object") return null;
  const family = lowerer.classes.get(value.type.className);
  if (!family?.generic || !lowerer.inHierarchy(family)) return null;
  const arms = expected.kind === "union" ? lowerer.unions.get(expected.unionId)?.arms : [expected];
  const candidates = arms?.filter(
    (arm) =>
      arm.kind === "object" &&
      lowerer.classes.get(arm.className)?.genericInstance?.family === family,
  );
  const target = candidates?.length === 1 ? candidates[0] : undefined;
  return target?.kind === "object"
    ? checkedClassAssertion(lowerer, value, target, value.loc)
    : null;
}
