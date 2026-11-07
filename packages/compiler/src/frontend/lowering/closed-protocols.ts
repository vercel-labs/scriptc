import * as ts from "../ts7/adapter.js";

/** The class-backed protocols whose every value is an instance of a known
 * set of program classes: the CLOSED protocols. Such an interface type needs
 * no checked-dynamic view. A value of it is the instance pointer it already
 * is under its class type, so the type maps to the class (one implementing
 * hierarchy) or to the union of its classes (several), member calls dispatch
 * on the class id, and no conversion happens where an instance enters the
 * interface type.
 *
 * Whole-program compilation decides it. An interface is closed when:
 *
 * - classes declare it (`implements`), each a plain top-level program class
 *   in a hierarchy of such classes;
 * - nothing else marked it a view (a receiver-dependent or member-kind
 *   literal, a collection flow: see ClassProtocols);
 * - no value that could inhabit it has another origin. Every expression the
 *   program moves into a slot (an argument, an initializer, a returned or
 *   assigned value, a literal's member, an asserted operand) is a possible
 *   origin, with the union parts and type arguments of its type. An origin
 *   whose type is assignable to the interface and is not one of its classes
 *   keeps the interface open: an object literal, a record type, a class
 *   that only matches it, a library type. A value held in a member was
 *   moved there and is an origin where it was. A type parameter is no
 *   origin: generic code is compiled per instantiation and its values
 *   arrive as arguments;
 * - no untyped value is converted into it: an `any` value written to a slot
 *   whose type holds the interface, an assertion that narrows to it, a type
 *   predicate that does, or a function with such a parameter handed to an
 *   untyped slot, whose callers pass untyped arguments. An untyped value
 *   passed through an `any` callee, written through an `any` receiver or
 *   by Object.assign can reach any typed slot, so it opens every one;
 * - its members are all required, methods are implemented as methods with
 *   the interface's parameter types and properties as fields of the
 *   interface's type, and no method is read as a value, no member is read
 *   by bracket, updated in place or destructured: the dispatch over classes
 *   answers calls and plain field reads and writes;
 * - no value of it is observed as a whole object (console, JSON, Object,
 *   Reflect, util, assert, structuredClone, a spread, `for…in`, `in`,
 *   `delete`, a template, a computed member, a member inherited from
 *   Object.prototype): those read an object's own properties, which the
 *   checked-dynamic view answers for every arm.
 *
 * Every test errs toward open, which keeps today's representation, and the
 * lowering driver compares a failing program against a pass with every
 * protocol open (lowerToIr), so a use the dispatch over classes does not
 * answer costs no program an error. The analysis runs only in programs
 * with a candidate, so a program without `implements` pays nothing. */
export class ClosedProtocols {
  /** Each closed interface's classes: none extends another. */
  private readonly closed = new Map<ts.Symbol, readonly ts.Symbol[]>();
  /** The candidates still closed, with the classes that cover each. */
  private readonly candidates = new Map<ts.Symbol, Candidate>();
  private readonly bases = new Map<ts.Symbol, ts.Symbol | null>();
  private readonly closableClasses = new Map<ts.Symbol, boolean>();
  /** Types whose own assignability to the candidates was tested. */
  private readonly tested = new Set<ts.Type>();
  /** Types whose parts were visited as origins. */
  private readonly visited = new Set<ts.Type>();
  private readonly untyped = new Map<ts.Type, boolean>();
  private readonly callables = new Map<ts.Type, boolean>();
  private readonly holders = new Map<ts.Type, boolean>();
  /** The names of the candidates' method members. */
  private readonly methodNames = new Set<string>();
  /** The types already visited as conversion targets. */
  private readonly converted = new Set<ts.Type>();

  constructor(
    private readonly checker: ts.TypeChecker,
    sources: readonly ts.SourceFile[],
    implementers: ReadonlyMap<ts.Symbol, ReadonlySet<ts.ClassLikeDeclaration>>,
    viewed: (symbol: ts.Symbol) => boolean,
  ) {
    for (const [symbol, declarations] of implementers) {
      if (viewed(symbol)) continue;
      const candidate = attempt(() => this.candidate(symbol, declarations));
      if (candidate != null) this.candidates.set(symbol, candidate);
    }
    if (this.candidates.size === 0) return;
    this.scan(sources);
    for (const [symbol, candidate] of this.candidates) this.closed.set(symbol, candidate.arms);
  }

  /** The classes whose instances are the only values of the interface
   * `symbol`, or null when it is not closed. */
  classesOf(symbol: ts.Symbol): readonly ts.Symbol[] | null {
    return this.closed.get(symbol) ?? null;
  }

  get size(): number {
    return this.closed.size;
  }

