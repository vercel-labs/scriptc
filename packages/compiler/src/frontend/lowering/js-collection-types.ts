/* Types of untyped JavaScript collections that their uses prove.
 *
 * In a JavaScript file, `const m = new Map()`, `new Set()` and `[]` type as
 * Map<any, any>, Set<any> and any[] to the checker, so every use lowers to
 * the checked-dynamic collection operations. When every reference of such a
 * `const` is a direct use of the collection, the value never leaves the
 * binding. If its keys, values or elements are then each one primitive type
 * wherever the program writes and looks them up, the binding lowers as the
 * typed Map<K, V>, Set<K> or T[], as a JSDoc @type would make it:
 *
 * - Map: `m.get(k)`, `m.has(k)`, `m.delete(k)`, `m.clear()`, `m.size`, and
 *   `m.set(k, v)` as a statement (its result is the map).
 * - Set: `s.add(k)` as a statement, `s.has(k)`, `s.delete(k)`, `s.clear()`,
 *   `s.size`.
 * - Array: `a.push(...)`, `a.pop()`, `a.shift()`, `a.at(i)`, `a.includes(v)`,
 *   `a.indexOf(v)`, `a.join(separator)`, `a.length`.
 *
 * Any other reference (passing, returning, storing, exporting, iterating,
 * spreading, inspecting the collection, an optional call), a direct `eval`
 * in the file, or any doubt about a type keeps the binding untyped.
 *
 * The types come from carrier declarations in scriptc-overrides.d.ts, which
 * only the lowering program includes. */

import * as ts from "../ts7/adapter.js";
import { isJsSourceFile } from "../program.js";
import { overridesDtsPath } from "../dts-paths.js";
import type { Lowerer } from "./lowerer.js";

type Primitive = "string" | "number" | "boolean";
const PRIMITIVES: readonly Primitive[] = ["string", "number", "boolean"];

type Collection = "map" | "set" | "array";

interface Candidate {
  readonly kind: Collection;
  readonly declaration: ts.VariableDeclaration;
  /** Every identifier that names the binding, its declaration's included. */
  readonly names: ts.Identifier[];
  /** Map keys or Set members written by set/add. */
  readonly keyWrites: ts.Expression[];
  /** Map values written by set. Array elements written by push. */
  readonly valueWrites: ts.Expression[];
  /** Arguments compared with keys or elements: get/has/delete, includes/indexOf. */
  readonly lookups: ts.Expression[];
  /** Array indexes passed to at(). */
  readonly indexes: ts.Expression[];
  /** Separators passed to join(). */
  readonly separators: ts.Expression[];
  key: Primitive | undefined;
  value: Primitive | undefined;
}

const MAP_LOOKUPS = new Set(["get", "has", "delete"]);
const SET_LOOKUPS = new Set(["has", "delete"]);
const ARRAY_READS = new Set(["pop", "shift"]);
const ARRAY_SEARCHES = new Set(["includes", "indexOf"]);
/** The expression lowering refuses deeper nesting (SC1090). */
const MAX_DEPTH = 200;

/** The inferred type of the binding a `new Map()` or `new Set()` initializes,
 * which the construction adopts. */
export function initializedCollectionType(
  lowerer: Lowerer,
  expr: ts.NewExpression,
): ts.Type | null {
  const declaration = expr.parent;
  return declaration !== undefined &&
    ts.isVariableDeclaration(declaration) &&
    declaration.initializer === expr &&
    ts.isIdentifier(declaration.name)
    ? inferredCollectionType(lowerer, declaration.name)
    : null;
}

/** The inferred collection type of an identifier that names a proven
 * binding, or null. Computed for every JavaScript file of the program on
 * first use. The inference itself reads types (a candidate's constructor
 * through a destructured require, for example); while it runs, those reads
 * see no inferred types rather than starting it again. */
export function inferredCollectionType(lowerer: Lowerer, node: ts.Identifier): ts.Type | null {
  if (lowerer.inferredCollectionTypes === undefined) {
    lowerer.inferredCollectionTypes = new Map();
    lowerer.inferredCollectionTypes = inferProgram(lowerer);
  }
  const types = lowerer.inferredCollectionTypes;
  return types.size === 0 ? null : (types.get(node) ?? null);
}

