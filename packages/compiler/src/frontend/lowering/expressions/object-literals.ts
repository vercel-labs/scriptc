import { InternalCompilerError } from "../../../errors.js";
import * as ts from "../../ts7/adapter.js";
import {
  BOOL,
  DYN,
  F64,
  STRING,
  UNDEFINED_T,
  VOID,
  arrayOf,
  canDynCheckTo,
  isUnitType,
  shapeHasAccessorSlots,
  typeEquals,
} from "../../../ir/ir.js";
import type { IrExpr, IrLocal, IrRecordShape, IrStmt, IrType, SrcLoc } from "../../../ir/ir.js";
import { isCjsExportTableLiteral, isJsSourceFile, locOf } from "../../program.js";
import { NARROW_FIRST } from "../surfaces.js";
import { recordShapeMismatchDiag } from "../../../diagnostics/diagnostic.js";
import { PoisonError, dynUndefinedExpr } from "../lowerer.js";
import type { Lowerer } from "../lowerer.js";
import { lowerIndexMergeHelper } from "../lower-containers.js";
import type { IndexMergeContributor } from "../lower-containers.js";
import { isGenericCallableMemberType } from "../../type-mapper.js";
import { numLit, varRef } from "../../../ir/build.js";
import { isSafeToRepeat } from "./evaluation-safety.js";
import { tryLowerExpression } from "./try-lower-expression.js";

/** `{ a: 1, b: "x" }` → recordLit. The record type comes from the
 * contextual type when tsc has one (annotated declarations, arguments,
 * nested literals) and from the literal's own type otherwise — both intern
 * to the same shapeId unless width subtyping is in play (an `as` cast can
 * smuggle a wider/narrower literal past tsc's freshness check), which the
 * exact-shape checks below reject with SC2002. Fields lower IN SOURCE
 * ORDER: JS evaluates property values in source order. */
/** The dropped-field names of the PromiseSettledResult honest subset
 * (SEMANTICS.md 46): when the literal's target type is (a union
 * containing) the lib's PromiseFulfilledResult / PromiseRejectedResult,
 * the record mapping kept only `status` — `value` and `reason` evaluate
 * for effect and are not stored. Null for every other target. */
function settledDropNames(lowerer: Lowerer, tsType: ts.Type): Set<string> | null {
  let names: Set<string> | null = null;
  const parts: readonly ts.Type[] = tsType.isUnionType() ? ts.constituentTypes(tsType) : [tsType];
  for (const part of parts) {
    const sym = part.getSymbol();
    if (
      !sym ||
      !lowerer.checker.declarationsOf(sym).some(
        (d) => ts.isInterfaceDeclaration(d) && lowerer.isStdlibFile(d.getSourceFile()),
      )
    ) {
      continue;
    }
    if (sym.name === "PromiseFulfilledResult") (names ??= new Set()).add("value");
    if (sym.name === "PromiseRejectedResult") (names ??= new Set()).add("reason");
  }
  return names;
}

/** `{ [KEY]: v }` where KEY is a compile-time-known string or number:
 * the key folds into an ordinary (spelled) property name — the record
 * shape is exactly what tsc computed for the literal (the late-bound
 * name IS the checker's literal type), so the fold is just spelling.
 * PURE key forms only, so skipping the key's evaluation is exact (JS
 * evaluates the key before the value; effectful expressions keep the
 * fence): any side-effect-free expression — identifiers, property
 * chains with no accessor on them (enum members, `other.name` reads),
 * literals, parenthesized/as-wrapped forms, operators over those —
 * whose checker type is ONE string or number literal (or a union whose
 * arms all spell the same name — `E1.x || E2.x` where both are 0).
 * Number keys take JS's canonical spelling (`{ [E.member]: v }` stores
 * "0" — ToPropertyKey), exactly the name tsc late-bound. Templates
 * fold structurally span by span as well (a template of literals whose
 * checker type widened still spells one string). Symbol-typed and
 * runtime-valued keys stay out. */
function literalComputedKey(lowerer: Lowerer, name: ts.ComputedPropertyName): string | null {
  return foldedStringKeyOf(lowerer, name.expression);
}

export function foldedStringKeyOf(lowerer: Lowerer, expr: ts.Expression): string | null {
  if (ts.isParenthesizedExpression(expr)) return foldedStringKeyOf(lowerer, expr.expression);
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return expr.text;
  if (ts.isTemplateExpression(expr)) {
    // Structural fold first — exact even where the checker widened the
    // template's own type; the general type-directed fold below is the
    // fallback (a template the checker DID type as one literal).
    let out = expr.head.text;
    let folded = true;
    for (const span of expr.templateSpans) {
      const part = foldedStringKeyOf(lowerer, span.expression);
      if (part === null) {
        folded = false;
        break;
      }
      out += part + span.literal.text;
    }
    if (folded) return out;
  }
  // The general fold: a PURE expression whose checker type spells one
  // property name. An as-cast folds by its OWN checker type — that is
  // the name tsc late-bound the property under, so shape and storage
  // stay one name (the standard trust-the-checker bet); a cast that
  // WIDENS to string un-late-binds the property, its type is no literal,
  // and the fence stays.
  if (!pureKeyExpr(lowerer, expr)) return null;
  return literalKeySpellingOf(lowerer.typeOf(expr));
}

/** The property-name spelling of a single-literal checker type: string
 * literals directly, number literals in JS's canonical ToString spelling
 * (enum members included — their literal flags carry the value), and
 * unions whose arms all spell the SAME name (`E1.x || E2.x` — two enum
 * literal types, one value). Null for everything else. */
function literalKeySpellingOf(t: ts.Type): string | null {
  if (t.isStringLiteralType()) return t.value;
  if (t.isNumberLiteralType()) return String(t.value);
  if (t.isUnionType()) {
    let out: string | null = null;
    for (const arm of ts.constituentTypes(t)) {
      const s = arm.isStringLiteralType() ? arm.value : arm.isNumberLiteralType() ? String(arm.value) : null;
      if (s === null || (out !== null && s !== out)) return null;
      out = s;
    }
    return out;
  }
  return null;
}

/** True iff evaluating `expr` can have no observable effect, so a fold
 * may skip it: literals, identifier reads, property chains whose every
 * member is a plain field/enum member (an accessor anywhere on the chain
 * is a call), operators and casts over those. Calls, `new`, assignments,
 * and element accesses stay impure. */
function pureKeyExpr(lowerer: Lowerer, expr: ts.Expression): boolean {
  if (ts.isParenthesizedExpression(expr) || ts.isNonNullExpression(expr)) return pureKeyExpr(lowerer, expr.expression);
  if (ts.isAsExpression(expr) || ts.isTypeAssertion(expr)) return pureKeyExpr(lowerer, expr.expression);
  if (ts.isIdentifier(expr)) return true;
  if (ts.isStringLiteralLike(expr) || ts.isNumericLiteral(expr)) return true;
  if (expr.kind === ts.SyntaxKind.TrueKeyword || expr.kind === ts.SyntaxKind.FalseKeyword ||
      expr.kind === ts.SyntaxKind.NullKeyword) return true;
  if (ts.isPropertyAccessExpression(expr)) {
    const sym = lowerer.checker.getSymbolAtLocation(expr.name);
    if (sym && sym.flags & (ts.SymbolFlags.GetAccessor | ts.SymbolFlags.SetAccessor)) return false;
    return pureKeyExpr(lowerer, expr.expression);
  }
  if (ts.isPrefixUnaryExpression(expr) &&
      (expr.operator === ts.SyntaxKind.MinusToken || expr.operator === ts.SyntaxKind.PlusToken ||
       expr.operator === ts.SyntaxKind.ExclamationToken || expr.operator === ts.SyntaxKind.TildeToken)) {
    return pureKeyExpr(lowerer, expr.operand);
  }
  if (ts.isBinaryExpression(expr)) {
    const op = expr.operatorToken.kind;
    const pureOp =
      op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken ||
      op === ts.SyntaxKind.QuestionQuestionToken ||
      (op >= ts.SyntaxKind.LessThanToken && op <= ts.SyntaxKind.CaretToken &&
        op !== ts.SyntaxKind.InstanceOfKeyword && op !== ts.SyntaxKind.InKeyword);
    return pureOp && pureKeyExpr(lowerer, expr.left) && pureKeyExpr(lowerer, expr.right);
  }
  if (ts.isConditionalExpression(expr)) {
    return pureKeyExpr(lowerer, expr.condition) && pureKeyExpr(lowerer, expr.whenTrue) && pureKeyExpr(lowerer, expr.whenFalse);
  }
  if (ts.isTemplateExpression(expr)) return expr.templateSpans.every((s) => pureKeyExpr(lowerer, s.expression));
  return false;
}

/** A property's field name: identifier/string-literal keys directly,
 * foldable computed keys through literalComputedKey (the syntax pass
 * fenced everything else). */
function propNameText(lowerer: Lowerer, name: ts.PropertyName): string {
  if (ts.isComputedPropertyName(name)) {
    const k = literalComputedKey(lowerer, name);
    if (k === null) throw new InternalCompilerError("lowerer bug: unfoldable computed key past the fence");
    return k;
  }
  // Numeric literals name their canonical string key (JS's ToPropertyKey
  // — the same name the checker gives the property symbol).
  if (ts.isNumericLiteral(name)) return String(Number(name.text));
  return (name as ts.Identifier | ts.StringLiteral).text;
}

/** The runtime-keyed JS object literal (a computed key that doesn't fold):
 * builds a dyn object member-by-member. Keys evaluate before their values,
 * properties in source order — JS's object-literal evaluation exactly.
 * Identifier/string keys are compile-time strings; numeric keys take
 * their canonical number string (`{ 0x10: v }` stores "16" — JS's
 * ToPropertyKey); computed keys evaluate and pass through ToString (the
 * dyn's String() for dyn operands — `{ [field]: v }` where field is a
 * checked-dynamic param). Values convert through the usual dyn boundary
 * (dynFrom's domain, functions box); a value with no dyn representation
 * fences per property. Spreads copy through dyn.assign in source order;
 * accessors stay fenced. */
