import { InternalCompilerError } from "../../errors.js";
import { isCheckerPanic } from "../../diagnostics/diagnostic.js";
/* The checker facade: 5.9.3-shaped TypeChecker methods over 7.0.2's sync
 * client, built around the survey's feasibility verdict. Naive per-call use
 * of the 7.0.2 client costs 0.1-0.3 ms of IPC per query; the census counted
 * 32,226 checker calls lowering mock-gateway, so a transparent adapter would
 * add seconds. Batched, the same queries run at ~0.005 ms/call — parity with
 * 5.9.3. Three mechanisms make batching and reuse the DEFAULT path:
 *
 * 1. IDENTITY MEMOS. One WeakMap per query kind, keyed on the client-side
 *    node/type/symbol object. Safe because the 7.0.2 client registry dedupes
 *    by server handle id (probe-verified: the same symbol/type from any two
 *    queries is the same object), and a snapshot is immutable — an answer
 *    never changes for the life of the program. The client itself does NOT
 *    memoize (warm re-query of 21 nodes costs 2.5-3.8 ms; the survey's
 *    finding), so this layer is where reuse lives.
 *
 * 2. PHASE-AWARE BATCH PREFETCH. Ordinary callers keep the whole-file
 *    first-miss fallback, but the compiler explicitly batches declaration
 *    headers, top-level code, and each newly reachable body wave. Managed
 *    files then use direct memoized misses instead of accidentally sweeping
 *    every unreachable body. prefetchSourceFile() retains the whole-file
 *    escape hatch. Symbol prefetch also batch-fetches getTypeOfSymbol over
 *    every symbol each batch surfaces (5,333 calls of the mock-gateway
 *    census ride that pattern).
 *
 * 3. CLIENT-SIDE FAST PATHS. getBaseTypeOfLiteralType — the census's single
 *    hottest method (9,059 calls on mock-gateway) — is answered locally from
 *    type.flags plus the intrinsic-type singletons for the literal kinds
 *    5.9.3 maps to intrinsics (string/number/bigint/boolean literals), with
 *    IPC only for enum-ish and union types. isTupleType answers shape-true
 *    and non-object-false locally; isArrayType likewise answers
 *    non-object-false locally. Both round-trip (memoized) only where object
 *    identity needs the checker. Immutable union/intersection constituents
 *    are memoized too because TypeScript 7's Type.getTypes() otherwise
 *    repeats an IPC request. All paths are verified against the raw checker
 *    and against 5.9.3 by the adapter's suites. */

import type { Node, SourceFile } from "typescript/unstable/ast";
import type {
  Checker,
  IndexInfo,
  Project,
  Signature,
  Symbol as Ts7Symbol,
  Type,
  TypePredicate,
  TypeReference,
} from "typescript/unstable/sync";
import { walkPreorder } from "./ast.js";
import { SignatureKind, SyntaxKind, TypeFlags } from "./enums.js";

/** Array-overload chunk size: large enough that per-request overhead
 * vanishes, small enough to keep any single JSON-RPC payload modest. */
const BATCH_CHUNK = 2048;

/** The bisecting panic fence for batch queries. The prefetch sweeps query
 * nodes/symbols the lowering itself may never ask about, and tsgo can PANIC
 * on some of them (a server-side failure the sync channel surfaces as a
 * thrown Error, server intact). A batch must not turn a node nobody needs
 * into a build crash: on failure, bisect — healthy items keep their real
 * answers, and the panicking ITEM alone memoizes undefined (anyType through
 * the facade), which is exactly what the pinned type-position finding maps
 * such answers to. */
function withPanicFence<I, O>(
  chunk: readonly I[],
  call: (chunk: I[]) => readonly (O | undefined)[],
): (O | undefined)[] {
  try {
    return [...call(chunk as I[])];
  } catch (e) {
    if (!isCheckerPanic(e)) throw e;
    if (chunk.length === 1) return [undefined];
    const mid = chunk.length >> 1;
    return [
      ...withPanicFence(chunk.slice(0, mid), call),
      ...withPanicFence(chunk.slice(mid), call),
    ];
  }
}

function chunked<T, R>(items: readonly T[], fetch: (chunk: readonly T[]) => readonly R[]): R[] {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += BATCH_CHUNK) {
    out.push(...fetch(items.slice(i, i + BATCH_CHUNK)));
  }
  return out;
}

/** The prefetch sweep's depth floor. The lowering fences expressions at 200
 * nesting levels (SC1090) and never queries below its fence, so nodes much
 * deeper than that can only belong to a program the build is about to
 * refuse — and batch-querying them is where a pathological file's cost
 * lives (the ~6500-term binderBinaryExpressionStress chains spent minutes
 * in server-side per-node queries). Skipped subtrees stay CORRECT: any
 * query the lowering does make below the floor falls through to a direct,
 * memoized per-node call. */
