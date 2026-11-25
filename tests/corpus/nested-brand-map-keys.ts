// Nested phantom marker tables erase with the primitive: Effect Schema's
// Brand<K> table (`{ readonly ["~effect/Brand"]: { readonly [P in K]: K } }`)
// and unique-symbol-keyed tables hold only marker values, so a branded
// primitive is still its primitive in Map keys, Set elements, parameters,
// and record fields.
type Brand<Key extends string> = { readonly ["~effect/Brand"]: { readonly [Name in Key]: Name } };
type ProviderDriverKind = string & Brand<"ProviderDriverKind">;
type Sequence = number & Brand<"Sequence">;
declare const metersTag: unique symbol;
type MetersTag<Key extends string> = { readonly [metersTag]: { readonly [Name in Key]: Name } };
type Meters = number & MetersTag<"Meters">;
type Enabled = boolean & Brand<"Enabled">;

const byDriverKind = new Map<ProviderDriverKind, number>();
byDriverKind.set("codex" as ProviderDriverKind, 1);
byDriverKind.set("claude" as ProviderDriverKind, 2);
byDriverKind.set("codex" as ProviderDriverKind, byDriverKind.get("codex" as ProviderDriverKind)! + 10);

const visited = new Set<Sequence>();
visited.add(3 as Sequence);
visited.add(3 as Sequence);
visited.add(5 as Sequence);

function label(kind: ProviderDriverKind): string {
  return `driver:${kind.toUpperCase()}`;
}

function distance(m: Meters): Meters {
  return (m * 2) as Meters;
}

const enabled: Enabled = true as Enabled;
const record: { kind: ProviderDriverKind; meters: Meters } = {
  kind: "gemini" as ProviderDriverKind,
  meters: 21 as Meters,
};

console.log(byDriverKind.size, byDriverKind.get("codex" as ProviderDriverKind));
for (const key of byDriverKind.keys()) console.log(key);
console.log(visited.size, visited.has(5 as Sequence), visited.has(4 as Sequence));
console.log(label(record.kind), distance(record.meters), enabled);
