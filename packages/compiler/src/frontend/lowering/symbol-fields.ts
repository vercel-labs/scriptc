import * as ts from "../ts7/adapter.js";
import {
  bindingEarlyUse7,
  cjsExportDiscardReason,
  isCjsExportTableLiteral,
  isModuleExportsAccess,
} from "../program.js";
import type { Lowerer } from "./lowerer.js";
import type { IrType } from "../../ir/ir.js";

export interface ClassSymbolKey {
  sym: ts.Symbol;
  /** Registry keys share identity across bindings and modules; ordinary
   * Symbol() calls retain the declaring binding's distinct identity. */
  identity: ts.Symbol;
  fieldName: string;
}

const FIELD_PREFIX = "%symbol:";

function constantSymbolDescription(
  lowerer: Lowerer,
  expression: ts.Expression,
  seen = new Set<ts.Symbol>(),
): string | null {
  while (ts.isParenthesizedExpression(expression)) expression = expression.expression;
  if (ts.isStringLiteralLike(expression)) return expression.text;
  if (!ts.isIdentifier(expression) && !ts.isPropertyAccessExpression(expression)) return null;
  const name = ts.isPropertyAccessExpression(expression) ? expression.name : expression;
  if (!ts.isIdentifier(name)) return null;
  const symbol = lowerer.resolveValueSymbol(name);
  if (!symbol || seen.has(symbol)) return null;
  seen.add(symbol);
  const declaration = symbol.valueDeclaration;
  if (
    !declaration ||
    !ts.isVariableDeclaration(declaration) ||
    !declaration.initializer ||
    !ts.isVariableDeclarationList(declaration.parent) ||
    !(declaration.parent.flags & ts.NodeFlags.Const)
  )
    return null;
  return constantSymbolDescription(lowerer, declaration.initializer, seen);
}

export function symbolFieldDisplayName(field: string): string {
  return field.slice(FIELD_PREFIX.length).replace(/^\d+:/, "");
}

/** CopyDataProperties includes symbols, unlike the string-keyed view used
 * by Object.keys/JSON. Refuse known symbol-bearing sources before boxing
 * erases their class type. A spread call argument supplies sources from
 * its array/tuple elements, rather than copying the container itself. */
export function fenceSymbolFieldCopy(
  lowerer: Lowerer,
  node: ts.Node,
  type: IrType,
  spread = false,
): void {
  if (type.kind === "union") {
    for (const arm of lowerer.unions.get(type.unionId)?.arms ?? [])
      fenceSymbolFieldCopy(lowerer, node, arm, spread);
  } else if (spread) {
    if (type.kind === "array") fenceSymbolFieldCopy(lowerer, node, type.elem);
    else if (type.kind === "record") {
      const shape = lowerer.shapes.get(type.shapeId);
      if (shape?.tuple)
        for (const field of shape.fields) fenceSymbolFieldCopy(lowerer, node, field.type);
    }
  } else if (type.kind === "object" && lowerer.classes.get(type.className)?.symbolFields?.size) {
    lowerer.unsupported(
      "SC1031",
      node,
      "copying class instances with symbol-keyed fields (the copied symbols have no record form)",
    );
  }
}

/** The registry name util.inspect.custom denotes. */
export const INSPECT_CUSTOM_DESCRIPTION = "nodejs.util.inspect.custom";
/** The method slot of a class's `[util.inspect.custom]` member. */
export const INSPECT_CUSTOM_MEMBER = `${FIELD_PREFIX}Symbol(${INSPECT_CUSTOM_DESCRIPTION})`;

/** The registry name util.promisify.custom denotes. */
export const PROMISIFY_CUSTOM_DESCRIPTION = "nodejs.util.promisify.custom";

/** `.custom` over one of node:util's functions: a named import, the module
 * namespace (`util.<member>`) or the CommonJS `util_1.<member>`. */
