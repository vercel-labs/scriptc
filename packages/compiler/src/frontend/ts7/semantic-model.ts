import type {
  SemanticSignatureData as SignatureResponse,
  SemanticSymbolData as SymbolResponse,
  SemanticTypeData as TypeResponse,
} from "./semantic-schema.generated.js";
import { AstNode } from "./ast-node.js";
import type { __String } from "./ast-types.js";
import type * as enums from "./enums.generated.js";
import { parseAstNodeHandle, syntaxKind71 } from "./ast-wire.js";
import type { SemanticChecker, SemanticJsDocTag } from "./semantic-checker.js";
import { decodeSemanticObject, decodeSemanticObjects, parseSemanticJson } from "./semantic-json.js";
import {
  SemanticObjectFlags as ObjectFlags,
  SemanticSignatureFlags as SignatureFlags,
  SemanticTypeFlags as TypeFlags,
} from "./semantic-schema.generated.js";

/** JSON and binary operations stay at the transport boundary. The concrete
 * semantic objects below need neither the SDK nor a JavaScript engine. */
/** The elements of a reply that has no nulls: a null element fails as it
 * would when read as an object. */
export function present<T>(items: (T | undefined)[], method: string): T[] {
  for (const item of items)
    if (item === undefined) throw new TypeError(`${method} returned a null element`);
  return items as T[];
}

export interface SemanticTransport {
  text: (method: string, payload: string) => string;
  binary: (method: string, payload: string) => Uint8Array;
}

export type SemanticDocument = string | { uri: string };

/** The pinned checker protocol's request fields. A single concrete record
 * keeps generic response decoding independent of structural object spread. */
export interface SemanticQuery {
  snapshot?: number | undefined;
  project?: string | undefined;
  objectId?: number | undefined;
  location?: string | undefined;
  locations?: string[] | undefined;
  file?: SemanticDocument | undefined;
  position?: number | undefined;
  positions?: readonly number[] | undefined;
  type?: number | undefined;
  /** A symbol's id; on a TypeScript 7.1 server, its reference (SemanticProject.encode). */
  symbol?: number | Ts71SymbolReference | undefined;
  symbols?: (number | Ts71SymbolReference)[] | undefined;
  signature?: number | undefined;
  source?: number | undefined;
  target?: number | undefined;
  kind?: number | undefined;
  name?: string | undefined;
  flags?: number | undefined;
  meaning?: number | undefined;
  excludeGlobals?: boolean | undefined;
  index?: number | undefined;
  node?: string | undefined;
  signatureDecl?: string | undefined;
  triggerCharacter?: string | undefined;
  includeSymbol?: boolean | undefined;
}

/** A symbol in TypeScript 7.1's protocol: its owner, a source file (kind 0)
 * or the snapshot and project (kind 1), and its id within that owner. */
export interface Ts71SymbolReference {
  kind: number;
  file?: Ts71SourceFileDescriptor;
  snapshot?: number;
  project?: string;
  id: number;
}

export interface Ts71SourceFileDescriptor {
  fileName: string;
  path: string;
  contentHash: string;
  parseOptionsKey: string;
  scriptKind: number;
  nodeId: string;
}

/** A symbol another TypeScript 7.1 response names: its id and, for a symbol
 * a source file owns, the file's node ID. Without a file, the response's
 * snapshot and project own it. */
export interface Ts71CompactReference {
  id: number;
  file?: string;
}

/** A symbol as TypeScript 7.1 reports it. */
export interface Ts71SymbolData {
  reference: Ts71SymbolReference;
  name: string;
  flags: number;
  checkFlags: number;
  declarations?: string[];
  valueDeclaration?: string;
  parent?: Ts71CompactReference;
  exportSymbol?: Ts71CompactReference;
}

/** A type as TypeScript 7.1 reports it: TypeResponse with compact symbol
 * references. */
export interface Ts71TypeData {
  id: number;
  flags: number;
  objectFlags?: number;
  value?: string | number | boolean | null;
  freshType?: number;
  regularType?: number;
  target?: number;
  typeParameters?: number[];
  outerTypeParameters?: number[];
  localTypeParameters?: number[];
  elementFlags?: number[];
  fixedLength?: number;
  readonly?: boolean;
  objectType?: number;
  indexType?: number;
  checkType?: number;
  extendsType?: number;
  baseType?: number;
  substConstraint?: number;
  texts?: string[];
  intrinsicName?: string;
  isThisType?: boolean;
  /** Whether the type is a tuple type, which 7.0 answers with isTupleType. */
  isTupleType?: boolean;
  aliasTypeArguments?: number[];
  aliasSymbol?: Ts71CompactReference;
  symbol?: Ts71CompactReference;
}

/** A signature as TypeScript 7.1 reports it. */
export interface Ts71SignatureData {
  id: number;
  flags: number;
  declaration?: string;
  typeParameters?: number[];
  parameters?: Ts71CompactReference[];
  thisParameter?: Ts71CompactReference;
  target?: number;
}

/** The methods whose source is a symbol: TypeScript 7.0 names it by
 * `objectId`, 7.1 by its reference in `symbol`. */
const SYMBOL_PROPERTY_METHODS = new Set([
  "getParentOfSymbol",
  "getExportSymbolOfSymbol",
  "getMembersOfSymbol",
  "getExportsOfSymbol",
]);