  private candidate(
    symbol: ts.Symbol,
    declarations: ReadonlySet<ts.ClassLikeDeclaration>,
  ): Candidate | null {
    if (
      symbol.declarations.length === 0 ||
      !symbol.declarations.every(
        (declaration) =>
          ts.isInterfaceDeclaration(declaration) &&
          programTsFile(declaration) &&
          (declaration.typeParameters?.nodes.length ?? 0) === 0,
      )
    )
      return null;
    const type = this.checker.getDeclaredTypeOfSymbol(symbol);
    if (
      this.checker.getCallSignatures(type).length > 0 ||
      this.checker.getConstructSignatures(type).length > 0 ||
      this.checker.getIndexInfosOfType(type).length > 0
    )
      return null;
    // An interface that extends a library type shares that type's values.
    const target = type.isTypeReference() ? type.getTarget() : type;
    if (target?.isClassOrInterface())
      for (const base of this.checker.getBaseTypes(target)) {
        const baseSymbol = base.getSymbol();
        if (
          baseSymbol === undefined ||
          !baseSymbol.declarations.every(
            (declaration) => ts.isInterfaceDeclaration(declaration) && programTsFile(declaration),
          )
        )
          return null;
      }
    const required: string[] = [];
    const members: { name: string; method: boolean; signature: ts.Symbol }[] = [];
    for (const property of this.checker.getPropertiesOfType(type)) {
      const name = ts.symbolName(property);
      if (name.startsWith("__@")) return null;
      for (const declaration of property.declarations) {
        if (!ts.isMethodSignatureDeclaration(declaration) && !ts.isPropertySignature(declaration))
          return null;
      }
      // A generic member is instantiated per call, which the dispatch over
      // classes does not do.
      if (
        this.checker
          .getCallSignatures(this.checker.getTypeOfSymbol(property))
          .some((signature) => signature.getTypeParameters().length > 0)
      )
        return null;
      // An optional member is present on some classes and absent on
      // others, which a read through the union of classes does not answer.
      if ((property.flags & ts.SymbolFlags.Optional) !== 0) return null;
      const method = property.declarations.every((declaration) =>
        ts.isMethodSignatureDeclaration(declaration),
      );
      // A function-valued property is read as a value before it is called.
      if (
        !method &&
        this.checker.getCallSignatures(this.checker.getTypeOfSymbol(property)).length > 0
      )
        return null;
      if (method) this.methodNames.add(name);
      members.push({ name, method, signature: property });
      required.push(name);
    }
    // Every object is a value of an interface that requires no member.
    if (required.length === 0) return null;
    for (const primitive of [
      this.checker.getStringType(),
      this.checker.getNumberType(),
      this.checker.getBooleanType(),
      this.checker.getBigIntType(),
    ])
      if (this.checker.isTypeAssignableTo(primitive, type)) return null;
    const covered = new Set<ts.Symbol>();
    for (const declaration of declarations) {
      const classSymbol =
        declaration.name === undefined
          ? undefined
          : this.checker.getSymbolAtLocation(declaration.name);
      if (classSymbol === undefined || !this.closableClass(classSymbol)) return null;
      if (!this.conforms(classSymbol, members)) return null;
      covered.add(classSymbol);
    }
    if (covered.size === 0) return null;
    const arms = [...covered].filter((classSymbol) => {
      for (let base = this.baseOf(classSymbol); base !== null; base = this.baseOf(base))
        if (covered.has(base)) return false;
      return true;
    });
    return { type, required, covered, arms, into: new Set() };
  }

  /** Whether the class `symbol` implements each member the way the
   * dispatch over classes reads it: a method as a method with the
   * interface's own parameter types, a property as a field. An accessor, a
   * function-valued field standing for a method, or a method with another
   * parameter list is answered by the checked-dynamic view instead. */
  private conforms(
    symbol: ts.Symbol,
    members: readonly { name: string; method: boolean; signature: ts.Symbol }[],
  ): boolean {
    const instance = this.checker.getDeclaredTypeOfSymbol(symbol);
    for (const member of members) {
      const implemented = this.checker.getPropertyOfType(instance, member.name);
      if (implemented === undefined || implemented.declarations.length === 0) return false;
      if ((implemented.flags & ts.SymbolFlags.Optional) !== 0) return false;
      if (!member.method) {
        if (
          !implemented.declarations.every(
            (declaration) => ts.isPropertyDeclaration(declaration) || ts.isParameter(declaration),
          )
        )
          return false;
        // One read through the classes needs one field type: the
        // interface's own (a field initialized with a literal has it).
        const declared = this.checker.getTypeOfSymbol(member.signature);
        const stored = this.checker.getTypeOfSymbol(implemented);
        if (stored !== declared && this.checker.getBaseTypeOfLiteralType(stored) !== declared)
          return false;
        continue;
      }
      if (!implemented.declarations.every((declaration) => ts.isMethodDeclaration(declaration)))
        return false;
      const declared = this.checker.getCallSignatures(
        this.checker.getTypeOfSymbol(member.signature),
      );
      const actual = this.checker.getCallSignatures(this.checker.getTypeOfSymbol(implemented));
      if (declared.length !== 1 || actual.length !== 1) return false;
      const expected = declared[0]!.getParameters();
      const given = actual[0]!.getParameters();
      if (expected.length !== given.length || actual[0]!.getTypeParameters().length > 0)
        return false;
      for (let i = 0; i < expected.length; i++)
        if (this.checker.getTypeOfSymbol(expected[i]!) !== this.checker.getTypeOfSymbol(given[i]!))
          return false;
    }
    return true;
  }

