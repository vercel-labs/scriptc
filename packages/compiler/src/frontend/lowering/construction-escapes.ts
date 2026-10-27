import * as ts from "../ts7/adapter.js";

/** Whether `node` mentions the constructor's receiver: a `this` or `super`
 * keyword outside nested declarations that bind their own receiver. Arrow
 * functions inherit the receiver, so they stay transparent. */
export function mentionsReceiver(node: ts.Node): boolean {
  let found = false;
  const visit = (child: ts.Node): void => {
    if (found) return;
    if (
      ts.isFunctionExpression(child) ||
      ts.isFunctionDeclaration(child) ||
      ts.isMethodDeclaration(child) ||
      ts.isConstructorDeclaration(child) ||
      ts.isGetAccessor(child) ||
      ts.isSetAccessor(child) ||
      ts.isClassDeclaration(child) ||
      ts.isClassExpression(child)
    ) {
      return;
    }
    if (child.kind === ts.SyntaxKind.ThisKeyword || child.kind === ts.SyntaxKind.SuperKeyword) {
      found = true;
      return;
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

/** The construction order inputs of one class: its own instance field
 * initializers in declaration order, its parameter property names, the
 * constructor body, and the inherited part of construction. */
export interface ConstructionInputs {
  ctor: ts.ConstructorDeclaration | null;
  /** Own declared fields in declaration order, with their initializers. */
  fields: readonly { name: string; initializer: ts.Expression | undefined }[];
  paramProps: readonly string[];
  derived: boolean;
  /** True when the base class's construction may expose the instance. */
  baseEscapes: boolean;
  /** True for names that are plain instance fields (not accessors). */
  isField: (name: string) => boolean;
  /** The body of the class's own method a `this.m(...)` call runs, when no
   * subclass can override it (TypeScript `private` and `#private`
   * methods); null otherwise. */
  privateMethodBody: (call: ts.CallExpression) => ts.Block | null;
}

export interface ConstructionEscape {
  /** True when construction may expose the instance to other code (a
   * method call, a callback, an argument, a base constructor that does). */
  escapes: boolean;
  /** Own fields assigned before the first exposure; every own field when
   * construction never exposes the instance. */
  assigned: Set<string>;
}

/** Private helper bodies are followed this deep. */
const HELPER_DEPTH = 3;

function containsReturn(node: ts.Node): boolean {
  let found = false;
  const visit = (child: ts.Node): void => {
    if (found || ts.isFunctionLike(child) || ts.isClassLikeDeclaration(child)) return;
    if (ts.isReturnStatement(child)) {
      found = true;
      return;
    }
    ts.forEachChild(child, visit);
  };
  ts.forEachChild(node, visit);
  return found;
}

/** Which own fields construction definitely assigns before the instance can
 * be observed by any other code. A field outside `assigned` may be read
 * while its slot still holds the pre-assignment undefined. */
export function constructionEscape(inputs: ConstructionInputs): ConstructionEscape {
  const assigned = new Set<string>();
  const stop = (): ConstructionEscape => ({ escapes: true, assigned });
  const thisMember = (node: ts.Node): node is ts.PropertyAccessExpression =>
    ts.isPropertyAccessExpression(node) && node.expression.kind === ts.SyntaxKind.ThisKeyword;
  // A plain read of an already-assigned field does not expose the instance,
  // nor does a private helper that itself only assigns fields and reads
  // assigned ones; anything else mentioning the receiver might.
  const exposes = (node: ts.Node, depth: number): boolean => {
    if (node.kind === ts.SyntaxKind.ThisKeyword || node.kind === ts.SyntaxKind.SuperKeyword)
      return true;
    if (ts.isCallExpression(node) && thisMember(node.expression)) {
      if (node.arguments.nodes.some((arg) => mentionsReceiver(arg) && exposes(arg, depth)))
        return true;
      const body = depth < HELPER_DEPTH ? inputs.privateMethodBody(node) : null;
      if (!body) return true;
      return !followStatements(body.statements.nodes, depth + 1);
    }
    if (thisMember(node)) {
      const name = node.name.text;
      return !(ts.isIdentifier(node.name) && assigned.has(name) && inputs.isField(name));
    }
    let found = false;
    ts.forEachChild(node, (child) => {
      if (!found && mentionsReceiver(child)) found = exposes(child, depth);
    });
    return found;
  };
  /** Walk straight-line statements; false at the first exposure. */
  const followStatements = (statements: readonly ts.Statement[], depth: number): boolean => {
    for (const stmt of statements) {
      // An early return leaves later assignments unproven on its path.
      if (ts.isReturnStatement(stmt) || containsReturn(stmt)) return false;
      if (!mentionsReceiver(stmt)) continue;
      if (
        ts.isExpressionStatement(stmt) &&
        ts.isBinaryExpression(stmt.expression) &&
        stmt.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        thisMember(stmt.expression.left) &&
        ts.isIdentifier(stmt.expression.left.name) &&
        inputs.isField(stmt.expression.left.name.text)
      ) {
        const right = stmt.expression.right;
        if (mentionsReceiver(right) && exposes(right, depth)) return false;
        assigned.add(stmt.expression.left.name.text);
        continue;
      }
      if (ts.isExpressionStatement(stmt) && !exposes(stmt.expression, depth)) continue;
      return false;
    }
    return true;
  };
  const ownInitializers = (): boolean => {
    for (const name of inputs.paramProps) assigned.add(name);
    for (const field of inputs.fields) {
      if (!field.initializer) continue;
      if (mentionsReceiver(field.initializer) && exposes(field.initializer, 0)) return false;
      assigned.add(field.name);
    }
    return true;
  };
  const statements = inputs.ctor?.body?.statements?.nodes ?? [];
  let index = 0;
  if (inputs.derived) {
    // Own initializers run when super() returns. A base construction that
    // exposes the instance exposes it before any own field is assigned.
    for (; index < statements.length; index++) {
      const stmt = statements[index]!;
      const isSuper =
        ts.isExpressionStatement(stmt) &&
        ts.isCallExpression(stmt.expression) &&
        stmt.expression.expression.kind === ts.SyntaxKind.SuperKeyword;
      if (isSuper) {
        if (stmt.expression.arguments.nodes.some((arg) => mentionsReceiver(arg))) return stop();
        break;
      }
      // super() nested inside other statements: keep the analysis simple.
      if (mentionsReceiver(stmt)) return stop();
    }
    if (inputs.ctor?.body && index >= statements.length) return stop();
    if (inputs.baseEscapes) return stop();
    index++;
  }
  if (!ownInitializers()) return stop();
  if (!followStatements(statements.slice(index), 0)) return stop();
  return { escapes: false, assigned };
}
