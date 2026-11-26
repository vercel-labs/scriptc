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
  isUnitType,
  type IrExpr,
  type IrStmt,
  type IrType,
  type SrcLoc,
  NULL_T,
  STRING,
  UNDEFINED_T,
  VOID,
  arrayOf,
} from "../../ir/ir.js";
import { boolLit, numLit, strLit, varRef } from "../../ir/build.js";
import { withoutParenthesesTypeWrappers } from "../outer-expressions.js";
import { dynUndefinedExpr } from "../../ir/build.js";

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

/** Whether `node`'s value is a CommonJS module object (or one or
 * undefined/null: `require.main`, `module.parent`), by its type: the
 * `Module` class the standard library declares, which is a number handle in
 * typed storage. A number-typed node answers false on the type flags. */
export function isNodeModuleHandle(lowerer: Lowerer, node: ts.Node): boolean {
  return isNodeModuleType(
    lowerer,
    lowerer.checker.getNonNullableType(lowerer.checker.getTypeAtLocation(node)),
  );
}

/** Whether `type` is the `Module` class the standard library declares. */
export function isNodeModuleType(lowerer: Lowerer, type: ts.Type): boolean {
  if ((type.flags & ts.TypeFlags.Object) === 0) return false;
  const symbol = type.getSymbol();
  return (
    symbol !== undefined &&
    (ts.symbolName(symbol) === "Module" || ts.symbolName(symbol) === "ScriptcModule") &&
    symbol.declarations.some((decl) => lowerer.isStdlibFile(ts.getSourceFileOfNode(decl)))
  );
}

export function isRequireCacheExpr(lowerer: Lowerer, node: ts.Expression): boolean {
  if (!ts.isPropertyAccessExpression(node) || node.name.text !== "cache") return false;
  return cjsGlobal(lowerer, node.expression, "require");
}

/** `require.main`, `module.parent`, and `module.parent.parent`: a property
 * path the module registry answers, even in a JS file whose implicit
 * `module.exports` assignment leaves `module` typed as `any`. */
/** Whether the program has a CommonJS entry module — Node's require.main.
 * An ES-module entry has no CommonJS main, so `require.main` is undefined
 * there even inside the CommonJS modules it imports. */
function requireMainPresent(lowerer: Lowerer): boolean {
  return !isNodeEsmFile(lowerer.entry, lowerer.program);
}

function isRequireMainExpr(lowerer: Lowerer, node: ts.Expression): boolean {
  const value = withoutParenthesesTypeWrappers(node);
  if (ts.isPropertyAccessExpression(value) && !value.questionDotToken && value.name.text === "main")
    return cjsGlobal(lowerer, withoutParenthesesTypeWrappers(value.expression), "require");
  return false;
}

/** `typeof <module value>` for the two spellings whose value the entry kind
 * decides: `require.main` (parenthesized or not) and a const bound from it.
 * A CommonJS entry always has a main module ("object"); an ES-module entry
 * has none, so the value is undefined ("undefined"). Null for every other
 * operand. */
export function lowerModuleValueTypeof(lowerer: Lowerer, node: ts.Expression): IrExpr | null {
  const loc = locOf(node);
  const answer = (): IrExpr => strLit(requireMainPresent(lowerer) ? "object" : "undefined", loc);
  if (isRequireMainExpr(lowerer, node)) return answer();
  const value = withoutParenthesesTypeWrappers(node);
  if (!ts.isIdentifier(value)) return null;
  const symbol = lowerer.checker.getSymbolAtLocation(value);
  const decl = symbol?.valueDeclaration;
  if (
    decl === undefined ||
    !ts.isVariableDeclaration(decl) ||
    decl.initializer === undefined ||
    !ts.isVariableDeclarationList(decl.parent) ||
    (decl.parent.flags & ts.NodeFlags.Const) === 0
  )
    return null;
  return isRequireMainExpr(lowerer, decl.initializer) ? answer() : null;
}

function moduleObjectExpression(lowerer: Lowerer, node: ts.Expression): boolean {
  if (!ts.isPropertyAccessExpression(node) || node.questionDotToken) return false;
  if (node.name.text === "main" && cjsGlobal(lowerer, node.expression, "require"))
    return requireMainPresent(lowerer);
  if (node.name.text !== "parent") return false;
  return (
    isCjsModuleGlobal(lowerer, node.expression) || moduleObjectExpression(lowerer, node.expression)
  );
}

