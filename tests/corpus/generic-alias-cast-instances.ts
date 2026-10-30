// Casts to a generic type alias spelled over the enclosing function's own
// type parameters (`x as Catalog<G, P>`). The checker keeps such an alias
// symbolic inside the generic body; each instance maps it with its own bound
// type arguments.

type Groups = Record<string, Record<string, object>>;

type EntryKey<G extends Groups> = { [A in keyof G]: keyof G[A] }[keyof G] & string;
type KeyOfKind<G extends Groups, K extends string> = Extract<EntryKey<G>, `${K}:${string}`>;
type EntryId<K extends string> = K extends `${string}:${infer I}` ? I : never;

type Catalog<G extends Groups, P extends string, K extends string> = {
  [Key in KeyOfKind<G, K> as EntryId<Key>]: { id: EntryId<Key>; label: string; owner: P };
};

function flatten(groups: Groups, kind: string): Record<string, object> {
  return Object.fromEntries(
    Object.values(groups)
      .flatMap((entries) => Object.entries(entries))
      .filter(([key]) => key.startsWith(kind + ":"))
      .map(([, entry]) => [(entry as { id: string }).id, entry]),
  );
}

function toolCatalog<const P extends string, const G extends Groups>(
  _owner: P,
  groups: G,
): Catalog<G, P, "tool"> {
  return flatten(groups, "tool") as Catalog<G, P, "tool">;
}

function partCatalog<const P extends string, const G extends Groups>(
  _owner: P,
  groups: G,
): Catalog<G, P, "part"> {
  return flatten(groups, "part") as Catalog<G, P, "part">;
}

const workshop = {
  bench: {
    "tool:saw": { id: "saw", label: "Hand saw", owner: "acme" },
    "part:bolt": { id: "bolt", label: "Hex bolt", owner: "acme" },
  },
  shelf: {
    "tool:drill": { id: "drill", label: "Cordless drill", owner: "acme" },
  },
};

const tools = toolCatalog("acme", workshop);
console.log(tools.saw.label, tools.drill.id, tools.drill.owner);
console.log(Object.keys(tools).join(","), JSON.stringify(tools.saw));

const parts = partCatalog("acme", workshop);
console.log(parts.bolt.label, Object.keys(parts).length);

// A second instantiation with different groups gets its own layout.
const garden = {
  shed: {
    "tool:rake": { id: "rake", label: "Leaf rake", owner: "green" },
    "tool:hoe": { id: "hoe", label: "Garden hoe", owner: "green" },
  },
};
const gardenTools = toolCatalog("green", garden);
console.log(gardenTools.rake.label, gardenTools.hoe.label, Object.keys(gardenTools).join(","));

// No entry of the kind: the alias resolves to the empty record.
const gardenParts = partCatalog("green", garden);
console.log(Object.keys(gardenParts).length, JSON.stringify(gardenParts));

// A homomorphic mapped alias over the bound type, cast inside the body.
type Boxed<T> = { [K in keyof T]: { value: T[K] } };

function boxAll<T extends Record<string, number>>(values: T): Boxed<T> {
  const out: Record<string, object> = {};
  for (const key of Object.keys(values)) out[key] = { value: values[key] };
  return out as Boxed<T>;
}

const boxed = boxAll({ width: 3, height: 4 });
console.log(boxed.width.value * boxed.height.value);

// The alias nested in an array type of the signature.
function boxEach<T extends Record<string, number>>(rows: T[]): Boxed<T>[] {
  return rows.map((row) => {
    const out: Record<string, object> = {};
    for (const key of Object.keys(row)) out[key] = { value: row[key] };
    return out as Boxed<T>;
  });
}

const rows = boxEach([
  { x: 1, y: 2 },
  { x: 5, y: 8 },
]);
console.log(rows.map((r) => r.x.value + r.y.value).join(" "));

// A generic body forwarding its parameters to another generic cast.
function ownedTools<const G extends Groups>(groups: G): Catalog<G, "shared", "tool"> {
  return toolCatalog("shared", groups);
}

const shared = ownedTools({ rack: { "tool:clamp": { id: "clamp", label: "C-clamp", owner: "shared" } } });
console.log(shared.clamp.label, shared.clamp.owner);
