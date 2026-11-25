/* The element type of an empty array literal that the checker leaves untyped.
 *
 * `{ files: [] }` with no contextual type is `{ files: never[] }`: the
 * literal names no element, and the checker lets the array flow into any
 * typed array slot (`const f: string[] = o.files`). JavaScript has one array
 * there, so the compiled program must too: the array's element
 * representation is decided once, where the array is created, and every
 * name sees that array. Converting the value at each typed slot would make
 * each name its own array.
 *
 * So the property is typed by where its value goes. The search follows the
 * value: out of the literal that holds it, through unannotated bindings and
 * function results, every read of the property in the program, aliases,
 * conditional and logical operands, spreads, callback results and generic
 * calls, until a declared type names the array's element. When every slot
 * reached names the same array type, the property has that type and the
 * literal is built as that array.
 *
 * The search is a choice of representation, not a proof: a flow it does not
 * see leaves the property the unit-element array, and a typed slot that
 * then receives it is refused by name (emptyArrayDiag), as is one array
 * used at two element types. */
import type { IrType } from "../../ir/ir.js";
import { arrayOf, typeEquals } from "../../ir/ir.js";
import { isJsSourceFile } from "../program.js";
import * as ts from "../ts7/adapter.js";
import { isConstAssertionTypeNode, unitOnlyUnion } from "../type-mapper.js";
import { identifiersNamed } from "./identifier-uses.js";
import type { Lowerer } from "./lowerer.js";

type ArrayType = IrType & { kind: "array" };

/** One step from a carried value to the array inside it: a property, an
 * array element, or a function's result. */
type Step = { prop: string } | "elem" | "result";

/** How far the value is followed, in expressions visited and in holders
 * nested (a literal in a literal in a binding, an alias of an alias). */
const MAX_VISITS = 2000;
const MAX_DEPTH = 12;
/** How deep and how wide a call's result type is searched for the property. */
const MAX_TYPE_DEPTH = 4;
const MAX_TYPE_MEMBERS = 48;

function panicSafe<T>(query: () => T, fallback: T): T {
  try {
    return query();
  } catch {
    return fallback;
  }
}

/** Where an untyped empty array is written: a property (`files: []`, also
 * under a const assertion), or a binding of the empty tuple
 * (`const NONE = [] as const`). A plain `const xs = []` is not one: the
 * checker types its reads by the elements written (evolvingArrayType). */
export type EmptyArrayOrigin = ts.PropertyAssignment | ts.VariableDeclaration;

/** The empty array literal `decl` is initialized with when it is an
 * EmptyArrayOrigin, through parentheses and a const assertion; null for
 * other declarations and for JavaScript, whose arrays are untyped. */
export function emptyArrayInitializer(decl: ts.Node | undefined): ts.ArrayLiteralExpression | null {
  if (decl === undefined) return null;
  const binding = ts.isVariableDeclaration(decl);
  if (!binding && !ts.isPropertyAssignment(decl)) return null;
  if (binding && (decl.type !== undefined || !ts.isIdentifier(decl.name))) return null;
  if (decl.initializer === undefined || isJsSourceFile(ts.getSourceFileOfNode(decl))) return null;
  let init: ts.Expression = decl.initializer;
  let asserted = false;
  for (;;) {
    if (ts.isParenthesizedExpression(init)) init = init.expression;
    else if (ts.isAsExpression(init) && isConstAssertionTypeNode(init.type)) {
      asserted = true;
      init = init.expression;
    } else break;
  }
  if (binding && !asserted) return null;
  return ts.isArrayLiteralExpression(init) && init.elements.nodes.length === 0 ? init : null;
}

/** Whether `node` is inside a function or class that declares type
 * parameters: types written there can name them at any depth. */
function insideGenericDeclaration(node: ts.Node): boolean {
  for (let outer = node.parent; outer !== undefined; outer = outer.parent) {
    if (
      (ts.isFunctionLike(outer) || ts.isClassDeclaration(outer) || ts.isClassExpression(outer)) &&
      (outer.typeParameters?.nodes.length ?? 0) > 0
    )
      return true;
  }
  return false;
}

/** The array type the untyped empty array of `decl` (`name: []`,
 * `const NONE = [] as const`) has: the one its contextual type names, or
 * the one array type the typed slots its value reaches agree on. Null when
 * no slot names one or the slots disagree: it keeps the unit-element array. */