export function lowerDynObjectLiteral(
  lowerer: Lowerer,
  expr: ts.ObjectLiteralExpression,
  boxValue?: (node: ts.Expression, value: IrExpr) => IrExpr,
): IrExpr {
  const loc = locOf(expr);
  let fields: { key: IrExpr; value: IrExpr }[] = [];
  let acc: IrExpr | null = null;
  const flushFields = (): void => {
    if (fields.length === 0) return;
    const chunk: IrExpr = { kind: "dynObjLit", fields, type: DYN, loc };
    acc = acc === null
      ? chunk
      : { kind: "libCall", fn: "dyn.assign", args: [acc, chunk], type: DYN, loc };
    fields = [];
  };
  for (const prop of expr.properties) {
    if (ts.isSpreadAssignment(prop)) {
      flushFields();
      const raw = lowerer.lowerExpr(prop.expression);
      const source = boxValue
        ? boxValue(prop.expression, raw)
        : lowerer.coerceToExpected(raw, DYN);
      if (source.type.kind !== "dyn") {
        lowerer.unsupported("SC1101", prop.expression, `spreading '${lowerer.fmt(source.type)}' into a checked-dynamic object literal`);
      }
      acc ??= { kind: "dynObjLit", fields: [], type: DYN, loc };
      acc = { kind: "libCall", fn: "dyn.assign", args: [acc, source], type: DYN, loc: locOf(prop) };
      continue;
    }
    if (
      !ts.isPropertyAssignment(prop) &&
      !ts.isShorthandPropertyAssignment(prop) &&
      !ts.isMethodDeclaration(prop)
    ) {
      lowerer.unsupported(
        "SC1090",
        prop,
        "accessors in a runtime-keyed (computed-key) object literal",
      );
    }
    const name = prop.name;
    let key: IrExpr;
    if (ts.isComputedPropertyName(name)) {
      const folded = literalComputedKey(lowerer, name);
      if (folded !== null) {
        key = { kind: "strLit", value: folded, type: STRING, loc: locOf(name) };
      } else {
        let k = lowerer.lowerExpr(name.expression);
        if (k.type.kind === "f64" || k.type.kind === "bool" || k.type.kind === "dyn") {
          k = { kind: "toString", operand: k, type: STRING, loc: locOf(name) };
        }
        if (k.type.kind !== "string") {
          lowerer.unsupported(
            "SC1090",
            name,
            `'${lowerer.fmt(k.type)}'-typed computed property keys (string, number, boolean, and unknown keys stringify)`,
          );
        }
        key = k;
      }
    } else if (ts.isIdentifier(name) || ts.isStringLiteral(name)) {
      key = { kind: "strLit", value: name.text, type: STRING, loc: locOf(name) };
    } else if (ts.isNumericLiteral(name)) {
      key = { kind: "strLit", value: String(Number(name.text)), type: STRING, loc: locOf(name) };
    } else {
      lowerer.unsupported("SC1090", prop, "non-identifier property names");
    }
    const valueExpr: ts.Node = ts.isMethodDeclaration(prop)
      ? prop
      : ts.isShorthandPropertyAssignment(prop)
        ? (prop.name as ts.Identifier)
        : prop.initializer;
    // Lambda values that fail to lower become trap closures (the
    // per-call fence granularity — fenceClosureProbe) so the object
    // still builds; everything else keeps the per-property fence below.
    let raw: IrExpr;
    const propDiagsBefore = lowerer.diags.length;
    try {
      const lowerValue = (): IrExpr =>
        ts.isMethodDeclaration(prop)
          ? (lowerer.rejectThisInObjectMethod(prop.body ?? prop), lowerer.lowerLambda(prop))
          : lowerer.lowerExpr(valueExpr as ts.Expression);
      raw =
        fenceClosureProbe(lowerer, valueExpr, undefined, lowerValue) ??
        lowerValue();
    } catch (err) {
      // A PURE member read a JS file cannot lower (a namespace object
      // in an export aggregate): the slot takes a boxed fence closure —
      // the diagnostics defer to the runtime-fence ledger, the object
      // builds, and only USING the member stops the run.
      const pureMember = ts.isIdentifier(valueExpr);
      if (!(err instanceof PoisonError) || !pureMember) throw err;
      const fence = lowerer.deferToRuntimeFence(propDiagsBefore, prop, {
        kind: "closure",
        name: () => `%fn${lowerer.lambdaCounter++}_dynfence`,
        returnType: VOID,
        type: { kind: "func", params: [], ret: VOID },
      });
      if (!fence) throw err;
      raw = fence;
    }
    let v = boxValue
      ? boxValue(valueExpr as ts.Expression, raw)
      : lowerer.coerceToExpected(raw, DYN);
    if (v.type.kind !== "dyn") {
      const convDiagsBefore = lowerer.diags.length;
      try {
        lowerer.unsupported(
          "SC1101",
          valueExpr,
          `holding '${lowerer.fmt(v.type)}' values in a runtime-keyed (computed-key) object literal`,
        );
      } catch (err) {
        // A member value the checked-dynamic tree cannot hold — a func whose signature
        // cannot box, an island ('any') handle, a record carrying func
        // fields (the export aggregate's typed utilities and npm-handle
        // members): the same call-time fence deferral as an unlowerable
        // member — the slot takes a boxed fence closure; only USING it
        // stops the run. Probe mode and ICEs keep the poison.
        if (!(err instanceof PoisonError)) throw err;
        const fence = lowerer.deferToRuntimeFence(convDiagsBefore, prop, {
          kind: "closure",
          name: () => `%fn${lowerer.lambdaCounter++}_dynfence`,
          returnType: VOID,
          type: { kind: "func", params: [], ret: VOID },
        });
        if (!fence) throw err;
        v = lowerer.coerceToExpected(fence, DYN);
      }
    }
    fields.push({ key, value: v });
  }
  flushFields();
  return acc ?? { kind: "dynObjLit", fields: [], type: DYN, loc };
}

/** Spreading a source whose shape carries accessor slots: Node's copy
 * invokes each getter exactly once in insertion order — even for keys a
 * later contributor overrides — while the field-copy desugar assumes pure
 * reads it may drop or reorder. Getter-call counts would silently diverge,
 * so accessor-carrying sources fence by name. */
function fenceAccessorSpreadSource(lowerer: Lowerer, prop: ts.Node, srcShape: IrRecordShape | undefined): void {
if (srcShape && shapeHasAccessorSlots(srcShape)) {
  lowerer.unsupported(
    "SC1090",
    prop,
    "object spread of sources carrying get/set accessor properties (Node invokes each getter once during the copy — the field-copy desugar cannot model the calls; bind the reads to consts first)",
  );
}
}
/** The JS trap-closure fallback for FUNCTION-VALUED object properties: a
 * lambda whose body fails to lower inside a JS object literal becomes a
 * closure of the field's exact func type whose body is the runtime fence —
 * the object still BUILDS (commander's `_outputConfiguration` table: the
 * driven writeOut/writeErr entries work; an unloweraable color probe traps
 * only if something CALLS it). The failed lambda's diagnostics move to the
 * runtime-fence inventory, exactly like a fenced JS statement. Null when
 * the fallback does not apply (not a JS file, not a lambda, no func slot)
 * — the caller lowers normally. ICEs (SC9001) never convert. */
function fenceClosureProbe(
lowerer: Lowerer,
node: ts.Node,
slotType: IrType | undefined,
attempt: () => IrExpr,
): IrExpr | null {
if (!isJsSourceFile(node.getSourceFile())) return null;
let inner: ts.Node = node;
while (ts.isParenthesizedExpression(inner)) inner = inner.expression;
if (!ts.isArrowFunction(inner) && !ts.isFunctionExpression(inner) && !ts.isMethodDeclaration(inner)) {
  return null;
}
// The trap's ABI: the field's func slot when one exists; otherwise (the
// dyn-object literal path — the value boxes into dyn) the all-dyn
// signature of the lambda's own arity, which canBoxFuncIntoDyn always
// admits.
const fieldType: IrType & { kind: "func" } =
  slotType !== undefined && slotType.kind === "func"
    ? slotType
    : { kind: "func", params: inner.parameters.map(() => DYN), ret: DYN };
if (slotType !== undefined && slotType.kind !== "func") return null;
const diagsBefore = lowerer.diags.length;
try {
  return attempt();
} catch (e) {
  if (!(e instanceof PoisonError)) throw e;
  const params = fieldType.params.map((t, i) => ({ localId: `p.${i}`, name: `p${i}`, type: t }));
  const fence = lowerer.deferToRuntimeFence(diagsBefore, node, {
    kind: "closure",
    name: () => `%fence.fn.${lowerer.liftedFns.length}`,
    params,
    returnType: fieldType.ret,
    paramsMutable: true,
    type: fieldType,
    fallback: { code: "SC1090", message: "this function's body has no static lowering" },
    bareMessage: true,
    allowDiagSink: true,
  });
  if (!fence) throw e;
  return fence;
}
}

/** The union arm an object LITERAL inhabits when its fields must widen
 * PER FIELD into exactly one record arm — the reducer-action pattern
 * (`{ kind: "a", parsed: 1 }` into `{ kind: "a"; parsed: number | null }
 * | { kind: "b" }`). The IR shapes erased the literal types tsc
 * discriminated on, so the probe runs against the contextual union's
 * CHECKER members: every literal field must exist on the member
 * (excess-property freshness — tsc already enforced it), every arm field
 * missing from the literal must be optional-flavored (an undefined-armed
 * union, or a dyn slot — the absent-completion rule), and each present
 * field's LITERAL type must fit the member's field type — literal against
 * literal decides by VALUE (the discriminant), everything else by the
 * widened IR pair under the width-lift relation. Exactly ONE fitting arm
 * answers it; zero or several answer null and the caller keeps its
 * fences. Plain property-assignment/shorthand literals only — spreads,
 * accessors, methods, and unfoldable computed keys keep their own paths. */
function literalUnionArmOf(
lowerer: Lowerer,
expr: ts.ObjectLiteralExpression,
tsType: ts.Type,
recordArms: (IrType & { kind: "record" })[],
): (IrType & { kind: "record" }) | null {
if (!tsType.isUnionType()) return null;
const props: { name: string; node: ts.Expression }[] = [];
for (const p of expr.properties) {
  if (ts.isPropertyAssignment(p) && !ts.isComputedPropertyName(p.name)) {
    props.push({ name: propNameText(lowerer, p.name), node: p.initializer });
  } else if (ts.isShorthandPropertyAssignment(p) && ts.isIdentifier(p.name)) {
    props.push({ name: p.name.text, node: p.name });
  } else {
    return null;
  }
}
/** litT fits ftT: unions per arm; literal-vs-literal by value; unit
 * types only into their own unit; otherwise the widened IR pair must be
 * equal or width-liftable. */
const fits = (litT: ts.Type, ftT: ts.Type): boolean => {
  if (ftT.isUnionType()) return ts.constituentTypes(ftT).some((a) => fits(litT, a));
  if (ftT.isStringLiteralType()) return litT.isStringLiteralType() && litT.value === ftT.value;
  if (ftT.isNumberLiteralType()) return litT.isNumberLiteralType() && litT.value === ftT.value;
  if (ftT.flags & ts.TypeFlags.BooleanLiteral) {
    return (litT.flags & ts.TypeFlags.BooleanLiteral) !== 0 && lowerer.checker.typeToString(litT) === lowerer.checker.typeToString(ftT);
  }
  if (ftT.flags & ts.TypeFlags.Null) return (litT.flags & ts.TypeFlags.Null) !== 0;
  if (ftT.flags & ts.TypeFlags.Undefined) return (litT.flags & ts.TypeFlags.Undefined) !== 0;
  if (litT.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)) return false;
  const li = lowerer.mapTypeOf(lowerer.checker.getBaseTypeOfLiteralType(litT));
  const fi = lowerer.mapTypeOf(ftT);
  if (!li || !fi) return false;
  return typeEquals(li, fi) || lowerer.widthLiftPlan(li, fi) !== null;
};
const armShapeIds = new Set(recordArms.map((a) => a.shapeId));
const candidates = new Set<string>();
for (const member of ts.constituentTypes(tsType)) {
  const mMapped = lowerer.mapTypeOf(member);
  if (mMapped?.kind !== "record" || !armShapeIds.has(mMapped.shapeId) || candidates.has(mMapped.shapeId)) continue;
  const shape = lowerer.shapes.get(mMapped.shapeId);
  if (!shape || shape.tuple || shape.indexValue) continue;
  // Excess-property freshness: every literal field must exist on the
  // member (tsc rejected the others for a fresh literal).
  if (!props.every((p) => lowerer.checker.getPropertyOfType(member, p.name) !== undefined)) continue;
  // Arm fields the literal leaves unset must be optional-flavored (the
  // absent-completion rule: an undefined-armed union or a dyn slot).
  const names = new Set(props.map((p) => p.name));
  const absentOk = shape.fields.every((f) => {
    if (names.has(f.name)) return true;
    if (f.type.kind === "dyn") return true;
    if (f.type.kind !== "union") return false;
    return lowerer.unions.get(f.type.unionId)?.arms.some((a) => a.kind === "undefinedT") ?? false;
  });
  if (!absentOk) continue;
  const fieldsFit = props.every((p) => {
    const sym = lowerer.checker.getPropertyOfType(member, p.name);
    if (!sym) return false;
    return fits(lowerer.typeOf(p.node), lowerer.checker.getTypeOfSymbol(sym));
  });
  if (fieldsFit) candidates.add(mMapped.shapeId);
}
if (candidates.size !== 1) return null;
const [only] = candidates;
return recordArms.find((a) => a.shapeId === only) ?? null;
}

/** Object spread treats nullish sources as empty. Preserve evaluation once,
 * then turn `Record<K, V> | undefined` into either that record or a fresh
 * empty record of the same represented shape. */
function lowerOptionalIndexSpreadSource(lowerer: Lowerer, source: IrExpr, loc: SrcLoc): IrExpr | null {
if (source.type.kind !== "union") return null;
const def = lowerer.unions.get(source.type.unionId);
if (!def || def.arms.length !== 2) return null;
const undefinedTag = def.arms.findIndex((arm) => arm.kind === "undefinedT");
const recordTag = def.arms.findIndex((arm) => arm.kind === "record");
if (undefinedTag < 0 || recordTag < 0) return null;
const recordType = def.arms[recordTag]!;
if (recordType.kind !== "record") return null;

const prefix: IrStmt[] = [];
let stable = source;
if (!isSafeToRepeat(source)) {
  const local = lowerer.declareHiddenLocal("%spread", source.type);
  prefix.push({ kind: "varDecl", localId: local.id, init: source, loc });
  stable = varRef(local.id, source.type, loc);
}
const selected: IrExpr = {
  kind: "ternary",
  cond: { kind: "unionIsTag", unionId: source.type.unionId, tag: undefinedTag, negated: false, value: stable, type: BOOL, loc },
  then: { kind: "recordLit", fields: [], type: recordType, loc },
  else_: { kind: "unionNarrow", unionId: source.type.unionId, tag: recordTag, value: stable, type: recordType, loc },
  type: recordType,
  loc,
};
return prefix.length === 0 ? selected : { kind: "seqExpr", stmts: prefix, result: selected, type: recordType, loc };
}

