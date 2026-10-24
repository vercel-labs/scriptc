/* Element reads and writes (`a[i]`, `a[i] = v`), compound element updates, and keyed record reads. */
import * as ts from "../../ts7/adapter.js";
import {
  lowerOptionalIndex,
  splitUndefinedIndex,
  undefinedTypedArrayKeyFence,
} from "../undefined-index.js";
import { type Lowerer, jsFuncNameOf, neverTaintedJsType } from "../lowerer.js";
import {
  BOOL,
  DYN,
  F64,
  type IrExpr,
  type IrRecordShape,
  type IrStmt,
  type IrType,
  NULL_T,
  STRING,
  type SrcLoc,
  UNDEFINED_T,
  VOID,
  canBoxFuncIntoDyn,
  canDynCheckTo,
  isDynTypedRefType,
  isUnitType,
  shapeHasAccessorSlots,
  typeEquals,
} from "../../../ir/ir.js";
import { importMetaField, isImportMeta } from "../import-meta.js";
import { hasOptionalChainGuard, isOptionalChainTail } from "./optional-chains.js";
import { lowerEnumAccess } from "../lower-enums.js";
import { fenceNodeModuleMutation, lowerRequireCacheElement } from "../lower-node-module.js";
import { lowerModuleNamespaceElement } from "../module-namespace-elements.js";
import { type CompoundOp, stdlibGlobalNameOf } from "../surfaces.js";
import { globalSymbolKey } from "./global-symbols.js";
import { isJsSourceFile, locOf } from "../../program.js";
import { lowerGlobalValue } from "../lower-global-value.js";
import { expandoMemberRead } from "../lower-expando.js";
import {
  assertedElementKeepsUndefined,
  compoundUnsupported,
  concatOperand,
  dynCompoundValue,
  hasClassPayload,
  lowerDynMemberAssignment,
  lowerOptionalArrayIndexRead,
  lowerOptionalNumber,
  assertedReadObservesUndefined,
  recordKeyResultOk,
  representedClassFieldTarget,
  runtimeOptionalElementKey,
  symbolFieldTarget,
} from "../lower-exprs.js";
import { hasRuntimeStatics } from "../class-runtime-statics.js";
import { tryLowerExpression } from "./try-lower-expression.js";
import { classFieldTarget, lowerUnionKeyedRead } from "./property-access.js";
import {
  arrayNumberRead,
  arrayValueRead,
  arrayValueStore,
  arrayValueType,
  elementMayBeForeign,
  lowerSafeBytesRead,
  lowerSafeIndexRead,
} from "../array-values.js";
import { lowerOptionalStringIndex, lowerUnionStringIndex } from "../string-index.js";
import { InternalCompilerError } from "../../../errors.js";
import { dynUndefinedExpr, nodeThrowExpr, numLit, strLit, varRef } from "../../../ir/build.js";
import { npmStaticPackageOfPath } from "../../npm-static.js";
import { isSafeToRepeat } from "./evaluation-safety.js";
import { lowerClassPrototypeComputedAssignment } from "../class-prototypes.js";
import { isClassCallback } from "../class-callbacks.js";
import { isKeyedFieldAccess } from "./keyed-field-targets.js";
import { lowerFieldCompoundValue } from "./updates.js";
import { readsHeldEvolvingArray } from "../lower-stmts.js";
import {
  type IndexedArm,
  indexedUnionArms,
  lowerIndexedUnionNumberRead,
  lowerIndexedUnionRead,
  lowerIndexedUnionWrite,
} from "../indexed-unions.js";
import { lowerBufferPrototypeMember } from "../containers/bytes.js";

/** `a[i]` reads. Only f64 indices into array receivers are modeled; JS
 * string-key element access (`a["length"]`) and string indexing (`s[0]`
 * typechecks against the lib's index signature; use .charAt) stay out. */