export function emptyArrayPlaceType(lowerer: Lowerer, decl: EmptyArrayOrigin): IrType | null {
  const places = lowerer.emptyArrayPlaces;
  const known = places.decided.get(decl);
  if (known !== undefined) return known;
  // The search maps the types it reaches; one of them naming this literal's
  // own type asks again. That inner answer is "undecided", so the outer one
  // must be too, or one type would map two ways.
  if (places.active.has(decl)) {
    places.reentered.add(decl);
    return null;
  }
  const literal = emptyArrayInitializer(decl);
  if (literal === null) {
    places.decided.set(decl, null);
    return null;
  }
  places.active.add(decl);
  let decided: IrType | null = null;
  let generic = false;
  try {
    const search = new Search(lowerer, decl);
    search.origin(literal);
    decided = search.conflict || search.votes.length !== 1 ? null : search.votes[0]!;
    generic = search.generic;
  } finally {
    places.active.delete(decl);
  }
  if (places.reentered.delete(decl)) decided = null;
  // A slot typed through a type parameter maps per instance of the generic
  // declaration it is in (`{ value: T }[]` is one array type per T), so an
  // answer found in or for a generic body is not kept across instances.
  if (!generic && !insideGenericDeclaration(decl)) places.decided.set(decl, decided);
  return decided;
}

/** The array type of a property the checker types `never[]`: an untyped
 * empty array (`files: []`) at the type decided for it, or an alias of one
 * (`list: o.files`, `{ files }` over such a binding) at that array's type.
 * Null for other properties. */
export function untypedArrayPropertyType(
  lowerer: Lowerer,
  decl: ts.PropertyAssignment | ts.ShorthandPropertyAssignment,
): IrType | null {
  if (isJsSourceFile(ts.getSourceFileOfNode(decl))) return null;
  if (ts.isPropertyAssignment(decl)) {
    if (emptyArrayInitializer(decl) !== null) return emptyArrayPlaceType(lowerer, decl);
    return untypedArrayExprType(lowerer, decl.initializer);
  }
  const value = panicSafe(
    () => lowerer.checker.getShorthandAssignmentValueSymbol(decl),
    undefined,
  )?.valueDeclaration;
  if (value === undefined || !(ts.isVariableDeclaration(value) || ts.isBindingElement(value)))
    return null;
  const origin = bindingOrigin(lowerer, value, 0);
  if (origin === null) return null;
  return emptyArrayPlaceType(lowerer, origin) ?? arrayOf(unitOnlyUnion(lowerer.unions));
}

/** The decided array type (emptyArrayPlaceType) of the property or
 * binding that the empty literal `literal` initializes; null when it
 * initializes none or nothing decides it. */
export function emptyArrayLiteralPlaceType(
  lowerer: Lowerer,
  literal: ts.ArrayLiteralExpression,
): IrType | null {
  let value: ts.Node = literal;
  while (
    value.parent !== undefined &&
    (ts.isParenthesizedExpression(value.parent) ||
      (ts.isAsExpression(value.parent) && isConstAssertionTypeNode(value.parent.type)))
  )
    value = value.parent;
  const holder = value.parent;
  if (holder === undefined) return null;
  if (!ts.isPropertyAssignment(holder) && !ts.isVariableDeclaration(holder)) return null;
  if (emptyArrayInitializer(holder) !== literal) return null;
  return emptyArrayPlaceType(lowerer, holder);
}

class Search {
  readonly votes: ArrayType[] = [];
  conflict = false;
  /** A slot reached names its element by a type parameter. */
  generic = false;
  private visits = 0;
  private readonly seen = new Map<ts.Node, number[]>();
  private readonly checker: ts.TypeChecker;

  constructor(
    private readonly lowerer: Lowerer,
    private readonly decl: EmptyArrayOrigin,
  ) {
    this.checker = lowerer.checker;
  }

  /** Start at the literal: its own contextual type decides alone. */
  origin(literal: ts.ArrayLiteralExpression): void {
    const context = panicSafe(() => this.checker.getContextualType(literal), undefined);
    if (context !== undefined && this.vote(context, [])) return;
    this.held(this.decl, [], 0);
  }

  /** Record the array types `type` names at `path`. True when it named one
   * (the value is typed here and needs no further following). */
  private vote(type: ts.Type, path: readonly Step[]): boolean {
    const reached = this.navigate(type, path, 0);
    let named = false;
    for (const array of reached) {
      const mapped = panicSafe(() => this.lowerer.mapTypeOf(array), null);
      if (mapped === null || mapped.kind !== "array" || this.lowerer.unitOnlyElem(mapped.elem))
        continue;
      named = true;
      const element = this.checker.getTypeArguments(array as ts.TypeReference)[0];
      if (element !== undefined && (element.flags & ts.TypeFlags.TypeParameter) !== 0)
        this.generic = true;
      if (!this.votes.some((vote) => typeEquals(vote, mapped))) this.votes.push(mapped);
    }
    if (this.votes.length > 1) this.conflict = true;
    return named;
  }