/** The methods TypeScript 7.1 gives their type or signature in `objectId`,
 * where 7.0 takes it in `type` or `signature`. */
const OBJECT_ID_METHODS_7_1 = new Map<string, "type" | "signature">([
  ["getApparentType", "type"],
  ["getConstraintOfTypeParameter", "type"],
  ["getNonNullableType", "type"],
  ["getReturnTypeOfSignature", "signature"],
]);

/** TypeScript 7.1's symbol references by local id. The semantic model keeps
 * TypeScript 7.0's numeric symbol ids; on a 7.1 server, each symbol owner
 * and id gets a local id, and requests send the reference back. A compact
 * reference gets the local id of the symbol it names, so a later response
 * with that symbol's full reference finds the same id. */
export class Ts71SymbolTable {
  private readonly locals = new Map<string, number>();
  private readonly references: (Ts71SymbolReference | undefined)[] = [undefined];

  private allocate(key: string): number {
    let local = this.locals.get(key);
    if (local === undefined) {
      local = this.references.length;
      this.references.push(undefined);
      this.locals.set(key, local);
    }
    return local;
  }

  /** The local id of `reference`, which requests then name it by. */
  fromReference(reference: Ts71SymbolReference): number {
    const key =
      reference.kind === 0
        ? `f${reference.file?.nodeId ?? ""}:${reference.id}`
        : `s${reference.project ?? ""}:${reference.id}`;
    const local = this.allocate(key);
    this.references[local] = reference;
    return local;
  }

  /** The local id of a compact reference in a response for `project`. */
  fromCompact(reference: Ts71CompactReference, project: string): number {
    return this.allocate(
      reference.file !== undefined
        ? `f${reference.file}:${reference.id}`
        : `s${project}:${reference.id}`,
    );
  }

  /** The reference of local id `local`. Throws for a symbol no response has
   * described yet. */
  reference(local: number): Ts71SymbolReference {
    const reference = this.references[local];
    if (reference === undefined) throw new Error(`Unknown TypeScript 7.1 symbol ${local}`);
    return reference;
  }

  /** `data` in TypeScript 7.0's shape, with local ids. */
  symbolData(data: Ts71SymbolData, project: string): SymbolResponse {
    const result: SymbolResponse = {
      id: this.fromReference(data.reference),
      project,
      name: data.name,
      flags: data.flags,
      checkFlags: data.checkFlags,
    };
    if (data.declarations !== undefined) result.declarations = data.declarations;
    if (data.valueDeclaration !== undefined) result.valueDeclaration = data.valueDeclaration;
    if (data.parent !== undefined) result.parent = this.fromCompact(data.parent, project);
    if (data.exportSymbol !== undefined)
      result.exportSymbol = this.fromCompact(data.exportSymbol, project);
    return result;
  }

  typeData(data: Ts71TypeData, project: string): TypeResponse {
    const result: TypeResponse = { id: data.id, flags: data.flags };
    if (data.objectFlags !== undefined) result.objectFlags = data.objectFlags;
    if (data.value !== undefined) result.value = data.value;
    if (data.freshType !== undefined) result.freshType = data.freshType;
    if (data.regularType !== undefined) result.regularType = data.regularType;
    if (data.target !== undefined) result.target = data.target;
    if (data.typeParameters !== undefined) result.typeParameters = data.typeParameters;
    if (data.outerTypeParameters !== undefined)
      result.outerTypeParameters = data.outerTypeParameters;
    if (data.localTypeParameters !== undefined)
      result.localTypeParameters = data.localTypeParameters;
    if (data.elementFlags !== undefined) result.elementFlags = data.elementFlags;
    if (data.fixedLength !== undefined) result.fixedLength = data.fixedLength;
    if (data.readonly !== undefined) result.readonly = data.readonly;
    if (data.objectType !== undefined) result.objectType = data.objectType;
    if (data.indexType !== undefined) result.indexType = data.indexType;
    if (data.checkType !== undefined) result.checkType = data.checkType;
    if (data.extendsType !== undefined) result.extendsType = data.extendsType;
    if (data.baseType !== undefined) result.baseType = data.baseType;
    if (data.substConstraint !== undefined) result.substConstraint = data.substConstraint;
    if (data.texts !== undefined) result.texts = data.texts;
    if (data.intrinsicName !== undefined) result.intrinsicName = data.intrinsicName;
    if (data.isThisType !== undefined) result.isThisType = data.isThisType;
    if (data.aliasTypeArguments !== undefined) result.aliasTypeArguments = data.aliasTypeArguments;
    if (data.aliasSymbol !== undefined)
      result.aliasSymbol = this.fromCompact(data.aliasSymbol, project);
    if (data.symbol !== undefined) result.symbol = this.fromCompact(data.symbol, project);
    return result;
  }

  signatureData(data: Ts71SignatureData, project: string): SignatureResponse {
    const result: SignatureResponse = { id: data.id, flags: data.flags };
    if (data.declaration !== undefined) result.declaration = data.declaration;
    if (data.typeParameters !== undefined) result.typeParameters = data.typeParameters;
    if (data.parameters !== undefined)
      result.parameters = data.parameters.map((parameter) => this.fromCompact(parameter, project));
    if (data.thisParameter !== undefined)
      result.thisParameter = this.fromCompact(data.thisParameter, project);
    if (data.target !== undefined) result.target = data.target;
    return result;
  }
}