  /** The program class `symbol` extends, or null. */
  private baseOf(symbol: ts.Symbol): ts.Symbol | null {
    const known = this.bases.get(symbol);
    if (known !== undefined) return known;
    let base: ts.Symbol | null = null;
    const declared = this.checker.getDeclaredTypeOfSymbol(symbol);
    const target = declared.isTypeReference() ? declared.getTarget() : declared;
    if (target?.isClassOrInterface())
      for (const candidate of this.checker.getBaseTypes(target)) {
        const baseSymbol = candidate.getSymbol();
        if (baseSymbol !== undefined && (baseSymbol.flags & ts.SymbolFlags.Class) !== 0) {
          base = baseSymbol;
          break;
        }
      }
    this.bases.set(symbol, base);
    return base;
  }

  /** A plain program class: declared at the top level of a TypeScript
   * file, not generic, not ambient, undecorated, and extending nothing but
   * such classes. Its instances carry a class id the dispatch can read. */
  private closableClass(symbol: ts.Symbol): boolean {
    const known = this.closableClasses.get(symbol);
    if (known !== undefined) return known;
    this.closableClasses.set(symbol, false);
    const answer = attempt(() => {
      if (symbol.declarations.length !== 1) return false;
      const declaration = symbol.declarations[0]!;
      if (
        !ts.isClassDeclaration(declaration) ||
        declaration.name === undefined ||
        !programTsFile(declaration) ||
        declaration.parent === undefined ||
        !ts.isSourceFile(declaration.parent) ||
        (declaration.typeParameters?.nodes.length ?? 0) > 0 ||
        declaration.modifiers?.nodes.some(
          (modifier) =>
            modifier.kind === ts.SyntaxKind.DeclareKeyword ||
            modifier.kind === ts.SyntaxKind.Decorator,
        ) === true
      )
        return false;
      for (const clause of declaration.heritageClauses?.nodes ?? []) {
        if (clause.token !== ts.SyntaxKind.ExtendsKeyword) continue;
        const base = this.baseOf(symbol);
        if (base === null || !this.closableClass(base)) return false;
      }
      return true;
    });
    this.closableClasses.set(symbol, answer === true);
    return answer === true;
  }

  /** The candidate whose interface `type` is. */
  private candidateOf(type: ts.Type): ts.Symbol | undefined {
    const symbol = type.getSymbol();
    return symbol !== undefined && this.candidates.has(symbol) ? symbol : undefined;
  }

  /** Whether instances of the class `symbol` are values of `candidate` by
   * declaration: the class or one it extends says `implements`. */
  private covers(candidate: Candidate, symbol: ts.Symbol): boolean {
    for (let cls: ts.Symbol | null = symbol; cls !== null; cls = this.baseOf(cls))
      if (candidate.covered.has(cls)) return true;
    return false;
  }

