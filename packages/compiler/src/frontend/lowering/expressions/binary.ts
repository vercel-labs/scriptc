/* Binary operators: arithmetic, comparisons and equality, logical and nullish pairs, and string conversion for concatenation. */
import { keyedHelperName } from "../stable-names.js";
import * as ts from "../../ts7/adapter.js";
import {
  lowerOptionalIndex,
  splitUndefinedIndex,
  undefinedTypedArrayKeyFence,
} from "../undefined-index.js";
import { cleanFuncAdaptable } from "../coercions/function-adapters.js";
import { type Lowerer, jsFuncNameOf } from "../lowerer.js";
import {
  BIGINT_T,
  BOOL,
  DYN,
  DYN_HANDLE_KINDS,
  F64,
  type IrExpr,
  type IrStmt,
  type IrType,
  REF_TRUTHY_KINDS,
  STRING,
  type SrcLoc,
  UNDEFINED_T,
  VOID,
  canBoxFuncIntoDyn,
  isUnitType,
  typeEquals,
  typeKey,
} from "../../../ir/ir.js";
import { isSafeToDiscard, isSafeToRepeat } from "./evaluation-safety.js";
import {
  bigintCompoundValue,
  compoundUnsupported,
  concatOperand,
  constructorGlobalTypeof,
  deferredSlotOr,
  dynCompoundValue,
  lowerAbsenceProbe,
  lowerDynMemberAssignment,
  lowerDereferencedElementAssignment,
  lowerOptionalNumber,
  lowerPresenceOperand,
  nullishBranches,
  operandPairs,
  operatorUnsupported,
  runtimeOptionalStorageOperand,
  symbolFieldInfo,
  typeofAnswer,
} from "../lower-exprs.js";
import { COMPOUND_ASSIGN_OPS, type CompoundOp, NARROW_FIRST } from "../surfaces.js";
import { lowerElementCompoundParts } from "./element-access.js";
import { InternalCompilerError } from "../../../errors.js";
import { isJsSourceFile, locOf } from "../../program.js";
import { storedClassValueType } from "../lower-classes.js";
import { builtinClassKind } from "../builtins/builtin-class-dyn.js";
import { hasRuntimeStatics } from "../class-runtime-statics.js";
import { tryLowerExpression } from "./try-lower-expression.js";
import { fenceNodeModuleMutation, lowerRequireCacheHas } from "../lower-node-module.js";
import { errorToStringCall } from "../error-methods.js";
import { classToStringConversion, classUnionToString } from "../class-to-primitive.js";
import { isPerfEntryType, perfEntryTag } from "../builtins/performance.js";
import { isX509Type, x509ToString } from "../builtins/x509.js";
import { guardNullProto, nullProtoRecordShape } from "../null-prototype.js";
import { numLit, varRef } from "../../../ir/build.js";
import { lowerUrlAssignment } from "../builtins/url.js";
import { lowerClassPrototypeComputedAssignment } from "../class-prototypes.js";
import { lowerShortCircuitAssignment } from "./nullish-assignment.js";
import { lowerEventObjectPropertyWrite } from "../lower-event-target.js";
import { lowerFieldCompoundValue } from "./updates.js";
import { expandoWritableTarget } from "../lower-expando.js";
import { nsWritableTarget } from "../lower-namespaces.js";
import { arrayValueStore, tryLowerBytesReadNumberEquality } from "../array-values.js";
import { cjsExportMemberWriteGlobalOf, cjsInFileExportGlobalOf } from "../cjs-exports-object.js";
import { lowerUnionFieldWrite } from "./union-fields.js";
import { lowerAbstractEquality } from "../abstract-equality.js";
import { lowerInExpression } from "./relational.js";
import { lowerDynTypeofTest, lowerErrorCodeTypeofTest } from "./typeof.js";
import { builtinClassRefOf, sameBuiltinClass } from "../builtins/class-values.js";
import {
  lowerRuntimeConstructorIs,
  runtimeConstructorReceiver,
} from "../builtins/runtime-constructor.js";
import { tryLowerIndexedComparison } from "../indexed-comparison.js";
import { lowerUnionEquality, tagEqualityMayMissAlias } from "../strict-equality.js";
import { withUnitArm } from "../../type-mapper.js";
import { npmStaticPackageOfPath } from "../../npm-static.js";
import { lowerWebAssemblyTypeof } from "../builtins/webassembly.js";

/** `v === undefined` / `v !== null` — the narrowing tests for unit-armed
 * unions. A union operand compared with a unit literal lowers to a
 * runtime TAG test (unionIsTag); afterwards tsc's control-flow narrowing
 * types the branches and reads bridge through maybeNarrow as usual. When
 * the checker already narrowed the non-literal side PAST the union
 * (`w = 5; if (w !== null)`), the comparison is statically decided and
 * folds to a bool literal — that drops only a side-effect-free read
 * (flow narrowing applies to references, never to calls), and soundness
 * rests on the same narrowing proof unionNarrow relies on. Null when
 * neither side is a unit literal (not a unit comparison). */
export function lowerUnitComparison(
  lowerer: Lowerer,
  left: IrExpr,
  right: IrExpr,
  negated: boolean,
  loc: SrcLoc,
): IrExpr | null {
  const unit = left.kind === "unitLit" ? left : right.kind === "unitLit" ? right : null;
  if (!unit) return null;
  const other = unit === left ? right : left;
  if (other.kind === "unitLit") {
    // Two unit literals (`undefined === undefined`): statically decided.
    return { kind: "boolLit", value: (other.unit === unit.unit) !== negated, type: BOOL, loc };
  }
  const slot = lowerer.deferredFieldSlot(other);
  if (slot) return lowerUnitComparison(lowerer, slot, unit, negated, loc);
  // A binding the checker narrowed past the unit can still hold it at
  // runtime when its value came from an unassigned deferred-init field;
  // the stored tag answers either way.
  if (
    other.kind === "unionNarrow" &&
    other.value.kind === "varRef" &&
    other.value.type.kind === "union" &&
    lowerer.armTag(other.value.type.unionId, unit.type) >= 0
  )
    return lowerUnitComparison(lowerer, other.value, unit, negated, loc);
  if (other.type.kind === "union") {
    const tag = lowerer.armTag(other.type.unionId, unit.type);
    if (tag < 0) {
      // A union WITHOUT that unit arm: legal TS (`miss === null` on a
      // `number | undefined` — null/undefined guard comparisons are
      // permitted against nullable-adjacent types), and === never
      // coerces, so the answer is the constant `negated`. The literal
      // must NOT flow into the union representation (the unionEq
      // fallback would coerce it through the stranded-arm trap and
      // throw where Node answers false). JS still evaluates the
      // operand, so a non-droppable one (`xs.find(f) === null` — the
      // callback's effects are observable) rides one throwaway tag
      // test; droppable reads fold to the bare literal.
      const answer: IrExpr = { kind: "boolLit", value: negated, type: BOOL, loc };
      if (isSafeToDiscard(other)) return answer;
      const evalOnce: IrExpr = {
        kind: "unionIsTag",
        unionId: other.type.unionId,
        tag: 0,
        negated: false,
        value: other,
        type: BOOL,
        loc,
      };
      return {
        kind: "logical",
        op: negated ? "||" : "&&",
        left: evalOnce,
        right: answer,
        type: BOOL,
        loc,
      };
    }
    return {
      kind: "unionIsTag",
      unionId: other.type.unionId,
      tag,
      negated,
      value: other,
      type: BOOL,
      loc,
    };
  }
  // A process.env read tsc narrowed past its union (an earlier write to
  // the same key): the environment is VOLATILE — `delete process.env.K`
  // undoes the write the narrowing rode on — so folding would bake a
  // stale answer. Compare the fresh read's union tag instead.
  const envRead = volatileEnvRead(other);
  if (envRead && envRead.type.kind === "union") {
    const tag = lowerer.armTag(envRead.type.unionId, unit.type);
    if (tag >= 0) {
      return {
        kind: "unionIsTag",
        unionId: envRead.type.unionId,
        tag,
        negated,
        value: envRead,
        type: BOOL,
        loc,
      };
    }
  }
  // A VOID-typed operand (`foo() === undefined` where foo's declared
  // return is undefined/void — the mapping folds both to void): JS
  // yields undefined from such a call, so the compare is TRUE-when-equal
  // — the opposite of the never-holds-units fold below — and the IR has
  // no value (nor a sequence form to keep the call's effects). Fall
  // through to the caller's comparison fence instead of folding a lie.
  if (other.type.kind === "void") return null;
  // Non-union operand: it can never hold undefined/null at runtime (the
  // checker narrowed it to a concrete arm), so `=== unit` is false and
  // `!== unit` is true.
  return { kind: "boolLit", value: negated, type: BOOL, loc };
}

/** The union-typed process.envGet read inside a checker-narrowed operand,
 * or null — the volatility escape above (and lowerLooseNullCompare's). */
function volatileEnvRead(e: IrExpr): IrExpr | null {
  if (e.kind === "libCall" && e.fn === "process.envGet") return e;
  if (e.kind === "unionNarrow" && e.value.kind === "libCall" && e.value.fn === "process.envGet") {
    return e.value;
  }
  return null;
}

function lowerLooseNullCompare(
  lowerer: Lowerer,
  expr: ts.BinaryExpression,
  loc: SrcLoc,
): IrExpr | null {
  const negated = expr.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsToken;
  const unwrap = (e: ts.Expression): ts.Expression =>
    ts.isParenthesizedExpression(e) ? unwrap(e.expression) : e;
  const left = unwrap(expr.left);
  const right = unwrap(expr.right);
  const leftIsNull = left.kind === ts.SyntaxKind.NullKeyword;
  if (!leftIsNull && right.kind !== ts.SyntaxKind.NullKeyword) return null;
  const otherNode = leftIsNull ? right : left;
  const other = lowerPresenceOperand(lowerer, otherNode);
  if (isUnitType(other.type)) {
    // `null == null`, `undefined == null`: units are mutually loose-equal.
    return { kind: "boolLit", value: !negated, type: BOOL, loc };
  }
  if (other.type.kind === "dyn") {
    // `v != null` on unknown: one dyn kind test covers both units.
    return {
      kind: "dynTest",
      test: "nullish",
      ...(negated ? { negated: true as const } : {}),
      value: other,
      type: BOOL,
      loc,
    };
  }
  if (other.type.kind === "union") {
    const ut = other.type;
    const def = lowerer.unions.get(ut.unionId);
    if (!def) lowerer.badType(otherNode, lowerer.typeOf(otherNode));
    const tags = def.arms.flatMap((a, i) => (isUnitType(a) ? [i] : []));
    if (tags.length === 0) {
      // No unit arms: never null-ish (defensive — the fold below).
      return { kind: "boolLit", value: negated, type: BOOL, loc };
    }
    const isTag = (tag: number, value: IrExpr): IrExpr => ({
      kind: "unionIsTag",
      unionId: ut.unionId,
      tag,
      negated,
      value,
      type: BOOL,
      loc,
    });
    if (tags.length === 1) return isTag(tags[0]!, other);
    // Both null AND undefined arms: tag-in-set as a short-circuit pair
    // (De Morgan for `!=`). The operand rides both tests, so an operand
    // that is not a plain read (`m.get(k)! == null`) is evaluated once
    // into a hidden local first.
    let value = other;
    let prefix: IrStmt[] = [];
    if (!isSafeToRepeat(other)) {
      const tmp = lowerer.declareHiddenLocal("%nullish", ut);
      value = varRef(tmp.id, ut, loc);
      prefix = [{ kind: "varDecl", localId: tmp.id, init: other, loc }];
    }
    const test: IrExpr = {
      kind: "logical",
      op: negated ? "&&" : "||",
      left: isTag(tags[0]!, value),
      right: isTag(tags[1]!, value),
      type: BOOL,
      loc,
    };
    return prefix.length === 0
      ? test
      : { kind: "seqExpr", stmts: prefix, result: test, type: BOOL, loc };
  }
  if (other.type.kind === "void") {
    return null; // no static tag to test — keep the fence
  }
  // The env-volatility escape (see lowerUnitComparison): a narrowed
  // process.env read compares its FRESH union tag instead of folding.
  const envRead = volatileEnvRead(other);
  if (envRead && envRead.type.kind === "union") {
    const def = lowerer.unions.get(envRead.type.unionId);
    const tag = def ? def.arms.findIndex((a) => isUnitType(a)) : -1;
    if (tag >= 0) {
      return {
        kind: "unionIsTag",
        unionId: envRead.type.unionId,
        tag,
        negated,
        value: envRead,
        type: BOOL,
        loc,
      };
    }
  }
  // A non-nullable operand (tsc allows the comparison as a guard):
  // `== null` is statically false, `!= null` statically true.
  return { kind: "boolLit", value: negated, type: BOOL, loc };
}

/** A plain value read that may be runtime-optional: an unchecked element
 * read, or a binding, member or call that carries one. Lowering these
 * without a destination type is the same as lowering them into one. */
function isPlainValueRead(node: ts.Expression): boolean {
  while (ts.isParenthesizedExpression(node)) node = node.expression;
  return (
    ts.isElementAccessExpression(node) ||
    ts.isIdentifier(node) ||
    ts.isPropertyAccessExpression(node) ||
    ts.isCallExpression(node)
  );
}

/** A member access or call receiver needs the present value itself (JS
 * throws a TypeError reading a member of undefined). */
function isMemberReceiver(node: ts.Expression): boolean {
  let child: ts.Node = node;
  let parent = node.parent;
  while (ts.isParenthesizedExpression(parent)) {
    child = parent;
    parent = parent.parent;
  }
  return (
    ((ts.isPropertyAccessExpression(parent) ||
      ts.isElementAccessExpression(parent) ||
      ts.isCallExpression(parent)) &&
      parent.expression === child) ||
    (ts.isTaggedTemplateExpression(parent) && parent.tag === child)
  );
}

/** A literal default (`0`, `-1`, `""`, `true`): it always has its own type.
 * Other defaults, such as an element read that can be undefined, keep the
 * dynamic path. */
function literalDefault(node: ts.Expression): boolean {
  while (ts.isParenthesizedExpression(node)) node = node.expression;
  if (
    ts.isPrefixUnaryExpression(node) &&
    (node.operator === ts.SyntaxKind.MinusToken || node.operator === ts.SyntaxKind.PlusToken)
  )
    node = node.operand;
  return (
    ts.isNumericLiteral(node) ||
    ts.isStringLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    node.kind === ts.SyntaxKind.TrueKeyword ||
    node.kind === ts.SyntaxKind.FalseKeyword
  );
}

