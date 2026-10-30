import * as ts from "../ts7/adapter.js";
import { isGenericCallableMemberType } from "../type-mapper.js";

/** Index only program classes. Ambient declarations describe APIs, not
 * compiled implementations, and must not change a protocol's storage. */
export class ClassProtocols {
  private implemented: Set<ts.Symbol> | null = null;
  private readonly methods = new Map<string, ts.ClassLikeDeclaration[]>();
  private readonly answers = new Map<ts.Type, boolean>();
  private readonly mappedViews = new Set<ts.Type>();

  constructor(
    private readonly checker: ts.TypeChecker,
    private readonly sources: readonly ts.SourceFile[],
    private readonly isStdlibFile: (source: ts.SourceFile) => boolean,
    private readonly integrityIdentitySource: (
      call: ts.CallExpression,
    ) => ts.Expression | undefined,
  ) {}

  private index(): Set<ts.Symbol> {
    if (this.implemented !== null) return this.implemented;
    const protocols = new Set<ts.Symbol>();
    this.implemented = protocols;
    const add = (type: ts.Type): void => {
      const symbol = type.getSymbol();
      if (!symbol || protocols.has(symbol)) return;
      protocols.add(symbol);
      const target = type.isTypeReference() ? type.getTarget() : type;
      if (target?.isClassOrInterface()) this.checker.getBaseTypes(target).forEach(add);
    };
    const usesReceiver = (node: ts.Node): boolean =>
      node.kind === ts.SyntaxKind.ThisKeyword || ts.forEachChild(node, usesReceiver) === true;
    const visit = (node: ts.Node): void => {
      if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
        for (const clause of node.heritageClauses ?? [])
          if (clause.token === ts.SyntaxKind.ImplementsKeyword)
            for (const protocol of clause.types) add(this.checker.getTypeAtLocation(protocol));
        const symbol = node.name ? this.checker.getSymbolAtLocation(node.name) : undefined;
        const instance = symbol ? this.checker.getDeclaredTypeOfSymbol(symbol) : undefined;
        for (const property of instance ? this.checker.getPropertiesOfType(instance) : []) {
          if (
            !this.checker
              .declarationsOf(property)
              .some(
                (member) =>
                  ts.isMethodDeclaration(member) &&
                  !member.modifiers?.some(
                    (modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword,
                  ),
              )
          )
            continue;
          const entries = this.methods.get(property.name) ?? [];
          entries.push(node);
          this.methods.set(property.name, entries);
        }
      }
      if (
        ts.isObjectLiteralExpression(node) &&
        node.properties.some(
          (property) =>
            (ts.isMethodDeclaration(property) ||
              ts.isGetAccessorDeclaration(property) ||
              ts.isSetAccessorDeclaration(property)) &&
            property.body !== undefined &&
            usesReceiver(property.body),
        )
      ) {
        // Receiver-dependent methods and accessors need a live object even
        // without a class implementation. Receiver-free methods keep their
        // native callable fields, including async callbacks.
        add(this.checker.getTypeAtLocation(node));
        const contextual = this.checker.getContextualType(node);
        if (contextual) add(contextual);
      }
      ts.forEachChild(node, visit);
    };
    for (const source of this.sources) if (!source.isDeclarationFile) visit(source);
    this.markIdentityFlows(protocols);
    return protocols;
  }

