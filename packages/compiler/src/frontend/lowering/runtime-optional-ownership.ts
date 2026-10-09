import * as ts from "../ts7/adapter.js";

/** Program queries for the array-ownership proof. */
export interface OwnershipHost {
  symbolOf(node: ts.Node): ts.Symbol | null;
  declarationOf(symbol: ts.Symbol): ts.Node | undefined;
  /** The node's checker type; null when the checker cannot answer. */
  typeOf(node: ts.Node): ts.Type | null;
  /** An instance of `owner` can be assigned to a value of type `target`. */
  instanceAssignableTo(owner: ts.ClassLikeDeclaration, target: ts.Type): boolean;
  isGlobal(node: ts.Expression, name: string): boolean;
  isArray(node: ts.Expression): boolean;
  /** Element keys of the native arrays a field's declared type holds. */
  fieldKeys(declaration: ts.PropertyDeclaration): readonly string[];
  /** Element keys of native arrays that some `any` or `unknown` value is
   * converted to. Such a conversion can view an array reached through
   * reflection (`(x as any).field`, `Object.values(x)`). */
  dynamicViewKeys(): ReadonlySet<string>;
}

interface Root {
  symbol: ts.Symbol;
  name: string;
  /** The private field declaration; null for a local binding. */
  field: ts.PropertyDeclaration | null;
}

/** Array methods returning their receiver: a used result aliases it. */
const RETURNS_RECEIVER = new Set(["sort", "reverse", "fill", "copyWithin"]);

/** Array methods whose callback receives the array itself, by the
 * position of that parameter. */
const ARRAY_ARGUMENT_AT = new Map([
  ["map", 2],
  ["filter", 2],
  ["forEach", 2],
  ["some", 2],
  ["every", 2],
  ["find", 2],
  ["findIndex", 2],
  ["findLast", 2],
  ["findLastIndex", 2],
  ["flatMap", 2],
  ["reduce", 3],
  ["reduceRight", 3],
]);

/** Iterator factories: their iterator reads the array later, so they are
 * only an owned use directly as a for-of source. */
const ITERATORS = new Set(["values", "entries", "keys"]);

/** Array methods that return a newly allocated array. */
const FRESH_METHODS = new Set([
  "map",
  "filter",
  "slice",
  "concat",
  "flat",
  "flatMap",
  "toSorted",
  "toReversed",
  "toSpliced",
  "with",
]);

/** Proves that an array is owned by one storage slot: a local variable or
 * a private instance field that only ever holds arrays allocated for it,
 * whose every use reads elements or the length, mutates the array in
 * place, or copies its elements into a new value (a spread, an iteration,
 * a copying method), and never lets the array itself flow anywhere else.
 * Facts about the slot's holes and undefined values then belong to the
 * slot alone rather than to every array with the same element type.
 *
 * A private field can also be reached without naming its symbol: an object
 * spread or destructuring of its instance, a literal-key access, or
 * reflection that yields an `any` value. The first two must not apply to a
 * value that can hold an instance, and no `any` or `unknown` value may be
 * converted to the field's array type, which is the only way a reflected
 * array becomes a native array again. */
export class ArrayOwnership {
  private references: Map<string, ts.Node[]> | null = null;
  /** Object spreads, which copy every own field out. */
  private readonly copiedObjects: ts.Expression[] = [];
  /** Object destructuring patterns by the property names they read; ""
   * collects patterns with a computed key or rest, which read any field. */
  private readonly destructurings = new Map<string, ts.ObjectBindingPattern[]>();
  /** Receivers of `x["name"]` and `x.name`, by name. */
  private readonly literalKeyAccesses = new Map<string, ts.Expression[]>();
  private readonly namedAccesses = new Map<string, ts.Expression[]>();
  /** Values whose fields are read by a computed key, an object walker, or
   * a for-in loop. */
  private readonly reflected: ts.Expression[] = [];
  private readonly ownedRoots = new Map<ts.Symbol, boolean>();