export class SemanticProgram {
  constructor(private readonly sourceFile: (path: string) => AstNode | undefined) {}
  getSourceFile(path: string): AstNode | undefined {
    // Called as a plain function: the instance is not its receiver.
    const sourceFile = this.sourceFile;
    return sourceFile(path);
  }
}

/** Symbols are snapshot-wide; TypeScript type and signature handles are
 * project-local. Preserve both scopes even when numeric handles coincide. */
export class SemanticSnapshot {
  private readonly projects = new Map<string, SemanticProject>();
  private readonly symbols = new Map<number, SemanticSymbol>();
  private disposed = false;

  /** TypeScript 7.1's symbol references, on a server that speaks 7.1. */
  readonly references: Ts71SymbolTable | undefined;

  constructor(
    readonly id: number,
    readonly transport: SemanticTransport,
    ts71 = false,
  ) {
    this.references = ts71 ? new Ts71SymbolTable() : undefined;
  }

  addProject(id: string, sourceFile: (path: string) => AstNode | undefined): SemanticProject {
    this.ensureActive();
    if (this.projects.has(id)) throw new Error(`Duplicate TypeScript project ${id}`);
    const project = new SemanticProject(id, this, new SemanticProgram(sourceFile));
    this.projects.set(id, project);
    return project;
  }

  getProject(id: string): SemanticProject {
    this.ensureActive();
    const project = this.projects.get(id);
    if (project === undefined) throw new Error(`Unknown TypeScript canonical project ${id}`);
    return project;
  }

  symbol(data: SymbolResponse): SemanticSymbol {
    this.ensureActive();
    let symbol = this.symbols.get(data.id);
    if (symbol === undefined) {
      symbol = new SemanticSymbol(data, this.getProject(data.project));
      this.symbols.set(data.id, symbol);
    }
    return symbol;
  }

  cachedSymbol(id: number): SemanticSymbol | undefined {
    this.ensureActive();
    return this.symbols.get(id);
  }

  ensureActive(): void {
    if (this.disposed) throw new Error("TypeScript semantic snapshot is disposed");
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const project of this.projects.values()) project.dispose();
    this.projects.clear();
    for (const symbol of this.symbols.values()) symbol.dispose();
    this.symbols.clear();
  }
}

export class SemanticProject {
  private readonly types = new Map<number, SemanticType>();
  /** TypeScript 7.1's isTupleType answers, by type id: 7.1 reports them on
   * the type instead of answering an isTupleType request. */
  private readonly tupleTypes = new Map<number, boolean>();
  private readonly signatures = new Map<number, SemanticSignature>();
  private readonly cleanups: (() => void)[] = [];
  private disposed = false;

  constructor(
    readonly id: string,
    readonly snapshot: SemanticSnapshot,
    readonly program: SemanticProgram,
  ) {}

  ensureActive(): void {
    this.snapshot.ensureActive();
    if (this.disposed) throw new Error("TypeScript semantic project is disposed");
  }

  /** Project-local consumers register cleanup without adding a global root.
   * Registration after disposal is rejected just like semantic queries. */
  onDispose(cleanup: () => void): void {
    this.ensureActive();
    this.cleanups.push(cleanup);
  }

  /** `query` for `method` in this project's snapshot. On a TypeScript 7.1
   * server, symbol ids become their references, and a symbol property
   * method takes its source symbol's reference in `symbol`. */
  private encode(method: string, query: SemanticQuery): string {
    this.ensureActive();
    query.snapshot = this.snapshot.id;
    query.project = this.id;
    const references = this.snapshot.references;
    if (references !== undefined) {
      if (typeof query.symbol === "number") query.symbol = references.reference(query.symbol);
      if (query.symbols !== undefined)
        query.symbols = query.symbols.map((symbol) =>
          typeof symbol === "number" ? references.reference(symbol) : symbol,
        );
      if (SYMBOL_PROPERTY_METHODS.has(method) && query.objectId !== undefined) {
        query.symbol = references.reference(query.objectId);
        query.objectId = undefined;
      }
      // signatureToSignatureDeclaration's kind is a SyntaxKind.
      if (method === "signatureToSignatureDeclaration" && query.kind !== undefined)
        query.kind = syntaxKind71(query.kind);
      const field = OBJECT_ID_METHODS_7_1.get(method);
      if (field === "type") {
        query.objectId = query.type;
        query.type = undefined;
      } else if (field === "signature") {
        query.objectId = query.signature;
        query.signature = undefined;
      }
    }
    return JSON.stringify(query);
  }

  request<T>(method: string, query: SemanticQuery = {}): T {
    return parseSemanticJson<T>(this.snapshot.transport.text(method, this.encode(method, query)));
  }

  requestBinary(method: string, query: SemanticQuery): Uint8Array {
    return this.snapshot.transport.binary(method, this.encode(method, query));
  }

  /** A type a TypeScript 7.1 reply holds. */
  type71(data: Ts71TypeData): SemanticType {
    const references = this.snapshot.references;
    if (references === undefined) throw new Error("TypeScript 7.1 type from a 7.0 server");
    this.tupleTypes.set(data.id, data.isTupleType === true);
    return this.type(references.typeData(data, this.id));
  }

  /** Whether a type a TypeScript 7.1 server reported is a tuple type. */
  isTupleType71(type: number): boolean {
    const result = this.tupleTypes.get(type);
    if (result === undefined) throw new Error(`Unknown TypeScript 7.1 type ${type}`);
    return result;
  }