export function lowerObjectLiteral(lowerer: Lowerer, expr: ts.ObjectLiteralExpression): IrExpr {
  const loc = locOf(expr);
  // The RUNTIME-KEYED literal (JS): a computed key that doesn't fold to a
  // compile-time string means the literal's shape is not a compile-time
  // fact — no record shape can hold it. The whole literal builds as a dyn
  // object instead (`{ [field]: criteria, actual: 0, ... }` —
  // test/common's _mustCallInner context), where keys are runtime string
  // values. TypeScript keeps the record world and its fence: this shape
  // only arises in checked-dynamic JS.
  if (
    isJsSourceFile(expr.getSourceFile()) &&
    expr.properties.some(
      (p) => {
        const n = ts.isSpreadAssignment(p) ? undefined : p.name;
        return n !== undefined && ts.isComputedPropertyName(n) && literalComputedKey(lowerer, n) === null;
      },
    )
  ) {
    return lowerDynObjectLiteral(lowerer, expr);
  }
  // Syntax fence FIRST: unsupported member forms get their specific
  // message even when they also make the literal's type unmappable
  // (a getter or a `this`-returning method would otherwise surface as an
  // opaque type fence on the whole literal).
  for (const prop of expr.properties) {
    if (ts.isSpreadAssignment(prop)) {
      // Supported shapes: FULL spreads of known record shapes read as
      // identifiers or other side-effect-free reads, all BEFORE any
      // explicit property (the field-copy desugar reads spread fields
      // first, exactly JS's eager copy order); and CONDITIONAL spreads
      // `...(c ? {k: v} : {})` — the optional-field idiom tsc types as
      // `k?: ...` — which desugar to one conditional field at the
      // spread's own position (any position: they introduce one fresh
      // name, collision-fenced below). Everything else stays fenced.
      const cs = conditionalSpreadOf(prop.expression);
      if (cs === "unsupported" || (cs && cs.props.length !== 1)) {
        lowerer.unsupported(
          "SC1090",
          prop,
          "conditional spreads beyond `...(c ? { field: v } : {})` (exactly one property against an empty arm — spell other shapes as optional fields)",
        );
      }
      // Spread ORDER is fenced in the field-by-field desugar below, not
      // here: the index-signature merge path supports any order (keyed
      // last-write-wins writes), so `{ K: v, ...extra }` into a pure
      // Record shape compiles — the buildServiceEnv pattern.
      continue;
    }
    if (ts.isGetAccessorDeclaration(prop) || ts.isSetAccessorDeclaration(prop)) {
      // JavaScript CJS-export tables reach reads through the lifted-
      // accessor path (cjsExportAccessorRead) — the literal VALUE
      // narrows to its plain fields below (accessor names are not
      // record storage; SEMANTICS.md documents the enumeration
      // divergence). TypeScript accessors lower into the shape's
      // reserved closure slots (%get:/%set: — see accessorSlotProp);
      // `this` in the body is fenced up front: the closure slot has no
      // receiver (capturing the record under construction would be an
      // RC cycle), and the generic lexical-this walk would silently
      // capture an ENCLOSING method's `this` — the object-method rule.
      if (!isJsSourceFile(expr.getSourceFile())) {
        rejectThisInObjectAccessor(lowerer, prop.body ?? prop);
      }
    }
    // Unfoldable computed keys are NOT fenced here: an index-signature
    // target lowers them as runtime keyed writes (the merge path below);
    // every other target re-fences them after the merge path declined
    // (fenceUnfoldableComputedKeys).
    // Identifier keys, STRING-LITERAL keys (`"content-type": v` —
    // record field names are data, never C identifiers; the mangler
    // encodes what C can't spell), NUMERIC-LITERAL keys in their
    // canonical string spelling (`{ 0: v }` stores "0", `{ 0x10: v }`
    // stores "16" — JS's ToPropertyKey; the checker names the property
    // symbol the same way), and FOLDABLE computed keys (above).
    if (
      !prop.name ||
      !(
        ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) ||
        ts.isNumericLiteral(prop.name) || ts.isComputedPropertyName(prop.name)
      )
    ) {
      lowerer.unsupported("SC1090", prop, "non-identifier property names");
    }
    // Shorthand methods are just closure-valued fields — but their `this`
    // is dynamically bound (typed as the literal by tsc, so noImplicitThis
    // lets it through) and records don't model it; the generic
    // lexical-this walk would silently capture an ENCLOSING method's
    // `this`, so any `this` in the body is rejected up front.
    if (ts.isMethodDeclaration(prop)) lowerer.rejectThisInObjectMethod(prop.body ?? prop);
  }

  let tsType = lowerer.checker.getContextualType(expr) ?? lowerer.typeOf(expr);
  // `lit satisfies T` is TYPE-LEVEL only: the expression's checker type —
  // and therefore the shape every downstream consumer sees — is the
  // literal's OWN type (T still contextually types members, so inferred
  // parameter types flow). Building at T would reshape the value tsc
  // says has the literal's type: `{...} satisfies Movable &
  // Record<string, unknown>` must NOT become an index-signature record.
  // Own type wins whenever it maps to a record; an unmappable own type
  // keeps the contextual fallback (a bare-null field whose satisfies
  // target names the wider slot type).
  {
    let p: ts.Node = expr.parent;
    while (ts.isParenthesizedExpression(p)) p = p.parent;
    if (ts.isSatisfiesExpression(p)) {
      const own = lowerer.typeOf(expr);
      if (lowerer.mapTypeOf(own)?.kind === "record") tsType = own;
    }
  }
  // An async function's return position types the literal
  // `T | PromiseLike<T>` (the lib's await-unwrapping contract). The
  // PromiseLike arm never maps, and the record the return slot actually
  // holds is exactly the checker's awaited type — strip to it BEFORE the
  // own-type fallback below: the awaited contextual type carries the
  // slot's field types (`lanIp: string | null`), which the literal's own
  // type narrows away (a field written as `lanIp: null` types as bare
  // `null`, which maps to nothing on its own).
  if (tsType.isUnionType() && ts.constituentTypes(tsType).some((t) => t.getSymbol()?.name === "PromiseLike")) {
    tsType = lowerer.checker.getAwaitedType(tsType) ?? tsType;
  }
  let mapped = lowerer.mapTypeOf(tsType);
  // A JavaScript call can contextually type an object literal as string even
  // though the literal itself is a record. Keep its own shape so a caller
  // performing ToString can convert it after the value is built.
  if (mapped?.kind === "string" && isJsSourceFile(expr.getSourceFile())) {
    const own = lowerer.mapTypeOf(lowerer.typeOf(expr));
    if (own?.kind === "record") mapped = own;
  }
  // An EMPTY-record context under a NON-empty literal (`Object.keys({
  // ...process.env })` — the lib's `{}`-typed parameters admit every
  // object): `{}` carries no shape information, so the literal builds as
  // its OWN type, exactly the unmappable-context fallback below. An
  // empty LITERAL keeps the context (the shapes agree).
  if (mapped?.kind === "record" && expr.properties.length > 0) {
    const ctxShape = lowerer.shapes.get(mapped.shapeId);
    if (ctxShape && ctxShape.fields.length === 0 && !ctxShape.indexValue && !ctxShape.tuple) {
      mapped = lowerer.mapTypeOf(lowerer.typeOf(expr)) ?? mapped;
    }
  }
  // A literal with a property the contextual TYPE ITSELF lacks — only
  // reachable through type assertions and satisfies (fresh-literal
  // excess-property checks reject the direct spelling): the context
  // cannot hold the value, so the literal builds at its OWN type and the
  // slot's width coercion narrows it (divergence 36's copy stance — the
  // extra fields drop in the copy). The probe is against the CHECKER's
  // contextual type, not the mapped shape: a property the contextual
  // type carries but the shape dropped (settled value/reason,
  // generic-callable members) belongs to the drop paths below, and
  // index-signature contexts keep every key (overflow capture).
  if (mapped?.kind === "record" && expr.properties.length > 0) {
    const ctxShape = lowerer.shapes.get(mapped.shapeId);
    if (ctxShape && !ctxShape.indexValue && !ctxShape.tuple) {
      const names = new Set(ctxShape.fields.map((f) => f.name));
      const ctxHasProp = (name: string): boolean => {
        const members = tsType.isUnionType() ? ts.constituentTypes(tsType) : [tsType];
        return members.some((m) => lowerer.checker.getPropertyOfType(m, name) !== undefined);
      };
      const extraOf = (text: string): boolean => !names.has(text) && !ctxHasProp(text);
      const extra = expr.properties.some((p) => {
        if (ts.isSpreadAssignment(p) || !p.name) return false;
        if (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) return extraOf(p.name.text);
        if (ts.isNumericLiteral(p.name)) return extraOf(String(Number(p.name.text)));
        return false; // computed keys keep their existing paths
      });
      if (extra) mapped = lowerer.mapTypeOf(lowerer.typeOf(expr)) ?? mapped;
    }
  }
  // A union-typed slot (`const r: Res = { kind: "ok", ... }`) contextually
  // types the literal as the WHOLE union; build the literal as its own
  // (arm) shape and let the slot's coercion wrap it into the union. An
  // unknown-typed slot (`JSON.stringify({ a: 1 })`) likewise. An
  // UNMAPPABLE context falls back the same way — the literal's own type
  // is the plain record the slot coerces. A CLASS-INSTANCE context
  // (`const p: Point = { x, y }` — tsc's structural view of data
  // classes) falls back too: the literal builds as its own record and
  // the slot's width coercion constructs through the trivial
  // parameter-property constructor (recordToClassPlan), or fences with
  // the record-shape story.
  // A jsval-mapped context reaches here only when lowerExpr's island
  // gate DECLINED it (a project-declared typedef that absorbed to the
  // island through checker-`any` field residue): the literal builds at
  // its own type like every unmappable context.
  if (mapped === null || mapped.kind === "union" || mapped.kind === "dyn" || mapped.kind === "object" || mapped.kind === "jsval") {
    const ctxUnion = mapped?.kind === "union" ? mapped : null;
    mapped = lowerer.mapTypeOf(lowerer.typeOf(expr)) ?? mapped;
    // A literal whose own shape re-tags into NO arm of the contextual
    // union, where the union has exactly ONE record arm: build AS that
    // arm — there is no ambiguity (tsc already checked the literal
    // against the union, and the record arm is the only shape it can
    // inhabit), and the arm's field types drive every property's
    // coercion (`{ env: {...spread...}, onCleanup }` against an
    // optional options param — the env value builds by ITS contextual
    // index-signature type and wraps into the arm's `| undefined`
    // field, where the literal's own inferred width would mismatch).
    // Empty literals (`_env = {}` — the fieldless own shape) and
    // literals against PURE index-signature arms (`{ OPENSSL_CONF:
    // candidate }` — keys become overflow entries) are the same rule's
    // simplest cases. The empty-array-in-union rule, record form.
    if (ctxUnion) {
      const def = lowerer.unions.get(ctxUnion.unionId);
      const recordArms = def?.arms.filter((a) => a.kind === "record") ?? [];
      if (recordArms.length === 1) {
        const armShape = lowerer.shapes.get(recordArms[0]!.shapeId);
        if (
          (mapped?.kind !== "record" || mapped.shapeId !== recordArms[0]!.shapeId) &&
          !armShape?.tuple
        ) {
          mapped = recordArms[0]!;
        }
      } else if (recordArms.length > 1) {
        const ownShapeId = mapped?.kind === "record" ? mapped.shapeId : null;
        // SEVERAL record arms (the reducer-action / discriminated-message
        // pattern): the literal's own inferred shape re-tags into no arm
        // — its field types widened per field (`parsed: 1` against
        // `parsed: number | null`), so the IR-level candidate probe is
        // ambiguous (a narrower arm also admits the literal by dropping
        // fields). The LITERAL types tsc checked carry the discriminant
        // the shapes erased: match the literal's fields against each
        // union member's CHECKER types (literal-vs-literal field pairs
        // decide by value — the `kind: "a"` discriminant), and when
        // exactly ONE member fits, build AS that arm — its field types
        // drive every property's coercion, exactly the single-record-arm
        // rule above. Ambiguous literals keep the SC2003 fence.
        if (ownShapeId === null || !recordArms.some((a) => a.shapeId === ownShapeId)) {
          const arm = literalUnionArmOf(lowerer, expr, tsType, recordArms);
          if (arm) mapped = arm;
        }
      }
    }
  }
  // The CJS EXPORT-TABLE literal in VALUE position (JS): importers reach
  // every member through alias plumbing and accessor lifts — the record
  // VALUE exists for the module's own reads (Object.keys, internal
  // member reads), so it keeps exactly the plain fields whose values
  // lower; accessor entries and members with no value representation
  // (rest-param function types) narrow away. SEMANTICS.md documents the
  // enumeration divergence.
  if (
    isJsSourceFile(expr.getSourceFile()) &&
    (!mapped || expr.properties.some((p) => ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p))) &&
    isCjsExportTableLiteral(expr)
  ) {
    const fields: { name: string; value: IrExpr }[] = [];
    for (const prop of expr.properties) {
      if (ts.isGetAccessorDeclaration(prop) || ts.isSetAccessorDeclaration(prop)) continue;
      const propName = ts.isSpreadAssignment(prop) ? undefined : prop.name;
      if (!propName || !(ts.isIdentifier(propName) || ts.isStringLiteral(propName))) continue;
      const name = propName.text;
      let v: IrExpr | null = null;
      if (ts.isShorthandPropertyAssignment(prop)) {
        v = tryLowerExpression(lowerer, propName as ts.Identifier);
      } else if (ts.isPropertyAssignment(prop)) {
        v = tryLowerExpression(lowerer, prop.initializer);
      }
      if (!v || v.type.kind === "void" || v.type.kind === "caught" || v.type.kind === "jsval") continue;
      if (isUnitType(v.type)) continue;
      fields.push({ name, value: v });
    }
    // Canonical (sorted) field order — the shape registry's invariant;
    // the dropped reads are all pure, so reordering loses nothing.
    fields.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const shapeId = lowerer.shapes.intern(fields.map((f) => ({ name: f.name, type: f.value.type })));
    return { kind: "recordLit", fields, type: { kind: "record", shapeId }, loc };
  }
  // The JS declaration fallback, literal-side (the checked-dynamic tree-array rule's
  // object form): a literal whose shape has no static home — an
  // unmappable contextual type over unmappable own fields (the
  // PropertyDescriptorMap argument of Object.defineProperties, nested
  // descriptor records with `any` values) — builds as a dyn OBJECT:
  // each field converts through the usual dyn boundary, and dynamic
  // consumers ride the keyed-dyn paths. TypeScript keeps the fence.
  if ((!mapped || mapped.kind === "dyn") && isJsSourceFile(expr.getSourceFile())) {
    return lowerDynObjectLiteral(lowerer, expr);
  }
  if (!mapped || mapped.kind !== "record") lowerer.badType(expr, tsType);
  let type: IrType = mapped;
  let shape = lowerer.shapes.get(type.shapeId)!;
  // ACCESSOR properties, JS literals only (TS accessors fill the shape's
  // %get:/%set: closure slots below): no record storage exists for them,
  // so the literal's shape NARROWS to its plain fields (reads resolve
  // through the lifted accessors; Object.keys over the value omits
  // accessor names — the documented divergence).
  if (isJsSourceFile(expr.getSourceFile())) {
    const accessorNames = new Set(
      expr.properties
        .filter((p) => ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p))
        .map((p) => (p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : ""))
        .filter((n) => n !== ""),
    );
    if (accessorNames.size > 0) {
      const narrowed = shape.fields.filter((f) => !accessorNames.has(f.name));
      const narrowedId = lowerer.shapes.intern(
        narrowed.map((f) => ({ name: f.name, type: f.type })),
        false,
        shape.indexValue,
      );
      type = { kind: "record", shapeId: narrowedId };
      shape = lowerer.shapes.get(narrowedId)!;
    }
  }
  const fieldTypes = new Map(shape.fields.map((f) => [f.name, f.type]));
  // File-scope JavaScript object bindings live in the checked-dynamic tree
  // to preserve open writes and identity. Build an optional-field literal
  // from its actually written keys so Object.hasOwn can distinguish an
  // omitted property from a present property whose value is undefined.
  const topLevelJsDecl = ts.isVariableDeclaration(expr.parent) &&
    expr.parent.initializer === expr &&
    ts.isVariableStatement(expr.parent.parent.parent) &&
    ts.isSourceFile(expr.parent.parent.parent.parent);
  const assignedProperties = expr.properties.filter(
    (prop): prop is ts.PropertyAssignment | ts.ShorthandPropertyAssignment =>
      ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop),
  );
  if (
    topLevelJsDecl && isJsSourceFile(expr.getSourceFile()) &&
    assignedProperties.length === expr.properties.length
  ) {
    const provided = new Set(assignedProperties.map((prop) => propNameText(lowerer, prop.name)));
    const omittedOptional = shape.fields.some((field) =>
      !provided.has(field.name) && field.type.kind === "union" &&
      lowerer.armTag(field.type.unionId, UNDEFINED_T) >= 0);
    if (omittedOptional) return lowerDynObjectLiteral(lowerer, expr);
  }
  // The clone probe may lower the leading spread before declining (a
  // static `as` cast can make the checker-visible shape match while its
  // erased IR value keeps a wider shape). Reuse that exact value in the
  // ordinary spread path so lowering still happens once.
  let leadingSpreadLowered: IrExpr | null = null;

  // The overwhelmingly common immutable-update form over a record:
  // `{ ...model, changed, other: value }`. The historic lowering expanded
  // the spread into one recordGet per untouched field at EVERY site, then
  // the backends inlined all of those retains and stores into the caller.
  // A 178-field model updated hundreds of times consequently produced a
  // half-million-line LLVM function. Keep the same evaluation/ownership
  // semantics in one compact IR node: source first, explicit overrides in
  // source order, and one backend clone helper per shape.
  //
  // Stay deliberately narrow. Tuple/index/accessor shapes, conditional or
  // multiple spreads, spread-after-explicit order, and shape-changing width
  // copies retain their existing lowering and diagnostics.
  if (
    !isJsSourceFile(expr.getSourceFile()) &&
    !shape.indexValue &&
    !shape.tuple &&
    !shapeHasAccessorSlots(shape) &&
    expr.properties.length >= 2 &&
    ts.isSpreadAssignment(expr.properties[0]!) &&
    !conditionalSpreadOf(expr.properties[0]!.expression) &&
    expr.properties.slice(1).every(
      (p) =>
        (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
        p.name !== undefined &&
        (ts.isIdentifier(p.name) ||
          ts.isStringLiteral(p.name) ||
          ts.isNumericLiteral(p.name) ||
          (ts.isComputedPropertyName(p.name) && literalComputedKey(lowerer, p.name) !== null)),
    )
  ) {
    const spread = expr.properties[0]! as ts.SpreadAssignment;
    const props = expr.properties.slice(1) as (
      | ts.PropertyAssignment
      | ts.ShorthandPropertyAssignment
    )[];
    const names = props.map((p) => propNameText(lowerer, p.name!));
    const unique = new Set(names);
    const sourceType = lowerer.mapTypeOf(lowerer.typeOf(spread.expression));
    if (
      sourceType?.kind === "record" &&
      sourceType.shapeId === type.shapeId &&
      unique.size === names.length &&
      names.every((name) => fieldTypes.has(name))
    ) {
      const source = lowerer.lowerExpr(spread.expression);
      if (source.type.kind === "record" && source.type.shapeId === type.shapeId) {
        const overrides: { name: string; value: IrExpr }[] = [];
        for (let i = 0; i < props.length; i++) {
          const p = props[i]!;
          const name = names[i]!;
          const fieldType = fieldTypes.get(name)!;
          const valueNode = ts.isPropertyAssignment(p) ? p.initializer : p;
          let value = ts.isPropertyAssignment(p)
            ? lowerer.lowerExpr(p.initializer)
            : lowerer.lowerShorthandValue(p);
          value = lowerer.coerceInto(valueNode, value, fieldType);
          if (!typeEquals(value.type, fieldType)) lowerer.badType(valueNode, lowerer.typeOf(valueNode));
          overrides.push({ name, value });
        }
        return { kind: "recordClone", source, overrides, type, loc };
      }
      leadingSpreadLowered = source;
    }
  }

  // A PURE index-signature target with spreads — `{ ...process.env }`,
  // `{ ...process.env, ...extraEnv }`, `{ ...env, PATH: p }` (the
  // spawn-env pattern): the field-by-field desugar below cannot
  // enumerate runtime overflow keys, so the literal lowers as ONE
  // interned merge-helper call — contributors apply in literal order
  // with keyed writes (JS last-write-wins), sources and values evaluate
  // once each in source order (the call's argument order). A CONDITIONAL
  // spread `...(c ? { k: v } : {})` contributes its one key as a ternary
  // — cond once, v lazily, the empty arm holding the value slot's
  // undefined arm (the explicit-undefined-is-absent stance: JSON and
  // child-env builders drop it, exactly Node's absent key); targets
  // with declared fields keep the historic desugar below.
  const isRuntimeComputedKey = (p: ts.ObjectLiteralElementLike): boolean =>
    !ts.isSpreadAssignment(p) &&
    p.name !== undefined &&
    ts.isComputedPropertyName(p.name) &&
    literalComputedKey(lowerer, p.name) === null;
  if (
    shape.indexValue &&
    shape.fields.length === 0 &&
    !shape.tuple &&
    (expr.properties.some((p) => ts.isSpreadAssignment(p)) || expr.properties.some(isRuntimeComputedKey))
  ) {
    const contributors: IndexMergeContributor[] = [];
    let mergeable = true;
    for (const prop of expr.properties) {
      if (ts.isSpreadAssignment(prop)) {
        const cs = conditionalSpreadOf(prop.expression);
        if (cs === "unsupported" || (cs && cs.props.length !== 1)) {
          lowerer.unsupported(
            "SC1090",
            prop,
            "conditional spreads beyond `...(c ? { field: v } : {})` (exactly one property against an empty arm)",
          );
        }
        if (cs) {
          const absent = lowerer.wrappedUndefined(shape.indexValue, locOf(prop));
          if (!absent) {
            lowerer.unsupported(
              "SC1090",
              prop,
              `conditional spreads into '${lowerer.fmt(shape.indexValue)}'-valued index-signature keys (the empty arm needs an undefined arm to hold — write the key in an if statement instead)`,
            );
          }
          const csProp = cs.props[0]!;
          const cond = lowerer.lowerCondition(cs.cond);
          const vNode: ts.Node = ts.isPropertyAssignment(csProp) ? csProp.initializer : csProp;
          const v = lowerer.intoIndexValueSlot(
            ts.isPropertyAssignment(csProp) ? lowerer.lowerExpr(csProp.initializer) : lowerer.lowerShorthandValue(csProp),
            shape.indexValue,
            vNode,
          );
          contributors.push({
            kind: "field",
            name: csProp.name.text,
            value: {
              kind: "ternary",
              cond,
              then: cs.whenTrue ? v : absent,
              else_: cs.whenTrue ? absent : v,
              type: shape.indexValue,
              loc: locOf(prop),
            },
          });
          continue;
        }
        let src = lowerer.lowerExpr(prop.expression);
        src = lowerOptionalIndexSpreadSource(lowerer, src, locOf(prop)) ?? src;
        if (src.type.kind !== "record") {
          lowerer.unsupported(
            "SC1090",
            prop,
            `object spread of '${lowerer.fmt(src.type)}' sources into an index-signature shape (only index-signature records merge — ${NARROW_FIRST})`,
          );
        }
        fenceAccessorSpreadSource(lowerer, prop, lowerer.shapes.get(src.type.shapeId));
        contributors.push({ kind: "spread", shapeId: src.type.shapeId, value: src });
        continue;
      }
      if (
        (ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop)) &&
        prop.name &&
        (ts.isIdentifier(prop.name) ||
          ts.isStringLiteral(prop.name) ||
          ts.isNumericLiteral(prop.name) ||
          (ts.isComputedPropertyName(prop.name) && literalComputedKey(lowerer, prop.name) !== null))
      ) {
        const value = ts.isPropertyAssignment(prop)
          ? lowerer.intoIndexValueSlot(lowerer.lowerExpr(prop.initializer), shape.indexValue, prop.initializer)
          : lowerer.intoIndexValueSlot(lowerer.lowerShorthandValue(prop), shape.indexValue, prop);
        contributors.push({ kind: "field", name: propNameText(lowerer, prop.name), value });
        continue;
      }
      // A RUNTIME-keyed property (`{ ...m, ["a" + "b"]: "" }`, `{ [K]:
      // v }` where K is a runtime string): the key evaluates before its
      // value (JS's per-property order — both are helper arguments) and
      // writes through the signature exactly like a spread's keys.
      // Number/boolean/unknown keys stringify (ToPropertyKey).
      if (ts.isPropertyAssignment(prop) && ts.isComputedPropertyName(prop.name)) {
        let k = lowerer.lowerExpr(prop.name.expression);
        if (k.type.kind === "f64" || k.type.kind === "bool" || k.type.kind === "dyn") {
          k = { kind: "toString", operand: k, type: STRING, loc: locOf(prop.name) };
        }
        if (k.type.kind !== "string") {
          lowerer.unsupported(
            "SC1090",
            prop.name,
            `'${lowerer.fmt(k.type)}'-typed computed property keys (string, number, boolean, and unknown keys stringify)`,
          );
        }
        const value = lowerer.intoIndexValueSlot(lowerer.lowerExpr(prop.initializer), shape.indexValue, prop.initializer);
        contributors.push({ kind: "keyedField", key: k, value });
        continue;
      }
      mergeable = false;
      break;
    }
    if (mergeable) {
      const helper = lowerIndexMergeHelper(lowerer, type.shapeId, contributors, loc);
      if (helper === null) {
        lowerer.unsupported(
          "SC1090",
          expr,
          `object spread into '${lowerer.fmt(type)}' from these source shapes (spread sources must be index-signature records whose value type is, or lifts into, the target's)`,
        );
      }
      return {
        kind: "call",
        callee: helper,
        args: contributors.flatMap((c) => (c.kind === "keyedField" ? [c.key, c.value] : [c.value])),
        type,
        loc,
      };
    }
  }
  // Unfoldable computed keys outside the index-signature merge path:
  // no record shape can hold a runtime-decided name.
  for (const prop of expr.properties) {
    if (isRuntimeComputedKey(prop)) {
      lowerer.unsupported("SC1090", (prop as ts.PropertyAssignment).name, "computed property keys (compile-time-known keys fold — a pure expression whose checker type is one string or number literal: consts, enum members, quoted keys, templates of those — `{ [MARKER]: v }`; runtime string keys write through an index-signature target; symbol keys stay out)");
    }
  }

  // A DECLARED-fields target built ENTIRELY from index-signature spreads —
  // `{ ...Object.fromEntries(...), ...Object.fromEntries(...) }` typed
  // AppConfig (the defaults-merge idiom over runtime-keyed sources): the
  // field-by-field desugar cannot enumerate runtime keys, so the literal
  // lowers as ONE interned merge-helper call — sources evaluate once each
  // in source order (the call's argument order — computed sources
  // included, no re-read), contributors apply in order with per-key
  // dispatch onto the declared fields (JS last-write-wins). Divergence 68
  // has the runtime rules (validated collisions, extra keys dropped).
  if (
    !shape.indexValue &&
    !shape.tuple &&
    shape.fields.length > 0 &&
    expr.properties.length > 0 &&
    expr.properties.every((p) => ts.isSpreadAssignment(p) && !conditionalSpreadOf(p.expression)) &&
    expr.properties.some((p) => {
      const t = lowerer.mapTypeOf(lowerer.typeOf((p as ts.SpreadAssignment).expression));
      return t?.kind === "record" && !!lowerer.shapes.get(t.shapeId)?.indexValue;
    })
  ) {
    return lowerDeclaredSpreadMerge(lowerer, expr, type, shape, loc);
  }

  const shapeMismatch = (node: ts.Node): never => {
    const own = lowerer.mapTypeOf(lowerer.typeOf(expr));
    lowerer.pushDiag(
      recordShapeMismatchDiag(
        lowerer.fmt(type),
        own ? lowerer.fmt(own) : lowerer.checker.typeToString(lowerer.typeOf(expr)),
        locOf(node),
        own?.kind === "record" && type.kind === "record"
          ? (lowerer.describeRecordWidthBlocker(own.shapeId, type.shapeId) ?? undefined)
          : undefined,
      ),
    );
    throw new PoisonError();
  };

  const fields: { name: string; value: IrExpr; overflow?: true; drop?: true }[] = [];
  // Field names introduced by conditional spreads: their ternary carries
  // the spread's whole evaluation (cond once, value lazily), so a LATER
  // contributor overriding one would silently drop that evaluation —
  // collisions fence in both directions.
  const conditionalNames = new Set<string>();
  // Member names DROPPED from the shape (JS deferral — unlowerable pure
  // member reads narrow away; see the catch in the property loop).
  const droppedNames = new Set<string>();
  for (const prop of expr.properties) {
    if (ts.isSpreadAssignment(prop)) {
      const cs = conditionalSpreadOf(prop.expression);
      if (cs && cs !== "unsupported") {
        // `...(c ? { k: v } : {})` — ONE conditional field at the
        // spread's own position: cond evaluates exactly once, `v` only
        // when the non-empty arm is taken (ternary arms are lazy), and
        // the empty arm holds the interned undefined arm — exactly the
        // omitted-optional-field representation, which is also why the
        // target field must be optional (tsc types the idiom that way).
        const csProp = cs.props[0]!; // single-prop-checked in the fence pass
        const name = csProp.name.text;
        const fieldType = fieldTypes.get(name);
        if (!fieldType) {
          if (shape.indexValue) {
            lowerer.unsupported(
              "SC1090",
              prop,
              "conditional spreads into index-signature keys (overflow entries model presence — write the key in an if statement instead)",
            );
          }
          throw shapeMismatch(prop);
        }
        const absent = lowerer.wrappedUndefined(fieldType, locOf(prop));
        if (!absent) {
          lowerer.unsupported(
            "SC1090",
            prop,
            `conditional spreads onto the required field '${name}' (the empty arm leaves it undefined — declare the field optional)`,
          );
        }
        if (fields.some((f) => f.name === name)) {
          lowerer.unsupported(
            "SC1090",
            prop,
            `conditional spread of '${name}' over an earlier '${name}' (the desugar keeps one entry per name — restructure so each name has one contributor)`,
          );
        }
        const cond = lowerer.lowerCondition(cs.cond);
        const valueNode = ts.isPropertyAssignment(csProp) ? csProp.initializer : csProp;
        let v = ts.isPropertyAssignment(csProp)
          ? lowerer.lowerExpr(csProp.initializer)
          : lowerer.lowerShorthandValue(csProp);
        v = lowerer.coerceInto(valueNode, v, fieldType);
        if (!typeEquals(v.type, fieldType)) lowerer.badType(valueNode, lowerer.typeOf(valueNode));
        conditionalNames.add(name);
        fields.push({
          name,
          value: {
            kind: "ternary",
            cond,
            then: cs.whenTrue ? v : absent,
            else_: cs.whenTrue ? absent : v,
            type: fieldType,
            loc: locOf(prop),
          },
        });
        continue;
      }
      // `{ ...base, ... }` — field-by-field copy of a known record
      // shape. Every source field must land on the target shape with an
      // equal type (a wider source would silently DROP fields JS keeps —
      // the width fence, same as literals). Later contributors override
      // earlier ones (JS last-write-wins; the reads are side-effect-free,
      // so dropping the earlier read is exact). Identifier sources
      // re-read per field (historic path); any OTHER source must be a
      // re-emittable pure read, sharing one lowered node per field.
      // The desugar's one-entry-per-name list reads spread fields
      // EAGERLY at the spread's position, so an explicit property
      // BEFORE a spread would need JS's overwrite — order-fenced (the
      // index-signature merge path above takes any order).
      if (
        expr.properties
          .slice(0, expr.properties.indexOf(prop))
          .some((p) => !ts.isSpreadAssignment(p))
      ) {
        lowerer.unsupported(
          "SC1090",
          prop,
          "object spread after explicit properties (spreads must come first — a later spread would overwrite them with JS semantics the desugar does not model)",
        );
      }
      let srcNode: ts.Expression = prop.expression;
      while (ts.isParenthesizedExpression(srcNode)) srcNode = srcNode.expression;
      const srcLowered =
        prop === expr.properties[0] && leadingSpreadLowered !== null
          ? leadingSpreadLowered
          : ts.isIdentifier(srcNode)
            ? null
            : lowerer.lowerExpr(srcNode);
      const srcType = srcLowered ? srcLowered.type : lowerer.mapTypeOf(lowerer.typeOf(srcNode));
      // `...options.installConfig` — a spread of `Partial<X> | undefined`
      // (the optional-options merge idiom `{ ...DEFAULTS, ...overrides }`):
      // JS spreads nothing for the unit arm and copies present keys
      // otherwise. Per target field the desugar builds
      // `present ? extracted : earlier` — present tests the source's
      // record tag AND (optional source fields) the field's own value
      // arm; absent keeps the earlier contributor's value (both reads
      // are pure, so the reorder into the ternary is unobservable).
      if (srcType?.kind === "union") {
        const def = lowerer.unions.get(srcType.unionId);
        const recArms = def?.arms.filter((a) => a.kind === "record") ?? [];
        if (
          !def ||
          recArms.length !== 1 ||
          !def.arms.every((a) => a.kind === "record" || isUnitType(a))
        ) {
          lowerer.unsupported(
            "SC1090",
            prop,
            `object spread of '${lowerer.fmt(srcType)}' sources (only known record shapes spread — ${NARROW_FIRST})`,
          );
        }
        if (srcLowered && !isSafeToRepeat(srcLowered)) {
          lowerer.unsupported(
            "SC1090",
            prop,
            "object spread of computed sources (the field copies re-read the source — bind it to a const first)",
          );
        }
        const recArm = recArms[0]! as IrType & { kind: "record" };
        const recTag = def.arms.indexOf(recArm);
        // A checked-dynamic VALUE under the union-mapped checker type
        // (a JS dyn-holding binding): the present/absent desugar tests
        // union tags a dyn box does not carry — fence honestly instead
        // of the validator's ICE.
        const probedSrc = srcLowered ?? tryLowerExpression(lowerer, srcNode);
        if (probedSrc?.type.kind === "dyn") {
          lowerer.unsupported(
            "SC1090",
            prop,
            `object spread of a checked-dynamic '${lowerer.fmt(srcType)}' source (${NARROW_FIRST})`,
          );
        }
        const srcShape = lowerer.shapes.get(recArm.shapeId);
        if (!srcShape) throw new InternalCompilerError(`lowerer bug: spread of unknown shape ${recArm.shapeId}`);
        fenceAccessorSpreadSource(lowerer, prop, srcShape);
        if (srcShape.indexValue || shape.indexValue) {
          lowerer.unsupported(
            "SC1090",
            prop,
            "object spread involving index-signature shapes (overflow keys are runtime state — copy the fields you need explicitly)",
          );
        }
        const laterNames = new Set<string>();
        for (const later of expr.properties.slice(expr.properties.indexOf(prop) + 1)) {
          if (ts.isSpreadAssignment(later)) {
            if (conditionalSpreadOf(later.expression)) continue;
            const lt = lowerer.mapTypeOf(lowerer.typeOf(later.expression));
            if (lt?.kind === "record") {
              for (const lf of lowerer.shapes.get(lt.shapeId)?.fields ?? []) laterNames.add(lf.name);
            }
            continue;
          }
          if (
            later.name &&
            (ts.isIdentifier(later.name) ||
              ts.isStringLiteral(later.name) ||
              ts.isNumericLiteral(later.name) ||
              (ts.isComputedPropertyName(later.name) && literalComputedKey(lowerer, later.name) !== null))
          ) {
            laterNames.add(propNameText(lowerer, later.name));
          }
        }
        const srcRef = (): IrExpr => srcLowered ?? lowerer.lowerExpr(srcNode);
        for (const f of srcShape.fields) {
          if (laterNames.has(f.name)) continue;
          const targetType = fieldTypes.get(f.name);
          // No slot on the target shape: the copy DROPS the field
          // (divergence 36's stance, same as the plain-record spread).
          if (!targetType) continue;
          if (conditionalNames.has(f.name)) {
            lowerer.unsupported(
              "SC1090",
              prop,
              `spread of '${f.name}' over an earlier conditional spread (the desugar keeps one entry per name — restructure so each name has one contributor)`,
            );
          }
          const fRead = (): IrExpr => ({
            kind: "recordGet",
            obj: { kind: "unionNarrow", unionId: srcType.unionId, tag: recTag, value: srcRef(), type: recArm, loc: locOf(prop) },
            shapeId: recArm.shapeId,
            field: f.name,
            type: f.type,
            loc: locOf(prop),
          });
          let cond: IrExpr = { kind: "unionIsTag", unionId: srcType.unionId, tag: recTag, negated: false, value: srcRef(), type: BOOL, loc: locOf(prop) };
          let thenVal: IrExpr;
          if (typeEquals(f.type, targetType)) {
            thenVal = fRead();
          } else if (
            f.type.kind === "union" &&
            lowerer.armTag(f.type.unionId, UNDEFINED_T) >= 0 &&
            typeEquals(lowerer.stripUndefinedArm(f.type), targetType)
          ) {
            // Optional source field into a required target slot: present
            // means the source holds the record AND the field its value
            // arm — the spread-override completion, union-source form.
            const ftUndef = lowerer.armTag(f.type.unionId, UNDEFINED_T);
            cond = {
              kind: "logical",
              op: "&&",
              left: cond,
              right: { kind: "unionIsTag", unionId: f.type.unionId, tag: ftUndef, negated: true, value: fRead(), type: BOOL, loc: locOf(prop) },
              type: BOOL,
              loc: locOf(prop),
            };
            const ftDef = lowerer.unions.get(f.type.unionId);
            if (targetType.kind === "union") {
              const retag = lowerer.unionRetagHelper(f.type.unionId, targetType.unionId, locOf(prop));
              if (!retag) {
                lowerer.pushDiag(recordShapeMismatchDiag(lowerer.fmt(type), lowerer.fmt(recArm), locOf(prop), `spread field '${f.name}': '${lowerer.fmt(f.type)}' cannot re-tag into '${lowerer.fmt(targetType)}' behind the present-test`));
                throw new PoisonError();
              }
              thenVal = { kind: "call", callee: retag, args: [fRead()], type: targetType, loc: locOf(prop) };
            } else if (ftDef && ftDef.arms.length === 2 && lowerer.armTag(f.type.unionId, targetType) >= 0) {
              thenVal = { kind: "unionNarrow", unionId: f.type.unionId, tag: lowerer.armTag(f.type.unionId, targetType), value: fRead(), type: targetType, loc: locOf(prop) };
            } else {
              lowerer.pushDiag(recordShapeMismatchDiag(lowerer.fmt(type), lowerer.fmt(recArm), locOf(prop), `spread field '${f.name}': '${lowerer.fmt(f.type)}' cannot narrow into '${lowerer.fmt(targetType)}' behind the present-test`));
              throw new PoisonError();
            }
          } else {
            // The width-lift fallback (arm wrap, re-tag, nested
            // reshape) — the same per-field rule the slot coercion
            // applies. Runs AFTER the optional-completion branch: a
            // present-test has its own semantics a re-tag's stranded
            // undefined trap must not shadow.
            const lift = lowerer.widthLiftPlan(f.type, targetType);
            if (!lift) {
              lowerer.pushDiag(recordShapeMismatchDiag(lowerer.fmt(type), lowerer.fmt(recArm), locOf(prop), `spread field '${f.name}': '${lowerer.fmt(f.type)}' does not lift into '${lowerer.fmt(targetType)}'`));
              throw new PoisonError();
            }
            thenVal = lowerer.applyWidthLift(lift, fRead(), targetType, locOf(prop));
          }
          const at = fields.findIndex((x) => x.name === f.name && !x.drop);
          const elseVal = at >= 0 ? fields[at]!.value : lowerer.wrappedUndefined(targetType, locOf(prop));
          if (!elseVal) {
            lowerer.unsupported(
              "SC1090",
              prop,
              `object spread of '${lowerer.fmt(srcType)}' sources where '${f.name}' has no earlier contributor (the absent arm leaves the required field unset — spread defaults first: { ...defaults, ...overrides })`,
            );
          }
          const merged: IrExpr = { kind: "ternary", cond, then: thenVal, else_: elseVal, type: targetType, loc: locOf(prop) };
          if (at >= 0) fields[at] = { name: f.name, value: merged };
          else fields.push({ name: f.name, value: merged });
        }
        continue;
      }
      if (srcType?.kind !== "record") {
        lowerer.unsupported(
          "SC1090",
          prop,
          `object spread of '${srcType ? lowerer.fmt(srcType) : lowerer.checker.typeToString(lowerer.typeOf(srcNode))}' sources (only known record shapes spread — ${NARROW_FIRST})`,
        );
      }
      if (srcLowered && !isSafeToRepeat(srcLowered)) {
        lowerer.unsupported(
          "SC1090",
          prop,
          "object spread of computed sources (the field copies re-read the source — bind it to a const first)",
        );
      }
      const srcShape = lowerer.shapes.get(srcType.shapeId);
      if (!srcShape) throw new InternalCompilerError(`lowerer bug: spread of unknown shape ${srcType.shapeId}`);
      fenceAccessorSpreadSource(lowerer, prop, srcShape);
      // Index-signature shapes carry runtime-keyed overflow entries the
      // field-by-field desugar cannot enumerate — fenced on either side.
      if (srcShape.indexValue || shape.indexValue) {
        lowerer.unsupported(
          "SC1090",
          prop,
          "object spread involving index-signature shapes (overflow keys are runtime state — copy the fields you need explicitly)",
        );
      }
      // Names a LATER contributor unconditionally defines: copying such a
      // source field is dead under JS last-write-wins (and spread reads
      // are side-effect-free), so it neither lowers nor width-checks —
      // the spread-then-override completion `{ ...config, stateDir }`
      // narrows an optional source field into a required target slot
      // exactly like Node does. Conditional spreads don't count (their
      // empty arm defines nothing) — their own collision fences hold.
      const laterNames = new Set<string>();
      for (const later of expr.properties.slice(expr.properties.indexOf(prop) + 1)) {
        if (ts.isSpreadAssignment(later)) {
          if (conditionalSpreadOf(later.expression)) continue;
          const lt = lowerer.mapTypeOf(lowerer.typeOf(later.expression));
          if (lt?.kind === "record") {
            for (const lf of lowerer.shapes.get(lt.shapeId)?.fields ?? []) laterNames.add(lf.name);
          }
          continue;
        }
        if (
          later.name &&
          (ts.isIdentifier(later.name) ||
            ts.isStringLiteral(later.name) ||
            ts.isNumericLiteral(later.name) ||
            (ts.isComputedPropertyName(later.name) && literalComputedKey(lowerer, later.name) !== null))
        ) {
          laterNames.add(propNameText(lowerer, later.name));
        }
      }
      for (const f of srcShape.fields) {
        if (laterNames.has(f.name)) continue;
        const targetType = fieldTypes.get(f.name);
        // A source field with NO slot on the target shape: the copy
        // DROPS it — a spread of a wider record into a narrower literal
        // is width subtyping in spread clothing, divergence 36's stance
        // (Node's object would keep the key); the read is pure, so
        // skipping evaluates nothing.
        if (!targetType) continue;
        const lift = typeEquals(f.type, targetType)
          ? null
          : lowerer.widthLiftPlan(f.type, targetType);
        if (!typeEquals(f.type, targetType) && !lift) {
          // Print the SOURCE shape, not the literal's own type: the
          // checker's own type already has later overrides applied, so
          // it can render identically to the target while the spread
          // source (the thing that actually mismatches) differs — an
          // invisible difference is a diagnostics bug.
          lowerer.pushDiag(recordShapeMismatchDiag(lowerer.fmt(type), lowerer.fmt(srcType), locOf(prop), `spread field '${f.name}': '${lowerer.fmt(f.type)}' does not lift into '${lowerer.fmt(targetType)}'`));
          throw new PoisonError();
        }
        const obj = srcLowered ?? lowerer.lowerExpr(srcNode);
        // A record-mapped CHECKER type whose VALUE lives in the checked-dynamic tree (a
        // JS file-scope object-literal global): read each field from
        // the checked-dynamic tree (dynKeyGet) and VALIDATE it into the source shape's
        // field type (dynCheck) — the checked-dynamic member-read
        // discipline. A missing key answers the dyn undefined, exactly
        // the undefined-armed optional's absent case; a mismatched
        // runtime value throws the catchable TypeError, never a silent
        // wrong copy. Runtime-ADDED keys drop — width subtyping in
        // spread clothing, divergence 36's stance.
        let value: IrExpr;
        if (obj.type.kind === "dyn") {
          if (!canDynCheckTo(f.type, (id) => lowerer.shapes.get(id), (id) => lowerer.unions.get(id))) {
            lowerer.unsupported(
              "SC1100",
              prop,
              `object spread of a checked-dynamic source whose field '${f.name}' ('${lowerer.fmt(f.type)}') cannot validate out of the checked-dynamic tree (copy the fields explicitly)`,
            );
          }
          value = {
            kind: "dynCheck",
            value: {
              kind: "dynKeyGet",
              key: { kind: "strLit", value: f.name, type: STRING, loc: locOf(prop) },
              value: obj,
              type: DYN,
              loc: locOf(prop),
            },
            type: f.type,
            loc: locOf(prop),
          };
        } else {
          value = {
            kind: "recordGet",
            obj,
            shapeId: srcType.shapeId,
            field: f.name,
            type: f.type,
            loc: locOf(prop),
          };
        }
        // A liftable field widens into the target slot (arm wrap,
        // re-tag, nested reshape) — the same per-field rule the slot
        // coercion applies.
        if (lift) value = lowerer.applyWidthLift(lift, value, targetType, locOf(prop));
        if (conditionalNames.has(f.name)) {
          lowerer.unsupported(
            "SC1090",
            prop,
            `spread of '${f.name}' over an earlier conditional spread (the desugar keeps one entry per name — restructure so each name has one contributor)`,
          );
        }
        const at = fields.findIndex((x) => x.name === f.name);
        if (at >= 0) fields[at] = { name: f.name, value };
        else fields.push({ name: f.name, value });
      }
      continue;
    }
    if (ts.isGetAccessorDeclaration(prop) || ts.isSetAccessorDeclaration(prop)) {
      // JS accessor entries carry no storage (narrowed away above); TS
      // accessors fill the shape's reserved closure slots — the getter
      // body lowers as an ordinary zero-arg closure invoked per property
      // READ, the setter as a one-arg closure invoked per WRITE
      // (fieldGetExpr/fieldSetStmt dispatch on the slots). Creating the
      // closures is side-effect-free, so their position among the data
      // fields' source-order evaluation is unobservable — exactly JS,
      // where accessor definitions evaluate nothing.
      if (isJsSourceFile(expr.getSourceFile())) continue;
      const name = propNameText(lowerer, prop.name); // key-form-checked above
      const slotName = `${ts.isGetAccessorDeclaration(prop) ? "%get" : "%set"}:${name}`;
      const slotT = fieldTypes.get(slotName);
      if (!slotT || slotT.kind !== "func") {
        // The contextual shape stores a DATA value under this name
        // (`const p: { x: number } = { get x() {...} }` — tsc lets a
        // live accessor satisfy a data member): the slot would freeze
        // one getter answer where Node keeps the accessor live.
        if (fieldTypes.has(name)) {
          lowerer.unsupported(
            "SC1090",
            prop,
            `a get/set accessor satisfying the data property '${name}' of '${lowerer.fmt(type)}' (the record slot stores a plain value — Node would keep the accessor live through this type)`,
          );
        }
        throw shapeMismatch(prop);
      }
      const closure = lowerer.coerceInto(prop, lowerer.lowerLambda(prop), slotT);
      if (!typeEquals(closure.type, slotT)) lowerer.badType(prop, lowerer.typeOf(prop));
      fields.push({ name: slotName, value: closure });
      continue;
    }
    const name = propNameText(lowerer, prop.name!); // key-form-checked above
    let fieldType = fieldTypes.get(name);
    // An undeclared name against an index-signature shape is an OVERFLOW
    // entry (tsc typechecked it against the signature's value type);
    // against a plain shape it is the width mismatch it always was —
    // EXCEPT the PromiseSettledResult honest subset's dropped fields
    // (value/reason — SEMANTICS.md 46): those evaluate for effect in
    // their source-order slot and store nothing.
    // A GENERIC-callable member (a generic method `m<T>(x: T) {...}` or a
    // generic arrow/function-expression property): excluded from the
    // record shape (isGenericCallableMemberType — no single closure slot
    // can hold it), so the literal stores nothing for it. Pure
    // function-creating forms skip outright (creating a closure has no
    // side effects; calls resolve statically against this declaration);
    // a computed initializer would need its evaluation kept — fenced.
    if (!fieldType && !ts.isSpreadAssignment(prop)) {
      const memberSym = prop.name && lowerer.checker.getSymbolAtLocation(prop.name);
      const memberT = memberSym ? lowerer.checker.getTypeOfSymbol(memberSym) : undefined;
      if (memberT && isGenericCallableMemberType(memberT, lowerer.checker)) {
        const pureInit = (() => {
          if (ts.isMethodDeclaration(prop)) return true;
          if (ts.isShorthandPropertyAssignment(prop)) return true; // a pure read
          if (!ts.isPropertyAssignment(prop)) return false;
          let init: ts.Expression = prop.initializer;
          while (ts.isParenthesizedExpression(init)) init = init.expression;
          return ts.isArrowFunction(init) || ts.isFunctionExpression(init) || ts.isIdentifier(init);
        })();
        if (!pureInit) {
          lowerer.unsupported(
            "SC1090",
            prop,
            `generic-function-valued properties with computed initializers ('${name}' has no record slot — its evaluation would be dropped; bind the function to a top-level declaration instead)`,
          );
        }
        continue;
      }
    }
    if (!fieldType && !shape.indexValue) {
      if (settledDropNames(lowerer, tsType)?.has(name)) {
        // Identifier and shorthand initializers are effect-free reads —
        // skipped outright. The caught `reason` MUST skip: lowering the
        // read would hit the catch-binding narrowness fence, and the
        // snapshot it names needs no evaluation.
        if (ts.isPropertyAssignment(prop) && !ts.isIdentifier(prop.initializer)) {
          const v = lowerer.lowerExpr(prop.initializer);
          // Effect-free lowerings (literals, plain reads) drop at
          // compile time; anything else — the awaited mapper — runs
          // (and may throw into the enclosing catch) with its result
          // released by the statement frame.
          if (
            v.kind !== "unitLit" && v.kind !== "numLit" && v.kind !== "strLit" &&
            v.kind !== "boolLit" && v.kind !== "varRef" && v.kind !== "closure"
          ) {
            fields.push({ name, value: v, drop: true });
          }
        }
        continue;
      }
      throw shapeMismatch(prop);
    }

    let value: IrExpr;
    let valueNode: ts.Node = prop;
    const propDiagsBefore = lowerer.diags.length;
    try {
    if (ts.isPropertyAssignment(prop)) {
      valueNode = prop.initializer;
      // ARRAY-LITERAL initializers route through the expected-type
      // lowering: a union field with one array-family arm builds the
      // literal AS that arm (lowerExprExpecting's IR-directed rule —
      // the option-table `default: [{ value: [] }]` shape), where the
      // bare lowering would take the JS dyn fallback and fence.
      let init: ts.Expression = prop.initializer;
      while (ts.isParenthesizedExpression(init)) init = init.expression;
      value =
        fenceClosureProbe(lowerer, prop.initializer, fieldType, () => lowerer.lowerExpr(prop.initializer)) ??
        (fieldType !== undefined && ts.isArrayLiteralExpression(init)
          ? lowerer.lowerExprExpecting(prop.initializer, fieldType)
          : lowerer.lowerExpr(prop.initializer));
    } else if (ts.isShorthandPropertyAssignment(prop)) {
      value = lowerer.lowerShorthandValue(prop);
    } else if (ts.isMethodDeclaration(prop)) {
      value =
        fenceClosureProbe(lowerer, prop, fieldType, () => lowerer.lowerLambda(prop)) ?? lowerer.lowerLambda(prop);
    } else {
      lowerer.unsupported("SC1090", prop, `syntax '${ts.SyntaxKind[(prop as ts.Node).kind]}'`);
    }
    } catch (err) {
      // A member VALUE a JS file cannot lower (a namespace object in an
      // export aggregate — the sharedWithCli `errors` member): the
      // member NARROWS AWAY like a CJS export-table accessor entry —
      // the diagnostics defer to the runtime-fence ledger, the shape
      // drops the field, and each READ of it meets its own per-site
      // fence. Pure member forms only (identifier/shorthand reads);
      // TypeScript, probe mode, and ICEs keep the poison.
      const pureMember =
        ts.isShorthandPropertyAssignment(prop) ||
        (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.initializer));
      if (
        !(err instanceof PoisonError) ||
        !pureMember ||
        !isJsSourceFile(expr.getSourceFile()) ||
        lowerer.diagSink !== null ||
        lowerer.diags.length <= propDiagsBefore ||
        lowerer.diags.slice(propDiagsBefore).some((d) => d.code === "SC9001")
      ) {
        throw err;
      }
      lowerer.runtimeFences.push(...lowerer.diags.splice(propDiagsBefore));
      droppedNames.add(name);
      continue;
    }
    if (!fieldType) {
      // Overflow entry: the value flows into the index signature's value
      // slot — dyn slots take a dyn conversion (dynFrom), typed slots the
      // ordinary coercion path. Later duplicates override (map semantics
      // are last-write-wins already; a duplicate literal key is a tsc
      // error anyway).
      const slotted = lowerer.intoIndexValueSlot(value, shape.indexValue!, valueNode);
      fields.push({ name, value: slotted, overflow: true });
      continue;
    }
    const promotedField = fieldType ? lowerer.runtimeOptionalWidening(value.type, fieldType) : null;
    if (promotedField && fieldType) {
      type = lowerer.runtimeOptionalRecordField(type, name, promotedField);
      if (type.kind === "record") shape = lowerer.shapes.get(type.shapeId)!;
      fieldTypes.set(name, promotedField);
      fieldType = promotedField;
    }
    value = lowerer.coerceInto(valueNode, value, fieldType); // union-typed fields wrap arm values
    if (!typeEquals(value.type, fieldType)) lowerer.badType(valueNode, lowerer.typeOf(valueNode));
    // An explicit property overrides a spread-copied field: JS
    // last-write-wins. The entry moves to the END so explicit property
    // values keep their source-order evaluation among themselves. A
    // conditional-spread entry cannot be overridden (its ternary IS the
    // spread's evaluation; splicing it out would drop that).
    if (conditionalNames.has(name)) {
      lowerer.unsupported(
        "SC1090",
        prop,
        `'${name}' after a conditional spread of the same name (the desugar keeps one entry per name — restructure so each name has one contributor)`,
      );
    }
    const at = fields.findIndex((x) => x.name === name);
    if (at >= 0) fields.splice(at, 1);
    fields.push({ name, value });
  }
  // Optional fields (undefined-armed union slots) may be omitted: the
  // absent field holds the interned undefined arm, exactly like writing
  // `a: undefined` (without exactOptionalPropertyTypes tsc treats the two
  // the same, and only optional fields may be omitted — tsc rejects
  // omission of required fields before lowering, undefined-armed or not).
  // A REQUIRED missing field keeps the shape-mismatch rejection (possible
  // through `as`: the cast smuggles a narrower literal past freshness).
  if (droppedNames.size > 0) {
    const narrowed = shape.fields.filter((f) => !droppedNames.has(f.name));
    const narrowedId = lowerer.shapes.intern(
      narrowed.map((f) => ({ name: f.name, type: f.type })),
      false,
      shape.indexValue,
    );
    type = { kind: "record", shapeId: narrowedId };
    shape = lowerer.shapes.get(narrowedId)!;
  }
  if (fields.filter((f) => !f.overflow).length !== shape.fields.length) {
    const provided = new Set(fields.filter((f) => !f.overflow).map((f) => f.name));
    for (const f of shape.fields) {
      if (provided.has(f.name)) continue;
      // 'unknown' fields complete with the dyn undefined — the absent
      // property reads as undefined in Node, and a dyn slot holds
      // exactly that (the options-record call shape against
      // `{ plugins: unknown, ... }` — a JS caller the checker admits).
      const absent = lowerer.wrappedUndefined(f.type, loc) ?? (f.type.kind === "dyn" ? dynUndefinedExpr(loc) : null);
      if (!absent) throw shapeMismatch(expr); // only optional (undefined-armed) and 'unknown' fields may be omitted
      fields.push({ name: f.name, value: absent });
    }
  }
  return { kind: "recordLit", fields, type, loc };
}