const PREFETCH_MAX_DEPTH = 512;

/** Node kinds the lowering routinely asks getTypeAtLocation about. The
 * fallback path remains correct for every other kind, but bulk-querying the
 * entire AST was severe overfetch on generated facades (191k nodes fetched,
 * only 29k ever requested). */
const TYPE_PREFETCH_KINDS = new Set<SyntaxKind>([
  SyntaxKind.Identifier,
  SyntaxKind.ThisKeyword,
  SyntaxKind.PropertyAccessExpression,
  SyntaxKind.ElementAccessExpression,
  SyntaxKind.CallExpression,
  SyntaxKind.NewExpression,
  SyntaxKind.ObjectLiteralExpression,
  SyntaxKind.ArrayLiteralExpression,
  SyntaxKind.ConditionalExpression,
]);

/** The TypeScript 7 client identity-dedupes immutable types but does not
 * memoize Type.getTypes(): every union/intersection inspection otherwise
 * repeats getTypesOfType over IPC. Keep that derived answer beside the
 * adapter, shared by preflight and lowering regardless of which facade
 * helper led to the type. */
const constituentTypesOf = new WeakMap<Type, readonly Type[]>();

export function constituentTypes(type: Type): readonly Type[] {
  let types = constituentTypesOf.get(type);
  if (types === undefined) {
    types = (type as Type & { getTypes(): readonly Type[] | undefined }).getTypes() ?? [];
    constituentTypesOf.set(type, types);
  }
  return types;
}

/** Function-like declarations whose body is deferred until reachability
 * asks for it. Header prefetch walks their names, type parameters, params,
 * and return types but leaves the body for a later explicit body wave. */
const DEFERRED_BODY_OWNERS = new Set<SyntaxKind>([
  SyntaxKind.FunctionDeclaration,
  SyntaxKind.FunctionExpression,
  SyntaxKind.ArrowFunction,
  SyntaxKind.MethodDeclaration,
  SyntaxKind.Constructor,
  SyntaxKind.GetAccessor,
  SyntaxKind.SetAccessor,
]);

type PrefetchWalk = "all" | "structure" | "reachable";

function isClassLikeKind(kind: SyntaxKind): boolean {
  return kind === SyntaxKind.ClassDeclaration || kind === SyntaxKind.ClassExpression;
}

function isClassMember(node: Node | undefined): boolean {
  return node?.parent !== undefined && isClassLikeKind(node.parent.kind);
}

function isDeferredExecutableRoot(node: Node, walk: PrefetchWalk): boolean {
  if (walk === "all") return false;
  const parent = node.parent as (Node & {
    body?: Node;
    initializer?: Node;
    modifiers?: readonly Node[];
  }) | undefined;
  if (parent === undefined) return false;
  if (DEFERRED_BODY_OWNERS.has(parent.kind) && parent.body === node) {
    // Structure collection defers every function-like body. A reached
    // outer body still eagerly lowers nested closures/functions, but class
    // methods remain independent reachability units.
    return walk === "structure" || isClassMember(parent);
  }
  // Parameter defaults execute on function entry, not while its signature
  // is collected. Keep an unreachable declaration's default cold too.
  if (parent.kind === SyntaxKind.Parameter && parent.initializer === node) {
    return walk === "structure" || isClassMember(parent.parent);
  }
  // Instance field initializers execute in the constructor. Static fields
  // remain declaration-time code and therefore stay in the structure wave.
  return (
    parent.kind === SyntaxKind.PropertyDeclaration &&
    parent.initializer === node &&
    !parent.modifiers?.some((modifier) => modifier.kind === SyntaxKind.StaticKeyword)
  );
}

/** Preorder sweep of one or more roots, ITERATIVE (walkPreorder): the obvious
 * recursive forEachChild walk overflowed the stack HERE, in the prefetch
 * sweep, on the binderBinaryExpressionStress chains — before lowering could
 * answer with its SC1090 nesting fence. Overlapping roots are identity-
 * deduped so a header/body wave never sends the same node twice. */
function collectNodes(roots: readonly Node[], walk: PrefetchWalk = "all"): Node[] {
  const nodes: Node[] = [];
  const seen = new Set<Node>();
  for (const root of roots) {
    walkPreorder(root, (n, depth) => {
      if (n !== root && isDeferredExecutableRoot(n, walk)) return "skip";
      if (!seen.has(n)) {
        seen.add(n);
        nodes.push(n);
      }
      if (depth >= PREFETCH_MAX_DEPTH) return "skip";
      return undefined;
    });
  }
  return nodes;
}