export function lowerElementAccess(lowerer: Lowerer, expr: ts.ElementAccessExpression): IrExpr {
  if (isImportMeta(expr.expression)) {
    const name = lowerer.foldedStringKeyOf(expr.argumentExpression);
    if (name === null)
      lowerer.unsupported(
        "SC1090",
        expr,
        "import.meta with a runtime-computed key (use a statically-known metadata field)",
      );
    return importMetaField(lowerer, expr, name);
  }

  // `a?.[i]`: the guard lowers as an optional-chain step around the
  // plain element read below.
  if (expr.questionDotToken && !lowerer.chainHandled.has(expr)) {
    return lowerer.lowerOptionalChain(expr);
  }
  // `a?.b[i]` — the tail of a chain whose token sits deeper: the whole
  // tail short-circuits with the guard.
  if (!expr.questionDotToken && isOptionalChainTail(lowerer, expr)) {
    return lowerer.lowerOptionalChain(expr);
  }
  // Enum accesses in element clothing — `E["A"]` forward reads and
  // `E[0]` reverse-mapping reads — fold to constants (lower-enums.ts),
  // claimed before any receiver-kind dispatch can see the enum object.
  {
    const en = lowerEnumAccess(lowerer, expr);
    if (en) return en;
  }
  const bufferMember = lowerBufferPrototypeMember(lowerer, expr);
  if (bufferMember) return bufferMember;
  const cachedModule = lowerRequireCacheElement(lowerer, expr);
  if (cachedModule) return cachedModule;
  const namespaceElement = lowerModuleNamespaceElement(lowerer, expr);
  if (namespaceElement) return namespaceElement;
  // Native Web handles use the same supported surface for bracket and dot
  // spellings. Fence a statically-known unsupported key before the generic
  // checked-dynamic element-read path can turn it into a runtime missing
  // member.
  lowerer.fenceStaticAbortControllerMemberRead(expr);
  lowerer.fenceStaticResponseMember(expr, "read");
  lowerer.fenceStaticHeadersMember(expr, "read");
  lowerer.fenceStaticReadableStreamMember(expr, "read");
  // Computed global reads share the stored global object's custom
  // properties. Symbol keys retain their identity-indexed store.
  if (!expr.questionDotToken && stdlibGlobalNameOf(lowerer, expr.expression) === "globalThis") {
    const symbol = globalSymbolKey(lowerer, expr.expression, expr.argumentExpression);
    if (symbol)
      return {
        kind: "libCall",
        fn: "dyn.globalSymbolGet",
        args: [symbol],
        type: DYN,
        loc: locOf(expr),
      };
    const key = lowerer.lowerExpr(expr.argumentExpression);
    const name: IrExpr =
      key.type.kind === "string"
        ? key
        : {
            kind: "libCall",
            fn: "dyn.toStringCoerce",
            args: [lowerer.coerceInto(expr.argumentExpression, key, DYN)],
            type: STRING,
            loc: locOf(expr),
          };
    return {
      kind: "dynKeyGet",
      value: lowerGlobalValue(lowerer, expr.expression),
      key: name,
      type: DYN,
      loc: locOf(expr),
    };
  }
  // `req.headers["x-name"]` — the computed twin of `req.headers.host`
  // (the server spoke owns both; the envGet precedent).
  {
    const header = lowerer.lowerHttpHeadersElement(expr);
    if (header) return lowerer.maybeNarrow(header, expr);
  }
  // `process.env[expr]` — the computed twin of `process.env.NAME`; both
  // lower to the ONE process.envGet intrinsic. The read narrows like any
  // union-typed expression when the checker narrowed this occurrence.
  if (lowerer.isProcessEnv(expr.expression)) {
    const key = lowerEnvironmentKey(lowerer, expr.argumentExpression);
    if (key.type.kind !== "string") {
      lowerer.unsupported(
        "SC1090",
        expr.argumentExpression,
        "indexing process.env with non-string keys",
      );
    }
    const get: IrExpr = {
      kind: "libCall",
      fn: "process.envGet",
      args: [key],
      type: lowerer.envValueType(),
      loc: locOf(expr),
    };
    return lowerer.maybeNarrow(get, expr);
  }
  // Expando function members in element clothing (`foo[strMem]`,
  // `foo[_private]` where foo is a module-level function/callable const
  // and the key folds or is a unique-symbol const): the member's module
  // global — the dotted read's twin (lower-expando.ts).
  {
    const ex = expandoMemberRead(lowerer, expr);
    if (ex) return lowerer.maybeNarrow(ex, expr);
  }
  // Symbol-keyed property READS (`this[kLimit]`): when the key is a
  // statically-resolvable symbol declared as a field of the receiver's
  // class (classSymbolKeyOf — the countdown.js/OpenTUI idioms), the
  // read IS an ordinary field read of the hidden slot. Every other
  // symbol key stays fenced: record shapes, runtime-identity keys
  // (symbol parameters, reassigned bindings), and keys no class declares
  // — the layouts are compile-time field lists.
  if (lowerer.mapTypeOf(lowerer.typeOf(expr.argumentExpression))?.kind === "symbol") {
    const target = symbolFieldTarget(lowerer, expr);
    if (target) return lowerer.maybeNarrow(lowerer.fieldGetExpr(target, locOf(expr), expr), expr);
    let receiver = lowerer.lowerExpr(expr.expression);
    const classInfo =
      receiver.type.kind === "classval" ? lowerer.classes.get(receiver.type.className) : undefined;
    if (
      receiver.type.kind === "func" ||
      receiver.type.kind === "generator" ||
      ((receiver.type.kind === "array" ||
        receiver.type.kind === "string" ||
        receiver.type.kind === "bytes") &&
        lowerer.dynConvertible(receiver.type)) ||
      (receiver.type.kind === "object" && lowerer.dynConvertible(receiver.type)) ||
      isDynTypedRefType(receiver.type) ||
      (classInfo && (classInfo.callableBase || hasRuntimeStatics(classInfo))) ||
      ((receiver.type.kind === "map" || receiver.type.kind === "set") &&
        lowerer.dynConvertible(receiver.type))
    ) {
      const fnName = jsFuncNameOf(expr.expression);
      receiver = {
        kind: "dynFrom",
        value: receiver,
        type: DYN,
        loc: locOf(expr),
        ...(fnName !== null ? { fnName } : {}),
      };
    }
    if (receiver.type.kind === "dyn") {
      const key = lowerer.lowerExprExpecting(expr.argumentExpression, DYN);
      return lowerer.maybeNarrow(
        { kind: "dynKeyGet", value: receiver, key, type: DYN, loc: locOf(expr) },
        expr,
      );
    }
    lowerer.unsupported(
      "SC1090",
      expr,
      "symbol-keyed property access outside class fields keyed by a stable module-level literal Symbol()/Symbol.for() (other static shapes have no symbol-keyed storage)",
    );
  }
  // A never-tainted JS receiver type (neverTaintedJsType — `cmd[1]` on
  // `const cmd = ['pwd', []]`, whose binding lowered checked-dynamic)
  // dispatches as unmapped so the dyn-receiver branch below reads
  // through the checked-dynamic tree instead of dynChecking into never's f64 residue.
  let receiverIr = neverTaintedJsType(lowerer, expr.expression, lowerer.typeOf(expr.expression))
    ? null
    : lowerer.mapTypeOf(lowerer.typeOf(expr.expression));
  if (isJsSourceFile(ts.getSourceFileOfNode(expr))) {
    const receiver = tryLowerExpression(lowerer, expr.expression);
    if (receiver?.type.kind === "dyn") {
      const key = lowerer.lowerExprExpecting(expr.argumentExpression, DYN);
      const optional = hasOptionalChainGuard(expr.expression, lowerer);
      return lowerer.maybeNarrow(
        {
          kind: "dynKeyGet",
          value: receiver,
          key,
          ...(optional ? { optional: true as const } : {}),
          type: DYN,
          loc: locOf(expr),
        },
        expr,
      );
    }
    if (receiver?.type.kind === "func" && lowerer.dynConvertible(receiver.type)) {
      const loc = locOf(expr);
      const fnName = jsFuncNameOf(expr.expression);
      const boxed: IrExpr = {
        kind: "dynFrom",
        value: receiver,
        type: DYN,
        loc,
        ...(fnName !== null ? { fnName } : {}),
      };
      const key = lowerer.lowerExprExpecting(expr.argumentExpression, DYN);
      return lowerer.maybeNarrow({ kind: "dynKeyGet", key, value: boxed, type: DYN, loc }, expr);
    }
    if (receiver?.type.kind === "array" || receiver?.type.kind === "bytes")
      receiverIr = receiver.type;
    if (receiver?.type.kind === "union") {
      const present = lowerer.stripUndefinedArm(receiver.type);
      if (present.kind === "array" || present.kind === "bytes") receiverIr = present;
    }
  }
  // A readonly tuple union under Array.isArray is checker-typed as an
  // intersection with any[], whose structural mapping is not the tuple
  // shape. maybeNarrow on the receiver uses the runtime tag proof to
  // extract the one array-valued arm; dispatch element access from that
  // lowered representation, like the existing any[] array-method path.
  const checkerArray = lowerer.checkerArrayValue(expr.expression);
  if (checkerArray) receiverIr = checkerArray.type;
  if (receiverIr?.kind === "object") {
    const key =
      recordKeyLiteralText(expr.argumentExpression) ??
      recordKeyTypeLiteralText(lowerer, expr.argumentExpression);
    if (key !== null) {
      const target = classFieldTarget(lowerer, expr.expression, receiverIr, key);
      if (target) return lowerer.maybeNarrow(lowerer.fieldGetExpr(target, locOf(expr), expr), expr);
    }
    if (receiverIr.className === "%Error" || isDynTypedRefType(receiverIr)) {
      const receiver = lowerer.coerceToExpected(lowerer.lowerExpr(expr.expression), DYN);
      const key = lowerer.lowerExprExpecting(expr.argumentExpression, DYN);
      return lowerer.maybeNarrow(
        { kind: "dynKeyGet", value: receiver, key, type: DYN, loc: locOf(expr) },
        expr,
      );
    }
  }

  // An element read of a union of typed arrays and number arrays: each
  // arm's own read, dispatched on the tag (indexed-unions.ts).
  const indexedArms = receiverIr ? indexedUnionArms(lowerer, receiverIr) : null;
  if (indexedArms && receiverIr && !isJsSourceFile(ts.getSourceFileOfNode(expr))) {
    let recv = lowerer.lowerExpr(expr.expression);
    if (recv.type.kind === "dyn") recv = lowerer.coerceInto(expr.expression, recv, receiverIr);
    const arms = indexedUnionArms(lowerer, recv.type);
    if (arms) {
      const index = lowerOptionalNumber(
        lowerer,
        lowerer.lowerExpr(expr.argumentExpression),
        locOf(expr.argumentExpression),
        expr.argumentExpression,
      );
      if (index.type.kind !== "f64")
        lowerer.unsupported("SC1090", expr.argumentExpression, "indexing with non-number keys");
      if (
        (ts.isNonNullExpression(expr.parent) && expr.parent.expression === expr) ||
        lowerer.nanCodedReads?.isNumericRead(expr) === true
      )
        return lowerIndexedUnionNumberRead(lowerer, recv, arms, index, locOf(expr));
      return lowerIndexedUnionRead(lowerer, recv, arms, index, locOf(expr));
    }
  }

  // Typed-array element read `b[i]` — like arrayGet with a scalar
  // result; any invalid index traps (the array discipline; JS would
  // read undefined — divergence 4's policy).
  if (receiverIr?.kind === "bytes") {
    let recv = lowerer.lowerExpr(expr.expression);
    if (recv.type.kind === "dyn") recv = lowerer.coerceInto(expr.expression, recv, receiverIr);
    if (recv.type.kind === "union" && lowerer.armTag(recv.type.unionId, UNDEFINED_T) >= 0) {
      const present = lowerer.stripUndefinedArm(recv.type);
      const helper =
        present.kind === "bytes"
          ? lowerer.narrowedArmHelper(recv.type.unionId, present, locOf(expr.expression))
          : null;
      recv = helper
        ? lowerer.checkedNarrowCall(helper, recv, present, locOf(expr.expression))
        : lowerer.maybeNarrow(recv, expr.expression);
    }

    const index = lowerOptionalNumber(
      lowerer,
      lowerer.lowerExpr(expr.argumentExpression),
      locOf(expr.argumentExpression),
      expr.argumentExpression,
    );
    if (isJsSourceFile(ts.getSourceFileOfNode(expr)) && recv.type.kind === "bytes") {
      return {
        kind: "dynKeyGet",
        value: lowerer.coerceInto(expr.expression, recv, DYN),
        key:
          index.type.kind === "f64"
            ? { kind: "toString", operand: index, type: STRING, loc: locOf(expr) }
            : index,
        type: DYN,
        loc: locOf(expr),
      };
    }
    if (index.type.kind === "dyn" && recv.type.kind === "bytes") {
      return {
        kind: "dynKeyGet",
        value: lowerer.coerceInto(expr.expression, recv, DYN),
        key: index,
        type: DYN,
        loc: locOf(expr),
      };
    }
    if (index.type.kind !== "f64") {
      lowerer.unsupported("SC1090", expr.argumentExpression, "indexing with non-number keys");
    }
    // `t[i]!` performs no runtime check, but its static type is a number:
    // it takes the numeric element read (NaN when invalid), except where
    // the value reaches a use that tells undefined from NaN (an equality, a
    // string conversion, `typeof`, an array element), which reads undefined
    // for an invalid index like `t[i]`. Every other read answers undefined
    // for an invalid index, like Node.
    // A read whose every consumer treats undefined like NaN (see
    // nan-coded-reads.ts) is the same plain numeric read.
    if (
      (ts.isNonNullExpression(expr.parent) &&
        expr.parent.expression === expr &&
        !assertedReadObservesUndefined(lowerer, expr.parent)) ||
      lowerer.nanCodedReads?.isNumericRead(expr) === true
    ) {
      return {
        kind: "bytesIntrinsic",
        method: "get",
        receiver: recv,
        args: [index],
        type: F64,
        loc: locOf(expr),
        invalidNaN: true,
      };
    }
    return lowerSafeBytesRead(lowerer, recv, index, locOf(expr));
  }
  // Tuple element read `t[0]`: a positional-field read of the tuple's
  // record shape — LITERAL indices only (the checker's per-index types
  // are what make the read honest; a dynamic index over a heterogeneous
  // shape has no single element type). Narrows like any field read.
  if (receiverIr?.kind === "record") {
    const shape = lowerer.shapes.get(receiverIr.shapeId);
    if (shape?.tuple) {
      let obj = lowerer.lowerExpr(expr.expression);

      if (obj.type.kind === "dyn") {
        // Object.entries over a checked value stores each pair in the
        // dynamic tree even when the checker names a tuple type.
        const key = lowerRecordPropertyKey(
          lowerer,
          lowerer.lowerExpr(expr.argumentExpression),
          expr.argumentExpression,
        );
        const optional = hasOptionalChainGuard(expr.expression, lowerer);
        return lowerer.maybeNarrow(
          {
            kind: "dynKeyGet",
            value: obj,
            key,
            ...(optional ? { optional: true as const } : {}),
            type: DYN,
            loc: locOf(expr),
          },
          expr,
        );
      }
      if (obj.type.kind === "union" && lowerer.armTag(obj.type.unionId, UNDEFINED_T) >= 0) {
        // The checker sees the outer `arrays[i]` as a tuple when
        // noUncheckedIndexedAccess is disabled, but the lowered read is
        // still tuple | undefined. A nested tuple field must validate the
        // outer tag before recordGet; an unchecked unionNarrow would let a
        // missing outer element reach the record backend as a bad pointer.
        const present = lowerer.stripUndefinedArm(obj.type);
        const helper =
          present.kind === "record"
            ? lowerer.narrowedArmHelper(obj.type.unionId, present, locOf(expr.expression))
            : null;
        obj = helper
          ? lowerer.checkedNarrowCall(helper, obj, present, locOf(expr.expression))
          : lowerer.maybeNarrow(obj, expr.expression);
      }
      const idx = tupleLiteralIndex(expr.argumentExpression);
      if (idx === null) {
        lowerer.unsupported(
          "SC1090",
          expr.argumentExpression,
          "tuple indexing with a non-literal index (tuples are fixed-shape — use t[0], t[1], ...)",
        );
      }
      const shapeId = obj.type.kind === "record" ? obj.type.shapeId : receiverIr.shapeId;
      const actualShape = lowerer.shapes.get(shapeId) ?? shape;
      const fieldType = actualShape.fields.find((f) => f.name === String(idx))?.type;
      if (fieldType === undefined) lowerer.badType(expr, lowerer.typeOf(expr)); // OOB smuggled past tsc
      const get: IrExpr = {
        kind: "recordGet",
        obj,
        shapeId,
        field: String(idx),
        type: fieldType,
        loc: locOf(expr),
      };
      return lowerer.isRuntimeOptionalField(shapeId, String(idx))
        ? get
        : lowerer.maybeNarrow(get, expr);
    }
    if (shape && !shape.tuple) {
      return lowerer.lowerRecordKeyRead(expr, receiverIr.shapeId, shape);
    }
  }
  // `pkg["k"]` / `scripts[name]` / `scopeMatch[1]` on a dyn receiver (a
  // JSON.parse result): the dyn keyed read, exactly the dot form.
  // NUMBER-typed indices convert through ToString first — JS property
  // keys are strings, and the canonical number text answers array
  // indices in the helper (fractions, negatives, and NaN read as
  // absent keys, exactly JS). An UNMAPPABLE checker type takes the
  // same path when the receiver LOWERS dyn
  // (`pkg.workspaces.packages["0"]` — the lowering world types the
  // unknown-rooted chain `any`); a non-dyn lowering falls through to
  // the fences below (re-lowering is pure IR construction).
  if (receiverIr?.kind === "dyn" || receiverIr?.kind === "union" || receiverIr === null) {
    const obj = lowerer.lowerExpr(expr.expression);
    // A generic mapped type can stay unresolved at this body use even
    // though its instantiated parameter has a concrete record ABI.
    // Dispatch from that stored shape, as the array fallback below does.
    if (receiverIr === null && obj.type.kind === "record") {
      const shape = lowerer.shapes.get(obj.type.shapeId);
      const index = tupleLiteralIndex(expr.argumentExpression);
      const field =
        shape?.tuple && index !== null
          ? shape.fields.find((field) => field.name === String(index))
          : null;
      if (field)
        return lowerer.maybeNarrow(
          {
            kind: "recordGet",
            obj,
            shapeId: obj.type.shapeId,
            field: field.name,
            type: field.type,
            loc: locOf(expr),
          },
          expr,
        );
      if (shape && !shape.tuple) {
        return lowerer.lowerRecordKeyRead(expr, obj.type.shapeId, shape);
      }
    }
    if (
      obj.type.kind === "dyn" ||
      (obj.type.kind === "object" && obj.type.className === "%Error") ||
      isDynTypedRefType(obj.type)
    ) {
      const rawKey = lowerer.lowerExpr(expr.argumentExpression);
      // Number, bool, and DYN keys stringify (ToPropertyKey) — the
      // dyn-keyed read `catchWarning[warning.name]` where the property
      // chain itself lowered dyn.
      const key =
        rawKey.type.kind === "dyn" ||
        rawKey.type.kind === "symbol" ||
        (rawKey.type.kind === "union" && lowerer.dynConvertible(rawKey.type))
          ? lowerer.coerceToExpected(rawKey, DYN)
          : lowerRecordPropertyKey(lowerer, rawKey, expr.argumentExpression);
      if (key.type.kind === "string" || key.type.kind === "dyn") {
        const opt = hasOptionalChainGuard(expr.expression, lowerer);
        return lowerer.maybeNarrow(
          {
            kind: "dynKeyGet",
            key,
            ...(opt ? { optional: true as const } : {}),
            value: lowerer.coerceToExpected(obj, DYN),
            type: DYN,
            loc: locOf(expr),
          },
          expr,
        );
      }
    }
    // A checker-`any` receiver that LOWERS to a static ARRAY
    // (`pm.split("@")[0]` — the dyn-receiver string machinery answers
    // string[]): the element read rides the ordinary array path on the
    // lowered value (invalid indices trap, divergence 4's policy).
    if (obj.type.kind === "array") {
      const index = lowerer.lowerExpr(expr.argumentExpression);
      if (index.type.kind === "f64") {
        const safe = lowerSafeIndexRead(lowerer, obj, index, locOf(expr));
        if (safe) return safe;
        return lowerer.maybeNarrow(
          { kind: "arrayGet", arr: obj, index, type: obj.type.elem, loc: locOf(expr) },
          expr,
        );
      }
    }
  }
  // `env[key]` on a UNION of record shapes (`ProcessEnv | Record<string,
  // string>` — the env-bag parameter pattern): the per-arm keyed read,
  // joined exactly like the dot form (lowerUnionProperty's keyed path).
  if (receiverIr?.kind === "union") {
    const value = lowerer.lowerExpr(expr.expression);
    if (value.type.kind === "union") {
      const key = lowerer.lowerExpr(expr.argumentExpression);
      if (key.type.kind === "f64") {
        const def = lowerer.unions.get(value.type.unionId);
        const presentArms = def?.arms.filter((arm) => !isUnitType(arm)) ?? [];
        if (presentArms.length === 1 && presentArms[0]?.kind === "string") {
          const property = runtimeOptionalElementKey(expr.argumentExpression);
          const receiver =
            property === null
              ? null
              : lowerer.runtimeOptionalPropertyReceiver(expr.expression, value, STRING, property);
          if (receiver !== null) {
            return {
              kind: "strIntrinsic",
              method: "charAt",
              receiver,
              args: [key],
              type: STRING,
              loc: locOf(expr),
            };
          }
        }
      }
      if (key.type.kind === "f64") {
        const safe = lowerOptionalArrayIndexRead(lowerer, expr, value, key);
        if (safe) return safe;
      }
      if (key.type.kind === "string" || key.type.kind === "f64") {
        const lit = ts.isStringLiteral(expr.argumentExpression)
          ? expr.argumentExpression.text
          : null;
        const keyed = lowerUnionKeyedRead(lowerer, expr, value.type.unionId, value, key, lit);
        if (keyed) return lowerer.maybeNarrow(keyed, expr);
      }
    }
  }
  if (receiverIr?.kind !== "array") {
    const receiver = tryLowerExpression(lowerer, expr.expression);
    {
      if (
        receiver?.type.kind === "dyn" ||
        (receiver &&
          isJsSourceFile(ts.getSourceFileOfNode(expr)) &&
          (receiver.type.kind === "union" || receiver.type.kind === "bytes") &&
          lowerer.dynConvertible(receiver.type))
      ) {
        const key = lowerRecordPropertyKey(
          lowerer,
          lowerer.lowerExpr(expr.argumentExpression),
          expr.argumentExpression,
        );
        return lowerer.maybeNarrow(
          {
            kind: "dynKeyGet",
            value: lowerer.coerceInto(expr.expression, receiver, DYN),
            key,
            type: DYN,
            loc: locOf(expr),
          },
          expr,
        );
      }
      if (
        receiver?.type.kind === "func" &&
        canBoxFuncIntoDyn(
          receiver.type,
          (id) => lowerer.shapes.get(id),
          (id) => lowerer.unions.get(id),
        )
      ) {
        const key = lowerRecordPropertyKey(
          lowerer,
          lowerer.lowerExpr(expr.argumentExpression),
          expr.argumentExpression,
        );
        if (key.type.kind === "string") {
          const boxed: IrExpr = {
            kind: "dynFrom",
            value: receiver,
            type: DYN,
            loc: locOf(expr.expression),
          };
          return lowerer.maybeNarrow(
            { kind: "dynKeyGet", key, value: boxed, type: DYN, loc: locOf(expr) },
            expr,
          );
        }
      }
    }
    // A checker-`any` receiver that lowers to a string (an implicit-any
    // package parameter specialized for a string argument) indexes the
    // string the same way.
    if (
      receiverIr?.kind === "string" ||
      (receiverIr === null && receiver?.type.kind === "string")
    ) {
      // An indexed string property is absent for non-integer and missing
      // indexes. charAt has different coercion and out-of-range semantics.
      const recv = lowerer.lowerExpr(expr.expression);
      const rawIndex = lowerer.lowerExpr(expr.argumentExpression);
      // A checked-dynamic index (an untyped JavaScript parameter, a parsed
      // value) reads the property its key names, as JavaScript does: a code
      // unit for an integer index, the length for "length", else undefined.
      // The checker's string type does not describe those results, so the
      // value stays checked-dynamic and consumers convert it.
      if (rawIndex.type.kind === "dyn" && lowerer.dynConvertible(recv.type)) {
        const key = lowerRecordPropertyKey(lowerer, rawIndex, expr.argumentExpression);
        return {
          kind: "dynKeyGet",
          value: lowerer.coerceInto(expr.expression, recv, DYN),
          key,
          type: DYN,
          loc: locOf(expr),
        };
      }
      const index = lowerOptionalNumber(
        lowerer,
        rawIndex,
        locOf(expr.argumentExpression),
        expr.argumentExpression,
      );
      if (index.type.kind === "f64" && recv.type.kind === "string") {
        // A proven in-bounds integer index always names a code unit, where
        // charAt and the property read agree.
        if (lowerer.stringIndexBounds.inBounds(expr))
          return {
            kind: "strIntrinsic",
            method: "charAt",
            receiver: recv,
            args: [index],
            type: STRING,
            loc: locOf(expr),
          };
        return lowerOptionalStringIndex(
          lowerer,
          recv,
          index,
          lowerer.withUndefinedArm(STRING),
          locOf(expr),
        );
      }
      // The checker narrowed the receiver to string, but its stored value
      // is still the union (an array-derived binding, a typeof guard).
      if (index.type.kind === "f64") {
        const read = lowerUnionStringIndex(
          lowerer,
          recv,
          index,
          expr.argumentExpression,
          lowerer.withUndefinedArm(STRING),
          locOf(expr),
        );
        if (read) return read;
      }
      lowerer.unsupported(
        "SC1090",
        expr,
        "string indexing with this index/result shape (expected a number index and a string or string | undefined result)",
      );
    }
    lowerer.unsupported("SC1090", expr, "element access on non-array values");
  }
  let arr = lowerer.lowerExpr(expr.expression);
  const runtimeOptionalSource = lowerer.runtimeOptionalSourceValue(expr.expression, arr);
  if (
    runtimeOptionalSource?.kind === "varRef" &&
    runtimeOptionalSource.type.kind === "union" &&
    arr.type.kind === "array"
  ) {
    // lowerer.lowerElementAccess has already recognized a captured
    // array | undefined receiver and supplied its checked extraction as
    // the expression override. Rebuild that check here so a missing
    // receiver throws the member-access error Node exposes, rather than
    // the generic target-union narrowing error. The stored receiver is a
    // varRef, so both the tag test and extraction read the same value
    // without repeating an effect.
    const stored = runtimeOptionalSource;
    if (stored.type.kind !== "union")
      throw new InternalCompilerError("runtime-optional array source lost its union storage");
    const unionId = stored.type.unionId;
    const undefTag = lowerer.armTag(unionId, UNDEFINED_T);
    const valueTag = lowerer.armTag(unionId, arr.type);
    const property = runtimeOptionalElementKey(expr.argumentExpression);
    if (undefTag >= 0 && valueTag >= 0 && property !== null) {
      arr = {
        kind: "ternary",
        cond: {
          kind: "unionIsTag",
          unionId,
          tag: undefTag,
          negated: false,
          value: stored,
          type: BOOL,
          loc: locOf(expr.expression),
        },
        then: nodeThrowExpr(
          1,
          "",
          `Cannot read properties of undefined (reading '${property}')`,
          arr.type,
          locOf(expr.expression),
        ),
        else_: {
          kind: "unionNarrow",
          unionId,
          tag: valueTag,
          value: stored,
          type: arr.type,
          loc: locOf(expr.expression),
        },
        type: arr.type,
        loc: locOf(expr.expression),
      };
    }
  }
  if (
    arr.type.kind === "union" &&
    lowerer.armTag(arr.type.unionId, UNDEFINED_T) >= 0 &&
    receiverIr.kind === "array"
  ) {
    // As with tuple receivers above, an unchecked outer read can be
    // undefined even when the checker reports an array. Extract the
    // present array arm with a runtime tag check before arrayGet or the
    // safe indexed-read helper runs.
    const present = lowerer.stripUndefinedArm(arr.type);
    const helper =
      present.kind === "array"
        ? lowerer.narrowedArmHelper(arr.type.unionId, present, locOf(expr.expression))
        : null;
    arr = helper
      ? lowerer.checkedNarrowCall(helper, arr, present, locOf(expr.expression))
      : lowerer.maybeNarrow(arr, expr.expression);
  }

  // An alias or container of an evolving array whose reads disagree
  // (`rows[0]` after `const rows = [xs]`) holds elements the checker's type
  // does not list, so its element read stays checked-dynamic.
  const heldEvolving = arr.type.kind === "dyn" && readsHeldEvolvingArray(lowerer, expr.expression);
  // The checker sees an array but the VALUE lowered checked-dynamic (a
  // jsdoc-typed default export from a .js module — signature 14): the
  // read rides the dynCheck boundary when the array shape is one the checked-dynamic tree
  // can validate, and fences by name when it is not — an arrayGet over a
  // dyn receiver is never emitted (the validator ICE).
  if (arr.type.kind === "dyn" && !heldEvolving) {
    if (
      canDynCheckTo(
        receiverIr,
        (id) => lowerer.shapes.get(id),
        (id) => lowerer.unions.get(id),
      )
    ) {
      arr = { kind: "dynCheck", value: arr, type: receiverIr, loc: locOf(expr) };
    } else {
      lowerer.unsupported(
        "SC1090",
        expr,
        `element access on checked-dynamic values with '${lowerer.fmt(receiverIr)}' elements`,
      );
    }
  }
  // Array reads can themselves supply an index. A missing numeric value
  // is undefined, which names the array's "undefined" property
  // (undefined-index.ts).
  const index = lowerOptionalIndex(
    lowerer,
    lowerer.lowerExpr(expr.argumentExpression),
    locOf(expr.argumentExpression),
    expr.argumentExpression,
  );
  if (heldEvolving)
    return {
      kind: "dynKeyGet",
      value: arr,
      key: lowerer.coerceToExpected(index, DYN),
      type: DYN,
      loc: locOf(expr),
    };
  if (
    arr.type.kind === "array" &&
    (index.type.kind === "dyn" ||
      (isJsSourceFile(ts.getSourceFileOfNode(expr)) &&
        index.type.kind !== "f64" &&
        lowerer.dynConvertible(index.type)))
  ) {
    return {
      kind: "dynKeyGet",
      value: lowerer.coerceToExpected(arr, DYN),
      key: index,
      type: DYN,
      loc: locOf(expr),
    };
  }
  if (index.type.kind !== "f64") {
    lowerer.unsupported("SC1090", expr.argumentExpression, "indexing with non-number keys");
  }
  // The LOWERED receiver's element type wins over the checker's when
  // both are arrays: a spoke result can be more precise than the
  // declared surface (emitter.listeners() answers the event's tuple
  // signature where the .d.ts says Function[], which would flatten the
  // element to a zero-parameter closure).
  const elemT = arr.type.kind === "array" ? arr.type.elem : receiverIr.elem;
  // Every ordinary array read is a JavaScript property read: an invalid
  // index answers undefined, even when the checker was built without
  // noUncheckedIndexedAccess. Keep the explicit optional union in the IR
  // so it can flow through templates, locals, calls, returns, operators,
  // and narrowing. The helper performs one length/proof check and then
  // uses the dense getter for the proven-present path, so this does not
  // change the storage representation or the low-level getter itself.
  if (arr.type.kind === "array") {
    // A non-null assertion is the explicit proven-present form. Preserve
    // the dense getter's established bounds trap where the asserted value
    // must be the element type (library ABI checks and the catchable
    // RangeError contract for an out-of-bounds assert). Where undefined is
    // representable, the assertion keeps JavaScript's unchecked read.
    const provenPresent =
      ts.isNonNullExpression(expr.parent) &&
      expr.parent.expression === expr &&
      !assertedElementKeepsUndefined(lowerer, expr.parent);
    if (provenPresent) {
      return lowerer.maybeNarrow(
        { kind: "arrayGet", arr, index, type: elemT, loc: locOf(expr) },
        expr,
      );
    }
    const safe = lowerSafeIndexRead(lowerer, arr, index, locOf(expr));
    if (safe) return safe;
  }
  // --npm-static package files retain the original slice-specific route
  // for compatibility with package-source inference.
  if (
    arr.type.kind === "array" &&
    arr.kind === "arrIntrinsic" &&
    arr.method === "slice" &&
    npmStaticPackageOfPath(ts.getSourceFileOfNode(expr).fileName) !== null
  ) {
    const safe = lowerSafeIndexRead(lowerer, arr, index, locOf(expr));
    if (safe) return safe;
  }
  // A union-element read narrows like an identifier when the checker has
  // narrowed THIS occurrence (`if (a[0] !== undefined) use(a[0])` — tsc
  // narrows literal-index element accesses).
  return lowerer.maybeNarrow({ kind: "arrayGet", arr, index, type: elemT, loc: locOf(expr) }, expr);
}

