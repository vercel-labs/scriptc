/* Layout adoption: a constant table is built in the layout of the one
 * structural type the program reads it through.
 *
 * A table written `as const` and bound to a `const` has its own type, the
 * literal's, and so its own record layout. When the program hands it to an
 * interface of another layout, the conversion is a width copy, and a copy is
 * a second object: a Map keyed by the table does not find the value an
 * interface-typed reader holds, `===` answers false, an array search misses.
 *
 *   interface Tool { readonly label: string; readonly grams?: number }
 *   const awl = { label: "awl" } as const;
 *   const drawer = new Set<Tool>([awl]);
 *   function stored(tool: Tool): boolean { return drawer.has(tool); }
 *   stored(awl); // true in JavaScript; false when each crossing copies
 *
 * Nothing is converted when the table already has the interface's layout.
 * This analysis decides, before any type is mapped, which tables can: the
 * type mapper then answers the interface's record for the table's literal
 * type (TypeMapperCtx.adoptedLayout), the literal is built like one written
 * under that annotation, and every crossing is the identity conversion. There
 * is one object in one layout, so identity holds with no view and no copy.
 *
 * A table adopts a layout when all of this holds:
 *
 *   - it is an object literal under `as const`, the initializer of a `const`
 *     at the top level of a module, and its members are plain data:
 *     primitives, nested literals of the same kind, lists of them, other
 *     tables by name, and objects made elsewhere whose type is the type of
 *     the slot that holds them (plainTable, heldAsItself);
 *   - every use of the binding is a member read, an identity comparison, or
 *     a flow into a type the checker names at the site (an argument, an
 *     annotated declaration, a return, an element or member of a
 *     contextually typed literal, an assignment, an assertion), and every
 *     such flow names the SAME structural type, or a type that takes any
 *     value. A generic callee that holds the table as its type parameter
 *     counts by the parameter's constraint, as long as the call does not
 *     answer the table's own type. A member read through the table's own
 *     type is a primitive, or a nested literal or another table, whose uses
 *     are followed the same way: a nested literal may only flow into the
 *     type its slot has. A use this scan does not understand (an alias
 *     binding, a spread, a destructuring, a type query, a list read through
 *     the table's own type, a module taken as a whole object) leaves the table
 *     as it is, and so does a table held by another table that keeps its
 *     own layout: a value typed by the literal could then reach a type this
 *     scan never saw;
 *   - the structural type declares every member the table has, and a member
 *     that is a nested literal, a list or another table has a structural
 *     type or an array of one there: the nested literals take those layouts
 *     with it, and a tuple is held as the interface's array;
 *   - the program can tell a copy from the table: a value of the structural
 *     type (or a value of unknown type) is compared by identity, used as a
 *     collection key or searched for. A program that only reads its tables
 *     is compiled exactly as before.
 *
 * Everything else keeps the width copy, with the refusals and the warning
 * (SC6001) it has.
 *
 * The scan is syntactic until a table is found: a program with no `as const`
 * table at module scope pays one pass over its top-level statements. */
import * as ts from "../ts7/adapter.js";
import { withoutParentheses, withoutParenthesesNonNull } from "../outer-expressions.js";
import { isConstAssertionTypeNode } from "../type-mapper.js";

/** A constant table: the binding, its literal, and the literal's type. */
interface Table {
  readonly name: string;
  readonly binding: ts.Symbol;
  readonly literal: ts.ObjectLiteralExpression;
  /** The symbol of the literal's own type. */
  readonly own: ts.Symbol;
  readonly type: ts.Type;
  /** The structural types the binding's uses flow into. */
  readonly targets: Set<ts.Type>;
  /** The module that declares it, and whether the module exports it. */
  readonly source: ts.SourceFile;
  exported: boolean;
  /** The tables whose literals name this one as a member. */
  readonly within: { container: Table; mention: ts.Identifier }[];
  /** The nested literals that flow somewhere by themselves, read as members
   * through the table's own type: the member names from the table to the
   * literal, and the structural type the read flows into. */
  readonly memberFlows: { path: readonly string[]; target: ts.Type }[];
  /** A use the scan does not understand: the table keeps its layout. */
  escaped: boolean;
}

/** What a use is a use of: a table, or a nested literal of one reached by
 * member reads through the table's own type. */
interface Subject {
  readonly table: Table;
  readonly literal: ts.ObjectLiteralExpression;
  /** The literal's own type and its symbol. */
  readonly type: ts.Type;
  readonly own: ts.Symbol;
  /** The member names from the table to the literal; empty for the table. */
  readonly path: readonly string[];
}

/** What a table's literal becomes in a structural type's layout. */
interface Fit {
  /** Each nested literal's type and the type whose layout it takes. */
  readonly nested: Map<ts.Symbol, ts.Type>;
  /** Each member that names another table, and the type its slot has. */
  readonly slots: Map<ts.Node, ts.Type>;
}

/** Methods whose first argument is looked up by identity. */
const KEY_METHODS = new Set([
  "has",
  "get",
  "set",
  "add",
  "delete",
  "indexOf",
  "lastIndexOf",
  "includes",
]);
const KEYED_COLLECTIONS = new Set(["Map", "Set", "WeakMap", "WeakSet"]);