function isUtilFunctionCustomAccess(
  lowerer: Lowerer,
  expr: ts.Expression,
  member: string,
): boolean {
  while (ts.isParenthesizedExpression(expr)) expr = expr.expression;
  if (!ts.isPropertyAccessExpression(expr) || expr.questionDotToken) return false;
  if (!ts.isIdentifier(expr.name) || expr.name.text !== "custom") return false;
  let target = expr.expression;
  while (ts.isParenthesizedExpression(target)) target = target.expression;
  const bi = ts.isIdentifier(target)
    ? lowerer.builtinImportOf(target)
    : ts.isPropertyAccessExpression(target) && !target.questionDotToken
      ? lowerer.builtinMemberOf(target)
      : null;
  return bi?.module === "util" && bi.member === member;
}

/** `inspect.custom` over node:util's inspect: a named import, `util.inspect`
 * or the CommonJS `util_1.inspect`. */
export function isInspectCustomAccess(lowerer: Lowerer, expr: ts.Expression): boolean {
  return isUtilFunctionCustomAccess(lowerer, expr, "inspect");
}

/** `promisify.custom` over node:util's promisify: a named import,
 * `util.promisify` or the CommonJS `util_1.promisify`. */
export function isPromisifyCustomAccess(lowerer: Lowerer, expr: ts.Expression): boolean {
  return isUtilFunctionCustomAccess(lowerer, expr, "promisify");
}

export function classSymbolKeyOf(lowerer: Lowerer, key: ts.Expression): ClassSymbolKey | null {
  // util.inspect.custom is the registered Symbol.for(INSPECT_CUSTOM_DESCRIPTION),
  // one identity with the program's own Symbol.for calls of that name.
  if (isInspectCustomAccess(lowerer, key)) {
    let e = key;
    while (ts.isParenthesizedExpression(e)) e = e.expression;
    const sym = lowerer.checker.getSymbolAtLocation((e as ts.PropertyAccessExpression).name);
    return sym ? symbolKeyOf(lowerer, sym, true, INSPECT_CUSTOM_DESCRIPTION) : null;
  }
  const wellKnown = wellKnownSymbolKeyOf(lowerer, key);
  if (wellKnown !== undefined) return wellKnown;
  if (
    !ts.isIdentifier(key) &&
    (!ts.isPropertyAccessExpression(key) || key.questionDotToken || !ts.isIdentifier(key.name))
  )
    return null;
  const type = lowerer.typeOf(key);
  if (!(type.flags & (ts.TypeFlags.UniqueESSymbol | ts.TypeFlags.ESSymbol))) return null;
  const id = ts.isPropertyAccessExpression(key) ? key.name : key;
  if (!ts.isIdentifier(id)) return null;
  const sym = lowerer.resolveValueSymbol(id);
  return sym ? classSymbolKeyOfSymbol(lowerer, sym) : null;
}

/** Well-known symbols a class field may be keyed by: those no protocol
 * consults on an instance, or whose protocol the lowering reads from the
 * field (Symbol.toStringTag, by the class string conversions). A field
 * keyed by any other well-known symbol (Symbol.iterator, toPrimitive,
 * hasInstance, ...) would be skipped by its protocol, so it keeps the
 * computed-key refusal. */
const FIELD_WELL_KNOWN_SYMBOLS: ReadonlySet<string> = new Set(["toStringTag"]);

/** The key of `Symbol.<name>` on the standard global: undefined when the
 * expression is not one, null when it is a well-known symbol a field may
 * not be keyed by. The identity is the lib's declaration of the property,
 * one symbol for every program reference. */