/** A conditional spread's carrier property: `name: value` or shorthand,
 * with an identifier/string-literal name. */
export type CondSpreadProp = (ts.PropertyAssignment | ts.ShorthandPropertyAssignment) & { name: ts.Identifier | ts.StringLiteral };

/** Parses the conditional-spread idiom `...(c ? { k: v, ... } : {})`
 * (either orientation). Returns the condition, the non-empty arm's
 * properties, and which arm carries them; "unsupported" for conditional
 * sources OUTSIDE the idiom (both arms non-empty, computed/method
 * members); null when the spread source isn't a conditional at all.
 * Callers slice their own honest subset (the static record path takes
 * exactly one property; the island literal takes any number; spawn's
 * options walk takes a `detached` boolean literal). */
export function conditionalSpreadOf(expr: ts.Expression):
  | { cond: ts.Expression; props: CondSpreadProp[]; whenTrue: boolean }
  | "unsupported"
  | null {
  let e: ts.Expression = expr;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  if (!ts.isConditionalExpression(e)) return null;
  const unwrap = (a: ts.Expression): ts.Expression => {
    let x = a;
    while (ts.isParenthesizedExpression(x)) x = x.expression;
    return x;
  };
  const whenTrue = unwrap(e.whenTrue);
  const whenFalse = unwrap(e.whenFalse);
  if (!ts.isObjectLiteralExpression(whenTrue) || !ts.isObjectLiteralExpression(whenFalse)) {
    return "unsupported";
  }
  const trueCarries = whenFalse.properties.length === 0 && whenTrue.properties.length > 0;
  const falseCarries = whenTrue.properties.length === 0 && whenFalse.properties.length > 0;
  if (!trueCarries && !falseCarries) return "unsupported"; // both empty is tsc-unreachable; both non-empty has no single desugar
  const carrier = trueCarries ? whenTrue : whenFalse;
  const props: CondSpreadProp[] = [];
  for (const p of carrier.properties) {
    if (
      (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
      p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))
    ) {
      props.push(p as CondSpreadProp);
    } else {
      return "unsupported";
    }
  }
  return { cond: e.condition, props, whenTrue: trueCarries };
}

