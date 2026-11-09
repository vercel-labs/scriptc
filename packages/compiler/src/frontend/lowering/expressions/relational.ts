/* instanceof and in, including private-name and runtime-key in. */
import { consoleHasKey, isConsoleExpression } from "../coercions/console-records.js";
import { lowerIteratorInstanceOf } from "../iterator-prototype.js";
import { programCreatesWrappers, WRAPPER_KIND_NUMBER } from "../primitive-wrappers.js";
import { boxedHandleReceiver } from "../handle-properties.js";
import { lowerArrayClassInstanceOf } from "../builtins/array-classes.js";
import { dateRootOf } from "../builtins/date-classes.js";
import { keyedHelperName } from "../stable-names.js";
import { lowerWebStreamInstanceof } from "../builtins/web-streams-dyn.js";
import * as ts from "../../ts7/adapter.js";
import { builtinClassInstanceOfAny, builtinClassKind } from "../builtins/builtin-class-dyn.js";
import {
  checkedPrivateIn,
  localPrivateBrandClass,
  primitiveOperand,
  privateInMessage,
} from "../private-brands.js";
import type { Lowerer } from "../lowerer.js";
import { callableBox, isCallableValue } from "../callable-properties.js";
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
import { builtinModuleHasMember } from "../builtin-module-members.js";
import {
  builtinNamespaceMemberTest,
  reflectOverNamespaceExpr,
} from "../builtin-namespace-probe.js";
import { nodeThrowExpr, numLit, strLit, varRef } from "../../../ir/build.js";
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
import { lowerGlobalObjectValue } from "../lower-global-value.js";
import { stringPropertyKey } from "../lower-exprs.js";
import { isSafeToDiscard, isSafeToRepeat } from "./evaluation-safety.js";
import { inOperatorTypeError, isPrimitiveValueType, throwAfterEach } from "../primitive-throws.js";
import { partialFieldPresence } from "../partial-assertions.js";
import {
  classDeclaresHasInstanceHook,
  findGenericMethodOn,
  parameterPropertiesFirst,
  type ClassInfo,
  storedClassValueType,
} from "../lower-classes.js";
import { classInstanceOf } from "../class-dynamic-dispatch.js";
import { InternalCompilerError } from "../../../errors.js";
import { tryLowerExpression } from "./try-lower-expression.js";
import { assertedInOperand } from "./asserted-receiver.js";
import { isJsSourceFile, locOf } from "../../program.js";
import { checkedClassInstanceOf } from "../class-construction.js";
import { unsupportedDiag } from "../../../diagnostics/diagnostic.js";
import { globalSymbolKey } from "./global-symbols.js";
import { hostAbsentInstall, isGlobalObjectRead } from "../host-globals.js";
import { globalObjectPresentNamesArg } from "../global-object-names.js";
import { hasGlobalFunctionValue } from "../global-function-values.js";
import { builtinGlobalHasKey } from "../builtins/global-namespace-keys.js";
import { foldedStringKeyOf } from "./object-literals.js";
import { NARROW_FIRST, sideEffectFreeOptionValue, stdlibGlobalNameOf } from "../surfaces.js";
import { isExecExceptionType, refuseExecExceptionCode } from "../builtins/errors.js";
import { hasRuntimeStatics } from "../class-runtime-statics.js";
import { nullProtoRecordShape, recordNullProtoTest } from "../null-prototype.js";
import { recordMayKeepSource } from "../record-sources.js";
import { recordHasOwnHelper } from "../lower-calls.js";
import { hostGlobalConstructorOfPrototype, hostGlobalNameOfRead } from "../host-globals.js";

/** The registered class behind the class type of a test's operand. A class
 * whose collection was refused is deferred, not registered, and a type can
 * still name it (a parameter, a union arm, a declared result). Naming it
 * here flushes that refusal, which reports at the class, and the test is
 * refused with it: the class has no layout to test against. */
function operandClass(lowerer: Lowerer, className: string, expr: ts.Node, test: string): ClassInfo {
  const info = lowerer.classes.get(className) ?? lowerer.flushDeferredClass(className);
  if (info) return info;
  if (!lowerer.deferredClassByName.has(className))
    throw new InternalCompilerError(`lowerer bug: unknown class ${className}`);
  lowerer.unsupported(
    "SC1090",
    expr,
    `${test} on a value whose type names '${lowerer.fmt({ kind: "object", className })}', a class that has no lowering (the class declaration itself was rejected — see its own diagnostic)`,
  );
}

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

/** The known answer of an `instanceof` test on a listed Node global's value,
 * after the left operand's evaluation (kept for its effects, as Node runs
 * it before the test). */