export function lowerNullishPair(
  lowerer: Lowerer,
  expr: ts.BinaryExpression,
  loc: SrcLoc,
  left: IrExpr,
): IrExpr {
  if (left.type.kind === "dyn") {
    // `a ?? b` on a CHECKED-DYNAMIC left: the deciding test is the
    // runtime kind (scr_dyn_is_nullish — UNDEF/NULL take the default).
    // Both sides live in the checked-dynamic tree — the right converts through
    // the usual boundary and evaluates lazily in its branch; a default
    // with no dyn representation keeps the fence.
    const right = lowerer.coerceToExpected(lowerer.lowerExpr(expr.right), DYN);
    if (right.type.kind !== "dyn") {
      lowerer.unsupported(
        "SC1100",
        expr,
        "nullish coalescing on 'unknown' values against defaults with no dynamic representation",
      );
    }
    return { kind: "nullish", left, right, type: DYN, loc };
  }

  if (left.type.kind !== "union") return left;
  const def = lowerer.unions.get(left.type.unionId);
  if (!def) lowerer.badType(expr.left, lowerer.typeOf(expr.left));
  if (!def.arms.some(isUnitType)) return left;
  const rest = def.arms.filter((a) => !isUnitType(a));
  // `optionalMap ?? new Map()` carries its element contract on the left;
  // the empty fallback may use it without constructing a Map<any, any>
  // arm that has no first-class union representation.
  const fresh = rest.length === 1 ? lowerer.emptyCollectionFor(expr.right, rest[0]!) : null;
  if (fresh) return { kind: "nullish", left, right: fresh, type: fresh.type, loc };
  let type = lowerer.irTypeOf(expr);
  // A runtime-optional read can reach the default even when declarations
  // call the left side present. Preserve a differently typed primitive
  // fallback rather than checking it against that incomplete result type.
  const rightType = lowerer.mapTypeOf(lowerer.typeOf(expr.right));
  const primitive = (t: IrType): boolean =>
    t.kind === "f64" || t.kind === "string" || t.kind === "bool";
  if (
    rightType &&
    primitive(type) &&
    primitive(rightType) &&
    !typeEquals(type, rightType) &&
    rest.every(primitive)
  ) {
    const arms = [...rest];
    if (!arms.some((arm) => typeEquals(arm, rightType))) arms.push(rightType);
    arms.sort((a, b) => (typeKey(a) < typeKey(b) ? -1 : 1));
    type = { kind: "union", unionId: lowerer.unions.intern(arms) };
    lowerer.runtimeOptionalArithmeticTypes.set(expr, type);
  }
  if (type.kind === "dyn" && lowerer.dynConvertible(left.type)) {
    // `counts.get(k) ?? 0` in JavaScript: a scalar optional left and a
    // default of its value's type give a scalar, so the test and the default
    // run on the typed path and only the result converts. Converting the
    // optional left itself would allocate a union for every read.
    if (
      rest.length === 1 &&
      primitive(rest[0]!) &&
      rightType &&
      typeEquals(rightType, rest[0]!) &&
      literalDefault(expr.right)
    ) {
      const typed: IrExpr = {
        kind: "nullish",
        left,
        right: lowerer.lowerExprExpecting(expr.right, rest[0]!),
        type: rest[0]!,
        loc,
      };
      return lowerer.coerceToExpected(typed, DYN);
    }
    return {
      kind: "nullish",
      left: lowerer.coerceToExpected(left, DYN),
      right: lowerer.lowerExprExpecting(expr.right, DYN),
      type: DYN,
      loc,
    };
  }
  // A runtime-optional default (`name ?? names[0]`): the checker types an
  // unchecked element read as the bare element type, but an out-of-range
  // read is undefined at runtime. When the default shares the left's
  // optional union, that union is the result, so the undefined state
  // reaches the consumer (an optional return or parameter takes it as its
  // undefined arm; a plain slot still extracts the element with its
  // checked narrow).
  if (
    rest.length === 1 &&
    typeEquals(type, rest[0]!) &&
    isPlainValueRead(expr.right) &&
    !isMemberReceiver(expr)
  ) {
    const raw = lowerer.lowerExpr(expr.right);
    if (typeEquals(raw.type, left.type))
      return { kind: "nullish", left, right: raw, type: left.type, loc };
    // `names[0] ?? undefined`: an explicit unit default stays the left's arm.
    if (isUnitType(raw.type) && lowerer.armTag(left.type.unionId, raw.type) >= 0) {
      const right = lowerer.coerceInto(expr.right, raw, left.type);
      return { kind: "nullish", left, right, type: left.type, loc };
    }
    return { kind: "nullish", left, right: lowerer.coerceInto(expr.right, raw, type), type, loc };
  }
  if (typeEquals(type, left.type) || (rest.length === 1 && typeEquals(type, rest[0]!))) {
    const right = lowerer.lowerExprExpecting(expr.right, type);
    return { kind: "nullish", left, right, type, loc };
  }
  if (type.kind !== "union" && rest.length > 1 && rest.some((arm) => typeEquals(arm, type))) {
    const helper = lowerer.narrowedArmHelper(left.type.unionId, type, loc);
    if (helper !== null) {
      return nullishBranches(
        lowerer,
        left,
        left.type,
        def.arms,
        type,
        loc,
        () => lowerer.lowerExprExpecting(expr.right, type),
        (stable) => ({ kind: "call", callee: helper, args: [stable], type, loc }),
      );
    }
  }
  // A subclass value defaulted to a base-class value (`circle ?? shape`):
  // the present arm upcasts after the original nullish test, and the
  // default lowers lazily into the base-class result.
  const present = rest.length === 1 ? rest[0]! : null;
  if (
    present?.kind === "object" &&
    type.kind === "object" &&
    present.className !== type.className &&
    lowerer.isSubclassOf(present.className, type.className)
  ) {
    const helper = lowerer.narrowedArmHelper(left.type.unionId, present, loc);
    if (helper !== null) {
      return nullishBranches(
        lowerer,
        left,
        left.type,
        def.arms,
        type,
        loc,
        () => lowerer.lowerExprExpecting(expr.right, type),
        (stable) => ({
          kind: "upcast",
          value: { kind: "call", callee: helper, args: [stable], type: present, loc },
          type,
          loc,
        }),
      );
    }
  }
  // A default may change the union or widen its records. Test the
  // original tag before coercing: converting the whole left first can
  // lose nullish arms, and evaluating the default eagerly loses laziness.
  if (type.kind === "union") {
    const retag =
      lowerer.unionRetagHelper(left.type.unionId, type.unionId, loc) ??
      lowerer.narrowedRetagHelper(expr.left, left.type.unionId, type.unionId, loc);
    if (retag !== null) {
      // Narrowing may exclude a record/class arm while storage retains
      // it. The checked retag traps that impossible arm, but only AFTER
      // the original nullish test: null/undefined must reach the lazy
      // default even when neither is representable in the result.
      return nullishBranches(
        lowerer,
        left,
        left.type,
        def.arms,
        type,
        loc,
        () => lowerer.lowerExprExpecting(expr.right, type),
        (stable) => ({ kind: "call", callee: retag, args: [stable], type, loc }),
      );
    }
  }
  // An optional callback defaulted to a function of another signature
  // (`o.tags ?? (() => ({}))`, fewer parameters or a narrower result): the
  // result is the callback's own function type, and the default adapts into
  // it (JavaScript ignores surplus arguments). The checker's merged union
  // signature would lose the callback's result shape.
  if (present?.kind === "func" && present.rest !== true) {
    const raw = lowerer.lowerExpr(expr.right);
    if (
      raw.type.kind === "func" &&
      (typeEquals(raw.type, present) || cleanFuncAdaptable(lowerer, raw.type, present))
    ) {
      const right = lowerer.coerceInto(expr.right, raw, present);
      lowerer.nullishFuncResults.add(expr);
      return { kind: "nullish", left, right, type: present, loc };
    }
  }
  lowerer.unsupported(
    "SC1090",
    expr,
    rest.length !== 1
      ? `'??' on '${lowerer.fmt(left.type)}' (the non-nullish result is a sub-union; check a discriminant field first)`
      : `'??' where the default changes the result type (left is '${lowerer.fmt(left.type)}' but the whole expression is '${lowerer.fmt(type)}' — give both sides one type)`,
  );
}

/** `a[i] op= rhs` over native arrays and byte views. A compound assignment
 * evaluates the receiver and index, reads the old element, evaluates rhs,
 * then writes. Capture each stage so a call in the index or rhs cannot
 * change the target or the value used by the operator. The expression yields
 * the computed value before a typed array or Buffer coerces it for storage. */
export function lowerElementCompound(
  lowerer: Lowerer,
  expr: ts.BinaryExpression,
  op: CompoundOp,
): IrExpr {
  const lowered = lowerElementCompoundParts(lowerer, expr, op, false);
  if (!lowered.expr)
    throw new InternalCompilerError("a compound element value lowered to statements");
  return lowered.expr;
}

/** JavaScript callable members live on the closure, so aliases and chained
 * writes share the same storage as Object.defineProperties. */
export function lowerNativeFunctionAssignment(
  lowerer: Lowerer,
  expr: ts.BinaryExpression,
): IrExpr | null {
  const target = expr.left;
  if (
    !isJsSourceFile(ts.getSourceFileOfNode(expr)) ||
    (!ts.isPropertyAccessExpression(target) && !ts.isElementAccessExpression(target)) ||
    target.questionDotToken
  )
    return null;
  // Checked constructors share the callable's live property descriptors.
  const classType = storedClassValueType(lowerer, target.expression);
  const staticClass =
    classType?.kind === "classval" ? lowerer.classes.get(classType.className) : undefined;
  if (staticClass && hasRuntimeStatics(staticClass)) {
    return lowerDynMemberAssignment(
      lowerer,
      expr,
      lowerer.lowerExprExpecting(target.expression, DYN),
    );
  }
  // Other class statics and prototype tables have their own paths.
  // Probing them as ordinary functions could materialize unused methods.
  if (
    lowerer.exactClassOfReceiver(target.expression) ||
    (ts.isPropertyAccessExpression(target.expression) &&
      target.expression.name.text === "prototype" &&
      lowerer.exactClassOfReceiver(target.expression.expression))
  )
    return null;
  const receiver = tryLowerExpression(lowerer, target.expression);
  if (
    receiver?.type.kind !== "func" ||
    !canBoxFuncIntoDyn(
      receiver.type,
      (id) => lowerer.shapes.get(id),
      (id) => lowerer.unions.get(id),
    )
  )
    return null;
  fenceNodeModuleMutation(lowerer, target, "assignment");
  const fnName = jsFuncNameOf(target.expression);
  const boxed: IrExpr = {
    kind: "dynFrom",
    value: receiver,
    type: DYN,
    loc: locOf(target.expression),
    ...(fnName !== null ? { fnName } : {}),
  };
  return lowerDynMemberAssignment(lowerer, expr, boxed);
}

/** `typeof globalThis.AbortSignal.any === "function"`: the comparison
 * folds with constructorGlobalTypeof's answer. */
function lowerConstructorGlobalTypeofTest(
  lowerer: Lowerer,
  expr: ts.BinaryExpression,
  loc: SrcLoc,
): IrExpr | null {
  const negated = expr.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken;
  for (const [a, b] of operandPairs(expr)) {
    if (!ts.isTypeOfExpression(a) || !ts.isStringLiteral(b)) continue;
    const answer = constructorGlobalTypeof(lowerer, a.expression);
    if (answer !== null)
      return { kind: "boolLit", value: (answer === b.text) !== negated, type: BOOL, loc };
  }
  return null;
}

export function ensureString(lowerer: Lowerer, e: IrExpr, node: ts.Node): IrExpr {
  if (e.type.kind === "string") return e;
  if (e.type.kind === "url")
    return { kind: "libCall", fn: "url.href", args: [e], type: STRING, loc: e.loc };
  // String(date) / `${date}` / "" + date: Date's ToPrimitive prefers
  // toString().
  if (e.type.kind === "date")
    return { kind: "libCall", fn: "date.toString", args: [e], type: STRING, loc: e.loc };
  if (e.type.kind === "regex") {
    return {
      kind: "regexIntrinsic",
      method: "toString",
      receiver: e,
      args: [],
      type: STRING,
      loc: e.loc,
    };
  }
  if (e.type.kind === "bigint") {
    return {
      kind: "libCall",
      fn: "bigint.toString",
      args: [e, { kind: "numLit", value: 10, type: F64, loc: e.loc }],
      type: STRING,
      loc: e.loc,
    };
  }
  if (e.type.kind === "dyn") {
    // String(u) / `${u}`: a runtime dispatch over the dyn kind — Node's
    // String() exactly (undefined/null texts, JS number formatting,
    // strings verbatim, arrays via join, objects as "[object Object]").
    return { kind: "toString", operand: e, type: STRING, loc: e.loc };
  }
  if (e.type.kind === "bytes") {
    // Preserve the runtime brand: typed arrays join numeric elements,
    // while a Buffer stored in a Uint8Array slot decodes its bytes.
    const boxed: IrExpr = { kind: "dynFrom", value: e, type: DYN, loc: e.loc };
    return { kind: "toString", operand: boxed, type: STRING, loc: e.loc };
  }

  if (e.type.kind === "object") {
    // String(err) / `${err}` uses the same dispatch as err.toString().
    for (let c = lowerer.classes.get(e.type.className) ?? null; c; c = c.base) {
      if (c.builtinError) {
        return errorToStringCall(lowerer, e);
      }
    }
    // A program class instance converts through its own methods.
    const converted = classToStringConversion(lowerer, e, "string", node);
    if (converted) return converted;
  }
  if (e.type.kind === "union") {
    // `${u}` — the arm's ToString via a per-union interned helper
    // (sc_us_*), Node-exact per arm kind: unit arms are the known texts
    // "undefined"/"null", string arms pass through, f64/bool arms use the
    // JS-exact formatters. Ref arms (records, arrays, ...) stay fenced:
    // JS would print "[object Object]" and friends — narrow first.
    const def = lowerer.unions.get(e.type.unionId);
    const stringable = def?.arms.every(
      (a) =>
        a.kind === "undefinedT" ||
        a.kind === "nullT" ||
        a.kind === "string" ||
        a.kind === "f64" ||
        a.kind === "bigint" ||
        a.kind === "bool",
    );
    if (stringable) {
      return { kind: "toString", operand: e, type: STRING, loc: e.loc };
    }
    // Runtime-optional locals can retain their stored union after the
    // checker has narrowed this use to a primitive arm. Validate that
    // arm before converting it; an unguarded object arm stays fenced.
    const narrowed = lowerer.mapTypeOf(lowerer.typeOf(node));
    if (
      narrowed &&
      (narrowed.kind === "string" ||
        narrowed.kind === "f64" ||
        narrowed.kind === "bool" ||
        narrowed.kind === "bigint")
    ) {
      const helper = lowerer.narrowedArmHelper(e.type.unionId, narrowed, e.loc);
      if (helper) {
        return ensureString(lowerer, lowerer.checkedNarrowCall(helper, e, narrowed, e.loc), node);
      }
    }
    if (
      narrowed?.kind === "union" &&
      !typeEquals(narrowed, e.type) &&
      lowerer.unions
        .get(narrowed.unionId)
        ?.arms.every(
          (arm) =>
            isUnitType(arm) ||
            arm.kind === "string" ||
            arm.kind === "f64" ||
            arm.kind === "bool" ||
            arm.kind === "bigint",
        )
    ) {
      const helper = lowerer.narrowedRetagHelper(node, e.type.unionId, narrowed.unionId, e.loc);
      if (helper)
        return ensureString(
          lowerer,
          { kind: "call", callee: helper, args: [e], type: narrowed, loc: e.loc },
          node,
        );
    }
    const viaClasses = classUnionToString(lowerer, e, "string", node);
    if (viaClasses) return viaClasses;
    lowerer.unsupported(
      "SC1090",
      node,
      `string conversions of unions with object arms (${NARROW_FIRST})`,
    );
  }
  if (e.type.kind === "symbol") {
    // JS splits here: `${sym}` and concatenation THROW a TypeError,
    // String(sym) answers "Symbol(desc)". One shared lowering cannot
    // honor both — fence with the sanctioned spelling instead of
    // guessing the context.
    lowerer.unsupported(
      "SC1090",
      node,
      "string conversions of symbol values (template literals throw in JS — call .toString() explicitly)",
    );
  }
  if (isUnitType(e.type)) {
    if (e.kind === "unitLit") {
      return { kind: "strLit", value: e.unit, type: STRING, loc: e.loc };
    }
    // Keep sequencing and branch effects even though the final unit's
    // spelling is constant. Never turn an unknown producer into a literal.
    if (e.kind === "seqExpr") {
      return { ...e, result: lowerer.ensureString(e.result, node), type: STRING };
    }
    if (e.kind === "ternary") {
      return {
        ...e,
        then: lowerer.ensureString(e.then, node),
        else_: lowerer.ensureString(e.else_, node),
        type: STRING,
      };
    }
    lowerer.unsupported(
      "SC1090",
      node,
      `string conversions of '${e.type.kind === "undefinedT" ? "undefined" : "null"}' values`,
    );
  }
  if (e.type.kind === "array") {
    // `${[1,2,3]}` / String(arr): Array.prototype.toString IS join(",")
    // — the SAME intrinsic the .join() lowering emits, fenced to the
    // same element kinds (f64/string/bool, unions of those with unit
    // arms printing empty). Nested arrays would need JS's recursive
    // dispatch — the join fence already tells that story.
    const elem = e.type.elem;
    const joinableUnion =
      elem.kind === "union" &&
      (lowerer.unions
        .get(elem.unionId)
        ?.arms.every(
          (a) =>
            a.kind === "f64" ||
            a.kind === "string" ||
            a.kind === "bool" ||
            a.kind === "date" ||
            isUnitType(a),
        ) ??
        false);
    // Checked-dynamic elements: the runtime's String() over the array's
    // dyn form (its join, element by element).
    if (elem.kind === "dyn") {
      const boxed: IrExpr = { kind: "dynFrom", value: e, type: DYN, loc: e.loc };
      return { kind: "toString", operand: boxed, type: STRING, loc: e.loc };
    }
    if (
      elem.kind === "f64" ||
      elem.kind === "string" ||
      elem.kind === "bool" ||
      elem.kind === "date" ||
      joinableUnion
    ) {
      const sep: IrExpr = { kind: "strLit", value: ",", type: STRING, loc: e.loc };
      return {
        kind: "arrIntrinsic",
        method: "join",
        receiver: e,
        args: [sep],
        type: STRING,
        loc: e.loc,
      };
    }
  }
  if (e.type.kind === "record") {
    // `${obj}` / String(obj): a plain data record has no toString of its
    // own (a func-typed `toString` FIELD would shadow the prototype's —
    // JS would call it, so that shape keeps the fence), and a TUPLE
    // prints its elements like an array (not lowered — fenced) — every
    // other record is Object.prototype.toString's constant.
    const shape = lowerer.shapes.get(e.type.shapeId);
    if (isPerfEntryType(lowerer, e.type)) return perfEntryTag(lowerer, e, e.type, e.loc);
    if (isX509Type(lowerer, e.type)) return x509ToString(e, e.loc);
    if (shape && !shape.tuple && !shape.fields.some((f) => f.name === "toString")) {
      // A null-prototype record (Object.groupBy) has no toString or
      // valueOf: ToPrimitive throws Node's TypeError.
      const nullProtoT = nullProtoRecordShape(lowerer, e.type);
      if (nullProtoT) return nullProtoToString(lowerer, e, nullProtoT);
      return { kind: "toString", operand: e, type: STRING, loc: e.loc };
    }
  }
  if (e.type.kind !== "f64" && e.type.kind !== "bool") lowerer.badType(node, lowerer.typeOf(node));
  return { kind: "toString", operand: e, type: STRING, loc: e.loc };
}