function nodeModuleType(lowerer: Lowerer, node: ts.Expression): boolean {
  // `require.main` in an ES-module-entry program is undefined, so its
  // declared module arm must not make `typeof` answer "object".
  if (
    ts.isPropertyAccessExpression(node) &&
    node.name.text === "main" &&
    !node.questionDotToken &&
    cjsGlobal(lowerer, node.expression, "require") &&
    !requireMainPresent(lowerer)
  )
    return false;
  if (isRequireMainExpr(lowerer, node)) return requireMainPresent(lowerer);
  if (moduleObjectExpression(lowerer, node)) return true;
  const type = lowerer.typeOf(node);
  // `require.main` and `module.parent` are typed `ScriptcModule |
  // undefined`; the module arm is what the value is when it is present, so
  // the union answers through it (the member lowering narrows the arm).
  if (type.isUnionType()) {
    return ts
      .constituentTypes(type)
      .some(
        (arm) =>
          (arm.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Void)) === 0 &&
          nodeModuleTypeOf(lowerer, arm),
      );
  }
  return nodeModuleTypeOf(lowerer, type);
}

function nodeModuleTypeOf(lowerer: Lowerer, type: ts.Type): boolean {
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

/** The declared type of the module member `node` names, which the checker
 * keeps even where the site type is `any` (a JS file that assigns
 * `module.exports`). */
function declaredModuleMemberType(
  lowerer: Lowerer,
  node: ts.Expression,
): IrType | null | undefined {
  if (!ts.isPropertyAccessExpression(node)) return undefined;
  const symbol = lowerer.checker.getSymbolAtLocation(node.name);
  if (!symbol) return undefined;
  const type = lowerer.checker.getTypeOfSymbolAtLocation(symbol, node);
  return type ? lowerer.mapTypeOf(type) : undefined;
}

function optionalModule(
  lowerer: Lowerer,
  node: ts.Expression,
  raw: IrExpr,
  absent: "undefined" | "parent",
): IrExpr {
  let target = lowerer.irTypeOf(node);
  if (target.kind !== "union") {
    // `module.exports = ...` in a JavaScript file leaves `module` typed as
    // any while the ambient declaration still says the member is nullable;
    // the union is what the value is, and the fields it serves need it.
    const declared = declaredModuleMemberType(lowerer, node);
    if (declared != null && declared.kind === "union") target = declared;
  }
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
  const loc = locOf(expr);
  // JavaScript types `require.main` as `any`: Node's Module object, the same
  // one `module.children[i]` answers, so identity comparisons hold.
  if (isAnyTyped(lowerer, expr) || isCjsJsFile(ts.getSourceFileOfNode(expr), lowerer.program)) {
    if (entryId === undefined) return dynUndefined(loc);
    return {
      kind: "libCall",
      fn: "module.dynObject",
      args: [numLit(entryId, loc)],
      type: DYN,
      loc,
    };
  }
  const raw = entryId === undefined ? numLit(-1, loc) : numLit(entryId, loc);
  return lowerer.maybeNarrow(optionalModule(lowerer, expr, raw, "undefined"), expr);
}

/** Whether the use of the CommonJS `module` identifier `expr` keeps the
 * module object where its type is known: a member or element read, a
 * comparison, `typeof`, a truthiness test, or a position that hands the
 * value on with its type (an initializer, an assignment, a return, a
 * literal's element, a logical or conditional operand, an argument for a
 * parameter typed as the module). The value is a number handle there. Any
 * other use (an argument for an untyped parameter, a string conversion, a
 * template, an operator, `in`, a spread) would read that number where Node
 * reads the object. A typed position that later hands the value to an
 * untyped one is refused there (Lowerer.coerceIntoSlot). */
function keepsModuleTyped(lowerer: Lowerer, expr: ts.Identifier): boolean {
  let node: ts.Node = expr;
  for (;;) {
    const parent = node.parent;
    if (parent === undefined) return true;
    if (
      ts.isParenthesizedExpression(parent) ||
      ts.isAsExpression(parent) ||
      ts.isTypeAssertion(parent) ||
      ts.isNonNullExpression(parent) ||
      ts.isSatisfiesExpression(parent)
    ) {
      node = parent;
      continue;
    }
    if (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent))
      return parent.expression === node;
    if (ts.isBinaryExpression(parent)) {
      switch (parent.operatorToken.kind) {
        case ts.SyntaxKind.EqualsEqualsEqualsToken:
        case ts.SyntaxKind.ExclamationEqualsEqualsToken:
        case ts.SyntaxKind.EqualsEqualsToken:
        case ts.SyntaxKind.ExclamationEqualsToken:
        case ts.SyntaxKind.AmpersandAmpersandToken:
        case ts.SyntaxKind.BarBarToken:
        case ts.SyntaxKind.QuestionQuestionToken:
        case ts.SyntaxKind.CommaToken:
          return true;
        case ts.SyntaxKind.EqualsToken:
          return parent.right === node;
        default:
          return false;
      }
    }
    if (ts.isPrefixUnaryExpression(parent))
      return parent.operator === ts.SyntaxKind.ExclamationToken;
    if (ts.isCallExpression(parent) || ts.isNewExpression(parent)) {
      if (parent.expression === node) return true;
      const contextual = lowerer.checker.getContextualType(node as ts.Expression);
      return (
        contextual !== undefined &&
        isNodeModuleType(lowerer, lowerer.checker.getNonNullableType(contextual))
      );
    }
    return (
      ts.isTypeOfExpression(parent) ||
      ts.isVoidExpression(parent) ||
      ts.isConditionalExpression(parent) ||
      ts.isIfStatement(parent) ||
      ts.isWhileStatement(parent) ||
      ts.isDoStatement(parent) ||
      ts.isForStatement(parent) ||
      ts.isVariableDeclaration(parent) ||
      ts.isReturnStatement(parent) ||
      ts.isArrowFunction(parent) ||
      ts.isPropertyAssignment(parent) ||
      ts.isShorthandPropertyAssignment(parent) ||
      ts.isArrayLiteralExpression(parent) ||
      ts.isExpressionStatement(parent)
    );
  }
}

