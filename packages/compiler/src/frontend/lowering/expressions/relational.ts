/* instanceof and in, including private-name and runtime-key in. */
import { lowerArrayClassInstanceOf } from "../builtins/array-classes.js";
import { dateRootOf } from "../builtins/date-classes.js";
import { keyedHelperName } from "../stable-names.js";
import * as ts from "../../ts7/adapter.js";
import { builtinClassInstanceOfAny, builtinClassKind } from "../builtins/builtin-class-dyn.js";
import {
  checkedPrivateIn,
  localPrivateBrandClass,
  primitiveOperand,
  privateInMessage,
} from "../private-brands.js";
import type { Lowerer } from "../lowerer.js";
import {
  BOOL,
  BYTES_ELEMENT_NAME,
  CAUGHT,
  DYN,
  F64,
  type IrBytesElem,
  type IrExpr,
  type IrStmt,
  type IrType,
  RUNTIME_ERROR_CLASSES,
  STRING,
  type SrcLoc,
  UNDEFINED_T,
  isUnitType,
  typeEquals,
  typeKey,
} from "../../../ir/ir.js";
import { lowerWebAssemblyInstanceof, refuseWebAssemblyUse } from "../builtins/webassembly.js";
import { lowerSocketInstanceOf } from "../lower-server.js";
import { builtinClassRefOf } from "../builtins/class-values.js";
import { lowerZlibInstanceOf } from "../builtins/compression.js";
import { numLit, strLit, varRef } from "../../../ir/build.js";
import { lowerDisposableStackInstanceOf } from "../builtins/disposable-stack.js";
import { lowerBlobInstanceof } from "../builtins/blob.js";
import { lowerReadlineInstanceof } from "../builtins/readline.js";
import { lowerKeyObjectInstanceof } from "../builtins/key-object.js";
import { lowerCryptoKeyInstanceof } from "../builtins/webcrypto.js";
import { lowerNetAddressInstanceof } from "../builtins/net-address.js";
import { lowerMimeInstanceof } from "../builtins/mime.js";
import { typedArrayHasMember } from "../builtins/typed-array-members.js";
import { fenceEarlyNsMemberRef, nsMemberIdentOf } from "../lower-namespaces.js";
import { maybePromiseInstanceOf } from "../maybe-promise.js";
import { isSafeToDiscard, isSafeToRepeat } from "./evaluation-safety.js";
import { type ClassInfo, storedClassValueType } from "../lower-classes.js";
import { classInstanceOf } from "../class-dynamic-dispatch.js";
import { InternalCompilerError } from "../../../errors.js";
import { tryLowerExpression } from "./try-lower-expression.js";
import { isJsSourceFile, locOf } from "../../program.js";
import { checkedClassInstanceOf } from "../class-construction.js";
import { unsupportedDiag } from "../../../diagnostics/diagnostic.js";
import { globalSymbolKey } from "./global-symbols.js";
import { builtinGlobalHasKey } from "../builtins/global-namespace-keys.js";
import { foldedStringKeyOf } from "./object-literals.js";
import { NARROW_FIRST, sideEffectFreeOptionValue } from "../surfaces.js";
import { isExecExceptionType, refuseExecExceptionCode } from "../builtins/errors.js";
import { hasRuntimeStatics } from "../class-runtime-statics.js";
import { nullProtoRecordShape, recordNullProtoTest } from "../null-prototype.js";

/** The class value an `instanceof` right-hand side holds. A JavaScript
 * object's property holding a program class (`holder.type`) reads as a
 * checked-dynamic value that the checker types as the class: it converts
 * to the class value. Runtime-provided classes keep their own lowering. */
function classValueOperand(
  lowerer: Lowerer,
  right: ts.Expression,
  type: IrType & { kind: "classval" },
): IrExpr {
  if (
    !isJsSourceFile(ts.getSourceFileOfNode(right)) ||
    ts.isIdentifier(right) ||
    lowerer.classes.get(type.className)?.def.runtime
  )
    return lowerer.lowerExpr(right);
  const value = lowerer.lowerExprExpecting(right, DYN);
  if (value.type.kind !== "dyn") return value;
  return { kind: "dynCheck", value, type, loc: locOf(right) };
}

/** The value kinds that never hold an instance of a program class. */
const NO_CLASS_INSTANCE_KINDS: ReadonlySet<IrType["kind"]> = new Set([
  "f64",
  "bigint",
  "date",
  "string",
  "bool",
  "array",
  "map",
  "set",
  "regex",
  "bytes",
  "symbol",
  "promise",
  "undefinedT",
  "nullT",
]);

const PRIMITIVE_WRAPPERS = ["Boolean", "Number", "String", "BigInt", "Symbol"] as const;

/** `x instanceof C` for a program-declared class C. When x's static
 * class and C are both in extends-hierarchies the test is dynamic — the
 * O(1) preorder-interval check against the vtable (`instanceOf` node).
 * Everything else is decided by the static class graph alone and folds
 * to the honest constant: `x instanceof C` is always true when x's
 * static class IS C or descends from it, and always false when the
 * classes are unrelated (a standalone class has no other relatives).
 * Folding is limited to side-effect-free operands — dropping a computed
 * operand would skip its effects, so those are rejected instead. */