export class CheckerFacade {
  /** Node-keyed memos. `undefined` results are represented by map presence
   * (WeakMap.has), so misses and cached-undefined are distinguishable. */
  private readonly typeAtLocation = new WeakMap<Node, Type | undefined>();
  private readonly symbolAtLocation = new WeakMap<Node, Ts7Symbol | undefined>();
  private readonly contextualType = new WeakMap<Node, Type | undefined>();
  private readonly typeFromTypeNode = new WeakMap<Node, Type | undefined>();
  private readonly shorthandValueSymbol = new WeakMap<Node, Ts7Symbol | undefined>();
  private readonly resolvedSignature = new WeakMap<Node, Signature | undefined>();
  private readonly signatureFromDeclaration = new WeakMap<Node, Signature | undefined>();
  /** Symbol-keyed memos. */
  private readonly typeOfSymbol = new WeakMap<Ts7Symbol, Type | undefined>();
  private readonly aliasedSymbol = new WeakMap<Ts7Symbol, Ts7Symbol>();
  private readonly declaredTypeOfSymbol = new WeakMap<Ts7Symbol, Type>();
  /** Type-keyed memos. */
  private readonly baseTypeOfLiteral = new WeakMap<Type, Type>();
  private readonly nonNullableType = new WeakMap<Type, Type | undefined>();
  private readonly propertiesOfType = new WeakMap<Type, readonly Ts7Symbol[]>();
  private readonly indexInfosOfType = new WeakMap<Type, readonly IndexInfo[]>();
  private readonly typeArgumentsOf = new WeakMap<Type, readonly Type[]>();
  private readonly arrayTypeAnswer = new WeakMap<Type, boolean>();
  private readonly arrayLikeAnswer = new WeakMap<Type, boolean>();
  private readonly typeStringOf = new WeakMap<Type, string>();
  private readonly awaitedTypeOf = new WeakMap<Type, Type | undefined>();
  /** Signature-keyed memos. */
  private readonly returnTypeOf = new WeakMap<Signature, Type | undefined>();
  private readonly typePredicateOf = new WeakMap<Signature, TypePredicate | undefined>();
  /** Files whose nodes have been batch-prefetched, per query kind. */
  private readonly prefetchedTypes = new WeakSet<SourceFile>();
  private readonly prefetchedSymbols = new WeakSet<SourceFile>();
  /** Files owned by explicit phase-aware prefetch. A miss in one of these
   * files must stay a direct memoized query; falling back to whole-file
   * prefetch would silently pull every unreachable body back into a build. */
  private readonly managedTypes = new WeakSet<SourceFile>();
  private readonly managedSymbols = new WeakSet<SourceFile>();
  private unknownType: Type | null = null;
  /** Intrinsic singletons (string/number/bigint/boolean), fetched once. */
  private readonly intrinsics = new Map<string, Type>();
  private readonly tupleTypeAnswer = new WeakMap<Type, boolean>();

  constructor(
    /** The underlying 7.0.2 sync checker — exposed for methods the facade
     * does not shim; going around the facade forfeits memoization only. */
    readonly raw: Checker,
    private readonly options: { autoPrefetch?: boolean; project?: Project } = {},
  ) {}

  /* ── the symbol-declaration surface (phase 3) ─────────────────────────
   * 7's Symbol carries declarations as NodeHandles (server references),
   * where 5.9.3 handed out the nodes themselves. The lowering reads
   * symbol.declarations/valueDeclaration pervasively, so the facade owns
   * the resolve step (NodeHandle.resolve into the client AST — identity-
   * stable, probe-verified) and memoizes per symbol. Requires the project
   * the symbols came from (options.project — Ts7Program supplies it). */
  private readonly declsOf = new WeakMap<Ts7Symbol, readonly Node[]>();
  private readonly valueDeclOf = new WeakMap<Ts7Symbol, Node | undefined>();

  private requireProject(): Project {
    const project = this.options.project;
    if (!project) throw new InternalCompilerError("CheckerFacade built without a project cannot resolve declarations");
    return project;
  }

  /** 5.9.3's symbol.declarations (never undefined here: 7 answers an empty
   * array where 5.9.3 answered undefined — callers treat them alike). */
  declarationsOf(symbol: Ts7Symbol): readonly Node[] {
    let decls = this.declsOf.get(symbol);
    if (decls === undefined) {
      const project = this.requireProject();
      decls = symbol.declarations
        .map((h) => h.resolve(project))
        .filter((n): n is Node => n !== undefined);
      this.declsOf.set(symbol, decls);
    }
    return decls;
  }