export class LayoutAdoptions {
  /** The literal type's symbol, and the type whose layout its values take. */
  private readonly layouts = new Map<ts.Symbol, ts.Type>();
  /** The tables of the program, by binding. */
  private readonly found: Map<ts.Symbol, Table>;

  constructor(
    private readonly checker: ts.TypeChecker,
    sources: readonly ts.SourceFile[],
  ) {
    const tables = this.tables(sources);
    this.found = tables;
    if (tables.size === 0) return;
    const names = new Set<string>();
    const literals = new Map<ts.Node, Table>();
    for (const table of tables.values()) {
      names.add(table.name);
      literals.set(table.literal, table);
    }
    const mentions: ts.Identifier[] = [];
    const compared: ts.Expression[] = [];
    const keyed: ts.Expression[] = [];
    /** The modules the program takes as a whole object: a namespace import
     * used as an object, `export *`, a dynamic `import()` or a `require()`;
     * null stands for a module named at run time. */
    const wholeModules: (ts.Expression | null)[] = [];
    const spaces = namespaceImports(sources);
    const spaceMentions: ts.Identifier[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node)) {
        if (names.has(node.text)) mentions.push(node);
        if (spaces.has(node.text)) spaceMentions.push(node);
        return;
      }
      observeIdentity(node, compared, keyed);
      wholeModule(node, wholeModules);
      ts.forEachChild(node, visit);
    };
    for (const source of sources) if (!source.isDeclarationFile) visit(source);
    this.namespacesTakenWhole(spaces, spaceMentions, wholeModules);
    for (const mention of mentions) {
      const table = this.tableOf(mention, tables);
      if (table === undefined) continue;
      const parent = mention.parent;
      if (parent !== undefined && (ts.isExportSpecifier(parent) || ts.isExportAssignment(parent)))
        table.exported = true;
      const container = containingTable(mention, literals);
      if (container !== undefined) {
        table.within.push({ container, mention });
        continue;
      }
      if (table.escaped) continue;
      try {
        this.use(mention, table);
      } catch {
        // A checker query that fails says nothing about the use.
        table.escaped = true;
      }
    }
    // A module taken as a whole object hands its exported tables to code
    // that names none of them.
    if (wholeModules.length > 0) {
      const whole = this.sourcesOf(wholeModules);
      for (const table of tables.values())
        if (table.exported && (whole === null || whole.has(table.source))) table.escaped = true;
    }
    let told: ((types: Iterable<ts.Type>, own: ts.Symbol) => boolean) | undefined;
    const decided = new Map<Table, { target: ts.Type; fit: Fit } | null>();
    // A table inside another takes the layout its slot has there, so the
    // containing tables are decided first. The literals nest by declaration
    // order, so this ends.
    /** A table that never leaves its binding: only its primitive members
     * are read and it is compared. */
    const inert = (table: Table): boolean =>
      !table.escaped &&
      table.targets.size === 0 &&
      table.within.every(({ container }) => decide(container) === null && inert(container));
    const decide = (table: Table): { target: ts.Type; fit: Fit } | null => {
      const known = decided.get(table);
      if (known !== undefined) return known;
      decided.set(table, null);
      if (table.escaped) return null;
      const targets = new Set(table.targets);
      for (const { container, mention } of table.within) {
        const outer = decide(container);
        if (outer === null) {
          // A container that keeps its own layout holds the table as
          // itself. If it goes anywhere, the table goes with it, typed by
          // its literal, into types this scan did not see.
          if (!inert(container)) return null;
          continue;
        }
        const slot = outer.fit.slots.get(mention);
        if (slot === undefined) return null;
        targets.add(slot);
      }
      if (targets.size !== 1) return null;
      const [target] = targets;
      if (target === undefined) return null;
      const fit: Fit = { nested: new Map(), slots: new Map() };
      try {
        if (!this.fits(table.literal, target, fit)) return null;
        if (!this.membersFlowAs(table, target)) return null;
      } catch {
        return null;
      }
      told ??= this.identityObserved(compared, keyed);
      if (!told([target, ...fit.nested.values(), ...fit.slots.values()], table.own)) return null;
      const answer = { target, fit };
      decided.set(table, answer);
      return answer;
    };
    // A table named in another is one object in one layout: the slot's,
    // when the container takes a layout. A container whose member keeps its
    // own layout would hold a copy of it (and a read of the member through
    // the container's own type would be typed by a literal of another
    // layout), so that container keeps its own layout too.
    for (let settled = false; !settled;) {
      settled = true;
      decided.clear();
      for (const table of tables.values()) {
        if (decide(table) !== null) continue;
        for (const { container } of table.within) {
          if (container.escaped || decide(container) === null) continue;
          container.escaped = true;
          settled = false;
        }
      }
    }
    for (const table of tables.values()) {
      const answer = decide(table);
      if (answer === null) continue;
      this.layouts.set(table.own, answer.target);
      for (const [nested, layout] of answer.fit.nested) this.layouts.set(nested, layout);
    }
  }

  /** The structural type whose layout values of `type` take, when `type` is
   * the literal type of an adopting table. */
  layoutOf(type: ts.Type): ts.Type | undefined {
    if (this.layouts.size === 0) return undefined;
    const symbol = type.getSymbol();
    return symbol === undefined ? undefined : this.layouts.get(symbol);
  }

  /** The module-scope `const name = { ... } as const` tables, by binding. */
  private tables(sources: readonly ts.SourceFile[]): Map<ts.Symbol, Table> {
    const tables = new Map<ts.Symbol, Table>();
    for (const source of sources) {
      if (source.isDeclarationFile) continue;
      for (const statement of source.statements.nodes) {
        if (!ts.isVariableStatement(statement)) continue;
        if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0) continue;
        for (const declaration of statement.declarationList.declarations.nodes) {
          if (!ts.isIdentifier(declaration.name) || declaration.type !== undefined) continue;
          if (declaration.initializer === undefined) continue;
          const asserted = withoutParentheses(declaration.initializer);
          if (!ts.isAsExpression(asserted) || !isConstAssertionTypeNode(asserted.type)) continue;
          const literal = withoutParentheses(asserted.expression);
          if (!ts.isObjectLiteralExpression(literal) || !plainTable(literal)) continue;
          try {
            const binding = this.checker.getSymbolAtLocation(declaration.name);
            const type = this.checker.getTypeAtLocation(declaration.name);
            const own = type.getSymbol();
            if (binding === undefined || own === undefined) continue;
            if ((type.flags & ts.TypeFlags.Object) === 0) continue;
            tables.set(binding, {
              name: declaration.name.text,
              binding,
              literal,
              own,
              type,
              targets: new Set(),
              source,
              exported:
                statement.modifiers?.nodes.some(
                  (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
                ) === true,
              within: [],
              memberFlows: [],
              escaped: false,
            });
          } catch {
            // No type for the binding: no table.
          }
        }
      }
    }
    return tables;
  }

  /** The table an identifier names, through imports and exports. */
  private tableOf(mention: ts.Identifier, tables: Map<ts.Symbol, Table>): Table | undefined {
    let symbol: ts.Symbol | undefined;
    try {
      const parent = mention.parent;
      symbol =
        parent !== undefined && ts.isShorthandPropertyAssignment(parent)
          ? this.checker.getShorthandAssignmentValueSymbol(parent)
          : this.checker.getSymbolAtLocation(mention);
      if (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0)
        symbol = this.checker.getAliasedSymbol(symbol);
    } catch {
      // An identifier the checker cannot resolve may be any binding of that
      // name: every table of the name keeps its layout.
      for (const table of tables.values()) if (table.name === mention.text) table.escaped = true;
      return undefined;
    }
    return symbol === undefined ? undefined : tables.get(symbol);
  }

  /** Records what one mention of a table's binding does with the table. */
  private use(mention: ts.Identifier, table: Table): void {
    const parent = mention.parent;
    if (parent === undefined) return;
    // The declaration itself, and the names of imports and exports.
    if (ts.isVariableDeclaration(parent) && parent.name === mention) return;
    if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent)) return;
    if (ts.isImportClause(parent) || ts.isNamespaceImport(parent)) return;
    if (ts.isExportAssignment(parent)) return;
    // `namespace.table`: the access is the mention.
    let value: ts.Expression = mention;
    if (ts.isPropertyAccessExpression(parent) && parent.name === mention) value = parent;
    else if (ts.isShorthandPropertyAssignment(parent) || ts.isQualifiedName(parent)) {
      table.escaped = true;
      return;
    }
    this.useValue(value, {
      table,
      literal: table.literal,
      type: table.type,
      own: table.own,
      path: [],
    });
  }

  /** Records what the program does with `start`, a value of `subject`. */
  private useValue(start: ts.Expression, subject: Subject): void {
    const { table } = subject;
    let value = start;
    // Parentheses, `!` and `satisfies` hand the value on unchanged.
    let outer = value.parent;
    while (
      outer !== undefined &&
      (ts.isParenthesizedExpression(outer) ||
        ts.isNonNullExpression(outer) ||
        ts.isSatisfiesExpression(outer))
    ) {
      value = outer;
      outer = outer.parent;
    }
    if (outer === undefined) {
      table.escaped = true;
      return;
    }
    // A member read by name: a primitive is the member's own value; any
    // other member is followed (readMember).
    if (ts.isPropertyAccessExpression(outer) && outer.expression === value) {
      if (isWritten(outer)) table.escaped = true;
      else if (!this.primitiveMember(subject.type, outer.name.text))
        this.readMember(outer, subject);
      return;
    }
    if (ts.isBinaryExpression(outer)) {
      const operator = outer.operatorToken.kind;
      if (isIdentityOperator(operator)) return;
      // `"name" in table` asks the object which members it has.
      if (operator === ts.SyntaxKind.InKeyword && outer.right === value) return;
      if (operator === ts.SyntaxKind.EqualsToken && outer.right === value) {
        if (this.flow(subject, this.checker.getTypeAtLocation(outer.left))) table.escaped = true;
        return;
      }
      table.escaped = true;
      return;
    }
    // `switch` compares its operand with each case by identity.
    if (ts.isCaseClause(outer) || (ts.isSwitchStatement(outer) && outer.expression === value))
      return;
    if (ts.isAsExpression(outer) || ts.isTypeAssertion(outer)) {
      if (this.flow(subject, this.checker.getTypeFromTypeNode(outer.type))) table.escaped = true;
      return;
    }
    if (
      ((ts.isCallExpression(outer) || ts.isNewExpression(outer)) && outer.expression !== value) ||
      (ts.isVariableDeclaration(outer) && outer.type !== undefined) ||
      (ts.isPropertyDeclaration(outer) && outer.type !== undefined) ||
      (ts.isParameter(outer) && outer.type !== undefined) ||
      ts.isReturnStatement(outer) ||
      (ts.isArrowFunction(outer) && outer.body === value) ||
      ts.isArrayLiteralExpression(outer) ||
      ts.isPropertyAssignment(outer)
    ) {
      // A context typed by the table's own type holds the table under an
      // inferred type: only a generic callee's type parameter is followed.
      if (
        this.flow(subject, this.checker.getContextualType(value)) &&
        !(
          (ts.isCallExpression(outer) || ts.isNewExpression(outer)) &&
          this.genericFlow(subject, outer, value)
        )
      )
        table.escaped = true;
      return;
    }
    table.escaped = true;
  }

  /** A member that is not a primitive, read through the type its literal
   * has. A nested literal is followed as a part of its table, and another
   * table named there as that table: each takes the layout of the slot that
   * holds it, so the read is typed by a literal that has that layout. An
   * object made elsewhere is in its slot as itself. A list is typed as the
   * tuple the literal wrote, which the adopted layout does not hold (its
   * slot is the structural type's array): a table read that way keeps its
   * own layout. */
  private readMember(access: ts.PropertyAccessExpression, subject: Subject): void {
    const member = memberOf(subject.literal, access.name.text);
    if (member !== undefined && ts.isObjectLiteralExpression(member)) {
      const type = this.checker.getTypeAtLocation(member);
      const own = type.getSymbol();
      if (own !== undefined) {
        const path = [...subject.path, access.name.text];
        this.useValue(access, { table: subject.table, literal: member, type, own, path });
        return;
      }
    }
    if (member === undefined || ts.isArrayLiteralExpression(member)) {
      subject.table.escaped = true;
      return;
    }
    // An object made elsewhere sits in its slot as itself (heldAsItself):
    // the read answers that object, whose uses are its own.
    const named = ts.isIdentifier(member) ? this.tableOf(member, this.found) : undefined;
    if (named === undefined) return;
    if (named.escaped) return;
    try {
      this.useValue(access, {
        table: named,
        literal: named.literal,
        type: named.type,
        own: named.own,
        path: [],
      });
    } catch {
      named.escaped = true;
    }
  }

  /** Whether each nested literal that flows somewhere by itself flows into
   * the type its slot has in `target`: the literal has that layout and no
   * other. */
  private membersFlowAs(table: Table, target: ts.Type): boolean {
    for (const flow of table.memberFlows) {
      let slot: ts.Type | undefined = target;
      for (const name of flow.path) {
        const member: ts.Symbol | undefined = this.checker.getPropertyOfType(slot, name);
        if (member === undefined) return false;
        slot = presentPart(this.checker.getTypeOfSymbol(member));
        if (slot === undefined) return false;
      }
      if (slot !== flow.target) return false;
    }
    return true;
  }

  /** One flow of a table into `target`, the type its context names.
   * Answers whether the context is typed by the table's own type (or by a
   * type parameter): then nothing converts there, and the value goes on
   * under a type the context inferred. */
  private flow(subject: Subject, target: ts.Type | undefined): boolean {
    const { table } = subject;
    if (target === undefined) {
      table.escaped = true;
      return false;
    }
    let structural: ts.Type | undefined;
    let own = false;
    for (const part of target.isUnionType() ? ts.constituentTypes(target) : [target]) {
      if ((part.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Void)) !== 0)
        continue;
      if (part.getSymbol() === subject.own || (part.flags & ts.TypeFlags.TypeParameter) !== 0) {
        own = true;
        continue;
      }
      if (this.takesAnyValue(part)) continue;
      if (!this.structural(part) || structural !== undefined) {
        table.escaped = true;
        return false;
      }
      structural = part;
    }
    if (structural !== undefined) flowsInto(subject, structural);
    return own;
  }

  /** An argument whose declared parameter type is a type parameter: the
   * callee holds the table itself and reads it through the parameter's
   * constraint, which counts as a flow into that type. Answers false when
   * the scan cannot follow the table: the parameter is declared otherwise,
   * its constraint is no structural type, or the call answers a value
   * typed by the table's own type. */
  private genericFlow(
    subject: Subject,
    call: ts.CallExpression | ts.NewExpression,
    argument: ts.Expression,
  ): boolean {
    const index = call.arguments?.nodes.indexOf(argument) ?? -1;
    const declaration = this.checker.getResolvedSignature(call)?.declaration;
    const parameter = index < 0 ? undefined : declaration?.parameters?.nodes[index];
    if (parameter?.type === undefined || parameter.dotDotDotToken !== undefined) return false;
    const declared = this.checker.getTypeFromTypeNode(parameter.type);
    if ((declared.flags & ts.TypeFlags.TypeParameter) === 0) return false;
    if (this.mentions(this.checker.getTypeAtLocation(call), subject.own, 0)) return false;
    const constraint = this.constraintOf(declared);
    if (constraint === undefined || this.takesAnyValue(constraint)) return true;
    if (!this.structural(constraint)) return false;
    flowsInto(subject, constraint);
    return true;
  }

  /** Whether `type` is, or holds as a member of a union or as a type
   * argument, the type whose symbol is `own`. */
  private mentions(type: ts.Type, own: ts.Symbol, depth: number): boolean {
    if (type.getSymbol() === own) return true;
    if (depth > 2) return false;
    if (type.isUnionType() || type.isIntersectionType())
      return ts.constituentTypes(type).some((part) => this.mentions(part, own, depth + 1));
    if ((type.flags & ts.TypeFlags.Object) === 0 || !type.isTypeReference()) return false;
    return this.checker
      .getTypeArguments(type)
      .some((argument) => this.mentions(argument, own, depth + 1));
  }

  /** Adds to `whole` the modules whose namespace import the program uses as
   * an object: handed on, enumerated, read by a computed name, destructured
   * or exported. A namespace that is only asked for members (`ns.member`, a
   * value or a type) names each export it reaches, and the scan follows
   * those mentions like any other. */
  private namespacesTakenWhole(
    spaces: ReadonlyMap<string, ts.ImportDeclaration[]>,
    mentions: readonly ts.Identifier[],
    whole: (ts.Expression | null)[],
  ): void {
    if (spaces.size === 0) return;
    const taken = new Set<ts.ImportDeclaration>();
    const bindings = new Map<ts.Symbol, ts.ImportDeclaration>();
    for (const declarations of spaces.values()) {
      for (const declaration of declarations) {
        const bound = declaration.importClause?.namedBindings;
        const symbols =
          bound !== undefined && ts.isNamespaceImport(bound) ? this.bindingSymbols(bound.name) : [];
        if (symbols.length === 0) taken.add(declaration);
        for (const symbol of symbols) bindings.set(symbol, declaration);
      }
    }
    for (const mention of mentions) {
      const parent = mention.parent;
      if (parent === undefined || asksForMember(mention, parent)) continue;
      const named = spaces.get(mention.text) ?? [];
      // An export of the binding hands the namespace to every importer.
      if (ts.isExportSpecifier(parent)) {
        const source = ts.getSourceFileOfNode(mention);
        for (const declaration of named)
          if (ts.getSourceFileOfNode(declaration) === source) taken.add(declaration);
        continue;
      }
      const symbols = this.bindingSymbols(mention);
      // A name the checker cannot resolve may be any namespace of that name.
      if (symbols.length === 0) for (const declaration of named) taken.add(declaration);
      for (const symbol of symbols) {
        const declaration = bindings.get(symbol);
        if (declaration !== undefined) taken.add(declaration);
      }
    }
    for (const declaration of taken) whole.push(declaration.moduleSpecifier);
  }

  /** The symbols an identifier stands for: the binding it names and, for an
   * import, what the import resolves to. Empty when the checker has none. */
  private bindingSymbols(name: ts.Identifier | undefined): ts.Symbol[] {
    if (name === undefined) return [];
    try {
      const parent = name.parent;
      const symbol =
        parent !== undefined && ts.isShorthandPropertyAssignment(parent)
          ? this.checker.getShorthandAssignmentValueSymbol(parent)
          : this.checker.getSymbolAtLocation(name);
      if (symbol === undefined) return [];
      if ((symbol.flags & ts.SymbolFlags.Alias) === 0) return [symbol];
      return [symbol, this.checker.getAliasedSymbol(symbol)];
    } catch {
      return [];
    }
  }

  /** The source files of the modules the program takes as whole objects;
   * null when one of them is named at run time. */
  private sourcesOf(specifiers: readonly (ts.Expression | null)[]): Set<ts.SourceFile> | null {
    const sources = new Set<ts.SourceFile>();
    for (const specifier of specifiers) {
      if (specifier === null) return null;
      try {
        const module = this.checker.getSymbolAtLocation(specifier);
        if (module === undefined) return null;
        for (const declaration of module.declarations)
          if (ts.isSourceFile(declaration)) sources.add(declaration);
      } catch {
        return null;
      }
    }
    return sources;
  }

  /** The declared constraint of a type parameter (`T extends Shape`). */
  private constraintOf(parameter: ts.Type): ts.Type | undefined {
    for (const declaration of parameter.getSymbol()?.declarations ?? [])
      if (ts.isTypeParameterDeclaration(declaration) && declaration.constraint !== undefined)
        return this.checker.getTypeFromTypeNode(declaration.constraint);
    return undefined;
  }

  /** `unknown`, `any`, `object`, `{}` or a type parameter: a slot that
   * holds the value itself, whatever its layout. */
  private takesAnyValue(type: ts.Type): boolean {
    if (
      (type.flags &
        (ts.TypeFlags.Any |
          ts.TypeFlags.Unknown |
          ts.TypeFlags.NonPrimitive |
          ts.TypeFlags.TypeParameter)) !==
      0
    )
      return true;
    return (
      (type.flags & ts.TypeFlags.Object) !== 0 &&
      this.checker.getPropertiesOfType(type).length === 0 &&
      this.checker.getCallSignatures(type).length === 0 &&
      this.checker.getConstructSignatures(type).length === 0 &&
      this.checker.getIndexInfosOfType(type).length === 0
    );
  }

  /** An interface or object type the program declares: a record layout. */
  private structural(type: ts.Type): boolean {
    if ((type.flags & ts.TypeFlags.Object) === 0) return false;
    if (this.checker.isArrayType(type) || this.checker.isTupleType(type)) return false;
    if (this.checker.getCallSignatures(type).length > 0) return false;
    if (this.checker.getConstructSignatures(type).length > 0) return false;
    if (this.checker.getIndexInfosOfType(type).length > 0) return false;
    const symbol = type.getSymbol();
    if (symbol === undefined) return false;
    if ((symbol.flags & (ts.SymbolFlags.Interface | ts.SymbolFlags.TypeLiteral)) === 0)
      return false;
    return (
      symbol.declarations.length > 0 &&
      symbol.declarations.every(
        (declaration) => !ts.getSourceFileOfNode(declaration).isDeclarationFile,
      )
    );
  }

  /** Whether the member `name` of a literal's own type is a primitive. */
  private primitiveMember(type: ts.Type, name: string): boolean {
    const member = this.checker.getPropertyOfType(type, name);
    return member !== undefined && primitive(this.checker.getTypeOfSymbol(member));
  }

  /** Whether the layout of `target` holds the value `literal` builds: every
   * member is a data member the target declares; a primitive sits in a
   * primitive slot, a nested literal or a named table in a slot of one
   * structural type, a list in an array slot whose element holds each
   * element the same way. Collects what the nested literals and the named
   * tables take (Fit). */
  private fits(literal: ts.ObjectLiteralExpression, target: ts.Type, fit: Fit): boolean {
    for (const property of literal.properties.nodes) {
      if (!ts.isPropertyAssignment(property)) return false;
      const name = property.name;
      if (!ts.isIdentifier(name) && !ts.isStringLiteral(name)) return false;
      const slot = this.checker.getPropertyOfType(target, name.text);
      if (slot === undefined) return false;
      if ((slot.flags & (ts.SymbolFlags.Method | ts.SymbolFlags.Accessor)) !== 0) return false;
      if (!this.fitsSlot(property.initializer, this.checker.getTypeOfSymbol(slot), fit))
        return false;
    }
    return true;
  }

  /** One member or element value against the type of its slot. */
  private fitsSlot(node: ts.Expression, declared: ts.Type, fit: Fit): boolean {
    const value = withoutParentheses(node);
    const literal = ts.isObjectLiteralExpression(value) || ts.isArrayLiteralExpression(value);
    // A primitive, however it is computed, is held by value in every
    // layout that has a primitive slot for it.
    const type = literal ? undefined : this.checker.getTypeAtLocation(value);
    if (type !== undefined && primitive(type)) return primitive(declared);
    const named = ts.isIdentifier(value) ? this.tableOf(value, this.found) : undefined;
    // An object made elsewhere (a binding of a declared type, a call's
    // result, a function, a class instance) is held as itself.
    if (type !== undefined && named === undefined) return heldAsItself(type, declared);
    const slot = presentPart(declared);
    if (slot === undefined) return false;
    // Another table by name.
    if (named !== undefined) {
      if (!this.structural(slot)) return false;
      fit.slots.set(value, slot);
      return true;
    }
    if (ts.isObjectLiteralExpression(value)) {
      if (!this.structural(slot)) return false;
      const own = this.checker.getTypeAtLocation(value).getSymbol();
      if (own === undefined || (own.flags & ts.SymbolFlags.ObjectLiteral) === 0) return false;
      fit.nested.set(own, slot);
      return this.fits(value, slot, fit);
    }
    if (ts.isArrayLiteralExpression(value)) {
      if (!this.checker.isArrayType(slot)) return false;
      const element = this.checker.getTypeArguments(slot as ts.TypeReference)[0];
      if (element === undefined) return false;
      return value.elements.nodes.every((item) => this.fitsSlot(item, element, fit));
    }
    return false;
  }

  /** Answers whether the program compares values of a structural type by
   * identity: an operand of `===` or `switch`, a key of a Map or Set, the
   * needle of an array search, of that type, of the table's own type, or of
   * a type that takes any value. */
  private identityObserved(
    compared: readonly ts.Expression[],
    keyed: readonly ts.Expression[],
  ): (types: Iterable<ts.Type>, own: ts.Symbol) => boolean {
    const symbols = new Set<ts.Symbol>();
    let any = false;
    const note = (type: ts.Type | undefined, depth = 0): void => {
      if (type === undefined || any || depth > 3) return;
      if (type.isUnionType()) {
        for (const part of ts.constituentTypes(type)) note(part, depth + 1);
        return;
      }
      if (primitive(type)) return;
      if (this.takesAnyValue(type)) {
        any = true;
        return;
      }
      const symbol = type.getSymbol();
      if (symbol !== undefined) symbols.add(symbol);
      // A list of tables is a member of the table that holds it: comparing
      // two lists tells a copied table from the table too.
      if (this.checker.isArrayType(type))
        note(this.checker.getTypeArguments(type as ts.TypeReference)[0], depth + 1);
    };
    this.checker.prefetchTypeQueries([...compared, ...keyed]);
    for (const operand of compared) {
      try {
        note(this.checker.getTypeAtLocation(operand));
      } catch {
        any = true;
      }
    }
    // A collection observes its key type: the first type argument.
    for (const collection of keyed) {
      try {
        const type = this.checker.getTypeAtLocation(collection);
        for (const part of type.isUnionType() ? ts.constituentTypes(type) : [type])
          note(this.checker.getTypeArguments(part)[0]);
      } catch {
        any = true;
      }
    }
    return (types, own) => {
      if (any || symbols.has(own)) return true;
      for (const type of types) {
        const symbol = type.getSymbol();
        if (symbol !== undefined && symbols.has(symbol)) return true;
      }
      return false;
    };
  }
}