function inferProgram(lowerer: Lowerer): Map<ts.Node, ts.Type> {
  const out = new Map<ts.Node, ts.Type>();
  const carriers = carrierTypes(lowerer);
  if (carriers === null) return out;
  for (const file of lowerer.program.getImplementationSourceFiles()) {
    if (!isJsSourceFile(file)) continue;
    for (const candidate of inferFile(lowerer, file)) {
      const name =
        candidate.kind === "map"
          ? `map_${candidate.key}_${candidate.value}`
          : candidate.kind === "set"
            ? `set_${candidate.key}`
            : `array_${candidate.value}`;
      const type = carriers.get(name);
      if (type === undefined) continue;
      for (const id of candidate.names) out.set(id, type);
    }
  }
  return out;
}

/** The carrier declarations' types, by name (`map_string_number`,
 * `set_number`, `array_string`, ...), or null when the lowering program does
 * not include them. */
function carrierTypes(lowerer: Lowerer): Map<string, ts.Type> | null {
  const file = lowerer.program.getSourceFile(overridesDtsPath());
  if (file === undefined) return null;
  const out = new Map<string, ts.Type>();
  for (const statement of file.statements.nodes) {
    if (
      !ts.isModuleDeclaration(statement) ||
      !ts.isIdentifier(statement.name) ||
      statement.name.text !== "__scriptcInferredCollections" ||
      statement.body === undefined ||
      !ts.isModuleBlock(statement.body)
    )
      continue;
    for (const member of statement.body.statements.nodes) {
      if (!ts.isVariableStatement(member)) continue;
      for (const declaration of member.declarationList.declarations.nodes)
        if (ts.isIdentifier(declaration.name))
          out.set(declaration.name.text, lowerer.checker.getTypeAtLocation(declaration.name));
    }
  }
  return out.size > 0 ? out : null;
}

function inferFile(lowerer: Lowerer, file: ts.SourceFile): Candidate[] {
  const candidates = new Map<ts.Symbol, Candidate>();
  let directEval = false;
  const declarations = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "eval"
    )
      directEval = true;
    if (ts.isVariableDeclaration(node)) {
      const kind = candidateKind(lowerer, node);
      const symbol = kind !== null ? lowerer.checker.getSymbolAtLocation(node.name) : undefined;
      if (kind !== null && symbol !== undefined)
        candidates.set(symbol, {
          kind,
          declaration: node,
          names: [node.name as ts.Identifier],
          keyWrites: [],
          valueWrites: [],
          lookups: [],
          indexes: [],
          separators: [],
          key: undefined,
          value: undefined,
        });
    }
  };
  ts.walkPreorder(file, declarations);
  if (directEval || candidates.size === 0) return [];

  const names = new Set(
    [...candidates.values()].map((c) => (c.declaration.name as ts.Identifier).text),
  );
  const refused = new Set<ts.Symbol>();
  const references = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && names.has(node.text)) {
      const symbol = referencedSymbol(lowerer, node);
      const candidate = symbol !== undefined ? candidates.get(symbol) : undefined;
      if (symbol !== undefined && candidate !== undefined && node !== candidate.declaration.name) {
        if (recordUse(candidate, node)) candidate.names.push(node);
        else refused.add(symbol);
      }
    }
  };
  ts.walkPreorder(file, references);
  for (const symbol of refused) candidates.delete(symbol);
  const proven = [...candidates.values()].filter(
    (c) => c.valueWrites.length > 0 || c.keyWrites.length > 0,
  );
  solve(lowerer, proven);
  return proven.filter((c) =>
    c.kind === "map" ? c.key && c.value : c.kind === "set" ? c.key : c.value,
  );
}

/** The collection a `const` declaration starts empty, when the checker
 * types it as an untyped Map, Set or array. */
function candidateKind(lowerer: Lowerer, declaration: ts.VariableDeclaration): Collection | null {
  if (!ts.isIdentifier(declaration.name) || declaration.initializer === undefined) return null;
  const list = declaration.parent;
  if (!ts.isVariableDeclarationList(list) || (list.flags & ts.NodeFlags.Const) === 0) return null;
  const statement = list.parent;
  if (
    ts.isVariableStatement(statement) &&
    ts.getModifiers(statement)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
  )
    return null;
  const init = declaration.initializer;
  let kind: Collection | null = null;
  if (ts.isArrayLiteralExpression(init) && init.elements.nodes.length === 0) kind = "array";
  else if (
    ts.isNewExpression(init) &&
    init.typeArguments === undefined &&
    (init.arguments?.nodes.length ?? 0) === 0
  ) {
    if (lowerer.isStdlibGlobal(init.expression, "Map")) kind = "map";
    else if (lowerer.isStdlibGlobal(init.expression, "Set")) kind = "set";
  }
  if (kind === null) return null;
  // A JSDoc type, or anything else the checker already knows, stands.
  const type = lowerer.checker.getTypeAtLocation(declaration.name);
  const args =
    kind === "array"
      ? lowerer.checker.isArrayType(type)
        ? lowerer.checker.getTypeArguments(type as ts.TypeReference)
        : []
      : lowerer.checker.getTypeArguments(type as ts.TypeReference);
  const arity = kind === "map" ? 2 : 1;
  if (args.length !== arity || !args.every((a) => (a.flags & ts.TypeFlags.Any) !== 0)) return null;
  return kind;
}