/** A record receiver that an outer keyed read left optional
 * (`nested[a][b]`, where `nested[a]` can miss). The receiver evaluates
 * once into `stmts`; `present` is its record arm, valid only once the
 * access has tested `stable` against the undefined (or, for reads, null)
 * arm. */
interface OptionalRecordReceiver {
  stmts: IrStmt[];
  stable: IrExpr;
  present: IrExpr;
  unionId: string;
  undefTag: number;
  nullish: "undefined" | "null";
}

function optionalRecordReceiver(
  lowerer: Lowerer,
  value: IrExpr,
  loc: SrcLoc,
  allowNull = false,
): OptionalRecordReceiver | null {
  if (value.type.kind !== "union") return null;
  const unionId = value.type.unionId;
  const arms = lowerer.unions.get(unionId)?.arms;
  if (arms?.length !== 2) return null;
  let undefTag = lowerer.armTag(unionId, UNDEFINED_T);
  let nullish: OptionalRecordReceiver["nullish"] = "undefined";
  // A null-initialized slot assigned a record later (iconv-lite's
  // `encodings = null` table, filled on first use): the checker narrows
  // the read to the record, the storage keeps the null arm.
  if (undefTag < 0 && allowNull) {
    undefTag = lowerer.armTag(unionId, NULL_T);
    nullish = "null";
  }
  if (undefTag < 0) return null;
  const record = arms[1 - undefTag]!;
  if (record.kind !== "record") return null;
  const stmts: IrStmt[] = [];
  const stable = stabilized(lowerer, value, "%recordReceiver", stmts);
  const present: IrExpr = {
    kind: "unionNarrow",
    unionId,
    tag: lowerer.armTag(unionId, record),
    value: stable,
    type: record,
    loc,
  };
  return { stmts, stable, present, unionId, undefTag, nullish };
}