/** One flow of `subject` into the structural type `target`. */
function flowsInto(subject: Subject, target: ts.Type): void {
  if (subject.path.length === 0) subject.table.targets.add(target);
  else subject.table.memberFlows.push({ path: subject.path, target });
}

/** Whether a slot declared as `declared` holds a value of `type` as the
 * object it is: everything the value can be is one of the things the slot
 * declares, so building the literal converts nothing and a read through the
 * table's own type only narrows the slot. A value of any other type the
 * slot accepts (a record with more members, a class instance for an
 * interface) would be copied into the slot's layout when the literal is
 * built, where the program could tell it from the object. */
function heldAsItself(type: ts.Type, declared: ts.Type): boolean {
  const slots = new Set(declared.isUnionType() ? ts.constituentTypes(declared) : [declared]);
  const absent = ts.TypeFlags.Undefined | ts.TypeFlags.Null;
  return (type.isUnionType() ? ts.constituentTypes(type) : [type]).every(
    (part) => (part.flags & absent) !== 0 || slots.has(part),
  );
}

/** A slot's one type besides `undefined` and `null`. */
function presentPart(declared: ts.Type): ts.Type | undefined {
  let slot: ts.Type | undefined;
  for (const part of declared.isUnionType() ? ts.constituentTypes(declared) : [declared]) {
    if ((part.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)) !== 0) continue;
    if (slot !== undefined) return undefined;
    slot = part;
  }
  return slot;
}

