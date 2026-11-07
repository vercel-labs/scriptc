/* Which async-iteration protocol types of a program hold a value that is not
 * a compiled async generator.
 *
 * `AsyncIterable<T>`, `AsyncIterableIterator<T>` and `AsyncIterator<T>` name
 * a protocol any object can implement. The value they hold is a compiled
 * async generator unless the program moves something else into one of them:
 * an instance of a class or an object literal with its own
 * Symbol.asyncIterator, a value of a Node island's type, an untyped value.
 * Only then is the type's value the checked-dynamic one, whose `for await`
 * runs the runtime's protocol; every other protocol type keeps the generator
 * and its typed stepping. The answer is per element type: the three
 * interfaces over one `T` hold each other's values.
 *
 * The decision is made before any lowering, from the program alone: a scan
 * of the places a value flows into a typed slot (the flow sites
 * class-protocols.ts scans for identity), read with the checker. A site
 * whose source may be such a value marks the element types of the protocol
 * types its target holds, and a marked protocol type flowing into another
 * marks that one too. A flow the scan does not see leaves its target a
 * generator slot, where the value is refused by name when it is lowered.
 *
 * The scan runs when the mapper first meets one of the three interfaces, so
 * a program that names none of them never pays for it. */
import * as ts from "../ts7/adapter.js";

const PROTOCOL_NAMES: ReadonlySet<string> = new Set([
  "AsyncIterable",
  "AsyncIterableIterator",
  "AsyncIterator",
]);

/** A place a value flows into a slot. */
interface FlowSite {
  source: ts.Expression;
  /** The node whose contextual type is the slot's type. */
  contextual?: ts.Expression;
  /** The slot's type, when it is not a contextual type. */
  target?: () => ts.Type | undefined;
}

/** What a flow's source may hold. */
interface SourceKinds {
  /** A value no compiled async generator is. */
  implementor: boolean;
  /** The element types of the protocol types it is typed as. */
  elements: ts.Type[];
}

/** A checker query that may hit an upstream checker panic: the scan skips a
 * site it cannot type rather than failing the build. */
function attempt<T>(query: () => T): T | undefined {
  try {
    return query();
  } catch {
    return undefined;
  }
}

export class AsyncProtocolHolders {
  /** The element types whose protocol types hold a checked-dynamic value. */
  private marked: Set<ts.Type> | null = null;
  /** A flow reached a protocol type over an unbound type parameter, which
   * stands for every element type its instances bind. */
  private every = false;
  /** Whether a type's own members implement the protocol, by its symbol (or
   * by the type, for one without a symbol). */
  private readonly implementors = new Map<ts.Symbol | ts.Type, boolean>();
  /** The flow sites the scan read and the time it took, for the timing
   * line. */
  sites = 0;
  elapsedMs = 0;

  constructor(
    private readonly checker: ts.TypeChecker,
    private readonly sources: readonly ts.SourceFile[],
    private readonly isStdlibFile: (sf: ts.SourceFile) => boolean,
  ) {}

  /** Whether the protocol types over `element` hold the checked-dynamic
   * value. `element` is the interface's type argument with the type
   * parameters of a generic instance already bound. */
  holds(element: ts.Type | undefined): boolean {
    const marked = this.index();
    return this.every || (element !== undefined && marked.has(element));
  }

  /** How many element types are marked (every one counts as -1). */
  get markedCount(): number {
    return this.every ? -1 : (this.marked?.size ?? 0);
  }

  private index(): Set<ts.Type> {
    if (this.marked !== null) return this.marked;
    const marked = new Set<ts.Type>();
    this.marked = marked;
    const started = performance.now();
    this.scan(marked);
    this.elapsedMs = Math.round((performance.now() - started) * 10) / 10;
    return marked;
  }

  private scan(marked: Set<ts.Type>): void {
    const sites = this.collect();
    this.sites = sites.length;
    if (sites.length === 0) return;
    const sourceNodes = sites.map((site) => flowSourceNode(site.source));
    // One batched round trip for the sources: most sit in bodies whose
    // reachability is not known yet, so nothing has prefetched them.
    attempt(() => this.checker.prefetchClassCollection(sourceNodes, []));
    const kinds: (SourceKinds | null)[] = sourceNodes.map((node) => {
      const type = attempt(() => this.checker.getTypeAtLocation(node));
      return type === undefined ? null : this.sourceKinds(type);
    });
    // Only a site whose source can matter asks for its target.
    attempt(() =>
      this.checker.prefetchContextualTypes(
        sites.flatMap((site, i) =>
          kinds[i] !== null && site.contextual !== undefined ? [site.contextual] : [],
        ),
      ),
    );
    /** A protocol type's element flows into another's. */
    const edges: [ts.Type, ts.Type][] = [];
    for (let i = 0; i < sites.length; i++) {
      const source = kinds[i];
      if (source === null || source === undefined) continue;
      const site = sites[i]!;
      const target = attempt(() =>
        site.contextual !== undefined
          ? this.checker.getContextualType(site.contextual)
          : site.target?.(),
      );
      if (target === undefined) continue;
      const elements: ts.Type[] = [];
      this.protocolElements(target, 0, elements);
      for (const element of elements) {
        if (source.implementor) this.mark(element);
        for (const from of source.elements) if (from !== element) edges.push([from, element]);
      }
    }
    for (let changed = edges.length > 0 && !this.every; changed;) {
      changed = false;
      for (const [from, to] of edges) {
        if (!marked.has(from) || marked.has(to)) continue;
        this.mark(to);
        changed = true;
      }
    }
  }

  private mark(element: ts.Type): void {
    if ((element.flags & ts.TypeFlags.TypeParameter) !== 0) this.every = true;
    this.marked!.add(element);
  }