/** String(r) over a record that may have a null prototype: an interned
 * helper that throws Node's TypeError for a null-prototype record and
 * answers "[object Object]" otherwise. */
function nullProtoToString(lowerer: Lowerer, e: IrExpr, t: IrType & { kind: "record" }): IrExpr {
  const loc = e.loc;
  const key = `nullProtoToString:${t.shapeId}`;
  let helper = lowerer.valueHelpers.get(key);
  if (!helper) {
    helper = keyedHelperName(lowerer, "%rec.tostr", key);
    lowerer.valueHelpers.set(key, helper);
    const r = varRef("r.0", t, loc);
    lowerer.liftedFns.push({
      name: helper,
      params: [{ localId: "r.0", name: "r", type: t }],
      returnType: STRING,
      locals: [{ id: "r.0", name: "r", type: t, mutable: false }],
      body: [
        {
          kind: "return",
          value: guardNullProto(
            r,
            t.shapeId,
            "Cannot convert object to primitive value",
            { kind: "toString", operand: r, type: STRING, loc },
            loc,
          ),
          loc,
        },
      ],
      loc,
    });
  }
  return { kind: "call", callee: helper, args: [e], type: STRING, loc };
}

/** Whether a lowered statement can live inside a seqExpr. These statements
 * do not leave the expression through a jump; the native emitters can place
 * their writes and local state branches before evaluating the final result.
 * Blocks check their bodies recursively. */
function seqExprSafeStmt(s: IrStmt): boolean {
  switch (s.kind) {
    case "varDecl":
    case "assign":
    case "exprStmt":
    case "fieldSet":
    case "recordSet":
    case "recordKeySet":
    case "arraySet":
    case "arraySetLength":
    case "bytesSet":
    case "arraySetUndefined":
    case "arrayDelete":
      return true;
    case "if":
      return s.then.every(seqExprSafeStmt) && (s.else_?.every(seqExprSafeStmt) ?? true);
    case "block":
      return s.body.every(seqExprSafeStmt);
    default:
      return false;
  }
}

export function lowerCompoundValueToTarget(
  lowerer: Lowerer,
  expr: ts.BinaryExpression,
  compound: CompoundOp,
  target: { id: string; type: IrType },
): IrExpr {
  const loc = locOf(expr);
  const read: IrExpr = {
    kind: "varRef",
    localId: target.id,
    type: target.type,
    loc: locOf(expr.left),
  };
  const rhs = lowerer.lowerExpr(expr.right);
  const numericRead = lowerOptionalNumber(lowerer, read, loc);
  const numericRhs = lowerOptionalNumber(lowerer, rhs, loc);

  if (
    compound === "+" &&
    (target.type.kind === "string" ||
      (target.type.kind === "union" &&
        lowerer.stripUndefinedArm(target.type).kind === "string" &&
        rhs.type.kind === "string"))
  ) {
    return lowerer.coerceInto(
      expr,
      {
        kind: "strConcat",
        left: lowerer.ensureString(read, expr.left),
        right: concatOperand(lowerer, rhs, expr.right),
        type: STRING,
        loc,
      },
      target.type,
    );
  }
  if (numericRead.type.kind === "f64" && numericRhs.type.kind === "f64") {
    return lowerer.coerceInto(
      expr,
      { kind: "bin", op: compound, left: numericRead, right: numericRhs, type: F64, loc },
      target.type,
    );
  }
  // An untyped operand: exactly the expanded `x = x op rhs` — the runtime
  // operator on both values, then the checked conversion into the
  // target's declared type (a string result for a number target throws the
  // catchable TypeError, as the expanded assignment does).
  // A union operand (`fraction += "0"` on a binding the program assigns
  // both a number and a string) takes the same runtime operator.
  if (
    ((target.type.kind === "dyn" || rhs.type.kind === "dyn") &&
      (isJsSourceFile(ts.getSourceFileOfNode(expr)) ||
        (lowerer.dynConvertible(read.type) && lowerer.dynConvertible(rhs.type)))) ||
    ((target.type.kind === "union" || rhs.type.kind === "union") &&
      lowerer.dynConvertible(read.type) &&
      lowerer.dynConvertible(rhs.type))
  ) {
    const left = lowerer.coerceInto(expr.left, read, DYN);
    const right = lowerer.coerceInto(expr.right, rhs, DYN);
    return lowerer.coerceInto(expr, dynCompoundValue(compound, left, right, loc), target.type);
  }
  const bigint = bigintCompoundValue(compound, read, rhs, loc);
  if (bigint) return bigint;
  compoundUnsupported(lowerer, expr, compound, read.type, rhs.type);
}

/** Equality of two NaN-coded values (nan-coded-reads.ts), each of which may
 * stand for undefined and never holds a genuine NaN: Node's undefined equals
 * undefined, so two NaNs compare equal here. Operands evaluate once, in
 * order. */
function lowerNanCodedEquality(lowerer: Lowerer, expr: ts.BinaryExpression): IrExpr | null {
  const loc = locOf(expr);
  const left = lowerer.lowerExpr(expr.left);
  const right = lowerer.lowerExpr(expr.right);
  if (left.type.kind !== "f64" || right.type.kind !== "f64") {
    throw new InternalCompilerError("NaN-coded equality operand is not a plain number");
  }
  const stmts: IrStmt[] = [];
  const stable = (value: IrExpr, name: string): IrExpr => {
    if (value.kind === "varRef" || value.kind === "numLit") return value;
    const tmp = lowerer.declareHiddenLocal(name, F64);
    stmts.push({ kind: "varDecl", localId: tmp.id, init: value, loc });
    return varRef(tmp.id, F64, loc);
  };
  const a = stable(left, "%eqLeft");
  const b = stable(right, "%eqRight");
  const isNaN = (value: IrExpr): IrExpr => ({
    kind: "libCall",
    fn: "num.isNaN",
    args: [value],
    type: BOOL,
    loc,
  });
  const bothUndefined: IrExpr = {
    kind: "logical",
    op: "&&",
    left: isNaN(a),
    right: isNaN(b),
    type: BOOL,
    loc,
  };
  const op = expr.operatorToken.kind;
  const negated =
    op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
    op === ts.SyntaxKind.ExclamationEqualsToken;
  const result: IrExpr = negated
    ? {
        kind: "logical",
        op: "&&",
        left: { kind: "bin", op: "!==", left: a, right: b, type: BOOL, loc },
        right: { kind: "unary", op: "!", operand: bothUndefined, type: BOOL, loc },
        type: BOOL,
        loc,
      }
    : {
        kind: "logical",
        op: "||",
        left: { kind: "bin", op: "===", left: a, right: b, type: BOOL, loc },
        right: bothUndefined,
        type: BOOL,
        loc,
      };
  return stmts.length === 0 ? result : { kind: "seqExpr", stmts, result, type: BOOL, loc };
}