  /** 5.9.3's symbol.valueDeclaration. */
  valueDeclarationOf(symbol: Ts7Symbol): Node | undefined {
    if (this.valueDeclOf.has(symbol)) return this.valueDeclOf.get(symbol);
    const decl = symbol.valueDeclaration?.resolve(this.requireProject());
    this.valueDeclOf.set(symbol, decl);
    return decl;
  }

  /** 5.9.3's signature.getDeclaration() (undefined for synthesized
   * signatures — same contract as sig.declaration there). */
  signatureDeclaration(signature: Signature): Node | undefined {
    if (this.sigDeclOf.has(signature)) return this.sigDeclOf.get(signature);
    const decl = signature.declaration?.resolve(this.requireProject());
    this.sigDeclOf.set(signature, decl);
    return decl;
  }
  private readonly sigDeclOf = new WeakMap<Signature, Node | undefined>();

  /** 5.9.3's type.getCallSignatures(). */
  getCallSignatures(type: Type): readonly Signature[] {
    let sigs = this.callSigsOf.get(type);
    if (sigs === undefined) {
      sigs = this.raw.getSignaturesOfType(type, SignatureKind.Call);
      this.callSigsOf.set(type, sigs);
    }
    return sigs;
  }
  private readonly callSigsOf = new WeakMap<Type, readonly Signature[]>();

  /** 5.9.3's type.getConstructSignatures(). */
  getConstructSignatures(type: Type): readonly Signature[] {
    let sigs = this.ctorSigsOf.get(type);
    if (sigs === undefined) {
      sigs = this.raw.getSignaturesOfType(type, SignatureKind.Construct);
      this.ctorSigsOf.set(type, sigs);
    }
    return sigs;
  }
  private readonly ctorSigsOf = new WeakMap<Type, readonly Signature[]>();

  /** 5.9.3's type.getProperty(name). */
  getPropertyOfType(type: Type, name: string): Ts7Symbol | undefined {
    return this.raw.getPropertyOfType(type, name);
  }

  /** The 5.9.3 checker never answered undefined from getTypeAtLocation-
   * family queries (errorType/anyType stood in); the 7 client loosens them
   * to `T | undefined`. The lowering is written against the 5.9.3 contract,
   * so the facade restores it: undefined becomes anyType — exactly the
   * equivalence the parity battery pinned (a 7-side undefined renders as
   * "any" wherever 5.9.3 said any). */
  private anyType(): Type {
    return this.intrinsic("any", () => this.raw.getAnyType());
  }

  /** Batch-prefetches getTypeAtLocation and getSymbolAtLocation for every
   * node of the file, plus getTypeOfSymbol for every symbol those answers
   * surfaced — the per-file hook that turns the lowering's walk into three
   * array requests instead of thousands of round trips. */
  prefetchSourceFile(sf: SourceFile): void {
    this.prefetchTypes(sf);
    this.prefetchSymbols(sf);
  }

  /** Batches the non-body structure of many files as ONE logical wave.
   * Top-level executable statements, class field initializers/static blocks,
   * and every declaration header are included; function/method/constructor
   * bodies wait for reachability. Calling this also opts the files out of
   * accidental whole-file first-miss prefetch. */
  prefetchSourceFileStructures(files: readonly SourceFile[]): void {
    this.markManaged(files);
    this.prefetchNodes(collectNodes(files, "structure"));
  }

  /** Batches all checker-hot nodes under many reached roots. Lowering uses
   * this for all init bodies together and for each declaration/instance
   * worklist wave. The roots may overlap; identity deduplication and the
   * answer memos make warm repeats free. */
  prefetchRoots(roots: readonly Node[]): void {
    this.markManaged(roots);
    this.prefetchNodes(collectNodes(roots, "reachable"));
  }

  /** Batches symbol queries for every identifier under roots without the
   * usual companion getTypeOfSymbol batch. Preflight uses this for AST
   * analyses that themselves inspect deferred bodies for binding identity:
   * those scans need symbols, but do not consume the symbols' types. */
  prefetchSymbolRoots(roots: readonly Node[]): void {
    this.markManaged(roots);
    this.prefetchSymbolNodes(collectNodes(roots), false, false);
  }

  /** Exact-node sibling of prefetchSymbolRoots for analyses that first
   * narrow a large AST walk to the identifier spellings they compare. */
  prefetchSymbolNodesExact(nodes: readonly Node[]): void {
    this.markManaged(nodes);
    this.prefetchSymbolNodes([...new Set(nodes)], false, false);
  }

