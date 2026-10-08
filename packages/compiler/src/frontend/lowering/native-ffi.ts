import * as ts from "../ts7/adapter.js";
import { type Lowerer, PoisonError } from "./lowerer.js";
import {
  type IrExpr,
  type SrcLoc,
  ffiClassType,
  ffiSourceParamTypes,
  isFfiCallbackParam,
  isFfiContextParam,
  isFfiReleaseParam,
  typeEquals,
  type IrFfiCallbackParam,
  type IrFfiCallbackParamClass,
  type IrFfiImport,
  type IrFfiReleaseParam,
  type IrFfiReturnClass,
  DYN,
  VOID,
  funcOf,
  type IrLocal,
} from "../../ir/ir.js";
import { locOf } from "../program.js";
import {
  ffiBindingDiag,
  ffiSignatureDiag,
  libCallbackDiag,
  type ScrDiagnostic,
} from "../../diagnostics/diagnostic.js";
import { strLit, varRef } from "../../ir/build.js";

function ffiSourceParams(
  binding: IrFfiImport,
): Exclude<IrFfiImport["params"][number], { context: string }>[] {
  const params: Exclude<IrFfiImport["params"][number], { context: string }>[] = [];
  for (const param of binding.params) {
    if (!isFfiContextParam(param)) params.push(param);
  }
  return params;
}

function ffiParamDisplay(param: ReturnType<typeof ffiSourceParams>[number]): string {
  return isFfiCallbackParam(param)
    ? `callback '${param.callback.id}'`
    : isFfiReleaseParam(param)
      ? `release callback '${param.callback.release}'`
      : `class '${param}'`;
}

/** A native input must cover its full scalar domain before IR widening.
 * Bytes and void have no scalar-domain check. */
function ffiScalarDomain(
  nativeClass: IrFfiCallbackParamClass | IrFfiReturnClass,
): { name: string; flag: ts.TypeFlags } | null {
  switch (nativeClass) {
    case "bytes":
    case "void":
      return null;
    case "i64":
    case "u64":
    case "pointer":
      return { name: "bigint", flag: ts.TypeFlags.BigInt };
    case "bool":
      return { name: "boolean", flag: ts.TypeFlags.Boolean };
    case "cstring":
    case "string":
      return { name: "string", flag: ts.TypeFlags.String };
    default:
      return { name: "number", flag: ts.TypeFlags.Number };
  }
}

/** Callback arguments flow from native code into TypeScript. Their source
 * declarations therefore need to cover the whole scalar domain represented
 * by the manifest class: IR widening alone cannot distinguish `0`, a numeric
 * enum, or `never` from an unrestricted `number`. */
function ffiCallbackInputDiagnostic(
  lowerer: Lowerer,
  descriptor: IrFfiCallbackParam | IrFfiReleaseParam,
  callbackType: ts.Type,
): string | null {
  const signatures = lowerer.checker.getCallSignatures(callbackType);
  if (signatures.length !== 1) return null;

  const nativeParams: IrFfiCallbackParamClass[] = [];
  for (const param of descriptor.callback.params) {
    if (!isFfiContextParam(param)) nativeParams.push(param);
  }
  let nativeIndex = 0;
  const params = signatures[0]!.getParameters();
  for (let i = 0; i < params.length; i++) {
    const paramType = lowerer.checker.getTypeOfSymbol(params[i]!);
    const mapped = lowerer.mapTypeOf(paramType);
    // Function mapping drops a `void` parameter because it consumes no
    // argument. Mirror that alignment before comparing manifest slots.
    if (mapped?.kind === "void") continue;

    const nativeClass = nativeParams[nativeIndex++];
    if (
      nativeClass === undefined ||
      mapped === null ||
      !typeEquals(mapped, ffiClassType(nativeClass))
    ) {
      continue;
    }

    const domain = ffiScalarDomain(nativeClass);
    if (domain === null) continue;
    if ((paramType.flags & domain.flag) === 0) {
      const descriptorName = isFfiCallbackParam(descriptor)
        ? descriptor.callback.id
        : descriptor.callback.release;
      return (
        `callback '${descriptorName}' parameter ${i + 1} is '${lowerer.checker.typeToString(paramType)}', ` +
        `but native class '${nativeClass}' may supply any ${domain.name}; declare it as '${domain.name}'`
      );
    }
  }

  return null;
}