export function lowerBinary(lowerer: Lowerer, expr: ts.BinaryExpression): IrExpr {
  const loc = locOf(expr);
  const op = expr.operatorToken.kind;

  const cacheHas = lowerRequireCacheHas(lowerer, expr);
  if (cacheHas) return cacheHas;

  if (lowerer.nanCodedReads?.needsUndefinedEquality(expr)) {
    const undefinedEquality = lowerNanCodedEquality(lowerer, expr);
    if (undefinedEquality) return undefinedEquality;
  }

  if (
    op === ts.SyntaxKind.EqualsToken ||
    (op >= ts.SyntaxKind.FirstCompoundAssignment && op <= ts.SyntaxKind.LastCompoundAssignment)
  ) {
    const urlWrite = lowerUrlAssignment(lowerer, expr);
    if (urlWrite) return urlWrite;
    if (op === ts.SyntaxKind.EqualsToken) {
      const prototypeWrite = lowerClassPrototypeComputedAssignment(lowerer, expr);
      if (prototypeWrite) return prototypeWrite;
      const callableWrite = lowerNativeFunctionAssignment(lowerer, expr);
      if (callableWrite) return callableWrite;
      const dereferenced = lowerDereferencedElementAssignment(lowerer, expr);
      if (dereferenced) return dereferenced;
    }
    if (
      op === ts.SyntaxKind.QuestionQuestionEqualsToken ||
      op === ts.SyntaxKind.AmpersandAmpersandEqualsToken ||
      op === ts.SyntaxKind.BarBarEqualsToken
    ) {
      return lowerShortCircuitAssignment(lowerer, expr);
    }
    if (ts.isPropertyAccessExpression(expr.left) || ts.isElementAccessExpression(expr.left)) {
      fenceNodeModuleMutation(lowerer, expr.left, "assignment");
    }
    // The writable Event accessors on Event subclass instances, in value
    // position (`const r = (event.returnValue = false)`).
    if (op === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(expr.left)) {
      const eventWrite = lowerEventObjectPropertyWrite(lowerer, expr.left, expr.right);
      if (eventWrite) return eventWrite;
    }
    // `x = e` in EXPRESSION position (`while ((idx = s.indexOf("\n")) !== -1)`,
    // `f(x = v)`): evaluate e once, write the binding, yield the assigned
    // value — JS evaluation order. Variable targets only (locals and module
    // globals, captured/boxed included); the RHS coerces into the binding's
    // type exactly like statement position, and the expression's value is
    // the coerced binding-typed value (representation change only — never
    // observably different from JS's raw-RHS yield). Indexed compounds
    // use a sequenced read/modify/write; other member targets and
    // destructuring targets stay fenced.
    if (op === ts.SyntaxKind.EqualsToken && ts.isIdentifier(expr.left)) {
      const target = lowerer.resolveWritable(expr.left);
      if (!target) {
        lowerer.rejectUnresolved(
          expr.left,
          `assignment to '${expr.left.text}' (not a writable local or module global)`,
        );
      }
      const value = lowerer.lowerExprExpecting(expr.right, target.type);
      const runtimeOptionalRoot = lowerer.runtimeOptionalRootOf(target);
      if (lowerer.runtimeOptionalStorageLocals.has(runtimeOptionalRoot))
        lowerer.runtimeOptionalLocals.add(runtimeOptionalRoot);
      return { kind: "assignExpr", localId: target.id, value, type: target.type, loc };
    }
    const indexedCompound = COMPOUND_ASSIGN_OPS[op];
    if (indexedCompound !== undefined && ts.isElementAccessExpression(expr.left)) {
      if (symbolFieldInfo(lowerer, expr.left))
        return lowerFieldCompoundValue(lowerer, expr.left, indexedCompound, expr.right, loc);
      return lowerElementCompound(lowerer, expr, indexedCompound);
    }
    if (indexedCompound !== undefined && ts.isIdentifier(expr.left)) {
      const target = lowerer.resolveWritable(expr.left);
      if (!target) {
        lowerer.rejectUnresolved(expr.left, "assignment to an unresolved variable");
      }
      const value = lowerCompoundValueToTarget(lowerer, expr, indexedCompound, target);
      return { kind: "assignExpr", localId: target.id, value, type: target.type, loc };
    }
    if (
      indexedCompound !== undefined &&
      (ts.isPropertyAccessExpression(expr.left) || ts.isElementAccessExpression(expr.left)) &&
      !(ts.isPropertyAccessExpression(expr.left) && expr.left.questionDotToken)
    ) {
      const target =
        expandoWritableTarget(lowerer, expr.left) ??
        (ts.isPropertyAccessExpression(expr.left) ? nsWritableTarget(lowerer, expr.left) : null);
      if (target) {
        const value = lowerCompoundValueToTarget(lowerer, expr, indexedCompound, target);
        return { kind: "assignExpr", localId: target.id, value, type: target.type, loc };
      }
      return lowerFieldCompoundValue(lowerer, expr.left, indexedCompound, expr.right, loc);
    }
    // `events.defaultMaxListeners = v` — the module-property write
    // Node validates (validateNumber(n, 'defaultMaxListeners', 0)):
    // the value crosses into the checked-dynamic tree and the runtime ladder throws
    // ERR_INVALID_ARG_TYPE / ERR_OUT_OF_RANGE with Node's exact slot
    // name; valid numbers apply. The expression's value is the RHS
    // (JS's assignment yield).
    if (
      op === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(expr.left) &&
      !expr.left.questionDotToken &&
      expr.left.name.text === "defaultMaxListeners"
    ) {
      const bi = lowerer.builtinMemberOf(expr.left);
      if (bi && bi.module === "events" && bi.member === "defaultMaxListeners") {
        const rhs = lowerer.lowerExpr(expr.right);
        if (rhs.type.kind === "dyn" || rhs.kind === "unitLit" || lowerer.dynConvertible(rhs.type)) {
          const valTmp = lowerer.declareHiddenLocal("%setVal", rhs.type);
          const valRef = (): IrExpr => ({
            kind: "varRef",
            localId: valTmp.id,
            type: rhs.type,
            loc,
          });
          const dynVal: IrExpr =
            rhs.type.kind === "dyn"
              ? valRef()
              : { kind: "dynFrom", value: valRef(), type: DYN, loc };
          return {
            kind: "seqExpr",
            stmts: [
              { kind: "varDecl", localId: valTmp.id, init: rhs, loc },
              {
                kind: "exprStmt",
                expr: {
                  kind: "libCall",
                  fn: "emitter.setDefaultMaxChk",
                  args: [
                    dynVal,
                    { kind: "strLit", value: "defaultMaxListeners", type: STRING, loc },
                  ],
                  type: VOID,
                  loc,
                },
                loc,
              },
            ],
            result: valRef(),
            type: rhs.type,
            loc,
          };
        }
      }
    }
    // Member targets whose storage IS a module global — namespace
    // members (`N.x`) and expando function members (`Foo.baz`): the
    // same assignExpr, since the "member" is a variable.
    if (
      op === ts.SyntaxKind.EqualsToken &&
      (ts.isPropertyAccessExpression(expr.left) || ts.isElementAccessExpression(expr.left)) &&
      !(ts.isPropertyAccessExpression(expr.left) && expr.left.questionDotToken)
    ) {
      const target =
        expandoWritableTarget(lowerer, expr.left) ??
        (ts.isPropertyAccessExpression(expr.left) ? nsWritableTarget(lowerer, expr.left) : null);
      if (target) {
        const value = lowerer.lowerExprExpecting(expr.right, target.type);
        return { kind: "assignExpr", localId: target.id, value, type: target.type, loc };
      }
      // Bundled numeric enums use e[e["name"] = value] = "name".
      // Capture the receiver and key before the RHS. PutValue coerces the
      // key afterward, then yields the RHS without rereading the property.
      if (ts.isElementAccessExpression(expr.left) && !expr.left.questionDotToken) {
        const recv = tryLowerExpression(lowerer, expr.left.expression);
        if (
          recv &&
          (recv.type.kind === "dyn" ||
            (recv.type.kind === "array" &&
              isJsSourceFile(ts.getSourceFileOfNode(expr)) &&
              lowerer.dynConvertible(recv.type)))
        ) {
          return lowerDynMemberAssignment(
            lowerer,
            expr,
            lowerer.coerceInto(expr.left.expression, recv, DYN),
          );
        }
        if (recv?.type.kind === "array" || recv?.type.kind === "bytes") {
          const receiver = lowerer.declareHiddenLocal("%setArray", recv.type);
          // An undefined index names the "undefined" property
          // (undefined-index.ts), which a typed array cannot hold.
          const rawIndex = lowerer.lowerExpr(expr.left.argumentExpression);
          const split =
            recv.type.kind === "bytes"
              ? splitUndefinedIndex(
                  lowerer,
                  rawIndex,
                  expr.left.argumentExpression,
                  locOf(expr.left.argumentExpression),
                )
              : null;
          const index =
            split?.index ??
            lowerOptionalIndex(
              lowerer,
              rawIndex,
              locOf(expr.left.argumentExpression),
              expr.left.argumentExpression,
            );
          if (index.type.kind !== "f64")
            lowerer.unsupported(
              "SC1090",
              expr.left.argumentExpression,
              "indexing with non-number keys",
            );
          const key = lowerer.declareHiddenLocal("%setIndex", F64);
          const raw = lowerer.lowerExpr(expr.right);
          const value = lowerer.declareHiddenLocal("%setValue", raw.type);
          const result = varRef(value.id, raw.type, loc);
          const arr = varRef(receiver.id, recv.type, loc);
          const idx = varRef(key.id, F64, loc);
          const store: IrStmt =
            recv.type.kind === "array"
              ? arrayValueStore(lowerer, arr, idx, result, recv.type.elem, loc)
              : {
                  kind: "bytesSet",
                  arr,
                  index: idx,
                  value: lowerer.coerceInto(expr.right, result, F64),
                  loc,
                };
          const write: IrStmt = split
            ? {
                kind: "if",
                cond: split.isUndefined,
                then: [undefinedTypedArrayKeyFence(lowerer, expr.left, loc)],
                else_: [store],
                loc,
              }
            : store;
          return {
            kind: "seqExpr",
            stmts: [
              { kind: "varDecl", localId: receiver.id, init: recv, loc },
              ...(split?.stmts ?? []),
              { kind: "varDecl", localId: key.id, init: index, loc },
              { kind: "varDecl", localId: value.id, init: raw, loc },
              write,
            ],
            result,
            type: result.type,
            loc,
          };
        }
      }

      // `h.k = v` on a CHECKED-DYNAMIC receiver in VALUE position
      // (`var _ = module.exports = foo`): receiver first, then RHS
      // (JS's reference-before-value order), the keyed write, and the
      // RHS value is the expression's value — its OWN type, so the
      // consumer sees exactly what the checker typed.
      if (ts.isPropertyAccessExpression(expr.left) && !expr.left.questionDotToken) {
        // `const src = exports.src = []`: an export member assigned in
        // value position writes its export global and yields the value.
        {
          let inFunction = false;
          for (let p: ts.Node | undefined = expr.parent; p !== undefined; p = p.parent) {
            if (ts.isFunctionLike(p) || ts.isClassDeclaration(p) || ts.isClassExpression(p)) {
              inFunction = true;
              break;
            }
          }
          const g = inFunction
            ? cjsExportMemberWriteGlobalOf(lowerer, expr.left)
            : cjsInFileExportGlobalOf(lowerer, expr.left);
          if (g) {
            const value = lowerer.lowerExprExpecting(expr.right, g.type);
            const tmp = lowerer.declareHiddenLocal("%exportValue", value.type);
            const result = varRef(tmp.id, value.type, loc);
            return {
              kind: "seqExpr",
              stmts: [
                { kind: "varDecl", localId: tmp.id, init: value, loc },
                { kind: "assign", localId: g.id, value: result, loc },
              ],
              result,
              type: value.type,
              loc,
            };
          }
        }
        const recv = tryLowerExpression(lowerer, expr.left.expression);
        if (recv && recv.type.kind === "dyn") return lowerDynMemberAssignment(lowerer, expr, recv);
        const unionWrite = lowerUnionFieldWrite(lowerer, expr.left, expr.right);
        if (unionWrite) return unionWrite;
        const field = lowerer.fieldTarget(expr.left);
        if (field) {
          const recvTmp = lowerer.declareHiddenLocal("%setReceiver", field.obj.type);
          const receiver = field.obj;
          field.obj = varRef(recvTmp.id, receiver.type, loc);
          const value = lowerer.lowerExprExpecting(expr.right, field.fieldType);
          const valTmp = lowerer.declareHiddenLocal("%setValue", value.type);
          const result = varRef(valTmp.id, value.type, loc);
          return {
            kind: "seqExpr",
            stmts: [
              { kind: "varDecl", localId: recvTmp.id, init: receiver, loc },
              { kind: "varDecl", localId: valTmp.id, init: value, loc },
              lowerer.fieldSetStmt(field, result, loc, expr.left),
            ],
            result,
            type: result.type,
            loc,
          };
        }
      }
    }
    // Destructuring assignment in VALUE position (`(() => [i] = [i+1])()`,
    // `({} = {x} = a)`, `var d = ([] = src)`): the statement machinery's
    // parts under a seqExpr — the expression's value is the RHS value
    // (JS's GetValue of the right reference), which is exactly the
    // parts' hidden temp.
    if (
      op === ts.SyntaxKind.EqualsToken &&
      (ts.isObjectLiteralExpression(expr.left) || ts.isArrayLiteralExpression(expr.left))
    ) {
      const parts = lowerer.lowerDestructuringAssignParts(expr.left, expr.right, loc);
      return {
        kind: "seqExpr",
        stmts: parts.stmts,
        result: parts.value,
        type: parts.value.type,
        loc,
      };
    }
    // `a[k] = b[k] = v` in a JavaScript file: a member write in value
    // position lowers as its statement form and yields the value. The
    // receiver, the key and the value are evaluated in that order into
    // temporaries first. A receiver held in a temporary must be a
    // checked-dynamic value, which the temporary shares; any other receiver
    // must be a variable or `this`.
    if (
      op === ts.SyntaxKind.EqualsToken &&
      isJsSourceFile(ts.getSourceFileOfNode(expr)) &&
      (ts.isPropertyAccessExpression(expr.left) || ts.isElementAccessExpression(expr.left)) &&
      !expr.left.questionDotToken
    ) {
      const target = expr.left;
      const receiverNode = target.expression;
      const bareReceiver =
        ts.isIdentifier(receiverNode) || receiverNode.kind === ts.SyntaxKind.ThisKeyword;
      if (bareReceiver || tryLowerExpression(lowerer, receiverNode)?.type.kind === "dyn") {
        const stmts: IrStmt[] = [];
        const overrides: { node: ts.Expression; value: IrExpr }[] = [];
        const hold = (node: ts.Expression, name: string): IrExpr => {
          const value = lowerer.lowerExpr(node);
          const local = lowerer.declareHiddenLocal(name, value.type);
          stmts.push({ kind: "varDecl", localId: local.id, init: value, loc: value.loc });
          const held = varRef(local.id, value.type, value.loc);
          overrides.push({ node, value: held });
          return held;
        };
        if (!bareReceiver) hold(receiverNode, "%assignReceiver");
        if (
          ts.isElementAccessExpression(target) &&
          !ts.isIdentifier(target.argumentExpression) &&
          !ts.isStringLiteral(target.argumentExpression) &&
          !ts.isNumericLiteral(target.argumentExpression)
        )
          hold(target.argumentExpression, "%assignKey");
        const result = hold(expr.right, "%assignValue");
        stmts.push(
          lowerer.withExpressionOverrides(overrides, () => lowerer.lowerExprStatement(expr)),
        );
        return { kind: "seqExpr", stmts, result, type: result.type, loc };
      }
    }
    lowerer.unsupported(
      "SC1090",
      expr,
      op === ts.SyntaxKind.EqualsToken
        ? "assignment to non-variables as an expression (only `x = e` over a variable yields a value; write property/destructuring assignments as statements)"
        : "compound assignment as an expression (write `x op= e` as a statement, or spell out `x = x op e`)",
    );
  }
  if (op === ts.SyntaxKind.EqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken) {
    const nullTest = lowerLooseNullCompare(lowerer, expr, loc);
    if (nullTest) return nullTest;
    const loose = lowerAbstractEquality(
      lowerer,
      deferredSlotOr(lowerer, lowerer.lowerExpr(expr.left)),
      deferredSlotOr(lowerer, lowerer.lowerExpr(expr.right)),
      op === ts.SyntaxKind.ExclamationEqualsToken,
      loc,
    );
    if (loose) return loose;
    lowerer.unsupported(
      "SC1040",
      expr,
      undefined,
      "object-to-primitive loose equality can call user-defined valueOf/toString methods — compare explicit primitive conversions instead",
    );
  }
  if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken) {
    return lowerLogicalChain(lowerer, expr);
  }
  if (op === ts.SyntaxKind.QuestionQuestionToken) {
    return lowerer.lowerNullishCoalesce(expr, loc);
  }
  if (op === ts.SyntaxKind.CommaToken) {
    // Comma expression in VALUE position (`r = ({} = a, [] = a)` — the
    // conformance corpus's paired-destructuring idiom): the left operand
    // runs for EFFECT exactly as its statement lowering (JS discards its
    // value), the right operand is the expression's value — a seqExpr.
    // The validator restricts seqExpr statements to straight-line writes
    // (the lowering point is mid-expression), so a left operand whose
    // statement lowering needs real control flow keeps a pointed fence
    // instead of tripping the validator downstream.
    const effect = lowerer.lowerExprStatement(expr.left);
    if (!seqExprSafeStmt(effect)) {
      lowerer.unsupported(
        "SC1090",
        expr.left,
        "comma expressions whose left operand needs control flow (run it as its own statement first)",
      );
    }
    const result = lowerer.lowerExpr(expr.right);
    return { kind: "seqExpr", stmts: [effect], result, type: result.type, loc };
  }
  if (op === ts.SyntaxKind.InstanceOfKeyword) return lowerer.lowerInstanceOf(expr, loc);
  if (op === ts.SyntaxKind.InKeyword) {
    return lowerInExpression(lowerer, expr, loc);
  }
  // `typeof e === "string"` on a catch binding or an `unknown` value: a
  // runtime kind test — intercepted BEFORE the operands lower (a raw
  // read of the binding is the narrowness fence, and bare `typeof e`
  // has no lowering).
  if (
    op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
    op === ts.SyntaxKind.ExclamationEqualsEqualsToken
  ) {
    const test =
      lowerConstructorGlobalTypeofTest(lowerer, expr, loc) ??
      lowerWebAssemblyTypeofTest(lowerer, expr, loc) ??
      lowerErrorCodeTypeofTest(lowerer, expr, loc) ??
      lowerer.lowerCaughtTypeofTest(expr, loc) ??
      lowerDynTypeofTest(lowerer, expr, loc) ??
      lowerUnionTypeofTest(lowerer, expr, loc);
    if (test) return test;
  }
  // `x.constructor === Readable` for an instance of EventEmitter or a
  // stream class: the instance's own class, compared without a class value.
  if (
    op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
    op === ts.SyntaxKind.ExclamationEqualsEqualsToken
  ) {
    for (const [side, other] of [
      [expr.left, expr.right],
      [expr.right, expr.left],
    ] as const) {
      const ctor = runtimeConstructorReceiver(lowerer, side);
      const target = ctor ? builtinClassRefOf(lowerer, other) : null;
      if (ctor && (target?.kind === "emitter" || target?.kind === "stream")) {
        const negated = op === ts.SyntaxKind.ExclamationEqualsEqualsToken;
        return lowerRuntimeConstructorIs(lowerer, ctor.receiver, target.info, negated, loc);
      }
    }
  }
  // `C === EventEmitter` between two builtin class references: the
  // classes are compile-time values, so the answer folds.
  if (
    op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
    op === ts.SyntaxKind.ExclamationEqualsEqualsToken
  ) {
    const leftClass = builtinClassRefOf(lowerer, expr.left);
    const rightClass = leftClass === null ? null : builtinClassRefOf(lowerer, expr.right);
    if (leftClass !== null && rightClass !== null) {
      const negated = op === ts.SyntaxKind.ExclamationEqualsEqualsToken;
      const same = sameBuiltinClass(leftClass, rightClass);
      return { kind: "boolLit", value: same !== negated, type: BOOL, loc };
    }
  }

  const strictEquality =
    op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
    op === ts.SyntaxKind.ExclamationEqualsEqualsToken;
  // An identifier whose storage is runtime-optional is compared by its
  // stored value: the checker's narrowing to the present arm is not a
  // runtime proof. Identifier reads are pure, so taking the stored value
  // after both operands lowered keeps the evaluation order. A union on
  // the other side keeps the narrowed read (union-to-union comparison
  // has no lowering).
  let left = strictEquality
    ? (lowerAbsenceProbe(lowerer, expr.left) ?? lowerer.lowerExpr(expr.left))
    : lowerer.lowerExpr(expr.left);
  let right = strictEquality
    ? (lowerAbsenceProbe(lowerer, expr.right) ?? lowerer.lowerExpr(expr.right))
    : lowerer.lowerExpr(expr.right);
  if (strictEquality) {
    const storedLeft = runtimeOptionalStorageOperand(lowerer, expr.left);
    const storedRight = runtimeOptionalStorageOperand(lowerer, expr.right);
    if (storedLeft !== null && right.type.kind !== "union") left = storedLeft;
    if (storedRight !== null && left.type.kind !== "union") right = storedRight;
    // A typed-array read compared with a plain number needs no
    // `number | undefined` box.
    const fusedLeft = tryLowerBytesReadNumberEquality(lowerer, left, right, expr.right);
    if (fusedLeft) left = fusedLeft;
    else {
      const fusedRight = tryLowerBytesReadNumberEquality(lowerer, right, left, expr.left);
      if (fusedRight) right = fusedRight;
    }
  }
  if (strictEquality && (left.type.kind === "caught" || right.type.kind === "caught")) {
    if (left.type.kind === "caught")
      left = { kind: "caughtToDyn", value: left, type: DYN, loc: left.loc };
    if (right.type.kind === "caught")
      right = { kind: "caughtToDyn", value: right, type: DYN, loc: right.loc };
  }
  if (left.type.kind === "dyn" || right.type.kind === "dyn") {
    // The narrowing unit comparisons ARE answerable on unknown: `v ===
    // undefined` / `v !== null` test the dyn node's kind directly, and
    // tsc's control flow narrows the branches (reads then bridge through
    // maybeNarrow's validated extraction).
    if (
      op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
      op === ts.SyntaxKind.ExclamationEqualsEqualsToken
    ) {
      const negated = op === ts.SyntaxKind.ExclamationEqualsEqualsToken;
      const unit = left.kind === "unitLit" ? left : right.kind === "unitLit" ? right : null;
      const other = left.kind === "unitLit" ? right : left;
      if (unit && other.type.kind === "dyn") {
        return {
          kind: "dynTest",
          test: unit.unit,
          ...(negated ? { negated: true as const } : {}),
          value: other,
          type: BOOL,
          loc,
        };
      }
      // dyn vs SCALAR strict equality (`value !== ""`, `u === 5` — the
      // normalizePricing filter): a guarded kind test + payload compare,
      // JS-exact (strict equality never coerces; a non-matching dyn kind
      // answers false). dyn vs dyn keeps the fence below.
      const dynSide = left.type.kind === "dyn" ? left : right;
      const scalarSide = dynSide === left ? right : left;
      const reference = scalarSide.type;
      if (
        (reference.kind === "object" ||
          reference.kind === "record" ||
          reference.kind === "array" ||
          reference.kind === "bytes" ||
          reference.kind === "func" ||
          reference.kind === "classval" ||
          reference.kind === "regex" ||
          reference.kind === "url" ||
          reference.kind === "bigint" ||
          reference.kind === "symbol" ||
          reference.kind === "map" ||
          reference.kind === "set" ||
          reference.kind === "union" ||
          // A promise of dyn boxes its own promise, so identity holds;
          // other promise types box a fresh adapter.
          (reference.kind === "promise" && reference.inner.kind === "dyn") ||
          DYN_HANDLE_KINDS.has(reference.kind)) &&
        lowerer.dynConvertible(reference)
      ) {
        // Records, arrays and byte views compare by the capsule identity
        // their dyn reads produce, including when they arrive through a
        // union (an optional array field read from a typed record).
        const liveArm = (type: IrType): boolean => {
          if (type.kind === "array" || type.kind === "bytes") return true;
          const shape = type.kind === "record" ? lowerer.shapes.get(type.shapeId) : undefined;
          return !!shape && (shape.fields.length > 0 || shape.indexValue !== undefined);
        };
        const boxed: IrExpr = {
          kind: "dynFrom",
          value: scalarSide,
          type: DYN,
          loc: scalarSide.loc,
          ...(reference.kind === "record" ||
          liveArm(reference) ||
          (reference.kind === "union" &&
            (lowerer.unions.get(reference.unionId)?.arms.some(liveArm) ?? false))
            ? { liveRef: true as const }
            : {}),
        };
        return {
          kind: "dynScalarEq",
          left: scalarSide === left ? boxed : left,
          right: scalarSide === right ? boxed : right,
          ...(negated ? { negated: true as const } : {}),
          type: BOOL,
          loc,
        };
      }
      // EventEmitter or a stream class against an untyped value in
      // JavaScript: the untyped value can hold the class's untyped
      // constructor (coerceToExpected), which compares by identity.
      if (
        dynSide.type.kind === "dyn" &&
        isJsSourceFile(expr.getSourceFile()) &&
        ((scalarSide.type.kind === "moduleNs" && scalarSide.type.moduleId === "builtin:events") ||
          (scalarSide.kind === "classRef" && builtinClassKind(scalarSide.className) !== null))
      ) {
        const boxed = lowerer.coerceToExpected(scalarSide, DYN);
        return {
          kind: "dynScalarEq",
          left: scalarSide === left ? boxed : left,
          right: scalarSide === right ? boxed : right,
          ...(negated ? { negated: true as const } : {}),
          type: BOOL,
          loc,
        };
      }
      // A Date against an untyped value: the same Date object, whose
      // checked-dynamic handle the untyped value would hold.
      if (dynSide.type.kind === "dyn" && scalarSide.type.kind === "date") {
        const boxed = lowerer.coerceToExpected(scalarSide, DYN);
        return {
          kind: "dynScalarEq",
          left: scalarSide === left ? boxed : left,
          right: scalarSide === right ? boxed : right,
          ...(negated ? { negated: true as const } : {}),
          type: BOOL,
          loc,
        };
      }
      if (
        dynSide.type.kind === "dyn" &&
        (scalarSide.type.kind === "f64" ||
          scalarSide.type.kind === "string" ||
          scalarSide.type.kind === "bool" ||
          // dyn vs dyn (`context.actual !== context.exact` —
          // test/common's exit accounting): the runtime's whole-dyn
          // strict equality — scalars by value, units by kind,
          // reference kinds by identity (scr_dyn_strict_eq).
          scalarSide.type.kind === "dyn")
      ) {
        return {
          kind: "dynScalarEq",
          left,
          right,
          ...(negated ? { negated: true as const } : {}),
          type: BOOL,
          loc,
        };
      }
    }
    const bitwise: Partial<Record<ts.SyntaxKind, string>> = {
      [ts.SyntaxKind.AmpersandToken]: "&",
      [ts.SyntaxKind.BarToken]: "|",
      [ts.SyntaxKind.CaretToken]: "^",
      [ts.SyntaxKind.LessThanLessThanToken]: "<<",
      [ts.SyntaxKind.GreaterThanGreaterThanToken]: ">>",
      [ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken]: ">>>",
    };
    if (bitwise[op]) {
      const l = lowerer.coerceToExpected(left, DYN);
      const r = lowerer.coerceToExpected(right, DYN);
      if (l.type.kind === "dyn" && r.type.kind === "dyn") {
        const value: IrExpr = {
          kind: "libCall",
          fn: "dyn.bitwise",
          args: [l, r, { kind: "strLit", value: bitwise[op]!, type: STRING, loc }],
          type: DYN,
          loc,
        };
        return left.type.kind === "f64" || right.type.kind === "f64"
          ? { kind: "dynCheck", value, type: F64, loc }
          : value;
      }
    }
    // Numeric operators dispatch on ToNumeric's actual Number/BigInt
    // result, including values flowing through native callable properties.
    if (
      isJsSourceFile(ts.getSourceFileOfNode(expr)) ||
      op === ts.SyntaxKind.PlusToken ||
      [
        ts.SyntaxKind.LessThanToken,
        ts.SyntaxKind.LessThanEqualsToken,
        ts.SyntaxKind.GreaterThanToken,
        ts.SyntaxKind.GreaterThanEqualsToken,
      ].includes(op) ||
      [
        ts.SyntaxKind.MinusToken,
        ts.SyntaxKind.AsteriskToken,
        ts.SyntaxKind.SlashToken,
        ts.SyntaxKind.PercentToken,
        ts.SyntaxKind.AsteriskAsteriskToken,
      ].includes(op)
    ) {
      const other = left.type.kind === "dyn" ? right : left;
      const NUM_BIN: Partial<Record<ts.SyntaxKind, "-" | "*" | "/" | "%" | "**">> = {
        [ts.SyntaxKind.MinusToken]: "-",
        [ts.SyntaxKind.AsteriskToken]: "*",
        [ts.SyntaxKind.SlashToken]: "/",
        [ts.SyntaxKind.PercentToken]: "%",
        [ts.SyntaxKind.AsteriskAsteriskToken]: "**",
      };
      const NUM_CMP: Partial<Record<ts.SyntaxKind, "<" | "<=" | ">" | ">=">> = {
        [ts.SyntaxKind.LessThanToken]: "<",
        [ts.SyntaxKind.LessThanEqualsToken]: "<=",
        [ts.SyntaxKind.GreaterThanToken]: ">",
        [ts.SyntaxKind.GreaterThanEqualsToken]: ">=",
      };
      const arith = NUM_BIN[op];
      const cmp = NUM_CMP[op];
      if (arith) {
        const l = lowerer.coerceToExpected(left, DYN);
        const r = lowerer.coerceToExpected(right, DYN);
        if (l.type.kind === "dyn" && r.type.kind === "dyn") {
          const value: IrExpr = {
            kind: "libCall",
            fn: "dyn.arithmetic",
            args: [l, r, { kind: "strLit", value: arith, type: STRING, loc }],
            type: DYN,
            loc,
          };
          const numeric =
            left.type.kind === "bigint" || right.type.kind === "bigint"
              ? BIGINT_T
              : left.type.kind === "f64" || right.type.kind === "f64"
                ? F64
                : null;
          return numeric ? { kind: "dynCheck", value, type: numeric, loc } : value;
        }
      }
      if (cmp && lowerer.dynConvertible(left.type) && lowerer.dynConvertible(right.type)) {
        return {
          kind: "libCall",
          fn: "dyn.compare",
          args: [
            lowerer.coerceToExpected(left, DYN),
            lowerer.coerceToExpected(right, DYN),
            { kind: "strLit", value: cmp, type: STRING, loc },
          ],
          type: BOOL,
          loc,
        };
      }
      // Untyped addition chooses concatenation or numeric addition only
      // after both operands have undergone ToPrimitive at runtime.
      if (op === ts.SyntaxKind.PlusToken) {
        const l = lowerer.coerceToExpected(left, DYN);
        const r = lowerer.coerceToExpected(right, DYN);
        if (l.type.kind === "dyn" && r.type.kind === "dyn") {
          const value: IrExpr = { kind: "libCall", fn: "dyn.add", args: [l, r], type: DYN, loc };
          // A statically known string operand guarantees a string result.
          return other.type.kind === "string"
            ? { kind: "dynCheck", value, type: STRING, loc }
            : value;
        }
      }
    }
    // Unsupported `any`-origin operations get their specific diagnostic;
    // unknown retains the narrowing diagnostic below.
    if (
      (left.type.kind === "dyn" && lowerer.anyOrigin(expr.left)) ||
      (right.type.kind === "dyn" && lowerer.anyOrigin(expr.right))
    ) {
      // `JSON.parse` and other checked-dynamic producers deliberately
      // remain dyn when assigned to an `any` local: eagerly converting
      // the binding would deep-copy its data and sever aliases. At an
      // unsupported operator, require an explicit represented type.
      lowerer.anyOpFence(`the '${ts.tokenToString(op) ?? ts.syntaxKindName(op)}' operator`, expr);
    }
    // tsc allows ===/!== on unknown (arithmetic/comparisons it rejects
    // itself); a dynamic equality would need a dyn walk — validate first.
    lowerer.unsupported("SC1100", expr, "operators on 'unknown' values");
  }

  if (left.type.kind === "bigint" && right.type.kind === "bigint") {
    const binary: Partial<
      Record<
        ts.SyntaxKind,
        | "bigint.add"
        | "bigint.sub"
        | "bigint.mul"
        | "bigint.div"
        | "bigint.mod"
        | "bigint.pow"
        | "bigint.and"
        | "bigint.or"
        | "bigint.xor"
        | "bigint.shl"
        | "bigint.shr"
      >
    > = {
      [ts.SyntaxKind.PlusToken]: "bigint.add",
      [ts.SyntaxKind.MinusToken]: "bigint.sub",
      [ts.SyntaxKind.AsteriskToken]: "bigint.mul",
      [ts.SyntaxKind.SlashToken]: "bigint.div",
      [ts.SyntaxKind.PercentToken]: "bigint.mod",
      [ts.SyntaxKind.AsteriskAsteriskToken]: "bigint.pow",
      [ts.SyntaxKind.AmpersandToken]: "bigint.and",
      [ts.SyntaxKind.BarToken]: "bigint.or",
      [ts.SyntaxKind.CaretToken]: "bigint.xor",
      [ts.SyntaxKind.LessThanLessThanToken]: "bigint.shl",
      [ts.SyntaxKind.GreaterThanGreaterThanToken]: "bigint.shr",
    };
    const fn = binary[op];
    if (fn) return { kind: "libCall", fn, args: [left, right], type: BIGINT_T, loc };
    if (
      op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
      op === ts.SyntaxKind.ExclamationEqualsEqualsToken
    ) {
      const equal: IrExpr = {
        kind: "libCall",
        fn: "bigint.eq",
        args: [left, right],
        type: BOOL,
        loc,
      };
      return op === ts.SyntaxKind.ExclamationEqualsEqualsToken
        ? { kind: "unary", op: "!", operand: equal, type: BOOL, loc }
        : equal;
    }
    if (
      op === ts.SyntaxKind.LessThanToken ||
      op === ts.SyntaxKind.LessThanEqualsToken ||
      op === ts.SyntaxKind.GreaterThanToken ||
      op === ts.SyntaxKind.GreaterThanEqualsToken
    ) {
      const cmp: IrExpr = {
        kind: "libCall",
        fn: "bigint.cmp",
        args: [left, right],
        type: F64,
        loc,
      };
      const zero: IrExpr = { kind: "numLit", value: 0, type: F64, loc };
      const cmpOp =
        op === ts.SyntaxKind.LessThanToken
          ? "<"
          : op === ts.SyntaxKind.LessThanEqualsToken
            ? "<="
            : op === ts.SyntaxKind.GreaterThanToken
              ? ">"
              : ">=";
      return { kind: "bin", op: cmpOp, left: cmp, right: zero, type: BOOL, loc };
    }
  }
  if (
    (left.type.kind === "bigint" && right.type.kind === "f64") ||
    (left.type.kind === "f64" && right.type.kind === "bigint")
  ) {
    if (
      op === ts.SyntaxKind.LessThanToken ||
      op === ts.SyntaxKind.LessThanEqualsToken ||
      op === ts.SyntaxKind.GreaterThanToken ||
      op === ts.SyntaxKind.GreaterThanEqualsToken
    ) {
      const big = left.type.kind === "bigint" ? left : right;
      const num = left.type.kind === "f64" ? left : right;
      const cmp: IrExpr = {
        kind: "libCall",
        fn: "bigint.cmpNumber",
        args: [big, num],
        type: F64,
        loc,
      };
      const cmpLocal = lowerer.declareHiddenLocal("%bigcmp", F64);
      const cmpRef: IrExpr = { kind: "varRef", localId: cmpLocal.id, type: F64, loc };
      const unordered: IrExpr = {
        kind: "bin",
        op: "===",
        left: cmpRef,
        right: { kind: "numLit", value: 2, type: F64, loc },
        type: BOOL,
        loc,
      };
      const zero: IrExpr = { kind: "numLit", value: 0, type: F64, loc };
      const leftBig = left.type.kind === "bigint";
      const cmpOp = leftBig
        ? op === ts.SyntaxKind.LessThanToken
          ? "<"
          : op === ts.SyntaxKind.LessThanEqualsToken
            ? "<="
            : op === ts.SyntaxKind.GreaterThanToken
              ? ">"
              : ">="
        : op === ts.SyntaxKind.LessThanToken
          ? ">"
          : op === ts.SyntaxKind.LessThanEqualsToken
            ? ">="
            : op === ts.SyntaxKind.GreaterThanToken
              ? "<"
              : "<=";
      const result: IrExpr = {
        kind: "logical",
        op: "&&",
        left: { kind: "unary", op: "!", operand: unordered, type: BOOL, loc },
        right: { kind: "bin", op: cmpOp, left: cmpRef, right: zero, type: BOOL, loc },
        type: BOOL,
        loc,
      };
      return {
        kind: "seqExpr",
        stmts: [{ kind: "varDecl", localId: cmpLocal.id, init: cmp, loc }],
        result,
        type: BOOL,
        loc,
      };
    }
  }
  // An unchecked array read keeps its undefined arm in the IR even when
  // the checker typed the binding as `string`. An optional string is not
  // itself a string operand for `+`: `undefined + 1` and
  // `undefined + undefined` are NaN, while a present string concatenates.
  // Keep this predicate exact so a nullable string does not take the
  // string path either.
  const optionalStringType = (type: IrType): boolean => {
    if (type.kind !== "union") return false;
    const arms = lowerer.unions.get(type.unionId)?.arms;
    return (
      !!arms &&
      arms.length === 2 &&
      arms.some((arm) => arm.kind === "string") &&
      arms.some((arm) => arm.kind === "undefinedT")
    );
  };
  const arithmeticNumber = (operand: IrExpr, node: ts.Expression): IrExpr =>
    lowerOptionalNumber(lowerer, operand, loc, node);
  const arithmeticLeft = strictEquality ? left : arithmeticNumber(left, expr.left);
  const arithmeticRight = strictEquality ? right : arithmeticNumber(right, expr.right);
  const bothNum = arithmeticLeft.type.kind === "f64" && arithmeticRight.type.kind === "f64";
  const bothStr = left.type.kind === "string" && right.type.kind === "string";

  const lowerOptionalStringPlus = (): IrExpr | null => {
    const leftOptional = optionalStringType(left.type);
    const rightOptional = optionalStringType(right.type);
    if (!leftOptional && !rightOptional) return null;
    const allowed = (type: IrType): boolean =>
      type.kind === "f64" || type.kind === "string" || optionalStringType(type);
    if (!allowed(left.type) || !allowed(right.type)) return null;

    // The tag tests and the chosen concatenation branch must see the same
    // operand values. This matters for `take()[0] + 1` and for two reads
    // with observable getters/calls.
    const prefix: IrStmt[] = [];
    const stable = (operand: IrExpr): IrExpr => {
      if (isSafeToRepeat(operand) || isSafeToDiscard(operand)) return operand;
      const tmp = lowerer.declareHiddenLocal("%plus", operand.type);
      prefix.push({ kind: "varDecl", localId: tmp.id, init: operand, loc });
      return varRef(tmp.id, operand.type, loc);
    };
    const stableLeft = stable(left);
    const stableRight = stable(right);
    const leftString = lowerer.ensureString(stableLeft, expr.left);
    const rightString = lowerer.ensureString(stableRight, expr.right);
    const concat: IrExpr = {
      kind: "strConcat",
      left: leftString,
      right: rightString,
      type: STRING,
      loc,
    };
    const nan: IrExpr = {
      kind: "bin",
      op: "/",
      left: numLit(0, loc),
      right: numLit(0, loc),
      type: F64,
      loc,
    };
    const resultT: IrType = { kind: "union", unionId: lowerer.unions.intern([F64, STRING]) };
    lowerer.runtimeOptionalArithmeticTypes.set(expr, resultT);
    const numberTag = lowerer.armTag(resultT.unionId, F64);
    const stringTag = lowerer.armTag(resultT.unionId, STRING);
    if (numberTag < 0 || stringTag < 0)
      throw new InternalCompilerError("lowerer bug: optional string plus result union");
    const number = (): IrExpr => ({
      kind: "unionWrap",
      unionId: resultT.unionId,
      tag: numberTag,
      value: nan,
      type: resultT,
      loc,
    });
    const string = (): IrExpr => ({
      kind: "unionWrap",
      unionId: resultT.unionId,
      tag: stringTag,
      value: concat,
      type: resultT,
      loc,
    });
    const undefinedTest = (operand: IrExpr): IrExpr => ({
      kind: "unionIsTag",
      unionId: operand.type.kind === "union" ? operand.type.unionId : "",
      tag: operand.type.kind === "union" ? lowerer.armTag(operand.type.unionId, UNDEFINED_T) : -1,
      negated: false,
      value: operand,
      type: BOOL,
      loc,
    });
    let result: IrExpr;
    if (leftOptional && rightOptional) {
      const rightMissing = undefinedTest(stableRight);
      const bothMissing: IrExpr = {
        kind: "ternary",
        cond: rightMissing,
        then: number(),
        else_: string(),
        type: resultT,
        loc,
      };
      result = {
        kind: "ternary",
        cond: undefinedTest(stableLeft),
        then: bothMissing,
        else_: string(),
        type: resultT,
        loc,
      };
    } else if (leftOptional) {
      result = {
        kind: "ternary",
        cond: undefinedTest(stableLeft),
        then: number(),
        else_: string(),
        type: resultT,
        loc,
      };
    } else {
      result = {
        kind: "ternary",
        cond: undefinedTest(stableRight),
        then: number(),
        else_: string(),
        type: resultT,
        loc,
      };
    }
    return prefix.length === 0
      ? result
      : { kind: "seqExpr", stmts: prefix, result, type: resultT, loc };
  };

  switch (op) {
    case ts.SyntaxKind.PlusToken:
      if (bothNum)
        return {
          kind: "bin",
          op: "+",
          left: arithmeticLeft,
          right: arithmeticRight,
          type: F64,
          loc,
        };
      if (left.type.kind === "string" || right.type.kind === "string") {
        // A Date on the left converts after the right operand is
        // evaluated, which can run its setters.
        if (left.type.kind === "date" && !isSafeToRepeat(right)) {
          const date = lowerer.declareHiddenLocal("%plus", left.type);
          const other = lowerer.declareHiddenLocal("%plus", right.type);
          return {
            kind: "seqExpr",
            stmts: [
              { kind: "varDecl", localId: date.id, init: left, loc },
              { kind: "varDecl", localId: other.id, init: right, loc },
            ],
            result: {
              kind: "strConcat",
              left: concatOperand(lowerer, varRef(date.id, left.type, loc), expr.left),
              right: concatOperand(lowerer, varRef(other.id, right.type, loc), expr.right),
              type: STRING,
              loc,
            },
            type: STRING,
            loc,
          };
        }
        return {
          kind: "strConcat",
          left: concatOperand(lowerer, left, expr.left),
          right: concatOperand(lowerer, right, expr.right),
          type: STRING,
          loc,
        };
      }
      const optionalStringPlus = lowerOptionalStringPlus();
      if (optionalStringPlus) return optionalStringPlus;
      {
        const primitive = (type: IrType): boolean =>
          type.kind === "f64" ||
          type.kind === "string" ||
          type.kind === "bool" ||
          isUnitType(type) ||
          (type.kind === "union" &&
            (lowerer.unions.get(type.unionId)?.arms.every(primitive) ?? false));
        if (
          (left.type.kind === "union" || right.type.kind === "union") &&
          primitive(left.type) &&
          primitive(right.type)
        ) {
          lowerer.runtimeOptionalArithmeticTypes.set(expr, DYN);
          return {
            kind: "libCall",
            fn: "dyn.add",
            args: [lowerer.coerceToExpected(left, DYN), lowerer.coerceToExpected(right, DYN)],
            type: DYN,
            loc,
          };
        }
      }
      operatorUnsupported(lowerer, expr, "+", [left.type, right.type]);
      break;
    case ts.SyntaxKind.MinusToken:
    case ts.SyntaxKind.AsteriskToken:
    case ts.SyntaxKind.SlashToken:
    case ts.SyntaxKind.PercentToken:
    case ts.SyntaxKind.AsteriskAsteriskToken: {
      if (!bothNum)
        operatorUnsupported(lowerer, expr, ts.tokenToString(op) ?? "?", [left.type, right.type]);
      const binOp =
        op === ts.SyntaxKind.MinusToken
          ? "-"
          : op === ts.SyntaxKind.AsteriskToken
            ? "*"
            : op === ts.SyntaxKind.SlashToken
              ? "/"
              : op === ts.SyntaxKind.PercentToken
                ? "%"
                : "**";
      return {
        kind: "bin",
        op: binOp,
        left: arithmeticLeft,
        right: arithmeticRight,
        type: F64,
        loc,
      };
    }
    // The bitwise six, JS-exact: operands through ToInt32/ToUint32
    // (NaN/±Infinity → 0, truncate, wrap mod 2^32), the operation in
    // 32-bit space (shift counts masked to 5 bits), the result back to
    // f64 — `>>>` as Uint32, the rest as Int32 (runtime scr_bit_*).
    case ts.SyntaxKind.AmpersandToken:
    case ts.SyntaxKind.BarToken:
    case ts.SyntaxKind.CaretToken:
    case ts.SyntaxKind.LessThanLessThanToken:
    case ts.SyntaxKind.GreaterThanGreaterThanToken:
    case ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken: {
      // Booleans take part as ToNumber converts them, true to 1 and false
      // to 0: JavaScript code writes `isFn(a) ^ isFn(b)` and `flags | ok`.
      // A hoisted JavaScript `var` can also hold undefined, and ToInt32
      // maps ToNumber(undefined) (NaN) and ToNumber(null) to 0.
      const optionalBoolTag = (e: IrExpr): number => {
        if (e.type.kind !== "union") return -1;
        const arms = lowerer.unions.get(e.type.unionId)?.arms ?? [];
        const ok = arms.every(
          (a) => a.kind === "bool" || a.kind === "undefinedT" || a.kind === "nullT",
        );
        return ok ? arms.findIndex((a) => a.kind === "bool") : -1;
      };
      const numeric = (e: IrExpr): boolean =>
        e.type.kind === "f64" || e.type.kind === "bool" || optionalBoolTag(e) >= 0;
      const boolBits = !bothNum && numeric(arithmeticLeft) && numeric(arithmeticRight);
      if (!bothNum && !boolBits)
        operatorUnsupported(lowerer, expr, ts.tokenToString(op) ?? "?", [left.type, right.type]);
      const bitPrefix: IrStmt[] = [];
      const oneOrZero = (cond: IrExpr): IrExpr => ({
        kind: "ternary",
        cond,
        then: numLit(1, loc),
        else_: numLit(0, loc),
        type: F64,
        loc,
      });
      // The tag test reads an operand twice: when either side needs it,
      // both sides evaluate once into temporaries, in source order. A left
      // operand that is safe to repeat still takes a temporary when the
      // right one does: the right operand runs first in the prefix, and it
      // can assign what the left operand reads.
      const stash = optionalBoolTag(arithmeticLeft) >= 0 || optionalBoolTag(arithmeticRight) >= 0;
      const rightTemp = stash && !isSafeToRepeat(arithmeticRight);
      const stable = (e: IrExpr, beforeTemp: boolean): IrExpr => {
        if (!stash || (isSafeToRepeat(e) && !beforeTemp)) return e;
        const tmp = lowerer.declareHiddenLocal("%bits", e.type);
        bitPrefix.push({ kind: "varDecl", localId: tmp.id, init: e, loc });
        return varRef(tmp.id, e.type, loc);
      };
      const bitOperand = (operand: IrExpr, beforeTemp: boolean): IrExpr => {
        const e = stable(operand, beforeTemp);
        if (e.type.kind === "bool") return oneOrZero(e);
        const tag = optionalBoolTag(e);
        if (tag < 0 || e.type.kind !== "union") return e;
        const unionId = e.type.unionId;
        return {
          kind: "ternary",
          cond: { kind: "unionIsTag", unionId, tag, negated: false, value: e, type: BOOL, loc },
          then: oneOrZero({ kind: "unionNarrow", unionId, tag, value: e, type: BOOL, loc }),
          else_: numLit(0, loc),
          type: F64,
          loc,
        };
      };
      const bitOp =
        op === ts.SyntaxKind.AmpersandToken
          ? "&"
          : op === ts.SyntaxKind.BarToken
            ? "|"
            : op === ts.SyntaxKind.CaretToken
              ? "^"
              : op === ts.SyntaxKind.LessThanLessThanToken
                ? "<<"
                : op === ts.SyntaxKind.GreaterThanGreaterThanToken
                  ? ">>"
                  : ">>>";
      const bits: IrExpr = {
        kind: "bin",
        op: bitOp,
        left: bitOperand(arithmeticLeft, rightTemp),
        right: bitOperand(arithmeticRight, false),
        type: F64,
        loc,
      };
      return bitPrefix.length === 0
        ? bits
        : { kind: "seqExpr", stmts: bitPrefix, result: bits, type: F64, loc };
    }
    case ts.SyntaxKind.EqualsEqualsEqualsToken:
    case ts.SyntaxKind.ExclamationEqualsEqualsToken:
      return lowerStrictEquality(
        lowerer,
        expr,
        expr.left,
        expr.right,
        left,
        right,
        op === ts.SyntaxKind.ExclamationEqualsEqualsToken,
        loc,
      );
    case ts.SyntaxKind.LessThanToken:
    case ts.SyntaxKind.LessThanEqualsToken:
    case ts.SyntaxKind.GreaterThanToken:
    case ts.SyntaxKind.GreaterThanEqualsToken: {
      const cmpOp =
        op === ts.SyntaxKind.LessThanToken
          ? "<"
          : op === ts.SyntaxKind.LessThanEqualsToken
            ? "<="
            : op === ts.SyntaxKind.GreaterThanToken
              ? ">"
              : ">=";
      if (bothNum)
        return {
          kind: "bin",
          op: cmpOp,
          left: arithmeticLeft,
          right: arithmeticRight,
          type: BOOL,
          loc,
        };
      if (bothStr) return { kind: "strCmp", op: cmpOp, left, right, type: BOOL, loc };
      // Dates compare by time value, the number hint of ToPrimitive. Both
      // operands evaluate before either converts, so a right operand that
      // mutates the left Date (`a < (a.setTime(t), b)`) is seen: with such
      // a right operand, both Dates bind first and their times read after.
      if (left.type.kind === "date" && right.type.kind === "date") {
        const time = (d: IrExpr): IrExpr => ({
          kind: "libCall",
          fn: "date.getTime",
          args: [d],
          type: F64,
          loc,
        });
        if (isSafeToRepeat(right))
          return { kind: "bin", op: cmpOp, left: time(left), right: time(right), type: BOOL, loc };
        const leftDate = lowerer.declareHiddenLocal("%date", left.type);
        const rightDate = lowerer.declareHiddenLocal("%date", right.type);
        return {
          kind: "seqExpr",
          stmts: [
            { kind: "varDecl", localId: leftDate.id, init: left, loc },
            { kind: "varDecl", localId: rightDate.id, init: right, loc },
          ],
          result: {
            kind: "bin",
            op: cmpOp,
            left: time(varRef(leftDate.id, left.type, loc)),
            right: time(varRef(rightDate.id, right.type, loc)),
            type: BOOL,
            loc,
          },
          type: BOOL,
          loc,
        };
      }
      if (lowerer.dynConvertible(left.type) && lowerer.dynConvertible(right.type)) {
        return {
          kind: "libCall",
          fn: "dyn.compare",
          args: [
            lowerer.coerceToExpected(left, DYN),
            lowerer.coerceToExpected(right, DYN),
            { kind: "strLit", value: cmpOp, type: STRING, loc },
          ],
          type: BOOL,
          loc,
        };
      }
      lowerer.unsupported("SC1043", expr);
      break;
    }
    default:
      break;
  }
  lowerer.unsupported(
    "SC1090",
    expr,
    `operator '${ts.tokenToString(op) ?? ts.syntaxKindName(op)}'`,
  );
}

