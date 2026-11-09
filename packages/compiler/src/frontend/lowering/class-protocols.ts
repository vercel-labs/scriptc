import * as ts from "../ts7/adapter.js";
import {
  activeNodeIslands,
  isForeignType,
  type NodeIslandSet,
} from "../../node-islands/boundary.js";
import { extendsElementOf } from "../heritage-elements.js";
import { bindsIslandExport } from "./lower-node-island.js";

/** Index only program classes. Ambient declarations describe APIs, not
 * compiled implementations, and must not change a protocol's storage. */
export class ClassProtocols {
  private implemented: Set<ts.Symbol> | null = null;
  private readonly methods = new Map<string, ts.ClassLikeDeclaration[]>();
  private readonly answers = new Map<ts.Type, boolean>();
  /** The program classes each Pick or Omit view accepts (classesAcceptedBy). */
  private readonly accepted = new Map<ts.Type, ts.Symbol[]>();
  /** copiedArgument's answers, per call and argument position. */
  private readonly copiedArguments = new Map<ts.CallExpression | ts.NewExpression, boolean[]>();
  /** What markIdentityFlows learned about the program, while it runs. */
  private facts: FlowFacts | null = null;
  /** The value types of the string-keyed dictionaries that keep checked
   * identity (see markDictionaryViews). */
  private readonly dictionaryViews = new Set<ts.Type>();
  /** The structural types a lib Map or Set flows into while it answers one
   * of their members (see markIdentityFlows). They keep checked identity
   * without protocol dispatch: their members are invoked on the collection
   * itself, not read from a property bag. */
  private readonly collectionViews = new Set<ts.Symbol>();
  /** The mapped views a receiver-dependent literal is used as, whose source
   * cannot carry the marking (see index). */
  private readonly literalViews = new Set<ts.Type>();
  /** The program types that receive island values and cannot carry the
   * marking on a symbol, recorded by the type itself (see markIslandView). */
  private readonly islandViews = new Set<ts.Type>();
  /** islandValue's answers: which expressions read an island handle. */
  private readonly islandValues = new Map<ts.Node, boolean>();
  /** The names each file's imports and `require` declarations bind
   * (importBoundNames): only those can bind an island module's export. */
  private readonly importNames = new Map<ts.SourceFile, ReadonlySet<string>>();
  /** islandSubclass's answers, per class declaration. */
  private readonly islandSubclasses = new Map<ts.Node, boolean>();
  /** The parameters a call passes an island value to, and the functions that
   * return one, where the type is `any` or `unknown` (followIslandFlows). */
  private readonly islandParameters = new Set<ts.Symbol>();
  private readonly islandReturners = new Set<ts.Symbol>();
  /** The untyped island values stored out of the analysis' sight
   * (noteIslandEscapes). */
  private readonly islandEscapes: ts.Expression[] = [];
  /** The object types markReceivedView has answered for, so a type that
   * names itself in a member (`interface Node { next?: Node }`) ends. */
  private readonly receivedTypes = new Set<ts.Type>();

  constructor(
    private readonly checker: ts.TypeChecker,
    private readonly sources: readonly ts.SourceFile[],
    /** True for the standard library's declaration files: a type any other
     * declaration file declares is a data type the program takes from a
     * file with no implementation (markUnplacedConversions). */
    private readonly isStdlibFile: (file: ts.SourceFile) => boolean,
  ) {}

  private index(): Set<ts.Symbol> {
    if (this.implemented !== null) return this.implemented;
    const protocols = new Set<ts.Symbol>();
    this.implemented = protocols;
    const add = (type: ts.Type): void => {
      // A homomorphic mapped view's own symbol is the shared mapped
      // `__type` that every mapped type in the program uses: marking it
      // would make every Pick, Omit, Partial and Readonly a view. Mark the
      // type the view maps instead when that is a structural type. A source
      // that cannot carry the marking keeps its own representation: a class
      // instance would make every instance a view, and an intersection has
      // no symbol. The VIEW type itself is recorded for those, so a
      // receiver-dependent literal typed as it still keeps checked identity
      // and protocol answers it through that record.
      const mapped = this.mappedViewSource(type);
      if (mapped !== null) {
        if (!this.isStructuralTarget(mapped)) {
          this.literalViews.add(type);
          return;
        }
        type = mapped;
      }
      const symbol = type.getSymbol();
      if (!symbol || protocols.has(symbol)) return;
      protocols.add(symbol);
      const target = type.isTypeReference() ? type.getTarget() : type;
      if (target?.isClassOrInterface()) this.checker.getBaseTypes(target).forEach(add);
    };
    const usesReceiver = (node: ts.Node): boolean =>
      node.kind === ts.SyntaxKind.ThisKeyword || ts.forEachChild(node, usesReceiver) === true;
    // The names any type in the program declares as a get/set accessor, and
    // every object literal in it. A data member of a literal can only
    // disagree with a target at a name in this set, and marking waits until
    // the walk ends, so the checker round trip stays off every literal whose
    // names are not accessors somewhere (this analysis runs on every
    // program, so it must stay syntax-cheap).
    const accessorNames = new Set<string>();
    const literals: ts.ObjectLiteralExpression[] = [];
    // The expressions that may read a value out of an island handle, when the
    // program runs islands at all: their declared types are marked once the
    // walk ends (markIslandView).
    const islands = activeNodeIslands();
    const sites: ts.Node[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
        const name = propertyNameText(node.name);
        if (name !== null) accessorNames.add(name);
      }
      // The nodes an island value can be read, asserted, handed over or
      // passed on at: they are judged once the walk ends, when the flows
      // through the program's own functions are known (markIslandSites).
      if (
        islands !== null &&
        (ts.isPropertyAccessExpression(node) ||
          ts.isElementAccessExpression(node) ||
          ts.isCallExpression(node) ||
          ts.isNewExpression(node) ||
          ts.isAssertionExpression(node) ||
          (ts.isIdentifier(node) && this.importBound(node)) ||
          ts.isReturnStatement(node) ||
          ts.isArrowFunction(node) ||
          ts.isVariableDeclaration(node) ||
          ts.isPropertyDeclaration(node) ||
          ts.isObjectLiteralExpression(node) ||
          ts.isArrayLiteralExpression(node) ||
          (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken))
      )
        sites.push(node);
      if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
        for (const clause of node.heritageClauses?.nodes ?? [])
          if (clause.token === ts.SyntaxKind.ImplementsKeyword)
            for (const protocol of clause.types.nodes)
              add(this.checker.getTypeAtLocation(protocol));
        const symbol = node.name ? this.checker.getSymbolAtLocation(node.name) : undefined;
        const instance = symbol ? this.checker.getDeclaredTypeOfSymbol(symbol) : undefined;
        for (const property of instance ? this.checker.getPropertiesOfType(instance) : []) {
          if (
            !property.declarations.some(
              (member) =>
                ts.isMethodDeclaration(member) &&
                !member.modifiers?.nodes.some(
                  (modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword,
                ),
            )
          )
            continue;
          const entries = this.methods.get(ts.symbolName(property)) ?? [];
          entries.push(node);
          this.methods.set(ts.symbolName(property), entries);
        }
      }
      if (ts.isObjectLiteralExpression(node)) {
        if (
          node.properties.nodes.some(
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
        // Member-kind disagreements with the literal's target type are
        // checked once the walk ends, when the accessor-name index above is
        // complete (see markMemberKindViews).
        literals.push(node);
      }
      ts.forEachChild(node, visit);
    };
    for (const source of this.sources) if (!source.isDeclarationFile) visit(source);
    for (const literal of literals) this.markMemberKindViews(literal, accessorNames, add);
    if (islands !== null) this.markIslandSites(sites, islands, add);
    this.markIdentityFlows(protocols);
    return protocols;
  }

  /** Judges the nodes of the program an island value can pass through
   * (collected by index) and marks the types that receive one.
   *
   * A crossing is a node whose declared type receives an island value: a
   * member read, an index or a call on an island value; a name bound to an
   * island module's export, read as a value (the island's value at each use,
   * whatever type the program's declarations give it); and an assertion
   * applied to an island value (`raw() as Item`, `raw() as unknown as Item`).
   * The assertion names the type the program reads that value through. It
   * has no run-time effect in Node, so it is a view of the island's object
   * like any typed island read, never a copy: a record is made only where
   * the program copies (`structuredClone`, a spread, JSON).
   *
   * What the program hands to an island (an argument of an island call or
   * construction, a value assigned to a member of an island object) holds the
   * functions the island calls with its own values (markIslandCallbacks). */
  private markIslandSites(
    sites: readonly ts.Node[],
    islands: NodeIslandSet,
    add: (type: ts.Type) => void,
  ): void {
    this.followIslandFlows(sites, islands);
    const crossings: ts.Expression[] = [];
    const handed: ts.Expression[] = [];
    for (const node of sites) {
      if (ts.isIdentifier(node)) {
        if (this.islandBinding(node, islands)) crossings.push(node);
        continue;
      }
      if (
        ts.isReturnStatement(node) ||
        ts.isArrowFunction(node) ||
        ts.isVariableDeclaration(node) ||
        ts.isPropertyDeclaration(node) ||
        ts.isObjectLiteralExpression(node) ||
        ts.isArrayLiteralExpression(node)
      )
        continue;
      if (ts.isBinaryExpression(node)) {
        if (
          (ts.isPropertyAccessExpression(node.left) || ts.isElementAccessExpression(node.left)) &&
          this.islandValue(node.left.expression, islands)
        )
          handed.push(node.right);
        continue;
      }
      if (ts.isAssertionExpression(node)) {
        if (this.islandValue(node.expression, islands)) crossings.push(node);
        continue;
      }
      if (ts.isNewExpression(node)) {
        if (this.islandValue(node.expression, islands))
          for (const argument of node.arguments?.nodes ?? []) handed.push(argument);
        continue;
      }
      const access = node as
        | ts.PropertyAccessExpression
        | ts.ElementAccessExpression
        | ts.CallExpression;
      if (ts.isCallExpression(access) && this.islandValue(access.expression, islands))
        for (const argument of access.arguments.nodes) handed.push(argument);
      // A call of a program function that hands on an island value answers
      // one too (followIslandFlows); its callee is not an island value.
      if (this.islandValue(access, islands)) crossings.push(access);
    }
    // An island read marks every type it reaches, as it always has: the read
    // the island's own declarations type, and equally the read whose value
    // the island makes under a type of the program's (a name bound to an
    // island export, a member of a native subclass of an island class), which
    // had no other form than a refusal. The origins where the program GIVES
    // an untyped island value a type (an assertion, the typed slot an `any`
    // value is put in, a parameter of a function handed to the island) are
    // conversions on main: they mark a type only when a view can hold all it
    // declares (markOriginView), and they come last, so that the outcome does
    // not depend on the order in which the program's files name a type.
    const given: ts.Expression[] = [];
    for (const crossing of crossings) {
      if (ts.isAssertionExpression(crossing)) {
        given.push(crossing);
        continue;
      }
      this.markIslandView(crossing, islands, add);
      const type = attempt(() => this.checker.getTypeAtLocation(crossing));
      if (type !== undefined && (type.flags & ts.TypeFlags.Any) !== 0) given.push(crossing);
    }
    for (const crossing of given) {
      const type = attempt(() => this.checker.getTypeAtLocation(crossing));
      if (ts.isAssertionExpression(crossing)) {
        if (type !== undefined) this.markOriginView(type, islands, add, 0);
      } else {
        // An untyped island value takes the type of the slot it is put in (a
        // typed binding, a parameter, a return): that type receives it.
        const slot = attempt(() => this.checker.getContextualType(crossing));
        if (slot !== undefined) this.markOriginView(slot, islands, add, 0);
      }
    }
    for (const value of handed) this.markIslandCallbacks(value, islands, add, 0);
    traceIslandViews(crossings);
    for (const node of sites) this.noteIslandEscapes(node, islands);
    if (this.islandEscapes.length > 0) this.markUnplacedConversions(sites, islands, add);
  }

  /** Marks the declaration-file types an untyped value of unknown origin is
   * given, in a program that stores an untyped island value out of sight
   * (noteIslandEscapes found a store). The stored value is read back with no
   * origin, so any assertion applied to an untyped value, and any typed
   * binding of an `any`, may be the one that receives it. A type a
   * declaration file declares has no implementation of its own: until such
   * types were mapped to native records, a value asserted to one stayed the
   * dynamic value it was, an island's object included. Marking the type a
   * view keeps that: the island's object stays the island's, and a native
   * value under the type is read with the same checks. A type the program's
   * own source declares keeps the checked conversion, as it always had (it
   * copies an island's object; SC6007 names the store). */
  private markUnplacedConversions(
    sites: readonly ts.Node[],
    islands: NodeIslandSet,
    add: (type: ts.Type) => void,
  ): void {
    for (const node of sites) {
      let operand: ts.Expression;
      let untyped: number = ts.TypeFlags.Any;
      if (ts.isAssertionExpression(node)) {
        operand = node.expression;
        untyped |= ts.TypeFlags.Unknown;
      } else if (
        ts.isVariableDeclaration(node) &&
        node.type !== undefined &&
        node.initializer !== undefined
      ) {
        operand = node.initializer;
      } else continue;
      // An island value the analysis follows was marked where it crossed.
      if (this.islandValue(operand, islands)) continue;
      const from = attempt(() => this.checker.getTypeAtLocation(operand));
      if (from === undefined || (from.flags & untyped) === 0) continue;
      const target = attempt(() => this.checker.getTypeAtLocation(node));
      if (target === undefined || !this.declarationFileType(target, 0)) continue;
      this.markOriginView(target, islands, add, 0);
    }
  }

  /** Whether `type`, an arm of it or its element type is an object type
   * whose every declaration is in a declaration file outside the standard
   * library. */
  private declarationFileType(type: ts.Type, depth: number): boolean {
    if (depth > DECLARATION_FILE_TYPE_DEPTH) return false;
    if (type.isUnionType() || type.isIntersectionType())
      return ts.constituentTypes(type).some((part) => this.declarationFileType(part, depth + 1));
    if ((type.flags & ts.TypeFlags.Object) === 0) return false;
    if (this.checker.isArrayType(type) || this.checker.isTupleType(type)) {
      const elements = attempt(() => this.checker.getTypeArguments(type as ts.TypeReference));
      return (elements ?? []).some((element) => this.declarationFileType(element, depth + 1));
    }
    const declarations = type.getSymbol()?.declarations ?? [];
    return (
      declarations.length > 0 &&
      declarations.every((declaration) => {
        const file = ts.getSourceFileOfNode(declaration);
        return file.isDeclarationFile && !this.isStdlibFile(file);
      })
    );
  }

  /** The untyped island values the program stores where their origin is no
   * longer followed (see noteIslandEscapes), in source order. */
  islandEscapeSites(): readonly ts.Expression[] {
    this.index();
    return this.islandEscapes;
  }

  /** Whether `expr` holds a value a Node island made, as this analysis
   * follows it (islandValue): the divergence scan asks it of the operand of
   * a conversion that copies (SC6007), so that the warning sees every origin
   * the marking does. False for a program that runs no island. */
  islandOrigin(expr: ts.Expression): boolean {
    this.index();
    const islands = activeNodeIslands();
    return islands !== null && this.islandValue(expr, islands);
  }

  /** Records the untyped island values `node` stores out of the analysis'
   * sight. An island value typed `any` or `unknown` is followed through
   * `const` bindings, parameters and returns of the program's functions, and
   * where it is asserted it becomes a view. Stored in a member, an element, a
   * reassigned binding, a literal the program keeps or a container (an
   * argument whose declared type is a type parameter: `list.push(v)`,
   * `map.set(k, v)`, `keep<T>(v)`), it is read back as a value of unknown
   * origin, and an assertion applied to it then is the checked conversion,
   * which copies an island's object. The build names each such store
   * (SC6007, divergences.ts). */
  private noteIslandEscapes(node: ts.Node, islands: NodeIslandSet): void {
    const note = (value: ts.Expression | undefined, stored: () => boolean): void => {
      if (value === undefined || !this.islandValue(value, islands)) return;
      const type = attempt(() => this.checker.getTypeAtLocation(value));
      if (type === undefined || (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) === 0)
        return;
      if (stored()) this.islandEscapes.push(value);
    };
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      if (this.islandValue(node.expression, islands) || isStructuredClone(node)) return;
      const args = node.arguments?.nodes ?? [];
      for (let index = 0; index < args.length; index++) {
        const argument = args[index]!;
        if (ts.isSpreadElement(argument)) break;
        note(argument, () => this.argumentKept(node, index));
      }
    } else if (ts.isBinaryExpression(node)) {
      const target = node.left;
      if (
        (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) &&
        this.islandValue(target.expression, islands)
      )
        return;
      note(node.right, () => true);
    } else if (ts.isVariableDeclaration(node)) {
      const held =
        ts.isIdentifier(node.name) && (ts.getCombinedNodeFlags(node) & ts.NodeFlags.Const) !== 0;
      if (!held) note(node.initializer, () => true);
    } else if (ts.isPropertyDeclaration(node)) {
      note(node.initializer, () => true);
    } else if (ts.isObjectLiteralExpression(node)) {
      for (const property of node.properties.nodes) {
        const value = ts.isPropertyAssignment(property)
          ? property.initializer
          : ts.isShorthandPropertyAssignment(property)
            ? (property.name as ts.Identifier)
            : ts.isSpreadAssignment(property)
              ? property.expression
              : undefined;
        note(value, () => !this.handedToIsland(node, islands));
      }
    } else if (ts.isArrayLiteralExpression(node)) {
      for (const element of node.elements.nodes)
        note(ts.isSpreadElement(element) ? element.expression : element, () => {
          return !this.handedToIsland(node, islands);
        });
    } else if (ts.isReturnStatement(node)) {
      note(node.expression, () => this.functionSymbolOf(node) === undefined);
    } else if (ts.isArrowFunction(node) && !ts.isBlock(node.body)) {
      note(node.body, () => this.functionSymbolOf(node) === undefined);
    }
  }