  /** The settled array types at `path` inside `type`: through null and
   * undefined, union members, promises, and the path's own steps. An
   * untyped array (`never[]`, `any[]`, `readonly []`), an untyped value or
   * a type parameter names nothing. */
  private navigate(type: ts.Type, path: readonly Step[], at: number): ts.Type[] {
    const { checker } = this;
    if (
      (type.flags &
        (ts.TypeFlags.Any |
          ts.TypeFlags.Unknown |
          ts.TypeFlags.Never |
          ts.TypeFlags.TypeParameter |
          ts.TypeFlags.Undefined |
          ts.TypeFlags.Null |
          ts.TypeFlags.Void)) !==
      0
    )
      return [];
    if (type.isUnionType()) {
      const out: ts.Type[] = [];
      for (const part of ts.constituentTypes(type)) out.push(...this.navigate(part, path, at));
      return out;
    }
    if (at === path.length) {
      if (!checker.isArrayType(type)) {
        // A promise of the array where the path ends (an async function's
        // declared result): the awaited value is the array.
        const awaited = this.awaited(type);
        return awaited !== null ? this.navigate(awaited, path, at) : [];
      }
      const element = checker.getTypeArguments(type as ts.TypeReference)[0];
      if (
        element === undefined ||
        (element.flags & (ts.TypeFlags.Never | ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0
      )
        return [];
      return [type];
    }
    const step = path[at]!;
    if (step === "elem") {
      if (checker.isArrayType(type) || checker.isTupleType(type)) {
        const out: ts.Type[] = [];
        for (const element of checker.getTypeArguments(type as ts.TypeReference))
          out.push(...this.navigate(element, path, at + 1));
        return out;
      }
    } else if (step === "result") {
      const out: ts.Type[] = [];
      for (const signature of checker.getSignaturesOfType(type, ts.SignatureKind.Call))
        out.push(...this.navigate(checker.getReturnTypeOfSignature(signature), path, at + 1));
      if (out.length > 0) return out;
    } else {
      const property = checker.getPropertyOfType(type, step.prop);
      if (property !== undefined)
        return this.navigate(checker.getTypeOfSymbol(property), path, at + 1);
    }
    const awaited = this.awaited(type);
    return awaited !== null ? this.navigate(awaited, path, at) : [];
  }

  /** The value a promise type resolves to; null for other types. */
  private awaited(type: ts.Type): ts.Type | null {
    const symbol = type.getSymbol();
    if (symbol === undefined || ts.symbolName(symbol) !== "Promise") return null;
    if (!this.lowerer.isStdlibSymbol(symbol)) return null;
    const args = panicSafe(
      () => this.checker.getTypeArguments(type as ts.TypeReference),
      [] as readonly ts.Type[],
    );
    return args.length === 1 ? args[0]! : null;
  }

  /** Whether `type` still holds an untyped array at `path`: the checker
   * carried the literal's `never[]` through to this type. */
  private untypedAt(type: ts.Type, path: readonly Step[], at: number): boolean {
    const { checker } = this;
    if (type.isUnionType())
      return ts.constituentTypes(type).some((part) => this.untypedAt(part, path, at));
    if (at === path.length) {
      if (checker.isTupleType(type))
        return checker.getTypeArguments(type as ts.TypeReference).length === 0;
      if (!checker.isArrayType(type)) return false;
      const element = checker.getTypeArguments(type as ts.TypeReference)[0];
      return element !== undefined && (element.flags & ts.TypeFlags.Never) !== 0;
    }
    const step = path[at]!;
    if (step === "elem") {
      if (!checker.isArrayType(type) && !checker.isTupleType(type)) return false;
      return checker
        .getTypeArguments(type as ts.TypeReference)
        .some((element) => this.untypedAt(element, path, at + 1));
    }
    if (step === "result")
      return checker
        .getSignaturesOfType(type, ts.SignatureKind.Call)
        .some((signature) =>
          this.untypedAt(checker.getReturnTypeOfSignature(signature), path, at + 1),
        );
    const property = checker.getPropertyOfType(type, step.prop);
    return (
      property !== undefined && this.untypedAt(checker.getTypeOfSymbol(property), path, at + 1)
    );
  }

  /** Whether `symbol` is the property the search started from. */
  private isOrigin(symbol: ts.Symbol | undefined): boolean {
    return (
      symbol !== undefined &&
      (symbol.valueDeclaration === this.decl || (symbol.declarations ?? []).includes(this.decl))
    );
  }

  /** The path to the origin property inside `type` (a generic call's
   * result that the checker built from the literal's type), or null. */
  private pathTo(type: ts.Type, depth: number): Step[] | null {
    if (depth > MAX_TYPE_DEPTH) return null;
    const { checker } = this;
    if (
      (type.flags &
        (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never | ts.TypeFlags.Primitive)) !==
      0
    )
      return null;
    if (type.isUnionType()) {
      for (const part of ts.constituentTypes(type)) {
        const found = this.pathTo(part, depth);
        if (found) return found;
      }
      return null;
    }
    if (checker.isArrayType(type) || checker.isTupleType(type)) {
      for (const element of checker.getTypeArguments(type as ts.TypeReference)) {
        const found = this.pathTo(element, depth + 1);
        if (found) return ["elem", ...found];
      }
      return null;
    }
    const awaited = this.awaited(type);
    if (awaited !== null) return this.pathTo(awaited, depth + 1);
    if ((type.flags & ts.TypeFlags.Object) === 0) return null;
    const properties = checker.getPropertiesOfType(type);
    if (properties.length > MAX_TYPE_MEMBERS) return null;
    for (const property of properties)
      if (this.isOrigin(property)) return [{ prop: ts.symbolName(property) }];
    for (const property of properties) {
      // Only literal-built members can hold the literal: a declared member
      // has a declared type, which the literal's type is not part of.
      const declaration = property.valueDeclaration;
      if (
        declaration === undefined ||
        !(ts.isPropertyAssignment(declaration) || ts.isShorthandPropertyAssignment(declaration))
      )
        continue;
      const found = this.pathTo(checker.getTypeOfSymbol(property), depth + 1);
      if (found) return [{ prop: ts.symbolName(property) }, ...found];
    }
    for (const signature of checker.getSignaturesOfType(type, ts.SignatureKind.Call)) {
      const found = this.pathTo(checker.getReturnTypeOfSignature(signature), depth + 1);
      if (found) return ["result", ...found];
    }
    return null;
  }

  /** The program's TypeScript sources that spell `name`. */
  private filesNaming(name: string): ts.SourceFile[] {
    return this.lowerer.program
      .getSourceFiles()
      .filter(
        (file) => !file.isDeclarationFile && !isJsSourceFile(file) && file.text.includes(name),
      );
  }

  /** Every expression that reads the binding declared by `name`: in its own
   * file, and through an import in the others when it is a module's
   * top-level binding. */
  private usesOfBinding(name: ts.Identifier): ts.Identifier[] {
    const { checker } = this;
    const symbol = panicSafe(() => checker.getSymbolAtLocation(name), undefined);
    if (symbol === undefined) return [];
    const home = ts.getSourceFileOfNode(name);
    const out: ts.Identifier[] = [];
    const resolve = (id: ts.Identifier): ts.Symbol | undefined =>
      ts.isShorthandPropertyAssignment(id.parent) && id.parent.name === id
        ? checker.getShorthandAssignmentValueSymbol(id.parent)
        : checker.getSymbolAtLocation(id);
    for (const id of identifiersNamed(this.lowerer, home, name.text)) {
      if (id === name) continue;
      if (panicSafe(() => resolve(id), undefined) === symbol) out.push(id);
    }
    let scope: ts.Node | undefined = name.parent;
    while (scope !== undefined && !ts.isFunctionLike(scope) && !ts.isSourceFile(scope))
      scope = scope.parent;
    if (scope === undefined || !ts.isSourceFile(scope)) return out;
    for (const file of this.filesNaming(name.text)) {
      if (file === home) continue;
      for (const id of identifiersNamed(this.lowerer, file, name.text)) {
        if (ts.isImportSpecifier(id.parent) || ts.isExportSpecifier(id.parent)) continue;
        const used = panicSafe(() => resolve(id), undefined);
        if (used === undefined || (used.flags & ts.SymbolFlags.Alias) === 0) continue;
        if (panicSafe(() => checker.getAliasedSymbol(used), undefined) === symbol) out.push(id);
      }
    }
    return out;
  }

  /** `holder` (a property assignment, a class field, a variable or binding
   * element, a function) holds a value with the array at `path`: follow
   * every expression that reads the holder. */
  private held(holder: ts.Node, path: readonly Step[], depth: number): void {
    if (depth > MAX_DEPTH || this.conflict) return;
    if (ts.isPropertyAssignment(holder) || ts.isShorthandPropertyAssignment(holder)) {
      const literal = holder.parent;
      const name = holder.name;
      if (!ts.isObjectLiteralExpression(literal)) return;
      if (!ts.isIdentifier(name) && !ts.isStringLiteral(name)) return;
      // The object that holds the property, as a whole.
      this.carried(literal, [{ prop: name.text }, ...path], depth + 1);
      // Every read of the property, wherever the object went.
      this.memberReads(holder, name.text, path, depth);
      return;
    }
    if (ts.isPropertyDeclaration(holder)) {
      if (ts.isIdentifier(holder.name)) this.memberReads(holder, holder.name.text, path, depth);
      return;
    }
    if (ts.isVariableDeclaration(holder) || ts.isBindingElement(holder)) {
      if (!ts.isIdentifier(holder.name)) return;
      for (const use of this.usesOfBinding(holder.name)) this.carried(use, path, depth + 1);
      return;
    }
    if (ts.isFunctionLike(holder)) {
      // A named function's calls carry its result; a function used as a
      // value (a callback, a stored arrow) carries it as that value's result.
      const name =
        (ts.isFunctionDeclaration(holder) || ts.isFunctionExpression(holder)) &&
        holder.name !== undefined
          ? holder.name
          : null;
      if (ts.isMethodDeclaration(holder) && ts.isIdentifier(holder.name)) {
        this.memberReads(holder, holder.name.text, ["result", ...path], depth);
        return;
      }
      if (name !== null && ts.isFunctionDeclaration(holder)) {
        for (const use of this.usesOfBinding(name))
          this.carried(use, ["result", ...path], depth + 1);
        return;
      }
      if (ts.isArrowFunction(holder) || ts.isFunctionExpression(holder))
        this.carried(holder, ["result", ...path], depth + 1);
    }
  }

  /** Reads of the member `name` declared by `declaration`, across the
   * program: `x.name`, and `{ name }` / `{ name: local }` patterns. */
  private memberReads(
    declaration: ts.Node,
    name: string,
    path: readonly Step[],
    depth: number,
  ): void {
    const { checker } = this;
    const declares = (symbol: ts.Symbol | undefined): boolean =>
      symbol !== undefined &&
      (symbol.valueDeclaration === declaration ||
        (symbol.declarations ?? []).includes(declaration));
    for (const file of this.filesNaming(name)) {
      for (const id of identifiersNamed(this.lowerer, file, name)) {
        if (this.conflict) return;
        const parent = id.parent;
        if (ts.isPropertyAccessExpression(parent) && parent.name === id) {
          if (declares(panicSafe(() => checker.getSymbolAtLocation(id), undefined)))
            this.carried(parent, path, depth + 1);
        } else if (
          ts.isBindingElement(parent) &&
          (parent.propertyName ?? parent.name) === id &&
          ts.isObjectBindingPattern(parent.parent) &&
          ts.isIdentifier(parent.name)
        ) {
          const pattern = parent.parent;
          const source = panicSafe(() => checker.getTypeAtLocation(pattern), undefined);
          const member =
            source === undefined
              ? undefined
              : panicSafe(() => checker.getPropertyOfType(source, name), undefined);
          if (declares(member)) this.held(parent, path, depth + 1);
        }
      }
    }
  }

  /** The value of `expr` has the array at `path`. Take the slot it goes
   * into as a vote, or follow the value on. */
  private carried(expr: ts.Expression, path: readonly Step[], depth: number): void {
    if (depth > MAX_DEPTH || this.conflict || ++this.visits > MAX_VISITS) return;
    const lengths = this.seen.get(expr);
    if (lengths?.includes(path.length)) return;
    if (lengths) lengths.push(path.length);
    else this.seen.set(expr, [path.length]);

    const { checker } = this;
    let node: ts.Expression = expr;
    while (
      ts.isParenthesizedExpression(node.parent) ||
      ts.isNonNullExpression(node.parent) ||
      ts.isSatisfiesExpression(node.parent)
    )
      node = node.parent;
    const parent = node.parent;

    // An assertion names the type directly; through `unknown` or `any` (or
    // `as const`) the value goes on to the next assertion or slot.
    if ((ts.isAsExpression(parent) || ts.isTypeAssertion(parent)) && parent.expression === node) {
      if (!isConstAssertionTypeNode(parent.type)) {
        const asserted = panicSafe(() => checker.getTypeFromTypeNode(parent.type), undefined);
        if (asserted !== undefined && this.vote(asserted, path)) return;
      }
      this.carried(parent, path, depth + 1);
      return;
    }
    // A member of the carried value: the next step of the path, or a use
    // of the value that names no type (`.length`, a method, another member).
    if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
      const step = path[0];
      if (step !== undefined && typeof step === "object" && step.prop === parent.name.text)
        this.carried(parent, path.slice(1), depth + 1);
      return;
    }
    if (ts.isElementAccessExpression(parent) && parent.expression === node) {
      const step = path[0];
      const key = parent.argumentExpression;
      if (step === "elem") this.carried(parent, path.slice(1), depth + 1);
      else if (
        step !== undefined &&
        typeof step === "object" &&
        ts.isStringLiteral(key) &&
        key.text === step.prop
      )
        this.carried(parent, path.slice(1), depth + 1);
      return;
    }
    // A call of the carried function: its result.
    if (ts.isCallExpression(parent) && parent.expression === node) {
      if (path[0] === "result") this.carried(parent, path.slice(1), depth + 1);
      return;
    }
    if (ts.isSpreadElement(parent)) return;

    // The declared slot: a typed binding, parameter, result, field or element.
    const context = panicSafe(() => checker.getContextualType(node), undefined);
    if (context !== undefined && this.vote(context, path)) return;

    // No declared element type here: the value goes on.
    if (ts.isConditionalExpression(parent)) {
      if (parent.condition !== node) this.operand(parent, path, depth);
      return;
    }
    if (ts.isBinaryExpression(parent)) {
      const operator = parent.operatorToken.kind;
      const result =
        operator === ts.SyntaxKind.QuestionQuestionToken ||
        operator === ts.SyntaxKind.BarBarToken ||
        ((operator === ts.SyntaxKind.AmpersandAmpersandToken ||
          operator === ts.SyntaxKind.CommaToken) &&
          parent.right === node);
      if (result) this.operand(parent, path, depth);
      return;
    }
    if (ts.isAwaitExpression(parent)) {
      this.carried(parent, path, depth + 1);
      return;
    }
    if (ts.isPropertyAssignment(parent) && parent.initializer === node) {
      this.held(parent, path, depth + 1);
      return;
    }
    if (ts.isShorthandPropertyAssignment(parent) && parent.name === node) {
      this.held(parent, path, depth + 1);
      return;
    }
    if (ts.isSpreadAssignment(parent) && ts.isObjectLiteralExpression(parent.parent)) {
      // The spread's members land in the enclosing literal under their own
      // names, unless a later member replaces the one on the path.
      const step = path[0];
      const literal = parent.parent;
      const members = literal.properties.nodes;
      const replaced =
        step !== undefined &&
        typeof step === "object" &&
        members
          .slice(members.indexOf(parent) + 1)
          .some(
            (member) =>
              (ts.isPropertyAssignment(member) ||
                ts.isShorthandPropertyAssignment(member) ||
                ts.isMethodDeclaration(member)) &&
              (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)) &&
              member.name.text === step.prop,
          );
      if (!replaced) this.carried(literal, path, depth + 1);
      return;
    }
    if (ts.isArrayLiteralExpression(parent)) {
      this.carried(parent, ["elem", ...path], depth + 1);
      return;
    }
    if (ts.isVariableDeclaration(parent) && parent.initializer === node) {
      if (ts.isIdentifier(parent.name)) {
        this.held(parent, path, depth + 1);
        return;
      }
      const step = path[0];
      if (ts.isObjectBindingPattern(parent.name) && step !== undefined && typeof step === "object")
        for (const element of parent.name.elements.nodes) {
          const key = element.propertyName ?? element.name;
          if (ts.isIdentifier(key) && key.text === step.prop && ts.isIdentifier(element.name))
            this.held(element, path.slice(1), depth + 1);
        }
      return;
    }
    if (ts.isPropertyDeclaration(parent) && parent.initializer === node) {
      this.held(parent, path, depth + 1);
      return;
    }
    if (ts.isReturnStatement(parent) || (ts.isArrowFunction(parent) && parent.body === node)) {
      let owner: ts.Node | undefined = parent;
      while (owner !== undefined && !ts.isFunctionLike(owner)) owner = owner.parent;
      if (owner !== undefined) this.held(owner, path, depth + 1);
      return;
    }
    if ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.expression !== node) {
      // An argument whose parameter names no element type (a type
      // parameter, a callback's inferred result): the checker built the
      // call's type from the argument's, so the value is in the result
      // where the literal's type is.
      const result = panicSafe(() => this.lowerer.typeOf(parent), undefined);
      if (result === undefined) return;
      if (this.untypedAt(result, path, 0)) {
        this.carried(parent, path, depth + 1);
        return;
      }
      const found = panicSafe(() => this.pathTo(result, 0), null);
      if (found !== null) this.carried(parent, found, depth + 1);
    }
  }

  /** `expr` is a conditional or logical expression one of whose operands
   * carries the value: its own type names the array when the other operand
   * typed it (`flag ? { errors: [] } : load()`), else the value goes on. */
  private operand(expr: ts.Expression, path: readonly Step[], depth: number): void {
    const own = panicSafe(() => this.lowerer.typeOf(expr), undefined);
    if (own !== undefined && !this.untypedAt(own, path, 0) && this.vote(own, path)) return;
    this.carried(expr, path, depth + 1);
  }
}