  /** Structural types that receive a value with identity: a program class
   * instance, or a value of a type already marked here. Natively such a
   * type would be a record, and the conversion into it a field copy, so a
   * write or identity check through the record would miss the original
   * (`function bump(o: { n: number }) { o.n++ }` called with a class
   * instance). Marking keeps every value of the type a live, checked view.
   * Flows are scanned syntactically, and only sites whose source carries
   * identity query their target type. */
  private markIdentityFlows(protocols: Set<ts.Symbol>): void {
    const sites: { source: ts.Expression; target: () => ts.Type | undefined }[] = [];
    /** Annotated callback parameters: the caller's argument (the contextual
     * signature's parameter) flows into the declared parameter type. */
    const callbackParams: { fn: ts.SignatureDeclaration; index: number; name: ts.Node }[] = [];
    const contextual = (expr: ts.Expression) => () => this.checker.getContextualType(expr);
    const flow = (expr: ts.Expression | undefined): void => {
      if (expr !== undefined) sites.push({ source: expr, target: contextual(expr) });
    };
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        node.arguments?.forEach(flow);
        // Integrity mutators return their operand. The checker's readonly
        // result can hide its class provenance before any binding is typed.
        const source = ts.isCallExpression(node) ? this.integrityIdentitySource(node) : undefined;
        if (source) sites.push({ source, target: () => this.checker.getTypeAtLocation(node) });
      } else if (ts.isVariableDeclaration(node) && node.type !== undefined) flow(node.initializer);
      else if (ts.isPropertyDeclaration(node) && node.type !== undefined) flow(node.initializer);
      else if (ts.isParameter(node) && node.type !== undefined) flow(node.initializer);
      else if (ts.isReturnStatement(node)) flow(node.expression);
      else if (ts.isArrowFunction(node) && !ts.isBlock(node.body)) flow(node.body);
      else if (ts.isYieldExpression(node)) flow(node.expression);
      else if (ts.isArrayLiteralExpression(node))
        node.elements.forEach((element) => {
          if (!ts.isSpreadElement(element) && !ts.isOmittedExpression(element)) flow(element);
        });
      else if (ts.isPropertyAssignment(node)) flow(node.initializer);
      else if (ts.isShorthandPropertyAssignment(node) && ts.isIdentifier(node.name))
        flow(node.name);
      else if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        !ts.isObjectLiteralExpression(node.left) &&
        !ts.isArrayLiteralExpression(node.left)
      ) {
        const left = node.left;
        sites.push({ source: node.right, target: () => this.checker.getTypeAtLocation(left) });
      } else if ((ts.isAsExpression(node) || ts.isTypeAssertion(node)) && !accessedInPlace(node)) {
        const typeNode = node.type;
        sites.push({
          source: node.expression,
          target: () => this.checker.getTypeFromTypeNode(typeNode),
        });
      }
      if (ts.isArrowFunction(node) || ts.isFunctionExpression(node))
        node.parameters.forEach((param, index) => {
          if (param.type !== undefined) callbackParams.push({ fn: node, index, name: param.name });
        });
      ts.forEachChild(node, visit);
    };
    for (const source of this.sources) if (!source.isDeclarationFile) visit(source);
    if (sites.length === 0 && callbackParams.length === 0) return;

    // One batched checker round trip for every node the scan reads: flow
    // sites sit in bodies whose reachability is not known yet, so the
    // facade has not prefetched them.
    const sourceNodes = sites.map((site) => this.flowSourceNode(site.source));
    attempt(() =>
      this.checker.prefetchClassCollection(
        [...sourceNodes, ...callbackParams.map((param) => param.name)],
        [],
      ),
    );

    const marked = protocols;
    const pending: { sourceType: ts.Type; target: () => ts.Type | undefined }[] = [];
    for (let i = 0; i < sites.length; i++) {
      const site = sites[i]!;
      const source = sourceNodes[i]!;
      const sourceType = attempt(() => this.checker.getTypeAtLocation(source));
      if (sourceType !== undefined) pending.push({ sourceType, target: site.target });
    }
    for (const { fn, index, name } of callbackParams) {
      attempt(() => {
        // Only structural declared types can lose identity; the contextual
        // signature is a checker round trip, so query it for those alone.
        const declared = this.checker.getTypeAtLocation(name);
        const parts = declared.isUnionType() ? ts.constituentTypes(declared) : [declared];
        if (!parts.some((part) => this.isStructuralTarget(part))) return;
        const context = this.checker.getContextualType(fn as ts.Expression);
        if (context === undefined) return;
        for (const signature of this.checker.getCallSignatures(context)) {
          const parameter = signature.getParameters()[index];
          if (parameter === undefined) continue;
          pending.push({
            sourceType: this.checker.getTypeOfSymbol(parameter),
            target: () => declared,
          });
        }
      });
    }
    let changed = true;
    while (changed) {
      changed = false;
      for (let i = pending.length - 1; i >= 0; i--) {
        const entry = pending[i]!;
        if (attempt(() => this.carriesIdentity(entry.sourceType, marked)) !== true) continue;
        pending.splice(i, 1);
        const target = attempt(entry.target);
        if (
          target !== undefined &&
          attempt(() => this.markTarget(entry.sourceType, target, marked)) === true
        )
          changed = true;
      }
    }
  }

  /** The value a flow site hands over: casts through `unknown` or `any`
   * keep the original value (`t as unknown as { v: number }`). */
  /** The expression whose type a flow site carries: parentheses, non-null
   * assertions and casts through `unknown`/`any` keep the value itself. */
  private flowSourceNode(expr: ts.Expression): ts.Expression {
    let inner: ts.Expression = expr;
    for (;;) {
      if (ts.isParenthesizedExpression(inner) || ts.isNonNullExpression(inner)) {
        inner = inner.expression;
        continue;
      }
      if (
        (ts.isAsExpression(inner) || ts.isTypeAssertion(inner)) &&
        (inner.type.kind === ts.SyntaxKind.UnknownKeyword ||
          inner.type.kind === ts.SyntaxKind.AnyKeyword)
      ) {
        inner = inner.expression;
        continue;
      }
      return inner;
    }
  }

  private isProgramClassInstance(type: ts.Type): boolean {
    const symbol = type.getSymbol();
    return (
      symbol !== undefined &&
      (symbol.flags & ts.SymbolFlags.Class) !== 0 &&
      this.checker
        .declarationsOf(symbol)
        .some((declaration) => !declaration.getSourceFile().isDeclarationFile) &&
      // `typeof C` (the class value) shares the class symbol.
      this.checker.getConstructSignatures(type).length === 0
    );
  }

  private carriesIdentity(type: ts.Type, marked: ReadonlySet<ts.Symbol>): boolean {
    if (type.isUnionType() || type.isIntersectionType())
      return ts.constituentTypes(type).some((part) => this.carriesIdentity(part, marked));
    if ((type.flags & ts.TypeFlags.Object) === 0) return false;
    if (this.checker.isArrayType(type)) {
      const [element] = this.checker.getTypeArguments(type as ts.TypeReference);
      return element !== undefined && this.carriesIdentity(element, marked);
    }
    if (this.isProgramClassInstance(type) || this.mappedViews.has(type)) return true;
    const symbol = type.getSymbol();
    if (symbol === undefined) return false;
    if (marked.has(symbol)) return true;
    // A program interface a class matches by its methods (protocol below).
    return (
      this.methods.size > 0 &&
      this.checker
        .declarationsOf(symbol)
        .some(
          (declaration) =>
            ts.isInterfaceDeclaration(declaration) &&
            !declaration.getSourceFile().isDeclarationFile,
        ) &&
      this.protocol(type)
    );
  }

  /** A structural target that natively becomes a record: a program object
   * type that is not a class instance, array, tuple, function or library
   * type. */
  private isStructuralTarget(type: ts.Type): boolean {
    if ((type.flags & ts.TypeFlags.Object) === 0) return false;
    if (this.checker.isArrayType(type) || this.checker.isTupleType(type)) return false;
    if (this.checker.getCallSignatures(type).length > 0) return false;
    if (this.checker.getConstructSignatures(type).length > 0) return false;
    if (this.isReadonlyClassView(type)) return true;
    const symbol = type.getSymbol();
    if (symbol === undefined || (symbol.flags & ts.SymbolFlags.Class) !== 0) return false;
    const declarations = this.checker.declarationsOf(symbol);
    return (
      declarations.length > 0 &&
      declarations.every((declaration) => !declaration.getSourceFile().isDeclarationFile)
    );
  }

  /** Marks the structural parts of `target` that the identity-carrying
   * parts of `source` flow into. Answers whether anything new was marked. */
  private markTarget(source: ts.Type, target: ts.Type, marked: Set<ts.Symbol>): boolean {
    if (source.isUnionType()) {
      let changed = false;
      for (const part of ts.constituentTypes(source))
        if (this.carriesIdentity(part, marked) && this.markTarget(part, target, marked))
          changed = true;
      return changed;
    }
    if (target.isUnionType()) {
      // Only the arms that accept the value receive it. An accepting arm
      // that holds it as itself (its own type, its class, or another
      // representation with identity) needs no structural view.
      const accepting: ts.Type[] = [];
      for (const part of ts.constituentTypes(target)) {
        if ((part.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)) !== 0) continue;
        if (part === source || part.getSymbol() === source.getSymbol()) return false;
        if (!this.checker.isTypeAssignableTo(source, part)) continue;
        if (!this.isStructuralTarget(part)) return false;
        accepting.push(part);
      }
      let changed = false;
      for (const part of accepting) if (this.markTarget(source, part, marked)) changed = true;
      return changed;
    }
    if (this.checker.isArrayType(source) && this.checker.isArrayType(target)) {
      const [from] = this.checker.getTypeArguments(source as ts.TypeReference);
      const [to] = this.checker.getTypeArguments(target as ts.TypeReference);
      return from !== undefined && to !== undefined && this.markTarget(from, to, marked);
    }
    if (!this.isStructuralTarget(target)) return false;
    if (this.isReadonlyClassView(target)) {
      // Utility aliases share a library symbol across instantiations. Mark
      // only the view receiving identity; unrelated readonly records stay native.
      if (this.mappedViews.has(target)) return false;
      this.mappedViews.add(target);
      return true;
    }
    const symbol = target.getSymbol();
    if (symbol === undefined || marked.has(symbol)) return false;
    if (source.getSymbol() === symbol) return false;
    marked.add(symbol);
    return true;
  }

  /** Class-backed protocols require live receiver dispatch. Other interfaces,
   * including factories backed by static methods and ordinary records of
   * closures, retain their fixed native layouts. */
  usesCheckedIdentity(type: ts.Type): boolean {
    if (type.isUnionType()) {
      const present = ts
        .constituentTypes(type)
        .filter((part) => (part.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)) === 0);
      return present.length > 0 && present.every((part) => this.usesCheckedIdentity(part));
    }
    if (type.isIntersectionType())
      return ts.constituentTypes(type).some((part) => this.usesCheckedIdentity(part));
    if ((type.flags & ts.TypeFlags.Object) === 0) return false;
    const previous = this.answers.get(type);
    if (previous !== undefined) return previous;
    const answer = this.protocol(type);
    this.answers.set(type, answer);
    return answer;
  }

  /** Readonly removes private members from the type, not from the value.
   * A checked view holds both class instances and structural implementations;
   * neither a copied method record nor nominal class storage can do that. */
  private isReadonlyClassView(type: ts.Type): boolean {
    const alias = type.getAliasSymbol();
    const args = type.getAliasTypeArguments();
    if (
      alias?.name !== "Readonly" ||
      args.length !== 1 ||
      !this.isProgramClassInstance(args[0]!) ||
      !this.checker
        .declarationsOf(alias)
        .some((decl) => ts.isTypeAliasDeclaration(decl) && this.isStdlibFile(decl.getSourceFile()))
    )
      return false;
    const properties = this.checker.getPropertiesOfType(type);
    return (
      properties.length === 0 ||
      properties.some(
        (property) =>
          !isGenericCallableMemberType(this.checker.getTypeOfSymbol(property), this.checker),
      )
    );
  }

  private protocol(type: ts.Type): boolean {
    const protocols = this.index();
    const symbol = type.getSymbol();
    const properties = this.checker.getPropertiesOfType(type);
    // Generic-only members have no single runtime callable signature. Keep
    // their existing declaration-based specialization and refusal boundary.
    if (
      properties.length > 0 &&
      properties.every((property) =>
        isGenericCallableMemberType(this.checker.getTypeOfSymbol(property), this.checker),
      )
    )
      return false;
    if (this.mappedViews.has(type) || (symbol && protocols.has(symbol))) return true;
    if (
      !symbol ||
      !this.checker
        .declarationsOf(symbol)
        .some(
          (declaration) =>
            ts.isInterfaceDeclaration(declaration) &&
            !declaration.getSourceFile().isDeclarationFile,
        )
    )
      return false;
    for (const property of properties) {
      const memberType = this.checker.getTypeOfSymbol(property);
      if (isGenericCallableMemberType(memberType, this.checker)) continue;
      if (this.checker.getCallSignatures(memberType).length === 0) continue;
      for (const declaration of this.methods.get(property.name) ?? []) {
        const classSymbol = declaration.name
          ? this.checker.getSymbolAtLocation(declaration.name)
          : undefined;
        if (
          classSymbol &&
          this.checker.isTypeAssignableTo(this.checker.getDeclaredTypeOfSymbol(classSymbol), type)
        )
          return true;
      }
    }
    return false;
  }
}

/** A checker query that may hit an upstream checker panic: the flow scan
 * skips a site it cannot type rather than failing the build. */
function attempt<T>(query: () => T): T | undefined {
  try {
    return query();
  } catch {
    return undefined;
  }
}

/** `(value as T).member` and `(value as T)[key]`: the assertion is read or
 * written member-wise in place, which lowers to the instance's own fields
 * and creates no view that could outlive it. */
function accessedInPlace(node: ts.Expression): boolean {
  let outer: ts.Node = node;
  while (ts.isParenthesizedExpression(outer.parent)) outer = outer.parent;
  const parent = outer.parent;
  return (
    (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
    parent.expression === outer
  );
}