/** The refusal of the CommonJS module object in an untyped position. */
export function untypedModuleValueFence(lowerer: Lowerer, node: ts.Node): never {
  lowerer.unsupported(
    "SC1090",
    node,
    "the CommonJS 'module' object as a value in an untyped position (its members, typeof, and comparisons such as require.main === module lower; an untyped use would see a number where Node has the object)",
  );
}

export function lowerNodeModuleIdentifier(lowerer: Lowerer, expr: ts.Identifier): IrExpr | null {
  if (!isCjsModuleGlobal(lowerer, expr)) return null;
  const ref = cjsModuleRef(lowerer, expr);
  if (ref) {
    // In JavaScript the identifier is itself a value (`child.parent ===
    // module`, `module === require.main`), and Node compares objects: answer
    // the checked-dynamic view of this module, the same object its children
    // and `require.main` answer.
    if (
      (isAnyTyped(lowerer, expr) || isCjsJsFile(ts.getSourceFileOfNode(expr), lowerer.program)) &&
      ref.type.kind === "f64"
    ) {
      return { kind: "libCall", fn: "module.dynObject", args: [ref], type: DYN, loc: locOf(expr) };
    }
    if (!keepsModuleTyped(lowerer, expr)) untypedModuleValueFence(lowerer, expr);
    return ref;
  }
  if (isCjsJsFile(ts.getSourceFileOfNode(expr), lowerer.program)) {
    lowerer.unsupported(
      "SC1090",
      expr,
      "the CommonJS 'module' object in this position (module.exports members, the whole module.exports in comparisons, and the module metadata fields lower)",
    );
  }
  lowerer.unsupported("SC1090", expr, "the CommonJS 'module' object in an ES module");
}

/** The single non-unit arm of a module-valued union (`require.main`,
 * `module.parent`), or the type itself when it is not such a union. */
function moduleArmOf(lowerer: Lowerer, type: IrType): IrType {
  if (type.kind !== "union") return type;
  const arms = lowerer.unions.get(type.unionId)?.arms.filter((arm) => !isUnitType(arm)) ?? [];
  return arms.length === 1 ? arms[0]! : type;
}

