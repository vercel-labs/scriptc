import { nodeThrowExpr, boolLit, strLit, varRef } from "../../../ir/build.js";
import { dirname, isAbsolute, resolve } from "node:path";
import * as ts from "../../ts7/adapter.js";
import { type Lowerer, PoisonError } from "../lowerer.js";
import { canonicalBuiltinModule, isNodeEsmFile, locOf } from "../../program.js";
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
  invalidJsonModuleDiag,
  nativeAddonDiag,
  unsupportedPackageImportDiag,
} from "../../../diagnostics/diagnostic.js";
import { NODE_BUILTIN_MODULES_V24 } from "../surfaces.js";
import {
  BOOL,
  DYN,
  type IrExpr,
  type IrType,
  NULL_T,
  STRING,
  type SrcLoc,
  UNDEFINED_T,
  arrayOf,
} from "../../../ir/ir.js";
import { lowerFfiMemoryModule } from "../native-ffi.js";
import {
  createRequireSpecOf,
  createRequireProgramModuleOf,
  createRequireCalleeFileOf,
} from "./module-bindings.js";
import { stripTypeCasts } from "./arguments.js";

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
  let argument = lowerer.lowerExpr(argumentNode);
  // A name that may be undefined (a read that may miss): undefined is not a
  // builtin's name, so the call answers false for it, as in Node.
  let optional: { stored: IrExpr; init: IrExpr; unionId: string } | null = null;
  if (
    argument.type.kind === "union" &&
    lowerer.armTag(argument.type.unionId, UNDEFINED_T) >= 0 &&
    lowerer.stripUndefinedArm(argument.type).kind === "string"
  ) {
    const unionId = argument.type.unionId;
    const local = lowerer.declareHiddenLocal("%builtinOptional", argument.type);
    const stored = varRef(local.id, argument.type, loc);
    optional = { stored, init: argument, unionId };
    argument = {
      kind: "unionNarrow",
      unionId,
      tag: lowerer.armTag(unionId, STRING),
      value: stored,
      type: STRING,
      loc,
    };
  }
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
  const checked: IrExpr = {
    kind: "seqExpr",
    stmts: [{ kind: "varDecl", localId: slot.id, init: argument, loc }],
    result,
    type: BOOL,
    loc,
  };
  if (optional === null) return checked;
  const stored = optional.stored as IrExpr & { kind: "varRef" };
  return {
    kind: "seqExpr",
    stmts: [{ kind: "varDecl", localId: stored.localId, init: optional.init, loc }],
    result: {
      kind: "ternary",
      cond: {
        kind: "unionIsTag",
        unionId: optional.unionId,
        tag: lowerer.armTag(optional.unionId, UNDEFINED_T),
        negated: false,
        value: stored,
        type: BOOL,
        loc,
      },
      then: boolLit(false, loc),
      else_: checked,
      type: BOOL,
      loc,
    },
    type: BOOL,
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
    lowerer.noLowering(
      "createRequire's require with this argument shape",
      call,
      'the compiled module graph is fixed at build time — the one lowered form is require("<static string literal>")',
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
  if (
    call.questionDotToken !== undefined ||
    call.arguments.nodes.length < 1 ||
    call.arguments.nodes.length > (pathsCall ? 1 : 2)
  ) {
    lowerer.noLowering(
      pathsCall
        ? "require.resolve.paths with this argument shape"
        : "require.resolve with this argument shape",
      call,
    );
  }
  const specifier = staticString(call.arguments.nodes[0]);
  if (specifier === null) {
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
