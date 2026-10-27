/* Engine-free CommonJS Module graph introspection. Module objects use the
 * process-lifetime f64-handle pattern (readline/diagnostics_channel): the
 * generated program defines immutable metadata once, while the runtime
 * registry tracks cache membership, parent/children, and loaded state as
 * require sites execute. */
import * as posix from "node:path/posix";
import * as win32 from "node:path/win32";
import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";
import type { FileParts } from "./lower-modules.js";
import { lowerCjsExportsObjectValue } from "./cjs-exports-object.js";
import { isCjsJsFile, isNodeEsmFile, locOf } from "../program.js";
import { runtimePathForTarget } from "../runtime-resolve.js";
import {
  BOOL,
  DYN,
  F64,
  type IrExpr,
  type IrStmt,
  type IrType,
  NULL_T,
  STRING,
  UNDEFINED_T,
  VOID,
  arrayOf,
} from "../../ir/ir.js";
import { boolLit, numLit, strLit, varRef } from "../../ir/build.js";

const MODULE_FIELDS = new Set([
  "children",
  "filename",
  "id",
  "isPreloading",
  "loaded",
  "parent",
  "path",
  "paths",
  "require",
]);

function cjsGlobal(lowerer: Lowerer, node: ts.Expression, name: "module" | "require"): boolean {
  if (!ts.isIdentifier(node) || node.text !== name) return false;
  if (lowerer.isStdlibGlobal(node, name)) return true;
  const symbol = lowerer.checker.getSymbolAtLocation(node);
  const decls = symbol ? symbol.declarations : [];
  const sourceShadow = decls.some(
    (decl) =>
      !ts.getSourceFileOfNode(decl).isDeclarationFile &&
      (ts.isVariableDeclaration(decl) ||
        ts.isParameter(decl) ||
        ts.isBindingElement(decl) ||
        ts.isFunctionDeclaration(decl) ||
        ts.isClassDeclaration(decl) ||
        ts.isImportSpecifier(decl) ||
        ts.isNamespaceImport(decl) ||
        ts.isImportEqualsDeclaration(decl)),
  );
  return !sourceShadow && !isNodeEsmFile(ts.getSourceFileOfNode(node), lowerer.program);
}

function graphSyntax(lowerer: Lowerer, sf: ts.SourceFile): boolean {
  let found = false;
  ts.walkPreorder(sf, (node) => {
    if (ts.isPropertyAccessExpression(node)) {
      if (
        cjsGlobal(lowerer, node.expression, "require") &&
        (node.name.text === "main" || node.name.text === "cache")
      ) {
        found = true;
        return "stop";
      }
      if (cjsGlobal(lowerer, node.expression, "module") && MODULE_FIELDS.has(node.name.text)) {
        found = true;
        return "stop";
      }
    }
    if (ts.isIdentifier(node) && cjsGlobal(lowerer, node, "module")) {
      const parent = node.parent;
      if (
        !ts.isPropertyAccessExpression(parent) ||
        parent.expression !== node ||
        (parent.name.text !== "exports" && MODULE_FIELDS.has(parent.name.text))
      ) {
        found = true;
        return "stop";
      }
    }
    return undefined;
  });
  return found;
}

export function prepareCjsModuleGraph(lowerer: Lowerer, parts: readonly FileParts[]): void {
  lowerer.cjsModuleGraphEnabled = parts.some(({ sf }) => graphSyntax(lowerer, sf));
  if (!lowerer.cjsModuleGraphEnabled) return;
  for (const { sf } of parts) {
    if (sf.isDeclarationFile || sf.fileName.endsWith(".json") || isNodeEsmFile(sf, lowerer.program))
      continue;
    // Zero stays reserved so every module handle is truthy like the object
    // it represents, even when a value reaches a generic boolean context.
    const id = lowerer.cjsModuleFiles.length + 1;
    lowerer.cjsModuleFiles.push(sf);
    lowerer.cjsModuleIdOf.set(sf, id);
  }
}

