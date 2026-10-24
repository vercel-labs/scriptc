import { widensReducedRecords } from "../function-returns.js";
import { widthNarrowHelper } from "../coercions/unions.js";
/* Property reads (`a.b`): lowerExprInner's property-access branch, intrinsic and union properties, field reads and targets, and match-group reads. */
import { indexedUnionArms, lowerIndexedUnionMember } from "../indexed-unions.js";
import { keyedHelperName } from "../stable-names.js";
import { staticallySelected } from "../static-typeof.js";
import * as ts from "../../ts7/adapter.js";
import { lowerHistogramProperty } from "../builtins/performance.js";
import { staticFunctionNameRead } from "../static-function-names.js";
import { typedArgumentsArity } from "../typed-arguments.js";
import { isThisParameter } from "../call-signatures.js";
import {
  checkedPrivateValue,
  localPrivateBrandClass,
  privateNameClass,
} from "../private-brands.js";
import { type Lowerer, PoisonError, jsFuncNameOf, neverTaintedJsType, own } from "../lowerer.js";
import {
  ARRAY_METHODS,
  MAP_METHODS,
  NARROW_FIRST,
  OBJECT_CALLABLE_VALUES,
  SET_METHODS,
  STDLIB_SURFACE,
  STRING_INDEX_METHODS,
  STR_METHODS,
  isChildSurfaceMember,
  stdlibGlobalNameOf,
} from "../surfaces.js";
import {
  isGenericCallableMemberType,
  isLegacyUrlSymbol,
  isOsConstantsType,
  isParseArgsDynTypeName,
} from "../../type-mapper.js";
import {
  BOOL,
  BYTES_ELEMENT_NAME,
  BYTES_U8,
  DYN,
  F64,
  type IrExpr,
  type IrLocal,
  type IrRecordShape,
  type IrStmt,
  type IrType,
  NULL_T,
  SEARCH_PARAMS_T,
  STRING,
  SYMBOL_T,
  type SrcLoc,
  UNDEFINED_T,
  arrayOf,
  canBoxFuncIntoDyn,
  funcOf,
  isDynTypedRefType,
  isUnitType,
  typeEquals,
  typeKey,
  unionContainerArmsOk,
  BYTES_ELEMENT_SIZE,
} from "../../../ir/ir.js";
import { lowerNavigatorMember } from "../builtins/navigator.js";
import { NODE_COMPAT_VERSION } from "../builtins/process.js";
import {
  inlineNamespaceRequireOf,
  lowerWithInlineRequireInit,
  wholeExportValue,
} from "../cjs-inline-require.js";
import {
  type FieldTarget,
  cjsAccessorCall,
  constInitializerOf,
  exactUnionWidening,
  hasClassPayload,
  lowerExpr,
  matchAllCallbackRegexOf,
  matchAllRegexOf,
  namedCaptureGroupsOfPattern,
  primitiveCtorClosure,
  recordKeyResultOk,
  representedClassFieldTarget,
  staticRegexPatternOf,
} from "../lower-exprs.js";
import {
  cjsInFileExportGlobalOf,
  isCjsExportsIdentifier,
  lowerCjsExportsObjectValue,
} from "../cjs-exports-object.js";
import { tscInteropDefaultValueOf } from "../cjs-tsc-interop.js";
import { lifetimeRegionMemberOf } from "../../experimental-import.js";
import { lowerInternTableProperty } from "../intern-tables.js";
import { lowerThreadSlotsProperty } from "../thread-slots.js";
import { builtinClassRefOf, runtimeClassValueOfType } from "../builtins/class-values.js";
import {
  lowerRuntimeConstructor,
  lowerRuntimeConstructorName,
  runtimeConstructorReceiver,
} from "../builtins/runtime-constructor.js";
import { findGenericMethodOn, lowerStaticFieldRead } from "../lower-classes.js";
import { isErrorPrototypeValue, lowerClassPrototypeData } from "../class-prototypes.js";
import { lowerEnumAccess } from "../lower-enums.js";
import {
  hasOptionalChainGuard,
  isOptionalChainTail,
  isRequireMainFilename,
} from "./optional-chains.js";
import {
  isCjsModuleGlobal,
  lowerNodeModuleProperty,
  lowerRequireMainProperty,
} from "../lower-node-module.js";
import { dynUndefinedExpr, nodeThrowExpr, numLit, strLit, varRef } from "../../../ir/build.js";
import { typedArrayLacksMember } from "../builtins/typed-array-members.js";
import { TEMPORAL_GLOBAL } from "../../builtin-modules.js";
import { tryLowerExpression } from "./try-lower-expression.js";
import {
  cjsClassExprWholeExportOf,
  cjsExportAssignmentOf,
  cjsExportDiscardReason,
  isCjsExportTableLiteral,
  isCjsJsFile,
  isJsSourceFile,
  isModuleExportsAccess,
  isNodeEsmFile,
  locOf,
} from "../../program.js";
import {
  ambientNsRootOf,
  ambientUndefReadType,
  ambientUndefVarRootOf,
  contextualUndefReadType,
  fenceEarlyNsMemberRef,
  nsMemberIdentOf,
  nsUndefRead,
} from "../lower-namespaces.js";
import { expandoMemberRead } from "../lower-expando.js";
import { lowerProtocolPropertyRead } from "../class-protocol-dispatch.js";
import { lowerReadlineProperty } from "../builtins/readline.js";
import { lowerAsyncLocalStorageProperty } from "../builtins/async-context.js";
import { lowerEventStaticProperty } from "../builtins/numbers.js";
import { lowerStreamProperty, lowerStreamStateProperty, streamSidesOf } from "../lower-stream.js";
import { lowerValueStreamProperty } from "../builtins/hash-stream.js";
import { lowerEventObjectProperty } from "../lower-event-target.js";
import { iteratorResultValueRead } from "../lower-generators.js";
import { lowerGlobalValue } from "../lower-global-value.js";
import { nullishGenericBindingUnitOf } from "../binding-analysis.js";
import { blockedBindingUseDiag } from "../../../diagnostics/diagnostic.js";
import { npmStaticPackageOfPath } from "../../npm-static.js";
import { importMetaField, isImportMeta } from "../import-meta.js";
import {
  builtinPrototypeMethod,
  lowerArrayIsArrayValue,
  lowerCheckedPredicateValue,
  lowerNumberParserValue,
  lowerObjectAssignValue,
  lowerStringCodesValue,
} from "../lower-builtin-values.js";
import { lowerArrayFromValue } from "../containers/array-construction.js";
import { lowerBufferPrototypeMember } from "../containers/bytes.js";
import { lowerNetAddressStaticRead } from "../builtins/net-address.js";
import { STATS_TYPE_TESTS } from "../builtins/filesystem.js";
import { arrayValueRead, arrayValueType } from "../array-values.js";
import { lowerClassMethodValue } from "../class-method-values.js";
import {
  objLitGenericFnInfoOf,
  objLitGenericFnNodeOf,
  requireObjLitGenericReceiver,
} from "../generic-functions.js";
import { narrowStoredClassValue, structuralReadType } from "../class-unions.js";
import { InternalCompilerError } from "../../../errors.js";
import { lowerUnionFieldRead } from "./union-fields.js";
import { errorPropertyRead } from "../error-methods.js";
import { isSafeToDiscard, isSafeToRepeat } from "./evaluation-safety.js";
import { isZlibStreamMember, lowerZlibStreamBytesWritten } from "../builtins/compression.js";
import { isWebCryptoReceiver } from "../builtins/crypto.js";
import { isFsStreamMember, lowerFsStreamProperty } from "../builtins/fs-streams.js";
import { keyedFieldRead } from "./keyed-field-targets.js";
import { promisePrototypeValue } from "../thenables.js";
import { lowerChildPropertyRead } from "../handle-properties.js";

/** True when a property access names an ABSTRACT property declaration
 * (`abstract p: number` — a PropertyDeclaration, not an accessor).
 * These uses need concrete property dispatch because the base has no slot. */
export function abstractPropertyDeclOf(
  lowerer: Lowerer,
  expr: ts.PropertyAccessExpression,
): boolean {
  const sym = lowerer.checker.getSymbolAtLocation(expr.name);
  if (!sym) return false;
  return sym.declarations.some(
    (d) =>
      ts.isPropertyDeclaration(d) &&
      ts.getModifiers(d)?.some((m) => m.kind === ts.SyntaxKind.AbstractKeyword) === true,
  );
}

/** A field declared by node:util's parseArgs checked-dynamic type family.
 * Narrowing a ParseArgsToken exposes one anonymous union arm, so its alias
 * identity no longer reaches mapType; declaration ancestry is the stable
 * provenance check. */
/** The Uint8Array base64/hex prototype methods (ES2026) Node 24 lacks. */
const UINT8ARRAY_BASE64_METHODS: ReadonlySet<string> = new Set([
  "toBase64",
  "toHex",
  "setFromBase64",
  "setFromHex",
]);

/** `Uint8Array.prototype.<base64/hex method>` read off the global. */
function isUint8ArrayBase64Probe(lowerer: Lowerer, expr: ts.PropertyAccessExpression): boolean {
  if (!UINT8ARRAY_BASE64_METHODS.has(expr.name.text)) return false;
  const proto = expr.expression;
  return (
    ts.isPropertyAccessExpression(proto) &&
    !proto.questionDotToken &&
    proto.name.text === "prototype" &&
    stdlibGlobalNameOf(lowerer, proto.expression) === "Uint8Array"
  );
}

function isParseArgsDynProperty(lowerer: Lowerer, expr: ts.PropertyAccessExpression): boolean {
  const sym = lowerer.checker.getSymbolAtLocation(expr.name);
  if (!sym) return false;
  return sym.declarations.some((d) => {
    if (!lowerer.isStdlibFile(ts.getSourceFileOfNode(d))) return false;
    let inParseArgsType = false;
    for (let node: ts.Node | undefined = d.parent; node; node = node.parent) {
      if (
        (ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) &&
        isParseArgsDynTypeName(node.name.text)
      ) {
        inParseArgsType = true;
      }
      if (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name)) {
        return inParseArgsType && (node.name.text === "util" || node.name.text === "node:util");
      }
    }
    return false;
  });
}

function isStatFsDynProperty(lowerer: Lowerer, expr: ts.PropertyAccessExpression): boolean {
  if (
    !["type", "bsize", "blocks", "bfree", "bavail", "files", "ffree", "bigint"].includes(
      expr.name.text,
    )
  )
    return false;
  const symbol = lowerer.checker.getSymbolAtLocation(expr.name);
  return (
    !!symbol &&
    symbol.declarations.some((declaration) => {
      if (!lowerer.isStdlibFile(ts.getSourceFileOfNode(declaration))) return false;
      const parent = declaration.parent;
      if (!ts.isInterfaceDeclaration(parent)) return false;
      if (
        expr.name.text === "bigint"
          ? parent.name.text !== "StatFsOptions"
          : !["StatsFsBase", "StatsFs", "BigIntStatsFs"].includes(parent.name.text)
      )
        return false;
      for (let node: ts.Node | undefined = parent.parent; node; node = node.parent) {
        if (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name))
          return node.name.text === "fs" || node.name.text === "node:fs";
      }
      return false;
    })
  );
}

/** The dgram.Socket methods its checked-dynamic handle answers as
 * function values (scr_dgram.c's scr_dgram_dyn_method_names). */
const DGRAM_METHOD_VALUES = new Set([
  "on",
  "once",
  "addListener",
  "removeListener",
  "off",
  "emit",
  "send",
  "close",
  "bind",
  "connect",
  "disconnect",
  "address",
  "ref",
  "unref",
]);