function wellKnownSymbolKeyOf(
  lowerer: Lowerer,
  key: ts.Expression,
): ClassSymbolKey | null | undefined {
  while (ts.isParenthesizedExpression(key)) key = key.expression;
  if (
    !ts.isPropertyAccessExpression(key) ||
    key.questionDotToken ||
    !ts.isIdentifier(key.expression) ||
    !ts.isIdentifier(key.name) ||
    !lowerer.isStdlibGlobal(key.expression, "Symbol")
  )
    return undefined;
  const name = key.name.text;
  const sym = lowerer.checker.getSymbolAtLocation(key.name);
  if (!sym || !(lowerer.typeOf(key).flags & ts.TypeFlags.UniqueESSymbol)) return undefined;
  if (!FIELD_WELL_KNOWN_SYMBOLS.has(name)) return null;
  return { sym, identity: sym, fieldName: wellKnownSymbolFieldName(name) };
}

/** The layout name of a field keyed by the well-known `Symbol.<name>`: a
 * reserved symbol-field name, printed as Node spells the key. */
export function wellKnownSymbolFieldName(name: string): string {
  return `${FIELD_PREFIX}Symbol(Symbol.${name})`;
}

/** The well-known symbol a field name is keyed by (`toStringTag`), or null. */
export function wellKnownSymbolOfField(field: string): string | null {
  const match = /^%symbol:Symbol\(Symbol\.(\w+)\)$/.exec(field);
  return match === null ? null : match[1]!;
}

/** The layout name of a `Symbol.toStringTag` field. */
export const TO_STRING_TAG_FIELD = wellKnownSymbolFieldName("toStringTag");

/** A literal Symbol()/Symbol.for() initialized once at module scope. The
 * whole-file proof also covers var declarations emitted by bundlers. Keys
 * cannot be used before initialization: a computed class field evaluates
 * its key when the class is defined, even if no instance is constructed. */
export function classSymbolKeyOfSymbol(lowerer: Lowerer, sym: ts.Symbol): ClassSymbolKey | null {
  const cache = lowerer.classSymbolKeys;
  const cached = cache.get(sym);
  if (cached !== undefined) return cached;
  cache.set(sym, null);
  const decls = sym.declarations;
  const decl = sym.valueDeclaration;
  if (decls.length === 1 && decl && ts.isPropertyAssignment(decl)) {
    const key = cjsTableSymbolKeyOf(lowerer, sym, decl);
    if (key) cache.set(sym, key);
    return key;
  }
  // `exports.KEY = Symbol("…")`: a CommonJS module's exported symbol key
  // (the form @nestjs/common's constants take). The export's global holds
  // the symbol value, so the member assignment is as stable as a
  // module-scope const.
  if (decls.length === 1 && decl && ts.isBinaryExpression(decl)) {
    const key = cjsMemberSymbolKeyOf(lowerer, sym, decl);
    if (key) cache.set(sym, key);
    return key;
  }
  if (decls.length !== 1 || !decl || !ts.isVariableDeclaration(decl) || !ts.isIdentifier(decl.name))
    return null;
  const list = decl.parent;
  if (
    !ts.isVariableDeclarationList(list) ||
    !ts.isVariableStatement(list.parent) ||
    !ts.isSourceFile(list.parent.parent)
  )
    return null;
  const init = decl.initializer;
  if (init && (ts.isIdentifier(init) || ts.isPropertyAccessExpression(init))) {
    const target = classSymbolKeyOf(lowerer, init);
    if (!target || bindingWritten(lowerer, sym, ts.getSourceFileOfNode(decl))) return null;
    const preceding = list.declarations.nodes.slice(0, list.declarations.nodes.indexOf(decl));
    if (
      bindingEarlyUse7(
        lowerer.program,
        ts.getSourceFileOfNode(decl),
        ts.getSourceFileOfNode(decl).statements.nodes.indexOf(list.parent),
        decl,
        preceding,
      ) !== null
    )
      return null;
    const alias = { ...target, sym };
    cache.set(sym, alias);
    return alias;
  }
  const call = init ? literalSymbolCallOf(lowerer, init) : null;
  if (!call) return null;
  const { registered, description } = call;
  // Ordinary Symbol() is a fresh identity per evaluation, so only the
  // module-scope declaration above can name one fixed layout slot.
  const sf = ts.getSourceFileOfNode(decl);
  if (bindingWritten(lowerer, sym, sf)) return null;
  const preceding = list.declarations.nodes.slice(0, list.declarations.nodes.indexOf(decl));
  // Creating a function value does not execute its body. The general
  // require-publication analysis conservatively enters those bodies, but a
  // prefix containing only imports and function definitions cannot call
  // them before this key initializes. Cyclic module reads are checked by
  // preflight independently.
  const inertInitializer = (declaration: ts.VariableDeclaration): boolean => {
    const init = declaration.initializer;
    return (
      ts.isIdentifier(declaration.name) &&
      init !== undefined &&
      (ts.isArrowFunction(init) ||
        ts.isFunctionExpression(init) ||
        ts.isStringLiteralLike(init) ||
        ts.isNumericLiteral(init) ||
        init.kind === ts.SyntaxKind.TrueKeyword ||
        init.kind === ts.SyntaxKind.FalseKeyword ||
        init.kind === ts.SyntaxKind.NullKeyword)
    );
  };
  const prefixIsInert =
    sf.statements.nodes
      .slice(0, sf.statements.nodes.indexOf(list.parent))
      .every(
        (statement) =>
          ts.isImportDeclaration(statement) ||
          ts.isFunctionDeclaration(statement) ||
          (ts.isVariableStatement(statement) &&
            statement.declarationList.declarations.nodes.every(inertInitializer)),
      ) && preceding.every(inertInitializer);
  if (
    !prefixIsInert &&
    bindingEarlyUse7(
      lowerer.program,
      sf,
      sf.statements.nodes.indexOf(list.parent),
      decl,
      preceding,
    ) !== null
  )
    return null;
  const key = symbolKeyOf(lowerer, sym, registered, description);
  cache.set(sym, key);
  return key;
}

