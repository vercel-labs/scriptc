import { dynUndefinedExpr, nodeThrowExpr, boolLit, strLit, varRef } from "../../../ir/build.js";
import { dirname, isAbsolute, resolve } from "node:path";
import * as ts from "../../ts7/adapter.js";
import { type Lowerer, PoisonError } from "../lowerer.js";
import { canonicalBuiltinModule, isJsSourceFile, isNodeEsmFile, locOf } from "../../program.js";
import { isRelativeSpecifier } from "../../workspace-registry.js";
import { probeNodeRequireRefusal } from "../../npm.js";
import { isNpmStaticPackage } from "../../npm-static.js";
import { trackedReadFile } from "../../input-tracker.js";
import {
  requireResolvePathsRuntime,
  resolveImportMetaRuntime,
  resolveRequireRuntime,
  type RuntimeResolveError,
  type RuntimeResolveResult,
} from "../../runtime-resolve.js";
import {
  computedRequireDiag,
  invalidJsonModuleDiag,
  nativeAddonDiag,
  noLoweringDiag,
  unsupportedPackageImportDiag,
} from "../../../diagnostics/diagnostic.js";
import { NODE_BUILTIN_MODULES_V24, builtinModulesArrayLit } from "../surfaces.js";
import { moduleFileName } from "../import-meta.js";
import {
  BOOL,
  DYN,
  type IrExpr,
  type IrStmt,
  type IrType,
  NULL_T,
  STRING,
  type SrcLoc,
  UNDEFINED_T,
  arrayOf,
  funcOf,
} from "../../../ir/ir.js";
import { lowerFfiMemoryModule } from "../native-ffi.js";
import {
  createRequireSpecOf,
  createRequireProgramModuleOf,
  createRequireCalleeFileOf,
} from "./module-bindings.js";
import { stripTypeCasts } from "./arguments.js";
import { keyedHelperName } from "../stable-names.js";

/** node:module's two compiler-only calls. isBuiltin compares one evaluated
 * string against the pinned Node 24 list (bare builtins also accept their
 * node: spelling; prefix-only entries do not gain a bare alias).
 * syncBuiltinESMExports takes no arguments and returns undefined; as a
 * statement it refreshes the events module's ES module namespace copy of
 * defaultMaxListeners (lowerExprStatement), the one builtin export a program
 * can change. */
export function lowerNodeModuleCall(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  bi: { module: string; member: string },
  loc: SrcLoc,
): IrExpr | null {
  if (bi.module !== "module") return null;
  if (bi.member === "syncBuiltinESMExports") {
    if (expr.arguments.nodes.length !== 0 || expr.arguments.nodes.some(ts.isSpreadElement)) {
      lowerer.noLowering(
        `module.syncBuiltinESMExports with ${expr.arguments.nodes.length} arguments`,
        expr,
        "syncBuiltinESMExports() takes no arguments",
      );
    }
    if (!ts.isExpressionStatement(expr.parent)) {
      lowerer.noLowering(
        "module.syncBuiltinESMExports used as a value",
        expr,
        "call syncBuiltinESMExports() as its own statement",
      );
    }
    return { kind: "unitLit", unit: "undefined", type: UNDEFINED_T, loc };
  }
  if (bi.member !== "isBuiltin") return null;
  if (expr.arguments.nodes.length !== 1 || expr.arguments.nodes.some(ts.isSpreadElement)) {
    lowerer.noLowering(
      `module.isBuiltin with ${expr.arguments.nodes.length} arguments`,
      expr,
      "isBuiltin(moduleName) takes one string",
    );
  }
  const argumentNode = expr.arguments.nodes[0]!;
  const argument = lowerer.lowerExpr(argumentNode);
  if (argument.type.kind !== "string") {
    if (argument.type.kind === "dyn" || argument.type.kind === "union") {
      lowerer.noLowering(
        "module.isBuiltin with a runtime-polymorphic argument",
        argumentNode,
        "narrow the module name to a string first; statically non-string values return false",
      );
    }
    return {
      kind: "seqExpr",
      stmts: [{ kind: "exprStmt", expr: argument, loc: locOf(argumentNode) }],
      result: boolLit(false, loc),
      type: BOOL,
      loc,
    };
  }
  const slot = lowerer.declareHiddenLocal("%builtinName", STRING);
  const ref = (): IrExpr => varRef(slot.id, STRING, loc);
  const accepted = NODE_BUILTIN_MODULES_V24.flatMap((name) =>
    name.startsWith("node:") ? [name] : [name, `node:${name}`],
  );
  let staticArgument: ts.Expression = argumentNode;
  while (
    ts.isParenthesizedExpression(staticArgument) ||
    ts.isAsExpression(staticArgument) ||
    ts.isTypeAssertion(staticArgument) ||
    ts.isNonNullExpression(staticArgument)
  ) {
    staticArgument = staticArgument.expression;
  }
  if (ts.isStringLiteralLike(staticArgument)) {
    return boolLit(accepted.includes(staticArgument.text), loc);
  }
  let result: IrExpr = boolLit(false, loc);
  for (let i = accepted.length - 1; i >= 0; i--) {
    const equal: IrExpr = {
      kind: "strEq",
      negated: false,
      left: ref(),
      right: strLit(accepted[i]!, loc),
      type: BOOL,
      loc,
    };
    result = { kind: "logical", op: "||", left: equal, right: result, type: BOOL, loc };
  }
  return {
    kind: "seqExpr",
    stmts: [{ kind: "varDecl", localId: slot.id, init: argument, loc }],
    result,
    type: BOOL,
    loc,
  };
}