/** `value`, evaluated once at this point of `out`. */
function stabilized(lowerer: Lowerer, value: IrExpr, name: string, out: IrStmt[]): IrExpr {
  if (isSafeToRepeat(value)) return value;
  const tmp = lowerer.declareHiddenLocal(name, value.type);
  out.push({ kind: "varDecl", localId: tmp.id, init: value, loc: value.loc });
  return varRef(tmp.id, value.type, value.loc);
}

function undefinedReceiver(receiver: OptionalRecordReceiver, loc: SrcLoc): IrExpr {
  return {
    kind: "unionIsTag",
    unionId: receiver.unionId,
    tag: receiver.undefTag,
    negated: false,
    value: receiver.stable,
    type: BOOL,
    loc,
  };
}

/** Node's TypeError for a keyed read or write on an undefined (or null)
 * receiver. */
function undefinedReceiverThrow(
  key: IrExpr,
  action: "read" | "set",
  type: IrType,
  loc: SrcLoc,
  nullish: OptionalRecordReceiver["nullish"] = "undefined",
): IrExpr {
  const head = `Cannot ${action} properties of ${nullish} (${action === "read" ? "reading" : "setting"} '`;
  const message: IrExpr = {
    kind: "strConcat",
    left: {
      kind: "strConcat",
      left: { kind: "strLit", value: head, type: STRING, loc },
      right: key,
      type: STRING,
      loc,
    },
    right: { kind: "strLit", value: "')", type: STRING, loc },
    type: STRING,
    loc,
  };
  return {
    kind: "libCall",
    fn: "error.nodeThrow",
    args: [numLit(1, loc), { kind: "strLit", value: "", type: STRING, loc }, message],
    type,
    loc,
  };
}

/** The receiver and key of a keyed access whose receiver can be undefined,
 * evaluated in order into `stmts`, with the receiver's record arm and the
 * key's property-name string. Null when the receiver is not optional. */
function guardedRecordAccess(
  lowerer: Lowerer,
  access: ts.ElementAccessExpression,
  rawObj: IrExpr,
  allowNull = false,
): { receiver: OptionalRecordReceiver; key: IrExpr; name: IrExpr } | null {
  const receiver = optionalRecordReceiver(lowerer, rawObj, locOf(access.expression), allowNull);
  if (!receiver) return null;
  const keyNode = access.argumentExpression;
  const litKey = recordKeyLiteralText(keyNode) ?? recordKeyTypeLiteralText(lowerer, keyNode);
  const key =
    litKey !== null
      ? ({ kind: "strLit", value: litKey, type: STRING, loc: locOf(keyNode) } satisfies IrExpr)
      : stabilized(lowerer, lowerer.lowerExpr(keyNode), "%recordKey", receiver.stmts);
  // A symbol key names no string property; its message spelling is not
  // modeled.
  const name =
    key.type.kind === "symbol"
      ? ({ kind: "strLit", value: "Symbol()", type: STRING, loc: locOf(keyNode) } satisfies IrExpr)
      : lowerRecordPropertyKey(lowerer, key, keyNode);
  return { receiver, key, name };
}

/** `nested[a][b] = v` where `nested[a]` can miss: the receiver, the key and
 * the value evaluate in order, then an undefined receiver throws Node's
 * TypeError and a present one takes the write. Only member and identifier
 * receivers are probed, since a probe that finds no optional receiver
 * lowers the receiver again. */
function lowerGuardedRecordWrite(
  lowerer: Lowerer,
  expr: ts.BinaryExpression,
  target: ts.ElementAccessExpression,
): IrStmt | null {
  let receiverNode: ts.Expression = target.expression;
  while (ts.isParenthesizedExpression(receiverNode)) receiverNode = receiverNode.expression;
  if (
    lowerer.chainRecvByNode.has(target.expression) ||
    !(
      ts.isElementAccessExpression(receiverNode) ||
      ts.isPropertyAccessExpression(receiverNode) ||
      ts.isIdentifier(receiverNode)
    )
  )
    return null;
  const guarded = guardedRecordAccess(lowerer, target, lowerer.lowerExpr(target.expression));
  if (!guarded) return null;
  const { receiver, key, name } = guarded;
  const loc = locOf(expr);
  const value = stabilized(lowerer, lowerer.lowerExpr(expr.right), "%recordValue", receiver.stmts);
  const write = lowerer.withExpressionOverride(target.expression, receiver.present, () =>
    lowerer.withExpressionOverride(target.argumentExpression, key, () =>
      lowerer.withExpressionOverride(expr.right, value, () => lowerer.lowerElementWrite(expr)),
    ),
  );
  return {
    kind: "block",
    body: [
      ...receiver.stmts,
      {
        kind: "if",
        cond: undefinedReceiver(receiver, loc),
        then: [{ kind: "exprStmt", expr: undefinedReceiverThrow(name, "set", VOID, loc), loc }],
        else_: [write],
        loc,
      },
    ],
    loc,
  };
}

/** `b[i] = v` where the checker's flow type of `b` is a typed array but
 * its storage is wider. A hoisted JavaScript `var` (or a field written
 * after construction) holds `bytes | undefined`: the receiver, index and
 * value evaluate in order, then an undefined receiver throws Node's
 * TypeError and a present one takes the typed store. Any other storage (a
 * `var` later reassigned a string, a checked-dynamic value) takes the
 * checked-dynamic store, which applies whatever value the receiver holds. */
function lowerWiderBytesWrite(
  lowerer: Lowerer,
  expr: ts.BinaryExpression,
  target: ts.ElementAccessExpression,
  recv: IrExpr,
): IrStmt {
  const loc = locOf(expr);
  if (recv.type.kind === "union") {
    const unionId = recv.type.unionId;
    const arms = lowerer.unions.get(unionId)?.arms;
    const undefTag = lowerer.armTag(unionId, UNDEFINED_T);
    const bytes = arms?.length === 2 && undefTag >= 0 ? arms[1 - undefTag]! : null;
    const keyType = lowerer.mapTypeOf(lowerer.typeOf(target.argumentExpression));
    const index =
      bytes?.kind === "bytes" && keyType?.kind === "f64"
        ? lowerer.lowerExpr(target.argumentExpression)
        : null;
    // An index stored wider than a number (a hoisted `var` counter) keeps
    // the checked-dynamic store below, which converts the key exactly.
    if (bytes?.kind === "bytes" && index?.type.kind === "f64") {
      const stmts: IrStmt[] = [];
      const stable = stabilized(lowerer, recv, "%bytesReceiver", stmts);
      const key = stabilized(lowerer, index, "%bytesIndex", stmts);
      const value = stabilized(
        lowerer,
        lowerer.lowerExprExpecting(expr.right, F64),
        "%bytesValue",
        stmts,
      );
      const name = lowerRecordPropertyKey(lowerer, key, target.argumentExpression);
      const present: IrExpr = {
        kind: "unionNarrow",
        unionId,
        tag: 1 - undefTag,
        value: stable,
        type: bytes,
        loc,
      };
      return {
        kind: "block",
        body: [
          ...stmts,
          {
            kind: "if",
            cond: {
              kind: "unionIsTag",
              unionId,
              tag: undefTag,
              negated: false,
              value: stable,
              type: BOOL,
              loc,
            },
            then: [{ kind: "exprStmt", expr: undefinedReceiverThrow(name, "set", VOID, loc), loc }],
            else_: [{ kind: "bytesSet", arr: present, index: key, value, loc }],
            loc,
          },
        ],
        loc,
      };
    }
  }
  if (!lowerer.dynConvertible(recv.type)) {
    lowerer.unsupported(
      "SC1090",
      target.expression,
      `typed-array element writes through '${lowerer.fmt(recv.type)}' storage`,
    );
  }
  return {
    kind: "exprStmt",
    expr: lowerDynMemberAssignment(lowerer, expr, lowerer.coerceInto(target.expression, recv, DYN)),
    loc,
  };
}

/** `r[k]` over a (non-tuple) record shape. A LITERAL key naming a declared
 * field is the bracket spelling of field access (the ONLY spelling tsc
 * permits for signature-declared fields under
 * noPropertyAccessFromIndexSignature) — an ordinary recordGet. Everything
 * else is a runtime-keyed read (recordKeyGet): declared fields answer
 * first via an emitted string-switch, index-signature shapes fall through
 * to the overflow map. The result type is the index signature's value type
 * armed with undefined (dyn for `unknown`): a missing key reads undefined,
 * as in JavaScript, whatever noUncheckedIndexedAccess says. Every declared
 * field must be able to SURFACE as that type (equal, an arm of it, or —
 * for dyn results — JSON-safe for the dyn conversion); shapes mixing in
 * fields outside that stay fenced. Declared-only shapes support reads
 * whose key type proves membership (tsc's keyof check): all fields must
 * share the result type, and a smuggled miss traps. */