function symbolKeyOf(
  lowerer: Lowerer,
  sym: ts.Symbol,
  registered: boolean,
  description: string,
  table = false,
): ClassSymbolKey {
  // A registry name denotes one symbol even when several source bindings
  // initialize it. Intern those names into a representative checker symbol;
  // the layout table then has one identity-keyed domain for both forms.
  let identity = sym;
  if (registered) {
    const existing = lowerer.registeredClassSymbols.get(description);
    if (existing) identity = existing;
    else lowerer.registeredClassSymbols.set(description, sym);
  }
  // Distinct identities can share a description (undici's core and mock
  // key tables both hold a `Symbol('close')`, and MockClient inherits one
  // and declares the other). A key-table key whose description an earlier
  // identity already holds takes an ordinal that keeps its slot apart; the
  // printable name drops it. Const keys keep their plain names.
  let identities = lowerer.symbolFieldIdentities.get(description);
  if (!identities) lowerer.symbolFieldIdentities.set(description, (identities = []));
  let ordinal = identities.indexOf(identity);
  if (ordinal < 0) ordinal = identities.push(identity) - 1;
  return {
    sym,
    identity,
    // Symbol slots are not string properties. The reserved prefix keeps
    // them out of the native class's string-keyed dynamic view, including
    // Object.keys/JSON serialization and string-property writeback.
    fieldName: `${FIELD_PREFIX}${table && ordinal > 0 ? `${ordinal}:` : ""}Symbol(${description})`,
  };
}

/** `Symbol(<constant>)` or `Symbol.for(<constant>)` on the standard global. */
function literalSymbolCallOf(
  lowerer: Lowerer,
  init: ts.Expression,
): { registered: boolean; description: string } | null {
  if (!ts.isCallExpression(init) || init.questionDotToken) return null;
  const callee = init.expression;
  const registered =
    ts.isPropertyAccessExpression(callee) && !callee.questionDotToken && callee.name.text === "for";
  const root = registered ? callee.expression : callee;
  if (!ts.isIdentifier(root) || !lowerer.isStdlibGlobal(root, "Symbol")) return null;
  const arg =
    init.arguments.nodes.length === 0
      ? null
      : init.arguments.nodes.length === 1
        ? init.arguments.nodes[0]!
        : undefined;
  if (arg === undefined || (registered && arg === null)) return null;
  const description = arg === null ? "" : constantSymbolDescription(lowerer, arg);
  return description === null ? null : { registered, description };
}