  /** Whether the callee of `call` may keep its argument at `index`: the
   * parameter's declared type names a type parameter, of the function or of
   * the class or interface that declares it, so the callee stores the value
   * or hands it back at a type the caller chose (`Array<T>.push`,
   * `Map<K, V>.set`, a generic helper). A parameter with a type of its own
   * converts the value, and an untyped one of a program function is followed
   * (followIslandFlows). */
  private argumentKept(call: ts.CallExpression | ts.NewExpression, index: number): boolean {
    const declaration = attempt(() => this.checker.getResolvedSignature(call))?.declaration;
    if (declaration === undefined || !ts.isFunctionLike(declaration)) return false;
    const parameters = declaration.parameters.nodes;
    const last = parameters.at(-1);
    const parameter =
      parameters[index] ??
      (last !== undefined && last.dotDotDotToken !== undefined ? last : undefined);
    if (parameter === undefined || parameter.type === undefined) return false;
    const names = new Set<string>();
    for (let scope: ts.Node | undefined = declaration; scope !== undefined; scope = scope.parent) {
      const declared =
        ts.isFunctionLike(scope) ||
        ts.isClassDeclaration(scope) ||
        ts.isClassExpression(scope) ||
        ts.isInterfaceDeclaration(scope)
          ? scope.typeParameters
          : undefined;
      for (const typeParameter of declared?.nodes ?? []) names.add(typeParameter.name.text);
    }
    if (names.size === 0) return false;
    const mentions = (type: ts.Node): boolean =>
      (ts.isIdentifier(type) && names.has(type.text)) || ts.forEachChild(type, mentions) === true;
    return mentions(parameter.type);
  }

  /** Whether the literal `literal`, or the literal it is a member of, is
   * handed to an island where it stands: an argument of an island call or
   * construction, or a value assigned to a member of an island object. The
   * island then holds what the literal holds. */
  private handedToIsland(
    literal: ts.ObjectLiteralExpression | ts.ArrayLiteralExpression,
    islands: NodeIslandSet,
  ): boolean {
    let value: ts.Node = literal;
    for (;;) {
      const parent: ts.Node | undefined = value.parent;
      if (parent === undefined) return false;
      if (
        ts.isParenthesizedExpression(parent) ||
        ts.isAssertionExpression(parent) ||
        ts.isSatisfiesExpression(parent) ||
        ts.isPropertyAssignment(parent) ||
        ts.isSpreadElement(parent) ||
        ts.isSpreadAssignment(parent) ||
        ts.isObjectLiteralExpression(parent) ||
        ts.isArrayLiteralExpression(parent)
      ) {
        value = parent;
        continue;
      }
      if (ts.isCallExpression(parent) || ts.isNewExpression(parent))
        return parent.expression !== value && this.islandValue(parent.expression, islands);
      if (
        ts.isBinaryExpression(parent) &&
        parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        parent.right === value
      ) {
        const target = parent.left;
        return (
          (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) &&
          this.islandValue(target.expression, islands)
        );
      }
      return false;
    }
  }

  /** Follows island values through the program's own functions, where the
   * type says nothing about them: a parameter typed `any` or `unknown` that
   * a call passes an island value to holds one (`asItem(raw())` with
   * `function asItem(value: unknown)`), and a function that returns an
   * island value at one of those types answers one. Both sets only grow, and
   * each round judges every call and return again with what the previous one
   * found, until a round finds nothing. A value stored in a field, an
   * element or a reassigned binding is not followed: its origin is not
   * visible where it is read back. */
  private followIslandFlows(sites: readonly ts.Node[], islands: NodeIslandSet): void {
    const untyped = (node: ts.Node): boolean => {
      const type = attempt(() => this.checker.getTypeAtLocation(node));
      return type !== undefined && (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0;
    };
    for (let round = 0; round < ISLAND_FLOW_ROUNDS; round++) {
      let grew = false;
      for (const node of sites) {
        if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
          const args = node.arguments?.nodes ?? [];
          let declaration: ts.Node | undefined | null = null;
          for (let index = 0; index < args.length; index++) {
            const argument = args[index]!;
            if (ts.isSpreadElement(argument)) break;
            if (!this.islandValue(argument, islands)) continue;
            if (declaration === null)
              declaration = attempt(() => this.checker.getResolvedSignature(node))?.declaration;
            if (declaration === undefined || declaration === null) break;
            if (!ts.isFunctionLike(declaration)) break;
            if (ts.getSourceFileOfNode(declaration).isDeclarationFile) break;
            const parameter = declaration.parameters.nodes[index];
            if (
              parameter === undefined ||
              parameter.dotDotDotToken !== undefined ||
              !ts.isIdentifier(parameter.name) ||
              !untyped(parameter)
            )
              continue;
            const symbol = attempt(() => this.checker.getSymbolAtLocation(parameter.name));
            if (symbol === undefined || this.islandParameters.has(symbol)) continue;
            this.islandParameters.add(symbol);
            grew = true;
          }
          continue;
        }
        let returned: ts.Expression | undefined;
        if (ts.isReturnStatement(node)) returned = node.expression;
        else if (ts.isArrowFunction(node) && !ts.isBlock(node.body)) returned = node.body;
        if (returned === undefined || !untyped(returned) || !this.islandValue(returned, islands))
          continue;
        const symbol = this.functionSymbolOf(node);
        if (symbol === undefined || this.islandReturners.has(symbol)) continue;
        this.islandReturners.add(symbol);
        grew = true;
      }
      if (!grew) return;
      // What a round found changes the answers of the next.
      this.islandValues.clear();
    }
  }