  /** Batches the hot getTypeAtLocation nodes structure collection may read
   * despite their runtime expressions being reachability-deferred. */
  prefetchCollectionTypes(nodes: readonly Node[]): void {
    this.markManaged(nodes);
    // Match ordinary whole-file prefetch's hot-kind boundary. Collection
    // asks some defaults conditionally; uncommon cold expressions should
    // remain direct misses only if collection actually consumes them.
    this.prefetchTypeNodes([...new Set(nodes)]);
  }

  /** Batches the exact body nodes class-shape collection reads before body
   * reachability is known. JavaScript field inference asks for the RHS type
   * and for a symbol on the `this.x` property access itself; ordinary
   * prefetch intentionally covers neither uncommon RHS kinds nor symbols
   * on non-identifiers. Descendants of symbol roots join because computed
   * `this[key]` declarations resolve the key identifier too. */
  prefetchClassCollection(
    typeNodes: readonly Node[],
    symbolRoots: readonly Node[],
  ): void {
    this.markManaged([...typeNodes, ...symbolRoots]);
    this.prefetchExactTypeNodes(typeNodes);
    this.prefetchSymbolNodes(collectNodes(symbolRoots, "reachable"), true);
  }

  private prefetchExactTypeNodes(typeNodes: readonly Node[]): void {
    const distinctTypes = [...new Set(typeNodes)].filter(
      (node) => !this.typeAtLocation.has(node),
    );
    const types = chunked(distinctTypes, (chunk) => this.typesWithPanicFence(chunk));
    distinctTypes.forEach((node, index) => this.typeAtLocation.set(node, types[index]));
  }

  private markManaged(roots: readonly Node[]): void {
    for (const root of roots) {
      const sf = root.getSourceFile();
      this.managedTypes.add(sf);
      this.managedSymbols.add(sf);
    }
  }

  private prefetchNodes(nodes: readonly Node[]): void {
    this.prefetchTypeNodes(nodes);
    this.prefetchSymbolNodes(nodes);
  }

  private prefetchTypes(sf: SourceFile): void {
    if (this.prefetchedTypes.has(sf)) return;
    this.prefetchedTypes.add(sf);
    this.prefetchTypeNodes(collectNodes([sf]));
  }

  private prefetchTypeNodes(allNodes: readonly Node[]): void {
    const nodes = allNodes.filter(
      (n) => TYPE_PREFETCH_KINDS.has(n.kind) && !this.typeAtLocation.has(n),
    );
    const types = chunked(nodes, (chunk) => this.typesWithPanicFence(chunk));
    nodes.forEach((n, i) => this.typeAtLocation.set(n, types[i]));
  }

  /** withPanicFence over the type sweep (observed panic: GetTypeAtLocation
   * over an unresolved npm import's clause — a server-side nil deref). */
  private typesWithPanicFence(chunk: readonly Node[]): (Type | undefined)[] {
    return withPanicFence(chunk, (c) => this.raw.getTypeAtLocation(c) as (Type | undefined)[]);
  }

  private prefetchSymbols(sf: SourceFile): void {
    if (this.prefetchedSymbols.has(sf)) return;
    this.prefetchedSymbols.add(sf);
    this.prefetchSymbolNodes(collectNodes([sf]));
  }

  private prefetchSymbolNodes(
    allNodes: readonly Node[],
    includePropertyAccess = false,
    prefetchSymbolTypes = true,
  ): void {
    const symbolNodes = allNodes.filter(
      (n) =>
        (n.kind === SyntaxKind.Identifier ||
          (includePropertyAccess && n.kind === SyntaxKind.PropertyAccessExpression)),
    );
    const nodes = symbolNodes.filter((n) => !this.symbolAtLocation.has(n));
    // The same bisecting panic fence as the type sweep: tsgo panics on
    // SYMBOL queries too (observed: GetSymbolAtLocation over an
    // `import.defer(...)` callee — the sweep's batch must not turn one
    // poisonous node into a build crash).
    const symbols = chunked(nodes, (chunk) =>
      withPanicFence(chunk, (c) => this.raw.getSymbolAtLocation(c)),
    );
    nodes.forEach((n, i) => this.symbolAtLocation.set(n, symbols[i]));
    if (!prefetchSymbolTypes) return;
    // The walk's companion query: types of the symbols the file mentions.
    // Include warm node answers too: a preceding symbol-only analysis may
    // have populated symbolAtLocation without fetching symbol types, and a
    // later reachable-body wave must still batch those missing types.
    const distinct = [
      ...new Set(
        symbolNodes
          .map((node) => this.symbolAtLocation.get(node))
          .filter((symbol): symbol is Ts7Symbol => symbol !== undefined),
      ),
    ].filter((symbol) => !this.typeOfSymbol.has(symbol));
    const symbolTypes = chunked(distinct, (chunk) =>
      withPanicFence(chunk, (c) => this.raw.getTypeOfSymbol(c)),
    );
    distinct.forEach((s, i) => this.typeOfSymbol.set(s, symbolTypes[i]));
  }