/** Whether the checker leaves `type` an untyped array: `never[]`, or the
 * empty tuple of `[] as const`. Asked for every binding and function
 * result, so the checks that need no checker request come first. */
export function isUntypedArrayType(checker: ts.TypeChecker, type: ts.Type): boolean {
  if ((type.flags & ts.TypeFlags.Object) === 0) return false;
  if (checker.isArrayType(type)) {
    const element = checker.getTypeArguments(type as ts.TypeReference)[0];
    return element !== undefined && (element.flags & ts.TypeFlags.Never) !== 0;
  }
  // The empty tuple is the tuple shape itself or a reference to it with
  // no type arguments; any other object type is answered here.
  if (!type.isTupleType() && !type.isTypeReference()) return false;
  return (
    checker.getTypeArguments(type as ts.TypeReference).length === 0 && checker.isTupleType(type)
  );
}

/** The typed array slot inside `expected` that the unit-element array at
 * the same position of `actual` would have to become: the reason a pair
 * has no conversion, for the diagnostic. Null when the pair does not
 * differ that way. */
export function untypedEmptyArraySlot(
  lowerer: Lowerer,
  actual: IrType,
  expected: IrType,
  depth: number,
): IrType | null {
  if (depth > 4) return null;
  if (expected.kind === "union" && actual.kind !== "union") {
    for (const arm of lowerer.unions.get(expected.unionId)?.arms ?? []) {
      if (arm.kind !== actual.kind) continue;
      const found = untypedEmptyArraySlot(lowerer, actual, arm, depth + 1);
      if (found !== null) return found;
    }
    return null;
  }
  if (actual.kind === "array" && expected.kind === "array") {
    if (lowerer.unitOnlyElem(actual.elem))
      return lowerer.unitOnlyElem(expected.elem) ? null : expected;
    return untypedEmptyArraySlot(lowerer, actual.elem, expected.elem, depth + 1);
  }
  if (actual.kind === "record" && expected.kind === "record") {
    const from = lowerer.shapes.get(actual.shapeId);
    const to = lowerer.shapes.get(expected.shapeId);
    if (!from || !to) return null;
    for (const field of from.fields) {
      const target = to.fields.find((candidate) => candidate.name === field.name);
      if (target === undefined || typeEquals(field.type, target.type)) continue;
      const found = untypedEmptyArraySlot(lowerer, field.type, target.type, depth + 1);
      if (found !== null) return found;
    }
  }
  return null;
}