  /** The symbol callers name the function enclosing `node` by: a declared
   * function's or method's own, or the binding or member an arrow or
   * function expression initializes. */
  private functionSymbolOf(node: ts.Node): ts.Symbol | undefined {
    let fn: ts.Node | undefined = ts.isArrowFunction(node) ? node : node.parent;
    while (fn !== undefined && !ts.isFunctionLike(fn)) fn = fn.parent;
    if (fn === undefined) return undefined;
    let name: ts.Node | undefined;
    if (ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn)) name = fn.name;
    else if (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) {
      const holder = fn.parent;
      if (holder !== undefined && ts.isVariableDeclaration(holder) && holder.initializer === fn)
        name = holder.name;
      else if (holder !== undefined && ts.isPropertyAssignment(holder) && holder.initializer === fn)
        name = holder.name;
    }
    if (name === undefined || !ts.isIdentifier(name)) return undefined;
    const named = name;
    return attempt(() => this.checker.getSymbolAtLocation(named));
  }

  /** Marks the program types that receive island values (SPEC 6 = C). An
   * island object crossing into a program record type used to be refused
   * (SC8010): a deep checked copy loses the identity and every later write
   * the island makes to the object. The checked-identity view is the one
   * representation for "a native-typed value that must stay a live
   * JavaScript object", so a program type that receives island values
   * becomes a view instead: an island object is already a live dynamic
   * object natively (a handle), and every other value of the type is the
   * checked-dynamic object a view builds, so identity and later changes are
   * shared exactly and the copy never happens.
   *
   * The types are the DECLARED types at the reads that produce island
   * values (`doc.colors`, `event.usage.cache_creation`, `islandFn()`), the
   * set `fromIsland` answers for. An intersection or union marks its object
   * parts; an island-declared part is a handle already and is skipped. A
   * type that cannot carry the marking on its symbol — a mapped type, whose
   * symbol is the shared `__type` — is recorded by instance instead.
   *
   * A member read from a live island object is an island value too, received
   * by the member's declared type (`const i = o.inner` holds the island's
   * own inner object), so the types a marked type's members are declared
   * with are marked with it, to any depth (markReceivedMembers). */
  private markIslandView(
    crossing: ts.Expression,
    islands: NodeIslandSet | null,
    add: (type: ts.Type) => void,
  ): void {
    const type = attempt(() => this.checker.getTypeAtLocation(crossing));
    if (type !== undefined) this.markReceivedView(type, islands, add, 0);
  }

  /** Marks the types that receive island values through a function the
   * program hands to an island: an argument of an island call or
   * construction, or a value assigned to a member of an island object. The
   * island calls the function with its own values (`each((item) => ...)`,
   * `emitter.on("row", onRow)`, `{ validate: (items) => ... }`), so each
   * parameter's declared type receives an island value exactly as the type
   * of an island read does. A fresh object or array literal is copied member
   * by member, so the functions among its members are handed over too; any
   * other object crosses by reference and keeps its own members' types. */
  private markIslandCallbacks(
    value: ts.Expression,
    islands: NodeIslandSet | null,
    add: (type: ts.Type) => void,
    depth: number,
  ): void {
    if (depth > RECEIVED_VIEW_DEPTH) return;
    let inner: ts.Expression = value;
    for (;;) {
      if (ts.isParenthesizedExpression(inner) || ts.isNonNullExpression(inner))
        inner = inner.expression;
      else if (ts.isAssertionExpression(inner) || ts.isSatisfiesExpression(inner))
        inner = inner.expression;
      else break;
    }
    if (ts.isSpreadElement(inner)) return;
    if (ts.isArrayLiteralExpression(inner)) {
      for (const element of inner.elements.nodes)
        this.markIslandCallbacks(element, islands, add, depth + 1);
      return;
    }
    if (ts.isObjectLiteralExpression(inner)) {
      for (const property of inner.properties.nodes) {
        if (ts.isPropertyAssignment(property))
          this.markIslandCallbacks(property.initializer, islands, add, depth + 1);
        else if (ts.isShorthandPropertyAssignment(property))
          this.markIslandCallbacks(property.name as ts.Identifier, islands, add, depth + 1);
        else if (ts.isMethodDeclaration(property))
          for (const parameter of property.parameters.nodes) {
            const type = attempt(() => this.checker.getTypeAtLocation(parameter));
            if (type !== undefined) this.markOriginView(type, islands, add, depth + 1);
          }
      }
      return;
    }
    const type = attempt(() => this.checker.getTypeAtLocation(inner));
    if (type === undefined) return;
    for (const signature of attempt(() => this.checker.getCallSignatures(type)) ?? [])
      for (const parameter of signature.getParameters()) {
        const received = attempt(() => this.checker.getTypeOfSymbol(parameter));
        if (received !== undefined) this.markOriginView(received, islands, add, depth + 1);
      }
  }

  private markReceivedView(
    type: ts.Type,
    islands: NodeIslandSet | null,
    add: (type: ts.Type) => void,
    depth: number,
  ): void {
    if (depth > RECEIVED_VIEW_DEPTH) return;
    if (type.isUnionType() || type.isIntersectionType()) {
      for (const part of ts.constituentTypes(type))
        this.markReceivedView(part, islands, add, depth + 1);
      return;
    }
    if ((type.flags & ts.TypeFlags.Object) === 0) return;
    if (islands !== null && isForeignType(islands, type, this.checker)) return;
    if (this.receivedTypes.has(type)) return;
    this.receivedTypes.add(type);
    // A promise the island returns is adopted, never converted: it is the
    // same promise on both sides, and the value that crosses is the one it
    // settles with, where the program awaits it or a reaction receives it.
    // That value's declared type is the promise's type argument, so the
    // argument is the type that receives the island value
    // (`await later<Rec>()` reads an island object as a `Rec`).
    const settled = attempt(() => this.checker.getAwaitedType(type));
    if (settled !== undefined && settled !== type) {
      this.markReceivedView(settled, islands, add, depth + 1);
      return;
    }
    // A mapped type's symbol is the shared `__type` every mapped type in the
    // program uses, so it can never carry the marking: a homomorphic view
    // marks what it maps (as a literal view does), and any other mapped type
    // (`Record<string, V>`, an inline `{ [K in ...]: V }`) is recorded by the
    // type itself. This is what keeps the fact from spreading to every Pick,
    // Partial and Record in the program.
    const source = this.mappedViewSource(type);
    if (source !== null) {
      if (this.isStructuralTarget(source)) add(source);
      else this.islandViews.add(type);
      this.markReceivedMembers(type, islands, add, depth);
      return;
    }
    if (((type as ts.ObjectType).objectFlags & ts.ObjectFlags.Mapped) !== 0) {
      this.islandViews.add(type);
      this.markReceivedMembers(type, islands, add, depth);
      return;
    }
    if (this.isStructuralTarget(type)) {
      add(type);
      this.markReceivedMembers(type, islands, add, depth);
      return;
    }
    // A class instance keeps its own native value (fromIsland unboxes it, it
    // is never copied), and an array, tuple or function has its own crossing
    // rule: neither is a record this marking can help.
    if (this.isProgramClassInstance(type) || this.checker.isArrayType(type)) return;
    if (this.checker.isTupleType(type)) return;
    if (this.checker.getCallSignatures(type).length > 0) return;
    // A library class (Date, Map, Error, URL, a typed array) has a native
    // representation of its own and never becomes a record, so there is no
    // view to mark; its instance type is also one type for the whole
    // program, native uses included.
    if (this.isLibraryClassInstance(type)) return;
    this.islandViews.add(type);
    this.markReceivedMembers(type, islands, add, depth);
  }

  /** Marks `type` where the program gives an untyped island value a type,
   * unless a view cannot hold what the type declares (viewKept): then
   * nothing is marked, the value keeps the checked conversion (a copy taken
   * where the type is given), and the divergence scan names the conversion
   * (SC6007, divergences.ts). */
  private markOriginView(
    type: ts.Type,
    islands: NodeIslandSet | null,
    add: (type: ts.Type) => void,
    depth: number,
  ): void {
    if (this.viewKept(type, islands, new Set(), 0)) return;
    this.markReceivedView(type, islands, add, depth);
  }

  /** Whether `type`, or a type one of its members is declared with, is one
   * a view of an island object cannot answer as the checked conversion does:
   * a string-keyed dictionary (a view reads a missing key as a TypeError
   * where a native dictionary answers `undefined`, and marking it would
   * change every dictionary of the type the program builds itself), or a
   * library object other than an array, a byte view or a promise (a Date, a
   * RegExp, a Map, a Set, an Error, a URL: the conversion builds the native
   * value, a member read through a view does not). */
  private viewKept(
    type: ts.Type,
    islands: NodeIslandSet | null,
    seen: Set<ts.Type>,
    depth: number,
  ): boolean {
    if (depth > RECEIVED_VIEW_DEPTH) return false;
    if (type.isUnionType() || type.isIntersectionType())
      return ts
        .constituentTypes(type)
        .some((part) => this.viewKept(part, islands, seen, depth + 1));
    if ((type.flags & ts.TypeFlags.Object) === 0) return false;
    if (islands !== null && isForeignType(islands, type, this.checker)) return false;
    if (seen.has(type)) return false;
    seen.add(type);
    if (this.checker.isArrayType(type) || this.checker.isTupleType(type)) {
      const elements = attempt(() => this.checker.getTypeArguments(type as ts.TypeReference));
      return (elements ?? []).some((element) => this.viewKept(element, islands, seen, depth + 1));
    }
    if (attempt(() => this.checker.getCallSignatures(type).length > 0) === true) return false;
    const settled = attempt(() => this.checker.getAwaitedType(type));
    if (settled !== undefined && settled !== type)
      return this.viewKept(settled, islands, seen, depth + 1);
    if (this.isLibraryClassInstance(type)) {
      const symbol = type.getSymbol();
      return symbol === undefined || !VIEWED_LIBRARY_OBJECTS.has(ts.symbolName(symbol));
    }
    if (attempt(() => this.checker.getIndexInfosOfType(type).length > 0) === true) return true;
    for (const property of this.checker.getPropertiesOfType(type)) {
      const member = attempt(() => this.checker.getTypeOfSymbol(property));
      if (member !== undefined && this.viewKept(member, islands, seen, depth + 1)) return true;
    }
    return false;
  }

  /** Marks the types the members of a marked type are declared with: the
   * island object behind a view holds island objects in its members, and a
   * read hands one to the member's type. Property types and index signature
   * values are followed through unions, intersections and optional members
   * (markReceivedView), so `inner: Inner`, `opt?: Inner`, `Inner | string`,
   * `Record<string, Inner>` and `Box<Inner>` all reach `Inner`.
   *
   * A promise-typed member reaches the type it settles with the same way
   * (`Promise<Inner>`). Arrays, tuples, Maps, Sets and other library classes
   * are not records and stay what they are: an island array has no native
   * counterpart, so a marked type with such a member is refused by name
   * where the island value crosses (fromIsland's unreceivableMember), not
   * marked here. */
  private markReceivedMembers(
    type: ts.Type,
    islands: NodeIslandSet | null,
    add: (type: ts.Type) => void,
    depth: number,
  ): void {
    for (const property of this.checker.getPropertiesOfType(type)) {
      const member = attempt(() => this.checker.getTypeOfSymbol(property));
      if (member !== undefined) this.markReceivedView(member, islands, add, depth + 1);
    }
    for (const index of this.checker.getIndexInfosOfType(type))
      this.markReceivedView(index.type, islands, add, depth + 1);
  }

  /** Whether `expr` reads a value out of an island handle: its receiver
   * chain is rooted at a value that comes out of an island. The origin
   * decides, not the type the program names: a binding of an island-declared
   * type, a name bound to an island module's export (islandBinding), or
   * `this` in a member of a native subclass of an island class, whose
   * instances the island constructs (islandSubclass). A value a program type
   * holds is a program value — that type is the one this pass marks — so the
   * chain never has to be followed through one. */
  private islandValue(expr: ts.Expression, islands: NodeIslandSet): boolean {
    const known = this.islandValues.get(expr);
    if (known !== undefined) return known;
    let inner: ts.Expression = expr;
    for (;;) {
      if (ts.isParenthesizedExpression(inner) || ts.isNonNullExpression(inner))
        inner = inner.expression;
      else if (ts.isAssertionExpression(inner) || ts.isSatisfiesExpression(inner))
        inner = inner.expression;
      else break;
    }
    // A chain that comes back to itself through `const` initializers ends.
    this.islandValues.set(expr, false);
    let answer = false;
    if (ts.isPropertyAccessExpression(inner) || ts.isElementAccessExpression(inner))
      answer = this.islandValue(inner.expression, islands);
    else if (ts.isCallExpression(inner))
      answer = this.islandValue(inner.expression, islands) || this.islandReturner(inner);
    // The value an island promise settles with, and a value one of whose
    // sources is an island value (`a ?? b`, `c ? a : b`).
    else if (ts.isAwaitExpression(inner)) answer = this.islandValue(inner.expression, islands);
    else if (ts.isConditionalExpression(inner))
      answer =
        this.islandValue(inner.whenTrue, islands) || this.islandValue(inner.whenFalse, islands);
    else if (ts.isBinaryExpression(inner) && VALUE_SELECTING.has(inner.operatorToken.kind))
      answer = this.islandValue(inner.left, islands) || this.islandValue(inner.right, islands);
    else if (ts.isIdentifier(inner))
      answer =
        attempt(() =>
          isForeignType(islands, this.checker.getTypeAtLocation(inner), this.checker),
        ) === true ||
        this.islandBinding(inner, islands) ||
        this.islandHeld(inner, islands);
    else if (inner.kind === ts.SyntaxKind.ThisKeyword)
      answer = this.islandSubclassReceiver(inner, islands);
    this.islandValues.set(expr, answer);
    return answer;
  }

  /** Whether `name` holds a value read out of an island for good: a `const`
   * initialized with one (`const body = makeBody()`), whatever type it has
   * (an island's `any` or `unknown` result is asserted or passed on later),
   * or a parameter a call passes one to (followIslandFlows). A `let` can be
   * reassigned, and a member holds whatever its writers put there: the
   * origin is not visible through those. */
  private islandHeld(name: ts.Identifier, islands: NodeIslandSet): boolean {
    const symbol = attempt(() => this.checker.getSymbolAtLocation(name));
    if (symbol === undefined) return false;
    if (this.islandParameters.has(symbol)) return true;
    const declaration = symbol.valueDeclaration;
    if (
      declaration === undefined ||
      !ts.isVariableDeclaration(declaration) ||
      declaration.initializer === undefined ||
      !ts.isIdentifier(declaration.name) ||
      (ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) === 0
    )
      return false;
    return this.islandValue(declaration.initializer, islands);
  }

  /** Whether `call` calls a program function that returns an island value
   * (followIslandFlows), named by a binding or a member. */
  private islandReturner(call: ts.CallExpression): boolean {
    if (this.islandReturners.size === 0) return false;
    let callee: ts.Expression = call.expression;
    while (ts.isParenthesizedExpression(callee) || ts.isNonNullExpression(callee))
      callee = callee.expression;
    const name = ts.isPropertyAccessExpression(callee) ? callee.name : callee;
    if (!ts.isIdentifier(name)) return false;
    const symbol = attempt(() => this.checker.getSymbolAtLocation(name));
    return symbol !== undefined && this.islandReturners.has(symbol);
  }

  /** Whether the identifier `name`, read as a value, binds an island
   * module's export: an import or a `require` of an island module, or a name
   * a native module re-exports from one (bindsIslandExport). Only a name the
   * file's own import and `require` declarations bind can be one, so every
   * other identifier is answered from syntax. */
  private islandBinding(name: ts.Identifier, islands: NodeIslandSet): boolean {
    if (!this.importBound(name)) return false;
    return attempt(() => bindsIslandExport(this.checker, islands, name)) === true;
  }

  /** Whether `name` is a use of a name its file's import and `require`
   * declarations bind, answered from syntax. */
  private importBound(name: ts.Identifier): boolean {
    const parent = name.parent;
    if (parent === undefined) return false;
    // The declaration's own names, a member name, and a name in a type.
    if (
      ts.isImportClause(parent) ||
      ts.isImportSpecifier(parent) ||
      ts.isNamespaceImport(parent) ||
      ts.isExportSpecifier(parent) ||
      ts.isTypeReferenceNode(parent) ||
      ts.isTypeQueryNode(parent) ||
      ts.isQualifiedName(parent) ||
      (ts.isPropertyAccessExpression(parent) && parent.name === name)
    )
      return false;
    const source = ts.getSourceFileOfNode(name);
    let names = this.importNames.get(source);
    if (names === undefined) {
      names = importBoundNames(source);
      this.importNames.set(source, names);
    }
    return names.has(name.text);
  }

  /** Whether `receiver` (a `this`) is an instance of a native subclass of an
   * island class: the island constructs the instance, so its members are
   * read out of the island like any island object's. */
  private islandSubclassReceiver(receiver: ts.Node, islands: NodeIslandSet): boolean {
    // Arrow functions keep the enclosing member's `this`.
    let scope: ts.Node | undefined = receiver.parent;
    while (scope !== undefined && (!ts.isFunctionLike(scope) || ts.isArrowFunction(scope))) {
      if (ts.isPropertyDeclaration(scope) || ts.isClassStaticBlockDeclaration(scope)) break;
      scope = scope.parent;
    }
    const owner = scope?.parent;
    return (
      owner !== undefined && ts.isClassDeclaration(owner) && this.islandSubclass(owner, islands)
    );
  }

  /** Whether `declaration` is a top-level class whose base is an island
   * class or another such subclass (lower-node-island.ts,
   * islandSubclassHeritage), answered from the declarations alone. */
  private islandSubclass(declaration: ts.ClassDeclaration, islands: NodeIslandSet): boolean {
    const known = this.islandSubclasses.get(declaration);
    if (known !== undefined) return known;
    this.islandSubclasses.set(declaration, false);
    let answer = false;
    const base = extendsElementOf(declaration);
    if (
      declaration.name !== undefined &&
      ts.isSourceFile(declaration.parent) &&
      base !== undefined
    ) {
      answer =
        attempt(() =>
          isForeignType(islands, this.checker.getTypeAtLocation(base.expression), this.checker),
        ) === true;
      if (!answer) {
        const symbol = attempt(() => this.checker.getSymbolAtLocation(base.expression));
        const parent = symbol?.declarations.find(ts.isClassDeclaration);
        answer = parent !== undefined && this.islandSubclass(parent, islands);
      }
    }
    this.islandSubclasses.set(declaration, answer);
    return answer;
  }

  /** Marks the structural types a literal's member kinds disagree with: a
   * get/set accessor satisfying a declared DATA member, or a data property
   * satisfying a declared accessor member. One static record layout cannot
   * hold both member kinds at one name (a data member is a storage slot, an
   * accessor member a `%get:`/`%set:` closure pair), so the target type
   * keeps checked identity instead: every value of it is a live
   * checked-dynamic view, where the accessor stays live, `Object.keys`
   * lists it, and `JSON.stringify` calls it — Node's own model.
   *
   * Only the TARGET is marked (for an intersection or union, its object
   * constituents): the literal then takes the checked-dynamic literal path
   * (`lowerDynObjectLiteral`), which defines an accessor member as a live
   * get/set property and a data member as a plain property, so both
   * directions construct live objects. */
  private markMemberKindViews(
    literal: ts.ObjectLiteralExpression,
    accessorNames: ReadonlySet<string>,
    add: (type: ts.Type) => void,
  ): void {
    const members: { name: string; accessor: boolean }[] = [];
    for (const property of literal.properties.nodes) {
      if (ts.isSpreadAssignment(property) || property.name === undefined) continue;
      const name = propertyNameText(property.name);
      if (name === null) continue;
      if (ts.isGetAccessorDeclaration(property) || ts.isSetAccessorDeclaration(property)) {
        members.push({ name, accessor: true });
        continue;
      }
      if (
        (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
        // A data member only disagrees with an accessor-declared target, and
        // only a type that declares an accessor somewhere can be one: the
        // name index keeps the checker round trip off the common literal.
        accessorNames.has(name)
      )
        members.push({ name, accessor: false });
    }
    if (members.length === 0) return;
    const contextual = attempt(() => this.checker.getContextualType(literal));
    if (contextual === undefined) return;
    // The literal converts into an object PART of its contextual type, so
    // both composites are resolved part by part. An intersection needs the
    // views of every constituent that declares a disagreeing member. A
    // union keeps checked identity only as a whole (usesCheckedIdentity
    // answers it when every present arm does), so it becomes a view only
    // when NO present arm can hold the literal natively: every present arm
    // declares a disagreeing member. An arm that agrees is the arm the
    // literal is, and marking the union anyway would make a program whose
    // literals already match their arms dynamic for nothing. Nullish arms
    // are ignored, so `Counter | undefined` still names Counter.
    const present = contextual.isUnionType()
      ? ts
          .constituentTypes(contextual)
          .filter((part) => (part.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)) === 0)
      : [contextual];
    if (present.length === 0) return;
    const union = present.length > 1;
    if (union && !present.every((part) => this.memberKindDisagrees(part, members))) return;
    const targets: ts.Type[] = [];
    for (const arm of present) {
      const found = this.viewTargets(arm, members, union);
      // An arm that cannot become a view leaves the union native; marking
      // the other arms alone would not give it checked identity.
      if (found === null) return;
      targets.push(...found);
    }
    for (const target of targets) add(target);
  }

  /** The view targets `target` needs for a literal with these member kinds,
   * or null when `target` cannot become a view. An intersection needs the
   * targets of every constituent. A homomorphic mapped view (Partial, Pick,
   * Omit, Readonly) has no symbol of its own — its symbol is the shared
   * mapped `__type`, which every mapped type in the program uses — so the
   * type it maps is the target instead, and `protocol` answers the view
   * through that marking. `force` targets a union arm that must keep
   * checked identity even when it agrees with the literal by itself. */
  private viewTargets(
    target: ts.Type,
    members: readonly { name: string; accessor: boolean }[],
    force: boolean,
  ): ts.Type[] | null {
    if (target.isIntersectionType()) {
      const targets: ts.Type[] = [];
      for (const part of ts.constituentTypes(target)) {
        const found = this.viewTargets(part, members, force);
        if (found === null) return null;
        targets.push(...found);
      }
      return targets;
    }
    if ((target.flags & ts.TypeFlags.TypeParameter) !== 0) return null;
    const source = this.mappedViewSource(target) ?? target;
    if (!this.isStructuralTarget(source)) return null;
    if (!force && !this.memberKindDisagrees(target, members)) return [];
    return [source];
  }

  /** Whether any of the literal's member kinds disagrees with the member
   * `target` declares under that name (a missing member never disagrees). */
  private memberKindDisagrees(
    target: ts.Type,
    members: readonly { name: string; accessor: boolean }[],
  ): boolean {
    return members.some((member) => {
      const kind = attempt(() => this.memberKind(target, member.name));
      return kind == null ? false : (kind === "accessor") !== member.accessor;
    });
  }

  /** The structural type a homomorphic mapped VIEW maps — Partial, Pick,
   * Omit or Readonly over a program type. Mapped types share one `__type`
   * symbol, so a view is identified through the alias it is spelled with;
   * program aliases of views (`type A = B`, `type B = Partial<X>`) are
   * followed through their declarations, and nested views
   * (`Partial<Omit<X, K>>`) resolve to the type carrying the members.
   * Null for everything else. */
  private mappedViewSource(type: ts.Type, depth = 0): ts.Type | null {
    if (depth > 8) return null;
    const alias = type.getAliasSymbol();
    if (alias === undefined) return null;
    if (this.isHomomorphicMappedAlias(alias)) {
      const [source] = type.getAliasTypeArguments();
      if (source === undefined) return null;
      return this.mappedViewSource(source, depth + 1) ?? source;
    }
    const declaration = this.programTypeAlias(alias);
    return declaration === null ? null : this.mappedViewSourceNode(declaration.type, depth + 1);
  }

  /** mappedViewSource for a view spelled as a type node (a program alias's
   * declaration, whose resolved type is the alias itself). */
  private mappedViewSourceNode(node: ts.TypeNode, depth: number): ts.Type | null {
    if (depth > 8) return null;
    while (ts.isParenthesizedTypeNode(node)) node = node.type;
    if (!ts.isTypeReferenceNode(node)) return null;
    const symbol = attempt(() => this.checker.getSymbolAtLocation(node.typeName));
    if (symbol === undefined) return null;
    if (this.isHomomorphicMappedAlias(symbol)) {
      const sourceNode = node.typeArguments?.nodes[0];
      if (sourceNode === undefined) return null;
      const source = attempt(() => this.checker.getTypeFromTypeNode(sourceNode));
      if (source === undefined) return null;
      return this.mappedViewSource(source, depth + 1) ?? source;
    }
    const declaration = this.programTypeAlias(symbol);
    return declaration === null ? null : this.mappedViewSourceNode(declaration.type, depth + 1);
  }

  /** The lib's homomorphic mapped utility types. */
  private isHomomorphicMappedAlias(symbol: ts.Symbol): boolean {
    const name = ts.symbolName(symbol);
    if (name !== "Pick" && name !== "Omit" && name !== "Partial" && name !== "Readonly")
      return false;
    return (
      symbol.declarations.length > 0 &&
      symbol.declarations.every((declaration) => declaration.getSourceFile().isDeclarationFile)
    );
  }

  /** The member kind `type` declares at `name` — an accessor (get/set pair)
   * or a data property — or null when it declares no member by that name. */
  private memberKind(type: ts.Type, name: string): "accessor" | "data" | null {
    const property = this.checker.getPropertyOfType(type, name);
    if (property === undefined) return null;
    return property.flags & (ts.SymbolFlags.GetAccessor | ts.SymbolFlags.SetAccessor)
      ? "accessor"
      : "data";
  }

  /** Structural types that receive a value with identity: a program class
   * instance, or a value of a type already marked here. Natively such a
   * type would be a record, and the conversion into it a field copy, so a
   * write or identity check through the record would miss the original
   * (`function bump(o: { n: number }) { o.n++ }` called with a class
   * instance). Marking keeps every value of the type a live, checked view.
   * Flows are scanned syntactically, and only sites whose source carries
   * identity query their target type.
   *
   * A copy differs from the original only when something observes the
   * difference, so a type is marked only when the program can: values of
   * the type are written through, compared by identity (`===`, `switch`,
   * assert), used as Set/Map keys or array search needles, given to
   * whole-object observers (console, JSON, Object, util, structuredClone,
   * spreads, for-in, templates, `unknown` parameters) or tested with
   * instanceof; or a field the type
   * exposes is written on the source class after construction, so a copy
   * could read a stale value. A view of readonly data that nothing
   * observes stays a native record. */
  private markIdentityFlows(protocols: Set<ts.Symbol>): void {
    const sites: {
      source: ts.Expression;
      target: () => ts.Type | undefined;
      /** The node whose contextual type `target` answers. */
      contextual?: ts.Expression;
      assertion?: true;
      /** The call the expression is an argument of, and its position. */
      call: { node: ts.CallExpression | ts.NewExpression; index: number } | undefined;
    }[] = [];
    /** Expressions whose values are observed as whole objects. */
    const observed: ts.Expression[] = [];
    /** Receivers whose type arguments or elements are observed (Set and Map
     * keys, array search haystacks). */
    const observedContainers: ts.Expression[] = [];
    /** Arguments observed when their parameter type accepts any value
     * (`unknown`, `any`, `object`, `{}`, an unresolved type parameter) or
     * the callee is a generic function or class that observes its type
     * parameter. */
    const looseArguments: ts.Expression[] = [];
    /** The call each loose argument belongs to. */
    const looseCalls: (ts.CallExpression | ts.NewExpression)[] = [];
    /** Member writes: the receiver and the written name (null: any name). */
    const writes: { receiver: ts.Expression; name: string | null }[] = [];
    /** Annotated callback parameters: the caller's argument (the contextual
     * signature's parameter) flows into the declared parameter type. */
    const callbackParams: { fn: ts.SignatureDeclaration; index: number; name: ts.Node }[] = [];
    const contextual = (expr: ts.Expression) => () => this.checker.getContextualType(expr);
    const flow = (
      expr: ts.Expression | undefined,
      call?: { node: ts.CallExpression | ts.NewExpression; index: number },
    ): void => {
      if (expr !== undefined)
        sites.push({ source: expr, target: contextual(expr), contextual: expr, call });
    };
    const write = (target: ts.Expression): void => {
      while (ts.isParenthesizedExpression(target) || ts.isNonNullExpression(target))
        target = target.expression;
      if (ts.isPropertyAccessExpression(target)) {
        // `this.f = v` in a constructor initializes the instance before any
        // view of it can exist.
        if (target.expression.kind !== ts.SyntaxKind.ThisKeyword || !inConstructor(target))
          writes.push({ receiver: target.expression, name: target.name.text });
      } else if (ts.isElementAccessExpression(target)) {
        const key = target.argumentExpression;
        writes.push({
          receiver: target.expression,
          name: ts.isStringLiteralLike(key) || ts.isNumericLiteral(key) ? key.text : null,
        });
      }
    };
    const observe = (node: ts.Node): void => {
      if (ts.isBinaryExpression(node)) {
        const op = node.operatorToken.kind;
        if (
          (op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
            op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
            op === ts.SyntaxKind.EqualsEqualsToken ||
            op === ts.SyntaxKind.ExclamationEqualsToken) &&
          !isNullishLiteral(node.left) &&
          !isNullishLiteral(node.right) &&
          !isPrimitiveLiteral(node.left) &&
          !isPrimitiveLiteral(node.right)
        )
          observed.push(node.left, node.right);
        else if (op === ts.SyntaxKind.InstanceOfKeyword) observed.push(node.left);
        else if (op === ts.SyntaxKind.InKeyword) observed.push(node.right);
        else if (op >= ts.SyntaxKind.FirstAssignment && op <= ts.SyntaxKind.LastAssignment)
          write(node.left);
      } else if (
        (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
        (node.operator === ts.SyntaxKind.PlusPlusToken ||
          node.operator === ts.SyntaxKind.MinusMinusToken)
      ) {
        write(node.operand);
      } else if (ts.isDeleteExpression(node)) {
        write(node.expression);
      } else if (ts.isSpreadAssignment(node) || ts.isTemplateSpan(node)) {
        observed.push(node.expression);
      } else if (ts.isForInStatement(node)) {
        observed.push(node.expression);
      } else if (ts.isSwitchStatement(node)) {
        // `switch` matches its cases with ===.
        const cases = node.caseBlock.clauses.nodes
          .filter(ts.isCaseClause)
          .map((clause) => clause.expression)
          .filter((expr) => !isNullishLiteral(expr) && !isPrimitiveLiteral(expr));
        if (cases.length > 0) observed.push(node.expression, ...cases);
      } else if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const callee = node.expression;
        const args = node.arguments?.nodes ?? [];
        const member = ts.isPropertyAccessExpression(callee) ? callee.name.text : null;
        const owner =
          ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)
            ? callee.expression.text
            : null;
        if (
          (owner !== null && OBSERVER_NAMESPACES.has(owner)) ||
          (ts.isIdentifier(callee) &&
            (OBSERVER_FUNCTIONS.has(callee.text) ||
              (ts.isNewExpression(node) && IDENTITY_CONSTRUCTORS.has(callee.text))))
        ) {
          observed.push(...args.filter((arg) => !ts.isSpreadElement(arg)));
          // Object.assign(target, ...) and Object.defineProperty write the target.
          if (owner === "Object" && args[0] !== undefined && OBJECT_WRITERS.has(member ?? ""))
            writes.push({ receiver: args[0], name: null });
        } else if (member !== null && IDENTITY_METHODS.has(member)) {
          observed.push(...args.filter((arg) => !ts.isSpreadElement(arg)));
          observedContainers.push((callee as ts.PropertyAccessExpression).expression);
        } else {
          for (const arg of args) {
            if (ts.isSpreadElement(arg)) continue;
            looseArguments.push(arg);
            looseCalls.push(node);
          }
        }
      }
    };
    const visit = (node: ts.Node): void => {
      observe(node);
      if (ts.isCallExpression(node) || ts.isNewExpression(node))
        node.arguments?.nodes.forEach((argument, index) => flow(argument, { node, index }));
      else if (ts.isVariableDeclaration(node) && node.type !== undefined) flow(node.initializer);
      else if (ts.isPropertyDeclaration(node) && node.type !== undefined) flow(node.initializer);
      else if (ts.isParameter(node) && node.type !== undefined) flow(node.initializer);
      else if (ts.isReturnStatement(node)) flow(node.expression);
      else if (ts.isArrowFunction(node) && !ts.isBlock(node.body)) flow(node.body);
      else if (ts.isYieldExpression(node)) flow(node.expression);
      else if (ts.isArrayLiteralExpression(node))
        node.elements.nodes.forEach((element) => {
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
        sites.push({
          source: node.right,
          target: () => this.checker.getTypeAtLocation(left),
          call: undefined,
        });
      } else if ((ts.isAsExpression(node) || ts.isTypeAssertion(node)) && !accessedInPlace(node)) {
        const typeNode = node.type;
        sites.push({
          source: node.expression,
          target: () => this.checker.getTypeFromTypeNode(typeNode),
          assertion: true,
          call: undefined,
        });
      }
      if (ts.isArrowFunction(node) || ts.isFunctionExpression(node))
        node.parameters.nodes.forEach((param, index) => {
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
    const observedNodes = observed.map((expr) => this.flowSourceNode(expr));
    const containerNodes = observedContainers.map((expr) => this.flowSourceNode(expr));
    const looseNodes = looseArguments.map((expr) => this.flowSourceNode(expr));
    const writeNodes = writes.map((w) => this.flowSourceNode(w.receiver));
    attempt(() =>
      this.checker.prefetchClassCollection(
        [
          ...sourceNodes,
          ...callbackParams.map((param) => param.name),
          ...observedNodes,
          ...containerNodes,
          ...looseNodes,
          ...writeNodes,
        ],
        [],
      ),
    );

    const marked = protocols;
    const facts: FlowFacts = {
      observed: new Set(),
      written: new Map(),
      loose: [],
      bases: new Map(),
      origins: new Map(),
      targets: new Map(),
      flows: new Map(),
      callSites: new Map(),
      otherSites: new Set(),
      genericObservers: new Set(),
    };
    const typeOf = (node: ts.Node): ts.Type | undefined =>
      attempt(() => this.checker.getTypeAtLocation(node));
    for (const node of [...observedNodes, ...containerNodes]) {
      const type = typeOf(node);
      if (type === undefined) continue;
      this.collectSymbols(type, facts.observed, 0);
      // A type parameter observed in a generic function or class: calls of
      // it observe whatever their arguments hold.
      const parts = type.isUnionType() ? ts.constituentTypes(type) : [type];
      for (const part of parts) {
        if ((part.flags & ts.TypeFlags.TypeParameter) === 0) continue;
        const symbol = part.getSymbol();
        for (const declaration of symbol ? symbol.declarations : [])
          if (ts.isTypeParameterDeclaration(declaration) && declaration.parent !== undefined)
            facts.genericObservers.add(declaration.parent);
      }
    }
    for (let i = 0; i < writes.length; i++) {
      const symbols = new Set<ts.Symbol>();
      // `this` has the polymorphic this type: the write lands on the
      // enclosing class's instance.
      const owner =
        writeNodes[i]!.kind === ts.SyntaxKind.ThisKeyword ? thisClass(writeNodes[i]!) : undefined;
      const ownerSymbol = owner?.name ? this.checker.getSymbolAtLocation(owner.name) : undefined;
      if (ownerSymbol !== undefined) symbols.add(ownerSymbol);
      else {
        const type = typeOf(writeNodes[i]!);
        if (type === undefined) continue;
        this.collectSymbols(type, symbols, 2);
      }
      const name = writes[i]!.name;
      for (const symbol of symbols) {
        const names = facts.written.get(symbol);
        if (name === null) facts.written.set(symbol, "all");
        else if (names === undefined) facts.written.set(symbol, new Set([name]));
        else if (names !== "all") names.add(name);
      }
    }
    this.markDictionaryViews(sites, sourceNodes, observedNodes, writeNodes);
    for (let i = 0; i < looseArguments.length; i++) {
      const type = typeOf(looseNodes[i]!);
      if (type === undefined) continue;
      const symbols = new Set<ts.Symbol>();
      this.collectSymbols(type, symbols, 0);
      if (symbols.size > 0)
        facts.loose.push({ node: looseArguments[i]!, call: looseCalls[i]!, symbols });
    }
    this.facts = facts;
    const pending: {
      sourceType: ts.Type;
      target: () => ts.Type | undefined;
      contextual?: ts.Expression;
      /** The call the source is an argument of, and its position. */
      call: { node: ts.CallExpression | ts.NewExpression; index: number } | undefined;
    }[] = [];
    /** Views a value of unknown origin is asserted to and that expose a
     * method of a class the view accepts (see methodViewSources). */
    const methodViews = new Set<ts.Symbol>();
    for (let i = 0; i < sites.length; i++) {
      const site = sites[i]!;
      const source = sourceNodes[i]!;
      const sourceType = attempt(() => this.checker.getTypeAtLocation(source));
      if (sourceType === undefined) continue;
      if (
        site.assertion &&
        (sourceType.flags & (ts.TypeFlags.Unknown | ts.TypeFlags.Any)) !== 0 &&
        this.methods.size > 0
      ) {
        const target = attempt(site.target);
        if (target !== undefined)
          for (const { classType, view } of attempt(() => this.methodViewSources(target)) ?? []) {
            pending.push({ sourceType: classType, target: () => view, call: undefined });
            const symbol = view.getSymbol();
            if (symbol !== undefined) methodViews.add(symbol);
          }
        continue;
      }
      pending.push(
        site.contextual === undefined
          ? { sourceType, target: site.target, call: site.call }
          : { sourceType, target: site.target, contextual: site.contextual, call: site.call },
      );
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
            call: undefined,
          });
        }
      });
    }
    // Every site is revisited until nothing new is marked, so each mark's
    // flows and origins are complete.
    const before = new Set(marked);
    const targets = new Map<number, ts.Type | undefined>();
    // The fixpoint asks the target of each site whose source carries
    // identity: one batch asks those of the sites that carry it now, and a
    // site that starts to as marks grow asks its own.
    attempt(() =>
      this.checker.prefetchContextualTypes(
        pending.flatMap((entry) =>
          entry.contextual !== undefined &&
          attempt(() => this.carriesIdentity(entry.sourceType, marked)) === true
            ? [entry.contextual]
            : [],
        ),
      ),
    );
    let changed = true;
    while (changed) {
      changed = false;
      for (let i = pending.length - 1; i >= 0; i--) {
        const entry = pending[i]!;
        if (attempt(() => this.carriesIdentity(entry.sourceType, marked)) !== true) continue;
        if (!targets.has(i)) targets.set(i, attempt(entry.target));
        const target = targets.get(i);
        if (
          target !== undefined &&
          attempt(() =>
            this.markTarget(entry.sourceType, target, marked, entry.call ?? null, true),
          ) === true
        )
          changed = true;
      }
    }
    // Keep the marks a copy would be told apart from, and the marks whose
    // values flow into a kept view or another live protocol.
    const added = [...marked].filter((symbol) => !before.has(symbol));
    // A copy of an instance drops the methods its class defines, so a view
    // that exposes one of them stays live wherever such an instance may
    // arrive. A record view of a collection needs no protocol: its checked
    // identity is the collection itself, and its members are the
    // collection's own methods, which protocol dispatch would read from a
    // property bag instead of invoking.
    const kept = new Set(
      added.filter(
        (symbol) =>
          !this.collectionViews.has(symbol) &&
          (methodViews.has(symbol) || this.needsView(symbol, marked, facts)),
      ),
    );
    let grew = true;
    while (grew) {
      grew = false;
      for (const symbol of added) {
        if (kept.has(symbol)) continue;
        for (const into of facts.flows.get(symbol) ?? NO_SYMBOLS) {
          if (kept.has(into) || before.has(into)) {
            kept.add(symbol);
            grew = true;
            break;
          }
        }
      }
    }
    for (const symbol of added) if (!kept.has(symbol)) marked.delete(symbol);
    this.facts = null;
  }

  /** The program classes a value asserted from `unknown` or `any` to
   * `target` may be an instance of while `target` exposes one of their
   * methods: for each structural part of `target` with a callable member,
   * the instance type of every class that declares a method of that name
   * and is assignable to the part. A record copy of such an instance would
   * drop the method, which Node reads from the instance's prototype. */
  private methodViewSources(target: ts.Type): { classType: ts.Type; view: ts.Type }[] {
    const parts = target.isUnionType() ? ts.constituentTypes(target) : [target];
    const out: { classType: ts.Type; view: ts.Type }[] = [];
    for (const part of parts) {
      if (!this.isStructuralTarget(part)) continue;
      for (const property of this.checker.getPropertiesOfType(part)) {
        const memberType = this.checker.getNonNullableType(this.checker.getTypeOfSymbol(property));
        if (this.checker.getCallSignatures(memberType).length === 0) continue;
        for (const declaration of this.methods.get(ts.symbolName(property)) ?? []) {
          const classSymbol = declaration.name
            ? this.checker.getSymbolAtLocation(declaration.name)
            : undefined;
          if (classSymbol === undefined) continue;
          const classType = this.checker.getDeclaredTypeOfSymbol(classSymbol);
          if (this.checker.isTypeAssignableTo(classType, part)) out.push({ classType, view: part });
        }
      }
    }
    return out;
  }

  /** The symbols of `type`'s object parts: union and intersection members,
   * and to `depth` levels the elements and type arguments they hold. */
  private collectSymbols(type: ts.Type, out: Set<ts.Symbol>, depth: number): void {
    if (type.isUnionType() || type.isIntersectionType()) {
      for (const part of ts.constituentTypes(type)) this.collectSymbols(part, out, depth);
      return;
    }
    if ((type.flags & ts.TypeFlags.Object) === 0) return;
    const symbol = type.getSymbol();
    if (symbol !== undefined) out.add(symbol);
    if (depth >= 2 || !type.isTypeReference()) return;
    for (const argument of this.checker.getTypeArguments(type))
      this.collectSymbols(argument, out, depth + 1);
  }

  /** Program classes whose instances can be values of `source`: a class,
   * its bases and the classes extending it, or the classes behind a marked
   * structural type. */
  private originsOf(source: ts.Type, facts: FlowFacts): Set<ts.Symbol> {
    const out = new Set<ts.Symbol>();
    const add = (type: ts.Type): void => {
      if (type.isUnionType() || type.isIntersectionType()) {
        for (const part of ts.constituentTypes(type)) add(part);
        return;
      }
      // A Pick or Omit view's values are instances of the class it views,
      // or of any other program class that has the view's members.
      const viewed = this.pickViewOf(type, 0);
      if (viewed !== null) {
        add(viewed);
        for (const other of this.classesAcceptedBy(type))
          for (const related of this.classFamily(other, facts)) out.add(related);
        return;
      }
      const symbol = type.getSymbol();
      if (symbol === undefined) return;
      if (this.isProgramClassInstance(type)) {
        for (const related of this.classFamily(symbol, facts)) out.add(related);
      } else {
        for (const origin of facts.origins.get(symbol) ?? NO_SYMBOLS) out.add(origin);
      }
    };
    if (this.checker.isArrayType(source)) {
      const [element] = this.checker.getTypeArguments(source as ts.TypeReference);
      if (element !== undefined) add(element);
    } else add(source);
    return out;
  }

  /** The program classes with methods whose instances are assignable to
   * `type`. */
  private classesAcceptedBy(type: ts.Type): ts.Symbol[] {
    const known = this.accepted.get(type);
    if (known !== undefined) return known;
    this.index();
    const found = new Set<ts.Symbol>();
    for (const entries of this.methods.values())
      for (const declaration of entries) {
        const symbol = declaration.name
          ? this.checker.getSymbolAtLocation(declaration.name)
          : undefined;
        if (
          symbol !== undefined &&
          !found.has(symbol) &&
          this.checker.isTypeAssignableTo(this.checker.getDeclaredTypeOfSymbol(symbol), type)
        )
          found.add(symbol);
      }
    const result = [...found];
    this.accepted.set(type, result);
    return result;
  }

  /** A class symbol with its base classes and the program classes that
   * extend it. */
  private classFamily(symbol: ts.Symbol, facts: FlowFacts): ts.Symbol[] {
    const known = facts.bases.get(symbol);
    if (known !== undefined) return known;
    const family = new Set<ts.Symbol>([symbol]);
    const addBases = (sym: ts.Symbol): void => {
      const declared = this.checker.getDeclaredTypeOfSymbol(sym);
      const target = declared.isTypeReference() ? declared.getTarget() : declared;
      if (!target?.isClassOrInterface()) return;
      for (const base of this.checker.getBaseTypes(target)) {
        const baseSymbol = base.getSymbol();
        if (baseSymbol !== undefined && !family.has(baseSymbol)) {
          family.add(baseSymbol);
          addBases(baseSymbol);
        }
      }
    };
    addBases(symbol);
    const declared = this.checker.getDeclaredTypeOfSymbol(symbol);
    for (const entries of this.methods.values())
      for (const declaration of entries) {
        const other = declaration.name
          ? this.checker.getSymbolAtLocation(declaration.name)
          : undefined;
        if (
          other !== undefined &&
          !family.has(other) &&
          this.checker.isTypeAssignableTo(this.checker.getDeclaredTypeOfSymbol(other), declared)
        )
          family.add(other);
      }
    const result = [...family];
    facts.bases.set(symbol, result);
    return result;
  }

  /** Whether the program can tell a copy of a value of the marked type
   * `symbol` from the original: see markIdentityFlows. */
  private needsView(symbol: ts.Symbol, marked: ReadonlySet<ts.Symbol>, facts: FlowFacts): boolean {
    if (facts.observed.has(symbol) || facts.written.has(symbol)) return true;
    const target = facts.targets.get(symbol);
    if (target === undefined) return true;
    // A type that exposes a program class's method can never be a record
    // copy: the copy would drop the method, which Node reads from the
    // instance's prototype, and a copied receiver would lose overrides.
    // The mark exists because an identity-carrying value flows into the
    // type, so keep the view even when nothing compares the value (pi's
    // `{ handleInput?(data: string): void } | undefined` field receives
    // component instances directly and is only ever called through).
    if (this.methodViewSources(target).length > 0) return true;
    const names = new Set(this.checker.getPropertiesOfType(target).map((p) => ts.symbolName(p)));
    const origins = facts.origins.get(symbol) ?? new Set<ts.Symbol>();
    const writesNames = (written: Set<string> | "all"): boolean =>
      written === "all" || [...written].some((name) => names.has(name));
    for (const origin of origins) {
      const written = facts.written.get(origin);
      // A field written after construction would be stale in a copy — unless
      // every value of the view arrives as a call argument the callee reads
      // and nothing else, where the copy answers the same reads the instance
      // would (copiedAtEverySite).
      if (written !== undefined && writesNames(written) && !this.copiedAtEverySite(symbol, facts))
        return true;
      // An accessor runs on every read of the instance: a copy would keep
      // the value of one call.
      if (this.hasAccessorFor(origin, names)) return true;
    }
    // Writes through another live view of the same instances.
    for (const [view, written] of facts.written) {
      if (view === symbol || !marked.has(view) || !writesNames(written)) continue;
      for (const origin of facts.origins.get(view) ?? NO_SYMBOLS)
        if (origins.has(origin)) return true;
    }
    // An argument holding the type, passed where any value is accepted or
    // to a generic function or class that observes its type parameter.
    return facts.loose.some(
      (arg) =>
        arg.symbols.has(symbol) &&
        attempt(() => {
          const context = this.checker.getContextualType(arg.node);
          if (context !== undefined && this.acceptsAnyValue(context)) return true;
          if (facts.genericObservers.size === 0) return false;
          const signature = this.checker.getResolvedSignature(arg.call);
          const declaration = signature && signature.declaration;
          return (
            declaration !== undefined &&
            (facts.genericObservers.has(declaration) ||
              (declaration.parent !== undefined && facts.genericObservers.has(declaration.parent)))
          );
        }) === true,
    );
  }

  /** Whether every value of the view arrives as a call argument whose
   * callee only reads it: then the record copy the boundary builds answers
   * the same reads the instance itself would, and later writes to the
   * instance cannot be observed through the view. */
  private copiedAtEverySite(symbol: ts.Symbol, facts: FlowFacts): boolean {
    if (facts.otherSites.has(symbol)) return false;
    const sites = facts.callSites.get(symbol);
    if (sites === undefined || sites.length === 0) return false;
    return sites.every(
      (site) =>
        this.isProgramClassInstance(site.source) && this.copiedArgument(site.node, site.index),
    );
  }

  /** Whether argument `index` of `call` can be copied into the parameter's
   * record: the callee is a program function whose body reads the instance
   * only through declared fields of primitive type, keeps no reference to
   * it, and runs no code that could write to it (assignments only to its
   * own locals, no await or yield, and every call a numeric builtin). */
  private copiedArgument(call: ts.CallExpression | ts.NewExpression, index: number): boolean {
    let byIndex = this.copiedArguments.get(call);
    if (byIndex === undefined) {
      byIndex = [];
      this.copiedArguments.set(call, byIndex);
    }
    const cached = byIndex[index];
    if (cached !== undefined) return cached;
    const answer = attempt(() => this.copiedArgumentNow(call, index)) === true;
    byIndex[index] = answer;
    return answer;
  }

  private copiedArgumentNow(call: ts.CallExpression | ts.NewExpression, index: number): boolean {
    const args = call.arguments?.nodes ?? [];
    if (index >= args.length || args.some((argument) => ts.isSpreadElement(argument))) return false;
    const signature = this.checker.getResolvedSignature(call);
    const declaration = signature?.declaration;
    if (declaration === undefined) return false;
    if (
      !ts.isFunctionDeclaration(declaration) &&
      !ts.isFunctionExpression(declaration) &&
      !ts.isArrowFunction(declaration)
    )
      return false;
    if (declaration.body === undefined) return false;
    if (!this.fixedCallee(declaration, call)) return false;
    if (declaration.asteriskToken !== undefined) return false;
    if (
      declaration.modifiers?.nodes.some(
        (modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword,
      ) === true
    )
      return false;
    // Defaults run in the callee's frame, after the arguments, and may write
    // the instance; a parameter pattern reads members the same way.
    if (
      declaration.parameters.nodes.some(
        (parameter) => !ts.isIdentifier(parameter.name) || parameter.initializer !== undefined,
      )
    )
      return false;
    const parameter = declaration.parameters.nodes[index];
    if (parameter === undefined || !ts.isIdentifier(parameter.name)) return false;
    if (parameter.dotDotDotToken !== undefined || parameter.questionToken !== undefined)
      return false;
    // Arguments evaluated after this one run while the copy stands: code in
    // them may write the instance before the callee reads the copy.
    for (let position = index + 1; position < args.length; position++) {
      const argument = args[position];
      if (argument !== undefined && containsProgramCode(argument, this.checker)) return false;
    }
    return this.readsParameterOnlyFields(declaration, parameter.name.text);
  }

  /** Whether the function whose body is inspected is the one this call runs:
   * the callee is the function itself, the identifier of the function
   * declaration, or the identifier of the `const` binding that holds it.
   * A `let` binding, a property, or another binding of the same signature
   * could run a body this analysis never saw. */
  private fixedCallee(
    fn: ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction,
    call: ts.CallExpression | ts.NewExpression,
  ): boolean {
    const callee = unwrapExpression(call.expression);
    if (callee === fn) return true;
    if (!ts.isIdentifier(callee)) return false;
    const symbol = attempt(() => this.checker.getSymbolAtLocation(callee));
    if (ts.isFunctionDeclaration(fn))
      return symbol?.declarations?.some((declaration) => declaration === fn) === true;
    const parent = fn.parent;
    const list = parent?.parent;
    if (
      !ts.isVariableDeclaration(parent) ||
      parent.initializer !== fn ||
      list === undefined ||
      (list.flags & ts.NodeFlags.Const) === 0
    )
      return false;
    return symbol?.declarations?.some((declaration) => declaration === parent) === true;
  }

  /** The body of `declaration` mentions `name` only as the receiver of a
   * property read whose value is a primitive, and never stores, returns,
   * passes on or compares the value itself. */
  private readsParameterOnlyFields(
    declaration: ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction,
    name: string,
  ): boolean {
    const body = declaration.body;
    if (body === undefined) return false;
    const locals = new Set<string>();
    for (const parameter of declaration.parameters.nodes)
      if (ts.isIdentifier(parameter.name)) locals.add(parameter.name.text);
    ts.walkPreorder(body, (node) => {
      if (ts.isFunctionLike(node)) return "skip";
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) locals.add(node.name.text);
      return undefined;
    });
    let ok = true;
    ts.walkPreorder(body, (node) => {
      if (!ok) return "stop";
      if (ts.isTypeNode(node)) return "skip";
      if (ts.isFunctionLike(node)) {
        // A nested function that mentions the parameter captures the value,
        // so the copy would be told apart from the instance.
        if (mentionsBinding(node, name)) ok = false;
        return "skip";
      }
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      ) {
        // Only the body's own locals may be written: a write through any
        // other value could reach the instance. A compound assignment also
        // coerces both sides, and a non-primitive operand runs its value
        // hook.
        const left = unwrapExpression(node.left);
        if (!ts.isIdentifier(left) || !locals.has(left.text)) {
          ok = false;
          return "stop";
        }
        if (
          node.operatorToken.kind !== ts.SyntaxKind.EqualsToken &&
          !primitiveOperands(left, node.right, this.checker)
        ) {
          ok = false;
          return "stop";
        }
        return undefined;
      }
      if (
        (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
        (node.operator === ts.SyntaxKind.PlusPlusToken ||
          node.operator === ts.SyntaxKind.MinusMinusToken)
      ) {
        const operand = unwrapExpression(node.operand);
        if (
          !ts.isIdentifier(operand) ||
          !locals.has(operand.text) ||
          !primitiveNode(operand, this.checker)
        ) {
          ok = false;
          return "stop";
        }
        return undefined;
      }
      // Calls, await and yield, element access, accessors, dynamic member
      // access, iteration and value coercion can all run program code while
      // the copy is the callee's parameter.
      if (expressionRunsCode(node, this.checker)) {
        ok = false;
        return "stop";
      }
      if (ts.isIdentifier(node) && node.text === name) {
        if (isMemberName(node)) return "skip";
        const receiver = unwrapExpression(node);
        const access = receiver.parent;
        if (
          access === undefined ||
          !ts.isPropertyAccessExpression(access) ||
          access.expression !== receiver
        ) {
          ok = false;
          return "stop";
        }
        if (!primitiveValue(this.checker.getTypeAtLocation(access))) {
          ok = false;
          return "stop";
        }
        if (isWrittenAccess(access)) {
          ok = false;
          return "stop";
        }
        return "skip";
      }
      return undefined;
    });
    return ok;
  }

  /** Whether one of `names` is a member the collection type itself
   * declares (`has`, `get`, `size`, `keys`, ...). */
  private exposesCollectionMember(collection: ts.Type, names: ReadonlySet<string>): boolean {
    return this.checker
      .getPropertiesOfType(collection)
      .some((property) => names.has(ts.symbolName(property)));
  }

  /** Whether class `symbol` declares a get or set accessor for one of
   * `names`. */
  private hasAccessorFor(symbol: ts.Symbol, names: ReadonlySet<string>): boolean {
    const declared = this.checker.getDeclaredTypeOfSymbol(symbol);
    return this.checker
      .getPropertiesOfType(declared)
      .some(
        (property) =>
          names.has(ts.symbolName(property)) &&
          property.declarations.some(
            (declaration) =>
              ts.isGetAccessorDeclaration(declaration) || ts.isSetAccessorDeclaration(declaration),
          ),
      );
  }

  /** `unknown`, `any`, `object`, `{}` and type-parameter parameters, alone
   * or in a union. */
  private acceptsAnyValue(type: ts.Type): boolean {
    if (type.isUnionType()) return ts.constituentTypes(type).some((p) => this.acceptsAnyValue(p));
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
      !this.checker.isArrayType(type)
    );
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

  /** `Pick<C, K>` or `Omit<C, K>` over a program class instance type: a
   * view of the class's own members, spelled inline instead of as an
   * interface. Like an interface the class matches, a view that exposes a
   * method needs a live receiver (see protocol). A program type alias of
   * such a view names the same view (`type V = Pick<C, K>`), so its
   * declaration is resolved to the Pick/Omit it spells. */
  private pickOfProgramClass(type: ts.Type): boolean {
    return this.pickViewOf(type, 0) !== null;
  }

  /** The program class instance this view views, resolving program type
   * aliases of views (`type A = B`, `type B = Pick<C, K>`) up to a small
   * depth; null for everything else. */
  private pickViewOf(type: ts.Type, depth: number): ts.Type | null {
    if (depth > 8) return null;
    const alias = type.getAliasSymbol();
    if (alias === undefined) return null;
    if (this.isPickOrOmitAlias(alias)) {
      const source = type.getAliasTypeArguments()[0];
      return source !== undefined && this.isProgramClassInstance(source) ? source : null;
    }
    const declaration = this.programTypeAlias(alias);
    return declaration === null ? null : this.pickViewNode(declaration.type, depth + 1);
  }

  /** The class instance a view's type node views. The resolved type of a
   * program alias is the alias itself, so the reference is read by name:
   * `Pick<C, K>` / `Omit<C, K>` keep the class it views, and another alias
   * is followed through its declaration. */
  private pickViewNode(node: ts.TypeNode, depth: number): ts.Type | null {
    if (depth > 8) return null;
    while (ts.isParenthesizedTypeNode(node)) node = node.type;
    if (!ts.isTypeReferenceNode(node)) return null;
    const symbol = attempt(() => this.checker.getSymbolAtLocation(node.typeName));
    if (symbol === undefined) return null;
    if (this.isPickOrOmitAlias(symbol)) {
      const sourceNode = node.typeArguments?.nodes[0];
      const source =
        sourceNode === undefined
          ? undefined
          : attempt(() => this.checker.getTypeFromTypeNode(sourceNode));
      return source !== undefined && this.isProgramClassInstance(source) ? source : null;
    }
    const declaration = this.programTypeAlias(symbol);
    return declaration === null ? null : this.pickViewNode(declaration.type, depth + 1);
  }

  /** The lib's `Pick` or `Omit` utility type. */
  private isPickOrOmitAlias(symbol: ts.Symbol): boolean {
    const name = ts.symbolName(symbol);
    if (name !== "Pick" && name !== "Omit") return false;
    return symbol.declarations.every(
      (declaration) => declaration.getSourceFile().isDeclarationFile,
    );
  }

  /** The program's own declaration of a type alias, if the symbol has one. */
  private programTypeAlias(symbol: ts.Symbol): ts.TypeAliasDeclaration | null {
    const declaration = symbol.declarations.find(
      (candidate) =>
        ts.isTypeAliasDeclaration(candidate) &&
        !ts.getSourceFileOfNode(candidate).isDeclarationFile,
    );
    return declaration !== undefined && ts.isTypeAliasDeclaration(declaration) ? declaration : null;
  }

  /** String-keyed dictionaries (`Record<string, V>`, `{ [key: string]: V }`)
   * that receive an existing record or class instance. Natively a
   * dictionary is a key/value record, and converting another object into
   * one copies its fields, so writes through the dictionary and identity
   * checks would miss the original. When the program writes through, or
   * observes, a value of such a dictionary type, every dictionary with that
   * value type keeps checked identity instead (records with the same value
   * type share one native layout, so values pass between them). A source
   * counts when it is an existing object (a binding, member, element or
   * `this`, not a fresh literal or call result) whose type is a program
   * class instance or a record with declared properties, or a constant
   * `{}`, `object` or `unknown` binding initialized with one. */
  private markDictionaryViews(
    sites: readonly {
      source: ts.Expression;
      target: () => ts.Type | undefined;
      contextual?: ts.Expression;
    }[],
    sourceNodes: readonly ts.Expression[],
    observedNodes: readonly ts.Expression[],
    writeNodes: readonly ts.Expression[],
  ): void {
    // The calls the sites' arguments belong to, by callee name, built on
    // first use.
    let calls: Map<string, (ts.CallExpression | ts.NewExpression)[]> | null = null;
    const callsNamed = (name: string): readonly (ts.CallExpression | ts.NewExpression)[] => {
      if (calls === null) {
        calls = new Map();
        for (const site of sites) {
          const call = site.contextual?.parent;
          if (call === undefined || (!ts.isCallExpression(call) && !ts.isNewExpression(call)))
            continue;
          const callee = call.expression;
          const named = ts.isIdentifier(callee)
            ? callee.text
            : ts.isPropertyAccessExpression(callee)
              ? callee.name.text
              : undefined;
          if (named === undefined) continue;
          const list = calls.get(named) ?? [];
          if (!list.includes(call)) list.push(call);
          calls.set(named, list);
        }
      }
      return calls.get(name) ?? [];
    };
    const candidates: { index: number; sourceType: ts.Type }[] = [];
    for (let i = 0; i < sites.length; i++) {
      const source = sourceNodes[i]!;
      if (!isExistingObject(source)) continue;
      const sourceType = attempt(() => this.checker.getTypeAtLocation(source));
      if (sourceType !== undefined && this.dictionarySource(source, sourceType, callsNamed))
        candidates.push({ index: i, sourceType });
    }
    if (candidates.length === 0) return;
    // One batch for the contextual targets of the candidate sites.
    attempt(() =>
      this.checker.prefetchContextualTypes(
        candidates.flatMap(({ index }) => {
          const contextual = sites[index]!.contextual;
          return contextual === undefined ? [] : [contextual];
        }),
      ),
    );
    const received = new Set<ts.Type>();
    for (const { index, sourceType } of candidates) {
      const target = attempt(sites[index]!.target);
      const parts =
        target === undefined ? [] : target.isUnionType() ? ts.constituentTypes(target) : [target];
      for (const part of parts) {
        const value = this.dictionaryValueType(part);
        // A dictionary of `unknown` or `any` values is checked-dynamic already.
        if (
          value !== undefined &&
          (value.flags & (ts.TypeFlags.Unknown | ts.TypeFlags.Any)) === 0 &&
          this.dictionaryValueType(sourceType) !== value
        )
          received.add(value);
      }
    }
    if (received.size === 0) return;
    // The dictionary values the program writes through or observes.
    const seen = new Set<ts.Type>();
    for (const node of [...writeNodes, ...observedNodes]) {
      const type = attempt(() => this.checker.getTypeAtLocation(node));
      const parts =
        type === undefined ? [] : type.isUnionType() ? ts.constituentTypes(type) : [type];
      for (const part of parts) {
        const value = this.dictionaryValueType(part);
        if (value !== undefined) seen.add(value);
      }
    }
    for (const value of received) if (seen.has(value)) this.dictionaryViews.add(value);
  }

  /** Whether `source` holds an existing object that a dictionary
   * conversion would copy. */
  private dictionarySource(
    source: ts.Expression,
    type: ts.Type,
    callsNamed: (name: string) => readonly (ts.CallExpression | ts.NewExpression)[],
  ): boolean {
    if (this.isProgramClassInstance(type) || this.isRecordWithFields(type)) return true;
    if (!isDynamicView(this.checker, type)) return false;
    const holdsObjectType = (held: ts.Type | undefined): boolean =>
      held !== undefined && (this.isProgramClassInstance(held) || this.isRecordWithFields(held));
    const holdsObject = (expr: ts.Expression): boolean =>
      holdsObjectType(attempt(() => this.checker.getTypeAtLocation(this.flowSourceNode(expr))));
    const constInitializer = (name: ts.Identifier): ts.Expression | undefined => {
      const decl = attempt(() => this.checker.getSymbolAtLocation(name))?.valueDeclaration;
      return decl !== undefined &&
        ts.isVariableDeclaration(decl) &&
        ts.isVariableDeclarationList(decl.parent) &&
        (decl.parent.flags & ts.NodeFlags.Const) !== 0
        ? decl.initializer
        : undefined;
    };
    if (ts.isElementAccessExpression(source)) {
      // An element of a constant `unknown[]` binding holds what the
      // binding's initializer stores: the elements of an array of records
      // or class instances, or what a `map` callback returns.
      let base = source.expression;
      while (ts.isParenthesizedExpression(base)) base = base.expression;
      const initializer = ts.isIdentifier(base) ? constInitializer(base) : undefined;
      if (initializer === undefined) return false;
      const array = attempt(() => this.checker.getTypeAtLocation(initializer));
      if (
        array !== undefined &&
        this.checker.isArrayType(array) &&
        holdsObjectType(this.checker.getTypeArguments(array as ts.TypeReference)[0])
      )
        return true;
      let call = initializer;
      while (ts.isParenthesizedExpression(call)) call = call.expression;
      if (
        !ts.isCallExpression(call) ||
        !ts.isPropertyAccessExpression(call.expression) ||
        call.expression.name.text !== "map"
      )
        return false;
      const callback = call.arguments.nodes[0];
      return (
        callback !== undefined &&
        (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) &&
        functionResults(callback).some(holdsObject)
      );
    }
    if (!ts.isIdentifier(source)) return false;
    const decl = attempt(() => this.checker.getSymbolAtLocation(source))?.valueDeclaration;
    if (decl === undefined) return false;
    if (ts.isParameter(decl)) {
      // A parameter holds what its callers pass: the calls of the function
      // by name whose signature resolves to it.
      const fn = decl.parent;
      if (fn === undefined || !ts.isFunctionLike(fn)) return false;
      const index = fn.parameters.nodes.indexOf(decl);
      const name = functionName(fn);
      if (name === undefined || index < 0) return false;
      return callsNamed(name).some((call) => {
        const argument = call.arguments?.nodes[index];
        return (
          argument !== undefined &&
          !ts.isSpreadElement(argument) &&
          attempt(() => this.checker.getResolvedSignature(call)?.declaration) === fn &&
          holdsObject(argument)
        );
      });
    }
    const initializer = constInitializer(source);
    return initializer !== undefined && holdsObject(initializer);
  }

  /** A program object type with declared properties that is not a class
   * instance, array, tuple, function or library type. */
  private isRecordWithFields(type: ts.Type): boolean {
    return this.isStructuralTarget(type) && this.checker.getPropertiesOfType(type).length > 0;
  }

  /** The value type of a string-keyed dictionary with no declared
   * properties, or undefined for any other type. */
  private dictionaryValueType(type: ts.Type): ts.Type | undefined {
    if ((type.flags & ts.TypeFlags.Object) === 0) return undefined;
    if (this.checker.isArrayType(type) || this.checker.isTupleType(type)) return undefined;
    if (this.checker.getCallSignatures(type).length > 0) return undefined;
    if (this.checker.getPropertiesOfType(type).length > 0) return undefined;
    return this.checker
      .getIndexInfosOfType(type)
      .find((index) => (index.keyType.flags & ts.TypeFlags.String) !== 0)?.type;
  }

  /** A lib Map, Set, ReadonlyMap or ReadonlySet: a live collection. Handed
   * to a structural type that spells one of its members, a copy would answer
   * from its own fields and miss later writes to the collection, so the view
   * stays the collection itself (checked-dynamic identity). */
  private isBuiltinCollection(type: ts.Type): boolean {
    if ((type.flags & ts.TypeFlags.Object) === 0) return false;
    const target = type.isTypeReference() ? type.getTarget() : type;
    const symbol = target?.getSymbol() ?? type.getSymbol();
    if (symbol === undefined) return false;
    const name = ts.symbolName(symbol);
    if (name !== "Map" && name !== "Set" && name !== "ReadonlyMap" && name !== "ReadonlySet")
      return false;
    return (
      (symbol.flags & ts.SymbolFlags.Class) === 0 &&
      symbol.declarations.length > 0 &&
      symbol.declarations.every(
        (declaration) => ts.getSourceFileOfNode(declaration).isDeclarationFile,
      )
    );
  }

  /** A builtin collection with an `any` or `unknown` type argument is
   * UNTYPED (`new Map()`). It cannot back a structural view narrower than
   * the values it may yield — `get` answers `any`, which the view declares
   * as its own member type — so it keeps the record-shape refusal rather
   * than carrying identity into the view. */
  private isUntypedCollection(type: ts.Type): boolean {
    if (!type.isTypeReference()) return true;
    const args = this.checker.getTypeArguments(type);
    return (
      args.length === 0 ||
      args.some((arg) => (arg.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0)
    );
  }

  /** A lib Error, TypeError, ... instance type (RUNTIME_ERROR_CLASSES' lib
   * names). Its fields are writable and its checked-dynamic view is the
   * error itself, so a record built from it would miss later writes. */
  private isBuiltinError(type: ts.Type): boolean {
    if ((type.flags & ts.TypeFlags.Object) === 0) return false;
    const symbol = type.getSymbol();
    if (symbol === undefined) return false;
    if (!ERROR_LIB_NAMES.has(ts.symbolName(symbol))) return false;
    return (
      (symbol.flags & ts.SymbolFlags.Class) === 0 &&
      symbol.declarations.length > 0 &&
      symbol.declarations.every(
        (declaration) => ts.getSourceFileOfNode(declaration).isDeclarationFile,
      )
    );
  }

  /** An instance of a class the standard library or a declaration package
   * provides: a type whose symbol is also a value (`class URL`, or the lib's
   * `interface Date` with `declare var Date`) and is declared only in
   * declaration files. A pure library interface (a data shape such as
   * `PropertyDescriptor`) has no value side and is not one. */
  private isLibraryClassInstance(type: ts.Type): boolean {
    const symbol = type.getSymbol();
    if (symbol === undefined) return false;
    if (
      (symbol.flags &
        (ts.SymbolFlags.Class | ts.SymbolFlags.Variable | ts.SymbolFlags.Function)) ===
      0
    )
      return false;
    return (
      symbol.declarations.length > 0 &&
      symbol.declarations.every(
        (declaration) => ts.getSourceFileOfNode(declaration).isDeclarationFile,
      )
    );
  }

  private isProgramClassInstance(type: ts.Type): boolean {
    const symbol = type.getSymbol();
    return (
      symbol !== undefined &&
      (symbol.flags & ts.SymbolFlags.Class) !== 0 &&
      symbol.declarations.some(
        (declaration) => !ts.getSourceFileOfNode(declaration).isDeclarationFile,
      ) &&
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
    if (this.isProgramClassInstance(type)) return true;
    // A Map or Set is a live collection: a record built from it answers the
    // members it copies once and misses every later write. An untyped
    // `new Map()` cannot back a narrower view (see isUntypedCollection), so
    // only a fully typed collection carries identity into the view.
    if (this.isBuiltinCollection(type)) return !this.isUntypedCollection(type);
    // A builtin Error keeps its own identity too: extra fields the program
    // puts on it (a status, a body) belong to the error, not to a copy.
    if (this.isBuiltinError(type)) return true;
    // A live Pick or Omit view of a program class holds the instance itself.
    if (this.pickOfProgramClass(type) && this.usesCheckedIdentity(type)) return true;
    // A homomorphic mapped view of a marked type is the live view itself.
    if (this.mappedViewSource(type) !== null && this.protocol(type)) return true;
    const symbol = type.getSymbol();
    if (symbol === undefined) return false;
    if (marked.has(symbol)) return true;
    // A program interface a class matches by its methods (protocol below).
    return (
      this.methods.size > 0 &&
      symbol.declarations.some(
        (declaration) =>
          ts.isInterfaceDeclaration(declaration) &&
          !ts.getSourceFileOfNode(declaration).isDeclarationFile,
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
    const symbol = type.getSymbol();
    if (symbol === undefined || (symbol.flags & ts.SymbolFlags.Class) !== 0) return false;
    const declarations = symbol.declarations;
    return (
      declarations.length > 0 &&
      declarations.every((declaration) => !ts.getSourceFileOfNode(declaration).isDeclarationFile)
    );
  }

  /** Marks the structural parts of `target` that the identity-carrying
   * parts of `source` flow into. Answers whether anything new was marked. */
  private markTarget(
    source: ts.Type,
    target: ts.Type,
    marked: Set<ts.Symbol>,
    site: { node: ts.CallExpression | ts.NewExpression; index: number } | null,
    record: boolean,
  ): boolean {
    if (source.isUnionType()) {
      let changed = false;
      for (const part of ts.constituentTypes(source))
        if (
          this.carriesIdentity(part, marked) &&
          this.markTarget(part, target, marked, site, false)
        )
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
      for (const part of accepting)
        if (this.markTarget(source, part, marked, site, false)) changed = true;
      return changed;
    }
    if (this.checker.isArrayType(source) && this.checker.isArrayType(target)) {
      const [from] = this.checker.getTypeArguments(source as ts.TypeReference);
      const [to] = this.checker.getTypeArguments(target as ts.TypeReference);
      return (
        from !== undefined && to !== undefined && this.markTarget(from, to, marked, site, false)
      );
    }
    if (!this.isStructuralTarget(target)) return false;
    const symbol = target.getSymbol();
    if (symbol === undefined) return false;
    const from = source.getSymbol();
    if (from === symbol) return false;
    const facts = this.facts;
    let collectionGrew = false;
    if (facts !== null) {
      // A Map or Set that reaches the view, which answers one of its
      // members: a record copy has no live backing behind `has`, `get` or
      // `size`, and Node's answer changes with every later write. The view
      // keeps checked identity, but not protocol dispatch: its members are
      // the collection's own methods. A collection view's value handed on
      // to another structural type is the same collection, so that view
      // answers through it too.
      const collection = this.isBuiltinCollection(source)
        ? this.exposesCollectionMember(
            source,
            new Set(
              this.checker.getPropertiesOfType(target).map((property) => ts.symbolName(property)),
            ),
          )
        : from !== undefined && this.collectionViews.has(from);
      if (collection && !this.collectionViews.has(symbol)) {
        this.collectionViews.add(symbol);
        collectionGrew = true;
      }
      // The flow: the source's classes and marked type reach `symbol`.
      const origins = facts.origins.get(symbol) ?? new Set<ts.Symbol>();
      for (const origin of this.originsOf(source, facts)) origins.add(origin);
      facts.origins.set(symbol, origins);
      if (!facts.targets.has(symbol)) facts.targets.set(symbol, target);
      if (from !== undefined && marked.has(from)) {
        const flows = facts.flows.get(from) ?? new Set<ts.Symbol>();
        flows.add(symbol);
        facts.flows.set(from, flows);
      }
    }
    if (facts !== null) {
      // Every top-level site that reaches this view is remembered: a view
      // whose values only ever arrive as a call argument the callee reads can
      // keep the record shape its type declares (copiedAtEverySite).
      if (site === null || !record) facts.otherSites.add(symbol);
      else {
        const recorded = facts.callSites.get(symbol) ?? [];
        if (!recorded.some((entry) => entry.node === site.node && entry.index === site.index))
          recorded.push({ node: site.node, index: site.index, source });
        facts.callSites.set(symbol, recorded);
      }
    }
    // A view marked earlier that becomes a collection view still changes
    // the fixpoint: the views its values flow into are asked again.
    if (marked.has(symbol)) return collectionGrew;
    marked.add(symbol);
    return true;
  }

  /** Whether `type` is a structural view that a Map or Set reaches and that
   * answers through the collection's own methods (see markIdentityFlows).
   * Such a view keeps checked identity but never protocol dispatch: there
   * is no stored member to read, and the collection answers the call. */
  collectionView(type: ts.Type): boolean {
    this.index();
    if (type.isUnionType() || type.isIntersectionType())
      return ts.constituentTypes(type).some((part) => this.collectionView(part));
    const symbol = type.getSymbol();
    return symbol !== undefined && this.collectionViews.has(symbol);
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
    // A dictionary keeps checked identity when the protocols already mark
    // it (a literal whose methods read `this`) or when it receives existing
    // objects (markDictionaryViews).
    const dictionaryValue = this.dictionaryValueType(type);
    const view = type.getSymbol();
    const answer =
      this.protocol(type) ||
      (dictionaryValue !== undefined && this.dictionaryViews.has(dictionaryValue)) ||
      // A record view of a Map or Set answers through the collection itself.
      (view !== undefined && this.collectionViews.has(view));
    this.answers.set(type, answer);
    return answer;
  }

  private protocol(type: ts.Type): boolean {
    const protocols = this.index();
    const symbol = type.getSymbol();
    const properties = this.checker.getPropertiesOfType(type);
    if (symbol && protocols.has(symbol)) return true;
    // A mapped view whose source cannot carry the marking was recorded
    // itself (index): the receiver-dependent literal typed as it needs the
    // live object, and no other view of that source does.
    if (this.literalViews.has(type)) return true;
    // A program type that receives island values, recorded by the type
    // itself because it has no symbol to mark (markIslandView).
    if (this.islandViews.has(type)) return true;
    // A homomorphic mapped view (Partial, Pick, Omit, Readonly) has no
    // symbol of its own to mark, so it is a view exactly when the type it
    // maps is one.
    const mapped = this.mappedViewSource(type);
    if (mapped !== null && this.protocol(mapped)) return true;
    if (
      !this.pickOfProgramClass(type) &&
      (!symbol ||
        !symbol.declarations.some(
          (declaration) =>
            ts.isInterfaceDeclaration(declaration) &&
            !ts.getSourceFileOfNode(declaration).isDeclarationFile,
        ))
    )
      return false;
    for (const property of properties) {
      const memberType = this.checker.getTypeOfSymbol(property);
      if (this.checker.getCallSignatures(memberType).length === 0) continue;
      for (const declaration of this.methods.get(ts.symbolName(property)) ?? []) {
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

/** How deep markReceivedView follows composites and members. The set of
 * answered types ends every finite cycle; the bound ends a generic that
 * names a larger instance of itself in a member (`next: List<T[]>`), and
 * what lies beyond it stays a native record, which the crossing refuses by
 * name. */
const RECEIVED_VIEW_DEPTH = 32;

/** The library objects a view of an island object holds as they are: byte
 * views share their memory with the island's (viewKept). */
const VIEWED_LIBRARY_OBJECTS: ReadonlySet<string> = new Set([
  "ArrayBuffer",
  "SharedArrayBuffer",
  "Buffer",
  "DataView",
  "Int8Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Int16Array",
  "Uint16Array",
  "Int32Array",
  "Uint32Array",
  "Float32Array",
  "Float64Array",
  "BigInt64Array",
  "BigUint64Array",
]);

/** How deep declarationFileType looks into unions and element types. */
const DECLARATION_FILE_TYPE_DEPTH = 4;

/** The operators whose value is one of their operands. */
const VALUE_SELECTING: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.QuestionQuestionToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.AmpersandAmpersandToken,
]);

/** `structuredClone(value)`: the program states the copy. */
function isStructuredClone(call: ts.CallExpression | ts.NewExpression): boolean {
  return ts.isIdentifier(call.expression) && call.expression.text === "structuredClone";
}

/** How many rounds followIslandFlows runs at most: each round follows an
 * island value one more call or return further, and a program hands one
 * through only a few of its own functions before it types it. */
const ISLAND_FLOW_ROUNDS = 8;

interface FlowFacts {
  /** Types whose values reach identity comparisons, Set/Map keys, array
   * searches or whole-object observers. */
  observed: Set<ts.Symbol>;
  /** Member names written after construction, per receiver type. */
  written: Map<ts.Symbol, Set<string> | "all">;
  /** Call arguments that may reach an any-value parameter. */
  loose: {
    node: ts.Expression;
    call: ts.CallExpression | ts.NewExpression;
    symbols: Set<ts.Symbol>;
  }[];
  /** Generic functions and classes that observe a type parameter's values. */
  genericObservers: Set<ts.Node>;
  /** Class families (see classFamily). */
  bases: Map<ts.Symbol, ts.Symbol[]>;
  /** The classes behind each marked structural type. */
  origins: Map<ts.Symbol, Set<ts.Symbol>>;
  /** A target type per marked symbol, for its member names. */
  targets: Map<ts.Symbol, ts.Type>;
  /** The marked types each marked type's values flow into. */
  flows: Map<ts.Symbol, Set<ts.Symbol>>;
  /** The call arguments that mark each symbol: the call, the position, and
   * the argument's type (copiedAtEverySite). */
  callSites: Map<
    ts.Symbol,
    { node: ts.CallExpression | ts.NewExpression; index: number; source: ts.Type }[]
  >;
  /** Symbols some mark reaches through something other than a call
   * argument: a variable, a field, a return, an array element. */
  otherSites: Set<ts.Symbol>;
}

/** The empty answer of the symbol maps above. */
const NO_SYMBOLS: ReadonlySet<ts.Symbol> = new Set();

/** The lib names RUNTIME_ERROR_CLASSES gives the runtime error encoding
 * (`%Error`, `%TypeError`, ...; ir.ts). */
const ERROR_LIB_NAMES = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "DOMException",
  "ReferenceError",
  "EvalError",
  "URIError",
  "AggregateError",
  "AssertionError",
  "SuppressedError",
]);

/** Calls of these namespaces and functions observe whole objects. */
const OBSERVER_NAMESPACES = new Set(["console", "JSON", "Object", "Reflect", "util", "assert"]);
const OBSERVER_FUNCTIONS = new Set([
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
/** Constructors that key their arguments' values by identity. */
const IDENTITY_CONSTRUCTORS = new Set(["Set", "Map", "WeakSet", "WeakMap", "WeakRef"]);
/** Object statics that write their first argument. */
const OBJECT_WRITERS = new Set(["assign", "defineProperty", "defineProperties", "setPrototypeOf"]);
/** Methods that compare their arguments by identity (Set, Map, WeakMap,
 * WeakSet and array searches). */
const IDENTITY_METHODS = new Set([
  "add",
  "has",
  "delete",
  "set",
  "get",
  "indexOf",
  "lastIndexOf",
  "includes",
]);

/** The values a function expression answers: an arrow's expression body,
 * or the operands of its own return statements. */
function functionResults(fn: ts.ArrowFunction | ts.FunctionExpression): ts.Expression[] {
  if (!ts.isBlock(fn.body)) return [fn.body];
  const results: ts.Expression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node) || ts.isClassLikeDeclaration(node)) return;
    if (ts.isReturnStatement(node) && node.expression !== undefined) results.push(node.expression);
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(fn.body, visit);
  return results;
}

/** An expression that denotes an object that already exists, not a fresh
 * literal or call result. */
function isExistingObject(node: ts.Expression): boolean {
  return (
    ts.isIdentifier(node) ||
    ts.isPropertyAccessExpression(node) ||
    ts.isElementAccessExpression(node) ||
    node.kind === ts.SyntaxKind.ThisKeyword
  );
}

/** `{}`, `object` and `unknown`: types whose values are checked-dynamic
 * and keep the original object. */
function isDynamicView(checker: ts.TypeChecker, type: ts.Type): boolean {
  if (type.flags & (ts.TypeFlags.Unknown | ts.TypeFlags.NonPrimitive)) return true;
  return (
    (type.flags & ts.TypeFlags.Object) !== 0 &&
    checker.getPropertiesOfType(type).length === 0 &&
    checker.getIndexInfosOfType(type).length === 0 &&
    checker.getCallSignatures(type).length === 0 &&
    checker.getConstructSignatures(type).length === 0
  );
}

/** The name calls use for a function, method or function-valued binding. */
function functionName(fn: ts.Node): string | undefined {
  if ((ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn)) && fn.name !== undefined)
    return ts.isIdentifier(fn.name) ? fn.name.text : undefined;
  if (
    (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) &&
    fn.parent !== undefined &&
    ts.isVariableDeclaration(fn.parent) &&
    ts.isIdentifier(fn.parent.name)
  )
    return fn.parent.name.text;
  return undefined;
}

function isNullishLiteral(node: ts.Expression): boolean {
  while (ts.isParenthesizedExpression(node)) node = node.expression;
  return (
    node.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isIdentifier(node) && node.text === "undefined") ||
    ts.isVoidExpression(node)
  );
}

/** A literal or `typeof` operand, which cannot hold an object. */
function isPrimitiveLiteral(node: ts.Expression): boolean {
  while (ts.isParenthesizedExpression(node)) node = node.expression;
  return (
    ts.isStringLiteralLike(node) ||
    ts.isNumericLiteral(node) ||
    ts.isBigIntLiteral(node) ||
    ts.isTypeOfExpression(node) ||
    node.kind === ts.SyntaxKind.TrueKeyword ||
    node.kind === ts.SyntaxKind.FalseKeyword ||
    ts.isTemplateExpression(node)
  );
}

/** The class whose instance `this` is at `node`: the nearest enclosing
 * class, unless a non-arrow function rebinds `this` first. */
function thisClass(node: ts.Node): ts.ClassLikeDeclaration | undefined {
  for (let cur = node.parent; cur !== undefined; cur = cur.parent) {
    if (ts.isClassDeclaration(cur) || ts.isClassExpression(cur)) return cur;
    if (ts.isFunctionDeclaration(cur) || ts.isFunctionExpression(cur)) return undefined;
  }
  return undefined;
}

/** Whether `node` sits directly in a constructor body (not in a nested
 * function). */
function inConstructor(node: ts.Node): boolean {
  for (let cur = node.parent; cur !== undefined; cur = cur.parent) {
    if (ts.isConstructorDeclaration(cur)) return true;
    if (ts.isFunctionLike(cur) || ts.isClassDeclaration(cur) || ts.isClassExpression(cur))
      return false;
  }
  return false;
}

/** SCRIPTC_NODE_ISLANDS_TRACE=views at build time prints each assertion
 * applied to an island value, whose asserted type becomes a view: the sites
 * where a program that copied on an assertion now reads through the handle. */
function traceIslandViews(crossings: readonly ts.Expression[]): void {
  const trace = process.env["SCRIPTC_NODE_ISLANDS_TRACE"];
  if (trace === undefined || !trace.includes("views")) return;
  for (const crossing of crossings) {
    if (!ts.isAssertionExpression(crossing)) continue;
    const source = ts.getSourceFileOfNode(crossing);
    const { line } = ts.getLineAndCharacterOfPosition(source, ts.tokenStartOfNode(crossing));
    process.stderr.write(`[node-islands] view assertion ${source.fileName}:${line + 1}\n`);
  }
}

/** The names a file's imports and top-level `require` declarations bind. */
function importBoundNames(source: ts.SourceFile): ReadonlySet<string> {
  const names = new Set<string>();
  const bound = (name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) names.add(name.text);
    else if (ts.isObjectBindingPattern(name))
      for (const element of name.elements.nodes)
        if (element.name !== undefined) bound(element.name);
  };
  for (const statement of source.statements.nodes) {
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      if (clause === undefined || clause.isTypeOnly) continue;
      if (clause.name !== undefined) names.add(clause.name.text);
      const named = clause.namedBindings;
      if (named === undefined) continue;
      if (ts.isNamespaceImport(named)) names.add(named.name.text);
      else for (const element of named.elements.nodes) names.add(element.name.text);
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations.nodes) {
        let init = declaration.initializer;
        while (init !== undefined && ts.isParenthesizedExpression(init)) init = init.expression;
        if (
          init !== undefined &&
          ts.isCallExpression(init) &&
          ts.isIdentifier(init.expression) &&
          init.expression.text === "require"
        )
          bound(declaration.name);
      }
    }
  }
  return names;
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