  /** Whether the server speaks TypeScript 7.1's protocol. */
  ts71(): boolean {
    return this.snapshot.references !== undefined;
  }

  /** A symbol a TypeScript 7.1 reply holds. */
  symbol71(data: Ts71SymbolData): SemanticSymbol {
    const references = this.snapshot.references;
    if (references === undefined) throw new Error("TypeScript 7.1 symbol from a 7.0 server");
    return this.symbol(references.symbolData(data, this.id));
  }

  /** The local id of a symbol id a TypeScript 7.1 server reports as a plain
   * number (getWellKnownSymbols): a symbol of this project's snapshot. */
  snapshotSymbolId(id: number): number {
    const references = this.snapshot.references;
    return references === undefined ? id : references.fromCompact({ id }, this.id);
  }

  /** A reply of one type, or undefined for null. */
  requestType(method: string, query: SemanticQuery): SemanticType | undefined {
    const bytes = this.requestBinary(method, query);
    const cached = (id: number): SemanticType | undefined => this.types.get(id);
    const references = this.snapshot.references;
    if (references !== undefined) {
      const build71 = (data: Ts71TypeData): SemanticType => this.type71(data);
      return decodeSemanticObject(bytes, cached, build71) ?? undefined;
    }
    const build = (data: TypeResponse): SemanticType => this.type(data);
    return decodeSemanticObject(bytes, cached, build) ?? undefined;
  }

  /** A reply of types and nulls (undefined here), or [] for null. */
  requestTypes(method: string, query: SemanticQuery): (SemanticType | undefined)[] {
    const bytes = this.requestBinary(method, query);
    const cached = (id: number): SemanticType | undefined => this.types.get(id);
    const references = this.snapshot.references;
    if (references !== undefined) {
      const build71 = (data: Ts71TypeData): SemanticType => this.type71(data);
      return (decodeSemanticObjects(bytes, cached, build71) ?? []).map((item) => item ?? undefined);
    }
    const build = (data: TypeResponse): SemanticType => this.type(data);
    return (decodeSemanticObjects(bytes, cached, build) ?? []).map((item) => item ?? undefined);
  }

  /** A reply of one symbol, or undefined for null. */
  requestSymbol(method: string, query: SemanticQuery): SemanticSymbol | undefined {
    const bytes = this.requestBinary(method, query);
    const references = this.snapshot.references;
    if (references !== undefined) {
      // TypeScript 7.1's symbols start with their reference, not an id.
      const none = (): SemanticSymbol | undefined => undefined;
      const build71 = (data: Ts71SymbolData): SemanticSymbol =>
        this.symbol(references.symbolData(data, this.id));
      return decodeSemanticObject(bytes, none, build71) ?? undefined;
    }
    const cached = (id: number): SemanticSymbol | undefined => this.snapshot.cachedSymbol(id);
    const build = (data: SymbolResponse): SemanticSymbol => this.symbol(data);
    return decodeSemanticObject(bytes, cached, build) ?? undefined;
  }

  /** A reply of symbols and nulls (undefined here), or [] for null. */
  requestSymbols(method: string, query: SemanticQuery): (SemanticSymbol | undefined)[] {
    const bytes = this.requestBinary(method, query);
    const references = this.snapshot.references;
    if (references !== undefined) {
      const none = (): SemanticSymbol | undefined => undefined;
      const build71 = (data: Ts71SymbolData): SemanticSymbol =>
        this.symbol(references.symbolData(data, this.id));
      return (decodeSemanticObjects(bytes, none, build71) ?? []).map((item) => item ?? undefined);
    }
    const cached = (id: number): SemanticSymbol | undefined => this.snapshot.cachedSymbol(id);
    const build = (data: SymbolResponse): SemanticSymbol => this.symbol(data);
    return (decodeSemanticObjects(bytes, cached, build) ?? []).map((item) => item ?? undefined);
  }

  /** A reply of one signature, or undefined for null. */
  requestSignature(method: string, query: SemanticQuery): SemanticSignature | undefined {
    const bytes = this.requestBinary(method, query);
    const cached = (id: number): SemanticSignature | undefined => this.signatures.get(id);
    const references = this.snapshot.references;
    if (references !== undefined) {
      const build71 = (data: Ts71SignatureData): SemanticSignature =>
        this.signature(references.signatureData(data, this.id));
      return decodeSemanticObject(bytes, cached, build71) ?? undefined;
    }
    const build = (data: SignatureResponse): SemanticSignature => this.signature(data);
    return decodeSemanticObject(bytes, cached, build) ?? undefined;
  }

  /** A reply of signatures and nulls (undefined here), or [] for null. */
  requestSignatures(method: string, query: SemanticQuery): (SemanticSignature | undefined)[] {
    const bytes = this.requestBinary(method, query);
    const cached = (id: number): SemanticSignature | undefined => this.signatures.get(id);
    const references = this.snapshot.references;
    if (references !== undefined) {
      const build71 = (data: Ts71SignatureData): SemanticSignature =>
        this.signature(references.signatureData(data, this.id));
      return (decodeSemanticObjects(bytes, cached, build71) ?? []).map((item) => item ?? undefined);
    }
    const build = (data: SignatureResponse): SemanticSignature => this.signature(data);
    return (decodeSemanticObjects(bytes, cached, build) ?? []).map((item) => item ?? undefined);
  }