/** The property assignment whose untyped empty array `expr` reads: a member
 * read of it (`o.files`), or a binding that is itself such an alias. */
function untypedArrayOrigin(
  lowerer: Lowerer,
  expr: ts.Expression,
  depth: number,
): EmptyArrayOrigin | null {
  if (depth > MAX_DEPTH) return null;
  let value = expr;
  while (ts.isParenthesizedExpression(value) || ts.isNonNullExpression(value))
    value = value.expression;
  const { checker } = lowerer;
  if (ts.isPropertyAccessExpression(value)) {
    const symbol = panicSafe(() => checker.getSymbolAtLocation(value.name), undefined);
    const declaration = symbol?.valueDeclaration;
    return declaration !== undefined &&
      ts.isPropertyAssignment(declaration) &&
      emptyArrayInitializer(declaration) !== null
      ? declaration
      : null;
  }
  // A copy made of nothing but spreads of it (`[...o.files]`) is a new
  // array of the same elements.
  if (ts.isArrayLiteralExpression(value)) {
    const elements = value.elements.nodes;
    const first = elements[0];
    if (first === undefined || !elements.every((element) => ts.isSpreadElement(element)))
      return null;
    return ts.isSpreadElement(first)
      ? untypedArrayOrigin(lowerer, first.expression, depth + 1)
      : null;
  }
  if (!ts.isIdentifier(value)) return null;
  const symbol = panicSafe(() => checker.getSymbolAtLocation(value), undefined);
  const declaration = symbol?.valueDeclaration;
  if (declaration === undefined) return null;
  if (ts.isVariableDeclaration(declaration) || ts.isBindingElement(declaration))
    return bindingOrigin(lowerer, declaration, depth + 1);
  return null;
}

