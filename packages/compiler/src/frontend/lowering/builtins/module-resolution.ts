import { dynUndefinedExpr, nodeThrowExpr, boolLit, strLit, varRef } from "../../../ir/build.js";
import { dirname, isAbsolute, resolve } from "node:path";
import * as posix from "node:path/posix";
import * as win32 from "node:path/win32";
import * as ts from "../../ts7/adapter.js";
import { withoutParenthesesTypeWrappers } from "../../outer-expressions.js";
import { type Lowerer, PoisonError } from "../lowerer.js";
import { boundSpecifier } from "../../specifier-bounds.js";
import { canonicalBuiltinModule, isJsSourceFile, isNodeEsmFile, locOf } from "../../program.js";
import { isRelativeSpecifier } from "../../workspace-registry.js";
import { probeNodeRequireRefusal } from "../../npm.js";
import { isNpmStaticPackage } from "../../npm-static.js";
import { trackedReadFile } from "../../input-tracker.js";
import {
  requireResolvePathsRuntime,
  resolveImportMetaRuntime,
  resolveRequireRuntime,
  runtimePathForTarget,
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
import { NODE_BUILTIN_MODULES_V24 } from "../../builtin-modules.js";
import { builtinModulesArrayLit } from "../surfaces.js";
import { isImportMeta, moduleFileName } from "../import-meta.js";
import {
  baseHrefOfPath,
  baseUrlLiteral,
  findPackageJson,
  findPackageJsonPathsMatchHost,
} from "../../find-package-json.js";
import {
  BOOL,
  DYN,
  F64,
  type IrExpr,
  type IrStmt,
  type IrType,
  NULL_T,
  STRING,
  type SrcLoc,
  UNDEFINED_T,
  VOID,
  arrayOf,
  funcOf,
} from "../../../ir/ir.js";
import { lowerFfiMemoryModule } from "../native-ffi.js";
import { StripUnsupportedSyntax, stripTypeScriptTypesStrip } from "../../strip-typescript-types.js";
import {
  createRequireSpecOf,
  createRequireProgramModuleOf,
  createRequireCalleeFileOf,
  createRequireFactoryBinding,
  isCreateRequireImportValue,
  createRequireLoaderAnchorOf,
  createRequireRuntimeBaseOf,
} from "./module-bindings.js";
import { keyedHelperName } from "../stable-names.js";
import { checkedIterableSpread } from "../checked-iterable-spread.js";

/** node:module's compile cache calls and the runtime entry point of each
 * (scr_module_cache.c). `value` marks the ones that hand their first
 * argument to the runtime, which validates it as Node does. */
const COMPILE_CACHE_CALLS = {
  enableCompileCache: { fn: "module.compileCacheEnable", value: true, result: DYN },
  getCompileCacheDir: { fn: "module.compileCacheDir", value: false, result: DYN },
  flushCompileCache: { fn: "module.compileCacheFlush", value: true, result: DYN },
} as const;
type CompileCacheMember = keyof typeof COMPILE_CACHE_CALLS;

/** enableCompileCache(options), getCompileCacheDir() and
 * flushCompileCache(): a compiled program loads no JavaScript, so there is
 * no code cache to enable, name or write. Every argument is evaluated in
 * source order, then the runtime validates the first one as Node does and
 * answers what Node answers with the cache disabled: { status: DISABLED,
 * message }, undefined, and undefined. In typed code the answer is checked
 * into the call's declared type (@types/node's EnableCompileCacheResult,
 * `string | undefined`); flushCompileCache's is void, which keeps the
 * runtime's undefined. */
function lowerCompileCacheCall(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  member: CompileCacheMember,
  loc: SrcLoc,
): IrExpr {
  const row = COMPILE_CACHE_CALLS[member];
  const args = expr.arguments.nodes;
  if (args.some(ts.isSpreadElement)) {
    lowerer.noLowering(
      `module.${member} with spread arguments`,
      expr,
      "pass the argument itself; the call reads at most one",
    );
  }
  const stmts: IrStmt[] = [];
  let first: IrExpr | null = null;
  args.forEach((arg, i) => {
    const value = lowerer.lowerExpr(arg);
    const argLoc = locOf(arg);
    if (i > 0 || !row.value) {
      stmts.push({ kind: "exprStmt", expr: value, loc: argLoc });
      return;
    }
    const boxed = lowerer.coerceInto(arg, value, DYN);
    if (args.length === 1) {
      first = boxed;
      return;
    }
    // Later arguments run before the runtime looks at this one.
    const slot = lowerer.declareHiddenLocal("%compileCacheArg", DYN);
    stmts.push({ kind: "varDecl", localId: slot.id, init: boxed, loc: argLoc });
    first = varRef(slot.id, DYN, argLoc);
  });
  const call: IrExpr = {
    kind: "libCall",
    fn: row.fn,
    args: row.value ? [first ?? dynUndefinedExpr(loc)] : [],
    type: row.result,
    loc,
  };
  const declared = lowerer.mapTypeOf(lowerer.typeOf(expr));
  const result =
    declared === null || declared.kind === "dyn" || declared.kind === "void"
      ? call
      : lowerer.coerceToExpected(call, declared);
  return stmts.length === 0 ? result : { kind: "seqExpr", stmts, result, type: result.type, loc };
}

/** `module.findPackageJSON(specifier[, base])` with a string-literal
 * specifier and a static base (`import.meta.url`, `__filename`, or a path or
 * file: URL literal): the nearest package.json resolved at build time, which
 * is the answer Node gives for the same source tree. A runtime-computed
 * specifier or base, and a lookup that fails, keep the named refusal. */
function lowerFindPackageJsonCall(lowerer: Lowerer, expr: ts.CallExpression, loc: SrcLoc): IrExpr {
  const args = expr.arguments.nodes;
  if (args.some(ts.isSpreadElement) || args.length === 0 || args.length > 2) {
    lowerer.noLowering(
      "module.findPackageJSON with this argument list",
      expr,
      "pass a string-literal specifier and an optional static base",
    );
  }
  const specifierNode = withoutParenthesesTypeWrappers(args[0]!);
  if (!ts.isStringLiteralLike(specifierNode)) {
    lowerer.noLowering(
      "module.findPackageJSON with a runtime-computed specifier",
      args[0]!,
      "a compiled binary has a fixed module graph; pass a string literal",
    );
  }
  let baseHref = "data:";
  if (args.length === 2) {
    const base = findPackageJsonBaseHref(lowerer, args[1]!);
    if (base === null) {
      lowerer.noLowering(
        "module.findPackageJSON with a runtime-computed base",
        args[1]!,
        "pass import.meta.url, __filename, or an absolute path or file: URL literal",
      );
    }
    baseHref = base;
  }
  if (!findPackageJsonPathsMatchHost(lowerer.targetPlatform)) {
    lowerer.noLowering(
      "module.findPackageJSON for this target",
      expr,
      "the build resolves the lookup with the host's path rules; this target's differ",
    );
  }
  const answer = findPackageJson(specifierNode.text, baseHref);
  if (!answer.ok) {
    lowerer.noLowering(
      `module.findPackageJSON(${JSON.stringify(specifierNode.text)}): ${answer.refusal}`,
      expr,
      "the build-time lookup cannot answer this call",
    );
  }
  const lit: IrExpr = { kind: "strLit", value: answer.path, type: STRING, loc };
  const declared = lowerer.mapTypeOf(lowerer.typeOf(expr));
  return declared === null ? lit : lowerer.coerceToExpected(lit, declared);
}

/** The file: URL a findPackageJSON base expression names, or null when it is
 * not one of the static spellings. */
function findPackageJsonBaseHref(lowerer: Lowerer, node: ts.Expression): string | null {
  const value = withoutParenthesesTypeWrappers(node);
  if (ts.isStringLiteralLike(value)) return baseUrlLiteral(value.text);
  const sf = ts.getSourceFileOfNode(value);
  if (
    ts.isPropertyAccessExpression(value) &&
    !value.questionDotToken &&
    value.name.text === "url" &&
    isImportMeta(value.expression)
  ) {
    return baseHrefOfPath(moduleFileName(lowerer, sf));
  }
  if (
    ts.isIdentifier(value) &&
    value.text === "__filename" &&
    !isNodeEsmFile(sf, lowerer.program)
  ) {
    return baseHrefOfPath(moduleFileName(lowerer, sf));
  }
  return null;
}

/** node:module's source-map support calls and the runtime entry point of
 * each (scr_lib.c). `params` is how many leading arguments the runtime
 * reads; the rest are evaluated and dropped, as Node ignores them. */
const SOURCE_MAP_CALLS = {
  getSourceMapsSupport: { fn: "module.sourceMapsSupport", params: 0, result: DYN },
  setSourceMapsSupport: { fn: "module.setSourceMapsSupport", params: 2, result: VOID },
  findSourceMap: { fn: "module.findSourceMap", params: 1, result: DYN },
} as const;
type SourceMapMember = keyof typeof SOURCE_MAP_CALLS;

/** getSourceMapsSupport(), setSourceMapsSupport(enabled[, options]) and
 * findSourceMap(path): a compiled program registers no source map, so the
 * support record answers the flags the program set exactly as Node's frozen
 * { enabled, nodeModules, generatedCode } does, and findSourceMap answers
 * undefined — what Node answers for a file whose map was never parsed. Every
 * argument is evaluated in source order before the runtime validates any, and
 * a trailing argument the call omits arrives as undefined (Node's own
 * defaults). */
function lowerSourceMapsCall(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  member: SourceMapMember,
  loc: SrcLoc,
): IrExpr {
  const row = SOURCE_MAP_CALLS[member];
  const args = expr.arguments.nodes;
  if (args.some(ts.isSpreadElement)) {
    lowerer.noLowering(
      `module.${member} with spread arguments`,
      expr,
      "pass the arguments themselves; the runtime reads at most two",
    );
  }
  const stmts: IrStmt[] = [];
  const lowered: IrExpr[] = [];
  args.forEach((arg, i) => {
    const value = lowerer.lowerExpr(arg);
    const argLoc = locOf(arg);
    if (i >= row.params) {
      stmts.push({ kind: "exprStmt", expr: value, loc: argLoc });
      return;
    }
    const boxed = lowerer.coerceInto(arg, value, DYN);
    if (i === args.length - 1 && stmts.length === 0) {
      lowered.push(boxed);
      return;
    }
    // Later arguments run before the runtime looks at this one.
    const slot = lowerer.declareHiddenLocal(`%sourceMapsArg${i}`, DYN);
    stmts.push({ kind: "varDecl", localId: slot.id, init: boxed, loc: argLoc });
    lowered.push(varRef(slot.id, DYN, argLoc));
  });
  for (let i = args.length; i < row.params; i++) lowered.push(dynUndefinedExpr(loc));
  const call: IrExpr = { kind: "libCall", fn: row.fn, args: lowered, type: row.result, loc };
  const declared = lowerer.mapTypeOf(lowerer.typeOf(expr));
  const result =
    declared === null || declared.kind === "dyn" || declared.kind === "void"
      ? call
      : lowerer.coerceToExpected(call, declared);
  return stmts.length === 0 ? result : { kind: "seqExpr", stmts, result, type: result.type, loc };
}

/** node:module's two compiler-only calls. isBuiltin compares one evaluated
 * string against the pinned Node 24 list (bare builtins also accept their
 * node: spelling; prefix-only entries do not gain a bare alias).
 * syncBuiltinESMExports takes no arguments and returns undefined; as a
 * statement it refreshes the events module's ES module namespace copy of
 * defaultMaxListeners (lowerExprStatement), the one builtin export a program
 * can change. */
/** Node's util.inspect-shaped description of a `code` argument that is not a
 * string, or null for a shape this check does not reproduce. */
function stripCodeReceivedText(lowerer: Lowerer, arg: ts.Expression): string | null {
  const a = withoutParenthesesTypeWrappers(arg);
  if (ts.isNumericLiteral(a)) return `type number (${a.text})`;
  if (a.kind === ts.SyntaxKind.TrueKeyword) return "type boolean (true)";
  if (a.kind === ts.SyntaxKind.FalseKeyword) return "type boolean (false)";
  if (a.kind === ts.SyntaxKind.NullKeyword) return "null";
  if (ts.isIdentifier(a) && lowerer.isStdlibGlobal(a, "undefined")) return "undefined";
  if (ts.isObjectLiteralExpression(a) && a.properties.nodes.length === 0)
    return "an instance of Object";
  if (ts.isArrayLiteralExpression(a) && a.elements.nodes.length === 0)
    return "an instance of Array";
  return null;
}

/** module.stripTypeScriptTypes(code, options): a compiled program strips the
 * code at build time, so the code and the options must be written literally.
 * Node's argument checks (the code's type, the mode, sourceMap, sourceUrl)
 * and the strip-mode syntax refusals answer Node's own errors and messages;
 * `mode: "transform"` is a named refusal (it re-prints the program through
 * SWC's code generator). The first call reports Node's one-time
 * ExperimentalWarning, then answers the stripped text. */
export function lowerStripTypeScriptTypesCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  loc: SrcLoc,
): IrExpr {
  const args = call.arguments.nodes;
  const refuse = (what: string, hint: string): never =>
    lowerer.noLowering(`module.stripTypeScriptTypes ${what}`, call, hint);
  // Node evaluates every argument before the call body runs, so an error the
  // checks raise happens after them — an ignored option value or an extra
  // argument keeps its side effects and its own exceptions on every path.
  const evaluation: IrStmt[] = args.map((arg) => ({
    kind: "exprStmt",
    expr: lowerer.lowerExpr(arg),
    loc: locOf(arg),
  }));
  const fail = (thrown: IrExpr): IrExpr =>
    evaluation.length === 0
      ? thrown
      : { kind: "seqExpr", stmts: evaluation, result: thrown, type: thrown.type, loc };
  if (args.some(ts.isSpreadElement))
    refuse("with a spread argument", "stripTypeScriptTypes(code, options) takes written literals");
  const codeNode = args[0];
  let code: string | null = null;
  if (codeNode !== undefined) {
    const a = withoutParenthesesTypeWrappers(codeNode);
    if (ts.isStringLiteralLike(a)) code = a.text;
  }
  if (code === null) {
    const received =
      codeNode === undefined ? "undefined" : stripCodeReceivedText(lowerer, codeNode);
    if (received !== null)
      return fail(
        nodeThrowExpr(
          1,
          "ERR_INVALID_ARG_TYPE",
          `The "code" argument must be of type string. Received ${received}`,
          DYN,
          loc,
        ),
      );
    return refuse(
      "with runtime-computed code",
      "the code must be a string literal: a compiled program strips it at build time",
    );
  }
  let sourceUrl: string | null = null;
  const optionsNode = args[1];
  if (optionsNode !== undefined) {
    const o = withoutParenthesesTypeWrappers(optionsNode);
    if (!ts.isObjectLiteralExpression(o))
      return refuse(
        "with runtime-computed options",
        'pass an options literal: { mode: "strip" }, sourceMap or sourceUrl',
      );
    for (const prop of o.properties?.nodes ?? []) {
      if (
        !ts.isPropertyAssignment(prop) ||
        prop.name === undefined ||
        !ts.isIdentifier(prop.name) ||
        prop.initializer === undefined
      )
        return refuse(
          "with a computed option",
          'write each option by name: { mode: "strip" }, sourceMap, sourceUrl',
        );
      const name = prop.name.text;
      const value = withoutParenthesesTypeWrappers(prop.initializer);
      if (name === "mode") {
        if (!ts.isStringLiteralLike(value))
          return refuse("with a runtime-computed mode", 'write the mode as a string: "strip"');
        if (value.text === "transform")
          return refuse(
            "in transform mode",
            "transform mode re-prints the program through SWC's code generator; only strip mode is implemented",
          );
        if (value.text !== "strip")
          return fail(
            nodeThrowExpr(
              1,
              "ERR_INVALID_ARG_VALUE",
              "The property 'options.mode' must be one of: 'strip', 'transform'. " +
                `Received '${value.text}'`,
              DYN,
              loc,
            ),
          );
      } else if (name === "sourceMap") {
        if (value.kind === ts.SyntaxKind.TrueKeyword)
          return fail(
            nodeThrowExpr(
              1,
              "ERR_INVALID_ARG_VALUE",
              "The property 'options.sourceMap' must be one of: false, undefined. Received true",
              DYN,
              loc,
            ),
          );
        if (
          value.kind !== ts.SyntaxKind.FalseKeyword &&
          !(ts.isIdentifier(value) && lowerer.isStdlibGlobal(value, "undefined"))
        )
          return refuse("with a runtime-computed sourceMap", "write sourceMap as false");
      } else if (name === "sourceUrl") {
        if (ts.isStringLiteralLike(value)) sourceUrl = value.text;
        else if (ts.isIdentifier(value) && lowerer.isStdlibGlobal(value, "undefined"))
          sourceUrl = null;
        else
          return refuse("with a runtime-computed sourceUrl", "write sourceUrl as a string literal");
      }
    }
  }
  let stripped: string;
  try {
    stripped = stripTypeScriptTypesStrip(code as string);
  } catch (err) {
    if (!(err instanceof StripUnsupportedSyntax)) throw err;
    // The refusal carries Node's own code: the strip-only syntax errors are
    // ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX, and pre-strip validation (an
    // `override` with no base class) is ERR_INVALID_TYPESCRIPT_SYNTAX.
    return fail(nodeThrowExpr(3, err.code, err.message, DYN, loc));
  }
  const text = sourceUrl === null ? stripped : `${stripped}\n\n//# sourceURL=${sourceUrl}`;
  // Node evaluates every argument before the call returns: an ignored option
  // value, an extra argument, their side effects and their exceptions all
  // happen where the call stands.
  const warning: IrStmt = {
    kind: "exprStmt",
    expr: { kind: "libCall", fn: "module.stripTypesWarning", args: [], type: VOID, loc },
    loc,
  };
  return {
    kind: "seqExpr",
    stmts: [...evaluation, warning],
    result: { kind: "strLit", value: text, type: STRING, loc },
    type: STRING,
    loc,
  };
}