/** Ground numeric calls: they cannot run program code, so a callee that
 * only uses them cannot observe a write to an instance it was handed. */
const PURE_CALLS = new Set(["parseInt", "parseFloat", "isNaN", "isFinite"]);

/** The identifier names a member (`o.value`), not the binding `o`. */
function isMemberName(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (parent === undefined || ts.isShorthandPropertyAssignment(parent)) return false;
  if ((parent as ts.Node & { name?: ts.Node }).name === node) return true;
  return ts.isBindingElement(parent) && parent.propertyName === node;
}

/** The node with parentheses, non-null assertions and type assertions
 * peeled off. */
function unwrapExpression(node: ts.Node): ts.Node {
  let outer = node;
  for (;;) {
    const parent = outer.parent;
    if (parent === undefined) return outer;
    if (
      !ts.isParenthesizedExpression(parent) &&
      !ts.isNonNullExpression(parent) &&
      !ts.isAssertionExpression(parent)
    )
      return outer;
    outer = parent;
  }
}

/** A number, string, boolean, bigint, null or undefined (or a union of
 * them): a value a record copy carries by value. */
function primitiveValue(type: ts.Type): boolean {
  if (type.isUnionType()) return ts.constituentTypes(type).every(primitiveValue);
  return (
    (type.flags &
      (ts.TypeFlags.Number |
        ts.TypeFlags.NumberLiteral |
        ts.TypeFlags.String |
        ts.TypeFlags.StringLiteral |
        ts.TypeFlags.Boolean |
        ts.TypeFlags.BooleanLiteral |
        ts.TypeFlags.BigInt |
        ts.TypeFlags.BigIntLiteral |
        ts.TypeFlags.Null |
        ts.TypeFlags.Undefined)) !==
    0
  );
}