  type(data: TypeResponse): SemanticType {
    this.ensureActive();
    let type = this.types.get(data.id);
    if (type === undefined) {
      type = new SemanticType(data, this);
      this.types.set(data.id, type);
    }
    return type;
  }

  signature(data: SignatureResponse): SemanticSignature {
    this.ensureActive();
    let signature = this.signatures.get(data.id);
    if (signature === undefined) {
      signature = new SemanticSignature(data, this);
      this.signatures.set(data.id, signature);
    }
    return signature;
  }

  symbol(data: SymbolResponse): SemanticSymbol {
    this.ensureActive();
    return this.snapshot.symbol(data);
  }

  fetchType(
    source: number,
    method: string,
    handle: number | undefined | false,
  ): SemanticType | undefined {
    this.ensureActive();
    if (handle !== false) {
      if (handle === undefined || handle === 0) return undefined;
      const cached = this.types.get(handle);
      if (cached !== undefined) return cached;
    }
    const type = this.requestType(method, { objectId: source });
    if (type === undefined) throw new Error(`${method} returned null type for ${source}`);
    return type;
  }

  fetchSymbol(
    source: number,
    method: string,
    handle: number | undefined,
  ): SemanticSymbol | undefined {
    this.ensureActive();
    if (handle === undefined || handle === 0) return undefined;
    const cached = this.snapshot.cachedSymbol(handle);
    if (cached !== undefined) return cached;
    const symbol = this.requestSymbol(method, { objectId: source });
    if (symbol === undefined) throw new Error(`${method} returned null symbol for ${source}`);
    return symbol;
  }

  fetchSignature(
    source: number,
    method: string,
    handle: number | undefined,
  ): SemanticSignature | undefined {
    this.ensureActive();
    if (handle === undefined || handle === 0) return undefined;
    const cached = this.signatures.get(handle);
    if (cached !== undefined) return cached;
    const signature = this.requestSignature(method, { objectId: source });
    if (signature === undefined) throw new Error(`${method} returned null signature for ${source}`);
    return signature;
  }

  fetchTypes(source: number, method: string, handles?: readonly number[]): SemanticType[] {
    this.ensureActive();
    if (handles !== undefined) {
      const cached: SemanticType[] = [];
      for (const id of handles) {
        const type = this.types.get(id);
        if (type === undefined) break;
        cached.push(type);
      }
      if (cached.length === handles.length) return cached;
    }
    return present(this.requestTypes(method, { objectId: source }), method);
  }

  fetchSymbols(source: number, method: string, handles?: readonly number[]): SemanticSymbol[] {
    this.ensureActive();
    if (handles !== undefined) {
      const cached: SemanticSymbol[] = [];
      for (const id of handles) {
        const symbol = this.snapshot.cachedSymbol(id);
        if (symbol === undefined) break;
        cached.push(symbol);
      }
      if (cached.length === handles.length) return cached;
    }
    return present(this.requestSymbols(method, { objectId: source }), method);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const type of this.types.values()) type.dispose();
    this.types.clear();
    this.signatures.clear();
    // Detach before invoking callbacks so reentrant disposal is harmless.
    const cleanups = this.cleanups.slice();
    this.cleanups.length = 0;
    for (const cleanup of cleanups) cleanup();
  }
}

/** A handle records its producing project, so declaration resolution is
 * unambiguous even when a symbol is reused by a second project's checker. */
export class SemanticNodeHandle {
  readonly index: number;
  readonly kind: number;
  readonly path: string;

  constructor(
    readonly handle: string,
    readonly canonicalProject: SemanticProject,
  ) {
    const parsed = parseAstNodeHandle(handle);
    this.index = parsed.index;
    this.kind = parsed.kind;
    this.path = parsed.path;
  }

  resolve(project: SemanticProject = this.canonicalProject): AstNode | undefined {
    this.canonicalProject.ensureActive();
    const file = project.program.getSourceFile(this.path);
    return file?.file.resolveHandle(this);
  }
}

export class SemanticSymbol {
  readonly id: number;
  /** The key of the member and export tables the symbol is in; `symbolName` gives its name. */
  readonly escapedName: __String;
  readonly flags: enums.SymbolFlags;
  readonly checkFlags: number;
  /** The declarations' node handles, as the server sends them. */
  readonly declarationHandles: SemanticNodeHandle[];
  readonly valueDeclarationHandle: SemanticNodeHandle | undefined;
  private declarationNodes: readonly AstNode[] | undefined;
  private valueDeclarationNode: AstNode | undefined;
  private valueDeclarationResolved = false;
  private readonly parent: number | undefined;
  private readonly exportSymbol: number | undefined;
  private membersCache: Map<__String, SemanticSymbol> | undefined;
  private exportsCache: Map<__String, SemanticSymbol> | undefined;

  constructor(
    data: SymbolResponse,
    readonly canonicalProject: SemanticProject,
  ) {
    this.id = data.id;
    this.escapedName = data.name as __String;
    this.flags = data.flags;
    this.checkFlags = data.checkFlags;
    this.declarationHandles = (data.declarations ?? []).map(
      (handle) => new SemanticNodeHandle(handle, canonicalProject),
    );
    this.valueDeclarationHandle = data.valueDeclaration
      ? new SemanticNodeHandle(data.valueDeclaration, canonicalProject)
      : undefined;
    this.parent = data.parent;
    this.exportSymbol = data.exportSymbol;
  }