export function lowerNodeModuleCall(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  bi: { module: string; member: string },
  loc: SrcLoc,
): IrExpr | null {
  if (bi.module !== "module") return null;
  if (Object.hasOwn(COMPILE_CACHE_CALLS, bi.member)) {
    return lowerCompileCacheCall(lowerer, expr, bi.member as CompileCacheMember, loc);
  }
  if (bi.member === "findPackageJSON") return lowerFindPackageJsonCall(lowerer, expr, loc);
  if (bi.member === "stripTypeScriptTypes")
    return lowerStripTypeScriptTypesCall(lowerer, expr, loc);
  if (Object.hasOwn(SOURCE_MAP_CALLS, bi.member)) {
    return lowerSourceMapsCall(lowerer, expr, bi.member as SourceMapMember, loc);
  }
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
  reason?: string,
): IrStmt & { kind: "runtimeFence" } {
  const loc = locOf(node);
  const d = noLoweringDiag(surface, loc, hint);
  // The Node island reason the refusal would carry (a computed require is
  // dynamic module loading), so island selection classifies the fence.
  if (reason !== undefined) d.reason = reason;
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
  if (baseFile === null) {
    // A run-time base resolves at run time: the value throws when called.
    if (
      isJsSourceFile(ts.getSourceFileOfNode(access)) &&
      createRequireRuntimeBaseOf(lowerer, access.expression)
    )
      return createRequireResolveFenceValue(lowerer, access, loc);
  }
  if (baseFile === null || !isJsSourceFile(ts.getSourceFileOfNode(access))) {
    lowerer.noLowering(
      "createRequire's require.resolve as a value",
      access,
      'call it with a string literal (require.resolve("<specifier>")), which resolves at build time',
    );
  }
  const name = keyedHelperName(
    lowerer,
    "%createRequire.resolve",
    createRequireLoaderAnchorOf(lowerer, access.expression),
  );
  if (lowerer.liftedFnNamed(name) === undefined) {
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

/** A createRequire loader's `resolve` (or `resolve.paths`) read as a value
 * in JavaScript source where the compiled graph cannot back it: a function
 * that throws the fence when called. */
export function createRequireResolveFenceValue(
  lowerer: Lowerer,
  access: ts.PropertyAccessExpression,
  loc: SrcLoc,
): IrExpr {
  const paths = access.name.text === "paths";
  const surface = `createRequire's require.resolve${paths ? ".paths" : ""} as a value`;
  // `r.resolve.paths` names a member of the loader's `resolve`: the loader
  // is one property access in.
  const loader =
    paths &&
    ts.isPropertyAccessExpression(access.expression) &&
    access.expression.name.text === "resolve" &&
    access.expression.questionDotToken === undefined
      ? access.expression.expression
      : access.expression;
  const runtimeBase = createRequireRuntimeBaseOf(lowerer, loader);
  const hint = runtimeBase
    ? "createRequire needs this file (import.meta.url or __filename), which anchors build-time resolution"
    : `call it with a string literal (require.resolve${paths ? ".paths" : ""}("<specifier>")), which resolves at build time`;
  if (!isJsSourceFile(ts.getSourceFileOfNode(access))) lowerer.noLowering(surface, access, hint);
  // The surface joins the anchor: one loader's `resolve` and `resolve.paths`
  // are different functions, so they must not share a helper.
  const name = keyedHelperName(
    lowerer,
    "%createRequire.fence",
    `${createRequireLoaderAnchorOf(lowerer, access.expression)}:${paths ? "paths" : "resolve"}`,
  );
  if (lowerer.liftedFnNamed(name) === undefined) {
    lowerer.liftedFns.push({
      name,
      params: [],
      locals: [],
      returnType: DYN,
      body: [
        createRequireFence(
          lowerer,
          surface,
          access,
          hint,
          runtimeBase ? "dynamic-require" : undefined,
        ),
      ],
      loc,
    });
  }
  const value: IrExpr = {
    kind: "dynFrom",
    value: { kind: "closure", fnName: name, captures: [], type: funcOf([], DYN), loc },
    fnName: access.name.text,
    type: DYN,
    loc,
  };
  if (!runtimeBase) return value;
  // An inline factory call in the receiver made the loader over a run-time
  // base: Node evaluates the base arguments at the property read.
  const stmts = createRequireBaseEffectStmts(lowerer, loader);
  return stmts.length === 0
    ? value
    : { kind: "seqExpr", stmts, result: value, type: value.type, loc };
}

/** A createRequire loader read as a value (stored in an object, passed
 * on, returned), in JavaScript and TypeScript source: a require function
 * over the runtime resolver. Calling it resolves its request like Node up
 * to the compiled graph's boundary, where a specifier the build did not
 * compile throws the SC2020 fence — the same deferred class as a
 * computed-specifier call in JavaScript. The value is checked-dynamic: a
 * typed slot it lands in takes it through the slot's checked conversion. */
export function createRequireLoaderValue(
  lowerer: Lowerer,
  ident: ts.Identifier,
  loc: SrcLoc,
): IrExpr | null {
  // In shorthand position (`{ load }`) the name carries the property's
  // symbol. The loader is the binding the shorthand reads, found through
  // its declaration's own name, which also anchors the one value every
  // read of the binding shares.
  const holder = ident.parent;
  if (holder !== undefined && ts.isShorthandPropertyAssignment(holder) && holder.name === ident) {
    const declared = lowerer.checker.getShorthandAssignmentValueSymbol(holder)?.declarations[0];
    const name =
      declared !== undefined &&
      (ts.isVariableDeclaration(declared) || ts.isImportSpecifier(declared))
        ? declared.name
        : undefined;
    return name !== undefined && ts.isIdentifier(name)
      ? createRequireLoaderValue(lowerer, name, loc)
      : null;
  }
  const baseFile = createRequireCalleeFileOf(lowerer, ident);
  if (baseFile === null) {
    // A loader over a run-time base cannot resolve against the compiled
    // graph: its one value form is the fence, thrown when called. The
    // destructured factory binding reads as a function the same way.
    if (!isJsSourceFile(ts.getSourceFileOfNode(ident))) return null;
    if (!createRequireRuntimeBaseOf(lowerer, ident) && !createRequireFactoryBinding(lowerer, ident))
      return null;
    return createRequireFenceFunctionValue(lowerer, ident, ident.text, loc);
  }
  const name = keyedHelperName(
    lowerer,
    "%createRequire.loader",
    createRequireLoaderAnchorOf(lowerer, ident),
  );
  if (lowerer.liftedFnNamed(name) === undefined) {
    const call: IrExpr = {
      kind: "libCall",
      fn: "module.requireComputed",
      args: [
        varRef("request", DYN, loc),
        ...computedRequireArgs(lowerer, "createRequire's require", ident, baseFile),
      ],
      type: DYN,
      loc,
    };
    lowerer.liftedFns.push({
      name,
      params: [{ localId: "request", name: "request", type: DYN }],
      locals: [{ id: "request", name: "request", type: DYN, mutable: false }],
      returnType: DYN,
      body: [{ kind: "return", value: call, loc }],
      loc,
    });
  }
  return {
    kind: "dynFrom",
    value: { kind: "closure", fnName: name, captures: [], type: funcOf([DYN], DYN), loc },
    fnName: ident.text,
    type: DYN,
    loc,
  };
}

/** The members Node's require function carries besides being callable. */
const LOADER_OWN_MEMBERS: ReadonlySet<string> = new Set(["resolve", "cache", "main", "extensions"]);

/** The declared type of a require function: @types/node's `NodeJS.Require`
 * and its global alias, and the bundled declarations' own name. */
const LOADER_TYPE_NAMES: ReadonlySet<string> = new Set([
  "Require",
  "NodeRequire",
  "ScriptcRequire",
]);

/** A member of a createRequire loader read through a VALUE that holds it
 * (`options.load.resolve`, `held.cache`), in TypeScript source: the loader
 * value is a function over the runtime resolver and has none of the
 * properties Node's require carries, so the read would answer undefined
 * where Node answers a function or an object. It is refused by name, and
 * the refusal is the statement's, at run time: the read compiles to a throw
 * of the refusal and the build names the statement (SC6015), so a program
 * that never reaches the read builds and runs as it does under Node. As in
 * Node, the holder is evaluated first, then the arguments of `call` when
 * the member is called where it is read; the throw stands where Node would
 * read the member's answer. Null where the access is not such a read. The
 * binding's own `load.resolve` keeps its lowering. JavaScript has no type
 * to tell a held loader by. */
export function heldLoaderMemberThrow(
  lowerer: Lowerer,
  access: ts.PropertyAccessExpression,
  call?: ts.CallExpression,
): IrExpr | null {
  const member = access.name.text;
  if (!LOADER_OWN_MEMBERS.has(member)) return null;
  if (isJsSourceFile(ts.getSourceFileOfNode(access))) return null;
  const symbol = lowerer.typeOf(access.expression).getSymbol();
  if (
    symbol === undefined ||
    !LOADER_TYPE_NAMES.has(ts.symbolName(symbol)) ||
    !lowerer.isStdlibSymbol(symbol)
  )
    return null;
  if (createRequireCalleeFileOf(lowerer, access.expression) !== null) return null;
  const loc = locOf(access);
  const diag = noLoweringDiag(
    `createRequire loader member '${member}' read through a value that holds the loader`,
    loc,
    "a held loader is a run-time require function without the properties Node's require carries: read them through the createRequire binding itself",
  );
  const stmts: IrStmt[] = [
    { kind: "exprStmt", expr: lowerer.lowerExpr(access.expression), loc: locOf(access.expression) },
  ];
  for (const arg of call?.arguments.nodes ?? []) {
    const value = ts.isSpreadElement(arg) ? arg.expression : arg;
    stmts.push({ kind: "exprStmt", expr: lowerer.lowerExpr(value), loc: locOf(arg) });
  }
  // Recorded once the holder and the arguments have lowered: a refusal of
  // theirs is the build's, and this read then defers nothing.
  lowerer.runtimeFences.push(diag);
  lowerer.noteDeferredRefusal(access, `${diag.code}: ${diag.message}`, diag.hint ?? "");
  const line = ts.getLineAndCharacterOfPosition(ts.getSourceFileOfNode(access), loc.start).line + 1;
  const never = lowerer.declareHiddenLocal("%never", DYN);
  never.mutable = true;
  stmts.push(
    { kind: "varDecl", localId: never.id, init: null, loc },
    {
      kind: "runtimeFence",
      code: diag.code,
      message: `${diag.message} [${diag.code} at ${loc.file}:${line}]`,
      loc,
    },
  );
  return {
    kind: "seqExpr",
    stmts,
    result: varRef(never.id, DYN, loc),
    diverges: true,
    type: DYN,
    loc,
  };
}

/** A createRequire-made require over a RUN-TIME base as a value: unlike a
 * loader anchored at this file, no build-time resolution can back it, so
 * the value is a function that throws the fence when called (typeof still
 * reads "function", stores round-trip it). */
function createRequireFenceFunctionValue(
  lowerer: Lowerer,
  node: ts.Expression,
  nameText: string,
  loc: SrcLoc,
): IrExpr {
  const surface = "createRequire's require over a run-time base";
  const hint =
    "createRequire needs this file (import.meta.url or __filename), which anchors build-time resolution";
  const name = keyedHelperName(
    lowerer,
    "%createRequire.fenceLoader",
    createRequireLoaderAnchorOf(lowerer, node),
  );
  if (lowerer.liftedFnNamed(name) === undefined) {
    lowerer.liftedFns.push({
      name,
      params: [{ localId: "request", name: "request", type: DYN }],
      locals: [{ id: "request", name: "request", type: DYN, mutable: false }],
      returnType: DYN,
      body: [createRequireFence(lowerer, surface, node, hint, "dynamic-require")],
      loc,
    });
  }
  return {
    kind: "dynFrom",
    value: { kind: "closure", fnName: name, captures: [], type: funcOf([DYN], DYN), loc },
    fnName: nameText,
    type: DYN,
    loc,
  };
}

/** One argument of a createRequire factory call as a statement. A spread
 * consumes its iterator, which throws for an operand that is not
 * iterable. */
function createRequireArgumentStmt(lowerer: Lowerer, arg: ts.Expression): IrStmt {
  const argLoc = locOf(arg);
  return {
    kind: "exprStmt",
    expr: ts.isSpreadElement(arg)
      ? checkedIterableSpread(
          lowerer,
          lowerer.lowerExpr(arg.expression),
          ts.getTextOfNode(arg.expression),
          argLoc,
        )
      : lowerer.lowerExpr(arg),
    loc: argLoc,
  };
}

/** The argument expressions of an inline factory call — `createRequire(base)`
 * or a destructured `cr(base)` — as statements in source order. Node
 * evaluates them when it makes the loader, before the loader value exists,
 * so side effects and throws happen there. A statically invalid base never
 * makes a loader: the factory's own argument error stands in for them. */
function createRequireBaseEffectStmts(lowerer: Lowerer, creator: ts.Expression): IrStmt[] {
  const e = withoutParenthesesTypeWrappers(creator);
  if (!ts.isCallExpression(e) || e.questionDotToken) return [];
  // An optional chain that hoisted this call into a local already ran the
  // base: the guarded read re-lowers the receiver, and must not repeat it.
  if (lowerer.chainRecvByNode.has(e)) return [];
  const invalid = createRequireArgumentThrow(lowerer, e, locOf(e));
  if (invalid !== null) return [{ kind: "exprStmt", expr: invalid, loc: locOf(e) }];
  return e.arguments.nodes.map((arg) => createRequireArgumentStmt(lowerer, arg));
}

/** A createRequire use deferred to run time in JavaScript source: as in
 * Node, the expressions that made the callee (`madeBy`) and the call's own
 * arguments are evaluated in order, then the call throws (here, the fence).
 * Code before the call in the same statement runs, and the expression
 * diverges, so nothing after it does. */
function deferredCreateRequireThrow(
  lowerer: Lowerer,
  call: ts.CallExpression,
  surface: string,
  hint: string,
  loc: SrcLoc,
  reason?: string,
  madeBy: readonly IrStmt[] = [],
): IrExpr {
  const stmts: IrStmt[] = [
    ...madeBy,
    ...call.arguments.nodes.map((arg): IrStmt => ({
      kind: "exprStmt",
      expr: lowerer.lowerExpr(arg),
      loc: locOf(arg),
    })),
  ];
  const type = lowerer.irTypeOf(call);
  const slot = lowerer.declareHiddenLocal("%never", type);
  slot.mutable = true;
  stmts.push(
    { kind: "varDecl", localId: slot.id, init: null, loc },
    createRequireFence(lowerer, surface, call, hint, reason),
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

/** What Node's argument check makes of a createRequire factory call:
 * "valid" for a base the check accepts, "invalid" with the text
 * util.inspect prints for a statically known base it rejects, "other" for a
 * base computed at run time (or one whose printed form this check does not
 * reproduce) and for a callee that is not the factory. */
type CreateRequireBaseCheck =
  | { kind: "valid" }
  | { kind: "invalid"; received: string }
  | { kind: "other" };

/** The quoted form util.inspect prints for a string, or null when the text
 * needs escaping this check does not reproduce (a backslash, a control
 * character, or both quote characters). */
function inspectStringText(text: string): string | null {
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (ch === "\\" || code < 0x20 || code === 0x7f) return null;
  }
  const hasSingle = text.includes("'");
  const hasDouble = text.includes('"');
  if (!hasSingle) return `'${text}'`;
  if (!hasDouble) return `"${text}"`;
  return null;
}

/** The text util.inspect prints for a numeric literal: its value in the
 * shortest round-tripping form, separators dropped, and negative zero kept
 * as "-0". */
function numericLiteralText(text: string): string {
  const n = Number(text.replace(/_/g, ""));
  return Object.is(n, -0) ? "-0" : String(n);
}

/** Node's argument check for a createRequire factory call — the named
 * import, or a destructured factory binding: the base must be a file URL
 * object, a file URL string, or an absolute path string. A statically known
 * argument of any other shape is Node's ERR_INVALID_ARG_VALUE throw, where
 * the factory call stands: the compiled loader fence would otherwise stand
 * in for a loader Node never creates. A call with no argument passes
 * undefined. */
function createRequireBaseCheck(lowerer: Lowerer, call: ts.CallExpression): CreateRequireBaseCheck {
  // Only the FACTORY call (`createRequire(<base>)`) takes a filename: a
  // call through the loader it made takes a module id, which has its own
  // lowering.
  const callee = withoutParenthesesTypeWrappers(call.expression);
  const factory =
    ts.isIdentifier(callee) &&
    (isCreateRequireImportValue(lowerer, callee) || createRequireFactoryBinding(lowerer, callee));
  if (!factory) return { kind: "other" };
  const args = call.arguments.nodes;
  if (args.length === 0) return { kind: "invalid", received: "undefined" };
  const arg = withoutParenthesesTypeWrappers(args[0]!);
  const invalid = (received: string): CreateRequireBaseCheck => ({ kind: "invalid", received });
  if (ts.isStringLiteralLike(arg)) {
    const text = arg.text;
    if (text.startsWith("file:") || isAbsoluteRuntimePath(text)) return { kind: "valid" };
    const quoted = inspectStringText(text);
    // A string this check cannot print faithfully still names no usable
    // base, so it keeps the run-time fence rather than a wrong message.
    return quoted === null ? { kind: "other" } : invalid(quoted);
  }
  if (ts.isNumericLiteral(arg)) return invalid(numericLiteralText(arg.text));
  if (
    ts.isPrefixUnaryExpression(arg) &&
    arg.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(arg.operand)
  )
    return invalid(numericLiteralText(`-${arg.operand.text}`));
  if (arg.kind === ts.SyntaxKind.TrueKeyword) return invalid("true");
  if (arg.kind === ts.SyntaxKind.FalseKeyword) return invalid("false");
  if (arg.kind === ts.SyntaxKind.NullKeyword) return invalid("null");
  // `undefined` by itself: the global, through casts, or a local binding
  // that holds undefined all pass Node's check the same value, so the
  // static type decides. A local binding of another type (`const undefined
  // = "/abs/x.cjs"`) is a base like any other and is left to run time.
  if (
    ts.isIdentifier(arg) &&
    arg.text === "undefined" &&
    lowerer.typeOf(arg).flags === ts.TypeFlags.Undefined
  )
    return invalid("undefined");
  if (ts.isVoidExpression(arg)) return invalid("undefined");
  if (ts.isObjectLiteralExpression(arg) && arg.properties.nodes.length === 0) return invalid("{}");
  if (ts.isArrayLiteralExpression(arg) && arg.elements.nodes.length === 0) return invalid("[]");
  return { kind: "other" };
}

/** Whether evaluating a `void` operand can do anything a program observes.
 * The operands that only name a unit (null, undefined, another void) emit
 * no code, so they need no statement of their own. */
function voidOperandHasEffect(expr: ts.Expression): boolean {
  const e = withoutParenthesesTypeWrappers(expr);
  if (e.kind === ts.SyntaxKind.NullKeyword) return false;
  if (ts.isIdentifier(e)) return e.text !== "undefined";
  if (ts.isVoidExpression(e)) return voidOperandHasEffect(e.expression);
  return true;
}

/** Node's argument error for a createRequire factory call whose base is
 * statically invalid, or null. The arguments after the base still run in
 * source order before the throw, as Node evaluates every argument before
 * the factory body runs. */
function createRequireArgumentThrow(
  lowerer: Lowerer,
  call: ts.CallExpression,
  loc: SrcLoc,
): IrExpr | null {
  const check = createRequireBaseCheck(lowerer, call);
  if (check.kind !== "invalid") return null;
  const thrown = nodeThrowExpr(
    1,
    "ERR_INVALID_ARG_VALUE",
    "The argument 'filename' must be a file URL object, file URL string, " +
      `or absolute path string. Received ${check.received}`,
    DYN,
    loc,
  );
  // Every argument runs before the factory body throws. The base itself is
  // a literal with no effect — except `void <expr>`, whose operand Node
  // evaluates and discards before the check.
  const stmts: IrStmt[] = [];
  const first = call.arguments.nodes[0];
  const base = first === undefined ? undefined : withoutParenthesesTypeWrappers(first);
  if (base !== undefined && ts.isVoidExpression(base) && voidOperandHasEffect(base.expression))
    stmts.push(createRequireArgumentStmt(lowerer, base.expression));
  for (const arg of call.arguments.nodes.slice(1))
    stmts.push(createRequireArgumentStmt(lowerer, arg));
  return stmts.length === 0
    ? thrown
    : { kind: "seqExpr", stmts, result: thrown, type: thrown.type, loc };
}

/** The throw a createRequire factory call with a statically invalid base
 * makes where Node makes it, for the paths that evaluate a factory call
 * without lowering it — a `const` binding over a run-time loader, whose
 * declaration keeps the base. Null for a valid or run-time base, and off
 * the factory-call shape. */
export function createRequireCreatorThrow(
  lowerer: Lowerer,
  creator: ts.Expression | undefined,
  loc: SrcLoc,
): IrExpr | null {
  if (creator === undefined) return null;
  const e = withoutParenthesesTypeWrappers(creator);
  if (!ts.isCallExpression(e) || e.questionDotToken) return null;
  return createRequireArgumentThrow(lowerer, e, loc);
}

function isAbsoluteRuntimePath(text: string): boolean {
  return text.startsWith("/") || /^[A-Za-z]:[\\/]/.test(text) || text.startsWith("\\\\");
}

export function lowerCreateRequireCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  loc: SrcLoc,
): IrExpr | null {
  const cr = createRequireSpecOf(lowerer, call);
  if (cr === null) {
    // A createRequire-made require with no build-time base: its use is a
    // run-time require over a base the compiled graph cannot anchor.
    if (!isJsSourceFile(ts.getSourceFileOfNode(call))) return null;
    const callee = withoutParenthesesTypeWrappers(call.expression);
    // A statically invalid base is Node's argument error, thrown where the
    // factory call stands.
    const invalid = createRequireArgumentThrow(lowerer, call, loc);
    if (invalid !== null) return invalid;
    // The factory call itself over a run-time base — `createRequire(base)`
    // or a destructured `cr(base)`: Node evaluates the base arguments,
    // then the factory returns the loader. The compiled loader is the
    // fence, and the base runs where the factory call stands. A call with
    // no argument has no base to evaluate and no loader Node would make.
    if (call.arguments.nodes.length > 0 && createRequireRuntimeBaseOf(lowerer, call)) {
      const stmts = createRequireBaseEffectStmts(lowerer, call);
      const value = createRequireFenceFunctionValue(
        lowerer,
        call,
        ts.isIdentifier(callee) ? callee.text : "createRequire",
        loc,
      );
      return stmts.length === 0
        ? value
        : { kind: "seqExpr", stmts, result: value, type: value.type, loc };
    }
    if (createRequireRuntimeBaseOf(lowerer, callee)) {
      // `createRequire(base)("./x")`: Node evaluates the base — its side
      // effects and throws — when it makes the loader, before the require
      // call's own arguments. The base is plumbing to the compiled graph's
      // RESOLUTION only, never to evaluation.
      return deferredCreateRequireThrow(
        lowerer,
        call,
        "createRequire's require over a run-time base",
        "createRequire needs this file (import.meta.url or __filename), which anchors build-time resolution",
        loc,
        "dynamic-require",
        createRequireBaseEffectStmts(lowerer, callee),
      );
    }
    return null;
  }
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
      return deferredCreateRequireThrow(lowerer, call, surface, hint, loc, "dynamic-require");
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
      // Under a host resolver this probe marks frontend inputs unstable,
      // but every branch here refuses compilation, so successful-build
      // caches keep their existing dependency proofs.
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

/** The statically-known text of a module specifier expression. Module
 * resolution is a build-time artifact, so only a value the compiler already
 * knows can name a module: a string literal (or substitution-free
 * template), a parenthesized or cast form of one, a `+` concatenation of
 * those, or a `const` binding whose initializer folds to one
 * (`const FS = "node:" + "fs"; import(FS)`). Null when the text is only
 * known at run time. */
export function staticString(
  lowerer: Lowerer,
  node: ts.Expression | undefined,
  depth = 0,
): string | null {
  if (node === undefined || depth > 8) return null;
  const value = withoutParenthesesTypeWrappers(node);
  if (ts.isStringLiteralLike(value)) return value.text;
  if (ts.isBinaryExpression(value) && value.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticString(lowerer, value.left, depth + 1);
    if (left === null) return null;
    const right = staticString(lowerer, value.right, depth + 1);
    return right === null ? null : left + right;
  }
  if (ts.isIdentifier(value)) {
    const decl = lowerer.checker.getSymbolAtLocation(value)?.valueDeclaration;
    if (
      decl !== undefined &&
      ts.isVariableDeclaration(decl) &&
      decl.initializer !== undefined &&
      decl.initializer !== value &&
      ts.isVariableDeclarationList(decl.parent) &&
      (decl.parent.flags & ts.NodeFlags.Const) !== 0
    )
      return staticString(lowerer, decl.initializer, depth + 1);
  }
  return null;
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
  const argNode = call.arguments.nodes[0]!;
  const specifier = staticString(lowerer, argNode);
  if (specifier === null) return lowerBoundedImportMetaResolve(lowerer, call, argNode);
  return importMetaResolveAnswer(lowerer, call, specifier);
}

/** What `import.meta.resolve(specifier)` answers in the containing module
 * for one build-time specifier: the resolved URL, or Node's error thrown
 * where the call runs. */
function importMetaResolveAnswer(
  lowerer: Lowerer,
  call: ts.CallExpression,
  specifier: string,
): IrExpr {
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

/** `import.meta.resolve(e)` whose specifier the build can bound
 * (specifier-bounds.ts): a parameter of a module-local function every call
 * of which passes a literal, a conditional over literals, and the other
 * forms a bounded `import()` takes. The call is a selector over the bounded
 * values; each arm is what the literal form of that value answers, a URL
 * or Node's error. The bound is an over-approximation, so the final arm is
 * unreachable; it throws ERR_MODULE_NOT_FOUND rather than falling through.
 * A specifier with no bound keeps the refusal, with the first source that
 * could not be bounded. */
function lowerBoundedImportMetaResolve(
  lowerer: Lowerer,
  call: ts.CallExpression,
  arg: ts.Expression,
): IrExpr {
  const loc = locOf(call);
  const bound = boundSpecifier(lowerer.specifierBoundContext(), arg);
  if (bound.kind !== "set") {
    const at = ts.getSourceFileOfNode(bound.at);
    const line = ts.getLineAndCharacterOfPosition(at, ts.tokenStartOfNode(bound.at)).line + 1;
    lowerer.noLowering(
      "import.meta.resolve with a runtime-computed specifier",
      arg,
      "a compiled binary has a fixed module graph — pass a string literal, a const, or a parameter of a " +
        "module-local function every call of which passes one " +
        `(not bounded at ${at.fileName}:${line}: ${bound.why})`,
    );
  }
  const arms: { value: string; answer: IrExpr }[] = [];
  for (const value of bound.values) {
    arms.push({ value, answer: importMetaResolveAnswer(lowerer, call, value) });
  }
  const specifier = lowerer.declareHiddenLocal("%specifier", STRING);
  const specifierRef = (): IrExpr => varRef(specifier.id, STRING, loc);
  let result: IrExpr = {
    kind: "libCall",
    fn: "error.nodeThrow",
    args: [
      { kind: "numLit", value: 0, type: F64, loc },
      strLit("ERR_MODULE_NOT_FOUND", loc),
      {
        kind: "strConcat",
        left: strLit("Cannot find module '", loc),
        right: {
          kind: "strConcat",
          left: specifierRef(),
          right: strLit("'", loc),
          type: STRING,
          loc,
        },
        type: STRING,
        loc,
      },
    ],
    type: STRING,
    loc,
  };
  for (let i = arms.length - 1; i >= 0; i--) {
    const arm = arms[i]!;
    result = {
      kind: "ternary",
      cond: {
        kind: "strEq",
        negated: false,
        left: specifierRef(),
        right: strLit(arm.value, loc),
        type: BOOL,
        loc,
      },
      then: arm.answer,
      else_: result,
      type: STRING,
      loc,
    };
  }
  return {
    kind: "seqExpr",
    stmts: [
      {
        kind: "varDecl",
        localId: specifier.id,
        init: lowerer.lowerExprExpecting(arg, STRING),
        loc,
      },
    ],
    result,
    type: STRING,
    loc,
  };
}

function requireResolverBaseFile(lowerer: Lowerer, receiver: ts.Expression): ts.SourceFile | null {
  const created = createRequireCalleeFileOf(lowerer, receiver);
  if (created !== null) return created;
  return lowerer.isStdlibGlobal(receiver, "require") &&
    !isNodeEsmFile(ts.getSourceFileOfNode(receiver), lowerer.program)
    ? ts.getSourceFileOfNode(receiver)
    : null;
}

/** One entry of `{ paths: [...] }`: a string literal, or `__dirname` in a
 * CommonJS file (the containing file's own directory, the same build-time
 * value the binding answers). */
function staticResolveOptionPathEntry(lowerer: Lowerer, node: ts.Expression): string | null {
  if (ts.isStringLiteralLike(node)) return node.text;
  const value = withoutParenthesesTypeWrappers(node);
  if (
    ts.isIdentifier(value) &&
    value.text === "__dirname" &&
    lowerer.isStdlibGlobal(value, "__dirname") &&
    !isNodeEsmFile(ts.getSourceFileOfNode(value), lowerer.program)
  ) {
    const source = ts.getSourceFileOfNode(value).fileName;
    // Build-time resolution reads HOST paths (the base file is one). A WASI
    // guest path would send the resolver to a directory that does not exist
    // on the build host; the guest form belongs to the emitted value, not to
    // this lookup.
    const file =
      lowerer.targetPlatform === "wasi"
        ? source
        : runtimePathForTarget(source, lowerer.targetPlatform);
    return lowerer.targetPlatform === "win32" ? win32.dirname(file) : posix.dirname(file);
  }
  return null;
}

function staticResolveOptionPaths(
  lowerer: Lowerer,
  node: ts.Expression | undefined,
): readonly string[] | undefined | null {
  if (node === undefined) return undefined;
  const value = withoutParenthesesTypeWrappers(node);
  if (ts.isIdentifier(value) && value.text === "undefined") return undefined;
  if (!ts.isObjectLiteralExpression(value)) return null;
  let paths: readonly string[] | undefined;
  for (const prop of value.properties.nodes) {
    if (!ts.isPropertyAssignment(prop)) return null;
    const name =
      ts.isIdentifier(prop.name) || ts.isStringLiteralLike(prop.name) ? prop.name.text : null;
    if (name !== "paths" || paths !== undefined) return null;
    const init = withoutParenthesesTypeWrappers(prop.initializer);
    if (!ts.isArrayLiteralExpression(init)) return null;
    const entries: string[] = [];
    for (const item of init.elements.nodes) {
      const entry = staticResolveOptionPathEntry(lowerer, item);
      if (entry === null) return null;
      entries.push(entry);
    }
    paths = entries;
  }
  return paths;
}

/** A createRequire loader's `resolve` (or `resolve.paths`) named where
 * TypeScript source has no value for it: the function exists there only as
 * the callee of a direct call, which resolves at build time. Node's
 * function closes over its module and never reads `this`, so a call that
 * reaches it through a choice of callees (lowerDirectOnlyChoiceCall) is its
 * direct call. JavaScript source reads the function as a value instead
 * (createRequireResolveValue). */
export function isDirectOnlyResolveCallee(lowerer: Lowerer, callee: ts.Expression): boolean {
  if (isJsSourceFile(ts.getSourceFileOfNode(callee))) return false;
  if (!ts.isPropertyAccessExpression(callee) || callee.questionDotToken !== undefined) return false;
  let resolve: ts.PropertyAccessExpression = callee;
  if (callee.name.text === "paths") {
    if (
      !ts.isPropertyAccessExpression(callee.expression) ||
      callee.expression.questionDotToken !== undefined
    )
      return false;
    resolve = callee.expression;
  }
  return (
    resolve.name.text === "resolve" &&
    createRequireCalleeFileOf(lowerer, resolve.expression) !== null
  );
}

/** CommonJS require.resolve and require.resolve.paths for the ambient
 * wrapper or a supported createRequire binding. Results are build-time
 * constants; failures lower to Node's catchable error object. `callee` is
 * the function the call reaches when its own callee expression only chooses
 * it (lowerDirectOnlyChoiceCall). */
export function lowerRequireResolveCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  callee: ts.Expression = call.expression,
): IrExpr | null {
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
  // A run-time-base loader's query: the anchor lives at run time, so the
  // compiled graph cannot answer it. The base that made the loader runs
  // first, then the query's own arguments, then it throws.
  if (
    call.questionDotToken === undefined &&
    createRequireRuntimeBaseOf(lowerer, receiver) &&
    isJsSourceFile(ts.getSourceFileOfNode(call))
  ) {
    const surface = pathsCall ? "require.resolve.paths" : "require.resolve";
    return deferredCreateRequireThrow(
      lowerer,
      call,
      `createRequire's ${surface} over a run-time base`,
      "createRequire needs this file (import.meta.url or __filename), which anchors build-time resolution",
      locOf(call),
      undefined,
      createRequireBaseEffectStmts(lowerer, receiver),
    );
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
  const specifier = staticString(lowerer, call.arguments.nodes[0]);
  // A computed request (or options) through a createRequire loader in
  // JavaScript source resolves at run time.
  if (
    (specifier === null || staticResolveOptionPaths(lowerer, call.arguments.nodes[1]) === null) &&
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
  const paths = staticResolveOptionPaths(lowerer, call.arguments.nodes[1]);
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