  constructor(
    private readonly files: readonly ts.SourceFile[],
    private readonly host: OwnershipHost,
  ) {}

  /** The owning slot `node` reads, when it directly references one. */
  ownerOf(node: ts.Expression): ts.Symbol | null {
    const root = this.rootOf(node);
    return root !== null && this.owned(root) ? root.symbol : null;
  }

  /** The owning slot a freshly built array initializes or is assigned to. */
  allocationOwner(allocation: ts.Expression): ts.Symbol | null {
    let child: ts.Node = allocation;
    let parent = allocation.parent;
    while (
      parent &&
      (ts.isParenthesizedExpression(parent) ||
        ts.isAsExpression(parent) ||
        ts.isTypeAssertion(parent) ||
        ts.isSatisfiesExpression(parent))
    ) {
      child = parent;
      parent = parent.parent;
    }
    let root: Root | null = null;
    if (parent && ts.isVariableDeclaration(parent) && parent.initializer === child) {
      if (ts.isIdentifier(parent.name)) root = this.rootOf(parent.name);
    } else if (
      parent &&
      ts.isBinaryExpression(parent) &&
      parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      parent.right === child
    ) {
      root = this.rootOf(parent.left);
    } else if (parent && ts.isPropertyDeclaration(parent) && parent.initializer === child) {
      root = this.fieldRoot(parent);
    }
    return root !== null && this.owned(root) ? root.symbol : null;
  }

  private rootOf(node: ts.Expression): Root | null {
    const e = peel(node);
    if (ts.isIdentifier(e)) {
      const symbol = this.host.symbolOf(e);
      const declaration = symbol ? this.host.declarationOf(symbol) : undefined;
      if (
        !symbol ||
        !declaration ||
        !ts.isVariableDeclaration(declaration) ||
        !ts.isIdentifier(declaration.name) ||
        !ts.isVariableDeclarationList(declaration.parent) ||
        !ts.isVariableStatement(declaration.parent.parent)
      )
        return null;
      return { symbol, name: e.text, field: null };
    }
    if (ts.isPropertyAccessExpression(e)) {
      const symbol = this.host.symbolOf(e.name);
      const declaration = symbol ? this.host.declarationOf(symbol) : undefined;
      return declaration && ts.isPropertyDeclaration(declaration)
        ? this.fieldRoot(declaration)
        : null;
    }
    return null;
  }