export function lowerPropertyAccessExpr(
  lowerer: Lowerer,
  expr: ts.PropertyAccessExpression,
  loc: SrcLoc,
): IrExpr {
  // `value.#x` on a checked-dynamic value, or on a checked extraction of
  // one: the field of the brand-checked receiver (checkedPrivateValue).
  if (ts.isPrivateIdentifier(expr.name)) {
    const owner = privateNameClass(lowerer, expr.name);
    const field = owner?.fields.get(expr.name.text);
    const probed = field ? tryLowerExpression(lowerer, expr.expression) : null;
    if (owner && field && probed && checkedDynamicValue(probed)) {
      const value = checkedDynamicValue(lowerer.lowerExpr(expr.expression))!;
      return {
        kind: "fieldGet",
        obj: checkedPrivateValue(lowerer, owner, expr, value, loc),
        className: owner.def.name,
        field: expr.name.text,
        type: field,
        loc,
      };
    }
  }
  // Node's navigator is never nullish, so `navigator?.userAgent` (zod's
  // Cloudflare probe) folds like `navigator.userAgent`.
  const navigator = lowerNavigatorMember(lowerer, expr, NODE_COMPAT_VERSION);
  if (navigator) return navigator;
  {
    const member = lowerBufferPrototypeMember(lowerer, expr);
    if (member) return member;
  }
  // A dgram socket's method read as a value in JavaScript (`emit:
  // socket.emit.bind(socket)`): the socket crosses as its checked-dynamic
  // handle, whose methods are function values that dispatch on their
  // receiver, as the prototype methods do. The receiver is a native
  // socket whatever its declaration spells (the shipped types declare no
  // EventEmitter members), so the name decides.
  if (
    !expr.questionDotToken &&
    DGRAM_METHOD_VALUES.has(expr.name.text) &&
    isJsSourceFile(ts.getSourceFileOfNode(expr)) &&
    lowerer.mapTypeOf(lowerer.typeOf(expr.expression))?.kind === "dgramSocket"
  ) {
    return {
      kind: "dynKeyGet",
      value: lowerer.coerceToExpected(lowerer.lowerExpr(expr.expression), DYN),
      key: { kind: "strLit", value: expr.name.text, type: STRING, loc },
      type: DYN,
      loc,
    };
  }
  // `fn.name` on a function parameter of a generic instance keyed by
  // its argument's static name (call-site specialization).
  {
    const staticName = staticFunctionNameRead(lowerer, expr);
    if (staticName !== null) return { kind: "strLit", value: staticName, type: STRING, loc };
  }
  // An IntervalHistogram's readings (min, max, mean, stddev, count, exceeds).
  {
    const reading = lowerHistogramProperty(lowerer, expr);
    if (reading) return reading;
  }
  // `.length` of a forwarded fixed tuple (a typed `arguments`, a tuple
  // rest parameter, an alias of either): the signature's arity.
  if (expr.name.text === "length" && !expr.questionDotToken) {
    const arity = typedArgumentsArity(lowerer, expr.expression);
    if (arity !== null) return { kind: "numLit", value: arity, type: F64, loc };
  }
  // `require("./x").member` over a program module's export table: the
  // module's %init at this position, then the member read exactly like
  // a `const m = require("./x")` binding's (cjs-inline-require.ts).
  if (!expr.questionDotToken) {
    const req = inlineNamespaceRequireOf(lowerer, expr.expression);
    if (req !== null && !lowerer.inlineRequireInitDone.has(req.call)) {
      return lowerWithInlineRequireInit(lowerer, req, () => lowerExpr(lowerer, expr));
    }
    // `module.exports` compared by identity inside its own module, or
    // refused by name as any other value (cjs-exports-object.ts).
    if (expr.name.text === "exports") {
      const exportsValue = lowerCjsExportsObjectValue(lowerer, expr);
      if (exportsValue) return exportsValue;
    }
    // tsc's `x_1.default` over a dependency whose whole export is one
    // value: that value (cjs-tsc-interop.ts).
    const interop = tscInteropDefaultValueOf(lowerer, expr);
    if (interop !== null) {
      const value = wholeExportValue(lowerer, interop.dep, expr);
      if (value !== null) return value;
    }
  }
  {
    const member = lifetimeRegionMemberOf(lowerer.program, expr, lowerer.experimentalFiles);
    if (member !== null)
      lowerer.noLowering(
        `LifetimeRegion.${member} (@scriptc/experimental) as a value`,
        expr,
        `call region.${member}(${member === "run" ? "fn" : ""}) directly`,
      );
  }
  {
    const table = lowerInternTableProperty(lowerer, expr);
    if (table) return table;
  }
  lowerThreadSlotsProperty(lowerer, expr);
  // `EventEmitter.name`, `zlib.Gzip.name`, `C.name` over a builtin
  // class alias.
  if (expr.name.text === "name" && !expr.questionDotToken) {
    const ref = builtinClassRefOf(lowerer, expr.expression);
    if (ref !== null) return { kind: "strLit", value: ref.name, type: STRING, loc };
  }
  // `x.constructor.name` and `x.constructor` on an instance of
  // EventEmitter or a stream class (builtins/runtime-constructor.ts).
  if (expr.name.text === "name" && !expr.questionDotToken) {
    const ctor = runtimeConstructorReceiver(lowerer, expr.expression);
    if (ctor) return lowerRuntimeConstructorName(lowerer, ctor.receiver, loc);
  }
  {
    const ctor = runtimeConstructorReceiver(lowerer, expr);
    if (ctor) return lowerRuntimeConstructor(lowerer, expr, ctor.info);
  }
  // `C.name` through a runtime-provided class VALUE (a `typeof Readable`
  // parameter): the class object's stored name.
  if (
    expr.name.text === "name" &&
    !expr.questionDotToken &&
    runtimeClassValueOfType(lowerer, lowerer.typeOf(expr.expression)) !== null
  ) {
    const read = lowerer.lowerFieldRead(expr);
    if (read) return read;
  }
  // Expando statics may still be absent even when JS inference sees
  // the eventual assignment's scalar type. Preserve the checked value.
  const staticField = lowerStaticFieldRead(lowerer, expr);
  if (staticField) return staticField;
  const prototypeData = lowerClassPrototypeData(lowerer, expr);
  if (prototypeData) return prototypeData;
  if (ts.isPropertyAccessExpression(expr.expression) && expr.expression.name.text === "prototype") {
    const prototype = lowerClassPrototypeData(lowerer, expr.expression);
    if (prototype)
      return {
        kind: "dynKeyGet",
        value: prototype,
        key: { kind: "strLit", value: expr.name.text, type: STRING, loc },
        type: DYN,
        loc,
      };
  }
  // `super.x`: the base chain's GETTER, called directly (super
  // dispatch is static in JS — never through the dynamic class).
  // super.method() calls are routed at the call site; a bare super
  // property read lands here.
  if (expr.expression.kind === ts.SyntaxKind.SuperKeyword) {
    return lowerer.lowerSuperAccessorRead(expr);
  }
  // Enum member reads (`E.A`) fold to their compile-time constants —
  // claimed FIRST so no receiver-shaped path (records, the
  // identifier fence on the enum object) sees them. lower-enums.ts.
  {
    const en = lowerEnumAccess(lowerer, expr);
    if (en) return en;
  }
  // `import.meta.<field>` — the file-backed ESM metadata that survives
  // compilation as a constant. Only direct, identifier-named reads are
  // claimed here; the bare meta object, computed access, writes, and
  // unsupported members continue through the generic module-loader fence
  // below. The source file is the module identity, so imported modules
  // receive their own filename/dirname and only the entry receives main.
  const importMeta = importMetaProperty(lowerer, expr);
  if (importMeta) return importMeta;
  // `require.main.filename` / `require.main?.filename` — CommonJS
  // entry-module identity: in a compiled binary require.main IS the
  // entry module (never undefined in a CJS graph, so the chain's guard
  // folds away), and its filename is the ENTRY file's real path —
  // Node's exact value when the same tree runs in place, exactly the
  // __filename stance. Checked BEFORE the optional-chain gate: the
  // checker types the chain `string | undefined`, but the value is a
  // compile-time string.
  if (isRequireMainFilename(lowerer, expr)) {
    return { kind: "strLit", value: lowerer.entry.fileName, type: STRING, loc };
  }
  const requireMain = lowerRequireMainProperty(lowerer, expr);
  if (requireMain) return requireMain;
  const moduleProperty = lowerNodeModuleProperty(lowerer, expr);
  if (moduleProperty) return moduleProperty;
  if (
    stdlibGlobalNameOf(lowerer, expr.expression) === "Symbol" &&
    [
      "iterator",
      "asyncIterator",
      "toStringTag",
      "toPrimitive",
      "hasInstance",
      "isConcatSpreadable",
      "match",
      "matchAll",
      "replace",
      "search",
      "split",
      "species",
      "unscopables",
      "dispose",
      "asyncDispose",
    ].includes(expr.name.text)
  ) {
    return {
      kind: "libCall",
      fn: "sym.wellKnown",
      args: [{ kind: "strLit", value: expr.name.text, type: STRING, loc }],
      type: { kind: "symbol" },
      loc,
    };
  }
  if (lowerer.stdlibGlobalMember(expr, "Object") === "freeze") {
    const name = "%builtin.Object.freeze";
    if (!lowerer.liftedFns.some((fn) => fn.name === name))
      lowerer.liftedFns.push({
        name,
        params: [{ localId: "value", name: "value", type: DYN }],
        locals: [{ id: "value", name: "value", type: DYN, mutable: false }],
        returnType: DYN,
        body: [
          {
            kind: "return",
            value: {
              kind: "libCall",
              fn: "dyn.freeze",
              args: [varRef("value", DYN, loc)],
              type: DYN,
              loc,
            },
            loc,
          },
        ],
        loc,
      });
    return { kind: "closure", fnName: name, captures: [], type: funcOf([DYN], DYN), loc };
  }
  // An Hmac has no copy() (Hash does): Node answers undefined, which
  // `typeof mac.copy` feature checks read. TypeScript rejects the read.
  if (
    expr.name.text === "copy" &&
    lowerer.mapTypeOf(lowerer.typeOf(expr.expression))?.kind === "cryptoHmac"
  ) {
    return {
      kind: "seqExpr",
      stmts: [{ kind: "exprStmt", expr: lowerer.lowerExpr(expr.expression), loc }],
      result: dynUndefinedExpr(loc),
      type: DYN,
      loc,
    };
  }
  if (lowerer.stdlibGlobalMember(expr, "globalThis") === "console") {
    return { kind: "libCall", fn: "console.native", args: [], type: DYN, loc };
  }
  if (lowerer.stdlibGlobalMember(expr, "console") !== null) {
    return {
      kind: "dynKeyGet",
      value: { kind: "libCall", fn: "console.native", args: [], type: DYN, loc },
      key: { kind: "strLit", value: expr.name.text, type: STRING, loc },
      type: DYN,
      loc,
    };
  }
  // Missing host globals (Bun/Deno capability probes) have no binding
  // in a native program. Declared globals retain their own lowering;
  // arbitrary global-object mutation remains fenced. Preserve a dyn
  // undefined value so stored probes compose with optional calls.
  if (
    stdlibGlobalNameOf(lowerer, expr.expression) === "globalThis" &&
    !lowerer.checker.getPropertyOfType(
      lowerer.typeOf(staticallySelected(lowerer, expr.expression)),
      expr.name.text,
    )
  ) {
    // A name the program stores on the global object
    // (`(_a = globalThis).__config ?? (_a.__config = {})`) reads back from
    // the global object's own properties.
    const globalType = lowerer.typeOf(staticallySelected(lowerer, expr.expression));
    if (globalThisWrittenNames(lowerer, globalType).has(expr.name.text)) {
      return {
        kind: "dynKeyGet",
        value: lowerer.coerceToExpected(lowerer.lowerExpr(expr.expression), DYN),
        key: { kind: "strLit", value: expr.name.text, type: STRING, loc },
        type: DYN,
        loc,
      };
    }
    return dynUndefinedExpr(loc);
  }
  // `Uint8Array.prototype.toBase64` and its siblings, the base64/hex
  // feature probes libraries such as jose make: the methods are newer
  // than Node 24, whose Uint8Array prototype answers undefined for them.
  if (isUint8ArrayBase64Probe(lowerer, expr)) return dynUndefinedExpr(loc);
  if (expr.questionDotToken && expr.name.text === "electron") {
    const processProperty = lowerer.lowerProcessProperty(expr);
    if (processProperty) return processProperty;
  }
  // Optional chaining `a?.b`: the guard lowers here (a tag test around
  // the plain property lowering below); the handled marker keeps this
  // re-entrant dispatch from looping.
  if (expr.questionDotToken && !lowerer.chainHandled.has(expr)) {
    return lowerer.lowerOptionalChain(expr);
  }
  // `a?.b.c` — the tail of a chain whose token sits deeper: the whole
  // tail short-circuits with the guard.
  if (!expr.questionDotToken && isOptionalChainTail(lowerer, expr)) {
    return lowerer.lowerOptionalChain(expr);
  }
  // Known Web handles retain their declared surface even when their
  // storage uses checked values. Apply this before generic reads.
  lowerer.fenceStaticAbortControllerMemberRead(expr);
  lowerer.fenceStaticResponseMember(expr, "read");
  lowerer.fenceStaticHeadersMember(expr, "read");
  lowerer.fenceStaticReadableStreamMember(expr, "read");

  // — reading off null/undefined — bridged catchably like everything
  // at the boundary). `o?.x` arrives here too, through the chain
  // lowering's re-dispatch (a questionDotToken past the gate above is
  // always chain-handled; the receiver reads back as the chain's
  // bound handle).

  // `m.index` on a for-of-over-matchAll binding reads the companion-
  // index array at this iteration's cursor — always a number: every
  // drained row matched, so the lib's `.index` is never undefined
  // here (lowerForOfMatchAll).
  if (expr.name.text === "index" && !expr.questionDotToken && ts.isIdentifier(expr.expression)) {
    const sym = lowerer.checker.getSymbolAtLocation(expr.expression);
    const companion = sym !== undefined ? lowerer.matchAllIndexBindings.get(sym) : undefined;
    if (companion !== undefined) {
      return {
        kind: "arrayGet",
        arr: { kind: "varRef", localId: companion.idxsLocalId, type: arrayOf(F64), loc },
        index: { kind: "varRef", localId: companion.curLocalId, type: F64, loc },
        type: F64,
        loc,
      };
    }
  }
  if ((expr.name.text === "index" || expr.name.text === "input") && !expr.questionDotToken) {
    const represented = tryLowerExpression(lowerer, expr.expression);
    if (
      represented &&
      isMatchSliceType(lowerer, represented.type) &&
      (lowerer.isStdlibMember(expr) || isJsSourceFile(ts.getSourceFileOfNode(expr)))
    ) {
      const recv = represented;
      const key: IrExpr = { kind: "strLit", value: expr.name.text, type: STRING, loc };
      // A plain slice answers from its match source without a dynamic copy.
      const read: IrExpr = typeEquals(recv.type, arrayOf(STRING))
        ? { kind: "libCall", fn: "regex.resultProp", args: [recv, key], type: DYN, loc }
        : { kind: "dynKeyGet", value: lowerer.coerceToExpected(recv, DYN), key, type: DYN, loc };
      return lowerer.maybeNarrow(read, expr);
    }
  }
  // `m.groups` on a match result whose regex is statically known:
  // the compile-time record projection over the honest slice (or
  // Node's undefined when the pattern has no named groups) — see
  // lowerMatchGroupsRead.
  {
    const g = lowerMatchGroupsRead(lowerer, expr);
    if (g !== null) return g;
  }
  // `arguments.length` in a TYPED function whose signature is
  // FIXED-ARITY (no optional/default/rest parameters): tsc enforces
  // exact arity at every call site and call/apply/bind indirection is
  // fenced, so the actual count IS the declared count — a compile-time
  // constant. Arrows don't bind `arguments` (the walk skips them,
  // exactly JS's scoping); variable-arity signatures keep the fence
  // (the count would need a hidden argc). The JS-source variadic
  // `arguments` object (dynRest) was claimed at identifier lowering.
  if (
    expr.name.text === "length" &&
    !expr.questionDotToken &&
    ts.isIdentifier(expr.expression) &&
    expr.expression.text === "arguments" &&
    !lowerer.ctx.argumentsLocal &&
    ts.symbolNameOf(lowerer.typeOf(expr.expression).getSymbol()) === "IArguments" &&
    lowerer.isStdlibSymbol(lowerer.typeOf(expr.expression).getSymbol())
  ) {
    let fn: ts.Node | undefined = expr.parent;
    while (
      fn !== undefined &&
      !ts.isFunctionDeclaration(fn) &&
      !ts.isFunctionExpression(fn) &&
      !ts.isMethodDeclaration(fn) &&
      !ts.isConstructorDeclaration(fn) &&
      !ts.isGetAccessorDeclaration(fn) &&
      !ts.isSetAccessorDeclaration(fn)
    ) {
      fn = ts.isSourceFile(fn) ? undefined : fn.parent;
    }
    if (fn !== undefined) {
      const fixedArity = (fn as ts.FunctionLikeDeclaration).parameters.nodes.every(
        (p) =>
          p.questionToken === undefined &&
          p.initializer === undefined &&
          p.dotDotDotToken === undefined,
      );
      if (fixedArity) {
        // A `this` parameter is type-only: callers never pass it.
        const declared = (fn as ts.FunctionLikeDeclaration).parameters.nodes.filter(
          (p) => !isThisParameter(p),
        ).length;
        const count = Math.max(declared, contextualArgumentCount(lowerer, fn) ?? 0);
        // Calls through the expression's own name pass the declared count,
        // calls through the wider slot pass more: no constant answers both.
        if (count > declared && referencesOwnName(lowerer, fn)) {
          lowerer.unsupported(
            "SC1090",
            expr,
            "'arguments.length' in a function expression that is called both through its own name and through a function type with more parameters (the count varies per call)",
          );
        }
        return { kind: "numLit", value: count, type: F64, loc };
      }
      lowerer.unsupported(
        "SC1090",
        expr,
        "'arguments.length' in functions with optional, default, or rest parameters (the count varies per call — a fixed-arity signature folds to a constant)",
      );
    }
  }
  // CommonJS namespace binding (`const lib = require("./lib.js")`):
  // `lib.member` IS the member — the export table is alias plumbing,
  // so the NAME resolves exactly like a bare identifier reference
  // (resolveValueSymbol lands on the exporter's declaration and every
  // existing path — globals, function values, classes — applies).
  if (!expr.questionDotToken && lowerer.cjsLocalModuleBindingOf(expr.expression)) {
    // A binding whose dep is a class-expression WHOLE export
    // (`module.exports = class {…}`): the member surface is the
    // CLASS's — `C.name` folds to NamedEvaluation's answer and own
    // statics read their globals (lowerStaticFieldRead resolves the
    // binding through the expression's own symbol). The plain
    // member-name delegation below would resolve `name` against the
    // stdlib var instead — a wrong VALUE, not a fence. Unknown
    // members fall through to the delegation (expando statics ride
    // their pre-registered export globals).
    const viaClass = lowerStaticFieldRead(lowerer, expr);
    if (viaClass) return viaClass;
    return lowerExpr(lowerer, expr.name);
  }
  // `module.exports` READ in a CommonJS file whose whole export IS a
  // class expression (`module.exports = class …{}`): the read answers
  // the class VALUE — `new module.exports()` inside the module is the
  // requirer's `new C()` spelled locally. Top-level reads ABOVE the
  // assignment fall through to their existing fences (Node still
  // answers the original export object there); function bodies
  // resolve unconditionally — they run after the module evaluated,
  // the same approximation identifier exports already make. Every
  // other module.exports read keeps its existing story.
  if (
    !expr.questionDotToken &&
    isModuleExportsAccess(expr) &&
    isCjsJsFile(ts.getSourceFileOfNode(expr), lowerer.program)
  ) {
    const whole = cjsClassExprWholeExportOf(ts.getSourceFileOfNode(expr));
    if (whole) {
      let inBody = false;
      for (
        let p: ts.Node | undefined = expr.parent;
        p !== undefined && !ts.isSourceFile(p);
        p = p.parent
      ) {
        if (ts.isFunctionLike(p) || ts.isClassDeclaration(p) || ts.isClassExpression(p)) {
          inBody = true;
          break;
        }
      }
      if (inBody || ts.tokenStartOfNode(expr) > whole.stmt.end) {
        return lowerer.classValueRef(lowerer.lowerClassExpressionInfo(whole.classExpr), expr);
      }
    }
  }
  // `module.exports.Sub` / `exports.Sub` READ in the same module: an
  // EXPRESSION-valued member rides its pre-registered export global —
  // exactly what requirers see through `require('./x').Sub`, and the
  // global IS the storage every `exports.Sub =` statement assigns, so
  // the read is Node's live member. Identifier-valued members have no
  // global (pure alias plumbing) and fall through unchanged; write
  // positions belong to the export-assignment machinery.
  {
    const writePos =
      ts.isBinaryExpression(expr.parent) &&
      expr.parent.left === expr &&
      expr.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken;
    const g = cjsInFileExportGlobalOf(lowerer, expr);
    if (g && !writePos) return { kind: "varRef", localId: g.id, type: g.type, loc };
  }
  // Namespace-qualified reads (`N.x`, `A.B.C.f`, import= alias
  // chains): the member is a compile-time-known declaration of a
  // lowered namespace block — it resolves exactly like a bare
  // identifier reference (globals, function values, classes), guarded
  // by the namespace source-order fences (lower-namespaces.ts).
  if (!expr.questionDotToken) {
    const nsMember = nsMemberIdentOf(lowerer, expr);
    if (nsMember) {
      const memberSym = lowerer.checker.getSymbolAtLocation(nsMember);
      if (memberSym) fenceEarlyNsMemberRef(lowerer, expr, memberSym);
      return lowerExpr(lowerer, nsMember);
    }
    // Expando function members (`foo.bar` after `foo.bar = 12`): the
    // member's module global (lower-expando.ts), before the ambient-
    // namespace fence — a declare-namespace merge over a real function
    // (`declare namespace Foo { var baz: number }` + `function Foo`)
    // reads its assigned members, not the ambient ReferenceError.
    {
      const ex = expandoMemberRead(lowerer, expr);
      if (ex) return lowerer.maybeNarrow(ex, expr);
    }
    // An AMBIENT namespace receiver (`M.x` where only `declare
    // namespace M` exists): the namespace object never exists at
    // runtime — Node's exact catchable ReferenceError at the access,
    // the ambient `declare const` stance.
    const ambientRoot = ambientNsRootOf(lowerer, expr.expression);
    if (ambientRoot !== null) {
      const t = ambientUndefReadType(lowerer, expr);
      if (t) return nsUndefRead(lowerer, ambientRoot.text, expr, t);
    }
  }
  // `exports.<name>` READS in a module whose export object was
  // REPLACED (`module.exports = ...`): `exports` still references the
  // ORIGINAL object — Node's aliasing rule — so when nothing ever
  // attached this name to it (`exports.<name> =` nowhere in the
  // file), the honest answer is undefined. tsc types the read off the
  // REPLACEMENT (its CJS model is identity-blind), which is exactly
  // the undiagnosed divergence this lowering closes. Reads in modules with
  // real `exports.<name> =` attachments keep their fences.
  {
    const ex = lowerReplacedExportsRead(lowerer, expr);
    if (ex) return ex;
  }
  // `this.<name>` inside a CJS export-table getter: Node binds the
  // receiver to module.exports — the read is the sibling getter's
  // lifted call.
  {
    const tm = lowerCjsExportTableThisMember(lowerer, expr);
    if (tm) return tm;
  }
  // Property signatures of class-backed protocols read implementing
  // classes' fields directly.
  if (!hasOptionalChainGuard(expr.expression)) {
    const typed = lowerProtocolPropertyRead(lowerer, expr);
    if (typed) return typed;
  }
  {
    const promiseMember = lowerPromiseConstructorRead(lowerer, expr);
    if (promiseMember) return promiseMember;
  }
  const handled =
    lowerer.lowerProcessEnvGet(expr) ??
    lowerer.lowerServerProperty(expr) ??
    // diagnostics_channel Channel receivers — name/hasSubscribers
    // over the f64 channel handle.
    lowerer.lowerDiagnosticsChannelProperty(expr) ??
    // AsyncLocalStorage receivers — the name option.
    lowerAsyncLocalStorageProperty(lowerer, expr) ??
    // readline Interface receivers — the history and option members
    // over the f64 interface handle.
    lowerReadlineProperty(lowerer, expr) ??
    // TracingChannel receivers — the five event channels and
    // hasSubscribers over the f64 tracing handle.
    lowerer.lowerTracingChannelProperty(expr) ??
    lowerer.lowerTestCtxProperty(expr) ??
    lowerer.lowerProcessProperty(expr) ??
    lowerer.lowerProcessStreamProperty(expr) ??
    lowerer.lowerFsConstantsProperty(expr) ??
    // http2.constants.NGHTTP2_CANCEL (any constants-object spelling):
    // the baked-literal table.
    lowerer.lowerBuiltinConstantsProperty(expr) ??
    // Builtin namespace imports (`path.sep`, `os.EOL`,
    // `fs.constants.R_OK` where the root is `import * as ...`): the
    // same constants and per-member fences as named builtin imports.
    lowerer.lowerNamespaceBuiltinProperty(expr) ??
    lowerer.lowerJsonProperty(expr) ??
    lowerer.lowerErrorCodeProperty(expr) ??
    lowerer.lowerNumberStaticProperty(expr) ??
    lowerEventStaticProperty(lowerer, expr) ??
    lowerer.lowerMathProperty(expr) ??
    lowerer.lowerIntrinsicProperty(expr) ??
    // The _readableState/_writableState scalar READS (the suite's
    // asserts) — checked before the generic stream property surface:
    // the inner access maps no type of its own.
    lowerStreamStateProperty(lowerer, expr) ??
    lowerStreamObjectProperty(lowerer, expr) ??
    lowerEventObjectProperty(lowerer, expr) ??
    lowerer.lowerUnionProperty(expr) ??
    // A builtin constructor reached through another binding (`const D =
    // Date; D.prototype`) holds its interned function value, which
    // models only name, length and constructor: a static member or the
    // prototype that no lowering above claimed keeps the SC2020 fence
    // rather than reading undefined through the field and dynamic reads.
    fenceBuiltinConstructorStaticRead(lowerer, expr) ??
    lowerer.lowerFieldRead(expr);
  // A union-typed field read narrows like an identifier when the
  // checker has narrowed this use to one arm.
  if (handled) {
    if (
      handled.type.kind === "union" &&
      lowerer.armTag(handled.type.unionId, UNDEFINED_T) >= 0 &&
      handled.kind === "recordGet" &&
      lowerer.isRuntimeOptionalField(handled.shapeId, handled.field)
    )
      return handled;
    // A class field assigned a missing read: the checker narrows this
    // read to the assigned value's bare type, but the stored undefined
    // arm is real (`obj.n = bytes[i]; obj.n` is undefined in Node).
    if (runtimeOptionalClassField(lowerer, handled, expr)) return handled;
    return iteratorResultValueRead(lowerer, handled, expr) ?? lowerer.maybeNarrow(handled, expr);
  }
  // `globalThis.crypto` is the WebCrypto object the bare `crypto` answers.
  if (
    !expr.questionDotToken &&
    stdlibGlobalNameOf(lowerer, expr.expression) === "globalThis" &&
    stdlibGlobalNameOf(lowerer, expr) === "crypto"
  ) {
    return { kind: "libCall", fn: "webcrypto.object", args: [], type: DYN, loc };
  }
  // `globalThis.<name>` that no lowering above claimed
  // (globalThis.SubtleCrypto, globalThis.localStorage
  // — the harness's capability-conditional knownGlobals adds): the
  // PROPERTY spelling of the identifier chokepoint's JS rule — a stdlib
  // global taken as a VALUE in a JavaScript source is the same opaque
  // IDENTITY TOKEN the bare spelling answers (`globalThis.crypto` IS
  // `crypto` — one global, one token, or identity flows through Sets
  // and === would disagree between the two spellings). TypeScript
  // sources keep the SC2020 member fence below, like the bare form.
  if (
    !expr.questionDotToken &&
    stdlibGlobalNameOf(lowerer, expr.expression) === "globalThis" &&
    isJsSourceFile(ts.getSourceFileOfNode(expr))
  ) {
    const canonical = stdlibGlobalNameOf(lowerer, expr);
    if (canonical !== null) {
      if (canonical === "globalThis") return lowerGlobalValue(lowerer, expr);
      // Typed for the programs that name it, absent in Node 24.
      if (canonical === TEMPORAL_GLOBAL) return dynUndefinedExpr(loc);
      if (canonical === "ArrayBuffer")
        return { kind: "libCall", fn: "arrayBuffer.constructor", args: [], type: DYN, loc };
      if (canonical === "fetch")
        return { kind: "libCall", fn: "fetch.function", args: [], type: DYN, loc };
      if (Object.values(BYTES_ELEMENT_NAME).includes(canonical))
        return {
          kind: "libCall",
          fn: "bytes.constructor",
          args: [{ kind: "strLit", value: canonical, type: STRING, loc }],
          type: DYN,
          loc,
        };
      return (
        builtinGlobalValueAt(lowerer, expr, canonical, loc, true) ?? {
          kind: "strLit",
          value: `[builtin ${canonical}]`,
          type: STRING,
          loc,
        }
      );
    }
  }
  // A JS receiver whose CHECKER type has no mapping (`mustCallChecks
  // .length` where the binding is an evolving any[] living as a
  // checked-dynamic global): the stdlib member fence below would blame
  // the unmappable checker type (`any[].length`), but the VALUE is a
  // dyn node — lower the receiver first and read through the dyn keyed
  // read (ARR answers length; everything else JS's own-property
  // answer). Mapped receivers keep the fence-first order: their
  // members' gaps are real surface gaps ([1,2].entries), not
  // representation artifacts. `.length` on a receiver whose checker
  // ARRAY type lowers to the checked-dynamic representation —
  // `unknown[]`, the collapsed `(string | object)[]`, and the `any[]`
  // an Array.isArray guard narrows a collapsed union to — is the checked-dynamic tree
  // array's OWN length (a keyed read the ARR kind answers exactly),
  // never an `Array.prototype` surface gap; both source languages.
  // Prototype-method VALUE reads (`ps.map` unparenthesized) keep the
  // fence-first order: a stored-member undefined would mis-answer
  // them, and calls dispatch through the dyn method machinery
  // instead.
  if (
    (isJsSourceFile(ts.getSourceFileOfNode(expr)) &&
      (lowerer.mapTypeOf(lowerer.typeOf(expr.expression)) === null ||
        (lowerer.typeOf(expr.expression).flags & ts.TypeFlags.Never) !== 0 ||
        // A never-tainted receiver type maps (never rides as f64) but
        // its VALUE lowered checked-dynamic — same dyn read.
        neverTaintedJsType(lowerer, expr.expression, lowerer.typeOf(expr.expression)))) ||
    (expr.name.text === "length" &&
      (lowerer.checkerAnyArray(expr.expression) ||
        (lowerer.checker.isArrayType(lowerer.typeOf(expr.expression)) &&
          lowerer.mapTypeOf(lowerer.typeOf(expr.expression))?.kind === "dyn")))
  ) {
    const recv = lowerer.lowerExpr(expr.expression);
    if (recv.type.kind === "dyn") {
      const key: IrExpr = {
        kind: "strLit",
        value: expr.name.text,
        type: STRING,
        loc: locOf(expr.name),
      };
      const opt = hasOptionalChainGuard(expr.expression, lowerer);
      return lowerer.maybeNarrow(
        {
          kind: "dynKeyGet",
          key,
          ...(opt ? { optional: true as const } : {}),
          value: recv,
          type: DYN,
          loc,
        },
        expr,
      );
    }
    if (
      expr.name.text === "length" &&
      (recv.type.kind === "array" || recv.type.kind === "string")
    ) {
      return recv.type.kind === "array"
        ? { kind: "arrIntrinsic", method: "length", receiver: recv, args: [], type: F64, loc }
        : { kind: "strIntrinsic", method: "length", receiver: recv, args: [], type: F64, loc };
    }
  }
  if (isJsSourceFile(ts.getSourceFileOfNode(expr)) && expr.name.text === "constructor") {
    const receiver = tryLowerExpression(lowerer, expr.expression);
    if (
      receiver?.type.kind === "dyn" ||
      (receiver?.type.kind === "object" &&
        !lowerer.classes.get(receiver.type.className)?.fields.has("constructor"))
    ) {
      return {
        kind: "dynKeyGet",
        value: lowerer.coerceToExpected(receiver, DYN),
        key: { kind: "strLit", value: "constructor", type: STRING, loc },
        type: DYN,
        loc,
      };
    }
  }
  // A plain record's inherited Object.prototype members READ as values
  // (`o.constructor`, `o.valueOf`, `({}).toString`, the isPlainObject and
  // deep-equal idioms): the record boxes into its dynamic view, whose
  // read answers the interned Object constructor and Object.prototype
  // methods — the same values `Object` and `Object.prototype.valueOf`
  // read, so identity comparisons are exact. Calls keep their own
  // lowerings; a record declaring the name reads its field.
  if (
    OBJECT_PROTOTYPE_VALUE_READS.has(expr.name.text) &&
    !isCalleeOf(expr) &&
    // `X.prototype.toString` keeps the builtin prototype-method lowering.
    !(ts.isPropertyAccessExpression(expr.expression) && expr.expression.name.text === "prototype")
  ) {
    const receiver = tryLowerExpression(lowerer, expr.expression);
    const name = expr.name.text;
    const shape =
      receiver?.type.kind === "record" ? lowerer.shapes.get(receiver.type.shapeId) : undefined;
    const info =
      receiver?.type.kind === "object" ? lowerer.classes.get(receiver.type.className) : undefined;
    const inherits =
      receiver?.type.kind === "dyn" ||
      (shape !== undefined && !shape.tuple && !shape.fields.some((field) => field.name === name)) ||
      (info !== undefined &&
        name !== "constructor" &&
        !info.fields.has(name) &&
        !lowerer.findMethodOn(info, name) &&
        !lowerer.findMethodOn(info, `get:${name}`));
    if (receiver !== null && receiver !== undefined && inherits) {
      return {
        kind: "dynKeyGet",
        value: lowerer.coerceToExpected(receiver, DYN),
        key: { kind: "strLit", value: name, type: STRING, loc },
        type: DYN,
        loc,
      };
    }
  }
  // `f.name` / `f.length` / own properties on a FUNCTION-typed JS
  // value (the mustCall wrapper's function-instance members): read
  // through the dyn box — the closure's own-property table answers
  // first (defineProperties writes land there), then the box's
  // best-effort static name and the declared arity; anything else is
  // the own-property answer, undefined. Function.prototype METHOD
  // names stay fenced (a stored-member undefined would mis-answer
  // `f.call` as a value). Static callable values keep the existing TS fence; checked callable
  // storage can expose its own name and length in both source languages.
  if (
    !["apply", "bind", "call", "toString", "caller", "arguments"].includes(expr.name.text) &&
    (isJsSourceFile(ts.getSourceFileOfNode(expr)) ||
      expr.name.text === "name" ||
      expr.name.text === "length" ||
      expr.name.text === "constructor")
  ) {
    const probed = tryLowerExpression(lowerer, expr.expression);
    // Inferred callable returns can use checked storage even when the
    // checker still describes a function. Read its actual dyn value;
    // the ambient Function member must not hide its own properties.
    const receiverType = lowerer.typeOf(expr.expression);
    const receiverSymbol = receiverType.getSymbol();
    const checkedFunction =
      lowerer.checker.getCallSignatures(receiverType).length > 0 ||
      (receiverSymbol !== undefined &&
        ts.symbolName(receiverSymbol) === "Function" &&
        lowerer.isStdlibSymbol(receiverSymbol));
    if (probed?.type.kind === "dyn" && checkedFunction) {
      const key: IrExpr = {
        kind: "strLit",
        value: expr.name.text,
        type: STRING,
        loc: locOf(expr.name),
      };
      const opt = hasOptionalChainGuard(expr.expression, lowerer);
      return lowerer.maybeNarrow(
        {
          kind: "dynKeyGet",
          key,
          value: probed,
          ...(opt ? { optional: true as const } : {}),
          type: DYN,
          loc,
        },
        expr,
      );
    }
    if (
      (isJsSourceFile(ts.getSourceFileOfNode(expr)) || expr.name.text === "constructor") &&
      probed?.type.kind === "func" &&
      canBoxFuncIntoDyn(
        probed.type,
        (id) => lowerer.shapes.get(id),
        (id) => lowerer.unions.get(id),
      )
    ) {
      const fnName = jsFuncNameOf(expr.expression);
      const boxed: IrExpr = {
        kind: "dynFrom",
        value: probed,
        type: DYN,
        ...(fnName !== null ? { fnName } : {}),
        loc,
      };
      const key: IrExpr = {
        kind: "strLit",
        value: expr.name.text,
        type: STRING,
        loc: locOf(expr.name),
      };
      return lowerer.maybeNarrow({ kind: "dynKeyGet", key, value: boxed, type: DYN, loc }, expr);
    }
  }
  // A NARROWED IteratorResult receiver (`if (!r.done) r.value` — the
  // checker narrows to IteratorYieldResult/IteratorReturnResult, whose
  // own type cannot map: the shared record shape needs BOTH channels):
  // the receiver's LOWERED record still carries the field, so the read
  // is an ordinary recordGet — maybeNarrow then bridges the union slot
  // to the checker's narrowed arm, exactly like a union field read.
  if (expr.name.text === "done" || expr.name.text === "value") {
    const receiverType = lowerer.typeOf(expr.expression);
    const recvSym =
      ts.symbolNameOf(receiverType.getAliasSymbol()) === "IteratorResult"
        ? receiverType.getAliasSymbol()
        : receiverType.getSymbol();
    if (
      ((recvSym !== undefined && ts.symbolName(recvSym) === "IteratorResult") ||
        (recvSym !== undefined && ts.symbolName(recvSym) === "IteratorYieldResult") ||
        (recvSym !== undefined && ts.symbolName(recvSym) === "IteratorReturnResult")) &&
      recvSym.declarations.some(
        (d) =>
          (ts.isInterfaceDeclaration(d) || ts.isTypeAliasDeclaration(d)) &&
          lowerer.isStdlibFile(ts.getSourceFileOfNode(d)),
      )
    ) {
      const recv = lowerer.lowerExpr(expr.expression);
      if (recv.type.kind === "dyn")
        return lowerer.maybeNarrow(
          {
            kind: "dynKeyGet",
            value: recv,
            key: { kind: "strLit", value: expr.name.text, type: STRING, loc },
            type: DYN,
            loc,
          },
          expr,
        );
      if (recv.type.kind === "record") {
        const shape = lowerer.shapes.get(recv.type.shapeId);
        const field = shape?.fields.find((f) => f.name === expr.name.text);
        if (field) {
          const read: IrExpr = {
            kind: "recordGet",
            obj: recv,
            shapeId: recv.type.shapeId,
            field: field.name,
            type: field.type,
            loc,
          };
          return iteratorResultValueRead(lowerer, read, expr) ?? lowerer.maybeNarrow(read, expr);
        }
      }
    }
  }
  // A chain rooted at an initializer-less ambient `declare const/var`
  // whose declared type has NO mapping (mappable roots compose through
  // the bare-read undefRead and never reach here): Node throws the
  // catchable ReferenceError at the ROOT read before any member
  // matters, so the whole access lowers to that throw — typed by the
  // use site, or by the context it flows into (the throw never
  // returns, so the dummy is never observed).
  {
    const ambientRoot = ambientUndefVarRootOf(lowerer, expr);
    if (ambientRoot !== null) {
      const t = ambientUndefReadType(lowerer, expr) ?? contextualUndefReadType(lowerer, expr);
      if (t) return nsUndefRead(lowerer, ambientRoot.text, expr, t);
    }
  }
  // Checked-dynamic stdlib results retain ambient property symbols,
  // including parseArgs tokens narrowed to anonymous union arms. Only
  // members owned by these implemented families bypass the stdlib fence.
  const segmentDataSymbol = lowerer.typeOf(expr.expression).getSymbol();
  const segmentDataProperty =
    segmentDataSymbol !== undefined &&
    ts.symbolName(segmentDataSymbol) === "SegmentData" &&
    lowerer.isStdlibSymbol(segmentDataSymbol) &&
    ["segment", "index", "input", "isWordLike"].includes(expr.name.text);
  // os.constants members vary by platform (the declared groups list
  // every platform's names): a number member reads as `number |
  // undefined`, like an array element, and a group stays checked.
  const osConstants = isOsConstantsType(lowerer.typeOf(expr.expression), lowerer);
  if (
    isParseArgsDynProperty(lowerer, expr) ||
    isStatFsDynProperty(lowerer, expr) ||
    segmentDataProperty ||
    osConstants ||
    isLegacyUrlSymbol(lowerer.checker.getSymbolAtLocation(expr.name), lowerer)
  ) {
    const recv = lowerer.lowerExpr(expr.expression);
    if (recv.type.kind === "dyn") {
      const key: IrExpr = {
        kind: "strLit",
        value: expr.name.text,
        type: STRING,
        loc: locOf(expr.name),
      };
      const opt = hasOptionalChainGuard(expr.expression, lowerer);
      const read: IrExpr = {
        kind: "dynKeyGet",
        key,
        ...(opt ? { optional: true as const } : {}),
        value: recv,
        type: DYN,
        loc,
      };
      if (osConstants) {
        return lowerer.mapTypeOf(lowerer.typeOf(expr))?.kind === "f64"
          ? lowerer.coerceToExpected(read, lowerer.withUndefinedArm(F64))
          : read;
      }
      return lowerer.maybeNarrow(read, expr);
    }
  }
  // A member read through a NULLISH generic binding (`const i: I<A &
  // B> = null as any; const _i: I<A> = i.something` — the receiver
  // provably holds null/undefined forever): the read throws Node's
  // exact TypeError at the access.
  if (ts.isIdentifier(expr.expression) && expr.questionDotToken === undefined) {
    const unit = nullishGenericBindingUnitOf(lowerer, lowerer.resolveValueSymbol(expr.expression));
    if (unit !== null) {
      const t =
        ambientUndefReadType(lowerer, expr) ?? contextualUndefReadType(lowerer, expr) ?? F64;
      return nodeThrowExpr(
        1,
        "",
        `Cannot read properties of ${unit} (reading '${expr.name.text}')`,
        t,
        loc,
      );
    }
  }
  // A stdlib-declared member (`message` of an interface extending Error)
  // on a catch binding narrowed to a structural type: the binding reads
  // as its checked-dynamic value, so the member does too.
  if (!expr.questionDotToken && lowerer.caughtLocalOf(expr.expression)) {
    const recv = lowerer.lowerExpr(expr.expression);
    if (recv.kind === "caughtToDyn") {
      const read: IrExpr = {
        kind: "dynKeyGet",
        key: { kind: "strLit", value: expr.name.text, type: STRING, loc: locOf(expr.name) },
        value: recv,
        type: DYN,
        loc,
      };
      const declared = lowerer.mapTypeOf(lowerer.typeOf(expr));
      return declared && declared.kind !== "void" ? lowerer.coerceToExpected(read, declared) : read;
    }
  }
  // The lib fence's PROPERTY chokepoint: a stdlib-declared member that
  // no lowering above claimed ([1,2].entries, Math.SQRT2, Promise.all,
  // re.exec as a value, ...) reports SC2020 here.
  lowerer.stdlibMemberFence(expr);
  // The npm chokepoint: a member on a package-typed receiver in a
  // static build — attributed to the package, like every other site.
  lowerer.npmMemberFence(expr);
  // A property read rooted at a BLOCKED binding: the declaration
  // carries the real diagnostic — the SC2004 cascade, not a generic
  // "property access" rejection.
  {
    let root: ts.Expression = expr.expression;
    while (ts.isPropertyAccessExpression(root)) root = root.expression;
    if (ts.isIdentifier(root) && lowerer.isBlockedBinding(lowerer.resolveValueSymbol(root))) {
      lowerer.pushDiag(blockedBindingUseDiag(root.text, loc));
      throw new PoisonError();
    }
  }
  // Nothing claimed the member. Lower the RECEIVER before rejecting:
  // when the receiver itself is the blocker (`(await import(x)).y` —
  // the dynamic import is the unsupported part), ITS diagnostic is the
  // honest one, not a generic recitation about the outer dot. A
  // receiver that lowers cleanly means the MEMBER is the gap — name
  // the property and the receiver's type instead of "property access".
  let recvLowered = lowerer.lowerExpr(expr.expression);
  // A receiver whose value union holds record types the checker's subtype
  // reduction folded into its type (`{ status } | { status, value }` typed
  // `{ status }`, a call of a function with an inferred return type): read
  // through the checker's type, converting the wider arms.
  if (recvLowered.type.kind === "union") {
    const declared = lowerer.mapTypeOf(lowerer.typeOf(expr.expression));
    if (
      declared !== null &&
      declared.kind === "record" &&
      widensReducedRecords(lowerer, declared, recvLowered.type)
    ) {
      const helper = widthNarrowHelper(lowerer, recvLowered.type.unionId, declared, loc);
      if (helper !== null)
        recvLowered = lowerer.checkedNarrowCall(helper, recvLowered, declared, loc);
    }
  }
  // A dyn receiver — JSON.parse's `any`, or `unknown` the checker
  // narrowed to `object` — reads through the dyn keyed read: member
  // or undefined (JS's own-property answer), throwing JS's TypeError
  // on undefined/null receivers unless an earlier `?.` guards the
  // chain. Scalar-narrowed occurrences bridge via maybeNarrow's
  // validated dynCheck as usual.
  if (
    recvLowered.type.kind === "dyn" ||
    (isJsSourceFile(ts.getSourceFileOfNode(expr)) &&
      (["f64", "bool", "bigint", "string", "symbol"].includes(recvLowered.type.kind) ||
        (recvLowered.type.kind === "union" && lowerer.dynConvertible(recvLowered.type))))
  ) {
    const key: IrExpr = {
      kind: "strLit",
      value: expr.name.text,
      type: STRING,
      loc: locOf(expr.name),
    };
    const opt = hasOptionalChainGuard(expr.expression, lowerer);
    return lowerer.maybeNarrow(
      {
        kind: "dynKeyGet",
        key,
        ...(opt ? { optional: true as const } : {}),
        value: lowerer.coerceToExpected(recvLowered, DYN),
        type: DYN,
        loc,
      },
      expr,
    );
  }
  // The lowered receiver is a RECORD the checker spelled wider —
  // `s.match(re).groups.key` in a JS file: the checker says
  // `{ [key: string]: string } | undefined`, but the groups
  // projection already answered the record arm (its null trap
  // included). Declared fields read directly; an index-signature
  // shape serves undeclared keys through the overflow read, exactly
  // the dot-access rule on checker-spelled hybrids.
  if (recvLowered.type.kind === "record") {
    const recvShape = lowerer.shapes.get(recvLowered.type.shapeId);
    const field = recvShape?.fields.find((f) => f.name === expr.name.text);
    if (field) {
      return lowerer.maybeNarrow(
        {
          kind: "recordGet",
          obj: recvLowered,
          shapeId: recvLowered.type.shapeId,
          field: field.name,
          type: field.type,
          loc,
        },
        expr,
      );
    }
    if (recvShape?.indexValue !== undefined && !recvShape.tuple) {
      return lowerer.maybeNarrow(
        {
          kind: "recordKeyGet",
          obj: recvLowered,
          shapeId: recvLowered.type.shapeId,
          key: { kind: "strLit", value: expr.name.text, type: STRING, loc: locOf(expr.name) },
          overflowOnly: true,
          type: recvShape.indexValue,
          loc,
        },
        expr,
      );
    }
    // An inferred package-JS call specializes a parameter to the
    // caller's own record shape. Optional option names omitted by that
    // caller read undefined; the missing field is not a failed type
    // assertion. Known prototype members were handled/fenced above.
    if (
      recvShape &&
      !recvShape.tuple &&
      lowerer.implicitParamTypes !== null &&
      isJsSourceFile(ts.getSourceFileOfNode(expr)) &&
      npmStaticPackageOfPath(ts.getSourceFileOfNode(expr).fileName) !== null
    ) {
      return {
        kind: "seqExpr",
        stmts: [{ kind: "exprStmt", expr: recvLowered, loc }],
        result: dynUndefinedExpr(loc),
        type: DYN,
        loc,
      };
    }
  }
  // An ABSTRACT property through an abstract-typed receiver: the
  // declaration is erased at runtime — Node defines no field for it,
  // each concrete subclass declares its OWN (at its own layout
  // position), so no shared base slot exists to read. Abstract
  // ACCESSORS are the supported spelling: they declare a vtable slot.
  if (recvLowered.type.kind === "object" && abstractPropertyDeclOf(lowerer, expr)) {
    lowerer.unsupported(
      "SC1090",
      expr,
      `reading the abstract property '${expr.name.text}' through a '${lowerer.checker.typeToString(lowerer.typeOf(expr.expression))}'-typed receiver (abstract property declarations are erased at runtime, so no shared slot exists — type the receiver as the concrete class, or declare an abstract getter instead)`,
    );
  }
  // Array reads may add an undefined arm even when the checker still
  // reports a class. Its property bag must remain reachable, while
  // an absent element takes the normal checked-value TypeError.
  const nativeReceiver = lowerer.stripUndefinedArm(recvLowered.type);
  if (ts.isPrivateIdentifier(expr.name) && recvLowered.type.kind === "object") {
    const field = lowerer.classes.get(recvLowered.type.className)?.fields.get(expr.name.text);
    if (field)
      return {
        kind: "fieldGet",
        obj: recvLowered,
        className: recvLowered.type.className,
        field: expr.name.text,
        type: field,
        loc,
      };
  }
  if (nativeReceiver.kind === "object" && nativeReceiver.className === "%Error") {
    return lowerer.maybeNarrow(
      {
        kind: "dynKeyGet",
        value: lowerer.coerceToExpected(recvLowered, DYN),
        key: { kind: "strLit", value: expr.name.text, type: STRING, loc },
        type: DYN,
        loc,
      },
      expr,
    );
  }
  if (isDynTypedRefType(nativeReceiver)) {
    const info = lowerer.classes.get(nativeReceiver.className);
    if (
      info &&
      !info.def.runtime &&
      !info.builtinError &&
      !info.builtinEmitter &&
      !info.builtinStream
    ) {
      return lowerer.maybeNarrow(
        {
          kind: "dynKeyGet",
          value: lowerer.coerceToExpected(recvLowered, DYN),
          key: { kind: "strLit", value: expr.name.text, type: STRING, loc },
          type: DYN,
          loc,
        },
        expr,
      );
    }
  }
  // A member a JavaScript module attached to one of its functions
  // (`status.message = codes; module.exports = status`), read from
  // TypeScript: JavaScript stores such members on the function's own
  // property table (`fn.member = v` writes through the function's
  // checked-dynamic face), so the read takes the same path and enters
  // the static code at the type inference gave the member.
  if (recvLowered.type.kind === "func" && jsFunctionExpandoMember(lowerer, expr)) {
    const read: IrExpr = {
      kind: "dynKeyGet",
      value: lowerer.coerceToExpected(recvLowered, DYN),
      key: { kind: "strLit", value: expr.name.text, type: STRING, loc: locOf(expr.name) },
      type: DYN,
      loc,
    };
    const mapped = lowerer.mapTypeOf(lowerer.typeOf(expr));
    return mapped && mapped.kind !== "void" ? lowerer.coerceInto(expr, read, mapped) : read;
  }
  const asserted = assertedMemberRead(lowerer, expr, recvLowered, loc);
  if (asserted) return asserted;
  // A checker-`any` receiver whose value is a FRESH typed result of an
  // earlier step in the chain (`out.split(" ").length`, where split
  // extracted the string and answered a native string[]): the member read
  // goes through the boxed checked-dynamic value, as the method-call twin
  // does. The box copies; a call result has no other holder to observe it.
  if (
    (lowerer.typeOf(expr.expression).flags & ts.TypeFlags.Any) !== 0 &&
    isFreshCallResult(expr.expression) &&
    lowerer.dynConvertible(recvLowered.type)
  ) {
    return lowerer.maybeNarrow(
      {
        kind: "dynKeyGet",
        value: lowerer.coerceToExpected(recvLowered, DYN),
        key: { kind: "strLit", value: expr.name.text, type: STRING, loc },
        type: DYN,
        loc,
      },
      expr,
    );
  }
  const childProperty = lowerChildPropertyRead(lowerer, expr);
  if (childProperty) return childProperty;
  // A member a typed array's type does not declare (a JavaScript read, or
  // one under @ts-ignore), such as the feature probe `typeof bytes.toHex`:
  // when Node's prototype chain for the value lacks the name too, the read
  // answers undefined, as GetV does there. Names Node has keep the fence.
  // The element size reads the same way where the checker's type of the
  // receiver no longer names a typed array (`a instanceof Uint8Array ||
  // a.BYTES_PER_ELEMENT === 1`, whose right side narrows `a` to never).
  if (recvLowered.type.kind === "bytes" && expr.name.text === "BYTES_PER_ELEMENT") {
    return afterReceiver(recvLowered, numLit(BYTES_ELEMENT_SIZE[recvLowered.type.elem], loc), loc);
  }
  if (
    recvLowered.type.kind === "bytes" &&
    !declaredMemberOf(lowerer, expr.expression, expr.name.text) &&
    typedArrayLacksMember(expr.name.text, recvLowered.type.elem === "u8")
  ) {
    return afterReceiver(recvLowered, dynUndefinedExpr(loc), loc);
  }
  // A typed array under a checker `any` (a JS binding its own initializer's
  // inference refers to: hono's etag digest `nextChunk`) reads through its
  // box, as the method-call twin dispatches. The box shares the native
  // storage, so it needs no fresh-result restriction.
  if (
    recvLowered.type.kind === "bytes" &&
    (lowerer.typeOf(expr.expression).flags & ts.TypeFlags.Any) !== 0
  ) {
    return lowerer.maybeNarrow(
      {
        kind: "dynKeyGet",
        value: lowerer.coerceToExpected(recvLowered, DYN),
        key: { kind: "strLit", value: expr.name.text, type: STRING, loc },
        type: DYN,
        loc,
      },
      expr,
    );
  }
  lowerer.unsupported(
    "SC1090",
    expr,
    `reading '${expr.name.text}' from a value of type '${lowerer.checker.typeToString(lowerer.typeOf(expr.expression))}'`,
  );
}

