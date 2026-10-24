/* Identifier references in expression position: lowerExprInner's identifier branch and its helpers. */
import { predeclareForwardClass } from "../lower-stmts.js";
import { cjsMemberAliasValueOf } from "../cjs-exports-object.js";
import { builtinClassValue, builtinMemberClassKind } from "../builtins/builtin-class-dyn.js";
import * as ts from "../../ts7/adapter.js";
import { InternalCompilerError } from "../../../errors.js";
import * as posix from "node:path/posix";
import { type Lowerer, PoisonError } from "../lowerer.js";
import {
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
} from "../../../ir/ir.js";
import { lowerNodeModuleIdentifier } from "../lower-node-module.js";
import { lowerCjsExportsObjectValue } from "../cjs-exports-object.js";
import {
  splitRequireBindingOfIdent,
  wholeExportSymbolOfModule,
  wholeExportValue,
} from "../cjs-inline-require.js";
import { captureContextArguments } from "../function-context.js";
import { argumentsOwner, typedArgumentsCandidate } from "../typed-arguments.js";
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
  primitiveCtorClosure,
  runtimeOptionalElementKey,
  runtimeOptionalUseOf,
} from "../lower-exprs.js";
import { runtimeOptionalReceiverRead } from "./narrowing.js";
import { iterableUnionOf } from "../iterable-values.js";
import { builtinGlobalValueAt } from "./property-access.js";
import { varRef } from "../../../ir/build.js";
import {
  ambientUndefReadType,
  ambientUndefinedFnSymbolOf,
  contextualUndefReadType,
  fenceEarlyAliasUse,
  isTemporalGlobalRoot,
  cjsNamespaceImportDep,
  lowerNsIdentifierValue,
  nsUndefRead,
} from "../lower-namespaces.js";
import {
  blockedBindingUseDiag,
  unsupportedDiag,
  unsupportedPackageValueDiag,
} from "../../../diagnostics/diagnostic.js";
import { dirname } from "node:path";
import { funcTypeFromParamShapes } from "../call-signatures.js";
import { threadsImportOf } from "../../threads-import.js";
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
import { builtinConstantsObject } from "../lower-builtin-values.js";
import { lowerTlsRootCertificates } from "../lower-server.js";
import { builtinFunctionFenceValue } from "../builtin-function-fences.js";
import { unsupportedModuleFeatureOf } from "../../builtin-modules.js";
import { lowerGlobalValue } from "../lower-global-value.js";
import { fenceEnumObjectValue } from "../lower-enums.js";
import { mixinFnOfCallee } from "../lower-mixins.js";
import { isNavigatorGlobal, refuseNavigator } from "../builtins/navigator.js";
import { wasiGuestPath } from "../../../wasi-paths.js";