export function lowerInstanceOf(lowerer: Lowerer, expr: ts.BinaryExpression, loc: SrcLoc): IrExpr {
  const arrayClassTest = lowerArrayClassInstanceOf(lowerer, expr, loc);
  if (arrayClassTest !== null) return arrayClassTest;
  const webAssembly = lowerWebAssemblyInstanceof(lowerer, expr);
  if (webAssembly !== null) return webAssembly;
  refuseWebAssemblyUse(lowerer, expr.right);
  // `x instanceof net.Socket` over a union with a netSocket arm — the
  // h2 compat 'connect' narrowing (lower-server.ts): a union tag test.
  const sockTest = lowerSocketInstanceOf(lowerer, expr, loc);
  if (sockTest !== null) return sockTest;
  const rightClass = builtinClassRefOf(lowerer, expr.right);
  if (rightClass?.kind === "zlib") return lowerZlibInstanceOf(lowerer, expr, rightClass.mode, loc);

  if (rightClass?.kind === "collection") {
    const collection = rightClass.which === "Map" ? "map" : "set";
    const value = lowerer.lowerExpr(expr.left);
    if (value.type.kind === "union") {
      const union = lowerer.unions.get(value.type.unionId);
      if (union) {
        const local = lowerer.declareHiddenLocal("%collectionTest", value.type);
        const reference = varRef(local.id, value.type, loc);
        let result: IrExpr = { kind: "boolLit", value: false, type: BOOL, loc };
        union.arms.forEach((arm, tag) => {
          if (arm.kind !== collection) return;
          const test: IrExpr = {
            kind: "unionIsTag",
            unionId: union.id,
            value: reference,
            tag,
            negated: false,
            type: BOOL,
            loc,
          };
          result =
            result.kind === "boolLit"
              ? test
              : { kind: "logical", op: "||", left: result, right: test, type: BOOL, loc };
        });
        return {
          kind: "seqExpr",
          stmts: [{ kind: "varDecl", localId: local.id, init: value, loc }],
          result,
          type: BOOL,
          loc,
        };
      }
    }
    if (value.type.kind === "dyn")
      return {
        kind: "libCall",
        fn: collection === "map" ? "dyn.nativeMapIs" : "dyn.nativeSetIs",
        args: [value],
        type: BOOL,
        loc,
      };
    if (value.type.kind === collection)
      return {
        kind: "seqExpr",
        stmts: [{ kind: "exprStmt", expr: value, loc }],
        result: { kind: "boolLit", value: true, type: BOOL, loc },
        type: BOOL,
        loc,
      };
    return {
      kind: "libCall",
      fn: collection === "map" ? "dyn.nativeMapIs" : "dyn.nativeSetIs",
      args: [lowerer.coerceInto(expr.left, value, DYN)],
      type: BOOL,
      loc,
    };
  }
  if (
    lowerer.isStdlibGlobal(expr.right, "WeakMap") ||
    lowerer.isStdlibGlobal(expr.right, "WeakSet")
  ) {
    const value = lowerer.coerceInto(expr.left, lowerer.lowerExpr(expr.left), DYN);
    return {
      kind: "libCall",
      fn: lowerer.isStdlibGlobal(expr.right, "WeakMap") ? "weakMap.is" : "weakSet.is",
      args: [value],
      type: BOOL,
      loc,
    };
  }
  // The primitive wrapper constructors: a compiled program never creates a
  // boxed primitive (`new Boolean(...)` and friends have no lowering), and
  // a primitive is never an instance, so the test is false for every value
  // (typebox's IsBoolean/IsNumber/IsString guards). The operand still runs.
  if (PRIMITIVE_WRAPPERS.some((name) => lowerer.isStdlibGlobal(expr.right, name))) {
    const value = lowerer.lowerExpr(expr.left);
    return {
      kind: "seqExpr",
      stmts: [{ kind: "exprStmt", expr: value, loc }],
      result: { kind: "boolLit", value: false, type: BOOL, loc },
      type: BOOL,
      loc,
    };
  }
  if (lowerer.isStdlibGlobal(expr.right, "FinalizationRegistry")) {
    const value = lowerer.coerceInto(expr.left, lowerer.lowerExpr(expr.left), DYN);
    return { kind: "libCall", fn: "finalizationRegistry.is", args: [value], type: BOOL, loc };
  }
  const rhsBuiltin = ts.isIdentifier(expr.right)
    ? lowerer.builtinImportOf(expr.right)
    : ts.isPropertyAccessExpression(expr.right)
      ? lowerer.builtinMemberOf(expr.right)
      : null;
  if (
    lowerer.isStdlibGlobal(expr.right, "URL") ||
    (rhsBuiltin?.module === "url" && rhsBuiltin.member === "URL")
  ) {
    const value = lowerer.coerceInto(expr.left, lowerer.lowerExpr(expr.left), DYN);
    return { kind: "libCall", fn: "dyn.nativeUrlIs", args: [value], type: BOOL, loc };
  }
  {
    const stack = lowerDisposableStackInstanceOf(lowerer, expr);
    if (stack) return stack;
  }
  if (lowerer.isStdlibGlobal(expr.right, "DataView")) {
    const value = lowerer.coerceInto(expr.left, lowerer.lowerExpr(expr.left), DYN);
    return { kind: "libCall", fn: "dyn.dataViewIs", args: [value], type: BOOL, loc };
  }
  {
    const eventKind = ["Event", "CustomEvent", "EventTarget"].findIndex((name) =>
      lowerer.isStdlibGlobal(expr.right, name),
    );
    if (eventKind >= 0) {
      const value = lowerer.coerceInto(expr.left, lowerer.lowerExpr(expr.left), DYN);
      const kind: IrExpr = { kind: "numLit", value: eventKind, type: F64, loc };
      return { kind: "libCall", fn: "event.is", args: [value, kind], type: BOOL, loc };
    }
  }
  {
    const blob = lowerBlobInstanceof(lowerer, expr);
    if (blob) return blob;
    const keyObject = lowerKeyObjectInstanceof(lowerer, expr);
    if (keyObject) return keyObject;
    const cryptoKey = lowerCryptoKeyInstanceof(lowerer, expr);
    if (cryptoKey) return cryptoKey;
    const netAddress = lowerNetAddressInstanceof(lowerer, expr);
    if (netAddress) return netAddress;
    const mime = lowerMimeInstanceof(lowerer, expr);
    if (mime) return mime;
    const readlineInterface = lowerReadlineInstanceof(lowerer, expr);
    if (readlineInterface) return readlineInterface;
  }
  if (lowerer.isStdlibGlobal(expr.right, "SharedArrayBuffer")) {
    const value = lowerer.coerceInto(expr.left, lowerer.lowerExpr(expr.left), DYN);
    return { kind: "libCall", fn: "sharedArrayBuffer.is", args: [value], type: BOOL, loc };
  }
  if (lowerer.isStdlibGlobal(expr.right, "ArrayBuffer")) {
    const value = lowerer.coerceInto(expr.left, lowerer.lowerExpr(expr.left), DYN);
    return { kind: "libCall", fn: "arrayBuffer.is", args: [value], type: BOOL, loc };
  }
  const rhsSymbol = ts.isIdentifier(expr.right) ? lowerer.resolveValueSymbol(expr.right) : null;
  // `x instanceof events.EventEmitter` — the namespace-member spelling
  // resolves to the same ambient class as the named import.
  const rhsMemberSymbol = (() => {
    if (!ts.isPropertyAccessExpression(expr.right) || !ts.isIdentifier(expr.right.name))
      return null;
    const sym = lowerer.checker.getSymbolAtLocation(expr.right.name);
    return sym && sym.flags & ts.SymbolFlags.Alias
      ? lowerer.checker.getAliasedSymbol(sym)
      : (sym ?? null);
  })();
  // `x instanceof N.C` — the USER-namespace-qualified spelling: the
  // member resolves to the registered program class, with the
  // source-order guard (an init-position test above the class's block
  // would read an uninitialized member in Node).
  const rhsNsClass = (() => {
    if (!ts.isPropertyAccessExpression(expr.right)) return undefined;
    const nsMember = nsMemberIdentOf(lowerer, expr.right);
    if (!nsMember) return undefined;
    const memberSym = lowerer.checker.getSymbolAtLocation(nsMember);
    if (memberSym) fenceEarlyNsMemberRef(lowerer, expr.right, memberSym);
    const classSym = lowerer.resolveValueSymbol(nsMember);
    const nsInfo = classSym ? lowerer.classBySymbol.get(classSym) : undefined;
    // Qualified spellings of a rebindable decorated class (import=
    // alias chains) must not fold against the declaration — the
    // decoration result decides at runtime.
    return nsInfo?.classDecorators?.valueGlobalId !== undefined ? undefined : nsInfo;
  })();
  // A rebindable decorated name as the RHS: the runtime target is the
  // decoration result — fall to the class-VALUE path below, whose
  // instanceOfValue reads the interval off the bound class object.
  const directRhs = rhsSymbol ? lowerer.classBySymbol.get(rhsSymbol) : undefined;
  const target =
    (directRhs?.localClass || directRhs?.classDecorators?.valueGlobalId !== undefined
      ? undefined
      : directRhs) ??
    rhsNsClass ??
    lowerer.builtinErrorInfoOf(rhsSymbol) ??
    lowerer.builtinErrorInfoOf(rhsMemberSymbol) ??
    lowerer.builtinEmitterInfoOf(rhsSymbol) ??
    lowerer.builtinEmitterInfoOf(rhsMemberSymbol) ??
    lowerer.builtinStreamInfoOf(rhsSymbol) ??
    lowerer.builtinStreamInfoOf(rhsMemberSymbol) ??
    undefined;
  if (!target) {
    const date = lowerer.isStdlibGlobal(expr.right, "Date");
    const url = lowerer.isStdlibGlobal(expr.right, "URL");
    // A catch binding holds a thrown Date as its checked-dynamic handle.
    const caughtDate = date ? lowerer.caughtLocalOf(expr.left) : null;
    if (caughtDate)
      return {
        kind: "libCall",
        fn: "dyn.nativeDateIs",
        args: [{ kind: "caughtToDyn", value: varRef(caughtDate.id, CAUGHT, loc), type: DYN, loc }],
        type: BOOL,
        loc,
      };
    if ((date || url) && !lowerer.caughtLocalOf(expr.left)) {
      const value = lowerer.lowerExpr(expr.left);
      if (value.type.kind === "dyn")
        return {
          kind: "libCall",
          fn: date ? "dyn.nativeDateIs" : "dyn.nativeUrlIs",
          args: [value],
          type: BOOL,
          loc,
        };
      if (value.type.kind === "union")
        return {
          kind: "libCall",
          fn: date ? "dyn.nativeDateIs" : "dyn.nativeUrlIs",
          args: [lowerer.coerceInto(expr.left, value, DYN)],
          type: BOOL,
          loc,
        };
      return {
        kind: "seqExpr",
        stmts: [{ kind: "exprStmt", expr: value, loc }],
        result: {
          kind: "boolLit",
          value:
            value.type.kind === (date ? "date" : "url") ||
            // An instance of a class declared `extends Date`.
            (date &&
              value.type.kind === "object" &&
              dateRootOf(lowerer.classes.get(value.type.className)) !== null),
          type: BOOL,
          loc,
        },
        type: BOOL,
        loc,
      };
    }
    const webBrand = ["Request", "Response", "Headers"].find((name) =>
      lowerer.isStdlibGlobal(expr.right, name),
    );
    if (webBrand)
      return {
        kind: "libCall",
        fn: "fetch.webIs",
        args: [
          lowerer.lowerExprExpecting(expr.left, DYN),
          { kind: "strLit", value: webBrand, type: STRING, loc },
        ],
        type: BOOL,
        loc,
      };
    // A codec in untyped storage is its record's handle box.
    const codec = (["TextEncoder", "TextDecoder"] as const).find((name) =>
      lowerer.isStdlibGlobal(expr.right, name),
    );
    if (codec && lowerer.mapTypeOf(lowerer.typeOf(expr.left))?.kind === "dyn") {
      return {
        kind: "libCall",
        fn: "text.codecIs",
        args: [
          lowerer.lowerExprExpecting(expr.left, DYN),
          { kind: "boolLit", value: codec === "TextDecoder", type: BOOL, loc },
        ],
        type: BOOL,
        loc,
      };
    }
    if (lowerer.isStdlibGlobal(expr.right, "ReadableStream")) {
      const value = lowerer.lowerExprExpecting(expr.left, DYN);
      return { kind: "libCall", fn: "fetch.streamIs", args: [value], type: BOOL, loc };
    }
    // Unknown storage retains each numeric typed array's exact native brand.
    if (!lowerer.caughtLocalOf(expr.left)) {
      const elem = (Object.keys(BYTES_ELEMENT_NAME) as IrBytesElem[]).find((kind) =>
        lowerer.isStdlibGlobal(expr.right, BYTES_ELEMENT_NAME[kind]),
      );
      if (elem !== undefined) {
        const left = lowerer.lowerExpr(expr.left);
        if (left.type.kind === "dyn") {
          return { kind: "dynTest", test: "bytes", bytesElem: elem, value: left, type: BOOL, loc };
        }
        return {
          kind: "dynTest",
          test: "bytes",
          bytesElem: elem,
          value: lowerer.coerceInto(expr.left, left, DYN),
          type: BOOL,
          loc,
        };
      }
    }
    // `x instanceof Promise` over a promise-armed union (the maybe-promise
    // `T | Promise<T>` dispatch): a union tag test — the data arms are
    // never promises (scriptc promises are all native, and no data arm
    // can hold one). A promise-typed operand answers true after its
    // evaluation; a checked-dynamic one asks the runtime.
    if (
      ts.isIdentifier(expr.right) &&
      lowerer.isStdlibGlobal(expr.right, "Promise") &&
      !lowerer.caughtLocalOf(expr.left)
    ) {
      const left = lowerer.lowerExpr(expr.left);
      const tagTest = maybePromiseInstanceOf(lowerer, left, loc);
      if (tagTest) return tagTest;
      if (left.type.kind === "dyn")
        return { kind: "dynTest", test: "promise", value: left, type: BOOL, loc };
      if (left.type.kind === "promise") {
        const yes: IrExpr = { kind: "boolLit", value: true, type: BOOL, loc };
        if (isSafeToDiscard(left)) return yes;
        return {
          kind: "seqExpr",
          stmts: [{ kind: "exprStmt", expr: left, loc }],
          result: yes,
          type: BOOL,
          loc,
        };
      }
      // Plain data (records, arrays, strings, numbers, booleans, and unions
      // of them) is never a promise: false after the operand's evaluation.
      const neverPromise = (t: IrType): boolean =>
        NEVER_PROMISE_KINDS.has(t.kind) ||
        (t.kind === "union" && (lowerer.unions.get(t.unionId)?.arms ?? [t]).every(neverPromise));
      if (neverPromise(left.type)) {
        const no: IrExpr = { kind: "boolLit", value: false, type: BOOL, loc };
        if (isSafeToDiscard(left)) return no;
        return {
          kind: "seqExpr",
          stmts: [{ kind: "exprStmt", expr: left, loc }],
          result: no,
          type: BOOL,
          loc,
        };
      }
      lowerer.unsupported(
        "SC1090",
        expr,
        `'instanceof Promise' on '${lowerer.fmt(left.type)}' values (only promises, promise-armed unions, and checked-dynamic values have a lowering)`,
      );
    }
    // `x instanceof RegExp` over a union with a regex arm (the
    // skip-utility `string | RegExp` dispatch): a union tag test — the
    // socket-narrowing shape; the checker types the branches and
    // maybeNarrow bridges the reads. A plain regex-typed LHS folds
    // true; the fold keeps the operand-purity rule of the class folds
    // (identifier reads only).
    if (
      ts.isIdentifier(expr.right) &&
      lowerer.isStdlibGlobal(expr.right, "RegExp") &&
      !lowerer.caughtLocalOf(expr.left)
    ) {
      const left = lowerer.lowerExpr(expr.left);
      if (left.type.kind === "dyn")
        return { kind: "libCall", fn: "dyn.nativeRegexIs", args: [left], type: BOOL, loc };
      if (left.type.kind === "union") {
        const def = lowerer.unions.get(left.type.unionId);
        const tag = def ? def.arms.findIndex((a) => a.kind === "regex") : -1;
        if (tag >= 0) {
          return {
            kind: "unionIsTag",
            unionId: left.type.unionId,
            tag,
            negated: false,
            value: left,
            type: BOOL,
            loc,
          };
        }
      }
      return {
        kind: "libCall",
        fn: "dyn.nativeRegexIs",
        args: [lowerer.coerceInto(expr.left, left, DYN)],
        type: BOOL,
        loc,
      };
    }
    // `x instanceof X` where X is a class VALUE (a classval-typed
    // binding): the target is DYNAMIC — a hierarchy target reads its
    // interval from the class object at runtime (instanceOfValue); a
    // STANDALONE target class has exactly one possible runtime value
    // (itself — no descendants can flow into the slot), so the answer
    // folds statically exactly like the named-target folds below.
    const rhsClassval = storedClassValueType(lowerer, expr.right);
    // A catch binding against a class held by a binding (`var E = class
    // extends Error {}`). The binding holds the declared class or one of its
    // subclasses. Without subclasses the test is the class's caught test,
    // after the right operand's read; otherwise a payload of the declared
    // class is tested against the class the binding holds.
    const caught = lowerer.caughtLocalOf(expr.left);
    const caughtTarget =
      rhsClassval?.kind === "classval" && caught
        ? lowerer.classes.get(rhsClassval.className)
        : undefined;
    if (caught && caughtTarget && !caughtTarget.localClass && !caughtTarget.def.runtime) {
      const classValue = lowerer.lowerExpr(expr.right);
      if (caughtTarget.subclasses.length === 0) {
        return {
          kind: "seqExpr",
          stmts: [{ kind: "exprStmt", expr: classValue, loc }],
          result: caughtClassInstanceOf(lowerer, caught.id, caughtTarget, loc),
          type: BOOL,
          loc,
        };
      }
      if (classValue.type.kind !== "classval")
        lowerer.badType(expr.right, lowerer.typeOf(expr.right));
      const held = lowerer.declareHiddenLocal("%instanceofClass", classValue.type);
      const instance: IrType = { kind: "object", className: caughtTarget.def.name };
      return {
        kind: "seqExpr",
        stmts: [{ kind: "varDecl", localId: held.id, init: classValue, loc }],
        result: {
          kind: "logical",
          op: "&&",
          left: caughtClassInstanceOf(lowerer, caught.id, caughtTarget, loc),
          right: {
            kind: "instanceOfValue",
            value: {
              kind: "caughtNarrow",
              value: varRef(caught.id, CAUGHT, loc),
              type: instance,
              loc,
            },
            classValue: varRef(held.id, classValue.type, loc),
            type: BOOL,
            loc,
          },
          type: BOOL,
          loc,
        },
        type: BOOL,
        loc,
      };
    }
    if (rhsClassval?.kind === "classval" && !caught) {
      const targetInfo =
        lowerer.classes.get(rhsClassval.className) ??
        lowerer.flushDeferredClass(rhsClassval.className);
      if (!targetInfo) {
        // The type world names a class the lowering never registered
        // (a fenced class expression, a deferred declaration): its
        // diagnostics flushed above; poison the test site, never an ICE.
        lowerer.unsupported(
          "SC1090",
          expr,
          "'instanceof' against a class value whose class has no lowering (the class declaration itself was rejected — see its own diagnostic)",
        );
      }
      const left = lowerer.lowerExpr(expr.left);
      if (left.type.kind === "dyn") {
        // An untyped binding the checker narrowed to EventEmitter or a
        // stream class (`ReleaseEmitter = EventEmitter` in JavaScript):
        // the binding holds an untyped constructor, so the test is
        // Function.prototype[Symbol.hasInstance] over it.
        const builtinKind = targetInfo.def.runtime ? builtinClassKind(targetInfo.def.name) : null;
        if (builtinKind !== null) {
          const right = lowerer.lowerExpr(expr.right);
          if (right.type.kind === "dyn")
            return builtinClassInstanceOfAny(lowerer, left, builtinKind, targetInfo, loc, right);
        }
        if (targetInfo.def.runtime) {
          lowerer.unsupported(
            "SC1090",
            expr,
            "'instanceof' through a runtime-provided class value on an untyped value (give the operand a class type first)",
          );
        }
        const classValue = classValueOperand(lowerer, expr.right, rhsClassval);
        return classInstanceOf(lowerer, left, targetInfo, loc, classValue);
      }
      // A union of class instances against a runtime class value (`new K()`
      // through a widened `[Readable, Writable]` element).
      if (left.type.kind === "union" && targetInfo.def.runtime) {
        const tested = unionClassValueInstanceOf(lowerer, left, expr.right, targetInfo, loc);
        if (tested) return tested;
      }
      // A value whose type holds no class instance (a primitive, a native
      // collection, a date, a regex, an array) is never an instance
      // of a program class: false, after both operands evaluate.
      if (!targetInfo.def.runtime && NO_CLASS_INSTANCE_KINDS.has(left.type.kind)) {
        const classValue = classValueOperand(lowerer, expr.right, rhsClassval);
        return {
          kind: "seqExpr",
          stmts: [
            { kind: "exprStmt", expr: left, loc },
            { kind: "exprStmt", expr: classValue, loc },
          ],
          result: { kind: "boolLit", value: false, type: BOOL, loc },
          type: BOOL,
          loc,
        };
      }
      if (left.type.kind !== "object") {
        lowerer.unsupported(
          "SC1090",
          expr,
          "'instanceof' on values other than class instances (narrow union-typed values first)",
        );
      }
      const lhsInfo = lowerer.classes.get(left.type.className);
      if (!lhsInfo)
        throw new InternalCompilerError(`lowerer bug: unknown class ${left.type.className}`);
      if (
        (lowerer.inHierarchy(targetInfo) && lowerer.inHierarchy(lhsInfo)) ||
        (targetInfo.localClass !== undefined && lhsInfo.localClass !== undefined)
      ) {
        const classValue = classValueOperand(lowerer, expr.right, rhsClassval);
        if (classValue.type.kind !== "classval")
          lowerer.badType(expr.right, lowerer.typeOf(expr.right));
        const writableTest = writableClassValueTest(
          lowerer,
          left,
          classValue,
          targetInfo,
          lhsInfo,
          loc,
        );
        if (writableTest) return writableTest;
        return { kind: "instanceOfValue", value: left, classValue, type: BOOL, loc };
      }
      // A standalone side: the answer is static (the target slot can
      // only hold the named class; a standalone operand's runtime class
      // IS its static class). Folding discards the operands' evaluation,
      // so only side-effect-free shapes fold — the named-target rule.
      const value =
        left.type.className === targetInfo.def.name ||
        lowerer.isSubclassOf(left.type.className, targetInfo.def.name);
      if (
        left.kind === "varRef" &&
        (ts.isIdentifier(expr.right) || expr.right.kind === ts.SyntaxKind.ThisKeyword)
      ) {
        return readsClassAfter(lowerer, targetInfo, expr.right, [], {
          kind: "boolLit",
          value,
          type: BOOL,
          loc,
        });
      }
      lowerer.unsupported(
        "SC1090",
        expr,
        "statically-decided 'instanceof' on computed operands (bind the values to variables first)",
      );
    }
    // A checked-dynamic right-hand side (a constructor read from a table, a
    // structural constructor type, a builtin constructor held as `any`):
    // the runtime's instanceof over the value, in both source languages.
    const constructor = tryLowerExpression(lowerer, expr.right);
    if (constructor?.type.kind === "dyn") {
      const value = lowerer.coerceInto(expr.left, lowerer.lowerExpr(expr.left), DYN);
      return checkedClassInstanceOf(
        lowerer,
        value,
        constructor,
        dynInstanceOfRefusal(lowerer, expr),
        loc,
      );
    }
    // `this instanceof Glob` in a JavaScript constructor function: the
    // function's prototype against the value's prototype chain.
    if (
      constructor?.type.kind === "func" &&
      isJsSourceFile(ts.getSourceFileOfNode(expr)) &&
      lowerer.dynConvertible(constructor.type)
    ) {
      const value = lowerer.coerceInto(expr.left, lowerer.lowerExpr(expr.left), DYN);
      return {
        kind: "libCall",
        fn: "dyn.functionInstanceOf",
        args: [value, { kind: "dynFrom", value: constructor, type: DYN, loc }],
        type: BOOL,
        loc,
      };
    }
    lowerer.unsupported(
      "SC1090",
      expr.right,
      "'instanceof' right-hand sides other than classes declared in the program",
    );
  }
  // `x instanceof Writable`: Node's Writable[Symbol.hasInstance] also
  // answers true for streams with a writable side that do not inherit from
  // Writable, which are Duplex and its subclasses (Transform, PassThrough,
  // the zlib streams). Subclasses of Writable keep the prototype test.
  const duplex =
    target.def.name === "%Writable" && target.builtinStream !== undefined
      ? lowerer.classes.get("%Duplex")
      : undefined;
  // The classes whose interval test can answer true for a value of static
  // class `className`: Writable and Duplex are disjoint, so a value typed
  // as one side needs only that side's test.
  const runtimeTests = (className: string): ClassInfo[] => {
    if (!duplex) return [target];
    const mayHold = (info: ClassInfo): boolean =>
      className === info.def.name ||
      lowerer.isSubclassOf(className, info.def.name) ||
      lowerer.isSubclassOf(info.def.name, className);
    const tests = [target, duplex].filter(mayHold);
    return tests.length > 0 ? tests : [target];
  };
  // A catch binding on the left: the runtime test against the class's
  // preorder interval (false for non-hierarchy-object payloads). tsc's
  // narrowing then types the branches; reads bridge through caughtRead.
  const caughtLocal = lowerer.caughtLocalOf(expr.left);
  if (caughtLocal) {
    const caughtInstanceOf = (info: ClassInfo): IrExpr =>
      caughtClassInstanceOf(lowerer, caughtLocal.id, info, loc);
    let test = caughtInstanceOf(target);
    // A thrown checked-dynamic object whose prototype chain reaches
    // Error.prototype (an ES5 constructor function inheriting from it).
    if (target.def.name === "%Error" && lowerer.errorPrototypeValues) {
      const value = varRef(caughtLocal.id, CAUGHT, loc);
      test = {
        kind: "logical",
        op: "||",
        left: test,
        right: {
          kind: "logical",
          op: "&&",
          left: { kind: "caughtTest", value, test: "dynamic", type: BOOL, loc },
          right: {
            kind: "libCall",
            fn: "dyn.inheritsErrorPrototype",
            args: [{ kind: "caughtToDyn", value, type: DYN, loc }],
            type: BOOL,
            loc,
          },
          type: BOOL,
          loc,
        },
        type: BOOL,
        loc,
      };
    }
    return duplex
      ? { kind: "logical", op: "||", left: test, right: caughtInstanceOf(duplex), type: BOOL, loc }
      : test;
  }
  const left = lowerer.lowerExpr(expr.left);
  // `u instanceof Error` on an `unknown` value: the checked-dynamic tree's error encoding
  // (the shape caughtToDyn builds for Error payloads — the reserved
  // "%error" marker) answers the test, so a caught Error passed through
  // an unknown slot narrows like Node (`error instanceof Error ?
  // error.message : String(error)` — the LAN-monitor handler). ROOT
  // only: the marker cannot honestly answer subclass prototype chains
  // (name strings are user-writable), so `u instanceof TypeError` keeps
  // the fence. Reads past the narrow bridge through maybeNarrow's
  // validated %Error extraction. SEMANTICS.md 67.
  if (
    left.type.kind === "dyn" &&
    !target.def.runtime &&
    !target.builtinError &&
    !target.builtinEmitter &&
    !target.builtinStream &&
    !target.localClass
  ) {
    return classInstanceOf(lowerer, left, target, loc);
  }
  if (left.type.kind === "dyn" && target.def.name === "%Error" && !lowerer.errorPrototypeValues) {
    return { kind: "dynTest", test: "error", value: left, type: BOOL, loc };
  }
  // An object whose prototype chain reaches Error.prototype (an ES5
  // constructor function inheriting from it) is an instance as well.
  if (left.type.kind === "dyn" && target.def.name === "%Error") {
    const local = lowerer.declareHiddenLocal("%instanceofValue", DYN);
    const value = varRef(local.id, DYN, loc);
    return {
      kind: "seqExpr",
      stmts: [{ kind: "varDecl", localId: local.id, init: left, loc }],
      result: {
        kind: "logical",
        op: "||",
        left: { kind: "dynTest", test: "error", value, type: BOOL, loc },
        right: {
          kind: "libCall",
          fn: "dyn.inheritsErrorPrototype",
          args: [value],
          type: BOOL,
          loc,
        },
        type: BOOL,
        loc,
      },
      type: BOOL,
      loc,
    };
  }
  // `u instanceof TypeError` (and the other BUILTIN error classes) on a
  // dyn value: the from_error cache holds the checked-dynamic tree↔error identity edge,
  // so the runtime resolves the encoding back to its error and asks the
  // vtable's stamped interval — exact for every error that crossed the
  // boundary (a hand-built {%error} literal answers false: subclass
  // identity is unknowable there). User subclasses keep the fence.
  if (left.type.kind === "dyn" && RUNTIME_ERROR_CLASSES.has(target.def.name)) {
    const rec = RUNTIME_ERROR_CLASSES.get(target.def.name)!;
    return {
      kind: "libCall",
      fn: "dyn.errInstanceof",
      args: [left, { kind: "numLit", value: rec.kind, type: F64, loc }],
      type: BOOL,
      loc,
    };
  }
  // `u instanceof EventEmitter` (or a stream class): an untyped object
  // built by a constructor function inherits the untyped constructor's
  // prototype (builtin-class-dyn.ts), and a compiled emitter or stream
  // boxes as a typed reference the class test answers for.
  const builtinKind = builtinClassKind(target.def.name);
  if (left.type.kind === "dyn" && builtinKind !== null) {
    return builtinClassInstanceOfAny(lowerer, left, builtinKind, target, loc);
  }
  if (left.type.kind === "dyn") {
    lowerer.unsupported(
      "SC1090",
      expr,
      `'instanceof ${target.def.name.replace(/^%/, "")}' on 'unknown' values (only the Error classes answer — test 'instanceof Error' and read '.name')`,
    );
  }
  if (left.type.kind === "union") {
    const unionId = left.type.unionId;
    const arms = lowerer.unions.get(unionId)?.arms;
    // Records, arrays and scalar values are no instances of a class that
    // does not extend Array (lowerArrayClassInstanceOf tests the classes
    // that do). Dynamic/opaque runtime objects keep their existing
    // instanceof fences.
    if (
      arms?.every(
        (arm) =>
          arm.kind === "object" ||
          arm.kind === "record" ||
          arm.kind === "array" ||
          arm.kind === "f64" ||
          arm.kind === "string" ||
          arm.kind === "bool" ||
          arm.kind === "bigint" ||
          arm.kind === "symbol" ||
          isUnitType(arm),
      )
    ) {
      const key = `instanceof.union:${unionId}:${target.def.name}`;
      let helper = lowerer.valueHelpers.get(key);
      if (!helper) {
        helper = keyedHelperName(lowerer, "%instanceof.union", key);
        lowerer.valueHelpers.set(key, helper);
        const value: IrExpr = { kind: "varRef", localId: "value.0", type: left.type, loc };
        const body: IrStmt[] = [];
        arms.forEach((arm, tag) => {
          if (arm.kind !== "object") return;
          const lhsInfo = lowerer.classes.get(arm.className);
          if (!lhsInfo)
            throw new InternalCompilerError(`lowerer bug: unknown class ${arm.className}`);
          const armTest = (info: ClassInfo): IrExpr =>
            lowerer.inHierarchy(lhsInfo) && lowerer.inHierarchy(info)
              ? {
                  kind: "instanceOf",
                  value: { kind: "unionNarrow", unionId, tag, value, type: arm, loc },
                  className: info.def.name,
                  type: BOOL,
                  loc,
                }
              : {
                  kind: "boolLit",
                  value:
                    arm.className === info.def.name ||
                    lowerer.isSubclassOf(arm.className, info.def.name),
                  type: BOOL,
                  loc,
                };
          const result = runtimeTests(arm.className)
            .map(armTest)
            .reduce((left: IrExpr, right: IrExpr): IrExpr => ({
              kind: "logical",
              op: "||",
              left,
              right,
              type: BOOL,
              loc,
            }));
          body.push({
            kind: "if",
            cond: { kind: "unionIsTag", unionId, tag, negated: false, value, type: BOOL, loc },
            then: [{ kind: "return", value: result, loc }],
            else_: null,
            loc,
          });
        });
        body.push({
          kind: "return",
          value: { kind: "boolLit", value: false, type: BOOL, loc },
          loc,
        });
        lowerer.liftedFns.push({
          name: helper,
          params: [{ localId: "value.0", name: "value", type: left.type }],
          returnType: BOOL,
          locals: [{ id: "value.0", name: "value", type: left.type, mutable: false }],
          body,
          loc,
        });
      }
      return { kind: "call", callee: helper, args: [left], type: BOOL, loc };
    }
    // A class arm could hold an instance: the test cannot be decided
    // statically.
    if (arms?.some((arm) => arm.kind === "object"))
      lowerer.unsupported(
        "SC1090",
        expr,
        "'instanceof' on a union of class instances and values without a class prototype test",
      );
  }
  if (left.type.kind !== "object") {
    return readsClassAfter(lowerer, target, expr.right, [{ kind: "exprStmt", expr: left, loc }], {
      kind: "boolLit",
      value: false,
      type: BOOL,
      loc,
    });
  }
  const lhsInfo = lowerer.classes.get(left.type.className);
  if (!lhsInfo)
    throw new InternalCompilerError(`lowerer bug: unknown class ${left.type.className}`);
  if (lowerer.inHierarchy(lhsInfo) && lowerer.inHierarchy(target)) {
    const tests = runtimeTests(left.type.className);
    if (tests.length === 1) {
      return { kind: "instanceOf", value: left, className: tests[0]!.def.name, type: BOOL, loc };
    }
    const local = lowerer.declareHiddenLocal("%writableTest", left.type);
    const ref = varRef(local.id, left.type, loc);
    const test = (className: string): IrExpr => ({
      kind: "instanceOf",
      value: ref,
      className,
      type: BOOL,
      loc,
    });
    return {
      kind: "seqExpr",
      stmts: [{ kind: "varDecl", localId: local.id, init: left, loc }],
      result: {
        kind: "logical",
        op: "||",
        left: test(tests[0]!.def.name),
        right: test(tests[1]!.def.name),
        type: BOOL,
        loc,
      },
      type: BOOL,
      loc,
    };
  }
  const leftClass = left.type.className;
  const isInstance = (className: string): boolean =>
    leftClass === className || lowerer.isSubclassOf(leftClass, className);
  const value =
    isInstance(target.def.name) || (duplex !== undefined && isInstance(duplex.def.name));
  if (left.kind === "varRef") {
    return readsClassAfter(lowerer, target, expr.right, [], {
      kind: "boolLit",
      value,
      type: BOOL,
      loc,
    });
  }
  lowerer.unsupported(
    "SC1090",
    expr,
    "statically-decided 'instanceof' on computed operands (bind the value to a variable first)",
  );
}