/** `result` after evaluating `receiver` for its effects (none to keep when
 * the read is safe to discard). */
function afterReceiver(receiver: IrExpr, result: IrExpr, loc: SrcLoc): IrExpr {
  if (isSafeToDiscard(receiver)) return result;
  return {
    kind: "seqExpr",
    stmts: [{ kind: "exprStmt", expr: receiver, loc }],
    result,
    type: result.type,
    loc,
  };
}

/** A call expression, through parentheses: its value has no other holder. */
function isFreshCallResult(node: ts.Expression): boolean {
  let e = node;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  return ts.isCallExpression(e);
}

/** `(source as { repoName: string }).repoName` where the assertion names a
 * member some arms of the stored union of records do not declare: Node
 * reads the property off whichever object it is, so arms that declare it
 * answer their slot, and the others answer undefined (native records are
 * closed, so they cannot hold it). The result keeps that undefined arm
 * whatever the assertion claims; a consumer that needs the asserted type
 * checks it like any other narrowing. The arms that declare the member
 * must agree on its type. Null when the receiver is not such an
 * assertion over records, or no arm declares the member. */
function assertedMemberRead(
  lowerer: Lowerer,
  expr: ts.PropertyAccessExpression,
  recv: IrExpr,
  loc: SrcLoc,
): IrExpr | null {
  let receiverNode: ts.Expression = expr.expression;
  while (ts.isParenthesizedExpression(receiverNode)) receiverNode = receiverNode.expression;
  if (!ts.isAsExpression(receiverNode) && !ts.isTypeAssertion(receiverNode)) return null;
  if (recv.type.kind !== "union") return null;
  const unionId = recv.type.unionId;
  const arms = lowerer.unions.get(unionId)?.arms ?? [];
  const name = expr.name.text;
  let resultType: IrType | null = null;
  let records = 0;
  const declaring: { tag: number; shapeId: string; type: IrType }[] = [];
  const units: number[] = [];
  for (let tag = 0; tag < arms.length; tag++) {
    const arm = arms[tag]!;
    if (isUnitType(arm)) {
      units.push(tag);
      continue;
    }
    if (arm.kind !== "record") return null;
    records++;
    const shape = lowerer.shapes.get(arm.shapeId);
    if (!shape || shape.tuple || shape.indexValue) return null;
    const field = shape.fields.find((f) => f.name === name);
    if (!field) continue;
    // The declaring arms agree up to an undefined arm (`string` beside
    // `string | undefined`).
    const armResult = lowerer.withUndefinedArmOf(field.type);
    if (!armResult || (resultType && !typeEquals(resultType, armResult))) return null;
    resultType = armResult;
    declaring.push({ tag, shapeId: arm.shapeId, type: field.type });
  }
  if (!resultType || declaring.length === records) return null;
  const stable = lowerer.declareHiddenLocal("%assertedRecv", recv.type);
  const ref = (): IrExpr => ({ kind: "varRef", localId: stable.id, type: recv.type, loc });
  let result: IrExpr | null = lowerer.wrappedUndefined(resultType, loc);
  if (!result) return null;
  // A unit arm the checker narrowed away reads like Node would read it.
  for (const tag of units) {
    const unit = arms[tag]!.kind === "nullT" ? "null" : "undefined";
    result = {
      kind: "ternary",
      cond: { kind: "unionIsTag", unionId, tag, negated: false, value: ref(), type: BOOL, loc },
      then: nodeThrowExpr(
        1,
        "",
        `Cannot read properties of ${unit} (reading '${name}')`,
        resultType,
        loc,
      ),
      else_: result,
      type: resultType,
      loc,
    };
  }
  for (const { tag, shapeId, type: fieldType } of declaring) {
    const read: IrExpr = {
      kind: "recordGet",
      obj: { kind: "unionNarrow", unionId, tag, value: ref(), type: arms[tag]!, loc },
      shapeId,
      field: name,
      type: fieldType,
      loc,
    };
    result = {
      kind: "ternary",
      cond: { kind: "unionIsTag", unionId, tag, negated: false, value: ref(), type: BOOL, loc },
      then: lowerer.coerceToExpected(read, resultType),
      else_: result,
      type: resultType,
      loc,
    };
  }
  return {
    kind: "seqExpr",
    stmts: [{ kind: "varDecl", localId: stable.id, init: recv, loc }],
    result,
    type: resultType,
    loc,
  };
}

