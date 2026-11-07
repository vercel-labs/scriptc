/* Which checker types are one type, however often the program spells them.
 *
 * The checker makes a new type object for every anonymous spelling: the
 * `{ n: number }` of an alias and the `{ n: number }` of an annotation are
 * two objects, and so are two instantiations whose arguments are. A fact
 * recorded by type object (ClassProtocols' dictionary marking) would then
 * hold for one spelling and not for the other, and a value passing between
 * the two would be converted, which copies it.
 *
 * Two types are THE SAME when one of these holds, read as the largest
 * relation that satisfies them (a pair met again while it is being compared
 * counts as the same, which is what closes a recursive type):
 *
 * - they are one checker type (every primitive and literal type is one);
 * - both are unions, or both intersections, with the same number of
 *   members, and every member of each is the same as a member of the other;
 * - both are instantiations of one generic type, and their type arguments
 *   are pairwise the same;
 * - both are arrays, both tuples or both class instances, and the previous
 *   line holds. These are nominal: nothing else is the same as one of them,
 *   and `readonly T[]` is not `T[]`;
 * - both are any other object type (a type literal, an interface, a mapped
 *   or instantiated type, wherever it is declared: another module and a
 *   declaration file count like the file itself), and they have
 *   - the same property names, each optional in both or in neither, with
 *     the same type,
 *   - the same index signatures: the same key type, the same value type,
 *   - the same call and construct signatures, in order: no type parameters
 *     and no type predicate, the same number of parameters, a rest parameter
 *     in both or in neither, the same parameter types and return type.
 *
 * `readonly` on a property or an index signature, the names of index keys
 * and parameters, and the alias a type is reached through are not part of a
 * type here. The checker lets such types pass for each other in both
 * directions without a cast, so a value does flow between them.
 *
 * Anything this cannot decide (a generic signature, a comparison that runs
 * past its budget, a checker query that fails) is a different type. That is
 * the answer the caller had before it asked. */
import * as ts from "../ts7/adapter.js";

/** Pairs one comparison may visit before it gives up. */
const BUDGET = 1000;

export class TypeSameness {
  /** The first type seen of each class of same types. */
  private readonly canonicalOf = new Map<ts.Type, ts.Type>();
  /** Canonical types by shape: only types of one shape are compared. */
  private readonly byShape = new Map<string, ts.Type[]>();
  /** The pairs the running comparison holds to be the same, as (a, b)
   * entries in the order they were entered: pairs still being compared, and
   * pairs found the same under the entries before them. */
  private assumed: ts.Type[] = [];
  private budget = 0;

  constructor(private readonly checker: ts.TypeChecker) {}

  /** One representative per class of same types: `canonical(a) ===
   * canonical(b)` exactly when `a` and `b` are the same. Memoized per type,
   * and a type that is only the same as itself (a primitive, a literal, a
   * type parameter) is answered without a checker query. */
  canonical(type: ts.Type): ts.Type {
    const known = this.canonicalOf.get(type);
    if (known !== undefined) return known;
    let answer = type;
    const shape = attempt(() => this.shape(type)) ?? null;
    if (shape !== null) {
      const candidates = this.byShape.get(shape);
      if (candidates === undefined) this.byShape.set(shape, [type]);
      else {
        const twin = candidates.find((candidate) => {
          this.assumed = [];
          this.budget = BUDGET;
          return attempt(() => this.same(candidate, type)) === true;
        });
        if (twin === undefined) candidates.push(type);
        else answer = twin;
      }
    }
    this.canonicalOf.set(type, answer);
    return answer;
  }

  /** What two same types must agree on before they are compared member by
   * member, or null for a type that is only the same as itself. */
  private shape(type: ts.Type): string | null {
    if (type.isUnionType() || type.isIntersectionType()) {
      // Same members have the same flags, so the kinds of member two same
      // composites hold are the same set.
      const parts = ts.constituentTypes(type);
      const kinds = [...new Set(parts.map((part) => part.flags))].sort((a, b) => a - b);
      return `${type.isUnionType() ? "|" : "&"}${parts.length}:${kinds.join(",")}`;
    }
    if ((type.flags & ts.TypeFlags.Object) === 0) return null;
    const nominal = this.nominal(type);
    if (nominal !== null) return nominal;
    const names = this.checker.getPropertiesOfType(type).map((property) => ts.symbolName(property));
    return [
      `{${names.sort().join(",")}}`,
      this.checker.getIndexInfosOfType(type).length,
      this.checker.getCallSignatures(type).length,
      this.checker.getConstructSignatures(type).length,
    ].join("/");
  }