  private autoPrefetch(node: Node, kind: "types" | "symbols"): void {
    if (this.options.autoPrefetch === false) return;
    const sf = node.getSourceFile();
    if (kind === "types") {
      if (!this.managedTypes.has(sf)) this.prefetchTypes(sf);
    } else if (!this.managedSymbols.has(sf)) {
      this.prefetchSymbols(sf);
    }
  }

  getTypeAtLocation(node: Node): Type {
    if (this.typeAtLocation.has(node)) return this.typeAtLocation.get(node) ?? this.anyType();
    this.autoPrefetch(node, "types");
    if (this.typeAtLocation.has(node)) return this.typeAtLocation.get(node) ?? this.anyType();
    const type = this.raw.getTypeAtLocation(node);
    this.typeAtLocation.set(node, type);
    return type ?? this.anyType();
  }

  getSymbolAtLocation(node: Node): Ts7Symbol | undefined {
    if (this.symbolAtLocation.has(node)) return this.symbolAtLocation.get(node);
    this.autoPrefetch(node, "symbols");
    if (this.symbolAtLocation.has(node)) return this.symbolAtLocation.get(node);
    const symbol = this.raw.getSymbolAtLocation(node);
    this.symbolAtLocation.set(node, symbol);
    return symbol;
  }

  getTypeOfSymbol(symbol: Ts7Symbol): Type {
    if (this.typeOfSymbol.has(symbol)) return this.typeOfSymbol.get(symbol) ?? this.anyType();
    // The direct (memo-miss) path wears the same panic fence as the
    // prefetch sweep: symbols the sweep never saw (members resolved from
    // other files' d.ts) can hit the identical server panics (observed:
    // GetTypeOfSymbol's TypeReference/TupleType conversion on the formatter idiom's
    // engine graph), and the fence's answer is the sweep's — undefined,
    // presented as `any`.
    const [type] = withPanicFence([symbol], (c) => this.raw.getTypeOfSymbol(c));
    this.typeOfSymbol.set(symbol, type);
    return type ?? this.anyType();
  }

  getAliasedSymbol(symbol: Ts7Symbol): Ts7Symbol {
    let aliased = this.aliasedSymbol.get(symbol);
    if (aliased === undefined) {
      aliased = this.raw.getAliasedSymbol(symbol);
      this.aliasedSymbol.set(symbol, aliased);
    }
    return aliased;
  }

  getDeclaredTypeOfSymbol(symbol: Ts7Symbol): Type {
    let type = this.declaredTypeOfSymbol.get(symbol);
    if (type === undefined) {
      type = this.raw.getDeclaredTypeOfSymbol(symbol);
      this.declaredTypeOfSymbol.set(symbol, type);
    }
    return type;
  }

  getContextualType(node: Node): Type | undefined {
    if (this.contextualType.has(node)) return this.contextualType.get(node);
    const type = this.raw.getContextualType(node as never);
    this.contextualType.set(node, type);
    return type;
  }

  getTypeFromTypeNode(node: Node): Type {
    if (this.typeFromTypeNode.has(node)) return this.typeFromTypeNode.get(node) ?? this.anyType();
    const type = this.raw.getTypeFromTypeNode(node as never);
    this.typeFromTypeNode.set(node, type);
    return type ?? this.anyType();
  }

  getShorthandAssignmentValueSymbol(node: Node): Ts7Symbol | undefined {
    if (this.shorthandValueSymbol.has(node)) return this.shorthandValueSymbol.get(node);
    const symbol = this.raw.getShorthandAssignmentValueSymbol(node);
    this.shorthandValueSymbol.set(node, symbol);
    return symbol;
  }

  getResolvedSignature(node: Node): Signature | undefined {
    if (this.resolvedSignature.has(node)) return this.resolvedSignature.get(node);
    const signature = this.raw.getResolvedSignature(node);
    this.resolvedSignature.set(node, signature);
    return signature;
  }

  getSignatureFromDeclaration(node: Node): Signature | undefined {
    if (this.signatureFromDeclaration.has(node)) return this.signatureFromDeclaration.get(node);
    const signature = this.raw.getSignatureFromDeclaration(node);
    this.signatureFromDeclaration.set(node, signature);
    return signature;
  }