function importMetaProperty(lowerer: Lowerer, expr: ts.PropertyAccessExpression): IrExpr | null {
  return isImportMeta(expr.expression) ? importMetaField(lowerer, expr, expr.name.text) : null;
}

/** The TypeError of a deferred-init field read that finds the field
 * unassigned where its declared type cannot hold undefined. */
export const DEFERRED_READ_MESSAGE =
  "undefined is not representable in the target union (a value narrowed or asserted past it still held it)";

/** Property access on a string or array receiver: `.length` lowers to the
 * matching intrinsic; a bare method reference (`const f = s.slice` — a
 * function value) is rejected with a specific message. Returns null for
 * other receivers (the generic property-access rejection applies). Both
 * the receiver type AND the ambient-file provenance of the member are
 * verified — the name alone proves nothing. */
export function lowerIntrinsicProperty(
  lowerer: Lowerer,
  expr: ts.PropertyAccessExpression,
): IrExpr | null {
  for (const name of ["String", "Number", "Boolean", "BigInt"] as (
    | "String"
    | "Number"
    | "Boolean"
    | "BigInt"
  )[]) {
    if (!lowerer.chainBlocked(expr) && lowerer.isStdlibGlobal(expr, name)) {
      return primitiveCtorClosure(
        lowerer,
        name,
        locOf(expr),
        isJsSourceFile(ts.getSourceFileOfNode(expr)),
      );
    }
  }
  if (lowerer.stdlibGlobalMember(expr, "Reflect") === "ownKeys") {
    const value = lowerer.lowerNativeCallableValue(
      {
        fn: "dyn.ownKeys",
        params: [DYN],
        result: DYN,
        valueParams: [{ mode: "required", type: DYN }],
      },
      "Reflect.ownKeys",
      locOf(expr),
    )!;
    return { kind: "dynFrom", value, fnName: "ownKeys", type: DYN, loc: locOf(expr) };
  }
  if (lowerer.chainBlocked(expr)) return null;
  // Object.prototype.constructor: the Object constructor value.
  if (
    expr.name.text === "constructor" &&
    ts.isPropertyAccessExpression(expr.expression) &&
    lowerer.stdlibGlobalMember(expr.expression, "Object") === "prototype"
  )
    return builtinGlobalValue("Object", locOf(expr));
  const builtinPrototype = builtinPrototypeMethod(lowerer, expr);
  if (builtinPrototype)
    return {
      kind: "libCall",
      fn: "dyn.builtinMethod",
      args: [
        { kind: "strLit", value: builtinPrototype, type: STRING, loc: locOf(expr) },
        { kind: "strLit", value: expr.name.text, type: STRING, loc: locOf(expr.name) },
      ],
      type: DYN,
      loc: locOf(expr),
    };
  if (
    ts.isPropertyAccessExpression(expr.expression) &&
    lowerer.stdlibGlobalMember(expr.expression, "Array") === "prototype"
  ) {
    return {
      kind: "dynKeyGet",
      value: {
        kind: "libCall",
        fn: "dyn.arrayPrototype",
        args: [],
        type: DYN,
        loc: locOf(expr.expression),
      },
      key: { kind: "strLit", value: expr.name.text, type: STRING, loc: locOf(expr.name) },
      type: DYN,
      loc: locOf(expr),
    };
  }
  if (
    expr.name.text === "apply" &&
    ts.isPropertyAccessExpression(expr.expression) &&
    lowerer.stdlibGlobalMember(expr.expression, "Function") === "prototype"
  )
    return { kind: "libCall", fn: "dyn.functionApply", args: [], type: DYN, loc: locOf(expr) };
  if (lowerer.stdlibGlobalMember(expr, "Array") === "prototype")
    return { kind: "libCall", fn: "dyn.arrayPrototype", args: [], type: DYN, loc: locOf(expr) };
  if (lowerer.stdlibGlobalMember(expr, "Object") === "prototype")
    return { kind: "libCall", fn: "dyn.objectPrototype", args: [], type: DYN, loc: locOf(expr) };
  // Error.prototype as a value (`F.prototype = Object.create(Error.prototype)`)
  // and Error.captureStackTrace read as a function (`if
  // (Error.captureStackTrace) ...`).
  if (isErrorPrototypeValue(lowerer, expr))
    return { kind: "libCall", fn: "dyn.errorPrototype", args: [], type: DYN, loc: locOf(expr) };
  if (lowerer.stdlibGlobalMember(expr, "Error") === "captureStackTrace")
    return {
      kind: "libCall",
      fn: "dyn.errorCaptureStackTraceFunction",
      args: [],
      type: DYN,
      loc: locOf(expr),
    };
  // Function.prototype as a VALUE (a prototype-chain link:
  // `Object.setPrototypeOf(F.prototype, Function.prototype)`): one
  // anonymous function answering undefined, length 0 — a zero-capture
  // closure of a compiler helper, so every read is the same function
  // (closure identity) and shares its property table. Reads through it
  // find the function members the checked runtime models for every
  // function (apply, constructor, name, length). Member forms keep their
  // own lowerings.
  if (lowerer.stdlibGlobalMember(expr, "Function") === "prototype") {
    const loc = locOf(expr);
    const name = "%dyn.functionPrototype";
    if (!lowerer.liftedFns.some((fn) => fn.name === name))
      lowerer.liftedFns.push({
        name,
        params: [],
        locals: [],
        returnType: DYN,
        body: [{ kind: "return", value: dynUndefinedExpr(loc), loc }],
        loc,
      });
    return {
      kind: "dynFrom",
      value: { kind: "closure", fnName: name, captures: [], type: funcOf([], DYN), loc },
      fnName: "",
      type: DYN,
      loc,
    };
  }
  if (lowerer.stdlibGlobalMember(expr, "Array") === "isArray")
    return lowerArrayIsArrayValue(lowerer, locOf(expr));
  if (lowerer.stdlibGlobalMember(expr, "Array") === "from")
    return lowerArrayFromValue(lowerer, locOf(expr));
  const stringMember = lowerer.stdlibGlobalMember(expr, "String");
  if (stringMember === "fromCharCode" || stringMember === "fromCodePoint")
    return lowerStringCodesValue(lowerer, stringMember, locOf(expr));
  const numberMember = lowerer.stdlibGlobalMember(expr, "Number");
  if (numberMember === "parseInt" || numberMember === "parseFloat")
    return lowerNumberParserValue(lowerer, numberMember, locOf(expr));
  if (lowerer.stdlibGlobalMember(expr, "Buffer") === "poolSize")
    return { kind: "libCall", fn: "buffer.poolSize", args: [], type: F64, loc: locOf(expr) };
  {
    const member = lowerer.stdlibGlobalMember(expr, "Buffer");
    if (member === "name")
      return { kind: "strLit", value: "Buffer", type: STRING, loc: locOf(expr) };
    if (member === "length") return numLit(3, locOf(expr));
    // JavaScript reads the statics from the Buffer function's value, so
    // each has one identity and Node's name and length.
    if (
      member !== null &&
      BUFFER_VALUE_STATICS.has(member) &&
      isJsSourceFile(ts.getSourceFileOfNode(expr))
    ) {
      const loc = locOf(expr);
      return {
        kind: "libCall",
        fn: "buffer.staticValue",
        args: [{ kind: "strLit", value: member, type: STRING, loc }],
        type: DYN,
        loc,
      };
    }
  }
  const netAddressStatic = lowerNetAddressStaticRead(lowerer, expr);
  if (netAddressStatic) return netAddressStatic;
  if (lowerer.stdlibGlobalMember(expr, "Buffer") === "isBuffer")
    return lowerCheckedPredicateValue(lowerer, "Buffer.isBuffer", "buffer", locOf(expr));
  // Buffer statics as function values (`Buffer.byteLength.bind(Buffer)` in
  // truncate-utf8-bytes): the checked forms take any argument as Node does.
  if (lowerer.stdlibGlobalMember(expr, "Buffer") === "byteLength")
    return lowerer.lowerNativeCallableValue(
      {
        fn: "buffer.byteLenValue",
        params: [DYN, DYN],
        result: F64,
        valueParams: [
          { mode: "required", type: DYN },
          { mode: "optional", type: DYN, defaultValue: undefined },
        ],
      },
      "Buffer.byteLength",
      locOf(expr),
    );
  if (lowerer.stdlibGlobalMember(expr, "Buffer") === "alloc")
    return bufferAllocValue(lowerer, locOf(expr));
  if (lowerer.stdlibGlobalMember(expr, "Buffer") === "compare")
    return lowerer.lowerNativeCallableValue(
      {
        fn: "buffer.compareChk",
        params: [DYN, DYN],
        result: F64,
        valueParams: [
          { mode: "required", type: DYN },
          { mode: "required", type: DYN },
        ],
      },
      "Buffer.compare",
      locOf(expr),
    );
  if (lowerer.stdlibGlobalMember(expr, "Date") === "now")
    return lowerer.lowerNativeCallableValue(
      {
        fn: "date.now",
        params: [],
        result: F64,
        valueParams: [],
      },
      "Date.now",
      locOf(expr),
    );
  if (stdlibGlobalNameOf(lowerer, expr.expression) === "Object") {
    if (expr.name.text === "assign") return lowerObjectAssignValue(lowerer, locOf(expr));
    const fn = own(OBJECT_CALLABLE_VALUES, expr.name.text);
    if (fn) return lowerer.lowerNativeCallableValue(fn, `Object.${expr.name.text}`, locOf(expr));
  }
  // A never-tainted JS receiver type lowered checked-dynamic
  // (neverTaintedJsType — `cmd.length` on `const cmd = ['pwd', []]`):
  // stand down so the dyn keyed read below the chain answers, instead
  // of an array libCall over a dyn receiver hitting the boundary fence.
  let kind = neverTaintedJsType(lowerer, expr.expression, lowerer.typeOf(expr.expression))
    ? undefined
    : lowerer.mapTypeOf(lowerer.typeOf(expr.expression))?.kind;
  // A checker-`any[]` receiver (the readonly-array Array.isArray quirk)
  // whose VALUE lowers to a real static array (maybeNarrow's isArray
  // bridge): `.length` and friends ride the array path on the lowered
  // value (re-lowering is pure IR construction).
  if (kind === undefined && lowerer.checkerAnyArray(expr.expression)) {
    const probe = lowerer.lowerExpr(expr.expression);
    if (probe.type.kind === "array") kind = "array";
  }
  if (
    kind !== "string" &&
    kind !== "array" &&
    kind !== "map" &&
    kind !== "set" &&
    kind !== "f64" &&
    kind !== "date" &&
    kind !== "regex" &&
    kind !== "url" &&
    kind !== "searchParams" &&
    kind !== "stats" &&
    kind !== "spawnRes" &&
    kind !== "child" &&
    kind !== "bytes" &&
    kind !== "symbol"
  ) {
    return null;
  }
  // child receivers also admit the user's own child-shaped interface
  // members (the NgrokChildProcess duck rule — see isChildSurfaceMember).
  // The EMPTY tuple `[]` rides the array REPRESENTATION (type-mapper.ts), but
  // its `length` member is the tuple's own synthesized property, not
  // Array.prototype's — provenance alone would refuse it. It reads the
  // runtime length (always 0) through the array intrinsic like any other
  // array; non-empty tuples never reach here (they map to records and
  // fold their arity constant on the record path).
  const tupleLengthOnArray =
    kind === "array" &&
    expr.name.text === "length" &&
    lowerer.checker.isTupleType(
      lowerer.checker.getBaseTypeOfLiteralType(lowerer.typeOf(expr.expression)),
    );
  if (
    kind === "child"
      ? !isChildSurfaceMember(lowerer, expr)
      : !tupleLengthOnArray && !lowerer.isStdlibMember(expr)
  )
    return null;
  const name = expr.name.text;
  if (kind === "array" && name === "constructor" && isJsSourceFile(ts.getSourceFileOfNode(expr))) {
    const receiver = lowerer.lowerExpr(expr.expression);
    if (receiver.type.kind === "dyn")
      return {
        kind: "dynKeyGet",
        value: receiver,
        key: { kind: "strLit", value: name, type: STRING, loc: locOf(expr) },
        type: DYN,
        loc: locOf(expr),
      };
    const result: IrExpr = {
      kind: "libCall",
      fn: "dyn.arrayConstructor",
      args: [],
      type: DYN,
      loc: locOf(expr),
    };
    return {
      kind: "seqExpr",
      stmts: [{ kind: "exprStmt", expr: receiver, loc: locOf(expr) }],
      result,
      type: DYN,
      loc: locOf(expr),
    };
  }
  const strictReceiver = (expected: IrType): IrExpr => {
    const value = lowerer.lowerExpr(expr.expression);
    if (value.type.kind === "dyn") {
      if (isJsSourceFile(ts.getSourceFileOfNode(expr)) && name === "length") return value;
      return lowerer.coerceInto(expr.expression, value, expected);
    }
    return lowerer.runtimeOptionalPropertyReceiver(expr.expression, value, expected, name) ?? value;
  };
  if (kind === "child") {
    const loc = locOf(expr);
    // The lifecycle reads, Node's exact shapes (SEMANTICS.md pins the
    // matrix): pid is `number | undefined` (undefined = spawn failure),
    // exitCode `number | null` (null while running and after a signal
    // death; -errno once a spawn failure settled), killed the
    // sent-a-signal flag. The unions build type-directedly in the
    // backend (the spawnRes.status pattern); a checker-narrowed read
    // extracts through maybeNarrow like any union member.
    if (name === "pid") {
      const receiver = lowerer.lowerExpr(expr.expression);
      const type: IrType = { kind: "union", unionId: lowerer.unions.intern([F64, UNDEFINED_T]) };
      return { kind: "libCall", fn: "child.pid", args: [receiver], type, loc };
    }
    if (name === "exitCode") {
      const receiver = lowerer.lowerExpr(expr.expression);
      const type: IrType = { kind: "union", unionId: lowerer.unions.intern([F64, NULL_T]) };
      return { kind: "libCall", fn: "child.exitCode", args: [receiver], type, loc };
    }
    if (name === "killed") {
      const receiver = lowerer.lowerExpr(expr.expression);
      return { kind: "libCall", fn: "child.killed", args: [receiver], type: BOOL, loc };
    }
    if (name === "on" || name === "once" || name === "kill" || name === "unref") {
      lowerer.unsupported("SC1090", expr, `child methods as values (call '${name}' directly)`);
    }
    lowerer.noLowering(
      `ChildProcess.${name}`,
      expr,
      'on/once("exit" | "close" | "error", cb), pid, exitCode, killed, kill(signal?), and unref() are the supported ChildProcess members',
      lowerer.checker.getSymbolAtLocation(expr.name),
    );
  }
  if (kind === "spawnRes") {
    // The spawnSync-result reads. status is the interned `number | null`
    // union (null = signal death or spawn failure); stdout/stderr are
    // the captured utf8 strings — under @types/node WITHOUT the
    // {encoding: "utf8"} options argument the checker types them Buffer,
    // which is re-fenced here (the call site already said so).
    const loc = locOf(expr);
    if (name === "status") {
      // Always the interned `number | null` union; a checker-NARROWED
      // read (`missing.status === null ? ... : ${missing.status}`)
      // bridges through maybeNarrow like any union read.
      const receiver = lowerer.lowerExpr(expr.expression);
      const type: IrType = { kind: "union", unionId: lowerer.unions.intern([F64, NULL_T]) };
      const read: IrExpr = { kind: "libCall", fn: "spawnRes.status", args: [receiver], type, loc };
      return lowerer.maybeNarrow(read, expr);
    }
    if (name === "stdout" || name === "stderr") {
      if (lowerer.mapTypeOf(lowerer.typeOf(expr))?.kind !== "string") {
        lowerer.noLowering(
          `spawnSync's ${name} without the "utf8" encoding`,
          expr,
          'Buffer captures are not representable — call spawnSync(cmd, args, { encoding: "utf8" }) so the outputs are strings',
        );
      }
      const receiver = lowerer.lowerExpr(expr.expression);
      const fn = name === "stdout" ? "spawnRes.stdout" : "spawnRes.stderr";
      return { kind: "libCall", fn, args: [receiver], type: STRING, loc };
    }
    if (name === "error") {
      // Node's spawn-failure carrier: `Error | undefined` — a fresh
      // %Error ("spawnSync <file> ENOENT", `code` stamped) when the
      // spawn itself failed, the undefined arm otherwise. The libCall
      // always carries the interned union (the declared `error?: Error`),
      // and a checker-NARROWED read (`if (r.error) r.error.message`)
      // bridges through maybeNarrow like any union read.
      const receiver = lowerer.lowerExpr(expr.expression);
      const type = lowerer.withUndefinedArmOf({ kind: "object", className: "%Error" });
      if (!type) lowerer.badType(expr, lowerer.typeOf(expr));
      const read: IrExpr = { kind: "libCall", fn: "spawnRes.error", args: [receiver], type, loc };
      return lowerer.maybeNarrow(read, expr);
    }
    lowerer.noLowering(
      `SpawnSyncReturns.${name}`,
      expr,
      "status, stdout, stderr, and error are the supported spawnSync-result members",
      lowerer.checker.getSymbolAtLocation(expr.name),
    );
  }
  if (kind === "stats") {
    if (name === "size") {
      const receiver = lowerer.lowerExpr(expr.expression);
      return { kind: "libCall", fn: "stats.size", args: [receiver], type: F64, loc: locOf(expr) };
    }
    if (Object.hasOwn(STATS_TYPE_TESTS, name)) {
      lowerer.unsupported("SC1090", expr, `Stats methods as values (call '${name}' directly)`);
    }
    lowerer.noLowering(
      `Stats.${name}`,
      expr,
      "isFile(), isDirectory(), isSymbolicLink(), isBlockDevice(), isCharacterDevice(), isFIFO(), isSocket(), dev, mode, nlink, uid, gid, rdev, blksize, ino, size, blocks, atimeMs, mtimeMs, ctimeMs, birthtimeMs, atime, mtime, ctime, and birthtime are the supported Stats members",
      lowerer.checker.getSymbolAtLocation(expr.name),
    );
  }
  if (kind === "date") {
    const methods = new Set([
      "getTime",
      "valueOf",
      "toISOString",
      "getFullYear",
      "getUTCFullYear",
      "getMonth",
      "getUTCMonth",
      "getDate",
      "getUTCDate",
      "getDay",
      "getUTCDay",
      "getHours",
      "getUTCHours",
      "getMinutes",
      "getUTCMinutes",
      "getSeconds",
      "getUTCSeconds",
      "getMilliseconds",
      "getUTCMilliseconds",
      "getTimezoneOffset",
    ]);
    if (methods.has(name)) {
      lowerer.unsupported("SC1090", expr, `Date methods as values (call '${name}' directly)`);
    }
    lowerer.noLowering(
      `Date.prototype.${name}`,
      expr,
      "getTime(), valueOf(), toISOString(), the local/UTC calendar getters, and getTimezoneOffset() are supported; Date setters and locale/string formatters have no lowering",
      lowerer.checker.getSymbolAtLocation(expr.name),
    );
  }
  if (kind === "symbol") {
    const loc = locOf(expr);
    // `.description`: the checker's `string | undefined` — undefined
    // exactly for the description-less Symbol()/Symbol(undefined) forms
    // (Symbol("") answers the EMPTY STRING arm, like Node). The interned
    // union builds in the backend from the runtime's +1-or-NULL answer
    // (the child.stdout pattern); a checker-narrowed read extracts
    // through maybeNarrow like any union member.
    if (name === "description") {
      const receiver = lowerer.coerceToExpected(lowerer.lowerExpr(expr.expression), SYMBOL_T);
      const type: IrType = { kind: "union", unionId: lowerer.unions.intern([STRING, UNDEFINED_T]) };
      return { kind: "libCall", fn: "sym.desc", args: [receiver], type, loc };
    }
    if (name === "toString" || name === "valueOf") {
      lowerer.unsupported("SC1090", expr, `symbol methods as values (call '${name}' directly)`);
    }
    lowerer.noLowering(
      `Symbol.prototype.${name}`,
      expr,
      "description and toString() are the supported symbol members",
      lowerer.checker.getSymbolAtLocation(expr.name),
    );
  }
  if (kind === "url") {
    // The supported URL getters. Everything else the lib declares
    // (searchParams, setters-as-reads, ...) fences with the
    // member-qualified name and the supported list. `host` is the WHATWG
    // serialization: lowercased hostname, `:port` appended exactly when
    // a non-default port is present (scr_url_host — Node-exact,
    // opaque-path URLs answer ""); `hostname` is the stored port-less
    // host field verbatim, including IPv6 brackets.
    if (
      name === "protocol" ||
      name === "origin" ||
      name === "username" ||
      name === "password" ||
      name === "pathname" ||
      name === "href" ||
      name === "host" ||
      name === "hostname" ||
      name === "port" ||
      name === "search" ||
      name === "hash"
    ) {
      const receiver = lowerer.lowerExpr(expr.expression);
      const fn =
        name === "protocol"
          ? "url.protocol"
          : name === "origin"
            ? "url.origin"
            : name === "username"
              ? "url.username"
              : name === "password"
                ? "url.password"
                : name === "pathname"
                  ? "url.pathname"
                  : name === "host"
                    ? "url.host"
                    : name === "hostname"
                      ? "url.hostname"
                      : name === "port"
                        ? "url.port"
                        : name === "search"
                          ? "url.search"
                          : name === "hash"
                            ? "url.hash"
                            : "url.href";
      return { kind: "libCall", fn, args: [receiver], type: STRING, loc: locOf(expr) };
    }
    // `u.searchParams`: the LIVE cached view (one identity per URL —
    // mutations through it re-serialize into the URL's query, so href
    // reflects immediately; Node's binding exactly).
    if (name === "searchParams") {
      const receiver = lowerer.lowerExpr(expr.expression);
      return {
        kind: "libCall",
        fn: "url.searchParams",
        args: [receiver],
        type: SEARCH_PARAMS_T,
        loc: locOf(expr),
      };
    }
    if (name === "toString" || name === "toJSON") {
      lowerer.unsupported("SC1090", expr, `URL methods as values (call '${name}' directly)`);
    }
    lowerer.noLowering(
      `URL.${name}`,
      expr,
      "protocol, origin, username, password, pathname, href, host, hostname, port, search, hash, searchParams, and toString() are the supported URL members",
      lowerer.checker.getSymbolAtLocation(expr.name),
    );
  }
  if (kind === "searchParams") {
    const SEARCH_PARAMS_METHODS = new Set([
      "get",
      "getAll",
      "set",
      "append",
      "delete",
      "has",
      "sort",
      "toString",
      "forEach",
      "keys",
      "values",
      "entries",
    ]);
    // The one data property; every method lowers at its CALL
    // (lowerSearchParamsMethodCall) — bare method references fence.
    if (name === "size") {
      const receiver = lowerer.lowerExpr(expr.expression);
      return { kind: "libCall", fn: "sp.size", args: [receiver], type: F64, loc: locOf(expr) };
    }
    if (SEARCH_PARAMS_METHODS.has(name)) {
      lowerer.unsupported(
        "SC1090",
        expr,
        `URLSearchParams methods as values (call '${name}' directly)`,
      );
    }
    lowerer.noLowering(
      `URLSearchParams.${name}`,
      expr,
      "get, getAll, set, append, delete, has, sort, size, toString(), forEach, and for-of iteration are the supported URLSearchParams members",
      lowerer.checker.getSymbolAtLocation(expr.name),
    );
  }
  if (kind === "regex") {
    if (name === "lastIndex") {
      return {
        kind: "regexIntrinsic",
        method: "lastIndex",
        receiver: strictReceiver({ kind: "regex" }),
        args: [],
        type: F64,
        loc: locOf(expr),
      };
    }
    if (name === "source" || name === "flags") {
      const receiver = strictReceiver({ kind: "regex" });
      return {
        kind: "regexIntrinsic",
        method: name,
        receiver,
        args: [],
        type: STRING,
        loc: locOf(expr),
      };
    }
    // The flag getters answer whether `flags` holds the flag's letter.
    const flag = REGEX_FLAG_GETTERS.get(name);
    if (flag !== undefined) {
      const loc = locOf(expr);
      const flags: IrExpr = {
        kind: "regexIntrinsic",
        method: "flags",
        receiver: strictReceiver({ kind: "regex" }),
        args: [],
        type: STRING,
        loc,
      };
      return {
        kind: "strIntrinsic",
        method: "includes",
        receiver: flags,
        args: [{ kind: "strLit", value: flag, type: STRING, loc }],
        type: BOOL,
        loc,
      };
    }
    if (name === "test") {
      lowerer.unsupported("SC1090", expr, "regex methods as values (call 'test' directly)");
    }
    return null;
  }
  if (kind === "f64") {
    if (own(STDLIB_SURFACE.number, name) !== undefined) {
      lowerer.unsupported("SC1090", expr, `number methods as values (call '${name}' directly)`);
    }
    return null;
  }
  if (kind === "bytes") {
    const loc = locOf(expr);
    if (name === "constructor") {
      const expected = lowerer.mapTypeOf(lowerer.typeOf(expr.expression));
      const receiver =
        expected?.kind === "bytes" ? strictReceiver(expected) : lowerer.lowerExpr(expr.expression);
      return {
        kind: "dynKeyGet",
        value: lowerer.coerceInto(expr.expression, receiver, DYN),
        key: { kind: "strLit", value: name, type: STRING, loc },
        type: DYN,
        loc,
      };
    }
    // The element size: a constant of the element kind (1 for a Buffer).
    if (name === "BYTES_PER_ELEMENT") {
      const expected = lowerer.mapTypeOf(lowerer.typeOf(expr.expression));
      const receiver =
        expected?.kind === "bytes" ? strictReceiver(expected) : lowerer.lowerExpr(expr.expression);
      if (receiver.type.kind === "bytes")
        return afterReceiver(receiver, numLit(BYTES_ELEMENT_SIZE[receiver.type.elem], loc), loc);
    }
    if (name === "length" || name === "byteLength") {
      const expected = lowerer.mapTypeOf(lowerer.typeOf(expr.expression));
      let receiver =
        expected?.kind === "bytes" ? strictReceiver(expected) : lowerer.lowerExpr(expr.expression);
      if (receiver.type.kind === "dyn")
        return {
          kind: "dynCheck",
          value: {
            kind: "dynKeyGet",
            value: receiver,
            key: { kind: "strLit", value: name, type: STRING, loc: locOf(expr) },
            type: DYN,
            loc: locOf(expr),
          },
          type: F64,
          loc: locOf(expr),
        };
      if (
        receiver.type.kind === "union" &&
        lowerer.armTag(receiver.type.unionId, UNDEFINED_T) >= 0
      ) {
        const present = lowerer.stripUndefinedArm(receiver.type);
        const helper =
          present.kind === "bytes"
            ? lowerer.narrowedArmHelper(receiver.type.unionId, present, locOf(expr.expression))
            : null;
        receiver = helper
          ? lowerer.checkedNarrowCall(helper, receiver, present, locOf(expr.expression))
          : lowerer.maybeNarrow(receiver, expr.expression);
      }

      // property read, exiting at the declared number type (the array

      return { kind: "bytesIntrinsic", method: name, receiver, args: [], type: F64, loc };
    }
    if (name === "byteOffset") {
      // 0 for owners (scriptc typed arrays own their whole storage —
      // SEMANTICS.md notes the divergence from Node's Buffer pooling),
      // the view's real offset for a DataView. A runtime read, so the
      // receiver's evaluation is never discarded.
      const expected = lowerer.mapTypeOf(lowerer.typeOf(expr.expression));
      const receiver =
        expected?.kind === "bytes" ? strictReceiver(expected) : lowerer.lowerExpr(expr.expression);
      return { kind: "bytesIntrinsic", method: "byteOffset", receiver, args: [], type: F64, loc };
    }
    if (name === "buffer") {
      const expected = lowerer.mapTypeOf(lowerer.typeOf(expr.expression));
      const receiver =
        expected?.kind === "bytes" ? strictReceiver(expected) : lowerer.lowerExpr(expr.expression);
      return { kind: "bytesIntrinsic", method: "buffer", receiver, args: [], type: DYN, loc };
    }
    if (name === "slice" || name === "subarray" || name === "set" || name === "toString") {
      lowerer.unsupported(
        "SC1090",
        expr,
        `typed-array methods as values (call '${name}' directly)`,
      );
    }
    return null; // fill, reverse, ... → the SC2020 member fence
  }
  if (kind === "map") {
    if (name === "size") {
      const expected = lowerer.mapTypeOf(lowerer.typeOf(expr.expression));
      const receiver =
        expected?.kind === "map" ? strictReceiver(expected) : lowerer.lowerExpr(expr.expression);
      return {
        kind: "mapIntrinsic",
        method: "size",
        receiver,
        args: [],
        type: F64,
        loc: locOf(expr),
      };
    }
    if (MAP_METHODS.has(name) || name === "forEach") {
      lowerer.unsupported("SC1090", expr, `Map methods as values (call '${name}' directly)`);
    }
    return null;
  }
  if (kind === "set") {
    if (name === "size") {
      const expected = lowerer.mapTypeOf(lowerer.typeOf(expr.expression));
      const receiver =
        expected?.kind === "set" ? strictReceiver(expected) : lowerer.lowerExpr(expr.expression);
      return {
        kind: "setIntrinsic",
        method: "size",
        receiver,
        args: [],
        type: F64,
        loc: locOf(expr),
      };
    }
    if (SET_METHODS.has(name)) {
      lowerer.unsupported("SC1090", expr, `Set methods as values (call '${name}' directly)`);
    }
    return null;
  }
  if (name === "length") {
    const expected =
      kind === "string" ? STRING : lowerer.mapTypeOf(lowerer.typeOf(expr.expression));
    let receiver = lowerer.lowerExpr(expr.expression);
    if (
      receiver.type.kind !== "dyn" &&
      expected &&
      (expected.kind === "string" || expected.kind === "array")
    ) {
      receiver =
        lowerer.runtimeOptionalPropertyReceiver(expr.expression, receiver, expected, name) ??
        receiver;
    }
    if (
      receiver.type.kind === "union" &&
      lowerer.armTag(receiver.type.unionId, UNDEFINED_T) >= 0 &&
      kind === "array"
    ) {
      const present = lowerer.stripUndefinedArm(receiver.type);
      const helper =
        present.kind === "array"
          ? lowerer.narrowedArmHelper(receiver.type.unionId, present, locOf(expr.expression))
          : null;
      receiver = helper
        ? lowerer.checkedNarrowCall(helper, receiver, present, locOf(expr.expression))
        : lowerer.maybeNarrow(receiver, expr.expression);
    }

    // A CHECKED-DYNAMIC value behind an array-typed checker spelling
    // (`Object.keys(u).length` — the dyn walk answers a dyn array while
    // tsc spells string[]): the runtime-world dispatch — a dyn keyed
    // read validated into the declared number (a lying length throws
    // the catchable TypeError, the dynCheck stance).
    if (receiver.type.kind === "dyn") {
      const read: IrExpr = {
        kind: "dynKeyGet",
        key: { kind: "strLit", value: "length", type: STRING, loc: locOf(expr) },
        ...(expr.questionDotToken ? { optional: true as const } : {}),
        value: receiver,
        type: DYN,
        loc: locOf(expr),
      };
      if (expr.questionDotToken) return read;
      return { kind: "dynCheck", value: read, type: F64, loc: locOf(expr) };
    }
    return kind === "string"
      ? { kind: "strIntrinsic", method: "length", receiver, args: [], type: F64, loc: locOf(expr) }
      : { kind: "arrIntrinsic", method: "length", receiver, args: [], type: F64, loc: locOf(expr) };
  }
  if (
    kind === "string"
      ? own(STR_METHODS, name) !== undefined ||
        STRING_INDEX_METHODS.has(name) ||
        own(STDLIB_SURFACE.string, name) !== undefined
      : ARRAY_METHODS.has(name)
  ) {
    // A JavaScript string method read as a value (smol-toml's
    // `!!(''.isWellFormed)` feature probe): String.prototype's method, the
    // runtime's interned function that runs it on its receiver.
    if (kind === "string" && isJsSourceFile(expr.getSourceFile()) && !expr.questionDotToken) {
      const receiver = lowerer.lowerExpr(expr.expression);
      const method: IrExpr = {
        kind: "libCall",
        fn: "dyn.builtinMethod",
        args: [
          { kind: "strLit", value: "String", type: STRING, loc: locOf(expr) },
          { kind: "strLit", value: name, type: STRING, loc: locOf(expr.name) },
        ],
        type: DYN,
        loc: locOf(expr),
      };
      return isSafeToDiscard(receiver)
        ? method
        : {
            kind: "seqExpr",
            stmts: [{ kind: "exprStmt", expr: receiver, loc: locOf(expr.expression) }],
            result: method,
            type: DYN,
            loc: locOf(expr),
          };
    }
    lowerer.unsupported("SC1090", expr, `${kind} methods as values (call '${name}' directly)`);
  }
  return null;
}