/** The run-time arguments of scr_require.c's computed require and
 * require.resolve after the specifier: the requiring file (Node's require
 * stack names it), the call's "file:line" for the SC2020 refusal, and the
 * builtin ids. The call joins the runtime-fence ledger, so coverage lists
 * it as deferred to runtime. */
function computedRequireArgs(
  lowerer: Lowerer,
  surface: string,
  node: ts.Node,
  baseFile: ts.SourceFile,
): IrExpr[] {
  const loc = locOf(node);
  lowerer.runtimeFences.push(computedRequireDiag(surface, loc));
  const line = ts.getLineAndCharacterOfPosition(ts.getSourceFileOfNode(node), loc.start).line + 1;
  return [
    strLit(moduleFileName(lowerer, baseFile), loc),
    strLit(`${loc.file}:${line}`, loc),
    builtinModulesArrayLit(loc),
  ];
}

/** A createRequire loader's require.resolve with a computed request, in
 * JavaScript source: Node's resolution at run time (scr_require.c), with
 * the options argument checked there. */
function computedResolveCall(
  lowerer: Lowerer,
  node: ts.Node,
  baseFile: ts.SourceFile,
  request: IrExpr,
  options: IrExpr,
  loc: SrcLoc,
): IrExpr {
  return {
    kind: "libCall",
    fn: "module.resolveComputed",
    args: [
      request,
      options,
      ...computedRequireArgs(lowerer, "createRequire's require.resolve", node, baseFile),
    ],
    type: STRING,
    loc,
  };
}

/** The fence a createRequire use with no build-time lowering throws in
 * JavaScript source, where preflight admits it inside a try block
 * (createRequireUse7 in program.ts). The diagnostic joins the runtime-fence
 * ledger, so coverage lists the use as deferred to runtime. */
function createRequireFence(
  lowerer: Lowerer,
  surface: string,
  node: ts.Node,
  hint: string,
): IrStmt & { kind: "runtimeFence" } {
  const loc = locOf(node);
  const d = noLoweringDiag(surface, loc, hint);
  lowerer.runtimeFences.push(d);
  const line = ts.getLineAndCharacterOfPosition(ts.getSourceFileOfNode(node), loc.start).line + 1;
  return {
    kind: "runtimeFence",
    code: d.code,
    message: `${d.message} [${d.code} at ${loc.file}:${line}]`,
    loc,
  };
}

/** A createRequire loader's `resolve` read as a value in JavaScript source
 * (passed on, or picked by `??`): a function that resolves its request at
 * run time, so `(options.resolve ?? require.resolve)(id)` behaves as in
 * Node. */