/** The value a literal gives its member `name`. */
function memberOf(literal: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  for (const property of literal.properties.nodes) {
    if (!ts.isPropertyAssignment(property)) continue;
    if (!ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name)) continue;
    if (property.name.text === name) return withoutParentheses(property.initializer);
  }
  return undefined;
}

/** The operands the program compares by identity (`compared`) and the
 * collections and arrays whose keys or elements it looks up (`keyed`). */
function observeIdentity(node: ts.Node, compared: ts.Expression[], keyed: ts.Expression[]): void {
  if (ts.isBinaryExpression(node)) {
    if (
      isIdentityOperator(node.operatorToken.kind) &&
      !primitiveLiteral(node.left) &&
      !primitiveLiteral(node.right)
    )
      compared.push(node.left, node.right);
    return;
  }
  if (ts.isSwitchStatement(node)) {
    const cases: ts.Expression[] = [];
    for (const clause of node.caseBlock.clauses.nodes)
      if (ts.isCaseClause(clause) && !primitiveLiteral(clause.expression))
        cases.push(clause.expression);
    if (cases.length > 0) compared.push(node.expression, ...cases);
    return;
  }
  if (ts.isNewExpression(node)) {
    if (ts.isIdentifier(node.expression) && KEYED_COLLECTIONS.has(node.expression.text))
      keyed.push(node);
    return;
  }
  if (!ts.isCallExpression(node)) return;
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee)) return;
  const first = node.arguments.nodes[0];
  if (KEY_METHODS.has(callee.name.text)) {
    if (first !== undefined && !ts.isSpreadElement(first) && !primitiveLiteral(first))
      compared.push(first);
    keyed.push(callee.expression);
  } else if (
    callee.name.text === "is" &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === "Object"
  ) {
    for (const argument of node.arguments.nodes)
      if (!ts.isSpreadElement(argument)) compared.push(argument);
  }
}