/** `x instanceof K` for a union-typed operand whose arms are class
 * instances or unit values: each instance arm tests against the class
 * value (with the Writable rule), unit arms answer false. Null when an arm
 * is anything else. */
function unionClassValueInstanceOf(
  lowerer: Lowerer,
  left: IrExpr,
  right: ts.Expression,
  targetInfo: ClassInfo,
  loc: SrcLoc,
): IrExpr | null {
  if (left.type.kind !== "union") return null;
  const unionId = left.type.unionId;
  const arms = lowerer.unions.get(unionId)?.arms;
  if (
    !arms?.every((arm) => {
      if (arm.kind !== "object") return isUnitType(arm);
      const info = lowerer.classes.get(arm.className);
      return info !== undefined && lowerer.inHierarchy(info);
    })
  )
    return null;
  const classValue = lowerer.lowerExpr(right);
  if (classValue.type.kind !== "classval") lowerer.badType(right, lowerer.typeOf(right));
  const value = lowerer.declareHiddenLocal("%instanceValue", left.type);
  const cls = lowerer.declareHiddenLocal("%instanceClass", classValue.type);
  const valueRef = varRef(value.id, left.type, loc);
  const clsRef = varRef(cls.id, classValue.type, loc);
  let result: IrExpr = { kind: "boolLit", value: false, type: BOOL, loc };
  arms.forEach((arm, tag) => {
    if (arm.kind !== "object") return;
    const narrowed: IrExpr = { kind: "unionNarrow", unionId, tag, value: valueRef, type: arm, loc };
    const lhsInfo = lowerer.classes.get(arm.className)!;
    const test: IrExpr = writableClassValueTest(
      lowerer,
      narrowed,
      clsRef,
      targetInfo,
      lhsInfo,
      loc,
    ) ?? { kind: "instanceOfValue", value: narrowed, classValue: clsRef, type: BOOL, loc };
    result = {
      kind: "ternary",
      cond: { kind: "unionIsTag", unionId, tag, negated: false, value: valueRef, type: BOOL, loc },
      then: test,
      else_: result,
      type: BOOL,
      loc,
    };
  });
  return {
    kind: "seqExpr",
    stmts: [
      { kind: "varDecl", localId: value.id, init: left, loc },
      { kind: "varDecl", localId: cls.id, init: classValue, loc },
    ],
    result,
    type: BOOL,
    loc,
  };
}