export function createRequireResolveValue(
  lowerer: Lowerer,
  access: ts.PropertyAccessExpression,
  loc: SrcLoc,
): IrExpr {
  const baseFile = createRequireCalleeFileOf(lowerer, access.expression);
  if (baseFile === null || !isJsSourceFile(ts.getSourceFileOfNode(access))) {
    lowerer.noLowering(
      "createRequire's require.resolve as a value",
      access,
      'call it with a string literal (require.resolve("<specifier>")), which resolves at build time',
    );
  }
  const name = keyedHelperName(lowerer, "%createRequire.resolve", `${loc.file}:${loc.start}`);
  if (!lowerer.liftedFns.some((fn) => fn.name === name)) {
    const call = computedResolveCall(
      lowerer,
      access,
      baseFile,
      varRef("request", DYN, loc),
      varRef("options", DYN, loc),
      loc,
    );
    lowerer.liftedFns.push({
      name,
      params: [
        { localId: "request", name: "request", type: DYN },
        { localId: "options", name: "options", type: DYN },
      ],
      locals: [
        { id: "request", name: "request", type: DYN, mutable: false },
        { id: "options", name: "options", type: DYN, mutable: false },
      ],
      returnType: STRING,
      body: [{ kind: "return", value: call, loc }],
      loc,
    });
  }
  return {
    kind: "dynFrom",
    value: { kind: "closure", fnName: name, captures: [], type: funcOf([DYN, DYN], STRING), loc },
    fnName: access.name.text,
    type: DYN,
    loc,
  };
}

/** A createRequire loader's `resolve.paths` read as a value in JavaScript
 * source: a function that throws the fence when called. */
export function createRequireResolveFenceValue(
  lowerer: Lowerer,
  access: ts.PropertyAccessExpression,
  loc: SrcLoc,
): IrExpr {
  const surface = "createRequire's require.resolve.paths as a value";
  const hint =
    'call it with a string literal (require.resolve.paths("<specifier>")), which resolves at build time';
  if (!isJsSourceFile(ts.getSourceFileOfNode(access))) lowerer.noLowering(surface, access, hint);
  const name = keyedHelperName(lowerer, "%createRequire.fence", `${loc.file}:${loc.start}`);
  if (!lowerer.liftedFns.some((fn) => fn.name === name)) {
    lowerer.liftedFns.push({
      name,
      params: [],
      locals: [],
      returnType: DYN,
      body: [createRequireFence(lowerer, surface, access, hint)],
      loc,
    });
  }
  return {
    kind: "dynFrom",
    value: { kind: "closure", fnName: name, captures: [], type: funcOf([], DYN), loc },
    fnName: access.name.text,
    type: DYN,
    loc,
  };
}

/** A createRequire use deferred to run time in JavaScript source: as in
 * Node, the call's arguments are evaluated in order, then the call throws
 * (here, the fence). Code before the call in the same statement runs, and
 * the expression diverges, so nothing after it does. */
function deferredCreateRequireThrow(
  lowerer: Lowerer,
  call: ts.CallExpression,
  surface: string,
  hint: string,
  loc: SrcLoc,
): IrExpr {
  const stmts: IrStmt[] = call.arguments.nodes.map((arg) => ({
    kind: "exprStmt",
    expr: lowerer.lowerExpr(arg),
    loc: locOf(arg),
  }));
  const type = lowerer.irTypeOf(call);
  const slot = lowerer.declareHiddenLocal("%never", type);
  slot.mutable = true;
  stmts.push(
    { kind: "varDecl", localId: slot.id, init: null, loc },
    createRequireFence(lowerer, surface, call, hint),
  );
  return {
    kind: "seqExpr",
    stmts,
    result: varRef(slot.id, type, loc),
    diverges: true,
    type,
    loc,
  };
}