/** `left === right` (`!==` when negated) over lowered operands: JS strict
 * equality for every pair of static kinds the program can compare.
 * `node` anchors diagnostics, and `leftNode`/`rightNode` the coercions. */
export function lowerStrictEquality(
  lowerer: Lowerer,
  node: ts.Node,
  leftNode: ts.Node,
  rightNode: ts.Node,
  left: IrExpr,
  right: IrExpr,
  negated: boolean,
  loc: SrcLoc,
): IrExpr {
  const plainBothNum = left.type.kind === "f64" && right.type.kind === "f64";
  const bothStr = left.type.kind === "string" && right.type.kind === "string";
  const indexed = tryLowerIndexedComparison(lowerer, left, right, negated, loc);
  if (indexed) return indexed;
  if (plainBothNum)
    return { kind: "bin", op: negated ? "!==" : "===", left, right, type: BOOL, loc };
  if (bothStr) {
    if (left.kind === "strLit" && right.kind === "strLit")
      return {
        kind: "boolLit",
        value: (left.value === right.value) !== negated,
        type: BOOL,
        loc,
      };
    return { kind: "strEq", negated, left, right, type: BOOL, loc };
  }
  // bool === bool: a plain value compare (the config-drift checks'
  // `desired.lanMode !== actual.lanMode` shape).
  if (left.type.kind === "bool" && right.type.kind === "bool") {
    return { kind: "bin", op: negated ? "!==" : "===", left, right, type: BOOL, loc };
  }
  const unitTest = lowerer.lowerUnitComparison(left, right, negated, loc);
  if (unitTest) return unitTest;
  if (left.type.kind === "union" || right.type.kind === "union") {
    const compared = lowerUnionEquality(lowerer, left, right, negated, false, loc);
    if (compared) return compared;
    const aliasRefusal = (type: IrType): void => {
      if (tagEqualityMayMissAlias(lowerer, type))
        lowerer.unsupported(
          "SC1090",
          node,
          `comparisons of related class values beside structural union members (${NARROW_FIRST})`,
        );
    };

    // JS strict equality of the ARM values, per union tag (a
    // per-union helper): equal tags compare payloads (f64 ==, string
    // bytes, bool ==, ref-arm POINTER identity), different tags are
    // never equal. Two shapes lower: same union on both sides, and
    // union vs plain arm value (`u === "text"` where the checker
    // didn't narrow) — the plain side wraps into the union, which
    // preserves payload identity. Different unions (tsc admits
    // partially-overlapping ones) still need narrowing first.
    const ut = left.type.kind === "union" ? left.type : (right.type as IrType & { kind: "union" });
    const bothUnion = left.type.kind === "union" && right.type.kind === "union";
    const sameUnion = bothUnion && typeEquals(left.type, right.type);
    const plainFunc = left.type.kind === "func" ? left : right.type.kind === "func" ? right : null;
    const unionArms = lowerer.unions.get(ut.unionId)?.arms ?? [];
    const funcArm = unionArms.find((arm) => arm.kind === "func");
    // `listeners()` reports original prefix callbacks, but the
    // checker views an indexed result as function | undefined. For
    // identity comparison, retain the original closure pointer rather
    // than adapting it to the tuple signature.
    if (
      !bothUnion &&
      plainFunc !== null &&
      funcArm?.kind === "func" &&
      unionArms.filter((arm) => arm.kind === "func").length === 1 &&
      unionArms.some(isUnitType)
    ) {
      return {
        kind: "unionFuncEq",
        unionId: ut.unionId,
        tag: lowerer.armTag(ut.unionId, funcArm),
        union: left.type.kind === "union" ? left : right,
        func: plainFunc,
        negated,
        type: BOOL,
        loc,
      };
    }
    // A promise against a union with a promise arm, or two such unions:
    // converting a promise into a union's promise arm of another payload
    // (`chains.get(id) === tail` with a `Map<K, Promise<unknown>>`, or
    // `a.pending === b.pending` after both were set to one promise) builds a
    // new promise, so either side may hold a conversion of the other's
    // promise, and a value narrowed out of the union may be one too.
    // Promises are objects to ===, so compare both sides as untyped values,
    // where a converted promise answers with its origin's identity (the plain
    // promise-vs-promise rule below).
    const holdsPromise = (type: IrType): boolean =>
      type.kind === "promise" ||
      (type.kind === "union" &&
        (lowerer.unions.get(type.unionId)?.arms ?? []).some((arm) => arm.kind === "promise"));
    if (
      holdsPromise(left.type) &&
      holdsPromise(right.type) &&
      lowerer.dynConvertible(left.type) &&
      lowerer.dynConvertible(right.type)
    ) {
      return {
        kind: "dynScalarEq",
        left: lowerer.coerceToExpected(left, DYN),
        right: lowerer.coerceToExpected(right, DYN),
        ...(negated ? { negated: true as const } : {}),
        type: BOOL,
        loc,
      };
    }
    if ((sameUnion || !bothUnion) && lowerer.eqComparableUnion(ut.unionId)) {
      aliasRefusal(ut);
      return {
        kind: "unionEq",
        unionId: ut.unionId,
        negated,
        sameValue: false,
        left: lowerer.coerceInto(leftNode, left, ut),
        right: lowerer.coerceInto(rightNode, right, ut),
        type: BOOL,
        loc,
      };
    }
    if (left.type.kind === "union" && right.type.kind === "union") {
      const leftDef = lowerer.unions.get(left.type.unionId);
      const rightDef = lowerer.unions.get(right.type.unionId);
      if (leftDef && rightDef) {
        const leftValues = leftDef.arms.filter((arm) => !isUnitType(arm));
        const rightValues = rightDef.arms.filter((arm) => !isUnitType(arm));
        const sameValueArms =
          leftValues.length === rightValues.length &&
          leftValues.every((arm) => rightValues.some((candidate) => typeEquals(candidate, arm)));
        if (sameValueArms) {
          const arms = [...leftDef.arms];
          for (const arm of rightDef.arms) {
            if (!arms.some((candidate) => typeEquals(candidate, arm))) arms.push(arm);
          }
          arms.sort((a, b) => (typeKey(a) < typeKey(b) ? -1 : 1));
          const common: IrType & { kind: "union" } = {
            kind: "union",
            unionId: lowerer.unions.intern(arms),
          };
          aliasRefusal(common);
          return {
            kind: "unionEq",
            unionId: common.unionId,
            negated,
            sameValue: false,
            left: lowerer.coerceInto(leftNode, left, common),
            right: lowerer.coerceInto(rightNode, right, common),
            type: BOOL,
            loc,
          };
        }
      }
    }
    lowerer.unsupported("SC1090", node, `comparisons of union-typed values (${NARROW_FIRST})`);
  }
  // Arrays, maps, functions, class instances and records compare by
  // reference identity (pointer compare) — JS-exact object equality.
  // Hierarchy-related classes compare after widening the derived side
  // (same pointer either way — prefix layout).
  let idLeft = left;
  let idRight = right;
  if (left.type.kind === "object" && right.type.kind === "object") {
    if (lowerer.isSubclassOf(left.type.className, right.type.className)) {
      idLeft = lowerer.upcastTo(left, right.type.className);
    } else if (lowerer.isSubclassOf(right.type.className, left.type.className)) {
      idRight = lowerer.upcastTo(right, left.type.className);
    }
  }
  // Two function values compare by identity whatever their STATIC
  // signatures (tsc admits the comparison when one side is
  // assignable to the other — a tuple-typed listeners() element
  // against a prefix-declared handler): the pointer answers it.
  if (idLeft.type.kind === "func" && idRight.type.kind === "func") {
    return {
      kind: "bin",
      op: negated ? "!==" : "===",
      left: idLeft,
      right: idRight,
      type: BOOL,
      loc,
    };
  }
  // Two CLASS values compare by identity whatever their static
  // classes — one immortal object per class, one pointer compare
  // (the function-identity rule verbatim; `X === D` through a
  // base-typed slot answers exactly JS).
  if (idLeft.type.kind === "classval" && idRight.type.kind === "classval") {
    return {
      kind: "bin",
      op: negated ? "!==" : "===",
      left: idLeft,
      right: idRight,
      type: BOOL,
      loc,
    };
  }
  if (idLeft.type.kind === "moduleNs" && idRight.type.kind === "moduleNs") {
    return {
      kind: "bin",
      op: negated ? "!==" : "===",
      left: idLeft,
      right: idRight,
      type: BOOL,
      loc,
    };
  }
  if (
    (idLeft.type.kind === "array" ||
      idLeft.type.kind === "map" ||
      idLeft.type.kind === "set" ||
      idLeft.type.kind === "regex" ||
      idLeft.type.kind === "date" ||
      idLeft.type.kind === "url" ||
      idLeft.type.kind === "object" ||
      idLeft.type.kind === "record" ||
      // Symbols ARE identity: `Symbol('a') === Symbol('a')` is false,
      // a symbol equals exactly itself, and Symbol.for's interned
      // values compare equal across call sites — all one pointer
      // compare, JS's spec without approximation.
      idLeft.type.kind === "symbol" ||
      // Typed arrays / Buffers ARE objects to ===: pointer identity
      // (buf === buf.swap16() — the in-place mutators return this).
      idLeft.type.kind === "bytes" ||
      idLeft.type.kind === "promise") &&
    typeEquals(idLeft.type, idRight.type)
  ) {
    return {
      kind: "bin",
      op: negated ? "!==" : "===",
      left: idLeft,
      right: idRight,
      type: BOOL,
      loc,
    };
  }
  // Runtime HANDLES are objects to === too: one handle per socket/
  // request/response, so pointer identity IS JS's object equality
  // (`c.pause() === c` — Node's chaining assertions). */
  if (DYN_HANDLE_KINDS.has(idLeft.type.kind) && typeEquals(idLeft.type, idRight.type)) {
    return {
      kind: "bin",
      op: negated ? "!==" : "===",
      left: idLeft,
      right: idRight,
      type: BOOL,
      loc,
    };
  }
  if (lowerer.dynConvertible(idLeft.type) && lowerer.dynConvertible(idRight.type)) {
    return {
      kind: "dynScalarEq",
      left: lowerer.coerceToExpected(idLeft, DYN),
      right: lowerer.coerceToExpected(idRight, DYN),
      ...(negated ? { negated: true as const } : {}),
      type: BOOL,
      loc,
    };
  }
  return lowerer.unsupported("SC1043", node);
}