/** Whether the property read `access` is assigned, updated or deleted. */
function isWrittenAccess(access: ts.Expression): boolean {
  let outer: ts.Node = access;
  for (;;) {
    const parent = outer.parent;
    if (
      parent !== undefined &&
      (ts.isParenthesizedExpression(parent) || ts.isNonNullExpression(parent))
    ) {
      outer = parent;
      continue;
    }
    if (parent === undefined) return false;
    if (ts.isBinaryExpression(parent))
      return (
        parent.left === outer &&
        parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      );
    if (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent))
      return parent.operand === outer;
    return ts.isDeleteExpression(parent);
  }
}

/** Whether `call` is one of the calls a copying callee may make: a numeric
 * builtin or console printer the program does not shadow, over values of
 * primitive type only (a coercion runs no hook on them). */
function pureCall(call: ts.CallExpression, checker: ts.TypeChecker): boolean {
  const callee = call.expression;
  const global = (node: ts.Node) => libSymbol(attempt(() => checker.getSymbolAtLocation(node)));
  if (ts.isIdentifier(callee)) {
    if (!PURE_CALLS.has(callee.text) || !global(callee)) return false;
  } else if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
    const owner = callee.expression.text;
    if (owner !== "Math" && owner !== "Number" && owner !== "console") return false;
    if (!global(callee.expression) || !global(callee.name)) return false;
  } else return false;
  const args = call.arguments?.nodes ?? [];
  return args.every((argument) => {
    if (ts.isSpreadElement(argument)) return false;
    const type = attempt(() => checker.getTypeAtLocation(argument));
    return type !== undefined && primitiveValue(type);
  });
}