export function lowerRecordKeyRead(
  lowerer: Lowerer,
  expr: ts.ElementAccessExpression,
  shapeId: string,
  shape: IrRecordShape,
  includeUndefined = false,
): IrExpr {
  const loc = locOf(expr);
  const keyNode = expr.argumentExpression;
  // Literal declared keys are plain field reads (narrowing included).
  // NUMERIC literals are their canonical string spelling — JS object keys
  // ARE strings (`r[1]` reads `r["1"]`), so `b[1]` hits a declared field
  // named "1" (a mapped type over a numeric enum) exactly like `b["1"]`.
  // A key IDENTIFIER whose type proves one literal (a literal-typed
  // const, a keyof-constrained type parameter bound to a literal inside
  // a generic instance) is the same static read — identifier evaluation
  // is pure, so skipping it matches JS exactly.
  const litKey = recordKeyLiteralText(keyNode) ?? recordKeyTypeLiteralText(lowerer, keyNode);
  // An outer keyed read can leave the receiver undefined: evaluate the
  // receiver and the key, then throw Node's TypeError or read the present
  // record.
  // The receiver lowers FIRST (both branches below read it, and JS
  // evaluates the receiver before the key).
  const obj = lowerer.lowerExpr(expr.expression);
  {
    // A null arm is guarded only for string and number keys: other keys
    // already take the checked-dynamic read, which handles null itself.
    // Only a receiver with a null arm asks about the key.
    let allowNull = false;
    if (obj.type.kind === "union" && lowerer.armTag(obj.type.unionId, NULL_T) >= 0) {
      const keyType = litKey !== null ? STRING : lowerer.mapTypeOf(lowerer.typeOf(keyNode));
      allowNull = keyType?.kind === "string" || keyType?.kind === "f64";
    }
    const guarded = guardedRecordAccess(lowerer, expr, obj, allowNull);
    if (guarded) {
      const { receiver, key, name } = guarded;
      const read = lowerer.withExpressionOverride(expr.expression, receiver.present, () =>
        litKey !== null
          ? lowerRecordKeyRead(lowerer, expr, shapeId, shape, includeUndefined)
          : lowerer.withExpressionOverride(keyNode, key, () =>
              lowerRecordKeyRead(lowerer, expr, shapeId, shape, includeUndefined),
            ),
      );
      return {
        kind: "seqExpr",
        stmts: receiver.stmts,
        result: {
          kind: "ternary",
          cond: undefinedReceiver(receiver, loc),
          then: undefinedReceiverThrow(name, "read", read.type, loc, receiver.nullish),
          else_: read,
          type: read.type,
          loc,
        },
        type: read.type,
        loc,
      };
    }
  }
  // A record-mapped CHECKER type over a VALUE living in the checked-dynamic tree (a JS
  // file-scope object-literal global): the checked-dynamic keyed read —
  // dynKeyGet against the runtime keys (a missing key answers the checked-dynamic tree
  // undefined, exactly JS); consumers validate (dynCheck) where a
  // static type is required, the member-read discipline.
  if (obj.type.kind === "dyn") {
    let dk =
      litKey !== null
        ? ({ kind: "strLit", value: litKey, type: STRING, loc: locOf(keyNode) } satisfies IrExpr)
        : lowerer.lowerExpr(keyNode);
    // Number AND checked-dynamic keys ride the JS-exact formatter —
    // property keys ARE strings (o[k] is o[String(k)] in JS), and a dyn
    // key (agent.sockets[agent.getName(...)]) stringifies the same way.
    if (dk.type.kind === "union" && lowerer.dynConvertible(dk.type))
      dk = lowerer.coerceToExpected(dk, DYN);
    if (dk.type.kind !== "symbol" && dk.type.kind !== "dyn")
      dk = lowerRecordPropertyKey(lowerer, dk, keyNode);
    if (dk.type.kind !== "string" && dk.type.kind !== "symbol" && dk.type.kind !== "dyn") {
      lowerer.unsupported("SC1090", keyNode, "indexing records with non-string or non-number keys");
    }
    const read: IrExpr = { kind: "dynKeyGet", key: dk, value: obj, type: DYN, loc };
    // Absence probes must keep the checked-dynamic undefined produced by
    // a missing key. The ordinary read narrows to the checker's declared
    // index value (and therefore validates it); ===/!==, ||, and ?? need
    // to observe the missing value instead of throwing during that check.
    return includeUndefined ? read : lowerer.maybeNarrow(read, expr);
  }
  if (litKey !== null) {
    const nominal = representedClassFieldTarget(lowerer, expr.expression, litKey, obj);
    if (nominal) {
      const read = lowerer.fieldGetExpr(nominal, loc, expr);
      return includeUndefined ? read : lowerer.maybeNarrow(read, expr);
    }
  }
  if (hasClassPayload(lowerer, obj.type)) {
    lowerer.unsupported(
      "SC1090",
      expr,
      "computed property reads through structural views of class instances (use a declared literal key)",
    );
  }
  // Predicates can strengthen optional fields without changing the
  // receiver's stored layout. Use that layout for bracket reads just as
  // fieldTarget does for the corresponding dot reads.
  if (obj.type.kind === "record") {
    const actualShape = lowerer.shapes.get(obj.type.shapeId);
    if (!actualShape)
      throw new InternalCompilerError("record receiver is missing its stored shape");
    shapeId = obj.type.shapeId;
    shape = actualShape;
  }
  if (litKey !== null) {
    const field = shape.fields.find((f) => f.name === litKey);
    if (field) {
      const get: IrExpr = {
        kind: "recordGet",
        obj,
        shapeId,
        field: field.name,
        type: field.type,
        loc,
      };
      return lowerer.maybeNarrow(get, expr);
    }
  }
  let key =
    litKey !== null
      ? ({ kind: "strLit", value: litKey, type: STRING, loc: locOf(keyNode) } satisfies IrExpr)
      : lowerer.lowerExpr(keyNode);
  // Optional string/number keys need ToPropertyKey, not a boxed copy of
  // the receiver. Keep record reads on their native storage so nested
  // references retain identity across index-signature reads.
  if (
    key.type.kind === "union" &&
    !lowerer.unions
      .get(key.type.unionId)
      ?.arms.some((arm) => arm.kind === "symbol" || arm.kind === "dyn")
  ) {
    key = lowerRecordPropertyKey(lowerer, key, keyNode);
  }
  if (
    (key.type.kind === "symbol" || key.type.kind === "dyn" || key.type.kind === "union") &&
    lowerer.dynConvertible(key.type) &&
    lowerer.dynConvertible(obj.type)
  ) {
    const read: IrExpr = {
      kind: "dynKeyGet",
      value: lowerer.coerceToExpected(obj, DYN),
      key: lowerer.coerceToExpected(key, DYN),
      type: DYN,
      loc,
    };
    return includeUndefined ? read : lowerer.maybeNarrow(read, expr);
  }
  // Runtime NUMBER keys ride the JS-exact formatter (o[n] is o[String(n)]
  // in JS — the number-keyed-signature access path).
  key = lowerRecordPropertyKey(lowerer, key, keyNode);
  if (key.type.kind !== "string") {
    lowerer.unsupported("SC1090", keyNode, "indexing records with non-string or non-number keys");
  }
  if (shape.fields.length === 0 && shape.indexValue === undefined) {
    const result = dynUndefinedExpr(loc);
    return {
      kind: "seqExpr",
      stmts: [
        { kind: "exprStmt", expr: obj, loc },
        { kind: "exprStmt", expr: key, loc },
      ],
      result,
      type: DYN,
      loc,
    };
  }
  // The result type of the access — the index signature's value type
  // armed with undefined, or the declared fields' one common type on
  // signature-free shapes (tsc's keyof check proved membership; a
  // smuggled miss traps). On signature-free shapes the checker may have
  // NARROWED this occurrence (assignment CFA on literal keys) — maybeNarrow
  // bridges to the narrowed arm exactly like a field read.
  let declared: IrType | null = null;
  // An index-signature read is a JavaScript property read: a missing key
  // answers undefined even without noUncheckedIndexedAccess. The read keeps
  // that explicit optional union, as an ordinary array read does.
  let optionalRead = false;
  // A read whose every consumer treats undefined like NaN (see
  // nan-coded-reads.ts) is a plain number that is NaN for a missing key.
  const nanCoded =
    !includeUndefined &&
    shape.indexValue?.kind === "f64" &&
    lowerer.nanCodedReads?.isNumericRead(expr) === true;
  if (shape.indexValue) {
    declared = shape.indexValue;
    if (declared.kind !== "dyn" && !nanCoded) {
      declared = lowerer.withUndefinedArmOf(declared);
      if (!declared) lowerer.badType(expr, lowerer.typeOf(expr));
      optionalRead = true;
    }
  } else if (
    shape.fields.length > 0 &&
    shape.fields.every((f) => typeEquals(f.type, shape.fields[0]!.type))
  ) {
    declared = shape.fields[0]!.type;
  } else if (shape.fields.length > 0) {
    // Fields of different types (`row[key]` with `key: keyof Row`): the
    // checker types the read as the union of the field types the key can
    // name. When every declared field surfaces in that union (an arm, or a
    // union that widens into it), the per-field dispatch wraps each hit
    // into its arm.
    const read = lowerer.mapTypeOf(lowerer.typeOf(expr));
    if (read !== null && read.kind === "union" && recordKeyResultOk(lowerer, shape, read))
      declared = read;
  }
  // Fields of different types answer a checked-dynamic value where nothing
  // typed the read: in JavaScript, and where the checker types it 'any'
  // (an object literal of a package's JavaScript indexed by a runtime key,
  // such as a numeric enum's reverse mapping).
  if (
    !declared &&
    (isJsSourceFile(ts.getSourceFileOfNode(expr)) ||
      (lowerer.typeOf(expr).flags & ts.TypeFlags.Any) !== 0) &&
    recordKeyResultOk(lowerer, shape, DYN)
  )
    declared = DYN;
  if (!declared) {
    lowerer.unsupported(
      "SC1090",
      expr,
      `dynamic keyed reads of '${lowerer.fmt({ kind: "record", shapeId })}' (the declared fields have no one common type)`,
    );
  }
  // A LITERAL key naming no declared field can only hit the overflow:
  // the declared-field surfacing constraint doesn't apply.
  const overflowOnly = litKey !== null && !!shape.indexValue;
  if (!recordKeyResultOk(lowerer, overflowOnly ? { ...shape, fields: [] } : shape, declared)) {
    lowerer.unsupported(
      "SC1090",
      expr,
      `dynamic keyed reads of '${lowerer.fmt({ kind: "record", shapeId })}' as '${lowerer.fmt(declared)}' (every declared field must be readable at that type)`,
    );
  }
  const read: IrExpr = {
    kind: "recordKeyGet",
    obj,
    shapeId,
    key,
    ...(overflowOnly ? { overflowOnly: true as const } : {}),
    ...(nanCoded ? { missNaN: true as const } : {}),
    type: declared,
    loc,
  };
  if (nanCoded) return read;
  return includeUndefined || optionalRead ? read : lowerer.maybeNarrow(read, expr);
}

/** ToPropertyKey for represented record keys. Missing array-derived string
 * values remain real undefined values, whose JavaScript property spelling
 * is the string "undefined". */
function lowerRecordPropertyKey(lowerer: Lowerer, key: IrExpr, node: ts.Expression): IrExpr {
  if (key.type.kind === "union" && lowerer.dynConvertible(key.type)) {
    return {
      kind: "libCall",
      fn: "dyn.toStringCoerce",
      args: [lowerer.coerceInto(node, key, DYN)],
      type: STRING,
      loc: key.loc,
    };
  }
  if (
    key.type.kind === "f64" ||
    key.type.kind === "bool" ||
    key.type.kind === "dyn" ||
    lowerer.runtimeOptionalWidening(key.type, STRING) !== null
  ) {
    return lowerer.ensureString(key, node);
  }
  return key;
}

/** The compile-time string spelling of a record key literal: a string
 * literal's text, or a NON-NEGATIVE numeric literal's canonical JS
 * spelling (`1` → "1", `1e21` → "1e+21" — String(Number(text)), which is
 * exactly the key JS derives; negative/computed keys stay runtime
 * expressions and canonicalize through ensureString instead). Null for
 * everything else. */
function recordKeyLiteralText(node: ts.Expression): string | null {
  if (ts.isStringLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) return String(Number(node.text));
  return null;
}

/** The compile-time key an IDENTIFIER's TYPE proves: a key variable whose
 * (narrowed) type is one string/number literal — `const k: "a" = …; o[k]`,
 * and the generic-body form where k's type is a keyof-constrained
 * parameter bound to a literal (`pick(o, "a")`'s instance reads `o[k]`
 * with K = "a", resolved through typeParamTsBindings). Identifier reads
 * are pure, so the static field read may skip evaluating the key exactly
 * like a syntactic literal. Null anywhere the type keeps more than one
 * key. */
function recordKeyTypeLiteralText(lowerer: Lowerer, node: ts.Expression): string | null {
  if (!ts.isIdentifier(node)) return null;
  let t: ts.Type = lowerer.typeOf(node);
  if (t.flags & ts.TypeFlags.TypeParameter) {
    const bound = lowerer.typeParamTsResolver(t);
    if (!bound) return null;
    t = bound;
  }
  if (t.isStringLiteralType()) return t.value;
  if (t.isNumberLiteralType()) {
    const n = t.value;
    return Number.isFinite(n) && n >= 0 ? String(n) : null;
  }
  return null;
}

/** The literal index of a tuple access, or null when the expression isn't
 * a non-negative integer literal (parentheses tolerated — tsc's own
 * literal-index typing accepts them). */
