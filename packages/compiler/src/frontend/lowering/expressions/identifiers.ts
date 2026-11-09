/* Identifier references in expression position: lowerExprInner's identifier branch and its helpers. */
import { isJsIteratorGlobal, iteratorConstructorExpr } from "../iterator-prototype.js";
import { globalMemberValue, tsUntypedGlobalValue } from "../global-values.js";
import { hostGlobalCallTarget, hostGlobalNameOfIdentifier } from "../host-globals.js";
import { hostGlobalValue } from "../host-global-values.js";
import { predeclareForwardClass } from "../lower-stmts.js";
import { cjsMemberAliasValueOf } from "../cjs-exports-object.js";
import { builtinClassValue, builtinMemberClassKind } from "../builtins/builtin-class-dyn.js";
import { legacyUrlClassValue } from "../builtins/url.js";
import { lowerWebStreamClassRead } from "../builtins/web-streams-dyn.js";
import * as ts from "../../ts7/adapter.js";
import { globalFunctionValue } from "../global-function-values.js";
import * as posix from "node:path/posix";
import { type Lowerer, PoisonError } from "../lowerer.js";
import {
  BIGINT_BYTES_NAMES,
  BOOL,
  BYTES_ELEMENT_NAME,
  DATE_T,
  DYN,
  F64,
  type IrExpr,
  type IrLocal,
  type IrType,
  STRING,
  type SrcLoc,
  UNDEFINED_T,
  arrayOf,
  funcOf,
  isUnitType,
  recordTextCodecClass,
  typeEquals,
} from "../../../ir/ir.js";
import { lowerNodeModuleIdentifier } from "../lower-node-module.js";
import { createRequireLoaderValue } from "../builtins/module-resolution.js";
import { lowerCjsExportsObjectValue } from "../cjs-exports-object.js";
import {
  cjsNestedExportReplacementOf,
  splitRequireBindingOfIdent,
  wholeExportSymbolOfModule,
  wholeExportValue,
  wholeExportValueOfModuleBinding,
} from "../cjs-inline-require.js";
import { captureContextArguments } from "../function-context.js";
import {
  argumentsOwner,
  forwardedOnlyTupleValue,
  typedArgumentsCandidate,
} from "../typed-arguments.js";
import { argumentCountValue } from "../argument-counts.js";
import {
  isCjsExportTableLiteral,
  isCjsJsFile,
  isJsSourceFile,
  isNodeEsmFile,
  locOf,
} from "../../program.js";
import { builtinClassAliasOwnsNoSlot, runtimeClassValueOf } from "../builtins/class-values.js";
import {
  cjsAccessorCall,
  cjsAccessorSnapshotOf,
  cjsImportedDataSnapshotOf,
  isArrayIterationCallback,
  primitiveConversionCallback,
  primitiveCtorValue,
  runtimeOptionalElementKey,
  runtimeOptionalUseOf,
} from "../lower-exprs.js";
import { runtimeOptionalReceiverRead } from "./narrowing.js";
import { requiredLibraryCallbackRead } from "./library-callbacks.js";
import { iterableUnionOf } from "../iterable-values.js";
import { builtinGlobalValueAt } from "./property-access.js";
import { varRef } from "../../../ir/build.js";
import {
  ambientUndefReadType,
  ambientUndefinedFnSymbolOf,
  ambientUndefinedVarSymbolOf,
  contextualUndefReadType,
  fenceEarlyAliasUse,
  isNodeUndefinedGlobalRoot,
  cjsNamespaceImportDep,
  lowerNsIdentifierValue,
  nsUndefRead,
} from "../lower-namespaces.js";
import { lowerFunduleMemberRead } from "../lower-fundule.js";
import {
  blockedBindingUseDiag,
  unsupportedDiag,
  unsupportedPackageValueDiag,
} from "../../../diagnostics/diagnostic.js";
import { dirname } from "node:path";
import { packageDirOf } from "../../../node-islands/origin.js";
import { funcTypeFromParamShapes } from "../call-signatures.js";
import { threadsImportOf } from "../../threads-import.js";
import { nodeApiBindingOf } from "../../node-api-import.js";
import { experimentalImportOf } from "../../experimental-import.js";
import { lowerWorkerMetadata } from "../builtins/workers.js";
import { esmImportBindingKind } from "../builtins/module-bindings.js";
import {
  builtinConstLit,
  builtinFenceHintOf,
  builtinModuleConstOf,
  builtinModuleFnOf,
  builtinModulesArrayLit,
  identifierReadSymbol,
  stdlibGlobalNameOf,
} from "../surfaces.js";
import {
  builtinConstantsEsmNamespace,
  builtinConstantsObject,
  pathModuleValue,
} from "../lower-builtin-values.js";
import { lowerTlsRootCertificates } from "../lower-server.js";
import { unloweredGlobalValue, unloweredModuleMemberValue } from "../node-value-reads.js";
import { unsupportedModuleFeatureOf } from "../../builtin-modules.js";
import { lowerGlobalValue } from "../lower-global-value.js";
import { lowerEnumObjectValue } from "../enum-objects.js";
import { mixinFnOfCallee } from "../lower-mixins.js";
import { isNavigatorGlobal, navigatorValue } from "../builtins/navigator.js";
import { moduleFileName } from "../import-meta.js";
import { envSnapshotHelper, heldEnvValueType } from "../builtins/environment.js";
import { processDataMemberValue } from "../builtins/process.js";
import { adoptingResolveUse } from "../promise-resolution.js";

/** Whether this identifier is the RECEIVER of a member access — the dotted
 * or bracketed `held.X` / `held[k]`, read or written, through any erasure
 * wrapper. Those uses answer through the live environment table themselves
 * (heldEnvValueType); every other use of a held value is a bare one and
 * reads the environment as it is at that site. */