/** The array type of an expression the checker types `never[]` because it
 * reads an untyped empty array property (a member read, an alias, a copy
 * by spread): the type that property was given. Null for other expressions. */
export function untypedArrayExprType(lowerer: Lowerer, expr: ts.Expression): IrType | null {
  const origin = untypedArrayOrigin(lowerer, expr, 0);
  if (origin === null) return null;
  return emptyArrayPlaceType(lowerer, origin) ?? arrayOf(unitOnlyUnion(lowerer.unions));
}

/** The origin (untypedArrayOrigin) an unannotated binding is initialized
 * from: `const mid = o.files`, `const { files } = o`. */
function bindingOrigin(
  lowerer: Lowerer,
  declaration: ts.VariableDeclaration | ts.BindingElement,
  depth: number,
): EmptyArrayOrigin | null {
  if (ts.isVariableDeclaration(declaration)) {
    if (emptyArrayInitializer(declaration) !== null) return declaration;
    if (declaration.type !== undefined || declaration.initializer === undefined) return null;
    return untypedArrayOrigin(lowerer, declaration.initializer, depth);
  }
  const pattern = declaration.parent;
  if (declaration.initializer !== undefined || declaration.dotDotDotToken !== undefined)
    return null;
  if (!ts.isObjectBindingPattern(pattern)) return null;
  const key = declaration.propertyName ?? declaration.name;
  if (!ts.isIdentifier(key)) return null;
  const { checker } = lowerer;
  const source = panicSafe(() => checker.getTypeAtLocation(pattern), undefined);
  const member =
    source === undefined
      ? undefined
      : panicSafe(() => checker.getPropertyOfType(source, key.text), undefined);
  const origin = member?.valueDeclaration;
  return origin !== undefined &&
    ts.isPropertyAssignment(origin) &&
    emptyArrayInitializer(origin) !== null
    ? origin
    : null;
}