/** Whether the checker gives this expression `any` (an untyped JavaScript
 * position, where Node's object itself is the value). */
function isAnyTyped(lowerer: Lowerer, node: ts.Expression): boolean {
  return (lowerer.typeOf(node).flags & ts.TypeFlags.Any) !== 0;
}

/** The checked-dynamic undefined value, for a branch of a dynamic ternary. */
function dynUndefined(loc: SrcLoc): IrExpr {
  return { kind: "dynFrom", value: unitUndefined(loc), type: DYN, loc };
}

function unitUndefined(loc: SrcLoc): IrExpr {
  return { kind: "unitLit", unit: "undefined", type: UNDEFINED_T, loc };
}

export function lowerNodeModuleProperty(
  lowerer: Lowerer,
  expr: ts.PropertyAccessExpression,
): IrExpr | null {
  const direct = isCjsModuleGlobal(lowerer, expr.expression);
  if (!direct && !nodeModuleType(lowerer, expr.expression)) return null;
  if (expr.questionDotToken) return null;
  const member = expr.name.text;
  if (member === "exports" && direct) {
    // A module whose whole export a run-time write chooses: the read is the
    // checked-dynamic slot that write filled (an empty object before it).
    const slot = lowerer.cjsRuntimeWholeExportValueSlotOf(ts.getSourceFileOfNode(expr));
    if (slot !== null && !moduleExportsAlwaysTruthy(lowerer, expr))
      return { kind: "varRef", localId: slot.id, type: DYN, loc: locOf(expr) };
  }
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
  // A binding that holds a module view in checked-dynamic storage reads as
  // the view itself: the checker's handle type must not narrow the read back
  // to a number before the member is chosen.
  if (moduleRef && moduleRef.kind === "dynCheck" && moduleRef.value.type.kind === "dyn")
    moduleRef = moduleRef.value;
  if (moduleRef?.type.kind === "union") {
    // `module.parent` is `ScriptcModule | null | undefined`; the module arm
    // is the only non-unit arm, and it is the one every field read wants.
    const present = moduleArmOf(lowerer, moduleRef.type);
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
  if (moduleRef && moduleRef.type.kind === "dyn") {
    // A JavaScript binding holds the checked-dynamic Module object (an alias
    // of `module`, `require.main` or `module.children[i]`), so its members
    // read from that object.
    const memberLoc = locOf(expr);
    return {
      kind: "dynKeyGet",
      value: moduleRef,
      key: strLit(member, memberLoc),
      type: DYN,
      loc: memberLoc,
    };
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
      // JavaScript reads the CommonJS `module` global as `{ exports }`, so
      // the member is `any`: Node's array of Module objects as checked
      // values, where `children[i].id` and identity comparisons answer what
      // Node answers (the static handle array is for typed programs).
      return isAnyTyped(lowerer, expr) || isCjsJsFile(ts.getSourceFileOfNode(expr), lowerer.program)
        ? { kind: "libCall", fn: "module.dynChildren", args: [moduleRef], type: DYN, loc }
        : call("module.children", arrayOf(F64));
    case "loaded":
      return call("module.loaded", BOOL);
    case "isPreloading":
      return boolLit(false, loc);
    case "parent": {
      if (isAnyTyped(lowerer, expr) || isCjsJsFile(ts.getSourceFileOfNode(expr), lowerer.program)) {
        // The runtime keeps Node's two absent cases apart: the entry is
        // `null` and a module with no CommonJS parent is `undefined`.
        return { kind: "libCall", fn: "module.dynParent", args: [moduleRef], type: DYN, loc };
      }
      return lowerer.maybeNarrow(
        optionalModule(lowerer, expr, call("module.parent", F64), "parent"),
        expr,
      );
    }
    default:
      lowerer.noLowering(
        `module.${member}`,
        expr,
        "the static CommonJS module surface is id, filename, path, paths, loaded, isPreloading, parent, children, exports, and require",
      );
  }
}

/** `typeof module.parent`: null (the CommonJS entry) and a module (a module
 * required by CommonJS) both answer "object"; a module loaded by an ES-module
 * entry has no CommonJS parent and answers "undefined". The registry's
 * absent marker (-2) is the only one that renders "undefined". */
export function lowerModuleParentTypeof(lowerer: Lowerer, node: ts.Expression): IrExpr | null {
  if (!ts.isPropertyAccessExpression(node) || node.questionDotToken) return null;
  if (node.name.text !== "parent" || !isCjsModuleGlobal(lowerer, node.expression)) return null;
  const id = cjsModuleRef(lowerer, node.expression);
  if (!id) return null;
  const loc = locOf(node);
  return {
    kind: "ternary",
    cond: {
      kind: "bin",
      op: "===",
      left: { kind: "libCall", fn: "module.parent", args: [id], type: F64, loc },
      right: numLit(-2, loc),
      type: BOOL,
      loc,
    },
    then: { kind: "strLit", value: "undefined", type: STRING, loc },
    else_: { kind: "strLit", value: "object", type: STRING, loc },
    type: STRING,
    loc,
  };
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

/** True when `expr` evaluates to node:module's `Module` class value: the
 * member read on the node:module namespace, directly or through a const
 * binding initialized with it. */
export function isModuleClassValue(lowerer: Lowerer, expr: ts.Expression): boolean {
  const value = withoutParenthesesTypeWrappers(expr);
  const moduleMember = (e: ts.Expression): boolean => {
    if (!ts.isPropertyAccessExpression(e) || e.questionDotToken || e.name.text !== "Module")
      return false;
    const bi = lowerer.builtinMemberOf(e);
    return bi !== null && bi.module === "module" && bi.member === "Module";
  };
  if (moduleMember(value)) return true;
  if (!ts.isIdentifier(value)) return false;
  const symbol = lowerer.checker.getSymbolAtLocation(value);
  const decl = symbol?.valueDeclaration;
  if (
    decl === undefined ||
    !ts.isVariableDeclaration(decl) ||
    decl.initializer === undefined ||
    !ts.isVariableDeclarationList(decl.parent) ||
    (decl.parent.flags & ts.NodeFlags.Const) === 0
  )
    return false;
  return moduleMember(withoutParenthesesTypeWrappers(decl.initializer));
}

/** A static member of node:module's `Module` class read as a value
 * (`Module.isBuiltin`, `Module.builtinModules`): the class carries the
 * module surface as statics, identical to the namespace's exports, so the
 * read lowers through the same member tables. Null when the class value is
 * not the receiver or the member has no value lowering (an internal such as
 * `_cache` stays unrepresented). */
/** The members node:module's `Module` class carries as statics that the
 * compiled surface can answer. */
const MODULE_CLASS_STATIC_NAMES: readonly string[] = [
  "Module",
  "builtinModules",
  "constants",
  "isBuiltin",
  "syncBuiltinESMExports",
  "enableCompileCache",
  "flushCompileCache",
  "getCompileCacheDir",
  "findPackageJSON",
  "createRequire",
  "getSourceMapsSupport",
  "setSourceMapsSupport",
  "findSourceMap",
  "SourceMap",
  "register",
  "registerHooks",
  "runMain",
  "stripTypeScriptTypes",
];

/** `value`, preceded by the receiver's own evaluation when the receiver is
 * an awaited literal import (`(await import("node:module")).Module`), which
 * the read does not lower: Node evaluates the await where the member is
 * read, before the call's own arguments and the computed key. */
function withModuleClassReceiverLoad(
  lowerer: Lowerer,
  receiver: ts.Expression,
  value: IrExpr,
  loc: SrcLoc,
): IrExpr {
  const load = lowerer.builtinReceiverLoad(receiver, loc);
  return load === null
    ? value
    : { kind: "seqExpr", stmts: [load], result: value, type: value.type, loc };
}

/** `Module[key]` with a runtime STRING key: the key is evaluated once and
 * matched against the class's statics the compiled surface answers, so a
 * computed name reads the same value its own spelling does; any other name
 * reads the class value itself, which answers the constructor's own `name`,
 * `length` and `prototype` and undefined for a name it lacks. Non-string
 * keys keep the general element-read behavior (Node's ToPropertyKey would
 * stringify them, which no static needs here). */
export function lowerModuleClassDynamicStatic(
  lowerer: Lowerer,
  expr: ts.ElementAccessExpression,
): IrExpr | null {
  if (expr.questionDotToken !== undefined) return null;
  if (!isModuleClassValue(lowerer, expr.expression)) return null;
  if (lowerer.foldedStringKeyOf(expr.argumentExpression) !== null) return null;
  const type = lowerer.mapTypeOf(lowerer.typeOf(expr.argumentExpression));
  if (type === null || type.kind !== "string") return null;
  const loc = locOf(expr);
  const keyLocal = lowerer.declareHiddenLocal("%moduleStaticKey", STRING);
  const classValue = lowerer.lowerBuiltinMemberDynValue("module", "Module", loc);
  let chain: IrExpr =
    classValue === null
      ? dynUndefinedExpr(loc)
      : {
          kind: "dynKeyGet",
          value: classValue,
          key: varRef(keyLocal.id, STRING, loc),
          type: DYN,
          loc,
        };
  for (let i = MODULE_CLASS_STATIC_NAMES.length - 1; i >= 0; i--) {
    const member = MODULE_CLASS_STATIC_NAMES[i]!;
    const value = lowerer.lowerBuiltinMemberDynValue("module", member, loc);
    if (value === null) continue;
    chain = {
      kind: "ternary",
      cond: {
        kind: "strEq",
        negated: false,
        left: varRef(keyLocal.id, STRING, loc),
        right: { kind: "strLit", value: member, type: STRING, loc },
        type: { kind: "bool" },
        loc,
      },
      then: lowerer.coerceInto(expr, value, DYN),
      else_: chain,
      type: DYN,
      loc,
    };
  }
  const load = lowerer.builtinReceiverLoad(expr.expression, loc);
  return {
    kind: "seqExpr",
    stmts: [
      ...(load === null ? [] : [load]),
      {
        kind: "varDecl",
        localId: keyLocal.id,
        init: lowerer.coerceInto(
          expr.argumentExpression,
          lowerer.lowerExpr(expr.argumentExpression),
          STRING,
        ),
        loc,
      },
    ],
    result: chain,
    type: DYN,
    loc,
  };
}

export function lowerModuleClassStatic(
  lowerer: Lowerer,
  expr: ts.PropertyAccessExpression,
): IrExpr | null {
  if (expr.questionDotToken) return null;
  if (!isModuleClassValue(lowerer, expr.expression)) return null;
  const value = lowerer.lowerBuiltinMemberDynValue("module", expr.name.text, locOf(expr));
  return value === null
    ? null
    : withModuleClassReceiverLoad(lowerer, expr.expression, value, locOf(expr));
}

/** A call to a static of node:module's `Module` class (`Module.isBuiltin(
 * "fs")`): the static is the module surface's own value, so the call runs
 * the same callable the namespace export is. Null when the receiver is not
 * the class value, the call spreads, or the member has no value lowering. */
export function lowerModuleClassStaticCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
): IrExpr | null {
  const callee = call.expression;
  if (call.questionDotToken !== undefined) return null;
  let member: string | null = null;
  let receiver: ts.Expression;
  if (ts.isPropertyAccessExpression(callee) && !callee.questionDotToken) {
    member = callee.name.text;
    receiver = callee.expression;
  } else if (ts.isElementAccessExpression(callee) && callee.questionDotToken === undefined) {
    member = lowerer.foldedStringKeyOf(callee.argumentExpression);
    receiver = callee.expression;
  } else {
    return null;
  }
  if (member === null) return null;
  if (!isModuleClassValue(lowerer, receiver)) return null;
  if (call.arguments.nodes.some(ts.isSpreadElement)) return null;
  const value = lowerer.lowerBuiltinMemberDynValue("module", member, locOf(callee));
  if (value === null) return null;
  const loc = locOf(call);
  const args = call.arguments.nodes.map((arg) =>
    lowerer.coerceInto(arg, lowerer.lowerExpr(arg), DYN),
  );
  const called: IrExpr = {
    kind: "dynCall",
    callee: value,
    calleeName: ts.getTextOfNode(callee),
    args,
    type: DYN,
    loc,
  };
  const result = lowerer.mapTypeOf(lowerer.typeOf(call));
  const value_ =
    result !== null && result.kind !== "dyn" ? lowerer.coerceToExpected(called, result) : called;
  // The receiver evaluates before the call's own arguments: an awaited
  // literal import does its microtask hop where the call stands.
  return withModuleClassReceiverLoad(lowerer, receiver, value_, loc);
}