  private fieldRoot(declaration: ts.PropertyDeclaration): Root | null {
    const owner = declaration.parent;
    if (!ts.isClassDeclaration(owner) && !ts.isClassExpression(owner)) return null;
    const name = declaration.name;
    const flags = ts.getCombinedModifierFlags(declaration);
    const isPrivate =
      ts.isPrivateIdentifier(name) ||
      (flags & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)) !== 0;
    if (!isPrivate || (flags & ts.ModifierFlags.Static) !== 0) return null;
    if (!ts.isIdentifier(name) && !ts.isPrivateIdentifier(name)) return null;
    const symbol = this.host.symbolOf(name);
    return symbol ? { symbol, name: name.text, field: declaration } : null;
  }

  private owned(root: Root): boolean {
    const cached = this.ownedRoots.get(root.symbol);
    if (cached !== undefined) return cached;
    const result = this.computeOwned(root);
    this.ownedRoots.set(root.symbol, result);
    return result;
  }

  private computeOwned(root: Root): boolean {
    const references = this.index().get(root.name) ?? [];
    for (const reference of references) {
      if (this.host.symbolOf(reference) !== root.symbol) continue;
      if (!this.ownedUse(reference, root)) return false;
    }
    return root.field === null || this.unexposed(root, root.field);
  }

  private ownedUse(reference: ts.Node, root: Root): boolean {
    const parent = reference.parent;
    if (
      parent &&
      (ts.isVariableDeclaration(parent) || ts.isPropertyDeclaration(parent)) &&
      parent.name === reference
    )
      return parent.initializer === undefined || this.isFreshArray(parent.initializer);
    let use: ts.Node = reference;
    if (root.field !== null) {
      if (!parent || !ts.isPropertyAccessExpression(parent) || parent.name !== reference)
        return false;
      use = parent;
    } else if (!ts.isIdentifier(reference)) return false;
    while (
      use.parent &&
      (ts.isParenthesizedExpression(use.parent) || ts.isNonNullExpression(use.parent))
    )
      use = use.parent;
    const user = use.parent;
    if (!user) return false;
    if (ts.isElementAccessExpression(user) && user.expression === use) return true;
    if (ts.isSpreadElement(user)) return true;
    if (ts.isForOfStatement(user) && user.expression === use) return true;
    if (ts.isPropertyAccessExpression(user) && user.expression === use) {
      const method = user.name.text;
      if (method === "length") return true;
      const call = user.parent;
      if (!call || !ts.isCallExpression(call) || call.expression !== user) return false;
      if (ITERATORS.has(method))
        return !!call.parent && ts.isForOfStatement(call.parent) && call.parent.expression === call;
      if (RETURNS_RECEIVER.has(method))
        return !!call.parent && ts.isExpressionStatement(call.parent);
      const arrayAt = ARRAY_ARGUMENT_AT.get(method);
      if (arrayAt !== undefined) {
        // An inline callback that cannot see its array argument.
        const callback = call.arguments[0];
        return (
          callback !== undefined &&
          (ts.isArrowFunction(callback) ||
            (ts.isFunctionExpression(callback) && !usesArguments(callback))) &&
          callback.parameters.length <= arrayAt &&
          !callback.parameters.some((parameter) => parameter.dotDotDotToken)
        );
      }
      return this.host.isArray(user.expression);
    }
    if (
      ts.isBinaryExpression(user) &&
      user.left === use &&
      user.operatorToken.kind === ts.SyntaxKind.EqualsToken
    )
      return this.isFreshArray(user.right);
    if (ts.isCallExpression(user) && user.arguments[0] === use) {
      const callee = peel(user.expression);
      return (
        ts.isPropertyAccessExpression(callee) &&
        ((callee.name.text === "hasOwn" && this.host.isGlobal(callee.expression, "Object")) ||
          (callee.name.text === "isArray" && this.host.isGlobal(callee.expression, "Array")) ||
          (callee.name.text === "from" &&
            user.arguments.length === 1 &&
            this.host.isGlobal(callee.expression, "Array")))
      );
    }
    return false;
  }

  /** Nothing reaches the field's array without naming the field. */
  private unexposed(root: Root, field: ts.PropertyDeclaration): boolean {
    const owner = field.parent as ts.ClassLikeDeclaration;
    const mayHoldInstance = (node: ts.Node): boolean => {
      const type = this.host.typeOf(node);
      if (type === null) return true;
      if (
        (type.flags &
          (ts.TypeFlags.Any |
            ts.TypeFlags.Unknown |
            ts.TypeFlags.NonPrimitive |
            ts.TypeFlags.TypeParameter)) !==
        0
      )
        return true;
      return this.host.instanceAssignableTo(owner, type);
    };
    this.index();
    for (const pattern of [
      ...(this.destructurings.get(root.name) ?? []),
      ...(this.destructurings.get("") ?? []),
    ]) {
      // Only a declaration's initializer names the destructured value.
      const owner = pattern.parent;
      if (!ts.isVariableDeclaration(owner) || !owner.initializer) return false;
      if (mayHoldInstance(owner.initializer)) return false;
    }
    if (this.copiedObjects.some(mayHoldInstance)) return false;
    if ((this.literalKeyAccesses.get(root.name) ?? []).some(mayHoldInstance)) return false;
    // A dynamic read can only reach the field through a value whose type
    // admits the instance; its `any` result must then become a native
    // array again.
    const dynamic = (node: ts.Expression): boolean => {
      const type = this.host.typeOf(node);
      return type === null || (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.TypeParameter)) !== 0;
    };
    const reflectedReads =
      this.reflected.some(mayHoldInstance) ||
      (this.namedAccesses.get(root.name) ?? []).some(dynamic);
    if (!reflectedReads) return true;
    const views = this.host.dynamicViewKeys();
    if (views.has("*")) return false;
    return this.host.fieldKeys(field).every((key) => !views.has(key));
  }

  private isFreshArray(node: ts.Expression): boolean {
    const e = peel(node);
    if (ts.isArrayLiteralExpression(e)) return true;
    if (!ts.isNewExpression(e) && !ts.isCallExpression(e)) return false;
    const callee = peel(e.expression);
    if (ts.isIdentifier(callee)) return this.host.isGlobal(callee, "Array");
    if (!ts.isPropertyAccessExpression(callee)) return false;
    const method = callee.name.text;
    if ((method === "from" || method === "of") && this.host.isGlobal(callee.expression, "Array"))
      return true;
    if (method === "fill") return this.isFreshArray(callee.expression);
    return FRESH_METHODS.has(method) && this.host.isArray(callee.expression);
  }

  private index(): Map<string, ts.Node[]> {
    if (this.references) return this.references;
    const references = new Map<string, ts.Node[]>();
    const add = (name: string, node: ts.Node): void => {
      const list = references.get(name);
      if (list) list.push(node);
      else references.set(name, [node]);
    };
    for (const file of this.files) {
      ts.walkPreorder(file, (node) => {
        if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) add(node.text, node);
        else if (ts.isPropertyAccessExpression(node)) {
          const list = this.namedAccesses.get(node.name.text);
          if (list) list.push(node.expression);
          else this.namedAccesses.set(node.name.text, [node.expression]);
        } else if (ts.isElementAccessExpression(node)) {
          const key = peel(node.argumentExpression);
          if (ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key)) {
            const list = this.literalKeyAccesses.get(key.text);
            if (list) list.push(node.expression);
            else this.literalKeyAccesses.set(key.text, [node.expression]);
          } else if (!ts.isNumericLiteral(key)) this.reflected.push(node.expression);
        } else if (ts.isSpreadAssignment(node)) this.copiedObjects.push(node.expression);
        else if (ts.isForInStatement(node)) this.reflected.push(node.expression);
        else if (ts.isCallExpression(node)) {
          const callee = peel(node.expression);
          const walker =
            ts.isPropertyAccessExpression(callee) &&
            (this.host.isGlobal(callee.expression, "Object") ||
              this.host.isGlobal(callee.expression, "Reflect"));
          const clone = ts.isIdentifier(callee) && this.host.isGlobal(callee, "structuredClone");
          if (walker || clone)
            for (const arg of node.arguments)
              this.reflected.push(ts.isSpreadElement(arg) ? arg.expression : arg);
        } else if (ts.isObjectBindingPattern(node)) {
          for (const element of node.elements) {
            const name = element.propertyName ?? element.name;
            // A rest element copies every remaining field.
            const key =
              !element.dotDotDotToken &&
              (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteral(name))
                ? name.text
                : "";
            const list = this.destructurings.get(key);
            if (list) list.push(node);
            else this.destructurings.set(key, [node]);
          }
        }
        return undefined;
      });
    }
    this.references = references;
    return references;
  }
}

function usesArguments(fn: ts.FunctionExpression): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isIdentifier(node) && node.text === "arguments") found = true;
    else if (!ts.isFunctionDeclaration(node) && !ts.isFunctionExpression(node))
      node.forEachChild(visit);
  };
  fn.body?.forEachChild(visit);
  return found;
}

function peel(node: ts.Expression): ts.Expression {
  let e = node;
  while (
    ts.isParenthesizedExpression(e) ||
    ts.isAsExpression(e) ||
    ts.isTypeAssertion(e) ||
    ts.isSatisfiesExpression(e) ||
    ts.isNonNullExpression(e)
  )
    e = e.expression;
  return e;
}
