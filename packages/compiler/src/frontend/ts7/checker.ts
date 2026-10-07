import { CheckerCache } from "./checker-cache.js";
import { InternalCompilerError } from "../../errors.js";
/* The checker facade: 5.9.3-shaped TypeChecker methods over 7.0.2's sync
 * client, built around the survey's feasibility verdict. Naive per-call use
 * of the 7.0.2 client costs 0.1-0.3 ms of IPC per query; the census counted
 * 32,226 checker calls lowering mock-gateway, so a transparent adapter would
 * add seconds. Batched, the same queries run at ~0.005 ms/call — parity with
 * 5.9.3. Three mechanisms make batching and reuse the DEFAULT path:
 *
 * 1. IDENTITY MEMOS. One program-owned Map per query kind, keyed on the client-side
 *    node/type/symbol object. Safe because the 7.0.2 client registry dedupes
 *    by server handle id (probe-verified: the same symbol/type from any two
 *    queries is the same object), and a snapshot is immutable — an answer
 *    never changes for the life of the program. The client itself does NOT
 *    memoize (warm re-query of 21 nodes costs 2.5-3.8 ms; the survey's
 *    finding), so this layer is where reuse lives.
 *
 * 2. PHASE-AWARE BATCH PREFETCH. Ordinary callers keep the whole-file
 *    first-miss fallback for implementation files. The compiler explicitly
 *    batches declaration headers, top-level code, and each newly reachable body wave. Managed
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

import type { Node, SourceFile } from "./ast-types.js";
import type {
  IndexInfo,
  InterfaceType,
  Signature,
  Symbol as Ts7Symbol,
  Type,
  TypePredicate,
  TypeReference,
} from "./semantic-types.js";
import type { SemanticChecker as Checker } from "./semantic-checker.js";
import type { SemanticProject as Project } from "./semantic-model.js";
import { isTypeNode, walkPreorder } from "./ast.js";
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
  } catch {
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

/** Constituents are owned by the type's semantic project. The type checks
 * its lifetime even for warm reads, and releases cached references when
 * that project is disposed. No process-global cache retains old snapshots. */