/** The array type of an unannotated binding the checker types `never[]`
 * (or the empty tuple) because it is initialized from an untyped empty
 * array property: the binding is that array, so it has the type the
 * property was given. Null for every other binding. */
export function untypedArrayBindingType(
  lowerer: Lowerer,
  name: ts.Node,
  type: ts.Type,
): IrType | null {
  if (!ts.isIdentifier(name)) return null;
  const declaration = name.parent;
  if (
    !(ts.isVariableDeclaration(declaration) || ts.isBindingElement(declaration)) ||
    declaration.name !== name ||
    isJsSourceFile(ts.getSourceFileOfNode(name))
  )
    return null;
  // `const list = () => o.files`: the binding is a function with the
  // result its value returns (untypedArrayResultType).
  if (ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined) {
    let value: ts.Expression = declaration.initializer;
    while (ts.isParenthesizedExpression(value)) value = value.expression;
    if (
      (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) &&
      untypedResultBinding(value) === declaration
    ) {
      const fn = value;
      const signature = panicSafe(() => lowerer.checker.getSignatureFromDeclaration(fn), undefined);
      const result =
        signature === undefined
          ? null
          : untypedArrayResultType(
              lowerer,
              fn,
              lowerer.checker.getReturnTypeOfSignature(signature),
            );
      if (result === null) return null;
      const mapped = panicSafe(() => lowerer.mapTypeOf(type), null);
      return mapped?.kind === "func" ? { ...mapped, ret: result } : null;
    }
  }
  if (!isUntypedArrayType(lowerer.checker, type)) return null;
  const origin = bindingOrigin(lowerer, declaration, 0);
  if (origin === null) return null;
  return emptyArrayPlaceType(lowerer, origin) ?? arrayOf(unitOnlyUnion(lowerer.unions));
}

