import type {
  SemanticIndexInfoData as IndexInfoResponse,
  SemanticSymbolData as SymbolResponse,
  SemanticTypePredicateData as TypePredicateResponse,
} from "./semantic-schema.generated.js";
import { AstFile, AstNode } from "./ast-node.js";
import {
  SemanticNodeHandle,
  SemanticProject,
  SemanticSignature,
  SemanticSymbol,
  SemanticType,
  type SemanticDocument,
  type SemanticQuery,
  type Ts71SymbolData,
  type Ts71TypeData,
  present,
} from "./semantic-model.js";
import { SemanticSymbolFlags } from "./semantic-schema.generated.js";
import type { TypePredicateKind } from "./enums.generated.js";

/** An index signature of a type. Its declaration resolves on first read: most queries only count a
 * type's index infos. */
export class SemanticIndexInfo {
  private declarationNode: AstNode | undefined;
  private declarationResolved = false;

  constructor(
    readonly keyType: SemanticType,
    readonly type: SemanticType,
    readonly isReadonly: boolean,
    private readonly declarationHandle: SemanticNodeHandle | undefined,
  ) {}

  get declaration(): AstNode | undefined {
    if (!this.declarationResolved) {
      this.declarationNode = this.declarationHandle?.resolve();
      this.declarationResolved = true;
    }
    return this.declarationNode;
  }
}

export interface SemanticTypePredicate {
  kind: TypePredicateKind;
  parameterIndex: number;
  parameterName: string | undefined;
  type: SemanticType | undefined;
}

export interface SemanticReferencedSymbol {
  definition: SemanticNodeHandle;
  symbol: SemanticSymbol | undefined;
  references: SemanticNodeHandle[];
}

export interface SemanticSignatureUsage {
  name: SemanticNodeHandle;
  call: SemanticNodeHandle | undefined;
}

export interface SemanticJsDocTag {
  name: string;
  text?: string;
}

interface WellKnownSymbols {
  unknown: number;
  undefined: number;
  arguments: number;
}

export interface SemanticCompletionOptions {
  triggerCharacter?: string;
  includeSymbol?: boolean;
}
/** `S` is TypeScript 7.0's SymbolResponse or 7.1's Ts71SymbolData. */
interface CompletionResponse<S> {
  isIncomplete: boolean;
  entries: {
    name: string;
    kind?: number;
    sortText?: string;
    insertText?: string;
    filterText?: string;
    detail?: string;
    labelDetails?: { detail?: string; description?: string };
    symbol?: S;
  }[];
}

/** TypeScript 7.1's type predicate and index info replies. */
interface TypePredicateResponse71 {
  kind: number;
  parameterIndex: number;
  parameterName?: string;
  type?: Ts71TypeData;
}
interface IndexInfoResponse71 {
  keyType: Ts71TypeData;
  valueType: Ts71TypeData;
  isReadonly?: boolean;
  declaration?: string;
}

/** TypeScript 7.1's getConstantValue answer: the value, with a number's
 * non-finite values written as "+Infinity", "-Infinity" and "NaN". */
interface ConstantValueResponse71 {
  isNumber: boolean;
  value?: string | number | boolean | null;
}

interface ReferencedSymbolResponse<S> {
  definition: string;
  symbol?: S;
  references?: string[];
}
export interface SemanticCompletion {
  name: string;
  kind: number | undefined;
  sortText: string | undefined;
  insertText: string | undefined;
  filterText: string | undefined;
  detail: string | undefined;
  labelDetails: { detail?: string; description?: string } | undefined;
  symbol: SemanticSymbol | undefined;
}

/** Whether lowering asks the checker for contextual types and resolved
 * signatures in batches (`getContextualTypes`, `getResolvedSignatures`,
 * answered from tsc-ts 0.0.7 on). Off, the batch prefetches (checker.ts) do
 * nothing and lowering asks node by node. A server without a batch method
 * (tsgo) answers it as unknown once, and the facade stops asking. */
export const NODE_BATCH_QUERIES = true;

/** The pinned checker's request surface over native objects. Every query
 * converges on the same snapshot/project registries, including batch and
 * lazy-object queries. No SDK object is constructed or consulted here. */
