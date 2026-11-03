import * as ts from "../frontend/ts7/adapter.js";

class Scope {
  readonly bindings = new Map<string, ts.Node>();
  readonly lexical = new Set<string>();
  readonly varScope: Scope;

  constructor(
    readonly parent: Scope | undefined,
    readonly strict: boolean,
    variable = false,
  ) {
    this.varScope = variable || parent === undefined ? this : parent.varScope;
  }
}

function isFunction(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

function useStrict(statements: readonly ts.Node[]): boolean {
  for (const statement of statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) break;
    if (statement.expression.text === "use strict") return true;
  }
  return false;
}

function moduleStrict(sf: ts.SourceFile): boolean {
  if (/\.m[jt]s$/.test(sf.fileName) || useStrict(sf.statements.nodes)) return true;
  return sf.statements.nodes.some(
    (statement) =>
      ts.isImportDeclaration(statement) ||
      ts.isExportDeclaration(statement) ||
      ts.isExportAssignment(statement) ||
      (ts.getCombinedModifierFlags(statement) & ts.ModifierFlags.Export) !== 0,
  );
}

function hasParameterExpressions(parameter: ts.ParameterDeclaration): boolean {
  if (parameter.initializer !== undefined) return true;
  let found = false;
  ts.walkPreorder(parameter.name, (node) => {
    if (
      ts.isComputedPropertyName(node) ||
      (ts.isBindingElement(node) && node.initializer !== undefined)
    ) {
      found = true;
      return "stop";
    }
    return undefined;
  });
  return found;
}

/** Syntactic value bindings for the island pre-scan. Alias facts belong to
 * one declaration, not to every same-spelling identifier in a module. */
export class ModuleBindings {
  private readonly scopes = new Map<ts.Node, Scope>();
  private readonly declarations = new Map<ts.Identifier, ts.Node>();
  private readonly resolved = new Map<ts.Identifier, ts.Node | undefined>();

  constructor(source: ts.SourceFile) {
    const root = new Scope(undefined, moduleStrict(source), true);
    const pending: Array<{ node: ts.Node; scope: Scope }> = [{ node: source, scope: root }];
    const annex: Array<{ name: ts.Identifier; scope: Scope }> = [];
    while (pending.length > 0) {
      const item = pending.pop()!;
      const node = item.node;
      let current = item.scope;
      if (
        ts.isTypeNode(node) ||
        ts.isInterfaceDeclaration(node) ||
        ts.isTypeAliasDeclaration(node) ||
        (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Ambient) !== 0 ||
        (ts.isFunctionDeclaration(node) && node.body === undefined)
      )
        continue;

      if (isFunction(node)) {
        if (ts.isFunctionDeclaration(node) && node.name !== undefined) {
          const parent = node.parent;
          const body = parent?.parent;
          const directBody =
            parent !== undefined &&
            ts.isBlock(parent) &&
            body !== undefined &&
            ((isFunction(body) && body.body === parent) || ts.isClassStaticBlockDeclaration(body));
          const variable = ts.isSourceFile(parent) || directBody;
          if (
            !variable &&
            !ts.isBlock(parent) &&
            !ts.isCaseClause(parent) &&
            !ts.isDefaultClause(parent)
          )
            current = new Scope(current, current.strict);
          this.bind(node.name, variable ? current.varScope : current, !variable);
          if (
            !variable &&
            !current.strict &&
            node.asteriskToken === undefined &&
            (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Async) === 0
          )
            annex.push({ name: node.name, scope: current });
        }
        let parent = current;
        if (ts.isFunctionExpression(node) && node.name !== undefined) {
          parent = new Scope(current, current.strict);
          this.bind(node.name, parent, true);
        }
        const strict =
          current.strict ||
          (node.body !== undefined &&
            ts.isBlock(node.body) &&
            useStrict(node.body.statements.nodes));
        const parameters = new Scope(parent, strict);
        for (const parameter of node.parameters.nodes) this.bindPattern(parameter.name, parameters);
        const body = new Scope(parameters, strict, true);
        // Only parameter expressions need a separate variable environment.
        // Rest/destructuring without expressions still share body vars.
        if (!node.parameters.nodes.some(hasParameterExpressions))
          for (const [name, declaration] of parameters.bindings)
            body.bindings.set(name, declaration);
        this.scopes.set(node, current);
        const children: ts.Node[] = [];
        ts.forEachChild(node, (child) => {
          children.push(child);
          return undefined;
        });
        for (let i = children.length - 1; i >= 0; i--) {
          const child = children[i]!;
          pending.push({
            node: child,
            scope:
              child === node.body
                ? body
                : ts.isParameter(child)
                  ? parameters
                  : child === node.name && ts.isFunctionExpression(node)
                    ? parent
                    : current,
          });
        }
        continue;
      }

      if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
        if (ts.isClassDeclaration(node) && node.name !== undefined)
          this.bind(node.name, current, true);
        current = new Scope(current, true);
        if (node.name !== undefined) {
          // Class declarations have an immutable inner name as well as
          // their outer binding; a class expression has only its inner name.
          if (ts.isClassExpression(node)) this.bind(node.name, current, true);
          else current.bindings.set(node.name.text, node);
        }
      } else if (ts.isClassStaticBlockDeclaration(node) || ts.isModuleBlock(node)) {
        current = new Scope(current, current.strict, true);
      } else if (
        ts.isBlock(node) ||
        ts.isCaseBlock(node) ||
        ts.isCatchClause(node) ||
        ((ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node)) &&
          node.initializer !== undefined &&
          ts.isVariableDeclarationList(node.initializer) &&
          (node.initializer.flags & ts.NodeFlags.BlockScoped) !== 0)
      ) {
        current = new Scope(current, current.strict);
      }
      this.scopes.set(node, current);