function memberReceiverUse(expr: ts.Identifier): boolean {
  let node: ts.Node = expr;
  for (;;) {
    const parent: ts.Node | undefined = node.parent;
    if (parent === undefined) return false;
    if (
      ts.isParenthesizedExpression(parent) ||
      ts.isAsExpression(parent) ||
      ts.isNonNullExpression(parent) ||
      ts.isSatisfiesExpression(parent)
    ) {
      node = parent;
      continue;
    }
    return (
      (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
      parent.expression === node
    );
  }
}

/** A JavaScript binding with checked-dynamic storage because the program
 * stores values outside its declared type (analyzeJsWidenedBindings): the
 * checker's narrowing at a read does not describe the stored value. */
function isJsWidenedBinding(lowerer: Lowerer, expr: ts.Identifier): boolean {
  if (lowerer.jsWidenedBindings.size === 0) return false;
  const symbol = lowerer.resolveValueSymbol(expr);
  return symbol !== null && symbol !== undefined && lowerer.jsWidenedBindings.has(symbol);
}

export function lowerIdentifierExpr(lowerer: Lowerer, expr: ts.Identifier, loc: SrcLoc): IrExpr {
  if (lowerer.isStdlibGlobal(expr, "console")) {
    return { kind: "libCall", fn: "console.native", args: [], type: DYN, loc };
  }

  // A createRequire loader as a VALUE (not the callee of a lowered call or
  // a resolve read, which their own lowerings own): a run-time require
  // function over the runtime resolver. Checked before the node:module
  // identifier fold, which would otherwise read the destructured factory
  // binding as the function value that refuses when it is called.
  const createRequireValue = createRequireLoaderValue(lowerer, expr, loc);
  if (createRequireValue !== null) return createRequireValue;

  const moduleValue = lowerNodeModuleIdentifier(lowerer, expr);
  if (moduleValue) return moduleValue;
  if (expr.text === "exports") {
    const exportsValue = lowerCjsExportsObjectValue(lowerer, expr);
    if (exportsValue) return exportsValue;
  }
  if (lowerer.isSelfReference(expr)) {
    return { kind: "selfRef", type: lowerer.ctx.selfType!, loc };
  }
  // `arguments` in a variadic JS function (the rest-marked form): the
  // synthetic trailing dyn-array param — lambdaSignature marked the
  // type and lowerLambda declared the local.
  if (expr.text === "arguments") {
    const binding = captureContextArguments(lowerer.fnStack);
    // A forwarded-only `arguments` read as a value after all (a call path
    // that takes its spread operand as a list): the tuple is built here
    // from its slots (typed-arguments.ts forwardedOnlyTupleValue).
    const forwardedSlots = binding ? lowerer.ctx.pureTuples.get(binding.id) : undefined;
    if (binding && forwardedSlots) {
      // A position that may be undefined, or holds an untyped value, may
      // also be absent at the call: the native signature always passes it,
      // so the tuple built from the slots would hand the callee an argument
      // the caller did not pass (a rest parameter one element longer). The
      // rest tuple with optional positions is refused the same way
      // (forwardedOnlyTupleValue), and so is `arguments.length`
      // (typedArgumentsArity).
      if (
        forwardedSlots.some(
          (slot) =>
            slot.type.kind === "dyn" ||
            (slot.type.kind === "union" &&
              lowerer.armTag(slot.type.unionId, { kind: "undefinedT" }) >= 0),
        )
      ) {
        lowerer.unsupported(
          "SC1090",
          expr,
          "'arguments' with positions that may be omitted, used other than forwarded into a call of a program function with one signature (its length varies per call, so it has no tuple value to pass on)",
        );
      }
      return lowerer.tupleOfSlots(forwardedSlots, binding.type, expr, loc);
    }
    if (binding) return { kind: "varRef", localId: binding.id, type: binding.type, loc };
    const owner = argumentsOwner(expr);
    if (owner && typedArgumentsCandidate(owner)) {
      lowerer.unsupported(
        "SC1090",
        expr,
        "'arguments' in a function expression whose value is not asserted to one fixed-arity signature (assert it, as in `function () { … } as F`, and the function lowers against that signature)",
      );
    }
  }
  // A read of a Node 24 global the native runtime does not implement
  // (WebSocket, FormData, …) answers the constructor Node has
  // (host-global-values.ts); constructing or calling it is the use that
  // refuses (SC2020, host-global). Imports, locals and program
  // declarations of the same name are the program's own bindings and
  // never reach here.
  {
    const hostGlobal = hostGlobalNameOfIdentifier(lowerer, expr);
    if (hostGlobal !== null) {
      if (hostGlobalCallTarget(expr)) lowerer.hostGlobalFence(hostGlobal, expr);
      return hostGlobalValue(lowerer, hostGlobal, expr);
    }
  }
  // A compiler-projected adapter as a VALUE: the adapter has no
  // runtime function object (its calls rewrite directly) — call it
  // through its immutable binding instead.
  {
    const sym = lowerer.resolveValueSymbol(expr);
    const projection = sym ? lowerer.staticCallables.get(sym) : undefined;
    if (
      projection?.kind === "promisified-exec-file" ||
      projection?.kind === "promisified-exec" ||
      projection?.kind === "promisified-builtin" ||
      projection?.kind === "promisified-zlib" ||
      projection?.kind === "promisified-crypto" ||
      projection?.kind === "promisified-dns"
    ) {
      lowerer.unsupported(
        "SC1090",
        expr,
        `a promisified builtin as a value (call '${expr.text}' directly)`,
      );
    }
    if (projection?.kind === "client-function") {
      // The client-function lowering works per call site (the module's
      // protocol and secure defaults); there is no function object to read.
      lowerer.unsupported(
        "SC1090",
        expr,
        `an http client function alias as an escaping value (call '${expr.text}' directly)`,
      );
    }
    if (projection?.kind === "builtin-function") {
      if (!isJsSourceFile(ts.getSourceFileOfNode(expr))) {
        const callable = lowerer.lowerBuiltinCallableValue(
          { module: projection.module, member: projection.member },
          loc,
        );
        if (callable) return callable;
      }
      lowerer.unsupported(
        "SC1090",
        expr,
        `a builtin function alias as an escaping value (call '${expr.text}' directly)`,
      );
    }
    // `EventEmitter`, `Readable` or `TypeError` (or a const alias of
    // one) as a value in a TypeScript file: the runtime class's class
    // object. JavaScript files read the runtime's untyped constructor or
    // the function value their own rule answers (node-value-reads.ts).
    if (!isJsSourceFile(ts.getSourceFileOfNode(expr))) {
      const runtimeClass = runtimeClassValueOf(lowerer, expr);
      if (runtimeClass) return lowerer.classValueRef(runtimeClass, expr);
    }
    // `const E = EventEmitter` owns no runtime slot: construction,
    // instanceof, typeof and .name lower at their use sites.
    if (sym && builtinClassAliasOwnsNoSlot(lowerer, sym)) {
      lowerer.unsupported(
        "SC1090",
        expr,
        `a builtin class alias as an escaping value (use '${expr.text}' with new, instanceof, typeof or .name)`,
      );
    }
  }
  // A forwarded-only rest tuple read as a value after all.
  const forwardedTuple = forwardedOnlyTupleValue(lowerer, expr, loc);
  if (forwardedTuple) return forwardedTuple;
  // Union-typed bindings read through tsc's control-flow narrowing:
  // when the checker types this USE as a single arm, maybeNarrow
  // bridges the tagged representation with a unionNarrow.
  const local = lowerer.resolveLocal(expr);
  // The resolve parameter of a typed promise's executor, at a use that gives
  // it a value with a promise arm: the function that adopts that arm.
  if (local && lowerer.adoptingResolves.size > 0) {
    const adopting = adoptingResolveUse(lowerer, expr, {
      kind: "varRef",
      localId: local.id,
      type: local.type,
      loc,
    });
    if (adopting) return adopting;
  }
  // A BARE use of a value HELD from process.env (`{ ...env }`, Object.keys,
  // an argument, a return) reads the environment as it is HERE: Node's hold
  // IS the environment object, so its contents at use time are the live
  // table's. Member accesses (`env.X`, `env[k]`, their writes) reroute to
  // getenv/setenv directly (heldEnvValueType) and never come through a bare
  // read, so they materialize no snapshot; every other use takes a fresh
  // one at this site instead of the copy the hold was given.
  {
    const mapped = lowerer.mapTypeOf(lowerer.typeOf(expr));
    if (
      mapped?.kind === "record" &&
      !memberReceiverUse(expr) &&
      heldEnvValueType(lowerer, expr) !== null
    ) {
      const helper = envSnapshotHelper(lowerer, mapped.shapeId, loc);
      if (helper !== null) return { kind: "call", callee: helper, args: [], type: mapped, loc };
    }
  }
  {
    const slot = local ?? lowerer.globalOf(expr);
    const closureRead = slot ? closureDynRead(lowerer, expr, slot.id, slot.type, loc) : null;
    if (closureRead) return closureRead;
  }
  // A Date local holding its time value reads as that Date: only uses
  // that read the time value reach here (date-values.ts).
  if (local && lowerer.timeValueDateLocals.has(local)) {
    const time: IrExpr = { kind: "varRef", localId: local.id, type: F64, loc };
    return { kind: "libCall", fn: "date.fromTime", args: [time], type: DATE_T, loc };
  }
  if (local) {
    // A switch can dispatch past a lexical declaration. Keep this
    // previously refused codec form out until switch-scope TDZ boxes
    // model that skipped initialization, including value aliases.
    if (
      local.type.kind === "record" &&
      recordTextCodecClass(lowerer.shapes.get(local.type.shapeId)!) !== null
    ) {
      const symbol = lowerer.resolveValueSymbol(expr);
      const decl = symbol ? symbol.valueDeclaration : undefined;
      if (
        decl &&
        ts.isVariableDeclaration(decl) &&
        ts.isVariableDeclarationList(decl.parent) &&
        (decl.parent.flags & ts.NodeFlags.BlockScoped) !== 0 &&
        ts.isVariableStatement(decl.parent.parent)
      ) {
        const clause = decl.parent.parent.parent;
        if (
          (ts.isCaseClause(clause) || ts.isDefaultClause(clause)) &&
          !(ts.tokenStartOfNode(expr) >= ts.tokenStartOfNode(clause) && expr.end <= clause.end)
        ) {
          lowerer.unsupported(
            "SC1090",
            expr,
            "codec bindings read from another switch clause before initialization is proven",
          );
        }
      }
    }
    if (local.type.kind === "caught") return lowerer.caughtRead(expr, local, loc);
    const symbol = lowerer.resolveValueSymbol(expr);
    const runtimeOptionalRoot = lowerer.runtimeOptionalRootOf(local);
    const active = lowerer.runtimeOptionalLocals.has(runtimeOptionalRoot);
    const arithmetic = lowerer.runtimeOptionalArithmeticLocals.has(runtimeOptionalRoot);
    const captured =
      !!symbol &&
      lowerer.runtimeOptionalStorageLocals.has(runtimeOptionalRoot) &&
      (local.boxed === true ||
        lowerer.ctx.captureBySymbol.get(symbol) === local ||
        runtimeOptionalRoot !== local);
    if (arithmetic && !runtimeOptionalUseOf(expr)) {
      return { kind: "varRef", localId: local.id, type: local.type, loc };
    }
    if (active || captured) {
      const use = runtimeOptionalUseOf(expr);
      if (use?.complex) {
        // A DECLARED absent arm is honest storage: when the checker itself
        // types this use with a unit arm (an optional property read, an
        // optional parameter, a `T | undefined` local), the read needs no
        // narrowing aid — the union value flows into the surrounding
        // logical/conditional operator, which handles the absent arm
        // itself (`(entries ?? []).map(...)`, `x?.y ?? z`). Only a hidden
        // absence the checker does not admit needs the refusal below.
        const checked = lowerer.mapTypeOf(lowerer.typeOf(expr));
        if (
          checked?.kind === "union" &&
          local.type.kind === "union" &&
          lowerer.armTag(checked.unionId, UNDEFINED_T) >= 0 &&
          lowerer.armTag(local.type.unionId, UNDEFINED_T) >= 0
        )
          return { kind: "varRef", localId: local.id, type: local.type, loc };
        lowerer.unsupported(
          "SC1090",
          expr,
          "a logical or conditional receiver containing a runtime-optional capture",
        );
      }
      if (use?.optional) return { kind: "varRef", localId: local.id, type: local.type, loc };
      if (use?.kind === "property")
        return runtimeOptionalReceiverRead(lowerer, expr, local, use.access.name.text, loc);
      if (use?.kind === "element") {
        const key = runtimeOptionalElementKey(use.access.argumentExpression);
        if (key === null) {
          return (
            runtimeOptionalKeyedRecord(lowerer, expr, local, loc) ??
            varRef(local.id, local.type, loc)
          );
        }
        return runtimeOptionalReceiverRead(lowerer, expr, local, key, loc);
      }
      if (use?.kind === "call") {
        if (use.comma && !use.optional) {
          lowerer.unsupported(
            "SC1090",
            use.access,
            "a direct call through a comma-wrapped runtime-optional capture",
          );
        }
        return runtimeOptionalReceiverRead(lowerer, expr, local, null, loc);
      }
      const callback = requiredLibraryCallbackRead(lowerer, expr, local, loc);
      if (callback) return callback;
      if (runtimeOptionalObjectWalkerArg(lowerer, expr)) {
        const narrowed = lowerer.mapTypeOf(lowerer.typeOf(expr));
        if (local.type.kind === "union" && narrowed) {
          const helper =
            narrowed.kind === "union"
              ? lowerer.narrowedRetagHelper(expr, local.type.unionId, narrowed.unionId, loc)
              : !isUnitType(narrowed)
                ? lowerer.narrowedArmHelper(local.type.unionId, narrowed, loc)
                : null;
          if (helper) {
            return lowerer.checkedNarrowCall(
              helper,
              varRef(local.id, local.type, loc),
              narrowed,
              loc,
            );
          }
        }
      }
      return { kind: "varRef", localId: local.id, type: local.type, loc };
    }
    if (local.type.kind === "dyn" && isJsWidenedBinding(lowerer, expr))
      return { kind: "varRef", localId: local.id, type: local.type, loc };
    const narrowed = lowerer.maybeNarrow(
      { kind: "varRef", localId: local.id, type: local.type, loc },
      expr,
    );
    if (
      narrowed.type.kind === "union" &&
      lowerer.runtimeOptionalStorageLocals.has(runtimeOptionalRoot) &&
      lowerer.mapTypeOf(lowerer.typeOf(expr))?.kind === "record"
    ) {
      // A presence guard can be followed by a predicate strengthening
      // the record's fields. Its refined shape is not a stored union
      // arm: extract the original layout before reading a member.
      const use = runtimeOptionalUseOf(expr);
      if (use && !use.complex && !use.optional) {
        if (use.kind === "property")
          return runtimeOptionalReceiverRead(lowerer, expr, local, use.access.name.text, loc);
        if (use.kind === "element") {
          const key = runtimeOptionalElementKey(use.access.argumentExpression);
          if (key !== null) return runtimeOptionalReceiverRead(lowerer, expr, local, key, loc);
        }
      }
    }
    return narrowed;
  }
  // An EXPORTED member of a function+namespace merge reads as the merged
  // function object's own property (Node's transform qualifies the bare
  // reference to `fn.member`), not as a module binding — lower-fundule.ts.
  {
    const fundule = lowerFunduleMemberRead(lowerer, expr, loc);
    if (fundule !== null) return fundule;
  }
  // `import x = N.y` aliases resolve transparently through globalOf/
  // fnSigOf below; their source-order guards live here (a no-op for
  // every non-import= binding — see lower-namespaces.ts).
  fenceEarlyAliasUse(lowerer, expr, expr);
  {
    const snapshot = cjsImportedDataSnapshotOf(lowerer, expr);
    if (snapshot !== null) return varRef(snapshot.id, snapshot.type, loc);
  }
  const g = lowerer.globalOf(expr);
  if (g) {
    // A global typed by a class that never REGISTERED (its collection
    // fenced): the initializing assignment never lowered, so the read
    // can only observe garbage — and the emitter would name a struct
    // that does not exist. The blocked-binding cascade names the use;
    // without this the validator's registration check ICEs on the live
    // reference (`@this {T}` inference — signature 07).
    let unregistered = lowerer.unregisteredClassOf(g.type, new Set());
    // The class's own rejection is the root cause the cascade names
    // (unless the flush registers it with dynamic slots).
    if (unregistered !== null && lowerer.flushDeferredClass(unregistered) !== undefined)
      unregistered = lowerer.unregisteredClassOf(g.type, new Set());
    if (unregistered !== null) {
      lowerer.pushDiag(blockedBindingUseDiag(expr.text, loc));
      throw new PoisonError();
    }
    const ref: IrExpr = { kind: "varRef", localId: g.id, type: g.type, loc };
    if (lowerer.isRuntimeOptionalArithmeticGlobal(g) && !runtimeOptionalUseOf(expr)) {
      return ref;
    }
    const storageHasUndefined =
      g.type.kind === "union" && lowerer.armTag(g.type.unionId, UNDEFINED_T) >= 0;
    if (lowerer.isRuntimeOptionalGlobal(g) || storageHasUndefined) {
      // A checker-narrowed global receiver (`if (tags !== undefined)
      // tags[tags.length] = ...`, or `a ? Object.keys(a) : ...`) is
      // still stored as the runtime optional union. Extract the proven
      // value arm before routing the member/element operation so dynamic
      // keys and builtin record walkers do not see a union receiver.
      const narrowed = lowerer.mapTypeOf(lowerer.typeOf(expr));
      // An optional Iterable proven present re-tags into the Iterable.
      if (
        g.type.kind === "union" &&
        narrowed?.kind === "union" &&
        narrowed.unionId !== g.type.unionId &&
        iterableUnionOf(lowerer, narrowed)
      ) {
        const helper = lowerer.narrowedRetagHelper(expr, g.type.unionId, narrowed.unionId, loc);
        if (helper) return { kind: "call", callee: helper, args: [ref], type: narrowed, loc };
      }
      const arithmeticUnion =
        g.type.kind === "union" &&
        lowerer.unions.get(g.type.unionId)?.arms.length === 2 &&
        lowerer.unions.get(g.type.unionId)!.arms.some((a) => a.kind === "f64") &&
        lowerer.unions.get(g.type.unionId)!.arms.some((a) => a.kind === "string");
      const symbol = lowerer.resolveValueSymbol(expr);
      if (
        !arithmeticUnion &&
        !(symbol !== null && lowerer.earlyReadVars.has(symbol)) &&
        g.type.kind === "union" &&
        narrowed &&
        narrowed.kind !== "union" &&
        !isUnitType(narrowed) &&
        !(
          narrowed.kind === "record" &&
          recordTextCodecClass(lowerer.shapes.get(narrowed.shapeId)!) !== null
        ) &&
        narrowed.kind !== "f64" &&
        narrowed.kind !== "string" &&
        narrowed.kind !== "bool" &&
        lowerer.armTag(g.type.unionId, narrowed) >= 0
      ) {
        const helper = lowerer.narrowedArmHelper(g.type.unionId, narrowed, loc);
        if (helper) return lowerer.checkedNarrowCall(helper, ref, narrowed, loc);
      }
      const callback = requiredLibraryCallbackRead(lowerer, expr, g, loc);
      if (callback) return callback;
      const use = runtimeOptionalUseOf(expr);
      // The enclosing logical/conditional expression consumes the union
      // before any member operation runs (`(value ?? fallback).length`).
      // Keep the tagged value intact and let that lazy expression decide
      // its branch; extracting here would evaluate or throw too early.
      if (use?.complex) return ref;
      if (use?.optional) return ref;
      if (use?.kind === "property")
        return runtimeOptionalReceiverRead(lowerer, expr, g, use.access.name.text, loc);
      if (use?.kind === "element") {
        const key = runtimeOptionalElementKey(use.access.argumentExpression);
        if (key === null)
          lowerer.unsupported(
            "SC1090",
            use.access,
            "a computed read from a runtime-optional global (use a literal key)",
          );
        return runtimeOptionalReceiverRead(lowerer, expr, g, key, loc);
      }
      if (use?.kind === "call") return runtimeOptionalReceiverRead(lowerer, expr, g, null, loc);
      return ref;
    }
    if (g.type.kind === "dyn" && isJsWidenedBinding(lowerer, expr)) return ref;
    return lowerer.maybeNarrow(ref, expr);
  }
  // `undefined` — tsc's intrinsic global (a local shadowing the name
  // resolved above): a unit literal, exactly like the `null` keyword.
  if (expr.text === "undefined" && lowerer.typeOf(expr).flags & ts.TypeFlags.Undefined) {
    return { kind: "unitLit", unit: "undefined", type: UNDEFINED_T, loc };
  }
  // `__dirname` / `__filename` — the CommonJS module globals: per-
  // MODULE compile-time constants, the containing file's location
  // (Node's exact values when the same tree runs in place; WASI uses
  // the equivalent guest-visible path; locals shadowing the names
  // resolved above), the same strings as import.meta.dirname/filename.
  // In a JavaScript ES module Node never defines them, so the read throws
  // Node's catchable ReferenceError. A .ts/.tsx file keeps them even when
  // Node's strip-types rule would load it as ESM: TypeScript projects are
  // commonly built as CommonJS bundles (tsc, esbuild, tsx) where these
  // globals exist, and @types/node declares them for every file.
  if (
    (expr.text === "__dirname" || expr.text === "__filename") &&
    lowerer.isStdlibGlobal(expr, expr.text)
  ) {
    const sf = ts.getSourceFileOfNode(expr);
    if (isNodeEsmFile(sf, lowerer.program) && !/\.tsx?$/.test(sf.fileName)) {
      return {
        kind: "libCall",
        fn: "global.undefRead",
        args: [{ kind: "strLit", value: expr.text, type: STRING, loc }],
        type: STRING,
        loc,
      };
    }
    // The WASI runner mounts the host cwd at guest `/` and the host temp
    // directory at `/tmp`. Bake the matching GUEST spelling so resource
    // lookups relative to these CommonJS globals stay inside the exposed
    // capability instead of naming an unreachable host-absolute path.
    const fileName = moduleFileName(lowerer, sf);
    const value =
      expr.text === "__dirname"
        ? lowerer.targetPlatform === "wasi"
          ? posix.dirname(fileName)
          : dirname(fileName)
        : fileName;
    return { kind: "strLit", value, type: STRING, loc };
  }
  const sig = lowerer.fnSigOf(expr);
  if (sig && lowerer.isTopLevelFnSymbol(expr)) {
    // A declared function used as a value: a zero-capture closure. The
    // backend interns one per function so `f === f` holds (JS identity).
    // The value's type is the completed ABI signature; optional/default
    // slots and typed rest arrays pass the value fence first.
    lowerer.noteEdge(sig.name);
    // dynRest slots stay out of the VALUE type's param list (fn.length
    // semantics); the rest marker carries the trailing dyn-array ABI.
    const funcType: IrType = funcTypeFromParamShapes(sig.params, sig.returnType);
    lowerer.requireExactArityValue(expr, expr, sig.params, funcType);
    const closure = {
      kind: "closure" as const,
      fnName: sig.name,
      captures: [],
      type: funcType,
      loc,
    };
    const decl = lowerer.resolveValueSymbol(expr)?.valueDeclaration;
    return decl && ts.isFunctionDeclaration(decl) && funcType.kind === "func"
      ? argumentCountValue(lowerer, decl, expr, { ...closure, type: funcType })
      : closure;
  }
  {
    // A generic function as a VALUE: monomorphized by flow — the
    // reference's pinned concrete signature (contextual type or an
    // instantiation expression) names the instance; unpinned
    // references fence inside (lowerGenericFnValue).
    const gfn = lowerer.genericFnOf(expr);
    if (gfn) return lowerer.lowerGenericFnValue(expr, gfn);
  }
  // A CJS export-table ACCESSOR read (`tmpdir.path`, or a destructured
  // binding aliasing one): the getter is a real function of module
  // scope — its body reads module globals, so it lifts like a lambda
  // (interned per declaration) and every read is a call. Node runs the
  // getter per read; so does this.
  {
    const acc = cjsExportAccessorRead(lowerer, expr);
    if (acc) return acc;
  }
  // A binding destructured from a baked constants object
  // (http2.constants / crypto.constants): the literal — the
  // declaration emitted nothing (builtinConstantsDestructureDecl).
  {
    const h2c = lowerer.builtinConstantBindingOf(expr);
    if (h2c) return h2c;
  }
  // Builtin-module import bindings: constants (path.sep, os.EOL) read
  // as interned string literals; functions have no closure
  // representation (they lower to libCall at call sites only); members
  // with no lowering at all fence with the module-qualified name.
  {
    const member = threadsImportOf(lowerer.program, expr);
    // scriptc delivers published graphs by reference.
    if (member === "sharesPublishedGraphs")
      return { kind: "boolLit", value: true, type: BOOL, loc };
    if (member === "publish")
      lowerer.noLowering(
        "publish (@scriptc/threads) as a value",
        expr,
        "call publish(value) directly",
      );
    const nodeApi = nodeApiBindingOf(lowerer.program, expr);
    if (nodeApi === "namespace")
      lowerer.noLowering(
        "the @scriptc/node namespace as a value",
        expr,
        "call its call and callSync members directly",
      );
    if (nodeApi !== null)
      lowerer.noLowering(
        `${nodeApi} (@scriptc/node) as a value`,
        expr,
        `call ${nodeApi}(specifier, name, ...args) directly`,
      );
    if (experimentalImportOf(lowerer.program, expr) === "LifetimeRegion")
      lowerer.noLowering(
        "LifetimeRegion (@scriptc/experimental) as a value",
        expr,
        "construct regions with new LifetimeRegion()",
      );
    if (experimentalImportOf(lowerer.program, expr) === "InternTable")
      lowerer.noLowering(
        "InternTable (@scriptc/experimental) as a value",
        expr,
        'open tables with new InternTable("name")',
      );
    if (experimentalImportOf(lowerer.program, expr) === "ThreadSlots")
      lowerer.noLowering(
        "ThreadSlots (@scriptc/experimental) as a value",
        expr,
        'open slots with new ThreadSlots("name")',
      );
  }
  {
    const bi = lowerer.builtinImportOf(expr);
    if (bi) {
      if (bi.module === "worker_threads") {
        const value = lowerWorkerMetadata(lowerer, bi.member, loc);
        if (value) return value;
      }
      // A named import of defaultMaxListeners reads the ES module
      // namespace's copy. A CommonJS destructured or member binding holds
      // the value read when its declaration ran, which these bindings do
      // not store.
      if (bi.module === "events" && bi.member === "defaultMaxListeners") {
        if (esmImportBindingKind(lowerer, expr) === "named") {
          return { kind: "libCall", fn: "emitter.esmDefaultMax", args: [], type: F64, loc };
        }
        lowerer.noLowering(
          "events.defaultMaxListeners through a CommonJS destructured or member binding",
          expr,
          "read require('events').defaultMaxListeners or EventEmitter.defaultMaxListeners where the value is needed",
        );
      }
      const c = builtinModuleConstOf(lowerer, bi.module, bi.member);
      if (c !== undefined) return builtinConstLit(c, loc);
      // `import { posix, win32 } from "node:path"` as VALUES: the platform
      // namespaces are members of the path module object, so the named
      // import reads the same checked-dynamic module value the property
      // form (path.posix) lowers to.
      if (
        (bi.module === "path" || bi.module === "path/posix" || bi.module === "path/win32") &&
        (bi.member === "posix" || bi.member === "win32")
      ) {
        return pathModuleValue(lowerer, `path/${bi.member}`, loc);
      }
      // module.builtinModules — the baked Node v24 list, a fresh
      // string[] per read.
      if (bi.module === "module" && bi.member === "builtinModules") {
        return builtinModulesArrayLit(loc);
      }
      if (bi.module === "http" && bi.member === "METHODS") {
        return { kind: "libCall", fn: "http.methods", args: [], type: arrayOf(STRING), loc };
      }
      if ((bi.module === "http" || bi.module === "https") && bi.member === "globalAgent") {
        return {
          kind: "libCall",
          fn: "http.globalAgent",
          args: [{ kind: "boolLit", value: bi.module === "https", type: BOOL, loc }],
          type: DYN,
          loc,
        };
      }
      if (bi.module === "http" && bi.member === "STATUS_CODES") {
        return { kind: "libCall", fn: "http.statusCodes", args: [], type: DYN, loc };
      }
      if (bi.module === "os" && bi.member === "constants") {
        return { kind: "libCall", fn: "os.constants", args: [], type: DYN, loc };
      }
      if (bi.module === "module" && bi.member === "constants") {
        return { kind: "libCall", fn: "module.compileCacheConstants", args: [], type: DYN, loc };
      }
      if (bi.module === "fs" && bi.member === "constants")
        return { kind: "libCall", fn: "fs.constants", args: [], type: DYN, loc };
      // `import { O_RDONLY } from "constants"`: the member of the frozen
      // module object.
      if (bi.module === "constants") {
        return {
          kind: "dynKeyGet",
          value: builtinConstantsObject(lowerer, loc),
          key: { kind: "strLit", value: bi.member, type: STRING, loc },
          type: DYN,
          loc,
        };
      }
      // tls.rootCertificates: a runtime-valued module constant (the
      // cached bundled-CA array) — the one member read that lowers
      // to a libCall instead of a baked literal.
      {
        const roots = lowerTlsRootCertificates(lowerer, bi, loc);
        if (roots) return roots;
      }
      {
        const callable = lowerer.lowerBuiltinCallableValue(bi, loc);
        if (callable) return callable;
      }
      // node:crypto's webcrypto is the WebCrypto global's object.
      if (bi.module === "crypto" && bi.member === "webcrypto")
        return { kind: "libCall", fn: "webcrypto.object", args: [], type: DYN, loc };
      // `import { argv, execArgv } from "node:process"`: a data member of
      // the process module reads what `process.<member>` reads. `env` stays
      // out: the spelled read answers a snapshot record, and a write through
      // the import (`env.NAME = value`) must reach the environment.
      if (bi.module === "process" && bi.member !== "env") {
        const value = processDataMemberValue(lowerer, bi.member, expr, loc);
        if (value !== null) return value;
      }
      // url.Url is Node's legacy Url constructor (JavaScript sources;
      // @types/node declares Url as a type only), the class of url.parse()
      // results.
      if (bi.module === "url" && bi.member === "Url") return legacyUrlClassValue(loc);
      // JavaScript sources: a builtin member no lowering above has a value
      // for reads what Node's own kind of value calls for
      // (node-value-reads.ts): a function or class is a function value that
      // refuses when it is called or constructed, so identity flows and
      // feature tests are Node's (the harness adds worker_threads.Worker to
      // its identity Set); any other value is refused by name where it is
      // read. It is never a stand-in the program could observe.
      if (isJsSourceFile(ts.getSourceFileOfNode(expr))) {
        // A member that is a global object reads as the global does.
        const global = globalMemberValue(lowerer, bi, expr, loc);
        if (global) return global;
        // EventEmitter and the stream classes are the runtime's untyped
        // constructors, so constructor functions can inherit from them.
        const classKind = builtinMemberClassKind(bi.module, bi.member);
        if (classKind !== null) return builtinClassValue(classKind, loc);
        // A member that is a supported module in its own right
        // (`import { promises } from "node:dns"`) reads as that module's
        // namespace, below.
        if (lowerer.builtinNamespaceModuleOf(expr) === null) {
          return unloweredModuleMemberValue(
            lowerer,
            bi,
            expr,
            loc,
            esmImportBindingKind(lowerer, expr) === "named",
          );
        }
      } else {
        if (builtinModuleFnOf(lowerer, bi.module, bi.member)) {
          lowerer.unsupported(
            "SC1090",
            expr,
            `library functions as values (call '${expr.text}' directly)`,
          );
        }
        lowerer.noLowering(
          `${bi.module}.${bi.member}`,
          expr,
          builtinFenceHintOf(bi.module, bi.member),
          lowerer.resolveValueSymbol(expr),
        );
      }
    }
  }
  // A builtin namespace import used as a bare VALUE (`const f = fs`):
  // the namespace object has no representation — members lower at
  // their access sites only. The CommonJS namespace binding
  // (`const lib = require("./lib.js")`) gets the same fence.
  const builtinShape = lowerer.builtinNamespaceShapeOf(expr);
  if (builtinShape !== null) {
    // node:constants has a value on each side of the import: the CommonJS
    // object a require and a default import bind, and the ES module
    // namespace an `import * as` binding binds (sorted names plus "default",
    // null prototype).
    if (builtinShape.module === "constants")
      return builtinShape.flavor === "esm"
        ? builtinConstantsEsmNamespace(lowerer, loc)
        : builtinConstantsObject(lowerer, loc);
    const type: IrType = { kind: "moduleNs", moduleId: `builtin:${builtinShape.module}` };
    return { kind: "moduleNsRef", moduleId: type.moduleId, type, loc };
  }
  // A binding of a SINGLE-VALUE module used as a bare value: Node's
  // require answers module.exports, so the read IS that value (the same
  // answer the split-binding path below gives).
  {
    const required = wholeExportValueOfModuleBinding(lowerer, expr);
    if (required !== null) return required;
  }
  if (lowerer.cjsLocalModuleBindingOf(expr)) {
    // A module that assigns module.exports inside a function or under a
    // condition (a UMD wrapper) exports whatever that statement chose when
    // it ran: the binding is that value under Node, and the static export
    // table this build reads does not hold it. The refusal names that
    // cause; "access its members" would not help.
    const dep = lowerer.cjsModuleBindingDepOf(expr);
    const nested = dep === null ? null : cjsNestedExportReplacementOf(dep);
    if (dep !== null && nested !== null) {
      const pkg = packageDirOf(dep.fileName);
      const line = ts.getLineAndCharacterOfPosition(dep, locOf(nested).start).line + 1;
      const where =
        pkg === null
          ? `line ${line} of its module`
          : `${posix.relative(pkg.dir, dep.fileName.split("\\").join("/"))}:${line}`;
      lowerer.unsupported(
        "SC1090",
        expr,
        `the value of '${expr.text}' (its module assigns module.exports inside a function or under a condition, at ${where}, so what it exports is decided when it runs)`,
        pkg === null
          ? "assign module.exports in a top-level statement of the module, or mark the module to run in a Node island"
          : `run the package in a Node island: --node-island=${pkg.name}, or leave the choice to the build with --node-islands=auto`,
      );
    }
    lowerer.unsupported(
      "SC1090",
      expr,
      `module namespace objects as values (access '${expr.text}' members directly)`,
    );
  }
  if (lowerer.stdlibGlobalFnOf(expr)) {
    // JavaScript reads the global functions with values as those values
    // (global-function-values.ts).
    const canonical = stdlibGlobalNameOf(lowerer, expr);
    const value =
      canonical !== null && isJsSourceFile(ts.getSourceFileOfNode(expr))
        ? globalFunctionValue(lowerer, canonical, loc)
        : null;
    if (value !== null) return value;
    lowerer.unsupported(
      "SC1090",
      expr,
      `library functions as values (call '${expr.text}' directly)`,
    );
  }
  // A declaration-only npm binding has no compiled runtime value.
  {
    const pkg = lowerer.npmPackageOfSymbol(lowerer.resolveValueSymbol(expr) ?? undefined);
    if (pkg) {
      lowerer.pushDiag(unsupportedPackageValueDiag(pkg, loc));
      throw new PoisonError();
    }
  }
  // Bindings imported from an UNSUPPORTED builtin module: coverage
  // analyzes past import fences, so uses of `spawn` from
  // child_process reach lowering — the use site reports the same
  // "the '<module>' module" diagnostic as the import line, and the
  // report groups them into one blocker. (Builds never get here: the
  // import already failed preflight.)
  {
    const spec = lowerer.fencedBuiltinImportOf(expr);
    if (spec !== null) {
      lowerer.pushDiag(unsupportedDiag("SC1010", loc, unsupportedModuleFeatureOf(spec)));
      throw new PoisonError();
    }
  }
  // The globals `Infinity` and `NaN` (lib-declared, provenance-checked
  // like every stdlib name): non-finite numLits — `-Infinity` arrives
  // through the unary-minus literal fold. Arithmetic, comparisons, and
  // formatting are IEEE-exact in C (String(Infinity) is "Infinity" and
  // String(NaN) is "NaN" in the number formatter; `NaN !== NaN` holds
  // because f64 compares are IEEE compares).
  if (expr.text === "Infinity" || expr.text === "NaN") {
    if (lowerer.isStdlibGlobal(expr, expr.text)) {
      return { kind: "numLit", value: expr.text === "NaN" ? NaN : Infinity, type: F64, loc };
    }
  }
  // The primitive constructors as VALUES (`const f = String`, an
  // option table's `type: Boolean` field, `opt.type === Number`): the
  // program's one function for the constructor (primitiveCtorClosure),
  // so every reference is the SAME zero-capture closure and `===` is JS
  // identity. Direct calls `String(x)` never reach here: the call
  // lowering intercepts them with the static coercions. The callback of
  // an array iteration method (`xs.map(Number)`) is the conversion too:
  // the method only calls it.
  const primitiveName = stdlibGlobalNameOf(lowerer, expr);
  if (
    primitiveName === "String" ||
    primitiveName === "Number" ||
    primitiveName === "Boolean" ||
    primitiveName === "BigInt"
  ) {
    if (isArrayIterationCallback(lowerer, expr))
      return primitiveConversionCallback(
        lowerer,
        primitiveName,
        loc,
        isJsSourceFile(ts.getSourceFileOfNode(expr)),
      );
    return primitiveCtorValue(lowerer, primitiveName, loc);
  }
  if (lowerer.isStdlibGlobal(expr, "ArrayBuffer"))
    return { kind: "libCall", fn: "arrayBuffer.constructor", args: [], type: DYN, loc };
  if (isJsSourceFile(ts.getSourceFileOfNode(expr)) && lowerer.isStdlibGlobal(expr, "Array"))
    return { kind: "libCall", fn: "dyn.arrayConstructor", args: [], type: DYN, loc };
  if (
    (Object.values(BYTES_ELEMENT_NAME).includes(expr.text) || BIGINT_BYTES_NAMES.has(expr.text)) &&
    lowerer.isStdlibGlobal(expr, expr.text)
  ) {
    return {
      kind: "libCall",
      fn: "bytes.constructor",
      args: [{ kind: "strLit", value: expr.text, type: STRING, loc }],
      type: DYN,
      loc,
    };
  }
  if (
    (expr.text === "encodeURIComponent" ||
      expr.text === "encodeURI" ||
      expr.text === "decodeURIComponent" ||
      expr.text === "decodeURI") &&
    lowerer.isStdlibGlobal(expr, expr.text)
  ) {
    return uriFunctionValue(lowerer, expr.text, loc);
  }
  if (lowerer.isStdlibGlobal(expr, "crypto"))
    return { kind: "libCall", fn: "webcrypto.object", args: [], type: DYN, loc };
  if (isNavigatorGlobal(lowerer, expr)) return navigatorValue(loc);
  const nativeAlias = stdlibGlobalNameOf(lowerer, expr);
  if (nativeAlias === "Buffer" && expr.text !== "Buffer") {
    // An alias through a cast of globalThis carries the cast's static type,
    // which the Buffer function's value below does not have.
    const aliasSymbol = identifierReadSymbol(lowerer, expr);
    if (aliasSymbol && lowerer.castGlobalAliases.has(aliasSymbol)) {
      lowerer.unsupported(
        "SC1090",
        expr,
        "the Buffer constructor read through a cast of globalThis as a value",
        "test it in a condition, read its typeof, or call its members",
      );
    }
    // The alias reads the Buffer function's value (builtinGlobalValue), in
    // both source languages: a condition over it is true, `typeof` answers
    // "function", and a value that escapes is the function Node passes.
    return { kind: "libCall", fn: "buffer.constructor", args: [], type: DYN, loc };
  }
  if (lowerer.isStdlibGlobal(expr, "fetch")) {
    return { kind: "libCall", fn: "fetch.function", args: [], type: DYN, loc };
  }
  // The lib fence's IDENTIFIER chokepoint: the real standard library
  // resolves names the old minimal ambient world never declared
  // (Symbol, Reflect, Infinity, Date, ...) — and the adopted
  // @types/node resolves its whole global surface (Buffer, fetch,
  // setInterval, URL, ...). Reaching one that no lowering above
  // claimed is SC2020, never an ICE — EXCEPT in JavaScript sources,
  // where a stdlib global taken as a VALUE (never called through this
  // path — call sites lower earlier) reads what Node's kind of value
  // calls for: a function or class is a function value with Node's name
  // and length that refuses when it is called or constructed, so identity
  // flows (the harness's knownGlobals Set, === comparisons) and `typeof`
  // are exact; any other value is refused by name where it is read
  // (node-value-reads.ts).
  {
    const webStream = lowerWebStreamClassRead(lowerer, expr);
    if (webStream) return webStream;
  }
  if (stdlibGlobalNameOf(lowerer, expr) === "globalThis") {
    return lowerGlobalValue(lowerer, expr);
  }
  {
    const sym = identifierReadSymbol(lowerer, expr);
    // A global the declarations type and Node 24 does not define (the
    // temporal global, localStorage): the read throws Node's
    // ReferenceError.
    if (isNodeUndefinedGlobalRoot(lowerer, expr, sym)) {
      const t =
        ambientUndefReadType(lowerer, expr) ?? contextualUndefReadType(lowerer, expr) ?? F64;
      return nsUndefRead(lowerer, expr.text, expr, t);
    }
    // `require` in an ES module: Node defines no `require` binding there, so
    // the READ throws its catchable ReferenceError "require is not defined"
    // (probed on Node 24.22.0 for `.ts`, `.mts` and `.mjs` ES modules; the
    // CommonJS "in ES module scope" suffix belongs to Node's `createRequire`
    // shim, not to the bare global). The read always throws, so the dummy is
    // dynamic and never observed.
    if (
      expr.text === "require" &&
      lowerer.isStdlibGlobal(expr, "require") &&
      isNodeEsmFile(ts.getSourceFileOfNode(expr), lowerer.program)
    ) {
      return {
        kind: "libCall",
        fn: "global.undefRead",
        args: [{ kind: "strLit", value: "require", type: STRING, loc }],
        type: DYN,
        loc,
      };
    }
    // A JavaScript binding that names a global and owns no storage (`const
    // p = process`, `import process from "node:process"`, `var Buffer =
    // buffer.Buffer`): its member reads resolve through to the global, and
    // its value is the value the global's own name reads. A TypeScript
    // binding of this kind is reported at its declaration
    // (rejectUnresolvedSymbol).
    const aliasedGlobal =
      sym !== undefined &&
      !lowerer.isStdlibSymbol(sym) &&
      expr.text !== "globalThis" &&
      isJsSourceFile(ts.getSourceFileOfNode(expr))
        ? stdlibGlobalNameOf(lowerer, expr)
        : null;
    if (lowerer.isStdlibSymbol(sym) || expr.text === "globalThis" || aliasedGlobal !== null) {
      const canonical = stdlibGlobalNameOf(lowerer, expr) ?? expr.text;
      // %Iterator% in JavaScript: the live constructor (scr_js_iterator.c).
      if (canonical === "Iterator" && isJsIteratorGlobal(lowerer, expr))
        return iteratorConstructorExpr(loc);
      // Builtin constructors have real function values in both source
      // languages (TypeScript reads them as dynamic values).
      const builtinValue = builtinGlobalValueAt(
        lowerer,
        expr,
        canonical,
        loc,
        isJsSourceFile(ts.getSourceFileOfNode(expr)),
      );
      if (builtinValue !== null) return builtinValue;
      // A JavaScript source reads what Node's kind of value calls for
      // (node-value-reads.ts): a refusing function value for a function or
      // class, a named refusal for anything else.
      if (isJsSourceFile(ts.getSourceFileOfNode(expr)))
        return unloweredGlobalValue(lowerer, canonical, expr, loc);
      const untyped = tsUntypedGlobalValue(lowerer, expr, canonical, loc);
      if (untyped !== null) return untyped;
      // The families with a WHY: each hint states what makes the
      // surface genuinely non-static (or what to use instead).
      const globalHints: Record<string, string | undefined> = {
        Proxy:
          "Proxy constructor values have no native lowering; use a direct new Proxy with checked-native plain objects",
        Reflect:
          "reflective property access has no static lowering — read and call members directly",
        Intl: 'native Intl supports Intl.NumberFormat and Intl.DateTimeFormat objects with format() (the default locale, "en-US" or "en"), the toLocaleString() forms that construct them, and Intl.Segmenter with grapheme or word granularity; locale negotiation and the other Intl constructors remain unsupported',
        SharedArrayBuffer: "use direct new SharedArrayBuffer(length) for fixed shared storage",
        ArrayBuffer:
          "ArrayBuffer constructor values have no native lowering; use new ArrayBuffer(length) for fixed-length shared storage",
        WeakRef:
          "deref()-after-collect exposes GC timing — genuinely dynamic; hold a strong reference instead",
        eval: "runtime code evaluation cannot be compiled ahead of time",
      };
      lowerer.noLowering(
        expr.text,
        expr,
        globalHints[expr.text],
        sym ?? undefined,
        expr.text === "WeakRef" || expr.text === "FinalizationRegistry"
          ? "weak-ref"
          : expr.text === "eval"
            ? "code-from-string"
            : undefined,
      );
    }
  }
  // An ambient global nothing defines compiles to exactly what Node does
  // at the access: the catchable ReferenceError "<name> is not defined".
  // Stdlib/@types/node ambients never reach here (their chokepoint
  // is above); only user-file declares do.
  {
    if (ambientUndefinedVarSymbolOf(lowerer, expr)) {
      const declared = lowerer.mapTypeOf(lowerer.typeOf(expr));
      if (declared && declared.kind !== "void") {
        return {
          kind: "libCall",
          fn: "global.undefRead",
          args: [{ kind: "strLit", value: expr.text, type: STRING, loc }],
          type: declared,
          loc,
        };
      }
    }
  }
  // An ambient `declare function` nothing defines, taken as a VALUE
  // (call sites lower earlier, in lowerCall): the same story as the
  // ambient `declare const` above — Node erases the declaration and
  // the read throws the catchable ReferenceError at the access.
  {
    if (ambientUndefinedFnSymbolOf(lowerer, expr)) {
      const t = ambientUndefReadType(lowerer, expr);
      if (t) return nsUndefRead(lowerer, expr.text, expr, t);
    }
  }
  // A read of a TRAP binding — a declaration whose own initializer
  // provably threw (module init unwound there), so this reference can
  // never execute: any lowering is sound, and the trap keeps the
  // shape honest. Typed by the use site when it maps, the F64 dummy
  // otherwise (never observed — never even reached).
  {
    const sym = lowerer.resolveValueSymbol(expr);
    if (sym !== null && lowerer.trapBindings.has(sym)) {
      const t =
        ambientUndefReadType(lowerer, expr) ?? contextualUndefReadType(lowerer, expr) ?? F64;
      return nsUndefRead(lowerer, expr.text, expr, t);
    }
  }
  // A program CLASS NAME as a value: the classRef over the class's
  // immortal class object (member accesses and construction never
  // reach here — their hooks claim the property/new forms first).
  {
    const sym = lowerer.resolveValueSymbol(expr);
    let classInfo = sym ? lowerer.classBySymbol.get(sym) : undefined;
    // A class local to a function lowered once per instantiation
    // (`$constructor` called with different argument types) registers per
    // instance under the same symbol: a hoisted function of a later
    // instance, lowered before its own class statement, must not reach the
    // class an earlier instance collected.
    const declaration = sym?.valueDeclaration;
    if (
      classInfo &&
      lowerer.localClassInstantiations.length > 0 &&
      declaration &&
      ts.isClassDeclaration(declaration) &&
      lowerer.classNamer(declaration) !== classInfo.def.name
    )
      classInfo = undefined;
    // A local class referenced from a function hoisted above its statement:
    // its TDZ box, holding the class as a checked-dynamic constructor.
    if (!classInfo && sym && predeclareForwardClass(lowerer, sym)) {
      const local = lowerer.resolveLocal(expr);
      if (local) return { kind: "varRef", localId: local.id, type: local.type, loc };
    }
    // A GENERIC class name whose CONTEXTUAL type pins one instantiation
    // (`const B: new (v: string) => Counter<string> = Counter`): the
    // value is that instantiation's class object — the generic-fn
    // pinning rule on the static side. Unpinned references fall
    // through to classValueRef's family fence.
    if (classInfo?.generic) {
      const ctxT = lowerer.checker.getContextualType(expr);
      const mapped = ctxT ? lowerer.mapTypeOf(ctxT) : null;
      const instInfo =
        mapped?.kind === "classval" ? lowerer.classes.get(mapped.className) : undefined;
      if (instInfo && instInfo.genericInstance?.family === classInfo) {
        return lowerer.classValueRef(instInfo, expr);
      }
    }
    if (classInfo) {
      // A decorated name a replacing decorator can REBIND: the value
      // is the decoration result — the mutable classval global %init
      // assigned at the class statement (TC39's name binding), never
      // the declaration's own class object.
      const decoratedGlobal = classInfo.classDecorators?.valueGlobalId;
      if (decoratedGlobal !== undefined) {
        return {
          kind: "varRef",
          localId: decoratedGlobal,
          type: { kind: "classval", className: classInfo.def.name },
          loc,
        };
      }
      return lowerer.classValueRef(classInfo, expr);
    }
    // The enum OBJECT as a value (member reads never reach here — the
    // access hooks fold them): the record its declaration built, or a
    // pointed fence for an enum that has no object (enum-objects.ts).
    if (sym) {
      const enumObject = lowerEnumObjectValue(lowerer, expr, sym);
      if (enumObject) return enumObject;
    }
    // A MIXIN function as a first-class value: no runtime function
    // exists — calls instantiate a class per call site
    // (lower-mixins.ts). Generic mixins took the generic-fn value
    // fence above; this names the non-generic spelling.
    if (mixinFnOfCallee(lowerer, expr)) {
      lowerer.unsupported(
        "SC1090",
        expr,
        `the mixin function '${expr.text}' as a value (mixin calls compile per call site — call it directly)`,
      );
    }
  }
  // A NAMESPACE object as a first-class value: members lower at their
  // qualified access sites; the object itself has no runtime
  // representation (ambient namespaces compile to Node's
  // ReferenceError instead — the object never exists at runtime).
  {
    // `ns.name` through a namespace import of a CommonJS module, where Node's
    // namespace has no `name` property (its lexer does not detect it), or
    // `ns.default` (module.exports itself).
    const cjsNamespace = cjsNamespaceImportDep(lowerer, expr);
    if (
      cjsNamespace !== null &&
      ts.isPropertyAccessExpression(expr.parent) &&
      expr.parent.expression === expr &&
      ts.isIdentifier(expr.parent.name)
    ) {
      const name = expr.parent.name.text;
      const { names, assignedLater } = lowerer.cjsNamespaceOf(cjsNamespace);
      if (name === "default")
        lowerer.unsupported(
          "SC1090",
          expr.parent,
          `reads of 'default' through namespace imports of CommonJS modules (module.exports itself: read it through a default import)`,
        );
      if (!names.has(name))
        lowerer.unsupported(
          "SC1090",
          expr.parent,
          `reads of '${name}' through namespace imports of CommonJS modules (Node's lexer does not detect '${name}' among the module's exports, so Node reads undefined)`,
        );
      if (assignedLater === "all" || assignedLater.has(name))
        lowerer.unsupported(
          "SC1090",
          expr.parent,
          `reads of '${name}' through namespace imports of CommonJS modules whose functions assign exports (Node's namespace keeps the values from the end of the module's evaluation)`,
        );
    }
    const moduleNs = lowerer.mapTypeOf(lowerer.typeOf(expr));
    if (moduleNs?.kind === "moduleNs") {
      return { kind: "moduleNsRef", moduleId: moduleNs.moduleId, type: moduleNs, loc };
    }
    const builtinNs = lowerer.builtinNamespaceModuleOf(expr);
    if (builtinNs === "constants") return builtinConstantsObject(lowerer, loc);
    if (builtinNs !== null) {
      const type: IrType = { kind: "moduleNs", moduleId: `builtin:${builtinNs}` };
      return { kind: "moduleNsRef", moduleId: type.moduleId, type, loc };
    }
    const ns = lowerNsIdentifierValue(lowerer, expr);
    if (ns) return ns;
  }
  // An import of a CommonJS member export whose value is a binding of the
  // exporting module (`module.exports = Client; module.exports.StatsD =
  // Client`): the member holds that binding's value.
  const memberAlias = cjsMemberAliasValueOf(lowerer, expr);
  if (memberAlias !== null) return lowerer.lowerExpr(memberAlias);
  // `var m; m = require("./x")` as a bare value: a whole-export target is
  // the exported value; a table target has no first-class module object.
  {
    const split = splitRequireBindingOfIdent(lowerer, expr);
    if (split !== null) {
      if (wholeExportSymbolOfModule(lowerer, split.dep) !== null) {
        const value = wholeExportValue(lowerer, split.dep, expr);
        if (value !== null) return value;
        lowerer.unsupported(
          "SC1090",
          expr,
          `the whole export of '${split.spec}' as a value (its 'module.exports =' value has no static representation)`,
        );
      }
      lowerer.unsupported(
        "SC1090",
        expr,
        `the exports object of '${split.spec}' as a value (its exports compile to a static table: read require(${JSON.stringify(split.spec)}).member directly)`,
      );
    }
  }
  // A `.js` READ of a name NOTHING declares. Node resolves such a name at
  // run time: the access throws the catchable `ReferenceError: <name> is not
  // defined` (a `typeof` test lowers earlier, in expressions/typeof.ts, and
  // answers "undefined" — exactly Node's rule), so the read compiles to that
  // throw and never yields a value. The value is checked-dynamic (the
  // checker's error-any), which every use site carries or fences — and the
  // read always unwinds before any of them observes it. A WRITE to the same
  // name is not a read: it reaches rejectUnresolved and its SC1091 story.
  // Typed sources keep the compile error (preflight's JS relaxation is
  // `isJsSourceFileName`-gated), except a name that only a library of the
  // project's `lib` declares and Node does not define (the DOM's
  // `document`): the project's own tsc resolves it, preflight admits it
  // (projectLibraryNameAt), and the read is Node's, as in a `.js` file.
  // In shorthand position (`{ x }`) `resolveValueSymbol` answers the
  // PROPERTY symbol, so the declaration test there is the checker's
  // shorthand-VALUE symbol.
  const parent = expr.parent;
  const undeclared =
    parent !== undefined && ts.isShorthandPropertyAssignment(parent) && parent.name === expr
      ? lowerer.checker.getShorthandAssignmentValueSymbol(parent) === undefined
      : lowerer.resolveValueSymbol(expr) === null;
  if (
    undeclared &&
    (isJsSourceFile(ts.getSourceFileOfNode(expr)) || lowerer.projectLibraryNameAt(expr))
  ) {
    return nsUndefRead(lowerer, expr.text, expr, contextualUndefReadType(lowerer, expr) ?? DYN);
  }
  // Preflight guarantees no unresolved identifiers; anything else here
  // is a blocked declaration's binding (the SC2004 cascade) or a
  // binding form we don't model yet.
  lowerer.rejectUnresolved(
    expr,
    `the reference to '${expr.text}' (a binding form with no lowering)`,
  );
}

/** A computed-key access (`value[key]` after `typeof value === "object"`)
 * of a runtime-optional binding the checker narrowed to one record arm of a
 * wider union. The binding re-tags to that record or undefined, so the keyed
 * read or write evaluates its operands and then throws Node's TypeError for
 * an undefined receiver. The other arms, which the checker excluded, fail
 * the checked re-tag. Null when the binding stores only the record and
 * undefined, or the narrowed record is not one of its arms. */
function runtimeOptionalKeyedRecord(
  lowerer: Lowerer,
  expr: ts.Identifier,
  local: IrLocal,
  loc: SrcLoc,
): IrExpr | null {
  if (local.type.kind !== "union") return null;
  const narrowed = lowerer.mapTypeOf(lowerer.typeOf(expr));
  if (narrowed?.kind !== "record") return null;
  const fromId = local.type.unionId;
  const arms = lowerer.unions.get(fromId)?.arms;
  const recordTag = lowerer.armTag(fromId, narrowed);
  const undefTag = lowerer.armTag(fromId, UNDEFINED_T);
  if (!arms || arms.length <= 2 || recordTag < 0 || undefTag < 0) return null;
  const target = lowerer.withUndefinedArm(narrowed);
  if (target.kind !== "union") return null;
  const trappable = new Set<number>();
  for (let tag = 0; tag < arms.length; tag++) {
    if (tag !== recordTag && tag !== undefTag) trappable.add(tag);
  }
  const helper = lowerer.unionRetagHelper(fromId, target.unionId, loc, trappable);
  if (!helper) return null;
  return lowerer.checkedNarrowCall(helper, varRef(local.id, local.type, loc), target, loc);
}

/** Object.keys, Object.values and Object.entries require an object
 * receiver, but their first argument is not syntactically a member
 * receiver. Recognize that one standard-library position so a
 * runtime-optional loop element can be checked against the checker-narrowed
 * record arm before builtin lowering. */
function runtimeOptionalObjectWalkerArg(lowerer: Lowerer, expr: ts.Expression): boolean {
  let arg = expr;
  while (
    (ts.isParenthesizedExpression(arg.parent) ||
      ts.isAssertionExpression(arg.parent) ||
      ts.isSatisfiesExpression(arg.parent) ||
      ts.isNonNullExpression(arg.parent)) &&
    arg.parent.expression === arg
  ) {
    arg = arg.parent;
  }
  const call = arg.parent;
  if (
    !ts.isCallExpression(call) ||
    call.arguments.nodes[0] !== arg ||
    !ts.isPropertyAccessExpression(call.expression)
  )
    return false;
  const access = call.expression;
  return (
    (access.name.text === "keys" ||
      access.name.text === "values" ||
      access.name.text === "entries") &&
    lowerer.isStdlibMember(access)
  );
}

/** A read that resolves to a CJS export-table ACCESSOR property
 * (`module.exports = { get path() {...}, set path(v) {...} }`): the
 * getter lifts as a module-level function (module globals need no
 * captures) — interned per declaration so every read site calls ONE
 * function — and the read IS the call, Node's per-read evaluation
 * exactly. Null when the identifier doesn't resolve to such a property
 * (or it has no getter: a setter-only read answers undefined in Node —
 * rare enough to keep fenced). */
function cjsExportAccessorRead(lowerer: Lowerer, ident: ts.Identifier): IrExpr | null {
  const symbol = lowerer.resolveValueSymbol(ident);
  const getter = symbol ? symbol.declarations.find(ts.isGetAccessorDeclaration) : undefined;
  if (!getter) return null;
  if (!ts.isObjectLiteralExpression(getter.parent) || !isCjsExportTableLiteral(getter.parent)) {
    return null;
  }
  // An ES-module import binding reads the value Node copied when the
  // importer linked the CommonJS module (cjsAccessorSnapshotStores).
  const raw = lowerer.checker.getSymbolAtLocation(ident);
  const binding = raw ? raw.declarations[0] : undefined;
  if (
    binding !== undefined &&
    (ts.isImportSpecifier(binding) || ts.isExportSpecifier(binding)) &&
    !isCjsJsFile(ts.getSourceFileOfNode(binding), lowerer.program)
  ) {
    const snapshot = cjsAccessorSnapshotOf(lowerer, getter);
    if (snapshot !== null)
      return { kind: "varRef", localId: snapshot.id, type: snapshot.type, loc: locOf(ident) };
  }
  return cjsAccessorCall(lowerer, getter, locOf(ident));
}

/** encodeURIComponent, encodeURI, decodeURI or decodeURIComponent as a
 * function value: one interned closure per function. */
export function uriFunctionValue(lowerer: Lowerer, which: string, loc: SrcLoc): IrExpr {
  const name = `%builtin.${which}`;
  const type = funcOf([DYN], STRING);
  if (lowerer.liftedFnNamed(name) === undefined) {
    const value: IrExpr = {
      kind: "libCall",
      fn: "dyn.toStringCoerce",
      args: [varRef("value", DYN, loc)],
      type: STRING,
      loc,
    };
    const fn =
      which === "encodeURIComponent"
        ? "str.encodeUriComponent"
        : which === "encodeURI"
          ? "str.encodeUri"
          : which === "decodeURI"
            ? "str.decodeUri"
            : "str.decodeUriComponent";
    lowerer.liftedFns.push({
      name,
      params: [{ localId: "value", name: "value", type: DYN }],
      locals: [{ id: "value", name: "value", type: DYN, mutable: false }],
      returnType: STRING,
      body: [
        {
          kind: "return",
          value: { kind: "libCall", fn, args: [value], type: STRING, loc },
          loc,
        },
      ],
      loc,
    });
  }
  return { kind: "closure", fnName: name, captures: [], type, loc };
}

/** A read of a captured handle `let` (Lowerer.closureDynLets) inside a
 * function nested in the binding's scope. The checker types it as the
 * handle, but the closure can run before the first write. As a member
 * receiver (`c.address()`, `child.stdin`) it reads the handle and throws
 * Node's TypeError when the binding is still undefined; elsewhere it reads
 * the checked-dynamic value of the handle or undefined. Null for other
 * reads. */
function closureDynRead(
  lowerer: Lowerer,
  expr: ts.Identifier,
  id: string,
  type: IrType,
  loc: SrcLoc,
): IrExpr | null {
  if (type.kind !== "union" || lowerer.closureDynLets.size === 0) return null;
  const symbol = lowerer.resolveValueSymbol(expr);
  if (!symbol || !lowerer.closureDynLets.has(symbol)) return null;
  const decl = symbol.valueDeclaration;
  if (!decl) return null;
  const scopeOf = (node: ts.Node): ts.Node | undefined => {
    let at = node.parent;
    while (at !== undefined && !ts.isFunctionLike(at) && !ts.isSourceFile(at)) at = at.parent;
    return at;
  };
  if (scopeOf(expr) === scopeOf(decl)) return null;
  const parent = expr.parent;
  const handle = lowerer.unions.get(type.unionId)?.arms.find((arm) => !isUnitType(arm));
  // Only a use the checker types as the handle narrows: inside a function
  // declared before the first write the binding reads as `any`.
  const typedAsHandle =
    handle !== undefined && typeEquals(lowerer.mapTypeOf(lowerer.typeOf(expr)) ?? DYN, handle);
  if (typedAsHandle && ts.isPropertyAccessExpression(parent) && parent.expression === expr) {
    // An optional read (`c?.address`) tests the tagged value: undefined
    // short-circuits and the handle arm narrows.
    if (parent.questionDotToken) return { kind: "varRef", localId: id, type, loc };
    const helper = lowerer.narrowedArmHelper(
      type.unionId,
      handle,
      loc,
      `Cannot read properties of undefined (reading '${parent.name.text}')`,
    );
    if (helper)
      return lowerer.checkedNarrowCall(
        helper,
        { kind: "varRef", localId: id, type, loc },
        handle,
        loc,
      );
  }
  return {
    kind: "dynFrom",
    value: { kind: "varRef", localId: id, type, loc },
    type: DYN,
    loc,
  };
}
