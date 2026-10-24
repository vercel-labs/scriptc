import {
  arrayClassMemberOwner,
  arrayClassView,
  lowerArrayClassStaticCall,
} from "./builtins/array-classes.js";
import { keyedHelperName } from "./stable-names.js";
import { perKeyOrder } from "./key-order-witness.js";
import { isForwardedTupleSpread, lowerForwardingApply } from "./typed-arguments.js";
import { guardNullProto, nullProtoRecordShape } from "./null-prototype.js";
import { lowerDynStreamMemberCall } from "./dyn-streams.js";
import { lowerBuiltinClassCall } from "./builtins/builtin-class-dyn.js";
import { refuseModuleMemberThis } from "./module-member-this.js";
import { lowerUnionEquality, tagEqualityMayMissAlias } from "./strict-equality.js";
import { lowerHashStreamCall } from "./builtins/hash-stream.js";
import { lowerWebAssemblyValueOf } from "./builtins/webassembly.js";
import { lowerResponseStaticJson } from "./lower-stdlib.js";
import { lowerArrayCallbackCall } from "./containers/array-callback-call.js";
/** Dispatch source calls, builtin members and receiver-specific operations.
 * Signature collection, argument completion and function bodies have their
 * own owners; this module selects the applicable call path. */
import { dynUndefinedExpr, nodeThrowExpr, countedFor, numLit, varRef } from "../../ir/build.js";
import { lowerBuiltinCall } from "./builtin-calls.js";
import { threadsImportOf } from "../threads-import.js";
import {
  adaptZeroArgTimerCallback,
  lowerTimersMemberCall,
  TIMER_MODULE_MEMBERS,
} from "./lower-timers.js";
import { lowerMockTimersElementCall } from "./lower-test.js";
import { objectEnumerationReceiver } from "./object-enumeration-receiver.js";
import { InternalCompilerError } from "../../errors.js";
import { isFsStreamMember, lowerFsStreamMethodCall } from "./builtins/fs-streams.js";
import * as ts from "../ts7/adapter.js";
import {
  isZlibStreamMember,
  lowerPromisifiedZlibCall,
  lowerZlibStreamMethodCall,
} from "./builtins/compression.js";
import type { Lowerer } from "./lowerer.js";
import {
  inlineNamespaceRequireOf,
  lowerInlineRequireValue,
  lowerUncompiledRequireCall,
  lowerWithInlineRequireInit,
} from "./cjs-inline-require.js";
import { cjsExportCallIgnoresThis, cjsInFileExportGlobalOf } from "./cjs-exports-object.js";
import { lowerGenMethodCall } from "./lower-generators.js";
import { lowerClassSymbolMethodCall } from "./symbol-methods.js";
import { lowerReadlineDisposeCall } from "./builtins/readline.js";
import { errorToStringCall } from "./error-methods.js";
import { lowerClassPrototypeAssign, lowerClassPrototypeDescriptors } from "./class-prototypes.js";
import {
  BYTES_ELEMENT_NAME,
  BYTES_U8,
  BIGINT_T,
  BOOL,
  CAUGHT,
  DYN,
  DYN_HANDLE_KINDS,
  F64,
  type IrExpr,
  type IrFunction,
  type IrLibFn,
  type IrLocal,
  type IrParam,
  type IrStmt,
  type IrType,
  NULL_T,
  STRING,
  SYMBOL_T,
  type SrcLoc,
  UNDEFINED_T,
  VOID,
  arrayOf,
  canBoxFuncIntoDyn,
  canConvertToDyn,
  canDynCheckTo,
  funcOf,
  isDynTypedRefType,
  isUnitType,
  shapeHasAccessorSlots,
  shapeKeyOrders,
  typeEquals,
  RUNTIME_EMITTER_CLASS,
} from "../../ir/ir.js";
import { lowerProtocolMethodCall } from "./class-protocol-dispatch.js";
import { isJsSourceFile, locOf, requireSpecOf } from "../program.js";
import { isPackageShimFile, isShimIntrinsicName } from "../package-shims.js";
import { lowerJsonRequireCall } from "./json-require.js";
import { lowerAssertInstanceCall } from "./assert-instances.js";
import {
  isGenericCallableMemberType,
  isOverloadedCallableMemberType,
  typeKey,
} from "../type-mapper.js";
import { dynFallbackType, jsFuncNameOf, newFnCtx, staticImportNamespaceType } from "./lowerer.js";
import {
  NARROW_FIRST,
  STRING_INDEX_METHODS,
  STR_METHODS,
  UTIL_TYPES_KEYS,
  stdlibGlobalNameOf,
} from "./surfaces.js";
import { dynStringReceiver } from "./containers/dynamic-receivers.js";
import {
  lowerArrayConstructor,
  lowerArrayFromCall,
  lowerArrayOfCall,
} from "./containers/array-construction.js";
import { lowerArrayFromAsyncCall } from "./containers/array-from-async.js";
import { lowerDynArrayFilterCall, lowerDynArrayFlatMapCall } from "./containers/array-callbacks.js";
import { lowerGroupByStaticCall } from "./containers/collection-grouping.js";
import {
  lowerGeneratorHelperCall,
  lowerHelperReturnCall,
  lowerIteratorFromCall,
  lowerIteratorHelperCall,
} from "./containers/iterator-helpers.js";
import {
  lowerObjectAssignIndexShape,
  lowerObjectConstructor,
  lowerObjectFromEntriesCall,
  lowerObjectIterOverIndexShape,
} from "./containers/indexed-objects.js";
import { lowerTupleReadMethodCall } from "./containers/array-methods.js";
import { tryFuseIndexRead } from "./array-values.js";
import {
  lowerBufferConstruct,
  lowerBytesPrototypeSetCall,
  lowerBytesStaticCall,
} from "./containers/bytes.js";
import {
  lowerRegexMethodCall,
  lowerStringIndexCall,
  lowerStringMethodCall,
  lowerStringPaddingCall,
  lowerStringSplitCall,
  isDynPrimitiveKindMethod,
  lowerDynPrimitiveMethodCall,
  lowerExtraNumberMethodCall,
} from "./containers/string-and-regexp.js";
import { createRequireSpecOf } from "./builtins/module-bindings.js";
import {
  lowerChildStreamMethodCall,
  lowerChildWriterMethodCall,
} from "./builtins/child-process-methods.js";
import {
  lowerCreateRequireCall,
  lowerImportMetaResolveCall,
  lowerRequireResolveCall,
} from "./builtins/module-resolution.js";
import {
  isWebCryptoReceiver,
  lowerCipherMethodCall,
  lowerCryptoGetRandomValues,
  lowerCryptoHashMethodCall,
  lowerPromisifiedCryptoCall,
} from "./builtins/crypto.js";
import { lowerErrorCaptureStackTraceCall, lowerErrorIsErrorCall } from "./builtins/errors.js";
import { lowerPromisifiedDnsCall } from "./lower-dgram.js";
import { lowerDisposableStackUseCall } from "./builtins/disposable-stack.js";
import {
  lowerDirentMethodCall,
  lowerFileHandleMethodCall,
  lowerDirMethodCall,
  lowerWatcherMethodCall,
} from "./builtins/filesystem.js";
import {
  fencePerfEntryKeyWalk,
  isPerfEntryType,
  lowerHistogramMethodCall,
  lowerPerfHooksCall,
  perfEntryTag,
} from "./builtins/performance.js";
import {
  lowerProcStreamMethodCall,
  lowerProcessBuiltinModuleNamespace,
} from "./builtins/process.js";
import { recordMayKeepSource, throughRecordSource } from "./record-sources.js";
import { lowerReflectCall } from "./builtins/reflection.js";
import {
  lowerAbsenceProbe,
  v8CalleeText,
  lowerPromiseAllTupleCall,
  lowerPromiseRejectCall,
  lowerToNumberArgument,
  stringWrapperToString,
  symbolFieldInfo,
  templateRawTextOf,
  primitiveCtorClosure,
} from "./lower-exprs.js";
import { isSafeToDiscard } from "./expressions/evaluation-safety.js";
import { tryLowerExpression } from "./expressions/try-lower-expression.js";
import { lowerChildMethodValue, lowerChildPropertyCall } from "./handle-properties.js";
import { classObjectTag, classToNumberConversion } from "./class-to-primitive.js";
import { hasRuntimeStatics } from "./class-runtime-statics.js";
import { structuralReadType } from "./class-unions.js";
import {
  httpClientFnBindingOf,
  lowerCompatReqStreamOptionalCall,
  lowerHttpClientFnCall,
} from "./lower-server.js";
import {
  EMITTER_API_MEMBERS,
  exactClassOfReceiver,
  exactInstanceClassOf,
  findGenericMethodOn,
  lowerClassGenericMethodCall,
  lowerStaticMethodCall,
  lowerStaticFieldRead,
  returnsOnlyThis,
  storedClassValueType,
  type ClassInfo,
} from "./lower-classes.js";
import { classCallbackCall, isClassCallback } from "./class-callbacks.js";
import { emitterRooted, lowerEmitterMethodCall } from "./lower-event-emitter.js";
import { eventTargetApiMethod, lowerEventTargetMethodCall } from "./lower-event-target.js";
import {
  dateRootOf,
  isDatePrototypeMethod,
  lowerInheritedDateMethodCall,
} from "./builtins/date-classes.js";
import {
  lowerConsoleInstanceCall,
  lowerConsoleMethodCall,
  lowerConsoleOutput,
} from "./lower-console.js";
import {
  STREAM_API_MEMBERS,
  STREAM_OPERATORS,
  lowerStreamMethodCall,
  lowerStreamStaticCall,
  streamSidesOf,
} from "./lower-stream.js";
import {
  ambientNsRootOf,
  ambientUndefReadType,
  ambientUndefVarRootOf,
  ambientUndefinedFnSymbolOf,
  contextualUndefReadType,
  fenceEarlyAliasUse,
  fenceEarlyNsMemberRef,
  nsMemberIdentOf,
  nsUndefRead,
} from "./lower-namespaces.js";
import { expandoMemberRead } from "./lower-expando.js";
import { fenceNodeModuleMutationCall, lowerRequireCacheKeys } from "./lower-node-module.js";
import {
  defaultAfterUndefined,
  lowerOptionalArgument,
  lowerStaticallyUndefinedArgument,
  positionNumber,
} from "./optional-arguments.js";
import { fenceSymbolFieldCopy } from "./symbol-fields.js";
import { lowerClassDataDescriptor, lowerClassDescriptorRead } from "./class-descriptors.js";
import { lowerClassFieldDefine, lowerClassIntegrity } from "./class-attributes.js";
import { freezableRecordType, lowerNativeFreeze } from "./frozen-records.js";
import { classStaticDataFor } from "./class-static-data.js";
import { lowerUrlFactory } from "./lower-url.js";
import { nullishValueUnitOf } from "./binding-analysis.js";
import {
  spreadNeedsRuntimeArity,
  completeFuncValueArgs,
  lowerSpreadArgsCall,
  completeArgs,
} from "./call-arguments.js";
import { isThisParameter, type ParamShape } from "./call-signatures.js";
import { dynamicOverloadChoice } from "./overload-choice.js";
import { lowerStringIteratorValue } from "./iterator-adapters.js";
import { checkedArmExtraction } from "./coercions/unions.js";
import { maybePromiseReturnStmt, promiseArmedUnionOf } from "./maybe-promise.js";
import {
  requireObjLitGenericReceiver,
  objLitGenericFnNodeOf,
  objLitGenericFnInfoOf,
  genericCallInstance,
} from "./generic-functions.js";

import { codeGenerationCalleeOf, lowerCodeGenerationCall } from "./code-generation.js";

const ZLIB_STREAM_METHODS: ReadonlySet<string> = new Set(["flush", "params", "close", "reset"]);

/** `Object.defineProperty(target, ...)`, `Object.defineProperties`,
 * `Reflect.defineProperty`, and `target.__defineGetter__/__defineSetter__`
 * over a target that may hold an Error can install an accessor over an
 * error's `name` or `message` (error-methods.ts). */
function noteErrorAccessorReflection(lowerer: Lowerer, expr: ts.CallExpression): void {
  const callee = expr.expression;
  if (!ts.isPropertyAccessExpression(callee)) return;
  const member = callee.name.text;
  const target =
    member === "defineProperty" || member === "defineProperties"
      ? expr.arguments.nodes[0]
      : member === "__defineGetter__" || member === "__defineSetter__"
        ? callee.expression
        : undefined;
  if (!target) return;
  const error = lowerer.checker.resolveName("Error", ts.SymbolFlags.Type, target, false);
  const errorType = error ? lowerer.checker.getDeclaredTypeOfSymbol(error) : null;
  if (mayHoldError(lowerer, lowerer.checker.getTypeAtLocation(target), errorType))
    lowerer.errorAccessorReflection = locOf(expr);
}

/** An untyped or generic type, a type Error is assignable to (`object`,
 * `{}`, `Object`, `{ message?: string }`), or
 * an Error-shaped type with both `name` and `message`, alone or in a
 * union or intersection. */
function mayHoldError(lowerer: Lowerer, type: ts.Type, errorType: ts.Type | null): boolean {
  if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Instantiable))
    return true;
  if (type.flags & (ts.TypeFlags.Union | ts.TypeFlags.Intersection))
    return ts.constituentTypes(type).some((part) => mayHoldError(lowerer, part, errorType));
  return (
    (lowerer.checker.getPropertyOfType(type, "message") !== undefined &&
      lowerer.checker.getPropertyOfType(type, "name") !== undefined) ||
    (errorType !== null && lowerer.checker.isTypeAssignableTo(errorType, type))
  );
}

/** The `f` of a `(0, f)` callee (a numeric left operand, so dropping it
 * changes only the call's receiver), or null. */
function receiverlessCalleeOf(callee: ts.Expression): ts.Expression | null {
  let e = callee;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  if (
    !ts.isBinaryExpression(e) ||
    e.operatorToken.kind !== ts.SyntaxKind.CommaToken ||
    !ts.isNumericLiteral(e.left)
  )
    return null;
  let right = e.right;
  while (ts.isParenthesizedExpression(right)) right = right.expression;
  return right;
}

export function lowerCall(lowerer: Lowerer, expr: ts.CallExpression): IrExpr {
  const loc = locOf(expr);
  if (lowerer.errorAccessorReflection === null) noteErrorAccessorReflection(lowerer, expr);
  // Object's checker return type is `any`. Claim known object inputs
  // before generic checked-dynamic dispatch tries to load the constructor.
  if (
    ts.isIdentifier(expr.expression) &&
    expr.expression.text === "Object" &&
    lowerer.isStdlibGlobal(expr.expression, "Object")
  ) {
    const object = lowerObjectConstructor(lowerer, expr.arguments.nodes, loc);
    if (object) return object;
  }

  // `EventEmitter.call(this)` in a constructor function: the untyped
  // EventEmitter constructor initializes the receiver.
  const builtinClassCall = lowerBuiltinClassCall(lowerer, expr);
  if (builtinClassCall) return builtinClassCall;

  // require() of a JSON document: the shared parsed object.
  const json = lowerJsonRequireCall(lowerer, expr);
  if (json) return json;

  // `(0, ns.member)(...)` over a builtin module (tsc's and esbuild's call
  // without a receiver): Node's module functions do not read `this`, so it
  // is the member call.
  {
    const member = receiverlessCalleeOf(expr.expression);
    if (member !== null && ts.isPropertyAccessExpression(member)) {
      const builtin = lowerer.lowerNamespaceBuiltinCall(expr, member);
      if (builtin) return builtin;
    }
  }

  // eval(...) and Function(...): Node's EvalError under
  // --disallow-code-generation-from-strings (code-generation.ts).
  {
    const codeGeneration = codeGenerationCalleeOf(lowerer, expr.expression);
    if (codeGeneration !== null) return lowerCodeGenerationCall(lowerer, expr, codeGeneration);
  }
  // The deprecated Buffer(...) call (containers/bytes.ts). The checker
  // types it `any`, so the bytes cross as a checked-dynamic value, which
  // keeps the Buffer brand for inspection.
  {
    const buffer = lowerBufferConstruct(lowerer, expr);
    if (buffer) return { kind: "dynFrom", value: buffer, type: DYN, loc };
  }
  // A package shim's runtime intrinsic (a bodiless `declare function`
  // named scriptcUnixDgram* in a shipped shim): a direct runtime call.
  if (ts.isIdentifier(expr.expression) && isShimIntrinsicName(expr.expression.text)) {
    const intrinsic = lowerShimIntrinsicCall(lowerer, expr, expr.expression, loc);
    if (intrinsic) return intrinsic;
  }
  // Inline require() of a program module (cjs-inline-require.ts): a
  // member call over its export table resolves like a binding's member
  // call after the module's %init at this position; the require itself
  // as a value answers the module's whole-export value.
  if (ts.isPropertyAccessExpression(expr.expression) && !expr.expression.questionDotToken) {
    const req = inlineNamespaceRequireOf(lowerer, expr.expression.expression);
    if (req !== null && !lowerer.inlineRequireInitDone.has(req.call)) {
      // Node calls the member with `this` bound to the module's exports.
      if (
        ts.isIdentifier(expr.expression.name) &&
        !cjsExportCallIgnoresThis(lowerer, req.dep, expr.expression.name.text)
      ) {
        lowerer.unsupported(
          "SC1090",
          expr,
          `calling '${expr.expression.name.text}' through require(${JSON.stringify(req.spec)}) when the function may read 'this' (Node binds it to the module's exports object, which compiles to a static table — bind the module and call a local function instead)`,
        );
      }
      return lowerWithInlineRequireInit(lowerer, req, () => lowerCall(lowerer, expr));
    }
  }
  {
    const inlineValue = lowerInlineRequireValue(lowerer, expr);
    if (inlineValue) return inlineValue;
  }

  // A call whose chain ROOTS at an ambient-undefined name (`declare
  // const value: Y | undefined; value?.foo("a")`, `declare function
  // chain...; chain(o).mapValues(f).value()`, a trap binding's read):
  // Node evaluates the root FIRST and throws the catchable
  // ReferenceError before any member, type argument, or argument runs —
  // the whole call IS that throw, typed by the use site (arguments
  // never lower; Node never evaluates them). Claimed before every
  // intrinsic and dispatch path: no lowering can answer differently
  // when the root read itself is the crash.
  {
    const root = ambientUndefVarRootOf(lowerer, expr);
    if (root !== null) {
      const mapped = lowerer.mapTypeOf(lowerer.typeOf(expr));
      const t =
        mapped && mapped.kind !== "void" && !lowerer.typeNamesUnregisteredClass(mapped)
          ? mapped
          : (contextualUndefReadType(lowerer, expr) ?? F64);
      return nsUndefRead(lowerer, root.text, expr, t);
    }
  }
  // A method call through a NULLISH binding (`const i: I<A & B> = null
  // as any; i.fn(...)` — the receiver provably holds null/undefined
  // forever): the member READ throws Node's exact TypeError before any
  // argument evaluates — the whole call lowers to that throw. Claimed
  // when the receiver's type has no mapping (no other story exists) or
  // the member is a generic signature (the alternative is the
  // interface-dispatch fence — the runtime truth is this throw).
  if (
    ts.isPropertyAccessExpression(expr.expression) &&
    ts.isIdentifier(expr.expression.expression) &&
    expr.expression.questionDotToken === undefined
  ) {
    const recvSym = lowerer.resolveValueSymbol(expr.expression.expression);
    const unit = nullishValueUnitOf(lowerer, recvSym);
    if (unit !== null) {
      const recvUnmappable =
        recvSym !== null && lowerer.mapTypeOf(lowerer.checker.getTypeOfSymbol(recvSym)) === null;
      const propSym = lowerer.checker.getPropertyOfType(
        lowerer.typeOf(expr.expression.expression),
        expr.expression.name.text,
      );
      const genericMember =
        propSym !== undefined &&
        propSym !== null &&
        isGenericCallableMemberType(lowerer.checker.getTypeOfSymbol(propSym), lowerer.checker);
      if (recvUnmappable || genericMember) {
        const mapped = lowerer.mapTypeOf(lowerer.typeOf(expr));
        const t =
          mapped && mapped.kind !== "void" && !lowerer.typeNamesUnregisteredClass(mapped)
            ? mapped
            : F64;
        return nodeThrowExpr(
          1,
          "",
          `Cannot read properties of ${unit} (reading '${expr.expression.name.text}')`,
          t,
          loc,
        );
      }
    }
  }

  // `require("spec")` through a createRequire binding (and the inline
  // `createRequire(import.meta.url)("spec")` spelling — a CallExpression
  // callee no other dispatch path serves): the static erasure —
  // builtins/json/npm per lowerCreateRequireCall's arms.
  {
    const crServed = lowerCreateRequireCall(lowerer, expr, loc);
    if (crServed) return crServed;
  }

  {
    const resolved =
      lowerImportMetaResolveCall(lowerer, expr) ?? lowerRequireResolveCall(lowerer, expr);
    if (resolved) return resolved;
  }
  // Any other require() call of the CommonJS global: MODULE_NOT_FOUND for
  // packages nothing installed resolves, a named refusal otherwise.
  {
    const uncompiled = lowerUncompiledRequireCall(lowerer, expr);
    if (uncompiled) return uncompiled;
  }

  // `process.getuid?.()` — intercepted BEFORE the optional-chain
  // machinery (the member always exists on a POSIX target, so the
  // optional call IS the call; `process.getuid` itself has no value
  // lowering for the chain to guard).
  // `h.return!()` / `h.return?.()` on a helper object: the method exists.
  const helperReturn = lowerHelperReturnCall(lowerer, expr);
  if (helperReturn) return helperReturn;
  const processOptional = lowerer.lowerProcessOptionalMethodCall(expr);
  if (processOptional) return processOptional;
  const reqStreamOptional = lowerCompatReqStreamOptionalCall(lowerer, expr);
  if (reqStreamOptional) return reqStreamOptional;
  // `t.unref?.()` on a Timeout handle — same story: the method always
  // exists, so the optional call is the call.
  if (expr.questionDotToken && ts.isPropertyAccessExpression(expr.expression)) {
    const timeoutOptional = lowerer.lowerTimeoutMethodCall(expr, expr.expression);
    if (timeoutOptional) return timeoutOptional;
  }
  // `req.session?.m(...)` remains absent on compatibility requests. Live
  // `req.stream` calls now pass through the normal optional-chain and h2
  // stream lowering using lowerServerProperty's checked getter.
  if (
    ts.isPropertyAccessExpression(expr.expression) &&
    ts.isPropertyAccessExpression(expr.expression.expression) &&
    !expr.expression.expression.questionDotToken &&
    expr.expression.expression.name.text === "session" &&
    ts.isIdentifier(expr.expression.expression.expression) &&
    lowerer.mapTypeOf(lowerer.typeOf(expr.expression.expression.expression))?.kind === "httpReq" &&
    lowerer.isStdlibMember(expr.expression.expression)
  ) {
    const member = expr.expression.expression.name.text;
    if (!ts.isExpressionStatement(expr.parent) && !ts.isArrowFunction(expr.parent)) {
      lowerer.unsupported(
        "SC1090",
        expr,
        `using the result of the '${member}${expr.expression.questionDotToken ? "?." : "."}${expr.expression.name.text}(...)' call (${member} is always undefined on this HTTP/1.1 lowering — call it as its own statement)`,
      );
    }
    if (!expr.expression.questionDotToken) {
      // The UNGUARDED form: on this lowering (and in Node, on every
      // HTTP/1.1 connection of an allowHTTP1 server) req.stream is
      // undefined — the member read on undefined THROWS Node's exact
      // TypeError, catchably (JS evaluates the receiver, throws reading
      // the method, and never evaluates the arguments — the identifier
      // receiver and unevaluated arguments make that order exact here).
      return {
        kind: "libCall",
        fn: "http2.streamUndefCall",
        args: [{ kind: "strLit", value: expr.expression.name.text, type: STRING, loc }],
        type: VOID,
        loc,
      };
    }
    return { kind: "libCall", fn: "http2.streamNoop", args: [], type: VOID, loc };
  }

  // `process.getBuiltinModule("node:os")` typed as the module namespace,
  // including pi's cast-and-probe spelling
  // `(process as P).getBuiltinModule?.("node:os")` (the member always
  // exists on Node 24's process object).
  {
    const namespace = lowerProcessBuiltinModuleNamespace(lowerer, expr);
    if (namespace) return namespace;
  }

  // Optional-chain call forms: `f?.()` (the token on the call) and
  // `a?.m()` (the token on the member access). The handled markers keep
  // the chain lowering's re-entrant dispatch from looping.
  if (
    (expr.questionDotToken && !lowerer.chainHandled.has(expr)) ||
    ((ts.isPropertyAccessExpression(expr.expression) ||
      ts.isElementAccessExpression(expr.expression)) &&
      expr.expression.questionDotToken &&
      !lowerer.chainHandled.has(expr.expression))
  ) {
    return lowerer.lowerOptionalChain(expr);
  }

  // super(...) is handled by the derived-constructor lowering as a
  // top-level statement (its field-initializer ordering lives there);
  // any other position would misorder initialization — rejected.
  if (expr.expression.kind === ts.SyntaxKind.SuperKeyword) {
    const superCall = lowerer.ctx.superCall;
    if (superCall) return superCall(expr) as IrExpr;
    lowerer.unsupported(
      "SC1090",
      expr,
      "super() calls anywhere but as a top-level constructor statement",
    );
  }
  // super.method(...): a DIRECT (never virtual) call of the base chain's
  // implementation over the same `this` — JS's super dispatch exactly.
  if (
    ts.isPropertyAccessExpression(expr.expression) &&
    expr.expression.expression.kind === ts.SyntaxKind.SuperKeyword
  ) {
    return lowerer.lowerSuperMethodCall(expr, expr.expression);
  }

  const consoleMember = lowerer.consoleCallMember(expr);
  const consoleMethod = consoleMember === null ? lowerer.consoleMethodMember(expr) : null;
  if (consoleMember !== null || consoleMethod !== null) {
    // A namespace returned by user code must evaluate before the log
    // arguments. Only the global and literal builtin require plumbing
    // have no receiver evaluation to preserve.
    const access = ts.isPropertyAccessExpression(expr.expression) ? expr.expression : null;
    const created =
      access && ts.isCallExpression(access.expression)
        ? createRequireSpecOf(lowerer, access.expression)
        : null;
    const receiver =
      access &&
      !lowerer.isStdlibGlobal(access.expression, "console") &&
      requireSpecOf(access.expression) === null &&
      created?.spec !== "node:console" &&
      created?.spec !== "console"
        ? lowerer.lowerExpr(access.expression)
        : null;
    const result =
      consoleMember !== null
        ? lowerConsoleOutput(
            lowerer,
            expr,
            consoleMember === "log" || consoleMember === "info" || consoleMember === "debug",
            `console.${consoleMember}`,
            loc,
          )
        : lowerConsoleMethodCall(lowerer, expr, consoleMethod!, loc);
    return receiver === null
      ? result
      : {
          kind: "seqExpr",
          stmts: [{ kind: "exprStmt", expr: receiver, loc }],
          result,
          type: result.type,
          loc,
        };
  }

  const consoleInstanceCall = lowerConsoleInstanceCall(lowerer, expr, loc);
  if (consoleInstanceCall) return consoleInstanceCall;

  if (
    ts.isPropertyAccessExpression(expr.expression) &&
    TIMER_MODULE_MEMBERS.has(expr.expression.name.text) &&
    lowerer.stdlibGlobalMember(expr.expression, "globalThis") === expr.expression.name.text
  ) {
    const served = lowerTimersMemberCall(lowerer, expr, expr.expression.name.text, loc);
    if (served) return served;
  }

  // The timer globals — setTimeout/clearTimeout, setInterval/
  // clearInterval, setImmediate/clearImmediate. Provenance-checked (a
  // user function shadowing the name has a different, non-ambient
  // symbol); the shared member dispatch also serves the node:timers
  // module forms (Node's timers module re-exports the globals).
  if (
    ts.isIdentifier(expr.expression) &&
    TIMER_MODULE_MEMBERS.has(expr.expression.text) &&
    lowerer.isStdlibSymbol(lowerer.resolveValueSymbol(expr.expression) ?? undefined) &&
    // A named/destructured node:timers/promises import shares the
    // spelling but is the PROMISIFIED surface (`await setTimeout(1)`)
    // — its own builtin-module lowering owns it below.
    lowerer.builtinImportOf(expr.expression)?.module !== "timers/promises"
  ) {
    const served = lowerTimersMemberCall(lowerer, expr, expr.expression.text, loc);
    if (served) return served;
  }

  // queueMicrotask: the callback enters the SAME FIFO promise
  // continuations ride (one microtask order), and a throw surfaces as
  // an UNCAUGHT exception, like Node. A checked-dynamic argument (the
  // mustCall wrapper, the suite's invalid-input probes) routes to the
  // runtime form that throws Node's ERR_INVALID_ARG_TYPE synchronously
  // on non-functions; extra arguments are Node-ignored (evaluated
  // nowhere — a documented residue: Node evaluates them). Provenance-
  // checked like setTimeout.
  if (
    ts.isIdentifier(expr.expression) &&
    expr.expression.text === "queueMicrotask" &&
    lowerer.isStdlibSymbol(lowerer.resolveValueSymbol(expr.expression) ?? undefined)
  ) {
    if (expr.arguments.nodes.length === 0) {
      // Node: queueMicrotask() throws ERR_INVALID_ARG_TYPE at runtime
      // (the undefined callback) — the Dyn form delivers exactly that.
      return {
        kind: "libCall",
        fn: "timers.queueMicrotaskDyn",
        args: [dynUndefinedExpr(loc)],
        type: VOID,
        loc,
      };
    }
    const raw = expr.arguments.nodes[0]!;
    const cb = lowerer.lowerExpr(raw);
    if (cb.type.kind === "dyn") {
      return { kind: "libCall", fn: "timers.queueMicrotaskDyn", args: [cb], type: VOID, loc };
    }
    if (cb.type.kind !== "func" && (cb.kind === "unitLit" || lowerer.dynConvertible(cb.type))) {
      // A statically-typed non-function (the invalid-input probes'
      // scalars and unions): Node's synchronous ERR_INVALID_ARG_TYPE,
      // through the Dyn form.
      return {
        kind: "libCall",
        fn: "timers.queueMicrotaskDyn",
        args: [{ kind: "dynFrom", value: cb, type: DYN, loc }],
        type: VOID,
        loc,
      };
    }
    const adapted = adaptZeroArgTimerCallback(lowerer, cb, raw, loc);
    if (adapted.type.kind !== "func") {
      lowerer.noLowering(
        `queueMicrotask with a '${lowerer.fmt(cb.type)}' argument`,
        raw,
        "a zero-parameter function is the lowered form",
      );
    }
    return { kind: "libCall", fn: "timers.queueMicrotask", args: [adapted], type: VOID, loc };
  }

  // structuredClone: the JSON-safe + bytes subset over the checked-dynamic tree, deep;
  // %DOMException clones through WebIDL serialization (name/message,
  // the code re-derives). Functions/handles throw the spec's catchable
  // DataCloneError; cycles fence (the checked-dynamic tree cannot represent them — Node
  // clones cycles, a documented divergence). Option validation throws
  // Node's exact errors; the zero-argument call Node's
  // ERR_MISSING_ARGS. Provenance-checked like setTimeout.
  if (
    ts.isIdentifier(expr.expression) &&
    expr.expression.text === "structuredClone" &&
    lowerer.isStdlibSymbol(lowerer.resolveValueSymbol(expr.expression) ?? undefined)
  ) {
    if (expr.arguments.nodes.length === 0) {
      return { kind: "libCall", fn: "dyn.cloneMissing", args: [], type: DYN, loc };
    }
    if (expr.arguments.nodes.length > 2) {
      lowerer.noLowering(`structuredClone with ${expr.arguments.nodes.length} arguments`, expr);
    }
    const toDynArg = (a: ts.Expression | undefined): IrExpr => {
      if (!a) return dynUndefinedExpr(loc);
      const v = lowerer.lowerExpr(a);
      const conv = lowerer.coerceToExpected(v, DYN);
      if (conv.type.kind !== "dyn") {
        lowerer.noLowering(
          `structuredClone with a '${lowerer.fmt(v.type)}' argument`,
          a,
          "JSON-safe data, bytes, and DOMException values are the cloneable subset",
        );
      }
      return conv;
    };
    const valueNode = expr.arguments.nodes[0]!;
    // A NON-EMPTY transfer array of static values: nothing static is
    // transferable, so the call is Node's DataCloneError — decided here
    // (the list's values need no dyn representation to fail). An EMPTY
    // literal transfer list is a no-op member and drops.
    {
      let optNode = expr.arguments.nodes[1];
      while (optNode && ts.isParenthesizedExpression(optNode)) optNode = optNode.expression;
      if (optNode && ts.isObjectLiteralExpression(optNode)) {
        const tr = optNode.properties.nodes.find(
          (p): p is ts.PropertyAssignment =>
            ts.isPropertyAssignment(p) &&
            p.name !== undefined &&
            (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) &&
            p.name.text === "transfer",
        );
        if (
          tr &&
          ts.isArrayLiteralExpression(tr.initializer) &&
          tr.initializer.elements.nodes.length > 0
        ) {
          // An ArrayBuffer first member may be a Buffer pool slab, which
          // Node reports as untransferable.
          const first = tr.initializer.elements.nodes[0]!;
          const firstType = ts.isSpreadElement(first) ? undefined : lowerer.typeOf(first);
          const parts = !firstType
            ? []
            : firstType.isUnionType()
              ? ts.constituentTypes(firstType)
              : [firstType];
          const isStorage =
            parts.length > 0 &&
            parts.every((part) => {
              const name = ts.symbolNameOf(part.getSymbol());
              return name === "ArrayBuffer" || name === "SharedArrayBuffer";
            });
          if (isStorage) {
            return {
              kind: "libCall",
              fn: "dyn.cloneTransferFailWith",
              args: [toDynArg(first)],
              type: DYN,
              loc,
            };
          }
          return { kind: "libCall", fn: "dyn.cloneTransferFail", args: [], type: DYN, loc };
        }
      }
    }
    const optsArg = toDynArg(expr.arguments.nodes[1]);
    // A DOMException value clones through its own runtime arm — the
    // typed result keeps the class (instanceof, .code, throwability).
    const valueT = lowerer.mapTypeOf(lowerer.typeOf(valueNode));
    if (valueT?.kind === "object" && valueT.className === "%DOMException") {
      const recv = lowerer.lowerExpr(valueNode);
      return {
        kind: "libCall",
        fn: "error.domClone",
        args: [recv, optsArg],
        type: { kind: "object", className: "%DOMException" },
        loc,
      };
    }
    const value = toDynArg(valueNode);
    const cloned: IrExpr = {
      kind: "libCall",
      fn: "dyn.structuredClone",
      args: [value, optsArg],
      type: DYN,
      loc,
    };
    // The declared result is the value's own type (the generic's T):
    // validate the dyn copy back into it when the type can be checked;
    // dyn-typed and unmappable results stay dyn values (JS files). An
    // empty record (`{}` inferred from a JavaScript `payload = {}`
    // default) is the checker's supertype of whatever arrives, not a
    // layout: checking into it would drop every member of the copy.
    const resultT = lowerer.mapTypeOf(lowerer.typeOf(expr));
    const resultShape =
      resultT?.kind === "record" ? lowerer.shapes.get(resultT.shapeId) : undefined;
    const emptyRecord =
      resultShape !== undefined &&
      !resultShape.tuple &&
      resultShape.indexValue === undefined &&
      resultShape.fields.length === 0;
    if (
      resultT !== null &&
      resultT.kind !== "dyn" &&
      resultT.kind !== "void" &&
      !emptyRecord &&
      canDynCheckTo(
        resultT,
        (id) => lowerer.shapes.get(id),
        (id) => lowerer.unions.get(id),
      )
    ) {
      return { kind: "dynCheck", value: cloned, type: resultT, loc };
    }
    return cloned;
  }

  // comptime: compile-time evaluation. Provenance-checked like setTimeout —
  // a user function named `comptime` has a different, non-ambient symbol
  // and takes the ordinary call paths.
  if (
    ts.isIdentifier(expr.expression) &&
    expr.expression.text === "comptime" &&
    lowerer.isStdlibSymbol(lowerer.resolveValueSymbol(expr.expression) ?? undefined)
  ) {
    return lowerer.lowerComptime(expr);
  }

  // The lib constructors-as-functions with STATIC conversion semantics:
  // String(x) is exactly the template-literal ToString, Boolean(x) is
  // exactly the condition ToBoolean (union arms included), Number(x) is
  // ToNumber where it lowers exactly: numbers pass through, booleans
  // become 1/0, null becomes 0, and undefined becomes NaN. Strings use
  // the runtime's StringToNumber parser (num.fromString — the full
  // StringNumericLiteral grammar in scr_string.c).
  // Provenance-checked like setTimeout; zero-arg forms are the JS
  // constants ("", false, 0). Wrapper objects stay fenced except where
  // the receiver is immediately converted by a direct String method call.
  if (lowerer.isStdlibGlobal(expr.expression, "BigInt")) {
    if (expr.arguments.nodes.length !== 1) {
      lowerer.noLowering(`BigInt with ${expr.arguments.nodes.length} arguments`, expr);
    }
    const argNode = expr.arguments.nodes[0]!;
    // Captured optional storage can change after TypeScript's guard.
    // BigInt consumes the stored value, including its nullish tag.
    const arg = optionalCallValue(lowerer, argNode) ?? lowerer.lowerExpr(argNode);
    const converted = lowerBigIntConstructorValue(lowerer, arg, loc);
    if (converted) return converted;
    lowerer.noLowering(
      `BigInt of ${lowerer.fmt(arg.type)} values`,
      argNode,
      "string, number, boolean, and bigint arguments are supported",
    );
  }

  if (
    lowerer.isStdlibGlobal(expr.expression, "String") ||
    lowerer.isStdlibGlobal(expr.expression, "Boolean") ||
    lowerer.isStdlibGlobal(expr.expression, "Number")
  ) {
    const name = lowerer.isStdlibGlobal(expr.expression, "String")
      ? "String"
      : lowerer.isStdlibGlobal(expr.expression, "Boolean")
        ? "Boolean"
        : "Number";
    if (expr.arguments.nodes.length > 1) {
      lowerer.noLowering(`${name} with ${expr.arguments.nodes.length} arguments`, expr);
    }
    const argNode = expr.arguments.nodes[0];
    if (!argNode) {
      if (name === "String") return { kind: "strLit", value: "", type: STRING, loc };
      if (name === "Boolean") return { kind: "boolLit", value: false, type: BOOL, loc };
      return { kind: "numLit", value: 0, type: F64, loc };
    }
    // String(e) on a catch binding: the snapshot's own ToString —
    // intercepted before lowerExpr (caughtRead would fence the raw read).
    if (name === "String") {
      const caught = lowerer.caughtToString(argNode);
      if (caught) return caught;
    }
    // Boolean(x) IS condition position: route through lowerCondition so
    // `&&`/`||` operands descend as ToBoolean'd conditions (JS-exact —
    // `Boolean(a && b)` ≡ `Boolean(a) && Boolean(b)`, short-circuit
    // preserved). This also admits mixed-kind operands with no VALUE
    // representation (`Boolean(rec && list.some(f))` — a record and a
    // bool) that a value lowering of the `&&` would fence on.
    if (name === "Boolean") return lowerer.lowerCondition(argNode);
    if (name === "Number") return lowerNumberConstructorValue(lowerer, argNode, loc);
    const arg = lowerer.lowerExpr(argNode);
    if (
      name === "String" &&
      (arg.type.kind === "dyn" ||
        (arg.type.kind === "union" &&
          lowerer.unions.get(arg.type.unionId)?.arms.some((arm) => arm.kind === "symbol") &&
          lowerer.dynConvertible(arg.type)))
    ) {
      return {
        kind: "libCall",
        fn: "dyn.stringConstructor",
        args: [lowerer.coerceToExpected(arg, DYN)],
        type: STRING,
        loc,
      };
    }
    if (name === "String") return lowerer.ensureString(arg, argNode);
  }

  // Computed calls preserve their evaluated receiver just like dotted
  // calls, including when the property is keyed by a native symbol.
  if (
    ts.isElementAccessExpression(expr.expression) &&
    !lowerer.chainBlocked(expr, expr.expression)
  ) {
    const access = expr.expression;
    lowerer.fenceStaticResponseMember(access, "call");
    lowerer.fenceStaticHeadersMember(access, "call");
    lowerer.fenceStaticReadableStreamMember(access, "call");
    const source = tryLowerExpression(lowerer, access.expression);
    if (
      source &&
      (source.type.kind === "dyn" ||
        source.type.kind === "func" ||
        (source.type.kind === "union" &&
          isJsSourceFile(ts.getSourceFileOfNode(expr)) &&
          lowerer.dynConvertible(source.type)) ||
        ((source.type.kind === "map" || source.type.kind === "set") &&
          lowerer.dynConvertible(source.type)) ||
        (isDynTypedRefType(source.type) &&
          lowerer.foldedStringKeyOf(access.argumentExpression) === null &&
          lowerer.mapTypeOf(lowerer.typeOf(access.argumentExpression))?.kind !== "symbol"))
    ) {
      const local = lowerer.declareHiddenLocal("%computedReceiver", DYN);
      const receiver = varRef(local.id, DYN, loc);
      const key = lowerer.lowerExprExpecting(access.argumentExpression, DYN);
      const callee: IrExpr = { kind: "dynKeyGet", value: receiver, key, type: DYN, loc };
      const args = expr.arguments.nodes.map((arg) =>
        lowerer.lowerExprExpecting(ts.isSpreadElement(arg) ? arg.expression : arg, DYN),
      );
      const spreads = expr.arguments.nodes.flatMap((arg, index) =>
        ts.isSpreadElement(arg) ? [{ arg: index, what: ts.getTextOfNode(arg.expression) }] : [],
      );
      return {
        kind: "seqExpr",
        stmts: [
          { kind: "varDecl", localId: local.id, init: lowerer.coerceToExpected(source, DYN), loc },
        ],
        result: {
          kind: "dynCall",
          callee,
          receiver,
          calleeName: ts.getTextOfNode(access),
          args,
          ...(spreads.length > 0 ? { spreads } : {}),
          type: DYN,
          loc,
        },
        type: DYN,
        loc,
      };
    }
  }

  // Builtin-module functions (fs, path, os, ...): named imports whose
  // binding resolves to a supported builtin specifier lower to `libCall`.
  // A user local shadowing an import has a different symbol and never
  // lands here. The fallback declarations make unsupported call forms
  // type errors; under @types/node the real (much wider) signatures
  // typecheck — options objects, omitted encodings, Buffer data — so the
  // supported form is fenced here per site. Members with no lowering at
  // all (fs.watch, os.cpus, ...) fence with the module-qualified name.
  if (ts.isIdentifier(expr.expression)) {
    if (expr.expression.text === "Array" && lowerer.isStdlibGlobal(expr.expression, "Array")) {
      return lowerArrayConstructor(lowerer, expr, expr.arguments.nodes);
    }
    // A call through a compile-time util.promisify projection. execFile
    // keeps its custom result helper; ordinary builtins route through
    // their existing promise-module lowering.
    {
      const sym = lowerer.resolveValueSymbol(expr.expression);
      const projection = sym ? lowerer.staticCallables.get(sym) : undefined;
      if (projection?.kind === "promisified-exec-file") {
        return lowerer.lowerExecFileAsyncCall(expr, loc);
      }
      if (projection?.kind === "promisified-exec") {
        return lowerer.lowerExecFileAsyncCall(expr, loc, true);
      }
      if (projection?.kind === "promisified-zlib") {
        return lowerPromisifiedZlibCall(lowerer, expr, projection.member, loc);
      }
      if (projection?.kind === "promisified-crypto") {
        return lowerPromisifiedCryptoCall(lowerer, expr, projection.member, loc);
      }
      if (projection?.kind === "promisified-dns") {
        return lowerPromisifiedDnsCall(lowerer, expr, projection.member, loc);
      }
      if (projection?.kind === "promisified-builtin") {
        return lowerBuiltinCall(
          lowerer,
          expr,
          { module: projection.module, member: projection.member },
          loc,
        );
      }
      if (projection?.kind === "builtin-function") {
        return lowerBuiltinCall(
          lowerer,
          expr,
          { module: projection.module, member: projection.member },
          loc,
        );
      }
      // A call through a `const requestFn = tls ? https.request :
      // http.request` binding (the client-function ternary): the http
      // client lowering with the RUNTIME-secure dial.
      const rf = sym ? httpClientFnBindingOf(lowerer, sym) : undefined;
      if (rf) return lowerHttpClientFnCall(lowerer, expr, rf, loc);
    }
    if (threadsImportOf(lowerer.program, expr.expression) === "publish") {
      // @scriptc/threads publish(value): the same value, its graph made
      // immortal and immutable (backend/llvm/publish.ts).
      if (expr.arguments.nodes.length !== 1 || ts.isSpreadElement(expr.arguments.nodes[0]!))
        lowerer.noLowering(`publish with ${expr.arguments.nodes.length} arguments`, expr);
      const value = lowerer.lowerExpr(expr.arguments.nodes[0]!);
      return { kind: "intrinsic", name: "threads.publish", args: [value], type: value.type, loc };
    }
    const bi = lowerer.builtinImportOf(expr.expression);
    if (bi) return lowerBuiltinCall(lowerer, expr, bi, loc);
    // The assert module binding called DIRECTLY (`assert(x)` — a default
    // import or the CJS `const assert = require("assert")`): Node's
    // module object IS assert.ok; namespace-import bindings fence inside
    // (ES namespace objects are not callable in Node).
    {
      const direct = lowerer.lowerAssertDirectCall(expr, loc);
      if (direct) return direct;
    }
    // The node:test module binding called DIRECTLY (`test(...)` — a
    // default import or the CJS `const test = require('node:test')`):
    // Node's module object IS the test function.
    {
      const direct = lowerer.lowerTestDirectCall(expr, loc);
      if (direct) return direct;
    }
    // `Symbol(desc?)` — the global Symbol factory (provenance like
    // parseInt: a user function shadowing the name has a different,
    // non-stdlib symbol). A fresh runtime-unique identity per call;
    // the optional description must be a string (Node ToStrings other
    // values — no static lowering, fenced with the honest hint).
    // `new Symbol()` throws in Node and is a checker error — the
    // generic new fence keeps it.
    if (
      expr.expression.text === "Symbol" &&
      lowerer.isStdlibSymbol(lowerer.resolveValueSymbol(expr.expression) ?? undefined)
    ) {
      if (expr.arguments.nodes.length > 1) {
        lowerer.noLowering(`Symbol with ${expr.arguments.nodes.length} arguments`, expr);
      }
      const argNode = expr.arguments.nodes[0];
      // A literal `undefined` argument IS the no-description form
      // (Symbol(undefined).description is undefined, like Symbol()).
      if (!argNode || (ts.isIdentifier(argNode) && argNode.text === "undefined")) {
        return { kind: "libCall", fn: "sym.newAnon", args: [], type: SYMBOL_T, loc };
      }
      const desc = lowerer.lowerExpr(argNode);
      if (desc.type.kind !== "string") {
        lowerer.noLowering(
          `Symbol with a '${lowerer.fmt(desc.type)}' description`,
          argNode,
          "only string descriptions lower (Node would ToString the value — convert it explicitly)",
        );
      }
      return { kind: "libCall", fn: "sym.new", args: [desc], type: SYMBOL_T, loc };
    }
    // STATIC parseInt/parseFloat/isNaN/isFinite (num.parseInt /
    // num.parseFloat / num.isNaN / number.isFinite — scr_string.c,
    // scr_lib.c; ECMA-exact, Node is the oracle). Declaration provenance
    // excludes shadowed names. parseInt's omitted radix completes
    // to 0 — the spec's "undefined" (base 10 with the 0x hex escape);
    // parseFloat lowers the STRING form only (Node would ToString other
    // values — no static story); isNaN/isFinite apply the global's
    // ToNumber to any argument, then test like Number.isNaN /
    // Number.isFinite.
    if (
      (expr.expression.text === "parseInt" ||
        expr.expression.text === "isNaN" ||
        expr.expression.text === "parseFloat" ||
        expr.expression.text === "isFinite") &&
      lowerer.isStdlibSymbol(lowerer.resolveValueSymbol(expr.expression) ?? undefined)
    ) {
      const parsed = lowerStaticNumberGlobal(
        lowerer,
        expr.expression.text,
        expr,
        expr.arguments.nodes,
        loc,
      );
      if (parsed !== null) return parsed;
    }
    // STATIC encodeURIComponent/encodeURI/decodeURIComponent
    // (str.encodeUriComponent / str.encodeUri / str.decodeUriComponent —
    // scr_string.c; ECMA-exact over the runtime's UTF-8 strings, Node
    // is the oracle). Provenance like parseInt: a user function
    // shadowing the name has a different, non-stdlib symbol. The
    // ENCODERS accept string | number | boolean — the spec ToStrings
    // first, which ensureString reproduces exactly for these types;
    // they THROW the spec's URIError on an unpaired surrogate. decode
    // THROWS the spec's URIError ("URI malformed") catchably and keeps
    // the string-only argument rule.
    if (
      (expr.expression.text === "encodeURIComponent" ||
        expr.expression.text === "encodeURI" ||
        expr.expression.text === "decodeURI" ||
        expr.expression.text === "decodeURIComponent") &&
      lowerer.isStdlibSymbol(lowerer.resolveValueSymbol(expr.expression) ?? undefined)
    ) {
      const name = expr.expression.text;
      if (expr.arguments.nodes.length !== 1) {
        lowerer.noLowering(
          `${name} with ${expr.arguments.nodes.length} argument${expr.arguments.nodes.length === 1 ? "" : "s"}`,
          expr,
        );
      }
      const loc = locOf(expr);
      const argNode = expr.arguments.nodes[0]!;
      if (name === "decodeURIComponent" || name === "decodeURI") {
        const d = optionalCallValue(lowerer, argNode) ?? lowerer.lowerExpr(argNode);
        const s = lowerer.ensureString(d, argNode);
        return {
          kind: "libCall",
          fn: name === "decodeURI" ? "str.decodeUri" : "str.decodeUriComponent",
          args: [s],
          type: STRING,
          loc,
        };
      }
      const value = optionalCallValue(lowerer, argNode) ?? lowerer.lowerExpr(argNode);
      const s = lowerer.ensureString(value, argNode);
      return {
        kind: "libCall",
        fn: name === "encodeURIComponent" ? "str.encodeUriComponent" : "str.encodeUri",
        args: [s],
        type: STRING,
        loc,
      };
    }
    // STATIC atob/btoa (str.atob / str.btoa — scr_string.c; WHATWG
    // forgiving-base64, Node is the oracle). The argument crosses as a
    // dyn value: WebIDL ToString runs in the runtime over the dyn kind
    // (Node's atob(null) decodes "null"), a malformed input throws the
    // catchable DOMException InvalidCharacterError, and the
    // zero-argument call throws Node's TypeError [ERR_MISSING_ARGS].
    // Provenance like parseInt: a shadowing user function has a
    // different, non-stdlib symbol.
    if (
      (expr.expression.text === "atob" || expr.expression.text === "btoa") &&
      lowerer.isStdlibSymbol(lowerer.resolveValueSymbol(expr.expression) ?? undefined)
    ) {
      const name = expr.expression.text;
      if (expr.arguments.nodes.length === 0) {
        return { kind: "libCall", fn: "str.b64Missing", args: [], type: STRING, loc };
      }
      if (expr.arguments.nodes.length > 1) {
        lowerer.noLowering(`${name} with ${expr.arguments.nodes.length} arguments`, expr);
      }
      const argNode = expr.arguments.nodes[0]!;
      const v = lowerer.lowerExpr(argNode);
      let data: IrExpr;
      if (v.type.kind === "dyn") {
        data = v;
      } else if (v.kind === "unitLit" || lowerer.dynConvertible(v.type)) {
        data = { kind: "dynFrom", value: v, type: DYN, loc };
      } else {
        lowerer.noLowering(
          `${name} with a '${lowerer.fmt(v.type)}' argument`,
          argNode,
          "string-convertible arguments lower (Node ToStrings the value — convert it explicitly)",
        );
      }
      return {
        kind: "libCall",
        fn: name === "atob" ? "str.atob" : "str.btoa",
        args: [data],
        type: STRING,
        loc,
      };
    }

    // global function executes — callFn(globalGet(name)) — and the
    // result exits to the declared static type. A user function
    // shadowing the name has a different, non-stdlib symbol.
    const islFn = lowerer.stdlibGlobalFnOf(expr.expression);
    if (islFn && expr.arguments.nodes.length !== islFn.args.length) {
      const name = expr.expression.text;
      lowerer.noLowering(
        `${name} with ${expr.arguments.nodes.length} argument${expr.arguments.nodes.length === 1 ? "" : "s"}`,
        expr,
      );
    }
    if (islFn && expr.arguments.nodes.length === islFn.args.length) {
      // The static forms above already took the exactly-typed argument
      // (a string for parseFloat): name the argument type that refused
      // the call, so the message states the condition rather than
      // reading as if the global itself were unsupported.
      const argText = loweredArgumentText(lowerer, expr.arguments.nodes[0]!);
      lowerer.refuseUnsupportedApi(
        `'${expr.expression.text}' with a '${argText}' argument`,
        expr,
        "only a string argument compiles statically: convert the argument explicitly first (for example String(x), or narrow the union)",
      );
    }
  }

  // A TYPE-GUARD call on a catch binding (`isErrnoException(err)` —
  // `(x: unknown) => x is T` with a single-return body): the caught
  // snapshot cannot cross a call boundary (KEEP NARROW), so the
  // predicate's return expression inlines HERE with the parameter bound
  // to the caught local — every caught lowering (instanceof, `in`,
  // typeof tests) applies inside it, tsc's call-site narrowing types
  // the guarded branch, and a body construct with no caught lowering
  // fences per site at its own location.
  if (ts.isIdentifier(expr.expression) && expr.arguments.nodes.length === 1) {
    const caughtArg = lowerer.caughtLocalOf(expr.arguments.nodes[0]!);
    if (caughtArg) {
      const inlined = lowerCaughtPredicateCall(lowerer, expr, caughtArg);
      if (inlined) return inlined;
    }
  }

  // A MIXIN call in value position (`const Thing1 = Tagged(Derived)`,
  // an argument, a log): the value is the per-call-site instantiation's
  // immortal class object — everything downstream (construction,
  // statics, extends, instanceof, identity) rides the classval
  // machinery unchanged (lower-mixins.ts). Non-mixin callees fall
  // through untouched; a recognized mixin with an unsupported argument
  // or position fences by name inside.
  if (ts.isIdentifier(expr.expression)) {
    const mixinInfo = lowerer.mixinCallClassInfoOf(expr);
    if (mixinInfo) return lowerer.classValueRef(mixinInfo, expr);
  }

  // Direct call of a top-level declared function: the fast path (no
  // closure object, plain C call). Generic functions route through
  // monomorphization (the call targets a per-instantiation instance).
  if (ts.isIdentifier(expr.expression) && !lowerer.isSelfReference(expr.expression)) {
    // A JS spread argument the compile-time completion cannot take (a
    // fixed position, a dynamic rest slot) sends the call down the
    // VALUE path — the runtime-arity lane (lowerSpreadArgsCall) boxes
    // the declaration's value and applies through a runtime-built
    // argument list. Typed .ts spreads keep completeArgs' rest packing.
    const jsSpreadArgs =
      expr.arguments.nodes.some((a) => ts.isSpreadElement(a)) &&
      isJsSourceFile(ts.getSourceFileOfNode(expr));
    if (lowerer.isTopLevelFnSymbol(expr.expression) && !lowerer.peekLocal(expr.expression)) {
      // `import g = N.f; g()` — the alias's own source-order guards
      // (a no-op for every non-import= binding).
      fenceEarlyAliasUse(lowerer, expr.expression, expr);
      const generic = lowerer.genericFnOf(expr.expression);
      // An implicit-any JS function spread-forwarded into: per-site
      // monomorphization has no slot for a runtime-length argument
      // list — the value path's boxed thunk delivers JS arity instead.
      if (generic && !(jsSpreadArgs && generic.implicitParams))
        return lowerer.lowerGenericCall(expr, generic);
      const sig = generic ? null : lowerer.fnSigOf(expr.expression);
      if (
        sig &&
        !(jsSpreadArgs && spreadNeedsRuntimeArity(lowerer, sig.params, expr.arguments.nodes))
      ) {
        lowerer.noteEdge(sig.name);
        const args = lowerer.completeArgs(expr.arguments.nodes, sig.params, loc, expr);
        const symbol = lowerer.resolveValueSymbol(expr.expression);
        const declaration = symbol ? symbol.valueDeclaration : undefined;
        // A bare call supplies undefined as this, even inside a callback
        // currently carrying a receiver. The value-call ABI saves and
        // restores that ambient receiver around the function invocation.
        if (
          declaration &&
          ts.isFunctionDeclaration(declaration) &&
          declaration.parameters.nodes.some(isThisParameter)
        ) {
          const callee = lowerer.lowerExpr(expr.expression);
          return reconcileOverloadReturn(lowerer, expr, {
            kind: "callValue",
            callee,
            args,
            type: sig.returnType,
            loc,
          });
        }
        return reconcileOverloadReturn(lowerer, expr, {
          kind: "call",
          callee: sig.name,
          args,
          type: sig.returnType,
          loc,
        });
      }
      // An ambient `declare function` nothing defines: Node evaluates
      // the callee first and throws ReferenceError before any argument
      // runs — undefRead reproduces it exactly (the ambient-namespace
      // callee stance; arguments never lower, Node never evaluates
      // them). The result type is what the use site sees; a VOID,
      // unmappable, or unregistered-class result takes the F64 dummy
      // (the read always throws first, so the dummy is never observed).
      if (ambientUndefinedFnSymbolOf(lowerer, expr.expression)) {
        const mapped = lowerer.mapTypeOf(lowerer.typeOf(expr));
        const t =
          mapped && mapped.kind !== "void" && !lowerer.typeNamesUnregisteredClass(mapped)
            ? mapped
            : F64;
        return nsUndefRead(lowerer, expr.expression.text, expr, t);
      }
    }
    // Calls through a generic function value BINDING (`const f = <T>(x:
    // T) => x; f(1)`): the binding provably holds its initializer
    // forever (never-reassigned — bindingGenericFnInfoOf's fences), so
    // the call monomorphizes against it exactly like a generic function
    // declaration and the binding is never read. Symbol identity does
    // the discrimination — a shadowing local has its own symbol, and
    // registered bindings never declare locals or globals. Implicit-any
    // JS bindings spread-forwarded into skip to the value path (the
    // runtime-arity lane), like the declaration form above.
    {
      const generic = lowerer.genericFnOf(expr.expression);
      if (generic && !(jsSpreadArgs && generic.implicitParams))
        return lowerer.lowerGenericCall(expr, generic);
    }
  }
  // Expando member calls (`example.isFoo('test')` after `example.isFoo
  // = fn`): read the member's global and call through the value —
  // lower-expando.ts owns the member storage.
  if (
    (ts.isPropertyAccessExpression(expr.expression) ||
      ts.isElementAccessExpression(expr.expression)) &&
    !expr.expression.questionDotToken
  ) {
    const callee = expandoMemberRead(lowerer, expr.expression);
    if (callee) {
      if (callee.type.kind !== "func")
        lowerer.badType(expr.expression, lowerer.typeOf(expr.expression));
      const args = completeFuncValueArgs(lowerer, expr, callee.type, loc);
      return { kind: "callValue", callee, args, type: callee.type.ret, loc };
    }
  }
  // Namespace-qualified calls (`N.f(1)`, `A.B.g()`, calls through
  // import= alias chains): the member resolves like a bare identifier —
  // the direct path when a signature exists (generic instantiation
  // included), the ordinary call-through-value otherwise. Guarded by the
  // namespace source-order fences (lower-namespaces.ts).
  if (
    ts.isPropertyAccessExpression(expr.expression) &&
    !expr.expression.questionDotToken &&
    ts.isIdentifier(expr.expression.name)
  ) {
    const nsMember = nsMemberIdentOf(lowerer, expr.expression);
    if (nsMember) {
      // A builtin RE-EXPORT FACADE member (`import * as assert from
      // "./facade.js"` over `export { ok } from "node:assert"` —
      // a universal re-export facade): builtinMemberOf's alias chase
      // resolves the builtin module/member, and the spokes own the call
      // exactly as a direct builtin import. Ordinary user-module
      // members answer null there and resolve below.
      const facadeServed = lowerer.lowerNamespaceBuiltinCall(expr, expr.expression);
      if (facadeServed) return facadeServed;
      const memberSym = lowerer.checker.getSymbolAtLocation(nsMember);
      if (memberSym) fenceEarlyNsMemberRef(lowerer, expr.expression, memberSym);
      refuseModuleMemberThis(lowerer, expr, nsMember);
      const generic = lowerer.genericFnOf(nsMember);
      if (generic) return lowerer.lowerGenericCall(expr, generic);
      const sig = lowerer.fnSigOf(nsMember);
      if (sig) {
        lowerer.noteEdge(sig.name);
        const args = lowerer.completeArgs(expr.arguments.nodes, sig.params, loc, expr);
        return reconcileOverloadReturn(lowerer, expr, {
          kind: "call",
          callee: sig.name,
          args,
          type: sig.returnType,
          loc,
        });
      }
      let callee = lowerer.lowerExpr(nsMember);
      if (callee.type.kind === "record") callee = lowerer.hybridCallUnwrap(callee);
      const checked = lowerCheckedCallableValue(lowerer, expr, callee, loc);
      if (checked) return checked;
      if (callee.type.kind !== "func")
        lowerer.badType(expr.expression, lowerer.typeOf(expr.expression));
      const args = completeFuncValueArgs(lowerer, expr, callee.type, loc);
      return { kind: "callValue", callee, args, type: callee.type.ret, loc };
    }
    // An AMBIENT namespace callee (`M.f()` where only `declare
    // namespace M` exists): Node evaluates the callee first and throws
    // ReferenceError before any argument runs — undefRead reproduces it
    // exactly (arguments never lower; Node never evaluates them).
    const ambientRoot = ambientNsRootOf(lowerer, expr.expression.expression);
    if (ambientRoot !== null) {
      // The result type is what the use site sees; a VOID, unmappable,
      // or unregistered-class result takes the F64 dummy (the read
      // always throws first, so the dummy is never observed — tsc keeps
      // void results out of value positions).
      const mapped = lowerer.mapTypeOf(lowerer.typeOf(expr));
      const t =
        mapped && mapped.kind !== "void" && !lowerer.typeNamesUnregisteredClass(mapped)
          ? mapped
          : F64;
      return nsUndefRead(lowerer, ambientRoot.text, expr, t);
    }
  }
  // CommonJS namespace member calls (`lib.double(5)` where lib is
  // `const lib = require("./lib.js")`): the export table is alias
  // plumbing, so the member call IS a call of the exporter's declaration
  // — the direct path when a signature exists (generic instantiation
  // included), the ordinary call-through-value otherwise (func-typed
  // export globals).
  if (
    ts.isPropertyAccessExpression(expr.expression) &&
    !expr.expression.questionDotToken &&
    lowerer.cjsLocalModuleBindingOf(expr.expression.expression)
  ) {
    // A binding whose dep is a class-expression WHOLE export
    // (`module.exports = class {…}`): `C.describe()` is a STATIC call
    // on that class — the static machinery answers before the member
    // delegation below resolves `describe` as a bare name (which no
    // binding form supports).
    const viaStatic = lowerStaticMethodCall(lowerer, expr, expr.expression);
    if (viaStatic) return viaStatic;
    const nameId = expr.expression.name;
    if (!ts.isIdentifier(nameId)) {
      lowerer.unsupported("SC1090", nameId, "private-named module members");
    }
    refuseModuleMemberThis(lowerer, expr, nameId);
    const generic = lowerer.genericFnOf(nameId);
    if (generic) return lowerer.lowerGenericCall(expr, generic);
    const sig = lowerer.fnSigOf(nameId);
    if (sig) {
      lowerer.noteEdge(sig.name);
      const args = lowerer.completeArgs(expr.arguments.nodes, sig.params, loc, expr);
      return reconcileOverloadReturn(lowerer, expr, {
        kind: "call",
        callee: sig.name,
        args,
        type: sig.returnType,
        loc,
      });
    }
    let callee = lowerer.lowerExpr(nameId);
    if (callee.type.kind === "record") callee = lowerer.hybridCallUnwrap(callee);
    const checked = lowerCheckedCallableValue(lowerer, expr, callee, loc);
    if (checked) return checked;
    if (callee.type.kind !== "func")
      lowerer.badType(expr.expression, lowerer.typeOf(expr.expression));
    const args = completeFuncValueArgs(lowerer, expr, callee.type, loc);
    return { kind: "callValue", callee, args, type: callee.type.ret, loc };
  }
  // `exports.f(x)` / `module.exports.f(x)` inside the module: a call of
  // the member's export global (cjs-exports-object.ts), the value every
  // `exports.f =` statement assigns.
  if (ts.isPropertyAccessExpression(expr.expression) && !expr.questionDotToken) {
    const g = cjsInFileExportGlobalOf(lowerer, expr.expression);
    if (
      g &&
      (g.type.kind === "func" || g.type.kind === "dyn") &&
      !cjsExportCallIgnoresThis(lowerer, ts.getSourceFileOfNode(expr), expr.expression.name.text)
    ) {
      lowerer.unsupported(
        "SC1090",
        expr,
        `calling '${ts.getTextOfNode(expr.expression)}' through the module's exports object when the function may read 'this' (Node binds it to the exports object, which compiles to a static table — call a local function instead)`,
      );
    }
    if (g && (g.type.kind === "func" || g.type.kind === "dyn")) {
      const callee: IrExpr = { kind: "varRef", localId: g.id, type: g.type, loc };
      const checked = lowerCheckedCallableValue(lowerer, expr, callee, loc);
      if (checked) return checked;
      if (callee.type.kind === "func") {
        const args = completeFuncValueArgs(lowerer, expr, callee.type, loc);
        return { kind: "callValue", callee, args, type: callee.type.ret, loc };
      }
    }
  }
  if (ts.isPropertyAccessExpression(expr.expression)) {
    const intrinsic =
      // Checked-dynamic stream slots dispatch per value (dyn-streams.ts).
      lowerDynStreamMemberCall(lowerer, expr, expr.expression) ??
      fenceNodeModuleMutationCall(lowerer, expr, expr.expression) ??
      // `f.apply(thisArg, args)` forwarding a fixed argument tuple (typed
      // `arguments`, a tuple rest parameter): a direct call.
      lowerForwardingApply(lowerer, expr, expr.expression) ??
      // Builtin namespace imports first (`fs.readFileSync(...)` where fs
      // is `import * as fs from "node:fs"`): the same tables and fences
      // as named builtin imports — before anything below tries to lower
      // the namespace object itself as a receiver.
      lowerer.lowerNamespaceBuiltinCall(expr, expr.expression) ??
      // Method calls on a static node:assert Assert instance.
      lowerAssertInstanceCall(lowerer, expr, expr.expression, locOf(expr)) ??
      // The node:perf_hooks spoke: performance.now() and its
      // .bind(performance) function value over the runtime's
      // process-start-anchored monotonic clock.
      lowerPerfHooksCall(lowerer, expr, expr.expression) ??
      lowerHistogramMethodCall(lowerer, expr, expr.expression) ??
      // The composed crypto pattern (randomBytes(n).toString(enc))
      // — its receiver is a Buffer-typed CALL no other lowering claims.
      lowerer.lowerCryptoComposedCall(expr, expr.expression) ??
      lowerer.lowerProcessMethodCall(expr, expr.expression) ??
      lowerer.lowerJsonMethodCall(expr, expr.expression) ??
      // Reflect.apply of a builtin rest-parameter fn (fixtures.js's
      // fixturesPath idiom) — before the stdlib member fence claims it.
      lowerReflectCall(lowerer, expr, expr.expression) ??
      lowerBigIntStaticCall(lowerer, expr, expr.expression) ??
      lowerer.lowerNumberStaticCall(expr, expr.expression) ??
      lowerer.lowerDateCall(expr, expr.expression) ??
      lowerer.lowerTextCodecCall(expr, expr.expression) ??
      lowerer.lowerStringStaticCall(expr, expr.expression) ??
      lowerer.lowerStringLastIndexOfCall(expr, expr.expression) ??
      lowerer.lowerPromiseMethodCall(expr, expr.expression) ??
      // Homogeneous promise-tuple literals claim BEFORE the static path
      // (whose array bound would fence them); Promise.reject follows it
      // (the static path leaves resolve/reject for the member fence).
      lowerPromiseAllTupleCall(lowerer, expr, expr.expression) ??
      lowerer.lowerPromiseStaticCall(expr, expr.expression) ??
      lowerPromiseRejectCall(lowerer, expr, expr.expression) ??
      lowerRegexMethodCallWithOptionalArg(lowerer, expr, expr.expression) ??
      lowerUrlStaticCall(lowerer, expr, expr.expression) ??
      lowerer.lowerUrlMethodCall(expr, expr.expression) ??
      lowerer.lowerSearchParamsMethodCall(expr, expr.expression) ??
      lowerer.lowerStatsMethodCall(expr, expr.expression) ??
      lowerHashStreamCall(lowerer, expr, expr.expression) ??
      lowerCryptoHashMethodCall(lowerer, expr, expr.expression) ??
      lowerCipherMethodCall(lowerer, expr, expr.expression) ??
      lowerFileHandleMethodCall(lowerer, expr, expr.expression) ??
      lowerDirMethodCall(lowerer, expr, expr.expression) ??
      lowerChildPropertyCall(lowerer, expr, expr.expression) ??
      lowerer.lowerChildMethodCall(expr, expr.expression) ??
      // Piped child-output stream receivers — on/once("data" | "end").
      lowerChildStreamMethodCall(lowerer, expr, expr.expression) ??
      lowerChildWriterMethodCall(lowerer, expr, expr.expression) ??
      // First-class process-stream receivers — write(data).
      lowerProcStreamMethodCall(lowerer, expr, expr.expression) ??
      // FSWatcher receivers — close() (fs.watch's handle).
      lowerWatcherMethodCall(lowerer, expr, expr.expression) ??
      // Atomics.wait — the synchronous-sleep idiom (no threads exist,
      // so the compare-then-sleep lowering IS the spec's behavior).
      lowerer.lowerAtomicsCall(expr, expr.expression) ??
      // StringDecoder receivers — BEFORE the record method paths (the
      // decoder maps to its one-field pending record).
      lowerer.lowerStringDecoderMethodCall(expr, expr.expression) ??
      // Dirent receivers — same story: the type probes read the record's
      // hidden %dtype field.
      lowerDirentMethodCall(lowerer, expr, expr.expression) ??
      // readline Interface receivers — BEFORE the Timeout path (both
      // map to f64 handles; the checker symbol discriminates).
      lowerer.lowerReadlineMethodCall(expr, expr.expression) ??
      // diagnostics_channel Channel receivers — the same f64-handle
      // story (publish/subscribe/unsubscribe).
      lowerer.lowerDiagnosticsChannelMethodCall(expr, expr.expression) ??
      // AsyncLocalStorage receivers — run/getStore/exit/enterWith over
      // the f64 store handle.
      lowerer.lowerAsyncLocalStorageMethodCall(expr, expr.expression) ??
      // TracingChannel receivers — subscribe/unsubscribe/traceSync/
      // traceCallback over the f64 tracing handle.
      lowerer.lowerTracingChannelMethodCall(expr, expr.expression) ??
      lowerer.lowerServerMethodCall(expr, expr.expression) ??
      lowerer.lowerDgramMethodCall(expr, expr.expression) ??
      // node:test — skip/todo/only twins on named import bindings, the
      // TestContext surface (t.test/t.skip/t.diagnostic), t.assert.*.
      lowerer.lowerTestMethodCall(expr, expr.expression) ??
      lowerer.lowerTimeoutMethodCall(expr, expr.expression) ??
      lowerArrayPrototypeBorrowCall(lowerer, expr, expr.expression) ??
      lowerBytesPrototypeSetCall(lowerer, expr, expr.expression) ??
      lowerObjectOwnPrototypeCall(lowerer, expr, expr.expression) ??
      lowerObjectPrototypeCall(lowerer, expr, expr.expression) ??
      lowerStringPrototypeCall(lowerer, expr, expr.expression) ??
      lowerStringMethodCallWithOptionalArgs(lowerer, expr, expr.expression) ??
      // Typed-array/Buffer receivers and the Buffer statics — before the

      lowerer.lowerBytesMethodCall(expr, expr.expression) ??
      lowerBytesStaticCall(lowerer, expr, expr.expression) ??
      lowerBufferStaticCallWithNarrowedArg(lowerer, expr, expr.expression) ??
      // Readable.from — the stream classes' one static (before the
      // stdlib chokepoint claims the member).
      lowerStreamStaticCall(lowerer, expr, expr.expression) ??
      // Primitive toString calls, including numeric radices, use the

      lowerNumberToStringCall(lowerer, expr, expr.expression) ??
      // Union receivers whose every arm has a text — the ngrok
      // `(chunk: Buffer | string) => chunk.toString()` idiom.
      lowerUnionToStringCall(lowerer, expr, expr.expression) ??
      // Object.prototype.toString's default answer on records and
      // override-free program classes — "[object Object]", folded.
      lowerDefaultToStringCall(lowerer, expr, expr.expression) ??
      // The remaining primitive prototype statics — toExponential(),
      // both toFixed() forms, hasOwnProperty over literal keys.
      lowerPrimitiveProtoCall(
        lowerer,
        expr,
        expr.expression.expression,
        expr.expression.name.text,
        lowerer.checker.getSymbolAtLocation(expr.expression.name),
      ) ??
      // hasOwnProperty on a program class CONSTRUCTOR — own statics are
      // compile-time-known, so a literal key folds to a constant.
      lowerClassHasOwnPropertyCall(lowerer, expr, expr.expression) ??
      lowerObjectOwnMethodCall(lowerer, expr, expr.expression) ??
      // Static Response.json(data, init?) builds a native Response.
      lowerResponseStaticJson(lowerer, expr) ??
      // Refuse Response constructor operations before generic-call
      // fallbacks can report an unrelated SC1090 diagnostic.
      lowerer.fenceUnsupportedFetchConstructorMember(expr.expression) ??
      // Static fetch responses are checked-dynamic handles, but the
      // adopted undici declaration exposes a wider API than that handle.
      // Refuse unsupported members before generic checked-value dispatch.
      lowerer.fenceStaticResponseMember(expr.expression, "call") ??
      lowerer.fenceStaticHeadersMember(expr.expression, "call") ??
      lowerer.fenceStaticReadableStreamMember(expr.expression, "call") ??
      lowerDisposableStackUseCall(lowerer, expr, expr.expression) ??
      lowerer.lowerStdlibMethodCall(expr, expr.expression) ??
      // crypto.getRandomValues / randomUUID on the WebCrypto global
      // (untyped in fallback builds, so before the dyn receiver path) or
      // webcrypto.
      lowerWebCryptoMethodCall(lowerer, expr, expr.expression) ??
      // Dyn receivers (JSON.parse-derived `unknown`/`any` values) —

      lowerDynReceiverMethodCall(lowerer, expr, expr.expression) ??
      // Narrowing filters (inferred predicates, filter(Boolean)) claim
      // their calls before the generic array HOF path types the result
      // by the receiver's own element.
      lowerer.lowerFilterNarrowCall(expr, expr.expression) ??
      lowerArrayIsArrayCall(lowerer, expr, expr.expression) ??
      lowerErrorIsErrorCall(lowerer, expr, expr.expression) ??
      lowerErrorCaptureStackTraceCall(lowerer, expr, expr.expression) ??
      lowerBigIntMethodCall(lowerer, expr, expr.expression) ??
      lowerSymbolStaticCall(lowerer, expr, expr.expression) ??
      lowerSymbolMethodCall(lowerer, expr, expr.expression) ??
      lowerRegExpStaticCall(lowerer, expr, expr.expression) ??
      // The composed en-US Intl.NumberFormat form — before the member
      // fences (the receiver's Intl.NumberFormat type has no mapping).
      lowerIntlNumberFormatCall(lowerer, expr, expr.expression) ??
      lowerGroupByStaticCall(lowerer, expr, expr.expression) ??
      // Iterator-helper chains rooted at arr.values() — before the
      // array method paths (the terminal names collide with array
      // methods, but only iterator-typed receivers reach this).
      lowerIteratorHelperCall(lowerer, expr, expr.expression) ??
      // Helper calls on generators and other iterator objects.
      lowerGeneratorHelperCall(lowerer, expr, expr.expression) ??
      lowerIteratorStaticFence(lowerer, expr, expr.expression) ??
      lowerObjectStaticCall(lowerer, expr, expr.expression) ??
      lowerObjectFromEntriesCall(lowerer, expr, expr.expression) ??
      lowerArrayClassStaticCall(lowerer, expr, expr.expression) ??
      lowerArrayFromCall(lowerer, expr, expr.expression) ??
      lowerArrayFromAsyncCall(lowerer, expr, expr.expression) ??
      lowerArrayOfCall(lowerer, expr, expr.expression) ??
      lowerer.lowerArrayMethodCall(expr, expr.expression) ??
      // Tuple reads preserve the receiver through argument evaluation;
      // callbacks read each position when visited.
      lowerTupleReadMethodCall(lowerer, expr, expr.expression) ??
      lowerGenMethodCall(lowerer, expr, expr.expression) ??
      lowerer.lowerMapMethodCall(expr, expr.expression) ??
      lowerer.lowerSetMethodCall(expr, expr.expression) ??
      // Static method calls — on the class name directly (`C.make()`)
      // or through a class VALUE (devirtualized; shadowing fences).
      lowerStaticMethodCall(lowerer, expr, expr.expression) ??
      lowerer.lowerObjectMethodCall(expr, expr.expression) ??
      lowerer.lowerRecordFieldCall(expr, expr.expression) ??
      // Object-literal GENERIC methods (excluded from record shapes) —
      // monomorphized against the defining literal's declaration.
      lowerObjLitGenericMethodCall(lowerer, expr, expr.expression);
    if (intrinsic) return intrinsic;
    {
      const boxed = lowerDynReceiverMethodCall(lowerer, expr, expr.expression, true);
      if (boxed) return boxed;
    }
    if (isJsSourceFile(ts.getSourceFileOfNode(expr))) {
      const staticField = lowerStaticFieldRead(lowerer, expr.expression);
      if (staticField?.type.kind === "dyn" && !expr.arguments.nodes.some(ts.isSpreadElement)) {
        return {
          kind: "dynCall",
          callee: staticField,
          receiver: lowerer.lowerExprExpecting(expr.expression.expression, DYN),
          calleeName: v8CalleeText(expr.expression),
          args: expr.arguments.nodes.map((arg) => lowerer.lowerExprExpecting(arg, DYN)),
          type: DYN,
          loc: locOf(expr),
        };
      }
    }
    const accessorTarget = lowerer.fieldTarget(expr.expression);
    if (accessorTarget?.container === "accessor") {
      let callee = lowerer.fieldGetExpr(accessorTarget, locOf(expr.expression), expr.expression);
      // A getter returning a callable class instance (chalk's
      // `chalk.red("x")`): call through its `%call` field.
      if (callee.type.kind === "object") {
        const direct = callableInstanceStringCall(lowerer, expr, callee, locOf(expr));
        if (direct) return direct;
        callee = lowerer.hybridCallUnwrap(callee);
        if (callee.type.kind === "func")
          return lowerCallThroughValue(lowerer, expr, callee, locOf(expr));
      }
      if (callee.type.kind === "func") {
        const args = completeFuncValueArgs(lowerer, expr, callee.type, locOf(expr));
        return { kind: "callValue", callee, args, type: callee.type.ret, loc: locOf(expr) };
      }
      if (
        callee.type.kind === "dyn" &&
        !expr.arguments.nodes.some((arg) => ts.isSpreadElement(arg))
      ) {
        const args = expr.arguments.nodes.map((arg) => lowerer.lowerExprExpecting(arg, DYN));
        return {
          kind: "dynCall",
          callee,
          calleeName: v8CalleeText(expr.expression),
          args,
          type: DYN,
          loc: locOf(expr),
        };
      }
    }
    // A method call rooted at an initializer-less ambient `declare
    // const/var` whose declared type has no mapping: Node throws the
    // catchable ReferenceError at the ROOT read before the member, the
    // arguments, or the call — the whole call lowers to that throw,
    // typed by the use site (or its context; never observed).
    {
      const ambientRoot = ambientUndefVarRootOf(lowerer, expr.expression);
      if (ambientRoot !== null) {
        const t = ambientUndefReadType(lowerer, expr) ?? contextualUndefReadType(lowerer, expr);
        if (t) return nsUndefRead(lowerer, ambientRoot.text, expr, t);
      }
    }
    {
      const childCall = lowerChildPropertyCall(lowerer, expr, expr.expression, true);
      if (childCall) return childCall;
    }
    // The lib fence's METHOD-CALL chokepoint: a stdlib-declared member
    // that every lowering above declined — an unlowered member
    // (m.keys(), p.then(f), Object.keys(o)) or an unlowered call FORM of
    // a lowered one (Math.min with three arguments, s.padStart(8),
    // x.toFixed()).
    lowerer.stdlibMemberFence(expr.expression);
    // The npm METHOD-CALL chokepoint: a call on a package-typed receiver
    // in a static build — attributed to the package.
    lowerer.npmMemberFence(expr.expression);
    // The chalk shape: a FUNCTION carrying properties
    // (`Object.assign(identity, { bold })`, typed `F & { bold: F }`) —
    // a callable-record hybrid this representation doesn't model yet.
    // Name the shape and the working split instead of the generic
    // method fence.
    {
      const recvT = lowerer.typeOf(expr.expression.expression);
      if (recvT.isIntersectionType() && lowerer.checker.getCallSignatures(recvT).length > 0) {
        lowerer.unsupported(
          "SC1090",
          expr,
          `calls through function-with-properties values ('${ts.getTextOfNode(expr.expression.expression)}' is callable AND carries members — the chalk shape; no hybrid representation exists yet: export the base and the property as separate functions)`,
        );
      }
    }
    // A GENERIC method no lowering above claimed — an ambient `declare
    // class`, an interface-typed receiver, a class whose collection
    // fenced: monomorphization needs a declaration WITH A BODY resolved
    // statically, and this receiver offers none. Name the shape instead
    // of the generic method fence.
    {
      const propSym = lowerer.checker.getPropertyOfType(
        lowerer.typeOf(expr.expression.expression),
        expr.expression.name.text,
      );
      if (
        propSym &&
        isGenericCallableMemberType(lowerer.checker.getTypeOfSymbol(propSym), lowerer.checker)
      ) {
        lowerer.unsupported(
          "SC1090",
          expr,
          `calls of the generic method '${expr.expression.name.text}' through this receiver (no compiled declaration with a body resolves statically here — ambient 'declare class' and interface-only methods are signature-only, and only class, static, and object-literal generic methods with bodies monomorphize)`,
        );
      }
    }
    lowerer.unsupported("SC1090", expr, `method calls like '${ts.getTextOfNode(expr.expression)}'`);
  }

  // `s[Symbol.iterator]()` on a string: the string iterator as a value.
  if (
    ts.isElementAccessExpression(expr.expression) &&
    !expr.expression.questionDotToken &&
    !expr.questionDotToken &&
    expr.arguments.nodes.length === 0
  ) {
    const iterator = lowerStringIteratorCall(lowerer, expr, expr.expression);
    if (iterator) return iterator;
  }

  // The element spelling of an unsupported native Web method must fence
  // before lowering the callee into a checked-dynamic keyed read.
  if (ts.isElementAccessExpression(expr.expression)) {
    const timersDispose = lowerMockTimersElementCall(lowerer, expr, expr.expression);
    if (timersDispose) return timersDispose;
    const symbolMethod = lowerClassSymbolMethodCall(lowerer, expr);
    if (symbolMethod) return symbolMethod;
    const readlineDispose = lowerReadlineDisposeCall(lowerer, expr);
    if (readlineDispose) return readlineDispose;
    lowerer.fenceUnsupportedFetchConstructorMember(expr.expression);
    lowerer.fenceStaticResponseMember(expr.expression, "call");
    lowerer.fenceStaticHeadersMember(expr.expression, "call");
    lowerer.fenceStaticReadableStreamMember(expr.expression, "call");
  }

  // Computed native members retain their original receiver and resolve
  // the function before argument effects, just like dotted calls.
  if (
    ts.isElementAccessExpression(expr.expression) &&
    !expr.expression.questionDotToken &&
    !expr.questionDotToken &&
    !symbolFieldInfo(lowerer, expr.expression)
  ) {
    const access = expr.expression;
    const value = tryLowerExpression(lowerer, access.expression);
    if (value?.type.kind === "array" && !isJsSourceFile(ts.getSourceFileOfNode(expr))) {
      const callback = lowerArrayCallbackCall(lowerer, expr, access, value);
      if (callback) return callback;
    }

    if (
      value?.type.kind === "dyn" ||
      value?.type.kind === "generator" ||
      (value &&
        ["array", "bytes", "map", "set"].includes(value.type.kind) &&
        lowerer.dynConvertible(value.type)) ||
      (value?.type.kind === "string" &&
        !ts.isStringLiteralLike(access.argumentExpression) &&
        lowerer.dynConvertible(value.type)) ||
      (value?.type.kind === "object" && !lowerer.classes.get(value.type.className)?.def.runtime)
    ) {
      const local = lowerer.declareHiddenLocal("%computedReceiver", value.type);
      const reference: IrExpr = { kind: "varRef", localId: local.id, type: value.type, loc };
      const receiver = lowerer.coerceToExpected(reference, DYN);
      const raw = lowerer.lowerExpr(access.argumentExpression);
      const key =
        raw.type.kind === "string" ? raw : lowerer.coerceInto(access.argumentExpression, raw, DYN);
      const callee: IrExpr = { kind: "dynKeyGet", value: receiver, key, type: DYN, loc };
      const spread = expr.arguments.nodes.some(ts.isSpreadElement)
        ? lowerSpreadArgsCall(lowerer, expr, callee, loc)
        : null;
      if (spread && spread.kind !== "dynCall")
        lowerer.unsupported("SC1090", expr, "computed native method spread arguments");
      const result: IrExpr =
        spread !== null
          ? { ...spread, receiver }
          : {
              kind: "dynCall",
              callee,
              receiver,
              calleeName: ts.getTextOfNode(access),
              args: expr.arguments.nodes.map((arg) => lowerer.lowerExprExpecting(arg, DYN)),
              type: DYN,
              loc,
            };
      return {
        kind: "seqExpr",
        stmts: [{ kind: "varDecl", localId: local.id, init: value, loc }],
        result,
        type: DYN,
        loc,
      };
    }
  }

  // The ELEMENT spelling of a primitive method call — `x['toString']()`,
  // `s['charAt'](0)`: JS resolves it exactly like the dot form, so the
  // literal-keyed shapes with a static lowering route there before the
  // callee-as-value path could fence on the member read.
  if (
    ts.isElementAccessExpression(expr.expression) &&
    !expr.expression.questionDotToken &&
    !expr.questionDotToken &&
    (ts.isStringLiteralLike(expr.expression.argumentExpression) ||
      ts.isNumericLiteral(expr.expression.argumentExpression))
  ) {
    const memberName = ts.isNumericLiteral(expr.expression.argumentExpression)
      ? String(Number(expr.expression.argumentExpression.text))
      : expr.expression.argumentExpression.text;
    const receiverType = lowerer.mapTypeOf(lowerer.typeOf(expr.expression.expression));
    if (receiverType?.kind === "object") {
      const info = lowerer.classes.get(receiverType.className);
      const found = info ? lowerer.findMethodOn(info, memberName) : null;
      if (info && found) {
        if (found.declarer.builtinError)
          return errorToStringCall(lowerer, lowerer.lowerExpr(expr.expression.expression));
        const virtual = lowerer.overrideBelow(info, memberName);
        if (found.sig.abstract === true && !virtual) {
          lowerer.unsupported(
            "SC1090",
            expr,
            `calls of the abstract method '${memberName}' with no concrete implementation below the receiver's static class`,
          );
        }
        if (virtual) lowerer.noteVirtualEdge(info, memberName);
        else lowerer.noteEdge(`%${found.declarer.def.name}.${memberName}`);
        const receiver = lowerer.lowerExpr(expr.expression.expression);
        const args = lowerer.completeArgs(
          expr.arguments.nodes,
          found.sig.params,
          locOf(expr),
          expr,
        );
        const callArgs = [
          lowerer.upcastTo(receiver, virtual ? info.def.name : found.declarer.def.name),
          ...args,
        ];
        const loc = locOf(expr);
        if (virtual) {
          return reconcileOverloadReturn(lowerer, expr, {
            kind: "virtualCall",
            className: info.def.name,
            method: memberName,
            args: callArgs,
            type: found.sig.ret,
            loc,
          });
        }
        return reconcileOverloadReturn(lowerer, expr, {
          kind: "call",
          callee: `%${found.declarer.def.name}.${memberName}`,
          args: callArgs,
          type: found.sig.ret,
          loc,
        });
      }
    }
    // ts7's getSymbolAtLocation does not resolve element accesses; the
    // member symbol comes from the receiver's (apparent) type instead —
    // same provenance answer as the dot spelling's name symbol.
    const recvType = lowerer.typeOf(expr.expression.expression);
    const memberSym = lowerer.checker.getPropertyOfType(recvType, memberName);
    const prim = lowerPrimitiveProtoCall(
      lowerer,
      expr,
      expr.expression.expression,
      memberName,
      memberSym,
    );
    if (prim) return prim;
  }
  // Everything else: evaluate the callee as a value and call through it
  // (func-typed locals/params/captures, self-recursion, IIFEs, results of
  // calls). tsc guarantees the callee is callable; anything that lowers to
  // a non-func IR type was already rejected while lowering the callee.
  // HYBRID (function-with-properties) values call through their %call slot.
  let callee = lowerer.lowerExpr(expr.expression);
  {
    const direct = callableInstanceStringCall(lowerer, expr, callee, loc);
    if (direct) return direct;
  }
  if (callee.type.kind === "record" || callee.type.kind === "object")
    callee = lowerer.hybridCallUnwrap(callee);
  return lowerCallThroughValue(lowerer, expr, callee, loc);
}

/** A callable class instance called with one string: its `%call1` method
 * when the class has one (the chalk shim's typed fast path), skipping the
 * variadic closure's checked-dynamic arguments. */
function callableInstanceStringCall(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  callee: IrExpr,
  loc: SrcLoc,
): IrExpr | null {
  if (callee.type.kind !== "object" || expr.arguments.nodes.length !== 1) return null;
  const arg = expr.arguments.nodes[0]!;
  if (ts.isSpreadElement(arg)) return null;
  const info = lowerer.classes.get(callee.type.className);
  if (info === undefined || !info.fields.has("%call") || !lowerer.findMethodOn(info, "%call1"))
    return null;
  const value = lowerer.lowerExpr(arg);
  if (value.type.kind === "string")
    return lowerer.accessorCall(callee.type.className, "%call1", callee, [value], STRING, loc);
  // Any other argument (a number behind a cast): the variadic closure,
  // through the checked-dynamic call as lowerCallThroughValue would.
  const closure = lowerer.hybridCallUnwrap(callee);
  if (closure.type.kind !== "func") return null;
  return {
    kind: "dynCall",
    callee: { kind: "dynFrom", value: closure, type: DYN, loc },
    calleeName: ts.isIdentifier(expr.expression) ? expr.expression.text : "value",
    args: [lowerer.coerceToExpected(value, DYN)],
    type: DYN,
    loc,
  };
}

/** A call through an evaluated callee value: checked-dynamic callees,
 * function unions, typed-rest and runtime-arity closures. */
function lowerCallThroughValue(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  callee: IrExpr,
  loc: SrcLoc,
): IrExpr {
  // A CHECKED-DYNAMIC callee — `fn(a, b)` where fn is an implicit-any
  // JS binding (the mustCall body's `fn(...args)`), a dyn capture, or a
  // keyed read off a dyn value: the dynCall boundary. Arguments convert
  // INTO dyn (typed values through dynFrom — closures box); the boxed
  // thunk validates them against the callee's declared signature and a
  // non-function callee throws Node's catchable "<name> is not a
  // function" TypeError. The result is dyn (checked per use like every
  // any-origin value). Spread arguments keep their fence.
  if (callee.type.kind === "dyn") {
    if (expr.arguments.nodes.some((a) => ts.isSpreadElement(a))) {
      // The runtime-arity lane: a dyn callee is already boxed — the
      // spread-marked dynCall applies through a fresh dyn argument
      // array (lowerSpreadArgsCall). Sources outside it keep the fence.
      const spreadServed = lowerSpreadArgsCall(lowerer, expr, callee, loc);
      if (spreadServed) return spreadServed;
      lowerer.unsupported("SC1090", expr, "spread arguments in calls through 'unknown' values");
    }
    const args = expr.arguments.nodes.map((a) => lowerer.lowerExprExpecting(a, DYN));
    const calleeName =
      ts.isPropertyAccessExpression(expr.expression) ||
      ts.isElementAccessExpression(expr.expression)
        ? ts.getTextOfNode(expr.expression)
        : ts.isIdentifier(expr.expression)
          ? expr.expression.text
          : "value";
    return { kind: "dynCall", callee, calleeName, args, type: DYN, loc };
  }
  if (
    callee.type.kind === "union" &&
    lowerer.dynConvertible(callee.type) &&
    lowerer.unions.get(callee.type.unionId)?.arms.some((arm) => arm.kind === "func")
  ) {
    return {
      kind: "dynCall",
      callee: lowerer.coerceToExpected(callee, DYN),
      calleeName: v8CalleeText(expr.expression),
      args: expr.arguments.nodes.map((arg) => lowerer.lowerExprExpecting(arg, DYN)),
      type: DYN,
      loc,
    };
  }
  if (callee.type.kind !== "func") {
    lowerer.badType(expr.expression, lowerer.typeOf(expr.expression));
  }
  // Typed-rest closures already have a fixed native ABI: complete the
  // source-level variadic call into their trailing typed-array slot.
  // Claim before the runtime-arity spread lane; completeArgs handles
  // typed spreads without boxing the function.
  if (callee.type.rest === true && callee.type.restAbi === "typed") {
    const args = completeFuncValueArgs(lowerer, expr, callee.type, loc);
    return { kind: "callValue", callee, args, type: callee.type.ret, loc };
  }
  // A SPREAD argument on a func-typed callee — the rest-forwarding
  // idiom (`(...args) => from(...args)`): the runtime-arity lane boxes
  // or marshals the callee and applies through a runtime-built argument
  // list (lowerSpreadArgsCall). Shapes outside its lanes fall through
  // to the historical fences.
  // Forwarded fixed tuples (`fn(...args)` over a tuple rest parameter or a
  // typed `arguments`) have a compile-time arity: complete them into the
  // callee's positional slots directly, without the runtime-arity lane.
  if (
    callee.type.rest !== true &&
    expr.arguments.nodes.some(ts.isSpreadElement) &&
    expr.arguments.nodes.every(
      (a) => !ts.isSpreadElement(a) || isForwardedTupleSpread(lowerer, a.expression),
    )
  ) {
    const args = completeFuncValueArgs(lowerer, expr, callee.type, loc);
    return { kind: "callValue", callee, args, type: callee.type.ret, loc };
  }
  if (expr.arguments.nodes.some((a) => ts.isSpreadElement(a))) {
    const spreadServed = lowerSpreadArgsCall(lowerer, expr, callee, loc);
    if (spreadServed) return spreadServed;
  }

  // A JS call with MORE arguments than the callee's lowered signature
  // (`cb(1, 'x')` where the mustCall wrapper's inferred type declared
  // fewer params — tsc's JS world doesn't police arity): ride the
  // checked-dynamic boundary — box the callee, dynCall — which delivers
  // JS arity exactly (the thunk ignores extras). Result dyn, checked
  // per use like every any-origin value.
  if (
    (expr.arguments.nodes.length > callee.type.params.length || callee.type.rest === true) &&
    (isJsSourceFile(ts.getSourceFileOfNode(expr)) ||
      (callee.type.rest === true && callee.type.restAbi === undefined)) &&
    !expr.arguments.nodes.some((a) => ts.isSpreadElement(a)) &&
    canBoxFuncIntoDyn(
      callee.type,
      (id) => lowerer.shapes.get(id),
      (id) => lowerer.unions.get(id),
    )
  ) {
    const args = expr.arguments.nodes.map((a) => lowerer.lowerExprExpecting(a, DYN));
    const calleeName = ts.isIdentifier(expr.expression) ? expr.expression.text : "value";
    const boxed: IrExpr = { kind: "dynFrom", value: callee, type: DYN, loc };
    return { kind: "dynCall", callee: boxed, calleeName, args, type: DYN, loc };
  }
  const args = completeFuncValueArgs(lowerer, expr, callee.type, loc);
  return { kind: "callValue", callee, args, type: callee.type.ret, loc };
}

/** Exported checked and variadic callables use the same runtime-arity ABI
 * whether the caller spells a bare import or a namespace member. */
function lowerCheckedCallableValue(
  lowerer: Lowerer,
  call: ts.CallExpression,
  value: IrExpr,
  loc: SrcLoc,
): IrExpr | null {
  let callee = value;
  if (callee.type.kind !== "dyn") {
    if (
      callee.type.kind !== "func" ||
      !(
        (callee.type.rest === true && callee.type.restAbi === undefined) ||
        (isJsSourceFile(ts.getSourceFileOfNode(call)) &&
          call.arguments.nodes.length > callee.type.params.length)
      ) ||
      !lowerer.dynConvertible(callee.type)
    )
      return null;
    callee = { kind: "dynFrom", value: callee, type: DYN, loc };
  }
  if (call.arguments.nodes.some(ts.isSpreadElement)) {
    const spread = lowerSpreadArgsCall(lowerer, call, callee, loc);
    if (spread) return spread;
    lowerer.unsupported("SC1090", call, "spread arguments in calls through 'unknown' values");
  }
  return {
    kind: "dynCall",
    callee,
    calleeName: v8CalleeText(call.expression),
    args: call.arguments.nodes.map((arg) => lowerer.lowerExprExpecting(arg, DYN)),
    type: DYN,
    loc,
  };
}

function lowerRegexMethodCallWithOptionalArg(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  const lowered = lowerer.lowerRegexMethodCall(call, access);
  if (
    lowered?.kind !== "regexIntrinsic" ||
    lowered.method !== "test" ||
    call.arguments.nodes.length !== 1
  )
    return lowered;
  const subject = lowered.args[0];
  if (subject?.type.kind !== "union" || lowerer.armTag(subject.type.unionId, UNDEFINED_T) < 0)
    return lowered;
  if (lowerer.mapTypeOf(lowerer.typeOf(call.arguments.nodes[0]!))?.kind !== "string")
    return lowered;
  const present = lowerer.stripUndefinedArm(subject.type);
  if (present.kind !== "string") return lowered;
  return {
    ...lowered,
    args: [lowerer.ensureString(subject, call.arguments.nodes[0]!)],
  };
}

function optionalCallValue(lowerer: Lowerer, node: ts.Expression): IrExpr | null {
  return lowerer.runtimeOptionalIdentifierValue(node)?.value ?? lowerAbsenceProbe(lowerer, node);
}

function lowerBufferStaticCallWithNarrowedArg(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  const result = lowerer.lowerBufferStaticCall(call, access);
  // The Buffer brand wraps the constructor result. Normalize its source
  // before restoring that wrapper so narrowed unions never reach bytesNew.
  const branded = result?.kind === "libCall" && result.fn === "buffer.brand" ? result : null;
  const lowered = branded ? branded.args[0]! : result;
  if (lowered?.kind !== "bytesNew" || !lowered.source || lowered.source.type.kind !== "union")
    return result;
  // A callback can store a wider union than the checker sees at this use
  // (including an added undefined arm). Extract the exact arm proven by
  // control-flow narrowing, not merely the union with undefined removed.
  const narrowed = lowerer.mapTypeOf(lowerer.typeOf(call.arguments.nodes[0]!));
  if (
    !narrowed ||
    !(
      narrowed.kind === "f64" ||
      (narrowed.kind === "array" && narrowed.elem.kind === "f64") ||
      (narrowed.kind === "bytes" && narrowed.elem === "u8")
    ) ||
    lowerer.armTag(lowered.source.type.unionId, narrowed) < 0
  ) {
    lowerer.unsupported(
      "SC1090",
      call.arguments.nodes[0]!,
      "a Buffer constructor argument whose narrowed type is not a stored source arm",
    );
  }
  const helper = lowerer.narrowedArmHelper(
    lowered.source.type.unionId,
    narrowed,
    lowered.source.loc,
  );
  if (!helper) {
    lowerer.unsupported(
      "SC1090",
      call.arguments.nodes[0]!,
      "a Buffer constructor argument whose narrowed type is not a stored source arm",
    );
  }
  const narrowedValue: IrExpr = {
    ...lowered,
    source: lowerer.checkedNarrowCall(helper, lowered.source, narrowed, lowered.source.loc),
  };
  return branded ? { ...branded, args: [narrowedValue] } : narrowedValue;
}

function lowerOptionalNumberDefault(
  lowerer: Lowerer,
  value: IrExpr,
  dflt: number,
  loc: SrcLoc,
): IrExpr | null {
  const widened = lowerer.runtimeOptionalWidening(value.type, F64);
  if (!widened || widened.kind !== "union") return null;
  const numberTag = lowerer.armTag(widened.unionId, F64);
  const undefinedTag = lowerer.armTag(widened.unionId, UNDEFINED_T);
  if (numberTag < 0 || undefinedTag < 0) return null;
  const key = `number.optionalDefault:${widened.unionId}:${dflt}`;
  let helper = lowerer.valueHelpers.get(key);
  if (!helper) {
    helper = keyedHelperName(lowerer, "%number.optionalDefault", key);
    lowerer.valueHelpers.set(key, helper);
    const input = varRef("value.0", widened, loc);
    lowerer.liftedFns.push({
      name: helper,
      params: [{ localId: "value.0", name: "value", type: widened }],
      returnType: F64,
      locals: [{ id: "value.0", name: "value", type: widened, mutable: false }],
      body: [
        {
          kind: "if",
          cond: {
            kind: "unionIsTag",
            unionId: widened.unionId,
            tag: undefinedTag,
            negated: false,
            value: input,
            type: BOOL,
            loc,
          },
          then: [{ kind: "return", value: { kind: "numLit", value: dflt, type: F64, loc }, loc }],
          else_: null,
          loc,
        },
        {
          kind: "return",
          value: {
            kind: "unionNarrow",
            unionId: widened.unionId,
            tag: numberTag,
            value: input,
            type: F64,
            loc,
          },
          loc,
        },
      ],
      loc,
    });
  }
  return { kind: "call", callee: helper, args: [value], type: F64, loc };
}

function lowerStringMethodCallWithOptionalArgs(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
  receiver?: () => IrExpr,
  argumentNodes: readonly ts.Expression[] = call.arguments.nodes,
): IrExpr | null {
  const lowered = lowerStringMethodCall(lowerer, call, access, receiver, argumentNodes);
  if (lowered?.kind !== "strIntrinsic") return lowered;
  const args = [...lowered.args];
  let changed = false;
  const zeroDefaultArgs =
    lowered.method === "charCodeAt" || lowered.method === "charAt" || lowered.method === "repeat"
      ? [0]
      : lowered.method === "slice" || lowered.method === "substring"
        ? [0]
        : lowered.method === "indexOf" || lowered.method === "includes"
          ? [1]
          : [];
  for (const index of zeroDefaultArgs) {
    if (index === undefined) continue;
    const value = args[index];
    if (!value) continue;
    const coerced = lowerOptionalNumberDefault(lowerer, value, 0, value.loc);
    if (coerced) {
      args[index] = coerced;
      changed = true;
    }
  }
  if (
    (lowered.method === "indexOf" ||
      lowered.method === "includes" ||
      lowered.method === "startsWith" ||
      lowered.method === "endsWith") &&
    args[0]?.type.kind === "union" &&
    lowerer.runtimeOptionalWidening(args[0].type, STRING) !== null
  ) {
    args[0] = lowerer.ensureString(args[0], argumentNodes[0]!);
    changed = true;
  }
  return changed ? { ...lowered, args } : lowered;
}

/** `.then(String)` / `.then(Number)` / `.then(Boolean)` over a promise of
 * a number, string or boolean: the ambient constructor converts its first
 * argument (the settled value), so the handler is an interned closure over
 * the settled type applying that conversion. The constructors' own value
 * form takes a string, which a number or boolean settled value is not.
 * Null for every other handler. */
function primitiveConversionHandler(
  lowerer: Lowerer,
  node: ts.Expression,
  inner: IrType,
): IrExpr | null {
  if (!ts.isIdentifier(node)) return null;
  const name = node.text;
  if (name !== "String" && name !== "Number" && name !== "Boolean") return null;
  // A string settled value already fits the constructors' value form.
  if (inner.kind !== "f64" && inner.kind !== "bool") return null;
  if (!lowerer.isStdlibSymbol(lowerer.resolveValueSymbol(node) ?? undefined)) return null;
  const loc = locOf(node);
  const ret: IrType = name === "String" ? STRING : name === "Number" ? F64 : BOOL;
  const fnT = funcOf([inner], ret);
  const key = `then.${name}:${typeKey(inner)}`;
  let fnName = lowerer.arrHofHelpers.get(key);
  if (fnName === undefined) {
    fnName = keyedHelperName(lowerer, `%then.${name}`, key);
    lowerer.arrHofHelpers.set(key, fnName);
    const value = varRef("v.0", inner, loc);
    let body: IrExpr;
    if (name === "Boolean") body = { kind: "toBool", operand: value, type: BOOL, loc };
    else if (name === "String") body = { kind: "toString", operand: value, type: STRING, loc };
    else if (inner.kind === "f64") body = value;
    else
      body = {
        kind: "ternary",
        cond: value,
        then: { kind: "numLit", value: 1, type: F64, loc },
        else_: { kind: "numLit", value: 0, type: F64, loc },
        type: F64,
        loc,
      };
    lowerer.liftedFns.push({
      name: fnName,
      params: [{ localId: "v.0", name: "v", type: inner }],
      returnType: ret,
      locals: [{ id: "v.0", name: "v", type: inner, mutable: false }],
      body: [{ kind: "return", value: body, loc }],
      loc,
    });
  }
  return { kind: "closure", fnName, captures: [], type: fnT, loc };
}

function lowerNumberConstructorValue(
  lowerer: Lowerer,
  argNode: ts.Expression,
  loc: SrcLoc,
): IrExpr {
  const undefinedArg = lowerStaticallyUndefinedArgument(lowerer, argNode);
  if (undefinedArg) {
    return defaultAfterUndefined(undefinedArg, {
      kind: "bin",
      op: "/",
      left: { kind: "numLit", value: 0, type: F64, loc },
      right: { kind: "numLit", value: 0, type: F64, loc },
      type: F64,
      loc,
    });
  }
  const arg = lowerer.lowerExpr(argNode);
  if (arg.type.kind === "nullT")
    return defaultAfterUndefined(arg, { kind: "numLit", value: 0, type: F64, loc });
  if (arg.type.kind === "bigint")
    return { kind: "libCall", fn: "bigint.toF64", args: [arg], type: F64, loc };
  if (arg.type.kind === "f64") return arg;
  if (arg.type.kind === "bool") {
    return {
      kind: "ternary",
      cond: arg,
      then: { kind: "numLit", value: 1, type: F64, loc },
      else_: { kind: "numLit", value: 0, type: F64, loc },
      type: F64,
      loc,
    };
  }
  if (arg.type.kind === "string")
    return { kind: "libCall", fn: "num.fromString", args: [arg], type: F64, loc };
  if (arg.type.kind === "dyn")
    return { kind: "libCall", fn: "dyn.numberConstructor", args: [arg], type: F64, loc };
  // Number(strings[i]) without boxing `string | undefined`: a missing slot
  // converts like undefined, to NaN.
  const indexedString =
    arg.type.kind === "union" &&
    arg.kind === "call" &&
    arg.args[0]?.type.kind === "array" &&
    arg.args[0].type.elem.kind === "string"
      ? tryFuseIndexRead(
          lowerer,
          arg,
          F64,
          (read) => ({ kind: "libCall", fn: "num.fromString", args: [read], type: F64, loc }),
          {
            kind: "bin",
            op: "/",
            left: { kind: "numLit", value: 0, type: F64, loc },
            right: { kind: "numLit", value: 0, type: F64, loc },
            type: F64,
            loc,
          },
        )
      : null;
  if (indexedString) return indexedString;
  if (arg.type.kind === "union" && lowerer.dynConvertible(arg.type))
    return {
      kind: "libCall",
      fn: "dyn.numberConstructor",
      args: [lowerer.coerceToExpected(arg, DYN)],
      type: F64,
      loc,
    };
  const optionalNumber = lowerOptionalStringNumber(lowerer, arg, loc);
  if (optionalNumber) return optionalNumber;
  // A program class instance converts through its own methods.
  const classNumber = classToNumberConversion(lowerer, arg, argNode);
  if (classNumber) return classNumber;
  const scalarUnionNumber = lowerScalarUnionNumber(lowerer, arg, argNode, loc);
  if (scalarUnionNumber) return scalarUnionNumber;
  return lowerer.noLowering(
    `Number of ${lowerer.fmt(arg.type)} values`,
    argNode,
    arg.type.kind === "union"
      ? "unions of numbers, booleans, strings, null, and undefined lower — narrow other arms first"
      : undefined,
  );
}

/** A runtime-optional local retains its full tagged storage even after a
 * checker guard. Dispatch BigInt by the actual value, including nullish
 * TypeErrors, rather than interpreting that storage as the narrowed arm. */
function lowerBigIntConstructorValue(lowerer: Lowerer, arg: IrExpr, loc: SrcLoc): IrExpr | null {
  if (arg.type.kind === "dyn")
    return { kind: "libCall", fn: "dyn.bigintConstructor", args: [arg], type: BIGINT_T, loc };
  if (arg.type.kind === "bigint") return arg;
  if (arg.type.kind === "string")
    return { kind: "libCall", fn: "bigint.parse", args: [arg], type: BIGINT_T, loc };
  if (arg.type.kind === "f64")
    return { kind: "libCall", fn: "bigint.fromF64", args: [arg], type: BIGINT_T, loc };
  // Byte storage converts through ToPrimitive, which BigInt then parses: a
  // typed array's text is its elements joined with "," (one element reads
  // as that element, none as 0n, several throw the SyntaxError for the
  // joined text), a Buffer's is its UTF-8 decoding and a DataView's is
  // "[object DataView]". The runtime value tells them apart, as for String.
  if (arg.type.kind === "bytes") {
    const text: IrExpr = {
      kind: "toString",
      operand: { kind: "dynFrom", value: arg, type: DYN, loc },
      type: STRING,
      loc,
    };
    return { kind: "libCall", fn: "bigint.parse", args: [text], type: BIGINT_T, loc };
  }
  if (arg.type.kind === "bool") {
    return {
      kind: "ternary",
      cond: arg,
      then: {
        kind: "libCall",
        fn: "bigint.parse",
        args: [{ kind: "strLit", value: "1", type: STRING, loc }],
        type: BIGINT_T,
        loc,
      },
      else_: {
        kind: "libCall",
        fn: "bigint.parse",
        args: [{ kind: "strLit", value: "0", type: STRING, loc }],
        type: BIGINT_T,
        loc,
      },
      type: BIGINT_T,
      loc,
    };
  }
  if (isUnitType(arg.type)) {
    const name = arg.type.kind === "nullT" ? "null" : "undefined";
    return defaultAfterUndefined(
      arg,
      nodeThrowExpr(1, "", `Cannot convert ${name} to a BigInt`, BIGINT_T, loc),
    );
  }
  if (arg.type.kind !== "union") return null;
  const unionId = arg.type.unionId;
  const arms = lowerer.unions.get(unionId)?.arms;
  if (
    !arms ||
    !arms.every(
      (arm) =>
        arm.kind === "bigint" ||
        arm.kind === "string" ||
        arm.kind === "f64" ||
        arm.kind === "bool" ||
        arm.kind === "bytes" ||
        isUnitType(arm),
    )
  )
    return null;
  const key = `bigint.scalar:${unionId}`;
  let helper = lowerer.valueHelpers.get(key);
  if (!helper) {
    helper = keyedHelperName(lowerer, "%bigint.scalar", key);
    lowerer.valueHelpers.set(key, helper);
    const value = varRef("value.0", arg.type, loc);
    const body: IrStmt[] = [];
    arms.forEach((arm, tag) => {
      const narrowed: IrExpr = isUnitType(arm)
        ? { kind: "unitLit", unit: arm.kind === "nullT" ? "null" : "undefined", type: arm, loc }
        : { kind: "unionNarrow", unionId, tag, value, type: arm, loc };
      const converted = lowerBigIntConstructorValue(lowerer, narrowed, loc);
      if (!converted) throw new InternalCompilerError("BigInt scalar union has an unsupported arm");
      const ret: IrStmt = { kind: "return", value: converted, loc };
      body.push(
        tag === arms.length - 1
          ? ret
          : {
              kind: "if",
              cond: { kind: "unionIsTag", unionId, tag, negated: false, value, type: BOOL, loc },
              then: [ret],
              else_: null,
              loc,
            },
      );
    });
    lowerer.liftedFns.push({
      name: helper,
      params: [{ localId: "value.0", name: "value", type: arg.type }],
      returnType: BIGINT_T,
      locals: [{ id: "value.0", name: "value", type: arg.type, mutable: false }],
      body,
      loc,
    });
  }
  return { kind: "call", callee: helper, args: [arg], type: BIGINT_T, loc };
}

function immediatePrimitiveWrapperToString(lowerer: Lowerer, node: ts.Expression): IrExpr | null {
  const stringValue = stringWrapperToString(lowerer, node);
  if (stringValue) return stringValue;
  let wrapped = node;
  while (ts.isParenthesizedExpression(wrapped)) wrapped = wrapped.expression;
  if (!ts.isNewExpression(wrapped) || !ts.isIdentifier(wrapped.expression)) return null;
  const name = wrapped.expression.text;
  if (
    (name !== "Boolean" && name !== "Number") ||
    !lowerer.isStdlibSymbol(lowerer.resolveValueSymbol(wrapped.expression) ?? undefined)
  )
    return null;
  const args = wrapped.arguments?.nodes ?? [];
  if (args.length > 1 || args.some(ts.isSpreadElement)) return null;
  const loc = locOf(wrapped);
  const primitive: IrExpr =
    name === "Boolean"
      ? args.length
        ? lowerer.lowerCondition(args[0]!)
        : { kind: "boolLit", value: false, type: BOOL, loc }
      : args.length
        ? lowerNumberConstructorValue(lowerer, args[0]!, loc)
        : { kind: "numLit", value: 0, type: F64, loc };
  return lowerer.ensureString(primitive, wrapped);
}

function objectToStringTag(lowerer: Lowerer, type: IrType): string | null {
  switch (type.kind) {
    case "undefinedT":
    case "void":
      return "Undefined";
    case "nullT":
      return "Null";
    case "bool":
      return "Boolean";
    case "f64":
      return "Number";
    case "string":
      return "String";
    case "bigint":
      return "BigInt";
    case "symbol":
      return "Symbol";
    case "array":
      return "Array";
    case "record":
      return "Object";
    case "func":
    case "classval":
      return "Function";
    case "date":
      return "Date";
    case "regex":
      return "RegExp";
    case "map":
      return "Map";
    case "set":
      return "Set";
    case "promise":
      return "Promise";
    case "bytes":
      return BYTES_ELEMENT_NAME[type.elem];
    case "object":
      return type.className === "%Error" || lowerer.isSubclassOf(type.className, "%Error")
        ? "Error"
        : null;
    default:
      return null;
  }
}

function immediateObjectTagReceiver(
  lowerer: Lowerer,
  node: ts.Expression,
): { tag: string; effect: IrExpr } | null {
  let value = node;
  while (ts.isParenthesizedExpression(value)) value = value.expression;
  const loc = locOf(value);
  if (ts.isArrayLiteralExpression(value)) return { tag: "Array", effect: lowerer.lowerExpr(value) };
  if (
    (ts.isCallExpression(value) || ts.isNewExpression(value)) &&
    ts.isIdentifier(value.expression) &&
    (value.expression.text === "Array" || value.expression.text === "Error") &&
    (value.arguments?.nodes.length ?? 0) === 0 &&
    lowerer.isStdlibSymbol(lowerer.resolveValueSymbol(value.expression) ?? undefined)
  ) {
    return { tag: value.expression.text, effect: { kind: "numLit", value: 0, type: F64, loc } };
  }
  if (
    ts.isNewExpression(value) &&
    ts.isIdentifier(value.expression) &&
    lowerer.isStdlibSymbol(lowerer.resolveValueSymbol(value.expression) ?? undefined)
  ) {
    const name = value.expression.text;
    const args = value.arguments?.nodes ?? [];
    // JavaScript dates use checked native handles, so their IR type alone
    // cannot recover the tag through an immediate Object(...) wrapper.
    if (name === "Date") return { tag: "Date", effect: lowerer.lowerExpr(value) };
    if (args.length <= 1 && !args.some(ts.isSpreadElement)) {
      if (name === "String") {
        const effect = stringWrapperToString(lowerer, value);
        if (effect) return { tag: "String", effect };
      }
      if (name === "Number")
        return {
          tag: "Number",
          effect: args.length
            ? lowerNumberConstructorValue(lowerer, args[0]!, loc)
            : { kind: "numLit", value: 0, type: F64, loc },
        };
      if (name === "Boolean")
        return {
          tag: "Boolean",
          effect: args.length
            ? lowerer.lowerCondition(args[0]!)
            : { kind: "boolLit", value: false, type: BOOL, loc },
        };
    }
  }
  if (
    (ts.isCallExpression(value) || ts.isNewExpression(value)) &&
    ts.isIdentifier(value.expression) &&
    value.expression.text === "Object" &&
    lowerer.isStdlibSymbol(lowerer.resolveValueSymbol(value.expression) ?? undefined)
  ) {
    const args = value.arguments?.nodes ?? [];
    if (args.some(ts.isSpreadElement)) return null;
    const first = args[0];
    const inner =
      first &&
      (immediateObjectTagReceiver(lowerer, first) ??
        (() => {
          const effect = lowerer.lowerExpr(first);
          const tag =
            isUnitType(effect.type) || effect.type.kind === "void"
              ? "Object"
              : objectToStringTag(lowerer, effect.type);
          return tag === null ? null : { tag, effect };
        })());
    if (first && !inner) return null;
    const stmts: IrStmt[] = [];
    if (inner && !isSafeToDiscard(inner.effect))
      stmts.push({ kind: "exprStmt", expr: inner.effect, loc: inner.effect.loc });
    for (const extra of args.slice(1)) {
      const effect = lowerer.lowerExpr(extra);
      if (!isSafeToDiscard(effect))
        stmts.push({ kind: "exprStmt", expr: effect, loc: locOf(extra) });
    }
    return {
      tag: inner?.tag ?? "Object",
      effect: {
        kind: "seqExpr",
        stmts,
        result: { kind: "numLit", value: 0, type: F64, loc },
        type: F64,
        loc,
      },
    };
  }
  return null;
}

const ARRAY_BORROW_METHODS = new Set([
  "at",
  "every",
  "filter",
  "find",
  "findIndex",
  "findLast",
  "findLastIndex",
  "forEach",
  "includes",
  "indexOf",
  "lastIndexOf",
  "map",
  "reduce",
  "reduceRight",
  "slice",
  "some",
]);

function lowerArrayPrototypeBorrowCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (
    !isJsSourceFile(ts.getSourceFileOfNode(call)) ||
    call.questionDotToken ||
    access.questionDotToken ||
    access.name.text !== "call" ||
    !ts.isPropertyAccessExpression(access.expression) ||
    call.arguments.nodes.some(ts.isSpreadElement)
  )
    return null;
  const method = access.expression;
  if (
    method.questionDotToken ||
    !ARRAY_BORROW_METHODS.has(method.name.text) ||
    !ts.isPropertyAccessExpression(method.expression) ||
    method.expression.questionDotToken ||
    method.expression.name.text !== "prototype" ||
    !lowerer.isStdlibGlobal(method.expression.expression, "Array") ||
    !lowerer.isStdlibMember(method)
  )
    return null;
  const loc = locOf(call);
  const receiver = call.arguments.nodes[0]
    ? lowerer.lowerExprExpecting(call.arguments.nodes[0]!, DYN)
    : (dynUndefinedExpr(loc) as IrExpr);
  const args = call.arguments.nodes.slice(1).map((arg) => lowerer.lowerExprExpecting(arg, DYN));
  return {
    kind: "libCall",
    fn: "dyn.arrayProtoCall",
    args: [
      receiver,
      { kind: "strLit", value: method.name.text, type: STRING, loc },
      { kind: "dynArrLit", elems: args, type: DYN, loc },
    ],
    type: DYN,
    loc,
  };
}

function lowerObjectOwnPrototypeCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (access.name.text !== "call" || !ts.isPropertyAccessExpression(access.expression)) return null;
  const method = access.expression;
  const enumerable = method.name.text === "propertyIsEnumerable";
  if (method.name.text !== "hasOwnProperty" && !enumerable) return null;
  const prototype = method.expression;
  if (
    !ts.isPropertyAccessExpression(prototype) ||
    prototype.name.text !== "prototype" ||
    !lowerer.isStdlibGlobal(prototype.expression, "Object") ||
    !lowerer.isStdlibMember(method) ||
    call.arguments.nodes.some(ts.isSpreadElement)
  )
    return null;
  return lowerObjectOwnCall(
    lowerer,
    call,
    call.arguments.nodes[0],
    call.arguments.nodes[1],
    call.arguments.nodes.slice(2),
    method.name.text,
  );
}

function lowerObjectOwnMethodCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  const method = access.name.text;
  if (
    call.questionDotToken ||
    access.questionDotToken ||
    (method !== "hasOwnProperty" && method !== "propertyIsEnumerable") ||
    call.arguments.nodes.some(ts.isSpreadElement)
  )
    return null;
  if (!lowerer.isStdlibMember(access)) {
    const receiver = tryLowerExpression(lowerer, access.expression);
    if (receiver?.type.kind !== "dyn") return null;
  }
  return lowerObjectOwnCall(
    lowerer,
    call,
    access.expression,
    call.arguments.nodes[0],
    call.arguments.nodes.slice(1),
    method,
    access,
  );
}

/** ToPropertyKey for the scalar keys represented by native own-key
 * probes. A lowered array-loop key may carry an undefined arm even when
 * its checker type is string; that arm spells "undefined" at runtime. */
function ownPropertyKey(lowerer: Lowerer, key: IrExpr): IrExpr | null {
  if (key.type.kind === "string") return key;
  if (key.type.kind === "bigint") {
    return {
      kind: "libCall",
      fn: "bigint.toString",
      args: [key, numLit(10, key.loc)],
      type: STRING,
      loc: key.loc,
    };
  }
  const scalar = (type: IrType): boolean =>
    type.kind === "string" || type.kind === "f64" || type.kind === "bool" || isUnitType(type);
  if (
    key.type.kind === "f64" ||
    key.type.kind === "bool" ||
    key.type.kind === "dyn" ||
    (key.type.kind === "union" && lowerer.unions.get(key.type.unionId)?.arms.every(scalar))
  ) {
    return { kind: "toString", operand: key, type: STRING, loc: key.loc };
  }
  return null;
}

function lowerObjectOwnCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  receiverNode: ts.Expression | undefined,
  keyNode: ts.Expression | undefined,
  extraNodes: readonly ts.Expression[],
  method: string,
  // The `receiver.method` access of a method call (null for the
  // Object.prototype.method.call form).
  methodAccess: ts.PropertyAccessExpression | null = null,
): IrExpr {
  const enumerable = method === "propertyIsEnumerable";
  const loc = locOf(call);
  const stmts: IrStmt[] = [];
  const receiver = receiverNode
    ? lowerer.lowerExpr(receiverNode)
    : ({ kind: "unitLit", unit: "undefined", type: UNDEFINED_T, loc } as IrExpr);
  let receiverRef: IrExpr = receiver;
  if (isUnitType(receiver.type) || receiver.type.kind === "void") {
    if (!isSafeToDiscard(receiver)) stmts.push({ kind: "exprStmt", expr: receiver, loc });
  } else {
    const local = lowerer.declareHiddenLocal("%ownReceiver", receiver.type);
    stmts.push({ kind: "varDecl", localId: local.id, init: receiver, loc });
    receiverRef = varRef(local.id, receiver.type, loc);
  }
  const rawKey = keyNode ? lowerer.lowerExpr(keyNode) : null;
  let keyRef: IrExpr | null = rawKey;
  if (rawKey && (isUnitType(rawKey.type) || rawKey.type.kind === "void")) {
    if (!isSafeToDiscard(rawKey)) stmts.push({ kind: "exprStmt", expr: rawKey, loc: rawKey.loc });
  } else if (rawKey) {
    const local = lowerer.declareHiddenLocal("%ownKey", rawKey.type);
    stmts.push({ kind: "varDecl", localId: local.id, init: rawKey, loc: rawKey.loc });
    keyRef = varRef(local.id, rawKey.type, loc);
  }
  for (const extra of extraNodes) {
    const effect = lowerer.lowerExpr(extra);
    if (!isSafeToDiscard(effect)) stmts.push({ kind: "exprStmt", expr: effect, loc: locOf(extra) });
  }
  let key: IrExpr | null = keyRef;
  if (
    lowerer.dynConvertible(receiverRef.type) &&
    keyRef &&
    (receiverRef.type.kind === "object" ||
      keyRef.type.kind === "symbol" ||
      keyRef.type.kind === "dyn" ||
      (keyRef.type.kind === "union" && lowerer.dynConvertible(keyRef.type)))
  ) {
    const result: IrExpr = {
      kind: "libCall",
      fn: enumerable ? "dyn.propertyIsEnumerableComputed" : "dyn.hasOwnComputed",
      args: [lowerer.coerceToExpected(receiverRef, DYN), lowerer.coerceToExpected(keyRef, DYN)],
      type: BOOL,
      loc,
    };
    return { kind: "seqExpr", stmts, result, type: BOOL, loc };
  }
  if (!keyNode || rawKey?.type.kind === "undefinedT" || rawKey?.type.kind === "void") {
    key = { kind: "strLit", value: "undefined", type: STRING, loc };
  } else if (rawKey?.type.kind === "nullT") {
    key = { kind: "strLit", value: "null", type: STRING, loc };
  } else if (key) {
    key = ownPropertyKey(lowerer, key);
  }
  if (!key || key.type.kind !== "string") {
    lowerer.noLowering("Object.prototype." + method + " with this property key", keyNode ?? call);
  }
  let result: IrExpr;
  const type = receiver.type;
  if (isUnitType(type) || type.kind === "void") {
    result = nodeThrowExpr(1, "", "Cannot convert undefined or null to object", BOOL, loc);
  } else if (type.kind === "record") {
    const shape = lowerer.shapes.get(type.shapeId);
    fencePerfEntryKeyWalk(lowerer, type, receiverNode ?? call, `Object.prototype.${method}`);
    if (!shape || shape.tuple || shapeHasAccessorSlots(shape)) {
      lowerer.noLowering(
        "Object.prototype." + method + " over this record shape",
        receiverNode ?? call,
      );
    }
    // A null-prototype record (Object.groupBy) has no such method: Node
    // throws after evaluating the arguments.
    result = {
      kind: "call",
      callee: recordHasOwnHelper(lowerer, type.shapeId, loc),
      args: [receiverRef, key],
      type: BOOL,
      loc,
    };
    if (methodAccess && nullProtoRecordShape(lowerer, type)) {
      result = guardNullProto(
        receiverRef,
        type.shapeId,
        `${ts.getTextOfNode(methodAccess)} is not a function`,
        result,
        loc,
      );
    }
  } else if (type.kind === "dyn") {
    result = {
      kind: "libCall",
      fn: enumerable ? "dyn.propertyIsEnumerable" : "dyn.hasOwn",
      args: [receiverRef, key],
      type: BOOL,
      loc,
    };
  } else if (type.kind === "string" || type.kind === "array") {
    const needleLocal = lowerer.declareHiddenLocal("%ownIndex", F64);
    stmts.push({
      kind: "varDecl",
      localId: needleLocal.id,
      init: { kind: "libCall", fn: "num.fromString", args: [key], type: F64, loc },
      loc,
    });
    const needle = varRef(needleLocal.id, F64, loc);
    const length: IrExpr =
      type.kind === "string"
        ? {
            kind: "strIntrinsic",
            method: "length",
            receiver: receiverRef,
            args: [],
            type: F64,
            loc,
          }
        : {
            kind: "arrIntrinsic",
            method: "length",
            receiver: receiverRef,
            args: [],
            type: F64,
            loc,
          };
    const inRange: IrExpr = { kind: "bin", op: "<", left: needle, right: length, type: BOOL, loc };
    const nonNegative: IrExpr = {
      kind: "bin",
      op: ">=",
      left: needle,
      right: { kind: "numLit", value: 0, type: F64, loc },
      type: BOOL,
      loc,
    };
    const integer: IrExpr = {
      kind: "bin",
      op: "===",
      left: needle,
      right: { kind: "libCall", fn: "math.floor", args: [needle], type: F64, loc },
      type: BOOL,
      loc,
    };
    const canonical: IrExpr = {
      kind: "strEq",
      negated: false,
      left: key,
      right: { kind: "toString", operand: needle, type: STRING, loc },
      type: BOOL,
      loc,
    };
    const present: IrExpr =
      type.kind === "string"
        ? { kind: "boolLit", value: true, type: BOOL, loc }
        : {
            kind: "bin",
            op: "===",
            left: {
              kind: "arrIntrinsic",
              method: "nextPresent",
              receiver: receiverRef,
              args: [needle],
              type: F64,
              loc,
            },
            right: needle,
            type: BOOL,
            loc,
          };
    const no: IrExpr = { kind: "boolLit", value: false, type: BOOL, loc };
    const indexOwn = [inRange, integer, canonical, present].reduce<IrExpr>(
      (left, right) => ({ kind: "logical", op: "&&", left, right, type: BOOL, loc }),
      nonNegative,
    );
    const lengthOwn: IrExpr = !enumerable
      ? {
          kind: "strEq",
          negated: false,
          left: key,
          right: { kind: "strLit", value: "length", type: STRING, loc },
          type: BOOL,
          loc,
        }
      : no;
    result = { kind: "logical", op: "||", left: lengthOwn, right: indexOwn, type: BOOL, loc };
  } else if (
    type.kind === "f64" ||
    type.kind === "bool" ||
    type.kind === "bigint" ||
    type.kind === "symbol"
  ) {
    result = { kind: "boolLit", value: false, type: BOOL, loc };
  } else {
    lowerer.noLowering(
      "Object.prototype." + method + " over a " + lowerer.fmt(type) + " receiver",
      receiverNode ?? call,
    );
  }
  return { kind: "seqExpr", stmts, result, type: BOOL, loc };
}

function lowerObjectPrototypeCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (access.name.text !== "call" || !ts.isPropertyAccessExpression(access.expression)) return null;
  const method = access.expression;
  const prototype = method.expression;
  if (
    method.name.text !== "toString" ||
    !ts.isPropertyAccessExpression(prototype) ||
    prototype.name.text !== "prototype" ||
    !lowerer.isStdlibGlobal(prototype.expression, "Object") ||
    !lowerer.isStdlibMember(method) ||
    call.arguments.nodes.some(ts.isSpreadElement)
  )
    return null;
  const loc = locOf(call);
  if (call.arguments.nodes.length === 0)
    return { kind: "strLit", value: "[object Undefined]", type: STRING, loc };
  const receiverNode = call.arguments.nodes[0]!;
  const immediate = immediateObjectTagReceiver(lowerer, receiverNode);
  const receiver = immediate?.effect ?? lowerer.lowerExpr(receiverNode);
  const tag = immediate?.tag ?? objectToStringTag(lowerer, receiver.type);
  if (tag === null && immediate === null && call.arguments.nodes.length === 1) {
    const classTag = classObjectTag(lowerer, receiver, receiverNode);
    if (classTag) return classTag;
  }
  // A generator object answers its tag through its checked capsule.
  if (tag === null && receiver.type.kind !== "dyn" && receiver.type.kind !== "generator") {
    lowerer.noLowering(
      "Object.prototype.toString.call over a " + lowerer.fmt(receiver.type) + " receiver",
      receiverNode,
    );
  }
  const stmts: IrStmt[] = [];
  let ref: IrExpr = receiver;
  if (isUnitType(receiver.type) || receiver.type.kind === "void") {
    if (!isSafeToDiscard(receiver)) stmts.push({ kind: "exprStmt", expr: receiver, loc });
  } else {
    const local = lowerer.declareHiddenLocal("%objectTagReceiver", receiver.type);
    stmts.push({ kind: "varDecl", localId: local.id, init: receiver, loc });
    ref = varRef(local.id, receiver.type, loc);
  }
  for (const extra of call.arguments.nodes.slice(1)) {
    stmts.push({ kind: "exprStmt", expr: lowerer.lowerExpr(extra), loc: locOf(extra) });
  }
  const result: IrExpr =
    tag === null
      ? {
          kind: "libCall",
          fn: "dyn.objectTag",
          args: [ref.type.kind === "generator" ? lowerer.coerceToExpected(ref, DYN) : ref],
          type: STRING,
          loc,
        }
      : { kind: "strLit", value: "[object " + tag + "]", type: STRING, loc };
  return { kind: "seqExpr", stmts, result, type: STRING, loc };
}

/** Function.call evaluates all arguments before RequireObjectCoercible and
 * ToString. Stabilize them before reusing the ordinary string method lowering,
 * so a boxed nullish receiver or a coercion hook cannot reorder effects. */
function lowerDynamicStringPrototypeCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  methodAccess: ts.PropertyAccessExpression,
  receiver: IrExpr,
  method: string,
): IrExpr | null {
  const loc = locOf(call);
  const receiverLocal = lowerer.declareHiddenLocal("%stringCallReceiver", receiver.type);
  const stmts: IrStmt[] = [{ kind: "varDecl", localId: receiverLocal.id, init: receiver, loc }];
  const receiverRef = varRef(receiverLocal.id, receiver.type, loc);
  const converted: IrExpr = {
    kind: "ternary",
    cond: { kind: "dynTest", test: "nullish", value: receiverRef, type: BOOL, loc },
    then: nodeThrowExpr(
      1,
      "",
      `String.prototype.${method} called on null or undefined`,
      STRING,
      loc,
    ),
    else_: { kind: "libCall", fn: "dyn.toStringCoerce", args: [receiverRef], type: STRING, loc },
    type: STRING,
    loc,
  };
  const overrides: { node: ts.Expression; previous: IrExpr | undefined }[] = [];
  try {
    for (const node of call.arguments.nodes.slice(1)) {
      const undefinedValue = lowerStaticallyUndefinedArgument(lowerer, node);
      const value = undefinedValue ?? lowerer.lowerExpr(node);
      let ref: IrExpr;
      if (undefinedValue || isUnitType(value.type) || value.type.kind === "void") {
        stmts.push({ kind: "exprStmt", expr: value, loc: value.loc });
        const nullUnit = !undefinedValue && value.type.kind === "nullT";
        ref = {
          kind: "unitLit",
          unit: nullUnit ? "null" : "undefined",
          type: nullUnit ? value.type : UNDEFINED_T,
          loc: value.loc,
        };
      } else {
        const local = lowerer.declareHiddenLocal("%stringCallArg", value.type);
        stmts.push({ kind: "varDecl", localId: local.id, init: value, loc: value.loc });
        ref = varRef(local.id, value.type, value.loc);
      }
      overrides.push({ node, previous: lowerer.chainRecvByNode.get(node) });
      lowerer.chainRecvByNode.set(node, ref);
    }
    const result = lowerStringMethodCallWithOptionalArgs(
      lowerer,
      call,
      methodAccess,
      () => converted,
      call.arguments.nodes.slice(1),
    );
    return result ? { kind: "seqExpr", stmts, result, type: result.type, loc } : null;
  } finally {
    for (const override of overrides) {
      if (override.previous) lowerer.chainRecvByNode.set(override.node, override.previous);
      else lowerer.chainRecvByNode.delete(override.node);
    }
  }
}

function lowerStringPrototypeCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (access.name.text !== "call" || !ts.isPropertyAccessExpression(access.expression)) return null;
  const methodAccess = access.expression;
  const prototypeAccess = methodAccess.expression;
  if (
    !ts.isPropertyAccessExpression(prototypeAccess) ||
    prototypeAccess.name.text !== "prototype" ||
    !ts.isIdentifier(prototypeAccess.expression) ||
    prototypeAccess.expression.text !== "String" ||
    (!Object.hasOwn(STR_METHODS, methodAccess.name.text) &&
      !STRING_INDEX_METHODS.has(methodAccess.name.text)) ||
    !lowerer.isStdlibMember(methodAccess)
  )
    return null;
  if (call.arguments.nodes.some(ts.isSpreadElement)) return null;
  const entry = STR_METHODS[methodAccess.name.text];
  const indexMethod = STRING_INDEX_METHODS.has(methodAccess.name.text)
    ? (methodAccess.name.text as "at" | "codePointAt")
    : null;
  const resultType = indexMethod
    ? lowerer.withUndefinedArmOf(indexMethod === "at" ? STRING : F64)
    : entry?.result;
  if (!resultType) return null;
  const method =
    methodAccess.name.text === "trimStart"
      ? "trimLeft"
      : methodAccess.name.text === "trimEnd"
        ? "trimRight"
        : methodAccess.name.text;
  const loc = locOf(call);
  const nullishError = nodeThrowExpr(
    1,
    "",
    `String.prototype.${method} called on null or undefined`,
    resultType,
    loc,
  );
  const receiverNode = call.arguments.nodes[0];
  if (!receiverNode) return nullishError;
  // Receiver coercion runs after .call has evaluated its arguments; keep
  // contextual wrapper lowering on forms without later method arguments.
  const immediateWrapper =
    entry?.maxArgs === 0 && call.arguments.nodes.length === 1
      ? immediatePrimitiveWrapperToString(lowerer, receiverNode)
      : null;
  const receiverValue = immediateWrapper ?? lowerer.lowerExpr(receiverNode);
  const receiverType = receiverValue.type;
  const nullish =
    isUnitType(receiverType) ||
    receiverType.kind === "void" ||
    (receiverType.kind === "union" &&
      (lowerer.unions
        .get(receiverType.unionId)
        ?.arms.every((arm) => isUnitType(arm) || arm.kind === "void") ??
        false));
  if (nullish) {
    const values = [
      receiverValue,
      ...call.arguments.nodes.slice(1).map((arg) => lowerer.lowerExpr(arg)),
    ];
    return {
      kind: "seqExpr",
      stmts: values
        .filter((value) => !isSafeToDiscard(value))
        .map((value) => ({ kind: "exprStmt", expr: value, loc: value.loc })),
      result: nullishError,
      type: resultType,
      loc,
    };
  }
  if (receiverType.kind === "dyn") {
    return lowerDynamicStringPrototypeCall(lowerer, call, methodAccess, receiverValue, method);
  }
  const padding = entry?.method === "padStart" || entry?.method === "padEnd";
  const scalar =
    receiverType.kind === "string" ||
    receiverType.kind === "f64" ||
    receiverType.kind === "bool" ||
    receiverType.kind === "bigint" ||
    (receiverType.kind === "union" &&
      (lowerer.unions
        .get(receiverType.unionId)
        ?.arms.every(
          (arm) =>
            arm.kind === "string" ||
            arm.kind === "f64" ||
            arm.kind === "bool" ||
            arm.kind === "bigint",
        ) ??
        false));
  // Other methods convert object receivers before lowering their arguments;
  // padding uses a helper that delays conversion until every argument is ready.
  const objectWithoutMethodArgs =
    entry?.maxArgs === 0 &&
    call.arguments.nodes.length === 1 &&
    (receiverType.kind === "record" ||
      receiverType.kind === "array" ||
      receiverType.kind === "object");
  if (padding && !scalar && lowerer.dynConvertible(receiverType)) {
    return lowerStringPaddingCall(
      lowerer,
      call,
      entry.method as "padStart" | "padEnd",
      lowerer.coerceToExpected(receiverValue, DYN),
      receiverNode,
      call.arguments.nodes.slice(1),
    );
  }
  if (!scalar && !objectWithoutMethodArgs) {
    lowerer.noLowering(
      `String.prototype.${methodAccess.name.text}.call with ${lowerer.fmt(receiverType)} receivers`,
      call,
    );
  }
  if (indexMethod)
    return lowerStringIndexCall(
      lowerer,
      call,
      indexMethod,
      receiverValue,
      receiverNode,
      call.arguments.nodes.slice(1),
    );
  if (!entry) return null;
  if (padding) {
    return lowerStringPaddingCall(
      lowerer,
      call,
      entry.method as "padStart" | "padEnd",
      receiverValue,
      receiverNode,
      call.arguments.nodes.slice(1),
    );
  }
  if (entry.method === "split") {
    return lowerStringSplitCall(
      lowerer,
      call,
      receiverValue,
      receiverNode,
      call.arguments.nodes.slice(1),
    );
  }
  const receiver = lowerer.ensureString(receiverValue, receiverNode);
  return lowerStringMethodCallWithOptionalArgs(
    lowerer,
    call,
    methodAccess,
    () => receiver,
    call.arguments.nodes.slice(1),
  );
}

/** ToNumber of a union of strings, numbers, booleans, null and undefined, as
 * `Number(value)` converts it; null for other types. Unary `+` takes it too:
 * the two conversions differ only for BigInt, which such unions don't hold. */
export function lowerPrimitiveUnionNumber(
  lowerer: Lowerer,
  arg: IrExpr,
  node: ts.Expression,
  loc: SrcLoc,
): IrExpr | null {
  return (
    lowerOptionalStringNumber(lowerer, arg, loc) ?? lowerScalarUnionNumber(lowerer, arg, node, loc)
  );
}

function lowerScalarUnionNumber(
  lowerer: Lowerer,
  arg: IrExpr,
  node: ts.Expression,
  loc: SrcLoc,
): IrExpr | null {
  if (
    arg.type.kind !== "union" ||
    !lowerer.unions
      .get(arg.type.unionId)
      ?.arms.every(
        (arm) =>
          arm.kind === "f64" || arm.kind === "string" || arm.kind === "bool" || isUnitType(arm),
      )
  )
    return null;
  const key = `number.scalar:${arg.type.unionId}`;
  let helper = lowerer.valueHelpers.get(key);
  if (!helper) {
    helper = keyedHelperName(lowerer, "%number.scalar", key);
    lowerer.valueHelpers.set(key, helper);
    const value = varRef("value.0", arg.type, loc);
    const nan: IrExpr = {
      kind: "bin",
      op: "/",
      left: { kind: "numLit", value: 0, type: F64, loc },
      right: { kind: "numLit", value: 0, type: F64, loc },
      type: F64,
      loc,
    };
    lowerer.liftedFns.push({
      name: helper,
      params: [{ localId: "value.0", name: "value", type: arg.type }],
      returnType: F64,
      locals: [{ id: "value.0", name: "value", type: arg.type, mutable: false }],
      body: [
        {
          kind: "return",
          value: positionNumber(lowerer, value, nan, node, "Number argument"),
          loc,
        },
      ],
      loc,
    });
  }
  return { kind: "call", callee: helper, args: [arg], type: F64, loc };
}

function lowerOptionalStringNumber(
  lowerer: Lowerer,
  arg: IrExpr,
  loc: SrcLoc,
  fn: "num.fromString" | "num.parseFloat" = "num.fromString",
  label = "number",
): IrExpr | null {
  if (arg.type.kind !== "union") return null;
  const def = lowerer.unions.get(arg.type.unionId);
  if (!def || def.arms.length !== 2) return null;
  const stringTag = lowerer.armTag(arg.type.unionId, STRING);
  const undefinedTag = lowerer.armTag(arg.type.unionId, UNDEFINED_T);
  if (stringTag < 0 || undefinedTag < 0) return null;
  const key = `${label}.optionalString:${arg.type.unionId}`;
  let helper = lowerer.valueHelpers.get(key);
  if (!helper) {
    helper = keyedHelperName(lowerer, `%${label}.optionalString`, key);
    lowerer.valueHelpers.set(key, helper);
    const value = varRef("value.0", arg.type, loc);
    lowerer.liftedFns.push({
      name: helper,
      params: [{ localId: "value.0", name: "value", type: arg.type }],
      returnType: F64,
      locals: [{ id: "value.0", name: "value", type: arg.type, mutable: false }],
      body: [
        {
          kind: "if",
          cond: {
            kind: "unionIsTag",
            unionId: arg.type.unionId,
            tag: undefinedTag,
            negated: false,
            value,
            type: BOOL,
            loc,
          },
          then: [
            {
              kind: "return",
              value: {
                kind: "bin",
                op: "/",
                left: { kind: "numLit", value: 0, type: F64, loc },
                right: { kind: "numLit", value: 0, type: F64, loc },
                type: F64,
                loc,
              },
              loc,
            },
          ],
          else_: null,
          loc,
        },
        {
          kind: "return",
          value: {
            kind: "libCall",
            fn,
            args: [
              {
                kind: "unionNarrow",
                unionId: arg.type.unionId,
                tag: stringTag,
                value,
                type: STRING,
                loc,
              },
            ],
            type: F64,
            loc,
          },
          loc,
        },
      ],
      loc,
    });
  }
  return { kind: "call", callee: helper, args: [arg], type: F64, loc };
}

/** `s[Symbol.iterator]()` on a string-typed receiver: the generator over
 * its code points. Null for other element calls. */
function lowerStringIteratorCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.ElementAccessExpression,
): IrExpr | null {
  let key = access.argumentExpression;
  while (ts.isParenthesizedExpression(key)) key = key.expression;
  if (
    !ts.isPropertyAccessExpression(key) ||
    lowerer.stdlibGlobalMember(key, "Symbol") !== "iterator"
  )
    return null;
  if (lowerer.mapTypeOf(lowerer.typeOf(access.expression))?.kind !== "string") return null;
  const type = lowerer.mapTypeOf(lowerer.typeOf(call));
  if (type?.kind !== "generator") return null;
  const receiver = lowerer.lowerExpr(access.expression);
  const value = lowerStringIteratorValue(lowerer, receiver, type, locOf(call));
  if (!value) lowerer.unsupported("SC1090", call, "this string iterator type");
  return value;
}

/** Iterator types with checked runtime receivers, whose helper calls lower
 * in lowerGeneratorHelperCall. */
const CHECKED_ITERATOR_TYPES = new Set(["MapIterator", "SetIterator"]);
const ITERATOR_HELPER_METHODS = new Set([
  "map",
  "filter",
  "take",
  "drop",
  "flatMap",
  "toArray",
  "forEach",
  "reduce",
  "some",
  "every",
  "find",
]);

/** A call expression, through parentheses: its value has no other holder. */
function isFreshCallResult(node: ts.Expression): boolean {
  let e = node;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  return ts.isCallExpression(e);
}

/** METHOD calls on dyn receivers (`pkg.name.replace(...)`, `rawName.split`,
 * `ws.packages.filter(...)` — JSON.parse-derived values): validate the
 * receiver's dyn kind, extract, and ride the STATIC method machinery — the
 * dyn boundary's trust-but-verify stance extended to receivers. The
 * receiver-kind mismatch throws V8's own catchable TypeErrors (nullish:
 * "Cannot read properties of undefined (reading 'replace')"; other kinds:
 * "pkg.name.replace is not a function") — though BEFORE the arguments
 * evaluate, where JS evaluates them first for the non-nullish case
 * (SEMANTICS.md). String methods ride the string/regex intrinsic tables
 * through a validated-string receiver; `.filter` runs the predicate over
 * the dyn array and validated-extracts the survivors into the element type
 * the checker committed the result to. Null when the receiver isn't a dyn
 * value or the method isn't claimable (the method-call fence stays). */
function lowerDynReceiverMethodCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
  boxTypedTemporary = false,
): IrExpr | null {
  if (lowerer.chainBlocked(call, access)) return null;
  if (stdlibGlobalNameOf(lowerer, access.expression) !== null) {
    // A named builtin import can resolve to its ambient declaration, too.
    // parentPort is an instance value whose methods use the native handle;
    // it must work without a non-null assertion or a namespace spelling.
    const binding = ts.isIdentifier(access.expression)
      ? lowerer.builtinImportOf(access.expression)
      : null;
    if (binding?.module !== "worker_threads" || binding.member !== "parentPort") return null;
  }
  // Only checker-untyped receivers: `any`/`unknown`, or the `any[]` an
  // Array.isArray guard narrows them to (the value is STILL the checked-dynamic tree
  // array — scalar narrowings bridge through maybeNarrow's dynCheck and
  // take the ordinary typed paths, but there is no static home for an
  // any-elemented array). Typed receivers keep their own lowerings.
  // An optional step the chain already guarded (`s?.m(x)`) has a receiver
  // proven non-nullish.
  const rawRecvTs = lowerer.typeOf(access.expression);
  const recvTs =
    access.questionDotToken !== undefined && lowerer.chainHandled.has(access)
      ? lowerer.checker.getNonNullableType(rawRecvTs)
      : rawRecvTs;
  if (lowerer.classImplementedProtocol(recvTs)) {
    const viewed = pickViewGenericMethodCall(lowerer, call, access, recvTs);
    if (viewed) return viewed;
    const property = lowerer.checker.getPropertyOfType(recvTs, access.name.text);
    if (
      property &&
      isGenericCallableMemberType(lowerer.checker.getTypeOfSymbol(property), lowerer.checker)
    )
      return lowerObjLitGenericMethodCall(lowerer, call, access);
  }
  const recvSymbol = recvTs.getSymbol();
  if (
    recvSymbol &&
    CHECKED_ITERATOR_TYPES.has(ts.symbolName(recvSymbol)) &&
    lowerer.isStdlibSymbol(recvSymbol) &&
    ITERATOR_HELPER_METHODS.has(access.name.text) &&
    lowerer.isStdlibMember(access)
  ) {
    const helper = lowerGeneratorHelperCall(lowerer, call, access);
    if (helper) return helper;
    lowerer.noLowering(
      `collection iterator .${access.name.text}()`,
      call,
      "iterator helpers on Map/Set iterators are called directly on the iterator, without optional chaining",
    );
  }
  const arrayReceiver = lowerer.checker.isArrayType(recvTs);
  const anyArray =
    arrayReceiver &&
    ((lowerer.checker.getTypeArguments(recvTs as ts.TypeReference)[0]?.flags ?? 0) &
      (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !==
      0;
  const checkerUntyped =
    (recvTs.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0 || anyArray;
  let recv: IrExpr;
  if (checkerUntyped) {
    recv = lowerer.lowerExpr(access.expression);
  } else {
    // A checker-TYPED spelling whose VALUE is still checked-dynamic (an
    // evolving `let h = {}` object flowing back out of a JS helper —
    // tsc types the return by the evolved shape, the binding lowered
    // dyn): probe the lowering and claim exactly the dyn results.
    const probed = tryLowerExpression(lowerer, access.expression);
    if (
      probed?.type.kind === "func" &&
      stdlibGlobalNameOf(lowerer, access.expression) === null &&
      !["call", "apply", "bind", "toString", "valueOf", "constructor"].includes(access.name.text) &&
      canBoxFuncIntoDyn(
        probed.type,
        (id) => lowerer.shapes.get(id),
        (id) => lowerer.unions.get(id),
      )
    ) {
      const loc = locOf(call);
      const fnName = jsFuncNameOf(access.expression, lowerer);
      const boxed: IrExpr = {
        kind: "dynFrom",
        value: probed,
        type: DYN,
        loc,
        ...(fnName !== null ? { fnName } : {}),
      };
      const local = lowerer.declareHiddenLocal("%callableReceiver", DYN);
      const receiver: IrExpr = { kind: "varRef", localId: local.id, type: DYN, loc };
      const member: IrExpr = {
        kind: "dynKeyGet",
        value: receiver,
        key: { kind: "strLit", value: access.name.text, type: STRING, loc },
        type: DYN,
        loc,
      };
      if (call.arguments.nodes.some(ts.isSpreadElement)) {
        lowerer.unsupported("SC1090", call, "spread arguments in callable property calls");
      }
      return {
        kind: "seqExpr",
        stmts: [{ kind: "varDecl", localId: local.id, init: boxed, loc }],
        result: {
          kind: "dynCall",
          callee: member,
          receiver,
          calleeName: ts.getTextOfNode(access),
          args: call.arguments.nodes.map((arg) => lowerer.lowerExprExpecting(arg, DYN)),
          type: DYN,
          loc,
        },
        type: DYN,
        loc,
      };
    }
    if (probed?.type.kind === "classval") {
      const info = lowerer.classes.get(probed.type.className);
      if (info) return lowerStaticMethodCall(lowerer, call, access);
    }
    // A possibly missing element of a class-typed array (`items[i]`) is
    // the receiver's class or undefined. The class method call checks for
    // undefined itself, as it does in TypeScript.
    const presentArm =
      probed?.type.kind === "union" ? lowerer.stripUndefinedArm(probed.type) : null;
    if (presentArm?.kind === "object" && typeEquals(presentArm, lowerer.mapTypeOf(recvTs) ?? DYN))
      return null;
    if (
      probed?.type.kind === "union" &&
      isJsSourceFile(ts.getSourceFileOfNode(call)) &&
      lowerer.unions
        .get(probed.type.unionId)
        ?.arms.every(
          (arm) =>
            isUnitType(arm) ||
            arm.kind === "object" ||
            arm.kind === "record" ||
            arm.kind === "func",
        ) &&
      lowerer.dynConvertible(probed.type)
    ) {
      recv = lowerer.coerceToExpected(probed, DYN);
    } else {
      if (probed?.type.kind !== "dyn") return null;
      recv = probed;
    }
  }
  // A factory may return a constructor more precise than its inferred
  // checker result. Runtime static members live on that constructor.
  if (recv.type.kind === "classval") {
    const info = lowerer.classes.get(recv.type.className);
    if (info) return lowerStaticMethodCall(lowerer, call, access);
  }
  // A checker-`any` receiver that already lowered to a real STRING (the
  // chained form — `cfg.host.trim().toLowerCase()`, where the first step
  // extracted): no validation needed, ride the string tables directly.
  if (recv.type.kind === "union" && lowerer.stripUndefinedArm(recv.type).kind === "string") {
    const present = lowerer.runtimeOptionalPropertyReceiver(
      access.expression,
      recv,
      STRING,
      access.name.text,
    );
    if (present) recv = present;
  }
  if (recv.type.kind === "string") {
    return (
      lowerRegexMethodCall(lowerer, call, access, () => recv) ??
      lowerStringMethodCall(lowerer, call, access, () => recv)
    );
  }
  // A checker-untyped JS binding holding `string | undefined` (string-
  // width's `const visibleSegment = baseVisible(segment)` after an
  // `=== undefined` guard the checker cannot see through): no typed
  // lowering claims the union, so a String method boxes it and takes the
  // dyn receiver path, whose undefined/null arms throw Node's read errors.
  if (
    checkerUntyped &&
    recv.type.kind === "union" &&
    isJsSourceFile(ts.getSourceFileOfNode(call)) &&
    isStringMethodName(access.name.text) &&
    lowerer.unions
      .get(recv.type.unionId)
      ?.arms.every((arm) => arm.kind === "string" || isUnitType(arm)) === true &&
    lowerer.dynConvertible(recv.type)
  ) {
    recv = lowerer.coerceToExpected(recv, DYN);
  }
  // A native handle read through `as any` (`(hash as any).update(x)`)
  // dispatches through the handle, as the same value held in an
  // 'unknown' slot does.
  if (checkerUntyped && DYN_HANDLE_KINDS.has(recv.type.kind))
    recv = lowerer.coerceToExpected(recv, DYN);
  // A typed array whose checker type collapsed to `any` (a JS binding
  // referenced in its own initializer's inference — hono's etag digest
  // `const nextChunk = new Uint8Array(new ArrayBuffer(f(chunk)))` beside
  // `chunk = nextChunk`) still lowered to its native bytes. The typed
  // lowerings key on the checker type and decline it, so it boxes by
  // reference (the box shares the native storage, so writes through the
  // call stay visible) and the call dispatches on the runtime kind.
  if (checkerUntyped && recv.type.kind === "bytes") recv = lowerer.coerceToExpected(recv, DYN);
  // The last-resort retry (boxTypedTemporary — every other lowering
  // already declined): a checker-`any` receiver whose value is a FRESH
  // typed result of an earlier step in the chain (`out.split("\n")`
  // extracted the string and answered a native string[]) has no typed
  // home under its `any` spelling, so it boxes into the checked-dynamic
  // tree and the call dispatches on the runtime kind — `.map`, `.pop`,
  // `.filter` on that array run JS-exact. Only call results qualify:
  // the box copies, and a temporary has no other holder to observe it.
  if (
    boxTypedTemporary &&
    checkerUntyped &&
    recv.type.kind !== "dyn" &&
    isFreshCallResult(access.expression) &&
    lowerer.dynConvertible(recv.type)
  )
    recv = lowerer.coerceToExpected(recv, DYN);
  if (recv.type.kind !== "dyn") return null;
  if (
    access.name.text === "normalize" &&
    call.arguments.nodes.length <= 1 &&
    !call.arguments.nodes.some(ts.isSpreadElement)
  ) {
    const loc = locOf(call);
    const hasArgument = call.arguments.nodes.length === 1;
    const name = `%dyn.string.normalize:${hasArgument ? 1 : 0}`;
    if (!lowerer.liftedFns.some((fn) => fn.name === name)) {
      const value = varRef("receiver", DYN, loc);
      const argument = varRef("form", DYN, loc);
      const form: IrExpr = {
        kind: "ternary",
        cond: { kind: "dynTest", value: argument, test: "undefined", type: BOOL, loc },
        then: { kind: "strLit", value: "NFC", type: STRING, loc },
        else_: { kind: "libCall", fn: "dyn.toStringCoerce", args: [argument], type: STRING, loc },
        type: STRING,
        loc,
      };
      const result: IrExpr = {
        kind: "strIntrinsic",
        method: "normalize",
        receiver: { kind: "dynCheck", value, type: STRING, loc },
        args: [form],
        type: STRING,
        loc,
      };
      lowerer.liftedFns.push({
        name,
        params: [
          { localId: "receiver", name: "receiver", type: DYN },
          { localId: "form", name: "form", type: DYN },
        ],
        locals: [
          { id: "receiver", name: "receiver", type: DYN, mutable: false },
          { id: "form", name: "form", type: DYN, mutable: false },
        ],
        returnType: DYN,
        loc,
        body: [
          {
            kind: "if",
            cond: { kind: "dynTest", value, test: "string", type: BOOL, loc },
            then: [
              { kind: "return", value: { kind: "dynFrom", value: result, type: DYN, loc }, loc },
            ],
            else_: null,
            loc,
          },
          {
            kind: "return",
            value: {
              kind: "dynInvoke",
              recv: value,
              method: "normalize",
              calleeName: ts.getTextOfNode(access),
              args: hasArgument ? [argument] : [],
              type: DYN,
              loc,
            },
            loc,
          },
        ],
      });
    }
    return {
      kind: "call",
      callee: name,
      args: [
        recv,
        call.arguments.nodes[0]
          ? lowerer.lowerExprExpecting(call.arguments.nodes[0], DYN)
          : dynUndefinedExpr(loc),
      ],
      type: DYN,
      loc,
    };
  }
  if (lowerer.mapTypeOf(recvTs)?.kind === "classval") {
    return lowerStaticMethodCall(lowerer, call, access);
  }
  const ownCallable =
    !checkerUntyped &&
    (() => {
      const prop = lowerer.checker.getPropertyOfType(recvTs, access.name.text);
      if (prop === undefined) return false;
      // getPropertyOfType includes inherited Object.prototype members.
      // Those are not stored members of a checked-dynamic object, so
      // dynKeyGet cannot stand in for JavaScript's prototype lookup. Only
      // an authored declaration can justify the own-member path.
      const authored = prop.declarations.some(
        (decl) => !lowerer.isStdlibFile(ts.getSourceFileOfNode(decl)),
      );
      return (
        authored &&
        lowerer.checker.getCallSignatures(lowerer.checker.getTypeOfSymbol(prop)).length > 0
      );
    })();
  // Typed-destination filter first (validated extraction into a real
  // T[]); an untyped destination falls through to the runtime dispatch
  // below (the survivors stay dyn values).
  if (access.name.text === "filter") {
    const extracted = lowerDynArrayFilterCall(lowerer, call, access, recv);
    if (extracted) return extracted;
  }
  if (access.name.text === "flatMap") return lowerDynArrayFlatMapCall(lowerer, call, access, recv);
  // String methods claim only names NO other dyn-representable kind's
  // prototype declares (Array carries includes/indexOf/slice too), so no
  // other kind inherits them. Shared names would need a receiver-kind
  // dispatch — they keep the fence.
  if (DYN_STRING_ONLY_METHODS.has(access.name.text) && !ownCallable) {
    // A checked-dynamic object can still carry its OWN member of that
    // name: zod's schemas assign `trim`, `toLowerCase` and `startsWith`
    // in their constructors (`z.string().trim().min(1)`), an object's
    // prototype can define `trim`, and a JavaScript module object can
    // assign `repeat` in a function body (`common.repeat(" ", n)`, an
    // object-typed receiver the member is missing from). An untyped
    // receiver, or a member the checker cannot type, dispatches on the
    // receiver's runtime kind: a string runs the string lowering, anything
    // else calls its member as Node does.
    if (
      (checkerUntyped ||
        (lowerer.typeOf(access).flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) &&
      !call.questionDotToken &&
      !access.questionDotToken &&
      !call.arguments.nodes.some(ts.isSpreadElement)
    )
      return lowerStringOrMemberCall(lowerer, call, access, recv);
    const checked = (): IrExpr => dynStringReceiver(lowerer, recv, access);
    return (
      lowerRegexMethodCall(lowerer, call, access, checked) ??
      lowerStringMethodCall(lowerer, call, access, checked)
    );
  }
  // String/Number methods the runtime dispatch has no answer for
  // (codePointAt, substr, toLocaleLowerCase, toPrecision, ...): a string
  // or number receiver runs the typed lowering, every other kind keeps the
  // runtime dispatch.
  if (
    !ownCallable &&
    !call.questionDotToken &&
    !access.questionDotToken &&
    isDynPrimitiveKindMethod(access.name.text) &&
    !lowerer.chainBlocked(access, call)
  ) {
    const primitive = lowerDynPrimitiveMethodCall(
      lowerer,
      call,
      access.name.text,
      ts.getTextOfNode(access),
      recv,
    );
    if (primitive) return primitive;
  }
  // The argument is a radix for bigint and an encoding for Buffer.
  // Preserve its runtime value so receiver dispatch can choose correctly.
  // An authored own `toString` member (zod's `errorUtil.toString`, which
  // answers string | undefined) is an ordinary method call instead.
  if (
    access.name.text === "toString" &&
    call.arguments.nodes.length <= 1 &&
    !ownCallable &&
    !(checkerUntyped && jsAssignsOwnToString(lowerer, access.expression))
  ) {
    const argument = call.arguments.nodes[0];
    return {
      kind: "libCall",
      fn: "dyn.toString",
      args: [
        recv,
        argument ? lowerer.lowerExprExpecting(argument, DYN) : dynUndefinedExpr(locOf(call)),
        { kind: "strLit", value: ts.getTextOfNode(access), type: STRING, loc: locOf(call) },
      ],
      type: STRING,
      loc: locOf(call),
    };
  }
  // Every dyn kind's prototype chain declares valueOf, and the runtime
  // answers each kind's own: primitives and plain objects themselves, a
  // Date its time value, an own or inherited valueOf member its result.
  if (access.name.text === "valueOf" && call.arguments.nodes.length === 0) {
    const webAssembly = lowerWebAssemblyValueOf(lowerer, access.expression, recv, locOf(call));
    if (webAssembly !== null) return webAssembly;
    return {
      kind: "libCall",
      fn: "dyn.valueOf",
      args: [
        recv,
        { kind: "strLit", value: ts.getTextOfNode(access), type: STRING, loc: locOf(call) },
      ],
      type: DYN,
      loc: locOf(call),
    };
  }
  // SHARED prototype names with a runtime dispatch (scr_dyn_invoke):
  // push/slice/join/forEach/map/apply/... dispatch on the receiver's
  // RUNTIME kind — the honest answer for names more than one dyn-
  // representable prototype declares (test/common's mustCall internals:
  // mustCallChecks.push(context), failed.forEach(fn), fn.apply(this,
  // args)). Implemented (kind, name) pairs run JS-exact; real-but-
  // unimplemented methods throw the 'not supported yet' Error; names the
  // kind's prototype lacks throw Node's "x.y is not a function"; OBJ
  // receivers call the own member.
  // A stored callback must be read before argument effects, and called
  // with the original receiver rather than a materialized property view.
  const callbackProperty = (() => {
    const prop = lowerer.checker.getPropertyOfType(recvTs, access.name.text);
    const mapped = lowerer.mapTypeOf(recvTs);
    if (
      mapped?.kind === "union" &&
      lowerer.unions
        .get(mapped.unionId)
        ?.arms.every(
          (arm) =>
            arm.kind === "object" &&
            lowerer.classes.get(arm.className)?.fields.has(access.name.text),
        )
    )
      return true;
    // A standard-library member spelled as a function-typed property
    // (undici-types declares Headers.append/forEach/... and the body mixin
    // as `readonly append: (...) => void`; scriptc's own declarations use
    // methods) is still the handle's native method: it takes the shared
    // receiver dispatch below either way (which also calls a plain object's
    // own member), so the lowering does not depend on which declaration
    // file supplies the type.
    const libMethod =
      prop !== undefined &&
      prop.declarations.length > 0 &&
      prop.declarations.every((decl) => lowerer.isStdlibFile(decl.getSourceFile()));
    return (
      prop !== undefined &&
      !libMethod &&
      prop.declarations.some(
        (decl) => ts.isPropertyDeclaration(decl) || ts.isPropertySignature(decl),
      )
    );
  })();
  // Protocol methods keep their static signature: instances of the
  // implementing classes call the native method.
  const protocolCall =
    !callbackProperty && lowerer.classImplementedProtocol(recvTs)
      ? lowerProtocolMethodCall(lowerer, call, access, recv)
      : null;
  if (protocolCall) return protocolCall;
  const dispatched = callbackProperty
    ? null
    : lowerDynDispatchMethodCall(lowerer, call, access, recv, arrayReceiver);
  if (dispatched) return dispatched;
  // Names NO dyn-representable prototype declares: the member can only
  // be an OWN property, so "read the member, call it" IS Node's
  // semantics for every possible dyn value — `handlers.onDone(x)` on a
  // checked-dynamic object calls the stored function (dynKeyGet answers
  // the member or undefined; dynCall throws Node's exact catchable
  // "handlers.onDone is not a function" on a non-function). Prototype
  // names (map/join/hasOwnProperty/call/...) keep the fence: on a real
  // dyn array/string/object Node would run the METHOD, which no stored
  // member models. Order note: JS reads the callee before evaluating
  // arguments — dynKeyGet's undefined-receiver TypeError fires first,
  // exactly Node.
  // A checker-typed object whose represented value remains dyn still
  // has an authored own-member contract. Let that member win even when
  // its name overlaps a primitive prototype (`colors.bold(...)`): the
  // source value was compiled from that object shape, while genuinely
  // untyped/any receivers retain the runtime-kind ambiguity and fence.
  // A name only String.prototype declares (`bold`, `italics`, `link`,
  // ...) on a checker-untyped receiver: every other dyn kind answers its
  // own or inherited member exactly like a non-prototype name (chalk's
  // `chalk.red.bold(...)` reads a prototype getter of a function), so
  // only a string receiver keeps the refusal, deferred to run time.
  // The same holds when only the MEMBER is checker-untyped: TypeScript
  // importing chalk's JavaScript source types the default export as a
  // plain function, so `chalk.bold` reads as `any` on a typed receiver.
  const ownToString =
    access.name.text === "toString" &&
    checkerUntyped &&
    jsAssignsOwnToString(lowerer, access.expression);
  const stringOnlyName =
    (checkerUntyped ||
      (lowerer.typeOf(access).flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) &&
    !ownCallable &&
    DYN_STRING_PROTO_ONLY_NAMES.has(access.name.text);
  if (
    DYN_PROTO_METHOD_NAMES.has(access.name.text) &&
    !ownCallable &&
    !ownToString &&
    !stringOnlyName
  )
    return null;
  // Optional forms (`obj.cb?.()`, `obj?.cb()`) belong to the chain
  // machinery's short-circuit semantics — not modeled here yet.
  if (call.questionDotToken || access.questionDotToken) return null;
  const loc = locOf(call);
  const receiverLocal = lowerer.declareHiddenLocal("%dynCallReceiver", DYN);
  const receiver: IrExpr = { kind: "varRef", localId: receiverLocal.id, type: DYN, loc };
  // The string refusal throws in place of the member read (a seqExpr
  // statement cannot leave the expression).
  const stringRefusal = (read: IrExpr): IrExpr => {
    if (!stringOnlyName) return read;
    const sf = ts.getSourceFileOfNode(call);
    const line = ts.getLineAndCharacterOfPosition(sf, ts.tokenStartOfNode(call)).line + 1;
    return {
      kind: "ternary",
      cond: { kind: "dynTest", test: "string", value: receiver, type: BOOL, loc },
      then: nodeThrowExpr(
        0,
        "SC1090",
        `method calls like '${ts.getTextOfNode(access)}' on a string are not supported yet [SC1090 at ${sf.fileName}:${line}]`,
        DYN,
        loc,
      ),
      else_: read,
      type: DYN,
      loc,
    };
  };
  const member: IrExpr = {
    kind: "dynKeyGet",
    key: { kind: "strLit", value: access.name.text, type: STRING, loc: locOf(access) },
    value: receiver,
    type: DYN,
    loc: locOf(access),
  };
  const calleeLocal = lowerer.declareHiddenLocal("%dynCallCallee", DYN);
  const callee = varRef(calleeLocal.id, DYN, loc);
  const stmts: IrStmt[] = [
    { kind: "varDecl", localId: receiverLocal.id, init: recv, loc },
    { kind: "varDecl", localId: calleeLocal.id, init: stringRefusal(member), loc },
  ];
  if (call.arguments.nodes.some(ts.isSpreadElement)) {
    const spread = lowerSpreadArgsCall(lowerer, call, callee, loc);
    if (spread?.kind === "dynCall")
      return { kind: "seqExpr", stmts, result: { ...spread, receiver }, type: DYN, loc };
    lowerer.unsupported("SC1090", call, "spread arguments in calls through 'unknown' values");
  }
  const args = call.arguments.nodes.map((a) => lowerer.lowerExprExpecting(a, DYN));
  return {
    kind: "seqExpr",
    stmts,
    result: {
      kind: "dynCall",
      callee,
      receiver,
      calleeName: ts.getTextOfNode(access),
      args,
      type: DYN,
      loc,
    },
    type: DYN,
    loc,
  };
}

/** `value.name(...args)` on a dyn receiver that may be a string or an
 * object: a string runs the String.prototype lowering, any other value
 * calls its member. The member is read before the arguments are
 * evaluated, and the arguments are evaluated once for either branch. */
function lowerStringOrMemberCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
  recv: IrExpr,
): IrExpr {
  const loc = locOf(call);
  const receiverLocal = lowerer.declareHiddenLocal("%dynCallReceiver", DYN);
  const receiver = varRef(receiverLocal.id, DYN, loc);
  const isString: IrExpr = { kind: "dynTest", test: "string", value: receiver, type: BOOL, loc };
  const calleeLocal = lowerer.declareHiddenLocal("%dynCallCallee", DYN);
  const callee = varRef(calleeLocal.id, DYN, loc);
  const stmts: IrStmt[] = [
    { kind: "varDecl", localId: receiverLocal.id, init: recv, loc },
    {
      kind: "varDecl",
      localId: calleeLocal.id,
      init: {
        kind: "ternary",
        cond: isString,
        then: dynUndefinedExpr(loc),
        else_: {
          kind: "dynKeyGet",
          key: { kind: "strLit", value: access.name.text, type: STRING, loc: locOf(access) },
          value: receiver,
          type: DYN,
          loc: locOf(access),
        },
        type: DYN,
        loc,
      },
      loc,
    },
  ];
  const args = call.arguments.nodes.map((node) => {
    const value = lowerer.lowerExpr(node);
    const local = lowerer.declareHiddenLocal("%dynCallArg", value.type);
    stmts.push({ kind: "varDecl", localId: local.id, init: value, loc: value.loc });
    return { node, value: varRef(local.id, value.type, value.loc) };
  });
  // String.prototype methods ignore arguments past the ones they read.
  const arity = DYN_STRING_ONLY_ARITY[access.name.text] ?? call.arguments.nodes.length;
  const stringReceiver = (): IrExpr => ({ kind: "dynCheck", value: receiver, type: STRING, loc });
  const lowerString = (): IrExpr | null =>
    (call.arguments.nodes.length <= arity
      ? lowerRegexMethodCall(lowerer, call, access, stringReceiver)
      : null) ??
    lowerStringMethodCall(
      lowerer,
      call,
      access,
      stringReceiver,
      call.arguments.nodes.slice(0, arity),
    );
  const stringCall = lowerer.withExpressionOverrides(args, lowerString);
  const memberCall: IrExpr = {
    kind: "dynCall",
    callee,
    receiver,
    calleeName: ts.getTextOfNode(access),
    args: args.map((arg) => lowerer.coerceToExpected(arg.value, DYN)),
    type: DYN,
    loc,
  };
  return {
    kind: "seqExpr",
    stmts,
    result: {
      kind: "ternary",
      cond: isString,
      then: stringCall
        ? lowerer.coerceToExpected(stringCall, DYN)
        : nodeThrowExpr(
            0,
            "SC1090",
            `method calls like '${ts.getTextOfNode(access)}' on a string are not supported yet [SC1090 at ${ts.getSourceFileOfNode(call).fileName}:${ts.getLineAndCharacterOfPosition(ts.getSourceFileOfNode(call), ts.tokenStartOfNode(call)).line + 1}]`,
            DYN,
            loc,
          ),
      else_: memberCall,
      type: DYN,
      loc,
    },
    type: DYN,
    loc,
  };
}

/** Prototype method names of the checked-dynamic tree-representable kinds (String, Array,
 * Object, Function, Number prototypes): a dyn receiver call on one of
 * these could be a REAL method on a real value, which a stored-member
 * read would answer incorrectly — they keep the fence. Everything else
 * is own-property-or-throw for every dyn value (the honest dynCall). */
const DYN_PROTO_METHOD_NAMES = new Set([
  // Object.prototype
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toLocaleString",
  "toString",
  "valueOf",
  // Function.prototype
  "apply",
  "bind",
  "call",
  // Array.prototype (less the dyn-claimed filter/flatMap — still listed:
  // the claim above runs first)
  "at",
  "concat",
  "copyWithin",
  "entries",
  "every",
  "fill",
  "filter",
  "find",
  "findIndex",
  "findLast",
  "findLastIndex",
  "flat",
  "flatMap",
  "forEach",
  "includes",
  "indexOf",
  "join",
  "keys",
  "lastIndexOf",
  "map",
  "pop",
  "push",
  "reduce",
  "reduceRight",
  "reverse",
  "shift",
  "slice",
  "some",
  "sort",
  "splice",
  "toReversed",
  "toSorted",
  "toSpliced",
  "unshift",
  "values",
  "with",
  // String.prototype (the shared-name remainder — the string-only set
  // was claimed above)
  "anchor",
  "big",
  "blink",
  "bold",
  "codePointAt",
  "fixed",
  "fontcolor",
  "fontsize",
  "isWellFormed",
  "italics",
  "link",
  "localeCompare",
  "normalize",
  "small",
  "strike",
  "sub",
  "sup",
  "toLocaleLowerCase",
  "toLocaleUpperCase",
  "toWellFormed",
  // Number.prototype
  "toExponential",
  "toFixed",
  "toPrecision",
]);

/** The DYN_PROTO_METHOD_NAMES that only String.prototype declares among
 * the dyn-representable kinds' prototypes. */
const DYN_STRING_PROTO_ONLY_NAMES = new Set([
  "anchor",
  "big",
  "blink",
  "bold",
  "codePointAt",
  "fixed",
  "fontcolor",
  "fontsize",
  "isWellFormed",
  "italics",
  "link",
  "localeCompare",
  "normalize",
  "small",
  "strike",
  "sub",
  "sup",
  "toLocaleLowerCase",
  "toLocaleUpperCase",
  "toWellFormed",
]);

/** The SHARED prototype names scr_dyn_invoke dispatches at runtime (the
 * subset of DYN_PROTO_METHOD_NAMES with a receiver-kind dispatch): the
 * runtime runs the real method for the receiver's kind, throws Node's
 * is-not-a-function where the kind's prototype lacks the name, and
 * throws the 'not supported yet' Error on real-but-unimplemented pairs. */
const DYN_DISPATCH_METHODS = new Set([
  "toFixed",
  "toExponential",
  "segment",
  "containing",
  "resolvedOptions",
  "test",
  "exec",
  "apply",
  "bind",
  "call",
  "push",
  "pop",
  "shift",
  "unshift",
  "slice",
  "splice",
  "at",
  "indexOf",
  "lastIndexOf",
  "includes",
  "join",
  "concat",
  "reverse",
  "sort",
  "forEach",
  "map",
  "filter",
  "some",
  "every",
  "find",
  "findIndex",
  // The native-handle receiver surface (SCR_DYN_HANDLE — req/res/socket
  // boxed through the checked-dynamic boundary): these names dispatch on
  // the runtime kind so a boxed IncomingMessage/ServerResponse/Socket
  // routes onto the same entry points the static lowerings use (modeled
  // members) or the 'not supported yet' error path (real-but-unmodeled ones).
  // On every other dyn kind they answer exactly what the stored-member
  // path answered (OBJ own members call; the rest throw Node's
  // is-not-a-function).
  "on",
  "once",
  "addListener",
  "removeListener",
  "off",
  "removeAllListeners",
  "emit",
  "prependListener",
  "prependOnceListener",
  "listeners",
  "listenerCount",
  // The rest of EventEmitter.prototype, which compiled emitters answer
  // through the class dispatch (class-dynamic-dispatch.ts).
  "rawListeners",
  "eventNames",
  "setMaxListeners",
  "getMaxListeners",
  "write",
  "end",
  "destroy",
  "pipe",
  "unpipe",
  "resume",
  "pause",
  "setEncoding",
  "setDefaultEncoding",
  "setTimeout",
  "read",
  "isPaused",
  "writeHead",
  "setHeader",
  "getHeader",
  "hasHeader",
  "removeHeader",
  "getHeaders",
  "getHeaderNames",
  "appendHeader",
  "flushHeaders",
  "add",
  "append",
  "delete",
  "get",
  "getSetCookie",
  "has",
  "set",
  "clear",
  "keys",
  "values",
  "entries",
  "next",
  "writeContinue",
  "writeEarlyHints",
  "cork",
  "uncork",
  "addTrailers",
  "ref",
  "unref",
  "address",
  "setNoDelay",
  "setKeepAlive",
  "connect",
  "resetAndDestroy",
  "destroySoon",
  // The Agent handle's own member (no other dyn prototype declares it,
  // so the remainder keeps the stored-member answers).
  "getName",
  // The netServer half of the handle surface (`let server; server =
  // createServer(...)` — the handle lives in a dyn binding whose
  // closures the checker cannot narrow): listen/close dispatch onto the
  // server ops; no other dyn prototype declares either name, so the
  // remainder keeps the stored-member answers.
  "listen",
  "close",
  // The native WHATWG readable-stream and AbortSignal handles used by
  // static fetch. These route through SCR_DYN_HANDLE dispatch just like
  // the http/net names above.
  "getReader",
  "cancel",
  "releaseLock",
  "enqueue",
  "error",
  "throwIfAborted",
  "addEventListener",
  "removeEventListener",
  "dispatchEvent",
  "preventDefault",
  "stopPropagation",
  "stopImmediatePropagation",
  "composedPath",
  "json",
  "text",
  "bytes",
  "arrayBuffer",
  // Promise.prototype (SCR_DYN_PROMISE receivers): the reaction trio
  // rides the fiber machinery (scr_dyn_promise_then); on every other dyn
  // kind then/catch/finally answer the stored-member path (OBJ own
  // members call, the rest throw Node's is-not-a-function).
  "then",
  "catch",
  "finally",
  // The h2 session/stream half (SCR_DYNH_H2_SESSION/STREAM — boxed
  // through a mustCall-wrapped listener's parameter): request/respond
  // and the stream/session methods dispatch onto the http2 ops. Names
  // shared with the http/net surface (write/end/close/on/...) are
  // already above; these are the h2-only additions.
  "respond",
  "respondWithFile",
  "respondWithFD",
  "pushStream",
  "request",
  "sendTrailers",
  "priority",
  "settings",
  "goaway",
  "ping",
  "additionalHeaders",
  "altsvc",
  "origin",
  // FinalizationRegistry's methods (scr_finalization_registry_new).
  "register",
  "unregister",
  // Worker and MessagePort methods use the owning context's handle adapter.
  "postMessage",
  "terminate",
  "start",
  "hasRef",
]);

export function lowerDynDispatchMethodCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
  recv: IrExpr,
  arrayReceiver: boolean,
): IrExpr | null {
  const method = access.name.text;
  if (
    (!DYN_DISPATCH_METHODS.has(method) && !isJsSourceFile(ts.getSourceFileOfNode(call))) ||
    lowerer.chainBlocked(call, access)
  )
    return null;
  // readable.compose lowers its stages from their syntax, so it needs the
  // stream's class: a stream a JavaScript function returns untyped has none.
  if (method === "compose") {
    const recvT = lowerer.mapTypeOf(lowerer.typeOf(access.expression));
    if (
      recvT?.kind === "object" &&
      streamSidesOf(lowerer, lowerer.classes.get(recvT.className)) !== null
    ) {
      lowerer.noLowering(
        "readable.compose on a stream held as a checked-dynamic value",
        call,
        "type the stream where it comes from, such as a JSDoc @returns {Readable} on the function that returns it",
      );
    }
  }
  if (call.arguments.nodes.some((arg) => ts.isSpreadElement(arg))) {
    const loc = locOf(call);
    const local = lowerer.declareHiddenLocal("%spreadReceiver", DYN);
    const receiver = varRef(local.id, DYN, loc);
    const callee: IrExpr = {
      kind: "dynKeyGet",
      value: receiver,
      key: { kind: "strLit", value: method, type: STRING, loc },
      type: DYN,
      loc,
    };
    const spread = lowerSpreadArgsCall(lowerer, call, callee, loc);
    if (spread?.kind === "dynCall")
      return {
        kind: "seqExpr",
        stmts: [
          { kind: "varDecl", localId: local.id, init: recv, loc },
          {
            kind: "exprStmt",
            expr: { kind: "libCall", fn: "dyn.arrayPrototype", args: [], type: DYN, loc },
            loc,
          },
        ],
        result: { ...spread, receiver },
        type: DYN,
        loc,
      };
    lowerer.unsupported("SC1090", call, "spread arguments in calls through 'unknown' values");
  }
  const predicate =
    method === "filter" && call.arguments.nodes[0]
      ? lowerer.lowerExpr(call.arguments.nodes[0])
      : null;
  if (arrayReceiver && predicate?.type.kind === "func" && predicate.type.ret.kind === "void") {
    lowerer.unsupported(
      "SC1090",
      call.arguments.nodes[0]!,
      "'.filter()' with a void-returning predicate (the callback return value is erased before its truthiness can be tested)",
    );
  }
  // A dynamic argument array consumed immediately by the fixed-arity arrow
  // apply lowering below never exposes its surplus tail. Keep a pushed
  // static-only value's evaluation and the array length mutation, but store
  // undefined in that unobserved slot so no impossible dyn conversion is
  // invented. If the slot falls inside the typed prefix, its dynCheck fails
  // at the callback boundary; valid callers preserve the original prefix.
  if (
    method === "push" &&
    call.arguments.nodes.length === 1 &&
    ts.isIdentifier(access.expression) &&
    ts.isExpressionStatement(call.parent) &&
    ts.isBlock(call.parent.parent)
  ) {
    const receiverSymbol = lowerer.checker.getSymbolAtLocation(access.expression);
    const block = call.parent.parent;
    const statementIndex = block.statements.nodes.indexOf(call.parent);
    const next = statementIndex >= 0 ? block.statements.nodes[statementIndex + 1] : undefined;
    let returned = next && ts.isReturnStatement(next) ? next.expression : undefined;
    while (returned && ts.isParenthesizedExpression(returned)) returned = returned.expression;
    const apply =
      returned &&
      ts.isCallExpression(returned) &&
      ts.isPropertyAccessExpression(returned.expression) &&
      returned.expression.name.text === "apply"
        ? returned
        : null;
    const argsNode = apply?.arguments?.nodes[1];
    const sameArgs =
      receiverSymbol !== undefined &&
      argsNode !== undefined &&
      ts.isIdentifier(argsNode) &&
      lowerer.checker.getSymbolAtLocation(argsNode) === receiverSymbol;
    const applyAccess =
      apply && ts.isPropertyAccessExpression(apply.expression) ? apply.expression : null;
    const applyTarget = applyAccess?.expression;
    const arrow = applyTarget ? arrowSignatureOf(lowerer, applyTarget) : null;
    const target =
      applyTarget && ts.isIdentifier(applyTarget) ? lowerer.peekLocal(applyTarget) : null;
    const targetParams =
      target?.type.kind === "func" && target.type.rest !== true ? target.type.params : null;
    if (
      sameArgs &&
      arrow !== null &&
      targetParams !== null &&
      targetParams.every((param) =>
        canDynCheckTo(
          param,
          (id) => lowerer.shapes.get(id),
          (id) => lowerer.unions.get(id),
        ),
      )
    ) {
      const value = lowerer.lowerExpr(call.arguments.nodes[0]!);
      if (value.type.kind !== "dyn" && !lowerer.dynConvertible(value.type)) {
        const saved = lowerer.declareHiddenLocal("%applyTail", DYN);
        return {
          kind: "seqExpr",
          stmts: [
            { kind: "varDecl", localId: saved.id, init: recv, loc: locOf(access.expression) },
            { kind: "exprStmt", expr: value, loc: value.loc },
          ],
          result: {
            kind: "dynInvoke",
            recv: { kind: "varRef", localId: saved.id, type: DYN, loc: locOf(access.expression) },
            method,
            calleeName: ts.getTextOfNode(access),
            args: [dynUndefinedExpr(locOf(call.arguments.nodes[0]!))],
            type: DYN,
            loc: locOf(call),
          },
          type: DYN,
          loc: locOf(call),
        };
      }
    }
  }
  // `String`, `Number` or `Boolean` as the callback of an array method
  // (`values.map(String)` over an unknown array): the method calls it with
  // each element, whatever its type, and cannot observe which function
  // value it received, so it gets the constructor's form that converts any
  // argument rather than the string-input form typed code stores.
  const arrayCallbackReceiver =
    ARRAY_CALLBACK_METHODS.has(method) &&
    lowerer.checker.isArrayType(lowerer.typeOf(access.expression));
  const args = call.arguments.nodes.map((arg, i) => {
    const primitive =
      i === 0 && arrayCallbackReceiver && ts.isIdentifier(arg)
        ? stdlibGlobalNameOf(lowerer, arg)
        : null;
    if (primitive === "String" || primitive === "Number" || primitive === "Boolean")
      return lowerer.coerceInto(
        arg,
        primitiveCtorClosure(lowerer, primitive, locOf(arg), true),
        DYN,
      );
    if (i === 0 && predicate) return lowerer.coerceInto(arg, predicate, DYN);
    const undefinedArg = lowerStaticallyUndefinedArgument(lowerer, arg);
    return undefinedArg
      ? defaultAfterUndefined(undefinedArg, dynUndefinedExpr(locOf(arg)))
      : lowerer.lowerExprExpecting(arg, DYN);
  });
  return {
    kind: "dynInvoke",
    recv,
    method,
    calleeName: ts.getTextOfNode(access),
    args,
    type: DYN,
    loc: locOf(call),
  };
}

/** Array.prototype methods whose first argument is a callback they call
 * with the elements. */
const ARRAY_CALLBACK_METHODS = new Set([
  "map",
  "filter",
  "forEach",
  "some",
  "every",
  "find",
  "findIndex",
  "findLast",
  "findLastIndex",
  "flatMap",
]);

/** Every String.prototype method name a typed or dyn string lowering
 * answers. */
function isStringMethodName(name: string): boolean {
  return (
    Object.hasOwn(STR_METHODS, name) ||
    STRING_INDEX_METHODS.has(name) ||
    DYN_STRING_ONLY_METHODS.has(name) ||
    isDynPrimitiveKindMethod(name) ||
    name === "normalize" ||
    name === "lastIndexOf"
  );
}

/** How many arguments each DYN_STRING_ONLY_METHODS method reads. */
const DYN_STRING_ONLY_ARITY: Readonly<Record<string, number>> = {
  charCodeAt: 1,
  charAt: 1,
  startsWith: 2,
  endsWith: 2,
  substring: 2,
  repeat: 1,
  trim: 0,
  trimStart: 0,
  trimEnd: 0,
  split: 2,
  padStart: 2,
  padEnd: 2,
  toLowerCase: 0,
  toUpperCase: 0,
  replace: 2,
  replaceAll: 2,
  match: 1,
  matchAll: 1,
  search: 1,
};

/** STR_METHODS ∪ the regex-form names, MINUS everything Array (or any
 * other dyn kind's prototype) also declares. */
const DYN_STRING_ONLY_METHODS = new Set([
  "charCodeAt",
  "charAt",
  "startsWith",
  "endsWith",
  "substring",
  "repeat",
  "trim",
  "trimStart",
  "trimEnd",
  "split",
  "padStart",
  "padEnd",
  "toLowerCase",
  "toUpperCase",
  "replace",
  "replaceAll",
  "match",
  "matchAll",
  "search",
]);

/** `Array.isArray(v)` — a real runtime test on `unknown` values (the checked-dynamic tree's
 * array kind: dyn arrays answer true, bytes/objects/scalars false — exactly
 * JS, Uint8Array included), a compile-time constant on statically-typed
 * ones (an `T[]` value IS an array, every other static kind is not; folded
 * only over side-effect-free reads, the `in`-operator discipline; unions
 * fence with the narrow-first hint). Null when the callee isn't THE
 * stdlib Array.isArray, so the chain keeps trying. */
function lowerArrayIsArrayCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (call.questionDotToken || access.questionDotToken) return null;
  if (lowerer.stdlibGlobalMember(access, "Array") !== "isArray") return null;
  if (call.arguments.nodes.length !== 1) return null; // the stdlib chokepoint fences
  const argNode = call.arguments.nodes[0]!;
  let arg = lowerer.lowerExpr(argNode);
  const loc = locOf(call);
  // A checker-narrowed dyn read arrives as a validated extraction (the
  // dynCheck bridge). The runtime value may be wider than the flow type
  // claims (an overload narrower than what arrives), so test the dyn value
  // itself instead of folding on the extracted type (typeof's rule).
  if (arg.kind === "dynCheck" && arg.value.type.kind === "dyn") arg = arg.value;
  if (arg.type.kind === "dyn") {
    return { kind: "dynTest", test: "array", value: arg, type: BOOL, loc };
  }
  if (arg.type.kind === "union") {
    // A union answers by its RUNTIME TAG: true iff the active arm is an
    // array value (homogeneous array or fixed tuple; bytes arms answer
    // false — Array.isArray(new Uint8Array) is false in JS too). One
    // array arm compiles to the plain tag test
    // (`Array.isArray(tlds)` on `string | readonly string[]` — the
    // narrowing test tsc's control flow then builds on); several array
    // arms OR their tag tests, and zero arms fold to false — both only
    // over side-effect-free reads. Opaque arms have no static tag answer
    // and keep the narrow-first fence.
    const unionId = arg.type.unionId;
    const def = lowerer.unions.get(unionId);
    const opaque = !def || def.arms.some((a) => a.kind === "dyn" || a.kind === "caught");
    const arrayTags = lowerer.arrayValueTags(arg.type.unionId);
    const freeRead = arg.kind === "varRef" || arg.kind === "recordGet" || arg.kind === "fieldGet";
    if (!opaque && arrayTags.length === 1) {
      return {
        kind: "unionIsTag",
        unionId: arg.type.unionId,
        tag: arrayTags[0]!,
        negated: false,
        value: arg,
        type: BOOL,
        loc,
      };
    }
    if (!opaque && freeRead && arrayTags.length === 0) {
      return { kind: "boolLit", value: false, type: BOOL, loc };
    }
    if (!opaque && freeRead && arrayTags.length > 1) {
      return arrayTags
        .map((tag): IrExpr => ({
          kind: "unionIsTag",
          unionId: unionId,
          tag,
          negated: false,
          value: arg,
          type: BOOL,
          loc,
        }))
        .reduce((left, right) => ({ kind: "logical", op: "||", left, right, type: BOOL, loc }));
    }
    lowerer.unsupported(
      "SC1090",
      argNode,
      `Array.isArray on '${lowerer.fmt(arg.type)}' values (narrow first: check a discriminant field, or compare with '!== undefined'/'!== null' for unit arms)`,
    );
  }
  if (arg.type.kind === "caught") return null;
  if (arg.kind === "varRef" || arg.kind === "recordGet" || arg.kind === "fieldGet") {
    return { kind: "boolLit", value: lowerer.isArrayValueType(arg.type), type: BOOL, loc };
  }
  lowerer.unsupported(
    "SC1090",
    call,
    "statically-decided Array.isArray on computed arguments (bind the value to a variable first)",
  );
}

/** Predicate declarations currently being inlined — re-entrancy guard
 * (a self-recursive guard body would otherwise inline forever). */
const inliningPredicates = new Set<ts.Symbol>();

/** `p(err)` where err is a CATCH BINDING and p a top-level type-guard
 * `(x: unknown) => x is T` whose body is a single `return <expr>;`: lowers
 * <expr> in the caller with the parameter aliased to the caught local.
 * Null when the callee isn't that shape (ordinary paths — and their
 * caught-argument fences — apply). */
function lowerCaughtPredicateCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  caughtLocal: IrLocal,
): IrExpr | null {
  if (call.questionDotToken) return null;
  const callee = call.expression;
  if (!ts.isIdentifier(callee)) return null;
  const symbol = lowerer.resolveValueSymbol(callee);
  const decl = symbol ? symbol.declarations.find(ts.isFunctionDeclaration) : undefined;
  if (!symbol || !decl || !decl.body) return null;
  if (!decl.type || !ts.isTypePredicateNode(decl.type)) return null;
  if (decl.parameters.nodes.length !== 1) return null;
  const param = decl.parameters.nodes[0]!;
  if (!ts.isIdentifier(param.name) || param.initializer || param.dotDotDotToken) return null;
  const paramSymbol = lowerer.checker.getSymbolAtLocation(param.name);
  if (!paramSymbol) return null;
  const ret = decl.body.statements.nodes.length === 1 ? decl.body.statements.nodes[0] : undefined;
  // A longer guard whose parameter is `unknown` (or `any`) takes the caught
  // value as an ordinary checked-dynamic argument: the call path converts
  // the binding, and the narrowed binding reads through the same value.
  if (
    (!ret || !ts.isReturnStatement(ret) || !ret.expression) &&
    lowerer.mapTypeOf(lowerer.checker.getTypeOfSymbol(paramSymbol))?.kind === "dyn"
  )
    return null;
  if (!ret || !ts.isReturnStatement(ret) || !ret.expression) {
    lowerer.unsupported(
      "SC1090",
      call,
      `the type-guard '${callee.text}' on a catch binding (only single-'return' guard bodies inline over the caught value)`,
    );
  }
  if (inliningPredicates.has(symbol)) {
    lowerer.unsupported(
      "SC1090",
      call,
      `the self-recursive type-guard '${callee.text}' on a catch binding`,
    );
  }
  inliningPredicates.add(symbol);
  lowerer.scopes.push(new Map([[paramSymbol, caughtLocal]]));
  try {
    const result = lowerer.lowerExpr(ret.expression);
    return lowerer.ensureBool(result, ret.expression);
  } finally {
    lowerer.scopes.pop();
    inliningPredicates.delete(symbol);
  }
}

/** Radix-free `.toString()` on a PRIMITIVE receiver: numbers take the
 * STATIC JS-exact number formatter — the same `toString` node templates
 * and String(n) lower to (Number::toString with radix 10 IS that
 * conversion, per spec) — booleans the "true"/"false" texts, and strings
 * the identity read (String.prototype.toString returns `this`). The
 * explicit-radix number form uses the native radix formatter;
 * null for other receivers, argument shapes, or non-lib members (a
 * user's own `.toString` takes the ordinary paths). */
function lowerNumberToStringCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (lowerer.chainBlocked(call, access)) return null;
  if (
    access.name.text !== "toString" ||
    call.arguments.nodes.length > 1 ||
    call.arguments.nodes.some(ts.isSpreadElement)
  )
    return null;
  const recvKind = lowerer.mapTypeOf(lowerer.typeOf(access.expression))?.kind;
  if (recvKind !== "f64" && recvKind !== "bool" && recvKind !== "string") return null;
  if (!lowerer.isStdlibMember(access)) return null;
  const operand = lowerer.lowerExpr(access.expression);
  // JavaScript array and typed-array reads can still be undefined even
  // when the checker declares a number. Preserve that runtime value and
  // let native method dispatch format numbers or throw for missing data.
  if (operand.type.kind === "dyn") {
    return {
      kind: "libCall",
      fn: "dyn.toString",
      args: [
        operand,
        call.arguments.nodes[0]
          ? lowerer.lowerExprExpecting(call.arguments.nodes[0], DYN)
          : dynUndefinedExpr(locOf(call)),
        { kind: "strLit", value: ts.getTextOfNode(access), type: STRING, loc: locOf(call) },
      ],
      type: STRING,
      loc: locOf(call),
    };
  }
  if (call.arguments.nodes.length === 1) {
    if (operand.type.kind !== "f64") return null;
    const arg = call.arguments.nodes[0]!;
    // A number radix needs no box: ToIntegerOrInfinity of a number is a
    // truncation, which the typed entry point applies itself.
    if (!ts.isSpreadElement(arg) && lowerer.mapTypeOf(lowerer.typeOf(arg))?.kind === "f64") {
      const radix = lowerer.lowerExpr(arg);
      if (radix.type.kind === "f64") {
        return {
          kind: "libCall",
          fn: "num.toStringRadixF64",
          args: [operand, radix],
          type: STRING,
          loc: locOf(call),
        };
      }
      return {
        kind: "libCall",
        fn: "num.toStringRadix",
        args: [operand, lowerer.coerceToExpected(radix, DYN)],
        type: STRING,
        loc: locOf(call),
      };
    }
    return {
      kind: "libCall",
      fn: "num.toStringRadix",
      args: [operand, lowerer.lowerExprExpecting(arg, DYN)],
      type: STRING,
      loc: locOf(call),
    };
  }
  if (operand.type.kind === "string") return operand; // identity, receiver evaluated
  if (operand.type.kind !== "f64" && operand.type.kind !== "bool") return null;
  return { kind: "toString", operand, type: STRING, loc: locOf(call) };
}

/** Radix-free `.toString()` on a UNION receiver whose every arm has one
 * (string identity, JS-exact number/bool texts, and the Buffer arm's
 * utf8 decode — Node's default encoding): the per-union ToString
 * helper dispatches on the tag, so `chunk.toString()` over the ngrok
 * `Buffer | string` listener param needs no narrowing. Unit-armed
 * unions stay out — `(undefined).toString()` THROWS in JS, and
 * claiming it here would print "undefined" instead. Null for
 * other receivers/arms (the narrow-first fences stay). */
function lowerUnionToStringCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (call.questionDotToken || access.questionDotToken) return null;
  if (access.name.text !== "toString" || call.arguments.nodes.length !== 0) return null;
  const recvT = lowerer.mapTypeOf(lowerer.typeOf(access.expression));
  if (recvT?.kind !== "union") return null;
  if (!lowerer.isStdlibMember(access)) return null;
  const def = lowerer.unions.get(recvT.unionId);
  const stringable = def?.arms.every(
    (a) =>
      a.kind === "string" ||
      a.kind === "f64" ||
      a.kind === "bool" ||
      (a.kind === "bytes" && a.elem === "u8"),
  );
  if (!stringable) return null;
  let operand = lowerer.lowerExpr(access.expression);
  if (operand.type.kind !== "union") return null;
  // A flow-narrowed read keeps its wider storage union (`string | number`
  // after `!Array.isArray(h.host)` over a `string | number | string[]`
  // slot): retag it to the proven union before the per-union helper.
  if (operand.type.unionId !== recvT.unionId) {
    operand = lowerer.coerceInto(access.expression, operand, recvT);
    if (operand.type.kind !== "union" || operand.type.unionId !== recvT.unionId) return null;
  }
  return { kind: "toString", operand, type: STRING, loc: locOf(call) };
}

/** `x.toString()` resolving to Object.prototype.toString (stdlib
 * provenance, zero arguments) on a RECORD or program-class receiver:
 * the spec's default answer is the constant "[object Object]". Records
 * carry no method storage at all, and a class receiver folds only when
 * neither its chain nor ANY subclass declares toString (dynamic
 * dispatch could reach an override otherwise — and a resolved override
 * is the USER's symbol, which never lands here). Pure receivers elide
 * evaluation; effectful ones evaluate through an interned identity
 * helper so the receiver's effects keep their place. */
function lowerDefaultToStringCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (call.questionDotToken || access.questionDotToken) return null;
  if (access.name.text !== "toString" || call.arguments.nodes.length !== 0) return null;
  if (!lowerer.isStdlibMember(access)) return null;
  const recvT = lowerer.mapTypeOf(lowerer.typeOf(access.expression));
  if (!recvT) return null;
  if (recvT.kind === "object") {
    const info = lowerer.classes.get(recvT.className);
    // Runtime-provided classes (Error, EventEmitter, streams) have real
    // toString stories of their own — only source-declared classes fold.
    if (!info || !info.decl) return null;
    if (lowerer.findMethodOn(info, "toString") !== null) return null;
    if (lowerer.overrideBelow(info, "toString")) return null;
    if (findGenericMethodOn(lowerer, info, "toString") !== null) return null;
  } else if (recvT.kind !== "record") {
    return null;
  }
  const loc = locOf(call);
  if (recvT.kind === "record" && isPerfEntryType(lowerer, recvT)) {
    return perfEntryTag(lowerer, lowerer.lowerExpr(access.expression), recvT, loc);
  }
  const constant: IrExpr = { kind: "strLit", value: "[object Object]", type: STRING, loc };
  // `(<A>{}).toString()` — assertion-wrapped literals and plain reads
  // have nothing to evaluate; pureObjectToStringReceiver widens
  // pureReceiverNode with the empty object literal.
  // A null-prototype record (Object.groupBy) has no toString: Node
  // throws "<callee> is not a function".
  const nullProtoT = nullProtoRecordShape(lowerer, recvT);
  const missing = nullProtoT ? `${ts.getTextOfNode(access)} is not a function` : null;
  if (!missing && pureObjectToStringReceiver(access.expression)) return constant;
  const recv = lowerer.lowerExpr(access.expression);
  const key = `objToStr:${typeKey(recv.type)}${missing ? `:${missing}` : ""}`;
  let helper = lowerer.valueHelpers.get(key);
  if (!helper) {
    helper = keyedHelperName(lowerer, "%obj.tostr", key);
    lowerer.valueHelpers.set(key, helper);
    const o = varRef("o.0", recv.type, loc);
    lowerer.liftedFns.push({
      name: helper,
      params: [{ localId: "o.0", name: "o", type: recv.type }],
      returnType: STRING,
      locals: [{ id: "o.0", name: "o", type: recv.type, mutable: false }],
      body: [
        {
          kind: "return",
          value:
            nullProtoT && missing
              ? guardNullProto(o, nullProtoT.shapeId, missing, { ...constant }, loc)
              : { ...constant },
          loc,
        },
      ],
      loc,
    });
  }
  return { kind: "call", callee: helper, args: [recv], type: STRING, loc };
}

/** pureReceiverNode plus the empty object literal — the default-toString
 * fold's receiver test (an empty literal allocates and nothing more,
 * which the discard cannot observe). */
function pureObjectToStringReceiver(node: ts.Expression): boolean {
  let e = node;
  while (
    ts.isParenthesizedExpression(e) ||
    ts.isAsExpression(e) ||
    ts.isNonNullExpression(e) ||
    ts.isTypeAssertion(e)
  ) {
    e = e.expression;
  }
  if (ts.isObjectLiteralExpression(e) && e.properties.nodes.length === 0) return true;
  return pureReceiverNode(e);
}

/** `A.hasOwnProperty(lit)` on a PROGRAM CLASS constructor: the own
 * properties of a class object are compile-time-known — its OWN static
 * member names (fields, methods, accessors; inherited statics live on
 * the base, not here) plus the function-object trio prototype/name/
 * length — so a literal key folds to a constant. Builtin classes and
 * non-literal keys keep the fence. */
function lowerClassHasOwnPropertyCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (call.questionDotToken || access.questionDotToken) return null;
  if (access.name.text !== "hasOwnProperty" || call.arguments.nodes.length !== 1) return null;
  if (!ts.isIdentifier(access.expression)) return null;
  const argNode = call.arguments.nodes[0]!;
  if (!ts.isStringLiteralLike(argNode)) return null;
  if (!lowerer.isStdlibMember(access)) return null;
  const sym = lowerer.resolveValueSymbol(access.expression);
  const info = sym ? lowerer.classBySymbol.get(sym) : undefined;
  if (!info || !info.decl) return null; // builtin/runtime classes keep the fence
  const key = argNode.text;
  const own = new Set(["prototype", "name", "length"]);
  for (const m of info.decl.members.nodes) {
    const isStatic =
      ts.canHaveModifiers(m) &&
      (ts.getModifiers(m) ?? []).some((mod) => mod.kind === ts.SyntaxKind.StaticKeyword);
    if (!isStatic) continue;
    if (
      !ts.isPropertyDeclaration(m) &&
      !ts.isMethodDeclaration(m) &&
      !ts.isGetAccessorDeclaration(m) &&
      !ts.isSetAccessorDeclaration(m)
    ) {
      continue; // static blocks and constructors carry no own name
    }
    if (ts.isIdentifier(m.name) || ts.isStringLiteralLike(m.name)) own.add(m.name.text);
    else return null; // computed static names — the answer isn't static
  }
  if (!own.has(key)) {
    const loc = locOf(call);
    const data = classStaticDataFor(lowerer, info, key, loc);
    if (data)
      return {
        kind: "libCall",
        fn: "dyn.hasOwn",
        args: [data, { kind: "strLit", value: key, type: STRING, loc }],
        type: BOOL,
        loc,
      };
  }
  return { kind: "boolLit", value: own.has(key), type: BOOL, loc: locOf(call) };
}

/** Side-effect-free receiver test for the CONSTANT primitive-prototype
 * answers (hasOwnProperty below): the constant elides the receiver's
 * evaluation, which is only honest when evaluating it could do nothing —
 * identifiers, literals, and parens over those. */
function pureReceiverNode(node: ts.Expression): boolean {
  let e = node;
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e)) {
    e = e.expression;
  }
  return (
    ts.isIdentifier(e) ||
    ts.isStringLiteralLike(e) ||
    ts.isNumericLiteral(e) ||
    e.kind === ts.SyntaxKind.TrueKeyword ||
    e.kind === ts.SyntaxKind.FalseKeyword ||
    e.kind === ts.SyntaxKind.ThisKeyword
  );
}

/** The remaining PRIMITIVE prototype surface with a static story, in both
 * member spellings (`x.hasOwnProperty(...)` and `x['hasOwnProperty'](...)`
 * — JS resolves the two identically, so the element spelling routes here
 * from lowerCall's element-access hook):
 *   - `n.toExponential()` and both `n.toFixed()` forms — the static
 *     runtime formatters (num.toExponential's shortest-mantissa form,
 *     num.toFixed0's ties-up integer fast path, and num.toFixed's exact
 *     binary-value rounding for an explicit fractionDigits).
 *   - `hasOwnProperty(lit)` on number/boolean receivers — the boxes own
 *     NOTHING, so any key answers false (a compile-time constant; the
 *     receiver must be effect-free since the constant elides it).
 *   - `hasOwnProperty(lit)` on string receivers — "length" is true,
 *     a canonical array index answers `index < s.length` (indices ARE
 *     own properties of the box, per spec), every other literal false.
 *   - the element-access spellings of `toString()` (the primitive
 *     lowering above) and `charAt(i)` — the two the element hook needs
 *     beyond this file's own claims.
 * Null elsewhere: non-literal keys, other members, other receivers. */
function lowerPrimitiveProtoCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  recv: ts.Expression,
  name: string,
  memberSym: ts.Symbol | undefined,
): IrExpr | null {
  if (call.questionDotToken) return null;
  if (!lowerer.isStdlibSymbol(memberSym)) return null;
  const recvKind = lowerer.mapTypeOf(lowerer.typeOf(recv))?.kind;
  if (
    (name === "toFixed" || name === "toExponential") &&
    call.arguments.nodes.length <= 1 &&
    !call.arguments.nodes.some(ts.isSpreadElement) &&
    isJsSourceFile(ts.getSourceFileOfNode(call))
  ) {
    const operand = lowerer.lowerExpr(recv);
    if (
      name === "toExponential" &&
      call.arguments.nodes.length === 1 &&
      (operand.type.kind === "dyn" ||
        (operand.type.kind === "union" && lowerer.dynConvertible(operand.type)))
    ) {
      const dispatched = lowerDynPrimitiveMethodCall(
        lowerer,
        call,
        name,
        `${ts.getTextOfNode(recv)}.${name}`,
        lowerer.coerceToExpected(operand, DYN),
      );
      if (dispatched) return dispatched;
    }
    if (
      operand.type.kind === "dyn" ||
      (operand.type.kind === "union" && lowerer.dynConvertible(operand.type))
    )
      return {
        kind: "dynInvoke",
        recv: lowerer.coerceToExpected(operand, DYN),
        method: name,
        calleeName: `${ts.getTextOfNode(recv)}.${name}`,
        args: call.arguments.nodes.map((argument) => lowerer.lowerExprExpecting(argument, DYN)),
        type: DYN,
        loc: locOf(call),
      };
  }
  if (
    name === "toPrecision" &&
    call.arguments.nodes.length <= 1 &&
    !call.arguments.nodes.some(ts.isSpreadElement) &&
    isJsSourceFile(ts.getSourceFileOfNode(call)) &&
    recvKind === "union"
  ) {
    const operand = lowerer.lowerExpr(recv);
    if (operand.type.kind === "union" && lowerer.dynConvertible(operand.type)) {
      const dispatched = lowerDynPrimitiveMethodCall(
        lowerer,
        call,
        name,
        `${ts.getTextOfNode(recv)}.${name}`,
        lowerer.coerceToExpected(operand, DYN),
      );
      if (dispatched) return dispatched;
    }
  }
  if (
    recvKind === "f64" &&
    (name === "toPrecision" || (name === "toExponential" && call.arguments.nodes.length === 1))
  ) {
    const typed = lowerExtraNumberMethodCall(lowerer, call, name, lowerer.lowerExpr(recv));
    if (typed) return typed;
  }
  if (recvKind !== "f64" && recvKind !== "bool" && recvKind !== "string") return null;
  const loc = locOf(call);
  if (name === "toString" && call.arguments.nodes.length === 0) {
    const operand = lowerer.lowerExpr(recv);
    if (operand.type.kind === "string") return operand; // identity
    if (operand.type.kind !== "f64" && operand.type.kind !== "bool") return null;
    return { kind: "toString", operand, type: STRING, loc };
  }
  if (
    (name === "toExponential" || name === "toFixed") &&
    recvKind === "f64" &&
    call.arguments.nodes.length === 0
  ) {
    const operand = lowerer.lowerExpr(recv);
    if (operand.type.kind !== "f64") return null;
    const fn = name === "toExponential" ? "num.toExponential" : "num.toFixed0";
    return { kind: "libCall", fn, args: [operand], type: STRING, loc };
  }
  if (name === "toFixed" && recvKind === "f64" && call.arguments.nodes.length === 1) {
    const operand = lowerer.lowerExpr(recv);
    let digits = lowerer.lowerExpr(call.arguments.nodes[0]!);
    // The optional parameter also admits undefined. Exact unit values
    // become the default 0 after preserving any evaluation effects; an
    // optional number selects 0 at runtime through the same narrowed
    // nullish IR used by `digits ?? 0`.
    const zero: IrExpr = { kind: "numLit", value: 0, type: F64, loc: digits.loc };
    const defaultUnitDigits = (value: IrExpr): IrExpr =>
      isSafeToDiscard(value)
        ? zero
        : {
            kind: "seqExpr",
            stmts: [{ kind: "exprStmt", expr: value, loc: value.loc }],
            result: zero,
            type: F64,
            loc: value.loc,
          };
    if (digits.type.kind === "undefinedT" || digits.type.kind === "void") {
      digits = defaultUnitDigits(digits);
    } else if (digits.type.kind === "union") {
      const def = lowerer.unions.get(digits.type.unionId);
      if (def?.arms.every(isUnitType)) {
        digits = defaultUnitDigits(digits);
      } else if (
        def?.arms.length === 2 &&
        def.arms.some((arm) => arm.kind === "f64") &&
        def.arms.some((arm) => arm.kind === "undefinedT")
      ) {
        digits = { kind: "nullish", left: digits, right: zero, type: F64, loc: digits.loc };
      }
    }
    if (operand.type.kind !== "f64" || digits.type.kind !== "f64") return null;
    return { kind: "libCall", fn: "num.toFixed", args: [operand, digits], type: STRING, loc };
  }
  // Number.prototype.toLocaleString("en-US") — the spec makes it
  // NumberFormat(locale).format(this), so the en-US embedded formatter
  // answers exactly. The unlowered forms fence by NAME: no locale (the
  // host environment's default, which a compiled binary cannot carry),
  // other locales (ICU data the binary does not embed), options bags.
  if (name === "toLocaleString" && recvKind === "f64") {
    if (call.arguments.nodes.length === 0) {
      lowerer.noLowering(
        "Number.prototype.toLocaleString without a locale",
        call,
        "the default locale is the host environment's, which a compiled binary cannot carry — " +
          'pass it explicitly: x.toLocaleString("en-US")',
      );
    }
    if (call.arguments.nodes.length > 1) {
      lowerer.noLowering(
        "Number.prototype.toLocaleString with an options bag",
        call,
        "the embedded data covers DEFAULT options only (decimal notation, up to 3 fraction " +
          'digits, grouping) — x.toLocaleString("en-US")',
      );
    }
    const locNode = call.arguments.nodes[0]!;
    if (
      ts.isSpreadElement(locNode) ||
      !ts.isStringLiteralLike(locNode) ||
      locNode.text !== "en-US"
    ) {
      lowerer.noLowering(
        !ts.isSpreadElement(locNode) && ts.isStringLiteralLike(locNode)
          ? `Number.prototype.toLocaleString at locale "${locNode.text}"`
          : "Number.prototype.toLocaleString with a non-literal locale",
        locNode,
        '"en-US" (Node\'s default-build locale) is the one locale whose data the runtime embeds — ' +
          "everything else is ICU data the binary does not carry",
      );
    }
    const operand = lowerer.lowerExpr(recv);
    if (operand.type.kind !== "f64") return null;
    return { kind: "libCall", fn: "intl.numFormatEnUs", args: [operand], type: STRING, loc };
  }
  if (
    name === "charAt" &&
    recvKind === "string" &&
    call.arguments.nodes.length === 1 &&
    !ts.isSpreadElement(call.arguments.nodes[0]!)
  ) {
    const receiver = lowerer.lowerExpr(recv);
    if (receiver.type.kind !== "string") return null;
    const idx = lowerer.lowerExprExpecting(call.arguments.nodes[0]!, F64);
    return { kind: "strIntrinsic", method: "charAt", receiver, args: [idx], type: STRING, loc };
  }
  if (name !== "hasOwnProperty" || call.arguments.nodes.length !== 1) return null;
  const argNode = call.arguments.nodes[0]!;
  if (!ts.isStringLiteralLike(argNode)) return null;
  const key = argNode.text;
  if (recvKind === "string") {
    if (/^(0|[1-9][0-9]*)$/.test(key) && Number(key) <= 2 ** 32 - 2) {
      // A canonical array index: an own property exactly when it is in
      // range — `index < s.length` (UTF-16 units, the box's indices).
      const receiver = lowerer.lowerExpr(recv);
      if (receiver.type.kind !== "string") return null;
      const len: IrExpr = {
        kind: "strIntrinsic",
        method: "length",
        receiver,
        args: [],
        type: F64,
        loc,
      };
      return {
        kind: "bin",
        op: "<",
        left: { kind: "numLit", value: Number(key), type: F64, loc },
        right: len,
        type: BOOL,
        loc,
      };
    }
    if (!pureReceiverNode(recv)) return null; // the constant elides the receiver
    return { kind: "boolLit", value: key === "length", type: BOOL, loc };
  }
  // Number/Boolean boxes own nothing: false for every key.
  if (!pureReceiverNode(recv)) return null;
  return { kind: "boolLit", value: false, type: BOOL, loc };
}

/** The uniquely arity-selected overload on an implicit-any receiver whose
 * active monomorphization supplies a concrete type. The checker resolved
 * the original call through `any`, so getResolvedSignature cannot name
 * the declaration-authored overload; typeOf carries the instance's real
 * receiver type. Restricting the fallback to exactly one bodyless
 * signature at this arity avoids recreating TypeScript's overload
 * resolution for same-arity type distinctions. */
function implicitReceiverOverloadReturn(
  lowerer: Lowerer,
  expr: ts.CallExpression | ts.TaggedTemplateExpression,
): IrType | null {
  if (
    !ts.isCallExpression(expr) ||
    !ts.isPropertyAccessExpression(expr.expression) ||
    expr.arguments.nodes.some(ts.isSpreadElement)
  ) {
    return null;
  }
  const access = expr.expression;
  const original = lowerer.checker.getTypeAtLocation(access.expression);
  if ((original.flags & ts.TypeFlags.Any) === 0) return null;
  const effective = lowerer.typeOf(access.expression);
  if ((effective.flags & ts.TypeFlags.Any) !== 0) return null;
  const member = lowerer.checker.getPropertyOfType(effective, access.name.text);
  if (!member) return null;
  const signatures = lowerer.checker.getCallSignatures(lowerer.checker.getTypeOfSymbol(member));
  const matches = signatures.filter((signature) => {
    const decl = signature.declaration;
    if (!decl || !(ts.isFunctionDeclaration(decl) || ts.isMethodDeclaration(decl)) || decl.body) {
      return false;
    }
    const params = decl.parameters.nodes.filter((param) => !isThisParameter(param));
    const required = params.filter(
      (param) => !param.questionToken && !param.initializer && !param.dotDotDotToken,
    ).length;
    const maximum = params.some((param) => param.dotDotDotToken) ? Infinity : params.length;
    return expr.arguments.nodes.length >= required && expr.arguments.nodes.length <= maximum;
  });
  if (matches.length !== 1) return null;
  return lowerer.mapTypeOf(lowerer.checker.getReturnTypeOfSignature(matches[0]!));
}

/** Reconciles a direct call's recorded type with the checker's answer at
 * the site when the callee is OVERLOADED: tsc resolved the call against
 * one overload SIGNATURE, so every downstream lowering sees that
 * overload's return type — but the value arrives through the
 * implementation's ABI (the only compiled body). Same mapped type: the
 * call stands (overloads differing only in parameters). A union
 * implementation return whose resolved type is one ARM: the CHECKED
 * extraction (narrowedArmHelper — the `x!` machinery), because nothing
 * ever CHECKED the implementation's body against the resolved signature
 * (tsc only checks it against the implementation signature), so a lying
 * implementation throws the catchable TypeError instead of a misread
 * payload. Everything else rides the ordinary coercion path — sub-union
 * re-tags bridge (stranded arms trap, the lying-cast stance), and pairs
 * with no honest bridge keep coerceInto's exactness fences. Calls that
 * resolved to the implementation itself (non-overloaded callees) pass
 * through untouched. */
/** A body-less abstract method that is its name's only declaration is the
 * virtual slot itself, not an overload signature: its lowered return is the
 * family ABI every override shares, so the call keeps that result instead
 * of narrowing it to the declared type. */
function isSoleAbstractMethod(decl: ts.FunctionDeclaration | ts.MethodDeclaration): boolean {
  if (!ts.isMethodDeclaration(decl)) return false;
  if (!ts.getModifiers(decl)?.some((m) => m.kind === ts.SyntaxKind.AbstractKeyword)) return false;
  const owner = decl.parent;
  if (!ts.isClassDeclaration(owner) && !ts.isClassExpression(owner)) return false;
  const name = ts.getTextOfNode(decl.name);
  return !owner.members.nodes.some(
    (member) =>
      member !== decl && ts.isMethodDeclaration(member) && ts.getTextOfNode(member.name) === name,
  );
}

function reconcileOverloadReturn(
  lowerer: Lowerer,
  expr: ts.CallExpression | ts.TaggedTemplateExpression,
  call: IrExpr,
): IrExpr {
  // The checker's overload is a guess for a checked-dynamic argument
  // another overload accepts: the implementation's value stands.
  if (ts.isCallExpression(expr) && dynamicOverloadChoice(lowerer, expr)) return call;
  const rsig = lowerer.checker.getResolvedSignature(expr);
  const rdecl = rsig ? rsig.declaration : undefined;
  // Nominal covariant overrides share the base's return ABI, but retain
  // their declared subclass result at the call site. Unannotated fluent
  // JS overrides use the same bridge for their proven receiver result.
  if (
    call.type.kind === "object" &&
    rdecl &&
    ts.isMethodDeclaration(rdecl) &&
    (!isJsSourceFile(ts.getSourceFileOfNode(rdecl)) || returnsOnlyThis(rdecl))
  ) {
    call = lowerer.maybeNarrow(call, expr);
  }
  // An override narrowed to part of its base's union return shares the
  // union ABI; a call resolved to that override narrows the result back.
  if (
    call.type.kind === "union" &&
    rsig &&
    rdecl &&
    ts.isMethodDeclaration(rdecl) &&
    lowerer.unionReturnOverrides.has(rdecl)
  ) {
    const declared = lowerer.mapTypeOf(lowerer.checker.getReturnTypeOfSignature(rsig));
    if (declared && !typeEquals(declared, call.type)) {
      if (declared.kind !== "union") {
        const helper = lowerer.narrowedArmHelper(call.type.unionId, declared, call.loc);
        if (helper) return lowerer.checkedNarrowCall(helper, call, declared, call.loc);
      }
      return lowerer.coerceInto(expr, call, declared);
    }
  }
  const resolvedOverload =
    rsig &&
    rdecl &&
    (ts.isFunctionDeclaration(rdecl) || ts.isMethodDeclaration(rdecl)) &&
    !rdecl.body &&
    !isSoleAbstractMethod(rdecl)
      ? lowerer.mapTypeOf(lowerer.checker.getReturnTypeOfSignature(rsig))
      : null;
  const rt = resolvedOverload ?? implicitReceiverOverloadReturn(lowerer, expr);
  // Unmappable, void, or unit resolved returns keep the implementation's
  // type: a discarded result never looks, a USED one meets its use
  // site's own mapping (and that site's honest fences). Unit narrowing
  // follows maybeNarrow's stance — a unit arm has no payload to extract.
  if (!rt || rt.kind === "void" || isUnitType(rt) || typeEquals(rt, call.type)) return call;

  // resolved overload's return type is a claim tsc never checked against
  // the body — extracting it HERE would throw the boundary TypeError
  // where Node just lets the value flow (functionOverloads35: the
  // implementation returns its object argument under a number-returning
  // overload signature; Node exits clean). The checker-trust trap keeps
  // governing edges the checker actually vouches for; this edge it never
  // did. The checked value stays in bindings and is validated per use.
  if (call.type.kind === "dyn") return call;
  if (call.type.kind === "union" && rt.kind !== "union") {
    const helper = lowerer.narrowedArmHelper(call.type.unionId, rt, call.loc);
    if (helper) return lowerer.checkedNarrowCall(helper, call, rt, call.loc);
  }
  return lowerer.coerceInto(expr, call, rt);
}

/** Escape validity of a TAGGED template span's raw text: an invalid
 * escape is legal syntax in a tagged template (ES2018) but cooks to
 * UNDEFINED — a hole no string[] strings object can carry, so those
 * sites keep a named fence. Valid: \x?? (two hex), \u???? (four hex),
 * \u{...} (≤ 0x10FFFF), \0 not followed by a digit, and every
 * non-digit character escape (identity escapes included). Invalid:
 * malformed hex/unicode forms and the legacy octal / \8 \9 family. */
function templateEscapesValid(raw: string): boolean {
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== "\\") continue;
    const c = raw[i + 1];
    if (c === undefined) return true; // trailing backslash: unreachable (the parser owns delimiters)
    if (c === "x") {
      if (!/^[0-9a-fA-F]{2}/.test(raw.slice(i + 2))) return false;
      i += 3;
      continue;
    }
    if (c === "u") {
      if (raw[i + 2] === "{") {
        const m = /^\{([0-9a-fA-F]+)\}/.exec(raw.slice(i + 2));
        if (!m || parseInt(m[1]!, 16) > 0x10ffff) return false;
        i += 1 + m[0].length;
        continue;
      }
      if (!/^[0-9a-fA-F]{4}/.test(raw.slice(i + 2))) return false;
      i += 5;
      continue;
    }
    if (c === "0") {
      if (/[0-9]/.test(raw[i + 2] ?? "")) return false;
      i += 1;
      continue;
    }
    if (/[1-9]/.test(c)) return false;
    i += 1; // any other escaped character (identity escapes, \n, line continuations)
  }
  return true;
}

export function lowerTaggedTemplate(lowerer: Lowerer, expr: ts.TaggedTemplateExpression): IrExpr {
  const loc = locOf(expr);
  const pieces = ts.isNoSubstitutionTemplateLiteral(expr.template)
    ? [expr.template]
    : [expr.template.head, ...expr.template.templateSpans.nodes.map((s) => s.literal)];
  for (const p of pieces) {
    if (!templateEscapesValid(templateRawTextOf(p))) {
      lowerer.unsupported(
        "SC1090",
        p,
        "tagged templates with invalid escape sequences (the span cooks to undefined, which the strings array cannot carry)",
      );
    }
  }
  const strings = (): IrExpr =>
    loweredTemplateStrings(
      lowerer,
      expr,
      pieces.map((piece) => piece.text),
      loc,
    );
  const values: readonly ts.Expression[] = ts.isNoSubstitutionTemplateLiteral(expr.template)
    ? []
    : expr.template.templateSpans.nodes.map((s) => s.expression);
  // Direct call of a top-level declared function — the plain-call fast
  // path with the strings array as the leading completed argument.
  if (ts.isIdentifier(expr.tag) && !lowerer.isSelfReference(expr.tag)) {
    if (lowerer.isTopLevelFnSymbol(expr.tag) && !lowerer.peekLocal(expr.tag)) {
      fenceEarlyAliasUse(lowerer, expr.tag, expr);
      const genericTag = lowerer.genericFnOf(expr.tag);
      if (genericTag && !genericTag.implicitParams) {
        lowerer.unsupported("SC1090", expr, "tagged templates with generic tag functions");
      }
      const sig = genericTag ? null : lowerer.fnSigOf(expr.tag);
      if (sig) {
        lowerer.noteEdge(sig.name);
        const args = completeArgs(lowerer, values, sig.params, loc, expr, [strings()]);
        return reconcileOverloadReturn(lowerer, expr, {
          kind: "call",
          callee: sig.name,
          args,
          type: sig.returnType,
          loc,
        });
      }
      // An ambient `declare function` nothing defines: Node throws
      // ReferenceError reading the tag before the template object is
      // built — the plain-call stance (nsUndefRead) reproduces it. An
      // `any`-typed result takes the DYN dummy rather than F64 so
      // downstream any-shaped consumers (`tag\`...\` as string`) keep
      // compiling — the read always throws first, the dummy is never
      // observed either way.
      if (ambientUndefinedFnSymbolOf(lowerer, expr.tag)) {
        const mapped = lowerer.mapTypeOf(lowerer.typeOf(expr));
        const t =
          mapped && mapped.kind !== "void" && !lowerer.typeNamesUnregisteredClass(mapped)
            ? mapped
            : (lowerer.typeOf(expr).flags & ts.TypeFlags.Any) !== 0
              ? DYN
              : F64;
        return nsUndefRead(lowerer, expr.tag.text, expr, t);
      }
    }
  }

  // Checked-dynamic tags (`var f: any; f\`abc\``, dyn property chains):
  // the dynCall boundary — arguments convert into dyn, a non-function
  // tag throws Node's catchable "<name> is not a function" TypeError.
  let callee = lowerer.lowerExpr(expr.tag);
  if (
    callee.type.kind === "func" &&
    isJsSourceFile(ts.getSourceFileOfNode(expr)) &&
    lowerer.dynConvertible(callee.type)
  ) {
    callee = { kind: "dynFrom", value: callee, type: DYN, loc };
  }
  if (callee.type.kind === "dyn") {
    const args = [
      loweredTemplateStrings(
        lowerer,
        expr,
        pieces.map((piece) => piece.text),
        loc,
        pieces.map(templateRawTextOf),
      ),
      ...values.map((a) => lowerer.lowerExprExpecting(a, DYN)),
    ];
    const calleeName =
      ts.isPropertyAccessExpression(expr.tag) || ts.isElementAccessExpression(expr.tag)
        ? ts.getTextOfNode(expr.tag)
        : ts.isIdentifier(expr.tag)
          ? expr.tag.text
          : "value";
    return { kind: "dynCall", callee, calleeName, args, type: DYN, loc };
  }
  lowerer.unsupported(
    "SC1090",
    expr,
    "tagged templates with this tag form (top-level functions and dynamic values tag; call the function directly otherwise)",
  );
}

function loweredTemplateStrings(
  lowerer: Lowerer,
  expr: ts.TaggedTemplateExpression,
  cooked: string[],
  loc: SrcLoc,
  raw?: string[],
): IrExpr {
  // Normal runtime construction keeps this array aligned with the current
  // ScrArr layout in the backend. The old static-header IR node encoded the
  // pre-sparse layout in LLVM and crashed as soon as a tag read its strings.
  const type = raw ? DYN : arrayOf(STRING);
  const array = (values: string[]): IrExpr => ({
    kind: "dynArrLit",
    elems: values.map((value): IrExpr => ({
      kind: "dynFrom",
      value: { kind: "strLit", value, type: STRING, loc },
      type: DYN,
      loc,
    })),
    type: DYN,
    loc,
  });
  const freeze = (value: IrExpr): IrExpr => ({
    kind: "libCall",
    fn: "dyn.freeze",
    args: [value],
    type: DYN,
    loc,
  });
  const checked: IrExpr | null = raw
    ? freeze({
        kind: "libCall",
        fn: "dyn.defineProperty",
        args: [
          array(cooked),
          {
            kind: "dynFrom",
            value: { kind: "strLit", value: "raw", type: STRING, loc },
            type: DYN,
            loc,
          },
          {
            kind: "dynObjLit",
            fields: [
              {
                key: { kind: "strLit", value: "value", type: STRING, loc },
                value: freeze(array(raw)),
              },
            ],
            type: DYN,
            loc,
          },
        ],
        type: DYN,
        loc,
      })
    : null;
  const key = `templateStringsGlobal:${loc.file}:${ts.tokenStartOfNode(expr.template)}:${raw ? "checked" : "typed"}`;
  let getter = lowerer.valueHelpers.get(key);
  if (!getter) {
    const site = lowerer.globalsList.length;
    const globalId = `%g.templateStrings.${site}`;
    const readyId = `%g.templateStringsReady.${site}`;
    getter = keyedHelperName(lowerer, "%templateStrings.get", key);
    lowerer.valueHelpers.set(key, getter);
    lowerer.globalsList.push(
      { id: globalId, name: "%templateStrings", type, mutable: true },
      { id: readyId, name: "%templateStringsReady", type: BOOL, mutable: true },
    );
    lowerer.liftedFns.push({
      name: getter,
      params: [],
      returnType: type,
      locals: [],
      body: [
        {
          kind: "if",
          cond: { kind: "unary", op: "!", operand: varRef(readyId, BOOL, loc), type: BOOL, loc },
          then: [
            {
              kind: "assign",
              localId: globalId,
              value: checked ?? {
                kind: "arrayLit",
                elems: cooked.map((value): IrExpr => ({
                  kind: "strLit",
                  value,
                  type: STRING,
                  loc,
                })),
                type,
                loc,
              },
              loc,
            },
            {
              kind: "assign",
              localId: readyId,
              value: { kind: "boolLit", value: true, type: BOOL, loc },
              loc,
            },
          ],
          else_: null,
          loc,
        },
        { kind: "return", value: varRef(globalId, type, loc), loc },
      ],
      loc,
    });
  }
  return { kind: "call", callee: getter, args: [], type, loc };
}

/** `p.then(f)` / `p.catch(handler)` / `p.finally(cb)` — fiber-level
 * DESUGARS. Each synthesizes a small async wrapper (lifted like a
 * lambda) and calls it with the receiver, so promise machinery,
 * microtask ordering, and rejection bookkeeping all ride the existing
 * await path:
 *
 *   p.then(f)    ≡ (async (pp, f) => { return f(await pp); })(p, f)
 *   p.catch(h)   ≡ (async (pp) => { try { return await pp; } catch (e) { <h's body> } })(p)
 *   p.finally(f) ≡ (async (pp, f) => { try { const v = await pp; f(); return v; } catch (e) { f(); throw e; } })(p, f)
 *
 * Node-exact by construction: the wrapper's await parks on pending
 * receivers and takes the settled-await microtask hop otherwise; the
 * catch handler's parameter binds the rejection reason as a CAUGHT
 * local — the typed-catch machinery (instanceof/typeof narrowing,
 * rethrow) IS the handler's surface; a handler throw rejects the
 * result; a handler falling off its end resolves with undefined
 * (checker-typed — the result union carries the arm); an unawaited
 * rejected result enters the unhandled-rejection ledger. The catch
 * HANDLER must be an inline arrow/function expression: its parameter
 * becomes the catch binding, and a handler VALUE would need a
 * caught-typed closure parameter, which cannot exist. finally takes
 * any () => void closure (its callback sees no arguments). then takes
 * a fulfillment handler and optionally a rejection handler; a
 * promise-returning handler flattens through the async
 * return path, a receiver rejection passes through untouched (the
 * wrapper's await re-throws it), and a handler throw rejects the
 * result — the spec's onFulfilled rules by construction. Null for
 * non-promise receivers and other members. */

function modulePromiseStorageTypeOf(lowerer: Lowerer, e: ts.Expression): IrType | null {
  const direct = staticImportNamespaceType(lowerer, e);
  if (direct?.kind === "promise") return direct;
  if (!ts.isIdentifier(e)) return null;
  const local = lowerer.resolveLocal(e);
  if (local?.type.kind === "promise" && local.type.inner.kind === "moduleNs") return local.type;
  if (local) return null;
  let sym = lowerer.checker.getSymbolAtLocation(e);
  if (sym && sym.flags & ts.SymbolFlags.Alias) sym = lowerer.checker.getAliasedSymbol(sym);
  const g = sym ? lowerer.globalsBySymbol.get(sym) : undefined;
  if (g?.type.kind === "promise" && g.type.inner.kind === "moduleNs") return g.type;
  return null;
}

function markModuleNsHandlerParams(
  lowerer: Lowerer,
  handler: ts.Expression,
  type: IrType & { kind: "moduleNs" },
): void {
  let e = handler;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  if (!ts.isArrowFunction(e) && !ts.isFunctionExpression(e)) return;
  for (const p of e.parameters.nodes) {
    if (ts.isIdentifier(p.name) && !p.dotDotDotToken && !p.initializer) {
      lowerer.moduleNsParamOverrides.set(p, type);
    }
  }
}

export function lowerPromiseMethodCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (call.questionDotToken || access.questionDotToken) return null;
  const member = access.name.text;
  if (member !== "then" && member !== "catch" && member !== "finally") return null;
  let recvT =
    lowerer.mapTypeOf(lowerer.typeOf(access.expression)) ??
    dynFallbackType(lowerer, access.expression, lowerer.typeOf(access.expression));
  // A dynamic-import promise under an unmappable checker type
  // (`Promise<typeof import("./m")>`) uses the module promise's native
  // storage type. Direct `import("./m").then(...)` needs no binding.
  if (!recvT) recvT = modulePromiseStorageTypeOf(lowerer, access.expression);
  if (recvT?.kind !== "promise") return null;
  if (!lowerer.isStdlibMember(access)) return null;
  const loc = locOf(call);
  // Handler-less spellings — `p.then()`, `p.catch()`, `p.finally()`,
  // and the explicit `undefined`/`null` handler: the spec substitutes
  // identity/thrower/no-op, so each is the PASSTHROUGH promise — a
  // fresh promise settling exactly as the receiver does (never the
  // receiver itself: `p.catch() !== p` in JS). Detected here; built
  // after the receiver lowers below.
  const isAbsentHandler = (a: ts.Expression | undefined): boolean => {
    if (a === undefined) return true;
    let e = a;
    while (ts.isParenthesizedExpression(e)) e = e.expression;
    return (
      e.kind === ts.SyntaxKind.NullKeyword ||
      (ts.isIdentifier(e) &&
        e.text === "undefined" &&
        (lowerer.typeOf(e).flags & ts.TypeFlags.Undefined) !== 0)
    );
  };
  const passthrough =
    call.arguments.nodes.length === 0 ||
    (call.arguments.nodes.length === 1 && isAbsentHandler(call.arguments.nodes[0]));
  if (
    call.arguments.nodes.length !== 1 &&
    !passthrough &&
    !(member === "then" && call.arguments.nodes.length === 2)
  ) {
    lowerer.noLowering(
      `${member} with ${call.arguments.nodes.length} arguments`,
      call,
      member === "then"
        ? "the supported form takes a fulfillment handler and an optional rejection handler"
        : `the supported form takes exactly one ${member === "catch" ? "inline handler" : "callback"}`,
    );
  }
  // The receiver evaluates FIRST, in the enclosing function, like JS.
  let receiver = lowerer.lowerExpr(access.expression);

  if (receiver.type.kind === "dyn" && lowerer.dynConvertible(recvT))
    receiver = lowerer.coerceInto(access.expression, receiver, recvT);
  if (receiver.type.kind !== "promise") {
    // mapTypeOf said promise but the value lowered as something else —
    // a lowering gap, named rather than ICEd on.
    lowerer.unsupported("SC1090", call, `'.${member}' on this receiver`);
  }
  // Wrapper types follow the receiver's promise type; typed uses of the
  // settled value convert through coerceInto below.
  const promT = receiver.type;
  const inner = promT.inner;

  if (passthrough) {
    // The absent-handler forms: a lifted `async (p) => await p` — the
    // fresh promise adopts p's settlement exactly (fulfillment value
    // through the await, rejection through the await's rethrow), which
    // IS the spec's identity/thrower/no-op substitution for all three
    // members. An argument expression, when present, is undefined/null
    // by construction — nothing to evaluate.
    const fnName = lowerer.closureName(loc, `_${member}pass`);
    const funcType: IrType & { kind: "func" } = { kind: "func", params: [promT], ret: promT };
    const fnCtx = newFnCtx(true, null, funcType, inner);
    fnCtx.isAsync = true;
    lowerer.fnStack.push(fnCtx);
    try {
      const pLocal = lowerer.declareHiddenLocal("p", promT);
      const awaitE: IrExpr = {
        kind: "awaitExpr",
        value: { kind: "varRef", localId: pLocal.id, type: promT, loc },
        type: inner,
        loc,
      };
      const body: IrStmt[] =
        inner.kind === "void"
          ? [
              { kind: "exprStmt", expr: awaitE, loc },
              { kind: "return", value: null, loc },
            ]
          : [{ kind: "return", value: awaitE, loc }];
      const ctx = lowerer.ctx;
      const lifted: IrFunction = {
        name: fnName,
        params: [{ localId: pLocal.id, name: pLocal.name, type: promT }],
        returnType: inner,
        locals: ctx.locals,
        captures: ctx.captures!,
        body,
        loc,
        async: true,
      };
      lowerer.liftedFns.push(lifted);
      const closure: IrExpr = {
        kind: "closure",
        fnName,
        captures: ctx.captureSources,
        type: funcType,
        loc,
      };
      return { kind: "callValue", callee: closure, args: [receiver], type: promT, loc };
    } finally {
      lowerer.fnStack.pop();
    }
  }

  if (member === "then") {
    if (call.arguments.nodes.length === 2) {
      const fulfilledNode = call.arguments.nodes[0]!;
      const rejectedNode = call.arguments.nodes[1]!;
      const fulfilledAbsent = isAbsentHandler(fulfilledNode);
      const rejectedAbsent = isAbsentHandler(rejectedNode);
      const resultT = lowerer.mapTypeOf(lowerer.typeOf(call));
      if (resultT?.kind !== "promise") {
        lowerer.noLowering(
          "then with these handlers",
          call,
          "the result must be a representable promise",
        );
      }
      const R = resultT.inner;
      if (!fulfilledAbsent && inner.kind === "moduleNs")
        markModuleNsHandlerParams(lowerer, fulfilledNode, inner);
      const boxHandler = (
        node: ts.Expression,
        allowDirect: boolean,
      ): { value: IrExpr; direct: boolean; returnsPromise: boolean } => {
        const value = lowerer.lowerExpr(node);
        if (
          allowDirect &&
          value.type.kind === "func" &&
          value.type.params.length <= 1 &&
          (value.type.params.length === 0 ||
            (inner.kind !== "void" && typeEquals(value.type.params[0]!, inner)))
        ) {
          return { value, direct: true, returnsPromise: value.type.ret.kind === "promise" };
        }
        if (value.type.kind === "dyn") return { value, direct: false, returnsPromise: false };
        if (
          value.type.kind === "func" &&
          value.type.params.length <= 1 &&
          canBoxFuncIntoDyn(
            value.type,
            (id) => lowerer.shapes.get(id),
            (id) => lowerer.unions.get(id),
          )
        ) {
          return {
            value: { kind: "dynFrom", value, type: DYN, loc },
            direct: false,
            returnsPromise: value.type.ret.kind === "promise",
          };
        }
        lowerer.unsupported("SC1090", node, "then handlers that cannot be called with one value");
      };
      // Evaluate both callback expressions before the wrapper runs, in source order.
      const fulfilled = fulfilledAbsent ? null : boxHandler(fulfilledNode, true);
      const rejected = rejectedAbsent ? null : boxHandler(rejectedNode, false);
      const fnName = lowerer.closureName(loc, "_then2");
      const paramTypes: IrType[] = [
        promT,
        ...(fulfilled ? [fulfilled.value.type] : []),
        ...(rejected ? [DYN] : []),
      ];
      const funcType: IrType & { kind: "func" } = {
        kind: "func",
        params: paramTypes,
        ret: resultT,
      };
      const fnCtx = newFnCtx(true, null, funcType, R);
      fnCtx.isAsync = true;
      lowerer.fnStack.push(fnCtx);
      try {
        const pLocal = lowerer.declareHiddenLocal("p", promT);
        const fLocal = fulfilled ? lowerer.declareHiddenLocal("f", fulfilled.value.type) : null;
        const rLocal = rejected ? lowerer.declareHiddenLocal("r", DYN) : null;
        const eLocal = lowerer.declareHiddenLocal("e", CAUGHT);
        const vLocal = inner.kind === "void" ? null : lowerer.declareHiddenLocal("v", inner);
        const awaitE: IrExpr = {
          kind: "awaitExpr",
          value: { kind: "varRef", localId: pLocal.id, type: promT, loc },
          type: inner,
          loc,
        };
        const tryBody: IrStmt[] = vLocal
          ? [{ kind: "varDecl", localId: vLocal.id, init: awaitE, loc }]
          : [{ kind: "exprStmt", expr: awaitE, loc }];
        const resultOf = (value: IrExpr, returnsPromise = false): IrStmt[] => {
          if (value.type.kind === "promise")
            return [lowerer.adoptingReturn(value, R, (e) => lowerer.coerceInto(call, e, R))];
          const flattened = maybePromiseHandlerResult(lowerer, call, value, R);
          if (flattened) return [flattened];
          if (returnsPromise) {
            // A boxed handler's promise result adopts too: the then job's
            // turn after the call, then the await of the returned value.
            const hLocal = lowerer.declareHiddenLocal("h", DYN);
            const settledDyn: IrExpr = {
              kind: "libCall",
              fn: "async.awaitDyn",
              args: [{ kind: "varRef", localId: hLocal.id, type: DYN, loc }],
              type: DYN,
              loc,
            };
            return [
              { kind: "varDecl", localId: hLocal.id, init: value, loc },
              {
                kind: "exprStmt",
                expr: { kind: "libCall", fn: "async.hop", args: [], type: VOID, loc },
                loc,
              },
              ...(R.kind === "void"
                ? [
                    { kind: "exprStmt" as const, expr: settledDyn, loc },
                    { kind: "return" as const, value: null, loc },
                  ]
                : [
                    {
                      kind: "return" as const,
                      value: lowerer.coerceInto(call, settledDyn, R),
                      loc,
                    },
                  ]),
            ];
          }
          return R.kind === "void"
            ? [
                { kind: "exprStmt", expr: value, loc },
                { kind: "return", value: null, loc },
              ]
            : [{ kind: "return", value: lowerer.coerceInto(call, value, R), loc }];
        };
        const rejectedCall: IrExpr | null = rLocal
          ? {
              kind: "dynCall",
              callee: { kind: "varRef", localId: rLocal.id, type: DYN, loc },
              calleeName: jsFuncNameOf(rejectedNode) ?? "onRejected",
              args: [
                {
                  kind: "caughtToDyn",
                  value: { kind: "varRef", localId: eLocal.id, type: CAUGHT, loc },
                  type: DYN,
                  loc,
                },
              ],
              type: DYN,
              loc,
            }
          : null;
        const catchBody: IrStmt[] = rejectedCall
          ? resultOf(rejectedCall, rejected?.returnsPromise)
          : [{ kind: "rethrow", localId: eLocal.id, loc }];
        const body: IrStmt[] = [
          { kind: "tryCatch", tryBody, catchBody, catchLocalId: eLocal.id, finallyBody: null, loc },
        ];
        // The fulfillment callback sits after the catch so a throw from it
        // rejects the result instead of reaching onRejected.
        if (fLocal) {
          const settled: IrExpr = vLocal
            ? { kind: "varRef", localId: vLocal.id, type: inner, loc }
            : dynUndefinedExpr(loc);
          if (fulfilled!.direct && fLocal.type.kind === "func") {
            body.push(
              ...resultOf({
                kind: "callValue",
                callee: { kind: "varRef", localId: fLocal.id, type: fLocal.type, loc },
                args: fLocal.type.params.length === 0 ? [] : [settled],
                type: fLocal.type.ret,
                loc,
              }),
            );
          } else {
            if (
              settled.type.kind !== "dyn" &&
              !canConvertToDyn(
                settled.type,
                (id) => lowerer.shapes.get(id),
                (id) => lowerer.unions.get(id),
              )
            ) {
              lowerer.unsupported(
                "SC1090",
                fulfilledNode,
                "then fulfillment values that cannot cross the checked-dynamic boundary",
              );
            }
            const arg: IrExpr =
              settled.type.kind === "dyn"
                ? settled
                : { kind: "dynFrom", value: settled, type: DYN, loc };
            body.push(
              ...resultOf(
                {
                  kind: "dynCall",
                  callee: { kind: "varRef", localId: fLocal.id, type: DYN, loc },
                  calleeName: jsFuncNameOf(fulfilledNode) ?? "onFulfilled",
                  args: [arg],
                  type: DYN,
                  loc,
                },
                fulfilled?.returnsPromise,
              ),
            );
          }
        } else if (vLocal) {
          body.push(...resultOf({ kind: "varRef", localId: vLocal.id, type: inner, loc }));
        } else if (R.kind === "void") {
          body.push({ kind: "return", value: null, loc });
        } else {
          body.push({
            kind: "return",
            value: lowerer.coerceInto(call, dynUndefinedExpr(loc), R),
            loc,
          });
        }
        const ctx = lowerer.ctx;
        const lifted: IrFunction = {
          name: fnName,
          params: [
            { localId: pLocal.id, name: pLocal.name, type: promT },
            ...(fLocal ? [{ localId: fLocal.id, name: fLocal.name, type: fLocal.type }] : []),
            ...(rLocal ? [{ localId: rLocal.id, name: rLocal.name, type: DYN }] : []),
          ],
          returnType: R,
          locals: ctx.locals,
          captures: ctx.captures!,
          body,
          loc,
          async: true,
        };
        lowerer.liftedFns.push(lifted);
        const closure: IrExpr = {
          kind: "closure",
          fnName,
          captures: ctx.captureSources,
          type: funcType,
          loc,
        };
        return {
          kind: "callValue",
          callee: closure,
          args: [
            receiver,
            ...(fulfilled ? [fulfilled.value] : []),
            ...(rejected ? [rejected.value] : []),
          ],
          type: resultT,
          loc,
        };
      } finally {
        lowerer.fnStack.pop();
      }
    }

    // contextual type spelled (a module-namespace type has no mapping —
    // the handle is the value's only story, isIslandExpr's local rule).

    if (inner.kind === "moduleNs")
      markModuleNsHandlerParams(lowerer, call.arguments.nodes[0]!, inner);
    let cb =
      primitiveConversionHandler(lowerer, call.arguments.nodes[0]!, inner) ??
      lowerer.lowerExpr(call.arguments.nodes[0]!);
    // A TYPED handler on a DYN-settling promise (the tracePromise
    // result's `.then((value) => ...)` — the checker's generic
    // instantiation typed the parameter, but the settled value is a
    // dyn value): box the handler and ride the dyn-handler desugar
    // below — its call thunk validates the settled value into the
    // declared parameter type (the per-arg dynCheck), Node's own
    // runtime contract for a value that came off the wire untyped.
    if (
      inner.kind === "dyn" &&
      cb.type.kind === "func" &&
      cb.type.params.some((p) => p.kind !== "dyn") &&
      canBoxFuncIntoDyn(
        cb.type,
        (id) => lowerer.shapes.get(id),
        (id) => lowerer.unions.get(id),
      )
    ) {
      cb = { kind: "dynFrom", value: cb, type: DYN, loc };
    }
    // A CHECKED-DYNAMIC handler VALUE (`p.then(common.mustCall())` — the
    // Node-suite wrapper is an untyped rest-args function): the same
    // async desugar with the handler called through the checked-dynamic tree — the
    // settled value boxes (dyn passes through; void arrives as JS's
    // explicit undefined argument), the result promise settles with the
    // handler's dyn result. A receiver rejection passes through the
    // await like the typed path; the dyn call's own argument checking
    // throws Node's TypeError for non-callables.
    if (cb.type.kind === "dyn") {
      const settledToDyn = (v: IrExpr): IrExpr => {
        if (v.type.kind === "dyn") return v;
        if (
          canConvertToDyn(
            v.type,
            (id) => lowerer.shapes.get(id),
            (id) => lowerer.unions.get(id),
          )
        ) {
          return { kind: "dynFrom", value: v, type: DYN, loc };
        }
        lowerer.unsupported(
          "SC1090",
          call.arguments.nodes[0]!,
          `then handlers receiving '${lowerer.fmt(v.type)}' values through an untyped handler (the settled value cannot cross the checked-dynamic tree boundary)`,
        );
      };
      const resultT: IrType & { kind: "promise" } = { kind: "promise", inner: DYN };
      const fnName = lowerer.closureName(loc, "_then");
      const funcType: IrType & { kind: "func" } = {
        kind: "func",
        params: [promT, DYN],
        ret: resultT,
      };
      const fnCtx = newFnCtx(true, null, funcType, DYN);
      fnCtx.isAsync = true;
      lowerer.fnStack.push(fnCtx);
      try {
        const pLocal = lowerer.declareHiddenLocal("p", promT);
        const cbLocal = lowerer.declareHiddenLocal("cb", DYN);
        const awaitE: IrExpr = {
          kind: "awaitExpr",
          value: { kind: "varRef", localId: pLocal.id, type: promT, loc },
          type: inner,
          loc,
        };
        const body: IrStmt[] = [];
        let handlerArgs: IrExpr[];
        if (inner.kind === "void") {
          body.push({ kind: "exprStmt", expr: awaitE, loc });
          handlerArgs = [dynUndefinedExpr(loc)];
        } else {
          const vLocal = lowerer.declareHiddenLocal("v", inner);
          body.push({ kind: "varDecl", localId: vLocal.id, init: awaitE, loc });
          handlerArgs = [settledToDyn({ kind: "varRef", localId: vLocal.id, type: inner, loc })];
        }
        body.push({
          kind: "return",
          value: {
            kind: "dynCall",
            callee: { kind: "varRef", localId: cbLocal.id, type: DYN, loc },
            calleeName: jsFuncNameOf(call.arguments.nodes[0]!, lowerer) ?? "onFulfilled",
            args: handlerArgs,
            type: DYN,
            loc,
          },
          loc,
        });
        const ctx = lowerer.ctx;
        const lifted: IrFunction = {
          name: fnName,
          params: [
            { localId: pLocal.id, name: pLocal.name, type: promT },
            { localId: cbLocal.id, name: cbLocal.name, type: DYN },
          ],
          returnType: DYN,
          locals: ctx.locals,
          captures: ctx.captures!,
          body,
          loc,
          async: true,
        };
        lowerer.liftedFns.push(lifted);
        const closure: IrExpr = {
          kind: "closure",
          fnName,
          captures: ctx.captureSources,
          type: funcType,
          loc,
        };
        return { kind: "callValue", callee: closure, args: [receiver, cb], type: resultT, loc };
      } finally {
        lowerer.fnStack.pop();
      }
    }
    if (cb.type.kind !== "func" || cb.type.params.length > 1) {
      lowerer.unsupported(
        "SC1090",
        call.arguments.nodes[0]!,
        "then handlers with more than one parameter (the two-argument onRejected form has no lowering — chain .catch(...) instead)",
      );
    }
    const param = cb.type.params[0];
    if (
      param !== undefined &&
      !typeEquals(param, inner) &&
      !(param.kind === "dyn" && (inner.kind === "void" || lowerer.dynConvertible(inner)))
    ) {
      lowerer.unsupported(
        "SC1090",
        call.arguments.nodes[0]!,
        `then handlers whose parameter is not the settled value's type (expected '${lowerer.fmt(inner)}', got '${lowerer.fmt(param)}')`,
      );
    }
    let resultT = lowerer.mapTypeOf(lowerer.typeOf(call));
    // JavaScript whose declared result type has no mapping (zod's
    // `Promise.all(items).then((r) => ParseStatus.mergeArray(status, r))`,
    // typed by a .d.ts union): the handler's value settles the promise as
    // a checked-dynamic value, checked where it is used.
    if (
      resultT?.kind !== "promise" &&
      isJsSourceFile(ts.getSourceFileOfNode(call)) &&
      cb.type.kind === "func" &&
      cb.type.ret.kind !== "promise" &&
      cb.type.ret.kind !== "void" &&
      (cb.type.ret.kind === "dyn" || lowerer.dynConvertible(cb.type.ret))
    ) {
      resultT = { kind: "promise", inner: DYN };
    }
    if (resultT?.kind !== "promise") {
      lowerer.noLowering(
        "then with this handler's result type",
        call,
        "the combined result must be a representable promise",
      );
    }
    const R = resultT.inner;
    const fnName = lowerer.closureName(loc, "_then");
    const funcType: IrType & { kind: "func" } = {
      kind: "func",
      params: [promT, cb.type],
      ret: resultT,
    };
    const fnCtx = newFnCtx(true, null, funcType, R);
    fnCtx.isAsync = true;
    lowerer.fnStack.push(fnCtx);
    try {
      const pLocal = lowerer.declareHiddenLocal("p", promT);
      const cbLocal = lowerer.declareHiddenLocal("cb", cb.type);
      const awaitE: IrExpr = {
        kind: "awaitExpr",
        value: { kind: "varRef", localId: pLocal.id, type: promT, loc },
        type: inner,
        loc,
      };
      const body: IrStmt[] = [];
      // The settled value: awaited into a local when the handler wants
      // it (a zero-param handler still awaits — the receiver must settle
      // before the handler runs, and a rejection must pass through).
      let handlerArgs: IrExpr[] = [];
      if (param !== undefined && inner.kind !== "void") {
        const vLocal = lowerer.declareHiddenLocal("v", inner);
        body.push({ kind: "varDecl", localId: vLocal.id, init: awaitE, loc });
        handlerArgs = [
          lowerer.coerceToExpected({ kind: "varRef", localId: vLocal.id, type: inner, loc }, param),
        ];
      } else {
        body.push({ kind: "exprStmt", expr: awaitE, loc });
        if (param !== undefined) handlerArgs = [dynUndefinedExpr(loc)];
      }
      const handlerCall: IrExpr = {
        kind: "callValue",
        callee: { kind: "varRef", localId: cbLocal.id, type: cb.type, loc },
        args: handlerArgs,
        type: cb.type.ret,
        loc,
      };
      // The handler's result: promise returns flatten exactly like
      // `return p` in any async body (the spec's thenable adoption);
      // everything else coerces into R.
      const flattened = maybePromiseHandlerResult(lowerer, call, handlerCall, R);
      if (flattened) {
        body.push(flattened);
      } else if (handlerCall.type.kind === "promise" && R.kind !== "promise") {
        body.push(lowerer.adoptingReturn(handlerCall, R, (e) => lowerer.coerceInto(call, e, R)));
      } else if (R.kind === "void") {
        body.push({ kind: "exprStmt", expr: handlerCall, loc });
        body.push({ kind: "return", value: null, loc });
      } else {
        body.push({ kind: "return", value: lowerer.coerceInto(call, handlerCall, R), loc });
      }
      const ctx = lowerer.ctx;
      const lifted: IrFunction = {
        name: fnName,
        params: [
          { localId: pLocal.id, name: pLocal.name, type: promT },
          { localId: cbLocal.id, name: cbLocal.name, type: cb.type },
        ],
        returnType: R,
        locals: ctx.locals,
        captures: ctx.captures!,
        body,
        loc,
        async: true,
      };
      lowerer.liftedFns.push(lifted);
      const closure: IrExpr = {
        kind: "closure",
        fnName,
        captures: ctx.captureSources,
        type: funcType,
        loc,
      };
      return { kind: "callValue", callee: closure, args: [receiver, cb], type: resultT, loc };
    } finally {
      lowerer.fnStack.pop();
    }
  }

  if (member === "finally") {
    const cb = lowerer.lowerExpr(call.arguments.nodes[0]!);
    if (lowerer.dynConvertible(promT) && lowerer.dynConvertible(cb.type)) {
      const result: IrExpr = {
        kind: "dynInvoke",
        recv: lowerer.coerceToExpected(receiver, DYN),
        method: "finally",
        calleeName: ts.getTextOfNode(access),
        args: [lowerer.coerceToExpected(cb, DYN)],
        type: DYN,
        loc,
      };
      return lowerer.coerceToExpected(result, promT);
    }
    if (cb.type.kind !== "func" || cb.type.params.length !== 0 || cb.type.ret.kind !== "void") {
      lowerer.unsupported(
        "SC1090",
        call.arguments.nodes[0]!,
        "finally callbacks with parameters or a return value (use () => { ... })",
      );
    }
    const fnName = lowerer.closureName(loc, "_finally");
    const funcType: IrType & { kind: "func" } = {
      kind: "func",
      params: [promT, cb.type],
      ret: promT,
    };
    const fnCtx = newFnCtx(true, null, funcType, inner);
    fnCtx.isAsync = true;
    lowerer.fnStack.push(fnCtx);
    try {
      const pLocal = lowerer.declareHiddenLocal("p", promT);
      const cbLocal = lowerer.declareHiddenLocal("cb", cb.type);
      const cbCall = (): IrStmt => ({
        kind: "exprStmt",
        expr: {
          kind: "callValue",
          callee: { kind: "varRef", localId: cbLocal.id, type: cb.type, loc },
          args: [],
          type: VOID,
          loc,
        },
        loc,
      });
      const awaitE: IrExpr = {
        kind: "awaitExpr",
        value: { kind: "varRef", localId: pLocal.id, type: promT, loc },
        type: inner,
        loc,
      };
      const tryBody: IrStmt[] = [];
      if (inner.kind === "void") {
        tryBody.push({ kind: "exprStmt", expr: awaitE, loc });
        tryBody.push(cbCall());
        tryBody.push({ kind: "return", value: null, loc });
      } else {
        const vLocal = lowerer.declareHiddenLocal("v", inner);
        tryBody.push({ kind: "varDecl", localId: vLocal.id, init: awaitE, loc });
        tryBody.push(cbCall());
        tryBody.push({
          kind: "return",
          value: { kind: "varRef", localId: vLocal.id, type: inner, loc },
          loc,
        });
      }
      // catch (e) { cb(); throw e; } — a throwing callback replaces the
      // in-flight rejection, exactly the spec's onFinally rule.
      const eLocal = lowerer.declareHiddenLocal("e", CAUGHT);
      const catchBody: IrStmt[] = [cbCall(), { kind: "rethrow", localId: eLocal.id, loc }];
      const ctx = lowerer.ctx;
      const lifted: IrFunction = {
        name: fnName,
        params: [
          { localId: pLocal.id, name: pLocal.name, type: promT },
          { localId: cbLocal.id, name: cbLocal.name, type: cb.type },
        ],
        returnType: inner,
        locals: ctx.locals,
        captures: ctx.captures!,
        body: [
          { kind: "tryCatch", tryBody, catchBody, catchLocalId: eLocal.id, finallyBody: null, loc },
        ],
        loc,
        async: true,
      };
      lowerer.liftedFns.push(lifted);
      const closure: IrExpr = {
        kind: "closure",
        fnName,
        captures: ctx.captureSources,
        type: funcType,
        loc,
      };
      return { kind: "callValue", callee: closure, args: [receiver, cb], type: promT, loc };
    } finally {
      lowerer.fnStack.pop();
    }
  }

  // .catch on a DYN-SETTLING promise (the tracePromise result's
  // `.catch((e) => ...)`): the rejection reason is a dyn value, so the
  // handler runs through the checked-dynamic tree — a lifted async helper awaits the
  // receiver, passes fulfillments through as dyn, and on rejection
  // calls the boxed handler with caughtToDyn's identity-preserving
  // snapshot (the dyn-then desugar's catch twin).
  if (
    member === "catch" &&
    (inner.kind === "dyn" ||
      (isJsSourceFile(ts.getSourceFileOfNode(call)) &&
        (inner.kind === "void" || lowerer.dynConvertible(inner))))
  ) {
    let cb = lowerer.lowerExpr(call.arguments.nodes[0]!);
    if (
      cb.type.kind === "func" &&
      canBoxFuncIntoDyn(
        cb.type,
        (id) => lowerer.shapes.get(id),
        (id) => lowerer.unions.get(id),
      )
    ) {
      cb = { kind: "dynFrom", value: cb, type: DYN, loc };
    }
    if (cb.type.kind === "dyn") {
      const resultT: IrType & { kind: "promise" } = { kind: "promise", inner: DYN };
      const fnName = lowerer.closureName(loc, "_catchdyn");
      const funcType: IrType & { kind: "func" } = {
        kind: "func",
        params: [promT, DYN],
        ret: resultT,
      };
      const fnCtx = newFnCtx(true, null, funcType, DYN);
      fnCtx.isAsync = true;
      lowerer.fnStack.push(fnCtx);
      try {
        const pLocal = lowerer.declareHiddenLocal("p", promT);
        const cbLocal = lowerer.declareHiddenLocal("cb", DYN);
        const eLocal = lowerer.declareHiddenLocal("e", CAUGHT);
        const vLocal = inner.kind === "void" ? null : lowerer.declareHiddenLocal("v", inner);
        const awaited: IrExpr = {
          kind: "awaitExpr",
          value: { kind: "varRef", localId: pLocal.id, type: promT, loc },
          type: inner,
          loc,
        };
        const tryBody: IrStmt[] = [
          vLocal
            ? { kind: "varDecl", localId: vLocal.id, init: awaited, loc }
            : { kind: "exprStmt", expr: awaited, loc },
          {
            kind: "return",
            value: vLocal
              ? lowerer.coerceToExpected(varRef(vLocal.id, inner, loc), DYN)
              : dynUndefinedExpr(loc),
            loc,
          },
        ];
        const catchBody: IrStmt[] = [
          {
            kind: "return",
            value: {
              kind: "dynCall",
              callee: { kind: "varRef", localId: cbLocal.id, type: DYN, loc },
              calleeName: jsFuncNameOf(call.arguments.nodes[0]!, lowerer) ?? "onRejected",
              args: [
                {
                  kind: "caughtToDyn",
                  value: { kind: "varRef", localId: eLocal.id, type: CAUGHT, loc },
                  type: DYN,
                  loc,
                },
              ],
              type: DYN,
              loc,
            },
            loc,
          },
        ];
        const body: IrStmt[] = [
          { kind: "tryCatch", tryBody, catchBody, catchLocalId: eLocal.id, finallyBody: null, loc },
        ];
        const ctx = lowerer.ctx;
        const lifted: IrFunction = {
          name: fnName,
          params: [
            { localId: pLocal.id, name: pLocal.name, type: promT },
            { localId: cbLocal.id, name: cbLocal.name, type: DYN },
          ],
          returnType: DYN,
          locals: ctx.locals,
          captures: ctx.captures!,
          body,
          loc,
          async: true,
        };
        lowerer.liftedFns.push(lifted);
        const closure: IrExpr = {
          kind: "closure",
          fnName,
          captures: ctx.captureSources,
          type: funcType,
          loc,
        };
        return { kind: "callValue", callee: closure, args: [receiver, cb], type: resultT, loc };
      } finally {
        lowerer.fnStack.pop();
      }
    }
  }

  // .catch: the handler must be INLINE — its parameter becomes the
  // catch binding.
  let handlerNode: ts.Expression = call.arguments.nodes[0]!;
  while (ts.isParenthesizedExpression(handlerNode)) handlerNode = handlerNode.expression;
  if (!ts.isArrowFunction(handlerNode) && !ts.isFunctionExpression(handlerNode)) {
    lowerer.unsupported(
      "SC1090",
      call.arguments.nodes[0]!,
      "catch handlers that are not inline function literals (the handler's parameter " +
        "becomes a typed-catch binding, which only an inline `(e) => ...` can receive)",
    );
  }
  if (handlerNode.modifiers?.nodes.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) {
    lowerer.unsupported("SC1090", handlerNode, "async catch handlers");
  }
  if (handlerNode.parameters.nodes.length > 1) {
    lowerer.unsupported("SC1090", handlerNode, "catch handlers with more than one parameter");
  }
  const param = handlerNode.parameters.nodes[0];
  if (param && (!ts.isIdentifier(param.name) || param.dotDotDotToken || param.initializer)) {
    lowerer.unsupported("SC1062", param);
  }
  if (
    param?.type &&
    param.type.kind !== ts.SyntaxKind.AnyKeyword &&
    param.type.kind !== ts.SyntaxKind.UnknownKeyword
  ) {
    lowerer.unsupported(
      "SC1090",
      param,
      "catch handlers with a typed parameter (the reject payload can be any thrown " +
        "value — take `(e)` or `(e: unknown)` and narrow with instanceof)",
    );
  }
  const resultT = lowerer.mapTypeOf(lowerer.typeOf(call));
  if (resultT?.kind !== "promise") {
    lowerer.noLowering(
      "catch with this handler's result type",
      call,
      "the combined result must be representable — a handler with no return value over a " +
        "non-void promise makes the result 'T | void': return a fallback of the promise's " +
        "own type, or annotate the handler `(): undefined =>` for the T | undefined result",
    );
  }
  const R = resultT.inner;
  const fnName = lowerer.closureName(loc, "_catch");
  const funcType: IrType & { kind: "func" } = { kind: "func", params: [promT], ret: resultT };
  const fnCtx = newFnCtx(true, null, funcType, R);
  fnCtx.isAsync = true;
  lowerer.fnStack.push(fnCtx);
  try {
    const pLocal = lowerer.declareHiddenLocal("p", promT);
    const awaitE: IrExpr = {
      kind: "awaitExpr",
      value: { kind: "varRef", localId: pLocal.id, type: promT, loc },
      type: inner,
      loc,
    };
    const tryBody: IrStmt[] =
      R.kind === "void"
        ? [
            { kind: "exprStmt", expr: awaitE, loc },
            { kind: "return", value: null, loc },
          ]
        : [{ kind: "return", value: lowerer.coerceInto(call, awaitE, R), loc }];
    // The handler body lowers as the catch clause, its parameter bound
    // as the CAUGHT local — exactly `catch (e) { ... }`.
    let catchLocalId: string | null = null;
    let catchBody: IrStmt[];
    lowerer.scopes.push(new Map());
    try {
      if (param && ts.isIdentifier(param.name)) {
        catchLocalId = lowerer.declareLocal(param.name, param.name.text, CAUGHT, false).id;
      }
      const hb = handlerNode.body;
      if (ts.isBlock(hb)) {
        catchBody = lowerer.lowerStmts(hb.statements.nodes);
      } else if (R.kind === "void") {
        catchBody = [{ kind: "exprStmt", expr: lowerer.lowerExpr(hb), loc: locOf(hb) }];
      } else {
        // Bare-expression handler: `(e) => v` (promise results flatten
        // through the async-return path, like any `return v`).
        catchBody = [{ kind: "return", value: lowerer.lowerReturnValue(hb), loc: locOf(hb) }];
      }
    } finally {
      lowerer.scopes.pop();
    }
    // A handler falling off its end resolves with undefined — the
    // checker already typed R with the undefined arm; the appended wrap
    // also satisfies the validator's always-returns analysis.
    if (R.kind === "union") {
      const def = lowerer.unions.get(R.unionId);
      const undefTag = def ? def.arms.findIndex((a) => a.kind === "undefinedT") : -1;
      if (undefTag >= 0) {
        catchBody.push({
          kind: "return",
          value: {
            kind: "unionWrap",
            unionId: R.unionId,
            tag: undefTag,
            value: { kind: "unitLit", unit: "undefined", type: UNDEFINED_T, loc },
            type: R,
            loc,
          },
          loc,
        });
      }
    } else if (R.kind === "void") {
      catchBody.push({ kind: "return", value: null, loc });
    } else if (R.kind === "dyn") {
      // A checked-dynamic result (the dyn-handler .then's promise-of-dyn
      // chained into .catch): falling off the handler's end resolves
      // with the dyn undefined.
      catchBody.push({ kind: "return", value: dynUndefinedExpr(loc), loc });
    }
    const ctx = lowerer.ctx;
    const lifted: IrFunction = {
      name: fnName,
      params: [{ localId: pLocal.id, name: pLocal.name, type: promT }],
      returnType: R,
      locals: ctx.locals,
      captures: ctx.captures!,
      body: [{ kind: "tryCatch", tryBody, catchBody, catchLocalId, finallyBody: null, loc }],
      loc,
      async: true,
    };
    lowerer.liftedFns.push(lifted);
    const closure: IrExpr = {
      kind: "closure",
      fnName,
      captures: ctx.captureSources,
      type: funcType,
      loc,
    };
    return { kind: "callValue", callee: closure, args: [receiver], type: resultT, loc };
  } finally {
    lowerer.fnStack.pop();
  }
}

/** NARROWING `a.filter(...)` — the two callback forms whose result the
 * checker types as a NARROWER array than the receiver:
 *
 *   xs.filter((x) => x !== undefined)   // TS-inferred type predicate
 *   xs.filter(Boolean)                  // BooleanConstructor overload
 *
 * Trust discipline: only tests the RUNTIME actually performs may re-tag.
 * An INFERRED predicate (inline arrow/function expression with no return
 * annotation — TS 5.5 only infers `x is T` when the body proves it) and
 * `Boolean` (retained elements are truthy, hence never the undefined/
 * null arm) both qualify; a HAND-WRITTEN `x is T` annotation is an
 * unchecked assertion (a lying one would corrupt the extraction) and
 * stays fenced. The narrowed element must be a SINGLE arm of the
 * receiver's union — retained elements re-tag through unionNarrow in the
 * synthesized loop; a multi-arm target would need the union-to-union
 * re-tag that doesn't exist (fenced with the annotate-the-callback
 * escape). Null hands non-narrowing filters to the generic HOF path. */
export function lowerFilterNarrowCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (call.questionDotToken || access.questionDotToken) return null;
  if (access.name.text !== "filter") return null;
  if (lowerer.chainBlocked(access, call)) return null;
  const receiverIr = lowerer.mapTypeOf(lowerer.typeOf(access.expression));
  if (receiverIr?.kind !== "array") return null;
  if (!lowerer.isStdlibMember(access)) return null;
  if (call.arguments.nodes.length !== 1) return null; // the generic path's arity fence
  const elem = receiverIr.elem;
  const argNode = call.arguments.nodes[0]!;
  const loc = locOf(call);

  const isBooleanArg =
    ts.isIdentifier(argNode) &&
    argNode.text === "Boolean" &&
    lowerer.isStdlibSymbol(lowerer.resolveValueSymbol(argNode) ?? undefined);

  // The checker's verdict on the call: filter(Boolean) and predicate
  // callbacks type the result element NARROWER than the receiver's.
  const callT = lowerer.typeOf(call);
  const resultIr = lowerer.mapTypeOf(callT);
  let outElem = resultIr?.kind === "array" ? resultIr.elem : null;
  if (outElem !== null && !typeEquals(outElem, elem)) {
    // An annotation pinning the receiver's own element type opts OUT of
    // the narrowing (`const kept: (Hit | undefined)[] = xs.filter(...)`):
    // tsc allows the covariant assignment, and the wide result is what
    // the desugared loop produces — the pre-predicate behavior, kept.
    const ctxIr = lowerer.mapTypeOf(lowerer.checker.getContextualType(call) ?? callT);
    if (ctxIr?.kind === "array" && typeEquals(ctxIr.elem, elem)) outElem = elem;
  }
  const narrowed = outElem !== null && !typeEquals(outElem, elem);
  if (!narrowed && !isBooleanArg) return null;
  // A written predicate (`(p): p is Cat => ...`, a guard function value)
  // proves nothing at run time: the generic array HOF path filters the
  // receiver's elements and converts the kept ones checked
  // (filterResultElem).
  if (
    !isBooleanArg &&
    ((!ts.isArrowFunction(argNode) && !ts.isFunctionExpression(argNode)) || argNode.type)
  )
    return null;

  const annotateEscape =
    "keep the receiver's element type instead — annotate the callback's return ': boolean' " +
    "(the checker then skips the predicate) or annotate the result with the receiver's own " +
    "element type — and narrow the elements after";
  let tag: number | null = null;
  if (narrowed) {
    if (outElem === null || elem.kind !== "union") {
      lowerer.badType(call, callT); // defensive: a narrowed non-union receiver
    }
    tag = lowerer.armTag(elem.unionId, outElem);
    // Several kept arms: the generic path converts the kept elements to
    // the narrower union (filterResultElem).
    if (tag < 0 && !isBooleanArg) return null;
    if (tag < 0) {
      lowerer.unsupported(
        "SC1090",
        call,
        `'.filter' narrowing '${lowerer.fmt(elem)}' elements to the multi-arm '${lowerer.fmt(outElem)}' ` +
          `(only a SINGLE arm re-tags — ${annotateEscape})`,
      );
    }
  }

  if (isBooleanArg) {
    // ToBoolean must be answerable per element (dyn/caught arms are not).
    if (elem.kind === "union") lowerer.requireTruthyUnion(elem.unionId, argNode);
    if (elem.kind === "dyn" || elem.kind === "void" || isUnitType(elem)) {
      lowerer.badType(argNode, lowerer.typeOf(argNode));
    }
    const receiver = lowerer.lowerExpr(access.expression);
    const helper = filterNarrowHelper(lowerer, "truthy", elem, outElem ?? elem, tag, loc);
    return { kind: "call", callee: helper, args: [receiver], type: arrayOf(outElem ?? elem), loc };
  }

  // An inferred type predicate: an inline function literal with no return
  // annotation, over parameter 0 (written predicates returned above).
  // The receiver evaluates FIRST, in the enclosing function, like JS.
  const receiver = lowerer.lowerExpr(access.expression);
  const fnArg = lowerer.lowerExpr(argNode);
  if (
    fnArg.type.kind !== "func" ||
    fnArg.type.params.length !== 1 ||
    !typeEquals(fnArg.type.params[0]!, elem) ||
    fnArg.type.ret.kind !== "bool"
  ) {
    lowerer.badType(argNode, lowerer.typeOf(argNode));
  }
  const helper = filterNarrowHelper(lowerer, "callback", elem, outElem!, tag, loc);
  return { kind: "call", callee: helper, args: [receiver, fnArg], type: arrayOf(outElem!), loc };
}

/** Interned synthetic loop for one narrowing/truthy filter combo — the
 * filter twin of arrayHofHelper, with the retained element re-tagged
 * (unionNarrow) when the output arm is narrower than the element union:
 *
 *   out = []; n = a.length;
 *   for (i = 0; i < n; i++) { v = a[i]; if (<test>) out.push(narrow(v)); }
 *   return out;
 *
 * <test> is f(v) for the predicate form and ToBoolean(v) for Boolean.
 * The re-tag is sound exactly because the test just PASSED for v: an
 * inferred predicate proved the arm dynamically, and a truthy value is
 * never the undefined/null arm. */
function filterNarrowHelper(
  lowerer: Lowerer,
  test: "callback" | "truthy",
  elem: IrType,
  outElem: IrType,
  tag: number | null,
  loc: SrcLoc,
): string {
  const key = `filterNarrow:${test}:${typeKey(elem)}:${typeKey(outElem)}`;
  const existing = lowerer.arrHofHelpers.get(key);
  if (existing) return existing;
  const name = keyedHelperName(lowerer, "%arr.filterNarrow", key);
  lowerer.arrHofHelpers.set(key, name);

  const arrT = arrayOf(elem);
  const outT = arrayOf(outElem);
  const fnT = funcOf([elem], BOOL);
  const locals: IrLocal[] = [
    { id: "a.0", name: "a", type: arrT, mutable: true },
    ...(test === "callback" ? [{ id: "f.0", name: "f", type: fnT, mutable: true } as IrLocal] : []),
    { id: "n.0", name: "n", type: F64, mutable: false },
    { id: "i.0", name: "i", type: F64, mutable: true },
    { id: "out.0", name: "out", type: outT, mutable: false },
    { id: "v.0", name: "v", type: elem, mutable: false },
  ];
  const params: IrParam[] = [
    { localId: "a.0", name: "a", type: arrT },
    ...(test === "callback" ? [{ localId: "f.0", name: "f", type: fnT }] : []),
  ];
  const v = varRef("v.0", elem, loc);
  const cond: IrExpr =
    test === "callback"
      ? { kind: "callValue", callee: varRef("f.0", fnT, loc), args: [v], type: BOOL, loc }
      : { kind: "toBool", operand: v, type: BOOL, loc };
  const kept: IrExpr =
    tag !== null && elem.kind === "union"
      ? { kind: "unionNarrow", unionId: elem.unionId, tag, value: v, type: outElem, loc }
      : v;
  const body: IrStmt[] = [
    {
      kind: "varDecl",
      localId: "out.0",
      init: { kind: "arrayLit", elems: [], type: outT, loc },
      loc,
    },
    {
      kind: "varDecl",
      localId: "n.0",
      init: {
        kind: "arrIntrinsic",
        method: "length",
        receiver: varRef("a.0", arrT, loc),
        args: [],
        type: F64,
        loc,
      },
      loc,
    },
    countedFor(loc, varRef("n.0", F64, loc), () => [
      {
        kind: "varDecl",
        localId: "v.0",
        init: {
          kind: "arrayGet",
          arr: varRef("a.0", arrT, loc),
          index: varRef("i.0", F64, loc),
          type: elem,
          loc,
        },
        loc,
      },
      {
        kind: "if",
        cond,
        then: [
          {
            kind: "exprStmt",
            expr: {
              kind: "arrIntrinsic",
              method: "push",
              receiver: varRef("out.0", outT, loc),
              args: [kept],
              type: F64,
              loc,
            },
            loc,
          },
        ],
        else_: null,
        loc,
      },
    ]),
    { kind: "return", value: varRef("out.0", outT, loc), loc },
  ];
  lowerer.liftedFns.push({ name, params, returnType: outT, locals, body, loc });
  return name;
}

/** `Object.keys(r)` / `Object.values(r)` / `Object.entries(r)` over FIXED
 * record shapes: the field list is compile-time-known, so each lowers to
 * an interned helper whose body is a sequence of pushes — no reflection,
 * no runtime walk. ORDER is the shape's first-seen DECLARATION order
 * (threaded through the shape registry), which matches Node whenever
 * objects are constructed in declaration order — the divergence for
 * reordered construction is SEMANTICS.md 36. Optional fields that are
 * absent (omitted or deleted) are SKIPPED at runtime, Node's missing key,
 * while an explicit `{ a: undefined }` is listed with its undefined
 * value. Values wrap
 * into the checker's result-element type per field; a multi-arm field
 * union that differs from the result union would need a re-tag — fenced.
 * Null when this isn't an Object static over a fixed record (index
 * signatures keep the SC2020 fence: the overflow needs a runtime walk). */
/** Statics on the global Symbol object: `Symbol.for(key)` (the global
 * registry — one interned symbol per key, identical on every call, like
 * Node across realms) and `Symbol.keyFor(sym)` (the registry key as the
 * checker's `string | undefined` — undefined for unregistered symbols).
 * Every OTHER member of SymbolConstructor is a well-known symbol
 * (Symbol.iterator, Symbol.asyncIterator, Symbol.toStringTag, ...) —
 * language-level protocol uses (for-of, template literals) already
 * compile through their constructs without reifying the symbol, so the
 * VALUE forms fence with a named message rather than a blanket
 * SymbolConstructor type fence. */
function lowerSymbolStaticCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (call.questionDotToken || access.questionDotToken) return null;
  if (!lowerer.isStdlibGlobal(access.expression, "Symbol")) return null;
  const member = access.name.text;
  const loc = locOf(call);
  if (member === "for") {
    if (call.arguments.nodes.length !== 1) {
      lowerer.noLowering(`Symbol.for with ${call.arguments.nodes.length} arguments`, call);
    }
    const key = lowerer.lowerExprExpecting(call.arguments.nodes[0]!, STRING);
    return { kind: "libCall", fn: "sym.for", args: [key], type: SYMBOL_T, loc };
  }
  if (member === "keyFor") {
    if (call.arguments.nodes.length !== 1) {
      lowerer.noLowering(`Symbol.keyFor with ${call.arguments.nodes.length} arguments`, call);
    }
    const sym = lowerer.lowerExpr(call.arguments.nodes[0]!);
    if (sym.type.kind !== "symbol") {
      lowerer.noLowering(
        `Symbol.keyFor of a '${lowerer.fmt(sym.type)}' value`,
        call.arguments.nodes[0]!,
        "the argument must be symbol-typed",
      );
    }
    // The checker types the call `string | undefined`, which interns
    // the result union (the map.get pattern); the backend builds the
    // arms from the runtime's +1-or-NULL answer.
    const type = lowerer.irTypeOf(call);
    if (type.kind !== "union") lowerer.badType(call, lowerer.typeOf(call));
    const read: IrExpr = { kind: "libCall", fn: "sym.keyFor", args: [sym], type, loc };
    return lowerer.maybeNarrow(read, call);
  }
  lowerer.unsupported(
    "SC1090",
    call,
    `well-known symbols as values (Symbol.${member} — for-of, iteration protocols, and template literals compile through their language constructs; the reified symbol has no static lowering)`,
  );
}

function lowerBigIntStaticCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (call.questionDotToken || access.questionDotToken) return null;
  if (!lowerer.isStdlibGlobal(access.expression, "BigInt")) return null;
  const name = access.name.text;
  if (name !== "asUintN" && name !== "asIntN") return null;
  if (call.arguments.nodes.length !== 2) {
    lowerer.noLowering(`BigInt.${name} with ${call.arguments.nodes.length} arguments`, call);
  }
  const loc = locOf(call);
  const bits = lowerer.lowerExprExpecting(call.arguments.nodes[0]!, F64);
  const value = lowerer.lowerExprExpecting(call.arguments.nodes[1]!, BIGINT_T);
  return {
    kind: "libCall",
    fn: name === "asUintN" ? "bigint.asUintN" : "bigint.asIntN",
    args: [bits, value],
    type: BIGINT_T,
    loc,
  };
}

function lowerBigIntMethodCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (lowerer.mapTypeOf(lowerer.typeOf(access.expression))?.kind !== "bigint") return null;
  if (!lowerer.isStdlibMember(access)) return null;
  const name = access.name.text;
  const loc = locOf(call);
  const receiver = lowerer.lowerExpr(access.expression);
  if (receiver.type.kind !== "bigint") return null;
  if (name === "valueOf" && call.arguments.nodes.length === 0) return receiver;
  if (name === "toString" && call.arguments.nodes.length <= 1) {
    const defaultRadix: IrExpr = { kind: "numLit", value: 10, type: F64, loc };
    const radix: IrExpr = call.arguments.nodes[0]
      ? lowerOptionalArgument(lowerer, call.arguments.nodes[0], F64, defaultRadix)
      : defaultRadix;
    return { kind: "libCall", fn: "bigint.toString", args: [receiver, radix], type: STRING, loc };
  }
  return null;
}

/** Method calls on symbol-typed receivers: `.toString()` is the
 * "Symbol(desc)" text (Node's Symbol.prototype.toString — note that
 * template literals and concatenation THROW in JS and stay fenced;
 * toString is the one sanctioned spelling). `.valueOf()` is the
 * identity read. */
function lowerSymbolMethodCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (lowerer.mapTypeOf(lowerer.typeOf(access.expression))?.kind !== "symbol") return null;
  if (!lowerer.isStdlibMember(access)) return null;
  const name = access.name.text;
  const loc = locOf(call);
  if (name === "toString" && call.arguments.nodes.length === 0) {
    const receiver = lowerer.lowerExpr(access.expression);
    if (receiver.type.kind !== "symbol") return null;
    return { kind: "libCall", fn: "sym.toString", args: [receiver], type: STRING, loc };
  }
  if (name === "valueOf" && call.arguments.nodes.length === 0) {
    const receiver = lowerer.lowerExpr(access.expression);
    if (receiver.type.kind !== "symbol") return null;
    return receiver;
  }
  return null; // description-as-a-call, ... → the stdlib member fence
}

/** The interned keys-array helper over a FIXED record shape: a call of a
 * lifted helper whose body pushes each declared field name in first-seen
 * DECLARATION order, skipping optional fields that are currently absent
 * (omitted or deleted — Node's missing key; a field explicitly holding
 * undefined is present and listed). ONE
 * construction, interned per shape, shared by Object.keys and for-in —
 * for-in iterates exactly the keys Object.keys answers. */
export function recordKeysArrayCall(
  lowerer: Lowerer,
  receiver: IrExpr,
  argIr: IrType & { kind: "record" },
  shape: import("../../ir/ir.js").IrRecordShape,
  loc: SrcLoc,
): IrExpr {
  const resultT = arrayOf(STRING);
  lowerer.keyOrder.observe(argIr);
  const key = `obj.keys:${argIr.shapeId}:${typeKey(resultT)}`;
  let helper = lowerer.arrHofHelpers.get(key);
  if (!helper) {
    helper = keyedHelperName(lowerer, "%obj.keys", key);
    const ref: IrExpr = { kind: "varRef", localId: "r.0", type: argIr, loc };
    const outRef: IrExpr = { kind: "varRef", localId: "out.0", type: resultT, loc };
    lowerer.arrHofHelpers.set(key, helper);
    const fn: IrFunction = {
      name: helper,
      params: [{ localId: "r.0", name: "r", type: argIr }],
      returnType: resultT,
      locals: [
        { id: "r.0", name: "r", type: argIr, mutable: true },
        { id: "out.0", name: "out", type: resultT, mutable: false },
      ],
      body: [],
      loc,
    };
    const finalize = (): void => {
      const latest = lowerer.shapes.get(argIr.shapeId);
      const current: import("../../ir/ir.js").IrRecordShape = latest !== undefined ? latest : shape;
      const body: IrStmt[] = [
        {
          kind: "varDecl",
          localId: "out.0",
          init: { kind: "arrayLit", elems: [], type: resultT, loc },
          loc,
        },
      ];
      // One walk per key order (see perKeyOrder).
      const orders = shapeKeyOrders(current);
      const walks = orders.map((): IrStmt[] => []);
      for (const [k, name] of orders.flatMap((order, k) =>
        order.map((name) => [k, name] as const),
      )) {
        const f = current.fields.find((x) => x.name === name)!;
        const pushStmt: IrStmt = {
          kind: "exprStmt",
          expr: {
            kind: "arrIntrinsic",
            method: "push",
            receiver: outRef,
            args: [{ kind: "strLit", value: f.name, type: STRING, loc }],
            type: F64,
            loc,
          },
          loc,
        };
        // Fields that can be absent push behind their presence test (the
        // key exists exactly when Object.keys would list it).
        const present = lowerer.recordFieldPresent(ref, argIr.shapeId, f.name, loc);
        walks[k]!.push(
          present.kind === "recordHas"
            ? { kind: "if", cond: present, then: [pushStmt], else_: null, loc }
            : pushStmt,
        );
      }
      body.push(...perKeyOrder(current, ref, walks, loc));
      body.push({ kind: "return", value: outRef, loc });
      fn.body = body;
    };
    finalize();
    lowerer.shapeOrderHelperFinalizers.push(finalize);
    lowerer.liftedFns.push(fn);
  }
  return { kind: "call", callee: helper, args: [receiver], type: resultT, loc };
}

/** Interned `%obj.hasOwn.<n>(r, k)` — Object.hasOwn's membership walk
 * over a record shape: the key compares against each
 * declared field name, optional fields answering by their presence
 * (a key is own exactly when Object.keys would list it — the two share
 * the test), everything else true. Unmatched keys probe the overflow
 * map when present, so explicit undefined values remain own keys. */
export function recordHasOwnHelper(lowerer: Lowerer, shapeId: string, loc: SrcLoc): string {
  const key = `obj.hasOwn:${shapeId}`;
  const existing = lowerer.arrHofHelpers.get(key);
  if (existing) return existing;
  const helper = keyedHelperName(lowerer, "%obj.hasOwn", key);
  lowerer.arrHofHelpers.set(key, helper);
  const shape = lowerer.shapes.get(shapeId)!;
  const recT: IrType = { kind: "record", shapeId };
  const rRef: IrExpr = { kind: "varRef", localId: "r.0", type: recT, loc };
  const kRef: IrExpr = { kind: "varRef", localId: "k.0", type: STRING, loc };
  const body: IrStmt[] = [];
  for (const f of shape.fields) {
    const answer = lowerer.recordFieldPresent(rRef, shapeId, f.name, loc);
    body.push({
      kind: "if",
      cond: {
        kind: "strEq",
        negated: false,
        left: kRef,
        right: { kind: "strLit", value: f.name, type: STRING, loc },
        type: BOOL,
        loc,
      },
      then: [{ kind: "return", value: answer, loc }],
      else_: null,
      loc,
    });
  }
  const fallback: IrExpr = shape.indexValue
    ? { kind: "recordOvfHas", obj: rRef, shapeId, key: kRef, type: BOOL, loc }
    : { kind: "boolLit", value: false, type: BOOL, loc };
  body.push({ kind: "return", value: fallback, loc });
  lowerer.liftedFns.push({
    name: helper,
    params: [
      { localId: "r.0", name: "r", type: recT },
      { localId: "k.0", name: "k", type: STRING },
    ],
    returnType: BOOL,
    locals: [
      { id: "r.0", name: "r", type: recT, mutable: true },
      { id: "k.0", name: "k", type: STRING, mutable: false },
    ],
    body,
    loc,
  });
  return helper;
}

/** Whether `Object.assign(instance, record)` can copy every field of the
 * record shape into a field the class declares with the same type: a plain
 * record (no tuple, index signature or accessor slots) and a compiled
 * class whose chain has no builtin or runtime-provided storage and no
 * accessor for the written names. */
function classAssignPlan(lowerer: Lowerer, className: string, srcShapeId: string): boolean {
  const info = lowerer.classes.get(className);
  const shape = lowerer.shapes.get(srcShapeId);
  if (!info || !shape || shape.tuple || shape.indexValue || shapeHasAccessorSlots(shape))
    return false;
  for (let c: ClassInfo | null = info; c; c = c.base) {
    if (c.builtinError || c.builtinEmitter || c.builtinStream !== undefined || c.def.runtime)
      return false;
  }
  return shape.fields.every((f) => {
    const declared = info.fields.get(f.name);
    return (
      declared !== undefined &&
      (typeEquals(declared, f.type) || lowerer.widthLiftPlan(f.type, declared) !== null) &&
      !lowerer.findMethodOn(info, f.name) &&
      !lowerer.findMethodOn(info, `get:${f.name}`) &&
      !lowerer.findMethodOn(info, `set:${f.name}`)
    );
  });
}

/** Interned `%obj.assignClass.<n>(o, s)` — Object.assign's per-field
 * write of a record into a class instance (classAssignPlan's gate):
 * optional source fields write only when present, and the instance
 * returns. */
function classAssignHelper(
  lowerer: Lowerer,
  className: string,
  srcShapeId: string,
  loc: SrcLoc,
): string | null {
  if (!classAssignPlan(lowerer, className, srcShapeId)) return null;
  const key = `obj.assignClass:${className}:${srcShapeId}`;
  const existing = lowerer.arrHofHelpers.get(key);
  if (existing) return existing;
  const helper = keyedHelperName(lowerer, "%obj.assignClass", key);
  lowerer.arrHofHelpers.set(key, helper);
  const sShape = lowerer.shapes.get(srcShapeId)!;
  const oT: IrType = { kind: "object", className };
  const sT: IrType = { kind: "record", shapeId: srcShapeId };
  const oRef: IrExpr = { kind: "varRef", localId: "o.0", type: oT, loc };
  const sRef: IrExpr = { kind: "varRef", localId: "s.0", type: sT, loc };
  const body: IrStmt[] = [];
  const info = lowerer.classes.get(className)!;
  for (const f of sShape.fields) {
    const declared = info.fields.get(f.name)!;
    const read: IrExpr = {
      kind: "recordGet",
      obj: sRef,
      shapeId: srcShapeId,
      field: f.name,
      type: f.type,
      loc,
    };
    const lift = typeEquals(declared, f.type) ? null : lowerer.widthLiftPlan(f.type, declared);
    const set: IrStmt = {
      kind: "fieldSet",
      obj: oRef,
      className,
      field: f.name,
      value: lift === null ? read : lowerer.applyWidthLift(lift, read, declared, loc),
      loc,
    };
    const present = lowerer.recordFieldPresent(sRef, srcShapeId, f.name, loc);
    body.push(
      present.kind === "recordHas"
        ? { kind: "if", cond: present, then: [set], else_: null, loc }
        : set,
    );
  }
  body.push({ kind: "return", value: oRef, loc });
  lowerer.liftedFns.push({
    name: helper,
    params: [
      { localId: "o.0", name: "o", type: oT },
      { localId: "s.0", name: "s", type: sT },
    ],
    returnType: oT,
    locals: [
      { id: "o.0", name: "o", type: oT, mutable: true },
      { id: "s.0", name: "s", type: sT, mutable: true },
    ],
    body,
    loc,
  });
  return helper;
}

/** Interned `%obj.assign.<n>(t, s)` — Object.assign's per-field copy
 * over signature-free records (every source field lands on a same-named,
 * same-typed target field — the caller's gate): optional source fields
 * copy only when present (an explicit undefined copies), everything else
 * straight,
 * and the TARGET returns (JS's aliasing). */
function recordAssignHelper(
  lowerer: Lowerer,
  targetShapeId: string,
  srcShapeId: string,
  loc: SrcLoc,
): string {
  const key = `obj.assign:${targetShapeId}:${srcShapeId}`;
  const existing = lowerer.arrHofHelpers.get(key);
  if (existing) return existing;
  const helper = keyedHelperName(lowerer, "%obj.assign", key);
  lowerer.arrHofHelpers.set(key, helper);
  const sShape = lowerer.shapes.get(srcShapeId)!;
  const tShape = lowerer.shapes.get(targetShapeId)!;
  const tT: IrType = { kind: "record", shapeId: targetShapeId };
  const sT: IrType = { kind: "record", shapeId: srcShapeId };
  const tRef: IrExpr = { kind: "varRef", localId: "t.0", type: tT, loc };
  const sRef: IrExpr = { kind: "varRef", localId: "s.0", type: sT, loc };
  const body: IrStmt[] = [];
  for (const f of sShape.fields) {
    const get: IrExpr = {
      kind: "recordGet",
      obj: sRef,
      shapeId: srcShapeId,
      field: f.name,
      type: f.type,
      loc,
    };
    const targetType = tShape.fields.find((x) => x.name === f.name)!.type;
    const set: IrStmt = {
      kind: "recordSet",
      obj: tRef,
      shapeId: targetShapeId,
      field: f.name,
      value: typeEquals(targetType, f.type) ? get : lowerer.coerceToExpected(get, targetType),
      loc,
    };
    const present = lowerer.recordFieldPresent(sRef, srcShapeId, f.name, loc);
    body.push(
      present.kind === "recordHas"
        ? { kind: "if", cond: present, then: [set], else_: null, loc }
        : set,
    );
  }
  body.push({ kind: "return", value: tRef, loc });
  lowerer.liftedFns.push({
    name: helper,
    params: [
      { localId: "t.0", name: "t", type: tT },
      { localId: "s.0", name: "s", type: sT },
    ],
    returnType: tT,
    locals: [
      { id: "t.0", name: "t", type: tT, mutable: true },
      { id: "s.0", name: "s", type: sT, mutable: true },
    ],
    body,
    loc,
  });
  return helper;
}

/** The `Iterator` global's statics (ES2025): `Iterator.from` over a typed
 * built-in iterable lowers (lowerIteratorFromCall); every other member,
 * and other arguments, fence with the working spelling named instead of
 * the generic-method fence's monomorphization wording. */
function lowerIteratorStaticFence(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (!lowerer.isStdlibGlobal(access.expression, "Iterator")) return null;
  if (!lowerer.isStdlibMember(access)) return null;
  const from = lowerIteratorFromCall(lowerer, call, access);
  if (from) return from;
  lowerer.noLowering(
    `Iterator.${access.name.text}`,
    call,
    access.name.text === "from"
      ? "Iterator.from accepts arrays, strings, typed arrays, Sets, Maps and iterator objects such as generators"
      : "iterator helpers apply directly to generators and to array, Map and Set iterators: " +
          "arr.values().map(f).take(n).toArray()",
  );
}

/** `RegExp.escape(s)` (ES2025) — the one RegExp static with a lowering:
 * a total string→string libCall (scr_regexp_escape). The lib pins the
 * argument to string, so the only unlowered shape is a non-string-typed
 * lowering (dyn/union), which fences. Null for other RegExp members
 * (the stdlib member fence names them). */
function lowerRegExpStaticCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (call.questionDotToken || access.questionDotToken) return null;
  if (!lowerer.isStdlibGlobal(access.expression, "RegExp")) return null;
  if (access.name.text !== "escape") return null;
  if (!lowerer.isStdlibMember(access)) return null;
  if (call.arguments.nodes.length !== 1 || ts.isSpreadElement(call.arguments.nodes[0]!)) {
    lowerer.noLowering(`RegExp.escape with ${call.arguments.nodes.length} arguments`, call);
  }
  const arg = lowerer.lowerExprExpecting(call.arguments.nodes[0]!, STRING);
  if (arg.type.kind !== "string")
    lowerer.badType(call.arguments.nodes[0]!, lowerer.typeOf(call.arguments.nodes[0]!));
  return { kind: "libCall", fn: "regexp.escape", args: [arg], type: STRING, loc: locOf(call) };
}

/** The composed en-US Intl.NumberFormat form: `new Intl.NumberFormat(
 * "en-US").format(x)` (and the callable spelling without `new` — the
 * spec makes them the same formatter). Only the COMPOSED form lowers —
 * formatter values have no representation — and only the one locale
 * whose data the runtime embeds, with default options: decimal
 * notation, 0–3 fraction digits rounded half-up on the shortest
 * round-tripping decimal (ICU's rounding input — format(1.0005) is
 * "1.001" though toFixed(3) answers "1.000"), "," grouping. The
 * unlowered forms fence by NAME (no locale — the host environment's
 * default, which a compiled binary cannot carry; other locales — ICU
 * data the binary does not embed; options bags; non-number arguments).
 * Null when the callee isn't a NumberFormat-construction .format. */
function lowerIntlNumberFormatCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (call.questionDotToken || access.questionDotToken) return null;
  if (access.name.text !== "format") return null;
  let recv: ts.Expression = access.expression;
  while (ts.isParenthesizedExpression(recv)) recv = recv.expression;
  let ctorArgs: readonly ts.Expression[];
  if (ts.isNewExpression(recv) || (ts.isCallExpression(recv) && !recv.questionDotToken)) {
    const ctor = recv.expression;
    if (
      !ts.isPropertyAccessExpression(ctor) ||
      ctor.questionDotToken ||
      ctor.name.text !== "NumberFormat" ||
      !lowerer.isStdlibGlobal(ctor.expression, "Intl")
    ) {
      return null;
    }
    ctorArgs = recv.arguments?.nodes ?? [];
  } else {
    return null;
  }
  const loc = locOf(call);
  if (ctorArgs.length === 0) {
    lowerer.noLowering(
      "Intl.NumberFormat without a locale",
      recv,
      "the default locale is the host environment's, which a compiled binary cannot carry — " +
        'pass it explicitly: new Intl.NumberFormat("en-US").format(x)',
    );
  }
  if (ctorArgs.length > 1) {
    lowerer.noLowering(
      "Intl.NumberFormat with an options bag",
      ctorArgs[1]!,
      "the embedded data covers DEFAULT options only (decimal notation, up to 3 fraction digits, " +
        'grouping) — new Intl.NumberFormat("en-US").format(x)',
    );
  }
  const locArg = ctorArgs[0]!;
  if (ts.isSpreadElement(locArg) || !ts.isStringLiteralLike(locArg) || locArg.text !== "en-US") {
    lowerer.noLowering(
      !ts.isSpreadElement(locArg) && ts.isStringLiteralLike(locArg)
        ? `Intl.NumberFormat at locale "${locArg.text}"`
        : "Intl.NumberFormat with a non-literal locale",
      locArg,
      '"en-US" (Node\'s default-build locale) is the one locale whose data the runtime embeds — ' +
        "everything else is ICU data the binary does not carry",
    );
  }
  if (call.arguments.nodes.length !== 1 || ts.isSpreadElement(call.arguments.nodes[0]!)) {
    lowerer.noLowering(
      `Intl.NumberFormat("en-US").format with ${call.arguments.nodes.length} arguments`,
      call,
    );
  }
  const argNode = call.arguments.nodes[0]!;
  if (lowerer.mapTypeOf(lowerer.typeOf(argNode))?.kind !== "f64") {
    lowerer.noLowering(
      `Intl.NumberFormat("en-US").format over a '${lowerer.checker.typeToString(lowerer.typeOf(argNode))}'`,
      argNode,
      "a number argument is the lowered form (bigint and numeric-string inputs have no representation)",
    );
  }
  const arg = lowerer.lowerExprExpecting(argNode, F64);
  if (arg.type.kind !== "f64") lowerer.badType(argNode, lowerer.typeOf(argNode));
  return { kind: "libCall", fn: "intl.numFormatEnUs", args: [arg], type: STRING, loc };
}

/** Object.is over statically disjoint kinds: the constant false, with
 * both operands still evaluated for their effects (droppable statics
 * fold away — JS evaluates arguments, but nothing observes a pure one). */
function objectIsDisjointFalse(left: IrExpr, right: IrExpr, loc: SrcLoc): IrExpr {
  const stmts: IrStmt[] = [];
  for (const e of [left, right]) {
    if (!isSafeToDiscard(e)) stmts.push({ kind: "exprStmt", expr: e, loc });
  }
  const answer: IrExpr = { kind: "boolLit", value: false, type: BOOL, loc };
  if (stmts.length === 0) return answer;
  return { kind: "seqExpr", stmts, result: answer, type: BOOL, loc };
}

/** A native [string, any][]: the result Object.entries builds directly
 * from a checked-dynamic value's pairs (dyn.objEntryPairs). */
function isDynEntryPairsType(lowerer: Lowerer, t: IrType): boolean {
  if (t.kind !== "array" || t.elem.kind !== "record") return false;
  const shape = lowerer.shapes.get(t.elem.shapeId);
  if (!shape?.tuple || shape.indexValue || shape.fields.length !== 2) return false;
  const field = (name: string): IrType | undefined =>
    shape.fields.find((f) => f.name === name)?.type;
  return field("0")?.kind === "string" && field("1")?.kind === "dyn";
}

function lowerObjectStaticCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (call.questionDotToken || access.questionDotToken) return null;
  if (!lowerer.isStdlibGlobal(access.expression, "Object")) return null;
  const member = access.name.text;
  // `Object.getOwnPropertyDescriptor(Error, "stackTraceLimit")` (Effect's
  // isStackTraceLimitWritable): Error's own writable, enumerable,
  // configurable data property holding the current limit. The interned
  // Error value models no other statics (builtinGlobalValueAt).
  const [first, second] = call.arguments.nodes;
  if (
    member === "getOwnPropertyDescriptor" &&
    call.arguments.nodes.length === 2 &&
    lowerer.isStdlibGlobal(first!, "Error") &&
    ts.isStringLiteralLike(second!) &&
    second.text === "stackTraceLimit"
  ) {
    const loc = locOf(call);
    const dyn = (value: IrExpr): IrExpr => ({ kind: "dynFrom", value, type: DYN, loc });
    const yes = dyn({ kind: "boolLit", value: true, type: BOOL, loc });
    const limit: IrExpr = { kind: "libCall", fn: "error.stackLimitGet", args: [], type: F64, loc };
    return {
      kind: "dynObjLit",
      fields: [
        { key: { kind: "strLit", value: "value", type: STRING, loc }, value: dyn(limit) },
        ...["writable", "enumerable", "configurable"].map((key) => ({
          key: { kind: "strLit" as const, value: key, type: STRING, loc },
          value: yes,
        })),
      ],
      type: DYN,
      loc,
    };
  }
  if (
    (member === "getOwnPropertyNames" ||
      member === "getOwnPropertySymbols" ||
      member === "getOwnPropertyDescriptors") &&
    call.arguments.nodes.length === 1 &&
    !call.arguments.nodes.some(ts.isSpreadElement)
  ) {
    let object = lowerer.lowerExpr(call.arguments.nodes[0]!);
    if (
      object.type.kind === "string" ||
      object.type.kind === "f64" ||
      object.type.kind === "bool" ||
      isUnitType(object.type)
    )
      object = { kind: "dynFrom", value: object, type: DYN, loc: locOf(call) };
    if (object.type.kind === "dyn")
      return {
        kind: "libCall",
        fn:
          member === "getOwnPropertyNames"
            ? "dyn.getOwnPropertyNames"
            : member === "getOwnPropertySymbols"
              ? "dyn.getOwnPropertySymbols"
              : "dyn.getOwnPropertyDescriptors",
        args: [object],
        type: DYN,
        loc: locOf(call),
      };
  }
  if (
    (member === "getPrototypeOf" || member === "setPrototypeOf") &&
    call.arguments.nodes.length === (member === "getPrototypeOf" ? 1 : 2) &&
    !call.arguments.nodes.some(ts.isSpreadElement)
  ) {
    let object = lowerer.lowerExpr(call.arguments.nodes[0]!);
    if (object.type.kind === "func") {
      const fnName = jsFuncNameOf(call.arguments.nodes[0]!, lowerer);
      object = {
        kind: "dynFrom",
        value: object,
        type: DYN,
        loc: locOf(call),
        ...(fnName !== null ? { fnName } : {}),
      };
    }
    if (
      object.type.kind !== "dyn" &&
      canConvertToDyn(
        object.type,
        (id) => lowerer.shapes.get(id),
        (id) => lowerer.unions.get(id),
      )
    )
      object = lowerer.coerceInto(call.arguments.nodes[0]!, object, DYN);
    if (object.type.kind === "dyn") {
      const loc = locOf(call);
      if (member === "getPrototypeOf") {
        let parent: ts.Node | undefined = call.parent;
        while (parent && ts.isParenthesizedExpression(parent)) parent = parent.parent;
        const identityOnly =
          !!parent &&
          ts.isBinaryExpression(parent) &&
          [
            ts.SyntaxKind.EqualsEqualsEqualsToken,
            ts.SyntaxKind.ExclamationEqualsEqualsToken,
          ].includes(parent.operatorToken.kind);
        return {
          kind: "libCall",
          fn: "dyn.getPrototype",
          args: [object],
          type: DYN,
          loc,
          ...(identityOnly ? { prototypeIdentityOnly: true as const } : {}),
        };
      }
      const prototype = lowerer.lowerExprExpecting(call.arguments.nodes[1]!, DYN);
      if (prototype.type.kind === "dyn")
        return {
          kind: "libCall",
          fn: "dyn.setPrototype",
          args: [object, prototype],
          type: DYN,
          loc,
        };
    }
  }
  if (member === "getOwnPropertyDescriptor" && call.arguments.nodes.length === 2) {
    const [receiver, key] = call.arguments.nodes;
    if (
      receiver &&
      key &&
      ts.isPropertyAccessExpression(receiver) &&
      receiver.name.text === "prototype" &&
      lowerer.isStdlibGlobal(receiver.expression, "ArrayBuffer") &&
      ts.isStringLiteral(key) &&
      key.text === "byteLength"
    ) {
      const loc = locOf(call);
      const getter = lowerer.lowerNativeCallableValue(
        { fn: "arrayBuffer.byteLengthGetter", params: [], result: F64, valueParams: [] },
        "get ArrayBuffer.prototype.byteLength",
        loc,
      )!;
      return {
        kind: "libCall",
        fn: "arrayBuffer.byteLengthDescriptor",
        args: [lowerer.coerceToExpected(getter, DYN)],
        type: DYN,
        loc,
      };
    }
  }

  const cacheKeys = lowerRequireCacheKeys(lowerer, call, member);
  if (cacheKeys) return cacheKeys;
  // Object.is — the spec's SameValue over the static kinds. Number
  // pairs take the runtime SameValue (NaN equals NaN, +0 differs from
  // -0 — the two divergences from ===); every other supported pair
  // rides exactly the strict-equality machinery, whose answers
  // SameValue shares: strings by bytes, bools by value, unit literals
  // by tag, unions per arm (a number arm's payload compare upgrades to
  // SameValue via unionEq's flag), and the reference kinds by pointer
  // identity. Statically DISJOINT kind pairs answer the constant false
  // with the operands still evaluated (tsc admits any pair — Object.is
  // is (any, any) — and JS evaluates the arguments either way).

  if (member === "is") {
    if (
      call.arguments.nodes.length !== 2 ||
      call.arguments.nodes.some((a) => ts.isSpreadElement(a))
    ) {
      lowerer.noLowering(
        `Object.is with ${call.arguments.nodes.length} arguments`,
        call,
        "exactly two arguments are the lowered form (JS treats a missing one as undefined — pass it explicitly)",
      );
    }
    const loc = locOf(call);
    const leftNode = call.arguments.nodes[0]!;
    const rightNode = call.arguments.nodes[1]!;
    const left = lowerer.lowerExpr(leftNode);
    const right = lowerer.lowerExpr(rightNode);
    const lk = left.type.kind;
    const rk = right.type.kind;
    if (lk === "f64" && rk === "f64") {
      return { kind: "libCall", fn: "num.sameValue", args: [left, right], type: BOOL, loc };
    }
    if (left.type.kind === "string" && right.type.kind === "string") {
      return { kind: "strEq", negated: false, left, right, type: BOOL, loc };
    }
    if (lk === "bool" && rk === "bool") {
      return { kind: "bin", op: "===", left, right, type: BOOL, loc };
    }
    const unitTest = lowerer.lowerUnitComparison(left, right, false, loc);
    if (unitTest) return unitTest;
    if (lk === "dyn" || rk === "dyn") {
      return {
        kind: "libCall",
        fn: "dyn.sameValue",
        args: [lowerer.coerceInto(leftNode, left, DYN), lowerer.coerceInto(rightNode, right, DYN)],
        type: BOOL,
        loc,
      };
    }
    if (left.type.kind === "union" || right.type.kind === "union") {
      const compared = lowerUnionEquality(lowerer, left, right, false, true, loc);
      if (compared) return compared;

      const ut =
        left.type.kind === "union" ? left.type : (right.type as IrType & { kind: "union" });
      const bothUnion = left.type.kind === "union" && right.type.kind === "union";
      const sameUnion = bothUnion && typeEquals(left.type, right.type);
      if ((sameUnion || !bothUnion) && lowerer.eqComparableUnion(ut.unionId)) {
        const plain = left.type.kind === "union" ? right : left;
        const arms = lowerer.unions.get(ut.unionId)?.arms ?? [];
        // The plain side wraps into the union exactly like === when the
        // union holds its type, or when a plain class instance upcasts
        // into exactly one class arm (the same pointer under a base tag);
        // a plain PRIMITIVE the union has no arm for is the disjoint
        // constant false (coercing it would strand).
        const plainType = plain.type;
        const upcastArm =
          plainType.kind === "object" &&
          arms.filter(
            (a) => a.kind === "object" && lowerer.isSubclassOf(plainType.className, a.className),
          ).length === 1;
        if (bothUnion || upcastArm || arms.some((a) => typeEquals(a, plain.type))) {
          if (tagEqualityMayMissAlias(lowerer, ut))
            lowerer.noLowering(
              "Object.is over related class values beside structural union members",
              call,
              NARROW_FIRST,
            );
          const sameValue = arms.some((a) => a.kind === "f64");
          return {
            kind: "unionEq",
            unionId: ut.unionId,
            negated: false,
            sameValue,
            left: lowerer.coerceInto(leftNode, left, ut),
            right: lowerer.coerceInto(rightNode, right, ut),
            type: BOOL,
            loc,
          };
        }
        if (
          plain.type.kind === "f64" ||
          plain.type.kind === "string" ||
          plain.type.kind === "bool" ||
          isUnitType(plain.type)
        ) {
          return objectIsDisjointFalse(left, right, loc);
        }
      }
      lowerer.noLowering(
        "Object.is over these union operands",
        call,
        `union-typed comparisons need one comparable shape (${NARROW_FIRST})`,
      );
    }
    // Reference kinds: pointer identity — exactly strict equality
    // (hierarchy-related classes widen the derived side first).
    let idLeft = left;
    let idRight = right;
    if (left.type.kind === "object" && right.type.kind === "object") {
      if (lowerer.isSubclassOf(left.type.className, right.type.className)) {
        idLeft = lowerer.upcastTo(left, right.type.className);
      } else if (lowerer.isSubclassOf(right.type.className, left.type.className)) {
        idRight = lowerer.upcastTo(right, left.type.className);
      }
    }
    if (
      (idLeft.type.kind === "func" && idRight.type.kind === "func") ||
      (idLeft.type.kind === "classval" && idRight.type.kind === "classval")
    ) {
      return { kind: "bin", op: "===", left: idLeft, right: idRight, type: BOOL, loc };
    }
    if (
      (idLeft.type.kind === "array" ||
        idLeft.type.kind === "map" ||
        idLeft.type.kind === "set" ||
        idLeft.type.kind === "object" ||
        idLeft.type.kind === "record" ||
        idLeft.type.kind === "symbol" ||
        idLeft.type.kind === "bytes" ||
        idLeft.type.kind === "promise") &&
      typeEquals(idLeft.type, idRight.type)
    ) {
      return { kind: "bin", op: "===", left: idLeft, right: idRight, type: BOOL, loc };
    }
    // Statically disjoint pairs with a primitive/unit side: SameValue
    // never crosses kinds, so the answer is the constant false.
    const disjoint = new Set(["f64", "string", "bool", "undefinedT", "nullT"]);
    if (lk !== rk && (disjoint.has(lk) || disjoint.has(rk))) {
      return objectIsDisjointFalse(left, right, loc);
    }
    lowerer.noLowering(
      `Object.is over '${lowerer.fmt(left.type)}' and '${lowerer.fmt(right.type)}' operands`,
      call,
      "the operands must share one comparable kind (numbers, strings, booleans, units, one union shape, or one reference type)",
    );
  }
  // Native checked objects retain a live prototype and can install an
  // own-property descriptor table during creation.
  if (member === "create") {
    if (call.arguments.nodes.some((a) => ts.isSpreadElement(a))) {
      lowerer.noLowering("Object.create with spread arguments", call);
    }
    if (call.arguments.nodes.length < 1 || call.arguments.nodes.length > 2) {
      lowerer.noLowering(`Object.create with ${call.arguments.nodes.length} arguments`, call);
    }
    const loc = locOf(call);
    let protoNode: ts.Expression = call.arguments.nodes[0]!;
    while (ts.isParenthesizedExpression(protoNode)) protoNode = protoNode.expression;
    const nullProto = protoNode.kind === ts.SyntaxKind.NullKeyword;

    if (nullProto && call.arguments.nodes.length === 1) {
      return { kind: "libCall", fn: "dyn.objCreateNullProto", args: [], type: DYN, loc };
    }
    let proto = nullProto
      ? ({
          kind: "dynFrom",
          value: { kind: "unitLit", unit: "null", type: NULL_T, loc },
          type: DYN,
          loc,
        } as IrExpr)
      : ts.isObjectLiteralExpression(protoNode)
        ? lowerer.lowerExprExpecting(protoNode, DYN)
        : lowerer.lowerExpr(protoNode);
    if (
      isUnitType(proto.type) ||
      proto.type.kind === "f64" ||
      proto.type.kind === "bool" ||
      proto.type.kind === "string"
    )
      proto = { kind: "dynFrom", value: proto, type: DYN, loc };
    // Typed records, arrays and class instances stay live prototypes.
    if (
      (proto.type.kind === "record" ||
        proto.type.kind === "array" ||
        proto.type.kind === "object") &&
      canConvertToDyn(
        proto.type,
        (id) => lowerer.shapes.get(id),
        (id) => lowerer.unions.get(id),
      )
    )
      proto = lowerer.coerceInto(protoNode, proto, DYN);
    if (proto.type.kind === "dyn") {
      if (call.arguments.nodes.length === 1)
        return { kind: "libCall", fn: "dyn.objCreate", args: [proto], type: DYN, loc };
      const descriptors = lowerer.lowerExprExpecting(call.arguments.nodes[1]!, DYN);
      if (descriptors.type.kind === "dyn")
        return {
          kind: "libCall",
          fn: "dyn.objCreateWithProperties",
          args: [proto, descriptors],
          type: DYN,
          loc,
        };
    }
    lowerer.noLowering(`Object.create over '${lowerer.fmt(proto.type)}' prototypes`, call);
  }
  // `Object.assign(fn, { props })` whose RESULT type maps to the hybrid
  // (function-with-properties) record: the chalk-shape CONSTRUCTOR.
  if (member === "assign") {
    const prototype = lowerClassPrototypeAssign(lowerer, call);
    if (prototype) return prototype;
    if (
      isJsSourceFile(ts.getSourceFileOfNode(call)) &&
      call.arguments.nodes.length > 0 &&
      !call.arguments.nodes.some(ts.isSpreadElement)
    ) {
      const target = tryLowerExpression(lowerer, call.arguments.nodes[0]!);
      if (
        target &&
        ((target.type.kind === "func" && lowerer.dynConvertible(target.type)) ||
          (target.type.kind === "object" && lowerer.dynConvertible(target.type)))
      ) {
        const loc = locOf(call);
        return {
          kind: "libCall",
          fn: "dyn.assignAll",
          args: [
            lowerer.coerceToExpected(target, DYN),
            {
              kind: "dynArrLit",
              elems: call.arguments.nodes
                .slice(1)
                .map((arg) => lowerer.lowerExprExpecting(arg, DYN)),
              type: DYN,
              loc,
            },
          ],
          type: DYN,
          loc,
        };
      }
    }
    const onError = lowerObjectAssignOntoError(lowerer, call);
    if (onError) return onError;
    const hybrid = lowerObjectAssignHybrid(lowerer, call);
    if (hybrid) return hybrid;
    // `Object.assign({}, lit)` — an EMPTY fresh-literal target and one
    // object-literal source: the result is a fresh object carrying
    // exactly the source literal's properties, which IS the source
    // literal evaluated (both fresh, no alias can tell them apart).
    // Everything else keeps the spread hint (stdlibMemberFence).
    if (
      call.arguments.nodes.length === 2 &&
      !call.arguments.nodes.some((a) => ts.isSpreadElement(a))
    ) {
      let target: ts.Expression = call.arguments.nodes[0]!;
      while (ts.isParenthesizedExpression(target)) target = target.expression;
      let source: ts.Expression = call.arguments.nodes[1]!;
      while (ts.isParenthesizedExpression(source)) source = source.expression;
      if (
        ts.isObjectLiteralExpression(target) &&
        target.properties.nodes.length === 0 &&
        ts.isObjectLiteralExpression(source)
      ) {
        return lowerer.lowerExpr(source);
      }
    }
    // `Object.assign(target, ...sources)` into an INDEX-SIGNATURE record
    // (the init-config merge pattern): the keyed-write walk over each
    // source, returning the target — indexed-objects owns the matrix.
    const merged = lowerObjectAssignIndexShape(lowerer, call);
    if (merged) return merged;
    // `Object.assign(target, source)` over signature-free RECORDS whose
    // source fields all land on same-named, same-typed target fields
    // (the mockable-clock restore: `Object.assign(mocked,
    // implementations)` over one shape): the per-field copy helper,
    // returning the TARGET — JS's aliasing, the target mutates in
    // place. Optional source fields copy only when present (an omitted
    // optional field must not erase the target's value — Node copies own
    // keys only — while an explicit `k: undefined` does). Everything
    // else keeps the spread hint.
    if (
      call.arguments.nodes.length === 2 &&
      !call.arguments.nodes.some((a) => ts.isSpreadElement(a))
    ) {
      const tProbe = tryLowerExpression(lowerer, call.arguments.nodes[0]!);
      const sProbe = tryLowerExpression(lowerer, call.arguments.nodes[1]!);
      // CHECKED-DYNAMIC target and source (the JS file-scope
      // object-literal identity story): the runtime dyn copy — own
      // members of the source land on the target, which returns.
      if (tProbe?.type.kind === "dyn") {
        const loc = locOf(call);
        const target = lowerer.lowerExpr(call.arguments.nodes[0]!);
        const rawSource = lowerer.lowerExpr(call.arguments.nodes[1]!);
        fenceSymbolFieldCopy(lowerer, call.arguments.nodes[1]!, rawSource.type);
        let targetNode: ts.Expression = call.arguments.nodes[0]!;
        while (ts.isParenthesizedExpression(targetNode)) targetNode = targetNode.expression;
        if (ts.isObjectLiteralExpression(targetNode))
          fenceClassCopyIntoFreshObject(lowerer, call, call.arguments.nodes[1]!, rawSource);
        const source = lowerer.coerceToExpected(rawSource, DYN);
        if (target.type.kind === "dyn" && source.type.kind === "dyn") {
          return { kind: "libCall", fn: "dyn.assign", args: [target, source], type: DYN, loc };
        }
      }
      // A CLASS-INSTANCE target and a plain record source whose fields are
      // all fields the class declares with the same types
      // (`Object.assign(this, { retries: 3 })`): the per-field write into
      // the instance, returning it — the instance mutates in place.
      if (tProbe?.type.kind === "object" && sProbe?.type.kind === "record") {
        const helper = classAssignPlan(lowerer, tProbe.type.className, sProbe.type.shapeId);
        if (helper) {
          const loc = locOf(call);
          const target = lowerer.lowerExpr(call.arguments.nodes[0]!);
          const source = lowerer.lowerExpr(call.arguments.nodes[1]!);
          if (target.type.kind === "object" && source.type.kind === "record") {
            const name = classAssignHelper(
              lowerer,
              target.type.className,
              source.type.shapeId,
              loc,
            );
            if (name)
              return { kind: "call", callee: name, args: [target, source], type: target.type, loc };
          }
        }
      }
      if (tProbe?.type.kind === "record" && sProbe?.type.kind === "record") {
        const tShape = lowerer.shapes.get(tProbe.type.shapeId);
        const sShape = lowerer.shapes.get(sProbe.type.shapeId);
        const ok =
          tShape &&
          sShape &&
          !tShape.tuple &&
          !sShape.tuple &&
          !tShape.indexValue &&
          !sShape.indexValue &&
          !shapeHasAccessorSlots(tShape) &&
          !shapeHasAccessorSlots(sShape) &&
          sShape.fields.every((sf) => {
            const tf = tShape.fields.find((x) => x.name === sf.name);
            // A source value converts into a wider target field (`{ bail:
            // true }` into `bail?: boolean`).
            return (
              tf !== undefined &&
              (typeEquals(tf.type, sf.type) || lowerer.coercibleValue(sf.type, tf.type))
            );
          });
        if (ok) {
          const loc = locOf(call);
          const target = lowerer.lowerExpr(call.arguments.nodes[0]!);
          const source = lowerer.lowerExpr(call.arguments.nodes[1]!);
          if (target.type.kind === "record" && source.type.kind === "record") {
            const helper = recordAssignHelper(
              lowerer,
              target.type.shapeId,
              source.type.shapeId,
              loc,
            );
            return { kind: "call", callee: helper, args: [target, source], type: target.type, loc };
          }
        }
      }
    }
    // `throw Object.assign(record, { extra })`: an error-shaped record given
    // a member its type lacks, thrown at once. A fixed record cannot grow
    // the member, so the throw carries a checked-dynamic copy of the target
    // with the source's members added. The copy is unobservable: control
    // leaves with the throw, so nothing on that path reads the target again.
    {
      let parent: ts.Node | undefined = call.parent;
      while (parent && ts.isParenthesizedExpression(parent)) parent = parent.parent;
      const argNodes = call.arguments.nodes;
      if (
        parent &&
        ts.isThrowStatement(parent) &&
        argNodes.length === 2 &&
        !argNodes.some((a) => ts.isSpreadElement(a))
      ) {
        const tProbe = tryLowerExpression(lowerer, argNodes[0]!);
        const sProbe = tryLowerExpression(lowerer, argNodes[1]!);
        if (
          tProbe?.type.kind === "record" &&
          lowerer.dynConvertible(tProbe.type) &&
          sProbe &&
          (sProbe.type.kind === "dyn" || lowerer.dynConvertible(sProbe.type))
        ) {
          const loc = locOf(call);
          const target = lowerer.coerceToExpected(lowerer.lowerExpr(argNodes[0]!), DYN);
          const source = lowerer.coerceToExpected(lowerer.lowerExpr(argNodes[1]!), DYN);
          if (target.type.kind === "dyn" && source.type.kind === "dyn")
            return { kind: "libCall", fn: "dyn.assign", args: [target, source], type: DYN, loc };
        }
      }
    }
    // `Object.assign(target, ...sources)` over a CHECKED-DYNAMIC target
    // — the n-ary/spread form (`Object.assign({}, ...plugins.map(p =>
    // p.options), coreOptions)`, support.js's option-table merge). The
    // sources pack into one fresh dyn array FIRST — plain sources
    // retain in, spread sources flatten through the spread-call walk
    // (V8's exact TypeError texts, the source spelling carried for the
    // nullish form) — so every source evaluates and flattens before any
    // copying (JS's ArgumentListEvaluation: a throwing spread leaves
    // the target untouched), then one runtime walk copies each source's
    // own enumerable keys left to right and answers the TARGET
    // (identity, like JS). Each source must enter the dyn world (dyn
    // already, or dynFrom's JSON-safe conversion — a STATIC array
    // spread copies in at the boundary, the documented aliasing
    // stance); anything else keeps the fence. Targets: dyn values, a
    // FRESH object-literal target (`Object.assign({}, ...)` — no alias
    // exists, so building it as a dyn object instead of a record is
    // unobservable), or a nullish unit (Node's ToObject TypeError
    // throws at the call, catchably); aliased record targets keep the
    // fence — their identity could not survive the conversion.
    if (call.arguments.nodes.length >= 1 && !ts.isSpreadElement(call.arguments.nodes[0]!)) {
      let targetNode: ts.Expression = call.arguments.nodes[0]!;
      while (ts.isParenthesizedExpression(targetNode)) targetNode = targetNode.expression;
      const freshLiteralTarget = ts.isObjectLiteralExpression(targetNode);
      const tProbe = freshLiteralTarget
        ? null
        : tryLowerExpression(lowerer, call.arguments.nodes[0]!);
      const tKind = tProbe?.type.kind;
      if (freshLiteralTarget || tKind === "dyn" || tKind === "nullT" || tKind === "undefinedT") {
        const loc = locOf(call);
        const target = lowerer.lowerExprExpecting(call.arguments.nodes[0]!, DYN);
        if (target.type.kind === "dyn") {
          const t = lowerer.declareHiddenLocal("%oat", DYN);
          const p = lowerer.declareHiddenLocal("%oap", DYN);
          const tRef = (): IrExpr => ({ kind: "varRef", localId: t.id, type: DYN, loc });
          const pRef = (): IrExpr => ({ kind: "varRef", localId: p.id, type: DYN, loc });
          const stmts: IrStmt[] = [
            { kind: "varDecl", localId: t.id, init: target, loc },
            {
              kind: "varDecl",
              localId: p.id,
              init: { kind: "dynArrLit", elems: [], type: DYN, loc },
              loc,
            },
          ];
          // V8 spells the optimized apply-path texts (the expression
          // named for a nullish source) only when the spread is the
          // SINGLE LAST argument; every other spread position drives
          // the real iterator protocol, whose failure describes the
          // value — the two runtime variants, picked here by position.
          const sources = call.arguments.nodes.slice(1);
          const spreadCount = sources.filter((a) => ts.isSpreadElement(a)).length;
          let ok = true;
          for (let i = 0; i < sources.length; i++) {
            const argNode = sources[i]!;
            const spread = ts.isSpreadElement(argNode);
            const srcNode = spread ? argNode.expression : argNode;
            const rawSource = lowerer.lowerExpr(srcNode);
            fenceSymbolFieldCopy(lowerer, srcNode, rawSource.type, spread);
            if (freshLiteralTarget)
              fenceClassCopyIntoFreshObject(lowerer, call, srcNode, rawSource);
            const src = lowerer.coerceToExpected(rawSource, DYN);
            if (src.type.kind !== "dyn") {
              ok = false;
              break;
            }
            const argLoc = locOf(argNode);
            const optimized = spreadCount === 1 && i === sources.length - 1;
            stmts.push({
              kind: "exprStmt",
              expr: spread
                ? optimized
                  ? {
                      kind: "libCall",
                      fn: "dyn.packPushSpread",
                      args: [
                        pRef(),
                        src,
                        {
                          kind: "strLit",
                          value: ts.getTextOfNode(srcNode),
                          type: STRING,
                          loc: argLoc,
                        },
                      ],
                      type: VOID,
                      loc: argLoc,
                    }
                  : {
                      kind: "libCall",
                      fn: "dyn.packPushSpreadIter",
                      args: [pRef(), src],
                      type: VOID,
                      loc: argLoc,
                    }
                : {
                    kind: "libCall",
                    fn: "dyn.packPush",
                    args: [pRef(), src],
                    type: VOID,
                    loc: argLoc,
                  },
              loc: argLoc,
            });
          }
          if (ok) {
            return {
              kind: "seqExpr",
              stmts,
              result: {
                kind: "libCall",
                fn: "dyn.assignAll",
                args: [tRef(), pRef()],
                type: DYN,
                loc,
              },
              type: DYN,
              loc,
            };
          }
        }
      }
    }
    return null;
  }
  if (
    (member === "defineProperty" && call.arguments.nodes.length === 3) ||
    (member === "getOwnPropertyDescriptor" && call.arguments.nodes.length === 2)
  ) {
    if (call.arguments.nodes.some((a) => ts.isSpreadElement(a))) return null;
    let target = tryLowerExpression(lowerer, call.arguments.nodes[0]!);
    const targetNode = call.arguments.nodes[0]!;
    // The checker gives C.prototype the instance type, but its lowered
    // value is the shared prototype table, not an instance to unbox.
    const prototypeTarget =
      ts.isPropertyAccessExpression(targetNode) &&
      targetNode.name.text === "prototype" &&
      (exactClassOfReceiver(lowerer, targetNode.expression) !== null ||
        storedClassValueType(lowerer, targetNode.expression)?.kind === "classval");
    const declaredTarget =
      target?.type.kind === "dyn" &&
      !prototypeTarget &&
      !isJsSourceFile(ts.getSourceFileOfNode(targetNode))
        ? lowerer.mapTypeOf(lowerer.typeOf(targetNode))
        : null;
    if (target && declaredTarget && isDynTypedRefType(declaredTarget))
      target = lowerer.coerceToExpected(target, declaredTarget);
    if (target && member === "defineProperty") {
      const field = lowerClassFieldDefine(lowerer, call, target);
      if (field) return field;
      const native = lowerClassDataDescriptor(lowerer, call, member, target);
      if (native) return native;
    }
    if (target && member === "getOwnPropertyDescriptor" && isDynTypedRefType(target.type)) {
      const descriptor = lowerClassDescriptorRead(lowerer, call, target);
      if (descriptor) return descriptor;
      target = lowerer.coerceToExpected(target, DYN);
    }
    // Error instances share a live property table with their checked view.
    const keyNode = call.arguments.nodes[1]!;
    if (
      target?.type.kind === "object" &&
      target.type.className !== "%DOMException" &&
      lowerer.errorHierarchyClassOf(target.type.className) &&
      ((ts.isStringLiteral(keyNode) && (keyNode.text === "cause" || keyNode.text === "message")) ||
        lowerer.mapTypeOf(lowerer.typeOf(keyNode))?.kind === "symbol")
    ) {
      target = lowerer.coerceToExpected(target, DYN);
    }
    if (target?.type.kind === "func" && lowerer.dynConvertible(target.type)) {
      const fnName = jsFuncNameOf(call.arguments.nodes[0]!, lowerer);
      target = {
        kind: "dynFrom",
        value: target,
        type: DYN,
        loc: locOf(call.arguments.nodes[0]!),
        ...(fnName !== null ? { fnName } : {}),
      };
    }
    // A class value (`Object.defineProperty(Definition, "name", { value })`)
    // boxes to its constructor function, whose own-property table holds the
    // definition for every alias of the class.
    if (target?.type.kind === "classval" && lowerer.dynConvertible(target.type)) {
      target = { kind: "dynFrom", value: target, type: DYN, loc: locOf(call.arguments.nodes[0]!) };
    }
    const descriptorPrimitive =
      member === "getOwnPropertyDescriptor" &&
      target &&
      (target.type.kind === "bool" || target.type.kind === "f64" || target.type.kind === "string");
    if (!target || (target.type.kind !== "dyn" && !isUnitType(target.type) && !descriptorPrimitive))
      return null;
    if (target.type.kind !== "dyn")
      target = { kind: "dynFrom", value: target, type: DYN, loc: locOf(call.arguments.nodes[0]!) };
    const key = lowerer.lowerExprExpecting(call.arguments.nodes[1]!, DYN);
    if (key.type.kind !== "dyn") return null;
    if (member === "getOwnPropertyDescriptor") {
      return {
        kind: "libCall",
        fn: "dyn.getOwnPropertyDescriptor",
        args: [target, key],
        type: DYN,
        loc: locOf(call),
      };
    }
    const descriptor = lowerer.lowerExprExpecting(call.arguments.nodes[2]!, DYN);
    if (descriptor.type.kind !== "dyn") return null;
    return {
      kind: "libCall",
      fn: "dyn.defineProperty",
      args: [target, key, descriptor],
      type: DYN,
      loc: locOf(call),
    };
  }
  // Object.defineProperties over a CHECKED-DYNAMIC target (test/common's
  // _mustCallInner copying name/length onto the mustCall wrapper): the
  // runtime turns each descriptor's `value` into an own property on
  // the dyn node (OBJ members preserve attributes; FUNC nodes carry an
  // own-property table). Accessors use the target as their receiver.
  // The result is the target, like JS. Typed targets keep the fence:
  // static shapes have no property table to extend.
  if (
    member === "defineProperties" &&
    call.arguments.nodes.length === 2 &&
    !call.arguments.nodes.some((a) => ts.isSpreadElement(a))
  ) {
    const prototype = lowerClassPrototypeDescriptors(lowerer, call, member);
    if (prototype) return prototype;
    let target = tryLowerExpression(lowerer, call.arguments.nodes[0]!);
    if (target) {
      const native = lowerClassDataDescriptor(lowerer, call, member, target);
      if (native) return native;
    }
    // A FUNCTION-typed target boxes through the dyn boundary: the
    // property table lives on the CLOSURE (shared by every box of this
    // function value), so defining through a fresh box sticks — the
    // wrapper returned later reads the same table.
    if (
      target &&
      target.type.kind === "func" &&
      canBoxFuncIntoDyn(
        target.type,
        (id) => lowerer.shapes.get(id),
        (id) => lowerer.unions.get(id),
      )
    ) {
      const fnName = jsFuncNameOf(call.arguments.nodes[0]!, lowerer);
      target = {
        kind: "dynFrom",
        value: target,
        type: DYN,
        loc: locOf(call.arguments.nodes[0]!),
        ...(fnName !== null ? { fnName } : {}),
      };
    }
    if (target && isUnitType(target.type)) {
      target = { kind: "dynFrom", value: target, type: DYN, loc: locOf(call.arguments.nodes[0]!) };
    }
    if (target?.type.kind === "dyn") {
      const descs = lowerer.lowerExprExpecting(call.arguments.nodes[1]!, DYN);
      if (descs.type.kind === "dyn") {
        return {
          kind: "libCall",
          fn: "dyn.defineProps",
          args: [target, descs],
          type: DYN,
          loc: locOf(call),
        };
      }
    }
    return null;
  }
  if (
    ["preventExtensions", "isExtensible", "seal", "isSealed"].includes(member) &&
    call.arguments.nodes.length === 1 &&
    !ts.isSpreadElement(call.arguments.nodes[0]!)
  ) {
    const value = lowerer.lowerExpr(call.arguments.nodes[0]!);
    if (
      value.type.kind === "string" ||
      value.type.kind === "f64" ||
      value.type.kind === "bool" ||
      value.type.kind === "symbol" ||
      isUnitType(value.type)
    ) {
      if (member === "preventExtensions" || member === "seal") return value;
      const loc = locOf(call);
      const answer: IrExpr = { kind: "boolLit", value: member !== "isExtensible", type: BOOL, loc };
      return isSafeToDiscard(value)
        ? answer
        : {
            kind: "seqExpr",
            stmts: [{ kind: "exprStmt", expr: value, loc: value.loc }],
            result: answer,
            type: BOOL,
            loc,
          };
    }
    const fnIntegrity = functionIntegrity(
      lowerer,
      member,
      value,
      call.arguments.nodes[0]!,
      locOf(call),
    );
    if (fnIntegrity) return fnIntegrity;
    // A Map or Set has no own properties: freeze, seal and preventExtensions
    // all only make it not extensible.
    if (value.type.kind === "map" || value.type.kind === "set") {
      if (member === "preventExtensions" || member === "seal")
        return lowerNativeFreeze(lowerer, "collection.preventExtensions", value, locOf(call));
      const extensible: IrExpr = {
        kind: "libCall",
        fn: "collection.isExtensible",
        args: [value],
        type: BOOL,
        loc: locOf(call),
      };
      return member === "isExtensible"
        ? extensible
        : { kind: "unary", op: "!", operand: extensible, type: BOOL, loc: locOf(call) };
    }
    if (member === "preventExtensions" || member === "seal") {
      const integrity = lowerClassIntegrity(lowerer, call, member, value);
      if (integrity) return integrity;
    } else if (isDynTypedRefType(value.type)) {
      // The instance's checked view carries its integrity state.
      return {
        kind: "libCall",
        fn: member === "isSealed" ? "dyn.isSealed" : "dyn.isExtensible",
        args: [lowerer.coerceToExpected(value, DYN)],
        type: BOOL,
        loc: locOf(call),
      };
    }
    if (value.type.kind === "dyn") {
      const operation = {
        preventExtensions: "dyn.preventExtensions",
        isExtensible: "dyn.isExtensible",
        seal: "dyn.seal",
        isSealed: "dyn.isSealed",
      } as const;
      const fn = operation[member as keyof typeof operation];
      return {
        kind: "libCall",
        fn,
        args: [value],
        type: member.startsWith("is") ? BOOL : DYN,
        loc: locOf(call),
      };
    }
  }
  // Object.freeze: on a FRESH literal (object or array) the result IS
  // the argument — no alias exists, so the frozen bit is unobservable
  // (writes through the Readonly<T> result are compile errors, and no
  // other reference can write). Primitives pass through per ES2015.
  // Aliased records get the frozen bit of their rc word (frozen-records.ts);
  // other aliased objects keep a fence: a later write through the original
  // reference would need a runtime frozen bit (strict mode throws).
  if (member === "isFrozen" && call.arguments.nodes.length === 1) {
    const argNode = call.arguments.nodes[0]!;
    const probedKind = tryLowerExpression(lowerer, argNode)?.type.kind;
    if (
      probedKind === "record" ||
      probedKind === "array" ||
      probedKind === "map" ||
      probedKind === "set"
    ) {
      const native = lowerer.lowerExpr(argNode);
      const loc = locOf(call);
      if (native.type.kind === "record" || native.type.kind === "array")
        return {
          kind: "libCall",
          fn: native.type.kind === "record" ? "record.isFrozen" : "array.isFrozen",
          args: [native],
          type: BOOL,
          loc,
        };
      if (native.type.kind === "map" || native.type.kind === "set")
        return {
          kind: "unary",
          op: "!",
          operand: {
            kind: "libCall",
            fn: "collection.isExtensible",
            args: [native],
            type: BOOL,
            loc,
          },
          type: BOOL,
          loc,
        };
    }
    const value = lowerer.lowerExprExpecting(argNode, DYN);
    return { kind: "libCall", fn: "dyn.isFrozen", args: [value], type: BOOL, loc: locOf(call) };
  }
  if (member === "freeze") {
    if (call.arguments.nodes.length !== 1 || ts.isSpreadElement(call.arguments.nodes[0]!)) {
      lowerer.noLowering(`Object.freeze with ${call.arguments.nodes.length} arguments`, call);
    }
    const argNode = call.arguments.nodes[0]!;
    let inner: ts.Expression = argNode;
    while (ts.isParenthesizedExpression(inner) || ts.isAsExpression(inner))
      inner = inner.expression;
    const value =
      isJsSourceFile(ts.getSourceFileOfNode(call)) &&
      (ts.isObjectLiteralExpression(inner) || ts.isArrayLiteralExpression(inner))
        ? lowerer.lowerExprExpecting(argNode, DYN)
        : lowerer.lowerExpr(argNode);
    if (value.type.kind === "dyn")
      return { kind: "libCall", fn: "dyn.freeze", args: [value], type: DYN, loc: locOf(call) };
    if (ts.isObjectLiteralExpression(inner) || ts.isArrayLiteralExpression(inner)) {
      return value; // fresh — freeze is identity here, honestly
    }
    if (
      value.type.kind === "string" ||
      value.type.kind === "f64" ||
      value.type.kind === "bool" ||
      value.type.kind === "symbol" ||
      value.type.kind === "bigint" ||
      isUnitType(value.type)
    ) {
      return value; // ES2015: freeze of a primitive is the primitive
    }
    if (
      value.type.kind === "union" &&
      lowerer.unions
        .get(value.type.unionId)
        ?.arms.every(
          (arm) =>
            isUnitType(arm) ||
            arm.kind === "f64" ||
            arm.kind === "bigint" ||
            arm.kind === "bool" ||
            arm.kind === "string" ||
            arm.kind === "symbol",
        )
    )
      return value;
    const fnIntegrity = functionIntegrity(lowerer, "freeze", value, argNode, locOf(call));
    if (fnIntegrity) return fnIntegrity;
    const integrity = lowerClassIntegrity(lowerer, call, "freeze", value);
    if (integrity) return integrity;
    if (freezableRecordType(lowerer, value.type))
      return lowerNativeFreeze(lowerer, "record.freeze", value, locOf(call));
    if (value.type.kind === "array")
      return lowerNativeFreeze(lowerer, "array.freeze", value, locOf(call));
    if (value.type.kind === "map" || value.type.kind === "set")
      return lowerNativeFreeze(lowerer, "collection.preventExtensions", value, locOf(call));
    lowerer.noLowering(
      "Object.freeze of a possibly-aliased value",
      call,
      "freeze of a FRESH object/array literal (and of primitives) compiles — frozen-ness is unobservable there; an aliased target's later writes would need the runtime frozen bit",
    );
  }
  // `Object.hasOwn(r, k)` over a RECORD receiver: a record's own-key set
  // is its declared field list, so membership is a compare chain against
  // the field names (interned per shape). Optional fields answer by
  // their runtime presence: an omitted or deleted optional field is NOT
  // own, while an explicit `k: undefined` is, exactly Node's keys. Tuple
  // and accessor-carrying shapes keep the SC2020 fence. Index-signature
  // records additionally probe the overflow map; non-record receivers
  // do too.
  if (
    member === "hasOwn" &&
    call.arguments.nodes.length === 2 &&
    !call.arguments.nodes.some((a) => ts.isSpreadElement(a))
  ) {
    const recvNode = call.arguments.nodes[0]!;
    const keyNode = call.arguments.nodes[1]!;
    const probed = tryLowerExpression(lowerer, recvNode);
    const arrayKey = probed?.type.kind === "array" ? lowerer.lowerExpr(keyNode) : null;
    if (probed?.type.kind === "array" && arrayKey?.type.kind === "f64") {
      // Numeric own keys use the array's slot/property presence directly.
      // Unlike `in`, this never includes inherited properties. arrayHas
      // evaluates and keeps the receiver alive before evaluating the key.
      return {
        kind: "arrayHas",
        arr: probed,
        index: arrayKey,
        type: BOOL,
        loc: locOf(call),
      };
    }
    const constructor =
      probed?.type.kind === "classval" ? lowerer.classes.get(probed.type.className) : undefined;
    // A CHECKED-DYNAMIC receiver (the JS file-scope object-literal
    // identity story): the runtime dyn probe — OBJ member presence, ARR
    // index bounds, Node's ToObject TypeError on nullish.
    if (
      probed?.type.kind === "dyn" ||
      (probed && isDynTypedRefType(probed.type)) ||
      (probed?.type.kind === "object" && lowerer.errorHierarchyClassOf(probed.type.className)) ||
      (probed && constructor && (constructor.callableBase || hasRuntimeStatics(constructor))) ||
      (probed?.type.kind === "func" && lowerer.dynConvertible(probed.type))
    ) {
      const loc = locOf(call);
      const receiver = lowerer.coerceToExpected(probed, DYN);
      const rawKey = arrayKey ?? lowerer.lowerExpr(keyNode);
      if (
        rawKey.type.kind === "dyn" ||
        rawKey.type.kind === "symbol" ||
        (rawKey.type.kind === "union" && lowerer.dynConvertible(rawKey.type))
      )
        return {
          kind: "libCall",
          fn: "dyn.hasOwnComputed",
          args: [receiver, lowerer.coerceToExpected(rawKey, DYN)],
          type: BOOL,
          loc,
        };
      const key = ownPropertyKey(lowerer, rawKey);
      if (!key) return null;
      return { kind: "libCall", fn: "dyn.hasOwn", args: [receiver, key], type: BOOL, loc };
    }
    if (probed?.type.kind !== "record") return null;
    const shape = lowerer.shapes.get(probed.type.shapeId);
    if (!shape || shape.tuple || shapeHasAccessorSlots(shape)) return null;
    const loc = locOf(call);
    const receiver = lowerer.lowerExpr(recvNode);
    if (receiver.type.kind !== "record") return null; // probe/lower drift: keep the fence
    const key = ownPropertyKey(lowerer, lowerer.lowerExpr(keyNode));
    if (!key) return null;
    const helper = recordHasOwnHelper(lowerer, receiver.type.shapeId, loc);
    return { kind: "call", callee: helper, args: [receiver, key], type: BOOL, loc };
  }
  if (member !== "keys" && member !== "values" && member !== "entries") return null;
  if (call.arguments.nodes.length !== 1 || ts.isSpreadElement(call.arguments.nodes[0]!))
    return null;
  const argNode = call.arguments.nodes[0]!;
  // util.types and node:util/types list Node's pinned key census
  // (UTIL_TYPES_KEYS): the object's own keys in Node's order, or the module
  // namespace's export names sorted with "default". values/entries would
  // include members that do not compile yet.
  const probedModule = tryLowerExpression(lowerer, argNode);
  if (
    lowerer.builtinNamespaceModuleOf(argNode) === "util/types" ||
    (probedModule?.type.kind === "moduleNs" && probedModule.type.moduleId === "builtin:util/types")
  ) {
    if (member !== "keys") {
      lowerer.noLowering(
        `Object.${member} over util.types`,
        call,
        "call the util.types predicates by name",
      );
    }
    const symbol = ts.isIdentifier(argNode)
      ? lowerer.checker.getSymbolAtLocation(argNode)
      : undefined;
    const namespace = symbol
      ? symbol.declarations.some((decl) => ts.isNamespaceImport(decl))
      : false;
    const names = namespace ? [...UTIL_TYPES_KEYS, "default"].sort() : UTIL_TYPES_KEYS;
    const loc = locOf(call);
    return {
      kind: "arrayLit",
      elems: names.map((name) => ({ kind: "strLit", value: name, type: STRING, loc })),
      type: arrayOf(STRING),
      loc,
    };
  }
  // A compiled PROGRAM module namespace is a nominal token whose members
  // remain live bindings, but its enumerable key set is static and Node
  // sorts it in code-unit order. Materialize exactly those value-export
  // names for Object.keys; values/entries would need a heterogeneous live
  // view and stay explicitly fenced. Builtin namespaces also stay fenced:
  // their exact runtime export set is Node-owned, not the ambient subset.
  {
    const probed = tryLowerExpression(lowerer, argNode);
    if (probed?.type.kind === "moduleNs") {
      if (member !== "keys") {
        lowerer.noLowering(
          `Object.${member} over a module namespace`,
          call,
          "read the named exports directly (module namespace values are live and may have heterogeneous representations)",
        );
      }
      const source = lowerer.sourceFileOfModuleNamespace(probed.type);
      if (source === null) {
        lowerer.noLowering(
          "Object.keys over a builtin module namespace",
          call,
          "access the builtin's named exports directly (the exact runtime key census is Node-owned)",
        );
      }
      const moduleSymbol = source ? lowerer.checker.getSymbolAtLocation(source) : undefined;
      const names: string[] = [];
      moduleSymbol?.getExports().forEach((symbol, key) => {
        // Internal names (`__export`) start with `__`; an exported name that
        // does is keyed with an extra `_` (escapedSymbolName).
        const name = String(key);
        if ((name.startsWith("__") && !name.startsWith("___")) || name === "export=") return;
        const target =
          symbol.flags & ts.SymbolFlags.Alias ? lowerer.checker.getAliasedSymbol(symbol) : symbol;
        if (target.flags & ts.SymbolFlags.Value) names.push(ts.symbolName(symbol));
      });
      names.sort();
      const loc = locOf(call);
      const result: IrExpr = {
        kind: "arrayLit",
        elems: names.map((name) => ({ kind: "strLit", value: name, type: STRING, loc })),
        type: arrayOf(STRING),
        loc,
      };
      const receiver = lowerer.lowerExpr(argNode);
      return isSafeToDiscard(receiver)
        ? result
        : {
            kind: "seqExpr",
            stmts: [{ kind: "exprStmt", expr: receiver, loc }],
            result,
            type: result.type,
            loc,
          };
    }
  }
  // A CHECKED-DYNAMIC argument — the checker may still spell a record
  // type (the JS file-scope object-literal identity story stores the
  // dyn object), so the LOWERED value's kind is the dispatch: the
  // runtime walks the dyn node's own keys (integer-like keys first,
  // JS's own-key order) and answers a dyn array.
  {
    const probed = tryLowerExpression(lowerer, argNode);
    const isDyn = probed?.type.kind === "dyn";
    // Unit-typed arguments (Object.keys(null)) ride the same runtime
    // walk: it throws Node's catchable TypeError.
    const isFunction = probed?.type.kind === "func" && lowerer.dynConvertible(probed.type);
    const isPrimitive =
      probed !== null &&
      probed !== undefined &&
      (isUnitType(probed.type) ||
        probed.type.kind === "string" ||
        probed.type.kind === "f64" ||
        probed.type.kind === "bool");
    const isJsUnion =
      probed?.type.kind === "union" &&
      isJsSourceFile(ts.getSourceFileOfNode(call)) &&
      lowerer.dynConvertible(probed.type);
    // An array walks its live view: the present indices, then its numeric
    // and named properties.
    const isArray = probed?.type.kind === "array" && lowerer.dynConvertible(probed.type);
    if (
      isDyn ||
      isPrimitive ||
      isFunction ||
      isJsUnion ||
      isArray ||
      (probed && isDynTypedRefType(probed.type))
    ) {
      const fn =
        member === "keys"
          ? "dyn.objKeys"
          : member === "values"
            ? "dyn.objValues"
            : "dyn.objEntries";
      let v = lowerer.lowerExpr(argNode);
      if (v.type.kind !== "dyn")
        v = {
          kind: "dynFrom",
          value: v,
          ...(isArray ? { liveRef: true as const } : {}),
          type: DYN,
          loc: locOf(call),
        };
      // In TypeScript the keys come back as a native string[] and the
      // entries as a native [string, any][]: the checker keeps every later
      // write to the arrays well typed. JavaScript may store anything into
      // them, so it keeps the checked-dynamic arrays.
      const resultT =
        member !== "values" && !isJsSourceFile(ts.getSourceFileOfNode(call))
          ? lowerer.mapTypeOf(lowerer.typeOf(call))
          : null;
      if (member === "keys" && resultT?.kind === "array" && resultT.elem.kind === "string")
        return {
          kind: "libCall",
          fn: "dyn.objKeyStrings",
          args: [v],
          type: resultT,
          loc: locOf(call),
        };
      if (member === "entries" && resultT && isDynEntryPairsType(lowerer, resultT))
        return {
          kind: "libCall",
          fn: "dyn.objEntryPairs",
          args: [v],
          type: resultT,
          loc: locOf(call),
        };
      // Values are `any[]`, which is the checked-dynamic array. When the
      // program only iterates or indexes the result, or passes it to a
      // read-only array method, a native vector of the checked values skips
      // building that array and, for for-of, the iterator protocol.
      if (
        member === "values" &&
        !isJsSourceFile(ts.getSourceFileOfNode(call)) &&
        consumesValueList(call)
      )
        return {
          kind: "libCall",
          fn: "dyn.objValueList",
          args: [v],
          type: arrayOf(DYN),
          loc: locOf(call),
        };
      return { kind: "libCall", fn, args: [v], type: DYN, loc: locOf(call) };
    }
  }
  let argIr = lowerer.mapTypeOf(lowerer.typeOf(argNode));
  // Inferred records can carry runtime-optional index values that the
  // checker omits (named regex captures). Enumerate the represented shape.
  const represented = tryLowerExpression(lowerer, argNode);
  if (represented?.type.kind === "record") argIr = represented.type;
  if (argIr?.kind !== "record") return null; // Maps, classes, arrays → the SC2020 fence
  const shape = lowerer.shapes.get(argIr.shapeId);
  if (!shape || shape.tuple) return null; // tuple → the fence
  // Accessor-carrying shapes: Node's answer includes the accessor NAMES
  // (own enumerable properties) and — for values/entries — the getter
  // RESULTS, invoked in key order. The static field walk models neither
  // (accessor slots live outside declaredOrder), so the surface fences.
  fencePerfEntryKeyWalk(lowerer, argIr, call, `Object.${member}`);
  if (shapeHasAccessorSlots(shape)) {
    lowerer.unsupported(
      "SC1090",
      call,
      `Object.${member} over a shape carrying get/set accessor properties (Node lists the accessor names${member === "keys" ? "" : " and invokes the getters"} — the static key walk cannot; read the properties explicitly)`,
    );
  }
  // unknown[] uses the checked-dynamic array representation. Enumerate
  // a live view of the record so values retain their identities and the

  const enumerationType = lowerer.mapTypeOf(lowerer.typeOf(call));
  if (
    (member === "values" || member === "entries") &&
    (enumerationType?.kind === "dyn" ||
      (enumerationType === null && isJsSourceFile(ts.getSourceFileOfNode(call))))
  ) {
    let receiver = lowerer.coerceToExpected(lowerer.lowerExpr(argNode), DYN);
    if (receiver.type.kind !== "dyn") lowerer.badType(argNode, lowerer.typeOf(argNode));
    if (receiver.kind === "dynFrom" && receiver.value.type.kind === "record")
      receiver = { ...receiver, liveRef: true };
    return {
      kind: "libCall",
      fn: member === "values" ? "dyn.objValues" : "dyn.objEntries",
      args: [receiver],
      type: DYN,
      loc: locOf(call),
    };
  }
  if (shape.indexValue) {
    // Index-signature (overflow-carrying) shapes: the runtime walk —
    // declared fields first, then the overflow in JS own-key order
    // (lowerObjectIterOverIndexShape in indexed-objects).
    return lowerObjectIterOverIndexShape(lowerer, call, member, argIr, shape);
  }
  const loc = locOf(call);
  const checkedT = lowerer.irTypeOf(call);
  if (checkedT.kind !== "array") lowerer.badType(call, lowerer.typeOf(call)); // defensive
  const resultT =
    member === "entries" && consumesEntryPairs(call)
      ? runtimeOptionalEntriesType(lowerer, argIr, checkedT)
      : checkedT;
  const enumerated = objectEnumerationReceiver(lowerer, lowerer.lowerExpr(argNode), argIr, loc);
  // A record that kept undeclared properties of its checked source answers
  // from its live checked view (values checked into the static result).
  const recordT = argIr;
  const sourced = (staticAnswer: (record: IrExpr) => IrExpr): IrExpr =>
    recordMayKeepSource(lowerer, recordT)
      ? throughRecordSource(lowerer, enumerated, loc, staticAnswer, (view, type) =>
          member === "keys"
            ? { kind: "libCall", fn: "dyn.objKeyStrings", args: [view], type, loc }
            : {
                kind: "dynCheck",
                value: {
                  kind: "libCall",
                  fn: member === "values" ? "dyn.objValues" : "dyn.objEntries",
                  args: [view],
                  type: DYN,
                  loc,
                },
                type,
                loc,
              },
        )
      : staticAnswer(enumerated);
  if (member === "keys") {
    // The keys walk is shared with for-in (which iterates exactly the
    // keys Object.keys answers — one construction, one intern key).
    return sourced((receiver) => recordKeysArrayCall(lowerer, receiver, argIr, shape, loc));
  }

  // The result-element type each field's value flows into: string for
  // keys, the checker's value union for values, the [string, V] tuple's
  // "1" field for entries.
  let valueT: IrType | null = null;
  let tupleT: (IrType & { kind: "record" }) | null = null;
  if (member === "values") valueT = resultT.elem;
  if (member === "entries") {
    if (resultT.elem.kind !== "record") lowerer.badType(call, lowerer.typeOf(call));
    tupleT = resultT.elem;
    const tupleShape = lowerer.shapes.get(resultT.elem.shapeId);
    if (!tupleShape?.tuple || tupleShape.fields.length !== 2)
      lowerer.badType(call, lowerer.typeOf(call));
    valueT = tupleShape.fields.find((f) => f.name === "1")!.type;
  }

  lowerer.keyOrder.observe(argIr);
  const key = `obj.${member}:${argIr.shapeId}:${typeKey(resultT)}`;
  let helper = lowerer.arrHofHelpers.get(key);
  if (!helper) {
    helper = keyedHelperName(lowerer, `%obj.${member}`, key);
    const recT = argIr;
    const ref: IrExpr = { kind: "varRef", localId: "r.0", type: recT, loc };
    const outRef: IrExpr = { kind: "varRef", localId: "out.0", type: resultT, loc };
    const fn: IrFunction = {
      name: helper,
      params: [{ localId: "r.0", name: "r", type: recT }],
      returnType: resultT,
      locals: [
        { id: "r.0", name: "r", type: recT, mutable: true },
        { id: "out.0", name: "out", type: resultT, mutable: false },
      ],
      body: [],
      loc,
    };
    const finalize = (): void => {
      const latest = lowerer.shapes.get(argIr.shapeId);
      const current: import("../../ir/ir.js").IrRecordShape = latest !== undefined ? latest : shape;
      const body: IrStmt[] = [
        {
          kind: "varDecl",
          localId: "out.0",
          init: { kind: "arrayLit", elems: [], type: resultT, loc },
          loc,
        },
      ];
      // One walk per key order (see perKeyOrder).
      const orders = shapeKeyOrders(current);
      const walks = orders.map((): IrStmt[] => []);
      for (const [k, name] of orders.flatMap((order, k) =>
        order.map((name) => [k, name] as const),
      )) {
        const f = current.fields.find((x) => x.name === name)!;
        const raw: IrExpr = {
          kind: "recordGet",
          obj: ref,
          shapeId: argIr.shapeId,
          field: f.name,
          type: f.type,
          loc,
        };
        // The pushed element per member; null when the field's value
        // cannot flow into the result element type.
        const elemOf = (value: IrExpr, vt: IrType): IrExpr | null => {
          if (!valueT) return null;
          if (typeEquals(vt, valueT)) return value;
          if (valueT.kind === "dyn" && lowerer.dynConvertible(vt))
            return lowerer.coerceToExpected(value, DYN);
          if (valueT.kind === "union" && vt.kind !== "union") {
            const tag = lowerer.armTag(valueT.unionId, vt);
            if (tag >= 0) {
              return { kind: "unionWrap", unionId: valueT.unionId, tag, value, type: valueT, loc };
            }
          }
          return null;
        };
        // Undefined-armed fields: the push is guarded by the field's
        // presence; a narrowed push re-tags the non-undefined arm.
        let guardUndefTag: number | null = null;
        let value: IrExpr = raw;
        let vt: IrType = f.type;
        if (f.type.kind === "union") {
          const undefTag = lowerer.armTag(f.type.unionId, UNDEFINED_T);
          if (undefTag >= 0) {
            guardUndefTag = undefTag;
            const arms = lowerer.unions.get(f.type.unionId)?.arms ?? [];
            const others = arms.filter((a): boolean => a.kind !== "undefinedT");
            if (valueT?.kind === "dyn" || typeEquals(f.type, valueT ?? f.type)) {
              // The field union IS the result union (single-field shapes):
              // push the raw box — but then the undefined skip must NOT
              // narrow. Handled below via vt === valueT.
              value = raw;
              vt = f.type;
            } else if (others.length === 1) {
              vt = others[0]!;
              // A UNIT other arm (`null | undefined` fields — the mixed-
              // defaults spread idiom; undefined was filtered above, so
              // the unit is null): units carry no payload, so the guarded
              // push writes the unit LITERAL — unionNarrow to a unit arm
              // (and unionWrap of a narrowed unit) is malformed IR; the
              // literal is the one legal unit spelling.
              value = isUnitType(vt)
                ? { kind: "unitLit", unit: "null", type: vt, loc }
                : {
                    kind: "unionNarrow",
                    unionId: f.type.unionId,
                    tag: lowerer.armTag(f.type.unionId, vt),
                    value: raw,
                    type: vt,
                    loc,
                  };
            } else {
              lowerer.unsupported(
                "SC1090",
                call,
                `Object.${member} over '${lowerer.fmt(argIr)}' (field '${f.name}' is a multi-arm union that ` +
                  "cannot re-tag into the result element type — read the fields directly)",
              );
            }
          } else if (valueT?.kind !== "dyn" && !typeEquals(f.type, valueT ?? f.type)) {
            lowerer.unsupported(
              "SC1090",
              call,
              `Object.${member} over '${lowerer.fmt(argIr)}' (field '${f.name}' is a union that cannot ` +
                "re-tag into the result element type — read the fields directly)",
            );
          }
        }
        const coerced = elemOf(value, vt);
        if (!coerced) {
          lowerer.unsupported(
            "SC1090",
            call,
            `Object.${member} over '${lowerer.fmt(argIr)}' (field '${f.name}' of type '${lowerer.fmt(f.type)}' ` +
              `cannot flow into the '${lowerer.fmt(valueT!)}' result element — read the fields directly)`,
          );
        }
        const pushOf = (element: IrExpr): IrStmt => ({
          kind: "exprStmt",
          expr: {
            kind: "arrIntrinsic",
            method: "push",
            receiver: outRef,
            args: [
              member === "values"
                ? element
                : {
                    kind: "recordLit",
                    fields: [
                      { name: "0", value: { kind: "strLit", value: f.name, type: STRING, loc } },
                      { name: "1", value: element },
                    ],
                    type: tupleT!,
                    loc,
                  },
            ],
            type: F64,
            loc,
          },
          loc,
        });
        let stmt = pushOf(coerced);
        if (guardUndefTag !== null && f.type.kind === "union") {
          if (value !== raw) {
            // A narrowed push: a present field holding undefined pushes
            // the result element's own undefined when it has one; a values
            // array without one stores a present undefined element (a
            // runtime-optional field the checker typed as required). An
            // entries tuple slot has no spelling for it.
            const undefinedElement = valueT ? lowerer.wrappedUndefined(valueT, loc) : null;
            const undefinedPush: IrStmt | null = undefinedElement
              ? pushOf(undefinedElement)
              : member === "values"
                ? {
                    kind: "arraySetUndefined",
                    arr: outRef,
                    index: {
                      kind: "arrIntrinsic",
                      method: "length",
                      receiver: outRef,
                      args: [],
                      type: F64,
                      loc,
                    },
                    loc,
                  }
                : null;
            stmt = {
              kind: "if",
              cond: {
                kind: "unionIsTag",
                unionId: f.type.unionId,
                tag: guardUndefTag,
                negated: true,
                value: raw,
                type: BOOL,
                loc,
              },
              then: [stmt],
              else_: undefinedPush ? [undefinedPush] : null,
              loc,
            };
          }
          // Absent fields contribute nothing; present ones push their
          // value, undefined included.
          stmt = {
            kind: "if",
            cond: lowerer.recordFieldPresent(ref, argIr.shapeId, f.name, loc),
            then: [stmt],
            else_: null,
            loc,
          };
        }
        walks[k]!.push(stmt);
      }
      body.push(...perKeyOrder(current, ref, walks, loc));
      body.push({ kind: "return", value: outRef, loc });
      fn.body = body;
    };
    finalize();
    lowerer.arrHofHelpers.set(key, helper);
    lowerer.shapeOrderHelperFinalizers.push(finalize);
    lowerer.liftedFns.push(fn);
  }
  const callee = helper;
  return sourced((receiver) => ({ kind: "call", callee, args: [receiver], type: resultT, loc }));
}

/** An entries array consumed pair by pair right where it is built: a
 * for-of loop or an array callback method. These consumers bind each pair
 * from the array's own layout, so the pair's value slot can keep a
 * runtime-optional field's undefined arm. */
function consumesEntryPairs(call: ts.CallExpression): boolean {
  let node: ts.Node = call;
  while (ts.isParenthesizedExpression(node.parent)) node = node.parent;
  const parent = node.parent;
  if (ts.isForOfStatement(parent)) return parent.expression === node;
  return (
    ts.isPropertyAccessExpression(parent) &&
    parent.expression === node &&
    ENTRY_PAIR_CALLBACK_METHODS.has(parent.name.text) &&
    ts.isCallExpression(parent.parent) &&
    parent.parent.expression === parent
  );
}

/** Whether an Object.values result is only iterated, indexed or passed to
 * a read-only array method, so no code observes or changes its array
 * representation. A bare `.length` read keeps the checked-dynamic array,
 * which measures as fast. */
function consumesValueList(call: ts.CallExpression): boolean {
  let node: ts.Node = call;
  while (ts.isParenthesizedExpression(node.parent)) node = node.parent;
  const parent = node.parent;
  if (ts.isForOfStatement(parent)) return parent.expression === node && !parent.awaitModifier;
  if (ts.isElementAccessExpression(parent))
    return parent.expression === node && !isWriteTarget(parent);
  if (!ts.isPropertyAccessExpression(parent) || parent.expression !== node) return false;
  return (
    VALUE_LIST_METHODS.has(parent.name.text) &&
    ts.isCallExpression(parent.parent) &&
    parent.parent.expression === parent
  );
}

/** Whether an access is assigned, updated or deleted. */
function isWriteTarget(access: ts.Expression): boolean {
  let node: ts.Node = access;
  while (ts.isParenthesizedExpression(node.parent)) node = node.parent;
  const parent = node.parent;
  if (ts.isBinaryExpression(parent))
    return (
      parent.left === node &&
      parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    );
  if (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent))
    return (
      parent.operator === ts.SyntaxKind.PlusPlusToken ||
      parent.operator === ts.SyntaxKind.MinusMinusToken
    );
  return ts.isDeleteExpression(parent);
}

const VALUE_LIST_METHODS = new Set(["every", "findIndex", "forEach", "join", "reduce", "some"]);

const ENTRY_PAIR_CALLBACK_METHODS = new Set([
  "every",
  "filter",
  "find",
  "findIndex",
  "flatMap",
  "forEach",
  "map",
  "some",
]);

/** The entries array of a record whose runtime-optional fields (unchecked
 * indexed reads the checker calls present) can hold undefined: the pair's
 * value slot gains the undefined arm, so such an entry is listed with its
 * undefined value as Node lists it. Reads of the slot follow the
 * runtime-optional field rules. */
function runtimeOptionalEntriesType(
  lowerer: Lowerer,
  record: IrType & { kind: "record" },
  resultT: IrType & { kind: "array" },
): IrType & { kind: "array" } {
  const shape = lowerer.shapes.get(record.shapeId);
  if (resultT.elem.kind !== "record" || !shape) return resultT;
  const pair = lowerer.shapes.get(resultT.elem.shapeId);
  const slot = pair?.tuple ? pair.fields.find((f) => f.name === "1") : undefined;
  if (!slot) return resultT;
  const optional = shape.fields.find(
    (f) =>
      lowerer.isRuntimeOptionalField(record.shapeId, f.name) &&
      lowerer.runtimeOptionalWidening(f.type, slot.type) !== null,
  );
  if (!optional) return resultT;
  const widened = lowerer.runtimeOptionalWidening(optional.type, slot.type)!;
  return { kind: "array", elem: lowerer.runtimeOptionalRecordField(resultT.elem, "1", widened) };
}

/** `r.f(args)` where `r` is a record and `f` a func-typed field: an
 * ordinary indirect call through the field's closure value. Deliberately
 * record-only — calling a func-typed CLASS field stays rejected (the
 * generic method-call rejection in lowerCall). */
/** `Object.assign(fn, { bold, ... })` → a HYBRID record literal: the
 * reserved %call field takes the function, each source object literal's
 * properties fill their declared fields (later sources override, JS's
 * last-write-wins — one entry per name, source values still evaluate in
 * order through the literal lowering's shared rules). Bounded to the
 * chalk shape on purpose: the RESULT type must map to a %call-carrying
 * record, sources must be plain object literals (an `as` cast unwraps),
 * and every declared field must be filled. REPRESENTATION NOTE
 * (SEMANTICS.md): the result is a FRESH record, not the mutated `fn` —
 * `assigned === fn` is false here where JS answers true, and `typeof`
 * would answer object; portless's colors.ts never observes either.
 * Null (→ the stdlib fence) for every other Object.assign form. */
function lowerObjectAssignHybrid(lowerer: Lowerer, call: ts.CallExpression): IrExpr | null {
  const mapped = lowerer.mapTypeOf(lowerer.typeOf(call));
  if (mapped?.kind !== "record") return null;
  const shape = lowerer.shapes.get(mapped.shapeId);
  const callField = shape?.fields.find((f) => f.name === "%call");
  if (!shape || !callField || callField.type.kind !== "func") return null;
  if (call.arguments.nodes.length < 2 || call.arguments.nodes.some((a) => ts.isSpreadElement(a)))
    return null;
  const loc = locOf(call);
  const values = new Map<string, IrExpr>();
  values.set("%call", lowerer.lowerExprExpecting(call.arguments.nodes[0]!, callField.type));
  for (const argNode of call.arguments.nodes.slice(1)) {
    let src: ts.Expression = argNode;
    while (ts.isParenthesizedExpression(src) || ts.isAsExpression(src) || ts.isTypeAssertion(src))
      src = src.expression;
    if (!ts.isObjectLiteralExpression(src)) {
      lowerer.unsupported(
        "SC1090",
        argNode,
        "Object.assign sources other than plain object literals when building a function-with-properties value",
      );
    }
    for (const prop of src.properties.nodes) {
      const nameOk =
        (ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop)) &&
        (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name));
      if (!nameOk) {
        lowerer.unsupported(
          "SC1090",
          prop,
          "this property form in an Object.assign source building a function-with-properties value",
        );
      }
      const name = (prop.name as ts.Identifier | ts.StringLiteral).text;
      const fieldType = shape.fields.find((f) => f.name === name)?.type;
      if (!fieldType) {
        lowerer.unsupported(
          "SC1090",
          prop,
          `the property '${name}' missing from the assigned result type '${lowerer.fmt(mapped)}'`,
        );
      }
      const value = ts.isPropertyAssignment(prop)
        ? lowerer.lowerExprExpecting(prop.initializer, fieldType)
        : lowerer.coerceInto(
            prop,
            lowerer.lowerShorthandValue(prop as ts.ShorthandPropertyAssignment),
            fieldType,
          );
      values.set(name, value);
    }
  }
  const fields: { name: string; value: IrExpr }[] = [];
  for (const f of shape.fields) {
    const v = values.get(f.name);
    if (!v) {
      const absent = lowerer.absentFieldValue(f.type, loc);
      if (!absent) {
        lowerer.unsupported(
          "SC1090",
          call,
          `Object.assign leaving the required field '${f.name}' of '${lowerer.fmt(mapped)}' unfilled`,
        );
      }
      fields.push({ name: f.name, value: absent });
      continue;
    }
    fields.push({ name: f.name, value: v });
  }
  return { kind: "recordLit", fields, type: mapped, loc };
}

/** The accessed member is an overload set (isOverloadedCallableMemberType),
 * also under an optional chain whose access still spells `| undefined`. */
function isOverloadedMemberAccess(lowerer: Lowerer, access: ts.PropertyAccessExpression): boolean {
  return isOverloadedCallableMemberType(
    lowerer.checker.getNonNullableType(lowerer.typeOf(access)),
    lowerer.checker,
  );
}

/** The result type of the overload a call through an overloaded member
 * resolved to: the erased slot's result converts to it. A non-generic
 * overload answers through its declaration, because the resolved signature
 * of an optional-chain call (`api?.m(x)`) also carries the chain's
 * undefined; a generic one answers through its instantiation. */
function resolvedOverloadResultType(lowerer: Lowerer, call: ts.CallExpression): IrType {
  const { checker } = lowerer;
  const signature = checker.getResolvedSignature(call);
  const decl = signature ? signature.declaration : undefined;
  const declared = decl ? checker.getSignatureFromDeclaration(decl) : undefined;
  const source = declared && declared.getTypeParameters().length === 0 ? declared : signature;
  const result = source ? lowerer.mapTypeOf(checker.getReturnTypeOfSignature(source)) : null;
  return result ?? lowerer.irTypeOf(call);
}

export function lowerRecordFieldCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (lowerer.chainBlocked(call)) return null;
  const stored = ts.isIdentifier(access.expression)
    ? (lowerer.peekLocal(access.expression)?.type ?? lowerer.globalOf(access.expression)?.type)
    : undefined;
  const receiverType =
    stored?.kind === "record" ? stored : lowerer.mapTypeOf(lowerer.typeOf(access.expression));
  if (receiverType?.kind !== "record" && receiverType?.kind !== "union") return null;
  // A union of records can share a closure-valued field. Its normal
  // property read performs the tag dispatch before arguments evaluate.
  // Class methods retain their vtable path and must not lose `this`.
  if (receiverType.kind === "union") {
    const arms = lowerer.unions.get(receiverType.unionId)?.arms;
    if (!arms?.every((arm) => arm.kind === "record")) return null;
    if (
      !arms.every(
        (arm) =>
          arm.kind === "record" &&
          lowerer.shapes
            .get(arm.shapeId)
            ?.fields.some((field) => field.name === access.name.text && field.type.kind === "func"),
      )
    )
      return null;
    const callee = lowerer.lowerUnionProperty(access);
    if (callee?.type.kind !== "func") return null;
    const args = completeFuncValueArgs(lowerer, call, callee.type, locOf(call));
    const value: IrExpr = {
      kind: "callValue",
      callee,
      args,
      type: callee.type.ret,
      loc: locOf(call),
    };
    // An overloaded member's erased result converts to the resolved
    // overload's type, as on a single record receiver below.
    return isOverloadedMemberAccess(lowerer, access)
      ? lowerer.coerceInto(call, value, resolvedOverloadResultType(lowerer, call))
      : value;
  }
  const target = lowerer.fieldTarget(access);
  const loc = locOf(call);
  const receiverLocal =
    target && isJsSourceFile(ts.getSourceFileOfNode(call))
      ? lowerer.declareHiddenLocal("%callReceiver", target.obj.type)
      : null;
  const init: IrStmt | null =
    target && receiverLocal
      ? { kind: "varDecl", localId: receiverLocal.id, init: target.obj, loc }
      : null;
  if (target && receiverLocal) target.obj = varRef(receiverLocal.id, receiverLocal.type, loc);
  let callee = target ? lowerer.fieldGetExpr(target, locOf(access), access) : null;
  if (!callee) return null;
  // A HYBRID (function-with-properties) field is callable through its
  // reserved %call slot — `colors.blue("x")` where blue also carries
  // `.bold` (the chalk shape).
  if (callee.type.kind === "object" && !init) {
    const direct = callableInstanceStringCall(lowerer, call, callee, loc);
    if (direct) return direct;
    // Other argument counts call the %call closure through its value, as
    // a call on the builder itself does (`theme.error("a", "b")`).
    const closure = lowerer.hybridCallUnwrap(callee);
    if (closure !== callee) return lowerCallThroughValue(lowerer, call, closure, loc);
  }
  if (callee.type.kind === "record" || callee.type.kind === "object")
    callee = lowerer.hybridCallUnwrap(callee);
  // Inferred JavaScript option records can retain checked callables in
  // fields even when the checker only describes those members as any.
  // TypeScript reaches here for callable library types that are checked
  // values (util.DebugLogger).
  if (
    callee.type.kind === "dyn" &&
    (isJsSourceFile(ts.getSourceFileOfNode(call)) ||
      lowerer.checker.getCallSignatures(lowerer.typeOf(access)).length > 0)
  ) {
    const receiver =
      target && receiverLocal ? lowerer.coerceToExpected(target.obj, DYN) : undefined;
    const spread = call.arguments.nodes.some(ts.isSpreadElement)
      ? lowerSpreadArgsCall(lowerer, call, callee, loc)
      : null;
    if (spread && spread.kind !== "dynCall")
      lowerer.unsupported("SC1090", call, "checked record property call spread arguments");
    const result: IrExpr = spread
      ? receiver
        ? { ...spread, receiver }
        : spread
      : {
          kind: "dynCall",
          callee,
          ...(receiver ? { receiver } : {}),
          calleeName: ts.getTextOfNode(access),
          args: call.arguments.nodes.map((arg) => lowerer.lowerExprExpecting(arg, DYN)),
          type: DYN,
          loc,
        };
    return init ? { kind: "seqExpr", stmts: [init], result, type: result.type, loc } : result;
  }
  // An optional callback field the checker narrowed at this call
  // (`o.cb ? o.cb(x) : …`, `if (o.cb) o.cb(x)`): extract the func arm.
  if (callee.type.kind === "union") callee = lowerer.maybeNarrow(callee, access);
  if (callee.type.kind !== "func") lowerer.badType(access, lowerer.typeOf(access));
  // JavaScript passes the record as `this`. A record with no dynamic form
  // cannot be that receiver; the library's own function fields (the
  // resolve/reject of Promise.withResolvers) never read it.
  let receiver: IrExpr | undefined;
  if (target && receiverLocal) {
    if (lowerer.dynConvertible(target.obj.type)) {
      receiver = lowerer.coerceToExpected(target.obj, DYN);
    } else if (!lowerer.isStdlibMember(access)) {
      lowerer.unsupported(
        "SC1090",
        call,
        `calling a function field of a '${lowerer.fmt(target.obj.type)}' record (the record has no dynamic form to pass as 'this')`,
      );
    }
  }
  const args = completeFuncValueArgs(lowerer, call, callee.type, locOf(call));
  let result: IrExpr = {
    kind: "callValue",
    callee,
    ...(receiver ? { receiver } : {}),
    args,
    type: callee.type.ret,
    loc,
  };
  // A generic member's field holds its erased instance, and an overloaded
  // member's field its erased function (the overloads joined): the result
  // converts to this call's instantiated or resolved return type.
  const memberType = lowerer.typeOf(access);
  if (isGenericCallableMemberType(memberType, lowerer.checker))
    result = lowerer.coerceInto(call, result, lowerer.irTypeOf(call));
  else if (isOverloadedMemberAccess(lowerer, access))
    result = lowerer.coerceInto(call, result, resolvedOverloadResultType(lowerer, call));
  return init ? { kind: "seqExpr", stmts: [init], result, type: result.type, loc } : result;
}

/** `o.m(args)` where `m` is an object-literal GENERIC method (own type
 * parameters — the member is excluded from the record shape, see
 * isGenericCallableMemberType): monomorphized per call site against the
 * DEFINING literal's declaration, exactly like top-level generic
 * functions. Resolution is static, so the receiver must provably BE the
 * defining literal: a const binding whose initializer is that literal,
 * read directly. The receiver read is pure and the compiled instance is
 * a plain module function (no `this`, fenced), so the call lowers to a
 * direct `call` of the instance with the receiver unevaluated. Claims
 * every call whose member is generic-callable — lowering it or fencing
 * with a named message. */
/** The URL factories use the constructor's conversion order and parser.
 * URL.revokeObjectURL() with NO argument: Node's ERR_MISSING_ARGS
 * throws before the registry lookup, so the zero-argument contract is
 * exact without any blob machinery. The one-argument form (Node's
 * no-op for unregistered ids) and createObjectURL keep their
 * fences — a compiled program has no blob registry to consult. */
function lowerUrlStaticCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  callee: ts.Expression,
): IrExpr | null {
  if (!ts.isPropertyAccessExpression(callee) || callee.questionDotToken !== undefined) return null;
  if (!ts.isIdentifier(callee.expression)) return null;
  const sym = lowerer.resolveValueSymbol(callee.expression);
  if (!sym || !lowerer.isStdlibSymbol(sym) || ts.symbolName(sym) !== "URL") return null;
  if (callee.name.text === "canParse" || callee.name.text === "parse") {
    return lowerUrlFactory(lowerer, call, callee.name.text);
  }
  if (callee.name.text !== "revokeObjectURL" || call.arguments.nodes.length !== 0) return null;
  return nodeThrowExpr(
    1,
    "ERR_MISSING_ARGS",
    'The "url" argument must be specified',
    VOID,
    locOf(call),
  );
}

const SP_BRAND_METHODS = new Set([
  "append",
  "delete",
  "get",
  "getAll",
  "has",
  "set",
  "sort",
  "forEach",
  "keys",
  "values",
  "entries",
  "toString",
]);

function arrowSignatureOf(lowerer: Lowerer, node: ts.Expression): ts.Signature | null {
  const signatures = lowerer.checker.getCallSignatures(lowerer.typeOf(node));
  if (signatures.length !== 1) return null;
  const declaration = signatures[0]!.declaration;
  return declaration !== undefined && ts.isArrowFunction(declaration) ? signatures[0]! : null;
}

/** An inline arrow has lexical `this` and no observable own properties
 * before binding. With no preset arguments, a fresh forwarding closure
 * preserves its completed ABI, defaults and captured environment. Keep
 * other receivers and rest/preset-argument forms on the named fence. */
function lowerInlineArrowBind(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (
    access.name.text !== "bind" ||
    call.arguments.nodes.length > 1 ||
    call.arguments.nodes.some(ts.isSpreadElement)
  )
    return null;
  let arrow = access.expression;
  while (ts.isParenthesizedExpression(arrow)) arrow = arrow.expression;
  if (!ts.isArrowFunction(arrow)) return null;
  const callee = lowerer.lowerExpr(access.expression);
  if (
    callee.type.kind !== "func" ||
    callee.type.rest ||
    !canBoxFuncIntoDyn(
      callee.type,
      (id) => lowerer.shapes.get(id),
      (id) => lowerer.unions.get(id),
    )
  )
    return null;
  const type = callee.type;
  const loc = locOf(call);
  const firstDefault = arrow.parameters.nodes.findIndex((p) => p.initializer !== undefined);
  const length = firstDefault < 0 ? arrow.parameters.nodes.length : firstDefault;
  const key = `arrow.bind:${typeKey(type)}:${length}`;
  const existing = lowerer.arrHofHelpers.get(key);
  const name = existing ?? keyedHelperName(lowerer, "%arrow.bind", key);
  if (!existing) {
    lowerer.arrHofHelpers.set(key, name);
    lowerer.freshClosureAdapters.add(name);
    const impl = `${name}.impl`;
    const captured: IrLocal = { id: "f.0", name: "f", type, mutable: false, boxed: true };
    const params: IrParam[] = type.params.map((type, i) => ({
      localId: `p.${i}`,
      name: `p${i}`,
      type,
    }));
    const invoked: IrExpr = {
      kind: "callValue",
      callee: { kind: "varRef", localId: captured.id, type, loc },
      args: params.map((p) => ({ kind: "varRef", localId: p.localId, type: p.type, loc })),
      type: type.ret,
      loc,
    };
    lowerer.liftedFns.push({
      name: impl,
      params,
      returnType: type.ret,
      captures: [{ localId: captured.id, name: captured.name, type }],
      locals: [
        captured,
        ...params.map((p) => ({ id: p.localId, name: p.name, type: p.type, mutable: false })),
      ],
      body: [
        type.ret.kind === "void"
          ? { kind: "exprStmt", expr: invoked, loc }
          : { kind: "return", value: invoked, loc },
      ],
      loc,
    });
    const bound: IrExpr = { kind: "varRef", localId: "bound.0", type, loc };
    const str = (value: string): IrExpr => ({ kind: "strLit", value, type: STRING, loc });
    const descriptor = (value: IrExpr): IrExpr => ({
      kind: "dynObjLit",
      fields: [{ key: str("value"), value: { kind: "dynFrom", value, type: DYN, loc } }],
      type: DYN,
      loc,
    });
    lowerer.liftedFns.push({
      name,
      params: [{ localId: captured.id, name: captured.name, type }],
      returnType: type,
      locals: [captured, { id: "bound.0", name: "bound", type, mutable: false }],
      body: [
        {
          kind: "varDecl",
          localId: "bound.0",
          init: { kind: "closure", fnName: impl, captures: [captured.id], type, loc },
          loc,
        },
        // Store metadata on the closure so aliases and repeated dyn boxes
        // observe the bound name and source arity, including defaults.
        {
          kind: "exprStmt",
          expr: {
            kind: "libCall",
            fn: "dyn.defineProps",
            args: [
              { kind: "dynFrom", value: bound, type: DYN, loc },
              {
                kind: "dynObjLit",
                fields: [
                  { key: str("name"), value: descriptor(str("bound ")) },
                  {
                    key: str("length"),
                    value: descriptor({ kind: "numLit", value: length, type: F64, loc }),
                  },
                ],
                type: DYN,
                loc,
              },
            ],
            type: DYN,
            loc,
          },
          loc,
        },
        { kind: "return", value: bound, loc },
      ],
      loc,
    });
  }
  const saved = lowerer.declareHiddenLocal("%bindFn", type);
  const stmts: IrStmt[] = [{ kind: "varDecl", localId: saved.id, init: callee, loc }];
  // The receiver is ignored by the arrow, but its effects and throws
  // happen after creating the arrow and before returning the bound value.
  if (call.arguments.nodes[0]) stmts.push(lowerer.lowerExprStatement(call.arguments.nodes[0]));
  const result: IrExpr = {
    kind: "call",
    callee: name,
    args: [{ kind: "varRef", localId: saved.id, type, loc }],
    type,
    loc,
  };
  return { kind: "seqExpr", stmts, result, type, loc };
}

/** `arrow.apply(thisArg, dynArgs)` for a fixed-arity compiled arrow. Arrows
 * ignore `thisArg` and surplus arguments by language definition; declared
 * parameters validate from the dynamic array in order. */
function lowerArrowFunctionApply(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (
    access.name.text !== "apply" ||
    call.arguments.nodes.length !== 2 ||
    call.arguments.nodes.some(ts.isSpreadElement) ||
    arrowSignatureOf(lowerer, access.expression) === null
  ) {
    return null;
  }
  const callee = lowerer.lowerExpr(access.expression);
  if (callee.type.kind !== "func" || callee.type.rest === true) return null;
  if (
    !callee.type.params.every((param) =>
      canDynCheckTo(
        param,
        (id) => lowerer.shapes.get(id),
        (id) => lowerer.unions.get(id),
      ),
    )
  ) {
    return null;
  }
  const argsList = lowerer.lowerExpr(call.arguments.nodes[1]!);
  if (argsList.type.kind !== "dyn") return null;
  const loc = locOf(call);
  const savedCallee = lowerer.declareHiddenLocal("%applyFn", callee.type);
  const savedArgs = lowerer.declareHiddenLocal("%applyArgs", DYN);
  const stmts: IrStmt[] = [
    { kind: "varDecl", localId: savedCallee.id, init: callee, loc },
    { kind: "exprStmt", expr: lowerer.lowerExpr(call.arguments.nodes[0]!), loc },
    { kind: "varDecl", localId: savedArgs.id, init: argsList, loc },
  ];
  const args = callee.type.params.map((param, index): IrExpr => {
    const read: IrExpr = {
      kind: "dynKeyGet",
      key: { kind: "strLit", value: String(index), type: STRING, loc },
      value: { kind: "varRef", localId: savedArgs.id, type: DYN, loc },
      type: DYN,
      loc,
    };
    return lowerer.coerceInto(call.arguments.nodes[1]!, read, param);
  });
  const invoked: IrExpr = {
    kind: "callValue",
    callee: { kind: "varRef", localId: savedCallee.id, type: callee.type, loc },
    args,
    type: callee.type.ret,
    loc,
  };
  let result: IrExpr;
  if (invoked.type.kind === "void") {
    stmts.push({ kind: "exprStmt", expr: invoked, loc });
    result = dynUndefinedExpr(loc);
  } else {
    result = lowerer.coerceInto(call, invoked, DYN);
    if (result.type.kind !== "dyn") return null;
  }
  return { kind: "seqExpr", stmts, result, type: DYN, loc };
}

function lowerObjLitGenericMethodCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (lowerer.chainBlocked(access, call)) return null;
  const name = access.name.text;
  // URLSearchParams method values through Function.prototype.call/apply
  // with a receiver that is provably NOT a URLSearchParams (the suite's
  // `params.append.call(undefined)` probes): the WHATWG brand check
  // throws ERR_INVALID_THIS before any argument conversion — the whole
  // call IS that throw. A receiver that IS searchParams-typed, or one
  // whose runtime kind is unknowable (dyn/'any'), keeps the fence.
  if (
    (name === "call" || name === "apply") &&
    ts.isPropertyAccessExpression(access.expression) &&
    lowerer.mapTypeOf(lowerer.typeOf(access.expression.expression))?.kind === "searchParams" &&
    SP_BRAND_METHODS.has(access.expression.name.text) &&
    lowerer.isStdlibMember(access.expression)
  ) {
    const thisArg = call.arguments.nodes[0];
    const thisT = thisArg
      ? lowerer.mapTypeOf(lowerer.typeOf(thisArg))
      : { kind: "undefinedT" as const };
    const provablyNot =
      thisT !== null &&
      thisT.kind !== "searchParams" &&
      thisT.kind !== "dyn" &&
      (!thisArg ||
        ts.isIdentifier(thisArg) ||
        ts.isLiteralExpression(thisArg) ||
        thisArg.kind === ts.SyntaxKind.NullKeyword ||
        isUnitType(thisT));
    if (provablyNot) {
      return nodeThrowExpr(
        1,
        "ERR_INVALID_THIS",
        'Value of "this" must be of type URLSearchParams',
        lowerer.mapTypeOf(lowerer.typeOf(call)) ?? VOID,
        locOf(call),
      );
    }
  }
  const recvT = lowerer.typeOf(access.expression);
  const propSym = lowerer.checker.getPropertyOfType(recvT, name);
  if (!propSym) return null;
  const propertyDecl = propSym.valueDeclaration;
  if (
    propertyDecl &&
    ts.isShorthandPropertyAssignment(propertyDecl) &&
    ts.isIdentifier(propertyDecl.name) &&
    ts.isObjectLiteralExpression(propertyDecl.parent)
  ) {
    requireObjLitGenericReceiver(lowerer, call, access.expression, propertyDecl.parent, name);
    const targetSymbol = lowerer.checker.getShorthandAssignmentValueSymbol(propertyDecl);
    const target = targetSymbol
      ? lowerer.genericFnsBySymbol.get(
          targetSymbol.flags & ts.SymbolFlags.Alias
            ? lowerer.checker.getAliasedSymbol(targetSymbol)
            : targetSymbol,
        )
      : undefined;
    if (target) return lowerer.lowerGenericCall(call, target);
  }
  if (!isGenericCallableMemberType(lowerer.checker.getTypeOfSymbol(propSym), lowerer.checker))
    return null;
  // CLASS members belong to the class path (lowerClassGenericMethodCall
  // claimed compilable ones; a class that failed collection keeps its
  // own diagnostics and the generic method-call fence downstream).
  if (
    propSym.declarations.some(
      (d) =>
        d.parent !== undefined &&
        (ts.isClassDeclaration(d.parent) || ts.isClassExpression(d.parent)),
    )
  ) {
    return null;
  }
  // An INTERFACE-typed receiver over a class instance (`const r: Repo =
  // new MemRepo(); r.get(...)` — the declaration is signature-only, but
  // the receiver's exact class is statically proven and the binding
  // kept the class representation, genericIfaceBindingKeepsClass): the
  // call is a class generic-method call on that exact class. The
  // receiver must LOWER as the class — a record-held value (a `let`, a
  // produced value, a parameter) has already dropped it, and keeps the
  // named fence below.
  {
    const exact = exactInstanceClassOf(lowerer, access.expression);
    const gfound = exact ? findGenericMethodOn(lowerer, exact, name) : null;
    if (gfound && ts.isIdentifier(access.expression)) {
      const recv = lowerer.lowerExpr(access.expression); // identifier reads are pure — no double evaluation
      if (recv.type.kind === "object") {
        return lowerClassGenericMethodCall(lowerer, call, access, exact!, gfound, recv);
      }
    }
  }
  const found = objLitGenericFnNodeOf(lowerer, propSym);
  if (!found) {
    const arrowBind = lowerInlineArrowBind(lowerer, call, access);
    if (arrowBind !== null) return arrowBind;
    const arrowApply = lowerArrowFunctionApply(lowerer, call, access);
    if (arrowApply !== null) return arrowApply;
    // Convertible native callables use the checked invocation boundary
    // for Function.prototype methods, including their call-time receiver.
    if (
      (name === "apply" || name === "call" || name === "bind") &&
      lowerer.checker.getCallSignatures(recvT).length > 0
    ) {
      const value = tryLowerExpression(lowerer, access.expression);
      // Builtin function values held as checked-dynamic functions
      // (String.fromCharCode, JSON.stringify) bind the same way, and so
      // does a member that lowers to a checked-dynamic value (a native
      // handle's method read in JavaScript).
      if (
        value &&
        (value.type.kind === "dyn" ||
          (value.type.kind === "func" && lowerer.dynConvertible(value.type))) &&
        !call.arguments.nodes.some(ts.isSpreadElement)
      ) {
        const loc = locOf(call);
        return {
          kind: "dynInvoke",
          recv: value.type.kind === "dyn" ? value : { kind: "dynFrom", value, type: DYN, loc },
          method: name,
          calleeName: ts.getTextOfNode(access),
          args: call.arguments.nodes.map((arg) => lowerer.lowerExprExpecting(arg, DYN)),
          type: DYN,
          loc,
        };
      }
      const childMethod = lowerChildMethodValue(lowerer, access.expression);
      if (childMethod && !call.arguments.nodes.some(ts.isSpreadElement)) {
        const loc = locOf(call);
        return {
          kind: "dynInvoke",
          recv: childMethod,
          method: name,
          calleeName: ts.getTextOfNode(access),
          args: call.arguments.nodes.map((arg) => lowerer.lowerExprExpecting(arg, DYN)),
          type: DYN,
          loc,
        };
      }
      lowerer.unsupported(
        "SC1090",
        call,
        `Function.prototype.${name} on a function whose signature cannot cross the checked-value boundary (call '${ts.getTextOfNode(access.expression)}(...)' directly)`,
      );
    }
    // STANDARD-LIBRARY generic members (Promise.then, Object.
    // defineProperty, Array-augmentation methods) are the lib fence's
    // story (SC2020, naming the member) — decline so the stdlib
    // chokepoint downstream reports, instead of an interface-dispatch
    // recitation about a receiver no user constructed.
    if (lowerer.isStdlibMember(access)) return null;
    // Interface-declared generic methods dispatch statically, so the
    // receiver's runtime class must be provable — name that discipline
    // instead of the object-literal wording when the method lives on an
    // interface.
    const onInterface = propSym.declarations.some(
      (d) => d.parent !== undefined && ts.isInterfaceDeclaration(d.parent),
    );
    // A receiver held as a checked-dynamic value (a class-backed interface)
    // dispatches by name to the runtime object's member, which a generic
    // method answers with its erased instance; the result converts to this
    // call's instantiated return type.
    if (onInterface && !call.arguments.nodes.some(ts.isSpreadElement)) {
      const receiver = lowerer.lowerExpr(access.expression);
      if (receiver.type.kind === "dyn") {
        const loc = locOf(call);
        const invoked: IrExpr = {
          kind: "dynInvoke",
          recv: receiver,
          method: name,
          calleeName: ts.getTextOfNode(access),
          args: call.arguments.nodes.map((arg) => lowerer.lowerExprExpecting(arg, DYN)),
          type: DYN,
          loc,
        };
        return lowerer.coerceInto(call, invoked, lowerer.irTypeOf(call));
      }
    }
    if (onInterface) {
      lowerer.unsupported(
        "SC1090",
        call,
        `calls of the generic method '${name}' through this receiver (the interface declaration is signature-only and generic methods dispatch statically, so the receiver's runtime class must be provable — bind the receiver to a const initialized with its 'new' expression, e.g. 'const r: ${lowerer.checker.typeToString(recvT)} = new C(...)')`,
      );
    }
    lowerer.unsupported(
      "SC1090",
      call,
      `calls of the generic method '${name}' with no defining object literal (the declaration is signature-only — only methods declared with a body in an object literal monomorphize)`,
    );
  }
  requireObjLitGenericReceiver(lowerer, call, access.expression, found.literal, name);
  const info = objLitGenericFnInfoOf(lowerer, call, name, found);
  const instance = genericCallInstance(lowerer, call, info);
  const loc = locOf(call);
  const args = lowerer.completeArgs(call.arguments.nodes, instance.params, loc, call);
  return { kind: "call", callee: instance.name, args, type: instance.returnType, loc };
}

/** `obj.method(args)` — whole-program devirtualization decides the form:
 * a method some strict subclass of the receiver's STATIC class overrides
 * must dispatch on the dynamic class (`virtualCall`, through the vtable);
 * everything else — standalone classes, non-overridden methods, leaf
 * receivers — stays a direct `call` of the nearest declaration, exactly
 * as before inheritance existed. */
export function lowerObjectMethodCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (lowerer.chainBlocked(access, call)) return null;
  let mappedReceiver =
    lowerer.receiverTypeOverrides.get(access.expression) ??
    structuralReadType(lowerer, access.expression) ??
    lowerer.mapTypeOf(lowerer.typeOf(access.expression));
  // EventEmitter's static side (the class, a value of it, or the events
  // module, which is the class) keeps its static surface on the emitter
  // dispatch (`EventEmitter.setMaxListeners(n)`), which tells the statics
  // apart by the receiver's construct signatures. The stream classes
  // inherit the same statics.
  if (mappedReceiver?.kind === "classval" && mappedReceiver.className === RUNTIME_EMITTER_CLASS) {
    mappedReceiver = { kind: "object", className: RUNTIME_EMITTER_CLASS };
  }
  // A specialized JS parameter can expose a native field whose checker
  // type still belongs to the unspecialized body (plane.normal.dot()).
  // Use the lowered receiver's representation and retain its evaluation.
  const probe =
    mappedReceiver?.kind !== "object" &&
    (lowerer.implicitParamTypes !== null ||
      lowerer.classImplementedProtocol(lowerer.typeOf(access.expression)) ||
      ts.isNewExpression(access.expression) ||
      isJsSourceFile(ts.getSourceFileOfNode(call)))
      ? ts.isNewExpression(access.expression)
        ? lowerer.lowerExpr(access.expression)
        : tryLowerExpression(lowerer, access.expression)
      : null;
  const specializedReceiver =
    probe?.type.kind === "object" ||
    (probe?.type.kind === "union" &&
      lowerer.unions.get(probe.type.unionId)?.arms.some((arm) => arm.kind === "object"))
      ? probe
      : null;
  if (specializedReceiver) mappedReceiver = specializedReceiver.type;
  // A member declared by a class that extends Array, called on an instance
  // (whose type maps to its array): the class's own method.
  const arrayClassOwner =
    mappedReceiver?.kind === "array" ? arrayClassMemberOwner(lowerer, access) : null;
  if (arrayClassOwner !== null)
    mappedReceiver = { kind: "object", className: arrayClassOwner.def.name };
  if (mappedReceiver?.kind === "union") {
    const dispatched =
      lowerUnionObjectMethodCall(lowerer, call, access, mappedReceiver) ??
      lowerUnionObjectDynFieldCall(lowerer, call, access, mappedReceiver);
    if (dispatched) return dispatched;
    const arms = lowerer.unions.get(mappedReceiver.unionId)?.arms;
    if (
      isJsSourceFile(ts.getSourceFileOfNode(call)) &&
      arms?.every(
        (arm) => arm.kind === "object" && !lowerer.classes.get(arm.className)?.def.runtime,
      ) &&
      lowerer.dynConvertible(mappedReceiver)
    ) {
      return lowerDynReceiverMethodCall(lowerer, call, access);
    }
  }
  const receiverIr =
    mappedReceiver?.kind === "object"
      ? mappedReceiver
      : mappedReceiver?.kind === "union"
        ? (() => {
            const arms = lowerer.unions.get(mappedReceiver.unionId)?.arms ?? [];
            const objects = arms.filter((arm): boolean => arm.kind === "object");
            const object = objects[0];
            return objects.length === 1 &&
              object?.kind === "object" &&
              arms.every((arm) => arm.kind === "object" || isUnitType(arm))
              ? object
              : null;
          })()
        : null;
  if (receiverIr === null) return null;
  const lowerReceiver = (): IrExpr => {
    if (arrayClassOwner !== null) {
      const value = lowerer.lowerExpr(access.expression);
      return value.type.kind === "array"
        ? arrayClassView(arrayClassOwner, value, locOf(access.expression))
        : value;
    }
    const receiver = specializedReceiver ?? lowerer.lowerExpr(access.expression);
    const optional = lowerer.runtimeOptionalPropertyReceiver(
      access.expression,
      receiver,
      receiverIr,
      access.name.text,
    );
    if (optional !== null) return optional;
    if (receiver.type.kind === "union") {
      const helper = lowerer.narrowedArmHelper(
        receiver.type.unionId,
        receiverIr,
        locOf(access.expression),
      );
      if (helper !== null)
        return lowerer.checkedNarrowCall(helper, receiver, receiverIr, locOf(access.expression));
    }
    return receiver.type.kind === "dyn"
      ? lowerer.coerceInto(access.expression, receiver, receiverIr)
      : receiver;
  };
  const info = lowerer.classes.get(receiverIr.className);
  if (!info) lowerer.flushDeferredClass(receiverIr.className);
  const found = info ? lowerer.findMethodOn(info, access.name.text) : null;
  // The zlib stream members (flush/params/close/reset) are declared on
  // the zlib classes; their receivers are runtime Transform streams.
  if (
    info &&
    !found &&
    ZLIB_STREAM_METHODS.has(access.name.text) &&
    isZlibStreamMember(lowerer, access)
  ) {
    return lowerZlibStreamMethodCall(lowerer, call, access);
  }
  // fs.ReadStream / fs.WriteStream's close(cb?): declared on the fs
  // classes; their receivers are runtime Readable / Writable streams.
  if (info && !found && isFsStreamMember(lowerer, access)) {
    const member = lowerFsStreamMethodCall(lowerer, call, access);
    if (member) return member;
  }
  // The stream surface: API-named calls on stream-rooted receivers
  // lower through the stream spoke (checked before the emitter surface
  // — the two member sets are disjoint, but streams root at the emitter
  // so both guards would pass an emitter-named call).
  if (
    info &&
    !found &&
    (STREAM_API_MEMBERS.has(access.name.text) ||
      STREAM_OPERATORS.has(access.name.text) ||
      access.name.text === "compose") &&
    streamSidesOf(lowerer, info) !== null
  ) {
    const stream = lowerStreamMethodCall(lowerer, call, access, info);
    if (stream) return stream;
  }
  // The EventEmitter surface: API-named calls on emitter-rooted
  // receivers lower through the emitter spoke (subclass members with
  // these names are fenced at collection, so `found` never shadows).
  if (
    info &&
    !found &&
    (EMITTER_API_MEMBERS.has(access.name.text) ||
      // A static with no instance twin (events.getEventListeners).
      (access.name.text === "getEventListeners" &&
        lowerer.checker.getConstructSignatures(lowerer.typeOf(access.expression)).length > 0)) &&
    emitterRooted(lowerer, info)
  ) {
    return lowerEmitterMethodCall(lowerer, call, access, info);
  }
  // The inherited EventTarget/Event methods of a class rooted at those
  // runtime bases (subclass members with these names are fenced).
  if (info && !found && eventTargetApiMethod(info, access.name.text)) {
    return lowerEventTargetMethodCall(lowerer, call, access, info, lowerReceiver());
  }
  // The Date methods a class declared `extends Date` does not declare.
  if (info && !found && dateRootOf(info) && isDatePrototypeMethod(access.name.text)) {
    return lowerInheritedDateMethodCall(lowerer, call, access.name.text, info, lowerReceiver());
  }
  // GENERIC methods (own type parameters) never enter the methods table:
  // they monomorphize per call site and dispatch statically
  // (lowerClassGenericMethodCall has the exactness rules).
  if (info && !found) {
    const gfound = findGenericMethodOn(lowerer, info, access.name.text);
    if (gfound)
      return lowerClassGenericMethodCall(lowerer, call, access, info, gfound, lowerReceiver());
  }
  // A FUNC-, nullable-FUNC-, or DYN-typed FIELD in call position:
  // `this.cb()` — the ctor-assigned callback field (countdown.js's
  // shape). The call is an ordinary call through the field's VALUE —
  // read and, when necessary, check-narrow the callable arm, then
  // callValue; checked-dynamic fields use the dynCall boundary. Every
  // other field type falls through to the fences.
  if (info && !found) {
    const fieldType = info.fields.get(access.name.text);
    const callableType =
      fieldType?.kind === "func"
        ? fieldType
        : fieldType?.kind === "union"
          ? (() => {
              const arms = lowerer.unions.get(fieldType.unionId)?.arms ?? [];
              const funcs = arms.filter((arm): boolean => arm.kind === "func");
              const func = funcs[0];
              return funcs.length === 1 &&
                func?.kind === "func" &&
                arms.every((arm) => arm.kind === "func" || isUnitType(arm))
                ? func
                : null;
            })()
          : null;
    if (fieldType && (callableType !== null || fieldType.kind === "dyn")) {
      const target = lowerer.fieldTarget(access);
      if (!target) return null;
      const loc = locOf(call);
      const receiverLocal = lowerer.declareHiddenLocal("%callReceiver", target.obj.type);
      const init: IrStmt = { kind: "varDecl", localId: receiverLocal.id, init: target.obj, loc };
      target.obj = { kind: "varRef", localId: receiverLocal.id, type: receiverLocal.type, loc };
      const receiver: { receiver?: IrExpr } = {};
      if (!lowerer.receiverFreeCallbackFields.has(access.name.text))
        receiver.receiver = lowerer.coerceToExpected(target.obj, DYN);
      const finish = (result: IrExpr): IrExpr => ({
        kind: "seqExpr",
        stmts: [init],
        result,
        type: result.type,
        loc,
      });
      let callee = target ? lowerer.fieldGetExpr(target, locOf(access), access) : null;
      if (callee?.type.kind === "union" && callableType !== null) {
        // Calling a cleared callback field throws Node's call TypeError.
        const inPlace = checkedArmExtraction(
          lowerer,
          callee,
          lowerer.armTag(callee.type.unionId, callableType),
          callableType,
          () => `${ts.getTextOfNode(access)} is not a function`,
        );
        const helper = inPlace
          ? null
          : lowerer.narrowedArmHelper(callee.type.unionId, callableType, locOf(access));
        if (inPlace) callee = inPlace;
        else if (helper !== null) {
          callee = lowerer.checkedNarrowCall(helper, callee, callableType, locOf(access));
        }
      }
      if (callee?.type.kind === "func") {
        if (
          ((callee.type.rest === true && callee.type.restAbi === undefined) ||
            call.arguments.nodes.length > callee.type.params.length) &&
          isJsSourceFile(ts.getSourceFileOfNode(call)) &&
          lowerer.dynConvertible(callee.type)
        ) {
          const boxed: IrExpr = { kind: "dynFrom", value: callee, type: DYN, loc };
          const spread = lowerSpreadArgsCall(lowerer, call, boxed, loc);
          if (spread?.kind === "dynCall") return finish({ ...spread, ...receiver });
          const args = call.arguments.nodes.map((arg) => lowerer.lowerExprExpecting(arg, DYN));
          return finish({
            kind: "dynCall",
            callee: boxed,
            ...receiver,
            calleeName: ts.getTextOfNode(access),
            args,
            type: DYN,
            loc,
          });
        }
        const args = completeFuncValueArgs(lowerer, call, callee.type, locOf(call));
        return finish({ kind: "callValue", callee, ...receiver, args, type: callee.type.ret, loc });
      }
      if (callee?.type.kind === "dyn") {
        if (call.arguments.nodes.some((a) => ts.isSpreadElement(a))) {
          lowerer.unsupported("SC1090", call, "spread arguments in calls through 'unknown' values");
        }
        const args = call.arguments.nodes.map((a) => lowerer.lowerExprExpecting(a, DYN));
        return finish({
          kind: "dynCall",
          callee,
          ...receiver,
          calleeName: ts.getTextOfNode(access),
          args,
          type: DYN,
          loc,
        });
      }
    }
    if (
      !fieldType &&
      isJsSourceFile(ts.getSourceFileOfNode(call)) &&
      !info.def.runtime &&
      !info.builtinError &&
      !info.builtinEmitter &&
      !info.builtinStream
    ) {
      const loc = locOf(call);
      const value = lowerReceiver();
      const local = lowerer.declareHiddenLocal("%callReceiver", value.type);
      const reference: IrExpr = { kind: "varRef", localId: local.id, type: value.type, loc };
      const receiver = lowerer.coerceToExpected(reference, DYN);
      const callee: IrExpr = {
        kind: "dynKeyGet",
        value: receiver,
        key: { kind: "strLit", value: access.name.text, type: STRING, loc },
        type: DYN,
        loc,
      };
      const spread = call.arguments.nodes.some(ts.isSpreadElement)
        ? lowerSpreadArgsCall(lowerer, call, callee, loc)
        : null;
      if (spread && spread.kind !== "dynCall")
        lowerer.unsupported("SC1090", call, "native property call spread arguments");
      const result: IrExpr =
        spread !== null
          ? { ...spread, receiver }
          : {
              kind: "dynCall",
              callee,
              receiver,
              calleeName: ts.getTextOfNode(access),
              args: call.arguments.nodes.map((arg) => lowerer.lowerExprExpecting(arg, DYN)),
              type: DYN,
              loc,
            };
      return {
        kind: "seqExpr",
        stmts: [{ kind: "varDecl", localId: local.id, init: value, loc }],
        result,
        type: DYN,
        loc,
      };
    }
    return null;
  }
  if (!info || !found) return null;
  const method = access.name.text;
  if (isClassCallback(lowerer, info, method)) {
    const loc = locOf(call);
    const receiver = lowerReceiver();
    const local = lowerer.declareHiddenLocal("%callbackReceiver", receiver.type);
    const value: IrExpr = { kind: "varRef", localId: local.id, type: receiver.type, loc };
    const args = lowerer.completeArgs(call.arguments.nodes, found.sig.params, loc, call);
    const virtual = lowerer.overrideBelow(info, method);
    if (virtual) lowerer.noteVirtualEdge(info, method);
    else lowerer.noteEdge(`%${found.declarer.def.name}.${method}`);
    const fallback: IrExpr = virtual
      ? {
          kind: "virtualCall",
          className: info.def.name,
          method,
          args: [lowerer.upcastTo(value, info.def.name), ...args],
          type: found.sig.ret,
          loc,
        }
      : {
          kind: "call",
          callee: `%${found.declarer.def.name}.${method}`,
          args: [lowerer.upcastTo(value, found.declarer.def.name), ...args],
          type: found.sig.ret,
          loc,
        };
    // The declaring class's original value, built with the observed slot.
    // An override below (a virtual call) keeps the dynamic call: a slot
    // reassigned to an ancestor's method must not reach the override. So do
    // methods declared in unchecked JavaScript, whose results are inferred,
    // and calls with a spread argument: the dynamic call drains the spread
    // through the iterator's current `next`, which may be a replacement.
    const declarerFile = found.declarer.decl ? ts.getSourceFileOfNode(found.declarer.decl) : null;
    const original =
      virtual ||
      call.arguments.nodes.some(ts.isSpreadElement) ||
      !declarerFile ||
      (isJsSourceFile(declarerFile) && !lowerer.checkedJsFile(declarerFile))
        ? undefined
        : {
            originalId: (): string | undefined => found.declarer.prototypeOriginals?.get(method),
            directCall: (): IrExpr => fallback,
          };
    const result = classCallbackCall(
      lowerer,
      value,
      method,
      call.arguments.nodes,
      fallback,
      loc,
      ts.getTextOfNode(access),
      original,
    );
    return {
      kind: "seqExpr",
      stmts: [{ kind: "varDecl", localId: local.id, init: receiver, loc }],
      result,
      type: result.type,
      loc,
    };
  }
  if (found.declarer.builtinError) {
    return errorToStringCall(lowerer, lowerReceiver());
  }
  // An ABSTRACT nearest declaration with no concrete override below the
  // static class: no implementation exists for a direct call to target.
  // Unreachable in a program that constructs anything of this type (tsc
  // makes instantiable subclasses implement, and their declarations flip
  // overrideBelow) — reaching here means the receiver can only be a
  // non-value (`null!`); the fence is the honest answer.
  if (found.sig.abstract === true && !lowerer.overrideBelow(info, method)) {
    lowerer.unsupported(
      "SC1090",
      call,
      `calls of the abstract method '${method}' with no concrete implementation below the receiver's static class`,
    );
  }
  // The static receiver's nearest declaration is an override adapted to
  // the inherited ABI, and nothing below overrides it: call its body
  // directly under its declared signature (exact parameters and result).
  // The slot function stays reachable; it lifts the body.
  const adapted = found.declarer.returnAdapters?.get(method);
  // A TypeScript override's own entry answers its declared result. A
  // JavaScript body's result is inferred, so its callers keep the slot.
  const declarerDecl = found.declarer.decl;
  if (
    adapted &&
    !(declarerDecl && isJsSourceFile(ts.getSourceFileOfNode(declarerDecl))) &&
    !lowerer.overrideBelow(info, method)
  ) {
    lowerer.noteEdge(`%${found.declarer.def.name}.${method}`);
    const receiver = lowerReceiver();
    const args = lowerer.completeArgs(call.arguments.nodes, adapted.params, locOf(call), call);
    return {
      kind: "call",
      callee: `%${found.declarer.def.name}.${method}$own`,
      args: [lowerer.upcastTo(receiver, found.declarer.def.name), ...args],
      type: adapted.ret,
      loc: locOf(call),
    };
  }
  if (lowerer.overrideBelow(info, method)) lowerer.noteVirtualEdge(info, method);
  else lowerer.noteEdge(`%${found.declarer.def.name}.${method}`);
  const receiver = lowerReceiver();
  const args = lowerer.completeArgs(call.arguments.nodes, found.sig.params, locOf(call), call);
  if (lowerer.overrideBelow(info, method)) {
    return reconcileOverloadReturn(lowerer, call, {
      kind: "virtualCall",
      className: info.def.name,
      method,
      args: [lowerer.upcastTo(receiver, info.def.name), ...args],
      type: found.sig.ret,
      loc: locOf(call),
    });
  }
  return reconcileOverloadReturn(lowerer, call, {
    kind: "call",
    callee: `%${found.declarer.def.name}.${method}`,
    args: [lowerer.upcastTo(receiver, found.declarer.def.name), ...args],
    type: found.sig.ret,
    loc: locOf(call),
  });
}

/** A method TypeScript proves callable on every arm of an unrelated class
 * union. Each runtime tag keeps its own direct/virtual dispatch; only the
 * completed argument ABI must agree. Results flow into the checker-selected
 * call type through the ordinary wrap/retag/width machinery. */
function lowerUnionObjectMethodCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
  receiverT: IrType & { kind: "union" },
): IrExpr | null {
  const def = lowerer.unions.get(receiverT.unionId);
  if (!def || def.arms.length < 2 || !def.arms.every((arm) => arm.kind === "object")) return null;
  const method = access.name.text;
  const plans: {
    arm: IrType & { kind: "object" };
    info: ClassInfo;
    found: NonNullable<ReturnType<Lowerer["findMethodOn"]>>;
  }[] = [];
  for (const arm of def.arms as (IrType & { kind: "object" })[]) {
    const info = lowerer.classes.get(arm.className);
    if (!info) {
      lowerer.flushDeferredClass(arm.className);
      return null;
    }
    const found = lowerer.findMethodOn(info, method);
    if (!found) return null;
    if (found.sig.abstract === true && !lowerer.overrideBelow(info, method)) return null;
    plans.push({ arm, info, found });
  }
  const shapes = plans[0]!.found.sig.params;
  if (plans.some((plan) => isClassCallback(lowerer, plan.info, method))) {
    const loc = locOf(call);
    const local = lowerer.declareHiddenLocal("%unionMethodReceiver", DYN);
    const receiver = varRef(local.id, DYN, loc);
    const callee: IrExpr = {
      kind: "dynKeyGet",
      value: receiver,
      key: { kind: "strLit", value: method, type: STRING, loc },
      type: DYN,
      loc,
    };
    const spread = call.arguments.nodes.some(ts.isSpreadElement)
      ? lowerSpreadArgsCall(lowerer, call, callee, loc)
      : null;
    if (spread && spread.kind !== "dynCall")
      lowerer.unsupported("SC1090", call, "union method spread arguments");
    const value: IrExpr =
      spread !== null
        ? { ...spread, receiver }
        : {
            kind: "dynCall",
            callee,
            receiver,
            calleeName: ts.getTextOfNode(access),
            args: call.arguments.nodes.map((arg) => lowerer.lowerExprExpecting(arg, DYN)),
            type: DYN,
            loc,
          };
    const resultT = lowerer.mapTypeOf(lowerer.typeOf(call));
    const result =
      resultT && !isUnitType(resultT) ? lowerer.coerceToExpected(value, resultT) : value;
    return {
      kind: "seqExpr",
      stmts: [
        {
          kind: "varDecl",
          localId: local.id,
          init: lowerer.coerceInto(access.expression, lowerer.lowerExpr(access.expression), DYN),
          loc,
        },
      ],
      result,
      type: result.type,
      loc,
    };
  }
  if (!plans.every((plan) => paramAbisEqual(shapes, plan.found.sig.params))) return null;
  const resultT = lowerer.mapTypeOf(lowerer.typeOf(call));
  if (!resultT || isUnitType(resultT)) return null;
  const loc = locOf(call);
  const receiver = lowerer.coerceInto(
    access.expression,
    lowerer.lowerExpr(access.expression),
    receiverT,
  );
  const args = lowerer.completeArgs(call.arguments.nodes, shapes, loc, call);
  const helper = unionObjectMethodHelper(
    lowerer,
    call,
    receiverT,
    method,
    plans,
    shapes,
    resultT,
    loc,
  );
  return { kind: "call", callee: helper, args: [receiver, ...args], type: resultT, loc };
}

function paramAbisEqual(left: readonly ParamShape[], right: readonly ParamShape[]): boolean {
  return (
    left.length === right.length &&
    left.every((shape, i) => {
      const other = right[i];
      return (
        other !== undefined &&
        typeEquals(shape.type, other.type) &&
        (shape.mode === other.mode ||
          (shape.type.kind === "dyn" &&
            (shape.mode === "required" || shape.mode === "omittable") &&
            (other.mode === "required" || other.mode === "omittable")))
      );
    })
  );
}

/** The JS-class sibling of union method dispatch: every arm stores the
 * named callable in a checked-dynamic field. A helper selects and retains
 * the field value before the dynCall evaluates its source arguments, so an
 * argument that overwrites the field cannot change this invocation. */
function lowerUnionObjectDynFieldCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
  receiverT: IrType & { kind: "union" },
): IrExpr | null {
  const def = lowerer.unions.get(receiverT.unionId);
  if (!def || def.arms.length < 2 || !def.arms.every((arm) => arm.kind === "object")) return null;
  const field = access.name.text;
  const plans: { arm: IrType & { kind: "object" }; info: ClassInfo }[] = [];
  for (const arm of def.arms as (IrType & { kind: "object" })[]) {
    const info = lowerer.classes.get(arm.className);
    if (!info || info.fields.get(field)?.kind !== "dyn") return null;
    plans.push({ arm, info });
  }
  if (call.arguments.nodes.some(ts.isSpreadElement)) {
    lowerer.unsupported("SC1090", call, "spread arguments in calls through 'unknown' values");
  }
  const loc = locOf(call);
  const receiver = lowerer.coerceInto(
    access.expression,
    lowerer.lowerExpr(access.expression),
    receiverT,
  );
  const key = `${receiverT.unionId}:dyn-field:${field}`;
  const receiverLocal = lowerer.declareHiddenLocal("%unionCallReceiver", receiverT);
  const receiverRef = varRef(receiverLocal.id, receiverT, loc);
  let helper = lowerer.unionCallHelpers.get(key);
  if (!helper) {
    helper = keyedHelperName(lowerer, "%union.call", key);
    lowerer.unionCallHelpers.set(key, helper);
    const receiverRef = varRef("this.0", receiverT, loc);
    const branch = (plan: (typeof plans)[number]): IrStmt[] => {
      const concrete: IrExpr = {
        kind: "unionNarrow",
        unionId: receiverT.unionId,
        tag: lowerer.armTag(receiverT.unionId, plan.arm),
        value: receiverRef,
        type: plan.arm,
        loc,
      };
      return [
        {
          kind: "return",
          value: {
            kind: "fieldGet",
            obj: concrete,
            className: plan.info.def.name,
            field,
            type: DYN,
            loc,
          },
          loc,
        },
      ];
    };
    let body = branch(plans[plans.length - 1]!);
    for (let i = plans.length - 2; i >= 0; i--) {
      const plan = plans[i]!;
      body = [
        {
          kind: "if",
          cond: {
            kind: "unionIsTag",
            unionId: receiverT.unionId,
            tag: lowerer.armTag(receiverT.unionId, plan.arm),
            negated: false,
            value: receiverRef,
            type: BOOL,
            loc,
          },
          then: branch(plan),
          else_: body,
          loc,
        },
      ];
    }
    const params: IrParam[] = [{ localId: "this.0", name: "this", type: receiverT }];
    const locals: IrLocal[] = params.map((param) => ({
      id: param.localId,
      name: param.name,
      type: param.type,
      mutable: false,
    }));
    lowerer.liftedFns.push({ name: helper, params, returnType: DYN, locals, body, loc });
  }
  const callee: IrExpr = { kind: "call", callee: helper, args: [receiverRef], type: DYN, loc };
  const args = call.arguments.nodes.map((arg) => lowerer.lowerExprExpecting(arg, DYN));
  return {
    kind: "seqExpr",
    stmts: [{ kind: "varDecl", localId: receiverLocal.id, init: receiver, loc }],
    result: {
      kind: "dynCall",
      callee,
      receiver: lowerer.coerceToExpected(receiverRef, DYN),
      calleeName: ts.getTextOfNode(access),
      args,
      type: DYN,
      loc,
    },
    type: DYN,
    loc,
  };
}

function unionObjectMethodHelper(
  lowerer: Lowerer,
  sourceCall: ts.CallExpression,
  receiverT: IrType & { kind: "union" },
  method: string,
  plans: {
    arm: IrType & { kind: "object" };
    info: ClassInfo;
    found: NonNullable<ReturnType<Lowerer["findMethodOn"]>>;
  }[],
  shapes: readonly ParamShape[],
  resultT: IrType,
  loc: SrcLoc,
): string {
  const key = `${receiverT.unionId}:${method}:${shapes.map((shape) => `${shape.mode}:${typeKey(shape.type)}`).join(",")}:${typeKey(resultT)}`;
  const existing = lowerer.unionCallHelpers.get(key);
  if (existing) return existing;
  const name = keyedHelperName(lowerer, "%union.call", key);
  lowerer.unionCallHelpers.set(key, name);
  // A probe that catches a refusal while the body lowers must not leave
  // the name registered for a helper that was never emitted.
  try {
    lowerer.liftedFns.push(
      unionObjectMethodFunction(
        lowerer,
        name,
        sourceCall,
        receiverT,
        method,
        plans,
        shapes,
        resultT,
        loc,
      ),
    );
  } catch (e) {
    lowerer.unionCallHelpers.delete(key);
    throw e;
  }
  return name;
}

function unionObjectMethodFunction(
  lowerer: Lowerer,
  name: string,
  sourceCall: ts.CallExpression,
  receiverT: IrType & { kind: "union" },
  method: string,
  plans: {
    arm: IrType & { kind: "object" };
    info: ClassInfo;
    found: NonNullable<ReturnType<Lowerer["findMethodOn"]>>;
  }[],
  shapes: readonly ParamShape[],
  resultT: IrType,
  loc: SrcLoc,
): IrFunction {
  const receiver = varRef("this.0", receiverT, loc);
  const argRefs = shapes.map((shape, i) => varRef(`a.${i}`, shape.type, loc));
  const branch = (plan: (typeof plans)[number]): IrStmt[] => {
    const concrete: IrExpr = {
      kind: "unionNarrow",
      unionId: receiverT.unionId,
      tag: lowerer.armTag(receiverT.unionId, plan.arm),
      value: receiver,
      type: plan.arm,
      loc,
    };
    let invoke: IrExpr;
    if (plan.found.declarer.builtinError) {
      invoke = errorToStringCall(lowerer, concrete);
    } else if (lowerer.overrideBelow(plan.info, method)) {
      lowerer.noteVirtualEdge(plan.info, method);
      invoke = {
        kind: "virtualCall",
        className: plan.info.def.name,
        method,
        args: [lowerer.upcastTo(concrete, plan.info.def.name), ...argRefs],
        type: plan.found.sig.ret,
        loc,
      };
    } else {
      lowerer.noteEdge(`%${plan.found.declarer.def.name}.${method}`);
      invoke = {
        kind: "call",
        callee: `%${plan.found.declarer.def.name}.${method}`,
        args: [lowerer.upcastTo(concrete, plan.found.declarer.def.name), ...argRefs],
        type: plan.found.sig.ret,
        loc,
      };
    }
    invoke = reconcileOverloadReturn(lowerer, sourceCall, invoke);
    const result = lowerer.coerceInto(sourceCall, invoke, resultT);
    return resultT.kind === "void"
      ? [
          { kind: "exprStmt", expr: result, loc },
          { kind: "return", value: null, loc },
        ]
      : [{ kind: "return", value: result, loc }];
  };
  let body = branch(plans[plans.length - 1]!);
  for (let i = plans.length - 2; i >= 0; i--) {
    const plan = plans[i]!;
    body = [
      {
        kind: "if",
        cond: {
          kind: "unionIsTag",
          unionId: receiverT.unionId,
          tag: lowerer.armTag(receiverT.unionId, plan.arm),
          negated: false,
          value: receiver,
          type: BOOL,
          loc,
        },
        then: branch(plan),
        else_: body,
        loc,
      },
    ];
  }
  const params: IrParam[] = [
    { localId: "this.0", name: "this", type: receiverT },
    ...shapes.map((shape, i) => ({ localId: `a.${i}`, name: `a${i}`, type: shape.type })),
  ];
  const locals: IrLocal[] = params.map((param) => ({
    id: param.localId,
    name: param.name,
    type: param.type,
    mutable: false,
  }));
  return { name, params, returnType: resultT, locals, body, loc };
}

/** The argument's lowered type for a message (what the static form saw),
 * or the checker's text when the argument itself does not lower. */
function loweredArgumentText(lowerer: Lowerer, arg: ts.Expression): string {
  const probed = tryLowerExpression(lowerer, arg);
  return probed !== null
    ? lowerer.fmt(probed.type)
    : lowerer.checker.typeToString(lowerer.checker.getTypeAtLocation(arg));
}

/** The static global number parsers (parseInt/parseFloat/isNaN/isFinite),
 * shared by the globals and their Number.* aliases. `call` blames arity
 * fences; null when the argument shape has no static form (the caller
 * reports the SC2012 refusal). */
export function lowerStaticNumberGlobal(
  lowerer: Lowerer,
  name: string,
  call: ts.CallExpression,
  args: readonly ts.Expression[],
  loc: SrcLoc,
): IrExpr | null {
  if (name === "parseInt" || name === "isNaN" || name === "isFinite") {
    const maxArgs = name === "parseInt" ? 2 : 1;
    if (args.length < 1 || args.length > maxArgs) {
      lowerer.noLowering(
        `${name} with ${args.length} argument${args.length === 1 ? "" : "s"}`,
        call,
      );
    }
    if (name === "isNaN" || name === "isFinite") {
      // The global's ToNumber turns a missing value into NaN, converts
      // strings, booleans and null, and calls valueOf/toString on objects.
      const x = lowerToNumberArgument(lowerer, args[0]!);
      const fn = name === "isNaN" ? "num.isNaN" : "number.isFinite";
      return { kind: "libCall", fn, args: [x], type: BOOL, loc };
    }
    const radix: IrExpr = args[1]
      ? lowerer.lowerExprExpecting(args[1], F64)
      : { kind: "numLit", value: 0, type: F64, loc };
    let optional = optionalCallValue(lowerer, args[0]!);
    let lowered: IrExpr | null = null;
    // A possibly-missing or untyped text in JavaScript (`parseInt(process.
    // env.PORT, 10)`): TypeScript rejects the call, Node parses the text
    // of whatever arrives ("undefined").
    if (optional === null && isJsSourceFile(ts.getSourceFileOfNode(call))) {
      const argT = lowerer.typeOf(args[0]!);
      const parts = argT.isUnionType() ? ts.constituentTypes(argT) : [argT];
      if (
        parts.some(
          (part) =>
            (part.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Any)) !== 0,
        )
      ) {
        const raw = lowerer.lowerExpr(args[0]!);
        if (raw.type.kind === "union") {
          optional = raw;
          lowered = raw;
        } else {
          const text: IrExpr =
            raw.type.kind === "dyn"
              ? { kind: "libCall", fn: "dyn.toStringCoerce", args: [raw], type: STRING, loc }
              : lowerer.coerceInto(args[0]!, raw, STRING);
          return { kind: "libCall", fn: "num.parseInt", args: [text, radix], type: F64, loc };
        }
      }
    }
    if (optional?.type.kind === "union") {
      const def = lowerer.unions.get(optional.type.unionId);
      const stringTag = def?.arms.findIndex((arm) => arm.kind === "string") ?? -1;
      if (
        def &&
        stringTag >= 0 &&
        def.arms.every((arm) => arm.kind === "string" || isUnitType(arm))
      ) {
        const unionT = optional.type;
        const key = `parseInt.optional:${unionT.unionId}`;
        let helper = lowerer.valueHelpers.get(key);
        if (!helper) {
          helper = keyedHelperName(lowerer, "%parseInt.optional", key);
          lowerer.valueHelpers.set(key, helper);
          const value: IrExpr = { kind: "varRef", localId: "value.0", type: unionT, loc };
          const radixRef: IrExpr = { kind: "varRef", localId: "radix.0", type: F64, loc };
          const body: IrStmt[] = def.arms.flatMap((arm, tag): IrStmt[] =>
            isUnitType(arm)
              ? [
                  {
                    kind: "if",
                    cond: {
                      kind: "unionIsTag",
                      unionId: unionT.unionId,
                      tag,
                      negated: false,
                      value,
                      type: BOOL,
                      loc,
                    },
                    // parseInt(undefined, radix) parses the text
                    // "undefined" (a number from radix 31 up).
                    then: [
                      {
                        kind: "return",
                        value: {
                          kind: "libCall",
                          fn: "num.parseInt",
                          args: [
                            {
                              kind: "strLit",
                              value: arm.kind === "nullT" ? "null" : "undefined",
                              type: STRING,
                              loc,
                            },
                            radixRef,
                          ],
                          type: F64,
                          loc,
                        },
                        loc,
                      },
                    ],
                    else_: null,
                    loc,
                  },
                ]
              : [],
          );
          body.push({
            kind: "return",
            value: {
              kind: "libCall",
              fn: "num.parseInt",
              args: [
                {
                  kind: "unionNarrow",
                  unionId: unionT.unionId,
                  tag: stringTag,
                  value,
                  type: STRING,
                  loc,
                },
                radixRef,
              ],
              type: F64,
              loc,
            },
            loc,
          });
          lowerer.liftedFns.push({
            name: helper,
            params: [
              { localId: "value.0", name: "value", type: unionT },
              { localId: "radix.0", name: "radix", type: F64 },
            ],
            returnType: F64,
            locals: [
              { id: "value.0", name: "value", type: unionT, mutable: true },
              { id: "radix.0", name: "radix", type: F64, mutable: true },
            ],
            body,
            loc,
          });
        }
        return { kind: "call", callee: helper, args: [optional, radix], type: F64, loc };
      }
    }
    const s =
      lowered !== null
        ? lowerer.coerceInto(args[0]!, lowered, STRING)
        : lowerer.lowerExprExpecting(args[0]!, STRING);
    return { kind: "libCall", fn: "num.parseInt", args: [s, radix], type: F64, loc };
  }
  // parseFloat takes one argument; Node ignores the rest after evaluating
  // them (`parseFloat(text, 10)`). Literal and identifier extras have
  // nothing to evaluate.
  if (
    name === "parseFloat" &&
    args.length > 1 &&
    args
      .slice(1)
      .every((arg) => ts.isNumericLiteral(arg) || ts.isStringLiteral(arg) || ts.isIdentifier(arg))
  )
    return lowerStaticNumberGlobal(lowerer, name, call, args.slice(0, 1), loc);
  // STATIC parseFloat over string arguments — parseInt's sibling
  // (num.parseFloat is ECMA 19.2.4's decimal-literal prefix parse in
  // scr_string.c). Other argument types retain their native coercion
  // checks or the SC2012 refusal. The probe never emits — lowering is IR
  // construction.
  if (name === "parseFloat" && args.length === 1) {
    const optional = optionalCallValue(lowerer, args[0]!);
    if (optional) {
      const parsed = lowerOptionalStringNumber(
        lowerer,
        optional,
        loc,
        "num.parseFloat",
        "parseFloat",
      );
      if (parsed) return parsed;
    }
    const probed = tryLowerExpression(lowerer, args[0]!);
    if (probed?.type.kind === "string") {
      return { kind: "libCall", fn: "num.parseFloat", args: [probed], type: F64, loc };
    }
    if (probed?.type.kind === "dyn") {
      return {
        kind: "libCall",
        fn: "num.parseFloat",
        args: [{ kind: "libCall", fn: "dyn.toStringCoerce", args: [probed], type: STRING, loc }],
        type: F64,
        loc,
      };
    }
  }
  return null;
}

/** `crypto.getRandomValues(view)` and `crypto.randomUUID()` on the
 * WebCrypto global or webcrypto. Other argument counts (JavaScript only)
 * invoke the dynamic object's method, which ignores extra arguments and
 * throws Node's missing-argument TypeError. */
function lowerWebCryptoMethodCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  const member = access.name.text;
  if (
    (member !== "getRandomValues" && member !== "randomUUID") ||
    call.questionDotToken ||
    access.questionDotToken ||
    !isWebCryptoReceiver(lowerer, access.expression)
  )
    return null;
  const args = call.arguments.nodes;
  if (member === "getRandomValues" && args.length === 1) {
    return lowerCryptoGetRandomValues(lowerer, call);
  }
  if (member === "randomUUID" && args.length === 0) {
    return { kind: "libCall", fn: "crypto.randomUUID", args: [], type: STRING, loc: locOf(call) };
  }
  if (args.some(ts.isSpreadElement)) return null;
  return {
    kind: "dynInvoke",
    recv: lowerer.lowerExprExpecting(access.expression, DYN),
    method: member,
    calleeName: v8CalleeText(access),
    args: args.map((arg) => lowerer.lowerExprExpecting(arg, DYN)),
    type: DYN,
    loc: locOf(call),
  };
}

/** A then handler's promise-armed result (`.then(() => cached ?? load())`
 * typed `T | Promise<T>`, or a `Promise<void> | void` callback's result):
 * the lifted async body adopts the promise arm and fulfills with the
 * others, like `return u` in an async function. Null for other results. */
function maybePromiseHandlerResult(
  lowerer: Lowerer,
  call: ts.CallExpression,
  value: IrExpr,
  R: IrType,
): IrStmt | null {
  const mp = promiseArmedUnionOf(lowerer, value.type);
  if (!mp || promiseArmedUnionOf(lowerer, R)) return null;
  const stmt = maybePromiseReturnStmt(lowerer, value, mp, R, (e) => lowerer.coerceInto(call, e, R));
  if (stmt === null) {
    lowerer.unsupported(
      "SC1090",
      call,
      `then handlers returning '${lowerer.fmt(value.type)}' into '${lowerer.fmt(R)}' (an arm does not convert to the result)`,
    );
  }
  return stmt;
}

/** `view.m(args)` where `view` is a `Pick<C, K>` / `Omit<C, K>` view of a
 * program class C and `m` is one of C's GENERIC methods (its overloads
 * included): generic methods have no dispatchable method value, so the
 * view's live receiver is extracted as the C instance it holds (a checked
 * extraction — a value of another class throws Node-style TypeError
 * text naming C) and the call monomorphizes statically against C, the
 * same lowering a C-typed receiver gets. Null for other receivers. */
function pickViewGenericMethodCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
  recvTs: ts.Type,
): IrExpr | null {
  const alias = recvTs.getAliasSymbol();
  if (alias === undefined || (ts.symbolName(alias) !== "Pick" && ts.symbolName(alias) !== "Omit"))
    return null;
  if (!alias.declarations.every((d) => ts.getSourceFileOfNode(d).isDeclarationFile)) return null;
  const source = recvTs.getAliasTypeArguments()[0];
  const symbol = source?.getSymbol();
  const info = symbol ? lowerer.classBySymbol.get(symbol) : undefined;
  if (!info || call.questionDotToken || access.questionDotToken) return null;
  const found = findGenericMethodOn(lowerer, info, access.name.text);
  if (!found) return null;
  const loc = locOf(access.expression);
  const lowered = lowerer.lowerExpr(access.expression);
  const instance: IrType = { kind: "object", className: info.def.name };
  // A view that statically holds an instance of another class (a
  // structurally compatible one) calls that class's method in Node, not
  // C's: the call is refused rather than extracted as a C instance.
  if (
    lowered.type.kind === "object" &&
    lowered.type.className !== info.def.name &&
    !lowerer.isSubclassOf(lowered.type.className, info.def.name)
  ) {
    lowerer.unsupported(
      "SC1090",
      access,
      `calling the generic method '${access.name.text}' through a '${ts.symbolName(alias)}' view of '${info.def.name}' that holds a '${lowerer.fmt(lowered.type)}'`,
    );
  }
  const receiver: IrExpr =
    lowered.type.kind === "object"
      ? lowered
      : { kind: "dynCheck", value: lowerer.coerceToExpected(lowered, DYN), type: instance, loc };
  return lowerClassGenericMethodCall(lowerer, call, access, info, found, receiver);
}

/** `Object.assign(err, ...sources)` in TypeScript onto an error-hierarchy
 * target (`Object.assign(new Error(message), details)`): the sources'
 * own members land on the error — the runtime copy over its
 * checked-dynamic node, whose name, message, stack, cause and code feed
 * back into the typed slots — and the call answers the error itself.
 * Null for every other target. */
function lowerObjectAssignOntoError(lowerer: Lowerer, call: ts.CallExpression): IrExpr | null {
  const argNodes = call.arguments.nodes;
  if (
    isJsSourceFile(ts.getSourceFileOfNode(call)) ||
    argNodes.length < 2 ||
    argNodes.some((a) => ts.isSpreadElement(a))
  )
    return null;
  const probe = tryLowerExpression(lowerer, argNodes[0]!);
  if (probe?.type.kind !== "object" || !lowerer.isErrorRootedClass(probe.type.className))
    return null;
  const loc = locOf(call);
  const target = lowerer.lowerExpr(argNodes[0]!);
  const slot = lowerer.declareHiddenLocal("%assignErr", target.type);
  const sources: IrExpr[] = [];
  for (const node of argNodes.slice(1)) {
    const raw = lowerer.lowerExpr(node);
    fenceSymbolFieldCopy(lowerer, node, raw.type);
    const source = lowerer.coerceToExpected(raw, DYN);
    if (source.type.kind !== "dyn") {
      lowerer.unsupported(
        "SC1090",
        node,
        `Object.assign onto an Error from a '${lowerer.fmt(raw.type)}' source (sources enter the error's dynamic properties)`,
      );
    }
    sources.push(source);
  }
  const ref = (): IrExpr => ({ kind: "varRef", localId: slot.id, type: target.type, loc });
  return {
    kind: "seqExpr",
    stmts: [
      { kind: "varDecl", localId: slot.id, init: target, loc },
      {
        kind: "exprStmt",
        expr: {
          kind: "libCall",
          fn: "error.assign",
          args: [ref(), { kind: "dynArrLit", elems: sources, type: DYN, loc }],
          type: VOID,
          loc,
        },
        loc,
      },
    ],
    result: ref(),
    type: target.type,
    loc,
  };
}

/** `Object.freeze(fn)` and the other integrity operations on a function
 * value: the function's checked-dynamic face holds its own properties (the
 * ones a program assigns, `name`, `length`, `prototype`) and their
 * integrity state, which the runtime keeps on its property table. The
 * mutators answer the function itself; the queries answer from the table.
 * Null for other values. */
function functionIntegrity(
  lowerer: Lowerer,
  member: string,
  value: IrExpr,
  node: ts.Expression,
  loc: SrcLoc,
): IrExpr | null {
  if (value.type.kind !== "func" || !lowerer.dynConvertible(value.type)) return null;
  const operations = {
    freeze: "dyn.freeze",
    seal: "dyn.seal",
    preventExtensions: "dyn.preventExtensions",
    isSealed: "dyn.isSealed",
    isExtensible: "dyn.isExtensible",
  } as const;
  if (!(member in operations)) return null;
  const fn = operations[member as keyof typeof operations];
  // The first operation on a function creates its property table, whose
  // `name` comes from the box: give the box the function's JS name, as a
  // closure flowing into any checked-dynamic slot gets.
  const name = jsFuncNameOf(node, lowerer);
  const boxed = (e: IrExpr): IrExpr => {
    const box = lowerer.coerceToExpected(e, DYN);
    return box.kind === "dynFrom" && name !== null ? { ...box, fnName: name } : box;
  };
  if (fn === "dyn.isSealed" || fn === "dyn.isExtensible") {
    return { kind: "libCall", fn, args: [boxed(value)], type: BOOL, loc };
  }
  const held = lowerer.declareHiddenLocal("%integrityFn", value.type);
  const ref = (): IrExpr => ({ kind: "varRef", localId: held.id, type: value.type, loc });
  return {
    kind: "seqExpr",
    stmts: [
      { kind: "varDecl", localId: held.id, init: value, loc },
      {
        kind: "exprStmt",
        expr: { kind: "libCall", fn, args: [boxed(ref())], type: DYN, loc },
        loc,
      },
    ],
    result: ref(),
    type: value.type,
    loc,
  };
}

/** A class instance copied into a fresh object (`Object.assign({},
 * instance)`): the result is a plain object holding the instance's own
 * fields, never an instance, so a result the checker types as the class has
 * no representation (the checked cast would throw). */
function fenceClassCopyIntoFreshObject(
  lowerer: Lowerer,
  call: ts.CallExpression,
  srcNode: ts.Expression,
  rawSource: IrExpr,
): void {
  if (rawSource.type.kind !== "object" || ts.isExpressionStatement(call.parent)) return;
  const resultT = lowerer.mapTypeOf(lowerer.typeOf(call));
  if (resultT === null || resultT.kind !== "object") return;
  lowerer.unsupported(
    "SC1090",
    srcNode,
    `Object.assign copying a '${lowerer.fmt(rawSource.type)}' instance into a fresh object typed as the class (the copy is a plain object holding the instance's own fields, not an instance — build the object literal from the fields you need)`,
  );
}

/** True when an untyped JavaScript receiver names a binding whose declaring
 * file assigns it an own `toString` (the TypeScript namespace downlevel
 * `errorUtil.toString = (message) => ...` in zod): its calls answer what
 * that function returns, not Object.prototype.toString's string. */
function jsAssignsOwnToString(lowerer: Lowerer, receiver: ts.Expression): boolean {
  if (!ts.isIdentifier(receiver)) return false;
  const decl = bindingDeclaration(lowerer, receiver);
  if (decl === undefined) return false;
  const sf = ts.getSourceFileOfNode(decl);
  if (!isJsSourceFile(sf)) return false;
  let targets = lowerer.ownToStringTargets.get(sf);
  if (targets === undefined) {
    targets = ownToStringTargets(lowerer, sf);
    lowerer.ownToStringTargets.set(sf, targets);
  }
  return targets.has(decl);
}

const unparenthesized = (e: ts.Expression): ts.Expression => {
  let out = e;
  while (ts.isParenthesizedExpression(out)) out = out.expression;
  return out;
};

/** The declaration of the binding an identifier names, through imports. */
function bindingDeclaration(lowerer: Lowerer, id: ts.Identifier): ts.Node | undefined {
  let sym = lowerer.checker.getSymbolAtLocation(id);
  if (sym !== undefined && (sym.flags & ts.SymbolFlags.Alias) !== 0)
    sym = lowerer.checker.getAliasedSymbol(sym);
  return sym?.valueDeclaration ?? sym?.declarations?.[0];
}

/** The declarations of the bindings a file's assignments `x.toString = ...`
 * (or `x["toString"] = ...`) give an own `toString`. An assignment through
 * the parameter of an immediately called function counts for the binding
 * the call passes (`(function (ns) { ns.toString = f; })(ns || (ns = {}))`). */
function ownToStringTargets(lowerer: Lowerer, sf: ts.SourceFile): Set<ts.Node> {
  const targets = new Set<ts.Node>();
  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const left = unparenthesized(node.left);
      const named =
        (ts.isPropertyAccessExpression(left) && left.name.text === "toString") ||
        (ts.isElementAccessExpression(left) &&
          ts.isStringLiteralLike(left.argumentExpression) &&
          left.argumentExpression.text === "toString");
      const target = named
        ? unparenthesized(
            (left as ts.PropertyAccessExpression | ts.ElementAccessExpression).expression,
          )
        : undefined;
      if (target !== undefined && ts.isIdentifier(target)) {
        const decl = bindingDeclaration(lowerer, target);
        if (decl !== undefined) {
          targets.add(decl);
          const passed = iifeArgumentDeclaration(lowerer, decl);
          if (passed !== undefined) targets.add(passed);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return targets;
}

/** For a parameter of an immediately called function, the declaration of
 * the binding its argument names: `x`, `x || (x = {})` or `(x = {})`. */
function iifeArgumentDeclaration(lowerer: Lowerer, param: ts.Node): ts.Node | undefined {
  if (!ts.isParameter(param)) return undefined;
  const fn = param.parent;
  if (!ts.isFunctionExpression(fn) && !ts.isArrowFunction(fn)) return undefined;
  let callee: ts.Node = fn;
  while (ts.isParenthesizedExpression(callee.parent)) callee = callee.parent;
  const call = callee.parent;
  if (!ts.isCallExpression(call) || call.expression !== callee) return undefined;
  const index = fn.parameters.nodes.indexOf(param);
  let arg = index < 0 ? undefined : call.arguments.nodes[index];
  if (arg === undefined) return undefined;
  arg = unparenthesized(arg);
  if (ts.isBinaryExpression(arg) && arg.operatorToken.kind === ts.SyntaxKind.BarBarToken)
    arg = unparenthesized(arg.left);
  if (ts.isBinaryExpression(arg) && arg.operatorToken.kind === ts.SyntaxKind.EqualsToken)
    arg = unparenthesized(arg.left);
  return ts.isIdentifier(arg) ? bindingDeclaration(lowerer, arg) : undefined;
}

/** The runtime calls package shims declare as bodiless functions. */
const SHIM_INTRINSICS: ReadonlyMap<string, { fn: IrLibFn; args: IrType[]; ret: IrType }> = new Map<
  string,
  { fn: IrLibFn; args: IrType[]; ret: IrType }
>([
  ["scriptcUnixDgramSocket", { fn: "dgram.unixSocket", args: [], ret: F64 }],
  ["scriptcUnixDgramConnect", { fn: "dgram.unixConnect", args: [F64, STRING], ret: F64 }],
  ["scriptcUnixDgramSend", { fn: "dgram.unixSend", args: [F64, BYTES_U8], ret: F64 }],
  ["scriptcUnixDgramClose", { fn: "dgram.unixClose", args: [F64], ret: F64 }],
  ["scriptcResponseLight", { fn: "fetch.responseLight", args: [DYN], ret: arrayOf(STRING) }],
]);

function lowerShimIntrinsicCall(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  callee: ts.Identifier,
  loc: SrcLoc,
): IrExpr | null {
  const intrinsic = SHIM_INTRINSICS.get(callee.text);
  if (intrinsic === undefined) return null;
  const decl = lowerer.checker.getSymbolAtLocation(callee)?.valueDeclaration;
  if (
    decl === undefined ||
    !ts.isFunctionDeclaration(decl) ||
    decl.body ||
    !isPackageShimFile(ts.getSourceFileOfNode(decl).fileName) ||
    expr.arguments.nodes.length !== intrinsic.args.length
  )
    return null;
  const args = expr.arguments.nodes.map((arg, i) =>
    lowerer.lowerExprExpecting(arg, intrinsic.args[i]!),
  );
  return { kind: "libCall", fn: intrinsic.fn, args, type: intrinsic.ret, loc };
}