export function lowerCreateRequireCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  loc: SrcLoc,
): IrExpr | null {
  const cr = createRequireSpecOf(lowerer, call);
  if (cr === null) return null;
  if (cr.spec === null) {
    const args = call.arguments.nodes;
    const surface = "createRequire's require with a computed specifier or this argument shape";
    const hint =
      'the compiled module graph is fixed at build time — the one lowered form is require("<static string literal>"); native addons are not loaded';
    if (!isJsSourceFile(ts.getSourceFileOfNode(call)))
      lowerer.noLowering(surface, call, hint, undefined, "dynamic-require");
    // Spread arguments have no run-time resolution: they run, then the
    // call throws the fence.
    if (args.some((a) => ts.isSpreadElement(a)))
      return deferredCreateRequireThrow(lowerer, call, surface, hint, loc);
    // Node evaluates every argument, then requires the first.
    const stmts: IrStmt[] = [];
    let id = args.length > 0 ? lowerer.lowerExprExpecting(args[0]!, DYN) : dynUndefinedExpr(loc);
    if (args.length > 1) {
      const slot = lowerer.declareHiddenLocal("%require.id", DYN);
      stmts.push({ kind: "varDecl", localId: slot.id, init: id, loc });
      for (const arg of args.slice(1))
        stmts.push({ kind: "exprStmt", expr: lowerer.lowerExpr(arg), loc: locOf(arg) });
      id = varRef(slot.id, DYN, loc);
    }
    const require: IrExpr = {
      kind: "libCall",
      fn: "module.requireComputed",
      args: [id, ...computedRequireArgs(lowerer, "createRequire's require", call, cr.baseFile)],
      type: DYN,
      loc,
    };
    return lowerer.coerceInto(
      call,
      stmts.length === 0 ? require : { kind: "seqExpr", stmts, result: require, type: DYN, loc },
      lowerer.irTypeOf(call),
    );
  }
  const spec = cr.spec;
  if (spec === "node:ffi") {
    return lowerFfiMemoryModule(lowerer, loc);
  }
  if (canonicalBuiltinModule(spec) !== null) {
    lowerer.unsupported(
      "SC1090",
      call,
      `module namespace objects as values (bind it first: const m = require("${spec}"), then access members through the binding)`,
    );
  }
  const programModule = createRequireProgramModuleOf(lowerer, call);
  if (programModule !== null) {
    lowerer.noLowering(
      `createRequire's module namespace value for '${spec}'`,
      call,
      `bind it once (const m = require(${JSON.stringify(spec)})) and access statically-known members through that binding`,
    );
  }
  if (spec.startsWith("#")) {
    lowerer.noLowering(
      `createRequire's require of the '${spec}' project import`,
      call,
      "imports-field specifiers have no require lowering yet — import the target statically",
    );
  }
  if (isRelativeSpecifier(spec) || isAbsolute(spec)) {
    if (!spec.endsWith(".json")) {
      // Only refine the existing refusal path: Node resolution detects
      // extensionless addons and directory entries without executing
      // them, and avoids mistaking a .node-named JS directory for one.
      // This probe marks frontend inputs unstable, but every branch
      // here refuses compilation, so successful-build caches keep their
      // existing dependency proofs.
      const resolved = resolveRequireRuntime(
        cr.baseFile.fileName,
        spec,
        lowerer.targetPlatform,
        undefined,
        lowerer.frontendServices,
      );
      if (resolved.ok && resolved.value.endsWith(".node")) {
        lowerer.pushDiag(nativeAddonDiag(spec, loc));
        throw new PoisonError();
      }
      lowerer.noLowering(
        `createRequire's require of '${spec}'`,
        call,
        "relative program modules lower when they resolve into the compiled graph; relative .json documents bake at build time",
      );
    }
    const abs = isAbsolute(spec) ? spec : resolve(dirname(cr.baseFile.fileName), spec);
    const text = trackedReadFile(abs);
    if (text === null) {
      lowerer.noLowering(
        `createRequire's require of '${spec}' (no file at ${abs})`,
        call,
        "the required document resolves at build time — check the path against the requiring file",
      );
    }
    try {
      JSON.parse(text);
    } catch (e) {
      lowerer.pushDiag(invalidJsonModuleDiag(abs, e instanceof Error ? e.message : String(e), loc));
      throw new PoisonError();
    }
    return {
      kind: "libCall",
      fn: "json.parse",
      args: [{ kind: "strLit", value: text, type: STRING, loc }],
      type: DYN,
      loc,
    };
  }
  // Bare package specifiers. --npm-static opt-ins are program modules —
  // their exports bind through static imports, not a require value.
  const pkgName = spec.startsWith("@")
    ? spec.split("/").slice(0, 2).join("/")
    : spec.split("/")[0]!;
  if (isNpmStaticPackage(pkgName)) {
    lowerer.noLowering(
      `createRequire's require of the --npm-static package '${pkgName}'`,
      call,
      "the opted-in package compiles as program modules — import it statically",
    );
  }
  const refusal = probeNodeRequireRefusal(cr.baseFile.fileName, spec);
  if (refusal !== null) {
    // Node's require-site MODULE_NOT_FOUND, catchable — the compiled
    // expression IS that throw (the typed dummy is abandoned by the
    // pending check's unwind).
    return nodeThrowExpr(0, "MODULE_NOT_FOUND", refusal.message, DYN, loc);
  }
  {
    lowerer.pushDiag(unsupportedPackageImportDiag(pkgName, loc));
    throw new PoisonError();
  }
}