function lowerLogicalChain(lowerer: Lowerer, expr: ts.BinaryExpression): IrExpr {
  // Logical chains have a left-nested AST. Keep the native stack bounded
  // while retaining each pair's checker type and lazy operand evaluation.
  const parents: ts.BinaryExpression[] = [];
  let current = expr;
  let result: IrExpr;
  while (true) {
    if (current.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
      const fallback = lowerAbsenceAwareOrChain(lowerer, current);
      if (fallback !== null) {
        result = fallback;
        break;
      }
    }
    const left = current.left;
    if (
      ts.isBinaryExpression(left) &&
      (left.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        left.operatorToken.kind === ts.SyntaxKind.BarBarToken) &&
      !lowerer.chainRecvByNode.has(left)
    ) {
      parents.push(current);
      current = left;
      continue;
    }
    result = lowerLogicalPair(
      lowerer,
      current,
      current.operatorToken.kind === ts.SyntaxKind.BarBarToken
        ? lowerPresenceOperand(lowerer, left)
        : (lowerAbsenceProbe(lowerer, left) ?? lowerer.lowerExpr(left)),
    );
    break;
  }
  for (let i = parents.length - 1; i >= 0; i--) {
    result = lowerLogicalPair(lowerer, parents[i]!, result);
  }
  return result;
}