export class SemanticChecker {
  private wellKnown: WellKnownSymbols | undefined;

  constructor(readonly project: SemanticProject) {}

  private type(method: string, query: SemanticQuery): SemanticType | undefined {
    return this.project.requestType(method, query);
  }
  private symbol(method: string, query: SemanticQuery): SemanticSymbol | undefined {
    return this.project.requestSymbol(method, query);
  }
  private signature(method: string, query: SemanticQuery): SemanticSignature | undefined {
    return this.project.requestSignature(method, query);
  }
  private types(method: string, query: SemanticQuery): SemanticType[] {
    return present(this.project.requestTypes(method, query), method);
  }
  private symbols(method: string, query: SemanticQuery): SemanticSymbol[] {
    return present(this.project.requestSymbols(method, query), method);
  }
  private optionalTypes(method: string, query: SemanticQuery): (SemanticType | undefined)[] {
    return this.project.requestTypes(method, query);
  }
  private optionalSymbols(method: string, query: SemanticQuery): (SemanticSymbol | undefined)[] {
    return this.project.requestSymbols(method, query);
  }

  getTypeAtLocation(node: AstNode): SemanticType | undefined;
  getTypeAtLocation(nodes: readonly AstNode[]): (SemanticType | undefined)[];
  getTypeAtLocation(
    input: AstNode | readonly AstNode[],
  ): SemanticType | undefined | (SemanticType | undefined)[] {
    if (Array.isArray(input))
      return this.optionalTypes("getTypeAtLocations", {
        locations: (input as readonly AstNode[]).map((node) => node.id),
      });
    return this.type("getTypeAtLocation", { location: (input as AstNode).id });
  }
  getSymbolAtLocation(node: AstNode): SemanticSymbol | undefined;
  getSymbolAtLocation(nodes: readonly AstNode[]): (SemanticSymbol | undefined)[];
  getSymbolAtLocation(
    input: AstNode | readonly AstNode[],
  ): SemanticSymbol | undefined | (SemanticSymbol | undefined)[] {
    if (Array.isArray(input))
      return this.optionalSymbols("getSymbolsAtLocations", {
        locations: (input as readonly AstNode[]).map((node) => node.id),
      });
    return this.symbol("getSymbolAtLocation", { location: (input as AstNode).id });
  }
  getTypeAtPosition(file: SemanticDocument, position: number): SemanticType | undefined;
  getTypeAtPosition(
    file: SemanticDocument,
    positions: readonly number[],
  ): (SemanticType | undefined)[];
  getTypeAtPosition(
    file: SemanticDocument,
    positions: number | readonly number[],
  ): SemanticType | undefined | (SemanticType | undefined)[] {
    return typeof positions === "number"
      ? this.type("getTypeAtPosition", { file, position: positions })
      : this.optionalTypes("getTypesAtPositions", { file, positions });
  }
  getSymbolAtPosition(file: SemanticDocument, position: number): SemanticSymbol | undefined;
  getSymbolAtPosition(
    file: SemanticDocument,
    positions: readonly number[],
  ): (SemanticSymbol | undefined)[];
  getSymbolAtPosition(
    file: SemanticDocument,
    positions: number | readonly number[],
  ): SemanticSymbol | undefined | (SemanticSymbol | undefined)[] {
    return typeof positions === "number"
      ? this.symbol("getSymbolAtPosition", { file, position: positions })
      : this.optionalSymbols("getSymbolsAtPositions", { file, positions });
  }
  getTypeOfSymbol(symbol: SemanticSymbol): SemanticType | undefined;
  getTypeOfSymbol(symbols: readonly SemanticSymbol[]): (SemanticType | undefined)[];
  getTypeOfSymbol(
    input: SemanticSymbol | readonly SemanticSymbol[],
  ): SemanticType | undefined | (SemanticType | undefined)[] {
    if (Array.isArray(input))
      return this.optionalTypes("getTypesOfSymbols", {
        symbols: (input as readonly SemanticSymbol[]).map((symbol) => symbol.id),
      });
    return this.type("getTypeOfSymbol", { symbol: (input as SemanticSymbol).id });
  }