/** Values returned by native code flow into TypeScript, so a declaration
 * must admit the whole scalar domain the ABI class can produce. `mapType`
 * intentionally widens literal and enum types to their storage type; that
 * is sound for script-owned values but not for an external return contract
 * (`(): true` cannot describe a bool callback that is free to return false). */
function ffiReturnDomainDiagnostic(
  lowerer: Lowerer,
  nativeClass: IrFfiImport["returns"],
  returnType: ts.Type,
): string | null {
  const domain = ffiScalarDomain(nativeClass);
  if (domain === null) return null;
  return (returnType.flags & domain.flag) !== 0
    ? null
    : `the return type is '${lowerer.checker.typeToString(returnType)}', but native class '${nativeClass}' may supply ` +
        `any ${domain.name}; declare it as '${domain.name}'`;
}

/** The binding surface's diagnostic flavor: native-manifest bindings
 * speak the SC5002/SC5003 FFI codes; library-mode host callbacks are the
 * same recognition machinery under the profile's vocabulary — SC4024 for
 * both the binding and signature halves, with "manifest" respelled
 * "profile" in the shared detail strings so the teaching names the
 * document the author actually edits. */
function ffiFlavor(lowerer: Lowerer): {
  binding: (name: string, detail: string, loc: SrcLoc) => ScrDiagnostic;
  signature: (name: string, detail: string, loc: SrcLoc) => ScrDiagnostic;
} {
  if (!lowerer.libraryCallbacks) return { binding: ffiBindingDiag, signature: ffiSignatureDiag };
  const lib = (name: string, detail: string, loc: SrcLoc): ScrDiagnostic =>
    libCallbackDiag(name, detail.replaceAll("manifest", "profile"), loc);
  return { binding: lib, signature: lib };
}

/** The declaration half of an outbound FFI binding. Kept independent of
 * call-site argument checks so the whole manifest can be validated even
 * when a configured function is never called. */
function ffiDeclarationDiagnostic(
  lowerer: Lowerer,
  binding: IrFfiImport,
  symbol: ts.Symbol,
  loc: SrcLoc,
): ScrDiagnostic | null {
  const { binding: bindingDiag, signature: signatureDiag } = ffiFlavor(lowerer);
  const declarations = lowerer.checker.declarationsOf(symbol);
  const functionDecls = declarations.filter(ts.isFunctionDeclaration);
  if (
    functionDecls.length === 0 ||
    declarations.some((decl) => !ts.isFunctionDeclaration(decl)) ||
    functionDecls.some((decl) => decl.body !== undefined)
  ) {
    return bindingDiag(
      binding.name,
      "the configured name does not resolve exclusively to signature-only function declarations",
      loc,
    );
  }
  if (functionDecls.some((decl) => (decl.typeParameters?.length ?? 0) > 0)) {
    return signatureDiag(
      binding.name,
      "generic ambient declarations cannot describe one fixed C ABI",
      loc,
    );
  }
  const signatures = lowerer.checker.getCallSignatures(lowerer.checker.getTypeOfSymbol(symbol));
  if (signatures.length !== 1) {
    return signatureDiag(
      binding.name,
      `the ambient binding has ${signatures.length} call signatures; exactly one non-overloaded signature is required`,
      loc,
    );
  }
  const signature = signatures[0]!;
  const params = signature.getParameters();
  const sourceParams = ffiSourceParams(binding);
  if (params.length !== sourceParams.length) {
    return signatureDiag(
      binding.name,
      `the TypeScript declaration has ${params.length} parameter(s), but the manifest declares ${sourceParams.length} source parameter(s) ` +
        `(${binding.params.length - sourceParams.length} additional native context slot(s) are compiler-supplied)`,
      loc,
    );
  }
  const expectedParams = ffiSourceParamTypes(binding.params);
  for (let i = 0; i < params.length; i++) {
    const paramType = lowerer.checker.getTypeOfSymbol(params[i]!);
    const sourceParam = sourceParams[i]!;
    // `mapType` deliberately gives uninhabited value positions a cheap f64
    // slot because no TypeScript value can ever reach them. An FFI
    // declaration is different: it is a callable external contract, so a
    // `never` slot cannot truthfully describe any native parameter.
    if ((paramType.flags & ts.TypeFlags.Never) !== 0) {
      return signatureDiag(
        binding.name,
        `parameter ${i + 1} is 'never', an uninhabited TypeScript type that cannot describe a native ABI parameter`,
        loc,
      );
    }
    if (isFfiCallbackParam(sourceParam) || isFfiReleaseParam(sourceParam)) {
      const callbackDiagnostic = ffiCallbackInputDiagnostic(lowerer, sourceParam, paramType);
      if (callbackDiagnostic !== null) {
        return signatureDiag(binding.name, callbackDiagnostic, loc);
      }
    }
    const mapped = lowerer.mapTypeOf(paramType);
    const expected = expectedParams[i]!;
    if (mapped === null || !typeEquals(mapped, expected)) {
      return signatureDiag(
        binding.name,
        `parameter ${i + 1} maps to '${mapped === null ? lowerer.checker.typeToString(paramType) : lowerer.fmt(mapped)}', ` +
          `which does not fit manifest ${ffiParamDisplay(sourceParam)}`,
        loc,
      );
    }
  }
  const returnType = lowerer.checker.getReturnTypeOfSignature(signature);
  // A native function is allowed to return. Accepting `never` here would
  // let tsc erase all control flow after the call while the linked function
  // continues, making the generated program disagree with TypeScript.
  if ((returnType.flags & ts.TypeFlags.Never) !== 0) {
    return signatureDiag(
      binding.name,
      "the return type is 'never', but a native ABI return cannot uphold TypeScript's non-returning contract",
      loc,
    );
  }
  const declaredReturn = lowerer.mapTypeOf(returnType);
  const expectedReturn = ffiClassType(binding.returns);
  if (declaredReturn === null || !typeEquals(declaredReturn, expectedReturn)) {
    return signatureDiag(
      binding.name,
      `the return maps to '${declaredReturn === null ? lowerer.checker.typeToString(returnType) : lowerer.fmt(declaredReturn)}', ` +
        `which does not fit manifest class '${binding.returns}'`,
      loc,
    );
  }
  const returnDomainDiagnostic = ffiReturnDomainDiagnostic(lowerer, binding.returns, returnType);
  if (returnDomainDiagnostic !== null) {
    return signatureDiag(binding.name, returnDomainDiagnostic, loc);
  }
  return null;
}