/** `x instanceof K` where K is a class value that may hold Writable (a
 * `typeof Writable` or `typeof EventEmitter` slot): Node's
 * Writable[Symbol.hasInstance] also answers true for streams with a
 * writable side that do not inherit from Writable (Duplex and its
 * subclasses), so when K is Writable the Duplex interval answers too.
 * Null when the slot cannot hold Writable or the operand cannot be a
 * Duplex. */
function writableClassValueTest(
  lowerer: Lowerer,
  left: IrExpr,
  classValue: IrExpr,
  targetInfo: ClassInfo,
  lhsInfo: ClassInfo,
  loc: SrcLoc,
): IrExpr | null {
  const writable = lowerer.classes.get("%Writable");
  const duplex = lowerer.classes.get("%Duplex");
  if (!writable || !duplex || classValue.type.kind !== "classval" || left.type.kind !== "object")
    return null;
  const slotHoldsWritable =
    targetInfo === writable || lowerer.isSubclassOf("%Writable", targetInfo.def.name);
  const operandMayBeDuplex =
    lhsInfo === duplex ||
    lowerer.isSubclassOf(lhsInfo.def.name, "%Duplex") ||
    lowerer.isSubclassOf("%Duplex", lhsInfo.def.name);
  if (!slotHoldsWritable || !operandMayBeDuplex) return null;
  lowerer.defineClassValueConstruct(writable);
  const value = lowerer.declareHiddenLocal("%instanceValue", left.type);
  const cls = lowerer.declareHiddenLocal("%instanceClass", classValue.type);
  const valueRef = varRef(value.id, left.type, loc);
  const clsRef = varRef(cls.id, classValue.type, loc);
  return {
    kind: "seqExpr",
    stmts: [
      { kind: "varDecl", localId: value.id, init: left, loc },
      { kind: "varDecl", localId: cls.id, init: classValue, loc },
    ],
    result: {
      kind: "logical",
      op: "||",
      left: { kind: "instanceOfValue", value: valueRef, classValue: clsRef, type: BOOL, loc },
      right: {
        kind: "logical",
        op: "&&",
        left: {
          kind: "bin",
          op: "===",
          left: clsRef,
          right: {
            kind: "classRef",
            className: "%Writable",
            type: { kind: "classval", className: "%Writable" },
            loc,
          },
          type: BOOL,
          loc,
        },
        right: { kind: "instanceOf", value: valueRef, className: "%Duplex", type: BOOL, loc },
        type: BOOL,
        loc,
      },
      type: BOOL,
      loc,
    },
    type: BOOL,
    loc,
  };
}