/** `{ ...idx, ...idx2 }` typed a DECLARED shape (no index signature) — the
 * defaults-merge idiom over runtime-keyed sources (`{ ...fromEntries(a),
 * ...fromEntries(b) }` typed AppConfig). Lowers to ONE interned helper
 * call: sources evaluate once each as arguments (source order — computed
 * sources included, JS's evaluate-once), the result starts all-undefined
 * (every target field must be optional — the runtime keys decide
 * presence), and each source's keys apply in JS own-key order with a
 * per-key dispatch onto the declared fields: a matching key writes the
 * field — identity when the source's value slot IS the field type, a
 * validated extraction otherwise (a dyn slot dynChecks; a union slot
 * re-tags arm-by-arm, and a value outside the field's arms throws the
 * catchable TypeError — divergence 34's keyed-write stance, where Node's
 * untyped copy would store the lie) — and a key naming NO declared field
 * is DROPPED (the shape cannot represent it; Node keeps it invisibly —
 * divergence 68). Later contributors overwrite earlier ones
 * (last-write-wins). Sources must be PURE index-signature records. */
function lowerDeclaredSpreadMerge(lowerer: Lowerer, expr: ts.ObjectLiteralExpression,
  type: IrType & { kind: "record" },
  shape: IrRecordShape,
  loc: SrcLoc,): IrExpr {
  interface Src { value: IrExpr; shapeId: string; iv: IrType }
  const srcs: Src[] = [];
  for (const prop of expr.properties) {
    const spread = prop as ts.SpreadAssignment; // caller-checked: all spreads
    const value = lowerer.lowerExpr(spread.expression);
    const srcShape = value.type.kind === "record" ? lowerer.shapes.get(value.type.shapeId) : undefined;
    if (value.type.kind !== "record" || !srcShape?.indexValue || srcShape.tuple || srcShape.fields.length > 0) {
      lowerer.unsupported(
        "SC1090",
        prop,
        `object spread of '${lowerer.fmt(value.type)}' into '${lowerer.fmt(type)}' (only PURE index-signature records — Object.fromEntries results, Record<string, T> values — spread into a declared shape)`,
      );
    }
    srcs.push({ value, shapeId: value.type.shapeId, iv: srcShape.indexValue });
  }
  // Every target field must be optional: absent keys leave the undefined
  // arm, exactly the unset-optional representation.
  for (const f of shape.fields) {
    if (f.type.kind !== "union" || lowerer.armTag(f.type.unionId, UNDEFINED_T) < 0) {
      lowerer.unsupported(
        "SC1090",
        expr,
        `object spread of runtime-keyed sources onto the required field '${f.name}' (the keys decide presence at runtime — declare the field optional or spell it explicitly)`,
      );
    }
  }
  // Per (source value slot → field) conversion, checked up front so the
  // fence fires at the literal, not inside the interned helper.
  const conv = (iv: IrType, f: { name: string; type: IrType }, v: IrExpr): { value: IrExpr } | { stmts: (write: (value: IrExpr) => IrStmt) => IrStmt[] } => {
    if (typeEquals(iv, f.type)) return { value: v };
    if (iv.kind === "dyn") {
      return { value: { kind: "dynCheck", value: v, type: f.type, loc } };
    }
    if (iv.kind === "union" && f.type.kind === "union") {
      const fUnion = f.type;
      const def = lowerer.unions.get(iv.unionId);
      const fDef = lowerer.unions.get(fUnion.unionId);
      if (def && fDef && def.arms.some((a) => lowerer.armTag(fUnion.unionId, a) >= 0)) {
        // Arm-by-arm validated re-tag, inline in the helper: matching
        // arms map by identity (unit arms re-wrap, value arms narrow and
        // wrap); anything else throws the catchable TypeError.
        return {
          stmts: (write) => {
            const chain = (i: number): IrStmt[] => {
              if (i >= def.arms.length) {
                return [{
                  kind: "throw",
                  value: {
                    kind: "libCall",
                    fn: "error.new",
                    args: [{ kind: "strLit", value: `expected ${lowerer.fmt(fUnion)} at $.${f.name}`, type: STRING, loc }],
                    type: { kind: "object", className: "%TypeError" },
                    loc,
                  },
                  loc,
                }];
              }
              const arm = def.arms[i]!;
              const toTag = lowerer.armTag(fUnion.unionId, arm);
              if (toTag < 0) return chain(i + 1);
              const extracted: IrExpr = isUnitType(arm)
                ? { kind: "unionWrap", unionId: fUnion.unionId, tag: toTag, value: { kind: "unitLit", unit: arm.kind === "undefinedT" ? "undefined" : "null", type: arm, loc }, type: fUnion, loc }
                : { kind: "unionWrap", unionId: fUnion.unionId, tag: toTag, value: { kind: "unionNarrow", unionId: iv.unionId, tag: i, value: v, type: arm, loc }, type: fUnion, loc };
              return [{
                kind: "if",
                cond: { kind: "unionIsTag", unionId: iv.unionId, tag: i, negated: false, value: v, type: BOOL, loc },
                then: [write(extracted)],
                else_: chain(i + 1),
                loc,
              }];
            };
            return chain(0);
          },
        };
      }
    }
    lowerer.unsupported(
      "SC1090",
      expr,
      `object spread into '${lowerer.fmt(type)}' where the source's '${lowerer.fmt(iv)}' values cannot reach the '${lowerer.fmt(f.type)}' field '${f.name}' (the value slot must be the field type, 'unknown', or a union covering the field's arms)`,
    );
  };
  const key = `declmerge:${type.shapeId}:${srcs.map((s) => s.shapeId).join(",")}`;
  let helper = lowerer.widthHelpers.get(key);
  if (!helper) {
    helper = `%rec.declmerge.${lowerer.widthHelpers.size}`;

    const outRef = varRef("out.0", type, loc);
    const ksT = arrayOf(STRING);
    const locals: IrLocal[] = [{ id: "out.0", name: "out", type, mutable: false }];
    const params = srcs.map((s, j) => {
      locals.push({ id: `s${j}.0`, name: `s${j}`, type: s.value.type, mutable: true });
      return { localId: `s${j}.0`, name: `s${j}`, type: s.value.type };
    });
    const body: IrStmt[] = [
      {
        kind: "varDecl",
        localId: "out.0",
        init: {
          kind: "recordLit",
          fields: shape.fields.map((f) => ({ name: f.name, value: lowerer.wrappedUndefined(f.type, loc)! })),
          type,
          loc,
        },
        loc,
      },
    ];
    srcs.forEach((s, j) => {
      const sRef = varRef(`s${j}.0`, s.value.type, loc);
      const kRef = varRef(`k${j}.0`, STRING, loc);
      const vRef = varRef(`v${j}.0`, s.iv, loc);
      locals.push(
        { id: `ks${j}.0`, name: `ks${j}`, type: ksT, mutable: false },
        { id: `i${j}.0`, name: `i${j}`, type: F64, mutable: true },
        { id: `k${j}.0`, name: `k${j}`, type: STRING, mutable: false },
        { id: `v${j}.0`, name: `v${j}`, type: s.iv, mutable: false },
      );
      // Per-key dispatch: if (k === "a") { write a } else if ... else drop.
      const dispatch = shape.fields.reduceRight<IrStmt[]>((rest, f) => {
        const write = (value: IrExpr): IrStmt => ({ kind: "recordSet", obj: outRef, shapeId: type.shapeId, field: f.name, value, loc });
        const c = conv(s.iv, f, vRef);
        const thenBody = "value" in c ? [write(c.value)] : c.stmts(write);
        return [{
          kind: "if",
          cond: { kind: "strEq", negated: false, left: kRef, right: { kind: "strLit", value: f.name, type: STRING, loc }, type: BOOL, loc },
          then: thenBody,
          else_: rest.length > 0 ? rest : null,
          loc,
        }];
      }, []);
      body.push(
        { kind: "varDecl", localId: `ks${j}.0`, init: { kind: "recordOvfKeys", obj: sRef, shapeId: s.shapeId, type: ksT, loc }, loc },
        {
          kind: "for",
          init: { kind: "varDecl", localId: `i${j}.0`, init: numLit(0, loc), loc },
          cond: { kind: "bin", op: "<", left: varRef(`i${j}.0`, F64, loc), right: { kind: "arrIntrinsic", method: "length", receiver: varRef(`ks${j}.0`, ksT, loc), args: [], type: F64, loc }, type: BOOL, loc },
          update: { kind: "assign", localId: `i${j}.0`, value: { kind: "bin", op: "+", left: varRef(`i${j}.0`, F64, loc), right: numLit(1, loc), type: F64, loc }, loc },
          body: [
            { kind: "varDecl", localId: `k${j}.0`, init: { kind: "arrayGet", arr: varRef(`ks${j}.0`, ksT, loc), index: varRef(`i${j}.0`, F64, loc), type: STRING, loc }, loc },
            { kind: "varDecl", localId: `v${j}.0`, init: { kind: "recordKeyGet", obj: sRef, shapeId: s.shapeId, key: kRef, overflowOnly: true, type: s.iv, loc }, loc },
            ...dispatch,
          ],
          loc,
        },
      );
    });
    body.push({ kind: "return", value: outRef, loc });
    lowerer.liftedFns.push({
      name: helper,
      params,
      returnType: type,
      locals,
      body,
      loc,
    });
    // Registered only after a fence-free build: a conv() fence mid-build
    // must not leave a phantom helper behind for the next literal.
    lowerer.widthHelpers.set(key, helper);
  }
  return { kind: "call", callee: helper, args: srcs.map((s) => s.value), type, loc };
}