/** The namespace imports of the program (`import * as ns from "m"`), by the
 * name each binds. */
function namespaceImports(sources: readonly ts.SourceFile[]): Map<string, ts.ImportDeclaration[]> {
  const spaces = new Map<string, ts.ImportDeclaration[]>();
  for (const source of sources) {
    if (source.isDeclarationFile) continue;
    for (const statement of source.statements.nodes) {
      if (!ts.isImportDeclaration(statement)) continue;
      const bindings = statement.importClause?.namedBindings;
      if (bindings === undefined || !ts.isNamespaceImport(bindings)) continue;
      const named = spaces.get(bindings.name.text);
      if (named === undefined) spaces.set(bindings.name.text, [statement]);
      else named.push(statement);
    }
  }
  return spaces;
}

/** Whether a mention of a namespace's name asks the namespace for a member
 * (`ns.member`, `ns.Type`), or is no use of a namespace at all: the import
 * that binds it, a member's or a property's own name. */
function asksForMember(mention: ts.Identifier, parent: ts.Node): boolean {
  if (ts.isPropertyAccessExpression(parent) || ts.isQualifiedName(parent)) return true;
  if (ts.isNamespaceImport(parent) || ts.isImportSpecifier(parent) || ts.isImportClause(parent))
    return true;
  return ts.isPropertyAssignment(parent) && parent.name === mention;
}