/** Buffer.alloc as a function value (`var alloc = Buffer.alloc` in
 * tar-stream): the runtime checks the size, allocates and fills with
 * `fill` and `encoding` as Node's alloc does. */
function bufferAllocValue(lowerer: Lowerer, loc: SrcLoc): IrExpr {
  const name = "%builtin.Buffer.alloc";
  if (!lowerer.builtinCallableValueFns.has(name)) {
    lowerer.builtinCallableValueFns.set(name, name);
    const params = ["size", "fill", "encoding"].map((id) => ({ localId: id, name: id, type: DYN }));
    lowerer.liftedFns.push({
      name,
      params,
      returnType: BYTES_U8,
      locals: params.map((p) => ({ id: p.localId, name: p.name, type: DYN, mutable: false })),
      loc,
      body: [
        {
          kind: "return",
          value: {
            kind: "libCall",
            fn: "buffer.allocValue",
            args: params.map((p) => varRef(p.localId, DYN, loc)),
            type: BYTES_U8,
            loc,
          },
          loc,
        },
      ],
    });
  }
  return {
    kind: "dynFrom",
    value: {
      kind: "closure",
      fnName: name,
      captures: [],
      type: { kind: "func", params: [DYN, DYN, DYN], ret: BYTES_U8 },
      loc,
    },
    fnName: "alloc",
    type: DYN,
    loc,
  };
}

/** A `T | undefined` class field read that the checker narrowed to `T`
 * where the field was assigned a value that may be missing (an unchecked
 * indexed read). TypeScript's assignment narrowing is not a runtime fact
 * there, so the read keeps the stored union instead of extracting `T`. */
function runtimeOptionalClassField(
  lowerer: Lowerer,
  value: IrExpr,
  node: ts.PropertyAccessExpression,
): boolean {
  if (value.kind !== "fieldGet" || value.type.kind !== "union") return false;
  if (lowerer.armTag(value.type.unionId, UNDEFINED_T) < 0) return false;
  if ((lowerer.unions.get(value.type.unionId)?.arms.length ?? 0) !== 2) return false;
  const symbol = lowerer.checker.getSymbolAtLocation(node.name);
  if (!symbol || !lowerer.runtimeOptionalAssignedSymbols.has(symbol)) return false;
  const narrowed = lowerer.mapTypeOf(lowerer.typeOf(node));
  return narrowed !== null && typeEquals(narrowed, lowerer.stripUndefinedArm(value.type));
}

/** `exports.<name>` in a JS module whose `module.exports =` REPLACED the
 * export object, with no `exports.<name> =` attachment anywhere in the
 * file: the read observes the ORIGINAL (empty-here) exports object, so
 * the honest value is undefined (Node's object identity exactly; tsc's
 * CJS model types the read off the replacement — identity-blind). Null
 * everywhere else: no replacement, a real attachment of this name, a
 * shadowing binding named `exports`, or write position. */
function lowerReplacedExportsRead(
  lowerer: Lowerer,
  expr: ts.PropertyAccessExpression,
): IrExpr | null {
  if (expr.questionDotToken) return null;
  const recv = expr.expression;
  if (!ts.isIdentifier(recv) || recv.text !== "exports") return null;
  const sf = ts.getSourceFileOfNode(expr);
  if (!isJsSourceFile(sf) || isNodeEsmFile(sf, lowerer.program)) return null;
  if (lowerer.peekLocal(recv) || lowerer.globalOf(recv)) return null; // a user binding shadows
  // Write position is the export-assignment machinery's territory.
  if (
    ts.isBinaryExpression(expr.parent) &&
    expr.parent.left === expr &&
    expr.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
  ) {
    return null;
  }
  let replaced = false;
  for (const stmt of sf.statements.nodes) {
    const cjs = cjsExportAssignmentOf(stmt);
    if (!cjs) continue;
    if (cjs.kind === "table" && cjsExportDiscardReason(stmt) === null) replaced = true;
    if (cjs.kind === "member" && ts.isIdentifier(cjs.name) && cjs.name.text === expr.name.text) {
      return null; // a real attachment of this name exists somewhere
    }
  }
  if (!replaced) return null;
  return { kind: "unitLit", unit: "undefined", type: UNDEFINED_T, loc: locOf(expr) };
}

/** `this.<name>` INSIDE a CJS export-table accessor (test/common's
 * `get localhostIPv4() { if (this.inFreeBSDJail) ... }`): Node binds the
 * getter's receiver to module.exports, so the read is the SIBLING table
 * property — a sibling GETTER's lifted call (per-read evaluation, like
 * any accessor read). Only arrows inherit the binding (a nested function
 * expression's `this` is its own). Null everywhere else — non-getter
 * siblings and absent names keep their per-site fences (none of the
 * probed suite shapes read them). */
function lowerCjsExportTableThisMember(
  lowerer: Lowerer,
  expr: ts.PropertyAccessExpression,
): IrExpr | null {
  if (expr.expression.kind !== ts.SyntaxKind.ThisKeyword || expr.questionDotToken) return null;
  if (!isJsSourceFile(ts.getSourceFileOfNode(expr))) return null;
  // The enclosing accessor, crossing only arrow boundaries (arrows
  // inherit `this`; any other function form rebinds it).
  let n: ts.Node | undefined = expr.parent;
  while (n !== undefined && !ts.isGetAccessorDeclaration(n) && !ts.isSetAccessorDeclaration(n)) {
    if (ts.isFunctionLike(n) && !ts.isArrowFunction(n)) return null;
    if (ts.isSourceFile(n)) return null;
    n = n.parent;
  }
  if (
    n === undefined ||
    !ts.isObjectLiteralExpression(n.parent) ||
    !isCjsExportTableLiteral(n.parent)
  ) {
    return null;
  }
  const sibling = n.parent.properties.nodes.find(
    (p): p is ts.GetAccessorDeclaration =>
      ts.isGetAccessorDeclaration(p) && ts.isIdentifier(p.name) && p.name.text === expr.name.text,
  );
  if (!sibling) return null;
  return cjsAccessorCall(lowerer, sibling, locOf(expr));
}

/** RegExp.prototype's flag getters and the flag each one reads. */
const REGEX_FLAG_GETTERS: ReadonlyMap<string, string> = new Map([
  ["hasIndices", "d"],
  ["global", "g"],
  ["ignoreCase", "i"],
  ["multiline", "m"],
  ["dotAll", "s"],
  ["unicode", "u"],
  ["unicodeSets", "v"],
  ["sticky", "y"],
]);

/** The named-group table of the regex that PRODUCED a match-result
 * expression — the `.groups` desugar's provenance question. Traces
 * (through parens, `!`, and const bindings):
 *   - `re.exec(s)` / `s.match(re)`   → re's static pattern
 *   - a matchAll ROW: `rows[i]`, the for-of binding over a direct
 *     `s.matchAll(re)` or a stored const drain → re's static pattern
 * Answers null when the producing regex isn't statically known (the
 * caller keeps its fence), or the groups list (possibly empty — a
 * traced regex WITHOUT named groups is the Node-undefined case). */
export function matchResultNamedGroupsOf(
  lowerer: Lowerer,
  e: ts.Expression,
): { name: string; index: number }[] | null {
  let producer = e;
  while (ts.isParenthesizedExpression(producer) || ts.isNonNullExpression(producer))
    producer = producer.expression;
  if (ts.isIdentifier(producer)) {
    const init = constInitializerOf(lowerer, producer);
    if (init !== null) return matchResultNamedGroupsOf(lowerer, init);
  }
  const reExpr = matchProducerRegexOf(lowerer, e);
  if (reExpr === null) return null;
  if (
    ts.isCallExpression(producer) &&
    ts.isPropertyAccessExpression(producer.expression) &&
    producer.expression.name.text === "match"
  ) {
    const flags = staticRegexFlagsOf(lowerer, reExpr);
    if (flags === null) return null;
    // Global String.match returns whole matches without a groups
    // property, even when the pattern contains named captures.
    if (flags.includes("g")) return [];
  }
  const pattern = staticRegexPatternOf(lowerer, reExpr);
  if (pattern === null) return null;
  return namedCaptureGroupsOfPattern(pattern);
}

function staticRegexFlagsOf(lowerer: Lowerer, node: ts.Expression): string | null {
  let expr = node;
  while (ts.isParenthesizedExpression(expr) || ts.isNonNullExpression(expr)) expr = expr.expression;
  if (ts.isRegularExpressionLiteral(expr)) return expr.text.slice(expr.text.lastIndexOf("/") + 1);
  if (ts.isIdentifier(expr)) {
    const init = constInitializerOf(lowerer, expr);
    return init !== null ? staticRegexFlagsOf(lowerer, init) : null;
  }
  if (
    ts.isNewExpression(expr) &&
    ts.isIdentifier(expr.expression) &&
    lowerer.isStdlibGlobal(expr.expression, "RegExp")
  ) {
    const flags = expr.arguments?.nodes[1];
    if (!flags) return "";
    if (ts.isStringLiteral(flags) || ts.isNoSubstitutionTemplateLiteral(flags)) return flags.text;
  }
  return null;
}

/** The regex EXPRESSION whose match produced `e` (see
 * matchResultNamedGroupsOf for the traced shapes). */
function matchProducerRegexOf(lowerer: Lowerer, e: ts.Expression): ts.Expression | null {
  let expr = e;
  for (;;) {
    if (ts.isParenthesizedExpression(expr) || ts.isNonNullExpression(expr)) {
      expr = expr.expression;
      continue;
    }
    break;
  }
  // The direct producers: re.exec(s) / s.match(re) — the receiver's
  // mapped type pins the STDLIB operation (a regex for exec, a string
  // or its nullable spelling for match — the claim string-and-regexp
  // makes), so a user method that happens to be named `match` with a
  // regex argument never traces.
  if (ts.isCallExpression(expr) && ts.isPropertyAccessExpression(expr.expression)) {
    const name = expr.expression.name.text;
    const recvT = lowerer.mapTypeOf(lowerer.typeOf(expr.expression.expression));
    if (name === "exec" && expr.arguments.nodes.length === 1 && recvT?.kind === "regex") {
      return expr.expression.expression;
    }
    if (
      name === "match" &&
      expr.arguments.nodes.length === 1 &&
      (recvT?.kind === "string" ||
        (recvT !== null && recvT !== undefined && nullableStringType(lowerer, recvT))) &&
      lowerer.mapTypeOf(lowerer.typeOf(expr.arguments.nodes[0]!))?.kind === "regex"
    ) {
      return expr.arguments.nodes[0]!;
    }
  }
  // A matchAll ROW by element access: rows[i] with rows tracing to the
  // drain call — or the direct s.matchAll(re)[i] spelling.
  if (ts.isElementAccessExpression(expr)) {
    return matchAllRegexOf(lowerer, expr.expression);
  }
  // A row picked by `rows.find(cb)`, `rows.findLast(cb)` or `rows.at(i)`.
  if (
    ts.isCallExpression(expr) &&
    ts.isPropertyAccessExpression(expr.expression) &&
    MATCH_ROW_PICK_METHODS.has(expr.expression.name.text) &&
    lowerer.isStdlibMember(expr.expression)
  ) {
    return matchAllRegexOf(lowerer, expr.expression.expression);
  }
  if (ts.isIdentifier(expr)) {
    // The for-of binding over a matchAll drain: `for (const m of
    // s.matchAll(re))` (or over a stored const rows).
    const sym = lowerer.resolveValueSymbol(expr);
    const decl = sym ? sym.valueDeclaration : undefined;
    if (
      decl !== undefined &&
      ts.isVariableDeclaration(decl) &&
      ts.isVariableDeclarationList(decl.parent) &&
      ts.isForOfStatement(decl.parent.parent)
    ) {
      return matchAllRegexOf(lowerer, decl.parent.parent.expression);
    }
    // A stored const match result: `const m = re.exec(s)`.
    const init = constInitializerOf(lowerer, expr);
    if (init !== null) return matchProducerRegexOf(lowerer, init);
    // The element parameter of an array callback over matchAll rows:
    // `[...s.matchAll(re)].map((m) => m.groups)`, and Array.from's
    // mapping function over `s.matchAll(re)`.
    if (decl !== undefined && ts.isParameter(decl)) return matchAllCallbackRegexOf(lowerer, decl);
  }
  return null;
}

/** Array methods that return one row of the receiver. */
const MATCH_ROW_PICK_METHODS = new Set(["find", "findLast", "at"]);