export interface FfiValidationResult {
  diagnostics: ScrDiagnostic[];
  symbolsByName: ReadonlyMap<string, ReadonlySet<ts.Symbol>>;
}

/** True when a library callback may claim declarations from this file.
 * Ordinary program source is always eligible. Declaration files are
 * eligible only when they are project-owned: the standard library and
 * installed/workspace package declarations are existing ambient surfaces,
 * never callback declarations merely because a profile channel shares their
 * spelling. */
function libraryCallbackOwnsFile(lowerer: Lowerer, file: ts.SourceFile): boolean {
  return !file.isDeclarationFile || (!lowerer.isStdlibFile(file) && !lowerer.isNpmFile(file));
}

/** Resolve and validate every configured outbound binding before emit.
 * Candidate declarations are signature-only functions bearing the manifest
 * name anywhere in the program. Multiple scoped declarations are all native
 * bindings under the existing name-based call surface, so every candidate
 * must fit the one manifest ABI. Library callbacks additionally exclude
 * standard-library and package declaration files while retaining project
 * declaration files as authored callback surface. */
export function validateFfiImports(lowerer: Lowerer): FfiValidationResult {
  const diagnostics: ScrDiagnostic[] = [];
  const symbolsByName = new Map<string, ReadonlySet<ts.Symbol>>();
  const configuredNames = new Set(
    lowerer.ffiImports
      .filter((binding) => binding.library === undefined)
      .map((binding) => binding.name),
  );
  const candidates = new Map<string, Map<ts.Symbol, ts.FunctionDeclaration>>();

  if (configuredNames.size === 0) return { diagnostics, symbolsByName };

  for (const file of lowerer.program.getSourceFiles()) {
    if (lowerer.libraryCallbacks && !libraryCallbackOwnsFile(lowerer, file)) continue;
    ts.walkPreorder(file, (node) => {
      if (ts.isFunctionDeclaration(node)) {
        if (
          node.body === undefined &&
          node.name !== undefined &&
          configuredNames.has(node.name.text)
        ) {
          const symbol = lowerer.checker.getSymbolAtLocation(node.name);
          if (symbol !== undefined) {
            let bySymbol = candidates.get(node.name.text);
            if (bySymbol === undefined) {
              bySymbol = new Map();
              candidates.set(node.name.text, bySymbol);
            }
            if (!bySymbol.has(symbol)) bySymbol.set(symbol, node);
          }
        }
        return "skip";
      }
      if (ts.isFunctionLike(node)) return "skip";
    });
  }

  for (const binding of lowerer.ffiImports) {
    if (binding.library !== undefined) continue;
    const bySymbol = candidates.get(binding.name);
    if (bySymbol === undefined || bySymbol.size === 0) {
      // A native-manifest binding with no declaration is a broken build
      // input. A library callback channel with no declaration is unused
      // CAPACITY: the registration symbol still dispatches it, nothing
      // calls it, and a later program revision may (a program that calls
      // the name without declaring it fails ordinary typechecking first).
      if (!lowerer.libraryCallbacks) {
        diagnostics.push(
          ffiBindingDiag(
            binding.name,
            "the program has no signature-only function declaration with this name",
            { file: lowerer.entry.fileName, start: 0, end: 0 },
          ),
        );
      } else {
        // Preserve the distinction between unused capacity and a binding
        // whose program declaration was found but failed validation. The
        // latter deliberately leaves no map entry so calls poison without
        // duplicating the program-level diagnostic; the empty set lets call
        // lowering inspect same-named builtins, implementations, and
        // unsupported ambient declaration shapes individually.
        symbolsByName.set(binding.name, new Set());
      }
      continue;
    }
    const validSymbols = new Set<ts.Symbol>();
    let valid = true;
    for (const [symbol, declaration] of bySymbol) {
      const diagnostic = ffiDeclarationDiagnostic(lowerer, binding, symbol, locOf(declaration));
      if (diagnostic === null) {
        validSymbols.add(symbol);
      } else {
        diagnostics.push(diagnostic);
        valid = false;
      }
    }
    if (valid) symbolsByName.set(binding.name, validSymbols);
  }

  return { diagnostics, symbolsByName };
}