  /** The shape of an array, a tuple or a class instance, which is the same
   * only as another instantiation of its own generic type. */
  private nominal(type: ts.Type): string | null {
    const symbol = type.getSymbol();
    const name = symbol === undefined ? "" : ts.symbolName(symbol);
    if (this.checker.isArrayType(type)) return `[]${name}`;
    if (this.checker.isTupleType(type)) return `[,]${this.typeArguments(type).length}`;
    if (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Class) !== 0) return `class ${name}`;
    return null;
  }

  private same(a: ts.Type, b: ts.Type): boolean {
    if (a === b) return true;
    const composite = a.isUnionType() || a.isIntersectionType();
    if (!composite && (a.flags & b.flags & ts.TypeFlags.Object) === 0) return false;
    // A pair under comparison is the same until a member says otherwise.
    const { assumed } = this;
    for (let i = 0; i < assumed.length; i += 2)
      if (assumed[i] === a && assumed[i + 1] === b) return true;
    if (--this.budget < 0) return false;
    const entered = assumed.length;
    assumed.push(a, b);
    const answer = composite ? this.sameConstituents(a, b) : this.sameObject(a, b);
    // What was found the same below a pair that is not may have relied on it.
    if (!answer) assumed.length = entered;
    return answer;
  }

  private sameConstituents(a: ts.Type, b: ts.Type): boolean {
    if (a.isUnionType() !== b.isUnionType() || a.isIntersectionType() !== b.isIntersectionType())
      return false;
    const left = ts.constituentTypes(a);
    const right = ts.constituentTypes(b);
    return (
      left.length === right.length &&
      left.every((part) => right.some((other) => this.same(part, other))) &&
      right.every((part) => left.some((other) => this.same(other, part)))
    );
  }

  private sameObject(a: ts.Type, b: ts.Type): boolean {
    // Instantiations of one generic type with the same arguments. The
    // target of a tuple is its arity and element kinds.
    const target = a.isTypeReference() ? a.getTarget() : undefined;
    if (
      target !== undefined &&
      target !== a &&
      b.isTypeReference() &&
      b.getTarget() === target &&
      this.sameList(this.typeArguments(a), this.typeArguments(b))
    )
      return true;
    if (this.nominal(a) !== null || this.nominal(b) !== null) return false;
    const { checker } = this;
    const left = checker.getPropertiesOfType(a);
    if (left.length !== checker.getPropertiesOfType(b).length) return false;
    for (const property of left) {
      const other = checker.getPropertyOfType(b, ts.symbolName(property));
      if (other === undefined) return false;
      if (((property.flags ^ other.flags) & ts.SymbolFlags.Optional) !== 0) return false;
      if (!this.same(checker.getTypeOfSymbol(property), checker.getTypeOfSymbol(other)))
        return false;
    }
    const indexes = checker.getIndexInfosOfType(b);
    if (checker.getIndexInfosOfType(a).length !== indexes.length) return false;
    for (const index of checker.getIndexInfosOfType(a)) {
      const other = indexes.find((candidate) => candidate.keyType === index.keyType);
      if (other === undefined || !this.same(index.type, other.type)) return false;
    }
    for (const kind of [ts.SignatureKind.Call, ts.SignatureKind.Construct]) {
      const signatures = checker.getSignaturesOfType(a, kind);
      const others = checker.getSignaturesOfType(b, kind);
      if (signatures.length !== others.length) return false;
      for (let i = 0; i < signatures.length; i++)
        if (!this.sameSignature(signatures[i]!, others[i]!)) return false;
    }
    return true;
  }

  private sameSignature(a: ts.Signature, b: ts.Signature): boolean {
    if (a === b) return true;
    const { checker } = this;
    if (a.getTypeParameters().length > 0 || b.getTypeParameters().length > 0) return false;
    if (a.hasRestParameter !== b.hasRestParameter) return false;
    if (checker.getTypePredicateOfSignature(a) !== undefined) return false;
    if (checker.getTypePredicateOfSignature(b) !== undefined) return false;
    const parameters = (signature: ts.Signature): ts.Type[] =>
      signature.getParameters().map((parameter) => checker.getTypeOfSymbol(parameter));
    return (
      this.sameList(parameters(a), parameters(b)) &&
      this.same(checker.getReturnTypeOfSignature(a), checker.getReturnTypeOfSignature(b))
    );
  }

  private sameList(left: readonly ts.Type[], right: readonly ts.Type[]): boolean {
    return left.length === right.length && left.every((type, i) => this.same(type, right[i]!));
  }

  private typeArguments(type: ts.Type): readonly ts.Type[] {
    return this.checker.getTypeArguments(type as ts.TypeReference);
  }
}

/** A checker query that may hit an upstream checker panic answers nothing,
 * which the caller reads as "a different type". */
function attempt<T>(query: () => T): T | undefined {
  try {
    return query();
  } catch {
    return undefined;
  }
}