  getDeclaredTypeOfSymbol(symbol: SemanticSymbol): SemanticType {
    const type = this.type("getDeclaredTypeOfSymbol", { symbol: symbol.id });
    if (type === undefined)
      throw new Error(`getDeclaredTypeOfSymbol returned no type for symbol ${symbol.id}`);
    return type;
  }
  getTypeOfSymbolAtLocation(symbol: SemanticSymbol, node: AstNode): SemanticType {
    const type = this.type("getTypeOfSymbolAtLocation", { symbol: symbol.id, location: node.id });
    if (type === undefined)
      throw new Error(`getTypeOfSymbolAtLocation returned no type for symbol ${symbol.id}`);
    return type;
  }
  getContextualType(node: AstNode): SemanticType | undefined {
    return this.type("getContextualType", { location: node.id });
  }
  /** getContextualType for each node. */
  getContextualTypes(nodes: readonly AstNode[]): (SemanticType | undefined)[] {
    return this.optionalTypes("getContextualTypes", { locations: nodes.map((node) => node.id) });
  }
  getTypeFromTypeNode(node: AstNode): SemanticType | undefined {
    return this.type("getTypeFromTypeNode", { location: node.id });
  }
  getShorthandAssignmentValueSymbol(node: AstNode): SemanticSymbol | undefined {
    return this.symbol("getShorthandAssignmentValueSymbol", { location: node.id });
  }
  getExportSpecifierLocalTargetSymbol(node: AstNode): SemanticSymbol | undefined {
    return this.symbol("getExportSpecifierLocalTargetSymbol", { location: node.id });
  }
  getResolvedSignature(node: AstNode): SemanticSignature | undefined {
    return this.signature("getResolvedSignature", { location: node.id });
  }
  /** getResolvedSignature for each node. */
  getResolvedSignatures(nodes: readonly AstNode[]): (SemanticSignature | undefined)[] {
    return this.project.requestSignatures("getResolvedSignatures", {
      locations: nodes.map((node) => node.id),
    });
  }
  getSignatureFromDeclaration(node: AstNode): SemanticSignature | undefined {
    return this.signature("getSignatureFromDeclaration", { location: node.id });
  }
  getReturnTypeOfSignature(signature: SemanticSignature): SemanticType | undefined {
    return this.type("getReturnTypeOfSignature", { signature: signature.id });
  }
  getRestTypeOfSignature(signature: SemanticSignature): SemanticType | undefined {
    return this.type("getRestTypeOfSignature", { signature: signature.id });
  }
  getParameterType(signature: SemanticSignature, index: number): SemanticType | undefined {
    return this.type("getParameterType", { signature: signature.id, index });
  }
  getBaseTypeOfLiteralType(type: SemanticType): SemanticType | undefined {
    return this.type("getBaseTypeOfLiteralType", { type: type.id });
  }
  getNonNullableType(type: SemanticType): SemanticType | undefined {
    return this.type("getNonNullableType", { type: type.id });
  }
  getWidenedType(type: SemanticType): SemanticType | undefined {
    return this.type("getWidenedType", { type: type.id });
  }
  getApparentType(type: SemanticType): SemanticType | undefined {
    return this.type("getApparentType", { type: type.id });
  }
  getConstraintOfTypeParameter(type: SemanticType): SemanticType | undefined {
    return this.type("getConstraintOfTypeParameter", { type: type.id });
  }
  getBaseConstraintOfType(type: SemanticType): SemanticType | undefined {
    return this.type("getBaseConstraintOfType", { type: type.id });
  }
  getBaseTypes(type: SemanticType): SemanticType[] {
    return this.types("getBaseTypes", { type: type.id });
  }
  getTypeArguments(type: SemanticType): SemanticType[] {
    return this.types("getTypeArguments", { type: type.id });
  }
  getPropertiesOfType(type: SemanticType): SemanticSymbol[] {
    return this.symbols("getPropertiesOfType", { type: type.id });
  }
  getPropertyOfType(type: SemanticType, name: string): SemanticSymbol | undefined {
    return this.symbol("getPropertyOfType", { type: type.id, name });
  }
  getExportsOfModule(symbol: SemanticSymbol): SemanticSymbol[] {
    return this.symbols("getExportsOfModule", { symbol: symbol.id });
  }
  getMemberInModuleExports(symbol: SemanticSymbol, name: string): SemanticSymbol | undefined {
    return this.symbol("getMemberInModuleExports", { symbol: symbol.id, name });
  }
  getImmediateAliasedSymbol(symbol: SemanticSymbol): SemanticSymbol | undefined {
    return this.symbol("getImmediateAliasedSymbol", { symbol: symbol.id });
  }