/** A catch binding tested against a program class: the runtime test against
 * the class's preorder interval (false for non-hierarchy-object payloads). */
function caughtClassInstanceOf(
  lowerer: Lowerer,
  caughtId: string,
  info: ClassInfo,
  loc: SrcLoc,
): IrExpr {
  if (!lowerer.inHierarchy(info)) {
    const value = varRef(caughtId, CAUGHT, loc);
    return {
      kind: "ternary",
      cond: {
        kind: "caughtTest",
        value,
        test: "instanceof",
        className: info.def.name,
        type: BOOL,
        loc,
      },
      then: { kind: "boolLit", value: true, type: BOOL, loc },
      else_: classInstanceOf(lowerer, { kind: "caughtToDyn", value, type: DYN, loc }, info, loc),
      type: BOOL,
      loc,
    };
  }
  return {
    kind: "caughtTest",
    value: { kind: "varRef", localId: caughtId, type: CAUGHT, loc },
    test: "instanceof",
    className: info.def.name,
    type: BOOL,
    loc,
  };
}

/** A statically decided `instanceof` still reads its class after the left
 * operand: a class with an initialization flag throws there before its
 * declaration ran. */
function readsClassAfter(
  lowerer: Lowerer,
  target: ClassInfo,
  right: ts.Expression,
  stmts: IrStmt[],
  result: IrExpr,
): IrExpr {
  if (!lowerer.classInitFlags.has(target.def.name)) {
    if (stmts.length === 0) return result;
    return { kind: "seqExpr", stmts, result, type: result.type, loc: result.loc };
  }
  const read = lowerer.lowerExpr(right);
  return {
    kind: "seqExpr",
    stmts: [...stmts, { kind: "exprStmt", expr: read, loc: locOf(right) }],
    result,
    type: result.type,
    loc: result.loc,
  };
}

/** `#name in obj` — the ergonomic brand check. In this closed world a
 * brand is held by exactly the instances of the declaring class
 * (subclasses included — construction always runs the declaring class's
 * own initializers), so the test IS `obj instanceof <declaring class>`:
 * statically decided when the receiver's class sits at/below the
 * declarer (true) or in a disjoint subtree (false) — both folds under
 * the instanceof purity rule — and a runtime interval test when the
 * declarer sits strictly BELOW the receiver's static class (the
 * narrowing use; tsc types the true branch at the class, and reads
 * bridge through maybeNarrow's downcast exactly like instanceof). tsc
 * confines the spelling to the declaring class's body and rejects
 * primitive/unknown receivers, so Node's in-operator TypeError is
 * unreachable in compilable programs. Timing residue: JS installs
 * brands DURING construction, so a check reachable from a base
 * constructor can observe false mid-construction where this answers
 * true (SEMANTICS.md). */
function lowerPrivateIn(
  lowerer: Lowerer,
  expr: ts.BinaryExpression,
  priv: ts.PrivateIdentifier,
  loc: SrcLoc,
): IrExpr {
  const pname = priv.text;
  // The declaring class: the nearest enclosing class declaring the name
  // (JS scoping — an inner class's spelling shadows an outer one's).
  let classDecl: ts.ClassLikeDeclaration | null = null;
  let staticBrand = false;
  for (let n: ts.Node | undefined = priv.parent; n; n = n.parent) {
    if (ts.isClassDeclaration(n) || ts.isClassExpression(n)) {
      const owner = n.members.nodes.find((m) => {
        const name = (m as { name?: ts.PropertyName }).name;
        return name !== undefined && ts.isPrivateIdentifier(name) && name.text === pname;
      });
      if (owner) {
        classDecl = n;
        staticBrand =
          ts.canHaveModifiers(owner) &&
          ts.getModifiers(owner)?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword) === true;
        break;
      }
    }
  }
  // tsc rejects the spelling outside a declaring class body; defensive.
  if (!classDecl)
    lowerer.unsupported("SC1090", expr, `'${pname} in …' outside a class declaring '${pname}'`);
  if (staticBrand) {
    lowerer.unsupported(
      "SC1090",
      expr,
      `'${pname} in …' brand checks for private STATICS (JS brands the declaring class OBJECT, not instances — compare against the class value directly)`,
    );
  }
  const info =
    lowerer.currentClass?.decl === classDecl
      ? lowerer.currentClass
      : (() => {
          const sym = classDecl.name
            ? lowerer.checker.getSymbolAtLocation(classDecl.name)
            : undefined;
          return sym ? lowerer.classBySymbol.get(sym) : undefined;
        })();
  if (!info) {
    lowerer.unsupported(
      "SC1090",
      expr,
      `'${pname} in …' where the declaring class has no lowering (see the class declaration's own diagnostic)`,
    );
  }
  // A GENERIC family: JS has ONE runtime class and ONE brand for every
  // instantiation, while these layouts mint one class per instantiation
  // — a cross-instantiation check would answer false where Node says
  // true, so the family reports SC1090 instead of splitting the brand.
  if (info.generic || info.genericInstance) {
    lowerer.unsupported(
      "SC1090",
      expr,
      `'${pname} in …' inside a generic class (JS shares one brand across every instantiation; these layouts mint one class per instantiation)`,
    );
  }
  const recv = lowerer.lowerExpr(expr.right);
  const declName = info.def.name;
  // A UNION of class instances (`o: Counter | Helper` — the
  // discriminating use): every object arm answers membership STATICALLY
  // (at/below the declarer → true, disjoint subtree → false), so the
  // whole test collapses to runtime TAG tests — the record-shape 'in'
  // discrimination, brand form. An arm ABOVE the declarer answers per
  // VALUE (its slot can hold branded and unbranded instances), and
  // non-object arms have no brand story — both fence.
  if (recv.type.kind === "union") {
    const unionId = recv.type.unionId;
    const arms = lowerer.unions.get(unionId)?.arms ?? [];
    const answers: { tag: number; has: boolean }[] = [];
    let staticAnswers = arms.length > 0;
    for (const arm of arms) {
      const tag = lowerer.armTag(unionId, arm);
      if (tag < 0 || arm.kind !== "object" || lowerer.isSubclassOf(declName, arm.className)) {
        staticAnswers = false;
        break;
      }
      answers.push({
        tag,
        has: arm.className === declName || lowerer.isSubclassOf(arm.className, declName),
      });
    }
    if (staticAnswers) {
      const pureRecv =
        recv.kind === "varRef" || recv.kind === "recordGet" || recv.kind === "fieldGet";
      const isTag = (tag: number, negated: boolean): IrExpr => ({
        kind: "unionIsTag",
        unionId,
        tag,
        negated,
        value: recv,
        type: BOOL,
        loc,
      });
      const trues = answers.filter((a) => a.has);
      if (trues.length === answers.length || trues.length === 0) {
        const ans = trues.length !== 0;
        if (pureRecv) return { kind: "boolLit", value: ans, type: BOOL, loc };
        // Constant either way, receiver still evaluates once: one tag
        // test whose branches agree (the record-'in' rule verbatim).
        return {
          kind: "ternary",
          cond: isTag(answers[0]!.tag, false),
          then: { kind: "boolLit", value: ans, type: BOOL, loc },
          else_: { kind: "boolLit", value: ans, type: BOOL, loc },
          type: BOOL,
          loc,
        };
      }
      if (trues.length === 1) return isTag(trues[0]!.tag, false);
      const falses = answers.filter((a) => !a.has);
      if (falses.length === 1) return isTag(falses[0]!.tag, true);
      if (pureRecv) {
        let out: IrExpr = isTag(trues[0]!.tag, false);
        for (const t of trues.slice(1)) {
          out = {
            kind: "logical",
            op: "||",
            left: out,
            right: isTag(t.tag, false),
            type: BOOL,
            loc,
          };
        }
        return out;
      }
      lowerer.unsupported(
        "SC1090",
        expr,
        `statically-decided '${pname} in …' on computed receivers (bind the value to a variable first)`,
      );
    }
  }
  // A checked value in JavaScript (`#x in this` inside a method, whose
  // receiver is the actual call-site value): the brand is present exactly
  // when the value is a class instance at or below the declarer. A typed
  // reference carries the class it was boxed under: the declarer or a
  // descendant answers true; an ancestor answers per instance.
  if (
    recv.type.kind === "dyn" &&
    recv.kind === "varRef" &&
    isJsSourceFile(ts.getSourceFileOfNode(expr))
  ) {
    // A function-local class has one brand per evaluation.
    if (info.localClass) {
      const owner = localPrivateBrandClass(lowerer, priv);
      if (!owner) {
        lowerer.unsupported(
          "SC1090",
          expr,
          `'${pname} in …' inside a function-local class that is not a named declaration`,
        );
      }
      return checkedPrivateIn(lowerer, owner.info, owner.decl, pname, recv, loc);
    }
    const typedRefIs = (className: string): IrExpr => ({
      kind: "libCall",
      fn: "dyn.typedRefIs",
      args: [
        recv,
        { kind: "strLit", value: typeKey({ kind: "object", className }), type: STRING, loc },
      ],
      type: BOOL,
      loc,
    });
    const or = (left: IrExpr | null, right: IrExpr): IrExpr =>
      left === null ? right : { kind: "logical", op: "||", left, right, type: BOOL, loc };
    let test: IrExpr | null = null;
    const below = (c: ClassInfo): void => {
      test = or(test, typedRefIs(c.def.name));
      for (const sub of c.subclasses) below(sub);
    };
    below(info);
    for (let base = info.base; base; base = base.base) {
      const baseType: IrType = { kind: "object", className: base.def.name };
      test = or(test, {
        kind: "logical",
        op: "&&",
        left: typedRefIs(base.def.name),
        right: {
          kind: "instanceOf",
          value: { kind: "dynCheck", value: recv, type: baseType, loc },
          className: declName,
          type: BOOL,
          loc,
        },
        type: BOOL,
        loc,
      });
    }
    // Only objects carry private names: a primitive operand throws Node's
    // TypeError.
    return {
      kind: "ternary",
      cond: primitiveOperand(recv, loc),
      then: {
        kind: "libCall",
        fn: "error.nodeThrow",
        args: [numLit(1, loc), strLit("", loc), privateInMessage(pname, recv, loc)],
        type: BOOL,
        loc,
      },
      else_: test!,
      type: BOOL,
      loc,
    };
  }
  if (recv.type.kind !== "object") {
    lowerer.unsupported(
      "SC1090",
      expr,
      `'${pname} in …' on '${lowerer.fmt(recv.type)}' receivers (only class-instance receivers — and unions of classes below or beside the declarer — have a static brand answer; narrow first)`,
    );
  }
  const lhsName = recv.type.className;
  const lhsInfo = lowerer.classes.get(lhsName);
  if (!lhsInfo) throw new InternalCompilerError(`lowerer bug: unknown class ${lhsName}`);
  if (lowerer.isSubclassOf(declName, lhsName)) {
    // The narrowing direction: the declarer strictly below the
    // receiver's static class — a strict subclass relation puts both in
    // a hierarchy, so the vtable interval test always exists.
    return { kind: "instanceOf", value: recv, className: declName, type: BOOL, loc };
  }
  const value = lhsName === declName || lowerer.isSubclassOf(lhsName, declName);
  if (recv.kind === "varRef") return { kind: "boolLit", value, type: BOOL, loc };
  lowerer.unsupported(
    "SC1090",
    expr,
    `statically-decided '${pname} in …' on computed operands (bind the value to a variable first)`,
  );
}