function referencedSymbol(lowerer: Lowerer, id: ts.Identifier): ts.Symbol | undefined {
  const parent = id.parent;
  if (parent !== undefined && ts.isShorthandPropertyAssignment(parent) && parent.name === id)
    return lowerer.checker.getShorthandAssignmentValueSymbol(parent);
  const symbol = lowerer.checker.getSymbolAtLocation(id);
  // `export { m }` names the export, an alias of the local binding.
  if (
    symbol !== undefined &&
    parent !== undefined &&
    ts.isExportSpecifier(parent) &&
    parent.propertyName === undefined &&
    (symbol.flags & ts.SymbolFlags.Alias) !== 0
  )
    return lowerer.checker.getAliasedSymbol(symbol);
  return symbol;
}

/** Records a reference's use, or answers false when the reference is not
 * one of the collection uses this inference proves. */
function recordUse(candidate: Candidate, id: ts.Identifier): boolean {
  const access = id.parent;
  if (
    access === undefined ||
    !ts.isPropertyAccessExpression(access) ||
    access.expression !== id ||
    access.questionDotToken !== undefined
  )
    return false;
  const name = access.name.text;
  const call = access.parent;
  if (call !== undefined && ts.isCallExpression(call) && call.expression === access) {
    if (call.questionDotToken !== undefined) return false;
    const args = call.arguments.nodes;
    if (args.some(ts.isSpreadElement)) return false;
    switch (candidate.kind) {
      case "map":
        if (MAP_LOOKUPS.has(name) && args.length === 1)
          return (candidate.lookups.push(args[0]!), true);
        if (name === "clear") return args.length === 0;
        if (name === "set" && args.length === 2 && isStatement(call)) {
          candidate.keyWrites.push(args[0]!);
          candidate.valueWrites.push(args[1]!);
          return true;
        }
        return false;
      case "set":
        if (SET_LOOKUPS.has(name) && args.length === 1)
          return (candidate.lookups.push(args[0]!), true);
        if (name === "clear") return args.length === 0;
        if (name === "add" && args.length === 1 && isStatement(call))
          return (candidate.keyWrites.push(args[0]!), true);
        return false;
      case "array":
        if (name === "push") return (candidate.valueWrites.push(...args), true);
        if (ARRAY_READS.has(name)) return args.length === 0;
        if (name === "at" && args.length === 1) return (candidate.indexes.push(args[0]!), true);
        if (ARRAY_SEARCHES.has(name) && args.length === 1)
          return (candidate.lookups.push(args[0]!), true);
        if (name === "join" && args.length <= 1) return (candidate.separators.push(...args), true);
        return false;
    }
  }
  return (candidate.kind === "array" ? name === "length" : name === "size") && isPlainRead(access);
}

function isStatement(call: ts.CallExpression): boolean {
  let node: ts.Node = call;
  while (node.parent !== undefined && ts.isParenthesizedExpression(node.parent)) node = node.parent;
  return node.parent !== undefined && ts.isExpressionStatement(node.parent);
}

/** A read that neither writes nor deletes the property. */
function isPlainRead(access: ts.PropertyAccessExpression): boolean {
  let node: ts.Node = access;
  while (node.parent !== undefined && ts.isParenthesizedExpression(node.parent)) node = node.parent;
  const parent = node.parent;
  if (parent === undefined) return false;
  if (
    ts.isBinaryExpression(parent) &&
    parent.left === node &&
    isAssignment(parent.operatorToken.kind)
  )
    return false;
  if (
    (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) &&
    (parent.operator === ts.SyntaxKind.PlusPlusToken ||
      parent.operator === ts.SyntaxKind.MinusMinusToken)
  )
    return false;
  return !ts.isDeleteExpression(parent);
}

function isAssignment(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}

/** Decides each candidate's key and value types: a fixed point in which a
 * decided candidate's reads type the expressions built from them. */