  getAliasedSymbol(symbol: SemanticSymbol): SemanticSymbol {
    const result = this.symbol("getAliasedSymbol", { symbol: symbol.id });
    if (result === undefined)
      throw new Error(`getAliasedSymbol returned no symbol for symbol ${symbol.id}`);
    return result;
  }
  resolveName(
    name: string,
    meaning: number,
    location?: AstNode | { document: SemanticDocument; position: number },
    excludeGlobals?: boolean,
  ): SemanticSymbol | undefined {
    const node = location instanceof AstNode ? location : undefined;
    const position =
      location !== undefined && !(location instanceof AstNode) ? location : undefined;
    return this.symbol("resolveName", {
      name,
      meaning,
      location: node?.id,
      file: position?.document,
      position: position?.position,
      excludeGlobals,
    });
  }
  getResolvedSymbol(node: AstNode): SemanticSymbol | undefined {
    const text = node.text;
    return text
      ? this.resolveName(text, SemanticSymbolFlags.Value | SemanticSymbolFlags.ExportValue, node)
      : undefined;
  }

  private intrinsic(method: string): SemanticType {
    const result = this.type(method, {});
    if (result === undefined) throw new Error(`${method} returned no intrinsic type`);
    return result;
  }
  getAnyType(): SemanticType {
    return this.intrinsic("getAnyType");
  }
  getStringType(): SemanticType {
    return this.intrinsic("getStringType");
  }
  getNumberType(): SemanticType {
    return this.intrinsic("getNumberType");
  }
  getBooleanType(): SemanticType {
    return this.intrinsic("getBooleanType");
  }
  getVoidType(): SemanticType {
    return this.intrinsic("getVoidType");
  }
  getUndefinedType(): SemanticType {
    return this.intrinsic("getUndefinedType");
  }
  getNullType(): SemanticType {
    return this.intrinsic("getNullType");
  }
  getNeverType(): SemanticType {
    return this.intrinsic("getNeverType");
  }
  getUnknownType(): SemanticType {
    return this.intrinsic("getUnknownType");
  }
  getBigIntType(): SemanticType {
    return this.intrinsic("getBigIntType");
  }
  getESSymbolType(): SemanticType {
    return this.intrinsic("getESSymbolType");
  }