function tupleLiteralIndex(node: ts.Expression): number | null {
  let e: ts.Expression = node;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  if (!ts.isNumericLiteral(e)) return null;
  const n = Number(e.text);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

export function lowerElementCompoundParts(
  lowerer: Lowerer,
  expr: ts.BinaryExpression,
  op: CompoundOp,
  statement: boolean,
): { expr: IrExpr | null; stmts: IrStmt[] | null } {
  const target = expr.left as ts.ElementAccessExpression;
  fenceNodeModuleMutation(lowerer, target, "assignment");
  const loc = locOf(expr);
  // A record through a computed key (`totals[side] += n` with a literal
  // union key, `counts[name] += 1` on an index-signature record): the
  // member compound's receiver, key, old value, rhs, write sequence.
  if (isKeyedFieldAccess(lowerer, target))
    return { expr: lowerFieldCompoundValue(lowerer, target, op, expr.right, loc), stmts: null };
  const checked = lowerer.lowerExpr(target.expression);
  if (checked?.type.kind === "dyn" && isJsSourceFile(ts.getSourceFileOfNode(expr))) {
    const stmts: IrStmt[] = [];
    const save = (value: IrExpr, name: string): IrExpr => {
      const local = lowerer.declareHiddenLocal(name, value.type);
      stmts.push({ kind: "varDecl", localId: local.id, init: value, loc });
      return varRef(local.id, value.type, loc);
    };
    const receiver = save(checked, "%compoundReceiver");
    const key = save(lowerer.lowerExprExpecting(target.argumentExpression, DYN), "%compoundKey");
    const old = save({ kind: "dynKeyGet", value: receiver, key, type: DYN, loc }, "%compoundOld");
    const rhs = lowerer.lowerExprExpecting(expr.right, DYN);
    const numeric = ["-", "*", "/", "%", "**"].includes(op);
    const value = save(
      {
        kind: "libCall",
        fn: op === "+" ? "dyn.add" : numeric ? "dyn.arithmetic" : "dyn.bitwise",
        args: op === "+" ? [old, rhs] : [old, rhs, strLit(op, loc)],
        type: DYN,
        loc,
      },
      "%compoundResult",
    );
    stmts.push({
      kind: "exprStmt",
      expr: {
        kind: "libCall",
        fn: "dyn.keySetComputed",
        args: [receiver, key, value],
        type: VOID,
        loc,
      },
      loc,
    });
    return { expr: { kind: "seqExpr", stmts, result: value, type: DYN, loc }, stmts: null };
  }
  const indexedArms = indexedUnionArms(lowerer, checked.type);
  if (indexedArms && !isJsSourceFile(ts.getSourceFileOfNode(expr)))
    return lowerIndexedUnionCompound(lowerer, expr, op, checked, indexedArms);
  const receiverType =
    checked.type.kind === "array" || checked.type.kind === "bytes"
      ? checked.type
      : lowerer.mapTypeOf(lowerer.typeOf(target.expression));
  if (receiverType?.kind !== "array" && receiverType?.kind !== "bytes") {
    lowerer.unsupported("SC1090", target, "compound assignment to non-array elements");
  }
  let receiver = checked;
  if (receiver.type.kind === "union" && lowerer.armTag(receiver.type.unionId, UNDEFINED_T) >= 0) {
    const present = lowerer.stripUndefinedArm(receiver.type);
    const helper =
      present.kind === receiverType.kind
        ? lowerer.narrowedArmHelper(receiver.type.unionId, present, locOf(target.expression))
        : null;
    if (helper)
      receiver = lowerer.checkedNarrowCall(helper, receiver, present, locOf(target.expression));
  }
  if (receiver.type.kind !== receiverType.kind) {
    lowerer.unsupported(
      "SC1090",
      target.expression,
      "compound assignment through a non-native array or byte view",
    );
  }
  // An undefined index names the "undefined" property (undefined-index.ts),
  // which a typed array cannot hold.
  const rawIndex = lowerer.lowerExpr(target.argumentExpression);
  const split =
    receiver.type.kind === "bytes"
      ? splitUndefinedIndex(
          lowerer,
          rawIndex,
          target.argumentExpression,
          locOf(target.argumentExpression),
        )
      : null;
  const index =
    split?.index ??
    lowerOptionalIndex(
      lowerer,
      rawIndex,
      locOf(target.argumentExpression),
      target.argumentExpression,
    );
  if (index.type.kind !== "f64")
    lowerer.unsupported("SC1090", target.argumentExpression, "indexing with non-number keys");
  const receiverLocal = lowerer.declareHiddenLocal("%compoundArray", receiver.type);
  const indexLocal = lowerer.declareHiddenLocal("%compoundIndex", F64);
  const receiverRef = (): IrExpr => varRef(receiverLocal.id, receiver.type, loc);
  const indexRef = (): IrExpr => varRef(indexLocal.id, F64, loc);
  const oldValue: IrExpr =
    receiver.type.kind === "array"
      ? receiver.type.elem.kind === "f64" &&
        !(op === "+" && elementMayBeForeign(lowerer, receiver.type.elem))
        ? // Every numeric operator applies ToNumber to the old value, so a
          // missing element is NaN without materializing `number | undefined`.
          arrayNumberRead(receiverRef(), indexRef(), locOf(target))
        : receiver.type.elem.kind === "string" &&
            op === "+" &&
            !elementMayBeForeign(lowerer, receiver.type.elem)
          ? arrayStringOperand(receiverRef(), indexRef(), locOf(target))
          : arrayValueRead(lowerer, receiverRef(), indexRef(), receiver.type.elem, locOf(target))
      : {
          // An invalid index reads undefined in Node, which every numeric
          // compound operator turns into NaN; the write is then ignored.
          kind: "bytesIntrinsic",
          method: "get",
          receiver: receiverRef(),
          args: [indexRef()],
          type: F64,
          loc: locOf(target),
          invalidNaN: true,
        };
  const oldLocal = lowerer.declareHiddenLocal("%compoundOld", oldValue.type);
  const oldRef = (): IrExpr => varRef(oldLocal.id, oldValue.type, loc);
  const rhs = lowerer.lowerExpr(expr.right);
  const numericRhs =
    rhs.type.kind === "dyn" &&
    isJsSourceFile(ts.getSourceFileOfNode(expr)) &&
    receiver.type.kind === "bytes"
      ? { kind: "libCall" as const, fn: "dyn.toNumberCoerce" as const, args: [rhs], type: F64, loc }
      : lowerOptionalNumber(lowerer, rhs, loc);
  const elementType = receiver.type.kind === "array" ? receiver.type.elem : F64;
  const valueType =
    elementType.kind === "union" && lowerer.armTag(elementType.unionId, UNDEFINED_T) >= 0
      ? lowerer.stripUndefinedArm(elementType)
      : elementType;
  if (
    statement &&
    op === "+" &&
    receiver.type.kind === "array" &&
    receiver.type.elem.kind === "string"
  ) {
    // Receiver, index, old element (read inside the concat), rhs, write.
    const appended: IrExpr = {
      kind: "strConcat",
      left: oldValue,
      right: concatOperand(lowerer, rhs, expr.right),
      type: STRING,
      loc,
    };
    return {
      expr: null,
      stmts: [
        { kind: "varDecl", localId: receiverLocal.id, init: receiver, loc },
        { kind: "varDecl", localId: indexLocal.id, init: index, loc },
        { kind: "arraySet", arr: receiverRef(), index: indexRef(), value: appended, loc },
      ],
    };
  }
  let computed: IrExpr;
  if (op === "+" && valueType.kind === "string") {
    computed = {
      kind: "strConcat",
      left: lowerer.ensureString(oldRef(), target),
      right: concatOperand(lowerer, rhs, expr.right),
      type: STRING,
      loc,
    };
  } else if (valueType.kind === "f64" && numericRhs.type.kind === "f64") {
    computed = {
      kind: "bin",
      op,
      left: lowerOptionalNumber(lowerer, oldRef(), loc),
      right: numericRhs,
      type: F64,
      loc,
    };
  } else if (valueType.kind === "dyn" && isJsSourceFile(ts.getSourceFileOfNode(expr))) {
    const left = lowerer.coerceToExpected(oldRef(), DYN),
      right = lowerer.coerceToExpected(rhs, DYN);
    computed = dynCompoundValue(op, left, right, loc);
  } else if (
    rhs.type.kind === "dyn" &&
    receiver.type.kind === "array" &&
    lowerer.dynConvertible(oldValue.type) &&
    lowerer.dynConvertible(valueType)
  ) {
    // An untyped right operand: the expanded `a[i] = a[i] op rhs`, checked
    // back into the element type.
    computed = lowerer.coerceInto(
      expr,
      dynCompoundValue(
        op,
        lowerer.coerceToExpected(oldRef(), DYN),
        lowerer.coerceToExpected(rhs, DYN),
        loc,
      ),
      valueType,
    );
  } else {
    compoundUnsupported(lowerer, expr, op, oldValue.type, rhs.type);
  }
  const resultLocal = lowerer.declareHiddenLocal("%compoundResult", computed.type);
  const resultRef = (): IrExpr => varRef(resultLocal.id, computed.type, loc);
  const store: IrStmt =
    receiver.type.kind === "array"
      ? arrayValueStore(lowerer, receiverRef(), indexRef(), resultRef(), receiver.type.elem, loc)
      : { kind: "bytesSet", arr: receiverRef(), index: indexRef(), value: resultRef(), loc };
  const write: IrStmt = split
    ? {
        kind: "if",
        cond: split.isUndefined,
        then: [undefinedTypedArrayKeyFence(lowerer, target, loc)],
        else_: [store],
        loc,
      }
    : store;
  return {
    expr: {
      kind: "seqExpr",
      stmts: [
        { kind: "varDecl", localId: receiverLocal.id, init: receiver, loc },
        ...(split?.stmts ?? []),
        { kind: "varDecl", localId: indexLocal.id, init: index, loc },
        { kind: "varDecl", localId: oldLocal.id, init: oldValue, loc },
        { kind: "varDecl", localId: resultLocal.id, init: computed, loc },
        write,
      ],
      result: resultRef(),
      type: computed.type,
      loc,
    },
    stmts: null,
  };
}

/** `u[i] op= v` on a union of typed arrays and number arrays: the
 * receiver and index evaluate once, the old element reads as a number (NaN
 * for an invalid index, as in the typed-array form), and the result is
 * stored through the union's element write. */
function lowerIndexedUnionCompound(
  lowerer: Lowerer,
  expr: ts.BinaryExpression,
  op: CompoundOp,
  receiver: IrExpr,
  arms: readonly IndexedArm[],
): { expr: IrExpr | null; stmts: IrStmt[] | null } {
  const target = expr.left as ts.ElementAccessExpression;
  const loc = locOf(expr);
  const index = lowerOptionalIndex(
    lowerer,
    lowerer.lowerExpr(target.argumentExpression),
    locOf(target.argumentExpression),
    target.argumentExpression,
  );
  if (index.type.kind !== "f64")
    lowerer.unsupported("SC1090", target.argumentExpression, "indexing with non-number keys");
  const receiverLocal = lowerer.declareHiddenLocal("%compoundArray", receiver.type);
  const indexLocal = lowerer.declareHiddenLocal("%compoundIndex", F64);
  const receiverRef = (): IrExpr => varRef(receiverLocal.id, receiver.type, loc);
  const indexRef = (): IrExpr => varRef(indexLocal.id, F64, loc);
  const oldValue = lowerIndexedUnionNumberRead(lowerer, receiverRef(), arms, indexRef(), loc);
  const rhs = lowerOptionalNumber(lowerer, lowerer.lowerExpr(expr.right), loc);
  if (rhs.type.kind !== "f64") compoundUnsupported(lowerer, expr, op, F64, rhs.type);
  const computed: IrExpr = { kind: "bin", op, left: oldValue, right: rhs, type: F64, loc };
  const resultLocal = lowerer.declareHiddenLocal("%compoundResult", F64);
  const resultRef = (): IrExpr => varRef(resultLocal.id, F64, loc);
  return {
    expr: {
      kind: "seqExpr",
      stmts: [
        { kind: "varDecl", localId: receiverLocal.id, init: receiver, loc },
        { kind: "varDecl", localId: indexLocal.id, init: index, loc },
        { kind: "varDecl", localId: resultLocal.id, init: computed, loc },
        lowerIndexedUnionWrite(lowerer, receiverRef(), arms, indexRef(), resultRef(), loc),
      ],
      result: resultRef(),
      type: F64,
      loc,
    },
    stmts: null,
  };
}

/** ToString of one stabilized `string[]` element read for `+=`: a missing
 * element concatenates as "undefined". */
function arrayStringOperand(arr: IrExpr, index: IrExpr, loc: SrcLoc): IrExpr {
  return {
    kind: "ternary",
    cond: {
      kind: "bin",
      op: "===",
      left: { kind: "arrayState", arr, index, type: F64, loc },
      right: { kind: "numLit", value: 1, type: F64, loc },
      type: BOOL,
      loc,
    },
    then: { kind: "arrayGet", arr, index, type: STRING, loc },
    else_: strLit("undefined", loc),
    type: STRING,
    loc,
  };
}

export function lowerElementWrite(lowerer: Lowerer, expr: ts.BinaryExpression): IrStmt {
  const prototype = lowerClassPrototypeComputedAssignment(lowerer, expr);
  if (prototype) return { kind: "exprStmt", expr: prototype, loc: locOf(expr) };
  const target = expr.left as ts.ElementAccessExpression;
  fenceNodeModuleMutation(lowerer, target, "assignment");
  const globalKey = globalSymbolKey(lowerer, target.expression, target.argumentExpression);
  if (globalKey) {
    const value = lowerer.lowerExprExpecting(expr.right, DYN);
    const loc = locOf(expr);
    return {
      kind: "exprStmt",
      expr: {
        kind: "libCall",
        fn: "dyn.globalSymbolSet",
        args: [globalKey, value],
        type: VOID,
        loc,
      },
      loc,
    };
  }
  // `process.env[key] = v` — the computed twin of the dotted env write:
  // setenv(3), string keys and string values only.
  if (lowerer.isProcessEnv(target.expression) && !target.questionDotToken) {
    const loc = locOf(expr);
    const key = lowerEnvironmentKey(lowerer, target.argumentExpression);
    if (key.type.kind !== "string") {
      lowerer.unsupported(
        "SC1090",
        target.argumentExpression,
        "indexing process.env with non-string keys",
      );
    }
    const value = lowerer.lowerExpr(expr.right);
    if (value.type.kind !== "string") {
      lowerer.unsupported(
        "SC1090",
        expr.right,
        `assigning '${lowerer.fmt(value.type)}' values to process.env (env values are strings — convert first: \`\${v}\`)`,
      );
    }
    return {
      kind: "exprStmt",
      expr: { kind: "libCall", fn: "process.envSet", args: [key, value], type: VOID, loc },
      loc,
    };
  }
  // Symbol-keyed property WRITES (`this[kLimit] = v`): the read path's
  // twin — a statically-resolvable unique-symbol key declared on the
  // receiver's class writes the hidden field slot; everything else keeps
  // the fence (static shapes have no symbol-keyed storage).
  if (lowerer.mapTypeOf(lowerer.typeOf(target.argumentExpression))?.kind === "symbol") {
    const fieldT = symbolFieldTarget(lowerer, target);
    if (fieldT) {
      const value = lowerer.lowerExprExpecting(expr.right, fieldT.fieldType);
      return lowerer.fieldSetStmt(fieldT, value, locOf(expr), target);
    }
    const receiver = lowerer.lowerExpr(target.expression);
    if (receiver.type.kind === "dyn")
      return {
        kind: "exprStmt",
        expr: lowerDynMemberAssignment(lowerer, expr, receiver),
        loc: locOf(expr),
      };
    if (
      isJsSourceFile(ts.getSourceFileOfNode(expr)) &&
      receiver.type.kind === "object" &&
      lowerer.dynConvertible(receiver.type)
    ) {
      return {
        kind: "exprStmt",
        expr: lowerDynMemberAssignment(lowerer, expr, lowerer.coerceToExpected(receiver, DYN)),
        loc: locOf(expr),
      };
    }
    lowerer.unsupported(
      "SC1090",
      target,
      "symbol-keyed property writes outside class fields keyed by a stable module-level literal Symbol()/Symbol.for() (other static shapes have no symbol-keyed storage)",
    );
  }
  const checkedReceiver = tryLowerExpression(lowerer, target.expression);
  if (checkedReceiver?.type.kind === "dyn") {
    return {
      kind: "exprStmt",
      expr: lowerDynMemberAssignment(lowerer, expr, checkedReceiver),
      loc: locOf(expr),
    };
  }
  if (checkedReceiver?.type.kind === "object" && isJsSourceFile(ts.getSourceFileOfNode(expr))) {
    const info = lowerer.classes.get(checkedReceiver.type.className);
    const key =
      recordKeyLiteralText(target.argumentExpression) ??
      recordKeyTypeLiteralText(lowerer, target.argumentExpression);
    if (info && key !== null && isClassCallback(lowerer, info, key)) {
      const receiver = lowerer.coerceInto(target.expression, checkedReceiver, DYN);
      return {
        kind: "exprStmt",
        expr: lowerDynMemberAssignment(lowerer, expr, receiver),
        loc: locOf(expr),
      };
    }
  }
  let receiverIr = lowerer.mapTypeOf(lowerer.typeOf(target.expression));
  if (isJsSourceFile(ts.getSourceFileOfNode(expr)) && checkedReceiver) {
    const represented =
      checkedReceiver.type.kind === "union"
        ? lowerer.stripUndefinedArm(checkedReceiver.type)
        : checkedReceiver.type;
    if (represented.kind === "array" || represented.kind === "bytes") receiverIr = represented;
  }
  if (receiverIr === null || receiverIr.kind === "dyn") {
    const receiver = tryLowerExpression(lowerer, target.expression);
    if (receiver?.type.kind === "array") receiverIr = receiver.type;
  }

  // A checked-dynamic receiver TYPE (`unknown[]` and the collapsed
  // `(string | object)[]` map to DYN wholesale now): the dyn keyed
  // write — dyn.keySet. Number keys canonicalize through the JS-exact
  // formatter; ARR receivers take canonical index keys as element
  // set/extend (undefined-hole padding, JS's length growth exactly),
  // OBJ receivers set the member, and the runtime throws Node's
  // TypeErrors on every other kind. Values convert into the checked-dynamic tree;
  // unconvertible ones fence per site (the dynFrom stance).
  if (receiverIr?.kind === "dyn") {
    const obj = lowerer.lowerExpr(target.expression);
    if (obj.type.kind === "dyn") {
      const loc = locOf(expr);
      const key = lowerRecordPropertyKey(
        lowerer,
        lowerer.lowerExpr(target.argumentExpression),
        target.argumentExpression,
      );
      if (key.type.kind !== "string") {
        lowerer.unsupported(
          "SC1090",
          target.argumentExpression,
          "indexing with non-string or non-number keys",
        );
      }
      const value = lowerer.coerceToExpected(lowerer.lowerExpr(expr.right), DYN);
      if (value.type.kind !== "dyn") {
        lowerer.unsupported(
          "SC1101",
          expr.right,
          `storing '${lowerer.fmt(value.type)}' values in a checked-dynamic array (the value cannot convert into the checked-dynamic tree)`,
        );
      }
      return {
        kind: "exprStmt",
        expr: { kind: "libCall", fn: "dyn.keySet", args: [obj, key, value], type: VOID, loc },
        loc,
      };
    }
  }
  if (receiverIr?.kind === "object" || receiverIr?.kind === "record") {
    const key =
      recordKeyLiteralText(target.argumentExpression) ??
      recordKeyTypeLiteralText(lowerer, target.argumentExpression);
    if (key !== null) {
      const receiver = lowerer.lowerExpr(target.expression);
      const field = representedClassFieldTarget(lowerer, target.expression, key, receiver);
      if (field) {
        const value = lowerer.lowerExprExpecting(expr.right, field.fieldType);
        return lowerer.fieldSetStmt(field, value, locOf(expr), target);
      }
      if (hasClassPayload(lowerer, receiver.type)) {
        if (receiver.type.kind === "object" && receiver.type.className === "%Error") {
          return {
            kind: "exprStmt",
            expr: lowerDynMemberAssignment(
              lowerer,
              expr,
              lowerer.coerceInto(target.expression, receiver, DYN),
            ),
            loc: locOf(expr),
          };
        }
        lowerer.unsupported(
          "SC1090",
          target,
          "writing undeclared properties through structural views of class instances",
        );
      }
    }
  }
  // Typed-array element write `b[i] = v` — bytesSet: the value is an f64
  // the runtime coerces JS-exactly; invalid indices are ignored.
  if (receiverIr?.kind === "bytes") {
    const recv = lowerer.lowerExpr(target.expression);
    // The checker's flow type is a typed array, but the storage is wider.
    if (recv.type.kind !== "bytes") return lowerWiderBytesWrite(lowerer, expr, target, recv);
    // An index the checker types as a number but whose storage may hold
    // undefined (a hole read) converts with ToNumber, as the reads do; an
    // undefined index names a property the typed array cannot hold.
    const rawIndex = lowerer.lowerExpr(target.argumentExpression);
    const split = splitUndefinedIndex(
      lowerer,
      rawIndex,
      target.argumentExpression,
      locOf(target.argumentExpression),
    );
    const index =
      split?.index ??
      lowerOptionalNumber(
        lowerer,
        rawIndex,
        locOf(target.argumentExpression),
        target.argumentExpression,
      );
    if (index.type.kind === "dyn" && recv.type.kind === "bytes") {
      return {
        kind: "exprStmt",
        expr: lowerDynMemberAssignment(
          lowerer,
          expr,
          lowerer.coerceInto(target.expression, recv, DYN),
        ),
        loc: locOf(expr),
      };
    }
    if (index.type.kind !== "f64") {
      lowerer.unsupported("SC1090", target.argumentExpression, "indexing with non-number keys");
    }
    const value = lowerer.lowerExprExpecting(expr.right, F64);
    if (split === null) return { kind: "bytesSet", arr: recv, index, value, loc: locOf(expr) };
    const loc = locOf(expr);
    const receiver = lowerer.declareHiddenLocal("%indexedBytes", recv.type);
    const valueLocal = lowerer.declareHiddenLocal("%elementValue", F64);
    return {
      kind: "block",
      body: [
        { kind: "varDecl", localId: receiver.id, init: recv, loc },
        ...split.stmts,
        { kind: "varDecl", localId: valueLocal.id, init: value, loc },
        {
          kind: "if",
          cond: split.isUndefined,
          then: [undefinedTypedArrayKeyFence(lowerer, target, loc)],
          else_: [
            {
              kind: "bytesSet",
              arr: varRef(receiver.id, recv.type, loc),
              index,
              value: varRef(valueLocal.id, F64, loc),
              loc,
            },
          ],
          loc,
        },
      ],
      loc,
    };
  }
  // Tuple element write `t[0] = v`: a positional-field write (recordSet)
  // — literal indices only, like the read.
  if (receiverIr?.kind === "record") {
    const shape = lowerer.shapes.get(receiverIr.shapeId);

    if (shape) {
      const obj = lowerer.lowerExpr(target.expression);
      if (hasClassPayload(lowerer, obj.type)) {
        lowerer.unsupported(
          "SC1090",
          target,
          "computed property writes through structural views of class instances (use a declared literal key)",
        );
      }

      // A record-mapped CHECKER type over a VALUE living in the checked-dynamic tree (a
      // JS file-scope object-literal global): the checked-dynamic keyed
      // write — dyn.keySet (later writes win, insertion order; Node's
      // TypeErrors on non-object receivers), the value converting into
      // the checked-dynamic tree. Literal and runtime keys alike: the checked-dynamic tree's key set is
      // open, so no declared-field collision analysis applies.
      if (obj.type.kind === "dyn") {
        const loc = locOf(expr);
        const litKey = recordKeyLiteralText(target.argumentExpression);
        let key: IrExpr =
          litKey !== null
            ? { kind: "strLit", value: litKey, type: STRING, loc: locOf(target.argumentExpression) }
            : lowerer.lowerExpr(target.argumentExpression);
        key = lowerRecordPropertyKey(lowerer, key, target.argumentExpression);
        if (key.type.kind !== "string") {
          lowerer.unsupported(
            "SC1090",
            target.argumentExpression,
            "indexing records with non-string or non-number keys",
          );
        }
        const value = lowerer.coerceToExpected(lowerer.lowerExpr(expr.right), DYN);
        if (value.type.kind !== "dyn") {
          lowerer.unsupported(
            "SC1101",
            expr.right,
            `storing '${lowerer.fmt(value.type)}' values in a checked-dynamic object (the value cannot convert into the checked-dynamic tree)`,
          );
        }
        return {
          kind: "exprStmt",
          expr: { kind: "libCall", fn: "dyn.keySet", args: [obj, key, value], type: VOID, loc },
          loc,
        };
      }
    }
    if (shape?.tuple) {
      const idx = tupleLiteralIndex(target.argumentExpression);
      if (idx === null) {
        lowerer.unsupported(
          "SC1090",
          target.argumentExpression,
          "tuple indexing with a non-literal index (tuples are fixed-shape — use t[0], t[1], ...)",
        );
      }
      const fieldType = shape.fields.find((f) => f.name === String(idx))?.type;
      if (fieldType === undefined) lowerer.badType(target, lowerer.typeOf(target));
      const obj = lowerer.lowerExpr(target.expression);
      const value = lowerer.lowerExprExpecting(expr.right, fieldType);
      return {
        kind: "recordSet",
        obj,
        shapeId: receiverIr.shapeId,
        field: String(idx),
        value,
        loc: locOf(expr),
      };
    }
    // Dynamic keyed write `r[k] = v` — index-signature shapes only (a
    // declared-only shape's writable key set is closed; spell the field).
    // A LITERAL declared key is the bracket spelling of a field write.
    // Values flow into the index-value slot (dyn slots convert, typed
    // slots coerce); declared-key collisions at runtime validate against
    // the field's type through the emitted helper (a mismatch throws the
    // catchable TypeError — SEMANTICS.md).
    if (shape && !shape.tuple) {
      const guarded = lowerGuardedRecordWrite(lowerer, expr, target);
      if (guarded) return guarded;
      // Literal keys — string literals AND numeric literals in their
      // canonical string spelling (`b[1] = v` writes field/key "1", JS's
      // own key derivation) — name declared fields directly. A key
      // IDENTIFIER whose TYPE proves one literal (a literal-typed const,
      // a keyof-constrained type parameter bound to a literal inside a
      // generic instance — `set(o, "a", v)`'s body writing `o[k] = v`)
      // is the same static field write.
      const litKey =
        recordKeyLiteralText(target.argumentExpression) ??
        recordKeyTypeLiteralText(lowerer, target.argumentExpression);
      if (litKey !== null) {
        const field = shape.fields.find((f) => f.name === litKey);
        if (field) {
          const obj = lowerer.lowerExpr(target.expression);
          const value = lowerer.lowerExprExpecting(expr.right, field.type);
          return {
            kind: "recordSet",
            obj,
            shapeId: receiverIr.shapeId,
            field: litKey,
            value,
            loc: locOf(expr),
          };
        }
      }
      if (!shape.indexValue) {
        // A SIGNATURE-FREE shape whose declared fields share ONE type
        // writes through the same per-shape dispatch (the mockable-clock
        // module shape: `mocked[functionality] = implementation` over a
        // table of same-signature closures). A key naming no declared
        // field throws the catchable TypeError — JS would ADD the
        // property, which a monomorphic struct cannot (the SEMANTICS.md
        // keyed-write-miss divergence). Mixed-type and accessor-carrying
        // shapes keep the fence.
        const common =
          shape.fields.length > 0 &&
          !shapeHasAccessorSlots(shape) &&
          shape.fields.every((f) => typeEquals(f.type, shape.fields[0]!.type))
            ? shape.fields[0]!.type
            : null;
        if (!common) {
          lowerer.unsupported(
            "SC1090",
            target,
            "dynamic keyed writes to records without an index signature (declared fields of ONE shared type dispatch by key — spell the field name otherwise)",
          );
        }
        const obj = lowerer.lowerExpr(target.expression);
        let key: IrExpr =
          litKey !== null
            ? { kind: "strLit", value: litKey, type: STRING, loc: locOf(target.argumentExpression) }
            : lowerer.lowerExpr(target.argumentExpression);
        // Runtime number/boolean/dyn keys stringify — ToPropertyKey,
        // exactly the index-signature path's rule.
        key = lowerRecordPropertyKey(lowerer, key, target.argumentExpression);
        if (key.type.kind !== "string") {
          lowerer.unsupported(
            "SC1090",
            target.argumentExpression,
            "indexing records with non-string or non-number keys",
          );
        }
        const value = lowerer.coerceInto(expr.right, lowerer.lowerExpr(expr.right), common);
        if (!typeEquals(value.type, common))
          lowerer.badType(expr.right, lowerer.typeOf(expr.right));
        return {
          kind: "recordKeySet",
          obj,
          shapeId: receiverIr.shapeId,
          key,
          value,
          loc: locOf(expr),
        };
      }
      // A LITERAL key naming no declared field is a pure overflow insert
      // — no collision to validate. Runtime keys must be able to collide
      // with every declared field: dyn slots validate through the
      // dynCheck walker (fields must be dyn-convertible — the same
      // convertibility the read needs); typed slots write through
      // directly, so every field must BE the index-value type.
      const overflowOnly = litKey !== null;
      const writable =
        overflowOnly ||
        (shape.indexValue.kind === "dyn"
          ? shape.fields.every((f) => lowerer.dynConvertible(f.type))
          : shape.fields.every((f) => typeEquals(f.type, shape.indexValue!)));
      if (!writable) {
        lowerer.unsupported(
          "SC1090",
          target,
          `dynamic keyed writes to '${lowerer.fmt(receiverIr)}' (a declared field's type cannot take the index signature's value at runtime)`,
        );
      }
      const obj = lowerer.lowerExpr(target.expression);
      let key =
        litKey !== null
          ? ({
              kind: "strLit",
              value: litKey,
              type: STRING,
              loc: locOf(target.argumentExpression),
            } satisfies IrExpr)
          : lowerer.lowerExpr(target.argumentExpression);
      // Runtime NUMBER keys canonicalize through the JS-exact formatter
      // (o[n] = v writes o[String(n)] — the number-keyed-signature path).
      key = lowerRecordPropertyKey(lowerer, key, target.argumentExpression);
      if (key.type.kind !== "string") {
        lowerer.unsupported(
          "SC1090",
          target.argumentExpression,
          "indexing records with non-string or non-number keys",
        );
      }
      const value = lowerer.intoIndexValueSlot(
        lowerer.lowerExpr(expr.right),
        shape.indexValue,
        expr.right,
      );
      return {
        kind: "recordKeySet",
        obj,
        shapeId: receiverIr.shapeId,
        key,
        value,
        ...(overflowOnly ? { overflowOnly: true as const } : {}),
        loc: locOf(expr),
      };
    }
  }
  // Keyed write `d[k] = v` on a CHECKED-DYNAMIC receiver (a JS `any`
  // dictionary — the Object.create(null) memo-table idiom writes
  // `result[key] = value`): dyn.keySet, exactly the record-mapped dyn
  // arm above — later writes win in insertion order, number keys
  // canonicalize through the JS-exact formatter (ToPropertyKey's string
  // side), index keys on dyn arrays set/extend elements, and non-object
  // receivers throw Node's TypeErrors at runtime. An unmapped checker type
  // probes the receiver's lowered representation: a dyn value takes the same
  // write, anything else falls through to the fences.
  if (receiverIr?.kind === "dyn" || receiverIr?.kind === "object" || receiverIr === null) {
    const obj =
      receiverIr !== null
        ? lowerer.lowerExpr(target.expression)
        : tryLowerExpression(lowerer, target.expression);
    if (
      obj !== null &&
      (obj.type.kind === "dyn" ||
        (obj.type.kind === "object" && obj.type.className === "%Error") ||
        isDynTypedRefType(obj.type))
    ) {
      const loc = locOf(expr);
      const litKey = recordKeyLiteralText(target.argumentExpression);
      let key: IrExpr =
        litKey !== null
          ? { kind: "strLit", value: litKey, type: STRING, loc: locOf(target.argumentExpression) }
          : lowerer.lowerExpr(target.argumentExpression);
      key = lowerRecordPropertyKey(lowerer, key, target.argumentExpression);
      if (key.type.kind !== "string") {
        lowerer.unsupported(
          "SC1090",
          target.argumentExpression,
          "indexing checked-dynamic values with non-string or non-number keys",
        );
      }
      const value = lowerer.coerceToExpected(lowerer.lowerExpr(expr.right), DYN);
      if (value.type.kind !== "dyn") {
        lowerer.unsupported(
          "SC1101",
          expr.right,
          `storing '${lowerer.fmt(value.type)}' values in a checked-dynamic object (the value cannot convert into the checked-dynamic tree)`,
        );
      }
      return {
        kind: "exprStmt",
        expr: {
          kind: "libCall",
          fn: "dyn.keySet",
          args: [lowerer.coerceToExpected(obj, DYN), key, value],
          type: VOID,
          loc,
        },
        loc,
      };
    }
  }
  // An element write into a union of typed arrays and number arrays
  // (indexed-unions.ts).
  const indexedArms = receiverIr ? indexedUnionArms(lowerer, receiverIr) : null;
  if (indexedArms && receiverIr && !isJsSourceFile(ts.getSourceFileOfNode(expr))) {
    let recv = lowerer.lowerExpr(target.expression);
    if (recv.type.kind === "dyn") recv = lowerer.coerceInto(target.expression, recv, receiverIr);
    const arms = indexedUnionArms(lowerer, recv.type);
    if (arms) {
      const index = lowerOptionalNumber(
        lowerer,
        lowerer.lowerExpr(target.argumentExpression),
        locOf(target.argumentExpression),
        target.argumentExpression,
      );
      if (index.type.kind !== "f64")
        lowerer.unsupported("SC1090", target.argumentExpression, "indexing with non-number keys");
      const value = lowerer.lowerExprExpecting(expr.right, F64);
      return lowerIndexedUnionWrite(lowerer, recv, arms, index, value, locOf(expr));
    }
  }
  if (receiverIr?.kind !== "array") {
    lowerer.unsupported("SC1090", target, "assignment to non-array elements");
  }
  let arr = lowerer.lowerExpr(target.expression);

  if (
    arr.type.kind === "union" &&
    lowerer.armTag(arr.type.unionId, UNDEFINED_T) >= 0 &&
    receiverIr.kind === "array"
  ) {
    const present = lowerer.stripUndefinedArm(arr.type);
    const helper =
      present.kind === "array"
        ? lowerer.narrowedArmHelper(arr.type.unionId, present, locOf(target.expression))
        : null;
    if (helper) {
      arr = lowerer.checkedNarrowCall(helper, arr, present, locOf(target.expression));
    }
  }
  if (arr.type.kind !== "array") {
    lowerer.unsupported(
      "SC1090",
      target.expression,
      "assignment through a possibly missing nested array receiver",
    );
  }
  const index = lowerOptionalIndex(
    lowerer,
    lowerer.lowerExpr(target.argumentExpression),
    locOf(target.argumentExpression),
    target.argumentExpression,
  );
  if (index.type.kind === "dyn" && lowerer.dynConvertible(arr.type)) {
    return {
      kind: "exprStmt",
      expr: lowerDynMemberAssignment(
        lowerer,
        expr,
        lowerer.coerceInto(target.expression, arr, DYN),
      ),
      loc: locOf(expr),
    };
  }
  if (index.type.kind !== "f64") {
    lowerer.unsupported("SC1090", target.argumentExpression, "indexing with non-number keys");
  }
  // Optional array reads carry the source array's payload type plus an
  // undefined arm. arrayValueStore turns that arm into the runtime's
  // UNDEFINED state while keeping number[]/string[] payload storage scalar.
  let literal = expr.right;
  while (ts.isParenthesizedExpression(literal) || ts.isSatisfiesExpression(literal))
    literal = literal.expression;
  const value =
    ts.isObjectLiteralExpression(literal) || ts.isArrayLiteralExpression(literal)
      ? lowerer.lowerExprExpecting(literal, arr.type.elem)
      : lowerer.lowerExpr(expr.right);
  // Validate the payload before emitting a native store. A dormant JS
  // method can contradict its JSDoc element type; retain its call-time
  // refusal instead of leaving invalid IR in a newly reachable method.
  const expected =
    value.type.kind === "undefinedT" ||
    (value.type.kind === "union" && lowerer.armTag(value.type.unionId, UNDEFINED_T) >= 0)
      ? arrayValueType(lowerer, arr.type.elem)
      : arr.type.elem;
  return arrayValueStore(
    lowerer,
    arr,
    index,
    lowerer.coerceInto(expr.right, value, expected),
    arr.type.elem,
    locOf(expr),
  );
}

/** Environment property names use ToPrimitive with the string hint, so
 * checked objects must execute their own conversion hooks. */
export function lowerEnvironmentKey(lowerer: Lowerer, node: ts.Expression): IrExpr {
  const key = lowerer.lowerExpr(node);
  if (key.type.kind === "dyn")
    return { kind: "libCall", fn: "dyn.toStringCoerce", args: [key], type: STRING, loc: key.loc };
  return lowerRecordPropertyKey(lowerer, key, node);
}