function moduleFileName(lowerer: Lowerer, sf: ts.SourceFile): string {
  return runtimePathForTarget(sf.fileName, lowerer.targetPlatform);
}

function nodeModulePaths(fileName: string, targetPlatform: string): string[] {
  const windows = targetPlatform === "win32";
  const paths: string[] = [];
  let dir = windows ? win32.dirname(fileName) : posix.dirname(fileName);
  for (;;) {
    const basename = windows ? win32.basename(dir) : posix.basename(dir);
    if (basename.toLowerCase() !== "node_modules") {
      paths.push(windows ? win32.join(dir, "node_modules") : posix.join(dir, "node_modules"));
    }
    const parent = windows ? win32.dirname(dir) : posix.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return paths;
}

export function cjsModuleRegistryPrelude(lowerer: Lowerer, loc: IrExpr["loc"]): IrStmt[] {
  if (!lowerer.cjsModuleGraphEnabled) return [];
  const body: IrStmt[] = [
    {
      kind: "exprStmt",
      expr: {
        kind: "libCall",
        fn: "module.registryInit",
        args: [numLit(lowerer.cjsModuleFiles.length + 1, loc)],
        type: VOID,
        loc,
      },
      loc,
    },
  ];
  for (const [index, sf] of lowerer.cjsModuleFiles.entries()) {
    const moduleId = index + 1;
    const filename = moduleFileName(lowerer, sf);
    const isMain = sf === lowerer.entry && !isNodeEsmFile(lowerer.entry, lowerer.program);
    const path =
      lowerer.targetPlatform === "win32" ? win32.dirname(filename) : posix.dirname(filename);
    const paths: IrExpr = {
      kind: "arrayLit",
      elems: nodeModulePaths(filename, lowerer.targetPlatform).map((value) => strLit(value, loc)),
      type: arrayOf(STRING),
      loc,
    };
    body.push({
      kind: "exprStmt",
      expr: {
        kind: "libCall",
        fn: "module.define",
        args: [
          numLit(moduleId, loc),
          strLit(filename, loc),
          strLit(isMain ? "." : filename, loc),
          strLit(path, loc),
          paths,
          boolLit(isMain, loc),
        ],
        type: VOID,
        loc,
      },
      loc,
    });
  }
  return body;
}

export function cjsModuleRef(lowerer: Lowerer, node: ts.Node): IrExpr | null {
  const id = lowerer.cjsModuleIdOf.get(ts.getSourceFileOfNode(node));
  return id === undefined ? null : numLit(id, locOf(node));
}

/** True when `node` is the CommonJS `require` global (not shadowed by a
 * source binding, and not in an ES module). */
export function isCjsRequireGlobal(lowerer: Lowerer, node: ts.Expression): boolean {
  return cjsGlobal(lowerer, node, "require");
}

export function isCjsModuleGlobal(lowerer: Lowerer, node: ts.Expression): boolean {
  return cjsGlobal(lowerer, node, "module");
}

export function isNodeModuleValue(lowerer: Lowerer, node: ts.Expression): boolean {
  return isCjsModuleGlobal(lowerer, node) || nodeModuleType(lowerer, node);
}

export function isRequireCacheExpr(lowerer: Lowerer, node: ts.Expression): boolean {
  if (!ts.isPropertyAccessExpression(node) || node.name.text !== "cache") return false;
  return cjsGlobal(lowerer, node.expression, "require");
}

function nodeModuleType(lowerer: Lowerer, node: ts.Expression): boolean {
  const type = lowerer.typeOf(node);
  const mapped = lowerer.mapTypeOf(type);
  const symbol = type.getSymbol();
  if (
    symbol &&
    (ts.symbolName(symbol) === "Module" || ts.symbolName(symbol) === "ScriptcModule") &&
    symbol.declarations.some((decl) => lowerer.isStdlibFile(ts.getSourceFileOfNode(decl)))
  ) {
    return true;
  }
  const property = lowerer.checker.getPropertyOfType(type, "filename");
  const declaredByModule =
    property &&
    property.declarations.some((decl) => {
      for (let parent: ts.Node | undefined = decl.parent; parent; parent = parent.parent) {
        if (
          (ts.isInterfaceDeclaration(parent) || ts.isClassDeclaration(parent)) &&
          parent.name &&
          (parent.name.text === "ScriptcModule" || parent.name.text === "Module") &&
          lowerer.isStdlibFile(ts.getSourceFileOfNode(parent))
        ) {
          return true;
        }
      }
      return false;
    });
  if (declaredByModule) return true;
  if (mapped?.kind !== "f64") return false;
  const rendered = lowerer.checker.typeToString(type);
  return rendered === "ScriptcModule" || rendered === "NodeModule" || rendered === "NodeJS.Module";
}

/** `module.exports` used only for its truthiness (the UMD test `typeof
 * module !== "undefined" && module.exports`): the exports object starts as
 * a fresh object, so it stays truthy unless the module replaces it with a
 * value that can be falsy. True when every `module.exports = value` in the
 * file assigns an object or function. */
function moduleExportsAlwaysTruthy(lowerer: Lowerer, expr: ts.PropertyAccessExpression): boolean {
  if (!truthinessOnly(expr)) return false;
  const sf = ts.getSourceFileOfNode(expr);
  if (isNodeEsmFile(sf, lowerer.program)) return false;
  let truthy = true;
  ts.walkPreorder(sf, (node) => {
    if (
      !ts.isBinaryExpression(node) ||
      node.operatorToken.kind < ts.SyntaxKind.FirstAssignment ||
      node.operatorToken.kind > ts.SyntaxKind.LastAssignment
    )
      return undefined;
    let target = node.left;
    while (ts.isParenthesizedExpression(target)) target = target.expression;
    if (
      !ts.isPropertyAccessExpression(target) ||
      target.name.text !== "exports" ||
      !isCjsModuleGlobal(lowerer, target.expression)
    )
      return undefined;
    const type = lowerer.typeOf(node.right);
    const objectLike = (t: ts.Type): boolean =>
      t.isUnionType()
        ? ts.constituentTypes(t).every(objectLike)
        : (t.flags & ts.TypeFlags.Object) !== 0 || (t.flags & ts.TypeFlags.NonPrimitive) !== 0;
    if (node.operatorToken.kind !== ts.SyntaxKind.EqualsToken || !objectLike(type)) {
      truthy = false;
      return "stop";
    }
    return undefined;
  });
  return truthy;
}

/** Whether only the truthiness of `node` can be observed: a condition, a
 * `!` operand, or a `&&`/`||` operand of an expression that is itself used
 * only for its truthiness. */
function truthinessOnly(node: ts.Expression): boolean {
  let child: ts.Node = node;
  for (let parent = node.parent; ; child = parent, parent = parent.parent) {
    if (ts.isParenthesizedExpression(parent)) continue;
    if (ts.isPrefixUnaryExpression(parent))
      return parent.operator === ts.SyntaxKind.ExclamationToken;
    if (
      ts.isBinaryExpression(parent) &&
      (parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        parent.operatorToken.kind === ts.SyntaxKind.BarBarToken)
    )
      continue;
    if (ts.isIfStatement(parent) || ts.isWhileStatement(parent) || ts.isDoStatement(parent))
      return parent.expression === child;
    if (ts.isForStatement(parent)) return parent.condition === child;
    if (ts.isConditionalExpression(parent)) return parent.condition === child;
    return false;
  }
}

/** `this` at the top level of a CommonJS module (directly, or inside
 * arrow functions there): Node calls the module wrapper with `this` bound
 * to the module's original exports object. */
export function isCjsTopLevelThis(lowerer: Lowerer, node: ts.Node): boolean {
  if (node.kind !== ts.SyntaxKind.ThisKeyword) return false;
  for (let p: ts.Node | undefined = node.parent; p && !ts.isSourceFile(p); p = p.parent) {
    if (ts.isArrowFunction(p)) continue;
    if (
      ts.isFunctionLike(p) ||
      ts.isClassDeclaration(p) ||
      ts.isClassExpression(p) ||
      ts.isClassStaticBlockDeclaration(p)
    )
      return false;
  }
  return isCjsJsFile(ts.getSourceFileOfNode(node), lowerer.program);
}

export function usesCjsTopLevelThis(lowerer: Lowerer, sf: ts.SourceFile): boolean {
  if (!isCjsJsFile(sf, lowerer.program)) return false;
  let found = false;
  ts.walkPreorder(sf, (node) => {
    if (
      node !== sf &&
      !ts.isArrowFunction(node) &&
      (ts.isFunctionLike(node) ||
        ts.isClassDeclaration(node) ||
        ts.isClassExpression(node) ||
        ts.isClassStaticBlockDeclaration(node))
    )
      return "skip";
    if (node.kind === ts.SyntaxKind.ThisKeyword) {
      found = true;
      return "stop";
    }
    return undefined;
  });
  return found;
}

/** The value of top-level `this` in a CommonJS module: the module's own
 * object standing for its original exports, created when the module starts
 * (lowerFileInit). Exports themselves are the static export table, so a
 * property access through `this` would read or write an object no requirer
 * sees; it keeps a named refusal instead. Typeof, truthiness, identity and
 * passing the value along (the UMD wrapper `(function (root) { ... })(this)`)
 * behave as in Node. */
export function lowerCjsTopLevelThis(lowerer: Lowerer, expr: ts.Expression): IrExpr | null {
  if (!isCjsTopLevelThis(lowerer, expr)) return null;
  const global = lowerer.cjsExportsThis.get(ts.getSourceFileOfNode(expr));
  if (!global) return null;
  let receiver: ts.Node = expr;
  while (ts.isParenthesizedExpression(receiver.parent)) receiver = receiver.parent;
  const access = receiver.parent;
  if (
    (ts.isPropertyAccessExpression(access) || ts.isElementAccessExpression(access)) &&
    access.expression === receiver
  ) {
    lowerer.unsupported(
      "SC1090",
      access,
      "property access through top-level 'this' in a CommonJS module (it is module.exports; spell exports.<name>)",
    );
  }
  return varRef(global.id, DYN, locOf(expr));
}

function optionalModule(
  lowerer: Lowerer,
  node: ts.Expression,
  raw: IrExpr,
  absent: "undefined" | "parent",
): IrExpr {
  const target = lowerer.irTypeOf(node);
  if (target.kind !== "union") return raw;
  const loc = locOf(node);
  const slot = lowerer.declareHiddenLocal("%module", F64);
  const ref = (): IrExpr => varRef(slot.id, F64, loc);
  const moduleValue = lowerer.coerceInto(node, ref(), target);
  const undefinedValue = lowerer.coerceInto(
    node,
    { kind: "unitLit", unit: "undefined", type: UNDEFINED_T, loc },
    target,
  );
  const missing =
    absent === "undefined"
      ? undefinedValue
      : {
          kind: "ternary" as const,
          cond: {
            kind: "bin" as const,
            op: "===" as const,
            left: ref(),
            right: numLit(-1, loc),
            type: BOOL,
            loc,
          },
          then: lowerer.coerceInto(
            node,
            { kind: "unitLit", unit: "null", type: NULL_T, loc },
            target,
          ),
          else_: undefinedValue,
          type: target,
          loc,
        };
  return {
    kind: "seqExpr",
    stmts: [{ kind: "varDecl", localId: slot.id, init: raw, loc }],
    result: {
      kind: "ternary",
      cond: { kind: "bin", op: ">=", left: ref(), right: numLit(0, loc), type: BOOL, loc },
      then: moduleValue,
      else_: missing,
      type: target,
      loc,
    },
    type: target,
    loc,
  };
}

export function lowerRequireMainProperty(
  lowerer: Lowerer,
  expr: ts.PropertyAccessExpression,
): IrExpr | null {
  if (
    expr.questionDotToken ||
    expr.name.text !== "main" ||
    !cjsGlobal(lowerer, expr.expression, "require")
  )
    return null;
  const entryId = lowerer.cjsModuleIdOf.get(lowerer.entry);
  const raw = entryId === undefined ? numLit(-1, locOf(expr)) : numLit(entryId, locOf(expr));
  return lowerer.maybeNarrow(optionalModule(lowerer, expr, raw, "undefined"), expr);
}

export function lowerNodeModuleIdentifier(lowerer: Lowerer, expr: ts.Identifier): IrExpr | null {
  if (!isCjsModuleGlobal(lowerer, expr)) return null;
  const ref = cjsModuleRef(lowerer, expr);
  if (ref) return ref;
  if (isCjsJsFile(ts.getSourceFileOfNode(expr), lowerer.program)) {
    lowerer.unsupported(
      "SC1090",
      expr,
      "the CommonJS 'module' object in this position (module.exports members, the whole module.exports in comparisons, and the module metadata fields lower)",
    );
  }
  lowerer.unsupported("SC1090", expr, "the CommonJS 'module' object in an ES module");
}

export function lowerNodeModuleProperty(
  lowerer: Lowerer,
  expr: ts.PropertyAccessExpression,
): IrExpr | null {
  const direct = isCjsModuleGlobal(lowerer, expr.expression);
  if (!direct && !nodeModuleType(lowerer, expr.expression)) return null;
  if (expr.questionDotToken) return null;
  const member = expr.name.text;
  if (member === "exports" && direct && moduleExportsAlwaysTruthy(lowerer, expr))
    return boolLit(true, locOf(expr));
  if (member === "exports" && direct) {
    const value = lowerCjsExportsObjectValue(lowerer, expr);
    if (value) return value;
  }
  if (member === "exports" || member === "require") return null;
  let moduleRef = direct
    ? cjsModuleRef(lowerer, expr.expression)
    : lowerer.lowerExpr(expr.expression);
  if (moduleRef?.type.kind === "union") {
    const present = lowerer.stripUndefinedArm(moduleRef.type);
    const helper =
      present.kind === "f64"
        ? lowerer.narrowedArmHelper(moduleRef.type.unionId, present, locOf(expr.expression))
        : null;
    if (helper) {
      moduleRef = {
        kind: "call",
        callee: helper,
        args: [moduleRef],
        type: F64,
        loc: locOf(expr.expression),
      };
    }
  }
  if (!moduleRef || moduleRef.type.kind !== "f64") return null;
  const loc = locOf(expr);
  const call = (
    fn:
      | "module.filename"
      | "module.id"
      | "module.path"
      | "module.paths"
      | "module.children"
      | "module.parent"
      | "module.loaded",
    type: IrType,
  ): IrExpr => ({ kind: "libCall", fn, args: [moduleRef], type, loc });
  switch (member) {
    case "filename":
      return call("module.filename", STRING);
    case "id":
      return call("module.id", STRING);
    case "path":
      return call("module.path", STRING);
    case "paths":
      return call("module.paths", arrayOf(STRING));
    case "children":
      return call("module.children", arrayOf(F64));
    case "loaded":
      return call("module.loaded", BOOL);
    case "isPreloading":
      return boolLit(false, loc);
    case "parent":
      return lowerer.maybeNarrow(
        optionalModule(lowerer, expr, call("module.parent", F64), "parent"),
        expr,
      );
    default:
      lowerer.noLowering(
        `module.${member}`,
        expr,
        "the static CommonJS module surface is id, filename, path, paths, loaded, isPreloading, parent, children, exports, and require",
      );
  }
}

export function lowerRequireCacheElement(
  lowerer: Lowerer,
  expr: ts.ElementAccessExpression,
): IrExpr | null {
  if (expr.questionDotToken || !isRequireCacheExpr(lowerer, expr.expression)) return null;
  const key = lowerer.lowerExpr(expr.argumentExpression);
  if (key.type.kind !== "string") {
    lowerer.noLowering("require.cache lookup with a non-string key", expr.argumentExpression);
  }
  const raw: IrExpr = {
    kind: "libCall",
    fn: "module.cacheGet",
    args: [key],
    type: F64,
    loc: locOf(expr),
  };
  return lowerer.maybeNarrow(optionalModule(lowerer, expr, raw, "undefined"), expr);
}

export function lowerRequireCacheHas(lowerer: Lowerer, expr: ts.BinaryExpression): IrExpr | null {
  if (
    expr.operatorToken.kind !== ts.SyntaxKind.InKeyword ||
    !isRequireCacheExpr(lowerer, expr.right)
  )
    return null;
  const key = lowerer.lowerExpr(expr.left);
  if (key.type.kind !== "string")
    lowerer.noLowering("require.cache membership with a non-string key", expr.left);
  return { kind: "libCall", fn: "module.cacheHas", args: [key], type: BOOL, loc: locOf(expr) };
}

export function lowerRequireCacheKeys(
  lowerer: Lowerer,
  call: ts.CallExpression,
  member: string,
): IrExpr | null {
  const argument = call.arguments.nodes[0];
  if (
    member !== "keys" ||
    call.arguments.nodes.length !== 1 ||
    argument === undefined ||
    !isRequireCacheExpr(lowerer, argument)
  )
    return null;
  return {
    kind: "libCall",
    fn: "module.cacheKeys",
    args: [],
    type: arrayOf(STRING),
    loc: locOf(call),
  };
}

function modulePropertyReceiver(lowerer: Lowerer, node: ts.Expression): boolean {
  return isNodeModuleValue(lowerer, node);
}

export function fenceNodeModuleMutation(
  lowerer: Lowerer,
  target: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  action: "assignment" | "delete",
): void {
  if (ts.isElementAccessExpression(target) && isRequireCacheExpr(lowerer, target.expression)) {
    lowerer.noLowering(
      `${action} through require.cache`,
      target,
      "a compiled binary has a fixed module graph; cache lookup and Object.keys(require.cache) are read-only",
      undefined,
      "loader-hook",
    );
  }
  if (
    ts.isPropertyAccessExpression(target) &&
    target.name.text !== "exports" &&
    modulePropertyReceiver(lowerer, target.expression)
  ) {
    lowerer.noLowering(
      `${action} to module.${target.name.text}`,
      target,
      "CommonJS module metadata is read-only in static builds; assign application state to a separate binding",
    );
  }
  if (
    ts.isElementAccessExpression(target) &&
    ts.isPropertyAccessExpression(target.expression) &&
    target.expression.name.text === "paths" &&
    modulePropertyReceiver(lowerer, target.expression.expression)
  ) {
    lowerer.noLowering(
      `${action} through module.paths`,
      target,
      "module.paths is introspection-only in a fixed compiled graph; configure resolution at build time",
    );
  }
}

export function fenceNodeModuleMutationCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (!ts.isPropertyAccessExpression(access.expression)) return null;
  const paths = access.expression;
  if (paths.name.text !== "paths" || !modulePropertyReceiver(lowerer, paths.expression))
    return null;
  const mutators = new Set([
    "copyWithin",
    "fill",
    "pop",
    "push",
    "reverse",
    "shift",
    "sort",
    "splice",
    "unshift",
  ]);
  if (!mutators.has(access.name.text)) return null;
  lowerer.noLowering(
    `module.paths.${access.name.text}()`,
    call,
    "module.paths is introspection-only in a fixed compiled graph; configure resolution at build time",
  );
}