export function constituentTypes(type: Type): readonly Type[] {
  return type.getTypes() ?? [];
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

type PrefetchWalk = "all" | "runtime" | "structure" | "reachable";

function isClassLikeKind(kind: SyntaxKind): boolean {
  return kind === SyntaxKind.ClassDeclaration || kind === SyntaxKind.ClassExpression;
}

function isClassMember(node: Node | undefined): boolean {
  return node?.parent !== undefined && isClassLikeKind(node.parent.kind);
}

function isDeferredExecutableRoot(node: Node, walk: PrefetchWalk): boolean {
  if (walk === "all" || walk === "runtime") return false;
  const parent = node.parent;
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
      // Managed waves prepare runtime lowering. Type-only syntax is still
      // checked by tsgo, but its metadata need not cross the process boundary
      // unless a consumer asks for it. Class heritage expressions remain
      // runtime inputs, and explicit roots retain the full query contract.
      if (
        n !== root &&
        walk !== "all" &&
        (n.kind === SyntaxKind.InterfaceDeclaration ||
          n.kind === SyntaxKind.TypeAliasDeclaration ||
          n.kind === SyntaxKind.TypeParameter ||
          (isTypeNode(n) && n.kind !== SyntaxKind.ExpressionWithTypeArguments))
      ) {
        return "skip";
      }
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
  private readonly cache = new CheckerCache();

  constructor(
    /** The underlying 7.0.2 sync checker — exposed for methods the facade
     * does not shim; going around the facade forfeits memoization only. */
    readonly raw: Checker,
    private readonly options: { autoPrefetch?: boolean; project?: Project } = {},
  ) {
    const cache = this.cache;
    raw.project.onDispose(() => cache.dispose());
  }

  private ensureActive(): void {
    this.cache.ensureActive();
    this.raw.project.ensureActive();
  }

  /** Eagerly release memoized answers when a facade is no longer needed.
   * The semantic project also owns this cleanup, covering session close
   * and snapshot disposal even when callers retain the facade. */
  dispose(): void {
    this.cache.dispose();
  }

  /* ── the symbol-declaration surface (phase 3) ─────────────────────────
   * 7's Symbol carries declarations as NodeHandles (server references),
   * where 5.9.3 handed out the nodes themselves. The lowering reads
   * symbol.declarations/valueDeclaration pervasively, so the facade owns
   * the resolve step (NodeHandle.resolve into the client AST — identity-
   * stable, probe-verified) and memoizes per symbol. Requires the project
   * the symbols came from (options.project — Ts7Program supplies it). */

  private requireProject(): Project {
    const project = this.options.project;
    if (!project)
      throw new InternalCompilerError(
        "CheckerFacade built without a project cannot resolve declarations",
      );
    return project;
  }

  /** 5.9.3's symbol.declarations (never undefined here: 7 answers an empty
   * array where 5.9.3 answered undefined — callers treat them alike). */
  declarationsOf(symbol: Ts7Symbol): readonly Node[] {
    this.ensureActive();
    let decls = this.cache.declsOf.get(symbol);
    if (decls === undefined) {
      const project = this.requireProject();
      const resolved: Node[] = [];
      for (const handle of symbol.declarations) {
        const node = handle.resolve(project);
        if (node !== undefined) resolved.push(node);
      }
      decls = resolved;
      this.cache.declsOf.set(symbol, decls);
    }
    return decls;
  }

  /** 5.9.3's symbol.valueDeclaration. */
  valueDeclarationOf(symbol: Ts7Symbol): Node | undefined {
    this.ensureActive();
    if (this.cache.valueDeclOf.has(symbol)) return this.cache.valueDeclOf.get(symbol);
    const decl = symbol.valueDeclaration?.resolve(this.requireProject());
    this.cache.valueDeclOf.set(symbol, decl);
    return decl;
  }

  /** 5.9.3's signature.getDeclaration() (undefined for synthesized
   * signatures — same contract as sig.declaration there). */
  signatureDeclaration(signature: Signature): Node | undefined {
    this.ensureActive();
    if (this.cache.sigDeclOf.has(signature)) return this.cache.sigDeclOf.get(signature);
    const decl = signature.declaration?.resolve(this.requireProject());
    this.cache.sigDeclOf.set(signature, decl);
    return decl;
  }

  /** 5.9.3's type.getCallSignatures(). */
  getCallSignatures(type: Type): readonly Signature[] {
    this.ensureActive();
    let sigs = this.cache.callSigsOf.get(type);
    if (sigs === undefined) {
      sigs = this.raw.getSignaturesOfType(type, SignatureKind.Call);
      this.cache.callSigsOf.set(type, sigs);
    }
    return sigs;
  }

  /** 5.9.3's type.getConstructSignatures(). */
  getConstructSignatures(type: Type): readonly Signature[] {
    this.ensureActive();
    let sigs = this.cache.ctorSigsOf.get(type);
    if (sigs === undefined) {
      sigs = this.raw.getSignaturesOfType(type, SignatureKind.Construct);
      this.cache.ctorSigsOf.set(type, sigs);
    }
    return sigs;
  }

  /** 5.9.3's type.getProperty(name). */
  getPropertyOfType(type: Type, name: string): Ts7Symbol | undefined {
    this.ensureActive();
    let properties = this.cache.propertyOfType.get(type);
    if (properties === undefined) {
      properties = new Map<string, Ts7Symbol | undefined>();
      this.cache.propertyOfType.set(type, properties);
    }
    // Absence is an answer too. Both keys belong to this immutable project;
    // another snapshot or project must ask its own checker.
    if (properties.has(name)) return properties.get(name);
    const symbol = this.raw.getPropertyOfType(type, name);
    properties.set(name, symbol);
    return symbol;
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
    this.ensureActive();
    this.prefetchTypes(sf);
    this.prefetchSymbols(sf);
  }

  /** Batches the non-body structure of many files as ONE logical wave.
   * Top-level executable statements, class field initializers/static blocks,
   * and every declaration header are included; function/method/constructor
   * bodies wait for reachability. Calling this also opts the files out of
   * accidental whole-file first-miss prefetch. */
  prefetchSourceFileStructures(files: readonly SourceFile[]): void {
    this.ensureActive();
    this.markManaged(files);
    this.prefetchNodes(collectNodes(files, "structure"));
  }

  /** Batches all checker-hot nodes under many reached roots. Lowering uses
   * this for all init bodies together and for each declaration/instance
   * worklist wave. The roots may overlap; identity deduplication and the
   * answer memos make warm repeats free. */
  prefetchRoots(roots: readonly Node[]): void {
    this.ensureActive();
    this.markManaged(roots);
    this.prefetchNodes(collectNodes(roots, "reachable"));
  }

  /** Batches symbol queries for every identifier under roots without the
   * usual companion getTypeOfSymbol batch. Preflight uses this for AST
   * analyses that themselves inspect deferred bodies for binding identity:
   * those scans need symbols, but do not consume the symbols' types.
   * Runtime-only analyses may omit erased type syntax while still walking
   * every deferred executable body. Other callers keep the full walk. */
  prefetchSymbolRoots(roots: readonly Node[], runtimeOnly = false): void {
    this.ensureActive();
    this.markManaged(roots);
    this.prefetchSymbolNodes(collectNodes(roots, runtimeOnly ? "runtime" : "all"), false, false);
  }

  /** Exact-node sibling of prefetchSymbolRoots for analyses that first
   * narrow a large AST walk to the identifier spellings they compare. */
  prefetchSymbolNodesExact(nodes: readonly Node[]): void {
    this.ensureActive();
    this.markManaged(nodes);
    this.prefetchSymbolNodes([...new Set(nodes)], false, false);
  }

  /** Batches the hot getTypeAtLocation nodes structure collection may read
   * despite their runtime expressions being reachability-deferred. */
  prefetchCollectionTypes(nodes: readonly Node[]): void {
    this.ensureActive();
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
  prefetchClassCollection(typeNodes: readonly Node[], symbolRoots: readonly Node[]): void {
    this.ensureActive();
    this.markManaged([...typeNodes, ...symbolRoots]);
    this.prefetchExactTypeNodes(typeNodes);
    this.prefetchSymbolNodes(collectNodes(symbolRoots, "reachable"), true);
  }

  private prefetchExactTypeNodes(typeNodes: readonly Node[]): void {
    const distinctTypes = [...new Set(typeNodes)].filter(
      (node) => !this.cache.typeAtLocation.has(node),
    );
    const types = chunked(distinctTypes, (chunk) => this.typesWithPanicFence(chunk));
    distinctTypes.forEach((node, index) => this.cache.typeAtLocation.set(node, types[index]));
  }

  private markManaged(roots: readonly Node[]): void {
    for (const root of roots) {
      const sf = root.getSourceFile();
      this.cache.managedTypes.add(sf);
      this.cache.managedSymbols.add(sf);
    }
  }

  private prefetchNodes(nodes: readonly Node[]): void {
    this.prefetchTypeNodes(nodes);
    this.prefetchSymbolNodes(nodes);
  }

  private prefetchTypes(sf: SourceFile): void {
    if (this.cache.prefetchedTypes.has(sf)) return;
    this.cache.prefetchedTypes.add(sf);
    this.prefetchTypeNodes(collectNodes([sf]));
  }

  private prefetchTypeNodes(allNodes: readonly Node[]): void {
    const nodes = allNodes.filter(
      (n) => TYPE_PREFETCH_KINDS.has(n.kind) && !this.cache.typeAtLocation.has(n),
    );
    const types = chunked(nodes, (chunk) => this.typesWithPanicFence(chunk));
    nodes.forEach((n, i) => this.cache.typeAtLocation.set(n, types[i]));
  }

  /** withPanicFence over the type sweep (observed panic: GetTypeAtLocation
   * over an unresolved npm import's clause — a server-side nil deref). */
  private typesWithPanicFence(chunk: readonly Node[]): (Type | undefined)[] {
    return withPanicFence(chunk, (c) => this.raw.getTypeAtLocation(c) as (Type | undefined)[]);
  }

  private prefetchSymbols(sf: SourceFile): void {
    if (this.cache.prefetchedSymbols.has(sf)) return;
    this.cache.prefetchedSymbols.add(sf);
    this.prefetchSymbolNodes(collectNodes([sf]));
  }

  private prefetchSymbolNodes(
    allNodes: readonly Node[],
    includePropertyAccess = false,
    prefetchSymbolTypes = true,
  ): void {
    const symbolNodes = allNodes.filter(
      (n) =>
        n.kind === SyntaxKind.Identifier ||
        (includePropertyAccess && n.kind === SyntaxKind.PropertyAccessExpression),
    );
    const nodes = symbolNodes.filter((n) => !this.cache.symbolAtLocation.has(n));
    // The same bisecting panic fence as the type sweep: tsgo panics on
    // SYMBOL queries too (observed: GetSymbolAtLocation over an
    // `import.defer(...)` callee — the sweep's batch must not turn one
    // poisonous node into a build crash).
    const symbols = chunked(nodes, (chunk) =>
      withPanicFence(chunk, (c) => this.raw.getSymbolAtLocation(c)),
    );
    nodes.forEach((n, i) => this.cache.symbolAtLocation.set(n, symbols[i]));
    if (!prefetchSymbolTypes) return;
    // The walk's companion query: types of the symbols the file mentions.
    // Include warm node answers too: a preceding symbol-only analysis may
    // have populated symbolAtLocation without fetching symbol types, and a
    // later reachable-body wave must still batch those missing types.
    const distinct: Ts7Symbol[] = [];
    const seen = new Set<Ts7Symbol>();
    for (const node of symbolNodes) {
      const symbol = this.cache.symbolAtLocation.get(node);
      if (symbol === undefined || seen.has(symbol) || this.cache.typeOfSymbol.has(symbol)) continue;
      seen.add(symbol);
      distinct.push(symbol);
    }
    const symbolTypes = chunked(distinct, (chunk) =>
      withPanicFence(chunk, (c) => this.raw.getTypeOfSymbol(c)),
    );
    distinct.forEach((s, i) => this.cache.typeOfSymbol.set(s, symbolTypes[i]));
  }

  private autoPrefetch(node: Node, kind: "types" | "symbols"): void {
    if (this.options.autoPrefetch === false) return;
    const sf = node.getSourceFile();
    // A referenced declaration rarely needs the rest of its library's
    // metadata. Keep those queries direct; explicit whole-file prefetch
    // remains available to consumers that do need the complete surface.
    if (sf.isDeclarationFile) return;
    if (kind === "types") {
      if (!this.cache.managedTypes.has(sf)) this.prefetchTypes(sf);
    } else if (!this.cache.managedSymbols.has(sf)) {
      this.prefetchSymbols(sf);
    }
  }

  getTypeAtLocation(node: Node): Type {
    this.ensureActive();
    if (this.cache.typeAtLocation.has(node))
      return this.cache.typeAtLocation.get(node) ?? this.anyType();
    this.autoPrefetch(node, "types");
    if (this.cache.typeAtLocation.has(node))
      return this.cache.typeAtLocation.get(node) ?? this.anyType();
    const type = this.raw.getTypeAtLocation(node);
    this.cache.typeAtLocation.set(node, type);
    return type ?? this.anyType();
  }

  getSymbolAtLocation(node: Node): Ts7Symbol | undefined {
    this.ensureActive();
    if (this.cache.symbolAtLocation.has(node)) return this.cache.symbolAtLocation.get(node);
    this.autoPrefetch(node, "symbols");
    if (this.cache.symbolAtLocation.has(node)) return this.cache.symbolAtLocation.get(node);
    const symbol = this.raw.getSymbolAtLocation(node);
    this.cache.symbolAtLocation.set(node, symbol);
    return symbol;
  }

  getTypeOfSymbol(symbol: Ts7Symbol): Type {
    this.ensureActive();
    if (this.cache.typeOfSymbol.has(symbol))
      return this.cache.typeOfSymbol.get(symbol) ?? this.anyType();
    // The direct (memo-miss) path wears the same panic fence as the
    // prefetch sweep: symbols the sweep never saw (members resolved from
    // other files' d.ts) can hit the identical server panics (observed:
    // GetTypeOfSymbol's TypeReference/TupleType conversion on the formatter idiom's
    // engine graph), and the fence's answer is the sweep's — undefined,
    // presented as `any`.
    const [type] = withPanicFence([symbol], (c) => this.raw.getTypeOfSymbol(c));
    this.cache.typeOfSymbol.set(symbol, type);
    return type ?? this.anyType();
  }

  /** A structural member walk consumes adjacent symbol types together.
   * Bound lookahead so an early refusal cannot query an entire wide shape.
   * Use the same panic isolation and memo as an individual field query. */
  prefetchMemberTypes(symbols: readonly Ts7Symbol[], start: number): void {
    this.ensureActive();
    const missing: Ts7Symbol[] = [];
    const end = Math.min(symbols.length, start + 32);
    for (let i = start; i < end; i++) {
      const symbol = symbols[i]!;
      if (!this.cache.typeOfSymbol.has(symbol)) missing.push(symbol);
    }
    if (missing.length === 0) return;
    const types = withPanicFence(missing, (chunk) => this.raw.getTypeOfSymbol(chunk));
    missing.forEach((symbol, i) => this.cache.typeOfSymbol.set(symbol, types[i]));
  }

  getAliasedSymbol(symbol: Ts7Symbol): Ts7Symbol {
    this.ensureActive();
    let aliased = this.cache.aliasedSymbol.get(symbol);
    if (aliased === undefined) {
      aliased = this.raw.getAliasedSymbol(symbol);
      this.cache.aliasedSymbol.set(symbol, aliased);
    }
    return aliased;
  }

  getDeclaredTypeOfSymbol(symbol: Ts7Symbol): Type {
    this.ensureActive();
    let type = this.cache.declaredTypeOfSymbol.get(symbol);
    if (type === undefined) {
      type = this.raw.getDeclaredTypeOfSymbol(symbol);
      this.cache.declaredTypeOfSymbol.set(symbol, type);
    }
    return type;
  }

  getContextualType(node: Node): Type | undefined {
    this.ensureActive();
    if (this.cache.contextualType.has(node)) return this.cache.contextualType.get(node);
    const type = this.raw.getContextualType(node as never);
    this.cache.contextualType.set(node, type);
    return type;
  }

  getTypeFromTypeNode(node: Node): Type {
    this.ensureActive();
    if (this.cache.typeFromTypeNode.has(node))
      return this.cache.typeFromTypeNode.get(node) ?? this.anyType();
    const type = this.raw.getTypeFromTypeNode(node as never);
    this.cache.typeFromTypeNode.set(node, type);
    return type ?? this.anyType();
  }

  getShorthandAssignmentValueSymbol(node: Node): Ts7Symbol | undefined {
    this.ensureActive();
    if (this.cache.shorthandValueSymbol.has(node)) return this.cache.shorthandValueSymbol.get(node);
    const symbol = this.raw.getShorthandAssignmentValueSymbol(node);
    this.cache.shorthandValueSymbol.set(node, symbol);
    return symbol;
  }

  getResolvedSignature(node: Node): Signature | undefined {
    this.ensureActive();
    if (this.cache.resolvedSignature.has(node)) return this.cache.resolvedSignature.get(node);
    const signature = this.raw.getResolvedSignature(node);
    this.cache.resolvedSignature.set(node, signature);
    return signature;
  }

  getSignatureFromDeclaration(node: Node): Signature | undefined {
    this.ensureActive();
    if (this.cache.signatureFromDeclaration.has(node))
      return this.cache.signatureFromDeclaration.get(node);
    const signature = this.raw.getSignatureFromDeclaration(node);
    this.cache.signatureFromDeclaration.set(node, signature);
    return signature;
  }

  getReturnTypeOfSignature(signature: Signature): Type {
    this.ensureActive();
    if (this.cache.returnTypeOf.has(signature))
      return this.cache.returnTypeOf.get(signature) ?? this.anyType();
    const type = this.raw.getReturnTypeOfSignature(signature);
    this.cache.returnTypeOf.set(signature, type);
    return type ?? this.anyType();
  }

  getTypePredicateOfSignature(signature: Signature): TypePredicate | undefined {
    this.ensureActive();
    if (this.cache.typePredicateOf.has(signature)) return this.cache.typePredicateOf.get(signature);
    const predicate = this.raw.getTypePredicateOfSignature(signature);
    this.cache.typePredicateOf.set(signature, predicate);
    return predicate;
  }

  /** 5.9.3 semantics, answered client-side wherever type.flags suffices:
   * string/number/bigint/boolean literals map to the intrinsic singletons
   * (one IPC ever per intrinsic); enum-ish and union types round-trip
   * (memoized); everything else is itself. */
  getBaseTypeOfLiteralType(type: Type): Type {
    this.ensureActive();
    const memo = this.cache.baseTypeOfLiteral.get(type);
    if (memo !== undefined) return memo;
    const flags = type.flags;
    let base: Type;
    if (flags & (TypeFlags.EnumLiteral | TypeFlags.Enum) || flags & TypeFlags.Union) {
      base = this.raw.getBaseTypeOfLiteralType(type) ?? type;
    } else if (flags & (TypeFlags.StringLiteral | TypeFlags.TemplateLiteral)) {
      base = this.getStringType();
    } else if (flags & TypeFlags.NumberLiteral) {
      base = this.getNumberType();
    } else if (flags & TypeFlags.BigIntLiteral) {
      base = this.intrinsic("bigint", () => this.raw.getBigIntType());
    } else if (flags & TypeFlags.BooleanLiteral) {
      base = this.getBooleanType();
    } else {
      base = type;
    }
    this.cache.baseTypeOfLiteral.set(type, base);
    return base;
  }

  private intrinsic(name: string, fetch: () => Type): Type {
    let type = this.cache.intrinsics.get(name);
    if (type === undefined) {
      type = fetch();
      this.cache.intrinsics.set(name, type);
    }
    return type;
  }

  /** 5.9.3's checker.getConstantValue, memoized per node. The one caller
   * (enum lowering) passes ENUM MEMBER declaration nodes only: 7 answers
   * the member's computed constant there for const and regular enums alike
   * (access-expression queries answer const enums only — same as 5.9.3 —
   * so the lowering resolves the member symbol and asks its declaration). */
  getConstantValue(node: Node): string | number | undefined {
    this.ensureActive();
    if (this.cache.constantValueOf.has(node)) return this.cache.constantValueOf.get(node);
    const value = this.raw.getConstantValue(node);
    this.cache.constantValueOf.set(node, value);
    return value;
  }

  getNonNullableType(type: Type): Type {
    this.ensureActive();
    if (this.cache.nonNullableType.has(type)) return this.cache.nonNullableType.get(type) ?? type;
    const result = this.raw.getNonNullableType(type);
    this.cache.nonNullableType.set(type, result);
    return result ?? type;
  }

  getPropertiesOfType(type: Type): readonly Ts7Symbol[] {
    this.ensureActive();
    let props = this.cache.propertiesOfType.get(type);
    if (props === undefined) {
      props = this.raw.getPropertiesOfType(type);
      this.cache.propertiesOfType.set(type, props);
    }
    return props;
  }

  getBaseTypes(type: InterfaceType): readonly Type[] {
    this.ensureActive();
    let bases = this.cache.baseTypesOf.get(type);
    if (bases === undefined) {
      bases = this.raw.getBaseTypes(type);
      this.cache.baseTypesOf.set(type, bases);
    }
    return bases;
  }

  /** Distributed intersections retain their original flags in the client
   * even when conflicting discriminants reduce the type to never. Ask the
   * checker for that semantic answer instead of inspecting display text. */
  isNeverType(type: Type): boolean {
    this.ensureActive();
    if (type.flags & TypeFlags.Never) return true;
    if (!(type.flags & (TypeFlags.Intersection | TypeFlags.Union))) return false;
    let answer = this.cache.neverTypeAnswer.get(type);
    if (answer === undefined) {
      const never = this.intrinsic("never", () => this.raw.getNeverType());
      answer = this.raw.isTypeAssignableTo(type, never);
      this.cache.neverTypeAnswer.set(type, answer);
    }
    return answer;
  }

  isTypeAssignableTo(source: Type, target: Type): boolean {
    this.ensureActive();
    if (source === target) return true;
    let targets = this.cache.assignableTypes.get(source);
    if (targets === undefined) {
      targets = new Map<Type, boolean>();
      this.cache.assignableTypes.set(source, targets);
    }
    let answer = targets.get(target);
    if (answer === undefined) {
      answer = this.raw.isTypeAssignableTo(source, target);
      targets.set(target, answer);
    }
    return answer;
  }

  getIndexInfosOfType(type: Type): readonly IndexInfo[] {
    this.ensureActive();
    let infos = this.cache.indexInfosOfType.get(type);
    if (infos === undefined) {
      infos = this.raw.getIndexInfosOfType(type);
      this.cache.indexInfosOfType.set(type, infos);
    }
    return infos;
  }

  getTypeArguments(type: TypeReference): readonly Type[] {
    this.ensureActive();
    let args = this.cache.typeArgumentsOf.get(type);
    if (args === undefined) {
      // 5.9.3 answered [] for a non-reference passed by cast (the lowering
      // leans on that — a concretely-declared interface takes the same
      // path as its generic @types twin); tsgo PANICS on it, so the
      // reference check happens client-side (free — objectFlags).
      args = (type as Type).isTypeReference() ? this.raw.getTypeArguments(type) : [];
      this.cache.typeArgumentsOf.set(type, args);
    }
    return args;
  }

  isArrayType(type: Type): boolean {
    this.ensureActive();
    // Arrays are object types. The raw checker agrees that primitive,
    // union/intersection, and type-parameter objects themselves are not
    // arrays (a narrowed array arm arrives as its object type), so avoid a
    // request for every visibly non-object type just as isTupleType does.
    if (!(type.flags & TypeFlags.Object)) return false;
    let answer = this.cache.arrayTypeAnswer.get(type);
    if (answer === undefined) {
      answer = this.raw.isArrayType(type);
      this.cache.arrayTypeAnswer.set(type, answer);
    }
    return answer;
  }

  /** 5.9.3's checker.isTupleType answers true for tuple SHAPES and for
   * REFERENCES to them (Pair<number>, a readonly [T, T] instantiation).
   * The 7.0.2 client-side Type.isTupleType() sees only the shape — a
   * reference answers false there (measured; the facade suite pins it) —
   * so shape-true and non-object-false resolve locally and only object
   * types that are not visibly tuples round-trip, memoized. */
  isTupleType(type: Type): boolean {
    this.ensureActive();
    if (type.isTupleType()) return true;
    if (!(type.flags & TypeFlags.Object)) return false;
    let answer = this.cache.tupleTypeAnswer.get(type);
    if (answer === undefined) {
      answer = this.raw.isTupleType(type);
      this.cache.tupleTypeAnswer.set(type, answer);
    }
    return answer;
  }

  isArrayLikeType(type: Type): boolean {
    this.ensureActive();
    let answer = this.cache.arrayLikeAnswer.get(type);
    if (answer === undefined) {
      answer = this.raw.isArrayLikeType(type);
      this.cache.arrayLikeAnswer.set(type, answer);
    }
    return answer;
  }

  typeToString(type: Type, enclosingDeclaration?: Node, flags?: number): string {
    this.ensureActive();
    if (enclosingDeclaration === undefined && flags === undefined) {
      let text = this.cache.typeStringOf.get(type);
      if (text === undefined) {
        text = this.raw.typeToString(type);
        this.cache.typeStringOf.set(type, text);
      }
      return text;
    }
    return this.raw.typeToString(type, enclosingDeclaration, flags);
  }

  getTypeOfSymbolAtLocation(symbol: Ts7Symbol, location: Node): Type {
    this.ensureActive();
    // Two-key query with one census call site: no memo, straight through.
    return this.raw.getTypeOfSymbolAtLocation(symbol, location);
  }

  getUnknownType(): Type {
    this.ensureActive();
    if (this.cache.unknownType === null) this.cache.unknownType = this.raw.getUnknownType();
    return this.cache.unknownType;
  }

  getStringType(): Type {
    this.ensureActive();
    return this.intrinsic("string", () => this.raw.getStringType());
  }

  getNumberType(): Type {
    this.ensureActive();
    return this.intrinsic("number", () => this.raw.getNumberType());
  }

  getBooleanType(): Type {
    this.ensureActive();
    return this.intrinsic("boolean", () => this.raw.getBooleanType());
  }

  /** 7.0.2 dropped getAwaitedType (the census's one MISSING checker method).
   * Shimmed per the survey: unwrap Promise/PromiseLike references through
   * their type argument, distributing over unions. The client cannot BUILD
   * union types, so a union whose arms unwrap to more than one distinct type
   * returns undefined (callers fall back to the input; the census's one call
   * site does exactly that) — a union like `T | PromiseLike<T>` collapses by
   * object identity to T, which is the pattern that call site exists for. */
  getAwaitedType(type: Type): Type | undefined {
    this.ensureActive();
    if (this.cache.awaitedTypeOf.has(type)) return this.cache.awaitedTypeOf.get(type);
    const awaited = this.computeAwaitedType(type, 0);
    this.cache.awaitedTypeOf.set(type, awaited);
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
      const distinct: Type[] = [];
      const seen = new Set<Type>();
      for (const arm of awaited) {
        if (arm !== undefined && !seen.has(arm)) {
          seen.add(arm);
          distinct.push(arm);
        }
      }
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
    const name = type.getTarget()?.getSymbol()?.name;
    if (name !== "Promise" && name !== "PromiseLike") return null;
    const args = this.getTypeArguments(type);
    return args[0] ?? null;
  }
}