/** Notes the module a node takes as a whole object: `export *`,
 * `import("m")`, `require("m")`. A namespace import is judged by its uses
 * (namespacesTakenWhole). */
function wholeModule(node: ts.Node, modules: (ts.Expression | null)[]): void {
  if (ts.isExportDeclaration(node)) {
    if (
      node.moduleSpecifier !== undefined &&
      (node.exportClause === undefined || ts.isNamespaceExport(node.exportClause))
    )
      modules.push(node.moduleSpecifier);
  } else if (ts.isCallExpression(node)) {
    const callee = node.expression;
    if (
      callee.kind !== ts.SyntaxKind.ImportKeyword &&
      !(ts.isIdentifier(callee) && callee.text === "require")
    )
      return;
    const specifier = node.arguments.nodes[0];
    modules.push(specifier !== undefined && ts.isStringLiteralLike(specifier) ? specifier : null);
  }
}

function isIdentityOperator(kind: ts.SyntaxKind): boolean {
  return (
    kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
    kind === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
    kind === ts.SyntaxKind.EqualsEqualsToken ||
    kind === ts.SyntaxKind.ExclamationEqualsToken
  );
}

/** A literal that is never an object: a comparison with it observes no
 * identity. */
function primitiveLiteral(node: ts.Expression): boolean {
  const value = withoutParenthesesNonNull(node);
  switch (value.kind) {
    case ts.SyntaxKind.StringLiteral:
    case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
    case ts.SyntaxKind.TemplateExpression:
    case ts.SyntaxKind.NumericLiteral:
    case ts.SyntaxKind.BigIntLiteral:
    case ts.SyntaxKind.TrueKeyword:
    case ts.SyntaxKind.FalseKeyword:
    case ts.SyntaxKind.NullKeyword:
    case ts.SyntaxKind.TypeOfExpression:
      return true;
    default:
      return ts.isIdentifier(value) && value.text === "undefined";
  }
}