export function lowerIdentifierExpr(lowerer: Lowerer, expr: ts.Identifier, loc: SrcLoc): IrExpr {
  if (lowerer.isStdlibGlobal(expr, "console")) {
    return { kind: "libCall", fn: "console.native", args: [], type: DYN, loc };
  }

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
    if (binding && lowerer.ctx.pureTuples.has(binding.id)) {
      throw new InternalCompilerError("lowerer bug: forwarded-only 'arguments' read as a value");
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
    // object. JavaScript files keep the identity token.
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
  // Union-typed bindings read through tsc's control-flow narrowing:
  // when the checker types this USE as a single arm, maybeNarrow
  // bridges the tagged representation with a unionNarrow.
  const local = lowerer.resolveLocal(expr);
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
  // `import x = N.y` aliases resolve transparently through globalOf/
  // fnSigOf below; their source-order guards live here (a no-op for
  // every non-import= binding — see lower-namespaces.ts).
  fenceEarlyAliasUse(lowerer, expr, expr);
  const g = lowerer.globalOf(expr);
  if (g) {
    // A global typed by a class that never REGISTERED (its collection
    // fenced): the initializing assignment never lowered, so the read
    // can only observe garbage — and the emitter would name a struct
    // that does not exist. The blocked-binding cascade names the use;
    // without this the validator's registration check ICEs on the live
    // reference (`@this {T}` inference — signature 07).
    const unregistered = lowerer.unregisteredClassOf(g.type, new Set());
    if (unregistered !== null) {
      // The class's own rejection is the root cause the cascade names.
      lowerer.flushDeferredClass(unregistered);
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
    return { kind: "closure", fnName: sig.name, captures: [], type: funcType, loc };
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
        const value = lowerWorkerMetadata(bi.member, loc);
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
      // JavaScript sources: an otherwise unsupported builtin VALUE is
      // the same identity-token story as stdlib globals above (the
      // harness adds worker_threads.Worker to its identity Set).
      if (isJsSourceFile(ts.getSourceFileOfNode(expr))) {
        // EventEmitter and the stream classes are the runtime's untyped
        // constructors, so constructor functions can inherit from them.
        const classKind = builtinMemberClassKind(bi.module, bi.member);
        if (classKind !== null) return builtinClassValue(classKind, loc);
        // A function member is a function value that fences when called.
        if (builtinModuleFnOf(lowerer, bi.module, bi.member))
          return builtinFunctionFenceValue(lowerer, bi, expr, loc);
        return {
          kind: "strLit",
          // node:stream/web exports the web stream globals themselves:
          // the same identity token as the global spelling.
          value:
            bi.module === "stream/web"
              ? `[builtin ${bi.member}]`
              : `[builtin ${bi.module}.${bi.member}]`,
          type: STRING,
          loc,
        };
      }
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
  // A builtin namespace import used as a bare VALUE (`const f = fs`):
  // the namespace object has no representation — members lower at
  // their access sites only. The CommonJS namespace binding
  // (`const lib = require("./lib.js")`) gets the same fence.
  const builtinNamespace = lowerer.builtinNamespaceModuleOf(expr);
  if (builtinNamespace === "constants") return builtinConstantsObject(lowerer, loc);
  if (builtinNamespace !== null) {
    const type: IrType = { kind: "moduleNs", moduleId: `builtin:${builtinNamespace}` };
    return { kind: "moduleNsRef", moduleId: type.moduleId, type, loc };
  }
  if (lowerer.cjsLocalModuleBindingOf(expr)) {
    lowerer.unsupported(
      "SC1090",
      expr,
      `module namespace objects as values (access '${expr.text}' members directly)`,
    );
  }
  if (lowerer.stdlibGlobalFnOf(expr)) {
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
    const sym = lowerer.checker.getSymbolAtLocation(expr);
    if (lowerer.isStdlibSymbol(sym)) {
      return { kind: "numLit", value: expr.text === "NaN" ? NaN : Infinity, type: F64, loc };
    }
  }
  // The primitive constructors as VALUES (`const f = String`, an
  // option table's `type: Boolean` field, `opt.type === Number`): the
  // interned coercion closure — one synthesized module function per
  // constructor per program, so every reference is the SAME zero-
  // capture closure and `===` is JS identity (the type mapping in
  // type-mapper.ts pins the one concrete signature `(value: string) =>
  // primitive`; direct calls `String(x)` never reach here — the call
  // lowering intercepts them with the wider static coercions).
  const jsPrimitiveCtorSelector = isJsSourceFile(ts.getSourceFileOfNode(expr));
  const primitiveName = stdlibGlobalNameOf(lowerer, expr);
  if (
    primitiveName === "String" ||
    primitiveName === "Number" ||
    primitiveName === "Boolean" ||
    primitiveName === "BigInt"
  ) {
    return primitiveCtorClosure(lowerer, primitiveName, loc, jsPrimitiveCtorSelector);
  }
  if (lowerer.isStdlibGlobal(expr, "ArrayBuffer"))
    return { kind: "libCall", fn: "arrayBuffer.constructor", args: [], type: DYN, loc };
  if (isJsSourceFile(ts.getSourceFileOfNode(expr)) && lowerer.isStdlibGlobal(expr, "Array"))
    return { kind: "libCall", fn: "dyn.arrayConstructor", args: [], type: DYN, loc };
  if (
    Object.values(BYTES_ELEMENT_NAME).includes(expr.text) &&
    lowerer.isStdlibSymbol(lowerer.checker.getSymbolAtLocation(expr))
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
    const name = `%builtin.${expr.text}`;
    const type = funcOf([DYN], STRING);
    if (!lowerer.liftedFns.some((fn) => fn.name === name)) {
      const value: IrExpr = {
        kind: "libCall",
        fn: "dyn.toStringCoerce",
        args: [varRef("value", DYN, loc)],
        type: STRING,
        loc,
      };
      const fn =
        expr.text === "encodeURIComponent"
          ? "str.encodeUriComponent"
          : expr.text === "encodeURI"
            ? "str.encodeUri"
            : expr.text === "decodeURI"
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
  if (lowerer.isStdlibGlobal(expr, "crypto"))
    return { kind: "libCall", fn: "webcrypto.object", args: [], type: DYN, loc };
  const nativeAlias = stdlibGlobalNameOf(lowerer, expr);
  if (nativeAlias === "Buffer" && expr.text !== "Buffer") {
    // An alias through a cast of globalThis carries the cast's static type,
    // which the identity token below does not have.
    const aliasSymbol = identifierReadSymbol(lowerer, expr);
    if (aliasSymbol && lowerer.castGlobalAliases.has(aliasSymbol)) {
      lowerer.unsupported(
        "SC1090",
        expr,
        "the Buffer constructor read through a cast of globalThis as a value",
        "test it in a condition, read its typeof, or call its members",
      );
    }
    // JavaScript reads the Buffer function's value (builtinGlobalValue).
    if (isJsSourceFile(ts.getSourceFileOfNode(expr)))
      return { kind: "libCall", fn: "buffer.constructor", args: [], type: DYN, loc };
    return { kind: "strLit", value: "[builtin Buffer]", type: STRING, loc };
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
  // path — call sites lower earlier) becomes an opaque IDENTITY TOKEN:
  // an interned string naming the global. Identity flows (the
  // harness's knownGlobals Set, === comparisons) are exact — one
  // global, one token; what a token cannot do (be called, answer
  // typeof "function") meets per-site fences/divergences, and
  // SEMANTICS.md documents the stance.
  if (stdlibGlobalNameOf(lowerer, expr) === "globalThis") {
    return lowerGlobalValue(lowerer, expr);
  }
  {
    const sym = identifierReadSymbol(lowerer, expr);
    // The temporal global is typed (TS 7's lib slice) but Node 24 does
    // not define it: the read throws Node's ReferenceError.
    if (isTemporalGlobalRoot(lowerer, expr, sym)) {
      const t =
        ambientUndefReadType(lowerer, expr) ?? contextualUndefReadType(lowerer, expr) ?? F64;
      return nsUndefRead(lowerer, expr.text, expr, t);
    }
    if (lowerer.isStdlibSymbol(sym) || expr.text === "globalThis") {
      const canonical = stdlibGlobalNameOf(lowerer, expr) ?? expr.text;
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
      if (isJsSourceFile(ts.getSourceFileOfNode(expr))) {
        return { kind: "strLit", value: `[builtin ${canonical}]`, type: STRING, loc };
      }
      // The families with a WHY: each hint states what makes the
      // surface genuinely non-static (or what to use instead).
      const globalHints: Record<string, string | undefined> = {
        Proxy:
          "Proxy constructor values have no native lowering; use a direct new Proxy with checked-native plain objects",
        Reflect:
          "reflective property access has no static lowering — read and call members directly",
        Intl: 'native Intl supports default Unicode grapheme segmentation and the composed new Intl.NumberFormat("en-US").format(x); locale negotiation and other ICU-backed operations remain unsupported',
        SharedArrayBuffer: "use direct new SharedArrayBuffer(length) for fixed shared storage",
        ArrayBuffer:
          "ArrayBuffer constructor values have no native lowering; use new ArrayBuffer(length) for fixed-length shared storage",
        WeakRef:
          "deref()-after-collect exposes GC timing — genuinely dynamic; hold a strong reference instead",
        eval: "runtime code evaluation cannot be compiled ahead of time",
      };
      lowerer.noLowering(expr.text, expr, globalHints[expr.text], sym ?? undefined);
    }
  }
  // An ambient global nothing defines compiles to exactly what Node does
  // at the access: the catchable ReferenceError "<name> is not defined".
  // Stdlib/@types/node ambients never reach here (their chokepoint
  // is above); only user-file declares do.
  {
    const sym = lowerer.resolveValueSymbol(expr);
    const decl = sym ? sym.declarations[0] : undefined;
    if (
      decl !== undefined &&
      ts.isVariableDeclaration(decl) &&
      decl.initializer === undefined &&
      ts.getCombinedModifierFlags(decl) & ts.ModifierFlags.Ambient
    ) {
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
    // access hooks fold them): iteration, storage, reverse lookups
    // through variables all land on this pointed fence.
    if (sym) fenceEnumObjectValue(lowerer, expr, sym);
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
  if (isNavigatorGlobal(lowerer, expr)) {
    refuseNavigator(
      lowerer,
      expr,
      "the navigator object as a value",
      lowerer.checker.getSymbolAtLocation(expr),
    );
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
  // Preflight guarantees no unresolved identifiers; anything else here
  // is a blocked declaration's binding (the SC2004 cascade) or a
  // binding form we don't model yet.
  lowerer.rejectUnresolved(
    expr,
    `the reference to '${expr.text}' (a binding form with no lowering)`,
  );
}

function moduleFileName(lowerer: Lowerer, sf: ts.SourceFile): string {
  return lowerer.targetPlatform === "wasi"
    ? (wasiGuestPath(sf.fileName) ?? sf.fileName.replace(/\\/g, "/"))
    : sf.fileName;
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
