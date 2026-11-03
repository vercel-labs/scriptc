// Primitive brands are the underlying primitive as Map keys and Set
// elements: the brand object is type-level only. Nested marker tables
// (Effect Schema's Brand<"Name"> shape) erase the same way as a flat
// `{ readonly __brand: "Name" }` marker.
type Brand<Value, Name extends string> = Value & { readonly __brand: Name };
type UserId = Brand<string, "UserId">;

const BrandTypeId = "~effect/Brand";
interface NestedBrand<Keys extends string> {
  readonly [BrandTypeId]: { readonly [K in Keys]: Keys };
}
type DriverKind = string & NestedBrand<"ProviderDriverKind">;

declare const metersTag: unique symbol;
interface SymbolBrand<Keys extends string> {
  readonly [metersTag]: { readonly [K in Keys]: typeof metersTag };
}
type Sequence = number & SymbolBrand<"Sequence">;

const users = new Map<UserId, number>();
const ada = "ada" as UserId;
users.set(ada, 1);
users.set("lin" as UserId, 2);
console.log(users.get(ada), users.has("lin" as UserId), users.size);

const drivers = new Map<DriverKind, string>();
const kind = "codex" as DriverKind;
drivers.set(kind, "Codex");
console.log(drivers.get(kind));

const sequences = new Set<Sequence>([7 as Sequence]);
sequences.add(8 as Sequence);
console.log(sequences.has(7 as Sequence), sequences.size);