function solve(lowerer: Lowerer, candidates: Candidate[]): void {
  const bySymbol = new Map<ts.Symbol, Candidate>();
  for (const c of candidates) {
    const symbol = lowerer.checker.getSymbolAtLocation(c.declaration.name);
    if (symbol) bySymbol.set(symbol, c);
  }
  for (let changed = true; changed;) {
    changed = false;
    for (const c of candidates) {
      if (c.kind !== "array" && c.key === undefined) {
        const key = uniform(lowerer, bySymbol, c.keyWrites);
        if (key !== null) {
          c.key = key;
          changed = true;
        }
      }
      if (c.kind !== "set" && c.value === undefined) {
        // Each candidate type is assumed for this collection's own reads.
        const accepted = PRIMITIVES.filter((assumed) => {
          c.value = assumed;
          const found = uniform(lowerer, bySymbol, c.valueWrites);
          c.value = undefined;
          return found === assumed;
        });
        if (accepted.length === 1) {
          c.value = accepted[0];
          changed = true;
        }
      }
    }
  }
  for (const c of candidates) {
    const element = c.kind === "array" ? c.value : c.key;
    // Lookups compare with the stored type; an index is a number.
    const lookupsAgree =
      element !== undefined &&
      c.lookups.every((e) => primitiveOf(lowerer, bySymbol, e, new Set()) === element) &&
      c.indexes.every((e) => primitiveOf(lowerer, bySymbol, e, new Set()) === "number") &&
      c.separators.every((e) => primitiveOf(lowerer, bySymbol, e, new Set()) === "string");
    if (!lookupsAgree) {
      c.key = undefined;
      c.value = undefined;
    }
  }
}

/** The one primitive type of every expression, or null. */
function uniform(
  lowerer: Lowerer,
  bySymbol: Map<ts.Symbol, Candidate>,
  exprs: readonly ts.Expression[],
): Primitive | null {
  let found: Primitive | null = null;
  for (const e of exprs) {
    const p = primitiveOf(lowerer, bySymbol, e, new Set());
    if (p === null || (found !== null && p !== found)) return null;
    found = p;
  }
  return found;
}

function checkerPrimitive(type: ts.Type): Primitive | null {
  const flags = type.flags;
  if (flags & (ts.TypeFlags.String | ts.TypeFlags.StringLiteral)) return "string";
  if (flags & (ts.TypeFlags.Number | ts.TypeFlags.NumberLiteral)) return "number";
  if (flags & (ts.TypeFlags.Boolean | ts.TypeFlags.BooleanLiteral)) return "boolean";
  return null;
}

/** The primitive type `e` always evaluates to, or null. The checker answers
 * where it knows; where it types `e` as `any`, the value's structure does:
 * a read of a decided candidate, arithmetic and comparisons over such
 * values, and constants defined from them. An expression nested deeper than
 * the lowering's nesting limit answers null. */