function hostGlobalInstanceOfAnswer(
  lowerer: Lowerer,
  expr: ts.BinaryExpression,
  answer: boolean,
  loc: SrcLoc,
): IrExpr {
  const value = lowerer.coerceInto(expr.left, lowerer.lowerExpr(expr.left), DYN);
  return {
    kind: "seqExpr",
    stmts: [{ kind: "exprStmt", expr: value, loc }],
    result: { kind: "boolLit", value: answer, type: BOOL, loc },
    type: BOOL,
    loc,
  };
}

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
  const iteratorTest = lowerIteratorInstanceOf(lowerer, expr, loc);
  if (iteratorTest !== null) return iteratorTest;
  // A listed Node global's value is a constructor native code never created
  // an instance from, so `x instanceof X` is false for every value — an
  // ordinary function's [[Prototype]] included, which the generic walk
  // cannot read and would throw its unsupported-getPrototypeOf error for.
  // The value is itself a Function instance, as Node's class is; the
  // runtime's generic walk stops at the object that terminates the value's
  // prototype chain, so that one answer is folded here too. The operand
  // still runs, as Node evaluates it before the test.
  if (hostGlobalNameOfRead(lowerer, expr.right) !== null)
    return hostGlobalInstanceOfAnswer(lowerer, expr, false, loc);
  if (lowerer.isStdlibGlobal(expr.right, "Function")) {
    // A function a Node island made is a Function instance, as it is in
    // Node, where the package and the program share one realm.
    if (lowerer.islandFunctionType(lowerer.typeOf(expr.left)))
      return hostGlobalInstanceOfAnswer(lowerer, expr, true, loc);
    const value =
      hostGlobalNameOfRead(lowerer, expr.left) ??
      hostGlobalConstructorOfPrototype(lowerer, expr.left);
    if (value !== null) return hostGlobalInstanceOfAnswer(lowerer, expr, true, loc);
  }
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
    // In a program that creates wrappers, a checked-dynamic value may be
    // one: the kind's prototype on its chain decides.
    const wrapperKind = (["String", "Number", "Boolean"] as const).find((name) =>
      lowerer.isStdlibGlobal(expr.right, name),
    );
    if (
      wrapperKind &&
      value.type.kind === "dyn" &&
      (lowerer.createsWrappers ??= programCreatesWrappers(lowerer))
    )
      return {
        kind: "libCall",
        fn: "wrapper.instanceOf",
        args: [value, { kind: "numLit", value: WRAPPER_KIND_NUMBER[wrapperKind], type: F64, loc }],
        type: BOOL,
        loc,
      };
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
  // `x instanceof URLSearchParams`: the brand of the value an untyped slot
  // holds for one, as for URL above.
  if (
    lowerer.isStdlibGlobal(expr.right, "URLSearchParams") ||
    (rhsBuiltin?.module === "url" && rhsBuiltin.member === "URLSearchParams")
  ) {
    const value = lowerer.coerceInto(expr.left, lowerer.lowerExpr(expr.left), DYN);
    return { kind: "libCall", fn: "dyn.nativeSearchParamsIs", args: [value], type: BOOL, loc };
  }
  // `x instanceof Buffer` in TypeScript: Buffer is the one byte view with a
  // brand of its own beside its element kind. JavaScript holds the
  // constructor as a value and tests against that (below).
  if (
    (lowerer.isStdlibGlobal(expr.right, "Buffer") ||
      (rhsBuiltin?.module === "buffer" && rhsBuiltin.member === "Buffer")) &&
    !isJsSourceFile(ts.getSourceFileOfNode(expr)) &&
    !lowerer.caughtLocalOf(expr.left)
  ) {
    const value = lowerer.coerceInto(expr.left, lowerer.lowerExpr(expr.left), DYN);
    return { kind: "dynTest", test: "buffer", value, type: BOOL, loc };
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
    const webStream = lowerWebStreamInstanceof(lowerer, expr);
    if (webStream) return webStream;
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
    // A catch binding holds a thrown promise as its checked-dynamic value.
    {
      const caughtPromise =
        ts.isIdentifier(expr.right) && lowerer.isStdlibGlobal(expr.right, "Promise")
          ? lowerer.caughtLocalOf(expr.left)
          : null;
      if (caughtPromise)
        return {
          kind: "dynTest",
          test: "promise",
          value: {
            kind: "caughtToDyn",
            value: varRef(caughtPromise.id, CAUGHT, loc),
            type: DYN,
            loc,
          },
          type: BOOL,
          loc,
        };
    }
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
      // of them) is never a promise, and neither is a class instance (no
      // program class extends Promise): false after the operand's evaluation.
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
      // A class that declares a static `Symbol.hasInstance` hook answers
      // through the hook: the caught payload reaches it as a checked-dynamic
      // value, exactly as a thrown value reaches Node's hook.
      if (classDeclaresHasInstanceHook(caughtTarget)) {
        return checkedClassInstanceOf(
          lowerer,
          { kind: "caughtToDyn", value: varRef(caught.id, CAUGHT, loc), type: DYN, loc },
          lowerer.coerceToExpected(classValue, DYN),
          dynInstanceOfRefusal(lowerer, expr),
          loc,
        );
      }
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
      // The class declares a static `Symbol.hasInstance` hook (its bases
      // included, through the static prototype chain): Node asks the hook
      // first and uses OrdinaryHasInstance only when it is absent, so the
      // test runs the checked-dynamic class test against the class value.
      if (!targetInfo.def.runtime && classDeclaresHasInstanceHook(targetInfo)) {
        const classValue = classValueOperand(lowerer, expr.right, rhsClassval);
        return checkedClassInstanceOf(
          lowerer,
          lowerer.coerceInto(expr.left, left, DYN),
          lowerer.coerceToExpected(classValue, DYN),
          dynInstanceOfRefusal(lowerer, expr),
          loc,
        );
      }
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
        // A checked-dynamic class value (`for (const C of [A, B])`: tsc's
        // common supertype names the first class, but the slot holds either
        // class at run time): the test dispatches on the class the value IS,
        // like any other untyped right-hand side. Using the statically named
        // class's prototype here answered false for every other class.
        if (classValue.type.kind === "dyn")
          return checkedClassInstanceOf(
            lowerer,
            left,
            classValue,
            dynInstanceOfRefusal(lowerer, expr),
            loc,
          );
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
      const lhsInfo = operandClass(lowerer, left.type.className, expr, "'instanceof'");
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
      // The answer is static (a standalone operand's runtime class IS its
      // static class), but the operands are computed: Node evaluates both,
      // so evaluate them and return the known answer.
      const classValue = classValueOperand(lowerer, expr.right, rhsClassval);
      return {
        kind: "seqExpr",
        stmts: [
          { kind: "exprStmt", expr: left, loc },
          { kind: "exprStmt", expr: classValue, loc },
        ],
        result: { kind: "boolLit", value, type: BOOL, loc },
        type: BOOL,
        loc,
      };
    }
    // A builtin global function value read off the global (`parseInt`,
    // `Symbol`, `WeakRef`, ...) is not a class value: the boxed value has
    // no prototype to test against, so the test is refused.
    if (
      isJsSourceFile(ts.getSourceFileOfNode(expr)) &&
      hasGlobalFunctionValue(stdlibGlobalNameOf(lowerer, expr.right) ?? "")
    ) {
      lowerer.unsupported(
        "SC1090",
        expr.right,
        "'instanceof' right-hand sides other than classes declared in the program",
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
    // A built-in class that has no test of its own above: name it, and
    // what a program can test instead.
    const builtinClass =
      stdlibGlobalNameOf(lowerer, expr.right) ??
      (rhsBuiltin ? `${rhsBuiltin.module}.${rhsBuiltin.member}` : null);
    if (builtinClass !== null) {
      lowerer.unsupported(
        "SC1090",
        expr.right,
        `'instanceof ${builtinClass}' (this built-in class has no run-time class test yet: test what the value has instead, ` +
          `such as \`typeof value === "object" && value !== null && "member" in value\`)`,
      );
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
    // A class that declares a static `Symbol.hasInstance` hook answers
    // through the hook whatever the operand's static type: the caught
    // payload reaches it as a checked-dynamic value, exactly as a thrown
    // value reaches Node's hook.
    if (!target.def.runtime && classDeclaresHasInstanceHook(target)) {
      const classValue = classValueOperand(lowerer, expr.right, {
        kind: "classval",
        className: target.def.name,
      });
      return checkedClassInstanceOf(
        lowerer,
        { kind: "caughtToDyn", value: varRef(caughtLocal.id, CAUGHT, loc), type: DYN, loc },
        lowerer.coerceToExpected(classValue, DYN),
        dynInstanceOfRefusal(lowerer, expr),
        loc,
      );
    }
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
  // A program class that declares a static `Symbol.hasInstance` hook (its
  // bases included, through the static prototype chain): Node asks the
  // hook first and uses OrdinaryHasInstance only when it is absent, so the
  // test runs the checked-dynamic class test against the class value,
  // whatever the operand's static type is.
  if (!target.def.runtime && classDeclaresHasInstanceHook(target)) {
    const classValue = classValueOperand(lowerer, expr.right, {
      kind: "classval",
      className: target.def.name,
    });
    return checkedClassInstanceOf(
      lowerer,
      lowerer.coerceInto(expr.left, left, DYN),
      lowerer.coerceToExpected(classValue, DYN),
      dynInstanceOfRefusal(lowerer, expr),
      loc,
    );
  }
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
    // that do), and neither is a promise: every compiled promise is the
    // standard library's own, and no program class extends it. Dynamic/opaque
    // runtime objects keep their existing instanceof fences.
    if (
      arms?.every(
        (arm) =>
          arm.kind === "object" ||
          arm.kind === "promise" ||
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
      // Every class arm is resolved before the helper is named: an arm
      // whose class was rejected refuses this test, and must not leave a
      // helper name behind that no function defines.
      for (const arm of arms)
        if (arm.kind === "object") operandClass(lowerer, arm.className, expr, "'instanceof'");
      const key = `instanceof.union:${unionId}:${target.def.name}`;
      let helper = lowerer.valueHelpers.get(key);
      if (!helper) {
        helper = keyedHelperName(lowerer, "%instanceof.union", key);
        lowerer.valueHelpers.set(key, helper);
        const value: IrExpr = { kind: "varRef", localId: "value.0", type: left.type, loc };
        const body: IrStmt[] = [];
        arms.forEach((arm, tag) => {
          if (arm.kind !== "object") return;
          const lhsInfo = operandClass(lowerer, arm.className, expr, "'instanceof'");
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
  const lhsInfo = operandClass(lowerer, left.type.className, expr, "'instanceof'");
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
  // A program class target: the answer is static (the operand's runtime
  // class IS its static class), but the operands are computed. Node
  // evaluates both, so evaluate them and return the known answer.
  if (target.decl !== null && !target.def.runtime) {
    const classValue = classValueOperand(lowerer, expr.right, {
      kind: "classval",
      className: target.def.name,
    });
    return {
      kind: "seqExpr",
      stmts: [
        { kind: "exprStmt", expr: left, loc },
        { kind: "exprStmt", expr: classValue, loc },
      ],
      result: { kind: "boolLit", value, type: BOOL, loc },
      type: BOOL,
      loc,
    };
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
  operandClass(lowerer, lhsName, expr, `'${pname} in …'`);
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

export const OBJECT_PROTOTYPE_KEYS: ReadonlySet<string> = new Set([
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

/** The declarers of `key` on an instance of a compiled class: a declared
 * field (inherited included in `fields`), a method, an accessor half, or a
 * generic member (a generic method or a generic function field, which live
 * in their own table and have no field slot). */
function declaresInstanceMember(lowerer: Lowerer, info: ClassInfo, key: string): boolean {
  if (OBJECT_PROTOTYPE_KEYS.has(key)) return true;
  return (
    info.fields.has(key) ||
    lowerer.findMethodOn(info, key) !== null ||
    lowerer.findMethodOn(info, `get:${key}`) !== null ||
    lowerer.findMethodOn(info, `set:${key}`) !== null ||
    findGenericMethodOn(lowerer, info, key) !== null
  );
}

/** A member one class spells in its own source (no base-chain walk): the
 * subclass check below only cares about what the class itself adds. */
function declaresOwnMember(info: ClassInfo, key: string): boolean {
  if (info.fields.has(key) || info.methods.has(key) || info.genericMethods?.has(key) === true)
    return true;
  return info.methods.has(`get:${key}`) || info.methods.has(`set:${key}`);
}

/** `classInstanceIn`'s answer: a static boolean, "the declaration lacks the
 * key but a subclass may declare it" (the caller resolves it with class
 * tests), or "the declaration cannot answer" (runtime-provided root,
 * unknown class). */
type ClassInAnswer = boolean | "below" | "unknown";

/** `classInstanceIn`'s subclass guard: a subclass whose values land in THIS
 * arm (it is not an arm of the union itself) that declares `key` makes the
 * arm's static `false` a lie. An arm of the union is tagged with its own
 * arm, so its subtree answers there and is skipped. */
function subclassDeclares(
  info: ClassInfo,
  key: string,
  armNames: ReadonlySet<string> | null,
): boolean {
  for (const sub of info.subclasses) {
    if (armNames?.has(sub.def.name)) continue;
    if (declaresOwnMember(sub, key)) return true;
    if (subclassDeclares(sub, key, armNames)) return true;
  }
  return false;
}

/** The program subclasses below `info` that declare `key` themselves (the
 * class tests a "below" answer ranges over): a subclass whose declaring
 * ancestor already answered is covered by that ancestor's test. */
function declaringSubclasses(info: ClassInfo, key: string, out: string[] = []): string[] {
  for (const sub of info.subclasses) {
    if (declaresOwnMember(sub, key)) out.push(sub.def.name);
    else declaringSubclasses(sub, key, out);
  }
  return out;
}

/** `'k' in instance` for a compiled class: every declared member is present
 * on every instance (a class field is defined at construction whether or
 * not it holds `undefined`, and a method lives on the prototype), so
 * membership answers STATICALLY from the declaration — exactly Node's
 * answer. `"unknown"` when the declaration cannot answer for the value:
 * runtime-provided roots (`decl === null`, the Error/EventEmitter/stream/
 * EventTarget/Date/Array families) expose members their declaration does
 * not spell. A class with an index signature answers the same way: its
 * declared members are on every instance, and a name it does not declare
 * is not declared, so the caller asks the instance (classAnswersAtRuntime).
 * `armNames` are the
 * class arms of the union whose arm this is (null for a single-class
 * receiver): a subclass that is itself an arm is tagged with that arm, so
 * only the other subclasses can lie about this arm's `false`. */
function classInstanceIn(
  lowerer: Lowerer,
  className: string,
  key: string,
  armNames: ReadonlySet<string> | null,
): ClassInAnswer {
  const info = lowerer.classes.get(className);
  if (!info) return "unknown";
  for (let c: ClassInfo | null = info; c; c = c.base) {
    // `decl === null` marks the runtime-provided roots (%Error and the
    // families below): their members come from the runtime, not a
    // declaration this can read.
    if (
      c.decl === null ||
      c.builtinError ||
      c.builtinEmitter ||
      c.builtinStream ||
      c.builtinEventTarget ||
      c.extendsDate ||
      c.extendsArray
    )
      return "unknown";
  }
  if (declaresInstanceMember(lowerer, info, key)) return true;
  if (subclassDeclares(info, key, armNames)) return "below";
  return false;
}

/** Whether `'key' in instance` must read the instance's own property state
 * instead of answering from the declaration. Two shapes cannot answer from
 * a declaration: a JAVASCRIPT class whose field layout is created by
 * assignment (a constructor branch may not run, and the instance can gain a
 * property at any point in its life), and a key nothing in the family
 * declares (a property added through an untyped view). The property bag the
 * checked-dynamic machinery keeps holds exactly Node's own-property state
 * for both, so these tests lower to a runtime probe when the receiver can
 * become an untyped value. */
function classAnswersAtRuntime(lowerer: Lowerer, info: ClassInfo, declared: boolean): boolean {
  if (!declared) return true;
  // A TypeScript class body defines every field it declares (a `declare`
  // field is erased at collection time), so its layout IS the declaration;
  // a JavaScript class in the family creates its fields by assignment.
  return lowerer.familyAnswersFromInstance(info);
}

/** An arrow called where it is written: the expression around it is that
 * call, so its body runs as part of the enclosing expression rather than
 * later through a value that escaped. */
function immediatelyInvokedArrow(fn: ts.ArrowFunction): boolean {
  let node: ts.Node = fn;
  for (let parent = node.parent; parent; node = parent, parent = parent.parent) {
    if (
      ts.isParenthesizedExpression(parent) ||
      ts.isAsExpression(parent) ||
      ts.isTypeAssertion(parent) ||
      ts.isSatisfiesExpression(parent) ||
      ts.isNonNullExpression(parent)
    )
      continue;
    return ts.isCallExpression(parent) && parent.expression === node;
  }
  return false;
}

/** Whether `node` is part of `initializer`'s own evaluation: a nested
 * function body runs later (after construction), so it does not see the
 * initializer's position in the field order. An arrow the expression calls
 * on the spot is the exception: its body runs while the initializer does,
 * with the same `this`, so the field order still holds there — up to its
 * `await`. An immediately invoked async arrow that suspends resumes the rest
 * of its body in a later job, once the constructor has returned, where `this`
 * holds every field. A suspension the test may not pass through leaves both
 * positions reachable, so the answer comes from the instance at runtime. */
function initializerPosition(initializer: ts.Node, node: ts.Node): "inside" | "after" | "either" {
  let position: "inside" | "either" = "inside";
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (current === initializer) return ts.isFunctionLike(current) ? "after" : position;
    if (ts.isFunctionLike(current)) {
      if (!ts.isArrowFunction(current) || !immediatelyInvokedArrow(current)) return "after";
      const reach = awaitReachBefore(current, node);
      if (reach === "always") return "after";
      if (reach === "maybe") position = "either";
    }
    // A loop turns the source order around: a later iteration runs the test
    // after an await the first iteration reached, wherever the two sit in
    // the body.
    if (
      (ts.isForStatement(current) ||
        ts.isForInStatement(current) ||
        ts.isForOfStatement(current) ||
        ts.isWhileStatement(current) ||
        ts.isDoStatement(current)) &&
      containsAwait(current)
    )
      position = "either";
  }
  return "after";
}

/** How far an `await` in `fn`'s own body stands before `node` does. */
type AwaitReach = "always" | "maybe" | "never";

function mergeAwaitReach(a: AwaitReach, b: AwaitReach): AwaitReach {
  if (a === "always" || b === "always") return "always";
  if (a === "maybe" || b === "maybe") return "maybe";
  return "never";
}

/** How far an `await` stands before a test that takes one of two alternative
 * paths: only a path that suspends on every one of its arms guarantees the
 * suspension, so an arm without an `await` leaves the other arm's reach
 * possible, not certain. */
function eitherAwaitReach(a: AwaitReach, b: AwaitReach): AwaitReach {
  if (a === "never" && b === "never") return "never";
  if (a === "always" && b === "always") return "always";
  return "maybe";
}

/** Whether executing `node` reaches an `await` in the same function: on every
 * path, on some path, or never. A short-circuit operand, conditional arm,
 * loop body or branch that may not run only makes the reach possible. A
 * constant condition settles which arm runs. */
function awaitReach(node: ts.Node): AwaitReach {
  if (ts.isFunctionLike(node) || ts.isClassExpression(node) || ts.isClassDeclaration(node))
    return "never";
  if (ts.isAwaitExpression(node)) return "always";
  if (ts.isConditionalExpression(node)) {
    const condition = awaitReach(node.condition);
    if (condition === "always") return "always";
    if (node.condition.kind === ts.SyntaxKind.TrueKeyword) return awaitReach(node.whenTrue);
    if (node.condition.kind === ts.SyntaxKind.FalseKeyword) return awaitReach(node.whenFalse);
    const arms = eitherAwaitReach(awaitReach(node.whenTrue), awaitReach(node.whenFalse));
    if (arms === "never") return "never";
    return condition === "never" && arms === "always" ? "always" : "maybe";
  }
  if (ts.isIfStatement(node)) {
    const condition = awaitReach(node.expression);
    if (condition === "always") return "always";
    if (node.expression.kind === ts.SyntaxKind.TrueKeyword) return awaitReach(node.thenStatement);
    if (node.expression.kind === ts.SyntaxKind.FalseKeyword)
      return node.elseStatement ? awaitReach(node.elseStatement) : "never";
    const arms = eitherAwaitReach(
      awaitReach(node.thenStatement),
      node.elseStatement ? awaitReach(node.elseStatement) : "never",
    );
    if (arms === "never") return "never";
    return condition === "never" && arms === "always" && node.elseStatement ? "always" : "maybe";
  }
  if (
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isWhileStatement(node) ||
    ts.isDoStatement(node) ||
    ts.isTryStatement(node) ||
    ts.isSwitchStatement(node)
  )
    return containsAwait(node) ? "maybe" : "never";
  if (ts.isBinaryExpression(node)) {
    const kind = node.operatorToken.kind;
    if (
      kind === ts.SyntaxKind.AmpersandAmpersandToken ||
      kind === ts.SyntaxKind.BarBarToken ||
      kind === ts.SyntaxKind.QuestionQuestionToken
    ) {
      const left = awaitReach(node.left);
      if (left !== "never") return left;
      const right = awaitReach(node.right);
      return right === "always" ? "maybe" : right;
    }
  }
  let state: AwaitReach = "never";
  ts.forEachChild(node, (child) => {
    state = mergeAwaitReach(state, awaitReach(child));
  });
  return state;
}

/** Whether an `await` outside a nested function appears anywhere in `node`. */
function containsAwait(node: ts.Node): boolean {
  if (ts.isFunctionLike(node) || ts.isClassExpression(node) || ts.isClassDeclaration(node))
    return false;
  if (ts.isAwaitExpression(node)) return true;
  return ts.forEachChild(node, containsAwait) === true;
}

/** How an `await` in `fn`'s own body stands before `node` does, so the test
 * either reaches it at the initializer's position or in a later job. */
function awaitReachBefore(fn: ts.ArrowFunction, node: ts.Node): AwaitReach {
  if (!ts.isBlock(fn.body)) return reachBefore(fn.body, node);
  let state: AwaitReach = "never";
  let child: ts.Node = node;
  for (let current: ts.Node | undefined = node.parent; current && current !== fn;) {
    if (ts.isBlock(current)) {
      for (const statement of current.statements.nodes) {
        if (statement === child) break;
        state = mergeAwaitReach(state, awaitReach(statement));
      }
    }
    child = current;
    current = current.parent;
  }
  // An `await` earlier in the test's own statement also suspends it, and a
  // statement may reach one on only some path.
  return mergeAwaitReach(state, reachBefore(child, node));
}

/** Whether `node` is `ancestor` itself or sits inside it. */
function within(ancestor: ts.Node, node: ts.Node): boolean {
  for (let current: ts.Node | undefined = node; current; current = current.parent)
    if (current === ancestor) return true;
  return false;
}

function childNodes(node: ts.Node): ts.Node[] {
  const children: ts.Node[] = [];
  ts.forEachChild(node, (child) => {
    children.push(child);
  });
  return children;
}

/** How an `await` in `root` stands before `target` evaluates: on every path
 * that reaches it, on some path, or never. Evaluation order decides — a
 * conditional's condition runs before the arm the target sits in, a call's
 * earlier arguments before a later one, and an await's own operand before
 * its suspension starts. */
function reachBefore(root: ts.Node, target: ts.Node): AwaitReach {
  if (root === target) return "never";
  if (ts.isFunctionLike(root) || ts.isClassExpression(root) || ts.isClassDeclaration(root))
    return "never";
  let state: AwaitReach = "never";
  if (ts.isAwaitExpression(root)) {
    // The target is inside the operand: the suspension starts only after the
    // operand finishes, so just the awaits nested in it come first.
    for (const child of childNodes(root))
      if (within(child, target)) state = mergeAwaitReach(state, reachBefore(child, target));
    return state;
  }
  // The arms of a conditional and of an if statement are exclusive, and a
  // loop's or a switch's remaining parts may run in another iteration: only
  // the condition, or nothing at all, precedes the arm that holds the target.
  if (ts.isConditionalExpression(root)) {
    if (within(root.condition, target)) return reachBefore(root.condition, target);
    const condition = awaitReach(root.condition);
    for (const arm of [root.whenTrue, root.whenFalse])
      if (within(arm, target)) return mergeAwaitReach(condition, reachBefore(arm, target));
  }
  if (ts.isIfStatement(root)) {
    if (within(root.expression, target)) return reachBefore(root.expression, target);
    const condition = awaitReach(root.expression);
    for (const statement of [root.thenStatement, root.elseStatement])
      if (statement && within(statement, target))
        return mergeAwaitReach(condition, reachBefore(statement, target));
  }
  if (
    ts.isForStatement(root) ||
    ts.isForInStatement(root) ||
    ts.isForOfStatement(root) ||
    ts.isWhileStatement(root) ||
    ts.isDoStatement(root) ||
    ts.isSwitchStatement(root) ||
    ts.isTryStatement(root)
  )
    return containsAwait(root) ? "maybe" : "never";
  for (const child of childNodes(root)) {
    if (within(child, target)) return mergeAwaitReach(state, reachBefore(child, target));
    state = mergeAwaitReach(state, awaitReach(child));
  }
  return state;
}

/** What the declaration says about `key` while the field at `defined` is
 * initializing: the members defined before that point, every inherited
 * member, and the prototype's members are on `this`; a field defined later,
 * or never, is not. */
function declaredMembership(
  lowerer: Lowerer,
  info: ClassInfo,
  key: string,
  defined: number,
): boolean {
  if (OBJECT_PROTOTYPE_KEYS.has(key)) return true;
  // A generic METHOD lives on the prototype like any other method. A field
  // initialized with a generic arrow or function collects like a method (no
  // closure slot can hold a generic function), but Node still defines its
  // property when that field's own initializer runs, so it answers from the
  // field order below.
  const generic = findGenericMethodOn(lowerer, info, key);
  if (
    lowerer.findMethodOn(info, key) !== null ||
    lowerer.findMethodOn(info, `get:${key}`) !== null ||
    lowerer.findMethodOn(info, `set:${key}`) !== null ||
    (generic !== null && ts.isMethodDeclaration(generic.info.decl))
  )
    return true;
  for (let base = info.base; base; base = base.base) if (base.fields.has(key)) return true;
  // A parameter property is assigned in the constructor body, after every
  // field initializer has run (Node's transform), so it is not on `this` yet.
  // A file whose tsconfig compiles class fields in the constructor assigns
  // its parameter properties first (ownFieldAndParamPropInitStmts): there
  // every one of them is on `this` when the first initializer runs.
  if (info.paramProps?.some((pp) => pp.name === key))
    return parameterPropertiesFirst(lowerer, info);
  const own = info.fieldOrder.findIndex((f) => f.name === key);
  if (own < 0) {
    if (generic === null) return false;
    // An inherited generic function field was defined by the base's own
    // initializers, which ran before this class's constructor body; this
    // class's own answers from where its declaration sits in the body.
    if (generic.declarer !== info) return true;
    const current = info.fieldOrder[defined]?.initializer;
    const field = generic.info.decl.parent;
    return current !== undefined && field !== undefined && field.pos < current.pos;
  }
  return own < defined;
}

/** `'key' in this` inside one of the class's own field initializers. Node
 * defines a field only as that field's own initializer finishes, so the
 * answer is the fields defined BEFORE this one, plus every inherited field
 * (a base class's initializers ran first) and the prototype's members;
 * a name this class defines later, or never, is absent. Null when the test
 * is not part of such an initializer. "suspended" when a suspension the test
 * may pass through leaves it either inside the initializer, with the field
 * order, or in a later job, where every field is defined: the flag the
 * enclosing arrow keeps decides which. */
function fieldInitializerAnswer(
  lowerer: Lowerer,
  expr: ts.BinaryExpression,
  key: string,
  receiverClass: string,
): { kind: "fixed"; value: boolean } | { kind: "suspended"; inside: boolean } | null {
  const context = lowerer.fieldInitializer;
  if (!context || context.info.def.name !== receiverClass) return null;
  let receiver = expr.right;
  while (ts.isParenthesizedExpression(receiver)) receiver = receiver.expression;
  if (receiver.kind !== ts.SyntaxKind.ThisKeyword) return null;
  const inside = declaredMembership(lowerer, context.info, key, context.index);
  const position = initializerPosition(context.initializer, expr);
  if (position === "after") return null;
  if (position === "either") return { kind: "suspended", inside };
  return { kind: "fixed", value: inside };
}

/** `key in <global object>` with a key that is not statically a symbol:
 * presence on the runtime's global object, whose answer is the program's own
 * global properties, then the names Node's global object has
 * (globalObjectPresentNamesArg). Node HAS the globals the native runtime
 * does not implement, so their answer must not be a silent false: arming the
 * compiler's derived set makes the runtime throw for them (host-globals.ts).
 * A literal key and a computed one take the same query: a literal names a
 * property the program may have added. A key that may hold a symbol at run
 * time reaches the global object's symbol store instead. Null when
 * `receiver` is not the global object or the key is a symbol. Also the
 * lowering of `Reflect.has(<global object>, key)`, the same query. */
export function lowerInGlobalObject(
  lowerer: Lowerer,
  keyNode: ts.Expression,
  receiver: ts.Expression,
  loc: SrcLoc,
): IrExpr | null {
  if (
    !isGlobalObjectRead(lowerer, receiver) ||
    lowerer.mapTypeOf(lowerer.typeOf(keyNode))?.kind === "symbol"
  )
    return null;
  const inGlobalKey = foldedStringKeyOf(lowerer, keyNode);
  const present = globalObjectPresentNamesArg(lowerer, receiver, loc);
  const globalHas = (key: IrExpr): IrExpr => ({
    kind: "libCall",
    fn: "dyn.globalHas",
    args: [key, present],
    type: BOOL,
    loc,
  });
  const installedHas = (key: IrExpr): IrExpr => ({
    kind: "seqExpr",
    stmts: [{ kind: "exprStmt", expr: hostAbsentInstall(loc), loc }],
    result: globalHas(key),
    type: BOOL,
    loc,
  });
  if (inGlobalKey !== null)
    return installedHas({ kind: "strLit", value: inGlobalKey, type: STRING, loc });
  // JS evaluates the key before the receiver; the receiver is the global
  // object, whose evaluation has no effects, so lowering the key first is
  // the whole evaluation order.
  const lowered = lowerer.lowerExpr(keyNode);
  if (lowered.type.kind === "string") return installedHas(lowered);
  // A key the type cannot prove to be a string may hold a symbol at
  // runtime, and a symbol is an identity, not a name: it must reach the
  // global object's symbol store rather than the string conversion (which
  // throws for a symbol). The boxed key is stabilized first; the answer is
  // the same presence query the dynamic path gives.
  const keyLocal = lowerer.declareHiddenLocal("%inKey", DYN);
  const boxedKey = varRef(keyLocal.id, DYN, loc);
  return {
    kind: "seqExpr",
    stmts: [
      { kind: "exprStmt", expr: hostAbsentInstall(loc), loc },
      {
        kind: "varDecl",
        localId: keyLocal.id,
        init: lowerer.coerceInto(keyNode, lowered, DYN),
        loc,
      },
    ],
    result: {
      kind: "ternary",
      cond: {
        kind: "strEq",
        negated: false,
        left: { kind: "libCall", fn: "dyn.typeof", args: [boxedKey], type: STRING, loc },
        right: { kind: "strLit", value: "symbol", type: STRING, loc },
        type: BOOL,
        loc,
      },
      then: {
        kind: "libCall",
        fn: "dyn.hasKeyComputed",
        args: [lowerGlobalObjectValue(lowerer, receiver, locOf(receiver)), boxedKey],
        type: BOOL,
        loc,
      },
      else_: globalHas({
        kind: "libCall",
        fn: "dyn.toStringCoerce",
        args: [boxedKey],
        type: STRING,
        loc,
      }),
      type: BOOL,
      loc,
    },
    type: BOOL,
    loc,
  };
}

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
  // `key in console`: console is a native handle with no key table, so
  // the answer comes from the keys Node's console has (console-records.ts).
  if (isConsoleExpression(lowerer, expr.right)) {
    const has = consoleHasKey(lowerer, expr.left, loc);
    if (has) return has;
  }
  // `#name in obj` — the ergonomic brand check (ES2022) — resolves
  // before any string-key machinery: the left operand is a private
  // NAME, not a value.
  if (ts.isPrivateIdentifier(expr.left)) {
    return lowerPrivateIn(lowerer, expr, expr.left, loc);
  }
  {
    const inGlobal = lowerInGlobalObject(lowerer, expr.left, expr.right, loc);
    if (inGlobal !== null) return inGlobal;
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
    // A RUNTIME string key over a supported builtin module namespace: the
    // interned census-name comparison helper, so a feature probe in a loop
    // (`names.filter((k) => k in zlib)`) answers Node's member surface.
    if (lowerer.mapTypeOf(lowerer.typeOf(expr.left))?.kind === "string") {
      const shape = lowerer.builtinNamespaceShapeOf(expr.right);
      if (shape !== null) {
        if (shape.flavor === "unknown") {
          lowerer.unsupported(
            "SC1090",
            expr.right,
            "'in' over a builtin module namespace whose runtime shape is not known statically (an ES module namespace and the CommonJS exports object answer different member sets; bind the namespace where it is imported or required)",
          );
        }
        const keyExpr = lowerer.lowerExprExpecting(expr.left, STRING);
        const member = builtinNamespaceMemberTest(lowerer, shape, false, keyExpr, loc);
        if (member !== null) {
          // Node evaluates the key, then the receiver. The census answers
          // without reading the receiver, so a spelling the lowerers can
          // evaluate still runs for its effects. The key is stabilized
          // before that evaluation whatever spelling it has: a read of a
          // mutable binding has no effects of its own, but it must not see
          // writes the receiver makes, so it cannot be left inside the test
          // the receiver now precedes.
          if (sideEffectFreeOptionValue(expr.right)) return member;
          const evaluated = tryLowerExpression(lowerer, expr.right);
          if (evaluated === null) return member;
          const keyLocal = lowerer.declareHiddenLocal("%inKey", STRING);
          return {
            kind: "seqExpr",
            stmts: [
              { kind: "varDecl", localId: keyLocal.id, init: keyExpr, loc },
              { kind: "exprStmt", expr: evaluated, loc },
            ],
            result: builtinNamespaceMemberTest(
              lowerer,
              shape,
              false,
              varRef(keyLocal.id, STRING, loc),
              loc,
            )!,
            type: BOOL,
            loc,
          };
        }
      }
    }
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
          // A key that names a string asks by that name, unboxed.
          const named = stringPropertyKey(lowerer, boxed, expr.left);
          const keyType = named !== null ? STRING : DYN;
          const keyLocal = lowerer.declareHiddenLocal("%inKey", keyType);
          return {
            kind: "seqExpr",
            stmts: [{ kind: "varDecl", localId: keyLocal.id, init: named ?? boxed, loc }],
            result: {
              kind: "libCall",
              fn: named !== null ? "dyn.in" : "dyn.hasKeyComputed",
              args: [
                lowerer.coerceToExpected(lowerer.lowerExpr(expr.right), DYN),
                varRef(keyLocal.id, keyType, loc),
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
  // A supported builtin module namespace (`"BROTLI_PARAM_QUALITY" in
  // zlib` — a feature probe): Node's member census answers, so the member
  // surface is the module's real one, not the lowerings' subset. A
  // CommonJS exports object also answers its prototype chain
  // (`"toString" in zlib`); an ESM namespace answers its export names
  // only. A receiver the census cannot place by shape (a parameter, an
  // untraced call result) has no answer.
  {
    const shape = lowerer.builtinNamespaceShapeOf(expr.right);
    if (shape !== null) {
      if (shape.flavor === "unknown") {
        lowerer.unsupported(
          "SC1090",
          expr.right,
          "'in' over a builtin module namespace whose runtime shape is not known statically (an ES module namespace and the CommonJS exports object answer different member sets; bind the namespace where it is imported or required)",
        );
      }
      const has = builtinModuleHasMember(shape.module, shape.flavor, key);
      if (has !== null)
        return reflectOverNamespaceExpr(
          lowerer,
          expr.right,
          { kind: "boolLit", value: has, type: BOOL, loc },
          loc,
        );
    }
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
  // `"stream" in (stored as R)` probes the value actually stored (Node
  // erases the assertion): a union of fixed record shapes answers per arm
  // below, so the assertion's checked extraction must not run first (it
  // would trap on the very arm the probe exists to detect).
  let recv = assertedInOperand(lowerer, expr.right) ?? lowerer.lowerExpr(expr.right);
  // A PRIMITIVE receiver: JavaScript's ToObject step throws Node's TypeError
  // for every primitive (`'x' in 5` included), and the throw precedes the
  // key's ToPropertyKey — the key is a compile-time literal on every path
  // that reaches here, so only the receiver's own evaluation remains. The
  // message spells the receiver's value, so a receiver the IR cannot
  // re-evaluate (`receiver()`) evaluates once into a hidden local.
  if (isPrimitiveValueType(recv.type)) {
    if (isUnitType(recv.type) || isSafeToRepeat(recv)) {
      return throwAfterEach([recv], inOperatorTypeError(lowerer, key, recv, BOOL, loc), loc);
    }
    const slot = lowerer.declareHiddenLocal("%inReceiver", recv.type);
    return {
      kind: "seqExpr",
      stmts: [{ kind: "varDecl", localId: slot.id, init: recv, loc }],
      result: inOperatorTypeError(lowerer, key, varRef(slot.id, recv.type, loc), BOOL, loc),
      type: BOOL,
      loc,
    };
  }
  const classInfo =
    recv.type.kind === "classval" ? lowerer.classes.get(recv.type.className) : undefined;
  if (
    (classInfo && (classInfo.callableBase || hasRuntimeStatics(classInfo))) ||
    (recv.type.kind === "func" &&
      lowerer.dynConvertible(recv.type) &&
      (isJsSourceFile(ts.getSourceFileOfNode(expr)) || isCallableValue(lowerer, expr.right)))
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
        lowerer.findMethodOn(c, `set:${key}`) !== null ||
        findGenericMethodOn(lowerer, c, key) !== null;
      const staticInfo = lowerer.classes.get(recv.type.className);
      if (staticInfo && declares(staticInfo)) return always();
      // Any other key: a descendant class that declares it (instanceof), or
      // an own property set at runtime (a throw site's extra fields,
      // Object.assign, writes through a dynamic view). `code` is such a key
      // too: at runtime it is the error's code slot, or an own `code` with
      // another value (`err.code = undefined` is present), and a subclass
      // that declares a `code` field holds it in the field instead. The
      // other keys built-in errors keep outside their class fields depend
      // on the runtime error and stay fenced.
      const staticName = recv.type.className;
      const declarers: string[] = [];
      for (const c of lowerer.classes.values()) {
        const name = c.def.name;
        if (name === staticName || !lowerer.isSubclassOf(name, staticName) || !declares(c))
          continue;
        // A declaring ancestor below the static class already covers it.
        if (c.base && c.base.def.name !== staticName && declares(c.base)) continue;
        declarers.push(name);
      }
      if (key === "code" && declarers.length === 0) {
        return { kind: "libCall", fn: "error.hasCode", args: [recv], type: BOOL, loc };
      }
      if (key === "code" || !BUILTIN_ERROR_SLOT_KEYS.has(key)) {
        const stable = recv.kind === "varRef" || recv.kind === "caughtNarrow";
        const slot = stable ? null : lowerer.declareHiddenLocal("%inRecv", recv.type);
        const ref = (): IrExpr => (slot ? varRef(slot.id, recv.type, loc) : recv);
        const tests: IrExpr[] = declarers.map((className) => ({
          kind: "instanceOf",
          value: ref(),
          className,
          type: BOOL,
          loc,
        }));
        tests.push(
          key === "code"
            ? { kind: "libCall", fn: "error.hasCode", args: [ref()], type: BOOL, loc }
            : {
                kind: "libCall",
                fn: "error.hasKey",
                args: [ref(), { kind: "strLit", value: key, type: STRING, loc }],
                type: BOOL,
                loc,
              },
        );
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
    // A plain compiled class (no Error root): every instance carries its
    // declared fields and prototype members, so membership answers from the
    // declaration (classInstanceIn). A receiver that is not a stable read
    // still evaluates for its effects.
    const classInfo = lowerer.classes.get(recv.type.className);
    const classVerdict = classInstanceIn(lowerer, recv.type.className, key, null);
    // A question a declaration cannot settle reads the instance's own
    // property state: a JavaScript class whose fields are created by
    // assignment, or a name no class in the family declares. Both land in
    // the property bag the checked-dynamic machinery keeps, which holds
    // Node's own-property state exactly.
    if (
      classInfo &&
      classVerdict !== "unknown" &&
      classAnswersAtRuntime(lowerer, classInfo, declaresInstanceMember(lowerer, classInfo, key)) &&
      lowerer.dynConvertible(recv.type)
    ) {
      return {
        kind: "dynHasKey",
        key,
        value: lowerer.coerceToExpected(recv, DYN),
        type: BOOL,
        loc,
      };
    }
    // Inside one of the class's own field initializers, only the fields
    // defined before this one are on `this` yet.
    const initializerAnswer =
      classVerdict === "unknown"
        ? null
        : fieldInitializerAnswer(lowerer, expr, key, recv.type.className);
    if (initializerAnswer?.kind === "suspended") {
      // The test may run before the enclosing arrow's suspension (the field
      // order answers) or after it, once the constructor has returned (the
      // built instance answers). The arrow's own flag says which.
      const inside: IrExpr = { kind: "boolLit", value: initializerAnswer.inside, type: BOOL, loc };
      const insideExpr: IrExpr = isSafeToDiscard(recv)
        ? inside
        : {
            kind: "seqExpr",
            stmts: [{ kind: "exprStmt", expr: recv, loc }],
            result: inside,
            type: BOOL,
            loc,
          };
      const flag = lowerer.ctx.suspendedFlag;
      if (!flag) return insideExpr;
      const previousInitializer = lowerer.fieldInitializer;
      lowerer.fieldInitializer = null;
      try {
        return {
          kind: "ternary",
          cond: varRef(flag.id, BOOL, loc),
          then: lowerInExpression(lowerer, expr, loc),
          else_: insideExpr,
          type: BOOL,
          loc,
        };
      } finally {
        lowerer.fieldInitializer = previousInitializer;
      }
    }
    if (initializerAnswer !== null) {
      const answer: IrExpr = {
        kind: "boolLit",
        value: initializerAnswer.value,
        type: BOOL,
        loc,
      };
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
    if (classVerdict === true || classVerdict === false) {
      const answer: IrExpr = { kind: "boolLit", value: classVerdict, type: BOOL, loc };
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
    // The declaration lacks the key, but a subclass may declare it (the
    // static type is the base): the declaring subclasses answer through
    // class tests, exactly the Error case above. The receiver evaluates
    // once, so it is stabilized when it is not a plain read.
    if (classVerdict === "below") {
      const info = lowerer.classes.get(recv.type.className)!;
      const declarers = declaringSubclasses(info, key);
      const stable =
        recv.kind === "varRef" || recv.kind === "caughtNarrow"
          ? null
          : lowerer.declareHiddenLocal("%inRecv", recv.type);
      const ref = (): IrExpr => (stable ? varRef(stable.id, recv.type, loc) : recv);
      let answer = declarers.reduce<IrExpr | null>((acc, className) => {
        const test: IrExpr = { kind: "instanceOf", value: ref(), className, type: BOOL, loc };
        return acc === null
          ? test
          : { kind: "logical", op: "||", left: acc, right: test, type: BOOL, loc };
      }, null) ?? { kind: "boolLit", value: false, type: BOOL, loc };
      if (stable) {
        answer = {
          kind: "seqExpr",
          stmts: [{ kind: "varDecl", localId: stable.id, init: recv, loc }],
          result: answer,
          type: BOOL,
          loc,
        };
      }
      return answer;
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
    const answers: {
      tag: number;
      has: boolean | "slot" | "unit" | "keyed" | "probe" | "source";
      arm: IrType;
    }[] = [];
    const armClasses = new Set(
      arms.filter((arm) => arm.kind === "object").map((arm) => arm.className),
    );
    let staticAnswers = arms.length > 0;
    for (const arm of arms) {
      const tag = lowerer.armTag(unionId, arm);
      if (tag < 0) {
        staticAnswers = false;
        break;
      }
      // A unit arm answers Node's TypeError (`'k' in undefined`): only an
      // erased assertion over an optional value still carries one.
      if (isUnitType(arm)) {
        answers.push({ tag, has: "unit", arm });
        continue;
      }
      // A CLASS arm answers from its declaration too (classInstanceIn);
      // a subclass that lands in this arm and declares the key keeps the
      // per-value answer impossible, so the fence stays.
      if (arm.kind === "object") {
        const verdict = classInstanceIn(lowerer, arm.className, key, armClasses);
        if (verdict === "below" || verdict === "unknown") {
          staticAnswers = false;
          break;
        }
        // A JavaScript arm's fields are created by assignment, so its
        // static answer is not a property of the tag: the arm reads its
        // own instance instead (see perValueUnionIn). The same holds for a
        // name no class in the arm's family declares: a value can gain it
        // at runtime through an untyped view, which the tag cannot rule
        // out. Both are the single-class receiver's answer above.
        const armInfo = lowerer.classes.get(arm.className);
        if (
          armInfo !== undefined &&
          classAnswersAtRuntime(lowerer, armInfo, verdict === true) &&
          lowerer.dynConvertible(arm)
        ) {
          answers.push({ tag, has: "probe", arm });
          continue;
        }
        answers.push({ tag, has: verdict, arm });
        continue;
      }
      const shape = arm.kind === "record" ? lowerer.shapes.get(arm.shapeId) : undefined;
      if (!shape || shape.tuple) {
        staticAnswers = false;
        break;
      }
      const f = shape.fields.find((x) => x.name === key);
      const inherited = OBJECT_PROTOTYPE_KEYS.has(key);
      if (
        f &&
        !inherited &&
        ((f.type.kind === "union" && lowerer.armTag(f.type.unionId, UNDEFINED_T) >= 0) ||
          (f.optional === true && f.type.kind === "dyn"))
      ) {
        answers.push({ tag, has: "slot", arm }); // presence is per-value
        continue;
      }
      // Accessor properties are own properties to `in` (Node answers
      // true without invoking the getter) — either slot present makes
      // the name a member.
      const acc = shape.fields.some((x) => x.name === `%get:${key}` || x.name === `%set:${key}`);
      // A key the arm does not declare is an own key of a linked copy's
      // source or of a kept source, as for a single record receiver
      // below: the value answers, not the tag (unless another arm declares
      // the key, see after the loop).
      if (
        arm.kind === "record" &&
        f === undefined &&
        !acc &&
        !inherited &&
        !shape.indexValue &&
        recordMayKeepSource(lowerer, arm)
      ) {
        answers.push({ tag, has: "source", arm });
        continue;
      }
      if (f !== undefined || acc || !shape.indexValue) {
        answers.push({ tag, has: f !== undefined || acc || inherited, arm });
        continue;
      }
      // An index-signature arm answers the overflow map's own key (a
      // stored undefined is present), or the prototype's name.
      answers.push({ tag, has: "keyed", arm });
    }
    // When another arm declares the key, the test also narrows the value
    // to that arm, by tag: an arm that lacks the key must then answer false
    // whatever its value kept, or the narrowed read would meet the wrong
    // arm. Only a key no arm declares is the value's to answer.
    if (answers.some((a) => a.has === true || a.has === "slot" || a.has === "probe"))
      for (const a of answers) if (a.has === "source") a.has = false;
    if (
      staticAnswers &&
      answers.some(
        (a) =>
          a.has === "slot" ||
          a.has === "unit" ||
          a.has === "keyed" ||
          a.has === "probe" ||
          a.has === "source",
      )
    ) {
      return perValueUnionIn(lowerer, recv, unionId, key, answers, loc);
    }
    if (staticAnswers) {
      // A field read is pure only over a pure object: the stored value of
      // an asserted receiver (`"k" in (make().stored as R)`) still
      // evaluates its call.
      const pureRecv = isSafeToRepeat(recv) || pureRecvNode;
      let value = recv;
      const isTag = (tag: number, negated: boolean): IrExpr => ({
        kind: "unionIsTag",
        unionId,
        tag,
        negated,
        value,
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
      // Several arms on each side: the OR chain re-reads the receiver, so
      // anything but a pure read is evaluated once into a hidden local.
      const stable = pureRecv ? null : lowerer.declareHiddenLocal("%inRecv", recv.type);
      if (stable) value = varRef(stable.id, recv.type, loc);
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
      if (!stable) return out;
      return {
        kind: "seqExpr",
        stmts: [{ kind: "varDecl", localId: stable.id, init: recv, loc }],
        result: out,
        type: BOOL,
        loc,
      };
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
  // A typed CALLABLE receiver (a function+namespace merge, an expando
  // function): its own data properties live in the closure's own-property
  // table, whose presence test is the keyed one the `any` view uses
  // (callable-properties.ts). The function protocol's inherited names
  // (length, name, prototype, call, ...) answer through the same runtime
  // walk.
  if (recv.type.kind === "func" && isCallableValue(lowerer, expr.right)) {
    const boxed = callableBox(lowerer, recv);
    if (boxed !== null) return { kind: "dynHasKey", key, value: boxed, type: BOOL, loc };
  }
  if (recv.type.kind !== "record") {
    // A typed handle in a program that adds properties to handles: own
    // keys and the class's members answer from its property table
    // (scr_dyn_handle_props.c).
    {
      const boxed = boxedHandleReceiver(lowerer, recv);
      if (boxed) return { kind: "dynHasKey", key, value: boxed, type: BOOL, loc };
    }
    lowerer.unsupported(
      "SC1090",
      expr,
      `'in' on '${lowerer.fmt(recv.type)}' receivers (only process.env, Error instances, class instances, record-typed values, and unions of fixed record shapes answer; ${NARROW_FIRST})`,
    );
  }
  const shape = lowerer.shapes.get(recv.type.shapeId);
  if (!shape) throw new InternalCompilerError(`lowerer bug: unknown shape ${recv.type.shapeId}`);
  const field = shape.fields.find((f) => f.name === key);
  if (field) {
    // A field some partial record assertion leaves unwritten (a partial
    // record view, partial-assertions.ts): the answer is the view's, not
    // the declared type's.
    {
      const viewPresence = partialFieldPresence(lowerer, recv, recv.type.shapeId, key, loc);
      if (viewPresence) return viewPresence;
    }
    if (
      !OBJECT_PROTOTYPE_KEYS.has(key) &&
      ((field.type.kind === "union" && lowerer.armTag(field.type.unionId, UNDEFINED_T) >= 0) ||
        (field.optional === true && field.type.kind === "dyn"))
    ) {
      // Optional slot: the key is present unless the field is absent
      // (omitted or deleted); an explicit undefined is present.
      return lowerer.recordFieldPresent(recv, recv.type.shapeId, key, loc);
    }
    // A declared non-optional field always exists on every value of the
    // shape — statically true, but a calling receiver (`"k" in make().api`)
    // must still run exactly once.
    return staticAnswerAfter(recv, true, loc);
  }
  // Accessor properties answer `in` as own members (Node: true, getter
  // NOT invoked) — statically true, with the receiver evaluated once.
  if (shape.fields.some((f) => f.name === `%get:${key}` || f.name === `%set:${key}`)) {
    return staticAnswerAfter(recv, true, loc);
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
  // A null-prototype record (Object.groupBy) has no inherited names.
  const nullProtoT = inherited ? nullProtoRecordShape(lowerer, recv.type) : null;
  if (nullProtoT) {
    // The answer reads the receiver itself, so it already evaluates it
    // exactly once; wrapping it in a discard statement would run an
    // effectful receiver (a call result) twice.
    return {
      kind: "unary",
      op: "!",
      operand: recordNullProtoTest(recv, nullProtoT.shapeId, loc),
      type: BOOL,
      loc,
    };
  }
  // A key the type does not declare is an own key of a linked copy's
  // source or of a kept source (record-links.ts, and the hasOwn helper's
  // kept width spread answer); the helper call evaluates the receiver once.
  if (!inherited && recordMayKeepSource(lowerer, recv.type))
    return {
      kind: "call",
      callee: recordHasOwnHelper(lowerer, recv.type.shapeId, loc),
      args: [recv, { kind: "strLit", value: key, type: STRING, loc }],
      type: BOOL,
      loc,
    };
  // Otherwise the answer is static; the key-order pass still reads the
  // site as a presence test of the receiver's keys.
  const answer = staticAnswerAfter(recv, inherited, loc);
  return inherited ? answer : lowerer.keyOrder.sourceProbe(answer, recv, key);
}

/** A statically-decided `in` answer: a side-effect-free receiver folds away,
 * while any other receiver (a call result, an effectful read) is still
 * evaluated exactly once for its effects. */
function staticAnswerAfter(recv: IrExpr, answer: boolean, loc: SrcLoc): IrExpr {
  return staticAnswerAfterWith(recv, { kind: "boolLit", value: answer, type: BOOL, loc }, loc);
}

function staticAnswerAfterWith(recv: IrExpr, result: IrExpr, loc: SrcLoc): IrExpr {
  if (isSafeToDiscard(recv)) return result;
  return {
    kind: "seqExpr",
    stmts: [{ kind: "exprStmt", expr: recv, loc }],
    result,
    type: BOOL,
    loc,
  };
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
  answers: readonly {
    tag: number;
    has: boolean | "slot" | "unit" | "keyed" | "probe" | "source";
    arm: IrType;
  }[],
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
  const inherited = OBJECT_PROTOTYPE_KEYS.has(key);
  for (const a of answers) {
    if (a.has === false || a.has === "unit") continue;
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
    if (a.has === "probe" && a.arm.kind === "object") {
      // This arm answers from the instance itself: the class creates its
      // own fields by assignment, so the narrowed value's own property
      // state decides (the tag test has proven the arm).
      const narrowed: IrExpr = {
        kind: "unionNarrow",
        unionId,
        tag: a.tag,
        value: ref(),
        type: a.arm,
        loc,
      };
      test = {
        kind: "logical",
        op: "&&",
        left: test,
        right: {
          kind: "dynHasKey",
          key,
          value: lowerer.coerceToExpected(narrowed, DYN),
          type: BOOL,
          loc,
        },
        type: BOOL,
        loc,
      };
    }
    if (a.has === "source" && a.arm.kind === "record") {
      // The arm does not declare the key, but its value may be a copy
      // linked to a source that has it, or keep a source of its own: the
      // own-key helper of the arm's type answers for the narrowed value.
      const narrowed: IrExpr = {
        kind: "unionNarrow",
        unionId,
        tag: a.tag,
        value: ref(),
        type: a.arm,
        loc,
      };
      test = {
        kind: "logical",
        op: "&&",
        left: test,
        right: {
          kind: "call",
          callee: recordHasOwnHelper(lowerer, a.arm.shapeId, loc),
          args: [narrowed, { kind: "strLit", value: key, type: STRING, loc }],
          type: BOOL,
          loc,
        },
        type: BOOL,
        loc,
      };
    }
    if (a.has === "keyed" && a.arm.kind === "record") {
      const narrowed: IrExpr = {
        kind: "unionNarrow",
        unionId,
        tag: a.tag,
        value: ref(),
        type: a.arm,
        loc,
      };
      // An inherited name answers the prototype (a null-prototype record
      // has none); any other key is an own key of the overflow map.
      const nullProtoT = inherited ? nullProtoRecordShape(lowerer, a.arm) : null;
      const presence: IrExpr = nullProtoT
        ? {
            kind: "unary",
            op: "!",
            operand: recordNullProtoTest(narrowed, a.arm.shapeId, loc),
            type: BOOL,
            loc,
          }
        : inherited
          ? { kind: "boolLit", value: true, type: BOOL, loc }
          : {
              kind: "recordOvfHas",
              obj: narrowed,
              shapeId: a.arm.shapeId,
              key: { kind: "strLit", value: key, type: STRING, loc },
              type: BOOL,
              loc,
            };
      test = {
        kind: "logical",
        op: "&&",
        left: test,
        right: presence,
        type: BOOL,
        loc,
      };
    }
    out = out ? { kind: "logical", op: "||", left: out, right: test, type: BOOL, loc } : test;
  }
  let result: IrExpr = out ?? { kind: "boolLit", value: false, type: BOOL, loc };
  // A unit arm throws Node's TypeError (`'k' in undefined`); the tests are
  // disjoint by tag, so the order among them does not matter.
  for (const a of answers) {
    if (a.has !== "unit") continue;
    const unit = a.arm.kind === "nullT" ? "null" : "undefined";
    result = {
      kind: "ternary",
      cond: isTag(a.tag),
      then: nodeThrowExpr(
        1,
        "",
        `Cannot use 'in' operator to search for '${key}' in ${unit}`,
        BOOL,
        loc,
      ),
      else_: result,
      type: BOOL,
      loc,
    };
  }
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
  "object",
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