function staticString(node: ts.Expression | undefined): string | null {
  if (node === undefined) return null;
  const value = stripTypeCasts(node);
  return ts.isStringLiteralLike(value) ? value.text : null;
}

function runtimeResolveThrow(error: RuntimeResolveError, type: IrType, loc: SrcLoc): IrExpr {
  return nodeThrowExpr(error.name === "TypeError" ? 1 : 0, error.code, error.message, type, loc);
}

/** import.meta.resolve("literal") folds through the runtime-module
 * resolver, never TypeScript's declaration-file resolver. Relative and
 * URL-like names remain valid even when no file exists; bare packages use
 * Node's import-condition exports path. */
export function lowerImportMetaResolveCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
): IrExpr | null {
  const callee = call.expression;
  if (
    !ts.isPropertyAccessExpression(callee) ||
    callee.questionDotToken !== undefined ||
    callee.name.text !== "resolve" ||
    !ts.isMetaProperty(callee.expression) ||
    callee.expression.keywordToken !== ts.SyntaxKind.ImportKeyword ||
    callee.expression.name.text !== "meta"
  ) {
    return null;
  }
  if (call.questionDotToken !== undefined || call.arguments.nodes.length !== 1) {
    lowerer.noLowering(
      "import.meta.resolve with this argument shape",
      call,
      'the lowered form is import.meta.resolve("<static specifier>") using the containing module as its parent',
    );
  }
  const specifier = staticString(call.arguments.nodes[0]);
  if (specifier === null) {
    lowerer.noLowering(
      "import.meta.resolve with a runtime-computed specifier",
      call.arguments.nodes[0]!,
      "a compiled binary has a fixed module graph — pass a string literal",
    );
  }
  const result = resolveImportMetaRuntime(
    ts.getSourceFileOfNode(call).fileName,
    specifier,
    lowerer.targetPlatform,
    lowerer.frontendServices,
  );
  if (result === null) {
    lowerer.noLowering(
      `import.meta.resolve of '${specifier}'`,
      call,
      "relative paths, URL-like names, builtins, and installed package names are supported; package-import aliases remain unsupported",
    );
  }
  const loc = locOf(call);
  return result.ok
    ? { kind: "strLit", value: result.value, type: STRING, loc }
    : runtimeResolveThrow(result.error, STRING, loc);
}

function requireResolverBaseFile(lowerer: Lowerer, receiver: ts.Expression): ts.SourceFile | null {
  const created = createRequireCalleeFileOf(lowerer, receiver);
  if (created !== null) return created;
  return lowerer.isStdlibGlobal(receiver, "require") &&
    !isNodeEsmFile(ts.getSourceFileOfNode(receiver), lowerer.program)
    ? ts.getSourceFileOfNode(receiver)
    : null;
}

function staticResolveOptionPaths(
  node: ts.Expression | undefined,
): readonly string[] | undefined | null {
  if (node === undefined) return undefined;
  const value = stripTypeCasts(node);
  if (ts.isIdentifier(value) && value.text === "undefined") return undefined;
  if (!ts.isObjectLiteralExpression(value)) return null;
  let paths: readonly string[] | undefined;
  for (const prop of value.properties.nodes) {
    if (!ts.isPropertyAssignment(prop)) return null;
    const name =
      ts.isIdentifier(prop.name) || ts.isStringLiteralLike(prop.name) ? prop.name.text : null;
    if (name !== "paths" || paths !== undefined) return null;
    const init = stripTypeCasts(prop.initializer);
    if (!ts.isArrayLiteralExpression(init)) return null;
    const entries: string[] = [];
    for (const item of init.elements.nodes) {
      if (!ts.isStringLiteralLike(item)) return null;
      entries.push(item.text);
    }
    paths = entries;
  }
  return paths;
}

/** CommonJS require.resolve and require.resolve.paths for the ambient
 * wrapper or a supported createRequire binding. Results are build-time
 * constants; failures lower to Node's catchable error object. */