/** Whether every declaration of `symbol` is in a declaration file: the
 * binding is the library's own, not one the program shadows it with. */
function libSymbol(symbol: ts.Symbol | undefined): boolean {
  const declarations = symbol?.declarations;
  return (
    declarations !== undefined &&
    declarations.length > 0 &&
    declarations.every((declaration) => declaration.getSourceFile().isDeclarationFile)
  );
}

/** Whether evaluating `node` can run program code — a call, a constructor, a
 * getter or a dynamic member read, an iterator, a coercion hook — and so
 * write an instance a copy was made of. */
function expressionRunsCode(node: ts.Node, checker: ts.TypeChecker): boolean {
  if (ts.isCallExpression(node)) return !pureCall(node, checker);
  if (ts.isNewExpression(node)) return true;
  if (ts.isElementAccessExpression(node)) return true;
  if (ts.isPropertyAccessExpression(node)) return accessRunsCode(node, checker);
  if (ts.isTemplateExpression(node)) {
    for (const span of node.templateSpans.nodes)
      if (!primitiveNode(span.expression, checker)) return true;
    return false;
  }
  if (ts.isBinaryExpression(node)) {
    const operator = node.operatorToken.kind;
    if (operator === ts.SyntaxKind.InstanceOfKeyword) return true;
    if (operator >= ts.SyntaxKind.FirstAssignment && operator <= ts.SyntaxKind.LastAssignment)
      return true;
    return !primitiveOperands(node.left, node.right, checker);
  }
  if (ts.isPrefixUnaryExpression(node)) {
    const operator = node.operator;
    if (operator === ts.SyntaxKind.PlusPlusToken || operator === ts.SyntaxKind.MinusMinusToken)
      return true;
    if (
      operator !== ts.SyntaxKind.PlusToken &&
      operator !== ts.SyntaxKind.MinusToken &&
      operator !== ts.SyntaxKind.TildeToken
    )
      return false;
    return !primitiveNode(node.operand, checker);
  }
  if (ts.isPostfixUnaryExpression(node)) return true;
  if (ts.isDeleteExpression(node) || ts.isAwaitExpression(node) || ts.isYieldExpression(node))
    return true;
  if (ts.isTaggedTemplateExpression(node)) return true;
  if (ts.isForOfStatement(node)) return true;
  if (ts.isSpreadElement(node) || ts.isSpreadAssignment(node)) return true;
  return false;
}