  /** The lib interface `type` refers to, by name, or null. */
  private libInterface(type: ts.Type): string | null {
    const symbol = type.getSymbol();
    if (symbol === undefined) return null;
    return symbol.declarations.some(
      (d) => ts.isInterfaceDeclaration(d) && this.isStdlibFile(ts.getSourceFileOfNode(d)),
    )
      ? ts.symbolName(symbol)
      : null;
  }

  /** The element types of the protocol types a slot of type `type` holds:
   * the type itself, an arm of its union, or what its promise settles to. */
  private protocolElements(type: ts.Type, depth: number, out: ts.Type[]): void {
    if (type.isUnionType()) {
      for (const arm of ts.constituentTypes(type)) this.protocolElements(arm, depth, out);
      return;
    }
    if ((type.flags & ts.TypeFlags.Object) === 0) return;
    const name = this.libInterface(type);
    if (name === null) return;
    const argument = (): ts.Type | undefined =>
      this.checker.getTypeArguments(type as ts.TypeReference)[0];
    if (PROTOCOL_NAMES.has(name)) {
      const element = argument();
      if (element !== undefined && !out.includes(element)) out.push(element);
    } else if ((name === "Promise" || name === "PromiseLike") && depth < 2) {
      const settled = argument();
      if (settled !== undefined) this.protocolElements(settled, depth + 1, out);
    }
  }

  /** What a value of type `type` may be, or null when it can be neither an
   * implementor nor a protocol-typed value. */
  private sourceKinds(type: ts.Type): SourceKinds | null {
    const kinds: SourceKinds = { implementor: false, elements: [] };
    const visit = (part: ts.Type, depth: number): void => {
      if (part.isUnionType()) {
        for (const arm of ts.constituentTypes(part)) visit(arm, depth);
        return;
      }
      if (
        (part.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter)) !==
        0
      ) {
        kinds.implementor = true;
        return;
      }
      if ((part.flags & (ts.TypeFlags.Object | ts.TypeFlags.Intersection)) === 0) return;
      const name = this.libInterface(part);
      if (name !== null) {
        // The generator object an `async *` function returns.
        if (name === "AsyncGenerator") return;
        const argument = this.checker.getTypeArguments(part as ts.TypeReference)[0];
        if (PROTOCOL_NAMES.has(name)) {
          if (argument !== undefined && !kinds.elements.includes(argument))
            kinds.elements.push(argument);
          return;
        }
        if ((name === "Promise" || name === "PromiseLike") && depth < 2) {
          if (argument !== undefined) visit(argument, depth + 1);
          return;
        }
      }
      if (this.implementsProtocol(part)) kinds.implementor = true;
    };
    visit(type, 0);
    return kinds.implementor || kinds.elements.length > 0 ? kinds : null;
  }

  /** Whether the type's own members implement the protocol: a
   * Symbol.asyncIterator member (an async iterable) or a `next` member (an
   * async iterator). */
  private implementsProtocol(type: ts.Type): boolean {
    const key = type.getSymbol() ?? type;
    const known = this.implementors.get(key);
    if (known !== undefined) return known;
    const answer =
      attempt(() =>
        this.checker.getPropertiesOfType(type).some((property) => {
          const name = ts.symbolName(property);
          return name === "next" || name.startsWith("__@asyncIterator@");
        }),
      ) ?? true;
    this.implementors.set(key, answer);
    return answer;
  }

  /** The program's flow sites: the same places class-protocols.ts reads for
   * values that carry identity. */
  private collect(): FlowSite[] {
    const sites: FlowSite[] = [];
    const flow = (expr: ts.Expression | undefined): void => {
      if (expr !== undefined) sites.push({ source: expr, contextual: expr });
    };
    const declared = (name: ts.Node, initializer: ts.Expression | undefined): void => {
      if (initializer !== undefined)
        sites.push({ source: initializer, target: () => this.checker.getTypeAtLocation(name) });
    };
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        for (const argument of node.arguments?.nodes ?? [])
          if (!ts.isSpreadElement(argument)) flow(argument);
      } else if (ts.isVariableDeclaration(node) && node.type !== undefined)
        declared(node.name, node.initializer);
      else if (ts.isPropertyDeclaration(node) && node.type !== undefined)
        declared(node.name, node.initializer);
      else if (ts.isParameter(node) && node.type !== undefined)
        declared(node.name, node.initializer);
      else if (ts.isReturnStatement(node)) flow(node.expression);
      else if (ts.isArrowFunction(node) && !ts.isBlock(node.body)) flow(node.body);
      else if (ts.isYieldExpression(node)) flow(node.expression);
      else if (ts.isArrayLiteralExpression(node)) {
        for (const element of node.elements.nodes)
          if (!ts.isSpreadElement(element) && !ts.isOmittedExpression(element)) flow(element);
      } else if (ts.isPropertyAssignment(node)) flow(node.initializer);
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
      } else if (ts.isAsExpression(node) || ts.isTypeAssertion(node)) {
        const typeNode = node.type;
        sites.push({
          source: node.expression,
          target: () => this.checker.getTypeFromTypeNode(typeNode),
        });
      }
      ts.forEachChild(node, visit);
    };
    for (const source of this.sources) if (!source.isDeclarationFile) visit(source);
    return sites;
  }
}

/** The expression a flow's value comes from: inside parentheses and
 * non-null assertions. */
function flowSourceNode(expr: ts.Expression): ts.Expression {
  let inner = expr;
  while (ts.isParenthesizedExpression(inner) || ts.isNonNullExpression(inner))
    inner = inner.expression;
  return inner;
}