  private scan(sources: readonly ts.SourceFile[]): void {
    const origins: ts.Expression[] = [];
    /** Origins with the node whose contextual type receives them, or the
     * declared type's node. */
    const targets: {
      index: number;
      source: ts.Expression;
      target: () => ts.Type | undefined;
      /** A call argument: with no contextual type the callee is untyped. */
      argument: boolean;
    }[] = [];
    const asserted: { source: ts.Expression; type: ts.TypeNode }[] = [];
    const predicates: { parameter: ts.Node | undefined; type: ts.TypeNode }[] = [];
    /** Expressions observed as whole objects. */
    const observed: ts.Expression[] = [];
    /** Calls with arguments: the callee, and its arguments' places among
     * the origins. `writer`: an Object or Reflect function that writes
     * properties of its target. */
    const calls: { callee: ts.Expression; first: number; count: number; writer: boolean }[] = [];
    /** Member writes: the receiver, and the value's place among the origins. */
    const writes: { receiver: ts.Expression; value: number }[] = [];
    /** Object binding patterns, whose types are destructured. */
    const patterns: ts.Node[] = [];
    /** Assignment targets, whose types receive the assigned values. */
    const written: ts.Expression[] = [];
    /** Receivers of a computed or inherited member access. */
    const keyed: ts.Expression[] = [];
    const contextual = (expr: ts.Expression) => () => this.checker.getContextualType(expr);
    const origin = (
      expr: ts.Expression | undefined,
      target?: () => ts.Type | undefined,
      argument = false,
    ): void => {
      if (expr === undefined) return;
      targets.push({
        index: origins.length,
        source: expr,
        target: target ?? contextual(expr),
        argument,
      });
      origins.push(expr);
    };
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const callee = node.expression;
        const observer =
          (ts.isPropertyAccessExpression(callee) &&
            ts.isIdentifier(callee.expression) &&
            OBSERVER_NAMESPACES.has(callee.expression.text)) ||
          (ts.isIdentifier(callee) && OBSERVER_FUNCTIONS.has(callee.text));
        const first = origins.length;
        for (const argument of node.arguments?.nodes ?? []) {
          const value = ts.isSpreadElement(argument) ? argument.expression : argument;
          origin(value, undefined, true);
          if (observer) observed.push(value);
        }
        if (origins.length > first)
          calls.push({
            callee,
            first,
            count: origins.length - first,
            writer:
              ts.isPropertyAccessExpression(callee) &&
              ts.isIdentifier(callee.expression) &&
              OBJECT_WRITERS.get(callee.expression.text)?.has(callee.name.text) === true,
          });
      } else if (ts.isForInStatement(node)) observed.push(node.expression);
      else if (ts.isTemplateSpan(node)) observed.push(node.expression);
      else if (ts.isDeleteExpression(node)) {
        let operand = node.expression;
        while (ts.isParenthesizedExpression(operand) || ts.isNonNullExpression(operand))
          operand = operand.expression;
        if (ts.isPropertyAccessExpression(operand) || ts.isElementAccessExpression(operand))
          observed.push(operand.expression);
      } else if (ts.isPropertyAccessExpression(node)) {
        // A member every object inherits (`value.constructor`) is not one
        // the interface declares: the view reads it off the object.
        if (INHERITED_MEMBERS.has(node.name.text)) keyed.push(node.expression);
        // A method read as a value (`const read = io.read`, `io.read.bind`)
        // is a function the view builds; a call needs none.
        else if (
          this.methodNames.has(node.name.text) &&
          !(
            node.parent !== undefined &&
            ts.isCallExpression(node.parent) &&
            node.parent.expression === node
          )
        )
          keyed.push(node.expression);
      } else if (ts.isObjectBindingPattern(node)) {
        // Destructuring reads members off the object as values.
        patterns.push(node);
      } else if (ts.isElementAccessExpression(node)) {
        // A bracket access reads the object by key, literal or computed.
        keyed.push(node.expression);
      } else if (
        (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
        (node.operator === ts.SyntaxKind.PlusPlusToken ||
          node.operator === ts.SyntaxKind.MinusMinusToken)
      ) {
        // An update of a member reads and writes it in one operation.
        let operand: ts.Expression = node.operand;
        while (ts.isParenthesizedExpression(operand) || ts.isNonNullExpression(operand))
          operand = operand.expression;
        if (ts.isPropertyAccessExpression(operand)) keyed.push(operand.expression);
      } else if (ts.isVariableDeclaration(node) && node.type !== undefined) {
        const declared = node.type;
        origin(node.initializer, () => this.checker.getTypeFromTypeNode(declared));
      } else if (ts.isPropertyDeclaration(node) && node.type !== undefined) {
        const declared = node.type;
        origin(node.initializer, () => this.checker.getTypeFromTypeNode(declared));
      } else if (ts.isParameter(node) && node.type !== undefined) {
        const declared = node.type;
        origin(node.initializer, () => this.checker.getTypeFromTypeNode(declared));
      } else if (ts.isReturnStatement(node)) origin(node.expression);
      else if (ts.isArrowFunction(node) && !ts.isBlock(node.body)) origin(node.body);
      else if (ts.isYieldExpression(node)) origin(node.expression);
      else if (ts.isArrayLiteralExpression(node)) {
        for (const element of node.elements.nodes) {
          if (ts.isOmittedExpression(element)) continue;
          origin(ts.isSpreadElement(element) ? element.expression : element);
        }
      } else if (ts.isPropertyAssignment(node)) origin(node.initializer);
      else if (ts.isShorthandPropertyAssignment(node) && ts.isIdentifier(node.name))
        origin(node.name);
      else if (ts.isSpreadAssignment(node)) {
        origin(node.expression);
        observed.push(node.expression);
      } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.InKeyword)
        observed.push(node.right);
      else if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      ) {
        const left = node.left;
        written.push(left);
        if (ts.isPropertyAccessExpression(left) || ts.isElementAccessExpression(left)) {
          writes.push({ receiver: left.expression, value: origins.length });
          // A compound assignment reads and writes the member in one
          // operation.
          if (node.operatorToken.kind !== ts.SyntaxKind.EqualsToken) keyed.push(left.expression);
        }
        origin(node.right, () => this.checker.getTypeAtLocation(left));
        // An assignment used as a value (`(current = next).run()`) is typed
        // by what was assigned while it holds the slot's representation.
        let outer: ts.Node | undefined = node.parent;
        while (outer !== undefined && ts.isParenthesizedExpression(outer)) outer = outer.parent;
        if (outer !== undefined && !ts.isExpressionStatement(outer)) keyed.push(left);
      } else if (ts.isAsExpression(node) || ts.isTypeAssertion(node)) {
        origins.push(node.expression);
        asserted.push({ source: node.expression, type: node.type });
      } else if (ts.isTypePredicateNode(node) && node.type !== undefined) {
        const name = node.parameterName;
        const fn = node.parent;
        const parameter =
          fn !== undefined && ts.isFunctionLike(fn) && ts.isIdentifier(name)
            ? fn.parameters.nodes.find(
                (candidate) => ts.isIdentifier(candidate.name) && candidate.name.text === name.text,
              )
            : undefined;
        predicates.push({ parameter: parameter?.name, type: node.type });
      }
      ts.forEachChild(node, visit);
    };
    for (const source of sources) if (!source.isDeclarationFile) visit(source);
    attempt(() =>
      this.checker.prefetchClassCollection(
        [...origins, ...observed, ...keyed, ...written, ...patterns],
        [],
      ),
    );

    // Every origin's type, with the types it holds.
    const typeOf = (node: ts.Node): ts.Type | undefined => {
      // `this` has the polymorphic this type: its values are the enclosing
      // class's instances.
      if (node.kind === ts.SyntaxKind.ThisKeyword) {
        const owner = thisClass(node);
        const symbol =
          owner?.name === undefined ? undefined : this.checker.getSymbolAtLocation(owner.name);
        if (symbol !== undefined) return this.checker.getDeclaredTypeOfSymbol(symbol);
      }
      return this.checker.getTypeAtLocation(node);
    };
    const types = origins.map((node) => attempt(() => typeOf(node)));
    for (const type of types) {
      if (this.candidates.size === 0) return;
      if (type !== undefined) attempt(() => this.originType(type, 0));
    }
    // Untyped values converted into a slot: the conversion would accept
    // only instances, so every candidate the slot's type holds stays open.
    const converted = targets.filter((entry) => {
      const type = types[entry.index];
      return type !== undefined && attempt(() => this.holdsUntyped(type, 0)) !== false;
    });
    attempt(() => this.checker.prefetchContextualTypes(converted.map((entry) => entry.source)));
    for (const entry of converted) {
      if (this.candidates.size === 0) return;
      const target = attempt(entry.target);
      // A value written to a slot of its own type converts nothing.
      if (target !== undefined && target !== types[entry.index]) this.openHeld(target);
    }
    // A function handed to an untyped slot is called with untyped
    // arguments: its parameters convert them, so the candidates they hold
    // stay open.
    const callbacks = targets.filter((entry) => {
      const type = types[entry.index];
      return type !== undefined && attempt(() => this.callable(type)) === true;
    });
    attempt(() => this.checker.prefetchContextualTypes(callbacks.map((entry) => entry.source)));
    for (const entry of callbacks) {
      if (this.candidates.size === 0) return;
      const target = attempt(entry.target);
      const type = types[entry.index]!;
      if (target === undefined ? entry.argument : this.untypedCaller(target))
        this.openParameters(type);
    }
    for (const { source, type } of asserted) {
      if (this.candidates.size === 0) return;
      attempt(() => {
        const target = this.checker.getTypeFromTypeNode(type);
        const from = typeOf(source);
        // A function asserted to an untyped type is called untyped.
        if (from !== undefined && this.callable(from) && this.untypedCaller(target))
          this.openParameters(from);
        // An assertion to a type the operand already has converts nothing.
        if (
          from !== undefined &&
          this.holdsUntyped(from, 0) === false &&
          this.checker.isTypeAssignableTo(from, target)
        )
          return;
        this.openHeld(target);
      });
    }
    for (const node of observed) {
      if (this.candidates.size === 0) return;
      const type = attempt(() => typeOf(node));
      if (type !== undefined) this.openObserved(type, true);
    }
    for (const node of patterns) {
      if (this.candidates.size === 0) return;
      const type = attempt(() => this.checker.getTypeAtLocation(node));
      if (type !== undefined) this.openObserved(type, false);
    }
    for (const node of keyed) {
      if (this.candidates.size === 0) return;
      const type = attempt(() => typeOf(node));
      if (type !== undefined) this.openObserved(type, false);
    }
    // An untyped value handed to untyped code can reach any typed slot that
    // code holds: a call through an `any` callee can run any function the
    // program ever converted, a write through an `any` receiver or by
    // Object.assign lands in a typed field. Which slot is not known here,
    // so every candidate stays open.
    const untypedOrigin = (index: number): boolean => {
      const type = types[index];
      return type !== undefined && attempt(() => this.holdsUntyped(type, 0)) !== false;
    };
    for (const call of calls) {
      if (this.candidates.size === 0) return;
      let untyped = false;
      for (let i = call.first; i < call.first + call.count && !untyped; i++)
        untyped = untypedOrigin(i) || (call.writer && this.memberUntyped(types[i]));
      if (!untyped) continue;
      const callee = attempt(() => this.checker.getTypeAtLocation(call.callee));
      if (call.writer || callee === undefined || (callee.flags & ts.TypeFlags.Any) !== 0)
        this.openAll();
    }
    for (const write of writes) {
      if (this.candidates.size === 0) return;
      if (!untypedOrigin(write.value)) continue;
      const receiver = attempt(() => this.checker.getTypeAtLocation(write.receiver));
      if (receiver === undefined || (receiver.flags & ts.TypeFlags.Any) !== 0) this.openAll();
    }
    for (const { parameter, type } of predicates) {
      if (this.candidates.size === 0) return;
      attempt(() => {
        const target = this.checker.getTypeFromTypeNode(type);
        const from =
          parameter === undefined ? undefined : this.checker.getTypeAtLocation(parameter);
        if (
          from !== undefined &&
          this.holdsUntyped(from, 0) === false &&
          this.checker.isTypeAssignableTo(from, target)
        )
          return;
        this.openHeld(target);
      });
    }
  }

  /** Tests `type` as a possible origin of a candidate's values, with its
   * union and intersection parts and its type arguments (an array's
   * elements, a promise's result). The members of a type are not visited:
   * a value held in a member was moved there, and is an origin where it
   * was. */
  private originType(type: ts.Type, depth: number): void {
    if (this.visited.has(type)) return;
    this.visited.add(type);
    if (type.isUnionType() || type.isIntersectionType()) {
      const parts = ts.constituentTypes(type);
      // An intersection is tested whole (its parts together satisfy the
      // interface) and by its parts.
      if (
        type.isIntersectionType() &&
        !parts.some((part) => (part.flags & ts.TypeFlags.TypeParameter) !== 0)
      )
        this.test(type);
      for (const part of parts) this.originType(part, depth);
      return;
    }
    // A type parameter is no origin: generic code is compiled per
    // instantiation, and the values of each arrive as arguments, which are
    // origins with their own types.
    if ((type.flags & ts.TypeFlags.Object) === 0) return;
    this.test(type);
    if (type.isTypeReference())
      for (const argument of this.checker.getTypeArguments(type))
        this.originType(argument, depth + 1);
  }

  /** Opens every candidate `type` is assignable to without being one of
   * its classes. */
  private test(type: ts.Type): void {
    if (this.tested.has(type)) return;
    this.tested.add(type);
    const own = this.candidateOf(type);
    const symbol = type.getSymbol();
    const classSymbol =
      symbol !== undefined &&
      (symbol.flags & ts.SymbolFlags.Class) !== 0 &&
      this.checker.getConstructSignatures(type).length === 0
        ? symbol
        : undefined;
    const names = new Set(
      this.checker.getPropertiesOfType(type).map((property) => ts.symbolName(property)),
    );
    for (const [candidateSymbol, candidate] of [...this.candidates]) {
      if (candidateSymbol === own || !this.candidates.has(candidateSymbol)) continue;
      if (classSymbol !== undefined && this.covers(candidate, classSymbol)) continue;
      if (!candidate.required.every((name) => names.has(name))) continue;
      if (!this.checker.isTypeAssignableTo(type, candidate.type)) continue;
      // Another closed interface whose classes are all classes of this one
      // brings no new value while it stays closed.
      const other = own === undefined ? undefined : this.candidates.get(own);
      if (other !== undefined && other.arms.every((arm) => this.covers(candidate, arm))) {
        other.into.add(candidateSymbol);
        continue;
      }
      this.open(candidateSymbol);
    }
  }

  private open(symbol: ts.Symbol): void {
    const candidate = this.candidates.get(symbol);
    if (candidate === undefined) return;
    this.candidates.delete(symbol);
    // The interfaces that took this one's values for instances.
    for (const dependent of candidate.into) this.open(dependent);
  }

  private openAll(): void {
    for (const symbol of [...this.candidates.keys()]) this.open(symbol);
  }

  /** Whether a member of the object type `type` is untyped: the object
   * carries an untyped value into whatever it is written to. */
  private memberUntyped(type: ts.Type | undefined): boolean {
    if (type === undefined) return true;
    return (
      attempt(() => {
        const parts =
          type.isUnionType() || type.isIntersectionType() ? ts.constituentTypes(type) : [type];
        return parts.some(
          (part) =>
            (part.flags & ts.TypeFlags.Object) !== 0 &&
            this.checker
              .getPropertiesOfType(part)
              .some((property) => this.holdsUntyped(this.checker.getTypeOfSymbol(property), 0)),
        );
      }) !== false
    );
  }

  /** A function type, alone or as a union arm, with a parameter that holds
   * a candidate. */
  private callable(type: ts.Type): boolean {
    const known = this.callables.get(type);
    if (known !== undefined) return known;
    this.callables.set(type, false);
    const parts = type.isUnionType() ? ts.constituentTypes(type) : [type];
    const answer = parts.some((part) => {
      // Only a function's own type or a function type literal: asking every
      // origin type for its call signatures would cost a checker round trip
      // per type.
      const symbol = part.getSymbol();
      if (
        (part.flags & ts.TypeFlags.Object) === 0 ||
        symbol === undefined ||
        (symbol.flags &
          (ts.SymbolFlags.Function | ts.SymbolFlags.Method | ts.SymbolFlags.TypeLiteral)) ===
          0
      )
        return false;
      return this.checker
        .getCallSignatures(part)
        .some((signature) =>
          signature
            .getParameters()
            .some((parameter) => this.holdsCandidate(this.checker.getTypeOfSymbol(parameter))),
        );
    });
    this.callables.set(type, answer);
    return answer;
  }

  /** Whether a function stored in a slot of type `target` may be called
   * with untyped arguments: the slot is `any` or `unknown`, or a function
   * type with a parameter that holds `any`. */
  private untypedCaller(target: ts.Type): boolean {
    if ((target.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) return true;
    if (target.isUnionType() || target.isIntersectionType())
      return ts.constituentTypes(target).some((part) => this.untypedCaller(part));
    if ((target.flags & ts.TypeFlags.Object) === 0) return false;
    return this.checker
      .getCallSignatures(target)
      .some((signature) =>
        signature
          .getParameters()
          .some((parameter) => this.holdsUntyped(this.checker.getTypeOfSymbol(parameter), 0)),
      );
  }

  /** Opens the candidates the parameters of the function type `type` hold. */
  private openParameters(type: ts.Type): void {
    attempt(() => {
      const parts = type.isUnionType() ? ts.constituentTypes(type) : [type];
      for (const part of parts)
        for (const signature of this.checker.getCallSignatures(part))
          for (const parameter of signature.getParameters())
            this.openHeld(this.checker.getTypeOfSymbol(parameter));
    });
  }

  /** Whether `type` is `any` or `unknown`, alone, as a union part or as a
   * type argument at any depth (`any[]`, `any[][][]`, `Promise<any>`): a
   * value of it converts where it is written to a typed slot. */
  private holdsUntyped(type: ts.Type, depth: number): boolean {
    if ((type.flags & ts.TypeFlags.Any) !== 0) return true;
    // An `unknown` value itself (the checker types a JSON.parse result so
    // in a typed slot): it reaches a typed slot only by converting.
    if (depth === 0 && (type.flags & ts.TypeFlags.Unknown) !== 0) return true;
    const known = this.untyped.get(type);
    if (known !== undefined) return known;
    this.untyped.set(type, false);
    let answer = false;
    if (type.isUnionType() || type.isIntersectionType())
      answer = ts.constituentTypes(type).some((part) => this.holdsUntyped(part, depth));
    else if ((type.flags & ts.TypeFlags.Object) !== 0 && type.isTypeReference())
      answer = this.checker
        .getTypeArguments(type)
        .some((argument) => this.holdsUntyped(argument, depth + 1));
    this.untyped.set(type, answer);
    return answer;
  }

  /** Opens the candidates a whole-object observer is handed: the type
   * itself and its union arms, and with `deep` every candidate the type
   * holds (an observer such as `console.log` or `JSON.stringify` walks
   * into the arrays and records it is given). */
  private openObserved(type: ts.Type, deep: boolean): void {
    if (type.isUnionType() || type.isIntersectionType()) {
      for (const part of ts.constituentTypes(type)) this.openObserved(part, deep);
      return;
    }
    if ((type.flags & ts.TypeFlags.Object) === 0) return;
    const own = this.candidateOf(type);
    if (own !== undefined) this.open(own);
    else if (deep) this.openHeld(type);
  }

  /** Opens every candidate the type `target` holds: a value converted into
   * `target` reaches each of them unchecked by this analysis. The object
   * types it holds are origins too: the conversion builds values of them. */
  private openHeld(target: ts.Type): void {
    attempt(() =>
      this.walkHeld(target, this.converted, (type, candidate) => {
        if (candidate !== undefined) this.open(candidate);
        else this.test(type);
      }),
    );
  }

  /** Whether the type `target` holds a candidate. An answer may outlive
   * the candidate it saw, which only costs a query. */
  private holdsCandidate(target: ts.Type): boolean {
    const known = this.holders.get(target);
    if (known !== undefined) return known;
    let found = false;
    attempt(() =>
      this.walkHeld(target, new Set(), (type, candidate) => {
        if (candidate !== undefined) found = true;
      }),
    );
    this.holders.set(target, found);
    return found;
  }

  /** Visits the object types `target` holds: itself, its parts, type
   * arguments, call parameters and results, and the members of the
   * program's own object types. A candidate is reported and not entered. */
  private walkHeld(
    target: ts.Type,
    seen: Set<ts.Type>,
    visit: (type: ts.Type, candidate: ts.Symbol | undefined) => void,
  ): void {
    const walk = (type: ts.Type, depth: number): void => {
      if (seen.has(type)) return;
      seen.add(type);
      if (type.isUnionType() || type.isIntersectionType()) {
        for (const part of ts.constituentTypes(type)) walk(part, depth);
        return;
      }
      if ((type.flags & ts.TypeFlags.Object) === 0) return;
      const own = this.candidateOf(type);
      visit(type, own);
      if (own !== undefined || depth > 6) return;
      if (type.isTypeReference())
        for (const argument of this.checker.getTypeArguments(type)) walk(argument, depth + 1);
      const symbol = type.getSymbol();
      if (symbol === undefined || !symbol.declarations.every(programFile)) return;
      for (const signature of this.checker.getCallSignatures(type)) {
        walk(this.checker.getReturnTypeOfSignature(signature), depth + 1);
        for (const parameter of signature.getParameters())
          walk(this.checker.getTypeOfSymbol(parameter), depth + 1);
      }
      // A class's members are its own: a conversion to a class type yields
      // an instance, never a built value.
      if ((symbol.flags & ts.SymbolFlags.Class) !== 0) return;
      for (const property of this.checker.getPropertiesOfType(type))
        walk(this.checker.getTypeOfSymbol(property), depth + 1);
    };
    walk(target, 0);
  }
}