/** `m.groups` on a match result whose producing regex is statically
 * known: the honest slice already HOLDS every named group's value at
 * its capture index, so the groups object is a compile-time record
 * projection — `{ year: m[1], month: m[2] }` — built by one interned
 * helper per (shape, index list, receiver type). Node's exact shape
 * decisions:
 *   - no named groups → `undefined` (the identifier-receiver shapes —
 *     a call receiver would lose its own null trap, so those keep the
 *     member fence);
 *   - a nullable receiver (the JS `s.match(re).groups` idiom) throws
 *     Node's exact TypeError on the unit arms;
 *   - every declared name is a key (nonparticipating groups hold undefined,
 *     exactly the slice elements they project);
 *   - ES2025 duplicate names (distinct alternatives) project the first
 *     participating occurrence, including a participating empty string;
 *   - key order is group declaration order (declaredOrder), Node's own.
 * The record has a null prototype, like Node's groups object. A
 * JavaScript callback parameter holds the row as a dynamic array; the
 * projection reads its elements through dynamic reads. Null when the
 * receiver isn't a match slice or the regex isn't traceable — the
 * caller's member fence (with the groups hint) names the gap. */
function lowerMatchGroupsRead(lowerer: Lowerer, expr: ts.PropertyAccessExpression): IrExpr | null {
  if (expr.name.text !== "groups") return null;
  // `m?.groups` re-dispatches through the optional-chain machinery, which
  // narrows the receiver to its match arm first.
  if (expr.questionDotToken !== undefined && !lowerer.chainHandled.has(expr)) return null;
  const loc = locOf(expr);
  const strArr = arrayOf(STRING);
  const recvT = lowerer.mapTypeOf(lowerer.typeOf(expr.expression));
  if (!recvT || !isMatchSliceType(lowerer, recvT) || !lowerer.isStdlibMember(expr)) return null;
  const groups = matchResultNamedGroupsOf(lowerer, expr.expression);
  // An untraced regex: TypeScript reaches the member fence; JavaScript
  // would otherwise read the slice's absent expando as undefined.
  if (groups === null && isJsSourceFile(ts.getSourceFileOfNode(expr)))
    lowerer.stdlibMemberFence(expr);
  if (groups === null) return null;
  if (groups.length === 0) {
    // Node: a match result of a group-less regex answers undefined —
    // the unit literal, exactly the `undefined` identifier's lowering.
    // Identifier receivers only (evaluation-free): a CALL receiver's
    // exec/match must still run and null-trap, which a folded unit
    // cannot carry — those keep the fence.
    let r: ts.Expression = expr.expression;
    while (ts.isParenthesizedExpression(r) || ts.isNonNullExpression(r)) r = r.expression;
    if (ts.isIdentifier(r) && typeEquals(recvT, strArr)) {
      return { kind: "unitLit", unit: "undefined", type: UNDEFINED_T, loc };
    }
    return null;
  }
  const recv = lowerer.lowerExpr(expr.expression);
  // A JavaScript callback parameter holds the row as a dynamic array.
  const dynRow = recv.type.kind === "dyn" && isJsSourceFile(ts.getSourceFileOfNode(expr));
  if (!dynRow && !isMatchSliceType(lowerer, recv.type)) return null;
  return lowerGroupsProjection(lowerer, recv, groups, loc);
}

/** True when the IR type is a string-or-units union — the Dict<string>
 * member spelling (`process.versions.openssl`), match's nullable
 * receiver claim. */
function nullableStringType(lowerer: Lowerer, t: IrType): boolean {
  if (t.kind !== "union") return false;
  const arms = lowerer.unions.get(t.unionId)?.arms ?? [];
  return (
    arms.some((a) => a.kind === "string") && arms.every((a) => a.kind === "string" || isUnitType(a))
  );
}

/** True when the IR type is the honest match slice — `string[]`, or a
 * union of it with unit arms only (`string[] | null`). The groups
 * projection's receiver gate, shared with the destructure interception. */
export function isMatchSliceType(lowerer: Lowerer, t: IrType): boolean {
  if (typeEquals(t, arrayOf(STRING))) return true;
  return t.kind === "union" && matchSliceUnionArms(lowerer, t.unionId) !== null;
}

/** The union-arm layout of a nullable match slice (`string[] | null`,
 * matchAll's checker spellings with undefined arms included): the
 * string[] arm's tag plus each unit arm's tag and spelling. Null when
 * the union holds anything else. */
function matchSliceUnionArms(
  lowerer: Lowerer,
  unionId: string,
): { arrTag: number; units: { tag: number; unit: "null" | "undefined" }[] } | null {
  const def = lowerer.unions.get(unionId);
  if (!def) return null;
  const strArr = arrayOf(STRING);
  const arrTag = def.arms.findIndex((a) => typeEquals(a, strArr));
  if (arrTag < 0) return null;
  const units: { tag: number; unit: "null" | "undefined" }[] = [];
  for (let i = 0; i < def.arms.length; i++) {
    if (i === arrTag) continue;
    const a = def.arms[i]!;
    if (!isUnitType(a)) return null;
    units.push({ tag: i, unit: a.kind === "nullT" ? "null" : "undefined" });
  }
  return { arrTag, units };
}

/** Node's TypeError for `.groups` read off null or undefined. */
function groupsReadTypeError(unit: "null" | "undefined", loc: SrcLoc): IrStmt {
  return {
    kind: "throw",
    value: {
      kind: "libCall",
      fn: "error.new",
      args: [strLit(`Cannot read properties of ${unit} (reading 'groups')`, loc)],
      type: { kind: "object", className: "%TypeError" },
      loc,
    },
    loc,
  };
}

/** The groups-record projection holds string | undefined values, including
 * an own overflow entry for every nonparticipating capture. One lifted helper per
 * (index list, receiver representation) builds it; see
 * lowerMatchGroupsRead for the semantics the body encodes. */
export function lowerGroupsProjection(
  lowerer: Lowerer,
  recv: IrExpr,
  groups: { name: string; index: number }[],
  loc: SrcLoc,
): IrExpr {
  // Name → its capture indices, in declaration order (duplicates keep
  // every occurrence — the projection picks the participating one).
  const order: string[] = [];
  const indicesByName = new Map<string, number[]>();
  for (const g of groups) {
    const got = indicesByName.get(g.name);
    if (got) {
      got.push(g.index);
    } else {
      indicesByName.set(g.name, [g.index]);
      order.push(g.name);
    }
  }
  const valueType = arrayValueType(lowerer, STRING);
  const shapeId = lowerer.shapes.intern([], false, valueType);
  const recordT: IrType = { kind: "record", shapeId };
  const recvKey =
    recv.type.kind === "union" ? recv.type.unionId : recv.type.kind === "dyn" ? "dyn" : "arr";
  const key = `regexgroups:${shapeId}:${groups.map((g) => `${g.name}=${g.index}`).join(",")}:${recvKey}`;
  let helper = lowerer.valueHelpers.get(key);
  if (!helper) {
    helper = keyedHelperName(lowerer, "%regex.groups", key);
    lowerer.valueHelpers.set(key, helper);
    const body: IrStmt[] = [];
    const locals: IrLocal[] = [{ id: "m.0", name: "m", type: recv.type, mutable: true }];
    let mRef: IrExpr = { kind: "varRef", localId: "m.0", type: recv.type, loc };
    if (recv.type.kind === "union") {
      // Node's exact TypeError per unit arm, then the checked narrow.
      const arms = matchSliceUnionArms(lowerer, recv.type.unionId)!;
      for (const u of arms.units) {
        body.push({
          kind: "if",
          cond: {
            kind: "unionIsTag",
            unionId: recv.type.unionId,
            tag: u.tag,
            negated: false,
            value: mRef,
            type: BOOL,
            loc,
          },
          then: [groupsReadTypeError(u.unit, loc)],
          else_: null,
          loc,
        });
      }
      const narrowed: IrExpr = {
        kind: "unionNarrow",
        unionId: recv.type.unionId,
        tag: arms.arrTag,
        value: mRef,
        type: arrayOf(STRING),
        loc,
      };
      locals.push({ id: "arr.0", name: "arr", type: arrayOf(STRING), mutable: false });
      body.push({ kind: "varDecl", localId: "arr.0", init: narrowed, loc });
      mRef = { kind: "varRef", localId: "arr.0", type: arrayOf(STRING), loc };
    } else if (recv.type.kind === "dyn") {
      // A JavaScript callback parameter holds the row as a dynamic array:
      // Node's TypeError for null and undefined, then dynamic element reads.
      for (const unit of ["null", "undefined"] as const) {
        body.push({
          kind: "if",
          cond: { kind: "dynTest", test: unit, value: mRef, type: BOOL, loc },
          then: [groupsReadTypeError(unit, loc)],
          else_: null,
          loc,
        });
      }
    }

    const elem = (index: number): IrExpr =>
      mRef.type.kind === "dyn"
        ? lowerer.coerceToExpected(
            {
              kind: "dynKeyGet",
              value: mRef,
              key: strLit(String(index), loc),
              type: DYN,
              loc,
            },
            valueType,
          )
        : arrayValueRead(lowerer, mRef, numLit(index, loc), STRING, loc);
    const values = new Map<string, IrExpr>();
    order.forEach((name, i) => {
      const idxs = indicesByName.get(name)!;
      if (idxs.length === 1) {
        values.set(name, elem(idxs[0]!));
        return;
      }
      // Duplicates: the first participating occurrence. Empty strings
      // participate; undefined means this alternative did not match.
      const id = `g${i}.0`;
      locals.push({ id, name: `g${i}`, type: valueType, mutable: true });
      body.push({ kind: "varDecl", localId: id, init: elem(idxs[0]!), loc });
      const gRef: IrExpr = { kind: "varRef", localId: id, type: valueType, loc };
      for (const idx of idxs.slice(1)) {
        body.push({
          kind: "if",
          cond: {
            kind: "unionIsTag",
            unionId: valueType.kind === "union" ? valueType.unionId : "",
            tag: valueType.kind === "union" ? lowerer.armTag(valueType.unionId, UNDEFINED_T) : -1,
            negated: false,
            value: gRef,
            type: BOOL,
            loc,
          },
          then: [{ kind: "assign", localId: id, value: elem(idx), loc }],
          else_: null,
          loc,
        });
      }
      values.set(name, gRef);
    });
    body.push({
      kind: "return",
      value: {
        kind: "recordLit",
        fields: order.map((name) => ({ name, value: values.get(name)!, overflow: true as const })),
        nullProto: true,
        type: recordT,
        loc,
      },
      loc,
    });
    lowerer.liftedFns.push({
      name: helper,
      params: [{ localId: "m.0", name: "m", type: recv.type }],
      returnType: recordT,
      locals,
      body,
      loc,
    });
  }
  return { kind: "call", callee: helper, args: [recv], type: recordT, loc };
}

/** Field reads use the shared FieldTarget union. Native method reads select
 * an interned unbound callable; invocation supplies its receiver separately. */
export function lowerFieldRead(lowerer: Lowerer, expr: ts.PropertyAccessExpression): IrExpr | null {
  // A checked receiver already owns its property table. An ambient
  // generic method signature must not divert its value into native
  // object-literal specialization (Array.prototype.map is one example).
  if (ts.isIdentifier(expr.expression)) {
    const stored = lowerer.peekLocal(expr.expression) ?? lowerer.globalOf(expr.expression);
    if (stored?.type.kind === "dyn") {
      const value = lowerer.lowerExpr(expr.expression);
      if (value.type.kind === "dyn")
        return {
          kind: "dynKeyGet",
          value,
          key: { kind: "strLit", value: expr.name.text, type: STRING, loc: locOf(expr.name) },
          ...(expr.questionDotToken || hasOptionalChainGuard(expr.expression, lowerer)
            ? { optional: true as const }
            : {}),
          type: DYN,
          loc: locOf(expr),
        };
    }
  }
  const target = lowerer.fieldTarget(expr);
  if (target) return lowerer.fieldGetExpr(target, locOf(expr), expr);
  if (expr.questionDotToken) return null;
  let receiverIr = lowerer.mapTypeOf(lowerer.typeOf(expr.expression));
  // The readonly-tuple Array.isArray narrow has no directly mappable
  // checker type (`Result & any[]`), but maybeNarrow extracted the tuple
  // record behind it. Route tuple properties such as `.length` from that
  // lowered value, the element-access bridge's twin.
  const checkerArray = lowerer.checkerArrayValue(expr.expression);
  if (checkerArray?.type.kind === "record") receiverIr = checkerArray.type;
  if (
    receiverIr?.kind === "object" &&
    (lowerer.findMethodOn(lowerer.classes.get(receiverIr.className) ?? null, expr.name.text) ||
      findGenericMethodOn(
        lowerer,
        lowerer.classes.get(receiverIr.className) ?? null,
        expr.name.text,
      ))
  ) {
    const info = lowerer.classes.get(receiverIr.className);
    if (info) return lowerClassMethodValue(lowerer, expr, info);
  }
  // An object-literal GENERIC method as a VALUE (`o.m` — the member is
  // excluded from the record shape): the pinned-value rule verbatim when
  // the receiver is the defining literal's own const binding (the value
  // is the pinned instance's closure — no `this` exists); anything else
  // fences by name inside the helpers.
  {
    const propSym = lowerer.checker.getPropertyOfType(
      lowerer.typeOf(expr.expression),
      expr.name.text,
    );
    if (
      receiverIr?.kind !== "object" &&
      propSym &&
      // The WebCrypto object's generic getRandomValues reads off its
      // dynamic object.
      !isWebCryptoReceiver(lowerer, expr.expression) &&
      isGenericCallableMemberType(lowerer.checker.getTypeOfSymbol(propSym), lowerer.checker) &&
      // CLASS members keep the class-path fences (a poisoned class's own
      // diagnostics, the bound-method fence above).
      !propSym.declarations.some(
        (d) =>
          d.parent !== undefined &&
          (ts.isClassDeclaration(d.parent) || ts.isClassExpression(d.parent)),
      )
    ) {
      const found = objLitGenericFnNodeOf(lowerer, propSym);
      if (!found) {
        lowerer.unsupported(
          "SC1090",
          expr,
          `the generic method '${expr.name.text}' as a value with no defining object literal (only methods declared with a body in an object literal compile)`,
        );
      }
      requireObjLitGenericReceiver(lowerer, expr, expr.expression, found.literal, expr.name.text);
      return lowerer.lowerGenericFnValue(
        expr,
        objLitGenericFnInfoOf(lowerer, expr, expr.name.text, found),
      );
    }
  }
  // Dot access to an UNDECLARED key of an index-signature shape
  // (`bag.count` on `Record<string, number>`): tsc allows it without
  // noPropertyAccessFromIndexSignature, but the bracket spelling is the
  // canonical index-signature form here — point at it.
  if (receiverIr?.kind === "record") {
    const shape = lowerer.shapes.get(receiverIr.shapeId);
    if (shape?.indexValue && !shape.fields.some((f) => f.name === expr.name.text)) {
      const actual = tryLowerExpression(lowerer, expr.expression);
      if (actual?.type.kind === "dyn")
        return {
          kind: "dynKeyGet",
          value: actual,
          key: { kind: "strLit", value: expr.name.text, type: STRING, loc: locOf(expr.name) },
          type: DYN,
          loc: locOf(expr),
        };
      if (actual?.type.kind === "record") {
        const field = lowerer.shapes
          .get(actual.type.shapeId)
          ?.fields.find((field) => field.name === expr.name.text);
        if (field)
          return {
            kind: "recordGet",
            obj: actual,
            shapeId: actual.type.shapeId,
            field: field.name,
            type: field.type,
            loc: locOf(expr),
          };
      }
      // A member the checker declares on the receiver, stored in a pure
      // index-signature record (an object literal that spread one, see
      // dictSpreadLiteralShape): the key is always present, so the keyed
      // read answers the member through the slot type.
      if (
        actual?.type.kind === "record" &&
        shape.fields.length === 0 &&
        declaredMemberOf(lowerer, expr.expression, expr.name.text)
      ) {
        return lowerer.maybeNarrow(
          {
            kind: "recordKeyGet",
            obj: actual,
            shapeId: actual.type.shapeId,
            key: { kind: "strLit", value: expr.name.text, type: STRING, loc: locOf(expr.name) },
            type: shape.indexValue,
            loc: locOf(expr),
          },
          expr,
        );
      }
      lowerer.unsupported(
        "SC1090",
        expr,
        `dot access to index-signature keys (spell it r["${expr.name.text}"] — brackets are the index-signature form)`,
      );
    }
  }
  // `t.length` on a tuple: the arity CONSTANT (tuples are fixed-shape —
  // the checker types it as the literal arity too). Folding discards the
  // receiver's evaluation, so only side-effect-free receivers fold;
  // anything else (a call result) binds to a const first.
  if (receiverIr?.kind === "record" && expr.name.text === "length") {
    const shape = lowerer.shapes.get(receiverIr.shapeId);
    if (shape?.tuple) {
      let root: ts.Expression = expr.expression;
      while (ts.isPropertyAccessExpression(root)) root = root.expression;
      if (!ts.isIdentifier(root) && root.kind !== ts.SyntaxKind.ThisKeyword) {
        lowerer.unsupported(
          "SC1090",
          expr,
          "'.length' of a computed tuple expression (the arity is a constant — bind the tuple to a const first)",
        );
      }
      return { kind: "numLit", value: shape.fields.length, type: F64, loc: locOf(expr) };
    }
  }
  return null;
}

/** Shared-field read `r.f` on a UNION receiver: supported exactly when
 * every arm is a record/class possessing the field with ONE shared IR
 * type — the discriminant pattern (`r.kind`, primitive) and the
 * shared-payload pattern (`spec.config` where every ServiceSpec arm
 * carries the same record). Lowers to `unionDisc` (the backend switches
 * on the runtime tag and reads the field from the concrete arm), which
 * composes with existing strEq/bin/switch nodes, so `r.kind === "ok"`
 * and `switch (r.kind)` work without dedicated test nodes. Anything else
 * on a union receiver is rejected specifically (narrow first). */
export function lowerUnionProperty(
  lowerer: Lowerer,
  expr: ts.PropertyAccessExpression,
): IrExpr | null {
  if (lowerer.chainBlocked(expr)) return null;
  const receiverIr =
    structuralReadType(lowerer, expr.expression) ??
    lowerer.mapTypeOf(lowerer.typeOf(expr.expression));
  if (receiverIr?.kind !== "union") return null;
  // Lower the receiver first: its runtime value can still carry the full
  // binding union even when the checker has removed several variants.
  let value = lowerer.lowerExpr(expr.expression);
  // A guard can remove several variants without selecting one record.
  // Materialize that sub-union before looking for common fields; arms
  // ruled out by the guard must not veto a field shared by the survivors.
  if (value.type.kind === "union" && !typeEquals(value.type, receiverIr)) {
    const helper = lowerer.narrowedRetagHelper(
      expr.expression,
      value.type.unionId,
      receiverIr.unionId,
      locOf(expr),
    );
    if (helper)
      value = { kind: "call", callee: helper, args: [value], type: receiverIr, loc: locOf(expr) };
    // Optional storage of a base class (a runtime-optional binding holding
    // `Base | undefined`) that `instanceof` narrowed to several subclasses:
    // extract the instance and test its class, as typed slots do.
    else value = narrowStoredClassValue(lowerer, value, receiverIr) ?? value;
  }
  // A checker-union receiver whose VALUE lowered to a plain RECORD (the
  // merged-signature fiction — `runner(cmd, args)` where runner joined
  // a structural runner type with spawnSync's, and the local adopted
  // the record arm): read the record field directly, the dyn-receiver
  // fallback's discipline.
  // A checker-union receiver whose VALUE lowered checked-dynamic (a
  // never-tainted JS chain — `cmd[1].length` on `const cmd = ['pwd',
  // []]`, where the element read stayed a dyn node): read through the
  // dyn keyed read like the unmappable-receiver path below the chain.
  if (value.type.kind === "dyn") {
    const key: IrExpr = {
      kind: "strLit",
      value: expr.name.text,
      type: STRING,
      loc: locOf(expr.name),
    };
    return { kind: "dynKeyGet", key, value, type: DYN, loc: locOf(expr) };
  }
  if (value.type.kind === "record") {
    const shape = lowerer.shapes.get(value.type.shapeId);
    const f = shape?.fields.find((x) => x.name === expr.name.text);
    if (f) {
      return {
        kind: "recordGet",
        obj: value,
        shapeId: value.type.shapeId,
        field: f.name,
        type: f.type,
        loc: locOf(expr),
      };
    }
    return null;
  }
  // A class instance the checker sees through a wider union (`(concrete
  // as A | B).value`): the value is that class's instance, so read its
  // field directly.
  if (value.type.kind === "object") {
    const className = value.type.className;
    const info = lowerer.classes.get(className) ?? null;
    const field = expr.name.text;
    const fieldType = info?.fields.get(field);
    if (fieldType !== undefined)
      return lowerer.fieldGetExpr(
        { container: "class", obj: value, className, field, fieldType },
        locOf(expr),
        expr,
      );
    const getter = lowerer.findMethodOn(info, `get:${field}`);
    if (getter)
      return lowerer.fieldGetExpr(
        { container: "accessor", obj: value, className, field, fieldType: getter.sig.ret },
        locOf(expr),
        expr,
      );
  }
  if (value.type.kind !== "union") {
    lowerer.unsupported(
      "SC1090",
      expr,
      "shared property access without a represented union receiver",
    );
  }
  const def = lowerer.unions.get(value.type.unionId);
  if (!def) throw new InternalCompilerError(`lowerer bug: unknown union ${value.type.unionId}`);
  const field = expr.name.text;
  if (field === "length") {
    const presentArms = def.arms.filter((arm) => !isUnitType(arm));
    const present = presentArms.length === 1 ? presentArms[0]! : null;
    if (present?.kind === "string" || present?.kind === "array") {
      const receiver = lowerer.runtimeOptionalPropertyReceiver(
        expr.expression,
        value,
        present,
        field,
      );
      if (receiver !== null) {
        return present.kind === "string"
          ? {
              kind: "strIntrinsic",
              method: "length",
              receiver,
              args: [],
              type: F64,
              loc: locOf(expr),
            }
          : {
              kind: "arrIntrinsic",
              method: "length",
              receiver,
              args: [],
              type: F64,
              loc: locOf(expr),
            };
      }
    }
  }
  const nonUnitArms = def.arms.filter((arm) => !isUnitType(arm));
  if (nonUnitArms.length === 1 && nonUnitArms[0]?.kind === "object") {
    const objectType = nonUnitArms[0];
    const fieldType = lowerer.classes.get(objectType.className)?.fields.get(field);
    if (fieldType !== undefined) {
      let receiver = lowerer.runtimeOptionalPropertyReceiver(
        expr.expression,
        value,
        objectType,
        field,
      );
      if (receiver === null) {
        const helper = lowerer.narrowedArmHelper(
          value.type.unionId,
          objectType,
          locOf(expr.expression),
        );
        if (helper !== null)
          receiver = lowerer.checkedNarrowCall(helper, value, objectType, locOf(expr.expression));
      }
      if (receiver !== null) {
        return {
          kind: "fieldGet",
          obj: receiver,
          className: objectType.className,
          field,
          type: fieldType,
          loc: locOf(expr),
        };
      }
    }
  }
  let common: IrType | null = null;
  for (const arm of def.arms) {
    let ft: IrType | undefined;
    if (arm.kind === "record") {
      ft = lowerer.shapes.get(arm.shapeId)?.fields.find((f) => f.name === field)?.type;
    } else if (arm.kind === "object") {
      ft = lowerer.classes.get(arm.className)?.fields.get(field);
    }
    if (!ft || ft.kind === "void" || isUnitType(ft) || (common && !typeEquals(common, ft))) {
      common = null;
      break;
    }
    common = ft;
  }
  if (common) {
    return {
      kind: "unionDisc",
      unionId: value.type.unionId,
      field,
      value,
      type: common,
      loc: locOf(expr),
    };
  }
  // The arms answer DIFFERENT types (or through index signatures / unit
  // arms): the JOIN path — `env.PORTLESS_PORT` on `ProcessEnv |
  // Record<string, string>`, the tail read of `loaded?.config.script`.
  const key: IrExpr = { kind: "strLit", value: field, type: STRING, loc: locOf(expr.name) };
  const keyed = lowerUnionKeyedRead(lowerer, expr, value.type.unionId, value, key, field);
  if (keyed) return keyed;
  // Class arms declaring the field with compatible but different types
  // (`T | undefined` beside `T`): per-arm slot reads widened to one type.
  const widened = lowerUnionFieldRead(lowerer, expr, value);
  if (widened) return widened;
  // JavaScript overloads commonly inspect a class brand on a scalar-or-
  // instance argument (e.g. Matrix4.makeTranslation). Preserve primitive
  // missing-property semantics and dispatch class data through its native
  // capsule instead of demanding a field shared by every union arm.
  if (isJsSourceFile(ts.getSourceFileOfNode(expr)) && lowerer.dynConvertible(value.type)) {
    return {
      kind: "dynKeyGet",
      value: lowerer.coerceToExpected(value, DYN),
      key,
      ...(hasOptionalChainGuard(expr.expression, lowerer) ? { optional: true as const } : {}),
      type: DYN,
      loc: locOf(expr),
    };
  }
  // A union of typed arrays and number arrays: each arm's own length
  // (and, for typed arrays only, byteLength, byteOffset, BYTES_PER_ELEMENT).
  const indexedArms = indexedUnionArms(lowerer, value.type);
  if (indexedArms) {
    const member = lowerIndexedUnionMember(lowerer, value, indexedArms, field, locOf(expr));
    if (member) return member;
  }
  lowerer.unsupported(
    "SC1090",
    expr,
    `reading '${field}' on a union-typed value (every arm must be an object/record ` +
      `with a same-typed field '${field}'; ` +
      `${NARROW_FIRST})`,
  );
}