function primitiveOf(
  lowerer: Lowerer,
  bySymbol: Map<ts.Symbol, Candidate>,
  e: ts.Expression,
  visiting: Set<ts.Node>,
  depth = 0,
): Primitive | null {
  if (depth > MAX_DEPTH) return null;
  const type = lowerer.checker.getTypeAtLocation(e);
  if ((type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) === 0) return checkerPrimitive(type);
  const of = (x: ts.Expression): Primitive | null =>
    primitiveOf(lowerer, bySymbol, x, visiting, depth + 1);
  if (ts.isParenthesizedExpression(e)) return of(e.expression);
  if (ts.isPrefixUnaryExpression(e)) {
    if (e.operator === ts.SyntaxKind.ExclamationToken) return "boolean";
    return e.operator !== ts.SyntaxKind.PlusPlusToken &&
      e.operator !== ts.SyntaxKind.MinusMinusToken &&
      of(e.operand) === "number"
      ? "number"
      : null;
  }
  if (ts.isConditionalExpression(e)) {
    const yes = of(e.whenTrue);
    return yes !== null && yes === of(e.whenFalse) ? yes : null;
  }
  if (ts.isBinaryExpression(e)) {
    const op = e.operatorToken.kind;
    switch (op) {
      case ts.SyntaxKind.LessThanToken:
      case ts.SyntaxKind.GreaterThanToken:
      case ts.SyntaxKind.LessThanEqualsToken:
      case ts.SyntaxKind.GreaterThanEqualsToken:
      case ts.SyntaxKind.EqualsEqualsEqualsToken:
      case ts.SyntaxKind.ExclamationEqualsEqualsToken:
      case ts.SyntaxKind.EqualsEqualsToken:
      case ts.SyntaxKind.ExclamationEqualsToken:
        return "boolean";
      case ts.SyntaxKind.QuestionQuestionToken:
      case ts.SyntaxKind.BarBarToken: {
        // `m.get(k) ?? d` and `a.pop() || d`: the stored type or a default of it.
        const stored = storedRead(lowerer, bySymbol, e.left);
        const fallback = of(e.right);
        return stored !== null && stored === fallback ? stored : null;
      }
      case ts.SyntaxKind.PlusToken: {
        const left = of(e.left);
        const right = of(e.right);
        if (left === "number" && right === "number") return "number";
        return left !== null && right !== null && (left === "string" || right === "string")
          ? "string"
          : null;
      }
      case ts.SyntaxKind.MinusToken:
      case ts.SyntaxKind.AsteriskToken:
      case ts.SyntaxKind.SlashToken:
      case ts.SyntaxKind.PercentToken:
      case ts.SyntaxKind.AsteriskAsteriskToken:
      case ts.SyntaxKind.BarToken:
      case ts.SyntaxKind.AmpersandToken:
      case ts.SyntaxKind.CaretToken:
      case ts.SyntaxKind.LessThanLessThanToken:
      case ts.SyntaxKind.GreaterThanGreaterThanToken:
      case ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken:
        return of(e.left) === "number" && of(e.right) === "number" ? "number" : null;
      default:
        return null;
    }
  }
  if (ts.isCallExpression(e) || ts.isPropertyAccessExpression(e))
    return candidateRead(lowerer, bySymbol, e);
  // A constant defined from such an expression.
  if (ts.isIdentifier(e) && !visiting.has(e)) {
    const symbol = lowerer.checker.getSymbolAtLocation(e);
    const declaration = symbol?.valueDeclaration;
    if (
      declaration !== undefined &&
      ts.isVariableDeclaration(declaration) &&
      declaration.initializer !== undefined &&
      ts.isVariableDeclarationList(declaration.parent) &&
      (declaration.parent.flags & ts.NodeFlags.Const) !== 0
    ) {
      visiting.add(e);
      const p = primitiveOf(lowerer, bySymbol, declaration.initializer, visiting, depth + 1);
      visiting.delete(e);
      return p;
    }
  }
  return null;
}

/** The candidate a use reads, when `e` is `c.member` or `c.member(...)` of a
 * candidate `c`. */
function candidateOf(
  lowerer: Lowerer,
  bySymbol: Map<ts.Symbol, Candidate>,
  e: ts.Expression,
): { candidate: Candidate; member: string } | null {
  const access = ts.isCallExpression(e) ? e.expression : e;
  if (!ts.isPropertyAccessExpression(access) || !ts.isIdentifier(access.expression)) return null;
  const symbol = lowerer.checker.getSymbolAtLocation(access.expression);
  const candidate = symbol !== undefined ? bySymbol.get(symbol) : undefined;
  return candidate !== undefined ? { candidate, member: access.name.text } : null;
}

/** The type of a candidate's read that may answer undefined: `m.get(k)`,
 * `a.pop()`, `a.shift()`, `a.at(i)`. */
function storedRead(
  lowerer: Lowerer,
  bySymbol: Map<ts.Symbol, Candidate>,
  e: ts.Expression,
): Primitive | null {
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  if (!ts.isCallExpression(e)) return null;
  const read = candidateOf(lowerer, bySymbol, e);
  if (read === null) return null;
  const { candidate, member } = read;
  if (candidate.kind === "map" && member === "get") return candidate.value ?? null;
  if (candidate.kind === "array" && (ARRAY_READS.has(member) || member === "at"))
    return candidate.value ?? null;
  return null;
}

/** The type of a candidate's read that always answers a value: size,
 * length, has, includes, indexOf, push. */
function candidateRead(
  lowerer: Lowerer,
  bySymbol: Map<ts.Symbol, Candidate>,
  e: ts.Expression,
): Primitive | null {
  const read = candidateOf(lowerer, bySymbol, e);
  if (read === null) return null;
  const { candidate, member } = read;
  if (!ts.isCallExpression(e)) return member === "size" || member === "length" ? "number" : null;
  if (member === "has" || member === "includes" || member === "delete") return "boolean";
  if (member === "indexOf" || (candidate.kind === "array" && member === "push")) return "number";
  if (candidate.kind === "array" && member === "join") return "string";
  return null;
}