  /** The declaration nodes, resolved in the symbol's project. A handle whose
   * file the project doesn't have resolves to nothing and is left out. */
  get declarations(): readonly AstNode[] {
    this.canonicalProject.ensureActive();
    if (this.declarationNodes === undefined) {
      const nodes: AstNode[] = [];
      for (const handle of this.declarationHandles) {
        const node = handle.resolve();
        if (node !== undefined) nodes.push(node);
      }
      this.declarationNodes = nodes;
    }
    return this.declarationNodes;
  }

  get valueDeclaration(): AstNode | undefined {
    this.canonicalProject.ensureActive();
    if (!this.valueDeclarationResolved) {
      this.valueDeclarationNode = this.valueDeclarationHandle?.resolve();
      this.valueDeclarationResolved = true;
    }
    return this.valueDeclarationNode;
  }

  getParent(): SemanticSymbol | undefined {
    return this.canonicalProject.fetchSymbol(this.id, "getParentOfSymbol", this.parent);
  }
  getExportSymbol(): SemanticSymbol {
    this.canonicalProject.ensureActive();
    if (this.exportSymbol === undefined || this.exportSymbol === 0) return this;
    const result = this.canonicalProject.fetchSymbol(
      this.id,
      "getExportSymbolOfSymbol",
      this.exportSymbol,
    );
    if (result === undefined) throw new Error(`Missing export symbol for ${this.id}`);
    return result;
  }
  private table(method: string): Map<__String, SemanticSymbol> {
    const table = new Map<__String, SemanticSymbol>();
    for (const symbol of this.canonicalProject.fetchSymbols(this.id, method))
      table.set(symbol.escapedName, symbol);
    return table;
  }
  getMembers(): Map<__String, SemanticSymbol> {
    this.canonicalProject.ensureActive();
    if (this.membersCache === undefined) this.membersCache = this.table("getMembersOfSymbol");
    return this.membersCache;
  }
  getExports(): Map<__String, SemanticSymbol> {
    this.canonicalProject.ensureActive();
    if (this.exportsCache === undefined) this.exportsCache = this.table("getExportsOfSymbol");
    return this.exportsCache;
  }
  dispose(): void {
    this.membersCache?.clear();
    this.exportsCache?.clear();
    this.membersCache = undefined;
    this.exportsCache = undefined;
  }
  getJsDocTags(checker: SemanticChecker): SemanticJsDocTag[] {
    return checker.getJsDocTagsOfSymbol(this);
  }
  getDocumentationComment(checker: SemanticChecker): string {
    return checker.getDocumentationCommentOfSymbol(this);
  }
}

/** The name of `symbol`, as TypeScript 7's API gives it: its escaped name, with the extra `_` of a
 * name that starts with `__` removed. */
export function symbolName(symbol: SemanticSymbol): string {
  const name: string = symbol.escapedName;
  return name.startsWith("___") ? name.slice(1) : name;
}

/** The key of the name `name` in a symbol table (`getExports()`, `getMembers()`): the name, with
 * an extra `_` when it starts with `__`. The inverse of `symbolName`. */
export function escapedSymbolName(name: string): __String {
  return (name.startsWith("__") ? `_${name}` : name) as __String;
}

/** `symbolName(symbol)`, or undefined without a symbol. */
export function symbolNameOf(symbol: SemanticSymbol | null | undefined): string | undefined {
  return symbol === undefined || symbol === null ? undefined : symbolName(symbol);
}

/** Type refinements keep the same native object, including its project and
 * lazy handle caches. Narrowed fields are read from their original storage. */
export type SemanticObjectType = SemanticType;
export interface SemanticTypeParameter extends SemanticType {
  readonly isThisType: boolean;
}
export interface SemanticTemplateLiteralType extends SemanticType {
  readonly texts: string[];
}
export interface SemanticIntrinsicType extends SemanticType {
  readonly intrinsicName: string;
}
export interface SemanticLiteralType extends SemanticType {
  readonly value: string | number | boolean | bigint;
}
export interface SemanticStringLiteralType extends SemanticLiteralType {
  readonly value: string;
}
export interface SemanticNumberLiteralType extends SemanticLiteralType {
  readonly value: number;
}
export interface SemanticBigIntLiteralType extends SemanticLiteralType {
  readonly value: bigint;
}
export interface SemanticBooleanLiteralType extends SemanticLiteralType {
  readonly value: boolean;
}
export interface SemanticTupleType extends SemanticObjectType {
  readonly elementFlags: enums.ElementFlags[];
  readonly fixedLength: number;
  readonly readonly: boolean;
}

/** Kind-specific accessors share one nominal layout. */
export class SemanticType {
  readonly id: number;
  readonly flags: enums.TypeFlags;
  /** The object flags of an object type; 0 for other types, as TypeScript 7's API gives them. */
  readonly objectFlags: enums.ObjectFlags;
  readonly value: string | number | boolean | bigint | undefined;
  readonly intrinsicName: string | undefined;
  /** Whether a type parameter is the `this` type; undefined for other types. */
  readonly isThisType: boolean | undefined;
  readonly elementFlags: enums.ElementFlags[] | undefined;
  readonly fixedLength: number | undefined;
  readonly readonly: boolean | undefined;
  readonly texts: string[] | undefined;
  private trueType: number | false = false;
  private falseType: number | false = false;
  private constituents: SemanticType[] | undefined;
  private constituentsPanic: Error | undefined;