/** The unionDisc generalization: a keyed read on a union receiver whose
 * arms answer DIFFERENT (but joinable) types. Each arm contributes its
 * declared answer — an array element's type (number keys), a declared field's type (literal keys), an
 * index-signature arm's value type (plus its declared fields' types for
 * runtime keys, which reach them through the keyed-read helper), and
 * UNDEFINED for unit arms (reachable only through optional-chain tails,
 * where JS short-circuits to undefined; a unit arm the checker narrowed
 * away is simply unreachable). The result type is the JOIN of those
 * answers; every arm's answer must be the join itself, one of its
 * arms, or a sub-union whose payload representations are unchanged.
 * Array reads retain the ordinary invalid-index trap policy.
 * Returns null when any arm cannot answer — the caller owns the fence
 * message. The caller (the property/element dispatch) maybeNarrows. */
export function lowerUnionKeyedRead(
  lowerer: Lowerer,
  expr: ts.Expression,
  unionId: string,
  value: IrExpr,
  key: IrExpr,
  literalField: string | null,
): IrExpr | null {
  const def = lowerer.unions.get(unionId);
  if (!def) return null;
  // Pass 1: per-arm declared answers, joined into the result type.
  const joinArms: IrType[] = [];
  const seen = new Set<string>();
  const push = (t: IrType): void => {
    const k = typeKey(t);
    if (!seen.has(k)) {
      seen.add(k);
      joinArms.push(t);
    }
  };
  const pushAnswer = (t: IrType): boolean => {
    if (t.kind === "void") return false;
    if (t.kind === "union") {
      const inner = lowerer.unions.get(t.unionId);
      if (!inner) return false;
      for (const a of inner.arms) push(a);
      return true;
    }
    push(t);
    return true;
  };
  for (const arm of def.arms) {
    if (isUnitType(arm)) {
      push(UNDEFINED_T);
      continue;
    }
    if (key.type.kind === "f64") {
      if (arm.kind !== "array" || !pushAnswer(arm.elem)) return null;
      continue;
    }
    if (arm.kind !== "record") return null;
    const shape = lowerer.shapes.get(arm.shapeId);
    if (!shape || shape.tuple) return null;
    const declared =
      literalField !== null ? shape.fields.find((f) => f.name === literalField)?.type : undefined;
    if (declared) {
      if (!pushAnswer(declared)) return null;
      continue;
    }
    // Runtime keys can reach the declared fields through the keyed-read
    // helper's string switch — every one joins.
    if (literalField === null) {
      for (const f of shape.fields) if (!pushAnswer(f.type)) return null;
    }
    if (!shape.indexValue) {
      if (literalField === null && shape.fields.length > 0) continue;
      return null;
    }
    if (!pushAnswer(shape.indexValue)) return null;
  }
  if (joinArms.length === 0) return null;
  // The join must satisfy native union invariants. The caller owns the
  // diagnostic when a container or opaque arm prevents that join.
  if (
    joinArms.length > 1 &&
    (!unionContainerArmsOk(joinArms) ||
      joinArms.some((a) => a.kind === "dyn" || a.kind === "generator" || a.kind === "caught"))
  ) {
    return null;
  }
  joinArms.sort((a, b) => (typeKey(a) < typeKey(b) ? -1 : 1));
  const type: IrType =
    joinArms.length === 1
      ? joinArms[0]!
      : { kind: "union", unionId: lowerer.unions.intern(joinArms) };
  // Pass 2: every arm's answer must SURFACE as the join, and index arms
  // must pass the single-record keyed-read constraints (the helper is
  // shared with recordKeyGet, its missing-key policy included).
  const surfaces = (t: IrType): boolean =>
    typeEquals(t, type) ||
    (type.kind === "union" && lowerer.armTag(type.unionId, t) >= 0) ||
    exactUnionWidening(lowerer, t, type);
  for (const arm of def.arms) {
    if (isUnitType(arm)) {
      if (!(type.kind === "union" && lowerer.armTag(type.unionId, UNDEFINED_T) >= 0)) return null;
      continue;
    }
    if (key.type.kind === "f64") {
      if (arm.kind !== "array" || !surfaces(arm.elem)) return null;
      continue;
    }
    if (arm.kind !== "record") return null;
    const shape = lowerer.shapes.get(arm.shapeId);
    if (!shape) return null;
    const declared =
      literalField !== null ? shape.fields.find((f) => f.name === literalField)?.type : undefined;
    if (declared) {
      if (!surfaces(declared)) return null;
      continue;
    }
    const ovfShape: IrRecordShape =
      literalField !== null && shape.indexValue ? { ...shape, fields: [] } : shape;
    if (!recordKeyResultOk(lowerer, ovfShape, type)) return null;
  }
  return { kind: "unionKeyGet", unionId, key, value, type, loc: locOf(expr) };
}

/** A structural TypeScript view does not change a nominal object's layout
 * or accessor dispatch. Resolve the property from the represented class;
 * the optional checker view must not turn its getter into a record read. */
export function classFieldTarget(
  lowerer: Lowerer,
  receiverNode: ts.Expression,
  receiverType: IrType & { kind: "object" },
  fieldName: string,
  saved?: IrExpr,
): FieldTarget | null {
  const represented = saved ?? lowerer.lowerExpr(receiverNode);
  if (
    represented.type.kind === "dyn" &&
    isJsSourceFile(ts.getSourceFileOfNode(receiverNode)) &&
    !fieldName.startsWith("#")
  ) {
    return { container: "dynamic", obj: represented, field: fieldName, fieldType: DYN };
  }
  const info = lowerer.classes.get(receiverType.className);
  if (!info) {
    // A receiver typed as a class whose collection deferred: the
    // deferred diagnostics are what explains the miss.
    lowerer.flushDeferredClass(receiverType.className);
    return null;
  }
  const fieldType = info.fields.get(fieldName);
  const lowerObjectReceiver = (): IrExpr => {
    let obj = represented;
    if (obj.type.kind === "union") {
      // A receiver that may hold a missing value (a field assigned an
      // unchecked read): Node's member-read TypeError for the unit arm.
      const present = lowerer.runtimeOptionalPropertyReceiver(
        receiverNode,
        obj,
        receiverType,
        fieldName,
      );
      if (present) return present;
      const helper = lowerer.narrowedArmHelper(obj.type.unionId, receiverType, locOf(receiverNode));
      obj = helper
        ? lowerer.checkedNarrowCall(helper, obj, receiverType, locOf(receiverNode))
        : lowerer.maybeNarrow(obj, receiverNode);
    }
    return lowerer.coerceInto(receiverNode, obj, receiverType);
  };
  if (fieldName === "cause" && receiverType.className !== "%DOMException") {
    let root = info;
    while (root.base) root = root.base;
    if (root.def.name === "%Error") {
      return {
        container: "errorCause",
        obj: lowerObjectReceiver(),
        field: "cause",
        fieldType: DYN,
      };
    }
  }
  if (fieldType) {
    const obj = lowerObjectReceiver();
    if (
      isJsSourceFile(ts.getSourceFileOfNode(receiverNode)) &&
      !fieldName.startsWith("#") &&
      [...lowerer.classes.values()].some(
        (candidate) =>
          lowerer.isSubclassOf(candidate.def.name, receiverType.className) &&
          (candidate.methods.has(`get:${fieldName}`) || candidate.methods.has(`set:${fieldName}`)),
      )
    ) {
      return {
        container: "dynamic",
        obj: lowerer.coerceToExpected(obj, DYN),
        field: fieldName,
        fieldType: DYN,
      };
    }
    return {
      container: "class",
      obj,
      className: receiverType.className,
      field: fieldName,
      fieldType,
    };
  }
  // Accessor property: either half declared anywhere on the chain
  // makes the name an accessor target (fields and accessors share a
  // namespace — tsc rejects mixing them, so the halves agree on kind).
  const getF = lowerer.findMethodOn(info, `get:${fieldName}`);
  const setF = lowerer.findMethodOn(info, `set:${fieldName}`);
  if (getF || setF) {
    const obj = lowerObjectReceiver();
    return {
      container: "accessor",
      obj,
      className: receiverType.className,
      field: fieldName,
      fieldType: getF ? getF.sig.ret : setF!.sig.params[0]!.type,
    };
  }
  if (info.decl && isJsSourceFile(ts.getSourceFileOfNode(info.decl))) {
    const property = lowerer.checker.getPropertyOfType(
      lowerer.checker.getTypeAtLocation(receiverNode),
      fieldName,
    );
    if (
      property &&
      property.declarations.some(
        (declaration) =>
          ts.isPropertyAccessExpression(declaration) ||
          ts.isBinaryExpression(declaration) ||
          ts.isElementAccessExpression(declaration),
      )
    ) {
      return {
        container: "dynamic",
        obj: lowerer.coerceToExpected(lowerObjectReceiver(), DYN),
        field: fieldName,
        fieldType: DYN,
      };
    }
  }
  return null;
}

/** Recognizes `obj.field` as an assignable field target: receiver is a
 * known class instance OR a record, and the member is a field or (class
 * receivers) a declared accessor property. Returns the pieces of a
 * fieldSet/recordSet/accessor-call (minus value/kind) or null. */
/** The checked-dynamic value `expr` reads: itself, or the value a checked
 * extraction validates. Null for other expressions. */
function checkedDynamicValue(expr: IrExpr): IrExpr | null {
  if (expr.type.kind === "dyn") return expr;
  return expr.kind === "dynCheck" && expr.value.type.kind === "dyn" ? expr.value : null;
}

export function fieldTarget(
  lowerer: Lowerer,
  access: ts.PropertyAccessExpression,
): FieldTarget | null {
  if (lowerer.cjsLocalModuleBindingOf(access.expression)) return null;
  // `module.exports` / `module.id`: CommonJS module surface, never a field.
  if (isCjsModuleGlobal(lowerer, access.expression)) return null;
  if (isCjsExportsIdentifier(lowerer, access.expression)) return null;
  if (lowerer.chainBlocked(access)) return null;
  if (
    access.name.text === "stackTraceLimit" &&
    lowerer.isStdlibGlobal(access.expression, "Error")
  ) {
    return {
      container: "errorStackLimit",
      obj: { kind: "numLit", value: 0, type: F64, loc: locOf(access) },
      field: "stackTraceLimit",
      fieldType: F64,
    };
  }
  // `this.#x` in a function-local class's prototype method: the field of
  // the brand-checked receiver (checkedPrivateReceiver).
  if (
    ts.isPrivateIdentifier(access.name) &&
    access.expression.kind === ts.SyntaxKind.ThisKeyword &&
    lowerer.resolveThis()?.type.kind === "dyn"
  ) {
    const owner = localPrivateBrandClass(lowerer, access.name);
    if (owner) {
      const ownerType: IrType & { kind: "object" } = {
        kind: "object",
        className: owner.info.def.name,
      };
      return classFieldTarget(lowerer, access.expression, ownerType, access.name.text);
    }
  }
  // `value.#x = v` on a checked-dynamic value: the field of the
  // brand-checked receiver (checkedPrivateValue).
  if (ts.isPrivateIdentifier(access.name)) {
    const owner = privateNameClass(lowerer, access.name);
    const probed = owner?.fields.has(access.name.text)
      ? tryLowerExpression(lowerer, access.expression)
      : null;
    if (owner && probed && checkedDynamicValue(probed)) {
      const receiver = checkedPrivateValue(
        lowerer,
        owner,
        access,
        checkedDynamicValue(lowerer.lowerExpr(access.expression))!,
        locOf(access),
      );
      return classFieldTarget(
        lowerer,
        access.expression,
        { kind: "object", className: owner.def.name },
        access.name.text,
        receiver,
      );
    }
  }
  const stored = ts.isIdentifier(access.expression)
    ? (lowerer.peekLocal(access.expression)?.type ?? lowerer.globalOf(access.expression)?.type)
    : undefined;
  const narrowed = lowerer.mapTypeOf(lowerer.typeOf(access.expression));
  // Structural record views retain their storage layout, while a nominal
  // subclass guard proves a more specific layout of the same object.
  const receiverIr =
    stored?.kind === "record"
      ? stored
      : stored?.kind === "object" &&
          !(
            narrowed?.kind === "object" &&
            lowerer.isSubclassOf(narrowed.className, stored.className)
          )
        ? stored
        : narrowed;
  if (receiverIr?.kind === "object") {
    const target = classFieldTarget(lowerer, access.expression, receiverIr, access.name.text);
    if (target) return target;
    // Abstract properties declare no base storage. Resolve the concrete
    // instance's live field or accessor through the existing class bridge;
    // inventing a shared field offset would misread subclass layouts.
    if (abstractPropertyDeclOf(lowerer, access)) {
      return {
        container: "dynamic",
        obj: lowerer.coerceInto(access.expression, lowerer.lowerExpr(access.expression), DYN),
        field: access.name.text,
        fieldType: lowerer.irTypeOf(access),
      };
    }
    return null;
  }
  if (receiverIr?.kind === "union" && hasClassPayload(lowerer, receiverIr)) {
    return representedClassFieldTarget(
      lowerer,
      access.expression,
      access.name.text,
      lowerer.lowerExpr(access.expression),
    );
  }
  if (receiverIr?.kind === "record") {
    const shape = lowerer.shapes.get(receiverIr.shapeId);
    const fieldType = shape?.fields.find((f) => f.name === access.name.text)?.type;
    if (fieldType) {
      let obj = lowerer.lowerExpr(access.expression);
      const nominal = representedClassFieldTarget(
        lowerer,
        access.expression,
        access.name.text,
        obj,
      );
      if (nominal) return nominal;
      // A checker-record receiver whose VALUE stayed dyn (the erased
      // all-unknown-fields cast — `(err as { code?: unknown }).code`):
      // decline, and the dyn keyed-read fallback answers.
      if (obj.type.kind === "union" && lowerer.armTag(obj.type.unionId, UNDEFINED_T) >= 0) {
        // A nested property read such as `rows[i].value` or
        // `table[k].value`: the outer read can miss. Validate the record
        // arm before fieldGet/recordGet so a missing outer value raises
        // Node's TypeError rather than reaching the backend with a union
        // receiver.
        const present = lowerer.stripUndefinedArm(obj.type);
        const parent = access.parent;
        const written =
          parent !== undefined &&
          ts.isBinaryExpression(parent) &&
          parent.left === access &&
          parent.operatorToken.kind === ts.SyntaxKind.EqualsToken;
        const helper =
          present.kind === "record"
            ? lowerer.narrowedArmHelper(obj.type.unionId, present, locOf(access.expression))
            : null;
        obj =
          (present.kind === "record"
            ? lowerer.runtimeOptionalPropertyReceiver(
                access.expression,
                obj,
                present,
                access.name.text,
                written ? "set" : "read",
              )
            : null) ??
          (helper
            ? lowerer.checkedNarrowCall(helper, obj, present, locOf(access.expression))
            : lowerer.maybeNarrow(obj, access.expression));
      }
      if (obj.type.kind !== "record") return null;
      const actualShape = lowerer.shapes.get(obj.type.shapeId);
      const actualField = actualShape?.fields.find((f) => f.name === access.name.text);
      return {
        container: "record",
        obj,
        shapeId: obj.type.shapeId,
        field: access.name.text,
        fieldType: actualField?.type ?? fieldType,
      };
    }
    // A RECORD accessor property: either slot present makes the name an
    // accessor target (get/set share the property namespace — tsc
    // rejects mixing an accessor with a data property, so the halves
    // agree). Reads dispatch the %get: closure, writes the %set: one.
    {
      const getSlot = shape?.fields.find((f) => f.name === `%get:${access.name.text}`)?.type;
      const setSlot = shape?.fields.find((f) => f.name === `%set:${access.name.text}`)?.type;
      if (getSlot?.kind === "func" || setSlot?.kind === "func") {
        const obj = lowerer.lowerExpr(access.expression);
        if (obj.type.kind !== "record") return null; // dyn-valued receiver: the keyed fallback answers
        const getType = getSlot?.kind === "func" ? getSlot : undefined;
        const setType = setSlot?.kind === "func" ? setSlot : undefined;
        return {
          container: "recordAccessor",
          obj,
          shapeId: receiverIr.shapeId,
          field: access.name.text,
          fieldType: getType ? getType.ret : setType!.params[0]!,
          ...(getType ? { getType } : {}),
          ...(setType ? { setType } : {}),
        };
      }
    }
    // Dot access to an UNDECLARED key of an index-signature shape: tsc
    // types it through the signature — the access resolves to NO property
    // symbol (mapped types like Record<string, T>) or to the signature's
    // own `__index` symbol (interface-declared signatures). A real member
    // symbol means a lib member like `toString` — not an index access;
    // those keep their fences below. It IS the bracket access in dot
    // spelling — the same overflow path.
    const nameSym = lowerer.checker.getSymbolAtLocation(access.name);
    if (shape?.indexValue && !shape.tuple) {
      // A member the shape CANONICALIZATION dropped into the overflow
      // (the header family: @types declares `host?: string` on
      // IncomingHttpHeaders while the canonical shape is a pure index
      // record) is the bracket access in dot spelling too: a PROPERTY
      // declaration whose own type fits within the index value. METHOD
      // members (`toString` — the lib's inherited surface) keep their
      // fences: JS finds the prototype function, never an overflow miss.
      const canonicalized = (): boolean => {
        if (!nameSym) return false;
        const nameDecls = nameSym.declarations;
        if (!nameDecls.length) return false;
        if (!nameDecls.every((d) => ts.isPropertySignature(d))) return false;
        const declared = lowerer.mapTypeOf(lowerer.typeOf(access));
        if (!declared) return false;
        const iv = shape.indexValue!;
        if (typeEquals(declared, iv)) return true;
        if (iv.kind !== "union") return false;
        const ivArms = lowerer.unions.get(iv.unionId)?.arms;
        if (!ivArms) return false;
        const declaredArms =
          declared.kind === "union"
            ? (lowerer.unions.get(declared.unionId)?.arms ?? [declared])
            : [declared];
        return declaredArms.every((a) => ivArms.some((b) => typeEquals(a, b)));
      };
      if (!nameSym || ts.symbolName(nameSym) === ts.InternalSymbolName.Index || canonicalized()) {
        let obj = lowerer.lowerExpr(access.expression);
        if (obj.type.kind === "union" && lowerer.armTag(obj.type.unionId, UNDEFINED_T) >= 0) {
          const present = lowerer.stripUndefinedArm(obj.type);
          obj =
            present.kind === "record"
              ? (lowerer.runtimeOptionalPropertyReceiver(
                  access.expression,
                  obj,
                  present,
                  access.name.text,
                ) ?? obj)
              : lowerer.maybeNarrow(obj, access.expression);
        }
        if (obj.type.kind !== "record") return null;
        const actualShape = lowerer.shapes.get(obj.type.shapeId);
        if (!actualShape?.indexValue) return null;
        return {
          container: "recordOvf",
          obj,
          shapeId: obj.type.shapeId,
          field: access.name.text,
          fieldType: actualShape.indexValue,
        };
      }
    }
    return null;
  }
  return null;
}

/** The read expression for a field target (fieldGet / recordGet /
 * getter call). `blame` locates the rejection of a setter-only read —
 * tsc-clean (the property types as the setter's param), but Node yields
 * undefined, which these property types cannot represent. */