/** The value of a shorthand property (`{ x }`): the binding `x` refers to.
 * The property name's own symbol is the PROPERTY, so resolution goes
 * through getShorthandAssignmentValueSymbol. */
export function lowerShorthandValue(lowerer: Lowerer, prop: ts.ShorthandPropertyAssignment): IrExpr {
  // 7 types the shorthand's name as PropertyName; it is always an
  // Identifier (the grammar allows nothing else in shorthand position).
  const propName = prop.name as ts.Identifier;
  const loc = locOf(propName);
  const symbol = lowerer.checker.getShorthandAssignmentValueSymbol(prop);
  if (symbol) {
    if (lowerer.ctx.selfSymbol === symbol) {
      return { kind: "selfRef", type: lowerer.ctx.selfType!, loc };
    }
    const local = lowerer.resolveKey(symbol, propName);
    if (local) {
      return lowerer.maybeNarrow({ kind: "varRef", localId: local.id, type: local.type, loc }, propName);
    }
    const resolved = symbol.flags & ts.SymbolFlags.Alias ? lowerer.checker.getAliasedSymbol(symbol) : symbol;
    lowerer.flushDeferred(resolved);
    const g = lowerer.globalsBySymbol.get(resolved);
    if (g) {
      return lowerer.maybeNarrow({ kind: "varRef", localId: g.id, type: g.type, loc }, propName);
    }
    const sig = lowerer.fnSigsBySymbol.get(resolved);
    const decl = lowerer.checker.declarationsOf(resolved)[0];
    if (
      sig && decl && ts.isFunctionDeclaration(decl) &&
      (ts.isSourceFile(decl.parent) || lowerer.nsBlocks.get(decl.parent) === "flattened")
    ) {
      lowerer.noteEdge(sig.name);
      const funcType: IrType = {
        kind: "func",
        params: sig.params.filter((p) => p.mode !== "dynRest").map((p) => p.type),
        ret: sig.returnType,
        ...(sig.params.some((p) => p.mode === "dynRest") ? { rest: true as const } : {}),
      };
      lowerer.requireExactArityValue(prop, propName, sig.params, funcType);
      return { kind: "closure", fnName: sig.name, captures: [], type: funcType, loc };
    }
    if (lowerer.genericFnsBySymbol.has(resolved)) {
      lowerer.unsupported(
        "SC1090",
        prop,
        `generic functions as values (call '${propName.text}' directly)`,
      );
    }
  }
  lowerer.rejectUnresolvedSymbol(
    symbol ? (symbol.flags & ts.SymbolFlags.Alias ? lowerer.checker.getAliasedSymbol(symbol) : symbol) : null,
    propName.text,
    prop,
    `the reference to '${propName.text}' (a binding form with no lowering)`,
  );
}