  typeToString(type: SemanticType, enclosingDeclaration?: AstNode, flags?: number): string {
    return this.project.request<string>("typeToString", {
      type: type.id,
      location: enclosingDeclaration?.id,
      flags,
    });
  }
  isContextSensitive(node: AstNode): boolean {
    return this.project.request<boolean>("isContextSensitive", { location: node.id });
  }
  isArrayType(type: SemanticType): boolean {
    return this.project.request<boolean>("isArrayType", { type: type.id });
  }
  isArrayLikeType(type: SemanticType): boolean {
    return this.project.request<boolean>("isArrayLikeType", { type: type.id });
  }
  isTupleType(type: SemanticType): boolean {
    if (this.project.ts71()) return this.project.isTupleType71(type.id);
    return this.project.request<boolean>("isTupleType", { type: type.id });
  }
  isTypeAssignableTo(source: SemanticType, target: SemanticType): boolean {
    return this.project.request<boolean>("isTypeAssignableTo", {
      source: source.id,
      target: target.id,
    });
  }
  getConstantValue(node: AstNode): string | number | undefined {
    if (this.project.ts71()) {
      const data = this.project.request<ConstantValueResponse71 | null>("getConstantValue", {
        location: node.id,
      });
      const value = data?.value;
      if (typeof value === "number") return value;
      if (typeof value !== "string") return undefined;
      if (!data!.isNumber) return value;
      return value === "+Infinity" ? Infinity : value === "-Infinity" ? -Infinity : NaN;
    }
    return (
      this.project.request<string | number | null>("getConstantValue", { location: node.id }) ??
      undefined
    );
  }
  getSignaturesOfType(type: SemanticType, kind: number): SemanticSignature[] {
    return present(
      this.project.requestSignatures("getSignaturesOfType", { type: type.id, kind }),
      "getSignaturesOfType",
    );
  }
  getTypePredicateOfSignature(signature: SemanticSignature): SemanticTypePredicate | undefined {
    if (this.project.ts71()) {
      const data = this.project.request<TypePredicateResponse71 | null>(
        "getTypePredicateOfSignature",
        { signature: signature.id },
      );
      return data === null
        ? undefined
        : {
            kind: data.kind,
            parameterIndex: data.parameterIndex,
            parameterName: data.parameterName,
            type: data.type === undefined ? undefined : this.project.type71(data.type),
          };
    }
    const data = this.project.request<TypePredicateResponse | null>("getTypePredicateOfSignature", {
      signature: signature.id,
    });
    return data === null
      ? undefined
      : {
          kind: data.kind,
          parameterIndex: data.parameterIndex,
          parameterName: data.parameterName,
          type: data.type === undefined ? undefined : this.project.type(data.type),
        };
  }
  getIndexInfosOfType(type: SemanticType): SemanticIndexInfo[] {
    if (this.project.ts71()) {
      const data = this.project.request<IndexInfoResponse71[] | null>("getIndexInfosOfType", {
        type: type.id,
      });
      return (data ?? []).map(
        (item) =>
          new SemanticIndexInfo(
            this.project.type71(item.keyType),
            this.project.type71(item.valueType),
            item.isReadonly ?? false,
            item.declaration === undefined
              ? undefined
              : new SemanticNodeHandle(item.declaration, this.project),
          ),
      );
    }
    const data = this.project.request<IndexInfoResponse[] | null>("getIndexInfosOfType", {
      type: type.id,
    });
    return (data ?? []).map(
      (item) =>
        new SemanticIndexInfo(
          this.project.type(item.keyType),
          this.project.type(item.valueType),
          item.isReadonly ?? false,
          item.declaration === undefined
            ? undefined
            : new SemanticNodeHandle(item.declaration, this.project),
        ),
    );
  }
  private getWellKnownSymbols(): WellKnownSymbols {
    this.project.ensureActive();
    if (this.wellKnown === undefined) {
      const ids = this.project.request<WellKnownSymbols>("getWellKnownSymbols");
      this.wellKnown = {
        unknown: this.project.snapshotSymbolId(ids.unknown),
        undefined: this.project.snapshotSymbolId(ids.undefined),
        arguments: this.project.snapshotSymbolId(ids.arguments),
      };
    }
    return this.wellKnown;
  }
  isUnknownSymbol(symbol: SemanticSymbol): boolean {
    return symbol.id === this.getWellKnownSymbols().unknown;
  }
  isUndefinedSymbol(symbol: SemanticSymbol): boolean {
    return symbol.id === this.getWellKnownSymbols().undefined;
  }
  isArgumentsSymbol(symbol: SemanticSymbol): boolean {
    return symbol.id === this.getWellKnownSymbols().arguments;
  }