/** Calls of these namespaces and functions observe whole objects. */
export const OBSERVER_NAMESPACES = new Set([
  "console",
  "JSON",
  "Object",
  "Reflect",
  "util",
  "assert",
]);
export const OBSERVER_FUNCTIONS = new Set([
  "structuredClone",
  "String",
  "inspect",
  "format",
  "isDeepStrictEqual",
  // node:assert's named exports.
  "strictEqual",
  "notStrictEqual",
  "deepStrictEqual",
  "notDeepStrictEqual",
  "deepEqual",
  "notDeepEqual",
  "equal",
  "notEqual",
]);
/** The Object and Reflect functions that write properties of a target. */
const OBJECT_WRITERS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["Object", new Set(["assign", "defineProperty", "defineProperties", "setPrototypeOf"])],
  ["Reflect", new Set(["set", "defineProperty", "setPrototypeOf", "apply", "construct"])],
]);

/** The members every object inherits from Object.prototype. */
const INHERITED_MEMBERS = new Set([
  "constructor",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toLocaleString",
  "toString",
  "valueOf",
  "__proto__",
]);

interface Candidate {
  type: ts.Type;
  /** The members every value must have: a quick test before assignability. */
  required: string[];
  /** The classes that declare the interface. */
  covered: Set<ts.Symbol>;
  /** `covered` without the classes that extend another of them. */
  arms: ts.Symbol[];
  /** The candidates that hold this one's values as instances of their own
   * classes: they open when this one does. */
  into: Set<ts.Symbol>;
}

/** A node of a TypeScript source file of the program. */
function programTsFile(node: ts.Node): boolean {
  const file = ts.getSourceFileOfNode(node);
  return !file.isDeclarationFile && !/\.[cm]?jsx?$/.test(file.fileName);
}

function programFile(node: ts.Node): boolean {
  return !ts.getSourceFileOfNode(node).isDeclarationFile;
}

/** The class whose instance `this` is at `node`. */
function thisClass(node: ts.Node): ts.ClassLikeDeclaration | undefined {
  for (let current = node.parent; current !== undefined; current = current.parent) {
    if (ts.isClassDeclaration(current) || ts.isClassExpression(current)) return current;
    if (ts.isFunctionDeclaration(current) || ts.isFunctionExpression(current)) return undefined;
  }
  return undefined;
}

function attempt<T>(query: () => T): T | undefined {
  try {
    return query();
  } catch {
    return undefined;
  }
}