export function lowerRequireResolveCall(lowerer: Lowerer, call: ts.CallExpression): IrExpr | null {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee) || callee.questionDotToken !== undefined) return null;
  let receiver: ts.Expression;
  let pathsCall = false;
  if (callee.name.text === "resolve") {
    receiver = callee.expression;
  } else if (
    callee.name.text === "paths" &&
    ts.isPropertyAccessExpression(callee.expression) &&
    callee.expression.questionDotToken === undefined &&
    callee.expression.name.text === "resolve"
  ) {
    receiver = callee.expression.expression;
    pathsCall = true;
  } else {
    return null;
  }
  const baseFile = requireResolverBaseFile(lowerer, receiver);
  if (baseFile === null) return null;
  const surface = pathsCall ? "require.resolve.paths" : "require.resolve";
  // A createRequire loader's query that resolves only at run time, in
  // JavaScript source: preflight admits it inside a try block
  // (createRequireUse7 in program.ts). Its arguments run, then it throws.
  const deferred = (what: string, hint: string): IrExpr | null =>
    call.questionDotToken === undefined &&
    createRequireCalleeFileOf(lowerer, receiver) !== null &&
    isJsSourceFile(ts.getSourceFileOfNode(call))
      ? deferredCreateRequireThrow(
          lowerer,
          call,
          `createRequire's ${surface} ${what}`,
          hint,
          locOf(call),
        )
      : null;
  const resolveHint = `call it with a string literal (${surface}("<specifier>")), which resolves at build time`;
  if (
    call.questionDotToken !== undefined ||
    call.arguments.nodes.length < 1 ||
    call.arguments.nodes.length > (pathsCall ? 1 : 2)
  ) {
    const fenced = deferred("with this argument shape", resolveHint);
    if (fenced) return fenced;
    lowerer.noLowering(
      pathsCall
        ? "require.resolve.paths with this argument shape"
        : "require.resolve with this argument shape",
      call,
    );
  }
  const specifier = staticString(call.arguments.nodes[0]);
  // A computed request (or options) through a createRequire loader in
  // JavaScript source resolves at run time.
  if (
    (specifier === null || staticResolveOptionPaths(call.arguments.nodes[1]) === null) &&
    !pathsCall &&
    createRequireCalleeFileOf(lowerer, receiver) !== null &&
    isJsSourceFile(ts.getSourceFileOfNode(call))
  ) {
    const [request, options] = call.arguments.nodes;
    return computedResolveCall(
      lowerer,
      call,
      baseFile,
      lowerer.lowerExprExpecting(request!, DYN),
      options === undefined
        ? dynUndefinedExpr(locOf(call))
        : lowerer.lowerExprExpecting(options, DYN),
      locOf(call),
    );
  }
  if (specifier === null) {
    const fenced = deferred("with a computed request", resolveHint);
    if (fenced) return fenced;
    lowerer.noLowering(
      `${pathsCall ? "require.resolve.paths" : "require.resolve"} with a runtime-computed request`,
      call.arguments.nodes[0]!,
      "a compiled binary has a fixed module graph — pass a string literal",
    );
  }
  const loc = locOf(call);
  if (pathsCall) {
    const result = requireResolvePathsRuntime(
      baseFile.fileName,
      specifier,
      lowerer.targetPlatform,
      lowerer.frontendServices,
    );
    if (result !== null && !Array.isArray(result)) {
      return runtimeResolveThrow(result as RuntimeResolveError, lowerer.irTypeOf(call), loc);
    }
    const raw: IrExpr =
      result === null
        ? { kind: "unitLit", unit: "null", type: NULL_T, loc }
        : {
            kind: "arrayLit",
            elems: (result as readonly string[]).map((value): IrExpr => ({
              kind: "strLit",
              value,
              type: STRING,
              loc,
            })),
            type: arrayOf(STRING),
            loc,
          };
    return lowerer.coerceInto(call, raw, lowerer.irTypeOf(call));
  }
  const paths = staticResolveOptionPaths(call.arguments.nodes[1]);
  if (paths === null) {
    const fenced = deferred(
      "with runtime-computed options",
      'omit options or pass { paths: ["<static directory>", ...] }',
    );
    if (fenced) return fenced;
    lowerer.noLowering(
      "require.resolve with runtime-computed options",
      call.arguments.nodes[1]!,
      'omit options or pass { paths: ["<static directory>", ...] }',
    );
  }
  const result: RuntimeResolveResult = resolveRequireRuntime(
    baseFile.fileName,
    specifier,
    lowerer.targetPlatform,
    paths,
    lowerer.frontendServices,
  );
  return result.ok
    ? { kind: "strLit", value: result.value, type: STRING, loc }
    : runtimeResolveThrow(result.error, STRING, loc);
}