  constructor(
    private readonly data: TypeResponse,
    readonly project: SemanticProject,
  ) {
    this.id = data.id;
    this.flags = data.flags;
    this.objectFlags = data.objectFlags ?? 0;
    const value = data.value;
    if ((data.flags & TypeFlags.BigIntLiteral) !== 0 && value != null) {
      if (typeof value !== "string")
        throw new Error("TypeScript bigint literal is not a decimal string");
      this.value = BigInt(value);
    } else {
      this.value = value ?? undefined;
    }
    this.intrinsicName = data.intrinsicName;
    this.isThisType =
      (data.flags & TypeFlags.TypeParameter) !== 0 ? (data.isThisType ?? false) : undefined;
    this.elementFlags = data.elementFlags;
    this.fixedLength = data.fixedLength;
    this.readonly = data.readonly;
    this.texts = data.texts;
  }

  getSymbol(): SemanticSymbol | undefined {
    return this.project.fetchSymbol(this.id, "getSymbolOfType", this.data.symbol);
  }
  getAliasSymbol(): SemanticSymbol | undefined {
    return this.project.fetchSymbol(this.id, "getAliasSymbolOfType", this.data.aliasSymbol);
  }
  getTarget(): SemanticType | undefined {
    return this.project.fetchType(this.id, "getTargetOfType", this.data.target);
  }
  getFreshType(): SemanticType | undefined {
    return this.project.fetchType(this.id, "getFreshTypeOfType", this.data.freshType);
  }
  getRegularType(): SemanticType | undefined {
    return this.project.fetchType(this.id, "getRegularTypeOfType", this.data.regularType);
  }
  getObjectType(): SemanticType | undefined {
    return this.project.fetchType(this.id, "getObjectTypeOfType", this.data.objectType);
  }
  getIndexType(): SemanticType | undefined {
    return this.project.fetchType(this.id, "getIndexTypeOfType", this.data.indexType);
  }
  getCheckType(): SemanticType | undefined {
    return this.project.fetchType(this.id, "getCheckTypeOfType", this.data.checkType);
  }
  getExtendsType(): SemanticType | undefined {
    return this.project.fetchType(this.id, "getExtendsTypeOfType", this.data.extendsType);
  }
  getBaseType(): SemanticType | undefined {
    return this.project.fetchType(this.id, "getBaseTypeOfType", this.data.baseType);
  }
  getConstraint(): SemanticType | undefined {
    return this.project.fetchType(this.id, "getConstraintOfType", this.data.substConstraint);
  }
  getTypeParameters(): SemanticTypeParameter[] {
    return this.project.fetchTypes(
      this.id,
      "getTypeParametersOfType",
      this.data.typeParameters ?? [],
    ) as SemanticTypeParameter[];
  }
  getOuterTypeParameters(): SemanticTypeParameter[] {
    return this.project.fetchTypes(
      this.id,
      "getOuterTypeParametersOfType",
      this.data.outerTypeParameters ?? [],
    ) as SemanticTypeParameter[];
  }
  getLocalTypeParameters(): SemanticTypeParameter[] {
    return this.project.fetchTypes(
      this.id,
      "getLocalTypeParametersOfType",
      this.data.localTypeParameters ?? [],
    ) as SemanticTypeParameter[];
  }
  getAliasTypeArguments(): SemanticType[] {
    return this.project.fetchTypes(
      this.id,
      "getAliasTypeArgumentsOfType",
      this.data.aliasTypeArguments ?? [],
    );
  }
  /** The members of a union or intersection, or the types of a template literal type; empty for
   * other types. */
  getTypes(): SemanticType[] {
    this.project.ensureActive();
    if ((this.flags & (TypeFlags.UnionOrIntersection | TypeFlags.TemplateLiteral)) === 0) return [];
    if (this.constituentsPanic !== undefined) throw this.constituentsPanic;
    if (this.constituents === undefined) {
      try {
        this.constituents = this.project.fetchTypes(this.id, "getTypesOfType");
      } catch (e) {
        // typescript-go panics serializing some constituents (an empty
        // tuple cloned as an array literal): answer every later read of
        // this snapshot's type with the same panic instead of a new
        // request.
        if (e instanceof Error && e.message.startsWith("panic:")) {
          // The widened union (the cloned empty tuple widens to a plain
          // array type) is readable and describes the same values; answer
          // with its members when typescript-go can serialize them.
          const widened = this.widenedConstituents();
          if (widened !== undefined) {
            this.constituents = widened;
            return widened;
          }
          (e as { unreadableConstituents?: true }).unreadableConstituents = true;
          this.constituentsPanic = e;
        }
        throw e;
      }
    }
    return this.constituents;
  }
  /** The members of this union's widened type, or undefined when widening
   * changes nothing or its members are unreadable too. */
  private widenedConstituents(): SemanticType[] | undefined {
    try {
      const widened = this.project.requestType("getWidenedType", { type: this.id });
      if (widened === undefined || widened.id === this.id) return undefined;
      if ((widened.flags & TypeFlags.Union) === 0) return [widened];
      return this.project.fetchTypes(widened.id, "getTypesOfType");
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("panic:")) return undefined;
      throw e;
    }
  }
  dispose(): void {
    this.constituents = undefined;
    this.constituentsPanic = undefined;
  }
  getBaseTypes(): SemanticType[] | undefined {
    this.project.ensureActive();
    if (!this.isClassOrInterface()) return undefined;
    return present(this.project.requestTypes("getBaseTypes", { type: this.id }), "getBaseTypes");
  }
  getTrueType(): SemanticType {
    const result = this.project.fetchType(this.id, "getTrueTypeOfConditionalType", this.trueType);
    if (result === undefined) throw new Error(`Missing conditional true type for ${this.id}`);
    this.trueType = result.id;
    return result;
  }
  getFalseType(): SemanticType {
    const result = this.project.fetchType(this.id, "getFalseTypeOfConditionalType", this.falseType);
    if (result === undefined) throw new Error(`Missing conditional false type for ${this.id}`);
    this.falseType = result.id;
    return result;
  }
  isClassOrInterface(): boolean {
    return this.isObjectType() && (this.objectFlags & ObjectFlags.ClassOrInterface) !== 0;
  }
  isUnionType(): boolean {
    return (this.flags & TypeFlags.Union) !== 0;
  }
  isIntersectionType(): boolean {
    return (this.flags & TypeFlags.Intersection) !== 0;
  }
  isObjectType(): boolean {
    return (this.flags & TypeFlags.Object) !== 0;
  }
  isIntrinsicType(): this is SemanticIntrinsicType {
    return (this.flags & TypeFlags.Intrinsic) !== 0;
  }
  isErrorType(): boolean {
    return this.isIntrinsicType() && this.intrinsicName === "error";
  }
  isLiteralType(): this is SemanticLiteralType {
    return (this.flags & TypeFlags.Literal) !== 0;
  }
  isStringLiteralType(): this is SemanticStringLiteralType {
    return (this.flags & TypeFlags.StringLiteral) !== 0;
  }
  isNumberLiteralType(): this is SemanticNumberLiteralType {
    return (this.flags & TypeFlags.NumberLiteral) !== 0;
  }
  isBigIntLiteralType(): this is SemanticBigIntLiteralType {
    return (this.flags & TypeFlags.BigIntLiteral) !== 0;
  }
  isBooleanLiteralType(): this is SemanticBooleanLiteralType {
    return (this.flags & TypeFlags.BooleanLiteral) !== 0;
  }
  isTypeReference(): boolean {
    return this.isObjectType() && (this.objectFlags & ObjectFlags.Reference) !== 0;
  }
  isTupleType(): this is SemanticTupleType {
    return this.isObjectType() && (this.objectFlags & ObjectFlags.Tuple) !== 0;
  }
  isIndexType(): boolean {
    return (this.flags & TypeFlags.Index) !== 0;
  }
  isIndexedAccessType(): boolean {
    return (this.flags & TypeFlags.IndexedAccess) !== 0;
  }
  isConditionalType(): boolean {
    return (this.flags & TypeFlags.Conditional) !== 0;
  }
  isSubstitutionType(): boolean {
    return (this.flags & TypeFlags.Substitution) !== 0;
  }
  isTemplateLiteralType(): this is SemanticTemplateLiteralType {
    return (this.flags & TypeFlags.TemplateLiteral) !== 0;
  }
  isStringMappingType(): boolean {
    return (this.flags & TypeFlags.StringMapping) !== 0;
  }
  isTypeParameter(): this is SemanticTypeParameter {
    return (this.flags & TypeFlags.TypeParameter) !== 0;
  }
}