  getReturnTypeOfSignature(signature: Signature): Type {
    if (this.returnTypeOf.has(signature)) return this.returnTypeOf.get(signature) ?? this.anyType();
    const type = this.raw.getReturnTypeOfSignature(signature);
    this.returnTypeOf.set(signature, type);
    return type ?? this.anyType();
  }

  getTypePredicateOfSignature(signature: Signature): TypePredicate | undefined {
    if (this.typePredicateOf.has(signature)) return this.typePredicateOf.get(signature);
    const predicate = this.raw.getTypePredicateOfSignature(signature);
    this.typePredicateOf.set(signature, predicate);
    return predicate;
  }

  /** 5.9.3 semantics, answered client-side wherever type.flags suffices:
   * string/number/bigint/boolean literals map to the intrinsic singletons
   * (one IPC ever per intrinsic); enum-ish and union types round-trip
   * (memoized); everything else is itself. */
  getBaseTypeOfLiteralType(type: Type): Type {
    const memo = this.baseTypeOfLiteral.get(type);
    if (memo !== undefined) return memo;
    const flags = type.flags;
    let base: Type;
    if (flags & (TypeFlags.EnumLiteral | TypeFlags.Enum) || flags & TypeFlags.Union) {
      base = this.raw.getBaseTypeOfLiteralType(type) ?? type;
    } else if (flags & (TypeFlags.StringLiteral | TypeFlags.TemplateLiteral)) {
      base = this.intrinsic("string", () => this.raw.getStringType());
    } else if (flags & TypeFlags.NumberLiteral) {
      base = this.intrinsic("number", () => this.raw.getNumberType());
    } else if (flags & TypeFlags.BigIntLiteral) {
      base = this.intrinsic("bigint", () => this.raw.getBigIntType());
    } else if (flags & TypeFlags.BooleanLiteral) {
      base = this.intrinsic("boolean", () => this.raw.getBooleanType());
    } else {
      base = type;
    }
    this.baseTypeOfLiteral.set(type, base);
    return base;
  }

  private intrinsic(name: string, fetch: () => Type): Type {
    let type = this.intrinsics.get(name);
    if (type === undefined) {
      type = fetch();
      this.intrinsics.set(name, type);
    }
    return type;
  }

  /** 5.9.3's checker.getConstantValue, memoized per node. The one caller
   * (enum lowering) passes ENUM MEMBER declaration nodes only: 7 answers
   * the member's computed constant there for const and regular enums alike
   * (access-expression queries answer const enums only — same as 5.9.3 —
   * so the lowering resolves the member symbol and asks its declaration). */
  getConstantValue(node: Node): string | number | undefined {
    if (this.constantValueOf.has(node)) return this.constantValueOf.get(node);
    const value = this.raw.getConstantValue(node);
    this.constantValueOf.set(node, value);
    return value;
  }
  private readonly constantValueOf = new WeakMap<Node, string | number | undefined>();

  getNonNullableType(type: Type): Type {
    if (this.nonNullableType.has(type)) return this.nonNullableType.get(type) ?? type;
    const result = this.raw.getNonNullableType(type);
    this.nonNullableType.set(type, result);
    return result ?? type;
  }

  getPropertiesOfType(type: Type): readonly Ts7Symbol[] {
    let props = this.propertiesOfType.get(type);
    if (props === undefined) {
      props = this.raw.getPropertiesOfType(type);
      this.propertiesOfType.set(type, props);
    }
    return props;
  }

  getIndexInfosOfType(type: Type): readonly IndexInfo[] {
    let infos = this.indexInfosOfType.get(type);
    if (infos === undefined) {
      infos = this.raw.getIndexInfosOfType(type);
      this.indexInfosOfType.set(type, infos);
    }
    return infos;
  }

  getTypeArguments(type: TypeReference): readonly Type[] {
    let args = this.typeArgumentsOf.get(type);
    if (args === undefined) {
      // 5.9.3 answered [] for a non-reference passed by cast (the lowering
      // leans on that — a concretely-declared interface takes the same
      // path as its generic @types twin); tsgo PANICS on it, so the
      // reference check happens client-side (free — objectFlags).
      args = (type as Type).isTypeReference() ? this.raw.getTypeArguments(type) : [];
      this.typeArgumentsOf.set(type, args);
    }
    return args;
  }

  isArrayType(type: Type): boolean {
    // Arrays are object types. The raw checker agrees that primitive,
    // union/intersection, and type-parameter objects themselves are not
    // arrays (a narrowed array arm arrives as its object type), so avoid a
    // request for every visibly non-object type just as isTupleType does.
    if (!(type.flags & TypeFlags.Object)) return false;
    let answer = this.arrayTypeAnswer.get(type);
    if (answer === undefined) {
      answer = withPanicFence([type], (c) => c.map((t) => this.raw.isArrayType(t)))[0] ?? false;
      this.arrayTypeAnswer.set(type, answer);
    }
    return answer;
  }