      if (ts.isVariableDeclaration(node)) {
        const parent = node.parent;
        const caught = parent !== undefined && ts.isCatchClause(parent);
        const lexical =
          caught ||
          (parent !== undefined &&
            ts.isVariableDeclarationList(parent) &&
            (parent.flags & ts.NodeFlags.BlockScoped) !== 0);
        this.bindPattern(
          node.name,
          lexical ? current : current.varScope,
          lexical,
          !lexical && node.initializer !== undefined ? current : undefined,
        );
      } else if (ts.isImportDeclaration(node)) {
        const clause = node.importClause;
        if (clause !== undefined && !clause.isTypeOnly) {
          if (clause.name !== undefined) this.bind(clause.name, current, true);
          const bindings = clause.namedBindings;
          if (bindings !== undefined && ts.isNamespaceImport(bindings))
            this.bind(bindings.name, current, true);
          else if (bindings !== undefined && ts.isNamedImports(bindings))
            for (const element of bindings.elements.nodes)
              if (!element.isTypeOnly) this.bind(element.name, current, true);
        }
      } else if (ts.isImportEqualsDeclaration(node)) {
        if (!node.isTypeOnly) this.bind(node.name, current, true);
      } else if (ts.isEnumDeclaration(node) || ts.isModuleDeclaration(node)) {
        if (ts.isIdentifier(node.name)) this.bind(node.name, current, true);
      }

      const children: ts.Node[] = [];
      ts.forEachChild(node, (child) => {
        children.push(child);
        return undefined;
      });
      for (let i = children.length - 1; i >= 0; i--)
        pending.push({ node: children[i]!, scope: current });
    }

    // Annex B's extra var binding belongs only to the containing function
    // or script. An intervening lexical declaration prevents that binding.
    for (const candidate of annex) {
      let blocked = false;
      for (let current = candidate.scope.parent; current !== undefined; current = current.parent) {
        if (current.lexical.has(candidate.name.text)) {
          blocked = true;
          break;
        }
        if (current === candidate.scope.varScope) break;
      }
      if (!blocked && !candidate.scope.varScope.bindings.has(candidate.name.text))
        candidate.scope.varScope.bindings.set(candidate.name.text, candidate.name.parent!);
    }
  }

  private bind(name: ts.Identifier, current: Scope, lexical: boolean): void {
    let declaration = current.bindings.get(name.text);
    if (declaration === undefined) {
      declaration = name;
      current.bindings.set(name.text, declaration);
    }
    if (lexical) current.lexical.add(name.text);
    this.declarations.set(name, declaration);
  }

  private bindPattern(
    name: ts.BindingName,
    current: Scope,
    lexical = false,
    assignmentScope?: Scope,
  ): void {
    const pending = [name];
    while (pending.length > 0) {
      const item = pending.pop()!;
      if (ts.isIdentifier(item)) {
        this.bind(item, current, lexical);
        // `catch (name) { var name = value }` declares an outer var but
        // initializes the catch parameter. Preserve both binding identities.
        for (
          let scope = assignmentScope;
          scope !== undefined && scope !== current;
          scope = scope.parent
        ) {
          const binding = scope.bindings.get(item.text);
          if (binding === undefined) continue;
          const declaration = binding.parent;
          if (
            declaration !== undefined &&
            ts.isVariableDeclaration(declaration) &&
            ts.isIdentifier(declaration.name) &&
            ts.isCatchClause(declaration.parent)
          )
            this.declarations.set(item, binding);
          break;
        }
      } else
        for (const element of item.elements.nodes)
          if (ts.isBindingElement(element) && element.name !== undefined)
            pending.push(element.name);
    }
  }

  /** The declaration a value reference names, or undefined for an ambient
   * name. Repeated var declarations return the same canonical node. */
  resolve(identifier: ts.Identifier): ts.Node | undefined {
    const declared = this.declarations.get(identifier);
    if (declared !== undefined) return declared;
    if (this.resolved.has(identifier)) return this.resolved.get(identifier);
    const parent = identifier.parent;
    if (
      parent !== undefined &&
      ((ts.isPropertyAccessExpression(parent) && parent.name === identifier) ||
        ((ts.isPropertyAssignment(parent) ||
          ts.isMethodDeclaration(parent) ||
          ts.isPropertyDeclaration(parent) ||
          ts.isGetAccessorDeclaration(parent) ||
          ts.isSetAccessorDeclaration(parent)) &&
          parent.name === identifier) ||
        (ts.isBindingElement(parent) && parent.propertyName === identifier) ||
        ts.isImportSpecifier(parent) ||
        ts.isImportClause(parent) ||
        ts.isNamespaceImport(parent))
    )
      return undefined;
    for (
      let current = this.scopes.get(identifier);
      current !== undefined;
      current = current.parent
    ) {
      const binding = current.bindings.get(identifier.text);
      if (binding !== undefined) {
        this.resolved.set(identifier, binding);
        return binding;
      }
    }
    this.resolved.set(identifier, undefined);
    return undefined;
  }
}