/** Whether reading `access` can run program code: a getter, or a member of
 * a value the analysis knows nothing static about. */
function accessRunsCode(access: ts.PropertyAccessExpression, checker: ts.TypeChecker): boolean {
  const symbol = attempt(() => checker.getSymbolAtLocation(access.name));
  if (symbol === undefined) return true;
  if ((symbol.flags & (ts.SymbolFlags.GetAccessor | ts.SymbolFlags.SetAccessor)) !== 0) return true;
  const receiver = valueType(access.expression, checker);
  if (receiver === undefined) return true;
  return (
    (receiver.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter)) !== 0
  );
}

/** Whether both operand types are primitive, so an operator between them
 * runs no value coercion. */
function primitiveOperands(
  left: ts.Expression,
  right: ts.Expression,
  checker: ts.TypeChecker,
): boolean {
  return primitiveNode(left, checker) && primitiveNode(right, checker);
}

/** The type of `node`'s value, ignoring parentheses, non-null assertions and
 * type assertions: a cast does not change what the value is at run time. */
function valueType(node: ts.Expression, checker: ts.TypeChecker): ts.Type | undefined {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isAssertionExpression(current)
  )
    current = current.expression;
  return attempt(() => checker.getTypeAtLocation(current));
}

/** Whether the value of `node` has a primitive type, so coercing it runs no
 * value hook. */