  /** 5.9.3's checker.isTupleType answers true for tuple SHAPES and for
   * REFERENCES to them (Pair<number>, a readonly [T, T] instantiation).
   * The 7.0.2 client-side Type.isTupleType() sees only the shape — a
   * reference answers false there (measured; the facade suite pins it) —
   * so shape-true and non-object-false resolve locally and only object
   * types that are not visibly tuples round-trip, memoized. The round-trip
   * wears the panic fence: upstream has panicked on exactly these
   * tuple/reference shape mixups, and one bad type must not crash the
   * query pass — it degrades to false (the not-a-tuple answer) memoized,
   * like a panicked batch item. */
  isTupleType(type: Type): boolean {
    if (type.isTupleType()) return true;
    if (!(type.flags & TypeFlags.Object)) return false;
    let answer = this.tupleTypeAnswer.get(type);
    if (answer === undefined) {
      answer = withPanicFence([type], (c) => c.map((t) => this.raw.isTupleType(t)))[0] ?? false;
      this.tupleTypeAnswer.set(type, answer);
    }
    return answer;
  }

  isArrayLikeType(type: Type): boolean {
    let answer = this.arrayLikeAnswer.get(type);
    if (answer === undefined) {
      answer = withPanicFence([type], (c) => c.map((t) => this.raw.isArrayLikeType(t)))[0] ?? false;
      this.arrayLikeAnswer.set(type, answer);
    }
    return answer;
  }

  typeToString(type: Type, enclosingDeclaration?: Node, flags?: number): string {
    if (enclosingDeclaration === undefined && flags === undefined) {
      let text = this.typeStringOf.get(type);
      if (text === undefined) {
        text = this.raw.typeToString(type);
        this.typeStringOf.set(type, text);
      }
      return text;
    }
    return this.raw.typeToString(type, enclosingDeclaration, flags);
  }

  getTypeOfSymbolAtLocation(symbol: Ts7Symbol, location: Node): Type {
    // Two-key query with one census call site: no memo, straight through.
    return this.raw.getTypeOfSymbolAtLocation(symbol, location);
  }

  getUnknownType(): Type {
    this.unknownType ??= this.raw.getUnknownType();
    return this.unknownType;
  }

  /** 7.0.2 dropped getAwaitedType (the census's one MISSING checker method).
   * Shimmed per the survey: unwrap Promise/PromiseLike references through
   * their type argument, distributing over unions. The client cannot BUILD
   * union types, so a union whose arms unwrap to more than one distinct type
   * returns undefined (callers fall back to the input; the census's one call
   * site does exactly that) — a union like `T | PromiseLike<T>` collapses by
   * object identity to T, which is the pattern that call site exists for. */
  getAwaitedType(type: Type): Type | undefined {
    if (this.awaitedTypeOf.has(type)) return this.awaitedTypeOf.get(type);
    const awaited = this.computeAwaitedType(type, 0);
    this.awaitedTypeOf.set(type, awaited);
    return awaited;
  }

  private computeAwaitedType(type: Type, depth: number): Type | undefined {
    if (depth > 8) return undefined; // matches 5.9.3's unwrap depth fence
    if (type.isUnionType()) {
      const arms = constituentTypes(type);
      const awaited = arms.map((arm) => this.computeAwaitedType(arm, depth + 1));
      if (awaited.some((arm) => arm === undefined)) return undefined;
      // No arm was a promise: awaiting the union is the union itself
      // (5.9.3 answers the input type — string | null stays string | null).
      if (awaited.every((arm, i) => arm === arms[i])) return type;
      const distinct = [...new Set(awaited as Type[])];
      return distinct.length === 1 ? distinct[0] : undefined;
    }
    const unwrapped = this.promiseArgumentOf(type);
    if (unwrapped === null) return type;
    return this.computeAwaitedType(unwrapped, depth + 1);
  }

  /** The type argument of a Promise/PromiseLike reference, or null when the
   * type is not one. Global-ness is approximated by symbol name — scriptc
   * programs see the es2025 lib's Promise (the ambient world forces it). */
  private promiseArgumentOf(type: Type): Type | null {
    if (!type.isTypeReference()) return null;
    const name = type.getTarget().getSymbol()?.name;
    if (name !== "Promise" && name !== "PromiseLike") return null;
    const args = this.getTypeArguments(type);
    return args[0] ?? null;
  }
}