/** A string, number, boolean, bigint, null or undefined type, or a union of
 * them: a value held by value in every layout. */
function primitive(type: ts.Type): boolean {
  if (type.isUnionType()) return ts.constituentTypes(type).every(primitive);
  return (
    (type.flags &
      (ts.TypeFlags.StringLike |
        ts.TypeFlags.NumberLike |
        ts.TypeFlags.BooleanLike |
        ts.TypeFlags.BigIntLike |
        ts.TypeFlags.Undefined |
        ts.TypeFlags.Null |
        ts.TypeFlags.Void)) !==
    0
  );
}

/** Whether a literal is plain data a layout can take member by member:
 * named members whose values are nested literals of the same kind, lists of
 * such values, or other expressions (a primitive, another table by name, an
 * object made elsewhere). No computed name, spread, method or function
 * written in the literal. */
function plainTable(literal: ts.ObjectLiteralExpression): boolean {
  if (literal.properties.nodes.length === 0) return false;
  return literal.properties.nodes.every((property) => {
    if (!ts.isPropertyAssignment(property)) return false;
    if (!ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name)) return false;
    return plainValue(property.initializer, true);
  });
}

function plainValue(node: ts.Expression, lists: boolean): boolean {
  const value = withoutParentheses(node);
  if (ts.isObjectLiteralExpression(value)) return plainTable(value);
  if (ts.isArrayLiteralExpression(value))
    return (
      lists &&
      value.elements.nodes.every(
        (item) =>
          !ts.isSpreadElement(item) && !ts.isOmittedExpression(item) && plainValue(item, false),
      )
    );
  // Any other expression is a leaf: a primitive by its type, another table
  // by name, or an object made elsewhere (fitsSlot).
  return !ts.isFunctionLike(value) && !ts.isClassExpression(value);
}