export function fieldGetExpr(
  lowerer: Lowerer,
  target: FieldTarget,
  loc: SrcLoc,
  blame: ts.Node,
): IrExpr {
  // A member read through an unassigned deferred-init field throws Node's
  // member-read TypeError instead of the generic checked extraction.
  if (
    target.container === "class" &&
    ts.isPropertyAccessExpression(blame) &&
    target.obj.type.kind === "object" &&
    lowerer.deferredFieldSlot(target.obj) !== null
  ) {
    const checked = lowerer.runtimeOptionalPropertyReceiver(
      blame.expression,
      target.obj,
      target.obj.type,
      target.field,
    );
    if (checked) target = { ...target, obj: checked };
  }
  if (target.container === "recordKeyed") return keyedFieldRead(lowerer, target, loc);
  if (target.container === "dynamic")
    return lowerer.coerceInto(
      blame,
      {
        kind: "dynKeyGet",
        value: target.obj,
        key: { kind: "strLit", value: target.field, type: STRING, loc },
        type: DYN,
        loc,
      },
      target.fieldType,
    );
  if (
    target.container === "class" &&
    (target.field === "message" || target.field === "name") &&
    (target.className === "%Error" || lowerer.isSubclassOf(target.className, "%Error"))
  )
    return errorPropertyRead(lowerer, target.obj, target.field);
  if (target.container === "errorStackLimit") {
    return { kind: "libCall", fn: "error.stackLimitGet", args: [], type: F64, loc };
  }
  if (target.container === "errorCause") {
    return { kind: "libCall", fn: "error.cause", args: [target.obj], type: DYN, loc };
  }
  // A record-shaped CHECKER target whose receiver VALUE lives in the checked-dynamic tree
  // (a JS file-scope object-literal global): the checked-dynamic keyed
  // read — dynKeyGet (a missing key answers the dyn undefined, exactly
  // JS); consumers validate (dynCheck) where a static type is required.
  if (
    (target.container === "record" || target.container === "recordOvf") &&
    target.obj.type.kind === "dyn"
  ) {
    return {
      kind: "dynKeyGet",
      key: { kind: "strLit", value: target.field, type: STRING, loc },
      value: target.obj,
      type: DYN,
      loc,
    };
  }
  if (target.container === "accessor") {
    const getF = lowerer.findMethodOn(
      lowerer.classes.get(target.className) ?? null,
      `get:${target.field}`,
    );
    if (!getF) {
      lowerer.unsupported(
        "SC1090",
        blame,
        `reading a property that has only a setter ('${target.field}' — Node would yield undefined)`,
      );
    }
    if (
      !target.field.startsWith("#") &&
      isJsSourceFile(ts.getSourceFileOfNode(blame)) &&
      lowerer.dynConvertible(getF.sig.ret)
    ) {
      const value: IrExpr = {
        kind: "dynKeyGet",
        value: lowerer.coerceToExpected(target.obj, DYN),
        key: { kind: "strLit", value: target.field, type: STRING, loc },
        type: DYN,
        loc,
      };
      return lowerer.coerceToExpected(value, getF.sig.ret);
    }
    return lowerer.accessorCall(
      target.className,
      `get:${target.field}`,
      target.obj,
      [],
      getF.sig.ret,
      loc,
    );
  }
  // Record accessor properties: the read IS a call of the %get: closure
  // — once per read, side effects and all (JS's evaluation). The
  // setter-only read keeps the class-path fence: the property types as
  // the setter's param where Node yields undefined.
  if (target.container === "recordAccessor") {
    if (!target.getType) {
      lowerer.unsupported(
        "SC1090",
        blame,
        `reading a property that has only a setter ('${target.field}' — Node would yield undefined)`,
      );
    }
    const closure: IrExpr = {
      kind: "recordGet",
      obj: target.obj,
      shapeId: target.shapeId,
      field: `%get:${target.field}`,
      type: target.getType,
      loc,
    };
    return { kind: "callValue", callee: closure, args: [], type: target.getType.ret, loc };
  }
  // Overflow dot reads: exactly the bracket read with a literal key —
  // recordKeyGet, overflowOnly (the name declares no field by
  // construction), typed as the index value armed with undefined
  // (mirroring lowerRecordKeyRead).
  if (target.container === "recordOvf") {
    let obj = target.obj;
    if (obj.type.kind === "union" && ts.isPropertyAccessExpression(blame)) {
      const present = lowerer.stripUndefinedArm(obj.type);
      if (present.kind === "record") {
        obj =
          lowerer.runtimeOptionalPropertyReceiver(blame.expression, obj, present, target.field) ??
          obj;
      }
    }
    if (obj.type.kind !== "record") {
      lowerer.unsupported(
        "SC1090",
        blame,
        `reading '${target.field}' on a non-record receiver (narrow first)`,
      );
    }
    const shape = lowerer.shapes.get(obj.type.shapeId);
    if (!shape?.indexValue)
      lowerer.unsupported(
        "SC1090",
        blame,
        `reading '${target.field}' on a record without an index signature`,
      );
    let t: IrType = shape.indexValue;
    if (t.kind !== "dyn") {
      const armed = lowerer.withUndefinedArmOf(t);
      if (!armed) lowerer.badType(blame, lowerer.typeOf(blame));
      t = armed;
    }
    return {
      kind: "recordKeyGet",
      obj,
      shapeId: obj.type.shapeId,
      key: { kind: "strLit", value: target.field, type: STRING, loc },
      overflowOnly: true,
      type: t,
      loc,
    };
  }
  if (target.container === "class") {
    const read: IrExpr = {
      kind: "fieldGet",
      obj: target.obj,
      className: target.className,
      field: target.field,
      type: target.fieldType,
      loc,
    };
    // DEFERRED-INIT fields (`stream!: T` assigned past the constructor's
    // top level — ClassInfo.deferredInitFields): the SLOT is the
    // undefined-armed union; the read CHECKED-extracts the declared type
    // — a genuinely unassigned read throws the catchable TypeError
    // where Node reads an undefined the declared type cannot hold.
    if (
      lowerer.classes.get(target.className)?.deferredInitFields?.has(target.field) === true &&
      target.fieldType.kind === "union"
    ) {
      const inner = lowerer.stripUndefinedArm(target.fieldType);
      // Reference arms over a stable receiver check inline: the present
      // arm is a plain projection of the slot, so ordinary reads keep their
      // borrowed form and only an unassigned slot reaches the throw.
      const unionId = target.fieldType.unionId;
      const presentTag = lowerer.armTag(unionId, inner);
      const undefTag = lowerer.armTag(unionId, UNDEFINED_T);
      if (
        inner.kind === "object" &&
        presentTag >= 0 &&
        undefTag >= 0 &&
        lowerer.unions.get(unionId)?.arms.length === 2 &&
        isSafeToRepeat(read)
      ) {
        return {
          kind: "ternary",
          cond: {
            kind: "unionIsTag",
            unionId,
            tag: undefTag,
            negated: false,
            value: read,
            type: BOOL,
            loc,
          },
          then: nodeThrowExpr(1, "", DEFERRED_READ_MESSAGE, inner, loc),
          else_: { kind: "unionNarrow", unionId, tag: presentTag, value: read, type: inner, loc },
          type: inner,
          loc,
        };
      }
      const helper = lowerer.deferredReadHelper(target.fieldType.unionId, inner, loc);
      if (helper) return { kind: "call", callee: helper, args: [read], type: inner, loc };
    }
    return read;
  }
  return {
    kind: "recordGet",
    obj: target.obj,
    shapeId: target.shapeId,
    field: target.field,
    type: target.fieldType,
    loc,
  };
}

/** Stream-rooted receivers' property surface (readableEnded, destroyed,
 * ...): the receiver's mapped class dispatches into lower-stream.ts.
 * Null off the stream hierarchy or for names the spoke does not own. */
function lowerStreamObjectProperty(
  lowerer: Lowerer,
  expr: ts.PropertyAccessExpression,
): IrExpr | null {
  if (expr.questionDotToken && !lowerer.chainHandled.has(expr)) return null;
  const valueStream = lowerValueStreamProperty(lowerer, expr);
  if (valueStream) return valueStream;
  const recvT = lowerer.mapTypeOf(lowerer.typeOf(expr.expression));
  if (recvT?.kind !== "object") return null;
  const info = lowerer.classes.get(recvT.className);
  if (!info || streamSidesOf(lowerer, info) === null) return null;
  if (expr.name.text === "bytesWritten" && isZlibStreamMember(lowerer, expr)) {
    return lowerZlibStreamBytesWritten(lowerer, expr);
  }
  if (isFsStreamMember(lowerer, expr)) {
    const member = lowerFsStreamProperty(lowerer, expr);
    if (member) return member;
  }
  return lowerStreamProperty(lowerer, expr, info);
}

/** The error constructors among GLOBAL_CONSTRUCTOR_VALUES. Their statics
 * (`Error.stackTraceLimit`, `Error.captureStackTrace`) keep their own
 * lowerings, so fenceBuiltinConstructorStaticRead leaves them alone. */
const ERROR_CONSTRUCTOR_VALUES: ReadonlySet<string> = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "EvalError",
  "URIError",
  "AggregateError",
]);

/** The builtin constructors JavaScript sources read as real function
 * values rather than identity tokens: the runtime interns one function per
 * constructor, and dynamic values answer `.constructor` with the same one,
 * so `o.constructor === Object` and `err.constructor === TypeError` are
 * exact identity tests, and `err.constructor.name` is the constructor's
 * name. */
const GLOBAL_CONSTRUCTOR_VALUES: ReadonlySet<string> = new Set([
  "Object",
  "Function",
  "Date",
  "RegExp",
  "Map",
  "Set",
  "Promise",
  "WeakMap",
  "WeakSet",
  "FinalizationRegistry",
  ...ERROR_CONSTRUCTOR_VALUES,
]);

/** The builtin global functions JavaScript sources read as interned
 * function values (the `cond ? setImmediate : process.nextTick` feature
 * probe of bcryptjs and async libraries): typeof answers "function",
 * identity holds across spellings, and calls run the timer APIs. */
const GLOBAL_FUNCTION_VALUES: ReadonlySet<string> = new Set([
  "setTimeout",
  "setInterval",
  "setImmediate",
  "clearTimeout",
  "clearInterval",
  "clearImmediate",
  "queueMicrotask",
]);

/** A builtin function value: one interned runtime function per name. */
export function builtinFunctionValue(name: string, loc: SrcLoc): IrExpr {
  return {
    kind: "libCall",
    fn: "dyn.builtinFunction",
    args: [{ kind: "strLit", value: name, type: STRING, loc }],
    type: DYN,
    loc,
  };
}

/** The value a source reads for the stdlib global `canonical` (builtin
 * constructors in both languages, builtin functions in JavaScript), or
 * null when it stays an identity token (JavaScript) or fenced. */
export function builtinGlobalValue(canonical: string, loc: SrcLoc, js = false): IrExpr | null {
  if (js && GLOBAL_FUNCTION_VALUES.has(canonical)) return builtinFunctionValue(canonical, loc);
  if (js && canonical === "Buffer")
    return { kind: "libCall", fn: "buffer.constructor", args: [], type: DYN, loc };
  if (GLOBAL_CONSTRUCTOR_VALUES.has(canonical)) {
    return {
      kind: "libCall",
      fn: "dyn.globalConstructor",
      args: [{ kind: "strLit", value: canonical, type: STRING, loc }],
      type: DYN,
      loc,
    };
  }
  return null;
}

/** The members the interned builtin function values model (the runtime
 * answers each one as Node does); any other member read through them would
 * answer undefined, so it keeps its static lowering or its fence. */
const BUILTIN_VALUE_MEMBERS: ReadonlySet<string> = new Set(["name", "length", "constructor"]);

/** The Object statics whose answers for an interned builtin function value
 * match Node's (identity, the empty enumerable own-key lists, and
 * extensibility: freezing, sealing and preventExtensions are fenced, so the
 * values stay extensible). */
const BUILTIN_VALUE_REFLECTION: ReadonlySet<string> = new Set([
  "is",
  "keys",
  "values",
  "entries",
  "isExtensible",
  "isFrozen",
  "isSealed",
]);

/** The value `builtinGlobalValue` gives the stdlib global `expr` read at its
 * use site: null when the use reads the global's members (they keep their
 * lowerings and fences), and SC2020 when it is the target of reflection or
 * redefinition (`Object.hasOwn(Object, "hasOwn")`,
 * `Object.defineProperty(Promise, ...)`, `hasOwnProperty.call(Map, ...)`),
 * which would observe or change members the interned value does not
 * model. */
export function builtinGlobalValueAt(
  lowerer: Lowerer,
  expr: ts.Expression,
  canonical: string,
  loc: SrcLoc,
  js: boolean,
): IrExpr | null {
  if (readsBuiltinGlobalMembers(expr)) return null;
  const value = builtinGlobalValue(canonical, loc, js);
  if (value === null) return null;
  let node: ts.Node = expr;
  while (node.parent !== undefined && ts.isParenthesizedExpression(node.parent)) node = node.parent;
  const call = node.parent;
  if (
    call !== undefined &&
    ts.isCallExpression(call) &&
    call.expression !== node &&
    ts.isPropertyAccessExpression(call.expression)
  ) {
    const callee = call.expression;
    const owner = stdlibGlobalNameOf(lowerer, callee.expression);
    const reflects =
      owner === "Reflect" ||
      (owner === "Object" && !BUILTIN_VALUE_REFLECTION.has(callee.name.text)) ||
      ((callee.name.text === "call" || callee.name.text === "apply") &&
        call.arguments.nodes[0] === node &&
        lowerer.isStdlibSymbol(
          lowerer.checker.getSymbolAtLocation(
            ts.isPropertyAccessExpression(callee.expression)
              ? callee.expression.name
              : callee.expression,
          ),
        ));
    if (reflects) {
      const name =
        owner !== null
          ? `${owner}.${callee.name.text}`
          : ts.getTextOfNode(callee).replace(/\s+/g, "");
      lowerer.noLowering(
        `${name}(${canonical}, ...)`,
        expr,
        "builtin constructor and function values model only name, length and constructor, so reflecting on or redefining their members has no lowering",
      );
    }
  }
  return value;
}

/** Whether the stdlib global `expr` is read for its members (`Map.prototype`,
 * `Date["UTC"]`, `"prototype" in Map`) rather than as a value. Those reads
 * keep the global's member lowerings and fences: its interned function value
 * models only BUILTIN_VALUE_MEMBERS. */
function readsBuiltinGlobalMembers(expr: ts.Expression): boolean {
  let node: ts.Node = expr;
  while (node.parent !== undefined && ts.isParenthesizedExpression(node.parent)) node = node.parent;
  const parent = node.parent;
  if (parent === undefined) return false;
  if (ts.isPropertyAccessExpression(parent) && parent.expression === node)
    return !BUILTIN_VALUE_MEMBERS.has(parent.name.text);
  if (ts.isElementAccessExpression(parent) && parent.expression === node) return true;
  return (
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.InKeyword &&
    parent.right === node
  );
}

/** Reports SC2020 when `access` reads a stdlib static member or the
 * prototype of a builtin constructor with an interned function value through
 * a receiver the checker types as the constructor's static side
 * (`MapConstructor`); null otherwise. Calls that lower statically never
 * reach the member read. */
function fenceBuiltinConstructorStaticRead(
  lowerer: Lowerer,
  access: ts.PropertyAccessExpression,
): null {
  if (BUILTIN_VALUE_MEMBERS.has(access.name.text)) return null;
  const symbol = lowerer.typeOf(access.expression).getSymbol();
  if (
    symbol !== undefined &&
    ts.symbolName(symbol).endsWith("Constructor") &&
    GLOBAL_CONSTRUCTOR_VALUES.has(ts.symbolName(symbol).slice(0, -"Constructor".length)) &&
    !ERROR_CONSTRUCTOR_VALUES.has(ts.symbolName(symbol).slice(0, -"Constructor".length)) &&
    lowerer.isStdlibSymbol(symbol)
  )
    lowerer.stdlibMemberFence(access);
  return null;
}

/** The Buffer statics the Buffer function's value holds
 * (scr_buffer_constructor_value). */
const BUFFER_VALUE_STATICS: ReadonlySet<string> = new Set([
  "from",
  "copyBytesFrom",
  "of",
  "alloc",
  "allocUnsafe",
  "allocUnsafeSlow",
  "isBuffer",
  "compare",
  "isEncoding",
  "concat",
  "byteLength",
]);

/** Object.prototype members a plain record inherits, read as values. */
const OBJECT_PROTOTYPE_VALUE_READS: ReadonlySet<string> = new Set([
  "constructor",
  "valueOf",
  "toString",
  "hasOwnProperty",
  "propertyIsEnumerable",
]);

/** Whether `expr` is the callee of a call (`o.toString()`), which keeps its
 * call lowering rather than reading the member as a value. */
function isCalleeOf(expr: ts.PropertyAccessExpression): boolean {
  let node: ts.Node = expr;
  while (node.parent !== undefined && ts.isParenthesizedExpression(node.parent)) node = node.parent;
  const parent = node.parent;
  return (
    parent !== undefined &&
    (ts.isCallExpression(parent) || ts.isNewExpression(parent)) &&
    parent.expression === node
  );
}

/** The constructor a primitive dynamic value answers for `.constructor`:
 * the same interned closure the `Number`/`String`/`Boolean`/`BigInt`
 * identifiers read (dequal's `(ctor = foo.constructor) === bar.constructor`
 * over numbers), or `otherwise` for non-primitives. `value` must be safe to
 * read repeatedly. */
export function primitiveConstructorOr(
  lowerer: Lowerer,
  value: IrExpr,
  otherwise: IrExpr,
  loc: SrcLoc,
): IrExpr {
  let result = otherwise;
  for (const [test, name] of [
    ["bigint", "BigInt"],
    ["boolean", "Boolean"],
    ["string", "String"],
    ["number", "Number"],
  ] as const) {
    result = {
      kind: "ternary",
      cond: { kind: "dynTest", test, value, type: BOOL, loc },
      then: {
        kind: "dynFrom",
        value: primitiveCtorClosure(lowerer, name, loc, true),
        type: DYN,
        loc,
      },
      else_: result,
      type: DYN,
      loc,
    };
  }
  return result;
}

/** True when `access` reads a member that JavaScript sources attach to a
 * function by assignment (`fn.member = value`): the receiver's type is
 * callable and every declaration of the member is such an assignment in a
 * JS file. */
function jsFunctionExpandoMember(lowerer: Lowerer, access: ts.PropertyAccessExpression): boolean {
  if (access.questionDotToken || !ts.isIdentifier(access.name)) return false;
  const recvType = lowerer.typeOf(access.expression);
  if (lowerer.checker.getCallSignatures(recvType).length === 0) return false;
  const member = lowerer.checker.getPropertyOfType(recvType, access.name.text);
  const decls = member ? member.declarations : [];
  return (
    decls.length > 0 &&
    decls.every((d) => {
      if (!isJsSourceFile(ts.getSourceFileOfNode(d))) return false;
      const assign = ts.isBinaryExpression(d) ? d : d.parent;
      return (
        assign !== undefined &&
        ts.isBinaryExpression(assign) &&
        assign.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isPropertyAccessExpression(assign.left)
      );
    })
  );
}

/** Whether the checker declares `name` as a property of `receiver`'s type
 * (as opposed to reading it through an index signature). */
export function declaredMemberOf(lowerer: Lowerer, receiver: ts.Expression, name: string): boolean {
  const symbol = lowerer.checker.getPropertyOfType(lowerer.typeOf(receiver), name);
  return !!symbol && symbol.declarations.length > 0;
}

/** Whether `expr` reads Promise.prototype, directly or as
 * `promise.constructor.prototype`. The checker types it Promise<any>, but
 * the value is an ordinary object, so a binding inferred from it stays
 * checked-dynamic (as in Node, promise methods called on it throw). */
export function isPromisePrototypeRead(lowerer: Lowerer, expr: ts.Expression | undefined): boolean {
  if (!expr) return false;
  while (ts.isParenthesizedExpression(expr)) expr = expr.expression;
  if (!ts.isPropertyAccessExpression(expr) || expr.questionDotToken) return false;
  if (expr.name.text !== "prototype") return false;
  if (lowerer.stdlibGlobalMember(expr, "Promise") === "prototype") return true;
  const inner = expr.expression;
  return (
    ts.isPropertyAccessExpression(inner) &&
    !inner.questionDotToken &&
    inner.name.text === "constructor" &&
    lowerer.mapTypeOf(lowerer.typeOf(inner.expression))?.kind === "promise"
  );
}

/** A promise's `constructor` (the Promise constructor value), and
 * Promise.prototype read as `promise.constructor.prototype` or
 * `Promise.prototype` (execa's `(async () => {})().constructor.prototype`):
 * an object holding the runtime's then, catch and finally (thenables.ts).
 * Null for other reads. */
function lowerPromiseConstructorRead(
  lowerer: Lowerer,
  expr: ts.PropertyAccessExpression,
): IrExpr | null {
  if (expr.questionDotToken) return null;
  const loc = locOf(expr);
  const isPromise = (node: ts.Expression): boolean =>
    lowerer.mapTypeOf(lowerer.typeOf(node))?.kind === "promise";
  if (expr.name.text === "prototype") {
    if (lowerer.stdlibGlobalMember(expr, "Promise") === "prototype")
      return promisePrototypeValue(lowerer, loc);
    const inner = expr.expression;
    if (
      ts.isPropertyAccessExpression(inner) &&
      !inner.questionDotToken &&
      inner.name.text === "constructor" &&
      isPromise(inner.expression)
    ) {
      const receiver = lowerer.lowerExpr(inner.expression);
      const prototype = promisePrototypeValue(lowerer, loc);
      return isSafeToDiscard(receiver)
        ? prototype
        : {
            kind: "seqExpr",
            stmts: [{ kind: "exprStmt", expr: receiver, loc }],
            result: prototype,
            type: DYN,
            loc,
          };
    }
    return null;
  }
  if (expr.name.text === "constructor" && isPromise(expr.expression)) {
    const receiver = lowerer.lowerExpr(expr.expression);
    const ctor = builtinGlobalValue("Promise", loc)!;
    return isSafeToDiscard(receiver)
      ? ctor
      : {
          kind: "seqExpr",
          stmts: [{ kind: "exprStmt", expr: receiver, loc }],
          result: ctor,
          type: DYN,
          loc,
        };
  }
  return null;
}

/** Whether a named function expression refers to itself by name in its
 * body (a recursive call, or the function escaping under its own name). */
function referencesOwnName(lowerer: Lowerer, fn: ts.Node): boolean {
  if (!ts.isFunctionExpression(fn) || fn.name === undefined || fn.body === undefined) return false;
  const self = lowerer.checker.getSymbolAtLocation(fn.name);
  if (self === undefined) return false;
  const name = fn.name.text;
  let found = false;
  ts.walkPreorder(fn.body, (node) => {
    if (found) return "stop";
    if (
      ts.isIdentifier(node) &&
      node.text === name &&
      lowerer.checker.getSymbolAtLocation(node) === self
    )
      found = true;
    return undefined;
  });
  return found;
}

/** The argument count every caller passes a function expression whose
 * value flows into one fixed-arity function type, an array method's
 * callback or an annotated slot: that type's parameter count. Null when
 * there is no such type or its arity varies. */
function contextualArgumentCount(lowerer: Lowerer, fn: ts.Node): number | null {
  if (!ts.isFunctionExpression(fn)) return null;
  const contextual = lowerer.checker.getContextualType(fn);
  if (contextual === undefined) return null;
  const signatures = lowerer.checker.getCallSignatures(
    lowerer.checker.getNonNullableType(contextual),
  );
  if (signatures.length !== 1) return null;
  const declaration = signatures[0]!.declaration;
  if (declaration === undefined) return null;
  let count = 0;
  for (const parameter of (declaration.parameters?.nodes ?? []) as ts.ParameterDeclaration[]) {
    if (isThisParameter(parameter)) continue;
    if (parameter.questionToken || parameter.initializer || parameter.dotDotDotToken) return null;
    count++;
  }
  return count;
}

/** The property names the program assigns on the global object, through
 * `globalThis` or a binding of its type (`(_a = globalThis).x = v`). */
function globalThisWrittenNames(lowerer: Lowerer, globalType: ts.Type): Set<string> {
  const known = lowerer.globalThisWrittenNames;
  if (known) return known;
  const names = new Set<string>();
  lowerer.globalThisWrittenNames = names;
  for (const sf of lowerer.program.getImplementationSourceFiles()) {
    if (sf.isDeclarationFile || !sf.text.includes("globalThis")) continue;
    ts.walkPreorder(sf, (node) => {
      if (
        ts.isBinaryExpression(node) &&
        (node.operatorToken.kind === ts.SyntaxKind.EqualsToken ||
          node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionEqualsToken ||
          node.operatorToken.kind === ts.SyntaxKind.BarBarEqualsToken ||
          node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandEqualsToken) &&
        ts.isPropertyAccessExpression(node.left) &&
        lowerer.typeOf(node.left.expression) === globalType
      )
        names.add(node.left.name.text);
      return undefined;
    });
  }
  return names;
}