/** The string keys every record inherits from Object.prototype. */
/** Keys built-in errors carry outside their class fields: Node's system
 * error properties, and AggregateError's, SuppressedError's and
 * AssertionError's own members. */
const BUILTIN_ERROR_SLOT_KEYS: ReadonlySet<string> = new Set([
  "errno",
  "syscall",
  "path",
  "dest",
  "info",
  "errors",
  "error",
  "suppressed",
  "actual",
  "expected",
  "operator",
  "generatedMessage",
]);

const OBJECT_PROTOTYPE_KEYS: ReadonlySet<string> = new Set([
  "constructor",
  "__defineGetter__",
  "__defineSetter__",
  "hasOwnProperty",
  "__lookupGetter__",
  "__lookupSetter__",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toString",
  "valueOf",
  "__proto__",
  "toLocaleString",
]);

/** `"key" in v` — the key-presence test. Three lowered receivers:
 * process.env (getenv(3) presence — Node-exact, an empty value still
 * counts as present), and monomorphic record shapes, where the answer is
 * type-directed: a declared non-optional field is a compile-time `true`,
 * a missing field (no index signature) a compile-time `false` unless
 * Object.prototype has it — both
 * folds limited to side-effect-free receivers, the lowerInstanceOf rule —
 * and an OPTIONAL field (undefined-armed union) is a runtime presence
 * test on the slot: an omitted or deleted property is absent, while a
 * property explicitly holding `undefined` is present, as in JS
 * (`"a" in {a: undefined}` is true). Union receivers (the `in`-narrowing
 * idiom over multiple shapes), index-signature keys, class instances,
 * and dyn/unknown stay fenced. Keys are literal strings — a computed key
 * over a shape would need the runtime key table. */