  getReferencesToSymbolInFile(
    file: SemanticDocument,
    symbol: SemanticSymbol,
  ): SemanticNodeHandle[] {
    const data = this.project.request<string[] | null>("getReferencesToSymbolInFile", {
      file,
      symbol: symbol.id,
    });
    return (data ?? []).map((handle) => new SemanticNodeHandle(handle, this.project));
  }
  getReferencedSymbolsForNode(node: AstNode, position: number): SemanticReferencedSymbol[] {
    const query = { node: node.id, position };
    if (this.project.ts71()) {
      const data = this.project.request<ReferencedSymbolResponse<Ts71SymbolData>[] | null>(
        "getReferencedSymbolsForNode",
        query,
      );
      return (data ?? []).map((item) => ({
        definition: new SemanticNodeHandle(item.definition, this.project),
        symbol: item.symbol === undefined ? undefined : this.project.symbol71(item.symbol),
        references: (item.references ?? []).map(
          (handle) => new SemanticNodeHandle(handle, this.project),
        ),
      }));
    }
    const data = this.project.request<ReferencedSymbolResponse<SymbolResponse>[] | null>(
      "getReferencedSymbolsForNode",
      query,
    );
    return (data ?? []).map((item) => ({
      definition: new SemanticNodeHandle(item.definition, this.project),
      symbol: item.symbol === undefined ? undefined : this.project.symbol(item.symbol),
      references: (item.references ?? []).map(
        (handle) => new SemanticNodeHandle(handle, this.project),
      ),
    }));
  }
  getSignatureUsage(node: AstNode): SemanticSignatureUsage[] {
    const data = this.project.request<{ name: string; call?: string }[] | null>(
      "getSignatureUsages",
      { signatureDecl: node.id },
    );
    return (data ?? []).map((item) => ({
      name: new SemanticNodeHandle(item.name, this.project),
      call: item.call === undefined ? undefined : new SemanticNodeHandle(item.call, this.project),
    }));
  }
  getJsDocTagsOfSymbol(symbol: SemanticSymbol): SemanticJsDocTag[] {
    return (
      this.project.request<SemanticJsDocTag[] | null>("getJsDocTags", { symbol: symbol.id }) ?? []
    );
  }
  getDocumentationCommentOfSymbol(symbol: SemanticSymbol): string {
    return this.project.request<string>("getDocumentationComment", { symbol: symbol.id });
  }
  getCompletionsAtPosition(
    file: SemanticDocument,
    position: number,
    options?: SemanticCompletionOptions,
  ): { isIncomplete: boolean; entries: SemanticCompletion[] } | undefined {
    const query = {
      file,
      position,
      triggerCharacter: options?.triggerCharacter,
      includeSymbol: options?.includeSymbol,
    };
    if (this.project.ts71()) {
      const data = this.project.request<CompletionResponse<Ts71SymbolData> | null>(
        "getCompletionsAtPosition",
        query,
      );
      if (data === null) return undefined;
      return {
        isIncomplete: data.isIncomplete,
        entries: data.entries.map((item) => ({
          name: item.name,
          kind: item.kind,
          sortText: item.sortText,
          insertText: item.insertText,
          filterText: item.filterText,
          detail: item.detail,
          labelDetails: item.labelDetails,
          symbol: item.symbol === undefined ? undefined : this.project.symbol71(item.symbol),
        })),
      };
    }
    const data = this.project.request<CompletionResponse<SymbolResponse> | null>(
      "getCompletionsAtPosition",
      query,
    );
    if (data === null) return undefined;
    return {
      isIncomplete: data.isIncomplete,
      entries: data.entries.map((item) => ({
        name: item.name,
        kind: item.kind,
        sortText: item.sortText,
        insertText: item.insertText,
        filterText: item.filterText,
        detail: item.detail,
        labelDetails: item.labelDetails,
        symbol: item.symbol === undefined ? undefined : this.project.symbol(item.symbol),
      })),
    };
  }
  typeToTypeNode(
    type: SemanticType,
    enclosingDeclaration?: AstNode,
    flags?: number,
  ): AstNode | undefined {
    const bytes = this.project.requestBinary("typeToTypeNode", {
      type: type.id,
      location: enclosingDeclaration?.id,
      flags,
    });
    return bytes.length === 0 ? undefined : new AstFile(bytes).root;
  }
  signatureToSignatureDeclaration(
    signature: SemanticSignature,
    kind: number,
    enclosingDeclaration?: AstNode,
    flags?: number,
  ): AstNode | undefined {
    const bytes = this.project.requestBinary("signatureToSignatureDeclaration", {
      signature: signature.id,
      kind,
      location: enclosingDeclaration?.id,
      flags,
    });
    return bytes.length === 0 ? undefined : new AstFile(bytes).root;
  }
  dispose(): void {
    this.project.dispose();
  }
}
