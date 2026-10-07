import * as ts from "../ts7/adapter.js";
import { isGenericCallableMemberType } from "../type-mapper.js";

/** Index only program classes. Ambient declarations describe APIs, not
 * compiled implementations, and must not change a protocol's storage. */
export class ClassProtocols {
  private implemented: Set<ts.Symbol> | null = null;
  private readonly methods = new Map<string, ts.ClassLikeDeclaration[]>();
  private readonly answers = new Map<ts.Type, boolean>();

  constructor(
    private readonly checker: ts.TypeChecker,
    private readonly sources: readonly ts.SourceFile[],
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
    const visit = (node: ts.Node): void => {
      if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
        for (const clause of node.heritageClauses ?? [])
          if (clause.token === ts.SyntaxKind.ImplementsKeyword)
            for (const protocol of clause.types) add(this.checker.getTypeAtLocation(protocol));
        for (const member of node.members) {
          if (
            !ts.isMethodDeclaration(member) ||
            !ts.isIdentifier(member.name) ||
            member.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword)
          )
            continue;
          const entries = this.methods.get(member.name.text) ?? [];
          entries.push(node);
          this.methods.set(member.name.text, entries);
        }
      }
      ts.forEachChild(node, visit);
    };
    for (const source of this.sources) if (!source.isDeclarationFile) visit(source);
    return protocols;
  }

  /** Method protocols require receiver dispatch. Callable data members only
   * require it when a compatible class actually implements them with methods;
   * ordinary records of closures retain their fixed native layouts. */
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
    if (symbol && protocols.has(symbol)) return true;
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
      if (
        this.checker
          .declarationsOf(property)
          .some((declaration) => declaration.kind === ts.SyntaxKind.MethodSignature)
      )
        return true;
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