export function lowerInExpression(
  lowerer: Lowerer,
  expr: ts.BinaryExpression,
  loc: SrcLoc,
): IrExpr {
  if (
    lowerer.isStdlibGlobal(expr.right, "process") &&
    lowerer.foldedStringKeyOf(expr.left) === "hrtime"
  ) {
    return { kind: "boolLit", value: true, type: BOOL, loc };
  }
  const globalKey = globalSymbolKey(lowerer, expr.right, expr.left);
  if (globalKey)
    return { kind: "libCall", fn: "dyn.globalSymbolHas", args: [globalKey], type: BOOL, loc };
  // `#name in obj` — the ergonomic brand check (ES2022) — resolves
  // before any string-key machinery: the left operand is a private
  // NAME, not a value.
  if (ts.isPrivateIdentifier(expr.left)) {
    return lowerPrivateIn(lowerer, expr, expr.left, loc);
  }
  // Compile-time-known STRING keys fold — literals, and the same
  // const/enum-literal and template folding computed property keys get
  // (foldedStringKeyOf); runtime-valued keys keep the fence.
  // NUMERIC literal keys answer on ARRAY receivers through the shared
  // presence query. Arrays retain holes independently from length, and
  // noncanonical numeric keys live in their ordinary-property table, so
  // a length comparison is not an honest `in` answer.
  {
    let kNode = expr.left;
    while (ts.isParenthesizedExpression(kNode)) kNode = kNode.expression;
    if (
      ts.isNumericLiteral(kNode) &&
      lowerer.mapTypeOf(lowerer.typeOf(expr.right))?.kind === "array"
    ) {
      const recvArr = lowerer.lowerExpr(expr.right);
      if (recvArr.type.kind === "array") {
        const n = Number(kNode.text);
        return {
          kind: "arrayHas",
          arr: recvArr,
          index: { kind: "numLit", value: n, type: F64, loc },
          type: BOOL,
          loc,
        };
      }
    }
  }
  // A RUNTIME numeric key over an ARRAY receiver (`if (i in arr)` in a
  // loop) asks the same slot/property presence query as the literal fold
  // above and `Object.hasOwn`. The checked-dynamic fallback below would
  // box the receiver and materialize every element on each evaluation,
  // which makes such loops quadratic. A Number key never names an
  // inherited property: neither Array.prototype nor Object.prototype has
  // index-like or numeric-string keys. JS evaluates the key before the
  // receiver, so the key is stabilized in a hidden local first.
  if (
    lowerer.mapTypeOf(lowerer.typeOf(expr.left))?.kind === "f64" &&
    lowerer.mapTypeOf(lowerer.typeOf(expr.right))?.kind === "array"
  ) {
    const k = lowerer.lowerExpr(expr.left);
    const recvArr = lowerer.lowerExpr(expr.right);
    if (k.type.kind === "f64" && recvArr.type.kind === "array") {
      const keyLocal = lowerer.declareHiddenLocal("%inIndex", F64);
      return {
        kind: "seqExpr",
        stmts: [{ kind: "varDecl", localId: keyLocal.id, init: k, loc }],
        result: {
          kind: "arrayHas",
          arr: recvArr,
          index: varRef(keyLocal.id, F64, loc),
          type: BOOL,
          loc,
        },
        type: BOOL,
        loc,
      };
    }
  }
  const key = foldedStringKeyOf(lowerer, expr.left);
  if (key === null) {
    // A RUNTIME string key over an INDEX-SIGNATURE record receiver (the
    // `names.filter((k) => k in config)` idiom): the interned key-
    // presence helper — declared fields answer statically per name
    // (optional slots by their runtime presence), then the overflow
    // map's live keys. Other receivers keep the
    // fence: fixed shapes want the literal folds above, and there is no
    // runtime key table to ask.
    const rIn = lowerRuntimeKeyIn(lowerer, expr, loc);
    if (rIn) return rIn;
    // A runtime key over a CHECKED-DYNAMIC receiver (`name in
    // agent.sockets` — both sides computed; the checker may type the
    // receiver as a Dict while the VALUE lives in the checked-dynamic tree, so the
    // LOWERED type decides): the dyn presence answer, with the key
    // stringified like every property key (o[k] is o[String(k)] in JS;
    // `in` shares the coercion).
    {
      const probed = tryLowerExpression(lowerer, expr.right);
      if (probed && lowerer.dynConvertible(probed.type)) {
        const k = lowerer.lowerExpr(expr.left); // JS order: the key evaluates first
        if (lowerer.dynConvertible(k.type)) {
          const boxed = lowerer.coerceToExpected(k, DYN);
          const keyLocal = lowerer.declareHiddenLocal("%inKey", DYN);
          return {
            kind: "seqExpr",
            stmts: [{ kind: "varDecl", localId: keyLocal.id, init: boxed, loc }],
            result: {
              kind: "libCall",
              fn: "dyn.hasKeyComputed",
              args: [
                lowerer.coerceToExpected(lowerer.lowerExpr(expr.right), DYN),
                varRef(keyLocal.id, DYN, loc),
              ],
              type: BOOL,
              loc,
            },
            type: BOOL,
            loc,
          };
        }
      }
    }
    lowerer.unsupported(
      "SC1090",
      expr.left,
      "'in' with computed (non-literal) keys (a const whose type is one string literal folds; a string-typed key answers over index-signature record receivers)",
    );
  }
  // A feature probe on a builtin constructor global (`"captureStackTrace"
  // in Error`): the global is a fixed object, so the answer is static.
  {
    let recvNode = expr.right;
    while (ts.isParenthesizedExpression(recvNode)) recvNode = recvNode.expression;
    if (ts.isIdentifier(recvNode) && lowerer.isStdlibGlobal(recvNode, recvNode.text)) {
      const has = builtinGlobalHasKey(recvNode.text, key);
      if (has !== null) return { kind: "boolLit", value: has, type: BOOL, loc };
    }
  }
  // A receiver re-read (the static folds below) is safe for plain reads
  // AND for side-effect-free expressions (an object literal of literals
  // — the `"a" in { a: true }` shape).
  const pureRecvNode = sideEffectFreeOptionValue(expr.right);
  if (lowerer.isProcessEnv(expr.right)) {
    // `"NO_COLOR" in process.env`: presence via the one envGet intrinsic —
    // getenv(3) returning non-NULL is Node's `in` on process.env exactly.
    const envType = lowerer.envValueType();
    if (envType.kind !== "union")
      throw new InternalCompilerError("lowerer bug: env value type is not a union");
    const undefTag = lowerer.armTag(envType.unionId, UNDEFINED_T);
    const read: IrExpr = {
      kind: "libCall",
      fn: "process.envGet",
      args: [{ kind: "strLit", value: key, type: STRING, loc }],
      type: envType,
      loc,
    };
    return {
      kind: "unionIsTag",
      unionId: envType.unionId,
      tag: undefTag,
      negated: true,
      value: read,
      type: BOOL,
      loc,
    };
  }
  if (key === "code" && isExecExceptionType(lowerer, lowerer.typeOf(expr.right))) {
    refuseExecExceptionCode(lowerer, expr);
  }
  // A literal key that names no declared member of an index-signature
  // record (`"id" in match.groups`): the same keyed presence probe a
  // runtime key takes — declared fields by name, then the overflow keys.
  {
    const recvT = lowerer.mapTypeOf(lowerer.typeOf(expr.right));
    const shape = recvT?.kind === "record" ? lowerer.shapes.get(recvT.shapeId) : undefined;
    if (
      shape?.indexValue &&
      !shape.tuple &&
      !OBJECT_PROTOTYPE_KEYS.has(key) &&
      !shape.fields.some(
        (f) => f.name === key || f.name === `%get:${key}` || f.name === `%set:${key}`,
      )
    ) {
      const probed = lowerRuntimeKeyIn(lowerer, expr, loc);
      if (probed) return probed;
    }
  }
  let recv = lowerer.lowerExpr(expr.right);
  const classInfo =
    recv.type.kind === "classval" ? lowerer.classes.get(recv.type.className) : undefined;
  if (
    (classInfo && (classInfo.callableBase || hasRuntimeStatics(classInfo))) ||
    (isJsSourceFile(ts.getSourceFileOfNode(expr)) &&
      recv.type.kind === "func" &&
      lowerer.dynConvertible(recv.type))
  ) {
    recv = lowerer.coerceToExpected(recv, DYN);
  }
  const siteType = lowerer.mapTypeOf(lowerer.typeOf(expr.right));
  if (
    recv.type.kind === "union" &&
    siteType?.kind === "union" &&
    !typeEquals(recv.type, siteType)
  ) {
    const helper = lowerer.narrowedRetagHelper(
      expr.right,
      recv.type.unionId,
      siteType.unionId,
      loc,
    );
    if (helper) recv = { kind: "call", callee: helper, args: [recv], type: siteType, loc };
  }
  // A builtin class held as a brand record (TextEncoder, TextDecoder: only
  // `%`-prefixed internal fields): its members are the class's prototype
  // members, which the standard library declares, so `"encodeInto" in
  // encoder` answers from the checker's type, plus Object.prototype's keys.
  // The receiver evaluates for its effects.
  if (recv.type.kind === "record") {
    const shape = lowerer.shapes.get(recv.type.shapeId);
    if (shape && shape.fields.length > 0 && shape.fields.every((f) => f.name.startsWith("%"))) {
      const declared =
        lowerer.checker.getPropertyOfType(lowerer.typeOf(expr.right), key) !== undefined;
      const answer: IrExpr = {
        kind: "boolLit",
        value: declared || OBJECT_PROTOTYPE_KEYS.has(key),
        type: BOOL,
        loc,
      };
      if (recv.kind === "varRef") return answer;
      return {
        kind: "seqExpr",
        stmts: [{ kind: "exprStmt", expr: recv, loc }],
        result: answer,
        type: BOOL,
        loc,
      };
    }
  }
  // Error-rooted receivers (builtin or user subclass — the isErrnoException
  // predicate's `err instanceof Error && "code" in err` shape): `code`
  // answers from the runtime error's code slot (stamped by fs/system/
  // event/spawn errors, absent on plain constructions — exactly Node's
  // own-property answer), and the always-present members (message, name,
  // stack, Object.prototype's keys, members the static class declares)
  // fold true. Other keys test the declaring subclasses and the error's
  // own runtime properties; keys of built-in errors' extra slots fence.
  if (recv.type.kind === "object") {
    // %DOMException first: `'cause' in e` answers the options form's
    // own-property record (the runtime slot), and code/name/message are
    // always present.
    if (recv.type.className === "%DOMException") {
      if (key === "cause") {
        return { kind: "libCall", fn: "error.domHasCause", args: [recv], type: BOOL, loc };
      }
      if (
        (key === "code" || key === "message" || key === "name") &&
        (recv.kind === "varRef" || recv.kind === "caughtNarrow")
      ) {
        return { kind: "boolLit", value: true, type: BOOL, loc };
      }
    }
    let info = lowerer.classes.get(recv.type.className) ?? null;
    while (info && info.base) info = info.base;
    if (info?.def.name === "%Error") {
      if (key === "cause") {
        return { kind: "libCall", fn: "error.hasCause", args: [recv], type: BOOL, loc };
      }
      // The code slot, or an own `code` with another value
      // (`err.code = undefined` is present).
      if (key === "code") {
        return { kind: "libCall", fn: "error.hasCode", args: [recv], type: BOOL, loc };
      }
      // The receiver evaluates for its effects when the answer is static.
      const always = (): IrExpr =>
        recv.kind === "varRef" || recv.kind === "caughtNarrow"
          ? { kind: "boolLit", value: true, type: BOOL, loc }
          : {
              kind: "seqExpr",
              stmts: [{ kind: "exprStmt", expr: recv, loc }],
              result: { kind: "boolLit", value: true, type: BOOL, loc },
              type: BOOL,
              loc,
            };
      if (key === "message" || key === "name") return always();
      // Every Error has its own `stack`, and Error.prototype's `toString`
      // and `constructor` are among Object.prototype's keys.
      if (key === "stack" || OBJECT_PROTOTYPE_KEYS.has(key)) return always();
      // A member the static class declares is always present.
      const declares = (c: ClassInfo): boolean =>
        c.fields.has(key) ||
        lowerer.findMethodOn(c, key) !== null ||
        lowerer.findMethodOn(c, `get:${key}`) !== null ||
        lowerer.findMethodOn(c, `set:${key}`) !== null;
      const staticInfo = lowerer.classes.get(recv.type.className);
      if (staticInfo && declares(staticInfo)) return always();
      // Any other key: a descendant class that declares it (instanceof), or
      // an own property set at runtime (a throw site's extra fields,
      // Object.assign, writes through a dynamic view). Keys built-in errors
      // keep outside their class fields depend on the runtime error and
      // stay fenced.
      if (!BUILTIN_ERROR_SLOT_KEYS.has(key)) {
        const stable = recv.kind === "varRef" || recv.kind === "caughtNarrow";
        const slot = stable ? null : lowerer.declareHiddenLocal("%inRecv", recv.type);
        const ref = (): IrExpr => (slot ? varRef(slot.id, recv.type, loc) : recv);
        const tests: IrExpr[] = [];
        const staticName = recv.type.className;
        for (const c of lowerer.classes.values()) {
          const name = c.def.name;
          if (name === staticName || !lowerer.isSubclassOf(name, staticName) || !declares(c))
            continue;
          // A declaring ancestor below the static class already covers it.
          if (c.base && c.base.def.name !== staticName && declares(c.base)) continue;
          tests.push({ kind: "instanceOf", value: ref(), className: name, type: BOOL, loc });
        }
        tests.push({
          kind: "libCall",
          fn: "error.hasKey",
          args: [ref(), { kind: "strLit", value: key, type: STRING, loc }],
          type: BOOL,
          loc,
        });
        const answer = tests.reduce((acc, test) => ({
          kind: "logical",
          op: "||",
          left: acc,
          right: test,
          type: BOOL,
          loc,
        }));
        if (!slot) return answer;
        return {
          kind: "seqExpr",
          stmts: [{ kind: "varDecl", localId: slot.id, init: recv, loc }],
          result: answer,
          type: BOOL,
          loc,
        };
      }
      lowerer.unsupported(
        "SC1090",
        expr,
        `'in' with the key '${key}' on Error receivers (code answers from the error's code slot; message and name are always present)`,
      );
    }
  }
  // A dyn receiver (`"portless" in pkg` after the `typeof pkg ===
  // "object"` guard): own-member presence on the checked-dynamic tree — tsc admits `in`
  // only on object-typed operands, so unit receivers are unreachable.
  if (recv.type.kind === "dyn") {
    return { kind: "dynHasKey", key, value: recv, type: BOOL, loc };
  }
  // `"k" in u` over a UNION whose arms are FIXED record shapes: every
  // arm answers membership STATICALLY (a declared non-optional field is
  // always present, an undeclared name never is), so the whole test
  // collapses to runtime TAG tests — tsc's own narrowing then types the
  // branches (the discriminating-`in` idiom). An arm declaring the key
  // as an optional (undefined-armed) slot answers per VALUE instead:
  // its tag test joins that payload's presence test (see
  // perValueUnionIn). Tuple/index-signature arms keep the fence below.
  if (recv.type.kind === "union") {
    const unionId = recv.type.unionId;
    const arms = lowerer.unions.get(unionId)?.arms ?? [];
    const answers: { tag: number; has: boolean | "slot"; arm: IrType }[] = [];
    let staticAnswers = arms.length > 0;
    for (const arm of arms) {
      const tag = lowerer.armTag(unionId, arm);
      const shape = arm.kind === "record" ? lowerer.shapes.get(arm.shapeId) : undefined;
      if (tag < 0 || !shape || shape.tuple || shape.indexValue) {
        staticAnswers = false;
        break;
      }
      const f = shape.fields.find((x) => x.name === key);
      const inherited = OBJECT_PROTOTYPE_KEYS.has(key);
      if (
        f &&
        !inherited &&
        f.type.kind === "union" &&
        lowerer.armTag(f.type.unionId, UNDEFINED_T) >= 0
      ) {
        answers.push({ tag, has: "slot", arm }); // presence is per-value
        continue;
      }
      // Accessor properties are own properties to `in` (Node answers
      // true without invoking the getter) — either slot present makes
      // the name a member.
      const acc = shape.fields.some((x) => x.name === `%get:${key}` || x.name === `%set:${key}`);
      answers.push({ tag, has: f !== undefined || acc || inherited, arm });
    }
    if (staticAnswers && answers.some((a) => a.has === "slot")) {
      return perValueUnionIn(lowerer, recv, unionId, key, answers, loc);
    }
    if (staticAnswers) {
      const pureRecv =
        recv.kind === "varRef" ||
        recv.kind === "recordGet" ||
        recv.kind === "fieldGet" ||
        pureRecvNode;
      const isTag = (tag: number, negated: boolean): IrExpr => ({
        kind: "unionIsTag",
        unionId,
        tag,
        negated,
        value: recv,
        type: BOOL,
        loc,
      });
      const trues = answers.filter((a) => a.has);
      if (trues.length === answers.length || trues.length === 0) {
        // Constant either way — but JS still EVALUATES the operand (it
        // may throw: an ambient-const read is a ReferenceError). Pure
        // reads fold; anything else rides one tag test whose branches
        // agree, evaluating the receiver exactly once.
        const ans = trues.length !== 0;
        if (pureRecv) return { kind: "boolLit", value: ans, type: BOOL, loc };
        return {
          kind: "ternary",
          cond: isTag(answers[0]!.tag, false),
          then: { kind: "boolLit", value: ans, type: BOOL, loc },
          else_: { kind: "boolLit", value: ans, type: BOOL, loc },
          type: BOOL,
          loc,
        };
      }
      // One deciding arm (either polarity): a single tag test, receiver
      // evaluated once — no purity requirement.
      if (trues.length === 1) return isTag(trues[0]!.tag, false);
      const falses = answers.filter((a) => !a.has);
      if (falses.length === 1) return isTag(falses[0]!.tag, true);
      // Several arms on each side: the OR chain re-reads the receiver,
      // so only side-effect-free reads qualify.
      if (pureRecv) {
        let out: IrExpr = isTag(trues[0]!.tag, false);
        for (const t of trues.slice(1)) {
          out = {
            kind: "logical",
            op: "||",
            left: out,
            right: isTag(t.tag, false),
            type: BOOL,
            loc,
          };
        }
        return out;
      }
      lowerer.unsupported(
        "SC1090",
        expr,
        "statically-decided 'in' on computed receivers (bind the value to a variable first)",
      );
    }
  }
  // A literal member name over a typed array (`"BYTES_PER_ELEMENT" in a`):
  // the answer is Node's prototype chain for the value's kind. Numeric keys
  // (elements) and Buffer-only names on a Uint8Array depend on the value and
  // keep the fence.
  if (recv.type.kind === "bytes" && key !== "-0" && String(Number(key)) !== key) {
    const has = typedArrayHasMember(key, recv.type.elem === "u8");
    if (has !== null) {
      const answer: IrExpr = { kind: "boolLit", value: has, type: BOOL, loc };
      return isSafeToDiscard(recv)
        ? answer
        : {
            kind: "seqExpr",
            stmts: [{ kind: "exprStmt", expr: recv, loc }],
            result: answer,
            type: BOOL,
            loc,
          };
    }
  }
  // A child process has `send`, `disconnect` and `channel` only when it was
  // created with an IPC channel (fork, or an "ipc" stdio entry), and keeps
  // them after the channel closes: the runtime answers from the child.
  if (recv.type.kind === "child" && CHILD_CHANNEL_MEMBERS.has(key))
    return { kind: "libCall", fn: "child.hasChannel", args: [recv], type: BOOL, loc };
  // A native Node handle (an http.Server, a socket, a child process...):
  // a member Node's declarations give the class is on its prototype, so
  // `"closeAllConnections" in server` answers true. Undeclared names can
  // still be real (internal `_`-prefixed fields), so they keep the fence.
  if (
    NATIVE_HANDLE_KINDS.has(recv.type.kind) &&
    nodeDeclaredMember(lowerer, lowerer.typeOf(expr.right), key)
  ) {
    const answer: IrExpr = { kind: "boolLit", value: true, type: BOOL, loc };
    return isSafeToDiscard(recv)
      ? answer
      : {
          kind: "seqExpr",
          stmts: [{ kind: "exprStmt", expr: recv, loc }],
          result: answer,
          type: BOOL,
          loc,
        };
  }
  if (recv.type.kind !== "record") {
    lowerer.unsupported(
      "SC1090",
      expr,
      `'in' on '${lowerer.fmt(recv.type)}' receivers (only process.env, Error instances, record-typed values, and unions of fixed record shapes answer; ${NARROW_FIRST})`,
    );
  }
  const shape = lowerer.shapes.get(recv.type.shapeId);
  if (!shape) throw new InternalCompilerError(`lowerer bug: unknown shape ${recv.type.shapeId}`);
  const field = shape.fields.find((f) => f.name === key);
  if (field) {
    if (
      !OBJECT_PROTOTYPE_KEYS.has(key) &&
      field.type.kind === "union" &&
      lowerer.armTag(field.type.unionId, UNDEFINED_T) >= 0
    ) {
      // Optional slot: the key is present unless the field is absent
      // (omitted or deleted); an explicit undefined is present.
      return lowerer.recordFieldPresent(recv, recv.type.shapeId, key, loc);
    }
    // A declared non-optional field always exists on every value of the
    // shape — statically true, but folding may only drop a
    // side-effect-free receiver read.
    if (
      recv.kind === "varRef" ||
      recv.kind === "recordGet" ||
      recv.kind === "fieldGet" ||
      pureRecvNode
    ) {
      return { kind: "boolLit", value: true, type: BOOL, loc };
    }
    lowerer.unsupported(
      "SC1090",
      expr,
      "statically-decided 'in' on computed receivers (bind the value to a variable first)",
    );
  }
  // Accessor properties answer `in` as own members (Node: true, getter
  // NOT invoked) — statically true under the same purity discipline as
  // declared non-optional fields.
  if (shape.fields.some((f) => f.name === `%get:${key}` || f.name === `%set:${key}`)) {
    if (
      recv.kind === "varRef" ||
      recv.kind === "recordGet" ||
      recv.kind === "fieldGet" ||
      pureRecvNode
    ) {
      return { kind: "boolLit", value: true, type: BOOL, loc };
    }
    lowerer.unsupported(
      "SC1090",
      expr,
      "statically-decided 'in' on computed receivers (bind the value to a variable first)",
    );
  }
  // Records are ordinary objects: Object.prototype's members are in them.
  const inherited = OBJECT_PROTOTYPE_KEYS.has(key);
  if (shape.indexValue && !inherited) {
    lowerer.unsupported(
      "SC1090",
      expr,
      "'in' over index-signature keys (read the key and test '!== undefined' instead)",
    );
  }
  if (
    recv.kind === "varRef" ||
    recv.kind === "recordGet" ||
    recv.kind === "fieldGet" ||
    pureRecvNode
  ) {
    // A null-prototype record (Object.groupBy) has no inherited names.
    const nullProtoT = inherited ? nullProtoRecordShape(lowerer, recv.type) : null;
    if (nullProtoT) {
      return {
        kind: "unary",
        op: "!",
        operand: recordNullProtoTest(recv, nullProtoT.shapeId, loc),
        type: BOOL,
        loc,
      };
    }
    return { kind: "boolLit", value: inherited, type: BOOL, loc };
  }
  lowerer.unsupported(
    "SC1090",
    expr,
    "statically-decided 'in' on computed receivers (bind the value to a variable first)",
  );
}