/** The table whose literal holds `mention` as a member or a list element. */
function containingTable(mention: ts.Identifier, literals: Map<ts.Node, Table>): Table | undefined {
  let node: ts.Node = mention;
  for (;;) {
    const parent: ts.Node | undefined = node.parent;
    if (parent === undefined) return undefined;
    if (ts.isPropertyAssignment(parent)) {
      if (parent.initializer !== node) return undefined;
    } else if (ts.isObjectLiteralExpression(parent)) {
      const table = literals.get(parent);
      if (table !== undefined) return table;
    } else if (!ts.isArrayLiteralExpression(parent) && !ts.isParenthesizedExpression(parent)) {
      return undefined;
    }
    node = parent;
  }
}

/** `access` is the target of an assignment, an update or a `delete`. */
function isWritten(access: ts.Expression): boolean {
  const parent = access.parent;
  if (parent === undefined) return false;
  if (ts.isBinaryExpression(parent)) {
    const operator = parent.operatorToken.kind;
    return (
      parent.left === access &&
      operator >= ts.SyntaxKind.FirstAssignment &&
      operator <= ts.SyntaxKind.LastAssignment
    );
  }
  if (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent))
    return (
      parent.operator === ts.SyntaxKind.PlusPlusToken ||
      parent.operator === ts.SyntaxKind.MinusMinusToken
    );
  return ts.isDeleteExpression(parent);
}