/** The unannotated binding whose value the function `decl` is
 * (`const list = () => o.files`), or null. */
function untypedResultBinding(decl: ts.Node): ts.VariableDeclaration | null {
  if (!ts.isArrowFunction(decl) && !ts.isFunctionExpression(decl)) return null;
  let value: ts.Node = decl;
  while (value.parent !== undefined && ts.isParenthesizedExpression(value.parent))
    value = value.parent;
  const holder = value.parent;
  return holder !== undefined &&
    ts.isVariableDeclaration(holder) &&
    holder.initializer === value &&
    holder.type === undefined &&
    ts.isIdentifier(holder.name)
    ? holder
    : null;
}

/** The result type of an unannotated function the checker types
 * `never[]` because every `return` reads the same untyped empty array
 * (`function list() { return o.files; }`): the function returns that
 * array, so its result has the array's type. Null for other functions. */
export function untypedArrayResultType(
  lowerer: Lowerer,
  decl: ts.SignatureDeclaration,
  result: ts.Type,
): IrType | null {
  if (
    decl.type !== undefined ||
    isJsSourceFile(ts.getSourceFileOfNode(decl)) ||
    !isUntypedArrayType(lowerer.checker, result)
  )
    return null;
  // A declared function, or a function that is an unannotated binding's
  // value: the places whose own type follows this answer
  // (untypedArrayBindingType). A callback, a method or a stored function
  // keeps the type its slot declares.
  if (!ts.isFunctionDeclaration(decl) && untypedResultBinding(decl) === null) return null;
  const body = (decl as { body?: ts.Node }).body;
  if (body === undefined) return null;
  const returned: ts.Expression[] = [];
  if (!ts.isBlock(body)) returned.push(body as ts.Expression);
  else
    ts.walkPreorder(body, (node) => {
      if (node !== body && ts.isFunctionLike(node)) return "skip";
      if (ts.isReturnStatement(node) && node.expression !== undefined)
        returned.push(node.expression);
      return undefined;
    });
  let type: IrType | null = null;
  for (const expr of returned) {
    const one = untypedArrayExprType(lowerer, expr);
    if (one === null || (type !== null && !typeEquals(type, one))) return null;
    type = one;
  }
  return type;
}