/** Rejects any `this` inside an object-literal method body — including in
 * nested arrows, which inherit the method's `this` (nested function
 * expressions reset it, but their bare `this` is already a tsc error
 * under noImplicitThis, so over-rejecting them here changes nothing). */
export function rejectThisInObjectMethod(lowerer: Lowerer, node: ts.Node): void {
  if (node.kind === ts.SyntaxKind.ThisKeyword) {
    lowerer.unsupported("SC1090", node, "references to 'this' in object literal methods");
  }
  ts.forEachChild(node, (child) => lowerer.rejectThisInObjectMethod(child));
}

/** The accessor twin of rejectThisInObjectMethod: a get/set accessor body
 * referencing `this` (`get x() { return this._x }`). The accessor lowers
 * as a closure stored IN the record — passing the record as a receiver
 * would capture the value under construction (an RC cycle), and the
 * generic lexical-this walk would silently bind an ENCLOSING method's
 * `this`; the fence names the fix (capture a binding instead). */
function rejectThisInObjectAccessor(lowerer: Lowerer, node: ts.Node): void {
  if (node.kind === ts.SyntaxKind.ThisKeyword) {
    lowerer.unsupported(
      "SC1090",
      node,
      "references to 'this' in object literal get/set accessors (the accessor lowers as a captured closure with no receiver — read a captured binding instead)",
    );
  }
  ts.forEachChild(node, (child) => rejectThisInObjectAccessor(lowerer, child));
}