export class SemanticSignature {
  readonly id: number;
  readonly flags: enums.SignatureFlags;
  /** The declaration's node handle, as the server sends it. */
  readonly declarationHandle: SemanticNodeHandle | undefined;
  private declarationNode: AstNode | undefined;
  private declarationResolved = false;

  constructor(
    private readonly data: SignatureResponse,
    readonly project: SemanticProject,
  ) {
    this.id = data.id;
    this.flags = data.flags;
    this.declarationHandle = data.declaration
      ? new SemanticNodeHandle(data.declaration, project)
      : undefined;
  }

  /** The declaration node, resolved in the signature's project; undefined
   * for a signature the checker synthesized. */
  get declaration(): AstNode | undefined {
    this.project.ensureActive();
    if (!this.declarationResolved) {
      this.declarationNode = this.declarationHandle?.resolve();
      this.declarationResolved = true;
    }
    return this.declarationNode;
  }

  getTypeParameters(): SemanticTypeParameter[] {
    return this.project.fetchTypes(
      this.id,
      "getTypeParametersOfSignature",
      this.data.typeParameters ?? [],
    ) as SemanticTypeParameter[];
  }
  getParameters(): SemanticSymbol[] {
    return this.project.fetchSymbols(
      this.id,
      "getParametersOfSignature",
      this.data.parameters ?? [],
    );
  }
  getThisParameter(): SemanticSymbol | undefined {
    return this.project.fetchSymbol(
      this.id,
      "getThisParameterOfSignature",
      this.data.thisParameter,
    );
  }
  getTarget(): SemanticSignature | undefined {
    return this.project.fetchSignature(this.id, "getTargetOfSignature", this.data.target);
  }
  get hasRestParameter(): boolean {
    return (this.flags & SignatureFlags.HasRestParameter) !== 0;
  }
  get isConstruct(): boolean {
    return (this.flags & SignatureFlags.Construct) !== 0;
  }
  get isAbstract(): boolean {
    return (this.flags & SignatureFlags.Abstract) !== 0;
  }
}