function primitiveNode(node: ts.Expression, checker: ts.TypeChecker): boolean {
  const type = valueType(node, checker);
  return type !== undefined && primitiveValue(type);
}

/** Whether `root` contains an expression that runs program code. */
function containsProgramCode(root: ts.Node, checker: ts.TypeChecker): boolean {
  let runs = false;
  ts.walkPreorder(root, (node) => {
    if (runs) return "stop";
    if (ts.isTypeNode(node)) return "skip";
    if (ts.isFunctionLike(node)) return "skip";
    // A class body's computed keys and static fields run when the class is
    // evaluated.
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      runs = true;
      return "stop";
    }
    if (expressionRunsCode(node, checker)) {
      runs = true;
      return "stop";
    }
    return undefined;
  });
  return runs;
}

/** Whether `node` mentions the binding `name`. */
function mentionsBinding(node: ts.Node, name: string): boolean {
  let found = false;
  ts.walkPreorder(node, (child) => {
    if (found) return "stop";
    if (ts.isIdentifier(child) && child.text === name && !isMemberName(child)) {
      found = true;
      return "stop";
    }
    return undefined;
  });
  return found;
}

/** The static property name a member declares, or null for a computed key
 * (its name is not a compile-time fact). */
function propertyNameText(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  if (ts.isNumericLiteral(name)) return String(Number(name.text));
  return null;
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