function lowerLogicalPair(lowerer: Lowerer, expr: ts.BinaryExpression, left: IrExpr): IrExpr {
  const op = expr.operatorToken.kind;
  const loc = locOf(expr);
  // Preserve short-circuiting during lowering too: an unreachable member
  // on a specialized value must not poison the surrounding JS statement.
  if (left.kind === "boolLit") {
    const takeRight = op === ts.SyntaxKind.AmpersandAmpersandToken ? left.value : !left.value;
    return takeRight ? lowerer.lowerExpr(expr.right) : left;
  }
  if (left.kind === "unitLit" && op === ts.SyntaxKind.AmpersandAmpersandToken) return left;
  if (op === ts.SyntaxKind.BarBarToken && REF_TRUTHY_KINDS.has(left.type.kind)) return left;
  const right = lowerer.lowerExpr(expr.right);
  // A LITERAL-unit left operand (a compile-time undefined/null — the
  // capability-probe members: `process.features.inspector ||
  // !flag.startsWith('--inspect')` reads undefined in a compiled
  // binary): statically falsy, so the operator folds JS-exactly —
  // `unit || X` IS X, `unit && X` IS the unit (X's side effects never
  // run in JS either; the lowered right is simply dropped). Literal
  // units only — computed unit-typed values keep the fences below.
  if (left.kind === "unitLit") {
    return op === ts.SyntaxKind.BarBarToken ? right : left;
  }
  // JS objects and symbols are always truthy. In `ref || fallback`
  // the fallback is therefore unreachable and the result is the
  // already-evaluated left value — the browser-fallback idiom used by
  // packages for `process.argv || []` and `process.env || {}`. The
  // operand itself remains in the IR, preserving reads/calls that
  // produce the reference; only the unreachable right lowering drops.
  if (op === ts.SyntaxKind.BarBarToken && REF_TRUTHY_KINDS.has(left.type.kind)) {
    return left;
  }
  if (left.type.kind === "dyn" || right.type.kind === "dyn") {
    // A checked-dynamic operand (`fn.name || '<anonymous>'` —
    // test/common's _mustCallInner): both sides live in the checked-dynamic tree and
    // the deciding test is ToBoolean over the dyn kind
    // (scr_dyn_truthy) — JS value semantics exactly, result dyn. The
    // non-dyn side converts through the usual boundary; a value with
    // no dyn representation keeps the fence.
    const l = lowerer.coerceToExpected(left, DYN);
    const r = lowerer.coerceToExpected(right, DYN);
    if (l.type.kind !== "dyn" || r.type.kind !== "dyn") {
      lowerer.unsupported("SC1100", expr, "logical operators on 'unknown' values");
    }
    return {
      kind: "logical",
      op: op === ts.SyntaxKind.AmpersandAmpersandToken ? "&&" : "||",
      left: l,
      right: r,
      type: DYN,
      loc,
    };
  }

  if (
    isJsSourceFile(ts.getSourceFileOfNode(expr)) &&
    op === ts.SyntaxKind.AmpersandAmpersandToken &&
    left.type.kind === "union" &&
    lowerer.unions.get(left.type.unionId)?.arms.some((arm) => arm.kind === "bool") &&
    !typeEquals(left.type, right.type) &&
    lowerer.dynConvertible(left.type) &&
    lowerer.dynConvertible(right.type)
  ) {
    return {
      kind: "logical",
      op: "&&",
      left: lowerer.coerceToExpected(left, DYN),
      right: lowerer.coerceToExpected(right, DYN),
      type: DYN,
      loc,
    };
  }
  if (left.type.kind === "union" || right.type.kind === "union") {
    // Test the deciding operand in its own representation. The result
    // contains only the values that can survive short-circuit evaluation.
    let target = lowerer.mapTypeOf(lowerer.typeOf(expr));
    // Index reads can be absent without noUncheckedIndexedAccess. Their
    // explicit nullish fallback still runs, even if the checker discarded it.
    if (target !== null) {
      const returned = [
        right.type,
        ...(op === ts.SyntaxKind.AmpersandAmpersandToken ? [left.type] : []),
      ];
      for (const type of returned) {
        const arms =
          type.kind === "union" ? (lowerer.unions.get(type.unionId)?.arms ?? []) : [type];
        for (const arm of arms) {
          if (arm.kind === "undefinedT" && !isUnitType(target))
            target = lowerer.runtimeOptionalType(target);
          if (arm.kind === "nullT")
            target = withUnitArm(target, arm.kind, lowerer.unions) ?? target;
        }
      }
    }
    // A broad-JSDoc npm-static body can leave the CHECKER result `any`
    // even after declaration-backed specialization has recovered both
    // operands (`helpOption && args.find(...)` in commander). When the
    // left consists only of always-truthy references and falsy units,
    // the static result is exactly the right operand plus those units.
    if (
      op === ts.SyntaxKind.AmpersandAmpersandToken &&
      target === null &&
      lowerer.implicitParamTypes !== null &&
      npmStaticPackageOfPath(ts.getSourceFileOfNode(expr).fileName) !== null &&
      (lowerer.typeOf(expr).flags & ts.TypeFlags.Any) !== 0 &&
      left.type.kind === "union"
    ) {
      const leftArms = lowerer.unions.get(left.type.unionId)?.arms;
      const rightArms =
        right.type.kind === "union" ? lowerer.unions.get(right.type.unionId)?.arms : [right.type];
      const rightIsStatic =
        rightArms?.every(
          (arm) => arm.kind !== "dyn" && arm.kind !== "caught" && arm.kind !== "void",
        ) ?? false;
      if (
        leftArms &&
        rightArms &&
        rightIsStatic &&
        leftArms.some(isUnitType) &&
        leftArms.every((arm) => isUnitType(arm) || REF_TRUTHY_KINDS.has(arm.kind))
      ) {
        const byKey = new Map<string, IrType>();
        for (const arm of [...rightArms, ...leftArms.filter(isUnitType)]) {
          byKey.set(typeKey(arm), arm);
        }
        const arms = [...byKey.values()].sort((a, b) => (typeKey(a) < typeKey(b) ? -1 : 1));
        if (arms.length > 1) {
          const source =
            right.type.kind === "union" ? lowerer.unions.get(right.type.unionId) : undefined;
          target = {
            kind: "union",
            unionId: source ? lowerer.unions.transform(source, arms) : lowerer.unions.intern(arms),
          };
        }
      }
    }
    // `&&` over an always-truthy plain left operand (an array, object or
    // function value) whose result union has no arm for it: every JS
    // object is truthy, so `list && list[0]` evaluates the left for its
    // effects and answers the right. Coercing the left into that union
    // would trap at run time where Node answers the right operand.
    if (
      op === ts.SyntaxKind.AmpersandAmpersandToken &&
      target?.kind === "union" &&
      REF_TRUTHY_KINDS.has(left.type.kind) &&
      lowerer.armTag(target.unionId, left.type) < 0
    ) {
      return {
        kind: "seqExpr",
        stmts: [{ kind: "exprStmt", expr: left, loc }],
        result: lowerer.coerceInto(expr.right, right, target),
        type: target,
        loc,
      };
    }
    if (target?.kind === "union") {
      // `&&` whose left does NOT fit the result union: the checker
      // built that result by DROPPING left arms which are always
      // truthy (`Option | undefined && string | undefined` answers
      // `string | undefined`, not `Option | string | undefined`).
      // Evaluate the left once, test it in its own union, and retag it
      // only on the falsy path. Any stranded reference arms are
      // unreachable there because every JS object is truthy.
      if (
        op === ts.SyntaxKind.AmpersandAmpersandToken &&
        left.type.kind === "union" &&
        !typeEquals(left.type, target)
      ) {
        const def = lowerer.unions.get(left.type.unionId);
        const trappable = new Set<number>();
        def?.arms.forEach((arm, tag) => {
          if (lowerer.armTag(target.unionId, arm) < 0 && REF_TRUTHY_KINDS.has(arm.kind)) {
            trappable.add(tag);
          }
        });
        const retag =
          trappable.size === 0
            ? null
            : lowerer.unionRetagHelper(left.type.unionId, target.unionId, loc, trappable);
        if (retag) {
          lowerer.requireTruthyUnion(left.type.unionId, expr);
          const stmts: IrStmt[] = [];
          let stable: IrExpr = left;
          if (!isSafeToRepeat(left)) {
            const local = lowerer.declareHiddenLocal("%and", left.type);
            stmts.push({ kind: "varDecl", localId: local.id, init: left, loc });
            stable = varRef(local.id, left.type, loc);
          }
          const result: IrExpr = {
            kind: "ternary",
            cond: lowerer.ensureBool(stable, expr.left),
            then: lowerer.coerceInto(expr.right, right, target),
            else_: { kind: "call", callee: retag, args: [stable], type: target, loc },
            type: target,
            loc,
          };
          return stmts.length === 0
            ? result
            : { kind: "seqExpr", stmts, result, type: target, loc };
        }
      }
      // `||` whose left does NOT fit the result union: the checker built
      // that result by DROPPING the left's falsy arms (`process.env.X ||
      // null` is `string | null`, `|| 3000` is `string | number` — the
      // `undefined` is gone from both), so coercing the left eagerly, as
      // the shared shape below does, retags an arm the test is about to
      // rule out and throws where Node yields the default. Single-eval
      // instead: test the left in its OWN union and retag only on the
      // truthy side, where the dropped arms are unreachable.
      if (
        op === ts.SyntaxKind.BarBarToken &&
        left.type.kind === "union" &&
        !typeEquals(left.type, target)
      ) {
        const retag = lowerer.unionRetagHelper(left.type.unionId, target.unionId, loc);
        if (retag) {
          lowerer.requireTruthyUnion(left.type.unionId, expr);
          return {
            kind: "orDefault",
            left,
            right: lowerer.coerceInto(expr.right, right, target),
            retag,
            type: target,
            loc,
          };
        }
      }
      lowerer.requireTruthyUnion(target.unionId, expr);
      return {
        kind: "logical",
        op: op === ts.SyntaxKind.AmpersandAmpersandToken ? "&&" : "||",
        left: lowerer.coerceInto(expr.left, left, target),
        right: lowerer.coerceInto(expr.right, right, target),
        type: target,
        loc,
      };
    }
    // `u || d` NARROWED by the default: the checker types the result
    // as u's single non-unit arm (`marker() || "default"`) — evaluate
    // u once, truthy extracts the arm, falsy takes d lazily (the
    // orDefault node, nullish's truthiness sibling). An UNMAPPABLE
    // checker result takes the same rule (`options.runner ||
    // defaultRunner` — tsc's union of two structurally-compatible
    // function types has no representation, while the left's one
    // non-unit arm is the only representable answer): the default
    // must coerce into the arm or fence on its own.
    if (op === ts.SyntaxKind.BarBarToken && left.type.kind === "union") {
      const def = lowerer.unions.get(left.type.unionId);
      const rest = def ? def.arms.filter((a) => !isUnitType(a)) : [];
      const funcArmDefault =
        rest[0]?.kind === "func" && (target === null || target.kind === "func");
      if (
        rest.length === 1 &&
        ((target !== null && typeEquals(target, rest[0]!)) || funcArmDefault)
      ) {
        lowerer.requireTruthyUnion(left.type.unionId, expr);
        const dflt = lowerer.lowerExprExpecting(expr.right, rest[0]!);
        return { kind: "orDefault", left, right: dflt, type: rest[0]!, loc };
      }
    }
    // JavaScript defaults can join differently inferred object layouts.
    // When both operands have native checked representations, preserve
    // the deciding value and short-circuit evaluation in that domain.
    if (
      isJsSourceFile(ts.getSourceFileOfNode(expr)) &&
      lowerer.dynConvertible(left.type) &&
      lowerer.dynConvertible(right.type)
    ) {
      return {
        kind: "logical",
        op: op === ts.SyntaxKind.AmpersandAmpersandToken ? "&&" : "||",
        left: lowerer.coerceInto(expr.left, left, DYN),
        right: lowerer.coerceInto(expr.right, right, DYN),
        type: DYN,
        loc,
      };
    }
    lowerer.unsupported(
      "SC1090",
      expr,
      `logical operators on union-typed values outside conditions (${NARROW_FIRST})`,
    );
  }
  const kind = left.type.kind;
  if (kind !== right.type.kind || (kind !== "f64" && kind !== "string" && kind !== "bool")) {
    // Mixed PLAIN operands (`value || null`, `flag || undefined`,
    // `s || 0`): JS value semantics still compile when the checker
    // types the RESULT as one union both operands coerce into — the
    // same lift the union-operand path above takes, arriving here
    // with two plain arm values instead.
    const target = lowerer.mapTypeOf(lowerer.typeOf(expr));
    // An always-truthy left operand (a record, object, array or function
    // value: every JS object is truthy): `o && x` evaluates `o` for its
    // effects and answers `x`; `o || x` answers `o` and never evaluates
    // `x`. supports-color's `stream && stream.isTTY` is the shape. Ahead
    // of the union lift below exactly where that lift would store the
    // object in a result union with no arm for it; a union holding the
    // operand keeps the lift.
    if (
      REF_TRUTHY_KINDS.has(kind) &&
      (target?.kind !== "union" ||
        (op === ts.SyntaxKind.AmpersandAmpersandToken &&
          lowerer.armTag(target.unionId, left.type) < 0))
    ) {
      const and = op === ts.SyntaxKind.AmpersandAmpersandToken;
      const answer = and ? right : left;
      const answerT = target ?? answer.type;
      if (answerT.kind !== "void") {
        const value = lowerer.coerceInto(and ? expr.right : expr.left, answer, answerT);
        if (!and) return value;
        return {
          kind: "seqExpr",
          stmts: [{ kind: "exprStmt", expr: left, loc }],
          result: value,
          type: answerT,
          loc,
        };
      }
    }
    if (target?.kind === "union") {
      lowerer.requireTruthyUnion(target.unionId, expr);
      return {
        kind: "logical",
        op: op === ts.SyntaxKind.AmpersandAmpersandToken ? "&&" : "||",
        left: lowerer.coerceInto(expr.left, left, target),
        right: lowerer.coerceInto(expr.right, right, target),
        type: target,
        loc,
      };
    }
    // A JavaScript default that tsc types `any` (`e.title || null` in an
    // instance of a function with untyped parameters, where `e.title` is a
    // string): the checked domain, as for union operands above.
    if (
      target === null &&
      isJsSourceFile(ts.getSourceFileOfNode(expr)) &&
      lowerer.dynConvertible(left.type) &&
      lowerer.dynConvertible(right.type)
    ) {
      return {
        kind: "logical",
        op: op === ts.SyntaxKind.AmpersandAmpersandToken ? "&&" : "||",
        left: lowerer.coerceInto(expr.left, left, DYN),
        right: lowerer.coerceInto(expr.right, right, DYN),
        type: DYN,
        loc,
      };
    }
    lowerer.unsupported("SC1042", expr);
  }
  return {
    kind: "logical",
    op: op === ts.SyntaxKind.AmpersandAmpersandToken ? "&&" : "||",
    left,
    right,
    type: left.type,
    loc,
  };
}