/** `"k" in u` over a union of fixed record shapes where some arm declares
 * `k` as an optional slot. Arms without the name answer false and arms
 * with an always-present member answer true, both by tag; an optional
 * slot answers its payload's own-property presence (an explicit
 * undefined is present, an omitted or deleted property is not), read
 * through the checked arm extraction the tag test has just proven. The
 * receiver evaluates once: a non-repeatable one is stabilized in a
 * hidden local first. */
function perValueUnionIn(
  lowerer: Lowerer,
  recv: IrExpr,
  unionId: string,
  key: string,
  answers: readonly { tag: number; has: boolean | "slot"; arm: IrType }[],
  loc: SrcLoc,
): IrExpr {
  const recvType = recv.type;
  const stable = isSafeToRepeat(recv) ? null : lowerer.declareHiddenLocal("%inRecv", recvType);
  const ref = (): IrExpr => (stable ? varRef(stable.id, recvType, loc) : recv);
  const isTag = (tag: number): IrExpr => ({
    kind: "unionIsTag",
    unionId,
    tag,
    negated: false,
    value: ref(),
    type: BOOL,
    loc,
  });
  let out: IrExpr | null = null;
  for (const a of answers) {
    if (a.has === false) continue;
    let test = isTag(a.tag);
    if (a.has === "slot" && a.arm.kind === "record") {
      test = {
        kind: "logical",
        op: "&&",
        left: test,
        right: {
          kind: "recordHas",
          obj: {
            kind: "unionNarrow",
            unionId,
            tag: a.tag,
            value: ref(),
            type: a.arm,
            loc,
          },
          shapeId: a.arm.shapeId,
          field: key,
          type: BOOL,
          loc,
        },
        type: BOOL,
        loc,
      };
    }
    out = out ? { kind: "logical", op: "||", left: out, right: test, type: BOOL, loc } : test;
  }
  const result: IrExpr = out ?? { kind: "boolLit", value: false, type: BOOL, loc };
  if (!stable) return result;
  return {
    kind: "seqExpr",
    stmts: [{ kind: "varDecl", localId: stable.id, init: recv, loc }],
    result,
    type: BOOL,
    loc,
  };
}

/** The runtime-key `in` (see lowerInExpression): `k in r` where k is a
 * runtime string and r an index-signature record — an interned
 * `%rec.haskey.<n>(k, r)` walks the declared names (a string-equality
 * chain: non-optional fields and accessor slots answer true, optional
 * slots answer their per-value tag test) and then probes the overflow
 * map's hashed key set. Null when the pair is outside that shape (the
 * caller keeps its fence). */
function lowerRuntimeKeyIn(
  lowerer: Lowerer,
  expr: ts.BinaryExpression,
  loc: SrcLoc,
): IrExpr | null {
  if (lowerer.mapTypeOf(lowerer.typeOf(expr.left))?.kind !== "string") return null;
  const recvT = lowerer.mapTypeOf(lowerer.typeOf(expr.right));
  if (recvT?.kind !== "record") return null;
  const shape = lowerer.shapes.get(recvT.shapeId);
  if (!shape?.indexValue || shape.tuple) return null;
  const keyIr = lowerer.lowerExprExpecting(expr.left, STRING);
  const recv = lowerer.lowerExprExpecting(expr.right, recvT);
  const hkey = `haskey:${recvT.shapeId}`;
  let helper = lowerer.valueHelpers.get(hkey);
  if (!helper) {
    helper = keyedHelperName(lowerer, "%rec.haskey", hkey);
    lowerer.valueHelpers.set(hkey, helper);
    const recT: IrType = { kind: "record", shapeId: recvT.shapeId };

    const k = varRef("k.0", STRING, loc);
    const r = varRef("r.0", recT, loc);
    const body: IrStmt[] = [];
    const ret = (value: IrExpr): IrStmt => ({ kind: "return", value, loc });
    for (const f of shape.fields) {
      const accessor = f.name.startsWith("%get:") || f.name.startsWith("%set:");
      if (f.name.startsWith("%") && !accessor) continue;
      const name = accessor ? f.name.slice(5) : f.name;
      const eq: IrExpr = {
        kind: "strEq",
        negated: false,
        left: k,
        right: { kind: "strLit", value: name, type: STRING, loc },
        type: BOOL,
        loc,
      };
      const answer: IrExpr = accessor
        ? { kind: "boolLit", value: true, type: BOOL, loc }
        : lowerer.recordFieldPresent(r, recvT.shapeId, f.name, loc);
      body.push({ kind: "if", cond: eq, then: [ret(answer)], else_: null, loc });
    }
    // Overflow keys answer through the map's hashed presence probe (a
    // stored undefined value is still present), not a scan over a fresh
    // key snapshot, which made `k in dict` loops quadratic.
    const ovfHas: IrExpr = {
      kind: "recordOvfHas",
      obj: r,
      shapeId: recvT.shapeId,
      key: k,
      type: BOOL,
      loc,
    };
    // A miss in the record's own keys still finds Object.prototype's,
    // unless the record has a null prototype (Object.groupBy).
    let protoName: IrExpr | null = null;
    for (const name of OBJECT_PROTOTYPE_KEYS) {
      if (shape.fields.some((f) => f.name === name)) continue;
      const eq: IrExpr = {
        kind: "strEq",
        negated: false,
        left: k,
        right: { kind: "strLit", value: name, type: STRING, loc },
        type: BOOL,
        loc,
      };
      protoName =
        protoName === null
          ? eq
          : { kind: "logical", op: "||", left: protoName, right: eq, type: BOOL, loc };
    }
    if (protoName !== null && nullProtoRecordShape(lowerer, recT)) {
      protoName = {
        kind: "logical",
        op: "&&",
        left: protoName,
        right: {
          kind: "unary",
          op: "!",
          operand: recordNullProtoTest(r, recvT.shapeId, loc),
          type: BOOL,
          loc,
        },
        type: BOOL,
        loc,
      };
    }
    body.push(
      ret(
        protoName === null
          ? ovfHas
          : { kind: "logical", op: "||", left: ovfHas, right: protoName, type: BOOL, loc },
      ),
    );
    lowerer.liftedFns.push({
      name: helper,
      params: [
        { localId: "k.0", name: "k", type: STRING },
        { localId: "r.0", name: "r", type: recT },
      ],
      returnType: BOOL,
      locals: [
        { id: "k.0", name: "k", type: STRING, mutable: true },
        { id: "r.0", name: "r", type: recT, mutable: true },
      ],
      body,
      loc,
    });
  }
  return { kind: "call", callee: helper, args: [keyIr, recv], type: BOOL, loc };
}

/** The SC1090 message `x instanceof C` throws, with the site's position,
 * when `C` is a runtime constructor with no instance test. */
function dynInstanceOfRefusal(lowerer: Lowerer, expr: ts.BinaryExpression): string {
  const diag = unsupportedDiag("SC1090", locOf(expr), "instanceof against this native constructor");
  const sf = ts.getSourceFileOfNode(expr);
  const line = ts.getLineAndCharacterOfPosition(sf, diag.loc.start).line + 1;
  return `${diag.message} [${diag.code} at ${diag.loc.file}:${line}]`;
}

/** IR kinds of native Node handles whose members come from Node's own
 * declarations. */
const NATIVE_HANDLE_KINDS: ReadonlySet<IrType["kind"]> = new Set([
  "netServer",
  "netSocket",
  "httpReq",
  "httpRes",
  "httpClientReq",
  "child",
  "dgramSocket",
  "fsWatcher",
  "http2Session",
  "http2Stream",
]);

/** Child process members that exist only on a child with an IPC channel. */
const CHILD_CHANNEL_MEMBERS: ReadonlySet<string> = new Set(["send", "disconnect", "channel"]);

/** Whether every constituent of `t` declares a required member `key` in
 * a declaration file (Node's @types/node). */
function nodeDeclaredMember(lowerer: Lowerer, t: ts.Type, key: string): boolean {
  const parts = t.isUnionType() ? ts.constituentTypes(t) : [t];
  return parts.every((part) => {
    const prop = lowerer.checker.getPropertyOfType(part, key);
    if (prop === undefined || (prop.flags & ts.SymbolFlags.Optional) !== 0) return false;
    return (
      prop.declarations.length > 0 &&
      prop.declarations.every((d) => ts.getSourceFileOfNode(d).isDeclarationFile)
    );
  });
}

const NEVER_PROMISE_KINDS: ReadonlySet<IrType["kind"]> = new Set([
  "record",
  "array",
  "string",
  "f64",
  "bool",
  "bigint",
  "date",
  "map",
  "set",
  "regex",
  "bytes",
  "symbol",
  "nullT",
  "undefinedT",
]);