/** A manifest-bound call of a signature-only ambient declaration. This
 * recognition deliberately runs before ambientUndefVarRootOf: without the
 * manifest the exact same source keeps Node's ReferenceError semantics;
 * with it, only the resolved declaration binding (never a shadowing
 * function with a body) becomes a direct native call. */
export function lowerFfiCall(lowerer: Lowerer, expr: ts.CallExpression): IrExpr | null {
  if (!ts.isIdentifier(expr.expression)) return null;
  const binding = lowerer.ffiImportsByName.get(expr.expression.text);
  if (binding?.library !== undefined) return null;
  if (binding === undefined) {
    // LIBRARY mode with a declared callback surface: a CALL of a
    // program-authored signature-only ambient function that names no
    // channel is the author reaching for the host seam the profile does
    // not provide — refuse with the callback teaching instead of the
    // ambient ReferenceError lowering. Scoped to project-owned source and
    // declaration files so lib.d.ts/@types/package ambients (parseInt,
    // setTimeout, …) keep every existing lowering; callback-free profiles
    // are untouched.
    if (lowerer.libraryCallbacks) {
      const symbol = lowerer.resolveValueSymbol(expr.expression);
      const decls = symbol === null ? [] : lowerer.checker.declarationsOf(symbol);
      const callbackShaped =
        decls.length > 0 &&
        decls.every(
          (decl) =>
            ts.isFunctionDeclaration(decl) &&
            decl.body === undefined &&
            libraryCallbackOwnsFile(lowerer, decl.getSourceFile()),
        );
      if (callbackShaped) {
        lowerer.pushDiag(
          libCallbackDiag(
            expr.expression.text,
            "the profile declares no callback channel with this name",
            locOf(expr),
          ),
        );
        throw new PoisonError();
      }
    }
    return null;
  }
  const loc = locOf(expr);
  const { binding: bindingFlavor, signature: signatureFlavor } = ffiFlavor(lowerer);
  const bindingError: (detail: string) => never = (detail) => {
    lowerer.pushDiag(bindingFlavor(binding.name, detail, loc));
    throw new PoisonError();
  };
  const signatureError = (detail: string): never => {
    lowerer.pushDiag(signatureFlavor(binding.name, detail, loc));
    throw new PoisonError();
  };
  const symbol = lowerer.resolveValueSymbol(expr.expression);
  if (!symbol) bindingError("the call has no resolved TypeScript symbol");
  if (lowerer.ffiBindingSymbols !== null) {
    const validSymbols = lowerer.ffiBindingSymbols.get(binding.name);
    // No entry means the program-level pass already diagnosed this
    // binding. Poison the statement without duplicating that diagnostic.
    if (validSymbols === undefined) throw new PoisonError();
    if (!validSymbols.has(symbol)) {
      if (lowerer.libraryCallbacks) {
        const declarations = lowerer.checker.declarationsOf(symbol);
        const programDeclarations = declarations.filter((decl) =>
          libraryCallbackOwnsFile(lowerer, decl.getSourceFile()),
        );
        const programAmbient =
          programDeclarations.length > 0 &&
          programDeclarations.every(
            (decl) =>
              decl.getSourceFile().isDeclarationFile ||
              (ts.getCombinedModifierFlags(decl as ts.Declaration) & ts.ModifierFlags.Ambient) !==
                0,
          );
        if (programAmbient) {
          // A called, program-authored ambient with a configured channel
          // name is not unused capacity. Validate the resolved symbol now
          // so unsupported declaration forms (`declare const cb: ...`)
          // refuse SC4024 instead of silently dropping the call. A valid
          // declaration missed by the up-front syntax walk may proceed as
          // the callback binding after this exact-symbol check.
          const diagnostic = ffiDeclarationDiagnostic(lowerer, binding, symbol, loc);
          if (diagnostic !== null) {
            lowerer.pushDiag(diagnostic);
            throw new PoisonError();
          }
        } else {
          // Standard-library/package ambients and same-named program
          // implementations remain their ordinary TypeScript bindings;
          // the profile does not claim them.
          return null;
        }
      } else {
        // TypeScript resolved this call to a distinct local declaration.
        // The manifest owns only the exact validated ambient binding; a
        // same-named function with a body remains ordinary scriptc code.
        return null;
      }
    }
  } else {
    const diagnostic = ffiDeclarationDiagnostic(lowerer, binding, symbol, loc);
    if (diagnostic !== null) {
      lowerer.pushDiag(diagnostic);
      throw new PoisonError();
    }
  }
  if (expr.questionDotToken !== undefined || expr.typeArguments !== undefined) {
    signatureError("native bindings support direct, non-generic calls only");
  }
  if (expr.arguments.some(ts.isSpreadElement)) {
    signatureError("spread arguments do not have a fixed native ABI");
  }
  const expectedParams = ffiSourceParamTypes(binding.params);
  if (expr.arguments.length !== expectedParams.length) {
    signatureError(
      `this call passes ${expr.arguments.length} argument(s), but the native binding requires exactly ${expectedParams.length}`,
    );
  }
  const expectedReturn = ffiClassType(binding.returns);
  const sourceParams = ffiSourceParams(binding);
  const args = expr.arguments.map((arg, i) => {
    const sourceParam = sourceParams[i]!;
    const expected = expectedParams[i]!;
    const lowered = lowerer.lowerExprExpecting(arg, expected);
    // Retained identity is the runtime closure pointer. A coercion adapter
    // would be freshly allocated at registration and release sites, so an
    // assignable-but-different function shape (notably `() => number` into
    // `() => void`) cannot honestly participate in explicit release. Script
    // identity roots do not help here: native code receives and matches the
    // registered context pointer itself, never the script function. The
    // adapter set comes from the mint sites themselves (Lowerer's
    // freshClosureAdapters), not name-prefix matching, so a new coercion
    // helper cannot silently slip past this guard.
    if (
      isFfiReleaseParam(sourceParam) ||
      (isFfiCallbackParam(sourceParam) && sourceParam.callback.lifetime === "retained")
    ) {
      if (
        lowered.kind === "dynCheck" ||
        (lowered.kind === "call" && lowerer.freshClosureAdapters.has(lowered.callee))
      ) {
        signatureError(
          `retained callback argument ${i + 1} must have the exact manifest function type; ` +
            `an implicit function adapter would change its release identity`,
        );
      }
      // An inline function value at a RELEASE site can never match:
      // lifted lambdas always carry a captures list (even an empty one),
      // so the backend creates a fresh closure per evaluation of the
      // expression — the release argument is a pointer no registration
      // holds, a guaranteed runtime trap. Declared functions stay valid
      // here — their value is the interned immortal closure (captures
      // undefined), one pointer for every mention. Registration sites
      // still accept literals: an unnameable registration is simply
      // permanent, released by the exit teardown (the live-at-exit
      // fixture shape), and hides no matching failure.
      if (
        isFfiReleaseParam(sourceParam) &&
        lowered.kind === "closure" &&
        lowerer.liftedFns.some((f) => f.name === lowered.fnName && f.captures !== undefined)
      ) {
        signatureError(
          `retained callback argument ${i + 1} cannot be an inline function value; ` +
            `each evaluation creates a fresh closure no registration holds — ` +
            `pass the same named value used to register`,
        );
      }
    }
    return lowered;
  });
  return {
    kind: "ffiCall",
    import: binding.name,
    args,
    type: expectedReturn,
    loc,
  };
}

