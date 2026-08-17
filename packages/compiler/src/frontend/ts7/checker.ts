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
 * 2. PER-FILE BATCH PREFETCH. The first getTypeAtLocation/getSymbolAtLocation
 *    miss in a source file walks the whole file client-side (free — the AST
 *    is local) and issues the ARRAY overloads for every node, chunked, then
 *    answers all later queries for that file from the memo. The lowering's
 *    walk touches most of a file anyway, so prefetching the file is the
 *    batching lever without changing a single call site. prefetchSourceFile()
 *    exposes the same hook explicitly. Symbol prefetch also batch-fetches
 *    getTypeOfSymbol over every symbol the file mentions (5,333 calls of the
 *    mock-gateway census ride that pattern).
 *
 * 3. CLIENT-SIDE FAST PATHS. getBaseTypeOfLiteralType — the census's single
 *    hottest method (9,059 calls on mock-gateway) — is answered locally from
 *    type.flags plus the intrinsic-type singletons for the literal kinds
 *    5.9.3 maps to intrinsics (string/number/bigint/boolean literals), with
 *    IPC only for enum-ish and union types. isTupleType answers shape-true
 *    and non-object-false locally and round-trips (memoized) only for
 *    object types. Both verified against the raw checker AND against 5.9.3
 *    by the adapter's suites. */

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
  SyntaxKind.PropertyAccessExpression,
  SyntaxKind.ObjectLiteralExpression,
  SyntaxKind.ArrayLiteralExpression,
  SyntaxKind.ConditionalExpression,
]);

/** Preorder sweep of the whole file, ITERATIVE (walkPreorder): the obvious
 * recursive forEachChild walk overflowed the stack HERE, in the prefetch
 * sweep, on the binderBinaryExpressionStress chains — before lowering could
 * answer with its SC1090 nesting fence. */
function collectNodes(sf: Node): Node[] {
  const nodes: Node[] = [];
  walkPreorder(sf, (n, depth) => {
    nodes.push(n);
    if (depth >= PREFETCH_MAX_DEPTH) return "skip";
    return undefined;
  });
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
    if (!project) throw new Error("CheckerFacade built without a project cannot resolve declarations");
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

  private prefetchTypes(sf: SourceFile): void {
    if (this.prefetchedTypes.has(sf)) return;
    this.prefetchedTypes.add(sf);
    this.prefetchTypesIn(sf);
  }

  private prefetchTypesIn(root: Node): void {
    const nodes = collectNodes(root).filter(
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
    this.prefetchSymbolsIn(sf);
  }

  private prefetchSymbolsIn(root: Node): void {
    const nodes = collectNodes(root).filter(
      (n) => n.kind === SyntaxKind.Identifier && !this.symbolAtLocation.has(n),
    );
    // The same bisecting panic fence as the type sweep: tsgo panics on
    // SYMBOL queries too (observed: GetSymbolAtLocation over an
    // `import.defer(...)` callee — the sweep's batch must not turn one
    // poisonous node into a build crash).
    const symbols = chunked(nodes, (chunk) =>
      withPanicFence(chunk, (c) => this.raw.getSymbolAtLocation(c)),
    );
    nodes.forEach((n, i) => this.symbolAtLocation.set(n, symbols[i]));
    // The walk's companion query: types of the symbols the file mentions.
    const distinct = [...new Set(symbols.filter((s): s is Ts7Symbol => s !== undefined))].filter(
      (s) => !this.typeOfSymbol.has(s),
    );
    const symbolTypes = chunked(distinct, (chunk) =>
      withPanicFence(chunk, (c) => this.raw.getTypeOfSymbol(c)),
    );
    distinct.forEach((s, i) => this.typeOfSymbol.set(s, symbolTypes[i]));
  }

  private autoPrefetch(node: Node, kind: "types" | "symbols"): void {
    if (this.options.autoPrefetch === false) return;
    const sf = node.getSourceFile();
    if (kind === "types") this.prefetchTypes(sf);
    else this.prefetchSymbols(sf);
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
    let answer = this.arrayTypeAnswer.get(type);
    if (answer === undefined) {
      answer = this.raw.isArrayType(type);
      this.arrayTypeAnswer.set(type, answer);
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
    if (type.isTupleType()) return true;
    if (!(type.flags & TypeFlags.Object)) return false;
    let answer = this.tupleTypeAnswer.get(type);
    if (answer === undefined) {
      answer = this.raw.isTupleType(type);
      this.tupleTypeAnswer.set(type, answer);
    }
    return answer;
  }

  isArrayLikeType(type: Type): boolean {
    let answer = this.arrayLikeAnswer.get(type);
    if (answer === undefined) {
      answer = this.raw.isArrayLikeType(type);
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
      const arms = type.getTypes();
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