/** A key table property: `kX: Symbol('x')` in a JS module's effective
 * top-level `module.exports = { ... }` literal (undici's core/symbols.js).
 * The module evaluates once, so the property names one symbol identity for
 * every requirer, as a module-scope const does. Requirers can observe the
 * table only after its assignment completes, provided nothing before it
 * can run code (a require there could close a cycle and publish the
 * initial empty exports object instead). Any write to the property, or
 * replacement through `exports`/`module.exports`, keeps it unstable. */
/** `exports.KEY = Symbol("…")` (or `module.exports.KEY = …`) at a
 * CommonJS module's top level: the exported member's symbol is one identity
 * for the module's evaluation, held by the export's global. */
function cjsMemberSymbolKeyOf(
  lowerer: Lowerer,
  sym: ts.Symbol,
  decl: ts.BinaryExpression,
): ClassSymbolKey | null {
  if (decl.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return null;
  const left = decl.left;
  if (!ts.isPropertyAccessExpression(left) || !ts.isIdentifier(left.name)) return null;
  const receiver = left.expression;
  const moduleExports =
    (ts.isIdentifier(receiver) && receiver.text === "exports") ||
    (ts.isPropertyAccessExpression(receiver) &&
      receiver.name.text === "exports" &&
      ts.isIdentifier(receiver.expression) &&
      receiver.expression.text === "module");
  if (!moduleExports) return null;
  const stmt = decl.parent;
  if (stmt === undefined || !ts.isExpressionStatement(stmt) || !ts.isSourceFile(stmt.parent))
    return null;
  const call = literalSymbolCallOf(lowerer, decl.right);
  if (!call) return null;
  const sf = ts.getSourceFileOfNode(decl);
  if (bindingWritten(lowerer, sym, sf)) return null;
  // No OTHER module may write the export: a consumer reassigning
  // `exports.SYM` (rotating the symbol to revoke access, for instance)
  // would make later instances answer from a different key, which a fixed
  // static slot cannot model.
  if (exportSymbolWritten(lowerer, sym, decl)) return null;
  // The assignment must run before any instance can exist: in the defining
  // module it precedes every top-level class declaration and every
  // statement that can run code, so the key is initialized before a class
  // that reads it is defined or constructed (Node's computed key reads the
  // export at the class statement, and a constructor before the assignment
  // writes the property key `undefined`).
  if (!assignmentPrecedesClassUses(decl)) return null;
  return symbolKeyOf(lowerer, sym, call.registered, call.description);
}

/** Whether any source file writes the export member `sym` (a CommonJS
 * assignment, delete, or `Object.defineProperty`) other than its defining
 * assignment. Consumers are resolved through their import aliases. */
function exportSymbolWritten(
  lowerer: Lowerer,
  sym: ts.Symbol,
  definition: ts.BinaryExpression,
): boolean {
  const name = ts.isPropertyAccessExpression(definition.left) ? definition.left.name.text : null;
  const definingFile = ts.getSourceFileOfNode(definition).fileName;
  const checker = lowerer.checker;
  const same = (target: ts.Symbol | undefined): boolean => {
    if (target === undefined) return false;
    const resolved =
      (target.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(target) : target;
    if (resolved === sym) return true;
    return (
      name !== null &&
      resolved.declarations.some((d) => {
        const node = d as unknown as ts.Node;
        return (
          ts.isPropertyAccessExpression(node) &&
          node.name.text === name &&
          ts.getSourceFileOfNode(node).fileName === definingFile
        );
      })
    );
  };
  const writeOf = (node: ts.Expression): boolean => {
    if (ts.isPropertyAccessExpression(node)) {
      if (same(checker.getSymbolAtLocation(node))) return true;
      // An untyped or casted receiver (`(pkg as any).SYM = …`) answers no
      // export symbol; the member NAME still shows the export is replaced.
      // A name match over-refuses only when an unrelated object writes the
      // same member name — the conservative side for a security fence.
      return name !== null && node.name.text === name;
    }
    if (ts.isElementAccessExpression(node)) {
      if (!ts.isStringLiteralLike(node.argumentExpression)) return false;
      if (same(checker.getSymbolAtLocation(node))) return true;
      return name !== null && node.argumentExpression.text === name;
    }
    return false;
  };
  for (const sf of lowerer.program.getImplementationSourceFiles()) {
    if (sf.isDeclarationFile) continue;
    let written = false;
    ts.walkPreorder(sf, (node) => {
      if (written) return "stop";
      if (
        node !== definition &&
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
        writeOf(node.left)
      ) {
        // The compiler's own initialization preamble (`exports.SYM = void 0`)
        // before the defining assignment runs nothing and writes no value.
        if (!(isUndefinedInitialization(node) && precedes(node, definition))) written = true;
      } else if (ts.isDeleteExpression(node) && writeOf(node.expression)) {
        written = true;
      } else if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "defineProperty" &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === "Object" &&
        node.arguments.nodes.length >= 2 &&
        ts.isStringLiteralLike(node.arguments.nodes[1]!) &&
        name !== null &&
        node.arguments.nodes[1]!.text === name &&
        writeOf(node.arguments.nodes[0]!)
      ) {
        written = true;
      }
      return undefined;
    });
    if (written) return true;
  }
  return false;
}

/** Whether `write` assigns only `void 0` / `undefined` (the initialization
 * preamble tsc emits for every export). */
function isUndefinedInitialization(write: ts.BinaryExpression): boolean {
  let value: ts.Expression = write.right;
  while (ts.isParenthesizedExpression(value)) value = value.expression;
  return (
    (ts.isVoidExpression(value) && value.expression.kind === ts.SyntaxKind.NumericLiteral) ||
    (ts.isIdentifier(value) && value.text === "undefined")
  );
}

/** Whether `a` starts before `b` in source order. */
function precedes(a: ts.Node, b: ts.Node): boolean {
  if (ts.getSourceFileOfNode(a) !== ts.getSourceFileOfNode(b)) return true;
  return ts.tokenStartOfNode(a) < ts.tokenStartOfNode(b);
}

/** Whether the defining assignment precedes every top-level statement of its
 * module that can construct or define a class: an instance cannot exist
 * before the export member holds the symbol (Node's key would be undefined).
 * Imports, function declarations and inert variable declarations may
 * precede it; a class declaration, an expression statement, a loop, or a
 * variable initializer that can run code may not. */
function assignmentPrecedesClassUses(decl: ts.BinaryExpression): boolean {
  const stmt = decl.parent;
  if (stmt === undefined) return false;
  const sf = ts.getSourceFileOfNode(decl);
  const at = sf.statements.nodes.indexOf(stmt as ts.Statement);
  if (at < 0) return false;
  const inert = (init: ts.Expression | undefined): boolean => {
    if (init === undefined) return true;
    while (ts.isParenthesizedExpression(init)) init = init.expression;
    return (
      ts.isStringLiteralLike(init) ||
      ts.isNumericLiteral(init) ||
      ts.isArrowFunction(init) ||
      ts.isFunctionExpression(init) ||
      init.kind === ts.SyntaxKind.TrueKeyword ||
      init.kind === ts.SyntaxKind.FalseKeyword ||
      init.kind === ts.SyntaxKind.NullKeyword ||
      (init.kind === ts.SyntaxKind.ThisKeyword && false)
    );
  };
  for (let i = 0; i < at; i++) {
    const statement = sf.statements.nodes[i]!;
    // A directive prologue ("use strict") runs nothing.
    if (ts.isExpressionStatement(statement) && ts.isStringLiteral(statement.expression)) continue;
    if (ts.isImportDeclaration(statement) || ts.isImportEqualsDeclaration(statement)) continue;
    if (ts.isFunctionDeclaration(statement)) continue;
    if (ts.isVariableStatement(statement)) {
      if (
        statement.declarationList.declarations.nodes.every(
          (d) => ts.isIdentifier(d.name) && inert(d.initializer),
        )
      )
        continue;
      return false;
    }
    return false;
  }
  return true;
}

function cjsTableSymbolKeyOf(
  lowerer: Lowerer,
  sym: ts.Symbol,
  decl: ts.PropertyAssignment,
): ClassSymbolKey | null {
  const table = decl.parent;
  if (!ts.isObjectLiteralExpression(table) || !ts.isIdentifier(decl.name)) return null;
  const assign = table.parent;
  if (
    !ts.isBinaryExpression(assign) ||
    assign.right !== table ||
    !isCjsExportTableLiteral(table) ||
    !ts.isExpressionStatement(assign.parent)
  )
    return null;
  const stmt = assign.parent;
  const sf = ts.getSourceFileOfNode(stmt);
  if (cjsExportDiscardReason(stmt) !== null) return null;
  const call = literalSymbolCallOf(lowerer, decl.initializer);
  if (!call) return null;
  const inert = (expr: ts.Expression | undefined): boolean => {
    if (!expr) return true;
    while (ts.isParenthesizedExpression(expr)) expr = expr.expression;
    return (
      ts.isIdentifier(expr) ||
      ts.isArrowFunction(expr) ||
      ts.isFunctionExpression(expr) ||
      ts.isStringLiteralLike(expr) ||
      ts.isNumericLiteral(expr) ||
      expr.kind === ts.SyntaxKind.TrueKeyword ||
      expr.kind === ts.SyntaxKind.FalseKeyword ||
      expr.kind === ts.SyntaxKind.NullKeyword ||
      literalSymbolCallOf(lowerer, expr) !== null
    );
  };
  const statements = sf.statements.nodes;
  const prefixInert = statements
    .slice(0, statements.indexOf(stmt))
    .every(
      (statement) =>
        (ts.isExpressionStatement(statement) && ts.isStringLiteral(statement.expression)) ||
        ts.isFunctionDeclaration(statement) ||
        (ts.isVariableStatement(statement) &&
          statement.declarationList.declarations.nodes.every(
            (d) => ts.isIdentifier(d.name) && inert(d.initializer),
          )),
    );
  if (!prefixInert) return null;
  for (const property of table.properties.nodes) {
    if (property === decl) break;
    if (ts.isShorthandPropertyAssignment(property)) continue;
    if (
      !ts.isPropertyAssignment(property) ||
      ts.isComputedPropertyName(property.name) ||
      !inert(property.initializer)
    )
      return null;
  }
  // Requirers can reach the property through a checker-synthesized symbol
  // (the export= type's member); the declaration's own symbol is the one
  // identity every requirer and the table's export global share.
  const canonical = lowerer.checker.getSymbolAtLocation(decl.name) ?? sym;
  if (tablePropertyWritten(lowerer, new Set([sym, canonical]), decl.name.text, sf)) return null;
  return { ...symbolKeyOf(lowerer, canonical, call.registered, call.description, true), sym };
}

function tablePropertyWritten(
  lowerer: Lowerer,
  symbols: ReadonlySet<ts.Symbol>,
  name: string,
  home: ts.SourceFile,
): boolean {
  let written = false;
  const targets = (node: ts.Node): boolean => {
    if (ts.isPropertyAccessExpression(node)) {
      if (node.name.text !== name) return false;
      const recv = node.expression;
      if (
        ts.getSourceFileOfNode(node) === home &&
        ((ts.isIdentifier(recv) && recv.text === "exports") || isModuleExportsAccess(recv))
      )
        return true;
      const target = lowerer.checker.getSymbolAtLocation(node.name);
      return target !== undefined && symbols.has(target);
    }
    if (ts.isElementAccessExpression(node)) {
      const key = node.argumentExpression;
      if (!ts.isStringLiteralLike(key) || key.text !== name) return false;
      const target = lowerer.checker.getSymbolAtLocation(node);
      return target !== undefined && symbols.has(target);
    }
    return false;
  };
  for (const sf of lowerer.program.getImplementationSourceFiles()) {
    if (written) break;
    if (!ts.sourceTextIncludes(sf, name)) continue;
    ts.walkPreorder(sf, (node) => {
      if (written) return "stop";
      let target: ts.Node | undefined;
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      )
        target = node.left;
      else if (ts.isDeleteExpression(node)) target = node.expression;
      else if (
        (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
        (node.operator === ts.SyntaxKind.PlusPlusToken ||
          node.operator === ts.SyntaxKind.MinusMinusToken)
      )
        target = node.operand;
      if (target && targets(target)) {
        written = true;
        return "stop";
      }
      return undefined;
    });
  }
  return written;
}

function bindingWritten(lowerer: Lowerer, sym: ts.Symbol, sf: ts.SourceFile): boolean {
  let written = false;
  const scanTarget = (target: ts.Node): void => {
    ts.walkPreorder(target, (node) => {
      // Assignment to obj[key] changes the property, never the key's
      // binding. The same applies to these leaves in destructuring.
      if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) return "skip";
      if (!ts.isIdentifier(node) || node.text !== ts.symbolName(sym)) return;
      const targetSym = ts.isShorthandPropertyAssignment(node.parent)
        ? lowerer.checker.getShorthandAssignmentValueSymbol(node.parent)
        : lowerer.checker.getSymbolAtLocation(node);
      if (targetSym === sym) {
        written = true;
        return "stop";
      }
    });
  };
  ts.walkPreorder(sf, (node) => {
    if (written) return "stop";
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      scanTarget(node.left);
    } else if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken ||
        node.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
      scanTarget(node.operand);
    } else if (
      (ts.isForOfStatement(node) || ts.isForInStatement(node)) &&
      !ts.isVariableDeclarationList(node.initializer)
    ) {
      scanTarget(node.initializer);
    }
  });
  return written;
}