/** Compile node:ffi's library catalog into ordinary native closures. No
 * runtime resolver, executable code generation, or engine is involved. */
export function lowerFfiMemoryModule(lowerer: Lowerer, loc: SrcLoc): IrExpr {
  const text = (value: string): IrExpr => ({
    kind: "dynFrom",
    value: strLit(value, loc),
    type: DYN,
    loc,
  });
  const object = (fields: Record<string, IrExpr>): IrExpr => ({
    kind: "dynObjLit",
    fields: Object.entries(fields).map(([key, value]) => ({ key: strLit(key, loc), value })),
    type: DYN,
    loc,
  });
  const entries = lowerer.ffiImports
    .filter((entry) => entry.library !== undefined)
    .map((entry) => {
      const name = `%ffi.module.${lowerer.lambdaCounter++}`;
      const sourceTypes = ffiSourceParamTypes(entry.params);
      const locals: IrLocal[] = sourceTypes.map((_, i) => ({
        id: `%arg${i}`,
        name: `arg${i}`,
        type: DYN,
        mutable: false,
      }));
      const args: IrExpr[] = entry.params.map((param, i) => ({
        kind: "dynCheck",
        type: sourceTypes[i]!,
        loc,
        value:
          typeof param === "string"
            ? {
                kind: "libCall",
                fn: "ffi.argument",
                args: [varRef(locals[i]!.id, DYN, loc), strLit(param, loc)],
                type: DYN,
                loc,
              }
            : varRef(locals[i]!.id, DYN, loc),
      }));
      const resultType = ffiClassType(entry.returns);
      const call: IrExpr = { kind: "ffiCall", import: entry.name, args, type: resultType, loc };
      lowerer.liftedFns.push({
        name,
        params: locals.map((local) => ({ localId: local.id, name: local.name, type: DYN })),
        locals,
        returnType: resultType.kind === "void" ? VOID : DYN,
        body:
          resultType.kind === "void"
            ? [
                { kind: "exprStmt", expr: call, loc },
                { kind: "return", value: null, loc },
              ]
            : [{ kind: "return", value: { kind: "dynFrom", value: call, type: DYN, loc }, loc }],
        loc,
      });
      const closure: IrExpr = {
        kind: "closure",
        fnName: name,
        captures: [],
        type: funcOf(
          locals.map(() => DYN),
          resultType.kind === "void" ? VOID : DYN,
        ),
        loc,
      };
      const callback = entry.params.find((param) => isFfiCallbackParam(param))?.callback;
      return object({
        library: text(entry.library!),
        name: text(entry.name),
        operation: text(entry.callbackOperation ?? "call"),
        target: text(entry.callbackTarget ?? ""),
        arguments: {
          kind: "dynArrLit",
          elems: (callback?.params ?? entry.params).map((param) => text(param as string)),
          type: DYN,
          loc,
        },
        return: text(callback?.returns ?? entry.returns),
        call: { kind: "dynFrom", value: closure, type: DYN, loc },
      });
    });
  return {
    kind: "libCall",
    fn: "ffi.memoryModule",
    args: [{ kind: "dynArrLit", elems: entries, type: DYN, loc }],
    type: DYN,
    loc,
  };
}