function lowerAbsenceAwareOrChain(lowerer: Lowerer, expr: ts.BinaryExpression): IrExpr | null {
  const nodes: ts.Expression[] = [];
  const pending: ts.Expression[] = [expr];
  while (pending.length !== 0) {
    const node = pending.pop()!;
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
      pending.push(node.right, node.left);
    } else {
      nodes.push(node);
    }
  }
  if (nodes.length < 3) return null;
  const lowered = nodes.map((node) => lowerAbsenceProbe(lowerer, node) ?? lowerer.lowerExpr(node));
  if (
    !lowered.some(
      (value) =>
        value.type.kind === "union" && lowerer.armTag(value.type.unionId, UNDEFINED_T) >= 0,
    )
  ) {
    return null;
  }
  let result = lowered[lowered.length - 1]!;
  for (let i = lowered.length - 2; i >= 0; i--) {
    const left = lowered[i]!;
    const loc = locOf(nodes[i]!);
    if (left.type.kind === "union") {
      const def = lowerer.unions.get(left.type.unionId);
      const nonUnit = def?.arms.filter((arm) => !isUnitType(arm)) ?? [];
      if (nonUnit.length !== 1 || !typeEquals(nonUnit[0]!, result.type)) return null;
      lowerer.requireTruthyUnion(left.type.unionId, expr);
      result = { kind: "orDefault", left, right: result, type: result.type, loc };
      continue;
    }
    if (!typeEquals(left.type, result.type)) return null;
    result = { kind: "logical", op: "||", left, right: result, type: result.type, loc };
  }
  return result;
}

/** `typeof WebAssembly === "object"` and `typeof WebAssembly.<member> ===
 * "function"`: the operand needs no value, so the test folds as bare typeof
 * does (builtins/webassembly.ts) before any dyn-typed operand lowers. */
function lowerWebAssemblyTypeofTest(
  lowerer: Lowerer,
  expr: ts.BinaryExpression,
  loc: SrcLoc,
): IrExpr | null {
  const negated = expr.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken;
  for (const [a, b] of operandPairs(expr)) {
    if (!ts.isTypeOfExpression(a) || !ts.isStringLiteral(b)) continue;
    const folded = lowerWebAssemblyTypeof(lowerer, a.expression);
    if (folded?.kind !== "strLit") continue;
    return { kind: "boolLit", value: (folded.value === b.text) !== negated, type: BOOL, loc };
  }
  return null;
}

/** `typeof v === "lit"` / `typeof v !== "lit"` where v is UNION-typed: the
 * arms whose static typeof answer equals the literal form a tag set, and
 * the test is a runtime tag test — one `unionIsTag` for a single matching
 * arm (the operand embeds once, so even effectful operands compose), a
 * short-circuit chain for several (pure reads only — the operand rides
 * every test, exactly the `== null` composition rule). When every arm
 * answers the same way the comparison is statically decided and folds to
 * a bool literal — dropping only a side-effect-free read, the same
 * trust-the-checker bet as lowerUnitComparison. tsc's control-flow
 * narrowing then types the branches, and reads bridge through
 * maybeNarrow's unionNarrow as usual. Null when neither side is a typeof
 * over a union-typed operand or the literal side isn't a literal (the
 * bare-typeof value form then composes with strEq for pure operands). */
function lowerUnionTypeofTest(
  lowerer: Lowerer,
  expr: ts.BinaryExpression,
  loc: SrcLoc,
): IrExpr | null {
  const negated = expr.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken;
  for (const [a, b] of operandPairs(expr)) {
    if (!ts.isTypeOfExpression(a)) continue;
    const stored = runtimeOptionalStorageOperand(lowerer, a.expression);
    if (stored === null && lowerer.mapTypeOf(lowerer.typeOf(a.expression))?.kind !== "union")
      continue;
    if (!ts.isStringLiteral(b)) continue; // bare-typeof + strEq handles pure operands
    const value = stored ?? lowerer.lowerExpr(a.expression);
    if (value.type.kind !== "union") continue; // defensive: an already-narrowed use
    const unionId = value.type.unionId;
    const def = lowerer.unions.get(unionId);
    const answers = def?.arms.map(typeofAnswer);
    if (!def || !answers || !answers.every((s): s is string => s !== null)) continue;
    const tags = answers.flatMap((s, i) => (s === b.text ? [i] : []));
    if (tags.length === 0 || tags.length === def.arms.length) {
      if (!isSafeToRepeat(value)) {
        lowerer.unsupported(
          "SC1090",
          expr,
          "statically-decided 'typeof' tests over effectful operands (bind the value to a const first)",
        );
      }
      return { kind: "boolLit", value: (tags.length !== 0) !== negated, type: BOOL, loc };
    }
    const isTag = (tag: number): IrExpr => ({
      kind: "unionIsTag",
      unionId,
      tag,
      negated,
      value,
      type: BOOL,
      loc,
    });
    if (tags.length === 1) return isTag(tags[0]!);
    if (!isSafeToRepeat(value)) {
      lowerer.unsupported(
        "SC1090",
        expr,
        "'typeof' tests matching several union arms over operands that aren't plain reads (bind the value to a const first)",
      );
    }
    // Tag-in-set as a short-circuit chain (De Morgan for `!==`).
    let acc = isTag(tags[0]!);
    for (const t of tags.slice(1)) {
      acc = {
        kind: "logical",
        op: negated ? "&&" : "||",
        left: acc,
        right: isTag(t),
        type: BOOL,
        loc,
      };
    }
    return acc;
  }
  return null;
}