/** The layout type of a symbol-keyed field read through a CommonJS
 * key-table key (`this[kCount]` with `kCount` from a `module.exports = {
 * kCount: Symbol('count') }` table), or null. The checker types such keys
 * as plain `symbol`, so it answers the read with the union of every
 * symbol-keyed property of the class; the field's own type is the read's
 * type. Keys declared as consts keep their unique-symbol checker types. */
export function tableKeyFieldType(
  lowerer: Lowerer,
  node: ts.ElementAccessExpression,
): IrType | null {
  const key = node.argumentExpression;
  if (!ts.isIdentifier(key) && !ts.isPropertyAccessExpression(key)) return null;
  const keyType = lowerer.checker.getTypeAtLocation(key);
  if (!(keyType.flags & ts.TypeFlags.ESSymbol) || keyType.flags & ts.TypeFlags.UniqueESSymbol)
    return null;
  const resolved = classSymbolKeyOf(lowerer, key);
  if (!resolved) return null;
  const decl = resolved.identity.valueDeclaration;
  if (!decl || !ts.isPropertyAssignment(decl)) return null;
  const receiver = lowerer.mapTypeOf(lowerer.checker.getTypeAtLocation(node.expression));
  if (receiver?.kind !== "object") return null;
  const info = lowerer.classes.get(receiver.className);
  const field = info?.symbolFields?.get(resolved.identity);
  return field === undefined ? null : (info!.fields.get(field) ?? null);
}
